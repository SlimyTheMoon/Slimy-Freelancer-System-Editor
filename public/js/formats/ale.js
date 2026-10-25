// Alchemy (.ale) particle effect files — parser + curve evaluation.
// ALE effect library reader and easings.
import { parseUtf } from './utf.js';
import { aleCrc } from './crc.js';

export const P = { // AleProperty ids
  BasicApp_Alpha: 0x4FC9016, BasicApp_BlendInfo: 0x1506EB6C, BasicApp_Color: 0x48767E8, BasicApp_CommonTexFrame: 0xF52B8DD5,
  BasicApp_FlipTexU: 0xF3D52EE4, BasicApp_FlipTexV: 0xE8DC7F5E, BasicApp_HToVAspect: 0xE0E97650, BasicApp_MotionBlur: 0xE91467F1,
  BasicApp_Rotate: 0x5DB630E, BasicApp_Size: 0xF7C2EBA9, BasicApp_TexFrame: 0x15A6F47, BasicApp_TexName: 0x1BA23359,
  BasicApp_TriTexture: 0xF863872E, BasicApp_UseCommonTexFrame: 0xE2F60EEB,
  ConeEmitter_MaxRadius: 0xF636F07F, ConeEmitter_MaxSpread: 0xFA4B5E41, ConeEmitter_MinRadius: 0x1C73D16B, ConeEmitter_MinSpread: 0x100E7F55,
  CubeEmitter_Depth: 0x14B74EB2, CubeEmitter_Height: 0xEFB0F8CF, CubeEmitter_Width: 0xFD22A11C,
  Emitter_EmitCount: 0xE7221F95, Emitter_Frequency: 0x23C350C, Emitter_InitialParticles: 0xF9A9D52, Emitter_InitLifeSpan: 0xA635880,
  Emitter_MaxParticles: 0xF5042852, Emitter_Pressure: 0xAB180C5, Emitter_VelocityApproach: 0x681233E,
  Node_LifeSpan: 0xF27FDE7D, Node_Name: 0xEFA8CE01, Node_Transform: 0xE13A59A1,
  OrientedApp_Height: 0xF267B8E1, OrientedApp_Width: 0xFA03992F,
  RectApp_CenterOnPos: 0xFB7958C1, RectApp_Length: 0xE48DDAE2, RectApp_Scale: 0xFBA203B8, RectApp_ViewingAngleFade: 0xF9FEBF0D, RectApp_Width: 0x1266735F,
  SphereEmitter_MaxRadius: 0x1874DE74, SphereEmitter_MinRadius: 0xF231FF60,
  GravityField_Gravity: 0xE02B8BD4, AirField_Magnitude: 0xE5E3524C, AirField_Approach: 0x10423CEB,
  // names below come from the property tables in alchemy.dll ({name pointer, hash, type, …} records)
  Appearance_LODCurve: 0x0C53B008, Emitter_LODCurve: 0xFE077E05, BasicApp_QuadTexture: 0xF87B5FD5, Node_ClassName: 0xF54EF296,
  BeamApp_DisablePlaceHolder: 0x08508C35, BeamApp_DupeFirstParticle: 0xE8B8CDE7, BeamApp_LineAppearance: 0x1C65B7B9,
  CubeEmitter_MinSpread: 0xE282006B, CubeEmitter_MaxSpread: 0x08C7217F,
  CollideField_Reflectivity: 0xF2468210, CollideField_Width: 0x138BDB51, CollideField_Height: 0x11336C98,
  MeshApp_MeshId: 0x0B7EE41C, MeshApp_MeshName: 0x18DADCA8, MeshApp_UseParticleTransform: 0x001FC112, MeshApp_ParticleTransform: 0xF0004D58,
  ParticleApp_LifeName: 0x0EC7A290, ParticleApp_DeathName: 0x03B76E6C, ParticleApp_UseDynamicRotation: 0xE34C3C55, ParticleApp_SmoothRotation: 0x049A6DBE,
  RadialField_Radius: 0xFF28F620, RadialField_Attenuation: 0x1A433168, RadialField_Magnitude: 0x0064B3B9, RadialField_Approach: 0xF3CF5EA5,
  TurbulenceField_Magnitude: 0x1CEAC6D1, TurbulenceField_Approach: 0x1B970B9A,
};

// ---------------- easing ----------------
const lerp = (a, b, t) => a + (b - a) * t;
export function ease(type, time, t1, t2, v1, v2) {
  const x = (time - t1) / (t2 - t1);
  switch (type) {
    case 1: return lerp(v1, v2, x);
    case 2: return lerp(v1, v2, x * x);
    case 3: return lerp(v1, v2, 1 - (1 - x) * (1 - x));
    case 4: return lerp(v1, v2, x * x * (3 - 2 * x));
    case 5: return lerp(v1, v2, v1 > v2 ? 1 - (1 - x) * (1 - x) : x * x);
    default: return v1; // step
  }
}
function easeColor(type, time, t1, t2, a, b) { return [0, 1, 2].map(i => ease(type, time, t1, t2, a[i], b[i])); }

function keyframeLookup(kf, time, interp) {
  if (!kf.length) return 0; // an item without keyframes (occurs in vanilla data)
  if (kf.length === 1 || time <= kf[0][0]) return kf[0][1];
  if (time >= kf[kf.length - 1][0]) return kf[kf.length - 1][1];
  let i = 1; while (i < kf.length && kf[i][0] <= time) i++;
  return interp(time, kf[i - 1][0], kf[i][0], kf[i - 1][1], kf[i][1]);
}

// FloatAnimation / ColorAnimation: items keyed by sparam, each with keyframes over normalized particle time
export class FloatAnim {
  constructor(type = 1, items = [{ sparam: 0, type: 1, kf: [[0, 0]] }]) { this.type = type; this.items = items; }
  static constant(v) { return new FloatAnim(1, [{ sparam: 0, type: 1, kf: [[0, v]] }]); }
  itemValue(it, t) { return keyframeLookup(it.kf, t, (time, t1, t2, v1, v2) => ease(it.type, time, t1, t2, v1, v2)); }
  get(sparam, t) {
    const I = this.items;
    if (I.length === 1) return this.itemValue(I[0], t);
    for (let i = 0; i < I.length - 1; i++) if (sparam >= I[i].sparam && sparam <= I[i + 1].sparam)
      return ease(this.type, sparam, I[i].sparam, I[i + 1].sparam, this.itemValue(I[i], t), this.itemValue(I[i + 1], t));
    return this.itemValue(I[I.length - 1], t);
  }
  max(abs) { let m = 0; for (const it of this.items) for (const [, v] of it.kf) { const x = abs ? Math.abs(v) : v; if (x > m) m = x; } return m; }
}
export class ColorAnim {
  constructor(type = 1, items = [{ sparam: 0, type: 1, kf: [[0, [1, 1, 1]]] }]) { this.type = type; this.items = items; }
  itemValue(it, t) { return keyframeLookup(it.kf, t, (time, t1, t2, v1, v2) => it.type === 0 ? v1 : easeColor(it.type, time, t1, t2, v1, v2)); }
  get(sparam, t) {
    const I = this.items;
    if (I.length === 1) return this.itemValue(I[0], t);
    for (let i = 0; i < I.length - 1; i++) if (sparam >= I[i].sparam && sparam <= I[i + 1].sparam)
      return easeColor(this.type, sparam, I[i].sparam, I[i + 1].sparam, this.itemValue(I[i], t), this.itemValue(I[i + 1], t));
    return this.itemValue(I[I.length - 1], t);
  }
}
// CurveAnimation: items keyed by sparam; each a constant or a Hermite-ish curve over global time
export class CurveAnim {
  constructor(type = 1, items = []) { this.type = type; this.items = items; }
  static constant(v) { return new CurveAnim(1, [{ sparam: 0, value: v, flags: 0, kf: [] }]); }
  get animates() { return !(this.items.length === 1 && !this.items[0].kf.length); }
  itemValue(c, time) {
    const K = c.kf;
    if (!K.length) return c.value;
    if (K.length === 1) return K[0].v;
    const last = K[K.length - 1];
    if (time >= last.t) { if (c.flags === 16 && last.t > 0) time = time % last.t; else return last.v; }
    if (time <= K[0].t) return K[0].v;
    let i = 1; while (i < K.length && K[i].t <= time) i++;
    if (i >= K.length) return last.v;
    const a = K[i - 1], b = K[i];
    const dt = b.t - a.t, dt2 = dt * 0.5, t0 = (time - a.t) / dt;
    const a0 = a.start * dt2 + a.v, b0 = -b.end * dt2 + b.v;
    const a1 = lerp(a.v, a0, t0), b1 = lerp(a0, b.v, t0), a2 = lerp(a.v, b0, t0), b2 = lerp(b0, b.v, t0);
    return lerp(lerp(a1, a2, t0), lerp(b1, b2, t0), t0);
  }
  get(sparam, time) {
    const I = this.items;
    if (!I.length) return 0;
    if (I.length === 1) return this.itemValue(I[0], time);
    for (let i = 0; i < I.length - 1; i++) {
      if (sparam >= I[i].sparam && sparam <= I[i + 1].sparam) {
        let c1 = I[i], c2 = I[i + 1];
        if (i + 2 < I.length && sparam >= I[i + 1].sparam && sparam <= I[i + 2].sparam) { c1 = I[i + 1]; c2 = I[i + 2]; }
        if (Math.abs(c1.sparam - c2.sparam) < 1e-7) return this.itemValue(c2, time);
        return ease(this.type, sparam, c1.sparam, c2.sparam, this.itemValue(c1, time), this.itemValue(c2, time));
      }
    }
    return this.itemValue(I[I.length - 1], time);
  }
  max(abs) { let m = 0; for (const c of this.items) { const vals = c.kf.length ? c.kf.map(k => k.v) : [c.value]; for (const v of vals) { const x = abs ? Math.abs(v) : v; if (x > m) m = x; } } return m; }
}
export class AleTransform {
  constructor(parts = null) { this.has = !!parts; Object.assign(this, parts || {}); this.animates = !!parts && Object.values(parts).some(c => c.animates); }
  translation(s, t) { return this.has ? [this.tx.get(s, t), this.ty.get(s, t), this.tz.get(s, t)] : [0, 0, 0]; }
  rotation(s, t) { return this.has ? [this.rx.get(s, t), this.ry.get(s, t), this.rz.get(s, t)] : [0, 0, 0]; } // pitch, yaw, roll degrees
  scale(s, t) { return this.has ? [this.sx.get(s, t), this.sy.get(s, t), this.sz.get(s, t)].map(v => Math.max(1e-5, v)) : [1, 1, 1]; }
}

// ---------------- binary reading ----------------
class Reader {
  constructor(u8) { this.u8 = u8; this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); this.p = 0; }
  u8_() { return this.u8[this.p++]; }
  u16() { const v = this.dv.getUint16(this.p, true); this.p += 2; return v; }
  u32() { const v = this.dv.getUint32(this.p, true); this.p += 4; return v; }
  f32() { const v = this.dv.getFloat32(this.p, true); this.p += 4; return v; }
  get left() { return this.u8.length - this.p; }
  str(len) { let s = ''; for (let i = 0; i < len; i++) { const c = this.u8[this.p + i]; if (c) s += String.fromCharCode(c); } this.p += len; return s; }
  name() { const n = this.u16(); this.lastLen = n; const s = this.str(n); this.p += n & 1; return s; }
}
function readCurve(r) {
  const type = r.u8_(), n = r.u8_(); const items = [];
  for (let i = 0; i < n; i++) {
    const c = { sparam: r.f32(), value: r.f32(), flags: 0, kf: [] };
    const loop = r.u16(), cnt = r.u16(); c.flags = loop;
    if (loop || cnt) for (let j = 0; j < cnt; j++) c.kf.push({ t: r.f32(), v: r.f32(), end: r.f32(), start: r.f32() });
    items.push(c);
  }
  return new CurveAnim(type, items);
}
function readFloatAnim(r) {
  const type = r.u8_(), n = r.u8_(); const items = [];
  for (let i = 0; i < n; i++) { const it = { sparam: r.f32(), type: r.u8_(), kf: [] }; const len = r.u8_(); for (let j = 0; j < len; j++) it.kf.push([r.f32(), r.f32()]); items.push(it); }
  return new FloatAnim(type, items);
}
function readColorAnim(r) {
  const type = r.u8_(), n = r.u8_(); const items = [];
  for (let i = 0; i < n; i++) { const it = { sparam: r.f32(), type: r.u8_(), kf: [] }; const len = r.u8_(); for (let j = 0; j < len; j++) it.kf.push([r.f32(), [r.f32(), r.f32(), r.f32()]]); items.push(it); }
  return new ColorAnim(type, items);
}
const TR_KEYS = ['tx', 'ty', 'tz', 'rx', 'ry', 'rz', 'sx', 'sy', 'sz'];
function readTransform(r) {
  const hdr = r.u8.slice(r.p, r.p + 4); r.p += 3;
  const has = r.u8_() !== 0;
  let t;
  if (!has) t = new AleTransform(null);
  else { const parts = {}; for (const key of TR_KEYS) parts[key] = readCurve(r); t = new AleTransform(parts); }
  t.hdr = hdr; return t;
}

export function parseAle(u8) {
  const root = parseUtf(u8);
  const fxLeaf = root.child('ALEffectLib') && (root.child('ALEffectLib').children || [])[0];
  const nodeLeaf = root.child('AlchemyNodeLibrary') && (root.child('AlchemyNodeLibrary').children || [])[0];
  const effects = [], nodes = [];
  if (fxLeaf) {
    const r = new Reader(fxLeaf.data);
    const version = r.f32(); const count = r.u32();
    for (let e = 0; e < count; e++) {
      const name = r.name();
      if (Math.abs(version - 1.1) < 1e-4) r.p += 16;
      const nref = r.u32(); const refs = [];
      for (let i = 0; i < nref; i++) refs.push({ flag: r.u32(), crc: r.u32(), parent: r.u32(), index: r.u32() });
      let npairs = r.u32(); npairs = Math.min(npairs, Math.floor(r.left / 8));
      const pairs = []; for (let i = 0; i < npairs; i++) pairs.push([r.u32(), r.u32()]);
      effects.push({ name, crc: aleCrc(name), refs, pairs });
    }
  }
  if (nodeLeaf) {
    const r = new Reader(nodeLeaf.data);
    const header = r.u8.slice(0, 4); r.p += 4; const count = r.u32();
    nodes.header = header;
    outer: for (let n = 0; n < count; n++) {
      const cls = r.name();
      const params = new Map(), order = []; let term = false;
      while (r.left >= 2) {
        const id = r.u16(); if (id === 0) { term = true; break; }
        const type = id & 0x7FFF; const prop = r.u32();
        let v;
        switch (type) {
          case 0x001: v = (id & 0x8000) !== 0; break;
          case 0x002: v = r.u32(); break;
          case 0x003: v = r.f32(); break;
          case 0x103: v = r.name(); break;
          case 0x104: v = [r.u32(), r.u32()]; break;
          case 0x105: v = readTransform(r); break;
          case 0x200: v = readFloatAnim(r); break;
          case 0x201: v = readColorAnim(r); break;
          case 0x202: v = readCurve(r); break;
          default:
            // unknown property type (e.g. 0x204 in Discovery's gf_battledust.ale): its size is unknown, so
            // nothing after it can be read. Keep what was read; the library is marked so it is never written back.
            nodes.truncated = `property type 0x${type.toString(16)} in node ${n + 1} of ${count} (${cls})`;
            nodes.push({ cls, name: params.get(P.Node_Name) || cls, crc: aleCrc(params.get(P.Node_Name) || cls), params, order, term: false, truncated: true });
            break outer;
        }
        const o = { id, prop }; if (type === 0x103) { o.len = r.lastLen; o.orig = v; } params.set(prop, v); order.push(o);
      }
      const name = params.get(P.Node_Name) || cls;
      nodes.push({ cls, name, crc: aleCrc(name), params, order, term });
    }
  }
  return { effects, nodes, root, nodeLeaf, truncated: nodes.truncated || null };
}

// ---------------- binary writing (node library) ----------------
class Writer {
  constructor() { this.buf = new Uint8Array(4096); this.dv = new DataView(this.buf.buffer); this.p = 0; }
  need(n) { if (this.p + n <= this.buf.length) return; const b = new Uint8Array(Math.max(this.buf.length * 2, this.p + n)); b.set(this.buf); this.buf = b; this.dv = new DataView(b.buffer); }
  u8_(v) { this.need(1); this.buf[this.p++] = v; }
  u16(v) { this.need(2); this.dv.setUint16(this.p, v, true); this.p += 2; }
  u32(v) { this.need(4); this.dv.setUint32(this.p, v >>> 0, true); this.p += 4; }
  f32(v) { this.need(4); this.dv.setFloat32(this.p, v, true); this.p += 4; }
  bytes(b) { this.need(b.length); this.buf.set(b, this.p); this.p += b.length; }
  name(s, len = null) { if (len == null) len = s ? s.length + 1 : 0; this.u16(len); for (let i = 0; i < len + (len & 1); i++) this.u8_(i < s.length ? s.charCodeAt(i) & 0xff : 0); }
  out() { return this.buf.slice(0, this.p); }
}
function writeCurve(w, c) {
  w.u8_(c.type); w.u8_(c.items.length);
  for (const it of c.items) {
    w.f32(it.sparam); w.f32(it.value); w.u16(it.flags || 0); w.u16(it.kf.length);
    if (it.flags || it.kf.length) for (const k of it.kf) { w.f32(k.t); w.f32(k.v); w.f32(k.end); w.f32(k.start); }
  }
}
function writeFloatAnim(w, a) { w.u8_(a.type); w.u8_(a.items.length); for (const it of a.items) { w.f32(it.sparam); w.u8_(it.type); w.u8_(it.kf.length); for (const [t, v] of it.kf) { w.f32(t); w.f32(v); } } }
function writeColorAnim(w, a) { w.u8_(a.type); w.u8_(a.items.length); for (const it of a.items) { w.f32(it.sparam); w.u8_(it.type); w.u8_(it.kf.length); for (const [t, c] of it.kf) { w.f32(t); w.f32(c[0]); w.f32(c[1]); w.f32(c[2]); } } }
// serialize parsed nodes back to the AlchemyNodeLibrary leaf (inverse of parseAle's node loop)
export function writeAleNodes(nodes) {
  if (nodes.truncated) throw new Error('This effect file could not be read completely (' + nodes.truncated + ') — saving it would lose the unread part');
  const w = new Writer();
  w.bytes(nodes.header || new Uint8Array([0x66, 0x66, 0x86, 0x3f])); w.u32(nodes.length);
  for (const n of nodes) {
    w.name(n.cls);
    for (const { id, prop, len, orig } of n.order) {
      const type = id & 0x7FFF, v = n.params.get(prop);
      w.u16(type === 0x001 ? (v ? (id | 0x8000) : (id & 0x7FFF)) : id); w.u32(prop);
      switch (type) {
        case 0x001: break;
        case 0x002: w.u32(v); break;
        case 0x003: w.f32(v); break;
        case 0x103: w.name(v, v === orig ? len : null); break;
        case 0x104: w.u32(v[0]); w.u32(v[1]); break;
        case 0x105: w.bytes(v.hdr ? v.hdr.slice(0, 3) : new Uint8Array(3)); w.u8_(v.has ? (v.hdr && v.hdr[3] ? v.hdr[3] : 1) : 0); if (v.has) for (const k of TR_KEYS) writeCurve(w, v[k]); break;
        case 0x200: writeFloatAnim(w, v); break;
        case 0x201: writeColorAnim(w, v); break;
        case 0x202: writeCurve(w, v); break;
      }
    }
    if (n.term) w.u16(0);
  }
  return w.out();
}
export const PROP_NAMES = new Map(Object.entries(P).map(([k, v]) => [v >>> 0, k]));
export const PROP_TYPE_NAMES = { 0x001: 'bool', 0x002: 'int', 0x003: 'float', 0x103: 'string', 0x104: 'blend', 0x105: 'transform', 0x200: 'float anim', 0x201: 'colour anim', 0x202: 'curve' };
