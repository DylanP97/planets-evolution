// Tiny synchronous pub/sub used to break upward import edges: low-layer
// modules (entities, modes/focus, system) emit events instead of importing
// ui/ render functions, and ui/wire-up.js subscribes the handlers once all
// modules have evaluated. This module imports nothing, so emitting from
// anywhere can never create an import cycle.
//
// Events in use (all subscribed in ui/wire-up.js):
//   'focus:changed'        focus moved to a body/city/probe → re-render panels
//   'focus:system'         request system-wide focus (nav setSystemFocus)
//   'nav:render'           refresh the bottom-nav focus card
//   'ui:info'              refresh the right-hand info panel
//   'ui:render-city-list'  refresh the colonies list
//   'ui:satellite-lists'   refresh the moons + probes lists
//   'ui:biome-tools'       rebuild the biome <select> for the focused body
//   'ui:active-tool'       re-resolve the current brush tool
//   'ui:left-panel'        re-apply focus context to the left panel
//   'ui:sync-rings'        re-sync the ring sliders (enable toggle greys intensity)
const handlers = new Map();

export function on(event, fn) {
  let list = handlers.get(event);
  if (!list) { list = []; handlers.set(event, list); }
  list.push(fn);
}

export function emit(event, ...args) {
  const list = handlers.get(event);
  if (!list) return;          // pre-wire-up emissions are no-ops by design
  for (const fn of list) fn(...args);
}
