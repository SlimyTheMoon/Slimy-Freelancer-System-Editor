// Save game viewer/editor. FL .fl saves are "FLS1" + bytes XOR ((“Gene”[i & 3] + i) | 0x80)
// plain-text saves are read as-is.
// Many values are CreateID hashes (ship_archetype, equip, cargo, visit, base/system in some versions):
// they are resolved by hashing every nickname the editor knows.
import { h, modal, toast, overlay } from './dom.js';
import { IniDocument } from '../formats/ini.js';
import { createID } from '../formats/crc.js';
import { dataPath } from '../api.js';
import { loadIni } from '../gamedata.js';

const GENE = [0x47, 0x65, 0x6e, 0x65];
export function flDecode(u8) {
  if (u8.length >= 4 && u8[0] === 0x46 && u8[1] === 0x4c && u8[2] === 0x53 && u8[3] === 0x31) {
    const out = new Uint8Array(u8.length - 4);
    for (let i = 0; i < out.length; i++) out[i] = u8[i + 4] ^ ((GENE[i & 3] + i) | 0x80);
    return { bytes: out, encrypted: true };
  }
  return { bytes: u8, encrypted: false };
}
export function flEncode(u8) {
  const out = new Uint8Array(u8.length + 4); out.set([0x46, 0x4c, 0x53, 0x31]);
  for (let i = 0; i < u8.length; i++) out[i + 4] = u8[i] ^ ((GENE[i & 3] + i) | 0x80);
  return out;
}
// names are stored as hex UTF-16BE ("0050006c…")
const decodeName = (s) => { if (!s || !/^[0-9a-f]+$/i.test(s) || s.length % 4) return s || ''; let o = ''; for (let i = 0; i < s.length; i += 4) o += String.fromCharCode(parseInt(s.slice(i, i + 4), 16)); return o; };
const encodeName = (s) => [...s].map(c => c.charCodeAt(0).toString(16).padStart(4, '0')).join('');

async function hashIndex(app) {
  const g = app.game, map = new Map();
  const add = (n, kind, ids) => { if (n) map.set(createID(n) >>> 0, { nick: n, kind }); if (n && ids) map.names.set(n.toLowerCase(), ids); };
  map.names = new Map();
  for (const n of g.equipIds.keys()) add(n, 'equipment');
  for (const a of g.archetypes.values()) add(a.nickname, 'solar');
  for (const s of g.systems) add(s.nickname, 'system');
  for (const b of g.bases) add(b.nickname, 'base');
  const dget = (k, d) => { const s = g.flIni && g.flIni.first('Data'); const v = s ? s.getAll(k) : []; return v.length ? v : d; };
  const shipFiles = dget('ships', ['ships\\shiparch.ini']), eqFiles = dget('equipment', []);
  const [shipDocs, eqDocs] = await (app.whileBusy || ((fn) => fn())).call(app, () => Promise.all([Promise.all(shipFiles.map(f => loadIni(dataPath(f)))), Promise.all(eqFiles.map(f => loadIni(dataPath(f))))])); // parallel, 3D view paused
  for (const d of shipDocs) { if (d) for (const s of d.all('Ship')) add(s.get('nickname'), 'ship', parseInt(s.get('ids_name') || '0')); }
  for (const d of eqDocs) { if (d) for (const s of d.sections) add(s.get('nickname'), s.name); }
  for (const doc of app.systemDocs.values()) for (const o of doc.objects) add(o.get('nickname'), 'object');
  return map;
}

export async function saveGameViewer(app, preset = null) {
  const file = preset || await new Promise((res) => { const i = document.createElement('input'); i.type = 'file'; i.accept = '.fl,.ini,.txt'; i.onchange = async () => { const f = i.files[0]; res(f ? { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) } : null); }; i.click(); });
  if (!file) return;
  const { bytes, encrypted } = flDecode(file.bytes);
  const ini = IniDocument.fromBytes(bytes, file.name);
  const P = ini.first('Player');
  if (!P) { toast('No [Player] section — not a Freelancer save?'); return; }
  const g = app.game;

  overlay('Resolving nicknames in the save…');
  let H; try { H = await hashIndex(app); } finally { overlay(null); }
  const res = (v) => { if (v == null) return ''; const n = Number(v); if (String(v).trim() !== '' && !isNaN(n)) { const hit = H.get(n >>> 0); if (hit) return hit.nick; } return String(v); };
  const label = (nick) => { if (!nick) return ''; const l = nick.toLowerCase(); const sys = g.findSystem(nick); if (sys) return g.name(sys.strid) || nick; const b = g.findBase(nick); if (b) return g.name(b.strid) || nick; const id = g.equipIds.get(l); if (id) return g.name(id) || nick; const a = g.arch(nick); if (a && a.ids) return g.name(a.ids) || nick; const sid = H.names.get(l); if (sid) return g.name(sid) || nick; return nick; };
  let dirty = false;
  const body = h('div');
  const m = modal({
    title: `Save game · ${file.name}${encrypted ? ' (FLS1 encrypted)' : ''}`, wide: true, body,
    buttons: [{ label: 'Close' },
      { label: 'Download decrypted .ini', onClick: () => { dl(file.name.replace(/\.fl$/i, '') + '_decrypted.ini', ini.toBytes()); return false; } },
      { label: 'Download edited save (.fl)', cls: 'primary', onClick: () => { dl(file.name, encrypted ? flEncode(ini.toBytes()) : ini.toBytes()); dirty = false; toast('Copy it over the original in My Games\\Freelancer\\Accts\\SinglePlayer'); return false; } }],
  });
  m.box.classList.add('xwide');
  const dl = (name, b) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([b])); a.download = name; a.click(); };
  const set = (sec, key, v) => { sec.set(key, String(v)); dirty = true; render(); };
  function render() {
    body.innerHTML = '';
    const num = (key, step = 1) => h('input', { type: 'number', value: P.get(key) || '0', step, style: { width: '140px' }, onchange: (e) => set(P, key, e.target.value) });
    const sys = res(P.get('system')), base = res(P.get('base')), ship = res(P.get('ship_archetype'));
    body.append(h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' } },
      h('div', { class: 'psec' }, h('h3', {}, decodeName(P.get('name')) || '(no name)'),
        h('div', { class: 'kv' },
          h('div', { class: 'k' }, 'rank'), h('div', { class: 'v' }, num('rank')), h('span'),
          h('div', { class: 'k' }, 'money'), h('div', { class: 'v' }, num('money', 1000)), h('span'),
          h('div', { class: 'k' }, 'kills'), h('div', { class: 'v' }, P.get('num_kills') || '0'), h('span'),
          h('div', { class: 'k' }, 'missions'), h('div', { class: 'v' }, `${P.get('num_misn_successes') || 0} won · ${P.get('num_misn_failures') || 0} failed`), h('span'),
          h('div', { class: 'k' }, 'location'), h('div', { class: 'v' }, `${label(sys)}${base ? ' · docked at ' + label(base) : ''}`), h('span'),
          h('div', { class: 'k' }, 'ship'), h('div', { class: 'v' }, `${label(ship)} (${ship})`), h('span'),
          h('div', { class: 'k' }, 'description'), h('div', { class: 'v' }, decodeName(P.get('description')) || '—'), h('span'))),
      (() => {
        const MP = ini.first('mPlayer');
        return h('div', { class: 'psec' }, h('h3', {}, 'Statistics'), MP ? h('div', { class: 'stat' },
          'Systems visited', h('b', {}, String(MP.findAll('sys_visited').length)), 'Bases visited', h('b', {}, String(MP.findAll('base_visited').length)),
          'Cash earned', h('b', {}, Number(MP.get('total_cash_earned') || 0).toLocaleString()), 'Time played', h('b', {}, `${Math.round(parseFloat(MP.get('total_time_played') || '0') / 3600)} h`),
          'Objects visited', h('b', {}, String(P.findAll('visit').length))) : h('div', { class: 'empty' }, 'no [mPlayer]'));
      })()));
    // reputation
    const rep = h('div', { class: 'psec' }, h('h3', {}, 'Reputation'));
    const grid = h('div', { style: { display: 'grid', gridTemplateColumns: '1.4fr 70px 2fr', gap: '3px 8px', alignItems: 'center', fontSize: '12px' } });
    for (const e of P.findAll('house')) {
      const v = parseFloat(e.values[0]) || 0, grp = e.values[1];
      const bar = h('div', { style: { height: '6px', background: 'rgba(255,255,255,0.08)', position: 'relative', borderRadius: '3px' } }, h('div', { style: { position: 'absolute', top: 0, bottom: 0, left: v < 0 ? `${50 + v * 50}%` : '50%', width: `${Math.abs(v) * 50}%`, background: v < -0.6 ? '#e55' : v > 0.6 ? '#5c5' : v < 0 ? '#c96' : '#8bc' } }));
      grid.append(h('div', {}, g.factionName(grp) || grp, h('span', { class: 'sub', style: { marginLeft: '6px', color: 'var(--faint)' } }, grp)),
        h('input', { type: 'number', value: v, step: 0.1, min: -1, max: 1, style: { width: '64px' }, onchange: (ev) => { e.value = `${Math.max(-1, Math.min(1, parseFloat(ev.target.value) || 0))}, ${grp}`; e.raw = null; dirty = true; render(); } }), bar);
    }
    rep.append(grid); body.append(rep);
    // ship equipment + cargo
    const eq = h('div', { class: 'psec' }, h('h3', {}, 'Equipment & cargo'));
    const t = h('table', { class: 'grid' }, h('tbody', {},
      ...P.findAll('equip').map(e => { const n = res(e.values[0]); return h('tr', {}, h('td', {}, label(n)), h('td', { class: 'sub' }, n), h('td', {}, e.values[1] || 'internal')); }),
      ...P.findAll('cargo').map(e => { const n = res(e.values[0]); return h('tr', {}, h('td', {}, label(n)), h('td', { class: 'sub' }, n), h('td', {}, `cargo × ${e.values[1]}`)); })));
    eq.append(t); body.append(eq);
    // visited
    const vs = new Map(); for (const e of P.findAll('visit')) { const n = res(e.values[0]); const hit = H.get(Number(e.values[0]) >>> 0); const k = hit ? hit.kind : 'unknown'; vs.set(k, (vs.get(k) || 0) + 1); }
    body.append(h('div', { class: 'psec' }, h('h3', {}, 'Visit flags by kind'), h('div', { class: 'stat' }, [...vs].flatMap(([k, n]) => [k, h('b', {}, String(n))]))));
    if (dirty) body.prepend(h('div', { class: 'sev-warn', style: { marginBottom: '6px' } }, 'Edited — use "Download edited save (.fl)" and replace the file in My Games\\Freelancer\\Accts\\SinglePlayer (keep a copy of the original).'));
  }
  render();
}

export { encodeName, decodeName };
