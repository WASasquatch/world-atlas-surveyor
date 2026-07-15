// Appearance panel — SURFACE COLOUR controls: an image GRADIENT MAP (recolour
// the whole world by luminance through an uploaded image's ramp) and per-group
// CUSTOM COLOUR swatches. Both are live, render-time-only overrides on the GL
// renderer: they never touch Planet's seed-deterministic bake or RNG, so the
// same seed still generates the same world. Enhanced (GL) mode only — the
// classic CPU renderer shows the baked seed colours.
//
// On ROCKY worlds the five biome swatches recolour water/land/veg/rock/ice; on
// GAS giants / ice giants / brown dwarfs the same five swatches are relabelled
// BAND 1–5 and recolour the flowing CLOUD bands (via GasGiantSim band colours),
// so the palette is useful there instead of editing invisible "ground" colours.

import { els } from './dom.js';
import { buildGradientLut } from '../core/color-grade.js';

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex(c) {
  const h = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return '#' + h(c[0]) + h(c[1]) + h(c[2]);
}
function scale(c, f) {
  return [Math.min(255, c[0] * f), Math.min(255, c[1] * f), Math.min(255, c[2] * f)];
}

// The five band-recolour swatches, in strip order (BAND 1..5).
const GAS_KEYS = ['water', 'land', 'veg', 'rock', 'ice'];

class AppearancePanel {
  constructor() {
    this.gl = null;
    this.planet = null;
    this._grad = null;        // { tex, mix } — current gradient map
    this._overrides = {};     // rocky biome / atmos / cloud group key -> [r,g,b]
    this._isGas = false;
    this._gasBands = null;    // 5 [r,g,b] band picks when on a gas kind
    this.wire();
    this.setAvailable(false);
  }

  attach(glRenderer, planet) {
    const prevPlanet = this.planet;
    this.gl = glRenderer;
    this.planet = planet;
    const cfg = planet && planet.getTypeConfig();
    this._isGas = !!(glRenderer && cfg && cfg.kind === 'gas');
    // Re-apply stored appearance to the (regenerated / mode-switched) renderer.
    if (this.gl) {
      if (this._grad) this.gl.setGradient(this._grad.tex, this._grad.mix, this._grad.scale);
      if (this._targets) this.gl.setGradientTargets(this._targets);
      if (Object.keys(this._overrides).length) this.gl.setPaletteOverride(this._buildPaletteMap());
      if (this._isGas) {
        // Gas band edits are per-planet. Clear the override only for a genuinely
        // NEW planet; a same-planet re-attach (e.g. an enhanced↔classic mode
        // toggle) must KEEP the user's custom bands — setPlanet/uploadPlanet
        // already restored them via _gasBandVecs, so we just re-read the strip.
        if (planet !== prevPlanet) this.gl.setGasBands(null);
        this._gasBands = this._readGasBands();
      } else {
        this._gasBands = null;
      }
    }
    this.setAvailable(!!glRenderer && !!planet);
    this._updateGradStatus();
  }

  // Sample the sim's live band strip (Vector3[8]) at five representative slots.
  _readGasBands() {
    const bc = this.gl && this.gl.gasSim && this.gl.gasSim.bandColors;
    const slots = [0, 2, 4, 5, 7];
    if (!bc) return slots.map(() => [128, 128, 128]);
    return slots.map((s) => {
      const v = bc[s] || { x: 0.5, y: 0.5, z: 0.5 };
      return [Math.round(v.x * 255), Math.round(v.y * 255), Math.round(v.z * 255)];
    });
  }

  // Expand the five band picks into a full 8-slot strip by linear interpolation
  // (pole → pole gradient the gas sim seeds its dye from).
  _buildGasStrip(picks) {
    const strip = [];
    for (let i = 0; i < 8; i++) {
      const t = (i / 7) * 4;
      const a = Math.floor(t), b = Math.min(4, a + 1), f = t - a;
      const ca = picks[a], cb = picks[b];
      strip.push([ca[0] + (cb[0] - ca[0]) * f, ca[1] + (cb[1] - ca[1]) * f, ca[2] + (cb[2] - ca[2]) * f]);
    }
    return strip;
  }

  setAvailable(on) {
    if (els.appearanceSection) els.appearanceSection.classList.toggle('disabled', !on);
    const hasGl = on && !!this.gl;
    const t = this.planet && this.planet.type;
    const stdBiome = hasGl && (t === 'terrestrial' || t === 'ocean' || t === 'primordial');
    const isGas = hasGl && this._isGas;
    const setEn = (el, ok) => {
      if (!el) return;
      el.disabled = !ok;
      if (el.parentElement) el.parentElement.style.opacity = ok ? '' : '0.4';
    };
    // relabel the first five swatches: BAND 1–5 on gas kinds, biomes on rocky
    const relabel = (el, gasTxt, rockTxt) => { if (el) el.textContent = isGas ? gasTxt : rockTxt; };
    relabel(els.lblWater, 'BAND 1', 'WATER'); relabel(els.lblLand, 'BAND 2', 'LAND');
    relabel(els.lblVeg, 'BAND 3', 'VEG'); relabel(els.lblRock, 'BAND 4', 'ROCK');
    relabel(els.lblIce, 'BAND 5', 'ICE');
    // gradient map: any GL body (recolours rocky biomes AND the gas dye)
    for (const el of [els.gradImage, els.gradIntensity, els.gradClear]) setEn(el, hasGl);
    // first five swatches: rocky standard-biome families OR gas band recolour
    for (const el of [els.palWater, els.palLand, els.palVeg, els.palRock, els.palIce]) setEn(el, stdBiome || isGas);
    setEn(els.palAtmos, hasGl);
    setEn(els.palCloud, hasGl && !isGas);   // gas kinds have no separate cloud deck
    setEn(els.palReset, hasGl);
    // reflect the CURRENT world's colours in the swatches (so they represent
    // what's actually rendered, not stale hardcoded defaults) — showing any
    // active override where set, otherwise the seed palette's representative slot.
    if (isGas && this._gasBands) {
      const set = (el, i) => { if (el && this._gasBands[i]) el.value = rgbToHex(this._gasBands[i]); };
      set(els.palWater, 0); set(els.palLand, 1); set(els.palVeg, 2); set(els.palRock, 3); set(els.palIce, 4);
    } else if (stdBiome) {
      this._syncRockySwatches();
    }
    // atmosphere / cloud swatches reflect the palette on every GL body
    if (hasGl && this.planet && this.planet.palette) {
      const pal = this.planet.palette, o = this._overrides;
      if (els.palAtmos) els.palAtmos.value = rgbToHex(o.atmos || pal.atmCol || [90, 154, 223]);
      if (els.palCloud) els.palCloud.value = rgbToHex(o.cloud || pal.cloudCol || [240, 244, 248]);
    }
  }

  // Set the five biome swatches to the current world's colours (override if set,
  // else the seed palette's representative slot for each group).
  _syncRockySwatches() {
    const pal = this.planet && this.planet.palette; if (!pal) return;
    const o = this._overrides;
    const set = (el, key, slot, fb) => { if (el) el.value = rgbToHex(o[key] || pal[slot] || fb); };
    set(els.palWater, 'water', 'water', [29, 93, 130]);
    set(els.palLand, 'land', 'plains', [93, 138, 74]);
    set(els.palVeg, 'veg', 'forest', [46, 90, 48]);
    set(els.palRock, 'rock', 'hills', [117, 97, 74]);
    set(els.palIce, 'ice', 'polarIce', [232, 240, 248]);
  }

  async loadImage(file) {
    if (!file || !this.gl) return;
    try {
      const bmp = await createImageBitmap(file);
      const { tex, lut } = buildGradientLut(bmp);
      if (bmp.close) bmp.close();
      const mix = parseInt(els.gradIntensity.value, 10) / 100;
      const scale = els.gradScale ? parseInt(els.gradScale.value, 10) / 100 : 1;
      this._grad = { tex, lut, mix, scale };
      this.gl.setGradient(tex, mix, scale, lut);
      this._updateGradStatus();
    } catch (e) {
      console.error('gradient image load failed', e);
    }
  }

  setIntensity() {
    const mix = parseInt(els.gradIntensity.value, 10) / 100;
    els.gradIntensityVal.textContent = Math.round(mix * 100) + '%';
    if (this._grad) { this._grad.mix = mix; if (this.gl) this.gl.setGradientMix(mix); }
  }

  setScale() {
    if (!els.gradScale) return;
    const scale = parseInt(els.gradScale.value, 10) / 100;
    if (els.gradScaleVal) els.gradScaleVal.textContent = scale.toFixed(2) + '×';
    if (this._grad) { this._grad.scale = scale; if (this.gl) this.gl.setGradientScale(scale); }
  }

  // Read the per-class TARGET controls into { enable[5], lo[5], hi[5] } and push
  // to the renderer. Index 0 water, 1 land/rock, 2 veg, 3 ice, 4 gas (always on,
  // whole ramp). Stored so it re-applies across regenerations.
  applyTargets() {
    if (!els.gtWaterEn) return;
    const rd = (en, lo, hi) => [en.checked ? 1 : 0, parseInt(lo.value, 10) / 100, parseInt(hi.value, 10) / 100];
    const w = rd(els.gtWaterEn, els.gtWaterLo, els.gtWaterHi);
    const l = rd(els.gtLandEn, els.gtLandLo, els.gtLandHi);
    const v = rd(els.gtVegEn, els.gtVegLo, els.gtVegHi);
    const ic = rd(els.gtIceEn, els.gtIceLo, els.gtIceHi);
    this._targets = {
      enable: [w[0], l[0], v[0], ic[0], 1],
      lo: [w[1], l[1], v[1], ic[1], 0],
      hi: [w[2], l[2], v[2], ic[2], 1],
    };
    if (this.gl) this.gl.setGradientTargets(this._targets);
  }

  clearGradient() {
    this._grad = null;
    if (els.gradImage) els.gradImage.value = '';
    if (this.gl) this.gl.clearGradient();
    this._updateGradStatus();
  }

  // Show/hide the "gradient active" indicator. A loaded gradient PERSISTS across
  // world regenerations (it's a global look), but the file <input> resets its
  // label to "No file selected", which hid that it was still remapping every
  // colour and silently overriding the custom swatches. This makes it explicit.
  _updateGradStatus() {
    const el = els.gradStatus; if (!el) return;
    const on = !!(this._grad && this._grad.tex);
    el.textContent = on ? '● GRADIENT ACTIVE — overrides swatches; CLEAR to use custom colours' : '';
    el.style.display = on ? '' : 'none';
    if (els.gradScale) { els.gradScale.disabled = !on; if (els.gradScale.parentElement) els.gradScale.parentElement.style.opacity = on ? '' : '0.4'; }
    if (els.gradTargets) els.gradTargets.style.display = on ? '' : 'none';
  }

  // Expand the per-group picks into a full palette-slot override map, deriving
  // shade variants (e.g. WATER -> deep/mid/shore) by luminance-scaling so depth
  // cues survive.
  _buildPaletteMap() {
    const o = this._overrides, m = {};
    if (o.water) { m.deepWater = scale(o.water, 0.45); m.water = scale(o.water, 0.78); m.shore = scale(o.water, 1.18); }
    // LAND = the vegetated/low green terrain; ROCK = the tan/rocky/mountain
    // terrain (arid/hills/mountain/peak) — which is most of the visible relief,
    // so ROCK now actually recolours the mountainous areas.
    if (o.land)  { m.lowland = scale(o.land, 0.9); m.plains = o.land; m.beach = scale(o.land, 1.25); }
    if (o.veg)   { m.forest = o.veg; }
    if (o.rock)  { m.arid = scale(o.rock, 1.05); m.hills = o.rock; m.mountain = scale(o.rock, 0.8); m.peak = scale(o.rock, 1.4); }
    if (o.ice)   { m.polarIce = o.ice; }
    if (o.atmos) { m.atmCol = o.atmos; }
    if (o.cloud) { m.cloudCol = o.cloud; }
    return m;
  }

  setColor(key, hex) {
    const rgb = hexToRgb(hex);
    // GAS kinds: the five biome swatches recolour the flowing cloud bands
    if (this._isGas && GAS_KEYS.indexOf(key) >= 0) {
      if (!this._gasBands) this._gasBands = this._readGasBands();
      this._gasBands[GAS_KEYS.indexOf(key)] = rgb;
      if (this.gl) this.gl.setGasBands(this._buildGasStrip(this._gasBands));
      return;
    }
    // ROCKY (biomes) + atmosphere/cloud (both kinds) go through the palette override
    this._overrides[key] = rgb;
    if (this.gl) this.gl.setPaletteOverride(this._buildPaletteMap());
  }

  resetColors() {
    this._overrides = {};
    if (!this.gl) return;
    this.gl.clearPaletteOverride();
    if (this._isGas) {
      this.gl.setGasBands(null);
      this._gasBands = this._readGasBands();
      this.setAvailable(true);   // resync swatch colours to the restored bands
    }
  }

  wire() {
    if (els.gradImage) els.gradImage.addEventListener('change', (e) => this.loadImage(e.target.files && e.target.files[0]));
    if (els.gradIntensity) els.gradIntensity.addEventListener('input', () => this.setIntensity());
    if (els.gradScale) els.gradScale.addEventListener('input', () => this.setScale());
    if (els.gradClear) els.gradClear.addEventListener('click', () => this.clearGradient());
    for (const el of [els.gtWaterEn, els.gtWaterLo, els.gtWaterHi, els.gtLandEn, els.gtLandLo, els.gtLandHi,
                      els.gtVegEn, els.gtVegLo, els.gtVegHi, els.gtIceEn, els.gtIceLo, els.gtIceHi]) {
      if (el) el.addEventListener('input', () => this.applyTargets());
    }
    // biome / band colours apply on release ('change') — rocky re-bakes the
    // surface, gas re-seeds the dye; both too heavy for every drag tick.
    const c = (el, key) => { if (el) el.addEventListener('change', () => this.setColor(key, el.value)); };
    c(els.palWater, 'water'); c(els.palLand, 'land'); c(els.palVeg, 'veg');
    c(els.palRock, 'rock'); c(els.palIce, 'ice'); c(els.palAtmos, 'atmos'); c(els.palCloud, 'cloud');
    if (els.palReset) els.palReset.addEventListener('click', () => this.resetColors());
  }
}

export { AppearancePanel };
