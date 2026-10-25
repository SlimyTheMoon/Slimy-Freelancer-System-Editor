// Infocard (RDL) renderer with Freelancer's look:
//   <TEXT> runs, <PARA/> line breaks, <JUST loc="left|center|right"/>, and
//   <TRA data=… mask=… def=… color=… font=… bold=… italic=… underline=…/> where
//   bit0 bold · bit1 italic · bit2 underline · bits3–7 font index (rich_fonts.ini) · bits 8–31 colour 0xBBGGRR.
// Fonts: DATA\FONTS\rich_fonts.ini [TrueType] font = index, family, size; the Agency FB TTFs shipped in
// DATA\FONTS are loaded into the page (Arial Unicode falls back to the system Arial).
import { h } from './dom.js';
import { api, dataPath } from '../api.js';
import { loadIni } from '../gamedata.js';

const NAMED = { fuchsia: 0xC2008800, gray: 0x80808000, blue: 0xE0484800, green: 0x13BF3B00, aqua: 0xE0C38700, red: 0x1D1DBF00, yellow: 0x52EAF500, white: 0xFFFFFF00 };
export const DEFAULT = { font: 0, bold: false, italic: false, underline: false, color: [160, 200, 230] };
const ALIGN = { l: 'left', left: 'left', c: 'center', center: 'center', r: 'right', right: 'right' }; // vanilla writes loc="l|c|r"
let fontsReady = null, richFonts = new Map();

export function loadGameFonts() {
  if (fontsReady) return fontsReady;
  fontsReady = (async () => {
    const d = await loadIni(dataPath('fonts\\rich_fonts.ini'));
    if (d) for (const s of d.all('TrueType')) for (const e of s.findAll('font')) { const v = e.values; richFonts.set(parseInt(v[0]), { family: v[1], size: parseFloat(v[2]) || 22 }); }
    for (const [file, weight] of [['AGENCYR.TTF', 'normal'], ['AGENCYB.TTF', 'bold']]) {
      try { const b = await api.read(dataPath('fonts\\' + file)); if (b) { const f = new FontFace('Agency FB', b.buffer, { weight }); await f.load(); document.fonts.add(f); } } catch { }
    }
  })();
  return fontsReady;
}
const num = (s) => { s = String(s).trim(); return s.startsWith('-') ? (parseInt(s) >>> 0) : s.toLowerCase().startsWith('0x') ? parseInt(s.slice(2), 16) >>> 0 : parseInt(s) >>> 0; };
function color(s) {
  const l = s.toLowerCase(); if (NAMED[l] != null) return NAMED[l];
  if (s.startsWith('#')) { const x = s.length === 4 ? s.slice(1).split('').map(c => c + c).join('') : s.slice(1); const r = parseInt(x.slice(0, 2), 16), g = parseInt(x.slice(2, 4), 16), b = parseInt(x.slice(4, 6), 16); return ((b << 24) | (g << 16) | (r << 8)) >>> 0; }
  return num(s);
}
const rgbOf = (c) => [(c >>> 8) & 0xFF, (c >>> 16) & 0xFF, (c >>> 24) & 0xFF];

// parse into paragraphs of styled runs
export function parseRdl(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) return null;
  const paras = [{ align: 'left', runs: [] }];
  let st = { ...DEFAULT };
  const tra = (el) => {
    let data = 0, mask = 0, def = 0; const A = (n) => el.getAttribute(n) ?? el.getAttribute(n.toLowerCase());
    if (A('DATA') != null) data = num(A('DATA')); if (A('MASK') != null) mask = num(A('MASK')); if (A('DEF') != null) def = num(A('DEF'));
    const flag = (attr, bit) => { const v = A(attr); if (v == null) return; mask |= bit; if (/^default$/i.test(v)) def |= bit; else if (/^true$/i.test(v)) data |= bit; else data &= ~bit; };
    if (A('COLOR') != null) { mask |= 0xFFFFFF00; if (/^default$/i.test(A('COLOR'))) def |= 0xFFFFFF00; else { data = (data & ~0xFFFFFF00) | color(A('COLOR')); } }
    if (A('FONT') != null) { mask |= 0xF8; if (/^default$/i.test(A('FONT'))) def |= 0xF8; else data = (data & ~0xF8) | (parseInt(A('FONT')) << 3); }
    flag('BOLD', 1); flag('ITALIC', 2); flag('UNDERLINE', 4);
    // the game changes only the properties in mask; within mask, def bits take the default instead of data
    // (verified in-game: data=0 mask=1 def=-1 turns bold off and leaves italic/colour as they were)
    const pick = (bit, v, d) => (mask & bit) ? ((def & bit) ? d : v) : undefined;
    const b = pick(1, !!(data & 1), DEFAULT.bold); if (b !== undefined) st.bold = b;
    const i = pick(2, !!(data & 2), DEFAULT.italic); if (i !== undefined) st.italic = i;
    const u = pick(4, !!(data & 4), DEFAULT.underline); if (u !== undefined) st.underline = u;
    const f = pick(0xF8, (data & 0xF8) >>> 3, DEFAULT.font); if (f !== undefined) st.font = f;
    if (mask & 0xFFFFFF00) st.color = (def & 0xFFFFFF00) ? DEFAULT.color : rgbOf(data);
  };
  const walk = (n) => {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) { if (c.textContent && c.parentNode.tagName && c.parentNode.tagName.toUpperCase() === 'TEXT') paras[paras.length - 1].runs.push({ text: c.textContent, ...st, color: [...st.color] }); continue; }
      if (c.nodeType !== 1) continue;
      const t = c.tagName.toUpperCase();
      if (t === 'PARA') paras.push({ align: paras[paras.length - 1].align, runs: [] });
      else if (t === 'JUST') { const loc = (c.getAttribute('loc') || c.getAttribute('LOC') || 'left').toLowerCase(); paras[paras.length - 1].align = ALIGN[loc] || ALIGN[loc[0]] || 'left'; }
      else if (t === 'TRA') tra(c);
      else walk(c);
    }
  };
  walk(doc.documentElement);
  return paras;
}

// render: a dark panel like the in-game infocard window
export function renderInfocard(xml, { maxHeight = '260px', scale = 0.62 } = {}) {
  const box = h('div', { class: 'flcard', style: { maxHeight } });
  if (!xml) return box;
  loadGameFonts();
  let paras = null; try { paras = parseRdl(xml); } catch { }
  if (!paras) { box.append(h('div', { class: 'sev-err' }, '⚠ Invalid XML — Freelancer shows it as plain text'), h('div', { style: { whiteSpace: 'pre-wrap', opacity: 0.7 } }, xml)); return box; }
  for (const p of paras) {
    const line = h('div', { style: { textAlign: p.align, minHeight: '0.9em' } });
    for (const r of p.runs) {
      const rf = richFonts.get(r.font) || { family: 'Arial Unicode MS', size: 22 };
      const fam = /agency/i.test(rf.family) ? "'Agency FB', 'Arial Narrow', sans-serif" : "'Arial Unicode MS', Arial, sans-serif";
      line.append(h('span', { style: { fontFamily: fam, fontSize: (rf.size * scale).toFixed(1) + 'px', fontWeight: r.bold ? 'bold' : 'normal', fontStyle: r.italic ? 'italic' : 'normal', textDecoration: r.underline ? 'underline' : 'none', color: `rgb(${r.color.join(',')})` } }, r.text));
    }
    box.append(line);
  }
  return box;
}

// ---------------------------------------------------------------- writing
// paragraphs of runs → RDL in the form the game's own infocards use: <RDL><PUSH/> … <POP/></RDL>,
// <JUST loc="l|c|r"/> where the alignment changes, <TRA …/> with only the attributes that change
// (bold/italic/underline="true|false", font="N|default", color="#RRGGBB|default"), <TEXT> runs, <PARA/> between
// paragraphs. Formatting state carries over paragraph breaks, as in the game.
const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sameColor = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
const hex = (c) => '#' + c.map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
// Discovery-style infocards use the numeric form <TRA data=… mask=… def=…/> and an XML declaration; an edited
// card keeps the dialect it came in. Numeric TRA: mask = the attributes that change (the game ignores the rest),
// data = their values, def = attributes at their default afterwards (bold on → data=1 mask=1 def=-2, as Discovery writes).
// The infocard style a whole mod uses, by majority over its cards (vanilla: attribute TRA, no XML header;
// Discovery: numeric data/mask/def TRA with an <?xml?> header). New cards are written in this style so they
// match their neighbours. Each detail is voted on only by cards where it shows.
export function modDialect(xmls) {
  const v = { num: 0, attr: 0, hdr: 0, noHdr: 0, headers: new Map(), longJ: 0, shortJ: 0, traF: 0, justF: 0, full: 0, part: 0, cards: 0 };
  for (const x0 of xmls) {
    const x = String(x0 || ''); if (!/<RDL/i.test(x)) continue;
    v.cards++;
    const h = /^\s*(<\?xml[^>]*\?>)/i.exec(x); if (h) { v.hdr++; v.headers.set(h[1], (v.headers.get(h[1]) || 0) + 1); } else v.noHdr++;
    const numT = /<TRA\b[^>]*\bdata\s*=/i.test(x), attrT = /<TRA\b[^>]*\b(bold|italic|underline|color|font)\s*=/i.test(x);
    if (numT && !attrT) v.num++; else if (attrT) v.attr++;
    if (/<JUST\s+loc="(left|center|right)"/i.test(x)) v.longJ++; else if (/<JUST\s+loc="[lcr]"/i.test(x)) v.shortJ++;
    const tf = (x.match(/<TRA\b[^>]*\/>\s*<JUST\b/gi) || []).length, jf = (x.match(/<JUST\b[^>]*\/>\s*<TRA\b/gi) || []).length;
    if (tf > jf) v.traF++; else if (jf > tf) v.justF++;
    if (numT) { const f = (x.match(/\bmask="-1"/gi) || []).length, p = (x.match(/\bmask="(?!-1")[^"]*"/gi) || []).length; if (f > p) v.full++; else if (p > f) v.part++; }
  }
  const header = v.hdr > v.noHdr ? [...v.headers].sort((a, b) => b[1] - a[1])[0][0] : '';
  return { numeric: v.num > v.attr, header, longJust: v.longJ > v.shortJ, traFirst: v.traF > v.justF, fullMask: v.full > v.part, votes: v };
}
const VANILLA_STYLE = (d) => !d || (!d.numeric && !d.header && !d.longJust && !d.traFirst && !d.fullMask);
// plain text (one line = one paragraph) → RDL in the given style; vanilla style keeps the editor's classic output
export function textToRdlStyled(text, dialect, plain) {
  if (VANILLA_STYLE(dialect)) return plain(text);
  // the game's own cards end with <PARA/> (a final empty paragraph), so the text gets one too
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n'); if (lines[lines.length - 1] !== '') lines.push('');
  const paras = lines.map(l => ({ align: 'left', runs: l ? [{ ...DEFAULT, color: [...DEFAULT.color], text: l }] : [] }));
  return writeRdl(normalizeParas(paras), dialect);
}

export function rdlDialect(xml) {
  const x = String(xml || '');
  const count = (re) => (x.match(re) || []).length;
  return {
    numeric: /<TRA\b[^>]*\bdata\s*=/i.test(x) && !/<TRA\b[^>]*\b(bold|italic|underline|color|font)\s*=/i.test(x),
    header: /^\s*<\?xml/i.test(x) ? x.match(/^\s*(<\?xml[^>]*\?>)/i)[1] : '',
    longJust: /<JUST\s+loc="(left|center|right)"/i.test(x),               // loc="center" instead of "c"
    traFirst: count(/<TRA\b[^>]*\/>\s*<JUST\b/gi) > count(/<JUST\b[^>]*\/>\s*<TRA\b/gi), // <TRA/><JUST/> order
    fullMask: count(/\bmask="-1"/gi) > count(/\bmask="(?!-1")[^"]*"/gi),        // data=0x… mask="-1" (every attribute explicit)
  };
}
const tok = (n) => { n = n >>> 0; if (n === 0xFFFFFFFF) return '-1'; return n > 255 ? '0x' + n.toString(16).toUpperCase().padStart(8, '0') : String(n); };
const sdec = (n) => String(n | 0);
// One numeric TRA for the change prev → next. mask = the properties that change (the game leaves everything
// else alone), data = their new values, def = every property that is at its default afterwards — the way
// Discovery writes it (bold on: data=1 mask=1 def=-2, bold off: data=0 mask=1 def=-1).
const fmtBits = (st) => { let d = 0, nd = 0; if (st.bold) { d |= 1; nd |= 1; } if (st.italic) { d |= 2; nd |= 2; } if (st.underline) { d |= 4; nd |= 4; } if (st.font) { d |= (st.font & 31) << 3; nd |= 0xF8; } if (!sameColor(st.color, DEFAULT.color)) { const [r, g, b] = st.color; d |= ((b << 24) | (g << 16) | (r << 8)) >>> 0; nd |= 0xFFFFFF00; } return { data: d >>> 0, nonDef: nd >>> 0 }; };
function numericTra(prev, next, fullMask) {
  const { data, nonDef } = fmtBits(next);
  if (fullMask) { // every attribute explicit, as some Discovery ship/equipment cards do
    if (!nonDef) return '<TRA data="0x00000000" mask="-1" def="-1"/>';
    return `<TRA data="${'0x' + data.toString(16).toUpperCase().padStart(8, '0')}" mask="-1"${(~nonDef >>> 0) && !(nonDef & 0xFFFFFF00) ? ` def="${sdec((~nonDef) >>> 0)}"` : ''}/>`;
  }
  let mask = 0;
  if (!!prev.bold !== !!next.bold) mask |= 1; if (!!prev.italic !== !!next.italic) mask |= 2; if (!!prev.underline !== !!next.underline) mask |= 4;
  if ((prev.font || 0) !== (next.font || 0)) mask |= 0xF8; if (!sameColor(prev.color, next.color)) mask |= 0xFFFFFF00;
  mask >>>= 0; const def = (~nonDef) >>> 0;
  return `<TRA data="${tok(data & mask)}" mask="${tok(mask)}"${def ? ` def="${sdec(def)}"` : ''}/>`;
}
export function writeRdl(paras, { numeric = false, header = '', longJust = false, traFirst = false, fullMask = false } = {}) {
  let out = header + '<RDL><PUSH/>', st = { ...DEFAULT, color: [...DEFAULT.color] }, align = 'left';
  // the tag that changes the current style st into next (empty when nothing changes)
  const tra = (next) => {
    const ch = [];
    for (const k of ['bold', 'italic', 'underline']) if (!!next[k] !== !!st[k]) ch.push(`${k}="${next[k] ? 'true' : 'false'}"`);
    if ((next.font || 0) !== (st.font || 0)) ch.push(`font="${next.font ? next.font : 'default'}"`);
    if (!sameColor(next.color, st.color)) ch.push(`color="${sameColor(next.color, DEFAULT.color) ? 'default' : hex(next.color)}"`);
    if (!ch.length) return '';
    const t = numeric ? numericTra(st, next, fullMask) : `<TRA ${ch.join(' ')}/>`;
    st = next; return t;
  };
  paras.forEach((p, i) => {
    if (i) {
      // the game draws a line break with the current underline ("_" at the start of the next line), so
      // underline is switched off before every <PARA/>
      if (st.underline) out += tra({ ...st, color: [...st.color], underline: false });
      out += '<PARA/>';
    }
    const a = p.align || 'left';
    let just = '';
    if (a !== align) { just = `<JUST loc="${longJust ? a : a[0]}"/>`; align = a; }
    if (just && !traFirst) { out += just; just = ''; }
    for (const r of p.runs) {
      if (!r.text) continue;
      out += tra({ font: r.font || 0, bold: !!r.bold, italic: !!r.italic, underline: !!r.underline, color: [...(r.color || DEFAULT.color)] });
      if (just) { out += just; just = ''; } // Discovery order: <TRA/><JUST/><TEXT>
      out += `<TEXT>${esc(r.text)}</TEXT>`;
    }
    if (just) out += just;
  });
  return out + '<POP/></RDL>';
}
// merge neighbouring runs with the same style; drop empty ones
export function normalizeParas(paras) {
  return paras.map(p => {
    const runs = [];
    for (const r of p.runs) { if (!r.text) continue; const l = runs[runs.length - 1]; if (l && l.bold === r.bold && l.italic === r.italic && l.underline === r.underline && (l.font || 0) === (r.font || 0) && sameColor(l.color, r.color)) l.text += r.text; else runs.push({ ...r, color: [...r.color] }); }
    return { align: p.align || 'left', runs };
  });
}
export function richFontList() { return [...richFonts].sort((a, b) => a[0] - b[0]).map(([i, f]) => ({ index: i, ...f })); }
export function fontCss(index, scale = 0.62) {
  const rf = richFonts.get(index) || { family: 'Arial Unicode MS', size: 22 };
  return { fontFamily: /agency/i.test(rf.family) ? "'Agency FB', 'Arial Narrow', sans-serif" : "'Arial Unicode MS', Arial, sans-serif", fontSize: (rf.size * scale).toFixed(1) + 'px' };
}
export const GAME_COLOURS = [['default', null], ['white', [255, 255, 255]], ['red', [255, 0, 0]], ['yellow', [245, 234, 82]], ['green', [59, 191, 19]], ['aqua', [135, 195, 224]], ['gray', [128, 128, 128]], ['fuchsia', [136, 0, 194]]];
