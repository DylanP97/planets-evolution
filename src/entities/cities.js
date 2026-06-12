import { setFocusedCity } from '../modes/focus.js';

import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as THREE from 'three';
import { COL } from '../core/constants.js';
import { sunMesh } from '../core/sun.js';
import { cities, focusedBody } from '../framework/state.js';
import { focusedCity, setCityFocus } from '../modes/focus.js';
import { focusNameEl } from '../ui/controls.js';

// ====== 18. Cities ======
// Cities are pinned to a body by a unit-direction `localPos`. Each settlement
// is a cloned `lunar_base.glb` parented to body.group (Y-up sits on the
// surface along localPos). Day/night dimming is applied in updateCityMarkers().
export const CITY_BASE_SIZE = 0.5;   // longest axis at scale 1 (readable on r≈12 bodies)
export const CITY_SURFACE_LIFT = 0.08;
// cities[] itself lives in framework/state.js
const _cityUp = new THREE.Vector3(0, 1, 0);

export let cityTemplate = null;
export let cityTemplateLoading = null;

export function loadCityTemplate() {
  if (cityTemplate) return Promise.resolve(cityTemplate);
  if (cityTemplateLoading) return cityTemplateLoading;
  const loader = new GLTFLoader();
  cityTemplateLoading = new Promise((resolve, reject) => {
    loader.load(
      'lunar_base.glb',
      (gltf) => {
        const root = gltf.scene;
        const bbox = new THREE.Box3().setFromObject(root);
        const size = bbox.getSize(new THREE.Vector3());
        const longest = Math.max(size.x, size.y, size.z) || 1;
        root.scale.multiplyScalar(CITY_BASE_SIZE / longest);
        // Re-seat so the model's bottom rests on y=0 (local "ground").
        const grounded = new THREE.Box3().setFromObject(root);
        const center = grounded.getCenter(new THREE.Vector3());
        root.position.x -= center.x;
        root.position.z -= center.z;
        root.position.y -= grounded.min.y;
        cityTemplate = root;
        resolve(root);
      },
      undefined,
      (err) => {
        console.error('[city] failed to load lunar_base.glb', err);
        reject(err);
      }
    );
  });
  return cityTemplateLoading;
}

export function disposeCityMesh(mesh) {
  mesh.traverse((obj) => {
    if (obj.isMesh) {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach(m => m.dispose());
      }
    }
  });
}

export function setCityMeshOpacity(mesh, opacity) {
  mesh.traverse((obj) => {
    if (!obj.isMesh || !obj.material) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    mats.forEach((m) => {
      m.transparent = true;
      m.opacity = opacity;
    });
  });
}

export function orientCityMesh(city) {
  const n = city.localPos;
  if (n.lengthSq() < 1e-8) return;
  city.mesh.quaternion.setFromUnitVectors(_cityUp, n);
}

export function createCityMarker() {
  const group = new THREE.Group();
  const geo = new THREE.BoxGeometry(0.12, 0.12, 0.12);
  const mat = new THREE.MeshBasicMaterial({ color: COL.cityLights });
  group.add(new THREE.Mesh(geo, mat));
  return group;
}

export function mountCityModel(group) {
  while (group.children.length) group.remove(group.children[0]);
  const clone = cityTemplate.clone(true);
  group.add(clone);
}

export function addCity(body, name, localPos) {
  const city = {
    body,
    name,
    localPos: localPos.clone().normalize(),
    mesh: createCityMarker(),
  };
  body.group.add(city.mesh);
  cities.push(city);
  updateCityMarkers();
  renderCityList();

  loadCityTemplate().then(() => {
    if (!cities.includes(city)) return;
    mountCityModel(city.mesh);
    updateCityMarkers();
  }).catch(() => {
    if (!cities.includes(city)) return;
    // Placeholder cube from createCityMarker() already visible.
  });
}

export function updateCityMarkers() {
  const sunWorld = new THREE.Vector3();
  sunMesh.getWorldPosition(sunWorld);
  const planetCenter = new THREE.Vector3();
  const cityWorld = new THREE.Vector3();
  cities.forEach(city => {
    const body = city.body;
    const r = body.baseRadius + CITY_SURFACE_LIFT;
    city.mesh.position.copy(city.localPos).multiplyScalar(r);
    orientCityMesh(city);

    // Day/night relative to *this* planet's sun direction (matters now that
    // planets orbit — direction from planet center to sun varies).
    city.mesh.getWorldPosition(cityWorld);
    body.group.getWorldPosition(planetCenter);
    const toSun = sunWorld.clone().sub(planetCenter).normalize();
    const surfaceNormal = cityWorld.clone().sub(planetCenter).normalize();
    const dot = surfaceNormal.dot(toSun);
    setCityMeshOpacity(city.mesh, dot < 0.1 ? 1.0 : 0.35);
  });
}

export function renderCityList() {
  const list = document.getElementById('cityList');
  list.innerHTML = cities.map((c, i) => {
    const focusedCls = focusedCity === c ? ' focused' : '';
    return `
    <div class="city-row" data-index="${i}">
      <span>${c.name} (${c.body.name})</span>
      <button class="city-focus focus-btn small-btn${focusedCls}" type="button">Focus</button>
      <button class="city-remove" type="button" aria-label="Remove city">×</button>
    </div>`;
  }).join('');
  list.querySelectorAll('.city-row').forEach((row) => {
    const index = parseInt(row.dataset.index, 10);
    row.querySelector('.city-focus').onclick = () => {
      const c = cities[index];
      if (c) setCityFocus(c);
    };
    row.querySelector('.city-remove').onclick = () => removeCityAt(index);
  });
}

export function removeCityAt(index) {
  const city = cities[index];
  if (!city) return;
  if (focusedCity === city) {
    setFocusedCity(null);
    focusNameEl.textContent = focusedBody ? focusedBody.name : '';
  }
  city.body.group.remove(city.mesh);
  disposeCityMesh(city.mesh);
  cities.splice(index, 1);
  renderCityList();
}
// Kept for backwards-compat with any inline onclick already in the DOM.
window.removeCity = removeCityAt;

loadCityTemplate();

