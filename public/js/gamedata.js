// Loads the shared game tables the system editor needs.
import { api, dataPath, norm } from './api.js';
import { IniDocument } from './formats/ini.js';
import { infocardToText } from './formats/resources.js';
import { DllDoc } from './dlldoc.js';

export async function loadIni(path) {
  const b = await api.read(path);
  if (!b) return null;
  return IniDocument.fromBytes(b, path);
}

export class GameData {
  constructor() {
    this.archetypes = new Map(); // lower nickname -> info
    this.stars = new Map();
    this.starGlows = new Map();
    this.starSpines = new Map(); this.lensFlares = new Map(); this.lensGlows = new Map();
    this.loadouts = [];
    this.factions = [];
    this.music = [];
    this.spacedust = [];
    this.gateTunnels = [];
    this.loadoutEquip = new Map();  // loadout nickname -> [[equipment, hardpoint], ...]
    this.equipIds = new Map();      // equipment nickname -> ids_name (all equipment files)
    this.attachedFx = new Map();    // [AttachedFX] nickname -> particles (effect nickname)
    this.fxEffects = new Map();     // [Effect] nickname -> { vis }
    this.visEffects = new Map();    // [VisEffect] nickname -> { alchemy, textures, crc }
    this.effectShapeFiles = [];
    this.asteroids = new Map();        // asteroidarch [Asteroid]/[AsteroidMine]
    this.dynamicAsteroids = new Map(); // asteroidarch [DynamicAsteroid]
    this.panelCache = new Map();
    this.jumpEffects = [];
    this.systems = [];           // universe [System] sections
    this.bases = [];
    this.strings = new Map();
    this.infocards = new Map();
    this.universe = null;        // IniDocument
    this.fieldCache = new Map();
    this.warnings = [];
  }

  async load(progress = () => { }) {
    progress('Reading freelancer.ini');
    this.flIni = await loadIni('EXE/freelancer.ini');
    if (!this.flIni) this.warnings.push('EXE/freelancer.ini not found — using default data paths');
    const dataSec = this.flIni && this.flIni.first('Data');
    const dget = (k) => dataSec ? dataSec.getAll(k) : [];
    const solarFiles = dget('solar').length ? dget('solar') : ['solar\\solararch.ini'];
    const starFiles = dget('stars').length ? dget('stars') : ['solar\\stararch.ini'];
    this.starArchFiles = starFiles;
    const loadoutFiles = dget('loadouts').length ? dget('loadouts') : ['solar\\loadouts.ini'];
    this.universePath = dataPath((dget('universe')[0]) || 'universe\\universe.ini');

    progress('Reading universe');
    this.universe = await loadIni(this.universePath);
    if (!this.universe) throw new Error('universe.ini not found at ' + this.universePath);
    this.refreshUniverse();

    progress('Reading archetypes');
    await Promise.all([
      ...solarFiles.map(async f => { const d = await loadIni(dataPath(f)); if (d) this.readSolarArch(d); }),
      ...starFiles.map(async f => { const d = await loadIni(dataPath(f)); if (d) { this.readStarArch(d); this.starDocs = this.starDocs || []; this.starDocs.push({ file: f, doc: d }); } }),
      ...loadoutFiles.map(async f => { const d = await loadIni(dataPath(f)); if (d) for (const s of d.all('Loadout')) { const n = s.get('nickname'); if (n) { this.loadouts.push(n); this.loadoutEquip.set(n.toLowerCase(), s.getAll('equip').map(v => v.split(',').map(x => x.trim()))); } } }),
      ...(dget('equipment').length ? dget('equipment') : ['equipment\\select_equip.ini']).map(async f => {
        const d = await loadIni(dataPath(f)); if (!d) return;
        for (const s of d.all('AttachedFX')) { const n = s.get('nickname'), pt = s.get('particles'); if (n && pt) this.attachedFx.set(n.toLowerCase(), pt); }
        for (const s of d.sections) { const n = s.get('nickname'), id = parseInt(s.get('ids_name') || '0'); if (n && id) this.equipIds.set(n.toLowerCase(), id); }
      }),
      ...(dget('asteroids').length ? dget('asteroids') : ['solar\\asteroidarch.ini']).map(async f => {
        const d = await loadIni(dataPath(f)); if (!d) return;
        for (const s of d.sections) {
          const n = s.get('nickname'); if (!n) continue;
          if (s.is('Asteroid') || s.is('AsteroidMine')) this.asteroids.set(n.toLowerCase(), { nickname: n, da: s.get('DA_archetype'), matLibs: s.getAll('material_library'), mine: s.is('AsteroidMine') });
          else if (s.is('DynamicAsteroid')) this.dynamicAsteroids.set(n.toLowerCase(), { nickname: n, da: s.get('DA_archetype'), matLibs: s.getAll('material_library') });
        }
      }),
      (async () => { const d = await loadIni(dataPath(dget('effect_shapes')[0] || 'fx\\effect_shapes.ini')); if (d) for (const s of d.all('Texture')) { const f = s.get('file'); if (f) this.effectShapeFiles.push(f); } })(),
      (async () => { const d = await loadIni(dataPath('initialworld.ini')); if (d) for (const s of d.all('Group')) this.factions.push({ nickname: s.get('nickname'), ids: parseInt(s.get('ids_name') || '0') }); })(),
      (async () => { const d = await loadIni(dataPath('audio\\music.ini')); if (d) for (const s of d.all('Sound')) { const n = s.get('nickname'); if (n) this.music.push(n); } })(),
      (async () => { for (const f of dget('gate_tunnels').length ? dget('gate_tunnels') : ['fx\\gate_tunnel.ini']) { const d = await loadIni(dataPath(f)); if (d) for (const s of d.sections) { const n = s.get('nickname'); if (n) this.gateTunnels.push(n); } } })(),
      (async () => { for (const f of dget('jump_effect').length ? dget('jump_effect') : ['fx\\jumpeffect.ini']) { const d = await loadIni(dataPath(f)); if (d) for (const s of d.sections) { const n = s.get('nickname'); if (n) this.jumpEffects.push(n); } } })(),
      (async () => {
        for (const f of dget('effects').length ? dget('effects') : ['fx\\effects.ini']) {
          const d = await loadIni(dataPath(f)); if (!d) continue;
          for (const s of d.sections) {
            const n = s.get('nickname'); if (!n) continue;
            if (/dust|atmosphere|nebula|debris/i.test(n) && s.is('Effect')) this.spacedust.push(n);
            if (s.is('Effect')) this.fxEffects.set(n.toLowerCase(), { vis: s.get('vis_effect') });
            else if (s.is('VisEffect')) this.visEffects.set(n.toLowerCase(), { alchemy: s.get('alchemy'), textures: s.getAll('textures'), crc: (parseInt(s.get('effect_crc') || '0') >>> 0) });
          }
        }
      })(),
    ]);
    this.loadouts.sort((a, b) => a.localeCompare(b));
    this.music.sort((a, b) => a.localeCompare(b));
    progress('Reading names');
    await this.loadResources();
  }

  refreshUniverse() {
    // keep object identity per nickname so open documents keep pointing at the same record
    const prev = new Map((this.systems || []).map(s => [s.nickname.toLowerCase(), s]));
    this.systems = this.universe.all('System').map(s => {
      const nick = s.get('nickname'); if (!nick) return null;
      const o = prev.get(nick.toLowerCase()) || {};
      return Object.assign(o, {
        section: s, nickname: nick, file: s.get('file'),
        pos: (s.vals('pos') || ['0', '0']).map(parseFloat), navScale: parseFloat(s.get('NavMapScale') || '1') || 1,
        strid: parseInt(s.get('strid_name') || '0'),
        labelOnly: !s.get('file'), // a [System] without a file: a name on the universe map only (Discovery's sector labels)
      });
    }).filter(Boolean);
    this.bases = this.universe.all('Base').map(s => ({ section: s, nickname: s.get('nickname'), system: s.get('system'), file: s.get('file'), strid: parseInt(s.get('strid_name') || '0') })).filter(b => b.nickname);
  }

  systemFilePath(sys) { // universe paths are relative to the universe.ini folder
    const dir = norm(this.universePath).split('/').slice(0, -1).join('/');
    return dir + '/' + norm(sys.file);
  }
  findSystem(nick) { if (!nick) return null; nick = nick.toLowerCase(); return this.systems.find(s => s.nickname.toLowerCase() === nick); }
  findBase(nick) { if (!nick) return null; nick = nick.toLowerCase(); return this.bases.find(s => s.nickname.toLowerCase() === nick); }

  readSolarArch(doc) {
    for (const s of doc.sections) {
      if (!s.is('Solar')) continue;
      const nick = s.get('nickname'); if (!nick) continue;
      this.archetypes.set(nick.toLowerCase(), {
        nickname: nick, type: (s.get('type') || '').toUpperCase(), da: s.get('DA_archetype'),
        matLibs: s.getAll('material_library'), radius: parseFloat(s.get('solar_radius') || '0'),
        ids: parseInt(s.get('ids_name') || '0'), section: s,
        loadout: s.get('loadout'), dockable: s.findAll('docking_sphere').length > 0,
      });
    }
  }
  readStarArch(doc) {
    for (const s of doc.sections) {
      const nick = s.get('nickname'); if (!nick) continue;
      if (s.is('Star')) this.stars.set(nick.toLowerCase(), { nickname: nick, radius: parseFloat(s.get('radius') || '1000'), glow: s.get('star_glow'), center: s.get('star_center'), section: s });
      else if (s.is('star_glow')) this.starGlows.set(nick.toLowerCase(), { nickname: nick, shape: s.get('shape'), scale: parseFloat(s.get('scale') || '1'), inner: (s.vals('inner_color') || [1, 1, 1]).map(parseFloat), outer: (s.vals('outer_color') || [1, 1, 1]).map(parseFloat), section: s });
      else if (s.is('spines')) {
        // spine = length, width, inner r, g, b, outer r, g, b, alpha  (FUN_0050fba0)
        const items = s.findAll('spine').map(e => { const v = e.values.map(parseFloat); return { length: v[0] || 0, width: v[1] || 0, inner: [v[2], v[3], v[4]].map(x => isNaN(x) ? 1 : x), outer: [v[5], v[6], v[7]].map(x => isNaN(x) ? 1 : x), alpha: isNaN(v[8]) ? 1 : v[8] }; });
        this.starSpines.set(nick.toLowerCase(), { nickname: nick, shape: s.get('shape'), scale: parseFloat(s.get('radius_scale') || '1'), min: parseFloat(s.get('min_radius') || '0'), max: parseFloat(s.get('max_radius') || '1e9'), items, section: s });
      } else if (s.is('lens_flare')) {
        // bead = position along sun→centre (×3), size × radius, r, g, b, alpha  (FUN_0050f3a0 / FUN_0050f850)
        this.lensFlares.set(nick.toLowerCase(), { nickname: nick, shape: s.get('shape'), min: parseFloat(s.get('min_radius') || '0'), max: parseFloat(s.get('max_radius') || '1e9'), beads: s.findAll('bead').map(e => e.values.map(parseFloat)), section: s });
      } else if (s.is('lens_glow')) {
        this.lensGlows.set(nick.toLowerCase(), { nickname: nick, shape: s.get('shape'), scale: parseFloat(s.get('radius_scale') || '1'), inner: (s.vals('inner_color') || [1, 1, 1]).map(parseFloat), outer: (s.vals('outer_color') || [1, 1, 1]).map(parseFloat), section: s });
      }
      else if (s.is('Texture')) { this.starTextures = this.starTextures || []; this.starTextures.push(...s.getAll('file')); }
    }
  }
  arch(nick) { return nick ? this.archetypes.get(nick.toLowerCase()) : null; }

  async loadResources() {
    const dlls = ['resources.dll'];
    const res = this.flIni && this.flIni.first('Resources');
    if (res) dlls.push(...res.getAll('DLL').map(d => d.trim()).filter(Boolean));
    this.resourceDlls = dlls;
    this.dllDocs = [];
    // Freelancer.exe (FUN_005b0c30) appends every [Resources] DLL even if LoadLibraryA fails, so the
    // index of each DLL — and therefore the high word of every id — is its position in this list.
    await Promise.all(dlls.map(async (dll, i) => {
      const path = 'EXE/' + dll;
      const b = await api.read(path);
      if (!b) { this.warnings.push(`Resource DLL ${dll} not found — ids ${i << 16}…${(i << 16) | 0xFFFF} will show as unknown`); return; }
      try {
        const d = new DllDoc(i, dll, path, b);
        d.onChange(() => this.syncDll(d));
        this.dllDocs[i] = d;
        this.syncDll(d);
      } catch (e) { console.warn('resource parse', dll, e); this.warnings.push(`Could not read ${dll}: ${e.message}`); }
    }));
  }
  syncDll(d) {
    const idx = d.index;
    for (const k of [...this.strings.keys()]) if ((k >>> 16) === idx) this.strings.delete(k);
    for (const k of [...this.infocards.keys()]) if ((k >>> 16) === idx) this.infocards.delete(k);
    for (const [k, v] of d.strings) if (v) this.strings.set((idx << 16) | k, v);
    for (const [k, v] of d.infocards) if (v) this.infocards.set((idx << 16) | k, v);
  }
  dllFor(id) { return this.dllDocs[(parseInt(id) >>> 16)] || null; }
  editableDlls() { return this.dllDocs.filter(d => d && d.editable); }
  // default target DLLs for new text: the editable DLL that already holds the most of that kind
  defaultDll(kind) {
    const pick = this.editableDlls().sort((a, b) => (kind === 'infocard' ? b.infocards.size - a.infocards.size : b.strings.size - a.strings.size));
    return pick[0] || null;
  }
  name(id) { id = parseInt(id); return id ? this.strings.get(id) || null : null; }
  infocard(id) { id = parseInt(id); if (!id) return ''; return infocardToText(this.infocards.get(id) || '') || this.strings.get(id) || ''; }

  // TexturePanels (shapes) file → { files:[txm], shapes: Map(lower name → {texture, x,y,w,h}) }
  // TexturePanels files ([Texture] file/texture_name/shape_name+dim/tex_shape, [Shape])
  async texturePanels(file) {
    const k = file.toLowerCase();
    if (!this.panelCache.has(k)) this.panelCache.set(k, (async () => {
      const d = await loadIni(dataPath(file));
      const out = { files: [], shapes: new Map() };
      if (!d) return out;
      let shapeTex = '';
      for (const s of d.sections) {
        if (s.is('Shape')) { const n = s.get('name'); if (n) out.shapes.set(n.toLowerCase(), { texture: shapeTex, x: s.num('x'), y: s.num('y'), w: s.num('w', 1), h: s.num('h', 1), px: true }); continue; }
        if (!s.is('Texture')) continue;
        let tex = null; const E = s.entries;
        for (let i = 0; i < E.length; i++) {
          const key = E[i].key.toLowerCase(), v = E[i].values;
          if (key === 'file') out.files.push(v[0]);
          else if (key === 'texture_name') tex = v[0];
          else if (key === 'tex_shape') out.shapes.set(v[0].toLowerCase(), { texture: v[0], x: 0, y: 0, w: 1, h: 1 });
          else if (key === 'shape_name') {
            let dim = [0, 0, 1, 1];
            if (E[i + 1] && E[i + 1].key.toLowerCase() === 'dim') { dim = E[i + 1].values.map(parseFloat); i++; }
            out.shapes.set(v[0].toLowerCase(), { texture: tex || v[0], x: dim[0], y: dim[1], w: dim[2], h: dim[3] });
          } else if (key === 'name') shapeTex = v[0];
        }
      }
      return out;
    })());
    return this.panelCache.get(k);
  }

  // [Asteroids]/[Nebula] referenced field file info (tint for zone display)
  // encounter archetypes = files in DATA\MISSIONS\ENCOUNTERS (nickname = file name, as in vanilla)
  async encounterList() {
    if (!this._encList) this._encList = api.ls(dataPath('missions\\encounters')).then(l => l.filter(f => !f.dir && /\.ini$/i.test(f.name)).map(f => f.name.replace(/\.ini$/i, '')).sort());
    return this._encList;
  }
  // short summary of an encounter file: behaviour, arrival, ship classes
  async encounterInfo(file) {
    const k = file.toLowerCase();
    if (!this._encInfo) this._encInfo = new Map();
    if (!this._encInfo.has(k)) this._encInfo.set(k, loadIni(dataPath(file)).then(d => {
      if (!d) return null;
      const f = d.first('EncounterFormation'); if (!f) return { text: '' };
      const ships = f.findAll('ship_by_class').map(e => { const v = e.values; return `${v[0] === v[1] ? v[0] : v[0] + '–' + v[1]}× ${v[2]}`; });
      return { behavior: f.get('behavior'), arrival: (f.vals('arrival') || []).join(', '), ships, makeClass: f.getAll('make_class'), text: [f.get('behavior'), ships.join(' + ')].filter(Boolean).join(' · ') };
    }));
    return this._encInfo.get(k);
  }
  factionName(nick) { const f = this.factions.find(x => (x.nickname || '').toLowerCase() === (nick || '').toLowerCase()); return f ? this.name(f.ids) : null; }

  async fieldInfo(file) {
    const k = file.toLowerCase();
    if (!this.fieldCache.has(k)) this.fieldCache.set(k, (async () => {
      const d = await loadIni(dataPath(file));
      if (!d) return null;
      const fog = d.first('Fog');
      const field = d.first('Field');
      let color = null;
      if (fog && fog.vals('color')) color = fog.vals('color').map(x => parseFloat(x) / 255);
      else if (field && field.vals('diffuse_color')) color = field.vals('diffuse_color').map(x => parseFloat(x) / 255);
      const cubes = d.all('Cube').flatMap(c => c.getAll('asteroid').map(a => a.split(',')[0].trim()));
      return { color, fogDistance: fog ? parseFloat(fog.get('distance') || '0') : 0, cubes, doc: d };
    })());
    return this.fieldCache.get(k);
  }
}
