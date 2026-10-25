#!/usr/bin/env node
// Freelancer System Editor — local server (Node >= 18, no dependencies)
// Serves the editor UI and gives it case-insensitive read/write access to the game install.
// Every file is backed up (first write per session) to <install>/editor_backups/<timestamp>/...
'use strict';
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { exec } = require('child_process');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const CONFIG = path.join(ROOT, 'config.json');
const PORT = parseInt(process.env.FLED_PORT || process.argv.find(a => /^--port=/.test(a))?.slice(7) || '5717', 10);
const NO_OPEN = process.argv.includes('--no-open') || require.main !== module;

let config = { installDir: '' };
try { config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG, 'utf8')) }; } catch { }
const IS_CLI = require.main === module;
const argDir = IS_CLI ? process.argv.slice(2).find(a => !a.startsWith('--')) : null;
if (argDir) config.installDir = path.resolve(argDir);

// Opens the OS folder picker and resolves { path } (empty when cancelled) or { error }.
function pickFolder(start) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const ps = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$f = New-Object System.Windows.Forms.Form; $f.TopMost = $true; $f.ShowInTaskbar = $false',
        '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
        '$d.Description = "Choose the Freelancer game folder (the one that contains DATA and EXE)"',
        '$d.ShowNewFolderButton = $false',
        '$s = $env:FLED_START; if ($s -and (Test-Path -LiteralPath $s)) { $d.SelectedPath = $s }',
        'if ($d.ShowDialog($f) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding = [Text.Encoding]::UTF8; [Console]::Out.Write($d.SelectedPath) }',
      ].join('; ');
      const child = require('child_process').spawn('powershell.exe', ['-NoProfile', '-STA', '-NonInteractive', '-Command', ps], { env: { ...process.env, FLED_START: start }, windowsHide: true });
      let out = '', err = '';
      child.stdout.on('data', d => out += d); child.stderr.on('data', d => err += d);
      child.on('error', e => resolve({ error: 'Could not open the folder dialog: ' + e.message }));
      child.on('close', (code) => resolve(code === 0 ? { path: out.trim() } : { error: 'Folder dialog failed: ' + (err.trim() || 'exit ' + code) }));
    } else if (process.platform === 'darwin') {
      exec(`osascript -e 'POSIX path of (choose folder with prompt "Choose the Freelancer game folder")'`, (e, out) => resolve(e ? { path: '' } : { path: out.trim() }));
    } else {
      exec('zenity --file-selection --directory --title="Choose the Freelancer game folder"', (e, out) => resolve(e && e.code !== 1 ? { error: 'No folder dialog available (install zenity) — type the path instead.' } : { path: (out || '').trim() }));
    }
  });
}
function looksLikeInstall(dir) {
  try { return !!resolveCI(dir, 'DATA/UNIVERSE/universe.ini'); } catch { return false; }
}
function autodetect() {
  if (config.installDir && looksLikeInstall(config.installDir)) return config.installDir;
  const candidates = [
    path.join(ROOT, '..', 'Freelancer HD Edition'),
    path.join(ROOT, '..', '..', 'Freelancer HD Edition'),
    path.join(ROOT, '..'),
    'C:\\Program Files (x86)\\Microsoft Games\\Freelancer',
    'C:\\Program Files\\Microsoft Games\\Freelancer',
    path.join(process.env.LOCALAPPDATA || '', 'Freelancer HD Edition'),
    'C:\\Games\\Freelancer HD Edition',
  ];
  // also: any sibling folder containing DATA/UNIVERSE/universe.ini
  try {
    for (const d of fs.readdirSync(path.join(ROOT, '..'))) candidates.push(path.join(ROOT, '..', d));
  } catch { }
  for (const c of candidates) if (c && looksLikeInstall(c)) return path.resolve(c);
  return '';
}
// ---------- case-insensitive path resolution ----------
const dirCache = new Map();
const DIR_TTL = 4000; // ms — picks up files added outside the editor (mods, copies) without a restart
function listDir(dir) {
  const hit = dirCache.get(dir);
  if (hit && Date.now() - hit.t < DIR_TTL) return hit.entries;
  let entries = null;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { }
  dirCache.set(dir, { t: Date.now(), entries });
  return entries;
}
function invalidate(dir) { dirCache.delete(dir); }
function splitRel(rel) { return rel.replace(/\\/g, '/').split('/').filter(s => s && s !== '.'); }
function resolveCI(base, rel) {
  let cur = base;
  for (const seg of splitRel(rel)) {
    if (seg === '..') { cur = path.dirname(cur); continue; }
    const entries = listDir(cur);
    if (!entries) return null;
    const l = seg.toLowerCase();
    const hit = entries.find(e => e.name.toLowerCase() === l);
    if (!hit) return null;
    cur = path.join(cur, hit.name);
  }
  return cur;
}
// For writing: resolve existing prefix case-insensitively, create the rest as given.
function resolveForWrite(base, rel) {
  let cur = base;
  const segs = splitRel(rel);
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const entries = listDir(cur);
    const hit = entries && entries.find(e => e.name.toLowerCase() === seg.toLowerCase());
    if (hit) { cur = path.join(cur, hit.name); continue; }
    return path.join(cur, ...segs.slice(i));
  }
  return cur;
}
function inside(base, p) {
  const r = path.relative(base, p);
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
}

config.installDir = autodetect();

// ---------- backups ----------
const SESSION = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const backedUp = new Set();
async function backup(abs) {
  if (backedUp.has(abs)) return;
  backedUp.add(abs);
  const rel = path.relative(config.installDir, abs);
  try {
    await fsp.access(abs);
  } catch { // new file — nothing to back up; remember it was created by the editor
    const dir = path.join(config.installDir, 'editor_backups', SESSION);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.appendFile(path.join(dir, '_created.txt'), rel + '\n');
    return;
  }
  const dst = path.join(config.installDir, 'editor_backups', SESSION, rel);
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  await fsp.copyFile(abs, dst);
}

// ---------- http ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req, limit = 512 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}


// text INI cache for reference searches (re-read when the file changes)
const iniCache = new Map();
async function readIniCached(p) {
  let st; try { st = await fsp.stat(p); } catch { return null; }
  const c = iniCache.get(p); if (c && c.mtime === st.mtimeMs && c.size === st.size) return c.t;
  let b; try { b = await fsp.readFile(p); } catch { return null; }
  let s, bini = false;
  if (b.slice(0, 4).toString('latin1') === 'BINI') { // binary INI: decode with the editor's own BINI reader
    try { const { IniDocument } = await import(require('url').pathToFileURL(path.join(PUBLIC, 'js', 'formats', 'ini.js')).href); s = new TextDecoder('windows-1252').decode(IniDocument.fromBytes(new Uint8Array(b)).toBytes()); bini = true; }
    catch { return 'BINI'; }
  } else s = b.toString('latin1');
  const t = { lines: s.split(/\r?\n/), lower: s.toLowerCase(), bini };
  iniCache.set(p, { mtime: st.mtimeMs, size: st.size, t });
  return t;
}


// single-player save folder (Documents may be redirected to OneDrive)
const launches = new Map();
function saveDirCandidates() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const docs = [path.join(home, 'Documents'), process.env.OneDrive && path.join(process.env.OneDrive, 'Documents'), path.join(home, 'OneDrive', 'Documents'), path.join(home, 'OneDrive', 'Dokumente'), path.join(home, 'Dokumente')].filter(Boolean);
  return docs.map(d => path.join(d, 'My Games', 'Freelancer', 'Accts', 'SinglePlayer'));
}
function saveDir() { for (const d of saveDirCandidates()) { try { if (fs.statSync(d).isDirectory()) return d; } catch { } } return null; }

// ---------- changed files (vs. the oldest backup = the file before the editor first touched it) ----------
async function changedFiles() {
  // every file the editor has overwritten, compared with the oldest backup (= the file before the
  // editor first touched it), plus files the editor created
  const dir = path.join(config.installDir, 'editor_backups');
  let sessions = []; try { sessions = (await fsp.readdir(dir)).sort(); } catch { }
  const files = new Map();
  const walk = async (base, sub, session) => {
    let ents = []; try { ents = await fsp.readdir(path.join(base, sub), { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const r = path.join(sub, e.name);
      if (e.isDirectory()) await walk(base, r, session);
      else if (r !== '_created.txt' && !/^_saves[\\/]/.test(r) && !r.endsWith('.fled-tmp') && !files.has(r.toLowerCase())) files.set(r.toLowerCase(), { path: r.split(path.sep).join('/'), session, backup: ['editor_backups', session, r].join('/').split(path.sep).join('/') });
    }
  };
  const created = [];
  for (const s of sessions) {
    await walk(path.join(dir, s), '', s);
    try { for (const l of (await fsp.readFile(path.join(dir, s, '_created.txt'), 'utf8')).split(/\r?\n/)) if (l.trim()) created.push({ path: l.trim().split(path.sep).join('/'), session: s }); } catch { }
  }
  const out = [];
  const createdIn = new Map(); for (const c of created) if (!createdIn.has(c.path.toLowerCase())) createdIn.set(c.path.toLowerCase(), c.session);
  for (const f of files.values()) {
    // created by the editor in an earlier session and changed later: still an added file, not an original
    const cs = createdIn.get(f.path.toLowerCase()); if (cs && cs <= f.session) { files.delete(f.path.toLowerCase()); continue; }
    const cur = resolveCI(config.installDir, f.path), bak = path.join(config.installDir, f.backup);
    let a = null, b = null; try { a = await fsp.readFile(bak); } catch { } try { b = cur ? await fsp.readFile(cur) : null; } catch { }
    out.push({ ...f, origSize: a ? a.length : null, curSize: b ? b.length : null, same: !!(a && b && a.equals(b)) });
  }
  for (const c of created) if (!files.has(c.path.toLowerCase())) {
    const cur = resolveCI(config.installDir, c.path); let st = null; try { st = cur ? await fsp.stat(cur) : null; } catch { }
    out.push({ path: c.path, session: c.session, created: true, backup: null, origSize: null, curSize: st ? st.size : null, same: false });
  }
  out.sort((x, y) => x.path.localeCompare(y.path));
  return { sessions, files: out };
}

// ---------- snapshots: named copies of every file the editor changed, in <install>/editor_snapshots/<id>/ ----------
async function writeBacked(abs, data) {
  await backup(abs);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  const tmp = abs + '.fled-tmp'; await fsp.writeFile(tmp, data); await fsp.rename(tmp, abs);
  let d = path.dirname(abs); while (inside(config.installDir, d)) { invalidate(d); if (d === config.installDir) break; d = path.dirname(d); }
}
async function removeBacked(abs) {
  await backup(abs); await fsp.unlink(abs);
  let d = path.dirname(abs); while (inside(config.installDir, d)) { invalidate(d); if (d === config.installDir) break; d = path.dirname(d); }
}
const snapRoot = () => path.join(config.installDir, 'editor_snapshots');
const readFileOr = async (p) => { try { return await fsp.readFile(p); } catch { return null; } };
async function listSnapshots() {
  let ids = []; try { ids = (await fsp.readdir(snapRoot())).sort().reverse(); } catch { }
  const out = [];
  for (const id of ids) { try { const m = JSON.parse(await fsp.readFile(path.join(snapRoot(), id, 'manifest.json'), 'utf8')); out.push({ id, ...m }); } catch { } }
  return out;
}
async function takeSnapshot(name, note = '', auto = false) {
  const ch = await changedFiles();
  const id = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '_' + (String(name).replace(/[^a-z0-9_-]+/gi, '_').slice(0, 40) || 'snapshot');
  const dir = path.join(snapRoot(), id);
  const files = [], deleted = [];
  for (const f of ch.files) {
    const cur = resolveCI(config.installDir, f.path);
    const data = cur ? await readFileOr(cur) : null;
    if (!data) { if (!f.created) deleted.push(f.path); continue; }
    if (f.same) continue; // identical to the original: nothing to keep
    const dst = path.join(dir, 'files', f.path);
    await fsp.mkdir(path.dirname(dst), { recursive: true }); await fsp.writeFile(dst, data);
    files.push({ path: f.path, size: data.length, created: !!f.created });
  }
  const manifest = { name: String(name || 'Snapshot'), note: String(note || ''), created: new Date().toISOString(), auto, files, deleted };
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 1));
  return { id, ...manifest };
}
// what restoring snapshot <id> would do to the current files
async function snapshotDiff(id) {
  const dir = path.join(snapRoot(), id);
  const m = JSON.parse(await fsp.readFile(path.join(dir, 'manifest.json'), 'utf8'));
  const ch = await changedFiles(), now = new Map(ch.files.map(f => [f.path.toLowerCase(), f]));
  const rows = [], seen = new Set();
  for (const f of m.files) {
    seen.add(f.path.toLowerCase());
    const cur = resolveCI(config.installDir, f.path), a = await readFileOr(path.join(dir, 'files', f.path)), b = cur ? await readFileOr(cur) : null;
    rows.push({ path: f.path, status: !b ? 'missing now' : a && a.equals(b) ? 'same' : 'changed since', action: !b || !(a && a.equals(b)) ? 'write snapshot copy' : '' , snapSize: f.size, curSize: b ? b.length : null });
  }
  for (const p of m.deleted || []) {
    seen.add(p.toLowerCase());
    const cur = resolveCI(config.installDir, p);
    rows.push({ path: p, status: cur ? 'exists now (deleted in snapshot)' : 'same', action: cur ? 'delete' : '' });
  }
  for (const f of now.values()) {
    if (seen.has(f.path.toLowerCase())) continue;
    const cur = resolveCI(config.installDir, f.path);
    if (f.created) { if (cur) rows.push({ path: f.path, status: 'added after snapshot', action: 'delete', curSize: f.curSize }); continue; }
    if (!f.same) rows.push({ path: f.path, status: cur ? 'changed after snapshot' : 'deleted after snapshot', action: 'restore original', curSize: f.curSize, origSize: f.origSize });
  }
  rows.sort((x, y) => x.path.localeCompare(y.path));
  return { id, ...m, rows };
}
async function restoreSnapshot(id) {
  const d = await snapshotDiff(id), dir = path.join(snapRoot(), id), ch = await changedFiles();
  const orig = new Map(ch.files.map(f => [f.path.toLowerCase(), f]));
  const done = [];
  for (const r of d.rows) {
    if (!r.action) continue;
    const abs = resolveCI(config.installDir, r.path) || resolveForWrite(config.installDir, r.path);
    if (!inside(config.installDir, abs)) continue;
    if (r.action === 'write snapshot copy') await writeBacked(abs, await fsp.readFile(path.join(dir, 'files', r.path)));
    else if (r.action === 'delete') { try { await removeBacked(abs); } catch { } }
    else if (r.action === 'restore original') { const o = orig.get(r.path.toLowerCase()); if (o && o.backup) await writeBacked(abs, await fsp.readFile(path.join(config.installDir, o.backup))); }
    done.push(r);
  }
  return done;
}
async function snapshots(req, res, route, url) {
  try {
    if (route === 'snapshots') return send(res, 200, { dir: snapRoot(), snapshots: await listSnapshots() });
    const id = String(url.searchParams.get('id') || '');
    if (route !== 'snapshot/create' && !/^[0-9T-]{19}_[A-Za-z0-9_-]+$/.test(id)) return send(res, 400, { error: 'bad snapshot id' });
    if (route === 'snapshot/diff') return send(res, 200, await snapshotDiff(id));
    if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    if (route === 'snapshot/create') return send(res, 200, await takeSnapshot(body.name, body.note));
    if (route === 'snapshot/restore') {
      const target = (await listSnapshots()).find(x => x.id === id); if (!target) return send(res, 404, { error: 'no such snapshot' });
      const safety = await takeSnapshot('Before restoring ' + target.name, '', true);
      const done = await restoreSnapshot(id);
      return send(res, 200, { ok: true, safety: safety.id, changed: done });
    }
    if (route === 'snapshot/delete') { await fsp.rm(path.join(snapRoot(), id), { recursive: true, force: true }); return send(res, 200, { ok: true }); }
    if (route === 'snapshot/rename') { const f = path.join(snapRoot(), id, 'manifest.json'); const m = JSON.parse(await fsp.readFile(f, 'utf8')); if (body.name != null) m.name = String(body.name); if (body.note != null) m.note = String(body.note); await fsp.writeFile(f, JSON.stringify(m, null, 1)); return send(res, 200, { ok: true }); }
    return send(res, 404, { error: 'unknown snapshot api' });
  } catch (e) { return send(res, 500, { error: String(e.message || e) }); }
}

async function api(req, res, url) {
  const route = url.pathname.slice(5);
  if (route === 'pick-folder') { // native "choose folder" dialog on the machine running the editor
    const start = String(url.searchParams.get('start') || config.installDir || '');
    const picked = await pickFolder(start);
    if (picked.error) return send(res, 200, picked);
    if (!picked.path) return send(res, 200, { cancelled: true });
    // accept the game folder itself, or DATA / EXE / anything inside it
    let dir = path.resolve(picked.path), fix = dir;
    for (let i = 0; i < 4 && fix; i++) { if (looksLikeInstall(fix)) break; const up = path.dirname(fix); fix = up === fix ? null : up; }
    return send(res, 200, { path: fix && looksLikeInstall(fix) ? fix : dir, valid: !!(fix && looksLikeInstall(fix)) });
  }
  if (route === 'config') {
    if (req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const dir = path.resolve(String(body.installDir || ''));
      if (!looksLikeInstall(dir)) return send(res, 400, { error: 'No DATA\\UNIVERSE\\universe.ini found under that folder.' });
      config.installDir = dir; dirCache.clear();
      await fsp.writeFile(CONFIG, JSON.stringify({ installDir: dir }, null, 2));
      if (onInstallDir) try { await onInstallDir(dir); } catch { }
    }
    return send(res, 200, { installDir: config.installDir, ok: !!config.installDir && looksLikeInstall(config.installDir), session: SESSION, platform: process.platform });
  }
  if (!config.installDir) return send(res, 409, { error: 'Freelancer install folder not configured' });
  const rel = url.searchParams.get('p') || '';
  // Paths are relative to the install root (e.g. DATA/SOLAR/x.cmp, EXE/freelancer.ini)
  if (route === 'file') {
    if (req.method === 'GET' || req.method === 'HEAD') {
      const abs = resolveCI(config.installDir, rel);
      if (!abs || !inside(config.installDir, abs)) return send(res, 404, { error: 'not found', path: rel });
      try {
        const st = await fsp.stat(abs);
        if (!st.isFile()) return send(res, 404, { error: 'not a file' });
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-store', 'X-Real-Path': encodeURIComponent(path.relative(config.installDir, abs)) });
        if (req.method === 'HEAD') return res.end();
        fs.createReadStream(abs).pipe(res);
      } catch (e) { send(res, 500, { error: String(e) }); }
      return;
    }
    if (req.method === 'POST' || req.method === 'PUT') {
      const abs = resolveForWrite(config.installDir, rel);
      if (!inside(config.installDir, abs) || !rel) return send(res, 400, { error: 'bad path' });
      const body = await readBody(req);
      try {
        await backup(abs);
        await fsp.mkdir(path.dirname(abs), { recursive: true });
        const tmp = abs + '.fled-tmp';
        await fsp.writeFile(tmp, body);
        await fsp.rename(tmp, abs);
        let d = path.dirname(abs); while (inside(config.installDir, d)) { invalidate(d); if (d === config.installDir) break; d = path.dirname(d); }
        return send(res, 200, { ok: true, path: path.relative(config.installDir, abs), bytes: body.length });
      } catch (e) {
        const locked = /EBUSY|EPERM|EACCES/.test(e.code || String(e));
        return send(res, 500, { error: locked ? `${path.basename(abs)} is in use (is Freelancer or FLServer running?) — close it and save again` : String(e) });
      }
    }
  }
  if (route === 'ls') {
    const abs = resolveCI(config.installDir, rel);
    if (!abs || !inside(config.installDir, abs)) return send(res, 404, { error: 'not found' });
    const entries = listDir(abs) || [];
    return send(res, 200, entries.map(e => ({ name: e.name, dir: e.isDirectory() })));
  }
  if (route === 'find') { // recursive file list by extension: /api/find?p=DATA&ext=.thn,.wav  → [relative paths]
    const abs = resolveCI(config.installDir, rel || 'DATA');
    if (!abs || !inside(config.installDir, abs)) return send(res, 404, { error: 'not found' });
    const exts = (url.searchParams.get('ext') || '').toLowerCase().split(',').filter(Boolean);
    const out = [];
    const walk = async (d, depth) => {
      if (depth > 12 || out.length > 50000) return;
      let ents = []; try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (!/^editor_/i.test(e.name)) await walk(p, depth + 1); } // skip editor_ folders: backups, snapshots, exports, patches
        else if (!exts.length || exts.some(x => e.name.toLowerCase().endsWith(x))) out.push(path.relative(config.installDir, p).replace(/\\/g, '/'));
      }
    };
    await walk(abs, 0);
    return send(res, 200, out.sort());
  }
  if (route === 'realpath') { // absolute path of an existing file (used by the VS Code extension to open it)
    const abs = resolveCI(config.installDir, rel);
    if (!abs || !inside(config.installDir, abs)) return send(res, 404, { error: 'not found' });
    return send(res, 200, { path: abs });
  }
  if (route === 'backups') {
    const dir = path.join(config.installDir, 'editor_backups');
    let list = []; try { list = (await fsp.readdir(dir)).sort().reverse(); } catch { }
    return send(res, 200, { dir, sessions: list });
  }
  if (route === 'flspew') { // the game's log, written on every run
    const home = process.env.USERPROFILE || process.env.HOME || '';
    const cands = [path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Freelancer', 'FLSpew.txt'),
      path.join(home, 'Documents', 'My Games', 'Freelancer', 'FLSpew.txt'), path.join(config.installDir, 'EXE', 'FLSpew.txt')];
    for (const p of cands) {
      try {
        const st = await fsp.stat(p); const fd = await fsp.open(p, 'r');
        const n = Math.min(st.size, 4 * 1024 * 1024), buf = Buffer.alloc(n);
        await fd.read(buf, 0, n, st.size - n); await fd.close();
        return send(res, 200, { path: p, modified: st.mtime.toISOString(), size: st.size, text: buf.toString('latin1') });
      } catch { }
    }
    return send(res, 404, { error: 'FLSpew.txt not found', tried: cands });
  }
  if (route === 'grep') { // case-insensitive search of the text INI files under DATA
    const q = (url.searchParams.get('q') || '').toLowerCase(); if (q.length < 2) return send(res, 400, { error: 'query too short' });
    const hits = []; let files = 0, truncated = false;
    const root = resolveCI(config.installDir, 'DATA');
    const walk = async (dir) => {
      let ents = []; try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (hits.length >= 200) { truncated = true; return; }
        const p = path.join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else if (/\.ini$/i.test(e.name)) {
          files++; let t; try { t = await fsp.readFile(p); } catch { continue; }
          if (t.slice(0, 4).toString() === 'BINI') continue;
          const s = t.toString('latin1'); if (!s.toLowerCase().includes(q)) continue;
          s.split(/\r?\n/).forEach((l, i) => { if (hits.length < 200 && l.toLowerCase().includes(q)) hits.push({ path: path.relative(config.installDir, p).split(path.sep).join('/'), line: i + 1, text: l.trim().slice(0, 160) }); });
        }
      }
    };
    if (root) await walk(root);
    return send(res, 200, { q, files, hits, truncated });
  }
  if (route === 'refs') {
    // every INI line under DATA and EXE whose value list contains the given token (case-insensitive,
    // whole comma-separated values), plus where it is defined (nickname = token); BINI files are skipped
    const q = (url.searchParams.get('q') || '').trim().toLowerCase(); if (!q) return send(res, 400, { error: 'no query' });
    const out = { q, defs: [], refs: [], bini: [], files: 0 };
    const roots = ['DATA', 'EXE'].map(r => resolveCI(config.installDir, r)).filter(Boolean);
    const walk = async (dir) => {
      let ents = []; try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { await walk(p); continue; }
        if (!/\.ini$/i.test(e.name)) continue;
        out.files++;
        const t = await readIniCached(p); if (t == null) continue;
        const rel = path.relative(config.installDir, p).split(path.sep).join('/');
        if (t === 'BINI') { out.bini.push(rel); continue; }
        if (t.bini) out.biniRead = (out.biniRead || 0) + 1;
        if (!t.lower.includes(q)) continue;
        let sec = '', secNick = '', secLine = 0;
        const lines = t.lines;
        for (let i = 0; i < lines.length; i++) {
          const raw = lines[i]; const m = /^\s*\[([^\]]+)\]/.exec(raw);
          if (m) { sec = m[1]; secLine = i + 1; secNick = ''; for (let j = i + 1; j < Math.min(lines.length, i + 8); j++) { const n = /^\s*nickname\s*=\s*([^;,\s]+)/i.exec(lines[j]); if (n) { secNick = n[1]; break; } if (/^\s*\[/.test(lines[j])) break; } continue; }
          const eq = raw.indexOf('='); if (eq < 0) continue;
          let val = raw.slice(eq + 1); const sc = val.indexOf(';'); if (sc >= 0) val = val.slice(0, sc);
          if (!val.toLowerCase().includes(q)) continue;
          const key = raw.slice(0, eq).trim();
          if (!val.split(',').some(v => v.trim().toLowerCase() === q)) continue;
          const hit = { path: rel, line: i + 1, section: sec, sectionLine: secLine, sectionNick: secNick, key, text: raw.trim().slice(0, 200) };
          (/^nickname$/i.test(key) ? out.defs : out.refs).push(hit);
          if (out.refs.length > 5000) { out.truncated = true; return; }
        }
      }
    };
    for (const r of roots) await walk(r);
    return send(res, 200, out);
  }
  if (route === 'saves' || route === 'savefile') { // single-player saves: <Documents>\My Games\Freelancer\Accts\SinglePlayer
    const dir = saveDir();
    if (!dir) return send(res, 404, { error: 'Save folder not found', tried: saveDirCandidates() });
    if (route === 'saves') {
      let ents = []; try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { }
      const list = [];
      for (const e of ents) if (e.isFile() && /\.fl$/i.test(e.name)) { try { const st = await fsp.stat(path.join(dir, e.name)); list.push({ name: e.name, size: st.size, modified: st.mtime.toISOString() }); } catch { } }
      list.sort((a, b) => b.modified.localeCompare(a.modified));
      return send(res, 200, { dir, saves: list });
    }
    const name = path.basename(url.searchParams.get('name') || ''); if (!/\.fl$/i.test(name)) return send(res, 400, { error: 'bad name' });
    const p = path.join(dir, name);
    if (req.method === 'GET') { try { return send(res, 200, await fsp.readFile(p), 'application/octet-stream'); } catch { return send(res, 404, { error: 'not found' }); } }
    const body = await readBody(req);
    try { await fsp.access(p); const bdir = path.join(config.installDir, 'editor_backups', SESSION, '_saves'); await fsp.mkdir(bdir, { recursive: true }); await fsp.copyFile(p, path.join(bdir, name)); } catch { }
    await fsp.writeFile(p, body);
    return send(res, 200, { ok: true, path: p });
  }
  if (route === 'mpsaves' || route === 'mpsavefile') { // multiplayer characters: <Documents>\My Games\Freelancer\Accts\MultiPlayer\<account>\*.fl
    const sp = saveDir(); const dir = sp ? path.join(path.dirname(sp), 'MultiPlayer') : null;
    if (!dir) return send(res, 404, { error: 'Save folder not found', tried: saveDirCandidates() });
    if (route === 'mpsaves') {
      const list = []; let accts = []; try { accts = await fsp.readdir(dir, { withFileTypes: true }); } catch { }
      for (const a of accts) if (a.isDirectory()) { let fs2 = []; try { fs2 = await fsp.readdir(path.join(dir, a.name)); } catch { } for (const f of fs2) if (/\.fl$/i.test(f)) { try { const st = await fsp.stat(path.join(dir, a.name, f)); list.push({ acct: a.name, name: f, size: st.size, modified: st.mtime.toISOString() }); } catch { } } }
      list.sort((x, y) => y.modified.localeCompare(x.modified));
      return send(res, 200, { dir, saves: list });
    }
    const acct = path.basename(url.searchParams.get('acct') || ''), name = path.basename(url.searchParams.get('name') || '');
    if (!acct || !/\.fl$/i.test(name)) return send(res, 400, { error: 'bad name' });
    const p = path.join(dir, acct, name);
    if (req.method === 'GET') { try { return send(res, 200, await fsp.readFile(p), 'application/octet-stream'); } catch { return send(res, 404, { error: 'not found' }); } }
    const body = await readBody(req);
    try { await fsp.access(p); const bdir = path.join(config.installDir, 'editor_backups', SESSION, '_mpsaves', acct); await fsp.mkdir(bdir, { recursive: true }); await fsp.copyFile(p, path.join(bdir, name)); } catch { }
    await fsp.writeFile(p, body);
    return send(res, 200, { ok: true, path: p });
  }
  if (route === 'launch') { // start the game (EXE\Freelancer.exe) and report when it exits
    if (req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const which = body.target === 'server' ? 'FLServer.exe' : 'Freelancer.exe';
      const exe = resolveCI(config.installDir, 'EXE/' + which);
      if (!exe) return send(res, 404, { error: 'EXE\\' + which + ' not found' });
      const args = String(body.args || '').split(/\s+/).filter(Boolean);
      try {
        const child = require('child_process').spawn(exe, args, { cwd: path.dirname(exe), detached: true, stdio: 'ignore' });
        const rec = { pid: child.pid, started: Date.now(), running: true, code: null };
        launches.set(child.pid, rec);
        child.on('exit', (code) => { rec.running = false; rec.code = code; rec.ended = Date.now(); });
        child.on('error', (e) => { rec.running = false; rec.error = String(e); });
        child.unref();
        return send(res, 200, rec);
      } catch (e) { return send(res, 500, { error: String(e) }); }
    }
    const rec = launches.get(parseInt(url.searchParams.get('pid'))); return rec ? send(res, 200, rec) : send(res, 404, { error: 'unknown pid' });
  }
  // one pass over every text INI under DATA (and EXE for freelancer.ini/dacom.ini): reused by the
  // pre-flight check and the ID tools. Returns the INI lines as [file, line, section, key, value].
  if (route === 'iniscan') {
    const want = (url.searchParams.get('what') || 'ids,paths,keys').split(',');
    const out = { files: 0, bini: [], ids: {}, paths: [], empty: [], keys: {} };
    const roots = ['DATA', 'EXE'].map(r => resolveCI(config.installDir, r)).filter(Boolean);
    const exists = new Map();
    const fileExists = (rel) => { const k = rel.toLowerCase(); if (!exists.has(k)) exists.set(k, !!resolveCI(config.installDir, rel)); return exists.get(k); };
    const emptyCache = new Map(); // referenced files that exist but have 0 bytes (Discovery ships some placeholders)
    const fileEmpty = (rel) => { const k = rel.toLowerCase(); if (!emptyCache.has(k)) { let e = false; try { const p = resolveCI(config.installDir, rel); e = !!p && fs.statSync(p).size === 0; } catch { } emptyCache.set(k, e); } return emptyCache.get(k); };
    const FILE_RX = /^[\w .$\-\\/]+\.(cmp|3db|sph|mat|txm|ale|thn|wav|utf|dfm|anm|ini|vms|sur|lua|txt|dll|tga|dds|bmp|mp3)$/i;
    const walk = async (dir, top) => {
      let ents = []; try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (top !== 'EXE') await walk(p, top); continue; }
        if (!/\.ini$/i.test(e.name)) continue;
        const t = await readIniCached(p); if (t == null) continue;
        const rel = path.relative(config.installDir, p).split(path.sep).join('/');
        if (t === 'BINI') { out.bini.push(rel); continue; }
        out.files++;
        let sec = '';
        const lines = t.lines;
        for (let i = 0; i < lines.length; i++) {
          const raw = lines[i]; const m = /^\s*\[([^\]]+)\]/.exec(raw); if (m) { sec = m[1].trim(); continue; }
          const eq = raw.indexOf('='); if (eq < 0) continue;
          const key = raw.slice(0, eq).trim(); if (!key || key.startsWith(';')) continue;
          let val = raw.slice(eq + 1); const sc = val.indexOf(';'); if (sc >= 0) val = val.slice(0, sc); val = val.trim();
          if (want.includes('keys')) { const k = sec.toLowerCase() + '|' + key.toLowerCase(); const o = out.keys[k]; if (o) o[2]++; else out.keys[k] = [rel, i + 1, 1, sec, key]; }
          if (want.includes('ids') && /(^|_)ids($|_)|^strid|^ids|_ids\d*$|ids_info\d*$/i.test(key)) {
            for (const v of val.split(',')) { const n = parseInt(v, 10); if (n > 0 && /^\s*\d+\s*$/.test(v)) { const a = out.ids[n] || (out.ids[n] = []); if (a.length < 6) a.push([rel, i + 1, key]); else a[5] = [a[5][0], a[5][1], a[5][2], (a[5][3] || 1) + 1]; } }
          }
          if (want.includes('paths')) for (const v0 of val.split(',')) {
            const v = v0.trim(); if (!v || !FILE_RX.test(v) || !/[\\/]/.test(v)) continue;
            // paths in INIs are relative to DATA (a few, in freelancer.ini, to EXE)
            const rp = (top === 'EXE' ? (/^\.\.[\\/]/.test(v) ? v.replace(/^\.\.[\\/]/, '') : 'EXE/' + v) : 'DATA/' + v).replace(/\\/g, '/');
            if (!fileExists(rp) && !fileExists('DATA/' + v.replace(/\\/g, '/'))) out.paths.push([rel, i + 1, sec, key, v]);
            else if (fileEmpty(fileExists(rp) ? rp : 'DATA/' + v.replace(/\\/g, '/'))) out.empty.push([rel, i + 1, sec, key, v]);
          }
        }
      }
    };
    for (const r of roots) await walk(r, path.basename(r).toUpperCase());
    return send(res, 200, out);
  }
  if (route === 'delete') { // remove a file (backed up first); used by mod uninstall for files a mod added
    if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
    const abs = resolveCI(config.installDir, rel);
    if (!abs || !inside(config.installDir, abs) || !rel) return send(res, 404, { error: 'not found' });
    try { await backup(abs); await fsp.unlink(abs); let d = path.dirname(abs); while (inside(config.installDir, d)) { invalidate(d); if (d === config.installDir) break; d = path.dirname(d); } return send(res, 200, { ok: true }); }
    catch (e) { return send(res, 500, { error: String(e) }); }
  }
  if (route === 'testkit-report') { // in-game test kit results: kept outside the tracked changes so a revert does not remove them
    const f = path.join(config.installDir, 'editor_testkit_report.txt');
    if (req.method === 'POST') { await fsp.writeFile(f, await readBody(req)); return send(res, 200, { ok: true, path: f }); }
    try { return send(res, 200, await fsp.readFile(f), 'text/plain; charset=utf-8'); } catch { return send(res, 404, { error: 'no report' }); }
  }
  if (route === 'changes') return send(res, 200, await changedFiles());
  // after a mod update: the old originals no longer describe the game files, so move editor_backups aside
  // (never deleted) and start backing up again from the files as they are now
  if (route === 'new-baseline' && req.method === 'POST') {
    const src = path.join(config.installDir, 'editor_backups');
    const dstRoot = path.join(config.installDir, 'editor_backups_old');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    let moved = false;
    try { await fsp.access(src); await fsp.mkdir(dstRoot, { recursive: true }); await fsp.rename(src, path.join(dstRoot, stamp)); moved = true; } catch (e) { if (e.code !== 'ENOENT') return send(res, 500, { error: String(e.message || e) }); }
    backedUp.clear();
    return send(res, 200, { moved, to: moved ? `editor_backups_old/${stamp}` : null });
  }
  if (route.startsWith('snapshot')) return snapshots(req, res, route, url);
  return send(res, 404, { error: 'unknown api' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    let p = decodeURIComponent(url.pathname);
    if (p === '/') p = '/index.html';
    const abs = path.join(PUBLIC, p);
    if (!inside(PUBLIC, abs)) return send(res, 403, 'forbidden', 'text/plain');
    fs.readFile(abs, (err, data) => {
      if (err) return send(res, 404, 'not found', 'text/plain');
      send(res, 200, data, MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream');
    });
  } catch (e) { send(res, 500, { error: String(e) }); }
});

// start(): used by the CLI below and by the VS Code extension (vscode/extension.js)
let onInstallDir = null; // host hook (VS Code extension saves the choice in its settings)
function start({ installDir, port = PORT, open = !NO_OPEN, quiet = false, onInstallChange = null } = {}) {
  onInstallDir = onInstallChange;
  if (installDir) { const d = path.resolve(installDir); if (looksLikeInstall(d)) { config.installDir = d; dirCache.clear(); } }
  return new Promise((resolve, reject) => {
    const onErr = (e) => {
      if (e.code === 'EADDRINUSE' && !quiet) { console.log(`Port ${port} busy — editor probably already running: http://localhost:${port}/`); if (open && process.platform === 'win32') exec(`start "" "http://localhost:${port}/"`); }
      reject(e);
    };
    server.once('error', onErr);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onErr);
      const actual = server.address().port, url = `http://localhost:${actual}/`;
      if (!quiet) {
        console.log('Freelancer System Editor');
        console.log('  install : ' + (config.installDir || '(not found - choose it in the editor)'));
        console.log('  backups : ' + (config.installDir ? path.join(config.installDir, 'editor_backups', SESSION) : '-'));
        console.log('  open    : ' + url);
        console.log('Close this window to stop the editor.');
      }
      if (open) {
        const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open ${url}` : `xdg-open ${url}`;
        exec(cmd, () => { });
      }
      resolve({ url, port: actual, installDir: config.installDir, close: () => new Promise(r => server.close(() => r())) });
    });
  });
}
module.exports = { start, getInstallDir: () => config.installDir };
if (require.main === module) start().catch(e => { if (e.code !== 'EADDRINUSE') console.error(e); });
