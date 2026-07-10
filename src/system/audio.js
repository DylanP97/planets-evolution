// Procedural ambience: a sci-fi drone bed (+ periodic cinematic swells) while
// in orbit, biome-driven nature beds (water/lush/arid/ice) while walking a
// surface. No audio assets exist in the repo, so everything here is
// synthesized with raw Web Audio nodes — no files to fetch, no build step.
// Crossfades are eased per frame like the app's other "reveal" ramps
// (ground.js, footprints.js) rather than snapping.
import * as THREE from 'three';
import { viewMode } from '../framework/state.js';
import { groundBiomeOfFace, FACE_BIOME } from '../framework/body.js';
import { surfaceState } from '../modes/surface/core.js';
import { groundRaycaster } from '../modes/surface/walk.js';

let ctx = null;
let master = null;
let orbitGain = null;
let orbitShimmerTimer = 0, orbitNextShimmer = 3;
let swellTimer = 0, nextSwell = 25 + Math.random() * 20; // first swell comes a bit sooner
const bedGains = {};           // 'water' | 'lush' | 'arid' | 'ice' -> GainNode
let noiseBuffer = null;        // shaped (brown-ish) noise — gentler than raw white noise
let currentBed = 'arid';
let bedSampleAccum = 0;
let chirpTimer = 0, nextChirp = 3;

// Per-bed target gain when active (water sits lower — it was overpowering
// even correctly triggered, per playtest feedback).
const BED_TARGET = { water: 0.4, lush: 0.55, arid: 0.4, ice: 0.45 };

const _auOrigin = new THREE.Vector3();
const _auDir = new THREE.Vector3();

// Lazily create the AudioContext + graph on the first call after a user
// gesture has occurred (autoplay policies block audio before that).
function ensureContext() {
  if (ctx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = 0.5;
  master.connect(ctx.destination);
  buildNoiseBuffer();
  buildOrbitPad();
  buildSurfaceBeds();
}

// Brown-ish noise (integrated white noise, leaky so it can't wander off):
// naturally rolls off the harsh top end that raw white noise has, so even a
// bright bandpass on top reads as "wind/water" instead of radio static.
function buildNoiseBuffer() {
  const len = ctx.sampleRate * 2;
  noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = noiseBuffer.getChannelData(0);
  let acc = 0;
  for (let i = 0; i < len; i++) {
    acc = (acc + (Math.random() * 2 - 1) * 0.1) * 0.98;
    d[i] = acc * 3.2; // renormalize — the leaky integration shrinks amplitude a lot
  }
}

function loopingNoise() {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  src.loop = true;
  src.start();
  return src;
}

// ── Orbit: a slow, detuned sci-fi drone chord + sparse high "shimmer"
// plucks + an occasional grandiose swell (a wider, louder chord that rises
// and falls over ~20s, like a film score sting) layered on top at intervals.
function buildOrbitPad() {
  orbitGain = ctx.createGain();
  orbitGain.gain.value = 0;
  orbitGain.connect(master);
  const freqs = [55, 82.4, 110, 164.8]; // A1 E2 A2 E3
  freqs.forEach((f, i) => {
    const osc = ctx.createOscillator();
    osc.type = i % 2 === 0 ? 'sine' : 'triangle';
    osc.frequency.value = f;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 900;
    const g = ctx.createGain();
    g.gain.value = 0.2 / (i + 1);
    osc.connect(filter).connect(g).connect(orbitGain);
    osc.start();
    // Slow detune LFO so the chord breathes instead of sitting static.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.025 + i * 0.011;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 4 + i;
    lfo.connect(lfoGain).connect(osc.detune);
    lfo.start();
  });
}

function plinkShimmer() {
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = 500 + Math.random() * 900;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.05, t + 0.06);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 2.4);
  osc.connect(g).connect(orbitGain);
  osc.start(t);
  osc.stop(t + 2.5);
}

// A wide, slow-swelling chord (A minor-ish stack, an octave+fifth up from
// the base drone) that rises over ~8s, holds, and fades over ~10s — a
// "grandiose movie" moment riding on top of the steady ambient bed rather
// than replacing it.
function playCinematicSwell() {
  const t = ctx.currentTime;
  const swellBus = ctx.createGain();
  swellBus.gain.value = 0;
  swellBus.connect(master);
  const attack = 7, hold = 6, release = 10;
  swellBus.gain.setValueAtTime(0, t);
  swellBus.gain.linearRampToValueAtTime(0.22, t + attack);
  swellBus.gain.setValueAtTime(0.22, t + attack + hold);
  swellBus.gain.linearRampToValueAtTime(0, t + attack + hold + release);
  const total = attack + hold + release;

  const chordFreqs = [220, 261.6, 329.6, 440, 523.3]; // A3 C4 E4 A4 C5 — wide, consonant
  chordFreqs.forEach((f, i) => {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = f;
    osc.detune.value = (Math.random() - 0.5) * 6;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 2000;
    const g = ctx.createGain();
    g.gain.value = 0.5 / (i + 1.5);
    osc.connect(filter).connect(g).connect(swellBus);
    osc.start(t);
    osc.stop(t + total + 0.5);
  });
  // A soft low "impact" swell under the chord for weight.
  const sub = ctx.createOscillator();
  sub.type = 'sine';
  sub.frequency.value = 55;
  const subGain = ctx.createGain();
  subGain.gain.value = 0.5;
  sub.connect(subGain).connect(swellBus);
  sub.start(t);
  sub.stop(t + total + 0.5);
}

// ── Surface: four filtered-noise "beds" crossfaded by the biome underfoot.
// Each gets its own slow amplitude LFO ("gusting") so they read as moving
// air/water rather than a flat, static hiss.
function buildSurfaceBeds() {
  for (const key of ['water', 'lush', 'arid', 'ice']) {
    const g = ctx.createGain();
    g.gain.value = 0;
    g.connect(master);
    bedGains[key] = g;
  }

  function gustingBed(filterType, freq, q, baseAmp, gustRate, gustDepth, dest) {
    const filter = ctx.createBiquadFilter();
    filter.type = filterType; filter.frequency.value = freq; filter.Q.value = q;
    const smooth = ctx.createBiquadFilter();  // extra gentle top-end shave
    smooth.type = 'lowpass'; smooth.frequency.value = Math.min(freq * 1.4, 3200);
    const amp = ctx.createGain(); amp.gain.value = baseAmp;
    const lfo = ctx.createOscillator(); lfo.frequency.value = gustRate;
    const lfoGain = ctx.createGain(); lfoGain.gain.value = gustDepth;
    lfo.connect(lfoGain).connect(amp.gain);
    lfo.start();
    loopingNoise().connect(filter).connect(smooth).connect(amp).connect(dest);
  }

  gustingBed('lowpass', 550, 0.5, 0.34, 0.10, 0.10, bedGains.water);
  gustingBed('bandpass', 900, 0.6, 0.16, 0.07, 0.05, bedGains.lush);
  gustingBed('bandpass', 1100, 0.5, 0.09, 0.05, 0.04, bedGains.arid);
  gustingBed('lowpass', 320, 0.8, 0.18, 0.06, 0.05, bedGains.ice);
}

function playChirp() {
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  const base = 1400 + Math.random() * 1200;
  osc.frequency.setValueAtTime(base, t);
  osc.frequency.exponentialRampToValueAtTime(base * (0.6 + Math.random() * 0.5), t + 0.09);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(0.06, t + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
  osc.connect(g).connect(bedGains.lush);
  osc.start(t);
  osc.stop(t + 0.18);
}

function biomeCategory(body, face) {
  const b = groundBiomeOfFace(body, face);
  switch (b) {
    case FACE_BIOME.COAST: return 'water';
    case FACE_BIOME.GRASS:
    case FACE_BIOME.FOREST:
    case FACE_BIOME.JUNGLE:
    case FACE_BIOME.TUNDRA: return 'lush';
    case FACE_BIOME.ICE: return 'ice';
    default: return 'arid'; // desert + bare rock/peaks
  }
}

function sampleBedCategory() {
  const body = surfaceState.body;
  if (!body) return 'arid';
  if (surfaceState.swimming) return 'water';
  body.mesh.updateMatrixWorld();
  _auDir.copy(surfaceState.localUp).multiplyScalar(-1).transformDirection(body.mesh.matrixWorld).normalize();
  _auOrigin.copy(surfaceState.localUp).multiplyScalar(surfaceState.groundRadius + 2).applyMatrix4(body.mesh.matrixWorld);
  groundRaycaster.set(_auOrigin, _auDir);
  const hits = groundRaycaster.intersectObject(body.mesh, false);
  if (!hits.length) return currentBed;
  return biomeCategory(body, hits[0].face);
}

// Unlocks the (autoplay-gated) AudioContext on the first real user gesture.
// Self-installing so main.js doesn't need a separate wiring step.
function installGestureUnlock() {
  const unlock = () => {
    ensureContext();
    if (ctx && ctx.state === 'suspended') ctx.resume();
    if (ctx) { window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); }
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);
}
installGestureUnlock();

// Console diagnostic, matching the grassDiag/footDiag convention.
window.audioDiag = () => {
  if (!ctx) return 'audio context not unlocked yet (click or press a key first)';
  const beds = {};
  for (const k in bedGains) beds[k] = +bedGains[k].gain.value.toFixed(3);
  return { state: ctx.state, orbitGain: +orbitGain.gain.value.toFixed(3), currentBed, beds, nextSwellIn: +(nextSwell - swellTimer).toFixed(1) };
};
// Trigger a swell on demand, for auditioning it without waiting out the timer.
window.audioSwellNow = () => { if (ctx) playCinematicSwell(); };

export function updateAmbientAudio(dt) {
  if (!ctx) return;               // no gesture yet — audio still locked
  const inSurface = viewMode === 'surface' && !!surfaceState.body;

  const orbitTarget = inSurface ? 0 : 0.55;
  orbitGain.gain.value += (orbitTarget - orbitGain.gain.value) * Math.min(1, dt * 0.6);

  if (!inSurface) {
    for (const key in bedGains) {
      const g = bedGains[key];
      g.gain.value += (0 - g.gain.value) * Math.min(1, dt * 1.2);
    }
    orbitShimmerTimer += dt;
    if (orbitShimmerTimer > orbitNextShimmer) {
      orbitShimmerTimer = 0; orbitNextShimmer = 4 + Math.random() * 6;
      plinkShimmer();
    }
    swellTimer += dt;
    if (swellTimer > nextSwell) {
      swellTimer = 0; nextSwell = 40 + Math.random() * 35; // roughly every 40-75s
      playCinematicSwell();
    }
    return;
  }

  bedSampleAccum += dt;
  if (bedSampleAccum > 0.4) { bedSampleAccum = 0; currentBed = sampleBedCategory(); }
  for (const key in bedGains) {
    const target = (key === currentBed) ? BED_TARGET[key] : 0;
    const g = bedGains[key];
    g.gain.value += (target - g.gain.value) * Math.min(1, dt * 1.2);
  }

  if (currentBed === 'lush') {
    chirpTimer += dt;
    if (chirpTimer > nextChirp) { chirpTimer = 0; nextChirp = 2 + Math.random() * 4; playChirp(); }
  }
}
