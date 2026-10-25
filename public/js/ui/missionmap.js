// Mission map (Tools → Mission map, or "3D map" in the mission script editor): a story mission's places in
// the 3D system view — mission ships, formations and solars, nav-map objectives, trigger areas
// (Cnd_DistVec…), player placements, spawn positions and GotoVec waypoints. A floating panel lists them for
// the current system; click one (in the list or in the view) to select it, drag the gizmo to move or rotate it,
// or type exact values. Edits change only the numbers on that INI line, through the shared undo history.
import * as THREE from 'three';
import { TransformControls } from 'three/addons/TransformControls.js';
import { CSS2DObject } from 'three/addons/CSS2DRenderer.js';
import { h, toast } from './dom.js';
import { dataPath } from '../api.js';
import { fmtNum } from '../formats/ini.js';
import { missionFiles } from './missionedit.js';

const lc = (s) => String(s || '').toLowerCase();
export const CATS = {
  ship: { label: 'Ships', col: 0xff7a59 },
  formation: { label: 'Formations', col: 0xffa040 },
  solar: { label: 'Solars', col: 0xc080ff },
  objective: { label: 'Objectives', col: 0x4fd1ff },
  area: { label: 'Trigger areas', col: 0xffe066 },
  player: { label: 'Player', col: 0x5fa8ff },
  spawn: { label: 'Spawn / move', col: 0xff9fb0 },
  waypoint: { label: 'Waypoints', col: 0x7ee787 },
};
const hex = (c) => '#' + c.toString(16).padStart(6, '0');

// Trigger commands with a position: [category, index of x, index of radius (or -1), index of quaternion w (or -1), min values]
const CMD = {
  cnd_distvec: ['area', 2, 5, -1, 6],
  cnd_distveclbl: ['area', 3, 6, -1, 7],
  act_setinitialplayerpos: ['player', 0, -1, 3, 3],
  act_moveplayer: ['player', 0, 3, -1, 3],
  act_relocateship: ['spawn', 1, -1, 4, 4],
  act_spawnship: ['spawn', 2, -1, 5, 5],
  act_spawnformation: ['spawn', 1, -1, -1, 4],
  act_randompopsphere: ['area', 0, 3, -1, 4],
};
const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : null; };

// every placeable thing of a mission INI: { id, cat, name, detail, system, guessed, sec, entry, xi, ri, qi }
export function collectMissionPlaces(doc) {
  const ini = doc.ini, trig = ini.all('Trigger'), out = [];
  const sysCount = new Map();
  for (const t of trig) { const s = lc(t.get('system')); if (s) sysCount.set(s, (sysCount.get(s) || 0) + 1); }
  const main = [...sysCount].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  // which system spawns a ship / formation (from the triggers that spawn it)
  const spawnSys = new Map();
  for (const t of trig) {
    const s = lc(t.get('system')); if (!s) continue;
    for (const e of t.entries) { const k = lc(e.key); if (k === 'act_spawnship' || k === 'act_spawnformation') { const n = lc(e.values[0]); if (n && !spawnSys.has(n)) spawnSys.set(n, s); } }
  }
  for (const f of ini.all('MsnFormation')) { const s = spawnSys.get(lc(f.get('nickname'))); if (s) for (const sh of f.getAll('ship')) if (!spawnSys.has(lc(sh))) spawnSys.set(lc(sh), s); }
  const add = (o) => { o.id = `${o.sec.name}|${o.sec.get('nickname') || ''}|${lc(o.entry.key)}|${o.sec.entries.indexOf(o.entry)}`; out.push(o); };
  const ent = (kind, cat) => {
    for (const s of ini.all(kind)) {
      const p = s.findAll('position')[0]; const nick = s.get('nickname') || kind;
      const own = lc(s.get('system')), sys = own || spawnSys.get(lc(nick)) || '';
      const q = s.findAll('orientation')[0];
      if (p && p.values.length >= 3) add({ cat, name: nick, detail: kind + (s.get('archetype') ? ' · ' + s.get('archetype') : s.get('NPC') ? ' · NPC ' + s.get('NPC') : ''), system: sys || main, guessed: !sys, sec: s, entry: p, xi: 0, ri: -1, qEntry: q && q.values.length >= 4 ? q : null, qi: 0 });
      else if (s.get('rel_pos') || s.get('relative_pos') || s.get('rel_pos_obj')) out.push({ cat, name: nick, detail: `${kind} · placed relative to ${(s.vals('rel_pos') || s.vals('relative_pos') || [])[1] || s.get('rel_pos_obj') || '?'}`, relative: true, system: sys || main, sec: s });
    }
  };
  ent('MsnShip', 'ship'); ent('MsnFormation', 'formation'); ent('MsnSolar', 'solar'); ent('MsnLoot', 'spawn');
  for (const s of ini.all('NNObjective')) {
    const e = s.findAll('type')[0]; if (!e) continue; const v = e.values;
    if (/^(navmarker|rep_inst)$/i.test(v[0]) && v.length >= 7) add({ cat: 'objective', name: s.get('nickname'), detail: `${v[0]}${v[7] ? ' → ' + v[7] : ''}`, system: lc(v[1]) || main, guessed: !v[1], sec: s, entry: e, xi: 4, ri: -1 });
  }
  for (const t of trig) {
    const tn = t.get('nickname') || 'trigger', sys = lc(t.get('system'));
    for (const e of t.entries) {
      const c = CMD[lc(e.key)]; if (!c) continue; const v = e.values;
      if (v.length < c[4] || [0, 1, 2].some(i => num(v[c[1] + i]) == null)) continue;
      const who = lc(e.key) === 'act_spawnship' || lc(e.key) === 'act_relocateship' || lc(e.key) === 'act_spawnformation' ? v[0] : lc(e.key).startsWith('cnd_distvec') ? v.slice(1, c[1]).join(' ') : '';
      add({ cat: c[0], name: `${tn}`, detail: `${e.key}${who ? ' · ' + who : ''}${c[2] >= 0 && v[c[2]] ? ' · r ' + v[c[2]] : ''}`, system: sys || main, guessed: !sys, sec: t, entry: e, xi: c[1], ri: c[2] >= 0 && num(v[c[2]]) != null ? c[2] : -1, qi: c[3] >= 0 && v.length >= c[3] + 4 && num(v[c[3]]) != null ? c[3] : -1 });
    }
  }
  for (const s of ini.all('ObjList')) {
    const sys = lc(s.get('system'));
    for (const e of s.entries) if (lc(e.key) === 'gotovec' && e.values.length >= 4 && num(e.values[1]) != null) add({ cat: 'waypoint', name: s.get('nickname') || 'ObjList', detail: `GotoVec · ${e.values[0]}${e.values[4] ? ' · within ' + e.values[4] : ''}`, system: sys || main, guessed: !sys, sec: s, entry: e, xi: 1, ri: -1 });
  }
  return out;
}

export const placePos = (p) => new THREE.Vector3(...[0, 1, 2].map(i => num(p.entry.values[p.xi + i]) || 0));
export const placeRadius = (p) => p.ri >= 0 ? num(p.entry.values[p.ri]) || 0 : 0;
export function placeQuat(p) {
  const e = p.qEntry || (p.qi >= 0 ? p.entry : null); if (!e) return null;
  const v = e.values.slice(p.qEntry ? 0 : p.qi).map(num); if (v.length < 4 || v.some(x => x == null)) return null;
  return new THREE.Quaternion(v[1], v[2], v[3], v[0]).normalize();
}
// write values back into the line (other values untouched)
export function writePlace(p, pos, radius, quat) {
  const set = (e, i, vals) => { const v = e.values.slice(); vals.forEach((x, j) => { v[i + j] = x; }); e.value = v.join(', '); e.raw = null; };
  if (pos) set(p.entry, p.xi, pos.map(x => fmtNum(Math.round(x), 0)));
  if (radius != null && p.ri >= 0) set(p.entry, p.ri, [fmtNum(Math.round(radius), 0)]);
  if (quat) { const q = [quat.w, quat.x, quat.y, quat.z].map(x => fmtNum(x, 4)); if (p.qEntry) set(p.qEntry, 0, q); else if (p.qi >= 0) set(p.entry, p.qi, q); }
}

// ---------------------------------------------------------------- real models
// ship: [MsnShip] NPC → [NPC] npc_ship_arch → [NPCShipArch] (the mission's npc_ship_file, then
// MISSIONS\npcships.ini) ship_archetype → shiparch [Ship] DA_archetype + material_library.
// formation: its ships at the offsets of MISSIONS\formations.ini. solar: the solar archetype's model.
let _shipArch = null, _formations = null;
async function shipArchMap(app) {
  if (_shipArch) return _shipArch;
  return (_shipArch = buildShipArchMap(app)); // cache the promise: every place asks at the same time
}
async function buildShipArchMap(app) {
  const m = new Map(), g = app.game, list = g.flIni && g.flIni.first('Data') ? g.flIni.first('Data').getAll('ships') : [];
  for (const f of (list.length ? list : ['ships\\shiparch.ini'])) { const d = await app.otherDoc(dataPath(f)); if (d) for (const s of d.ini.all('Ship')) { const n = s.get('nickname'); if (n) m.set(lc(n), { da: s.get('DA_archetype'), libs: s.getAll('material_library') }); } }
  return m;
}
async function formationOffsets(app) {
  if (_formations) return _formations;
  return (_formations = (async () => {
    const m = new Map(), d = await app.otherDoc(dataPath('missions\\formations.ini'));
    if (d) for (const s of d.ini.all('Formation')) m.set(lc(s.get('nickname')), s.findAll('pos').map(e => e.values.map(v => parseFloat(v) || 0)));
    return m;
  })());
}
export async function placeModels(app, doc, p) {
  const ini = doc.ini, byNick = (kind, n) => ini.all(kind).find(s => lc(s.get('nickname')) === lc(n));
  const ships = await shipArchMap(app);
  const npcFiles = [];
  const mf = (ini.first('Mission') || { get: () => null }).get('npc_ship_file'); if (mf) { const d = await app.otherDoc(dataPath(mf)); if (d) npcFiles.push(d); }
  const gl = await app.otherDoc(dataPath('missions\\npcships.ini')); if (gl) npcFiles.push(gl);
  const shipOf = (msnShip) => {
    const sec = typeof msnShip === 'string' ? byNick('MsnShip', msnShip) : msnShip; if (!sec) return null;
    const npc = byNick('NPC', sec.get('NPC')); const archName = npc && npc.get('npc_ship_arch'); if (!archName) return null;
    for (const d of npcFiles) { if (!d._npcIdx || d._npcN !== d.ini.sections.length) { d._npcN = d.ini.sections.length; d._npcIdx = new Map(); for (const s of d.ini.all('NPCShipArch')) { const n = lc(s.get('nickname')); if (n && !d._npcIdx.has(n)) d._npcIdx.set(n, s); } } const a = d._npcIdx.get(lc(archName)); if (a) { const sh = ships.get(lc(a.get('ship_archetype'))); return sh && sh.da ? sh : null; } }
    return null;
  };
  const formation = async (sec) => {
    if (!sec) return [];
    const offs = (await formationOffsets(app)).get(lc(sec.get('formation'))) || [];
    return sec.getAll('ship').map((n, i) => ({ spec: shipOf(n), offset: offs[i] || [i * 40, 0, i * 60] })).filter(x => x.spec);
  };
  const k = p.entry ? lc(p.entry.key) : '';
  if (p.sec.is('MsnShip')) { const s = shipOf(p.sec); return s ? [{ spec: s, offset: [0, 0, 0] }] : []; }
  if (p.sec.is('MsnFormation')) return formation(p.sec);
  if (p.sec.is('MsnSolar')) { const a = app.game.arch(p.sec.get('archetype')); return a && a.da ? [{ spec: { da: a.da, libs: a.matLibs }, offset: [0, 0, 0] }] : []; }
  if (k === 'act_spawnship' || k === 'act_relocateship') { const s = shipOf(p.entry.values[0]); return s ? [{ spec: s, offset: [0, 0, 0] }] : []; }
  if (k === 'act_spawnformation') return formation(byNick('MsnFormation', p.entry.values[0]));
  return [];
}
// dispose what the overlay itself created, never the shared model geometry / materials
function disposeOverlay(o) {
  if (o.userData && o.userData.model) return;
  if (o.isCSS2DObject && o.element) o.element.remove();
  if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose();
  for (const c of o.children) disposeOverlay(c);
}

export async function missionMap(app, { path = null } = {}) {
  if (app.missionMap) app.missionMap.close();
  const files = await missionFiles();
  if (!files.length) { toast('No mission scripts found under DATA\\MISSIONS'); return; }
  path = path || localStorage.getItem('fled.missionMap') || files[0];
  if (!files.includes(path)) path = files[0];
  const vp = app.viewport, dom = vp.renderer.domElement;
  let doc = null, places = [], selId = null, mode = 'translate', placing = false;
  const hidden = new Set();
  const group = new THREE.Group(); group.userData.noPick = true; vp.scene.add(group);
  const proxy = new THREE.Object3D(); vp.scene.add(proxy);
  const tc = new TransformControls(vp.camera, dom); tc.setSize(0.8); const tcHelper = tc.getHelper(); vp.scene.add(tcHelper);
  let dragging = false;
  tc.addEventListener('dragging-changed', (e) => {
    vp.orbit.enabled = !e.value; dragging = e.value; vp.gizmoDragged = true;
    if (!e.value) commitProxy();
  });
  tc.addEventListener('objectChange', () => { const g = group.children.find(o => o.userData.placeId === selId); if (g) { g.position.copy(proxy.position); const a = g.children.find(o => o.userData.arrow); if (a) a.quaternion.copy(proxy.quaternion); const mh = g.children.find(o => o.userData.model); if (mh && mode === 'rotate') mh.quaternion.copy(proxy.quaternion); } updateFields(); });

  let showModels = (() => { try { return localStorage.getItem('fled.msnModels') !== '0'; } catch { return true; } })();
  // ---------- panel
  const fileSel = h('select', { style: { width: '100%' }, onchange: () => load(fileSel.value) }, files.map(f => h('option', { value: f, selected: f === path }, f.replace('DATA/MISSIONS/', ''))));
  const sysRow = h('div', { style: { fontSize: '11px', color: 'var(--dim)', margin: '4px 0' } });
  const chips = h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '3px', margin: '4px 0' } });
  const list = h('div', { style: { overflow: 'auto', flex: '1', minHeight: '60px', fontSize: '12px' } });
  const editBox = h('div', { style: { fontSize: '12px', borderTop: '1px solid var(--line)', paddingTop: '6px', marginTop: '4px' } });
  const panel = h('div', { class: 'msnmap', style: { position: 'absolute', left: '10px', top: '10px', bottom: '10px', width: '330px', zIndex: 6, background: 'rgba(16,20,28,0.94)', border: '1px solid var(--line)', borderRadius: '8px', padding: '8px', display: 'flex', flexDirection: 'column', fontSize: '12px' } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' } }, h('b', { style: { flex: 1 } }, '🗺 Mission map'),
      h('label', { title: 'Show ships, formations and solars with their real models', style: { fontSize: '11px', color: 'var(--dim)' } }, h('input', { type: 'checkbox', checked: showModels, onchange: (e) => { showModels = e.target.checked; try { localStorage.setItem('fled.msnModels', showModels ? '1' : '0'); } catch { } build(); } }), ' 3D models'),
      h('button', { class: 'btn sm', title: 'Open the mission script editor', onclick: () => { const p = path; close(); import('./missionedit.js').then(m => m.missionEditor(app, { path: p })); } }, 'Scripts…'),
      h('button', { class: 'btn sm', title: 'Close the mission map', onclick: () => close() }, '×')),
    fileSel, sysRow, chips, list, editBox);
  document.getElementById('viewport').append(panel);

  const cur = () => lc(app.sys && app.sys.nickname);
  // real models: one holder per place, kept across rebuilds (keyed by place id + what it shows)
  const models = new Map(); // place id → Promise<THREE.Group|null>
  function attachModel(g, p, q) {
    const key = p.id + '|' + (p.sec.get('NPC') || p.sec.get('archetype') || p.sec.get('formation') || '') + '|' + (p.entry ? p.entry.values[0] : '');
    if (!models.has(key)) models.set(key, (async () => {
      const list = await placeModels(app, doc, p).catch(() => []); if (!list.length) return null;
      const holder = new THREE.Group(); holder.userData.model = true; holder.userData.noPick = true;
      for (const { spec, offset } of list) {
        const m = await app.rm.model(dataPath(spec.da), (spec.libs || []).map(dataPath)).catch(() => null);
        if (m) { m.position.set(...offset); m.traverse(o => { o.userData.noPick = true; }); holder.add(m); }
      }
      return holder.children.length ? holder : null;
    })());
    models.get(key).then(holder => {
      if (!holder || g.parent !== group) return;
      if (holder.parent) holder.parent.remove(holder);
      holder.quaternion.copy(q || new THREE.Quaternion()); g.add(holder); g.userData.hasModel = true; vp.poke && vp.poke();
    });
  }

  const sel = () => places.find(p => p.id === selId);

  function build() {
    for (const c of group.children) { const hold = c.children.find(x => x.userData.model); if (hold) c.remove(hold); disposeOverlay(c); }
    group.clear();
    const dot = new THREE.OctahedronGeometry(1, 0);
    for (const p of places) {
      if (p.relative || p.system !== cur() || hidden.has(p.cat)) continue;
      const col = CATS[p.cat].col, isSel = p.id === selId;
      const g = new THREE.Group(); g.userData.placeId = p.id; g.position.copy(placePos(p));
      const m = new THREE.Mesh(dot, new THREE.MeshBasicMaterial({ color: isSel ? 0xffffff : col, depthTest: false, transparent: true, opacity: 0.95 }));
      m.userData.dot = isSel ? 2 : 1; m.renderOrder = 30; g.add(m);
      const r = placeRadius(p);
      if (r > 0) {
        const s = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 12), new THREE.MeshBasicMaterial({ color: col, wireframe: true, transparent: true, opacity: isSel ? 0.5 : 0.18, depthWrite: false }));
        s.scale.setScalar(r); s.userData.radius = true; g.add(s);
      }
      const q = placeQuat(p);
      if (q) { const a = new THREE.Group(); a.userData.arrow = true; a.quaternion.copy(q); const c = new THREE.Mesh(new THREE.ConeGeometry(0.35, 1.4, 8), new THREE.MeshBasicMaterial({ color: col, depthTest: false, transparent: true })); c.rotation.x = -Math.PI / 2; c.position.z = -1.6; c.renderOrder = 30; c.userData.cone = true; a.add(c); g.add(a); }
      if (isSel || app.settings.labels !== 'none') {
        const el = document.createElement('div'); el.className = 'lbl'; el.style.color = isSel ? '#fff' : hex(col); el.style.fontSize = '11px'; el.textContent = p.name;
        const lab = new CSS2DObject(el); lab.center.set(-0.08, 0.5); g.add(lab);
      }
      if (showModels) attachModel(g, p, q);
      group.add(g);
    }
    const s = sel();
    if (s && !s.relative && s.system === cur()) {
      proxy.position.copy(placePos(s)); proxy.quaternion.copy(placeQuat(s) || new THREE.Quaternion());
      proxy.updateMatrixWorld(true); tc.attach(proxy); tc.setMode(mode === 'rotate' && placeQuat(s) ? 'rotate' : 'translate'); tc.setSpace(mode === 'rotate' ? 'local' : 'world');
    } else tc.detach();
  }
  function renderPanel() {
    // systems
    const counts = new Map(); for (const p of places) counts.set(p.system, (counts.get(p.system) || 0) + 1);
    sysRow.innerHTML = '';
    sysRow.append('Systems: ', ...[...counts].sort((a, b) => b[1] - a[1]).map(([s, n]) => {
      const name = (app.game.systems.find(x => lc(x.nickname) === s) || {}).nickname || s;
      return h('a', { href: '#', style: { marginRight: '6px', color: s === cur() ? '#fff' : 'var(--accent, #6ab0ff)', fontWeight: s === cur() ? 600 : 400 }, onclick: (e) => { e.preventDefault(); if (s !== cur() && app.game.systems.some(x => lc(x.nickname) === s)) app.openSystem(name); } }, `${name} (${n})`);
    }));
    chips.innerHTML = '';
    for (const [k, c] of Object.entries(CATS)) {
      const n = places.filter(p => p.cat === k && p.system === cur()).length; if (!n) continue;
      chips.append(h('button', { class: 'btn sm', style: { opacity: hidden.has(k) ? 0.4 : 1, borderColor: hex(c.col) }, onclick: () => { hidden.has(k) ? hidden.delete(k) : hidden.add(k); build(); renderPanel(); } }, h('span', { style: { color: hex(c.col) } }, '◆ '), `${c.label} ${n}`));
    }
    list.innerHTML = '';
    const here = places.filter(p => p.system === cur() && !hidden.has(p.cat));
    if (!here.length) list.append(h('div', { style: { color: 'var(--faint)', padding: '6px' } }, counts.size ? 'Nothing of this mission is in this system — pick a system above.' : 'This mission has no positions.'));
    for (const p of here) {
      list.append(h('div', { style: { padding: '2px 4px', cursor: 'pointer', borderRadius: '4px', background: p.id === selId ? 'rgba(255,255,255,0.1)' : '' }, onclick: () => choose(p.id, true), title: p.relative ? 'placed relative to another object — no fixed position' : '' },
        h('span', { style: { color: hex(CATS[p.cat].col) } }, p.relative ? '◇ ' : '◆ '), h('span', {}, p.name), h('span', { style: { color: 'var(--faint)' } }, ' · ' + p.detail), p.guessed ? h('span', { style: { color: '#ffb366' }, title: 'no system given; assumed the mission\'s main system' }, ' ?') : null));
    }
    renderEdit();
  }
  let fields = null;
  function renderEdit() {
    editBox.innerHTML = ''; fields = null;
    const p = sel();
    if (!p) { editBox.append(h('div', { style: { color: 'var(--faint)' } }, 'Click a marker in the view or a line above. W move · E rotate · F focus.')); return; }
    editBox.append(h('div', { style: { marginBottom: '4px' } }, h('b', {}, p.name), h('span', { style: { color: 'var(--faint)' } }, ` [${p.sec.name}] ${p.entry ? p.entry.key : ''}`)));
    if (p.relative) { editBox.append(h('div', { style: { color: 'var(--dim)' } }, p.detail + '.'), h('button', { class: 'btn sm', onclick: () => convertToFixed(p) }, 'Give it a fixed position (click in the view)')); return; }
    const inp = (v, on) => h('input', { type: 'number', value: Math.round(v), style: { width: '78px' }, onchange: on });
    const pos = placePos(p);
    const xyz = [0, 1, 2].map(i => inp(pos.getComponent(i), () => apply('Move', { pos: xyz.map(x => +x.value) })));
    const rr = p.ri >= 0 ? inp(placeRadius(p), () => apply('Change radius', { radius: +rr.value })) : null;
    fields = { xyz, rr };
    editBox.append(...[
      h('div', { class: 'btnrow', style: { alignItems: 'center' } }, 'x', xyz[0], 'y', xyz[1], 'z', xyz[2]),
      rr ? h('div', { class: 'btnrow', style: { alignItems: 'center', marginTop: '3px' } }, 'radius', rr) : null,
      h('div', { class: 'btnrow', style: { marginTop: '4px' } },
        h('button', { class: 'btn sm' + (mode === 'translate' ? ' primary' : ''), onclick: () => { mode = 'translate'; build(); renderEdit(); } }, 'Move (W)'),
        placeQuat(p) ? h('button', { class: 'btn sm' + (mode === 'rotate' ? ' primary' : ''), onclick: () => { mode = 'rotate'; build(); renderEdit(); } }, 'Rotate (E)') : null,
        h('button', { class: 'btn sm', title: 'next click in the view places it there (on the y = 0 plane)', onclick: () => { placing = true; toast('Click in the view to place ' + p.name); } }, 'Place by click'),
        h('button', { class: 'btn sm', onclick: () => focus(p) }, 'Focus (F)'))].filter(Boolean));
  }
  function updateFields() { if (!fields || !dragging) return; fields.xyz.forEach((f, i) => { f.value = Math.round(proxy.position.getComponent(i)); }); }
  function apply(label, { pos = null, radius = null, quat = null }) {
    const p = sel(); if (!p) return;
    app.history.do(`${label} ${p.name} (mission)`, [doc], () => writePlace(p, pos, radius, quat));
    refresh();
  }
  function commitProxy() {
    const p = sel(); if (!p) return;
    const q = placeQuat(p);
    apply(mode === 'rotate' ? 'Rotate' : 'Move', { pos: proxy.position.toArray(), quat: q && mode === 'rotate' ? proxy.quaternion.clone() : null });
  }
  function convertToFixed(p) {
    placing = (pt) => {
      app.history.do(`Fixed position for ${p.name} (mission)`, [doc], () => {
        for (const k of ['rel_pos', 'relative_pos', 'rel_pos_obj', 'rel_pos_offset']) p.sec.remove(k);
        p.sec.add('position', pt.map(x => fmtNum(Math.round(x), 0)).join(', '));
      });
      refresh();
    };
    toast('Click in the view to place ' + p.name);
  }
  function focus(p) {
    if (!p || p.relative) return;
    const g = group.children.find(o => o.userData.placeId === p.id), mh = g && g.children.find(o => o.userData.model);
    if (mh && !placeRadius(p)) { const sp = new THREE.Box3().setFromObject(mh).getBoundingSphere(new THREE.Sphere()); vp.animateTo(sp.center, Math.max(sp.radius * 3.5, 120)); return; }
    vp.animateTo(placePos(p), Math.max(placeRadius(p) * 2.5, 3000));
  }
  function choose(id, fly) {
    selId = id; app.select && app.select(null); build(); renderPanel();
    const p = sel(); if (fly && p && !p.relative && p.system === cur()) focus(p);
  }
  function refresh() {
    if (!doc) return;
    places = collectMissionPlaces(doc);
    if (selId && !sel()) selId = null;
    build(); renderPanel();
  }
  async function load(pth) {
    path = pth; try { localStorage.setItem('fled.missionMap', path); } catch { }
    doc = await app.otherDoc(path); if (!doc) { toast('Cannot read ' + path); return; }
    selId = null; refresh();
    // jump to the mission's main system if nothing of it is here
    if (!places.some(p => p.system === cur())) {
      const counts = new Map(); for (const p of places) counts.set(p.system, (counts.get(p.system) || 0) + 1);
      const best = [...counts].sort((a, b) => b[1] - a[1])[0];
      const s = best && app.game.systems.find(x => lc(x.nickname) === best[0]);
      if (s) await app.openSystem(s.nickname);
    }
  }

  // ---------- view hooks
  vp.pickHook = (e) => {
    if (placing) {
      const pt = vp.groundPoint(e).toArray(); const f = placing; placing = false;
      if (typeof f === 'function') f(pt); else apply('Place', { pos: pt });
      return true;
    }
    const r = dom.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top, t = new THREE.Vector3();
    let best = null, bd = 12;
    for (const g of group.children) { t.copy(g.position).project(vp.camera); if (t.z > 1) continue; const d = Math.hypot((t.x + 1) / 2 * r.width - mx, (1 - t.y) / 2 * r.height - my); if (d < bd) { bd = d; best = g; } }
    if (best) { choose(best.userData.placeId, false); return true; }
    return false;
  };
  const keys = (e) => {
    if (!selId || /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || '') || e.ctrlKey || e.metaKey) return;
    const k = e.key.toLowerCase();
    if (k === 'w') { mode = 'translate'; build(); renderEdit(); }
    else if (k === 'e' && sel() && placeQuat(sel())) { mode = 'rotate'; build(); renderEdit(); }
    else if (k === 'f') focus(sel());
    else if (k === 'escape') { selId = null; build(); renderPanel(); }
  };
  window.addEventListener('keydown', keys);
  app.dialogRefreshers.add(refresh);
  function close() {
    vp.pickHook = null; tc.detach(); tc.dispose(); vp.scene.remove(tcHelper); vp.scene.remove(proxy);
    for (const c of group.children) disposeOverlay(c);
    vp.scene.remove(group); panel.remove(); window.removeEventListener('keydown', keys); app.dialogRefreshers.delete(refresh); vp.orbit.enabled = true;
    if (app.missionMap === api) app.missionMap = null;
  }
  const api = {
    close, refresh, get places() { return places; }, get doc() { return doc; }, select: (id) => choose(id, true),
    onSystem() { if (tc.camera !== vp.camera) tc.camera = vp.camera; refresh(); },
    frame(camera) {
      if (tc.camera !== camera) tc.camera = camera;
      const persp = camera.isPerspectiveCamera;
      for (const g of group.children) {
        const d = persp ? camera.position.distanceTo(g.position) : (camera.top - camera.bottom) / camera.zoom * 0.6;
        for (const o of g.children) {
          // with a real model the marker shrinks to a small dot and the model shows the facing
          if (o.userData.dot) o.scale.setScalar(g.userData.hasModel ? Math.max(d * (o.userData.dot === 2 ? 0.006 : 0.004), 2) : Math.max(d * (o.userData.dot === 2 ? 0.009 : 0.006), 20));
          if (o.userData.arrow) { o.visible = !g.userData.hasModel; o.scale.setScalar(Math.max(d * 0.012, 40)); }
        }
      }
    },
  };
  app.missionMap = api;
  await load(path);
  return api;
}
