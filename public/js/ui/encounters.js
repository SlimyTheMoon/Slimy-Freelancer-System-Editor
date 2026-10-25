// Zone population + encounters editor, patrol/trade path editor, and the "new path" click tool.
// Key semantics (from the vanilla data):
//   encounter = <archetype>, <difficulty level>, <chance 0..1>   followed by its own
//   faction   = <group nickname>, <weight>                        lines.
//   density_restriction = <max count>, <ship class>   ·   path_label = <label>, <segment index>
// Chance and faction weights are decimals as in the shipped files (an int chance would make 0.4
// impossible); path labels need not be unique universe-wide — vanilla
// reuses them in up to 8 systems.
import * as THREE from 'three';
import { h, datalist, modal, toast } from './dom.js';
import { IniEntry, fmtNum } from '../formats/ini.js';
import { getPos } from '../system.js';
import { collectPaths, pathLabel, waypoints, applyWaypoints, createPath, segEnds } from '../paths.js';

const POP_KEYS = [
  ['toughness', 'Ship level range of the zone (1–19)'], ['density', 'Max ships alive at once'], ['repop_time', 'Seconds before a killed wave respawns'],
  ['max_battle_size', 'Max ships in one fight'], ['pop_type', ''], ['relief_time', 'Seconds before reinforcements'],
  ['usage', 'patrol / trade (paths)'], ['mission_eligible', 'true = random missions may use it'], ['population_additive', ''], ['sort', ''],
];
const POP_TYPES = ['attack_patrol', 'field_patrol', 'trade_path', 'lane_patrol', 'mining_path', 'scavenger_path', 'jumpgate', 'wormhole', 'major_tradelane', 'minor_tradelane', 'lootable_field', 'lootable_core_field', 'nonlootable_ast_field', 'nonlootable_core_ast_field', 'Background', 'extend_law', 'extend_freeport', 'single_base_law', 'single_base_unlaw', 'base_cluster_law', 'freeport_base'];
const SHIP_CLASSES = ['patroller', 'police_patroller', 'pirate_patroller', 'lawfuls', 'unlawfuls', 'fighters', 'freighters', 'transports', 'capital'];
const POP_DEFAULTS = [['toughness', '4'], ['density', '3'], ['repop_time', '90'], ['max_battle_size', '4'], ['pop_type', 'attack_patrol'], ['relief_time', '30']];

// ---------------------------------------------------------------- encounter blocks
export function readEncounters(sec) {
  const blocks = []; let cur = null;
  for (const e of sec.entries) {
    const k = e.key.toLowerCase();
    if (k === 'encounter') { cur = { enc: e, factions: [] }; blocks.push(cur); }
    else if (k === 'faction') { if (!cur) { cur = { enc: null, factions: [] }; blocks.push(cur); } cur.factions.push(e); }
  }
  return blocks;
}
// rewrite the encounter/faction lines in one place (where the first one was), reusing entry objects
function writeEncounters(sec, blocks) {
  const isEF = (l) => l.type === 'entry' && /^(encounter|faction)$/i.test(l.key);
  let at = sec.lines.findIndex(isEF);
  sec.lines = sec.lines.filter(l => !isEF(l));
  if (at < 0 || at > sec.lines.length) at = sec.lastEntryIndex() + 1;
  const out = [];
  for (const b of blocks) { if (b.enc) out.push(b.enc); out.push(...b.factions); }
  sec.lines.splice(at, 0, ...out);
}
function ensureEncounterParam(sys, arch) {
  if (!arch) return;
  const l = arch.toLowerCase();
  if (sys.ini.all('EncounterParameters').some(s => (s.get('nickname') || '').toLowerCase() === l)) return;
  const all = sys.ini.all('EncounterParameters');
  sys.ini.addSection('EncounterParameters', all[all.length - 1] || sys.ini.first('Music') || sys.ini.first('SystemInfo'), [['nickname', arch], ['filename', `missions\\encounters\\${arch}.ini`]]);
}

// ---------------------------------------------------------------- panel: population & encounters
export function populationSection(app, sec) {
  const g = app.game, sys = app.sys;
  const edit = (label, fn) => app.edit(label, fn);
  const wrap = h('div', { class: 'psec' });
  const blocks = readEncounters(sec);
  const hasPop = ['toughness', 'density', 'repop_time', 'max_battle_size', 'pop_type', 'relief_time'].some(k => sec.has(k)) || blocks.length || sec.has('density_restriction');
  wrap.append(h('h3', {}, 'Population & encounters', hasPop ? h('span', { class: 'act' }, h('button', { class: 'btn sm', title: 'Simulate what this zone spawns, with the game\'s encounter rules', onclick: () => import('./spawnsim.js').then(m => m.spawnSimulator(app, sec)) }, 'Simulate spawns…')) : h('span', { class: 'act' }, h('button', { class: 'btn sm', onclick: () => edit('Add population', () => { for (const [k, v] of POP_DEFAULTS) if (!sec.has(k)) sec.set(k, v); }) }, '+ Populate zone'))));
  if (!hasPop) { wrap.append(h('div', { style: { color: 'var(--faint)', fontSize: '12px' } }, 'No ships spawn here.')); return wrap; }

  const popDl = datalist(POP_TYPES), clsDl = datalist(SHIP_CLASSES);
  wrap.append(popDl.el, clsDl.el);
  const grid = h('div', { class: 'kv' });
  for (const [k, note] of POP_KEYS) {
    if (['usage', 'mission_eligible', 'population_additive', 'sort'].includes(k) && !sec.has(k) && !sec.has('path_label')) continue;
    const e = sec.find(k);
    const inp = h('input', { value: e ? e.value : '', placeholder: '—', onchange: (ev) => edit(`Set ${k}`, () => { const v = ev.target.value.trim(); if (v) sec.set(e ? e.key : k, v); else sec.remove(k); }) });
    if (k === 'pop_type') inp.setAttribute('list', popDl.id);
    grid.append(h('div', { class: 'k', title: note || k }, k), h('div', { class: 'v' }, inp), h('span'));
  }
  wrap.append(grid);

  // density restrictions
  const drs = sec.findAll('density_restriction');
  const drBox = h('div', { style: { marginTop: '6px' } }, h('div', { style: { fontSize: '11px', color: 'var(--faint)', marginBottom: '2px' } }, 'density_restriction — at most N ships of a class'));
  drs.forEach(e => {
    const v = e.values;
    const n = h('input', { value: v[0] || '1', style: { width: '52px' }, onchange: (ev) => edit('Density restriction', () => { e.value = `${ev.target.value.trim() || '1'}, ${e.values[1] || ''}`; e.raw = null; }) });
    const c = h('input', { value: v[1] || '', style: { flex: 1 }, onchange: (ev) => edit('Density restriction', () => { e.value = `${e.values[0] || '1'}, ${ev.target.value.trim()}`; e.raw = null; }) }); c.setAttribute('list', clsDl.id);
    drBox.append(h('div', { style: { display: 'flex', gap: '4px', marginBottom: '3px' } }, n, c, h('button', { class: 'btn sm', onclick: () => edit('Remove density restriction', () => sec.removeEntry(e)) }, '×')));
  });
  drBox.append(h('button', { class: 'btn sm', onclick: () => edit('Add density restriction', () => {
    const last = drs[drs.length - 1]; const ne = new IniEntry('density_restriction', '1, patroller');
    sec.lines.splice(last ? sec.lines.indexOf(last) + 1 : sec.lastEntryIndex() + 1, 0, ne);
  }) }, '+ Restriction'));
  wrap.append(drBox);

  // encounters
  const encBox = h('div', { style: { marginTop: '8px' } });
  const facDl = datalist(g.factions.map(f => ({ value: f.nickname, label: g.name(f.ids) || '' })));
  const encDl = { id: 'dl-enc-' + Math.random().toString(36).slice(2), el: h('datalist') }; encDl.el.id = encDl.id;
  g.encounterList().then(list => { const known = new Set(list.map(x => x.toLowerCase())); for (const s of sys.ini.all('EncounterParameters')) { const n = s.get('nickname'); if (n && !known.has(n.toLowerCase())) list = [...list, n]; } encDl.el.append(...list.map(n => h('option', { value: n }))); });
  encBox.append(facDl.el, encDl.el);
  let total = 0; for (const b of blocks) if (b.enc) total += parseFloat(b.enc.values[2] || '0') || 0;
  encBox.append(h('div', { style: { fontSize: '11px', color: 'var(--faint)', display: 'flex', justifyContent: 'space-between' } },
    h('span', {}, `Encounters (${blocks.filter(b => b.enc).length})`), blocks.length ? h('span', { title: 'Sum of encounter chances' }, `Σ chance ${fmtNum(total, 2)}`) : null));

  blocks.forEach((b, bi) => {
    const card = h('div', { style: { border: '1px solid var(--line)', borderRadius: '6px', padding: '6px', margin: '4px 0' } });
    if (b.enc) {
      const v = b.enc.values;
      const setEnc = (i, val) => edit('Edit encounter', () => { const nv = b.enc.values; while (nv.length < 3) nv.push(i === 1 ? '1' : '0'); nv[i] = val; b.enc.value = nv.join(', '); b.enc.raw = null; if (i === 0) ensureEncounterParam(sys, val); });
      const arch = h('input', { value: v[0] || '', style: { flex: 1, minWidth: '0', fontFamily: 'var(--mono)', fontSize: '12px' }, onchange: (e) => setEnc(0, e.target.value.trim()) }); arch.setAttribute('list', encDl.id);
      const lvl = h('input', { type: 'number', value: v[1] || '1', min: 1, max: 19, title: 'Difficulty level', style: { width: '44px' }, onchange: (e) => setEnc(1, e.target.value.trim()) });
      const ch = h('input', { type: 'number', value: v[2] || '0', step: 0.01, min: 0, max: 1, title: 'Chance (0–1)', style: { width: '56px' }, onchange: (e) => setEnc(2, e.target.value.trim()) });
      const info = h('div', { style: { fontSize: '11px', color: 'var(--faint)', marginTop: '2px' } });
      const ep = sys.ini.all('EncounterParameters').find(s => (s.get('nickname') || '').toLowerCase() === (v[0] || '').toLowerCase());
      if (!ep) info.append(h('span', { class: 'sev-warn' }, 'not in this system\'s [EncounterParameters] — ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); edit('Add encounter parameter', () => ensureEncounterParam(sys, v[0])); } }, 'add')));
      else g.encounterInfo(ep.get('filename') || '').then(i => { info.textContent = i ? i.text || '' : `file not found: ${ep.get('filename')}`; if (!i) info.className = 'sev-err'; });
      card.append(h('div', { style: { display: 'flex', gap: '4px', alignItems: 'center' } }, arch,
        h('span', { style: { fontSize: '10px', color: 'var(--faint)' } }, 'lvl'), lvl, h('span', { style: { fontSize: '10px', color: 'var(--faint)' } }, 'p'), ch,
        h('button', { class: 'btn sm', title: 'Remove encounter', onclick: () => edit('Remove encounter', () => writeEncounters(sec, blocks.filter((_, j) => j !== bi))) }, '×')), info);
    } else card.append(h('div', { class: 'sev-warn', style: { fontSize: '11px' } }, 'faction lines without an encounter above them'));
    b.factions.forEach((fe, fi) => {
      const fv = fe.values;
      const setFac = (i, val) => edit('Edit faction', () => { const nv = fe.values; while (nv.length < 2) nv.push('1'); nv[i] = val; fe.value = nv.join(', '); fe.raw = null; });
      const fn = h('input', { value: fv[0] || '', style: { flex: 1, minWidth: '0', fontFamily: 'var(--mono)', fontSize: '12px' }, onchange: (e) => setFac(0, e.target.value.trim()) }); fn.setAttribute('list', facDl.id);
      const fw = h('input', { type: 'number', value: fv[1] || '1', step: 0.1, min: 0, title: 'Weight', style: { width: '56px' }, onchange: (e) => setFac(1, e.target.value.trim()) });
      const nm = g.factionName(fv[0]);
      card.append(h('div', { style: { display: 'flex', gap: '4px', alignItems: 'center', marginTop: '3px', paddingLeft: '12px' } },
        h('span', { style: { fontSize: '10px', color: 'var(--faint)', width: '38px' } }, 'faction'), fn, fw,
        h('button', { class: 'btn sm', onclick: () => edit('Remove faction', () => sec.removeEntry(fe)) }, '×')),
        nm || !fv[0] ? h('div', { style: { fontSize: '11px', color: 'var(--dim)', paddingLeft: '54px' } }, nm || '') : h('div', { class: 'sev-err', style: { fontSize: '11px', paddingLeft: '54px' } }, 'unknown faction'));
    });
    card.append(h('div', { style: { paddingLeft: '12px', marginTop: '3px' } }, h('button', { class: 'btn sm', onclick: () => edit('Add faction', () => {
      const last = b.factions[b.factions.length - 1] || b.enc;
      sec.lines.splice(sec.lines.indexOf(last) + 1, 0, new IniEntry('faction', `${(b.factions[0] && b.factions[0].values[0]) || (g.factions[0] || {}).nickname || ''}, 1`));
    }) }, '+ Faction')));
    encBox.append(card);
  });
  encBox.append(h('div', { class: 'btnrow', style: { marginTop: '4px' } },
    h('button', { class: 'btn sm', onclick: async () => {
      const list = await g.encounterList();
      const prev = blocks.filter(b => b.enc).pop();
      const arch = prev ? prev.enc.values[0] : (list.find(x => /patrol/.test(x)) || list[0] || 'area_scout');
      const fac = prev && prev.factions[0] ? prev.factions[0].values[0] : (g.factions[0] || {}).nickname || 'li_n_grp';
      edit('Add encounter', () => {
        const enc = new IniEntry('encounter', `${arch}, ${prev ? prev.enc.values[1] || '4' : sec.get('toughness') || '4'}, 0.25`);
        writeEncounters(sec, [...blocks, { enc, factions: [new IniEntry('faction', `${fac}, 1`)] }]);
        ensureEncounterParam(sys, arch);
      });
    } }, '+ Encounter'),
    blocks.length ? h('button', { class: 'btn sm', title: 'Copy population & encounters to other zones', onclick: () => copyPopulationDialog(app, sec) }, 'Copy to…') : null));
  wrap.append(encBox);
  return wrap;
}

const POP_COPY = new Set(['toughness', 'density', 'repop_time', 'max_battle_size', 'pop_type', 'relief_time', 'mission_eligible', 'population_additive', 'density_restriction', 'encounter', 'faction', 'usage']);
function popLines(sec) { return sec.entries.filter(e => POP_COPY.has(e.key.toLowerCase())); }
// replace target's population lines with the source's (kept at the position of the target's first pop line)
function copyPopulation(src, dst) {
  const lines = popLines(src).map(e => new IniEntry(e.key, e.value));
  const isPop = (l) => l.type === 'entry' && POP_COPY.has(l.key.toLowerCase());
  let at = dst.lines.findIndex(isPop);
  dst.lines = dst.lines.filter(l => !isPop(l));
  if (at < 0 || at > dst.lines.length) at = dst.lastEntryIndex() + 1;
  dst.lines.splice(at, 0, ...lines);
}
function copyPopulationDialog(app, src) {
  const sys = app.sys;
  const pl = pathLabel(src);
  const sameKey = pl ? pl.label.toLowerCase() : null;
  const zones = sys.zones.filter(z => z !== src);
  const checks = new Map();
  const list = h('div', { style: { maxHeight: '340px', overflow: 'auto', fontSize: '12px' } });
  for (const z of zones) {
    const p = pathLabel(z);
    const cb = h('input', { type: 'checkbox', checked: !!(sameKey && p && p.label.toLowerCase() === sameKey) });
    checks.set(z, cb);
    list.append(h('label', { style: { display: 'flex', gap: '6px', padding: '1px 0' } }, cb, z.get('nickname'), p ? h('span', { style: { color: 'var(--faint)' } }, `path ${p.label} #${p.index}`) : null));
  }
  modal({
    title: 'Copy population & encounters', body: h('div', {}, h('div', { style: { fontSize: '12px', color: 'var(--dim)', marginBottom: '6px' } }, `From ${src.get('nickname')}: ${popLines(src).length} lines (toughness, density, restrictions, encounters, factions…). Target zones lose their own population lines.`), list),
    buttons: [{ label: 'Cancel' }, { label: 'Copy', cls: 'primary', onClick: () => {
      const tg = [...checks].filter(([, c]) => c.checked).map(([z]) => z);
      if (!tg.length) return false;
      app.edit(`Copy population to ${tg.length} zones`, () => { for (const z of tg) copyPopulation(src, z); });
      toast(`Copied to ${tg.length} zones`);
    } }],
  });
}

// ---------------------------------------------------------------- panel: path
export function pathSection(app, sec) {
  const sys = app.sys, pl = pathLabel(sec);
  const paths = collectPaths(sys); const path = paths.get(pl.label.toLowerCase());
  const { pts, gaps } = waypoints(path);
  const edit = (label, fn) => app.edit(label, fn);
  const setPts = (label, np) => edit(label, () => applyWaypoints(sys, collectPaths(sys).get(pl.label.toLowerCase()), np));
  const wrap = h('div', { class: 'psec' });
  wrap.append(h('h3', {}, `Path · ${path.label}`, h('span', { class: 'act', style: { fontFamily: 'var(--mono)', color: 'var(--faint)' } }, `segment ${pl.index} of ${path.segs.length}`)));
  if (gaps.length) wrap.append(h('div', { class: 'sev-warn', style: { fontSize: '12px' } }, `Segments do not connect before segment ${gaps.map(i => i + 1).join(', ')}. Editing a waypoint rejoins them.`));
  const segIdx = path.segs.findIndex(s => s.sec === sec);
  const tbl = h('div', { style: { display: 'grid', gridTemplateColumns: '22px repeat(3, 1fr) auto', gap: '3px', fontSize: '11px', alignItems: 'center', margin: '4px 0' } },
    ...['#', 'x', 'y', 'z', ''].map(t => h('div', { style: { color: 'var(--faint)' } }, t)));
  pts.forEach((p, i) => {
    const mine = i === segIdx || i === segIdx + 1;
    const cell = (axis) => h('input', { type: 'number', value: fmtNum(p[axis], 0), step: 100, style: { width: '100%', fontFamily: 'var(--mono)', fontSize: '11px', padding: '2px 3px', background: mine ? 'rgba(255,200,80,0.08)' : '' }, onchange: (e) => { const np = pts.map(q => q.clone()); np[i][axis] = parseFloat(e.target.value) || 0; setPts('Move waypoint', np); } });
    tbl.append(h('div', { style: { color: mine ? 'var(--warn)' : 'var(--faint)' } }, String(i + 1)), cell('x'), cell('y'), cell('z'),
      h('div', { style: { display: 'flex', gap: '2px' } },
        h('button', { class: 'btn sm', title: 'Insert a waypoint after this one', style: { padding: '0 5px' }, disabled: i === pts.length - 1, onclick: () => { const np = pts.map(q => q.clone()); np.splice(i + 1, 0, pts[i].clone().lerp(pts[i + 1], 0.5)); setPts('Insert waypoint', np); } }, '+'),
        h('button', { class: 'btn sm', title: 'Delete waypoint', style: { padding: '0 5px' }, disabled: pts.length <= 2, onclick: () => { const np = pts.filter((_, j) => j !== i); setPts('Delete waypoint', np); } }, '×')));
  });
  wrap.append(tbl);
  const radius = segEnds(path.segs[0].sec).radius;
  wrap.append(h('div', { class: 'btnrow' },
    h('button', { class: 'btn sm', onclick: () => app.selectMany(path.segs.map(s => s.sec.id)) }, 'Select all segments'),
    h('button', { class: 'btn sm', title: 'Click in the 3D view to append waypoints', onclick: () => clickPoints(app, { start: pts, onDone: (np) => setPts('Extend path', np) }) }, 'Extend by clicking…'),
    h('button', { class: 'btn sm', onclick: () => setPts('Reverse path', pts.slice().reverse()) }, 'Reverse'),
    h('button', { class: 'btn sm', title: 'Set every waypoint to Y = 0', onclick: () => setPts('Flatten path', pts.map(p => new THREE.Vector3(p.x, 0, p.z))) }, 'Flatten'),
    h('button', { class: 'btn sm', onclick: async () => {
      const { promptDialog } = await import('./dom.js');
      const nl = (await promptDialog('Rename path', 'New path label (unique within this system)', path.label) || '').trim();
      if (!nl || nl === path.label) return;
      if (collectPaths(sys).has(nl.toLowerCase())) { toast('That label is already used in this system'); return; }
      edit('Rename path', () => { for (const s of path.segs) s.sec.set('path_label', `${nl}, ${s.index}`); });
    } }, 'Rename…')));
  const rIn = h('input', { type: 'number', value: fmtNum(radius, 0), step: 50, style: { width: '80px' }, onchange: (e) => { const r = parseFloat(e.target.value) || 750; edit('Path radius', () => { for (const s of path.segs) { const v = s.sec.vals('size') || []; s.sec.set('size', `${fmtNum(r, 0)}, ${v[1] || '1000'}`); } }); } });
  wrap.append(h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', marginTop: '6px', fontSize: '12px', color: 'var(--dim)' } }, 'Radius of all segments', rIn, 'm'));
  return wrap;
}

// ---------------------------------------------------------------- click-to-place waypoints
// Click on the Y=0 plane to add points (Shift+click snaps to the object under the cursor),
// Backspace removes the last one, Enter or double-click finishes, Esc cancels.
export function clickPoints(app, { start = [], onDone, minPoints = 2, title = 'Click to place waypoints' }) {
  const vp = app.viewport;
  if (vp.clickHook) vp.clickHook.cancel();
  const pts = start.map(p => p.clone());
  const group = new THREE.Group(); group.userData.noPick = true; vp.scene.add(group);
  const banner = h('div', { class: 'clickbanner' });
  document.getElementById('viewport').append(banner);
  let hover = null;
  const redraw = () => {
    group.traverse(o => { if (o.geometry) o.geometry.dispose(); }); group.clear();
    const all = hover ? [...pts, hover] : pts;
    if (all.length > 1) group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(all), new THREE.LineBasicMaterial({ color: 0xffe066, depthTest: false })));
    const d = vp.camera.position.distanceTo(vp.orbit.target) * 0.01;
    for (const p of pts) { const m = new THREE.Mesh(new THREE.SphereGeometry(Math.max(d, 80), 10, 8), new THREE.MeshBasicMaterial({ color: 0xffe066, depthTest: false })); m.position.copy(p); group.add(m); }
    banner.innerHTML = '';
    banner.append(h('b', {}, title), ` · ${pts.length} point${pts.length === 1 ? '' : 's'} · click = add · Shift+click = snap to object · Backspace = undo · Enter = finish · Esc = cancel `,
      h('button', { class: 'btn sm primary', disabled: pts.length < minPoints, onclick: finish }, 'Finish'), ' ', h('button', { class: 'btn sm', onclick: cancel }, 'Cancel'));
  };
  const pointFor = (e) => {
    if (e.shiftKey) { const hit = vp.pick(e); if (hit) { const s = app.sys.byId(hit.id); if (s) return new THREE.Vector3(...getPos(s)); } }
    const p = vp.groundPoint(e); const sn = vp.snap ? (app.settings.snapMove || 0) : 0;
    if (sn > 0) { p.x = Math.round(p.x / sn) * sn; p.z = Math.round(p.z / sn) * sn; }
    return p;
  };
  const move = (e) => { if (!pts.length) return; hover = pointFor(e); redraw(); };
  const key = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
    else if (e.key === 'Enter') { e.preventDefault(); finish(); }
    else if (e.key === 'Backspace' && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); pts.pop(); redraw(); }
  };
  const dbl = (e) => { e.preventDefault(); finish(); };
  const cleanup = () => {
    vp.clickHook = null; vp.scene.remove(group); group.traverse(o => { if (o.geometry) o.geometry.dispose(); }); banner.remove();
    vp.renderer.domElement.removeEventListener('pointermove', move); vp.renderer.domElement.removeEventListener('dblclick', dbl); document.removeEventListener('keydown', key, true);
  };
  function finish() { if (pts.length < minPoints) { toast(`Place at least ${minPoints} points`); return; } cleanup(); onDone(pts); }
  function cancel() { cleanup(); }
  vp.clickHook = { add: (e) => { const p = pointFor(e); if (!pts.length || p.distanceTo(pts[pts.length - 1]) > 10) pts.push(p); redraw(); }, cancel };
  vp.renderer.domElement.addEventListener('pointermove', move); vp.renderer.domElement.addEventListener('dblclick', dbl); document.addEventListener('keydown', key, true);
  redraw();
}

// ---------------------------------------------------------------- Create → Patrol / trade path…
export function newPathTool(app) {
  clickPoints(app, { title: 'New path', onDone: (pts) => newPathDialog(app, pts) });
}
export function newPathDialog(app, pts) {
  const sys = app.sys, g = app.game;
  const paths = collectPaths(sys);
  const base = `${sys.nickname.toLowerCase()}_patrol`;
  let n = 1; while (paths.has(`${base}_${n}`)) n++;
  const label = h('input', { value: `${base}_${n}`, style: { width: '100%' } });
  const usage = h('select', {}, ['patrol', 'trade'].map(u => h('option', {}, u)));
  const radius = h('input', { type: 'number', value: '750', step: 50 });
  const tmplSel = h('select', {}, h('option', { value: '' }, '(defaults below)'), [...paths.values()].map(p => h('option', { value: p.label.toLowerCase() }, `${p.label} — ${p.usage}, ${p.segs.length} seg`)));
  const vals = Object.fromEntries([['toughness', '4'], ['density', '3'], ['repop_time', '90'], ['max_battle_size', '4'], ['pop_type', 'field_patrol'], ['relief_time', '30']].map(([k, v]) => [k, h('input', { value: v })]));
  const enc = h('input', { value: '' }); const fac = h('input', { value: '' }); const chance = h('input', { value: '0.4' });
  const encDl = datalist([]); g.encounterList().then(l => { encDl.el.append(...l.map(x => h('option', { value: x }))); enc.value = l.find(x => x === 'patrolp_gov_patrol') || l.find(x => /patrol/.test(x)) || ''; });
  enc.setAttribute('list', encDl.id);
  const facDl = datalist(g.factions.map(f => ({ value: f.nickname, label: g.name(f.ids) || '' }))); fac.setAttribute('list', facDl.id); fac.value = (g.factions.find(f => /_p_grp$|_n_grp$/.test(f.nickname)) || g.factions[0] || {}).nickname || '';
  usage.onchange = () => { vals.pop_type.value = usage.value === 'trade' ? 'trade_path' : 'field_patrol'; };
  const len = pts.reduce((a, p, i) => i ? a + p.distanceTo(pts[i - 1]) : 0, 0);
  const row = (l, el, note) => [h('label', {}, l), el, note ? h('div', { class: 'help' }, note) : null];
  modal({
    title: 'New patrol / trade path', wide: true,
    body: h('div', { class: 'form' },
      h('div', { style: { gridColumn: '1 / -1', color: 'var(--dim)', fontSize: '12px' } }, `${pts.length} waypoints → ${pts.length - 1} CYLINDER zones, ${fmtNum(len / 1000, 1)} km total.`),
      ...row('Path label', label, 'Unique within this system. Vanilla reuses labels across systems (e.g. outcasts1 in 8 systems), so they are per-system names.'),
      ...row('Usage', usage), ...row('Radius (m)', radius),
      ...row('Copy population from', tmplSel, 'Takes toughness, density, restrictions, encounters and factions from an existing path in this system.'),
      ...Object.entries(vals).flatMap(([k, el]) => row(k, el)),
      ...row('Encounter', h('div', { style: { display: 'flex', gap: '4px' } }, enc, chance, encDl.el), 'archetype and chance (0–1); level = toughness'),
      ...row('Faction', h('div', {}, fac, facDl.el))),
    buttons: [{ label: 'Cancel' }, { label: 'Create path', cls: 'primary', onClick: () => {
      const lb = label.value.trim().replace(/\s+/g, '_');
      if (!lb) { toast('Label required'); return false; }
      if (collectPaths(sys).has(lb.toLowerCase())) { toast('Label already used in this system'); return false; }
      let props;
      const tp = tmplSel.value && paths.get(tmplSel.value);
      if (tp) props = popLines(tp.segs[0].sec).map(e => [e.key, e.value]);
      else {
        props = Object.entries(vals).map(([k, el]) => [k, el.value.trim()]).filter(([, v]) => v);
        props.push(['usage', usage.value], ['mission_eligible', 'true']);
        for (const c of ['patroller', 'police_patroller', 'pirate_patroller']) props.push(['density_restriction', `1, ${c}`]);
        if (enc.value.trim()) { props.push(['encounter', `${enc.value.trim()}, ${vals.toughness.value.trim() || '4'}, ${chance.value.trim() || '0.4'}`]); if (fac.value.trim()) props.push(['faction', `${fac.value.trim()}, 1`]); }
      }
      if (!props.some(([k]) => k === 'usage')) props.push(['usage', usage.value]);
      props.unshift(['sort', '99']);
      let made = [];
      app.edit('Create path', () => {
        made = createPath(sys, lb, pts, parseFloat(radius.value) || 750, props);
        for (const [k, v] of props) if (k === 'encounter') ensureEncounterParam(sys, v.split(',')[0].trim());
      });
      if (made.length) app.select(made[0].id);
      toast(`Created ${made.length} path zones`);
    } }],
  });
}
