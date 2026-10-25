// Zone containment / scaled distance:
//   SPHERE  size = radius            ELLIPSOID size = radii x,y,z
//   BOX     size = full extents      CYLINDER  size = radius, height (axis = local Y)
//   RING    ini size = outer radius, inner radius, height (axis = local Y)
import * as THREE from 'three';
import { getPos, getRot } from './system.js';

const DEG = Math.PI / 180;
export function zoneShape(sec) {
  const shape = (sec.get('shape') || 'SPHERE').toUpperCase();
  const s = (sec.vals('size') || ['1000']).map(parseFloat);
  const p = new THREE.Vector3(...getPos(sec));
  const r = getRot(sec);
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(r[0] * DEG, r[1] * DEG, r[2] * DEG, 'ZYX'));
  const inv = q.clone().invert();
  let size;
  switch (shape) {
    case 'SPHERE': size = [s[0], s[0], s[0]]; break;
    case 'ELLIPSOID': case 'BOX': size = [s[0], s[1] ?? s[0], s[2] ?? s[0]]; break;
    case 'CYLINDER': size = [s[0], s[1] ?? s[0], s[0]]; break;
    case 'RING': size = [s[0], s[2] ?? 100, s[1] ?? s[0] * 0.5]; break; // outer, height, inner
    default: size = [s[0] || 1000, s[0] || 1000, s[0] || 1000];
  }
  return { shape, size, pos: p, quat: q, inv, sec };
}
const _l = new THREE.Vector3();
function local(z, pt) { return _l.copy(pt).sub(z.pos).applyQuaternion(z.inv); }

// < 1 inside, 1 at the surface
export function scaledDistance(z, pt) {
  const l = local(z, pt), [a, b, c] = z.size;
  switch (z.shape) {
    case 'SPHERE': return l.length() / a;
    case 'ELLIPSOID': return Math.sqrt((l.x / a) ** 2 + (l.y / b) ** 2 + (l.z / c) ** 2);
    case 'BOX': return Math.max(Math.abs(l.x) / (a / 2), Math.abs(l.y) / (b / 2), Math.abs(l.z) / (c / 2));
    case 'CYLINDER': return Math.max(Math.hypot(l.x, l.z) / a, Math.abs(l.y) / (b / 2));
    case 'RING': return Math.max(Math.hypot(l.x, l.z) / a, Math.abs(l.y) / (b / 2));
    default: return l.length() / a;
  }
}
export function contains(z, pt) {
  if (z.shape === 'RING') { const l = local(z, pt); const r = Math.hypot(l.x, l.z); return r <= z.size[0] && r >= z.size[2] && Math.abs(l.y) <= z.size[1] / 2; }
  return scaledDistance(z, pt) <= 1;
}
export function boundingRadius(z) {
  const [a, b, c] = z.size;
  if (z.shape === 'BOX') return Math.hypot(a, b, c) / 2;
  if (z.shape === 'CYLINDER' || z.shape === 'RING') return Math.hypot(a, b / 2);
  return Math.max(a, b, c);
}
