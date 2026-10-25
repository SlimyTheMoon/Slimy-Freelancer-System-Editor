// TGA decoder for Freelancer texture libraries → RGBA8, rows top-down (D3D / FL UV convention).
// Handles every TGA kind the game's loader (D3DX) accepts: colour-mapped (1/9), true-colour (2/10) and
// greyscale (3/11), uncompressed and RLE, 8/15/16/24/32 bits, either origin. THREE's TGALoader rejects
// some of these and returned bottom-up rows, so the editor uses this one.
export function isTga(u8) {
  if (!u8 || u8.length < 18) return false;
  const type = u8[2], bpp = u8[16];
  return [1, 2, 3, 9, 10, 11].includes(type) && [8, 15, 16, 24, 32].includes(bpp) && (u8[12] | (u8[13] << 8)) > 0 && (u8[14] | (u8[15] << 8)) > 0;
}

export function decodeTga(u8) {
  if (!isTga(u8)) throw new Error('not a TGA image');
  const idLen = u8[0], cmType = u8[1], type = u8[2];
  const cmFirst = u8[3] | (u8[4] << 8), cmLen = u8[5] | (u8[6] << 8), cmBits = u8[7];
  const w = u8[12] | (u8[13] << 8), h = u8[14] | (u8[15] << 8), bpp = u8[16], desc = u8[17];
  const topDown = !!(desc & 0x20), rightToLeft = !!(desc & 0x10);
  let p = 18 + idLen;
  // colour map
  let pal = null;
  if (cmType === 1) {
    const cb = Math.ceil(cmBits / 8); pal = new Uint8Array((cmFirst + cmLen) * 4);
    for (let i = 0; i < cmLen; i++, p += cb) px(u8, p, cmBits, pal, (cmFirst + i) * 4);
  }
  const B = Math.ceil(bpp / 8), n = w * h, raw = new Uint8Array(n * B);
  if (type >= 9) { // RLE
    let o = 0;
    while (o < raw.length && p < u8.length) {
      const hdr = u8[p++], cnt = (hdr & 0x7f) + 1;
      if (hdr & 0x80) { for (let i = 0; i < cnt && o < raw.length; i++) for (let k = 0; k < B; k++) raw[o++] = u8[p + k]; p += B; }
      else { const len = Math.min(cnt * B, raw.length - o); raw.set(u8.subarray(p, p + len), o); o += len; p += cnt * B; }
    }
  } else raw.set(u8.subarray(p, p + raw.length));
  const out = new Uint8Array(n * 4), kind = type & 3; // 1 mapped, 2 true colour, 3 grey
  for (let i = 0; i < n; i++) {
    const sx = i % w, sy = (i / w) | 0;
    const x = rightToLeft ? w - 1 - sx : sx, y = topDown ? sy : h - 1 - sy, o = (y * w + x) * 4;
    if (kind === 1) { const idx = B === 2 ? raw[i * 2] | (raw[i * 2 + 1] << 8) : raw[i]; if (pal) { out[o] = pal[idx * 4]; out[o + 1] = pal[idx * 4 + 1]; out[o + 2] = pal[idx * 4 + 2]; out[o + 3] = pal[idx * 4 + 3]; } }
    else if (kind === 3) { const v = raw[i * B]; out[o] = out[o + 1] = out[o + 2] = v; out[o + 3] = B === 2 ? raw[i * B + 1] : 255; }
    else px(raw, i * B, bpp, out, o);
  }
  return { width: w, height: h, data: out };
}

// one BGR(A) pixel of the given bit depth → RGBA
function px(src, p, bits, out, o) {
  if (bits === 32) { out[o] = src[p + 2]; out[o + 1] = src[p + 1]; out[o + 2] = src[p]; out[o + 3] = src[p + 3]; }
  else if (bits === 24) { out[o] = src[p + 2]; out[o + 1] = src[p + 1]; out[o + 2] = src[p]; out[o + 3] = 255; }
  else if (bits === 15 || bits === 16) { const v = src[p] | (src[p + 1] << 8); out[o] = ((v >> 10) & 31) * 255 / 31 | 0; out[o + 1] = ((v >> 5) & 31) * 255 / 31 | 0; out[o + 2] = (v & 31) * 255 / 31 | 0; out[o + 3] = 255; }
  else { out[o] = out[o + 1] = out[o + 2] = src[p]; out[o + 3] = 255; }
}

// Freelancer's early "Palette 8 bit" texture: Palette RGB 888 (+ per-mip "Image indices" and optional
// "Alpha 8 bit"). Images are square powers of two in every file seen (vanilla equipment icons, Discovery).
export function decodeFlPalette(node) {
  const pal = (node.children || []).find(c => /^palette/i.test(c.name) && c.isLeaf);
  const mip0 = (node.children || []).find(c => /^mip0$/i.test(c.name) && !c.isLeaf);
  if (!pal || !mip0) return null;
  const idx = mip0.children.find(c => /indices/i.test(c.name)), alpha = mip0.children.find(c => /alpha/i.test(c.name));
  if (!idx || !idx.data || !idx.data.length) return null;
  const n = idx.data.length, side = Math.round(Math.sqrt(n));
  const w = side * side === n ? side : n, h = side * side === n ? side : 1;
  const out = new Uint8Array(n * 4), P = pal.data, A = alpha && alpha.data && alpha.data.length === n ? alpha.data : null;
  for (let i = 0; i < n; i++) { const k = idx.data[i] * 3; out[i * 4] = P[k]; out[i * 4 + 1] = P[k + 1]; out[i * 4 + 2] = P[k + 2]; out[i * 4 + 3] = A ? A[i] : 255; }
  return { width: w, height: h, data: out };
}

// Which bytes hold the image of an FL texture node, decided by content: MIPS / MIPn leaves hold DDS or TGA
// data whatever their names say (Discovery has TGA bytes in MIPS, DDS bytes in MIP0, and a MIPS nested in
// a MIP0 folder). → { dds: Uint8Array } | { rgba: {width,height,data} } | null
export function textureSource(node) {
  const kids = node.children || [];
  const pal = decodeFlPalette(node); if (pal) return { rgba: pal };
  let leaf = kids.find(c => /^mips$/i.test(c.name) && c.isLeaf) || kids.find(c => /^mip0$/i.test(c.name)) || kids.find(c => /^mip\d/i.test(c.name));
  if (leaf && !leaf.isLeaf) leaf = (leaf.children || []).find(c => /^mips$/i.test(c.name) && c.isLeaf) || null;
  if (!leaf || !leaf.data || !leaf.data.length) return null;
  const d = leaf.data;
  if (d.length > 4 && d[0] === 0x44 && d[1] === 0x44 && d[2] === 0x53 && d[3] === 0x20) return { dds: d };
  if (isTga(d)) return { rgba: decodeTga(d) };
  return null;
}
