// Quick 2D preview of a [star] from stararch.ini: glow + centre radial gradients (inner → outer colour),
// spines laid out exactly like FL (i·2π/n from angle 0, ray from the centre, transparent until the
// sun's edge, length/width × radius_scale) and lens-flare beads along the diagonal.
// Colours/sizes come from the data; the textures themselves are approximated with soft gradients.
import { h } from './dom.js';

const css = (c, a = 1) => `rgba(${c.map(x => Math.round(Math.max(0, Math.min(1, x)) * 255)).join(',')},${a})`;

export function starPreview(game, starNick, size = 220) {
  const cv = h('canvas', { width: size, height: size, style: { width: size + 'px', height: size + 'px', background: '#000', borderRadius: '6px', display: 'block' } });
  const st = starNick && game.stars.get(starNick.toLowerCase());
  const ctx = cv.getContext('2d'); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, size, size);
  if (!st) { ctx.fillStyle = '#666'; ctx.font = '12px sans-serif'; ctx.fillText('unknown star', 10, 20); return cv; }
  const S = st.section, cx = size * 0.42, cy = size * 0.45;
  const glow = S.get('star_glow') && game.starGlows.get(S.get('star_glow').toLowerCase());
  const center = S.get('star_center') && game.starGlows.get(S.get('star_center').toLowerCase());
  const spines = S.get('spines') && game.starSpines.get(S.get('spines').toLowerCase());
  const flare = S.get('lens_flare') && game.lensFlares.get(S.get('lens_flare').toLowerCase());
  // the sun's disk radius in preview pixels; glow/centre quads are radius × scale wide (as in 3D)
  const r = size * 0.07;
  ctx.globalCompositeOperation = 'lighter';
  const radial = (g, scale) => { const R = r * scale / 2 * 2; const gr = ctx.createRadialGradient(cx, cy, 0, cx, cy, R); gr.addColorStop(0, css(g.inner, 1)); gr.addColorStop(0.35, css(g.inner.map((v, i) => (v + g.outer[i]) / 2), 0.55)); gr.addColorStop(1, css(g.outer, 0)); ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill(); };
  if (glow) radial(glow, glow.scale);
  if (spines && [2, 4, 6, 12].includes(spines.items.length)) {
    const rr = Math.min(Math.max(r, spines.min), spines.max);
    spines.items.forEach((s, i) => {
      const a = i * 2 * Math.PI / spines.items.length, L = rr * s.length * spines.scale, hw = rr * s.width * spines.scale * 0.5;
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(-a);
      const gr = ctx.createLinearGradient(0, 0, L, 0);
      const f = Math.min(rr / Math.max(L, 1), 1);
      gr.addColorStop(0, css(s.inner, 0)); gr.addColorStop(f, css(s.inner, s.alpha)); gr.addColorStop(1, css(s.outer, 0));
      ctx.fillStyle = gr; ctx.beginPath(); ctx.moveTo(0, -hw); ctx.lineTo(L, -hw * 0.25); ctx.lineTo(L, hw * 0.25); ctx.lineTo(0, hw); ctx.closePath(); ctx.fill();
      ctx.restore();
    });
  }
  if (center) radial(center, center.scale);
  if (flare) {
    const rr = Math.min(Math.max(r, flare.min), flare.max), dx = size / 2 - cx + size * 0.12, dy = size / 2 - cy + size * 0.1;
    for (const b of flare.beads) { const x = cx + dx * 3 * b[0], y = cy + dy * 3 * b[0], hs = rr * b[1]; ctx.fillStyle = css([b[2], b[3], b[4]], Math.min(1, b[5] * 4)); ctx.beginPath(); ctx.arc(x, y, Math.max(hs, 1), 0, Math.PI * 2); ctx.fill(); }
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.font = '10px sans-serif';
  ctx.fillText(`${st.nickname} · r ${st.radius}`, 6, size - 6);
  return cv;
}
