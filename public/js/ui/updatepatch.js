// Update-safe patches (ui/updatepatch.js; ui/patches.js is the separate exe/dll hex patch manager): your edits recorded as individual changes (INI sections and keys, strings and
// infocards, whole files for models/textures) instead of whole files, so they can be put back on top of a
// new version of the mod (e.g. after a Discovery update) without undoing what the update changed.
//
// Optional (Mods dialog → "Update patch"): when switched on, every save refreshes
// <game>\editor_patches\my-changes.flpatch.json, and the editor notices at start-up when files of the
// patch were replaced outside the editor (a mod update) and offers to re-apply.
import { h, modal, toast, confirmDialog } from './dom.js';
import { api } from '../api.js';
import { IniDocument } from '../formats/ini.js';
import { readDll, extractText } from '../formats/dll.js';

export const PATCH_FILE = 'editor_patches/my-changes.flpatch.json';
const HISTORY_SLOTS = 10;
const FORMAT = 'fl-system-editor-patch/1';
const isIni = (p) => /\.ini$/i.test(p);
const isDll = (p) => /\.dll$/i.test(p);
const lc = (s) => String(s || '').toLowerCase();
const saveSettings = (s) => { try { localStorage.setItem('fled.settings', JSON.stringify(s)); } catch { } };

// ---------------------------------------------------------------- small helpers
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => { const b = atob(s); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
export async function sha(u8) { const d = await crypto.subtle.digest('SHA-256', u8); return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join(''); }
async function readBytes(p) { const b = await api.read(p); return b ? new Uint8Array(b) : null; }

// ---------------------------------------------------------------- section identity
// A section is found again in another version of the file by its name plus nickname (or another identifying
// key). Repeated nicknames (e.g. [MRoom] bar under every [MBase]) are told apart by the container they follow.
const IDENT = ['nickname', 'base', 'headline', 'ids_name', 'name', 'id', 'file'];
const CONTAINERS = new Set(['mbase', 'base', 'system', 'mission', 'faction', 'ship', 'room']);
export function sectionIds(ini) {
  const keyOf = (s) => { for (const k of IDENT) { const v = s.get(k); if (v) return `${k}=${lc(v.trim())}`; } return ''; };
  const count = new Map(); for (const s of ini.sections) { const k = lc(s.name) + '|' + keyOf(s); count.set(k, (count.get(k) || 0) + 1); }
  const ids = new Map(), since = new Map(); let anchor = '^';
  for (const s of ini.sections) {
    const nm = lc(s.name), k = keyOf(s), base = k ? `${nm}{${k}}` : nm;
    const unique = k && count.get(nm + '|' + k) === 1;
    let id = base;
    if (!unique) { const key = anchor + '>' + base; const c = (since.get(key) || 0) + 1; since.set(key, c); id = `${base}@${anchor}#${c}`; }
    ids.set(s, id);
    if (unique && CONTAINERS.has(nm)) anchor = id;
  }
  return ids;
}
const entryList = (s) => s.entries.map(e => [e.key, e.value]);
function keyVals(s) { const m = new Map(); for (const e of s.entries) { const k = lc(e.key); if (!m.has(k)) m.set(k, { key: e.key, vals: [] }); m.get(k).vals.push(e.value.trim()); } return m; }
const norm = (v) => v == null ? null : String(v).replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').trim().toLowerCase();
const same = (a, b) => norm(a) === norm(b);
function multisetDiff(a, b) { const left = [...b]; const removed = []; for (const v of a) { const i = left.findIndex(x => same(x, v)); if (i >= 0) left.splice(i, 1); else removed.push(v); } return { removed, added: left }; }

function diffSection(o, c) {
  const ops = [], A = keyVals(o), B = keyVals(c);
  for (const k of new Set([...A.keys(), ...B.keys()])) {
    const a = A.get(k)?.vals || [], b = B.get(k)?.vals || [], key = (B.get(k) || A.get(k)).key;
    if (a.length === b.length && a.every((v, i) => same(v, b[i]))) continue;
    if (a.length <= 1 && b.length <= 1) ops.push({ op: 'set', key, old: a[0] ?? null, new: b[0] ?? null });
    else {
      // repeated keys (MarketGood, equip, fixture…): a line whose first value is unique on both sides is one
      // item (commodity_boron, 0, -1, … 1.3 → … 1.9 is a price change, not a removal plus an addition)
      const d = multisetDiff(a, b), first = (v) => lc(String(v).split(',')[0].trim());
      const uniq = (list, k) => list.filter(v => first(v) === k).length === 1;
      for (const r of [...d.removed]) {
        const k = first(r), m = d.added.find(v => first(v) === k);
        if (k && m && uniq(d.removed, k) && uniq(d.added, k) && uniq(a, k) && uniq(b, k)) { ops.push({ op: 'item', key, item: k, old: r, new: m }); d.removed.splice(d.removed.indexOf(r), 1); d.added.splice(d.added.indexOf(m), 1); }
      }
      if (d.removed.length || d.added.length) ops.push({ op: 'list', key, ...d });
    }
  }
  return ops;
}
export function diffIni(origIni, curIni) {
  const io = sectionIds(origIni), ic = sectionIds(curIni);
  const byO = new Map([...io].map(([s, id]) => [id, s])), byC = new Map([...ic].map(([s, id]) => [id, s]));
  const out = []; let prev = null;
  for (const s of curIni.sections) {
    const id = ic.get(s), o = byO.get(id);
    if (o) { const ops = diffSection(o, s); if (ops.length) out.push({ t: 'mod', id, name: s.name, ops, full: entryList(s) }); }
    else out.push({ t: 'add', id, name: s.name, lines: entryList(s), after: prev });
    prev = id;
  }
  for (const s of origIni.sections) { const id = io.get(s); if (!byC.has(id)) out.push({ t: 'del', id, name: s.name, lines: entryList(s) }); }
  return out;
}

// ---------------------------------------------------------------- build
export async function buildPatch(app, { name = 'My changes' } = {}) {
  const r = await fetch('/api/changes').then(x => x.json()).catch(() => null);
  const files = (r && r.files || []).filter(f => !f.same && f.curSize != null && !/^editor_/i.test(f.path));
  const patch = { format: FORMAT, name, created: new Date().toISOString(), files: [], stats: { files: 0, changes: 0 } };
  for (const f of files) {
    const cur = await readBytes(f.path); if (!cur) continue;
    const orig = f.backup ? await readBytes(f.backup) : null;
    const mineHash = await sha(cur);
    if (!orig) { patch.files.push({ path: f.path, kind: 'new', mineHash, data: b64(cur) }); patch.stats.changes++; continue; }
    const origHash = await sha(orig);
    if (isIni(f.path)) {
      try {
        const sections = diffIni(IniDocument.fromBytes(orig, f.path), IniDocument.fromBytes(cur, f.path));
        if (!sections.length) continue;
        patch.files.push({ path: f.path, kind: 'ini', origHash, mineHash, sections });
        patch.stats.changes += sections.reduce((n, s) => n + (s.ops ? s.ops.length : 1), 0);
        continue;
      } catch (e) { console.warn('patch: ini diff failed, storing whole file', f.path, e); }
    }
    if (isDll(f.path)) {
      try {
        const a = extractText(readDll(orig).tree), b = extractText(readDll(cur).tree), texts = [];
        for (const [t, A, B] of [['s', a.strings, b.strings], ['i', a.infocards, b.infocards]])
          for (const id of new Set([...A.keys(), ...B.keys()])) { const x = A.get(id) || '', y = B.get(id) || ''; if (x !== y) texts.push({ t, id, old: x, new: y }); }
        if (texts.length) { patch.files.push({ path: f.path, kind: 'dll', origHash, mineHash, texts }); patch.stats.changes += texts.length; }
        continue;
      } catch (e) { console.warn('patch: dll diff failed, storing whole file', f.path, e); }
    }
    patch.files.push({ path: f.path, kind: 'file', origHash, mineHash, data: b64(cur) }); patch.stats.changes++;
  }
  patch.stats.files = patch.files.length;
  return patch;
}

// ---------------------------------------------------------------- plan (what would happen) and apply
// every item: { file, where, what, status: 'apply'|'same'|'conflict'|'error', base, update, mine, choice, run(choice) }
export async function planPatch(app, patch) {
  if (!patch || patch.format !== FORMAT) throw new Error('Not an editor patch file');
  await app.loadAllSystemDocs(); // system files must resolve to the docs the editor already has open
  const items = [];
  const vals1 = (sec, key) => { const all = sec.getAll(key); return all.length ? all[0].trim() : null; };
  for (const f of patch.files) {
    if (f.kind === 'ini') {
      const doc = await app.otherDoc(f.path);
      if (!doc) { items.push({ file: f.path, where: '', what: 'file', status: 'error', mine: 'This file does not exist in this version of the game/mod' }); continue; }
      const ids = sectionIds(doc.ini), byId = new Map([...ids].map(([s, id]) => [id, s]));
      const find = (id) => byId.get(id) || null;
      for (const S of f.sections) {
        const where = `[${S.name}] ${S.id.replace(/^[^{]*\{?(?:nickname=)?|\}.*$/g, '') || ''}`.trim();
        if (S.t === 'mod') {
          const sec = find(S.id);
          if (!sec) {
            items.push({ file: f.path, doc, where, what: 'section', status: 'conflict', update: 'removed in this version', mine: S.full.map(([k, v]) => `${k} = ${v}`).join('\n'), choice: 'mine',
              run: (c) => { if (c === 'mine') doc.ini.addSection(S.name, null, S.full); } });
            continue;
          }
          for (const op of S.ops) {
            if (op.op === 'set') {
              const cur = vals1(sec, op.key);
              const st = same(cur, op.new) ? 'same' : same(cur, op.old) ? 'apply' : 'conflict';
              items.push({ file: f.path, doc, where, what: op.key, status: st, base: op.old, update: cur, mine: op.new, choice: 'mine',
                run: (c) => { if (c !== 'mine') return; const s2 = find(S.id); if (op.new == null) s2.remove(op.key); else s2.set(op.key, op.new); } });
            } else if (op.op === 'item') {
              const first = (v) => lc(String(v).split(',')[0].trim());
              const hits = sec.findAll(op.key).filter(e => first(e.value) === op.item), cur = hits.length === 1 ? hits[0].value.trim() : hits.length ? hits.map(e => e.value).join(' | ') : null;
              const st = same(cur, op.new) ? 'same' : same(cur, op.old) ? 'apply' : 'conflict';
              items.push({ file: f.path, doc, where, what: `${op.key} ${op.item}`, status: st, base: op.old, update: cur, mine: op.new, choice: 'mine',
                run: (c) => { if (c !== 'mine') return; const s2 = find(S.id); const hs = s2.findAll(op.key).filter(e => first(e.value) === op.item);
                  if (hs.length) { hs[0].value = op.new; hs[0].raw = null; for (const x of hs.slice(1)) s2.removeEntry(x); } else s2.add(op.key, op.new); } });
            } else {
              const cur = sec.getAll(op.key).map(v => v.trim());
              const toRemove = op.removed.filter(v => cur.some(x => same(x, v))), toAdd = op.added.filter(v => !cur.some(x => same(x, v)));
              items.push({ file: f.path, doc, where, what: `${op.key} (${op.added.length ? '+' + op.added.length : ''}${op.added.length && op.removed.length ? ' ' : ''}${op.removed.length ? '−' + op.removed.length : ''} lines)`,
                status: toRemove.length || toAdd.length ? 'apply' : 'same', mine: [...op.added.map(v => '+ ' + v), ...op.removed.map(v => '− ' + v)].join('\n'), choice: 'mine',
                run: (c) => { if (c !== 'mine') return; const s2 = find(S.id); for (const v of toRemove) { const e = s2.findAll(op.key).find(x => same(x.value, v)); if (e) s2.removeEntry(e); } for (const v of toAdd) s2.add(s2.find(op.key) ? s2.find(op.key).key : op.key, v); } });
            }
          }
        } else if (S.t === 'add') {
          const ex = find(S.id), txt = S.lines.map(([k, v]) => `${k} = ${v}`).join('\n');
          if (ex) {
            const eq = ex.entries.length === S.lines.length && ex.entries.every((e, i) => lc(e.key) === lc(S.lines[i][0]) && same(e.value, S.lines[i][1]));
            items.push({ file: f.path, doc, where, what: 'new section', status: eq ? 'same' : 'conflict', update: ex.entries.map(e => `${e.key} = ${e.value}`).join('\n'), mine: txt, choice: 'mine',
              run: (c) => { if (c !== 'mine' || eq) return; const s2 = find(S.id); s2.lines = s2.lines.filter(l => l.type !== 'entry'); for (const [k, v] of S.lines) s2.add(k, v); } });
          } else items.push({ file: f.path, doc, where, what: 'new section', status: 'apply', mine: txt, choice: 'mine', run: (c) => { if (c === 'mine') doc.ini.addSection(S.name, (S.after && find(S.after)) || null, S.lines); } });
        } else if (S.t === 'del') {
          const ex = find(S.id);
          if (!ex) { items.push({ file: f.path, where, what: 'removed section', status: 'same' }); continue; }
          const eq = ex.entries.length === S.lines.length && ex.entries.every((e, i) => lc(e.key) === lc(S.lines[i][0]) && same(e.value, S.lines[i][1]));
          items.push({ file: f.path, doc, where, what: 'removed section', status: eq ? 'apply' : 'conflict', update: eq ? null : 'changed in this version: ' + ex.entries.slice(0, 4).map(e => `${e.key} = ${e.value}`).join(' · '), mine: '(remove the section)', choice: 'mine',
            run: (c) => { if (c === 'mine') { const s2 = find(S.id); if (s2) doc.ini.removeSection(s2); } } });
        }
      }
    } else if (f.kind === 'dll') {
      const base = f.path.split('/').pop().toLowerCase();
      const d = app.game.dllDocs.find(x => x && x.name.toLowerCase() === base);
      if (!d) { items.push({ file: f.path, what: 'texts', status: 'error', mine: `${base} is not loaded (not listed under [Resources] in freelancer.ini)` }); continue; }
      if (!d.editable) { items.push({ file: f.path, what: 'texts', status: 'error', mine: `${d.name} is read-only: ${d.readOnlyReason}` }); continue; }
      for (const t of f.texts) {
        const map = () => t.t === 'i' ? d.infocards : d.strings, cur = map().get(t.id) || '';
        const st = cur === t.new ? 'same' : cur === t.old ? 'apply' : 'conflict';
        items.push({ file: f.path, doc: d, where: `${t.t === 'i' ? 'infocard' : 'string'} ${d.globalId(t.id)}`, what: 'text', status: st, base: short(t.old), update: short(cur), mine: short(t.new), choice: 'mine',
          run: (c) => { if (c !== 'mine') return; if (t.new) map().set(t.id, t.new); else map().delete(t.id); d.changed(); } });
      }
    } else {
      const cur = await readBytes(f.path), h2 = cur ? await sha(cur) : null;
      const st = h2 === f.mineHash ? 'same' : (f.kind === 'file' && h2 === f.origHash) || (f.kind === 'new' && !cur) ? 'apply' : 'conflict';
      items.push({ file: f.path, where: f.kind === 'new' ? 'new file' : 'whole file', what: 'file', status: st, update: st === 'conflict' ? (cur ? 'changed in this version' : 'removed in this version') : null, mine: `your version (${Math.round(unb64(f.data).length / 1024)} KB)`, choice: 'mine', binary: true,
        run: async (c) => { if (c === 'mine') await api.write(f.path, unb64(f.data)); } });
    }
  }
  return items;
}
const short = (s) => { s = String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); return s.length > 140 ? s.slice(0, 140) + '…' : s; };

export async function applyItems(app, items) {
  const todo = items.filter(i => (i.status === 'apply' || i.status === 'conflict') && i.choice === 'mine' && i.run);
  const docs = [...new Set(todo.filter(i => !i.binary).map(i => i.doc).filter(Boolean))];
  if (docs.length) app.history.do(`Re-apply patch (${todo.filter(i => !i.binary).length} changes)`, docs, () => { for (const i of todo) if (!i.binary) i.run('mine'); });
  for (const i of todo) if (i.binary) await i.run('mine');
  // refresh what is on screen
  try { app.game.refreshUniverse && docs.includes(app.universeDoc) && app.game.refreshUniverse(); } catch { }
  try { await app.rebuildVisuals(); app.outliner.render(); app.props.render(); app.updateDocState(); } catch { }
  return { applied: todo.length, docs: docs.length };
}

// ---------------------------------------------------------------- tracking (the switch)
export async function readSavedPatch() { const b = await api.read(PATCH_FILE); if (!b) return null; try { return JSON.parse(new TextDecoder().decode(b)); } catch { return null; } }
async function writePatch(app, patch) {
  const bytes = new TextEncoder().encode(JSON.stringify(patch));
  const prev = await readSavedPatch();
  const changed = !prev || JSON.stringify({ ...prev, created: 0 }) !== JSON.stringify({ ...patch, created: 0 });
  if (!changed) return false;
  if (prev) { // keep the previous versions in rotating slots (never more than HISTORY_SLOTS files)
    const slot = ((app.settings.patchSlot || 0) + 1) % HISTORY_SLOTS; app.settings.patchSlot = slot; saveSettings(app.settings);
    await api.write(`editor_patches/history/previous-${slot}.flpatch.json`, new TextEncoder().encode(JSON.stringify(prev)));
  }
  await api.write(PATCH_FILE, bytes);
  return true;
}
// called after every save while the switch is on
export async function afterSave(app) {
  if (!app.settings.patchTracking) return;
  if (app.patchSuspended) { app.status.msg('Update patch not refreshed: files were replaced outside the editor — see File → Mods → Update patch', 'err'); return; }
  try { const p = await buildPatch(app); if (await writePatch(app, p)) app.status.msg(`Saved · update patch refreshed (${p.stats.changes} changes in ${p.stats.files} files)`, 'ok'); }
  catch (e) { console.warn('patch refresh failed', e); app.status.msg('Update patch could not be refreshed: ' + e.message, 'err'); }
}
// at start-up: were files of the patch replaced outside the editor (a mod update)?
export async function outsideChanges(patch) {
  const out = [];
  for (const f of patch.files) { const cur = await readBytes(f.path); const hsh = cur ? await sha(cur) : null; if (hsh !== f.mineHash) out.push(f.path); }
  return out;
}
export async function startupCheck(app) {
  if (!app.settings.patchTracking) return;
  const p = await readSavedPatch(); if (!p || !p.files.length) return;
  const changed = await outsideChanges(p);
  if (!changed.length) return;
  app.patchSuspended = true; app.patchOutside = changed;
  app.rebuildMenus();
  toast(`${changed.length} file${changed.length === 1 ? '' : 's'} with your changes ${changed.length === 1 ? 'was' : 'were'} replaced outside the editor — a mod update? File → Re-apply my changes… puts your edits back on top.`, 12000);
}

// ---------------------------------------------------------------- UI: the "Update patch" tab
export async function patchTab(app, body, rerender) {
  const S = app.settings;
  const para = (t) => h('p', { style: { margin: '6px 0', color: 'var(--dim)', maxWidth: '820px', lineHeight: 1.5 } }, t);
  body.append(h('h3', { style: { margin: '4px 0 6px' } }, 'Keep my changes safe across mod updates'),
    para('A mod update (for example a new Discovery version) replaces the mod\'s files, and with them your edits. With this switched on, every save also writes your changes as an update-safe patch: not whole files, but each change on its own (“Li01 · Li01_03 · reputation li_n_grp → li_p_grp”, a new object, an infocard text…). After installing the update, re-apply the patch: changes in places the update did not touch go straight back in; where the update changed the same thing you choose.'));
  const sw = h('input', { type: 'checkbox', checked: !!S.patchTracking, onchange: async () => {
    S.patchTracking = sw.checked; saveSettings(S); app.rebuildMenus();
    if (S.patchTracking) { app.patchSuspended = false; await afterSave(app); }
    rerender();
  } });
  body.append(h('label', { class: 'topt', style: { fontSize: '13px', margin: '8px 0' } }, sw, h('b', {}, 'Keep an update patch of my changes'), h('span', { style: { color: 'var(--faint)', marginLeft: '6px' } }, `(saved to ${PATCH_FILE.replace(/\//g, '\\')} on every save)`)));

  const status = h('div', { style: { margin: '8px 0' } });
  body.append(status);
  const saved = await readSavedPatch();
  if (S.patchTracking) {
    if (app.patchSuspended) {
      status.append(h('div', { class: 'viewbanner', style: { margin: '6px 0' } }, h('span', {}, `${(app.patchOutside || []).length} file(s) with your changes were replaced outside the editor (a mod update?). The patch is not refreshed until you decide.`)),
        h('div', { class: 'btnrow' },
          h('button', { class: 'btn primary', onclick: () => saved && reapplyDialog(app, saved) }, 'Re-apply my changes…'),
          h('button', { class: 'btn', title: 'The replaced files are fine as they are (you changed them yourself elsewhere): take them into the patch', onclick: async () => { if (!(await confirmDialog('Keep the files as they are', 'Rebuild the patch from the files as they are now? Use this only if you replaced them yourself on purpose — after a mod update this would record the update as your change.', 'Rebuild patch', true))) return; app.patchSuspended = false; await afterSave(app); app.rebuildMenus(); rerender(); } }, 'Files are fine — rebuild the patch')));
    } else if (saved) status.append(h('div', {}, `Patch: ${saved.stats.changes} change${saved.stats.changes === 1 ? '' : 's'} in ${saved.stats.files} file${saved.stats.files === 1 ? '' : 's'} · last refreshed ${new Date(saved.created).toLocaleString()}`));
    else status.append(h('div', { style: { color: 'var(--faint)' } }, 'No patch yet — it is written the next time you save (or click Refresh now).'));
  }
  const listFor = (p) => h('div', { style: { margin: '6px 0 0', columns: '2 340px', fontSize: '12px' } }, p.files.map(f => h('div', {}, f.path, h('span', { style: { color: 'var(--faint)' } }, ' · ' + (f.kind === 'ini' ? `${f.sections.length} section${f.sections.length === 1 ? '' : 's'}` : f.kind === 'dll' ? `${f.texts.length} text${f.texts.length === 1 ? '' : 's'}` : f.kind === 'new' ? 'new file' : 'whole file')))));
  if (saved && saved.files.length) status.append(listFor(saved));

  const fileIn = h('input', { type: 'file', accept: '.json,.flpatch', style: { display: 'none' }, onchange: async () => { const fl = fileIn.files[0]; if (!fl) return; try { reapplyDialog(app, JSON.parse(await fl.text())); } catch (e) { toast('Not a patch file: ' + e.message); } } });
  body.append(h('div', { class: 'btnrow', style: { marginTop: '10px', flexWrap: 'wrap' } },
    S.patchTracking ? h('button', { class: 'btn', onclick: async () => { app.patchSuspended = false; await afterSave(app); rerender(); } }, 'Refresh now') : null,
    h('button', { class: 'btn', title: 'Download the patch (for another install, or to keep)', onclick: async () => { const p = saved && S.patchTracking ? saved : await buildPatch(app); if (!p.files.length) return toast('No changes to put in a patch'); const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(p, null, 1)], { type: 'application/json' })), download: 'my-changes.flpatch.json' }); document.body.append(a); a.click(); a.remove(); } }, 'Download patch'),
    saved && !(S.patchTracking && app.patchSuspended) ? h('button', { class: 'btn primary', onclick: () => reapplyDialog(app, saved) }, 'Re-apply saved patch…') : null,
    h('button', { class: 'btn', onclick: () => fileIn.click() }, 'Re-apply a patch file…'), fileIn));
  body.append(para('Previous versions of the patch are kept in editor_patches\\history (the last ten). Nothing here changes the game until you re-apply and save.'));
}

// ---------------------------------------------------------------- UI: re-apply
export async function reapplyDialog(app, patch) {
  const body = h('div', {}, h('div', { class: 'empty' }, 'Comparing the patch with the files as they are now…'));
  const m = modal({ title: `Re-apply: ${patch.name || 'patch'} (${new Date(patch.created).toLocaleDateString()})`, wide: true, body, buttons: [{ label: 'Cancel' }, { label: 'Apply', cls: 'primary', onClick: () => go() }] });
  m.box.classList.add('xwide');
  let items;
  try { items = await planPatch(app, patch); } catch (e) { body.innerHTML = ''; body.append(h('div', { class: 'sev-err' }, e.message)); return; }
  const n = (s) => items.filter(i => i.status === s).length;
  const baseline = h('input', { type: 'checkbox', checked: n('same') < items.length / 2 });
  body.innerHTML = '';
  body.append(
    h('div', { class: 'stat', style: { marginBottom: '8px' } }, 'Go straight in', h('b', {}, n('apply')), 'Already there', h('b', {}, n('same')), 'Need a decision', h('b', { style: { color: n('conflict') ? 'var(--warn)' : '' } }, n('conflict')), 'Cannot apply', h('b', { style: { color: n('error') ? 'var(--err)' : '' } }, n('error'))),
    h('label', { class: 'topt', style: { margin: '4px 0 10px' } }, baseline, 'This is a new version of the mod: start a new baseline first', h('span', { style: { color: 'var(--faint)', marginLeft: '6px' } }, '(moves editor_backups to editor_backups_old, so “Review changes”, mod export and the next patch compare with the new version)')));
  const rows = h('div', { style: { maxHeight: 'calc(100vh - 340px)', overflow: 'auto' } });
  const order = { conflict: 0, error: 1, apply: 2, same: 3 };
  const chip = (s) => h('span', { class: 'chip', style: { fontSize: '10px', padding: '1px 6px', background: { apply: 'var(--accent2)', same: 'var(--panel2)', conflict: '#6b4f12', error: '#6b1d1d' }[s] } }, { apply: 'apply', same: 'already there', conflict: 'decide', error: 'cannot' }[s]);
  let lastFile = null;
  for (const it of [...items].sort((a, b) => order[a.status] - order[b.status] || a.file.localeCompare(b.file))) {
    if (it.file !== lastFile) { rows.append(h('div', { class: 'grp', style: { padding: '8px 0 2px', cursor: 'default' } }, it.file)); lastFile = it.file; }
    const pick = it.status === 'conflict' ? h('select', { onchange: (e) => { it.choice = e.target.value; } }, h('option', { value: 'mine' }, 'use mine'), h('option', { value: 'theirs' }, 'keep this version\'s')) : null;
    const pre = (label, v, col) => v == null || v === '' ? null : h('div', { style: { display: 'grid', gridTemplateColumns: '90px 1fr', gap: '6px', fontSize: '12px' } }, h('span', { style: { color: 'var(--faint)' } }, label), h('span', { style: { whiteSpace: 'pre-wrap', fontFamily: 'var(--mono)', color: col || 'var(--text)' } }, v));
    rows.append(h('div', { style: { borderBottom: '1px solid var(--line)', padding: '5px 0' } },
      h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, chip(it.status), h('b', {}, it.where || ''), h('span', { style: { color: 'var(--dim)' } }, it.what), h('span', { style: { flex: 1 } }), pick),
      it.status === 'same' ? null : h('div', { style: { marginTop: '3px' } },
        it.status === 'conflict' && it.base !== undefined ? pre('was', it.base ?? '(not set)', 'var(--faint)') : null,
        it.status === 'conflict' ? pre('this version', it.update ?? '(not set)', 'var(--warn)') : null,
        pre(it.status === 'error' ? 'problem' : 'mine', it.mine ?? '(remove)', it.status === 'error' ? 'var(--err)' : 'var(--ok)'))));
  }
  body.append(rows);
  async function go() {
    if (baseline.checked) { const r = await fetch('/api/new-baseline', { method: 'POST' }).then(x => x.json()).catch(e => ({ error: e.message })); if (r.error) { toast('Could not start a new baseline: ' + r.error, 6000); return false; } }
    const r = await applyItems(app, items);
    app.patchSuspended = false; app.patchOutside = null; app.rebuildMenus();
    toast(`${r.applied} change${r.applied === 1 ? '' : 's'} re-applied — check them, then Ctrl+S to write the files`, 7000);
    return true;
  }
}
