// Snapshots (File menu): named checkpoints of the whole mod. A snapshot keeps a copy of every file the
// editor has changed or added (compared with the originals in editor_backups), stored in
// <install>/editor_snapshots/<id>/. Compare shows what restoring would change; Restore writes the
// snapshot's files back, puts later-changed files back to their originals and removes files added after it.
// Restoring first takes an automatic "Before restoring …" snapshot, so it can always be undone.
import { h, modal, toast, promptDialog, confirmDialog } from './dom.js';

const j = (r) => r.json().then(x => { if (!r.ok) throw new Error(x.error || r.statusText); return x; });
export const snapApi = {
  list: () => fetch('/api/snapshots').then(j),
  create: (name, note = '') => fetch('/api/snapshot/create', { method: 'POST', body: JSON.stringify({ name, note }) }).then(j),
  diff: (id) => fetch('/api/snapshot/diff?id=' + encodeURIComponent(id)).then(j),
  restore: (id) => fetch('/api/snapshot/restore?id=' + encodeURIComponent(id), { method: 'POST', body: '{}' }).then(j),
  remove: (id) => fetch('/api/snapshot/delete?id=' + encodeURIComponent(id), { method: 'POST', body: '{}' }).then(j),
  rename: (id, name, note) => fetch('/api/snapshot/rename?id=' + encodeURIComponent(id), { method: 'POST', body: JSON.stringify({ name, note }) }).then(j),
};
const when = (iso) => { const d = new Date(iso); return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
const kb = (n) => n == null ? '—' : n < 1024 ? n + ' B' : (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
const STATUS_COL = { 'same': 'var(--faint)', 'changed since': '#ffd34d', 'missing now': '#ff8a65', 'changed after snapshot': '#ffd34d', 'added after snapshot': '#ff8a65', 'deleted after snapshot': '#ff8a65', 'exists now (deleted in snapshot)': '#ff8a65' };

export async function snapshotsDialog(app) {
  const list = h('div', { style: { overflow: 'auto', fontSize: '12px' } });
  const detail = h('div', { style: { overflow: 'auto', fontSize: '12px' } });
  let sel = null, showSame = false;
  async function refresh() {
    let r; try { r = await snapApi.list(); } catch (e) { list.textContent = 'Cannot list snapshots: ' + e.message; return; }
    list.innerHTML = '';
    if (!r.snapshots.length) list.append(h('div', { style: { color: 'var(--faint)', padding: '8px' } }, 'No snapshots yet. Take one before a risky change — it keeps a copy of every file you have changed so far.'));
    for (const s of r.snapshots) {
      list.append(h('div', { style: { padding: '6px 8px', borderRadius: '6px', cursor: 'pointer', marginBottom: '2px', background: sel === s.id ? 'rgba(255,255,255,0.1)' : '' }, onclick: () => { sel = s.id; refresh(); compare(s.id); } },
        h('div', {}, s.auto ? h('span', { style: { color: 'var(--faint)' }, title: 'taken automatically' }, '⟲ ') : '📌 ', h('b', {}, s.name)),
        h('div', { style: { color: 'var(--faint)', fontSize: '11px' } }, `${when(s.created)} · ${s.files.length} file(s)${s.deleted && s.deleted.length ? ` · ${s.deleted.length} deleted` : ''}`),
        s.note ? h('div', { style: { color: 'var(--dim)', fontSize: '11px' } }, s.note) : null));
    }
    list.dataset.dir = r.dir;
  }
  async function compare(id) {
    detail.innerHTML = 'Comparing…';
    let d; try { d = await snapApi.diff(id); } catch (e) { detail.textContent = 'Cannot compare: ' + e.message; return; }
    const acts = d.rows.filter(r => r.action);
    detail.innerHTML = '';
    detail.append(h('h3', { style: { margin: '0 0 4px' } }, d.name), h('div', { style: { color: 'var(--faint)', marginBottom: '6px' } }, `${when(d.created)}${d.auto ? ' · automatic' : ''} · ${d.files.length} file(s) kept`),
      h('div', { class: 'btnrow', style: { marginBottom: '8px', alignItems: 'center' } },
        h('button', { class: 'btn primary', disabled: !acts.length, onclick: () => restore(d, acts) }, acts.length ? `Restore (${acts.length} change${acts.length > 1 ? 's' : ''})` : 'Current files match'),
        h('button', { class: 'btn sm', onclick: async () => { const n = await promptDialog('Rename snapshot', 'Name', d.name); if (n == null) return; const note = await promptDialog('Snapshot note', 'Note (optional)', d.note || ''); await snapApi.rename(id, n, note == null ? d.note : note); refresh(); compare(id); } }, 'Rename…'),
        h('button', { class: 'btn sm danger', onclick: async () => { if (!await confirmDialog('Delete snapshot', `Delete “${d.name}”? The files it kept are removed; your current files are not touched.`, 'Delete', true)) return; await snapApi.remove(id); sel = null; detail.innerHTML = ''; refresh(); } }, 'Delete'),
        h('label', { style: { marginLeft: 'auto' } }, h('input', { type: 'checkbox', checked: showSame, onchange: (e) => { showSame = e.target.checked; compare(id); } }), ' show unchanged')),
      h('div', { style: { color: 'var(--dim)', marginBottom: '6px' } }, acts.length ? 'Restoring would:' : 'Your files are exactly as in this snapshot.'));
    const tbl = h('table', { class: 'grid' }, h('tr', {}, h('th', {}, 'File'), h('th', {}, 'Now'), h('th', {}, 'Restore will'), h('th', {}, 'Size snapshot → now')));
    for (const r of d.rows) {
      if (!showSame && !r.action) continue;
      tbl.append(h('tr', {}, h('td', { style: { fontFamily: 'var(--mono)' } }, r.path), h('td', { style: { color: STATUS_COL[r.status] || '' } }, r.status), h('td', {}, r.action || '—'), h('td', { style: { whiteSpace: 'nowrap' } }, `${kb(r.snapSize ?? r.origSize)} → ${kb(r.curSize)}`)));
    }
    detail.append(tbl);
  }
  async function restore(d, acts) {
    if (app.history.dirty.size && !await confirmDialog('Unsaved changes', 'You have unsaved changes in the editor. Restoring replaces files on disk and reloads the editor, so they would be lost. Continue?', 'Discard and restore', true)) return;
    if (!await confirmDialog('Restore snapshot', `Restore “${d.name}”? ${acts.length} file change(s). A snapshot of the current state is taken first, so you can go back.`, 'Restore')) return;
    try { const r = await snapApi.restore(d.id); toast(`Restored ${r.changed.length} file(s) — reloading`); app.history.dirty.clear(); setTimeout(() => location.reload(), 700); }
    catch (e) { toast('Restore failed: ' + e.message); }
  }
  async function take() {
    const name = await promptDialog('Take snapshot', 'Name (e.g. “before balance pass”)', 'Snapshot ' + new Date().toLocaleDateString()); if (!name) return;
    if (app.history.dirty.size && await confirmDialog('Unsaved changes', 'A snapshot keeps the files on disk. Save your unsaved changes first?', 'Save first')) await app.save();
    try { const s = await snapApi.create(name); toast(`Snapshot “${s.name}”: ${s.files.length} file(s)`); sel = s.id; await refresh(); compare(s.id); }
    catch (e) { toast('Snapshot failed: ' + e.message); }
  }
  modal({ title: 'Snapshots', wide: true, body: h('div', {},
    h('div', { class: 'btnrow', style: { marginBottom: '8px', alignItems: 'center' } }, h('button', { class: 'btn primary', onclick: take }, '📌 Take snapshot'),
      h('span', { style: { color: 'var(--faint)', fontSize: '12px' } }, 'A snapshot keeps every file you have changed or added (Freelancer\'s own unchanged files are not copied). Restore compares first and takes a safety snapshot.')),
    h('div', { style: { display: 'grid', gridTemplateColumns: '300px 1fr', gap: '12px', height: 'calc(100vh - 260px)' } }, list, detail)),
    buttons: [{ label: 'Close' }] }).box.classList.add('xwide');
  await refresh();
}
