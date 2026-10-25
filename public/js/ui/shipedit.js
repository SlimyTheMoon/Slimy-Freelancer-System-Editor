// Ships & equipment editor: shiparch ships (stats, hp_type ↔ model hardpoint matching, ship packages),
// equipment of every kind (with goods.ini price) and loadouts (equip / cargo with hardpoint pickers).
// Everything edits the original INI lines through history (undo, Ctrl+S, backups like the rest).
import { h, datalist, modal, toast, promptDialog } from './dom.js';
import { dataPath } from '../api.js';
import { IniEntry } from '../formats/ini.js';
import { textEditor } from './strings.js';
import { renderInfocard } from './rdl.js';
import { modelViewer } from './modelview.js';

const SHIP_KEYS = [['ids_name', 'name'], ['ids_info', 'infocard'], ['ids_info1', 'stats card'], ['type', ''], ['ship_class', ''], ['mission_property', ''], ['hit_pts', ''], ['mass', 'kg (×1000 in FL units)'], ['hold_size', 'cargo'], ['nanobot_limit', ''], ['shield_battery_limit', ''], ['linear_drag', ''], ['steering_torque', 'x, y, z'], ['angular_drag', 'x, y, z'], ['rotation_inertia', 'x, y, z'], ['nudge_force', ''], ['strafe_force', ''], ['max_bank_angle', ''], ['DA_archetype', 'model'], ['material_library', '']];

export async function shipEditor(app, initial = {}) {
  const g = app.game;
  const dget = (k, def) => { const s = g.flIni && g.flIni.first('Data'); const v = s ? s.getAll(k) : []; return v.length ? v : def; };
  const load = async (files) => (await Promise.all(files.map(f => app.otherDoc(dataPath(f))))).filter(Boolean);
  const shipDocs = await load(dget('ships', ['ships\\shiparch.ini']));
  const equipDocs = await load(dget('equipment', ['equipment\\select_equip.ini']));
  const goodDocs = await load(dget('goods', ['equipment\\goods.ini']));
  const loadoutDocs = await load(dget('loadouts', ['solar\\loadouts.ini', 'ships\\loadouts.ini']));
  const nm = (id) => g.name(parseInt(id)) || '';
  const findIn = (docs, sect, nick) => { const l = (nick || '').toLowerCase(); for (const d of docs) for (const s of d.ini.sections) if ((!sect || s.is(sect)) && (s.get('nickname') || '').toLowerCase() === l) return { doc: d, sec: s }; return null; };
  const allEquip = () => equipDocs.flatMap(d => d.ini.sections.filter(s => s.get('nickname')).map(sec => ({ doc: d, sec })));
  const equipDl = datalist(allEquip().map(({ sec }) => ({ value: sec.get('nickname'), label: `${nm(sec.get('ids_name'))} · ${sec.name}` })));

  const tabs = h('div', { style: { display: 'flex', gap: '4px', marginBottom: '10px' } });
  const body = h('div');
  const viewer = modelViewer(app, { height: 'calc(100vh - 330px)' });
  const m = modal({ title: 'Ships & equipment', wide: true, body: h('div', {}, tabs, body, equipDl.el), onClose: () => { viewer.dispose(); app._shipRefresh = null; } });
  m.box.classList.add('xwide');
  let current = initial.tab || 'ships', selShip = initial.ship || null, selEq = null, selLo = null, filter = '', eqType = '';
  const show = (t) => { current = t; for (const b of tabs.children) b.classList.toggle('on', b.dataset.t === t); body.innerHTML = ''; ({ ships: shipsTab, equip: equipTab, loadouts: loadoutTab })[t](); };
  app._shipRefresh = () => show(current);
  for (const [t, l] of [['ships', 'Ships'], ['equip', 'Equipment'], ['loadouts', 'Loadouts']]) tabs.append(h('button', { class: 'chip', 'data-t': t, onclick: () => show(t) }, l));
  const edit = (doc, label, fn) => { app.history.do(label, [doc], fn); show(current); };

  // generic key/value form for a section (id keys get ✎ and their text)
  function entriesForm(doc, sec, keys = null) {
    const grid = h('div', { class: 'kv' });
    const known = keys ? keys.map(k => k[0].toLowerCase()) : [];
    const order = keys ? [...keys.map(k => k[0]), ...sec.entries.map(e => e.key).filter(k => !known.includes(k.toLowerCase()))] : sec.entries.map(e => e.key);
    const seen = new Set();
    for (const key of order) {
      const kl = key.toLowerCase(); if (seen.has(kl) && sec.findAll(key).length <= 1) continue; seen.add(kl);
      const entries = sec.findAll(key);
      const list = entries.length ? entries : (keys ? [null] : []);
      list.forEach((e) => {
        const inp = h('input', { value: e ? e.value : '', placeholder: '—', onchange: (ev) => edit(doc, `Set ${key}`, () => { const v = ev.target.value.trim(); if (e) { if (v) { e.value = v; e.raw = null; } else sec.removeEntry(e); } else if (v) sec.set(key, v); }) });
        const isId = /^ids_/i.test(key);
        const extra = isId ? [h('button', { class: 'btn sm', onclick: async () => { const id = parseInt(e && e.value) || null; const gid = await textEditor(app, { id, kind: /info/i.test(key) ? 'infocard' : 'string' }); if (gid && gid !== id) edit(doc, `Set ${key}`, () => sec.set(key, String(gid))); else show(current); } }, (e && parseInt(e.value)) ? '✎' : '+'), h('span', { class: 'hint', title: nm(e && e.value) }, (nm(e && e.value) || '').split('\n')[0])] : [];
        if (/^(equip|projectile_archetype|loadout)$/i.test(key)) inp.setAttribute('list', equipDl.id);
        const note = keys && (keys.find(k => k[0].toLowerCase() === kl) || [])[1];
        grid.append(h('div', { class: 'k', title: note || key }, key), h('div', { class: 'v' }, inp, ...extra), e ? h('button', { class: 'x', title: 'Remove', onclick: () => edit(doc, `Remove ${key}`, () => sec.removeEntry(e)) }, '×') : h('span'));
      });
    }
    const addK = h('input', { placeholder: '+ key', style: { width: '120px' } }), addV = h('input', { placeholder: 'value', style: { flex: 1 } });
    return h('div', {}, grid, h('div', { style: { display: 'flex', gap: '4px', marginTop: '6px' } }, addK, addV, h('button', { class: 'btn sm', onclick: () => { const k = addK.value.trim(); if (k) edit(doc, `Add ${k}`, () => sec.lines.splice(sec.lastEntryIndex() + 1, 0, new IniEntry(k, addV.value.trim()))); } }, 'Add')));
  }
  const layout = (listEl, detailEl) => h('div', { style: { display: 'grid', gridTemplateColumns: '300px 1fr 1fr', gap: '12px', alignItems: 'start' } }, listEl, detailEl, viewer.el);
  const listBox = (items, isSel, onPick, placeholder) => {
    const q = h('input', { value: filter, placeholder, style: { width: '100%' }, oninput: (e) => { filter = e.target.value.toLowerCase(); draw(); } });
    const lst = h('div', { class: 'reflist', style: { height: 'calc(100vh - 300px)', overflow: 'auto', marginTop: '6px' } });
    const draw = () => { lst.innerHTML = ''; for (const it of items.filter(it => !filter || `${it.title} ${it.sub}`.toLowerCase().includes(filter)).slice(0, 1500)) lst.append(h('div', { style: { padding: '2px 6px', cursor: 'pointer', background: isSel(it) ? 'rgba(255,210,80,0.12)' : '' }, onclick: () => onPick(it) }, it.title, h('span', { style: { color: 'var(--faint)', float: 'right', fontSize: '11px' } }, it.sub))); };
    draw(); return h('div', {}, q, lst);
  };

  // ------------------------------------------------------------ ships
  function shipsTab() {
    const ships = shipDocs.flatMap(d => d.ini.all('Ship').map(sec => ({ doc: d, sec, nick: sec.get('nickname'), title: nm(sec.get('ids_name')) || sec.get('nickname'), sub: `${(sec.get('type') || '').toLowerCase()} · ${sec.get('nickname')}` })));
    if (!selShip && ships[0]) selShip = ships[0].nick;
    const cur = ships.find(s => (s.nick || '').toLowerCase() === (selShip || '').toLowerCase());
    const detail = h('div', { style: { height: 'calc(100vh - 260px)', overflow: 'auto' } });
    body.append(layout(listBox(ships, (it) => it === cur, (it) => { selShip = it.nick; show('ships'); }, `Filter ${ships.length} ships…`), detail));
    if (!cur) return;
    const { doc, sec } = cur;
    const da = sec.get('DA_archetype'), libs = sec.getAll('material_library');
    detail.append(h('h3', {}, cur.title, h('span', { class: 'act' },
      da ? h('button', { class: 'btn sm', onclick: () => import('./hardpoints.js').then(hp => hp.hardpointEditor(app, { path: dataPath(da), matLibs: libs.map(dataPath), title: cur.nick })) }, 'Hardpoints…') : null,
      h('button', { class: 'btn sm', onclick: () => duplicate(doc, sec, 'Ship') }, 'Duplicate…'))));
    const info = g.infocards.get(parseInt(sec.get('ids_info')));
    if (info) detail.append(renderInfocard(info, { maxHeight: '140px' }));
    detail.append(h('div', { class: 'psec' }, h('h3', {}, 'Ship'), entriesForm(doc, sec, SHIP_KEYS.filter(([k]) => sec.has(k) || ['ids_name', 'ids_info', 'type', 'hit_pts', 'mass', 'hold_size', 'nanobot_limit', 'shield_battery_limit'].includes(k)))));
    // hp_type ↔ model hardpoints
    const hpBox = h('div', { class: 'psec' }, h('h3', {}, 'Hardpoint types (hp_type)'));
    detail.append(hpBox);
    viewer.load(da ? dataPath(da) : null, libs.map(dataPath)).then(() => {
      const modelHps = new Set(viewer.hardpoints().map(n => n.toLowerCase()));
      const used = new Set();
      for (const e of sec.findAll('hp_type')) {
        const v = e.values, type = v[0], hps = v.slice(1);
        hps.forEach(x => used.add(x.toLowerCase()));
        const missing = hps.filter(x => modelHps.size && !modelHps.has(x.toLowerCase()));
        const row = h('div', { style: { display: 'flex', gap: '4px', alignItems: 'center', marginBottom: '3px' } },
          h('input', { value: type, style: { width: '210px', fontFamily: 'var(--mono)', fontSize: '12px' }, onchange: (ev) => edit(doc, 'hp_type', () => { const nv = e.values; nv[0] = ev.target.value.trim(); e.value = nv.join(', '); e.raw = null; }) }),
          h('input', { value: hps.join(', '), style: { flex: 1, fontFamily: 'var(--mono)', fontSize: '12px' }, onfocus: () => viewer.setHighlight(hps), onchange: (ev) => edit(doc, 'hp_type', () => { e.value = [type, ...ev.target.value.split(',').map(x => x.trim()).filter(Boolean)].join(', '); e.raw = null; }) }),
          h('button', { class: 'x', onclick: () => edit(doc, 'Remove hp_type', () => sec.removeEntry(e)) }, '×'));
        hpBox.append(row);
        if (missing.length) hpBox.append(h('div', { class: 'sev-err', style: { fontSize: '11px', marginBottom: '4px' } }, `not in the model: ${missing.join(', ')}`));
      }
      const unmapped = viewer.hardpoints().filter(n => /^Hp(Weapon|Turret|Torpedo|Mine|CM|Shield|Thruster)/i.test(n) && !used.has(n.toLowerCase()));
      if (unmapped.length) hpBox.append(h('div', { class: 'sev-warn', style: { fontSize: '11px' } }, `model hardpoints without any hp_type: ${unmapped.join(', ')}`));
      hpBox.append(h('button', { class: 'btn sm', style: { marginTop: '4px' }, onclick: () => edit(doc, 'Add hp_type', () => { const last = sec.findAll('hp_type').pop(); sec.lines.splice(last ? sec.lines.indexOf(last) + 1 : sec.lastEntryIndex() + 1, 0, new IniEntry('hp_type', 'hp_gun_special_1, HpWeapon01')); }) }, '+ hp_type'));
    });
    // packages that sell this ship
    const hulls = goodDocs.flatMap(d => d.ini.all('Good').filter(s => (s.get('ship') || '').toLowerCase() === cur.nick.toLowerCase()).map(s => ({ d, s })));
    const pk = h('div', { class: 'psec' }, h('h3', {}, 'Goods (hull / package)'));
    for (const { d, s } of hulls) {
      pk.append(h('div', { style: { fontSize: '12px', margin: '2px 0' } }, `hull ${s.get('nickname')} · price ${s.get('price')}`));
      for (const gd of goodDocs) for (const p of gd.ini.all('Good').filter(x => (x.get('hull') || '').toLowerCase() === (s.get('nickname') || '').toLowerCase()))
        pk.append(h('details', {}, h('summary', { style: { cursor: 'pointer', fontSize: '12px' } }, `package ${p.get('nickname')} · ${p.findAll('addon').length} addons`), entriesForm(gd, p)));
      pk.append(h('details', {}, h('summary', { style: { cursor: 'pointer', fontSize: '12px' } }, `edit hull good`), entriesForm(d, s)));
    }
    if (!hulls.length) pk.append(h('div', { style: { color: 'var(--faint)', fontSize: '12px' } }, 'No [Good] with ship = this ship (not sold anywhere).'));
    detail.append(pk, h('details', { style: { marginTop: '6px' } }, h('summary', { style: { cursor: 'pointer', fontSize: '12px', color: 'var(--dim)' } }, 'All entries'), entriesForm(doc, sec)));
  }

  // ------------------------------------------------------------ equipment
  function equipTab() {
    const items = allEquip().filter(({ sec }) => !eqType || sec.name.toLowerCase() === eqType).map(({ doc, sec }) => ({ doc, sec, title: nm(sec.get('ids_name')) || sec.get('nickname'), sub: `${sec.name} · ${sec.get('nickname')}` }));
    const types = [...new Set(allEquip().map(({ sec }) => sec.name))].sort();
    const cur = items.find(it => it.sec === selEq) || null;
    const detail = h('div', { style: { height: 'calc(100vh - 260px)', overflow: 'auto' } });
    const typeSel = h('select', { style: { width: '100%', marginBottom: '6px' }, onchange: (e) => { eqType = e.target.value; show('equip'); } }, h('option', { value: '' }, 'all types'), types.map(t => h('option', { value: t.toLowerCase(), selected: eqType === t.toLowerCase() }, t)));
    body.append(layout(h('div', {}, typeSel, listBox(items, (it) => it === cur, (it) => { selEq = it.sec; show('equip'); }, `Filter ${items.length}…`)), detail));
    if (!cur) { viewer.load(null); return; }
    const { doc, sec } = cur;
    detail.append(h('h3', {}, cur.title, h('span', { class: 'act' }, h('button', { class: 'btn sm', onclick: () => duplicate(doc, sec, sec.name) }, 'Duplicate…'))));
    const info = g.infocards.get(parseInt(sec.get('ids_info')));
    if (info) detail.append(renderInfocard(info, { maxHeight: '140px' }));
    detail.append(h('div', { class: 'psec' }, h('h3', {}, `[${sec.name}]`), entriesForm(doc, sec)));
    // the good (price) that sells this equipment
    const goods = goodDocs.flatMap(d => d.ini.all('Good').filter(s => (s.get('equipment') || '').toLowerCase() === (sec.get('nickname') || '').toLowerCase()).map(s => ({ d, s })));
    for (const { d, s } of goods) detail.append(h('div', { class: 'psec' }, h('h3', {}, `[Good] ${s.get('nickname')}`), entriesForm(d, s, [['price', 'credits'], ['item_icon', ''], ['combinable', '']])));
    // which ships can mount it
    const hpType = sec.get('hp_gun_type') || sec.get('hp_type');
    if (hpType) {
      const fits = shipDocs.flatMap(d => d.ini.all('Ship')).filter(s => s.findAll('hp_type').some(e => (e.values[0] || '').toLowerCase() === hpType.toLowerCase()));
      detail.append(h('div', { class: 'psec' }, h('h3', {}, `Fits ${hpType} (${fits.length} ships)`), h('div', { style: { fontSize: '12px', color: 'var(--dim)' } }, fits.map(s => nm(s.get('ids_name')) || s.get('nickname')).join(', ') || '—')));
    }
    const da = sec.get('DA_archetype') || sec.get('da_archetype');
    viewer.load(da ? dataPath(da) : null, sec.getAll('material_library').map(dataPath), { showHardpoints: true });
  }

  // ------------------------------------------------------------ loadouts
  function loadoutTab() {
    const items = loadoutDocs.flatMap(d => d.ini.all('Loadout').map(sec => ({ doc: d, sec, title: sec.get('nickname'), sub: `${sec.findAll('equip').length} equip · ${d.path.split('/').pop()}` })));
    const cur = items.find(it => it.sec === selLo) || null;
    const detail = h('div', { style: { height: 'calc(100vh - 260px)', overflow: 'auto' } });
    body.append(layout(listBox(items, (it) => it === cur, (it) => { selLo = it.sec; show('loadouts'); }, `Filter ${items.length} loadouts…`), detail));
    if (!cur) { viewer.load(null); return; }
    const { doc, sec } = cur;
    // archetype → model hardpoints: ships (shiparch) or solar archetypes
    const archNick = sec.get('archetype');
    const shipA = archNick && findIn(shipDocs, 'Ship', archNick);
    const solarA = archNick && g.arch(archNick);
    const da = shipA ? shipA.sec.get('DA_archetype') : solarA && solarA.da;
    const libs = shipA ? shipA.sec.getAll('material_library') : solarA ? solarA.matLibs : [];
    detail.append(h('h3', {}, cur.title, h('span', { class: 'act' }, h('button', { class: 'btn sm', onclick: () => duplicate(doc, sec, 'Loadout') }, 'Duplicate…'))),
      h('div', { class: 'kv' }, h('div', { class: 'k' }, 'archetype'), h('div', { class: 'v' }, h('input', { value: archNick || '', onchange: (e) => edit(doc, 'Loadout archetype', () => e.target.value.trim() ? sec.set('archetype', e.target.value.trim()) : sec.remove('archetype')) }), h('span', { class: 'hint' }, shipA ? 'ship' : solarA ? solarA.type.toLowerCase() : archNick ? 'unknown' : '')), h('span')));
    const tbl = h('div', { style: { display: 'grid', gridTemplateColumns: '1.4fr 1.6fr 1fr 22px', gap: '3px', marginTop: '8px', fontSize: '12px', alignItems: 'center' } }, ...['equipment', 'name', 'hardpoint', ''].map(t => h('div', { style: { color: 'var(--faint)' } }, t)));
    const hpDl = datalist([]); detail.append(hpDl.el);
    for (const e of sec.findAll('equip')) {
      const v = e.values;
      const eq = h('input', { value: v[0] || '', style: { fontFamily: 'var(--mono)', fontSize: '12px' }, onchange: (ev) => edit(doc, 'Loadout equip', () => { const nv = e.values; nv[0] = ev.target.value.trim(); e.value = nv.join(', '); e.raw = null; }) }); eq.setAttribute('list', equipDl.id);
      const hp = h('input', { value: v[1] || '', placeholder: '(internal)', style: { fontFamily: 'var(--mono)', fontSize: '12px' }, onfocus: () => viewer.setHighlight([hp.value]), onchange: (ev) => edit(doc, 'Loadout hardpoint', () => { const nv = e.values; const val = ev.target.value.trim(); if (val) nv[1] = val; else nv.length = 1; e.value = nv.join(', '); e.raw = null; }) }); hp.setAttribute('list', hpDl.id);
      const eqs = findIn(equipDocs, null, v[0]);
      tbl.append(eq, h('div', { style: { color: eqs ? 'var(--dim)' : 'var(--err, #f77)' } }, eqs ? `${nm(eqs.sec.get('ids_name')) || ''} (${eqs.sec.name})` : 'unknown equipment'), hp, h('button', { class: 'x', onclick: () => edit(doc, 'Remove equip', () => sec.removeEntry(e)) }, '×'));
    }
    detail.append(tbl, h('button', { class: 'btn sm', style: { marginTop: '6px' }, onclick: () => edit(doc, 'Add equip', () => { const last = sec.findAll('equip').pop(); sec.lines.splice(last ? sec.lines.indexOf(last) + 1 : sec.lastEntryIndex() + 1, 0, new IniEntry('equip', '')); }) }, '+ equip'));
    const cargo = h('div', { class: 'psec' }, h('h3', {}, 'Cargo'));
    for (const e of sec.findAll('cargo')) cargo.append(h('div', { style: { display: 'flex', gap: '4px', marginBottom: '3px' } },
      (() => { const i = h('input', { value: e.values[0] || '', style: { flex: 1 }, onchange: (ev) => edit(doc, 'Cargo', () => { const nv = e.values; nv[0] = ev.target.value.trim(); e.value = nv.join(', '); e.raw = null; }) }); i.setAttribute('list', equipDl.id); return i; })(),
      h('input', { value: e.values[1] || '1', type: 'number', style: { width: '70px' }, onchange: (ev) => edit(doc, 'Cargo', () => { const nv = e.values; nv[1] = ev.target.value.trim(); e.value = nv.join(', '); e.raw = null; }) }),
      h('button', { class: 'x', onclick: () => edit(doc, 'Remove cargo', () => sec.removeEntry(e)) }, '×')));
    cargo.append(h('button', { class: 'btn sm', onclick: () => edit(doc, 'Add cargo', () => sec.lines.splice(sec.lastEntryIndex() + 1, 0, new IniEntry('cargo', ', 1'))) }, '+ cargo'));
    detail.append(cargo);
    viewer.load(da ? dataPath(da) : null, libs.map(dataPath)).then(() => {
      const hps = viewer.hardpoints(); hpDl.el.append(...hps.map(n => h('option', { value: n })));
      viewer.setHighlight(sec.findAll('equip').map(e => e.values[1]).filter(Boolean));
      const bad = sec.findAll('equip').map(e => e.values[1]).filter(x => x && hps.length && !hps.some(n => n.toLowerCase() === x.toLowerCase()));
      if (bad.length) detail.insertBefore(h('div', { class: 'sev-err', style: { fontSize: '12px', margin: '6px 0' } }, `hardpoints not in the model: ${[...new Set(bad)].join(', ')}`), tbl);
    });
  }

  async function duplicate(doc, sec, kind) {
    const nn = (await promptDialog(`Duplicate ${kind}`, 'New nickname', (sec.get('nickname') || '') + '_copy') || '').trim();
    if (!nn) return;
    if (findIn([...shipDocs, ...equipDocs, ...loadoutDocs, ...goodDocs], null, nn)) { toast('Nickname already used'); return; }
    edit(doc, `Duplicate ${kind}`, () => { const c = sec.clone(); c.set('nickname', nn); doc.ini.insertSection(c, doc.ini.sections.indexOf(sec) + 1); });
    if (kind === 'Ship') selShip = nn; else if (kind === 'Loadout') selLo = doc.ini.sections[doc.ini.sections.indexOf(sec) + 1]; else selEq = doc.ini.sections[doc.ini.sections.indexOf(sec) + 1];
    show(current);
  }

  show(current);
}
