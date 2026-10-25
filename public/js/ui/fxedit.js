// Particle effect (.ale) editor: pick a [VisEffect], see it live, edit every node parameter
// (scalars, textures, blend modes, float/colour animations, curves, node transforms) and save the
// .ale back. Writing uses formats/ale.js writeAleNodes (byte-exact on all 625 vanilla .ale files)
// + writeUtf.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { h, modal, toast, confirmDialog } from './dom.js';
import { parseAle, writeAleNodes, PROP_NAMES, PROP_TYPE_NAMES, P, CurveAnim, AleTransform } from '../formats/ale.js';
import { writeUtf } from '../formats/utf.js';
import { FxLibrary, FxInstance } from '../fx.js';
import { api, dataPath } from '../api.js';
import { searchPicker } from './picker.js';

const EASE = ['Step', 'Linear', 'Ease in', 'Ease out', 'Ease in-out', 'Ease (auto)'];
const BLENDS = ['', 'Zero', 'One', 'SrcColor', 'InvSrcColor', 'SrcAlpha', 'InvSrcAlpha', 'DstAlpha', 'InvDstAlpha', 'DstColor', 'InvDstColor', 'SrcAlphaSat'];
const TR_LABEL = { tx: 'Translate X', ty: 'Translate Y', tz: 'Translate Z', rx: 'Pitch°', ry: 'Yaw°', rz: 'Roll°', sx: 'Scale X', sy: 'Scale Y', sz: 'Scale Z' };
const propLabel = (prop) => (PROP_NAMES.get(prop >>> 0) || '0x' + (prop >>> 0).toString(16)).replace(/_/g, ' › ');
const hex = (c) => '#' + c.map(v => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('');
const unhex = (s) => [1, 3, 5].map(i => parseInt(s.slice(i, i + 2), 16) / 255);
const fmt = (v) => (Math.round(v * 1e4) / 1e4).toString();

export async function fxEditor(app, { vis = null } = {}) {
  const g = app.game;
  const visList = [...g.visEffects.entries()].filter(([, v]) => v.alchemy).map(([k, v]) => ({ value: k, sub: v.alchemy }));
  if (!vis) vis = await searchPicker(app, { title: 'Particle effect — choose a [VisEffect]', items: visList });
  if (!vis) return;

  let V, path, ale, effect, inst = null, selNode = null, dirty = false, sparam = 0, speed = 1, paused = false;
  const undo = [], redo = [], docListeners = [];
  const dropListeners = () => { for (const [ev, f] of docListeners) document.removeEventListener(ev, f); docListeners.length = 0; };
  // ---------- preview
  const canvas = h('canvas', { style: { width: '100%', height: '100%', display: 'block', borderRadius: '6px', background: '#05070b' } });
  const pvInfo = h('div', { style: { position: 'absolute', left: '8px', bottom: '6px', fontSize: '11px', color: 'var(--faint)', pointerEvents: 'none' } });
  const pv = h('div', { style: { position: 'relative', height: '100%', minHeight: '360px' } }, canvas, pvInfo);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1e6);
  const grid = new THREE.GridHelper(20, 20, 0x334455, 0x1a2230); grid.material.transparent = true; grid.material.opacity = 0.5; scene.add(grid);
  const orbit = new OrbitControls(camera, canvas); orbit.enableDamping = true;
  const ro = new ResizeObserver(() => { const r = pv.getBoundingClientRect(); if (!r.width) return; renderer.setSize(r.width, r.height, false); camera.aspect = r.width / r.height; camera.updateProjectionMatrix(); }); ro.observe(pv);
  let running = true, last = performance.now();
  (function loop() {
    if (!running) return;
    const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000) * speed; last = now;
    orbit.update();
    if (inst) { if (!paused) inst.update(dt); inst.object.updateWorldMatrix(true, true); inst.draw(camera); pvInfo.textContent = `t = ${inst.time.toFixed(2)} s · ${inst.particles.reduce((a, l) => a + l.length, 0)} particles`; }
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  })();

  async function restart(fit = false) {
    if (inst) { scene.remove(inst.object); inst.dispose(); }
    inst = null;
    let lib; try { lib = new FxLibrary(ale, path); } catch (e) { pvInfo.textContent = 'preview failed: ' + e.message; return; }
    const ef = lib.find(V.crc); if (!ef) { pvInfo.textContent = 'effect crc not found in file'; return; }
    inst = new FxInstance(ef, app.rm, sparam, app.fx.instanceOpts());
    scene.add(inst.object);
    if (fit) {
      for (let i = 0; i < 60; i++) inst.update(1 / 30);
      let R = 0; for (const l of inst.particles) for (const p of l) R = Math.max(R, p.pos.length() + 1);
      R = Math.max(2, Math.min(5000, R || 10));
      grid.scale.setScalar(R / 10); orbit.target.set(0, 0, 0); camera.position.set(R * 1.3, R * 0.9, R * 1.8); camera.near = R / 1000; camera.far = R * 1000; camera.updateProjectionMatrix();
      scene.remove(inst.object); inst.dispose(); inst = new FxInstance(ef, app.rm, sparam, app.fx.instanceOpts()); scene.add(inst.object);
    }
  }
  let rebuildT = 0;
  const changed = () => { dirty = true; title(); clearTimeout(rebuildT); rebuildT = setTimeout(() => restart(false), 120); };
  const snapshot = () => { undo.push(fileBytes()); if (undo.length > 100) undo.shift(); redo.length = 0; };
  // same-size edits are patched straight into the original file bytes (byte-exact elsewhere);
  // structural edits (keyframes added/removed…) rewrite the UTF with writeUtf.
  let base = null, leafOff = 0, leafLen = 0;
  const fileBytes = () => {
    const d = writeAleNodes(ale.nodes);
    if (base && d.length === leafLen) { const out = base.slice(); out.set(d, leafOff); return out; }
    ale.nodeLeaf.data = d; return writeUtf(ale.root);
  };

  async function load(nick) {
    V = g.visEffects.get(nick); path = dataPath(V.alchemy); vis = nick;
    await app.fx.loadShapes();
    await Promise.all((V.textures || []).map(t => app.rm.loadUtf(dataPath(t))));
    const b = await api.read(path); if (!b) { toast('Cannot read ' + V.alchemy); return false; }
    base = b.slice(); ale = parseAle(b); if (ale.truncated) toast(`${V.alchemy}: part of this effect file could not be read (${ale.truncated}). It is shown as far as it was read; saving it is blocked so nothing is lost.`, 9000); leafOff = ale.nodeLeaf ? ale.nodeLeaf.data.byteOffset - b.byteOffset : 0; leafLen = ale.nodeLeaf ? ale.nodeLeaf.data.length : -1; effect = ale.effects.find(e => e.crc === V.crc) || (ale.effects.length === 1 ? ale.effects[0] : null);
    selNode = null; dirty = false; undo.length = redo.length = 0;
    await restart(true); renderTree(); renderProps(); title();
    return true;
  }

  // ---------- layout
  const tree = h('div', { class: 'reflist', style: { overflow: 'auto', height: '100%', fontSize: '12px' } });
  const props = h('div', { style: { overflow: 'auto', height: '100%', fontSize: '12px', paddingRight: '6px' } });
  const sp = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: 0, style: { width: '120px' }, oninput: (e) => { sparam = parseFloat(e.target.value); restart(false); }, onchange: () => restart(true) });
  const speedSel = h('select', { onchange: (e) => (speed = parseFloat(e.target.value)) }, ...[0.25, 0.5, 1, 2].map(s => h('option', { value: s, selected: s === 1 }, s + '×')));
  const pauseBtn = h('button', { class: 'btn', onclick: () => { paused = !paused; pauseBtn.textContent = paused ? '▶ Play' : '❚❚ Pause'; } }, '❚❚ Pause');
  const bar = h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '8px', flexWrap: 'wrap' } },
    h('button', { class: 'btn', onclick: async () => { if (dirty && !(await confirmDialog('Discard changes?', 'This effect has unsaved changes.', 'Discard', true))) return; const n = await searchPicker(app, { title: 'Particle effect', items: visList, current: vis }); if (n) load(n); } }, 'Effect…'),
    h('button', { class: 'btn', onclick: () => restart(false) }, '↻ Restart'), h('button', { class: 'btn', title: 'Frame the effect', onclick: () => restart(true) }, 'Fit'), pauseBtn, speedSel,
    h('label', { style: { display: 'flex', gap: '4px', alignItems: 'center' }, title: 'sparam: the per-instance parameter (e.g. engine throttle) that blends between curve items' }, 'sparam', sp),
    h('span', { style: { flex: 1 } }),
    h('button', { class: 'btn', onclick: () => doUndo(), title: 'Ctrl+Z' }, '↶'), h('button', { class: 'btn', onclick: () => doRedo(), title: 'Ctrl+Y' }, '↷'));
  const body = h('div', {}, bar, h('div', { style: { display: 'grid', gridTemplateColumns: '270px 1fr 430px', gap: '10px', height: '68vh' } }, tree, pv, props));
  const m = modal({
    title: 'Particle effect', wide: true, body,
    onClose: () => { dropListeners(); running = false; ro.disconnect(); renderer.dispose(); document.removeEventListener('keydown', keys, true); },
    buttons: [{ label: 'Close' }, { label: 'Revert', onClick: async () => { await load(vis); return false; } }, { label: 'Save .ale', cls: 'primary', onClick: () => { save(); return false; } }],
  });
  m.box.classList.add('xwide');
  const title = () => { const t = m.box.querySelector('header h2'); const s = `Particle effect · ${vis} · ${V ? V.alchemy : ''}${dirty ? ' •' : ''}`; if (t) t.textContent = s; };
  const keys = (e) => { if (!(e.ctrlKey || e.metaKey) || e.target.tagName === 'INPUT') return; const k = e.key.toLowerCase(); if (k === 'z' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); doUndo(); } else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); e.stopPropagation(); doRedo(); } };
  document.addEventListener('keydown', keys, true);
  function restore(bytes) { const name = selNode && selNode.name; ale = parseAle(bytes); effect = ale.effects.find(e => e.crc === V.crc) || ale.effects[0]; selNode = ale.nodes.find(n => n.name === name) || null; dirty = true; title(); restart(false); renderTree(); renderProps(); }
  function doUndo() { if (!undo.length) return; redo.push(fileBytes()); restore(undo.pop()); }
  function doRedo() { if (!redo.length) return; undo.push(fileBytes()); restore(redo.pop()); }
  async function save() {
    try {
      const out = fileBytes();
      await api.write(path, out);
      app.fx.libs.delete(V.alchemy.toLowerCase());
      dirty = false; title(); toast(`Saved ${V.alchemy} (original kept in backups)`);
    } catch (e) { toast('Save failed: ' + e.message, 5000); }
  }

  // ---------- node tree (effect hierarchy; nodes of other effects in the same file listed below)
  function renderTree() {
    tree.innerHTML = '';
    const byCrc = new Map(ale.nodes.map(n => [n.crc, n]));
    const used = new Set();
    const row = (n, depth, extra = '') => {
      const kind = /Emitter$/.test(n.cls) ? 'emitter' : /Appearance$/.test(n.cls) ? 'appearance' : /Field$/.test(n.cls) ? 'field' : 'node';
      const col = { emitter: '#7fb7ff', appearance: '#ffb86b', field: '#b48cff', node: '#9aa' }[kind];
      return h('div', { class: selNode === n ? 'sel' : '', style: { padding: `2px 6px 2px ${6 + depth * 14}px`, cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }, title: n.name, onclick: () => { selNode = n; renderTree(); renderProps(); } },
        h('span', { style: { color: col } }, '● '), n.name, h('span', { style: { color: 'var(--faint)', marginLeft: '6px', fontSize: '10px' } }, n.cls.replace(/^Fx/, '') + extra));
    };
    if (effect) {
      tree.append(h('div', { class: 'sub', style: { padding: '4px 6px', color: 'var(--faint)' } }, `effect “${effect.name}”`));
      const refs = new Map(effect.refs.map(r => [r.index, r]));
      const kids = (idx) => effect.refs.filter(r => r.parent === idx);
      const walk = (r, d) => {
        const n = r.flag === 1 ? null : byCrc.get(r.crc);
        if (n) { used.add(n); tree.append(row(n, d)); }
        else tree.append(h('div', { style: { padding: `2px 6px 2px ${6 + d * 14}px`, color: 'var(--faint)' } }, r.flag === 1 ? '⚓ attachment' : '? missing node'));
        for (const c of kids(r.index)) walk(c, d + 1);
      };
      for (const r of effect.refs.filter(r => r.parent === 32768 || !refs.has(r.parent))) walk(r, 0);
      const links = effect.pairs.map(([a, b]) => [refs.get(a), refs.get(b)]).filter(([a, b]) => a && b).map(([a, b]) => `${(byCrc.get(a.crc) || {}).name} → ${(byCrc.get(b.crc) || {}).name}`);
      if (links.length) tree.append(h('div', { style: { padding: '8px 6px 2px', color: 'var(--faint)', fontSize: '10px' } }, 'emitter → appearance', ...links.map(l => h('div', {}, l))));
    }
    const rest = ale.nodes.filter(n => !used.has(n));
    if (rest.length) { tree.append(h('div', { style: { padding: '8px 6px 2px', color: 'var(--faint)' } }, `other nodes in file (${rest.length})`)); for (const n of rest) tree.append(row(n, 0)); }
  }

  // ---------- property editor
  function renderProps() {
    props.innerHTML = ''; dropListeners();
    if (!selNode) { props.append(h('div', { class: 'empty' }, 'Select a node on the left. Emitters (blue) spawn particles, appearances (orange) draw them; the arrow list shows which emitter feeds which appearance.')); return; }
    const n = selNode;
    props.append(h('h3', { style: { margin: '0 0 6px' } }, n.name), h('div', { class: 'sub', style: { color: 'var(--faint)', marginBottom: '8px' } }, n.cls));
    for (const o of n.order) {
      if (o.prop === P.Node_Name) continue;
      const v = n.params.get(o.prop), type = o.id & 0x7FFF;
      const box = h('div', { class: 'fxprop' });
      const head = h('div', { class: 'fxhead' }, h('span', {}, propLabel(o.prop)), h('span', { class: 'fxtype' }, PROP_TYPE_NAMES[type] || type));
      box.append(head);
      const set = (val) => { snapshot(); n.params.set(o.prop, val); changed(); };
      if (type === 0x001) head.prepend(h('input', { type: 'checkbox', checked: !!v, onchange: (e) => set(e.target.checked) }));
      else if (type === 0x002) box.append(h('input', { type: 'number', step: 1, value: v, onchange: (e) => set(parseInt(e.target.value) >>> 0) }));
      else if (type === 0x003) box.append(h('input', { type: 'number', step: 'any', value: fmt(v), onchange: (e) => set(parseFloat(e.target.value) || 0) }));
      else if (type === 0x103) {
        const dl = 'fxtex' + Math.random().toString(36).slice(2);
        box.append(h('input', { value: v, list: o.prop === P.BasicApp_TexName ? dl : null, style: { width: '100%' }, onchange: (e) => set(e.target.value) }));
        if (o.prop === P.BasicApp_TexName) box.append(h('datalist', { id: dl }, ...[...app.rm.textures.keys()].filter(k => !/_\d+$/.test(k) || true).slice(0, 3000).map(k => h('option', { value: k }))));
      }
      else if (type === 0x104) box.append(h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } }, 'src', blendSel(v[0], (x) => set([x, v[1]])), 'dst', blendSel(v[1], (x) => set([v[0], x])),
        h('span', { class: 'sub', style: { color: 'var(--faint)' } }, v[0] === 5 && v[1] === 2 ? 'additive' : v[0] === 5 && v[1] === 6 ? 'alpha blend' : '')));
      else if (type === 0x105) box.append(transformEditor(v));
      else if (type === 0x200 || type === 0x201 || type === 0x202) box.append(animEditor(v, type));
      props.append(box);
    }
  }
  const blendSel = (cur, on) => h('select', { onchange: (e) => on(parseInt(e.target.value)) }, ...BLENDS.map((b, i) => i ? h('option', { value: i, selected: i === cur }, b) : null).filter(Boolean));

  function transformEditor(tr) {
    const wrap = h('div');
    if (!tr.has) {
      wrap.append(h('button', { class: 'btn', onclick: () => { snapshot(); const parts = {}; for (const k of Object.keys(TR_LABEL)) parts[k] = CurveAnim.constant(k[0] === 's' ? 1 : 0); const nt = new AleTransform(parts); nt.hdr = tr.hdr; selNode.params.set(P.Node_Transform, nt); changed(); renderProps(); } }, '+ Add transform'));
      return wrap;
    }
    for (const k of Object.keys(TR_LABEL)) {
      const c = tr[k];
      const d = h('details', { open: c.animates }, h('summary', {}, TR_LABEL[k], ' ', h('span', { class: 'sub', style: { color: 'var(--faint)' } }, c.animates ? 'animated' : '= ' + fmt(c.items[0] ? c.items[0].value : 0))), animEditor(c, 0x202, () => { tr.animates = Object.keys(TR_LABEL).some(q => tr[q].animates); }));
      wrap.append(d);
    }
    return wrap;
  }

  // Float/colour animation (over particle life 0…1) or curve (over effect time, seconds)
  function animEditor(anim, type, after = null) {
    const isColor = type === 0x201, isCurve = type === 0x202;
    const wrap = h('div');
    let itIdx = 0;
    const done = () => { after && after(); changed(); draw(); table(); };
    const head = h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap', margin: '4px 0' } });
    const cv = h('canvas', { width: 400, height: 110, style: { width: '100%', height: '110px', background: 'rgba(255,255,255,0.03)', borderRadius: '4px', cursor: 'crosshair' } });
    const tb = h('div');
    wrap.append(head, cv, tb);
    const item = () => anim.items[itIdx];
    function heads() {
      head.innerHTML = '';
      if (anim.items.length > 1 || true) {
        head.append(h('span', { class: 'sub', style: { color: 'var(--faint)' } }, 'sparam'));
        anim.items.forEach((it, i) => head.append(h('button', { class: 'btn ' + (i === itIdx ? 'primary' : ''), style: { padding: '0 6px' }, onclick: () => { itIdx = i; heads(); draw(); table(); } }, fmt(it.sparam))));
        head.append(h('button', { class: 'btn', style: { padding: '0 6px' }, title: 'Add an item for another sparam value (blended between)', onclick: () => { snapshot(); const c = JSON.parse(JSON.stringify(item())); c.sparam = Math.min(1, item().sparam + 0.5); anim.items.push(c); anim.items.sort((a, b) => a.sparam - b.sparam); itIdx = anim.items.indexOf(c); heads(); done(); } }, '+'));
        if (anim.items.length > 1) head.append(h('button', { class: 'btn', style: { padding: '0 6px' }, onclick: () => { snapshot(); anim.items.splice(itIdx, 1); itIdx = 0; heads(); done(); } }, '−'));
      }
      if (!isCurve) head.append(h('span', { style: { marginLeft: 'auto' } }, h('select', { title: 'easing between keyframes', onchange: (e) => { snapshot(); item().type = parseInt(e.target.value); done(); } }, ...EASE.map((x, i) => h('option', { value: i, selected: item().type === i }, x)))));
    }
    // keyframe accessors normalised to {t, v}
    const kfs = () => isCurve ? item().kf : item().kf.map(([t, v]) => ({ t, v }));
    const setKf = (i, t, v) => { if (isCurve) { item().kf[i].t = t; if (v != null) item().kf[i].v = v; } else { item().kf[i][0] = t; if (v != null) item().kf[i][1] = v; } };
    const range = () => {
      const K = kfs(); const tMax = isCurve ? Math.max(1, ...K.map(k => k.t)) : 1;
      if (isColor) return { tMax, lo: 0, hi: 1 };
      const vals = isCurve && !K.length ? [item().value] : K.map(k => k.v);
      let lo = Math.min(0, ...vals), hi = Math.max(...vals, lo + 1e-3); const pad = (hi - lo) * 0.12 || 1; return { tMax, lo: lo - (lo < 0 ? pad : 0), hi: hi + pad };
    };
    function draw() {
      const c = cv.getContext('2d'), W = cv.width, H = cv.height; c.clearRect(0, 0, W, H);
      const R = range(), X = (t) => 6 + t / R.tMax * (W - 12), Y = (v) => H - 6 - (v - R.lo) / (R.hi - R.lo) * (H - 12);
      c.strokeStyle = 'rgba(255,255,255,0.08)'; c.beginPath(); c.moveTo(0, Y(0)); c.lineTo(W, Y(0)); c.stroke();
      const it = item();
      if (isColor) {
        for (let x = 0; x < W; x++) { const col = anim.itemValue(it, x / W); c.fillStyle = hex(col); c.fillRect(x, 0, 1, H - 20); }
        for (const k of kfs()) { c.fillStyle = '#fff'; c.beginPath(); c.moveTo(X(k.t), H - 18); c.lineTo(X(k.t) - 5, H - 4); c.lineTo(X(k.t) + 5, H - 4); c.fill(); }
        return;
      }
      c.strokeStyle = '#6cf'; c.lineWidth = 1.5; c.beginPath();
      for (let x = 0; x <= W; x += 2) { const t = (x - 6) / (W - 12) * R.tMax; const v = isCurve ? anim.itemValue(it, t) : anim.itemValue(it, Math.max(0, Math.min(1, t))); x ? c.lineTo(x, Y(v)) : c.moveTo(x, Y(v)); }
      c.stroke();
      for (const k of kfs()) { c.fillStyle = '#ffe066'; c.fillRect(X(k.t) - 3, Y(k.v) - 3, 6, 6); }
      c.fillStyle = 'rgba(255,255,255,0.45)'; c.font = '10px sans-serif'; c.fillText(fmt(R.hi), 2, 10); c.fillText(fmt(R.lo), 2, H - 2); c.fillText(isCurve ? `${fmt(R.tMax)} s` : 'life →', W - 40, H - 2);
    }
    // drag keyframes
    let drag = -1, R0 = null;
    cv.onmousedown = (e) => {
      const r = cv.getBoundingClientRect(), sx = cv.width / r.width, mx = (e.clientX - r.left) * sx, my = (e.clientY - r.top) * (cv.height / r.height);
      R0 = range(); const X = (t) => 6 + t / R0.tMax * (cv.width - 12), Y = (v) => cv.height - 6 - (v - R0.lo) / (R0.hi - R0.lo) * (cv.height - 12);
      const K = kfs(); drag = K.findIndex(k => Math.abs(X(k.t) - mx) < 7 && (isColor || Math.abs(Y(k.v) - my) < 7));
      if (drag >= 0) snapshot();
    };
    const mm = (e) => {
      if (drag < 0) return;
      const r = cv.getBoundingClientRect(), mx = (e.clientX - r.left) * (cv.width / r.width), my = (e.clientY - r.top) * (cv.height / r.height);
      const K = kfs(); const lo = drag > 0 ? K[drag - 1].t : 0, hi = drag < K.length - 1 ? K[drag + 1].t : (isCurve ? Infinity : 1);
      let t = (mx - 6) / (cv.width - 12) * R0.tMax; t = Math.max(lo, Math.min(hi, t)); if (drag === 0 && !isCurve) t = K[0].t;
      const v = isColor ? null : R0.lo + (cv.height - 6 - my) / (cv.height - 12) * (R0.hi - R0.lo);
      setKf(drag, t, v); after && after(); changed(); draw();
    };
    const mu = () => { if (drag >= 0) { drag = -1; table(); } };
    document.addEventListener('mousemove', mm); document.addEventListener('mouseup', mu); docListeners.push(['mousemove', mm], ['mouseup', mu]);

    function table() {
      tb.innerHTML = '';
      const it = item();
      const t = h('table', { class: 'grid fxkf' });
      const num = (val, on, step = 'any') => h('input', { type: 'number', step, value: fmt(val), onchange: (e) => { snapshot(); on(parseFloat(e.target.value) || 0); done(); } });
      if (isCurve) {
        if (!it.kf.length) {
          tb.append(h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } }, 'constant', num(it.value, (x) => (it.value = x)),
            h('button', { class: 'btn', onclick: () => { snapshot(); it.kf.push({ t: 0, v: it.value, end: 0, start: 0 }, { t: 1, v: it.value, end: 0, start: 0 }); done(); } }, 'Animate')));
          return;
        }
        t.append(h('tr', {}, ...['time s', 'value', 'tan in', 'tan out', ''].map(x => h('th', {}, x))));
        it.kf.forEach((k, i) => t.append(h('tr', {}, h('td', {}, num(k.t, (x) => (k.t = x))), h('td', {}, num(k.v, (x) => (k.v = x))), h('td', {}, num(k.end, (x) => (k.end = x))), h('td', {}, num(k.start, (x) => (k.start = x))),
          h('td', {}, h('button', { class: 'btn', onclick: () => { snapshot(); it.kf.splice(i, 1); done(); } }, '×')))));
        tb.append(t, h('div', { style: { display: 'flex', gap: '6px', marginTop: '4px' } },
          h('button', { class: 'btn', onclick: () => { snapshot(); const l = it.kf[it.kf.length - 1]; it.kf.push({ t: l.t + 1, v: l.v, end: 0, start: 0 }); done(); } }, '+ keyframe'),
          h('label', {}, h('input', { type: 'checkbox', checked: it.flags === 16, onchange: (e) => { snapshot(); it.flags = e.target.checked ? 16 : 0; done(); } }), ' loop'),
          h('button', { class: 'btn', onclick: () => { snapshot(); it.value = it.kf[0].v; it.kf.length = 0; it.flags = 0; done(); } }, 'Make constant')));
        return;
      }
      t.append(h('tr', {}, h('th', {}, 'life'), h('th', {}, isColor ? 'colour' : 'value'), h('th', {})));
      it.kf.forEach((k, i) => t.append(h('tr', {}, h('td', {}, num(k[0], (x) => (k[0] = Math.max(0, Math.min(1, x))))),
        h('td', {}, isColor ? h('input', { type: 'color', value: hex(k[1]), onchange: (e) => { snapshot(); k[1] = unhex(e.target.value); done(); } }) : num(k[1], (x) => (k[1] = x))),
        h('td', {}, it.kf.length > 1 ? h('button', { class: 'btn', onclick: () => { snapshot(); it.kf.splice(i, 1); done(); } }, '×') : null))));
      tb.append(t, h('button', { class: 'btn', style: { marginTop: '4px' }, onclick: () => {
        snapshot(); // insert midway in the widest gap
        let best = it.kf.length - 1, gap = 1 - it.kf[it.kf.length - 1][0];
        for (let i = 0; i < it.kf.length - 1; i++) if (it.kf[i + 1][0] - it.kf[i][0] > gap) { gap = it.kf[i + 1][0] - it.kf[i][0]; best = i; }
        const tt = it.kf[best][0] + gap / 2; const val = anim.itemValue(it, tt);
        it.kf.splice(best + 1, 0, [tt, Array.isArray(val) ? val.slice() : val]); done();
      } }, '+ keyframe'));
    }
    heads(); draw(); table();
    return wrap;
  }

  await load(vis);
}
