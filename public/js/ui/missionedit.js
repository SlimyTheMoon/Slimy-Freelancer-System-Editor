// Mission script editor (story mission INIs, DATA\MISSIONS\Mxx\mxx.ini).
// A mission is a set of [Trigger]s: each has one Cnd_* condition and any number of Act_* actions;
// Act_ActTrig / Act_DeactTrig switch other triggers on/off and Cnd_WatchTrigger waits for one —
// those links are drawn as a graph. Ships, NPCs, objective lists, dialogs, objectives, formations,
// solars and loot are the "entities" the actions refer to. A node-based
// mission script editor would hide the INI; this one keeps the INI as the single source of truth and edits
// it through the normal undo history, so Ctrl+S / Ctrl+Z work as everywhere else.
import { h, modal, toast, promptDialog, confirmDialog } from './dom.js';
import { IniSection, IniEntry } from '../formats/ini.js';
import { api } from '../api.js';
import { loadIniDocs, keyDoc, keyIsRead, suggestKey, documentedKeys } from '../inidocs.js';

const KINDS = ['MsnShip', 'NPC', 'ObjList', 'Dialog', 'NNObjective', 'MsnFormation', 'MsnSolar', 'MsnLoot'];
// which parameter of a command refers to which section kind (for the problem check)
const REFS = {
  act_acttrig: ['Trigger'], act_deacttrig: ['Trigger'], cnd_watchtrigger: ['Trigger'],
  act_spawnship: ['MsnShip', 'ObjList'], act_giveobjlist: [null, 'ObjList'], act_startdialog: ['Dialog'], act_setnnobj: ['NNObjective'],
  act_spawnformation: ['MsnFormation'], act_spawnsolar: ['MsnSolar'], act_spawnloot: ['MsnLoot'],
};
const EDGE = { act_acttrig: { col: '#5fd38d', label: 'activates' }, act_deacttrig: { col: '#e86a6a', label: 'deactivates' }, cnd_watchtrigger: { col: '#6aaee8', label: 'watches', dash: true } };
// commands used by the vanilla missions (for the command pickers)
const CND = ['Cnd_True', 'Cnd_Timer', 'Cnd_Destroyed', 'Cnd_CommComplete', 'Cnd_DistShip', 'Cnd_DistVec', 'Cnd_DistVecLbl', 'Cnd_DistCircle', 'Cnd_WatchTrigger', 'Cnd_SpaceEnter', 'Cnd_SpaceExit', 'Cnd_BaseEnter', 'Cnd_BaseExit', 'Cnd_LocEnter', 'Cnd_LocExit', 'Cnd_SystemEnter', 'Cnd_SystemExit', 'Cnd_NPCSystemEnter', 'Cnd_ProjHit', 'Cnd_ProjHitShipToLbl', 'Cnd_HealthDec', 'Cnd_TLEntered', 'Cnd_TLExited', 'Cnd_InTradelane', 'Cnd_InSpace', 'Cnd_InZone', 'Cnd_LaunchComplete', 'Cnd_PlayerLaunch', 'Cnd_PlayerManeuver', 'Cnd_MsnResponse', 'Cnd_PopUpDialog', 'Cnd_CharSelect', 'Cnd_TetherBroke', 'Cnd_RTCDone', 'Cnd_LootAcquired', 'Cnd_JumpInComplete', 'Cnd_HasMsn', 'Cnd_WatchVibe', 'Cnd_EncLaunched', 'Cnd_CargoScanned'];
const ACT = ['Act_ActTrig', 'Act_DeactTrig', 'Act_ChangeState', 'Act_SpawnShip', 'Act_SpawnFormation', 'Act_SpawnSolar', 'Act_SpawnLoot', 'Act_Destroy', 'Act_GiveObjList', 'Act_SendComm', 'Act_EtherComm', 'Act_StartDialog', 'Act_SetNNObj', 'Act_SetNNState', 'Act_SetNNHidden', 'Act_NNIds', 'Act_NNPath', 'Act_GiveNNObjs', 'Act_SetVibe', 'Act_SetVibeLbl', 'Act_SetVibeLblToShip', 'Act_SetVibeShipToLbl', 'Act_SetRep', 'Act_LockDock', 'Act_Invulnerable', 'Act_MarkObj', 'Act_Cloak', 'Act_PlayMusic', 'Act_PlaySoundEffect', 'Act_NagOff', 'Act_NagDistLeaving', 'Act_NagDistTowards', 'Act_NagClamp', 'Act_NagGreet', 'Act_PlayerCanDock', 'Act_PlayerCanTradelane', 'Act_PlayerEnemyClamp', 'Act_LightFuse', 'Act_AdjHealth', 'Act_AdjAcct', 'Act_AddRTC', 'Act_RemoveRTC', 'Act_CallThorn', 'Act_RandomPop', 'Act_RandomPopSphere', 'Act_SetLifeTime', 'Act_LockManeuvers', 'Act_EnableManeuver', 'Act_RelocateShip', 'Act_SetOffer', 'Act_Save', 'Act_PobjIdle', 'Act_SetTitle', 'Act_RevertCam', 'Act_StaticCam', 'Act_Jumper', 'Act_SetInitialPlayerPos', 'Act_GCSClamp', 'Act_SetPriority', 'Act_Popupdialog', 'Act_MovePlayer', 'Act_DisableTradelane', 'Act_DisableFriendlyFire', 'Act_RpopAttClamp', 'Act_RpopTLAttacksEnabled', 'Act_HostileClamp', 'Act_SetShipAndLoadout', 'Act_RemoveCargo', 'Act_RemoveAmbient', 'Act_AddAmbient', 'Act_ForceLand', 'Act_DockRequest', 'Act_DisableEnc', 'Act_EnableEnc', 'Act_SetOrient'];
const lc = (s) => (s || '').toLowerCase();
const isCnd = (k) => /^cnd_/i.test(k), isAct = (k) => /^act_/i.test(k);

// parameter slots of a Cnd_/Act_ command from the reference: "2,3,4: x,y,z" → three
// slots, "5..8: quaternion" → four, "7...: accessories" → the rest of the line
export function paramSlots(key) {
  const d = keyDoc('Trigger', key); if (!d || !d.params) return null;
  if (d.multiForm) return null; // several alternative layouts: edit the raw line
  const out = [];
  for (const p of d.params) {
    const at = p.at.replace(/\s/g, '');
    const labels = p.label.split(',').map(x => x.trim());
    if (/\.\.\.$/.test(at)) { out.push({ i: parseInt(at), rest: true, label: p.label, type: p.type, optional: true }); continue; }
    let idx = [];
    const r = /^(\d+)\.\.(\d+)$/.exec(at);
    if (r) for (let i = +r[1]; i <= +r[2]; i++) idx.push(i); else idx = at.split(',').map(Number).filter(n => !isNaN(n));
    const required = !p.optional && p.default === '-' && !/form [a-z]/i.test(p.label);
    idx.forEach((i, j) => { if (!out.some(o => o.i === i)) out.push({ i, label: idx.length > 1 ? (labels.length === idx.length ? labels[j] : `${p.label} ${j + 1}`) : p.label, type: p.type, optional: p.optional, required }); });
  }
  return out.sort((a, b) => a.i - b.i);
}
// problems of one Cnd_/Act_ line against the reference
export function commandProblems(key, values) {
  const out = [];
  if (!/^(cnd|act)_/i.test(key)) return out;
  const d = keyDoc('Trigger', key);
  if (!d) {
    if (keyIsRead('Trigger', key) === false) { const s = suggestKey('Trigger', key); out.push({ sev: 'error', msg: `${key} is not a command the game knows${s ? ` — did you mean ${s}?` : ''}` }); }
    return out;
  }
  const slots = paramSlots(key); if (!slots) return out;
  const vals = values.map(v => v.trim());
  const hasRest = slots.some(x => x.rest), maxI = Math.max(...slots.map(x => x.i));
  for (const sl of slots) {
    if (sl.rest) continue;
    const v = vals[sl.i];
    if ((v === undefined || v === '') && sl.required) out.push({ sev: 'warn', msg: `${key}: missing ${sl.label} (value ${sl.i + 1})` });
    else if (v && /^(int|float)$/.test(sl.type) && isNaN(Number(v))) out.push({ sev: 'warn', msg: `${key}: ${sl.label} should be a number, “${v}” reads as 0` });
  }
  if (!hasRest && vals.length > maxI + 1 && vals.slice(maxI + 1).some(Boolean)) out.push({ sev: 'info', msg: `${key}: ${vals.length - maxI - 1} extra value(s) are ignored by the game` });
  return out;
}

let _msnFiles = null;
export function missionFiles() { return _msnFiles || (_msnFiles = scanMissionFiles().catch(e => { _msnFiles = null; throw e; })); }
async function scanMissionFiles() {
  const dirs = (await api.ls('DATA/MISSIONS')).filter(d => d.dir);
  const lists = await Promise.all(dirs.map(d => api.ls('DATA/MISSIONS/' + d.name))); // parallel: one round trip instead of one per folder
  const out = [];
  dirs.forEach((d, i) => { for (const f of lists[i]) if (!f.dir && /^m\d+[a-z]?\.ini$/i.test(f.name)) out.push(`DATA/MISSIONS/${d.name}/${f.name}`); });
  return out.sort();
}

export async function missionEditor(app, { path = null } = {}) {
  const files = await missionFiles();
  if (!files.length) { toast('No mission scripts found under DATA\\MISSIONS'); return; }
  path = path || files[0];
  let doc, sel = null, view = 'graph', kind = 'MsnShip', q = '';
  const rawMode = new WeakSet();
  await loadIniDocs();
  const posKey = () => 'fled.msnpos.' + lc(path);
  let pos = {};
  const loadPos = () => { try { pos = JSON.parse(localStorage.getItem(posKey()) || '{}'); } catch { pos = {}; } };
  const savePos = () => { try { localStorage.setItem(posKey(), JSON.stringify(pos)); } catch { } };
  const edit = (label, fn) => { app.history.do(label, [doc], fn); refresh(); };

  // ---------- model
  let M = null;
  function model() {
    const ini = doc.ini, trig = ini.all('Trigger');
    const byNick = new Map(trig.map(t => [lc(t.get('nickname')), t]));
    const ents = new Map(), entKinds = new Map(); for (const k of KINDS) for (const s of ini.all(k)) { const n = s.get('nickname'); if (!n) continue; const key = lc(n); if (!ents.has(key) || k === 'MsnShip') ents.set(key, { kind: k, sec: s }); if (!entKinds.has(key)) entKinds.set(key, new Set()); entKinds.get(key).add(k); }
    const labels = new Set(); for (const k of ['MsnShip', 'MsnSolar']) for (const s of ini.all(k)) for (const l of s.getAll('label')) labels.add(lc(l));
    const edges = [];
    for (const t of trig) for (const e of t.entries) { const k = lc(e.key); if (EDGE[k]) { const dst = byNick.get(lc(e.values[0])); edges.push({ src: t, dst, type: k, entry: e, missing: !dst ? e.values[0] : null }); } }
    const initActive = (t) => lc(t.get('InitState')) === 'active';
    // problems
    const probs = [];
    for (const t of trig) {
      const n = t.get('nickname') || '(no nickname)';
      const cnds = t.entries.filter(e => isCnd(e.key));
      if (cnds.length !== 1) probs.push({ sev: 'warn', t, msg: `${n}: ${cnds.length} conditions (vanilla triggers always have exactly one Cnd_)` });
      if (!initActive(t) && !edges.some(e => e.dst === t && e.type === 'act_acttrig')) probs.push({ sev: 'info', t, msg: `${n}: never activated (not InitState = ACTIVE and no Act_ActTrig points to it)` });
      for (const e of t.entries) for (const p of commandProblems(e.key, e.values)) probs.push({ sev: p.sev, t, msg: `${n}: ${p.msg}` });
      for (const e of t.entries) {
        const spec = REFS[lc(e.key)]; if (!spec) continue;
        spec.forEach((want, i) => {
          const v = e.values[i]; if (!want || !v || ['player', 'no_params', 'no_ol', 'none'].includes(lc(v)) || /^-?\d+$/.test(v)) return;
          if (want === 'Trigger') { if (!byNick.has(lc(v))) probs.push({ sev: 'error', t, msg: `${n}: ${e.key} refers to unknown trigger “${v}”` }); return; }
          const ks = entKinds.get(lc(v));
          if (!ks) probs.push({ sev: 'error', t, msg: `${n}: ${e.key} refers to unknown ${want} “${v}”` });
          else if (!ks.has(want)) probs.push({ sev: 'warn', t, msg: `${n}: ${e.key} expects a ${want}, “${v}” is a ${[...ks].join('/')}` });
        });
      }
    }
    for (const s of ini.all('MsnShip')) { const npc = s.get('NPC'); if (npc && !(entKinds.get(lc(npc)) || new Set()).has('NPC')) probs.push({ sev: 'error', ent: s, msg: `MsnShip ${s.get('nickname')}: unknown NPC “${npc}”` }); }
    const dup = new Map(); for (const t of trig) { const k = lc(t.get('nickname')); dup.set(k, (dup.get(k) || 0) + 1); }
    for (const [k, n] of dup) if (n > 1) probs.push({ sev: 'error', t: byNick.get(k), msg: `trigger nickname “${k}” used ${n}×` });
    M = { trig, byNick, ents, entKinds, labels, edges, initActive, probs };
    layout();
  }
  function layout() {
    // layered layout by activation depth from the initially-active triggers (positions the user dragged are kept)
    const { trig, edges, initActive } = M;
    const depth = new Map(); const queue = [];
    for (const t of trig) if (initActive(t)) { depth.set(t, 0); queue.push(t); }
    while (queue.length) { const t = queue.shift(); for (const e of edges) if (e.src === t && e.dst && e.type === 'act_acttrig' && !depth.has(e.dst)) { depth.set(e.dst, depth.get(t) + 1); queue.push(e.dst); } }
    // columns by depth, wrapped into bands of BAND columns (long mission chains read like lines of text);
    // triggers never reached from the start go into a grid below
    const BAND = 7, cols = [];
    for (const t of trig) if (depth.has(t)) { const d = depth.get(t); (cols[d] = cols[d] || []).push(t); }
    M.auto = new Map(); let top = 0;
    for (let b = 0; b * BAND < cols.length; b++) {
      let hgt = 0;
      for (let c = 0; c < BAND; c++) { const list = cols[b * BAND + c] || []; list.forEach((t, i) => M.auto.set(t, { x: c * 250, y: top + i * 52 })); hgt = Math.max(hgt, list.length); }
      top += hgt * 52 + 70;
    }
    const rest = trig.filter(t => !depth.has(t));
    rest.forEach((t, i) => M.auto.set(t, { x: (i % BAND) * 250, y: top + 30 + Math.floor(i / BAND) * 52 }));
    M.restTop = rest.length ? top : null;
  }
  const P = (t) => pos[lc(t.get('nickname'))] || M.auto.get(t) || { x: 0, y: 0 };

  // ---------- layout
  const fileSel = h('select', { onchange: async (e) => { path = e.target.value; await open(); } }, ...files.map(f => h('option', { value: f, selected: f === path }, f.replace('DATA/MISSIONS/', ''))));
  const search = h('input', { placeholder: 'Find trigger / entity…', style: { width: '200px' }, oninput: (e) => { q = lc(e.target.value); const hit = q && M.trig.find(t => lc(t.get('nickname')).includes(q)); if (hit && view === 'graph') { sel = hit; center(hit); } draw(); renderList(); } });
  const tabs = h('div', { class: 'seg' });
  const center_ = h('div', { style: { position: 'relative', overflow: 'hidden', borderRadius: '6px', background: 'var(--well)' } });
  const side = h('div', { style: { overflow: 'auto', fontSize: '12px', paddingRight: '4px' } });
  const probsBox = h('div', { style: { maxHeight: '110px', overflow: 'auto', fontSize: '11px', marginTop: '6px' } });
  const body = h('div', {},
    h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '8px', flexWrap: 'wrap' } }, fileSel, tabs, search,
      h('span', { style: { flex: 1 } }),
      h('button', { class: 'btn', title: 'Show this mission\'s ships, objectives and areas in the 3D system view', onclick: () => { m.close ? m.close() : m.box.closest('.backdrop')?.remove(); import('./missionmap.js').then(mm => mm.missionMap(app, { path })); } }, '🗺 3D map'),
      h('button', { class: 'btn', onclick: () => newTrigger() }, '+ Trigger'),
      h('button', { class: 'btn', title: 'Show the whole graph', onclick: () => fit() }, 'Fit'),
      h('button', { class: 'btn', title: 'Forget dragged positions and lay the graph out again', onclick: () => { pos = {}; savePos(); fit(); } }, 'Auto layout')),
    h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 520px', gap: '10px', height: '64vh' } }, center_, side),
    probsBox);
  const m = modal({ title: 'Mission scripts', wide: true, body, onClose: () => { app._missionRefresh = null; ro.disconnect(); window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); }, buttons: [{ label: 'Close' }, { label: 'Save all (Ctrl+S)', cls: 'primary', onClick: () => { app.save(); return false; } }] });
  m.box.classList.add('xwide');
  const setTitle = () => { const t = m.box.querySelector('header h2'); if (t) t.textContent = `Mission scripts · ${path.replace('DATA/MISSIONS/', '')} · ${M.trig.length} triggers`; };

  // ---------- graph canvas
  const cv = h('canvas', { style: { width: '100%', height: '100%', display: 'block', cursor: 'grab' } });
  const legend = h('div', { style: { position: 'absolute', right: '8px', bottom: '6px', fontSize: '11px', color: 'var(--faint)', pointerEvents: 'none', textAlign: 'right' } },
    ...Object.values(EDGE).map(e => h('div', {}, h('span', { style: { color: e.col } }, e.dash ? '┄┄ ' : '── '), e.label)), h('div', {}, h('span', { style: { color: '#5fd38d' } }, '▌'), 'InitState = ACTIVE'));
  const listEl = h('div', { class: 'reflist', style: { position: 'absolute', inset: 0, overflow: 'auto', fontSize: '12px' } });
  let cam = { x: 40, y: 40, z: 1 };
  const NW = 190, NH = 38;
  const ro = new ResizeObserver(() => draw()); ro.observe(center_);
  function draw() {
    if (view !== 'graph' || !M) return;
    const r = center_.getBoundingClientRect(), dpr = devicePixelRatio || 1;
    cv.width = r.width * dpr; cv.height = r.height * dpr;
    const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, r.width, r.height);
    c.translate(cam.x, cam.y); c.scale(cam.z, cam.z);
    const focus = sel ? new Set([sel, ...M.edges.filter(e => e.src === sel || e.dst === sel).flatMap(e => [e.src, e.dst])]) : null;
    // edges
    for (const e of M.edges) {
      if (!e.dst) continue;
      const a = P(e.src), b = P(e.dst), on = !focus || e.src === sel || e.dst === sel;
      const st = EDGE[e.type];
      c.strokeStyle = st.col; c.globalAlpha = on ? 0.9 : 0.12; c.lineWidth = on && focus ? 2 : 1.2; c.setLineDash(st.dash ? [5, 4] : []);
      const x1 = a.x + NW, y1 = a.y + NH / 2, x2 = b.x, y2 = b.y + NH / 2;
      const self = e.src === e.dst;
      c.beginPath(); c.moveTo(x1, y1);
      if (self) c.bezierCurveTo(x1 + 40, y1 - 50, x2 - 40, y2 - 50, x2, y2);
      else { const dx = Math.max(40, Math.abs(x2 - x1) / 2); c.bezierCurveTo(x1 + dx, y1, x2 - dx, y2, x2, y2); }
      c.stroke();
      c.setLineDash([]); c.beginPath(); c.moveTo(x2, y2); c.lineTo(x2 - 7, y2 - 4); c.lineTo(x2 - 7, y2 + 4); c.fillStyle = st.col; c.fill();
    }
    c.globalAlpha = 1;
    if (M.restTop != null) { c.fillStyle = '#9a9a9a'; c.font = '13px system-ui, sans-serif'; c.fillText('Not reachable from the start (activated from other files, or unused):', 0, M.restTop + 14); }
    // nodes
    c.font = '12px system-ui, sans-serif';
    for (const t of M.trig) {
      const p = P(t), nick = t.get('nickname') || '?';
      const dim = (focus && !focus.has(t)) || (q && !lc(nick).includes(q));
      c.globalAlpha = dim ? 0.3 : 1;
      c.fillStyle = t === sel ? '#2c5d87' : '#3a3a3a'; c.strokeStyle = t === sel ? '#ffe066' : M.probs.some(x => x.t === t && x.sev === 'error') ? '#e86a6a' : '#3a4658';
      c.lineWidth = t === sel ? 2 : 1;
      c.beginPath(); c.roundRect(p.x, p.y, NW, NH, 5); c.fill(); c.stroke();
      if (M.initActive(t)) { c.fillStyle = '#5fd38d'; c.fillRect(p.x, p.y + 3, 3, NH - 6); }
      c.fillStyle = '#d6d6d6'; c.fillText(clip(c, nick, NW - 14), p.x + 8, p.y + 15);
      const cnd = t.entries.find(e => isCnd(e.key));
      c.fillStyle = '#9a9a9a'; c.font = '10px system-ui, sans-serif';
      c.fillText(clip(c, cnd ? `${cnd.key.slice(4)} ${cnd.value}` : 'no condition', NW - 14), p.x + 8, p.y + 30);
      if (lc(t.get('repeatable')) === 'true') { c.fillStyle = '#d6b35a'; c.fillText('↻', p.x + NW - 13, p.y + 14); }
      c.font = '12px system-ui, sans-serif';
    }
    c.globalAlpha = 1;
  }
  const clip = (c, s, w) => { if (c.measureText(s).width <= w) return s; while (s.length > 1 && c.measureText(s + '…').width > w) s = s.slice(0, -1); return s + '…'; };
  const hit = (mx, my) => { const x = (mx - cam.x) / cam.z, y = (my - cam.y) / cam.z; for (let i = M.trig.length - 1; i >= 0; i--) { const p = P(M.trig[i]); if (x >= p.x && x <= p.x + NW && y >= p.y && y <= p.y + NH) return M.trig[i]; } return null; };
  function center(t) { cam.z = Math.max(cam.z, 0.9); const r = center_.getBoundingClientRect(), p = P(t); cam.x = r.width / 2 - (p.x + NW / 2) * cam.z; cam.y = r.height / 2 - (p.y + NH / 2) * cam.z; }
  function fit() {
    const r = center_.getBoundingClientRect(); if (!M.trig.length || !r.width) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const t of M.trig) { const p = P(t); x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x + NW); y1 = Math.max(y1, p.y + NH); }
    cam.z = Math.max(0.15, Math.min(1.2, Math.min(r.width / (x1 - x0 + 80), r.height / (y1 - y0 + 80))));
    cam.x = 40 - x0 * cam.z; cam.y = 40 - y0 * cam.z; draw();
  }
  let drag = null;
  cv.onmousedown = (e) => {
    const r = cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top, t = hit(mx, my);
    if (t) { sel = t; const p = P(t); drag = { t, ox: (mx - cam.x) / cam.z - p.x, oy: (my - cam.y) / cam.z - p.y, moved: false }; renderSide(); }
    else drag = { pan: true, sx: mx - cam.x, sy: my - cam.y, moved: false };
    draw();
  };
  const onMove = (e) => {
    if (!drag) return; const r = cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top; drag.moved = true;
    if (drag.pan) { cam.x = mx - drag.sx; cam.y = my - drag.sy; }
    else pos[lc(drag.t.get('nickname'))] = { x: Math.round((mx - cam.x) / cam.z - drag.ox), y: Math.round((my - cam.y) / cam.z - drag.oy) };
    draw();
  };
  const onUp = () => { if (drag && !drag.pan && drag.moved) savePos(); if (drag && drag.pan && !drag.moved) { sel = null; renderSide(); draw(); } drag = null; };
  window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
  cv.onwheel = (e) => { e.preventDefault(); const r = cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top; const z = Math.max(0.1, Math.min(3, cam.z * Math.exp(-e.deltaY * 0.0015))); cam.x = mx - (mx - cam.x) * z / cam.z; cam.y = my - (my - cam.y) * z / cam.z; cam.z = z; draw(); };
  cv.ondblclick = (e) => { const r = cv.getBoundingClientRect(); const t = hit(e.clientX - r.left, e.clientY - r.top); if (t) { center(t); draw(); } };

  // ---------- center views
  function renderTabs() {
    tabs.innerHTML = '';
    const tab = (id, label) => h('button', { class: 'btn ' + (view === id ? 'primary' : ''), onclick: () => { view = id; if (view === 'graph' && !(sel && sel.is('Trigger'))) sel = null; renderAll(); } }, label);
    tabs.append(tab('graph', `Triggers (${M.trig.length})`), tab('ents', `Entities (${M.ents.size})`), tab('mission', '[Mission]'));
  }
  function renderCenter() {
    center_.innerHTML = '';
    if (view === 'graph') { center_.append(cv, legend); requestAnimationFrame(draw); }
    else { center_.append(listEl); renderList(); }
  }
  function renderList() {
    if (view === 'graph') return;
    listEl.innerHTML = '';
    if (view === 'mission') { const s = doc.ini.first('Mission'); if (s) { sel = s; renderSide(); } listEl.append(h('div', { class: 'empty', style: { padding: '12px' } }, 'The [Mission] header (title, offer, reward, NPC ship file) is shown on the right.')); return; }
    const kb = h('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap', padding: '6px', position: 'sticky', top: 0, background: 'var(--well)' } },
      ...KINDS.map(k => h('button', { class: 'btn ' + (k === kind ? 'primary' : ''), style: { padding: '1px 8px' }, onclick: () => { kind = k; renderList(); } }, `${k} ${doc.ini.all(k).length}`)),
      h('button', { class: 'btn', style: { padding: '1px 8px', marginLeft: 'auto' }, onclick: () => newEntity() }, `+ ${kind}`));
    listEl.append(kb);
    for (const s of doc.ini.all(kind)) {
      const n = s.get('nickname') || '(no nickname)'; if (q && !lc(n).includes(q)) continue;
      const users = usedBy(n).length;
      listEl.append(h('div', { class: sel === s ? 'sel' : '', style: { padding: '3px 8px', cursor: 'pointer' }, onclick: () => { sel = s; renderList(); renderSide(); } },
        n, h('span', { style: { float: 'right', color: users ? 'var(--faint)' : '#d6b35a', fontSize: '11px' } }, users ? `${users} trigger${users > 1 ? 's' : ''}` : 'unused')));
    }
  }
  const usedBy = (nick) => { const k = lc(nick); return M.trig.filter(t => t.entries.some(e => (isCnd(e.key) || isAct(e.key)) && e.values.some(v => lc(v) === k))); };
  const goto = (nick) => {
    const k = lc(nick); const t = M.byNick.get(k);
    if (t) { view = 'graph'; sel = t; renderAll(); requestAnimationFrame(() => { center(t); draw(); }); return; }
    const en = M.ents.get(k); if (en) { view = 'ents'; kind = en.kind; sel = en.sec; renderAll(); }
  };

  // ---------- side panel
  function chips(values) {
    const out = h('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '2px' } });
    for (const v of values) {
      const k = lc(v); const t = M.byNick.get(k), en = M.ents.get(k);
      if (t || en) out.append(h('a', { href: '#', class: 'chip', style: { fontSize: '10px', padding: '0 6px', borderRadius: '8px', background: t ? 'rgba(95,211,141,0.15)' : 'rgba(106,174,232,0.15)', color: t ? '#8fe0b0' : '#9cc8f0', textDecoration: 'none' }, onclick: (e) => { e.preventDefault(); goto(v); } }, `${t ? 'Trigger' : en.kind} › ${v}`));
      else if (M.labels.has(k)) out.append(h('span', { style: { fontSize: '10px', color: 'var(--faint)' } }, `label ${v}`));
    }
    return out.children.length ? out : null;
  }
  function entryRow(s, e, list) {
    const dl = isCnd(e.key) ? 'msn-cnd' : isAct(e.key) ? 'msn-act' : null;
    const move = (d) => edit(`Move ${e.key}`, () => {
      const L = s.lines, i = L.indexOf(e); let j = i + d;
      while (j >= 0 && j < L.length && L[j].type !== 'entry') j += d;
      if (j < 0 || j >= L.length || /^nickname$/i.test(L[j].key)) return;
      L[i] = L[j]; L[j] = e;
    });
    const slots = (isCnd(e.key) || isAct(e.key)) ? paramSlots(e.key) : null;
    const d = keyDoc('Trigger', e.key);
    const setValues = (vals) => { while (vals.length && (vals[vals.length - 1] == null || vals[vals.length - 1] === '')) vals.pop(); edit(`Edit ${e.key}`, () => { e.value = vals.map(v => v == null ? '' : v).join(', '); e.raw = null; }); };
    let valueEl;
    if (slots && !rawMode.has(e)) {
      const vals = e.values.slice();
      valueEl = h('div', { class: 'msnparams' }, ...slots.map(sl => {
        const cur = sl.rest ? vals.slice(sl.i).join(', ') : (vals[sl.i] ?? '');
        const inp = h('input', { value: cur, placeholder: sl.optional ? 'optional' : '', title: `${sl.label}${sl.type ? ' · ' + sl.type : ''}${sl.optional ? ' · optional' : ''}`,
          style: { width: sl.rest ? '160px' : /float|int/.test(sl.type) ? '70px' : '120px' },
          onchange: (ev) => { const v = vals.slice(); if (sl.rest) { v.length = sl.i; v.push(...ev.target.value.split(',').map(x => x.trim())); } else { while (v.length <= sl.i) v.push(''); v[sl.i] = ev.target.value.trim(); } setValues(v); } });
        return h('label', { class: sl.optional ? 'opt' : '' }, h('span', {}, sl.label), inp);
      }));
    } else valueEl = h('input', { value: e.value, style: { fontFamily: 'var(--mono)', fontSize: '11px' }, onchange: (ev) => edit(`Edit ${e.key}`, () => { e.value = ev.target.value; e.raw = null; }) });
    const probs = (isCnd(e.key) || isAct(e.key)) ? commandProblems(e.key, e.values) : [];
    const wide = slots && !rawMode.has(e);
    return h('div', { style: { margin: '4px 0 8px' } },
      h('div', { style: { display: 'grid', gridTemplateColumns: wide ? '1fr auto' : '170px 1fr auto', gap: '4px', alignItems: 'start' } },
        h('input', { value: e.key, list: dl, title: d ? `${d.meaning}\n\nSource: ${d.source}` : '', style: { fontFamily: 'var(--mono)', fontSize: '11px', color: isCnd(e.key) ? '#f0c674' : isAct(e.key) ? '#9cc8f0' : '' }, onchange: (ev) => { const k = ev.target.value.trim(); if (!k) return; edit(`Rename ${e.key}`, () => { e.key = k; e.raw = null; }); } }),
        wide ? null : valueEl,
        h('span', { style: { whiteSpace: 'nowrap' } },
          slots ? h('button', { class: 'btn', style: { padding: '0 5px' }, title: rawMode.has(e) ? 'Edit as fields' : 'Edit the raw line', onclick: () => { rawMode.has(e) ? rawMode.delete(e) : rawMode.add(e); renderSide(); } }, rawMode.has(e) ? '▤' : '✎') : null,
          h('button', { class: 'btn', style: { padding: '0 5px' }, title: 'Move up', onclick: () => move(-1) }, '↑'),
          h('button', { class: 'btn', style: { padding: '0 5px' }, title: 'Move down', onclick: () => move(1) }, '↓'),
          h('button', { class: 'btn', style: { padding: '0 5px' }, title: 'Remove', onclick: () => edit(`Remove ${e.key}`, () => s.removeEntry(e)) }, '×'))),
      wide ? h('div', { style: { margin: '3px 0 0 12px' } }, valueEl) : null,
      d ? h('div', { class: 'msnhelp' }, d.meaning.length > 220 ? d.meaning.slice(0, 220) + '…' : d.meaning) : null,
      ...probs.map(p => h('div', { class: 'sev-' + (p.sev === 'error' ? 'err' : p.sev), style: { fontSize: '11px' } }, p.msg)),
      chips(e.values));
  }
  const addEntry = (s, key, value) => edit(`Add ${key}`, () => { const ne = new IniEntry(key, value); s.lines.splice(s.lastEntryIndex() + 1, 0, ne); });
  function renderSide() {
    side.innerHTML = '';
    const docCmds = documentedKeys('Trigger'); const cmdList = (re, base) => [...new Set([...base, ...docCmds.filter(k => re.test(k))])].sort();
    side.append(h('datalist', { id: 'msn-cnd' }, ...cmdList(/^cnd_/i, CND).map(c => h('option', { value: c }))), h('datalist', { id: 'msn-act' }, ...cmdList(/^act_/i, ACT).map(c => h('option', { value: c }))));
    if (!sel || !doc.ini.sections.includes(sel)) { sel = null; side.append(h('div', { class: 'empty' }, view === 'graph' ? 'Click a trigger. Drag to move it, drag the background to pan, wheel to zoom, double-click to centre. Green bar = active when the mission starts.' : 'Select an entry.')); return; }
    const s = sel, nick = s.get('nickname');
    if (s.is('Trigger')) {
      side.append(h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
        h('h3', { style: { margin: 0, flex: 1 } }, nick),
        h('button', { class: 'btn', onclick: () => renameTrigger(s) }, 'Rename'),
        h('button', { class: 'btn', onclick: () => duplicate(s) }, 'Duplicate'),
        h('button', { class: 'btn danger', onclick: () => removeSection(s) }, 'Delete')));
      side.append(h('div', { style: { display: 'flex', gap: '14px', margin: '6px 0' } },
        h('label', {}, h('input', { type: 'checkbox', checked: M.initActive(s), onchange: (e) => edit('InitState', () => { if (e.target.checked) s.set('InitState', 'ACTIVE'); else s.remove('InitState'); }) }), ' active at start'),
        h('label', {}, h('input', { type: 'checkbox', checked: lc(s.get('repeatable')) === 'true', onchange: (e) => edit('repeatable', () => { if (e.target.checked) s.set('repeatable', 'true'); else s.remove('repeatable'); }) }), ' repeatable'),
        h('label', {}, 'system ', h('input', { value: s.get('system') || '', style: { width: '90px' }, onchange: (e) => edit('system', () => { if (e.target.value) s.set('system', e.target.value); else s.remove('system'); }) }))));
      const cnds = s.entries.filter(e => isCnd(e.key)), acts = s.entries.filter(e => isAct(e.key)), other = s.entries.filter(e => !isCnd(e.key) && !isAct(e.key) && !/^(nickname|system|initstate|repeatable)$/i.test(e.key));
      side.append(h('div', { class: 'psec' }, h('h3', {}, 'Condition'), ...cnds.map(e => entryRow(s, e)),
        cnds.length !== 1 ? h('div', { class: 'sev-warn', style: { fontSize: '11px' } }, 'Vanilla triggers have exactly one condition.') : null,
        !cnds.length ? h('button', { class: 'btn', onclick: () => addEntry(s, 'Cnd_True', 'no_params') }, '+ condition') : null));
      side.append(h('div', { class: 'psec' }, h('h3', {}, `Actions (${acts.length})`), ...acts.map(e => entryRow(s, e)),
        h('div', { style: { display: 'flex', gap: '4px', marginTop: '4px', flexWrap: 'wrap' } },
          h('button', { class: 'btn', onclick: () => addEntry(s, 'Act_ActTrig', '') }, '+ activate trigger'),
          h('button', { class: 'btn', onclick: () => addEntry(s, 'Act_DeactTrig', nick) }, '+ deactivate'),
          h('button', { class: 'btn', onclick: () => addEntry(s, 'Act_SpawnShip', '') }, '+ spawn ship'),
          h('button', { class: 'btn', onclick: () => addEntry(s, 'Act_SendComm', ', Player, ') }, '+ comm'),
          h('button', { class: 'btn', onclick: () => addEntry(s, 'Act_', '') }, '+ other…'))));
      if (other.length) side.append(h('div', { class: 'psec' }, h('h3', {}, 'Other keys'), ...other.map(e => entryRow(s, e))));
      const inc = M.edges.filter(e => e.dst === s && e.src !== s);
      side.append(h('div', { class: 'psec' }, h('h3', {}, 'Referenced by'), inc.length ? h('div', {}, ...inc.map(e => h('div', {}, h('span', { style: { color: EDGE[e.type].col } }, EDGE[e.type].label + ' '), h('a', { href: '#', style: { color: '#9cc8f0' }, onclick: (ev) => { ev.preventDefault(); goto(e.src.get('nickname')); } }, e.src.get('nickname'))))) : h('div', { class: 'empty' }, M.initActive(s) ? 'nothing — active at start' : 'nothing — this trigger is never activated')));
      return;
    }
    // generic section
    side.append(h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } }, h('h3', { style: { margin: 0, flex: 1 } }, `[${s.name}] ${nick || ''}`),
      s.is('NPC') && s.get('npc_ship_arch') ? h('button', { class: 'btn', title: 'Open the NPC ship (ship, loadout, pilot, level)', onclick: () => { const f = doc.ini.first('Mission') && doc.ini.first('Mission').get('npc_ship_file'); import('./npcships.js').then(mm => mm.npcShipEditor(app, { file: f ? 'DATA/' + f.replace(/\\/g, '/') : null, select: s.get('npc_ship_arch') })); } }, 'NPC ship…') : null,
      s.is('Mission') ? null : h('button', { class: 'btn', onclick: () => duplicate(s) }, 'Duplicate'),
      s.is('Mission') ? null : h('button', { class: 'btn danger', onclick: () => removeSection(s) }, 'Delete')));
    side.append(h('div', { class: 'psec' }, ...s.entries.map(e => entryRow(s, e)),
      h('button', { class: 'btn', style: { marginTop: '4px' }, onclick: async () => { const k = await promptDialog('Add key', 'Key name', ''); if (k) addEntry(s, k.trim(), ''); } }, '+ key')));
    if (nick) { const u = usedBy(nick); side.append(h('div', { class: 'psec' }, h('h3', {}, 'Used by triggers'), u.length ? h('div', {}, ...u.map(t => h('div', {}, h('a', { href: '#', style: { color: '#9cc8f0' }, onclick: (ev) => { ev.preventDefault(); goto(t.get('nickname')); } }, t.get('nickname'))))) : h('div', { class: 'empty' }, 'not referenced by any trigger'))); }
  }
  function renderProbs() {
    probsBox.innerHTML = '';
    const errs = M.probs.filter(p => p.sev === 'error').length, warns = M.probs.filter(p => p.sev === 'warn').length, infos = M.probs.length - errs - warns;
    probsBox.append(h('div', { style: { color: 'var(--faint)' } }, `Checks: ${errs} errors · ${warns} warnings · ${infos} notes`));
    for (const p of M.probs.sort((a, b) => ['error', 'warn', 'info'].indexOf(a.sev) - ['error', 'warn', 'info'].indexOf(b.sev)).slice(0, 200))
      probsBox.append(h('div', { class: 'sev-' + p.sev, style: { cursor: 'pointer' }, onclick: () => { if (p.t) goto(p.t.get('nickname')); else if (p.ent) goto(p.ent.get('nickname')); } }, p.msg));
  }

  // ---------- structural edits
  const unique = (base) => { let n = base, i = 2; while (M.byNick.has(lc(n)) || M.ents.has(lc(n))) n = `${base}_${i++}`; return n; };
  async function newTrigger() {
    const n = await promptDialog('New trigger', 'Nickname', unique('trig_new')); if (!n) return;
    if (M.byNick.has(lc(n))) { toast('That nickname exists'); return; }
    const s = new IniSection('Trigger'); s.lines.push(new IniEntry('nickname', n));
    const sys = sel && sel.is && sel.is('Trigger') ? sel.get('system') : (M.trig[0] && M.trig[0].get('system')); if (sys) s.lines.push(new IniEntry('system', sys));
    s.lines.push(new IniEntry('Cnd_True', 'no_params'), { type: 'other', raw: '' });
    edit(`New trigger ${n}`, () => { const after = sel && sel.is && sel.is('Trigger') ? sel : M.trig[M.trig.length - 1]; const i = after ? doc.ini.sections.indexOf(after) + 1 : doc.ini.sections.length; doc.ini.sections.splice(i, 0, s); });
    if (sel && sel.is && sel.is('Trigger')) { const p = P(sel); pos[lc(n)] = { x: p.x + 250, y: p.y }; savePos(); }
    view = 'graph'; sel = s; renderAll();
  }
  async function newEntity() {
    const n = await promptDialog(`New ${kind}`, 'Nickname', unique(lc(kind) + '_new')); if (!n) return;
    const s = new IniSection(kind); s.lines.push(new IniEntry('nickname', n), { type: 'other', raw: '' });
    const last = doc.ini.all(kind).pop();
    edit(`New ${kind} ${n}`, () => { const i = last ? doc.ini.sections.indexOf(last) + 1 : doc.ini.sections.length; doc.ini.sections.splice(i, 0, s); });
    sel = s; renderAll();
  }
  async function duplicate(s) {
    const n = await promptDialog('Duplicate', 'Nickname of the copy', unique(s.get('nickname') + '_copy')); if (!n) return;
    const c = s.clone(); c.lines.forEach(l => { if (l.type === 'entry' && l.key.toLowerCase() === 'nickname') { l.value = n; l.raw = null; } });
    edit(`Duplicate ${s.get('nickname')}`, () => doc.ini.sections.splice(doc.ini.sections.indexOf(s) + 1, 0, c));
    if (s.is('Trigger')) { const p = P(s); pos[lc(n)] = { x: p.x, y: p.y + NH + 14 }; savePos(); }
    sel = c; renderAll();
  }
  async function removeSection(s) {
    const n = s.get('nickname'); const u = n ? usedBy(n).filter(t => t !== s) : [];
    if (!(await confirmDialog(`Delete ${n}?`, u.length ? `Still referenced by ${u.length} trigger(s): ${u.slice(0, 6).map(t => t.get('nickname')).join(', ')}${u.length > 6 ? '…' : ''}` : 'Not referenced anywhere.', 'Delete', true))) return;
    edit(`Delete ${n}`, () => { doc.ini.sections = doc.ini.sections.filter(x => x !== s); });
    sel = null; renderAll();
  }
  async function renameTrigger(s) {
    const old = s.get('nickname'); const n = await promptDialog('Rename trigger', 'New nickname (references in this file are updated)', old); if (!n || n === old) return;
    if (M.byNick.has(lc(n))) { toast('That nickname exists'); return; }
    edit(`Rename ${old} → ${n}`, () => {
      s.set('nickname', n);
      for (const t of doc.ini.all('Trigger')) for (const e of t.entries) if (EDGE[lc(e.key)] && lc(e.values[0]) === lc(old)) { const v = e.values; v[0] = n; e.value = v.join(', '); e.raw = null; }
    });
    if (pos[lc(old)]) { pos[lc(n)] = pos[lc(old)]; delete pos[lc(old)]; savePos(); }
  }

  function renderAll() { renderTabs(); renderCenter(); renderSide(); renderProbs(); setTitle(); }
  function refresh() {
    if (sel && !doc.ini.sections.includes(sel)) { const k = sel.name, n = lc(sel.get('nickname')); sel = doc.ini.sections.find(x => x.is(k) && lc(x.get('nickname')) === n) || null; }
    model(); renderAll();
  }
  async function open() {
    doc = await app.otherDoc(path); if (!doc) { toast('Cannot read ' + path); return; }
    loadPos(); sel = null; view = 'graph'; model(); cam = { x: 30, y: 30, z: 0.85 }; renderAll();
  }
  app._missionRefresh = () => { if (doc) refresh(); };
  await open();
}
