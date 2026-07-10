// Remote-player avatars: presence-only multiplayer (position/facing/anim),
// no terrain sync. Deliberately does NOT reuse avatar.js's loadAstronaut/
// attachAstronaut/setAstronautAction — those are tightly coupled to the
// local singleton `astronaut` var (the mixer's 'finished' listener reads it
// directly), so duplicating the smaller "load a GLB, rig a mixer, crossfade
// a loop clip" slice here is safer than untangling that coupling. The local
// player's own code path in avatar.js is completely untouched.
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as THREE from 'three';
import { scene } from '../core/scene.js';
import { bodies } from '../framework/state.js';
import { CHARACTERS, ASTRO_CLIPS, ASTRO_FADE, ASTRO_HEIGHT_FACTOR, ASTRO_TURN_RATE } from '../modes/surface/avatar.js';

const remotePlayers = new Map(); // clientId -> entry (see onPeerJoined)

function findBodyById(bodyId) {
  return bodies.find(b => b.currentSeed === bodyId) || null;
}

function loadRemoteInstance(charId) {
  const character = CHARACTERS.find(c => c.id === charId) || CHARACTERS[0];
  const loader = new GLTFLoader();
  return new Promise((resolve, reject) => {
    loader.load(character.url, (gltf) => {
      const inner = gltf.scene;
      inner.updateMatrixWorld(true);
      const bbox = new THREE.Box3().setFromObject(inner);
      const size = bbox.getSize(new THREE.Vector3());
      const center = bbox.getCenter(new THREE.Vector3());
      const footOffset = new THREE.Vector3(-center.x, -bbox.min.y, -center.z);
      inner.position.copy(footOffset);
      inner.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
      const pivot = new THREE.Group();
      pivot.add(inner);
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
          idle: pick(ASTRO_CLIPS.idle, 'idle', 'stand') || anims[0],
          walk: pick(ASTRO_CLIPS.walk, 'walk'),
          run: pick(ASTRO_CLIPS.run, 'run', 'sprint'),
          jump: pick(ASTRO_CLIPS.jump, 'jump'),
        };
        for (const key in clips) if (clips[key]) actions[key] = mixer.clipAction(clips[key]);
        if (actions.jump) { actions.jump.setLoop(THREE.LoopOnce, 1); actions.jump.clampWhenFinished = true; }
      }
      const animated = !!(actions.idle || actions.walk);
      const instance = {
        root: pivot, inner, mixer, actions, animated, current: null,
        nativeHeight: size.y || 1,
        facing: character.facing != null ? character.facing : 1,
      };
      scene.add(pivot);
      resolve(instance);
    }, undefined, reject);
  });
}

function resolveInstanceAction(instance, name) {
  const A = instance.actions;
  if (name === 'run') return A.run || A.walk || A.idle || null;
  if (name === 'jump') return A.jump || A.idle || null;
  if (name === 'walk' || name === 'swim') return A.walk || A.idle || null;
  return A.idle || A.walk || null;
}

function crossfadeInstanceTo(instance, next) {
  if (!next || next === instance.current) return;
  next.reset(); next.enabled = true; next.setEffectiveWeight(1); next.setEffectiveTimeScale(1); next.play();
  if (instance.current) instance.current.crossFadeTo(next, ASTRO_FADE, false);
  instance.current = next;
}

export function setRemoteAvatarAction(instance, name) {
  if (!instance || !instance.animated) return;
  crossfadeInstanceTo(instance, resolveInstanceAction(instance, name));
}

export function onPeerJoined(clientId, payload) {
  if (remotePlayers.has(clientId)) return;
  const entry = {
    instance: null, body: null,
    localUp: null, faceLocal: null, radius: 0, eyeHeight: 0.04,
    animName: 'idle', characterId: (payload && payload.characterId) || CHARACTERS[0].id,
  };
  remotePlayers.set(clientId, entry);
  loadRemoteInstance(entry.characterId).then((instance) => { entry.instance = instance; });
}

export function onPeerLeft(clientId) {
  const entry = remotePlayers.get(clientId);
  if (!entry) return;
  if (entry.instance) {
    scene.remove(entry.instance.root);
    entry.instance.root.traverse((o) => {
      if (!o.isMesh) return;
      if (o.geometry) o.geometry.dispose();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach(m => m && m.dispose());
    });
  }
  remotePlayers.delete(clientId);
}

// payload: { bodyId, localUp:[x,y,z], faceLocal:[x,y,z], radius, eyeHeight, animName, characterId }
export function onAvatarState(clientId, payload) {
  let entry = remotePlayers.get(clientId);
  if (!entry) { onPeerJoined(clientId, payload); entry = remotePlayers.get(clientId); }
  entry.body = findBodyById(payload.bodyId);
  entry.localUp = payload.localUp;
  entry.faceLocal = payload.faceLocal;
  entry.radius = payload.radius;
  entry.eyeHeight = payload.eyeHeight;
  if (entry.animName !== payload.animName) {
    entry.animName = payload.animName;
    if (entry.instance) setRemoteAvatarAction(entry.instance, payload.animName);
  }
}

export function clearRemoteAvatars() {
  for (const clientId of [...remotePlayers.keys()]) onPeerLeft(clientId);
}

// Scratch vectors/matrix — module scope, reused every frame (never allocate
// in the loop; mirrors the pattern swim.js uses for the local avatar's own
// orientation basis).
const _footLocal = new THREE.Vector3();
const _footWorld = new THREE.Vector3();
const _worldUp = new THREE.Vector3();
const _worldFwd = new THREE.Vector3();
const _astroX = new THREE.Vector3();
const _astroMat = new THREE.Matrix4();
const _astroQuat = new THREE.Quaternion();

export function updateRemoteAvatars(dt) {
  for (const entry of remotePlayers.values()) {
    const { instance, body, localUp, faceLocal } = entry;
    if (!instance || !body || !localUp || !faceLocal) continue;
    const mw = body.mesh.matrixWorld;
    const worldScale = body.group.scale.x || 1;

    _footLocal.set(localUp[0], localUp[1], localUp[2]).multiplyScalar(entry.radius);
    _footWorld.copy(_footLocal).applyMatrix4(mw).sub(scene.position);
    instance.root.position.copy(_footWorld);

    const targetH = entry.eyeHeight * ASTRO_HEIGHT_FACTOR * worldScale;
    instance.root.scale.setScalar(targetH / instance.nativeHeight);

    _worldUp.set(localUp[0], localUp[1], localUp[2]).transformDirection(mw);
    _worldFwd.set(faceLocal[0], faceLocal[1], faceLocal[2]).transformDirection(mw).multiplyScalar(instance.facing);
    _astroX.crossVectors(_worldUp, _worldFwd).normalize();
    _astroMat.makeBasis(_astroX, _worldUp, _worldFwd);
    _astroQuat.setFromRotationMatrix(_astroMat);
    instance.root.quaternion.slerp(_astroQuat, Math.min(1, dt * ASTRO_TURN_RATE));

    if (instance.mixer) instance.mixer.update(dt);
  }
}
