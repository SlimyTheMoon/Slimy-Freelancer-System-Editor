// Freelancer model pipeline: .cmp / .3db / .sph  ->  THREE.Group
// Materials/textures follow FL's global lookup: anything loaded from any UTF's
// "Material library"/"Texture library" (model file itself, archetype material_library .mat/.txm)
// becomes visible to every model, keyed by the DACOM CRC of the name.
import * as THREE from 'three';
import { DDSLoader } from 'three/addons/DDSLoader.js';
import { textureSource } from './tga.js';
import { parseUtf, readCString } from './utf.js';
import { dacomCrc } from './crc.js';
import { parseAnimation } from './anim.js';

const dds = new DDSLoader();

export class ResourceManager {
  constructor(api) {
    this.api = api;
    this.utfCache = new Map();     // path -> Promise<UtfNode|null>
    this.libsLoaded = new Set();
    this.materials = new Map();    // crc -> def
    this.textures = new Map();     // lower name -> UtfNode (texture entry)
    this.texCache = new Map();     // lower name -> THREE.Texture
    this.vmesh = new Map();        // crc -> parsed VMeshData
    this.matCache = new Map();     // key -> THREE.Material
    this.modelCache = new Map();   // key -> Promise<Template>
    this.missing = new Set();
    this.anisotropy = 4;
    // memory: templates remember when they were last used and which files they came from, so trim()
    // can let go of models from systems opened a while ago (without this a session grew by ~100 MB per system)
    this.gen = 0; this.lastUse = new Map(); this.deps = new Map(); this.built = new Map(); this.prov = new Map();
  }

  async loadUtf(path) {
    const key = path.toLowerCase().replace(/\//g, '\\');
    if (!this.utfCache.has(key)) {
      this.utfCache.set(key, (async () => {
        try {
          const buf = await this.api.read(path);
          if (!buf) { this.missing.add(path); return null; }
          const root = parseUtf(buf);
          this.register(root, key);
          return root;
        } catch (e) { console.warn('UTF load failed', path, e); this.missing.add(path); return null; }
      })());
    }
    return this.utfCache.get(key);
  }

  register(root, fileKey = null) {
    const prov = fileKey ? (this.prov.get(fileKey) || this.prov.set(fileKey, { mat: [], tex: [], vm: [] }).get(fileKey)) : null;
    const ml = root.child('Material library');
    if (ml) for (const m of ml.children || []) if (!m.isLeaf) {
      const crc = dacomCrc(m.name);
      if (!this.materials.has(crc)) { this.materials.set(crc, parseMaterial(m)); prov && prov.mat.push(crc); }
    }
    const tl = root.child('Texture library');
    if (tl) for (const t of tl.children || []) if (!t.isLeaf) {
      const k = t.name.toLowerCase();
      if (!this.textures.has(k)) { this.textures.set(k, t); prov && prov.tex.push(k); }
    }
    const vl = root.child('VMeshLibrary');
    if (vl) for (const v of vl.children || []) {
      const d = v.child('VMeshData');
      if (d) { const crc = dacomCrc(v.name); if (!this.vmesh.has(crc)) { this.vmesh.set(crc, parseVMeshData(d.data)); prov && prov.vm.push(crc); } }
    }
  }

  async loadLibs(paths) {
    await Promise.all((paths || []).map(p => this.loadUtf(p)));
  }

  texture(name) {
    if (!name) return null;
    const k = name.toLowerCase();
    if (this.texCache.has(k)) return this.texCache.get(k);
    const node = this.textures.get(k);
    if (!node) return null;
    const tex = textureFromNode(node, this.anisotropy, name);
    if (tex) tex.userData.rmShared = true;
    this.texCache.set(k, tex);
    return tex;
  }

  material(crc, opts = {}) {
    const key = crc + (opts.unlit ? ':u' : '') + (opts.vcol ? ':v' : '');
    if (this.matCache.has(key)) return this.matCache.get(key);
    const def = this.materials.get(crc);
    const m = makeMaterial(this, def, opts);
    this.matCache.set(key, m);
    return m;
  }

  // Let go of models not used by the scenes in `roots` and not requested in the last `keep` generations
  // (a generation = one opened system). Only what those models created is disposed: their geometry, and
  // materials/textures no remaining model or visible object uses. Effect and sun textures are never touched.
  trim(roots = [], keep = 1) {
    const inUse = { geo: new Set(), mat: new Set(), tex: new Set() };
    const collect = (o, into) => o.traverse(x => {
      if (x.geometry) into.geo.add(x.geometry);
      for (const m of [].concat(x.material || [])) { into.mat.add(m); for (const k in m) if (m[k] && m[k].isTexture) into.tex.add(m[k]); }
    });
    for (const r of roots) if (r) collect(r, inUse);
    const evict = [], remain = [];
    for (const [key, tpl] of this.built) {
      if (key.startsWith('mem/')) { remain.push(tpl); continue; }
      let shown = false; tpl.traverse(x => { if (x.geometry && inUse.geo.has(x.geometry)) shown = true; });
      if (shown || (this.lastUse.get(key) ?? -1) >= this.gen - keep) remain.push(tpl); else evict.push(key);
    }
    if (!evict.length) return { evicted: 0 };
    const keepSet = { geo: new Set(inUse.geo), mat: new Set(inUse.mat), tex: new Set(inUse.tex) };
    for (const t of remain) if (t) collect(t, keepSet);
    const gone = { geo: new Set(), mat: new Set(), tex: new Set() };
    const files = new Set();
    for (const key of evict) {
      const tpl = this.built.get(key); if (tpl) collect(tpl, gone);
      for (const f of this.deps.get(key) || []) files.add(f);
      this.built.delete(key); this.modelCache.delete(key); this.lastUse.delete(key); this.deps.delete(key);
    }
    for (const g of gone.geo) if (!keepSet.geo.has(g)) g.dispose();
    for (const [k, m] of [...this.matCache]) if (gone.mat.has(m) && !keepSet.mat.has(m)) { m.dispose(); this.matCache.delete(k); }
    for (const [k, t] of [...this.texCache]) if (t && gone.tex.has(t) && !keepSet.tex.has(t)) { t.dispose(); this.texCache.delete(k); }
    // parsed files only the evicted models needed (a later request simply reads them again)
    const stillNeeded = new Set(); for (const d of this.deps.values()) for (const f of d) stillNeeded.add(f);
    let files0 = 0;
    for (const f of files) {
      if (stillNeeded.has(f) || !this.utfCache.has(f)) continue;
      this.utfCache.delete(f); files0++;
      const p = this.prov.get(f);
      if (p) { for (const c of p.mat) this.materials.delete(c); for (const k of p.tex) if (!this.texCache.has(k)) this.textures.delete(k); for (const c of p.vm) this.vmesh.delete(c); this.prov.delete(f); }
    }
    return { evicted: evict.length, files: files0 };
  }

  // drop cached copies of a file after it was rewritten (hardpoint editor)
  invalidate(path) {
    const key = path.toLowerCase().replace(/\//g, '\\');
    this.utfCache.delete(key);
    const mk = path.toLowerCase();
    for (const k of [...this.modelCache.keys()]) if (k.startsWith(mk + '|')) { this.modelCache.delete(k); this.built.delete(k); }
  }

  // -------- models ---------
  // DACOM.INI [MaterialMap]: type renames (DcDtEcEt = DcDtEt) and material-name regexes (^nomad.*$ = NomadMaterialNoBendy).
  // "evaluation of material map happens in reverse order listed" — the last matching line wins.
  async loadMaterialMap() {
    if (!this._mmap) this._mmap = (async () => {
      const rules = [];
      try {
        const b = await this.api.read('EXE/dacom.ini');
        if (b) {
          let inSec = false;
          for (const raw of new TextDecoder('latin1').decode(b).split(/\r?\n/)) {
            const line = raw.replace(/;.*$/, '').trim(); if (!line) continue;
            const sec = /^\[(.+)\]$/.exec(line); if (sec) { inSec = sec[1].toLowerCase() === 'materialmap'; continue; }
            if (!inSec) continue;
            const m = /^name\s*=\s*(.+?)\s*=\s*(\S+)$/i.exec(line);
            if (m) { try { rules.push({ re: new RegExp(m[1], 'i'), to: m[2] }); } catch { } continue; }
            const t = /^(\S+)\s*=\s*(\S+)$/.exec(line); if (t) rules.push({ type: t[1].toLowerCase(), to: t[2] });
          }
        }
      } catch { }
      this.materialMap = rules.reverse();
      return rules;
    })();
    return this._mmap;
  }
  resolveType(def) {
    if (!def) return 'DcDt';
    for (const r of this.materialMap || []) {
      if (r.re ? r.re.test(def.name) : r.type === String(def.type).toLowerCase()) return r.to;
    }
    return def.type;
  }

  async model(path, matLibs = [], opts = {}) {
    const key = path.toLowerCase() + '|' + (opts.unlit ? 'u' : '');
    this.lastUse.set(key, this.gen);
    if (!this.modelCache.has(key)) {
      const fk = (p) => p.toLowerCase().replace(/\//g, '\\');
      this.deps.set(key, [fk(path), ...(matLibs || []).map(fk)]);
      this.modelCache.set(key, (async () => {
        await this.loadMaterialMap();
        await this.loadLibs(matLibs);
        const root = await this.loadUtf(path);
        if (!root) return null;
        const tpl = buildModel(this, root, opts);
        if (tpl) tpl.traverse(x => { if (x.geometry) x.geometry.userData.rmShared = true; for (const m of [].concat(x.material || [])) m.userData.rmShared = true; }); // owned by this cache, not by the scene object
        this.built.set(key, tpl);
        return tpl;
      })());
    }
    const tpl = await this.modelCache.get(key);
    if (!tpl) return null;
    const inst = tpl.clone(true);
    inst.userData = { ...tpl.userData };
    return inst;
  }
}

// Uncompressed DDS in any bit layout (16-bit 565/1555/4444, 24-bit, 32-bit, 8-bit luminance/alpha) → RGBA8.
// THREE's DDSLoader only knows DXT and one 32-bit layout; mods (Discovery) ship the others.
export function rawDds(ab) {
  const dv = new DataView(ab); if (ab.byteLength < 128 || dv.getUint32(0, true) !== 0x20534444) return null;
  const h = dv.getUint32(12, true), w = dv.getUint32(16, true), pf = dv.getUint32(80, true);
  if (pf & 0x4) return null; // FOURCC (DXT…) → DDSLoader
  if (dv.getUint32(112, true) & 0x200) return { isCubemap: true };
  const bits = dv.getUint32(88, true), masks = [92, 96, 100, 104].map(o => dv.getUint32(o, true));
  const lum = pf & 0x20000, alphaOnly = (pf & 0x2) && !(pf & 0x40) && !lum, hasA = (pf & 0x1) || alphaOnly;
  const bpp = bits >> 3; if (!w || !h || ![1, 2, 3, 4].includes(bpp) || 128 + w * h * bpp > ab.byteLength) return null;
  const ch = masks.map(m => { if (!m) return null; let sh = 0; while (!((m >>> sh) & 1)) sh++; const max = m >>> sh; return { m, sh, max }; });
  const get = (v, c) => c ? Math.round(((v & c.m) >>> c.sh) * 255 / c.max) : 0;
  const out = new Uint8Array(w * h * 4); let p = 128;
  for (let i = 0; i < w * h; i++, p += bpp) {
    const v = bpp === 4 ? dv.getUint32(p, true) : bpp === 3 ? dv.getUint8(p) | dv.getUint8(p + 1) << 8 | dv.getUint8(p + 2) << 16 : bpp === 2 ? dv.getUint16(p, true) : dv.getUint8(p);
    let r, g, b, a;
    if (alphaOnly) { r = g = b = 255; a = get(v, ch[3] || { m: 0xff, sh: 0, max: 255 }); }
    else if (lum) { r = g = b = get(v, ch[0] || { m: 0xff, sh: 0, max: 255 }); a = hasA && ch[3] ? get(v, ch[3]) : 255; }
    else { r = get(v, ch[0]); g = get(v, ch[1]); b = get(v, ch[2]); a = hasA && ch[3] ? get(v, ch[3]) : 255; }
    const o = i * 4; out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
  }
  return { width: w, height: h, format: THREE.RGBAFormat, mipmaps: [{ data: out, width: w, height: h }], mipmapCount: 1, isCubemap: false };
}

// THREE texture from a UTF texture node (MIPS = DDS, MIP0… = TGA); also used by the UTF browser
export function textureFromNode(node, anisotropy = 4, name = '') {
    let tex = null;
    try {
      const src = textureSource(node);
      if (src && src.dds) {
        const ab = src.dds.slice().buffer;
        const raw = rawDds(ab);
        const d = raw || dds.parse(ab, true);
        if (d.isCubemap || !d.mipmaps || !d.mipmaps.length || !d.width) tex = null; // unsupported → untextured, never an empty texture (that breaks every frame)
        else if (d.format === THREE.RGBAFormat) {
          tex = new THREE.DataTexture(d.mipmaps[0].data, d.width, d.height, THREE.RGBAFormat);
          tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter;
        } else {
          // D3D treats DXT1 as having 1-bit alpha (used by OcOt cut-out materials)
          const fmt = d.format === THREE.RGB_S3TC_DXT1_Format ? THREE.RGBA_S3TC_DXT1_Format : d.format;
          tex = new THREE.CompressedTexture(d.mipmaps, d.width, d.height, fmt);
          tex.minFilter = d.mipmapCount === 1 ? THREE.LinearFilter : THREE.LinearMipmapLinearFilter;
        }
      } else if (src && src.rgba) { // TGA or FL palette image, rows already top-down
        const r = src.rgba;
        tex = new THREE.DataTexture(r.data, r.width, r.height, THREE.RGBAFormat);
        tex.flipY = false; tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter;
      }
    } catch (e) { console.warn('texture decode failed', name, e); }
    if (tex) {
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.magFilter = THREE.LinearFilter;
      tex.anisotropy = anisotropy;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
    }
    return tex;
}


// ---------------- materials ----------------
export function parseMaterial(node) {
  const get = (n) => node.child(n);
  const col = (n, d) => { const c = get(n); if (!c || c.data.byteLength < 12) return d; return [c.f32(0), c.f32(1), c.f32(2)]; };
  const num = (n, d) => { const c = get(n); return c ? c.f32(0) : d; };
  const str = (n) => { const c = get(n); return c ? c.str() : null; };
  return {
    name: node.name,
    type: str('Type') || 'DcDt',
    dc: col('Dc', [1, 1, 1]), ec: col('Ec', null), ac: col('Ac', null),
    oc: num('Oc', 1), alpha: num('Alpha', 1), fade: num('Fade', 1), scale: num('Scale', 1),
    dt: str('Dt_name'), et: str('Et_name'), dm: str('Dm_name') || str('Dm0_name') || str('Dm1_name') || str('Bt_name'),
    tileRate: num('TileRate', num('TileRate0', 4)),
    flipU: get('flip u') ? get('flip u').u32() : 0, flipV: get('flip v') ? get('flip v').u32() : 0,
  };
}

// Material families and their Direct3D 8 states, from the decompiled Shading.dll / flmaterials.dll bind tables
// (Shading/Material, flmaterials/MaterialImpl):
//   DcDt…      lit · stage0 tex×diffuse · opaque; Oc < 1 → alpha blend (SRCALPHA / INVSRCALPHA)
//   …OcOt      texture alpha: 1-bit (DXT1) → alpha test (ref 0x80), other alpha formats → alpha blend
//   DcDtEt     + stage1 ADD of the emissive texture          EcEt     lit · blend ONE / ONE (additive)
//   Nebula     unlit · blend SRCALPHA / ONE                     Atmosphere lit · alpha blend
//   Detail     stage1 MODULATE2X with the detail map (Dm/Bt), tile rate (default 4)
//   LightMap   unlit · blend DESTCOLOR / ZERO (multiply)        Glass*     lit · opaque, alpha raised to 0.8
//   Nomad      unlit · alpha blend · vertex colour               Exclusion  lit · alpha blend
//   NullMaterial is never drawn. Names ending in Two are two-sided.
function texHasAlpha(tex) {
  if (!tex) return 'none';
  const f = tex.format;
  if (f === THREE.RGBA_S3TC_DXT1_Format || f === THREE.RGB_S3TC_DXT1_Format) return '1bit';
  if (f === THREE.RGBA_S3TC_DXT3_Format || f === THREE.RGBA_S3TC_DXT5_Format || f === THREE.RGBAFormat) return 'full';
  return 'none';
}
function addDetailMap(m, detail, rate) {
  m.userData.detail = { map: detail, rate };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.flDetail = { value: detail }; sh.uniforms.flDetailRate = { value: rate };
    sh.fragmentShader = sh.fragmentShader.replace('#include <map_pars_fragment>', '#include <map_pars_fragment>\nuniform sampler2D flDetail; uniform float flDetailRate;')
      .replace('#include <map_fragment>', '#include <map_fragment>\n#ifdef USE_MAP\n diffuseColor.rgb *= texture2D(flDetail, vMapUv * flDetailRate).rgb * 2.0;\n#endif');
  };
  m.customProgramCacheKey = () => 'fl-detail';
}
function makeMaterial(rm, def, opts) {
  if (!def) {
    return new THREE.MeshLambertMaterial({ color: 0x9aa4b0, vertexColors: !!opts.vcol, side: THREE.FrontSide });
  }
  const t = rm.resolveType ? rm.resolveType(def) : def.type;
  const T = t.toLowerCase();
  const map = def.dt ? rm.texture(def.dt) : null;
  const emap = def.et ? rm.texture(def.et) : null;
  const color = new THREE.Color().setRGB(...def.dc.map(x => Math.min(x, 4)), THREE.SRGBColorSpace);
  const two = /two$/i.test(t) || /^nebula/i.test(t) && /two/i.test(t);
  let blend = 'opaque', lit = true, alphaTest = 0;
  if (T === 'nullmaterial') { const m = new THREE.MeshBasicMaterial({ visible: false }); m.name = def.name; m.userData.flType = t; return m; }
  if (/^nebula/.test(T)) { blend = 'additive-alpha'; lit = false; }
  else if (/^ecet/.test(T)) blend = 'add';
  else if (T === 'atmospherematerial' || T === 'exclusionzonematerial') blend = 'alpha';
  else if (T === 'lightmap') { blend = 'multiply'; lit = false; }
  else if (/^nomadmaterial/.test(T)) { blend = 'alpha'; lit = false; }
  else if (/glassmaterial$/.test(T)) blend = 'opaque';
  else if (def.oc < 1) blend = 'alpha';
  else if (/ocot/.test(T)) { const a = texHasAlpha(map); if (a === '1bit') alphaTest = 0.5; else if (a === 'full') blend = 'alpha'; }
  if (opts.unlit) { lit = false; }
  const transparent = blend !== 'opaque';
  const common = {
    color, map, transparent, side: two || opts.unlit ? THREE.DoubleSide : THREE.FrontSide,
    opacity: /glassmaterial$/.test(T) ? 1 : Math.min(1, def.oc), vertexColors: !!opts.vcol || /^nomad/.test(T),
    depthWrite: !transparent && !opts.unlit, alphaTest,
  };
  if (blend === 'add' || blend === 'additive-alpha') common.blending = THREE.AdditiveBlending;
  else if (blend === 'multiply') Object.assign(common, { blending: THREE.CustomBlending, blendSrc: THREE.DstColorFactor, blendDst: THREE.ZeroFactor });
  let m;
  if (!lit) m = new THREE.MeshBasicMaterial({ ...common, fog: false });
  else {
    m = new THREE.MeshLambertMaterial({ ...common });
    if (def.ec) m.emissive = new THREE.Color().setRGB(...def.ec, THREE.SRGBColorSpace);
    if (emap) { m.emissiveMap = emap; if (!def.ec) m.emissive = new THREE.Color(1, 1, 1); }
    // D3D fixed function: Ec is part of the lighting term, which the texture then modulates
    // (tex × (Dc·light + Ec)); three adds emissive after the texture, so give it the diffuse map too
    else if (def.ec && map) m.emissiveMap = map;
    if (/detail/.test(T) && def.dm && map) { const d = rm.texture(def.dm); if (d) { d.wrapS = d.wrapT = THREE.RepeatWrapping; addDetailMap(m, d, def.tileRate || 4); } }
  }
  m.name = def.name;
  m.userData.flType = t;
  if (t !== def.type) m.userData.flTypeFile = def.type;
  return m;
}

// ---------------- VMeshData ----------------
export function parseVMeshData(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const meshCount = dv.getUint16(8, true);
  const indexCount = dv.getUint16(10, true);
  const fvf = dv.getUint16(12, true);
  const vertCount = dv.getUint16(14, true);
  const meshes = [];
  let p = 16;
  for (let i = 0; i < meshCount; i++) {
    meshes.push({ material: dv.getUint32(p, true), startVertex: dv.getUint16(p + 4, true), endVertex: dv.getUint16(p + 6, true), numIndices: dv.getUint16(p + 8, true) });
    p += 12;
  }
  const indices = new Uint16Array(indexCount);
  for (let i = 0; i < indexCount; i++) indices[i] = dv.getUint16(p + i * 2, true);
  p += indexCount * 2;
  const hasPos = fvf & 0x2, hasNormal = fvf & 0x10, hasDiffuse = fvf & 0x40, hasSpec = fvf & 0x80;
  const texCount = (fvf >> 8) & 0xF;
  const stride = (hasPos ? 12 : 0) + (hasNormal ? 12 : 0) + (hasDiffuse ? 4 : 0) + (hasSpec ? 4 : 0) + texCount * 8;
  // some FL meshes (0x412 etc.) carry extra tangent data per tex set — derive stride from remaining bytes
  const realStride = vertCount ? Math.floor((u8.byteLength - p) / vertCount) : stride;
  const st = realStride >= stride ? realStride : stride;
  const pos = new Float32Array(vertCount * 3);
  const nrm = hasNormal ? new Float32Array(vertCount * 3) : null;
  const col = hasDiffuse ? new Float32Array(vertCount * 4) : null;
  const uv = texCount ? new Float32Array(vertCount * 2) : null;
  for (let v = 0; v < vertCount; v++) {
    let o = p + v * st;
    pos[v * 3] = dv.getFloat32(o, true); pos[v * 3 + 1] = dv.getFloat32(o + 4, true); pos[v * 3 + 2] = dv.getFloat32(o + 8, true); o += 12;
    if (hasNormal) { nrm[v * 3] = dv.getFloat32(o, true); nrm[v * 3 + 1] = dv.getFloat32(o + 4, true); nrm[v * 3 + 2] = dv.getFloat32(o + 8, true); o += 12; }
    if (hasDiffuse) { // D3DCOLOR = BGRA bytes
      col[v * 4 + 2] = u8[o] / 255; col[v * 4 + 1] = u8[o + 1] / 255; col[v * 4] = u8[o + 2] / 255; col[v * 4 + 3] = u8[o + 3] / 255; o += 4;
    }
    if (hasSpec) o += 4;
    if (texCount) { uv[v * 2] = dv.getFloat32(o, true); uv[v * 2 + 1] = dv.getFloat32(o + 4, true); }
  }
  return { meshes, indices, pos, nrm, col, uv, fvf, vertCount };
}

function parseVMeshRef(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  return {
    lib: dv.getUint32(4, true), startVertex: dv.getUint16(8, true), numVertices: dv.getUint16(10, true),
    startIndex: dv.getUint16(12, true), numIndices: dv.getUint16(14, true), startMesh: dv.getUint16(16, true), numMeshes: dv.getUint16(18, true),
    radius: u8.byteLength >= 60 ? dv.getFloat32(56, true) : 0,
  };
}

function buildRef(rm, refNode, opts) {
  const ref = parseVMeshRef(refNode.data);
  const vd = rm.vmesh.get(ref.lib);
  const group = new THREE.Group();
  if (!vd) return group;
  let idx = ref.startIndex;
  for (let mi = ref.startMesh; mi < ref.startMesh + ref.numMeshes && mi < vd.meshes.length; mi++) {
    const m = vd.meshes[mi];
    const base = ref.startVertex + m.startVertex;
    const count = m.endVertex - m.startVertex + 1;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(vd.pos.slice(base * 3, (base + count) * 3), 3));
    if (vd.nrm) g.setAttribute('normal', new THREE.BufferAttribute(vd.nrm.slice(base * 3, (base + count) * 3), 3));
    if (vd.uv) g.setAttribute('uv', new THREE.BufferAttribute(vd.uv.slice(base * 2, (base + count) * 2), 2));
    if (vd.col) g.setAttribute('color', new THREE.BufferAttribute(vd.col.slice(base * 4, (base + count) * 4), 4));
    // FL meshes are counter-clockwise when viewed from outside in FL's (right-handed, Y-up) world,
    // which matches GL's default front face — use the index order as stored.
    const ind = vd.indices.slice(idx, idx + m.numIndices);
    g.setIndex(new THREE.BufferAttribute(ind, 1));
    idx += m.numIndices;
    if (!vd.nrm && !opts.unlit) g.computeVertexNormals();
    g.computeBoundingSphere();
    const mat = rm.material(m.material, { unlit: opts.unlit, vcol: !!vd.col && opts.unlit });
    const mesh = new THREE.Mesh(g, mat);
    if (mat.transparent) mesh.renderOrder = 1;
    group.add(mesh);
  }
  return group;
}

function findRef(node) {
  return node.path('MultiLevel/Level0/VMeshPart/VMeshRef') || node.path('VMeshPart/VMeshRef');
}

function readHardpoints(node, into, matrixWorld = null) {
  const hp = node.child('Hardpoints');
  if (!hp) return;
  for (const kind of hp.children) for (const h of kind.children || []) {
    const pos = h.child('Position'), ori = h.child('Orientation');
    if (!pos) continue;
    const p = new THREE.Vector3(pos.f32(0), pos.f32(1), pos.f32(2));
    into.push({ name: h.name, pos: p, rot: ori ? ori.floats() : null, revolute: /revolute/i.test(kind.name), part: node.name });
  }
}

// FL stores 3x3 rotations column by column (d0→M11, d1→M21, d2→M31
// in System.Numerics' row-vector convention). In THREE's column-vector convention that is the transpose,
// so the stored triples become THREE's rows.
export function rotFromFl(r) {
  return new THREE.Matrix4().set(r[0], r[1], r[2], 0, r[3], r[4], r[5], 0, r[6], r[7], r[8], 0, 0, 0, 0, 1);
}
// Rest-pose local transform per construct type:
//   fix / loose : R, then +Origin
//   rev / sphere: -Offset, then R, then +Origin
//   pris        : R, then +(Origin + Offset)
function matFromCons(kind, origin, offset, r) {
  const m = rotFromFl(r);
  if (kind === 'rev' || kind === 'sphere') {
    m.multiply(new THREE.Matrix4().makeTranslation(-offset[0], -offset[1], -offset[2]));
    m.premultiply(new THREE.Matrix4().makeTranslation(origin[0], origin[1], origin[2]));
  } else if (kind === 'pris') {
    m.premultiply(new THREE.Matrix4().makeTranslation(origin[0] + offset[0], origin[1] + offset[1], origin[2] + offset[2]));
  } else {
    m.premultiply(new THREE.Matrix4().makeTranslation(origin[0], origin[1], origin[2]));
  }
  return m;
}

function parseCons(cons) {
  const out = [];
  if (!cons) return out;
  for (const c of cons.children || []) { // some mod models have Cons as an empty leaf
    if (!c.isLeaf) continue;
    const n = c.name.toLowerCase();
    const stride = n === 'fix' || n === 'loose' ? 176 : n === 'sphere' ? 212 : 208;
    const u8 = c.data; const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    for (let o = 0; o + stride <= u8.byteLength; o += stride) {
      const parent = readCString(u8, o, 64), child = readCString(u8, o + 64, 64);
      const f = (i) => dv.getFloat32(o + 128 + i * 4, true);
      const origin = [f(0), f(1), f(2)];
      let rot, offset = [0, 0, 0], axis = null, min = 0, max = 0;
      if (stride === 176) rot = [f(3), f(4), f(5), f(6), f(7), f(8), f(9), f(10), f(11)];
      else {
        offset = [f(3), f(4), f(5)]; rot = [f(6), f(7), f(8), f(9), f(10), f(11), f(12), f(13), f(14)];
        if (n === 'sphere') { min = [f(15), f(17), f(19)]; max = [f(16), f(18), f(20)]; }
        else { axis = [f(15), f(16), f(17)]; min = f(18); max = f(19); }
      }
      out.push({ parent, child, matrix: matFromCons(n, origin, offset, rot), kind: n, origin, offset, rot, axis, min, max });
    }
  }
  return out;
}

function buildModel(rm, root, opts) {
  const group = new THREE.Group();
  const hardpoints = [];
  const cmpnd = root.child('Cmpnd');
  const sphere = root.child('Sphere');
  if (cmpnd) {
    const parts = new Map(); // object name -> file node
    for (const p of cmpnd.children || []) {
      if (p.isLeaf || p.name.toLowerCase() === 'cons') continue;
      const on = p.child('Object name'), fn = p.child('File name');
      if (!on || !fn) continue;
      const fnode = root.child(fn.str());
      if (fnode) parts.set(on.str().toLowerCase(), fnode);
    }
    const cons = parseCons(cmpnd.child('Cons'));
    const objs = new Map();
    for (const [name, fnode] of parts) {
      const o = new THREE.Group(); o.name = name;
      const ref = findRef(fnode);
      if (ref) o.add(buildRef(rm, ref, opts));
      readHardpoints(fnode, hardpoints);
      objs.set(name, o);
    }
    const attached = new Set();
    for (const c of cons) {
      const p = objs.get(c.parent.toLowerCase()), ch = objs.get(c.child.toLowerCase());
      if (!p || !ch) continue;
      ch.matrixAutoUpdate = false; ch.matrix.copy(c.matrix);
      ch.userData.cons = { kind: c.kind, origin: c.origin, offset: c.offset, rot: c.rot, axis: c.axis, min: c.min, max: c.max, rest: c.matrix.toArray() };
      p.add(ch); attached.add(c.child.toLowerCase());
    }
    for (const [name, o] of objs) if (!attached.has(name)) group.add(o);
    // hardpoints: transform into model space
    for (const h of hardpoints) {
      const part = [...parts.entries()].find(([, f]) => f.name === h.part);
      const o = part && objs.get(part[0]);
      if (o) { o.updateWorldMatrix(true, false); h.localPos = h.pos.clone(); h.partName = o.name; h.pos.applyMatrix4(o.matrixWorld); h.partMatrix = o.matrixWorld.clone(); }
    }
  } else if (sphere) {
    buildSphere(rm, sphere, group, opts);
  } else {
    const ref = findRef(root);
    if (ref) group.add(buildRef(rm, ref, opts));
    readHardpoints(root, hardpoints);
  }
  group.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(group);
  const s = new THREE.Sphere(); box.getBoundingSphere(s);
  let animations = [];
  try { animations = parseAnimation(root.child('Animation')); } catch (e) { console.warn('animation', e); }
  group.userData = { radius: isFinite(s.radius) ? s.radius : 0, center: s.center, hardpoints, isSphere: !!sphere, sphereRadius: group.userData.sphereRadius, animations };
  return group;
}

// Cube-mapped planet sphere: M0..M3 equator faces, M4 top, M5 bottom, M6 atmosphere (if Sides==7)
const FACES = [
  { n: [0, 0, 1], r: [1, 0, 0], u: [0, 1, 0] },
  { n: [1, 0, 0], r: [0, 0, -1], u: [0, 1, 0] },
  { n: [0, 0, -1], r: [-1, 0, 0], u: [0, 1, 0] },
  { n: [-1, 0, 0], r: [0, 0, 1], u: [0, 1, 0] },
  { n: [0, 1, 0], r: [1, 0, 0], u: [0, 0, -1] },
  { n: [0, -1, 0], r: [1, 0, 0], u: [0, 0, 1] },
];
function faceGeometry(f, radius, seg = 24) {
  const pos = [], nrm = [], uv = [], idx = [];
  for (let j = 0; j <= seg; j++) for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * 2 - 1, b = 1 - (j / seg) * 2;
    const v = new THREE.Vector3(f.n[0] + a * f.r[0] + b * f.u[0], f.n[1] + a * f.r[1] + b * f.u[1], f.n[2] + a * f.r[2] + b * f.u[2]).normalize();
    nrm.push(v.x, v.y, v.z); pos.push(v.x * radius, v.y * radius, v.z * radius); uv.push(i / seg, j / seg);
  }
  for (let j = 0; j < seg; j++) for (let i = 0; i < seg; i++) {
    const a = j * (seg + 1) + i, b = a + 1, c = a + seg + 1, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

function buildSphere(rm, sphere, group, opts) {
  const radiusNode = sphere.child('Radius');
  const radius = radiusNode ? radiusNode.f32() : 1000;
  const sides = sphere.child('Sides') ? sphere.child('Sides').u32() : 6;
  const name = (i) => { const n = sphere.child('M' + i); return n ? n.str() : null; };
  group.userData.sphereRadius = radius;
  if (sides >= 6) {
    for (let i = 0; i < 6; i++) {
      const mname = name(i);
      const mat = mname ? rm.material(dacomCrc(mname), {}) : new THREE.MeshLambertMaterial({ color: 0x777777 });
      const def = mname && rm.materials.get(dacomCrc(mname));
      let m = mat;
      if (def && (def.flipU || def.flipV) && mat.map) {
        m = mat.clone(); m.map = mat.map.clone(); m.map.repeat.set(def.flipU ? -1 : 1, def.flipV ? -1 : 1); m.map.needsUpdate = true;
      }
      const mesh = new THREE.Mesh(faceGeometry(FACES[i], radius), m);
      mesh.userData.planetFace = true;
      group.add(mesh);
    }
    const atm = sides >= 7 && name(6);
    const def = atm && rm.materials.get(dacomCrc(atm));
    if (def) group.add(atmosphereMesh(radius * (def.scale || 1.02), def));
  } else {
    group.userData.sunLike = true;
  }
}

function atmosphereMesh(radius, def) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color().setRGB(...def.dc.map(x => Math.min(1, x))) }, alpha: { value: def.alpha }, fade: { value: def.fade } },
    vertexShader: `varying vec3 vN; varying vec3 vV;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main(){ vec4 mv = modelViewMatrix*vec4(position,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv;
      #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `uniform vec3 color; uniform float alpha; uniform float fade; varying vec3 vN; varying vec3 vV;
      #include <logdepthbuf_pars_fragment>
      void main(){
      #include <logdepthbuf_fragment>
      float f = 1.0 - abs(dot(vN, vV)); gl_FragColor = vec4(color, clamp(pow(f, 2.0*fade) * (alpha+0.4), 0.0, 1.0)); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const m = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 32), mat);
  m.renderOrder = 2;
  m.userData.atmosphere = true;
  return m;
}
