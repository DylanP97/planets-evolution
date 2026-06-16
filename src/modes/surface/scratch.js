// Shared module-scope scratch for the surface modules (grass, ground, rocks,
// props): one raycaster + reusable vectors/quaternions/colors so the per-frame
// placement loops never allocate. Zero imports besides THREE, so any surface
// module can use these without creating an import cycle.
//
// NOT re-entrant: a caller must finish with a scratch value before invoking
// anything else that writes the same one.
import * as THREE from 'three';

// Downward terrain probes (grass biome probe, ground patch, rock/prop drop).
export const grassRaycaster = new THREE.Raycaster();
export const _grOrigin = new THREE.Vector3();
export const _grDir    = new THREE.Vector3();
export const _grHit    = new THREE.Vector3();
export const _grCol    = new THREE.Color();
export const _grTint   = new THREE.Color();

// Instance placement (blade / rock / prop transforms).
export const _gP     = new THREE.Vector3();
export const _gUp    = new THREE.Vector3();
export const _gTilt  = new THREE.Vector3();
export const _gMat   = new THREE.Matrix4();
export const _gQuat  = new THREE.Quaternion();
export const _gRot   = new THREE.Quaternion();
export const _gScale = new THREE.Vector3();
export const _gAxisY = new THREE.Vector3(0, 1, 0);
