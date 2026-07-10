// Per-frame lighting refresh: per-body uSunDir uniforms, shadow-map framing,
// and the moonlight rig that lights night-side surface walks.
import * as THREE from 'three';
import { camera, moonLight, scene, SUN_RADIUS } from '../core/scene.js';
import { coronaMesh, sunMesh } from '../core/sun.js';
import { bodies, focusedBody, focusedProbe, moons, viewMode } from '../framework/state.js';
import { surfaceState } from '../modes/surface/core.js';

/** Set each frame by updateMoonLight when a primary satellite lights the focus body. */
export let moonLightActive = false;

// ====== Sun apparent size ======
// The Sun's real mesh is oversized for orbit-view drama (radius 18 vs.
// Mercury's own orbit distance of 120), so seen at true scale from any
// planet it fills a huge chunk of the sky. Shrink the disc with an
// inverse-square falloff once the camera is farther than CLOSE_ORBIT_DIST —
// that keeps it reading as a small, roughly constant white dot from every
// planet, and only lets it bloom back up to full size (fiery plasma detail +
// corona) if the camera actually flies in close to the star itself. The
// corona's restless red halo only reads as a "circle" once shrunk down with
// the disc, so instead of scaling it we just hide it outside close orbit.
const SUN_CLOSE_ORBIT_DIST = SUN_RADIUS * 2.0;
const SUN_MIN_SCALE = 0.09;
const _sunAppearPos = new THREE.Vector3();
export function updateSunAppearance() {
  sunMesh.getWorldPosition(_sunAppearPos);
  const dist = camera.position.distanceTo(_sunAppearPos);
  const raw = (SUN_CLOSE_ORBIT_DIST / Math.max(1e-3, dist)) ** 2;
  const scale = Math.min(1, Math.max(SUN_MIN_SCALE, raw));
  sunMesh.scale.setScalar(scale);
  // On atmosphere worlds the sky shader paints its own sun disc, so the real
  // mesh (and its corona) stay hidden regardless of distance.
  const atmosphereHidesSun = viewMode === 'surface' && surfaceState.paintsSunDisc;
  coronaMesh.visible = !atmosphereHidesSun && raw >= 1;
}

// ====== 21. Sun light for focus ======
// PointLight sits at the sun's origin, so its lighting direction is
// already correct per-body (each fragment computes its own light vector).
// The atmosphere shader still uses a uniform vec3 uSunDir, so we refresh
// each body's gas material with its own (body → sun) direction.
export const _sunWorldTmp = new THREE.Vector3();
const _bodyPosTmp  = new THREE.Vector3();
export const _toSunTmp    = new THREE.Vector3();
export function updateSunLightForFocus() {
  sunMesh.getWorldPosition(_sunWorldTmp);
  for (const b of bodies) {
    const needsGas  = !!(b.gasMesh  && b.gasMesh.material.uniforms.uSunDir);
    const needsRing = !!(b.ringMesh && b.ringMesh.visible);
    if (!needsGas && !needsRing) continue;
    b.group.getWorldPosition(_bodyPosTmp);
    _toSunTmp.subVectors(_sunWorldTmp, _bodyPosTmp);
    if (_toSunTmp.lengthSq() < 1e-8) _toSunTmp.set(1, 0, 0);
    else _toSunTmp.normalize();
    if (needsGas) {
      b.gasMesh.material.uniforms.uSunDir.value.copy(_toSunTmp);
    }
    if (needsRing) {
      const u = b.ringMesh.material.uniforms;
      u.uSunDir.value.copy(_toSunTmp);
      u.uBodyCenter.value.copy(_bodyPosTmp);
      // World radius includes the body group's scale so the planet shadow
      // on the ring tracks visually no matter the planet size.
      const worldScale = b.group.scale.x;
      u.uBodyRadius.value = b.baseRadius * worldScale;
      // Gas occluder: where the line of sight to a ring fragment passes
      // through the gas sphere, the shader fades alpha so a thick
      // atmosphere (or gas-giant body) hides the back half of the ring.
      // For 'full' gas the body IS the gas — opacity tracks density.
      // For 'atmosphere' shells, both density and coverage matter (sparse
      // clouds don't block much regardless of how dense each clump is).
      if (b.matter && b.matter.gas) {
        const thick = b.gasThickness ?? 1.0;
        u.uGasRadius.value = b.baseRadius * thick * worldScale;
        const density  = b.gasDensity  ?? 0.5;
        const coverage = b.gasCoverage ?? 0.5;
        u.uGasOpacity.value = b.matter.gas === 'full'
          ? density
          : density * coverage;
      } else {
        u.uGasRadius.value  = 0.0;
        u.uGasOpacity.value = 0.0;
      }
    }
  }
}

// Refresh the moon-eclipse-shadow uniforms on every planet's body + ocean
// material (see framework/materials.js → ECLIPSE_GLSL). For each planet we
// gather its moons' world positions + world radii and the Sun's world
// position; the shader darkens the sunlit fragments each moon occludes.
const _eclSun  = new THREE.Vector3();
const _eclMoon = new THREE.Vector3();
function writeEclipseUniforms(sh, planet) {
  if (!sh) return;
  let n = 0;
  for (const m of moons) {
    if (m.parent !== planet || n >= sh.uniforms.uEclipsePos.value.length) continue;
    m.body.group.getWorldPosition(_eclMoon);
    sh.uniforms.uEclipsePos.value[n].copy(_eclMoon);
    sh.uniforms.uEclipseRad.value[n] = m.body.baseRadius * m.body.group.scale.x;
    n++;
  }
  sh.uniforms.uEclipseCount.value = n;
  sh.uniforms.uSunPos.value.copy(_eclSun);
}
export function updateEclipseShadows() {
  sunMesh.getWorldPosition(_eclSun);
  for (const b of bodies) {
    if (b.kind !== 'planet') continue;
    writeEclipseUniforms(b.mesh.material.userData.detailShader, b);
    if (b.oceanMesh && b.oceanMesh.visible) {
      writeEclipseUniforms(b.oceanMesh.material.userData.shader, b);
    }
  }
}

export function updateMoonLight() {
  moonLightActive = false;
  // Moonlight is only calculated for the current "focus" context: either the
  // planet we're walking on, or the body (planet/moon) the camera is focused on.
  const targetBody = (viewMode === 'surface' ? surfaceState.body : (focusedProbe ? null : focusedBody));
  if (!targetBody) {
    moonLight.intensity = 0;
    return;
  }

  let primarySat = null;
  let maxImpact = 0;

  if (targetBody.kind === 'planet') {
    // Find the moon with the most "impact" (apparent size) on this planet.
    for (const m of moons) {
      if (m.parent === targetBody) {
        const size = m.body.baseRadius * m.body.group.scale.x;
        // impact is proportional to solid angle (size^2 / distance^2)
        const impact = (size * size) / (m.distance * m.distance);
        if (impact > maxImpact) {
          maxImpact = impact;
          primarySat = m.body;
        }
      }
    }
  } else if (targetBody.kind === 'moon') {
    // If we're on a moon, the host planet is our "primary" light source (planetlight).
    const m = moons.find(mn => mn.body === targetBody);
    if (m && m.parent) {
      primarySat = m.parent;
      maxImpact = 1.0; // host planet is always the dominant night light
    }
  }

  if (!primarySat) {
    moonLight.intensity = 0;
    return;
  }

  moonLightActive = true;

  // Direction from target to satellite.
  primarySat.group.getWorldPosition(_sunWorldTmp);
  targetBody.group.getWorldPosition(_bodyPosTmp);
  _toSunTmp.subVectors(_sunWorldTmp, _bodyPosTmp);
  
  if (_toSunTmp.lengthSq() < 1e-8) {
    moonLight.intensity = 0;
    moonLightActive = false;
    return;
  }
  _toSunTmp.normalize();
  
  // DirectionalLight: position is the direction vector relative to the target.
  // We set target at the body center, and position at (body center + direction).
  // Minus scene.position: both are scene children, and in surface mode the
  // scene carries the floating-origin shift (see updateSurfaceOrigin).
  moonLight.target.position.copy(_bodyPosTmp).sub(scene.position);
  moonLight.position.copy(_bodyPosTmp).add(_toSunTmp).sub(scene.position);
  
  // Orbit view only — surface mode scales intensity in surface-lighting.js.
  if (viewMode !== 'surface') {
    moonLight.intensity = 0.10;
    moonLight.color.setHex(0xd0e7ff);
  }
}

