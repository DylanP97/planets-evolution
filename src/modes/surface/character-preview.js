// Character preview: a small standalone three.js viewport that shows a
// CHARACTERS entry rotating in place — a completely separate
// renderer/scene/camera from the main app so browsing skins never touches
// the live avatar or its animation state. Two Character panels share this
// factory: the in-game pause menu (#surfaceCharacterPreview, wired from
// character-page.js) and the title-screen start menu
// (#startCharacterPreview, wired from ui/start-menu.js) — each gets its own
// independent renderer/cache/render-loop instance. If the model ships a
// wave/hello clip (fuzzy-matched, same convention as avatar.js's ASTRO_CLIPS)
// it plays once whenever that character is selected/hovered, settling back
// into idle (or just holding its last frame) when it finishes.
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as THREE from 'three';

// Recenter on the ground plane, normalize height, and wire up a mixer +
// fuzzy-matched clips so every character fills the same on-screen frame and
// (when it ships the clips) can wave hello on pick.
function buildPreviewEntry(gltf) {
  const model = gltf.scene;
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const h = size.y || 1;
  model.position.set(-center.x, -box.min.y, -center.z);
  const group = new THREE.Group();
  group.add(model);
  group.scale.setScalar(1.7 / h);

  let mixer = null;
  const actions = {};
  const anims = gltf.animations || [];
  if (anims.length) {
    mixer = new THREE.AnimationMixer(model);
    const pick = (...keys) => {
      for (const want of keys) {
        const w = want.toLowerCase();
        const c = anims.find(a => a.name && a.name.toLowerCase().includes(w));
        if (c) return c;
      }
      return null;
    };
    const idleClip = pick('idle', 'breath', 'stand', 'rest') || anims[0];
    const waveClip = pick('wave', 'hello', 'greet');
    if (idleClip) actions.idle = mixer.clipAction(idleClip);
    if (waveClip) {
      actions.wave = mixer.clipAction(waveClip);
      actions.wave.setLoop(THREE.LoopOnce, 1);
      actions.wave.clampWhenFinished = true;
    }
  }
  return { group, mixer, actions, current: null };
}

/** Build an independent preview viewport bound to the canvas at `canvasId`.
 *  Returns { show(character), start(), stop() }; a no-op stub if the canvas
 *  isn't in the DOM (e.g. this panel variant isn't present on this page). */
export function createCharacterPreview(canvasId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return { show() {}, start() {}, stop() {} };

  let renderer = null, scene = null, camera = null, rig = null, rafId = null;
  const loader = new GLTFLoader();
  const cache = new Map();   // character id -> preview entry ({ group, mixer, actions })
  let currentId = null;
  let activeEntry = null;
  let lastTickMs = null;

  function ensureScene() {
    if (renderer) return;
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(canvas.width, canvas.height, false);
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(32, 1, 0.05, 20);
    camera.position.set(0, 1.05, 3.4);
    camera.lookAt(0, 0.85, 0);
    scene.add(new THREE.HemisphereLight(0xdfefff, 0x1a1f28, 1.15));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(2, 3, 2);
    scene.add(key);
    rig = new THREE.Group();
    scene.add(rig);
  }

  function loadPreview(character) {
    if (cache.has(character.id)) return Promise.resolve(cache.get(character.id));
    return new Promise((resolve, reject) => {
      loader.load(character.url, (gltf) => {
        const entry = buildPreviewEntry(gltf);
        cache.set(character.id, entry);
        resolve(entry);
      }, undefined, reject);
    });
  }

  // Play the wave clip once (crossfading into idle when it finishes) so
  // picking/hovering a character reads as a little "hi" — falls back to a
  // plain idle loop, or nothing, for models that don't ship those clips.
  function greet(entry) {
    const { mixer, actions } = entry;
    if (!mixer) return;
    for (const k in actions) actions[k].stop();
    entry.current = null;
    const play = (action) => {
      if (!action || action === entry.current) return;
      action.reset().setEffectiveWeight(1).play();
      entry.current = action;
    };
    if (actions.wave) {
      play(actions.wave);
      mixer.addEventListener('finished', function onFinished() {
        mixer.removeEventListener('finished', onFinished);
        if (actions.idle) play(actions.idle);
      });
    } else if (actions.idle) {
      play(actions.idle);
    }
  }

  function show(character) {
    if (!character) return;
    ensureScene();
    currentId = character.id;
    loadPreview(character).then((entry) => {
      if (currentId !== character.id) return;   // selection moved on while this was loading
      rig.clear();
      rig.add(entry.group);
      activeEntry = entry;
      greet(entry);
    }).catch((err) => console.error('[character-preview]', canvasId, 'load failed:', character.id, character.url, err));
  }

  function tick() {
    rafId = requestAnimationFrame(tick);
    const now = performance.now();
    const dt = Math.min((now - lastTickMs) / 1000, 0.1);
    lastTickMs = now;
    if (rig) rig.rotation.y += 0.012;
    if (activeEntry && activeEntry.mixer) activeEntry.mixer.update(dt);
    if (renderer && scene && camera) renderer.render(scene, camera);
  }

  function start() {
    ensureScene();
    lastTickMs = performance.now();   // reset so a paused/hidden gap isn't fed to the mixer as one huge dt
    if (rafId == null) tick();
  }

  function stop() {
    if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
  }

  return { show, start, stop };
}
