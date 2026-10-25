// Mission creation wizard (Tools menu, "New mission…" in the mission script editor).
// Freelancer starts scripted missions only from the fixed story list in Content.dll (Mission_01a … Mission_13,
// Missions\Mxx\mxx.ini), so a new mission is installed in one of two ways:
//   • side job: its triggers are appended to a story mission's INI and start when the player docks at the start
//     base and launches again — it runs while that story mission is the active one. It never changes the story
//     mission's state (no Act_ChangeState), it pays a reward and updates the objective text.
//   • replace a story slot: the slot's INI becomes this mission alone (new game → land at the start base with the
//     chosen ship), for mods that start their own campaign. The original is backed up on save; take a snapshot.
// Templates: destroy (fly to a spot, a hostile group appears, destroy it), escort (a friendly ship flies from the
// start base to a destination base; optional ambush half way; fails if it dies), patrol (three waypoints, ambush at
// the second), courier (dock at a destination base). Positions are placed near a chosen object; fine-tune them in
// the Mission map (3D) afterwards. Everything goes through the shared undo history.
import * as THREE from 'three';
import { h, modal, toast } from './dom.js';
import { dataPath } from '../api.js';
import { getPos } from '../system.js';
import { missionFiles } from './missionedit.js';

const lc = (s) => String(s || '').toLowerCase();
const TYPES = { destroy: 'Destroy a hostile group', escort: 'Escort a ship to a base', patrol: 'Patrol three waypoints', courier: 'Courier: fly to a base and dock' };
// level range in an NPC ship nickname: vanilla "…_d4-19", Discovery "…_d1_d4_mission_t1"
const levelRange = (nick) => { const m = /_d(\d+)(?:-|_d)?(\d+)?(?:_|$)/i.exec(nick); return m ? [+m[1], +(m[2] || m[1])] : null; };
const fmt = (p) => p.map(v => Math.round(v)).join(', ');

export async function missionWizard(app) {
  const g = app.game;
  const fp = await app.otherDoc(dataPath('missions\\faction_prop.ini'));
  const gnpc = await app.otherDoc(dataPath('missions\\npcships.ini'));
  const factions = fp ? fp.ini.all('FactionProps').filter(s => s.getAll('npc_ship').length).map(s => s.get('affiliation')) : [];
  const archs = new Map(); if (gnpc) for (const s of gnpc.ini.all('NPCShipArch')) archs.set(lc(s.get('nickname')), s);
  const files = await missionFiles();
  const slots = files.filter(f => /\/m\d+[ab]?\.ini$/i.test(f));

  // ---- inputs
  const typeSel = h('select', {}, Object.entries(TYPES).map(([k, v]) => h('option', { value: k }, v)));
  const title = h('input', { value: 'Clear the pirate nest', style: { width: '100%' } });
  const baseSel = h('select', { style: { width: '100%' } }, g.bases.filter(b => b.system).map(b => h('option', { value: b.nickname, selected: lc(b.nickname) === 'li01_01_base' }, `${g.name(b.strid) || b.nickname} · ${b.system}`)));
  const objSel = h('select', { style: { width: '100%' } }), destSel = h('select', { style: { width: '100%' } });
  const dist = h('input', { type: 'number', value: 6, step: 1, style: { width: '70px' } });
  const facLabel = (f) => `${g.factionName(f) || f} · ${f}`;
  const facSel = h('select', { style: { width: '100%' } }, factions.map(f => h('option', { value: f, selected: f === 'fc_lr_grp' }, facLabel(f))));
  const friendSel = h('select', { style: { width: '100%' } }, factions.map(f => h('option', { value: f, selected: f === 'li_p_grp' }, facLabel(f))));
  const count = h('input', { type: 'number', value: 3, min: 1, max: 8, style: { width: '60px' } });
  const level = h('input', { type: 'number', value: 3, min: 1, max: 19, style: { width: '60px' } });
  const ambush = h('input', { type: 'checkbox', checked: true });
  const reward = h('input', { type: 'number', value: 5000, step: 500, style: { width: '100px' } });
  const modeSel = h('select', {}, h('option', { value: 'side' }, 'side job in a story mission'), h('option', { value: 'replace' }, 'replace a story mission slot'));
  const hostSel = h('select', { style: { width: '100%' } }, files.map(f => h('option', { value: f, selected: /m13\.ini$/i.test(f) }, f.replace('DATA/MISSIONS/', ''))));
  const shipIn = h('input', { value: 'ge_fighter', style: { width: '140px' } }), loadoutIn = h('input', { value: 'msn_playerloadout', style: { width: '160px' } }), cash = h('input', { type: 'number', value: 2000, style: { width: '100px' } });
  const texts = { go: h('input', { style: { width: '100%' } }), act: h('input', { style: { width: '100%' } }), done: h('input', { style: { width: '100%' } }), fail: h('input', { style: { width: '100%' } }) };
  const preview = h('canvas', { width: 360, height: 360, style: { width: '100%', background: 'var(--well)', borderRadius: '6px' } });
  const summary = h('div', { style: { fontSize: '12px', color: 'var(--dim)', marginTop: '6px' } });
  const rowsFor = {};
  let sysDoc = null, seed = 7;

  const baseObj = (doc, base) => doc && (doc.objects.find(o => lc(o.get('dock_with')) === lc(base)) || doc.objects.find(o => lc(o.get('base')) === lc(base)));
  async function loadSystem() {
    const b = g.findBase(baseSel.value); sysDoc = b ? await app.loadSystemDoc(b.system) : null;
    objSel.innerHTML = ''; destSel.innerHTML = '';
    if (!sysDoc) return draw();
    const named = sysDoc.objects.filter(o => o.get('ids_name') && !/trade_lane_ring|dock_ring|docking_fixture/i.test(o.get('archetype') || ''));
    objSel.append(...named.map(o => h('option', { value: o.get('nickname') }, `${g.name(o.get('ids_name')) || o.get('nickname')} · ${o.get('archetype')}`)));
    const near = sysDoc.objects.find(o => /field|wreck|jump|hole/i.test(o.get('archetype') || '') && o.get('ids_name')); if (near) objSel.value = near.get('nickname');
    const bases = g.bases.filter(x => lc(x.system) === lc(sysDoc.nickname) && lc(x.nickname) !== lc(baseSel.value) && baseObj(sysDoc, x.nickname)); // only bases you can dock at in space
    destSel.append(...bases.map(x => h('option', { value: x.nickname }, `${g.name(x.strid) || x.nickname}`)));
    autoTexts(); draw();
  }
  function autoTexts() {
    const t = typeSel.value, obj = sysDoc && sysDoc.byNick(objSel.value), on = obj ? (g.name(obj.get('ids_name')) || objSel.value) : 'the target', db = g.findBase(destSel.value), dn = db ? (g.name(db.strid) || db.nickname) : 'the destination';
    const v = {
      destroy: [`Fly to the marked position near ${on}.`, `Destroy the hostile ships.`, `The hostiles are destroyed. Payment transferred.`, ''],
      escort: [`Escort the transport to ${dn}.`, `Protect the transport until it reaches ${dn}.`, `The transport arrived safely. Payment transferred.`, `The transport was destroyed. The job is lost.`],
      patrol: [`Fly the patrol route near ${on}: waypoint 1.`, `Continue the patrol: next waypoint.`, `Patrol complete. Payment transferred.`, ''],
      courier: [`Deliver the package to ${dn}.`, `Dock at ${dn}.`, `Package delivered. Payment transferred.`, ''],
    }[t];
    texts.go.value = v[0]; texts.act.value = v[1]; texts.done.value = v[2]; texts.fail.value = v[3];
    const tt = { destroy: 'Clear the pirate nest', escort: 'Convoy escort', patrol: 'Patrol duty', courier: 'Urgent delivery' }[t]; if (Object.values({ a: 'Clear the pirate nest', b: 'Convoy escort', c: 'Patrol duty', d: 'Urgent delivery' }).includes(title.value)) title.value = tt;
    for (const [k, r] of Object.entries(rowsFor)) r.forEach(el => el && (el.style.display = r.types.includes(t) ? '' : 'none'));
  }
  // ---- geometry
  function plan() {
    if (!sysDoc) return null;
    const t = typeSel.value, start = baseObj(sysDoc, baseSel.value), sp = start ? new THREE.Vector3(...getPos(start)) : new THREE.Vector3();
    const obj = sysDoc.byNick(objSel.value), op = obj ? new THREE.Vector3(...getPos(obj)) : sp.clone();
    let s = seed; const R = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    const away = (p, d) => { const a = R() * Math.PI * 2; return p.clone().add(new THREE.Vector3(Math.cos(a) * d, 0, Math.sin(a) * d)); };
    const D = (+dist.value || 6) * 1000;
    const db = g.findBase(destSel.value), dobj = db && baseObj(sysDoc, db.nickname), dp = dobj ? new THREE.Vector3(...getPos(dobj)) : null;
    const P = { start, sp, target: null, wps: [], escortStart: null, dest: dobj, dp, ambushAt: null };
    if (t === 'destroy') P.target = away(op, D);
    if (t === 'patrol') { const c = op; for (let i = 0; i < 3; i++) { const a = (i / 3) * Math.PI * 2 + R(); P.wps.push(c.clone().add(new THREE.Vector3(Math.cos(a) * D, 0, Math.sin(a) * D))); } P.ambushAt = P.wps[1]; }
    if (t === 'escort' && dp) { const dir = dp.clone().sub(sp).normalize(); P.escortStart = sp.clone().addScaledVector(dir, 2500); P.ambushAt = sp.clone().lerp(dp, 0.5).add(new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(2500)); }
    return P;
  }
  function draw() {
    const c = preview.getContext('2d'), W = preview.width; c.clearRect(0, 0, W, W);
    const P = plan(); if (!P) return;
    const pts = sysDoc.objects.map(o => getPos(o)); const ext = Math.max(20000, ...pts.map(p => Math.max(Math.abs(p[0]), Math.abs(p[2]))));
    const S = (W / 2 - 10) / ext, C = (p) => [W / 2 + p.x * S, W / 2 + p.z * S], C3 = (a) => [W / 2 + a[0] * S, W / 2 + a[2] * S];
    c.fillStyle = '#3a4660'; for (const p of pts) { const [x, y] = C3(p); c.fillRect(x - 1, y - 1, 2, 2); }
    const mark = (p, col, label, r = 4) => { if (!p) return; const [x, y] = C(p); c.fillStyle = col; c.beginPath(); c.arc(x, y, r, 0, 7); c.fill(); c.font = '10px sans-serif'; c.fillText(label, x + 6, y + 3); };
    mark(P.sp, '#c080ff', 'start', 5);
    if (P.target) mark(P.target, '#ff7a59', 'hostiles');
    P.wps.forEach((w, i) => mark(w, '#4fd1ff', 'WP' + (i + 1)));
    if (P.wps.length) { c.strokeStyle = '#4fd1ff'; c.setLineDash([4, 4]); c.beginPath(); P.wps.forEach((w, i) => { const [x, y] = C(w); i ? c.lineTo(x, y) : c.moveTo(x, y); }); c.closePath(); c.stroke(); c.setLineDash([]); }
    if (P.dp) mark(P.dp, '#7ee787', 'destination', 5);
    if (P.escortStart && P.dp) { c.strokeStyle = '#7ee787'; c.beginPath(); c.moveTo(...C(P.escortStart)); c.lineTo(...C(P.dp)); c.stroke(); }
    if (ambush.checked && P.ambushAt && typeSel.value !== 'destroy' && typeSel.value !== 'courier') mark(P.ambushAt, '#ff7a59', 'ambush');
    const arch = pickArch(facSel.value, +level.value);
    summary.textContent = `${TYPES[typeSel.value]} in ${sysDoc.nickname}, starting when the player launches from ${g.name((g.findBase(baseSel.value) || {}).strid) || baseSel.value}. ${['destroy', 'patrol', 'escort'].includes(typeSel.value) ? `Hostiles: ${count.value} × ${arch || '(no ship for this faction/level)'}. ` : ''}Reward ${(+reward.value).toLocaleString()} credits. Installed as ${modeSel.value === 'side' ? 'a side job in ' + hostSel.value.split('/').pop() : 'the mission of slot ' + hostSel.value.split('/').pop()}.`;
  }
  function pickArch(fac, lvl, wantTransport = false) {
    const f = fp && fp.ini.all('FactionProps').find(s => lc(s.get('affiliation')) === lc(fac)); if (!f) return null;
    // random-mission ships (nickname ends in _dN or _dN-M); story/set-scene ships only as a last resort
    const all = f.getAll('npc_ship').filter(n => archs.has(lc(n))), special = (n) => /^(msn|setscene)|fauxplayer/i.test(n);
    const list = [...all.filter(n => !special(n) && levelRange(n)), ...all.filter(n => !special(n) && !levelRange(n)), ...all.filter(special)];
    const fit = (n) => { const r = levelRange(n); return !r || (lvl >= r[0] && lvl <= r[1]); };
    const isT = (n) => /freighter|transport|train|liner|armored/i.test((archs.get(lc(n)) || { get: () => '' }).get('ship_archetype') || n);
    const pool = list.filter(n => wantTransport ? isT(n) : !isT(n));
    return pool.find(fit) || pool[0] || list.find(fit) || list[0] || null;
  }

  // ---- create
  async function create() {
    const P = plan(); if (!P || !P.start) { toast('The start base has no docking object in its system'); return false; }
    const t = typeSel.value; if ((t === 'escort' || t === 'courier') && !P.dest) { toast('Choose a destination base in the same system'); return false; }
    const host = await app.otherDoc(dataPath(hostSel.value.replace(/^DATA\//i, ''))); if (!host) { toast('Cannot read ' + hostSel.value); return false; }
    const npcFileRel = (host.ini.first('Mission') || { get: () => null }).get('npc_ship_file') || hostSel.value.replace(/^DATA\//i, '').replace(/[^/\\]+$/, 'npcships.ini');
    const npcDoc = await app.otherDoc(dataPath(npcFileRel.replace(/\//g, '\\')));
    const enemyArch = pickArch(facSel.value, +level.value), friendArch = pickArch(friendSel.value, +level.value, true);
    if (['destroy', 'patrol'].includes(t) || (t === 'escort' && ambush.checked)) { if (!enemyArch) { toast('No NPC ship for that faction'); return false; } }
    const used = new Set(host.ini.sections.map(s => lc(s.get('nickname'))));
    let P0 = 'fled_' + lc(title.value).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 20); let k = 1; while ([...used].some(n => n && n.startsWith(P0 + '_'))) P0 = P0.replace(/\d*$/, '') + (++k);
    const N = (s) => `${P0}_${s}`, sys = sysDoc.nickname, startBase = baseSel.value, db = g.findBase(destSel.value);
    // strings (own undo steps, before the mission edit)
    const ids = {}; for (const [k2, el] of Object.entries(texts)) if (el.value.trim()) ids[k2] = app.newText('string', el.value.trim());
    const titleId = app.newText('string', title.value.trim() || 'New mission');
    const fpSec = (fac) => fp.ini.all('FactionProps').find(s => lc(s.get('affiliation')) === lc(fac));
    const voice = (fac) => (fpSec(fac)?.getAll('voice') || [])[0], costume = (fac) => (fpSec(fac)?.getAll('space_costume') || [])[0];
    const sec = (name, entries) => [name, entries.filter(e => e[1] != null && e[1] !== '')];
    const S = [];
    // entities
    const npc = (nick, fac, arch) => S.push(sec('NPC', [['nickname', nick], ['affiliation', fac], ['npc_ship_arch', arch], ['voice', voice(fac)], ['space_costume', costume(fac)], ['individual_name', 1]]));
    const hostiles = (n, at) => { const out = []; for (let i = 0; i < n; i++) { const p = at.clone().add(new THREE.Vector3((i % 3 - 1) * 120, 0, Math.floor(i / 3) * 120)); S.push(sec('MsnShip', [['nickname', N('hostile_' + (i + 1))], ['NPC', N('npc_hostile')], ['label', N('hostiles')], ['random_name', 'true'], ['position', fmt(p.toArray())]])); out.push(N('hostile_' + (i + 1))); } return out; };
    const nav = (nick, textId, p) => S.push(sec('NNObjective', [['nickname', nick], ['state', 'HIDDEN'], ['type', p ? `navmarker, ${sys}, ${textId}, ${textId}, ${fmt(p.toArray())}` : `ids, ${textId}`]]));
    const trig = (nick, active, entries) => S.push(sec('Trigger', [['nickname', nick], ...(active ? [['InitState', 'ACTIVE']] : []), ['system', sys], ...entries]));
    const n = Math.max(1, Math.min(8, +count.value || 3));
    let hostileNames = [];
    if (['destroy', 'patrol'].includes(t) || (t === 'escort' && ambush.checked)) npc(N('npc_hostile'), facSel.value, enemyArch);
    if (t === 'destroy') hostileNames = hostiles(n, P.target);
    if ((t === 'patrol' || t === 'escort') && ambush.checked) hostileNames = hostiles(n, P.ambushAt);
    if (t === 'escort') { npc(N('npc_escort'), friendSel.value, friendArch || enemyArch); S.push(sec('MsnShip', [['nickname', N('escort')], ['NPC', N('npc_escort')], ['label', N('escort')], ['random_name', 'true'], ['position', fmt(P.escortStart.toArray())]])); S.push(sec('ObjList', [['system', sys], ['nickname', N('ol_escort')], ['Dock', P.dest.get('nickname')]])); }
    // objectives
    const go = ids.go || titleId, act = ids.act || go, done = ids.done || titleId, fail = ids.fail || titleId;
    if (t === 'destroy') { nav(N('obj_go'), go, P.target); nav(N('obj_kill'), act, null); }
    if (t === 'patrol') P.wps.forEach((w, i) => nav(N('obj_wp' + (i + 1)), i ? act : go, w));
    if (t === 'escort') nav(N('obj_escort'), go, P.dp);
    if (t === 'courier') S.push(sec('NNObjective', [['nickname', N('obj_dock')], ['state', 'HIDDEN'], ['type', `rep_inst, ${sys}, ${go}, ${act}, ${fmt(P.dp.toArray())}, ${P.dest.get('nickname')}`]]));
    nav(N('obj_done'), done, null); if (t === 'escort') nav(N('obj_fail'), fail, null);
    // triggers: docked at the start base → next launch starts the job
    const finish = [['Act_AdjAcct', +reward.value || 0], ['Act_SetNNObj', `${N('obj_done')}, OBJECTIVE_HISTORY`], ['Act_NNIds', `${done}, HISTORY`]];
    trig(N('docked'), true, [['Cnd_BaseEnter', startBase], ['Act_ActTrig', N('launch')]]);
    const launch = [['Cnd_LaunchComplete', 'Player'], ['Act_NNIds', `${titleId}, HISTORY`]];
    if (t === 'destroy') { trig(N('launch'), false, [...launch, ['Act_SetNNObj', `${N('obj_go')}, OBJECTIVE_HISTORY`], ['Act_ActTrig', N('arrive')]]); trig(N('arrive'), false, [['Cnd_DistVec', `inside, Player, ${fmt(P.target.toArray())}, 4000`], ...hostileNames.map(h2 => ['Act_SpawnShip', `${h2}, no_ol`]), ...hostileNames.map(h2 => ['Act_MarkObj', `${h2}, 1`]), ['Act_SetNNObj', `${N('obj_kill')}, OBJECTIVE_HISTORY`], ['Act_ActTrig', N('cleared')]]); trig(N('cleared'), false, [['Cnd_Destroyed', `${N('hostiles')}, -1`], ...finish]); }
    if (t === 'patrol') {
      trig(N('launch'), false, [...launch, ['Act_SetNNObj', `${N('obj_wp1')}, OBJECTIVE_HISTORY`], ['Act_ActTrig', N('wp1')]]);
      P.wps.forEach((w, i) => { const last = i === P.wps.length - 1; const acts = last ? finish : [['Act_SetNNObj', `${N('obj_wp' + (i + 2))}, OBJECTIVE_HISTORY`], ['Act_ActTrig', N('wp' + (i + 2))]]; if (i === 1 && hostileNames.length) acts.unshift(...hostileNames.map(h2 => ['Act_SpawnShip', `${h2}, no_ol`]), ...hostileNames.map(h2 => ['Act_MarkObj', `${h2}, 1`])); trig(N('wp' + (i + 1)), false, [['Cnd_DistVec', `inside, Player, ${fmt(w.toArray())}, 1500`], ...acts]); });
    }
    if (t === 'escort') {
      trig(N('launch'), false, [...launch, ['Act_SpawnShip', `${N('escort')}, ${N('ol_escort')}`], ['Act_MarkObj', `${N('escort')}, 1`], ['Act_SetNNObj', `${N('obj_escort')}, OBJECTIVE_HISTORY`], ['Act_ActTrig', N('arrived')], ['Act_ActTrig', N('lost')], ...(hostileNames.length ? [['Act_ActTrig', N('ambush')]] : [])]);
      trig(N('arrived'), false, [['Cnd_DistVec', `inside, ${N('escort')}, ${fmt(P.dp.toArray())}, 2500`], ['Act_DeactTrig', N('lost')], ...finish]);
      trig(N('lost'), false, [['Cnd_Destroyed', `${N('escort')}, 1`], ['Act_DeactTrig', N('arrived')], ['Act_SetNNObj', `${N('obj_fail')}, OBJECTIVE_HISTORY`], ['Act_NNIds', `${fail}, HISTORY`]]);
      if (hostileNames.length) trig(N('ambush'), false, [['Cnd_DistVec', `inside, ${N('escort')}, ${fmt(P.ambushAt.toArray())}, 4000`], ...hostileNames.map(h2 => ['Act_SpawnShip', `${h2}, no_ol`]), ...hostileNames.map(h2 => ['Act_MarkObj', `${h2}, 1`])]);
    }
    if (t === 'courier') { trig(N('launch'), false, [...launch, ['Act_SetNNObj', `${N('obj_dock')}, OBJECTIVE_HISTORY`], ['Act_ActTrig', N('delivered')]]); trig(N('delivered'), false, [['Cnd_BaseEnter', db.nickname], ...finish]); }
    // NPC ship archetypes the mission's npc_ship_file does not have yet
    const needArch = [...new Set([enemyArch, friendArch].filter(Boolean))].filter(a => npcDoc && !npcDoc.ini.all('NPCShipArch').some(s => lc(s.get('nickname')) === lc(a)));
    const docs = [host, ...(npcDoc && needArch.length ? [npcDoc] : [])];
    const replace = modeSel.value === 'replace';
    app.history.do(`${replace ? 'Mission (replaces slot)' : 'Side job'}: ${title.value}`, docs, () => {
      if (replace) {
        const keepNpcFile = npcFileRel;
        host.ini.sections.length = 0;
        host.ini.addSection('Mission', null, [['mission_title', titleId], ['mission_offer', titleId], ['reward', +reward.value || 0], ['npc_ship_file', keepNpcFile]]);
        // new game: land at the start base with the chosen ship and money
        host.ini.addSection('Trigger', null, [['nickname', N('newgame')], ['InitState', 'ACTIVE'], ['system', sys], ['Cnd_True', 'no_params'], ['Act_ForceLand', startBase], ['Act_SetShipAndLoadout', `${shipIn.value.trim()}, ${loadoutIn.value.trim()}`], ['Act_AdjAcct', +cash.value || 0]]);
      }
      let after = host.ini.sections[host.ini.sections.length - 1] || null;
      for (const [name, entries] of S) after = host.ini.addSection(name, after, entries);
      for (const a of needArch) { const src = archs.get(lc(a)); if (src) npcDoc.ini.addSection('NPCShipArch', npcDoc.ini.sections[npcDoc.ini.sections.length - 1] || null, src.entries.map(e => [e.key, e.value])); }
    });
    toast(`${title.value}: ${S.length} sections added to ${hostSel.value.split('/').pop()} — Ctrl+S to save. Fine-tune positions in Tools → Mission map.`, 7000);
    import('./missionmap.js').then(m => m.missionMap(app, { path: hostSel.value }));
    return true;
  }

  const row = (label, el, help, types) => { const els = [h('label', {}, label), el, help ? h('div', { class: 'help' }, help) : null]; if (types) { const r = els.slice(); r.types = types; rowsFor[label] = r; } return els; };
  [typeSel, objSel, destSel].forEach(x => x.addEventListener('change', () => { autoTexts(); draw(); }));
  [dist, count, level, facSel, ambush, modeSel, hostSel, reward].forEach(x => x.addEventListener('change', draw));
  baseSel.onchange = loadSystem;
  modeSel.addEventListener('change', () => { for (const el of replRows) if (el) el.style.display = modeSel.value === 'replace' ? '' : 'none'; hostSel.innerHTML = ''; hostSel.append(...(modeSel.value === 'replace' ? slots : files).map(f => h('option', { value: f, selected: /m13\.ini$/i.test(f) }, f.replace('DATA/MISSIONS/', '')))); draw(); });
  const replRows = [...row('Player ship', h('div', { class: 'btnrow' }, shipIn, loadoutIn), 'Ship and loadout the new game starts with'), ...row('Starting credits', cash)];
  modal({ title: 'New mission wizard', wide: true, body: h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 380px', gap: '14px' } },
    h('div', { class: 'form' },
      ...row('Mission type', typeSel), ...row('Title', title, 'Shown in the mission log'),
      ...row('Start base', baseSel, 'The job starts when the player has docked here and launches'),
      ...row('Near object', h('div', { class: 'btnrow' }, objSel, dist, 'km', h('button', { class: 'btn sm', onclick: () => { seed = (seed * 48271) % 2147483647; draw(); } }, '🎲')), 'Where the hostiles / waypoints are placed', ['destroy', 'patrol']),
      ...row('Destination base', destSel, 'Same system as the start base', ['escort', 'courier']),
      ...row('Hostile faction', facSel, null, ['destroy', 'patrol', 'escort']),
      ...row('Hostiles', h('div', { class: 'btnrow' }, count, 'ships, level', level), 'Ships come from the faction\'s random-mission ships (faction_prop.ini) for that level', ['destroy', 'patrol', 'escort']),
      ...row('Ambush', ambush, 'Escort: half way · Patrol: at waypoint 2', ['escort', 'patrol']),
      ...row('Escorted ship', friendSel, 'A transport of this faction when it has one', ['escort']),
      ...row('Reward', reward),
      ...row('Text: start', texts.go), ...row('Text: active', texts.act), ...row('Text: success', texts.done), ...row('Text: failure', texts.fail, null, ['escort']),
      ...row('Install as', modeSel, 'Freelancer only runs the 14 story missions listed in Content.dll. A side job runs while that story mission is active; replacing a slot makes this the whole mission (e.g. a new game)'),
      ...row('Mission file', hostSel), ...replRows),
    h('div', {}, preview, summary)),
    buttons: [{ label: 'Cancel' }, { label: 'Create mission', cls: 'primary', onClick: create }] }).box.classList.add('xwide');
  for (const el of replRows) if (el) el.style.display = 'none';
  await loadSystem();
}
