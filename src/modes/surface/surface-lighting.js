// Surface-walk day/night lighting: scales the global sun + ambient down on the
// dark side, boosts moonlight, and exposes day/night factors for fog tuning.
import * as THREE from 'three';
import { sun, ambientLight, moonLight } from '../../core/scene.js';
import { smoothstep } from '../../core/utils.js';
import { moonLightActive } from '../../system/lighting.js';
import { surfaceState } from './core.js';

// Mutable so the dev panel (ui/dev-panel.js) can retune these live — every
// consumer below reads the object fresh each frame/call rather than a
// snapshot, same live-tuning pattern as underwater-pass.js's uwFogTuning.
export const lightingTuning = {
  sunDay: 1.50,
  sunNight: 0.0,
  ambDay: 0.04,
  ambNight: 0.008,
  moonBase: 0.42,
  moonColor: 0xa8c8ff,
};

const _moonColor = new THREE.Color(lightingTuning.moonColor);

/** Restore the stock orbit-view rig after exitSurfaceMode. */
export function restoreOrbitLighting() {
  sun.intensity = lightingTuning.sunDay;
  sun.color.setHex(0xfff1d4);
  ambientLight.intensity = lightingTuning.ambDay;
  ambientLight.color.setHex(0xd0d0ff);
}

/**
 * @param {number} sunElev dot(localUp, toSun) from updateSurfaceSkyEffects
 * @returns {{ day: number, night: number }}
 */
export function updateSurfaceNightLighting(sunElev) {
  const day = smoothstep(-0.12, 0.22, sunElev);
  const night = 1 - day;

  sun.intensity = THREE.MathUtils.lerp(lightingTuning.sunNight, lightingTuning.sunDay, day);
  sun.color.setHex(day > 0.5 ? 0xfff1d4 : 0x8899bb);

  ambientLight.intensity = THREE.MathUtils.lerp(lightingTuning.ambNight, lightingTuning.ambDay, day);
  ambientLight.color.setHex(0xd0d0ff);

  if (moonLightActive) {
    _moonColor.setHex(lightingTuning.moonColor);
    moonLight.intensity = lightingTuning.moonBase * night;
    moonLight.color.copy(_moonColor);
  }

  surfaceState.surfaceDay = day;
  surfaceState.surfaceNight = night;
  return { day, night };
}
