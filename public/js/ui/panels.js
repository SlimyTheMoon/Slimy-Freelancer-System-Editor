import { fieldEditor } from './fieldedit.js';
import { keyTip, keyIsRead, documentedKeys } from '../inidocs.js';
import { falloffSection } from './falloff.js';
import { starPreview } from './starpreview.js';
import { renderInfocard } from './rdl.js';
import { searchPicker, pickerFor, PICKER_KEYS } from './picker.js';
import { populationSection, pathSection } from './encounters.js';
import { pathLabel } from '../paths.js';
import { bulkPanel } from './bulk.js';
import { applyPreset, presetName, BUILTIN, markCustomView } from './viewpresets.js';
import { OBJ_GROUPS, ZONE_GROUPS, groupOf, groupOn, kindOn, layerOn, setGroup, setKind, groupLabel } from './visibility.js';
import { h, datalist, toast, confirmDialog, promptDialog } from './dom.js';
import { kindOf, getPos, getRot, setPos, setRot } from '../system.js';
import { objectColor } from '../visuals.js';
import { fmtNum, fmtVec, IniEntry } from '../formats/ini.js';
import * as dialogs from './dialogs.js';
import { api, dataPath } from '../api.js';
import { validateSystem } from '../validate.js';
import { textEditor, stringBrowser, ID_KIND } from './strings.js';

// starting text for a new name: current name, else nickname turned into words
function suggestText(app, key, sec) {
  if (!sec) return '';
  const cur = app.game.name(sec.get(key)); if (cur && ID_KIND(key) === 'string') return cur;
  if (ID_KIND(key) === 'infocard') return '';
  const n = sec.get('nickname') || ''; return n.replace(/_/g, ' ');
}

const hex = (c) => '#' + c.toString(16).padStart(6, '0');

// ============================================================ Outliner
// eye toggle for outliner rows: hides the item in the 3D view only (nothing is written to the INI)
const EYE = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 19c-7 0-11-7-11-7a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 7 11 7a18.5 18.5 0 0 1-2.16 3.19"/><path d="M1 1l22 22"/></svg>';
// eye states: 'on' (drawn; the eye shows on hover) · 'off' (switched off here) · 'some' (on, but some items
// inside are off) · 'inherit' (on here, but a level above is off — faded)
function eyeBtn(state, title, onClick) {
  if (state === true) state = 'off'; else if (state === false) state = 'on';
  const b = h('span', { class: 'eye ' + state, title, onclick: (e) => { e.stopPropagation(); onClick(); }, ondblclick: (e) => e.stopPropagation(), onmousedown: (e) => e.stopPropagation() });
  b.innerHTML = state === 'off' || state === 'inherit' ? EYE_OFF : EYE; return b;
}
const KIND_NAME = { object: 'Objects', zone: 'Zones', light: 'Light sources' };
const NOTE = '\n(Only what the 3D view draws — nothing is changed in the game files.)';
// make one hidden thing visible on its own: switch on the levels above it and switch off its siblings there
function revealOnly(app, s) {
  const k = kindOf(s), g = groupOf(app, s), ents = app.sys.entities;
  if (!kindOn(app, k)) { setKind(app, k, true); if (k === 'object') for (const [o] of OBJ_GROUPS) setGroup(app, k, o, o === g); if (k === 'zone') for (const [o] of ZONE_GROUPS) setGroup(app, k, o, o === g); }
  else if (!groupOn(app, k, g)) { setGroup(app, k, g, true); if (!app.hidden) app.hidden = new Set(); for (const e of ents) if (e !== s && kindOf(e) === k && groupOf(app, e) === g) app.hidden.add(e.id); app.saveHidden(); }
  app.hidden && app.hidden.delete(s.id); app.saveHidden();
  markCustomView(app); app.refreshVisibility();
}
// eye of one item (or a trade lane = several ring ids)
function itemEye(app, list, what = 'this item') {
  const ids = list.map(s => s.id);
  if (ids.every(id => app.isHidden(id))) return eyeBtn('off', `Hidden. Click to show ${what} again.` + NOTE, () => app.setHidden(ids, false));
  const s = list[0], k = kindOf(s);
  if (!layerOn(app, s)) { const why = !kindOn(app, k) ? `all ${KIND_NAME[k].toLowerCase()}` : `the category “${groupLabel(k, groupOf(app, s))}”`; return eyeBtn('inherit', `Not drawn because ${why} is switched off.\nClick to show only ${what} from it.` + NOTE, () => revealOnly(app, s)); }
  return eyeBtn('on', `Drawn. Click to hide ${what} (shortcut H for the selection).` + NOTE, () => app.setHidden(ids, true));
}

export class Outliner {
  constructor(el, app) {
    this.el = el; this.app = app; this.filter = ''; this.kinds = { object: true, zone: true, light: true }; this.collapsed = {};
    this.f = { type: '', faction: '', base: false, loadout: false, zcat: '' }; this.groupLanes = true; this.openLanes = new Set(); this.showFilters = false;
    this.search = h('input', { placeholder: 'Filter… (also key=value, e.g. loadout=li_ or reputation=li_n_grp)', oninput: () => { this.filter = this.search.value.toLowerCase(); this.render(); } });
    this.fbtn = h('button', { class: 'btn sm', title: 'More filters', onclick: () => { this.showFilters = !this.showFilters; this.render(); } }, '⚙');
    this.isolate = false;
    this.isoBtn = h('button', { class: 'btn sm', title: 'Draw only listed: the 3D view shows only what this list shows (search text, ⚙ filters, the Objects/Zones/Lights buttons). Click again to draw everything again.', onclick: () => { this.isolate = !this.isolate; this.render(); } }, '◎ Only listed');
    this.chips = h('div', { class: 'chips' });
    this.fpanel = h('div', { class: 'fpanel' });
    this.tree = h('div', { class: 'tree' });
    el.append(h('div', { class: 'searchrow' }, this.search, this.fbtn), h('div', { class: 'chips' }, this.chips, this.isoBtn), this.fpanel, this.tree);
    this.chips.className = 'chipset';
  }
  label(sec) {
    const app = this.app, k = kindOf(sec);
    const name = app.game.name(sec.get('ids_name'));
    const nick = sec.get('nickname') || '(no nickname)';
    let sub = '';
    if (k === 'object') { const a = app.game.arch(sec.get('archetype')); sub = a ? a.type.toLowerCase().replace(/_/g, ' ') : (sec.get('archetype') || ''); }
    if (k === 'zone') { const zi = app.zoneInfo && app.zoneInfo.get(nick.toLowerCase()); sub = zi ? zi.kind : (sec.get('shape') || '').toLowerCase(); }
    if (k === 'light') sub = (sec.get('type') || 'light').toLowerCase();
    return { title: name ? `${name}` : nick, nick, sub, name };
  }
  // text filter: plain words match name/nickname/type/archetype; key=value matches that entry
  matches(s, l) {
    if (!this.filter) return true;
    for (const tok of this.filter.split(/\s+/).filter(Boolean)) {
      const eq = tok.indexOf('=');
      if (eq > 0) { const k = tok.slice(0, eq), v = tok.slice(eq + 1); if (!s.findAll(k).some(e => e.value.toLowerCase().includes(v))) return false; }
      else if (!(l.title + ' ' + l.nick + ' ' + l.sub + ' ' + (s.get('archetype') || '')).toLowerCase().includes(tok)) return false;
    }
    return true;
  }
  passes(s, k) {
    const f = this.f, g = this.app.game;
    if (k === 'object') {
      if (f.type) { const a = g.arch(s.get('archetype')); if (!a || a.type !== f.type) return false; }
      if (f.faction && (s.get('reputation') || '').toLowerCase() !== f.faction) return false;
      if (f.base && !(s.has('base') || s.has('dock_with'))) return false;
      if (f.loadout && !s.has('loadout')) return false;
    } else if (f.type || f.faction || f.base || f.loadout) return false;
    if (k === 'zone' && f.zcat) { const v = this.app.viewport.visuals.get(s.id); if (!v || v.userData.cat !== f.zcat) return false; }
    return true;
  }
  renderFilters() {
    const app = this.app, g = app.game; this.fpanel.innerHTML = '';
    const active = Object.values(this.f).some(Boolean);
    this.fbtn.classList.toggle('primary', active);
    if (!this.showFilters) return;
    const types = [...new Set(app.sys.objects.map(o => (g.arch(o.get('archetype')) || {}).type).filter(Boolean))].sort();
    const facs = [...new Set(app.sys.objects.map(o => (o.get('reputation') || '').toLowerCase()).filter(Boolean))].sort();
    const zcats = [...new Set([...app.viewport.visuals.values()].filter(v => v.userData.kind === 'zone').map(v => v.userData.cat).filter(Boolean))].sort();
    const sel = (key, opts, label) => h('select', { onchange: (e) => { this.f[key] = e.target.value; this.render(); } }, h('option', { value: '' }, label), opts.map(([v, l]) => h('option', { value: v, selected: this.f[key] === v }, l)));
    const chk = (key, label) => h('label', { class: 'topt' }, h('input', { type: 'checkbox', checked: !!this.f[key], onchange: (e) => { this.f[key] = e.target.checked; this.render(); } }), label);
    this.fpanel.append(
      sel('type', types.map(t => [t, t.toLowerCase().replace(/_/g, ' ')]), 'any object type'),
      sel('faction', facs.map(f => [f, `${g.factionName(f) || f}`]), 'any faction'),
      sel('zcat', zcats.map(c => [c, c]), 'any zone kind'),
      h('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap' } }, chk('base', 'has base'), chk('loadout', 'has loadout'),
        h('label', { class: 'topt' }, h('input', { type: 'checkbox', checked: this.groupLanes, onchange: (e) => { this.groupLanes = e.target.checked; this.render(); } }), 'group trade lanes')),
      ...(active ? [h('button', { class: 'btn sm', onclick: () => { this.f = { type: '', faction: '', base: false, loadout: false, zcat: '' }; this.render(); } }, 'Clear filters')] : []));
  }
  // trade lanes: chains of rings linked by next_ring, starting at a ring without prev_ring
  lanes() {
    const sys = this.app.sys, g = this.app.game;
    const rings = sys.objects.filter(o => (g.arch(o.get('archetype')) || {}).type === 'TRADELANE_RING');
    const byNick = new Map(rings.map(r => [(r.get('nickname') || '').toLowerCase(), r]));
    const seen = new Set(), out = [];
    const heads = rings.filter(r => !r.get('prev_ring') || !byNick.has(r.get('prev_ring').toLowerCase()));
    for (const hd of [...heads, ...rings]) {
      if (seen.has(hd)) continue;
      const chain = []; let cur = hd;
      while (cur && !seen.has(cur)) { seen.add(cur); chain.push(cur); cur = byNick.get((cur.get('next_ring') || '').toLowerCase()); }
      out.push(chain);
    }
    return out;
  }
  laneTitle(chain) {
    const g = this.app.game, a = chain[0], b = chain[chain.length - 1];
    // tradelane_space_name on an end ring names the place at that end (checked: Li01 ring 16 → Fort Bush, 3 km away)
    const nm = (r) => g.name(r.get('tradelane_space_name')) || '';
    // fallback: the nearest named non-ring object to that end
    const near = (r) => { const p = getPos(r); let best = null, bd = 15000; for (const o of this.app.sys.objects) { if ((g.arch(o.get('archetype')) || {}).type === 'TRADELANE_RING') continue; const n = g.name(o.get('ids_name')); if (!n) continue; const q = getPos(o), d = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]); if (d < bd) { bd = d; best = n; } } return best; };
    const from = nm(a) || near(a) || a.get('nickname'), to = nm(b) || near(b) || b.get('nickname');
    return `${from} ↔ ${to}`;
  }
  render() {
    const app = this.app; if (!app.sys) return;
    this.chips.innerHTML = '';
    for (const [k, lbl] of [['object', 'Objects'], ['zone', 'Zones'], ['light', 'Lights']]) this.chips.append(h('button', { class: 'chip' + (this.kinds[k] ? ' on' : ''), onclick: () => { this.kinds[k] = !this.kinds[k]; this.render(); } }, lbl));
    this.renderFilters();
    this.tree.innerHTML = '';
    const groups = { object: [], zone: [], light: [] };
    const ok = new Set();
    for (const s of app.sys.entities) {
      const k = kindOf(s); if (!this.kinds[k]) continue;
      const l = this.label(s);
      if (!this.matches(s, l) || !this.passes(s, k)) continue;
      groups[k].push([s, l]); ok.add(s);
    }
    // "draw only listed": the 3D view follows this list
    const iso = this.isolate ? new Set([...ok].map(s => s.id)) : null;
    const isoChanged = !!iso !== !!app.isolate || (iso && (iso.size !== app.isolate.size || [...iso].some(id => !app.isolate.has(id))));
    app.isolate = iso; this.isoBtn.classList.toggle('primary', !!iso);
    if (isoChanged) { app.viewport.applyAllFilters(); app.viewport.poke(); }
    // status: how much is not drawn, and the way back
    const ents = app.sys.entities, notDrawn = ents.filter(s => app.notShown(s.id)).length;
    if (notDrawn) this.tree.append(h('div', { class: 'viewbanner' },
      h('div', { class: 'vb-line' }, h('span', {}, iso ? `Drawing only the ${iso.size} listed item${iso.size === 1 ? '' : 's'} (${notDrawn} of ${ents.length} not drawn).` : `${notDrawn} of ${ents.length} items not drawn.`),
        h('button', { class: 'btn sm', title: 'All eyes on, view “Everything”, “Only listed” off (Alt+H)', onclick: () => app.showAll() }, 'Show all')),
      h('div', { class: 'vb-legend' }, 'Click an eye to hide or show. A faded eye: its category is off. H hides the selection, Shift+H everything else, Alt+H shows all.')));
    this.rows = new Map();
    const mkRow = (s, l, k, indent) => {
      let color = '#8a96a8';
      if (k === 'object') color = hex(objectColor(app.game.arch(s.get('archetype'))));
      if (k === 'zone') { const v = app.viewport.visuals.get(s.id); if (v && v.userData.color) color = '#' + v.userData.color.getHexString(); }
      if (k === 'light') color = '#ffe9a0';
      const off = app.notShown(s.id);
      const row = h('div', { class: 'row' + (app.isSelected(s.id) ? ' sel' : '') + (off ? ' hid' : ''), title: l.nick + (off ? ' — not drawn' : ''), style: { paddingLeft: indent + 'px' }, onclick: (e) => app.select(s.id, e.shiftKey || e.ctrlKey || e.metaKey), ondblclick: () => app.viewport.focus(s.id) },
        h('span', { class: 'dot', style: { background: color } }), h('span', { class: 'nm' }, l.title), h('span', { class: 'sub' }, l.name ? l.nick : l.sub),
        itemEye(app, [s]));
      this.rows.set(s.id, row); return row;
    };
    const head = (key, cls, title, count, eye, indent) => h('div', { class: 'grp ' + cls, style: indent ? { paddingLeft: indent + 'px' } : null, onclick: () => { this.collapsed[key] = !this.collapsed[key]; this.render(); } }, (this.collapsed[key] ? '▸ ' : '▾ ') + title, h('span', {}, count), eye);
    const plural = (n) => n === 1 ? 'item' : 'items';
    for (const k of ['object', 'zone', 'light']) {
      if (!this.kinds[k]) continue;
      const list = groups[k]; if (!list.length) continue;
      const kOn = kindOn(app, k), mine = list.filter(([s]) => app.isHidden(s.id)).length;
      const anyGroupOff = k === 'object' ? OBJ_GROUPS.some(([g]) => !groupOn(app, k, g) && list.some(([s]) => groupOf(app, s) === g)) : k === 'zone' ? ZONE_GROUPS.some(([g]) => !groupOn(app, k, g) && list.some(([s]) => groupOf(app, s) === g)) : false;
      const kState = !kOn ? 'off' : (anyGroupOff || mine) ? 'some' : 'on';
      const kEye = eyeBtn(kState, kState === 'off' ? `All ${KIND_NAME[k].toLowerCase()} are switched off. Click to switch them on.` + NOTE : kState === 'some' ? `Some ${KIND_NAME[k].toLowerCase()} are hidden. Click to show all of them.` + NOTE : `Click to switch off all ${KIND_NAME[k].toLowerCase()}.` + NOTE,
        () => { if (kState === 'some') { if (k !== 'light') for (const [g] of (k === 'object' ? OBJ_GROUPS : ZONE_GROUPS)) setGroup(app, k, g, true); if (app.hidden) for (const [s] of list) app.hidden.delete(s.id); app.saveHidden(); } else setKind(app, k, kState === 'off'); markCustomView(app); app.refreshVisibility(); });
      const drawnHere = list.filter(([s]) => !app.notShown(s.id)).length;
      this.tree.append(head(k, 'top', KIND_NAME[k], drawnHere === list.length ? list.length : `${list.length} · ${list.length - drawnHere} not drawn`, kEye, 0));
      if (this.collapsed[k]) continue;
      const frag = document.createDocumentFragment();
      if (k === 'light') { for (const [s, l] of list) frag.append(mkRow(s, l, k, 22)); this.tree.append(frag); continue; }
      const defs = k === 'object' ? OBJ_GROUPS : ZONE_GROUPS;
      for (const [g, gname] of defs) {
        let items = list.filter(([s]) => groupOf(app, s) === g); if (!items.length) continue;
        if (k === 'object') items.sort((a, b) => typeRank(app, a[0]) - typeRank(app, b[0]) || a[1].nick.localeCompare(b[1].nick, undefined, { numeric: true }));
        const gOn = groupOn(app, k, g), gMine = items.filter(([s]) => app.isHidden(s.id)).length;
        const gState = !kOn ? 'inherit' : !gOn ? 'off' : gMine ? 'some' : 'on';
        const gEye = eyeBtn(gState,
          gState === 'inherit' ? `Not drawn because all ${KIND_NAME[k].toLowerCase()} are switched off.\nClick to show only “${gname}”.` + NOTE
            : gState === 'off' ? `“${gname}” is switched off (in every system). Click to switch it on.` + NOTE
              : gState === 'some' ? `${gMine} ${plural(gMine)} in “${gname}” hidden one by one. Click to show them again.` + NOTE
                : `Click to switch off “${gname}” (in every system).` + NOTE,
          () => {
            if (gState === 'inherit') { setKind(app, k, true); for (const [o] of defs) setGroup(app, k, o, o === g); }
            else if (gState === 'some') { for (const [s] of items) app.hidden.delete(s.id); app.saveHidden(); }
            else setGroup(app, k, g, gState === 'off');
            markCustomView(app); app.refreshVisibility();
          });
        const gDrawn = items.filter(([s]) => !app.notShown(s.id)).length;
        const key = k + ':' + g;
        frag.append(head(key, 'cat' + (gState === 'off' || gState === 'inherit' ? ' dim' : ''), gname, gDrawn === items.length ? items.length : `${items.length} · ${items.length - gDrawn} not drawn`, gEye, 12));
        if (this.collapsed[key]) continue;
        if (g === 'lanes' && this.groupLanes) {
          for (const chain of this.lanes()) {
            const vis = chain.filter(r => ok.has(r)); if (!vis.length) continue;
            const lkey = (chain[0].get('nickname') || '').toLowerCase(), open = this.openLanes.has(lkey);
            const allSel = chain.every(r => app.isSelected(r.id)), laneOff = chain.every(r => app.notShown(r.id));
            frag.append(h('div', { class: 'row' + (allSel ? ' sel' : '') + (laneOff ? ' hid' : ''), style: { paddingLeft: '22px' }, title: `${chain[0].get('nickname')} … ${chain[chain.length - 1].get('nickname')}`, onclick: (e) => { if (e.target.classList.contains('tw')) return; app.selectMany(chain.map(r => r.id)); }, ondblclick: () => app.viewport.focus(chain[Math.floor(chain.length / 2)].id) },
              h('span', { class: 'tw', style: { width: '12px', cursor: 'pointer', color: 'var(--faint)' }, onclick: () => { open ? this.openLanes.delete(lkey) : this.openLanes.add(lkey); this.render(); } }, open ? '▾' : '▸'),
              h('span', { class: 'dot', style: { background: hex(objectColor(app.game.arch(chain[0].get('archetype')))) } }), h('span', { class: 'nm' }, this.laneTitle(chain)), h('span', { class: 'sub' }, `${chain.length} rings`),
              itemEye(app, chain, 'this trade lane')));
            if (open) for (const r of vis) frag.append(mkRow(r, this.label(r), 'object', 40));
          }
        } else for (const [s, l] of items) frag.append(mkRow(s, l, k, 22));
      }
      this.tree.append(frag);
    }
  }
  highlight() {
    if (!this.rows) return;
    for (const [id, r] of this.rows) r.classList.toggle('sel', this.app.isSelected(id));
    const first = this.rows.get(this.app.selection[this.app.selection.length - 1]);
    if (first) first.scrollIntoView({ block: 'nearest' });
  }
}
function typeRank(app, s) {
  const order = ['SUN', 'PLANET', 'MOON', 'STATION', 'DOCKING_RING', 'JUMP_GATE', 'JUMP_HOLE', 'AIRLOCK_GATE', 'WEAPONS_PLATFORM', 'DESTROYABLE_DEPOT', 'SATELLITE', 'TRADELANE_RING'];
  const a = app.game.arch(s.get('archetype')); const i = a ? order.indexOf(a.type) : -1; return i < 0 ? 50 : i;
}

// ============================================================ Systems list
export class SystemsList {
  constructor(el, app) {
    this.el = el; this.app = app; this.filter = '';
    this.search = h('input', { placeholder: 'Filter systems…', oninput: () => { this.filter = this.search.value.toLowerCase(); this.render(); } });
    this.list = h('div', { class: 'tree' });
    el.append(h('div', { class: 'searchrow' }, this.search, h('button', { class: 'btn sm', title: 'Create a new system', onclick: () => dialogs.newSystem(app) }, '+ New')), this.list);
  }
  render() {
    const app = this.app; this.list.innerHTML = '';
    const dirtyKeys = new Set([...app.history.dirty].map(d => d.key));
    const items = app.game.systems.map(s => ({ s, name: app.game.name(s.strid) || '' }))
      .filter(x => !this.filter || (x.s.nickname + ' ' + x.name).toLowerCase().includes(this.filter))
      .sort((a, b) => a.s.nickname.localeCompare(b.s.nickname, undefined, { numeric: true }));
    for (const { s, name } of items) {
      const cur = app.sys && app.sys.nickname.toLowerCase() === s.nickname.toLowerCase();
      this.list.append(h('div', { class: 'row' + (cur ? ' cur sel' : '') + (dirtyKeys.has('sys:' + s.nickname.toLowerCase()) ? ' dirty' : ''), style: s.labelOnly ? { opacity: 0.5 } : {}, title: s.labelOnly ? 'No system file: a name on the universe map only' : '', onclick: () => app.openSystem(s.nickname) },
        h('span', { class: 'nm' }, name || s.nickname), h('span', { class: 'sub' }, s.labelOnly ? s.nickname + ' · map label' : s.nickname)));
    }
  }
}

// ============================================================ Properties
const OBJECT_KEYS = ['nickname', 'ids_name', 'ids_info', 'pos', 'rotate', 'archetype', 'star', 'atmosphere_range', 'burn_color', 'ambient_color', 'base', 'dock_with', 'reputation', 'behavior', 'visit', 'goto', 'jump_effect', 'prev_ring', 'next_ring', 'tradelane_space_name', 'loadout', 'parent', 'ring', 'pilot', 'voice', 'space_costume', 'difficulty_level', 'msg_id_prefix', 'spin', 'faction'];
const ZONE_KEYS = ['nickname', 'ids_name', 'ids_info', 'pos', 'rotate', 'shape', 'size', 'property_flags', 'property_fog_color', 'sort', 'toughness', 'density', 'repop_time', 'max_battle_size', 'pop_type', 'relief_time', 'path_label', 'usage', 'mission_type', 'encounter', 'faction', 'comment', 'lane_id', 'tradelane_attack', 'attack_ids', 'music', 'spacedust', 'spacedust_maxparticles', 'interference', 'damage', 'edge_fraction', 'population_additive', 'visit', 'mission_eligible', 'vignette_type', 'Music'];
const LIGHT_KEYS = ['nickname', 'pos', 'rotate', 'color', 'range', 'type', 'attenuation', 'atten_curve', 'direction', 'behavior', 'color_curve'];
const ID_KEYS = new Set(['ids_name', 'ids_info', 'strid_name', 'tradelane_space_name']);
// Flag names of zone property_flags and visit
const ZONE_FLAGS = [
  ['Object density', [[0x1, 'Low'], [0x2, 'Medium'], [0x4, 'High']]],
  ['Danger', [[0x8, 'Low'], [0x10, 'Medium'], [0x20, 'High']]],
  ['Field type', [[0x40, 'Rock'], [0x80, 'Debris'], [0x100, 'Ice'], [0x200, 'Lava'], [0x400, 'Nomad'], [0x800, 'Crystal'], [0x1000, 'Mines'], [0x2000, 'Badlands'], [0x4000, 'Gas pockets'], [0x8000, 'Cloud']]],
  ['Exclusion', [[0x10000, 'Exclusion 1'], [0x20000, 'Exclusion 2']]],
  ['Effects', [[0x40000, 'Damage'], [0x80000, 'Drag modifier'], [0x100000, 'Interference'], [0x200000, 'Spacedust / Music']]],
];
const VISIT_FLAGS = [
  ['Visit', [[1, 'Visited'], [2, 'Unused'], [4, 'Mineable zone'], [8, 'Actively visited'], [16, 'Wreck'], [32, 'Zone'], [64, 'Faction'], [128, 'Hidden']]],
];
const flagName = (groups, bit) => { for (const [g, list] of groups) for (const [b, l] of list) if (b === bit) return groups.length > 1 ? `${g}: ${l}` : l; return null; };
function flagsText(v, groups) {
  const on = []; for (let b = 1; b <= v && b > 0; b *= 2) if (v & b) on.push(flagName(groups, b) || `unknown ${b}`);
  return on.length ? on.join(' · ') : 'none';
}

export class Props {
  constructor(el, app) { this.el = el; this.app = app; this.suggestCache = new Map(); }

  render() {
    const app = this.app; this.el.innerHTML = ''; this.posInputs = null;
    // universe map: show the system selected there (not the one open in the 3D view)
    const uniSel = app.currentView === 'universe' && app.universeMap && app.universeMap.selected;
    if (uniSel && !(app.sys && app.sys.sys === uniSel)) return this.renderUniverseSystem(uniSel);
    if (!app.sys) return;
    const sel = app.selected();
    if (!sel.length) return this.renderSystem();
    if (sel.length > 1) return this.renderMulti(sel);
    this.renderEntity(sel[0]);
  }

  // live gizmo feedback
  liveTransform() {
    if (!this.posInputs || this.app.selection.length !== 1) return;
    const v = this.app.viewport.visuals.get(this.app.selection[0]); if (!v) return;
    const p = v.position.toArray(); const r = [v.rotation.x, v.rotation.y, v.rotation.z].map(x => x * 180 / Math.PI);
    this.posInputs.pos.forEach((inp, i) => inp.value = fmtNum(p[i], 0));
    this.posInputs.rot.forEach((inp, i) => inp.value = fmtNum(r[i], 2));
  }

  edit(label, fn) { this.app.edit(label, fn); }

  // ---------------- entity ----------------
  renderEntity(sec) {
    const app = this.app, game = app.game, k = kindOf(sec);
    const nick = sec.get('nickname') || '';
    const name = game.name(sec.get('ids_name'));
    const arch = k === 'object' ? game.arch(sec.get('archetype')) : null;
    const kindLabel = k === 'object' ? (arch ? arch.type.replace(/_/g, ' ') : 'object') : k === 'zone' ? 'zone · ' + (sec.get('shape') || '?') : 'light source';
    const nickInput = h('input', { value: nick, style: { width: '100%', fontSize: '15px', fontWeight: 600 }, onchange: () => app.renameEntity(sec, nickInput.value.trim()) });
    this.el.append(h('div', { class: 'phead' }, h('div', { class: 'kind' }, kindLabel), nickInput, h('div', { class: 'sub' }, name || (k === 'object' ? 'no ids_name' : ''))));

    // transform
    const p = getPos(sec), r = getRot(sec);
    const mkv = (vals, digits, onset) => vals.map((v, i) => h('input', { type: 'number', value: fmtNum(v, digits), step: digits ? 1 : 100, onchange: (e) => onset(i, parseFloat(e.target.value) || 0) }));
    const posIn = mkv(p, 0, (i, val) => this.edit('Set position', () => { const q = getPos(sec); q[i] = val; setPos(sec, q); }));
    const rotIn = mkv(r, 2, (i, val) => this.edit('Set rotation', () => { const q = getRot(sec); q[i] = val; setRot(sec, q); }));
    this.posInputs = { pos: posIn, rot: rotIn };
    const vecRow = (ins) => h('div', { class: 'vec' }, h('label', { class: 'x' }, 'X'), ins[0], h('label', { class: 'y' }, 'Y'), ins[1], h('label', { class: 'z' }, 'Z'), ins[2]);
    this.el.append(h('div', { class: 'psec' }, h('h3', {}, 'Position', h('span', { class: 'act' }, h('button', { class: 'btn sm', title: 'Set Y to 0', onclick: () => this.edit('Flatten', () => { const q = getPos(sec); q[1] = 0; setPos(sec, q); }) }, 'Y=0'))), vecRow(posIn),
      h('h3', {}, 'Rotation (deg)', h('span', { class: 'act' }, h('button', { class: 'btn sm', onclick: () => this.edit('Reset rotation', () => sec.remove('rotate')) }, 'Reset'))), vecRow(rotIn)));

    if (k === 'object') this.objectSections(sec, arch);
    if (k === 'zone') this.zoneSections(sec);
    if (k === 'light') this.lightSections(sec);

    // infocard
    const info = game.infocard(sec.get('ids_info'));
    if (info) { const raw = game.infocards.get(parseInt(sec.get('ids_info'))); this.el.append(h('div', { class: 'psec' }, h('h3', {}, 'Infocard ' + sec.get('ids_info')), raw ? renderInfocard(raw, { maxHeight: '320px' }) : h('div', { class: 'info' }, info))); }

    // all entries
    this.el.append(this.entriesTable(sec, k === 'object' ? OBJECT_KEYS : k === 'zone' ? ZONE_KEYS : LIGHT_KEYS));

    // references
    const refs = nick ? app.sys.references(nick) : [];
    if (refs.length) this.el.append(h('div', { class: 'psec' }, h('h3', {}, `Referenced by (${refs.length})`), h('div', { class: 'reflist' }, refs.map(r => h('div', { onclick: () => kindOf(r.section) && app.select(r.section.id) }, `[${r.section.name}] ${r.section.get('nickname') || r.section.get('file') || ''} · ${r.entry.key}`)))));

    this.el.append(h('div', { class: 'psec' }, h('div', { class: 'btnrow' },
      h('button', { class: 'btn', onclick: () => app.viewport.focus(sec.id) }, 'Focus'),
      app.revealInIni ? h('button', { class: 'btn', title: 'Open the INI at this section in VS Code (Ctrl+Alt+E)', onclick: () => app.revealInIni(sec) }, 'Show in INI') : null,
      nick ? h('button', { class: 'btn', title: 'Every file in the mod that names this nickname; rename everywhere (Ctrl+Shift+F)', onclick: () => import('./refs.js').then(m => m.referencesDialog(app, { q: nick })) }, 'References…') : null,
      h('button', { class: 'btn', onclick: () => app.duplicateSelected() }, 'Duplicate'),
      h('button', { class: 'btn', onclick: () => app.copy() }, 'Copy'),
      h('button', { class: 'btn danger', onclick: () => app.deleteSelected() }, 'Delete'))));
  }

  objectSections(sec, arch) {
    const app = this.app, game = app.game;
    const t = arch ? arch.type : '';
    const sc = h('div', { class: 'psec' }, h('h3', {}, 'Archetype', h('span', { class: 'act' }, h('button', { class: 'btn sm', onclick: () => dialogs.pickArchetype(app, sec.get('archetype'), (a) => this.edit('Change archetype', () => { sec.set('archetype', a); app.sys.ensureArchetypePreload(a); if (game.arch(a)?.type === 'SUN' && !sec.has('star')) sec.set('star', 'med_white_sun'); })) }, 'Change…'),
        arch && arch.da && !/\.sph$/i.test(arch.da) ? h('button', { class: 'btn sm', title: 'Edit this model\'s hardpoints', onclick: () => import('./hardpoints.js').then(m => m.openHardpointEditorFor(app, sec.get('archetype'))) }, 'Hardpoints…') : null,
        arch && arch.da ? h('button', { class: 'btn sm', title: 'Edit this model\'s materials and textures', onclick: () => import('./materials.js').then(m => m.materialsForArchetype(app, sec.get('archetype'))) }, 'Materials…') : null)),
      h('div', { class: 'archcard' }, h('div', {},
        h('div', { class: 'ttl' }, sec.get('archetype') || '(none)'),
        h('div', { class: 'meta' }, arch ? `${t.toLowerCase()} · radius ${arch.radius || '?'} · ${(arch.da || '').split('\\').pop()}` : 'unknown archetype'),
        arch && game.name(arch.ids) ? h('div', { class: 'meta' }, game.name(arch.ids)) : null)));
    this.el.append(sc);

    if (t === 'JUMP_GATE' || t === 'JUMP_HOLE' || sec.has('goto')) this.el.append(this.gotoEditor(sec));
    if (t === 'TRADELANE_RING' || sec.has('next_ring') || sec.has('prev_ring')) this.el.append(this.laneSection(sec));
    if (['STATION', 'PLANET', 'DOCKING_RING', 'MOON'].includes(t) || sec.has('base') || sec.has('dock_with')) this.el.append(this.baseSection(sec, t));
    if (t === 'SUN' || sec.has('star')) this.el.append(this.sunSection(sec));
    if (t === 'PLANET' || sec.has('ring')) this.el.append(this.ringSection(sec));
    this.el.append(this.flagsSection(sec, 'visit', VISIT_FLAGS));
  }

  // star type (stararch.ini) — what the 3D view and the spines/flare overlay draw
  sunSection(sec) {
    const app = this.app, g = app.game;
    const cur = (sec.get('star') || '').toLowerCase();
    const sel = h('select', { onchange: () => this.edit('Change star', () => sec.set('star', sel.value)) },
      !g.stars.has(cur) ? h('option', { value: cur, selected: true }, cur ? `${cur} (unknown)` : '(none)') : null,
      [...g.stars.values()].sort((a, b) => a.nickname.localeCompare(b.nickname)).map(st => h('option', { value: st.nickname, selected: st.nickname.toLowerCase() === cur }, `${st.nickname} · r ${st.radius}`)));
    const st = g.stars.get(cur);
    const rows = [];
    if (st) {
      const S = st.section, sp = S.get('spines') && g.starSpines.get(S.get('spines').toLowerCase());
      rows.push(['star_glow', S.get('star_glow')], ['star_center', S.get('star_center')], ['spines', S.get('spines') ? `${S.get('spines')}${sp ? ` (${sp.items.length})` : ' (missing)'}` : ''], ['lens_flare', S.get('lens_flare')], ['lens_glow', S.get('lens_glow')], ['radius', S.get('radius')]);
      if (sp && ![2, 4, 6, 12].includes(sp.items.length)) rows.push(['', `⚠ ${sp.items.length} spines: Freelancer only draws spine sets of 2, 4, 6 or 12 (others get zero visibility)`]);
    }
    return h('div', { class: 'psec' }, h('h3', {}, 'Sun', h('span', { class: 'act' }, h('button', { class: 'btn sm', title: 'Pick with preview', onclick: async () => {
        const v = await searchPicker(app, { title: 'Star', current: cur, items: [...g.stars.values()].map(s => ({ value: s.nickname, sub: `radius ${s.radius}` })), preview: (it) => h('div', {}, starPreview(g, it.value, 260)) });
        if (v) this.edit('Change star', () => sec.set('star', v));
      } }, '…'))), h('div', { class: 'kv' }, h('div', { class: 'k' }, 'star'), h('div', { class: 'v' }, sel), h('span')),
      st ? h('div', { style: { margin: '6px 0' } }, starPreview(g, cur, 200)) : null,
      st ? h('div', { class: 'stat', style: { marginTop: '6px' } }, rows.map(([k, v]) => k ? [k, h('b', { style: { fontSize: '11px' } }, v || '—')] : h('div', { class: 'sev-warn', style: { gridColumn: '1 / -1', fontSize: '11px' } }, v))) : null);
  }

  // planetary ring: ring = <zone>, <ring ini>
  ringSection(sec) {
    const app = this.app, sys = app.sys;
    const v = sec.vals('ring');
    const wrap = h('div', { class: 'psec' }, h('h3', {}, 'Ring'));
    if (!v) {
      wrap.append(h('div', { style: { color: 'var(--faint)', fontSize: '12px' } }, 'No ring.'), h('div', { class: 'btnrow', style: { marginTop: '6px' } }, h('button', { class: 'btn sm', onclick: async () => {
        const files = (await api.ls(dataPath('solar\\rings'))).filter(f => !f.dir && /\.ini$/i.test(f.name) && !/^shapes/i.test(f.name)).map(f => 'solar\\rings\\' + f.name);
        const r = (this.app.viewport.visuals.get(sec.id) || {}).userData?.radius || 4000;
        const p = getPos(sec), rot = getRot(sec);
        this.edit('Add ring', () => {
          const z = sys.addZone('RING', p, [r * 3, r * 1.5, 300], { nickname: `Zone_${sec.get('nickname')}_ring`, rotate: [rot[0] + 10, rot[1], rot[2]], sort: 99.5 });
          sec.set('ring', `${z.get('nickname')}, ${files[0] || 'solar\\rings\\aso.ini'}`);
        });
      } }, '+ Add ring')));
      return wrap;
    }
    const z = sys.byNick(v[0]);
    const fileIn = h('input', { value: v[1] || '', onchange: (e) => this.edit('Ring file', () => sec.set('ring', `${v[0]}, ${e.target.value.trim()}`)) });
    api.ls(dataPath('solar\\rings')).then(l => { const dl = datalist(l.filter(f => !f.dir && /\.ini$/i.test(f.name) && !/^shapes/i.test(f.name)).map(f => 'solar\\rings\\' + f.name)); fileIn.setAttribute('list', dl.id); wrap.append(dl.el); });
    wrap.append(h('div', { class: 'kv' },
      h('div', { class: 'k' }, 'zone'), h('div', { class: 'v' }, h('button', { class: 'btn sm', disabled: !z, onclick: () => z && app.select(z.id) }, z ? v[0] : `${v[0]} (missing!)`)), h('span'),
      h('div', { class: 'k' }, 'file'), h('div', { class: 'v' }, fileIn), h('span')),
      z ? h('div', { style: { fontSize: '11px', color: 'var(--faint)', marginTop: '4px' } }, `${(z.get('shape') || '').toUpperCase()} · size ${z.get('size') || ''} (outer, inner, thickness) · tilt from the zone's rotate`) : null,
      h('div', { class: 'btnrow', style: { marginTop: '6px' } },
        h('button', { class: 'btn sm', onclick: () => import('./dialogs.js').then(async d => { const doc = await app.otherDoc(dataPath(v[1])); if (doc) d.rawIni(app, doc); }) }, 'Edit ring file…'),
        h('button', { class: 'btn sm', onclick: () => this.edit('Remove ring', () => sec.remove('ring')) }, 'Remove ring')));
    return wrap;
  }

  gotoEditor(sec) {
    const app = this.app, game = app.game;
    const g = sec.vals('goto') || ['', '', ''];
    const sysSel = h('select', {}, h('option', { value: '' }, '— target system —'), game.systems.map(s => h('option', { value: s.nickname, selected: s.nickname.toLowerCase() === (g[0] || '').toLowerCase() }, `${s.nickname}  ${game.name(s.strid) || ''}`)));
    const objSel = h('select', {}, h('option', { value: g[1] || '' }, g[1] || '— target object —'));
    const tun = h('input', { value: g[2] || '', list: '' });
    const dl = datalist(game.gateTunnels); tun.setAttribute('list', dl.id);
    const fill = async () => {
      objSel.innerHTML = '';
      if (!sysSel.value) return;
      const d = await app.loadSystemDoc(sysSel.value);
      const objs = d.objects.filter(o => { const a = game.arch(o.get('archetype')); return o.has('goto') || (a && /JUMP/.test(a.type)); });
      objSel.append(h('option', { value: '' }, '— target object —'), ...objs.map(o => h('option', { value: o.get('nickname'), selected: (o.get('nickname') || '').toLowerCase() === (g[1] || '').toLowerCase() }, o.get('nickname'))));
      if (g[1] && !objs.some(o => (o.get('nickname') || '').toLowerCase() === g[1].toLowerCase())) objSel.append(h('option', { value: g[1], selected: true }, g[1] + ' (missing!)'));
    };
    fill();
    sysSel.onchange = fill;
    const apply = () => this.edit('Set goto', () => sec.set('goto', [sysSel.value, objSel.value, tun.value || (game.gateTunnels[0] || 'gate_tunnel_bretonia')].join(', ')));
    const pair = async () => {
      if (!sysSel.value || !objSel.value) return;
      const d = await app.loadSystemDoc(sysSel.value);
      const t = d.byNick(objSel.value); if (!t) return toast('Target object not found');
      app.history.do('Link jump back', [d], () => t.set('goto', [app.sys.nickname, sec.get('nickname'), tun.value || 'gate_tunnel_bretonia'].join(', ')));
      toast(`${d.nickname}/${objSel.value} now jumps back here`);
    };
    return h('div', { class: 'psec' }, h('h3', {}, 'Jump destination'),
      h('div', { class: 'kv' },
        h('div', { class: 'k' }, 'system'), h('div', { class: 'v' }, sysSel), h('span'),
        h('div', { class: 'k' }, 'object'), h('div', { class: 'v' }, objSel), h('span'),
        h('div', { class: 'k' }, 'tunnel'), h('div', { class: 'v' }, tun, dl.el), h('span')),
      h('div', { class: 'btnrow', style: { marginTop: '8px' } },
        h('button', { class: 'btn primary sm', onclick: apply }, 'Apply'),
        h('button', { class: 'btn sm', title: 'Make the target object jump back to this one', onclick: pair }, 'Link back'),
        h('button', { class: 'btn sm', onclick: async () => { if (!sysSel.value) return; await app.openSystem(sysSel.value); const t = app.sys.byNick(objSel.value); if (t) { app.select(t.id); app.viewport.focus(t.id); } } }, 'Go to target')));
  }

  laneSection(sec) {
    const app = this.app;
    const chain = laneChain(app.sys, sec);
    const idx = chain.indexOf(sec);
    let len = 0; for (let i = 1; i < chain.length; i++) { const a = getPos(chain[i - 1]), b = getPos(chain[i]); len += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }
    return h('div', { class: 'psec' }, h('h3', {}, 'Trade lane'),
      h('div', { class: 'stat' }, 'Ring', h('b', {}, `${idx + 1} of ${chain.length}`), 'Lane length', h('b', {}, `${(len / 1000).toFixed(1)} k`),
        'Start name', h('b', {}, app.game.name(chain[0].get('tradelane_space_name')) || '—'), 'End name', h('b', {}, app.game.name(chain[chain.length - 1].get('tradelane_space_name')) || '—')),
      h('div', { class: 'btnrow', style: { marginTop: '8px' } },
        h('button', { class: 'btn sm', onclick: () => app.selectMany(chain.map(s => s.id)) }, 'Select lane'),
        h('button', { class: 'btn sm', title: 'Re-space rings evenly and aim them along the lane', onclick: () => this.edit('Straighten lane', () => straightenLane(chain)) }, 'Straighten & align'),
        h('button', { class: 'btn sm', title: 'Point every ring at its neighbour', onclick: () => this.edit('Align lane', () => straightenLane(chain, false)) }, 'Align only')));
  }

  baseSection(sec, t) {
    const app = this.app, game = app.game;
    const bn = sec.get('base');
    const base = game.findBase(bn);
    const kids = [h('h3', {}, 'Base / docking')];
    if (base) kids.push(h('div', { class: 'stat' }, 'Base', h('b', {}, base.nickname), 'Name', h('b', {}, game.name(base.strid) || '—'), 'File', h('b', { style: { fontSize: '11px' } }, base.file || '—'), 'System', h('b', {}, base.system || '—')));
    else if (bn) kids.push(h('div', { class: 'sev-err' }, `base "${bn}" is not defined in universe.ini`));
    else kids.push(h('div', { class: 'sub', style: { color: 'var(--faint)' } }, 'Not a base.'));
    kids.push(h('div', { class: 'btnrow', style: { marginTop: '8px' } },
      !base ? h('button', { class: 'btn sm primary', onclick: () => dialogs.createBase(app, sec) }, 'Create base…') : null,
      base ? h('button', { class: 'btn sm', onclick: () => dialogs.editUniverseSection(app, base.section, 'Base ' + base.nickname) }, 'Edit universe entry…') : null,
      base ? h('button', { class: 'btn sm', onclick: () => import('./trade.js').then(t => t.tradePlanner(app, { tab: 'markets', base: base.nickname })) }, 'Market…') : null,
      base ? h('button', { class: 'btn sm', onclick: () => import('./mbases.js').then(t => t.basesEditor(app, { base: base.nickname })) }, 'Characters & news…') : null,
      base ? h('button', { class: 'btn sm', onclick: () => import('./rooms.js').then(t => t.baseInteriors(app, { base: base.nickname })) }, 'Interiors…') : null));
    return h('div', { class: 'psec' }, kids);
  }

  zoneSections(sec) {
    const app = this.app;
    const shape = (sec.get('shape') || 'SPHERE').toUpperCase();
    const size = (sec.vals('size') || ['1000']).map(parseFloat);
    const labels = { SPHERE: ['radius'], ELLIPSOID: ['radius x', 'radius y', 'radius z'], BOX: ['size x', 'size y', 'size z'], CYLINDER: ['radius', 'height'], RING: ['outer r', 'inner r', 'height'] }[shape] || ['size'];
    const shapeSel = h('select', { onchange: () => this.edit('Zone shape', () => { const ns = shapeSel.value; const s0 = size[0] || 1000; const def = { SPHERE: [s0], ELLIPSOID: [s0, s0, s0], BOX: [s0, s0, s0], CYLINDER: [s0, s0 * 4], RING: [s0, s0 * 0.6, s0 * 0.1] }[ns]; sec.set('shape', ns); sec.set('size', def.map(x => fmtNum(x, 0)).join(', ')); }) },
      ['SPHERE', 'ELLIPSOID', 'BOX', 'CYLINDER', 'RING'].map(s => h('option', { value: s, selected: s === shape }, s)));
    const ins = labels.map((l, i) => h('input', { type: 'number', value: fmtNum(size[i] ?? size[0], 0), step: 100, onchange: () => this.edit('Zone size', () => sec.set('size', ins.map(x => fmtNum(parseFloat(x.value) || 0, 0)).join(', '))) }));
    const zi = app.zoneInfo.get((sec.get('nickname') || '').toLowerCase());
    this.el.append(h('div', { class: 'psec' }, h('h3', {}, 'Shape'),
      h('div', { class: 'kv' }, h('div', { class: 'k' }, 'shape'), h('div', { class: 'v' }, shapeSel), h('span'),
        labels.map((l, i) => [h('div', { class: 'k' }, l), h('div', { class: 'v' }, ins[i]), h('span')])),
      h('div', { class: 'btnrow', style: { marginTop: '8px' } },
        h('button', { class: 'btn sm', onclick: () => this.edit('Scale zone', () => sec.set('size', size.map(x => fmtNum(x * 1.25, 0)).join(', '))) }, '+25%'),
        h('button', { class: 'btn sm', onclick: () => this.edit('Scale zone', () => sec.set('size', size.map(x => fmtNum(x * 0.8, 0)).join(', '))) }, '−20%'))));
    this.el.append(h('div', { class: 'psec' }, h('h3', {}, 'Field'),
      zi ? h('div', { class: 'stat' }, 'Type', h('b', {}, zi.kind), 'File', h('b', { style: { fontSize: '11px' } }, zi.file || '—')) : h('div', { style: { color: 'var(--faint)' } }, 'No asteroid field or nebula uses this zone.'),
      h('div', { class: 'btnrow', style: { marginTop: '8px' } },
        zi ? h('button', { class: 'btn sm', onclick: () => this.edit('Unlink field', () => app.sys.ini.removeSection(zi.section)) }, 'Unlink field') : h('button', { class: 'btn sm', onclick: () => dialogs.fieldLink(app, sec) }, 'Make asteroid field / nebula…'))));
    if (sec.has('path_label') && pathLabel(sec)) this.el.append(pathSection(app, sec));
    this.el.append(populationSection(app, sec));
    if (zi && zi.file) this.el.append(fieldEditor(app, sec, zi));
    // property flags and visit flags
    this.el.append(this.flagsSection(sec, 'property_flags', ZONE_FLAGS));
    this.el.append(this.flagsSection(sec, 'visit', VISIT_FLAGS));
  }

  flagsSection(sec, key, groups) {
    const v = parseInt(sec.get(key) || '0') || 0;
    const known = groups.reduce((m, [, l]) => l.reduce((a, [b]) => a | b, m), 0);
    const unknown = v & ~known;
    const set = (bit, on) => this.edit(key, () => { const cur = parseInt(sec.get(key) || '0') || 0; const nv = on ? (cur | bit) : (cur & ~bit); if (nv) sec.set(key, nv); else sec.remove(key); });
    const box = (bit, label) => h('label', { title: `${label} = ${bit} (0x${bit.toString(16)})`, style: { display: 'flex', gap: '6px', alignItems: 'center', color: v & bit ? 'var(--text)' : 'var(--dim)', whiteSpace: 'nowrap' } },
      h('input', { type: 'checkbox', checked: !!(v & bit), onchange: (e) => set(bit, e.target.checked) }), label);
    return h('div', { class: 'psec' },
      h('h3', {}, key, h('span', { class: 'act', style: { fontFamily: 'var(--mono)', color: 'var(--faint)' } }, `= ${v}`)),
      groups.map(([g, list]) => h('div', { style: { marginBottom: '6px' } },
        groups.length > 1 ? h('div', { style: { fontSize: '11px', color: 'var(--faint)', margin: '2px 0' } }, g) : null,
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '2px 8px', fontSize: '12px' } }, list.map(([b, l]) => box(b, l))))),
      unknown ? h('div', { class: 'sev-warn', style: { fontSize: '12px' } }, `Unknown bits set: ${unknown} — kept as-is`) : null);
  }

  lightSections(sec) {
    const c = (sec.vals('color') || ['255', '255', '255']).map(x => Math.max(0, Math.min(255, parseInt(x) || 0)));
    const picker = h('input', { type: 'color', value: '#' + c.map(x => x.toString(16).padStart(2, '0')).join(''), onchange: () => { const v = picker.value; this.edit('Light color', () => sec.set('color', [1, 3, 5].map(i => parseInt(v.substr(i, 2), 16)).join(', '))); } });
    const range = h('input', { type: 'number', value: sec.get('range') || '0', step: 1000, onchange: () => this.edit('Light range', () => sec.set('range', range.value)) });
    const type = h('select', { onchange: () => this.edit('Light type', () => sec.set('type', type.value)) }, ['POINT', 'DIRECTIONAL'].map(t => h('option', { selected: (sec.get('type') || 'POINT').toUpperCase() === t }, t)));
    this.el.append(h('div', { class: 'psec' }, h('h3', {}, 'Light'), h('div', { class: 'kv' },
      h('div', { class: 'k' }, 'color'), h('div', { class: 'v' }, picker, h('span', { class: 'hint' }, c.join(', '))), h('span'),
      h('div', { class: 'k' }, 'range'), h('div', { class: 'v' }, range), h('span'),
      h('div', { class: 'k' }, 'type'), h('div', { class: 'v' }, type), h('span'))));
    this.el.append(falloffSection(this.app, sec, (l, fn) => this.edit(l, fn)));
  }

  // generic table of every entry, with typed suggestions & hints
  entriesTable(sec, known) {
    const app = this.app;
    const wrap = h('div', { class: 'psec' });
    const grid = h('div', { class: 'kv' });
    for (const e of sec.entries) {
      const kl = e.key.toLowerCase();
      const keyIn = h('input', { value: e.key, onchange: () => this.edit('Rename key', () => { e.key = keyIn.value.trim(); e.raw = null; }) });
      const valIn = h('input', { value: e.value, onchange: () => this.edit(`Set ${e.key}`, () => { e.value = valIn.value.trim(); e.raw = null; }) });
      const sugg = this.suggestions(kl, sec);
      let dl = null; if (sugg && sugg.length) { dl = datalist(sugg); valIn.setAttribute('list', dl.id); }
      const hint = this.hint(kl, e.value);
      const idb = ID_KEYS.has(kl) ? this.idButtons(kl, () => e.value, (gid) => this.edit(`Set ${e.key}`, () => { e.value = String(gid); e.raw = null; }), sec) : null;
      const pkb = this.pickButton(kl, sec, () => e.value, (v) => this.edit(`Set ${e.key}`, () => { e.value = v; e.raw = null; }), sugg);
      // keys the game never reads get no marking at all (user's choice); documented keys keep their tooltip
      const unread = keyIsRead(sec.name, e.key) === false;
      grid.append(h('div', { class: 'k', title: unread ? '' : keyTip(sec.name, e.key) }, keyIn), h('div', { class: 'v' }, valIn, dl && dl.el, pkb, idb, hint ? h('span', { class: 'hint', title: hint }, hint) : null),
        h('button', { class: 'x', title: 'Remove entry', onclick: () => this.edit(`Remove ${e.key}`, () => sec.removeEntry(e)) }, '×'));
      if (kl === 'visit' || kl === 'property_flags') grid.append(h('div', { class: 'note' }, flagsText(parseInt(e.value) || 0, kl === 'visit' ? VISIT_FLAGS : ZONE_FLAGS)));
    }
    const present = new Set(sec.entries.map(e => e.key.toLowerCase()));
    const docKeys = documentedKeys(sec.name).filter(k => !known.some(x => x.toLowerCase() === k.toLowerCase()) && !/[ .]/.test(k));
    const addSel = h('select', {}, h('option', { value: '' }, '+ add entry…'), known.filter(k => !present.has(k.toLowerCase()) || ['encounter', 'faction', 'music'].includes(k.toLowerCase())).map(k => h('option', { value: k, title: keyTip(sec.name, k) }, k)),
      docKeys.length ? h('optgroup', { label: 'Other keys the game reads' }, docKeys.filter(k => !present.has(k.toLowerCase())).sort().map(k => h('option', { value: k, title: keyTip(sec.name, k) }, k))) : null,
      h('option', { value: '__custom' }, 'custom key…'));
    addSel.onchange = async () => {
      let key = addSel.value; if (!key) return;
      if (key === '__custom') { key = ((await promptDialog('Add entry', 'Key name')) || '').trim(); if (!key) { addSel.value = ''; return; } }
      this.edit(`Add ${key}`, () => { sec.lines.splice(sec.lastEntryIndex() + 1, 0, new IniEntry(key, defaultValue(key))); });
    };
    wrap.append(h('h3', {}, `[${sec.name}] entries`, h('span', { class: 'act' }, h('button', { class: 'btn sm', onclick: () => dialogs.rawSection(app, sec) }, 'Raw…'))), grid, h('div', { style: { marginTop: '8px' } }, addSel));
    return wrap;
  }

  suggestions(k, sec) {
    const g = this.app.game, sys = this.app.sys;
    const nicks = () => sys.objects.map(o => o.get('nickname')).filter(Boolean);
    switch (k) {
      case 'archetype': return [...g.archetypes.values()].map(a => a.nickname);
      case 'star': return [...g.stars.values()].map(s => s.nickname);
      case 'loadout': return g.loadouts;
      case 'base': case 'dock_with': return g.bases.map(b => ({ value: b.nickname, label: g.name(b.strid) || b.system }));
      case 'reputation': return g.factions.map(f => ({ value: f.nickname, label: g.name(f.ids) || '' }));
      case 'behavior': return ['NOTHING'];
      case 'prev_ring': case 'next_ring': case 'parent': return nicks();
      case 'jump_effect': return g.jumpEffects;
      case 'spacedust': return g.spacedust;
      case 'music': return g.music;
      case 'shape': return ['SPHERE', 'ELLIPSOID', 'BOX', 'CYLINDER', 'RING'];
      case 'type': return ['POINT', 'DIRECTIONAL'];
      case 'faction': return g.factions.map(f => f.nickname + ', 1');
      default: return this.observed(k);
    }
  }
  observed(k) {
    // values seen for this key across loaded systems (pilot, voice, pop_type, usage, encounter…)
    const vals = new Set();
    for (const d of this.app.systemDocs.values()) for (const s of d.entities) for (const e of s.findAll(k)) vals.add(e.value);
    return [...vals].slice(0, 500).sort();
  }
  hint(k, v) {
    const g = this.app.game;
    if (ID_KEYS.has(k)) return g.name(v) || (g.infocard(v) ? '(infocard)' : (parseInt(v) ? '(unknown id)' : ''));
    if (k === 'archetype') { const a = g.arch(v); return a ? a.type.toLowerCase() : 'unknown!'; }
    if (k === 'base' || k === 'dock_with') { const b = g.findBase(v.split(',')[0].trim()); return b ? g.name(b.strid) || 'ok' : 'not in universe!'; }
    if (k === 'reputation') { const f = g.factions.find(f => f.nickname.toLowerCase() === v.toLowerCase()); return f ? g.name(f.ids) || '' : ''; }
    if (k === 'goto') { const s = g.findSystem(v.split(',')[0].trim()); return s ? g.name(s.strid) || s.nickname : 'unknown system!'; }
    if (k === 'prev_ring' || k === 'next_ring' || k === 'parent') return this.app.sys.byNick(v) ? '' : 'missing!';
    return '';
  }

  renderMulti(sel) { this.el.append(bulkPanel(this, sel)); }

  // ---------------- system (no selection) ----------------
  // a system picked on the universe map: its file is loaded (not opened in the 3D view) and shown like the open one
  renderUniverseSystem(s) {
    const app = this.app, game = app.game;
    if (s.labelOnly) {
      this.el.append(h('div', { class: 'phead' }, h('div', { class: 'kind' }, 'system'), h('h2', {}, game.name(s.strid) || s.nickname), h('div', { class: 'sub' }, `${s.nickname} · name on the universe map only (no system file)`)));
      const w = h('div', { class: 'psec' }, h('h3', {}, 'universe.ini [System]')); w.append(this.miniTable(s.section, ['strid_name', 'ids_info', 'pos', 'NavMapScale', 'visit', 'msg_id_prefix', 'file'], app.universeDoc)); this.el.append(w);
      return;
    }
    const doc = app.systemDocs && app.systemDocs.get(s.nickname.toLowerCase());
    if (doc) return this.renderSystem(doc);
    this.el.append(h('div', { class: 'phead' }, h('div', { class: 'kind' }, 'system'), h('h2', {}, game.name(s.strid) || s.nickname), h('div', { class: 'sub' }, 'Loading…')));
    app.loadSystemDoc(s.nickname).then(() => { if (app.currentView === 'universe' && app.universeMap.selected === s) this.render(); })
      .catch(e => { this.el.append(h('div', { class: 'psec sev-err' }, `Could not load ${s.nickname}: ${e.message}`)); });
  }
  renderSystem(docArg = null) {
    const app = this.app, game = app.game, doc = docArg || app.sys, open = doc === app.sys;
    const uni = doc.sys.section;
    this.el.append(h('div', { class: 'phead' }, h('div', { class: 'kind' }, open ? 'system' : 'system · selected on the universe map'), h('h2', {}, game.name(doc.sys.strid) || doc.nickname), h('div', { class: 'sub' }, `${doc.nickname} · ${doc.path}`),
      open ? null : h('div', { style: { marginTop: '6px' } }, h('button', { class: 'btn sm primary', title: 'Open this system in the 3D view (or double-click it on the map)', onclick: () => app.openSystem(doc.nickname) }, 'Open system'))));
    const st = { objects: doc.objects.length, zones: doc.zones.length, lights: doc.lights.length };
    const bases = game.bases.filter(b => (b.system || '').toLowerCase() === doc.nickname.toLowerCase());
    this.el.append(h('div', { class: 'psec' }, h('div', { class: 'stat' }, 'Objects', h('b', {}, st.objects), 'Zones', h('b', {}, st.zones), 'Light sources', h('b', {}, st.lights), 'Bases', h('b', {}, bases.length))));

    const uniWrap = h('div', { class: 'psec' }, h('h3', {}, 'universe.ini [System]'));
    uniWrap.append(this.miniTable(uni, ['strid_name', 'ids_info', 'pos', 'NavMapScale', 'visit', 'msg_id_prefix', 'file'], app.universeDoc));
    this.el.append(uniWrap);

    const sections = [
      ['SystemInfo', ['space_color', 'local_faction', 'space_farclip'], { local_faction: game.factions.map(f => f.nickname) }],
      ['Music', ['space', 'danger', 'battle'], { space: game.music, danger: game.music, battle: game.music }],
      ['Ambient', ['color'], {}],
      ['Dust', ['spacedust'], { spacedust: game.spacedust }],
      ['Background', ['basic_stars', 'complex_stars', 'nebulae'], {}],
      ['TexturePanels', ['file'], {}],
    ];
    for (const [name, keys, sugg] of sections) {
      const s = doc.ini.first(name);
      const wrap = h('div', { class: 'psec' }, h('h3', {}, `[${name}]`, !s ? h('span', { class: 'act' }, h('button', { class: 'btn sm', onclick: () => app.edit(`Add [${name}]`, () => doc.ini.addSection(name, doc.ini.first('SystemInfo'), keys.map(k => [k, '']))) }, 'Add')) : null));
      if (s) wrap.append(this.miniTable(s, keys, doc, sugg, !open ? null : name === 'Background' ? () => app.viewport.setBackground(doc) : name === 'Ambient' || name === 'SystemInfo' ? () => { app.viewport.setLighting(doc); app.viewport.setBackground(doc); } : null));
      if (name === 'Ambient' && s) {
        const c = (s.vals('color') || ['0', '0', '0']).map(x => Math.max(0, Math.min(255, parseInt(x) || 0)));
        const pk = h('input', { type: 'color', value: '#' + c.map(x => x.toString(16).padStart(2, '0')).join(''), onchange: () => { app.edit('Ambient color', () => s.set('color', [1, 3, 5].map(i => parseInt(pk.value.substr(i, 2), 16)).join(', '))); app.viewport.setLighting(doc); } });
        wrap.append(h('div', { style: { marginTop: '6px' } }, pk));
      }
      this.el.append(wrap);
    }
    if (bases.length) this.el.append(h('div', { class: 'psec' }, h('h3', {}, 'Bases in this system'), h('div', { class: 'reflist' }, bases.map(b => {
      const obj = doc.objects.find(o => (o.get('base') || '').toLowerCase() === b.nickname.toLowerCase());
      const go = () => { if (!obj) return; if (open) { app.select(obj.id); app.viewport.focus(obj.id); return; } app.openSystem(doc.nickname).then(() => { const o = app.sys && app.sys.objects.find(x => (x.get('base') || '').toLowerCase() === b.nickname.toLowerCase()); if (o) { app.select(o.id); app.viewport.focus(o.id); } }); };
      return h('div', { onclick: go, title: b.file + (open ? '' : ' — click to open the system at this base') }, `${b.nickname}  ${game.name(b.strid) || ''}${obj ? '' : '  (no object!)'}`);
    }))));
    this.el.append(h('div', { class: 'psec' }, h('div', { class: 'btnrow' },
      h('button', { class: 'btn', onclick: () => dialogs.validation(app, validateSystem(app, doc)) }, 'Validate'),
      open ? h('button', { class: 'btn', onclick: () => app.rebuildPreload() }, 'Rebuild preload list') : null,
      h('button', { class: 'btn', onclick: () => dialogs.rawIni(app, doc) }, 'Raw INI…'))));
  }
  miniTable(sec, keys, doc, sugg = {}, after = null) {
    const grid = h('div', { class: 'kv' });
    const all = [...new Set([...keys.filter(k => sec.has(k) || true), ...sec.entries.map(e => e.key)])];
    const seen = new Set();
    for (const key of all) {
      if (seen.has(key.toLowerCase())) continue; seen.add(key.toLowerCase());
      const e = sec.find(key);
      const inp = h('input', { value: e ? e.value : '', placeholder: '—', onchange: () => { this.app.history.do(`Set ${key}`, [doc], () => inp.value.trim() ? sec.set(e ? e.key : key, inp.value.trim()) : sec.remove(key)); after && after(); } });
      let dl = null; const s = sugg[key]; if (s && s.length) { dl = datalist(s); inp.setAttribute('list', dl.id); }
      const isId = ID_KEYS.has(key.toLowerCase());
      const hint = isId ? (this.app.game.name(e && e.value) || (e && this.app.game.infocard(e.value) ? '(infocard)' : '')) : '';
      const idb = isId ? this.idButtons(key.toLowerCase(), () => (sec.find(key) || {}).value, (gid) => { this.app.history.do(`Set ${key}`, [doc], () => sec.set(e ? e.key : key, String(gid))); after && after(); }, sec) : null;
      const pkb = this.pickButton(key.toLowerCase(), sec, () => (sec.find(key) || {}).value, (v) => { this.app.history.do(`Set ${key}`, [doc], () => sec.set(e ? e.key : key, v)); after && after(); }, s);
      grid.append(h('div', { class: 'k', title: keyTip(sec.name, key) }, key), h('div', { class: 'v' }, inp, dl && dl.el, pkb, idb, hint ? h('span', { class: 'hint', title: hint }, hint) : null), h('span'));
    }
    return grid;
  }

  // … opens a search picker for reference fields (loadout, faction, base, music, star, pilot, voice, parent…)
  pickButton(k, sec, getValue, setValue, observed) {
    if (!PICKER_KEYS.has(k)) return null;
    return h('button', { class: 'btn sm', title: 'Search…', style: { padding: '1px 6px', flex: '0 0 auto' }, onclick: async () => {
      const cur = getValue() || '';
      const first = cur.split(',')[0].trim();
      const spec = await pickerFor(this.app, k, sec, observed);
      const v = await searchPicker(this.app, { ...spec, current: first });
      if (v == null) return;
      // keep trailing values (e.g. zone "faction = li_n_grp, 1")
      const rest = cur.includes(',') ? cur.slice(cur.indexOf(',')) : '';
      setValue(v + rest);
    } }, '…');
  }

  // ✎ edit the text behind an id · + create new text and point the entry at it · ⌕ pick an existing id
  idButtons(key, getValue, setValue, sec) {
    const app = this.app, kind = ID_KIND(key);
    const b = (label, title, fn) => h('button', { class: 'btn sm', title, style: { padding: '1px 6px', flex: '0 0 auto' }, onclick: fn }, label);
    return h('span', { style: { display: 'flex', gap: '3px', flex: '0 0 auto' } },
      b('✎', `Edit the ${kind} text`, async () => {
        const v = parseInt(getValue() || '0');
        if (!v) { const gid = await textEditor(app, { kind, initial: suggestText(app, key, sec) }); if (gid) setValue(gid); return; }
        await textEditor(app, { id: v, kind });
      }),
      b('+', `New ${kind} (allocates a free id in an editable DLL)`, async () => { const gid = await textEditor(app, { kind, initial: suggestText(app, key, sec) }); if (gid) setValue(gid); }),
      b('⌕', `Pick an existing ${kind}`, () => stringBrowser(app, { kind, pick: (gid) => setValue(gid) })));
  }
}

function defaultValue(key) {
  const k = key.toLowerCase();
  return { behavior: 'NOTHING', difficulty_level: '1', visit: '0', rotate: '0, 0, 0', shape: 'SPHERE', size: '1000', sort: '99', density: '0', toughness: '1', repop_time: '30', max_battle_size: '4', relief_time: '20', faction: 'li_p_grp, 1', range: '20000', color: '255, 255, 255', type: 'POINT', attenuation: '1, 0, 0.000000005' }[k] ?? '';
}

export function laneChain(sys, sec) {
  let first = sec, guard = 0;
  while (first.get('prev_ring') && guard++ < 500) { const p = sys.byNick(first.get('prev_ring')); if (!p || p === sec && guard > 1) break; first = p; }
  const chain = [first]; guard = 0;
  let cur = first;
  while (cur.get('next_ring') && guard++ < 500) { const n = sys.byNick(cur.get('next_ring')); if (!n || chain.includes(n)) break; chain.push(n); cur = n; }
  return chain;
}
export function laneRotation(from, to) {
  // FL rings face along their -Z axis toward the next ring; Euler ZYX, degrees
  const d = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  const L = Math.hypot(...d) || 1; const f = d.map(x => -x / L);
  const x = -Math.asin(Math.max(-1, Math.min(1, f[1]))) * 180 / Math.PI;
  const y = Math.atan2(f[0], f[2]) * 180 / Math.PI;
  return [x, y, 0];
}
export function straightenLane(chain, respace = true) {
  if (chain.length < 2) return;
  const a = getPos(chain[0]), b = getPos(chain[chain.length - 1]);
  chain.forEach((s, i) => {
    if (respace) { const t = i / (chain.length - 1); setPos(s, a.map((v, j) => v + (b[j] - v) * t)); }
  });
  chain.forEach((s, i) => {
    const p = getPos(s), q = getPos(chain[Math.min(i + 1, chain.length - 1)]), o = getPos(chain[Math.max(i - 1, 0)]);
    const r = i < chain.length - 1 ? laneRotation(p, q) : laneRotation(o, p);
    setRot(s, r);
  });
}
