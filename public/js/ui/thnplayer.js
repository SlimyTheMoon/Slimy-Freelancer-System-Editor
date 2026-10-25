// Cutscene (.thn) player and script editor.
// Scripts are run with formats/thorn.js (compiled Lua 3.2 or text); the scene follows the game's
// Thn runtime (script, instance, events):
//   entities: COMPOUND (solar / ship / prop / room / equipment cart / equipment / asteroid models), CAMERA,
//             MARKER, LIGHT, MOTION_PATH, PSYS (ALE effects), SOUND, DEFORMABLE (characters, shown as stand-ins)
//   events:   SET_CAMERA, START_SPATIAL_PROP_ANIM, START_PATH_ANIMATION, ATTACH_ENTITY, START_MOTION,
//             START_CAMERA_PROP_ANIM, START_LIGHT_PROP_ANIM, START_PSYS, START_SOUND, CONNECT_HARDPOINTS …
// Time is simulated in fixed 1/60 s steps from 0, so seeking backwards replays the scene exactly.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { TransformControls } from 'three/addons/TransformControls.js';
import { h, modal, toast } from './dom.js';
import { api, dataPath } from '../api.js';
import { runThorn, globalsToLua, LuaTable, LuaEnum, enumName, THN_ENV } from '../formats/thorn.js';
import { confirmDialog } from './dom.js';
import { applyScript } from '../formats/anim.js';
import { loadIni } from '../gamedata.js';
import { soundBytes, decodeFlWav, playOverlay, dbToGain } from '../formats/audio.js';
import { characterData, loadCostume } from '../formats/dfm.js';

const STEP = 1 / 60;
const lc = (s) => String(s || '').toLowerCase();
const N = (v, d = 0) => v == null ? d : (v instanceof LuaEnum ? v.value : typeof v === 'boolean' ? (v ? 1 : 0) : (+v || 0));
const tget = (t, k) => t instanceof LuaTable ? t.get(k) : undefined;
const vec3 = (t, d = null) => t instanceof LuaTable && t.length >= 3 ? new THREE.Vector3(N(t.get(1)), N(t.get(2)), N(t.get(3))) : d;
const quatWXYZ = (t) => t instanceof LuaTable && t.length >= 4 ? new THREE.Quaternion(N(t.get(2)), N(t.get(3)), N(t.get(4)), N(t.get(1))).normalize() : null;
// orient = { {m11,m12,m13}, {m21,…}, {m31,…} } rows of a row-vector matrix → THREE takes the transpose
function orientQuat(t) {
  if (!(t instanceof LuaTable) || t.length < 3) return null;
  const r = [1, 2, 3].map(i => t.get(i));
  if (!r.every(x => x instanceof LuaTable)) return null;
  const m = new THREE.Matrix4().set(N(r[0].get(1)), N(r[1].get(1)), N(r[2].get(1)), 0, N(r[0].get(2)), N(r[1].get(2)), N(r[2].get(2)), 0, N(r[0].get(3)), N(r[1].get(3)), N(r[2].get(3)), 0, 0, 0, 0, 1);
  return new THREE.Quaternion().setFromRotationMatrix(m);
}
const AXES = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, -1)];

// ---------------- parameter curves (ParameterCurve.cs) ----------------
const ease = (kind, x, x0, x1, y0, y1) => {
  const d = x1 - x0; let t = d > 0 ? (x - x0) / d : 1; t = Math.max(0, Math.min(1, t));
  if (kind === 'in') t = t * t; else if (kind === 'out') t = t * (2 - t); else if (kind === 'inout') t = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
  return y0 + (y1 - y0) * t;
};
function curveFrom(props) {
  const pc = tget(props, 'param_curve'); if (!(pc instanceof LuaTable)) return null;
  const cls = lc(tget(pc, 'CLSID')); const pts = [];
  const P = tget(pc, 'points'); if (P instanceof LuaTable) for (const p of P.arr) if (p instanceof LuaTable) pts.push([N(p.get(1)), N(p.get(2)), N(p.get(3)), N(p.get(4))]);
  return { cls, pts, period: N(tget(props, 'pcurve_period')) };
}
function curveValue(c, time, duration) {
  const p = c.period / 1000; const x = p < 1e-6 ? time / duration : (time % p) / p;
  let a = [0, 0, 0, 0], b = [1, 1, 0, 0];
  if (c.pts.length >= 2) {
    if (x <= 0) return c.pts[0][1];
    if (x >= 1) return c.pts[c.pts.length - 1][1];
    for (let i = 0; i < c.pts.length - 1; i++) if (x >= c.pts[i][0] && x <= c.pts[i + 1][0]) { a = c.pts[i]; b = c.pts[i + 1]; }
  }
  if (c.cls === 'freeformpcurve') {
    const per = b[0] - a[0] || 1, u = (x - a[0]) / per, u2 = u * u, u3 = u2 * u;
    return (3 * u2 - 2 * u3) * b[1] + (2 * u3 - 3 * u2 + 1) * a[1] + (u3 - u2) * b[2] * per + (u3 - 2 * u2 + u) * a[3] * per;
  }
  if (c.cls === 'steppcurve') return a[1];
  if (c.cls === 'bumpinpcurve' || c.cls === 'rampuppcurve') return ease('in', x, a[0], b[0], a[1], b[1]);
  if (c.cls === 'bumpoutpcurve' || c.cls === 'rampdownpcurve') return ease('out', x, a[0], b[0], a[1], b[1]);
  if (c.cls === 'smoothpcurve') return ease('inout', x, a[0], b[0], a[1], b[1]);
  return ease('lin', x, a[0], b[0], a[1], b[1]);
}
const getT = (ev, t) => { if (ev.duration <= 0) return 1; t = Math.max(0, Math.min(ev.duration, t)); return ev.curve ? curveValue(ev.curve, t, ev.duration) : t / ev.duration; };

// ---------------- motion paths (MotionPath.cs; centripetal Catmull-Rom) ----------------
function parsePath(desc) {
  try {
    const g = runThorn('path = {' + desc + '}', { ...THN_ENV });
    const p = g.get('path'); if (!(p instanceof LuaTable)) return null;
    const closed = N(p.get(1)) === 0;
    const hasQ = p.get(3) instanceof LuaTable && p.get(3).length >= 4;
    const pts = [], qs = [];
    for (let i = 2; i <= p.length; i++) { const v = p.get(i); if (hasQ && i % 2 !== 0) qs.push(quatWXYZ(v)); else pts.push(vec3(v)); }
    if (pts.length < 2) return null;
    const curve = new THREE.CatmullRomCurve3(pts, closed, 'centripetal');
    return { closed, pts, qs, curve };
  } catch (e) { console.warn('path', e); return null; }
}

// ---------------- templates → models ----------------
async function catalog(app) {
  if (app._thnCatalog) return app._thnCatalog;
  app._thnCatalog = (async () => {
    const dsec = app.game.flIni && app.game.flIni.first('Data');
    const dget = (k, def) => { const v = dsec ? dsec.getAll(k) : []; return v.length ? v : def; };
    const cat = { ships: new Map(), equip: new Map(), petal: new Map(), costumes: new Map() };
    const read = async (files, fn) => { for (const f of files) { const d = await loadIni(dataPath(f)); if (d) fn(d); } };
    await Promise.all([
      read(dget('ships', ['ships\\shiparch.ini']), d => { for (const s of d.all('Ship')) { const n = s.get('nickname'); if (n) cat.ships.set(lc(n), { da: s.get('DA_archetype'), matLibs: s.getAll('material_library') }); } }),
      read(dget('equipment', ['equipment\\select_equip.ini']), d => { for (const s of d.sections) { const n = s.get('nickname'), da = s.get('DA_archetype'); if (n && da) cat.equip.set(lc(n), { da, matLibs: s.getAll('material_library') }); } }),
      read(['petaldb.ini'], d => { for (const s of d.sections) for (const e of s.entries) { const [n, p] = e.value.split(',').map(x => x.trim()); if (n && p) cat.petal.set(lc(e.key) + ':' + lc(n), p); } }),
      read(dget('bodyparts', ['characters\\bodyparts.ini']).concat(dget('costumes', ['characters\\costumes.ini'])), d => { for (const s of d.all('Costume')) { const n = s.get('nickname'); if (n) cat.costumes.set(lc(n), { body: s.get('body'), head: s.get('head') }); } }),
    ]);
    return cat;
  })();
  return app._thnCatalog;
}
async function modelFor(app, cat, category, template, opts = {}) {
  const c = lc(category), t = lc(template); let src = null;
  if (!t) return null;
  if (c === 'solar') { const a = app.game.arch(template); if (a && a.da) src = { da: a.da, matLibs: a.matLibs }; }
  else if (c === 'ship' || c === 'spaceship') src = cat.ships.get(t);
  else if (c === 'prop' || c === 'room' || c === 'equipment cart') { const p = cat.petal.get((c === 'equipment cart' ? 'cart' : c) + ':' + t); if (p) src = { da: p, matLibs: [] }; }
  else if (c === 'equipment') src = cat.equip.get(t);
  else if (c === 'asteroid') { const a = app.game.asteroids.get(t); if (a) src = a; }
  if (!src) { const a = app.game.arch(template) || cat.ships.get(t) || cat.equip.get(t); if (a && a.da) src = { da: a.da, matLibs: a.matLibs || [] }; }
  if (!src || !src.da) return null;
  return app.rm.model(dataPath(src.da), (src.matLibs || []).map(dataPath), opts);
}

// ---------------- the script ----------------
export function parseThn(bytesOrText) {
  const g = runThorn(bytesOrText);
  const ents = new Map(), events = [];
  const E = g.get('entities'), V = g.get('events');
  if (E instanceof LuaTable) for (const t of E.arr) {
    if (!(t instanceof LuaTable)) continue;
    const name = String(t.get('entity_name') || ''); if (!name) continue;
    const sp = t.get('spatialprops'), up = t.get('userprops');
    const e = { name, type: N(t.get('type')), template: String(t.get('template_name') || ''), table: t,
      pos: vec3(tget(sp, 'pos')), quat: orientQuat(tget(sp, 'orient')), flags: N(t.get('flags')), userFlag: N(t.get('usr_flg')),
      category: String(tget(up, 'category') || tget(up, 'Category') || ''), mainObject: tget(up, 'main_object') != null, actor: tget(up, 'Actor'),
      ambient: vec3(t.get('ambient')), floorHeight: N(tget(t.get('compoundprops'), 'floor_height'), 0), camera: t.get('cameraprops'), light: t.get('lightprops'), path: null, audio: t.get('audioprops') };
    const pp = t.get('pathprops'); if (pp instanceof LuaTable && pp.get('path_data')) e.path = parsePath(String(pp.get('path_data')));
    ents.set(lc(name), e);
  }
  if (V instanceof LuaTable) for (const t of V.arr) {
    if (!(t instanceof LuaTable)) continue;
    const tg = t.get(3), props = t.get(4) instanceof LuaTable ? t.get(4) : new LuaTable();
    events.push({ table: t, time: N(t.get(1)), type: N(t.get(2)), typeName: enumName('event', t.get(2)), targets: tg instanceof LuaTable ? tg.arr.map(String) : [], props, duration: N(props.get('duration')), curve: curveFrom(props) });
  }
  events.sort((a, b) => a.time - b.time);
  return { globals: g, duration: N(g.get('duration')), entities: ents, events };
}

// Base scripts run together with their room: the room INI (…/BASES/ROOMS/*.ini) names the set script
// ([Room_Info] set_script) and ambient scenes (scene = …) that the game loads with landing/launch scripts.
export async function roomContext(scriptPath) {
  const name = scriptPath.split('/').pop();
  const r = await fetch('/api/grep?q=' + encodeURIComponent(name)).then(x => x.json()).catch(() => null);
  const hit = r && (r.hits || []).find(x => /\/rooms\//i.test(x.path));
  if (!hit) return null;
  const ini = await loadIni(hit.path); if (!ini) return null;
  const info = ini.first('Room_Info'); if (!info) return null;
  const paths = [info.get('set_script'), ...info.getAll('scene').map(v => v.split(',').map(x => x.trim()).find(x => /\.thn$/i.test(x)))].filter(Boolean)
    .map(x => 'DATA/' + x.replace(/\\/g, '/')).filter(x => x.toLowerCase().split('/').pop() !== name.toLowerCase());
  return { room: hit.path, paths, animation: info.get('animation') };
}
export function mergeScripts(main, extras) {
  const out = { ...main, entities: new Map(main.entities), events: [...main.events], extras: [] };
  const mainSetsCamera = main.events.some(e => e.type === 2);
  for (const x of extras) {
    for (const [k, e] of x.script.entities) if (!out.entities.has(k)) out.entities.set(k, e);
    for (const ev of x.script.events) if (!(mainSetsCamera && ev.type === 2)) out.events.push(ev);
    out.extras.push(x.path);
  }
  out.events.sort((a, b) => a.time - b.time);
  return out;
}

// ---------------- runtime ----------------
export class Runtime {
  constructor(app, script, scene) {
    this.app = app; this.script = script; this.scene = scene;
    this.objects = new Map(); this.root = new THREE.Group(); scene.add(this.root); this.bg = new THREE.Scene();
    this.ambient = new THREE.AmbientLight(0xffffff, 0.5); this.root.add(this.ambient);
  }
  async build(progress) {
    const cat = await catalog(this.app);
    const list = [...this.script.entities.values()];
    let i = 0;
    for (const e of list) {
      progress && progress(++i, list.length);
      const node = new THREE.Group(); node.name = e.name; this.root.add(node);
      const o = { ent: e, node, attach: [], startPos: e.pos ? e.pos.clone() : new THREE.Vector3(), startQuat: e.quat ? e.quat.clone() : new THREE.Quaternion() };
      if (e.type === 1) { // COMPOUND
        const m = await modelFor(this.app, cat, e.category, e.template, e.userFlag ? { unlit: true } : {}).catch(() => null);
        if (m && e.userFlag) { // starsphere: drawn behind everything, centred on the camera (rendered as a background pass)
          let order = this.bg.children.length;
          m.traverse(x => { if (x.isMesh) { x.material = x.material.clone(); x.material.depthTest = false; x.material.depthWrite = false; x.renderOrder = order; } });
          if (e.quat) m.quaternion.copy(e.quat);
          this.bg.add(m); o.model = m; o.starsphere = true;
        } else if (m) { o.model = m; node.add(m); }
        else o.missing = `${e.category || '?'}: ${e.template}`;
      } else if (e.type === 2 && (o.char = await (async () => { try { const cd = this.chars || (this.chars = await characterData(this.app, loadIni, dataPath)); return await loadCostume(this.app, cd, e.template, dataPath); } catch (err) { console.warn('character', e.template, err); return null; } })())) {
        node.add(o.char.object); // DEFORMABLE — costume from costumes.ini, animated with the .anm library
      } else if (e.type === 2) { // DEFORMABLE without a known costume — a stand-in figure
        o.missing = 'costume: ' + e.template;
        const g = new THREE.Group();
        const mat = new THREE.MeshStandardMaterial({ color: 0x8aa0c8, roughness: 0.7 });
        const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.25, 1.1, 4, 10), mat); body.position.y = 0.8; g.add(body);
        const head = new THREE.Mesh(new THREE.SphereGeometry(0.14, 12, 10), mat); head.position.y = 1.62; g.add(head);
        const nose = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.14, 8), new THREE.MeshBasicMaterial({ color: 0xffc04d })); nose.rotation.x = Math.PI / 2; nose.position.set(0, 1.62, 0.17); g.add(nose);
        node.add(g); o.standin = true;
      } else if (e.type === 3) { // CAMERA
        const c = e.camera;
        o.cam = { fovh: N(tget(c, 'fovh'), 17), aspect: N(tget(c, 'hvaspect'), 1.33), near: N(tget(c, 'nearplane'), 0.5), far: N(tget(c, 'farplane'), 1e7) };
        o.helper = new THREE.Mesh(new THREE.ConeGeometry(0.6, 1.2, 4, 1, true), new THREE.MeshBasicMaterial({ color: 0x66ccff, wireframe: true })); o.helper.rotation.x = -Math.PI / 2; o.helper.position.z = -0.6; node.add(o.helper);
      } else if (e.type === 5) { // LIGHT
        const lp = e.light; const tp = N(tget(lp, 'type'), 1);
        const col = vec3(tget(lp, 'diffuse'), new THREE.Vector3(1, 1, 1));
        const range = N(tget(lp, 'range'), 1000);
        const L = tp === 3 ? new THREE.DirectionalLight() : tp === 2 ? new THREE.SpotLight() : new THREE.PointLight();
        L.color.setRGB(col.x, col.y, col.z); L.intensity = 1.6; if (!L.isDirectionalLight) { L.distance = range; L.decay = 0; }
        if (L.isSpotLight) { L.angle = Math.min(Math.PI / 2 - 0.01, N(tget(lp, 'cutoff'), 0.6)); L.penumbra = 0.4; }
        const on = tget(lp, 'on'); L.visible = on == null ? true : !!N(on);
        const dir = vec3(tget(lp, 'direction'), new THREE.Vector3(0, 0, 1));
        if (L.target) { node.add(L.target); L.target.position.copy(dir).multiplyScalar(10); }
        node.add(L); o.light = L; o.lightBase = { color: L.color.clone(), range };
      } else if (e.type === 13) { // PSYS
        try { const inst = await this.app.fx.create(e.template); if (inst) { this.app.fx.instances.delete(inst); o.fx = inst; node.add(inst.object); inst.object.visible = false; } } catch { }
      } else if (e.type === 11 && e.path) { // MOTION_PATH
        const pts = e.path.curve.getPoints(Math.max(24, e.path.pts.length * 12));
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xffaa33 })); line.userData.helper = true; node.add(line); o.helper = line;
      } else if (e.type === 7) { // MARKER
        o.helper = new THREE.AxesHelper(1.5); node.add(o.helper);
      } else if (e.type === 9 && e.ambient) { // SCENE
        const a = e.ambient; this.ambient.color.setRGB(a.x / 255, a.y / 255, a.z / 255); this.ambient.intensity = 1;
      }
      this.objects.set(lc(e.name), o);
    }
    this.reset();
  }
  // a room's own looping animation ([Room_Info] animation = Sc_loop) on its room compound
  loopRoomAnimation(name) {
    for (const o of this.objects.values()) {
      if (!o.model || lc(o.ent.category) !== 'room') continue;
      const sc = (o.model.userData.animations || []).find(s => lc(s.name) === lc(name)); if (sc && sc.duration > 0) o.roomLoop = sc;
    }
  }
  reset() {
    this.t = 0; this.procs = []; this.next = 0; this.cameraName = null; this.subtitles = []; this.sounds = [];
    for (const o of this.objects.values()) {
      o.node.position.copy(o.startPos); o.node.quaternion.copy(o.startQuat); o.attach = [];
      if (o.cam) { const c = o.ent.camera; o.cam.fovh = N(tget(c, 'fovh'), 17); }
      if (o.fx) o.fx.object.visible = false;
      if (o.light) { o.light.color.copy(o.lightBase.color); const on = tget(o.ent.light, 'on'); o.light.visible = on == null ? true : !!N(on); }
      if (o.model && o.model.userData.animations?.length) { o.motion = null; }
      if (o.char) { o.char.stopAll(); o.floor = o.ent.floorHeight || 0; o.rootPrev = null; this.placeChar(o); }
    }
    // the first camera is active until a SET_CAMERA says otherwise
    const firstCam = [...this.objects.values()].find(o => o.cam); this.cameraName = firstCam ? lc(firstCam.ent.name) : null;
    this.applyAttachments();
  }
  obj(name) { return this.objects.get(lc(name)); }
  // characters: root motion of the running animation moves
  // the entity, and its height is always floor height + the animation's root height (feet on the floor)
  placeChar(o) {
    const m = o.char.rootMotion();
    if (m) {
      const p = o.rootPrev && o.rootPrev.inst === m.inst ? o.rootPrev : { inst: m.inst, tr: new THREE.Vector3(), rot: new THREE.Quaternion() };
      const frame = o.node.quaternion.clone().multiply(p.rot.clone().invert());
      o.node.position.add(m.tr.clone().sub(p.tr).applyQuaternion(frame));
      o.node.quaternion.multiply(p.rot.clone().invert().multiply(m.rot));
      o.rootPrev = m;
    } else o.rootPrev = null;
    o.node.position.y = (o.floor || 0) + (o.char.rootHeight || 0);
  }
  seek(t) {
    if (t < this.t - 1e-9) this.reset();
    while (this.t + STEP <= t + 1e-9) this.step(STEP);
    for (const o of this.objects.values()) if (o.char && o.char.dirty) { o.char.pose(); o.char.dirty = false; }
    this.applyAttachments();
  }
  step(dt) {
    this.t += dt;
    const evs = this.script.events;
    while (this.next < evs.length && evs[this.next].time <= this.t + 1e-9) this.run(evs[this.next++]);
    this.procs = this.procs.filter(p => p(dt) !== false);
    for (const o of this.objects.values()) if (o.char) { o.char.advance(dt); this.placeChar(o); }
    for (const o of this.objects.values()) if (o.roomLoop) { applyScript(o.model, o.roomLoop, this.t % o.roomLoop.duration); o.model.updateMatrixWorld(true); }
    this.applyAttachments();
  }
  run(ev) {
    const [a, b] = ev.targets, A = this.obj(a), B = b != null ? this.obj(b) : null;
    const P = ev.props;
    switch (ev.type) {
      case 2: { const mon = this.obj(a); if (mon && mon.ent.type === 4 && b) this.cameraName = lc(b); else if (b) this.cameraName = lc(b); break; }
      case 7: { // START_SPATIAL_PROP_ANIM
        if (!A) break;
        const sp = tget(P, 'spatialprops');
        const pos = vec3(tget(sp, 'pos')), q = quatWXYZ(tget(sp, 'q_orient')) || orientQuat(tget(sp, 'orient'));
        const axr = tget(sp, 'axisrot');
        const startPos = A.node.position.clone(), startQ = A.node.quaternion.clone();
        let local = 0;
        const apply = (k) => {
          if (B) { if (pos || !q) A.node.position.lerpVectors(startPos, B.node.position, k); if (q) A.node.quaternion.slerpQuaternions(startQ, B.node.quaternion, k); return; }
          if (pos) A.node.position.lerpVectors(startPos, pos, k);
          if (q) A.node.quaternion.slerpQuaternions(startQ, q, k);
          if (axr instanceof LuaTable) { const deg = N(axr.get(1)), ax = AXES[N(axr.get(2), 1)] || AXES[1]; const og = ax.clone().applyQuaternion(startQ); A.node.quaternion.copy(startQ).premultiply(new THREE.Quaternion().setFromAxisAngle(og, -deg * k * Math.PI / 180)); }
        };
        if (ev.duration <= 0) { apply(1); break; }
        this.procs.push((dt) => { local += dt; apply(getT(ev, local)); return local < ev.duration; });
        break;
      }
      case 6: { // START_PATH_ANIMATION
        if (!A || !B || !B.ent.path) break;
        const start = N(P.get('start_percent')), stop = P.get('stop_percent') == null ? 1 : N(P.get('stop_percent')), flags = N(P.get('flags'), 2), off = vec3(P.get('offset'), new THREE.Vector3());
        const att = { kind: 'path', target: B, pct: start, flags, offset: off };
        A.attach.push(att);
        let local = 0;
        this.procs.push((dt) => { local += dt; att.pct = start + (stop - start) * getT(ev, local); if (local >= ev.duration) { this.applyOne(A, att); A.attach = A.attach.filter(x => x !== att); return false; } return true; });
        break;
      }
      case 8: { // ATTACH_ENTITY
        if (!A || !B) break;
        const flags = P.get('flags') == null ? 6 : N(P.get('flags'));
        const att = { kind: 'entity', target: B, flags, offset: vec3(P.get('offset'), new THREE.Vector3()), targetType: N(P.get('target_type')), part: P.get('target_part') ? String(P.get('target_part')) : null };
        A.attach.push(att);
        let local = 0;
        this.procs.push((dt) => { local += dt; if (local > ev.duration) { this.applyOne(A, att); A.attach = A.attach.filter(x => x !== att); return false; } return true; });
        break;
      }
      case 9: { // CONNECT_HARDPOINTS: place A so that its hardpoint sits on B's hardpoint
        if (!A || !B) break;
        const hpB = this.hardpointWorld(B, String(P.get('parent_hardpoint') || ''));
        if (hpB) { A.node.position.copy(hpB.p); A.node.quaternion.copy(hpB.q); }
        break;
      }
      case 10: { // START_MOTION — character .anm script, or a compound's Cmpnd animation
        if (A && A.char && this.chars) {
          const sc = this.chars.scripts.get(lc(P.get('animation'))); if (!sc) break;
          A.char.start(sc, { startTime: N(P.get('start_time')), timeScale: P.get('time_scale') == null ? 1 : N(P.get('time_scale')), duration: ev.duration, loop: N(P.get('event_flags')) === 2 });
          break;
        }
        if (!A || !A.model) break;
        const name = lc(P.get('animation')); const sc = (A.model.userData.animations || []).find(s => lc(s.name) === name);
        if (!sc) break;
        let local = N(P.get('start_time')); const scale = P.get('time_scale') == null ? 1 : N(P.get('time_scale'));
        const dur = ev.duration > 0 ? ev.duration : sc.duration / (scale || 1);
        let run = 0;
        this.procs.push((dt) => { run += dt; local += dt * scale; applyScript(A.model, sc, Math.min(local, sc.duration)); A.model.updateMatrixWorld(true); return run < dur; });
        break;
      }
      case 18: { // START_FLR_HEIGHT_ANIM — a character's floor height
        if (!A || !A.char) break;
        const f1 = N(P.get('floor_height')), f0 = A.floor || 0;
        if (ev.duration <= 0) { A.floor = f1; break; }
        let local = 0; this.procs.push((dt) => { local += dt; A.floor = f0 + (f1 - f0) * getT(ev, local); return local < ev.duration; });
        break;
      }
      case 5: { // START_CAMERA_PROP_ANIM
        if (!A || !A.cam) break;
        const fov = tget(tget(P, 'cameraprops'), 'fovh'); if (fov == null) break;
        const f0 = A.cam.fovh, f1 = N(fov);
        if (ev.duration <= 0) { A.cam.fovh = f1; break; }
        let local = 0; this.procs.push((dt) => { local += dt; A.cam.fovh = f0 + (f1 - f0) * getT(ev, local); return local < ev.duration; });
        break;
      }
      case 4: { // START_LIGHT_PROP_ANIM
        if (!A || !A.light) break;
        const lp = tget(P, 'lightprops'); const on = tget(lp, 'on'); const col = vec3(tget(lp, 'diffuse'));
        if (on != null) A.light.visible = !!N(on);
        if (col) { const c0 = A.light.color.clone(), c1 = new THREE.Color(col.x, col.y, col.z); if (ev.duration <= 0) A.light.color.copy(c1); else { let local = 0; this.procs.push((dt) => { local += dt; A.light.color.lerpColors(c0, c1, getT(ev, local)); return local < ev.duration; }); } }
        break;
      }
      case 13: { // START_PSYS
        if (!A || !A.fx) break;
        A.fx.object.visible = true;
        if (ev.duration > 0) { let local = 0; this.procs.push((dt) => { local += dt; if (local >= ev.duration) { A.fx.object.visible = false; return false; } return true; }); }
        break;
      }
      case 3: { // START_SOUND
        if (!A) break;
        this.sounds.push({ at: this.t, name: A.ent.template, ent: A.ent.name, dur: ev.duration });
        if (this.live && this.onSound) this.onSound(A.ent, ev);
        break;
      }
    }
  }
  hardpointWorld(o, name) {
    if (o.char && name) {
      const m = o.char.hardpoint(name); if (!m) return null;
      o.node.updateMatrixWorld(true); m.premultiply(o.node.matrixWorld);
      const p = new THREE.Vector3(), q = new THREE.Quaternion(); m.decompose(p, q, new THREE.Vector3()); return { p, q };
    }
    if (!o.model || !name) return null;
    const hp = (o.model.userData.hardpoints || []).find(x => lc(x.name) === lc(name)); if (!hp) return null;
    o.node.updateMatrixWorld(true);
    const m = new THREE.Matrix4();
    if (hp.rot) m.set(hp.rot[0], hp.rot[1], hp.rot[2], 0, hp.rot[3], hp.rot[4], hp.rot[5], 0, hp.rot[6], hp.rot[7], hp.rot[8], 0, 0, 0, 0, 1);
    if (hp.partMatrix) m.premultiply(new THREE.Matrix4().extractRotation(hp.partMatrix));
    m.setPosition(hp.pos); m.premultiply(o.node.matrixWorld);
    const p = new THREE.Vector3(), q = new THREE.Quaternion(); m.decompose(p, q, new THREE.Vector3());
    return { p, q };
  }
  applyOne(o, att) {
    if (att.kind === 'path') {
      const path = att.target.ent.path; const tn = att.target.node;
      const t = Math.max(0, Math.min(1, att.pct));
      const local = path.curve.getPointAt(t).add(att.offset);
      const world = local.clone().applyQuaternion(tn.quaternion).add(tn.position);
      if (att.flags & 2) o.node.position.copy(world);
      if (att.flags & 8) { // LOOK_AT: face along the path
        const ahead = path.curve.getPointAt(Math.min(1, t + 0.01)).applyQuaternion(tn.quaternion).add(tn.position);
        if (ahead.distanceToSquared(world) > 1e-8) { const m = new THREE.Matrix4().lookAt(world, ahead, new THREE.Vector3(0, 1, 0)); o.node.quaternion.setFromRotationMatrix(m); }
      } else if ((att.flags & 4) && path.qs.length) {
        const f = t * (path.qs.length - 1), i = Math.min(path.qs.length - 2, Math.floor(f));
        const q = path.qs.length > 1 ? path.qs[i].clone().slerp(path.qs[i + 1], f - i) : path.qs[0].clone();
        o.node.quaternion.copy(tn.quaternion).multiply(q);
      }
      return;
    }
    const T = att.target;
    let p = T.node.position.clone(), q = T.node.quaternion.clone();
    if (att.targetType === 1 && att.part) { const hp = this.hardpointWorld(T, att.part); if (hp) { p = hp.p; q = hp.q; } }
    if (att.flags & 8) { // LOOK_AT
      const m = new THREE.Matrix4().lookAt(o.node.position, p, new THREE.Vector3(0, 1, 0));
      o.node.quaternion.setFromRotationMatrix(m);
      return;
    }
    if (att.flags & 2) o.node.position.copy(p).add(att.offset.clone().applyQuaternion((att.flags & 32) ? q : new THREE.Quaternion()));
    if (att.flags & 4) o.node.quaternion.copy(q);
  }
  applyAttachments() { for (const o of this.objects.values()) for (const a of o.attach) this.applyOne(o, a); }
  activeCamera() { const o = this.cameraName && this.objects.get(this.cameraName); return o && o.cam ? o : null; }
  dispose() { this.scene.remove(this.root); }
}

// ---------------- dialog ----------------
export async function thnPlayer(app, { path = null } = {}) {
  const list = h('div', { class: 'reflist', style: { height: 'calc(100vh - 260px)', overflow: 'auto', fontSize: '12px' } });
  const filter = h('input', { placeholder: 'Filter cutscenes…', style: { width: '100%' } });
  const canvas = h('canvas', { style: { width: '100%', height: '100%', display: 'block', background: '#000', borderRadius: '6px' } });
  const subtitle = h('div', { style: { position: 'absolute', left: '0', right: '0', bottom: '14px', textAlign: 'center', color: '#fff', textShadow: '0 1px 3px #000', fontSize: '13px', pointerEvents: 'none' } });
  const badge = h('div', { style: { position: 'absolute', left: '10px', top: '8px', color: '#9cf', fontSize: '11px', fontFamily: 'var(--mono)', textShadow: '0 1px 2px #000', pointerEvents: 'none' } });
  const view = h('div', { style: { position: 'relative', height: 'calc(100vh - 372px)', minHeight: '280px' } }, canvas, badge, subtitle);
  const slider = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: 0, style: { flex: '1' } });
  const tlabel = h('span', { style: { fontFamily: 'var(--mono)', fontSize: '11px', minWidth: '96px', textAlign: 'right' } }, '0.00 / 0.00');
  const playBtn = h('button', { class: 'btn sm primary' }, 'Play');
  const modeSel = h('select', {}, h('option', { value: 'cam' }, 'Through the cutscene camera'), h('option', { value: 'free' }, 'Free camera (orbit)'));
  const helpers = h('input', { type: 'checkbox', checked: true });
  const soundOn = h('input', { type: 'checkbox', checked: true, onchange: () => { if (!soundOn.checked) stopSounds(); } });
  const live = new Set();
  const stopSounds = () => { for (const s of live) { try { s.stop(); } catch { } } live.clear(); };
  const sndCache = new Map();
  const onSound = async (ent) => {
    if (!soundOn.checked || speed !== 1) return;
    const key = lc(ent.template); if (!key) return;
    try {
      if (!sndCache.has(key)) sndCache.set(key, soundBytes(app, ent.template).then(r => r && r.bytes ? decodeFlWav(r.bytes) : null).catch(() => null));
      const buf = await sndCache.get(key); if (!buf || !playing) return;
      const att = N(tget(ent.audio, 'attenuation'));
      const src = await playOverlay(buf, Math.min(1, dbToGain(att))); live.add(src); src.onended = () => live.delete(src);
    } catch { }
  };
  const withRoom = h('input', { type: 'checkbox', checked: true, onchange: () => { if (filePath) open(filePath); } });
  const editBar = h('div', { class: 'btnrow', style: { alignItems: 'center', margin: '0 0 6px', flexWrap: 'wrap' } });
  const timeline = h('canvas', { height: 44, style: { width: '100%', height: '44px', display: 'block', cursor: 'pointer', background: 'var(--bg2, #111821)', borderRadius: '4px' } });
  const right = h('div', { style: { height: 'calc(100vh - 260px)', overflow: 'auto', fontSize: '12px' } });
  const tabs = h('div', { class: 'btnrow' });
  const title = h('span', { style: { fontWeight: 600 } }, 'No cutscene loaded');
  const m = modal({
    title: 'Cutscenes (.thn)', wide: true,
    body: h('div', { style: { display: 'grid', gridTemplateColumns: '240px 1fr 380px', gap: '10px' } },
      h('div', {}, filter, list),
      h('div', {}, h('div', { style: { margin: '0 0 6px' } }, title), editBar, view,
        h('div', { class: 'btnrow', style: { alignItems: 'center', margin: '6px 0' } }, playBtn, h('button', { class: 'btn sm', onclick: () => { seek(0); } }, '⏮'), slider, tlabel, modeSel, h('label', { title: 'cameras, markers and paths' }, helpers, ' helpers'), h('label', { title: 'base scripts: also load the room set and ambient scripts named in the room INI' }, withRoom, ' room'), h('label', { title: 'play the sounds and voice lines of START_SOUND events while playing' }, soundOn, ' sound')),
        timeline),
      h('div', {}, tabs, right)),
    onClose: () => { running = false; stopSounds(); gizmo.dispose(); renderer.dispose(); rt && rt.dispose(); entDlEl.remove(); },
    buttons: [{ label: 'Close', onClick: async () => !dirty || await confirmDialog('Discard?', 'The cutscene has unsaved edits.', 'Discard', true) }],
  });
  m.box.classList.add('xwide');

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(50, 1, 0.5, 1e7);
  const free = new THREE.PerspectiveCamera(50, 1, 0.5, 1e7); free.position.set(30, 20, 40);
  const bgCam = new THREE.PerspectiveCamera();
  const orbit = new OrbitControls(free, canvas); orbit.enableDamping = true;
  let rt = null, script = null, filePath = null, playing = false, running = true, speed = 1, last = performance.now(), tab = 'events', text = '';
  // ---- editing (main script only; room scripts loaded alongside are read-only)
  let own = null, selEnt = null, selEv = null, dirty = false; const undoStack = [];
  const keyDur = h('input', { type: 'number', value: '1', step: '0.1', min: '0', style: { width: '56px' }, title: 'seconds a new key takes to reach the pose' });
  const gizmo = new TransformControls(free, canvas); gizmo.setSize(0.7);
  const proxy = new THREE.Object3D(); scene.add(proxy); scene.add(gizmo.getHelper());
  gizmo.addEventListener('dragging-changed', (e) => { orbit.enabled = !e.value; if (!e.value) commitGizmo(); });
  const ownsEnt = (e) => !!(own && e && own.entities.get(lc(e.name)) === e);
  const showDirty = () => { title.querySelector('.dirty')?.remove(); if (dirty) title.prepend(h('span', { class: 'dirty', style: { color: '#ffd34d' } }, '● ')); };
  function snapshot() { if (!own) return; undoStack.push(globalsToLua(own.globals)); if (undoStack.length > 60) undoStack.shift(); dirty = true; }
  let selEvKey = null;
  async function reloadEdited() { selEvKey = selEv ? { type: selEv.type, tg: selEv.targets.join('|'), time: +selEv.table.get(1) } : null; text = globalsToLua(own.globals); await load(text, filePath, true, true); }
  const luaVec = (v) => { const t = new LuaTable(); [v.x, v.y, v.z].forEach((x, i) => t.set(i + 1, +x.toFixed(4))); return t; };
  // THREE rotation → orient rows (inverse of orientQuat: rows of the row-vector matrix = columns here)
  const luaOrient = (q) => { const e = new THREE.Matrix4().makeRotationFromQuaternion(q).elements; const t = new LuaTable(); for (let a = 0; a < 3; a++) { const r = new LuaTable(); for (let b = 0; b < 3; b++) r.set(b + 1, +e[a * 4 + b].toFixed(6)); t.set(a + 1, r); } return t; };
  const luaQuat = (q) => { const t = new LuaTable(); [q.w, q.x, q.y, q.z].forEach((x, i) => t.set(i + 1, +x.toFixed(6))); return t; };
  const props = (pairs) => { const t = new LuaTable(); for (const [k, v] of pairs) t.set(k, v); return t; };
  function setStartPose(e, pos, quat) {
    let sp = e.table.get('spatialprops'); if (!(sp instanceof LuaTable)) { sp = new LuaTable(); e.table.set('spatialprops', sp); }
    sp.set('pos', luaVec(pos)); sp.set('orient', luaOrient(quat));
  }
  function addEvent(time, typeName, targets, propPairs) {
    const evs = own.globals.get('events'); const t = new LuaTable();
    t.set(1, +time.toFixed(3)); t.set(2, THN_ENV[typeName]); const tg = new LuaTable(); targets.forEach((x, i) => tg.set(i + 1, x)); t.set(3, tg); t.set(4, props(propPairs));
    evs.set(evs.length + 1, t); return t;
  }
  // a pose for entity e: at 0 s its start pose, later a START_SPATIAL_PROP_ANIM key (updated if one starts at this time)
  function poseEntity(e, pos, quat) {
    const t = rt ? rt.t : 0;
    if (t < 0.05) { setStartPose(e, pos, quat); return 'start pose'; }
    const ex = own.events.find(ev => ev.type === 7 && Math.abs(ev.time - t) < 0.02 && ev.targets.length === 1 && lc(ev.targets[0]) === lc(e.name));
    const sp = props([['pos', luaVec(pos)], ['q_orient', luaQuat(quat)]]);
    if (ex) ex.props.set('spatialprops', sp);
    else addEvent(t, 'START_SPATIAL_PROP_ANIM', [e.name], [['duration', +(+keyDur.value || 0).toFixed(3)], ['spatialprops', sp]]);
    return 'key at ' + t.toFixed(2) + ' s';
  }
  function attachGizmo() {
    const o = selEnt && rt && rt.obj(selEnt.name);
    if (!o || !ownsEnt(selEnt) || modeSel.value !== 'free') { gizmo.detach(); return; }
    o.node.updateMatrixWorld(true); o.node.matrixWorld.decompose(proxy.position, proxy.quaternion, proxy.scale); proxy.updateMatrixWorld(true);
    gizmo.attach(proxy);
  }
  async function commitGizmo() {
    if (!selEnt || !ownsEnt(selEnt)) return;
    snapshot(); const what = poseEntity(selEnt, proxy.position, proxy.quaternion);
    await reloadEdited(); toast(`${selEnt.name}: ${what}`);
  }
  async function cameraFromView() {
    let e = selEnt && selEnt.type === 3 ? selEnt : null;
    if (!e) { const c = rt && rt.activeCamera(); e = c && ownsEnt(c.ent) ? c.ent : null; }
    if (!e) { toast('Select a camera of this script (Entities tab) first'); return; }
    snapshot(); const what = poseEntity(e, free.position, free.quaternion);
    // horizontal half angle from the free view
    const fovh = Math.atan(Math.tan(free.fov * Math.PI / 360) * free.aspect) * 180 / Math.PI;
    if ((rt ? rt.t : 0) < 0.05) { let cp = e.table.get('cameraprops'); if (!(cp instanceof LuaTable)) { cp = new LuaTable(); e.table.set('cameraprops', cp); } cp.set('fovh', +fovh.toFixed(3)); }
    await reloadEdited(); toast(`${e.name}: ${what} from the view`);
  }
  async function undoEdit() { const t = undoStack.pop(); if (t == null) { toast('Nothing to undo'); return; } text = t; selEvKey = null; await load(t, filePath, true, true); dirty = undoStack.length > 0; showDirty(); }
  async function saveThn() {
    if (!filePath || !own) return;
    try { text = globalsToLua(own.globals); parseThn(text); await api.write(filePath, new TextEncoder().encode(text.replace(/\r?\n/g, '\r\n'))); dirty = false; undoStack.length = 0; showDirty(); toast('Saved ' + filePath.split('/').pop() + ' (as text; the original is backed up)'); }
    catch (e) { toast('Not saved: ' + e.message, 5000); }
  }
  editBar.append(
    h('button', { class: 'btn sm', title: 'Undo the last cutscene edit', onclick: undoEdit }, '↶ Undo'),
    h('button', { class: 'btn sm primary', onclick: saveThn }, 'Save .thn'),
    h('button', { class: 'btn sm', title: 'Put the selected camera (or the active one) where the free camera is: start pose at 0 s, otherwise a key at the current time', onclick: cameraFromView }, '📷 Camera from view'),
    h('button', { class: 'btn sm', title: 'Cut to the selected camera at the current time', onclick: async () => {
      const e = selEnt && selEnt.type === 3 ? selEnt : null; if (!e) return toast('Select a camera in the Entities tab');
      const mon = [...script.entities.values()].find(x => x.type === 4); const prev = own.events.find(ev => ev.type === 2);
      snapshot(); addEvent(rt.t, 'SET_CAMERA', [prev ? prev.targets[0] : mon ? mon.name : 'Monitor_1', e.name], []); await reloadEdited();
    } }, '✂ Cut to camera here'),
    h('span', { style: { fontSize: '11px', color: 'var(--faint)' }, title: 'Free camera: click an entity (or pick it in Entities) and drag the gizmo — W move, E rotate. At 0 s this changes its start pose; later it adds a key that moves it there over this many seconds. Drag timeline bars to move events, their right end to change the duration.' }, 'key length ⓘ'), keyDur, h('span', { style: { fontSize: '11px', color: 'var(--faint)' } }, 's'));
  window.addEventListener('keydown', (ev) => { if (!running || document.activeElement && /input|textarea|select/i.test(document.activeElement.tagName)) return; if (ev.key === 'w') gizmo.setMode('translate'); if (ev.key === 'e') gizmo.setMode('rotate'); });
  const resize = () => { const r = view.getBoundingClientRect(); if (!r.width) return; renderer.setSize(r.width, r.height, false); free.aspect = r.width / r.height; free.updateProjectionMatrix(); timeline.width = timeline.getBoundingClientRect().width; drawTimeline(); };
  new ResizeObserver(resize).observe(view);

  function seek(t) { if (!rt) return; rt.seek(Math.max(0, Math.min(script.duration, t))); updateUi(); }
  function updateUi() {
    if (!rt) return;
    slider.value = String(rt.t); tlabel.textContent = `${rt.t.toFixed(2)} / ${script.duration.toFixed(2)}`;
    const c = rt.activeCamera();
    badge.textContent = `${c ? '📷 ' + c.ent.name : 'no camera'}`;
    const s = rt.sounds.filter(x => rt.t - x.at < Math.max(2.5, x.dur || 0)).slice(-2);
    subtitle.textContent = s.map(x => '♪ ' + x.name).join('   ');
    drawTimeline();
  }
  function drawTimeline() {
    const ctx = timeline.getContext('2d'), W = timeline.width, H = timeline.height;
    ctx.clearRect(0, 0, W, H);
    if (!script) return;
    const D = script.duration || 1, x = (t) => (t / D) * W;
    const rows = { 2: 0, 7: 1, 6: 1, 8: 1, 10: 2, 11: 2, 3: 3, 15: 3, 13: 3, 14: 3, 4: 3, 16: 3, 5: 0 };
    const col = { 0: '#66ccff', 1: '#ffaa33', 2: '#a78bfa', 3: '#4ade80' };
    for (const ev of script.events) { const r = rows[ev.type] ?? 3; ctx.fillStyle = ev === selEv ? '#ffffff' : col[r]; ctx.globalAlpha = own && !own.events.includes(ev) ? 0.3 : 0.8; ctx.fillRect(x(ev.time), 3 + r * 10, Math.max(2, x(ev.duration)), 7); }
    ctx.globalAlpha = 1; if (rt) { ctx.fillStyle = '#fff'; ctx.fillRect(x(rt.t) - 1, 0, 2, H); }
  }
  canvas.addEventListener('pointerdown', (e) => { canvas._down = [e.clientX, e.clientY]; });
  canvas.addEventListener('pointerup', (e) => {
    if (!rt || modeSel.value !== 'free' || gizmo.dragging || !canvas._down || Math.hypot(e.clientX - canvas._down[0], e.clientY - canvas._down[1]) > 4) return;
    const r = canvas.getBoundingClientRect(), ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), free);
    const nodes = [...rt.objects.values()].filter(o => !o.starsphere && o.ent.type !== 9 && !(o.model && lc(o.ent.category) === 'room')).map(o => o.node);
    const hit = ray.intersectObjects(nodes, true).find(x => x.object.visible);
    if (!hit) return;
    let n = hit.object; while (n && !nodes.includes(n)) n = n.parent;
    const o = n && [...rt.objects.values()].find(x => x.node === n);
    if (o) { selEnt = o.ent; attachGizmo(); if (tab === 'entities') renderTabs(); toast(o.ent.name + (ownsEnt(o.ent) ? '' : ' (room script, read-only)')); }
  });
  // timeline: click = seek; drag a bar = move the event; drag its right end = change the duration
  const ROWS = { 2: 0, 7: 1, 6: 1, 8: 1, 10: 2, 11: 2, 3: 3, 15: 3, 13: 3, 14: 3, 4: 3, 16: 3, 5: 0 };
  const evAt = (px, py) => { if (!script) return null; const W = timeline.width, D = script.duration || 1; for (const ev of [...script.events].reverse()) { const r = ROWS[ev.type] ?? 3, x0 = (ev.time / D) * W, x1 = x0 + Math.max(3, (ev.duration / D) * W); if (py >= 3 + r * 10 - 1 && py <= 3 + r * 10 + 8 && px >= x0 - 2 && px <= x1 + 2) return { ev, edge: ev.duration > 0 && px > x1 - 5 }; } return null; };
  let tlDrag = null;
  timeline.addEventListener('pointerdown', (e) => {
    const r = timeline.getBoundingClientRect(), px = (e.clientX - r.left) * timeline.width / r.width, py = (e.clientY - r.top) * timeline.height / r.height;
    const hit = evAt(px, py);
    if (hit && own && own.events.includes(hit.ev)) { selEv = hit.ev; tlDrag = { ...hit, x: e.clientX, t0: hit.ev.time, d0: hit.ev.duration, moved: false, snap: globalsToLua(own.globals) }; timeline.setPointerCapture(e.pointerId); tab = 'events'; renderTabs(); drawTimeline(); return; }
    seek((px / timeline.width) * (script ? script.duration : 0));
  });
  timeline.addEventListener('pointermove', (e) => {
    const r = timeline.getBoundingClientRect();
    if (!tlDrag) { const hit = evAt((e.clientX - r.left) * timeline.width / r.width, (e.clientY - r.top) * timeline.height / r.height); timeline.style.cursor = hit ? (hit.edge ? 'ew-resize' : 'grab') : 'pointer'; return; }
    const dt = ((e.clientX - tlDrag.x) / r.width) * (script.duration || 1); if (Math.abs(e.clientX - tlDrag.x) > 2) tlDrag.moved = true;
    const snap = (v) => Math.round(v * 20) / 20;
    if (tlDrag.edge) { tlDrag.ev.duration = Math.max(0, snap(tlDrag.d0 + dt)); } else tlDrag.ev.time = Math.max(0, snap(tlDrag.t0 + dt));
    drawTimeline();
  });
  timeline.addEventListener('pointerup', async () => {
    const d = tlDrag; tlDrag = null; if (!d) return;
    if (!d.moved) { seek(d.ev.time + 1e-3); return; }
    undoStack.push(d.snap); dirty = true;
    d.ev.table.set(1, d.ev.time); if (d.edge) d.ev.props.set('duration', d.ev.duration); if (!(d.ev.table.get(4) instanceof LuaTable)) d.ev.table.set(4, d.ev.props);
    await reloadEdited();
  });
  slider.oninput = () => { playing = false; stopSounds(); playBtn.textContent = 'Play'; seek(+slider.value); };
  playBtn.onclick = () => { if (!rt) return; if (rt.t >= script.duration - 1e-3) seek(0); playing = !playing; if (!playing) stopSounds(); playBtn.textContent = playing ? 'Pause' : 'Play'; last = performance.now(); };
  modeSel.addEventListener('change', () => attachGizmo());
  modeSel.onchange = () => { if (modeSel.value === 'free' && rt) { const c = rt.activeCamera(); if (c) { free.position.copy(c.node.position); orbit.target.copy(c.node.position.clone().add(new THREE.Vector3(0, 0, -20).applyQuaternion(c.node.quaternion))); } } };

  (function loop() {
    if (!running) return;
    const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (playing && rt) { const target = Math.min(script.duration, rt.t + dt * speed); rt.live = true; rt.seek(target); rt.live = false; updateUi(); if (rt.t >= script.duration - 1e-3) { playing = false; playBtn.textContent = 'Play'; } }
    let camera = free;
    if (rt) {
      for (const o of rt.objects.values()) if (o.helper) o.helper.visible = helpers.checked && modeSel.value === 'free';
      if (gizmo.object && !gizmo.dragging && selEnt) { const so = rt.obj(selEnt.name); if (so) { so.node.updateMatrixWorld(true); so.node.matrixWorld.decompose(proxy.position, proxy.quaternion, proxy.scale); } }
      const c = rt.activeCamera();
      if (modeSel.value === 'cam' && c) {
        c.node.updateMatrixWorld(true);
        cam.position.setFromMatrixPosition(c.node.matrixWorld); cam.quaternion.setFromRotationMatrix(new THREE.Matrix4().extractRotation(c.node.matrixWorld));
        const r = view.getBoundingClientRect(); cam.aspect = r.width / Math.max(1, r.height);
        cam.fov = 2 * Math.atan(Math.tan(c.cam.fovh * Math.PI / 180) / cam.aspect) * 180 / Math.PI;
        cam.near = Math.max(0.1, c.cam.near); cam.far = Math.max(cam.near * 10, c.cam.far || 1e7); cam.updateProjectionMatrix();
        camera = cam;
      } else orbit.update();
      for (const o of rt.objects.values()) {
        if (o.fx && o.fx.object.visible) { o.fx.update(playing ? dt * speed : 0); o.fx.object.updateWorldMatrix(true, false); o.fx.draw(camera); }
      }
    } else orbit.update();
    renderer.autoClear = false; renderer.clear();
    if (rt && rt.bg.children.length) { bgCam.copy(camera); bgCam.position.set(0, 0, 0); bgCam.near = 0.1; bgCam.far = 1e5; bgCam.updateProjectionMatrix(); renderer.render(rt.bg, bgCam); renderer.clearDepth(); }
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  })();

  function eventEditor(ev) {
    const box = h('div', { class: 'psec', style: { marginBottom: '8px' } }, h('h3', {}, ev.typeName.replace(/_/g, ' ').toLowerCase()));
    const commit = async (fn) => { snapshot(); fn(); await reloadEdited(); };
    const num = (v, on) => h('input', { type: 'number', step: '0.05', value: +(+v).toFixed(3), style: { width: '80px' }, onchange: (e) => commit(() => on(+e.target.value || 0)) });
    box.append(h('div', { class: 'btnrow', style: { alignItems: 'center', flexWrap: 'wrap' } },
      'time', num(ev.time, (v) => ev.table.set(1, v)), 'duration', num(ev.duration, (v) => ev.props.set('duration', v))));
    const tg = ev.table.get(3);
    box.append(h('div', { style: { margin: '4px 0' } }, 'targets ', ...(tg instanceof LuaTable ? tg.arr : []).map((t, i) => h('input', { value: String(t), list: entDl.id, style: { width: '45%', marginRight: '4px' }, onchange: (e) => commit(() => tg.set(i + 1, e.target.value)) }))));
    // simple properties (numbers and strings); nested tables are edited in the Script tab
    for (const [k, v] of ev.props.entries()) {
      if (k === 'duration' || v instanceof LuaTable) continue;
      box.append(h('div', { style: { display: 'grid', gridTemplateColumns: '110px 1fr', gap: '4px', margin: '2px 0' } }, h('span', { style: { color: 'var(--dim)' } }, String(k)),
        h('input', { value: v instanceof LuaEnum ? v.name : String(v), style: { width: '100%' }, onchange: (e) => commit(() => { const x = e.target.value.trim(); ev.props.set(k, x !== '' && !isNaN(+x) ? +x : (THN_ENV[x] || x)); }) })));
    }
    box.append(h('div', { class: 'btnrow', style: { marginTop: '6px' } },
      h('button', { class: 'btn sm', onclick: () => commit(() => { const evs = own.globals.get('events'); const c = runThorn('x = ' + globalsToLua(new Map([['x', ev.table]])).replace(/^x = /, ''), THN_ENV).get('x'); c.set(1, +(ev.time + 1).toFixed(3)); evs.set(evs.length + 1, c); }) }, 'Duplicate (+1 s)'),
      h('button', { class: 'btn sm danger', onclick: () => commit(() => { const evs = own.globals.get('events'); evs.arr = evs.arr.filter(t => t !== ev.table); selEv = null; }) }, 'Delete')));
    return box;
  }
  const entDl = { id: 'thn-ent-dl' }; const entDlEl = h('datalist', { id: entDl.id }); document.body.append(entDlEl);
  function renderTabs() {
    entDlEl.innerHTML = ''; if (script) for (const e of script.entities.values()) entDlEl.append(h('option', { value: e.name }));
    tabs.innerHTML = '';
    for (const [k, l] of [['events', 'Events'], ['entities', 'Entities'], ['script', 'Script']]) tabs.append(h('button', { class: 'btn sm' + (tab === k ? ' primary' : ''), onclick: () => { tab = k; renderTabs(); } }, l));
    right.innerHTML = '';
    if (!script) { right.append(h('div', { class: 'empty' }, 'Pick a cutscene on the left.')); return; }
    if (tab === 'events') {
      if (selEv && own && own.events.includes(selEv)) right.append(eventEditor(selEv));
      right.append(h('div', { style: { color: 'var(--faint)', margin: '6px 0' } }, `${script.events.length} events · click one to select it and jump there`));
      right.append(h('div', {}, script.events.map(ev => h('div', { style: { display: 'grid', gridTemplateColumns: '52px 1fr', gap: '6px', padding: '2px 4px', cursor: 'pointer', borderBottom: '1px solid var(--line, #222)', background: ev === selEv ? 'rgba(255,210,80,.12)' : '', opacity: own && !own.events.includes(ev) ? 0.55 : 1 }, onclick: () => { playing = false; playBtn.textContent = 'Play'; selEv = ev; seek(ev.time + 1e-3); renderTabs(); } },
        h('span', { style: { fontFamily: 'var(--mono)', color: 'var(--faint)' } }, ev.time.toFixed(2)),
        h('span', {}, h('b', {}, ev.typeName.replace(/^START_/, '').replace(/_/g, ' ').toLowerCase()), ' ', ev.targets.join(' → '), ev.duration > 0 ? h('span', { style: { color: 'var(--faint)' } }, ` · ${ev.duration.toFixed(2)} s`) : null,
          ev.type === 10 && ev.props.get('animation') ? h('div', { style: { color: 'var(--faint)', fontSize: '11px' } }, String(ev.props.get('animation'))) : null)))));
    } else if (tab === 'entities') {
      const names = { 0: 'unknown', 1: 'compound', 2: 'character', 3: 'camera', 4: 'monitor', 5: 'light', 6: 'sound', 7: 'marker', 9: 'scene', 10: 'sub-scene', 11: 'motion path', 12: 'deleted', 13: 'effect' };
      right.append(h('div', {}, [...script.entities.values()].sort((a, b) => a.type - b.type || a.name.localeCompare(b.name)).map(e => {
        const o = rt && rt.obj(e.name);
        return h('div', { style: { padding: '2px 4px', borderBottom: '1px solid var(--line, #222)', cursor: 'pointer', background: e === selEnt ? 'rgba(255,210,80,.12)' : '' }, onclick: () => { if (!o) return; selEnt = e; modeSel.value = 'free'; setTimeout(() => { attachGizmo(); renderTabs(); }); o.node.updateMatrixWorld(true); const p = new THREE.Vector3().setFromMatrixPosition(o.node.matrixWorld); orbit.target.copy(p); free.position.copy(p).add(new THREE.Vector3(8, 5, 12).multiplyScalar(o.model ? Math.max(1, (o.model.userData.radius || 10) / 8) : 1)); } },
          h('b', {}, e.name), h('span', { style: { color: 'var(--faint)' } }, ` · ${names[e.type] || e.type}`),
          e.template ? h('div', { style: { fontSize: '11px', color: o && o.missing ? '#ffb366' : 'var(--dim)' } }, `${e.category ? e.category + ': ' : ''}${e.template}${o && o.missing ? ' — model not found' : ''}`) : null);
      })));
    } else {
      const ta = h('textarea', { spellcheck: false, style: { width: '100%', height: 'calc(100vh - 360px)', fontFamily: 'var(--mono)', fontSize: '11px', whiteSpace: 'pre', tabSize: 4 } }); ta.value = text;
      right.append(h('div', { style: { color: 'var(--faint)', margin: '6px 0' } }, 'Decompiled script. Edit and press Apply to preview; Save writes it as a text .thn, which Freelancer reads like the compiled ones (the original is backed up).'), ta,
        h('div', { class: 'btnrow', style: { marginTop: '6px' } },
          h('button', { class: 'btn sm', onclick: async () => { try { await load(ta.value, filePath, true); toast('Script applied'); } catch (e) { toast('Script error: ' + e.message, 5000); } } }, 'Apply'),
          h('button', { class: 'btn sm primary', disabled: !filePath, onclick: async () => { try { parseThn(ta.value); await api.write(filePath, new TextEncoder().encode(ta.value.replace(/\r?\n/g, '\r\n'))); text = ta.value; toast('Saved ' + filePath.split('/').pop()); } catch (e) { toast('Not saved: ' + e.message, 5000); } } }, 'Save .thn')));
    }
  }

  async function load(src, p, keepText = false, keepView = false) {
    let parsed = parseThn(src);
    own = parsed; const prevT = rt ? rt.t : 0;
    if (!keepView) { selEnt = null; selEv = null; undoStack.length = 0; dirty = false; }
    let ctx = null;
    if (withRoom.checked && p && /\/scripts\/(bases|story)\//i.test(p)) {
      ctx = await roomContext(p).catch(() => null);
      // story scenes (s003x_…_li_01_bar_01.thn) are not named in a room INI: find the room from the file name
      const rm = !ctx && /([a-z]{2}_\d\d_[a-z]+)_\d\d[a-z]?\.thn$/i.exec(p);
      if (rm) ctx = await roomContext(`DATA/SCRIPTS/BASES/${rm[1]}_hardpoint_01.thn`).catch(() => null);
      if (ctx && rm) ctx.paths.unshift(`DATA/SCRIPTS/BASES/${rm[1]}_hardpoint_01.thn`);
      if (ctx && ctx.paths.length) {
        const extras = [];
        for (const x of ctx.paths) { const b = await api.read(x); if (b) try { extras.push({ path: x, script: parseThn(b) }); } catch (e) { console.warn(x, e); } }
        parsed = mergeScripts(parsed, extras);
      }
    }
    if (rt) rt.dispose();
    script = parsed; filePath = p; playing = false; playBtn.textContent = 'Play';
    if (!keepText) text = globalsToLua(own.globals);
    title.textContent = `${(p || '').split('/').pop()} · ${parsed.duration.toFixed(1)} s · ${own.entities.size} entities · ${own.events.length} events`;
    if (parsed.extras && parsed.extras.length) title.append(h('span', { style: { color: 'var(--faint)', fontWeight: 400 }, title: parsed.extras.join('\n') }, ` · with ${parsed.extras.length} room script${parsed.extras.length > 1 ? 's' : ''} (${ctx.room.split('/').pop()})`));
    stopSounds();
    rt = new Runtime(app, parsed, scene); rt.onSound = onSound;
    badge.textContent = 'loading models…';
    await rt.build((i, n) => { badge.textContent = `loading ${i}/${n}…`; });
    if (ctx && ctx.animation) rt.loopRoomAnimation(ctx.animation);
    slider.max = String(parsed.duration || 1);
    // free camera framing: everything that is not a starsphere
    const box = new THREE.Box3(); for (const o of rt.objects.values()) if (!o.starsphere && (o.model || o.ent.type === 3 || o.standin)) box.expandByObject(o.node);
    if (!box.isEmpty() && !keepView) { const s = box.getBoundingSphere(new THREE.Sphere()); orbit.target.copy(s.center); free.position.copy(s.center).add(new THREE.Vector3(1, 0.6, 1.2).multiplyScalar(Math.max(5, s.radius))); }
    if (keepView && selEnt) selEnt = [...own.entities.values()].find(e => lc(e.name) === lc(selEnt.name)) || null;
    if (keepView && selEvKey) { let best = null, bd = 1e9; for (const ev of own.events) if (ev.type === selEvKey.type && ev.targets.join('|') === selEvKey.tg) { const d = Math.abs(ev.time - selEvKey.time); if (d < bd) { bd = d; best = ev; } } selEv = best; } else if (keepView) selEv = null;
    seek(keepView ? prevT : 0); renderTabs(); attachGizmo(); showDirty();
  }
  async function open(p) {
    const b = await api.read(p); if (!b) { toast('Not found: ' + p); return; }
    try { await load(b, p); } catch (e) { console.error(e); toast('Cutscene error: ' + e.message, 5000); }
    [...list.children].forEach(el => el.classList.toggle('sel', el.dataset.p === p));
  }
  const files = await api.find('DATA', ['.thn']);
  const renderList = () => {
    const q = filter.value.toLowerCase(); list.innerHTML = '';
    for (const f of files.filter(x => !q || x.toLowerCase().includes(q)).slice(0, 2000)) {
      const rel = f.replace(/^DATA\//i, '');
      list.append(h('div', { 'data-p': f, style: { padding: '2px 6px', cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }, title: rel, onclick: () => open(f) }, rel.split('/').pop(), h('span', { style: { color: 'var(--faint)', fontSize: '10px' } }, ' ' + rel.split('/').slice(0, -1).join('/'))));
    }
  };
  filter.oninput = renderList; renderList(); renderTabs();
  if (path) open(path);
  return { open, seek: (t) => seek(t), get runtime() { return rt; }, get script() { return script; } };
}
