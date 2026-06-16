// Three.js bootstrap: scene, camera, renderer, OrbitControls, the sun point
// light (+shadow map), ambient fill, moonlight rig, and the surface skylight.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export const scene = new THREE.Scene();
scene.background = new THREE.Color(0x02030a);

export const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 7000);
camera.position.set(0, 15, 28);

export const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('c'), antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
// Shadow map OFF. The Sun is a PointLight at the system origin, so its single
// shadow map has to span the WHOLE solar system (far = SUN_FAR ≈ 1400) at
// 1024². Up close on a surface that's one texel across the entire landscape,
// so the planet self-shadows into a big dark zone around the avatar by day
// (and the inverse, a pale zone, by night) that tracks the camera on every
// world. It resolves nothing useful at any zoom — rings draw their own
// shader-based planet shadow, and the avatar has a blob shadow — so we leave
// the shadow map disabled. (sun.castShadow below is then a no-op.)
renderer.shadowMap.enabled = false;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

export const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 0);
controls.mouseButtons = {
  LEFT: THREE.MOUSE.ROTATE,
  MIDDLE: THREE.MOUSE.DOLLY,
  RIGHT: null,
};

export const SUN_RADIUS = 18;
export const SUN_FAR    = 1400;

export const sun = new THREE.PointLight(0xfff1d4, 1.50, 0, 0);
sun.position.set(0, 0, 0);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.near = SUN_RADIUS + 0.5;
sun.shadow.camera.far  = SUN_FAR;
sun.shadow.bias        = -0.0005;
scene.add(sun);

export const ambientLight = new THREE.AmbientLight(0xd0d0ff, 0.04);
scene.add(ambientLight);

export const moonLight = new THREE.DirectionalLight(0xd0e7ff, 0.0);
scene.add(moonLight);
scene.add(moonLight.target);

// Surface-walk skylight from uncommitted changes
export const surfaceSkyLight = new THREE.HemisphereLight(0xffffff, 0x202020, 0.0);
scene.add(surfaceSkyLight);
