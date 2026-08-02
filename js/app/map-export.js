// Layered equirectangular map export.
//
// Decomposes the current planet into separable layers (GROUND, VEGETATION,
// SNOW/ICE, WATER = rivers+oceans, CLOUDS) via Planet.bakeExportLayers(), then
// composites the SELECTED layers into a single transparent PNG. Coverage lives
// in each layer's alpha, so exporting one layer alone yields it on transparency;
// MASK mode ignores colour and emits a white-on-transparent coverage matte
// (flatten on black → the classic white-on-black mask). Baked at native
// 768×384 then smooth-upscaled to the chosen width via canvas drawImage.

// Physical composite order (bottom → top). CLOUDS always last.
const ORDER = ['ground', 'water', 'veg', 'snow', 'clouds'];

// Straight-alpha source-over of a layer (rgb defined everywhere, coverage in
// alpha) onto an accumulating float RGBA buffer.
function srcOver(dst, layer, sel, N) {
  const { rgb, alpha } = layer;
  for (let k = 0; k < N; k++) {
    const a = alpha[k] * sel;
    if (a <= 0) continue;
    const o = k * 3, d = k * 4;
    const ia = 1 - a;
    dst[d] = rgb[o] * a + dst[d] * ia;
    dst[d + 1] = rgb[o + 1] * a + dst[d + 1] * ia;
    dst[d + 2] = rgb[o + 2] * a + dst[d + 2] * ia;
    dst[d + 3] = a + dst[d + 3] * ia;
  }
}

// Read a live look-uniform defensively (only the GL renderer exposes .u).
function u(renderer, name, dflt) {
  const v = renderer && renderer.u && renderer.u[name];
  return (v && v.value != null) ? v.value : dflt;
}
function vec255(v, dflt) {
  if (v && typeof v.x === 'number') return [v.x * 255, v.y * 255, v.z * 255];
  if (Array.isArray(v)) return [v[0] * 255, v[1] * 255, v[2] * 255];
  return dflt;
}

export function exportMapLayers(renderer, opts = {}) {
  const planet = (renderer && (renderer.planet || renderer.currentPlanet)) || opts.planet;
  if (!planet || typeof planet.bakeExportLayers !== 'function') {
    throw new Error('No planet available for map export');
  }
  const sel = opts.layers || { ground: true, veg: true, snow: true, water: true, clouds: true };
  const mask = !!opts.mask;
  const width = Math.max(256, Math.min(4096, opts.width | 0 || 2048));
  const height = Math.round(width * planet.texH / planet.texW);   // 2:1 equirect

  // Supersample for anti-aliasing, then box-downsample to the target. The bake
  // now runs at the SUPERSAMPLED resolution (planet.bakeExportLayers evaluates
  // procedural detail at full res + crisp per-pixel coast/river thresholds), so
  // this replaces the old "bake 768 → blurry upscale" with a crisp AA'd render.
  // Cap the baked buffer at ~4096×2048 (memory): 2× SSAA up to 2048, 1× at 4096.
  const ss = width <= 2048 ? 2 : 1;
  const BW = width * ss, BH = height * ss, BN = BW * BH;

  // Gradient map (with per-class targeting) so the export matches the viewport.
  // The CPU-side LUT lives on renderer._grad.lut (set alongside the GL texture).
  let gradient = null;
  if (u(renderer, 'uHasGradient', 0) > 0.5 && renderer && renderer._grad && renderer._grad.lut) {
    const arr = (name, dflt) => { const v = renderer.u && renderer.u[name]; return (v && v.value) ? v.value.slice() : dflt; };
    gradient = {
      lut: renderer._grad.lut,
      mix: u(renderer, 'uGradientMix', 1),
      scale: u(renderer, 'uGradientScale', 1),
      enable: arr('uGradEnable', [1, 1, 1, 1, 1]),
      lo: arr('uGradLo', [0, 0, 0, 0, 0]),
      hi: arr('uGradHi', [1, 1, 1, 1, 1]),
    };
  }

  // Live-look values so the export tracks the current view.
  //
  // The TERRAFORM sliders re-classify the surface in the SHADER (sea level, ice
  // line, snow line, vegetation) without ever re-baking the planet's maps, so
  // the CPU bake has to be driven by the same live uniforms — otherwise raising
  // SEA gives you an ocean world on screen and the original continents in the
  // PNG. uTerraform is the renderer's own "live re-classification is on" flag;
  // while it's off those uniforms just echo the baked cfg (and on
  // non-terraformable bodies they're not meaningful), so only override then.
  const tfLive = u(renderer, 'uTerraform', 0) > 0.5;
  const bakeOpts = {
    width: BW, height: BH,
    terraform: tfLive,
    seaLevel: tfLive ? u(renderer, 'uSeaLevel', null) : null,
    iceLine: tfLive ? u(renderer, 'uIceLine', null) : null,
    snowOffset: tfLive ? u(renderer, 'uSnowOffset', 0) : 0,
    riverStrength: u(renderer, 'uRiverStrength', 1),
    cloudCover: u(renderer, 'uCloudCover', 0.5),
    cloudMul: u(renderer, 'uCloudMul', 1),
    cloudColor: vec255(u(renderer, 'uCloudColor', null), [255, 255, 255]),
    ashCloud: vec255(u(renderer, 'uAshCloud', null), [58, 46, 36]),
    vegetation: u(renderer, 'uVegetation', 1),
    gradient,
  };

  // Gas kinds: the CPU colorMap is only the STATIC banded albedo — the live view
  // is the gaseous-giganticus flow sim advecting an equirect dye texture. Pull
  // the GG-flowed, seamless equirect surface straight from the shader
  // (readSurfaceEquirect samples uGasTex + the gradient) so the export matches
  // the animated planet instead of exporting flat, un-flowed bands.
  const cfg = (planet.getTypeConfig && planet.getTypeConfig()) || planet._cfg || {};
  const isGas = cfg.kind === 'gas';
  let L;
  if (isGas && renderer && renderer.gasSim && typeof renderer.readSurfaceEquirect === 'function') {
    const surf = renderer.readSurfaceEquirect(BW, BH);
    const N = BW * BH;
    const rgb = new Uint8ClampedArray(N * 3), alpha = new Float32Array(N);
    for (let k = 0; k < N; k++) { const s = k * 4, o = k * 3; rgb[o] = surf.data[s]; rgb[o + 1] = surf.data[s + 1]; rgb[o + 2] = surf.data[s + 2]; alpha[k] = 1; }
    const empty = () => ({ rgb: new Uint8ClampedArray(N * 3), alpha: new Float32Array(N) });
    L = { ground: { rgb, alpha }, veg: empty(), snow: empty(), water: empty(), clouds: empty() };
  } else {
    L = planet.bakeExportLayers(bakeOpts);
  }
  const out = new Uint8ClampedArray(width * height * 4);
  const cnt = ss * ss;

  if (mask) {
    // Coverage matte: opaque white-on-black luminance mask (grey = partial
    // coverage). Box-downsample the max-coverage over selected layers.
    for (let ty = 0; ty < height; ty++) {
      for (let tx = 0; tx < width; tx++) {
        let sum = 0;
        for (let oy = 0; oy < ss; oy++) for (let ox = 0; ox < ss; ox++) {
          const sk = (ty * ss + oy) * BW + (tx * ss + ox);
          let cov = 0; for (const key of ORDER) { if (sel[key] && L[key].alpha[sk] > cov) cov = L[key].alpha[sk]; }
          sum += cov;
        }
        const d = (ty * width + tx) * 4, v = (sum / cnt) * 255;
        out[d] = out[d + 1] = out[d + 2] = v; out[d + 3] = 255;
      }
    }
  } else {
    // Composite in physical order at bake res. srcOver() accumulates
    // PREMULTIPLIED rgb (co = cs·as + cd·(1−as)) with straight alpha tracked
    // separately. Box-downsample straight FROM the premultiplied buffer (sum
    // premult-rgb & alpha over the block, then un-premultiply) — this both
    // fixes the too-dark straight-alpha bug and anti-aliases in one pass.
    const acc = new Float32Array(BN * 4);
    for (const key of ORDER) { if (sel[key]) srcOver(acc, L[key], 1, BN); }
    for (let ty = 0; ty < height; ty++) {
      for (let tx = 0; tx < width; tx++) {
        let sr = 0, sg = 0, sb = 0, sa = 0;
        for (let oy = 0; oy < ss; oy++) for (let ox = 0; ox < ss; ox++) {
          const s = ((ty * ss + oy) * BW + (tx * ss + ox)) * 4;
          sr += acc[s]; sg += acc[s + 1]; sb += acc[s + 2]; sa += acc[s + 3];  // premult sums
        }
        const d = (ty * width + tx) * 4;
        if (sa > 0) { out[d] = sr / sa; out[d + 1] = sg / sa; out[d + 2] = sb / sa; }
        out[d + 3] = (sa / cnt) * 255;
      }
    }
  }

  const outCanvas = document.createElement('canvas');
  outCanvas.width = width;
  outCanvas.height = height;
  outCanvas.getContext('2d').putImageData(new ImageData(out, width, height), 0, 0);

  const designation = ((planet.attributes && planet.attributes.designation) || 'world')
    .toString().replace(/[^A-Za-z0-9_-]+/g, '_');
  const activeCount = ORDER.filter((k) => sel[k]).length;
  const tag = activeCount === 1 ? ORDER.find((k) => sel[k]) : 'layers';
  const suffix = mask ? `${tag}_mask` : tag;

  return new Promise((resolve, reject) => {
    outCanvas.toBlob((blob) => {
      if (!blob) { reject(new Error('PNG encode failed')); return; }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `was_${designation}_${suffix}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      resolve();
    }, 'image/png');
  });
}
