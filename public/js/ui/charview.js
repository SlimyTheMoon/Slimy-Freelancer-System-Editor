// Character viewer: a costume or a set of body parts, posed and animated with the game's .anm library.
// Used by the bar editor (character appearance) and Assets → Characters & animations.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { h, modal, overlay } from './dom.js';
import { dataPath } from '../api.js';
import { loadIni } from '../gamedata.js';
import { characterData, loadCharacter } from '../formats/dfm.js';

const lc = (s) => String(s || '').toLowerCase();

// returns { el, set(parts), dispose() }
export function characterView(app, { height = 360 } = {}) {
  const canvas = h('canvas', { style: { width: '100%', height: '100%', display: 'block', background: 'var(--well)', borderRadius: '6px' } });
  const view = h('div', { style: { position: 'relative', height: height + 'px' } }, canvas);
  const animSel = h('select', { style: { flex: '1', minWidth: '0' } });
  const filter = h('input', { placeholder: 'filter animations…', style: { width: '140px' } });
  const loop = h('input', { type: 'checkbox', checked: true });
  const info = h('span', { style: { fontSize: '11px', color: 'var(--faint)' } });
  const el = h('div', {}, view, h('div', { class: 'btnrow', style: { marginTop: '4px', alignItems: 'center' } }, filter, animSel, h('label', {}, loop, ' loop'), info));
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true }); renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene(); scene.add(new THREE.AmbientLight(0xc8d0e0, 1.1));
  const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(1.5, 2.5, -3); scene.add(key);
  const fill = new THREE.DirectionalLight(0x8899bb, 0.8); fill.position.set(-2, 1, 2); scene.add(fill);
  const floor = new THREE.Mesh(new THREE.CircleGeometry(1, 40), new THREE.MeshBasicMaterial({ color: 0x223044 })); floor.rotation.x = -Math.PI / 2; scene.add(floor);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 100); camera.position.set(0.4, 0.5, -4.2);
  const orbit = new OrbitControls(camera, canvas); orbit.target.set(0, 0.1, 0); orbit.enableDamping = true;
  let ch = null, data = null, running = true, last = performance.now(), token = 0;
  const resize = () => { const r = view.getBoundingClientRect(); if (!r.width) return; renderer.setSize(r.width, r.height, false); camera.aspect = r.width / r.height; camera.updateProjectionMatrix(); };
  new ResizeObserver(resize).observe(view);
  (function loop_() {
    if (!running) return;
    const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (ch) ch.update(dt);
    orbit.update(); renderer.render(scene, camera); requestAnimationFrame(loop_);
  })();
  const fillAnims = () => {
    if (!data) return;
    const pre = ch && ch.sex === 'female' ? /^sc_fm/i : /^sc_ml/i, q = lc(filter.value);
    const names = [...data.scripts.values()].filter(s => pre.test(s.name) && (!q || lc(s.name).includes(q))).map(s => s.name).sort();
    const cur = animSel.value; animSel.innerHTML = '';
    animSel.append(h('option', { value: '' }, `— base pose — (${names.length} animations)`), ...names.slice(0, 1500).map(n => h('option', { value: n, selected: n === cur }, n)));
  };
  filter.oninput = fillAnims;
  animSel.onchange = () => {
    if (!ch) return; ch.stopAll();
    const s = data.scripts.get(lc(animSel.value));
    if (s) { ch.start(s, { loop: loop.checked }); info.textContent = `${s.duration.toFixed(1)} s · ${s.joints.length} joints`; } else info.textContent = '';
  };
  return {
    el,
    async set(parts) {
      const my = ++token;
      data = data || await characterData(app, loadIni, dataPath);
      const c = parts.costume ? data.costumes.get(lc(parts.costume)) : parts;
      const next = c ? await loadCharacter(app, data, c, dataPath).catch(e => { console.warn(e); return null; }) : null;
      if (my !== token) return;
      if (ch) scene.remove(ch.object);
      ch = next; info.textContent = ch ? '' : 'body part not found';
      if (ch) {
        scene.add(ch.object); fillAnims(); if (animSel.value) animSel.onchange();
        ch.object.updateMatrixWorld(true); const box = new THREE.Box3().setFromObject(ch.object, true);
        if (!box.isEmpty()) { floor.position.y = box.min.y; orbit.target.set(0, (box.min.y + box.max.y) / 2, 0); }
      }
    },
    dispose() { running = false; renderer.dispose(); },
  };
}

// Assets → Characters & animations: every costume (and the bar characters' part sets) in the viewer
export async function characterBrowser(app) {
  overlay('Reading characters and animations…');
  let data; try { data = await characterData(app, loadIni, dataPath); } finally { overlay(null); }
  const filter = h('input', { placeholder: `Filter ${data.costumes.size} costumes…`, style: { width: '100%' } });
  const list = h('div', { class: 'reflist', style: { height: 'calc(100vh - 300px)', overflow: 'auto', fontSize: '12px' } });
  const parts = h('div', { style: { fontSize: '12px', marginTop: '6px', color: 'var(--dim)' } });
  const v = characterView(app, { height: Math.max(360, window.innerHeight - 330) });
  const render = () => {
    const q = lc(filter.value); list.innerHTML = '';
    for (const c of [...data.costumes.values()].sort((a, b) => a.nickname.localeCompare(b.nickname))) {
      if (q && !lc([c.nickname, c.body, c.head].join(' ')).includes(q)) continue;
      list.append(h('div', { style: { padding: '2px 6px', cursor: 'pointer' }, onclick: () => { v.set({ costume: c.nickname }); parts.textContent = `body ${c.body} · head ${c.head || '—'} · hands ${c.leftHand || '—'}, ${c.rightHand || '—'}${c.accessory ? ' · accessory ' + c.accessory : ''}`; } }, c.nickname));
    }
  };
  filter.oninput = render; render();
  modal({ title: 'Characters & animations', wide: true, onClose: () => v.dispose(),
    body: h('div', { style: { display: 'grid', gridTemplateColumns: '260px 1fr', gap: '10px' } }, h('div', {}, filter, list), h('div', {}, v.el, parts)),
    buttons: [{ label: 'Close' }] }).box.classList.add('xwide');
  const first = [...data.costumes.keys()].find(k => k === 'trent') || [...data.costumes.keys()][0];
  if (first) v.set({ costume: first });
}
