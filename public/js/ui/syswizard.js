// New system wizard (Create menu): a complete, playable star system in one step — universe entry and name,
// look (music, background, dust, ambient) and sun copied from a template system, planets with death zones,
// a dockable station with a base cloned from a template base (rooms, bar, markets), jump gates/holes to
// chosen systems (both ends), trade lanes from the station to each gate, patrol paths with the template's
// encounters, and the shortest-path files extended with routes to and from the new system.
// Everything goes through the normal history (several undo steps) and is written with Ctrl+S.
import * as THREE from 'three';
import { h, modal, toast, overlay } from './dom.js';
import { dataPath } from '../api.js';
import { fmtNum } from '../formats/ini.js';
import { createSystem, doCreateBase } from './dialogs.js';
import { laneRotation } from './panels.js';
import { createPath, collectPaths } from '../paths.js';

const lc = (s) => String(s || '').toLowerCase();
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
const archRadius = (a) => a ? (a.radius || parseFloat((String(a.nickname).match(/_(\d{3,5})$/) || [])[1] || '0') || 0) : 0;

// ---------------------------------------------------------------- shortest paths
// Freelancer's systems_shortest_path / shortest_legal_path / shortest_illegal_path.ini: one
// [SystemConnections] per source system with "Path = From, To, From, …, To" for every reachable system.
// Existing lines are kept as they are; routes to and from the new system are added (fewest jumps;
// legal = jump gates only, the other two = gates and holes).
export function connectionGraph(app, docs, legalOnly) {
  const g = app.game, adj = new Map();
  for (const d of docs) {
    const from = lc(d.nickname);
    if (!adj.has(from)) adj.set(from, new Set());
    for (const o of d.objects) {
      const go = o.vals('goto'); if (!go || !go[0]) continue;
      const a = g.arch(o.get('archetype')); const type = a ? a.type : '';
      if (legalOnly && type !== 'JUMP_GATE') continue;
      // any other object with goto (story airlocks, core entrances) connects systems too, but is not a legal route
      adj.get(from).add(lc(go[0]));
    }
  }
  return adj;
}
export function bfsPath(adj, from, to) {
  if (from === to) return [from];
  const prev = new Map([[from, null]]), q = [from];
  while (q.length) {
    const c = q.shift();
    for (const n of [...(adj.get(c) || [])].sort()) {
      if (prev.has(n)) continue; prev.set(n, c);
      if (n === to) { const p = [to]; let k = c; while (k) { p.unshift(k); k = prev.get(k); } return p; }
      q.push(n);
    }
  }
  return null;
}
// travel-time routes (default): Dijkstra over the trade planner's graph — free flight at cruise speed,
// trade lanes at lane speed (enter anywhere, leave at the ends), a fixed time per jump — starting at the
// centre of the source system and ending on arrival in the target system. Returns the system sequence.
export function timeRoute(td, from, to, legal, opt = { cruise: 300, lane: 2500, jumpTime: 20, laneEnter: 8 }) {
  if (from === to) return [from];
  const N = td.nodes, dist = new Float64Array(N.length).fill(Infinity), prev = new Int32Array(N.length).fill(-1), via = new Uint8Array(N.length);
  const heap = [];
  const push = (d, i) => { heap.push([d, i]); let c = heap.length - 1; while (c > 0) { const p = (c - 1) >> 1; if (heap[p][0] <= heap[c][0]) break; [heap[p], heap[c]] = [heap[c], heap[p]]; c = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let c = 0; for (;;) { const l = 2 * c + 1, r = l + 1; let m = c; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === c) break; [heap[m], heap[c]] = [heap[c], heap[m]]; c = m; } } return top; };
  for (const n of td.bySystem.get(from) || []) { const d0 = Math.hypot(n.x, n.y, n.z) / opt.cruise; if (d0 < dist[n.i]) { dist[n.i] = d0; push(d0, n.i); } }
  while (heap.length) {
    const [d, u] = pop(); if (d > dist[u]) continue; const n = N[u];
    if (n.sys === to) { const seq = []; for (let i = u; i !== -1; i = prev[i]) { const s = N[i].sys; if (seq[0] !== s) seq.unshift(s); } return seq; }
    const relax = (v, w, how) => { const nd = d + w; if (nd < dist[v]) { dist[v] = nd; prev[v] = u; via[v] = how; push(nd, v); } };
    for (const t of n.lane) { const m = N[t]; relax(t, Math.hypot(m.x - n.x, m.y - n.y, m.z - n.z) / opt.lane + (via[u] === 2 ? 0 : opt.laneEnter), 2); }
    if (n.jump != null && (n.kind === 'gate' || !legal)) relax(n.jump, opt.jumpTime, 3);
    if (n.kind === 'ring' && !n.laneEnd && via[u] === 2) continue;
    for (const m of td.bySystem.get(n.sys)) if (m.i !== u) relax(m.i, Math.hypot(m.x - n.x, m.y - n.y, m.z - n.z) / opt.cruise, 1);
  }
  return null;
}
export async function routeGraph(app) {
  const { TradeData } = await import('../trade.js');
  const td = new TradeData(app); await app.loadAllSystemDocs(); td.buildGraph(); return td;
}
export async function extendShortestPaths(app, newNick, docs, mode = 'time') {
  const g = app.game, name = (n) => (g.findSystem(n) || {}).nickname || n;
  const out = []; extendShortestPaths._td = null;
  for (const [file, legal] of [['systems_shortest_path.ini', false], ['shortest_legal_path.ini', true], ['shortest_illegal_path.ini', false]]) {
    const doc = await app.otherDoc(dataPath('UNIVERSE\\' + file)); if (!doc) continue;
    const adj = connectionGraph(app, docs, legal), N = lc(newNick);
    const td = mode === 'time' ? (extendShortestPaths._td || (extendShortestPaths._td = await routeGraph(app))) : null;
    const find = (a, b) => (td && timeRoute(td, a, b, legal)) || bfsPath(adj, a, b);
    const fmt = (p) => `${name(p[0])}, ${name(p[p.length - 1])}, ${p.map(name).join(', ')}`;
    const secs = doc.ini.all('SystemConnections');
    const sourceOf = (s) => lc((s.findAll('Path')[0]?.values || [])[0]);
    out.push({ doc, apply: () => {
      // existing sources → new system
      for (const s of secs) { const from = sourceOf(s); if (!from || from === N || s.findAll('Path').some(e => lc(e.values[1]) === N)) continue; const p = find(from, N); if (p) s.add('Path', fmt(p)); }
      // new system → everything reachable (and itself)
      if (!secs.some(s => sourceOf(s) === N)) {
        const lines = [[`Path`, fmt([N])]];
        for (const t of g.systems.filter(x => !x.labelOnly)) { const tn = lc(t.nickname); if (tn === N) continue; const p = find(N, tn); if (p) lines.push(['Path', fmt(p)]); }
        doc.ini.addSection('SystemConnections', secs[secs.length - 1] || null, lines);
      }
    } });
  }
  return out;
}

// ---------------------------------------------------------------- wizard
export async function systemWizard(app) {
  const g = app.game;
  const prefixes = [...new Set(g.systems.map(s => (s.nickname.match(/^([A-Za-z]+)\d+$/) || [])[1]).filter(Boolean))].sort();
  const nextNick = (pre) => { let i = 1; while (g.findSystem(pre + String(i).padStart(2, '0'))) i++; return pre + String(i).padStart(2, '0'); };
  const curPre = app.sys ? (app.sys.nickname.match(/^([A-Za-z]+)\d+$/) || [])[1] : prefixes[0];
  // ---- inputs
  const name = h('input', { value: 'New Frontier', style: { width: '100%' } });
  const preSel = h('select', {}, prefixes.map(p => h('option', { selected: p === curPre }, p)));
  const nick = h('input', { value: nextNick(preSel.value), style: { width: '90px' } });
  preSel.onchange = () => { nick.value = nextNick(preSel.value); defaults(); };
  const posX = h('input', { type: 'number', step: 0.5, style: { width: '70px' } }), posY = h('input', { type: 'number', step: 0.5, style: { width: '70px' } });
  const tplSel = h('select', { style: { width: '100%' } }, g.systems.filter(s => !s.labelOnly).map(s => h('option', { value: s.nickname, selected: app.sys && s === app.sys.sys }, `${s.nickname} · ${g.name(s.strid) || ''}`)));
  const sunChk = h('input', { type: 'checkbox', checked: true });
  const nPlanets = h('select', {}, [0, 1, 2, 3, 4, 5].map(n => h('option', { value: n, selected: n === 3 }, n)));
  let seed = (Math.random() * 1e9) | 0;
  const baseChk = h('input', { type: 'checkbox', checked: true });
  const stationSel = h('select', { style: { width: '100%' } });
  const baseName = h('input', { value: '', placeholder: 'e.g. Frontier Station', style: { width: '100%' } });
  const baseTpl = h('select', { style: { width: '100%' } });
  const jumps = [0, 1, 2].map(() => ({ target: h('select', { style: { width: '100%' } }), kind: h('select', {}, h('option', { value: 'JUMP_GATE' }, 'gate'), h('option', { value: 'JUMP_HOLE' }, 'hole')) }));
  const routeMode = h('select', {}, h('option', { value: 'time' }, 'by travel time (trade lanes count)'), h('option', { value: 'hops' }, 'by fewest jumps'));
  const lanesChk = h('input', { type: 'checkbox', checked: true }), patrolChk = h('input', { type: 'checkbox', checked: true }), spChk = h('input', { type: 'checkbox', checked: true });
  const patrolSel = h('select', { style: { width: '100%' } });
  const uniCanvas = h('canvas', { width: 360, height: 260, style: { width: '100%', background: 'var(--well)', borderRadius: '6px', cursor: 'crosshair' } });
  const sysCanvas = h('canvas', { width: 360, height: 360, style: { width: '100%', background: 'var(--well)', borderRadius: '6px' } });
  const summary = h('div', { style: { fontSize: '12px', color: 'var(--dim)', marginTop: '6px' } });
  let tplDoc = null;

  // ---- template-dependent lists
  async function loadTemplate() {
    tplDoc = await app.loadSystemDoc(tplSel.value);
    const stations = new Map();
    const notStation = /dock|fixture|ring|dreadnought|battleship|wreck|mining/i;
    for (const o of tplDoc.objects) { const a = g.arch(o.get('archetype')); if (a && a.type === 'STATION' && o.get('base') && !notStation.test(a.nickname)) stations.set(lc(a.nickname), a.nickname); }
    for (const a of g.archetypes.values()) if (a.type === 'STATION' && stations.size < 40 && /station|outpost|depot|freeport|shipyard/i.test(a.nickname)) stations.set(lc(a.nickname), a.nickname);
    stationSel.innerHTML = ''; stationSel.append(...[...stations.values()].map(n => h('option', { value: n, selected: /^(largestation1|smallstation1)$/i.test(n) }, n)));
    // bases of the template system, station bases first (the wizard builds a station)
    const typesOf = (b) => tplDoc.objects.filter(o => lc(o.get('base')) === lc(b.nickname)).map(o => (g.arch(o.get('archetype')) || {}).type);
    const isStationBase = (b) => { const t = typesOf(b); return t.includes('STATION') && !t.includes('PLANET'); };
    const tb = g.bases.filter(b => lc(b.system) === lc(tplSel.value)).sort((a, b) => isStationBase(b) - isStationBase(a));
    baseTpl.innerHTML = ''; baseTpl.append(...[...tb, ...g.bases.filter(b => !tb.includes(b))].slice(0, 300).map(b => h('option', { value: b.nickname }, `${b.nickname} · ${g.name(b.strid) || ''}`)));
    const paths = [...collectPaths(tplDoc).values()].filter(p => /patrol/.test(p.usage));
    patrolSel.innerHTML = ''; patrolSel.append(...paths.map(p => h('option', { value: p.label }, `${p.label} (${p.segs.length} segments)`)));
    if (!paths.length) patrolSel.append(h('option', { value: '' }, '(template has no patrol paths)'));
    draw();
  }
  tplSel.onchange = loadTemplate;
  function defaults() {
    // a free spot near the template on the universe map, and the closest systems as jump targets
    const t = g.findSystem(tplSel.value) || g.systems[0];
    const taken = (x, y) => g.systems.some(s => Math.hypot(s.pos[0] - x, s.pos[1] - y) < 1.2);
    let best = [t.pos[0] + 1.5, t.pos[1]];
    for (let r = 1.5; r < 8; r += 0.5) { let found = false; for (let a = 0; a < 16; a++) { const x = +(t.pos[0] + Math.cos(a * Math.PI / 8) * r).toFixed(1), y = +(t.pos[1] + Math.sin(a * Math.PI / 8) * r).toFixed(1); if (!taken(x, y)) { best = [x, y]; found = true; break; } } if (found) break; }
    posX.value = best[0]; posY.value = best[1];
    fillTargets();
  }
  function fillTargets() {
    const p = [+posX.value, +posY.value];
    const near = g.systems.filter(s => !s.labelOnly).sort((a, b) => Math.hypot(a.pos[0] - p[0], a.pos[1] - p[1]) - Math.hypot(b.pos[0] - p[0], b.pos[1] - p[1]));
    jumps.forEach((j, i) => { const cur = j.target.value; j.target.innerHTML = ''; j.target.append(h('option', { value: '' }, '— none —'), ...near.map(s => h('option', { value: s.nickname }, `${s.nickname} · ${g.name(s.strid) || ''}`))); j.target.value = cur && near.some(s => s.nickname === cur) ? cur : i === 0 ? near[0].nickname : ''; });
    draw();
  }
  [posX, posY].forEach(x => x.onchange = fillTargets);
  [nPlanets, baseChk, lanesChk, patrolChk, sunChk, ...jumps.flatMap(j => [j.target, j.kind])].forEach(x => x.addEventListener('change', () => draw()));
  uniCanvas.onclick = (e) => { const r = uniCanvas.getBoundingClientRect(), u = uniView(); posX.value = +((e.clientX - r.left) / r.width * uniCanvas.width / u.s + u.x0).toFixed(1); posY.value = +((e.clientY - r.top) / r.height * uniCanvas.height / u.s + u.y0).toFixed(1); fillTargets(); };

  // ---- layout of the new system (shared by the preview and the creation)
  function plan() {
    const R = rng(seed), P = [], n = +nPlanets.value;
    const tplPlanets = tplDoc ? tplDoc.objects.filter(o => { const a = g.arch(o.get('archetype')); return a && a.type === 'PLANET' && !o.get('base'); }) : [];
    const allPlanets = [...g.archetypes.values()].filter(a => a.type === 'PLANET' && archRadius(a) >= 800 && archRadius(a) <= 6000);
    for (let i = 0; i < n; i++) {
      const tp = tplPlanets.length ? tplPlanets[Math.floor(R() * tplPlanets.length)] : null;
      const arch = tp ? g.arch(tp.get('archetype')) : allPlanets[Math.floor(R() * allPlanets.length)];
      const orbit = 13000 + i * 11000 + R() * 3000, ang = R() * Math.PI * 2;
      P.push({ tpl: tp, arch, pos: [Math.cos(ang) * orbit, 0, Math.sin(ang) * orbit].map(Math.round), orbit, r: archRadius(arch) || 2000 });
    }
    const me = [+posX.value, +posY.value];
    const J = jumps.filter(j => j.target.value).map(j => {
      const t = g.findSystem(j.target.value); const d = new THREE.Vector2(t.pos[0] - me[0], t.pos[1] - me[1]); if (!d.lengthSq()) d.set(1, 0); d.normalize();
      return { target: t, kind: j.kind.value, pos: [Math.round(d.x * 70000), 0, Math.round(d.y * 70000)] };
    });
    let station = null;
    if (baseChk.checked) {
      const sa = g.arch(stationSel.value), sr = archRadius(sa) || 600;
      if (P.length) { const p0 = P[0], d = new THREE.Vector3(...p0.pos).normalize(), side = new THREE.Vector3(-d.z, 0, d.x); const q = new THREE.Vector3(...p0.pos).addScaledVector(side, p0.r + sr + 3500); station = { pos: q.toArray().map(Math.round), r: sr }; }
      else station = { pos: [12000, 0, -9000], r: sr };
    }
    const lanes = station && lanesChk.checked ? J.filter(j => j.kind === 'JUMP_GATE').map(j => { const a = new THREE.Vector3(...station.pos), b = new THREE.Vector3(...j.pos), dir = b.clone().sub(a).normalize(); return { j, s: a.clone().addScaledVector(dir, station.r + 2500), e: b.clone().addScaledVector(dir, -4000) }; }) : [];
    const patrols = patrolChk.checked && patrolSel.value ? J.map(j => {
      const a = new THREE.Vector3(...(station ? station.pos : [0, 0, 0])), b = new THREE.Vector3(...j.pos), dir = b.clone().sub(a).normalize(), side = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(3000);
      return [a.clone().addScaledVector(dir, (station ? station.r : 10000) + 3000).add(side), b.clone().addScaledVector(dir, -3000).add(side)];
    }) : [];
    return { planets: P, jumps: J, station, lanes, patrols };
  }

  // ---- previews
  function uniView() { const xs = g.systems.map(s => s.pos[0]), ys = g.systems.map(s => s.pos[1]); const x0 = Math.min(...xs) - 1, x1 = Math.max(...xs) + 1, y0 = Math.min(...ys) - 1, y1 = Math.max(...ys) + 1; const s = Math.min(uniCanvas.width / (x1 - x0), uniCanvas.height / (y1 - y0)); return { x0, y0, s }; }
  function draw() {
    const pl = plan();
    { // universe
      const c = uniCanvas.getContext('2d'), u = uniView(), X = (x) => (x - u.x0) * u.s, Y = (y) => (y - u.y0) * u.s;
      c.clearRect(0, 0, uniCanvas.width, uniCanvas.height);
      c.fillStyle = '#556'; c.font = '9px sans-serif';
      for (const s of g.systems) { c.beginPath(); c.arc(X(s.pos[0]), Y(s.pos[1]), 2.5, 0, 7); c.fill(); c.fillText(s.nickname, X(s.pos[0]) + 3, Y(s.pos[1]) - 2); }
      const me = [+posX.value, +posY.value];
      c.strokeStyle = '#7ee787'; c.setLineDash([3, 3]);
      for (const j of pl.jumps) { c.beginPath(); c.moveTo(X(me[0]), Y(me[1])); c.lineTo(X(j.target.pos[0]), Y(j.target.pos[1])); c.stroke(); }
      c.setLineDash([]); c.fillStyle = '#ffe066'; c.beginPath(); c.arc(X(me[0]), Y(me[1]), 5, 0, 7); c.fill(); c.font = 'bold 11px sans-serif'; c.fillText(nick.value, X(me[0]) + 7, Y(me[1]) + 4);
    }
    { // system
      const c = sysCanvas.getContext('2d'), W = sysCanvas.width, S = W / 2 / 80000, C = (p) => [W / 2 + p[0] * S, W / 2 + p[2] * S];
      c.clearRect(0, 0, W, W);
      c.strokeStyle = '#1e2633'; for (let r = 20000; r <= 80000; r += 20000) { c.beginPath(); c.arc(W / 2, W / 2, r * S, 0, 7); c.stroke(); }
      if (sunChk.checked) { c.fillStyle = '#ffd34d'; c.beginPath(); c.arc(W / 2, W / 2, 6, 0, 7); c.fill(); }
      pl.planets.forEach((p, i) => { c.strokeStyle = '#26324a'; c.beginPath(); c.arc(W / 2, W / 2, p.orbit * S, 0, 7); c.stroke(); const [x, y] = C(p.pos); c.fillStyle = '#6aaee8'; c.beginPath(); c.arc(x, y, Math.max(3, p.r * S), 0, 7); c.fill(); c.fillStyle = '#9fb6cc'; c.font = '10px sans-serif'; c.fillText(`${name.value} ${ROMAN[i]}`, x + 6, y - 4); });
      c.strokeStyle = '#50e080'; c.setLineDash([]); for (const l of pl.lanes) { const a = C(l.s.toArray()), b = C(l.e.toArray()); c.lineWidth = 2; c.beginPath(); c.moveTo(...a); c.lineTo(...b); c.stroke(); c.lineWidth = 1; }
      c.strokeStyle = '#ffa040'; c.setLineDash([4, 4]); for (const p of pl.patrols) { const a = C(p[0].toArray()), b = C(p[1].toArray()); c.beginPath(); c.moveTo(...a); c.lineTo(...b); c.stroke(); } c.setLineDash([]);
      if (pl.station) { const [x, y] = C(pl.station.pos); c.fillStyle = '#c080ff'; c.fillRect(x - 4, y - 4, 8, 8); c.fillStyle = '#d8c0ff'; c.fillText(baseName.value || 'station', x + 6, y + 12); }
      for (const j of pl.jumps) { const [x, y] = C(j.pos); c.strokeStyle = j.kind === 'JUMP_GATE' ? '#7ee787' : '#ff8a65'; c.lineWidth = 2; c.beginPath(); c.arc(x, y, 6, 0, 7); c.stroke(); c.lineWidth = 1; c.fillStyle = '#ccd'; c.fillText(`→ ${j.target.nickname}`, x + 8, y + 3); }
    }
    const lanesRings = pl.lanes.reduce((s, l) => s + Math.max(2, Math.round(l.s.distanceTo(l.e) / 7500) + 1), 0);
    summary.textContent = `${nick.value}: ${sunChk.checked ? 'sun, ' : ''}${pl.planets.length} planet(s)${pl.station ? ', a station with a base' : ''}, ${pl.jumps.length} jump connection(s)${pl.lanes.length ? `, ${pl.lanes.length} trade lane(s) (${lanesRings} rings)` : ''}${pl.patrols.length ? `, ${pl.patrols.length} patrol path(s)` : ''}${spChk.checked ? ', shortest-path files extended' : ''}.`;
  }
  [name, baseName, nick].forEach(x => x.addEventListener('input', draw));

  // ---- create
  async function create() {
    const n = nick.value.trim();
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(n) || g.findSystem(n)) { toast('Nickname empty, invalid or already used'); return false; }
    if (!g.editableDlls().length) { toast('No editable resource DLL for the names'); return false; }
    const pl = plan(), tpl = tplDoc, steps = [];
    overlay('Creating system…');
    try {
      const strid = app.newText('string', name.value.trim() || n);
      await createSystem(app, { nick: n, strid: String(strid), pos: `${posX.value}, ${posY.value}`, src: tpl, sun: false });
      await app.openSystem(n);
      const sys = app.sys;
      const lf = (tpl.ini.first('SystemInfo') || { get: () => null }).get('local_faction') || 'li_p_grp';
      // sun + light, planets with death zones (names first: each new string is its own undo step)
      const sunStr = sunChk.checked ? app.newText('string', `${name.value.trim() || n} Sun`) : null;
      const planetStr = pl.planets.map((p, i) => app.newText('string', `${name.value.trim() || n} ${ROMAN[i]}`));
      app.history.do('Wizard: sun & planets', [sys], () => {
        if (sunChk.checked) {
          const tl = tpl.ini.all('LightSource')[0], ts = tpl.objects.find(o => (g.arch(o.get('archetype')) || {}).type === 'SUN');
          sys.ini.addSection('LightSource', sys.ini.all('LightSource').pop() || sys.ini.first('Background'), [['nickname', `${n}_system_light`], ['pos', '0, 0, 0'], ['color', tl?.get('color') || '255, 255, 255'], ['range', tl?.get('range') || '150000'], ['type', tl?.get('type') || 'DIRECTIONAL'], ['atten_curve', tl?.get('atten_curve') || 'DYNAMIC_DIRECTION']]);
          const sa = ts ? ts.get('archetype') : [...g.archetypes.values()].find(a => a.type === 'SUN')?.nickname;
          sys.addObject(sa, [0, 0, 0], { nickname: `${n}_Sun`, ids_name: sunStr, ambient_color: ts?.get('ambient_color') || '255, 255, 255', star: ts?.get('star') || 'med_white_sun', atmosphere_range: ts?.get('atmosphere_range') || '9000', burn_color: ts?.get('burn_color') || '255, 255, 255', visit: ts?.get('visit') || null });
          sys.addZone('SPHERE', [0, 0, 0], [10000], { nickname: `Zone_${n}_sun_death`, damage: 10000, sort: 99.5, density: 0, relief_time: 0, population_additive: 'false' });
        }
        pl.planets.forEach((p, i) => {
          const pn = `${n}_${String(i + 1).padStart(2, '0')}`, ids = planetStr[i];
          const extra = { nickname: pn, ids_name: ids };
          if (p.tpl) for (const k of ['spin', 'atmosphere_range', 'burn_color', 'ambient_color', 'visit']) if (p.tpl.get(k)) extra[k] = p.tpl.get(k);
          sys.addObject(p.arch.nickname, p.pos, extra);
          sys.addZone('SPHERE', p.pos, [Math.round(p.r * 1.025)], { nickname: `Zone_${pn}_death`, damage: 2000000, sort: 99.5, density: 0, relief_time: 0, population_additive: 'false' });
        });
      });
      // station + base (rooms, bar characters, markets cloned from the template base)
      let stationSec = null;
      if (pl.station) {
        const tb = g.findBase(baseTpl.value);
        const tst = tb && [...app.systemDocs.values()].flatMap(d => d.objects).find(o => lc(o.get('base')) === lc(tb.nickname));
        const bname = baseName.value.trim() || `${name.value.trim() || n} Station`;
        const ids = app.newText('string', bname);
        app.history.do('Wizard: station', [sys], () => {
          const extra = { nickname: `${n}_${String(pl.planets.length + 1).padStart(2, '0')}`, ids_name: ids, reputation: lf, behavior: 'NOTHING', difficulty_level: 1 };
          if (tst) for (const k of ['ids_info', 'loadout', 'pilot', 'voice', 'space_costume']) if (tst.get(k)) extra[k] = tst.get(k);
          stationSec = sys.addObject(stationSel.value, pl.station.pos, extra);
        });
        await doCreateBase(app, stationSec, `${n}_01_Base`, String(ids), tb, { rooms: true, mbases: true, markets: true });
      }
      // jump connections (both ends)
      const twinOf = (arch) => [...app.systemDocs.values()].flatMap(d => d.objects).find(o => lc(o.get('archetype')) === lc(arch) && o.get('goto'));
      const gateNicks = [];
      for (const j of pl.jumps) {
        const td = await app.loadSystemDoc(j.target.nickname), A = n, B = td.nickname, hole = j.kind === 'JUMP_HOLE';
        const arch = [...g.archetypes.values()].find(a => a.type === j.kind && (hole ? /^jumphole$/i.test(a.nickname) : /^jumpgate$/i.test(a.nickname)))?.nickname || [...g.archetypes.values()].find(a => a.type === j.kind)?.nickname;
        const twin = twinOf(arch), tunnel = g.gateTunnels.find(t => /^gate_tunnel_bretonia$/i.test(t)) || g.gateTunnels[0] || 'gate_tunnel_bretonia', effect = (hole ? g.jumpEffects.find(e => /^jump_effect_hole$/i.test(e)) : g.jumpEffects.find(e => /^jump_effect_bretonia$/i.test(e))) || g.jumpEffects[0] || ''; // as vanilla: one tunnel for all, hole / gate effect
        const n1 = sys.uniqueNick(hole ? `${A}_to_${B}_hole` : `${A}_to_${B}`), n2 = td.uniqueNick(hole ? `${B}_to_${A}_hole` : `${B}_to_${A}`);
        const d = new THREE.Vector2(A === B ? 1 : (+posX.value - j.target.pos[0]), +posY.value - j.target.pos[1]); if (!d.lengthSq()) d.set(1, 0); d.normalize();
        const tp = [Math.round(d.x * 120000 / (j.target.navScale || 1) * 0.6), 0, Math.round(d.y * 120000 / (j.target.navScale || 1) * 0.6)];
        const yawTo = (p) => { const r = laneRotation([0, 0, 0], [-p[0], 0, -p[2]]); return [0, r[1], 0]; };
        const common = (toSys, from) => { const e = { behavior: 'NOTHING', difficulty_level: '1', msg_id_prefix: `gcs_refer_system_${toSys}`, jump_effect: effect }; if (twin) for (const k of ['ids_info', 'loadout', 'pilot']) if (twin.get(k)) e[k] = twin.get(k); e.ids_name = (g.findSystem(toSys) || {}).strid || twin?.get('ids_name'); if (!hole) { const f = from.ini.first('SystemInfo'); if (f && f.get('local_faction')) e.reputation = f.get('local_faction'); } return e; };
        app.history.do(`Wizard: ${hole ? 'jump hole' : 'jump gate'} ${A} ↔ ${B}`, [sys, td], () => {
          sys.addObject(arch, j.pos, { ...common(B, sys), nickname: n1, rotate: yawTo(j.pos), goto: `${B}, ${n2}, ${tunnel}` });
          td.addObject(arch, tp, { ...common(A, td), nickname: n2, rotate: yawTo(tp), goto: `${A}, ${n1}, ${tunnel}` });
        });
        gateNicks.push(n1);
      }
      // trade lanes from the station to each gate
      if (pl.lanes.length) {
        const ringArch = [...g.archetypes.values()].find(a => a.type === 'TRADELANE_RING' && /^trade_lane_ring$/i.test(a.nickname))?.nickname || [...g.archetypes.values()].find(a => a.type === 'TRADELANE_RING')?.nickname;
        const tplRing = tpl.objects.find(o => lc(o.get('archetype')) === lc(ringArch)) || [...app.systemDocs.values()].flatMap(d => d.objects).find(o => lc(o.get('archetype')) === lc(ringArch));
        let k = 1;
        app.history.do('Wizard: trade lanes', [sys], () => {
          for (const l of pl.lanes) {
            const cnt = Math.max(2, Math.round(l.s.distanceTo(l.e) / 7500) + 1), nicks = [];
            for (let i = 0; i < cnt; i++) { while (sys.nickExists(`${n}_Trade_Lane_Ring_${k}`)) k++; nicks.push(`${n}_Trade_Lane_Ring_${k++}`); }
            const rot = laneRotation(l.s.toArray(), l.e.toArray());
            for (let i = 0; i < cnt; i++) {
              const p = l.s.clone().lerp(l.e, i / (cnt - 1));
              const extra = { nickname: nicks[i], rotate: rot, behavior: 'NOTHING' };
              if (tplRing) for (const kk of ['ids_name', 'ids_info', 'reputation', 'difficulty_level', 'loadout', 'pilot']) if (tplRing.get(kk)) extra[kk] = tplRing.get(kk);
              extra.reputation = lf;
              if (i > 0) extra.prev_ring = nicks[i - 1]; if (i < cnt - 1) extra.next_ring = nicks[i + 1];
              if (i === 0) extra.tradelane_space_name = l.j.target.strid || ''; if (i === cnt - 1 && stationSec) extra.tradelane_space_name = stationSec.get('ids_name');
              sys.addObject(ringArch, p.toArray().map(Math.round), extra);
            }
          }
        });
      }
      // patrol paths with the template path's population and encounters
      if (pl.patrols.length) {
        const tp = collectPaths(tpl).get(lc(patrolSel.value));
        const first = tp && tp.segs[0].sec;
        const props = first ? first.entries.filter(e => !['nickname', 'pos', 'rotate', 'shape', 'size', 'path_label', 'comment', 'ids_name', 'ids_info'].includes(lc(e.key))).map(e => [e.key, e.value]) : [['usage', 'patrol']];
        const radius = first ? (parseFloat((first.vals('size') || [])[0]) || 750) : 750;
        // the encounters the path uses must be declared in the system ([EncounterParameters] nickname + filename)
        const encs = new Set(props.filter(([k]) => lc(k) === 'encounter').map(([, v]) => lc(String(v).split(',')[0].trim())));
        const params = tpl.ini.all('EncounterParameters').filter(e => encs.has(lc(e.get('nickname'))));
        app.history.do('Wizard: patrol paths', [sys], () => {
          for (const e of params) if (!sys.ini.all('EncounterParameters').some(x => lc(x.get('nickname')) === lc(e.get('nickname')))) sys.ini.addSection('EncounterParameters', sys.ini.all('EncounterParameters').pop() || sys.ini.first('Background') || null, e.entries.map(x => [x.key, x.value]));
          pl.patrols.forEach((p, i) => createPath(sys, `${n}_patrol_${i + 1}`, p, radius, props));
        });
      }
      // shortest-path files
      if (spChk.checked) {
        overlay('Routes: reading all systems…');
        const docs = await app.loadAllSystemDocs();
        const ext = await extendShortestPaths(app, n, docs, routeMode.value);
        if (ext.length) app.history.do('Wizard: shortest paths', ext.map(x => x.doc), () => ext.forEach(x => x.apply()));
      }
      g.refreshUniverse();
      await app.openSystem(n);
      overlay(null);
      toast(`${name.value} (${n}) created — press Ctrl+S to write all files`, 6000);
      return true;
    } catch (e) { console.error(e); overlay(null); toast('Wizard stopped: ' + e.message + ' — Ctrl+Z undoes what was created', 8000); return true; }
  }

  modal({ title: 'New system wizard', wide: true, body: h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 380px', gap: '14px' } },
    h('div', { class: 'form' },
      h('label', {}, 'Name'), name, null,
      h('label', {}, 'Nickname'), h('div', { class: 'btnrow' }, preSel, nick), h('div', { class: 'help' }, 'Region prefix + number, as in the game (Li01, Br04…)'),
      h('label', {}, 'Universe map'), h('div', { class: 'btnrow' }, 'x', posX, 'y', posY), h('div', { class: 'help' }, 'Click the map on the right to place the system'),
      h('label', {}, 'Template system'), tplSel, h('div', { class: 'help' }, 'Music, background, dust, ambient light, space colour, local faction, sun and planet types are taken from it'),
      h('label', {}, 'Sun'), sunChk, null,
      h('label', {}, 'Planets'), h('div', { class: 'btnrow' }, nPlanets, h('button', { class: 'btn sm', onclick: () => { seed = (Math.random() * 1e9) | 0; draw(); } }, '🎲 new layout')), h('div', { class: 'help' }, 'Each gets a name (“Name I, II…”) and a death zone'),
      h('label', {}, 'Station with base'), baseChk, null,
      h('label', {}, 'Station model'), stationSel, null,
      h('label', {}, 'Base name'), baseName, null,
      h('label', {}, 'Copy base from'), baseTpl, h('div', { class: 'help' }, 'Rooms, bar characters and markets are cloned from this base'),
      ...jumps.flatMap((j, i) => [h('label', {}, `Jump ${i + 1}`), h('div', { class: 'btnrow' }, j.target, j.kind), i === 0 ? h('div', { class: 'help' }, 'Both ends are created; each end faces the other system') : null]),
      h('label', {}, 'Trade lanes'), lanesChk, h('div', { class: 'help' }, 'From the station to each jump gate'),
      h('label', {}, 'Patrol paths'), h('div', { class: 'btnrow' }, patrolChk, patrolSel), h('div', { class: 'help' }, 'Station ↔ each jump, with the population and encounters of the chosen template path'),
      h('label', {}, 'Routes'), h('div', { class: 'btnrow' }, spChk, routeMode), h('div', { class: 'help' }, 'Add routes to and from the new system to the shortest-path files (nav map route plotting, NPC traffic). Travel time: cruise 300 m/s, lanes 2,500 m/s, 20 s per jump; legal routes use gates only')),
    h('div', {}, uniCanvas, h('div', { style: { height: '8px' } }), sysCanvas, summary)),
    buttons: [{ label: 'Cancel' }, { label: 'Create system', cls: 'primary', onClick: create }] }).box.classList.add('xwide');
  defaults(); await loadTemplate();
}

// ---------------------------------------------------------------- routes tool (Tools menu)
// Checks the three shortest-path files against the current universe: systems without a section, reachable
// pairs without a Path, and Paths that use a connection that no longer exists (or a hole in the legal file).
// "Add missing" only adds lines; "Rebuild" rewrites every Path (travel time or fewest jumps).
export async function routesTool(app) {
  const g = app.game;
  overlay('Routes: reading all systems…');
  const docs = await app.loadAllSystemDocs(); const td = await routeGraph(app);
  overlay(null);
  const name = (n) => (g.findSystem(n) || {}).nickname || n;
  const FILES = [['systems_shortest_path.ini', false, 'all connections'], ['shortest_legal_path.ini', true, 'jump gates only'], ['shortest_illegal_path.ini', false, 'gates and holes']];
  const body = h('div', { style: { fontSize: '13px' } });
  const mode = h('select', {}, h('option', { value: 'time' }, 'travel time (trade lanes count)'), h('option', { value: 'hops' }, 'fewest jumps'));
  const hiddenChk = h('input', { type: 'checkbox', onchange: () => analyse() });
  const isHidden = (n) => ((parseInt((g.findSystem(n) || { section: { get: () => '0' } }).section.get('visit') || '0') || 0) & 128) !== 0;
  const wanted = () => g.systems.filter(s => !s.labelOnly).map(s => lc(s.nickname)).filter(n => hiddenChk.checked || !isHidden(n));
  let report = [];
  async function analyse() {
    report = [];
    for (const [file, legal, what] of FILES) {
      const doc = await app.otherDoc(dataPath('UNIVERSE\\' + file)); if (!doc) { report.push({ file, missingFile: true }); continue; }
      const adj = connectionGraph(app, docs, legal);
      const secs = doc.ini.all('SystemConnections'), bySrc = new Map();
      for (const s of secs) { const p = s.findAll('Path'); const src = lc((p[0]?.values || [])[0]); if (src) bySrc.set(src, s); }
      const sysNicks = wanted();
      const noSection = sysNicks.filter(n => !bySrc.has(n) && (adj.get(n) || new Set()).size);
      let missing = 0, broken = 0; const brokenEx = [];
      for (const [src, s] of bySrc) {
        const have = new Set(s.findAll('Path').map(e => lc(e.values[1])));
        for (const e of s.findAll('Path')) { const r = e.values.slice(2).map(lc); for (let i = 0; i + 1 < r.length; i++) if (!(adj.get(r[i]) || new Set()).has(r[i + 1])) { broken++; if (brokenEx.length < 4) brokenEx.push(`${e.values[0]} → ${e.values[1]}: ${r[i]} ↛ ${r[i + 1]}`); break; } }
        for (const t of sysNicks) if (!have.has(t) && t !== src && bfsPath(adj, src, t)) missing++;
      }
      report.push({ file, legal, what, doc, adj, bySrc, noSection, missing, broken, brokenEx, paths: secs.reduce((a, s) => a + s.findAll('Path').length, 0) });
    }
    render();
  }
  function render() {
    body.innerHTML = '';
    body.append(h('p', { style: { marginTop: 0, color: 'var(--dim)' } }, 'Freelancer plots nav-map routes and sends NPC traffic along the routes in these files. A system you added needs routes to and from it; a removed or changed jump connection leaves broken routes.'));
    for (const r of report) {
      if (r.missingFile) { body.append(h('div', {}, `${r.file}: not found`)); continue; }
      const ok = !r.noSection.length && !r.missing && !r.broken;
      body.append(h('div', { style: { border: '1px solid var(--line)', borderRadius: '8px', padding: '8px 10px', marginBottom: '8px' } },
        h('b', {}, r.file), h('span', { style: { color: 'var(--faint)' } }, ` · ${r.what} · ${r.paths} routes`),
        h('div', { style: { color: ok ? '#7ee787' : '#ffd34d', marginTop: '3px' } }, ok ? '✓ complete — every reachable pair has a route and all routes use existing connections' :
          [r.noSection.length ? `${r.noSection.length} system(s) without a section (${r.noSection.slice(0, 6).map(name).join(', ')}${r.noSection.length > 6 ? '…' : ''})` : '', r.missing ? `${r.missing} missing route(s)` : '', r.broken ? `${r.broken} route(s) through a connection that does not exist` : ''].filter(Boolean).join(' · ')),
        r.brokenEx.length ? h('div', { style: { color: 'var(--faint)', fontSize: '12px' } }, 'e.g. ' + r.brokenEx.join(' · ')) : null));
    }
    body.append(h('div', { class: 'btnrow', style: { alignItems: 'center', marginTop: '6px' } }, 'New routes by', mode, h('label', { title: 'systems with visit = 128 (story-only, e.g. St01–St03) have no routes in the original game' }, hiddenChk, ' include story-only systems (visit = 128)')),
      h('div', { style: { color: 'var(--faint)', fontSize: '12px', marginTop: '4px' } }, 'The original game also has no routes for Li05 (Alaska); adding them lets NPC traffic and route plotting go through it. Existing correct routes are never changed by “Add missing / fix broken”.'));
  }
  const find = (r, a, b) => (mode.value === 'time' && timeRoute(td, a, b, r.legal)) || bfsPath(r.adj, a, b);
  const fmt = (p) => `${name(p[0])}, ${name(p[p.length - 1])}, ${p.map(name).join(', ')}`;
  function apply(rebuild) {
    const docsTouched = report.filter(r => r.doc).map(r => r.doc); let added = 0, rewritten = 0;
    app.history.do(rebuild ? 'Rebuild routes' : 'Add missing routes', docsTouched, () => {
      for (const r of report) {
        if (!r.doc) continue;
        const sysNicks = wanted();
        for (const src of sysNicks) {
          if (!(r.adj.get(src) || new Set()).size && !r.bySrc.has(src)) continue;
          let s = r.bySrc.get(src);
          if (!s) { const secs = r.doc.ini.all('SystemConnections'); s = r.doc.ini.addSection('SystemConnections', secs[secs.length - 1] || null, [['Path', fmt([src])]]); r.bySrc.set(src, s); added++; }
          if (rebuild) {
            for (const e of s.findAll('Path')) { const t = lc(e.values[1]); const p = find(r, src, t); if (p) { const v = fmt(p); if (v !== e.value) { e.value = v; e.raw = null; rewritten++; } } else { s.removeEntry(e); rewritten++; } }
          } else {
            for (const e of s.findAll('Path')) { const rr = e.values.slice(2).map(lc); if (rr.some((x, i) => i + 1 < rr.length && !(r.adj.get(x) || new Set()).has(rr[i + 1]))) { const p = find(r, src, lc(e.values[1])); if (p) { e.value = fmt(p); e.raw = null; } else s.removeEntry(e); rewritten++; } }
          }
          const have = new Set(s.findAll('Path').map(e => lc(e.values[1])));
          for (const t of sysNicks) if (!have.has(t) && t !== src) { const p = find(r, src, t); if (p) { s.add('Path', fmt(p)); added++; } }
        }
      }
    });
    toast(`${added} route(s) added, ${rewritten} rewritten — Ctrl+S to save`, 5000);
    analyse();
  }
  modal({ title: 'Routes (shortest-path files)', wide: true, body, buttons: [
    { label: 'Close' },
    { label: 'Rebuild all routes', onClick: () => { apply(true); return false; } },
    { label: 'Add missing / fix broken', cls: 'primary', onClick: () => { apply(false); return false; } }] });
  await analyse();
}
