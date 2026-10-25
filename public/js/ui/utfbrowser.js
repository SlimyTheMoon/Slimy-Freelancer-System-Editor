// UTF file browser: tree of any .cmp/.3db/.mat/.txm/.sph/.ale/.vms file,
// leaf viewer (hex · floats · ints · string · texture preview), edit values, export/replace leaf data,
// add/rename/delete nodes, save (writeUtf, original backed up by the server).
import * as THREE from 'three';
import { h, modal, toast, promptDialog, confirmDialog } from './dom.js';
import { api, dataPath } from '../api.js';
import { parseUtf, writeUtf, UtfNode } from '../formats/utf.js';
import { textureFromNode } from '../formats/model.js';
import { dacomCrc } from '../formats/crc.js';
import { utfHistory } from './utfundo.js';

const hex2 = (b) => b.toString(16).padStart(2, '0');
function hexDump(u8, max = 512) {
  const lines = [];
  for (let o = 0; o < Math.min(u8.length, max); o += 16) {
    const row = u8.subarray(o, Math.min(o + 16, u8.length));
    lines.push(o.toString(16).padStart(6, '0') + '  ' + [...row].map(hex2).join(' ').padEnd(48) + '  ' + [...row].map(c => c >= 32 && c < 127 ? String.fromCharCode(c) : '.').join(''));
  }
  if (u8.length > max) lines.push(`… ${u8.length - max} more bytes`);
  return lines.join('\n');
}
function download(name, bytes) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([bytes])); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function pickFile(accept) {
  return new Promise((res) => { const i = document.createElement('input'); i.type = 'file'; i.accept = accept || ''; i.onchange = async () => { const f = i.files[0]; res(f ? { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) } : null); }; i.click(); });
}
// texture preview renderer (one per window)
function texturePreview(node) {
  const tex = textureFromNode(node);
  if (!tex) return null;
  const W = tex.image.width || 256, H = tex.image.height || 256, s = Math.min(1, 256 / Math.max(W, H));
  const cv = document.createElement('canvas'); cv.width = Math.round(W * s); cv.height = Math.round(H * s);
  const r = new THREE.WebGLRenderer({ canvas: cv, alpha: true });
  const scene = new THREE.Scene(), cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  // DDS/TGA rows are top-down (D3D); flip v so the image shows upright
  const mat = new THREE.ShaderMaterial({ uniforms: { map: { value: tex } }, transparent: true, vertexShader: 'varying vec2 vUv; void main(){ vUv = vec2(uv.x, 1.0 - uv.y); gl_Position = vec4(position.xy, 0.0, 1.0); }', fragmentShader: 'uniform sampler2D map; varying vec2 vUv; void main(){ gl_FragColor = texture2D(map, vUv);\n#include <colorspace_fragment>\n}' });
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
  r.render(scene, cam);
  const img = document.createElement('canvas'); img.width = cv.width; img.height = cv.height; img.getContext('2d').drawImage(cv, 0, 0);
  r.dispose(); tex.dispose(); mat.dispose();
  img.style.cssText = 'background: repeating-conic-gradient(#333 0% 25%, #222 0% 50%) 50% / 16px 16px; border-radius: 4px; max-width: 100%';
  return { el: img, info: `${W} × ${H}` };
}

export async function utfBrowser(app, { path, title } = {}) {
  if (!path) {
    const sel = app.selected()[0]; const a = sel && app.game.arch(sel.get('archetype'));
    const p = await promptDialog('Open UTF file', 'Path under the install (e.g. DATA\\SOLAR\\DOCKABLE\\station_small_b_lod.cmp)', a && a.da ? 'DATA\\' + a.da : 'DATA\\');
    if (!p) return; path = p.replace(/\\/g, '/');
  }
  const bytes = await api.read(path);
  if (!bytes) { toast('File not found: ' + path); return; }
  let root; try { root = parseUtf(bytes); } catch (e) { toast('Not a UTF file: ' + e.message); return; }
  (function own(n) { if (n.isLeaf) n.data = n.data.slice(); else n.children.forEach(own); })(root);
  let dirty = false, sel = root; const open = new Set([root]);
  const parentOf = (n, cur = root) => { if (cur.isLeaf) return null; for (const c of cur.children) { if (c === n) return cur; const p = parentOf(n, c); if (p) return p; } return null; };
  const treeEl = h('div', { style: { fontFamily: 'var(--mono)', fontSize: '12px', overflow: 'auto', height: 'calc(100vh - 210px)' } });
  const detail = h('div', { style: { overflow: 'auto', height: 'calc(100vh - 210px)', fontSize: '12px' } });
  const titleEl = h('span');
  const inTree = (n) => n === root || !!parentOf(n);
  const H = utfHistory(root, () => { if (!inTree(sel)) sel = root; showDirty(); render(); });
  const showDirty = () => { dirty = H.dirty; titleEl.textContent = dirty ? ' ● unsaved' : ''; };
  const setDirty = (d) => { if (d) H.push(); else H.markSaved(); showDirty(); };
  const unbindKeys = H.bindKeys();
  const m = modal({
    onClose: () => unbindKeys(),
    title: `UTF · ${title || path.split('/').pop()}`, wide: true,
    body: h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(260px, 1fr) 1.5fr', gap: '12px' } }, treeEl, detail),
    buttons: [{ label: 'Close', onClick: async () => !dirty || await confirmDialog('Discard changes?', 'The file has unsaved changes.', 'Discard', true) },
      { label: 'Save file', cls: 'primary', onClick: async () => { try { await api.write(path, writeUtf(root)); setDirty(false); app.rm.invalidate(path); app.rebuildVisuals && app.rebuildVisuals(); toast('Saved (original backed up)'); } catch (e) { toast('Save failed: ' + e.message); } return false; } }],
  });
  m.box.classList.add('xwide'); m.box.querySelector('header h2').append(titleEl);

  function renderTree() {
    treeEl.innerHTML = '';
    const walk = (n, depth) => {
      const isOpen = open.has(n);
      treeEl.append(h('div', { style: { paddingLeft: (depth * 14 + 4) + 'px', cursor: 'pointer', whiteSpace: 'nowrap', background: n === sel ? 'rgba(255,210,80,0.14)' : '' }, onclick: () => { sel = n; if (!n.isLeaf) { isOpen && n !== root ? open.delete(n) : open.add(n); } render(); } },
        n.isLeaf ? '  ' : (isOpen ? '▾ ' : '▸ '), n.name, h('span', { style: { color: 'var(--faint)', marginLeft: '8px' } }, n.isLeaf ? `${n.data.length} B` : `${n.children.length}`)));
      if (!n.isLeaf && isOpen) for (const c of n.children) walk(c, depth + 1);
    };
    walk(root, 0);
  }
  function renderDetail() {
    detail.innerHTML = '';
    const n = sel, par = parentOf(n);
    const path_ = []; for (let x = n; x; x = parentOf(x)) path_.unshift(x.name);
    detail.append(h('div', { style: { fontFamily: 'var(--mono)', color: 'var(--dim)', marginBottom: '6px', wordBreak: 'break-all' } }, path_.join(' / ')),
      h('div', { class: 'btnrow', style: { marginBottom: '8px' } },
        n !== root ? h('button', { class: 'btn sm', onclick: async () => { const nn = (await promptDialog('Rename node', 'Name', n.name) || '').trim(); if (nn) { n.name = nn; setDirty(true); render(); } } }, 'Rename…') : null,
        !n.isLeaf ? h('button', { class: 'btn sm', onclick: async () => { const nn = (await promptDialog('New folder node', 'Name', 'New') || '').trim(); if (nn) { n.children.push(new UtfNode(nn)); open.add(n); setDirty(true); render(); } } }, '+ Folder') : null,
        !n.isLeaf ? h('button', { class: 'btn sm', onclick: async () => { const nn = (await promptDialog('New value node', 'Name', 'Value') || '').trim(); if (nn) { const c = new UtfNode(nn, new Uint8Array(4)); n.children.push(c); open.add(n); sel = c; setDirty(true); render(); } } }, '+ Value') : null,
        !n.isLeaf ? h('button', { class: 'btn sm', title: 'Add a file (e.g. a .dds/.tga texture) as a value node', onclick: async () => { const f = await pickFile(); if (!f) return; const c = new UtfNode(f.name, f.bytes); n.children.push(c); open.add(n); sel = c; setDirty(true); render(); } }, '+ From file…') : null,
        n !== root ? h('button', { class: 'btn sm danger', onclick: () => { par.children = par.children.filter(c => c !== n); sel = par; setDirty(true); render(); } }, 'Delete') : null));
    if (!n.isLeaf) {
      // texture folder (has MIPS or MIP0): preview + export/replace as image file
      const mips = n.child('MIPS'), mip0 = n.child('MIP0');
      if (mips || mip0) {
        const pv = texturePreview(n);
        const leafN = mips || mip0, ext = mips ? 'dds' : 'tga';
        detail.append(h('h3', {}, 'Texture'), pv ? h('div', {}, pv.el, h('div', { style: { color: 'var(--faint)' } }, `${pv.info} · ${mips ? 'DDS (MIPS)' : 'TGA (MIP0)'}`)) : h('div', { class: 'sev-warn' }, 'cannot preview'),
          h('div', { class: 'btnrow', style: { marginTop: '6px' } },
            h('button', { class: 'btn sm', onclick: () => download(`${n.name.replace(/\.[^.]+$/, '')}.${ext}`, leafN.data) }, `Export .${ext}`),
            h('button', { class: 'btn sm', onclick: async () => {
              const f = await pickFile('.dds,.tga'); if (!f) return;
              const isDds = f.bytes[0] === 0x44 && f.bytes[1] === 0x44 && f.bytes[2] === 0x53;
              n.children = n.children.filter(c => !/^(mips|mip\d+)$/i.test(c.name));
              n.children.push(new UtfNode(isDds ? 'MIPS' : 'MIP0', f.bytes));
              setDirty(true); render();
            } }, 'Replace with .dds/.tga…')));
      }
      detail.append(h('div', { style: { color: 'var(--faint)', marginTop: '8px' } }, `${n.children.length} children · name CRC 0x${dacomCrc(n.name).toString(16).toUpperCase().padStart(8, '0')}`));
      return;
    }
    const d = n.data, dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
    const floats = [], ints = [];
    for (let i = 0; i + 4 <= d.length && i < 4096; i += 4) { floats.push(dv.getFloat32(i, true)); ints.push(dv.getInt32(i, true)); }
    let str = ''; for (let i = 0; i < d.length && d[i]; i++) str += String.fromCharCode(d[i]);
    const printable = d.length && [...d.subarray(0, Math.min(d.length, 64))].every((c, i) => c === 0 ? i > 0 : c >= 32 && c < 127);
    const ta = (val, kind) => {
      const t = h('textarea', { class: 'raw', style: { height: '90px', fontFamily: 'var(--mono)', fontSize: '12px' } }); t.value = val;
      return h('div', {}, t, h('button', { class: 'btn sm', style: { marginTop: '4px' }, onclick: () => {
        let out;
        if (kind === 'str') { out = new Uint8Array(t.value.length + 1); for (let i = 0; i < t.value.length; i++) out[i] = t.value.charCodeAt(i) & 0xFF; }
        else { const nums = t.value.split(/[\s,]+/).filter(Boolean).map(Number); if (nums.some(isNaN)) { toast('Not a number list'); return; } out = new Uint8Array(nums.length * 4); const o = new DataView(out.buffer); nums.forEach((v, i) => kind === 'f' ? o.setFloat32(i * 4, v, true) : o.setInt32(i * 4, v | 0, true)); }
        n.data = out; setDirty(true); render();
      } }, `Apply as ${kind === 'f' ? 'floats' : kind === 'i' ? 'ints' : 'string'}`));
    };
    detail.append(h('div', { style: { color: 'var(--faint)', marginBottom: '6px' } }, `${d.length} bytes`),
      h('div', { class: 'btnrow', style: { marginBottom: '8px' } },
        h('button', { class: 'btn sm', onclick: () => download(n.name.replace(/[\\/:*?"<>|]/g, '_') + '.bin', d) }, 'Export bytes'),
        h('button', { class: 'btn sm', onclick: async () => { const f = await pickFile(); if (f) { n.data = f.bytes; setDirty(true); render(); } } }, 'Replace from file…')));
    if (printable) detail.append(h('h3', {}, 'String'), ta(str, 'str'));
    if (floats.length && floats.length <= 64) detail.append(h('h3', {}, 'Floats'), ta(floats.map(f => +f.toPrecision(7)).join(', '), 'f'), h('h3', {}, 'Ints'), ta(ints.join(', '), 'i'));
    detail.append(h('h3', {}, 'Hex'), h('pre', { style: { fontSize: '11px', lineHeight: '1.35', background: 'rgba(0,0,0,0.25)', padding: '6px', borderRadius: '4px', overflow: 'auto' } }, hexDump(d)));
  }
  function render() { renderTree(); renderDetail(); }
  render();
}
