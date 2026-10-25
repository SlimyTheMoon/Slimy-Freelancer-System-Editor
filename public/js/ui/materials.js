// Materials & textures editor (Assets menu, "Materials…" on objects): the [Material library] and
// [Texture library] of one UTF file (.mat / .txm, or a .cmp / .3db with embedded materials).
// Materials: type, colours (Dc Ec Ac), opacity (Oc), texture slots (Dt Et Dm/Bt …) with live preview on the
// model (or a sphere for a library without a model). Textures: thumbnails, export PNG, replace / add from
// PNG·JPG·WebP·BMP·DDS (encoded to DXT1/DXT5 with mipmaps), which materials use them.
// Undo/redo per window (Ctrl+Z / Ctrl+Y), Save rewrites the file (the server backs up the original).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { h, modal, toast, promptDialog, confirmDialog, overlay } from './dom.js';
import { api, dataPath } from '../api.js';
import { parseUtf, writeUtf, UtfNode } from '../formats/utf.js';
import { ResourceManager, parseMaterial } from '../formats/model.js';
import { dacomCrc } from '../formats/crc.js';
import { decodeTextureNode, rgbaToFlDDS, readDDS } from '../formats/texcodec.js';
import { utfHistory } from './utfundo.js';

const lc = (s) => String(s || '').toLowerCase();
export const MATERIAL_TYPES = ['DcDt', 'DcDtTwo', 'DcDtEc', 'DcDtEcTwo', 'DcDtOcOt', 'DcDtOcOtTwo', 'DcDtEcOcOt', 'DcDtEcOcOtTwo', 'DcDtEt', 'DcDtEtTwo', 'DcDtEcEt', 'DcDtEcEtTwo', 'EcEt', 'DcDtBt', 'DcDtBtTwo', 'DcDtBtOcOt', 'DcDtBtOcOtTwo', 'BtDetailMapMaterial', 'DetailMapMaterial', 'DetailMap2Dm1Msk2PassMaterial', 'IllumDetailMapMaterial', 'Masked2DetailMapMaterial', 'Nebula', 'NebulaTwo', 'AtmosphereMaterial', 'NomadMaterial', 'NomadMaterialNoBendy', 'GlassMaterial', 'HighGlassMaterial', 'HUDAnimMaterial', 'HUDIconMaterial', 'ExclusionZoneMaterial', 'NullMaterial'];
const COLOURS = [['Dc', 'diffuse colour'], ['Ec', 'emissive colour'], ['Ac', 'ambient colour']];
const NUMBERS = [['Oc', 'opacity (1 = solid)'], ['Alpha', 'alpha'], ['Fade', 'fade'], ['TileRate', 'detail tile rate'], ['TileRate0', 'tile rate 0'], ['TileRate1', 'tile rate 1']];
const SLOTS = [['Dt', 'diffuse texture'], ['Et', 'emissive texture'], ['Dm', 'detail map'], ['Dm0', 'detail map 0'], ['Dm1', 'detail map 1'], ['Bt', 'bump/detail texture'], ['Nt', 'normal texture']];

// ---- leaf encoding (little-endian floats / ints, NUL-terminated strings padded to 4 bytes)
const f32s = (arr) => new Uint8Array(new Float32Array(arr).buffer);
const u32s = (arr) => new Uint8Array(new Uint32Array(arr).buffer);
function strBytes(s) { const b = new TextEncoder().encode(s); const out = new Uint8Array((b.length + 4) & ~3); out.set(b); return out; }
const hexCol = (c) => '#' + c.map(v => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('');
const colHex = (s) => [1, 3, 5].map(i => parseInt(s.slice(i, i + 2), 16) / 255);

function setLeaf(node, name, data) {
  let c = node.child(name);
  if (data == null) { if (c) node.children.splice(node.children.indexOf(c), 1); return; }
  if (!c) { c = new UtfNode(name, data); node.children.push(c); } else c.data = data;
}
function ensureDir(root, name) { let n = root.child(name); if (!n) { n = new UtfNode(name); root.children.push(n); } return n; }

// image file → { w, h, rgba } (top-down rows)
async function decodeImage(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (/\.dds$/i.test(file.name)) return { dds: bytes, ...readDDS(bytes) };
  const bmp = await createImageBitmap(new Blob([bytes]));
  const cv = document.createElement('canvas'); cv.width = bmp.width; cv.height = bmp.height;
  const g = cv.getContext('2d'); g.drawImage(bmp, 0, 0);
  return { w: bmp.width, h: bmp.height, rgba: new Uint8Array(g.getImageData(0, 0, bmp.width, bmp.height).data.buffer) };
}
function thumb(img, size = 96) {
  const cv = document.createElement('canvas'); const s = Math.min(1, size / Math.max(img.w, img.h));
  cv.width = Math.max(1, Math.round(img.w * s)); cv.height = Math.max(1, Math.round(img.h * s));
  const full = document.createElement('canvas'); full.width = img.w; full.height = img.h;
  full.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.rgba.buffer, img.rgba.byteOffset, img.w * img.h * 4), img.w, img.h), 0, 0);
  const g = cv.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(full, 0, 0, cv.width, cv.height);
  cv.style.cssText = 'background: repeating-conic-gradient(#333 0% 25%, #222 0% 50%) 50% / 12px 12px; border-radius: 4px; display:block';
  return { cv, full };
}
function texFormat(node) {
  const m = node.child('MIPS');
  if (m && m.data.byteLength > 88) { const d = m.data; return d[80] & 4 ? String.fromCharCode(d[84], d[85], d[86], d[87]) : 'DDS RGB(A)'; }
  return (node.children || []).some(c => /^mip\d/i.test(c.name)) ? 'TGA' : '?';
}

// Open from an archetype: the model + its material libraries
export async function materialsForArchetype(app, archNick) {
  const a = app.game.arch(archNick);
  if (!a || !a.da) { toast('Archetype has no model'); return; }
  return materialEditor(app, { model: dataPath(a.da), libs: a.matLibs.map(dataPath), title: a.nickname });
}

export async function materialEditor(app, { path = null, model = null, libs = [], title = '' } = {}) {
  if (!path && !model) {
    const p = await promptDialog('Materials & textures', 'File under the install (.mat .txm .cmp .3db), e.g. DATA\\SHIPS\\LIBERTY\\LI_ELITE\\li_elite.mat', 'DATA\\');
    if (!p) return; path = p.replace(/\\/g, '/');
  }
  // candidate files to edit: the model (if it has its own materials/textures) and every material library
  const files = [];
  const loadRoot = async (p) => { const b = await api.read(p); if (!b) return null; try { const r = parseUtf(b); (function own(n) { if (n.isLeaf) n.data = n.data.slice(); else n.children.forEach(own); })(r); return r; } catch { return null; } };
  const cand = [...new Set([...libs, model, path].filter(Boolean))].filter((p, i, a) => a.findIndex(q => lc(q) === lc(p)) === i);
  overlay('Reading materials and textures…');
  let roots; try { roots = await (app.whileBusy ? app.whileBusy(() => Promise.all(cand.map(loadRoot))) : Promise.all(cand.map(loadRoot))); } finally { overlay(null); } // parallel, 3D view paused
  for (let ci = 0; ci < cand.length; ci++) {
    const p = cand[ci], root = roots[ci]; if (!root) continue;
    const has = root.child('Material library') || root.child('Texture library');
    if (has || p === path) files.push({ path: p, root });
  }
  if (!files.length) { toast(model ? 'The model and its material libraries have no materials or textures' : 'Cannot read ' + path); return; }
  let F = files.find(f => lc(f.path) === lc(path)) || files.find(f => f.root.child('Material library')) || files[0];
  let selMat = null, selTex = null, tab = 'materials';
  const hist = new Map(); // file -> history
  const H = () => { if (!hist.has(F)) hist.set(F, utfHistory(F.root, () => { render(); schedulePreview(); showDirty(); })); return hist.get(F); };
  const anyDirty = () => [...hist.values()].some(x => x.dirty);

  // ---------- preview (private resource manager so unsaved edits show without touching the main view)
  const canvas = h('canvas', { style: { width: '100%', height: '100%', display: 'block', borderRadius: '6px', background: 'var(--well)' } });
  const view = h('div', { style: { position: 'relative', height: '100%', minHeight: '300px' } }, canvas);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true }); renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(40, 1, 0.1, 1e7);
  scene.add(new THREE.AmbientLight(0x778899, 1.3)); const sun = new THREE.DirectionalLight(0xffffff, 1.7); camera.add(sun); sun.position.set(0.4, 0.6, 1); scene.add(camera);
  const orbit = new OrbitControls(camera, canvas); orbit.enableDamping = true;
  let running = true, shown = null, framed = false, previewMode = model ? 'model' : 'sphere';
  const resize = () => { const r = view.getBoundingClientRect(); if (!r.width) return; renderer.setSize(r.width, r.height, false); camera.aspect = r.width / r.height; camera.updateProjectionMatrix(); };
  const ro = new ResizeObserver(resize); ro.observe(view);
  (function loop() { if (!running) return; orbit.update(); renderer.render(scene, camera); requestAnimationFrame(loop); })();
  let pvT = 0, pvToken = 0;
  const schedulePreview = () => { clearTimeout(pvT); pvT = setTimeout(preview, 150); };
  async function preview() {
    const my = ++pvToken;
    const rm = new ResourceManager(app.rm.api);
    await rm.loadMaterialMap();
    for (const f of files) { rm.utfCache.set(f.path.toLowerCase().replace(/\//g, '\\'), Promise.resolve(f.root)); }
    rm.register(F.root); for (const f of files) rm.register(f.root);
    await rm.loadLibs(libs);
    let obj = null;
    if (previewMode === 'model' && model) obj = await rm.model(model, libs).catch(e => { console.warn(e); return null; });
    else if (selMat) { const m = rm.material(dacomCrc(selMat.name)); obj = new THREE.Mesh(new THREE.SphereGeometry(10, 48, 32), m); obj.userData.radius = 10; obj.userData.center = new THREE.Vector3(); }
    if (my !== pvToken) return;
    if (shown) scene.remove(shown);
    shown = obj; if (!obj) return;
    scene.add(obj);
    if (!framed || obj.isMesh) { const R = obj.userData.radius || 10, c = obj.userData.center || new THREE.Vector3(); orbit.target.copy(c); camera.position.copy(c).add(new THREE.Vector3(R * 1.4, R * 0.8, R * 1.8)); orbit.update(); framed = !obj.isMesh; }
  }

  // ---------- panel
  const fileSel = h('select', { onchange: () => { F = files[+fileSel.value]; selMat = selTex = null; render(); schedulePreview(); } }, files.map((f, i) => h('option', { value: i, selected: f === F }, f.path.split('/').pop())));
  const pvSel = h('select', { title: 'preview', onchange: () => { previewMode = pvSel.value; framed = false; schedulePreview(); } }, model ? h('option', { value: 'model', selected: previewMode === 'model' }, 'model') : null, h('option', { value: 'sphere', selected: previewMode === 'sphere' }, 'sphere (selected material)'));
  const tabs = h('div', { class: 'btnrow' });
  const left = h('div', { style: { overflow: 'auto', fontSize: '12px' } });
  const right = h('div', { style: { overflow: 'auto', fontSize: '12px' } });
  const titleEl = h('span', { style: { color: '#ffb366', fontSize: '12px' } });
  const showDirty = () => { titleEl.textContent = anyDirty() ? ' ● unsaved' : ''; };
  const unbind = [];
  const keys = (e) => { if (!(e.ctrlKey || e.metaKey) || /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return; const k = e.key.toLowerCase(); if (k === 'z' || k === 'y') { e.preventDefault(); e.stopPropagation(); (k === 'y' || e.shiftKey) ? H().redo() : H().undo(); } };
  document.addEventListener('keydown', keys, true); unbind.push(() => document.removeEventListener('keydown', keys, true));
  async function save() {
    try {
      for (const f of files) { const x = hist.get(f); if (!x || !x.dirty) continue; await api.write(f.path, writeUtf(f.root)); x.markSaved(); refreshMain(f); }
      showDirty(); toast('Saved (originals backed up)');
    } catch (e) { toast('Save failed: ' + e.message); }
  }
  // the main view caches materials/textures by name: drop this file's entries and reload it
  function refreshMain(f) {
    const rm = app.rm; rm.invalidate(f.path);
    const ml = f.root.child('Material library'), tl = f.root.child('Texture library');
    if (ml) for (const m of ml.children || []) rm.materials.delete(dacomCrc(m.name));
    if (tl) for (const t of tl.children || []) { rm.textures.delete(lc(t.name)); const tx = rm.texCache.get(lc(t.name)); if (tx) tx.dispose(); rm.texCache.delete(lc(t.name)); }
    for (const m of rm.matCache.values()) m.dispose && m.dispose(); rm.matCache.clear(); rm.modelCache.clear();
    rm.loadUtf(f.path).then(() => app.rebuildVisuals && app.rebuildVisuals());
  }
  const m = modal({
    title: `Materials & textures${title ? ' · ' + title : ''}`, wide: true,
    onClose: () => { running = false; ro.disconnect(); renderer.dispose(); unbind.forEach(f => f()); },
    body: h('div', { style: { display: 'grid', gridTemplateColumns: '250px 1fr 380px', gap: '10px', height: 'calc(100vh - 190px)' } },
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', minHeight: 0 } }, h('div', { class: 'btnrow' }, fileSel), tabs, left),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', minHeight: 0 } }, h('div', { class: 'btnrow', style: { alignItems: 'center', fontSize: '12px' } }, 'Preview ', pvSel, h('span', { style: { color: 'var(--faint)' } }, 'unsaved changes show here; the main view updates on Save')), view),
      right),
    buttons: [{ el: h('button', { class: 'btn', onclick: () => H().undo() }, '↶ Undo') }, { el: h('button', { class: 'btn', onclick: () => H().redo() }, '↷ Redo') },
      { label: 'Close', onClick: async () => !anyDirty() || await confirmDialog('Discard changes?', 'Materials or textures have unsaved changes.', 'Discard', true) },
      { label: 'Save', cls: 'primary', onClick: async () => { await save(); return false; } }],
  });
  m.box.classList.add('xwide'); m.box.querySelector('header h2').append(titleEl);

  const mats = () => (F.root.child('Material library')?.children || []).filter(n => !n.isLeaf);
  const texs = () => (F.root.child('Texture library')?.children || []).filter(n => !n.isLeaf);
  const allTexNames = () => { const s = new Set(); for (const f of files) for (const t of f.root.child('Texture library')?.children || []) s.add(t.name); return [...s].sort(); };
  const usedBy = (tname) => { const out = []; for (const f of files) for (const mm of f.root.child('Material library')?.children || []) for (const c of mm.children || []) if (/_name$/i.test(c.name) && lc(c.str()) === lc(tname)) out.push(mm.name); return out; };
  const edit = (fn) => { const hh = H(); fn(); hh.push(); showDirty(); render(); schedulePreview(); };

  function render() {
    tabs.innerHTML = '';
    const nm = mats().length, nt = texs().length;
    tabs.append(h('button', { class: 'btn sm' + (tab === 'materials' ? ' primary' : ''), onclick: () => { tab = 'materials'; render(); } }, `Materials ${nm}`), h('button', { class: 'btn sm' + (tab === 'textures' ? ' primary' : ''), onclick: () => { tab = 'textures'; render(); } }, `Textures ${nt}`));
    left.innerHTML = '';
    if (selMat && !mats().includes(selMat)) selMat = null;
    if (selTex && !texs().includes(selTex)) selTex = null;
    if (tab === 'materials') {
      left.append(h('div', { class: 'btnrow', style: { marginBottom: '4px' } },
        h('button', { class: 'btn sm', onclick: addMaterial }, '+ New'),
        selMat ? h('button', { class: 'btn sm', onclick: () => dupMaterial(selMat) }, 'Duplicate') : null));
      for (const n of mats()) {
        const d = parseMaterial(n);
        left.append(h('div', { style: { padding: '3px 4px', cursor: 'pointer', borderRadius: '4px', display: 'flex', gap: '6px', alignItems: 'center', background: n === selMat ? 'rgba(255,255,255,0.1)' : '' }, onclick: () => { selMat = n; render(); if (previewMode === 'sphere') schedulePreview(); } },
          h('span', { style: { width: '12px', height: '12px', borderRadius: '3px', background: hexCol(d.dc), flex: 'none', border: '1px solid #0006' } }), h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, n.name), h('span', { style: { color: 'var(--faint)', fontSize: '10px' } }, d.type)));
      }
      if (!nm) left.append(h('div', { style: { color: 'var(--faint)' } }, 'No materials in this file.'));
      renderMaterial();
    } else {
      left.append(h('div', { class: 'btnrow', style: { marginBottom: '4px' } }, h('button', { class: 'btn sm', onclick: () => importTexture(null) }, '+ Add from image…')));
      for (const n of texs()) left.append(h('div', { style: { padding: '3px 4px', cursor: 'pointer', borderRadius: '4px', background: n === selTex ? 'rgba(255,255,255,0.1)' : '' }, onclick: () => { selTex = n; render(); } }, n.name, h('span', { style: { color: 'var(--faint)', fontSize: '10px' } }, ' · ' + texFormat(n))));
      if (!nt) left.append(h('div', { style: { color: 'var(--faint)' } }, 'No textures in this file.'));
      renderTexture();
    }
  }
  function renderMaterial() {
    right.innerHTML = '';
    const n = selMat; if (!n) { right.append(h('div', { style: { color: 'var(--faint)' } }, 'Pick a material.')); return; }
    const d = parseMaterial(n);
    const row = (label, ...kids) => h('div', { style: { display: 'grid', gridTemplateColumns: '120px 1fr', alignItems: 'center', gap: '6px', margin: '3px 0' } }, h('span', { style: { color: 'var(--dim)' } }, label), h('div', { class: 'btnrow', style: { alignItems: 'center' } }, ...kids));
    const typeIn = h('input', { value: d.type, list: 'fl-mattypes', style: { width: '100%' }, onchange: () => edit(() => setLeaf(n, 'Type', strBytes(typeIn.value.trim() || 'DcDt'))) });
    right.append(h('datalist', { id: 'fl-mattypes' }, MATERIAL_TYPES.map(t => h('option', { value: t }))),
      h('h3', { style: { margin: '0 0 6px' } }, n.name), h('div', { style: { color: 'var(--faint)', marginBottom: '6px' } }, `crc 0x${(dacomCrc(n.name) >>> 0).toString(16)} · models refer to materials by this name, so it cannot be renamed here`),
      row('Type', typeIn));
    for (const [k, label] of COLOURS) {
      const c = n.child(k), v = c && c.data.byteLength >= 12 ? c.floats().slice(0, 3) : null;
      const pick = h('input', { type: 'color', value: hexCol(v || [1, 1, 1]), oninput: () => { /* live */ }, onchange: () => edit(() => setLeaf(n, k, f32s(colHex(pick.value)))) });
      const nums = h('span', { style: { fontFamily: 'var(--mono)', color: 'var(--faint)', fontSize: '11px' } }, v ? v.map(x => +x.toFixed(3)).join(', ') : '—');
      right.append(row(`${k} · ${label}`, v ? pick : h('button', { class: 'btn sm', onclick: () => edit(() => setLeaf(n, k, f32s(k === 'Dc' ? [1, 1, 1] : [0, 0, 0]))) }, '+ add'), nums, v ? h('button', { class: 'btn sm', title: 'remove', onclick: () => edit(() => setLeaf(n, k, null)) }, '×') : null));
    }
    for (const [k, label] of NUMBERS) {
      const c = n.child(k); if (!c && k !== 'Oc') continue;
      const inp = h('input', { type: 'number', step: 0.05, value: c ? +c.f32(0).toFixed(4) : 1, style: { width: '80px' }, onchange: () => edit(() => setLeaf(n, k, f32s([+inp.value]))) });
      const sl = k === 'Oc' || k === 'Alpha' ? h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: c ? c.f32(0) : 1, oninput: () => { inp.value = sl.value; }, onchange: () => edit(() => setLeaf(n, k, f32s([+sl.value]))) }) : null;
      right.append(row(`${k} · ${label}`, sl, inp, c ? h('button', { class: 'btn sm', title: 'remove', onclick: () => edit(() => setLeaf(n, k, null)) }, '×') : null));
    }
    right.append(h('h4', { style: { margin: '10px 0 4px' } }, 'Textures'), h('datalist', { id: 'fl-texnames' }, allTexNames().map(t => h('option', { value: t }))));
    for (const [k, label] of SLOTS) {
      const c = n.child(k + '_name'), fl = n.child(k + '_flags');
      if (!c && !['Dt', 'Et'].includes(k)) continue;
      const nameIn = h('input', { value: c ? c.str() : '', list: 'fl-texnames', placeholder: '(none)', style: { flex: 1, minWidth: 0 }, onchange: () => edit(() => { const v = nameIn.value.trim(); setLeaf(n, k + '_name', v ? strBytes(v) : null); if (v && !n.child(k + '_flags')) setLeaf(n, k + '_flags', u32s([64])); if (!v) setLeaf(n, k + '_flags', null); }) });
      const tn = c && c.str(); const known = tn && allTexNames().some(t => lc(t) === lc(tn));
      right.append(row(`${k} · ${label}`, nameIn, fl ? h('span', { style: { color: 'var(--faint)', fontSize: '10px' }, title: 'texture flags (64 = wrap)' }, `flags ${fl.u32()}`) : null,
        tn ? h('span', { title: known ? 'in this file / its libraries' : 'not in these files — must come from another loaded library', style: { color: known ? '#7ee787' : '#ffb366' } }, known ? '●' : '?') : null,
        tn && known ? h('button', { class: 'btn sm', onclick: () => { const f = files.find(f => (f.root.child('Texture library')?.children || []).some(t => lc(t.name) === lc(tn))); if (f && f !== F) { F = f; fileSel.value = files.indexOf(f); } tab = 'textures'; selTex = texs().find(t => lc(t.name) === lc(tn)); render(); } }, 'Open') : null));
    }
    const other = n.children.filter(c => !['type', ...COLOURS.map(x => lc(x[0])), ...NUMBERS.map(x => lc(x[0])), ...SLOTS.flatMap(([k]) => [lc(k) + '_name', lc(k) + '_flags'])].includes(lc(c.name)));
    if (other.length) right.append(h('div', { style: { color: 'var(--faint)', marginTop: '8px' } }, 'Other values (edit in the UTF browser): ' + other.map(c => c.name).join(', ')));
    right.append(h('div', { class: 'btnrow', style: { marginTop: '12px' } }, h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmDialog('Delete material', `Delete ${n.name}? Models that use it will draw untextured grey.`, 'Delete', true)) edit(() => { const ml = F.root.child('Material library'); ml.children.splice(ml.children.indexOf(n), 1); selMat = null; }); } }, 'Delete material')));
  }
  function renderTexture() {
    right.innerHTML = '';
    const n = selTex; if (!n) { right.append(h('div', { style: { color: 'var(--faint)' } }, 'Pick a texture.')); return; }
    let img = null; try { img = decodeTextureNode(n); } catch (e) { console.warn(e); }
    const users = usedBy(n.name);
    right.append(h('h3', { style: { margin: '0 0 6px' } }, n.name));
    if (img) { const t = thumb(img, 340); right.append(t.cv, h('div', { style: { color: 'var(--dim)', margin: '4px 0' } }, `${img.w} × ${img.h} · ${texFormat(n)}`)); }
    else right.append(h('div', { style: { color: '#ffb366' } }, 'Cannot decode this texture.'));
    right.append(h('div', { style: { margin: '6px 0' } }, h('span', { style: { color: 'var(--dim)' } }, 'Used by: '), users.length ? users.join(', ') : h('i', { style: { color: 'var(--faint)' } }, 'no material in these files')),
      h('div', { class: 'btnrow', style: { marginTop: '8px' } },
        h('button', { class: 'btn sm primary', onclick: () => importTexture(n) }, 'Replace from image…'),
        img ? h('button', { class: 'btn sm', onclick: () => { const t = thumb(img, 1e9); t.full.toBlob(b => { const a = h('a', { href: URL.createObjectURL(b), download: n.name.replace(/\.[^.]*$/, '') + '.png' }); document.body.append(a); a.click(); a.remove(); }); } }, 'Export PNG') : null,
        h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmDialog('Delete texture', `Delete ${n.name}?${users.length ? ` ${users.length} material(s) use it.` : ''}`, 'Delete', true)) edit(() => { const tl = F.root.child('Texture library'); tl.children.splice(tl.children.indexOf(n), 1); selTex = null; }); } }, 'Delete')),
      h('div', { style: { color: 'var(--faint)', marginTop: '8px' } }, 'Images are resized to a power of two (max 2048) and stored as DXT1 (no transparency) or DXT5 (with transparency) with mipmaps. A material shows the texture\'s transparency only with an …OcOt type.'));
  }
  function pickImage() { return new Promise(res => { const i = h('input', { type: 'file', accept: '.png,.jpg,.jpeg,.webp,.bmp,.dds' }); i.onchange = () => res(i.files[0] || null); i.click(); }); }
  async function importTexture(node) {
    const file = await pickImage(); if (!file) return;
    let img; try { img = await decodeImage(file); } catch (e) { toast('Cannot read image: ' + e.message); return; }
    let name = node ? node.name : await promptDialog('New texture', 'Texture name (materials refer to it by this name)', file.name.replace(/\.[^.]*$/, '') + '.tga');
    if (!name) return;
    const enc = img.dds ? { bytes: img.dds, format: 'DDS', w: img.w, h: img.h } : rgbaToFlDDS(img.rgba, img.w, img.h);
    edit(() => {
      const tl = ensureDir(F.root, 'Texture library');
      let n = node || tl.children.find(t => lc(t.name) === lc(name));
      if (!n) { n = new UtfNode(name); tl.children.push(n); }
      n.children = [new UtfNode('MIPS', enc.bytes)];
      selTex = n; tab = 'textures';
    });
    toast(`${name}: ${enc.w} × ${enc.h} ${enc.format}`);
  }
  async function addMaterial() {
    const name = await promptDialog('New material', 'Material name (unique; models refer to it by this name)', 'new_material'); if (!name) return;
    if (mats().some(x => lc(x.name) === lc(name))) { toast('A material with that name exists'); return; }
    edit(() => { const ml = ensureDir(F.root, 'Material library'); const n = new UtfNode(name); n.children.push(new UtfNode('Type', strBytes('DcDt')), new UtfNode('Dc', f32s([1, 1, 1])), new UtfNode('Oc', f32s([1]))); ml.children.push(n); selMat = n; });
  }
  async function dupMaterial(src) {
    const name = await promptDialog('Duplicate material', 'Name of the copy', src.name + '_copy'); if (!name) return;
    if (mats().some(x => lc(x.name) === lc(name))) { toast('A material with that name exists'); return; }
    edit(() => { const n = new UtfNode(name); n.children = src.children.map(c => new UtfNode(c.name, c.data ? c.data.slice() : null)); const ml = F.root.child('Material library'); ml.children.splice(ml.children.indexOf(src) + 1, 0, n); selMat = n; });
  }
  selMat = mats()[0] || null; if (!mats().length) tab = 'textures';
  render(); preview();
  return { files, get F() { return F; }, select: (name) => { selMat = mats().find(x => lc(x.name) === lc(name)) || selMat; render(); schedulePreview(); }, save, setTab: (t) => { tab = t; render(); }, history: H };
}
