// UTF ("Universal Tree Format") reader — container for .cmp .3db .sph .mat .txm .ale .vms
export class UtfNode {
  constructor(name, data = null) { this.name = name; this.data = data; this.children = data ? null : []; }
  get isLeaf() { return this.children === null; }
  child(name) {
    if (!this.children) return null;
    const n = name.toLowerCase();
    return this.children.find(c => c.name.toLowerCase() === n) || null;
  }
  path(p) {
    let cur = this;
    for (const part of p.split('/')) { if (!part) continue; cur = cur && cur.child(part); }
    return cur;
  }
  str() { return this.data ? readCString(this.data, 0) : ''; }
  u32(i = 0) { return new DataView(this.data.buffer, this.data.byteOffset, this.data.byteLength).getUint32(i * 4, true); }
  i32(i = 0) { return new DataView(this.data.buffer, this.data.byteOffset, this.data.byteLength).getInt32(i * 4, true); }
  f32(i = 0) { return new DataView(this.data.buffer, this.data.byteOffset, this.data.byteLength).getFloat32(i * 4, true); }
  floats() { const n = this.data.byteLength >> 2; const out = []; for (let i = 0; i < n; i++) out.push(this.f32(i)); return out; }
}

export function readCString(u8, off, max = Infinity) {
  let e = off; const lim = Math.min(u8.length, off + max);
  while (e < lim && u8[e]) e++;
  let s = ''; for (let i = off; i < e; i++) s += String.fromCharCode(u8[i]);
  return s;
}

export function parseUtf(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (u8.length < 56) throw new Error(u8.length ? `Not a UTF file (only ${u8.length} bytes)` : 'Empty file (0 bytes) — the mod ships this file empty');
  if (dv.getUint32(0, true) !== 0x20465455) throw new Error('Not a UTF file');
  const nbo = dv.getUint32(8, true);
  const sbo = dv.getUint32(24, true);
  const dbo = dv.getUint32(36, true);
  const name = (o) => readCString(u8, sbo + o);
  const visited = new Set();
  function read(off) {
    const list = [];
    let guard = 0;
    while (true) {
      if (visited.has(off) || guard++ > 100000) break;
      visited.add(off);
      const b = nbo + off;
      const peer = dv.getUint32(b, true);
      const nm = name(dv.getUint32(b + 4, true));
      const flags = dv.getUint32(b + 8, true);
      const child = dv.getUint32(b + 16, true);
      const size = dv.getUint32(b + 24, true);
      let node;
      if (flags & 0x10) {
        node = new UtfNode(nm);
        if (child) node.children = read(child);
      } else {
        node = new UtfNode(nm, u8.subarray(dbo + child, dbo + child + size));
      }
      list.push(node);
      if (!peer) break;
      off = peer;
    }
    return list;
  }
  const roots = read(0);
  return roots[0];
}

// UTF writer (layout FL accepts):
//   56-byte header · node block (44 bytes per node, depth-first, children right after their parent)
//   · string block (unique names, NUL-terminated, padded to 4) · data block (each leaf padded to 4).
// Identical leaf payloads are stored once.
export function writeUtf(root) {
  const names = new Map(); let strLen = 0;
  const nameOff = (n) => { if (!names.has(n)) { names.set(n, strLen); strLen += n.length + 1; } return names.get(n); };
  const nodes = []; // flat, depth-first
  (function walk(n) { nodes.push(n); nameOff(n.name); if (!n.isLeaf) for (const c of n.children) walk(c); })(root);
  // data block with de-duplication
  const dataOff = new Map(); const chunks = []; let dataLen = 0; const seen = new Map();
  for (const n of nodes) if (n.isLeaf) {
    const d = n.data || new Uint8Array(0);
    let key = d.length + ':'; for (let i = 0; i < Math.min(d.length, 64); i++) key += d[i].toString(16);
    let hit = null;
    for (const [o, b] of seen.get(key) || []) if (b.length === d.length && b.every((x, i) => x === d[i])) { hit = o; break; }
    if (hit != null) { dataOff.set(n, hit); continue; }
    dataOff.set(n, dataLen); if (!seen.has(key)) seen.set(key, []); seen.get(key).push([dataLen, d]);
    chunks.push(d); dataLen += (d.length + 3) & ~3;
  }
  // node offsets: preorder index × 44
  const offOf = new Map(); nodes.forEach((n, i) => offOf.set(n, i * 44));
  const nodeBlock = new Uint8Array(nodes.length * 44); const nd = new DataView(nodeBlock.buffer);
  (function emit(list) {
    list.forEach((n, i) => {
      const o = offOf.get(n), next = list[i + 1];
      // a sibling follows this node's whole subtree, so use the sibling's own offset
      nd.setUint32(o, next ? offOf.get(next) : 0, true);
      nd.setUint32(o + 4, names.get(n.name), true);
      if (n.isLeaf) {
        const len = n.data ? n.data.length : 0;
        nd.setUint32(o + 8, 0x80, true); nd.setUint32(o + 16, dataOff.get(n), true);
        nd.setUint32(o + 20, (len + 3) & ~3, true); nd.setUint32(o + 24, len, true); nd.setUint32(o + 28, len, true);
      } else {
        nd.setUint32(o + 8, 0x10, true); nd.setUint32(o + 16, n.children.length ? offOf.get(n.children[0]) : 0, true);
        emit(n.children);
      }
      for (const k of [32, 36, 40]) nd.setInt32(o + k, -2037297339, true);
    });
  })([root]);
  const strAlloc = (strLen + 3) & ~3;
  const total = 56 + nodeBlock.length + strAlloc + dataLen;
  const out = new Uint8Array(total), dv = new DataView(out.buffer);
  dv.setUint32(0, 0x20465455, true); dv.setUint32(4, 0x101, true);
  dv.setUint32(8, 56, true); dv.setUint32(12, nodeBlock.length, true); dv.setUint32(16, 0, true); dv.setUint32(20, 44, true);
  dv.setUint32(24, 56 + nodeBlock.length, true); dv.setUint32(28, strAlloc, true); dv.setUint32(32, strLen, true);
  dv.setUint32(36, 56 + nodeBlock.length + strAlloc, true);
  dv.setBigUint64(48, 125596224000000000n, true);
  out.set(nodeBlock, 56);
  let p = 56 + nodeBlock.length;
  for (const [n, o] of names) for (let i = 0; i < n.length; i++) out[p + o + i] = n.charCodeAt(i) & 0xFF;
  p = 56 + nodeBlock.length + strAlloc;
  let q = p; for (const c of chunks) { out.set(c, q); q += (c.length + 3) & ~3; }
  return out;
}
// structural comparison (names, tree shape, leaf bytes) for round-trip checks
export function utfEqual(a, b) {
  if (a.name !== b.name || a.isLeaf !== b.isLeaf) return false;
  if (a.isLeaf) { if (a.data.length !== b.data.length) return false; for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return false; return true; }
  if (a.children.length !== b.children.length) return false;
  return a.children.every((c, i) => utfEqual(c, b.children[i]));
}
