/* The hero: the A in 3D. Two halves (white, gold) board together, then the A floats over its reflection in the rain. */
import * as THREE from 'three';
import { RoomEnvironment } from '/vendor/RoomEnvironment.js';

const LEFT = [[0, 544], [262, 0], [262, 232.55], [190.98, 380], [262, 380], [262, 436], [164.02, 436], [112, 544]];
function shapeOf(pts) {
  const s = new THREE.Shape();
  pts.forEach(([x, y], i) => { const X = (x - 262) / 272, Y = (272 - y) / 272; i ? s.lineTo(X, Y) : s.moveTo(X, Y); });
  s.closePath(); return s;
}
const ease = t => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 4);

export function hero3d(host, { reduced = false } = {}) {
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' }); }
  catch (e) { return null; }
  const small = innerWidth < 760;
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, small ? 1.5 : 1.75));
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  host.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  if ('environmentIntensity' in scene) scene.environmentIntensity = 0.9;
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  camera.position.set(0, 0.32, 6.4); camera.lookAt(0, 0.02, 0);

  // the two halves
  const geo = pts => {
    const g = new THREE.ExtrudeGeometry(shapeOf(pts), { depth: 0.36, bevelEnabled: true, bevelThickness: 0.035, bevelSize: 0.024, bevelSegments: 5, curveSegments: 1 });
    g.translate(0, 0, -0.18); g.computeVertexNormals(); return g;
  };
  const white = new THREE.MeshPhysicalMaterial({ color: 0xf1ede4, roughness: 0.34, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.12 });
  const gold = new THREE.MeshPhysicalMaterial({ color: 0xd8ab55, roughness: 0.22, metalness: 1, clearcoat: 0.5, clearcoatRoughness: 0.18 });
  const A = new THREE.Group();
  const L = new THREE.Mesh(geo(LEFT), white);
  const R = new THREE.Mesh(geo(LEFT.map(([x, y]) => [524 - x, y])), gold);
  A.add(L, R); scene.add(A);
  // reflection: a mirrored, dimmed copy under a fading floor
  const refl = new THREE.Group();
  const dim = m => { const c = m.clone(); c.transparent = true; c.opacity = 0.2; c.depthWrite = false; return c; };
  const L2 = new THREE.Mesh(L.geometry, dim(white)), R2 = new THREE.Mesh(R.geometry, dim(gold));
  refl.add(L2, R2); refl.scale.y = -1; scene.add(refl);
  const line = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 0.004), new THREE.MeshBasicMaterial({ color: 0xd8b36a, transparent: true, opacity: 0.35 }));
  line.position.set(0, -1.075, 0.6); line.rotation.x = -Math.PI / 2; scene.add(line);

  // lights
  scene.add(new THREE.AmbientLight(0xffffff, 0.12));
  const key = new THREE.DirectionalLight(0xfff3e0, 2.2); key.position.set(-3, 4, 5); scene.add(key);
  const rim = new THREE.DirectionalLight(0xf0c878, 0); rim.position.set(3, 2, -4); scene.add(rim);
  const fill = new THREE.PointLight(0xd8b36a, 4, 9, 2); fill.position.set(1.8, -0.6, 2.4); scene.add(fill);

  // the flood: thin rain behind, gold dust around
  const RAIN = small ? 220 : 520;
  const rp = new Float32Array(RAIN * 6), rv = new Float32Array(RAIN);
  for (let i = 0; i < RAIN; i++) {
    const x = (Math.random() - 0.5) * 12, y = Math.random() * 7 - 2.5, z = -1.5 - Math.random() * 4, l = 0.12 + Math.random() * 0.22;
    rp.set([x, y, z, x - 0.02, y - l, z], i * 6); rv[i] = 2.4 + Math.random() * 2.6;
  }
  const rainGeo = new THREE.BufferGeometry(); rainGeo.setAttribute('position', new THREE.BufferAttribute(rp, 3));
  const rain = new THREE.LineSegments(rainGeo, new THREE.LineBasicMaterial({ color: 0xbdb7ab, transparent: true, opacity: 0.16 }));
  scene.add(rain);
  const DUST = small ? 60 : 140;
  const dp = new Float32Array(DUST * 3), dv = new Float32Array(DUST);
  for (let i = 0; i < DUST; i++) { dp.set([(Math.random() - 0.5) * 4, Math.random() * 3 - 1, (Math.random() - 0.5) * 2], i * 3); dv[i] = 0.06 + Math.random() * 0.18; }
  const dustGeo = new THREE.BufferGeometry(); dustGeo.setAttribute('position', new THREE.BufferAttribute(dp, 3));
  const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({ color: 0xf0d595, size: 0.018, transparent: true, opacity: 0.7, depthWrite: false, blending: THREE.AdditiveBlending }));
  scene.add(dust);

  // sizing + loop
  const resize = () => { const w = host.clientWidth || 1, h = host.clientHeight || 1; renderer.setSize(w, h, false); camera.aspect = w / h; camera.fov = w / h < 0.9 ? 38 : 30; camera.updateProjectionMatrix(); };
  resize(); new ResizeObserver(resize).observe(host);
  let mx = 0, my = 0, tx = 0, ty = 0, vis = true, sy = 0;
  addEventListener('pointermove', e => { if (e.pointerType === 'touch') return; tx = e.clientX / innerWidth - 0.5; ty = e.clientY / innerHeight - 0.5; }, { passive: true });
  addEventListener('scroll', () => { sy = scrollY; }, { passive: true });
  if ('IntersectionObserver' in window) new IntersectionObserver(es => { vis = es[0].isIntersecting; }).observe(host);
  const t0 = performance.now(); let last = t0, joined = false;
  const tick = now => {
    requestAnimationFrame(tick);
    if (!vis || document.hidden) { last = now; return; }
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    const t = (now - t0) / 1000;
    mx += (tx - mx) * 0.05; my += (ty - my) * 0.05;
    // intro: the halves slide in from either side and lock together
    const k = reduced ? 1 : ease((t - 0.25) / 1.7);
    L.position.x = -1.15 * (1 - k); R.position.x = 1.15 * (1 - k);
    L.rotation.y = 0.9 * (1 - k); R.rotation.y = -0.9 * (1 - k);
    L.position.y = R.position.y = -0.25 * (1 - k);
    if (!joined && k > 0.995) { joined = true; rim.intensity = 7; }
    rim.intensity += (1.6 - rim.intensity) * 0.04;
    const scrollK = Math.min(1, sy / innerHeight);
    A.rotation.y = (reduced ? 0 : Math.sin(t * 0.45) * 0.28) + mx * 0.55 + scrollK * 0.9;
    A.rotation.x = my * 0.12 - scrollK * 0.08;
    A.position.y = 0.08 + Math.sin(t * 0.9) * 0.035 + scrollK * 0.35;
    refl.rotation.copy(A.rotation); refl.rotation.x = -A.rotation.x;
    L2.position.copy(L.position); R2.position.copy(R.position); L2.rotation.copy(L.rotation); R2.rotation.copy(R.rotation);
    L2.position.y = -L.position.y; R2.position.y = -R.position.y;
    refl.position.y = -2.16 - A.position.y + 0.08;
    // rain + dust
    const p = rainGeo.attributes.position.array;
    for (let i = 0; i < RAIN; i++) {
      const o = i * 6, d = rv[i] * dt;
      p[o + 1] -= d; p[o + 4] -= d;
      if (p[o + 4] < -2.6) { const l = p[o + 1] - p[o + 4]; p[o + 1] = 4.4 + Math.random(); p[o + 4] = p[o + 1] - l; }
    }
    rainGeo.attributes.position.needsUpdate = true;
    const q = dustGeo.attributes.position.array;
    for (let i = 0; i < DUST; i++) { q[i * 3 + 1] += dv[i] * dt; q[i * 3] += Math.sin(t + i) * 0.0008; if (q[i * 3 + 1] > 2.2) q[i * 3 + 1] = -1; }
    dustGeo.attributes.position.needsUpdate = true;
    renderer.render(scene, camera);
  };
  requestAnimationFrame(tick);
  return { renderer };
}
