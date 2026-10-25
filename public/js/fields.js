// Asteroid fields and nebulae:
//   Render/AsteroidFieldRenderer.cs, AsteroidCubeMesh.cs, AsteroidFieldShared.cs, GameData/World/AsteroidCubeRotation.cs,
//   Render/NebulaRenderer.cs, Shaders/AsteroidBand.frag, NebulaExtPuff.*, NebulaInterior.*
// Details: puff billboard rotation (sin and cos, not sin twice), nebula fill-plane UVs
// (two planes need the right 4th UV), ellipsoid nebula puff/fill sizes (radii, not halved —
// they are radii everywhere), bit_radius_random_variation parsed as float (not int → 0).
import * as THREE from 'three';
import { dataPath } from './api.js';
import { shapeTex } from './shapes.js';
import { zoneShape, contains, scaledDistance, boundingRadius } from './zonemath.js';
import { dacomCrc } from './formats/crc.js';

const DEG = Math.PI / 180;
const col = (v, def = [1, 1, 1]) => { if (!v) return def; const n = v.map(parseFloat); const big = n.some(x => x > 1.0001); return n.slice(0, 3).map(x => big ? x / 255 : x); };
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ---------- AsteroidFieldShared (exact port: cube placement + hash) ----------
const _f = new Float32Array(1), _u = new Uint32Array(_f.buffer);
function hash(x) { x = (x + (x << 10)) >>> 0; x = (x ^ (x >>> 6)) >>> 0; x = (x + (x << 3)) >>> 0; x = (x ^ (x >>> 11)) >>> 0; x = (x + (x << 15)) >>> 0; return x; }
function fbits(v) { _f[0] = v; return _u[0]; }
export function positionHash(x, y, z) {
  let h = hash(fbits(x));
  h = (Math.imul(3, h) + hash(fbits(y))) >>> 0;
  h = (Math.imul(7, h) + hash(fbits(z))) >>> 0;
  _u[0] = (h & 0x007FFFFF) | 0x3F800000; return _f[0] - 1;
}
function cubeExists(x, y, z, empty) {
  if (empty >= 1) return -1;
  const hv = positionHash(x, y, z);
  if (hv > empty) { const rot = empty > 1e-7 ? (hv - empty) / (1 - empty) : hv; return Math.floor(rot * 63); }
  return -1;
}
function closeCube(c, size) {
  const t = (v) => Math.trunc(v < 0 ? v - 0.1 : v + 0.1);
  const px = t(c.x), py = t(c.y), pz = t(c.z);
  const sz = Math.trunc((size + 1) * 0.5);
  return new THREE.Vector3(
    Math.trunc(px / size) * size + (px < 1 ? sz : -sz),
    Math.trunc(py / size) * size + (py < 1 ? sz : -sz),
    Math.trunc(pz / size) * size + (pz < 1 ? sz : -sz));
}
// AsteroidCubeRotation: 64 variants from 4 angles per axis, Rx·Ry·Rz (row-vector) == THREE Euler 'ZYX'
function cubeRotations(ax, ay, az) {
  const out = [];
  for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) for (let z = 0; z < 4; z++)
    out.push(new THREE.Quaternion().setFromEuler(new THREE.Euler(ax[x] * DEG, ay[y] * DEG, az[z] * DEG, 'ZYX')));
  return out;
}
const DEFAULT_AXIS = [0, 90, 180, 270];

// "Exclusion Zones": each exclusion/exclude line starts a group; following keys belong to it
export function exclusionGroups(ini) {
  const out = [];
  for (const s of ini.all('Exclusion Zones')) {
    let cur = null;
    for (const e of s.entries) {
      if (/^(exclusion|exclude)$/i.test(e.key)) { cur = { zone: e.value, props: {}, entries: [e] }; out.push(cur); }
      else if (cur) { cur.props[e.key.toLowerCase()] = e.value; cur.entries.push(e); }
    }
  }
  return out;
}

// ---------- texture shapes ----------
async function loadPanels(app, iniDoc) {
  const tp = iniDoc.first('TexturePanels');
  const files = tp ? tp.getAll('file') : [];
  const shapes = new Map();
  for (const f of files) {
    const p = await app.game.texturePanels(f);
    await Promise.all(p.files.map(t => app.rm.loadUtf(dataPath(t))));
    for (const [k, v] of p.shapes) shapes.set(k, v);
  }
  return shapes;
}

// ---------- billboard shader (camera-facing quad/tri, per-instance pos/size/rot/uv/color) ----------
const BB_VERT = `
attribute vec2 corner; attribute vec2 cuv;
attribute vec3 iPos; attribute vec2 iSize; attribute float iRot; attribute vec4 iRect; attribute vec4 iColor;
varying vec2 vUv; varying vec4 vColor;
#include <common>
#include <logdepthbuf_pars_vertex>
void main(){
  vec3 R = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 U = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  float s = sin(iRot), c = cos(iRot);
  vec2 k = vec2(c * corner.x - s * corner.y, s * corner.x + c * corner.y) * iSize * 0.5;
  vec3 pos = iPos + R * k.x + U * k.y;
  vUv = iRect.xy + cuv * iRect.zw; vColor = iColor;
  gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
  #include <logdepthbuf_vertex>
}`;
const BB_FRAG = `
uniform sampler2D map; uniform float hasMap;
varying vec2 vUv; varying vec4 vColor;
#include <logdepthbuf_pars_fragment>
void main(){
  #include <logdepthbuf_fragment>
  vec4 t = hasMap > 0.5 ? texture2D(map, vUv) : vec4(1.0);
  gl_FragColor = t * vColor;
  if (gl_FragColor.a < 0.004) discard;
  #include <colorspace_fragment>
}`;
function billboardMesh(tex, max, tri = false) {
  const g = new THREE.InstancedBufferGeometry();
  if (tri) { // centre + two corners of the texture → triangle sprite
    const a = [90, 210, 330].map(d => d * DEG);
    g.setAttribute('position', new THREE.Float32BufferAttribute(a.flatMap(t => [Math.cos(t), Math.sin(t), 0]), 3));
    g.setAttribute('corner', new THREE.Float32BufferAttribute(a.flatMap(t => [Math.cos(t), Math.sin(t)]), 2));
    g.setAttribute('cuv', new THREE.Float32BufferAttribute([0.5, 0.5, 0, 0, 1, 0], 2));
    g.setIndex([0, 1, 2]);
  } else {
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0], 3));
    g.setAttribute('corner', new THREE.Float32BufferAttribute([-1, -1, 1, -1, -1, 1, 1, 1], 2));
    g.setAttribute('cuv', new THREE.Float32BufferAttribute([0, 1, 1, 1, 0, 0, 1, 0], 2));
    g.setIndex([0, 1, 2, 1, 3, 2]);
  }
  const A = {};
  for (const [n, sz] of [['iPos', 3], ['iSize', 2], ['iRot', 1], ['iRect', 4], ['iColor', 4]]) { A[n] = new THREE.InstancedBufferAttribute(new Float32Array(max * sz), sz); A[n].setUsage(THREE.DynamicDrawUsage); g.setAttribute(n, A[n]); }
  g.instanceCount = 0;
  const m = new THREE.Mesh(g, new THREE.ShaderMaterial({ vertexShader: BB_VERT, fragmentShader: BB_FRAG, uniforms: { map: { value: tex }, hasMap: { value: tex ? 1 : 0 } }, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
  m.frustumCulled = false; m.userData.noPick = true; m.renderOrder = 7;
  m.userData.attrs = A; m.userData.max = max;
  return m;
}

// =====================================================================================
export class AsteroidFieldRenderer {
  constructor(app, zoneSec, doc, file) { this.app = app; this.zoneSec = zoneSec; this.doc = doc; this.file = file; this.group = new THREE.Group(); this.group.userData.noPick = true; this.lastCam = null; }
  async init() {
    const app = this.app, d = this.doc.ini, g = app.game;
    this.z = zoneShape(this.zoneSec);
    const F = d.first('Field');
    this.cubeSize = F ? F.num('cube_size', 100) || 100 : 100;
    this.fill = F ? F.num('fill_dist', 100) || 100 : 100;
    this.empty = F ? F.num('empty_cube_frequency', 0) : 0;
    const tint = F && F.vals('tint_field');
    this.diffuse = new THREE.Color(...col(tint || (F && F.vals('diffuse_color'))));
    this.shapes = await loadPanels(app, d);
    // exclusion zones ("exclusion"/"exclude" start a new group)
    this.exclusions = [];
    for (const g of exclusionGroups(d)) { const zs = app.sys.byNick(g.zone); if (zs) { const z = zoneShape(zs); z.billboards = /^(1|true)$/i.test(g.props.exclude_billboards || ''); this.exclusions.push(z); } }
    // cube
    const C = d.first('Cube');
    const axis = (k) => (C && C.vals(k) ? C.vals(k).map(parseFloat) : DEFAULT_AXIS);
    this.rotations = cubeRotations(axis('xaxis_rotation'), axis('yaxis_rotation'), axis('zaxis_rotation'));
    this.parts = []; // { mesh: InstancedMesh, local: Matrix4 }
    this.cubeRadius = 0;
    const asts = C ? C.findAll('asteroid').map(e => e.values) : [];
    for (const a of asts) {
      const arch = g.asteroids.get((a[0] || '').toLowerCase());
      if (!arch || !arch.da) continue;
      const model = await app.rm.model(dataPath(arch.da), arch.matLibs.map(dataPath));
      if (!model) continue;
      const pos = new THREE.Vector3(+a[1], +a[2], +a[3]).multiplyScalar(this.cubeSize);
      const rot = new THREE.Quaternion().setFromEuler(new THREE.Euler((+a[4] || 0) * DEG, (+a[5] || 0) * DEG, (+a[6] || 0) * DEG, 'ZYX'));
      const astM = new THREE.Matrix4().compose(pos, rot, new THREE.Vector3(1, 1, 1));
      model.updateMatrixWorld(true);
      model.traverse(o => {
        if (!o.isMesh) return;
        const mat = o.material.clone(); if (mat.color) mat.color.multiply(this.diffuse);
        const im = new THREE.InstancedMesh(o.geometry, mat, 3000);
        im.count = 0; im.frustumCulled = false; im.userData.noPick = true;
        this.parts.push({ mesh: im, local: astM.clone().multiply(o.matrixWorld) });
        this.group.add(im);
      });
      this.cubeRadius = Math.max(this.cubeRadius, pos.length() + (model.userData.radius || 0));
    }
    // band
    const B = d.first('Band');
    if (B && B.get('shape') && (this.z.shape === 'SPHERE' || this.z.shape === 'ELLIPSOID')) this.makeBand(B);
    // billboards
    const BB = d.first('AsteroidBillboards');
    if (BB && BB.has('count')) this.makeBillboards(BB);
  }
  makeBand(B) {
    const st = shapeTex(this.app, this.shapes, B.get('shape'));
    const sides = 20, h = B.num('height', 1000), off = B.num('offset_dist', 0);
    const parts = Math.max(1, B.num('render_parts', 1)), aspect = B.num('texture_aspect', 1);
    const cs = col(B.vals('color_shift'), [1, 1, 1]);
    const geo = new THREE.CylinderGeometry(1, 1, 2, sides, 1, true);
    // texture repeats render_parts times around the ring; texture_aspect scales U (AsteroidBand.frag)
    const uv = geo.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * parts, 1 - uv.getY(i));
    const rect = st ? st.rect : [0, 0, 1, 1];
    const mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: st ? st.tex : null }, hasMap: { value: st ? 1 : 0 }, shift: { value: new THREE.Color(...cs) }, aspect: { value: aspect }, rect: { value: new THREE.Vector4(...rect) } },
      vertexShader: `varying vec2 vUv; varying vec3 vW;
        #include <common>
        #include <logdepthbuf_pars_vertex>
        void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w;
        #include <logdepthbuf_vertex>
        }`,
      fragmentShader: `uniform sampler2D map; uniform float hasMap; uniform vec3 shift; uniform float aspect; uniform vec4 rect; varying vec2 vUv; varying vec3 vW;
        #include <logdepthbuf_pars_fragment>
        void main(){
        #include <logdepthbuf_fragment>
          float dist = distance(cameraPosition, vW);
          float alpha = (12000.0 - max(12000.0 - dist, 0.0)) / 12000.0;
          vec2 t = vec2(fract(vUv.x * aspect), vUv.y);
          vec4 tex = hasMap > 0.5 ? texture2D(map, rect.xy + t * rect.zw) : vec4(0.6,0.55,0.5,0.5);
          gl_FragColor = vec4(tex.rgb * shift, tex.a * alpha);
          #include <colorspace_fragment>
        }`,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    const m = new THREE.Mesh(geo, mat); m.userData.noPick = true; m.renderOrder = 6;
    const sz = this.z.shape === 'SPHERE' ? [this.z.size[0], this.z.size[0], this.z.size[0]] : this.z.size.slice();
    m.scale.set(Math.max(1, sz[0] - off), h / 2, Math.max(1, sz[2] - off));
    m.position.copy(this.z.pos); m.quaternion.copy(this.z.quat);
    this.band = m; this.group.add(m);
  }
  makeBillboards(BB) {
    const count = Math.min(9000, BB.num('count', 0));
    if (count <= 0) return;
    this.bb = { start: BB.num('start_dist', 0), fadePct: BB.num('fade_dist_percent', 0), size: (BB.vals('size') || ['50', '100']).map(parseFloat), tint: col(BB.vals('color_shift'), [1, 1, 1]) };
    const st = shapeTex(this.app, this.shapes, BB.get('shape'));
    this.bbRect = st ? st.rect : [0, 0, 1, 1];
    const r = rng(dacomCrc(this.zoneSec.get('nickname') || 'field'));
    this.bbCube = Array.from({ length: count }, () => ({ p: new THREE.Vector3(r() * 2 - 1, r() * 2 - 1, r() * 2 - 1).multiplyScalar(this.fill), size: (this.bb.size[0] + r() * (this.bb.size[1] - this.bb.size[0])) * 2, tex: Math.floor(r() * 4) }));
    this.bbMesh = billboardMesh(st ? st.tex : null, count, true);
    this.group.add(this.bbMesh);
  }
  bbAlpha(dist) {
    const F = this.fill, S = this.bb.start;
    if (dist >= S) return (F - dist) / (F - S);
    const near = S - S * this.bb.fadePct;
    if (dist >= near) return (dist - near) / (S * this.bb.fadePct);
    return 0;
  }
  // re-place cubes/billboards around the camera (only when the camera is within reach of the field)
  update(cam) {
    const reach = boundingRadius(this.z) + this.fill;
    const near = cam.distanceTo(this.z.pos) <= reach;
    this.group.visible = true;
    if (!near) { for (const p of this.parts) p.mesh.count = 0; if (this.bbMesh) this.bbMesh.geometry.instanceCount = 0; return; }
    if (this.lastCam && this.lastCam.distanceTo(cam) < this.cubeSize * 0.25) { if (this.bbMesh) this.updateBillboardAlpha(cam); return; }
    this.lastCam = cam.clone();
    // ---- cubes (AsteroidFieldRenderer.CalculateAsteroidsTask)
    if (this.parts.length) {
      const close = closeCube(cam, this.cubeSize);
      const n = Math.floor(this.fill / this.cubeSize) + 1;
      const m = new THREE.Matrix4(), c = new THREE.Vector3();
      let k = 0;
      const cap = this.parts[0].mesh.instanceMatrix.count;
      for (let x = -n; x <= n && k < cap; x++) for (let y = -n; y <= n && k < cap; y++) for (let z = -n; z <= n && k < cap; z++) {
        c.set(close.x + x * this.cubeSize, close.y + y * this.cubeSize, close.z + z * this.cubeSize);
        if (c.distanceTo(cam) - this.cubeRadius >= this.fill) continue;
        if (!contains(this.z, c)) continue;
        const rv = cubeExists(c.x, c.y, c.z, this.empty); if (rv < 0) continue;
        if (this.exclusions.some(e => contains(e, c))) continue;
        m.compose(c, this.rotations[rv & 63], new THREE.Vector3(1, 1, 1));
        for (const p of this.parts) { const mm = m.clone().multiply(p.local); p.mesh.setMatrixAt(k, mm); }
        k++;
      }
      for (const p of this.parts) { p.mesh.count = k; p.mesh.instanceMatrix.needsUpdate = true; }
      this.cubeCount = k;
    }
    // ---- billboards (CalculateBillboards)
    if (this.bbMesh) {
      const size = this.fill * 2, close = closeCube(cam, size);
      const list = [];
      const def = cubeRotations(DEFAULT_AXIS, DEFAULT_AXIS, DEFAULT_AXIS);
      for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
        const center = close.clone().add(new THREE.Vector3(x, y, z).multiplyScalar(size));
        if (center.distanceTo(cam) - (this.fill + this.bb.size[1]) > this.fill) continue;
        if (scaledDistance(this.z, center) > 1.1) continue;
        const q = def[Math.floor(positionHash(center.x, center.y, center.z) * 63) & 63];
        for (const b of this.bbCube) {
          const p = b.p.clone().applyQuaternion(q).add(center);
          if (p.distanceTo(cam) > this.fill) continue;
          if (this.exclusions.some(e => e.billboards && contains(e, p))) continue;
          list.push({ p, size: b.size, tex: b.tex, d: center.distanceToSquared(cam) });
        }
      }
      list.sort((a, b) => a.d - b.d);
      this.bbList = list.slice(0, this.bbMesh.userData.max);
      this.updateBillboardAlpha(cam);
    }
  }
  updateBillboardAlpha(cam) {
    const A = this.bbMesh.userData.attrs; let n = 0;
    const [rx, ry, rw, rh] = this.bbRect;
    // the 4 triangle billboard variants, expressed as rotation of one tri layout
    for (const b of this.bbList || []) {
      const a = this.bbAlpha(b.p.distanceTo(cam)); if (a <= 0) continue;
      A.iPos.setXYZ(n, b.p.x, b.p.y, b.p.z); A.iSize.setXY(n, b.size, b.size); A.iRot.setX(n, b.tex * Math.PI / 2);
      A.iRect.setXYZW(n, rx, ry, rw, rh); A.iColor.setXYZW(n, this.bb.tint[0], this.bb.tint[1], this.bb.tint[2], Math.min(1, a));
      n++;
    }
    this.bbMesh.geometry.instanceCount = n;
    for (const k in A) A[k].needsUpdate = true;
  }
  dispose() { for (const p of this.parts) { p.mesh.dispose(); p.mesh.material.dispose(); } }
}

// =====================================================================================
export class NebulaRenderer {
  constructor(app, zoneSec, doc, file) { this.app = app; this.zoneSec = zoneSec; this.doc = doc; this.file = file; this.group = new THREE.Group(); this.group.userData.noPick = true; }
  async init() {
    const app = this.app, d = this.doc.ini;
    this.z = zoneShape(this.zoneSec);
    this.shapes = await loadPanels(app, d);
    const fog = d.first('Fog'), ext = d.first('Exterior'), cl = d.first('Clouds'), nl = d.first('NebulaLight');
    this.fogColor = new THREE.Color(...col(fog && fog.vals('color'), [0.1, 0.1, 0.15]));
    this.fogNear = fog ? fog.num('near', 0) : 0; this.fogFar = fog ? fog.num('distance', 2000) : 2000;
    this.fogEnabled = fog ? fog.num('fog_enabled', 0) !== 0 : false;
    this.ambient = nl && nl.vals('ambient') ? new THREE.Color(...col(nl.vals('ambient'))) : null;
    if (this.z.shape === 'SPHERE' || this.z.shape === 'ELLIPSOID') {
      if (ext) this.makeExterior(ext);
    }
    if (cl) this.clouds = { maxDist: cl.num('max_distance', 300), count: Math.min(200, cl.num('puff_count', 0)), radius: cl.num('puff_radius', 100), a: col(cl.vals('puff_colora')), b: col(cl.vals('puff_colorb')), alpha: cl.num('puff_max_alpha', 0.5), shapes: cl.getAll('puff_shape'), weights: (cl.vals('puff_weights') || []).map(Number), drift: cl.num('puff_drift', 0), fade: (cl.vals('near_fade_distance') || ['0', '0']).map(parseFloat) };
    if (this.clouds && this.clouds.count > 0) { this.cloudMesh = billboardMesh(null, this.clouds.count); this.group.add(this.cloudMesh); this.cloudPuffs = []; }
  }
  radii() { return this.z.shape === 'SPHERE' ? [this.z.size[0], this.z.size[0], this.z.size[0]] : this.z.size; }
  makeExterior(ext) {
    const sz = this.radii(); const R = new THREE.Vector3(...sz);
    const rn = rng(dacomCrc(this.zoneSec.get('nickname') || 'nebula'));
    const shapes = ext.getAll('shape'); const weights = (ext.vals('shape_weights') || []).map(Number);
    const pick = () => { if (!shapes.length) return null; const tot = shapes.reduce((a, _, i) => a + (weights[i] || 1), 0); let r = rn() * tot; for (let i = 0; i < shapes.length; i++) { r -= (weights[i] || 1); if (r <= 0) return shapes[i]; } return shapes[shapes.length - 1]; };
    const minB = ext.num('min_bits', 3), maxB = Math.max(minB, ext.num('max_bits', 6));
    const bitR = ext.num('bit_radius', 1000), varr = parseFloat(ext.get('bit_radius_random_variation') || '0') || 0, move = ext.num('move_bit_percent', 0);
    const color = col(ext.vals('color'), [1, 1, 1]);
    // group puffs by texture so each texture gets one instanced mesh
    const byTex = new Map();
    for (const ypct of [0.25, 0.5, 0.75]) { // GeneratePuffRing
      const yval = ypct * R.y;
      const count = minB + Math.floor(rn() * (maxB - minB + 1));
      let ang = 0; const dA = Math.PI * 2 / count;
      for (let i = 0; i < count; i++) {
        const y = yval - R.y * move + rn() * (2 * R.y * move);
        // PrimitiveMath.GetPointOnRadius
        const yr = y - R.y / 2; const r = Math.sqrt(Math.max(0, R.y * R.y - yr * yr));
        const pos = new THREE.Vector3(Math.cos(ang) * r * (R.x / R.y), y - R.y / 2, Math.sin(ang) * r * (R.z / R.y));
        const radius = bitR * (1 - varr) + rn() * (bitR * 2 * varr);
        const st = shapeTex(this.app, this.shapes, pick());
        const key = st ? st.tex.uuid : 'none';
        if (!byTex.has(key)) byTex.set(key, { st, list: [] });
        byTex.get(key).list.push({ pos, size: radius * 2, rot: rn() * Math.PI * 2 - Math.PI });
        ang += dA;
      }
    }
    for (const { st, list } of byTex.values()) {
      const m = billboardMesh(st ? st.tex : null, list.length);
      const A = m.userData.attrs; const rect = st ? st.rect : [0, 0, 1, 1];
      list.forEach((p, i) => { const w = p.pos.clone().applyQuaternion(this.z.quat).add(this.z.pos); A.iPos.setXYZ(i, w.x, w.y, w.z); A.iSize.setXY(i, p.size, p.size); A.iRot.setX(i, p.rot); A.iRect.setXYZW(i, ...rect); A.iColor.setXYZW(i, color[0], color[1], color[2], 1); });
      m.geometry.instanceCount = list.length; m.userData.exterior = true;
      this.group.add(m);
    }
    // fill: three orthogonal textured planes (NebulaFill) tinted with the fog colour
    const fill = shapeTex(this.app, this.shapes, ext.get('fill_shape'));
    if (fill) {
      const [x, y, w, h] = fill.rect;
      const u = (a, b) => [x + a * w, y + b * h];
      const pos = [], uv = [], idx = [];
      const quad = (pts) => { const b = pos.length / 3; pts.forEach(p => pos.push(...p)); [u(0, 1), u(1, 1), u(0, 0), u(1, 0)].forEach(t => uv.push(...t)); idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2); };
      quad([[-1, -1, 0], [1, -1, 0], [-1, 1, 0], [1, 1, 0]]);
      quad([[0, -1, -1], [0, -1, 1], [0, 1, -1], [0, 1, 1]]);
      quad([[-1, 0, -1], [-1, 0, 1], [1, 0, -1], [1, 0, 1]]);
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx);
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: fill.tex, color: this.fogColor.clone().lerp(new THREE.Color(...color), 0.5), transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false }));
      m.scale.copy(R); m.position.copy(this.z.pos); m.quaternion.copy(this.z.quat);
      m.userData.noPick = true; m.renderOrder = 5; m.userData.fill = true;
      this.group.add(m);
    }
  }
  update(cam, dt) {
    const inside = contains(this.z, cam);
    this.inside = inside;
    for (const c of this.group.children) if (c.userData.fill) c.visible = !inside;
    if (!this.cloudMesh) return;
    if (!inside) { this.cloudMesh.geometry.instanceCount = 0; return; }
    const C = this.clouds; const A = this.cloudMesh.userData.attrs;
    while (this.cloudPuffs.length < C.count) this.cloudPuffs.push({ spawned: false });
    let n = 0;
    for (const p of this.cloudPuffs) {
      if (!p.spawned || p.pos.distanceTo(cam) > C.maxDist) {
        const t = Math.random(); p.color = C.a.map((v, i) => v + (C.b[i] - v) * t);
        p.st = shapeTex(this.app, this.shapes, C.shapes[Math.floor(Math.random() * C.shapes.length)]);
        const dir = new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
        p.pos = cam.clone().addScaledVector(dir, C.maxDist * Math.cbrt(Math.random()));
        p.vel = new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize().multiplyScalar(C.drift);
        p.spawned = true;
        if (p.st && !this.cloudMesh.material.uniforms.map.value) { this.cloudMesh.material.uniforms.map.value = p.st.tex; this.cloudMesh.material.uniforms.hasMap.value = 1; }
      }
      p.pos.addScaledVector(p.vel, dt || 0);
      const d = p.pos.distanceTo(cam); let a = C.alpha;
      if (d < C.fade[0]) a = 0; else if (d < C.fade[1]) { const diff = C.fade[1] - C.fade[0]; a -= a * (diff - (d - C.fade[0])) / diff; }
      const r = p.st ? p.st.rect : [0, 0, 1, 1];
      A.iPos.setXYZ(n, p.pos.x, p.pos.y, p.pos.z); A.iSize.setXY(n, C.radius, C.radius); A.iRot.setX(n, 0); A.iRect.setXYZW(n, ...r); A.iColor.setXYZW(n, p.color[0], p.color[1], p.color[2], a);
      n++;
    }
    this.cloudMesh.geometry.instanceCount = n;
    for (const k in A) A[k].needsUpdate = true;
  }
  dispose() { }
}

// =====================================================================================
export class FieldManager {
  constructor(app) { this.app = app; this.items = []; this.group = new THREE.Group(); this.group.userData.noPick = true; this.token = 0; }
  clear() { for (const it of this.items) it.dispose(); this.items = []; this.group.clear(); }
  // only zones/links that feed a field matter; moving a station must not rebuild every field
  signature(sys) {
    const parts = [];
    for (const kind of ['Asteroids', 'Nebula']) for (const s of sys.ini.all(kind)) {
      const z = sys.byNick(s.get('zone') || ''); parts.push(kind, s.get('file'), s.get('zone'), z ? z.text('\n') : '-');
    }
    return parts.join('|');
  }
  async build(sys) {
    this.sig = sys ? this.signature(sys) : '';
    const my = ++this.token;
    this.clear();
    if (!this.app.settings.fields) return;
    const jobs = [];
    for (const kind of ['Asteroids', 'Nebula']) for (const s of sys.ini.all(kind)) {
      const file = s.get('file'), zn = s.get('zone'); if (!file || !zn) continue;
      const zone = sys.byNick(zn); if (!zone) continue;
      jobs.push((async () => {
        const doc = await this.app.otherDoc(dataPath(file)); if (!doc) return;
        const R = kind === 'Asteroids' ? AsteroidFieldRenderer : NebulaRenderer;
        const r = new R(this.app, zone, doc, file);
        try { await r.init(); } catch (e) { console.warn('field init failed', file, e); return; }
        if (my !== this.token) { r.dispose(); return; }
        this.items.push(r); this.group.add(r.group);
      })());
    }
    await Promise.all(jobs);
  }
  async rebuildFor(doc) { if (this.items.some(i => i.doc === doc || i.zoneSec)) await this.build(this.app.sys); }
  frame(cam, dt) {
    for (const it of this.items) { it.group.visible = !(this.app.notShown && this.app.notShown(it.zoneSec.id)); if (it.group.visible) it.update(cam, dt); }
    // nebula fog when the camera is inside a nebula (optional — thick fog makes editing hard)
    const v = this.app.viewport; const neb = this.items.find(i => i instanceof NebulaRenderer && i.group.visible && i.inside && i.fogEnabled);
    if (neb && this.app.settings.nebulaFog) { if (!v.scene.fog || v.scene.fog.color.getHex() !== neb.fogColor.getHex()) v.scene.fog = new THREE.Fog(neb.fogColor, neb.fogNear, Math.max(neb.fogFar * 2, 500)); }
    else if (v.scene.fog) v.scene.fog = null;
  }
  stats() { return this.items.map(i => ({ file: i.file, kind: i instanceof NebulaRenderer ? 'nebula' : 'asteroids', cubes: i.cubeCount || 0, parts: i.parts ? i.parts.length : 0, billboards: i.bbMesh ? i.bbMesh.geometry.instanceCount : 0, band: !!i.band, inside: !!i.inside })); }
}
