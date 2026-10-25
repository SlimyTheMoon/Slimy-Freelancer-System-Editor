// Create → Zone (draw): drag out a zone on the Y=0 plane.
//   SPHERE / CYLINDER / RING: press at the centre, drag to the radius.
//   ELLIPSOID: press at the centre, drag to a corner — radii from the drag in X and Z.
//   BOX: press at one corner, drag to the opposite corner.
// The mode stays on for several zones; Esc or "Done" leaves it. Snap (toolbar) rounds to the move snap.
import * as THREE from 'three';
import { h } from './dom.js';

const SHAPES = ['SPHERE', 'ELLIPSOID', 'BOX', 'CYLINDER', 'RING'];
const PRESETS = { plain: {}, exclusion: { sort: 99 }, death: { damage: 2000000, sort: 99.5 }, encounter: { sort: 99, toughness: 3, density: 4, repop_time: 30, max_battle_size: 4, pop_type: 'attack_patrol', relief_time: 20 } };

export function drawZoneTool(app, initialShape = 'SPHERE') {
  const vp = app.viewport, dom = vp.renderer.domElement;
  if (vp.clickHook) vp.clickHook.cancel();
  let shape = initialShape, preset = 'plain', start = null, cur = null;
  const group = new THREE.Group(); group.userData.noPick = true; vp.scene.add(group);
  const banner = h('div', { class: 'clickbanner' }); document.getElementById('viewport').append(banner);
  const snap = (p) => { const s = vp.snap ? (app.settings.snapMove || 0) : 0; if (s > 0) { p.x = Math.round(p.x / s) * s; p.z = Math.round(p.z / s) * s; } p.y = 0; return p; };
  const dims = () => {
    if (!start || !cur) return null;
    const dx = cur.x - start.x, dz = cur.z - start.z, r = Math.hypot(dx, dz);
    switch (shape) {
      case 'SPHERE': return { pos: start.clone(), size: [r], show: [r, r, r] };
      case 'CYLINDER': return { pos: start.clone(), size: [r, r * 0.5], show: [r, r * 0.25, r] };
      case 'RING': return { pos: start.clone(), size: [r, r * 0.6, Math.max(r * 0.05, 50)], show: [r, Math.max(r * 0.025, 25), r] };
      case 'ELLIPSOID': { const a = Math.abs(dx), c = Math.abs(dz), b = Math.min(a, c); return { pos: start.clone(), size: [a, b, c], show: [a, b, c] }; }
      case 'BOX': { const a = Math.abs(dx), c = Math.abs(dz), b = Math.min(a, c); return { pos: start.clone().add(cur).multiplyScalar(0.5), size: [a, b, c], show: [a / 2, b / 2, c / 2] }; }
    }
  };
  const redraw = () => {
    group.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); group.clear();
    const d = dims();
    if (d && d.size[0] > 1) {
      const geo = shape === 'BOX' ? new THREE.BoxGeometry(2, 2, 2) : shape === 'CYLINDER' ? new THREE.CylinderGeometry(1, 1, 2, 48, 1, true) : shape === 'RING' ? new THREE.CylinderGeometry(1, 1, 2, 64, 1, true) : new THREE.SphereGeometry(1, 40, 20);
      const mesh = new THREE.LineSegments(new THREE.WireframeGeometry(geo), new THREE.LineBasicMaterial({ color: 0xffe066, depthTest: false, transparent: true, opacity: 0.8 }));
      mesh.position.copy(d.pos); mesh.scale.set(...d.show); group.add(mesh);
      if (shape === 'RING') { const inner = mesh.clone(); inner.material = mesh.material.clone(); inner.scale.set(d.size[1], d.show[1], d.size[1]); group.add(inner); }
    }
    banner.innerHTML = '';
    banner.append(h('b', {}, 'Draw zone'), ' ',
      ...SHAPES.map(s => h('button', { class: 'btn sm' + (s === shape ? ' primary' : ''), onclick: () => { shape = s; redraw(); } }, s.toLowerCase())), ' ',
      h('select', { style: { fontSize: '12px' }, onchange: (e) => { preset = e.target.value; } }, Object.keys(PRESETS).map(p => h('option', { selected: p === preset }, p))), ' ',
      d ? h('span', { style: { fontFamily: 'var(--mono)' } }, ` size ${d.size.map(v => Math.round(v)).join(', ')} `) : h('span', {}, shape === 'BOX' ? ' drag corner → corner ' : ' drag centre → edge '),
      h('button', { class: 'btn sm', onclick: done }, 'Done'));
  };
  const down = (e) => {
    if (e.button !== 0 || e.target !== dom) return;
    e.stopPropagation(); start = snap(vp.groundPoint(e)); cur = start.clone(); vp.orbit.enabled = false; redraw();
  };
  const move = (e) => { if (!start) return; cur = snap(vp.groundPoint(e)); redraw(); };
  const up = (e) => {
    if (!start) return;
    const d = dims(); start = null; cur = null; vp.orbit.enabled = true; redraw();
    if (!d || d.size[0] < 10) return;
    const nick = app.sys.uniqueNick(`Zone_${app.sys.nickname}_${shape.toLowerCase()}_01`);
    app.addZoneAt(shape, d.pos, d.size.map(v => Math.round(v)), { nickname: nick, ...PRESETS[preset] });
  };
  const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(); } };
  function done() {
    vp.clickHook = null; vp.orbit.enabled = true; vp.scene.remove(group); banner.remove();
    dom.removeEventListener('pointerdown', down, true); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); document.removeEventListener('keydown', key, true);
  }
  vp.clickHook = { add: () => { }, cancel: done };
  dom.addEventListener('pointerdown', down, true); window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); document.addEventListener('keydown', key, true);
  redraw();
}
