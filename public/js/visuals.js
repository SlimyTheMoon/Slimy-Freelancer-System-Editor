// Builds THREE visuals for system entities (objects, zones, lights).
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/CSS2DRenderer.js';
import { dataPath } from './api.js';
import { getPos, getRot } from './system.js';
import { rotFromFl } from './formats/model.js';
import { buildSun } from './sun.js';

const DEG = Math.PI / 180;
export function applyTransform(obj, sec) {
  const p = getPos(sec), r = getRot(sec);
  obj.position.set(p[0], p[1], p[2]);
  obj.rotation.set(r[0] * DEG, r[1] * DEG, r[2] * DEG, 'ZYX');
}

export const TYPE_COLORS = {
  PLANET: 0x4f9de8, MOON: 0x7fb2d9, SUN: 0xffd34d, STATION: 0x52d17c, DOCKING_RING: 0x52d17c, JUMP_GATE: 0xd08cff, JUMP_HOLE: 0xb06cff,
  TRADELANE_RING: 0x45d6d0, WEAPONS_PLATFORM: 0xff6b5c, DESTROYABLE_DEPOT: 0xffa94d, SATELLITE: 0xc8c8c8, MISSION_SATELLITE: 0xc8c8c8,
  NON_TARGETABLE: 0x8a8a8a, AIRLOCK_GATE: 0x52d17c, DEFAULT: 0xbfc7d5,
};
export function objectColor(arch) { return TYPE_COLORS[arch && arch.type] || TYPE_COLORS.DEFAULT; }

export function zoneStyle(sec, info) {
  const n = (sec.get('nickname') || '').toLowerCase();
  if (info && info.kind === 'nebula') return { color: info.color ? new THREE.Color(...info.color.map(c => Math.max(c, 0.25))) : new THREE.Color(0.7, 0.4, 1), cat: 'nebula' };
  if (info && info.kind === 'asteroids') return { color: new THREE.Color(0.85, 0.6, 0.35), cat: 'asteroids' };
  if (sec.has('damage') || /death/.test(n)) return { color: new THREE.Color(1, 0.3, 0.25), cat: 'death' };
  if (/exclusion|_exclusion|exclude/.test(n)) return { color: new THREE.Color(1, 0.55, 0.2), cat: 'exclusion' };
  if (sec.has('path_label') || /path|tradelane/.test(n) || sec.has('lane_id')) return { color: new THREE.Color(0.25, 0.85, 0.85), cat: 'path' };
  if (sec.has('encounter')) return { color: new THREE.Color(1, 0.85, 0.3), cat: 'encounter' };
  return { color: new THREE.Color(0.7, 0.75, 0.85), cat: 'other' };
}

// ---------------- shared sprite textures ----------------
let glowTex = null, dotTex = null, lightTex = null;
function radialTexture(stops, size = 128) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, col] of stops) grd.addColorStop(o, col);
  g.fillStyle = grd; g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function glowTexture() { return glowTex || (glowTex = radialTexture([[0, 'rgba(255,255,255,1)'], [0.18, 'rgba(255,255,255,0.75)'], [0.45, 'rgba(255,255,255,0.18)'], [1, 'rgba(255,255,255,0)']])); }
function dotTexture() {
  if (dotTex) return dotTex;
  const c = document.createElement('canvas'); c.width = c.height = 32; const g = c.getContext('2d');
  g.beginPath(); g.arc(16, 16, 11, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill(); g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,0.85)'; g.stroke();
  dotTex = new THREE.CanvasTexture(c); return dotTex;
}
function lightTexture() {
  if (lightTex) return lightTex;
  const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
  g.translate(32, 32); g.strokeStyle = '#fff'; g.lineWidth = 4;
  for (let i = 0; i < 8; i++) { g.rotate(Math.PI / 4); g.beginPath(); g.moveTo(14, 0); g.lineTo(26, 0); g.stroke(); }
  g.beginPath(); g.arc(0, 0, 9, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill();
  lightTex = new THREE.CanvasTexture(c); return lightTex;
}

function marker(color, size = 9) {
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
  const m = new THREE.PointsMaterial({ color, size, sizeAttenuation: false, map: dotTexture(), transparent: true, alphaTest: 0.2, depthTest: false, depthWrite: false });
  const p = new THREE.Points(g, m); p.renderOrder = 10; p.userData.marker = true; return p;
}

function label(text, cls) {
  const d = document.createElement('div'); d.className = 'lbl ' + (cls || ''); d.textContent = text;
  const o = new CSS2DObject(d); o.userData.label = true; o.center.set(0.5, -0.4); return o;
}

// ---------------- objects ----------------
export async function buildObject(app, sec) {
  const game = app.game, rm = app.rm;
  const group = new THREE.Group();
  group.userData = { entityId: sec.id, kind: 'object' };
  applyTransform(group, sec);
  const archName = sec.get('archetype');
  const arch = game.arch(archName);
  const color = objectColor(arch);
  const starNick = sec.get('star');
  let radius = arch && arch.radius ? arch.radius : 150;
  const content = new THREE.Group(); content.userData.content = true; group.add(content);
  group.userData.arch = arch ? arch.type : null;
  if (starNick && game.stars.get(starNick.toLowerCase())) {
    radius = await buildSun(app, starNick, content, group);
  } else if (arch && arch.da && app.settings.models) {
    const model = await rm.model(dataPath(arch.da), arch.matLibs.map(dataPath));
    if (model) {
      content.add(model);
      radius = model.userData.sphereRadius || model.userData.radius || radius;
      group.userData.hardpoints = model.userData.hardpoints;
      // Some archetypes are invisible in-game (jump holes are an effect, hazard boxes/buoys are markers):
      // give them a translucent stand-in so they can be seen and clicked.
      let visible = false;
      model.traverse(o => { if (o.isMesh && o.material && (o.material.opacity > 0.02 || !o.material.transparent)) visible = true; });
      // particle effects from the loadout (e.g. jump hole wormhole = AttachedFX on HpFX1)
      const fxCount = app.settings.effects && app.fx ? await attachEffects(app, sec, arch, model, content) : 0;
      if (!visible) {
        radius = Math.max(arch.radius || 0, model.userData.radius || 0, 150);
        const px = arch.type === 'JUMP_HOLE' ? holeProxy(color, radius) : proxy(color, radius, 0.35);
        // with a real effect showing, keep the stand-in only as an invisible click target
        if (fxCount) px.traverse(o => { if (o.material) o.material.visible = false; });
        content.add(px);
      }
    } else content.add(proxy(color, radius));
  } else {
    content.add(proxy(color, radius));
  }
  // atmosphere range ring for planets (subtle)
  group.userData.radius = radius;
  group.userData.color = color;
  const mk = marker(color, arch && ['PLANET', 'SUN', 'MOON'].includes(arch.type) ? 11 : arch && arch.type === 'TRADELANE_RING' ? 6 : 8);
  group.add(mk);
  const nm = game.name(sec.get('ids_name'));
  const text = nm ? nm : sec.get('nickname');
  const lb = label(text, arch ? 't-' + (arch.type || '').toLowerCase() : '');
  lb.userData.important = !!(arch && ['PLANET', 'SUN', 'MOON', 'STATION', 'JUMP_GATE', 'JUMP_HOLE', 'DOCKING_RING'].includes(arch.type)) || !!sec.get('base');
  lb.userData.tradelane = !!(arch && arch.type === 'TRADELANE_RING');
  group.add(lb);
  return group;
}

async function attachEffects(app, sec, arch, model, content) {
  const g = app.game;
  const lo = (sec.get('loadout') || arch.loadout || '').toLowerCase();
  const equips = g.loadoutEquip.get(lo) || [];
  let n = 0;
  for (const [eq, hp] of equips) {
    const particles = g.attachedFx.get((eq || '').toLowerCase());
    if (!particles) continue;
    const inst = await app.fx.create(particles);
    if (!inst) continue;
    const h = hp && (model.userData.hardpoints || []).find(x => x.name.toLowerCase() === hp.toLowerCase());
    if (h) {
      inst.object.position.copy(h.pos);
      if (h.rot) { const m = rotFromFl(h.rot); if (h.partMatrix) m.premultiply(new THREE.Matrix4().extractRotation(h.partMatrix)); inst.object.quaternion.setFromRotationMatrix(m); }
    }
    content.add(inst.object); n++;
  }
  return n;
}

function proxy(color, radius, opacity = 0.85) {
  const m = new THREE.Mesh(new THREE.IcosahedronGeometry(Math.max(radius, 60), 1), new THREE.MeshLambertMaterial({ color, flatShading: true, transparent: true, opacity, depthWrite: opacity > 0.5 }));
  m.userData.proxy = true; return m;
}
function holeProxy(color, radius) {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(radius * 0.8, radius * 0.12, 12, 48), mat);
  const disc = new THREE.Mesh(new THREE.CircleGeometry(radius * 0.75, 48), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.15, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }));
  g.add(ring, disc); g.userData.proxy = true;
  return g;
}

// ---------------- zones ----------------
function circle(r, axis = 'y', seg = 96) {
  const pts = [];
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2, c = Math.cos(a) * r, s = Math.sin(a) * r;
    pts.push(axis === 'y' ? new THREE.Vector3(c, 0, s) : axis === 'x' ? new THREE.Vector3(0, c, s) : new THREE.Vector3(c, s, 0));
  }
  return pts;
}
function linesFromLoops(loops) {
  const pos = [];
  for (const l of loops) for (let i = 0; i < l.length - 1; i++) pos.push(l[i].x, l[i].y, l[i].z, l[i + 1].x, l[i + 1].y, l[i + 1].z);
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); return g;
}
export function zoneDims(sec) {
  const shape = (sec.get('shape') || 'SPHERE').toUpperCase();
  const s = (sec.vals('size') || ['1000']).map(parseFloat);
  return { shape, s };
}
export function zoneGeometry(shape, s) {
  let wire, fill;
  if (shape === 'SPHERE' || shape === 'ELLIPSOID') {
    const [rx, ry, rz] = shape === 'SPHERE' ? [s[0], s[0], s[0]] : [s[0], s[1] ?? s[0], s[2] ?? s[0]];
    const loops = [circle(1, 'y'), circle(1, 'x'), circle(1, 'z')];
    wire = linesFromLoops(loops); wire.scale(rx, ry, rz);
    fill = new THREE.SphereGeometry(1, 32, 20); fill.scale(rx, ry, rz);
  } else if (shape === 'BOX') {
    const [x, y, z] = [s[0], s[1] ?? s[0], s[2] ?? s[0]];
    fill = new THREE.BoxGeometry(x, y, z);
    wire = new THREE.EdgesGeometry(fill);
  } else if (shape === 'CYLINDER') {
    const r = s[0], h = s[1] ?? s[0];
    const top = circle(r, 'y').map(v => v.setY(h / 2)), bot = circle(r, 'y').map(v => v.setY(-h / 2));
    const sides = [0, 1, 2, 3].map(i => { const a = i * Math.PI / 2; return [new THREE.Vector3(Math.cos(a) * r, h / 2, Math.sin(a) * r), new THREE.Vector3(Math.cos(a) * r, -h / 2, Math.sin(a) * r)]; });
    wire = linesFromLoops([top, bot, ...sides]);
    fill = new THREE.CylinderGeometry(r, r, h, 32, 1);
  } else if (shape === 'RING') {
    const ro = s[0], ri = s[1] ?? s[0] * 0.5, h = s[2] ?? 100;
    const loops = [ro, ri].flatMap(r => [circle(r, 'y').map(v => v.setY(h / 2)), circle(r, 'y').map(v => v.setY(-h / 2))]);
    wire = linesFromLoops(loops);
    const shapeR = new THREE.Shape(); shapeR.absarc(0, 0, ro, 0, Math.PI * 2, false);
    const hole = new THREE.Path(); hole.absarc(0, 0, ri, 0, Math.PI * 2, true); shapeR.holes.push(hole);
    fill = new THREE.ExtrudeGeometry(shapeR, { depth: h, bevelEnabled: false, curveSegments: 48 });
    fill.rotateX(-Math.PI / 2); fill.translate(0, -h / 2, 0);
  } else {
    wire = linesFromLoops([circle(s[0] || 1000, 'y')]); fill = new THREE.SphereGeometry(s[0] || 1000, 16, 12);
  }
  return { wire, fill };
}

export function buildZone(app, sec, info) {
  const group = new THREE.Group();
  group.userData = { entityId: sec.id, kind: 'zone' };
  applyTransform(group, sec);
  const { shape, s } = zoneDims(sec);
  const style = zoneStyle(sec, info);
  const { wire, fill } = zoneGeometry(shape, s);
  const lm = new THREE.LineBasicMaterial({ color: style.color, transparent: true, opacity: 0.55, depthWrite: false });
  const lines = new THREE.LineSegments(wire, lm); lines.userData.zoneWire = true; lines.renderOrder = 4;
  group.add(lines);
  const fm = new THREE.MeshBasicMaterial({ color: style.color, transparent: true, opacity: style.cat === 'nebula' ? 0.07 : 0.035, depthWrite: false, side: THREE.DoubleSide });
  const fillMesh = new THREE.Mesh(fill, fm); fillMesh.userData.zoneFill = true; fillMesh.renderOrder = 5;
  group.add(fillMesh);
  if (style.cat === 'asteroids' || style.cat === 'nebula') group.add(fieldDots(fillMesh.geometry, style.color, style.cat === 'nebula' ? 160 : 260));
  group.userData.cat = style.cat;
  group.userData.color = style.color;
  fill.computeBoundingSphere();
  group.userData.radius = fill.boundingSphere ? fill.boundingSphere.radius : 1000;
  const lb = label(sec.get('nickname'), 'zone'); lb.userData.zone = true; group.add(lb);
  return group;
}

function fieldDots(geom, color, n) {
  geom.computeBoundingBox();
  const bb = geom.boundingBox; const pos = [];
  const tmp = new THREE.Mesh(geom); const ray = new THREE.Raycaster();
  let tries = 0;
  while (pos.length / 3 < n && tries++ < n * 12) {
    const p = new THREE.Vector3(THREE.MathUtils.lerp(bb.min.x, bb.max.x, Math.random()), THREE.MathUtils.lerp(bb.min.y, bb.max.y, Math.random()), THREE.MathUtils.lerp(bb.min.z, bb.max.z, Math.random()));
    // inside test: ray along +x crosses an odd number of faces (double sided)
    ray.set(p, new THREE.Vector3(1, 0.0001, 0.0002).normalize());
    tmp.material.side = THREE.DoubleSide;
    const hits = ray.intersectObject(tmp, false);
    if (hits.length % 2 === 1) pos.push(p.x, p.y, p.z);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const pts = new THREE.Points(g, new THREE.PointsMaterial({ color, size: 2.5, sizeAttenuation: false, transparent: true, opacity: 0.55, depthWrite: false }));
  pts.userData.noPick = true; pts.userData.fieldDots = true;
  return pts;
}

// ---------------- lights ----------------
export function buildLight(app, sec) {
  const group = new THREE.Group();
  group.userData = { entityId: sec.id, kind: 'light' };
  applyTransform(group, sec);
  const c = (sec.vals('color') || ['255', '255', '255']).map(x => parseFloat(x) / 255);
  const color = new THREE.Color(...c);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: lightTexture(), color, sizeAttenuation: false, depthTest: false, transparent: true }));
  sp.scale.set(0.035, 0.035, 1); sp.renderOrder = 11; sp.userData.lightIcon = true;
  group.add(sp);
  const range = parseFloat(sec.get('range') || '0');
  if (range > 0) {
    const w = new THREE.LineSegments(linesFromLoops([circle(range, 'y')]), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.25 }));
    w.userData.rangeRing = true; w.visible = false; w.userData.noPick = true; group.add(w);
  }
  group.userData.radius = 300; group.userData.color = color;
  const lb = label(sec.get('nickname'), 'light'); lb.userData.lightLabel = true; group.add(lb);
  return group;
}
