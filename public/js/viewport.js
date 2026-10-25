// 3D viewport: rendering, camera, picking, transform gizmo.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { TransformControls } from 'three/addons/TransformControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/CSS2DRenderer.js';
import { dataPath } from './api.js';
import { rotFromFl } from './formats/model.js';

const DEG = Math.PI / 180;
export const NAVMAP_SIZE = 240000; // full navmap width in metres at NavMapScale = 1

export class Viewport {
  constructor(el, app) {
    this.el = el; this.app = app;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.autoClear = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    el.appendChild(this.renderer.domElement);
    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = 'labels';
    el.appendChild(this.labels.domElement);

    this.scene = new THREE.Scene();
    this.world = new THREE.Group(); this.scene.add(this.world);
    this.helpers = new THREE.Group(); this.scene.add(this.helpers);
    this.bgScene = new THREE.Scene();
    this.bgCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 10000);

    this.persp = new THREE.PerspectiveCamera(50, 1, 2, 2e7);
    this.persp.position.set(0, 60000, 90000);
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -1e7, 1e7);
    this.ortho.up.set(0, 0, -1);
    this.camera = this.persp;

    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.enableDamping = true; this.orbit.dampingFactor = 0.12; this.orbit.screenSpacePanning = true;
    this.orbit.zoomToCursor = true; this.orbit.maxDistance = 3e6; this.orbit.minDistance = 5;
    this.orbit.zoomSpeed = 1.4;

    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.setSize(0.9);
    this.gizmoHelper = this.gizmo.getHelper();
    this.scene.add(this.gizmoHelper);
    this.pivot = new THREE.Object3D(); this.scene.add(this.pivot);
    this.gizmo.addEventListener('dragging-changed', (e) => this.onDragging(e.value));
    this.gizmo.addEventListener('objectChange', () => this.onGizmoChange());

    // lights
    this.ambient = new THREE.AmbientLight(0x334466, 1.0); this.scene.add(this.ambient);
    this.hemi = new THREE.HemisphereLight(0xdde6ff, 0x30343c, 1.1); this.scene.add(this.hemi);
    this.headlight = new THREE.DirectionalLight(0xffffff, 1.3); this.camera.add(this.headlight); this.headlight.position.set(0.3, 0.4, 1); this.headlight.target.position.set(0, 0, -1); this.camera.add(this.headlight.target); this.scene.add(this.persp); this.scene.add(this.ortho);
    this.systemLights = new THREE.Group(); this.scene.add(this.systemLights);

    this.grid = new THREE.GridHelper(400000, 40, 0x3a4660, 0x232a38);
    this.grid.material.transparent = true; this.grid.material.opacity = 0.5; this.grid.material.depthWrite = false;
    this.helpers.add(this.grid);
    this.navGrid = new THREE.Group(); this.helpers.add(this.navGrid);

    this.fieldRoot = new THREE.Group(); this.scene.add(this.fieldRoot);
    this.visuals = new Map(); // entityId -> Object3D
    this.selBoxes = new THREE.Group(); this.helpers.add(this.selBoxes);
    this.hpGroup = new THREE.Group(); this.helpers.add(this.hpGroup);
    this.keys = new Set();
    this.clock = new THREE.Clock();
    this.raycaster = new THREE.Raycaster();
    this.mode = 'translate';
    this.space = 'world';
    this.snap = false;

    const dom = this.renderer.domElement;
    dom.tabIndex = 0;
    let down = null;
    dom.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, b: e.button }; dom.focus(); });
    dom.addEventListener('pointerup', (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      if (moved < 5 && down.b === 0 && !this.gizmoDragged) this.onClick(e);
      if (moved < 5 && down.b === 2) this.app.onContextMenu(e, this.pick(e));
      down = null; this.gizmoDragged = false;
    });
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    dom.addEventListener('dblclick', (e) => { const h = this.pick(e); if (h) this.focus(h.id); });
    dom.addEventListener('pointermove', (e) => this.onHover(e));
    // render on demand: full rate while something happens, a few frames a second when idle, none while paused
    this.pauseCount = 0; this.lastActivity = performance.now();
    const poke = () => { this.lastActivity = performance.now(); };
    for (const ev of ['pointerdown', 'pointermove', 'wheel', 'keydown']) dom.addEventListener(ev, poke, { passive: true });
    window.addEventListener('resize', poke);
    this.orbit.addEventListener('change', poke);
    this.gizmo.addEventListener('change', poke);
    dom.addEventListener('keydown', (e) => { if (!e.ctrlKey && !e.metaKey && !e.altKey) this.keys.add(e.key.toLowerCase()); });
    dom.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    dom.addEventListener('blur', () => this.keys.clear());
    new ResizeObserver(() => this.resize()).observe(el);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h); this.labels.setSize(w, h);
    this.persp.aspect = w / h; this.persp.updateProjectionMatrix();
    this.bgCamera.aspect = w / h; this.bgCamera.updateProjectionMatrix();
    this.updateOrtho();
  }
  updateOrtho() {
    const w = this.el.clientWidth || 1, h = this.el.clientHeight || 1;
    const half = this.orthoHalf || 120000;
    this.ortho.left = -half * w / h; this.ortho.right = half * w / h; this.ortho.top = half; this.ortho.bottom = -half;
    this.ortho.updateProjectionMatrix();
  }

  // ---------- camera modes ----------
  setView(mode) {
    const target = this.orbit.target.clone();
    if (mode === 'top') {
      this.orthoHalf = this.orthoHalf || (NAVMAP_SIZE / 2 / (this.navScale || 1)) * 1.08;
      this.ortho.position.set(target.x, 500000, target.z); this.ortho.lookAt(target.x, 0, target.z);
      this.updateOrtho();
      this.camera = this.ortho;
      this.orbit.enableRotate = false;
    } else {
      this.camera = this.persp; this.orbit.enableRotate = true;
    }
    this.camera.add(this.headlight); this.camera.add(this.headlight.target);
    this.orbit.object = this.camera; this.gizmo.camera = this.camera;
    this.orbit.target.copy(target); this.orbit.update();
    this.view = mode;
    this.updateNavGrid();
  }

  frameAll() {
    const box = new THREE.Box3();
    for (const v of this.visuals.values()) if (v.userData.kind !== 'zone') box.expandByPoint(v.position);
    if (box.isEmpty()) box.set(new THREE.Vector3(-50000, 0, -50000), new THREE.Vector3(50000, 0, 50000));
    const c = box.getCenter(new THREE.Vector3()); const r = Math.max(box.getSize(new THREE.Vector3()).length() * 0.6, 20000);
    this.orbit.target.copy(c);
    if (this.camera === this.persp) this.persp.position.copy(c).add(new THREE.Vector3(0, r * 0.75, r * 0.95));
    else { this.ortho.position.set(c.x, 500000, c.z); this.orthoHalf = r * 0.8; this.ortho.zoom = 1; this.updateOrtho(); }
    this.orbit.update();
  }

  focus(id) {
    const v = this.visuals.get(id); if (!v) return;
    const r = Math.max(v.userData.radius || 500, 200);
    const target = v.getWorldPosition(new THREE.Vector3());
    this.animateTo(target, Math.min(Math.max(r * (v.userData.kind === 'zone' ? 2.2 : 4.5), 1200), 400000));
  }
  animateTo(target, dist) {
    const cam = this.camera;
    const from = this.orbit.target.clone();
    const dir = cam.position.clone().sub(from).normalize();
    if (this.camera === this.ortho) {
      this.orbit.target.copy(target); cam.position.set(target.x, 500000, target.z);
      this.orthoHalf = dist * 0.7; this.ortho.zoom = 1; this.updateOrtho(); this.orbit.update(); return;
    }
    const startPos = cam.position.clone();
    const endPos = target.clone().add(dir.multiplyScalar(dist));
    const t0 = performance.now(), dur = 450;
    this.anim = () => {
      const t = Math.min(1, (performance.now() - t0) / dur), k = 1 - Math.pow(1 - t, 3);
      this.orbit.target.lerpVectors(from, target, k); cam.position.lerpVectors(startPos, endPos, k);
      if (t >= 1) this.anim = null;
    };
  }

  // ---------- scene content ----------
  clear() {
    for (const v of this.visuals.values()) { dropLabels(v); this.world.remove(v); disposeOwned(v); }
    this.visuals.clear();
    this.gizmo.detach();
    this.selBoxes.clear(); dropLabels(this.hpGroup); this.hpGroup.clear();
    this.bgScene.clear();
    this.systemLights.clear();
  }
  setVisual(id, obj) {
    const old = this.visuals.get(id);
    if (old && old !== obj) { dropLabels(old); this.world.remove(old); disposeOwned(old); }
    this.visuals.set(id, obj); this.world.add(obj);
    this.applyFilters(obj);
  }
  removeVisual(id) { const v = this.visuals.get(id); if (v) { dropLabels(v); this.world.remove(v); disposeOwned(v); this.visuals.delete(id); } }

  async setBackground(doc) {
    this.bgScene.clear();
    const sec = doc.ini.first('SystemInfo');
    const sc = sec && sec.vals('space_color');
    this.spaceColor = sc ? new THREE.Color(...sc.map(x => parseFloat(x) / 255)) : new THREE.Color(0, 0, 0);
    const bg = doc.ini.first('Background');
    if (!bg) return;
    let order = 0;
    for (const key of ['basic_stars', 'complex_stars', 'nebulae']) {
      const f = bg.get(key); if (!f) { order++; continue; }
      const m = await this.app.rm.model(dataPath(f), [], { unlit: true });
      if (!m) { order++; continue; }
      m.traverse(o => { if (o.isMesh) { o.material = o.material.clone(); o.material.depthTest = false; o.material.depthWrite = false; o.material.fog = false; o.renderOrder = order; } });
      m.renderOrder = order++;
      this.bgScene.add(m);
    }
  }

  setLighting(doc) {
    this.systemLights.clear();
    const amb = doc.ini.first('Ambient');
    const c = amb && amb.vals('color');
    this.ambient.color = c ? new THREE.Color(...c.map(x => parseFloat(x) / 255)) : new THREE.Color(0.2, 0.2, 0.25);
    for (const l of doc.lights) {
      const col = (l.vals('color') || [255, 255, 255]).map(x => parseFloat(x) / 255);
      const p = l.vec('pos', [0, 0, 0]);
      const range = parseFloat(l.get('range') || '50000');
      const pl = new THREE.PointLight(new THREE.Color(...col), 2.2, range * 1.2, 0);
      pl.position.set(...p); pl.userData.sectionId = l.id;
      this.systemLights.add(pl);
    }
    this.applyLightingMode();
  }
  applyLightingMode() {
    const mode = this.app.settings.lighting;
    const editor = mode === 'editor';
    this.hemi.intensity = editor ? 1.3 : mode === 'system' ? 0.0 : 0.8;
    this.headlight.intensity = editor ? 1.4 : mode === 'system' ? 0 : 0.7;
    this.systemLights.visible = !editor;
    this.ambient.intensity = editor ? 0.3 : 1.2;
  }

  updateNavGrid() {
    dropLabels(this.navGrid); this.navGrid.clear();
    const show = this.app.settings.navgrid || this.view === 'top';
    this.navGrid.visible = show;
    this.grid.visible = this.app.settings.grid && !show;
    if (!show) return;
    const size = NAVMAP_SIZE / (this.navScale || 1), half = size / 2, step = size / 8;
    const pos = [];
    for (let i = 0; i <= 8; i++) {
      const t = -half + i * step;
      pos.push(t, 0, -half, t, 0, half, -half, 0, t, half, 0, t);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x5a7bb0, transparent: true, opacity: 0.55, depthWrite: false }));
    this.navGrid.add(lines);
    const letters = 'ABCDEFGH';
    for (let i = 0; i < 8; i++) {
      const mk = (txt, x, z) => { const d = document.createElement('div'); d.className = 'navlbl'; d.textContent = txt; const o = new CSS2DObject(d); o.position.set(x, 0, z); this.navGrid.add(o); };
      mk(letters[i], -half + step * (i + 0.5), -half - step * 0.12);
      mk(String(i + 1), -half - step * 0.12, -half + step * (i + 0.5));
    }
  }

  // ---------- filters ----------
  applyFilters(v) {
    const s = this.app.settings;
    const k = v.userData.kind;
    // eyes in the Outliner (kind → category → item, ui/visibility.js). A hidden zone or light that is selected is
    // still drawn so it can be found; a hidden selected object keeps its yellow selection box.
    const hidden = this.app.notShown ? this.app.notShown(v.userData.entityId) : false;
    v.visible = !hidden || (k !== 'object' && this.app.isSelected(v.userData.entityId));
    v.traverse(o => {
      if (o.userData.label) {
        const sel = this.app.isSelected(v.userData.entityId);
        o.visible = s.labels !== 'none' && (sel || (k === 'object' && (s.labels === 'all' ? true : (o.userData.important && !o.userData.tradelane))) || (k === 'zone' && s.labels === 'all') || (k === 'light' && s.labels === 'all'));
        if (o.element) o.element.classList.toggle('sel', sel);
      }
      if (o.userData.fieldDots) o.visible = s.fieldDots;
    });
  }
  applyAllFilters() { for (const v of this.visuals.values()) this.applyFilters(v); this.updateNavGrid(); this.applyHidden(); }
  // things drawn by other managers from an object/zone: planet rings, patrol/trade paths (fields: FieldManager.frame)
  applyHidden() {
    const hid = (id) => this.app.notShown && this.app.notShown(id);
    if (this.app.rings) for (const m of this.app.rings.group.children) if (m.userData.ids) m.visible = !m.userData.ids.some(hid);
    if (this.app.paths) for (const g of this.app.paths.group.children) if (g.userData.zoneIds) g.visible = !g.userData.zoneIds.every(hid);
  }

  // ---------- selection display ----------
  showSelection(ids) {
    this.selBoxes.clear(); dropLabels(this.hpGroup); this.hpGroup.clear();
    for (const v of this.visuals.values()) {
      const sel = ids.includes(v.userData.entityId);
      v.traverse(o => {
        if (o.userData.zoneWire) { o.material.opacity = sel ? 1 : 0.55; o.material.color.copy(sel ? new THREE.Color(1, 1, 0.5) : v.userData.color); }
        if (o.userData.zoneFill) o.material.opacity = sel ? 0.1 : (v.userData.cat === 'nebula' ? 0.07 : 0.035);
        if (o.userData.rangeRing) o.visible = sel;
        if (o.userData.marker) o.material.color.set(sel ? 0xffff66 : v.userData.color);
      });
      this.applyFilters(v);
      if (sel && v.userData.kind === 'object') {
        const content = v.children.find(c => c.userData.content);
        if (content) { const bh = new THREE.BoxHelper(content, 0xffe066); bh.material.depthTest = false; bh.material.transparent = true; bh.renderOrder = 20; bh.userData.target = content; this.selBoxes.add(bh); }
        if (this.app.settings.hardpoints && v.userData.hardpoints) {
          for (const h of v.userData.hardpoints) {
            const ax = new THREE.AxesHelper(Math.max(15, (v.userData.radius || 100) * 0.05));
            ax.position.copy(h.pos); ax.userData.follow = v;
            if (h.rot) { const rm = rotFromFl(h.rot); if (h.partMatrix) rm.premultiply(new THREE.Matrix4().extractRotation(h.partMatrix)); ax.quaternion.setFromRotationMatrix(rm); }
            const g = new THREE.Group(); g.add(ax); g.userData.follow = v; this.hpGroup.add(g);
            const d = document.createElement('div'); d.className = 'hplbl'; d.textContent = h.name; const lo = new CSS2DObject(d); lo.position.copy(h.pos); g.add(lo);
          }
        }
      }
    }
    this.attachGizmo(ids);
  }

  attachGizmo(ids) {
    const vs = ids.map(id => this.visuals.get(id)).filter(Boolean);
    if (!vs.length || this.mode === 'select') { this.gizmo.detach(); return; }
    const c = new THREE.Vector3(); vs.forEach(v => c.add(v.position)); c.divideScalar(vs.length);
    this.pivot.position.copy(c);
    if (vs.length === 1) this.pivot.quaternion.copy(vs[0].quaternion); else this.pivot.quaternion.identity();
    this.pivot.updateMatrixWorld(true);
    this.gizmo.attach(this.pivot);
    this.gizmo.setMode(this.mode);
    this.gizmo.setSpace(this.space);
    this.applySnap();
  }
  applySnap() {
    const s = this.app.settings;
    this.gizmo.setTranslationSnap(this.snap ? s.snapMove : null);
    this.gizmo.setRotationSnap(this.snap ? s.snapRot * DEG : null);
  }
  setMode(m) { this.mode = m; this.attachGizmo(this.app.selection); }

  onDragging(active) {
    this.orbit.enabled = !active;
    if (active) {
      this.gizmoDragged = true;
      this.dragStart = { pivotInv: this.pivot.matrixWorld.clone().invert(), items: this.app.selection.map(id => ({ id, v: this.visuals.get(id), m: this.visuals.get(id)?.matrix.clone() })).filter(x => x.v) };
    } else if (this.dragStart) {
      const items = this.dragStart.items; this.dragStart = null;
      this.app.commitTransforms(items.map(({ id, v }) => ({ id, pos: v.position.toArray(), rot: new THREE.Euler().setFromQuaternion(v.quaternion, 'ZYX').toArray().slice(0, 3).map(r => r / DEG) })));
    }
  }
  onGizmoChange() {
    if (!this.dragStart) return;
    this.pivot.updateMatrixWorld(true);
    const delta = this.pivot.matrixWorld.clone().multiply(this.dragStart.pivotInv);
    for (const { v, m } of this.dragStart.items) {
      const nm = delta.clone().multiply(m);
      nm.decompose(v.position, v.quaternion, v.scale);
      v.scale.set(1, 1, 1);
      v.rotation.setFromQuaternion(v.quaternion, 'ZYX');
    }
    this.app.onLiveTransform();
  }

  // ---------- picking ----------
  ndc(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }
  pick(e) {
    const p = this.ndc(e);
    this.raycaster.setFromCamera(p, this.camera);
    this.raycaster.params.Line.threshold = 0; this.raycaster.params.Points.threshold = 0;
    const meshes = [];
    for (const v of this.visuals.values()) {
      if (!v.visible || v.userData.kind !== 'object') continue;
      v.traverse(o => { if (o.isMesh && !o.userData.atmosphere && !o.userData.noPick && o.visible) meshes.push(o); });
    }
    const hits = this.raycaster.intersectObjects(meshes, false);
    if (hits.length) return { id: entityOf(hits[0].object), point: hits[0].point };
    // screen-space markers (objects + lights)
    const r = this.renderer.domElement.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    let best = null, bestD = 12;
    const tmp = new THREE.Vector3();
    for (const v of this.visuals.values()) {
      if (!v.visible || v.userData.kind === 'zone') continue;
      tmp.copy(v.position).project(this.camera);
      if (tmp.z > 1 || tmp.z < -1) continue;
      const sx = (tmp.x + 1) / 2 * r.width, sy = (1 - tmp.y) / 2 * r.height;
      const d = Math.hypot(sx - mx, sy - my);
      if (d < bestD) { bestD = d; best = v; }
    }
    if (best) return { id: best.userData.entityId, point: best.position.clone() };
    // zones: smallest zone under cursor
    const fills = [];
    for (const v of this.visuals.values()) if (v.visible && v.userData.kind === 'zone') v.traverse(o => { if (o.userData.zoneFill) fills.push(o); });
    const zh = this.raycaster.intersectObjects(fills, false);
    if (zh.length) {
      zh.sort((a, b) => (entityVisual(a.object).userData.radius || 0) - (entityVisual(b.object).userData.radius || 0));
      return { id: entityOf(zh[0].object), point: zh[0].point };
    }
    return null;
  }
  // point on y=0 plane (or along view) under the cursor, for placing new things
  groundPoint(e) {
    this.raycaster.setFromCamera(e ? this.ndc(e) : new THREE.Vector2(0, 0), this.camera);
    const pt = new THREE.Vector3();
    if (this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), pt) && pt.distanceTo(this.camera.position) < 1e6) return pt;
    return this.orbit.target.clone();
  }
  onClick(e) {
    if (this.clickHook) { this.clickHook.add(e); return; }
    if (this.pickHook && this.pickHook(e)) return;
    const h = this.pick(e);
    this.app.select(h ? h.id : null, e.shiftKey || e.ctrlKey || e.metaKey);
  }
  onHover(e) {
    if (this.hoverPending) return;
    this.hoverPending = true;
    requestAnimationFrame(() => {
      this.hoverPending = false;
      const pt = this.groundPoint(e);
      this.app.status.cursor(pt);
    });
  }

  // ---------- frame ----------
  poke() { this.lastActivity = performance.now(); }
  pause() { this.pauseCount++; }
  resume() { this.pauseCount = Math.max(0, this.pauseCount - 1); this.poke(); }
  frame() {
    try { this._frame(); }
    catch (e) {
      // one bad object/texture must not black out the view: report once, keep going
      const k = String(e && e.message); if (this._lastFrameErr !== k) { this._lastFrameErr = k; console.error('viewport frame failed', e); this.app.status && this.app.status.msg('3D view problem: ' + k + ' — the rest of the view keeps drawing', 'err'); }
      try { this.labels.render(this.scene, this.camera); } catch { }
    }
  }
  _frame() {
    if (this.pauseCount > 0) return;
    // idle (no input, camera animation, flying or dragging for 2 s): redraw 5× a second (effects keep moving, slower)
    { const now = performance.now(); if (!this.anim && !this.keys.size && !this.dragStart && now - this.lastActivity > 2000) { if (now - (this._lastIdle || 0) < 200) return; this._lastIdle = now; } }
    // a dialog covers the view (cutscene player, model editor… have their own renderers): redraw every 2 s
    if (document.querySelector('#modal-root .backdrop') || document.querySelector('#overlay:not(.hidden)')) { const now = performance.now(); if (now - (this._lastCovered || 0) < 2000) return; this._lastCovered = now; }
    const dt = Math.min(this.clock.getDelta(), 0.1);
    if (this.anim) this.anim();
    this.fly(dt);
    this.orbit.update();
    for (const b of this.selBoxes.children) b.update();
    for (const g of this.hpGroup.children) { const v = g.userData.follow; g.position.copy(v.position); g.quaternion.copy(v.quaternion); }
    const r = this.renderer;
    r.setClearColor(this.spaceColor || 0x000000, 1);
    r.clear();
    if (this.app.settings.starsphere && this.camera === this.persp && this.bgScene.children.length) {
      this.bgCamera.quaternion.copy(this.camera.quaternion);
      this.bgCamera.fov = this.persp.fov; this.bgCamera.updateProjectionMatrix();
      r.render(this.bgScene, this.bgCamera);
      r.clearDepth();
    }
    if (this.app.fields) { if (this.app.fields.group.parent !== this.fieldRoot) this.fieldRoot.add(this.app.fields.group); this.app.fields.frame(this.camera.position, dt); }
    if (this.app.fx) this.app.fx.frame(dt, this.camera);
    if (this.app.paths) { if (this.app.paths.group.parent !== this.fieldRoot) this.fieldRoot.add(this.app.paths.group); this.app.paths.frame(this.camera); }
    if (this.app.missionMap) this.app.missionMap.frame(this.camera);
    if (this.app.rings && this.app.rings.group.parent !== this.fieldRoot) this.fieldRoot.add(this.app.rings.group);
    r.render(this.scene, this.camera);
    if (this.app.sunOverlay) { const sz = r.getSize(this._sz || (this._sz = new THREE.Vector2())); this.app.sunOverlay.render(r, this.camera, sz.x, sz.y, dt); }
    this.labels.render(this.scene, this.camera);
  }
  fly(dt) {
    if (!this.keys.size || this.gizmo.dragging) return;
    const k = this.keys;
    const dist = this.camera.position.distanceTo(this.orbit.target);
    const speed = (k.has('shift') ? 4 : 1) * Math.max(dist, 2000) * 0.9 * dt;
    const fwd = new THREE.Vector3(); this.camera.getWorldDirection(fwd);
    if (this.camera === this.ortho) fwd.set(0, 0, -1);
    const right = new THREE.Vector3().crossVectors(fwd, this.camera.up).normalize();
    const up = this.camera === this.ortho ? new THREE.Vector3() : new THREE.Vector3(0, 1, 0);
    const mv = new THREE.Vector3();
    if (k.has('w')) mv.add(fwd); if (k.has('s')) mv.sub(fwd);
    if (k.has('d')) mv.add(right); if (k.has('a')) mv.sub(right);
    if (k.has('e')) mv.add(up); if (k.has('q')) mv.sub(up);
    if (!mv.lengthSq()) return;
    mv.normalize().multiplyScalar(speed);
    this.camera.position.add(mv); this.orbit.target.add(mv);
  }
}

// CSS2DRenderer only removes a label's DOM element when the label itself is removed,
// not when an ancestor is — so detach them explicitly before dropping any subtree.
// free the GPU buffers of a visual that left the scene; model parts shared with the ResourceManager cache are
// left alone (the cache frees them in trim()). Three.js re-uploads anything disposed if it is drawn again.
function disposeOwned(root) {
  root.traverse(o => {
    if (o.geometry && !o.geometry.userData.rmShared) o.geometry.dispose();
    for (const m of [].concat(o.material || [])) if (m && !m.userData.rmShared) { for (const k in m) if (m[k] && m[k].isTexture && !m[k].userData.rmShared) m[k].dispose(); m.dispose(); }
  });
}
function dropLabels(root) {
  root.traverse(o => { if (o.isCSS2DObject && o.element && o.element.parentNode) o.element.parentNode.removeChild(o.element); });
}

function entityVisual(o) { while (o && o.userData.entityId == null) o = o.parent; return o; }
function entityOf(o) { const v = entityVisual(o); return v ? v.userData.entityId : null; }
