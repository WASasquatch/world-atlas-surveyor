// Survey-data side panel — reflects a generated planet in the UI.

import { els } from './dom.js';
import { fmt, TYPE_NAMES } from './format.js';

function setUI(planet) {
  const a = planet.attributes;
  els.designation.textContent = a.designation;
  const variantTag = (planet.variantName && planet.variantName !== 'Standard')
    ? ` · ${planet.variantName.toUpperCase()}`
    : '';
  els.designationClass.textContent = `CLASS: ${TYPE_NAMES[planet.type]}${variantTag}`;
  els.vpDesignation.textContent = a.designation;
  els.vpClass.textContent = `${TYPE_NAMES[planet.type]}${variantTag}`;

  els.dRadius.textContent = `${fmt(a.radiusKm, 0)} km`;
  els.dMass.textContent = `${fmt(a.massE, 2)} M⊕`;
  els.dGrav.textContent = `${fmt(a.gravity, 2)} m/s²`;
  els.dDay.textContent = `${fmt(a.dayHrs, 1)} hr`;
  els.dAlbedo.textContent = fmt(a.albedo, 2);
  els.dTemp.textContent = `${fmt(a.tempC, 0)} °C`;
  if (a.pressureAtm < 0.01) els.dPressure.textContent = `${fmt(a.pressureAtm * 1000, 2)} mbar`;
  else if (a.pressureAtm > 100) els.dPressure.textContent = `${fmt(a.pressureAtm, 0)} atm`;
  else els.dPressure.textContent = `${fmt(a.pressureAtm, 2)} atm`;

  // Composition bar
  els.compBar.innerHTML = '';
  els.compLegend.innerHTML = '';
  for (const c of a.composition) {
    const seg = document.createElement('div');
    seg.style.background = c.col;
    seg.style.width = c.pct + '%';
    els.compBar.appendChild(seg);
    const lg = document.createElement('span');
    lg.innerHTML = `<span class="swatch" style="background:${c.col}"></span>${c.name} <span class="pct">${c.pct}%</span>`;
    els.compLegend.appendChild(lg);
  }

  // Features
  els.features.innerHTML = '';
  for (const f of a.features) {
    const tag = document.createElement('span');
    tag.className = 'feature-tag';
    tag.textContent = f;
    els.features.appendChild(tag);
  }

  // Resources
  els.resources.innerHTML = '';
  if (a.resources) {
    for (const r of a.resources) {
      const row = document.createElement('div');
      row.className = 'data-row';
      row.style.fontSize = '10px';
      const lvlClass = r.level === 'RICH' ? 'green'
                     : r.level === 'ABUNDANT' ? 'tl'
                     : r.level === 'TRACE' ? 'dim' : '';
      row.innerHTML = `<span class="key">${r.name}</span><span class="val ${lvlClass}">${r.level}</span>`;
      els.resources.appendChild(row);
    }
  }

  // Habitability
  els.dHab.textContent = a.habitability;
  const hab = a.habitability;
  els.dHab.className = 'val tl';
  if (hab === 'HIGH') els.dHab.classList.replace('tl','green');
  else if (hab === 'HOSTILE' || hab === 'EXTREME') els.dHab.classList.replace('tl','warn');

  els.dWater.textContent = (planet.type === 'ocean') ? 'GLOBAL'
    : (planet.type === 'terrestrial') ? 'LIQUID'
    : (planet.type === 'primordial') ? 'LIQUID + LAVA'
    : (planet.type === 'ice') ? 'FROZEN'
    : (planet.type === 'volcanic') ? 'NONE / LAVA'
    : (planet.type === 'gas_giant' || planet.type === 'ice_giant') ? 'N/A'
    : 'NONE';

  els.meta.textContent = `RAD ${fmt(a.radiusKm,0)}km · ATM ${planet.atmosphere.toUpperCase()} · TEMP ${fmt(a.tempC,0)}°C`;
}

function showLoading(on) {
  els.loading.classList.toggle('active', on);
  els.status.textContent = on ? 'GENERATING' : 'READY';
  els.status.className = on ? 'working' : 'ok';
}

export { setUI, showLoading };
