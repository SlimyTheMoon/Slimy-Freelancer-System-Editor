// Base interiors (Tools menu, and "Interiors…" on a base): every room of a base in 3D — the room's own scripts
// (set script + ambient scenes from the room INI, as in the cutscene player), its fixtures (bartender, dealers…)
// at their markers playing their fidget scripts, and the bar characters of the room on the free seats and
// standing spots — with the room INI ([Room_Info], [Room_Sound], [Camera], [CharacterPlacement], [Hotspot]…)
// and the mbases.ini [MRoom] (density, fixtures) editable next to it. Edits use the shared undo and Ctrl+S.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { h, modal, toast, datalist } from './dom.js';
import { api, dataPath } from '../api.js';
import { loadIni } from '../gamedata.js';
import { parseThn, mergeScripts, Runtime } from './thnplayer.js';
import { characterData, loadCharacter } from '../formats/dfm.js';
import { baseBlocks } from './mbases.js';

const lc = (s) => String(s || '').toLowerCase();
const MARKER_RX = /^z[gs]\/(npc|pc)\//i;

function idleFor(data, sex, marker) {
  const pre = sex === 'female' ? 'FMBODY' : 'MLBODY';
  const want = /sitlow/i.test(marker) ? `${pre}_CHRB_IDLE_000LV` : /sithigh/i.test(marker) ? `${pre}_CHRF_IDLE_000LV` : `${pre}_STND_IDLE_000LV`;
  return [...data.scripts.values()].find(s => s.name.toUpperCase().startsWith('SC_' + want)) || null;
}

// DATA\SCRIPTS\GCS\genericscripts.ini: [GenericScripts] with running set_segment / set_gender / set_posture and
// script = lines → Map("segment|gender|posture" → [paths]). The game
// gives a generic bar character the fidget scripts of its gender for the posture of its spot.
let _generic = null;
export function genericScripts() {
  return _generic || (_generic = (async () => {
    const out = new Map(), ini = await loadIni(dataPath('scripts\\gcs\\genericscripts.ini')).catch(() => null);
    if (ini) for (const sec of ini.sections) {
      let seg = '', gen = '', pos = '';
      for (const e of sec.entries) {
        const k = lc(e.key), v = lc(e.value);
        if (k === 'set_segment') seg = v; else if (k === 'set_gender') gen = v; else if (k === 'set_posture') pos = v;
        else if (k === 'script') { const key = `${seg}|${gen}|${pos}`; if (!out.has(key)) out.set(key, []); out.get(key).push(e.value); }
      }
    }
    return out;
  })());
}
const hashPick = (list, s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; return list[Math.abs(h) % list.length]; };

export async function baseInteriors(app, { base: startBase = null, room: startRoom = null } = {}) {
  const g = app.game;
  const mdoc = await app.otherDoc(dataPath('missions\\mbases.ini'));
  let chars = null; const getChars = async () => chars || (chars = await characterData(app, loadIni, dataPath));
  const vendorThn = (await api.find('DATA/SCRIPTS/VENDORS', ['.thn'])).map(p => p.replace(/^DATA\//i, '').replace(/\//g, '\\'));
  const dlFidget = datalist(vendorThn);
  // ---- layout
  const baseSel = h('select', { style: { width: '100%' } }, g.bases.map(b => h('option', { value: b.nickname, selected: lc(b.nickname) === lc(startBase) }, `${g.name(b.strid) || b.nickname} (${b.nickname})`)));
  const roomList = h('div', { style: { margin: '6px 0' } });
  const canvas = h('canvas', { style: { width: '100%', height: '100%', display: 'block', background: '#000', borderRadius: '6px' } });
  const badge = h('div', { style: { position: 'absolute', left: '8px', top: '6px', color: '#9cf', fontSize: '11px', fontFamily: 'var(--mono)', textShadow: '0 1px 2px #000', pointerEvents: 'none' } });
  const view = h('div', { style: { position: 'relative', height: 'calc(100vh - 250px)', minHeight: '320px' } }, canvas, badge);
  const camSel = h('select', {});
  const markersChk = h('input', { type: 'checkbox', checked: true });
  const side = h('div', { style: { height: 'calc(100vh - 220px)', overflow: 'auto', fontSize: '12px' } });
  const m = modal({ title: 'Base interiors', wide: true, onClose: () => { running = false; renderer.dispose(); app.dialogRefreshers.delete(refresh); },
    body: h('div', { style: { display: 'grid', gridTemplateColumns: '230px 1fr 400px', gap: '10px' } },
      h('div', {}, baseSel, roomList), h('div', {}, view, h('div', { class: 'btnrow', style: { marginTop: '6px', alignItems: 'center' } }, 'View', camSel, h('label', {}, markersChk, ' markers'), h('span', { style: { color: 'var(--faint)', fontSize: '11px' } }, 'Click a marker to see its name; with a fixture selected, “Use” puts it there.'))), side, dlFidget.el),
    buttons: [{ label: 'Close' }] });
  m.box.classList.add('xwide');

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true }); renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  const free = new THREE.PerspectiveCamera(50, 1, 0.05, 1e6); free.position.set(5, 3, 8);
  const cam = new THREE.PerspectiveCamera(50, 1, 0.05, 1e6), bgCam = new THREE.PerspectiveCamera();
  const orbit = new OrbitControls(free, canvas); orbit.enableDamping = true;
  const markerGroup = new THREE.Group(); scene.add(markerGroup);
  canvas.__fl = { scene, cam, get chars() { return chars3d; } }; // for tests
  let running = true, last = performance.now(), rt = null, chars3d = [], roomDoc = null, baseDoc = null, room = null, picked = null, fixtureSel = null, buildToken = 0;
  const resize = () => { const r = view.getBoundingClientRect(); if (!r.width) return; renderer.setSize(r.width, r.height, false); free.aspect = r.width / r.height; free.updateProjectionMatrix(); };
  new ResizeObserver(resize).observe(view);

  (function loop() {
    if (!running) return;
    const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000); last = now;
    let camera = free;
    if (rt) {
      const T = rt.script.duration || 60;
      let t = rt.t + dt; if (t > T) { rt.reset(); t = 0; }
      rt.seek(t);
      for (const c of chars3d) c.tick(dt);
      for (const o of rt.objects.values()) if (o.helper) o.helper.visible = false;
      markerGroup.visible = markersChk.checked && camSel.value === '';
      const o = camSel.value && rt.obj(camSel.value);
      if (o && o.cam) {
        o.node.updateMatrixWorld(true); cam.position.setFromMatrixPosition(o.node.matrixWorld); cam.quaternion.setFromRotationMatrix(new THREE.Matrix4().extractRotation(o.node.matrixWorld));
        const r = view.getBoundingClientRect(); cam.aspect = r.width / Math.max(1, r.height); cam.fov = 2 * Math.atan(Math.tan(o.cam.fovh * Math.PI / 180) / cam.aspect) * 180 / Math.PI; cam.near = 0.05; cam.far = 1e6; cam.updateProjectionMatrix(); camera = cam;
      } else orbit.update();
      renderer.autoClear = false; renderer.clear();
      if (rt.bg.children.length) { bgCam.copy(camera); bgCam.position.set(0, 0, 0); bgCam.near = 0.1; bgCam.far = 1e5; bgCam.updateProjectionMatrix(); renderer.render(rt.bg, bgCam); renderer.clearDepth(); }
    } else { orbit.update(); renderer.autoClear = true; }
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  })();

  // picking markers
  canvas.addEventListener('pointerdown', (e) => { canvas._down = [e.clientX, e.clientY]; });
  canvas.addEventListener('pointerup', (e) => {
    if (!canvas._down || Math.hypot(e.clientX - canvas._down[0], e.clientY - canvas._down[1]) > 4 || camSel.value) return;
    const r = canvas.getBoundingClientRect(), ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), free);
    const hit = ray.intersectObjects(markerGroup.children, false)[0];
    if (hit) { picked = hit.object.userData.name; for (const c of markerGroup.children) c.material.color.set(c.userData.name === picked ? 0xffffff : c.userData.color); renderSide(); }
  });

  const baseNick = () => baseSel.value;
  const block = () => mdoc ? baseBlocks(mdoc.ini).get(lc(baseNick())) : null;
  const npcSection = (nick) => mdoc && mdoc.ini.sections.find(s => s.is('GF_NPC') && lc(s.get('nickname')) === lc(nick));
  const mroom = () => { const b = block(); return b ? b.secs.find(s => s.is('MRoom') && lc(s.get('nickname')) === lc(room && room.nickname)) : null; };
  const edit = (doc, label, fn) => { app.history.do(label, [doc], fn); renderSide(); scheduleRebuild(); };

  async function loadBase() {
    const b = g.findBase(baseNick()); roomList.innerHTML = ''; baseDoc = null;
    if (!b || !b.file) { roomList.append(h('div', { class: 'empty' }, 'This base has no base INI.')); return; }
    baseDoc = await app.otherDoc(dataPath(b.file));
    if (!baseDoc) { roomList.append(h('div', { class: 'empty' }, 'Base INI not found: ' + b.file)); return; }
    const info = baseDoc.ini.first('BaseInfo');
    const rooms = baseDoc.ini.all('Room').map(s => ({ nickname: s.get('nickname'), file: s.get('file'), section: s })).filter(r => r.nickname);
    for (const r of rooms) roomList.append(h('div', { style: { padding: '3px 6px', cursor: 'pointer', borderRadius: '4px' }, 'data-r': lc(r.nickname), onclick: () => openRoom(r) }, r.nickname, lc(info && info.get('start_room')) === lc(r.nickname) ? h('span', { style: { color: 'var(--faint)' } }, ' · start') : null));
    const want = rooms.find(r => lc(r.nickname) === lc(startRoom)) || rooms.find(r => /bar/i.test(r.nickname)) || rooms[0];
    startRoom = null;
    if (want) openRoom(want);
  }
  async function openRoom(r) {
    room = r; picked = null; fixtureSel = null;
    for (const el of roomList.children) el.style.background = el.dataset.r === lc(r.nickname) ? 'rgba(255,210,80,.15)' : '';
    roomDoc = r.file ? await app.otherDoc(dataPath(r.file)) : null;
    renderSide(); await rebuild();
  }
  let rebuildTimer = null;
  const scheduleRebuild = () => { clearTimeout(rebuildTimer); rebuildTimer = setTimeout(rebuild, 400); };

  async function rebuild() {
    const my = ++buildToken;
    if (rt) { rt.dispose(); rt = null; }
    for (const c of chars3d) scene.remove(c.object); chars3d = [];
    markerGroup.clear();
    if (!roomDoc) { badge.textContent = 'no room INI'; return; }
    badge.textContent = 'loading room…';
    const info = roomDoc.ini.first('Room_Info');
    const paths = info ? [info.get('set_script'), ...info.getAll('scene').map(v => v.split(',').map(x => x.trim()).find(x => /\.thn$/i.test(x)))].filter(Boolean) : [];
    const scripts = [];
    for (const p of paths) { const b = await api.read(dataPath(p)); if (b) try { scripts.push({ path: p, script: parseThn(b) }); } catch (e) { console.warn(p, e); } }
    if (my !== buildToken) return;
    if (!scripts.length) { badge.textContent = 'the room has no scripts'; return; }
    const merged = mergeScripts(scripts[0].script, scripts.slice(1));
    const r = new Runtime(app, merged, scene);
    await r.build((i, n) => { if (my === buildToken) badge.textContent = `loading ${i}/${n}…`; });
    if (my !== buildToken) { r.dispose(); return; }
    rt = r;
    if (info && info.get('animation')) rt.loopRoomAnimation(info.get('animation'));
    rt.seek(0.05);
    // markers
    const markers = [...rt.objects.values()].filter(o => o.ent.type === 7 && MARKER_RX.test(o.ent.name));
    for (const o of markers) {
      o.node.updateMatrixWorld(true);
      const col = /^zs\//i.test(o.ent.name) ? 0xffa64d : /\/pc\//i.test(o.ent.name) ? 0x66ccff : 0x6ee07a;
      const s = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), new THREE.MeshBasicMaterial({ color: col, depthTest: false, transparent: true, opacity: 0.85 }));
      s.renderOrder = 10; s.position.setFromMatrixPosition(o.node.matrixWorld); s.userData = { name: o.ent.name, color: col }; markerGroup.add(s);
    }
    // cameras
    const cams = [...rt.objects.values()].filter(o => o.cam).map(o => o.ent.name);
    const roomCam = (roomDoc.ini.first('Camera') || { get: () => null }).get('name');
    camSel.innerHTML = ''; camSel.append(h('option', { value: '' }, 'Free camera'), ...cams.map(c => h('option', { value: c, selected: lc(c) === lc(roomCam) }, c + (lc(c) === lc(roomCam) ? ' (room camera)' : ''))));
    // frame
    const box = new THREE.Box3(); for (const o of rt.objects.values()) if (o.model && !o.starsphere) box.expandByObject(o.node);
    if (!box.isEmpty()) { const sp = box.getBoundingSphere(new THREE.Sphere()); orbit.target.copy(sp.center); free.position.copy(sp.center).add(new THREE.Vector3(0.6, 0.5, 0.8).multiplyScalar(Math.max(4, sp.radius * 0.8))); }
    await placeCharacters(my, markers);
    if (my === buildToken) { badge.textContent = `${room.nickname} · ${markers.length} markers · ${chars3d.length} characters`; renderSide(); }
  }

  // fixtures with their fidget scripts, then the room's bar characters on free spots
  async function placeCharacters(my, markers) {
    await getChars();
    const mr = mroom(); const used = new Set();
    const generic = await genericScripts();
    const put = async (npc, markerName, fidget) => {
      const s = npcSection(npc); if (!s) return;
      const mk = rt.obj(markerName); if (!mk) return;
      const ch = await loadCharacter(app, chars, { body: s.get('body'), head: s.get('head'), leftHand: s.get('lefthand'), rightHand: s.get('righthand'), accessory: s.get('accessory') }, dataPath).catch(() => null);
      if (!ch || my !== buildToken) return;
      // placement as in the game: the spot's X/Z and facing, Y = floor (0) +
      // the animation's root height, plus the root motion of the running animation
      mk.node.updateMatrixWorld(true);
      const spotPos = new THREE.Vector3().setFromMatrixPosition(mk.node.matrixWorld), spotQuat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(mk.node.matrixWorld));
      let basePos = spotPos.clone(), baseQuat = spotQuat.clone(), lastRoot = null;
      ch.object.matrixAutoUpdate = false;
      scene.add(ch.object); used.add(lc(markerName));
      if (!fidget) { // a generic character: a fidget script for its gender and the spot's posture
        const posture = lc(markerName.split('/').pop());
        const list = generic.get(`fidget|${ch.sex}|${posture}`) || generic.get(`fidget|${ch.sex}|stand`);
        if (list && list.length) fidget = hashPick(list, npc + markerName);
      }
      let plan = null, fidgetT = 0, idx = 0;
      if (fidget) {
        const b = await api.read(dataPath(fidget));
        if (b) try { const f = parseThn(b); const dfm = [...f.entities.values()].find(e => e.type === 2); plan = { file: fidget, dur: f.duration || 30, evs: f.events.filter(e => e.type === 10 && dfm && e.targets.some(t => lc(t) === lc(dfm.name))) }; } catch { }
      }
      if (!plan || !plan.evs.length) { const idle = idleFor(chars, ch.sex, markerName); if (idle) ch.start(idle, { loop: true }); }
      const place = () => {
        if (ch.rootInst !== lastRoot) { // a new root-motion script starts from where the character is now
          if (lastRoot && ch.rootInst) { basePos.copy(ch.object.position); baseQuat.copy(ch.object.quaternion); }
          lastRoot = ch.rootInst;
        }
        const m = ch.rootMotion();
        ch.object.quaternion.copy(baseQuat); ch.object.position.copy(basePos);
        if (m) { ch.object.position.add(m.tr.clone().applyQuaternion(baseQuat)); ch.object.quaternion.multiply(m.rot); }
        ch.object.position.y = (ch.floorHeight || 0) + (ch.rootHeight || 0);
        ch.object.matrix.compose(ch.object.position, ch.object.quaternion, ch.object.scale); ch.object.matrixWorldNeedsUpdate = true;
      };
      chars3d.push({ object: ch.object, npc, marker: markerName, fidget: plan && plan.file, ch, tick(dt) {
        if (plan && plan.evs.length) {
          fidgetT += dt;
          if (fidgetT > plan.dur) { fidgetT = 0; idx = 0; basePos.copy(spotPos); baseQuat.copy(spotQuat); lastRoot = null; } // the fidget repeats from the spot
          while (idx < plan.evs.length && plan.evs[idx].time <= fidgetT) { const e = plan.evs[idx++]; const sc = chars.scripts.get(lc(e.props.get('animation'))); if (sc) ch.start(sc, { startTime: +(e.props.get('start_time') || 0), timeScale: +(e.props.get('time_scale') || 1), duration: e.duration, loop: +(e.props.get('event_flags') || 0) === 2 }); }
        }
        ch.update(dt); place();
      } });
      chars3d[chars3d.length - 1].tick(0);
    };
    if (mr) for (const e of mr.entries) if (lc(e.key) === 'fixture') { const [npc, mk, fidget] = e.values; await put(npc, mk, fidget); }
    // the base's characters assigned to this room, on free generic spots
    const b = block(); if (!b) return;
    const roomNpcs = new Set(); for (const f of b.secs.filter(s => s.is('BaseFaction'))) for (const e of f.entries) if (lc(e.key) === 'npc') roomNpcs.add(lc(e.value));
    const spots = markers.filter(o => /^zg\/npc\//i.test(o.ent.name) && !used.has(lc(o.ent.name))).map(o => o.ent.name);
    const density = mr ? parseInt(mr.get('character_density') || '0') || 0 : 0;
    let n = 0;
    for (const nick of roomNpcs) {
      const s = npcSection(nick); if (!s || lc(s.get('room')) !== lc(room.nickname)) continue;
      if (n >= spots.length || (density && n >= density)) break;
      await put(s.get('nickname'), spots[n++], null);
    }
  }

  // ---------------- side panel ----------------
  function kvSection(doc, sec, title, opts = {}) {
    const wrap = h('div', { class: 'psec', style: { marginTop: '8px' } }, h('h3', {}, title, opts.remove ? h('span', { class: 'act' }, h('button', { class: 'btn sm', onclick: () => edit(doc, 'Remove [' + sec.name + ']', () => doc.ini.removeSection(sec)) }, '×')) : null));
    const grid = h('div', { style: { display: 'grid', gridTemplateColumns: '120px 1fr 22px', gap: '3px 6px', alignItems: 'center' } });
    for (const e of sec.entries) {
      const inp = h('input', { value: e.value, list: opts.lists && opts.lists[lc(e.key)], style: { width: '100%' }, onchange: () => edit(doc, `${sec.name} ${e.key}`, () => { e.value = inp.value; e.raw = null; }) });
      const extra = /^(music|ambient)$/i.test(e.key) ? h('button', { class: 'btn sm', title: 'play', style: { padding: '0 5px' }, onclick: async () => { const A = await import('../formats/audio.js'); const r = await A.soundBytes(app, e.values[0]); if (!r) return toast('sound not found'); A.playBuffer(await A.decodeFlWav(r.bytes)); } }, '▶') : null;
      grid.append(h('span', { style: { color: 'var(--dim)' } }, e.key), h('div', { style: { display: 'flex', gap: '3px' } }, inp, extra), h('button', { class: 'x', onclick: () => edit(doc, 'Remove ' + e.key, () => sec.removeEntry(e)) }, '×'));
    }
    const nk = h('input', { placeholder: 'key', style: { width: '100%' } }), nv = h('input', { placeholder: 'value', style: { width: '100%' } });
    grid.append(nk, nv, h('button', { class: 'btn sm', style: { padding: '0 5px' }, onclick: () => { if (nk.value.trim()) edit(doc, 'Add ' + nk.value, () => sec.add(nk.value.trim(), nv.value)); } }, '+'));
    wrap.append(grid);
    return wrap;
  }
  function renderSide() {
    side.innerHTML = '';
    if (!room) { side.append(h('div', { class: 'empty' }, 'Choose a room.')); return; }
    if (picked) side.append(h('div', { class: 'psec' }, h('h3', {}, 'Marker'), h('div', { style: { fontFamily: 'var(--mono)' } }, picked),
      fixtureSel ? h('button', { class: 'btn sm primary', style: { marginTop: '4px' }, onclick: () => { const e = fixtureSel; edit(mdoc, 'Fixture location', () => { const v = e.values; v[1] = picked; e.value = v.join(', '); e.raw = null; }); } }, `Use for ${fixtureSel.values[0]}`) : null));
    // mbases [MRoom]
    const mr = mroom();
    const ms = h('div', { class: 'psec' }, h('h3', {}, `Characters · mbases.ini [MRoom] ${room.nickname}`));
    if (!mdoc) ms.append(h('div', { class: 'empty' }, 'missions\\mbases.ini not found'));
    else if (!mr) ms.append(h('button', { class: 'btn sm', onclick: () => { const b = block(); if (!b) return toast('this base has no [MBase] block in mbases.ini'); const after = b.secs.filter(s => s.is('MRoom')).pop() || b.secs[b.secs.length - 1] || b.mbase; edit(mdoc, 'Add [MRoom]', () => mdoc.ini.addSection('MRoom', after, [['nickname', lc(room.nickname)], ['character_density', '3']])); } }, '+ [MRoom] for this room'));
    else {
      const markerNames = rt ? [...rt.objects.values()].filter(o => o.ent.type === 7 && MARKER_RX.test(o.ent.name)).map(o => o.ent.name) : [];
      const dlMk = datalist(markerNames); ms.append(dlMk.el);
      const blockNpcs = (block() ? block().secs : []).filter(s => s.is('GF_NPC')).map(s => s.get('nickname'));
      const dlNpc = datalist(blockNpcs); ms.append(dlNpc.el);
      const dens = mr.find('character_density');
      ms.append(h('div', { class: 'btnrow', style: { alignItems: 'center' } }, 'character_density', h('input', { type: 'number', value: dens ? dens.value : '', style: { width: '70px' }, onchange: (ev) => edit(mdoc, 'character_density', () => mr.set('character_density', ev.target.value)) })));
      const tbl = h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1.4fr 1.4fr 0.8fr 22px', gap: '3px', marginTop: '6px' } }, ...['fixture (npc)', 'location marker', 'fidget script', 'type', ''].map(t => h('span', { style: { color: 'var(--faint)' } }, t)));
      for (const e of mr.entries.filter(x => lc(x.key) === 'fixture')) {
        const cellIn = (i, list) => h('input', { value: e.values[i] || '', list, style: { width: '100%', outline: fixtureSel === e ? '1px solid #ffd34d' : '' }, onfocus: () => { fixtureSel = e; }, onchange: (ev) => edit(mdoc, 'Fixture', () => { const v = e.values; while (v.length <= i) v.push(''); v[i] = ev.target.value; e.value = v.join(', '); e.raw = null; }) });
        tbl.append(cellIn(0, dlNpc.id), cellIn(1, dlMk.id), cellIn(2, dlFidget.id), cellIn(3), h('button', { class: 'x', onclick: () => edit(mdoc, 'Remove fixture', () => mr.removeEntry(e)) }, '×'));
      }
      ms.append(tbl, h('button', { class: 'btn sm', style: { marginTop: '4px' }, onclick: () => edit(mdoc, 'Add fixture', () => mr.add('fixture', `${blockNpcs[0] || 'npc'}, ${picked || markerNames[0] || ''}, scripts\\vendors\\li_bartender_fidget.thn, bartender`)) }, '+ fixture'));
      const placed = chars3d.map(c => `${c.npc} → ${c.marker}`);
      ms.append(h('div', { style: { color: 'var(--faint)', marginTop: '6px' } }, placed.length ? 'In the view: ' + placed.join(' · ') : 'No characters placed.'),
        h('button', { class: 'btn sm', style: { marginTop: '4px' }, onclick: () => import('./mbases.js').then(mm => mm.basesEditor(app, { base: baseNick() })) }, 'Edit characters (bar editor)…'));
    }
    side.append(ms);
    // room INI
    if (!roomDoc) { side.append(h('div', { class: 'empty' }, 'Room INI not found: ' + (room.file || '—'))); return; }
    side.append(h('div', { style: { color: 'var(--faint)', margin: '8px 0 0' } }, room.file));
    const lists = { music: datalist(g.music).id };
    for (const s of roomDoc.ini.sections) side.append(kvSection(roomDoc, s, `[${s.name}]`, { remove: /hotspot|forsaleship/i.test(s.name), lists }));
    side.append(h('div', { class: 'btnrow', style: { marginTop: '6px' } },
      h('button', { class: 'btn sm', onclick: () => edit(roomDoc, 'Add hotspot', () => roomDoc.ini.addSection('Hotspot', null, [['name', 'IDS_HOTSPOT_EXIT'], ['behavior', 'ExitDoor'], ['room_switch', 'Cityscape']])) }, '+ [Hotspot]'),
      h('button', { class: 'btn sm', onclick: () => edit(roomDoc, 'Add ship placement', () => roomDoc.ini.addSection('ForSaleShipPlacement', null, [['name', 'X/Shipcentre/01']])) }, '+ [ForSaleShipPlacement]')));
  }
  const refresh = () => { renderSide(); scheduleRebuild(); };
  app.dialogRefreshers.add(refresh);
  baseSel.onchange = loadBase;
  await loadBase();
}
