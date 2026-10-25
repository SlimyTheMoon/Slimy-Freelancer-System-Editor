// Freelancer System Editor — VS Code extension.
// Runs the editor's own local server (server.js) inside the extension host and shows the editor in a
// webview panel (iframe to http://127.0.0.1:<port>). File access stays on the fast HTTP path; only small
// control messages (reveal line, dirty count, file changed) go through the webview message channel.
'use strict';
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const http = require('http');

let server = null;   // { url, port, installDir, close }
let panel = null;
let watcher = null;
let out = null;

function log(s) { if (!out) out = vscode.window.createOutputChannel('Freelancer System Editor'); out.appendLine(s); }

// case-insensitive "does <dir>/DATA/UNIVERSE/universe.ini exist"
function ciExists(base, rel) {
  let cur = base;
  for (const seg of rel.split('/')) {
    let entries; try { entries = fs.readdirSync(cur); } catch { return false; }
    const hit = entries.find(e => e.toLowerCase() === seg.toLowerCase());
    if (!hit) return false;
    cur = path.join(cur, hit);
  }
  return true;
}
const isInstall = (d) => d && ciExists(d, 'DATA/UNIVERSE/universe.ini');

function detectInstall() {
  const cfg = vscode.workspace.getConfiguration('freelancerSystemEditor');
  const set = cfg.get('installDir');
  if (set && isInstall(set)) return set;
  for (const f of vscode.workspace.workspaceFolders || []) {
    const root = f.uri.fsPath;
    if (isInstall(root)) return root;
    if (isInstall(path.dirname(root))) return path.dirname(root);
    let kids = []; try { kids = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => path.join(root, e.name)); } catch { }
    for (const k of kids) if (isInstall(k)) return k;
  }
  return '';
}

async function ensureServer() {
  if (server) return server;
  let installDir = detectInstall();
  if (!installDir) {
    const pick = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Use as Freelancer install', title: 'Select the Freelancer folder (the one containing DATA and EXE)' });
    if (!pick || !pick[0]) throw new Error('No Freelancer install selected');
    installDir = pick[0].fsPath;
    if (!isInstall(installDir)) throw new Error(`No DATA\\UNIVERSE\\universe.ini under ${installDir}`);
    await vscode.workspace.getConfiguration('freelancerSystemEditor').update('installDir', installDir, vscode.ConfigurationTarget.Global);
  }
  const { start } = require('./server.js');
  // a fixed port keeps the editor's browser storage (view settings, last system) between sessions;
  // fall back to any free port when it is taken
  const port = vscode.workspace.getConfiguration('freelancerSystemEditor').get('port') || 5718;
  // "File → Game folder…" inside the editor also updates this setting, so the choice survives a restart
  const onInstallChange = (dir) => vscode.workspace.getConfiguration('freelancerSystemEditor').update('installDir', dir, vscode.ConfigurationTarget.Global);
  try { server = await start({ installDir, port, open: false, quiet: true, onInstallChange }); }
  catch (e) { if (e.code !== 'EADDRINUSE') throw e; server = await start({ installDir, port: 0, open: false, quiet: true, onInstallChange }); }
  log(`Server ${server.url} · install ${server.installDir}`);
  watchInstall();
  return server;
}

function watchInstall() {
  if (watcher || !server) return;
  watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(server.installDir), '**/*.ini'));
  const notify = (uri) => { if (!panel) return; panel.webview.postMessage({ fledExt: true, type: 'fileChanged', rel: path.relative(server.installDir, uri.fsPath).replace(/\\/g, '/') }); };
  watcher.onDidChange(notify); watcher.onDidCreate(notify);
}

function getJson(url) {
  return new Promise((resolve, reject) => http.get(url, (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }).on('error', reject));
}

async function openPanel(context, first) {
  const srv = await ensureServer();
  if (panel) {
    panel.reveal();
    if (first) panel.webview.postMessage({ fledExt: true, ...first });
    return panel;
  }
  const ext = await vscode.env.asExternalUri(vscode.Uri.parse(srv.url));
  const q = new URLSearchParams({ host: 'vscode' });
  if (first && first.type === 'openSystem') q.set('system', first.system);
  const src = ext.toString(true).replace(/\/?$/, '/') + '?' + q.toString();
  panel = vscode.window.createWebviewPanel('freelancerSystemEditor', 'FL System Editor', vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true });
  panel.iconPath = vscode.Uri.file(path.join(context.extensionPath, 'icon.png'));
  const origin = new URL(src).origin;
  panel.webview.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${origin} http://127.0.0.1:* http://localhost:*; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
<style>html,body,iframe{margin:0;padding:0;border:0;width:100%;height:100%;overflow:hidden;background:#0d1117}</style></head>
<body><iframe id="f" src="${src}" allow="clipboard-read; clipboard-write"></iframe>
<script>
const vscode = acquireVsCodeApi(); const f = document.getElementById('f');
window.addEventListener('message', (e) => {
  const d = e.data || {};
  if (d.fled && e.source === f.contentWindow) vscode.postMessage(d);           // editor -> extension
  else if (d.fledExt) f.contentWindow.postMessage(d, '*');                      // extension -> editor
});
</script></body></html>`;
  panel.webview.onDidReceiveMessage(async (m) => {
    if (m.type === 'dirty') panel.title = 'FL System Editor' + (m.n ? ` ● ${m.n}` : '');
    if (m.type === 'ready' && first && first.type !== 'openSystem') panel.webview.postMessage({ fledExt: true, ...first });
    if (m.type === 'reveal' && m.rel) {
      try {
        const r = await getJson(`${srv.url}api/realpath?p=${encodeURIComponent(m.rel)}`);
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(r.path));
        const line = Math.max(0, (m.line || 1) - 1);
        await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false, selection: new vscode.Range(line, 0, line, 0) });
      } catch (e) { vscode.window.showErrorMessage('Could not open ' + m.rel + ': ' + e.message); }
    }
  });
  panel.onDidDispose(() => { panel = null; });
  return panel;
}

// nickname of the [Object]/[Zone]/[LightSource] section around the cursor in a system INI
function sectionNicknameAt(doc, line) {
  let start = line;
  while (start >= 0 && !/^\s*\[/.test(doc.lineAt(start).text)) start--;
  if (start < 0 || !/^\s*\[(object|zone|lightsource)\]/i.test(doc.lineAt(start).text)) return null;
  for (let i = start + 1; i < doc.lineCount; i++) {
    const t = doc.lineAt(i).text; if (/^\s*\[/.test(t)) break;
    const m = /^\s*nickname\s*=\s*([^;\s]+)/i.exec(t); if (m) return m[1];
  }
  return null;
}

// ---- INI key reference (shipped as public/data/*.json) ----
let iniRef = null;
function loadIniRef(context) {
  if (iniRef) return iniRef;
  try {
    const dir = path.join(context.extensionPath, 'public', 'data');
    const schema = JSON.parse(fs.readFileSync(path.join(dir, 'inischema.json'), 'utf8'));
    const strings = new Set(JSON.parse(fs.readFileSync(path.join(dir, 'inistrings.json'), 'utf8')).strings);
    iniRef = { schema, strings };
  } catch (e) { iniRef = { schema: { sections: {}, groups: {} }, strings: null }; }
  return iniRef;
}
function sectionAt(doc, line) {
  for (let i = line; i >= 0; i--) { const m = /^\s*\[([^\]]+)\]/.exec(doc.lineAt(i).text); if (m) return m[1]; }
  return null;
}
function keysOf(ref, sec) {
  const s = ref.schema.sections[(sec || '').toLowerCase()]; if (!s) return null;
  const out = new Map(Object.entries(s.keys));
  for (const g of s.include || []) for (const [k, v] of Object.entries(ref.schema.groups[g].keys)) if (!out.has(k)) out.set(k, v);
  return out;
}
function registerIniLanguage(context) {
  const sel = [{ language: 'ini' }, { pattern: '**/*.ini' }];
  context.subscriptions.push(vscode.languages.registerHoverProvider(sel, {
    provideHover(doc, pos) {
      const text = doc.lineAt(pos.line).text, m = /^\s*([^=;\[]+?)\s*=/.exec(text);
      if (!m || pos.character > text.indexOf('=')) return null;
      const ref = loadIniRef(context), sec = sectionAt(doc, pos.line); if (!sec) return null;
      const key = m[1].trim(), d = (keysOf(ref, sec) || new Map()).get(key.toLowerCase());
      const md = new vscode.MarkdownString();
      if (d) {
        md.appendMarkdown(`**${d.key}** · \`${d.type || '?'}\`${d.default ? ` · default \`${d.default}\`` : ''}\n\n${d.meaning}\n\n`);
        md.appendMarkdown(`_[${sec}] — INI reference (${d.page})${d.source ? ', ' + d.source : ''}_`);
      } else if (ref.strings && !ref.strings.has(key.toLowerCase()) && !/^(encounterparameters|spiels|cfg|reverb|sp ranks|mp ranks|systems|properties)$/i.test(sec)) {
        md.appendMarkdown(`**${key}** is not read by the game: no code in the reconstructed Freelancer source looks this key up.`);
      } else return null;
      return new vscode.Hover(md);
    },
  }));
  context.subscriptions.push(vscode.languages.registerCompletionItemProvider(sel, {
    provideCompletionItems(doc, pos) {
      const before = doc.lineAt(pos.line).text.slice(0, pos.character);
      if (before.includes('=') || /^\s*\[/.test(before)) return null;
      const ref = loadIniRef(context), sec = sectionAt(doc, pos.line), keys = keysOf(ref, sec); if (!keys) return null;
      return [...keys.values()].filter(d => /^[A-Za-z_][A-Za-z0-9_]*$/.test(d.key)).map(d => {
        const it = new vscode.CompletionItem(d.key, vscode.CompletionItemKind.Property);
        it.detail = `${d.type || ''}${d.default ? ' = ' + d.default : ''}`; it.documentation = new vscode.MarkdownString(d.meaning); it.insertText = d.key + ' = ';
        return it;
      });
    },
  }));
}

function activate(context) {
  registerIniLanguage(context);
  context.subscriptions.push(
    vscode.commands.registerCommand('freelancerSystemEditor.open', async () => {
      try { await openPanel(context); } catch (e) { vscode.window.showErrorMessage(String(e.message || e)); }
    }),
    vscode.commands.registerCommand('freelancerSystemEditor.openFile', async (uri) => {
      try {
        uri = uri || (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri);
        if (!uri) return openPanel(context);
        const srv = await ensureServer();
        const rel = path.relative(srv.installDir, uri.fsPath).replace(/\\/g, '/');
        if (rel.startsWith('..')) { vscode.window.showWarningMessage('That file is not inside the Freelancer install ' + srv.installDir); return; }
        const ed = vscode.window.activeTextEditor;
        const nick = ed && ed.document.uri.fsPath === uri.fsPath ? sectionNicknameAt(ed.document, ed.selection.active.line) : null;
        await openPanel(context, { type: 'openFile', rel });
        if (nick) setTimeout(() => panel && panel.webview.postMessage({ fledExt: true, type: 'select', nickname: nick }), 1500);
      } catch (e) { vscode.window.showErrorMessage(String(e.message || e)); }
    }),
    vscode.commands.registerCommand('freelancerSystemEditor.setInstall', async () => {
      const pick = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Use as Freelancer install' });
      if (!pick || !pick[0]) return;
      if (!isInstall(pick[0].fsPath)) { vscode.window.showErrorMessage('No DATA\\UNIVERSE\\universe.ini in that folder.'); return; }
      await vscode.workspace.getConfiguration('freelancerSystemEditor').update('installDir', pick[0].fsPath, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage('Freelancer install set. Reload the window to apply it to a running editor.');
    }),
    { dispose: () => { if (watcher) watcher.dispose(); if (server) server.close(); } },
  );
}
function deactivate() { if (server) return server.close(); }
module.exports = { activate, deactivate };
