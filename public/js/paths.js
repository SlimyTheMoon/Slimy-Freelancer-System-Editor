// Patrol / trade paths: chains of CYLINDER zones sharing `path_label = <label>, <index>`.
// Each segment's cylinder axis is its local +Y; index n runs from pos − Y·h/2 to pos + Y·h/2
// (checked against Li01 outcasts2_1 → _2: end of 1 meets start of 2 within ~170 m).
// Vanilla writes flat segments as `rotate = -90, yaw, 0`; segmentRotation() reproduces that form.
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/CSS2DRenderer.js';
import { fmtNum, fmtVec } from './formats/ini.js';
import { zoneShape } from './zonemath.js';

const DEG = 180 / Math.PI;

export function pathLabel(sec) {
  const v = sec.vals('path_label'); if (!v || !v[0]) return null;
  return { label: v[0], index: parseInt(v[1] || '1', 10) || 1 };
}

export function collectPaths(sys) {
  const map = new Map();
  for (const z of sys.zones) {
    const pl = pathLabel(z); if (!pl) continue;
    const k = pl.label.toLowerCase();
    if (!map.has(k)) map.set(k, { label: pl.label, segs: [], usage: '' });
    map.get(k).segs.push({ sec: z, index: pl.index });
  }
  for (const p of map.values()) {
    p.segs.sort((a, b) => a.index - b.index);
    p.usage = (p.segs[0].sec.get('usage') || '').toLowerCase();
  }
  return map;
}

export function segEnds(sec) {
  const z = zoneShape(sec);
  const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(z.quat);
  const half = (z.size[1] || 0) / 2;
  return { start: z.pos.clone().addScaledVector(axis, -half), end: z.pos.clone().addScaledVector(axis, half), radius: z.size[0], z };
}

// waypoints of a path: start of the first segment, then the end of each segment.
// A segment that does not start where the previous ended starts a new "run" (gap).
export function waypoints(path) {
  const pts = [], gaps = [];
  let prev = null;
  path.segs.forEach((s, i) => {
    const e = segEnds(s.sec);
    if (!prev) pts.push(e.start);
    else if (prev.distanceTo(e.start) > Math.max(2 * e.radius, 1500)) { gaps.push(i); pts.push(e.start); }
    pts.push(e.end); prev = e.end;
  });
  return { pts, gaps };
}

// rotate for a cylinder whose +Y points from p1 to p2, in vanilla's "pitch, yaw, 0" form
export function segmentRotation(p1, p2) {
  const d = p2.clone().sub(p1).normalize();
  const a = -Math.acos(Math.max(-1, Math.min(1, d.y)));
  const t = Math.abs(Math.sin(a)) < 1e-6 ? 0 : Math.atan2(-d.x, -d.z);
  return [a * DEG, t * DEG, 0].map(v => Math.abs(v) < 0.005 ? 0 : v);
}
export function segmentFor(p1, p2) {
  return { pos: p1.clone().add(p2).multiplyScalar(0.5), height: p1.distanceTo(p2), rotate: segmentRotation(p1, p2) };
}

function writeSeg(sec, p1, p2, radius) {
  const s = segmentFor(p1, p2);
  sec.set('pos', fmtVec(s.pos.toArray(), 0));
  sec.set('rotate', s.rotate.map(v => fmtNum(v, 1)).join(', '));
  sec.set('shape', 'CYLINDER');
  sec.set('size', `${fmtNum(radius, 0)}, ${fmtNum(s.height, 0)}`);
}

// Rewrite a path so its segments run through `pts` (array of Vector3). Existing segments keep all
// their other keys (encounters, attack_ids…); new segments copy the last one; surplus segments go.
// Call inside history.do on the system doc. Returns the zone sections of the path.
export function applyWaypoints(sysDoc, path, pts) {
  const segs = path.segs.map(s => s.sec);
  // segments whose two waypoints did not move keep their exact original geometry lines
  // (vanilla joints are ~190 m apart, so regenerating untouched segments would shift them)
  const W0 = waypoints(path), old = W0.pts, hadGaps = W0.gaps.length > 0;
  const keep = segs.map((sec, j) => ({ a: old[j], b: old[j + 1], pos: sec.get('pos'), rotate: sec.get('rotate'), size: sec.get('size') }));
  const same = (p, q) => p && q && p.distanceTo(q) < 0.5;
  const tmpl = segs[segs.length - 1];
  const radius = segs.length ? (zoneShape(segs[0]).size[0] || 750) : 750;
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    let sec = segs[i];
    if (!sec) {
      sec = tmpl.clone();
      sec.set('nickname', sysDoc.uniqueNick(`Zone_${sysDoc.nickname}_path_${path.label}_${i + 1}`));
      const prevSec = out[out.length - 1];
      sysDoc.ini.insertSection(sec, sysDoc.ini.sections.indexOf(prevSec) + 1);
    }
    sec.set('path_label', `${path.label}, ${i + 1}`);
    const k = hadGaps ? null : keep.find(o => same(o.a, pts[i]) && same(o.b, pts[i + 1]));
    if (k) { sec.set('pos', k.pos); if (k.rotate) sec.set('rotate', k.rotate); else sec.remove('rotate'); sec.set('size', k.size); }
    else writeSeg(sec, pts[i], pts[i + 1], radius);
    out.push(sec);
  }
  for (const s of segs.slice(Math.max(0, pts.length - 1))) sysDoc.ini.removeSection(s);
  return out;
}

// Create a new path from points. `props` = [[key, value]...] written after size (population, encounters).
export function createPath(sysDoc, label, pts, radius, props) {
  const out = [];
  let after = sysDoc.insertAfterKind('zone');
  for (let i = 0; i < pts.length - 1; i++) {
    const s = segmentFor(pts[i], pts[i + 1]);
    const nick = sysDoc.uniqueNick(`Zone_${sysDoc.nickname}_path_${label}_${i + 1}`);
    const entries = [['nickname', nick], ['pos', fmtVec(s.pos.toArray(), 0)], ['rotate', s.rotate.map(v => fmtNum(v, 1)).join(', ')], ['shape', 'CYLINDER'], ['size', `${fmtNum(radius, 0)}, ${fmtNum(s.height, 0)}`]];
    for (const [k, v] of props) entries.push([k, k === 'path_label' ? `${label}, ${i + 1}` : v]);
    if (!props.some(([k]) => k === 'path_label')) entries.push(['path_label', `${label}, ${i + 1}`]);
    after = sysDoc.ini.addSection('Zone', after, entries);
    out.push(after);
  }
  return out;
}

export function labelInUniverse(app, label) {
  const l = label.toLowerCase(), hits = [];
  for (const d of app.systemDocs.values()) for (const z of d.zones) { const p = pathLabel(z); if (p && p.label.toLowerCase() === l) { hits.push(d.nickname); break; } }
  return hits;
}

// ---------------------------------------------------------------- 3D overlay
const COLORS = { patrol: 0xffa040, trade: 0x50e080, mixed: 0xd0d060 };
export class PathOverlay {
  constructor(app) { this.app = app; this.group = new THREE.Group(); this.group.userData.noPick = true; this.sig = ''; this.highlight = null; }
  signature(sys) {
    const parts = [];
    for (const z of sys.zones) if (z.has('path_label')) parts.push(z.get('path_label'), z.get('pos'), z.get('rotate'), z.get('size'), z.get('usage'));
    return parts.join('|');
  }
  clear() {
    this.group.traverse(o => { if (o.isCSS2DObject && o.element && o.element.parentNode) o.element.parentNode.removeChild(o.element); if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    this.group.clear();
  }
  build(sys, force = false) {
    if (!sys) { this.clear(); return; }
    const sig = this.signature(sys) + '|' + (this.highlight || '') + '|' + this.app.settings.paths + '|' + this.app.settings.labels;
    if (!force && sig === this.sig) return;
    this.sig = sig; this.clear();
    if (!this.app.settings.paths) return;
    this.paths = collectPaths(sys);
    for (const [k, p] of this.paths) {
      const hl = this.highlight === k, dim = this.highlight && !hl;
      const base = COLORS[p.usage.includes('trade') && p.usage.includes('patrol') ? 'mixed' : p.usage.includes('trade') ? 'trade' : 'patrol'];
      const color = hl ? 0xffe066 : base;
      const { pts } = waypoints(p);
      const g = new THREE.Group(); g.userData.pathKey = k; g.userData.zoneIds = p.segs.map(sg => sg.sec.id);
      const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: hl ? 1 : dim ? 0.3 : 0.75, depthWrite: false, depthTest: !hl });
      // draw each segment separately so gaps stay visible
      const segPts = [];
      p.segs.forEach(s => { const e = segEnds(s.sec); segPts.push(e.start, e.end); });
      g.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(segPts), mat));
      // joints between consecutive segments (dashed when they don't meet)
      const joints = [];
      for (let i = 1; i < p.segs.length; i++) joints.push(segPts[i * 2 - 1], segPts[i * 2]);
      if (joints.length) { const jl = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(joints), new THREE.LineDashedMaterial({ color, dashSize: 300, gapSize: 300, transparent: true, opacity: 0.6 })); jl.computeLineDistances(); g.add(jl); }
      // direction arrows at segment midpoints + waypoint dots
      for (let i = 0; i < segPts.length; i += 2) {
        const a = segPts[i], b = segPts[i + 1], len = a.distanceTo(b); if (len < 1) continue;
        const dir = b.clone().sub(a).normalize();
        const size = Math.min(Math.max(len * 0.04, 250), 1200);
        const cone = new THREE.Mesh(new THREE.ConeGeometry(size * 0.35, size, 10), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: hl ? 1 : dim ? 0.3 : 0.8, depthWrite: false }));
        cone.position.copy(a).lerp(b, 0.5); cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
        cone.userData.screenScale = true; g.add(cone);
        if (hl) { const tube = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, len, 8, 1, true), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false })); tube.position.copy(cone.position); tube.quaternion.copy(cone.quaternion); tube.userData.tube = true; g.add(tube); }
      }
      const dotGeo = new THREE.SphereGeometry(1, 10, 8);
      for (const pt of pts) { const d = new THREE.Mesh(dotGeo, new THREE.MeshBasicMaterial({ color: hl ? 0xffffff : color, transparent: true, opacity: dim ? 0.3 : 0.9, depthWrite: false })); d.position.copy(pt); d.userData.dot = hl ? 2 : 1; g.add(d); }
      if (hl || this.app.settings.labels === 'all') {
        const el = document.createElement('div'); el.className = 'lbl pathlbl'; el.textContent = `${p.label} (${p.usage || 'path'}, ${p.segs.length})`;
        el.style.color = '#' + color.toString(16).padStart(6, '0');
        const lab = new CSS2DObject(el); lab.position.copy(pts[0]); g.add(lab);
      }
      this.group.add(g);
    }
    this.app.viewport.applyHidden();
  }
  // keep dots/arrows a readable size on screen
  frame(camera) {
    if (!this.group.children.length) return;
    const persp = camera.isPerspectiveCamera;
    for (const g of this.group.children) for (const o of g.children) {
      if (!o.userData.dot && !o.userData.tube) continue;
      const d = persp ? camera.position.distanceTo(o.position) : (camera.top - camera.bottom) / camera.zoom * 0.6;
      if (o.userData.tube) { const r = Math.max(d * 0.0012, 15); o.scale.set(r, 1, r); continue; }
      o.scale.setScalar(Math.max(d * (o.userData.dot === 2 ? 0.004 : 0.0018), 40));
    }
  }
}

