// Suns: 3D glow + center billboards, and the screen-space spines / lens flare / lens glow overlay.
//
// Derived from the decompiled Freelancer.exe (pipeline\out\Freelancer.exe), class StarEffects::Star:
//  * vf6 @0x5118d0 draws star_glow and star_center as camera-facing billboards in 3D.
//  * FUN_0050fba0 loads [spines]: per spine {cos, sin, length, width, inner rgb, outer rgb, alpha}
//    (0x2c bytes). Directions are i·2π/n starting at angle 0; length and width × radius_scale.
//  * FUN_00510160 draws spines IN SCREEN SPACE. r = projected sun radius in pixels clamped to
//    [min_radius, max_radius]; each spine is a ray from the sun centre outwards, length r·length,
//    width r·width; transparent at the centre, full alpha from the sun's edge (r) on, inner colour
//    blending to outer colour at the tip; additive blending (D3D SRCALPHA, ONE).
//    Spine counts other than 2, 4, 6 and 12 get 0 from the occlusion sampler FUN_00510990,
//    so they are never visible in FL; we mirror that and flag it in the star editor.
//  * FUN_0050f850 draws [lens_flare] beads in screen space: bead = {pos, size, r, g, b, alpha};
//    centre = sun + 3·(screen centre − sun)·pos, half size = clamp(r, min, max)·size, alpha fades
//    out when the sun is within 10 % of the screen width of the centre.
// Spines are screen-space rays from the sun centre (3D quads centred on the sun would show every spine
// on both sides); angles start at 0, and lens flare and lens glow are drawn as the game does.
// Colour maths is done like D3D8 did it: in gamma space. Textures are tagged sRGB for the built-in
// materials, so shaders convert samples back to gamma (toGamma) and write the result unconverted.
import * as THREE from 'three';
import { dataPath } from './api.js';
import { shapeTex } from './shapes.js';

const LOGV = `#include <common>
#include <logdepthbuf_pars_vertex>`;
const RADIAL_VERT = `${LOGV}
attribute vec2 corner; varying vec2 vUv; uniform float uSize; uniform vec4 uRect;
void main(){
  vec3 R = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 U = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec4 c = modelMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  vec3 p = c.xyz + (R * corner.x + U * corner.y) * uSize * 0.5;
  vUv = corner * 0.5 + 0.5;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  #include <logdepthbuf_vertex>
}`;
const RADIAL_FRAG = `#include <logdepthbuf_pars_fragment>
vec4 toGamma(vec4 v){ return vec4(mix(pow(v.rgb, vec3(0.41666)) * 1.055 - vec3(0.055), v.rgb * 12.92, vec3(lessThanEqual(v.rgb, vec3(0.0031308)))), v.a); }
uniform sampler2D map; uniform float hasMap; uniform vec4 uRect; uniform vec3 inner; uniform vec3 outer; uniform float alpha;
varying vec2 vUv;
void main(){
  #include <logdepthbuf_fragment>
  vec4 t = hasMap > 0.5 ? toGamma(texture2D(map, uRect.xy + vUv * uRect.zw)) : vec4(1.0, 1.0, 1.0, 1.0 - smoothstep(0.0, 0.5, distance(vUv, vec2(0.5))));
  float d = min(distance(vUv, vec2(0.5)) * 2.0, 1.0);
  gl_FragColor = t * vec4(mix(inner, outer, d), alpha);
}`;

let quadGeo = null;
function billboardGeo() {
  if (quadGeo) return quadGeo;
  quadGeo = new THREE.BufferGeometry();
  quadGeo.setAttribute('corner', new THREE.Float32BufferAttribute([-1, -1, 1, -1, 1, 1, -1, 1], 2));
  quadGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 3));
  quadGeo.setIndex([0, 1, 2, 0, 2, 3]);
  quadGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
  return quadGeo;
}
function radialBillboard(st, size, inner, outer, additive) {
  const m = new THREE.ShaderMaterial({
    vertexShader: RADIAL_VERT, fragmentShader: RADIAL_FRAG, transparent: true, depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, side: THREE.DoubleSide,
    uniforms: { map: { value: st ? st.tex : null }, hasMap: { value: st ? 1 : 0 }, uRect: { value: new THREE.Vector4(...(st ? st.rect : [0, 0, 1, 1])) }, uSize: { value: size }, inner: { value: new THREE.Vector3(...inner) }, outer: { value: new THREE.Vector3(...outer) }, alpha: { value: 1 } },
  });
  const mesh = new THREE.Mesh(billboardGeo(), m);
  mesh.frustumCulled = false; mesh.userData.noPick = true; mesh.renderOrder = 4;
  return mesh;
}

// shapes from stararch [Texture] blocks (tex_shape = whole texture)
let shapeCache = null;
export async function starShapes(app) {
  if (shapeCache) return shapeCache;
  shapeCache = (async () => {
    const g = app.game, shapes = new Map();
    for (const f of g.starArchFiles || ['solar\\stararch.ini']) {
      const p = await g.texturePanels(f);
      await Promise.all(p.files.map(t => app.rm.loadUtf(dataPath(t))));
      for (const [k, v] of p.shapes) shapes.set(k, v);
    }
    return shapes;
  })();
  return shapeCache;
}

// Build the 3D part of a sun into `content`; returns the radius. Spines/flare are drawn by SunOverlay.
export async function buildSun(app, starNick, content, group) {
  const g = app.game, star = g.stars.get(starNick.toLowerCase());
  const radius = star.radius || 1000;
  const shapes = await starShapes(app);
  const glow = star.glow && g.starGlows.get(star.glow.toLowerCase());
  const center = star.center && g.starGlows.get(star.center.toLowerCase());
  // invisible pick target (FL draws no sphere for suns)
  const pick = new THREE.Mesh(new THREE.SphereGeometry(radius, 24, 16), new THREE.MeshBasicMaterial({ visible: false }));
  content.add(pick);
  if (glow) content.add(radialBillboard(shapeTex(app, shapes, glow.shape), radius * glow.scale, glow.inner, glow.outer, false));
  if (center) { const c = radialBillboard(shapeTex(app, shapes, center.shape), radius * center.scale, center.inner, center.outer, true); c.renderOrder = 5; content.add(c); }
  if (!glow && !center) content.add(radialBillboard(null, radius * 4, [1, 1, 0.9], [1, 0.8, 0.5], true));
  group.userData.sunFx = { star, radius, vis: 0 };
  return radius;
}

// ---------------------------------------------------------------- screen-space overlay
const SCREEN_VERT = `attribute vec4 color; varying vec4 vColor; varying vec2 vUv;
void main(){ vColor = color; vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const SCREEN_FRAG = `vec4 toGamma(vec4 v){ return vec4(mix(pow(v.rgb, vec3(0.41666)) * 1.055 - vec3(0.055), v.rgb * 12.92, vec3(lessThanEqual(v.rgb, vec3(0.0031308)))), v.a); }
uniform sampler2D map; uniform float hasMap; varying vec4 vColor; varying vec2 vUv;
void main(){ vec4 t = hasMap > 0.5 ? toGamma(texture2D(map, vUv)) : vec4(1.0, 1.0, 1.0, 1.0 - smoothstep(0.0, 0.5, distance(fract(vUv), vec2(0.5)))); gl_FragColor = t * vColor;
}`;

class QuadBatch {
  constructor() { this.pos = []; this.uv = []; this.col = []; }
  // a quad from 4 corners (screen px), uvs and per-corner colours
  quad(p, uv, c) { for (const i of [0, 1, 2, 0, 2, 3]) { this.pos.push(p[i][0], p[i][1], 0); this.uv.push(uv[i][0], uv[i][1]); this.col.push(...c[i]); } }
}

export class SunOverlay {
  constructor(app) {
    this.app = app;
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
    this.meshes = new Map(); // texture key -> mesh
    this.shapes = null; starShapes(app).then(s => { this.shapes = s; });
    this.ray = new THREE.Raycaster();
  }
  meshFor(st) {
    const key = st ? st.tex.uuid : 'none';
    let m = this.meshes.get(key);
    if (!m) {
      m = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.ShaderMaterial({ vertexShader: SCREEN_VERT, fragmentShader: SCREEN_FRAG, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, uniforms: { map: { value: st ? st.tex : null }, hasMap: { value: st ? 1 : 0 } } }));
      m.frustumCulled = false; this.scene.add(m); this.meshes.set(key, m);
    }
    return m;
  }
  // is the sun hidden behind a planet/moon sphere? (FL samples 12 rays; one central ray is enough here)
  occluded(sunPos, cam) {
    const dir = sunPos.clone().sub(cam.position); const dist = dir.length(); dir.normalize();
    const vp = this.app.viewport, tmp = new THREE.Vector3();
    for (const v of vp.visuals.values()) {
      const r = v.userData.radius, t = v.userData.arch;
      if (!r || v.userData.sunFx || !v.visible || !(t === 'PLANET' || t === 'MOON')) continue;
      v.getWorldPosition(tmp); const oc = tmp.sub(cam.position);
      const proj = oc.dot(dir); if (proj < 0 || proj > dist) continue;
      if (oc.lengthSq() - proj * proj < r * r * 0.9) return true;
    }
    return false;
  }
  render(renderer, cam, w, h, dt) {
    const S = this.app.settings;
    const batches = new Map();
    const add = (st) => { const k = st ? st.tex.uuid : 'none'; if (!batches.has(k)) batches.set(k, { st, b: new QuadBatch() }); return batches.get(k).b; };
    if (S.sunFx !== false && this.shapes) {
      const g = this.app.game, persp = cam.isPerspectiveCamera;
      const sp = new THREE.Vector3(), ndc = new THREE.Vector3();
      for (const v of this.app.viewport.visuals.values()) {
        const fx = v.userData.sunFx; if (!fx || !v.visible) continue;
        v.getWorldPosition(sp);
        ndc.copy(sp).project(cam);
        const inFront = persp ? sp.clone().sub(cam.position).dot(cam.getWorldDirection(new THREE.Vector3())) > 0 : true;
        const onScreen = inFront && Math.abs(ndc.x) < 1.15 && Math.abs(ndc.y) < 1.15;
        const target = onScreen && !(persp && this.occluded(sp, cam)) ? 1 : 0;
        fx.vis += Math.sign(target - fx.vis) * Math.min(Math.abs(target - fx.vis), dt / 0.25); // 0.25 s fade (glow_fade_*_seconds)
        if (fx.vis <= 0.001) continue;
        const x = ndc.x * w / 2, y = ndc.y * h / 2;
        const rpx = persp ? fx.radius / Math.max(sp.distanceTo(cam.position), 1) * (h / 2) / Math.tan(cam.fov * Math.PI / 360)
          : fx.radius * cam.zoom * h / (cam.top - cam.bottom);
        const sec = fx.star.section;
        // spines
        const spn = sec.get('spines') && g.starSpines && g.starSpines.get(sec.get('spines').toLowerCase());
        if (spn && [2, 4, 6, 12].includes(spn.items.length)) {
          const st = shapeTex(this.app, this.shapes, spn.shape); const b = add(st);
          const r = Math.min(Math.max(rpx, spn.min), spn.max);
          const rc = st ? st.rect : [0, 0, 1, 1];
          spn.items.forEach((s, i) => {
            const a = i * 2 * Math.PI / spn.items.length, dx = Math.cos(a), dy = Math.sin(a);
            const L = r * s.length * spn.scale, hw = r * s.width * spn.scale * 0.5;
            const al = s.alpha * fx.vis, f = Math.min(r / Math.max(L, 1e-3), 1);
            const nx = -dy * hw, ny = dx * hw;
            const P = (d, side) => [x + dx * d + nx * side, y + dy * d + ny * side];
            const mid = s.inner.map((c, k) => c + (s.outer[k] - c) * f);
            const U = (u, vv) => [rc[0] + u * rc[2], rc[1] + vv * rc[3]];
            // centre → sun edge: fade in; sun edge → tip: full alpha, inner → outer colour
            b.quad([P(0, -1), P(r * 0 + f * L, -1), P(f * L, 1), P(0, 1)], [U(0, 0), U(f, 0), U(f, 1), U(0, 1)], [[...s.inner, 0], [...mid, al], [...mid, al], [...s.inner, 0]]);
            b.quad([P(f * L, -1), P(L, -1), P(L, 1), P(f * L, 1)], [U(f, 0), U(1, 0), U(1, 1), U(f, 1)], [[...mid, al], [...s.outer, al], [...s.outer, al], [...mid, al]]);
          });
        }
        if (persp) {
          // lens glow at the sun
          const lg = sec.get('lens_glow') && g.lensGlows && g.lensGlows.get(sec.get('lens_glow').toLowerCase());
          if (lg) {
            const st = shapeTex(this.app, this.shapes, lg.shape); const b = add(st); const rc = st ? st.rect : [0, 0, 1, 1];
            const hs = Math.min(Math.max(rpx, 15), 150) * lg.scale;
            const ci = [...lg.inner, fx.vis * 0.9], co = [...lg.outer, fx.vis * 0.9];
            b.quad([[x - hs, y - hs], [x + hs, y - hs], [x + hs, y + hs], [x - hs, y + hs]], [[rc[0], rc[1]], [rc[0] + rc[2], rc[1]], [rc[0] + rc[2], rc[1] + rc[3]], [rc[0], rc[1] + rc[3]]], [ci, co, co, ci]);
          }
          // lens flare beads along sun → screen centre
          const lf = sec.get('lens_flare') && g.lensFlares && g.lensFlares.get(sec.get('lens_flare').toLowerCase());
          if (lf && onScreen) {
            const st = shapeTex(this.app, this.shapes, lf.shape); const b = add(st); const rc = st ? st.rect : [0, 0, 1, 1];
            const r = Math.min(Math.max(rpx, lf.min), lf.max);
            const ddx = -x, ddy = -y, d2 = ddx * ddx + ddy * ddy, lim = (0.1 * w) ** 2;
            const fade = d2 < lim ? d2 / lim : 1;
            const visK = 1 - (1 - fx.vis) * (1 - fx.vis);
            for (const bd of lf.beads) {
              const cx = x + ddx * 3 * bd[0], cy = y + ddy * 3 * bd[0], hs = r * visK * bd[1];
              const c = [bd[2], bd[3], bd[4], bd[5] * fade];
              b.quad([[cx - hs, cy - hs], [cx + hs, cy - hs], [cx + hs, cy + hs], [cx - hs, cy + hs]], [[rc[0], rc[1]], [rc[0] + rc[2], rc[1]], [rc[0] + rc[2], rc[1] + rc[3]], [rc[0], rc[1] + rc[3]]], [c, c, c, c]);
            }
          }
        }
      }
    }
    for (const m of this.meshes.values()) m.visible = false;
    if (!batches.size) return;
    for (const { st, b } of batches.values()) {
      const m = this.meshFor(st); m.visible = true;
      const geo = m.geometry;
      geo.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 4));
    }
    this.camera.left = -w / 2; this.camera.right = w / 2; this.camera.top = h / 2; this.camera.bottom = -h / 2; this.camera.updateProjectionMatrix();
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
  }
}
