// Find references / rename everywhere (Edit menu, Ctrl+Shift+F).
// The server scans every text INI under DATA and EXE for lines whose comma-separated values contain the
// nickname (whole values, case-insensitive): where it is defined (nickname = …) and every place that names
// it — loadouts, markets, encounters, missions, NPC ships, system files, universe.ini … Rename rewrites
// all of them in one undoable step (Ctrl+S saves every touched file, originals backed up).
import { h, modal, toast, confirmDialog } from './dom.js';
import { norm } from '../api.js';

const lc = (s) => (s || '').toLowerCase();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// the editor's doc for a file: loaded system doc, universe doc, or a plain INI doc
export async function docFor(app, path) {
  const k = norm(path).toLowerCase();
  for (const s of app.game.systems) { try { if (norm(app.game.systemFilePath(s)).toLowerCase() === k) return await app.loadSystemDoc(s.nickname); } catch { } }
  return app.otherDoc(path);
}
// entries in a doc whose value list contains the token
function hitsIn(doc, token) {
  const t = lc(token), out = [];
  for (const sec of doc.ini.sections) for (const e of sec.entries) if (e.values.some(v => lc(v) === t)) out.push({ sec, e });
  return out;
}

export async function referencesDialog(app, { q = '' } = {}) {
  const input = h('input', { value: q || '', placeholder: 'nickname (object, archetype, equipment, loadout, faction, base, system, trigger …)', style: { flex: 1, fontFamily: 'var(--mono)' }, onkeydown: (e) => { if (e.key === 'Enter') search(); } });
  const list = h('div', { class: 'reflist', style: { overflow: 'auto', height: '100%', fontSize: '12px' } });
  const preview = h('pre', { style: { overflow: 'auto', height: '100%', margin: 0, fontSize: '11px', background: 'rgba(255,255,255,0.03)', padding: '6px', borderRadius: '4px' } });
  const status = h('span', { style: { color: 'var(--faint)', fontSize: '11px' } });
  const renameBtn = h('button', { class: 'btn primary', disabled: true, onclick: () => rename() }, 'Rename everywhere…');
  const body = h('div', {},
    h('div', { style: { display: 'flex', gap: '8px', marginBottom: '8px', alignItems: 'center' } }, input, h('button', { class: 'btn', onclick: () => search() }, 'Find'), renameBtn),
    h('div', { style: { display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: '10px', height: '60vh' } }, list, preview),
    h('div', { style: { marginTop: '6px' } }, status));
  const m = modal({ title: 'Find references / rename everywhere', wide: true, body, buttons: [{ label: 'Close' }] });
  m.box.classList.add('xwide');
  let result = null;

  async function find(token) {
    const r = await fetch('/api/refs?q=' + encodeURIComponent(token)); if (!r.ok) throw new Error('search failed');
    const j = await r.json();
    // unsaved edits are only in memory: add hits from dirty docs the disk scan cannot see
    for (const d of app.history.dirty) {
      if (!d.ini || !d.ini.sections || !d.path) continue;
      const p = norm(d.path).toLowerCase();
      j.refs = j.refs.filter(x => norm(x.path).toLowerCase() !== p); j.defs = j.defs.filter(x => norm(x.path).toLowerCase() !== p);
      const lines = d.ini.text ? d.ini.text('\n').split('\n') : [];
      for (const { sec, e } of hitsIn(d, token)) {
        const ln = lines.findIndex(l => l.trim() === e.text().trim()) + 1;
        (/^nickname$/i.test(e.key) ? j.defs : j.refs).push({ path: d.path, line: ln || 0, section: sec.name, sectionNick: sec.get('nickname') || '', key: e.key, text: e.text().trim(), unsaved: true });
      }
    }
    return j;
  }
  async function search() {
    const t = input.value.trim(); if (!t) return;
    list.innerHTML = ''; preview.textContent = ''; status.textContent = 'Searching all INI files…'; renameBtn.disabled = true;
    try { result = await find(t); } catch (e) { status.textContent = e.message; return; }
    const groups = new Map();
    for (const x of [...result.defs.map(d => ({ ...d, def: true })), ...result.refs]) { if (!groups.has(x.path)) groups.set(x.path, []); groups.get(x.path).push(x); }
    const sorted = [...groups].sort((a, b) => (b[1].some(x => x.def) - a[1].some(x => x.def)) || a[0].localeCompare(b[0]));
    for (const [p, arr] of sorted) {
      list.append(h('div', { style: { padding: '6px 8px 2px', color: 'var(--dim)', fontWeight: 600 } }, p, arr.some(x => x.unsaved) ? h('span', { style: { color: 'var(--warn)', marginLeft: '6px', fontWeight: 400 } }, 'unsaved') : null));
      for (const x of arr) list.append(h('div', { style: { padding: '2px 8px 2px 18px', cursor: 'pointer', display: 'flex', gap: '8px' }, onclick: (ev) => { list.querySelectorAll('.sel').forEach(n => n.classList.remove('sel')); ev.currentTarget.classList.add('sel'); show(x); } },
        h('span', { style: { color: x.def ? '#5fd38d' : 'var(--accent)', width: '74px', flex: '0 0 74px' } }, x.def ? 'defined' : x.key),
        h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, `[${x.section}] ${x.sectionNick}`),
        h('span', { style: { color: 'var(--faint)' } }, x.line ? 'line ' + x.line : '')));
    }
    const n = result.refs.length, d = result.defs.length;
    status.textContent = `${d} definition${d === 1 ? '' : 's'}, ${n} reference${n === 1 ? '' : 's'} in ${groups.size} file${groups.size === 1 ? '' : 's'} (${result.files} INI files searched${result.bini.length ? `; ${result.bini.length} binary INI files not searched` : ''})${result.truncated ? ' — truncated' : ''}.`;
    if (!d && !n) list.append(h('div', { class: 'empty' }, `“${t}” is not used in any INI file.`));
    renameBtn.disabled = !(d + n);
    if (d > 1) status.append(h('div', { class: 'sev-warn' }, `Defined ${d} times — different kinds can share a nickname (e.g. an NPC and a mission ship); rename changes all of them.`));
  }
  async function show(x) {
    preview.textContent = 'Loading…';
    const doc = await docFor(app, x.path);
    if (!doc) { preview.textContent = 'Cannot open ' + x.path; return; }
    const sec = doc.ini.sections.find(s => s.name === x.section && (s.get('nickname') || '') === x.sectionNick) || doc.ini.sections.find(s => s.name === x.section);
    preview.textContent = sec ? sec.text('\n') : '';
    preview.prepend(h('div', { style: { color: 'var(--faint)', marginBottom: '4px' } }, x.path, x.line ? ` · line ${x.line}` : ''));
    const actions = h('div', { style: { display: 'flex', gap: '6px', margin: '6px 0' } });
    if (doc.sys && sec && sec.id != null) actions.append(h('button', { class: 'btn sm', onclick: async () => { m.close(); await app.openSystem(doc.sys.nickname); app.select(sec.id); app.viewport.focus(sec.id); } }, 'Open in system'));
    if (app.revealInIni && sec) actions.append(h('button', { class: 'btn sm', onclick: () => app.revealInIni(sec, doc) }, 'Show in VS Code'));
    preview.prepend(actions);
  }
  async function rename() {
    const old = input.value.trim(); if (!old || !result) return;
    const nn = await new Promise((res) => {
      const inp = h('input', { value: old, style: { width: '100%', fontFamily: 'var(--mono)' } });
      modal({ title: `Rename “${old}” everywhere`, body: h('div', {}, h('p', { style: { marginTop: 0 } }, `${result.defs.length} definition(s) and ${result.refs.length} reference(s) will be changed in one undoable step.`), inp,
        h('p', { style: { color: 'var(--faint)', fontSize: '12px' } }, 'Not changed: save games and binary INI files (they store hashes or are compiled), file and folder names, and texts in the resource DLLs.')),
        buttons: [{ label: 'Cancel', onClick: () => res(null) }, { label: 'Rename', cls: 'primary', onClick: () => res(inp.value.trim()) }] });
    });
    if (!nn || nn === old) return;
    if (!/^[\w.\-#]+$/.test(nn)) { toast('Use letters, digits, _ . - only'); return; }
    const clash = await find(nn);
    if (clash.defs.length && !(await confirmDialog('Name already used', `“${nn}” is already defined in ${clash.defs.map(d => d.path).join(', ')}. Rename anyway (the two will be merged)?`, 'Rename', true))) return;
    if (result.bini.length && result.bini.length < 20) toast(`${result.bini.length} binary INI file(s) were not searched`, 4000);
    const paths = [...new Set([...result.defs, ...result.refs].map(x => x.path))];
    const docs = (await Promise.all(paths.map(p => docFor(app, p)))).filter(Boolean);
    const rx = new RegExp(`(^|,)(\\s*)${esc(old)}(\\s*)(?=,|$)`, 'gi');
    let count = 0;
    app.history.do(`Rename ${old} → ${nn} (${docs.length} files)`, docs, () => {
      for (const d of docs) for (const { e } of hitsIn(d, old)) { const v = e.value.replace(rx, (_, a, b, c) => { count++; return `${a}${b}${nn}${c}`; }); if (v !== e.value) { e.value = v; e.raw = null; } }
    });
    if (docs.includes(app.universeDoc)) app.game.refreshUniverse();
    toast(`Renamed ${count} value(s) in ${docs.length} file(s) — Ctrl+S saves, Ctrl+Z undoes`, 5000);
    if (app.sys) { app.outliner.render(); app.props.render(); }
    input.value = nn; result = null; await search();
  }
  if (q) search(); else input.focus();
}
