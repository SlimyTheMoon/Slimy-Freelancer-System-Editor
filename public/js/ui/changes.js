// Review changes (File → Review changes…): what the editor has changed compared with the files as
// they were before it first touched them (the oldest copy in editor_backups), plus unsaved edits.
// INI files get a line diff, resource DLLs a string/infocard diff, UTF files (.cmp .3db .ale .mat .txm …)
// a node diff. Any saved file can be put back to its original with one click (the current version is
// backed up first, so that is reversible too).
import { h, modal, toast, confirmDialog } from './dom.js';
import { api } from '../api.js';
import { IniDocument } from '../formats/ini.js';
import { readDll, extractText, rdlToText } from '../formats/dll.js';
import { parseUtf } from '../formats/utf.js';
import { diskChanged } from '../host.js';

const dec = new TextDecoder('windows-1252');
const kindOf = (p) => /\.ini$/i.test(p) ? 'ini' : /\.dll$/i.test(p) ? 'dll' : /\.(cmp|3db|ale|mat|txm|sph|vms|utf|anm)$/i.test(p) ? 'utf' : /\.(txt|xml|cfg)$/i.test(p) ? 'text' : 'bin';
const textOf = (u8) => {
  if (!u8) return '';
  if (u8.length >= 4 && u8[0] === 0x42 && u8[1] === 0x49 && u8[2] === 0x4E && u8[3] === 0x49) return dec.decode(IniDocument.fromBytes(u8).toBytes()); // BINI → text
  return dec.decode(u8);
};

// Myers O(ND) line diff → [{op:' '|'-'|'+', a, b, line}]
export function diffLines(A, B) {
  const N = A.length, M = B.length, max = N + M, off = max + 1;
  const V = new Int32Array(2 * max + 3); const trace = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push({ base: off - d - 1, arr: V.slice(off - d - 1, off + d + 2) }); // only the diagonals reachable at this d
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && V[off + k - 1] < V[off + k + 1])) ? V[off + k + 1] : V[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && A[x] === B[y]) { x++; y++; }
      V[off + k] = x;
      if (x >= N && y >= M) { found = true; break; }
    }
    if (d > 4000) return null; // too different to be useful
  }
  // backtrack
  const out = []; let x = N, y = M;
  for (let d = trace.length - 1; d >= 0; d--) {
    const T = trace[d], Vd = (kk) => T.arr[off + kk - T.base], k = x - y;
    const prevK = (k === -d || (k !== d && Vd(k - 1) < Vd(k + 1))) ? k + 1 : k - 1;
    const px = Vd(prevK), py = px - prevK;
    while (x > px && y > py) { x--; y--; out.push({ op: ' ', a: x, b: y, line: A[x] }); }
    if (d > 0) { if (x === px) { y--; out.push({ op: '+', a: x, b: y, line: B[y] }); } else { x--; out.push({ op: '-', a: x, b: y, line: A[x] }); } }
  }
  return out.reverse();
}
function hunks(ops, ctx = 3) {
  const keep = new Array(ops.length).fill(false);
  ops.forEach((o, i) => { if (o.op !== ' ') for (let j = Math.max(0, i - ctx); j <= Math.min(ops.length - 1, i + ctx); j++) keep[j] = true; });
  const out = []; let cur = null;
  ops.forEach((o, i) => { if (!keep[i]) { cur = null; return; } if (!cur) { cur = []; out.push(cur); } cur.push(o); });
  return out;
}
// section name of a line index (for hunk headers)
function sectionAt(lines, i) { for (let j = Math.min(i, lines.length - 1); j >= 0; j--) { const m = /^\s*\[([^\]]+)\]/.exec(lines[j]); if (m) { for (let k = j + 1; k < Math.min(lines.length, j + 6); k++) { const n = /^\s*nickname\s*=\s*([^;\s]+)/i.exec(lines[k]); if (n) return `[${m[1]}] ${n[1]}`; } return `[${m[1]}]`; } } return ''; }

function textDiffView(a, b) {
  const A = textOf(a).split(/\r?\n/), B = textOf(b).split(/\r?\n/);
  const ops = diffLines(A, B);
  if (!ops) return { el: h('div', { class: 'empty' }, 'Too many differences to show line by line.'), added: NaN, removed: NaN };
  const added = ops.filter(o => o.op === '+').length, removed = ops.filter(o => o.op === '-').length;
  const box = h('div', { class: 'diff' });
  for (const hk of hunks(ops)) {
    const first = hk[0];
    box.append(h('div', { class: 'dh' }, `@@ line ${first.a + 1} → ${first.b + 1}  ${sectionAt(B, first.b) || sectionAt(A, first.a)}`));
    for (const o of hk) box.append(h('div', { class: 'd' + (o.op === '+' ? 'a' : o.op === '-' ? 'r' : 'c') }, h('span', { class: 'dn' }, o.op === '+' ? '' : String(o.a + 1)), h('span', { class: 'dn' }, o.op === '-' ? '' : String(o.b + 1)), (o.op === ' ' ? '  ' : o.op + ' ') + o.line));
  }
  if (!added && !removed) box.append(h('div', { class: 'empty' }, 'No line differences (only line endings or encoding differ).'));
  return { el: box, added, removed };
}
function dllDiffView(a, b) {
  const ta = a ? extractText(readDll(a).tree) : { strings: new Map(), infocards: new Map() };
  const tb = b ? extractText(readDll(b).tree) : { strings: new Map(), infocards: new Map() };
  const rows = []; let added = 0, removed = 0;
  for (const kind of ['strings', 'infocards']) {
    const A = ta[kind], B = tb[kind]; const ids = [...new Set([...A.keys(), ...B.keys()])].sort((x, y) => x - y);
    for (const id of ids) {
      const va = A.get(id), vb = B.get(id); if (va === vb) continue;
      const t = (v) => v == null ? '' : kind === 'infocards' ? rdlToText(v) : v;
      if (va == null) added++; else if (vb == null) removed++; else { added++; removed++; }
      rows.push(h('div', { class: 'dh' }, `${kind === 'strings' ? 'string' : 'infocard'} local id ${id}${va == null ? ' (new)' : vb == null ? ' (removed)' : ''}`));
      if (va != null) rows.push(h('div', { class: 'dr' }, '- ' + t(va)));
      if (vb != null) rows.push(h('div', { class: 'da' }, '+ ' + t(vb)));
    }
  }
  return { el: h('div', { class: 'diff' }, ...(rows.length ? rows : [h('div', { class: 'empty' }, 'No string or infocard differences.')])), added, removed };
}
function utfDiffView(a, b) {
  const flat = (u8) => { const m = new Map(); if (!u8) return m; const walk = (n, p) => { const q = p ? p + '/' + n.name : n.name; if (n.isLeaf) m.set(q.toLowerCase(), { q, d: n.data }); else { m.set(q.toLowerCase() + '/', { q: q + '/', d: null }); n.children.forEach(c => walk(c, q)); } }; walk(parseUtf(u8), ''); return m; };
  const A = flat(a), B = flat(b); const rows = []; let added = 0, removed = 0;
  const same = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
  const keys = [...new Set([...A.keys(), ...B.keys()])].sort();
  for (const k of keys) {
    const x = A.get(k), y = B.get(k);
    if (x && y) { if (x.d && y.d && !same(x.d, y.d)) { added++; removed++; rows.push(h('div', { class: 'dc' }, `~ ${y.q}  (${x.d.length} → ${y.d.length} bytes)`)); } }
    else if (y) { added++; rows.push(h('div', { class: 'da' }, `+ ${y.q}${y.d ? `  (${y.d.length} bytes)` : ''}`)); }
    else { removed++; rows.push(h('div', { class: 'dr' }, `- ${x.q}`)); }
  }
  return { el: h('div', { class: 'diff' }, ...(rows.length ? rows : [h('div', { class: 'empty' }, 'Same node tree and values (the file layout differs only).')])), added, removed };
}
function viewFor(path, a, b) {
  const k = kindOf(path);
  try {
    if (k === 'ini' || k === 'text') return textDiffView(a, b);
    if (k === 'dll') return dllDiffView(a, b);
    if (k === 'utf') return utfDiffView(a, b);
  } catch (e) { return { el: h('div', { class: 'sev-err' }, 'Could not compare: ' + e.message), added: NaN, removed: NaN }; }
  return { el: h('div', { class: 'empty' }, `Binary file: ${a ? a.length : 0} → ${b ? b.length : 0} bytes.`), added: NaN, removed: NaN };
}

export async function reviewChanges(app) {
  const list = h('div', { class: 'reflist', style: { overflow: 'auto', height: '100%', fontSize: '12px' } });
  const detail = h('div', { style: { overflow: 'auto', height: '100%' } });
  const head = h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '6px', minHeight: '28px' } });
  const showSame = h('input', { type: 'checkbox', onchange: () => renderList() });
  const body = h('div', {},
    h('div', { style: { color: 'var(--dim)', fontSize: '12px', marginBottom: '8px' } }, 'Saved files are compared with the file as it was before the editor first changed it (the oldest copy in editor_backups). Unsaved edits are compared with the file on disk.'),
    h('div', { style: { display: 'grid', gridTemplateColumns: '330px 1fr', gap: '10px', height: '64vh' } },
      h('div', { style: { display: 'flex', flexDirection: 'column', minHeight: 0 } }, list, h('label', { style: { fontSize: '11px', color: 'var(--faint)', marginTop: '4px' } }, showSame, ' also list files that are back to their original')),
      h('div', { style: { display: 'flex', flexDirection: 'column', minHeight: 0 } }, head, detail)));
  const m = modal({ title: 'Review changes', wide: true, body, buttons: [{ label: 'Close' }, { label: 'Copy summary', onClick: () => { copySummary(); return false; } }] });
  m.box.classList.add('xwide');
  let items = [], sel = null;
  const stats = new Map();

  async function load() {
    const r = await api.changes();
    const unsaved = [...app.history.dirty].filter(d => d.path).map(d => ({ path: d.path.replace(/^\/+/, ''), unsaved: true, doc: d }));
    items = [...unsaved, ...r.files.map(f => ({ ...f }))];
    renderList();
    if (!sel) { const first = items.find(i => i.unsaved || !i.same); if (first) select(first); else detail.replaceChildren(h('div', { class: 'empty' }, 'Nothing has been changed yet.')); }
  }
  const label = (it) => it.unsaved ? 'unsaved' : it.created ? 'new file' : it.same ? 'original' : it.curSize == null ? 'deleted' : 'changed';
  function renderList() {
    list.innerHTML = '';
    const groups = [['Unsaved edits', items.filter(i => i.unsaved)], ['Saved changes', items.filter(i => !i.unsaved && (!i.same || showSame.checked))]];
    for (const [title, arr] of groups) {
      list.append(h('div', { style: { padding: '6px 8px 2px', color: 'var(--faint)', fontSize: '11px', textTransform: 'uppercase' } }, `${title} (${arr.length})`));
      if (!arr.length) list.append(h('div', { style: { padding: '2px 8px', color: 'var(--faint)' } }, 'none'));
      for (const it of arr) {
        const st = stats.get(it);
        list.append(h('div', { class: sel === it ? 'sel' : '', style: { padding: '3px 8px', cursor: 'pointer', display: 'flex', gap: '6px' }, title: it.path, onclick: () => select(it) },
          h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl', textAlign: 'left' } }, it.path),
          st && !isNaN(st.added) ? h('span', { style: { fontFamily: 'var(--mono)', fontSize: '10px' } }, h('span', { style: { color: '#5fd38d' } }, '+' + st.added), ' ', h('span', { style: { color: '#e86a6a' } }, '−' + st.removed)) : null,
          h('span', { style: { fontSize: '10px', color: it.unsaved ? 'var(--warn)' : it.same ? 'var(--faint)' : 'var(--accent)' } }, label(it))));
      }
    }
  }
  async function select(it) {
    sel = it; renderList();
    head.replaceChildren(h('b', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, it.path));
    detail.replaceChildren(h('div', { class: 'empty' }, 'Comparing…'));
    let a, b;
    if (it.unsaved) { a = await api.read(it.path); b = it.doc.ini.toBytes(); }
    else { a = it.backup ? await api.read(it.backup) : null; b = it.curSize != null ? await api.read(it.path) : null; }
    if (sel !== it) return;
    const v = viewFor(it.path, a, b); stats.set(it, v); renderList();
    if (!it.unsaved && it.backup && !it.same) head.append(h('button', { class: 'btn', title: 'Write the original back (the current file is backed up first)', onclick: () => restore(it, a) }, 'Restore original'));
    if (!it.unsaved && it.backup) head.append(h('span', { style: { fontSize: '11px', color: 'var(--faint)' } }, `original from ${it.session}`));
    if (it.created) head.append(h('span', { style: { fontSize: '11px', color: 'var(--faint)' } }, `created ${it.session}`));
    detail.replaceChildren(v.el);
  }
  async function restore(it, orig) {
    if (app.history.dirty.size && [...app.history.dirty].some(d => d.path && d.path.toLowerCase().replace(/^\/+/, '') === it.path.toLowerCase())) { toast('This file has unsaved edits — save or undo them first'); return; }
    if (!(await confirmDialog('Restore original?', `${it.path} will be replaced by its original from ${it.session}. The current version is backed up first.`, 'Restore', true))) return;
    try { await api.write(it.path, orig); await diskChanged(app, it.path, 'restored to its original'); if (/\.dll$/i.test(it.path)) toast('Restored — restart the editor to see the original texts', 5000); sel = null; stats.clear(); await load(); }
    catch (e) { toast('Restore failed: ' + e.message, 5000); }
  }
  async function copySummary() {
    for (const it of items) if (!stats.has(it) && (it.unsaved || !it.same)) {
      try { const a = it.unsaved ? await api.read(it.path) : it.backup ? await api.read(it.backup) : null; const b = it.unsaved ? it.doc.ini.toBytes() : it.curSize != null ? await api.read(it.path) : null; stats.set(it, viewFor(it.path, a, b)); } catch { }
    }
    const lines = items.filter(i => i.unsaved || !i.same).map(i => { const s = stats.get(i); return `${label(i).padEnd(8)} ${i.path}${s && !isNaN(s.added) ? `  (+${s.added} −${s.removed})` : ''}`; });
    const text = `Freelancer System Editor — changes (${new Date().toLocaleString()})\n` + (lines.join('\n') || 'no changes');
    try { await navigator.clipboard.writeText(text); toast('Summary copied'); } catch { toast('Clipboard not available'); }
    renderList();
  }
  await load();
}
