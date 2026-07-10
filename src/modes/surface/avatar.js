// The surface avatar: the CHARACTERS registry (switchable via the pause
// menu's Character page), loading/normalizing, the clip state machine
// (idle/walk/run/jump/swim), crossfades, and the blob shadow.
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as THREE from 'three';
import { scene } from '../../core/scene.js';
import { viewMode } from '../../framework/state.js';
import { surfaceState } from './core.js';

// ── Astronaut character ────────────────────────────────────────────────
// A GLB drives the surface avatar. It loads once and is re-parented to the
// scene for each visit (only one surface session is ever active). The model
// is character.glb (the three.js RobotExpressive explorer): fully colored
// materials and a complete clip set — Idle/Walking/Running/Jump plus emotes
// like Wave. Clip names are fuzzy-matched, so any rigged+animated GLB
// (e.g. a Mixamo export) can be dropped in as a replacement; an UNRIGGED
// static mesh falls back to procedural bob + lean so it still reads as
// moving. (The old astronaut.glb was removed: textured but missing a Jump
// clip, which is why jumps used to freeze in the idle pose.)
export const ASTRO_CLIPS = { idle: 'Idle', walk: 'Walking', run: 'Running', jump: 'Jump' };

// ── Switchable characters ──────────────────────────────────────────────
// Every entry is a GLB the loader below can normalize: rigged+animated ones
// get the full clip state machine, static ones (the Hitem3D astronauts) fall
// back to procedural bob + lean. `facing` = the model's local forward axis
// sign (see ASTRO_FACING note below). The pick persists across sessions.
export const CHARACTERS = [
  { id: 'robot',       label: 'Explorer Bot', url: 'assets/character.glb',        facing: 1 },
  { id: 'astronaut-c', label: 'Astronaut',    url: 'assets/astronaut-c.glb',      facing: 1 },
  { id: 'human',       label: 'Wanderer',     url: 'assets/character-human.glb',  facing: 1 },
  { id: 'human2',      label: 'Crypto',       url: 'assets/character-human2.glb', facing: 1 },
];
const CHARACTER_STORE_KEY = 'planetTiles.characterId';

function storedCharacterId() {
  try {
    const id = localStorage.getItem(CHARACTER_STORE_KEY);
    if (CHARACTERS.some(c => c.id === id)) return id;
  } catch (_) { /* storage blocked — session default */ }
  return CHARACTERS[0].id;
}

export let characterId = storedCharacterId();
export function currentCharacter() {
  return CHARACTERS.find(c => c.id === characterId) || CHARACTERS[0];
}
// The model's local forward axis. Flip sign if the avatar faces the camera
// instead of showing its back. RobotExpressive faces +Z, so we use +1
// (Soldier.glb-style models face -Z and would need -1).
export const ASTRO_FACING = 1;
export const ASTRO_TURN_RATE = 10;            // how fast the avatar swivels to face its heading
export const ASTRO_FADE = 0.18;               // animation crossfade seconds
export const ASTRO_HEIGHT_FACTOR = 2.2;       // avatar height as a fraction of eye height (tune the visual size)

const _avatarEmDay   = new THREE.Color(0x181c22);
const _avatarEmNight = new THREE.Color(0x6090c8);
const _avatarFillDay = new THREE.Color(0xfff1d4);
const _avatarFillNight = new THREE.Color(0xc8dcff);

export let astronaut = null;                  // { root, inner, mixer, actions, animated, footOffset, nativeHeight }
export let astronautLoading = null;

/** Per-frame suit readout: emissive ramp + chest fill track surfaceState.surfaceNight. */
export function updateAvatarNightLook(night) {
  if (!astronaut) return;
  const n = Math.max(0, Math.min(1, night));
  for (const entry of astronaut.lookMats) {
    const { mat, baseColor } = entry;
    if (mat.emissive) {
      mat.emissive.copy(_avatarEmDay).lerp(_avatarEmNight, n);
      mat.emissiveIntensity = THREE.MathUtils.lerp(0.12, 2.15, n);
    }
    // MeshBasicMaterial ignores lights — brighten albedo at night instead.
    if (mat.isMeshBasicMaterial && baseColor) {
      mat.color.copy(baseColor).lerp(_avatarEmNight, n * 0.42);
    }
  }
  if (astronaut.nightFill) {
    astronaut.nightFill.intensity = n * 0.72;
    astronaut.nightFill.color.copy(_avatarFillDay).lerp(_avatarFillNight, n);
  }
}

export function loadAstronaut() {
  if (astronaut) return Promise.resolve(astronaut);
  if (astronautLoading) return astronautLoading;
  const character = currentCharacter();
  const loader = new GLTFLoader();
  astronautLoading = new Promise((resolve, reject) => {
    loader.load(character.url, (gltf) => {
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
      const lookMats = [];
      inner.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = true;
        o.frustumCulled = false;       // tiny on-screen; culling math gets twitchy at this scale
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m) => {
          if (!m) return;
          const baseColor = m.color ? m.color.clone() : null;
          if (m.emissive) {
            m.emissive.copy(_avatarEmDay);
            m.emissiveIntensity = 0.12;
          }
          lookMats.push({ mat: m, baseColor });
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
      // Chest-mounted fill: cheap moon-key read on the suit without relighting the jungle.
      const nightFill = new THREE.PointLight(0xc8dcff, 0, 1.4, 0);
      nightFill.position.set(0, (size.y || 1) * 0.55, (size.y || 1) * 0.08);
      pivot.add(nightFill);
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
          swim: pick('swim', 'paddle', 'breaststroke'),
          treadWater: pick('treadwater', 'tread water', 'tread'),
          wave: pick('wave', 'hello', 'greet'),
          dying: pick('dying', 'death', 'die'),
        };
        for (const key in clips) {
          if (clips[key]) actions[key] = mixer.clipAction(clips[key]);
        }
        // One-shots: a jump plays once and freezes on its last frame until
        // landing flips the state; the landing wave plays once then settles
        // into idle via the mixer's 'finished' event below; dying plays once
        // and freezes on its collapsed pose until a respawn resets the state.
        for (const key of ['jump', 'wave', 'dying']) {
          if (actions[key]) {
            actions[key].setLoop(THREE.LoopOnce, 1);
            actions[key].clampWhenFinished = true;
          }
        }
        mixer.addEventListener('finished', () => {
          if (!astronaut) return;
          astronaut.oneShot = false;
          // Airborne: hold the jump clip clamped on its final frame; the
          // state machine crossfades out on touchdown. Dead: hold the death
          // pose clamped until a respawn resets animName.
          if (surfaceState.animName === 'jump' || surfaceState.animName === 'dying') return;
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
        oneShot: false, shadow, armBones, footOffset, nativeHeight: size.y || 1,
        facing: character.facing != null ? character.facing : ASTRO_FACING,
        lookMats, nightFill };
      updateAvatarNightLook(0);
      if (animated) {
        console.info('[surface] astronaut clips:', Object.keys(actions).join(', '));
      } else {
        console.info('[surface] avatar GLB has no usable clips — using procedural motion');
      }
      resolve(astronaut);
    }, undefined, (err) => {
      console.error('[surface] failed to load astronaut model', character.url, err);
      astronautLoading = null;   // allow a retry / a different character pick
      reject(err);
    });
  });
  return astronautLoading;
}

// Swap the controlled character. Persists the pick, tears down the current
// model (GPU resources included — each swap would otherwise leak a full
// mesh+texture set), and if a surface visit is live, mounts the replacement
// in-place so the swap is seamless from the pause menu. Returns the load
// promise so the Character page can show a busy state.
export function setCharacter(id) {
  if (id === characterId || !CHARACTERS.some(c => c.id === id)) {
    return Promise.resolve(astronaut);
  }
  characterId = id;
  try { localStorage.setItem(CHARACTER_STORE_KEY, id); } catch (_) {}
  const old = astronaut;
  astronaut = null;
  astronautLoading = null;
  if (old) {
    if (old.root.parent) old.root.parent.remove(old.root);
    if (old.mixer) old.mixer.stopAllAction();
    old.root.traverse((o) => {
      if (!o.isMesh) return;
      if (o.geometry) o.geometry.dispose();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => {
        if (!m) return;
        if (m.map) m.map.dispose();
        m.dispose();
      });
    });
  }
  return loadAstronaut().then((next) => {
    if (viewMode === 'surface' && surfaceState.body) {
      attachAstronaut();
      // The frame loop repositions the avatar every tick, but it's frozen
      // while the pause menu is up — seat the new model at the old one's
      // spot now so it doesn't flash at the origin behind the menu.
      if (old) {
        next.root.position.copy(old.root.position);
        next.root.quaternion.copy(old.root.quaternion);
      }
    }
    return next;
  });
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
  if (name === 'treadWater') return A.treadWater || A.swim || A.walk || A.idle || null;
  if (name === 'dying') return A.dying || A.idle || null;
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

