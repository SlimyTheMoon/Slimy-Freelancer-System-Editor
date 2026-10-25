import { presetControl, applyPreset as applyViewPreset, BUILTIN as VIEW_BUILTIN, markCustomView } from './ui/viewpresets.js';
import { layerOn, setGroup, setKind, groupOf } from './ui/visibility.js';
import { kindOf as entityKind } from './system.js';
import { modDialect } from './ui/rdl.js';
import * as THREE from 'three';
import { api, dataPath, norm } from './api.js';
import { GameData, loadIni } from './gamedata.js';
import { ResourceManager } from './formats/model.js';
import { IniDocument, fmtVec } from './formats/ini.js';
import { SystemDoc, History, kindOf, getPos, setPos, setRot } from './system.js';
import { Viewport } from './viewport.js';
import { buildObject, buildZone, buildLight, applyTransform } from './visuals.js';
import { h, $, modal, toast, contextMenu, overlay, confirmDialog } from './ui/dom.js';
import { Outliner, SystemsList, Props } from './ui/panels.js';
import { UniverseMap } from './ui/universe.js';
import * as dialogs from './ui/dialogs.js';
import { validateSystem } from './validate.js';
import { FxManager } from './fx.js';
import { PathOverlay, pathLabel } from './paths.js';
import { RingManager } from './rings.js';
import { tradePlanner } from './ui/trade.js';
import { basesEditor } from './ui/mbases.js';
import { hashTool } from './ui/hashtool.js';
import { drawZoneTool } from './ui/drawzone.js';
import { installHost, inVSCode, startSystem } from './host.js';
import { openHardpointEditorFor } from './ui/hardpoints.js';
import { SunOverlay } from './sun.js';
import { newPathTool } from './ui/encounters.js';
import { FieldManager } from './fields.js';
import { DllDoc } from './dlldoc.js';
import { stringBrowser } from './ui/strings.js';

const DEFAULT_SETTINGS = {
  models: true, starsphere: true, zones: true, lights: true, objects: true, labels: 'important', grid: true, navgrid: false,
  fieldDots: true, hardpoints: false, effects: true, fields: true, nebulaFog: false, paths: true, rings: true, sunFx: true, lighting: 'mixed', snapMove: 100, snapRot: 15,
  zoneCats: { nebula: true, asteroids: true, death: true, exclusion: true, path: false, encounter: false, other: false },
  objHidden: {}, // object categories switched off (ui/visibility.js)
};

class App {
  constructor() {
    this.settings = loadSettings();
    this.viewRule = null; // (old view rules are replaced by categories with eyes — ui/visibility.js)
    this.isolate = null;  // Set of ids when "draw only listed" is on (Outliner)
    this.systemDocs = new Map();
    this.otherDocs = new Map();
    this.selection = [];
    this.clipboard = null;
    this.history = new History((e) => this.onHistory(e));
    this.status = {
      msg: (t, cls = '') => { const el = $('#st-msg'); el.textContent = t; el.className = cls; },
      cursor: (p) => { $('#st-cursor').textContent = p ? `x ${Math.round(p.x)}  z ${Math.round(p.z)}${this.navCell(p)}` : ''; },
    };
  }

  // ------------------------------------------------------------------ boot
  async boot() {
    const cfg = await api.config();
    this.cfg = cfg;
    if (!cfg.ok) { await dialogs.setupInstall(this, cfg); return; }
    overlay('Loading game data…');
    this.game = new GameData();
    this.rm = new ResourceManager(api);
    this.fx = new FxManager(this);
    this.dialogRefreshers = new Set(); // open dialogs that redraw after undo/redo
    this.fields = new FieldManager(this);
    this.paths = new PathOverlay(this);
    this.rings = new RingManager(this);
    this.sunOverlay = new SunOverlay(this);
    import('./inidocs.js').then(m => m.loadIniDocs()); // key reference (background)
    try { await this.game.load((t) => overlay(t + '…')); }
    catch (e) { overlay(null); this.status.msg(String(e.message || e), 'err'); await dialogs.setupInstall(this, cfg, String(e.message || e)); return; }
    this.universeDoc = { key: 'universe', path: this.game.universePath, ini: this.game.universe, label: 'universe.ini' };
    this.buildChrome();
    this.viewport = new Viewport($('#viewport'), this);
    this.universeMap = new UniverseMap($('#universe'), this);
    this.outliner = new Outliner($('#tab-outliner'), this);
    this.systemsList = new SystemsList($('#tab-systems'), this);
    this.props = new Props($('#props'), this);
    this.bindKeys();
    window.addEventListener('beforeunload', (e) => { if (this.history.dirty.size) { e.preventDefault(); e.returnValue = ''; } });
    installHost(this);
    const last = localStorage.getItem('fled.lastSystem');
    const first = this.game.findSystem(startSystem) || this.game.findSystem(last) || this.game.findSystem('Li01') || this.game.systems[0];
    overlay(null);
    if (first) await this.openSystem(first.nickname);
    this.status.msg(`Ready — ${this.game.systems.length} systems, ${this.game.archetypes.size} solar archetypes, ${this.game.strings.size} strings`, 'ok');
    if (this.game.warnings.length) toast(this.game.warnings.join('\n'), 6000);
    if (this.settings.patchTracking) import('./ui/updatepatch.js').then(m => m.startupCheck(this)).catch(e => console.warn('patch check', e));
  }

  // ------------------------------------------------------------------ menus / toolbar
  buildChrome() {
    const S = this.settings;
    const chk = (label, get, set) => ({ label, check: get, action: () => { set(!get()); saveSettings(S); this.viewport.applyAllFilters(); this.viewport.applyLightingMode(); this.rebuildMenus(); } });
    this.menuDefs = () => [
      ['File', [
        { label: 'Save all', key: 'Ctrl+S', action: () => this.save() },
        { label: 'Reload system from disk', action: () => this.reloadSystem() },
        ...(inVSCode ? [{ label: 'Show selection in INI (VS Code)', key: 'Ctrl+Alt+E', action: () => this.revealInIni() }] : []),
        '-',
        { label: 'Edit raw INI of system…', action: () => dialogs.rawIni(this, this.sys) },
        { label: 'Edit raw universe.ini…', action: () => dialogs.rawIni(this, this.universeDoc) },
        '-',
        { label: 'Review changes…', action: () => import('./ui/changes.js').then(m => m.reviewChanges(this)) },
        { label: 'Backups…', action: () => dialogs.backups(this) },
        { label: 'Snapshots (checkpoints)…', action: () => import('./ui/snapshots.js').then(m => m.snapshotsDialog(this)) },
        { label: 'Mods: export, install, conflicts…', action: () => import('./ui/modtools.js').then(m => m.modManager(this)) },
        ...(this.settings.patchTracking ? [{ label: (this.patchSuspended ? '⚠ ' : '') + 'Re-apply my changes after a mod update…', action: () => import('./ui/modtools.js').then(m => m.modManager(this, { tab: 'patch' })) }] : []),
        { label: 'Game folder…', action: () => dialogs.setupInstall(this, this.cfg) },
      ]],
      ['Edit', [
        { label: 'Undo', key: 'Ctrl+Z', action: () => this.history.undo() },
        { label: 'Redo', key: 'Ctrl+Y', action: () => this.history.redo() },
        '-',
        { label: 'Copy', key: 'Ctrl+C', action: () => this.copy() },
        { label: 'Paste', key: 'Ctrl+V', action: () => this.paste() },
        { label: 'Duplicate', key: 'Ctrl+D', action: () => this.duplicateSelected() },
        { label: 'Delete', key: 'Del', action: () => this.deleteSelected() },
        '-',
        { label: 'Find in all systems…', key: 'Ctrl+F', action: () => dialogs.find(this) },
        { label: 'Find references / rename everywhere…', key: 'Ctrl+Shift+F', action: () => import('./ui/refs.js').then(m => m.referencesDialog(this, { q: this.selected()[0] && this.selected()[0].get('nickname') })) },
        { label: 'Select all of same archetype', action: () => this.selectSameArchetype() },
      ]],
      ['Create', [
        { label: 'Object…', key: 'Shift+A', action: () => dialogs.addObject(this) },
        { label: 'Zone…', action: () => dialogs.addZone(this) },
        { label: 'Zone (draw on map)', key: 'Z', action: () => drawZoneTool(this) },
        { label: 'Light source', action: () => this.addLightAt(this.placePoint()) },
        '-',
        { label: 'Trade lane…', action: () => dialogs.tradelane(this) },
        { label: 'Patrol / trade path (click points)…', action: () => newPathTool(this) },
        { label: 'Jump gate / hole connection…', action: () => dialogs.jumpConnection(this) },
        { label: 'Base for selected object…', action: () => dialogs.createBase(this) },
        { label: 'Asteroid field / nebula for selected zone…', action: () => dialogs.fieldLink(this) },
        '-',
        { label: 'New system wizard (complete system)…', action: () => import('./ui/syswizard.js').then(m => m.systemWizard(this)) },
        { label: 'New system…', action: () => dialogs.newSystem(this) },
      ]],
      ['View', [
        { label: 'Frame all', key: 'Home', action: () => this.viewport.frameAll() },
        { label: 'Focus selection', key: 'F', action: () => this.selection[0] != null && this.viewport.focus(this.selection[0]) },
        { label: this.viewport && this.viewport.view === 'top' ? 'Perspective view' : 'Top (navmap) view', key: 'Num5', action: () => this.toggleTop() },
        '-',
        chk('Models', () => S.models, v => { S.models = v; this.rebuildVisuals(); }),
        chk('Particle effects (jump holes…)', () => S.effects, v => { S.effects = v; this.rebuildVisuals(); }),
        chk('Asteroid fields & nebulae (3D)', () => S.fields, v => { S.fields = v; this.fields.build(this.sys); }),
        chk('Planet rings', () => S.rings, v => { S.rings = v; this.rings.build(this.sys, true); }),
        chk('Sun spines & lens flare', () => S.sunFx, v => S.sunFx = v),
        chk('Patrol & trade paths', () => S.paths, v => { S.paths = v; this.paths.build(this.sys, true); }),
        chk('Nebula fog when inside', () => S.nebulaFog, v => S.nebulaFog = v),
        chk('Starsphere', () => S.starsphere, v => S.starsphere = v),
        chk('Objects', () => S.objects, v => S.objects = v),
        chk('Zones', () => S.zones, v => S.zones = v),
        chk('Field particles', () => S.fieldDots, v => S.fieldDots = v),
        chk('Light sources', () => S.lights, v => S.lights = v),
        chk('Hardpoints of selection', () => S.hardpoints, v => { S.hardpoints = v; this.viewport.showSelection(this.selection); }),
        chk('Grid', () => S.grid, v => S.grid = v),
        chk('Navmap grid', () => S.navgrid, v => S.navgrid = v),
        '-',
        { label: 'Labels: ' + S.labels + ' (cycle)', key: 'L', action: () => this.cycleLabels() },
        { label: 'Lighting: ' + S.lighting + ' (cycle)', action: () => { S.lighting = { mixed: 'system', system: 'editor', editor: 'mixed' }[S.lighting]; saveSettings(S); this.viewport.applyLightingMode(); this.rebuildMenus(); } },
        { label: 'Zone categories…', action: () => dialogs.zoneFilter(this) },
      ]],
      ['Tools', [
        { label: 'Validate system', action: () => dialogs.validation(this, validateSystem(this, this.sys)) },
        { label: 'Validate all systems', action: () => dialogs.validateAll(this) },
        { label: 'Crash & log analyser (FLSpew)…', action: () => import('./ui/crash.js').then(m => m.crashAnalyzer(this)) },
        { label: 'Strings & infocards (DLL editor)…', key: 'Ctrl+I', action: () => stringBrowser(this) },
        { label: 'Faction relations…', action: () => import('./ui/factions.js').then(m => m.factionRelations(this)) },
        { label: 'Translation: export / import texts…', action: () => import('./ui/translate.js').then(m => m.translationTools(this)) },
        { label: 'Server tools (multiplayer)…', action: () => import('./ui/servertools.js').then(m => m.serverTools(this)) },
        { label: 'Routes (shortest-path files)…', action: () => import('./ui/syswizard.js').then(m => m.routesTool(this)) },
        { label: 'Base interiors (rooms, fixtures, hotspots)…', action: () => import('./ui/rooms.js').then(m => m.baseInteriors(this, { base: this.currentBaseNick() })) },
        { label: 'Base characters & news…', key: 'Ctrl+B', action: () => basesEditor(this, { base: this.currentBaseNick() }) },
        { label: 'Trade planner & markets…', key: 'Ctrl+M', action: () => tradePlanner(this, { fromSystem: this.sys ? this.sys.nickname.toLowerCase() : '' }) },
        '-',
        { label: 'Pre-flight check (everything)…', action: () => import('./ui/preflight.js').then(m => m.preflight(this)) },
        { label: 'Playtest here…', key: 'F5', action: () => import('./ui/playtest.js').then(m => m.playtest(this)) },
        { label: 'Spawn simulator (zone population)…', action: () => import('./ui/spawnsim.js').then(m => m.spawnSimulator(this)) },
        { label: 'Balance tables (guns, shields, thrusters, ships)…', action: () => import('./ui/balance.js').then(m => m.balanceTables(this)) },
        { label: 'Ships, equipment & loadouts…', action: () => import('./ui/shipedit.js').then(m => m.shipEditor(this)) },
        { label: 'NPC ships (npcships.ini)…', action: () => import('./ui/npcships.js').then(m => m.npcShipEditor(this)) },
        { label: 'Mission scripts…', action: () => import('./ui/missionedit.js').then(m => m.missionEditor(this)) },
        { label: 'New mission wizard…', action: () => import('./ui/msnwizard.js').then(m => m.missionWizard(this)) },
        { label: 'Mission map (3D)…', action: () => import('./ui/missionmap.js').then(m => m.missionMap(this)) },
        { label: 'Save game viewer…', action: () => import('./ui/savegame.js').then(m => m.saveGameViewer(this)) },
        { label: 'Hash tool (CreateID, CRC)…', action: () => hashTool(this) },
        { label: 'Rebuild [Archetype] preload list', action: () => this.rebuildPreload() },
        { label: 'Measure distance (2 selected)', action: () => this.measure() },
        '-',
        { label: 'Snap settings…', action: () => dialogs.snapSettings(this) },
      ]],
      ['Assets', [
        { label: 'Model & hardpoint editor…', action: () => { const s = this.selected()[0]; dialogs.pickArchetype(this, s && s.get('archetype'), (a) => openHardpointEditorFor(this, a)); } },
        { label: 'Import model (glTF / GLB / OBJ)…', action: () => import('./ui/modelimport.js').then(m => m.modelImport(this)) },
        { label: 'Export model to glTF (.glb)…', action: () => { const s = this.selected()[0]; dialogs.pickArchetype(this, s && s.get('archetype'), (n) => { const a = this.game.arch(n); if (!a || !a.da) return toast('Archetype has no model'); import('./ui/modelimport.js').then(m => m.exportModelDialog(this, dataPath(a.da), a.matLibs.map(dataPath))); }); } },
        { label: 'Materials & textures…', action: () => import('./ui/materials.js').then(m => { const s = this.selected()[0]; const a = s && this.game.arch(s.get('archetype')); return a && a.da ? m.materialsForArchetype(this, a.nickname) : m.materialEditor(this); }) },
        { label: 'UTF file browser (.cmp .3db .mat .txm)…', action: () => import('./ui/utfbrowser.js').then(m => m.utfBrowser(this)) },
        { label: 'Particle effects…', action: () => import('./ui/fxedit.js').then(m => m.fxEditor(this)) },
        { label: 'Characters & animations…', action: () => import('./ui/charview.js').then(m => m.characterBrowser(this)) },
        { label: 'Sounds & voices…', action: () => import('./ui/audio.js').then(m => m.audioBrowser(this)) },
        { label: 'Cutscenes (.thn player & script editor)…', action: () => import('./ui/thnplayer.js').then(m => m.thnPlayer(this)) },
        '-',
        { label: 'Patch manager (exe / dll hex edits)…', action: () => import('./ui/patches.js').then(m => m.patchManager(this)) },
      ]],
      ['Help', [
        { label: 'User manual (walkthroughs)', action: () => this.showGuide('', 'manual.html') },
        { label: 'Reference guide', key: 'F1', action: () => this.showGuide() },
        { label: 'Keyboard & mouse', action: () => dialogs.shortcuts() },
        { label: 'Open the guide in a browser tab', action: () => window.open('guide.html', '_blank') },
        { label: 'Open the manual in a browser tab', action: () => window.open('manual.html', '_blank') },
        { label: 'In-game test kit…', action: () => import('./ui/testkit.js').then(m => m.testKit(this)) },
      ]],
    ];
    this.rebuildMenus();
    document.addEventListener('mousedown', (e) => { if (!e.target.closest('.menu')) document.querySelectorAll('.menu.open').forEach(m => m.classList.remove('open')); });
    // view tabs
    document.querySelectorAll('#viewtabs > button').forEach(b => b.onclick = () => this.showView(b.dataset.view));
    document.querySelectorAll('#lefttabs button').forEach(b => b.onclick = () => {
      document.querySelectorAll('#lefttabs button').forEach(x => x.classList.toggle('on', x === b));
      $('#tab-outliner').classList.toggle('hidden', b.dataset.tab !== 'outliner');
      $('#tab-systems').classList.toggle('hidden', b.dataset.tab !== 'systems');
    });
    this.buildToolstrip();
  }
  rebuildMenus() {
    const nav = $('#menus'); nav.innerHTML = '';
    for (const [name, items] of this.menuDefs()) {
      const drop = h('div', { class: 'drop' });
      const menu = h('div', { class: 'menu' }, h('button', { onclick: () => { const open = menu.classList.contains('open'); document.querySelectorAll('.menu.open').forEach(m => m.classList.remove('open')); if (!open) menu.classList.add('open'); }, onmouseenter: () => { if (document.querySelector('.menu.open') && !menu.classList.contains('open')) { document.querySelectorAll('.menu.open').forEach(m => m.classList.remove('open')); menu.classList.add('open'); } } }, name), drop);
      for (const it of items) {
        if (it === '-') { drop.append(h('hr')); continue; }
        drop.append(h('button', { class: it.check ? (it.check() ? 'checked' : 'unchecked') : '', onclick: () => { menu.classList.remove('open'); this.pauseWhileOpening(it.action()); } }, it.label, it.key ? h('kbd', {}, it.key) : null));
      }
      nav.append(menu);
    }
  }
  buildToolstrip() {
    const ts = $('#toolstrip'); ts.innerHTML = '';
    const vp = () => this.viewport;
    const mk = (label, title, on, fn) => h('button', { class: 'tbtn' + (on ? ' on' : ''), title, onclick: () => { fn(); this.buildToolstrip(); } }, label);
    const mode = this.viewport ? this.viewport.mode : 'translate';
    ts.append(
      mk('Select', 'Select only (V)', mode === 'select', () => vp().setMode('select')),
      mk('Move', 'Move gizmo (G)', mode === 'translate', () => vp().setMode('translate')),
      mk('Rotate', 'Rotate gizmo (R)', mode === 'rotate', () => vp().setMode('rotate')),
      h('span', { class: 'tsep' }),
      mk(this.viewport && this.viewport.space === 'local' ? 'Local' : 'World', 'Gizmo space (X)', false, () => { vp().space = vp().space === 'world' ? 'local' : 'world'; vp().attachGizmo(this.selection); }),
      mk('Snap', `Snap ${this.settings.snapMove} m / ${this.settings.snapRot}°`, this.viewport && this.viewport.snap, () => { vp().snap = !vp().snap; vp().applySnap(); }),
      h('span', { class: 'tsep' }),
      mk(this.viewport && this.viewport.view === 'top' ? 'Top' : '3D', 'Toggle top/navmap view (Num5 / T)', this.viewport && this.viewport.view === 'top', () => this.toggleTop()),
      mk('Frame', 'Frame all (Home)', false, () => vp().frameAll()),
      h('span', { class: 'tsep' }),
      presetControl(this),
    );
  }
  showView(v) {
    document.querySelectorAll('#viewtabs > button').forEach(b => b.classList.toggle('on', b.dataset.view === v));
    $('#viewport').classList.toggle('hidden', v !== 'system');
    $('#hud').classList.toggle('hidden', v !== 'system');
    $('#universe').classList.toggle('hidden', v !== 'universe');
    $('#toolstrip').classList.toggle('hidden', v !== 'system');
    this.currentView = v;
    if (v === 'universe') this.universeMap.show();
  }
  toggleTop() { this.viewport.setView(this.viewport.view === 'top' ? 'persp' : 'top'); this.buildToolstrip(); this.rebuildMenus(); }
  cycleLabels() { const S = this.settings; S.labels = { important: 'all', all: 'none', none: 'important' }[S.labels]; saveSettings(S); this.viewport.applyAllFilters(); this.paths.build(this.sys); this.rebuildMenus(); toast('Labels: ' + S.labels); }

  // run a long task with the 3D view paused (it would otherwise compete for the main thread)
  // a menu action that reads files before its dialog appears: pause the 3D view until the dialog is up, the
  // action is done, or 60 s passed (never longer — some actions wait for a file choice that may not come)
  pauseWhileOpening(result) {
    if (!result || typeof result.then !== 'function') return;
    const vp = this.viewport; vp.pause(); let done = false;
    const end = () => { if (done) return; done = true; clearInterval(iv); clearTimeout(to); vp.resume(); };
    const iv = setInterval(() => { if (document.querySelector('#modal-root .backdrop')) end(); }, 100), to = setTimeout(end, 60000);
    result.then(end, end);
  }
  async whileBusy(fn) { this.viewport.pause(); try { return await fn(); } finally { this.viewport.resume(); } }

  // ------------------------------------------------------------------ documents
  async loadSystemDoc(nick) {
    const sys = this.game.findSystem(nick);
    if (!sys) throw new Error('Unknown system ' + nick);
    const k = sys.nickname.toLowerCase();
    if (this.systemDocs.has(k)) return this.systemDocs.get(k);
    const path = this.game.systemFilePath(sys);
    let ini = await loadIni(path);
    if (!ini) { ini = new IniDocument(path); ini.missing = true; }
    const doc = new SystemDoc(this.game, sys, path, ini);
    doc.key = 'sys:' + k; doc.label = sys.nickname;
    this.systemDocs.set(k, doc);
    return doc;
  }
  async loadAllSystemDocs(progress) {
    // parallel (6 at a time) with the 3D view paused: rendering between fetches was most of the time
    const list = this.game.systems.filter(s => !s.labelOnly); let i = 0, next = 0;
    if (list.some(s => !this.systemDocs.has(s.nickname.toLowerCase()))) {
      this.viewport.pause();
      try {
        const worker = async () => { while (next < list.length) { const s = list[next++]; await this.loadSystemDoc(s.nickname); progress && progress(++i, list.length); } };
        await Promise.all(Array.from({ length: 6 }, worker));
      } finally { this.viewport.resume(); }
    }
    return list.map(s => this.systemDocs.get(s.nickname.toLowerCase())).filter(Boolean);
  }
  async otherDoc(path, create = false) {
    const k = norm(path).toLowerCase();
    // the same file must never be loaded twice: hand out the universe / loaded system doc for their paths
    if (this.universeDoc && norm(this.universeDoc.path).toLowerCase() === k) return this.universeDoc;
    for (const d of this.systemDocs.values()) if (norm(d.path).toLowerCase() === k) return d;
    if (this.otherDocs.has(k)) return this.otherDocs.get(k);
    // one read per file even when many callers ask at once (the mission map asks per place: 148 parallel
    // parses of Discovery's shiparch/npcships froze the page)
    this._docLoads = this._docLoads || new Map();
    if (!this._docLoads.has(k)) this._docLoads.set(k, loadIni(path).finally(() => this._docLoads.delete(k)));
    let ini = await this._docLoads.get(k);
    if (this.otherDocs.has(k)) return this.otherDocs.get(k); // another caller finished first
    if (!ini) { if (!create) return null; ini = new IniDocument(path); }
    const d = { key: 'file:' + k, path, ini, label: norm(path).split('/').pop() };
    this.otherDocs.set(k, d);
    return d;
  }

  async openSystem(nick) {
    const target = this.game.findSystem(nick);
    if (target && target.labelOnly) { toast(`${target.nickname} has no system file — it is only a name on the universe map (like Discovery's sector labels)`, 5000); return; }
    const doc = await this.loadSystemDoc(nick);
    if (this.rm) this.rm.gen++; // one generation per opened system (see ResourceManager.trim)
    this.sys = doc;
    this.loadHidden(doc);
    localStorage.setItem('fled.lastSystem', doc.nickname);
    this.selection = [];
    this.viewport.clear();
    this.viewport.navScale = doc.sys.navScale;
    this.showView('system');
    overlay(`Opening ${doc.nickname}…`);
    const token = this.openToken = (this.openToken || 0) + 1;
    this.viewport.pause();
    try { await this.computeZoneInfo(); await this.rebuildVisuals(true); } finally { this.viewport.resume(); }
    // a newer openSystem() started while this one was loading: leave the scene to it
    if (token !== this.openToken) return;
    this.viewport.setLighting(doc);
    this.viewport.updateNavGrid();
    this.viewport.frameAll();
    overlay(null);
    this.viewport.setBackground(doc);
    this.fields.build(doc);
    if (this.missionMap) this.missionMap.onSystem();
    if (this.viewport.clickHook) this.viewport.clickHook.cancel();
    this.paths.highlight = null; this.paths.build(doc, true);
    this.rings.build(doc, true);
    this.outliner.render(); this.systemsList.render(); this.props.render(); this.updateDocState();
    // free models of systems opened before the previous one (dialogs build into their own scenes: skip while one is open)
    if (this.rm && !document.querySelector('#modal-root .backdrop')) { try { const r = this.rm.trim([this.viewport.scene, this.viewport.bgScene], 1); if (r.evicted) console.debug('freed', r); } catch (e) { console.warn('cache trim failed', e); } }
    const nm = this.game.name(doc.sys.strid);
    document.title = `${doc.nickname}${nm ? ' · ' + nm : ''} — FL System Editor`;
    if (doc.ini.missing) toast('System file does not exist yet — it will be created on save.');
  }

  async computeZoneInfo() {
    const info = new Map();
    for (const kind of ['Asteroids', 'Nebula']) {
      for (const s of this.sys.ini.all(kind)) {
        const z = s.get('zone'), f = s.get('file'); if (!z) continue;
        const fi = f ? await this.game.fieldInfo(f) : null;
        info.set(z.toLowerCase(), { kind: kind.toLowerCase(), file: f, color: fi && fi.color, section: s });
      }
    }
    this.zoneInfo = info;
  }

  sig(sec) { return sec.name + '|' + sec.entries.filter(e => !/^(pos|rotate)$/i.test(e.key)).map(e => e.key.toLowerCase() + '=' + e.value).join('|'); }
  async buildVisual(sec) {
    const k = kindOf(sec);
    if (k === 'object') return buildObject(this, sec);
    if (k === 'zone') return buildZone(this, sec, this.zoneInfo.get((sec.get('nickname') || '').toLowerCase()));
    if (k === 'light') return buildLight(this, sec);
  }
  async rebuildVisuals(initial = false) {
    if (!this.sys) return;
    if (!initial) { for (const id of [...this.viewport.visuals.keys()]) this.viewport.removeVisual(id); }
    const ents = this.sys.entities;
    let done = 0;
    await Promise.all(ents.map(async sec => {
      const v = await this.buildVisual(sec);
      v.userData.sig = this.sig(sec);
      if (this.sys.byId(sec.id) === sec) this.viewport.setVisual(sec.id, v);
      if (initial && ++done % 25 === 0) overlay(`Opening ${this.sys.nickname}… ${done}/${ents.length}`);
    }));
    this.viewport.showSelection(this.selection);
  }
  async syncVisuals() {
    const vp = this.viewport, ents = this.sys.entities;
    const ids = new Set(ents.map(s => s.id));
    for (const id of [...vp.visuals.keys()]) if (!ids.has(id)) vp.removeVisual(id);
    await this.computeZoneInfo();
    await Promise.all(ents.map(async sec => {
      const v = vp.visuals.get(sec.id);
      const sig = this.sig(sec);
      if (v && v.userData.sig === sig) { applyTransform(v, sec); return; }
      const nv = await this.buildVisual(sec); nv.userData.sig = sig;
      if (this.sys.byId(sec.id)) vp.setVisual(sec.id, nv);
    }));
    this.selection = this.selection.filter(id => ids.has(id));
    vp.showSelection(this.selection);
  }

  onHistory(e) {
    this.viewport && this.viewport.poke();
    this.updateDocState();
    if (!this.sys) return;
    if (e.docs.includes(this.sys) || e.docs.includes(this.universeDoc)) {
      if (e.docs.includes(this.universeDoc)) this.game.refreshUniverse();
      this.syncVisuals().then(() => { this.outliner.render(); this.props.render(); });
      if (e.docs.some(d => d.ini.first && d.ini.first('Background'))) { /* background may have changed */ }
    }
    if (e.docs.some(d => d instanceof DllDoc)) this.refreshNames();
    if (this._basesRefresh && e.docs.some(d => d instanceof DllDoc || (d.key && /^file:.*missions\/(mbases|news)\.ini$/i.test(d.key)))) this._basesRefresh();
    if (this.sys && ((e.docs.includes(this.sys) && this.fields.signature(this.sys) !== this.fields.sig) || e.docs.some(d => this.fields.items.some(i => i.doc === d)))) {
      clearTimeout(this._fieldT); this._fieldT = setTimeout(() => this.fields.build(this.sys), 250);
    }
    if (e.docs.includes(this.sys)) { this.paths.build(this.sys); this.rings.build(this.sys); }
    if (this.trade && this.trade.nodes) {
      if (e.docs.some(d => this.trade.marketDocs.includes(d))) { this.trade.readMarkets(); this.trade.cache = null; if (this.trade.onChange) this.trade.onChange(); }
      if (e.docs.some(d => d instanceof Object && d.sys && d.objects) || e.docs.includes(this.universeDoc)) this.trade.graphDirty = true;
    }
    if (e.docs.some(d => d.key && /^file:.*solar\/rings\//i.test(d.key))) this.rings.build(this.sys, true);
    if (!e.docs.includes(this.sys) && e.docs.some(d => d.key && d.key.startsWith('file:') && this.fields.items.some(i => i.doc === d))) this.props.render();
    if ((e.undo || e.redo) && this._shipRefresh) this._shipRefresh();
    if ((e.undo || e.redo) && this._missionRefresh) this._missionRefresh();
    for (const f of this.dialogRefreshers) { try { f(e); } catch (err) { console.warn(err); } }
    if (e.undo || e.redo) this.status.msg(e.label);
    if (this.currentView === 'universe') this.universeMap.draw();
  }
  edit(label, fn, docs = [this.sys]) { return this.history.do(label, docs, fn); }
  showGuide(anchor = '', page = 'guide.html') {
    const m = modal({ title: page === 'manual.html' ? 'User manual' : 'Reference guide', wide: true, body: h('iframe', { src: page + '?theme=dark' + (anchor ? '#' + anchor : ''), style: { width: '100%', height: '74vh', border: '0', borderRadius: '6px', background: '#0d1117' } }), buttons: [{ label: 'Close' }] });
    m.box.classList.add('xwide');
  }

  updateDocState() {
    const n = this.history.dirty.size;
    $('#docstate').innerHTML = '';
    $('#docstate').append(n ? h('span', { class: 'dirty', title: [...this.history.dirty].map(d => d.label || d.path).join('\n') }, `● ${n} unsaved file${n > 1 ? 's' : ''} — Ctrl+S`) : h('span', {}, 'All changes saved'));
    if (this.systemsList) this.systemsList.render();
  }

  async save() {
    const dirty = [...this.history.dirty];
    if (!dirty.length) { toast('Nothing to save'); return; }
    let ok = 0;
    for (const d of dirty) {
      if ((d.isNew || d.ini.missing) && !d.ini.sections.length) { this.history.dirty.delete(d); continue; }
      try { await api.write(d.path, d.ini.toBytes()); this.history.markSaved(d); d.ini.missing = false; ok++; }
      catch (e) { this.status.msg(`Save failed: ${d.path}: ${e.message}`, 'err'); }
    }
    this.updateDocState();
    this.status.msg(`Saved ${ok} file${ok === 1 ? '' : 's'} (originals backed up to editor_backups\\${this.cfg.session})`, 'ok');
    toast(`Saved ${ok} file${ok === 1 ? '' : 's'}`);
    if (this.settings.patchTracking && ok) import('./ui/updatepatch.js').then(m => m.afterSave(this)); // optional: keep the update patch current
  }
  async reloadSystem() {
    if (this.history.dirty.has(this.sys) && !await confirmDialog('Reload system', 'Discard unsaved changes to this system?', 'Discard', true)) return;
    this.history.dirty.delete(this.sys);
    this.systemDocs.delete(this.sys.nickname.toLowerCase());
    this.history.undoStack = this.history.undoStack.filter(e => !e.before.some(([d]) => d === this.sys));
    await this.openSystem(this.sys.nickname);
  }

  // ------------------------------------------------------------------ selection
  isSelected(id) { return this.selection.includes(id); }
  // the infocard style this mod uses (majority over its cards), for new infocards; recounted when cards change
  infocardStyle() {
    const n = this.game.infocards.size;
    if (!this._rdlStyle || this._rdlStyleN !== n) { this._rdlStyle = modDialect(this.game.infocards.values()); this._rdlStyleN = n; }
    return this._rdlStyle;
  }
  // ---- per-item hiding (eye buttons in the outliner): view only, never written to the INI; remembered per system by nickname
  hiddenKey(doc) { return 'fled.hidden.' + String(doc.nickname).toLowerCase(); }
  loadHidden(doc) {
    this.hidden = new Set(); let list = [];
    try { list = JSON.parse(localStorage.getItem(this.hiddenKey(doc)) || '[]'); } catch { }
    for (const n of list) { const s = doc.byNick(n); if (s) this.hidden.add(s.id); }
  }
  saveHidden() {
    if (!this.sys) return; const k = this.hiddenKey(this.sys);
    const nicks = this.sys.entities.filter(s => this.hidden.has(s.id)).map(s => (s.get('nickname') || '').toLowerCase()).filter(Boolean);
    try { nicks.length ? localStorage.setItem(k, JSON.stringify(nicks)) : localStorage.removeItem(k); } catch { }
  }
  isHidden(id) { return !!this.hidden && this.hidden.has(id); }
  // not drawn: the item's own eye is off, its kind or category is switched off (ui/visibility.js), or
  // "draw only listed" is on and the Outliner does not list it
  notShown(id) {
    if (this.isHidden(id)) return true;
    const s = this.sys && this.sys.byId(id); if (!s) return false;
    if (!layerOn(this, s)) return true;
    return !!(this.isolate && !this.isolate.has(id));
  }
  refreshVisibility() { saveSettings(this.settings); this.viewport.applyAllFilters(); this.outliner.render(); this.viewport.poke(); }
  // H: hide the selection
  hideSelection() { if (this.selection.length) this.setHidden([...this.selection], true); }
  // Shift+H: hide everything else (the selection's categories are switched on so it stays visible)
  hideUnselected() {
    if (!this.sys || !this.selection.length) return;
    const keep = new Set(this.selection);
    for (const id of keep) { const s = this.sys.byId(id); if (!s) continue; const k = entityKind(s); setKind(this, k, true); setGroup(this, k, groupOf(this, s), true); }
    if (!this.hidden) this.hidden = new Set();
    for (const s of this.sys.entities) keep.has(s.id) ? this.hidden.delete(s.id) : this.hidden.add(s.id);
    this.isolate = null; markCustomView(this); this.saveHidden(); this.refreshVisibility();
  }
  // Alt+H: show everything again (view Everything, all item eyes on, "draw only listed" off)
  showAll() {
    this.isolate = null; this.outliner.isolate = false;
    if (this.hidden && this.hidden.size) { this.hidden.clear(); this.saveHidden(); }
    applyViewPreset(this, VIEW_BUILTIN.find(p => p.id === 'all'));
  }
  setHidden(ids, hide) {
    if (!this.hidden) this.hidden = new Set();
    for (const id of ids) hide ? this.hidden.add(id) : this.hidden.delete(id);
    this.saveHidden(); this.viewport.applyAllFilters(); this.outliner.render(); this.viewport.poke();
  }
  select(id, additive = false) {
    if (id == null) { if (!additive) this.selection = []; }
    else if (additive) this.selection = this.isSelected(id) ? this.selection.filter(x => x !== id) : [...this.selection, id];
    else this.selection = [id];
    this.afterSelect();
  }
  // base of the selected object (base = / dock_with), else the first base of the open system
  currentBaseNick() {
    const s = this.selected()[0]; const b = s && (s.get('base') || s.get('dock_with'));
    if (b) return b;
    const sb = this.sys && this.game.bases.find(x => (x.system || '').toLowerCase() === this.sys.nickname.toLowerCase());
    return sb ? sb.nickname : '';
  }
  selectMany(ids) { this.selection = ids; this.afterSelect(); }
  afterSelect() {
    this.viewport.showSelection(this.selection);
    if (this.paths) { const s0 = this.selected()[0]; const pl = s0 && pathLabel(s0); this.paths.highlight = pl ? pl.label.toLowerCase() : null; this.paths.build(this.sys); }
    this.outliner.highlight();
    this.props.render();
    const n = this.selection.length;
    $('#st-sel').textContent = n ? `${n} selected` : '';
  }
  selected() { return this.selection.map(id => this.sys.byId(id)).filter(Boolean); }
  selectSameArchetype() {
    const s = this.selected()[0]; if (!s) return;
    const a = (s.get('archetype') || '').toLowerCase();
    this.selectMany(this.sys.objects.filter(o => (o.get('archetype') || '').toLowerCase() === a).map(o => o.id));
  }

  // ------------------------------------------------------------------ editing
  commitTransforms(items) {
    this.edit(items.length > 1 ? `Transform ${items.length} entities` : 'Transform', () => {
      for (const it of items) { const s = this.sys.byId(it.id); if (!s) continue; setPos(s, it.pos); if (s.has('rotate') || it.rot.some(r => Math.abs(r) > 0.01)) setRot(s, it.rot); }
    });
  }
  onLiveTransform() { this.props.liveTransform(); }

  placePoint(e) { return e ? this.viewport.groundPoint(e) : this.viewport.orbit.target.clone(); }
  addObjectAt(arch, p, extra = {}) {
    const sec = this.edit('Add object', () => this.sys.addObject(arch, [p.x, p.y, p.z], extra));
    this.selectAfterSync([sec.id]);
    return sec;
  }
  addZoneAt(shape, p, size, extra) { const sec = this.edit('Add zone', () => this.sys.addZone(shape, [p.x, p.y, p.z], size, extra)); this.selectAfterSync([sec.id]); return sec; }
  addLightAt(p) { const sec = this.edit('Add light', () => this.sys.addLight([p.x, p.y, p.z])); this.selectAfterSync([sec.id]); return sec; }
  selectAfterSync(ids) { setTimeout(() => this.selectMany(ids), 60); }

  async deleteSelected() {
    const secs = this.selected(); if (!secs.length) return;
    const refs = secs.flatMap(s => this.sys.references(s.get('nickname') || '').filter(r => !secs.includes(r.section)));
    if (refs.length && !await confirmDialog('Delete', `${secs.length} entit${secs.length > 1 ? 'ies are' : 'y is'} referenced ${refs.length} time(s) in this system:\n\n` + refs.slice(0, 12).map(r => `[${r.section.name}] ${r.section.get('nickname') || ''}: ${r.entry.key} = ${r.entry.value}`).join('\n') + '\n\nTrade lane links and field links are removed automatically. Delete anyway?', 'Delete', true)) return;
    this.edit(`Delete ${secs.length}`, () => { for (const s of secs) this.sys.remove(s); });
    this.selection = [];
    this.status.msg(`Deleted ${secs.length}`);
  }
  duplicateSelected() {
    const secs = this.selected(); if (!secs.length) return;
    const ids = this.edit('Duplicate', () => secs.map(s => this.sys.duplicate(s, [Math.max(300, (this.viewport.visuals.get(s.id)?.userData.radius || 300) * 2.2), 0, 0]).id));
    this.selectAfterSync(ids);
  }
  copy() {
    const secs = this.selected(); if (!secs.length) return;
    this.clipboard = { from: this.sys.nickname, sections: secs.map(s => s.clone()) };
    try { navigator.clipboard.writeText(secs.map(s => s.text('\r\n')).join('\r\n\r\n')).catch(() => { }); } catch { }
    toast(`Copied ${secs.length}`);
  }
  paste(at) {
    if (!this.clipboard) return;
    const src = this.clipboard.sections;
    const c = new THREE.Vector3(); src.forEach(s => c.add(new THREE.Vector3(...getPos(s)))); c.divideScalar(src.length);
    const target = at || this.viewport.orbit.target;
    const sameSys = this.clipboard.from === this.sys.nickname;
    const ids = this.edit(`Paste ${src.length}`, () => {
      const renames = new Map();
      const out = src.map(s => {
        const n = s.clone();
        const oldNick = s.get('nickname') || 'pasted';
        let nick = oldNick;
        if (!sameSys) nick = oldNick.replace(new RegExp('^' + this.clipboard.from, 'i'), this.sys.nickname);
        nick = this.sys.uniqueNick(nick);
        renames.set(oldNick.toLowerCase(), nick);
        n.set('nickname', nick);
        const p = getPos(s); n.set('pos', fmtVec([p[0] - c.x + target.x, p[1] - c.y + target.y, p[2] - c.z + target.z], 0));
        const after = this.sys.insertAfterKind(kindOf(n));
        const idx = after ? this.sys.ini.sections.indexOf(after) + 1 : this.sys.ini.sections.length;
        if (n.lines.length && n.lines[n.lines.length - 1].type === 'entry') n.lines.push({ type: 'other', raw: '' });
        this.sys.ini.insertSection(n, idx);
        return n;
      });
      // remap links among pasted set; drop links to things not pasted
      for (const n of out) for (const k of ['prev_ring', 'next_ring', 'parent']) {
        const v = n.get(k); if (!v) continue;
        if (renames.has(v.toLowerCase())) n.set(k, renames.get(v.toLowerCase())); else if (!sameSys || k !== 'parent') n.remove(k);
      }
      for (const n of out) { n.remove('base'); n.remove('dock_with'); }
      return out.map(n => n.id);
    });
    this.selectAfterSync(ids);
  }
  renameEntity(sec, newNick) {
    const old = sec.get('nickname');
    if (!newNick || newNick === old) return;
    if (this.sys.byNick(newNick) && this.sys.byNick(newNick) !== sec) { toast('Nickname already used in this system'); return; }
    this.edit('Rename', () => { sec.set('nickname', newNick); if (old) this.sys.renameRefs(old, newNick); });
    this.renameCrossRefs(old, newNick);
  }
  async renameCrossRefs(old, nick) {
    // gotos in other systems pointing at this object
    const docs = await this.loadAllSystemDocs();
    const touched = [];
    for (const d of docs) {
      if (d === this.sys) continue;
      for (const o of d.objects) {
        const g = o.vals('goto');
        if (g && g[0] && g[0].toLowerCase() === this.sys.nickname.toLowerCase() && g[1] && g[1].toLowerCase() === (old || '').toLowerCase()) touched.push([d, o, g]);
      }
    }
    if (!touched.length) return;
    this.history.do('Update gotos for rename', [...new Set(touched.map(t => t[0]))], () => {
      for (const [, o, g] of touched) { g[1] = nick; o.set('goto', g.join(', ')); }
    });
    toast(`Updated ${touched.length} jump link(s) in other systems`);
  }
  // ---- resource DLL text (strings / infocards) ----
  setText(kind, id, value) {
    const d = this.game.dllFor(id);
    if (!d) throw new Error(`No DLL loaded for id ${id}`);
    if (!d.editable) throw new Error(`${d.name} is read-only: ${d.readOnlyReason}`);
    const local = parseInt(id) & 0xFFFF;
    this.history.do(`Edit ${kind} ${id}`, [d], () => {
      const map = kind === 'infocard' ? d.infocards : d.strings;
      if (value) map.set(local, value); else map.delete(local);
      d.changed();
    });
  }
  newText(kind, value, dll) {
    const d = dll || this.game.defaultDll(kind);
    if (!d || !d.editable) throw new Error('No editable resource DLL available');
    let gid;
    this.history.do(`New ${kind}`, [d], () => {
      const local = d.allocLocal();
      (kind === 'infocard' ? d.infocards : d.strings).set(local, value);
      d.changed();
      gid = d.globalId(local);
    });
    return gid;
  }
  refreshNames() {
    // names come from the DLLs: update labels, outliner, properties without rebuilding models
    for (const [id, v] of this.viewport.visuals) {
      const sec = this.sys.byId(id); if (!sec) continue;
      v.traverse(o => { if (o.userData.label && o.element && v.userData.kind === 'object') o.element.textContent = this.game.name(sec.get('ids_name')) || sec.get('nickname'); });
    }
    this.outliner.render(); this.systemsList.render(); this.props.render();
    if (this.currentView === 'universe') this.universeMap.draw();
  }

  rebuildPreload() {
    const sec = this.sys.ini.first('Archetype');
    if (!sec) { toast('No [Archetype] section in this system'); return; }
    const used = [...new Set(this.sys.objects.map(o => o.get('archetype')).filter(Boolean).map(a => a.toLowerCase()))];
    const have = new Set(sec.getAll('solar').map(s => s.toLowerCase()));
    const missing = used.filter(a => !have.has(a) && this.game.arch(a));
    this.edit('Rebuild preload list', () => { for (const a of missing) this.sys.ensureArchetypePreload(this.game.arch(a).nickname); });
    toast(`Added ${missing.length} solar archetype(s) to [Archetype]`);
  }
  measure() {
    const s = this.selected();
    if (s.length < 2) { toast('Select two entities (Shift+click)'); return; }
    const a = new THREE.Vector3(...getPos(s[0])), b = new THREE.Vector3(...getPos(s[1]));
    const d = a.distanceTo(b);
    this.status.msg(`Distance ${s[0].get('nickname')} → ${s[1].get('nickname')}: ${Math.round(d)} m (${(d / 1000).toFixed(2)} k)`, 'ok');
  }
  navCell(p) {
    const half = 120000 / (this.sys ? this.sys.sys.navScale : 1), step = half / 4;
    const cx = Math.floor((p.x + half) / step), cz = Math.floor((p.z + half) / step);
    if (cx < 0 || cx > 7 || cz < 0 || cz > 7) return '';
    return `   ${'ABCDEFGH'[cx]}${cz + 1}`;
  }

  onContextMenu(e, hit) {
    const p = this.viewport.groundPoint(e);
    if (hit && !this.isSelected(hit.id)) this.select(hit.id);
    const sel = this.selected();
    contextMenu(e.clientX, e.clientY, [
      { label: 'Add object here…', action: () => dialogs.addObject(this, p) },
      { label: 'Add zone here…', action: () => dialogs.addZone(this, p) },
      { label: 'Add light here', action: () => this.addLightAt(p) },
      this.clipboard ? { label: `Paste ${this.clipboard.sections.length} here`, key: 'Ctrl+V', action: () => this.paste(p) } : null,
      sel.length ? '-' : null,
      sel.length ? { label: 'Focus', key: 'F', action: () => this.viewport.focus(sel[0].id) } : null,
      sel.length && this.revealInIni ? { label: 'Show in INI (VS Code)', key: 'Ctrl+Alt+E', action: () => this.revealInIni(sel[0]) } : null,
      sel.length ? { label: 'Duplicate', key: 'Ctrl+D', action: () => this.duplicateSelected() } : null,
      sel.length ? { label: 'Copy', key: 'Ctrl+C', action: () => this.copy() } : null,
      sel.length ? { label: 'Move to cursor (keep height)', action: () => this.edit('Move to cursor', () => { const s0 = sel[0]; const c = getPos(s0); for (const s of sel) { const q = getPos(s); setPos(s, [q[0] - c[0] + p.x, q[1], q[2] - c[2] + p.z]); } }) } : null,
      sel.length ? { label: 'Delete', key: 'Del', action: () => this.deleteSelected() } : null,
    ]);
  }

  bindKeys() {
    document.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); this.save(); return; } // works in dialogs too
      if (e.key === 'F5' && !document.querySelector('#modal-root .backdrop')) { e.preventDefault(); import('./ui/playtest.js').then(m => m.playtest(this)); return; }
      if (e.key === 'F1') { e.preventDefault(); if (!document.querySelector('#modal-root .backdrop')) this.showGuide(); return; }
      if (document.querySelector('#modal-root .backdrop')) {
        // in dialogs: undo/redo of the shared edit history (dialogs with their own history,
        // like the effect, hardpoint and UTF editors, catch the keys before they get here)
        if (!mod || typing) return;
        const k = e.key.toLowerCase();
        if (k === 'z' && !e.shiftKey) { e.preventDefault(); this.history.undo(); }
        else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); this.history.redo(); }
        return;
      }
      if (typing) return;
      const k = e.key.toLowerCase();
      if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); this.history.undo(); }
      else if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); this.history.redo(); }
      else if (mod && k === 'd') { e.preventDefault(); this.duplicateSelected(); }
      else if (mod && k === 'c') { this.copy(); }
      else if (mod && k === 'v') { this.paste(); }
      else if (mod && e.shiftKey && k === 'f') { e.preventDefault(); import('./ui/refs.js').then(m => m.referencesDialog(this, { q: this.selected()[0] && this.selected()[0].get('nickname') })); }
      else if (mod && k === 'f') { e.preventDefault(); dialogs.find(this); }
      else if (mod && k === 'i') { e.preventDefault(); stringBrowser(this); }
      else if (mod && k === 'b') { e.preventDefault(); basesEditor(this, { base: this.currentBaseNick() }); }
      else if (mod && k === 'm') { e.preventDefault(); tradePlanner(this, { fromSystem: this.sys ? this.sys.nickname.toLowerCase() : '' }); }
      else if (mod && e.altKey && k === 'e' && this.revealInIni) { e.preventDefault(); this.revealInIni(); }
      else if (mod && k === 'a') { e.preventDefault(); this.selectMany(this.sys.entities.filter(s => { const v = this.viewport.visuals.get(s.id); return v && v.visible; }).map(s => s.id)); }
      else if (mod) return;
      else if (k === 'delete' || k === 'backspace') { e.preventDefault(); this.deleteSelected(); }
      else if (k === 'escape') this.select(null);
      else if (k === 'f') { if (this.selection[0] != null) this.viewport.focus(this.selection[0]); }
      else if (k === 'home') this.viewport.frameAll();
      else if (k === 'g') { this.viewport.setMode('translate'); this.buildToolstrip(); }
      else if (k === 'r') { this.viewport.setMode('rotate'); this.buildToolstrip(); }
      else if (k === 'v') { this.viewport.setMode('select'); this.buildToolstrip(); }
      else if (k === 'x') { this.viewport.space = this.viewport.space === 'world' ? 'local' : 'world'; this.viewport.attachGizmo(this.selection); this.buildToolstrip(); }
      else if (k === 't' || e.code === 'Numpad5') this.toggleTop();
      else if (k === 'l') this.cycleLabels();
      else if (k === 'z' && !e.shiftKey) drawZoneTool(this);
      else if (e.shiftKey && k === 'a') dialogs.addObject(this);
      else if (e.code === 'KeyH' && e.altKey) { e.preventDefault(); this.showAll(); }
      else if (e.code === 'KeyH' && e.shiftKey) this.hideUnselected();
      else if (e.code === 'KeyH') this.hideSelection();
    });
  }
}

function loadSettings() {
  try { const s = JSON.parse(localStorage.getItem('fled.settings') || '{}'); return { ...DEFAULT_SETTINGS, ...s, zoneCats: { ...DEFAULT_SETTINGS.zoneCats, ...(s.zoneCats || {}) } }; }
  catch { return structuredClone(DEFAULT_SETTINGS); }
}
export function saveSettings(s) { try { localStorage.setItem('fled.settings', JSON.stringify(s)); } catch { } }

const app = new App();
window.fled = app;
app.boot().catch(e => { console.error(e); overlay(null); const el = document.getElementById('st-msg'); el.textContent = 'Startup failed: ' + (e.message || e); el.className = 'err'; });
