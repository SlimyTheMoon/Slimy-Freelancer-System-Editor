// Hash tool: CreateID, faction hash, model (DACOM) CRC, ALE CRC.
import { h, modal, toast } from './dom.js';
import { createID, facHash, dacomCrc, aleCrc } from '../formats/crc.js';

export function hashTool(app) {
  const inp = h('input', { placeholder: 'nickname, e.g. li_fighter or Li01_01_Base', style: { width: '100%' } });
  const out = h('table', { class: 'grid', style: { marginTop: '10px' } });
  const rows = [
    ['CreateID', 'archetype / equipment / base / system ids (saves, mission scripts)', createID],
    ['Faction hash (MakeId)', 'faction / group ids', facHash],
    ['Model CRC (DACOM)', 'VMeshLibId, material and texture ids in .cmp/.3db/.mat', dacomCrc],
    ['ALE CRC', 'effect / node ids in .ale files (case-sensitive)', aleCrc],
  ];
  const copy = (t) => { if (navigator.clipboard) navigator.clipboard.writeText(t).then(() => toast('Copied ' + t)); };
  const update = () => {
    out.innerHTML = '';
    const v = inp.value;
    out.append(h('thead', {}, h('tr', {}, h('th', {}, 'Hash'), h('th', { class: 'r' }, 'Unsigned'), h('th', { class: 'r' }, 'Signed'), h('th', { class: 'r' }, 'Hex'))),
      h('tbody', {}, rows.map(([n, d, fn]) => {
        const u = v ? fn(v) >>> 0 : 0, s32 = u | 0, hx = '0x' + u.toString(16).toUpperCase().padStart(8, '0');
        return h('tr', { title: d }, h('td', {}, n, h('span', { class: 'sub' }, d)), ...[String(u), String(s32), hx].map(t => h('td', { class: 'r', style: { cursor: 'copy' }, onclick: () => v && copy(t) }, v ? t : '—')));
      })));
  };
  inp.oninput = update; update();
  modal({ title: 'Hash tool', wide: true, body: h('div', {}, inp, out, h('div', { style: { marginTop: '6px', fontSize: '11px', color: 'var(--faint)' } }, 'Click a value to copy it.')), buttons: [{ label: 'Close' }] });
}
