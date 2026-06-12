import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as THREE from 'three';
import { scene } from '../../core/scene.js';
import { surfaceState } from './core.js';

// ── Astronaut character ────────────────────────────────────────────────
// A GLB drives the surface avatar. It loads once and is re-parented to the
// scene for each visit (only one surface session is ever active). The model
// is character.glb (the three.js RobotExpressive explorer): fully colored
// materials and a complete clip set — Idle/Walking/Running/Jump plus emotes
// like Wave. Clip names are fuzzy-matched, so any rigged+animated GLB
// (e.g. a Mixamo export) can be dropped in as a replacement; an UNRIGGED
// static mesh falls back to procedural bob + lean so it still reads as
// moving. (astronaut.glb is the old model: textured but missing a Jump
// clip, which is why jumps used to freeze in the idle pose.)
export const ASTRO_MODEL_URL = 'character.glb';
export const ASTRO_CLIPS = { idle: 'Idle', walk: 'Walking', run: 'Running', jump: 'Jump' };
// The model's local forward axis. Flip sign if the avatar faces the camera
// instead of showing its back. RobotExpressive faces +Z, so we use +1
// (Soldier.glb-style models face -Z and would need -1).
export const ASTRO_FACING = 1;
export const ASTRO_TURN_RATE = 10;            // how fast the avatar swivels to face its heading
export const ASTRO_FADE = 0.18;               // animation crossfade seconds
export const ASTRO_HEIGHT_FACTOR = 0.9;       // avatar height as a fraction of eye height (tune the visual size)

export let astronaut = null;                  // { root, inner, mixer, actions, animated, footOffset, nativeHeight }
export let astronautLoading = null;

export function loadAstronaut() {
  if (astronaut) return Promise.resolve(astronaut);
  if (astronautLoading) return astronautLoading;
  const loader = new GLTFLoader();
  astronautLoading = new Promise((resolve, reject) => {
    loader.load(ASTRO_MODEL_URL, (gltf) => {
      const inner = gltf.scene;
      // Re-seat so the model's feet sit at the pivot origin and it's centred
      // on X/Z. These offsets are in native model units; the pivot's scale
      // (set per visit) shrinks the whole thing to human size on the body.
      // updateMatrixWorld FIRST so the bbox includes the rig's nested node
      // scales — otherwise the measured height is wrong and scaling breaks.
      inner.updateMatrixWorld(true);
      const bbox = new THREE.Box3().setFromObject(inner);
      const size = bbox.getSize(new THREE.Vector3());
      const center = bbox.getCenter(new THREE.Vector3());
      const footOffset = new THREE.Vector3(-center.x, -bbox.min.y, -center.z);
      inner.position.copy(footOffset);
      inner.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = true;
        o.frustumCulled = false;       // tiny on-screen; culling math gets twitchy at this scale
        // A dim self-glow so the avatar stays readable on the night side,
        // where the Sun PointLight doesn't reach.
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m) => {
          // Dim neutral fill so the avatar stays faintly visible on the night
          // side without washing out under daylight.
          if (m && m.emissive) { m.emissive.setHex(0x222428); m.emissiveIntensity = 1.0; }
        });
      });
      // Arm bones for the procedural swim stroke: the clip set has no swim
      // animation and the walk clip barely moves the arms (~0.1 quaternion
      // range), so updateAstronaut windmills these AFTER the mixer writes
      // each frame. Fuzzy name match ("UpperArm.L" / "UpperArmL" / "upper_arm.R"…).
      const armBones = { L: null, R: null };
      inner.traverse((o) => {
        const n = (o.name || '').toLowerCase().replace(/[^a-z]/g, '');
        if (!n.includes('upperarm')) return;
        if (n.endsWith('l')) armBones.L = o;
        else if (n.endsWith('r')) armBones.R = o;
      });
      const pivot = new THREE.Group();
      pivot.add(inner);
      // Build a mixer only if the model actually ships clips. We fuzzy-match
      // clip names (case-insensitive substring) so most rigged models from
      // Mixamo/Sketchfab/etc. "just work" without manual renaming. Exact
      // ASTRO_CLIPS names are tried first as a hint.
      const actions = {};
      let mixer = null;
      if (gltf.animations && gltf.animations.length) {
        mixer = new THREE.AnimationMixer(inner);
        const anims = gltf.animations;
        const pick = (...keys) => {
          for (const want of keys) {
            const w = want.toLowerCase();
            const c = anims.find(a => a.name && a.name.toLowerCase().includes(w));
            if (c) return c;
          }
          return null;
        };
        const clips = {
          idle: pick(ASTRO_CLIPS.idle, 'idle', 'breath', 'stand', 'rest') || anims[0],
          walk: pick(ASTRO_CLIPS.walk, 'walk'),
          run:  pick(ASTRO_CLIPS.run, 'run', 'sprint', 'jog'),
          jump: pick(ASTRO_CLIPS.jump, 'jump', 'leap'),
          swim: pick('swim', 'paddle', 'tread', 'breaststroke'),
          wave: pick('wave', 'hello', 'greet'),
        };
        for (const key in clips) {
          if (clips[key]) actions[key] = mixer.clipAction(clips[key]);
        }
        // One-shots: a jump plays once and freezes on its last frame until
        // landing flips the state; the landing wave plays once then settles
        // into idle via the mixer's 'finished' event below.
        for (const key of ['jump', 'wave']) {
          if (actions[key]) {
            actions[key].setLoop(THREE.LoopOnce, 1);
            actions[key].clampWhenFinished = true;
          }
        }
        mixer.addEventListener('finished', () => {
          if (!astronaut) return;
          astronaut.oneShot = false;
          // Airborne: hold the jump clip clamped on its final frame; the
          // state machine crossfades out on touchdown.
          if (surfaceState.animName === 'jump') return;
          crossfadeAstronautTo(resolveAstronautAction(surfaceState.animName));
        });
      }
      // "Animated" = we have at least a stand or walk clip to drive.
      const animated = !!(actions.idle || actions.walk);
      // Soft blob shadow at the feet: the sun's cube shadow map covers the
      // whole system and can't resolve a centimetre-scale figure, so a
      // radial-gradient disc does the grounding instead. Child of the pivot
      // (which carries world placement + scale); per-frame code drops it by
      // the jump height so it stays ON the ground while the body leaps.
      const shadow = buildAstronautBlobShadow(size.y || 1);
      pivot.add(shadow);
      astronaut = { root: pivot, inner, mixer, actions, animated, current: null,
        oneShot: false, shadow, armBones, footOffset, nativeHeight: size.y || 1 };
      if (animated) {
        console.info('[surface] astronaut clips:', Object.keys(actions).join(', '));
      } else {
        console.info('[surface] astronaut.glb has no usable clips — using procedural motion');
      }
      resolve(astronaut);
    }, undefined, (err) => {
      console.error('[surface] failed to load astronaut model', ASTRO_MODEL_URL, err);
      reject(err);
    });
  });
  return astronautLoading;
}

// Radial-gradient disc lying flat in the pivot's XZ plane (pivot Y = surface
// normal). MeshBasicMaterial so it's a plain dark stain, unlit and cheap.
export function buildAstronautBlobShadow(nativeH) {
  const cnv = document.createElement('canvas');
  cnv.width = cnv.height = 128;
  const ctx = cnv.getContext('2d');
  const grad = ctx.createRadialGradient(64, 64, 4, 64, 64, 62);
  grad.addColorStop(0.0, 'rgba(0,0,0,0.55)');
  grad.addColorStop(0.6, 'rgba(0,0,0,0.28)');
  grad.addColorStop(1.0, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);
  const mat = new THREE.MeshBasicMaterial({
    map: new THREE.CanvasTexture(cnv),
    transparent: true,
    depthWrite: false,
    opacity: 0.6,
  });
  const mesh = new THREE.Mesh(new THREE.CircleGeometry(nativeH * 0.34, 24), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = nativeH * 0.02;    // hair above the foot plane to dodge z-fighting
  mesh.renderOrder = 2;
  mesh.frustumCulled = false;
  return mesh;
}

// Resolve a desired state to whatever clip the model actually has, with
// graceful fallbacks (run→walk→idle, jump→idle, swim→walk-as-paddle) so
// partial clip sets work.
export function resolveAstronautAction(name) {
  const A = astronaut.actions;
  if (name === 'run')  return A.run  || A.walk || A.idle || null;
  if (name === 'walk') return A.walk || A.idle || null;
  if (name === 'jump') return A.jump || A.idle || null;
  if (name === 'swim') return A.swim || A.walk || A.idle || null;
  return A.idle || A.walk || null;
}

// Shared crossfade plumbing (also used by the mixer's 'finished' handler to
// settle one-shots back into the current looping state).
export function crossfadeAstronautTo(next) {
  if (!next || next === astronaut.current) return;
  next.reset();
  next.enabled = true;
  next.setEffectiveWeight(1);
  next.setEffectiveTimeScale(1.0);
  next.play();
  if (astronaut.current) astronaut.current.crossFadeTo(next, ASTRO_FADE, false);
  astronaut.current = next;
}

// Crossfade to the clip for a state (clip-driven models only). For static
// models we just record the state name so updateAstronaut fakes it.
export function setAstronautAction(name) {
  if (!astronaut) return;
  surfaceState.animName = name;
  if (!astronaut.animated) return;
  // A one-shot flourish (the landing wave) owns the rig while we're just
  // standing; any real state change cancels it immediately.
  if (astronaut.oneShot) {
    if (name === 'idle') return;
    astronaut.oneShot = false;
  }
  crossfadeAstronautTo(resolveAstronautAction(name));
}

// Mount the (already loaded) avatar into the scene for a fresh visit.
export function attachAstronaut() {
  if (!astronaut) return;
  const body = surfaceState.body;
  if (!body) return;
  const worldScale = body.group.scale.x || 1;
  // Target world height = a fraction of eye height, scaled into world units.
  const targetH = surfaceState.eyeHeight * ASTRO_HEIGHT_FACTOR * worldScale;
  const s = targetH / astronaut.nativeHeight;
  astronaut.root.scale.setScalar(s);
  // Remember the avatar's real rendered height so the camera can frame it in
  // units of "character heights" instead of guessing from eye height.
  surfaceState.charWorldH = targetH;
  astronaut.root.visible = surfaceState.cameraMode === 'third';
  if (!astronaut.root.parent) scene.add(astronaut.root);
  surfaceState.animName = 'idle';
  surfaceState.stridePhase = 0;
  surfaceState.swimBlend = 0;
  surfaceState.swimPhase = 0;
  astronaut.inner.position.copy(astronaut.footOffset);
  astronaut.inner.rotation.set(0, 0, 0);
  if (astronaut.animated) {
    // Reset to a clean idle so a previous visit's pose doesn't carry over.
    for (const k in astronaut.actions) astronaut.actions[k].stop();
    astronaut.current = null;
    astronaut.oneShot = false;
    setAstronautAction('idle');
    // Landing flourish: wave hello once, then settle into idle (the mixer's
    // 'finished' handler does the settle). Movement input cancels it.
    if (astronaut.actions.wave) {
      crossfadeAstronautTo(astronaut.actions.wave);
      astronaut.oneShot = true;
    }
  }
}

