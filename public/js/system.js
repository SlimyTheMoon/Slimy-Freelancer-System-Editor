// System document model + editing operations.
import { IniEntry, fmtNum, fmtVec } from './formats/ini.js';

export const KIND = { Object: 'object', Zone: 'zone', LightSource: 'light' };
export function kindOf(sec) {
  const n = sec.name.toLowerCase();
  if (n === 'object') return 'object';
  if (n === 'zone') return 'zone';
  if (n === 'lightsource') return 'light';
  return null;
}

export class SystemDoc {
  constructor(game, sys, path, ini) {
    this.game = game; this.sys = sys; this.nickname = sys.nickname; this.path = path; this.ini = ini;
  }
  get entities() { return this.ini.sections.filter(s => kindOf(s)); }
  get objects() { return this.ini.all('Object'); }
  get zones() { return this.ini.all('Zone'); }
  get lights() { return this.ini.all('LightSource'); }
  byId(id) { return this.ini.sections.find(s => s.id === id) || null; }
  byNick(n) { if (!n) return null; n = n.toLowerCase(); return this.entities.find(s => (s.get('nickname') || '').toLowerCase() === n) || null; }
  nickExists(n) { return !!this.byNick(n); }
  uniqueNick(base) {
    base = base.replace(/\s+/g, '_');
    if (!this.nickExists(base)) return base;
    const m = base.match(/^(.*_)(\d+)$/); // only a trailing "_NN" counts as a counter
    let stem = m ? m[1] : base + '_', i = m ? parseInt(m[2], 10) + 1 : 2;
    const width = m ? m[2].length : 1;
    while (this.nickExists(stem + String(i).padStart(width, '0'))) i++;
    return stem + String(i).padStart(width, '0');
  }

  // ---- create ----
  insertAfterKind(kind) {
    const list = kind === 'zone' ? this.zones : kind === 'light' ? this.lights : this.objects;
    return list[list.length - 1] || this.ini.sections[this.ini.sections.length - 1] || null;
  }
  addObject(arch, pos, extra = {}) {
    const a = this.game.arch(arch);
    const nick = this.uniqueNick(extra.nickname || `${this.nickname}_${arch}_01`);
    const entries = [['nickname', nick]];
    entries.push(['ids_name', extra.ids_name != null ? extra.ids_name : (a && a.ids ? a.ids : null)]);
    entries.push(['pos', fmtVec(pos, 0)]);
    if (extra.rotate) entries.push(['rotate', fmtVec(extra.rotate, 2)]);
    entries.push(['archetype', arch]);
    for (const [k, v] of Object.entries(extra)) if (!['nickname', 'rotate', 'ids_name'].includes(k) && v != null && v !== '') entries.push([k, v]);
    if (a && a.type === 'SUN' && !extra.star) entries.push(['star', 'med_white_sun']);
    for (let i = entries.length - 1; i >= 0; i--) if (entries[i][1] == null || entries[i][1] === '') entries.splice(i, 1);
    const s = this.ini.addSection('Object', this.insertAfterKind('object'), entries);
    this.ensureArchetypePreload(arch);
    return s;
  }
  addZone(shape, pos, size, extra = {}) {
    const nick = this.uniqueNick(extra.nickname || `Zone_${this.nickname}_01`);
    const entries = [['nickname', nick], ['pos', fmtVec(pos, 0)]];
    if (extra.rotate) entries.push(['rotate', fmtVec(extra.rotate, 2)]);
    entries.push(['shape', shape], ['size', Array.isArray(size) ? size.map(x => fmtNum(x, 0)).join(', ') : fmtNum(size, 0)]);
    for (const [k, v] of Object.entries(extra)) if (!['nickname', 'rotate'].includes(k) && v != null && v !== '') entries.push([k, v]);
    return this.ini.addSection('Zone', this.insertAfterKind('zone'), entries);
  }
  addLight(pos, extra = {}) {
    const nick = this.uniqueNick(extra.nickname || `${this.nickname}_light_01`);
    return this.ini.addSection('LightSource', this.insertAfterKind('light'), [
      ['nickname', nick], ['pos', fmtVec(pos, 0)], ['color', extra.color || '255, 255, 255'], ['range', extra.range || 20000], ['type', extra.type || 'POINT'], ['attenuation', extra.attenuation || '1, 0, 0.000000005'],
    ]);
  }
  duplicate(sec, offset = [500, 0, 0]) {
    const c = sec.clone();
    const nick = this.uniqueNick(sec.get('nickname') || 'copy');
    c.set('nickname', nick);
    const p = c.vec('pos', [0, 0, 0]); c.set('pos', fmtVec([p[0] + offset[0], p[1] + offset[1], p[2] + offset[2]], 0));
    // links do not make sense on a copy
    for (const k of ['prev_ring', 'next_ring', 'base', 'dock_with', 'goto']) c.remove(k);
    const idx = this.ini.sections.indexOf(sec);
    if (c.lines.length && c.lines[c.lines.length - 1].type === 'entry') c.lines.push({ type: 'other', raw: '' });
    this.ini.insertSection(c, idx + 1);
    return c;
  }
  remove(sec) {
    const nick = sec.get('nickname');
    this.ini.removeSection(sec);
    if (!nick) return;
    const l = nick.toLowerCase();
    // unlink tradelane neighbours & Asteroids/Nebula/zone references
    for (const s of this.objects) {
      for (const k of ['prev_ring', 'next_ring']) if ((s.get(k) || '').toLowerCase() === l) s.remove(k);
      if ((s.get('parent') || '').toLowerCase() === l) s.remove('parent');
    }
    for (const s of [...this.ini.all('Asteroids'), ...this.ini.all('Nebula')]) if ((s.get('zone') || '').toLowerCase() === l) this.ini.removeSection(s);
  }
  // references to nickname inside this system
  references(nick) {
    const l = nick.toLowerCase(); const out = [];
    for (const s of this.ini.sections) for (const e of s.entries) {
      if (e.key.toLowerCase() === 'nickname') continue;
      const vals = e.values.map(v => v.toLowerCase());
      if (vals.includes(l)) out.push({ section: s, entry: e });
    }
    return out;
  }
  renameRefs(oldNick, newNick) {
    for (const { entry } of this.references(oldNick)) {
      entry.value = entry.values.map(v => v.toLowerCase() === oldNick.toLowerCase() ? newNick : v).join(', ');
      entry.raw = null;
    }
  }
  ensureArchetypePreload(arch) {
    const sec = this.ini.first('Archetype');
    if (!sec) return;
    if (sec.getAll('solar').some(v => v.toLowerCase() === arch.toLowerCase())) return;
    if (!this.game.arch(arch)) return;
    const solars = sec.findAll('solar');
    const at = solars.length ? sec.lines.indexOf(solars[solars.length - 1]) + 1 : sec.lastEntryIndex() + 1;
    sec.lines.splice(at, 0, new IniEntry('solar', arch));
  }
}

// --------- transforms ----------
export function getPos(sec) { return sec.vec('pos', [0, 0, 0]); }
export function getRot(sec) { return sec.vec('rotate', [0, 0, 0]); }
export function setPos(sec, p) { sec.set('pos', fmtVec(p, 0)); }
export function setRot(sec, r) {
  const n = r.map(x => { let a = ((x + 180) % 360 + 360) % 360 - 180; return Math.abs(a) < 0.005 ? 0 : a; });
  if (n.every(x => x === 0) && !sec.has('rotate')) return;
  sec.set('rotate', fmtVec(n, 2));
}

// --------- history (undo/redo over any set of IniDocuments) ----------
export class History {
  constructor(onChange) { this.undoStack = []; this.redoStack = []; this.onChange = onChange; this.dirty = new Set(); this.savedMarks = new Map(); this.state = new Map(); this.counter = 0; }
  // a doc is dirty when its current state (the history entry that produced it) differs from the state
  // it had when last saved or loaded, so undoing back to the saved text clears the unsaved mark
  mark(d) { if ((this.state.get(d) || 0) === (this.savedMarks.get(d) || 0)) this.dirty.delete(d); else this.dirty.add(d); }
  markSaved(d) { this.savedMarks.set(d, this.state.get(d) || 0); this.dirty.delete(d); }
  stateBefore(d) { for (let i = this.undoStack.length - 1; i >= 0; i--) if (this.undoStack[i].before.some(([x]) => x === d)) return this.undoStack[i].n; return 0; }
  // docs: array of {ini, key}
  do(label, docs, fn) {
    const before = docs.map(d => [d, d.ini.snapshot()]);
    let result;
    try { result = fn(); }
    catch (e) { for (const [d, s] of before) d.ini.restore(s); throw e; }
    const after = docs.map(d => [d, d.ini.snapshot()]);
    this.undoStack.push({ label, before, after, n: ++this.counter });
    if (this.undoStack.length > 300) this.undoStack.shift();
    this.redoStack = [];
    for (const d of docs) { this.state.set(d, this.counter); this.mark(d); }
    this.onChange && this.onChange({ label, docs: docs.map(d => d) });
    return result;
  }
  undo() {
    const e = this.undoStack.pop(); if (!e) return null;
    for (const [d, s] of e.before) { d.ini.restore(s); this.state.set(d, this.stateBefore(d)); this.mark(d); }
    this.redoStack.push(e);
    this.onChange && this.onChange({ label: 'Undo ' + e.label, docs: e.before.map(x => x[0]), undo: true });
    return e;
  }
  redo() {
    const e = this.redoStack.pop(); if (!e) return null;
    for (const [d, s] of e.after) { d.ini.restore(s); this.state.set(d, e.n); this.mark(d); }
    this.undoStack.push(e);
    this.onChange && this.onChange({ label: 'Redo ' + e.label, docs: e.after.map(x => x[0]), redo: true });
    return e;
  }
}
