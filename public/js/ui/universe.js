// Universe map: systems from universe.ini, links from every system's goto entries.
import { h, contextMenu, toast } from './dom.js';
import * as dialogs from './dialogs.js';
import { fmtNum } from '../formats/ini.js';

const PREFIX_COLORS = { li: '#5aa8ff', br: '#ff7a6b', ku: '#ffb44d', rh: '#6fd88f', iw: '#c9b37a', bw: '#b48cff', ew: '#9aa6b8', hi: '#7fd6d6', st: '#ff6ec7', fp: '#cccccc' };

export class UniverseMap {
  constructor(el, app) {
    this.el = el; this.app = app;
    this.canvas = el.querySelector('canvas'); this.ctx = this.canvas.getContext('2d');
    this.hud = el.querySelector('#unihud');
    this.view = { x: 0, y: 0, s: 40 };
    this.links = []; this.loaded = false; this.selected = null;
    new ResizeObserver(() => this.draw()).observe(el);
    let drag = null;
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      const hit = this.hit(e);
      drag = { x: e.clientX, y: e.clientY, vx: this.view.x, vy: this.view.y, sys: hit && e.button === 0 ? hit : null, moved: false, start: hit ? hit.pos.slice() : null };
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      const hov = this.hit(e); c.style.cursor = hov ? 'pointer' : 'default';
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.hypot(dx, dy) > 3) drag.moved = true;
      if (drag.sys && drag.moved) { drag.sys.pos = [drag.start[0] + dx / this.view.s, drag.start[1] + dy / this.view.s]; this.draw(); }
      else if (!drag.sys && drag.moved) { this.view.x = drag.vx - dx / this.view.s; this.view.y = drag.vy - dy / this.view.s; this.draw(); }
    });
    c.addEventListener('pointerup', (e) => {
      if (!drag) return;
      const d = drag; drag = null;
      if (d.sys && d.moved) {
        const s = d.sys, np = s.pos.map(v => Math.round(v * 10) / 10); s.pos = d.start;
        this.app.history.do('Move system on map', [this.app.universeDoc], () => s.section.set('pos', `${fmtNum(np[0], 1)}, ${fmtNum(np[1], 1)}`));
      } else if (!d.moved && e.button === 0) { this.selected = this.hit(e); this.draw(); this.app.props && this.app.props.render(); } // properties panel follows the selection
    });
    c.addEventListener('dblclick', (e) => { const s = this.hit(e); if (s) app.openSystem(s.nickname); });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const before = this.toWorld(e); this.view.s = Math.min(400, Math.max(8, this.view.s * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      const after = this.toWorld(e); this.view.x += before[0] - after[0]; this.view.y += before[1] - after[1]; this.draw();
    }, { passive: false });
    c.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const s = this.hit(e), w = this.toWorld(e);
      contextMenu(e.clientX, e.clientY, [
        s ? { label: `Open ${s.nickname}`, action: () => app.openSystem(s.nickname) } : null,
        s ? { label: `Edit universe entry…`, action: () => dialogs.editUniverseSection(app, s.section) } : null,
        { label: 'New system here…', action: () => dialogs.newSystem(app, w) },
        { label: 'Reload links', action: () => { this.loaded = false; this.show(); } },
      ]);
    });
  }
  async show() {
    if (!this.fitted) { this.fit(); this.fitted = true; }
    this.draw();
    if (!this.loaded) {
      this.loaded = true;
      this.hud.textContent = 'Loading system files for jump links…';
      await this.app.loadAllSystemDocs((i, n) => { this.hud.textContent = `Loading systems ${i}/${n}…`; });
      this.draw();
    }
  }
  computeLinks() {
    const links = [], g = this.app.game;
    for (const d of this.app.systemDocs.values()) for (const o of d.objects) {
      const go = o.vals('goto'); if (!go || !go[0]) continue;
      const a = g.arch(o.get('archetype'));
      links.push({ from: d.nickname.toLowerCase(), to: go[0].toLowerCase(), hole: !!(a && a.type === 'JUMP_HOLE') });
    }
    return links;
  }
  fit() {
    const ss = this.app.game.systems; if (!ss.length) return;
    const xs = ss.map(s => s.pos[0]), ys = ss.map(s => s.pos[1]);
    const w = this.el.clientWidth || 800, hh = this.el.clientHeight || 600;
    const minx = Math.min(...xs), maxx = Math.max(...xs), miny = Math.min(...ys), maxy = Math.max(...ys);
    this.view.s = Math.min(w / (maxx - minx + 3), hh / (maxy - miny + 3));
    this.view.x = (minx + maxx) / 2 - w / 2 / this.view.s; this.view.y = (miny + maxy) / 2 - hh / 2 / this.view.s;
  }
  toScreen(p) { return [(p[0] - this.view.x) * this.view.s, (p[1] - this.view.y) * this.view.s]; }
  toWorld(e) { const r = this.canvas.getBoundingClientRect(); return [(e.clientX - r.left) / this.view.s + this.view.x, (e.clientY - r.top) / this.view.s + this.view.y]; }
  hit(e) {
    const r = this.canvas.getBoundingClientRect(); const mx = e.clientX - r.left, my = e.clientY - r.top;
    let best = null, bd = 14;
    for (const s of this.app.game.systems) { const [x, y] = this.toScreen(s.pos); const d = Math.hypot(x - mx, y - my); if (d < bd) { bd = d; best = s; } }
    return best;
  }
  draw() {
    const c = this.canvas, ctx = this.ctx, dpr = window.devicePixelRatio || 1;
    const w = this.el.clientWidth, hh = this.el.clientHeight; if (!w || !hh || this.el.classList.contains('hidden')) return;
    if (c.width !== w * dpr || c.height !== hh * dpr) { c.width = w * dpr; c.height = hh * dpr; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#262626'; ctx.fillRect(0, 0, w, hh);
    // grid
    ctx.strokeStyle = '#2f2f2f'; ctx.lineWidth = 1; ctx.beginPath();
    const x0 = Math.floor(this.view.x), x1 = Math.ceil(this.view.x + w / this.view.s), y0 = Math.floor(this.view.y), y1 = Math.ceil(this.view.y + hh / this.view.s);
    for (let x = x0; x <= x1; x++) { const [sx] = this.toScreen([x, 0]); ctx.moveTo(sx, 0); ctx.lineTo(sx, hh); }
    for (let y = y0; y <= y1; y++) { const [, sy] = this.toScreen([0, y]); ctx.moveTo(0, sy); ctx.lineTo(w, sy); }
    ctx.stroke();
    const g = this.app.game; const byNick = new Map(g.systems.map(s => [s.nickname.toLowerCase(), s]));
    const links = this.computeLinks();
    const seen = new Set();
    for (const l of links) {
      const a = byNick.get(l.from), b = byNick.get(l.to); if (!a || !b) continue;
      const key = [l.from, l.to].sort().join('|') + l.hole; if (seen.has(key)) continue; seen.add(key);
      const back = links.some(m => m.from === l.to && m.to === l.from && m.hole === l.hole);
      const [ax, ay] = this.toScreen(a.pos), [bx, by] = this.toScreen(b.pos);
      ctx.strokeStyle = l.hole ? 'rgba(190,140,255,.75)' : 'rgba(120,170,230,.8)';
      ctx.setLineDash(l.hole ? [5, 4] : back ? [] : [2, 3]); ctx.lineWidth = back ? 1.6 : 1;
      if (!back) ctx.strokeStyle = 'rgba(255,107,92,.9)';
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    }
    ctx.setLineDash([]);
    const dirty = new Set([...this.app.history.dirty].map(d => d.key));
    for (const s of g.systems) {
      const [x, y] = this.toScreen(s.pos);
      const col = PREFIX_COLORS[s.nickname.slice(0, 2).toLowerCase()] || '#bbbbbb';
      const cur = this.app.sys && this.app.sys.sys === s, sel = this.selected === s;
      ctx.beginPath(); ctx.arc(x, y, cur ? 7 : 5.5, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill();
      if (cur || sel) { ctx.lineWidth = 2; ctx.strokeStyle = sel ? '#ffe066' : '#fff'; ctx.stroke(); }
      ctx.font = '600 12px "Segoe UI", system-ui, sans-serif'; ctx.fillStyle = '#c4c4c4'; ctx.textAlign = 'center';
      ctx.fillText(g.name(s.strid) || s.nickname, x, y - 11);
      ctx.font = '10px ui-monospace, Consolas, monospace'; ctx.fillStyle = dirty.has('sys:' + s.nickname.toLowerCase()) ? '#e0a64a' : '#8a8a8a';
      ctx.fillText(s.nickname, x, y + 17);
    }
    const sel = this.selected;
    this.hud.textContent = sel ? `${sel.nickname} · ${g.name(sel.strid) || ''} · pos ${sel.pos.join(', ')} · NavMapScale ${sel.navScale} — double-click to open, drag to move`
      : `${g.systems.length} systems · ${seen.size} connections · solid = gate, dashed = jump hole, red = one-way link · drag systems to move, right-click for more`;
  }
}
