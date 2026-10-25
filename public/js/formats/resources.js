// Reads string tables (RT_STRING) and infocards (RT_HTML / ids_info) from Freelancer resource DLLs.
// Global id = (dllIndex << 16) | localId, dllIndex 0 = resources.dll, then [Resources] DLL = ... order.
export function parsePeResources(buf) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const strings = new Map(), html = new Map();
  if (dv.getUint16(0, true) !== 0x5A4D) return { strings, html };
  const pe = dv.getUint32(0x3C, true);
  const nsec = dv.getUint16(pe + 6, true);
  const optSize = dv.getUint16(pe + 20, true);
  const opt = pe + 24;
  const magic = dv.getUint16(opt, true);
  const ddOff = opt + (magic === 0x20B ? 112 : 96);
  const rsrcRva = dv.getUint32(ddOff + 2 * 8, true);
  const secs = [];
  for (let i = 0; i < nsec; i++) {
    const s = opt + optSize + i * 40;
    secs.push({ va: dv.getUint32(s + 12, true), vsize: dv.getUint32(s + 8, true), raw: dv.getUint32(s + 20, true), rsize: dv.getUint32(s + 16, true) });
  }
  const rva2off = (rva) => { for (const s of secs) if (rva >= s.va && rva < s.va + Math.max(s.vsize, s.rsize)) return rva - s.va + s.raw; return -1; };
  const base = rva2off(rsrcRva);
  if (base < 0) return { strings, html };
  const dir = (off) => {
    const named = dv.getUint16(off + 12, true), ids = dv.getUint16(off + 14, true);
    const out = [];
    for (let i = 0; i < named + ids; i++) {
      const e = off + 16 + i * 8;
      out.push({ id: dv.getUint32(e, true), ptr: dv.getUint32(e + 4, true) });
    }
    return out;
  };
  const leaf = (ptr) => { // walk to first language data entry
    let p = ptr;
    while (p & 0x80000000) { const d = dir(base + (p & 0x7FFFFFFF)); if (!d.length) return null; p = d[0].ptr; }
    const de = base + p;
    const off = rva2off(dv.getUint32(de, true));
    return { off, size: dv.getUint32(de + 4, true) };
  };
  const utf16 = (off, chars) => { let s = ''; for (let i = 0; i < chars; i++) s += String.fromCharCode(dv.getUint16(off + i * 2, true)); return s; };
  for (const t of dir(base)) {
    if (!(t.ptr & 0x80000000)) continue;
    if (t.id === 6) {
      for (const blk of dir(base + (t.ptr & 0x7FFFFFFF))) {
        const d = leaf(blk.ptr); if (!d || d.off < 0) continue;
        let p = d.off;
        for (let i = 0; i < 16 && p < d.off + d.size; i++) {
          const len = dv.getUint16(p, true); p += 2;
          if (len) strings.set((blk.id - 1) * 16 + i, utf16(p, len));
          p += len * 2;
        }
      }
    } else if (t.id === 23) {
      for (const r of dir(base + (t.ptr & 0x7FFFFFFF))) {
        const d = leaf(r.ptr); if (!d || d.off < 0) continue;
        let off = d.off, size = d.size;
        if (dv.getUint16(off, true) === 0xFEFF) { off += 2; size -= 2; }
        html.set(r.id, utf16(off, size >> 1).replace(/\0+$/, ''));
      }
    }
  }
  return { strings, html };
}

export function infocardToText(xml) {
  if (!xml) return '';
  return xml.replace(/<PARA\s*\/>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/\n{3,}/g, '\n\n').trim();
}
