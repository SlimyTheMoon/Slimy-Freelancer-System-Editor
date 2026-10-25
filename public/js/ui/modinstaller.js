// Player installer package (File → Mods → Export): a zip players can use without the editor.
//   <mod>-<version>/install.cmd · uninstall.cmd · check.cmd   → run installer.ps1 (Windows PowerShell 5.1+)
//   <mod>-<version>/mod.json   name, version, author, description and per file: path, SHA-256 of the mod's file,
//                              SHA-256 of the original it replaces (null = the mod adds the file)
//   <mod>-<version>/files/…    the files at their install paths (DATA\…, EXE\…)
// The script finds the Freelancer folder (the package's own location, the registry, common folders or a folder
// dialog), refuses while Freelancer/FLServer runs, shows what will happen, warns when a file is not the one the
// mod was made for, backs up every replaced file to <Freelancer>\mod_backups\<id>\, verifies each copy and rolls
// back on failure; uninstall restores the originals (asking about files changed since the install).
import { writeZip } from '../formats/zip.js';
import { api } from '../api.js';

const crlf = (s) => s.replace(/\r?\n/g, '\r\n');
const u8 = (s) => new TextEncoder().encode(s);
export const slugId = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'mod';
export async function sha256(bytes) { const d = await crypto.subtle.digest('SHA-256', bytes); return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join(''); }

// files: [{ path, data (Uint8Array), original (Uint8Array|null) }]
export async function buildPlayerPackage({ name, version = '1.0', author = '', description = '', files }) {
  const id = slugId(name), folder = `${id}-${String(version || '1').replace(/[^\w.-]+/g, '_')}`;
  const manifest = { format: 'fl-player-mod/1', id, name, version, author, description, created: new Date().toISOString(), files: [] };
  const zip = [];
  for (const f of files) {
    const path = f.path.replace(/\\/g, '/');
    manifest.files.push({ path, size: f.data.length, sha256: await sha256(f.data), original: f.original && f.original.length ? await sha256(f.original) : null });
    zip.push({ name: `${folder}/files/${path}`, data: f.data });
  }
  const ps = await fetch('/installer/installer.ps1').then(r => r.text());
  // a dragged-in folder may end in \ — that would escape the closing quote for PowerShell, so strip it
  const cmd = (action) => crlf(['@echo off', `rem ${name} ${version} - ${action}`, 'setlocal', 'set "GD=%~1"', 'if defined GD if "%GD:~-1%"=="\\" set "GD=%GD:~0,-1%"',
    `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer.ps1" -Action ${action} -GameDir "%GD%"`, 'echo.', 'pause', ''].join('\n'));
  zip.push({ name: `${folder}/mod.json`, data: u8(JSON.stringify(manifest, null, 1)) });
  zip.push({ name: `${folder}/installer.ps1`, data: new Uint8Array([0xEF, 0xBB, 0xBF, ...u8(crlf(ps))]) });
  zip.push({ name: `${folder}/install.cmd`, data: u8(cmd('install')) });
  zip.push({ name: `${folder}/uninstall.cmd`, data: u8(cmd('uninstall')) });
  zip.push({ name: `${folder}/check.cmd`, data: u8(cmd('check')) });
  const added = manifest.files.filter(f => !f.original).length;
  zip.push({ name: `${folder}/README.txt`, data: u8(crlf(`${name} ${version}${author ? ' by ' + author : ''}
${description ? '\n' + description + '\n' : ''}
INSTALL
  1. Close Freelancer.
  2. Unpack this folder anywhere (for example into your Freelancer folder).
  3. Double-click install.cmd. It finds your Freelancer folder (or asks for it), shows what it will change,
     backs up every file it replaces and checks every copied file.
     If it cannot find the game, drag your Freelancer folder onto install.cmd, or run:
         install.cmd "C:\\path\\to\\Freelancer"

UNINSTALL
  Double-click uninstall.cmd. It puts back every original file and removes the files the mod added.

CHECK FIRST
  check.cmd only reports what installing would do - nothing is changed.

This mod changes ${manifest.files.length - added} file(s) and adds ${added}. Backups: <Freelancer>\\mod_backups\\${id}\\
If Windows asks whether to run the script, choose "Run" / "More info > Run anyway" (it is a plain text
PowerShell script you can read in installer.ps1).

Made with the Freelancer System Editor.
`)) });
  return { zip: await writeZip(zip), fileName: `${folder}.zip`, manifest };
}

// read the editor's changed files (as Mods → Export does) into the package input
export async function filesFromChanges(sel) {
  const out = [];
  for (const f of sel) { const data = new Uint8Array(await api.read(f.path)); const original = f.backup ? new Uint8Array(await api.read(f.backup) || []) : null; out.push({ path: f.path, data, original }); }
  return out;
}
