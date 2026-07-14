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
    this.wire();
    this.setAvailable(false);
  }

  attach(glRenderer, planet) {
    this.gl = glRenderer;
    this.planet = planet;
    const cfg = planet ? planet.getTypeConfig() : null;
    this.base = cfg ? {
      seaLevel: cfg.seaLevel,
      iceLine: glRenderer ? glRenderer.terraform.iceLine : 0.65,
      tempC: planet.attributes.tempC,
      pressureAtm: planet.attributes.pressureAtm,
    } : null;
    this.reset(false);
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
      for (const el of [els.tfSea, els.tfVeg, els.tfIce, els.tfSnow, els.tfEvolve]) setEnabled(el, rocky);
      setEnabled(els.tfGasDensity, isGas);             // gas kinds only
      setEnabled(els.tfEmission, !!cfg.selfEmit);      // brown dwarfs only
      setEnabled(els.tfAurora, !!pal.auroraCol);       // aurora-capable only
      // vortex / churn / cloud / atmos / procedural clouds: every GL body
      const waterRocky = cfg.kind === 'rocky' &&
        (this.planet.type === 'terrestrial' || this.planet.type === 'ocean' || this.planet.type === 'primordial');
      setEnabled(els.tfRivers, waterRocky);
      setEnabled(els.tfErosion, waterRocky);
      setEnabled(els.tfIterations, isGas);
      for (const el of [els.tfVortex, els.tfChurn, els.tfCloud, els.tfAtmo, els.tfProcClouds]) setEnabled(el, true);
    }
  }

  reset(apply = true) {
    els.tfSea.value = 0;
    els.tfVeg.value = 100;
    els.tfIce.value = 50;
    els.tfCloud.value = 100;
    els.tfAtmo.value = 100;
    els.tfEvolve.value = 0;
    els.tfSnow.value = 0;
    els.tfVortex.value = 50;
    els.tfChurn.value = 100;
    els.tfGasDensity.value = 100;
    els.tfEmission.value = 100;
    els.tfAurora.value = 100;
    els.tfRivers.value = 100;
    els.tfErosion.value = 100;
    els.tfIterations.value = 16;
    els.tfProcClouds.checked = false;
    if (apply) this.apply();
    else this.refreshLabels();
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
      els.tfEvolve.value = Math.max(10, els.tfEvolve.value | 0);
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
      cloudMul: parseInt(els.tfCloud.value, 10) / 100,         // 0 .. 2
      atmScale: parseInt(els.tfAtmo.value, 10) / 100,          // 0 .. 1.5
      evolve: parseInt(els.tfEvolve.value, 10) / 100,          // 0 .. 1
      snowOffset: parseInt(els.tfSnow.value, 10) / 100,        // -1 .. 1
      vortex: parseInt(els.tfVortex.value, 10),                // 0 .. 100 (raw)
      churn: parseInt(els.tfChurn.value, 10) / 100,            // 0 .. 2
      gasDensity: parseInt(els.tfGasDensity.value, 10) / 100,  // 0 .. 2
      emission: parseInt(els.tfEmission.value, 10) / 100,      // 0 .. 2
      aurora: parseInt(els.tfAurora.value, 10) / 100,          // 0 .. 2
      riverStrength: parseInt(els.tfRivers.value, 10) / 100,   // 0 .. 2 (live)
      procClouds: els.tfProcClouds.checked ? 1 : 0,
    };
  }

  refreshLabels() {
    const v = this.values();
    els.tfSeaVal.textContent = v.seaDelta === 0 ? 'BASE' : (v.seaDelta > 0 ? '+' : '') + v.seaDelta.toFixed(2);
    els.tfVegVal.textContent = v.veg.toFixed(1) + '×';
    els.tfIceVal.textContent = v.iceT === 0.5 ? 'BASE' : v.iceT < 0.5 ? 'WARM' : 'COLD';
    els.tfCloudVal.textContent = v.cloudMul.toFixed(1) + '×';
    els.tfAtmoVal.textContent = v.atmScale.toFixed(1) + '×';
    els.tfEvolveVal.textContent = v.evolve === 0 ? 'OFF' : v.evolve.toFixed(2);
    els.tfSnowVal.textContent = v.snowOffset === 0 ? 'BASE' : v.snowOffset > 0 ? 'BARE+' + v.snowOffset.toFixed(2) : 'ICE' + v.snowOffset.toFixed(2);
    els.tfVortexVal.textContent = (0.1 * Math.pow(100, v.vortex / 100)).toFixed(1) + '×';
    els.tfChurnVal.textContent = v.churn === 0 ? 'FROZEN' : v.churn.toFixed(1) + '×';
    els.tfGasDensityVal.textContent = v.gasDensity.toFixed(1) + '×';
    els.tfEmissionVal.textContent = v.emission.toFixed(1) + '×';
    els.tfAuroraVal.textContent = v.aurora.toFixed(1) + '×';
    els.tfRiversVal.textContent = v.riverStrength.toFixed(1) + '×';
    els.tfErosionVal.textContent = (parseInt(els.tfErosion.value, 10) / 100).toFixed(1) + '×';
    els.tfIterationsVal.textContent = String(Math.round(100 + (parseInt(els.tfIterations.value, 10) / 100) * 1900));
  }

  apply() {
    this.refreshLabels();
    if (!this.gl || !this.planet || !this.base) return;
    const v = this.values();
    const tf = this.gl.terraform;

    const touched = v.seaDelta !== 0 || v.veg !== 1 || v.iceT !== 0.5 || v.evolve > 0 || v.snowOffset !== 0;
    tf.enabled = touched && this.gl.terraformable;
    tf.seaLevel = this.base.seaLevel + v.seaDelta;
    // ice slider: continuous piecewise map through the baked baseline —
    // 0 = ice line beyond the poles (no ice), 0.5 = baked, 1 = snowball
    const noIce = 1.25;
    const snowball = Math.max(0.10, this.base.iceLine - 0.55);
    tf.iceLine = v.iceT <= 0.5
      ? noIce + (this.base.iceLine - noIce) * (v.iceT / 0.5)
      : this.base.iceLine + (snowball - this.base.iceLine) * ((v.iceT - 0.5) / 0.5);
    tf.vegetation = v.veg;
    tf.cloudMul = v.cloudMul;
    tf.atmScale = v.atmScale;
    tf.evolveAmp = v.evolve;                               // full reach -> new world at 1
    tf.evolve = 11.7 + v.evolve * 4.0;
    tf.snowOffset = v.snowOffset >= 0 ? v.snowOffset * 1.30 : v.snowOffset * 0.65;
    tf.procClouds = v.procClouds;
    tf.emission = v.emission;
    tf.aurora = v.aurora;
    tf.riverStrength = v.riverStrength;
    const flowMul = 0.1 * Math.pow(100, v.vortex / 100);  // 0.1 .. 10 (exp, ~100x range)
    tf.flowMul = flowMul;
    tf.churn = v.churn;
    tf.gasDensity = v.gasDensity;                         // persisted so a quality rebuild can restore it
    if (this.gl.gasSim) {
      this.gl.gasSim.setVortex(flowMul);
      this.gl.gasSim.setDensity(v.gasDensity);
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
  applyErosion() {
    if (!this.gl || !this.planet || !this.planet.baseHeightMap) return;
    const strength = parseInt(els.tfErosion.value, 10) / 100;
    els.tfErosionVal.textContent = 'ERODING…';
    setTimeout(() => {
      this.planet.reErode(strength);
      this.gl.refreshMaps(this.planet);
      els.tfErosionVal.textContent = strength.toFixed(1) + '×';
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

  wire() {
    const oninput = () => this.apply();
    for (const el of [els.tfSea, els.tfVeg, els.tfIce, els.tfCloud, els.tfAtmo, els.tfEvolve,
                      els.tfSnow, els.tfVortex, els.tfChurn, els.tfGasDensity, els.tfEmission, els.tfAurora,
                      els.tfRivers]) {
      el.addEventListener('input', oninput);
    }
    els.tfProcClouds.addEventListener('change', oninput);
    els.tfErosion.addEventListener('change', () => this.applyErosion());
    els.tfIterations.addEventListener('change', () => this.applyIterations());
    // reflect the slider value live while dragging (apply on release)
    els.tfErosion.addEventListener('input', () => this.refreshLabels());
    els.tfIterations.addEventListener('input', () => this.refreshLabels());
    els.tfPresetDead.addEventListener('click', () => this.preset('dead'));
    els.tfPresetFlood.addEventListener('click', () => this.preset('flood'));
    els.tfPresetEden.addEventListener('click', () => this.preset('eden'));
    els.tfPresetReset.addEventListener('click', () => this.reset(true));
  }
}

export { TerraformPanel };
