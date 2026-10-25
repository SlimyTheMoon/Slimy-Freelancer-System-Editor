// Patch manager for the game executables (Assets / Tools menu).
// Catalog: public/data/patches.json — community hex edits,
// each checked by tools/build_patches.py against a real install. In the user's install every edit is
// checked again before anything is written: a byte patch can only be switched when the bytes in the
// file are exactly the original (→ apply) or the patched bytes (→ revert). Value patches show the value
// that is in the file now. Each location is mapped to the function that contains it (this project's
// Ghidra pipeline, C++ names from the decompilation) so you can see what code a patch touches.
// Writes go through the server, which backs up the original file on the first write of the session.
import { h, modal, toast, confirmDialog } from './dom.js';
import { api } from '../api.js';
import { parsePE } from '../formats/pe.js';
import { loadMap, lookup } from './crash.js';

const hexb = (s) => new Uint8Array((s.replace(/[^0-9a-f]/gi, '').match(/../g) || []).map(x => parseInt(x, 16)));
const tohex = (u8) => [...u8].map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
const H = (n, w = 6) => '0x' + (n >>> 0).toString(16).toUpperCase().padStart(w, '0');
const SIZES = { f: 4, d: 8, i: 4, b: 1 };
function readVal(u8, off, t) { const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); return t === 'f' ? dv.getFloat32(off, true) : t === 'd' ? dv.getFloat64(off, true) : t === 'i' ? dv.getInt32(off, true) : u8[off]; }
function writeVal(u8, off, t, v) { const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); if (t === 'f') dv.setFloat32(off, v, true); else if (t === 'd') dv.setFloat64(off, v, true); else if (t === 'i') dv.setInt32(off, v | 0, true); else u8[off] = v & 255; }
const fmtV = (v, t) => t === 'f' || t === 'd' ? String(+(+v).toPrecision(t === 'f' ? 7 : 12)) : String(v);
const eq = (u8, off, bytes) => { if (off + bytes.length > u8.length) return false; for (let i = 0; i < bytes.length; i++) if (u8[off + i] !== bytes[i]) return false; return true; };

export async function patchManager(app) {
  const cat = await fetch('data/patches.json').then(r => r.json()).catch(() => null);
  if (!cat) { toast('patches.json missing'); return; }
  const map = await loadMap();
  const exeDir = await api.ls('EXE');
  const modules = new Map(); // lower name -> { name, path, u8, pe, dirty }
  async function mod(name) {
    const k = name.toLowerCase(); if (modules.has(k)) return modules.get(k);
    const hit = exeDir.find(e => !e.dir && e.name.toLowerCase() === k);
    let m = null;
    if (hit) { const b = await api.read('EXE/' + hit.name); if (b) { m = { name: hit.name, path: 'EXE/' + hit.name, u8: new Uint8Array(b), pe: null, dirty: false }; try { m.pe = parsePE(m.u8); } catch { } } }
    modules.set(k, m); return m;
  }
  for (const p of cat.patches) await mod(p.module);

  function state(p) {
    const m = modules.get(p.module.toLowerCase());
    if (!m) return { s: 'missing', label: `${p.module} not found`, cls: 'dim' };
    const bytes = p.edits.filter(e => e.orig);
    if (!bytes.length) return { s: 'value', label: 'value', cls: '' };
    let o = 0, n = 0, x = 0;
    for (const e of bytes) { const ob = hexb(e.orig), nb = hexb(e.new); if (eq(m.u8, e.off, ob)) o++; else if (eq(m.u8, e.off, nb)) n++; else x++; }
    if (x) return { s: 'mismatch', label: 'does not match your file', cls: 'warn' };
    if (n === bytes.length) return { s: 'applied', label: 'applied', cls: 'ok' };
    if (o === bytes.length) return { s: 'off', label: 'not applied', cls: '' };
    return { s: 'partial', label: 'partly applied', cls: 'warn' };
  }
  function where(m, off) {
    if (!m || !m.pe) return '';
    const r = m.pe.offToRva(off); if (!r) return 'outside sections';
    const va = m.pe.imageBase + r.rva;
    const f = map && lookup(map, m.name.toLowerCase(), r.rva);
    let fn = '';
    if (f) fn = f.near ? ` · near ${f.gname}` : ` · in ${f.cname || f.gname}+${H(f.off, 1)}${f.src ? ' (' + f.src + ')' : ''}`;
    else if (!(r.section.flags & 0x20000000)) fn = ' · data';
    return `${r.section.name} · VA ${H(va, 8)}${fn}`;
  }

  const list = h('div', { style: { height: 'calc(100vh - 300px)', overflow: 'auto' } });
  const filter = h('input', { placeholder: 'Filter patches…', style: { flex: '1' } });
  const catSel = h('select', {}, h('option', { value: '' }, 'All categories'), [...new Set(cat.patches.map(p => p.category))].sort().map(c => h('option', { value: c }, c)));
  const status = h('div', { style: { fontSize: '12px', color: 'var(--faint)' } });
  const saveBtn = h('button', { class: 'btn primary', disabled: true }, 'Write changed files');

  function setDirty() {
    const d = [...modules.values()].filter(m => m && m.dirty);
    saveBtn.disabled = !d.length; saveBtn.textContent = d.length ? `Write ${d.map(m => m.name).join(', ')}` : 'Write changed files';
  }
  function toggle(p, on) {
    const m = modules.get(p.module.toLowerCase());
    for (const e of p.edits.filter(e => e.orig)) m.u8.set(hexb(on ? e.new : e.orig), e.off);
    m.dirty = true; setDirty(); render();
  }
  function render() {
    const q = filter.value.toLowerCase(), c = catSel.value;
    list.innerHTML = '';
    let shown = 0;
    for (const p of cat.patches) {
      if (c && p.category !== c) continue;
      if (q && !(p.title + ' ' + p.desc + ' ' + p.module + ' ' + p.category).toLowerCase().includes(q)) continue;
      shown++;
      const st = state(p), m = modules.get(p.module.toLowerCase());
      const badge = h('span', { style: { fontSize: '11px', padding: '1px 6px', borderRadius: '8px', marginLeft: '6px', background: st.cls === 'ok' ? 'rgba(80,200,120,.2)' : st.cls === 'warn' ? 'rgba(255,170,60,.2)' : 'rgba(255,255,255,.07)', color: st.cls === 'ok' ? '#7ee2a0' : st.cls === 'warn' ? '#ffb366' : 'var(--dim)' } }, st.label);
      const card = h('div', { style: { border: '1px solid var(--line, #263040)', borderRadius: '6px', padding: '8px 10px', margin: '0 0 8px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          h('b', {}, p.title), badge, h('span', { style: { color: 'var(--faint)', fontSize: '11px' } }, `${p.category} · ${p.module}${p.author ? ' · by ' + p.author : ''}`),
          h('span', { style: { flex: '1' } }),
          st.s === 'off' || st.s === 'partial' ? h('button', { class: 'btn sm primary', onclick: () => toggle(p, true) }, 'Apply') : null,
          st.s === 'applied' ? h('button', { class: 'btn sm', onclick: () => toggle(p, false) }, 'Revert') : null),
        p.desc ? h('div', { style: { fontSize: '12px', margin: '4px 0', color: 'var(--dim)' } }, p.desc) : null);
      const rows = h('div', { style: { fontSize: '11px', fontFamily: 'var(--mono)', display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 10px' } });
      for (const e of p.edits) {
        if (e.orig) {
          const cur = m ? tohex(m.u8.subarray(e.off, e.off + hexb(e.orig).length)) : '—';
          rows.append(h('span', {}, H(e.off)), h('span', { title: where(m, e.off) }, `${e.orig} → ${e.new}`, h('span', { style: { color: 'var(--faint)' } }, `   now ${cur} · ${where(m, e.off)}`)));
        } else {
          const cur = m ? readVal(m.u8, e.off, e.type) : null;
          const inp = h('input', { type: 'number', step: 'any', value: cur == null ? '' : fmtV(cur, e.type), style: { width: '140px' }, disabled: !m });
          const set = (v) => { if (!m || !isFinite(v)) return; writeVal(m.u8, e.off, e.type, v); m.dirty = true; setDirty(); render(); };
          rows.append(h('span', {}, H(e.off)),
            h('span', {}, `${e.label || 'value'} (${{ f: 'float', d: 'double', i: 'int', b: 'byte' }[e.type]}) `, inp, ' ',
              h('button', { class: 'btn sm', disabled: !m, onclick: () => set(parseFloat(inp.value)) }, 'Set'),
              e.install != null && cur != null && Math.abs(cur - e.install) > 1e-9 ? h('button', { class: 'btn sm', title: 'value in the reference HD Edition install', onclick: () => set(e.install) }, `Reset ${fmtV(e.install, e.type)}`) : null,
              e.suggest != null ? h('button', { class: 'btn sm', title: 'suggested value', onclick: () => set(e.suggest) }, `Suggested ${e.suggest}`) : null,
              h('span', { style: { color: 'var(--faint)' } }, '  ' + where(m, e.off))));
        }
      }
      card.append(rows);
      list.append(card);
    }
    const applied = cat.patches.filter(p => state(p).s === 'applied').length;
    status.textContent = `${shown} of ${cat.patches.length} patches · ${applied} applied in your files · ${[...modules.values()].filter(Boolean).length} modules read from EXE\\`;
  }
  filter.oninput = render; catSel.onchange = render;

  // custom patch
  const cMod = h('select', {}, exeDir.filter(e => !e.dir && /\.(exe|dll)$/i.test(e.name)).map(e => h('option', { value: e.name }, e.name)));
  const cOff = h('input', { placeholder: 'offset, e.g. 0x11DB44', style: { width: '150px' } });
  const cOrig = h('input', { placeholder: 'original bytes, e.g. 74', style: { width: '200px' } });
  const cNew = h('input', { placeholder: 'new bytes, e.g. EB', style: { width: '200px' } });
  const cInfo = h('span', { style: { fontSize: '11px', color: 'var(--faint)' } });
  const cCheck = async () => {
    const m = await mod(cMod.value); const off = parseInt(cOff.value); if (!m || !isFinite(off)) { cInfo.textContent = ''; return null; }
    const o = hexb(cOrig.value), n = hexb(cNew.value);
    const len = Math.max(o.length, n.length, 1);
    const cur = m.u8.subarray(off, off + len);
    cInfo.textContent = `now ${tohex(cur)} · ${where(m, off)}${o.length ? (eq(m.u8, off, o) ? ' · original matches ✓' : eq(m.u8, off, n) ? ' · already patched' : ' · original does NOT match') : ''}`;
    return { m, off, o, n };
  };
  for (const el of [cMod, cOff, cOrig, cNew]) el.addEventListener('input', cCheck);
  const custom = h('details', { style: { margin: '6px 0', fontSize: '12px' } }, h('summary', {}, 'Custom patch (any offset from a patch list)'),
    h('div', { class: 'btnrow', style: { alignItems: 'center', flexWrap: 'wrap', marginTop: '6px' } }, cMod, cOff, cOrig, '→', cNew,
      h('button', { class: 'btn sm primary', onclick: async () => {
        const c = await cCheck(); if (!c) return;
        if (!c.n.length) { toast('Enter the new bytes'); return; }
        if (c.o.length && !eq(c.m.u8, c.off, c.o)) { toast('The original bytes do not match this file — not applied'); return; }
        if (!c.o.length && !await confirmDialog('No original bytes', 'Without original bytes the patch cannot be checked against your file. Write it anyway?', 'Patch', true)) return;
        c.m.u8.set(c.n, c.off); c.m.dirty = true; setDirty(); cCheck(); render(); toast('Patched in memory — write the file to keep it');
      } }, 'Apply')), cInfo);

  saveBtn.onclick = async () => {
    const d = [...modules.values()].filter(m => m && m.dirty);
    if (!await confirmDialog('Write executables', `Write ${d.map(m => m.name).join(', ')}? Freelancer must be closed. The originals are copied to editor_backups the first time each file is written in this session.`, 'Write', false)) return;
    for (const m of d) {
      try { await api.write(m.path, m.u8); m.dirty = false; } catch (e) { toast(`${m.name}: ${e.message || e}`, 6000); }
    }
    setDirty(); render(); toast('Written — start Freelancer to test');
  };
  modal({
    title: 'Patch manager (game executables)', wide: true,
    body: h('div', {},
      h('div', { style: { fontSize: '12px', color: 'var(--dim)', margin: '0 0 6px' } }, 'Community hex edits, checked byte for byte against your files. Each location shows the function of the decompiled game it falls in. Changes stay in memory until you write the files.'),
      h('div', { class: 'btnrow', style: { alignItems: 'center' } }, filter, catSel), status, custom, list),
    buttons: [{ label: 'Close', onClick: async () => ![...modules.values()].some(m => m && m.dirty) || await confirmDialog('Discard?', 'Patched files have not been written.', 'Discard', true) }, { el: saveBtn }],
  }).box.classList.add('xwide');
  render();
}
