import * as THREE from 'three';
import { scene, SUN_RADIUS } from './scene.js';
import { makePlasmaMaterial } from '../shaders/plasma.js';
import { makeCoronaMaterial } from '../shaders/corona.js';

// Sun anchors the system center; planets orbit around (0,0,0).
// Lit with the plasma shader: larger-scale + slower than the default so it
// reads as a vast photosphere; colors are pushed toward yellow-white (less
// red) and brightness up, since the Sun is a hot star.
export const sunMesh = new THREE.Mesh(
  new THREE.SphereGeometry(SUN_RADIUS, 48, 24),
  makePlasmaMaterial()
);
sunMesh.position.set(0, 0, 0);
scene.add(sunMesh);
{
  const su = sunMesh.material.uniforms;
  su.uScale.value = 3.0;
  su.uSpeed.value = 0.8;
  su.uBright.value = 1.55;
  su.uColorDeep.value.setHex(0xa83a08); // bright deep orange (no dark red)
  su.uColorLow.value.setHex(0xff8a2a);  // orange
  su.uColorMid.value.setHex(0xffd27a);  // warm yellow
  su.uColorHot.value.setHex(0xffffff);  // pure white
  // Bleach toward white as the camera pulls away to system view.
  su.uWhiten.value = 1.0;
  su.uWhitenNear.value = SUN_RADIUS * 4.0;
  su.uWhitenFar.value  = SUN_RADIUS * 30.0;
}

// Restless red-orange glow dome around the Sun.
export const CORONA_OUTER = SUN_RADIUS * 1.6;
export const coronaMesh = new THREE.Mesh(
  new THREE.SphereGeometry(CORONA_OUTER, 64, 32),
  makeCoronaMaterial(0xff4d12, SUN_RADIUS, CORONA_OUTER)
);
coronaMesh.position.copy(sunMesh.position);
scene.add(coronaMesh);

// Uniform sets ticked every frame by the animate loop (always advancing —
// a star never freezes, even when the sim is paused).
export const plasmaTickUniforms = [sunMesh.material.uniforms, coronaMesh.material.uniforms];
