// Model & hardpoint editor.
// Hardpoints live in the UTF tree of each part:  <part>/Hardpoints/{Fixed|Revolute}/<HpName>/
//   Position (3 floats) · Orientation (3×3 floats, stored column by column — see rotFromFl)
//   Revolute adds Axis (3 floats), Min, Max (radians).
// In a .cmp the part is the file node named by Cmpnd/<part>/File name; positions are part-local.
// Saving rewrites the whole UTF file with writeUtf (round-trip verified on all 1,385 UTF files of
// the HD install); the server backs up the original on the first write of the session.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { TransformControls } from 'three/addons/TransformControls.js';
import { h, modal, toast, confirmDialog, promptDialog } from './dom.js';
import { api, dataPath } from '../api.js';
import { parseUtf, writeUtf, UtfNode } from '../formats/utf.js';
import { utfHistory } from './utfundo.js';
import { rotFromFl } from '../formats/model.js';
import { fmtNum } from '../formats/ini.js';
import { applyScript, resetPose, poseJoint, movableParts } from '../formats/anim.js';

const DEG = Math.PI / 180;
const f32 = (arr) => new Uint8Array(new Float32Array(arr).buffer);
const leaf = (name, arr) => new UtfNode(name, f32(arr));

export async function hardpointEditor(app, { path, matLibs = [], title } = {}) {
  const bytes = await api.read(path);
  if (!bytes) { toast('File not found: ' + path); return; }
  let root;
  try { root = parseUtf(bytes); } catch (e) { toast('Not a UTF model: ' + e.message); return; }
  // independent copy of the leaf payloads (parseUtf returns views into the read buffer)
  (function own(n) { if (n.isLeaf) n.data = n.data.slice(); else n.children.forEach(own); })(root);

  // ---- parts: [{ name (object name), node (file node), matrix (model space) }]
  const parts = [];
  const cmpnd = root.child('Cmpnd');
  if (cmpnd) {
    for (const p of cmpnd.children || []) {
      if (p.isLeaf || p.name.toLowerCase() === 'cons') continue;
      const on = p.child('Object name'), fn = p.child('File name');
      const node = fn && root.child(fn.str());
      if (on && node) parts.push({ name: on.str(), node, matrix: new THREE.Matrix4() });
    }
  } else parts.push({ name: 'Root', node: root, matrix: new THREE.Matrix4() });

  // ---- 3D
  const canvas = h('canvas', { style: { width: '100%', height: '100%', display: 'block', borderRadius: '6px', background: 'var(--well)' } });
  const view = h('div', { style: { position: 'relative', height: 'calc(100vh - 190px)', minHeight: '380px' } }, canvas);
  const side = h('div', { style: { height: 'calc(100vh - 190px)', overflow: 'auto', fontSize: '12px' } });
  let dirty = false;
  const titleEl = h('span');
  // every change calls setDirty(true) right after it, which records an undo step
  const H = utfHistory(root, () => { showDirty(); refresh(); });
  const showDirty = () => { dirty = H.dirty; titleEl.textContent = dirty ? ' ● unsaved' : ''; };
  const setDirty = (d) => { if (d) H.push(); else H.markSaved(); showDirty(); };
  const unbindKeys = H.bindKeys();
  const m = modal({
    title: `Hardpoints · ${title || path.split('/').pop()}`, wide: true,
    body: h('div', {}, h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 380px', gap: '12px' } }, view, side)),
    onClose: () => { unbindKeys(); running = false; renderer.dispose(); },
    buttons: [{ label: 'Close', onClick: async () => !dirty || await confirmDialog('Discard changes?', 'The model has unsaved hardpoint changes.', 'Discard', true) }, { label: 'Save model', cls: 'primary', onClick: async () => { await save(); return false; } }],
  });
  m.box.classList.add('xwide');
  m.box.querySelector('header h2').append(titleEl);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1e7);
  scene.add(new THREE.AmbientLight(0x667788, 1.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6); camera.add(sun); sun.position.set(0.3, 0.5, 1); scene.add(camera);
  const orbit = new OrbitControls(camera, canvas); orbit.enableDamping = true;
  const gizmo = new TransformControls(camera, canvas); gizmo.setSize(0.8); scene.add(gizmo.getHelper());
  gizmo.addEventListener('dragging-changed', (e) => { orbit.enabled = !e.value; if (!e.value) commitGizmo(); });
  const proxy = new THREE.Object3D(); scene.add(proxy);
  const hpGroup = new THREE.Group(); scene.add(hpGroup);
  let model = null, radius = 100;
  async function loadModel() {
    if (model) scene.remove(model);
    model = await app.rm.model(path, matLibs);
    if (!model) { toast('Model could not be built (missing material libraries?) — editing positions only'); radius = 100; }
    else {
      scene.add(model); model.updateMatrixWorld(true);
      radius = model.userData.radius || 100;
      // part matrices from the built model (same construct maths as the 3D view)
      for (const p of parts) { const o = model.getObjectByName(p.name.toLowerCase()) || model.getObjectByName(p.name); p.matrix = o ? o.matrixWorld.clone() : new THREE.Matrix4(); }
    }
    const c = model && model.userData.center ? model.userData.center : new THREE.Vector3();
    orbit.target.copy(c); camera.position.copy(c).add(new THREE.Vector3(radius * 1.6, radius * 0.9, radius * 1.8)); orbit.update();
  }
  let running = true;
  const resize = () => { const r = view.getBoundingClientRect(); renderer.setSize(r.width, r.height, false); camera.aspect = r.width / Math.max(r.height, 1); camera.updateProjectionMatrix(); };
  new ResizeObserver(resize).observe(view);
  // ---- animation playback (Cmpnd "Animation/Script" + manual joint posing)
  const anim = { script: null, t: 0, playing: false, loop: true, speed: 1, last: performance.now(), slider: null, label: null };
  const animTick = () => {
    const now = performance.now(), dt = Math.min(0.1, (now - anim.last) / 1000); anim.last = now;
    if (!anim.playing || !anim.script || !model) return;
    const dur = anim.script.duration || 0;
    anim.t += dt * anim.speed;
    if (anim.t > dur) { if (anim.loop && dur > 0) anim.t %= dur; else { anim.t = dur; anim.playing = false; refresh(false); } }
    applyScript(model, anim.script, anim.t); model.updateMatrixWorld(true);
    if (anim.slider) anim.slider.value = String(anim.t);
    if (anim.label) anim.label.textContent = `${anim.t.toFixed(2)} / ${dur.toFixed(2)} s`;
  };
  (function loop() { if (!running) return; animTick(); orbit.update(); renderer.render(scene, camera); requestAnimationFrame(loop); })();
  function animSection() {
    const scripts = (model && model.userData.animations) || [];
    const joints = model ? movableParts(model) : [];
    if (!scripts.length && !joints.length) return null;
    const sec = h('div', { class: 'psec', style: { marginTop: '8px' } }, h('h3', {}, 'Animation & moving parts'));
    if (scripts.length) {
      if (!anim.script || !scripts.includes(anim.script)) anim.script = scripts[0];
      const dur = anim.script.duration || 0;
      anim.slider = h('input', { type: 'range', min: 0, max: dur || 1, step: 0.01, value: anim.t, style: { width: '100%' }, oninput: (e) => { anim.t = +e.target.value; anim.playing = false; applyScript(model, anim.script, anim.t); model.updateMatrixWorld(true); anim.label.textContent = `${anim.t.toFixed(2)} / ${dur.toFixed(2)} s`; } });
      anim.label = h('span', { style: { fontFamily: 'var(--mono)', fontSize: '11px' } }, `${anim.t.toFixed(2)} / ${dur.toFixed(2)} s`);
      sec.append(
        h('select', { style: { width: '100%' }, onchange: (e) => { anim.script = scripts[+e.target.value]; anim.t = 0; resetPose(model); applyScript(model, anim.script, 0); model.updateMatrixWorld(true); refresh(false); } },
          scripts.map((s, i) => h('option', { value: i, selected: s === anim.script }, `${s.name} · ${s.joints.length} joint${s.joints.length === 1 ? '' : 's'} · ${(s.duration || 0).toFixed(1)} s`))),
        h('div', { class: 'btnrow', style: { margin: '4px 0', alignItems: 'center' } },
          h('button', { class: 'btn sm primary', onclick: () => { if (anim.t >= (anim.script.duration || 0)) anim.t = 0; anim.playing = !anim.playing; anim.last = performance.now(); refresh(false); } }, anim.playing ? 'Pause' : 'Play'),
          h('button', { class: 'btn sm', onclick: () => { anim.playing = false; anim.t = 0; resetPose(model); model.updateMatrixWorld(true); refresh(false); } }, 'Reset pose'),
          h('label', {}, h('input', { type: 'checkbox', checked: anim.loop, onchange: (e) => anim.loop = e.target.checked }), ' loop'),
          h('select', { onchange: (e) => anim.speed = +e.target.value }, [0.25, 0.5, 1, 2, 4].map(v => h('option', { value: v, selected: v === anim.speed }, v + '×'))),
          anim.label),
        anim.slider);
    }
    if (joints.length) {
      sec.append(h('div', { style: { fontSize: '11px', color: 'var(--faint)', margin: '6px 0 2px' } }, 'Moving parts (drag to pose — the model file is not changed)'));
      for (const o of joints) {
        const c = o.userData.cons;
        if (c.kind === 'sphere') { sec.append(h('div', { style: { fontSize: '11px' } }, `${o.name} · sphere joint`)); continue; }
        const lo = Math.min(c.min, c.max), hi = Math.max(c.min, c.max), isRev = c.kind === 'rev';
        const val = h('span', { style: { fontFamily: 'var(--mono)', fontSize: '11px', minWidth: '60px', textAlign: 'right' } }, '0');
        sec.append(h('div', { style: { display: 'grid', gridTemplateColumns: '110px 1fr 60px', gap: '6px', alignItems: 'center', fontSize: '11px' } },
          h('span', { title: `${c.kind} · axis ${c.axis.map(v => fmtNum(v, 2)).join(', ')} · ${isRev ? (lo / DEG).toFixed(0) + '°…' + (hi / DEG).toFixed(0) + '°' : lo + '…' + hi}`, style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, `${o.name} (${c.kind})`),
          h('input', { type: 'range', min: lo, max: hi || 1, step: (hi - lo) / 200 || 0.01, value: Math.max(lo, Math.min(hi, 0)), oninput: (e) => { anim.playing = false; poseJoint(o, +e.target.value); model.updateMatrixWorld(true); val.textContent = isRev ? (e.target.value / DEG).toFixed(1) + '°' : (+e.target.value).toFixed(2); } }),
          val));
      }
    }
    return sec;
  }

  // ---- hardpoint model
  // list: [{ part, kind ('Fixed'|'Revolute'), node }]
  const list = () => {
    const out = [];
    for (const p of parts) { const hp = p.node.child('Hardpoints'); if (!hp || hp.isLeaf) continue; for (const k of hp.children) if (!k.isLeaf) for (const n of k.children) if (!n.isLeaf) out.push({ part: p, kind: /revolute/i.test(k.name) ? 'Revolute' : 'Fixed', node: n }); }
    return out.sort((a, b) => a.node.name.localeCompare(b.node.name, undefined, { numeric: true }));
  };
  const getV = (n, name, len, def) => { const c = n.child(name); if (!c || c.isLeaf === false) return def; const v = c.floats(); return v.length >= len ? v.slice(0, len) : def; };
  const setV = (n, name, arr) => { let c = n.child(name); if (!c) { c = new UtfNode(name, f32(arr)); n.children.push(c); } else c.data = f32(arr); };
  const localMatrix = (hp) => { const p = getV(hp.node, 'Position', 3, [0, 0, 0]), r = getV(hp.node, 'Orientation', 9, [1, 0, 0, 0, 1, 0, 0, 0, 1]); const mm = rotFromFl(r); mm.setPosition(p[0], p[1], p[2]); return mm; };
  const writeLocal = (hp, mm) => { const e = mm.elements; setV(hp.node, 'Position', [e[12], e[13], e[14]]); const rot = new THREE.Matrix4().extractRotation(mm).elements; setV(hp.node, 'Orientation', [rot[0], rot[4], rot[8], rot[1], rot[5], rot[9], rot[2], rot[6], rot[10]]); };
  const exists = (name) => list().some(x => x.node.name.toLowerCase() === name.toLowerCase());
  const kindNode = (part, kind) => {
    let hp = part.node.child('Hardpoints'); if (!hp) { hp = new UtfNode('Hardpoints'); part.node.children.push(hp); }
    let k = hp.child(kind); if (!k) { k = new UtfNode(kind); hp.children.push(k); } return k;
  };
  const removeHp = (hp) => {
    const hpRoot = hp.part.node.child('Hardpoints'); const k = hpRoot.child(hp.kind);
    k.children = k.children.filter(c => c !== hp.node);
    if (!k.children.length) hpRoot.children = hpRoot.children.filter(c => c !== k);
    if (!hpRoot.children.length) hp.part.node.children = hp.part.node.children.filter(c => c !== hpRoot);
  };

  let selName = null, filter = '';
  const sel = () => list().find(x => x.node.name === selName) || null;

  function drawMarkers() {
    hpGroup.clear();
    const s = Math.max(radius * 0.06, 2);
    for (const hp of list()) {
      const w = hp.part.matrix.clone().multiply(localMatrix(hp));
      const g = new THREE.Group(); w.decompose(g.position, g.quaternion, new THREE.Vector3());
      const on = hp.node.name === selName;
      const ax = new THREE.AxesHelper(s * (on ? 1.6 : 1)); ax.material.depthTest = false; ax.renderOrder = 10; g.add(ax);
      const dot = new THREE.Mesh(new THREE.SphereGeometry(s * 0.12, 10, 8), new THREE.MeshBasicMaterial({ color: on ? 0xffe066 : (hp.kind === 'Revolute' ? 0x66c2ff : 0xff8866), depthTest: false }));
      dot.renderOrder = 11; dot.userData.hp = hp.node.name; g.add(dot);
      hpGroup.add(g);
    }
  }
  function attach() {
    const hp = sel();
    if (!hp) { gizmo.detach(); return; }
    const w = hp.part.matrix.clone().multiply(localMatrix(hp));
    w.decompose(proxy.position, proxy.quaternion, proxy.scale); proxy.scale.set(1, 1, 1); proxy.updateMatrixWorld(true);
    gizmo.attach(proxy);
  }
  function commitGizmo() {
    const hp = sel(); if (!hp) return;
    proxy.updateMatrixWorld(true);
    const local = hp.part.matrix.clone().invert().multiply(proxy.matrixWorld);
    writeLocal(hp, local); setDirty(true); refresh(false);
  }
  // click a marker to select it; Shift+click on the model adds a hardpoint at that point
  const ray = new THREE.Raycaster();
  canvas.addEventListener('pointerdown', (e) => { canvas._down = [e.clientX, e.clientY]; });
  canvas.addEventListener('pointerup', (e) => {
    if (!canvas._down || Math.hypot(e.clientX - canvas._down[0], e.clientY - canvas._down[1]) > 4 || gizmo.dragging) return;
    const r = canvas.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
    const hits = ray.intersectObjects(hpGroup.children, true).filter(x => x.object.userData.hp);
    if (hits.length && !e.shiftKey) { selName = hits[0].object.userData.hp; refresh(); return; }
    if (e.shiftKey && model) { const mh = ray.intersectObject(model, true)[0]; if (mh) addHp(mh.point, mh.face ? mh.face.normal.clone().transformDirection(mh.object.matrixWorld) : null); }
  });

  async function addHp(worldPoint = null, normal = null, template = null) {
    const base = template ? template.node.name.replace(/\d+$/, '') : 'HpNew';
    let i = 1, nn; do { nn = `${base}${String(i++).padStart(2, '0')}`; } while (exists(nn));
    nn = (await promptDialog(template ? 'Duplicate hardpoint' : 'New hardpoint', 'Name (e.g. HpDockMount01, HpTurret01, HpFX01)', nn) || '').trim();
    if (!nn) return; if (exists(nn)) { toast('Name already used'); return; }
    const part = template ? template.part : (parts.find(p => p.name.toLowerCase() === 'root') || parts[0]);
    const kind = template ? template.kind : 'Fixed';
    const node = new UtfNode(nn);
    let local = template ? localMatrix(template) : new THREE.Matrix4();
    if (worldPoint) {
      const w = new THREE.Matrix4();
      if (normal) w.lookAt(new THREE.Vector3(), normal, Math.abs(normal.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)); // +Z out of the surface
      w.setPosition(worldPoint);
      local = part.matrix.clone().invert().multiply(w);
    } else if (template) local.elements[12] += radius * 0.05;
    node.children.push(leaf('Orientation', [1, 0, 0, 0, 1, 0, 0, 0, 1]), leaf('Position', [0, 0, 0]));
    if (kind === 'Revolute') { const src = template && template.node; node.children.push(leaf('Axis', src ? getV(src, 'Axis', 3, [0, 1, 0]) : [0, 1, 0]), leaf('Min', src ? getV(src, 'Min', 1, [-Math.PI]) : [-Math.PI]), leaf('Max', src ? getV(src, 'Max', 1, [Math.PI]) : [Math.PI])); }
    kindNode(part, kind).children.push(node);
    writeLocal({ node }, local);
    selName = nn; setDirty(true); refresh();
  }

  // ---- side panel
  function refresh(rebuildGizmo = true) {
    drawMarkers(); if (rebuildGizmo) attach();
    side.innerHTML = '';
    const all = list();
    const q = h('input', { value: filter, placeholder: `Filter ${all.length} hardpoints…`, style: { width: '100%' }, oninput: (e) => { filter = e.target.value.toLowerCase(); renderList(); } });
    const lst = h('div', { class: 'reflist', style: { maxHeight: '34vh', overflow: 'auto', margin: '6px 0' } });
    const renderList = () => {
      lst.innerHTML = '';
      for (const hp of all.filter(x => !filter || x.node.name.toLowerCase().includes(filter))) lst.append(h('div', { style: { padding: '2px 6px', cursor: 'pointer', background: hp.node.name === selName ? 'rgba(255,210,80,0.12)' : '' }, onclick: () => { selName = hp.node.name; refresh(); } },
        hp.node.name, h('span', { style: { float: 'right', color: 'var(--faint)', fontSize: '11px' } }, `${hp.kind.toLowerCase()}${parts.length > 1 ? ' · ' + hp.part.name : ''}`)));
    };
    renderList();
    side.append(h('div', { class: 'btnrow' },
      h('button', { class: 'btn sm primary', onclick: () => addHp() }, '+ Hardpoint'),
      h('button', { class: 'btn sm', disabled: !sel(), onclick: () => addHp(null, null, sel()) }, 'Duplicate'),
      h('button', { class: 'btn sm danger', disabled: !sel(), onclick: () => { const hp = sel(); if (hp) { removeHp(hp); selName = null; setDirty(true); refresh(); } } }, 'Delete'),
      h('button', { class: 'btn sm', title: 'Open the raw UTF tree of this file (close this window first if you have unsaved hardpoint changes)', onclick: () => import('./utfbrowser.js').then(u => u.utfBrowser(app, { path, title })) }, 'UTF…'),
      h('button', { class: 'btn sm', title: 'Gizmo mode', onclick: () => { gizmo.setMode(gizmo.mode === 'translate' ? 'rotate' : 'translate'); refresh(false); } }, gizmo.mode === 'translate' ? 'Move' : 'Rotate')),
      h('div', { style: { fontSize: '11px', color: 'var(--faint)', margin: '4px 0' } }, 'Click a marker to select · Shift+click the model to add a hardpoint there (Z axis out of the surface) · drag the gizmo to move/rotate.'),
      q, lst);
    const animEl = animSection(); if (animEl) side.append(animEl);
    const hp = sel();
    if (!hp) { side.append(h('div', { class: 'empty' }, 'No hardpoint selected.')); return; }
    const L = localMatrix(hp), p = new THREE.Vector3(), qq = new THREE.Quaternion(); L.decompose(p, qq, new THREE.Vector3());
    const eul = new THREE.Euler().setFromQuaternion(qq, 'XYZ');
    const num = (val, on, step = 1) => h('input', { type: 'number', value: fmtNum(val, 3), step, style: { width: '100%' }, onchange: (e) => on(parseFloat(e.target.value) || 0) });
    const setPos = (i, v) => { const a = [p.x, p.y, p.z]; a[i] = v; L.setPosition(a[0], a[1], a[2]); writeLocal(hp, L); setDirty(true); refresh(); };
    const setRot = (i, v) => { const a = [eul.x, eul.y, eul.z]; a[i] = v * DEG; const R = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(a[0], a[1], a[2], 'XYZ')); R.setPosition(p); writeLocal(hp, R); setDirty(true); refresh(); };
    const det = h('div', { class: 'psec', style: { marginTop: '8px' } },
      h('h3', {}, hp.node.name, h('span', { class: 'act' }, h('button', { class: 'btn sm', onclick: async () => { const nn = (await promptDialog('Rename hardpoint', 'New name', hp.node.name) || '').trim(); if (!nn || nn === hp.node.name) return; if (exists(nn)) { toast('Name already used'); return; } hp.node.name = nn; selName = nn; setDirty(true); refresh(); } }, 'Rename…'))),
      h('div', { class: 'kv' },
        h('div', { class: 'k' }, 'type'), h('div', { class: 'v' }, h('select', { onchange: (e) => { const nk = e.target.value; removeHp(hp); kindNode(hp.part, nk).children.push(hp.node); if (nk === 'Revolute') { if (!hp.node.child('Axis')) hp.node.children.push(leaf('Axis', [0, 1, 0]), leaf('Min', [-Math.PI]), leaf('Max', [Math.PI])); } else hp.node.children = hp.node.children.filter(c => !/^(axis|min|max)$/i.test(c.name)); setDirty(true); refresh(); } }, ['Fixed', 'Revolute'].map(k => h('option', { selected: hp.kind === k }, k)))), h('span'),
        parts.length > 1 ? [h('div', { class: 'k' }, 'part'), h('div', { class: 'v' }, h('select', { onchange: (e) => { const np = parts.find(x => x.name === e.target.value); const world = hp.part.matrix.clone().multiply(L); removeHp(hp); kindNode(np, hp.kind).children.push(hp.node); writeLocal({ node: hp.node }, np.matrix.clone().invert().multiply(world)); setDirty(true); refresh(); } }, parts.map(x => h('option', { selected: x === hp.part }, x.name)))), h('span')] : null),
      h('div', { style: { fontSize: '11px', color: 'var(--faint)', margin: '6px 0 2px' } }, `position (${parts.length > 1 ? 'part' : 'model'} space)`),
      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '4px' } }, num(p.x, v => setPos(0, v)), num(p.y, v => setPos(1, v)), num(p.z, v => setPos(2, v))),
      h('div', { style: { fontSize: '11px', color: 'var(--faint)', margin: '6px 0 2px' } }, 'rotation (degrees, X → Y → Z)'),
      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '4px' } }, num(eul.x / DEG, v => setRot(0, v), 5), num(eul.y / DEG, v => setRot(1, v), 5), num(eul.z / DEG, v => setRot(2, v), 5)),
      h('div', { class: 'btnrow', style: { marginTop: '6px' } },
        h('button', { class: 'btn sm', onclick: () => { L.makeRotationFromEuler(new THREE.Euler()); L.setPosition(p); writeLocal(hp, L); setDirty(true); refresh(); } }, 'Reset rotation'),
        h('button', { class: 'btn sm', onclick: () => { orbit.target.copy(proxy.position); orbit.update(); } }, 'Focus')));
    if (hp.kind === 'Revolute') {
      const ax = getV(hp.node, 'Axis', 3, [0, 1, 0]), mn = getV(hp.node, 'Min', 1, [0])[0], mx = getV(hp.node, 'Max', 1, [0])[0];
      det.append(h('div', { style: { fontSize: '11px', color: 'var(--faint)', margin: '8px 0 2px' } }, 'revolute: axis · min / max (degrees)'),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '4px' } }, ...[0, 1, 2].map(i => num(ax[i], v => { const a = ax.slice(); a[i] = v; setV(hp.node, 'Axis', a); setDirty(true); refresh(false); }, 0.1)),
          num(mn / DEG, v => { setV(hp.node, 'Min', [v * DEG]); setDirty(true); refresh(false); }, 5), num(mx / DEG, v => { setV(hp.node, 'Max', [v * DEG]); setDirty(true); refresh(false); }, 5)));
    }
    side.append(det);
  }

  async function save() {
    try {
      const out = writeUtf(root);
      await api.write(path, out);
      setDirty(false);
      app.rm.invalidate(path);
      toast('Saved ' + path.split('/').pop() + ' (original backed up)');
      await loadModel(); refresh();
      app.rebuildVisuals && app.rebuildVisuals();
    } catch (e) { toast('Save failed: ' + (e.message || e)); }
  }

  await loadModel();
  refresh();
}

// Tools → Model & hardpoint editor: pick an archetype, open its model
export async function openHardpointEditorFor(app, archNick) {
  const a = app.game.arch(archNick);
  if (!a || !a.da) { toast('Archetype has no model'); return; }
  return hardpointEditor(app, { path: dataPath(a.da), matLibs: a.matLibs.map(dataPath), title: `${a.nickname} (${a.da.split('\\').pop()})` });
}
