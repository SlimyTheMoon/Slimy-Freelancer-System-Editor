// Freelancer compound animations (the "Animation/Script" node of .cmp files and .anm files).
// Channel layout and construct maths (channels, revolute,
// prismatic and sphere constructs):
//   Header = frameCount:int32, interval:float (<0 → each frame starts with its own time), type:uint32
//   type bits: 0x1 angle (float) · 0x2 position (vec3) · 0x4 full quaternion (w,x,y,z floats)
//              0x40 / 0x80 compressed quaternion (3 × int16) · 0x10 / 0x20 empty vector / quaternion
//   rev  joint: T(origin) · axisAngle(angle) · R · T(−offset)
//   pris joint: T(origin + offset + axis·d) · R
//   sphere    : T(origin) · q · R · T(−offset)
import * as THREE from 'three';
import { readCString } from './utf.js';

const lc = (s) => String(s || '').toLowerCase();

function parseChannel(node) {
  const hd = node.child('Header'), fr = node.child('Frames');
  if (!hd || hd.data.byteLength < 12) return null;
  const hv = new DataView(hd.data.buffer, hd.data.byteOffset, 12);
  const count = hv.getInt32(0, true), interval = hv.getFloat32(4, true), type = hv.getUint32(8, true) & 0xFF;
  let stride = interval < 0 ? 4 : 0;
  if (type & 0x1) stride += 4;
  if (type & 0x2) stride += 12;
  if (type & 0x40) stride += 6;
  if (type & 0x80) stride += 6;
  if (type & 0x4) stride += 16;
  const data = fr ? new DataView(fr.data.buffer, fr.data.byteOffset, fr.data.byteLength) : new DataView(new ArrayBuffer(0));
  const ch = { count: Math.min(count, stride ? Math.floor(data.byteLength / stride) : count), interval, type, stride, data };
  ch.duration = ch.count <= 0 ? 0 : interval < 0 ? time(ch, ch.count - 1) : Math.max(0, interval * (ch.count - 1));
  return ch;
}
function time(ch, i) { return ch.interval >= 0 ? i * ch.interval : ch.data.getFloat32(i * ch.stride, true); }
function angle(ch, i) { return ch.type & 1 ? ch.data.getFloat32(i * ch.stride + (ch.interval < 0 ? 4 : 0), true) : 0; }
function position(ch, i) {
  if (!(ch.type & 2)) return new THREE.Vector3();
  const o = i * ch.stride + (ch.interval < 0 ? 4 : 0);
  return new THREE.Vector3(ch.data.getFloat32(o, true), ch.data.getFloat32(o + 4, true), ch.data.getFloat32(o + 8, true));
}
function quat(ch, i) {
  const o = i * ch.stride + (ch.interval < 0 ? 4 : 0) + (ch.type & 2 ? 12 : 0), d = ch.data;
  if (ch.type & 0x4) return new THREE.Quaternion(d.getFloat32(o + 4, true), d.getFloat32(o + 8, true), d.getFloat32(o + 12, true), d.getFloat32(o, true));
  if (ch.type & 0xC0) {
    const v = new THREE.Vector3(d.getInt16(o, true) / 32767, d.getInt16(o + 2, true) / 32767, d.getInt16(o + 4, true) / 32767);
    if (ch.type & 0x40) { const l = v.lengthSq(); return new THREE.Quaternion(v.x, v.y, v.z, l < 1 ? Math.sqrt(1 - l) : 0); }
    const s = v.lengthSq(); if (s <= 0) return new THREE.Quaternion();
    const len = Math.sqrt(s), sn = Math.sin(Math.PI * len * 0.5);
    v.multiplyScalar(sn / len); return new THREE.Quaternion(v.x, v.y, v.z, Math.sqrt(Math.max(0, 1 - sn * sn)));
  }
  return new THREE.Quaternion();
}
// index of the frame at or before t, plus blend weight to the next frame
function locate(ch, t) {
  if (ch.count <= 1) return [0, 0];
  if (ch.interval >= 0) {
    const i = Math.max(0, Math.min(ch.count - 1, Math.floor(t / (ch.interval || 1))));
    if (i >= ch.count - 1) return [ch.count - 1, 0];
    return [i, Math.max(0, Math.min(1, (t - i * ch.interval) / (ch.interval || 1)))];
  }
  let lo = 0, hi = ch.count - 1;
  if (t <= time(ch, 0)) return [0, 0];
  if (t >= time(ch, hi)) return [hi, 0];
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (time(ch, m) <= t) lo = m; else hi = m; }
  const t0 = time(ch, lo), t1 = time(ch, lo + 1);
  return [lo, t1 > t0 ? (t - t0) / (t1 - t0) : 0];
}
export function sampleAngle(ch, t) { const [i, w] = locate(ch, t); if (i >= ch.count - 1 || !w) return angle(ch, i); return angle(ch, i) + (angle(ch, i + 1) - angle(ch, i)) * w; }
export function sampleQuat(ch, t) { const [i, w] = locate(ch, t); if (i >= ch.count - 1 || !w) return quat(ch, i); return quat(ch, i).slerp(quat(ch, i + 1), w); }
export function samplePos(ch, t) { const [i, w] = locate(ch, t); if (i >= ch.count - 1 || !w) return position(ch, i); return position(ch, i).lerp(position(ch, i + 1), w); }

function parseMap(node) {
  const m = { parent: '', child: '', ch: null };
  for (const c of node.children || []) {
    const n = lc(c.name);
    if (n === 'parent name') m.parent = readCString(c.data, 0, c.data.byteLength);
    else if (n === 'child name') m.child = readCString(c.data, 0, c.data.byteLength);
    else if (n === 'channel' && !c.isLeaf) m.ch = parseChannel(c);
  }
  return m;
}

// UTF node "Animation" (or an .anm root) → [{ name, joints, objects, duration, rootHeight }]
export function parseAnimation(anim) {
  const out = [];
  if (!anim) return out;
  const script = (anim.children || []).find(c => lc(c.name) === 'script') || (lc(anim.name) === 'script' ? anim : null);
  if (!script) return out;
  for (const sc of script.children || []) {
    if (sc.isLeaf) continue;
    const s = { name: sc.name, joints: [], objects: [], duration: 0, rootHeight: null };
    for (const c of sc.children || []) {
      const n = lc(c.name);
      if (n.startsWith('joint map')) { const m = parseMap(c); if (m.ch) s.joints.push(m); }
      else if (n.startsWith('object map')) { const m = parseMap(c); if (m.ch) s.objects.push(m); }
      else if (n === 'root height' && c.data && c.data.byteLength >= 4) s.rootHeight = new DataView(c.data.buffer, c.data.byteOffset, 4).getFloat32(0, true);
    }
    for (const m of [...s.joints, ...s.objects]) s.duration = Math.max(s.duration, m.ch.duration);
    out.push(s);
  }
  return out;
}

// --------- posing a loaded model (formats/model.js keeps construct data in part.userData.cons) ---------
const _q = new THREE.Quaternion(), _m = new THREE.Matrix4(), _axis = new THREE.Vector3();
function partsByName(model) {
  if (model.userData._parts) return model.userData._parts;
  const map = new Map();
  model.traverse(o => { if (o.userData && o.userData.cons) map.set(lc(o.name), o); });
  model.userData._parts = map;
  return map;
}
export function poseJoint(o, ang = 0, q = null) {
  const c = o.userData.cons; if (!c) return;
  const R = new THREE.Matrix4().set(c.rot[0], c.rot[1], c.rot[2], 0, c.rot[3], c.rot[4], c.rot[5], 0, c.rot[6], c.rot[7], c.rot[8], 0, 0, 0, 0, 1);
  const m = new THREE.Matrix4();
  if (c.kind === 'rev') {
    const a = Math.max(Math.min(c.min, c.max), Math.min(Math.max(c.min, c.max), ang));
    _axis.fromArray(c.axis); if (_axis.lengthSq() < 1e-8) _axis.set(0, 1, 0); _axis.normalize();
    m.makeTranslation(c.origin[0], c.origin[1], c.origin[2]).multiply(_m.makeRotationAxis(_axis, a)).multiply(R).multiply(new THREE.Matrix4().makeTranslation(-c.offset[0], -c.offset[1], -c.offset[2]));
  } else if (c.kind === 'pris') {
    const d = Math.max(Math.min(c.min, c.max), Math.min(Math.max(c.min, c.max), ang));
    m.makeTranslation(c.origin[0] + c.offset[0] + c.axis[0] * d, c.origin[1] + c.offset[1] + c.axis[1] * d, c.origin[2] + c.offset[2] + c.axis[2] * d).multiply(R);
  } else if (c.kind === 'sphere') {
    m.makeTranslation(c.origin[0], c.origin[1], c.origin[2]).multiply(_m.makeRotationFromQuaternion(q || _q.identity())).multiply(R).multiply(new THREE.Matrix4().makeTranslation(-c.offset[0], -c.offset[1], -c.offset[2]));
  } else return;
  o.matrix.copy(m); o.matrixWorldNeedsUpdate = true;
}
// Pose the model at time t of a script. Returns the number of joints that were driven.
export function applyScript(model, script, t) {
  const parts = partsByName(model); let n = 0;
  for (const j of script.joints) {
    const o = parts.get(lc(j.child)); if (!o) continue;
    const tt = Math.min(t, j.ch.duration);
    poseJoint(o, j.ch.type & 1 ? sampleAngle(j.ch, tt) : 0, j.ch.type & 0xC4 ? sampleQuat(j.ch, tt) : null);
    n++;
  }
  return n;
}
export function resetPose(model) {
  for (const o of partsByName(model).values()) { const r = o.userData.cons.rest; if (r) { o.matrix.fromArray(r); o.matrixWorldNeedsUpdate = true; } }
}
export function movableParts(model) { return [...partsByName(model).values()].filter(o => /^(rev|pris|sphere)$/.test(o.userData.cons.kind)); }
