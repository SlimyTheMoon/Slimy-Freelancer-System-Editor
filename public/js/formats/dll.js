// Freelancer resource DLL reader/writer.
//
// Writer: a minimal PE template, with
// these corrections (checked against the PE/COFF spec and Freelancer.exe's own loader code):
//  * every resource type/name/language of the source DLL is preserved (not only
//    strings/infocards/dialogs/menus/version) — only RT_STRING blocks and RT_HTML(23) infocards are rebuilt;
//  * the language id of the original resources is kept (a hard-coded 1033 would leave German/French
//    installs would end up with mixed languages);
//  * the original ImageBase is kept so DLLs don't collide on 0x070E0000;
//  * the resource data-directory Size is patched (the template's 0x10 is wrong);
//  * SizeOfImage is aligned to SectionAlignment (0x1000), SizeOfInitializedData to FileAlignment;
//  * section padding writes bytes (writing 4-byte ints would leave trailing junk);
//  * resource data blobs are 8-byte aligned.
// Freelancer.exe loads these with plain LoadLibraryA (FUN_005b0c30) and reads them with
// FindResourceExA(h, RT_STRING, (id>>4)+1, 0) / FindResourceExA(h, 23, id, 0) (FUN_00434720, FUN_0057da40),
// so the result must be a fully valid image.

const RT_STRING = 6, RT_HTML = 23;

// minimal PE template (512-byte header with one .rsrc section at RVA 0x1000)
const PE_TEMPLATE_B64 =
  'TVqQAAMAAAAEAAAA//8AALgAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAsAAAAA4fug4AtAnNIbgBTM0hVGhpcyBwcm9ncmFtIGNhbm5vdCBiZSBydW4gaW4gRE9TIG1v' +
  'ZGUuDQ0KJAAAAAAAAADrIDXbr0FbiK9BW4ivQVuIaEddiK5BW4hSaWNor0FbiAAAAAAAAAAAAAAA' +
  'AAAAAABQRQAATAEBAC9np08AAAAAAAAAAOAADiELAQYAAAAAAAACAAAAAAAAAAAAAAAQAAAAEAAA' +
  'AAAOBwAQAAAAAgAABAAAAAAAAAAEAAAAAAAAAAAgAAAAAgAAAAAAAAIAAAAAABAAABAAAAAAEAAA' +
  'EAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAABAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC5yc3JjAAAAEAAAAAAQAAAAAgAAAAIAAAAAAAAAAAAA' +
  'AAAAAEAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const RSRC_RVA = 0x1000;
const OFF = { initData: 0xD0, imageBase: 0xE4, sizeOfImage: 0x100, checksum: 0x108, rsrcDirSize: 0x13C, secVSize: 0x1B0, secRawSize: 0x1B8 };
const align = (v, a) => (v + a - 1) & ~(a - 1);
const b64 = (s) => typeof atob === 'function' ? Uint8Array.from(atob(s), c => c.charCodeAt(0)) : new Uint8Array(Buffer.from(s, 'base64'));

// ------------------------------------------------------------ read
export function readDll(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint16(0, true) !== 0x5A4D) throw new Error('not a PE file');
  const pe = dv.getUint32(0x3C, true);
  const nsec = dv.getUint16(pe + 6, true), optSize = dv.getUint16(pe + 20, true), opt = pe + 24;
  const magic = dv.getUint16(opt, true);
  const imageBase = magic === 0x10B ? dv.getUint32(opt + 28, true) : 0x70E0000;
  const ddOff = opt + (magic === 0x20B ? 112 : 96);
  const rsrcRva = dv.getUint32(ddOff + 16, true);
  const secs = [];
  for (let i = 0; i < nsec; i++) { const s = opt + optSize + i * 40; secs.push({ va: dv.getUint32(s + 12, true), vs: dv.getUint32(s + 8, true), raw: dv.getUint32(s + 20, true), rs: dv.getUint32(s + 16, true), flags: dv.getUint32(s + 36, true) }); }
  // A DLL is only safe to rebuild if it is a pure resource container: no code, no exports, no entry point.
  // (resources.dll has a .text section; mods sometimes list plugin DLLs with code under [Resources].)
  const entryPoint = dv.getUint32(opt + 16, true);
  const exportRva = dv.getUint32(ddOff, true);
  const hasCode = secs.some(s => (s.flags & 0x20) || (s.flags & 0x20000000));
  const pureResource = !hasCode && !exportRva && !entryPoint;
  const r2o = (rva) => { for (const s of secs) if (rva >= s.va && rva < s.va + Math.max(s.vs, s.rs)) return rva - s.va + s.raw; return -1; };
  const base = r2o(rsrcRva);
  // tree: Map<type, Map<name, Map<lang, {data, codepage}>>> (numeric ids; string names kept as 'str:Name')
  const tree = new Map();
  if (base < 0) return { tree, imageBase, pureResource };
  const nameOf = (raw) => {
    if (!(raw & 0x80000000)) return raw;
    const o = base + (raw & 0x7FFFFFFF); const len = dv.getUint16(o, true);
    let s = ''; for (let i = 0; i < len; i++) s += String.fromCharCode(dv.getUint16(o + 2 + i * 2, true));
    return 'str:' + s;
  };
  const dir = (off) => { const n = dv.getUint16(off + 12, true) + dv.getUint16(off + 14, true); const out = []; for (let i = 0; i < n; i++) out.push([nameOf(dv.getUint32(off + 16 + i * 8, true)), dv.getUint32(off + 20 + i * 8, true)]); return out; };
  for (const [type, tp] of dir(base)) {
    if (!(tp & 0x80000000)) continue;
    const names = new Map(); tree.set(type, names);
    for (const [name, np] of dir(base + (tp & 0x7FFFFFFF))) {
      if (!(np & 0x80000000)) continue;
      const langs = new Map(); names.set(name, langs);
      for (const [lang, lp] of dir(base + (np & 0x7FFFFFFF))) {
        if (lp & 0x80000000) continue;
        const de = base + lp;
        const off = r2o(dv.getUint32(de, true)), size = dv.getUint32(de + 4, true), cp = dv.getUint32(de + 8, true);
        if (off < 0) continue;
        langs.set(lang, { data: u8.slice(off, off + size), codepage: cp });
      }
    }
  }
  return { tree, imageBase, pureResource };
}

const utf16 = (u8, off, chars) => { let s = ''; for (let i = 0; i < chars; i++) s += String.fromCharCode(u8[off + i * 2] | (u8[off + i * 2 + 1] << 8)); return s; };
function encUtf16(str, bom = false) {
  const out = new Uint8Array(str.length * 2 + (bom ? 2 : 0)); let p = 0;
  if (bom) { out[0] = 0xFF; out[1] = 0xFE; p = 2; }
  for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); out[p++] = c & 0xFF; out[p++] = c >> 8; }
  return out;
}

// strings: Map<localId, text>, infocards: Map<localId, xml>, lang: dominant language of those types
export function extractText(tree) {
  const strings = new Map(), infocards = new Map(), langCount = new Map();
  const st = tree.get(RT_STRING);
  if (st) for (const [blk, langs] of st) {
    if (typeof blk !== 'number') continue;
    const [lang, { data }] = [...langs][0];
    langCount.set(lang, (langCount.get(lang) || 0) + 1);
    let p = 0;
    for (let i = 0; i < 16 && p + 2 <= data.length; i++) {
      const len = data[p] | (data[p + 1] << 8); p += 2;
      if (len) strings.set((blk - 1) * 16 + i, utf16(data, p, len));
      p += len * 2;
    }
  }
  const ht = tree.get(RT_HTML);
  if (ht) for (const [id, langs] of ht) {
    if (typeof id !== 'number') continue;
    const [lang, { data }] = [...langs][0];
    langCount.set(lang, (langCount.get(lang) || 0) + 1);
    let off = 0, n = data.length >> 1;
    if (data[0] === 0xFF && data[1] === 0xFE) { off = 2; n--; }
    infocards.set(id, utf16(data, off, n).replace(/\0+$/, ''));
  }
  let lang = 1033, best = -1; for (const [l, c] of langCount) if (c > best) { best = c; lang = l; }
  return { strings, infocards, lang };
}

// ------------------------------------------------------------ write
export function buildTree(original, strings, infocards, lang) {
  const tree = new Map();
  for (const [t, names] of original) if (t !== RT_STRING && t !== RT_HTML) tree.set(t, names);
  if (strings.size) {
    const blocks = new Map();
    for (const [id, s] of strings) { if (!s) continue; const b = (id >> 4) + 1; if (!blocks.has(b)) blocks.set(b, new Array(16).fill('')); blocks.get(b)[id & 15] = s; }
    const st = new Map();
    for (const [b, arr] of blocks) {
      const parts = arr.map(s => { if (s.length > 0xFFFF) throw new Error('string too long'); const e = encUtf16(s); const o = new Uint8Array(2 + e.length); o[0] = s.length & 0xFF; o[1] = s.length >> 8; o.set(e, 2); return o; });
      const total = parts.reduce((a, p) => a + p.length, 0); const data = new Uint8Array(total); let p = 0; for (const x of parts) { data.set(x, p); p += x.length; }
      st.set(b, new Map([[lang, { data, codepage: 0 }]]));
    }
    tree.set(RT_STRING, st);
  }
  if (infocards.size) {
    const ht = new Map();
    for (const [id, xml] of infocards) if (xml) ht.set(id, new Map([[lang, { data: encUtf16(xml, true), codepage: 0 }]]));
    tree.set(RT_HTML, ht);
  }
  return tree;
}

export function writeDll(tree, imageBase = 0x70E0000) {
  // ---- lay out .rsrc: directories, then (named-entry strings), data entries, data
  const sortKeys = (m) => [...m.keys()].sort((a, b) => {
    const as = typeof a === 'string', bs = typeof b === 'string';
    if (as !== bs) return as ? -1 : 1; // named entries come first in a resource directory
    return as ? a.localeCompare(b) : a - b;
  });
  const types = sortKeys(tree);
  const dirs = []; // {entries:[{key, child}], off}
  const leaves = []; // {data, codepage, entryOff, dataOff}
  const mkDir = () => { const d = { entries: [], off: 0 }; dirs.push(d); return d; };
  const root = mkDir();
  for (const t of types) {
    const names = tree.get(t); const td = mkDir(); root.entries.push({ key: t, child: td });
    for (const n of sortKeys(names)) {
      const langs = names.get(n); const nd = mkDir(); td.entries.push({ key: n, child: nd });
      for (const l of sortKeys(langs)) { const leaf = { ...langs.get(l), entryOff: 0, dataOff: 0 }; leaves.push(leaf); nd.entries.push({ key: l, leaf }); }
    }
  }
  let p = 0;
  for (const d of dirs) { d.off = p; p += 16 + d.entries.length * 8; }
  const nameStrings = new Map();
  for (const d of dirs) for (const e of d.entries) if (typeof e.key === 'string' && !nameStrings.has(e.key)) { nameStrings.set(e.key, p); p += 2 + (e.key.length - 4) * 2; }
  p = align(p, 4);
  for (const l of leaves) { l.entryOff = p; p += 16; }
  for (const l of leaves) { p = align(p, 8); l.dataOff = p; p += l.data.length; }
  const rsrcLen = p;
  const rsrc = new Uint8Array(rsrcLen); const rv = new DataView(rsrc.buffer);
  for (const d of dirs) {
    const named = d.entries.filter(e => typeof e.key === 'string').length;
    rv.setUint16(d.off + 8, 4, true); // major version 4 (as MS rc output)
    rv.setUint16(d.off + 12, named, true); rv.setUint16(d.off + 14, d.entries.length - named, true);
    d.entries.forEach((e, i) => {
      const o = d.off + 16 + i * 8;
      rv.setUint32(o, typeof e.key === 'string' ? (0x80000000 | nameStrings.get(e.key)) >>> 0 : e.key, true);
      rv.setUint32(o + 4, e.child ? (0x80000000 | e.child.off) >>> 0 : e.leaf.entryOff, true);
    });
  }
  for (const [s, off] of nameStrings) { const str = s.slice(4); rv.setUint16(off, str.length, true); for (let i = 0; i < str.length; i++) rv.setUint16(off + 2 + i * 2, str.charCodeAt(i), true); }
  for (const l of leaves) {
    rv.setUint32(l.entryOff, RSRC_RVA + l.dataOff, true); rv.setUint32(l.entryOff + 4, l.data.length, true); rv.setUint32(l.entryOff + 8, l.codepage || 0, true);
    rsrc.set(l.data, l.dataOff);
  }
  // ---- PE
  const tpl = b64(PE_TEMPLATE_B64);
  const raw = align(rsrcLen, 0x200);
  const out = new Uint8Array(tpl.length + raw);
  out.set(tpl); out.set(rsrc, tpl.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(OFF.initData, raw, true);
  dv.setUint32(OFF.imageBase, imageBase >>> 0, true);
  dv.setUint32(OFF.sizeOfImage, align(RSRC_RVA + rsrcLen, 0x1000), true);
  dv.setUint32(OFF.rsrcDirSize, rsrcLen, true);
  dv.setUint32(OFF.secVSize, rsrcLen, true);
  dv.setUint32(OFF.secRawSize, raw, true);
  dv.setUint32(OFF.checksum, 0, true);
  dv.setUint32(OFF.checksum, peChecksum(out), true);
  return out;
}

export function peChecksum(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let sum = 0;
  const n = u8.length & ~1;
  for (let i = 0; i < n; i += 2) {
    if (i === OFF.checksum || i === OFF.checksum + 2) continue;
    sum += dv.getUint16(i, true);
    sum = (sum & 0xFFFF) + (sum >>> 16);
  }
  if (u8.length & 1) { sum += u8[u8.length - 1]; sum = (sum & 0xFFFF) + (sum >>> 16); }
  sum = (sum & 0xFFFF) + (sum >>> 16);
  return (sum + u8.length) >>> 0;
}

// ------------------------------------------------------------ infocard helpers (Freelancer RDL)
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export function textToRdl(text) {
  const paras = text.replace(/\r\n/g, '\n').split('\n');
  return '<RDL><PUSH/>' + paras.map(p => (p ? `<TEXT>${esc(p)}</TEXT>` : '') + '<PARA/>').join('') + '<POP/></RDL>';
}
export function rdlToText(xml) {
  if (!xml) return '';
  return xml.replace(/<PARA\s*\/>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').replace(/\n$/, '');
}
// true when the XML only uses <RDL><PUSH/><TEXT/><PARA/><POP/> — i.e. safe to edit as plain text
export function isPlainRdl(xml) {
  return !!xml && /^<RDL>/i.test(xml.trim()) && !/<(?!\/?(RDL|PUSH|POP|TEXT|PARA)\b)[^>]+>/i.test(xml);
}
export function validXml(xml) {
  try { if (typeof DOMParser === 'undefined') return true; const d = new DOMParser().parseFromString(xml, 'application/xml'); return !d.getElementsByTagName('parsererror').length; } catch { return false; }
}
