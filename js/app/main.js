// App entry point — wires controls, owns the renderers and the
// generate/animation loops. This is the composition root: everything
// else is importable on its own.
//
// Two renderers share the viewport on separate stacked canvases (a canvas
// can only ever hold one context type): the WebGL2 "enhanced" renderer
// (js/gl/) and the original CPU rasterizer as the "classic" mode / fallback.

import { Planet } from '../planet.js';
import { Renderer } from '../renderer.js';
import { GLRenderer } from '../gl/gl-renderer.js';
import { EASTER_EGGS } from '../data/easter-eggs.js';
import { EARTH_MASK, decodeEarthMask } from '../data/earth-mask.js';
import { decodeCloudRef } from '../data/cloud-ref.js';
import { els } from './dom.js';
import { randomDesignation, sizeLabel } from './format.js';
import { setUI, showLoading } from './survey-panel.js';
import { exportCard } from './export-card.js';
import { TerraformPanel } from './terraform.js';
import { AppearancePanel } from './appearance.js';
import { Quality } from '../core/quality.js';
import { captureAnimation } from './animate.js';
import { exportMapLayers } from './map-export.js';

// ---------- renderers ----------
const cpuRenderer = new Renderer(els.planetCanvas, els.starsCanvas);
const glSupported = GLRenderer.isSupported();
let glRenderer = null;
if (glSupported) {
  try {
    glRenderer = new GLRenderer(els.planetGLCanvas, els.starsCanvas);
  } catch (e) {
    console.error('GL renderer init failed, falling back to classic:', e);
  }
}

let renderer = glRenderer || cpuRenderer;
let currentPlanet = null;
const terraform = new TerraformPanel();
const appearance = new AppearancePanel();

if (!glRenderer) {
  els.renderMode.value = 'classic';
  els.renderMode.disabled = true;
  els.renderMode.title = 'WebGL2 not available — classic renderer only';
}

function applyRenderMode(mode) {
  const useGL = mode === 'enhanced' && glRenderer;
  const next = useGL ? glRenderer : cpuRenderer;
  if (next === renderer) return;
  // carry user state across
  next.autoRotate = els.autoRotate.checked;
  renderer = next;
  els.planetGLCanvas.classList.toggle('hidden', !useGL);
  els.planetCanvas.classList.toggle('hidden', useGL);
  fitRenderer();
  updateSunFromUI();
  if (currentPlanet) {
    renderer.setPlanet(currentPlanet);
    applyDisplacement(parseInt(els.displacement.value, 10) / 100);
  }
  terraform.attach(useGL ? glRenderer : null, currentPlanet);
  appearance.attach(useGL ? glRenderer : null, currentPlanet);
  // classic mode shows the un-terraformed planet — restore baked readouts
  if (!useGL && currentPlanet) setUI(currentPlanet);
}

// Relief: the GL path shades per-frame from a uniform; the CPU path
// re-bakes the planet's colorMap.
function applyDisplacement(v) {
  if (renderer === glRenderer && glRenderer) {
    glRenderer.setDisplacement(v);
  } else if (renderer.planet) {
    renderer.planet.setDisplacement(v);
  }
}

// ---------- generation ----------
let generating = false;
function generate() {
  if (generating) return;
  generating = true;
  showLoading(true);
  setTimeout(() => {
    try {
      const seed = els.seed.value.trim() || randomDesignation();
      els.seed.value = seed;
      const seedUpper = seed.toUpperCase();
      const isEarth = (seedUpper === 'EARTH') && !!EARTH_MASK;
      // Easter-egg lookup — VULCAN, BAJOR, ARRAKIS, etc. lock specific
      // type/atmosphere/size/variant. Earth wins if both match (won't happen
      // since EARTH isn't in EASTER_EGGS, but defensive ordering).
      const egg = !isEarth ? EASTER_EGGS[seedUpper] : null;
      const planet = new Planet({
        seed,
        type:       isEarth ? 'terrestrial' : (egg ? egg.type       : els.planetType.value),
        atmosphere: isEarth ? 'thick'       : (egg ? egg.atmosphere : els.atmosphere.value),
        size:       isEarth ? 0.50          : (egg ? egg.size       : parseInt(els.size.value, 10) / 100),
        earthMode:  isEarth,
        forceVariant: egg ? egg.forceVariant : null,
      });
      // Reflect Earth state in the UI controls so the user sees what's set
      if (isEarth) {
        els.planetType.value = 'terrestrial';
        els.atmosphere.value = 'thick';
        els.size.value = 50;
        if (els.sizeVal) els.sizeVal.textContent = sizeLabel(0.5);
      } else if (egg) {
        // Reflect easter-egg state in the UI dropdowns/sliders so the user
        // sees what got locked. Doesn't affect generation — already passed in.
        els.planetType.value = egg.type;
        els.atmosphere.value = egg.atmosphere;
        els.size.value = Math.round(egg.size * 100);
        if (els.sizeVal) els.sizeVal.textContent = sizeLabel(egg.size);
      }
      planet.attributes.designation = seed;
      currentPlanet = planet;
      // Honor the current Relief slider for newly generated planets.
      const dispVal = parseInt(els.displacement.value, 10) / 100;
      if (dispVal !== 1.0 && renderer !== glRenderer) planet.setDisplacement(dispVal);
      renderer.setPlanet(planet);
      if (renderer === glRenderer) glRenderer.setDisplacement(dispVal);
      setUI(planet);
      terraform.attach(renderer === glRenderer ? glRenderer : null, planet);
      appearance.attach(renderer === glRenderer ? glRenderer : null, planet);
    } catch (e) {
      console.error(e);
      els.status.textContent = 'ERROR';
      els.status.className = 'err';
    } finally {
      generating = false;
      showLoading(false);
    }
  }, 30);
}

function fitRenderer() {
  const vp = els.planetCanvas.parentElement;
  const rect = vp.getBoundingClientRect();
  const aa = els.antialias ? (parseInt(els.antialias.value, 10) || 1) : 1;
  renderer.resize(rect.width, rect.height, parseInt(els.pixelScale.value, 10), aa);
}

// ---------- inputs ----------
els.randomSeed.addEventListener('click', () => {
  els.seed.value = randomDesignation();
  generate();
});
els.earthPreset.addEventListener('click', () => {
  els.seed.value = 'EARTH';
  generate();
});
els.exportCard.addEventListener('click', () => exportCard(renderer));
els.generate.addEventListener('click', generate);
els.seed.addEventListener('keydown', (e) => { if (e.key === 'Enter') generate(); });
els.renderMode.addEventListener('change', () => applyRenderMode(els.renderMode.value));

// Quality select — 'auto' probes up/down from frame timings; a named tier freezes it.
els.quality.addEventListener('change', () => {
  const v = els.quality.value;
  if (v === 'auto') Quality.enableAuto();
  else Quality.set(v);
});

// Animation export
els.animFrames.addEventListener('input', () => { els.animFramesVal.textContent = els.animFrames.value; });
els.exportAnim.addEventListener('click', async () => {
  if (renderer !== glRenderer || !glRenderer) { els.animProgress.textContent = 'Enhanced (GL) mode only'; return; }
  if (!currentPlanet) return;
  els.exportAnim.disabled = true;
  const format = els.animFormat.value;
  const frames = parseInt(els.animFrames.value, 10);
  const alpha = els.animAlpha.checked;
  const size = parseInt(els.animRes.value, 10) || 384;
  try {
    const { bytes, mime, ext } = await captureAnimation(glRenderer, {
      frames, format, alpha, size,
      onProgress: (i, n) => { els.animProgress.textContent = 'CAPTURING ' + i + '/' + n; },
    });
    els.animProgress.textContent = 'ENCODING…';
    await new Promise((r) => setTimeout(r, 0));
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (currentPlanet.attributes.designation || 'world').replace(/[^A-Za-z0-9_-]/g, '_') + '.' + ext;
    a.click();
    URL.revokeObjectURL(url);
    els.animProgress.textContent = 'SAVED ' + Math.round(bytes.length / 1024) + ' KB';
  } catch (e) {
    console.error(e);
    els.animProgress.textContent = 'EXPORT FAILED';
  } finally {
    els.exportAnim.disabled = false;
  }
});

// Layered map export — CPU decomposition to a transparent equirect PNG.
els.exportMap.addEventListener('click', () => {
  if (!currentPlanet) return;
  const layers = {
    ground: els.mapGround.checked,
    veg: els.mapVeg.checked,
    snow: els.mapSnow.checked,
    water: els.mapWater.checked,
    clouds: els.mapClouds.checked,
  };
  if (!Object.values(layers).some(Boolean)) { els.mapProgress.textContent = 'SELECT A LAYER'; return; }
  els.exportMap.disabled = true;
  els.mapProgress.textContent = 'BAKING…';
  // Defer so the button state paints before the synchronous bake blocks.
  setTimeout(async () => {
    try {
      await exportMapLayers(renderer, {
        layers,
        mask: els.mapMask.checked,
        width: parseInt(els.mapRes.value, 10) || 2048,
        planet: currentPlanet,
      });
      els.mapProgress.textContent = 'SAVED';
    } catch (e) {
      console.error(e);
      els.mapProgress.textContent = 'EXPORT FAILED';
    } finally {
      els.exportMap.disabled = false;
    }
  }, 0);
});
// If the user explicitly changes type/atmosphere/size while seed is "EARTH"
// or any easter-egg seed (VULCAN, BAJOR, etc.), roll a fresh procedural seed
// so their override takes effect (otherwise the named-world override would
// silently win over their dropdown choice).
function clearEarthOnOverride() {
  const cur = els.seed.value.trim().toUpperCase();
  const isLockedSeed = (cur === 'EARTH') || (cur in EASTER_EGGS);
  if (isLockedSeed) {
    els.seed.value = randomDesignation();
    // Clean up the UI controls that were force-set by the named-world load.
    // Without this reset, the atmosphere dropdown stays stuck at whatever
    // the named world used, so every subsequently-generated planet would
    // inherit that setting — even types like dwarf planets / asteroids
    // where pickAtmosphere() should otherwise yield 'none'.
    els.atmosphere.value = 'auto';
    els.size.value = 50;
    if (els.sizeVal) els.sizeVal.textContent = sizeLabel(0.5);
  }
}
els.planetType.addEventListener('change', () => { clearEarthOnOverride(); generate(); });
els.atmosphere.addEventListener('change', () => { clearEarthOnOverride(); generate(); });
els.size.addEventListener('input', () => {
  els.sizeVal.textContent = sizeLabel(parseInt(els.size.value, 10) / 100);
});
els.size.addEventListener('change', () => { clearEarthOnOverride(); generate(); });
els.pixelScale.addEventListener('input', () => {
  els.pixelVal.textContent = els.pixelScale.value + '×';
  fitRenderer();
});
if (els.antialias) els.antialias.addEventListener('change', fitRenderer);
els.autoRotate.addEventListener('change', () => {
  renderer.autoRotate = els.autoRotate.checked;
});

// Displacement / Relief slider — GL: per-frame uniform; CPU: re-applies bump
// shading at new strength without rebuilding the planet (cached rawColorMap).
els.displacement.addEventListener('input', () => {
  const v = parseInt(els.displacement.value, 10) / 100;
  els.displacementVal.textContent = v.toFixed(2) + '×';
  applyDisplacement(v);
});

// Star (sun) azimuth + elevation + camera tilt + intensity + hue.
function classifyStarHue(h) {
  if (h <= -75) return 'M ★';
  if (h <= -40) return 'K ★';
  if (h <   20) return 'G ★';
  if (h <   50) return 'F ★';
  if (h <   80) return 'A ★';
  return 'B ★';
}
function updateSunFromUI() {
  renderer.sunAz = parseInt(els.sunAzimuth.value, 10);
  renderer.sunEl = parseInt(els.sunElevation.value, 10);
  renderer.viewTilt = parseInt(els.viewTilt.value, 10);
  renderer.sunIntensity = parseInt(els.sunIntensity.value, 10);
  renderer.sunHue       = parseInt(els.sunHue.value, 10);
  els.sunAzimuthVal.textContent   = renderer.sunAz + '°';
  els.sunElevationVal.textContent = renderer.sunEl + '°';
  els.viewTiltVal.textContent     = renderer.viewTilt + '°';
  els.sunIntensityVal.textContent = (renderer.sunIntensity / 100).toFixed(2) + '×';
  els.sunHueVal.textContent       = classifyStarHue(renderer.sunHue);
}
els.sunAzimuth.addEventListener('input', updateSunFromUI);
els.sunElevation.addEventListener('input', updateSunFromUI);
els.viewTilt.addEventListener('input', updateSunFromUI);
els.sunIntensity.addEventListener('input', updateSunFromUI);
els.sunHue.addEventListener('input', updateSunFromUI);

window.addEventListener('resize', fitRenderer);

// Animation loop
let lastT = performance.now();
function loop(t) {
  const dt = t - lastT;
  lastT = t;
  renderer.render(dt);
  els.vpFrame.textContent = String(renderer.frame).padStart(4, '0');
  els.vpRender.textContent = renderer.lastFrameMs.toFixed(1);
  if (renderer === glRenderer) Quality.sampleFrame(renderer.lastFrameMs);
  requestAnimationFrame(loop);
}

// Initial setup
els.sizeVal.textContent = sizeLabel(0.5);
els.pixelVal.textContent = '3×';
els.displacementVal.textContent = '1.00×';
renderer.autoRotate = els.autoRotate.checked;
els.renderMode.value = renderer === glRenderer ? 'enhanced' : 'classic';
els.planetCanvas.classList.toggle('hidden', renderer === glRenderer);
els.planetGLCanvas.classList.toggle('hidden', renderer !== glRenderer);
updateSunFromUI();
fitRenderer();
// Decode embedded reference assets (Earth water mask + cloud pattern) in
// parallel before the initial render. Both are optional — if either fails
// (very old browser without DecompressionStream, etc.) we still render.
Promise.all([decodeEarthMask(), decodeCloudRef()]).then(([earthOk]) => {
  if (!earthOk) {
    els.seed.value = randomDesignation();
  }
  generate();
});
requestAnimationFrame(loop);
