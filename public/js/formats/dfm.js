// Freelancer characters: deformable meshes (.dfm), skeletons and their animations (.anm).
// .dfm characters: meshes, skinning, bones and skeletons.
// Row-vector maths (System.Numerics style) is written here as THREE's
// column-vector form (row-vector A·B = "A then B" = B·A here).
//   Bone to root (12 floats) = T(−t) then Rᵀ        · bone local = T(origin + translation) · R(rotation ∘ originalRotation) in parent space
//   bone matrix = local · inverse(bone to root)       · vertices are skinned with up to 4 bones (Bone_id_chain / Bone_weight_chain)
//   head / hands hang on the body through hardpoints: hp_neck/hp_head, hp_left a/b, hp_right a/b (DfmSkeletonManager.Connection)
import * as THREE from 'three';
import { dacomCrc } from './crc.js';
import { rotFromFl } from './model.js';
import { parseAnimation, sampleQuat, samplePos } from './anim.js';

const lc = (s) => String(s || '').toLowerCase();
const leafOf = (n, name) => (n.children || []).find(c => lc(c.name) === lc(name));
const i32 = (leaf) => leaf ? new Int32Array(leaf.data.slice().buffer) : null;
const f32 = (leaf) => leaf ? new Float32Array(leaf.data.slice().buffer, 0, leaf.data.byteLength >> 2) : null;
const u16 = (leaf) => leaf ? new Uint16Array(leaf.data.slice().buffer, 0, leaf.data.byteLength >> 1) : null;
const str = (leaf) => { if (!leaf) return ''; let s = ''; for (const b of leaf.data) { if (!b) break; s += String.fromCharCode(b); } return s; };

function hpTransform(node) {
  const p = f32(leafOf(node, 'Position')), o = f32(leafOf(node, 'Orientation'));
  const m = o && o.length >= 9 ? rotFromFl(o) : new THREE.Matrix4();
  if (p) m.setPosition(p[0], p[1], p[2]);
  return m;
}
function readCons(leaf, kind) {
  const out = []; const u8 = leaf.data, dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const stride = kind === 'sphere' ? 212 : 176;
  const name = (o) => { let s = ''; for (let i = 0; i < 64 && u8[o + i]; i++) s += String.fromCharCode(u8[o + i]); return s; };
  for (let o = 0; o + stride <= u8.length; o += stride) {
    const f = (i) => dv.getFloat32(o + 128 + i * 4, true);
    const origin = [f(0), f(1), f(2)];
    const rot = kind === 'sphere' ? [f(6), f(7), f(8), f(9), f(10), f(11), f(12), f(13), f(14)] : [f(3), f(4), f(5), f(6), f(7), f(8), f(9), f(10), f(11)];
    out.push({ parent: name(o), child: name(o + 64), origin, rot });
  }
  return out;
}

// UTF root of a .dfm → { mesh (level 0), parts: Map(index → { name, boneToRoot, hardpoints }), cons, scale }
export function parseDfm(root) {
  const bones = new Map(), parts = new Map(); let cons = [], mesh = null, scale = 1;
  for (const n of root.children || []) {
    const nm = lc(n.name);
    if (nm === 'multilevel') {
      const m0 = (n.children || []).find(c => lc(c.name) === 'mesh0'); if (!m0) continue;
      const geo = leafOf(m0, 'Geometry'), fg = leafOf(m0, 'Face_groups');
      mesh = {
        pointIdx: i32(leafOf(geo, 'Point_indices')), uv0Idx: i32(leafOf(geo, 'UV0_indices')),
        points: f32(leafOf(geo, 'Points')), normals: f32(leafOf(geo, 'Vertex_normals')), uv0: f32(leafOf(geo, 'UV0')),
        boneFirst: i32(leafOf(geo, 'Point_bone_first')), boneCount: i32(leafOf(geo, 'Point_bone_count')),
        boneIds: i32(leafOf(geo, 'Bone_id_chain')), weights: f32(leafOf(geo, 'Bone_weight_chain')),
        groups: (fg ? fg.children : []).filter(g => /^group/i.test(g.name)).map(g => ({ material: str(leafOf(g, 'Material_name')), strip: u16(leafOf(g, 'Tristrip_indices')), faces: u16(leafOf(g, 'Face_indices')) })),
      };
    } else if (nm === 'cmpnd') {
      for (const c of n.children || []) {
        const cn = lc(c.name);
        if (cn === 'scale' && c.data) scale = f32(c)[0];
        else if (cn === 'cons') for (const l of c.children || []) { const k = lc(l.name); if (k === 'sphere' || k === 'loose') cons = cons.concat(readCons(l, k)); }
        else if (cn === 'root' || cn.startsWith('part_')) {
          const idx = new DataView(leafOf(c, 'Index').data.buffer, leafOf(c, 'Index').data.byteOffset, 4).getInt32(0, true);
          parts.set(idx, { name: str(leafOf(c, 'Object name')), file: str(leafOf(c, 'File name')) });
        }
      }
    } else if (nm.endsWith('.3db')) {
      const btr = f32(leafOf(n, 'Bone to root'));
      let m = new THREE.Matrix4();
      if (btr && btr.length >= 12) m = rotFromFl(btr).transpose().multiply(new THREE.Matrix4().makeTranslation(-btr[9], -btr[10], -btr[11]));
      const hps = [];
      const hp = leafOf(n, 'Hardpoints');
      if (hp) for (const k of hp.children || []) for (const h of k.children || []) if (!h.isLeaf) hps.push({ name: h.name, m: hpTransform(h) });
      bones.set(lc(n.name), { boneToRoot: m, hardpoints: hps });
    }
  }
  for (const p of parts.values()) { const b = bones.get(lc(p.file)); p.boneToRoot = b ? b.boneToRoot : new THREE.Matrix4(); p.hardpoints = b ? b.hardpoints : []; }
  return { mesh, parts, cons, scale };
}

// ---------- skeleton (DfmSkinning + BoneInstance) ----------
class Skin {
  constructor(dfm) {
    this.dfm = dfm; this.bones = new Map(); this.instances = [];
    for (const [idx, p] of dfm.parts) {
      const b = { name: p.name, index: idx, invBind: p.boneToRoot.clone().invert(), local: p.boneToRoot.clone(), matrix: new THREE.Matrix4(), origRot: new THREE.Quaternion(), origin: new THREE.Vector3(), rot: new THREE.Quaternion(), tr: new THREE.Vector3(), parent: null, children: [], hardpoints: p.hardpoints };
      this.instances[idx] = b; this.bones.set(lc(p.name), b);
    }
    for (const c of dfm.cons) {
      const b = this.bones.get(lc(c.child)); if (!b) continue;
      if (c.parent) { const p = this.bones.get(lc(c.parent)); if (p) { p.children.push(b); b.parent = p; } }
      b.origRot.setFromRotationMatrix(rotFromFl(c.rot)); b.origin.fromArray(c.origin);
    }
    this.roots = [...this.bones.values()].filter(b => !b.parent);
  }
  update() {
    const upd = (b, parent) => {
      const q = b.rot.clone().multiply(b.origRot);
      b.local.compose(b.origin.clone().add(b.tr), q, new THREE.Vector3(1, 1, 1)); if (parent) b.local.premultiply(parent);
      b.matrix.multiplyMatrices(b.local, b.invBind);
      for (const c of b.children) upd(c, b.local);
    };
    for (const r of this.roots) upd(r, null);
  }
  hardpoint(name) {
    for (const b of this.bones.values()) for (const h of b.hardpoints) if (lc(h.name) === lc(name)) return { bone: b, m: h.m };
    return null;
  }
}
const boneTransform = (hp) => hp ? hp.bone.local.clone().multiply(hp.m) : new THREE.Matrix4();
class Connection {
  constructor(parent, child, parentHp, childHp, connHp) {
    this.p = parent.hardpoint(parentHp); this.c = child.hardpoint(childHp); this.k = parent.hardpoint(connHp);
    this.calc();
    this.invBind = new THREE.Matrix4().copy(this.transform).invert().multiply(boneTransform(this.k)).invert();
    this.calcBone();
  }
  calc() { this.transform = boneTransform(this.p).multiply(boneTransform(this.c).invert()); }
  calcBone() { this.bone = this.transform.clone().invert().multiply(boneTransform(this.k)).multiply(this.invBind); }
  update() { this.calc(); this.calcBone(); }
}

// one deformable mesh → THREE.SkinnedMesh driven by a Skin
function buildMesh(rm, dfm, skin, connection) {
  const M = dfm.mesh; if (!M) return null;
  const n = M.pointIdx.length;
  const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), uv = new Float32Array(n * 2), si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const p = M.pointIdx[i], u = M.uv0Idx ? M.uv0Idx[i] : p;
    pos.set([M.points[p * 3], M.points[p * 3 + 1], M.points[p * 3 + 2]], i * 3);
    if (M.normals) nrm.set([M.normals[p * 3], M.normals[p * 3 + 1], M.normals[p * 3 + 2]], i * 3);
    if (M.uv0) uv.set([M.uv0[u * 2], M.uv0[u * 2 + 1]], i * 2);
    const first = M.boneFirst[p], count = Math.min(4, M.boneCount[p]);
    if (!count) { sw[i * 4] = 1; continue; }
    for (let k = 0; k < count; k++) { si[i * 4 + k] = M.boneIds[first + k]; sw[i * 4 + k] = M.weights ? M.weights[first + k] : (k === 0 ? 1 : 0); }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  const idx = [], mats = [];
  M.groups.forEach((g, gi) => {
    const start = idx.length;
    if (g.faces) idx.push(...g.faces);
    else if (g.strip) for (let i = 0; i + 2 < g.strip.length; i++) { const a = g.strip[i], b = g.strip[i + 1], c = g.strip[i + 2]; if (a === b || b === c || a === c) continue; if (i & 1) idx.push(b, a, c); else idx.push(a, b, c); }
    geo.addGroup(start, idx.length - start, gi);
    const m = rm.material(dacomCrc(g.material), {}).clone(); m.side = THREE.DoubleSide; mats.push(m);
  });
  geo.setIndex(idx);
  if (!M.normals) geo.computeVertexNormals();
  // bones: one THREE.Bone per part index; their matrixWorld is set directly from the skin every frame
  const count = Math.max(1, skin.instances.length);
  const bones = []; for (let i = 0; i < count; i++) { const b = new THREE.Bone(); b.matrixAutoUpdate = false; b.matrixWorldAutoUpdate = false; bones.push(b); }
  const skeleton = new THREE.Skeleton(bones, bones.map(() => new THREE.Matrix4()));
  const mesh = new THREE.SkinnedMesh(geo, mats);
  mesh.bindMode = THREE.DetachedBindMode; mesh.bind(skeleton, new THREE.Matrix4());
  mesh.frustumCulled = false;
  mesh.userData.sync = () => {
    for (let i = 0; i < count; i++) { const b = skin.instances[i]; bones[i].matrixWorld.copy(b ? b.matrix : connection ? connection.bone : new THREE.Matrix4()); }
  };
  return mesh;
}

// ---------- characters ----------
export class Character {
  constructor(rm, parts) {
    this.object = new THREE.Group(); this.object.name = 'character';
    this.scripts = [];
    const add = (dfm, conn, skin) => { const m = buildMesh(rm, dfm, skin, conn); if (!m) return null; const holder = new THREE.Group(); holder.matrixAutoUpdate = false; holder.add(m); this.object.add(holder); return { mesh: m, holder, conn }; };
    this.body = new Skin(parts.body);
    this.parts = [{ skin: this.body, ...add(parts.body, null, this.body) }];
    const link = (dfm, a, b, c) => { if (!dfm) return; const s = new Skin(dfm); const conn = new Connection(this.body, s, a, b, c); this.parts.push({ skin: s, ...add(dfm, conn, s) }); };
    link(parts.head, 'hp_head', 'hp_head', 'hp_neck');
    link(parts.leftHand, 'hp_left b', 'hp_left b', 'hp_left a');
    link(parts.rightHand, 'hp_right b', 'hp_right b', 'hp_right a');
    this.update(0);
  }
  // play an .anm script (DfmSkeletonManager.StartScript). Scripts are layered in start order: each one
  // blends over the pose below it with its weight, which ramps up over blendIn seconds (skipped when the
  // character is still in its rest pose) and down over blendOut before a timed script ends. A script that
  // reaches full weight replaces older scripts whose bones it covers completely.
  // rootHeight (anm "Root height") = height of the body origin (hips) above the floor for this animation;
  // the "Root" object map moves the whole character (root motion, read by rootMotion()).
  start(script, { startTime = 0, timeScale = 1, duration = 0, loop = false, blendIn = 0.3, blendOut = 0.3 } = {}) {
    const joints = [];
    for (const j of script.joints) for (const p of this.parts) { const b = p.skin.bones.get(lc(j.child)); if (b) { joints.push({ b, ch: j.ch }); break; } }
    if (script.rootHeight != null) this.rootHeight = script.rootHeight;
    const root = script.objects.find(o => lc(o.parent) === 'root') || null;
    const atRest = !this.scripts.length && !this.moved;
    const inst = { script, t: 0, startTime, timeScale, duration, loop, joints, root, blendIn: atRest ? 0 : blendIn, blendOut: !loop && duration > 0 ? Math.min(blendOut, duration / 2) : 0 };
    this.scripts.push(inst);
    if (root) this.rootInst = inst;
    this.moved = true;
    return inst;
  }
  weight(s) {
    let w = 1;
    if (s.blendIn > 0 && s.t < s.blendIn) w = s.t / s.blendIn;
    if (s.blendOut > 0 && s.t > s.duration - s.blendOut) w = Math.min(w, (s.duration - s.t) / s.blendOut);
    return Math.max(0, Math.min(1, w));
  }
  // back to the bind pose, then the gender's base pose (the bind pose lies on its back)
  stopAll() {
    this.scripts = []; this.rootInst = null;
    for (const p of this.parts) for (const b of p.skin.bones.values()) { b.rot.identity(); b.tr.set(0, 0, 0); }
    if (this.basePose) { this.start(this.basePose); this.scripts[0].blendIn = 0; this.pose(); this.scripts = []; this.rootInst = null; }
    for (const p of this.parts) for (const b of p.skin.bones.values()) { b.held = { rot: b.rot.clone(), tr: b.tr.clone() }; }
    this.rootHeight = this.basePose && this.basePose.rootHeight != null ? this.basePose.rootHeight : 0;
    this.moved = false;
  }
  update(dt) { this.advance(dt); this.pose(); }
  // time only (cheap); pose() applies the channels and skins
  advance(dt) {
    for (const s of this.scripts) s.t += dt;
    this.dirty = true;
  }
  pose() {
    const touched = new Set(), done = [];
    for (const s of this.scripts) for (const j of s.joints) touched.add(j.b);
    for (const b of touched) { if (!b.held) b.held = { rot: b.rot.clone(), tr: b.tr.clone() }; b.rot.copy(b.held.rot); b.tr.copy(b.held.tr); }
    for (const s of this.scripts) {
      const ft = s.t * s.timeScale + s.startTime, w = this.weight(s);
      let running = false;
      for (const j of s.joints) {
        const d = j.ch.duration; let t = ft; if (s.loop && d > 0 && t > d) t %= d;
        if (w > 0) {
          if (j.ch.type & 0xC4) { const q = sampleQuat(j.ch, Math.min(t, d)); if (w >= 1) j.b.rot.copy(q); else j.b.rot.slerp(q, w); }
          if (j.ch.type & 0x02) { const v = samplePos(j.ch, Math.min(t, d)); if (w >= 1) j.b.tr.copy(v); else j.b.tr.lerp(v, w); }
        }
        if (ft < d || s.loop) running = true;
      }
      if (s.duration > 0 ? s.t >= s.duration : !running) done.push(s);
    }
    // a fully blended-in script supersedes older ones it covers completely
    for (let i = this.scripts.length - 1; i > 0; i--) {
      const s = this.scripts[i]; if (this.weight(s) < 1 || done.includes(s)) continue;
      const mine = new Set(s.joints.map(j => j.b));
      for (const o of this.scripts.slice(0, i)) if (!done.includes(o) && o.joints.every(j => mine.has(j.b))) done.push(o);
    }
    if (done.length) {
      // bones keep the pose they have now once nothing animates them (no snap back)
      this.scripts = this.scripts.filter(s => !done.includes(s));
      for (const s of done) for (const j of s.joints) j.b.held = { rot: j.b.rot.clone(), tr: j.b.tr.clone() };
      if (done.includes(this.rootInst)) this.rootInst = null;
    }
    for (const p of this.parts) p.skin.update();
    for (const p of this.parts) {
      if (p.conn) { p.conn.update(); p.holder.matrix.copy(p.conn.transform); }
      if (p.mesh) p.mesh.userData.sync();
      p.holder.matrixWorldNeedsUpdate = true;
    }
    if (this.accessory) { // DfmSkeletonManager.GetAccessoryTransform
      const a = this.accessory, hp = this.hardpoint(a.def.bodyHp || a.def.hp);
      const src = (a.model.userData.hardpoints || []).find(h => lc(h.name) === lc(a.def.hp));
      if (hp && src) { const sm = src.rot ? rotFromFl(src.rot) : new THREE.Matrix4(); sm.setPosition(src.pos); a.model.matrix.copy(hp).multiply(sm.invert()); a.model.matrixWorldNeedsUpdate = true; }
    }
  }
  // root motion of the newest script with a "Root" object map, from its start to now:
  // { inst, tr (in the character's frame at script start), rot } — loops accumulate whole cycles
  // (DfmSkeletonManager.EvaluateRoot). null when no such script runs.
  rootMotion() {
    const s = this.rootInst; if (!s || !s.root || !s.root.ch) return null;
    const ch = s.root.ch, ft = s.t * s.timeScale + s.startTime, f0 = s.startTime;
    const at = (t) => {
      const tr = new THREE.Vector3(), rot = new THREE.Quaternion(); let ct = t;
      if (s.loop && ch.duration > 0) {
        const one = ch.type & 0x02 ? samplePos(ch, ch.duration) : new THREE.Vector3(), q1 = ch.type & 0xC4 ? sampleQuat(ch, ch.duration) : new THREE.Quaternion();
        let n = 0; while (ct > ch.duration && n++ < 10000) { tr.add(one.clone().applyQuaternion(rot)); rot.multiply(q1); ct -= ch.duration; }
      }
      if (ch.type & 0x02) tr.add(samplePos(ch, Math.min(ct, ch.duration)).applyQuaternion(rot));
      if (ch.type & 0xC4) rot.multiply(sampleQuat(ch, Math.min(ct, ch.duration)));
      return { tr, rot };
    };
    const a = at(f0), b = at(ft), inv = a.rot.clone().invert();
    return { inst: s, tr: b.tr.sub(a.tr).applyQuaternion(inv), rot: inv.multiply(b.rot) };
  }
  hardpoint(name) {
    for (const p of this.parts) { const h = p.skin.hardpoint(name); if (h) { const m = boneTransform(h); if (p.conn) m.premultiply(p.conn.transform); return m; } }
    return null;
  }
}

// ---------- game data: bodyparts.ini / costumes.ini and the animation library ----------
export async function characterData(app, loadIni, dataPath) {
  if (app._chars) return app._chars;
  const busy = (fn) => app.whileBusy ? app.whileBusy(fn) : fn(); // pause the 3D view: hundreds of reads
  app._chars = busy(async () => {
    const parts = new Map(), costumes = new Map(), accessories = new Map(), anims = [];
    const bp = await loadIni(dataPath('characters\\bodyparts.ini'));
    if (bp) {
      let sex = 'male';
      for (const s of bp.sections) {
        if (s.is('Skeleton')) sex = lc(s.get('sex'));
        else if (s.is('Animations')) anims.push(...s.getAll('anim'));
        else if (/^(body|head|lefthand|righthand)$/i.test(s.name)) { const n = s.get('nickname'); if (n) parts.set(lc(n), { kind: lc(s.name), mesh: s.get('mesh'), sex }); }
        else if (s.is('Accessory')) { const n = s.get('nickname'); if (n) accessories.set(lc(n), { mesh: s.get('mesh'), hp: s.get('hardpoint'), bodyHp: s.get('body_hardpoint') }); }
      }
    }
    const cs = await loadIni(dataPath('characters\\costumes.ini'));
    if (cs) for (const s of cs.all('Costume')) { const n = s.get('nickname'); if (n) costumes.set(lc(n), { nickname: n, body: s.get('body'), head: s.get('head'), leftHand: s.get('lefthand'), rightHand: s.get('righthand'), accessory: s.get('accessory') }); }
    const scripts = new Map();
    const animFiles = [...new Set(anims.map(lc))], roots = await Promise.all(animFiles.map(f => app.rm.loadUtf(dataPath(f))));
    for (const root of roots) {
      if (!root) continue;
      const anim = root.child('Animation');
      for (const s of parseAnimation(anim)) if (!scripts.has(lc(s.name))) scripts.set(lc(s.name), s);
    }
    return { parts, costumes, accessories, scripts };
  });
  app._chars.catch(() => { app._chars = null; });
  return app._chars;
}
export async function loadCharacter(app, data, { body, head, leftHand, rightHand, accessory }, dataPath) {
  const load = async (nick) => { const p = nick && data.parts.get(lc(nick)); if (!p || !p.mesh) return null; const r = await app.rm.loadUtf(dataPath(p.mesh)); return r ? parseDfm(r) : null; };
  const b = await load(body); if (!b || !b.mesh) return null;
  const ch = new Character(app.rm, { body: b, head: await load(head), leftHand: await load(leftHand), rightHand: await load(rightHand) });
  const sex = (data.parts.get(lc(body)) || {}).sex || 'male';
  ch.sex = sex;
  const pre = sex === 'female' ? 'FMBODY' : 'MLBODY';
  ch.basePose = [...data.scripts.values()].find(s => s.name.toUpperCase().includes(pre + '_BASEPOSE')) || [...data.scripts.values()].find(s => s.name.toUpperCase().includes(pre));
  ch.stopAll();
  if (accessory) {
    const a = data.accessories.get(lc(accessory));
    if (a && a.mesh) { const m = await app.rm.model(dataPath(a.mesh)); if (m) { ch.accessory = { model: m, def: a }; ch.object.add(m); m.matrixAutoUpdate = false; } }
  }
  return ch;
}
export async function loadCostume(app, data, costumeNick, dataPath) {
  const c = data.costumes.get(lc(costumeNick)); if (!c) return null;
  return loadCharacter(app, data, c, dataPath);
}
