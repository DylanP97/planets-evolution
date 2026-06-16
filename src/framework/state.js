import * as THREE from 'three';
import { BIOME } from '../core/constants.js';

// Central registry of shared mutable state. ES-module live bindings let any
// module READ these directly, but only this module may ASSIGN them — other
// modules must call the set* functions (assigning to an import is a TypeError).
// Plain arrays/objects (bodies, gasPaintColor, …) are mutated in place and
// need no setters.

export const bodies = [];
export const planets = [];
export const moons = [];
export const probes = [];
export const cities = [];

// The conventional "home"/default body (Earth in Sol; planets[0] elsewhere).
// Re-pointed by each bootstrap*System(), so it must be a reassignable `let`
// — when a system is torn down and rebuilt the old body is disposed.
export let planet = null;
export function setPlanet(v) { planet = v; }

// The archetype the UI is currently editing; regenerateBody reads it off
// module scope (spawn paths flip it briefly around regenerateBody calls).
export let currentArchetype = 'terrestrial';
export function setCurrentArchetype(v) { currentArchetype = v; }

export let climateReady = false;
export function setClimateReady(v) { climateReady = v; }

export let focusedBody = null;
export function setFocusedBody(v) { focusedBody = v; }

export let viewMode = 'orbit'; // 'orbit' | 'pick' | 'surface'
export function setViewMode(v) { viewMode = v; }

// City / probe focus. These only flag WHICH entity is focused — the
// camera-moving entry points (setFocus / setCityFocus / setProbeFocus, which
// also clear each other and re-render the UI) live in modes/focus.js.
// When a probe is focused, focusedBody stays on its host planet so the left
// panel keeps that planet's context; focusedProbe distinguishes the two.
export let focusedCity = null;
export function setFocusedCity(v) { focusedCity = v; }

export let focusedProbe = null;
export function setFocusedProbe(v) { focusedProbe = v; }

// Seed of the last "Generate World" run on the home planet — the fallback
// shown in the seed input / info panel when a body has no own currentSeed.
export let planetCurrentSeed = 'planet';
export function setPlanetCurrentSeed(v) { planetCurrentSeed = v; }

// ── Brush / tool state (initial values match the original section 14) ──
export let brushRadius   = 0.25; // radians of arc on the unit sphere
export function setBrushRadius(v) { brushRadius = v; }

export let brushStrength = 1.5;  // height units per second of holding
export function setBrushStrength(v) { brushStrength = v; }

export let brushRaise    = true; // false = lower
export function setBrushRaise(v) { brushRaise = v; }

export let paintMode     = true; // when true, right-drag paints; when false, right-drag pans
export function setPaintMode(v) { paintMode = v; }

export let paused        = false;
export function setPaused(v) { paused = v; }

export let currentTool   = 'none'; // 'land' | 'biome' | 'city' | 'gasband' | 'gaswhirl' | 'none'
export function setCurrentTool(v) { currentTool = v; }

export let selectedBiome = BIOME.AUTO;
export function setSelectedBiome(v) { selectedBiome = v; }

// Selected biome (drives gasPaintColor + bandBiomes tagging on stroke).
export let selectedGasBiomeId = null;
export function setSelectedGasBiomeId(v) { selectedGasBiomeId = v; }

// Selected color for the atmospheric-band brush on full-gas planets.
export const gasPaintColor = new THREE.Color('#cc9966');

// Active sub-mode for gas paint: 'gasband' = drag-paint latitude bands;
// 'gaswhirl' = press-and-hold to grow a whirlpool that wraps surrounding
// bands around the click center (no overpaint — just direction warp).
export let gasPaintMode  = 'gasband';
export function setGasPaintModeState(v) { gasPaintMode = v; }

// The whirlpool created on the current drag stroke; grown each frame in
// applyBrushToBody while the user holds the right button.
export let activeVortex  = null;
export function setActiveVortex(v) { activeVortex = v; }

// ── Active paint stroke (written by interaction/pointer.js) ──
export let isPainting = false;
export function setIsPainting(v) { isPainting = v; }

export let activeBrushBody = null;  // body the current drag stroke is editing
export function setActiveBrushBody(v) { activeBrushBody = v; }

export let lastHitLocal = null;     // hit point in activeBrushBody's mesh-local space
export function setLastHitLocal(v) { lastHitLocal = v; }
