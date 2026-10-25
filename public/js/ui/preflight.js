// Pre-flight check (Tools menu, also offered before Playtest): everything the editor can verify without
// starting the game, in one report — systems, files named in INIs, keys the game never reads, string/infocard
// ids, and the cross references between equipment, goods, markets, loadouts and NPC ships.
// The "IDs & strings" tab lists unused and duplicate resource ids and the next free id per DLL.
import { h, modal, toast, overlay } from './dom.js';
import { api, dataPath } from '../api.js';
import { loadIni } from '../gamedata.js';
import { validateSystem } from '../validate.js';
import { loadIniDocs, keyIsRead, suggestKey } from '../inidocs.js';

const lc = (s) => String(s || '').toLowerCase();
const ORDER = { err: 0, warn: 1, info: 2 };

async function crossRefs(app, add) {
  const dsec = app.game.flIni && app.game.flIni.first('Data');
  const list = (k, def) => { const v = dsec ? dsec.getAll(k) : []; return v.length ? v : def; };
  const load = async (files) => (await Promise.all(files.map(async f => ({ f, d: await loadIni(dataPath(f)) })))).filter(x => x.d);
  const equip = await load(list('equipment', [])), ships = await load(list('ships', ['ships\\shiparch.ini'])), goods = await load(list('goods', ['equipment\\goods.ini']));
  const markets = await load(list('markets', [])), loadouts = await load(list('loadouts', ['solar\\loadouts.ini']));
  const npc = await load(['missions\\npcships.ini']);
  const eqSet = new Set(), shipSet = new Set(), goodSet = new Set(), loadoutSet = new Set();
  for (const { d } of equip) for (const s of d.sections) { const n = s.get('nickname'); if (n) eqSet.add(lc(n)); }
  for (const { d } of ships) for (const s of d.all('Ship')) { const n = s.get('nickname'); if (n) shipSet.add(lc(n)); }
  for (const { d } of goods) for (const s of d.all('Good')) { const n = s.get('nickname'); if (n) goodSet.add(lc(n)); }
  for (const { d } of loadouts) for (const s of d.all('Loadout')) { const n = s.get('nickname'); if (n) loadoutSet.add(lc(n)); }
  const bases = new Set(app.game.bases.map(b => lc(b.nickname)));
  for (const { f, d } of goods) for (const s of d.all('Good')) {
    const n = s.get('nickname'), cat = lc(s.get('category'));
    const eq = s.get('equipment'); if (eq && !eqSet.has(lc(eq))) add('err', 'Goods', `[Good] ${n}: equipment ${eq} does not exist`, { path: 'DATA/' + f });
    if (cat === 'shiphull') { const sh = s.get('ship'); if (sh && !shipSet.has(lc(sh))) add('err', 'Goods', `[Good] ${n}: ship ${sh} does not exist`, { path: 'DATA/' + f }); }
    if (cat === 'ship') { const hull = s.get('hull'); if (hull && !goodSet.has(lc(hull))) add('err', 'Goods', `[Good] ${n}: hull good ${hull} does not exist`, { path: 'DATA/' + f }); }
  }
  for (const { f, d } of markets) for (const s of d.all('BaseGood')) {
    const b = s.get('base'); if (b && !bases.has(lc(b))) add('warn', 'Markets', `[BaseGood] ${b}: base is not in universe.ini`, { path: 'DATA/' + f });
    for (const e of s.entries) if (/^marketgood$/i.test(e.key)) { const g = e.value.split(',')[0].trim(); if (g && !goodSet.has(lc(g))) add('err', 'Markets', `${b}: market good ${g} is not in goods.ini`, { path: 'DATA/' + f }); }
  }
  for (const { f, d } of loadouts) for (const s of d.all('Loadout')) for (const e of s.entries) if (/^(equip|cargo)$/i.test(e.key)) { const q = e.value.split(',')[0].trim(); if (q && !eqSet.has(lc(q))) add('err', 'Loadouts', `[Loadout] ${s.get('nickname')}: ${e.key} ${q} does not exist`, { path: 'DATA/' + f }); }
  for (const { f, d } of npc) for (const s of d.all('NPCShipArch')) { const lo = s.get('loadout'); if (lo && !loadoutSet.has(lc(lo))) add('err', 'NPC ships', `[NPCShipArch] ${s.get('nickname')}: loadout ${lo} does not exist`, { path: 'DATA/' + f }); }
  return { eqSet, shipSet, goodSet };
}

export async function preflight(app, opts = {}) {
  // the checks fetch and parse hundreds of files: keep the 3D view paused meanwhile
  return app.whileBusy ? app.whileBusy(() => runPreflight(app, opts)) : runPreflight(app, opts);
}
async function runPreflight(app, { onDone } = {}) {
  const issues = [];
  const add = (sev, area, msg, at = {}) => issues.push({ sev, area, msg, ...at });
  overlay('Pre-flight: reading every INI…');
  await loadIniDocs();
  const scan = await fetch('/api/iniscan').then(r => r.json()).catch(() => null);
  // 1. systems
  overlay('Pre-flight: systems…');
  const docs = await app.loadAllSystemDocs((i, n) => overlay(`Pre-flight: systems ${i}/${n}…`));
  for (const d of docs) {
    // (missing model / field / background files are covered by the file check below, for every INI)
    for (const i of validateSystem(app, d)) add(i.sev === 'error' ? 'err' : i.sev, 'Systems', `${i.sys}${i.nick ? ' / ' + i.nick : ''}: ${i.msg}`, { sys: i.sys, id: i.id, nick: i.nick });
  }
  if (scan) {
    overlay('Pre-flight: files, keys and ids…');
    // 2. files named in INIs
    const missing = new Map();
    for (const [path, line, sec, key, v] of scan.paths) { const k = lc(v); if (!missing.has(k)) missing.set(k, { v, at: [] }); missing.get(k).at.push({ path, line, sec, key }); }
    for (const m of missing.values()) add(m.at.some(a => /^(da_archetype|material_library)$/i.test(a.key)) ? 'err' : 'warn', 'Files', `${m.v} is named in ${m.at.length} place${m.at.length > 1 ? 's' : ''} but does not exist (first: [${m.at[0].sec}] ${m.at[0].key})`, { path: m.at[0].path, line: m.at[0].line });
    const empty = new Map();
    for (const [path, line, sec, key, v] of scan.empty || []) { const k = lc(v); if (!empty.has(k)) empty.set(k, { v, at: [] }); empty.get(k).at.push({ path, line, sec, key }); }
    for (const m of empty.values()) add('warn', 'Files', `${m.v} is named in ${m.at.length} place${m.at.length > 1 ? 's' : ''} but the file is empty (0 bytes) — nothing can be loaded from it (first: [${m.at[0].sec}] ${m.at[0].key})`, { path: m.at[0].path, line: m.at[0].line });
    // 3. keys the game does not read
    for (const [path, line, n, sec, key] of Object.values(scan.keys)) {
      if (keyIsRead(sec, key) !== false) continue;
      const s = suggestKey(sec, key);
      if (s) add('warn', 'Keys', `[${sec}] ${key} (${n}×): the game does not read this key — typo for “${s}”?`, { path, line });
      else add('info', 'Keys', `[${sec}] ${key} (${n}×): not read by the game`, { path, line });
    }
    // 4. ids
    const g = app.game, nDll = g.resourceDlls.length;
    for (const [id, hits] of Object.entries(scan.ids)) {
      const n = +id; if (!n) continue;
      const known = g.strings.has(n) || g.infocards.has(n);
      if (known) continue;
      const dll = n >>> 16;
      const where = hits[0];
      if (dll >= nDll) add('err', 'IDs', `${n}: DLL index ${dll} — freelancer.ini [Resources] lists only ${nDll} DLLs (${where[2]} in ${where[0]})`, { path: where[0], line: where[1] });
      else if (g.dllDocs[dll]) add(/name|strid/i.test(where[2]) ? 'warn' : 'info', 'IDs', `${n}: no text in ${g.resourceDlls[dll]} (${where[2]}, ${hits.length}${hits.length >= 6 ? '+' : ''} use${hits.length === 1 ? '' : 's'})`, { path: where[0], line: where[1] });
    }
    if (scan.bini.length) add('info', 'Files', `${scan.bini.length} binary INI files could not be read for these checks`);
  }
  // 5. cross references
  overlay('Pre-flight: goods, markets, loadouts…');
  try { await crossRefs(app, add); } catch (e) { add('warn', 'Cross references', 'check failed: ' + e.message); }
  for (const w of app.game.warnings || []) add('warn', 'Game data', w);
  overlay(null);
  issues.sort((a, b) => ORDER[a.sev] - ORDER[b.sev] || a.area.localeCompare(b.area));
  report(app, issues, scan);
  onDone && onDone(issues);
  return issues;
}

function report(app, issues, scan) {
  let area = '', sev = 'warn';
  const list = h('div', { style: { height: 'calc(100vh - 330px)', overflow: 'auto', fontSize: '12px' } });
  const preview = h('pre', { style: { margin: 0, fontSize: '11px', height: 'calc(100vh - 330px)', overflow: 'auto', background: 'var(--well)', padding: '8px', borderRadius: '6px' } }, 'Click an entry to see the INI lines.');
  const areas = [...new Set(issues.map(i => i.area))];
  const counts = ['err', 'warn', 'info'].map(s => issues.filter(i => i.sev === s).length);
  const bar = h('div', { class: 'btnrow', style: { flexWrap: 'wrap' } });
  const tabs = h('div', { class: 'btnrow', style: { margin: '6px 0' } });
  let view = 'issues';
  const body = h('div', {});
  async function show(i) {
    if (i.sys) { if (!app.sys || app.sys.nickname !== i.sys) await app.openSystem(i.sys); const s = i.id != null ? app.sys.byId(i.id) : i.nick ? app.sys.byNick(i.nick) : null; if (s) { app.select(s.id); app.viewport.focus(s.id); } }
    if (!i.path) { preview.textContent = i.msg; return; }
    const b = await api.read(i.path); if (!b) { preview.textContent = 'Cannot read ' + i.path; return; }
    const lines = new TextDecoder('windows-1252').decode(b).split(/\r?\n/), L = i.line || 1;
    preview.textContent = '';
    preview.append(h('div', { style: { color: 'var(--faint)' } }, `${i.path} · line ${L}`));
    for (let k = Math.max(0, L - 12); k < Math.min(lines.length, L + 12); k++) preview.append(h('div', { style: { background: k === L - 1 ? 'rgba(255,200,80,.15)' : '', whiteSpace: 'pre' } }, String(k + 1).padStart(5) + '  ' + lines[k]));
  }
  function renderIssues() {
    bar.innerHTML = '';
    for (const [s, l] of [['err', `errors (${counts[0]})`], ['warn', `+ warnings (${counts[1]})`], ['info', `+ notes (${counts[2]})`]]) bar.append(h('button', { class: 'btn sm' + (sev === s ? ' primary' : ''), onclick: () => { sev = s; renderIssues(); } }, l));
    bar.append(h('select', { onchange: (e) => { area = e.target.value; renderIssues(); } }, h('option', { value: '' }, 'All areas'), areas.map(a => h('option', { value: a, selected: a === area }, `${a} (${issues.filter(i => i.area === a).length})`))));
    bar.append(h('button', { class: 'btn sm', onclick: () => { const csv = 'severity;area;message;file;line\n' + issues.map(i => [i.sev, i.area, i.msg.replace(/;/g, ','), i.path || '', i.line || ''].join(';')).join('\n'); const a = h('a', { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), download: 'preflight.csv' }); document.body.append(a); a.click(); a.remove(); } }, 'Export CSV'));
    list.innerHTML = '';
    const shown = issues.filter(i => ORDER[i.sev] <= ORDER[sev] && (!area || i.area === area));
    if (!shown.length) list.append(h('div', { class: 'empty' }, counts[0] + counts[1] ? 'Nothing at this level.' : 'No problems found ✓'));
    for (const i of shown.slice(0, 3000)) list.append(h('div', { style: { display: 'grid', gridTemplateColumns: '42px 90px 1fr', gap: '6px', padding: '2px 4px', cursor: 'pointer', borderBottom: '1px solid var(--line, #222)' }, onclick: () => show(i) },
      h('span', { class: 'sev-' + (i.sev === 'err' ? 'err' : i.sev), style: { textTransform: 'uppercase', fontSize: '11px' } }, i.sev), h('span', { style: { color: 'var(--faint)' } }, i.area), h('span', {}, i.msg)));
  }
  function renderIds() {
    body.innerHTML = '';
    const g = app.game; const used = new Set(Object.keys(scan ? scan.ids : {}).map(Number));
    const rows = [];
    for (const d of g.dllDocs) {
      if (!d) continue;
      const ids = [...d.strings.keys(), ...d.infocards.keys()].map(k => (d.index << 16) | k);
      const unusedS = [...d.strings.keys()].filter(k => d.strings.get(k) && !used.has((d.index << 16) | k));
      const unusedI = [...d.infocards.keys()].filter(k => d.infocards.get(k) && !used.has((d.index << 16) | k));
      const max = ids.length ? Math.max(...ids.map(x => x & 0xFFFF)) : 0;
      rows.push(h('tr', {}, h('td', {}, d.name || g.resourceDlls[d.index]), h('td', {}, String(d.index)), h('td', {}, String(d.strings.size)), h('td', {}, String(d.infocards.size)), h('td', {}, String(unusedS.length)), h('td', {}, String(unusedI.length)), h('td', {}, String(((d.index << 16) | (max + 1))))));
    }
    // duplicate strings
    const byText = new Map(); for (const [id, t] of g.strings) { const k = t.trim(); if (!k) continue; if (!byText.has(k)) byText.set(k, []); byText.get(k).push(id); }
    const dups = [...byText.entries()].filter(([, ids]) => ids.length > 1).sort((a, b) => b[1].length - a[1].length);
    const missing = issues.filter(i => i.area === 'IDs');
    body.append(
      h('p', { style: { color: 'var(--dim)' } }, 'Ids counted as used when any INI line refers to them. Freelancer.exe itself also uses fixed ids (interface texts, news, mission text), so “unused” here means “no INI refers to it” — check before deleting.'),
      h('table', { class: 'grid', style: { width: '100%' } }, h('tr', {}, ['DLL', 'index', 'strings', 'infocards', 'strings unused by INIs', 'infocards unused by INIs', 'next free id'].map(t => h('th', {}, t))), rows),
      h('h3', {}, `Ids used in INIs without text (${missing.length})`), h('div', {}, missing.slice(0, 300).map(i => h('div', {}, i.msg))),
      h('h3', {}, `Identical strings under several ids (${dups.length})`), h('div', {}, dups.slice(0, 200).map(([t, ids]) => h('div', {}, h('b', {}, t.length > 60 ? t.slice(0, 60) + '…' : t), ' — ', ids.join(', ')))));
  }
  function render() {
    tabs.innerHTML = '';
    for (const [k, l] of [['issues', 'Issues'], ['ids', 'IDs & strings']]) tabs.append(h('button', { class: 'btn sm' + (view === k ? ' primary' : ''), onclick: () => { view = k; render(); } }, l));
    body.innerHTML = '';
    if (view === 'issues') { body.append(bar, h('div', { style: { display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: '10px', marginTop: '6px' } }, list, preview)); renderIssues(); }
    else renderIds();
  }
  const m = modal({ title: `Pre-flight check — ${counts[0]} errors, ${counts[1]} warnings, ${counts[2]} notes`, wide: true, body: h('div', {}, tabs, body), buttons: [{ label: 'Close' }] });
  m.box.classList.add('xwide');
  render();
}
