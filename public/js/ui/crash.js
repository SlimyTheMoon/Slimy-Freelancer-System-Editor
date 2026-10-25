// Crash & log analyser (Tools menu). Paste a crash report / Windows event text / FLSpew.txt (or load
// FLSpew.txt directly). Crash addresses (module+offset, Event Viewer "Fault offset", bare addresses)
// are mapped to the containing function of the game binary (this project's Ghidra pipeline) and, where
// the decompiled source names it, to the C++ function and source file. FLSpew lines are grouped,
// traced to the code that prints them (FDUMP format strings) and the names they
// mention are looked up in the game data.
import { h, modal, toast } from './dom.js';

let MAP = null;
export async function loadMap() {
  if (!MAP) MAP = fetch('data/crashmap.json').then(r => r.ok ? r.json() : null).then(m => {
    if (!m) return null;
    // log formats -> regex
    m.logRx = m.logs.map(([fmt, src]) => {
      const lit = fmt.replace(/\\n|\\r|\\t/g, ' ').trim();
      let rx = ''; let i = 0, groups = 0;
      const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      for (const m2 of lit.matchAll(/%[-+ #0]*\d*(?:\.\d+)?(?:l|ll|h|I64)?[sdiuxXfgcp]/g)) { rx += esc(lit.slice(i, m2.index)).replace(/\s+/g, '\\s*'); rx += m2[0].endsWith('s') ? '(.*?)' : '([-\\w.]+)'; i = m2.index + m2[0].length; groups++; }
      rx += esc(lit.slice(i)).replace(/\s+/g, '\\s*');
      const fixed = lit.replace(/%[-+ #0]*\d*(?:\.\d+)?(?:l|ll|h|I64)?[sdiuxXfgcp]/g, '').replace(/[^A-Za-z]/g, '').length;
      try { return fixed >= 8 ? { re: new RegExp(rx, 'i'), src, fmt: lit, fixed } : null; } catch { return null; }
    }).filter(Boolean).sort((a, b) => b.fixed - a.fixed);
    return m;
  }).catch(() => null);
  return MAP;
}

// containing function of module+rva
export function lookup(map, mod, rva) {
  const list = map.funcs[mod]; if (!list) return null;
  let lo = 0, hi = list.length - 1, best = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (list[mid][0] <= rva) { best = mid; lo = mid + 1; } else hi = mid - 1; }
  if (best < 0) return null;
  const [start, size, gname, cname, src] = list[best];
  const off = rva - start;
  if (size && off >= size + 16) return { near: true, start, gname, cname, src, off };
  return { start, size, gname, cname, src, off };
}
const hex = (n, w = 8) => '0x' + (n >>> 0).toString(16).toUpperCase().padStart(w, '0');

function findCrashes(map, text) {
  const out = [], seen = new Set();
  const push = (mod, rva, how, line) => {
    mod = mod.toLowerCase(); const k = mod + ':' + rva; if (seen.has(k)) return; seen.add(k);
    out.push({ mod, rva, how, line: line.trim().slice(0, 200) });
  };
  for (const line of text.split(/\r?\n/)) {
    for (const m of line.matchAll(/([\w.-]+\.(?:dll|exe))\s*(?:\+|@|:|!|, offset)\s*(?:0x)?([0-9a-f]{1,8})\b/gi)) push(m[1], parseInt(m[2], 16), 'module+offset', line);
  }
  // Windows Event Viewer / WER: "Faulting module name: Common.dll, ..." + "Fault offset: 0x0001a2b3"
  const fm = /Faulting module name:\s*([^\s,]+)/i.exec(text) || /Fault Module Name:\s*([^\s,]+)/i.exec(text), fo = /Fault offset:\s*(?:0x)?([0-9a-f]+)/i.exec(text) || /Fault Offset:\s*(?:0x)?([0-9a-f]+)/i.exec(text);
  if (fm && fo) {
    push(fm[1], parseInt(fo[1], 16), 'Windows error report', `${fm[0]} · ${fo[0]}`);
    // the module time stamp tells whether the crash came from the same build the map describes
    const ts = /Faulting module name:[^\n]*?time stamp:\s*0x([0-9a-f]+)/i.exec(text), info = map.modules[fm[1].toLowerCase()];
    if (ts && info && parseInt(ts[1], 16) !== info.timestamp) out[out.length - 1].stamp = `The crashed ${fm[1]} has time stamp 0x${ts[1]}, the HD Edition one is 0x${info.timestamp.toString(16)}: a different or patched build, so function names may be off.`;
  }
  // bare absolute addresses inside a game module (e.g. "EIP=0626A1B4", "at address 06ce4f10")
  for (const line of text.split(/\r?\n/)) for (const m of line.matchAll(/(?:EIP|address|at|eip)\s*[=:]?\s*(?:0x)?(0[0-9a-f]{7})\b/gi)) {
    const a = parseInt(m[1], 16);
    for (const [mod, info] of Object.entries(map.modules)) if (a >= info.base && a < info.base + info.size && (mod.endsWith('.dll') || a < 0x01000000)) { push(mod, a - info.base, 'address', line); break; }
  }
  return out;
}

function parseSpew(map, text) {
  const groups = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line) continue;
    if (!/(error|warning|fail|assert|unable|can't|cannot|not found|invalid|missing|unknown|bad )/i.test(line)) continue;
    const key = line.replace(/\b\d+(\.\d+)?\b/g, '#').replace(/0x[0-9a-f]+/gi, '#');
    const g = groups.get(key) || { line, count: 0, sev: /error|assert|fail/i.test(line) ? 'err' : 'warn' };
    g.count++; groups.set(key, g);
  }
  const out = [...groups.values()].sort((a, b) => (a.sev === b.sev ? b.count - a.count : a.sev === 'err' ? -1 : 1));
  for (const g of out) {
    for (const f of map.logRx) { const m = f.re.exec(g.line); if (m) { g.src = f.src; g.fmt = f.fmt; g.args = m.slice(1).filter(x => x && x.length < 80); break; } }
    // names worth looking up: quoted strings, args, path-ish tokens
    const names = new Set([...(g.args || []), ...[...g.line.matchAll(/['"]([^'"]{2,80})['"]/g)].map(x => x[1]), ...[...g.line.matchAll(/\b([A-Za-z0-9_]+\\[\w\\.]+\.(?:ini|cmp|3db|mat|txm|ale|thn|utf|wav|dll))\b/gi)].map(x => x[1])]);
    for (const x of g.line.replace(/^.*?\)\s*:/, '').matchAll(/\b([A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+)\b/g)) names.add(x[1]); // nickname-like tokens
    g.names = [...names].filter(n => /[A-Za-z]/.test(n) && !/^(error|warning)$/i.test(n)).slice(0, 4);
    const rs = /([\w.]+\.(?:cpp|c|h))\((\d+)\)/i.exec(g.line); if (rs) g.retailSrc = `${rs[1]} line ${rs[2]}`;
  }
  return out;
}

export async function crashAnalyzer(app, opts = {}) {
  const map = await loadMap();
  if (!map) { toast('crashmap.json missing — the analyser data was not installed'); return; }
  const ta = h('textarea', { placeholder: 'Paste a crash report, a Windows Event Viewer / error report text, an FLHook crash log or FLSpew.txt here…', style: { width: '100%', height: '120px', font: '12px var(--mono)' } });
  const out = h('div', { style: { overflow: 'auto', maxHeight: '52vh', marginTop: '8px' } });
  const run = () => analyse(ta.value);
  let spewBtn;
  const body = h('div', {},
    h('div', { style: { display: 'flex', gap: '6px', marginBottom: '6px', flexWrap: 'wrap' } },
      h('button', { class: 'btn primary', onclick: run }, 'Analyse'),
      spewBtn = h('button', { class: 'btn', title: 'Reads %LOCALAPPDATA%\\Freelancer\\FLSpew.txt (the game log written on every run)', onclick: async () => {
        const r = await fetch('/api/flspew'); if (!r.ok) { toast('FLSpew.txt not found — use "Open file…"', 4000); return; }
        const j = await r.json(); ta.value = j.text; toast(`Loaded ${j.path} (${(j.text.length / 1024).toFixed(0)} KB, ${j.modified})`); run();
      } }, 'Load FLSpew.txt'),
      h('button', { class: 'btn', onclick: () => { const i = document.createElement('input'); i.type = 'file'; i.accept = '.txt,.log,.dmp,.ini'; i.onchange = async () => { const f = i.files[0]; if (f) { ta.value = (await f.text()).slice(-2_000_000); run(); } }; i.click(); } }, 'Open file…'),
      h('span', { style: { flex: 1 } }),
      h('span', { style: { color: 'var(--faint)', fontSize: '11px', alignSelf: 'center' } }, `${Object.values(map.funcs).reduce((a, l) => a + l.length, 0).toLocaleString()} functions · ${map.logs.length.toLocaleString()} log messages known`)),
    ta, out);
  const m = modal({ title: 'Crash & log analyser', wide: true, body, buttons: [{ label: 'Close' }] });
  m.box.classList.add('xwide');
  if (opts.loadSpew && spewBtn) spewBtn.click();

  async function analyse(text) {
    out.innerHTML = '';
    if (!text.trim()) { out.append(h('div', { class: 'empty' }, 'Nothing to analyse.')); return; }
    const crashes = findCrashes(map, text);
    if (crashes.length) {
      const sec = h('div', { class: 'psec' }, h('h3', {}, `Crash location${crashes.length > 1 ? 's' : ''}`));
      for (const c of crashes) {
        const info = map.modules[c.mod];
        const f = info ? lookup(map, c.mod, c.rva) : null;
        const va = info ? info.base + c.rva : null;
        sec.append(h('div', { class: 'crashrow' },
          h('div', {}, h('b', {}, c.mod), ` + ${hex(c.rva, 6)}`, va != null ? h('span', { class: 'sub' }, `  (address ${hex(va)})`) : null, h('span', { class: 'sub' }, ` · from ${c.how}`)),
          !info ? h('div', { class: 'sev-warn' }, `${c.mod} is not a Freelancer binary — a mod or plugin DLL (or a driver) crashed. Try disabling it in EXE\\dacom.ini [Libraries] (or the matching loader) and test again.`)
            : !f ? h('div', { class: 'sub' }, 'No function information for this module (not covered by the decompilation).')
              : h('div', {},
                h('div', {}, f.cname ? h('b', {}, f.cname) : h('b', {}, f.gname), f.cname ? h('span', { class: 'sub' }, `  (${f.gname})`) : null, h('span', { class: 'sub' }, `  + ${hex(f.off, 1)}${f.near ? ' — past the end of the nearest known function' : ''}`)),
                f.src ? h('div', { class: 'sub' }, 'Source: ', h('code', {}, 'src/' + f.src)) : h('div', { class: 'sub' }, `Ghidra listing: pipeline\\out\\${c.mod === 'freelancer.exe' ? 'Freelancer.exe' : c.mod.replace(/^common/, 'Common').replace(/^server/, 'Server')}\\funcs\\${hex(info.base + f.start).slice(2).toLowerCase()}_*.c`),
                hint(f)),
          c.stamp ? h('div', { class: 'sev-warn', style: { fontSize: '11px' } }, c.stamp) : null,
          h('div', { class: 'sub', style: { fontFamily: 'var(--mono)', fontSize: '10px' } }, c.line)));
      }
      out.append(sec);
    }
    const spew = parseSpew(map, text);
    if (spew.length) {
      const sec = h('div', { class: 'psec' }, h('h3', {}, `Log messages (${spew.length} distinct)`));
      for (const g of spew.slice(0, 200)) {
        const row = h('div', { class: 'crashrow' },
          h('div', {}, h('span', { class: 'sev-' + g.sev }, g.sev === 'err' ? 'ERROR ' : 'WARN '), g.count > 1 ? h('b', {}, `${g.count}× `) : null, g.line.slice(0, 300)),
          g.src || g.retailSrc ? h('div', { class: 'sub' }, g.retailSrc ? `logged by the game's ${g.retailSrc}` : '', g.src ? [g.retailSrc ? ' · ' : '', 'matching code: ', h('code', {}, 'src/' + g.src)] : '') : null);
        if (g.names.length) {
          const finds = h('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '2px' } });
          for (const n of g.names) finds.append(h('button', { class: 'btn sm', title: 'Search the game data for this name', onclick: async () => {
            const r = await fetch('/api/grep?q=' + encodeURIComponent(n)); const j = r.ok ? await r.json() : { hits: [] };
            finds.querySelectorAll('.grephits').forEach(x => x.remove());
            finds.append(h('div', { class: 'grephits', style: { width: '100%', fontSize: '11px', fontFamily: 'var(--mono)' } }, j.hits.length ? j.hits.slice(0, 20).map(x => h('div', {}, `${x.path}:${x.line}  ${x.text}`)) : `“${n}” is not mentioned in any DATA ini file${j.truncated ? ' (search truncated)' : ''}.`));
          } }, `find “${n.length > 40 ? n.slice(0, 40) + '…' : n}”`));
          row.append(finds);
        }
        sec.append(row);
      }
      out.append(sec);
    }
    if (!crashes.length && !spew.length) out.append(h('div', { class: 'empty' }, 'No crash addresses or error/warning lines found.'));
  }
  function hint(f) {
    const n = (f.cname || f.gname || '').toLowerCase(), s = (f.src || '').toLowerCase();
    const tips = [
      [/archetype|archdb|loadout|equip/, 'Archetype / loadout / equipment code: check the nicknames used by the last thing that spawned or was loaded (loadouts, shiparch, solararch, equipment files).'],
      [/universe|system|zone|object|cobj/, 'Universe / system code: run Tools → Validate all systems; look for broken references in system INIs.'],
      [/alchemy|fx|effect|particle/, 'Effect code: check recently edited .ale files and effect nicknames (Particle effects editor).'],
      [/mission|trigger|content|msn/, 'Mission / content code: check the mission scripts (Tools → Mission scripts) and NPC ships.'],
      [/market|base|room|mbase|news|bar/, 'Base / market code: check market and mbases.ini changes (Review changes).'],
      [/model|mesh|vmesh|cmp|deform|hardpoint|utf/, 'Model code: a model or material changed recently? Check hardpoints / UTF edits with File → Review changes.'],
      [/sound|audio|voice/, 'Audio code: check sound/voice INIs and referenced audio files.'],
      [/thn|thorn|script/, 'Cutscene (Thorn) code: check .thn scripts referenced by missions or bases.'],
    ];
    const t = tips.find(([re]) => re.test(n) || re.test(s));
    return t ? h('div', { class: 'sev-info', style: { fontSize: '11px' } }, t[1]) : null;
  }
}
