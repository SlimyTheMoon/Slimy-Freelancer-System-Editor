// Spawn simulator: what a zone's population actually creates, simulated with the game's own rules
// (Content.dll: Encounters, EncounterParams, Cargo):
//  * zone "encounter = file, level, chance" + the faction lines after it; ApplyDifficulty adds the ship
//    class "diff<level + offset>" (min 1) to every ship_by_class line;
//  * an NPC ship arch fits a line when, for every class of the line, a member of the [ShipClass] of that
//    name (shipclasses.ini) — or the class itself if no such [ShipClass] exists — is in its npc_class list;
//  * a formation's factions = the zone factions (with their weights) whose faction_prop npc_ship list has
//    a fitting arch for every line (BuildFormationFactions); no faction → the formation never spawns;
//  * Populate: encounters are drawn by their chance as weights until one spawns; Spawn draws a permutation
//    by weight and creates its first available unstarred formation; starred formations spawn on every refresh;
//    each formation draws a faction by weight, each line an arch uniformly among the faction's fitting archs
//    (PickFactionShipLineArch) and min + rand·(max − min + 1) ships.
//  * spawn chance per check while nothing is near (RollSpawnChance): (density − ships near)/repop_time, clamped 0…1.
// Not simulated: the player's reputation filter (factions at ≤ −0.6 need the hostile clamp in single
// player), density_restriction counts, relief_time / max_battle_size and times_to_create.
import { h, modal, toast } from './dom.js';
import { dataPath } from '../api.js';
import { loadIni } from '../gamedata.js';

const lc = (s) => (s || '').toLowerCase();
let TABLES = null;
async function tables(app) {
  if (TABLES) return TABLES;
  const g = app.game;
  const dget = (k, d) => { const s = g.flIni && g.flIni.first('Data'); const v = s ? s.getAll(k) : []; return v.length ? v : d; };
  const archs = new Map();
  for (const f of ['missions\\npcships.ini', 'missions\\npcships_test.ini']) {
    const d = await loadIni(dataPath(f)); if (!d) continue;
    for (const s of d.all('NPCShipArch')) { const n = lc(s.get('nickname')); if (!n || archs.has(n)) continue; archs.set(n, { nick: s.get('nickname'), ship: s.get('ship_archetype'), loadout: s.get('loadout'), level: parseInt((s.get('level') || '0').replace(/^\D+/, '')) || 0, classes: new Set((s.get('npc_class') || '').split(',').map(x => lc(x.trim())).filter(Boolean)), pilot: s.get('pilot') }); }
  }
  const shipClasses = new Map();
  { const d = await loadIni(dataPath('missions\\shipclasses.ini')); if (d) for (const s of d.all('ShipClass')) { const n = lc(s.get('nickname')); if (n && !shipClasses.has(n)) shipClasses.set(n, s.getAll('member').map(lc)); } }
  const factions = new Map(); // group -> npc ship arch nicks
  { const d = await loadIni(dataPath('missions\\faction_prop.ini')); let aff = '';
    if (d) for (const s of d.all('FactionProps')) { if (s.get('affiliation')) aff = lc(s.get('affiliation')); if (!aff || factions.has(aff)) continue; factions.set(aff, s.getAll('npc_ship').map(lc)); } }
  const shipNames = new Map();
  for (const f of dget('ships', ['ships\\shiparch.ini'])) { const d = await loadIni(dataPath(f)); if (d) for (const s of d.all('Ship')) shipNames.set(lc(s.get('nickname')), g.name(s.get('ids_name')) || s.get('nickname')); }
  TABLES = { archs, shipClasses, factions, shipNames };
  return TABLES;
}

async function loadEncounter(path) {
  const d = await loadIni(dataPath(path)); if (!d) return null;
  const forms = d.all('EncounterFormation').map(s => ({
    lines: s.entries.filter(e => /^(ship_by_class|ship_by_npc_arch)$/i.test(e.key)).map(e => {
      const v = e.values; return /npc_arch/i.test(e.key) ? { min: parseInt(v[0]) || 0, max: parseInt(v[1]) || 0, arch: lc(v[2]) } : { min: parseInt(v[0]) || 0, max: parseInt(v[1]) || 0, classes: [lc(v[2])], offset: v[3] !== undefined && v[3] !== '' ? parseInt(v[3]) || 0 : 0 };
    }),
    behavior: s.get('behavior') || '', formation: s.get('formation') || s.get('formation_by_class') || '',
    simultaneous: !/^(no|false)$/.test(s.get('allow_simultaneous_creation') || 'true'), times: s.get('times_to_create') || 'infinite',
  }));
  const cr = d.first('Creation');
  let perms = cr ? cr.findAll('permutation').map(e => {
    const v = e.values; const entries = (v[0] || '').split(/[\s+]+/).filter(Boolean).map(t => ({ idx: parseInt(t), star: /\*/.test(t) })).filter(x => !isNaN(x.idx) && x.idx < forms.length);
    return { entries, weight: parseInt(v[1]) || 0 };
  }) : [];
  if (!perms.length) perms = [{ entries: forms.map((_, i) => ({ idx: i, star: false })), weight: 1 }];
  return { forms, perms };
}

const pickW = (items, w) => { let sum = 0; for (const x of items) sum += w(x); if (sum <= 0) return null; let r = Math.random() * sum, run = 0; for (const x of items) { run += w(x); if (r <= run) return x; } return null; };

export async function simulateZone(app, zone, { trials = 2000 } = {}) {
  const T = await tables(app);
  const sysDoc = app.sys;
  const encParams = new Map(sysDoc.ini.all('EncounterParameters').map(s => [lc(s.get('nickname')), s.get('filename')]));
  // zone encounters with their faction lines (the lines directly after each encounter)
  const encs = []; let cur = null;
  for (const e of zone.entries) {
    if (/^encounter$/i.test(e.key)) { const v = e.values; cur = { nick: v[0], level: Math.trunc(parseFloat(v[1]) || 0), chance: parseFloat(v[2]) || 0, factions: [] }; encs.push(cur); }
    else if (/^faction$/i.test(e.key) && cur) cur.factions.push({ group: lc(e.values[0]), weight: parseFloat(e.values[1]) || 0 });
    else cur = null; // the faction list ends at the first other line
  }
  const problems = [];
  const fits = (line, arch) => line.classes.every(c => { const members = T.shipClasses.get(c); return members ? members.some(m => arch.classes.has(m)) : arch.classes.has(c); });
  for (const enc of encs) {
    const file = encParams.get(lc(enc.nick));
    if (!file) { problems.push(`${enc.nick}: no [EncounterParameters] entry in this system`); continue; }
    enc.params = await loadEncounter(file); if (!enc.params) { problems.push(`${enc.nick}: file ${file} not found`); continue; }
    enc.file = file;
    for (const [fi, f] of enc.params.forms.entries()) {
      // ApplyDifficulty: diff<level + offset> joins every class line
      for (const l of f.lines) if (l.classes) l.allClasses = [...l.classes, `diff${Math.max(1, enc.level + l.offset)}`];
      const lineArchs = (group, l) => l.arch ? [T.archs.get(l.arch)].filter(Boolean) : (T.factions.get(group) || []).map(n => T.archs.get(n)).filter(a => a && fits({ classes: l.allClasses }, a));
      // factions allowed for this formation
      f.factions = enc.factions.filter(fw => {
        if (!T.factions.has(fw.group)) return false;
        return f.lines.every(l => l.arch ? (T.factions.get(fw.group) || []).includes(l.arch) : lineArchs(fw.group, l).length > 0); // GetNpcArchFactions / GetShipLineFactions
      });
      f.lineArchs = lineArchs;
      if (!f.factions.length) problems.push(`${enc.nick} formation ${fi}: none of the zone's factions (${enc.factions.map(x => x.group).join(', ') || 'none'}) has an NPC ship for ${f.lines.map(l => l.arch || l.allClasses.join('+')).join(' / ')} — never spawns`);
    }
  }
  // Monte Carlo
  const stat = { trials, spawned: 0, enc: new Map(), fac: new Map(), arch: new Map(), combos: new Map(), ships: 0, starred: new Map() };
  const bump = (m, k, n = 1) => m.set(k, (m.get(k) || 0) + n);
  for (let t = 0; t < trials; t++) {
    const pool = encs.filter(e => e.params);
    let done = false;
    while (!done && pool.length) {
      const enc = pickW(pool, e => e.chance); if (!enc) break;
      const perm = pickW(enc.params.perms, p => p.weight); if (!perm) { pool.splice(pool.indexOf(enc), 1); continue; }
      for (const en of perm.entries) {
        if (en.star) continue;
        const f = enc.params.forms[en.idx];
        const fac = pickW(f.factions, x => x.weight); if (!fac) continue;
        const ships = []; let ok = true;
        for (const l of f.lines) {
          const cands = f.lineArchs(fac.group, l); if (!cands.length) { ok = false; break; }
          const arch = cands[Math.floor(Math.random() * cands.length)];
          const n = l.min + Math.floor(Math.random() * (l.max - l.min + 1));
          for (let i = 0; i < n; i++) ships.push(arch);
        }
        if (!ok || !ships.length) continue;
        stat.spawned++; bump(stat.enc, enc.nick); bump(stat.fac, fac.group); stat.ships += ships.length;
        for (const a of ships) bump(stat.arch, a.nick);
        const combo = Object.entries(ships.reduce((m, a) => (m[a.nick] = (m[a.nick] || 0) + 1, m), {})).map(([k, v]) => `${v}× ${k}`).join(' + ');
        bump(stat.combos, `${fac.group} · ${combo}`);
        done = true; break;
      }
      if (!done) pool.splice(pool.indexOf(enc), 1);
    }
    // starred formations of every encounter (spawned on each refresh)
    for (const enc of encs) if (enc.params) for (const p of enc.params.perms) for (const en of p.entries) if (en.star) bump(stat.starred, `${enc.nick} #${en.idx}`);
  }
  const density = parseFloat(zone.get('density') || '0'), repop = parseFloat(zone.get('repop_time') || '0');
  return { encs, problems, stat, density, repop, checkChance: repop > 0 ? Math.max(0, Math.min(1, density / repop)) : (density > 0 ? 1 : 0), T };
}

export async function spawnSimulator(app, zone) {
  if (!zone) { const s = app.selected()[0]; if (s && s.is('Zone')) zone = s; }
  const zones = app.sys.zones.filter(z => z.findAll('encounter').length);
  if (!zones.length) { toast('This system has no zone with encounters'); return; }
  if (!zone || !zone.findAll('encounter').length) zone = zones[0];
  const zoneSel = h('select', { onchange: (e) => { zone = zones.find(z => z.get('nickname') === e.target.value); run(); } }, ...zones.map(z => h('option', { value: z.get('nickname'), selected: z === zone }, z.get('nickname'))));
  const trialsSel = h('select', { onchange: () => run() }, ...[500, 2000, 10000].map(n => h('option', { value: n, selected: n === 2000 }, `${n.toLocaleString()} spawns`)));
  const out = h('div', { style: { overflow: 'auto', height: '64vh', fontSize: '12px' } });
  const m = modal({ title: 'Spawn simulator', wide: true, body: h('div', {}, h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '8px' } }, 'zone', zoneSel, trialsSel, h('button', { class: 'btn', onclick: () => run() }, '↻ Run again'), h('span', { style: { flex: 1 } }), h('span', { style: { color: 'var(--faint)', fontSize: '11px' } }, 'Rules: Content.dll encounter code')), out), buttons: [{ label: 'Close' }] });
  m.box.classList.add('xwide');
  async function run() {
    out.replaceChildren(h('div', { class: 'empty' }, 'Simulating…'));
    const r = await simulateZone(app, zone, { trials: parseInt(trialsSel.value) });
    const g = app.game, S = r.stat, pct = (n, d = S.trials) => d ? `${(100 * n / d).toFixed(1)} %` : '—';
    const facName = (grp) => g.factionName(grp) || grp;
    const bar = (frac, col = 'var(--accent)') => h('div', { style: { height: '6px', background: 'rgba(255,255,255,0.06)', borderRadius: '3px', width: '160px' } }, h('div', { style: { height: '6px', width: `${Math.round(frac * 100)}%`, background: col, borderRadius: '3px' } }));
    const table = (rows) => h('table', { class: 'grid' }, h('tbody', {}, ...rows));
    out.innerHTML = '';
    out.append(h('div', { class: 'psec' }, h('h3', {}, `${zone.get('nickname')}`),
      h('div', { class: 'stat' }, 'density', h('b', {}, String(r.density)), 'repop_time', h('b', {}, `${zone.get('repop_time') || '—'} s`), 'spawn chance per check (nothing near)', h('b', {}, pct(r.checkChance, 1)),
        'encounters', h('b', {}, String(r.encs.length)), 'ships per spawn (average)', h('b', {}, S.spawned ? (S.ships / S.spawned).toFixed(1) : '—'), 'spawns that produce something', h('b', {}, pct(S.spawned)))));
    if (r.problems.length) out.append(h('div', { class: 'psec' }, h('h3', {}, 'Problems'), ...r.problems.map(p => h('div', { class: 'sev-warn' }, p))));
    out.append(h('div', { class: 'psec' }, h('h3', {}, 'Encounters'), table(r.encs.map(e => h('tr', {}, h('td', {}, e.nick, h('span', { class: 'sub', style: { color: 'var(--faint)', marginLeft: '6px' } }, `level ${e.level} · chance ${e.chance}`)), h('td', {}, bar((S.enc.get(e.nick) || 0) / S.trials)), h('td', { style: { textAlign: 'right' } }, pct(S.enc.get(e.nick) || 0)),
      h('td', { class: 'sub', style: { color: 'var(--faint)' } }, e.params ? e.params.forms.map(f => f.lines.map(l => `${l.min === l.max ? l.min : l.min + '–' + l.max}× ${l.arch || l.allClasses.join('+')}`).join(', ')).join(' | ') : 'missing'))))));
    out.append(h('div', { class: 'psec' }, h('h3', {}, 'Factions'), table([...S.fac].sort((a, b) => b[1] - a[1]).map(([k, n]) => h('tr', {}, h('td', {}, facName(k), h('span', { class: 'sub', style: { color: 'var(--faint)', marginLeft: '6px' } }, k)), h('td', {}, bar(n / S.trials, '#5fd38d')), h('td', { style: { textAlign: 'right' } }, pct(n)))))));
    out.append(h('div', { class: 'psec' }, h('h3', {}, 'Ships (share of all ships spawned)'), table([...S.arch].sort((a, b) => b[1] - a[1]).map(([k, n]) => { const a = r.T.archs.get(lc(k)); return h('tr', {}, h('td', {}, r.T.shipNames.get(lc(a && a.ship)) || (a && a.ship) || k, h('span', { class: 'sub', style: { color: 'var(--faint)', marginLeft: '6px' } }, k)), h('td', {}, a ? `d${a.level}` : ''), h('td', { class: 'sub' }, a ? a.loadout : ''), h('td', {}, bar(n / S.ships, '#e3b341')), h('td', { style: { textAlign: 'right' } }, pct(n, S.ships))); }))));
    out.append(h('div', { class: 'psec' }, h('h3', {}, 'Most common groups'), table([...S.combos].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, n]) => { const [grp, combo] = k.split(' · '); return h('tr', {}, h('td', {}, facName(grp)), h('td', { style: { fontFamily: 'var(--mono)', fontSize: '11px' } }, combo), h('td', { style: { textAlign: 'right' } }, pct(n))); }))));
    if (S.starred.size) out.append(h('div', { class: 'psec' }, h('h3', {}, 'Starred formations (spawn on every refresh, in addition)'), ...[...S.starred.keys()].map(k => h('div', {}, k))));
    out.append(h('div', { style: { color: 'var(--faint)', fontSize: '11px', marginTop: '6px' } }, 'Not simulated: factions hostile to the player (≤ −0.6) only spawn in single player when the mission allows hostile ships; density_restriction, relief_time, max_battle_size and times_to_create limit spawns further in the game.'));
  }
  run();
}
