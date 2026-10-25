// Balance tables (Tools menu): guns & launchers, shields, thrusters and ships side by side, like the
// community FLStat tool. The derived numbers follow the game's own dealer infocard code
// (Freelancer.exe FUN_00484090, dealer equipment stats):
//   hull damage   = munition hull_damage + explosion hull_damage
//   energy damage = hull damage × HULL_DAMAGE_FACTOR ([ShieldEquipConsts] in constants.ini) + munition + explosion energy_damage
//   range         = munition lifetime × muzzle_velocity; guided (motor lifetime > 0): seeker_range, and
//                   seeker_range + (motor lifetime − delay) × accel + muzzle_velocity
//   refire        = 1 / refire_delay;   thruster "speed" = (max_force + 48000) / 600
// Raw values are edited in place (shared undo history, Ctrl+S); a whole column can be scaled for the
// rows currently shown.
import { h, modal, toast, promptDialog } from './dom.js';
import { dataPath } from '../api.js';

const lc = (s) => (s || '').toLowerCase();
const num = (s, k, d = 0) => { const v = s && s.get(k); const n = parseFloat(v); return isFinite(n) ? n : d; };

export async function balanceTables(app, { tab = 'guns' } = {}) {
  const g = app.game;
  const dget = (k, d) => { const s = g.flIni && g.flIni.first('Data'); const v = s ? s.getAll(k) : []; return v.length ? v : d; };
  const load = async (list) => (await Promise.all(list.map(f => app.otherDoc(dataPath(f))))).filter(Boolean);
  const eqDocs = await load(dget('equipment', []));
  const goodDocs = await load(dget('goods', ['equipment\\goods.ini']));
  const shipDocs = await load(dget('ships', ['ships\\shiparch.ini']));
  const constDoc = await app.otherDoc(dataPath('constants.ini'));
  const hdf = num(constDoc && constDoc.ini.first('ShieldEquipConsts'), 'HULL_DAMAGE_FACTOR', 1);

  let index;
  function reindex() {
    index = new Map(); // "kind:nick" -> {doc, sec}
    for (const d of eqDocs) for (const s of d.ini.sections) { const n = lc(s.get('nickname')); if (n) index.set(`${lc(s.name)}:${n}`, { doc: d, sec: s }); }
    for (const d of goodDocs) for (const s of d.ini.all('Good')) {
      const e = lc(s.get('equipment')), sh = lc(s.get('ship')), cat = lc(s.get('category'));
      if (e) index.set(`good:${e}`, { doc: d, sec: s });
      if (cat === 'shiphull' && sh) index.set(`hull:${sh}`, { doc: d, sec: s });
    }
  }
  reindex();
  const find = (kind, nick) => index.get(`${kind}:${lc(nick)}`) || null;
  const name = (s) => g.name(s.get('ids_name')) || '';
  const level = (types, re) => { for (const t of types) { const m = re.exec(t || ''); if (m) return parseInt(m[2]); } return null; };

  // ---- column helpers: raw editable value or derived read-only value
  const raw = (label, where, key, opts = {}) => ({ label, key, where, edit: true, get: (r) => { const t = r[where]; return t ? num(t.sec, key, NaN) : NaN; }, ...opts });
  const calc = (label, fn, opts = {}) => ({ label, get: fn, ...opts });

  const TABS = {
    guns: {
      title: 'Guns & launchers',
      rows: () => eqDocs.flatMap(d => d.ini.all('Gun').map(s => {
        const mun = find('munition', s.get('projectile_archetype')), expl = mun && find('explosion', mun.sec.get('explosion_arch')), motor = mun && find('motor', mun.sec.get('motor'));
        const types = s.getAll('hp_gun_type');
        const turret = types.some(t => /turret/i.test(t));
        return { nick: s.get('nickname'), name: name(s), gun: { doc: d, sec: s }, mun, expl, motor, good: find('good', s.get('nickname')),
          cls: `${turret ? 'turret' : types.some(t => /torpedo|mine|missile|cm|cruise/i.test(t)) ? 'launcher' : 'gun'} ${level(types, /(gun|turret)_special_(\d+)/i) ?? ''}`.trim(),
          lvl: Math.max(0, ...types.map(t => { const m = /special_(\d+)/i.exec(t || ''); return m ? +m[1] : 0; })) };
      }).filter(r => r.mun)),
      cols: [
        calc('class', (r) => r.cls, { text: true, sortBy: (r) => (r.cls.startsWith('turret') ? 100 : r.cls.startsWith('launcher') ? 200 : 0) + r.lvl }),
        calc('hull dmg', (r) => hull(r)), calc('shield dmg', (r) => energy(r)),
        calc('refire /s', (r) => { const d = num(r.gun.sec, 'refire_delay'); return d > 0 ? 1 / d : 0; }, { dec: 2 }),
        calc('hull DPS', (r) => hull(r) * refire(r), { dec: 0, hi: true }), calc('shield DPS', (r) => energy(r) * refire(r), { dec: 0, hi: true }),
        calc('range', (r) => range(r)[0]), calc('speed', (r) => range(r)[1]),
        calc('energy /s', (r) => num(r.gun.sec, 'power_usage') * refire(r), { dec: 0 }),
        calc('hull dmg / energy', (r) => { const p = num(r.gun.sec, 'power_usage'); return p > 0 ? hull(r) / p : 0; }, { dec: 2 }),
        raw('refire_delay', 'gun', 'refire_delay', { dec: 3 }), raw('power_usage', 'gun', 'power_usage'), raw('muzzle_velocity', 'gun', 'muzzle_velocity'),
        raw('mun hull_damage', 'mun', 'hull_damage', { shared: true }), raw('mun energy_damage', 'mun', 'energy_damage', { shared: true }), raw('mun lifetime', 'mun', 'lifetime', { dec: 2, shared: true }),
        raw('price', 'good', 'price'),
      ],
    },
    shields: {
      title: 'Shields',
      rows: () => eqDocs.flatMap(d => d.ini.all('ShieldGenerator').map(s => {
        const types = [s.get('hp_type')];
        const k = /(fighter|elite|freighter)_shield_special_(\d+)/i.exec(types[0] || '');
        return { nick: s.get('nickname'), name: name(s), sh: { doc: d, sec: s }, good: find('good', s.get('nickname')), cls: k ? `${k[1].toLowerCase()} ${k[2]}` : (types[0] || '').replace(/^hp_/, ''), lvl: k ? +k[2] : 0 };
      })),
      cols: [
        calc('class', (r) => r.cls, { text: true, sortBy: (r) => r.cls }),
        raw('capacity', 'sh', 'max_capacity'), raw('regeneration', 'sh', 'regeneration_rate'), raw('rebuild power', 'sh', 'rebuild_power_draw'),
        raw('constant power', 'sh', 'constant_power_draw'), raw('offline rebuild s', 'sh', 'offline_rebuild_time', { dec: 1 }), raw('offline threshold', 'sh', 'offline_threshold', { dec: 2 }),
        calc('s to full', (r) => { const c = num(r.sh.sec, 'max_capacity'), g2 = num(r.sh.sec, 'regeneration_rate'); return g2 > 0 ? c / g2 : 0; }, { dec: 1 }),
        raw('hit_pts', 'sh', 'hit_pts'), raw('price', 'good', 'price'),
      ],
    },
    thrusters: {
      title: 'Thrusters',
      rows: () => eqDocs.flatMap(d => d.ini.all('Thruster').map(s => ({ nick: s.get('nickname'), name: name(s), th: { doc: d, sec: s }, good: find('good', s.get('nickname')), cls: '' }))),
      cols: [
        calc('dealer speed', (r) => (num(r.th.sec, 'max_force') + 48000) / 600, { dec: 2, hi: true }),
        raw('max_force', 'th', 'max_force'), raw('power_usage', 'th', 'power_usage'), raw('hit_pts', 'th', 'hit_pts'), raw('price', 'good', 'price'),
      ],
    },
    ships: {
      title: 'Ships',
      rows: () => shipDocs.flatMap(d => d.ini.all('Ship').map(s => ({ nick: s.get('nickname'), name: name(s), ship: { doc: d, sec: s }, good: find('hull', s.get('nickname')), cls: s.get('type') || '', lvl: num(s, 'ship_class') }))),
      cols: [
        calc('type', (r) => r.cls, { text: true, sortBy: (r) => r.cls }), raw('ship_class', 'ship', 'ship_class'),
        raw('hit_pts', 'ship', 'hit_pts'), raw('hold_size', 'ship', 'hold_size'), raw('nanobots', 'ship', 'nanobot_limit'), raw('batteries', 'ship', 'shield_battery_limit'),
        raw('mass', 'ship', 'mass'), calc('linear_drag', (r) => num(r.ship.sec, 'linear_drag'), { dec: 1 }),
        calc('steering torque', (r) => vec(r.ship.sec, 'steering_torque'), { text: true }), calc('angular drag', (r) => vec(r.ship.sec, 'angular_drag'), { text: true }),
        raw('hull price', 'good', 'price'),
      ],
    },
  };
  const vec = (s, k) => (s.get(k) || '').split(',').map(x => x.trim()).join(' / ');
  const refire = (r) => { const d = num(r.gun.sec, 'refire_delay'); return d > 0 ? 1 / d : 0; };
  const hull = (r) => num(r.mun.sec, 'hull_damage') + (r.expl ? num(r.expl.sec, 'hull_damage') : 0);
  const energy = (r) => hull(r) * hdf + num(r.mun.sec, 'energy_damage') + (r.expl ? num(r.expl.sec, 'energy_damage') : 0);
  const range = (r) => {
    const mv = num(r.gun.sec, 'muzzle_velocity'), simple = num(r.mun.sec, 'lifetime') * mv;
    if (r.motor && num(r.motor.sec, 'lifetime') > 0) { const sr = num(r.mun.sec, 'seeker_range'); return [sr, sr + (num(r.motor.sec, 'lifetime') - num(r.motor.sec, 'delay')) * num(r.motor.sec, 'accel') + mv]; }
    return [simple, mv];
  };

  // ---- UI
  let cur = tab, q = '', sortCol = null, sortDir = -1, rows = [];
  const tabsEl = h('div', { style: { display: 'flex', gap: '4px' } });
  const search = h('input', { placeholder: 'Filter: name, nickname, class… (several words = all must match)', style: { flex: 1 }, oninput: (e) => { q = lc(e.target.value); renderTable(); } });
  const info = h('span', { style: { color: 'var(--faint)', fontSize: '11px' } });
  const saleOnly = h('input', { type: 'checkbox', onchange: () => renderTable() });
  const tableBox = h('div', { style: { overflow: 'auto', height: '62vh' } });
  const body = h('div', {},
    h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '8px' } }, tabsEl, search, h('label', { style: { fontSize: '12px', whiteSpace: 'nowrap' }, title: 'Only items that have a [Good] entry (a price), i.e. can be bought somewhere' }, saleOnly, ' with price only'), info),
    tableBox,
    h('div', { style: { color: 'var(--faint)', fontSize: '11px', marginTop: '6px' } }, `Numbers as the dealer infocard computes them (HULL_DAMAGE_FACTOR = ${hdf} from constants.ini). Blue columns are INI values: click to edit; the ×-button on a blue column header scales it for all rows shown. “mun …” values are shared by every gun that fires that munition.`));
  const m = modal({ title: 'Balance tables', wide: true, body, onClose: () => app.dialogRefreshers.delete(refresh), buttons: [{ label: 'Close' }, { label: 'Copy as CSV', onClick: () => { copyCsv(); return false; } }, { label: 'Save all (Ctrl+S)', cls: 'primary', onClick: () => { app.save(); return false; } }] });
  m.box.classList.add('xwide');
  const refresh = (e) => { if (e.docs.some(d => eqDocs.includes(d) || goodDocs.includes(d) || shipDocs.includes(d))) { reindex(); renderTable(); } };
  app.dialogRefreshers.add(refresh);

  function renderTabs() {
    tabsEl.innerHTML = '';
    for (const [k, t] of Object.entries(TABS)) tabsEl.append(h('button', { class: 'btn ' + (k === cur ? 'primary' : ''), onclick: () => { cur = k; sortCol = null; renderTabs(); renderTable(); } }, t.title));
  }
  const fmt = (c, v) => c.text ? (v || '') : !isFinite(v) ? '—' : c.dec != null ? v.toFixed(c.dec) : Math.trunc(v).toLocaleString();
  function visibleRows() {
    const T = TABS[cur];
    rows = T.rows();
    if (saleOnly.checked) rows = rows.filter(r => r.good);
    if (q) { const ws = q.split(/\s+/).filter(Boolean); rows = rows.filter(r => { const hay = lc(`${r.name} ${r.nick} ${r.cls}`); return ws.every(w => hay.includes(w)); }); }
    if (sortCol != null) { const c = T.cols[sortCol]; const key = c.sortBy || c.get; rows.sort((a, b) => { const x = key(a), y = key(b); return (typeof x === 'string' ? x.localeCompare(y) : (isFinite(x) ? x : -Infinity) - (isFinite(y) ? y : -Infinity)) * sortDir; }); }
    else rows.sort((a, b) => (a.name || a.nick).localeCompare(b.name || b.nick));
    return rows;
  }
  function renderTable() {
    const T = TABS[cur], R = visibleRows();
    info.textContent = `${R.length} rows`;
    const head = h('tr', {}, h('th', { style: { position: 'sticky', left: 0, background: 'var(--panel)', zIndex: 2 } }, 'item'),
      ...T.cols.map((c, i) => h('th', { style: { cursor: 'pointer', whiteSpace: 'nowrap', color: c.edit ? 'var(--accent)' : c.hi ? '#e3b341' : '' }, title: c.edit ? `${c.key} in [${c.where === 'good' ? 'Good' : c.where}]` : 'derived', onclick: () => { sortDir = sortCol === i ? -sortDir : -1; sortCol = i; renderTable(); } },
        c.label, sortCol === i ? (sortDir < 0 ? ' ▾' : ' ▴') : '',
        c.edit ? h('button', { class: 'btn sm', style: { padding: '0 4px', marginLeft: '4px' }, title: 'Scale this column for all rows shown', onclick: (e) => { e.stopPropagation(); scaleColumn(c, R); } }, '×') : null)));
    const tb = h('tbody');
    for (const r of R.slice(0, 1500)) {
      tb.append(h('tr', {},
        h('td', { style: { position: 'sticky', left: 0, background: 'var(--panel)', whiteSpace: 'nowrap', maxWidth: '260px', overflow: 'hidden', textOverflow: 'ellipsis' }, title: r.nick }, r.name || r.nick, r.name ? h('span', { class: 'sub', style: { marginLeft: '6px', color: 'var(--faint)', fontSize: '10px' } }, r.nick) : null),
        ...T.cols.map(c => {
          const v = c.get(r);
          if (!c.edit) return h('td', { style: { textAlign: c.text ? 'left' : 'right', whiteSpace: 'nowrap', color: c.hi ? '#e3b341' : '' } }, fmt(c, v));
          const t = r[c.where];
          if (!t) return h('td', { style: { textAlign: 'right', color: 'var(--faint)' } }, '—');
          return h('td', { style: { textAlign: 'right' } }, h('input', { value: t.sec.get(c.key) ?? '', style: { width: '78px', textAlign: 'right', background: 'transparent', border: '1px solid transparent', color: 'var(--accent)' },
            onfocus: (e) => (e.target.style.borderColor = 'var(--line2)'), onblur: (e) => (e.target.style.borderColor = 'transparent'),
            onchange: (e) => { const val = e.target.value.trim(); app.history.do(`${c.key} ${r.nick}`, [t.doc], () => { if (val === '') t.sec.remove(c.key); else t.sec.set(c.key, val); }); } }));
        })));
    }
    tableBox.innerHTML = '';
    tableBox.append(h('table', { class: 'grid balance' }, h('thead', {}, head), tb));
  }
  async function scaleColumn(c, R) {
    const targets = new Map(); // unique sections (munitions are shared)
    for (const r of R) { const t = r[c.where]; if (t && t.sec.has(c.key)) targets.set(t.sec, t); }
    if (!targets.size) { toast('No values to scale in the rows shown'); return; }
    const f = parseFloat(await promptDialog(`Scale ${c.label}`, `Multiply ${c.key} in ${targets.size} section(s) by`, '1.1'));
    if (!isFinite(f)) return;
    const docs = [...new Set([...targets.values()].map(t => t.doc))];
    const round = (x, old) => { const dp = (String(old).split('.')[1] || '').length; return dp ? x.toFixed(Math.min(6, Math.max(dp, 2))) : String(Math.round(x)); };
    app.history.do(`Scale ${c.key} ×${f} (${targets.size})`, docs, () => { for (const t of targets.values()) { const old = t.sec.get(c.key); const v = parseFloat(old); if (isFinite(v)) t.sec.set(c.key, round(v * f, old)); } });
    toast(`${c.key} ×${f} on ${targets.size} section(s) — Ctrl+Z to undo`);
  }
  function copyCsv() {
    const T = TABS[cur], R = rows;
    const esc = (x) => /[",\n]/.test(String(x)) ? `"${String(x).replace(/"/g, '""')}"` : String(x);
    const lines = [['name', 'nickname', ...T.cols.map(c => c.label)].map(esc).join(','),
      ...R.map(r => [r.name, r.nick, ...T.cols.map(c => { const v = c.edit ? (r[c.where] ? r[c.where].sec.get(c.key) ?? '' : '') : c.get(r); return typeof v === 'number' ? (isFinite(v) ? +v.toFixed(3) : '') : v; })].map(esc).join(','))];
    navigator.clipboard.writeText(lines.join('\n')).then(() => toast(`${R.length} rows copied as CSV`), () => toast('Clipboard not available'));
  }
  renderTabs(); renderTable();
}
