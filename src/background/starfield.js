// Background starfield points (fades during surface daylight).
import * as THREE from 'three';
import { scene } from '../core/scene.js';

// ====== 19. Starfield ======
export const starCount = 2000;
export const starPositions = new Float32Array(starCount * 3);
// Stars sit at a large radius so they read as a backdrop even when the
// system-view camera is pulled out hundreds of units to frame all planets.
for (let i = 0; i < starCount; i++) {
  const theta = Math.random() * Math.PI * 2;
  const phi = Math.acos(2 * Math.random() - 1);
  const r = 2200;
  starPositions[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
  starPositions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
  starPositions[i * 3 + 2] = r * Math.cos(phi);
}
export const starGeo = new THREE.BufferGeometry();
starGeo.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
export const starMat = new THREE.PointsMaterial({
  color: 0xffffff,
  size: 1.6,
  sizeAttenuation: false,
  transparent: true,
  opacity: 0.95,
  depthWrite: false,
  fog: false,
});
export const stars = new THREE.Points(starGeo, starMat);
scene.add(stars);

