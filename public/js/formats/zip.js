// Minimal ZIP writer / reader (stored + deflate via the browser's CompressionStream).
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
async function pipe(u8, stream) { const s = new Blob([u8]).stream().pipeThrough(stream); return new Uint8Array(await new Response(s).arrayBuffer()); }
const deflate = (u8) => pipe(u8, new CompressionStream('deflate-raw'));
const inflate = (u8) => pipe(u8, new DecompressionStream('deflate-raw'));
const enc = (s) => new TextEncoder().encode(s);

// files: [{ name: 'DATA/x.ini', data: Uint8Array }] → Uint8Array (.zip)
export async function writeZip(files) {
  const parts = [], central = []; let off = 0;
  const now = new Date(), dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1), dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const name = enc(f.name.replace(/\\/g, '/')), crc = crc32(f.data);
    let data = f.data, method = 0;
    if (f.data.length > 64) { const d = await deflate(f.data); if (d.length < f.data.length * 0.95) { data = d; method = 8; } }
    const lh = new Uint8Array(30 + name.length), lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, method, true); lv.setUint16(10, dosTime, true); lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true); lv.setUint32(18, data.length, true); lv.setUint32(22, f.data.length, true); lv.setUint16(26, name.length, true); lh.set(name, 30);
    const ch = new Uint8Array(46 + name.length), cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true); cv.setUint16(10, method, true); cv.setUint16(12, dosTime, true); cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, f.data.length, true); cv.setUint16(28, name.length, true); cv.setUint32(42, off, true); ch.set(name, 46);
    parts.push(lh, data); central.push(ch); off += lh.length + data.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22), ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true); ev.setUint32(12, cdSize, true); ev.setUint32(16, off, true);
  const out = new Uint8Array(off + cdSize + 22); let p = 0;
  for (const x of [...parts, ...central, end]) { out.set(x, p); p += x.length; }
  return out;
}

// .zip → [{ name, data }]
export async function readZip(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let e = u8.length - 22; while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error('not a zip file');
  const n = dv.getUint16(e + 10, true); let p = dv.getUint32(e + 16, true);
  const out = [];
  for (let i = 0; i < n; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('bad zip directory');
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), lo = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    const ds = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true);
    const raw = u8.subarray(ds, ds + csize);
    let data;
    if (method === 0) data = raw.slice(); else if (method === 8) data = await inflate(raw); else throw new Error(`${name}: compression method ${method} not supported`);
    out.push({ name, data });
  }
  return out;
}
