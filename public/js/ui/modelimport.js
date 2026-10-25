// Model import (glTF / GLB / OBJ+MTL → .3db or .cmp + .sur) and export (.cmp/.3db → GLB).
// Conventions (common Freelancer naming, so existing Blender files work):
//   node "name$lod1" … extra levels of detail · node "name$hull" or extras.hull → collision hull
//   empty named Hp… (or extras.hardpoint) → hardpoint; extras.hptype = "rev" + axis/min/max → revolute
//   extras.construct = "rev"/"pris" (+ axis, min, max, offset) on a part → moving part
// Output is checked by loading it back through the editor's own model loader before anything is written.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/GLTFLoader.js';
import { OBJLoader } from 'three/addons/OBJLoader.js';
import { MTLLoader } from 'three/addons/MTLLoader.js';
import { GLTFExporter } from 'three/addons/GLTFExporter.js';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { h, modal, toast, confirmDialog, promptDialog } from './dom.js';
import { api, dataPath } from '../api.js';
import { ResourceManager } from '../formats/model.js';
import { buildModelUtf, buildSur, readSur } from '../formats/modelwrite.js';
import { rgbaToFlDDS, decodeTextureNode } from '../formats/texcodec.js';
import { parseUtf } from '../formats/utf.js';
import { dacomCrc } from '../formats/crc.js';
import { IniDocument } from '../formats/ini.js';

const LOD_RE = /\$lod(\d)$/i, HULL_RE = /\$hull$/i;
const isHull = (o) => HULL_RE.test(o.name) || !!o.userData?.hull;
const isHp = (o) => (!o.isMesh && /^hp/i.test(o.name)) || !!o.userData?.hardpoint;
const clean = (s) => String(s || '').replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '') || 'x';

// ---------------- loading user files ----------------
export async function loadFiles(files) {
  const urls = new Map(); for (const f of files) urls.set(f.name.toLowerCase(), URL.createObjectURL(f));
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((u) => { const n = decodeURIComponent(u.split(/[\\/]/).pop().split('?')[0]).toLowerCase(); return urls.get(n) || u; });
  const main = files.find(f => /\.(glb|gltf)$/i.test(f.name)) || files.find(f => /\.obj$/i.test(f.name));
  if (!main) throw new Error('Choose a .glb, .gltf or .obj file (plus its .bin / .mtl / texture files)');
  let scene, source;
  if (/\.(glb|gltf)$/i.test(main.name)) {
    const g = await new GLTFLoader(manager).loadAsync(urls.get(main.name.toLowerCase()));
    scene = g.scene; source = 'gltf';
  } else {
    const loader = new OBJLoader(manager);
    const mtl = files.find(f => /\.mtl$/i.test(f.name));
    if (mtl) { const mats = await new MTLLoader(manager).loadAsync(urls.get(mtl.name.toLowerCase())); mats.preload(); loader.setMaterials(mats); }
    scene = await loader.loadAsync(urls.get(main.name.toLowerCase()));
    source = 'obj';
  }
  // wait for textures that are still decoding
  await new Promise(r => { if (manager.itemsLoaded >= manager.itemsTotal) r(); else { manager.onLoad = r; setTimeout(r, 4000); } });
  return { scene, source, name: main.name.replace(/\.[^.]+$/, '') };
}

function imageToRGBA(img) {
  const w = img.width || img.naturalWidth, hgt = img.height || img.naturalHeight;
  if (!w || !hgt) return null;
  const c = document.createElement('canvas'); c.width = w; c.height = hgt;
  const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(img, 0, 0);
  return { w, h: hgt, rgba: new Uint8Array(ctx.getImageData(0, 0, w, hgt).data.buffer) };
}

// ---------------- three scene → abstract FL model ----------------
export function sceneToModel(scene, opts) {
  const name = clean(opts.name);
  const C = new THREE.Matrix4();
  if (opts.zUp) C.premultiply(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
  if (opts.flipForward) C.premultiply(new THREE.Matrix4().makeRotationY(Math.PI));
  C.premultiply(new THREE.Matrix4().makeScale(opts.scale, opts.scale, opts.scale));
  scene.updateMatrixWorld(true);
  const world = (o) => new THREE.Matrix4().multiplyMatrices(C, o.matrixWorld);
  const noScale = (m) => { const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3(); m.decompose(p, q, s); return new THREE.Matrix4().compose(p, q, new THREE.Vector3(1, 1, 1)); };
  const warnings = [];

  // parts
  const hasGeom = (o) => { let g = false; o.traverse(c => { if (c.isMesh && !isHull(c)) g = true; }); return g; };
  const partOf = new Map(); // Object3D → part
  const parts = [];
  // a scene with a single top-level node (typical for exports, ours included): that node is the root part
  let rootObj = scene;
  for (;;) { const kids = rootObj.children.filter(c => !isHull(c) && !isHp(c)); if (kids.length === 1 && !kids[0].isMesh && hasGeom(kids[0]) && !kids[0].userData?.construct) rootObj = kids[0]; else break; }
  const root = { name: 'Root', parent: null, kind: 'fix', obj: rootObj, frame: new THREE.Matrix4(), lods: [], hardpoints: [], hulls: [], hullObjs: [] };
  parts.push(root); partOf.set(scene, root); partOf.set(rootObj, root);
  const markedParts = rootObj !== scene && rootObj.children.some(c => c.userData?.construct);
  if (opts.mode === 'parts') {
    const used = new Set(['root']);
    (function walk(obj, parentPart, depth) {
      for (const c of obj.children) {
        if (isHull(c) || isHp(c) || LOD_RE.test(c.name)) continue;
        const con = c.userData?.construct;
        // under a single root node that marks its parts with "construct" extras (our own exports and similar tools), only those
        // nodes are parts; otherwise every top-level node with geometry is one
        const becomePart = hasGeom(c) && (con || (depth === 0 && !markedParts && !(c.isMesh && rootObj !== scene)));
        if (becomePart) {
          let nm = clean(c.name || 'part'); while (used.has(nm.toLowerCase())) nm += '_';
          used.add(nm.toLowerCase());
          const kind = /^(rev|pris)$/i.test(con || '') ? con.toLowerCase() : 'fix';
          const p = { name: nm, parent: parentPart.name, kind, obj: c, frame: noScale(world(c)), lods: [], hardpoints: [], hulls: [], hullObjs: [] };
          if (kind !== 'fix') {
            const ud = c.userData;
            p.axis = Array.isArray(ud.axis) ? ud.axis : [0, 1, 0];
            p.min = (ud.min ?? (kind === 'rev' ? -90 : 0)) * (kind === 'rev' ? Math.PI / 180 : 1);
            p.max = (ud.max ?? (kind === 'rev' ? 90 : 1)) * (kind === 'rev' ? Math.PI / 180 : 1);
            p.offset = Array.isArray(ud.offset) ? ud.offset : [0, 0, 0];
          }
          parts.push(p); partOf.set(c, p);
          walk(c, p, depth + 1);
        } else walk(c, parentPart, depth);
      }
    })(rootObj, root, 0);
  }
  const ownerPart = (o) => { let p = o; while (p) { if (partOf.has(p)) return partOf.get(p); p = p.parent; } return root; };
  const lodOf = (o) => { let p = o; while (p && p !== scene) { const m = LOD_RE.exec(p.name); if (m) return +m[1]; p = p.parent; } return 0; };
  const inHp = (o) => { let p = o.parent; while (p) { if (isHp(p)) return p; p = p.parent; } return null; };
  const inHull = (o) => { let p = o; while (p) { if (isHull(p)) return true; p = p.parent; } return false; };

  // materials / textures
  const materials = new Map(), textures = new Map(), matNames = new Map();
  const texName = new Map();
  const texFor = (tex) => {
    if (!tex || !tex.image) return null;
    if (texName.has(tex)) return texName.get(tex);
    const img = imageToRGBA(tex.image);
    if (!img) return null;
    const nm = `${name}_${clean(tex.name || (tex.image.src || '').split('/').pop().replace(/\.[^.]+$/, '') || 'tex' + texName.size)}.dds`.toLowerCase();
    const enc = rgbaToFlDDS(img.rgba, img.w, img.h, { maxSize: opts.maxTex });
    textures.set(nm, enc.bytes);
    texName.set(tex, { name: nm, alpha: enc.alpha });
    return texName.get(tex);
  };
  const matFor = (m) => {
    if (matNames.has(m)) return matNames.get(m);
    let nm = `${name}_${clean(m.name || 'mat' + matNames.size)}`;
    while ([...materials.keys()].some(k => k.toLowerCase() === nm.toLowerCase())) nm += '_';
    const def = { dc: [1, 1, 1], dt: null, et: null, ec: null, oc: 1, two: m.side === THREE.DoubleSide };
    if (m.color) { const c = m.color.clone(); def.dc = [c.r, c.g, c.b].map(v => +(v < 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055).toFixed(4)); }
    const t = texFor(m.map);
    if (t) { def.dt = t.name; if (t.alpha && (m.transparent || m.alphaTest > 0)) def.alphaTex = true; }
    else {
      // untextured: a small solid texture (FL's DcDt expects one) tinted by Dc
      const key = `${name}_white.dds`;
      if (!textures.has(key)) textures.set(key, rgbaToFlDDS(new Uint8Array(16 * 4).fill(255), 4, 4).bytes);
      def.dt = key;
    }
    const et = texFor(m.emissiveMap);
    if (et) def.et = et.name;
    else if (m.emissive && (m.emissive.r + m.emissive.g + m.emissive.b) > 0.01) def.ec = [m.emissive.r, m.emissive.g, m.emissive.b];
    if (m.transparent && m.opacity < 1) def.oc = m.opacity;
    materials.set(nm, def); matNames.set(m, nm);
    return nm;
  };

  // meshes, hulls, hardpoints
  const hpObjs = [];
  scene.traverse(o => {
    if (o === scene) return;
    if (isHp(o) && !inHull(o)) { hpObjs.push(o); return; }
    if (!o.isMesh) return;
    const hp = inHp(o);
    const part = ownerPart(hp || o);
    const toPart = new THREE.Matrix4().copy(part.frame).invert().multiply(world(o));
    if (inHull(o)) {
      const pts = meshPoints(o.geometry, toPart);
      if (hp) (hp.userData._hulls ||= []).push(pts); else part.hulls.push(pts);
      return;
    }
    if (hp) return; // geometry under a hardpoint (preview helpers) is ignored
    const lod = lodOf(o);
    while (part.lods.length <= lod) part.lods.push({ groups: [] });
    for (const g of meshGroups(o, toPart, opts.source === 'obj')) {
      const mname = matFor(g.material);
      const target = part.lods[lod].groups.find(x => x.material === mname);
      if (target) appendGroup(target, g); else part.lods[lod].groups.push({ material: mname, pos: g.pos, nrm: g.nrm, uv: g.uv, col: g.col, idx: g.idx });
    }
  });
  for (const o of hpObjs) {
    const part = ownerPart(o.parent);
    const m = noScale(new THREE.Matrix4().copy(part.frame).invert().multiply(world(o)));
    const ud = o.userData || {};
    let rev = null;
    const kind = (opts.hpKinds && opts.hpKinds[o.name]) || ((ud.hptype || '').toLowerCase() === 'rev' ? 'rev' : 'fix');
    if (kind === 'rev') rev = { axis: Array.isArray(ud.axis) ? ud.axis : [0, 1, 0], min: ud.min ?? -45, max: ud.max ?? 45 };
    part.hardpoints.push({ name: o.name, matrix: m, rev, hulls: ud._hulls || [] });
  }
  // remove empty parts (no geometry) except root
  for (const p of parts.slice(1)) if (!p.lods.length) { warnings.push(`part ${p.name} has no geometry — merged into ${p.parent}`); }
  // auto hulls
  for (const p of parts) {
    p.lods = p.lods.filter(l => l.groups.length);
    if (!p.hulls.length && opts.autoHull && p.lods[0]) {
      const pts = []; for (const g of p.lods[0].groups) pts.push(...g.pos);
      p.hulls.push(new Float32Array(pts));
    }
    p.matrix = p.parent ? new THREE.Matrix4().copy(parts.find(x => x.name === p.parent).frame).invert().multiply(p.frame) : new THREE.Matrix4();
  }
  if (!root.lods.length) {
    // FL requires geometry on the root part — promote the first part when the scene root is empty
    const first = parts.find(p => p !== root && p.lods.length);
    if (first && parts.length === 2) { root.lods = first.lods; root.hardpoints.push(...first.hardpoints); root.hulls.push(...first.hulls); parts.splice(parts.indexOf(first), 1); }
    else if (first) warnings.push('the scene root has no mesh; Freelancer needs geometry on the root part');
  }
  const model = { name, parts: parts.filter(p => p === root || p.lods.length), materials, textures, warnings };
  return model;
}

function meshPoints(geo, m) {
  const pos = geo.attributes.position, out = new Float32Array(pos.count * 3), v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i).applyMatrix4(m); out[i * 3] = v.x; out[i * 3 + 1] = v.y; out[i * 3 + 2] = v.z; }
  return out;
}
function meshGroups(mesh, m, flipV) {
  const geo = mesh.geometry, pos = geo.attributes.position, nrm = geo.attributes.normal, uv = geo.attributes.uv, col = geo.attributes.color;
  const nm = new THREE.Matrix3().getNormalMatrix(m);
  const index = geo.index ? geo.index.array : null;
  const count = index ? index.length : pos.count;
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const ranges = geo.groups.length ? geo.groups : [{ start: 0, count, materialIndex: 0 }];
  const flip = m.determinant() < 0; // mirrored transforms reverse winding
  const out = [];
  for (const r of ranges) {
    const material = mats[r.materialIndex ?? 0] || mats[0];
    const remap = new Map(); const P = [], N = [], U = [], Cc = [], I = [];
    const v = new THREE.Vector3();
    const end = Math.min(count, r.start + r.count);
    for (let k = r.start; k < end; k++) {
      const src = index ? index[k] : k;
      if (!remap.has(src)) {
        remap.set(src, P.length / 3);
        v.fromBufferAttribute(pos, src).applyMatrix4(m); P.push(v.x, v.y, v.z);
        if (nrm) { v.fromBufferAttribute(nrm, src).applyMatrix3(nm).normalize(); N.push(v.x, v.y, v.z); }
        if (uv) U.push(uv.getX(src), flipV ? 1 - uv.getY(src) : uv.getY(src));
        if (col && material.vertexColors) Cc.push(col.getX(src), col.getY(src), col.getZ(src), col.itemSize > 3 ? col.getW(src) : 1);
      }
      I.push(remap.get(src));
    }
    for (let t = 0; t + 2 < I.length; t += 3) if (flip) [I[t + 1], I[t + 2]] = [I[t + 2], I[t + 1]];
    let normals = N.length ? new Float32Array(N) : null;
    if (!normals) { const g2 = new THREE.BufferGeometry(); g2.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g2.setIndex(I); g2.computeVertexNormals(); normals = g2.attributes.normal.array; }
    out.push({ material, pos: new Float32Array(P), nrm: normals, uv: U.length ? new Float32Array(U) : null, col: Cc.length ? new Float32Array(Cc) : null, idx: new Uint16Array(I) });
    if (P.length / 3 > 65535) throw new Error(`mesh "${mesh.name}" has more than 65535 vertices`);
  }
  return out;
}
function appendGroup(t, g) {
  const base = t.pos.length / 3;
  const cat = (a, b) => { if (!a || !b) return null; const r = new a.constructor(a.length + b.length); r.set(a); r.set(b, a.length); return r; };
  const idx = new Uint16Array(t.idx.length + g.idx.length); idx.set(t.idx); for (let i = 0; i < g.idx.length; i++) idx[t.idx.length + i] = g.idx[i] + base;
  if (base + g.pos.length / 3 > 65535) throw new Error('a part has more than 65535 vertices after merging; use "keep parts" or reduce the mesh');
  t.pos = cat(t.pos, g.pos); t.nrm = cat(t.nrm, g.nrm); t.uv = cat(t.uv, g.uv); t.col = t.col || g.col ? cat(t.col || new Float32Array(base * 4).fill(1), g.col || new Float32Array(g.pos.length / 3 * 4).fill(1)) : null; t.idx = idx;
}

// ---------------- preview via the editor's own FL loader ----------------
function memoryApi(files) { return { read: async (p) => files.get(p.toLowerCase().replace(/\\/g, '/')) || null }; }
function viewer(el) {
  const canvas = h('canvas', { style: { width: '100%', height: '100%', display: 'block', borderRadius: '6px', background: 'var(--well)' } });
  el.append(canvas);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true, preserveDrawingBuffer: true });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(40, 1, 0.1, 1e7);
  scene.add(new THREE.AmbientLight(0x778899, 1.3)); const sun = new THREE.DirectionalLight(0xffffff, 1.7); camera.add(sun); sun.position.set(0.4, 0.6, 1); scene.add(camera);
  const orbit = new OrbitControls(camera, canvas); orbit.enableDamping = true;
  let running = true, content = null;
  const resize = () => { const r = el.getBoundingClientRect(); if (!r.width) return; renderer.setSize(r.width, r.height, false); camera.aspect = r.width / r.height; camera.updateProjectionMatrix(); };
  const ro = new ResizeObserver(resize); ro.observe(el);
  (function loop() { if (!running) return; orbit.update(); renderer.render(scene, camera); requestAnimationFrame(loop); })();
  return {
    show(obj, radius, center) {
      if (content) scene.remove(content); content = obj; if (!obj) return; scene.add(obj);
      orbit.target.copy(center); camera.position.copy(center).add(new THREE.Vector3(radius * 1.4, radius * 0.8, radius * 1.8)); camera.near = radius / 1000; camera.updateProjectionMatrix(); orbit.update();
    },
    dispose() { running = false; ro.disconnect(); renderer.dispose(); },
  };
}
function hullOverlay(sur) {
  const g = new THREE.Group();
  for (const part of sur) for (const hl of part.hulls) {
    if (hl.type === 5) continue;
    const pos = []; for (const f of hl.faces) for (const k of f) { const p = part.points[k]; if (p) pos.push(p[0], p[1], p[2]); }
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.add(new THREE.LineSegments(new THREE.WireframeGeometry(geo), new THREE.LineBasicMaterial({ color: 0x55ff99, transparent: true, opacity: 0.6 })));
  }
  return g;
}

// ---------------- import dialog ----------------
export function modelImport(app) {
  const fileIn = h('input', { type: 'file', multiple: true, accept: '.glb,.gltf,.bin,.obj,.mtl,.png,.jpg,.jpeg,.webp,.bmp,.tga' });
  const nameIn = h('input', { value: '', placeholder: 'model name', style: { width: '100%' } });
  const outIn = h('input', { value: 'SHIPS\\imported\\', style: { width: '100%' } });
  const scaleIn = h('input', { type: 'number', value: '1', step: 'any', style: { width: '90px' } });
  const zUp = h('input', { type: 'checkbox' }), flipF = h('input', { type: 'checkbox' }), autoHull = h('input', { type: 'checkbox', checked: true });
  const modeSel = h('select', {}, h('option', { value: 'merge' }, 'one part (merge all meshes) → .3db'), h('option', { value: 'parts' }, 'keep top-level nodes as parts → .cmp'));
  const texSel = h('select', {}, [512, 1024, 2048].map(n => h('option', { value: n, selected: n === 1024 }, n + ' px')));
  const info = h('div', { style: { fontSize: '12px', lineHeight: '1.5', maxHeight: '300px', overflow: 'auto' } }, 'Choose the model file and everything it references (.bin, .mtl, textures).');
  const view = h('div', { style: { height: '420px', position: 'relative' } });
  const v = viewer(view);
  let loaded = null, built = null, hpKinds = {};

  const form = h('div', { class: 'form', style: { display: 'grid', gridTemplateColumns: '130px 1fr', gap: '6px 10px', alignItems: 'center', fontSize: '12px' } },
    h('label', {}, 'Files'), fileIn,
    h('label', {}, 'Model name'), nameIn,
    h('label', {}, 'Save to (DATA\\…)'), outIn,
    h('label', {}, 'Structure'), modeSel,
    h('label', {}, 'Scale'), h('div', {}, scaleIn, h('span', { style: { opacity: .7, marginLeft: '8px' } }, '1 unit = 1 m in Freelancer')),
    h('label', {}, 'Axes'), h('div', {}, h('label', {}, zUp, ' source is Z-up'), '  ', h('label', {}, flipF, ' turn 180° (nose to −Z)')),
    h('label', {}, 'Collision'), h('label', {}, autoHull, ' convex hull per part when the file has no $hull nodes'),
    h('label', {}, 'Texture size'), texSel);

  async function rebuild() {
    if (!loaded) return;
    try {
      const model = sceneToModel(loaded.scene, { name: nameIn.value || loaded.name, scale: +scaleIn.value || 1, zUp: zUp.checked, flipForward: flipF.checked, mode: modeSel.value, autoHull: autoHull.checked, maxTex: +texSel.value, source: loaded.source, hpKinds });
      const isCmp = model.parts.length > 1;
      const ext = isCmp ? '.cmp' : '.3db';
      const bytes = buildModelUtf(model);
      const sur = buildSur(model);
      const dirPath = outIn.value.replace(/[\\/]+$/, '');
      const modelPath = `${dirPath}\\${model.name}${ext}`;
      built = { model, bytes, sur, modelPath, surPath: `${dirPath}\\${model.name}.sur` };
      // load back through the real FL loader
      const files = new Map([['mem/model' + ext, bytes]]);
      const rm = new ResourceManager(memoryApi(files));
      const obj = await rm.model('mem/model' + ext);
      let surParts = null; try { surParts = sur.bytes ? readSur(sur.bytes) : null; } catch (e) { sur.warnings.push('sur re-read failed: ' + e.message); }
      const grp = new THREE.Group(); if (obj) grp.add(obj); if (surParts) grp.add(hullOverlay(surParts));
      for (const hp of obj?.userData.hardpoints || []) { const s = new THREE.Mesh(new THREE.SphereGeometry((obj.userData.radius || 10) * 0.015), new THREE.MeshBasicMaterial({ color: 0xffd34d })); s.position.copy(hp.pos); grp.add(s); }
      v.show(grp, obj?.userData.radius || 10, obj?.userData.center || new THREE.Vector3());
      const tris = model.parts.reduce((s, p) => s + (p.lods[0]?.groups.reduce((a, g) => a + g.idx.length / 3, 0) || 0), 0);
      info.innerHTML = '';
      info.append(
        h('div', {}, h('b', {}, modelPath), ` · ${(bytes.length / 1024).toFixed(0)} KB · ${tris} triangles · ${model.materials.size} materials · ${model.textures.size} textures`),
        h('div', {}, `Collision: ${surParts ? surParts.reduce((s, p) => s + p.hulls.filter(x => x.type === 4).length, 0) + ' hulls in ' + surParts.length + ' part(s) → ' + built.surPath : 'none'}`),
        h('table', { class: 'grid', style: { width: '100%', marginTop: '6px' } },
          h('tr', {}, h('th', {}, 'Part'), h('th', {}, 'Parent'), h('th', {}, 'Joint'), h('th', {}, 'LODs'), h('th', {}, 'Hulls')),
          model.parts.map(p => h('tr', {}, h('td', {}, p.name), h('td', {}, p.parent || '—'), h('td', {}, p.parent ? p.kind : '—'), h('td', {}, p.lods.length), h('td', {}, p.hulls.length)))),
        h('div', { style: { marginTop: '6px' } }, h('b', {}, 'Hardpoints'), model.parts.flatMap(p => p.hardpoints).length ? null : ' — none (add empties named Hp… in Blender, or use the hardpoint editor afterwards)'),
        model.parts.flatMap(p => p.hardpoints.map(hp => {
          const sel = h('select', { onchange: () => { hpKinds[hp.name] = sel.value; rebuild(); } }, h('option', { value: 'fix', selected: !hp.rev }, 'fixed'), h('option', { value: 'rev', selected: !!hp.rev }, 'revolute'));
          return h('div', {}, `${hp.name} (${p.name}) `, sel);
        })),
        [...model.warnings, ...sur.warnings].length ? h('div', { style: { color: '#ffb366', marginTop: '6px' } }, [...model.warnings, ...sur.warnings].map(w => h('div', {}, '⚠ ' + w))) : null);
    } catch (e) { console.error(e); built = null; info.textContent = '✖ ' + e.message; }
  }
  fileIn.onchange = async () => {
    try {
      info.textContent = 'Loading…';
      loaded = await loadFiles([...fileIn.files]);
      if (!nameIn.value) nameIn.value = clean(loaded.name).toLowerCase();
      if (loaded.source === 'obj' && outIn.value === 'SHIPS\\imported\\') zUp.checked = false;
      hpKinds = {};
      await rebuild();
    } catch (e) { info.textContent = '✖ ' + e.message; }
  };
  for (const el of [nameIn, outIn, scaleIn, zUp, flipF, autoHull, modeSel, texSel]) el.addEventListener('change', rebuild);

  async function write(withArch) {
    if (!built) { toast('Nothing to write yet'); return false; }
    if (await api.exists(dataPath(built.modelPath)) && !(await confirmDialog('Overwrite model', `${built.modelPath} exists. Overwrite? (the original is backed up)`, 'Overwrite', true))) return false;
    await api.write(dataPath(built.modelPath), built.bytes);
    if (built.sur.bytes) await api.write(dataPath(built.surPath), built.sur.bytes);
    app.rm.invalidate(dataPath(built.modelPath));
    toast(`Wrote ${built.modelPath}${built.sur.bytes ? ' and .sur' : ''}`);
    if (withArch) await addSolarArchetype(app, built);
    return false;
  }
  modal({
    title: 'Import model (glTF / OBJ → Freelancer)', wide: true,
    body: h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' } }, h('div', {}, form, h('hr'), info), view),
    onClose: () => v.dispose(),
    buttons: [{ label: 'Close' }, { label: 'Write + add solar archetype…', onClick: () => write(true) }, { label: 'Write files', cls: 'primary', onClick: () => write(false) }],
  });
}

async function addSolarArchetype(app, built) {
  const path = 'DATA/SOLAR/solararch.ini';
  const doc = app.docs?.get?.(path) || null;
  const nick = await promptDialog('New solar archetype', 'Nickname for the new [Solar] archetype', built.model.name);
  if (!nick) return;
  const bytes = await api.read(path); if (!bytes) { toast('solararch.ini not found'); return; }
  const r = built.model.parts[0].lods[0];
  let radius = 10; if (r) for (const g of r.groups) for (let i = 0; i < g.pos.length; i += 3) radius = Math.max(radius, Math.hypot(g.pos[i], g.pos[i + 1], g.pos[i + 2]));
  const block = `\r\n[Solar]\r\nnickname = ${nick}\r\ntype = STATION\r\nDA_archetype = ${built.modelPath.replace(/\//g, '\\')}\r\nsurface_hit_effects = 0, small_hit_spark_debris01\r\nmass = 10000\r\nsolar_radius = ${Math.round(radius)}\r\nshape_name = NAV_depot\r\nhit_pts = 1000000\r\nphantom_physics = ${built.sur.bytes ? 'false' : 'true'}\r\n`;
  const text = new TextDecoder('latin1').decode(bytes);
  if (new RegExp('^\\s*nickname\\s*=\\s*' + nick + '\\s*$', 'im').test(text)) { toast('An archetype with that nickname already exists'); return; }
  await api.write(path, new TextEncoder().encode(text.replace(/\s*$/, '') + '\r\n' + block));
  toast(`Added [Solar] ${nick} — restart the editor (or reload) to place it`);
  void doc; void IniDocument;
}

// ---------------- export (.cmp/.3db → GLB) ----------------
export async function exportModelGlb(app, path, { matLibs = [], withHulls = true } = {}) {
  const tpl = await app.rm.model(path, matLibs);
  if (!tpl) { toast('Model could not be loaded'); return null; }
  const out = new THREE.Group(); out.name = path.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
  const texCache = new Map();
  const texFromName = (nm) => {
    if (!nm) return null;
    const k = nm.toLowerCase(); if (texCache.has(k)) return texCache.get(k);
    const node = app.rm.textures.get(k); let t = null;
    try {
      const img = node && decodeTextureNode(node);
      if (img) {
        const c = document.createElement('canvas'); c.width = img.w; c.height = img.h;
        c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.rgba.buffer, img.rgba.byteOffset, img.rgba.length), img.w, img.h), 0, 0);
        t = new THREE.CanvasTexture(c); t.flipY = false; t.colorSpace = THREE.SRGBColorSpace; t.name = nm.replace(/\.[^.]+$/, '');
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
      }
    } catch (e) { console.warn('texture export', nm, e); }
    texCache.set(k, t); return t;
  };
  const matCache = new Map();
  const conv = (src) => {
    if (matCache.has(src)) return matCache.get(src);
    const def = app.rm.materials.get(dacomCrc(src.name || '')) || null;
    const m = new THREE.MeshStandardMaterial({ name: src.name || 'material', color: src.color ? src.color.clone() : 0xffffff, roughness: 0.8, metalness: 0.1, side: src.side, transparent: src.transparent, opacity: src.opacity, alphaTest: src.alphaTest });
    if (def?.dt) m.map = texFromName(def.dt);
    if (def?.et) { m.emissiveMap = texFromName(def.et); m.emissive = new THREE.Color(1, 1, 1); }
    else if (def?.ec) m.emissive = new THREE.Color(...def.ec);
    matCache.set(src, m); return m;
  };
  // copy hierarchy, replacing materials
  (function copy(src, dst) {
    for (const c of src.children) {
      let n;
      if (c.isMesh) { n = new THREE.Mesh(c.geometry, conv(c.material)); n.name = c.name || ''; }
      else { n = new THREE.Group(); n.name = c.name || ''; }
      n.matrixAutoUpdate = false; n.matrix.copy(c.matrix); n.matrix.decompose(n.position, n.quaternion, n.scale);
      if (c.userData?.cons) n.userData = { construct: c.userData.cons.kind, ...(c.userData.cons.axis ? { axis: c.userData.cons.axis, min: c.userData.cons.min, max: c.userData.cons.max, offset: c.userData.cons.offset } : {}) };
      dst.add(n); copy(c, n);
    }
  })(tpl, out);
  // hardpoints as empties (part-local when the part is known)
  out.updateMatrixWorld(true);
  for (const hp of tpl.userData.hardpoints || []) {
    const e = new THREE.Object3D(); e.name = hp.name;
    const local = new THREE.Matrix4();
    if (hp.rot) local.copy(new THREE.Matrix4().set(hp.rot[0], hp.rot[1], hp.rot[2], 0, hp.rot[3], hp.rot[4], hp.rot[5], 0, hp.rot[6], hp.rot[7], hp.rot[8], 0, 0, 0, 0, 1));
    const partObj = hp.partName ? out.getObjectByName(hp.partName) : null;
    const lp = hp.localPos || hp.pos;
    local.setPosition(lp.x, lp.y, lp.z);
    e.userData = { hardpoint: true, ...(hp.revolute ? { hptype: 'rev' } : {}) };
    (partObj || out).add(e); e.matrix.copy(local); e.matrix.decompose(e.position, e.quaternion, e.scale);
    if (!partObj && hp.partMatrix) { e.matrix.premultiply(hp.partMatrix); e.matrix.decompose(e.position, e.quaternion, e.scale); }
  }
  // collision hulls from the .sur next to the model
  if (withHulls) {
    const surBytes = await api.read(path.replace(/\.(cmp|3db)$/i, '.sur'));
    if (surBytes) try {
      const sur = readSur(surBytes);
      for (const part of sur) part.hulls.filter(x => x.type === 4 && x.hullId === part.crc).forEach((hl, i) => {
        const pos = []; for (const f of hl.faces) for (const k of f) { const p = part.points[k]; pos.push(p[0], p[1], p[2]); }
        const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.computeVertexNormals();
        const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x33ff88, wireframe: true, name: 'hull' }));
        const owner = [...out.children, ...out.children.flatMap(c => c.children)].find(o => dacomCrc(o.name || '') === part.crc);
        mesh.name = `${owner ? owner.name : out.name}${i ? '_' + i : ''}$hull`; mesh.userData = { hull: true };
        (owner || out).add(mesh);
      });
    } catch (e) { console.warn('sur export', e); }
  }
  const glb = await new GLTFExporter().parseAsync(out, { binary: true });
  return new Uint8Array(glb);
}

export async function exportModelDialog(app, path, matLibs = []) {
  try {
    const bytes = await exportModelGlb(app, path, { matLibs });
    if (!bytes) return;
    const name = path.split(/[\\/]/).pop().replace(/\.[^.]+$/, '') + '.glb';
    await api.write('editor_exports/' + name, bytes);
    const a = h('a', { href: URL.createObjectURL(new Blob([bytes], { type: 'model/gltf-binary' })), download: name }); document.body.append(a); a.click(); a.remove();
    toast(`Exported ${name} (${(bytes.length / 1024).toFixed(0)} KB) — also saved to <game>\\editor_exports`);
  } catch (e) { console.error(e); toast('Export failed: ' + e.message); }
}
