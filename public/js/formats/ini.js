// Round-trip Freelancer INI document.
// Untouched lines are written back byte-for-byte; only edited entries are regenerated.
// Also reads BINI (binary INI) so vanilla (non-HD) installs open too; BINI files are saved as text,
// which Freelancer reads just as well.

let uid = 1;

export class IniEntry {
  constructor(key, value, raw = null, comment = '') {
    this.type = 'entry';
    this.key = key;
    this.value = value;     // raw value string (without inline comment)
    this.comment = comment; // inline comment including leading ';'
    this.raw = raw;         // original line text (null => regenerate)
  }
  get values() { return splitValues(this.value); }
  text() {
    if (this.raw != null) return this.raw;
    return this.value === '' ? `${this.key} =${this.comment ? ' ' + this.comment : ''}`
      : `${this.key} = ${this.value}${this.comment ? ' ' + this.comment : ''}`;
  }
}

export class IniSection {
  constructor(name, raw = null) {
    this.id = uid++;
    this.name = name;
    this.raw = raw;       // header line text
    this.lines = [];      // IniEntry | {type:'other', raw}
  }
  get entries() { return this.lines.filter(l => l.type === 'entry'); }
  is(name) { return this.name.toLowerCase() === name.toLowerCase(); }
  find(key) { key = key.toLowerCase(); return this.lines.find(l => l.type === 'entry' && l.key.toLowerCase() === key); }
  findAll(key) { key = key.toLowerCase(); return this.lines.filter(l => l.type === 'entry' && l.key.toLowerCase() === key); }
  get(key, def = undefined) { const e = this.find(key); return e ? e.value : def; }
  getAll(key) { return this.findAll(key).map(e => e.value); }
  has(key) { return !!this.find(key); }
  vals(key) { const e = this.find(key); return e ? e.values : null; }
  num(key, def = 0) { const v = this.vals(key); return v && v.length ? parseFloat(v[0]) : def; }
  vec(key, def = null) {
    const v = this.vals(key); if (!v) return def;
    const n = v.map(parseFloat); while (n.length < 3) n.push(0); return n.slice(0, 3);
  }
  lastEntryIndex() {
    for (let i = this.lines.length - 1; i >= 0; i--) if (this.lines[i].type === 'entry') return i;
    return -1;
  }
  set(key, value) {
    value = String(value);
    const e = this.find(key);
    if (e) { if (e.value !== value) { e.value = value; e.raw = null; } return e; }
    const ne = new IniEntry(key, value);
    this.lines.splice(this.lastEntryIndex() + 1, 0, ne);
    return ne;
  }
  // a new entry even when the key exists (multi-value keys: fixture, scene, hotspot lines…), after the last one of that key
  add(key, value) {
    const ne = new IniEntry(key, String(value));
    const same = this.findAll(key); const at = same.length ? this.lines.indexOf(same[same.length - 1]) + 1 : this.lastEntryIndex() + 1;
    this.lines.splice(at, 0, ne);
    return ne;
  }
  setAll(key, values) {
    const existing = this.findAll(key);
    let insertAt = existing.length ? this.lines.indexOf(existing[0]) : this.lastEntryIndex() + 1;
    this.lines = this.lines.filter(l => !existing.includes(l));
    const news = values.map((v, i) => {
      const old = existing[i];
      if (old && old.value === String(v)) return old;
      return new IniEntry(old ? old.key : key, String(v));
    });
    this.lines.splice(Math.min(insertAt, this.lines.length), 0, ...news);
  }
  remove(key) { key = key.toLowerCase(); this.lines = this.lines.filter(l => !(l.type === 'entry' && l.key.toLowerCase() === key)); }
  removeEntry(entry) { this.lines = this.lines.filter(l => l !== entry); }
  clone() {
    const s = new IniSection(this.name, this.raw);
    s.lines = this.lines.map(l => l.type === 'entry' ? Object.assign(new IniEntry(), l) : { ...l });
    return s;
  }
  text(eol) {
    const out = [this.raw != null ? this.raw : `[${this.name}]`];
    for (const l of this.lines) out.push(l.type === 'entry' ? l.text() : l.raw);
    return out.join(eol);
  }
}

export function splitValues(v) {
  if (v == null || v === '') return [];
  return v.split(',').map(s => s.trim());
}

export function fmtNum(n, digits = 2) {
  if (!isFinite(n)) return '0';
  const r = Math.round(n * 10 ** digits) / 10 ** digits;
  return String(Object.is(r, -0) ? 0 : r);
}
export function fmtVec(v, digits = 2) { return v.map(x => fmtNum(x, digits)).join(', '); }

function stripComment(s) {
  // ';' starts a comment; '//' too (some FL files use it)
  let i = s.indexOf(';');
  const j = s.indexOf('//');
  if (j >= 0 && (i < 0 || j < i)) i = j;
  if (i < 0) return [s, ''];
  return [s.slice(0, i), s.slice(i)];
}

export class IniDocument {
  constructor(path = '') {
    this.path = path;
    this.preamble = [];      // lines before first section
    this.sections = [];
    this.eol = '\r\n';
    this.finalNewline = true;
    this.wasBini = false;
  }

  static parse(text, path = '') {
    const doc = new IniDocument(path);
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const crlf = (text.match(/\r\n/g) || []).length, lf = (text.match(/\n/g) || []).length - crlf;
    doc.eol = crlf >= lf && crlf ? '\r\n' : '\n';
    doc.finalNewline = /\n$/.test(text);
    // files that mix CRLF and LF (some Discovery room files) keep each line's own ending, so untouched
    // lines are written back byte-for-byte; consistent files take the simple path
    doc.mixedEol = crlf > 0 && lf > 0;
    const ends = doc.mixedEol ? (text.match(/\r?\n/g) || []) : null;
    const lines = text.split(/\r?\n/);
    if (doc.finalNewline) lines.pop();
    let cur = null, li = -1;
    const nl = (o) => { if (ends) o.nl = ends[li] ?? ''; return o; };
    for (const raw of lines) {
      li++;
      const t = raw.trim();
      if (t.startsWith('[')) {
        const end = t.indexOf(']');
        if (end > 0) {
          cur = new IniSection(t.slice(1, end).trim(), raw);
          if (ends) cur.hnl = ends[li] ?? '';
          doc.sections.push(cur);
          continue;
        }
      }
      if (!cur) { doc.preamble.push(raw); if (ends) (doc.preambleNl || (doc.preambleNl = [])).push(ends[li] ?? ''); continue; }
      const [body, comment] = stripComment(raw);
      const eq = body.indexOf('=');
      if (body.trim() === '' ) { cur.lines.push(nl({ type: 'other', raw })); continue; }
      if (eq < 0) { // flag-style key with no value
        cur.lines.push(nl(Object.assign(new IniEntry(body.trim(), '', raw, comment.trim()), {})));
        continue;
      }
      const key = body.slice(0, eq).trim();
      const value = body.slice(eq + 1).trim();
      cur.lines.push(nl(new IniEntry(key, value, raw, comment.trim())));
    }
    return doc;
  }

  static fromBytes(bytes, path = '') {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (u8.length >= 12 && u8[0] === 0x42 && u8[1] === 0x49 && u8[2] === 0x4E && u8[3] === 0x49) {
      const doc = parseBini(u8, path);
      doc.wasBini = true;
      return doc;
    }
    return IniDocument.parse(new TextDecoder('windows-1252').decode(u8), path);
  }

  text() {
    if (this.mixedEol) { // each line with its own ending; new lines get the file's usual one
      const pieces = [];
      this.preamble.forEach((p, i) => pieces.push([p, this.preambleNl && this.preambleNl[i]]));
      for (const s of this.sections) { pieces.push([s.raw != null ? s.raw : `[${s.name}]`, s.hnl]); for (const l of s.lines) pieces.push([l.type === 'entry' ? l.text() : l.raw, l.nl]); }
      let out = '';
      pieces.forEach(([t, e], i) => { out += t; if (i < pieces.length - 1) out += e || this.eol; else if (this.finalNewline) out += e || this.eol; });
      return out;
    }
    const parts = [];
    if (this.preamble.length) parts.push(this.preamble.join(this.eol));
    for (const s of this.sections) parts.push(s.text(this.eol));
    let out = parts.join(this.eol);
    if (this.finalNewline) out += this.eol;
    return out;
  }

  toBytes() {
    const s = this.text();
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); out[i] = c < 256 ? c : 0x3F; }
    return out;
  }

  all(name) { return this.sections.filter(s => s.is(name)); }
  first(name) { return this.sections.find(s => s.is(name)); }
  ensure(name, after = null) {
    let s = this.first(name);
    if (!s) s = this.addSection(name, after);
    return s;
  }
  addSection(name, after = null, entries = []) {
    const s = new IniSection(name);
    for (const [k, v] of entries) s.lines.push(new IniEntry(k, String(v)));
    s.lines.push({ type: 'other', raw: '' });
    let idx = after ? this.sections.indexOf(after) + 1 : this.sections.length;
    if (idx <= 0) idx = this.sections.length;
    // keep a blank line separating from previous section
    const prev = this.sections[idx - 1];
    if (prev && (prev.lines.length === 0 || prev.lines[prev.lines.length - 1].type === 'entry')) prev.lines.push({ type: 'other', raw: '' });
    this.sections.splice(idx, 0, s);
    return s;
  }
  insertSection(s, idx) { this.sections.splice(idx, 0, s); }
  removeSection(s) { this.sections = this.sections.filter(x => x !== s); }

  // Snapshot / restore for undo (structure-preserving; keeps raw lines).
  snapshot() {
    return {
      preamble: this.preamble.slice(), preambleNl: this.preambleNl ? this.preambleNl.slice() : null,
      sections: this.sections.map(s => ({ id: s.id, name: s.name, raw: s.raw, hnl: s.hnl, lines: s.lines.map(l => ({ ...l })) })),
    };
  }
  restore(snap) {
    this.preamble = snap.preamble.slice(); if (snap.preambleNl) this.preambleNl = snap.preambleNl.slice();
    this.sections = snap.sections.map(o => {
      const s = new IniSection(o.name, o.raw); s.id = o.id; if (o.hnl !== undefined) s.hnl = o.hnl;
      s.lines = o.lines.map(l => l.type === 'entry' ? Object.assign(new IniEntry(), l) : { ...l });
      return s;
    });
  }
}

// ---------- BINI ----------
function parseBini(u8, path) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const strOff = dv.getUint32(8, true);
  const strTable = u8.subarray(strOff);
  const str = (o) => { let e = o; while (strTable[e]) e++; return new TextDecoder('windows-1252').decode(strTable.subarray(o, e)); };
  const doc = new IniDocument(path);
  let p = 12;
  while (p < strOff) {
    const nameOff = dv.getUint16(p, true); const count = dv.getUint16(p + 2, true); p += 4;
    const sec = new IniSection(str(nameOff));
    for (let i = 0; i < count; i++) {
      const kOff = dv.getUint16(p, true); const vc = u8[p + 2]; p += 3;
      const vals = [];
      for (let j = 0; j < vc; j++) {
        const t = u8[p]; p += 1;
        if (t === 1) vals.push(String(dv.getInt32(p, true)));
        else if (t === 2) vals.push(fmtNum(dv.getFloat32(p, true), 6));
        else vals.push(str(dv.getUint32(p, true)));
        p += 4;
      }
      sec.lines.push(new IniEntry(str(kOff), vals.join(', ')));
    }
    sec.lines.push({ type: 'other', raw: '' });
    doc.sections.push(sec);
  }
  return doc;
}
