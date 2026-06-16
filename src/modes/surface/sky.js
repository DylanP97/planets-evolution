// Surface-mode sky effects: aerial-perspective fog and the thick-atmosphere
// skylight ramp. (Underwater depth fog is no longer here — it's a per-pixel
// post-process pass; see modes/surface/underwater-pass.js. A per-camera
// scene.fog could only flip the whole view between "sky" and "murk", which
// couldn't separate the two across the waterline or follow the waves.)
import * as THREE from 'three';
import { milkyMat } from '../../background/galaxy.js';
import { starMat } from '../../background/starfield.js';
import { COL } from '../../core/constants.js';
import { camera, scene, surfaceSkyLight } from '../../core/scene.js';
import { coronaMesh, sunMesh } from '../../core/sun.js';
import { smoothstep } from '../../core/utils.js';
import { viewMode } from '../../framework/state.js';
import { _sunWorldTmp, _toSunTmp } from '../../system/lighting.js';
import { surfaceState } from './core.js';
import { cameraSubmerged } from './underwater-pass.js';

const _surfBodyCenter = new THREE.Vector3();
const _surfCamDir     = new THREE.Vector3();
export const SURFACE_STAR_OPACITY = 0.95;

// Full-screen tint overlay element. The underwater pass now owns the submerged
// look, so this is kept only so exitSurfaceMode can force it hidden (and for
// any future above-water screen tints); setUnderwaterOverlay just drives it.
export const underwaterOverlayEl = document.getElementById('underwaterOverlay');
let _uwOverlayHex = -1;
let _uwOverlayOp  = -1;
export function setUnderwaterOverlay(opacity, body) {
  if (!underwaterOverlayEl) return;
  if (opacity > 0 && body) {
    const hex = body.oceanBaseColor || COL.water;
    if (hex !== _uwOverlayHex) {
      _uwOverlayHex = hex;
      const c = new THREE.Color(hex);
      const rgb = (m) => `${Math.round(c.r * 255 * m)}, ${Math.round(c.g * 255 * m)}, ${Math.round(c.b * 255 * m)}`;
      underwaterOverlayEl.style.background =
        `radial-gradient(circle at 50% 38%, rgba(${rgb(0.65)}, 0.40) 0%, rgba(${rgb(0.18)}, 0.85) 100%)`;
    }
  }
  const op = Math.max(0, Math.min(1, opacity));
  if (op !== _uwOverlayOp) {
    _uwOverlayOp = op;
    underwaterOverlayEl.style.opacity = op.toFixed(3);
  }
}
// Aerial perspective: a linear haze that only switches on while standing on an
// ATMOSPHERE world (vacuum has none), tinting the terrain toward a horizon haze
// with distance. Sells the planet's scale and softly hides the rim of the
// surface-detail props/patch out near the skyline. near/far track eye height so
// it reads the same on a moon or a giant; the colour dims toward night so the
// haze doesn't glow on the dark side. Three's fog is GLOBAL, so we exclude the
// starfield + galactic band (the gas sky shell + sun are fog-less ShaderMaterials
// already, so the sky itself stays clear — only ground-level geometry hazes).
export const AERIAL_FOG_COLOR = new THREE.Color(0xb8c6d4);
export const aerialFog = new THREE.Fog(0xb8c6d4, 1, 100);
starMat.fog = false;
if (typeof milkyMat !== 'undefined' && milkyMat) milkyMat.fog = false;
export function updateSurfaceSkyEffects() {
  if (viewMode !== 'surface' || !surfaceState.body) {
    starMat.opacity = SURFACE_STAR_OPACITY;
    scene.fog = null;
    setUnderwaterOverlay(0, null);
    return;
  }
  // Underwater fog is a per-pixel post-process pass now (underwater-pass.js),
  // so nothing here keys off "is the camera submerged" — the sky stays the sky
  // and the murk is decided per pixel by the view ray. scene.fog is reset and
  // only re-armed below as the above-water aerial haze on atmosphere worlds.
  scene.fog = null;
  // Atmosphere worlds: shader paints the sun, so keep the real mesh hidden.
  // Airless worlds: show the real Sun (occluded by the body when it sets).
  sunMesh.visible    = !surfaceState.paintsSunDisc;
  coronaMesh.visible = !surfaceState.paintsSunDisc;
  // Airless worlds have no atmosphere to scatter daylight, so the sky stays
  // black and the stars never wash out — the Sun just hangs among them.
  if (!surfaceState.paintsSunDisc) {
    starMat.opacity = SURFACE_STAR_OPACITY;
    return;
  }
  surfaceState.body.group.getWorldPosition(_surfBodyCenter);
  _surfCamDir.copy(camera.position).sub(_surfBodyCenter).normalize();
  sunMesh.getWorldPosition(_sunWorldTmp);
  _toSunTmp.subVectors(_sunWorldTmp, _surfBodyCenter).normalize();
  const sunElev = _surfCamDir.dot(_toSunTmp);
  surfaceState.sunElev = sunElev;     // cached for diagnostics (day/night side)
  // Atmospheric skylight follows the sun: full diffuse daylight when the sun
  // is up, fading through twilight to nothing at night. Position is only a
  // direction (local up); subtract scene.position for the floating origin.
  surfaceSkyLight.intensity = (surfaceState.skyLightBase || 0) * smoothstep(-0.08, 0.30, sunElev);
  surfaceSkyLight.position.copy(_surfCamDir).multiplyScalar(10).sub(scene.position);
  if (sunElev >= 0.06) {
    starMat.opacity = 0;
  } else {
    const t = Math.min(1, Math.max(0, (0.06 - sunElev) / 0.44));
    const eased = t * t * (3 - 2 * t);
    starMat.opacity = eased * SURFACE_STAR_OPACITY;
  }
  // Aerial-perspective haze (atmosphere worlds). Dim the haze toward night so
  // the dark-side horizon doesn't pick up a daytime glow. Skip it entirely while
  // the camera is submerged: its pale-blue colour would bake into the offscreen
  // target and wash the underwater pass's blue murk toward white at the horizon.
  if (!cameraSubmerged()) {
    const eh = surfaceState.eyeHeight;
    const dayFactor = 1 - Math.min(1, starMat.opacity / SURFACE_STAR_OPACITY);
    aerialFog.near = eh * 8;
    aerialFog.far  = eh * 44;
    aerialFog.color.copy(AERIAL_FOG_COLOR).multiplyScalar(0.15 + 0.85 * dayFactor);
    scene.fog = aerialFog;
  }
}

// Per-frame: rebuild the camera transform from the body's current world
// matrix. The body spins on its axis and orbits the sun; by transforming
// the local eye/look vectors through body.mesh.matrixWorld every frame,
// the camera naturally rides along — sun and stars wheel overhead.
