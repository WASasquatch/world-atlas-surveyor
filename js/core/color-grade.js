// Colour-grade / gradient-map utilities — shared by the GL renderer, the
// classic CPU renderer, and the export card so all three stay pixel-consistent.
//
// A GRADIENT MAP (Photoshop-style) remaps an image by LUMINANCE through a colour
// ramp: dark pixels take the ramp's left end, bright pixels its right. We build
// that ramp as a 256×1 lookup table (LUT) from a user-supplied image (its
// columns are box-averaged into a shadows→highlights strip) or from hand
// authored stops. The GL path samples the LUT as a texture in-shader; the CPU
// path indexes the same Uint8 array. Both use the identical Rec.709 luma
// weights and mix maths so the viewport, classic mode, and the card match.
//
// This is an explicit user override applied as a pure post-process on the final
// albedo — it never enters Planet's seed-deterministic bake or the RNG stream.

import * as THREE from '../vendor/three.module.min.js';

// Rec.709 luma — MUST match the GLSL applyGradient() weights exactly.
const LUMA = [0.2126, 0.7152, 0.0722];

// Build a 256×1 LUT from any drawable image source (ImageBitmap / HTMLImage /
// canvas). Returns { tex, lut }: `tex` is a 256×1 RGBA DataTexture for GL,
// `lut` is a Uint8Array(256*3) for the CPU / export paths.
function buildGradientLut(source) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 1;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;          // box-average the columns into a strip
  ctx.drawImage(source, 0, 0, 256, 1);
  const px = ctx.getImageData(0, 0, 256, 1).data;   // RGBA, length 1024
  const lut = new Uint8Array(256 * 3);
  const rgba = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    lut[i * 3] = px[i * 4]; lut[i * 3 + 1] = px[i * 4 + 1]; lut[i * 3 + 2] = px[i * 4 + 2];
    rgba[i * 4] = px[i * 4]; rgba[i * 4 + 1] = px[i * 4 + 1]; rgba[i * 4 + 2] = px[i * 4 + 2]; rgba[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(rgba, 256, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return { tex, lut };
}

// Build a LUT from hand-authored stops [{ t: 0..1, rgb: [r,g,b] }] via a canvas
// linear gradient — same 256×1 output as buildGradientLut.
function buildGradientLutFromStops(stops) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 1;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 256, 0);
  for (const s of stops) g.addColorStop(Math.max(0, Math.min(1, s.t)), `rgb(${s.rgb[0]|0},${s.rgb[1]|0},${s.rgb[2]|0})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 1);
  return buildGradientLut(c);
}

// CPU / export twin of the GLSL applyGradient(): remap one 0-255 RGB triple by
// luminance through `lut`, blended by `mix` (0 = original, 1 = full grade).
// Returns a fresh [r,g,b] (0-255 floats). Pure IEEE maths (no Math.pow/hypot).
function applyGradientRGB(r, g, b, lut, mix, scale, lo, hi) {
  if (!lut || mix <= 0) return [r, g, b];
  let L = (r * LUMA[0] + g * LUMA[1] + b * LUMA[2]) / 255;
  L = L < 0 ? 0 : L > 1 ? 1 : L;
  // Match the GLSL applyGradient(): luminance spread (uGradientScale) then the
  // per-class sub-range remap (lo..hi) so classes map to distinct ramp slices.
  if (scale && scale !== 1) { L = (L - 0.5) / scale + 0.5; L = L < 0 ? 0 : L > 1 ? 1 : L; }
  if (lo != null && hi != null) { L = lo + (hi - lo) * L; L = L < 0 ? 0 : L > 1 ? 1 : L; }
  const i = (L * 255) | 0;
  const mr = lut[i * 3], mg = lut[i * 3 + 1], mb = lut[i * 3 + 2];
  return [r + (mr - r) * mix, g + (mg - g) * mix, b + (mb - b) * mix];
}

export { buildGradientLut, buildGradientLutFromStops, applyGradientRGB, LUMA };
