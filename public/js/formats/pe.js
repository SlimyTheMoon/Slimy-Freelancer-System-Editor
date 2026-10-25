// Minimal PE (Win32 exe/dll) header reader: sections, image base, file offset ↔ RVA.
export function parsePE(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint16(0, true) !== 0x5A4D) throw new Error('not an MZ executable');
  const pe = dv.getUint32(0x3C, true);
  if (dv.getUint32(pe, true) !== 0x4550) throw new Error('no PE header');
  const nsec = dv.getUint16(pe + 6, true), optSize = dv.getUint16(pe + 20, true), opt = pe + 24;
  const imageBase = dv.getUint32(opt + 28, true), timestamp = dv.getUint32(pe + 8, true);
  const sections = [];
  for (let i = 0; i < nsec; i++) {
    const o = opt + optSize + i * 40;
    let name = ''; for (let k = 0; k < 8 && u8[o + k]; k++) name += String.fromCharCode(u8[o + k]);
    sections.push({ name, vsize: dv.getUint32(o + 8, true), va: dv.getUint32(o + 12, true), rawSize: dv.getUint32(o + 16, true), raw: dv.getUint32(o + 20, true), flags: dv.getUint32(o + 36, true) });
  }
  return {
    imageBase, timestamp, sections,
    offToRva(off) { const s = sections.find(s => off >= s.raw && off < s.raw + s.rawSize); return s ? { rva: off - s.raw + s.va, section: s } : null; },
    rvaToOff(rva) { const s = sections.find(s => rva >= s.va && rva < s.va + Math.max(s.vsize, s.rawSize)); return s ? rva - s.va + s.raw : null; },
  };
}
