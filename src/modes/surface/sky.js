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
import { bodies, probes, viewMode } from '../../framework/state.js';
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

// Bodies hanging in the surface sky (the Moon, other planets) are the same
// solid icosphere meshes used in orbit. The catch: the surface-mode aerial fog
// (updateSurfaceSkyEffects) is GLOBAL with a very short far distance, tuned to
// haze the near-field ground props. Distant bodies sit far beyond that far
// plane, so three.js blends them to 100% fog colour — a flat grey disc, no
// matter what their surface actually looks like (the very same grey that eats
// far-off trees and probes). The fix mirrors what the sky already does for the
// starfield/galaxy: exclude these bodies from fog so they render as their real
// lit selves. While we're here, add a soft night-side colour floor + gentle
// maria (materials.js, driven by uSkyBodyFill) so a far body reads as a world
// rather than a flat coin. Surface mode only; reverted by clearSkyBodies. The
// visited body underfoot is skipped — its ground SHOULD still take the haze.
// Toggle scene-fog response across a mesh subtree (probe GLBs are multi-mesh,
// sometimes multi-material). Only flips + recompiles materials that actually
// change, so it's cheap to call every frame.
function setSubtreeFog(root, fogOn) {
  root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) if (m.fog !== fogOn) { m.fog = fogOn; m.needsUpdate = true; }
  });
}

export function updateSkyBodies() {
  const here = surfaceState.body;
  if (!here) return;
  for (const b of bodies) {
    if (b === here) continue;
    if (b.kind !== 'planet' && b.kind !== 'moon') continue;
    if (!b.matter || !b.matter.solid) continue;
    const mat = b.mesh.material;
    // Drop fog on this far body's surface mesh (recompiles once; guarded).
    if (mat.fog) { mat.fog = false; mat.needsUpdate = true; }
    const sh = mat.userData.detailShader;
    if (sh) sh.uniforms.uSkyBodyFill.value = 0.12;
  }
  // Probes (orbiting GLB satellites) sit past the fog far-plane too, so they'd
  // otherwise read as the same flat grey blobs. Drop fog on their meshes. Done
  // every frame so probes whose GLB resolves AFTER we entered surface mode get
  // caught the moment they load.
  for (const p of probes) {
    if (p.mesh) setSubtreeFog(p.mesh, false);
  }
  // Daytime sky-glow veil on distant ATMOSPHERES (gas giants + thick-air worlds
  // like Venus). Their gas shells are fog-less ShaderMaterials, so unlike the
  // rocky surface meshes above they ignore the aerial haze and punch through the
  // daytime sky at full brightness. Fade them by how bright the sky you stand
  // under actually is: the glow scales with daylight AND the visited world's own
  // air opacity, so an airless/thin-atmosphere world still shows them clearly —
  // and lowering this body's Opacity reveals them even at noon (the real reason
  // you only rarely catch a planet in daylight is sky brightness, not opacity).
  const air = here.matter && here.matter.gas === 'atmosphere' ? (here.gasDensity ?? 0) : 0;
  const dayFactor = 1 - Math.min(1, starMat.opacity / SURFACE_STAR_OPACITY);
  // Daytime sky brightness is what hides planets, not the air's opacity — so the
  // veil tracks DAYLIGHT, exactly like the dim rocky discs (Moon/Mars) already
  // do. Any world with a real atmosphere washes distant gas planets down to a
  // faint daytime ghost regardless of the Opacity slider; only when the air is
  // nearly a vacuum (< ~0.1) does the daytime sky go dark enough to reveal them.
  // A 0.04 floor keeps a trace rather than popping straight to zero.
  const hasAir = smoothstep(0.04, 0.12, air);
  const veil = 1 - 0.96 * dayFactor * hasAir;
  // Bodies fade toward the colour of the sky they sit against — the visited
  // world's own sky tint — so they camouflage into it rather than just dimming.
  const skyTint = here.gasMesh ? here.gasMesh.material.uniforms.uSkyTint.value : null;
  for (const b of bodies) {
    if (b === here || !b.gasMesh) continue;
    if (b.kind !== 'planet' && b.kind !== 'moon') continue;
    const u = b.gasMesh.material.uniforms;
    u.uSkyVeil.value = veil;
    if (skyTint) u.uVeilColor.value.copy(skyTint);
  }
}

// Revert the sky-body treatment on leaving surface mode so the orbit view is
// unchanged: re-enable fog (only on the meshes we cleared, to avoid needless
// recompiles) and drop the night floor + any leftover detail flag.
export function clearSkyBodies() {
  for (const b of bodies) {
    if (b.kind !== 'planet' && b.kind !== 'moon') continue;
    const mat = b.mesh && b.mesh.material;
    if (!mat) continue;
    if (!mat.fog) { mat.fog = true; mat.needsUpdate = true; }
    const sh = mat.userData.detailShader;
    if (sh) {
      sh.uniforms.uSurfaceDetail.value = 0;
      sh.uniforms.uSkyBodyFill.value   = 0;
    }
  }
  // Re-enable fog on probe meshes for the orbit view.
  for (const p of probes) {
    if (p.mesh) setSubtreeFog(p.mesh, true);
  }
  // Clear the daytime sky-glow veil so gas shells render full-strength in orbit.
  for (const b of bodies) {
    if (b.gasMesh) b.gasMesh.material.uniforms.uSkyVeil.value = 1.0;
  }
}

// Console diagnostic: window.skyDiag() — what is actually hanging in the
// surface sky and why a body reads the way it does. For every body it prints
// kind, matter phase, whether a gas SHELL is drawn over it (a thin night-side
// shell renders as a soft grey halo — easily mistaken for the solid disc),
// its apparent radius in screen pixels, and the sky-disc uniforms this module
// is (or isn't) applying. Run it while standing on a surface looking at the disc.
const _sdCamPos = new THREE.Vector3();
const _sdBodyPos = new THREE.Vector3();
window.skyDiag = function skyDiag() {
  const here = surfaceState.body;
  camera.getWorldPosition(_sdCamPos);
  const pxPerRad = window.innerHeight / (camera.fov * Math.PI / 180);
  const rows = [];
  for (const b of bodies) {
    b.group.getWorldPosition(_sdBodyPos);
    const dist = _sdCamPos.distanceTo(_sdBodyPos);
    const rWorld = b.baseRadius * (b.group.scale.x || 1);
    const apxPx = Math.atan(rWorld / Math.max(1e-6, dist)) * pxPerRad;
    const sh = b.mesh.material.userData.detailShader;
    const gasOn = !!(b.gasMesh && b.gasMesh.visible);
    rows.push({
      name: b.name,
      kind: b.kind,
      phase: b.matter ? (b.matter.solid ? 'solid' : b.matter.gas ? 'gas' : b.matter.liquid ? 'liquid' : '?') : '?',
      isUnderfoot: b === here,
      gasShellDrawn: gasOn,
      apparentRadiusPx: +apxPx.toFixed(1),
      detailShader: !!sh,
      uSkyBodyFill: sh ? +sh.uniforms.uSkyBodyFill.value.toFixed(3) : 'n/a',
      uSurfaceDetail: sh ? +sh.uniforms.uSurfaceDetail.value.toFixed(2) : 'n/a',
    });
  }
  rows.sort((a, b) => b.apparentRadiusPx - a.apparentRadiusPx);
  console.table(rows);
  console.info('[skyDiag] standing on: %s | viewMode=%s — biggest discs are at the top of the table.',
    here ? here.name : '(not on a surface)', viewMode);
  return rows;
};

// Per-frame: rebuild the camera transform from the body's current world
// matrix. The body spins on its axis and orbits the sun; by transforming
// the local eye/look vectors through body.mesh.matrixWorld every frame,
// the camera naturally rides along — sun and stars wheel overhead.
