// Trade data + route finding.
//
// Markets (Common.dll BaseDataList::load_market_data @0x06265900):
//   MarketGood = good, level, rep, min_stock, max_stock, flag, price_multiplier
//   defaults: level 0, rep -1, min 0, max 0, flag 0, multiplier 1. A line that is all defaults is
//   skipped by the game. Vanilla commodities use exactly two forms:
//     "…, 150, 500, 0, m"  → the base SELLS the good (stock 150–500)       (844 lines)
//     "…, 0, 0, 1, m"      → the base only BUYS it (no stock, flag 1)       (1150 lines)
//   The 6th value decides: 0 = sells, 1 = buys only. Discovery writes "x, 0, 0, m" (sells) and "x, 1, 1, m" (buys).
//   Price = goods.ini price × multiplier.
// Edits only touch the changed line (rewriting a whole market file would sort it, lose comments and
// could turn min/max into 1/1 or 0/0 and the flag into 0, which turns the base's 150–500 stock into 1).
//
// Travel time: Dijkstra over docking points (bases, jump gates/holes, trade-lane rings) in every system.
//   * straight flight between points of one system at cruise speed,
//   * trade lanes ring → next/prev ring at lane speed (enter at any ring, leave only at a lane end),
//   * jump gate/hole → its goto target in the other system (+ fixed jump time).
// Obstacles (planets, fields) are ignored; times are estimates for comparing routes.
import { dataPath } from './api.js';
import { loadIni } from './gamedata.js';
import { getPos } from './system.js';

export const TRADE_DEFAULTS = { cruise: 300, lane: 2500, jumpTime: 20, dockTime: 20, laneEnter: 8, cargo: 100, holes: true, unlisted: false };

export class TradeData {
  constructor(app) { this.app = app; this.ready = null; }
  load(progress = () => { }) {
    if (!this.ready) this.ready = this.app.whileBusy ? this.app.whileBusy(() => this._load(progress)) : this._load(progress);
    return this.ready;
  }
  async _load(progress) {
    const app = this.app, g = app.game;
    const dget = (k) => { const s = g.flIni && g.flIni.first('Data'); return s ? s.getAll(k) : []; };
    progress('Reading goods');
    this.goods = new Map();      // good nickname -> { nickname, price, equipment, category }
    this.commodities = new Map(); // equipment nickname -> { nickname, ids, volume }
    this.equipment = new Map();   // any equipment nickname -> { type, ids }
    await Promise.all((dget('goods').length ? dget('goods') : ['equipment\\goods.ini']).map(async f => {
      const d = await loadIni(dataPath(f)); if (!d) return;
      for (const s of d.all('Good')) { const n = s.get('nickname'); if (n) this.goods.set(n.toLowerCase(), { nickname: n, price: parseFloat(s.get('price') || '0'), equipment: s.get('equipment') || n, category: (s.get('category') || '').toLowerCase(), hull: s.get('hull'), ship: s.get('ship'), ids: parseInt(s.get('ids_name') || '0') }); }
    }));
    await Promise.all((dget('equipment').length ? dget('equipment') : ['equipment\\select_equip.ini']).map(async f => {
      const d = await loadIni(dataPath(f)); if (!d) return;
      for (const s of d.all('Commodity')) { const n = s.get('nickname'); if (n) this.commodities.set(n.toLowerCase(), { nickname: n, ids: parseInt(s.get('ids_name') || '0'), volume: parseFloat(s.get('volume') || '1') || 1 }); }
      // every equipment section (Gun, ShieldGenerator, Thruster, Engine, Power, Armor, …) for in-game names
      for (const s of d.sections) { const n = s.get('nickname'); if (n && !this.equipment.has(n.toLowerCase())) this.equipment.set(n.toLowerCase(), { type: s.name, ids: parseInt(s.get('ids_name') || '0') }); }
    }));
    this.ships = new Map();
    for (const f of (dget('ships').length ? dget('ships') : ['ships\\shiparch.ini'])) { const d = await loadIni(dataPath(f)); if (d) for (const s of d.all('Ship')) { const n = s.get('nickname'); if (n) this.ships.set(n.toLowerCase(), parseInt(s.get('ids_name') || '0')); } }
    progress('Reading markets');
    this.marketFiles = dget('markets').length ? dget('markets') : ['equipment\\market_commodities.ini'];
    this.marketDocs = [];
    for (const f of this.marketFiles) { const d = await app.otherDoc(dataPath(f)); if (d) this.marketDocs.push(d); }
    progress('Loading all systems');
    await app.loadAllSystemDocs((i, n) => progress(`Loading systems ${i}/${n}`));
    this.buildGraph();
    this.readMarkets();
  }
  // in-game name of a good: commodity/equipment via its equipment's ids_name, ships via package → hull good ids_name
  goodName(nick) {
    const g = this.app.game, gd = this.goods.get((nick || '').toLowerCase());
    if (!gd) return nick;
    if (gd.category === 'ship') { const hull = gd.hull && this.goods.get(gd.hull.toLowerCase()); return (hull && (g.name(hull.ids) || (hull.ship && g.name(this.shipIds(hull.ship))))) || nick; }
    if (gd.category === 'shiphull') return g.name(gd.ids) || nick;
    const c = this.commodities.get(gd.equipment.toLowerCase()) || this.equipment.get(gd.equipment.toLowerCase());
    return (c && g.name(c.ids)) || g.name(gd.ids) || nick;
  }
  // what kind of good: Commodity, Gun, ShieldGenerator, … or Ship
  goodKind(nick) {
    const gd = this.goods.get((nick || '').toLowerCase()); if (!gd) return '';
    if (gd.category === 'ship' || gd.category === 'shiphull') return 'Ship';
    const e = this.equipment.get(gd.equipment.toLowerCase());
    const t = e ? e.type : gd.category;
    return ({ Gun: 'Guns', Munition: 'Ammo & missiles', Mine: 'Mines', MineDropper: 'Mine droppers', CounterMeasure: 'Countermeasures', CounterMeasureDropper: 'Countermeasure droppers', ShieldGenerator: 'Shields', ShieldBattery: 'Shield batteries', RepairKit: 'Nanobots', Thruster: 'Thrusters', Engine: 'Engines', Power: 'Power plants', Armor: 'Armor', Scanner: 'Scanners', Tractor: 'Tractor beams', CloakingDevice: 'Cloaks', Commodity: 'Commodities' })[t] || t;
  }
  goodPrice(nick) {
    const gd = this.goods.get((nick || '').toLowerCase()); if (!gd) return 0;
    if (gd.category === 'ship') { const hull = gd.hull && this.goods.get(gd.hull.toLowerCase()); return hull ? hull.price : 0; }
    return gd.price;
  }
  shipIds(ship) { return this.ships && this.ships.get(ship.toLowerCase()) || 0; }
  isCommodity(nick) { const gd = this.goods.get((nick || '').toLowerCase()); return !!gd && (gd.category === 'commodity' || this.commodities.has(gd.equipment.toLowerCase())); }
  volume(nick) { const gd = this.goods.get((nick || '').toLowerCase()); const c = gd && this.commodities.get(gd.equipment.toLowerCase()); return c ? c.volume : 1; }

  // ---------------------------------------------------------------- markets
  // entries: { doc, sec, entry, base, good, level, rep, min, max, flag, mult, price, sells }
  readMarkets() {
    this.market = new Map(); // base lower -> [entries]
    for (const doc of this.marketDocs) for (const sec of doc.ini.all('BaseGood')) {
      const base = sec.get('base'); if (!base) continue;
      const list = this.market.get(base.toLowerCase()) || [];
      for (const e of sec.findAll('MarketGood')) {
        const v = e.values;
        const gd = this.goods.get((v[0] || '').toLowerCase());
        const num = (i, d) => (v[i] === undefined || v[i] === '' ? d : parseFloat(v[i]));
        const m = { doc, sec, entry: e, base, good: v[0], level: num(1, 0), rep: num(2, -1), min: num(3, 0), max: num(4, 0), flag: num(5, 0), mult: num(6, 1) };
        m.price = Math.floor(this.goodPrice(m.good) * m.mult);
        m.sells = m.flag === 0; // 6th value: 0 = the base sells it, 1 = only buys (stock values are not what decides — Discovery writes "x, 0, 0" for goods it sells)
        m.commodity = this.isCommodity(m.good);
        m.unknown = !gd;
        list.push(m);
      }
      this.market.set(base.toLowerCase(), list);
    }
  }
  baseMarket(base) { return this.market.get((base || '').toLowerCase()) || []; }

  // ---------------------------------------------------------------- graph
  buildGraph() {
    const app = this.app, g = app.game;
    this.nodes = []; this.bySystem = new Map(); this.baseNode = new Map();
    const objNode = new Map(); // "sys|nick" -> node index
    const add = (sys, sec, kind) => {
      const p = getPos(sec);
      const n = { i: this.nodes.length, sys: sys.nickname.toLowerCase(), sec, nick: sec.get('nickname'), kind, x: p[0], y: p[1], z: p[2], lane: [], jump: null, laneEnd: true };
      this.nodes.push(n);
      if (!this.bySystem.has(n.sys)) this.bySystem.set(n.sys, []);
      this.bySystem.get(n.sys).push(n);
      objNode.set(n.sys + '|' + (n.nick || '').toLowerCase(), n.i);
      return n;
    };
    for (const sys of app.systemDocs.values()) {
      for (const o of sys.objects) {
        const a = g.arch(o.get('archetype')); const t = a ? a.type : '';
        const base = o.get('dock_with') || o.get('base');
        if (t === 'TRADELANE_RING') add(sys, o, 'ring');
        else if (o.has('goto') && (t === 'JUMP_GATE' || t === 'JUMP_HOLE' || /jump/i.test(t))) add(sys, o, t === 'JUMP_HOLE' ? 'hole' : 'gate');
        else if (base && g.findBase(base)) {
          const n = add(sys, o, 'base'); n.base = base.toLowerCase();
          // prefer the docking ring (dock_with) over the planet itself (base =)
          if (!this.baseNode.has(n.base) || o.has('dock_with')) this.baseNode.set(n.base, n.i);
        }
      }
    }
    // lanes and jumps
    for (const n of this.nodes) {
      if (n.kind === 'ring') {
        for (const k of ['next_ring', 'prev_ring']) { const t = objNode.get(n.sys + '|' + (n.sec.get(k) || '').toLowerCase()); if (t != null) n.lane.push(t); }
        n.laneEnd = n.lane.length < 2;
      }
      if (n.kind === 'gate' || n.kind === 'hole') {
        const go = n.sec.vals('goto');
        if (go && go[1]) { const t = objNode.get(go[0].toLowerCase() + '|' + go[1].toLowerCase()); if (t != null) n.jump = t; }
      }
    }
  }
  // shortest times (seconds) from a base to every node; cached per option set
  times(fromBase, opt) {
    const key = fromBase + '|' + [opt.cruise, opt.lane, opt.jumpTime, opt.laneEnter, opt.holes].join(',');
    this.cache = this.cache || new Map();
    if (this.cache.has(key)) return this.cache.get(key);
    const N = this.nodes.length, dist = new Float64Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1), via = new Uint8Array(N);
    const s = this.baseNode.get(fromBase); if (s == null) return null;
    dist[s] = 0;
    // binary heap
    const heap = [[0, s]];
    const push = (d, i) => { heap.push([d, i]); let c = heap.length - 1; while (c > 0) { const p = (c - 1) >> 1; if (heap[p][0] <= heap[c][0]) break; [heap[p], heap[c]] = [heap[c], heap[p]]; c = p; } };
    const pop = () => { const top = heap[0]; const last = heap.pop(); if (heap.length) { heap[0] = last; let c = 0; for (;;) { const l = 2 * c + 1, r = l + 1; let m = c; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === c) break; [heap[m], heap[c]] = [heap[c], heap[m]]; c = m; } } return top; };
    const relax = (u, v, w, how) => { const d = dist[u] + w; if (d < dist[v]) { dist[v] = d; prev[v] = u; via[v] = how; push(d, v); } };
    while (heap.length) {
      const [d, u] = pop(); if (d > dist[u]) continue;
      const n = this.nodes[u];
      // lane travel
      for (const t of n.lane) { const m = this.nodes[t]; relax(u, t, Math.hypot(m.x - n.x, m.y - n.y, m.z - n.z) / opt.lane + (via[u] === 2 ? 0 : opt.laneEnter), 2); }
      // jumps
      if (n.jump != null && (n.kind === 'gate' || opt.holes)) relax(u, n.jump, opt.jumpTime, 3);
      // free flight: not from the middle of a lane (you can only leave at the ends)
      if (n.kind === 'ring' && !n.laneEnd && via[u] === 2) continue;
      for (const m of this.bySystem.get(n.sys)) if (m.i !== u) relax(u, m.i, Math.hypot(m.x - n.x, m.y - n.y, m.z - n.z) / opt.cruise, 1);
    }
    const res = { dist, prev, via };
    this.cache.set(key, res);
    return res;
  }
  path(res, toBase) {
    const t = this.baseNode.get(toBase); if (t == null || !res || !isFinite(res.dist[t])) return null;
    const steps = []; for (let i = t; i !== -1; i = res.prev[i]) steps.push(i);
    steps.reverse();
    const systems = []; let jumps = 0, laneDist = 0, flyDist = 0;
    for (let k = 0; k < steps.length; k++) {
      const n = this.nodes[steps[k]];
      if (!systems.length || systems[systems.length - 1] !== n.sys) systems.push(n.sys);
      if (k) { const p = this.nodes[steps[k - 1]]; const how = res.via[steps[k]]; const d = Math.hypot(n.x - p.x, n.y - p.y, n.z - p.z); if (how === 3) jumps++; else if (how === 2) laneDist += d; else flyDist += d; }
    }
    return { time: res.dist[t], systems, jumps, laneDist, flyDist, steps };
  }

  // ---------------------------------------------------------------- routes
  routes(opt, filter = {}, progress = () => { }) { return this.app.whileBusy ? this.app.whileBusy(() => this._routes(opt, filter, progress)) : this._routes(opt, filter, progress); }
  async _routes(opt, filter, progress) {
    const sellers = new Map(); // good -> [entries that sell]
    const buyers = new Map();  // good -> [entries (base buys)]
    for (const list of this.market.values()) for (const m of list) {
      if (!m.commodity || m.unknown || !this.baseNode.has(m.base.toLowerCase())) continue;
      const k = m.good.toLowerCase();
      if (m.sells) { if (!sellers.has(k)) sellers.set(k, []); sellers.get(k).push(m); }
      if (!buyers.has(k)) buyers.set(k, []); buyers.get(k).push(m);
    }
    if (opt.unlisted) for (const [k, list] of buyers) {
      const gd = this.goods.get(k); const have = new Set(list.map(m => m.base.toLowerCase()));
      for (const b of this.baseNode.keys()) if (!have.has(b)) list.push({ base: this.app.game.findBase(b)?.nickname || b, good: gd.nickname, price: Math.floor(gd.price), mult: 1, unlisted: true, sells: false, level: 0, rep: -1 });
    }
    // Index once: sellers by base, buyers with their node + system resolved. Discovery has ~2 million
    // profitable pairs, so candidates go into typed arrays and only the best few hundred per sort column
    // become objects (the table shows the top 300 under whichever column is sorted).
    const sellByBase = new Map();
    for (const [k, sl] of sellers) { if (filter.good && k !== filter.good) continue; for (const s of sl) { const b = s.base.toLowerCase(); if (!sellByBase.has(b)) sellByBase.set(b, []); sellByBase.get(b).push(s); } }
    const buyIdx = new Map();
    for (const [k, list] of buyers) buyIdx.set(k, list.map(by => ({ by, low: by.base.toLowerCase(), node: this.baseNode.get(by.base.toLowerCase()), sys: filter.toSystem ? this.baseSystem(by.base) : '' })).filter(x => x.node != null && (!filter.toSystem || x.sys === filter.toSystem)));
    let cap = 1 << 16, n = 0;
    let pu = new Float64Array(cap), pr = new Float64Array(cap), tm = new Float64Array(cap), pm = new Float64Array(cap), si = new Int32Array(cap), bi = new Int32Array(cap);
    const grow = () => { cap *= 2; const g = (A, T) => { const x = new T(cap); x.set(A); return x; }; pu = g(pu, Float64Array); pr = g(pr, Float64Array); tm = g(tm, Float64Array); pm = g(pm, Float64Array); si = g(si, Int32Array); bi = g(bi, Int32Array); };
    const sellRefs = [], buyRefs = [];
    const srcBases = [...sellByBase.keys()].filter(b => !filter.fromSystem || this.baseSystem(b) === filter.fromSystem);
    let i = 0, lastYield = performance.now();
    for (const b of srcBases) {
      i++; if (performance.now() - lastYield > 50) { progress(`Routing ${i}/${srcBases.length}`); await yieldUi(); lastYield = performance.now(); }
      const res = this.times(b, opt); if (!res) continue;
      for (const s of sellByBase.get(b)) {
        const k = s.good.toLowerCase(), list = buyIdx.get(k); if (!list) continue;
        const units = Math.floor(opt.cargo / this.volume(s.good)); const sIdx = sellRefs.push({ s, units }) - 1;
        for (const x of list) {
          if (x.low === b) continue;
          const p = x.by.price - s.price; if (p <= 0) continue;
          const time = res.dist[x.node]; if (!isFinite(time)) continue;
          if (n === cap) grow();
          if (x.ref == null) x.ref = buyRefs.push(x.by) - 1;
          const total = time + opt.dockTime * 2;
          pu[n] = p; pr[n] = p * units; tm[n] = total; pm[n] = p * units / (total / 60); si[n] = sIdx; bi[n] = x.ref; n++;
        }
      }
    }
    const keep = new Set();
    const top = (A, asc, K = 300) => {
      if (n <= K) { for (let j = 0; j < n; j++) keep.add(j); return; }
      const idx = new Int32Array(n); for (let j = 0; j < n; j++) idx[j] = j;
      // partial selection: threshold from a sorted sample, then exact sort of the survivors
      const v = Float64Array.from(A.subarray(0, n)); v.sort(); const thr = asc ? v[K - 1] : v[n - K];
      const pick = []; for (let j = 0; j < n; j++) if (asc ? A[j] <= thr : A[j] >= thr) pick.push(j);
      pick.sort((x, y) => asc ? A[x] - A[y] : A[y] - A[x]); for (const j of pick.slice(0, K)) keep.add(j);
    };
    top(pm, false); top(pr, false); top(pu, false); top(tm, true);
    const out = [...keep].map(j => { const { s, units } = sellRefs[si[j]]; return { good: s.good, seller: s, buyer: buyRefs[bi[j]], perUnit: pu[j], units, perRun: pr[j], time: tm[j], perMin: pm[j] }; });
    out.total = n;
    return out;
  }
  baseSystem(base) { const b = this.app.game.findBase(base); return b ? (b.system || '').toLowerCase() : ''; }

  // ---------------------------------------------------------------- editing (call inside history.do on m.doc)
  static setFields(m, f) {
    const v = m.entry.values; while (v.length < 7) v.push(['', '0', '-1', '0', '0', '0', '1'][v.length]);
    const map = { good: 0, level: 1, rep: 2, min: 3, max: 4, flag: 5, mult: 6 };
    for (const [k, val] of Object.entries(f)) v[map[k]] = String(val);
    m.entry.value = v.join(', '); m.entry.raw = null;
  }
}

// Let the page repaint without setTimeout, which background tabs clamp to ~1 s per call.
const yieldUi = () => new Promise(r => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });
export function fmtTime(s) { if (!isFinite(s)) return '—'; s = Math.round(s); const m = Math.floor(s / 60); return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m ${String(s % 60).padStart(2, '0')}s`; }
export function fmtCr(n) { return Math.round(n).toLocaleString('en-US'); }
