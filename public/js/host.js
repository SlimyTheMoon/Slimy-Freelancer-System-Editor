// Bridge to the VS Code extension. When the editor runs inside the extension's webview it is loaded
// with ?host=vscode in an iframe; messages go via window.parent (the webview), which relays them to
// the extension host and back. In a normal browser tab none of this is active.
import { norm } from './api.js';
import { toast } from './ui/dom.js';
import { kindOf } from './system.js';

const params = new URLSearchParams(location.search);
export const inVSCode = params.get('host') === 'vscode';
export const startSystem = params.get('system') || null;

export function post(msg) { if (inVSCode) window.parent.postMessage({ fled: true, ...msg }, '*'); }

// 1-based line of a section header in its file (preamble + previous sections)
export function sectionLine(ini, sec) {
  let line = (ini.preamble ? ini.preamble.length : 0) + 1;
  for (const s of ini.sections) { if (s === sec) return line; line += 1 + s.lines.length; }
  return 1;
}

export function installHost(app) {
  if (!inVSCode) return;
  const recentSaves = new Map(); // lower path -> time (ignore our own writes when VS Code reports changes)
  const origSave = app.save.bind(app);
  app.save = async () => { for (const d of app.history.dirty) recentSaves.set(norm(d.path).toLowerCase(), Date.now()); await origSave(); };
  const origUpd = app.updateDocState.bind(app);
  app.updateDocState = () => { origUpd(); post({ type: 'dirty', n: app.history.dirty.size }); };

  // show the selected entity (or the system file) in VS Code's text editor
  app.revealInIni = (sec = app.selected()[0]) => {
    const doc = app.sys; if (!doc) return;
    post({ type: 'reveal', rel: norm(doc.path), line: sec ? sectionLine(doc.ini, sec) : 1, nickname: sec ? sec.get('nickname') : '' });
  };

  window.addEventListener('message', async (e) => {
    const m = e.data; if (!m || !m.fledExt) return;
    if (m.type === 'openSystem' && m.system) {
      const sys = app.game.findSystem(m.system); if (sys) await app.openSystem(sys.nickname); else toast(`Unknown system ${m.system}`);
    }
    if (m.type === 'openFile' && m.rel) {
      // a system INI → open that system; otherwise say what it is
      const rel = norm(m.rel).toLowerCase();
      const sys = app.game.systems.find(s => norm(app.game.systemFilePath(s)).toLowerCase() === rel);
      if (sys) { await app.openSystem(sys.nickname); return; }
      toast(`${m.rel.split('/').pop()} is not a system file listed in universe.ini`);
    }
    if (m.type === 'select' && m.nickname && app.sys) { const s = app.sys.byNick(m.nickname); if (s && kindOf(s)) { app.select(s.id); app.viewport.focus(s.id); } }
    if (m.type === 'fileChanged' && m.rel) {
      const rel = norm(m.rel).toLowerCase();
      const t = recentSaves.get(rel); if (t && Date.now() - t < 5000) return; // our own save
      await diskChanged(app, m.rel, 'changed in VS Code');
    }
  });
  post({ type: 'ready' });
}

// A file changed on disk behind the editor's back (VS Code edit, "Restore original"):
// drop the cached copy so it is re-read, reload the open system, warn about unsaved edits.
export async function diskChanged(app, relPath, why = 'changed on disk') {
  const rel = norm(relPath).toLowerCase(), name = relPath.split('/').pop();
  if (/\.(cmp|3db|mat|txm|sph|ale|vms)$/i.test(rel)) { app.rm && app.rm.invalidate && app.rm.invalidate(relPath); if (app.fx) app.fx.libs.clear(); return; }
  const sysDoc = [...app.systemDocs.values()].find(d => norm(d.path).toLowerCase() === rel);
  const other = [...app.otherDocs.entries()].find(([, d]) => norm(d.path).toLowerCase() === rel);
  const doc = sysDoc || (other && other[1]);
  if (!doc) return;
  if (app.history.dirty.has(doc)) { toast(`${name} ${why}, but you have unsaved edits to it in the editor — saving will overwrite the file.`, 7000); return; }
  if (sysDoc && sysDoc === app.sys) { await app.reloadSystem(); toast(`Reloaded ${name} (${why})`); return; }
  if (sysDoc) app.systemDocs.delete(sysDoc.nickname.toLowerCase());
  if (other) app.otherDocs.delete(other[0]);
  toast(`${name} ${why} — will be re-read when next opened`);
}
