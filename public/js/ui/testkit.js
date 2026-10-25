// In-game test kit (Help menu): one small, clearly visible change per editor, all at Planet Manhattan (Li01)
// so a new game or a save docked there shows them within minutes. Takes a snapshot first; "Revert" restores it.
// Each change goes through the same code the editors use (INI docs + history + save, DLL rebuild, UTF writer,
// DXT encoder, THN text writer), so a pass in the game verifies those writers end to end.
// The checklist (pass / fail / note per item) is saved in the browser and as <install>\editor_testkit_report.txt.
import * as THREE from 'three';
import { h, modal, toast, confirmDialog } from './dom.js';
import { api, dataPath } from '../api.js';
import { textToRdl } from '../formats/dll.js';
import { textToRdlStyled } from './rdl.js';
import { parseUtf, writeUtf, UtfNode } from '../formats/utf.js';
import { rgbaToFlDDS } from '../formats/texcodec.js';
import { globalsToLua, LuaTable } from '../formats/thorn.js';
import { parseThn } from './thnplayer.js';
import { snapApi } from './snapshots.js';

const KEY = 'fled.testkit';
const lc = (s) => String(s || '').toLowerCase();
const BASE = 'Li01_01_Base';
const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } };
const store = (st) => { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch { } };

// a 256×256 magenta/white checker with "FL TEST" — unmistakable on a model
function testTexture() {
  const cv = document.createElement('canvas'); cv.width = cv.height = 256; const g = cv.getContext('2d');
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { g.fillStyle = (x + y) % 2 ? '#ff2bd6' : '#ffffff'; g.fillRect(x * 32, y * 32, 32, 32); }
  g.fillStyle = '#000'; g.font = 'bold 54px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('FL TEST', 128, 128);
  return { w: 256, h: 256, rgba: new Uint8Array(g.getImageData(0, 0, 256, 256).data.buffer) };
}

// ---- the steps. apply(ctx) returns the line telling the player what to look for.
const STEPS = [
  { id: 'object', area: 'System editor + names & infocards (DLL)', async apply({ app }) {
    const doc = await app.loadSystemDoc('Li01');
    const ring = doc.objects.find(o => lc(o.get('nickname')) === 'dock_ring_li01_01') || doc.objects.find(o => lc(o.get('dock_with')) === lc(BASE));
    const p = ring ? ring.vec('pos', [0, 0, 0]) : [-33267, 0, -28810];
    const d = Math.hypot(p[0], p[2]) || 1, pos = [p[0] - p[0] / d * 1500, p[1] + 150, p[2] - p[2] / d * 1500];
    const ids = app.newText('string', 'FL Editor Test Buoy');
    const info = app.newText('infocard', textToRdlStyled('If you can read this, the editor\'s resource DLL writer works.\nPlaced by the in-game test kit.', app.infocardStyle ? app.infocardStyle() : null, textToRdl));
    app.history.do('Test kit: buoy', [doc], () => doc.addObject('nav_buoy', pos, { nickname: 'Li01_fled_test_buoy', ids_name: ids, ids_info: info, visit: 0 }));
    return `Launch from Manhattan: a nav buoy named “FL Editor Test Buoy” about 1.5 km from the docking ring (contact list). Select it — its info text says the DLL writer works.`;
  } },
  { id: 'material', area: 'Materials & textures (UTF writer, DXT encoder)', async apply({ app }) {
    const a = app.game.arch('nav_buoy'); if (!a || !a.da) throw new Error('nav_buoy archetype not found');
    const model = await app.rm.model(dataPath(a.da), a.matLibs.map(dataPath));
    const names = new Set(); model.traverse(o => { if (o.isMesh) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.name && names.add(lc(m.name))); });
    for (const lib of [...a.matLibs.map(dataPath), dataPath(a.da)]) {
      const bytes = await api.read(lib); if (!bytes) continue;
      const root = parseUtf(bytes); (function own(n) { if (n.isLeaf) n.data = n.data.slice(); else n.children.forEach(own); })(root);
      const ml = root.child('Material library'); if (!ml) continue;
      const mats = (ml.children || []).filter(m => !m.isLeaf && names.has(lc(m.name))); if (!mats.length) continue;
      const enc = rgbaToFlDDS(testTexture().rgba, 256, 256);
      const tname = 'fled_test_checker.tga', s = new TextEncoder().encode(tname), sb = new Uint8Array((s.length + 4) & ~3); sb.set(s);
      for (const mat of mats) {
        const set = (k, data) => { let c = mat.child(k); if (!c) mat.children.push(c = new UtfNode(k, data)); else c.data = data; };
        set('Dc', new Uint8Array(new Float32Array([1, 0.55, 1]).buffer));
        set('Dt_name', sb); if (!mat.child('Dt_flags')) set('Dt_flags', new Uint8Array(new Uint32Array([64]).buffer));
      }
      let tl = root.child('Texture library'); if (!tl) root.children.push(tl = new UtfNode('Texture library'));
      tl.children = tl.children.filter(t => lc(t.name) !== tname); const tn = new UtfNode(tname); tn.children.push(new UtfNode('MIPS', enc.bytes)); tl.children.push(tn);
      await api.write(lib, writeUtf(root)); app.rm.invalidate(lib);
      const mat = { name: mats.map(m => m.name).join(', ') };
      return `The test buoy (and every nav buoy in the game) is covered in a pink/white checker with “FL TEST” (other models sharing these materials too) — material(s) ${mat.name} in ${lib.split('/').pop()} (pink-tinted colour + new texture).`;
    }
    throw new Error('no material of nav_buoy found in its libraries');
  } },
  { id: 'market', area: 'Markets (INI writer)', async apply({ app }) {
    const doc = await app.otherDoc(dataPath('EQUIPMENT/market_commodities.ini'));
    const sec = doc.ini.all('BaseGood').find(s => lc(s.get('base')) === lc(BASE)); if (!sec) throw new Error('Manhattan has no [BaseGood] in market_commodities.ini');
    const e = sec.findAll('MarketGood').find(x => x.values.length >= 7 && parseFloat(x.values[6]) > 0); if (!e) throw new Error('no MarketGood line with a price multiplier');
    const v = e.values.slice(), old = parseFloat(v[6]), nu = +(old * 3).toFixed(2);
    const goods = await app.otherDoc(dataPath('EQUIPMENT/goods.ini'));
    const gs = goods && goods.ini.all('Good').find(s => lc(s.get('nickname')) === lc(v[0])); const base = gs ? parseFloat(gs.get('price')) : null;
    app.history.do('Test kit: market price', [doc], () => { v[6] = String(nu); e.value = v.join(', '); e.raw = null; });
    return `Manhattan commodity dealer: ${v[0]} costs 3× its usual price — about ${base ? Math.round(base * nu) + ' credits' : nu + '× base price'} instead of ${base ? Math.round(base * old) : old + '×'}.`;
  } },
  { id: 'news', area: 'Bar news (INI + strings)', async apply({ app }) {
    const doc = await app.otherDoc(dataPath('MISSIONS/news.ini'));
    const head = app.newText('string', 'FL EDITOR TEST: NEWS WORKS');
    const text = app.newText('string', 'This news item was added by the editor\'s in-game test kit. If you can read it on Manhattan, news.ini and the string table were written correctly.');
    const last = doc.ini.all('NewsItem').slice(-1)[0];
    app.history.do('Test kit: news', [doc], () => doc.ini.addSection('NewsItem', last, [['rank', 'base_0_rank, mission_end'], ['icon', 'world'], ['logo', 'news_scene2'], ['category', head], ['headline', head], ['text', text], ['base', BASE]]));
    return `Manhattan bar → news vendor: a story “FL EDITOR TEST: NEWS WORKS” with its text.`;
  } },
  { id: 'bartender', area: 'Bar characters (mbases.ini) + characters', async apply({ app }) {
    const doc = await app.otherDoc(dataPath('MISSIONS/mbases.ini'));
    const npc = doc.ini.all('GF_NPC').find(s => lc(s.get('nickname')) === 'li0101_fix_bartender'); if (!npc) throw new Error('li0101_fix_bartender not found');
    const bp = await app.otherDoc(dataPath('CHARACTERS/bodyparts.ini'));
    const heads = new Set(bp ? bp.ini.sections.flatMap(s => s.getAll('nickname')).map(lc) : []);
    const old = npc.get('head'), nu = ['li_rockford_head', 'br_brighton_head', 'benchmark_male_head'].find(x => heads.has(x) && x !== lc(old)) || 'benchmark_male_head';
    app.history.do('Test kit: bartender head', [doc], () => npc.set('head', nu));
    return `Manhattan bar: the bartender has a different face (${nu} instead of ${old}). The editor's character preview (bar editor → Appearance) should show the same face.`;
  } },
  { id: 'music', area: 'Base interiors (room INI) + audio', async apply({ app }) {
    const doc = await app.otherDoc(dataPath('UNIVERSE/SYSTEMS/LI01/BASES/ROOMS/li01_01_bar.ini'));
    const sec = doc.ini.all('Room_Sound')[0]; if (!sec) throw new Error('[Room_Sound] not found');
    const old = sec.get('music');
    app.history.do('Test kit: bar music', [doc], () => sec.set('music', 'music_bar_rh01'));
    return `Manhattan bar music is the Rheinland bar theme (music_bar_rh01) instead of ${old}.`;
  } },
  { id: 'thn', area: 'Cutscene editor (text .thn writer)', async apply({ app }) {
    const room = await app.otherDoc(dataPath('UNIVERSE/SYSTEMS/LI01/BASES/ROOMS/li01_01_bar.ini'));
    const camName = room.ini.all('Camera')[0]?.get('name') || 'Camera_0';
    const set = room.ini.all('Room_Info')[0]?.get('set_script'); if (!set) throw new Error('no set_script');
    const path = dataPath(set.replace(/\\/g, '/'));
    const f = parseThn(await api.read(path));
    const e = f.entities.get(lc(camName)); if (!e || !(e.table.get('cameraprops') instanceof LuaTable)) throw new Error(`${camName} not found in ${set}`);
    const cp = e.table.get('cameraprops'), fov = +cp.get('fovh'); cp.set('fovh', +(fov * 1.35).toFixed(3));
    const text = globalsToLua(f.globals); parseThn(text);
    await api.write(path, new TextEncoder().encode(text.replace(/\r?\n/g, '\r\n')));
    return `Manhattan bar: the view is wider (zoomed out — ${camName} field of view ${fov} → ${(fov * 1.35).toFixed(1)}). The bar script is now a text .thn file; if the bar looks normal otherwise, the game reads the editor's text cutscenes.`;
  } },
];

function report(st) {
  const lines = [`Freelancer editor — in-game test kit report`, `applied ${st.at} · snapshot ${st.snap}`, ''];
  for (const s of st.steps) lines.push(`[${(st.results[s.id]?.r || 'not checked').toUpperCase()}] ${s.area}${s.error ? ' — APPLY FAILED: ' + s.error : ''}${st.results[s.id]?.note ? '\n    note: ' + st.results[s.id].note : ''}`);
  return lines.join('\n') + '\n';
}

export async function testKit(app) {
  let st = load();
  const body = h('div', { style: { fontSize: '13px' } });
  const saveReport = () => { store(st); fetch('/api/testkit-report', { method: 'POST', body: report(st) }).catch(() => { }); };
  function render() {
    body.innerHTML = '';
    if (!st) {
      body.append(h('p', { style: { marginTop: 0 } }, 'This makes one small, clearly visible change per editor, all at Planet Manhattan in New York, so you can check them in the game within a few minutes:'),
        h('ul', {}, STEPS.map(s => h('li', {}, s.area))),
        h('p', {}, 'A snapshot is taken first; “Revert test kit” puts every file back exactly. Close Freelancer before applying (Windows locks files it has open).'),
        h('div', { class: 'note' }, 'Changes to the news and the bar are read when the game starts: start Freelancer after applying, then start a new game (you begin in the Manhattan bar) or load a save docked at Manhattan.'));
      return;
    }
    body.append(h('p', { style: { marginTop: 0, color: 'var(--dim)' } }, `Applied ${new Date(st.at).toLocaleString()}. Start Freelancer, go to Manhattan (new game, or a save docked there) and mark each item. Results are saved as editor_testkit_report.txt in your Freelancer folder.`));
    for (const s of st.steps) {
      const r = st.results[s.id] || (st.results[s.id] = { r: '', note: '' });
      const btn = (val, label, col) => h('button', { class: 'btn sm' + (r.r === val ? ' primary' : ''), style: r.r === val ? { background: col, borderColor: col } : {}, onclick: () => { r.r = r.r === val ? '' : val; saveReport(); render(); } }, label);
      body.append(h('div', { style: { border: '1px solid var(--line)', borderRadius: '8px', padding: '8px 10px', marginBottom: '8px' } },
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, h('b', { style: { flex: 1 } }, s.area), s.error ? null : btn('pass', '✓ works', '#2f8f4e'), s.error ? null : btn('fail', '✗ wrong', '#b84a4a')),
        s.error ? h('div', { style: { color: '#ff8a65' } }, 'Could not apply: ' + s.error) : h('div', { style: { color: 'var(--dim)', margin: '4px 0' } }, s.expect),
        h('input', { placeholder: 'note (what you saw)…', value: r.note, style: { width: '100%' }, onchange: (e) => { r.note = e.target.value; saveReport(); } })));
    }
  }
  async function apply() {
    if (app.history.dirty.size && !await confirmDialog('Unsaved changes', 'Save your unsaved changes first? They become part of the snapshot taken before the test kit.', 'Save and continue')) return;
    if (app.history.dirty.size) await app.save();
    let snap; try { snap = await snapApi.create('Before in-game test kit', 'taken automatically by Help → In-game test kit'); } catch (e) { toast('Snapshot failed — nothing changed: ' + e.message); return; }
    const steps = [];
    for (const s of STEPS) {
      try { steps.push({ id: s.id, area: s.area, expect: await s.apply({ app }) }); }
      catch (e) { console.warn(e); steps.push({ id: s.id, area: s.area, error: String(e.message || e) }); }
    }
    try { await app.save(); } catch (e) { toast('Save failed: ' + e.message); }
    st = { at: new Date().toISOString(), snap: snap.id, steps, results: {} };
    saveReport(); render(); refreshButtons();
    const bad = steps.filter(s => s.error).length;
    toast(bad ? `Test kit applied with ${bad} problem(s) — see the list` : 'Test kit applied and saved — start Freelancer');
    if (app.sys && lc(app.sys.nickname) === 'li01') app.openSystem('Li01');
  }
  async function revert() {
    if (!await confirmDialog('Revert test kit', 'Restore all files to the snapshot taken before the test kit? Your results stay in editor_testkit_report.txt.', 'Revert', true)) return;
    try { await snapApi.restore(st.snap); saveReport(); try { localStorage.removeItem(KEY); } catch { } toast('Reverted — reloading'); app.history.dirty.clear(); setTimeout(() => location.reload(), 700); }
    catch (e) { toast('Revert failed: ' + e.message); }
  }
  const applyBtn = h('button', { class: 'btn primary', onclick: apply }, 'Apply test kit');
  const revertBtn = h('button', { class: 'btn danger', onclick: revert }, 'Revert test kit');
  const copyBtn = h('button', { class: 'btn', onclick: () => { navigator.clipboard?.writeText(report(st)).then(() => toast('Report copied'), () => toast('Copy failed')); } }, 'Copy report');
  const refreshButtons = () => { applyBtn.style.display = st ? 'none' : ''; revertBtn.style.display = copyBtn.style.display = st ? '' : 'none'; };
  modal({ title: 'In-game test kit', wide: true, body, buttons: [{ el: copyBtn }, { el: revertBtn }, { el: applyBtn }, { label: 'Close' }] });
  refreshButtons(); render();
  return { apply, get state() { return st; } };
}
