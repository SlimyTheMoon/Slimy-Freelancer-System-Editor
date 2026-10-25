import { keyIsRead, suggestKey } from './inidocs.js';
// Consistency checks for a system (and its links into universe.ini / other systems).
import { kindOf, getPos } from './system.js';
import { api, dataPath } from './api.js';

export function validateSystem(app, doc) {
  const g = app.game, out = [];
  const add = (sev, sec, msg) => out.push({ sev, id: sec ? sec.id : null, sys: doc.nickname, nick: sec ? sec.get('nickname') : '', msg });
  const seen = new Map();
  for (const s of doc.entities) {
    const n = (s.get('nickname') || '');
    if (!n) { add('err', s, `[${s.name}] has no nickname`); continue; }
    const l = n.toLowerCase();
    if (seen.has(l)) add('err', s, `duplicate nickname "${n}"`); else seen.set(l, s);
  }
  for (const o of doc.objects) {
    const arch = o.get('archetype');
    if (!arch) add('err', o, 'object without archetype');
    else if (!g.arch(arch)) add('err', o, `unknown archetype "${arch}"`);
    if (o.get('star') && !g.stars.get(o.get('star').toLowerCase())) add('err', o, `unknown star "${o.get('star')}"`);
    if (!o.has('pos')) add('warn', o, 'no pos (defaults to 0,0,0)');
    for (const k of ['prev_ring', 'next_ring']) {
      const v = o.get(k); if (!v) continue;
      const t = doc.byNick(v);
      if (!t) add('err', o, `${k} → missing "${v}"`);
      else { const back = t.get(k === 'next_ring' ? 'prev_ring' : 'next_ring'); if (!back || back.toLowerCase() !== (o.get('nickname') || '').toLowerCase()) add('warn', o, `${k} "${v}" does not link back`); }
    }
    const p = o.get('parent'); if (p && !doc.byNick(p)) add('err', o, `parent → missing "${p}"`);
    const base = o.get('base');
    if (base) { const b = g.findBase(base); if (!b) add('err', o, `base "${base}" not in universe.ini`); else if ((b.system || '').toLowerCase() !== doc.nickname.toLowerCase()) add('warn', o, `base "${base}" belongs to system ${b.system}`); }
    const dw = o.get('dock_with'); if (dw && !g.findBase(dw)) add('err', o, `dock_with "${dw}" not in universe.ini`);
    const go = o.vals('goto');
    if (go) {
      if (go.length < 3) add('warn', o, 'goto should be: system, object, tunnel');
      const ts = g.findSystem(go[0]);
      if (!ts) add('err', o, `goto → unknown system "${go[0]}"`);
      else {
        const td = app.systemDocs.get(ts.nickname.toLowerCase());
        if (td) {
          const t = td.byNick(go[1]);
          if (!t) add('err', o, `goto → "${go[1]}" not found in ${ts.nickname}`);
          else { const back = t.vals('goto'); if (!back || back[0].toLowerCase() !== doc.nickname.toLowerCase() || (back[1] || '').toLowerCase() !== (o.get('nickname') || '').toLowerCase()) add('warn', o, `${ts.nickname}/${go[1]} does not jump back here`); }
        }
      }
    }
    const a = g.arch(arch);
    if (a && /JUMP/.test(a.type) && !go) add('warn', o, 'jump gate/hole without goto');
    if (o.get('ids_name') && !g.name(o.get('ids_name'))) add('info', o, `ids_name ${o.get('ids_name')} has no string`);
    const ring = o.vals('ring'); if (ring && !doc.byNick(ring[0])) add('err', o, `ring zone "${ring[0]}" missing`);
  }
  for (const z of doc.zones) {
    const shape = (z.get('shape') || '').toUpperCase();
    if (!['SPHERE', 'ELLIPSOID', 'BOX', 'CYLINDER', 'RING'].includes(shape)) add('err', z, `bad shape "${z.get('shape') || ''}"`);
    const sz = z.vals('size'); if (!sz || sz.some(v => isNaN(parseFloat(v)))) add('err', z, 'missing/invalid size');
    const need = { ELLIPSOID: 3, BOX: 3, CYLINDER: 2, RING: 3 }[shape];
    if (need && sz && sz.length < need) add('warn', z, `${shape} expects ${need} size values`);
  }
  // population / encounters
  const encParams = new Set(doc.ini.all('EncounterParameters').map(s => (s.get('nickname') || '').toLowerCase()));
  const facs = new Set(g.factions.map(f => (f.nickname || '').toLowerCase()));
  for (const z of doc.zones) {
    let lastEnc = null;
    for (const e of z.entries) {
      const k = e.key.toLowerCase(), v = e.values;
      if (k === 'encounter') {
        lastEnc = e;
        if (!encParams.has((v[0] || '').toLowerCase())) add('err', z, `encounter "${v[0]}" has no [EncounterParameters] in this system`);
        const c = parseFloat(v[2]); if (v.length < 3 || isNaN(c) || c < 0 || c > 1) add('warn', z, `encounter "${v[0]}" chance should be 0–1 (is "${v[2] ?? ''}")`);
      } else if (k === 'faction') {
        if (!lastEnc) add('warn', z, `faction "${v[0]}" before any encounter line`);
        if (!facs.has((v[0] || '').toLowerCase())) add('err', z, `unknown faction "${v[0]}"`);
      }
    }
    for (const e of z.findAll('encounter')) { /* each encounter needs at least one faction line after it */
      const i = z.lines.indexOf(e); const next = z.lines.slice(i + 1).find(l => l.type === 'entry' && /^(encounter|faction)$/i.test(l.key));
      if (!next || next.key.toLowerCase() !== 'faction') add('warn', z, `encounter "${e.values[0]}" has no faction line`);
    }
    if (z.has('path_label') && (z.get('shape') || '').toUpperCase() !== 'CYLINDER') add('warn', z, 'path zone is not a CYLINDER');
  }
  for (const s of doc.ini.all('EncounterParameters')) if (!s.get('nickname') || !s.get('filename')) add('err', null, '[EncounterParameters] needs nickname and filename');
  // paths: index gaps / duplicates (labels are per system: vanilla reuses e.g. "outcasts1" in 8 systems)
  const labels = new Map();
  for (const z of doc.zones) { const v = z.vals('path_label'); if (!v || !v[0]) continue; const k = v[0].toLowerCase(); if (!labels.has(k)) labels.set(k, []); labels.get(k).push([parseInt(v[1] || '0', 10), z]); }
  for (const [k, list] of labels) {
    list.sort((a, b) => a[0] - b[0]);
    list.forEach(([n, z], i) => { if (n !== i + 1) add('warn', z, `path "${k}": segment index ${n} where ${i + 1} was expected`); });
  }
  for (const kind of ['Asteroids', 'Nebula']) for (const s of doc.ini.all(kind)) {
    const z = s.get('zone'); if (!z || !doc.byNick(z)) add('err', null, `[${kind}] ${s.get('file') || ''} → zone "${z || ''}" missing`);
  }
  // universe-level
  const uni = doc.sys.section;
  if (!uni.get('strid_name')) add('info', null, 'universe [System] has no strid_name');
  const bases = g.bases.filter(b => (b.system || '').toLowerCase() === doc.nickname.toLowerCase());
  for (const b of bases) if (!doc.objects.some(o => (o.get('base') || '').toLowerCase() === b.nickname.toLowerCase())) add('warn', null, `universe base ${b.nickname} has no object with base = ${b.nickname}`);
  // keys the game never reads (no code looks them up by name). Likely typos are
  // reported per entry; vanilla leftovers (zone sort, pop_type…) once per section/key with a count.
  const unread = new Map();
  for (const s of doc.ini.sections) for (const e of s.entries) {
    if (keyIsRead(s.name, e.key) !== false) continue;
    const sug = suggestKey(s.name, e.key);
    if (sug) { add('warn', s.get('nickname') ? s : null, `[${s.name}] ${e.key}: the game does not read this key — typo for “${sug}”?`); continue; }
    const k = `[${s.name}] ${e.key}`; unread.set(k, (unread.get(k) || 0) + 1);
  }
  for (const [k, n] of unread) add('info', null, `${k}: not read by the game — leftover or editor-only data (${n}×), safe to ignore`);
  const order = { err: 0, warn: 1, info: 2 };
  return out.sort((a, b) => order[a.sev] - order[b.sev]);
}

// async file-existence checks (models, field files, background) — slower, so separate
export async function validateFiles(app, doc) {
  const out = []; const g = app.game;
  const check = async (p, what, sec) => { if (p && !(await api.exists(dataPath(p)))) out.push({ sev: 'err', id: sec ? sec.id : null, sys: doc.nickname, nick: sec ? sec.get('nickname') : '', msg: `${what}: file not found ${p}` }); };
  const bg = doc.ini.first('Background');
  if (bg) for (const k of ['basic_stars', 'complex_stars', 'nebulae']) await check(bg.get(k), `[Background] ${k}`);
  for (const kind of ['Asteroids', 'Nebula']) for (const s of doc.ini.all(kind)) await check(s.get('file'), `[${kind}]`);
  for (const s of doc.ini.all('EncounterParameters')) await check(s.get('filename'), `[EncounterParameters] ${s.get('nickname') || ''}`);
  const archs = new Set(doc.objects.map(o => (o.get('archetype') || '').toLowerCase()));
  for (const a of archs) { const ar = g.arch(a); if (ar && ar.da) await check(ar.da, `archetype ${ar.nickname} DA_archetype`); }
  return out;
}
