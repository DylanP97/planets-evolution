// Shared DOM element refs used across ui/ modules (and a few outside).
// This module imports nothing, so it can never sit inside an import cycle:
// any module may import these consts at module scope without TDZ risk.
// Elements used by only ONE module stay in that module — only refs that are
// imported across module boundaries belong here.
export const focusNameEl   = document.getElementById('focusName');
export const moonsListEl   = document.getElementById('moonsList');
export const addMoonBtn    = document.getElementById('addMoon');
export const probesListEl  = document.getElementById('probesList');
export const addProbeBtn   = document.getElementById('addProbe');
export const focusPlanetBtn= document.getElementById('focusPlanet');
export const locationNameInput = document.getElementById('locationNameInput');
export const planetListEl  = document.getElementById('planetList');
export const deployPlanetBtn = document.getElementById('deployPlanetBtn');
export const navNameEl     = document.getElementById('navFocusName');
export const navRandomBtn  = document.getElementById('navRandomBtn');
