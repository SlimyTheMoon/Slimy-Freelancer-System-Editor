// "Thorn" — Freelancer's Lua 3.2 scripts (.thn / .lua cutscenes, motion paths).
// Compiled chunks (ESC "Lua" 0x32) are run by a small Lua 3.2 VM; plain-text scripts by a parser for the
// table-constructor subset they use. Both give the script's globals as plain JS values:
//   numbers, strings, booleans, null, LuaTable { arr: [...1-based values as 0-based array], map: Map }.
// Undump / opcode table / VM semantics of Lua 3.2.

export class LuaTable {
  constructor() { this.arr = []; this.map = new Map(); }
  get(k) {
    if (typeof k === 'number' && Number.isInteger(k) && k >= 1 && k <= this.arr.length) return this.arr[k - 1];
    if (typeof k === 'string') { if (this.map.has(k)) return this.map.get(k); const l = k.toLowerCase(); for (const [kk, v] of this.map) if (typeof kk === 'string' && kk.toLowerCase() === l) return v; return undefined; }
    return this.map.get(k);
  }
  set(k, v) {
    if (typeof k === 'number' && Number.isInteger(k) && k >= 1) {
      if (k <= this.arr.length) { this.arr[k - 1] = v; return; }
      if (k === this.arr.length + 1) { this.arr.push(v); while (this.map.has(this.arr.length + 1)) { this.arr.push(this.map.get(this.arr.length + 1)); this.map.delete(this.arr.length); } return; }
    }
    this.map.set(k, v);
  }
  get length() { return this.arr.length; }
  *entries() { for (let i = 0; i < this.arr.length; i++) yield [i + 1, this.arr[i]]; yield* this.map; }
}

// Named constants used by cutscenes. Values keep their name for display.
export class LuaEnum { constructor(name, value) { this.name = name; this.value = value; } valueOf() { return this.value; } toString() { return this.name; } }
const E = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'boolean' ? v : new LuaEnum(k, v)]));
export const THN_ENV = E({
  LIT_DYNAMIC: 2, LIT_AMBIENT: 4, HIDDEN: 16, REFERENCE: 1, SPATIAL: 2, STREAM: 4, LOOP: 8,
  L_DIRECT: 3, L_POINT: 1, L_SPOT: 2, HARDPOINT: 1, PART: 2, ROOT: 0,
  POSITION: 2, ORIENTATION: 4, LOOK_AT: 8, ENTITY_RELATIVE: 32, ORIENTATION_RELATIVE: 128, PARENT_CHILD: 64,
  UNKNOWN_ENTITY: 0, COMPOUND: 1, DEFORMABLE: 2, CAMERA: 3, MONITOR: 4, LIGHT: 5, SOUND: 6, MARKER: 7, SCENE: 9, SUB_SCENE: 10, MOTION_PATH: 11, DELETED: 12, PSYS: 13,
  F_NONE: 0, F_EXP2: 2, F_EXP: 1, F_LINEAR: 3,
  UNDEFINED_EVENT: 0, USER_EVENT: 1, SET_CAMERA: 2, START_SOUND: 3, START_LIGHT_PROP_ANIM: 4, START_CAMERA_PROP_ANIM: 5, START_PATH_ANIMATION: 6, START_SPATIAL_PROP_ANIM: 7,
  ATTACH_ENTITY: 8, CONNECT_HARDPOINTS: 9, START_MOTION: 10, START_IK: 11, START_SUB_SCENE: 12, START_PSYS: 13, START_PSYS_PROP_ANIM: 14, START_AUDIO_PROP_ANIM: 15,
  START_FOG_PROP_ANIM: 16, START_REVERB_PROP_ANIM: 17, START_FLR_HEIGHT_ANIM: 18, SUBTITLE: 19,
  X_AXIS: 0, Y_AXIS: 1, Z_AXIS: 2, NEG_X_AXIS: 3, NEG_Y_AXIS: 4, NEG_Z_AXIS: 5,
  OPEN: 1, CLOSED: 0,
  Y: true, N: false, y: true, n: false,
});
export const enumName = (group, v) => {
  const n = +v; const names = { entity: ['UNKNOWN_ENTITY', 'COMPOUND', 'DEFORMABLE', 'CAMERA', 'MONITOR', 'LIGHT', 'SOUND', 'MARKER', '', 'SCENE', 'SUB_SCENE', 'MOTION_PATH', 'DELETED', 'PSYS'],
    event: ['UNDEFINED_EVENT', 'USER_EVENT', 'SET_CAMERA', 'START_SOUND', 'START_LIGHT_PROP_ANIM', 'START_CAMERA_PROP_ANIM', 'START_PATH_ANIMATION', 'START_SPATIAL_PROP_ANIM', 'ATTACH_ENTITY', 'CONNECT_HARDPOINTS', 'START_MOTION', 'START_IK', 'START_SUB_SCENE', 'START_PSYS', 'START_PSYS_PROP_ANIM', 'START_AUDIO_PROP_ANIM', 'START_FOG_PROP_ANIM', 'START_REVERB_PROP_ANIM', 'START_FLR_HEIGHT_ANIM', 'SUBTITLE'] }[group];
  return (v instanceof LuaEnum) ? v.name : (names && names[n]) || String(v);
};

// ---------------- compiled chunks ----------------
function undump(u8) {
  let p = 0;
  const byte = () => { if (p >= u8.length) throw new Error('unexpected end of chunk'); return u8[p++]; };
  const word = () => (byte() << 8) | byte();
  const long = () => ((word() << 16) | word()) >>> 0;
  const bytes = (n) => { const b = u8.subarray(p, p + n); p += n; return b; };
  const str = () => { const n = long(); if (!n) return null; let s = ''; const b = bytes(n); for (let i = 0; i < b.length; i++) if (b[i]) s += String.fromCharCode(b[i]); return s; };
  if (byte() !== 27 || byte() !== 0x4C || byte() !== 0x75 || byte() !== 0x61) throw new Error('not a compiled Lua chunk');
  const version = byte(); if (version !== 0x32) throw new Error('Lua version 0x' + version.toString(16) + ' (expected 3.2)');
  const sizeofR = byte(); const native = sizeofR !== 0;
  const number = () => { if (native) { const b = bytes(8); return new DataView(b.buffer, b.byteOffset, 8).getFloat64(0, true); } const n = byte(); return parseFloat(String.fromCharCode(...bytes(n))); };
  if (native) number(); // test number 3.14159265358979323846E8
  const fn = () => {
    const proto = { line: long(), source: str() || '', code: null, consts: [] };
    proto.code = bytes(long());
    const nl = long(); for (let i = 0; i < nl; i++) { long(); str(); }
    const nc = long();
    for (let i = 0; i < nc; i++) {
      const t = byte(); // stored as −(Lua 3.2 type tag): NUMBER −1, STRING −2, PROTO −4, NIL −6
      if (t === 1) proto.consts.push(number());
      else if (t === 2) proto.consts.push(str());
      else if (t === 4) proto.consts.push(fn());
      else if (t === 6) proto.consts.push(null);
      else throw new Error('constant type ' + t);
    }
    return proto;
  };
  return fn();
}
// [code, argument kind] per opcode: 0 none, 1 byte, 2 word, 3 byte byte, 4 word byte
const OPS = [
  ['END', 0], ['RET', 1], ['CALL', 3], ['TAILCALL', 3], ['PUSHNIL', 1], ['POP', 1], ['PUSHNUM', 2], ['PUSHNUM', 1], ['PUSHNEG', 2], ['PUSHNEG', 1],
  ['PUSHCONST', 2], ['PUSHCONST', 1], ['PUSHUPVAL', 1], ['PUSHLOCAL', 1], ['GETGLOBAL', 2], ['GETGLOBAL', 1], ['GETTABLE', 0], ['GETDOTTED', 2], ['GETDOTTED', 1],
  ['PUSHSELF', 2], ['PUSHSELF', 1], ['CREATEARRAY', 2], ['CREATEARRAY', 1], ['SETLOCAL', 1], ['SETGLOBAL', 2], ['SETGLOBAL', 1], ['SETTABLEPOP', 0], ['SETTABLE', 1],
  ['SETLIST', 4], ['SETLIST', 3], ['SETMAP', 1], ['NEQ', 0], ['EQ', 0], ['LT', 0], ['LE', 0], ['GT', 0], ['GE', 0], ['ADD', 0], ['SUB', 0], ['MUL', 0], ['DIV', 0], ['POW', 0],
  ['CONC', 0], ['MINUS', 0], ['NOT', 0], ['ONTJMP', 2], ['ONTJMP', 1], ['ONFJMP', 2], ['ONFJMP', 1], ['JMP', 2], ['JMP', 1], ['IFFJMP', 2], ['IFFJMP', 1],
  ['IFTUPJMP', 2], ['IFTUPJMP', 1], ['IFFUPJMP', 2], ['IFFUPJMP', 1], ['CLOSURE', 4], ['CLOSURE', 3], ['SETLINE', 2], ['SETLINE', 1], ['LONGARG', 2], ['LONGARG', 1], ['CHECKSTACK', 1],
];
const num = (v) => { if (typeof v === 'number') return v; if (v instanceof LuaEnum) return v.value; if (typeof v === 'string' && v.trim() !== '' && !isNaN(+v)) return +v; throw new Error('arithmetic on ' + typeof v); };
function run(proto, env, globals, args = [], upvals = [], depth = 0, budget = { n: 2_000_000 }) {
  if (depth > 40) throw new Error('call depth exceeded');
  const code = proto.code; let pc = 0;
  const stack = [...args];
  pc++; // frame size byte
  pc++; // (Lua 3.2 has the arg count byte after it)
  let longArg = 0;
  while (pc < code.length) {
    if (budget.n-- <= 0) throw new Error('instruction limit exceeded');
    const op = code[pc++]; const info = OPS[op]; if (!info) throw new Error('bad opcode ' + op);
    let a = 0, b = 0;
    switch (info[1]) { case 1: a = code[pc++]; break; case 2: a = (code[pc] << 8) | code[pc + 1]; pc += 2; break; case 3: a = code[pc++]; b = code[pc++]; break; case 4: a = (code[pc] << 8) | code[pc + 1]; pc += 2; b = code[pc++]; break; }
    if (longArg) { a += longArg; longArg = 0; }
    const pop = () => stack.pop();
    switch (info[0]) {
      case 'END': return null;
      case 'RET': return stack.length - a > 1 ? { tuple: stack.slice(a) } : stack[stack.length - 1];
      case 'CALL': case 'TAILCALL': {
        const nArgs = b; let callArgs = stack.splice(stack.length - nArgs, nArgs);
        const last = callArgs[callArgs.length - 1]; if (last && last.tuple) callArgs = [...callArgs.slice(0, -1), ...last.tuple];
        const f = pop();
        let r;
        if (typeof f === 'function') r = f(...callArgs);
        else if (f && f.proto) r = run(f.proto, env, globals, callArgs, f.up || [], depth + 1, budget);
        else throw new Error('call of a non-function');
        if (info[0] === 'TAILCALL') return r;
        let nRes = a;
        if (nRes === 255) { if (r && r.tuple) stack.push(...r.tuple); else stack.push(r); }
        else if (nRes >= 1) { const vals = r && r.tuple ? r.tuple : [r]; for (let i = 0; i < nRes; i++) stack.push(vals[i] ?? null); }
        break;
      }
      case 'PUSHNIL': for (let i = 0; i <= a; i++) stack.push(null); break;
      case 'POP': stack.length -= a; break;
      case 'PUSHNUM': stack.push(a); break;
      case 'PUSHNEG': stack.push(-a); break;
      case 'PUSHCONST': stack.push(proto.consts[a]); break;
      case 'PUSHUPVAL': stack.push(upvals[a]); break;
      case 'PUSHLOCAL': stack.push(stack[a]); break;
      case 'GETGLOBAL': { const k = proto.consts[a]; stack.push(Object.prototype.hasOwnProperty.call(env, k) ? env[k] : (globals.has(k) ? globals.get(k) : null)); break; }
      case 'GETTABLE': { const i = pop(), t = pop(); stack.push(t instanceof LuaTable ? (t.get(i) ?? null) : null); break; }
      case 'GETDOTTED': { const t = pop(); stack.push(t instanceof LuaTable ? (t.get(proto.consts[a]) ?? null) : null); break; }
      case 'PUSHSELF': { const t = stack[stack.length - 1]; stack.push(t instanceof LuaTable ? (t.get(proto.consts[a]) ?? null) : null); stack.push(stack.splice(stack.length - 2, 1)[0]); break; }
      case 'CREATEARRAY': stack.push(new LuaTable()); break;
      case 'SETLOCAL': stack[a] = pop(); break;
      case 'SETGLOBAL': globals.set(proto.consts[a], pop()); break;
      case 'SETTABLEPOP': { const v = pop(), i = pop(), t = pop(); t.set(i, v); break; }
      case 'SETTABLE': { const idx = stack.length - 3 - a; const v = pop(); stack[idx].set(stack[idx + 1], v); break; }
      case 'SETLIST': { const vals = stack.splice(stack.length - b, b); const t = stack[stack.length - 1]; const off = a * 64; vals.forEach((v, i) => t.set(off + i + 1, v)); break; }
      case 'SETMAP': { const n = (a + 1) * 2; const kv = stack.splice(stack.length - n, n); const t = stack[stack.length - 1]; for (let i = 0; i < n; i += 2) t.set(kv[i], kv[i + 1]); break; }
      case 'NEQ': { const y = pop(), x = pop(); stack.push(x !== y ? 1 : null); break; }
      case 'EQ': { const y = pop(), x = pop(); stack.push(x === y ? 1 : null); break; }
      case 'LT': { const y = pop(), x = pop(); stack.push(num(x) < num(y) ? 1 : null); break; }
      case 'LE': { const y = pop(), x = pop(); stack.push(num(x) <= num(y) ? 1 : null); break; }
      case 'GT': { const y = pop(), x = pop(); stack.push(num(x) > num(y) ? 1 : null); break; }
      case 'GE': { const y = pop(), x = pop(); stack.push(num(x) >= num(y) ? 1 : null); break; }
      case 'ADD': { const y = pop(), x = pop(); stack.push(num(x) + num(y)); break; }
      case 'SUB': { const y = pop(), x = pop(); stack.push(num(x) - num(y)); break; }
      case 'MUL': { const y = pop(), x = pop(); stack.push(num(x) * num(y)); break; }
      case 'DIV': { const y = pop(), x = pop(); stack.push(num(x) / num(y)); break; }
      case 'POW': { const y = pop(), x = pop(); stack.push(Math.pow(num(x), num(y))); break; }
      case 'CONC': { const y = pop(), x = pop(); stack.push(String(x) + String(y)); break; }
      case 'MINUS': stack.push(-num(pop())); break;
      case 'NOT': stack.push(pop() == null ? 1 : null); break;
      case 'ONTJMP': if (stack[stack.length - 1] != null) pc += a; else pop(); break;
      case 'ONFJMP': if (stack[stack.length - 1] == null) pc += a; else pop(); break;
      case 'JMP': pc += a; break;
      case 'IFFJMP': if (pop() == null) pc += a; break;
      case 'IFTUPJMP': if (pop() != null) pc -= a; break;
      case 'IFFUPJMP': if (pop() == null) pc -= a; break;
      case 'CLOSURE': { const up = stack.splice(stack.length - b, b); stack.push({ proto: proto.consts[a], up }); break; }
      case 'SETLINE': break;
      case 'LONGARG': longArg = a << 16; break;
      case 'CHECKSTACK': break;
    }
  }
  return null;
}

// ---------------- text scripts (the table-constructor subset cutscenes use) ----------------
function parseText(src, env) {
  let p = 0; const n = src.length; const globals = new Map();
  const ws = () => {
    for (;;) {
      while (p < n && /\s/.test(src[p])) p++;
      if (src.startsWith('--', p)) { while (p < n && src[p] !== '\n') p++; continue; }
      break;
    }
  };
  const err = (m) => { const line = src.slice(0, p).split('\n').length; throw new Error(`${m} (line ${line})`); };
  const peek = (s) => { ws(); return src.startsWith(s, p); };
  const eat = (s) => { if (!peek(s)) err(`expected "${s}"`); p += s.length; };
  const ident = () => { ws(); const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(p, p + 200)); if (!m) return null; p += m[0].length; return m[0]; };
  const string = () => {
    const q = src[p++]; let s = '';
    while (p < n && src[p] !== q) { if (src[p] === '\\') { p++; const c = src[p++]; s += c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c; } else s += src[p++]; }
    p++; return s;
  };
  function primary() {
    ws();
    const c = src[p];
    if (c === '"' || c === "'") return string();
    if (src.startsWith('[[', p)) { const e = src.indexOf(']]', p + 2); const s = src.slice(p + 2, e); p = e + 2; return s; }
    if (c === '{') return table();
    if (c === '(') { p++; const v = expr(); eat(')'); return v; }
    if (c === '-' ) { p++; return -num(unary()); }
    const m = /^(0x[0-9a-fA-F]+|\d+\.?\d*(e[-+]?\d+)?|\.\d+(e[-+]?\d+)?)/i.exec(src.slice(p, p + 64));
    if (m) { p += m[0].length; return Number(m[0]); }
    const id = ident(); if (id == null) err('unexpected "' + src.slice(p, p + 12) + '"');
    if (id === 'nil') return null; if (id === 'true') return true; if (id === 'false') return false;
    if (id === 'not') return unary() == null ? 1 : null;
    let v = Object.prototype.hasOwnProperty.call(env, id) ? env[id] : globals.has(id) ? globals.get(id) : id;
    for (;;) {
      if (peek('.') && !peek('..')) { p++; const k = ident(); v = v instanceof LuaTable ? v.get(k) : null; }
      else if (peek('[') && !peek('[[')) { p++; const k = expr(); eat(']'); v = v instanceof LuaTable ? v.get(k) : null; }
      else break;
    }
    return v;
  }
  function unary() { return primary(); }
  function term() { let v = unary(); for (;;) { if (peek('*')) { p++; v = num(v) * num(unary()); } else if (peek('/')) { p++; v = num(v) / num(unary()); } else return v; } }
  function arith() { let v = term(); for (;;) { if (peek('..')) { p += 2; v = String(v) + String(term()); } else if (peek('+')) { p++; v = num(v) + num(term()); } else if (peek('-') && !peek('--')) { p++; v = num(v) - num(term()); } else return v; } }
  function expr() { return arith(); }
  function table() {
    eat('{'); const t = new LuaTable(); let i = 1;
    for (;;) {
      if (peek('}')) { p++; return t; }
      if (peek('[') && !peek('[[')) { p++; const k = expr(); eat(']'); eat('='); t.set(k, expr()); }
      else {
        const save = p; const id = ident();
        if (id != null && peek('=') && !peek('==')) { p++; t.set(id, expr()); }
        else { p = save; t.set(i++, expr()); }
      }
      if (peek(',') || peek(';')) p++;
      else if (!peek('}')) err('expected "," or "}"');
    }
  }
  for (;;) {
    ws(); if (p >= n) break;
    const id = ident(); if (!id) err('expected a name');
    if (id === 'local') continue;
    eat('='); globals.set(id, expr());
    if (peek(';') || peek(',')) p++;
  }
  return globals;
}

// bytes or text → Map of globals
export function runThorn(input, env = THN_ENV) {
  const u8 = typeof input === 'string' ? null : input;
  if (u8 && u8[0] === 27) {
    const proto = undump(u8); const globals = new Map();
    run(proto, env, globals);
    return globals;
  }
  const text = typeof input === 'string' ? input : new TextDecoder('latin1').decode(u8);
  return parseText(text, env);
}

// ---------------- back to text ----------------
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const fmtN = (v) => Number.isInteger(v) ? String(v) : String(+v.toFixed(6));
function enumFor(path, v) {
  // name a few well-known numeric fields
  const k = path[path.length - 1];
  if (k === 'type' && path.length === 3 && path[0] === 'entities') return enumName('entity', v);
  if (path.length === 3 && k === 2 && path[0] === 'events') return enumName('event', v);
  return null;
}
export function toLua(value, path = [], indent = '') {
  if (value == null) return 'nil';
  if (value instanceof LuaEnum) return value.name;
  if (typeof value === 'boolean') return value ? 'Y' : 'N';
  if (typeof value === 'number') { const e = enumFor(path, value); return e && !/^\d/.test(e) ? e : fmtN(value); }
  if (typeof value === 'string') return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
  if (value instanceof LuaTable) {
    const items = [];
    const simple = value.map.size === 0 && value.arr.every(v => typeof v === 'number' || typeof v === 'string' || v instanceof LuaEnum);
    for (let i = 0; i < value.arr.length; i++) items.push(toLua(value.arr[i], [...path, i + 1], indent + '\t'));
    for (const [k, v] of value.map) items.push((typeof k === 'string' && IDENT.test(k) ? k : '[' + toLua(k) + ']') + ' = ' + toLua(v, [...path, k], indent + '\t'));
    if (simple || items.join(', ').length < 70 && !items.some(s => s.includes('\n'))) return '{ ' + items.join(', ') + ' }';
    return '{\n' + items.map(s => indent + '\t' + s).join(',\n') + '\n' + indent + '}';
  }
  if (value && value.proto) return '--[[function]] nil';
  return 'nil';
}
export function globalsToLua(globals) {
  return [...globals].map(([k, v]) => `${k} = ${toLua(v, [k])}`).join('\n\n') + '\n';
}
