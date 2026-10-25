// DACOM_CRC::GetCRC32 — ported from the reconstruction in src/dacom/dacom_crc.cpp
// (dacom.dll 0x065B4380, verified L1/L2/L3 in decompilation_audit.md).
// Freelancer uses this exact hash to link VMeshRef -> VMeshData (VMeshLibId) and
// VMeshData mesh -> material (MaterialId) inside .cmp/.3db files.
// Table blob = 256 x u32 non-IEEE CRC table followed by the 256-byte tolower table
// (signed-char indexing: bytes >= 0x80 read the tail of the CRC table, as in the original).
const B64 = "AAAAAJYwBwksYQ4SulEJGxnEbf+P9Gr2NaVj7aOVZOQyiNv+pLjc9x7p1eyI2dLlK0y2Ab18sQgHLbgTkR2/GmQQt/3yILD0SHG5795BvuZ91NoC6+TdC1G11BDHhdMZVphsA8Coawp6+WIR7MllGE9cAfzZbAb1Yz0P7vUNCOfIIG77XhBp8uRBYOlycWfg0eQDBEfUBA39hQ0Wa7UKH/qotQVsmLIM1sm7F0D5vB7jbNj6dVzf888N1uhZPdHhrDDZBjoA3g+AUdcUFmHQHbX0tPkjxLPwmZW66w+lveKeuAL4CIgF8bLZDOok6Qvjh3xvBxFMaA6rHWEVPS1mHJBB3PYGcdv/vCDS5CoQ1e2JhbEJH7W2AKXkvxsz1LgSoskHCDT5AAGOqAkaGJgOE7sNavctPW3+l2xk5QFcY+z0UWsLYmFsAtgwZRlOAGIQ7ZUG9HulAf3B9AjmV8QP78bZsPVQ6bf86ri+53yIue7fHd0KSS3aA/N80xhlTNQRWGGyDc5RtQR0ALwf4jC7FkGl3/LXldj7bcTR4Pv01ulq6Wnz/Nlu+kaIZ+HQuGDocy0EDOUdAwVfTAoeyXwNFzxxBfCqQQL5EBAL4oYgDOsltWgPs4VvBgnUZh2f5GEUDvneDpjJ2QcimNActKjXFRc9s/GBDbT4O1y9461suuogg7jttrO/5Azitv+a0rH2OUfVEq930hsVJtsAgxbcCRILYxOEO2QaPmptAahaaggLzw7snf8J5SeuAP6xngf3RJMPENKjCBlo8gEC/sIGC11XYu/LZ2XmcTZs/ecGa/R2G9Tu4CvT51p62vzMSt31b9+5EfnvvhhDvrcD1Y6wCuij1hZ+k9EfxMLYBFLy3w3xZ7vpZ1e84N0GtftLNrLy2isN6EwbCuH2SgP6YHoE88PvYBdV32ce745uBXm+aQyMs2HrGoNm4qDSb/k24mjwlXcMFANHCx25FgIGLyYFD747uhUoC70cklq0BwRqsw6n/9fqMc/Q44ue2fgdrt7xsMJkGybyYxKco2oJCpNtAKkGCeQ/Ng7thWcH9hNXAP+CSr/lFHq47K4rsfc4G7b+m47SGg2+1RO379wIId/bAdTS0+ZC4tTv+LPd9G6D2v3NFr4ZWya5EOF3sAt3R7cC5loIGHBqDxHKOwYKXAsBA/+eZedprmLu0/9r9UXPbPx44grg7tIN6VSDBPLCswP7YSZnH/cWYBZNR2kN23duBEpq0R7cWtYXZgvfDPA72AVTrrzhxZ676H/PsvPp/7X6HPK9HYrCuhQwk7MPpqO0BgU20OKTBtfrKVfe8L9n2fkuembjuEph6gIbaPGUK2/4N74LHKGODBUb3wUOje8CBwABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4fICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj9AYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpbXF1eX2BhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ent8fX5/gIGCg4SFhoeIiYqLjI2Oj5CRkpOUlZaXmJmam5ydnp+goaKjpKWmp6ipqqusra6vsLGys7S1tre4ubq7vL2+v8DBwsPExcbHyMnKy8zNzs/Q0dLT1NXW19jZ2tvc3d7f4OHi4+Tl5ufo6err7O3u7/Dx8vP09fb3+Pn6+/z9/v8=";
const blob = Uint8Array.from(atob(B64), c => c.charCodeAt(0));
const dv = new DataView(blob.buffer);
const T = new Uint32Array(256);
for (let i = 0; i < 256; i++) T[i] = dv.getUint32(i * 4, true);
function foldChar(c) { const s = (c << 24) >> 24; return blob[1024 + s]; }
export function dacomCrc(str) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i) & 0xFF;
    c = ((c >>> 8) ^ T[(foldChar(ch) ^ (c & 0xFF)) & 0xFF]) >>> 0;
  }
  return (~c) >>> 0;
}
// ALE CRC: same DACOM table, no case folding (used for .ale node/effect ids)
export function aleCrc(str) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < str.length; i++) c = ((c >>> 8) ^ T[((c & 0xFF) ^ (str.charCodeAt(i) & 0xFF)) & 0xFF]) >>> 0;
  return (~c) >>> 0;
}

// Freelancer CreateID (Common.dll CFLIDMaker::CreateStaticID @0x0630d1f0): lower-cased, CRC over a
// "modded" CRC-16/IBM table, byte-swapped, >> 2, top bit set.
const IDT = new Uint32Array(256);
for (let i = 0; i < 256; i++) { let x = i; for (let j = 0; j < 8; j++) x = (x & 1) ? ((x >>> 1) ^ (0xA001 << 14)) >>> 0 : x >>> 1; IDT[i] = x >>> 0; }
export function createID(str) {
  const s = str.toLowerCase();
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = ((hash >>> 8) ^ IDT[(hash & 0xFF) ^ (s.charCodeAt(i) & 0xFF)]) >>> 0;
  hash = ((hash >>> 24) | ((hash >>> 8) & 0x0000FF00) | ((hash << 8) & 0x00FF0000) | (hash << 24)) >>> 0;
  return ((hash >>> 2) | 0x80000000) >>> 0;
}
// Faction hash (Common.dll MakeId @0x0630e510): CRC-16/CCITT table — verified entry-for-entry against the
// table at 0x063ed230 in Common.dll — start 0xFFFF, lower-cased.
const FT = new Uint16Array(256);
for (let i = 0; i < 256; i++) { let x = (i << 8) & 0xFFFF; for (let j = 0; j < 8; j++) x = (x & 0x8000) ? ((x << 1) ^ 0x1021) & 0xFFFF : (x << 1) & 0xFFFF; FT[i] = x; }
export function facHash(str) {
  let h = 0xFFFF; const s = str.toLowerCase();
  for (let i = 0; i < s.length; i++) h = (FT[(h & 0xFF) ^ (s.charCodeAt(i) & 0xFF)] ^ (h >>> 8)) & 0xFFFF;
  return h;
}
