// Shared marker meshes for the 3D globe widgets (minimap.js + planet-map.js):
// one avatar arrow + one target-waypoint highlight ring, both real meshes
// parented to the visited body's group (like a location's own marker in
// entities/locations.js) so either widget's camera just sees them as part
// of the live scene — no per-widget duplicate geometry. Attached/detached
// alongside the other surface fields (grass, rocks, props, ...) in mode.js.
import * as THREE from 'three';
import { targetLocation } from '../../framework/state.js';
import { surfaceState } from './core.js';

const AVATAR_MARKER_SCALE = 0.06;   // fraction of body.baseRadius
const AVATAR_MARKER_LIFT  = 0.10;
const TARGET_MARKER_SCALE = 0.09;
const TARGET_MARKER_LIFT  = 0.07;

let avatarMarker = null;
let targetMarker = null;
let markerBody = null;

const _dir   = new THREE.Vector3();
const _fwd   = new THREE.Vector3();
const _right = new THREE.Vector3();
const _quat  = new THREE.Quaternion();
const _m4    = new THREE.Matrix4();
const _zAxis = new THREE.Vector3(0, 0, 1);

function buildAvatarMarker() {
  // ConeGeometry's apex sits on local +Y by default — left as-is, since
  // updateGlobeMarkers() below maps local Y to world "forward" directly, so
  // the tip reads as a heading arrow when the top-down minimap camera looks
  // straight down the surface normal at it.
  const geo = new THREE.ConeGeometry(0.55, 1.4, 4);
  const mat = new THREE.MeshBasicMaterial({ color: 0x00f2ff, depthTest: false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 999;
  return mesh;
}

function buildTargetMarker() {
  const geo = new THREE.RingGeometry(0.6, 1, 24);
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffcc33, side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthTest: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 999;
  mesh.visible = false;
  return mesh;
}

export function attachGlobeMarkers(body) {
  detachGlobeMarkers();
  markerBody = body;
  avatarMarker = buildAvatarMarker();
  avatarMarker.scale.setScalar(body.baseRadius * AVATAR_MARKER_SCALE);
  body.group.add(avatarMarker);
  targetMarker = buildTargetMarker();
  targetMarker.scale.setScalar(body.baseRadius * TARGET_MARKER_SCALE);
  body.group.add(targetMarker);
}

export function detachGlobeMarkers() {
  if (avatarMarker) {
    if (avatarMarker.parent) avatarMarker.parent.remove(avatarMarker);
    avatarMarker.geometry.dispose();
    avatarMarker.material.dispose();
    avatarMarker = null;
  }
  if (targetMarker) {
    if (targetMarker.parent) targetMarker.parent.remove(targetMarker);
    targetMarker.geometry.dispose();
    targetMarker.material.dispose();
    targetMarker = null;
  }
  markerBody = null;
}

// Per-frame upkeep, called from the surface-mode block in main.js. Cheap:
// two mesh transforms, no raycasts.
export function updateGlobeMarkers() {
  if (!markerBody || markerBody !== surfaceState.body) return;

  _dir.copy(surfaceState.localUp).normalize();
  avatarMarker.position.copy(_dir).multiplyScalar(surfaceState.groundRadius + AVATAR_MARKER_LIFT);
  // Orient the cone so its tip (local +Y, see buildAvatarMarker) points along
  // faceLocal (world "forward") with local +Z riding the surface normal —
  // reads as a heading arrow from a top-down camera looking down -Z.
  _fwd.copy(surfaceState.faceLocal).normalize();
  _right.crossVectors(_fwd, _dir).normalize();
  _fwd.crossVectors(_dir, _right).normalize();
  _m4.makeBasis(_right, _fwd, _dir);
  _quat.setFromRotationMatrix(_m4);
  avatarMarker.quaternion.copy(_quat);

  const showTarget = !!(targetLocation && targetLocation.body === markerBody);
  targetMarker.visible = showTarget;
  if (showTarget) {
    _dir.copy(targetLocation.localPos).normalize();
    targetMarker.position.copy(_dir).multiplyScalar(markerBody.baseRadius + TARGET_MARKER_LIFT);
    targetMarker.quaternion.setFromUnitVectors(_zAxis, _dir);
  }
}
