// INI key reference (written from the reconstructed
// game source): docs for every section/key the game reads (data/inischema.json, built by
// tools/build_inischema.py) and every string literal of that source (data/inistrings.json).
// A key that appears in no string literal is not read by name anywhere in the game.
let schema = null, strings = null, loading = null;
// sections that are read positionally or by a custom parser, so their keys are not compared by name
const POSITIONAL = new Set(['encounterparameters', 'spiels', 'cfg', 'reverb', 'sp ranks', 'mp ranks', 'systems', 'properties']);

export function loadIniDocs() {
  if (!loading) loading = Promise.all([
    fetch('data/inischema.json').then(r => r.ok ? r.json() : null).catch(() => null),
    fetch('data/inistrings.json').then(r => r.ok ? r.json() : null).catch(() => null),
  ]).then(([a, b]) => { schema = a; strings = b ? new Set(b.strings) : null; return !!a; });
  return loading;
}
export const iniDocsReady = () => !!schema;

function sectionKeys(sec) {
  if (!schema) return null;
  const s = schema.sections[(sec || '').toLowerCase()]; if (!s) return null;
  const out = new Map(Object.entries(s.keys));
  for (const g of s.include || []) for (const [k, v] of Object.entries(schema.groups[g].keys)) if (!out.has(k)) out.set(k, v);
  return out;
}
// documentation entry for a key: { key, type, default, meaning, page, heading, source } or null
export function keyDoc(section, key) {
  const m = sectionKeys(section); if (!m) return null;
  return m.get((key || '').toLowerCase()) || null;
}
export function documentedKeys(section) { const m = sectionKeys(section); return m ? [...m.values()].map(e => e.key) : []; }
// true / false / null (unknown: data not loaded or section parsed positionally)
export function keyIsRead(section, key) {
  if (!strings) return null;
  if (POSITIONAL.has((section || '').toLowerCase())) return null;
  const k = (key || '').toLowerCase().trim();
  if (!k || /^[^a-z_]/.test(k)) return null;
  return strings.has(k);
}
// closest documented key (for typos), within edit distance 2
export function suggestKey(section, key) {
  const m = sectionKeys(section); if (!m) return null;
  const k = key.toLowerCase(); let best = null, bd = 3;
  for (const cand of m.keys()) { const d = lev(k, cand, bd); if (d < bd) { bd = d; best = m.get(cand).key; } }
  return best;
}
function lev(a, b, max) {
  if (Math.abs(a.length - b.length) >= max) return max;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]; let rowMin = i;
    for (let j = 1; j <= b.length; j++) { cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); rowMin = Math.min(rowMin, cur[j]); }
    if (rowMin >= max) return max; prev = cur;
  }
  return prev[b.length];
}
// one-line tooltip text
export function keyTip(section, key) {
  const d = keyDoc(section, key);
  const read = keyIsRead(section, key);
  if (d) return `${d.key} — ${d.type || '?'}${d.default ? ` (default ${d.default})` : ''}\n${d.meaning}\n\n[${section}] · ${d.page}${d.source ? ' · ' + d.source : ''}`;
  if (read === false) { const s = suggestKey(section, key); return `${key}: not read by the game — no code in the reconstructed source looks this key up${s ? `. Did you mean “${s}”?` : '.'}`; }
  return key;
}
