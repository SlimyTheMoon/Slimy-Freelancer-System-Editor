// Bulk editing for a multi-selection: the entries the selected objects/zones share (one undo step per change),
// group transforms around the shared centre, and renaming a series of nicknames (references follow).
import * as THREE from 'three';
import { h, datalist, toast, promptDialog } from './dom.js';
import { kindOf, getPos, getRot, setPos, setRot } from '../system.js';
import { keyTip } from '../inidocs.js';
import { fmtVec } from '../formats/ini.js';

const DEG = Math.PI / 180;
const SKIP = new Set(['nickname', 'pos', 'rotate']); // shown in the transform tools instead
const ORDER = ['archetype', 'ids_name', 'ids_info', 'reputation', 'loadout', 'behavior', 'pilot', 'voice', 'visit', 'difficulty_level', 'base', 'dock_with', 'parent',
  'shape', 'size', 'sort', 'property_flags', 'property_fog_color', 'density', 'repop_time', 'max_battle_size', 'pop_type', 'relief_time', 'faction', 'encounter', 'usage', 'mission_type'];
const MEM = {};
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

export function bulkPanel(props, sel) {
  const app = props.app;
  const wrap = h('div', {});
  const kinds = {}; for (const s of sel) { const k = kindOf(s); kinds[k] = (kinds[k] || 0) + 1; }
  const centre = () => { const c = [0, 0, 0]; for (const s of sel) { const p = getPos(s); for (let i = 0; i < 3; i++) c[i] += p[i] / sel.length; } return c; };

  // ---------------------------------------------------------------- header + narrowing
  const kindNames = { object: 'objects', zone: 'zones', light: 'lights' };
  const narrow = Object.keys(kinds).length > 1 ? h('div', { class: 'btnrow', style: { marginTop: '6px' } }, 'Keep only:',
    Object.entries(kinds).map(([k, n]) => h('button', { class: 'btn sm', onclick: () => app.selectMany(sel.filter(s => kindOf(s) === k).map(s => s.id)) }, `${n} ${kindNames[k] || k}`))) : null;
  let d = '';
  if (sel.length === 2) { const a = getPos(sel[0]), b = getPos(sel[1]); d = Math.round(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])) + ' m'; }
  wrap.append(h('div', { class: 'phead' }, h('div', { class: 'kind' }, 'multiple selection'), h('h2', {}, `${sel.length} selected`),
    h('div', { class: 'sub' }, Object.entries(kinds).map(([k, n]) => `${n} ${kindNames[k] || k}`).join(' · ')), narrow),
  h('div', { class: 'psec' }, h('div', { class: 'stat' }, 'Centre', h('b', {}, fmtVec(centre(), 0)), d ? 'Distance' : '', d ? h('b', {}, d) : '')));

  // ---------------------------------------------------------------- shared entries
  const byKey = new Map(); // lower key -> { key, have: [[sec, entry]] }
  for (const s of sel) for (const e of s.entries) {
    const kl = e.key.toLowerCase(); if (SKIP.has(kl)) continue;
    if (!byKey.has(kl)) byKey.set(kl, { key: e.key, have: [] });
    const b = byKey.get(kl); if (!b.have.some(([x]) => x === s)) b.have.push([s, e]);
  }
  const keys = [...byKey.keys()].sort((a, b) => { const ia = ORDER.indexOf(a), ib = ORDER.indexOf(b); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b); });
  const setAll = (key, value) => app.edit(`Set ${key} on ${sel.length}`, () => { for (const s of sel) s.set(s.find(key) ? s.find(key).key : key, value); });
  const grid = h('div', { class: 'kv' });
  for (const kl of keys) {
    const { key, have } = byKey.get(kl);
    const vals = [...new Set(have.map(([, e]) => e.value))];
    const same = vals.length === 1 && have.length === sel.length;
    const inp = h('input', {
      value: same ? vals[0] : '',
      placeholder: vals.length > 1 ? `mixed · ${vals.length} values` : `only ${have.length} of ${sel.length}: ${vals[0]}`,
      title: vals.length > 1 ? 'Values now:\n' + vals.slice(0, 20).join('\n') + (vals.length > 20 ? '\n…' : '') + '\n\nType a value to set it on all ' + sel.length : '',
      onchange: () => { const v = inp.value.trim(); if (v) setAll(key, v); },
    });
    const sugg = props.suggestions(kl, sel[0]); let dl = null; if (sugg && sugg.length) { dl = datalist(sugg); inp.setAttribute('list', dl.id); }
    const pkb = props.pickButton(kl, sel[0], () => (same ? vals[0] : ''), (v) => setAll(key, v), sugg);
    const count = have.length === sel.length ? '' : h('span', { class: 'hint', title: `${have.length} of the ${sel.length} selected have this entry` }, `${have.length}/${sel.length}`);
    const hint = same ? props.hint(kl, vals[0]) : '';
    grid.append(h('div', { class: 'k', title: keyTip(sel[0].name, key) }, key), h('div', { class: 'v' }, inp, dl && dl.el, pkb, count, hint ? h('span', { class: 'hint', title: hint }, hint) : null),
      h('button', { class: 'x', title: `Remove ${key} from all ${have.length}`, onclick: () => app.edit(`Remove ${key} from ${have.length}`, () => { for (const [s] of have) s.remove(key); }) }, '×'));
  }
  const addKey = h('input', { placeholder: 'key', style: { width: '38%', minWidth: 0 } }), addVal = h('input', { placeholder: 'value', style: { flex: 1, minWidth: 0 } });
  addKey.addEventListener('change', () => { const sg = props.suggestions(addKey.value.trim().toLowerCase(), sel[0]); if (sg && sg.length) { const d2 = datalist(sg); addVal.setAttribute('list', d2.id); addVal.after(d2.el); } });
  wrap.append(h('div', { class: 'psec' }, h('h3', {}, 'Shared entries', h('span', { class: 'act', style: { fontWeight: 400, textTransform: 'none', letterSpacing: 0 } }, 'changes apply to all selected')),
    keys.length ? grid : h('div', { class: 'note' }, 'No common entries.'),
    h('div', { style: { display: 'flex', gap: '6px', marginTop: '8px', alignItems: 'center' } }, addKey, addVal, h('button', { class: 'btn sm primary', style: { whiteSpace: 'nowrap' }, onclick: () => { const k = addKey.value.trim(), v = addVal.value.trim(); if (!k || !v) { toast('Key and value needed'); return; } setAll(k, v); } }, `Set on ${sel.length}`))));

  // ---------------------------------------------------------------- transforms (same path as the gizmo: one undo step)
  const v3 = (...a) => new THREE.Vector3(...a);
  // apply a world matrix to every selected item's position + orientation
  function transformAll(label, M) {
    const items = sel.map(s => {
      const p = getPos(s), r = getRot(s);
      const m = new THREE.Matrix4().compose(v3(...p), new THREE.Quaternion().setFromEuler(new THREE.Euler(r[0] * DEG, r[1] * DEG, r[2] * DEG, 'ZYX')), v3(1, 1, 1));
      const nm = M.clone().multiply(m), pos = v3(), q = new THREE.Quaternion(), sc = v3(); nm.decompose(pos, q, sc);
      const e = new THREE.Euler().setFromQuaternion(q, 'ZYX');
      return { id: s.id, pos: pos.toArray().map(x => Math.round(x * 100) / 100), rot: [e.x, e.y, e.z].map(x => Math.round(x / DEG * 100) / 100) };
    });
    app.commitTransforms(items);
  }
  // the panel redraws after every edit; keep what was typed
  const num = (k, v, w = '64px') => { const i = h('input', { type: 'number', value: k in MEM ? MEM[k] : v, style: { width: w } }); i.addEventListener('input', () => { MEM[k] = i.value; }); return i; };
  const dx = num('dx', 0), dy = num('dy', 0), dz = num('dz', 0), ang = num('ang', 15, '56px'), fac = num('fac', 1.5, '56px');
  const axisSel = h('select', { onchange: () => { MEM.axis = axisSel.value; } }, ['y', 'x', 'z'].map(a => h('option', { value: a, selected: (MEM.axis || 'y') === a }, a === 'y' ? 'Y (top view)' : a.toUpperCase())));
  const rotateGroup = (deg) => {
    const c = v3(...centre()), ax = { x: v3(1, 0, 0), y: v3(0, 1, 0), z: v3(0, 0, 1) }[axisSel.value];
    const M = new THREE.Matrix4().makeTranslation(c.x, c.y, c.z).multiply(new THREE.Matrix4().makeRotationAxis(ax, deg * DEG)).multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z));
    transformAll(`Rotate ${sel.length} around centre`, M);
  };
  function spread(f) {
    const c = centre();
    app.edit(`Spread ${sel.length} ×${f}`, () => { for (const s of sel) { const p = getPos(s); setPos(s, p.map((x, i) => c[i] + (x - c[i]) * f)); } });
  }
  function distribute() {
    if (sel.length < 3) { toast('Select at least 3 items'); return; }
    // the two items farthest apart stay; the rest go evenly between them, in their current order along that line
    let a = sel[0], b = sel[1], best = -1;
    for (const s of sel) for (const t of sel) { const p = getPos(s), q = getPos(t), dd = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); if (dd > best) { best = dd; a = s; b = t; } }
    const A = v3(...getPos(a)), B = v3(...getPos(b)), dir = B.clone().sub(A);
    const order = [...sel].sort((s, t) => v3(...getPos(s)).sub(A).dot(dir) - v3(...getPos(t)).sub(A).dot(dir));
    app.edit(`Distribute ${sel.length}`, () => order.forEach((s, i) => setPos(s, A.clone().lerp(B, i / (order.length - 1)).toArray().map(x => Math.round(x)))));
  }
  function circle() {
    const c = centre(); const rIn = Math.round(sel.reduce((m, s) => { const p = getPos(s); return m + Math.hypot(p[0] - c[0], p[2] - c[2]); }, 0) / sel.length) || 1000;
    promptDialog('Arrange in a circle', `Radius in metres (around the centre, flat on the XZ plane, in nickname order)`, String(rIn)).then(v => {
      const r = parseFloat(v); if (!(r > 0)) return;
      const order = [...sel].sort((s, t) => natural(s.get('nickname') || '', t.get('nickname') || ''));
      app.edit(`Circle of ${sel.length}`, () => order.forEach((s, i) => { const a = i / order.length * Math.PI * 2; setPos(s, [Math.round(c[0] + Math.cos(a) * r), Math.round(c[1]), Math.round(c[2] + Math.sin(a) * r)]); }));
    });
  }
  const primary = sel[sel.length - 1];
  wrap.append(h('div', { class: 'psec' }, h('h3', {}, 'Move & arrange'),
    h('div', { class: 'btnrow', style: { flexWrap: 'wrap', alignItems: 'center' } }, 'Offset', dx, dy, dz,
      h('button', { class: 'btn sm', onclick: () => { const o = [+dx.value || 0, +dy.value || 0, +dz.value || 0]; if (!o.some(Boolean)) return; app.edit(`Move ${sel.length}`, () => sel.forEach(s => setPos(s, getPos(s).map((x, i) => x + o[i])))); } }, 'Move')),
    h('div', { class: 'btnrow', style: { flexWrap: 'wrap', alignItems: 'center', marginTop: '6px' } }, 'Rotate group', ang, '° around', axisSel,
      h('button', { class: 'btn sm', title: 'Turn the whole group around its centre (positions and orientations)', onclick: () => rotateGroup(-(+ang.value || 0)) }, '⟲'),
      h('button', { class: 'btn sm', onclick: () => rotateGroup(+ang.value || 0) }, '⟳')),
    h('div', { class: 'btnrow', style: { flexWrap: 'wrap', alignItems: 'center', marginTop: '6px' } }, 'Spread ×', fac,
      h('button', { class: 'btn sm', title: 'Move every item away from (>1) or towards (<1) the centre', onclick: () => { const f = +fac.value; if (f > 0) spread(f); } }, 'Apply')),
    h('div', { class: 'btnrow', style: { flexWrap: 'wrap', marginTop: '6px' } },
      h('button', { class: 'btn sm', title: 'Even spacing on the line between the two items farthest apart', onclick: distribute }, 'Distribute in a line'),
      h('button', { class: 'btn sm', onclick: circle }, 'Arrange in a circle…'),
      h('button', { class: 'btn sm', onclick: () => app.edit('Flatten', () => sel.forEach(s => { const p = getPos(s); p[1] = 0; setPos(s, p); })) }, 'All Y=0'),
      h('button', { class: 'btn sm', title: `Give every item the orientation of ${primary.get('nickname')} (the last one selected)`, onclick: () => { const r = getRot(primary); app.edit(`Same rotation on ${sel.length}`, () => sel.forEach(s => setRot(s, [...r]))); } }, 'Same rotation'),
      h('button', { class: 'btn sm', title: 'Snap positions to the move snap step (View → snap settings)', onclick: () => { const st = app.settings.snapMove || 100; app.edit(`Snap ${sel.length}`, () => sel.forEach(s => setPos(s, getPos(s).map(x => Math.round(x / st) * st)))); } }, `Snap to ${app.settings.snapMove || 100} m`))));

  // ---------------------------------------------------------------- rename series
  const pat = h('input', { value: guessPattern(sel), style: { flex: 1, minWidth: 0 }, title: '{n} is replaced by the number; {n:2} pads to 2 digits (01, 02 …)' });
  const start = num('start', 1, '48px');
  const preview = h('div', { class: 'note', style: { marginTop: '4px' } });
  const ordered = () => [...sel].sort((a, b) => natural(a.get('nickname') || '', b.get('nickname') || ''));
  const names = () => ordered().map((s, i) => pat.value.replace(/\{n(?::(\d))?\}/g, (_, w) => String((+start.value || 0) + i).padStart(+w || 0, '0')));
  const showPrev = () => { const n = names(), o = ordered(); preview.textContent = o.slice(0, 3).map((s, i) => `${s.get('nickname')} → ${n[i]}`).join(' · ') + (o.length > 3 ? ` · … (${o.length})` : ''); };
  pat.addEventListener('input', showPrev); start.addEventListener('input', showPrev); showPrev();
  async function renameSeries() {
    if (!/\{n(?::\d)?\}/.test(pat.value)) { toast('The pattern needs {n} for the number'); return; }
    const o = ordered(), n = names();
    if (new Set(n.map(x => x.toLowerCase())).size !== n.length) { toast('The pattern gives duplicate names'); return; }
    const mine = new Set(o.map(s => s.id));
    const clash = n.find(x => { const t = app.sys.byNick(x); return t && !mine.has(t.id); }); if (clash) { toast(`${clash} already exists in this system`); return; }
    const olds = o.map(s => s.get('nickname'));
    // two phases through temporary names so A→B, B→C swaps cannot collide; references in this system follow
    app.edit(`Rename ${o.length}`, () => {
      o.forEach((s, i) => { const tmp = `__fled_tmp_${i}`; s.set('nickname', tmp); if (olds[i]) app.sys.renameRefs(olds[i], tmp); });
      o.forEach((s, i) => { s.set('nickname', n[i]); app.sys.renameRefs(`__fled_tmp_${i}`, n[i]); });
    });
    for (let i = 0; i < o.length; i++) if (olds[i] && olds[i] !== n[i]) await app.renameCrossRefs(olds[i], n[i]); // jump gotos in other systems
    toast(`Renamed ${o.length}; references in this system and jump connections followed. Use References… for other files (missions, bases).`, 6000);
  }
  wrap.append(h('div', { class: 'psec' }, h('h3', {}, 'Rename series'),
    h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } }, pat, 'from', start, h('button', { class: 'btn sm primary', style: { whiteSpace: 'nowrap' }, onclick: renameSeries }, 'Rename')), preview));

  // ---------------------------------------------------------------- the rest
  wrap.append(h('div', { class: 'psec' }, h('div', { class: 'btnrow' },
    h('button', { class: 'btn', onclick: () => app.duplicateSelected() }, 'Duplicate'),
    h('button', { class: 'btn', onclick: () => app.copy() }, 'Copy'),
    h('button', { class: 'btn danger', onclick: () => app.deleteSelected() }, 'Delete'))),
  h('div', { class: 'psec' }, h('h3', {}, 'Selected'), h('div', { class: 'reflist' }, ordered().map(s => h('div', { onclick: () => app.select(s.id), title: 'Select only this one' }, s.get('nickname'))))));
  return wrap;
}

// "EW06_01_wp03" + "EW06_01_wp07" → "EW06_01_wp{n:2}"
function guessPattern(sel) {
  const ns = sel.map(s => s.get('nickname') || '').filter(Boolean); if (!ns.length) return 'item_{n}';
  const m = /^(.*?)(\d+)$/.exec(ns[0]);
  if (m && ns.every(n => n.startsWith(m[1]) && /^\d+$/.test(n.slice(m[1].length)))) return `${m[1]}{n${m[2].length > 1 ? ':' + m[2].length : ''}}`;
  let p = ns[0]; for (const n of ns) while (!n.startsWith(p)) p = p.slice(0, -1);
  return (p || 'item_') + '{n:2}';
}
