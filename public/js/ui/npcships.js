// NPC ship editor: [NPCShipArch] entries in MISSIONS\npcships.ini and the per-mission files named by
// [Mission] npc_ship_file. Each entry ties a ship hull, loadout, pilot, difficulty level, AI state graph
// and npc_class tags together; mission [NPC] sections pick one with npc_ship_arch.
// All edits go through the shared undo history (Ctrl+Z works in the dialog, Ctrl+S saves).
import { h, modal, toast, promptDialog, confirmDialog } from './dom.js';
import { IniSection, IniEntry } from '../formats/ini.js';
import { api, dataPath } from '../api.js';
import { loadIni } from '../gamedata.js';
import { searchPicker, pickerFor } from './picker.js';
import { modelViewer } from './modelview.js';

const GRAPHS = ['FIGHTER', 'TRANSPORT', 'GUNBOAT', 'CRUISER', 'FREIGHTER', 'NOTHING'];
const lc = (s) => (s || '').toLowerCase();
const KEYS = ['nickname', 'loadout', 'level', 'ship_archetype', 'pilot', 'state_graph', 'npc_class'];

export async function npcShipEditor(app, { file = null, select = null } = {}) {
  const g = app.game;
  // files: global + every mission's npc_ship_file
  const files = ['DATA/MISSIONS/npcships.ini'];
  // one directory listing per mission folder, all at once (was one after another)
  const msnDirs = (await api.ls('DATA/MISSIONS')).filter(d => d.dir), msnLists = await Promise.all(msnDirs.map(d => api.ls('DATA/MISSIONS/' + d.name)));
  msnDirs.forEach((d, i) => { for (const f of msnLists[i]) if (!f.dir && /^npcships\.ini$/i.test(f.name)) files.push(`DATA/MISSIONS/${d.name}/${f.name}`); });
  file = (file && files.find(f => lc(f) === lc(file.replace(/\\/g, '/')))) || files[0];
  // ships (shiparch) with in-game names and models
  const ships = new Map();
  const shipFiles = (() => { const s = g.flIni && g.flIni.first('Data'); const v = s ? s.getAll('ships') : []; return v.length ? v : ['ships\\shiparch.ini']; })();
  const shipDocs = await Promise.all(shipFiles.map(f => loadIni(dataPath(f))));
  for (const d of shipDocs) { if (d) for (const s of d.all('Ship')) { const n = s.get('nickname'); if (n) ships.set(lc(n), { nickname: n, name: g.name(s.get('ids_name')) || '', da: s.get('DA_archetype'), matLibs: s.getAll('material_library'), type: s.get('type') || '' }); } }
  const loadouts = new Set(g.loadouts.map(lc));
  // which mission [NPC] sections use which arch (for "used by" and rename)
  const users = new Map();
  const msnPaths = []; msnDirs.forEach((d, i) => { for (const f of msnLists[i]) if (!f.dir && /^m\d+[a-z]?\.ini$/i.test(f.name)) msnPaths.push(`DATA/MISSIONS/${d.name}/${f.name}`); });
  const msnDocs = await Promise.all(msnPaths.map(p => loadIni(p)));
  for (let mi = 0; mi < msnPaths.length; mi++) {
    const p = msnPaths[mi], doc = msnDocs[mi]; if (!doc) continue;
    for (const s of doc.all('NPC')) { const a = lc(s.get('npc_ship_arch')); if (!a) continue; if (!users.has(a)) users.set(a, []); users.get(a).push({ path: p, npc: s.get('nickname') }); }
  }

  let doc, sel = null, q = '';
  const viewer = modelViewer(app, { height: '210px' });
  const fileSel = h('select', { onchange: async (e) => { file = e.target.value; await open(); } }, ...files.map(f => h('option', { value: f, selected: f === file }, f.replace('DATA/MISSIONS/', ''))));
  const list = h('div', { class: 'reflist', style: { overflow: 'auto', height: '100%', fontSize: '12px' } });
  const form = h('div', { style: { overflow: 'auto', height: '100%', fontSize: '12px' } });
  const body = h('div', {},
    h('div', { style: { display: 'flex', gap: '8px', marginBottom: '8px', alignItems: 'center' } }, fileSel,
      h('input', { placeholder: 'Search nickname, ship, loadout, class…', style: { flex: 1 }, oninput: (e) => { q = lc(e.target.value); renderList(); } }),
      h('button', { class: 'btn', onclick: () => add() }, '+ NPC ship')),
    h('div', { style: { display: 'grid', gridTemplateColumns: '360px 1fr', gap: '10px', height: '64vh' } }, list, form));
  const m = modal({ title: 'NPC ships', wide: true, body, onClose: () => { viewer.dispose(); app.dialogRefreshers.delete(refresh); }, buttons: [{ label: 'Close' }, { label: 'Save all (Ctrl+S)', cls: 'primary', onClick: () => { app.save(); return false; } }] });
  m.box.classList.add('xwide');
  const refresh = (e) => { if (doc && e.docs.includes(doc)) { if (sel && !doc.ini.sections.includes(sel)) sel = doc.ini.sections.find(s => s.is('NPCShipArch') && lc(s.get('nickname')) === lc(selNick)) || null; renderList(); renderForm(); } };
  app.dialogRefreshers.add(refresh);
  let selNick = '';
  const edit = (label, fn) => { app.history.do(label, [doc], fn); renderList(); renderForm(); };
  const archs = () => doc.ini.all('NPCShipArch');

  function problems(s) {
    const p = [];
    const ship = ships.get(lc(s.get('ship_archetype')));
    if (!s.get('ship_archetype')) p.push('no ship_archetype'); else if (!ship) p.push(`unknown ship “${s.get('ship_archetype')}”`);
    if (!s.get('loadout')) p.push('no loadout'); else if (!loadouts.has(lc(s.get('loadout')))) p.push(`unknown loadout “${s.get('loadout')}”`);
    if (!/^d\d+$/i.test(s.get('level') || '')) p.push('level should be d1…d19');
    if (!s.get('state_graph')) p.push('no state_graph');
    if (!s.get('npc_class')) p.push('no npc_class');
    return p;
  }
  function renderList() {
    list.innerHTML = '';
    const all = archs();
    let shown = 0;
    for (const s of all) {
      const n = s.get('nickname') || '(no nickname)', ship = ships.get(lc(s.get('ship_archetype')));
      const hay = lc([n, s.get('ship_archetype'), ship && ship.name, s.get('loadout'), s.get('npc_class'), s.get('level')].join(' '));
      if (q && !q.split(/\s+/).every(w => hay.includes(w))) continue;
      shown++;
      const pr = problems(s), u = users.get(lc(n));
      list.append(h('div', { class: sel === s ? 'sel' : '', style: { padding: '3px 8px', cursor: 'pointer' }, onclick: () => { sel = s; selNick = n; renderList(); renderForm(); } },
        h('div', { style: { display: 'flex', gap: '6px' } }, h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, n),
          pr.length ? h('span', { class: 'sev-err', title: pr.join('\n') }, '⚠') : null, h('span', { style: { color: 'var(--faint)', fontSize: '11px' } }, s.get('level') || '')),
        h('div', { style: { color: 'var(--faint)', fontSize: '11px' } }, `${ship ? ship.name || ship.nickname : s.get('ship_archetype') || '?'} · ${s.get('state_graph') || ''}${u ? ` · used by ${u.length}` : ''}`)));
    }
    list.prepend(h('div', { style: { padding: '4px 8px', color: 'var(--faint)', fontSize: '11px' } }, `${shown} of ${all.length} entries`));
  }
  function row(label, input, extra = null) { return h('div', { style: { display: 'grid', gridTemplateColumns: '120px 1fr auto', gap: '6px', alignItems: 'center', margin: '4px 0' } }, h('span', { style: { color: 'var(--dim)' } }, label), input, extra); }
  function renderForm() {
    form.innerHTML = '';
    if (!sel || !doc.ini.sections.includes(sel)) { sel = null; form.append(h('div', { class: 'empty' }, 'Select an NPC ship on the left.')); viewer.load(null); return; }
    const s = sel, nick = s.get('nickname') || '';
    const set = (k, v) => edit(`${k} ${nick}`, () => { if (v === '' || v == null) s.remove(k); else s.set(k, v); });
    const text = (k) => h('input', { value: s.get(k) || '', style: { width: '100%' }, onchange: (e) => set(k, e.target.value.trim()) });
    const pick = (k, getCfg) => h('button', { class: 'btn', title: 'Pick…', onclick: async () => { const cfg = await getCfg(); const v = await searchPicker(app, { ...cfg, current: s.get(k) || '' }); if (v) set(k, v); } }, '…');
    const ship = ships.get(lc(s.get('ship_archetype')));
    form.append(h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', marginBottom: '6px' } },
      h('h3', { style: { margin: 0, flex: 1 } }, nick),
      h('button', { class: 'btn', onclick: () => rename(s) }, 'Rename'), h('button', { class: 'btn', onclick: () => duplicate(s) }, 'Duplicate'), h('button', { class: 'btn danger', onclick: () => remove(s) }, 'Delete')));
    form.append(viewer.el);
    form.append(
      row('ship_archetype', text('ship_archetype'), pick('ship_archetype', async () => ({ title: 'Ship', items: [...ships.values()].map(x => ({ value: x.nickname, label: x.name, sub: x.type })) }))),
      ship ? h('div', { style: { color: 'var(--faint)', margin: '-2px 0 4px 126px' } }, `${ship.name || ''} ${ship.type ? '· ' + ship.type : ''}`) : null,
      row('loadout', text('loadout'), pick('loadout', () => pickerFor(app, 'loadout', s))),
      row('level', h('select', { onchange: (e) => set('level', e.target.value) }, ...Array.from({ length: 19 }, (_, i) => `d${i + 1}`).concat(/^d\d+$/i.test(s.get('level') || '') && parseInt((s.get('level') || 'd0').slice(1)) > 19 ? [s.get('level')] : []).map(v => h('option', { value: v, selected: lc(v) === lc(s.get('level')) }, v)))),
      row('pilot', text('pilot'), pick('pilot', () => pickerFor(app, 'pilot', s, archs().map(x => x.get('pilot')).filter(Boolean)))),
      row('state_graph', h('select', { onchange: (e) => set('state_graph', e.target.value) }, ...[...new Set([...GRAPHS, s.get('state_graph') || ''])].filter(Boolean).map(v => h('option', { value: v, selected: v === s.get('state_graph') }, v)))),
      row('npc_class', classEditor(s)));
    const pr = problems(s);
    if (pr.length) form.append(h('div', { class: 'sev-err', style: { margin: '6px 0' } }, pr.join(' · ')));
    const other = s.entries.filter(e => !KEYS.includes(lc(e.key)));
    if (other.length) form.append(h('div', { class: 'psec' }, h('h3', {}, 'Other keys'), ...other.map(e => row(e.key, h('input', { value: e.value, style: { width: '100%' }, onchange: (ev) => edit(`Edit ${e.key}`, () => { e.value = ev.target.value; e.raw = null; }) })))));
    const u = users.get(lc(nick)) || [];
    form.append(h('div', { class: 'psec' }, h('h3', {}, 'Used by mission NPCs'), u.length ? h('div', {}, ...u.map(x => h('div', {}, `${x.path.replace('DATA/MISSIONS/', '')} · [NPC] ${x.npc}`))) : h('div', { class: 'empty' }, file.endsWith('MISSIONS/npcships.ini') ? 'No mission [NPC] names it directly (the global list is also used by encounters through npc_class).' : 'No mission [NPC] uses it.')));
    if (ship && ship.da) viewer.load(dataPath(ship.da), ship.matLibs.map(dataPath), { showHardpoints: false }); else viewer.load(null);
  }
  // npc_class = lawful|unlawful, class tags…, levels: shown as removable chips
  function classEditor(s) {
    const vals = (s.get('npc_class') || '').split(',').map(x => x.trim()).filter(Boolean);
    const write = (arr) => edit('npc_class', () => s.set('npc_class', arr.join(', ')));
    const all = new Set(); for (const x of archs()) for (const t of (x.get('npc_class') || '').split(',')) if (t.trim()) all.add(t.trim());
    const dl = 'npccls' + Math.random().toString(36).slice(2);
    const add = h('input', { list: dl, placeholder: '+ tag', style: { width: '110px' }, onchange: (e) => { const v = e.target.value.trim(); if (v && !vals.includes(v)) write([...vals, v]); } });
    return h('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap', alignItems: 'center' } },
      ...vals.map((v, i) => h('span', { style: { background: 'var(--panel2)', border: '1px solid var(--line2)', borderRadius: '10px', padding: '0 4px 0 8px', fontSize: '11px' } }, v, h('button', { class: 'btn sm', style: { padding: '0 4px', marginLeft: '2px', border: 0, background: 'none' }, onclick: () => write(vals.filter((_, j) => j !== i)) }, '×'))),
      add, h('datalist', { id: dl }, ...[...all].sort().map(v => h('option', { value: v }))));
  }
  const unique = (b) => { let n = b, i = 2; const have = new Set(archs().map(x => lc(x.get('nickname')))); while (have.has(lc(n))) n = `${b}_${i++}`; return n; };
  async function add() {
    const n = await promptDialog('New NPC ship', 'Nickname', unique('npc_ship_new')); if (!n) return;
    const s = new IniSection('NPCShipArch');
    const tpl = sel || archs()[0];
    for (const k of KEYS) s.lines.push(new IniEntry(k, k === 'nickname' ? n : (tpl && tpl.get(k)) || (k === 'level' ? 'd1' : k === 'state_graph' ? 'FIGHTER' : '')));
    s.lines.push({ type: 'other', raw: '' });
    edit(`New NPC ship ${n}`, () => doc.ini.sections.push(s)); sel = s; selNick = n; renderList(); renderForm();
  }
  async function duplicate(s0) {
    const n = await promptDialog('Duplicate', 'Nickname of the copy', unique(s0.get('nickname') + '_copy')); if (!n) return;
    const c = s0.clone(); c.set('nickname', n);
    edit(`Duplicate ${s0.get('nickname')}`, () => doc.ini.sections.splice(doc.ini.sections.indexOf(s0) + 1, 0, c)); sel = c; selNick = n; renderList(); renderForm();
  }
  async function remove(s) {
    const n = s.get('nickname'), u = users.get(lc(n)) || [];
    if (!(await confirmDialog(`Delete ${n}?`, u.length ? `Still used by ${u.length} mission NPC(s): ${u.slice(0, 5).map(x => x.npc).join(', ')}` : 'No mission NPC uses it.', 'Delete', true))) return;
    edit(`Delete ${n}`, () => { doc.ini.sections = doc.ini.sections.filter(x => x !== s); }); sel = null; renderList(); renderForm();
  }
  async function rename(s) {
    const old = s.get('nickname'); const n = await promptDialog('Rename NPC ship', 'New nickname (mission NPCs using it are updated)', old); if (!n || n === old) return;
    if (archs().some(x => x !== s && lc(x.get('nickname')) === lc(n))) { toast('That nickname exists'); return; }
    const u = users.get(lc(old)) || [];
    const docs = [doc]; const mdocs = [];
    for (const p of [...new Set(u.map(x => x.path))]) { const d = await app.otherDoc(p); if (d) { docs.push(d); mdocs.push(d); } }
    app.history.do(`Rename ${old} → ${n}`, docs, () => {
      s.set('nickname', n);
      for (const d of mdocs) for (const npc of d.ini.all('NPC')) { const e = npc.find('npc_ship_arch'); if (e && lc(e.value) === lc(old)) { e.value = n; e.raw = null; } }
    });
    if (u.length) { users.set(lc(n), u); users.delete(lc(old)); }
    selNick = n; renderList(); renderForm();
  }
  async function open() {
    doc = await app.otherDoc(file); if (!doc) { toast('Cannot read ' + file); return; }
    sel = (select && archs().find(s => lc(s.get('nickname')) === lc(select))) || null; selNick = sel ? sel.get('nickname') : '';
    renderList(); renderForm();
  }
  await open();
}
