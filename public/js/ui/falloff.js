// Light falloff: D3D attenuation (1 / (a + b·d + c·d²)) or an atten_curve from igraph.ini, plotted over the
// light's range. Freelancer lights do not light anything beyond `range`.
// An atten_curve is drawn from the curve's own points
// (x normalised to 0…range).
import { h } from './dom.js';
import { fmtNum } from '../formats/ini.js';
import { dataPath } from '../api.js';
import { loadIni } from '../gamedata.js';

let graphs = null;
export async function igraphs() {
  if (graphs) return graphs;
  graphs = new Map();
  const d = await loadIni(dataPath('igraph.ini'));
  if (d) for (const s of d.all('IGraph')) {
    const n = s.get('nickname'); if (!n) continue;
    const pts = s.findAll('point').map(e => e.values.map(parseFloat)).filter(p => !p.some(isNaN)).sort((a, b) => a[0] - b[0]);
    graphs.set(n.toLowerCase(), { nickname: n, type: s.get('type'), points: pts });
  }
  return graphs;
}

function curveAt(pts, t) { // t in 0..1 over the curve's x span
  if (!pts.length) return 1;
  if (pts.length === 1) return pts[0][1];
  const x0 = pts[0][0], x1 = pts[pts.length - 1][0], x = x0 + t * (x1 - x0);
  for (let i = 1; i < pts.length; i++) if (x <= pts[i][0]) { const [ax, ay] = pts[i - 1], [bx, by] = pts[i]; return ay + (by - ay) * ((x - ax) / ((bx - ax) || 1)); }
  return pts[pts.length - 1][1];
}

export function falloffSection(app, sec, edit) {
  const wrap = h('div', { class: 'psec' }, h('h3', {}, 'Falloff'));
  const range = parseFloat(sec.get('range') || '0') || 0;
  const att = (sec.vals('attenuation') || ['1', '0', '0']).map(v => parseFloat(v) || 0);
  const curveName = sec.get('atten_curve');
  const mode = curveName ? 'curve' : 'd3d';
  const cv = h('canvas', { width: 320, height: 130, style: { width: '100%', maxWidth: '320px', background: 'rgba(0,0,0,0.25)', borderRadius: '4px' } });
  const draw = (G) => {
    const ctx = cv.getContext('2d'), W = cv.width, H = cv.height, pad = 18;
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.font = '10px sans-serif';
    for (let i = 0; i <= 4; i++) { const x = pad + (W - pad * 2) * i / 4; ctx.beginPath(); ctx.moveTo(x, 4); ctx.lineTo(x, H - pad); ctx.stroke(); ctx.fillText(range ? `${fmtNum(range * i / 4 / 1000, 1)}k` : '', x - 8, H - 4); }
    for (const v of [0, 0.5, 1]) { const y = (H - pad) - v / 1.2 * (H - pad - 4); ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(W - pad, y); ctx.stroke(); ctx.fillText(String(v), 2, y + 3); }
    if (!range) { ctx.fillText('set a range to preview', W / 2 - 50, H / 2); return; }
    const plot = (fn, color) => {
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
      for (let i = 0; i <= 200; i++) { const t = i / 200, v = Math.max(0, Math.min(1.2, fn(t))); const x = pad + (W - pad * 2) * t, y = (H - pad) - v / 1.2 * (H - pad - 4); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
      ctx.stroke(); ctx.lineWidth = 1;
    };
    if (mode === 'd3d') plot((t) => { const d = t * range; return 1 / ((att[0] || 1e-7) + att[1] * d + att[2] * d * d); }, '#ffd866');
    else { const g = G && G.get((curveName || '').toLowerCase()); if (g) plot((t) => curveAt(g.points, t), '#7ee787'); else ctx.fillText(`unknown curve ${curveName}`, 40, H / 2); }
  };
  igraphs().then(draw);
  const at = (d) => 1 / ((att[0] || 1e-7) + att[1] * d + att[2] * d * d);
  const modeSel = h('select', { onchange: (e) => edit('Light falloff mode', () => { if (e.target.value === 'curve') { sec.remove('attenuation'); sec.set('atten_curve', 'DYNAMIC_DIRECTION'); } else { sec.remove('atten_curve'); sec.set('attenuation', '1, 0, ' + fmtNum(9 / Math.max(range, 1) ** 2, 10)); } }) },
    h('option', { value: 'd3d', selected: mode === 'd3d' }, 'attenuation (1 / (a + b·d + c·d²))'), h('option', { value: 'curve', selected: mode === 'curve' }, 'atten_curve (igraph.ini)'));
  wrap.append(h('div', { class: 'kv' }, h('div', { class: 'k' }, 'mode'), h('div', { class: 'v' }, modeSel), h('span')));
  if (mode === 'd3d') {
    const inp = (i) => h('input', { type: 'number', value: att[i], step: 'any', style: { width: '100%' }, onchange: (e) => edit('Light attenuation', () => { const v = att.slice(); v[i] = parseFloat(e.target.value) || 0; sec.set('attenuation', v.map(x => fmtNum(x, 10)).join(', ')); }) });
    wrap.append(h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '4px', margin: '4px 0' } }, h('span', { class: 'k' }, 'a (constant)'), h('span', { class: 'k' }, 'b (linear)'), h('span', { class: 'k' }, 'c (quadratic)'), inp(0), inp(1), inp(2)));
    const presets = [['50 %', 0.5], ['25 %', 0.25], ['10 %', 0.1], ['1 %', 0.01]];
    wrap.append(h('div', { class: 'btnrow', style: { marginBottom: '4px', alignItems: 'center' } }, h('span', { style: { fontSize: '11px', color: 'var(--faint)' } }, 'brightness at range:'),
      presets.map(([l, f]) => h('button', { class: 'btn sm', title: `c = (1/${f} − 1) / range²`, disabled: !range, onclick: () => edit('Light attenuation preset', () => sec.set('attenuation', `1, 0, ${fmtNum((1 / f - 1) / (range * range), 12)}`)) }, l))));
    if (range) wrap.append(h('div', { style: { fontSize: '11px', color: 'var(--dim)' } }, `at ¼ range ${fmtNum(at(range / 4) * 100, 1)} % · at ½ ${fmtNum(at(range / 2) * 100, 1)} % · at range ${fmtNum(at(range) * 100, 2)} %, then cut off`));
  } else {
    const sel = h('select', { onchange: (e) => edit('Light atten_curve', () => sec.set('atten_curve', e.target.value)) });
    igraphs().then(G => { for (const g of G.values()) sel.append(h('option', { value: g.nickname, selected: g.nickname.toLowerCase() === (curveName || '').toLowerCase() }, `${g.nickname} (${g.points.length} pts)`)); });
    wrap.append(h('div', { class: 'kv' }, h('div', { class: 'k' }, 'atten_curve'), h('div', { class: 'v' }, sel), h('span')));
  }
  wrap.append(cv);
  return wrap;
}
