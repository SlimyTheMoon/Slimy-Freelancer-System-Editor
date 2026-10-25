// Server tools (Tools menu): multiplayer in one place.
//   Server   — freelancer.ini [Server] (name, description, death penalty), the server-side libraries from
//              dacomsrv.ini (FLHook, FLSharp…) and FLHook plugins in EXE\plugins; start FLServer.exe.
//   New players — DATA\CHARACTERS\newcharacter.ini ([Faction] start options, [Package] ship/loadout/money, [Pilot])
//              checked against the game data, and the starting reputations ("house = value, faction") of
//              EXE\mpnewcharacter.fl.
//   Multiplayer saves — characters in My Games\Freelancer\Accts\MultiPlayer, opened in the save editor.
//   Server / client files — the files you changed, sorted by where they must go: the server and every client
//              (gameplay data has to match), clients only (art, sound, texts, cutscenes) or the server only
//              (FLHook and server DLLs, new-character files); a zip for each.
import { h, modal, toast, confirmDialog } from './dom.js';
import { api, dataPath } from '../api.js';
import { writeZip } from '../formats/zip.js';

const lc = (s) => String(s || '').toLowerCase();
const CLIENT_ONLY = /\.(cmp|3db|mat|txm|sph|dfm|anm|ale|vms|utf|wav|mp3|ogg|thn|bmp|tga|dds|png|jpg|ttf|txt|wmv|rdl)$|^data\/(interface|audio|fx|intro|scripts)\//i;
const SERVER_ONLY = /^exe\/(flhook|plugins\/|flserver|server\.dll|dacomsrv\.ini|serverresources\.dll|remoteserver\.dll|mpnewcharacter\.fl)/i;
export function fileRole(app, path) {
  const p = lc(path).replace(/\\/g, '/');
  if (SERVER_ONLY.test(p)) return 'server';
  if (/^exe\/.*\.dll$/.test(p)) return (app.game.resourceDlls || []).some(d => lc(d).split(/[\\/]/).pop() === p.split('/').pop()) ? 'client' : 'both';
  if (CLIENT_ONLY.test(p)) return 'client';
  return 'both';
}

export async function serverTools(app, { tab: startTab = 'server' } = {}) {
  const g = app.game;
  let tab = startTab;
  const bodyRoot = h('div', { style: { fontSize: '13px', minHeight: '60vh' } });
  let token = 0;
  const tabs = h('div', { class: 'btnrow', style: { marginBottom: '8px' } });
  const TABS = { server: 'Server', players: 'New players', saves: 'Multiplayer saves', files: 'Server / client files' };
  const renderTabs = () => { tabs.innerHTML = ''; for (const [k, v] of Object.entries(TABS)) tabs.append(h('button', { class: 'btn sm' + (tab === k ? ' primary' : ''), onclick: () => { tab = k; renderTabs(); render(); } }, v)); };
  const refresh = () => render();
  app.dialogRefreshers.add(refresh);
  modal({ title: 'Server tools', wide: true, body: h('div', {}, tabs, bodyRoot), onClose: () => app.dialogRefreshers.delete(refresh), buttons: [{ label: 'Close' }] }).box.classList.add('xwide');
  renderTabs(); render();

  // each tab renders into its own container, shown only if it is still the current tab when done
  async function render() {
    const my = ++token, el = h('div');
    try { await ({ server: renderServer, players: renderPlayers, saves: renderSaves, files: renderFiles })[tab](el); }
    catch (e) { console.error(e); el.append(h('div', { style: { color: '#ff8a65' } }, 'Failed: ' + e.message)); }
    if (my === token) { bodyRoot.innerHTML = ''; bodyRoot.append(el); }
  }

  // ------------------------------------------------------------ server
  async function renderServer(body) {
    const fl = await app.otherDoc('EXE/freelancer.ini');
    const srv = fl && fl.ini.first('Server');
    const field = (key, help, width = '100%') => {
      const e = srv && srv.findAll(key)[0];
      const inp = h('input', { value: e ? e.value : '', placeholder: '(not set)', style: { width } , onchange: () => app.history.do(`Server ${key}`, [fl], () => { const v = inp.value.trim(); if (!v) srv.remove(key); else srv.set(key, v); }) });
      return [h('label', {}, key), inp, h('div', { class: 'help' }, help)];
    };
    body.append(h('h3', { style: { margin: '0 0 6px' } }, 'freelancer.ini [Server]'),
      srv ? h('div', { class: 'form' }, ...field('name', 'Server name in the server list (FLServer also asks for it when it starts)'), ...field('description', 'Description in the server list'), ...field('death_penalty', 'Percentage of cargo (commodities and unmounted equipment) lost at death', '90px'))
        : h('div', { style: { color: 'var(--faint)' } }, 'freelancer.ini has no [Server] section.'));
    const ds = await app.otherDoc('EXE/dacomsrv.ini');
    const libs = ds && ds.ini.first('Libraries') ? ds.ini.first('Libraries').lines.filter(l => l.type === 'entry' || (l.raw && l.raw.trim() && !l.raw.trim().startsWith(';'))).map(l => l.type === 'entry' ? l.key : l.raw.trim()) : [];
    const plugins = (await api.ls('EXE/plugins').catch(() => [])).filter(f => !f.dir && /\.dll$/i.test(f.name)).map(f => f.name);
    const mp = fl && fl.ini.first('Initial MP DLLs');
    body.append(h('h3', { style: { margin: '14px 0 6px' } }, 'What the server loads'),
      h('div', {}, h('b', {}, 'dacomsrv.ini [Libraries]: '), libs.length ? libs.join(', ') : '—', libs.some(l => /flhook/i.test(l)) ? h('span', { style: { color: '#7ee787' } }, '  · FLHook is active') : null),
      h('div', { style: { marginTop: '4px' } }, h('b', {}, `FLHook plugins (EXE\\plugins, ${plugins.length}): `), plugins.length ? plugins.join(', ') : '—'),
      mp ? h('div', { style: { marginTop: '4px', color: 'var(--dim)' } }, h('b', {}, '[Initial MP DLLs]: '), mp.entries.filter(e => /^dll$/i.test(e.key)).map(e => e.value.split(';')[0].trim()).join(' · ')) : null,
      h('div', { class: 'btnrow', style: { marginTop: '12px' } },
        h('button', { class: 'btn primary', onclick: async () => {
          if (app.history.dirty.size && await confirmDialog('Unsaved changes', 'Save your changes first so the server uses them?', 'Save')) await app.save();
          const r = await fetch('/api/launch', { method: 'POST', body: JSON.stringify({ target: 'server' }) }).then(x => x.json()).catch(e => ({ error: e.message }));
          toast(r.error ? 'Could not start FLServer: ' + r.error : 'FLServer started (pid ' + r.pid + ') — connect from Freelancer via Multiplayer → your server', 6000);
        } }, '▶ Start FLServer'),
        h('button', { class: 'btn', onclick: () => { tab = 'files'; renderTabs(); render(); } }, 'Which changed files does the server need?')),
      h('p', { style: { color: 'var(--faint)', fontSize: '12px' } }, 'FLHook\'s own settings and the plugin settings are not edited here; FLServer keeps its server name and password in its own window.'));
  }

  // ------------------------------------------------------------ new players
  async function renderPlayers(body) {
    const nc = await app.otherDoc(dataPath('CHARACTERS\\newcharacter.ini'));
    const mpc = await app.otherDoc('EXE/mpnewcharacter.fl');
    const ships = new Set(), loadouts = new Set(g.loadouts.map(l => lc(l.nickname || l)));
    for (const f of ((g.flIni && g.flIni.first('Data')) ? g.flIni.first('Data').getAll('ships') : ['ships\\shiparch.ini'])) { const d = await app.otherDoc(dataPath(f)); if (d) for (const s of d.ini.all('Ship')) ships.add(lc(s.get('nickname'))); }
    const groups = new Set(g.factions.map(f => lc(f.nickname)));
    if (nc) {
      const packages = nc.ini.all('Package'), pilots = nc.ini.all('Pilot'), facs = nc.ini.all('Faction');
      const pk = new Set(packages.map(s => lc(s.get('nickname')))), pl = new Set(pilots.map(s => lc(s.get('nickname'))));
      const edit = (doc, sec, key) => { const inp = h('input', { value: sec.get(key) || '', style: { width: '100%' }, onchange: () => app.history.do(`newcharacter ${key}`, [doc], () => sec.set(key, inp.value.trim())) }); return inp; };
      const bad = (ok, title) => ok ? null : h('span', { style: { color: '#ff8a65' }, title }, ' ⚠');
      body.append(h('h3', { style: { margin: '0 0 6px' } }, 'Start options (newcharacter.ini [Faction])'),
        h('table', { class: 'grid' }, h('tr', {}, ['option', 'reputation group', 'start base', 'package', 'pilot'].map(t => h('th', {}, t))),
          facs.map(s => h('tr', {}, h('td', {}, s.get('nickname')),
            h('td', {}, edit(nc, s, 'rep_group'), bad(groups.has(lc(s.get('rep_group'))), 'not a faction in initialworld.ini')),
            h('td', {}, edit(nc, s, 'base'), bad(g.findBase(s.get('base')), 'not a base in universe.ini'), h('div', { style: { color: 'var(--faint)', fontSize: '11px' } }, g.name((g.findBase(s.get('base')) || {}).strid) || '')),
            h('td', {}, edit(nc, s, 'Package'), bad(pk.has(lc(s.get('Package'))), 'no such [Package]')),
            h('td', {}, edit(nc, s, 'Pilot'), bad(pl.has(lc(s.get('Pilot'))), 'no such [Pilot]'))))),
        h('h3', { style: { margin: '12px 0 6px' } }, 'Ship packages (newcharacter.ini [Package])'),
        h('table', { class: 'grid' }, h('tr', {}, ['package', 'ship', 'loadout', 'money'].map(t => h('th', {}, t))),
          packages.map(s => h('tr', {}, h('td', {}, s.get('nickname'), h('div', { style: { color: 'var(--faint)', fontSize: '11px' } }, g.name(s.get('strid_name')) || '')),
            h('td', {}, edit(nc, s, 'ship'), bad(ships.has(lc(s.get('ship'))), 'not a ship in shiparch.ini')),
            h('td', {}, edit(nc, s, 'loadout'), bad(!loadouts.size || loadouts.has(lc(s.get('loadout'))), 'not a loadout in loadouts.ini')),
            h('td', {}, edit(nc, s, 'money'))))));
    } else body.append(h('div', { style: { color: 'var(--faint)' } }, 'DATA\\CHARACTERS\\newcharacter.ini not found.'));
    if (mpc) {
      const P = mpc.ini.first('Player'); const house = P ? P.findAll('house') : [];
      const grid = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(330px, 1fr))', gap: '4px 14px' } });
      const nameCount = new Map(); for (const e of house) { const n = g.factionName(e.values[1]) || e.values[1]; nameCount.set(n, (nameCount.get(n) || 0) + 1); }
      for (const e of house) {
        const [v, f] = e.values; const val = parseFloat(v) || 0;
        const col = val <= -0.6 ? '#e86a6a' : val >= 0.6 ? '#7ee787' : 'var(--dim)';
        const sl = h('input', { type: 'range', min: -1, max: 1, step: 0.05, value: val, style: { flex: 1 }, onchange: () => app.history.do(`Start reputation ${f}`, [mpc], () => { e.value = `${(+sl.value).toFixed(2).replace(/\.?0+$/, '') || '0'}, ${f}`; e.raw = null; }) });
        grid.append(h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } }, h('span', { style: { width: '150px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: f }, (() => { const n = g.factionName(f) || f || '(empty)'; return nameCount.get(n) > 1 ? `${n} (${f})` : n; })()), sl, h('span', { style: { width: '40px', textAlign: 'right', color: col } }, String(val)), groups.has(lc(f)) ? null : h('span', { style: { color: '#ff8a65' }, title: 'not in initialworld.ini' }, '⚠')));
      }
      body.append(h('h3', { style: { margin: '12px 0 6px' } }, 'Starting reputations of new characters (EXE\\mpnewcharacter.fl)'), house.length ? grid : h('div', { style: { color: 'var(--faint)' } }, 'No "house =" lines.'),
        h('p', { style: { color: 'var(--faint)', fontSize: '12px' } }, 'Red ≤ −0.6 hostile, green ≥ 0.6 friendly. The %%…%% placeholders in the file are filled from the start option and package chosen in the new-character screen.'));
    }
  }

  // ------------------------------------------------------------ multiplayer saves
  async function renderSaves(body) {
    const r = await fetch('/api/mpsaves').then(x => x.json()).catch(() => null);
    if (!r || r.error) { body.append(h('div', { style: { color: 'var(--faint)' } }, 'No multiplayer save folder found' + (r && r.tried ? ` (looked in ${r.tried.map(t => t.replace(/SinglePlayer$/, 'MultiPlayer')).join(', ')})` : '') + '. Characters are stored on the computer that runs FLServer.')); return; }
    body.append(h('div', { style: { color: 'var(--dim)', marginBottom: '6px' } }, `${r.saves.length} character file(s) in ${r.dir}. Stop FLServer before changing a character — it rewrites the file on save. Edits are written back with a backup in editor_backups.`));
    const tbl = h('table', { class: 'grid' }, h('tr', {}, ['account', 'file', 'modified', ''].map(t => h('th', {}, t))));
    for (const s of r.saves) tbl.append(h('tr', {}, h('td', { style: { fontFamily: 'var(--mono)' } }, s.acct), h('td', {}, s.name), h('td', {}, new Date(s.modified).toLocaleString()),
      h('td', {}, h('button', { class: 'btn sm', onclick: async () => { const b = await fetch(`/api/mpsavefile?acct=${encodeURIComponent(s.acct)}&name=${encodeURIComponent(s.name)}`).then(x => x.arrayBuffer()); (await import('./savegame.js')).saveGameViewer(app, { name: s.name, bytes: new Uint8Array(b) }); } }, 'Open'))));
    body.append(tbl);
  }

  // ------------------------------------------------------------ server / client files
  async function renderFiles(body) {
    const ch = await api.changes().catch(() => null);
    const files = (ch && ch.files || []).filter(f => !f.same && f.curSize != null);
    const groups = { both: [], client: [], server: [] };
    for (const f of files) groups[fileRole(app, f.path)].push(f);
    const INFO = { both: ['Server and every client', 'Gameplay data — systems, bases, markets, goods, equipment, ships, loadouts, factions, missions. Server and clients must have identical copies, or players see different worlds, get kicked or crash.'], client: ['Clients only', 'Models, textures, sounds, interface, cutscenes and the resource DLLs with names and infocards. The server does not read them (it is harmless if it has them).'], server: ['Server only', 'FLHook, its plugins, server DLLs and new-character files.'] };
    if (app.history.dirty.size) body.append(h('div', { style: { color: '#ffd34d', marginBottom: '6px' } }, `${app.history.dirty.size} file(s) have unsaved changes — save first so they are included.`));
    body.append(h('p', { style: { color: 'var(--dim)', marginTop: 0 } }, `${files.length} file(s) differ from the original game (from the editor's backups).`));
    for (const [k, list] of Object.entries(groups)) {
      body.append(h('div', { style: { border: '1px solid var(--line)', borderRadius: '8px', padding: '8px 10px', marginBottom: '8px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, h('b', { style: { flex: 1 } }, `${INFO[k][0]} (${list.length})`),
          list.length ? h('button', { class: 'btn sm', onclick: () => pack(list, `fl-${k}-files.zip`) }, 'Download zip') : null),
        h('div', { style: { color: 'var(--faint)', fontSize: '12px', margin: '2px 0 4px' } }, INFO[k][1]),
        h('div', { style: { fontFamily: 'var(--mono)', fontSize: '12px', maxHeight: '160px', overflow: 'auto' } }, list.map(f => h('div', {}, f.path + (f.created ? '  (new)' : ''))))));
    }
    const server = [...groups.both, ...groups.server], client = [...groups.both, ...groups.client];
    body.append(h('div', { class: 'btnrow' },
      h('button', { class: 'btn primary', disabled: !server.length, onclick: () => pack(server, 'fl-server-package.zip') }, `Server package (${server.length} files)`),
      h('button', { class: 'btn primary', disabled: !client.length, onclick: () => pack(client, 'fl-client-package.zip') }, `Client package (${client.length} files)`)),
      h('p', { style: { color: 'var(--faint)', fontSize: '12px' } }, 'The zips keep the folder layout of the Freelancer folder (DATA\\…, EXE\\…): unpack them into the server\'s or player\'s Freelancer folder. Players can also install a mod exported with File → Mods.'));
  }
  async function pack(list, name) {
    const files = [];
    for (const f of list) { const b = await api.read(f.path); if (b) files.push({ name: f.path, data: b }); }
    const zip = await writeZip(files);
    const a = h('a', { href: URL.createObjectURL(new Blob([zip], { type: 'application/zip' })), download: name }); document.body.append(a); a.click(); a.remove();
    toast(`${name}: ${files.length} file(s)`);
  }
}
