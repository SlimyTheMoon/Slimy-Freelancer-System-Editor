// Client for the local editor server. Paths are relative to the Freelancer install root.
export const api = {
  async config() { return (await fetch('/api/config')).json(); },
  async setInstall(dir) {
    const r = await fetch('/api/config', { method: 'POST', body: JSON.stringify({ installDir: dir }) });
    const j = await r.json(); if (!r.ok) throw new Error(j.error || 'failed'); return j;
  },
  async read(path) {
    const r = await fetch('/api/file?p=' + encodeURIComponent(norm(path)));
    if (!r.ok) return null;
    return new Uint8Array(await r.arrayBuffer());
  },
  async exists(path) {
    const r = await fetch('/api/file?p=' + encodeURIComponent(norm(path)), { method: 'HEAD' });
    return r.ok;
  },
  async write(path, bytes) {
    const r = await fetch('/api/file?p=' + encodeURIComponent(norm(path)), { method: 'POST', body: bytes });
    const j = await r.json(); if (!r.ok) throw new Error(j.error || 'write failed'); return j;
  },
  async ls(path) {
    const r = await fetch('/api/ls?p=' + encodeURIComponent(norm(path)));
    return r.ok ? r.json() : [];
  },
  async find(dir, exts = []) {
    const r = await fetch('/api/find?p=' + encodeURIComponent(norm(dir)) + '&ext=' + encodeURIComponent(exts.join(',')));
    return r.ok ? r.json() : [];
  },
  async backups() { return (await fetch('/api/backups')).json(); },
  async changes() { return (await fetch('/api/changes')).json(); },
};
// FL-style data path (relative to DATA, backslashes) -> install-relative
export function dataPath(p) { return 'DATA/' + norm(p); }
export function norm(p) { return String(p).replace(/\\/g, '/').replace(/^\/+/, ''); }
