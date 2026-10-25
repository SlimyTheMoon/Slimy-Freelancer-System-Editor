// Visual infocard editor: type and format directly on a panel that looks like the in-game infocard window.
// Covers everything the game's own infocards use (bold, italic, underline, font from rich_fonts.ini, colour,
// left/centre/right alignment, paragraphs). Modes: Visual · Plain text (one line = one paragraph) · XML.
// The original XML is returned unchanged until something is actually edited; edits are written in the
// game's own RDL style (writeRdl in rdl.js — content-identical round trip on all 5,258 vanilla infocards).
import { h, toast, confirmDialog, modal } from './dom.js';
import { parseRdl, writeRdl, rdlDialect, textToRdlStyled, normalizeParas, renderInfocard, loadGameFonts, richFontList, fontCss, DEFAULT, GAME_COLOURS } from './rdl.js';
import { textToRdl, rdlToText, validXml } from '../formats/dll.js';

const SCALE = 0.62;
const sameColor = (a, b) => !!a && !!b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
const TEMPLATES = {
  station: ['Station', [{ align: 'left', runs: [{ text: 'CLASS: ', bold: true }, { text: 'Trading Outpost' }] }, { runs: [{ text: 'GRAVITY: ', bold: true }, { text: 'Complete' }] }, { runs: [{ text: 'DOCKING: ', bold: true }, { text: 'Yes' }] }, { runs: [{ text: 'AMENITIES: ', bold: true }, { text: 'Yes' }] }, { runs: [{ text: 'POPULATION: ', bold: true }, { text: '1,200' }] }, { runs: [] }, { runs: [{ text: 'Describe the station here.' }] }, { runs: [] }]],
  planet: ['Planet', [{ runs: [{ text: 'CLASS: ', bold: true }, { text: 'Terraformed' }] }, { runs: [{ text: 'GRAVITY: ', bold: true }, { text: 'Complete' }] }, { runs: [{ text: 'DOCKING: ', bold: true }, { text: 'Yes' }] }, { runs: [{ text: 'POPULATION: ', bold: true }, { text: '200 Million' }] }, { runs: [] }, { runs: [{ text: 'Describe the planet here.' }] }, { runs: [] }]],
  commodity: ['Commodity / equipment', [{ align: 'center', runs: [{ text: 'NAME', bold: true }] }, { align: 'left', runs: [] }, { runs: [{ text: 'Describe the item here.' }] }, { runs: [] }]],
  warning: ['Warning line', [{ align: 'center', runs: [{ text: '>>> ', bold: true }, { text: 'RESTRICTED', bold: true, color: [255, 0, 0] }, { text: ' <<<', bold: true }] }, { align: 'left', runs: [] }]],
};
// The two infocard notations the game reads. Vanilla names each format change; Discovery (and the tools it is
// built with) packs them into numbers and starts every card with an XML header. Freelancer shows both the same.
export const NOTATIONS = {
  vanilla: { numeric: false, header: '', longJust: false, traFirst: false, fullMask: false },
  discovery: { numeric: true, header: '<?xml version="1.0" encoding="UTF-16"?>', longJust: true, traFirst: true, fullMask: false },
};
const NOTE_KEY = 'fled.rdlNotation';
const loadNote = () => { try { const v = localStorage.getItem(NOTE_KEY); return NOTATIONS[v] ? v : 'auto'; } catch { return 'auto'; } };
const saveNote = (v) => { try { localStorage.setItem(NOTE_KEY, v); } catch { } };
const noteName = (d) => d && (d.numeric || d.header) ? 'Discovery' : 'Vanilla';
// Detailed explanation of the two notations, shown in its own dialog (ⓘ button, closes with × / Close / Esc).
// Examples are produced by the editor's own writer, so they show exactly what gets saved.
function notationInfo() {
  const red = [255, 0, 0];
  const run = (text, o = {}) => ({ text, bold: false, italic: false, underline: false, font: 0, color: [...DEFAULT.color], ...o });
  const ex = (paras) => [writeRdl(paras, NOTATIONS.vanilla), writeRdl(paras, NOTATIONS.discovery)];
  const strip = (x) => x.replace(/^<\?xml[^?]*\?>/, '').replace(/^<RDL><PUSH\/>/, '').replace(/<POP\/><\/RDL>$/, '');
  const pair = (label, paras, note) => { const [v, d] = ex(paras); return h('tr', {}, h('td', {}, label, note ? h('div', { class: 'np-note' }, note) : null), h('td', {}, h('code', {}, strip(v))), h('td', {}, h('code', {}, strip(d)))); };
  const sec = (t, ...c) => h('section', {}, h('h3', {}, t), ...c);
  const P = (...c) => h('p', {}, ...c), C = (t) => h('code', {}, t), B = (t) => h('b', {}, t);
  const rows = (head, list, codeCols = [1, 2]) => h('table', { class: 'grid np-table' }, h('tr', {}, ...head.map(x => h('th', {}, x))), ...list.map(r => h('tr', {}, ...r.map((c, k) => h('td', {}, codeCols.includes(k) && /[<#=]|^0x/.test(c) ? h('code', {}, c) : c)))));
  const [cardV, cardD] = ex([{ align: 'center', runs: [run('PLANET MANHATTAN', { bold: true })] }, { align: 'left', runs: [run('Class: '), run('Terraformed', { color: [...red] })] }, { align: 'left', runs: [] }]);
  return h('div', { class: 'notation-info' },
    sec('In short',
      P('Freelancer keeps every infocard (the formatted text you see for bases, planets, ships, equipment …) as a small piece of XML called ', B('RDL'), ', stored inside the resource DLLs. The same formatting can be written in two ways:'),
      h('ul', {},
        h('li', {}, B('Vanilla notation'), ' – used by the original game. Each change is spelled out by name: ', C('bold="true"'), ', ', C('color="#FF0000"'), '.'),
        h('li', {}, B('Discovery notation'), ' – used throughout Discovery Freelancer (all of its ~19,000 cards). Every change is packed into three numbers (', C('data'), ', ', C('mask'), ', ', C('def'), ') and each card starts with an XML declaration.')),
      P(B('The game reads both and shows them exactly the same.'), ' The choice only affects how the text is stored in the file, not what players see.')),
    sec('Side by side',
      rows(['', 'Vanilla', 'Discovery'], [
        ['Start of the card', '<RDL><PUSH/>…', '<?xml version="1.0" encoding="UTF-16"?><RDL><PUSH/>…'],
        ['How formatting is written', 'named attributes: bold, italic, underline, font, color', 'three numbers: data, mask, def'],
        ['Alignment', '<JUST loc="c"/>   (l / c / r)', '<JUST loc="center"/>   (left / center / right)'],
        ['Order when both change', '<JUST/> first, then <TRA/>', '<TRA/> first, then <JUST/>'],
        ['Colour', '#RRGGBB   (red, green, blue)', '0xBBGGRR00 inside data   (blue, green, red – reversed)'],
        ['Readable by hand', 'easy', 'needs the bit table below']])),
    sec('How Discovery’s numbers work',
      P('A Discovery formatting tag looks like ', C('<TRA data="1" mask="1" def="-2"/>'), '. Each number is a 32-bit field in which every bit stands for one property:'),
      rows(['Bits', 'Value', 'Property'], [
        ['0', '1', 'bold'], ['1', '2', 'italic'], ['2', '4', 'underline'],
        ['3 – 7', '8 … 248', 'font number × 8 (fonts from rich_fonts.ini; 0 = default font)'],
        ['8 – 31', '0xBBGGRR00', 'text colour, stored blue-green-red']], [1]),
      h('ul', {},
        h('li', {}, C('data'), ' – the new values. ', C('data="1"'), ' means bold on, ', C('data="3"'), ' bold + italic.'),
        h('li', {}, C('mask'), ' – which properties this tag changes. ', C('mask="1"'), ' means "only bold"; properties outside the mask keep their current value.'),
        h('li', {}, C('def'), ' – among the properties in the mask, which ones go back to their default instead of taking the value from data. It has no effect outside the mask. Discovery sets it to every property that is at its default after the tag (', C('-1'), ' = all bits, ', C('-2'), ' = all except bold, ', C('-3'), ' = all except italic, ', C('255'), ' = bits 0–7), so the tag also documents the full style; the game only uses the part inside the mask.')),
      P('So ', C('<TRA data="1" mask="1" def="-2"/>'), ' reads "bold on, leave everything else as it is" – the same as vanilla\u2019s ', C('<TRA bold="true"/>'), '. To switch italic off you need the italic bit in the mask (', C('<TRA data="0" mask="2" def="-1"/>'), '); a tag with ', C('mask="1"'), ' would only touch bold.')),
    sec('Examples – exactly what the editor writes',
      h('table', { class: 'grid np-table' },
        h('tr', {}, h('th', {}, 'Formatting'), h('th', {}, 'Vanilla'), h('th', {}, 'Discovery')),
        pair('Bold word', [{ align: 'left', runs: [run('Bold', { bold: true }), run(' normal')] }]),
        pair('Italic word', [{ align: 'left', runs: [run('Italic', { italic: true }), run(' normal')] }]),
        pair('Underlined word', [{ align: 'left', runs: [run('Under', { underline: true }), run(' normal')] }]),
        pair('Red word', [{ align: 'left', runs: [run('Red', { color: [...red] }), run(' normal')] }], 'FF0000 is stored as 0x0000FF00 (reversed, shifted)'),
        pair('Bold + red', [{ align: 'left', runs: [run('Alert', { bold: true, color: [...red] }), run(' normal')] }]),
        pair('Font 2', [{ align: 'left', runs: [run('Title', { font: 2 }), run(' normal')] }], '2 × 8 = 16'),
        pair('Centred line', [{ align: 'center', runs: [run('Centred')] }, { align: 'left', runs: [run('Left')] }]))),
    sec('A whole card',
      P('The same small card (bold centred title, then a line with a red word) in both notations:'),
      h('div', { class: 'np-cards' },
        h('div', {}, h('div', { class: 'np-cap' }, 'Vanilla'), h('pre', {}, cardV.replace(/></g, '>\n<'))),
        h('div', {}, h('div', { class: 'np-cap' }, 'Discovery'), h('pre', {}, cardD.replace(/></g, '>\n<'))))),
    sec('What the Notation list does',
      h('ul', {},
        h('li', {}, B('Auto'), ' (recommended) – an existing card keeps the notation it already has, so an edit changes only what you edited. A new card uses the notation most of the loaded mod’s cards use: vanilla on vanilla, Discovery on Discovery. The label shows what was detected.'),
        h('li', {}, B('Vanilla'), ' / ', B('Discovery'), ' – the card is written in that notation. Choosing one converts the whole card when you apply; text and formatting stay identical. The choice is remembered for the next cards you edit until you switch back to Auto. The line above the card always says which notation will be saved.'))),
    sec('When to pick one yourself',
      h('ul', {},
        h('li', {}, 'You copy cards from one mod to another and want them to match their new neighbours.'),
        h('li', {}, 'You send changes to a mod team: using their notation keeps file comparisons small and readable.'),
        h('li', {}, 'You edit cards by hand in XML mode and prefer the readable vanilla form while you work.'))),
    sec('Good to know',
      h('ul', {},
        h('li', {}, 'Underline is switched off before every line break: the game draws an underlined line break as a "_" at the start of the next line.'),
        h('li', {}, 'Converting rewrites the whole card, so a file comparison shows the whole card as changed even though it looks the same in-game.'),
        h('li', {}, 'Mixing notations is fine: the game accepts both, even side by side in the same DLL.'),
        h('li', {}, 'The declaration says UTF-16 because the DLLs store infocards as UTF-16 text. The editor saves them that way in both notations.'),
        h('li', {}, 'Visual and Plain-text modes look and work the same in both notations (Plain text drops formatting in both). Only XML mode shows the notation itself.'))));
}
function showNotationInfo() { modal({ title: 'Infocard notation: Vanilla vs Discovery', body: notationInfo(), wide: true, buttons: [{ label: 'Close', cls: 'primary' }] }); }
const full = (r) => ({ text: r.text || '', bold: !!r.bold, italic: !!r.italic, underline: !!r.underline, font: r.font || 0, color: r.color ? [...r.color] : [...DEFAULT.color] });

export function infocardEditor({ xml = '', height = '34vh', onChange = () => { }, dialect: modStyle = null } = {}) {
  loadGameFonts();
  let original = xml || '', touched = false, mode = 'visual', pending = null;
  const ed = h('div', { class: 'flcard fl-edit', contenteditable: 'true', spellcheck: 'true', style: { height, maxHeight: 'none', overflow: 'auto', outline: 'none', cursor: 'text', padding: '10px 12px', whiteSpace: 'pre-wrap' } }); // pre-wrap: spaces stay real spaces (no &nbsp; tricks that move the caret out of styled text)
  const ta = h('textarea', { class: 'raw', spellcheck: 'true', style: { height, display: 'none', whiteSpace: 'pre-wrap', fontFamily: 'var(--mono)' } });
  const prev = h('div', { style: { display: 'none', marginTop: '6px' } });
  const status = h('span', { style: { fontSize: '11px', color: 'var(--faint)' } });
  const tb = h('div', { class: 'btnrow', style: { flexWrap: 'wrap', alignItems: 'center', gap: '4px', marginBottom: '6px' } });
  const modes = h('div', { class: 'btnrow', style: { marginBottom: '6px', alignItems: 'center' } });
  const el = h('div', {}, modes, tb, ed, ta, prev);

  // ---------------------------------------------------------------- DOM ⇄ paragraphs
  function styleSpan(sp, st) {
    sp.className = 'r';
    sp.dataset.b = st.bold ? '1' : ''; sp.dataset.i = st.italic ? '1' : ''; sp.dataset.u = st.underline ? '1' : '';
    sp.dataset.font = String(st.font || 0); sp.dataset.color = st.color.join(',');
    const f = fontCss(st.font || 0, SCALE);
    Object.assign(sp.style, { fontFamily: f.fontFamily, fontSize: f.fontSize, fontWeight: st.bold ? 'bold' : 'normal', fontStyle: st.italic ? 'italic' : 'normal', textDecoration: st.underline ? 'underline' : 'none', color: `rgb(${st.color.join(',')})` });
  }
  function render(paras) {
    ed.innerHTML = '';
    for (const p of paras) {
      const d = h('div', { style: { textAlign: p.align || 'left', minHeight: '0.9em' } }); d.dataset.align = p.align || 'left';
      for (const r of p.runs) { if (!r.text) continue; const sp = document.createElement('span'); styleSpan(sp, full(r)); sp.textContent = r.text; d.append(sp); }
      if (!d.childNodes.length) d.append(document.createElement('br'));
      ed.append(d);
    }
    if (!ed.childNodes.length) ed.append(h('div', { style: { minHeight: '0.9em' } }, h('br')));
  }
  // style of a text node: the nearest span.r, then <b>/<i>/<u>/<font> or inline styles a browser may have added
  function styleOf(node) {
    const st = { bold: null, italic: null, underline: null, font: null, color: null };
    for (let e = node.parentElement; e && e !== ed; e = e.parentElement) {
      const t = e.tagName;
      if (e.classList.contains('r')) {
        if (st.bold == null) st.bold = !!e.dataset.b; if (st.italic == null) st.italic = !!e.dataset.i; if (st.underline == null) st.underline = !!e.dataset.u;
        if (st.font == null) st.font = parseInt(e.dataset.font || '0') || 0; if (st.color == null && e.dataset.color) st.color = e.dataset.color.split(',').map(Number);
      }
      if (st.bold == null && (t === 'B' || t === 'STRONG' || /bold|[6-9]00/.test(e.style.fontWeight))) st.bold = true;
      if (st.italic == null && (t === 'I' || t === 'EM' || e.style.fontStyle === 'italic')) st.italic = true;
      if (st.underline == null && (t === 'U' || /underline/.test(e.style.textDecoration))) st.underline = true;
      if (st.color == null && t === 'FONT' && e.getAttribute('color')) { const c = e.getAttribute('color').replace('#', ''); st.color = [0, 2, 4].map(i => parseInt(c.slice(i, i + 2), 16)); }
    }
    return { bold: !!st.bold, italic: !!st.italic, underline: !!st.underline, font: st.font || 0, color: st.color || [...DEFAULT.color] };
  }
  function readDom() {
    const paras = [];
    const blocks = [...ed.childNodes];
    let cur = null;
    const newPara = (align) => { cur = { align: align || 'left', runs: [] }; paras.push(cur); };
    const walk = (n, align) => {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) { if (c.textContent) cur.runs.push({ text: c.textContent.replace(/​/g, '').replace(/\u00a0/g, ' '), ...styleOf(c) }); }
        else if (c.nodeType === 1) {
          if (c.tagName === 'BR') { if (c.nextSibling || cur.runs.length) newPara(align); continue; }
          if (c.tagName === 'DIV' || c.tagName === 'P') { if (cur.runs.length) newPara(c.dataset.align || c.style.textAlign || align); else cur.align = c.dataset.align || c.style.textAlign || align; walk(c, cur.align); continue; }
          walk(c, align);
        }
      }
    };
    for (const b of blocks) {
      if (b.nodeType === 1 && (b.tagName === 'DIV' || b.tagName === 'P')) { const a = b.dataset.align || b.style.textAlign || 'left'; newPara(a); walk(b, a); }
      else { if (!cur) newPara('left'); walk({ childNodes: [b] }, cur.align); }
    }
    return normalizeParas(paras.map(p => ({ align: ['center', 'right'].includes(p.align) ? p.align : 'left', runs: p.runs })));
  }
  // keep the card's own style (vanilla attributes or Discovery's numeric TRA + XML header); an empty/new card takes the mod's style
  const autoDialect = /<RDL/i.test(xml || '') ? rdlDialect(xml) : (modStyle || rdlDialect(''));
  let notation = loadNote();
  let dialect = notation === 'auto' ? autoDialect : NOTATIONS[notation];
  const xmlFromVisual = () => writeRdl(readDom(), dialect);

  // ---------------------------------------------------------------- undo / redo
  // The browser's own undo does not know about formatting, alignment or templates (they change the DOM
  // directly) and gets confused by them, so the editor keeps its own snapshots: markup + caret position.
  const undoStack = [], redoStack = []; let typingAt = 0;
  function caretOffset() {
    const sel = getSelection(); if (!sel.rangeCount || !inEd(sel.anchorNode)) return null;
    const r = sel.getRangeAt(0), pre = document.createRange(); pre.selectNodeContents(ed); pre.setEnd(r.startContainer, r.startOffset);
    return pre.toString().length;
  }
  function setCaret(off) {
    const sel = getSelection(), it = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT); let n, left = off == null ? Infinity : off, last = null;
    for (n = it.nextNode(); n; n = it.nextNode()) { last = n; if (left <= n.length) break; left -= n.length; }
    const r = document.createRange();
    if (n) r.setStart(n, left); else if (last) r.setStart(last, last.length); else r.setStart(ed.firstChild || ed, 0);
    r.collapse(true); sel.removeAllRanges(); sel.addRange(r);
  }
  const snap = () => ({ html: ed.innerHTML, caret: caretOffset() });
  function remember(typing = false) { // call BEFORE a change
    const now = performance.now();
    if (typing && now - typingAt < 800 && undoStack.length) { typingAt = now; return; } // one undo step per word
    typingAt = typing ? now : 0;
    const sn = snap(); if (undoStack.length && undoStack[undoStack.length - 1].html === sn.html) return;
    undoStack.push(sn); if (undoStack.length > 200) undoStack.shift(); redoStack.length = 0;
  }
  function restore(from, to) {
    if (!from.length) return; to.push(snap()); const sn = from.pop();
    ed.innerHTML = sn.html; ed.focus(); setCaret(sn.caret); typingAt = 0; pending = null; changed(); updateToolbar();
  }
  const undo = () => restore(undoStack, redoStack), redo = () => restore(redoStack, undoStack);
  ed.addEventListener('beforeinput', (e) => {
    if (e.inputType === 'historyUndo') { e.preventDefault(); undo(); return; }
    if (e.inputType === 'historyRedo') { e.preventDefault(); redo(); return; }
    if (e.inputType === 'insertText' && e.data === ' ') typingAt = 0; // a space starts a new undo step
    remember(e.inputType === 'insertText' || e.inputType === 'deleteContentBackward' || e.inputType === 'deleteContentForward');
  }, true);

  // ---------------------------------------------------------------- selection formatting
  const inEd = (n) => n && (n === ed || ed.contains(n));
  function textNodesIn(range) {
    const out = [], it = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT);
    for (let n = it.nextNode(); n; n = it.nextNode()) if (n.textContent && range.intersectsNode(n)) out.push(n);
    return out;
  }
  // every text node of a paragraph in its own span.r carrying its full style (text nodes are moved, not copied)
  function flatten(block) {
    const texts = []; const it = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    for (let n = it.nextNode(); n; n = it.nextNode()) texts.push([n, styleOf(n)]);
    if (!texts.length) return;
    block.innerHTML = '';
    for (const [t, st] of texts) { const sp = document.createElement('span'); styleSpan(sp, st); sp.append(t); block.append(sp); }
  }
  const blockOf = (n) => { while (n && n.parentNode !== ed) n = n.parentNode; return n; };
  function format(patchFn) {
    const sel = getSelection(); if (!sel.rangeCount) return;
    const r = sel.getRangeAt(0); if (!inEd(r.commonAncestorContainer)) return;
    if (r.collapsed) { pending = patchFn(pending || styleOf(r.startContainer.nodeType === 3 ? r.startContainer : (r.startContainer.childNodes[r.startOffset - 1] || r.startContainer))); updateToolbar(); return; }
    // split the text nodes at the selection edges
    let { startContainer: sc, startOffset: so, endContainer: ec, endOffset: eo } = r;
    if (ec.nodeType === 3 && eo < ec.length && eo > 0) ec.splitText(eo);
    if (sc.nodeType === 3 && so > 0 && so < sc.length) { const after = sc.splitText(so); if (ec === sc) ec = after; sc = after; so = 0; }
    const rr = document.createRange(); rr.setStart(sc, so); rr.setEnd(ec, ec.nodeType === 3 ? Math.min(eo, ec.length) : eo);
    const nodes = textNodesIn(rr).filter(n => !(n === sc && so >= n.length));
    if (!nodes.length) return;
    const styles = nodes.map(styleOf), patch = patchFn(null, styles);
    remember();
    for (const b of new Set(nodes.map(blockOf))) if (b) flatten(b);
    nodes.forEach((n, i) => styleSpan(n.parentElement, { ...styles[i], ...patch }));
    const nr = document.createRange(); nr.setStart(nodes[0], 0); nr.setEnd(nodes[nodes.length - 1], nodes[nodes.length - 1].length);
    sel.removeAllRanges(); sel.addRange(nr);
    changed();
  }
  const toggle = (k) => format((cur, list) => list ? { [k]: !list.every(s => s[k]) } : { ...cur, [k]: !cur[k] });
  const setFont = (f) => format((cur, list) => list ? { font: f } : { ...cur, font: f });
  const setColor = (c) => format((cur, list) => list ? { color: [...c] } : { ...cur, color: [...c] });
  const clearFmt = () => format((cur, list) => list ? { bold: false, italic: false, underline: false, font: 0, color: [...DEFAULT.color] } : { ...DEFAULT, color: [...DEFAULT.color] });
  function align(a) {
    const sel = getSelection(); if (!sel.rangeCount) return; const r = sel.getRangeAt(0); if (!inEd(r.commonAncestorContainer)) return;
    const blocks = [...ed.childNodes].filter(b => b.nodeType === 1 && (r.intersectsNode(b) || b.contains(r.startContainer)));
    if (blocks.length) remember();
    for (const b of blocks) { b.style.textAlign = a; b.dataset.align = a; }
    changed(); updateToolbar();
  }
  // typing after choosing a style with nothing selected: insert the text in a span of that style
  ed.addEventListener('beforeinput', (e) => {
    if (!pending || e.inputType !== 'insertText' || !e.data) return;
    e.preventDefault();
    const sel = getSelection(), r = sel.getRangeAt(0); r.deleteContents();
    const sp = document.createElement('span'); styleSpan(sp, pending); sp.textContent = e.data;
    let at = r.startContainer;
    if (at.nodeType === 3) { const after = at.splitText(r.startOffset); after.parentNode.insertBefore(sp, after); }
    else if (at === ed) { const d = h('div'); d.append(sp); ed.insertBefore(d, ed.childNodes[r.startOffset] || null); }
    else { const br = at.querySelector && at.childNodes.length === 1 && at.firstChild.tagName === 'BR' ? at.firstChild : null; if (br) br.remove(); at.insertBefore(sp, at.childNodes[r.startOffset] || null); }
    const nr = document.createRange(); nr.setStart(sp.firstChild, sp.firstChild.length); nr.collapse(true); sel.removeAllRanges(); sel.addRange(nr);
    pending = null; changed();
  });
  ed.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return; const k = e.key.toLowerCase();
    if (k === 'b' || k === 'i' || k === 'u') { e.preventDefault(); e.stopPropagation(); toggle({ b: 'bold', i: 'italic', u: 'underline' }[k]); }
    else if (k === 'z' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); undo(); }
    else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); e.stopPropagation(); redo(); }
  });
  ed.addEventListener('paste', (e) => {
    e.preventDefault();
    const t = (e.clipboardData.getData('text/plain') || '').replace(/\r\n?/g, '\n');
    remember();
    document.execCommand('insertText', false, t);
  });
  ed.addEventListener('input', () => changed());
  document.addEventListener('selectionchange', () => { if (mode === 'visual' && inEd(getSelection().anchorNode)) { pending = null; updateToolbar(); } });
  try { document.execCommand('defaultParagraphSeparator', false, 'div'); } catch { }

  // ---------------------------------------------------------------- toolbar
  const btn = (label, title, fn, extra = {}) => h('button', { class: 'btn sm', title, onmousedown: (e) => e.preventDefault(), onclick: fn, ...extra }, label);
  const bB = btn(h('b', {}, 'B'), 'Bold (Ctrl+B)', () => toggle('bold')), bI = btn(h('i', {}, 'I'), 'Italic (Ctrl+I)', () => toggle('italic')), bU = btn(h('u', {}, 'U'), 'Underline (Ctrl+U)', () => toggle('underline'));
  const aL = btn('⯇', 'Align left', () => align('left')), aC = btn('≡', 'Centre', () => align('center')), aR = btn('⯈', 'Align right', () => align('right'));
  const fontSel = h('select', { title: 'Font (DATA\\FONTS\\rich_fonts.ini)', style: { maxWidth: '170px' }, onchange: () => { setFont(parseInt(fontSel.value) || 0); ed.focus(); } });
  const fillFonts = () => { const list = richFontList(); fontSel.innerHTML = ''; fontSel.append(...(list.length ? list : [{ index: 0, family: 'Arial Unicode MS', size: 22 }]).map(f => h('option', { value: f.index }, `${f.index}${f.index === 0 ? ' (default)' : ''} · ${f.family} ${f.size}`))); };
  loadGameFonts().then(() => { fillFonts(); if (mode === 'visual' && !touched) render(safeParse(original) || [{ runs: [] }]); });
  fillFonts();
  const swatches = GAME_COLOURS.map(([n, c]) => h('button', { class: 'btn sm', title: n === 'default' ? 'Default text colour' : n, onmousedown: (e) => e.preventDefault(), onclick: () => setColor(c || DEFAULT.color), style: { width: '20px', height: '20px', padding: 0, background: `rgb(${(c || DEFAULT.color).join(',')})`, border: n === 'default' ? '2px solid #fff' : '1px solid #0008' } }));
  const custom = h('input', { type: 'color', title: 'Any colour', style: { width: '28px', height: '22px', padding: 0, border: 0, background: 'none' }, onchange: () => { setColor([1, 3, 5].map(i => parseInt(custom.value.slice(i, i + 2), 16))); } });
  // (no window.confirm: VS Code webviews block it and it silently answers "no")
  const tplSel = h('select', { title: 'Replace the card with a template (Ctrl+Z undoes it)', onchange: async () => {
    const t = TEMPLATES[tplSel.value]; tplSel.value = ''; if (!t) return;
    const has = readDom().some(p => p.runs.some(r => r.text.trim()));
    if (has && !(await confirmDialog('Use template', `Replace the current text with the “${t[0]}” template? Ctrl+Z brings the text back.`, 'Replace'))) return;
    applyTemplate(t);
  } },
    h('option', { value: '' }, 'Template…'), Object.entries(TEMPLATES).map(([k, [l]]) => h('option', { value: k }, l)));
  function applyTemplate(t) {
    remember(); render(t[1].map(p => ({ align: p.align || 'left', runs: p.runs.map(full) })));
    ed.focus(); setCaret(null); pending = null; changed(); updateToolbar();
  }
  const widthBtn = btn('↔ game width', 'Narrow the editor to about the width of the in-game infocard panel to see where lines wrap', () => { const n = ed.style.maxWidth !== '440px'; ed.style.maxWidth = n ? '440px' : ''; ed.style.margin = n ? '0 auto' : ''; widthBtn.classList.toggle('primary', n); });
  const noteSel = h('select', { title: 'Which infocard notation to write. Click ⓘ for the difference', onchange: () => setNotation(noteSel.value) },
    h('option', { value: 'auto' }, `Notation: Auto (${noteName(autoDialect)})`), h('option', { value: 'vanilla' }, 'Notation: Vanilla'), h('option', { value: 'discovery' }, 'Notation: Discovery'));
  noteSel.value = notation;
  const info = h('button', { class: 'btn sm infobtn', type: 'button', title: 'What is the difference between the notations?', onmousedown: (e) => e.preventDefault(), onclick: showNotationInfo }, 'ⓘ');
  function setNotation(v) {
    notation = v; saveNote(v);
    const before = current();
    dialect = v === 'auto' ? autoDialect : NOTATIONS[v];
    const differs = noteName(dialect) !== noteName(/<RDL/i.test(before) ? rdlDialect(before) : autoDialect);
    if (mode === 'xml') { const p = safeParse(ta.value); if (p && differs) { ta.value = writeRdl(p, dialect); changed(); } }
    else if (differs && before) changed();
    if (differs) toast(`This card will be written in ${noteName(dialect)} notation`);
  }
  tb.append(widthBtn, h('span', { style: { width: '6px' } }), bB, bI, bU, h('span', { style: { width: '6px' } }), aL, aC, aR, h('span', { style: { width: '6px' } }), fontSel, ...swatches, custom, btn('⌫ format', 'Remove formatting from the selection', clearFmt), tplSel, noteSel, info, h('span', { style: { flex: 1 } }), status);
  function updateToolbar() {
    if (mode !== 'visual') return;
    const sel = getSelection(); let st = pending;
    if (!st && sel.rangeCount && inEd(sel.anchorNode)) { const n = sel.anchorNode.nodeType === 3 ? sel.anchorNode : (sel.anchorNode.childNodes[Math.max(0, sel.anchorOffset - 1)] || sel.anchorNode); st = styleOf(n.nodeType === 3 ? n : (n.firstChild && n.firstChild.nodeType === 3 ? n.firstChild : n)); }
    st = st || DEFAULT;
    bB.classList.toggle('primary', !!st.bold); bI.classList.toggle('primary', !!st.italic); bU.classList.toggle('primary', !!st.underline);
    fontSel.value = String(st.font || 0);
    const b = sel.rangeCount && blockOf(sel.anchorNode); const a = b && b.nodeType === 1 ? (b.dataset.align || b.style.textAlign || 'left') : 'left';
    aL.classList.toggle('primary', a === 'left'); aC.classList.toggle('primary', a === 'center'); aR.classList.toggle('primary', a === 'right');
  }

  // ---------------------------------------------------------------- modes
  const safeParse = (x) => { if (!x) return [{ align: 'left', runs: [] }]; try { const p = parseRdl(x); return p ? normalizeParas(p) : null; } catch { return null; } };
  function current() { // XML right now
    if (mode === 'visual') return touched ? xmlFromVisual() : original;
    if (mode === 'text') return touched ? textToRdlStyled(ta.value, dialect, textToRdl) : original;
    return ta.value;
  }
  function changed() { touched = true; status.textContent = statusText(); if (mode !== 'visual') { prev.innerHTML = ''; prev.append(renderInfocard(current(), { maxHeight: '200px' })); } onChange(current()); }
  const statusText = () => { const p = mode === 'visual' ? readDom() : null; const chars = p ? p.reduce((s, x) => s + x.runs.reduce((a, r) => a + r.text.length, 0), 0) : ta.value.length; return `${chars} characters${touched ? ' · edited' : ''} · ${noteName(dialect)} notation`; };
  async function setMode(m) {
    if (m === mode) return;
    const x = current();
    if (m === 'text') { const p = safeParse(x); if (p && p.some(q => q.runs.some(r => r.bold || r.italic || r.underline || r.font || !sameColor(r.color, DEFAULT.color)) || q.align !== 'left') && !(await confirmDialog('Plain text', 'Plain text drops the formatting (bold, colours, fonts, alignment). Continue?', 'Continue'))) return; }
    if (m === 'visual') { const p = safeParse(x); if (!p) { toast('This XML is not well-formed — fix it in XML mode first'); return; } render(p); undoStack.length = redoStack.length = 0; }
    if (m === 'text') ta.value = rdlToText(x);
    if (m === 'xml') ta.value = x;
    if (touched || m !== mode) { original = x; touched = false; }
    mode = m;
    ed.style.display = m === 'visual' ? '' : 'none'; tb.style.display = m === 'visual' ? '' : 'none'; ta.style.display = m === 'visual' ? 'none' : ''; prev.style.display = m === 'visual' ? 'none' : '';
    ta.style.fontFamily = m === 'xml' ? 'var(--mono)' : 'var(--ui)';
    if (m !== 'visual') { prev.innerHTML = ''; prev.append(h('div', { style: { fontSize: '11px', color: 'var(--faint)', margin: '6px 0 4px' } }, 'PREVIEW'), renderInfocard(x, { maxHeight: '200px' })); }
    renderModes(); status.textContent = statusText();
  }
  ta.addEventListener('input', () => changed());
  function renderModes() {
    modes.innerHTML = '';
    for (const [k, l, t] of [['visual', 'Visual', 'Format directly, as it looks in the game'], ['text', 'Plain text', 'One line = one paragraph, no formatting'], ['xml', 'XML', 'The RDL markup itself']]) modes.append(h('button', { class: 'btn sm' + (mode === k ? ' primary' : ''), title: t, onclick: () => setMode(k) }, l));
    modes.append(h('span', { style: { fontSize: '11px', color: 'var(--faint)', marginLeft: '8px' } }, mode === 'visual' ? 'Select text and use the buttons; Ctrl+B / I / U work too. Nothing is rewritten until you change something.' : mode === 'text' ? 'Each line becomes a paragraph.' : 'Freelancer shows malformed XML as plain text.'));
  }
  // start
  const p0 = safeParse(original);
  if (p0) render(p0); else { mode = 'xml'; ta.value = original; ed.style.display = 'none'; tb.style.display = 'none'; ta.style.display = ''; }
  renderModes(); status.textContent = statusText();
  return {
    el, get xml() { return current(); }, get touched() { return touched; }, get mode() { return mode; }, setMode,
    focus() { (mode === 'visual' ? ed : ta).focus(); }, valid() { return validXml(current()); },
    // for tests
    _format: { toggle, setFont, setColor, align, clearFmt, undo, redo, applyTemplate: (k) => applyTemplate(TEMPLATES[k]) }, _ed: ed, _read: readDom, _tpl: tplSel, _note: noteSel, _info: info,
  };
}
