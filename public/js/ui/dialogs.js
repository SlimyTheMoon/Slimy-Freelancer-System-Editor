import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { h, modal, toast, datalist, confirmDialog, overlay } from './dom.js';
import { api, dataPath, norm } from '../api.js';
import { IniDocument, IniSection, IniEntry, fmtNum, fmtVec } from '../formats/ini.js';
import { SystemDoc, kindOf, getPos } from '../system.js';
import { laneRotation } from './panels.js';
import { validateSystem, validateFiles } from '../validate.js';
import { objectColor } from '../visuals.js';

const v3 = (p) => p.isVector3 ? p : new THREE.Vector3(p[0], p[1], p[2]);
const numIn = (v, step = 100) => h('input', { type: 'number', value: fmtNum(v, 0), step });
const vecIn = (p) => { const ins = [p.x, p.y, p.z].map(x => numIn(x)); return { el: h('div', { class: 'vec', style: { marginBottom: 0 } }, h('label', { class: 'x' }, 'X'), ins[0], h('label', { class: 'y' }, 'Y'), ins[1], h('label', { class: 'z' }, 'Z'), ins[2]), get: () => ins.map(i => parseFloat(i.value) || 0), set: (q) => ins.forEach((i, k) => i.value = fmtNum(q[k], 0)) }; };
const row = (label, el, help) => [h('label', {}, label), el, help ? h('div', { class: 'help' }, help) : null];

// ------------------------------------------------------------ install folder
export async function setupInstall(app, cfg, err) {
  const inp = h('input', { value: cfg.installDir || '', placeholder: 'C:\\Games\\Freelancer HD Edition' });
  const msg = h('div', { class: 'sev-err', style: { marginTop: '8px' } }, err || '');
  inp.style.flex = '1';
  const browse = h('button', { class: 'btn', title: 'Open a folder dialog', onclick: async () => {
    browse.disabled = true; msg.className = 'sev-info'; msg.textContent = 'A folder dialog is open (it may be behind this window)…';
    try {
      const j = await (await fetch('/api/pick-folder?start=' + encodeURIComponent(inp.value.trim()))).json();
      if (j.error) { msg.className = 'sev-err'; msg.textContent = j.error; }
      else if (j.cancelled) msg.textContent = '';
      else { inp.value = j.path; msg.className = j.valid ? 'sev-ok' : 'sev-err'; msg.textContent = j.valid ? 'Freelancer found in this folder.' : 'No DATA\\UNIVERSE\\universe.ini in this folder — pick the game folder that contains DATA and EXE.'; }
    } catch (e) { msg.className = 'sev-err'; msg.textContent = e.message; }
    browse.disabled = false;
  } }, 'Browse…');
  modal({
    title: 'Freelancer game folder', body: h('div', {},
      h('p', { style: { color: 'var(--dim)', marginTop: 0 } }, 'Point the editor at the folder that contains DATA and EXE (the one with DATA\\UNIVERSE\\universe.ini). Files are edited in place; originals are copied to editor_backups\\ in that folder before the first save of each session.'),
      h('div', { class: 'form' }, ...row('Install folder', h('div', { style: { display: 'flex', gap: '6px' } }, inp, browse))), msg),
    buttons: [{ label: 'Use this folder', cls: 'primary', onClick: async () => { try { await api.setInstall(inp.value.trim()); location.reload(); } catch (e) { msg.textContent = e.message; return false; } } }],
  });
}

// ------------------------------------------------------------ raw editors
export function rawIni(app, doc) {
  const ta = h('textarea', { class: 'raw', spellcheck: 'false' }); ta.value = doc.ini.text();
  modal({
    title: 'Raw INI — ' + (doc.label || doc.path), wide: true, body: h('div', {}, h('div', { style: { color: 'var(--faint)', marginBottom: '6px', fontSize: '12px' } }, doc.path), ta),
    buttons: [{ label: 'Cancel' }, {
      label: 'Apply', cls: 'primary', onClick: () => {
        const nd = IniDocument.parse(ta.value, doc.path);
        app.history.do('Edit raw INI', [doc], () => { doc.ini.preamble = nd.preamble; doc.ini.sections = nd.sections; doc.ini.eol = nd.eol; });
        if (doc === app.universeDoc) app.game.refreshUniverse();
        app.selection = []; app.props.render();
      },
    }],
  });
}
export function rawSection(app, sec, doc = app.sys) {
  const ta = h('textarea', { class: 'raw', spellcheck: 'false', style: { height: '40vh' } }); ta.value = sec.text('\n');
  modal({
    title: `Raw [${sec.name}] ${sec.get('nickname') || ''}`, wide: true, body: ta,
    buttons: [{ label: 'Cancel' }, {
      label: 'Apply', cls: 'primary', onClick: () => {
        const nd = IniDocument.parse(ta.value.trim() + '\n');
        const ns = nd.sections[0]; if (!ns) { toast('Text must start with a [Section] header'); return false; }
        app.history.do('Edit section', [doc], () => {
          sec.name = ns.name; sec.raw = ns.raw;
          const tail = sec.lines.slice(sec.lastEntryIndex() + 1).filter(l => l.type !== 'entry');
          sec.lines = [...ns.lines.filter((l, i, a) => !(l.type !== 'entry' && i >= a.length - 1 && !l.raw.trim())), ...(tail.length ? tail : [{ type: 'other', raw: '' }])];
        });
        if (doc === app.universeDoc) app.game.refreshUniverse();
      },
    }],
  });
}
export function editUniverseSection(app, sec) { rawSection(app, sec, app.universeDoc); }

export async function backups(app) {
  const b = await api.backups();
  modal({ title: 'Backups', body: h('div', {}, h('p', { style: { color: 'var(--dim)', marginTop: 0 } }, 'Before a file is first overwritten in a session, the original is copied here. To restore, copy a file back from the session folder.'), h('div', { class: 'info' }, b.dir), h('h3', {}, 'Sessions'), h('div', { class: 'reflist' }, b.sessions.length ? b.sessions.map(s => h('div', {}, s + (s === app.cfg.session ? '  (current)' : ''))) : h('div', {}, 'none yet'))), buttons: [{ label: 'Close' }] });
}

// ------------------------------------------------------------ archetype picker (with live 3D preview)
export function pickArchetype(app, current, onPick, filterType = null) {
  const g = app.game;
  const types = [...new Set([...g.archetypes.values()].map(a => a.type))].sort();
  const search = h('input', { placeholder: 'Search archetypes…', value: '' });
  const typeSel = h('select', {}, h('option', { value: '' }, 'All types'), types.map(t => h('option', { value: t, selected: t === filterType }, t)));
  const list = h('div', { class: 'list tree' });
  const canvas = h('canvas');
  const meta = h('div', { class: 'meta' }, 'Select an archetype to preview');
  let chosen = current;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x0b0f15);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.6)); const dl = new THREE.DirectionalLight(0xffffff, 1.6); dl.position.set(1, 1, 1); scene.add(dl);
  const cam = new THREE.PerspectiveCamera(40, 1, 1, 1e7);
  const ctl = new OrbitControls(cam, canvas); ctl.autoRotate = true; ctl.autoRotateSpeed = 1.5;
  let holder = new THREE.Group(); scene.add(holder);
  let alive = true;
  const loop = () => { if (!alive) return; const w = canvas.clientWidth, hh = canvas.clientHeight; if (w && hh && (canvas.width !== w || canvas.height !== hh)) { renderer.setSize(w, hh, false); cam.aspect = w / hh; cam.updateProjectionMatrix(); } ctl.update(); renderer.render(scene, cam); requestAnimationFrame(loop); };
  loop();
  let token = 0;
  const preview = async (a) => {
    chosen = a.nickname; const my = ++token;
    meta.innerHTML = ''; meta.append(h('b', {}, a.nickname), h('br'), `${a.type} · radius ${a.radius || '?'}`, h('br'), a.da || 'no model', g.name(a.ids) ? h('div', {}, g.name(a.ids)) : null);
    scene.remove(holder); holder = new THREE.Group(); scene.add(holder);
    if (!a.da) return;
    const m = await app.rm.model(dataPath(a.da), a.matLibs.map(dataPath));
    if (my !== token || !m) return;
    holder.add(m);
    const box = new THREE.Box3().setFromObject(m); const s = box.getBoundingSphere(new THREE.Sphere());
    ctl.target.copy(s.center); cam.position.copy(s.center).add(new THREE.Vector3(1, 0.6, 1).normalize().multiplyScalar(s.radius * 2.6)); cam.near = s.radius / 100; cam.far = s.radius * 100; cam.updateProjectionMatrix();
  };
  const draw = () => {
    list.innerHTML = '';
    const q = search.value.toLowerCase(), t = typeSel.value;
    const items = [...g.archetypes.values()].filter(a => (!t || a.type === t) && (!q || (a.nickname + ' ' + (g.name(a.ids) || '') + ' ' + a.type).toLowerCase().includes(q))).sort((a, b) => a.type.localeCompare(b.type) || a.nickname.localeCompare(b.nickname));
    for (const a of items.slice(0, 1500)) {
      const r = h('div', { class: 'row' + (a.nickname.toLowerCase() === (chosen || '').toLowerCase() ? ' sel' : ''), onclick: () => { list.querySelectorAll('.row.sel').forEach(x => x.classList.remove('sel')); r.classList.add('sel'); preview(a); }, ondblclick: () => { onPick(a.nickname); m.close(); } },
        h('span', { class: 'dot', style: { background: '#' + objectColor(a).toString(16).padStart(6, '0') } }), h('span', { class: 'nm' }, a.nickname), h('span', { class: 'sub' }, g.name(a.ids) || a.type.toLowerCase()));
      list.append(r);
    }
    const cur = list.querySelector('.row.sel'); if (cur) cur.scrollIntoView({ block: 'center' });
  };
  search.oninput = draw; typeSel.onchange = draw;
  const m = modal({
    title: 'Choose archetype', wide: true, onClose: () => { alive = false; renderer.dispose(); },
    body: h('div', {}, h('div', { class: 'btnrow', style: { marginBottom: '8px' } }, h('div', { style: { flex: 1, display: 'flex' } }, search), typeSel), h('div', { class: 'picker' }, list, h('div', { class: 'preview' }, canvas, meta))),
    buttons: [{ label: 'Cancel' }, { label: 'Use archetype', cls: 'primary', onClick: () => { if (chosen) onPick(chosen); } }],
  });
  m.box.querySelector('input').style.width = '100%';
  draw();
  const cur = current && g.arch(current); if (cur) preview(cur);
}

// ------------------------------------------------------------ create object / zone
export function addObject(app, at) {
  const p = at || app.placePoint();
  pickArchetype(app, null, (arch) => {
    const a = app.game.arch(arch);
    const extra = {};
    // sensible defaults by type, copied from a similar object in this system when possible
    const twin = app.sys.objects.find(o => (o.get('archetype') || '').toLowerCase() === arch.toLowerCase());
    if (twin) for (const k of ['ids_info', 'reputation', 'behavior', 'difficulty_level', 'loadout', 'pilot', 'visit', 'jump_effect']) if (twin.get(k)) extra[k] = twin.get(k);
    if (a && ['STATION', 'WEAPONS_PLATFORM', 'DOCKING_RING', 'TRADELANE_RING', 'JUMP_GATE'].includes(a.type) && !extra.behavior) extra.behavior = 'NOTHING';
    if (a && a.type === 'SUN') extra.star = 'med_white_sun';
    extra.nickname = `${app.sys.nickname}_${arch}_01`;
    app.addObjectAt(arch, p, extra);
  });
}
export function addZone(app, at) {
  const p = v3(at || app.placePoint());
  const shape = h('select', {}, ['SPHERE', 'ELLIPSOID', 'BOX', 'CYLINDER', 'RING'].map(s => h('option', {}, s)));
  const nick = h('input', { value: app.sys.uniqueNick(`Zone_${app.sys.nickname}_01`) });
  const size = h('input', { value: '5000' });
  const preset = h('select', {}, ['plain', 'exclusion (sort 99)', 'death zone', 'encounter / patrol'].map(s => h('option', {}, s)));
  const pos = vecIn(p);
  modal({
    title: 'New zone', body: h('div', { class: 'form' }, ...row('Nickname', nick), ...row('Shape', shape), ...row('Size', size, 'Comma separated: sphere r · ellipsoid rx,ry,rz · box x,y,z · cylinder r,height · ring outer,inner,height'), ...row('Preset', preset), ...row('Position', pos.el)),
    buttons: [{ label: 'Cancel' }, {
      label: 'Create', cls: 'primary', onClick: () => {
        const s = size.value.split(',').map(x => parseFloat(x)).filter(x => !isNaN(x));
        const need = { ELLIPSOID: 3, BOX: 3, CYLINDER: 2, RING: 3 }[shape.value] || 1;
        while (s.length < need) s.push(shape.value === 'CYLINDER' ? s[0] * 4 : s.length === 1 && shape.value === 'RING' ? s[0] * 0.6 : s[0] || 1000);
        const extra = { nickname: nick.value.trim() };
        if (preset.selectedIndex === 1) Object.assign(extra, { sort: 99 });
        if (preset.selectedIndex === 2) Object.assign(extra, { damage: 2000000, sort: 99.5 });
        if (preset.selectedIndex === 3) Object.assign(extra, { sort: 99, toughness: 3, density: 4, repop_time: 30, max_battle_size: 4, pop_type: 'attack_patrol', relief_time: 20 });
        const q = pos.get();
        app.addZoneAt(shape.value, new THREE.Vector3(...q), s, extra);
      },
    }],
  });
}

// ------------------------------------------------------------ trade lane generator
export function tradelane(app) {
  const sys = app.sys, g = app.game;
  const objs = sys.objects.filter(o => { const a = g.arch(o.get('archetype')); return a && a.type !== 'TRADELANE_RING'; });
  const sel = app.selected();
  const mkSel = (def) => h('select', {}, h('option', { value: '' }, '(custom position)'), objs.map(o => h('option', { value: o.id, selected: def && def.id === o.id }, `${g.name(o.get('ids_name')) || o.get('nickname')}  · ${o.get('nickname')}`)));
  const fromSel = mkSel(sel[0]), toSel = mkSel(sel[1]);
  const fromPos = vecIn(v3(sel[0] ? getPos(sel[0]) : app.placePoint())), toPos = vecIn(v3(sel[1] ? getPos(sel[1]) : app.placePoint().add(new THREE.Vector3(30000, 0, 0))));
  fromSel.onchange = () => { const o = sys.byId(+fromSel.value); if (o) fromPos.set(getPos(o)); };
  toSel.onchange = () => { const o = sys.byId(+toSel.value); if (o) toPos.set(getPos(o)); };
  const tpl = sys.objects.find(o => { const a = g.arch(o.get('archetype')); return a && a.type === 'TRADELANE_RING'; });
  const ringArchs = [...g.archetypes.values()].filter(a => a.type === 'TRADELANE_RING').map(a => a.nickname);
  const arch = h('select', {}, ringArchs.map(a => h('option', { selected: tpl && tpl.get('archetype').toLowerCase() === a.toLowerCase() }, a)));
  const spacing = numIn(7500), gap = numIn(2500);
  const startName = h('input', { value: '' }), endName = h('input', { value: '' });
  const nums = sys.objects.map(o => (o.get('nickname') || '').match(/Trade_Lane_Ring_(\d+)$/i)).filter(Boolean).map(m => +m[1]);
  const prefix = h('input', { value: `${sys.nickname}_Trade_Lane_Ring_` });
  const startNum = numIn((nums.length ? Math.max(...nums) : 0) + 1, 1);
  const preview = h('div', { style: { color: 'var(--dim)', marginTop: '6px' } });
  const calc = () => {
    const a = new THREE.Vector3(...fromPos.get()), b = new THREE.Vector3(...toPos.get());
    const dir = b.clone().sub(a); const L = dir.length(); dir.normalize();
    const ga = (sys.byId(+fromSel.value) ? (app.viewport.visuals.get(+fromSel.value)?.userData.radius || 0) : 0) + (parseFloat(gap.value) || 0);
    const gb = (sys.byId(+toSel.value) ? (app.viewport.visuals.get(+toSel.value)?.userData.radius || 0) : 0) + (parseFloat(gap.value) || 0);
    const s = a.clone().addScaledVector(dir, sys.byId(+fromSel.value) ? ga : 0), e = b.clone().addScaledVector(dir, sys.byId(+toSel.value) ? -gb : 0);
    const len = s.distanceTo(e); const n = Math.max(2, Math.round(len / (parseFloat(spacing.value) || 7500)) + 1);
    preview.textContent = `${n} rings over ${(len / 1000).toFixed(1)} k (≈${Math.round(len / (n - 1))} m apart)`;
    return { s, e, n, len };
  };
  [fromSel, toSel, spacing, gap].forEach(x => x.addEventListener('change', calc)); setTimeout(calc, 0);
  modal({
    title: 'Create trade lane', wide: false,
    body: h('div', { class: 'form' },
      ...row('From', fromSel), ...row('', fromPos.el), ...row('To', toSel), ...row('', toPos.el),
      ...row('Ring archetype', arch), ...row('Ring spacing (m)', spacing), ...row('Gap at stations (m)', gap, 'Distance kept from the station/planet surface'),
      ...row('Nickname prefix', prefix), ...row('First number', startNum),
      ...row('Start name (ids)', startName, 'tradelane_space_name on the first ring, e.g. the destination name id'), ...row('End name (ids)', endName),
      h('div', { class: 'full' }, preview), tpl ? h('div', { class: 'full', style: { color: 'var(--faint)', fontSize: '12px' } }, `Copies loadout, reputation, pilot, ids from ${tpl.get('nickname')}`) : null),
    buttons: [{ label: 'Cancel' }, {
      label: 'Create lane', cls: 'primary', onClick: () => {
        const { s, e, n } = calc();
        const base = parseInt(startNum.value) || 1;
        const nicks = []; let k = base;
        for (let i = 0; i < n; i++) { while (sys.nickExists(prefix.value + k)) k++; nicks.push(prefix.value + k); k++; }
        const ids = app.edit('Create trade lane', () => {
          const out = [];
          for (let i = 0; i < n; i++) {
            const t = i / (n - 1); const p = s.clone().lerp(e, t);
            const rot = laneRotation(s.toArray(), e.toArray());
            const extra = { nickname: nicks[i], rotate: rot };
            if (tpl) for (const kk of ['ids_name', 'ids_info', 'reputation', 'difficulty_level', 'loadout', 'pilot']) if (tpl.get(kk)) extra[kk] = tpl.get(kk);
            if (i > 0) extra.prev_ring = nicks[i - 1];
            if (i < n - 1) extra.next_ring = nicks[i + 1];
            extra.behavior = 'NOTHING';
            if (i === 0 && startName.value) extra.tradelane_space_name = startName.value;
            if (i === n - 1 && endName.value) extra.tradelane_space_name = endName.value;
            const sec = sys.addObject(arch.value, [p.x, p.y, p.z], extra);
            if (tpl && tpl.get('ids_name')) sec.set('ids_name', tpl.get('ids_name'));
            out.push(sec.id);
          }
          return out;
        });
        app.selectAfterSync(ids);
        toast(`Created ${n} trade lane rings`);
      },
    }],
  });
}

// ------------------------------------------------------------ jump gate / hole pair
export async function jumpConnection(app) {
  const g = app.game, sys = app.sys;
  const kind = h('select', {}, h('option', { value: 'JUMP_GATE' }, 'Jump gate'), h('option', { value: 'JUMP_HOLE' }, 'Jump hole'));
  const archSel = h('select');
  const fillArch = () => { archSel.innerHTML = ''; for (const a of [...g.archetypes.values()].filter(a => a.type === kind.value)) archSel.append(h('option', { selected: /^jumpgate$|^jumphole$/i.test(a.nickname) }, a.nickname)); };
  kind.onchange = fillArch; fillArch();
  const target = h('select', {}, g.systems.filter(s => s !== sys.sys).map(s => h('option', { value: s.nickname }, `${s.nickname}  ${g.name(s.strid) || ''}`)));
  const here = vecIn(v3(app.placePoint()));
  const there = vecIn(new THREE.Vector3());
  const tunnel = h('input', { value: g.gateTunnels.find(t => /bretonia/i.test(t)) || g.gateTunnels[0] || 'gate_tunnel_bretonia' }); const tdl = datalist(g.gateTunnels); tunnel.setAttribute('list', tdl.id);
  const effect = h('input', { value: g.jumpEffects.find(t => /bretonia/i.test(t)) || g.jumpEffects[0] || '' }); const edl = datalist(g.jumpEffects); effect.setAttribute('list', edl.id);
  const autoThere = () => {
    const t = g.findSystem(target.value); if (!t) return;
    const d = new THREE.Vector2(sys.sys.pos[0] - t.pos[0], sys.sys.pos[1] - t.pos[1]); if (!d.lengthSq()) d.set(1, 0); d.normalize();
    const r = 120000 / (t.navScale || 1) * 0.6;
    there.set([d.x * r, 0, d.y * r]);
    const d2 = new THREE.Vector2(t.pos[0] - sys.sys.pos[0], t.pos[1] - sys.sys.pos[1]); if (!d2.lengthSq()) d2.set(1, 0); d2.normalize();
    const r2 = 120000 / (sys.sys.navScale || 1) * 0.6;
    if (!app.selection.length) here.set([d2.x * r2, 0, d2.y * r2]);
  };
  target.onchange = autoThere; autoThere();
  modal({
    title: 'Jump connection', body: h('div', { class: 'form' },
      ...row('Type', kind), ...row('Archetype', archSel), ...row('Target system', target),
      ...row(`Position in ${sys.nickname}`, here.el), ...row('Position in target', there.el, 'Defaults point each end toward the other system on the universe map'),
      ...row('Gate tunnel', h('div', {}, tunnel, tdl.el)), ...row('Jump effect', h('div', {}, effect, edl.el))),
    buttons: [{ label: 'Cancel' }, {
      label: 'Create both ends', cls: 'primary', onClick: async () => {
        const td = await app.loadSystemDoc(target.value);
        const hole = kind.value === 'JUMP_HOLE';
        const A = sys.nickname, B = td.nickname;
        const n1 = sys.uniqueNick(hole ? `${A}_to_${B}_hole` : `${A}_to_${B}`), n2 = td.uniqueNick(hole ? `${B}_to_${A}_hole` : `${B}_to_${A}`);
        const twin = [...sys.objects, ...td.objects].find(o => (o.get('archetype') || '').toLowerCase() === archSel.value.toLowerCase());
        const common = (from, toSys) => {
          const e = { behavior: 'NOTHING', difficulty_level: '1', msg_id_prefix: `gcs_refer_system_${toSys}`, jump_effect: effect.value };
          if (twin) for (const k of ['ids_name', 'ids_info', 'loadout', 'pilot']) if (twin.get(k)) e[k] = twin.get(k);
          if (!hole) { const f = from.ini.first('SystemInfo'); const lf = f && f.get('local_faction'); if (lf) e.reputation = lf; }
          return e;
        };
        const yawTo = (p) => { const r = laneRotation([0, 0, 0], [-p[0], 0, -p[2]]); return [0, r[1], 0]; };
        const hp = here.get(), tp = there.get();
        let id1;
        app.history.do(`Jump ${A} ↔ ${B}`, [sys, td], () => {
          const s1 = sys.addObject(archSel.value, hp, { ...common(sys, B), nickname: n1, rotate: yawTo(hp), goto: `${B}, ${n2}, ${tunnel.value}` });
          td.addObject(archSel.value, tp, { ...common(td, A), nickname: n2, rotate: yawTo(tp), goto: `${A}, ${n1}, ${tunnel.value}` });
          id1 = s1.id;
        });
        app.selectAfterSync([id1]);
        toast(`Created ${n1} ↔ ${B}/${n2}`);
      },
    }],
  });
}

// ------------------------------------------------------------ base creation (clones a template base)
export async function createBase(app, objSec) {
  const g = app.game, sys = app.sys;
  objSec = objSec || app.selected()[0];
  if (!objSec || kindOf(objSec) !== 'object') { toast('Select the station/planet object first'); return; }
  const used = new Set(g.bases.map(b => b.nickname.toLowerCase()));
  let n = 1; while (used.has(`${sys.nickname}_${String(n).padStart(2, '0')}_base`.toLowerCase())) n++;
  const nick = h('input', { value: `${sys.nickname}_${String(n).padStart(2, '0')}_Base` });
  const strid = h('input', { value: objSec.get('ids_name') || '' });
  const sysBases = g.bases.filter(b => (b.system || '').toLowerCase() === sys.nickname.toLowerCase());
  const tplSel = h('select', {}, [...sysBases, ...g.bases.filter(b => !sysBases.includes(b))].map(b => h('option', { value: b.nickname }, `${b.nickname}  ${g.name(b.strid) || ''}`)));
  const cRooms = h('input', { type: 'checkbox', checked: true }), cMb = h('input', { type: 'checkbox', checked: true }), cMk = h('input', { type: 'checkbox', checked: true });
  modal({
    title: 'Create base for ' + objSec.get('nickname'), body: h('div', { class: 'form' },
      ...row('Base nickname', nick), ...row('strid_name', strid, 'Name shown in game (defaults to the object ids_name)'), ...row('Template base', tplSel, 'Base ini, rooms, NPCs and markets are cloned from this base'),
      ...row('Copy rooms', cRooms), ...row('Copy mbases.ini entry', cMb), ...row('Copy market entries', cMk)),
    buttons: [{ label: 'Cancel' }, {
      label: 'Create base', cls: 'primary', onClick: async () => {
        const bn = nick.value.trim(); if (!bn || used.has(bn.toLowerCase())) { toast('Nickname empty or already used'); return false; }
        const tpl = g.findBase(tplSel.value);
        overlay('Creating base…');
        try { await doCreateBase(app, objSec, bn, strid.value.trim(), tpl, { rooms: cRooms.checked, mbases: cMb.checked, markets: cMk.checked }); }
        catch (e) { toast('Failed: ' + e.message, 5000); }
        overlay(null);
      },
    }],
  });
}
export async function doCreateBase(app, objSec, bn, strid, tpl, opt) {
  const g = app.game, sys = app.sys;
  const docs = [sys, app.universeDoc];
  const baseRel = `Universe\\Systems\\${sys.nickname}\\Bases\\${bn}.ini`;
  const newDocs = [];
  let baseText = '[BaseInfo]\r\nnickname = ' + bn + '\r\nstart_room = Deck\r\nprice_variance = 0.15\r\n';
  if (tpl && tpl.file) {
    const t = await app.otherDoc(dataPath(tpl.file));
    if (t) {
      const copy = IniDocument.parse(t.ini.text(), dataPath(baseRel));
      const bi = copy.first('BaseInfo'); if (bi) bi.set('nickname', bn);
      for (const r of copy.all('Room')) {
        const f = r.get('file'); const rn = r.get('nickname') || 'room';
        if (!f) continue;
        if (opt.rooms) {
          const src = await app.otherDoc(dataPath(f));
          const nrel = `Universe\\Systems\\${sys.nickname}\\Bases\\Rooms\\${bn}_${rn}.ini`;
          if (src) { const rd = { key: 'file:' + norm(dataPath(nrel)).toLowerCase(), path: dataPath(nrel), ini: IniDocument.parse(src.ini.text(), dataPath(nrel)), label: norm(nrel).split('/').pop() }; newDocs.push(rd); r.set('file', nrel); }
        }
      }
      baseText = copy.text();
    }
  }
  const baseDoc = { key: 'file:' + norm(dataPath(baseRel)).toLowerCase(), path: dataPath(baseRel), ini: IniDocument.parse(baseText, dataPath(baseRel)), label: bn + '.ini' };
  newDocs.push(baseDoc);
  // mbases & markets
  const extra = [];
  if (opt.mbases && tpl) { const d = await app.otherDoc(dataPath('missions\\mbases.ini')); if (d) extra.push(['mbase', d]); }
  if (opt.markets && tpl) for (const f of ['equipment\\market_misc.ini', 'equipment\\market_commodities.ini', 'equipment\\market_ships.ini']) { const d = await app.otherDoc(dataPath(f)); if (d) extra.push(['market', d]); }
  const allDocs = [...docs, ...newDocs, ...extra.map(e => e[1])];
  // new files start empty in history so undo removes their content; register so Save writes them
  const finals = newDocs.map(d => d.ini.snapshot());
  for (const d of newDocs) { d.isNew = true; d.ini.sections = []; d.ini.preamble = []; app.otherDocs.set(d.key.slice(5), d); }
  app.history.do('Create base ' + bn, allDocs, () => {
    newDocs.forEach((d, i) => d.ini.restore(finals[i]));
    const uni = app.universeDoc.ini;
    const lastBase = [...uni.all('Base')].filter(b => (b.get('system') || '').toLowerCase() === sys.nickname.toLowerCase()).pop() || uni.all('Base').pop();
    const entries = [['nickname', bn], ['system', sys.nickname], ['strid_name', strid || '0'], ['file', baseRel]];
    if (tpl && tpl.section.get('BGCS_base_run_by')) entries.push(['BGCS_base_run_by', tpl.section.get('BGCS_base_run_by')]);
    uni.addSection('Base', lastBase, entries);
    objSec.set('base', bn); objSec.set('dock_with', bn);
    for (const [kind, d] of extra) {
      if (kind === 'mbase') {
        const secs = d.ini.sections; const i0 = secs.findIndex(s => s.is('MBase') && (s.get('nickname') || '').toLowerCase() === tpl.nickname.toLowerCase());
        if (i0 < 0) continue;
        let i1 = i0 + 1; while (i1 < secs.length && !secs[i1].is('MBase')) i1++;
        const clones = secs.slice(i0, i1).map(s => s.clone());
        clones[0].set('nickname', bn);
        for (const c of clones) if (c.lines.length && c.lines[c.lines.length - 1].type === 'entry') c.lines.push({ type: 'other', raw: '' });
        d.ini.sections.push(...clones);
      } else {
        const src = d.ini.all('BaseGood').filter(s => (s.get('base') || '').toLowerCase() === tpl.nickname.toLowerCase());
        for (const s of src) { const c = s.clone(); c.set('base', bn); if (c.lines.length && c.lines[c.lines.length - 1].type === 'entry') c.lines.push({ type: 'other', raw: '' }); d.ini.sections.push(c); }
      }
    }
  });
  g.refreshUniverse();
  app.props.render();
  toast(`Base ${bn} created (${allDocs.length} files changed — Ctrl+S to save)`, 4000);
}

// ------------------------------------------------------------ asteroid / nebula link
export async function fieldLink(app, zone) {
  zone = zone || app.selected()[0];
  if (!zone || kindOf(zone) !== 'zone') { toast('Select a zone first'); return; }
  const kind = h('select', {}, h('option', { value: 'Asteroids' }, 'Asteroid field'), h('option', { value: 'Nebula' }, 'Nebula'));
  const file = h('input', { placeholder: 'solar\\asteroids\\....ini' });
  const dlWrap = h('div');
  const asNew = h('input', { type: 'checkbox' });
  const newName = h('input', { value: `${zone.get('nickname')}.ini`.replace(/^zone_/i, '') });
  const fill = async () => {
    const dir = kind.value === 'Asteroids' ? 'solar\\asteroids' : 'solar\\nebula';
    const files = (await api.ls(dataPath(dir))).filter(f => !f.dir && /\.ini$/i.test(f.name)).map(f => `${dir}\\${f.name}`);
    dlWrap.innerHTML = ''; const dl = datalist(files); dlWrap.append(dl.el); file.setAttribute('list', dl.id);
    if (!file.value || !file.value.toLowerCase().startsWith(dir)) file.value = files[0] || '';
  };
  kind.onchange = fill; await fill();
  modal({
    title: 'Field for ' + zone.get('nickname'), body: h('div', { class: 'form' }, ...row('Type', kind), ...row('Field file', h('div', {}, file, dlWrap)), ...row('Copy to new file', asNew, 'Clone the chosen file so this field can be tuned separately'), ...row('New file name', newName)),
    buttons: [{ label: 'Cancel' }, {
      label: 'Link', cls: 'primary', onClick: async () => {
        let f = file.value.trim(); if (!f) return false;
        const docs = [app.sys]; let nd = null;
        if (asNew.checked) {
          const src = await app.otherDoc(dataPath(f)); if (!src) { toast('Source file not found'); return false; }
          const dir = f.split('\\').slice(0, -1).join('\\'); f = `${dir}\\${newName.value.trim()}`;
          nd = { key: 'file:' + norm(dataPath(f)).toLowerCase(), path: dataPath(f), ini: new IniDocument(dataPath(f)), label: newName.value, isNew: true };
          app.otherDocs.set(nd.key.slice(5), nd); docs.push(nd);
          var finalSnap = IniDocument.parse(src.ini.text(), nd.path).snapshot();
        }
        app.edit('Link field', () => {
          if (nd) nd.ini.restore(finalSnap);
          const last = app.sys.ini.all(kind.value).pop() || app.sys.ini.all('Asteroids').pop() || app.sys.ini.all('Nebula').pop();
          app.sys.ini.addSection(kind.value, last || app.sys.ini.first('Background'), [['file', f], ['zone', zone.get('nickname')]]);
        }, docs);
      },
    }],
  });
}

// ------------------------------------------------------------ new system
export function newSystem(app, uniPos) {
  const g = app.game;
  const nick = h('input', { value: 'NEW01' });
  const strid = h('input', { value: '' });
  const dispName = h('input', { value: '', placeholder: 'e.g. Ohio' });
  const pos = h('input', { value: uniPos ? `${fmtNum(uniPos[0], 1)}, ${fmtNum(uniPos[1], 1)}` : '10, 10' });
  const scale = h('input', { value: '1' });
  const tpl = h('select', {}, h('option', { value: '' }, 'Empty system'), g.systems.map(s => h('option', { value: s.nickname, selected: app.sys && s === app.sys.sys }, 'Copy settings from ' + s.nickname)));
  const sun = h('input', { type: 'checkbox', checked: true });
  modal({
    title: 'New system', body: h('div', { class: 'form' }, ...row('Nickname', nick), ...row('Display name', dispName, 'Creates a new string in an editable resource DLL (leave empty to skip)'), ...row('…or strid_name', strid, 'Use an existing string id instead'), ...row('Universe map pos', pos, 'x, y on the universe map grid'), ...row('NavMapScale', scale),
      ...row('Template', tpl, 'Copies [SystemInfo] [Music] [Dust] [Ambient] [Background] [TexturePanels]'), ...row('Add sun + light', sun)),
    buttons: [{ label: 'Cancel' }, {
      label: 'Create', cls: 'primary', onClick: async () => {
        const n = nick.value.trim(); if (!n || g.findSystem(n)) { toast('Nickname empty or exists'); return false; }
        let src = null; if (tpl.value) src = await app.loadSystemDoc(tpl.value);
        if (dispName.value.trim() && !strid.value.trim()) { try { strid.value = String(app.newText('string', dispName.value.trim())); } catch (e) { toast(e.message, 5000); } }
        await createSystem(app, { nick: n, strid: strid.value, pos: pos.value, scale: scale.value, src, sun: sun.checked });
        await app.openSystem(n);
        toast(`System ${n} created — save to write universe.ini and systems\\${n}\\${n}.ini`, 4000);
      },
    }],
  });
}


// creates the universe.ini [System] entry and an (unsaved) system file; returns the SystemDoc
export function createSystem(app, { nick: n, strid = '', pos = '10, 10', scale = '1', src = null, sun = true }) {
  const g = app.game;
  const sunChecked = sun;
  const file = `systems\\${n}\\${n}.ini`;
  const uni = app.universeDoc.ini;
  app.history.do('New system ' + n, [app.universeDoc], () => {
    const entries = [['nickname', n], ['file', file], ['pos', pos], ['msg_id_prefix', `gcs_refer_system_${n}`], ['visit', '0']];
    if (strid) entries.push(['strid_name', strid]);
    if (parseFloat(scale) !== 1) entries.push(['NavMapScale', scale]);
    uni.addSection('System', uni.all('System').pop(), entries);
  });
  g.refreshUniverse();
  const sys = g.findSystem(n);
  const path = g.systemFilePath(sys);
  const ini = new IniDocument(path);
  const doc = new SystemDoc(g, sys, path, ini); doc.isNew = true; doc.key = 'sys:' + n.toLowerCase(); doc.label = n;
  app.systemDocs.set(n.toLowerCase(), doc);
  app.history.do('Create system file', [doc], () => {
    ini.addSection('SystemInfo', null, [['space_color', '0, 0, 0'], ['local_faction', 'li_p_grp']]);
    ini.addSection('Archetype', null, []);
    for (const name of ['Music', 'Dust', 'Ambient', 'Background', 'TexturePanels']) {
      const s = src && src.ini.first(name);
      if (s) { const c = s.clone(); if (c.lines.length && c.lines[c.lines.length - 1].type === 'entry') c.lines.push({ type: 'other', raw: '' }); ini.sections.push(c); }
    }
    const si = src && src.ini.first('SystemInfo'); if (si) { ini.first('SystemInfo').set('space_color', si.get('space_color') || '0, 0, 0'); if (si.get('local_faction')) ini.first('SystemInfo').set('local_faction', si.get('local_faction')); }
    if (!ini.first('Ambient')) ini.addSection('Ambient', null, [['color', '30, 30, 40']]);
    if (sunChecked) {
      ini.addSection('LightSource', null, [['nickname', `${n}_system_light`], ['pos', '0, 0, 0'], ['color', '255, 255, 255'], ['range', '150000'], ['type', 'DIRECTIONAL'], ['atten_curve', 'DYNAMIC_DIRECTION']]);
      const sa = [...g.archetypes.values()].find(a => a.type === 'SUN');
      if (sa) ini.addSection('Object', null, [['nickname', `${n}_Sun`], ['pos', '0, 0, 0'], ['ambient_color', '255, 255, 255'], ['archetype', sa.nickname], ['star', 'med_white_sun'], ['atmosphere_range', '9000'], ['burn_color', '255, 255, 255']]);
    }
  });
  return doc;
}

// ------------------------------------------------------------ misc
export function zoneFilter(app) {
  const S = app.settings;
  const cats = [['nebula', 'Nebulae'], ['asteroids', 'Asteroid / debris fields'], ['death', 'Damage / death zones'], ['exclusion', 'Exclusion zones'], ['path', 'Paths & trade lane zones'], ['encounter', 'Encounter / population zones'], ['other', 'Other zones']];
  modal({
    title: 'Zone categories', body: h('div', {}, cats.map(([k, l]) => h('label', { style: { display: 'flex', gap: '8px', padding: '4px 0' } }, h('input', { type: 'checkbox', checked: S.zoneCats[k] !== false, onchange: (e) => { S.zoneCats[k] = e.target.checked; localStorage.setItem('fled.settings', JSON.stringify(S)); app.viewport.applyAllFilters(); } }), l))),
    buttons: [{ label: 'Done' }],
  });
}
export function snapSettings(app) {
  const S = app.settings; const m = numIn(S.snapMove, 10), r = numIn(S.snapRot, 1);
  modal({ title: 'Snap', body: h('div', { class: 'form' }, ...row('Move step (m)', m), ...row('Rotate step (°)', r)), buttons: [{ label: 'Cancel' }, { label: 'Save', cls: 'primary', onClick: () => { S.snapMove = parseFloat(m.value) || 100; S.snapRot = parseFloat(r.value) || 15; localStorage.setItem('fled.settings', JSON.stringify(S)); app.viewport.applySnap(); app.buildToolstrip(); } }] });
}
export function shortcuts() {
  const k = [['Left drag', 'Orbit'], ['Right / middle drag', 'Pan'], ['Wheel', 'Zoom to cursor'], ['W A S D  Q E (+Shift)', 'Fly (click viewport first)'], ['Click / Shift+click', 'Select / add to selection'], ['Double-click', 'Focus'], ['G / R / V', 'Move / rotate / select-only gizmo'], ['X', 'Toggle world/local gizmo space'], ['T or Num5', 'Top (navmap) view'], ['F / Home', 'Focus selection / frame all'], ['L', 'Cycle labels'], ['H', 'Hide the selection'], ['Shift+H', 'Hide everything except the selection'], ['Alt+H', 'Show everything again'], ['Ctrl+Z / Ctrl+Y', 'Undo / redo'], ['Ctrl+C / Ctrl+V', 'Copy / paste (also between systems)'], ['Ctrl+D', 'Duplicate'], ['Del', 'Delete'], ['Ctrl+A', 'Select all visible'], ['Ctrl+F', 'Find in all systems'], ['Ctrl+S', 'Save all changed files'], ['Shift+A', 'Add object'], ['Z', 'Draw a zone on the map'], ['Ctrl+I', 'Strings & infocards'], ['Ctrl+B', 'Base characters & news'], ['Ctrl+M', 'Trade planner & markets'], ['Ctrl+Alt+E', 'Show selection in INI (VS Code)'], ['F1', 'User guide'], ['Right-click', 'Context menu (add here, paste here…)']];
  modal({ title: 'Keyboard & mouse', body: h('div', { class: 'stat' }, k.flatMap(([a, b]) => [h('span', {}, b), h('b', { style: { fontFamily: 'var(--mono)', fontSize: '12px' } }, a)])), buttons: [{ label: 'Close' }] });
}

export function validation(app, issues, title = 'Validation') {
  const list = h('div', { class: 'tree issues' });
  if (!issues.length) list.append(h('div', { class: 'empty' }, 'No problems found ✓'));
  for (const i of issues) list.append(h('div', { class: 'row', onclick: async () => { if (!app.sys || app.sys.nickname !== i.sys) await app.openSystem(i.sys); if (i.id != null) { app.select(i.id); app.viewport.focus(i.id); } else if (i.nick) { const s = app.sys.byNick(i.nick); if (s) { app.select(s.id); app.viewport.focus(s.id); } } } },
    h('span', { class: 'sev-' + i.sev, style: { width: '38px', flex: '0 0 38px', fontSize: '11px', textTransform: 'uppercase' } }, i.sev), h('span', { class: 'nm', style: { whiteSpace: 'normal' } }, h('b', {}, `${i.sys}${i.nick ? ' / ' + i.nick : ''}`), ' — ', i.msg)));
  const counts = ['err', 'warn', 'info'].map(s => issues.filter(i => i.sev === s).length);
  modal({ title: `${title} — ${counts[0]} errors, ${counts[1]} warnings, ${counts[2]} notes`, wide: true, body: h('div', { style: { maxHeight: '62vh', display: 'flex' } }, list), buttons: [{ label: 'Close' }] });
}
export async function validateAll(app) {
  overlay('Loading all systems…');
  const docs = await app.loadAllSystemDocs((i, n) => overlay(`Loading systems ${i}/${n}…`));
  let all = [];
  for (const d of docs) all = all.concat(validateSystem(app, d));
  overlay('Checking files…');
  try { // all systems at once, 3D view paused (was one system after another)
    const parts = await app.whileBusy(() => Promise.all(docs.map(d => validateFiles(app, d))));
    for (const p of parts) all = all.concat(p);
  } finally { overlay(null); }
  const order = { err: 0, warn: 1, info: 2 };
  validation(app, all.sort((a, b) => order[a.sev] - order[b.sev]), 'Validate all systems');
}

export async function find(app) {
  const q = h('input', { placeholder: 'nickname, in-game name or archetype…', style: { width: '100%' } });
  const list = h('div', { class: 'tree', style: { maxHeight: '55vh' } });
  const m = modal({ title: 'Find in all systems', wide: true, body: h('div', {}, q, h('div', { style: { height: '8px' } }), list), buttons: [{ label: 'Close' }] });
  list.append(h('div', { class: 'empty' }, 'Loading systems…'));
  const docs = await app.loadAllSystemDocs();
  const run = () => {
    list.innerHTML = '';
    const s = q.value.trim().toLowerCase(); if (s.length < 2) return;
    let n = 0;
    for (const d of docs) for (const e of d.entities) {
      const nick = e.get('nickname') || '', nm = app.game.name(e.get('ids_name')) || '', ar = e.get('archetype') || '';
      if (!(nick + ' ' + nm + ' ' + ar).toLowerCase().includes(s)) continue;
      if (++n > 400) break;
      list.append(h('div', { class: 'row', onclick: async () => { m.close(); if (app.sys !== d) await app.openSystem(d.nickname); app.select(e.id); app.viewport.focus(e.id); } }, h('span', { class: 'nm' }, nm || nick), h('span', { class: 'sub' }, `${d.nickname} · ${nick} · ${e.name}`)));
    }
    if (!n) list.append(h('div', { class: 'empty' }, 'No matches'));
  };
  q.oninput = run; run();
}
