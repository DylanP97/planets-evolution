import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export const scene = new THREE.Scene();
scene.background = new THREE.Color(0x02030a);

export const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 7000);
camera.position.set(0, 15, 28);

export const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('c'), antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
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
