// Views: one click switches what the 3D view shows. A view switches the kinds and categories of the Outliner
// (the same eyes you can click yourself, ui/visibility.js) plus the display switches (labels, paths, fields…).
// Models, effects and lighting (speed-related) are left as the user set them. Several views can be ticked at
// once: the combination shows everything any of them shows (Everything and Clean are single choices).
// Item eyes (per system) are never touched by a view.
import { h, toast, promptDialog, confirmDialog, modal } from './dom.js';
import { OBJ_GROUPS } from './visibility.js';
const saveSettings = (s) => { try { localStorage.setItem('fled.settings', JSON.stringify(s)); } catch { } };

const CONTENT_KEYS = ['objects', 'zones', 'lights', 'labels', 'fields', 'paths', 'rings', 'sunFx', 'starsphere', 'grid', 'navgrid', 'fieldDots'];
const ALL_CATS = { nebula: true, asteroids: true, death: true, exclusion: true, path: true, encounter: true, other: true };
const NO_CATS = { nebula: false, asteroids: false, death: false, exclusion: false, path: false, encounter: false, other: false };
const BASE = { objects: true, zones: true, lights: true, labels: 'important', fields: true, paths: true, rings: true, sunFx: true, starsphere: true, grid: true, navgrid: false, fieldDots: true,
  zoneCats: { nebula: true, asteroids: true, death: true, exclusion: true, path: false, encounter: false, other: false }, objHidden: {} };
const EXCLUSIVE = new Set(['std', 'all', 'clean']);
const LABEL_RANK = { none: 0, important: 1, all: 2 };
// object categories a view shows; every other category is switched off
const only = (...ids) => Object.fromEntries(OBJ_GROUPS.map(([g]) => [g, true]).filter(([g]) => !ids.includes(g)));

export const BUILTIN = [
  { id: 'std', name: 'Standard', desc: 'The default: everything except patrol paths, encounter zones and other zones (they clutter most systems)', settings: {} },
  { id: 'all', name: 'Everything', desc: 'Every kind and category on, including patrol paths and encounter zones', settings: { zoneCats: { ...ALL_CATS } } },
  { id: 'nav', name: 'Bases, lanes & jumps', desc: 'Suns, planets, stations, trade lanes, gates and holes — no zones', settings: { zones: false, lights: false, paths: false, objHidden: only('planets', 'stations', 'gates', 'lanes') } },
  { id: 'zones', name: 'Zones', desc: 'Every zone category with labels; suns and planets for orientation', settings: { zoneCats: { ...ALL_CATS }, labels: 'all', fields: false, objHidden: only('planets') } },
  { id: 'enc', name: 'Encounters & patrols', desc: 'Encounter zones, patrol/trade paths and the places they connect', settings: { zoneCats: { ...NO_CATS, path: true, encounter: true }, fields: false, objHidden: only('planets', 'stations', 'gates') } },
  { id: 'def', name: 'Defences', desc: 'Weapons platforms, depots and the stations they guard', settings: { zones: false, paths: false, objHidden: only('planets', 'stations', 'platforms') } },
  { id: 'fields', name: 'Fields & hazards', desc: 'Asteroid fields, nebulae, death and exclusion zones', settings: { zoneCats: { ...NO_CATS, nebula: true, asteroids: true, death: true, exclusion: true }, paths: false, objHidden: only('planets') } },
  { id: 'clean', name: 'Clean (screenshots)', desc: 'Only the models and backdrop: no labels, zones, paths or grid', settings: { labels: 'none', zones: false, paths: false, grid: false, navgrid: false, lights: false } },
];

// saved views from before v1.22 stored an object-type rule; turn it into categories
const TYPES_OF = new Map(OBJ_GROUPS.map(([g, , t]) => [g, t]));
function upgrade(p) {
  if (!p || !p.rule || p.settings.objHidden) return p;
  const types = new Set((p.rule && p.rule.types) || []);
  const objHidden = types.size ? Object.fromEntries(OBJ_GROUPS.filter(([g]) => !(TYPES_OF.get(g) || []).some(t => types.has(t))).map(([g]) => [g, true])) : {};
  return { ...p, settings: { ...p.settings, objHidden }, rule: null };
}
const loadUser = () => { try { return JSON.parse(localStorage.getItem('fled.viewPresets') || '[]').map(upgrade); } catch { return []; } };
const saveUser = (l) => { try { localStorage.setItem('fled.viewPresets', JSON.stringify(l)); } catch { } };
export const allPresets = () => [...BUILTIN, ...loadUser()];

// ---------------------------------------------------------------- apply
export function applyPreset(app, p, sel = { ids: [p.id] }) {
  const S = app.settings;
  const st = p.settings || {};
  const next = { ...BASE, ...st, zoneCats: { ...BASE.zoneCats, ...(st.zoneCats || {}) }, objHidden: { ...(st.objHidden || {}) } };
  const rebuild = { fields: S.fields !== next.fields, paths: S.paths !== next.paths || S.labels !== next.labels, rings: S.rings !== next.rings };
  for (const k of CONTENT_KEYS) S[k] = next[k];
  S.zoneCats = next.zoneCats; S.objHidden = next.objHidden;
  S.viewSel = sel.ids; S.viewPreset = p.id; S.viewPresetName = p.name; S.viewRule = null; delete S.viewFacs;
  saveSettings(S);
  app.viewRule = null;
  if (app.sys) {
    if (rebuild.fields) app.fields.build(app.sys);
    if (rebuild.paths) app.paths.build(app.sys, true);
    if (rebuild.rings) app.rings.build(app.sys, true);
  }
  app.viewport.applyAllFilters(); app.viewport.applyLightingMode(); app.viewport.poke();
  app.rebuildMenus(); app.buildToolstrip(); app.outliner.render();
}
// an eye was clicked by hand: the toolbar shows "Custom" until a view is chosen again
export function markCustomView(app) {
  const S = app.settings; if (S.viewPreset === 'custom') return;
  S.viewSel = []; S.viewPreset = 'custom'; S.viewPresetName = 'Custom'; saveSettings(S); app.buildToolstrip();
}
// one preset that shows everything any of the given presets shows
export function combinePresets(list) {
  if (list.length === 1) return list[0];
  const full = list.map(p => ({ ...BASE, ...(p.settings || {}), zoneCats: { ...BASE.zoneCats, ...((p.settings || {}).zoneCats || {}) }, objHidden: { ...((p.settings || {}).objHidden || {}) } }));
  const settings = { zoneCats: {}, objHidden: {} };
  for (const k of CONTENT_KEYS) settings[k] = k === 'labels' ? full.map(f => f.labels).sort((a, b) => (LABEL_RANK[b] ?? 1) - (LABEL_RANK[a] ?? 1))[0] : full.some(f => f[k]);
  for (const c of Object.keys(ALL_CATS)) settings.zoneCats[c] = full.some(f => f.zoneCats[c]);
  for (const [g] of OBJ_GROUPS) if (full.every(f => f.objHidden[g])) settings.objHidden[g] = true;
  return { id: list.map(p => p.id).join('+'), name: list.map(p => p.name).join(' + '), desc: 'Combination: shows everything any of the ticked views shows', settings };
}
export function selection(app) {
  const S = app.settings;
  if (S.viewPreset === 'custom') return { ids: [] };
  const ids = Array.isArray(S.viewSel) ? S.viewSel.filter(id => allPresets().some(p => p.id === id)) : (allPresets().some(p => p.id === (S.viewPreset || 'std')) ? [S.viewPreset || 'std'] : []);
  return { ids };
}
// apply the ticked views (empty → Standard)
export function applySelection(app, ids) {
  const list = ids.map(id => allPresets().find(p => p.id === id)).filter(Boolean);
  if (!list.length) return applyPreset(app, BUILTIN[0]);
  applyPreset(app, combinePresets(list), { ids: list.map(p => p.id) });
}
export function currentPreset(app) { const id = app.settings.viewPreset || 'std'; return allPresets().find(p => p.id === id) || { id, name: app.settings.viewPresetName || 'Custom' }; }

// snapshot of what is on screen now
function snapshot(app, name) {
  const S = app.settings, settings = {};
  for (const k of CONTENT_KEYS) settings[k] = S[k];
  settings.zoneCats = { ...S.zoneCats }; settings.objHidden = { ...(S.objHidden || {}) };
  return { id: 'u_' + Date.now().toString(36), name, settings, user: true };
}

// ---------------------------------------------------------------- toolbar control
export function presetControl(app) {
  const cur = currentPreset(app);
  const label = h('span', { class: 'vsel-label' }, cur.name);
  const btn = h('button', { class: 'vsel', type: 'button', title: (cur.id === 'custom' ? 'You changed eyes in the Outliner by hand' : (cur.desc || '')) + ' — tick one or more views', onclick: () => open ? close() : show() }, label, h('span', { class: 'vsel-caret' }, '▾'));
  let open = null;
  const close = () => { if (!open) return; open.remove(); open = null; document.removeEventListener('mousedown', outside, true); document.removeEventListener('keydown', esc, true); };
  const outside = (e) => { if (open && !open.contains(e.target) && !btn.contains(e.target)) close(); };
  const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const show = () => {
    const panel = h('div', { class: 'vsel-panel' }); open = panel;
    const draw = () => {
      const { ids } = selection(app); const on = new Set(ids);
      const toggle = (id, exclusive) => {
        let next = [...on];
        if (on.has(id)) next = next.filter(x => x !== id);
        else if (exclusive) next = [id];
        else next = [...next.filter(x => !EXCLUSIVE.has(x)), id];
        applySelection(app, next); label.textContent = currentPreset(app).name; draw();
      };
      const item = (checked, text, title, onclick, cls = '') => h('label', { class: 'vsel-item ' + cls, title }, h('input', { type: 'checkbox', checked, onchange: onclick }), h('span', {}, text));
      panel.innerHTML = '';
      panel.append(h('div', { class: 'vsel-head' }, 'Views', h('span', {}, 'tick several to combine')));
      for (const p of BUILTIN) panel.append(item(on.has(p.id), p.name, p.desc + (EXCLUSIVE.has(p.id) ? ' (on its own — unticks the others)' : ''), () => toggle(p.id, EXCLUSIVE.has(p.id)), EXCLUSIVE.has(p.id) ? 'excl' : ''));
      const u = loadUser();
      if (u.length) { panel.append(h('div', { class: 'vsel-head' }, 'Saved')); for (const p of u) panel.append(item(on.has(p.id), p.name, 'Saved view', () => toggle(p.id, false))); }
      panel.append(...[
        h('div', { class: 'vsel-note' }, 'A view switches the category eyes in the Outliner — change any of them there. Only one faction? Use ⚙ → faction in the Outliner, then “Draw only listed”.'),
        h('hr'),
        h('button', { class: 'vsel-act', onclick: async () => { close(); const n = ((await promptDialog('Save view', 'Name for the current view (kind and category eyes, labels, paths, grids…)', '')) || '').trim(); if (!n) return; const p = snapshot(app, n); saveUser([...loadUser(), p]); applyPreset(app, p); toast(`Saved view “${n}”`); } }, 'Save current view…'),
        u.length ? h('button', { class: 'vsel-act', onclick: () => { close(); manage(app); } }, 'Manage saved views…') : null,
        h('button', { class: 'vsel-act', title: 'Alt+H', onclick: () => { close(); app.showAll(); } }, 'Show everything (Alt+H)')].filter(Boolean));
    };
    draw();
    document.body.append(panel);
    const r = btn.getBoundingClientRect(); panel.style.top = (r.bottom + 2) + 'px'; panel.style.left = Math.max(8, Math.min(r.left, innerWidth - panel.offsetWidth - 8)) + 'px';
    document.addEventListener('mousedown', outside, true); document.addEventListener('keydown', esc, true);
  };
  return h('label', { class: 'tview', title: cur.desc || '' }, 'View', btn);
}

function manage(app) {
  const list = h('div', {});
  const draw = () => {
    list.innerHTML = '';
    const u = loadUser(); if (!u.length) { list.append(h('div', { class: 'note' }, 'No saved views.')); return; }
    for (const p of u) list.append(h('div', { class: 'row', style: { gap: '8px' } }, h('span', { class: 'nm' }, p.name),
      h('button', { class: 'btn sm', onclick: async () => { const n = ((await promptDialog('Rename view', 'Name', p.name)) || '').trim(); if (!n) return; saveUser(loadUser().map(x => x.id === p.id ? { ...x, name: n } : x)); draw(); app.buildToolstrip(); } }, 'Rename'),
      h('button', { class: 'btn sm', title: 'Store what is on screen now under this name', onclick: () => { const s = snapshot(app, p.name); saveUser(loadUser().map(x => x.id === p.id ? { ...s, id: p.id } : x)); toast(`Updated “${p.name}”`); } }, 'Update'),
      h('button', { class: 'btn sm danger', onclick: async () => { if (!(await confirmDialog('Delete view', `Delete the saved view “${p.name}”?`, 'Delete', true))) return; saveUser(loadUser().filter(x => x.id !== p.id)); draw(); app.buildToolstrip(); } }, 'Delete')));
  };
  draw();
  modal({ title: 'Saved views', body: list, buttons: [{ label: 'Close' }] });
}

// label for the outliner
export function presetName(app) { return currentPreset(app).name; }
// kept for older callers; views no longer carry item rules
export function compileRule() { return null; }
