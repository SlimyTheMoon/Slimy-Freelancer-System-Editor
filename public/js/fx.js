// Particle effects (Alchemy .ale) runtime + THREE renderer.
// Simulation: emitter update, per-emitter SetParticle,
// ParticleEffectInstance.Update, Fx*Appearance.Draw and Particle.vert.hlsl.
import * as THREE from 'three';
import { parseAle, P, FloatAnim, ColorAnim, CurveAnim } from './formats/ale.js';
import { aleCrc } from './formats/crc.js';
import { dataPath } from './api.js';

const DEG = Math.PI / 180;
const rnd = (a, b) => a + Math.random() * (b - a);

// ------------------------------------------------------------ library
export class FxLibrary {
  constructor(ale, path) {
    this.path = path;
    const byCrc = new Map();
    for (const n of ale.nodes) byCrc.set(n.crc, wrapNode(n));
    this.effects = new Map();
    for (const e of ale.effects) {
      const refs = new Map();
      for (const r of e.refs) {
        const node = r.flag === 1 ? { kind: 'node', transform: null, lifespan: Infinity } : (byCrc.get(r.crc) || { kind: 'node', transform: null, lifespan: Infinity });
        refs.set(r.index, { node, attachment: r.flag === 1, children: [], parent: null, idx: 0 });
      }
      for (const r of e.refs) { if (r.parent === 32768) continue; const p = refs.get(r.parent), c = refs.get(r.index); if (p && c) { p.children.push(c); c.parent = p; } }
      const emitters = [], appearances = [];
      for (const ref of refs.values()) { if (ref.node.kind === 'emitter') emitters.push(ref); else if (ref.node.kind === 'appearance') appearances.push(ref); }
      for (const [s, t] of e.pairs) {
        const a = refs.get(s), b = refs.get(t); if (!a || !b) continue;
        if (a.node.kind === 'emitter' && b.node.kind === 'appearance') a.linked = b;
        else if (a.node.kind === 'appearance' && b.node.kind === 'field') (a.fields = a.fields || []).push(b); // field acts on that appearance's particles
      }
      let i = 0; const roots = [...refs.values()].filter(r => !r.parent);
      const assign = (r) => { r.idx = i++; r.children.forEach(assign); }; roots.forEach(assign);
      this.effects.set(e.crc, { name: e.name, crc: e.crc, roots, emitters, appearances, nodeCount: i, lib: this });
    }
  }
  find(crc) { if (this.effects.size === 1) return this.effects.values().next().value; return this.effects.get(crc >>> 0) || null; }
}

function curve(n, id, def = 0) { const v = n.params.get(id); return v instanceof CurveAnim ? v : CurveAnim.constant(def); }
function fanim(n, id, def = 0, allowNull = false) { const v = n.params.get(id); return v instanceof FloatAnim ? v : (allowNull ? null : FloatAnim.constant(def)); }
function wrapNode(n) {
  const base = { name: n.name, cls: n.cls, transform: n.params.get(P.Node_Transform) || null, lifespan: n.params.has(P.Node_LifeSpan) ? n.params.get(P.Node_LifeSpan) : Infinity };
  if (/Emitter$/.test(n.cls)) {
    const e = Object.assign(base, {
      kind: 'emitter', shape: n.cls === 'FxConeEmitter' ? 'cone' : n.cls === 'FxSphereEmitter' ? 'sphere' : 'cube',
      frequency: n.params.get(P.Emitter_Frequency) || null, initLife: curve(n, P.Emitter_InitLifeSpan, 1), pressure: curve(n, P.Emitter_Pressure, 0),
      maxParticles: n.params.get(P.Emitter_MaxParticles) || null,
    });
    if (e.shape === 'cone') Object.assign(e, { minR: curve(n, P.ConeEmitter_MinRadius), maxR: curve(n, P.ConeEmitter_MaxRadius), minS: curve(n, P.ConeEmitter_MinSpread), maxS: curve(n, P.ConeEmitter_MaxSpread) });
    else if (e.shape === 'sphere') Object.assign(e, { minR: curve(n, P.SphereEmitter_MinRadius), maxR: curve(n, P.SphereEmitter_MaxRadius) });
    else Object.assign(e, { w: curve(n, P.CubeEmitter_Width), h: curve(n, P.CubeEmitter_Height), d: curve(n, P.CubeEmitter_Depth) });
    return e;
  }
  // fields (runtime behaviour from alchemy.dll, see FIELD below)
  const fieldKinds = { FxGravityField: 'gravity', FxAirField: 'air', FxRadialField: 'radial', FxTurbulenceField: 'turbulence', FxCollideField: 'collide', FLDustField: 'dust', FLBeamField: 'beamfield' };
  if (fieldKinds[n.cls]) return Object.assign(base, {
    kind: 'field', field: fieldKinds[n.cls],
    gravity: curve(n, P.GravityField_Gravity), magnitude: curve(n, n.cls === 'FxAirField' ? P.AirField_Magnitude : n.cls === 'FxRadialField' ? P.RadialField_Magnitude : P.TurbulenceField_Magnitude),
    approach: curve(n, n.cls === 'FxAirField' ? P.AirField_Approach : n.cls === 'FxRadialField' ? P.RadialField_Approach : P.TurbulenceField_Approach),
    radius: curve(n, P.RadialField_Radius, 1), attenuation: fanim(n, P.RadialField_Attenuation, 1),
    reflectivity: curve(n, P.CollideField_Reflectivity, 1), width: curve(n, P.CollideField_Width, 1), height: curve(n, P.CollideField_Height, 1),
    dustRadius: curve(n, P.SphereEmitter_MaxRadius, 1),
  });
  if (n.cls === 'FxMeshAppearance') return Object.assign(base, { kind: 'appearance', draw: 'mesh', meshName: n.params.get(P.MeshApp_MeshName) || '' });
  if (n.cls === 'FxParticleAppearance') return Object.assign(base, { kind: 'appearance', draw: 'particle', lifeName: n.params.get(P.ParticleApp_LifeName) || '', deathName: n.params.get(P.ParticleApp_DeathName) || '' });
  const drawKinds = { FxBasicAppearance: 'basic', FxRectAppearance: 'rect', FxPerpAppearance: 'perp', FxOrientedAppearance: 'basic', FLDustAppearance: 'basic', FLBeamAppearance: 'beam' };
  if (drawKinds[n.cls]) {
    const color = n.params.get(P.BasicApp_Color); const blend = n.params.get(P.BasicApp_BlendInfo);
    return Object.assign(base, {
      kind: 'appearance', draw: drawKinds[n.cls],
      color: color instanceof ColorAnim ? color : new ColorAnim(), alpha: fanim(n, P.BasicApp_Alpha, 0), size: fanim(n, P.BasicApp_Size, 0),
      rotate: fanim(n, P.BasicApp_Rotate, 0, true), texture: n.params.get(P.BasicApp_TexName) || '',
      useCommon: !!n.params.get(P.BasicApp_UseCommonTexFrame), texFrame: fanim(n, P.BasicApp_TexFrame, 0, true), commonTexFrame: n.params.get(P.BasicApp_CommonTexFrame) || null,
      flipU: !!n.params.get(P.BasicApp_FlipTexU), flipV: !!n.params.get(P.BasicApp_FlipTexV), motionBlur: !!n.params.get(P.BasicApp_MotionBlur),
      blend: Array.isArray(blend) ? blend : [5, 6],
      scale: fanim(n, P.RectApp_Scale, 0), length: fanim(n, P.RectApp_Length, 0), width: fanim(n, P.RectApp_Width, 0), centerOnPos: !!n.params.get(P.RectApp_CenterOnPos),
      dupeFirst: !!n.params.get(P.BeamApp_DupeFirstParticle), lineApp: !!n.params.get(P.BeamApp_LineAppearance),
    });
  }
  return Object.assign(base, { kind: /Appearance$/.test(n.cls) ? 'unsupported' : 'node' });
}

// node-local transform at time t (Euler X,Y,Z degrees, scale, translate)
const _e = new THREE.Euler(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _t = new THREE.Vector3();
function nodeMatrix(tr, sparam, t, out) {
  const [x, y, z] = tr.rotation(sparam, t);
  _e.set(x * DEG, y * DEG, z * DEG, 'ZYX'); _q.setFromEuler(_e);
  _s.fromArray(tr.scale(sparam, t)); _t.fromArray(tr.translation(sparam, t));
  return out.compose(_t, _q, _s);
}

// ------------------------------------------------------------ textures
const BLEND = { 1: THREE.ZeroFactor, 2: THREE.OneFactor, 3: THREE.SrcColorFactor, 4: THREE.OneMinusSrcColorFactor, 5: THREE.SrcAlphaFactor, 6: THREE.OneMinusSrcAlphaFactor, 7: THREE.DstAlphaFactor, 8: THREE.OneMinusDstAlphaFactor, 9: THREE.DstColorFactor, 10: THREE.OneMinusDstColorFactor, 11: THREE.SrcAlphaSaturateFactor };

function particleTexture(rm, name) {
  const k = (name || '').toLowerCase();
  const node = rm.textures.get(k);
  if (node && node.child('Frame rects')) {
    const fr = node.child('Frame rects').floats(); const frames = [];
    for (let i = 0; i + 4 < fr.length; i += 5) frames.push({ u1: fr[i + 1], v1: fr[i + 2], u2: fr[i + 3], v2: fr[i + 4] });
    return { tex: rm.texture(name + '_0'), frames };
  }
  return { tex: rm.texture(name), frames: null };
}
function frameCoords(pt, frame) {
  if (!pt.frames || !pt.frames.length) return [0, 0, 1, 1];
  const f = pt.frames[Math.max(0, Math.min(pt.frames.length - 1, Math.floor((pt.frames.length - 1) * frame)))];
  const x = f.u1, y = 1 - f.v1; return [x, y, f.u2 - f.u1, (1 - f.v2) - y];
}

// ------------------------------------------------------------ shader
const VERT = `
attribute vec2 corner;
attribute vec3 iPos; attribute vec4 iColor; attribute vec3 iNormal; attribute float iRot; attribute vec4 iUV; attribute vec2 iHalf; attribute float iMB;
uniform int kind;
varying vec2 vUv; varying vec4 vColor;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vec3 p = iPos; vec3 right; vec3 up;
  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  float stretch = 0.0;
  if (kind == 0) {
    if (iMB < 0.5 || length(iNormal) < 1e-5) { right = camRight; up = camUp; }
    else {
      vec3 toCam = normalize(cameraPosition - p); up = iNormal; right = cross(up, toCam);
      float ang = atan(length(right), dot(up, toCam)); stretch = length(iNormal) * 0.03 * abs(sin(ang));
      right = normalize(right); up = normalize(cross(toCam, right));
    }
  } else if (kind == 1) {
    right = normalize(iNormal); vec3 toCam = normalize(cameraPosition - p); up = cross(toCam, right);
  } else {
    right = cross(iNormal, vec3(0.0, 1.0, 0.0)); up = cross(right, iNormal);
  }
  float s = sin(iRot), c = cos(iRot);
  vec3 vU = (c * right - s * up) * iHalf.x;
  vec3 vR = (s * right + c * up) * iHalf.y;
  vec3 pos = p + corner.x * vU + corner.y * vR;
  if (stretch > 0.0 && corner.y < 0.0) pos -= up * stretch;
  vUv = vec2(corner.x < 0.0 ? iUV.x : iUV.z, corner.y < 0.0 ? iUV.w : iUV.y);
  vColor = iColor;
  gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
  #include <logdepthbuf_vertex>
}`;
const FRAG = `
uniform sampler2D map; uniform float hasMap;
varying vec2 vUv; varying vec4 vColor;
#include <logdepthbuf_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  vec4 t = hasMap > 0.5 ? texture2D(map, vUv) : vec4(1.0);
  gl_FragColor = t * vColor;
  #include <colorspace_fragment>
}`;

class AppearanceMesh {
  constructor(app, rm, max) {
    this.app = app; this.max = max;
    this.pt = particleTexture(rm, app.texture);
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0], 3));
    g.setAttribute('corner', new THREE.Float32BufferAttribute([-1, -1, 1, -1, -1, 1, 1, 1], 2));
    g.setIndex([0, 1, 2, 1, 3, 2]);
    const mk = (n, size) => { const a = new THREE.InstancedBufferAttribute(new Float32Array(max * size), size); a.setUsage(THREE.DynamicDrawUsage); g.setAttribute(n, a); return a; };
    this.a = { pos: mk('iPos', 3), color: mk('iColor', 4), normal: mk('iNormal', 3), rot: mk('iRot', 1), uv: mk('iUV', 4), half: mk('iHalf', 2), mb: mk('iMB', 1) };
    g.instanceCount = 0;
    const [src, dst] = app.blend;
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      uniforms: { map: { value: this.pt.tex }, hasMap: { value: this.pt.tex ? 1 : 0 }, kind: { value: app.draw === 'rect' ? 1 : app.draw === 'perp' ? 2 : 0 } },
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.CustomBlending, blendSrc: BLEND[src] || THREE.SrcAlphaFactor, blendDst: BLEND[dst] || THREE.OneFactor,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 6; this.mesh.userData.noPick = true; this.mesh.matrixAutoUpdate = false;
  }
}


// FLBeamAppearance, as retail FUN_06205720 / FUN_06206020 (alchemy appearances
// FillRibbon / EmitRing): newest particle first, a ring of four vertices per particle on two rails
// (camera right and camera up, so the beam reads from any angle), half width =
// RectApp_Width(t) · RectApp_Scale(t) · 0.5, U across the rail (frame u0 / u1), V alternating between
// the frame's top and bottom on every ring, and a ring is only added once the beam has moved
// more than 0.1 (squared length > 0.01).
const BVERT = `
attribute vec4 bColor; varying vec2 vUv; varying vec4 vColor;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() { vUv = uv; vColor = bColor; gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`;
class BeamMesh {
  constructor(app, rm, max) {
    this.app = app; this.max = max;
    this.pt = particleTexture(rm, app.texture);
    const g = new THREE.BufferGeometry();
    const mk = (n, size) => { const a = new THREE.BufferAttribute(new Float32Array(max * 4 * size), size); a.setUsage(THREE.DynamicDrawUsage); g.setAttribute(n, a); return a; };
    this.a = { pos: mk('position', 3), uv: mk('uv', 2), color: mk('bColor', 4) };
    // ring i = 4 vertices (rail A: −A,+A along camera right; rail B: −B,+B along camera up);
    // each segment joins two rings with two quads (retail FUN_06208b50 order)
    const idx = []; for (let i = 0; i < max - 1; i++) { const p = i * 4, q = p + 4; idx.push(p, p + 1, q, p + 1, q + 1, q, p + 2, p + 3, q + 2, p + 3, q + 3, q + 2); }
    g.setIndex(idx); g.setDrawRange(0, 0);
    const [src, dst] = app.blend;
    this.material = new THREE.ShaderMaterial({
      vertexShader: BVERT, fragmentShader: FRAG, uniforms: { map: { value: this.pt.tex }, hasMap: { value: this.pt.tex ? 1 : 0 } },
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.CustomBlending, blendSrc: BLEND[src] || THREE.SrcAlphaFactor, blendDst: BLEND[dst] || THREE.OneFactor,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 6; this.mesh.userData.noPick = true; this.mesh.matrixAutoUpdate = false;
  }
}

// Fields act on the particles of the appearance they are paired with. Formulas as retail alchemy.dll,
// checked against the decompiled alchemy fields (Pad5 per frame, BeginField, ApplyFieldToVel):
//   k = min(1, 4·dt·Approach)
//   gravity:    v += R·(0, −Gravity·dt, 0)
//   air:        v += (R·(0, Magnitude, 0) − v)·k
//   turbulence: v += (unit(rand3) · rand · Magnitude − v)·k
//   radial:     d = c − p; f = Attenuation(min(1, |d|/Radius)); v += (d · f · −Magnitude − v)·k  (d not normalised)
//   collide:    infinite plane through the field origin, normal R·(0,1,0) offset by 5 along the normal;
//               a particle crossing it this frame is put on the plane and bounces with Reflectivity
//               (CollideField_Width/Height are read but never used by the game)
//   FLDustField: particles outside the radius die; others get age = (1 − (R − z)/(2R)) · fade · 10,
//               fade = 1 − (d² − 0.8R²)/(0.2R²) for z < 0 and d² > 0.8R² (positions in field space)
const _fi = new THREE.Matrix4(), _fv = new THREE.Vector3(), _fw = new THREE.Vector3(), _fm = new THREE.Matrix4(), _fy = new THREE.Vector3(), _fc = new THREE.Vector3(), _fq = new THREE.Quaternion(), _fs = new THREE.Vector3(), _ft = new THREE.Vector3();
function applyFields(inst, ar, list, dt) {
  const s = inst.sparam, t = inst.time;
  for (const fr of ar.fields) {
    const f = fr.node;
    _fm.copy(inst.nodeWorld[ar.idx]).invert().multiply(inst.nodeWorld[fr.idx]);
    _fm.decompose(_fc, _fq, _fs); _fy.set(0, 1, 0).applyQuaternion(_fq);
    const k = Math.min(1, 4 * dt * f.approach.get(s, t));
    if (f.field === 'gravity') { const g = f.gravity.get(s, t) * dt; for (const p of list) p.vel.addScaledVector(_fy, -g); }
    else if (f.field === 'air') { const m = f.magnitude.get(s, t); for (const p of list) { p.vel.x += (_fy.x * m - p.vel.x) * k; p.vel.y += (_fy.y * m - p.vel.y) * k; p.vel.z += (_fy.z * m - p.vel.z) * k; } }
    else if (f.field === 'turbulence') {
      const m = f.magnitude.get(s, t);
      for (const p of list) { _ft.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize().multiplyScalar(Math.random() * m); p.vel.x += (_ft.x - p.vel.x) * k; p.vel.y += (_ft.y - p.vel.y) * k; p.vel.z += (_ft.z - p.vel.z) * k; }
    } else if (f.field === 'radial') {
      const m = f.magnitude.get(s, t), inv = 1 / Math.max(0.001, f.radius.get(s, t));
      for (const p of list) {
        _ft.copy(_fc).sub(p.pos);                                     // d = c − p
        const u = Math.min(1, _ft.length() * inv), sc = (f.attenuation ? f.attenuation.get(s, u) : 1) * -m;
        p.vel.x += (_ft.x * sc - p.vel.x) * k; p.vel.y += (_ft.y * sc - p.vel.y) * k; p.vel.z += (_ft.z * sc - p.vel.z) * k;
      }
    } else if (f.field === 'collide') {
      const r = f.reflectivity.get(s, t);
      const corner = _fs.set(1, 0, 1).applyMatrix4(_fm);             // retail transforms (1, 0, 1) as the plane point
      for (const p of list) {
        const t0 = _ft.copy(p.pos).addScaledVector(_fy, 5);         // T0 = pos + 5N
        const d0 = _fv.copy(t0).sub(corner).dot(_fy); if (d0 < 0) continue;
        const v1 = _fw.copy(p.vel).multiplyScalar(dt); if (v1.dot(_fy) < 0) continue;
        const v2 = v1.addScaledVector(_fy, -5);                     // V2 = V1 − 5N
        const d1 = _fv.copy(v2).add(t0).sub(corner).dot(_fy); if (d1 > 0) continue;
        const T = d0 / (d0 - d1);
        p.pos.copy(v2).multiplyScalar(T).add(t0);
        const speed = p.vel.length(); if (!(speed > 0.001)) continue;
        const dir = _fv.copy(p.vel).divideScalar(speed), K = 2 * dir.dot(_fy);
        p.vel.copy(_fy).multiplyScalar(K).sub(dir).multiplyScalar(-speed * r);
        p.pos.addScaledVector(p.vel, -(1 - T) * dt);
      }
    } else if (f.field === 'dust') {
      const R = f.dustRadius.get(s, t), R2 = R * R; _fi.copy(_fm).invert();
      for (const p of list) {
        const l = _fv.copy(p.pos).applyMatrix4(_fi), d2 = l.lengthSq();
        if (d2 > R2) { p.age = Infinity; continue; }                 // killed (retail writes FLT_MAX to the age)
        let fade = 1; if (l.z < 0) { const band = R2 * 0.8; if (d2 > band) fade = 1 - (d2 - band) / (R2 - band); }
        p.age = (1 - (R - l.z) / (2 * R)) * fade * 10;               // the age drives the appearance curves
      }
    }
  }
}

// ------------------------------------------------------------ instance
const _m = new THREE.Matrix4(), _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _n = new THREE.Vector3(), _inv = new THREE.Matrix4();
export class FxInstance {
  constructor(effect, rm, sparam = 0, opts = {}) {
    this.effect = effect; this.sparam = sparam; this.time = 0; this.rm = rm; this.opts = opts;
    this.subs = []; // child effects of FxParticleAppearance (life effect per particle, death effect where it died)
    this.meshCache = new Map();
    this.object = new THREE.Group(); this.object.userData.fx = this; this.object.userData.noPick = true;
    this.nodeWorld = Array.from({ length: effect.nodeCount }, () => new THREE.Matrix4());
    this.emitState = effect.emitters.map(() => ({ next: 0, count: 0 }));
    this.particles = effect.appearances.map(() => []);
    this.meshes = effect.appearances.map(a => a.node.draw === 'beam' ? new BeamMesh(a.node, rm, 600) : (a.node.draw === 'mesh' || a.node.draw === 'particle') ? null : a.node.draw ? new AppearanceMesh(a.node, rm, 1200) : null);
    for (const m of this.meshes) if (m) this.object.add(m.mesh);
  }
  update(dt) {
    const s = this.sparam;
    this.time += dt;
    const t = this.time;
    // node transforms (in the effect's local space; the THREE group carries the world placement)
    const walk = (ref, parent) => {
      let m = parent;
      if (!ref.attachment && ref.node.transform && ref.node.transform.has) m = parent.clone().multiply(nodeMatrix(ref.node.transform, s, t, _m));
      this.nodeWorld[ref.idx].copy(m);
      for (const c of ref.children) walk(c, m);
    };
    for (const r of this.effect.roots) walk(r, new THREE.Matrix4());
    // fields, then age particles
    this.effect.appearances.forEach((a, i) => {
      const list = this.particles[i];
      if (a.fields && list.length) applyFields(this, a, list, dt);
      for (let j = list.length - 1; j >= 0; j--) {
        const p = list[j]; p.age += dt;
        if (p.age >= p.life) { this.emitState[p.em].count--; list.splice(j, 1); this.particleDied(a, p); }
        else p.pos.addScaledVector(p.vel, dt);
      }
    });
    // emit
    this.effect.emitters.forEach((er, ei) => {
      const e = er.node; if (!er.linked || e.lifespan < t) return;
      const ai = this.effect.appearances.indexOf(er.linked);
      const maxCount = e.maxParticles ? Math.ceil(e.maxParticles.get(s, t)) : Infinity;
      const freq = e.frequency ? e.frequency.get(s, t) : 0;
      const life = e.initLife.get(s, 0);
      if (life <= 0) return;
      const st = this.emitState[ei];
      if (freq <= 0) { st.next = 0; return; }
      const d = Math.min(dt, 3);
      st.next += d * freq;
      let toEmit = 0;
      if (st.next > 1) { toEmit = Math.min(Math.floor(st.next), maxCount); st.next -= toEmit; }
      const corr = toEmit > 1 ? d / toEmit : 0;
      // spawn transform: emitter node relative to the linked appearance node
      _inv.copy(this.nodeWorld[er.linked.idx]).invert();
      const spawn = _inv.multiply(this.nodeWorld[er.idx]);
      const list = this.particles[ai];
      for (let k = 0; k < toEmit; k++) {
        if (life < d || st.count >= maxCount || list.length >= (this.meshes[ai] ? this.meshes[ai].max : 150)) continue;
        const p = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), life, age: k * corr, em: ei };
        spawnParticle(e, s, p, spawn);
        st.count++;
        if (p.vel.lengthSq() > 0 && toEmit > 1) p.pos.addScaledVector(p.vel, p.age);
        list.push(p);
      }
    });
    this.updateChildren(dt);
  }
  dispose() {
    for (const sb of this.subs) sb.inst.dispose(); this.subs = [];
    for (const m of this.meshes) if (m) { m.mesh.geometry.dispose(); m.material.dispose(); }
  }
  // ---- FxParticleAppearance (child effects) and FxMeshAppearance (a model per particle)
  childEffect(name) { const lib = this.effect.lib; return name && lib ? lib.effects.get(aleCrc(name) >>> 0) || null : null; }
  particleDied(ar, p) {
    if (p.sub) { p.sub.dead = true; }
    if (p.mesh) { this.object.remove(p.mesh); p.mesh = null; }
    if (ar.node.draw === 'particle' && ar.node.deathName && this.subs.length < 60) {
      const ef = this.childEffect(ar.node.deathName);
      if (ef) { const inst = new FxInstance(ef, this.rm, this.sparam, this.opts); inst.object.position.copy(p.pos).applyMatrix4(this.nodeWorld[ar.idx]); this.object.add(inst.object); this.subs.push({ inst, ttl: 4 }); }
    }
  }
  updateChildren(dt) {
    this.effect.appearances.forEach((ar, i) => {
      const a = ar.node;
      if (a.draw === 'particle' && a.lifeName) {
        const ef = this.childEffect(a.lifeName); if (!ef) return;
        for (const p of this.particles[i]) if (!p.sub && this.subs.length < 60) {
          const inst = new FxInstance(ef, this.rm, this.sparam, this.opts); this.object.add(inst.object);
          p.sub = { inst, p, ar, ttl: Infinity }; this.subs.push(p.sub);
        }
      } else if (a.draw === 'mesh' && this.opts.resolveMesh) {
        if (!this.meshCache.has(a.meshName)) { this.meshCache.set(a.meshName, null); this.opts.resolveMesh(a.meshName).then(o => this.meshCache.set(a.meshName, o || false)).catch(() => this.meshCache.set(a.meshName, false)); }
        const src = this.meshCache.get(a.meshName); if (!src) return;
        for (const p of this.particles[i]) {
          if (!p.mesh) { p.mesh = src.clone(); p.mesh.userData.noPick = true; this.object.add(p.mesh); }
          p.mesh.position.copy(p.pos).applyMatrix4(this.nodeWorld[ar.idx]);
        }
      }
    });
    for (let i = this.subs.length - 1; i >= 0; i--) {
      const sb = this.subs[i];
      if (sb.p && !sb.dead) sb.inst.object.position.copy(sb.p.pos).applyMatrix4(this.nodeWorld[sb.ar.idx]);
      if (sb.dead) { sb.dead = false; sb.ttl = 2; sb.p = null; } // let a life effect's particles fade out
      sb.ttl -= dt; sb.inst.update(dt);
      if (sb.ttl <= 0) { this.object.remove(sb.inst.object); sb.inst.dispose(); this.subs.splice(i, 1); }
    }
  }
  draw(camera) {
    for (const sb of this.subs) { sb.inst.object.updateWorldMatrix(true, false); sb.inst.draw(camera); }
    const world = this.object.matrixWorld;
    this.effect.appearances.forEach((ar, i) => {
      const m = this.meshes[i]; if (!m) return;
      const a = ar.node, s = this.sparam, list = this.particles[i], A = m.a;
      const nodeTr = _m.copy(world).multiply(this.nodeWorld[ar.idx]);
      if (a.draw === 'beam') { drawBeam(this, m, a, list, nodeTr, camera); return; }
      let n = 0;
      for (const p of list) {
        const time = p.age / p.life;
        const c = a.color.get(s, time), al = a.alpha.get(s, time);
        if (al <= 0.0001) continue;
        let pos = _v.copy(p.pos), normal, hx, hy;
        if (a.draw === 'rect') {
          const l = a.length.get(s, time), w = a.width.get(s, time), sc = a.scale.get(s, time);
          const nn = _n.copy(p.vel).normalize();
          if (!a.centerOnPos) pos.addScaledVector(nn, l * sc * 0.5 * 2);
          pos.applyMatrix4(nodeTr);
          normal = nn.transformDirection(nodeTr);
          hx = l * sc; hy = w * sc;
        } else if (a.draw === 'perp') {
          const p2 = _v2.copy(p.pos).add(p.vel).applyMatrix4(nodeTr);
          pos.applyMatrix4(nodeTr);
          normal = _n.copy(pos).sub(p2).normalize();
          hx = hy = a.size.get(s, time) * 0.5;
        } else {
          pos.applyMatrix4(nodeTr);
          normal = _n.copy(p.vel).transformDirection(nodeTr).multiplyScalar(p.vel.length());
          hx = hy = a.size.get(s, time);
        }
        const frame = Math.max(0, Math.min(1, a.useCommon ? (a.commonTexFrame ? a.commonTexFrame.get(s, this.time) : 0) : (a.texFrame ? a.texFrame.get(s, time) : 0)));
        const [x, y, w, h] = frameCoords(m.pt, frame);
        const top = a.flipV ? y + h : y, bottom = a.flipV ? y : y + h, left = a.flipU ? x + w : x, right = a.flipU ? x : x + w;
        A.pos.setXYZ(n, pos.x, pos.y, pos.z);
        A.color.setXYZW(n, c[0], c[1], c[2], al);
        A.normal.setXYZ(n, normal.x, normal.y, normal.z);
        A.rot.setX(n, a.rotate ? a.rotate.get(s, time) * DEG : 0);
        A.uv.setXYZW(n, left, top, right, bottom);
        A.half.setXY(n, hx, hy);
        A.mb.setX(n, a.motionBlur ? 1 : 0);
        if (++n >= m.max) break;
      }
      m.mesh.geometry.instanceCount = n;
      for (const k in A) { A[k].needsUpdate = true; A[k].clearUpdateRanges?.(); }
    });
  }
}

const _b1 = new THREE.Vector3(), _b2 = new THREE.Vector3(), _bs = new THREE.Vector3(), _bc = new THREE.Vector3();
function drawBeam(inst, m, a, list, nodeTr, camera) {
  const s = inst.sparam, A = m.a;
  if (list.length < 2) { m.mesh.geometry.setDrawRange(0, 0); return; }
  const frame = Math.max(0, Math.min(1, a.useCommon ? (a.commonTexFrame ? a.commonTexFrame.get(s, inst.time) : 0) : (a.texFrame ? a.texFrame.get(s, list[list.length - 1].age / list[list.length - 1].life) : 0)));
  const [fx, fy, fw, fh] = frameCoords(m.pt, frame);
  const u0 = a.flipU ? fx + fw : fx, u1 = a.flipU ? fx : fx + fw, vTop = a.flipV ? fy + fh : fy, vBot = a.flipV ? fy : fy + fh;
  _bs.setFromMatrixColumn(camera.matrixWorld, 0).normalize(); _bc.setFromMatrixColumn(camera.matrixWorld, 1).normalize(); // rails A, B
  let n = 0, last = null;
  for (let i = list.length - 1; i >= 0 && n < m.max; i--) { // newest first
    const p = list[i];
    _b1.copy(p.pos).applyMatrix4(nodeTr);
    if (last && _b2.copy(_b1).sub(last).lengthSq() <= 0.01) continue;
    const time = p.age / p.life, half = a.width.get(s, time) * a.scale.get(s, time) * 0.5;
    const c = a.color.get(s, time), al = a.alpha.get(s, time), v = (n & 1) ? vBot : vTop;
    const o = n * 4;
    A.pos.setXYZ(o, _b1.x - _bs.x * half, _b1.y - _bs.y * half, _b1.z - _bs.z * half); A.uv.setXY(o, u0, v);
    A.pos.setXYZ(o + 1, _b1.x + _bs.x * half, _b1.y + _bs.y * half, _b1.z + _bs.z * half); A.uv.setXY(o + 1, u1, v);
    A.pos.setXYZ(o + 2, _b1.x - _bc.x * half, _b1.y - _bc.y * half, _b1.z - _bc.z * half); A.uv.setXY(o + 2, u0, v);
    A.pos.setXYZ(o + 3, _b1.x + _bc.x * half, _b1.y + _bc.y * half, _b1.z + _bc.z * half); A.uv.setXY(o + 3, u1, v);
    for (let k = 0; k < 4; k++) A.color.setXYZW(o + k, c[0], c[1], c[2], al);
    last = (last || new THREE.Vector3()).copy(_b1); n++;
  }
  m.mesh.geometry.setDrawRange(0, Math.max(0, n - 1) * 12);
  for (const k in A) A[k].needsUpdate = true;
}

function spawnParticle(e, s, p, spawn) {
  const identity = isIdentity(spawn);
  if (e.shape === 'cone') {
    const r = rnd(e.minR.get(s, 0), e.maxR.get(s, 0));
    const smin = e.minS.get(s, 0) * DEG, smax = e.maxS.get(s, 0) * DEG;
    // RandomInCone: rotate +Y around X by spread, then around Y by random angle
    const ang = rnd(smin, smax), rot = rnd(-Math.PI, Math.PI);
    const d = new THREE.Vector3(0, 1, 0).applyAxisAngle(new THREE.Vector3(1, 0, 0), ang).applyAxisAngle(new THREE.Vector3(0, 1, 0), rot);
    p.pos.copy(d).multiplyScalar(r);
    const n = d.clone();
    if (!identity) { p.pos.applyMatrix4(spawn); n.transformDirection(spawn); }
    p.vel.copy(n).multiplyScalar(e.pressure.get(s, 0));
  } else if (e.shape === 'sphere') {
    const r = rnd(e.minR.get(s, 0), e.maxR.get(s, 0));
    const d = new THREE.Vector3(rnd(-1, 1), rnd(-1, 1), rnd(-1, 1)).normalize();
    const n = d.clone();
    if (!identity) { d.applyMatrix4(spawn); n.transformDirection(spawn); }
    p.pos.copy(d).multiplyScalar(r);
    p.vel.copy(n).multiplyScalar(e.pressure.get(s, 0));
  } else {
    const w = e.w.get(s, 0) / 2, h = e.h.get(s, 0) / 2, dd = e.d.get(s, 0) / 2;
    p.pos.set(rnd(-w, w), rnd(-h, h), rnd(-dd, dd));
    const n = new THREE.Vector3(0, 1, 0);
    if (!identity) { p.pos.applyMatrix4(spawn); n.transformDirection(spawn); }
    p.vel.copy(n).multiplyScalar(e.pressure.get(s, 0));
  }
}
function isIdentity(m) { const e = m.elements; for (let i = 0; i < 16; i++) if (Math.abs(e[i] - (i % 5 === 0 ? 1 : 0)) > 1e-6) return false; return true; }

// ------------------------------------------------------------ manager (effect lookup by nickname chain)
export class FxManager {
  constructor(app) { this.app = app; this.libs = new Map(); this.instances = new Set(); this.shapesLoaded = null; }
  async loadShapes() {
    if (!this.shapesLoaded) this.shapesLoaded = (async () => {
      const g = this.app.game;
      for (const f of g.effectShapeFiles || []) await this.app.rm.loadUtf(dataPath(f));
    })();
    return this.shapesLoaded;
  }
  // AttachedFX/Effect nickname → FxInstance (or null)
  async create(effectNick) {
    const g = this.app.game;
    const eff = g.fxEffects.get((effectNick || '').toLowerCase());
    const vis = eff && g.visEffects.get((eff.vis || '').toLowerCase());
    if (!vis || !vis.alchemy) return null;
    await this.loadShapes();
    await Promise.all(vis.textures.map(t => this.app.rm.loadUtf(dataPath(t))));
    const key = vis.alchemy.toLowerCase();
    if (!this.libs.has(key)) this.libs.set(key, (async () => {
      const b = await this.app.rm.api.read(dataPath(vis.alchemy));
      if (!b) return null;
      try { return new FxLibrary(parseAle(b), vis.alchemy); } catch (e) { console.warn('ALE parse failed', vis.alchemy, e); return null; }
    })());
    const lib = await this.libs.get(key);
    if (!lib) return null;
    const effect = lib.find(vis.crc);
    if (!effect) return null;
    const inst = new FxInstance(effect, this.app.rm, 0, this.instanceOpts());
    for (let i = 0; i < 90; i++) inst.update(1 / 30); // pre-warm 3 s so it is visible immediately
    this.instances.add(inst);
    return inst;
  }
  // FxMeshAppearance names a mesh by nickname; the vanilla ones are asteroid archetypes (beryl_asteroid10…)
  instanceOpts() {
    const g = this.app.game, rm = this.app.rm;
    return { resolveMesh: async (name) => { const k = (name || '').toLowerCase(); const a = (g.asteroids && g.asteroids.get(k)) || g.arch(name); return a && a.da ? rm.model(dataPath(a.da), (a.matLibs || []).map(dataPath)) : null; } };
  }
  frame(dt, camera) {
    for (const inst of this.instances) {
      if (!inst.object.parent) { this.instances.delete(inst); continue; } // removed from scene
      let vis = true; for (let o = inst.object; o; o = o.parent) if (!o.visible) { vis = false; break; }
      if (!vis) continue;
      inst.update(dt);
      inst.object.updateWorldMatrix(true, false);
      inst.draw(camera);
    }
  }
}
