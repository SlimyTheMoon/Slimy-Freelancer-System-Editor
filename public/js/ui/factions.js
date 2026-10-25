// Faction relations (Tools menu): the [Group] rep lines of initialworld.ini as a colour grid.
// Row = the faction that holds the opinion, column = the faction it is about (rep = value, other).
// Cells where A→B and B→A differ by more than a threshold are outlined; a missing pair (no line) is grey.
// Click a cell to edit; "both ways" writes the same value into the mirrored line. Shared undo + Ctrl+S.
import { h, modal, toast } from './dom.js';
import { dataPath } from '../api.js';

const lc = (s) => String(s || '').toLowerCase();
const colour = (v) => {
  if (v == null) return '#2a3140';
  const t = Math.max(-1, Math.min(1, v)), mix = (a, b, k) => a.map((x, i) => Math.round(x + (b[i] - x) * k));
  const grey = [128, 134, 146], c = t < 0 ? mix(grey, [205, 72, 72], -t) : mix(grey, [72, 190, 100], t);
  return `rgb(${c.join(',')})`;
};
const verdict = (v) => v == null ? 'no line (the game uses 0)' : v <= -0.6 ? 'hostile' : v >= 0.6 ? 'friendly' : 'neutral';

export async function factionRelations(app) {
  const g = app.game;
  const doc = await app.otherDoc(dataPath('initialworld.ini'));
  if (!doc) { toast('initialworld.ini not found'); return; }
  let both = true, filter = '', asymLimit = 0.3, sel = null;
  const grid = h('div', { style: { overflow: 'auto', height: 'calc(100vh - 300px)' } });
  const side = h('div', { style: { fontSize: '12px' } });
  const groups = () => doc.ini.all('Group').filter(s => s.get('nickname'));
  const repOf = (s) => { const m = new Map(); for (const e of s.findAll('rep')) { const [v, f] = e.values; if (f) m.set(lc(f), { v: parseFloat(v), e }); } return m; };
  const name = (s) => g.name(s.get('ids_short_name')) || g.name(s.get('ids_name')) || s.get('nickname');
  function setRep(from, to, v) {
    const e = repOf(from).get(lc(to.get('nickname')));
    const txt = `${+v.toFixed(2)}, ${to.get('nickname')}`;
    if (e) { e.e.value = txt; e.e.raw = null; } else from.add('rep', txt);
  }
  function render() {
    const gs = groups(), q = lc(filter);
    const rows = gs.filter(s => !q || lc(s.get('nickname') + ' ' + name(s)).includes(q));
    const reps = new Map(gs.map(s => [s, repOf(s)]));
    const tbl = h('table', { style: { borderCollapse: 'collapse', fontSize: '10px' } });
    tbl.append(h('tr', {}, h('th', { style: { position: 'sticky', left: 0, top: 0, background: 'var(--panel)', zIndex: 2 } }), ...gs.map(c => h('th', { title: `${c.get('nickname')} · ${name(c)}`, style: { position: 'sticky', top: 0, background: 'var(--panel)', writingMode: 'vertical-rl', transform: 'rotate(180deg)', padding: '2px 0', height: '120px', fontWeight: 400, color: 'var(--dim)', zIndex: 1 } }, name(c)))));
    let asym = 0, missing = 0;
    for (const r of rows) {
      const tr = h('tr', {}, h('th', { title: r.get('nickname'), style: { position: 'sticky', left: 0, background: 'var(--panel)', textAlign: 'right', paddingRight: '6px', fontWeight: 400, whiteSpace: 'nowrap', color: 'var(--dim)', zIndex: 1 } }, name(r)));
      for (const c of gs) {
        const a = reps.get(r).get(lc(c.get('nickname'))), b = reps.get(c).get(lc(r.get('nickname')));
        const v = a ? a.v : null, w = b ? b.v : null;
        const off = r !== c && v != null && w != null && Math.abs(v - w) > asymLimit;
        if (off) asym++; if (v == null && r !== c) missing++;
        const isSel = sel && sel[0] === r && sel[1] === c;
        tr.append(h('td', { title: `${name(r)} → ${name(c)}: ${v == null ? '—' : v} (${verdict(v)})${w != null ? ` · back: ${w}` : ''}`, onclick: () => { sel = [r, c]; render(); },
          style: { width: '16px', height: '16px', background: r === c ? '#111' : colour(v), outline: isSel ? '2px solid #fff' : off ? '2px solid #ffd34d' : '', outlineOffset: '-2px', cursor: 'pointer' } }));
      }
      tbl.append(tr);
    }
    grid.innerHTML = ''; grid.append(tbl);
    side.innerHTML = '';
    side.append(h('div', { style: { color: 'var(--faint)', marginBottom: '8px' } }, `${gs.length} factions · ${asym} one-sided pairs (difference > ${asymLimit}) outlined yellow · ${missing} missing lines`));
    if (sel) {
      const [r, c] = sel; const a = repOf(r).get(lc(c.get('nickname'))), b = repOf(c).get(lc(r.get('nickname')));
      const inp = h('input', { type: 'range', min: -1, max: 1, step: 0.01, value: a ? a.v : 0, style: { width: '100%' } });
      const num = h('input', { type: 'number', min: -1, max: 1, step: 0.05, value: a ? a.v : 0, style: { width: '80px' } });
      const apply = (v) => app.history.do(`Reputation ${r.get('nickname')} → ${c.get('nickname')}`, [doc], () => { setRep(r, c, v); if (both && r !== c) setRep(c, r, v); });
      inp.oninput = () => { num.value = inp.value; }; inp.onchange = () => apply(+inp.value); num.onchange = () => apply(+num.value);
      side.append(h('div', { class: 'psec' }, h('h3', {}, `${name(r)} → ${name(c)}`),
        h('div', {}, `${r.get('nickname')} thinks of ${c.get('nickname')}: `, h('b', {}, a ? String(a.v) : '—'), ` (${verdict(a ? a.v : null)})`),
        h('div', { style: { color: 'var(--dim)' } }, `${c.get('nickname')} thinks of ${r.get('nickname')}: `, h('b', {}, b ? String(b.v) : '—')),
        h('div', { class: 'btnrow', style: { alignItems: 'center', marginTop: '6px' } }, inp, num),
        h('div', { class: 'btnrow', style: { marginTop: '4px' } }, ...[-1, -0.65, 0, 0.65, 1].map(v => h('button', { class: 'btn sm', onclick: () => apply(v) }, String(v))),
          b && a && a.v !== b.v ? h('button', { class: 'btn sm', onclick: () => app.history.do('Mirror reputation', [doc], () => setRep(c, r, a.v)) }, 'Copy to the other side') : null)));
    }
    side.append(h('div', { style: { marginTop: '10px', color: 'var(--faint)' } }, 'Colours: red hostile (≤ −0.6), grey neutral, green friendly (≥ 0.6). Row = who holds the opinion.'));
  }
  const refresh = () => render();
  app.dialogRefreshers.add(refresh);
  modal({ title: 'Faction relations (initialworld.ini)', wide: true, onClose: () => app.dialogRefreshers.delete(refresh),
    body: h('div', {},
      h('div', { class: 'btnrow', style: { alignItems: 'center', marginBottom: '6px' } },
        h('input', { placeholder: 'Filter rows…', oninput: (e) => { filter = e.target.value; render(); } }),
        h('label', {}, h('input', { type: 'checkbox', checked: both, onchange: (e) => both = e.target.checked }), ' edit both ways'),
        'one-sided if difference >', h('input', { type: 'number', value: asymLimit, step: 0.05, style: { width: '64px' }, onchange: (e) => { asymLimit = +e.target.value || 0; render(); } })),
      h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 300px', gap: '10px' } }, grid, side)),
    buttons: [{ label: 'Close' }] }).box.classList.add('xwide');
  render();
}
