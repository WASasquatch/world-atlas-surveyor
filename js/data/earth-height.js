// Earth preset — grayscale equirectangular ELEVATION map (GEBCO composite),
// loaded OFF DISK from assets/earth-height.png (converted from the source
// maps/gebco_composite_4k.tif) rather than embedded as base64. Brighter = higher
// (BlackIsZero: deep ocean → dark, peaks → white), with real bathymetry.
//
// Populated asynchronously by decodeEarthHeight(); importers see the update
// through the live module binding. If the PNG is missing (e.g. not yet added),
// decode returns false and planet.js falls back to the 1-bit EARTH_MASK.
//
// The map is bilinearly sampled at the generation grid, so it AUTOMATICALLY
// scales to whatever MAP RES is selected (768 … 2k) — a 4k source super-samples
// cleanly down to any generation resolution.

let EARTH_HEIGHT = null;          // Float32Array length W*H, grayscale 0..1
let EARTH_HEIGHT_W = 0;
let EARTH_HEIGHT_H = 0;
let EARTH_SEA = 0.5;              // auto-detected sea-level gray value (0..1)

// Resolve relative to THIS module so it works regardless of where the app is
// served from (the app is served over HTTP by serve.sh, so fetch() works).
const HEIGHT_URL = new URL('../../assets/earth-height.png', import.meta.url);

async function decodeEarthHeight() {
  try {
    const res = await fetch(HEIGHT_URL);
    if (!res.ok) return false;                       // no file yet → mask fallback
    const bmp = await createImageBitmap(await res.blob());
    const w = bmp.width, h = bmp.height;
    const cv = (typeof OffscreenCanvas !== 'undefined')
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement('canvas'), { width: w, height: h });
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    if (bmp.close) bmp.close();
    const px = ctx.getImageData(0, 0, w, h).data;    // RGBA (grayscale → R=G=B)

    const out = new Float32Array(w * h);
    // Sea level = the grayscale value below which ~71% of the map's AREA is
    // "ocean" (Earth's ocean fraction). Weight rows by cos(lat) so the poles —
    // hugely over-sampled in an equirect image — don't skew the estimate. This
    // self-calibrates to any real Earth map's black-point / contrast.
    const hist = new Float64Array(256);
    let wsum = 0;
    for (let j = 0; j < h; j++) {
      const lat = (j + 0.5) / h * Math.PI - Math.PI * 0.5;
      const wl = Math.cos(lat);
      const row = j * w;
      for (let i = 0; i < w; i++) {
        const g = px[(row + i) * 4];
        out[row + i] = g / 255;
        hist[g] += wl;
      }
      wsum += wl * w;
    }
    let acc = 0, seaByte = 128;
    const target = wsum * 0.71;
    for (let b = 0; b < 256; b++) { acc += hist[b]; if (acc >= target) { seaByte = b; break; } }

    EARTH_HEIGHT = out;
    EARTH_HEIGHT_W = w;
    EARTH_HEIGHT_H = h;
    EARTH_SEA = seaByte / 255;
    return true;
  } catch (e) {
    console.warn('Earth height decode failed:', e);
    return false;
  }
}

// Bilinear sample at UV (u,v in 0..1). Wraps in U (longitude), clamps in V
// (latitude). Returns the grayscale elevation 0..1.
function sampleEarthHeight(u, v) {
  if (!EARTH_HEIGHT) return EARTH_SEA;
  const W = EARTH_HEIGHT_W, H = EARTH_HEIGHT_H;
  u -= Math.floor(u);
  v = v < 0 ? 0 : (v > 1 ? 1 : v);
  const fx = u * W - 0.5, fy = v * (H - 1);
  let i0 = Math.floor(fx), j0 = Math.floor(fy);
  const tx = fx - i0, ty = fy - j0;
  let i1 = i0 + 1;
  i0 = ((i0 % W) + W) % W;
  i1 = ((i1 % W) + W) % W;
  if (j0 < 0) j0 = 0;
  let j1 = j0 + 1; if (j1 > H - 1) j1 = H - 1;
  const a = EARTH_HEIGHT[j0 * W + i0], b = EARTH_HEIGHT[j0 * W + i1];
  const c = EARTH_HEIGHT[j1 * W + i0], d = EARTH_HEIGHT[j1 * W + i1];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

// Current auto-detected sea-level gray value (0..1).
function earthSeaGray() { return EARTH_SEA; }

export { EARTH_HEIGHT, EARTH_HEIGHT_W, EARTH_HEIGHT_H, decodeEarthHeight, sampleEarthHeight, earthSeaGray };
