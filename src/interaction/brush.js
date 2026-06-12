// The brush cursor ring, the shared pointer raycaster, and isBrushTool.
import * as THREE from 'three';
import { scene } from '../core/scene.js';
import { brushRadius, currentTool } from '../framework/state.js';

// ====== 14. Brush ======
// Brush/tool state itself lives in framework/state.js (it is shared by the
// pointer handlers, the UI, and the animate loop). This module owns the
// brush cursor ring and the shared raycaster.

export function isBrushTool(tool = currentTool) {
  return tool === 'land' || tool === 'biome' || tool === 'gasband' || tool === 'gaswhirl';
}

export const raycaster = new THREE.Raycaster();
export const pointer = new THREE.Vector2();

// Brush cursor — a thin ring oriented to the surface tangent plane.
export const brushRingGeo = new THREE.RingGeometry(0.95, 1.0, 64);
export const brushRingMat = new THREE.MeshBasicMaterial({
  color: 0xffffff,
  side: THREE.DoubleSide,
  transparent: true,
  opacity: 0.9,
  depthWrite: false,
  depthTest: false,
});
export const brushRing = new THREE.Mesh(brushRingGeo, brushRingMat);
brushRing.renderOrder = 999;
brushRing.visible = false;
scene.add(brushRing);

export function updateBrushRing(hitWorld, hitNormalWorld, radiusWorld) {
  brushRing.position.copy(hitWorld);
  brushRing.lookAt(hitWorld.clone().add(hitNormalWorld));
  brushRing.position.addScaledVector(hitNormalWorld, 0.02);
  brushRing.scale.setScalar(radiusWorld);
  brushRing.visible = true;
}

// arcLen ≈ angularRadius * R, where R is the radial distance at the hit.
export function brushArcWorldRadius(hitRadius) {
  return brushRadius * hitRadius;
}

