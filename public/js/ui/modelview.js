// Small reusable 3D model viewer (orbit, headlight, optional hardpoint markers + labels).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { h } from './dom.js';

export function modelViewer(app, { height = '320px' } = {}) {
  const canvas = h('canvas', { style: { width: '100%', height: '100%', display: 'block', borderRadius: '6px', background: 'var(--well)' } });
  const labels = h('div', { style: { position: 'absolute', inset: '0', pointerEvents: 'none', overflow: 'hidden' } });
  const el = h('div', { style: { position: 'relative', height } }, canvas, labels);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(40, 1, 0.1, 1e7);
  scene.add(new THREE.AmbientLight(0x778899, 1.3)); const sun = new THREE.DirectionalLight(0xffffff, 1.7); camera.add(sun); sun.position.set(0.4, 0.6, 1); scene.add(camera);
  const orbit = new OrbitControls(camera, canvas); orbit.enableDamping = true;
  let model = null, marks = [], running = true, highlight = new Set();
  const resize = () => { const r = el.getBoundingClientRect(); if (!r.width) return; renderer.setSize(r.width, r.height, false); camera.aspect = r.width / r.height; camera.updateProjectionMatrix(); };
  const ro = new ResizeObserver(resize); ro.observe(el);
  const v = new THREE.Vector3();
  (function loop() {
    if (!running) return; orbit.update(); renderer.render(scene, camera);
    const r = el.getBoundingClientRect();
    for (const mk of marks) { v.copy(mk.pos).project(camera); const vis = v.z < 1; mk.el.style.display = vis ? '' : 'none'; mk.el.style.left = ((v.x + 1) / 2 * r.width) + 'px'; mk.el.style.top = ((1 - v.y) / 2 * r.height) + 'px'; mk.el.style.color = highlight.has(mk.name.toLowerCase()) ? '#ffe066' : '#9fb6cc'; }
    requestAnimationFrame(loop);
  })();
  const api = {
    el,
    async load(path, matLibs = [], { showHardpoints = true } = {}) {
      if (model) scene.remove(model); labels.innerHTML = ''; marks = [];
      model = path ? await app.rm.model(path, matLibs) : null;
      if (!model) { labels.append(h('div', { style: { position: 'absolute', left: '10px', top: '10px', color: '#888' } }, path ? 'model not found' : 'no model')); return null; }
      scene.add(model);
      const R = model.userData.radius || 10, c = model.userData.center || new THREE.Vector3();
      orbit.target.copy(c); camera.position.copy(c).add(new THREE.Vector3(R * 1.4, R * 0.8, R * 1.8)); orbit.update();
      if (showHardpoints) for (const hp of model.userData.hardpoints || []) {
        const d = h('div', { style: { position: 'absolute', transform: 'translate(-50%, -50%)', fontSize: '10px', whiteSpace: 'nowrap', textShadow: '0 0 3px #000' } }, '● ' + hp.name);
        labels.append(d); marks.push({ pos: hp.pos.clone(), el: d, name: hp.name });
      }
      return model;
    },
    setHighlight(names) { highlight = new Set(names.map(n => n.toLowerCase())); },
    hardpoints() { return model ? (model.userData.hardpoints || []).map(h => h.name) : []; },
    dispose() { running = false; ro.disconnect(); renderer.dispose(); },
  };
  return api;
}
