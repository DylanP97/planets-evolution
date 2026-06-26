// Asset Library — standalone dev scene controller.
//
// This file is intentionally independent of src/ : it shares no imports with
// the main app, only the GLB files in the parent folder (../*.glb). Its job is
// to load one model at a time, frame it, light it, and report its stats so we
// can iterate on assets in isolation.
//
// To register a new model: add an entry to ASSETS (path is relative to this
// file, i.e. the GLBs sit one level up in assets/). Or drag-and-drop a .glb
// onto the page for a throwaway preview.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ---- Asset registry (path relative to assets/dev/, so ../ === assets/) -------
const ASSETS = [
  { name: 'character.glb',      path: '../character.glb',      tag: 'avatar' },
  { name: 'satellite.glb',      path: '../satellite.glb',      tag: 'probe' },
  { name: 'tree.glb',           path: '../tree.glb',           tag: 'prop' },
  { name: 'pine.glb',           path: '../pine.glb',           tag: 'prop' },
  { name: 'palm.glb',           path: '../palm.glb',           tag: 'prop' },
  { name: 'rock.glb',           path: '../rock.glb',           tag: 'prop' },
  { name: 'fern.glb',           path: '../fern.glb',           tag: 'prop' },
  { name: 'jungle-bush.glb',    path: '../jungle-bush.glb',    tag: 'prop' },
  { name: 'jungle-flowers.glb', path: '../jungle-flowers.glb', tag: 'prop' },
  { name: 'fish.glb',           path: '../fish.glb',           tag: 'fauna' },
];

// ---- DOM ---------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const canvas = $('c');
const stage = $('stage');
const listEl = $('assetList');
const clipSelect = $('clipSelect');
const statusEl = $('status');

// ---- Renderer / scene / camera ----------------------------------------------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();
const bgColor = new THREE.Color();
scene.background = bgColor;

const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 5000);
camera.position.set(3, 2, 5);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

// ---- Lighting ----------------------------------------------------------------
const hemi = new THREE.HemisphereLight(0xcfe4ff, 0x202832, 0.6);
scene.add(hemi);
const keyLight = new THREE.DirectionalLight(0xffffff, 1.3);
keyLight.position.set(5, 8, 6);
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0x88aaff, 0.5);
fillLight.position.set(-6, 3, -4);
scene.add(fillLight);

// ---- Helpers (grid + axes) ---------------------------------------------------
const grid = new THREE.GridHelper(20, 20, 0x223047, 0x182230);
grid.material.transparent = true;
grid.material.opacity = 0.6;
const axes = new THREE.AxesHelper(2);
const helperGroup = new THREE.Group();
helperGroup.add(grid, axes);
scene.add(helperGroup);

const boxHelper = new THREE.Box3Helper(new THREE.Box3(), 0x4fd1c5);
boxHelper.visible = false;
scene.add(boxHelper);

// ---- Model state -------------------------------------------------------------
const loader = new GLTFLoader();
const clock = new THREE.Clock();
let current = null;        // THREE.Object3D currently displayed
let mixer = null;          // AnimationMixer for the current model
let clips = [];            // AnimationClip[]
let wireframe = false;

function clearCurrent() {
  if (mixer) { mixer.stopAllAction(); mixer = null; }
  if (current) {
    scene.remove(current);
    current.traverse((o) => {
      if (o.isMesh) {
        o.geometry?.dispose();
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m) => m?.dispose());
      }
    });
    current = null;
  }
  clips = [];
}

// Bounding box that survives skinned meshes. Box3.setFromObject() reads the
// raw (un-skinned) geometry positions, which for a rig like character.glb are
// stored in the bones' inflated bind space (RobotArmature is scaled ×100) — so
// it reports a box ~100× too big and off-origin. For skinned meshes we instead
// take the box of the posed skeleton's bone world-positions (the real visual
// extent); plain meshes still use the cheap geometry path.
const _bonePos = new THREE.Vector3();
function computeBounds(obj, target) {
  obj.updateMatrixWorld(true);
  const box = (target || new THREE.Box3()).makeEmpty();
  let sawSkinned = false;
  obj.traverse((o) => {
    if (o.isSkinnedMesh && o.skeleton) {
      sawSkinned = true;
      o.skeleton.bones.forEach((b) => box.expandByPoint(b.getWorldPosition(_bonePos)));
    } else if (o.isMesh) {
      box.expandByObject(o);
    }
  });
  // Bones sit inside the mesh surface — pad a little so the silhouette fits.
  if (sawSkinned && !box.isEmpty()) {
    const pad = box.getSize(_bonePos).length() * 0.06;
    box.expandByScalar(pad);
  }
  return box;
}

// Frame the model: center it on the origin, rest it on the grid, and pull the
// camera back so the whole bounding sphere fits the 45° view.
function frameModel(obj) {
  const box = computeBounds(obj);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  // Recenter horizontally; sit the base on y=0.
  obj.position.x -= center.x;
  obj.position.z -= center.z;
  obj.position.y -= box.min.y;

  const radius = size.length() * 0.5 || 1;
  const dist = radius / Math.sin((camera.fov * Math.PI) / 180 / 2) * 1.15;
  camera.position.set(dist * 0.6, size.y * 0.55 + radius * 0.4, dist);
  controls.target.set(0, size.y * 0.5, 0);
  controls.update();

  // Scale grid/axes to the model so tiny and huge assets both read well.
  const s = Math.max(0.2, Math.min(radius, 50));
  helperGroup.scale.setScalar(s / 10);
  axes.scale.setScalar(10);

  return { box, size };
}

function applyWireframe() {
  if (!current) return;
  current.traverse((o) => {
    if (o.isMesh) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => { if (m) m.wireframe = wireframe; });
    }
  });
}

function modelStats(obj) {
  let meshes = 0, verts = 0, tris = 0;
  const mats = new Set();
  obj.traverse((o) => {
    if (o.isMesh) {
      meshes++;
      const g = o.geometry;
      const n = g.attributes.position ? g.attributes.position.count : 0;
      verts += n;
      tris += g.index ? g.index.count / 3 : n / 3;
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      ms.forEach((m) => m && mats.add(m.uuid));
    }
  });
  return { meshes, verts, tris: Math.round(tris), mats: mats.size };
}

function setInfo(name, obj, size, nClips) {
  const s = modelStats(obj);
  $('infoName').textContent = name;
  $('infoSize').textContent = `${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)}`;
  $('infoMeshes').textContent = s.meshes;
  $('infoVerts').textContent = s.verts.toLocaleString();
  $('infoTris').textContent = s.tris.toLocaleString();
  $('infoMats').textContent = s.mats;
  $('infoClips').textContent = nClips;
}

// ---- Load (from URL or an ArrayBuffer for drag-drop) -------------------------
function showModel(gltf, label) {
  clearCurrent();
  current = gltf.scene || gltf.scenes[0];
  scene.add(current);

  const { size } = frameModel(current);
  applyWireframe();

  clips = gltf.animations || [];
  populateClips();
  if (clips.length) {
    mixer = new THREE.AnimationMixer(current);
    mixer.clipAction(clips[0]).play();
    clipSelect.value = '0';
  }

  computeBounds(current, boxHelper.box);
  setInfo(label, current, size, clips.length);
  statusEl.textContent = '';
}

function loadAsset(asset, li) {
  statusEl.textContent = 'Loading…';
  [...listEl.children].forEach((n) => n.classList.toggle('active', n === li));
  loader.load(
    asset.path,
    (gltf) => showModel(gltf, asset.name),
    undefined,
    (err) => {
      const tried = new URL(asset.path, document.baseURI).href;
      console.error('[dev-scene] failed to load', tried, err);
      // A 404 whose URL has no /assets/ segment means the static server's root
      // is assets/dev/ — the .glb files live one level up and are unreachable.
      const rootHint = !tried.includes('/assets/')
        ? ' — server root looks wrong: serve the project root and open /assets/dev/'
        : '';
      statusEl.textContent = `404 ${asset.name}${rootHint}`;
    },
  );
}

function loadFromBuffer(buffer, label) {
  statusEl.textContent = 'Parsing…';
  [...listEl.children].forEach((n) => n.classList.remove('active'));
  loader.parse(buffer, '', (gltf) => showModel(gltf, label),
    (err) => {
      console.error('[dev-scene] parse failed', err);
      statusEl.textContent = 'Could not parse dropped file';
    });
}

function populateClips() {
  clipSelect.innerHTML = '';
  if (!clips.length) {
    clipSelect.innerHTML = '<option>—</option>';
    clipSelect.disabled = true;
    return;
  }
  clipSelect.disabled = false;
  clips.forEach((c, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = c.name || `clip ${i}`;
    clipSelect.appendChild(opt);
  });
}

// ---- Sidebar list ------------------------------------------------------------
ASSETS.forEach((asset) => {
  const li = document.createElement('li');
  li.innerHTML = `<span>${asset.name}</span><span class="tag">${asset.tag}</span>`;
  li.addEventListener('click', () => loadAsset(asset, li));
  listEl.appendChild(li);
});

// ---- Controls wiring ---------------------------------------------------------
clipSelect.addEventListener('change', () => {
  if (!mixer || !clips.length) return;
  mixer.stopAllAction();
  mixer.clipAction(clips[+clipSelect.value]).reset().play();
});

$('optGrid').addEventListener('change', (e) => { helperGroup.visible = e.target.checked; });
$('optWire').addEventListener('change', (e) => { wireframe = e.target.checked; applyWireframe(); });
$('optSpin').addEventListener('change', (e) => { controls.autoRotate = e.target.checked; });
$('optBox').addEventListener('change', (e) => {
  boxHelper.visible = e.target.checked;
  if (current) computeBounds(current, boxHelper.box);
});
$('optBg').addEventListener('input', (e) => {
  const v = e.target.value / 100;
  bgColor.setRGB(v * 0.5, v * 0.55, v * 0.7);
});
$('optLight').addEventListener('input', (e) => {
  const v = e.target.value / 100;
  keyLight.intensity = 1.3 * v;
  fillLight.intensity = 0.5 * v;
  hemi.intensity = 0.6 * v;
});
$('resetCam').addEventListener('click', () => { if (current) frameModel(current); });

controls.autoRotateSpeed = 2.0;
bgColor.setRGB(0.045, 0.05, 0.064); // matches default slider (9%)

// ---- Drag and drop -----------------------------------------------------------
['dragenter', 'dragover'].forEach((ev) =>
  stage.addEventListener(ev, (e) => { e.preventDefault(); stage.classList.add('dragging'); }));
['dragleave', 'drop'].forEach((ev) =>
  stage.addEventListener(ev, (e) => { e.preventDefault(); stage.classList.remove('dragging'); }));
stage.addEventListener('drop', (e) => {
  const file = e.dataTransfer?.files?.[0];
  if (!file || !file.name.toLowerCase().endsWith('.glb')) {
    statusEl.textContent = 'Drop a .glb file';
    return;
  }
  file.arrayBuffer().then((buf) => loadFromBuffer(buf, file.name));
});

// ---- Resize + render loop ----------------------------------------------------
function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  if (mixer) mixer.update(dt);
  if (boxHelper.visible && current) computeBounds(current, boxHelper.box);
  controls.update();
  renderer.render(scene, camera);
}
animate();

// Load the first asset so the scene isn't empty on open.
if (ASSETS.length) loadAsset(ASSETS[0], listEl.children[0]);
