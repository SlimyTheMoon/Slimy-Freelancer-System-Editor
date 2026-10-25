// Translation tools (Tools menu): every string and infocard of the resource DLLs as a spreadsheet file
// (CSV, UTF-8, opens in Excel / LibreOffice / translation tools), and the translated file read back into the
// DLLs in one undoable step. Columns: id, dll, kind, source, translation.
import { h, modal, toast } from './dom.js';

const csvCell = (s) => /[",\r\n;]/.test(s) ? '"' + String(s).replace(/"/g, '""') + '"' : String(s);
export function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  const sep = (() => { const first = text.split(/\r?\n/, 1)[0] || ''; return (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : ','; })();
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
    if (c === '"') q = true; else if (c === sep) { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => x !== ''));
}

export function translationTools(app) {
  const g = app.game;
  const dlls = g.dllDocs.filter(Boolean);
  const checks = dlls.map(d => ({ d, cb: h('input', { type: 'checkbox', checked: d.editable }) }));
  const kinds = { strings: h('input', { type: 'checkbox', checked: true }), infocards: h('input', { type: 'checkbox', checked: true }) };
  const out = h('div', { style: { fontSize: '12px', marginTop: '8px' } });
  const fileIn = h('input', { type: 'file', accept: '.csv,.txt' });
  const onlyChanged = h('input', { type: 'checkbox', checked: true });

  function exportCsv() {
    const lines = [['id', 'dll', 'kind', 'source', 'translation'].join(',')]; let n = 0;
    for (const { d, cb } of checks) {
      if (!cb.checked) continue;
      const emit = (kind, map) => { for (const [k, v] of [...map].sort((a, b) => a[0] - b[0])) { if (!v) continue; lines.push([(d.index << 16) | k, d.name, kind, v, ''].map(csvCell).join(',')); n++; } };
      if (kinds.strings.checked) emit('string', d.strings);
      if (kinds.infocards.checked) emit('infocard', d.infocards);
    }
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = h('a', { href: URL.createObjectURL(blob), download: 'freelancer-texts.csv' }); document.body.append(a); a.click(); a.remove();
    out.textContent = `Exported ${n} texts. Fill the “translation” column (empty cells keep the original) and import the file again.`;
  }
  async function importCsv() {
    const f = fileIn.files[0]; if (!f) return toast('Choose the translated .csv first');
    const rows = parseCsv((await f.text()).replace(/^﻿/, ''));
    const head = rows.shift().map(x => x.trim().toLowerCase());
    const ci = { id: head.indexOf('id'), kind: head.indexOf('kind'), src: head.indexOf('source'), tr: head.indexOf('translation') >= 0 ? head.indexOf('translation') : head.indexOf('text') };
    if (ci.id < 0 || ci.tr < 0) return toast('The file needs an “id” and a “translation” (or “text”) column');
    const plan = new Map(); let skipped = 0, readOnly = 0, same = 0; const problems = [];
    for (const r of rows) {
      const id = parseInt(r[ci.id]); const tr = (r[ci.tr] || ''); if (!id || !tr.trim()) { skipped++; continue; }
      const d = g.dllFor(id); if (!d) { problems.push(`${id}: no DLL in [Resources] for this id`); continue; }
      if (!d.editable) { readOnly++; continue; }
      const local = id & 0xFFFF;
      const kind = ci.kind >= 0 && /info/i.test(r[ci.kind]) ? 'infocard' : ci.kind >= 0 ? 'string' : (d.infocards.has(local) ? 'infocard' : 'string');
      const map = kind === 'infocard' ? d.infocards : d.strings;
      if (onlyChanged.checked && ci.src >= 0 && map.get(local) != null && map.get(local) !== r[ci.src]) problems.push(`${id}: the text in the DLL changed since the export — imported anyway`);
      if (map.get(local) === tr) { same++; continue; }
      if (kind === 'infocard' && !/^\s*<\?xml|<RDL/i.test(tr) && /^\s*<\?xml|<RDL/i.test(map.get(local) || '')) problems.push(`${id}: infocard translation is not RDL XML — the game will show it as plain text`);
      if (!plan.has(d)) plan.set(d, []);
      plan.get(d).push([kind, local, tr]);
    }
    const docs = [...plan.keys()]; const total = docs.reduce((s, d) => s + plan.get(d).length, 0);
    if (total) app.history.do(`Import translation (${total} texts)`, docs, () => { for (const d of docs) { for (const [kind, local, tr] of plan.get(d)) (kind === 'infocard' ? d.infocards : d.strings).set(local, tr); d.changed(); } });
    out.innerHTML = '';
    out.append(h('div', {}, h('b', {}, `${total} texts imported`), ` into ${docs.map(d => d.name).join(', ') || '—'} · ${same} already identical · ${skipped} empty rows skipped${readOnly ? ` · ${readOnly} in read-only DLLs (resources.dll) skipped` : ''}. Save with Ctrl+S; undo with Ctrl+Z.`),
      problems.length ? h('div', { style: { color: '#ffb366', marginTop: '6px', maxHeight: '200px', overflow: 'auto' } }, problems.slice(0, 200).map(p => h('div', {}, p))) : null);
    app.refreshNames && app.refreshNames();
  }
  modal({ title: 'Translation: export / import texts', wide: true, body: h('div', {},
    h('p', { style: { marginTop: 0, color: 'var(--dim)' } }, 'Export the texts to a CSV file, translate the “translation” column (in a spreadsheet or a translation tool), then import it: the texts are written into the same resource DLLs, so translate a copy of your install. Infocards stay RDL XML — translate the words between the tags.'),
    h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '2px 10px', fontSize: '12px' } }, checks.map(({ d, cb }) => h('label', {}, cb, ` ${d.name} · ${d.strings.size} strings · ${d.infocards.size} infocards${d.editable ? '' : ' (read-only)'}`))),
    h('div', { class: 'btnrow', style: { marginTop: '8px', alignItems: 'center' } }, h('label', {}, kinds.strings, ' strings'), h('label', {}, kinds.infocards, ' infocards'), h('button', { class: 'btn primary', onclick: exportCsv }, 'Export CSV')),
    h('hr'),
    h('div', { class: 'btnrow', style: { alignItems: 'center' } }, fileIn, h('label', { title: 'warn when a text was changed in the DLL after the export' }, onlyChanged, ' check source column'), h('button', { class: 'btn primary', onclick: importCsv }, 'Import translation')),
    out), buttons: [{ label: 'Close' }] });
}
