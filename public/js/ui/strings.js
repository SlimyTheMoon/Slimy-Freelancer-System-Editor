// Strings & infocards: single-entry editor and full browser (resource DLL editing).
import { renderInfocard, textToRdlStyled } from './rdl.js';
import { infocardEditor } from './rdledit.js';
import { h, modal, toast, confirmDialog } from './dom.js';
import { textToRdl, rdlToText, isPlainRdl, validXml } from '../formats/dll.js';

const ID_KIND = (key) => /ids_info/i.test(key || '') ? 'infocard' : 'string';
export { ID_KIND };

function dllSelect(app, kind, current) {
  const g = app.game;
  const remembered = app.settings['dll_' + kind];
  const def = (current && current.editable) ? current : g.editableDlls().find(d => d.name === remembered) || g.defaultDll(kind);
  return h('select', {}, g.editableDlls().map(d => h('option', { value: d.index, selected: d === def }, `${d.name}  (#${d.index}, ${kind === 'infocard' ? d.infocards.size + ' infocards' : d.strings.size + ' strings'})`)));
}

// preview with the game's fonts/colours (ui/rdl.js)
function previewRdl(xml) { return renderInfocard(xml, { maxHeight: '260px' }); }

// Edit an existing id, or create a new one (id == null). Resolves with the (new) global id or null.
export function textEditor(app, { id = null, kind = 'string', title, initial = '' } = {}) {
  return new Promise((resolve) => {
    const g = app.game;
    const existing = id ? g.dllFor(id) : null;
    const local = id ? (parseInt(id) & 0xFFFF) : null;
    if (id && !existing) { toast(`id ${id} belongs to DLL #${parseInt(id) >>> 16}, which is not loaded`); resolve(null); return; }
    if (existing && !existing.editable) {
      modal({ title: 'Read-only DLL', body: h('div', {}, `${existing.name} cannot be edited: ${existing.readOnlyReason}.`, h('br'), h('br'), 'Use "New…" to create a new string in an editable DLL instead.'), buttons: [{ label: 'OK' }] });
      resolve(null); return;
    }
    let curStr = existing ? (kind === 'string' ? existing.strings.get(local) : existing.infocards.get(local)) : null;
    const style = kind === 'infocard' && app.infocardStyle ? app.infocardStyle() : null; // new cards match the mod's own style
    if (curStr == null) curStr = kind === 'infocard' ? (initial ? textToRdlStyled(initial, style, textToRdl) : '') : initial;
    const dllSel = existing ? null : dllSelect(app, kind, null);
    // infocards: the visual editor (Visual / Plain text / XML); strings: a text box
    const card = kind === 'infocard' ? infocardEditor({ xml: curStr || '', dialect: style }) : null;
    const ta = card ? null : h('textarea', { class: 'raw', spellcheck: 'true', style: { height: '90px', whiteSpace: 'pre-wrap', fontFamily: 'var(--ui)' } });
    if (ta) ta.value = curStr || '';
    const xmlNow = () => card ? card.xml : ta.value;
    const head = h('div', { class: 'stat', style: { marginBottom: '10px' } },
      'Type', h('b', {}, kind === 'infocard' ? 'Infocard (XML, RT_HTML)' : 'String (RT_STRING)'),
      'Id', h('b', {}, id ? `${id}  (${existing.name} #${existing.index}, local ${local})` : 'new — assigned on save'));
    modal({
      title: title || (id ? `Edit ${kind} ${id}` : `New ${kind}`), wide: kind === 'infocard',
      body: h('div', {}, head, dllSel ? h('div', { class: 'form', style: { marginBottom: '10px' } }, h('label', {}, 'Store in'), dllSel) : null,
        card ? card.el : ta),
      onClose: () => resolve(null),
      guard: () => xmlNow() !== (curStr || ''),
      buttons: [{ label: 'Cancel' }, {
        label: id ? 'Apply' : 'Create', cls: 'primary', onClick: async () => {
          const value = xmlNow();
          if (id && value === (curStr || '')) { resolve(id); return; } // unchanged: don't mark the DLL as modified
          if (kind === 'infocard' && value && !validXml(value)) { if (!(await confirmDialog('Malformed infocard', 'The XML is not well-formed; Freelancer will show it as plain text. Save anyway?', 'Save anyway'))) return false; }
          try {
            let gid = id;
            if (id) app.setText(kind, id, value);
            else {
              const d = g.dllDocs[parseInt(dllSel.value)];
              app.settings['dll_' + kind] = d.name; try { localStorage.setItem('fled.settings', JSON.stringify(app.settings)); } catch { }
              gid = app.newText(kind, value, d);
            }
            resolve(gid);
          } catch (e) { toast(e.message, 5000); return false; }
        },
      }],
    });
    setTimeout(() => (card || ta).focus(), 50);
  });
}

// Browser over every string and infocard in all resource DLLs
export function stringBrowser(app, { pick = null, kind: forceKind = null } = {}) {
  const g = app.game;
  const q = h('input', { placeholder: 'Search text or id…', style: { flex: 1 } });
  const kindSel = h('select', {}, [['all', 'Strings + infocards'], ['string', 'Strings'], ['infocard', 'Infocards']].map(([v, l]) => h('option', { value: v, selected: v === (forceKind || 'all') }, l)));
  const dllSel = h('select', {}, h('option', { value: '' }, 'All DLLs'), g.dllDocs.filter(Boolean).map(d => h('option', { value: d.index }, `${d.name}${d.editable ? '' : ' (read-only)'}`)));
  const list = h('div', { class: 'tree', style: { height: '58vh', border: '1px solid var(--line)', borderRadius: '6px' } });
  const count = h('span', { style: { color: 'var(--faint)', fontSize: '12px' } });
  const run = () => {
    list.innerHTML = '';
    const s = q.value.trim().toLowerCase(); const k = kindSel.value; const di = dllSel.value === '' ? null : parseInt(dllSel.value);
    let n = 0; const rows = [];
    const asNum = /^\d+$/.test(s) ? parseInt(s) : null;
    for (const d of g.dllDocs) {
      if (!d || (di != null && d.index !== di)) continue;
      const sources = [];
      if (k !== 'infocard') sources.push(['string', d.strings]);
      if (k !== 'string') sources.push(['infocard', d.infocards]);
      for (const [kind, map] of sources) for (const [local, v] of map) {
        if (!v) continue;
        const gid = d.globalId(local);
        const text = kind === 'infocard' ? rdlToText(v) : v;
        if (s && !(asNum != null ? String(gid).startsWith(s) || gid === asNum : text.toLowerCase().includes(s))) continue;
        n++; if (rows.length < 600) rows.push({ gid, kind, text, d });
      }
    }
    rows.sort((a, b) => a.gid - b.gid);
    for (const r of rows) list.append(h('div', { class: 'row', title: r.text, onclick: async () => {
      if (pick) { pick(r.gid, r.kind); m.close(); return; }
      const res = await textEditor(app, { id: r.gid, kind: r.kind }); if (res) run();
    } }, h('span', { style: { fontFamily: 'var(--mono)', fontSize: '11px', color: 'var(--accent)', width: '64px', flex: '0 0 64px' } }, r.gid),
      h('span', { style: { fontSize: '10px', color: 'var(--faint)', width: '52px', flex: '0 0 52px' } }, r.kind === 'infocard' ? 'infocard' : 'string'),
      h('span', { class: 'nm' }, r.text.replace(/\n/g, ' ⏎ ').slice(0, 200)), h('span', { class: 'sub' }, r.d.name)));
    count.textContent = `${n} match${n === 1 ? '' : 'es'}${n > rows.length ? ` (showing ${rows.length})` : ''}`;
    if (!n) list.append(h('div', { class: 'empty' }, 'No matches'));
  };
  q.oninput = () => { clearTimeout(q._t); q._t = setTimeout(run, 150); }; kindSel.onchange = run; dllSel.onchange = run;
  const newBtn = (kind) => h('button', { class: 'btn', onclick: async () => { const gid = await textEditor(app, { kind }); if (gid) { q.value = String(gid); run(); if (pick) { pick(gid, kind); m.close(); } } } }, kind === 'string' ? '+ New string' : '+ New infocard');
  const m = modal({
    title: pick ? 'Pick a string / infocard' : 'Strings & infocards (resource DLLs)', wide: true,
    body: h('div', {},
      h('div', { class: 'btnrow', style: { marginBottom: '8px', alignItems: 'center' } }, q, kindSel, dllSel),
      list,
      h('div', { class: 'btnrow', style: { marginTop: '8px', alignItems: 'center' } }, newBtn('string'), newBtn('infocard'), h('span', { class: 'spacer' }), count),
      h('div', { style: { color: 'var(--faint)', fontSize: '12px', marginTop: '6px' } }, `Editable: ${g.editableDlls().map(d => d.name).join(', ') || 'none'}. Changes are saved with Ctrl+S (originals backed up). Close Freelancer before saving — Windows locks DLLs in use.`)),
    buttons: [{ label: 'Close' }],
    onClose: () => app.dialogRefreshers.delete(refresh),
  });
  const refresh = (e) => { if (e.docs.some(d => d instanceof Object && d.strings && d.infocards)) run(); };
  app.dialogRefreshers.add(refresh);
  run();
}
