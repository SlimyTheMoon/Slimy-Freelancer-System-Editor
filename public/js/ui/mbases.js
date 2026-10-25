// Base characters (missions\mbases.ini) and news (missions\news.ini) editor.
// mbases.ini is a flat list of sections; everything after an [MBase] up to the next [MBase]
// ([MVendor], [BaseFaction], [GF_NPC], [MRoom]) belongs to that base.
// Key layout of mbases.ini (GF_NPC, MRoom, BaseFaction) and news.ini:
//   rumor / rumor_type2 = start flag, end flag, rep level (1–3), ids   (+ optional rumorknowdb = objects)
//   know  = ids text, ids text 2, price, rep level                     (+ optional knowdb = objects)
//   bribe = faction, price, ids      misn = mission type, min, max
//   fixture = npc, marker, fidget script, role      (MRoom)
//   [NewsItem] rank = start, end · icon · logo · category · headline · text · base (multi) · autoselect
import { h, datalist, modal, toast, confirmDialog, promptDialog } from './dom.js';
import { IniEntry } from '../formats/ini.js';
import { dataPath } from '../api.js';
import { loadIni } from '../gamedata.js';
import { textEditor } from './strings.js';

const MBASES = 'missions\\mbases.ini', NEWS = 'missions\\news.ini';

// ---------------------------------------------------------------- model helpers
export function baseBlocks(ini) {
  const out = new Map(); let cur = null;
  for (const s of ini.sections) {
    if (s.is('MBase')) { cur = { mbase: s, secs: [] }; const n = (s.get('nickname') || '').toLowerCase(); if (n) out.set(n, cur); continue; }
    if (cur) cur.secs.push(s);
  }
  return out;
}
const of = (blk, name) => blk ? blk.secs.filter(s => s.is(name)) : [];

function textOf(g, id) { const n = parseInt(id); if (!n) return ''; return g.name(n) ?? g.infocard(n) ?? ''; }
function kindOf(g, id, def) { const n = parseInt(id); if (n && g.name(n) != null) return 'string'; if (n && g.infocard(n)) return 'infocard'; return def; }

// entry → editable column values
function setVal(e, i, v) { const vals = e.values; while (vals.length <= i) vals.push(''); vals[i] = v; e.value = vals.join(', '); e.raw = null; }

export async function basesEditor(app, initial = {}) {
  const g = app.game;
  const mdoc = await app.otherDoc(dataPath(MBASES));
  const ndoc = await app.otherDoc(dataPath(NEWS));
  if (!mdoc && !ndoc) { toast('missions\\mbases.ini and news.ini not found'); return; }
  // pick lists
  const parts = await loadIni(dataPath('characters\\bodyparts.ini'));
  const partList = (k) => parts ? parts.all(k).map(s => s.get('nickname')).filter(Boolean) : [];
  const dl = {
    body: datalist(partList('Body')), head: datalist(partList('Head')), left: datalist(partList('LeftHand')), right: datalist(partList('RightHand')), acc: datalist(partList('Accessory')),
    faction: datalist(g.factions.map(f => ({ value: f.nickname, label: g.name(f.ids) || '' }))),
    base: datalist(g.bases.map(b => ({ value: b.nickname, label: g.name(b.strid) || '' }))),
  };
  const distinct = (doc, keys, idx = 0) => { const set = new Set(); if (doc) for (const s of doc.ini.sections) for (const e of s.entries) if (keys.includes(e.key.toLowerCase())) { const v = e.values[idx]; if (v) set.add(v); } return [...set].sort(); };
  const flags = [...new Set([...distinct(mdoc, ['rumor', 'rumor_type2'], 0), ...distinct(mdoc, ['rumor', 'rumor_type2'], 1), ...distinct(ndoc, ['rank'], 0), ...distinct(ndoc, ['rank'], 1)])].sort();
  Object.assign(dl, { voice: datalist(distinct(mdoc, ['voice'])), room: datalist(distinct(mdoc, ['room'])), flag: datalist(flags), icon: datalist(distinct(ndoc, ['icon'])), logo: datalist(distinct(ndoc, ['logo'])), misn: datalist(distinct(mdoc, ['misn', 'mission_type'])), appr: datalist(distinct(mdoc, ['base_appr'])) });
  const dlEls = Object.values(dl).map(d => d.el);

  const tabs = h('div', { style: { display: 'flex', gap: '4px', marginBottom: '10px' } });
  const body = h('div');
  const m = modal({ title: 'Base characters & news', body: h('div', {}, tabs, body, dlEls), wide: true, onClose: () => { app._basesRefresh = null; } });
  m.box.classList.add('xwide');
  let current = initial.tab || 'npcs', baseSel = initial.base || (g.bases[0] && g.bases[0].nickname) || '', npcSel = null;
  const show = (t) => { current = t; for (const b of tabs.children) b.classList.toggle('on', b.dataset.t === t); body.innerHTML = ''; (t === 'npcs' ? npcsTab : newsTab)(); };
  app._basesRefresh = () => show(current);
  for (const [t, l] of [['npcs', 'Base characters'], ['news', 'News']]) tabs.append(h('button', { class: 'chip', 'data-t': t, onclick: () => show(t) }, l));
  const baseLabel = (b) => { const bb = g.findBase(b); return (bb && g.name(bb.strid)) || b; };
  const edit = (doc, label, fn) => { app.history.do(label, [doc], fn); show(current); };

  // input bound to one column of an entry
  const cell = (doc, e, i, opts = {}) => {
    const inp = h('input', { value: e.values[i] ?? '', placeholder: opts.ph || '', style: { width: opts.w || '100%', minWidth: '0', fontFamily: opts.mono ? 'var(--mono)' : '', fontSize: '12px' }, type: opts.num ? 'number' : 'text', step: opts.step || 'any',
      onchange: (ev) => edit(doc, opts.label || `Edit ${e.key}`, () => setVal(e, i, ev.target.value.trim())) });
    if (opts.list) inp.setAttribute('list', opts.list.id);
    return inp;
  };
  // id text column: preview + ✎ (edit or create)
  const idCell = (doc, e, i, defKind) => {
    const id = parseInt(e.values[i]) || 0, txt = textOf(g, id);
    return h('div', { style: { display: 'flex', gap: '4px', alignItems: 'center', minWidth: '0' } },
      h('input', { value: id || '', style: { width: '78px', fontFamily: 'var(--mono)', fontSize: '12px' }, onchange: (ev) => edit(doc, `Set ${e.key} id`, () => setVal(e, i, ev.target.value.trim())) }),
      h('button', { class: 'btn sm', title: id ? 'Edit text' : 'Create text', onclick: async () => { const gid = await textEditor(app, { id: id || null, kind: kindOf(g, id, defKind), initial: '' }); if (gid && gid !== id) edit(doc, `Set ${e.key} id`, () => setVal(e, i, String(gid))); else show(current); } }, id ? '✎' : '+'),
      h('span', { title: txt, style: { color: txt ? 'var(--dim)' : 'var(--faint)', fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: '0', flex: 1 } }, txt ? txt.replace(/\s+/g, ' ') : (id ? '(no text)' : '')));
  };
  const kv = (doc, sec, key, opts = {}) => {
    const e = sec.find(key);
    const inp = h('input', { value: e ? e.value : '', placeholder: '—', style: { width: '100%' }, onchange: (ev) => edit(doc, `Set ${key}`, () => { const v = ev.target.value.trim(); if (v) sec.set(e ? e.key : key, v); else sec.remove(key); }) });
    if (opts.list) inp.setAttribute('list', opts.list.id);
    return [h('div', { class: 'k' }, key), h('div', { class: 'v' }, inp, opts.after ? opts.after(e) : null), h('span')];
  };
  // a repeated key as a table. attach = optional follow-up key bound to each row (knowdb / rumorknowdb)
  function rowsTable(doc, sec, keys, cols, { attach, addKey, addValue, title } = {}) {
    const entries = sec.entries.filter(e => keys.includes(e.key.toLowerCase()));
    const wrap = h('div', { style: { margin: '6px 0' } });
    if (title) wrap.append(h('div', { style: { fontSize: '11px', color: 'var(--faint)', margin: '6px 0 2px' } }, `${title} (${entries.length})`));
    const grid = h('div', { style: { display: 'grid', gridTemplateColumns: cols.map(c => c.w || '1fr').join(' ') + (attach ? ' 1fr' : '') + ' 22px', gap: '3px', alignItems: 'center', fontSize: '12px' } });
    grid.append(...cols.map(c => h('div', { style: { color: 'var(--faint)', fontSize: '11px' } }, c.label)), ...(attach ? [h('div', { style: { color: 'var(--faint)', fontSize: '11px' } }, attach)] : []), h('span'));
    const follow = (e) => { const i = sec.lines.indexOf(e); const n = sec.lines.slice(i + 1).find(l => l.type === 'entry'); return n && n.key.toLowerCase() === attach ? n : null; };
    for (const e of entries) {
      for (const c of cols) grid.append(c.render ? c.render(e) : c.ids ? idCell(doc, e, c.i, c.ids) : cell(doc, e, c.i, c));
      if (attach) {
        const a = follow(e);
        grid.append(h('input', { value: a ? a.value : '', placeholder: '—', style: { width: '100%', fontSize: '12px' }, onchange: (ev) => edit(doc, `Set ${attach}`, () => { const v = ev.target.value.trim(); if (a && v) { a.value = v; a.raw = null; } else if (a) sec.removeEntry(a); else if (v) sec.lines.splice(sec.lines.indexOf(e) + 1, 0, new IniEntry(attach, v)); }) }));
      }
      grid.append(h('button', { class: 'x', title: 'Remove', style: { background: 'none', border: 0, color: 'var(--faint)', cursor: 'pointer' }, onclick: () => edit(doc, `Remove ${e.key}`, () => { const a = attach && follow(e); sec.removeEntry(e); if (a) sec.removeEntry(a); }) }, '×'));
    }
    wrap.append(grid);
    if (addKey) wrap.append(h('button', { class: 'btn sm', style: { marginTop: '4px' }, onclick: () => edit(doc, `Add ${addKey}`, () => {
      const last = entries[entries.length - 1]; let at = last ? sec.lines.indexOf(last) + 1 : sec.lastEntryIndex() + 1;
      if (last && attach) { const a = follow(last); if (a) at = sec.lines.indexOf(a) + 1; }
      sec.lines.splice(at, 0, new IniEntry(addKey, typeof addValue === 'function' ? addValue(last) : addValue));
    }) }, `+ ${addKey}`));
    return wrap;
  }

  // ------------------------------------------------------------ characters tab
  function npcsTab() {
    if (!mdoc) { body.append(h('div', { class: 'sev-err' }, 'missions\\mbases.ini not found')); return; }
    const blocks = baseBlocks(mdoc.ini);
    const pick = h('input', { value: baseSel, style: { width: '260px' }, onchange: () => { baseSel = pick.value.trim(); npcSel = null; show('npcs'); } }); pick.setAttribute('list', dl.base.id);
    body.append(h('div', { class: 'topts' }, h('label', { class: 'topt' }, 'Base', pick), h('span', {}, baseLabel(baseSel)), h('span', { style: { marginLeft: 'auto' } }, `${blocks.size} bases in mbases.ini`)));
    const blk = blocks.get(baseSel.toLowerCase());
    if (!blk) {
      body.append(h('div', { class: 'empty' }, 'This base has no [MBase] block (no characters, no bar).'),
        h('button', { class: 'btn primary', onclick: () => edit(mdoc, 'Create MBase', () => {
          const s = mdoc.ini.addSection('MBase', null, [['nickname', baseSel], ['local_faction', (g.factions[0] || {}).nickname || 'li_n_grp'], ['diff', '1'], ['msg_id_prefix', `gcs_refer_base_${baseSel}`]]);
          let after = mdoc.ini.addSection('MVendor', s, [['num_offers', '2, 4']]);
          after = mdoc.ini.addSection('MRoom', after, [['nickname', 'bar'], ['character_density', '4']]);
        }) }, '+ Create [MBase] block'));
      return;
    }
    const mb = blk.mbase, vendor = of(blk, 'MVendor')[0];
    const npcs = of(blk, 'GF_NPC'), facs = of(blk, 'BaseFaction'), rooms = of(blk, 'MRoom');
    const npcDl = datalist(npcs.map(n => ({ value: n.get('nickname'), label: textOf(g, n.get('individual_name')).split('\n').pop() })));
    body.append(npcDl.el);
    // reference check: npc names used by factions/fixtures must exist as [GF_NPC] (searched across the file, as FL does)
    const allNpc = new Set(mdoc.ini.all('GF_NPC').map(x => (x.get('nickname') || '').toLowerCase()));
    const missing = [...new Set([...facs.flatMap(f => f.getAll('npc')), ...rooms.flatMap(r => r.findAll('fixture').map(e => e.values[0]))].filter(v => v && !allNpc.has(v.toLowerCase())))];
    if (missing.length) body.append(h('div', { class: 'sev-err', style: { fontSize: '12px', marginBottom: '6px' } }, `Referenced characters without a [GF_NPC]: ${missing.join(', ')}`));
    if (!g.findBase(mb.get('nickname'))) body.append(h('div', { class: 'sev-warn', style: { fontSize: '12px' } }, 'This [MBase] has no matching [Base] in universe.ini.'));
    const cols = h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(300px, 1fr) minmax(420px, 1.6fr)', gap: '16px', alignItems: 'start' } });
    body.append(cols);
    const left = h('div'), right = h('div'); cols.append(left, right);

    // base header
    left.append(h('div', { class: 'psec' }, h('h3', {}, '[MBase]'), h('div', { class: 'kv' }, ...kv(mdoc, mb, 'local_faction', { list: dl.faction }), ...kv(mdoc, mb, 'diff'), ...kv(mdoc, mb, 'msg_id_prefix'), ...(vendor ? kv(mdoc, vendor, 'num_offers') : []))));
    // rooms
    const roomBox = h('div', { class: 'psec' }, h('h3', {}, `Rooms (${rooms.length})`));
    for (const r of rooms) {
      roomBox.append(h('div', { style: { borderTop: '1px solid var(--line)', paddingTop: '4px', marginTop: '4px' } },
        h('div', { class: 'kv' }, ...kv(mdoc, r, 'nickname'), ...kv(mdoc, r, 'character_density')),
        rowsTable(mdoc, r, ['fixture'], [{ label: 'npc', i: 0, list: npcDl, w: '1.3fr', mono: true }, { label: 'marker', i: 1, w: '1.3fr' }, { label: 'fidget', i: 2, w: '1.3fr' }, { label: 'role', i: 3, w: '0.8fr' }], { addKey: 'fixture', addValue: () => `${npcs[0] ? npcs[0].get('nickname') : 'npc'}, Zs/NPC/Bartender/01/A/Stand, scripts\\vendors\\li_bartender_fidget.thn, bartender`, title: 'fixtures' }),
        h('button', { class: 'btn sm danger', onclick: () => edit(mdoc, 'Remove room', () => mdoc.ini.removeSection(r)) }, 'Remove room')));
    }
    roomBox.append(h('button', { class: 'btn sm', style: { marginTop: '6px' }, onclick: () => edit(mdoc, 'Add room', () => mdoc.ini.addSection('MRoom', [...blk.secs].pop() || mb, [['nickname', 'bar'], ['character_density', '4']])) }, '+ Room'));
    // factions
    const facBox = h('div', { class: 'psec' }, h('h3', {}, `Factions on this base (${facs.length})`));
    for (const f of facs) {
      const npcLines = f.findAll('npc');
      facBox.append(h('div', { style: { borderTop: '1px solid var(--line)', paddingTop: '4px', marginTop: '4px' } },
        h('div', { class: 'kv' }, ...kv(mdoc, f, 'faction', { list: dl.faction, after: () => h('span', { class: 'hint' }, g.factionName(f.get('faction')) || '') }), ...kv(mdoc, f, 'weight')),
        rowsTable(mdoc, f, ['mission_type'], [{ label: 'mission type', i: 0, list: dl.misn }, { label: 'min', i: 1, w: '60px' }, { label: 'max', i: 2, w: '70px' }, { label: 'weight', i: 3, w: '60px' }], { addKey: 'mission_type', addValue: 'DestroyMission, 0, 0.112387, 10', title: 'missions offered' }),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '4px' } }, npcLines.map(e => h('span', { class: 'chip', style: { cursor: 'pointer' }, onclick: () => { npcSel = e.value.toLowerCase(); show('npcs'); } }, e.value, ' ', h('b', { style: { cursor: 'pointer', marginLeft: '4px' }, onclick: (ev) => { ev.stopPropagation(); edit(mdoc, 'Remove npc from faction', () => f.removeEntry(e)); } }, '×'))),
          (() => { const add = h('input', { placeholder: '+ npc…', style: { width: '160px', fontSize: '12px' }, onchange: (ev) => { const v = ev.target.value.trim(); if (v) edit(mdoc, 'Add npc to faction', () => { const last = npcLines[npcLines.length - 1]; f.lines.splice(last ? f.lines.indexOf(last) + 1 : f.lastEntryIndex() + 1, 0, new IniEntry('npc', v)); }); } }); add.setAttribute('list', npcDl.id); return add; })()),
        h('button', { class: 'btn sm danger', style: { marginTop: '4px' }, onclick: () => edit(mdoc, 'Remove base faction', () => mdoc.ini.removeSection(f)) }, 'Remove faction')));
    }
    facBox.append(h('button', { class: 'btn sm', style: { marginTop: '6px' }, onclick: () => edit(mdoc, 'Add base faction', () => mdoc.ini.addSection('BaseFaction', facs[facs.length - 1] || vendor || mb, [['faction', (g.factions[0] || {}).nickname || 'li_n_grp'], ['weight', '10']])) }, '+ Faction'));
    left.append(roomBox, facBox);

    // NPC list + editor
    const where = (n) => { const nick = (n.get('nickname') || '').toLowerCase(); const fs = facs.filter(f => f.getAll('npc').some(v => v.toLowerCase() === nick)).map(f => f.get('faction')); const fx = rooms.filter(r => r.findAll('fixture').some(e => (e.values[0] || '').toLowerCase() === nick)).map(r => r.get('nickname')); return { fs, fx }; };
    if (!npcSel || !npcs.some(n => (n.get('nickname') || '').toLowerCase() === npcSel)) npcSel = npcs[0] ? npcs[0].get('nickname').toLowerCase() : null;
    const list = h('div', { class: 'reflist', style: { maxHeight: '220px', overflow: 'auto' } });
    for (const n of npcs) {
      const nick = n.get('nickname') || '', w = where(n), name = textOf(g, n.get('individual_name')).replace(/\n/g, ' · ');
      list.append(h('div', { class: (nick.toLowerCase() === npcSel ? 'sel' : ''), style: { background: nick.toLowerCase() === npcSel ? 'rgba(255,210,80,0.1)' : '' }, onclick: () => { npcSel = nick.toLowerCase(); show('npcs'); } },
        h('b', {}, name || nick), h('span', { style: { color: 'var(--faint)', marginLeft: '6px', fontSize: '11px' } }, `${nick} · ${n.get('affiliation') || ''}${w.fx.length ? ' · fixture: ' + w.fx.join(', ') : ''}${!w.fs.length && !w.fx.length ? ' · unused' : ''}`)));
    }
    right.append(h('div', { class: 'psec' }, h('h3', {}, `Characters (${npcs.length})`, h('span', { class: 'act' },
      h('button', { class: 'btn sm', onclick: () => newNpc(blk, npcs, facs, null) }, '+ New'),
      npcSel ? h('button', { class: 'btn sm', onclick: () => newNpc(blk, npcs, facs, npcs.find(n => n.get('nickname').toLowerCase() === npcSel)) }, 'Duplicate') : null)), list));
    const n = npcs.find(x => (x.get('nickname') || '').toLowerCase() === npcSel);
    if (n) right.append(npcEditor(n, blk, facs, rooms));
  }

  function npcEditor(n, blk, facs, rooms) {
    const box = h('div', { class: 'psec' });
    const nick = n.get('nickname');
    const nameE = n.find('individual_name');
    box.append(h('h3', {}, nick, h('span', { class: 'act' }, h('button', { class: 'btn sm', onclick: async () => {
      const nn = (await promptDialog('Rename character', 'New nickname (references in this base are updated)', nick) || '').trim();
      if (!nn || nn === nick) return;
      edit(mdoc, 'Rename character', () => { const lo = nick.toLowerCase(); n.set('nickname', nn); for (const s of [...facs, ...rooms]) for (const e of s.entries) { if (e.key.toLowerCase() === 'npc' && e.value.toLowerCase() === lo) { e.value = nn; e.raw = null; } if (e.key.toLowerCase() === 'fixture' && (e.values[0] || '').toLowerCase() === lo) setVal(e, 0, nn); } });
      npcSel = nn.toLowerCase(); show('npcs');
    } }, 'Rename…'), h('button', { class: 'btn sm danger', onclick: async () => {
      if (!(await confirmDialog('Delete character', `Delete ${nick} and remove it from this base's factions and rooms?`, 'Delete', true))) return;
      edit(mdoc, 'Delete character', () => { const lo = nick.toLowerCase(); for (const s of [...facs, ...rooms]) for (const e of [...s.entries]) if ((e.key.toLowerCase() === 'npc' && e.value.toLowerCase() === lo) || (e.key.toLowerCase() === 'fixture' && (e.values[0] || '').toLowerCase() === lo)) s.removeEntry(e); mdoc.ini.removeSection(n); });
    } }, 'Delete'))));
    const grid = h('div', { class: 'kv' });
    grid.append(h('div', { class: 'k' }, 'individual_name'), h('div', { class: 'v' }, nameE ? idCell(mdoc, nameE, 0, 'string') : h('button', { class: 'btn sm', onclick: async () => { const gid = await textEditor(app, { kind: 'string', initial: '' }); if (gid) edit(mdoc, 'Set name', () => n.set('individual_name', String(gid))); } }, '+ name')), h('span'));
    grid.append(...kv(mdoc, n, 'affiliation', { list: dl.faction, after: () => h('span', { class: 'hint' }, g.factionName(n.get('affiliation')) || '') }), ...kv(mdoc, n, 'voice', { list: dl.voice }), ...kv(mdoc, n, 'room', { list: dl.room }));
    box.append(grid);
    const app_ = h('details', { style: { marginTop: '6px' } }, h('summary', { style: { cursor: 'pointer', fontSize: '12px', color: 'var(--dim)' } }, 'Appearance'),
      h('div', { class: 'kv' }, ...kv(mdoc, n, 'body', { list: dl.body }), ...kv(mdoc, n, 'head', { list: dl.head }), ...kv(mdoc, n, 'lefthand', { list: dl.left }), ...kv(mdoc, n, 'righthand', { list: dl.right }), ...kv(mdoc, n, 'accessory', { list: dl.acc }), ...kv(mdoc, n, 'base_appr', { list: dl.appr })));
    box.append(app_);
    // 3D preview of the appearance, created when the section is opened
    app_.addEventListener('toggle', async () => {
      if (!app_.open || app_._view) return;
      const { characterView } = await import('./charview.js');
      const v = characterView(app, { height: 300 }); app_._view = v; app_.append(v.el);
      v.set({ body: n.get('body'), head: n.get('head'), leftHand: n.get('lefthand'), rightHand: n.get('righthand'), accessory: n.get('accessory') });
      const mo = new MutationObserver(() => { if (!document.body.contains(app_)) { v.dispose(); mo.disconnect(); } }); mo.observe(document.body, { childList: true, subtree: true });
    });
    const misn = n.find('misn');
    box.append(h('div', { class: 'kv', style: { marginTop: '6px' } }, h('div', { class: 'k' }, 'misn'), h('div', { class: 'v' }, misn ? h('div', { style: { display: 'flex', gap: '4px' } }, cell(mdoc, misn, 0, { list: dl.misn }), cell(mdoc, misn, 1, { w: '60px' }), cell(mdoc, misn, 2, { w: '80px' }), h('button', { class: 'btn sm', onclick: () => edit(mdoc, 'Remove misn', () => n.removeEntry(misn)) }, '×')) : h('button', { class: 'btn sm', onclick: () => edit(mdoc, 'Add misn', () => n.set('misn', 'DestroyMission, 0, 0.112387')) }, '+ offers missions')), h('span')));
    const rep = { label: 'rep', i: 2, w: '46px', num: true };
    box.append(rowsTable(mdoc, n, ['rumor', 'rumor_type2'], [
      { label: 'type', w: '90px', render: (e) => h('select', { style: { fontSize: '12px' }, onchange: (ev) => edit(mdoc, 'Rumor type', () => { e.key = ev.target.value; e.raw = null; }) }, ['rumor', 'rumor_type2'].map(k => h('option', { selected: e.key.toLowerCase() === k }, k))) },
      { label: 'from flag', i: 0, list: dl.flag, w: '1fr' }, { label: 'until flag', i: 1, list: dl.flag, w: '1fr' }, rep, { label: 'text', i: 3, ids: 'infocard', w: '2fr' }],
    { attach: 'rumorknowdb', addKey: 'rumor', addValue: (last) => last ? `${last.values[0]}, ${last.values[1]}, 1, 0` : 'base_0_rank, mission_end, 1, 0', title: 'Rumors' }));
    box.append(rowsTable(mdoc, n, ['bribe'], [{ label: 'faction', i: 0, list: dl.faction, w: '1fr' }, { label: 'price', i: 1, w: '80px', num: true }, { label: 'text', i: 2, ids: 'string', w: '2fr' }], { addKey: 'bribe', addValue: `${n.get('affiliation') || 'li_n_grp'}, 10000, 16100`, title: 'Bribes (reputation hacks)' }));
    box.append(rowsTable(mdoc, n, ['know'], [{ label: 'offer text', i: 0, ids: 'string', w: '1.5fr' }, { label: 'after text', i: 1, ids: 'string', w: '1.5fr' }, { label: 'price', i: 2, w: '70px', num: true }, { label: 'rep', i: 3, w: '46px', num: true }], { attach: 'knowdb', addKey: 'know', addValue: '0, 0, 1000, 1', title: 'Sells information (know)' }));
    return box;
  }

  async function newNpc(blk, npcs, facs, tmpl) {
    const prefix = (blk.mbase.get('nickname') || 'base').toLowerCase().replace(/_base$/, '').replace(/_/g, '');
    let i = npcs.length + 1, nn; const exists = (x) => mdoc.ini.all('GF_NPC').some(s => (s.get('nickname') || '').toLowerCase() === x.toLowerCase());
    do { nn = `${prefix}_npc_${String(i++).padStart(3, '0')}_m`; } while (exists(nn));
    nn = (await promptDialog(tmpl ? 'Duplicate character' : 'New character', 'Nickname (unique in mbases.ini)', nn) || '').trim();
    if (!nn) return; if (exists(nn)) { toast('Nickname already used'); return; }
    edit(mdoc, tmpl ? 'Duplicate character' : 'New character', () => {
      const after = npcs[npcs.length - 1] || [...blk.secs].reverse().find(s => s.is('BaseFaction')) || blk.mbase;
      let s;
      if (tmpl) { s = tmpl.clone(); s.set('nickname', nn); mdoc.ini.insertSection(s, mdoc.ini.sections.indexOf(after) + 1); }
      else s = mdoc.ini.addSection('GF_NPC', after, [['nickname', nn], ['body', 'li_male_guard_body'], ['head', 'li_captain_head'], ['lefthand', 'benchmark_male_hand_left'], ['righthand', 'benchmark_male_hand_right'], ['individual_name', '0'], ['affiliation', (facs[0] && facs[0].get('faction')) || 'li_n_grp'], ['voice', 'rvp101'], ['room', 'bar']]);
      const fac = facs.find(f => (f.get('faction') || '').toLowerCase() === (s.get('affiliation') || '').toLowerCase());
      if (fac) { const last = fac.findAll('npc').pop(); fac.lines.splice(last ? fac.lines.indexOf(last) + 1 : fac.lastEntryIndex() + 1, 0, new IniEntry('npc', nn)); }
    });
    npcSel = nn.toLowerCase(); show('npcs');
  }

  // ------------------------------------------------------------ news tab
  let newsBase = initial.base || '';
  function newsTab() {
    if (!ndoc) { body.append(h('div', { class: 'sev-err' }, 'missions\\news.ini not found')); return; }
    const pick = h('input', { value: newsBase, placeholder: 'all bases', style: { width: '260px' }, onchange: () => { newsBase = pick.value.trim(); show('news'); } }); pick.setAttribute('list', dl.base.id);
    const items = ndoc.ini.all('NewsItem').filter(s => !newsBase || s.getAll('base').some(b => b.toLowerCase() === newsBase.toLowerCase()));
    body.append(h('div', { class: 'topts' }, h('label', { class: 'topt' }, 'Base', pick), h('span', {}, newsBase ? baseLabel(newsBase) : ''), h('span', {}, `${items.length} of ${ndoc.ini.all('NewsItem').length} news items`),
      h('button', { class: 'btn sm primary', style: { marginLeft: 'auto' }, onclick: async () => {
        const hid = await textEditor(app, { kind: 'string', initial: 'Headline' }); if (!hid) return;
        const tid = await textEditor(app, { kind: 'string', initial: 'Story text' }); if (!tid) return;
        const all = ndoc.ini.all('NewsItem');
        edit(ndoc, 'Add news item', () => ndoc.ini.addSection('NewsItem', all[all.length - 1] || null, [['rank', 'mission_end, mission_end'], ['icon', 'world'], ['logo', 'news_scene2'], ['category', String(hid)], ['headline', String(hid)], ['text', String(tid)], ...(newsBase ? [['base', newsBase]] : [])]));
      } }, '+ News item')));
    const listEl = h('div', { style: { maxHeight: 'calc(100vh - 260px)', overflow: 'auto' } });
    for (const s of items.slice(0, 200)) {
      const rank = s.find('rank'), head = s.find('headline'), text = s.find('text');
      const auto = s.entries.find(e => e.key.toLowerCase() === 'autoselect');
      const bases = s.findAll('base');
      const card = h('div', { class: 'psec', style: { border: '1px solid var(--line)', borderRadius: '6px', padding: '8px', margin: '6px 0' } });
      card.append(h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, textOf(g, head && head.value) || '(no headline)'),
        h('div', { style: { fontSize: '12px', color: 'var(--dim)', marginBottom: '6px', whiteSpace: 'pre-wrap', maxHeight: '4.5em', overflow: 'hidden' } }, textOf(g, text && text.value)),
        h('div', { style: { display: 'grid', gridTemplateColumns: '90px 1fr 90px 1fr', gap: '4px 8px', alignItems: 'center', fontSize: '12px' } },
          h('span', { class: 'k' }, 'from flag'), rank ? cell(ndoc, rank, 0, { list: dl.flag }) : h('span'), h('span', { class: 'k' }, 'until flag'), rank ? cell(ndoc, rank, 1, { list: dl.flag }) : h('span'),
          h('span', { class: 'k' }, 'headline'), head ? idCell(ndoc, head, 0, 'string') : h('span'), h('span', { class: 'k' }, 'text'), text ? idCell(ndoc, text, 0, 'string') : h('span'),
          h('span', { class: 'k' }, 'icon'), (() => { const e = s.find('icon'); return e ? cell(ndoc, e, 0, { list: dl.icon }) : h('span'); })(), h('span', { class: 'k' }, 'logo'), (() => { const e = s.find('logo'); return e ? cell(ndoc, e, 0, { list: dl.logo }) : h('span'); })(),
          h('span', { class: 'k' }, 'autoselect'), h('label', {}, h('input', { type: 'checkbox', checked: !!auto, onchange: (ev) => edit(ndoc, 'News autoselect', () => { if (ev.target.checked) s.lines.splice(Math.max(0, s.lines.indexOf(rank) + 1), 0, new IniEntry('autoselect', '', 'autoselect')); else s.removeEntry(auto); }) }), ' show first'), h('span'), h('span')),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '6px', alignItems: 'center' } }, h('span', { style: { fontSize: '11px', color: 'var(--faint)' } }, `bases (${bases.length})`),
          bases.map(e => h('span', { class: 'chip' }, baseLabel(e.value), ' ', h('b', { style: { cursor: 'pointer' }, onclick: () => edit(ndoc, 'Remove news base', () => s.removeEntry(e)) }, '×'))),
          (() => { const add = h('input', { placeholder: '+ base…', style: { width: '150px', fontSize: '12px' }, onchange: (ev) => { const v = ev.target.value.trim(); if (v) edit(ndoc, 'Add news base', () => { const last = bases[bases.length - 1]; s.lines.splice(last ? s.lines.indexOf(last) + 1 : s.lastEntryIndex() + 1, 0, new IniEntry('base', v)); }); } }); add.setAttribute('list', dl.base.id); return add; })(),
          h('button', { class: 'btn sm danger', style: { marginLeft: 'auto' }, onclick: () => edit(ndoc, 'Delete news item', () => ndoc.ini.removeSection(s)) }, 'Delete')));
      listEl.append(card);
    }
    if (items.length > 200) listEl.append(h('div', { class: 'note' }, `Showing 200 of ${items.length}; pick a base to narrow down.`));
    body.append(listEl);
  }

  show(current);
}
