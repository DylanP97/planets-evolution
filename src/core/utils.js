// Tiny shared math helpers.
export function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// Typed-array <-> base64 codec, used by system/save.js to embed a body's
// heights/biomes into a save-file JSON blob. Chunked instead of a single
// String.fromCharCode(...bytes) spread — a moon's ~41K vertices produce a
// byte array well past the engine argument-spread limit.
export function encodeTypedArray(arr) {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function decodeBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function decodeFloat32Array(b64) {
  const bytes = decodeBytes(b64);
  return new Float32Array(bytes.buffer);
}

export function decodeUint8Array(b64) {
  return decodeBytes(b64);
}
