// Planetary rings: `ring = <zone>, <ring ini>` on a planet object. The ring is a flat annulus in the
// zone's local XZ plane (zone shape RING: outer radius, inner radius, height).
// From the decompiled Freelancer.exe, PlanetaryRings::PlanetRing:
//  * vf1 @0x50a240 reads [Exterior] shape, detail_shape, detail_tile (u, v), color (0–255), opacity,
//    thickness_edge, inner_edge, outer_edge, num_segments, transition_dist; [Clouds] = interior puffs.
//    If the detail texture is unavailable, opacity is halved.
//  * vf4 @0x50b510 builds a strip of num_segments quads around the ring. The main texture's v runs across
//    the ring (inner → outer) and its u alternates u0/u1 from one segment to the next. The detail texture
//    uses (u, v) = (0 or detail_tile[1] alternating per segment, 0 → detail_tile[0] across the ring).
//  * FUN_0050b2d0 sets the D3D8 states (tables at 0x5db0d8/0x5db108/0x5db140): lighting off, alpha blend
//    SRCALPHA/INVSRCALPHA; stage 0 = texture × diffuse (rgb and alpha); stage 1 = detail MODULATE2X on
//    rgb and MODULATE on alpha. Diffuse = color (0–255) with alpha = opacity.
import * as THREE from 'three';
import { dataPath } from './api.js';
import { shapeTex } from './shapes.js';
import { zoneShape } from './zonemath.js';

const VERT = `#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec2 ring; varying vec2 vRing;
void main(){ vRing = ring; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
#include <logdepthbuf_vertex>
}`;
const FRAG = `#include <logdepthbuf_pars_fragment>
vec4 toGamma(vec4 v){ return vec4(mix(pow(v.rgb, vec3(0.41666)) * 1.055 - vec3(0.055), v.rgb * 12.92, vec3(lessThanEqual(v.rgb, vec3(0.0031308)))), v.a); }
uniform sampler2D map; uniform sampler2D detail; uniform float hasMap; uniform float hasDetail;
uniform vec4 rect; uniform vec4 drect; uniform vec2 tile; uniform vec3 color; uniform float opacity; // gamma-space maths as in D3D8
varying vec2 vRing; // x: 0/1 alternating around, y: 0 inner → 1 outer
void main(){
  #include <logdepthbuf_fragment>
  vec4 t = hasMap > 0.5 ? toGamma(texture2D(map, rect.xy + vec2(vRing.x, vRing.y) * rect.zw)) : vec4(1.0, 1.0, 1.0, 0.6 * (1.0 - abs(vRing.y * 2.0 - 1.0)));
  if (hasDetail > 0.5) { vec2 d = fract(vec2(vRing.x * tile.y, vRing.y * tile.x)); vec4 dt = toGamma(texture2D(detail, drect.xy + d * drect.zw)); t.rgb *= dt.rgb * 2.0; t.a *= dt.a; }
  gl_FragColor = vec4(t.rgb * color, t.a * opacity);
}`;

export class RingManager {
  constructor(app) { this.app = app; this.group = new THREE.Group(); this.group.userData.noPick = true; this.sig = ''; this.token = 0; }
  signature(sys) {
    const parts = [];
    for (const o of sys.objects) { const r = o.vals('ring'); if (!r) continue; const z = sys.byNick(r[0]); parts.push(r.join(','), z ? [z.get('pos'), z.get('rotate'), z.get('size'), z.get('shape')].join(';') : '-'); }
    return parts.join('|') + '|' + this.app.settings.rings;
  }
  clear() { this.group.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); this.group.clear(); }
  async build(sys, force = false) {
    if (!sys) { this.clear(); this.sig = ''; return; }
    const sig = this.signature(sys);
    if (!force && sig === this.sig) return;
    this.sig = sig; const my = ++this.token;
    const meshes = [];
    if (this.app.settings.rings !== false) {
      for (const o of sys.objects) {
        const r = o.vals('ring'); if (!r || !r[1]) continue;
        const z = sys.byNick(r[0]); if (!z) continue;
        try { const m = await this.ringMesh(z, r[1]); if (m) { m.userData.ids = [o.id, z.id]; meshes.push(m); } } catch (e) { console.warn('ring', r, e); }
      }
    }
    if (my !== this.token) { for (const m of meshes) { m.geometry.dispose(); m.material.dispose(); } return; }
    this.clear(); for (const m of meshes) this.group.add(m);
    this.app.viewport.applyHidden();
  }
  async ringMesh(zoneSec, file) {
    const app = this.app;
    const doc = await app.otherDoc(dataPath(file)); if (!doc) return null;
    const ex = doc.ini.first('Exterior'); if (!ex) return null;
    const shapes = new Map();
    const tp = doc.ini.first('TexturePanels');
    for (const f of tp ? tp.getAll('file') : []) {
      const p = await app.game.texturePanels(f);
      await Promise.all(p.files.map(t => app.rm.loadUtf(dataPath(t))));
      for (const [k, v] of p.shapes) shapes.set(k, v);
    }
    const st = (n) => shapeTex(app, shapes, n);
    const main = st(ex.get('shape')), det = st(ex.get('detail_shape'));
    const z = zoneShape(zoneSec);
    const outer = z.size[0], inner = z.shape === 'RING' ? z.size[2] : outer * 0.6;
    const n = Math.max(8, Math.min(512, parseInt(ex.get('num_segments') || '64', 10) || 64));
    const pos = [], ring = [], idx = [];
    for (let i = 0; i <= n; i++) {
      const a = i / n * Math.PI * 2, c = Math.cos(a), s = Math.sin(a), alt = i % 2;
      pos.push(c * inner, 0, s * inner, c * outer, 0, s * outer);
      ring.push(alt, 0, alt, 1);
      if (i < n) { const k = i * 2; idx.push(k, k + 1, k + 3, k, k + 3, k + 2); }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('ring', new THREE.Float32BufferAttribute(ring, 2));
    geo.setIndex(idx); geo.computeBoundingSphere();
    const col = (ex.vals('color') || ['255', '255', '255']).map(v => (parseFloat(v) || 0) / 255);
    const tile = (ex.vals('detail_tile') || ['1', '1']).map(v => parseFloat(v) || 1);
    let opacity = parseFloat(ex.get('opacity') || '1'); if (!det) opacity *= 0.5;
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: {
        map: { value: main ? main.tex : null }, hasMap: { value: main ? 1 : 0 }, rect: { value: new THREE.Vector4(...(main ? main.rect : [0, 0, 1, 1])) },
        detail: { value: det ? det.tex : null }, hasDetail: { value: det ? 1 : 0 }, drect: { value: new THREE.Vector4(...(det ? det.rect : [0, 0, 1, 1])) },
        tile: { value: new THREE.Vector2(tile[0], tile[1] ?? tile[0]) }, color: { value: new THREE.Vector3(...col) }, opacity: { value: opacity },
      },
    });
    const m = new THREE.Mesh(geo, mat);
    m.position.copy(z.pos); m.quaternion.copy(z.quat); m.renderOrder = 2; m.userData.noPick = true;
    return m;
  }
}
