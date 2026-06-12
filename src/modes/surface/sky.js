// Surface-mode sky effects: aerial-perspective fog, underwater murk + the
// full-screen overlay, and the thick-atmosphere skylight ramp.
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
import { waterPatch, waterUniforms } from './water.js';

const _surfBodyCenter = new THREE.Vector3();
const _surfCamDir     = new THREE.Vector3();
export const SURFACE_STAR_OPACITY = 0.95;
// Reused single fog instance for the underwater look (an exponential murk,
// tinted from the body's own liquid, that collapses visibility to a few
// body-heights). scene.fog is otherwise unused.
export const underwaterFog = new THREE.FogExp2(0x10566f, 0.0);
const _uwCamLocal = new THREE.Vector3();
// Full-screen underwater tint overlay: three's fog only touches fog-enabled
// materials, so the gas sky shell / sun / stars stay crisp through the murk
// without it. The overlay tints EVERYTHING toward the water colour and adds
// a soft vignette, which is what finally sells "you are inside the water".
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
  // Underwater: judged from the CAMERA's actual position, not the avatar's
  // nominal head height — the third-person camera trails low behind the
  // walker and routinely dips under the surface while the head is still dry
  // (that mismatch is why the sea used to look completely transparent from
  // just below the waterline). When submerged, sight collapses to a handful
  // of body-heights of liquid-coloured murk that darkens with depth, and the
  // full-screen overlay tints the fog-immune sky shaders to match.
  let submerged = false;
  {
    const b = surfaceState.body;
    if (b.matter && b.matter.liquid) {
      _uwCamLocal.copy(camera.position);
      b.mesh.worldToLocal(_uwCamLocal);
      const camR = _uwCamLocal.length();
      // The water-patch surface rides at baseRadius + uLift (so wave troughs
      // clear sea level) — judge submersion against the VISIBLE waterline,
      // not the nominal one, or a camera just under the surface stays dry.
      let seaR = b.baseRadius;
      if (waterPatch && waterPatch.mesh.visible && waterUniforms) seaR += waterUniforms.uLift.value;
      if (camR < seaR) {
        submerged = true;
        const scale  = b.group.scale.x || 1;
        const eh     = surfaceState.eyeHeight * scale;   // world-unit body height
        const depthW = (seaR - camR) * scale;            // world units below the waterline
        // Clear-ish for the first body-heights, closing in as you sink.
        const vis = Math.max(eh * 3.0, eh * 14.0 - depthW * 5.0);
        underwaterFog.density = 1.4 / vis;
        const deepF = Math.min(1, depthW / (eh * 18.0));
        underwaterFog.color.setHex(b.oceanBaseColor || COL.water)
          .multiplyScalar(0.42 * (1 - deepF) + 0.10 * deepF);
        scene.fog = underwaterFog;
        setUnderwaterOverlay(0.40 + 0.40 * deepF, b);
      }
    }
    if (!submerged) {
      scene.fog = null;
      setUnderwaterOverlay(0, null);
    }
  }
  // Atmosphere worlds: shader paints the sun, so keep the real mesh hidden.
  // Airless worlds: show the real Sun (occluded by the body when it sets).
  sunMesh.visible    = !surfaceState.paintsSunDisc;
  coronaMesh.visible = !surfaceState.paintsSunDisc;
  // Airless worlds have no atmosphere to scatter daylight, so the sky stays
  // black and the stars never wash out — the Sun just hangs among them.
  if (!surfaceState.paintsSunDisc) {
    starMat.opacity = submerged ? 0 : SURFACE_STAR_OPACITY;
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
  if (submerged) starMat.opacity = 0;   // no stars through the murk
  // Aerial-perspective haze (atmosphere worlds, above water). Dim the haze
  // toward night so the dark-side horizon doesn't pick up a daytime glow.
  if (scene.fog !== underwaterFog) {
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
