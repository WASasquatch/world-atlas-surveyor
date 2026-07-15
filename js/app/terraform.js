// Terraform panel — live re-classification controls for the GL renderer.
// Sliders write straight into glRenderer.terraform (consumed as shader
// uniforms every frame), so feedback is instant: no re-bake, no rng.
// Survey-panel readouts (temp/pressure/habitability/water) are recomputed
// with pure formulas; planet.attributes itself is never mutated.

import { els } from './dom.js';
import { fmt } from './format.js';

// pure habitability scoring — mirrors planet.computeHabitability
function habitability(tempC, pressureAtm, type) {
  if (type === 'gas_giant' || type === 'ice_giant') return 'NIL';
  if (type === 'brown_dwarf') return 'EXTREME';
  if (type === 'volcanic') return tempC > 200 ? 'HOSTILE' : 'EXTREME';
  if (type === 'cratered' || type === 'asteroid' || type === 'dwarf_planet') return 'BARREN';
  let score = 0;
  if (tempC >= -10 && tempC <= 40) score += 40;
  else if (tempC >= -50 && tempC <= 80) score += 15;
  if (pressureAtm >= 0.4 && pressureAtm <= 3) score += 30;
  else if (pressureAtm >= 0.1 && pressureAtm <= 10) score += 10;
  if (type === 'terrestrial') score += 30;
  else if (type === 'ocean') score += 20;
  else if (type === 'desert') score += 10;
  else if (type === 'ice') score += 5;
  if (score >= 80) return 'HIGH';
  if (score >= 55) return 'MODERATE';
  if (score >= 30) return 'MARGINAL';
  return 'HOSTILE';
}

// area-weighted water fraction for the current sea level
function waterPercent(planet, seaLevel) {
  const { heightMap, texW: W, texH: H } = planet;
  let water = 0, total = 0;
  for (let j = 0; j < H; j += 2) {
    const lat = ((j + 0.5) / H) * Math.PI - Math.PI / 2;
    const wgt = Math.cos(lat);
    for (let i = 0; i < W; i += 2) {
      total += wgt;
      if (heightMap[j * W + i] < seaLevel) water += wgt;
    }
  }
  return total > 0 ? (water / total) * 100 : 0;
}

class TerraformPanel {
  constructor() {
    this.gl = null;        // active GLRenderer (null in classic mode)
    this.planet = null;
    this.base = null;      // baked defaults for the current planet
    this._terrainDirty = false;  // has EVOLVE/EROSION re-baked the heightMap?
    this.wire();
    this.setAvailable(false);
  }

  attach(glRenderer, planet) {
    const prevPlanet = this.planet;
    this.gl = glRenderer;
    this.planet = planet;
    const cfg = planet ? planet.getTypeConfig() : null;
    this.base = cfg ? {
      seaLevel: cfg.seaLevel,
      iceLine: glRenderer ? glRenderer.terraform.iceLine : 0.65,
      tempC: planet.attributes.tempC,
      pressureAtm: planet.attributes.pressureAtm,
    } : null;
    // Only wipe the sliders for a genuinely NEW planet. A same-planet re-attach
    // (enhanced↔classic mode toggle) must PRESERVE the user's terraform edits
    // and re-push them to the (re)attached GL renderer — otherwise switching
    // renderers silently resets every terraform setting.
    if (planet !== prevPlanet) this.reset(false);
    else if (glRenderer && planet) this.apply();
    this.setAvailable(!!glRenderer && !!planet);
  }

  setAvailable(on) {
    els.terraformSection.classList.toggle('disabled', !on);
    if (on && this.gl && this.planet) {
      const rocky = this.gl.terraformable;              // terrestrial / ocean
      const cfg = this.planet.getTypeConfig();
      const pal = this.planet.palette || {};
      const isGas = cfg.kind === 'gas';
      const setEnabled = (el, ok) => {
        if (!el) return;
        el.disabled = !ok;
        if (el.parentElement) el.parentElement.style.opacity = ok ? '' : '0.35';
      };
      // rocky-only: sea / veg / ice / snow / evolve
      for (const el of [els.tfSea, els.tfVeg, els.tfIce, els.tfSnow]) setEnabled(el, rocky);
      setEnabled(els.tfGasDensity, isGas);             // gas kinds only
      setEnabled(els.tfGasScale, isGas);               // gas flow shape (GG-style)
      setEnabled(els.tfGasTurb, isGas);
      setEnabled(els.tfGasDetail, isGas);
      setEnabled(els.tfEmission, !!cfg.selfEmit);      // brown dwarfs only
      setEnabled(els.tfAurora, !!pal.auroraCol);       // aurora-capable only
      // vortex / churn / cloud / atmos / procedural clouds: every GL body
      const waterRocky = cfg.kind === 'rocky' &&
        (this.planet.type === 'terrestrial' || this.planet.type === 'ocean' || this.planet.type === 'primordial');
      setEnabled(els.tfRivers, waterRocky);
      setEnabled(els.tfErosion, waterRocky);
      setEnabled(els.tfDetail, waterRocky);
      setEnabled(els.tfEvolve, waterRocky);
      setEnabled(els.tfEvolveScale, waterRocky);
      setEnabled(els.tfIterations, isGas);
      for (const el of [els.tfVortex, els.tfChurn, els.tfCloud, els.tfCloudCover, els.tfAtmo, els.tfAtmoDensity,
                        els.tfCloudAltLow, els.tfCloudAltMid, els.tfCloudAltHigh, els.tfCloudAmtLow, els.tfCloudAmtMid, els.tfCloudAmtHigh,
                        els.tfCloudScatter, els.tfCloudFlow, els.tfCloudSeed]) setEnabled(el, true);
    }
  }

  reset(apply = true) {
    els.tfSea.value = 0;
    els.tfVeg.value = 100;
    els.tfIce.value = 50;
    els.tfCloud.value = 100;
    els.tfCloudCover.value = 50;
    if (els.tfCloudAltLow) { els.tfCloudAltLow.value = 3; els.tfCloudAltMid.value = 6; els.tfCloudAltHigh.value = 10; }
    if (els.tfCloudAmtLow) { els.tfCloudAmtLow.value = 100; els.tfCloudAmtMid.value = 70; els.tfCloudAmtHigh.value = 50; }
    if (els.tfCloudScatter) els.tfCloudScatter.value = 60;
    els.tfAtmo.value = 100;
    if (els.tfAtmoDensity) els.tfAtmoDensity.value = 100;
    els.tfEvolve.value = 0;
    els.tfEvolveScale.value = 50;
    els.tfSnow.value = 0;
    els.tfVortex.value = 50;
    els.tfChurn.value = 100;
    els.tfGasDensity.value = 100;
    els.tfGasScale.value = 50;
    els.tfGasTurb.value = 50;
    els.tfGasDetail.value = 50;
    els.tfEmission.value = 100;
    els.tfAurora.value = 100;
    els.tfRivers.value = 100;
    els.tfErosion.value = 100;
    els.tfDetail.value = 50;
    els.tfIterations.value = 16;
    if (els.tfCloudFlow) els.tfCloudFlow.value = 100;
    if (els.tfCloudSeed) els.tfCloudSeed.value = 0;
    const wasDirty = this._terrainDirty;
    if (apply) {
      this.apply();
      // if EVOLVE/EROSION had re-baked the terrain, rebuild it from the base at
      // the reset (neutral) values so the heightMap matches the reset sliders
      if (wasDirty) this.applyTerrain(); else this._terrainDirty = false;
    } else {
      this._terrainDirty = false;   // fresh planet on attach — terrain is base
      this.refreshLabels();
    }
  }

  preset(name) {
    if (name === 'dead') {
      // the dead-earth special: drained oceans, zero vegetation, dusty
      // thin atmosphere, shrunken ice caps, no clouds worth mentioning
      els.tfSea.value = -60;
      els.tfVeg.value = 0;
      els.tfIce.value = 12;
      els.tfCloud.value = 10;
      els.tfAtmo.value = 30;
      // DEAD drains + sterilises the CURRENT world (live sliders) — it doesn't
      // reshape continents (that's the EVOLVE control), so no terrain re-bake.
    } else if (name === 'flood') {
      els.tfSea.value = 42;
      els.tfVeg.value = 120;
      els.tfCloud.value = 130;
      els.tfAtmo.value = 110;
    } else if (name === 'eden') {
      els.tfSea.value = 5;
      els.tfVeg.value = 185;
      els.tfIce.value = 32;
      els.tfCloud.value = 115;
      els.tfAtmo.value = 115;
    }
    this.apply();
  }

  values() {
    return {
      seaDelta: parseInt(els.tfSea.value, 10) / 100,           // -0.6 .. 0.6
      veg: parseInt(els.tfVeg.value, 10) / 100,                // 0 .. 2
      iceT: parseInt(els.tfIce.value, 10) / 100,               // 0 (none) .. 1 (snowball)
      cloudMul: parseInt(els.tfCloud.value, 10) / 100,         // 0 .. 2 (opacity)
      cloudCover: parseInt(els.tfCloudCover.value, 10) / 100,  // 0 .. 1 (area)
      cloudAltLow: parseInt(els.tfCloudAltLow.value, 10) / 100,   // shell heights (0..0.2)
      cloudAltMid: parseInt(els.tfCloudAltMid.value, 10) / 100,
      cloudAltHigh: parseInt(els.tfCloudAltHigh.value, 10) / 100,
      cloudAmtLow: parseInt(els.tfCloudAmtLow.value, 10) / 100,   // per-deck opacity (0..1.5)
      cloudAmtMid: parseInt(els.tfCloudAmtMid.value, 10) / 100,
      cloudAmtHigh: parseInt(els.tfCloudAmtHigh.value, 10) / 100,
      cloudScatter: parseInt(els.tfCloudScatter.value, 10) / 100, // 0..2 (silver lining)
      cloudFlow: parseInt(els.tfCloudFlow.value, 10) / 100,       // 0..2 (GG flow warp strength)
      cloudSeed: parseInt(els.tfCloudSeed.value, 10) * 0.137,     // re-roll offset for the cloud pattern
      atmScale: parseInt(els.tfAtmo.value, 10) / 100,          // 0 .. 1.5 (height/extent)
      atmDensity: parseInt(els.tfAtmoDensity.value, 10) / 100, // 0 .. 3 (haze/halo opacity)
      evolve: parseInt(els.tfEvolve.value, 10) / 100,          // 0 .. 1
      snowOffset: parseInt(els.tfSnow.value, 10) / 100,        // -1 .. 1
      vortex: parseInt(els.tfVortex.value, 10),                // 0 .. 100 (raw)
      churn: parseInt(els.tfChurn.value, 10) / 100,            // 0 .. 2
      gasDensity: parseInt(els.tfGasDensity.value, 10) / 100,  // 0 .. 2
      gasScale: parseInt(els.tfGasScale.value, 10),            // 0..100 raw
      gasTurb: parseInt(els.tfGasTurb.value, 10),              // 0..100 raw
      emission: parseInt(els.tfEmission.value, 10) / 100,      // 0 .. 2
      aurora: parseInt(els.tfAurora.value, 10) / 100,          // 0 .. 2
      riverStrength: parseInt(els.tfRivers.value, 10) / 100,   // 0 .. 2 (live)
    };
  }

  refreshLabels() {
    const v = this.values();
    els.tfSeaVal.textContent = v.seaDelta === 0 ? 'BASE' : (v.seaDelta > 0 ? '+' : '') + v.seaDelta.toFixed(2);
    els.tfVegVal.textContent = v.veg.toFixed(1) + '×';
    els.tfIceVal.textContent = v.iceT === 0.5 ? 'BASE' : v.iceT < 0.5 ? 'WARM' : 'COLD';
    els.tfCloudVal.textContent = v.cloudMul.toFixed(1) + '×';
    els.tfCloudCoverVal.textContent = Math.round(v.cloudCover * 100) + '%';
    els.tfAtmoVal.textContent = v.atmScale.toFixed(1) + '×';
    if (els.tfAtmoDensityVal) els.tfAtmoDensityVal.textContent = v.atmDensity.toFixed(1) + '×';
    if (els.tfCloudScatterVal) els.tfCloudScatterVal.textContent = v.cloudScatter.toFixed(1) + '×';
    if (els.tfCloudFlowVal) els.tfCloudFlowVal.textContent = v.cloudFlow.toFixed(1) + '×';
    els.tfEvolveVal.textContent = v.evolve === 0 ? 'OFF' : v.evolve.toFixed(2);
    { const sv = parseInt(els.tfEvolveScale.value, 10); els.tfEvolveScaleVal.textContent = sv < 34 ? 'FINE' : sv < 67 ? 'MED' : 'BROAD'; }
    els.tfSnowVal.textContent = v.snowOffset === 0 ? 'BASE' : v.snowOffset > 0 ? 'BARE+' + v.snowOffset.toFixed(2) : 'ICE' + v.snowOffset.toFixed(2);
    els.tfVortexVal.textContent = (0.1 * Math.pow(100, v.vortex / 100)).toFixed(1) + '×';
    els.tfChurnVal.textContent = v.churn === 0 ? 'FROZEN' : v.churn.toFixed(1) + '×';
    els.tfGasDensityVal.textContent = v.gasDensity.toFixed(1) + '×';
    els.tfGasScaleVal.textContent = Math.pow(2, (v.gasScale - 50) / 50).toFixed(1) + '×';
    els.tfGasTurbVal.textContent = v.gasTurb < 34 ? 'LOW' : v.gasTurb < 67 ? 'MED' : 'HIGH';
    { const dv = parseInt(els.tfGasDetail.value, 10); els.tfGasDetailVal.textContent = dv < 34 ? 'SMOOTH' : dv < 67 ? 'MED' : 'SHARP'; }
    els.tfEmissionVal.textContent = v.emission.toFixed(1) + '×';
    els.tfAuroraVal.textContent = v.aurora.toFixed(1) + '×';
    els.tfRiversVal.textContent = v.riverStrength.toFixed(1) + '×';
    els.tfErosionVal.textContent = (parseInt(els.tfErosion.value, 10) / 100).toFixed(1) + '×';
    { const dv = parseInt(els.tfDetail.value, 10); els.tfDetailVal.textContent = dv < 34 ? 'SMOOTH' : dv < 67 ? 'MED' : 'SHARP'; }
    els.tfIterationsVal.textContent = String(Math.round(100 + (parseInt(els.tfIterations.value, 10) / 100) * 1900));
  }

  apply() {
    this.refreshLabels();
    if (!this.gl || !this.planet || !this.base) return;
    const v = this.values();
    const tf = this.gl.terraform;

    const touched = v.seaDelta !== 0 || v.veg !== 1 || v.iceT !== 0.5 || v.snowOffset !== 0;
    tf.enabled = touched && this.gl.terraformable;
    tf.seaLevel = this.base.seaLevel + v.seaDelta;
    // ice slider: continuous piecewise map through the baked baseline —
    // 0 = ice line beyond the poles (no ice), 0.5 = baked, 1 = snowball
    const noIce = 1.25;
    // full snowball: the shader reaches cover=1 at the equator only when
    // iceLine ≲ -0.16 (absLat + noise must clear iceLine + 0.05, noise dips to
    // ~-0.1), so drive max ICE well below zero to freeze the whole globe.
    const snowball = -0.20;
    tf.iceLine = v.iceT <= 0.5
      ? noIce + (this.base.iceLine - noIce) * (v.iceT / 0.5)
      : this.base.iceLine + (snowball - this.base.iceLine) * ((v.iceT - 0.5) / 0.5);
    tf.vegetation = v.veg;
    tf.cloudMul = v.cloudMul;
    tf.cloudCover = v.cloudCover;
    tf.cloudAltLow = v.cloudAltLow; tf.cloudAltMid = v.cloudAltMid; tf.cloudAltHigh = v.cloudAltHigh;
    tf.cloudAmtLow = v.cloudAmtLow; tf.cloudAmtMid = v.cloudAmtMid; tf.cloudAmtHigh = v.cloudAmtHigh;
    tf.cloudScatter = v.cloudScatter;
    tf.cloudFlow = v.cloudFlow;
    tf.cloudSeed = v.cloudSeed;
    tf.atmScale = v.atmScale;
    tf.atmDensity = v.atmDensity;
    tf.snowOffset = v.snowOffset >= 0 ? v.snowOffset * 1.30 : v.snowOffset * 0.65;
    tf.emission = v.emission;
    tf.aurora = v.aurora;
    tf.riverStrength = v.riverStrength;
    const flowMul = 0.1 * Math.pow(100, v.vortex / 100);  // 0.1 .. 10 (exp, ~100x range)
    tf.flowMul = flowMul;
    tf.churn = v.churn;
    tf.gasDensity = v.gasDensity;                         // persisted so a quality rebuild can restore it
    const gasScaleMul = Math.pow(2, (v.gasScale - 50) / 50);  // 0.5..2, neutral 1
    const gasTurbAmt = (v.gasTurb / 100) * 0.7;               // 0..0.7, neutral 0.35
    tf.gasScale = gasScaleMul;                            // persisted for quality rebuild
    tf.gasTurb = gasTurbAmt;
    if (this.gl.gasSim) {
      this.gl.gasSim.setVortex(flowMul);
      this.gl.gasSim.setDensity(v.gasDensity);
      this.gl.gasSim.setScale(gasScaleMul);
      this.gl.gasSim.setTurbulence(gasTurbAmt);
    }

    this.updateReadouts(v);
  }

  updateReadouts(v) {
    const p = this.planet;
    // temperature responds to the ice slider only where the slider actually
    // drives the render (terraformable bodies); gas giants etc. keep baked temp
    const tempC = this.gl.terraformable
      ? this.base.tempC + (0.5 - v.iceT) * 60
      : this.base.tempC;
    const pressure = this.base.pressureAtm * Math.max(v.atmScale, 0.01);
    const hab = habitability(tempC, pressure, p.type);

    els.dTemp.textContent = `${fmt(tempC, 0)} °C`;
    if (pressure < 0.01) els.dPressure.textContent = `${fmt(pressure * 1000, 2)} mbar`;
    else if (pressure > 100) els.dPressure.textContent = `${fmt(pressure, 0)} atm`;
    else els.dPressure.textContent = `${fmt(pressure, 2)} atm`;
    els.dHab.textContent = hab;
    els.dHab.className = 'val tl';
    if (hab === 'HIGH') els.dHab.classList.replace('tl', 'green');
    else if (hab === 'HOSTILE' || hab === 'EXTREME') els.dHab.classList.replace('tl', 'warn');

    if (this.gl.terraformable) {
      const pct = waterPercent(p, this.base.seaLevel + v.seaDelta);
      els.dWater.textContent = pct < 0.5 ? 'NONE'
        : pct > 95 ? 'GLOBAL'
        : `${fmt(pct, 0)}% LIQUID`;
    }
  }

  // EROSION slider release — re-carve terrain + river network from the clean
  // base at the new strength, then re-upload the maps. Heavy (~0.3-0.5s), so
  // it runs on 'change' (release), not per input tick.
  applyTerrain() {
    if (!this.gl || !this.planet || !this.planet.baseHeightMap) return;
    const evolveAmt = parseInt(els.tfEvolve.value, 10) / 100;
    const scaleV = parseInt(els.tfEvolveScale.value, 10);
    const evolveScale = 1.6 - (scaleV / 100) * 1.2;        // higher slider = bigger continents
    const erosion = parseInt(els.tfErosion.value, 10) / 100;
    const detail = parseInt(els.tfDetail.value, 10) / 100;  // 0 (broad) .. 1 (fine cuts)
    els.tfErosionVal.textContent = 'BAKING…';
    els.tfEvolveVal.textContent = 'BAKING…';
    setTimeout(() => {
      // EVOLVE (terrain morph) runs first, then multi-resolution EROSION carves
      // broad drainage + fine channels and rivers form, so the whole surface is
      // consistent (rivers follow the evolved shape).
      this.planet.reTerrain(evolveAmt, evolveScale, erosion, detail);
      this.gl.refreshMaps(this.planet);
      els.tfErosionVal.textContent = erosion.toFixed(1) + '×';
      els.tfEvolveVal.textContent = evolveAmt === 0 ? 'OFF' : evolveAmt.toFixed(2);
      // terrain is "dirty" (diverges from the freshly-generated base) whenever
      // any of these differ from their neutral defaults — so RESET knows to
      // rebuild the base rather than leaving a stale morphed heightMap.
      this._terrainDirty = evolveAmt > 0.001 || Math.abs(erosion - 1) > 0.001 || Math.abs(detail - 0.5) > 0.001;
    }, 20);
  }

  // ITERATIONS slider release — develop the gas flow to N steps (crisper,
  // more detailed swirls at higher counts).
  applyIterations() {
    if (!this.gl || !this.gl.gasSim) return;
    const steps = Math.round(100 + (parseInt(els.tfIterations.value, 10) / 100) * 1900);
    els.tfIterationsVal.textContent = 'DEVELOPING…';
    setTimeout(() => {
      if (this.gl.gasSim) this.gl.gasSim.setIterations(steps);
      els.tfIterationsVal.textContent = String(steps);
    }, 10);
  }

  // Gas DETAIL slider release — re-seed the init dye at the new roughness and
  // let it migrate into the live flow (cheap; deferred like ITERATIONS).
  applyGasDetail() {
    const d = parseInt(els.tfGasDetail.value, 10) / 100;
    if (this.gl) this.gl.terraform.gasDetail = d;   // persisted for quality rebuild
    if (this.gl && this.gl.gasSim) this.gl.gasSim.setDetail(d);
    this.refreshLabels();
  }

  wire() {
    const oninput = () => this.apply();
    for (const el of [els.tfSea, els.tfVeg, els.tfIce, els.tfCloud, els.tfCloudCover, els.tfAtmo,
                      els.tfAtmoDensity, els.tfSnow, els.tfVortex, els.tfChurn, els.tfGasDensity, els.tfGasScale,
                      els.tfGasTurb, els.tfEmission, els.tfAurora, els.tfRivers,
                      els.tfCloudAltLow, els.tfCloudAltMid, els.tfCloudAltHigh,
                      els.tfCloudAmtLow, els.tfCloudAmtMid, els.tfCloudAmtHigh, els.tfCloudScatter,
                      els.tfCloudFlow, els.tfCloudSeed]) {
      if (el) el.addEventListener('input', oninput);
    }
    // heavy re-bake controls apply on release ('change'); labels track on 'input'
    for (const el of [els.tfEvolve, els.tfEvolveScale, els.tfErosion, els.tfDetail]) {
      el.addEventListener('change', () => this.applyTerrain());
      el.addEventListener('input', () => this.refreshLabels());
    }
    els.tfIterations.addEventListener('change', () => this.applyIterations());
    els.tfIterations.addEventListener('input', () => this.refreshLabels());
    els.tfGasDetail.addEventListener('change', () => this.applyGasDetail());
    els.tfGasDetail.addEventListener('input', () => this.refreshLabels());
    els.tfPresetDead.addEventListener('click', () => this.preset('dead'));
    els.tfPresetFlood.addEventListener('click', () => this.preset('flood'));
    els.tfPresetEden.addEventListener('click', () => this.preset('eden'));
    els.tfPresetReset.addEventListener('click', () => this.reset(true));
  }
}

export { TerraformPanel };
