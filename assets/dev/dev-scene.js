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
  { name: 'ice-cube.glb',       path: '../ice-cube.glb',       tag: 'prop' },
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

// Environment map (image-based lighting). Transmissive / reflective materials —
// the ice cube's refraction and every PBR asset's glints — have nothing to
// refract or mirror without one, so they render dark and flat.
//
// We use a bright, almost-uniform cold-sky GRADIENT rather than three's
// RoomEnvironment: that studio room has a dark ceiling + dark walls, which made
// the ice's top/bottom faces reflect black while the sides caught the light —
// faces that should look alike read very differently. A near-uniform sky lights
// all six faces consistently and previews closer to the bright arctic scene.
// (scene.environment only feeds reflections/refraction; the background stays the
// dark slider colour above so the model still reads against a neutral stage.)
const pmrem = new THREE.PMREMGenerator(renderer);
function makeSky() {
  const cv = document.createElement('canvas');
  cv.width = 8; cv.height = 256;
  const ctx = cv.getContext('2d');
  // A real sky→ground gradient with CONTRAST. A transparent object only looks
  // transparent when there's something varied behind it to refract — a flat
  // field makes ice read as a solid blob. The bright sky also lights the edges
  // (no black fringe) and the gradient distorting through the cube is what reads
  // as "see-through ice".
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0.0, '#a9ccf0'); // zenith — sky blue
  g.addColorStop(0.45, '#d6e7f6');
  g.addColorStop(0.55, '#eef3f8'); // bright horizon band
  g.addColorStop(1.0, '#c4cfda'); // ground — light cool grey
  ctx.fillStyle = g; ctx.fillRect(0, 0, 8, 256);
  const tex = new THREE.CanvasTexture(cv);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  const env = pmrem.fromEquirectangular(tex).texture;
  return { env, skyTex: tex }; // keep skyTex usable as a background skybox
}
const { env: skyEnv, skyTex } = makeSky();
scene.environment = skyEnv;

// Sky dome surrounding the scene, painted with the SAME gradient as the env.
// three.js's transmission pass refracts opaque geometry (a scene.background
// skybox isn't reliably captured), so this dome is what the ice "sees through" —
// and because it's a gradient, the refraction is visible = the cube looks
// transparent. (The flat-coloured version made it look like a solid blob.)
const skyDome = new THREE.Mesh(
  new THREE.SphereGeometry(80, 32, 16),
  new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, fog: false }),
);
scene.add(skyDome);

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
// Back/rim light — grazes the far edges; on ice it produces the bright cold
// rim that really sells the material.
const rimLight = new THREE.DirectionalLight(0xbfe0ff, 0.6);
rimLight.position.set(-4, 5, -9);
scene.add(rimLight);

// ---- Lighting controls (sidebar panel) ---------------------------------------
(function buildLightingPanel() {
  const sidebar = document.getElementById('sidebar');
  const foot = sidebar.querySelector('.side-foot');
  const sec = document.createElement('div');
  sec.className = 'side-section';
  sec.innerHTML = '<div class="section-title">Lighting</div>';
  const render = () => renderer.render(scene, camera);

  // Key light is positioned from elevation/azimuth so it can be swung around.
  const key = { elev: 52, azim: 38 };
  const setKeyPos = () => {
    const e = key.elev * Math.PI / 180, a = key.azim * Math.PI / 180, r = 12;
    keyLight.position.set(r * Math.cos(e) * Math.cos(a), r * Math.sin(e), r * Math.cos(e) * Math.sin(a));
  };
  setKeyPos();

  const slider = (label, min, max, step, value, on) => {
    const row = document.createElement('div');
    row.style.cssText = 'margin:9px 0;font-size:11px;color:var(--txt-dim)';
    row.innerHTML =
      `<div style="display:flex;justify-content:space-between"><span>${label}</span>`
      + '<span class="v" style="color:var(--txt);font-variant-numeric:tabular-nums"></span></div>'
      + `<input type="range" min="${min}" max="${max}" step="${step}" value="${value}"`
      + ' style="width:100%;accent-color:var(--accent)"/>';
    const inp = row.querySelector('input'), v = row.querySelector('.v');
    v.textContent = (+value).toFixed(2);
    inp.addEventListener('input', () => { const val = +inp.value; v.textContent = val.toFixed(2); on(val); render(); });
    sec.appendChild(row);
  };
  const color = (label, hex, on) => {
    const row = document.createElement('label');
    row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin:7px 0;font-size:12px;color:var(--txt)';
    row.innerHTML = `${label}<input type="color" value="${hex}" style="width:42px;height:24px;border:0;background:none;cursor:pointer"/>`;
    row.querySelector('input').addEventListener('input', (e) => { on(e.target.value); render(); });
    sec.appendChild(row);
  };

  slider('Exposure',        0, 2,   0.01, renderer.toneMappingExposure, (v) => { renderer.toneMappingExposure = v; });
  slider('Key intensity',   0, 5,   0.05, keyLight.intensity,           (v) => { keyLight.intensity = v; });
  slider('Key elevation°',  5, 90,  1,    key.elev,                     (v) => { key.elev = v; setKeyPos(); });
  slider('Key azimuth°',    0, 360, 1,    key.azim,                     (v) => { key.azim = v; setKeyPos(); });
  color('Key colour', '#ffffff', (hex) => keyLight.color.set(hex));
  slider('Fill intensity',  0, 3,   0.05, fillLight.intensity,          (v) => { fillLight.intensity = v; });
  slider('Rim intensity',   0, 3,   0.05, rimLight.intensity,           (v) => { rimLight.intensity = v; });
  slider('Hemisphere',      0, 3,   0.05, hemi.intensity,               (v) => { hemi.intensity = v; });

  sidebar.insertBefore(sec, foot);
})();

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
  captureIceRefs(current);
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

// ---- "Source material" box (collapsible thumbnails of the ice maps) ----------
// Documents the CC0 texture set baked into ice-cube.glb. `used` flags the maps
// actually embedded in the GLB; the rest are shown for reference.
const SOURCE_MATERIAL = {
  caption: 'ambientCG <a href="https://ambientcg.com/view?id=Ice001" target="_blank" '
    + 'rel="noopener">Ice001</a> · CC0 · 1K. Baked into <code>ice-cube.glb</code>.',
  maps: [
    { label: 'Color',     src: './ice-src/ice_color.jpg',     used: false },
    { label: 'Normal',    src: './ice-src/ice_normal.jpg',    used: true },
    { label: 'Roughness', src: './ice-src/ice_roughness.jpg', used: true },
    { label: 'Preview',   src: './ice-src/ice_preview.png',   used: false },
  ],
};

(function buildMaterialBox() {
  $('matCaption').innerHTML = SOURCE_MATERIAL.caption;
  const wrap = $('matMaps');
  // Inline layout so it doesn't depend on a possibly-cached stylesheet. The
  // minmax(0,…) is essential: plain 1fr columns inherit the 1024px image's
  // intrinsic width and blow the grid out sideways.
  wrap.style.cssText = 'display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px';
  SOURCE_MATERIAL.maps.forEach((m) => {
    const cell = document.createElement('div');
    cell.className = 'mat-map' + (m.used ? ' used' : '');
    cell.style.cssText = 'min-width:0;display:flex;flex-direction:column;gap:4px';
    cell.innerHTML =
      `<img src="${m.src}" alt="" style="display:block;width:100%;height:auto;`
      + `aspect-ratio:1;object-fit:cover;border-radius:6px;border:1px solid var(--line)" />`
      + `<span class="mat-label">${m.label}`
      + `${m.used ? '<span class="mat-flag">BAKED</span>' : ''}</span>`;
    wrap.appendChild(cell);
  });
})();

// ---- Live ice playground (toggles + sliders) ---------------------------------
// Drive the loaded ice-cube material in real time so you can dial the look in
// yourself instead of rebuilding the GLB. `captureIceRefs` grabs the material
// whenever ice-cube.glb loads and syncs every control to its current values.
let iceRefs = null; // { mat, normalMap, roughnessMap }

function captureIceRefs(root) {
  iceRefs = null;
  let mat = null;
  root.traverse((o) => {
    if (o.isMesh && o.material && o.material.transmission !== undefined
        && o.material.transmission > 0) mat = o.material;
  });
  if (mat) iceRefs = { mat, normalMap: mat.normalMap, roughnessMap: mat.roughnessMap };
  applyToggles();
  syncControlsFromMat();
}

// Checkboxes: things a slider can't express (presence of a map, the backdrop).
const TOGGLES = [
  { id: 'tNormal', label: 'Normal map', def: true,
    apply: (on) => { iceRefs.mat.normalMap = on ? iceRefs.normalMap : null; iceRefs.mat.needsUpdate = true; } },
  { id: 'tRough', label: 'Roughness map', def: true,
    apply: (on) => { iceRefs.mat.roughnessMap = on ? iceRefs.roughnessMap : null; iceRefs.mat.needsUpdate = true; } },
  { id: 'tSky', label: 'Sky backdrop', def: true, global: true,
    apply: (on) => { skyDome.visible = on; scene.background = on ? skyTex : bgColor; } },
];

// Sliders: live material (and one model-scale) parameters. `model:true` ones act
// on the loaded object instead of the material.
const SLIDERS = [
  { id: 'sTrans',  label: 'Transmission',    min: 0,   max: 1,    step: 0.01, get: (m) => m.transmission,       set: (m, v) => { m.transmission = v; } },
  { id: 'sRough',  label: 'Roughness',       min: 0,   max: 1,    step: 0.01, get: (m) => m.roughness,          set: (m, v) => { m.roughness = v; } },
  { id: 'sMetal',  label: 'Metalness',       min: 0,   max: 1,    step: 0.01, get: (m) => m.metalness,          set: (m, v) => { m.metalness = v; } },
  { id: 'sIor',    label: 'IOR',             min: 1,   max: 2.33, step: 0.01, get: (m) => m.ior,                set: (m, v) => { m.ior = v; } },
  { id: 'sThick',  label: 'Thickness',       min: 0,   max: 3,    step: 0.01, get: (m) => m.thickness,          set: (m, v) => { m.thickness = v; } },
  { id: 'sAtten',  label: 'Attenuation dist',min: 0.1, max: 10,   step: 0.1,  get: (m) => Math.min(m.attenuationDistance, 10), set: (m, v) => { m.attenuationDistance = v; } },
  { id: 'sCoat',   label: 'Clearcoat',       min: 0,   max: 1,    step: 0.01, get: (m) => m.clearcoat,          set: (m, v) => { m.clearcoat = v; } },
  { id: 'sCoatR',  label: 'Clearcoat rough', min: 0,   max: 1,    step: 0.01, get: (m) => m.clearcoatRoughness, set: (m, v) => { m.clearcoatRoughness = v; } },
  { id: 'sNormal', label: 'Normal scale',    min: 0,   max: 2,    step: 0.01, get: (m) => m.normalScale.x,      set: (m, v) => { m.normalScale.set(v, v); } },
  { id: 'sEnv',    label: 'Env intensity',   min: 0,   max: 3,    step: 0.01, get: (m) => m.envMapIntensity,    set: (m, v) => { m.envMapIntensity = v; } },
  { id: 'sScale',  label: 'Model scale',     min: 0.2, max: 3,    step: 0.01, model: true, get: () => (current ? current.scale.x : 1), set: (_, v) => { if (current) current.scale.setScalar(v); } },
];

const COLORS = [
  { id: 'cBase',  label: 'Base tint',    get: (m) => m.color,            },
  { id: 'cAtten', label: 'Attenuation',  get: (m) => m.attenuationColor, },
];

const toggleState = {};
const sliderEls = {}; // id -> { input, val, cfg }
const colorEls = {};  // id -> { input, cfg }

function applyToggles() {
  for (const t of TOGGLES) {
    if (t.global) { t.apply(toggleState[t.id]); continue; }
    if (iceRefs) t.apply(toggleState[t.id]);
  }
}

// Push the live material/object values back into every control so the panel
// always reflects what's actually loaded.
function syncControlsFromMat() {
  for (const id in sliderEls) {
    const { input, val, cfg } = sliderEls[id];
    if (!iceRefs && !cfg.model) continue;
    const v = cfg.get(iceRefs ? iceRefs.mat : null);
    input.value = v; val.textContent = Number(v).toFixed(2);
  }
  if (iceRefs) {
    for (const id in colorEls) {
      const { input, cfg } = colorEls[id];
      input.value = '#' + cfg.get(iceRefs.mat).getHexString();
    }
  }
}

(function buildControls() {
  const panel = $('matPanel');
  const section = (title) => {
    const d = document.createElement('div');
    d.style.cssText = 'margin-top:14px;padding-top:12px;border-top:1px solid var(--line)';
    d.innerHTML = `<div class="section-title" style="margin-bottom:8px">${title}</div>`;
    panel.appendChild(d);
    return d;
  };

  // Toggles.
  const tBox = section('Ingredients');
  TOGGLES.forEach((t) => {
    toggleState[t.id] = t.def;
    const lab = document.createElement('label');
    lab.className = 'toggle';
    lab.innerHTML = `<input type="checkbox" id="${t.id}" ${t.def ? 'checked' : ''}/> ${t.label}`;
    lab.querySelector('input').addEventListener('change', (e) => {
      toggleState[t.id] = e.target.checked;
      applyToggles();
      renderer.render(scene, camera);
    });
    tBox.appendChild(lab);
  });

  // Sliders.
  const sBox = section('Parameters');
  SLIDERS.forEach((cfg) => {
    const row = document.createElement('div');
    row.style.cssText = 'margin:9px 0;font-size:11px;color:var(--txt-dim)';
    row.innerHTML =
      `<div style="display:flex;justify-content:space-between"><span>${cfg.label}</span>`
      + `<span id="${cfg.id}v" style="color:var(--txt);font-variant-numeric:tabular-nums">–</span></div>`
      + `<input type="range" id="${cfg.id}" min="${cfg.min}" max="${cfg.max}" step="${cfg.step}"`
      + ` style="width:100%;accent-color:var(--accent)" />`;
    sBox.appendChild(row);
    const input = row.querySelector('input');
    const val = row.querySelector(`#${cfg.id}v`);
    sliderEls[cfg.id] = { input, val, cfg };
    input.addEventListener('input', () => {
      const v = +input.value;
      val.textContent = v.toFixed(2);
      if (cfg.model) cfg.set(null, v);
      else if (iceRefs) cfg.set(iceRefs.mat, v);
      renderer.render(scene, camera);
    });
  });

  // Colour pickers.
  const cBox = section('Colours');
  COLORS.forEach((cfg) => {
    const row = document.createElement('label');
    row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin:7px 0;font-size:12px;color:var(--txt)';
    row.innerHTML = `${cfg.label}<input type="color" id="${cfg.id}" style="width:42px;height:24px;border:0;background:none;cursor:pointer" />`;
    cBox.appendChild(row);
    const input = row.querySelector('input');
    colorEls[cfg.id] = { input, cfg };
    input.addEventListener('input', () => {
      if (iceRefs) { cfg.get(iceRefs.mat).set(input.value); renderer.render(scene, camera); }
    });
  });

  // Reset — reload the GLB to get the authored defaults back.
  const reset = document.createElement('button');
  reset.className = 'btn';
  reset.textContent = 'Reset to GLB defaults';
  reset.style.marginTop = '14px';
  reset.addEventListener('click', () => {
    const li = [...listEl.children].find((n) => n.textContent.includes('ice-cube.glb'));
    if (li) loadAsset({ name: 'ice-cube.glb', path: '../ice-cube.glb' }, li);
  });
  panel.appendChild(reset);
})();

const matToggle = $('matToggle');
const matPanel = $('matPanel');
matToggle.addEventListener('click', () => {
  const open = matToggle.getAttribute('aria-expanded') === 'true';
  matToggle.setAttribute('aria-expanded', String(!open));
  matPanel.hidden = open;
});
// Apply the default backdrop choice immediately (before any model loads).
applyToggles();
console.log('[dev-scene] BUILD material-box-v4 — toggles + live sliders wired');

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
