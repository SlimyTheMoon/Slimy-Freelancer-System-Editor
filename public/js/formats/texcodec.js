// Texture codecs for model import/export: DXT1/DXT3/DXT5 encode + decode, DDS writer, mip chains,
// and decoding of FL texture-library nodes (MIPS = DDS, MIP0 = TGA) to plain RGBA.
import { textureSource } from './tga.js';

// ---------- helpers ----------
const to565 = (r, g, b) => ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
const from565 = (c) => [((c >> 11) & 31) * 255 / 31 | 0, ((c >> 5) & 63) * 255 / 63 | 0, (c & 31) * 255 / 31 | 0];

export function isPow2(n) { return n > 0 && (n & (n - 1)) === 0; }
export function nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }

// Box-filter resize (any size → w×h), RGBA8
export function resizeRGBA(src, sw, sh, dw, dh) {
  if (sw === dw && sh === dh) return src;
  const out = new Uint8Array(dw * dh * 4);
  const fx = sw / dw, fy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * fy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * fx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1 && yy < sh; yy++) for (let xx = x0; xx < x1 && xx < sw; xx++) {
        const i = (yy * sw + xx) * 4; r += src[i]; g += src[i + 1]; b += src[i + 2]; a += src[i + 3]; n++;
      }
      const o = (y * dw + x) * 4; out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
    }
  }
  return out;
}

export function mipChain(rgba, w, h) {
  const levels = [{ w, h, data: rgba }];
  while (w > 1 || h > 1) {
    const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1);
    rgba = resizeRGBA(rgba, w, h, nw, nh); w = nw; h = nh;
    levels.push({ w, h, data: rgba });
  }
  return levels;
}

// ---------- DXT encode (bounding-box endpoints with inset, nearest palette entry) ----------
function encodeColorBlock(px, out, o, allowAlpha1bit) {
  let minR = 255, minG = 255, minB = 255, maxR = 0, maxG = 0, maxB = 0, transparent = false;
  for (let i = 0; i < 16; i++) {
    const a = px[i * 4 + 3];
    if (allowAlpha1bit && a < 128) { transparent = true; continue; }
    const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
    if (r < minR) minR = r; if (g < minG) minG = g; if (b < minB) minB = b;
    if (r > maxR) maxR = r; if (g > maxG) maxG = g; if (b > maxB) maxB = b;
  }
  if (minR > maxR) { minR = maxR = minG = maxG = minB = maxB = 0; }
  // inset the box a little (reduces error, as in the classic real-time DXT encoders)
  const ir = (maxR - minR) >> 4, ig = (maxG - minG) >> 4, ib = (maxB - minB) >> 4;
  minR = Math.min(255, minR + ir); minG = Math.min(255, minG + ig); minB = Math.min(255, minB + ib);
  maxR = Math.max(0, maxR - ir); maxG = Math.max(0, maxG - ig); maxB = Math.max(0, maxB - ib);
  let c0 = to565(maxR, maxG, maxB), c1 = to565(minR, minG, minB);
  const dv = new DataView(out.buffer, out.byteOffset);
  let pal;
  if (transparent) {
    if (c0 > c1) [c0, c1] = [c1, c0];          // c0 <= c1 → 3-colour + transparent mode
    const a = from565(c0), b = from565(c1);
    pal = [a, b, a.map((v, k) => (v + b[k]) >> 1), null];
  } else {
    if (c0 < c1) [c0, c1] = [c1, c0];
    if (c0 === c1) { pal = [from565(c0), from565(c0), from565(c0), from565(c0)]; }
    else { const a = from565(c0), b = from565(c1); pal = [a, b, a.map((v, k) => (2 * v + b[k]) / 3 | 0), a.map((v, k) => (v + 2 * b[k]) / 3 | 0)]; }
  }
  dv.setUint16(o, c0, true); dv.setUint16(o + 2, c1, true);
  let bits = 0;
  for (let i = 15; i >= 0; i--) {
    let best = 0;
    if (transparent && px[i * 4 + 3] < 128) best = 3;
    else {
      let bd = Infinity;
      for (let k = 0; k < 4; k++) {
        const p = pal[k]; if (!p) continue;
        const dr = p[0] - px[i * 4], dg = p[1] - px[i * 4 + 1], db = p[2] - px[i * 4 + 2];
        const d = dr * dr * 3 + dg * dg * 4 + db * db * 2;
        if (d < bd) { bd = d; best = k; }
      }
    }
    bits = (bits << 2) | best;
  }
  dv.setUint32(o + 4, bits >>> 0, true);
}
function encodeAlphaBlock(px, out, o) {
  let mn = 255, mx = 0;
  for (let i = 0; i < 16; i++) { const a = px[i * 4 + 3]; if (a < mn) mn = a; if (a > mx) mx = a; }
  out[o] = mx; out[o + 1] = mn;
  const pal = [mx, mn];
  if (mx > mn) for (let k = 1; k < 7; k++) pal.push(((7 - k) * mx + k * mn) / 7 | 0);
  else for (let k = 0; k < 6; k++) pal.push(mx);
  for (let k = 2; k < 8; k++) out[o + k] = 0;
  for (let i = 0; i < 16; i++) {
    const a = px[i * 4 + 3]; let best = 0, bd = 1e9;
    for (let k = 0; k < 8; k++) { const d = Math.abs(pal[k] - a); if (d < bd) { bd = d; best = k; } }
    for (let b = 0; b < 3; b++) { const bit = i * 3 + b; if ((best >> b) & 1) out[o + 2 + (bit >> 3)] |= 1 << (bit & 7); }
  }
}
export function encodeDXT(rgba, w, h, format /* 'DXT1' | 'DXT5' */) {
  const bw = Math.max(1, (w + 3) >> 2), bh = Math.max(1, (h + 3) >> 2);
  const bs = format === 'DXT1' ? 8 : 16;
  const out = new Uint8Array(bw * bh * bs);
  const px = new Uint8Array(64);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      const sx = Math.min(w - 1, bx * 4 + x), sy = Math.min(h - 1, by * 4 + y);
      const s = (sy * w + sx) * 4, d = (y * 4 + x) * 4;
      px[d] = rgba[s]; px[d + 1] = rgba[s + 1]; px[d + 2] = rgba[s + 2]; px[d + 3] = rgba[s + 3];
    }
    const o = (by * bw + bx) * bs;
    if (format === 'DXT1') encodeColorBlock(px, out, o, true);
    else { encodeAlphaBlock(px, out, o); encodeColorBlock(px, out, o + 8, false); }
  }
  return out;
}

// ---------- DXT decode ----------
export function decodeDXT(data, w, h, format) {
  const out = new Uint8Array(w * h * 4);
  const bw = Math.max(1, (w + 3) >> 2), bh = Math.max(1, (h + 3) >> 2);
  const bs = format === 'DXT1' ? 8 : 16;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    const o = (by * bw + bx) * bs;
    if (o + bs > data.length) continue;
    const co = format === 'DXT1' ? o : o + 8;
    const c0 = dv.getUint16(co, true), c1 = dv.getUint16(co + 2, true), bits = dv.getUint32(co + 4, true);
    const a = from565(c0), b = from565(c1);
    let pal;
    if (c0 > c1 || format !== 'DXT1') pal = [[...a, 255], [...b, 255], [...a.map((v, k) => (2 * v + b[k]) / 3 | 0), 255], [...a.map((v, k) => (v + 2 * b[k]) / 3 | 0), 255]];
    else pal = [[...a, 255], [...b, 255], [...a.map((v, k) => (v + b[k]) >> 1), 255], [0, 0, 0, 0]];
    let alpha = null;
    if (format === 'DXT3') {
      alpha = []; for (let i = 0; i < 8; i++) { const v = data[o + i]; alpha.push((v & 15) * 17, (v >> 4) * 17); }
    } else if (format === 'DXT5') {
      const a0 = data[o], a1 = data[o + 1];
      const ap = [a0, a1];
      if (a0 > a1) for (let k = 1; k < 7; k++) ap.push(((7 - k) * a0 + k * a1) / 7 | 0);
      else { for (let k = 1; k < 5; k++) ap.push(((5 - k) * a0 + k * a1) / 5 | 0); ap.push(0, 255); }
      alpha = [];
      for (let i = 0; i < 16; i++) { let idx = 0; for (let b = 0; b < 3; b++) { const bit = i * 3 + b; idx |= ((data[o + 2 + (bit >> 3)] >> (bit & 7)) & 1) << b; } alpha.push(ap[idx]); }
    }
    for (let i = 0; i < 16; i++) {
      const x = bx * 4 + (i & 3), y = by * 4 + (i >> 2);
      if (x >= w || y >= h) continue;
      const p = pal[(bits >>> (i * 2)) & 3], d = (y * w + x) * 4;
      out[d] = p[0]; out[d + 1] = p[1]; out[d + 2] = p[2]; out[d + 3] = alpha ? alpha[i] : p[3];
    }
  }
  return out;
}

// ---------- DDS ----------
export function writeDDS(levels, format /* 'DXT1'|'DXT5'|'ARGB' */) {
  const bodies = levels.map(l => format === 'ARGB' ? rgbaToBgra(l.data) : encodeDXT(l.data, l.w, l.h, format));
  const size = 128 + bodies.reduce((s, b) => s + b.length, 0);
  const out = new Uint8Array(size), dv = new DataView(out.buffer);
  dv.setUint32(0, 0x20534444, true); dv.setUint32(4, 124, true);
  const linear = format !== 'ARGB';
  dv.setUint32(8, 0x1007 | 0x20000 | (linear ? 0x80000 : 0x8), true);
  dv.setUint32(12, levels[0].h, true); dv.setUint32(16, levels[0].w, true);
  dv.setUint32(20, linear ? bodies[0].length : levels[0].w * 4, true);
  dv.setUint32(28, levels.length, true);
  dv.setUint32(76, 32, true);
  if (linear) { dv.setUint32(80, 4, true); for (let i = 0; i < 4; i++) out[84 + i] = format.charCodeAt(i); }
  else { dv.setUint32(80, 0x41, true); dv.setUint32(88, 32, true); dv.setUint32(92, 0x00ff0000, true); dv.setUint32(96, 0x0000ff00, true); dv.setUint32(100, 0x000000ff, true); dv.setUint32(104, 0xff000000, true); }
  dv.setUint32(108, 0x1000 | (levels.length > 1 ? 0x400008 : 0), true);
  let p = 128; for (const b of bodies) { out.set(b, p); p += b.length; }
  return out;
}
function rgbaToBgra(d) { const o = new Uint8Array(d.length); for (let i = 0; i < d.length; i += 4) { o[i] = d[i + 2]; o[i + 1] = d[i + 1]; o[i + 2] = d[i]; o[i + 3] = d[i + 3]; } return o; }

export function readDDS(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint32(0, true) !== 0x20534444) throw new Error('not DDS');
  const h = dv.getUint32(12, true), w = dv.getUint32(16, true);
  const pfFlags = dv.getUint32(80, true);
  const four = String.fromCharCode(u8[84], u8[85], u8[86], u8[87]);
  const body = u8.subarray(128);
  if (pfFlags & 4) {
    if (!/DXT[135]/.test(four)) throw new Error('unsupported DDS ' + four);
    return { w, h, rgba: decodeDXT(body, w, h, four) };
  }
  const bits = dv.getUint32(88, true), rm = dv.getUint32(92, true), gm = dv.getUint32(96, true), bm = dv.getUint32(100, true), am = dv.getUint32(104, true);
  const bpp = bits >> 3, out = new Uint8Array(w * h * 4);
  const sh = (m) => { if (!m) return [0, 0]; let s = 0; while (!((m >>> s) & 1)) s++; let n = 0; while ((m >>> (s + n)) & 1) n++; return [s, n]; };
  const [rs, rn] = sh(rm), [gs, gn] = sh(gm), [bs, bn] = sh(bm), [as, an] = sh(am);
  const sc = (v, n) => n ? Math.round(v * 255 / ((1 << n) - 1)) : 255;
  for (let i = 0; i < w * h; i++) {
    let v = 0; for (let k = 0; k < bpp; k++) v |= body[i * bpp + k] << (8 * k); v >>>= 0;
    out[i * 4] = sc((v & rm) >>> rs, rn); out[i * 4 + 1] = sc((v & gm) >>> gs, gn); out[i * 4 + 2] = sc((v & bm) >>> bs, bn); out[i * 4 + 3] = am ? sc((v & am) >>> as, an) : 255;
  }
  return { w, h, rgba: out };
}

// FL texture-library entry → { w, h, rgba } with rows top-down (D3D/glTF UV convention)
export function decodeTextureNode(node) {
  const src = textureSource(node);
  if (!src) return null;
  if (src.dds) return readDDS(src.dds);
  return { w: src.rgba.width, h: src.rgba.height, rgba: src.rgba.data };
}

// Image (any browser-decodable: png/jpg/webp/bmp/tga via caller) → texture-library DDS bytes
export function rgbaToFlDDS(rgba, w, h, { maxSize = 2048 } = {}) {
  let tw = Math.min(maxSize, nextPow2(w)), th = Math.min(maxSize, nextPow2(h));
  const data = resizeRGBA(rgba, w, h, tw, th);
  let alpha = false; for (let i = 3; i < data.length; i += 4) if (data[i] < 250) { alpha = true; break; }
  const fmt = alpha ? 'DXT5' : 'DXT1';
  return { bytes: writeDDS(mipChain(data, tw, th), fmt), format: fmt, w: tw, h: th, alpha };
}
