// Asteroid field / nebula file editor, shown in the properties panel for a zone with a field.
// Section/key layout of field files (asteroid field, field, band,
// AsteroidCube.cs, AsteroidBillboards.cs, DynamicAsteroids.cs, AsteroidExclusion.cs, Nebula*.cs).
import { h, datalist, toast } from './dom.js';
import { IniEntry, fmtNum } from '../formats/ini.js';
import { exclusionGroups } from '../fields.js';
import { dataPath } from '../api.js';

const AST = [
  ['Field', 'Field', [['cube_size', 'num', 'Cube edge length (m)'], ['fill_dist', 'num', 'Asteroids drawn within this distance'], ['empty_cube_frequency', 'num', '0 = every cube filled, 1 = none'], ['tint_field', 'color', 'Overrides diffuse + ambient'], ['diffuse_color', 'color'], ['ambient_color', 'color'], ['ambient_increase', 'color'], ['max_alpha', 'num'], ['contains_fog_zone', 'text']]],
  ['Band', 'Band (distant ring)', [['shape', 'shape'], ['render_parts', 'num'], ['height', 'num'], ['offset_dist', 'num', 'Shrinks the band radius'], ['fade', 'nums4'], ['texture_aspect', 'num'], ['color_shift', 'vec3'], ['ambient_intensity', 'num'], ['vert_increase', 'num'], ['cull_mode', 'num']]],
  ['AsteroidBillboards', 'Billboards (distant sprites)', [['count', 'num'], ['start_dist', 'num'], ['fade_dist_percent', 'num'], ['shape', 'shape'], ['color_shift', 'vec3'], ['ambient_intensity', 'num'], ['size', 'nums2', 'min, max']]],
];
const NEB = [
  ['Fog', 'Fog (inside)', [['fog_enabled', 'num', '1 = on'], ['near', 'num'], ['distance', 'num'], ['color', 'color']]],
  ['Exterior', 'Exterior (seen from outside)', [['fill_shape', 'shape'], ['plane_slices', 'num'], ['bit_radius', 'num', 'Puff radius'], ['bit_radius_random_variation', 'num', '0–1'], ['min_bits', 'num'], ['max_bits', 'num'], ['move_bit_percent', 'num'], ['equator_bias', 'num'], ['color', 'color'], ['opacity', 'num']]],
  ['NebulaLight', 'Light', [['ambient', 'color'], ['sun_burnthrough_intensity', 'num'], ['sun_burnthrough_scaler', 'num']]],
  ['Clouds', 'Interior clouds', [['max_distance', 'num'], ['puff_count', 'num'], ['puff_radius', 'num'], ['puff_colora', 'color'], ['puff_colorb', 'color'], ['puff_max_alpha', 'num'], ['puff_drift', 'num'], ['near_fade_distance', 'nums2'], ['lightning_intensity', 'num'], ['lightning_color', 'color'], ['lightning_gap', 'num'], ['lightning_duration', 'num']]],
  ['BackgroundLightning', 'Background lightning', [['duration', 'num'], ['gap', 'num'], ['color', 'color']]],
  ['DynamicLightning', 'Dynamic lightning', [['gap', 'num'], ['duration', 'num'], ['color', 'color'], ['ambient_intensity', 'num'], ['intensity_increase', 'num']]],
];
const DEFAULTS = {
  Field: [['cube_size', '400'], ['fill_dist', '3000'], ['empty_cube_frequency', '0.5'], ['diffuse_color', '255, 255, 255'], ['ambient_color', '120, 120, 120']],
  Band: [['render_parts', '6'], ['shape', ''], ['height', '5000'], ['offset_dist', '3000'], ['fade', '1, 1.35, 15, 17'], ['texture_aspect', '1'], ['color_shift', '1, 1, 1']],
  AsteroidBillboards: [['count', '400'], ['start_dist', '2000'], ['fade_dist_percent', '0.35'], ['shape', ''], ['color_shift', '1, 1, 1'], ['size', '60, 120']],
  Cube: [],
  Fog: [['fog_enabled', '1'], ['near', '0'], ['distance', '1000'], ['color', '40, 40, 60']],
  Exterior: [['fill_shape', ''], ['bit_radius', '10000'], ['bit_radius_random_variation', '0.2'], ['min_bits', '3'], ['max_bits', '8'], ['move_bit_percent', '0.5'], ['equator_bias', '0.5'], ['color', '60, 60, 90']],
  NebulaLight: [['ambient', '30, 30, 50']],
  Clouds: [['max_distance', '300'], ['puff_count', '10'], ['puff_radius', '100'], ['puff_colora', '60, 60, 120'], ['puff_colorb', '60, 30, 40'], ['puff_max_alpha', '0.5'], ['puff_drift', '1'], ['near_fade_distance', '125, 200']],
  BackgroundLightning: [['duration', '0.75'], ['gap', '3'], ['color', '40, 20, 60']],
  DynamicLightning: [['gap', '1'], ['duration', '0.4'], ['color', '180, 200, 220']],
};

const to255 = (v) => { const n = (v || '').split(',').map(x => parseFloat(x)); if (n.some(isNaN) || n.length < 3) return [255, 255, 255]; const big = n.some(x => x > 1.0001); return n.slice(0, 3).map(x => Math.round(big ? x : x * 255)); };
const hex = (c) => '#' + c.map(x => Math.max(0, Math.min(255, x)).toString(16).padStart(2, '0')).join('');

// re-renders happen after every edit: keep <details> open state and the panel height stable
const openState = new Map(); let lastHeight = 0;
export function fieldEditor(app, zoneSec, info) {
  const wrap = h('div', { class: 'psec' });
  if (lastHeight) wrap.style.minHeight = lastHeight + 'px';
  const docP = app.otherDoc(dataPath(info.file));
  wrap.append(h('h3', {}, `${info.kind === 'nebula' ? 'Nebula' : 'Asteroid field'} file`), h('div', { class: 'empty', style: { padding: '6px' } }, 'Loading…'));
  docP.then(async (doc) => {
    wrap.innerHTML = '';
    if (!doc) { wrap.append(h('h3', {}, 'Field file'), h('div', { class: 'sev-err' }, 'File not found: ' + info.file)); return; }
    const ini = doc.ini;
    const edit = (label, fn) => app.history.do(label, [doc], fn);
    const item = app.fields.items.find(i => i.doc === doc);
    const shapes = item && item.shapes ? [...item.shapes.keys()] : [];
    const shapeDl = datalist(shapes);
    wrap.append(h('h3', {}, `${info.kind === 'nebula' ? 'Nebula' : 'Asteroid field'} · ${info.file.split('\\').pop()}`,
      h('span', { class: 'act' }, app.history.dirty.has(doc) ? h('span', { style: { color: 'var(--warn)' } }, '● unsaved') : null)), shapeDl.el);
    const shared = sharedBy(app, info.file);
    if (shared.length > 1) wrap.append(h('div', { class: 'sev-warn', style: { fontSize: '12px', marginBottom: '6px' } }, `Shared by ${shared.length} zones: ${shared.join(', ')} — edits affect all. Use "Make asteroid field / nebula…" → copy to give this zone its own file.`));

    // texture panels
    const tp = ini.first('TexturePanels');
    wrap.append(kvRow('TexturePanels', h('input', { value: tp ? tp.getAll('file').join(', ') : '', onchange: (e) => edit('TexturePanels', () => { const s = tp || ini.addSection('TexturePanels', null, []); s.setAll('file', e.target.value.split(',').map(x => x.trim()).filter(Boolean)); }) })));

    const specs = info.kind === 'nebula' ? NEB : AST;
    for (const [name, title, keys] of specs) wrap.append(sectionForm(ini, name, title, keys, shapeDl.id, edit));
    if (info.kind !== 'nebula') {
      wrap.append(cubeEditor(app, ini, edit));
      wrap.append(dynamicEditor(app, ini, edit));
    } else {
      wrap.append(listEditor(ini, 'Exterior', 'shape', 'shape_weights', 'Exterior puff shapes', shapeDl.id, edit));
      wrap.append(listEditor(ini, 'Clouds', 'puff_shape', 'puff_weights', 'Interior puff shapes', shapeDl.id, edit));
    }
    wrap.append(exclusionEditor(app, ini, info.kind, edit));
    // everything else (LootableZone, ExclusionBand, mod sections…) as plain key/value forms
    const covered = new Set([...specs.map(x => x[0]), 'TexturePanels', 'Cube', 'DynamicAsteroids', 'Exclusion Zones', 'properties'].map(x => x.toLowerCase()));
    for (const sec of ini.sections) if (!covered.has(sec.name.toLowerCase())) wrap.append(otherSection(ini, sec, edit));
    const props = ini.first('properties');
    wrap.append(kvRow('properties flags', h('input', { value: props ? props.getAll('flag').join(', ') : '', placeholder: 'e.g. rock_objects, object_density_med', onchange: (e) => edit('Field flags', () => { const s = props || ini.addSection('properties', null, []); s.setAll('flag', e.target.value.split(',').map(x => x.trim()).filter(Boolean)); }) })));
    wrap.append(h('div', { class: 'btnrow', style: { marginTop: '8px' } },
      h('button', { class: 'btn sm', onclick: () => import('./dialogs.js').then(d => d.rawIni(app, doc)) }, 'Raw file…'),
      h('button', { class: 'btn sm', onclick: () => { const z = item && item.z; if (z) { app.viewport.animateTo(z.pos.clone(), 1500); } } }, 'Fly inside')));
    for (const d of wrap.querySelectorAll('details')) {
      const k = info.file.toLowerCase() + '|' + d.firstChild.textContent.replace(/\s*\(.*$/, '');
      if (openState.has(k)) d.open = openState.get(k);
      d.addEventListener('toggle', () => openState.set(k, d.open));
    }
    requestAnimationFrame(() => { wrap.style.minHeight = ''; lastHeight = wrap.offsetHeight; });
  });
  return wrap;
}

function sharedBy(app, file) {
  const out = [];
  for (const d of app.systemDocs.values()) for (const k of ['Asteroids', 'Nebula']) for (const s of d.ini.all(k)) if ((s.get('file') || '').toLowerCase() === file.toLowerCase()) out.push(`${d.nickname}/${s.get('zone')}`);
  return out;
}

function kvRow(label, input, note) {
  return h('div', { class: 'kv', style: { marginBottom: '4px' } }, h('div', { class: 'k', title: label }, label), h('div', { class: 'v' }, input), h('span'), note ? h('div', { class: 'note' }, note) : null);
}

function valueInput(sec, key, type, dlId, edit) {
  const e = sec.find(key); const v = e ? e.value : '';
  const set = (nv) => edit(`Set ${key}`, () => { if (nv === '' || nv == null) sec.remove(key); else sec.set(e ? e.key : key, nv); });
  if (type === 'color') {
    const txt = h('input', { value: v, placeholder: 'r, g, b', onchange: (ev) => set(ev.target.value.trim()) });
    const pk = h('input', { type: 'color', class: 'swatch', value: hex(to255(v)), onchange: (ev) => { const c = ev.target.value; set([1, 3, 5].map(i => parseInt(c.substr(i, 2), 16)).join(', ')); } });
    return h('div', { style: { display: 'flex', gap: '4px', width: '100%' } }, pk, txt);
  }
  const inp = h('input', { value: v, placeholder: type === 'nums4' ? 'a, b, c, d' : type === 'nums2' ? 'a, b' : type === 'vec3' ? 'x, y, z' : '—', onchange: (ev) => set(ev.target.value.trim()) });
  if (type === 'shape' && dlId) inp.setAttribute('list', dlId);
  return inp;
}

function sectionForm(ini, name, title, keys, dlId, edit) {
  const sec = ini.first(name);
  const box = h('details', { open: !!sec && ['Field', 'Fog', 'Exterior'].includes(name), style: { marginTop: '6px' } });
  box.append(h('summary', { style: { cursor: 'pointer', color: sec ? 'var(--text)' : 'var(--faint)', fontSize: '12px', padding: '3px 0' } }, title + (sec ? '' : ' (none)')));
  if (!sec) {
    box.append(h('button', { class: 'btn sm', style: { margin: '4px 0' }, onclick: () => edit(`Add [${name}]`, () => ini.addSection(name, null, DEFAULTS[name] || [])) }, `+ Add [${name}]`));
    return box;
  }
  const grid = h('div', { class: 'kv' });
  const known = new Set(keys.map(k => k[0]));
  for (const [key, type, note] of keys) {
    grid.append(h('div', { class: 'k', title: key }, key), h('div', { class: 'v' }, valueInput(sec, key, type, dlId, edit)), h('span'));
    if (note) grid.append(h('div', { class: 'note' }, note));
  }
  // any other keys in the section stay editable too
  for (const e of sec.entries) if (!known.has(e.key.toLowerCase()) && !['shape', 'shape_weights', 'puff_shape', 'puff_weights', 'asteroid'].includes(e.key.toLowerCase()))
    grid.append(h('div', { class: 'k', title: e.key }, e.key), h('div', { class: 'v' }, valueInput(sec, e.key, 'text', null, edit)), h('span'));
  box.append(grid, h('div', { style: { marginTop: '4px' } }, h('button', { class: 'btn sm danger', onclick: () => edit(`Remove [${name}]`, () => ini.removeSection(sec)) }, `Remove [${name}]`)));
  return box;
}

// [Cube]: rotation axes + asteroid table
function cubeEditor(app, ini, edit) {
  const box = h('details', { open: true, style: { marginTop: '6px' } }, h('summary', { style: { cursor: 'pointer', fontSize: '12px', padding: '3px 0' } }, 'Cube (asteroid layout)'));
  const sec = ini.first('Cube');
  if (!sec) { box.append(h('button', { class: 'btn sm', onclick: () => edit('Add [Cube]', () => ini.addSection('Cube', ini.first('Field'), [])) }, '+ Add [Cube]')); return box; }
  const g = app.game;
  const dl = datalist([...g.asteroids.values()].map(a => ({ value: a.nickname, label: a.mine ? 'mine' : '' })));
  box.append(dl.el);
  const axes = h('div', { class: 'kv' });
  for (const k of ['xaxis_rotation', 'yaxis_rotation', 'zaxis_rotation']) axes.append(h('div', { class: 'k' }, k.replace('_rotation', '')), h('div', { class: 'v' }, valueInput(sec, k, 'nums4', null, edit)), h('span'));
  box.append(h('div', { class: 'note', style: { color: 'var(--faint)', fontSize: '11px', margin: '2px 0 4px' } }, 'Rotation variants (4 angles per axis, default 0, 90, 180, 270). Positions are in cube units (−1…1).'), axes);
  const rows = sec.findAll('asteroid');
  const table = h('div', { style: { display: 'grid', gridTemplateColumns: '1.6fr repeat(6, 1fr) 18px', gap: '3px', marginTop: '6px', fontSize: '11px', alignItems: 'center' } },
    ...['archetype', 'x', 'y', 'z', 'rx', 'ry', 'rz', ''].map(t => h('div', { style: { color: 'var(--faint)' } }, t)));
  rows.forEach((e) => {
    const v = e.values; while (v.length < 7) v.push('0');
    const cell = (i) => { const inp = h('input', { value: v[i], style: { width: '100%', fontFamily: 'var(--mono)', fontSize: '11px', padding: '2px 3px' }, onchange: (ev) => edit('Edit cube asteroid', () => { const nv = e.values; while (nv.length < 7) nv.push('0'); nv[i] = ev.target.value.trim(); e.value = nv.join(', '); e.raw = null; }) }); if (i === 0) inp.setAttribute('list', dl.id); return inp; };
    table.append(...[0, 1, 2, 3, 4, 5, 6].map(cell), h('button', { class: 'x', style: { background: 'none', border: 0, color: 'var(--faint)', cursor: 'pointer' }, onclick: () => edit('Remove cube asteroid', () => sec.removeEntry(e)) }, '×'));
  });
  box.append(table, h('div', { class: 'btnrow', style: { marginTop: '6px' } },
    h('button', { class: 'btn sm', onclick: () => edit('Add cube asteroid', () => {
      const r = () => fmtNum(Math.random() * 1.6 - 0.8, 2), a = () => Math.round(Math.random() * 360);
      const first = rows[0] ? rows[0].values[0] : ([...g.asteroids.values()][0] || {}).nickname || 'asteroid';
      sec.lines.splice(sec.lastEntryIndex() + 1, 0, new IniEntry('asteroid', [first, r(), r(), r(), a(), a(), a()].join(', ')));
    }) }, '+ Asteroid (random spot)')));
  return box;
}

function dynamicEditor(app, ini, edit) {
  const list = ini.all('DynamicAsteroids');
  const box = h('details', { style: { marginTop: '6px' } }, h('summary', { style: { cursor: 'pointer', fontSize: '12px', padding: '3px 0', color: list.length ? 'var(--text)' : 'var(--faint)' } }, `Dynamic asteroids (${list.length})`));
  const dl = datalist([...app.game.dynamicAsteroids.values()].map(a => a.nickname)); box.append(dl.el);
  for (const sec of list) {
    const grid = h('div', { class: 'kv', style: { borderTop: '1px solid var(--line)', paddingTop: '4px', marginTop: '4px' } });
    for (const k of ['asteroid', 'count', 'placement_radius', 'placement_offset', 'max_velocity', 'max_angular_velocity', 'color_shift']) {
      const inp = valueInput(sec, k, 'text', null, edit); if (k === 'asteroid') inp.setAttribute('list', dl.id);
      grid.append(h('div', { class: 'k' }, k), h('div', { class: 'v' }, inp), h('span'));
    }
    box.append(grid, h('button', { class: 'btn sm danger', style: { marginTop: '3px' }, onclick: () => edit('Remove dynamic asteroids', () => ini.removeSection(sec)) }, 'Remove'));
  }
  box.append(h('div', { style: { marginTop: '6px' } }, h('button', { class: 'btn sm', onclick: () => edit('Add dynamic asteroids', () => ini.addSection('DynamicAsteroids', list[list.length - 1] || null, [['asteroid', ([...app.game.dynamicAsteroids.values()][0] || {}).nickname || ''], ['count', '10'], ['placement_radius', '150'], ['placement_offset', '90'], ['max_velocity', '10'], ['max_angular_velocity', '3'], ['color_shift', '1, 1, 1']])) }, '+ Dynamic asteroids')));
  return box;
}

// repeated shape lines + parallel weights list (Exterior shape/shape_weights, Clouds puff_shape/puff_weights)
function listEditor(ini, secName, key, wkey, title, dlId, edit) {
  const sec = ini.first(secName);
  const box = h('details', { style: { marginTop: '6px' } }, h('summary', { style: { cursor: 'pointer', fontSize: '12px', padding: '3px 0', color: sec ? 'var(--text)' : 'var(--faint)' } }, title));
  if (!sec) return box;
  const shapes = sec.getAll(key); const w = (sec.vals(wkey) || []);
  const save = (ns, nw) => edit(`Edit ${key}`, () => { sec.setAll(key, ns); if (ns.length) sec.set(wkey, ns.map((_, i) => nw[i] || '1').join(', ')); else sec.remove(wkey); });
  shapes.forEach((s, i) => {
    const si = h('input', { value: s, onchange: (e) => { const ns = shapes.slice(); ns[i] = e.target.value.trim(); save(ns, w); } }); si.setAttribute('list', dlId);
    const wi = h('input', { value: w[i] || '1', style: { width: '50px' }, title: 'weight', onchange: (e) => { const nw = w.slice(); nw[i] = e.target.value.trim(); save(shapes, nw); } });
    box.append(h('div', { style: { display: 'flex', gap: '4px', marginBottom: '3px' } }, si, wi, h('button', { class: 'btn sm', onclick: () => save(shapes.filter((_, j) => j !== i), w.filter((_, j) => j !== i)) }, '×')));
  });
  box.append(h('button', { class: 'btn sm', onclick: () => save([...shapes, shapes[0] || ''], [...w, '1']) }, '+ Shape'));
  return box;
}

// "Exclusion Zones": groups starting at each exclusion/exclude line
function exclusionEditor(app, ini, kind, edit) {
  const groups = exclusionGroups(ini);
  const box = h('details', { style: { marginTop: '6px' } }, h('summary', { style: { cursor: 'pointer', fontSize: '12px', padding: '3px 0', color: groups.length ? 'var(--text)' : 'var(--faint)' } }, `Exclusion zones (${groups.length})`));
  const zones = datalist(app.sys.zones.map(z => z.get('nickname')).filter(Boolean)); box.append(zones.el);
  const props = kind === 'nebula' ? [['fog_far', 'num'], ['fog_near', 'num'], ['zone_shell', 'text'], ['shell_scalar', 'num'], ['max_alpha', 'num'], ['exclusion_tint', 'color']] : [['exclude_billboards', 'bool'], ['exclude_dynamic_asteroids', 'bool'], ['empty_cube_frequency', 'num'], ['billboard_count', 'num']];
  // edits go line-by-line so comments and the original ordering survive
  const secOf = (e) => ini.all('Exclusion Zones').find(x => x.lines.includes(e));
  const setProp = (g, k, v) => edit(`Exclusion ${k}`, () => {
    const s = secOf(g.entries[0]); const old = g.entries.find(e => e.key.toLowerCase() === k);
    if (old && v == null) s.removeEntry(old);
    else if (old) { old.value = v; old.raw = null; }
    else if (v != null) s.lines.splice(s.lines.indexOf(g.entries[g.entries.length - 1]) + 1, 0, new IniEntry(k, v));
  });
  const rename = (g, v) => edit('Exclusion zone', () => { g.entries[0].value = v; g.entries[0].raw = null; });
  const drop = (g) => edit('Remove exclusion', () => { const s = secOf(g.entries[0]); for (const e of g.entries) s.removeEntry(e); if (!s.entries.length) ini.removeSection(s); });
  const addGroup = (zone) => edit('Add exclusion', () => {
    const all = ini.all('Exclusion Zones');
    const s = all[all.length - 1] || ini.addSection('Exclusion Zones', ini.first('Field') || ini.first('Fog'), []);
    s.lines.splice(s.lastEntryIndex() + 1, 0, new IniEntry('exclusion', zone));
  });
  groups.forEach((g, i) => {
    const z = app.sys.byNick(g.zone);
    const zi = h('input', { value: g.zone, style: { flex: 1 }, onchange: (e) => rename(g, e.target.value.trim()) }); zi.setAttribute('list', zones.id);
    const row = h('div', { style: { borderTop: '1px solid var(--line)', paddingTop: '4px', marginTop: '4px' } },
      h('div', { style: { display: 'flex', gap: '4px', alignItems: 'center' } }, zi,
        h('button', { class: 'btn sm', title: 'Select zone', onclick: () => z && app.select(z.id) }, z ? '→' : '?'),
        h('button', { class: 'btn sm', onclick: () => drop(g) }, '×')),
      !z ? h('div', { class: 'sev-err', style: { fontSize: '11px' } }, 'zone not in this system') : null);
    const grid = h('div', { class: 'kv', style: { marginTop: '3px' } });
    for (const [k, t] of props) {
      const cur = g.props[k] ?? '';
      const inp = t === 'bool'
        ? h('input', { type: 'checkbox', checked: /^(1|true)$/i.test(cur), onchange: (e) => setProp(g, k, e.target.checked ? '1' : null) })
        : h('input', { value: cur, placeholder: '—', onchange: (e) => setProp(g, k, e.target.value.trim() || null) });
      grid.append(h('div', { class: 'k' }, k), h('div', { class: 'v' }, inp), h('span'));
    }
    row.append(grid); box.append(row);
  });
  const add = h('input', { placeholder: 'zone nickname…', style: { flex: 1 } }); add.setAttribute('list', zones.id);
  box.append(h('div', { style: { display: 'flex', gap: '4px', marginTop: '6px' } }, add, h('button', { class: 'btn sm', onclick: () => { const v = add.value.trim(); if (!v) return; addGroup(v); } }, '+ Exclusion')));
  return box;
}

function otherSection(ini, sec, edit) {
  const zone = sec.get('zone') || sec.get('asteroid') || sec.get('dynamic_loot_commodity') || '';
  const box = h('details', { style: { marginTop: '6px' } }, h('summary', { style: { cursor: 'pointer', fontSize: '12px', padding: '3px 0' } }, `[${sec.name}]${zone ? ' · ' + zone : ''}`));
  const grid = h('div', { class: 'kv' });
  for (const e of sec.entries) grid.append(h('div', { class: 'k', title: e.key }, e.key), h('div', { class: 'v' }, valueInput(sec, e.key, 'text', null, edit)), h('span'));
  box.append(grid, h('div', { class: 'btnrow', style: { marginTop: '4px' } },
    h('button', { class: 'btn sm', onclick: () => edit(`Duplicate [${sec.name}]`, () => ini.addSection(sec.name, sec, sec.entries.map(e => [e.key, e.value]))) }, 'Duplicate'),
    h('button', { class: 'btn sm danger', onclick: () => edit(`Remove [${sec.name}]`, () => ini.removeSection(sec)) }, 'Remove')));
  return box;
}
