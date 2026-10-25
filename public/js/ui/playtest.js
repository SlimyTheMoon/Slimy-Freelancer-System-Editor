// Playtest here (Tools menu, F5): writes a single-player save that starts in the system being edited —
// in space next to the selected object (or at the camera), with a chosen ship and equipment — and can start
// Freelancer. When the game exits, its log (FLSpew.txt) goes straight into the crash & log analyser.
// The save is built from the game's own new-game template EXE\newplayer.fl; the [Player] keys follow
// the save reader PlayerData_LoadSaveRecord.
import * as THREE from 'three';
import { h, modal, toast } from './dom.js';
import { api, dataPath } from '../api.js';
import { IniDocument, IniEntry } from '../formats/ini.js';
import { loadIni } from '../gamedata.js';
import { flDecode } from './savegame.js';
import { searchPicker, pickerFor } from './picker.js';

const lc = (s) => (s || '').toLowerCase();
const hexName = (s) => [...s].map(c => c.charCodeAt(0).toString(16).padStart(4, '0')).join('');

export async function playtest(app) {
  const g = app.game;
  if (!app.sys) { toast('Open a system first'); return; }
  const tpl = await api.read('EXE/newplayer.fl');
  if (!tpl) { toast('EXE\\newplayer.fl (the new-game template) was not found'); return; }
  // ships with names, and the dealer package of each hull (what the player gets when buying it)
  const dget = (k, d) => { const s = g.flIni && g.flIni.first('Data'); const v = s ? s.getAll(k) : []; return v.length ? v : d; };
  const ships = new Map();
  for (const f of dget('ships', ['ships\\shiparch.ini'])) { const d = await loadIni(dataPath(f)); if (d) for (const s of d.all('Ship')) if (s.get('nickname')) ships.set(lc(s.get('nickname')), { nick: s.get('nickname'), name: g.name(s.get('ids_name')) || '' }); }
  const goods = []; for (const f of dget('goods', ['equipment\\goods.ini'])) { const d = await loadIni(dataPath(f)); if (d) goods.push(...d.all('Good')); }
  const packageOf = (shipNick) => {
    const hull = goods.find(s => lc(s.get('category')) === 'shiphull' && lc(s.get('ship')) === lc(shipNick)); if (!hull) return null;
    const pkg = goods.find(s => lc(s.get('category')) === 'ship' && lc(s.get('hull')) === lc(hull.get('nickname'))); if (!pkg) return null;
    return pkg.findAll('addon').map(e => e.values); // item, hardpoint, count
  };
  const saves = await fetch('/api/saves').then(r => r.ok ? r.json() : null).catch(() => null);

  const sel = app.selected()[0];
  const bases = app.sys.objects.filter(o => o.get('base')).map(o => ({ nick: o.get('base'), obj: o, name: g.name(o.get('ids_name')) || o.get('nickname') }));
  const st = { where: sel ? 'object' : 'camera', dist: 1500, ship: 'li_elite', equip: 'package', loadout: '', money: 100000, rank: 10, story: 'free', unlock: true, saveName: 'FLEditorPlaytest.fl', lastBase: '' };
  if (!ships.has(st.ship)) st.ship = [...ships.values()][0].nick;
  const near = (p) => { let best = null, bd = Infinity; for (const b of bases) { const q = b.obj.vec('pos', [0, 0, 0]); const d = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]); if (d < bd) { bd = d; best = b; } } return best; };

  // spawn point and orientation (FL rotate = Euler degrees, applied X→Y→Z: three.js order 'ZYX'; ships fly along −Z)
  function spawn() {
    const cam = app.viewport.camera.position.clone();
    let pos, target;
    if (st.where === 'object' && sel) {
      const o = new THREE.Vector3(...sel.vec('pos', [0, 0, 0]));
      const dir = cam.clone().sub(o); if (dir.lengthSq() < 1) dir.set(0, 0, 1); dir.normalize();
      pos = o.clone().addScaledVector(dir, st.dist); target = o;
    } else { pos = cam; const f = new THREE.Vector3(); app.viewport.camera.getWorldDirection(f); target = cam.clone().add(f); }
    const m = new THREE.Matrix4().lookAt(pos, target, new THREE.Vector3(0, 1, 0));
    const e = new THREE.Euler().setFromRotationMatrix(m, 'ZYX');
    const deg = (r) => Math.round(r * 180 / Math.PI * 10) / 10;
    return { pos: [pos.x, pos.y, pos.z].map(v => Math.round(v)), rot: [deg(e.x), deg(e.y), deg(e.z)] };
  }

  function buildSave() {
    const ini = IniDocument.fromBytes(flDecode(tpl).bytes, 'newplayer.fl');
    const P = ini.first('Player');
    const sp = spawn();
    const sysNick = app.sys.sys.nickname;
    const label = st.where === 'object' && sel ? `${g.name(sel.get('ids_name')) || sel.get('nickname')}` : 'camera';
    P.set('description', hexName(`Playtest ${sysNick} – ${label}`.slice(0, 60))); P.remove('Description');
    P.set('system', sysNick); P.remove('base'); P.remove('location');
    const lb = st.lastBase || (near(sp.pos) || {}).nick; if (lb) P.set('last_base', lb);
    P.set('pos', sp.pos.join(', ')); P.set('rotate', sp.rot.join(', '));
    P.set('money', String(Math.round(st.money))); P.set('rank', String(Math.round(st.rank)));
    P.set('ship_archetype', st.ship);
    if (st.equip !== 'template') {
      let items = [];
      if (st.equip === 'package') items = (packageOf(st.ship) || []).map(([it, hp, n]) => ({ it, hp: hp && !/^internal$/i.test(hp) ? hp : '', n: parseInt(n || '1') }));
      else { const L = g.loadoutEquip.get(lc(st.loadout)) || []; items = L.map(([it, hp]) => ({ it, hp: hp || '', n: 1 })); }
      P.lines = P.lines.filter(l => !(l.type === 'entry' && /^(equip|cargo)$/i.test(l.key)));
      const isAmmoOrCargo = (it) => /_ammo$|commodity_|_battery|_repair|nanobot|shield_?bat/i.test(it);
      for (const x of items) {
        if (!x.hp && isAmmoOrCargo(x.it)) P.lines.push(new IniEntry('cargo', `${x.it}, ${x.n}`));
        else P.lines.push(new IniEntry('equip', x.hp ? `${x.it}, ${x.hp}` : x.it));
      }
    }
    if (st.story === 'free') {
      const S = ini.first('StoryInfo'); if (S) { S.set('Mission', 'No_Mission'); S.set('MissionNum', '41'); }
      const M = ini.first('mPlayer');
      if (M && st.unlock) M.lines = M.lines.filter(l => !(l.type === 'entry' && /^locked_gate$/i.test(l.key)));
      if (M) { M.set('can_dock', 'true'); M.set('can_tl', 'true'); }
    }
    return ini;
  }

  // ---- UI
  const preview = h('pre', { style: { maxHeight: '220px', overflow: 'auto', fontSize: '11px', background: 'rgba(255,255,255,0.03)', padding: '6px', borderRadius: '4px', margin: 0 } });
  const runInfo = h('div', { style: { fontSize: '12px', marginTop: '6px' } });
  const field = (label, el, note = '') => h('div', { style: { display: 'grid', gridTemplateColumns: '150px 1fr', gap: '8px', alignItems: 'center', margin: '5px 0' } }, h('span', { style: { color: 'var(--dim)' } }, label), h('div', {}, el, note ? h('span', { style: { color: 'var(--faint)', fontSize: '11px', marginLeft: '6px' } }, note) : null));
  const upd = () => { try { preview.textContent = buildSave().first('Player').text('\n').split('\n').filter(l => !/^\s*(house|log|;)/i.test(l)).slice(0, 40).join('\n'); } catch (e) { preview.textContent = 'Error: ' + e.message; } };
  const shipBtn = h('button', { class: 'btn', onclick: async () => { const v = await searchPicker(app, { title: 'Ship', items: [...ships.values()].map(s => ({ value: s.nick, label: s.name, sub: packageOf(s.nick) ? 'has dealer package' : '' })), current: st.ship }); if (v) { st.ship = v; shipBtn.textContent = label(); upd(); } } });
  const label = () => { const s = ships.get(lc(st.ship)); return s ? `${s.name || s.nick} (${s.nick})` : st.ship; };
  shipBtn.textContent = label();
  const loadBtn = h('button', { class: 'btn', onclick: async () => { const cfg = await pickerFor(app, 'loadout', null); const v = await searchPicker(app, { ...cfg, current: st.loadout }); if (v) { st.loadout = v; st.equip = 'loadout'; eqSel.value = 'loadout'; loadBtn.textContent = v; upd(); } } }, 'pick loadout…');
  const eqSel = h('select', { onchange: (e) => { st.equip = e.target.value; upd(); } }, h('option', { value: 'package' }, 'the ship\'s dealer package'), h('option', { value: 'loadout' }, 'a loadout'), h('option', { value: 'template' }, 'new-game starter equipment'));
  const num = (k, step) => h('input', { type: 'number', value: st[k], step, style: { width: '120px' }, oninput: (e) => { st[k] = parseFloat(e.target.value) || 0; upd(); } });
  const whereSel = h('select', { onchange: (e) => { st.where = e.target.value; upd(); } },
    sel ? h('option', { value: 'object', selected: st.where === 'object' }, `next to ${g.name(sel.get('ids_name')) || sel.get('nickname')}`) : null,
    h('option', { value: 'camera', selected: st.where === 'camera' }, 'at the camera, looking where it looks'));
  const baseSel = h('select', { onchange: (e) => { st.lastBase = e.target.value; upd(); } }, h('option', { value: '' }, 'nearest base'), ...bases.map(b => h('option', { value: b.nick }, b.name)));
  const storySel = h('select', { onchange: (e) => { st.story = e.target.value; upd(); } }, h('option', { value: 'free' }, 'free roam: no story mission'), h('option', { value: 'story' }, 'new-game story (Mission 1 runs)'));
  const unlock = h('input', { type: 'checkbox', checked: st.unlock, onchange: (e) => { st.unlock = e.target.checked; upd(); } });
  const nameIn = h('input', { value: st.saveName, style: { width: '220px' }, oninput: (e) => { st.saveName = e.target.value; } });
  const body = h('div', {},
    h('div', { style: { color: 'var(--dim)', fontSize: '12px', marginBottom: '6px' } }, `Writes a save that starts in ${g.name(app.sys.sys.strid) || app.sys.sys.nickname} (${app.sys.sys.nickname}). In Freelancer: Load Game → “Playtest …”. Save your edits (Ctrl+S) first.`),
    field('start', whereSel), field('distance (m)', num('dist', 100), 'from the object, towards the camera'),
    field('ship', shipBtn), field('equipment', h('span', {}, eqSel, ' ', loadBtn)),
    field('money / rank', h('span', {}, num('money', 1000), ' ', num('rank', 1))),
    field('respawn base', baseSel, 'last_base: where you respawn after dying'),
    field('story', storySel), field('', h('label', {}, unlock, ' unlock all jump gates / holes')),
    field('save file', nameIn, saves ? `in ${saves.dir}` : 'save folder not found'),
    h('div', { style: { color: 'var(--faint)', fontSize: '11px', margin: '6px 0 2px' } }, '[Player] preview (reputation lines hidden)'), preview, runInfo);
  const m = modal({
    title: 'Playtest here', wide: true, body, buttons: [{ label: 'Close' },
      { label: 'Pre-flight check…', onClick: () => { import('./preflight.js').then(p => p.preflight(app)); return false; } },
      { label: 'Write save', onClick: async () => { await write(); return false; } },
      { label: 'Write save & start Freelancer', cls: 'primary', onClick: async () => { if (await write()) await launch(); return false; } }],
  });
  if (!saves) runInfo.append(h('div', { class: 'sev-warn' }, 'The save folder (Documents\\My Games\\Freelancer\\Accts\\SinglePlayer) was not found: start Freelancer once and create a save, or use "Download" below.'), h('button', { class: 'btn sm', onclick: () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([buildSave().toBytes()])); a.download = st.saveName; a.click(); } }, 'Download save file'));
  upd();

  async function write() {
    if (app.history.dirty.size) toast(`${app.history.dirty.size} file(s) have unsaved edits — the game only sees saved files (Ctrl+S)`, 5000);
    const name = (st.saveName || 'FLEditorPlaytest.fl').replace(/[^\w.-]/g, '_').replace(/(\.fl)?$/i, '.fl');
    const r = await fetch('/api/savefile?name=' + encodeURIComponent(name), { method: 'POST', body: buildSave().toBytes() });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { toast('Could not write the save: ' + (j.error || r.status), 5000); return false; }
    runInfo.replaceChildren(h('div', { class: 'sev-info' }, `Save written: ${j.path}`));
    return true;
  }
  async function launch() {
    const r = await fetch('/api/launch', { method: 'POST', body: JSON.stringify({}) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { toast('Could not start Freelancer: ' + (j.error || r.status), 5000); return; }
    const line = h('div', {}, `Freelancer started (process ${j.pid}). Load Game → “Playtest …”. The log is analysed when the game closes.`);
    runInfo.append(line);
    const poll = setInterval(async () => {
      const s = await fetch('/api/launch?pid=' + j.pid).then(x => x.json()).catch(() => null);
      if (!s || s.running) return;
      clearInterval(poll);
      line.textContent = `Freelancer closed${s.code ? ` with exit code ${s.code} (0x${(s.code >>> 0).toString(16)})` : ''}.`;
      runInfo.append(h('button', { class: 'btn', onclick: () => import('./crash.js').then(mm => mm.crashAnalyzer(app, { loadSpew: true })) }, 'Analyse the game log'));
      if (s.code) import('./crash.js').then(mm => mm.crashAnalyzer(app, { loadSpew: true }));
    }, 2000);
  }
}
