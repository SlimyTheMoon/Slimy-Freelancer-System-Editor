// Freelancer model writer: abstract model → .3db / .cmp (UTF) and .sur (collision).
// Layout as the game's own model files (geometry, parts,
// hardpoints, materials, surfaces), which gives files
// vanilla Freelancer loads. Hashes use the DACOM CRC from the decompilation (crc.js).
//
// model = {
//   name, parts: [{ name, parent (null = root), kind: 'fix'|'rev'|'pris', matrix: THREE.Matrix4 (local, parent space),
//                   axis?, min?, max?, offset?,
//                   lods: [ { groups: [{ material, pos: Float32Array, nrm, uv, col?, idx: Uint16Array }] } ],
//                   hardpoints: [{ name, matrix: THREE.Matrix4 (part space), rev: {axis:[x,y,z], min, max} | null }],
//                   hulls: [ Float32Array points (part space) ] }],
//   materials: Map(name → { dc:[r,g,b], dt: textureName|null, et: textureName|null, ec:[r,g,b]|null, oc: 1, two: false }),
//   textures:  Map(name → Uint8Array DDS) }
import * as THREE from 'three';
import { ConvexHull } from 'three/addons/ConvexHull.js';
import { UtfNode, writeUtf } from './utf.js';
import { dacomCrc } from './crc.js';

const f32 = (arr) => new Uint8Array(new Float32Array(arr).buffer);
const u32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); return b; };
const i32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v, true); return b; };
const cstr = (s) => { const b = new Uint8Array(s.length + 1); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255; return b; };
const leaf = (name, data) => new UtfNode(name, data);
const dir = (name, children = []) => { const n = new UtfNode(name); n.children = children; return n; };

// THREE rotation → FL 3×3 (the inverse of model.js rotFromFl: stored triples are THREE's rows)
export function flRot(m) { const e = m.elements; return [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]]; }

// ---------------- geometry ----------------
const FVF_XYZ = 0x2, FVF_NORMAL = 0x10, FVF_DIFFUSE = 0x40, FVF_TEX1 = 0x100;
export function lodFvf(lod) {
  let f = FVF_XYZ;
  if (lod.groups.every(g => g.nrm)) f |= FVF_NORMAL;
  if (lod.groups.some(g => g.col)) f |= FVF_DIFFUSE;
  if (lod.groups.every(g => g.uv)) f |= FVF_TEX1;
  return f;
}
function lodStats(lod) {
  let nv = 0, ni = 0; const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const g of lod.groups) {
    nv += g.pos.length / 3; ni += g.idx.length;
    for (let i = 0; i < g.pos.length; i += 3) for (let k = 0; k < 3; k++) { const v = g.pos[i + k]; if (v < min[k]) min[k] = v; if (v > max[k]) max[k] = v; }
  }
  if (!isFinite(min[0])) { min.fill(0); max.fill(0); }
  const c = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  let r = 0;
  for (const g of lod.groups) for (let i = 0; i < g.pos.length; i += 3) r = Math.max(r, Math.hypot(g.pos[i] - c[0], g.pos[i + 1] - c[1], g.pos[i + 2] - c[2]));
  return { nv, ni, min, max, c, r };
}
export function vmeshData(lod) {
  const fvf = lodFvf(lod), st = lodStats(lod);
  if (st.nv > 65535) throw new Error(`a mesh has ${st.nv} vertices; Freelancer allows 65535 per part — split it into parts or reduce it`);
  if (st.ni > 65535) throw new Error(`a mesh has ${st.ni} indices; Freelancer allows 65535 per part`);
  const stride = 12 + (fvf & FVF_NORMAL ? 12 : 0) + (fvf & FVF_DIFFUSE ? 4 : 0) + (fvf & FVF_TEX1 ? 8 : 0);
  const size = 16 + lod.groups.length * 12 + st.ni * 2 + st.nv * stride;
  const out = new Uint8Array(size), dv = new DataView(out.buffer);
  dv.setUint32(0, 1, true); dv.setUint32(4, 4, true);
  dv.setUint16(8, lod.groups.length, true); dv.setUint16(10, st.ni, true); dv.setUint16(12, fvf, true); dv.setUint16(14, st.nv, true);
  let p = 16, base = 0;
  for (const g of lod.groups) {
    let mx = 0; for (const i of g.idx) if (i > mx) mx = i;
    dv.setUint32(p, g.material ? dacomCrc(g.material) : 0, true);
    dv.setUint16(p + 4, base, true); dv.setUint16(p + 6, base + mx, true); dv.setUint16(p + 8, g.idx.length, true); dv.setUint16(p + 10, 0xCC, true);
    p += 12; base += g.pos.length / 3;
  }
  for (const g of lod.groups) for (const i of g.idx) { dv.setUint16(p, i, true); p += 2; }
  for (const g of lod.groups) {
    const n = g.pos.length / 3;
    for (let v = 0; v < n; v++) {
      dv.setFloat32(p, g.pos[v * 3], true); dv.setFloat32(p + 4, g.pos[v * 3 + 1], true); dv.setFloat32(p + 8, g.pos[v * 3 + 2], true); p += 12;
      if (fvf & FVF_NORMAL) { dv.setFloat32(p, g.nrm[v * 3], true); dv.setFloat32(p + 4, g.nrm[v * 3 + 1], true); dv.setFloat32(p + 8, g.nrm[v * 3 + 2], true); p += 12; }
      if (fvf & FVF_DIFFUSE) { // D3DCOLOR (BGRA)
        const c = g.col ? [g.col[v * 4], g.col[v * 4 + 1], g.col[v * 4 + 2], g.col[v * 4 + 3]] : [1, 1, 1, 1];
        out[p] = c[2] * 255; out[p + 1] = c[1] * 255; out[p + 2] = c[0] * 255; out[p + 3] = c[3] * 255; p += 4;
      }
      if (fvf & FVF_TEX1) { dv.setFloat32(p, g.uv[v * 2], true); dv.setFloat32(p + 4, g.uv[v * 2 + 1], true); p += 8; }
    }
  }
  return out;
}
function vmeshRef(lod, vmsName) {
  const st = lodStats(lod);
  const b = new Uint8Array(60), dv = new DataView(b.buffer);
  dv.setUint32(0, 60, true); dv.setUint32(4, dacomCrc(vmsName), true);
  dv.setUint16(8, 0, true); dv.setUint16(10, st.nv, true); dv.setUint16(12, 0, true); dv.setUint16(14, st.ni, true);
  dv.setUint16(16, 0, true); dv.setUint16(18, lod.groups.length, true);
  [st.max[0], st.min[0], st.max[1], st.min[1], st.max[2], st.min[2], st.c[0], st.c[1], st.c[2], st.r].forEach((v, i) => dv.setFloat32(20 + i * 4, v, true));
  return b;
}

function hardpointsNode(hps) {
  const fixed = hps.filter(h => !h.rev), rev = hps.filter(h => h.rev);
  const node = (h) => {
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3(); h.matrix.decompose(p, q, s);
    const r = new THREE.Matrix4().makeRotationFromQuaternion(q);
    const kids = [leaf('Orientation', f32(flRot(r))), leaf('Position', f32([p.x, p.y, p.z]))];
    if (h.rev) kids.push(leaf('Axis', f32(h.rev.axis)), leaf('Max', f32([h.rev.max * Math.PI / 180])), leaf('Min', f32([h.rev.min * Math.PI / 180])));
    return dir(h.name, kids);
  };
  const kids = [];
  if (fixed.length) kids.push(dir('Fixed', fixed.map(node)));
  if (rev.length) kids.push(dir('Revolute', rev.map(node)));
  return dir('Hardpoints', kids);
}

// mesh-part node contents (3db body): MultiLevel or VMeshPart + Hardpoints
function partBody(model, part, vmsLib) {
  const kids = [];
  const names = part.lods.map((lod, i) => `${model.name}-${part.name}.lod${i}.${lodFvf(lod)}.vms`);
  part.lods.forEach((lod, i) => vmsLib.children.push(dir(names[i], [leaf('VMeshData', vmeshData(lod))])));
  if (part.lods.length > 1) {
    const sw = [0]; let cut = part.switchDistances?.[1] || 2250;
    for (let i = 1; i < part.lods.length; i++) { sw.push(part.switchDistances?.[i] ?? cut); cut *= 2; }
    sw.push(1000000);
    // Switch2 has one entry per level boundary (levels + 1)
    kids.push(dir('MultiLevel', [
      ...part.lods.map((lod, i) => dir('Level' + i, [dir('VMeshPart', [leaf('VMeshRef', vmeshRef(lod, names[i]))])])),
      leaf('Switch2', f32(sw)),
    ]));
  } else if (part.lods.length === 1) {
    kids.push(dir('VMeshPart', [leaf('VMeshRef', vmeshRef(part.lods[0], names[0]))]));
  } else {
    const b = new Uint8Array(60); new DataView(b.buffer).setUint32(0, 60, true);
    kids.push(dir('VMeshPart', [leaf('VMeshRef', b)]));
  }
  if (part.hardpoints?.length) kids.push(hardpointsNode(part.hardpoints));
  return kids;
}

function libraries(model) {
  const out = [];
  if (model.materials?.size) {
    const mats = [...model.materials.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([name, m]) => {
      const kids = [leaf('Type', cstr(materialType(m)))];
      kids.push(leaf('Dc', f32(m.dc || [1, 1, 1])));
      if (m.ec && !m.et) kids.push(leaf('Ec', f32(m.ec)));
      if (m.oc != null && m.oc < 1) kids.push(leaf('Oc', f32([m.oc])));
      if (m.dt) { kids.push(leaf('Dt_name', cstr(m.dt))); kids.push(leaf('Dt_flags', i32(64))); }
      if (m.et) { kids.push(leaf('Et_name', cstr(m.et))); kids.push(leaf('Et_flags', i32(64))); }
      return dir(name, kids);
    });
    out.push(dir('Material library', mats));
  }
  if (model.textures?.size) {
    out.push(dir('Texture library', [...model.textures.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([name, bytes]) => dir(name, [leaf('MIPS', bytes)]))));
  }
  return out;
}
export function materialType(m) {
  const alpha = (m.oc != null && m.oc < 1) || m.alphaTex;
  let t = m.et ? 'DcDtEcEt' : m.ec ? 'DcDtEc' : alpha ? 'DcDtOcOt' : 'DcDt';
  if (m.two && t !== 'DcDtEcEt') t += 'Two';
  return t;
}

// Fix / Rev / Pris construct records (176 / 208 / 208 bytes)
function consRecord(p) {
  const kind = p.kind || 'fix';
  const size = kind === 'fix' ? 176 : 208;
  const b = new Uint8Array(size), dv = new DataView(b.buffer);
  const put = (s, o) => { for (let i = 0; i < Math.min(63, s.length); i++) b[o + i] = s.charCodeAt(i); };
  put(p.parent, 0); put(p.name, 64);
  const pos = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3(); p.matrix.decompose(pos, q, sc);
  const r = flRot(new THREE.Matrix4().makeRotationFromQuaternion(q));
  let o = 128;
  const w = (v) => { dv.setFloat32(o, v, true); o += 4; };
  w(pos.x); w(pos.y); w(pos.z);
  if (kind !== 'fix') { const off = p.offset || [0, 0, 0]; w(off[0]); w(off[1]); w(off[2]); }
  r.forEach(w);
  if (kind !== 'fix') { const ax = p.axis || [0, 1, 0]; w(ax[0]); w(ax[1]); w(ax[2]); w(p.min ?? (kind === 'rev' ? -Math.PI / 2 : 0)); w(p.max ?? (kind === 'rev' ? Math.PI / 2 : 1)); }
  return b;
}

export function buildModelUtf(model) {
  const root = dir('\\');
  root.children.push(leaf('Exporter Version', cstr('FL System Editor model import')));
  const parts = model.parts;
  const rootPart = parts.find(p => !p.parent);
  if (!rootPart) throw new Error('model has no root part');
  if (parts.length === 1) {
    const vms = dir('VMeshLibrary');
    const body = partBody(model, rootPart, vms);
    root.children.push(vms, ...body);
  } else {
    const salt = Math.random().toString(16).slice(2, 10);
    const file = (p) => `${p.name}.${salt}.3db`;
    const vms = dir('VMeshLibrary');
    root.children.push(vms);
    const cmpnd = dir('Cmpnd');
    let index = 0;
    const ordered = [rootPart]; (function walk(par) { for (const c of parts.filter(x => x.parent === par.name)) { ordered.push(c); walk(c); } })(rootPart);
    for (const p of ordered) {
      cmpnd.children.push(dir(p === rootPart ? 'Root' : 'PART_' + p.name, [leaf('File name', cstr(file(p))), leaf('Object name', cstr(p === rootPart ? 'Root' : p.name)), leaf('Index', i32(index++))]));
      root.children.push(dir(file(p), partBody(model, p, vms)));
    }
    const groups = { fix: [], rev: [], pris: [] };
    for (const p of ordered.slice(1)) groups[p.kind || 'fix'].push(consRecord({ ...p, parent: p.parent === rootPart.name ? 'Root' : p.parent }));
    const cons = dir('Cons');
    for (const [k, recs] of Object.entries(groups)) if (recs.length) {
      const all = new Uint8Array(recs.reduce((s, r) => s + r.length, 0)); let o = 0; for (const r of recs) { all.set(r, o); o += r.length; }
      cons.children.push(leaf(k[0].toUpperCase() + k.slice(1), all));
    }
    if (cons.children.length) cmpnd.children.push(cons);
    root.children.push(cmpnd);
  }
  root.children.push(...libraries(model));
  return writeUtf(root);
}

// ---------------- collision (.sur) ----------------
// Convex hull of points → { verts: Vector3[], tris: [[a,b,c]] } with outward CCW faces
export function convexHull(points) {
  const pts = []; for (let i = 0; i < points.length; i += 3) pts.push(new THREE.Vector3(points[i], points[i + 1], points[i + 2]));
  if (pts.length < 4) return null;
  const hull = new ConvexHull().setFromPoints(pts);
  const verts = [], map = new Map(), tris = [];
  const vid = (v) => { const k = v.x + ',' + v.y + ',' + v.z; if (!map.has(k)) { map.set(k, verts.length); verts.push(v.clone()); } return map.get(k); };
  for (const f of hull.faces) {
    const loop = []; let e = f.edge; do { loop.push(vid(e.head().point)); e = e.next; } while (e !== f.edge);
    for (let i = 1; i + 1 < loop.length; i++) tris.push([loop[0], loop[i], loop[i + 1]]);
  }
  if (tris.length < 4) return null;
  // enforce outward orientation
  const c = new THREE.Vector3(); verts.forEach(v => c.add(v)); c.divideScalar(verts.length);
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3();
  for (const t of tris) { ab.subVectors(verts[t[1]], verts[t[0]]); ac.subVectors(verts[t[2]], verts[t[0]]); n.crossVectors(ab, ac); if (n.dot(new THREE.Vector3().subVectors(verts[t[0]], c)) < 0) [t[1], t[2]] = [t[2], t[1]]; }
  return { verts, tris };
}

// Simplify point cloud for hull generation (FL hulls should stay below ~300 triangles)
export function simplifyHullPoints(points, maxTris = 280) {
  let h = convexHull(points); if (!h) return null;
  let grid = 0;
  const box = new THREE.Box3(); for (const v of h.verts) box.expandByPoint(v);
  const size = box.getSize(new THREE.Vector3()).length() || 1;
  while (h.tris.length > maxTris && grid < 40) {
    grid++;
    const cell = size / (64 - grid * 1.5);
    const seen = new Map();
    for (const v of h.verts) { const k = Math.round(v.x / cell) + ',' + Math.round(v.y / cell) + ',' + Math.round(v.z / cell); if (!seen.has(k)) seen.set(k, v); }
    const arr = []; for (const v of seen.values()) arr.push(v.x, v.y, v.z);
    const h2 = convexHull(arr); if (!h2) break; h = h2;
  }
  return h;
}

class SurNode {
  constructor() { this.center = new THREE.Vector3(); this.radius = 0; this.scale = new THREE.Vector3(1, 1, 1); this.hull = null; this.left = null; this.right = null; }
  setBoundary(min, max) {
    this.center.addVectors(min, max).multiplyScalar(0.5);
    this.radius = 0.5 * min.distanceTo(max);
    this.scale = this.radius > 0 ? new THREE.Vector3().subVectors(max, min).multiplyScalar(0.5 / this.radius) : new THREE.Vector3(1, 1, 1);
  }
  boundary() { const e = this.scale.clone().multiplyScalar(this.radius); return [this.center.clone().sub(e), this.center.clone().add(e)]; }
  static group(a, b) { const [mia, maa] = a.boundary(), [mib, mab] = b.boundary(); const n = new SurNode(); n.left = a; n.right = b; n.setBoundary(mia.min(mib), maa.max(mab)); return n; }
}

function rayTri(o, d, a, b, c) {
  const ab = new THREE.Vector3().subVectors(b, a), ac = new THREE.Vector3().subVectors(c, a);
  const normal = new THREE.Vector3().crossVectors(ac, ab);
  const dn = -d.dot(normal);
  const ao = new THREE.Vector3().subVectors(o, a);
  const t = ao.dot(normal);
  if (t < 0) return false;
  const aoxd = new THREE.Vector3().crossVectors(ao, d);
  const v = -ac.dot(aoxd); if (v < 0 || v > dn) return false;
  const w = ab.dot(aoxd); if (w < 0 || v + w > dn) return false;
  return true;
}

function toSurfaceHull(h, crc, type, pointIndex) {
  const edges = [];
  for (const t of h.tris) edges.push([t[0], t[1]], [t[1], t[2]], [t[2], t[0]]);
  const ekey = new Map(); edges.forEach((e, i) => ekey.set(e[0] + ',' + e[1], i));
  const reversed = edges.map(e => ekey.has(e[1] + ',' + e[0]) ? ekey.get(e[1] + ',' + e[0]) : -1);
  const faces = [];
  let ec = 0;
  h.tris.forEach((t, i) => {
    const a = h.verts[t[0]], b = h.verts[t[1]], c = h.verts[t[2]];
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
    const center = new THREE.Vector3().add(a).add(b).add(c).divideScalar(3);
    const o = center.clone().addScaledVector(n, -1e-6), d = n.clone().negate();
    let hit = -1;
    for (let j = 0; j < h.tris.length; j++) { const q = h.tris[j]; if (rayTri(o, d, h.verts[q[0]], h.verts[q[1]], h.verts[q[2]])) { hit = j; break; } }
    const f = { index: faces.length, opposite: hit === -1 ? 1 : hit, flag: type === 5, flags: [type === 5, type === 5, type === 5], points: [], shared: [] };
    for (let k = 0; k < 3; k++) { f.points.push(pointIndex[edges[ec][0]]); f.shared.push(reversed[ec]); ec++; }
    faces.push(f);
  });
  return { hullId: crc, type, unknown: 0, faces };
}

// model → .sur bytes
export function buildSur(model) {
  const parts = model.parts, rootPart = parts.find(p => !p.parent);
  const single = parts.length === 1;
  const out = [];
  const warnings = [];
  function ctxFor(part, parentCtx) {
    return { part, parent: parentCtx, transform: part.matrix || new THREE.Matrix4(), hpIds: new Set(), points: [], pointKey: new Map(), nodes: [], hash: 2166136261 };
  }
  function addPoint(ctx, v, crc) {
    const k = v.x + ',' + v.y + ',' + v.z + ',' + crc;
    if (!ctx.pointKey.has(k)) { ctx.pointKey.set(k, ctx.points.length); ctx.points.push({ p: v.clone(), mesh: crc }); }
    return ctx.pointKey.get(k);
  }
  function addHull(ctx, h, crc, type, hpid) {
    if (type === 4 && ctx.parent) {
      const tv = h.verts.map(v => v.clone().applyMatrix4(ctx.transform));
      addHull(ctx.parent, { verts: tv, tris: h.tris }, crc, 4, hpid);
    }
    if (hpid) ctx.hpIds.add(crc);
    const min = new THREE.Vector3(Infinity, Infinity, Infinity), max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    const idx = h.verts.map(v => { min.min(v); max.max(v); const f = new Float32Array([v.x, v.y, v.z]); for (const by of new Uint8Array(f.buffer)) ctx.hash = Math.imul(ctx.hash ^ by, 16777619) >>> 0; return addPoint(ctx, v, crc); });
    const n = new SurNode(); n.hull = toSurfaceHull(h, crc, type, idx); n.setBoundary(min, max);
    ctx.nodes.push(n);
  }
  function makePart(part, parentCtx, kind) {
    const crc = kind === '3db' ? 0 : kind === 'root' ? dacomCrc('Root') : dacomCrc(part.name);
    const hulls = (part.hulls || []).map(pts => simplifyHullPoints(pts)).filter(Boolean);
    hulls.forEach(h => { if (h.tris.length > 300) warnings.push(`${part.name}: hull has ${h.tris.length} triangles (Freelancer prefers < 300)`); });
    if (!hulls.length) warnings.push(`${part.name}: no collision hull`);
    const ctx = ctxFor(part, parentCtx);
    for (const h of hulls) addHull(ctx, h, crc, 4, false);
    for (const hp of part.hardpoints || []) for (const pts of hp.hulls || []) {
      const h = simplifyHullPoints(pts); if (h) addHull(ctx, h, dacomCrc(hp.name), 4, true);
    }
    const sp = { crc, dynamic: (part.kind || 'fix') === 'fix', hpIds: [], points: null, root: null };
    out.push(sp);
    for (const c of parts.filter(x => x.parent === part.name)) makePart(c, (c.kind || 'fix') === 'fix' ? ctx : null, 'normal');
    sp.hpIds = [...ctx.hpIds].sort((a, b) => a - b);
    sp.points = ctx.points;
    // pair nodes by nearest centres until one root remains
    let nodes = ctx.nodes;
    while (nodes.length > 1) {
      const next = []; const left = nodes.slice();
      while (left.length > 1) {
        let bi = 0, bj = 1, bd = Infinity;
        for (let i = 0; i < left.length; i++) for (let j = i + 1; j < left.length; j++) { const d = left[i].center.distanceTo(left[j].center); if (d < bd) { bd = d; bi = i; bj = j; } }
        const a = left[bi], b = left[bj];
        left.splice(bj, 1); left.splice(bi, 1);
        next.push(SurNode.group(a, b));
      }
      if (left.length === 1) next.push(left[0]);
      nodes = next;
    }
    if (nodes.length !== 1) { out.splice(out.indexOf(sp), 1); return; }
    sp.root = nodes[0];
    if (!sp.root.hull) {
      const arr = []; for (const p of ctx.points) arr.push(p.p.x, p.p.y, p.p.z);
      const wrap = convexHull(arr);
      if (!wrap) { out.splice(out.indexOf(sp), 1); warnings.push('could not build wrap hull for ' + part.name); return; }
      const idx = wrap.verts.map(v => ctx.points.findIndex(p => p.p.equals(v)));
      sp.root.hull = toSurfaceHull(wrap, crc, 5, idx);
    }
    sp.min = new THREE.Vector3(Infinity, Infinity, Infinity); sp.max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    let minR = 0, maxR = 0;
    for (const p of ctx.points) {
      const r = p.p.length(); maxR = Math.max(maxR, r);
      if (ctx.hpIds.has(p.mesh)) minR = Math.max(minR, r); else { sp.min.min(p.p); sp.max.max(p.p); }
    }
    if (!isFinite(sp.min.x)) { sp.min.set(0, 0, 0); sp.max.set(0, 0, 0); }
    if (minR === 0) minR = maxR;
    sp.radius = maxR; sp.scale = maxR ? minR / maxR : 1;
    const d = 0.2 * maxR * maxR;
    let rng = (Math.imul(1664525, ctx.hash) + 1013904223) >>> 0;
    const nf = () => { rng ^= rng << 13; rng >>>= 0; rng ^= rng >>> 17; rng ^= rng << 5; rng >>>= 0; return -1 + (rng / 4294967296) * 2; };
    sp.inertia = new THREE.Vector3(d + nf() * d * 0.001, d + nf() * d * 0.001, d + nf() * d * 0.001);
  }
  makePart(rootPart, null, single ? '3db' : 'root');
  if (!out.length) return { bytes: null, warnings: warnings.concat('no valid hulls') };
  out[0].dynamic = true;
  return { bytes: writeSur(out), warnings };
}

// ---------- .sur binary writer ----------
class Buf {
  constructor() { this.u8 = new Uint8Array(1 << 16); this.dv = new DataView(this.u8.buffer); this.pos = 0; this.len = 0; }
  ensure(n) { if (this.pos + n > this.u8.length) { const b = new Uint8Array(Math.max(this.u8.length * 2, this.pos + n + 1024)); b.set(this.u8); this.u8 = b; this.dv = new DataView(b.buffer); } }
  adv(n) { this.pos += n; if (this.pos > this.len) this.len = this.pos; }
  u32(v) { this.ensure(4); this.dv.setUint32(this.pos, v >>> 0, true); this.adv(4); }
  i32(v) { this.ensure(4); this.dv.setInt32(this.pos, v, true); this.adv(4); }
  u16(v) { this.ensure(2); this.dv.setUint16(this.pos, v & 0xFFFF, true); this.adv(2); }
  u8v(v) { this.ensure(1); this.u8[this.pos] = v & 255; this.adv(1); }
  f(v) { this.ensure(4); this.dv.setFloat32(this.pos, v, true); this.adv(4); }
  seek(p) { this.ensure(Math.max(0, p - this.pos)); this.pos = p; if (p > this.len) this.len = p; }
  bytes() { return this.u8.slice(0, this.len); }
}
function hullsOf(root, wrap) {
  const out = [], st = [root];
  while (st.length) { const t = st.pop(); if (t.right) st.push(t.right); if (t.left) st.push(t.left); if (t.hull && t.hull.type === 4) out.push(t.hull); }
  if (wrap && root.hull && root.hull.type === 5) out.push(root.hull);
  return out;
}
function writeHull(w, h) {
  w.u32(h.hullId);
  const refVerts = ((12 + h.faces.length * 6) / 4) | 0;
  w.u32((refVerts << 8) | h.type);
  w.u16(h.faces.length); w.u16(h.unknown);
  let edgeCount = 0;
  for (const f of h.faces) {
    let data = (f.index & 0xFFF) | ((f.opposite & 0xFFF) << 12); if (f.flag) data |= 0x80000000;
    w.u32(data >>> 0);
    for (let k = 0; k < 3; k++) {
      const s = f.shared[k];
      let sh = s - edgeCount + Math.trunc(s / 3) - Math.trunc(edgeCount / 3);
      sh &= 0x7FFF; if (f.flags[k]) sh |= 0x8000;
      w.u16(f.points[k]); w.u16(sh); edgeCount++;
    }
  }
}
function writeSurPart(w, s) {
  let sections = 2; if (s.dynamic) sections++; if (s.hpIds.length) sections++;
  w.u32(s.crc); w.u32(sections);
  if (s.dynamic) w.u32(0x64786621);
  w.u32(0x73747865); [s.min.x, s.min.y, s.min.z, s.max.x, s.max.y, s.max.z].forEach(v => w.f(v));
  w.u32(0x66727573);
  const startOffset = 4 + w.pos;
  w.seek(w.pos + 52);
  const hulls = hullsOf(s.root, true);
  const offsets = [];
  for (const h of hulls) { offsets.push(w.pos); w.u32(0); writeHull(w, h); }
  const pointsStart = w.pos;
  for (const p of s.points) { w.f(p.p.x); w.f(p.p.y); w.f(p.p.z); w.u32(p.mesh); }
  const nodesStart = w.pos;
  hulls.forEach((h, i) => { w.seek(offsets[i]); w.i32(pointsStart - offsets[i]); if (h.type === 5) w.i32(nodesStart - offsets[i]); });
  w.seek(nodesStart);
  const st = [[0, s.root]];
  while (st.length) {
    const [parentOff, node] = st.pop();
    const cur = w.pos;
    if (parentOff > 0) { w.seek(parentOff); w.i32(cur - parentOff); w.seek(cur); }
    w.u32(0);
    w.i32(node.hull ? -(cur - offsets[hulls.indexOf(node.hull)]) : 0);
    w.f(node.center.x); w.f(node.center.y); w.f(node.center.z); w.f(node.radius);
    w.u8v(node.scale.x * 0xFA); w.u8v(node.scale.y * 0xFA); w.u8v(node.scale.z * 0xFA); w.u8v(0);
    if (node.right) st.push([cur, node.right]);
    if (node.left) st.push([0, node.left]);
  }
  const bitsEnd = w.pos, endOffset = w.pos;
  w.seek(startOffset - 4);
  w.i32(endOffset - startOffset);
  w.f(0); w.f(0); w.f(0);
  w.f(s.inertia.x); w.f(s.inertia.y); w.f(s.inertia.z);
  w.f(s.radius);
  w.u32((((bitsEnd - startOffset) << 8) | ((s.scale * 0xFA) & 255)) >>> 0);
  w.i32(nodesStart - startOffset);
  w.f(0); w.f(0); w.f(0);
  w.seek(endOffset);
  if (s.hpIds.length) { w.u32(0x64697068); w.u32(s.hpIds.length); for (const id of s.hpIds) w.u32(id); }
}
export function writeSur(parts) {
  const w = new Buf();
  w.u32(0x73726576); w.u32(0x40000000);
  for (const s of parts) writeSurPart(w, s);
  return w.bytes();
}

// ---------- .sur reader (for verification and the collision overlay) ----------
export function readSur(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint32(0, true) !== 0x73726576) throw new Error('not a .sur file');
  let p = 8; const parts = [];
  while (p < u8.byteLength) {
    const part = { crc: dv.getUint32(p, true), hpIds: [], dynamic: false, points: [], hulls: [] };
    let n = dv.getUint32(p + 4, true); p += 8;
    while (n-- > 0) {
      const id = dv.getUint32(p, true); p += 4;
      if (id === 0x73747865) { part.min = [0, 1, 2].map(i => dv.getFloat32(p + i * 4, true)); part.max = [3, 4, 5].map(i => dv.getFloat32(p + i * 4, true)); p += 24; }
      else if (id === 0x64786621) part.dynamic = true;
      else if (id === 0x64697068) { const c = dv.getUint32(p, true); p += 4; for (let i = 0; i < c; i++) { part.hpIds.push(dv.getUint32(p, true)); p += 4; } }
      else if (id === 0x66727573) {
        const size = dv.getInt32(p, true); const start = p + 4; const end = start + size;
        part.center = [0, 1, 2].map(i => dv.getFloat32(start + i * 4, true));
        part.radius = dv.getFloat32(start + 24, true);
        const bitsEnd = start + (dv.getUint32(start + 28, true) >>> 8), nodesStart = start + dv.getUint32(start + 32, true);
        let pointsStart = 0;
        const st = [nodesStart], seenHull = new Set();
        while (st.length) {
          const no = st.pop(); if (no < nodesStart || no > bitsEnd) throw new Error('sur node out of range');
          const right = dv.getInt32(no, true), hullRel = dv.getInt32(no + 4, true);
          const leftOff = no + 8 + 20;
          let type = 0;
          if (hullRel) {
            const ho = no + hullRel;
            pointsStart = dv.getInt32(ho, true) + ho;
            const hullId = dv.getUint32(ho + 4, true); type = dv.getUint32(ho + 8, true) & 255; const fc = dv.getInt16(ho + 12, true);
            if (!seenHull.has(ho)) {
              seenHull.add(ho);
              const faces = []; let q = ho + 16;
              for (let i = 0; i < fc; i++) { faces.push([dv.getUint16(q + 4, true), dv.getUint16(q + 8, true), dv.getUint16(q + 12, true)]); q += 16; }
              part.hulls.push({ hullId, type, faces });
            }
          }
          if (!hullRel || type === 5) { if (right) st.push(no + right); st.push(leftOff); }
        }
        for (let q = pointsStart; q < nodesStart; q += 16) part.points.push([dv.getFloat32(q, true), dv.getFloat32(q + 4, true), dv.getFloat32(q + 8, true), dv.getUint32(q + 12, true)]);
        p = end;
      }
    }
    parts.push(part);
  }
  return parts;
}
