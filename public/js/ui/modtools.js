// Mod packages (File menu): export your changes as a .zip mod, install mods with conflict detection and a
// three-way merge for INI files, uninstall them again, and see which installed mods touch the same files.
//
// Package layout:  fl-mod.json (manifest) · files at their install paths (DATA/…, EXE/…) ·
//                  _base/<path> = the file as it was before the change (INI/text only) — the merge base.
// Installed mods are recorded in <game>\editor_mods\<id>.json; the file each install replaced is kept in
// <game>\editor_mods\<id>\original\<path> so uninstall can put it back.
import { h, modal, toast, confirmDialog } from './dom.js';
import { api } from '../api.js';
import { writeZip, readZip, crc32 } from '../formats/zip.js';
import { diffLines } from './changes.js';

const lc = (s) => String(s || '').toLowerCase();
const TEXT = /\.(ini|txt|xml|cfg|lua)$/i;
const dec = (u8) => new TextDecoder('windows-1252').decode(u8);
const enc = (s) => { const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); u[i] = c < 256 ? c : 63; } return u; };
const hex = (n) => n == null ? '—' : (n >>> 0).toString(16).padStart(8, '0');
const slug = (s) => lc(s).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'mod';
const isBini = (u8) => u8 && u8.length >= 4 && u8[0] === 0x42 && u8[1] === 0x49 && u8[2] === 0x4E && u8[3] === 0x49;

// ---------- three-way line merge ----------
function hunksOf(base, other) {
  const ops = diffLines(base, other); if (!ops) return null;
  const out = []; let cur = null;
  for (const o of ops) {
    if (o.op === ' ') { if (cur) { out.push(cur); cur = null; } continue; }
    if (!cur) cur = { start: o.a, end: o.a, lines: [] };
    if (o.op === '-') cur.end = o.a + 1; else cur.lines.push(o.line);
  }
  if (cur) out.push(cur);
  return out;
}
export function merge3(baseT, oursT, theirsT) {
  const split = (t) => t.split(/\r?\n/);
  const base = split(baseT), A = hunksOf(base, split(oursT)), B = hunksOf(base, split(theirsT));
  if (!A || !B) return { ok: false, conflicts: [{ line: 1, why: 'files too different to merge' }] };
  const all = [...A.map(x => ({ ...x, side: 'ours' })), ...B.map(x => ({ ...x, side: 'theirs' }))].sort((x, y) => x.start - y.start || x.end - y.end);
  const out = [], conflicts = []; let pos = 0, i = 0;
  while (i < all.length) {
    let grp = [all[i]], gEnd = all[i].end, j = i + 1;
    while (j < all.length && (all[j].start < gEnd || (all[j].start === gEnd && all[j].start === grp[0].start))) { grp.push(all[j]); gEnd = Math.max(gEnd, all[j].end); j++; }
    const gStart = grp[0].start;
    for (; pos < gStart; pos++) out.push(base[pos]);
    const sides = new Set(grp.map(x => x.side));
    if (sides.size === 1) { for (const x of grp) { out.push(...x.lines); } }
    else {
      const render = (side) => { const lines = []; let p = gStart; for (const x of grp.filter(y => y.side === side)) { for (; p < x.start; p++) lines.push(base[p]); lines.push(...x.lines); p = x.end; } for (; p < gEnd; p++) lines.push(base[p]); return lines.join('\n'); };
      const a = render('ours'), b = render('theirs');
      if (a === b) out.push(...a.split('\n'));
      else { conflicts.push({ line: gStart + 1, ours: a, theirs: b }); out.push(...b.split('\n')); }
    }
    pos = Math.max(pos, gEnd); i = j;
  }
  for (; pos < base.length; pos++) out.push(base[pos]);
  return { ok: !conflicts.length, text: out.join('\r\n'), conflicts };
}

async function registry() {
  const ents = await api.ls('editor_mods');
  const out = [];
  for (const e of ents) if (!e.dir && /\.json$/i.test(e.name)) { const b = await api.read('editor_mods/' + e.name); if (b) try { out.push({ file: e.name, ...JSON.parse(new TextDecoder().decode(b)) }); } catch { } }
  return out;
}

export async function modManager(app, { tab: startTab = 'export' } = {}) {
  let tab = startTab;
  const tabs = h('div', { class: 'btnrow' });
  const body = h('div', { style: { height: 'calc(100vh - 260px)', overflow: 'auto', fontSize: '12px', marginTop: '8px' } });
  const m = modal({ title: 'Mods: package, install, conflicts', wide: true, body: h('div', {}, tabs, body), buttons: [{ label: 'Close' }] });
  m.box.classList.add('xwide');
  const show = () => {
    tabs.innerHTML = '';
    for (const [k, l] of [['export', 'Export my changes as a mod'], ['install', 'Install a mod'], ['installed', 'Installed mods & conflicts'], ['patch', 'Update patch' + (app.settings.patchTracking ? ' ✓' : '')]]) tabs.append(h('button', { class: 'btn sm' + (tab === k ? ' primary' : ''), onclick: () => { tab = k; show(); } }, l));
    body.innerHTML = '';
    ({ export: exportTab, install: installTab, installed: installedTab, patch: () => import('./updatepatch.js').then(P => P.patchTab(app, body, show)) })[tab]();
  };

  // ---------------- export ----------------
  async function exportTab() {
    body.append(h('div', { class: 'empty' }, 'Reading changes…'));
    const r = await fetch('/api/changes').then(x => x.json()).catch(() => null);
    body.innerHTML = '';
    const files = (r && r.files || []).filter(f => !f.same && f.curSize != null && !/^editor_/i.test(f.path));
    if (!files.length) { body.append(h('div', { class: 'empty' }, 'No changed files yet — edit something and save first.')); return; }
    const name = h('input', { value: 'My mod', style: { width: '260px' } }), ver = h('input', { value: '1.0', style: { width: '80px' } }), author = h('input', { placeholder: 'author', style: { width: '200px' } });
    const desc = h('textarea', { rows: 3, style: { width: '100%' }, placeholder: 'What the mod does (shown when installing)' });
    const checks = files.map(f => ({ f, cb: h('input', { type: 'checkbox', checked: true }) }));
    body.append(
      h('div', { class: 'btnrow', style: { alignItems: 'center', flexWrap: 'wrap' } }, 'Name', name, 'Version', ver, 'Author', author), desc,
      h('div', { style: { color: 'var(--faint)', margin: '6px 0' } }, `${files.length} file${files.length === 1 ? '' : 's'} changed or created by the editor (compared with the oldest backup). Untick what should not be in the mod.`),
      h('div', {}, checks.map(({ f, cb }) => h('label', { style: { display: 'grid', gridTemplateColumns: '22px 1fr auto', gap: '6px', padding: '1px 0' } }, cb, h('span', {}, f.path), h('span', { style: { color: 'var(--faint)' } }, f.created ? 'new file' : `${f.origSize} → ${f.curSize} bytes`)))),
      h('div', { class: 'btnrow', style: { marginTop: '8px' } }, h('button', { class: 'btn primary', onclick: async () => {
        const sel = checks.filter(c => c.cb.checked).map(c => c.f); if (!sel.length) return toast('Nothing selected');
        const zipFiles = [], manifest = { format: 'fl-system-editor-mod/1', name: name.value.trim() || 'mod', version: ver.value.trim(), author: author.value.trim(), description: desc.value.trim(), created: new Date().toISOString(), files: [] };
        for (const f of sel) {
          const cur = new Uint8Array(await api.read(f.path)); const orig = f.backup ? new Uint8Array(await api.read(f.backup) || []) : null;
          zipFiles.push({ name: f.path, data: cur });
          if (orig && orig.length && TEXT.test(f.path) && !isBini(orig)) zipFiles.push({ name: '_base/' + f.path, data: orig });
          manifest.files.push({ path: f.path, size: cur.length, crc: crc32(cur), origCrc: orig && orig.length ? crc32(orig) : null });
        }
        zipFiles.unshift({ name: 'fl-mod.json', data: new TextEncoder().encode(JSON.stringify(manifest, null, 1)) });
        zipFiles.push({ name: 'README.txt', data: new TextEncoder().encode(`${manifest.name} ${manifest.version}${manifest.author ? ' by ' + manifest.author : ''}\r\n\r\n${manifest.description}\r\n\r\nInstall with the Freelancer System Editor (File > Mods > Install a mod) for conflict checks and uninstall,\r\nor copy the DATA and EXE folders over your Freelancer folder (back up first).\r\n`) });
        const zip = await writeZip(zipFiles);
        const fn = slug(manifest.name) + '-' + (manifest.version || '1') + '.zip';
        await api.write('editor_exports/' + fn, zip);
        const a = h('a', { href: URL.createObjectURL(new Blob([zip], { type: 'application/zip' })), download: fn }); document.body.append(a); a.click(); a.remove();
        toast(`${fn}: ${sel.length} files, ${(zip.length / 1024).toFixed(0)} KB — also saved to editor_exports`, 5000);
      } }, 'Build mod .zip'),
        h('button', { class: 'btn primary', title: 'A zip players can install without the editor: install.cmd / uninstall.cmd with backups and version checks', onclick: async () => {
          const sel = checks.filter(c => c.cb.checked).map(c => c.f); if (!sel.length) return toast('Nothing selected');
          const M = await import('./modinstaller.js');
          const r2 = await M.buildPlayerPackage({ name: name.value.trim() || 'My mod', version: ver.value.trim() || '1.0', author: author.value.trim(), description: desc.value.trim(), files: await M.filesFromChanges(sel) });
          await api.write('editor_exports/' + r2.fileName, r2.zip);
          const a = h('a', { href: URL.createObjectURL(new Blob([r2.zip], { type: 'application/zip' })), download: r2.fileName }); document.body.append(a); a.click(); a.remove();
          toast(`${r2.fileName}: player installer with ${sel.length} files, ${(r2.zip.length / 1024).toFixed(0)} KB — also saved to editor_exports`, 6000);
        } }, 'Build player installer (.zip)')),
      h('div', { style: { color: 'var(--faint)', fontSize: '12px', marginTop: '6px' } }, 'Mod .zip: for other editor users (File → Mods → Install, with merge). Player installer: for players without the editor — unpack and double-click install.cmd; uninstall.cmd restores the originals.'));
  }

  // ---------------- install ----------------
  function installTab() {
    const inp = h('input', { type: 'file', accept: '.zip' });
    const out = h('div', { style: { marginTop: '8px' } });
    body.append(h('div', {}, 'Choose a mod .zip (made with this editor, or any zip with DATA\\ / EXE\\ folders): ', inp), out);
    inp.onchange = async () => {
      out.innerHTML = 'Reading…';
      let entries; try { entries = await readZip(new Uint8Array(await inp.files[0].arrayBuffer())); } catch (e) { out.textContent = '✖ ' + e.message; return; }
      const man = entries.find(e => lc(e.name) === 'fl-mod.json');
      let manifest = man ? JSON.parse(new TextDecoder().decode(man.data)) : null;
      // a plain zip: find the folder that holds DATA/ or EXE/
      const strip = (() => { if (manifest) return ''; const p = entries.map(e => e.name).find(n => /(^|\/)(data|exe)\//i.test(n)); const m2 = p && /^(.*?)(data|exe)\//i.exec(p); return m2 ? m2[1] : ''; })();
      const files = entries.filter(e => !/^_base\//i.test(e.name) && !/^(fl-mod\.json|readme\.txt)$/i.test(e.name)).map(e => ({ path: e.name.slice(strip.length), data: e.data })).filter(e => /^(data|exe)\//i.test(e.path));
      const base = new Map(entries.filter(e => /^_base\//i.test(e.name)).map(e => [lc(e.name.slice(6)), e.data]));
      if (!manifest) manifest = { name: inp.files[0].name.replace(/\.zip$/i, ''), version: '', files: files.map(f => ({ path: f.path, crc: crc32(f.data), origCrc: undefined })) };
      const id = slug(manifest.name);
      const reg = await registry();
      const plan = [];
      for (const f of files) {
        const mf = (manifest.files || []).find(x => lc(x.path) === lc(f.path)) || {};
        const curB = await api.read(f.path); const cur = curB ? new Uint8Array(curB) : null;
        const curCrc = cur ? crc32(cur) : null, newCrc = crc32(f.data);
        const others = reg.filter(r => r.id !== id && (r.files || []).some(x => lc(x.path) === lc(f.path))).map(r => r.name);
        let status, action = 'write', merged = null;
        if (curCrc === newCrc) { status = 'already identical'; action = 'skip'; }
        else if (!cur) status = 'new file';
        else if (mf.origCrc === undefined) status = 'replaces your file (no original recorded in this zip)';
        else if (mf.origCrc === curCrc) status = 'clean (your file is the one the mod was made from)';
        else {
          const b = base.get(lc(f.path));
          if (b && TEXT.test(f.path) && !isBini(cur)) {
            const r3 = merge3(dec(b), dec(cur), dec(f.data));
            if (r3.ok) { status = 'merged with your changes (three-way)'; merged = enc(r3.text); }
            else { status = `CONFLICT: ${r3.conflicts.length} place(s) changed both by you and by the mod — the mod's version wins there`; merged = enc(r3.text); }
          } else status = 'CONFLICT: your file differs from the one the mod was made from';
        }
        plan.push({ ...f, cur, curCrc, newCrc, status, action, merged, others, cb: h('input', { type: 'checkbox', checked: action !== 'skip' }) });
      }
      out.innerHTML = '';
      out.append(h('div', { style: { margin: '4px 0' } }, h('b', {}, `${manifest.name} ${manifest.version || ''}`), manifest.author ? ` by ${manifest.author}` : '', manifest.description ? h('div', { style: { color: 'var(--dim)', whiteSpace: 'pre-wrap' } }, manifest.description) : null),
        reg.some(r => r.id === id) ? h('div', { class: 'sev-warn' }, 'A mod with this name is installed already — uninstall it first or the old record is replaced.') : null,
        h('div', {}, plan.map(p => h('label', { style: { display: 'grid', gridTemplateColumns: '22px 1.2fr 1.6fr', gap: '6px', padding: '2px 0', borderBottom: '1px solid var(--line, #222)' } }, p.cb, h('span', {}, p.path),
          h('span', { style: { color: /CONFLICT/.test(p.status) ? '#ffb366' : /merged/.test(p.status) ? '#7ee2a0' : 'var(--dim)' } }, p.status, p.others.length ? h('div', { style: { color: '#ffb366' } }, 'also changed by: ' + p.others.join(', ')) : null)))),
        h('div', { class: 'btnrow', style: { marginTop: '8px' } }, h('button', { class: 'btn primary', onclick: async () => {
          const go = plan.filter(p => p.cb.checked);
          if (!go.length) return toast('Nothing to install');
          if (go.some(p => /CONFLICT/.test(p.status)) && !await confirmDialog('Conflicts', 'Some files conflict with your current files. Install anyway? Your current versions are kept in editor_mods for uninstall.', 'Install', true)) return;
          const rec = { id, name: manifest.name, version: manifest.version, author: manifest.author, installed: new Date().toISOString(), files: [] };
          for (const p of go) {
            const data = p.merged || p.data;
            let stash = null;
            if (p.cur) { stash = `editor_mods/${id}/original/${p.path}`; await api.write(stash, p.cur); }
            await api.write(p.path, data);
            rec.files.push({ path: p.path, crc: crc32(data), prevCrc: p.curCrc, stash });
          }
          await api.write(`editor_mods/${id}.json`, new TextEncoder().encode(JSON.stringify(rec, null, 1)));
          toast(`Installed ${manifest.name}: ${go.length} files — reload the editor to see the changes`, 5000);
          tab = 'installed'; show();
        } }, 'Install')));
    };
  }

  // ---------------- installed ----------------
  async function installedTab() {
    const reg = await registry();
    if (!reg.length) { body.append(h('div', { class: 'empty' }, 'No mods installed with the editor.')); return; }
    // files touched by more than one mod
    const byFile = new Map(); for (const r of reg) for (const f of r.files || []) { const k = lc(f.path); if (!byFile.has(k)) byFile.set(k, { path: f.path, mods: [] }); byFile.get(k).mods.push(r.name); }
    const shared = [...byFile.values()].filter(x => x.mods.length > 1);
    for (const r of reg) {
      const rows = [];
      let changed = 0;
      for (const f of r.files || []) {
        const b = await api.read(f.path); const c = b ? crc32(new Uint8Array(b)) : null;
        const st = c === f.crc ? 'as installed' : c == null ? 'missing' : 'changed since install';
        if (st !== 'as installed') changed++;
        rows.push(h('div', { style: { display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: '6px' } }, h('span', {}, f.path), h('span', { style: { color: st === 'as installed' ? 'var(--dim)' : '#ffb366' } }, st + (f.stash ? '' : ' · added by the mod'))));
      }
      body.append(h('div', { style: { border: '1px solid var(--line, #263040)', borderRadius: '6px', padding: '8px', margin: '0 0 8px' } },
        h('div', { class: 'btnrow', style: { alignItems: 'center' } }, h('b', {}, `${r.name} ${r.version || ''}`), h('span', { style: { color: 'var(--faint)' } }, `${(r.files || []).length} files · installed ${String(r.installed).slice(0, 16).replace('T', ' ')}`), h('span', { style: { flex: '1' } }),
          h('button', { class: 'btn sm danger', onclick: async () => {
            if (!await confirmDialog('Uninstall', `Uninstall ${r.name}? Files are put back as they were before the install.${changed ? `\n\n${changed} file(s) changed after the install — those changes are lost.` : ''}`, 'Uninstall', true)) return;
            for (const f of r.files || []) {
              if (f.stash) { const b = await api.read(f.stash); if (b) await api.write(f.path, new Uint8Array(b)); }
              else await fetch('/api/delete?p=' + encodeURIComponent(f.path), { method: 'POST' });
            }
            await fetch('/api/delete?p=' + encodeURIComponent('editor_mods/' + r.file), { method: 'POST' });
            toast(`Uninstalled ${r.name}`); show();
          } }, 'Uninstall')),
        h('div', { style: { marginTop: '4px' } }, rows)));
    }
    body.append(h('h3', {}, 'Files changed by more than one mod'), shared.length ? h('div', {}, shared.map(x => h('div', {}, h('b', {}, x.path), ' — ', x.mods.join(', ')))) : h('div', { class: 'empty' }, 'None — the installed mods do not overlap.'));
  }
  show();
}
