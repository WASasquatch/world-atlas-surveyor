// Card export — renders a high-res survey-card PNG for the current planet.

import { clamp } from '../core/color.js';
import { els } from './dom.js';
import { fmt, TYPE_NAMES } from './format.js';

// ============================================================
// CARD EXPORT — high-res TCG-style card image
// Renders the planet at 1024x1024 (crisp, non-pixelated by using pixelScale=1)
// and composites it onto a 2048x3072 card with bordered TCG layout.
// ============================================================
function exportCard(renderer) {
  if (!renderer.planet) {
    console.warn('No planet to export');
    return;
  }
  const planet = renderer.planet;
  // the actual flat surface (biomes + relief + rivers + live terraform for
  // rocky, or the simulated dye for gas) — the "as seen" map minus lighting /
  // clouds / atmosphere. Used by the surface AND thermal modules.
  const surfEq = (renderer && renderer.readSurfaceEquirect) ? renderer.readSurfaceEquirect() : null;
  els.exportCard.disabled = true;
  els.exportCard.textContent = 'RENDERING...';

  // Defer to next tick so the button updates visibly first
  setTimeout(() => {
    try {
      const CARD_W = 2048, CARD_H = 4096;
      const card = document.createElement('canvas');
      card.width = CARD_W;
      card.height = CARD_H;
      const ctx = card.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';

      // ---- Background panel ----
      const bg = ctx.createLinearGradient(0, 0, 0, CARD_H);
      bg.addColorStop(0, '#0a0e16');
      bg.addColorStop(0.5, '#06070a');
      bg.addColorStop(1, '#0a0e16');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, CARD_W, CARD_H);

      // ---- Outer border ----
      const BORDER = 24;
      ctx.strokeStyle = '#4ad6c4';
      ctx.lineWidth = 6;
      ctx.strokeRect(BORDER, BORDER, CARD_W - BORDER*2, CARD_H - BORDER*2);
      ctx.strokeStyle = 'rgba(74, 214, 196, 0.3)';
      ctx.lineWidth = 2;
      ctx.strokeRect(BORDER + 14, BORDER + 14, CARD_W - (BORDER+14)*2, CARD_H - (BORDER+14)*2);

      // ---- Header band ----
      const HEADER_Y = 60;
      const HEADER_H = 180;
      ctx.fillStyle = 'rgba(74, 214, 196, 0.06)';
      ctx.fillRect(BORDER + 24, HEADER_Y, CARD_W - (BORDER+24)*2, HEADER_H);
      ctx.strokeStyle = 'rgba(74, 214, 196, 0.4)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(BORDER + 24, HEADER_Y + HEADER_H);
      ctx.lineTo(CARD_W - BORDER - 24, HEADER_Y + HEADER_H);
      ctx.stroke();

      // ---- Designation (top-left) ----
      const a = planet.attributes;
      ctx.fillStyle = '#4ad6c4';
      ctx.font = 'bold 78px "VT323", "Courier New", monospace';
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      ctx.fillText(a.designation, BORDER + 56, HEADER_Y + 30);

      const variantSuffix = (planet.variantName && planet.variantName !== 'Standard')
        ? ` · ${planet.variantName.toUpperCase()}` : '';
      ctx.fillStyle = '#ffaa44';
      ctx.font = 'bold 40px "VT323", "Courier New", monospace';
      ctx.fillText(`CLASS  ${TYPE_NAMES[planet.type] || ''}${variantSuffix}`, BORDER + 56, HEADER_Y + 116);

      // ---- Type tag (top-right) ----
      ctx.textAlign = 'right';
      ctx.fillStyle = '#4ad6c4';
      ctx.font = 'bold 38px "JetBrains Mono", "Courier New", monospace';
      ctx.fillText('// WORLD ATLAS SURVEYOR', CARD_W - BORDER - 56, HEADER_Y + 38);
      ctx.fillStyle = '#aaa';
      ctx.font = '32px "JetBrains Mono", "Courier New", monospace';
      ctx.fillText(`SEED · ${a.designation}`, CARD_W - BORDER - 56, HEADER_Y + 90);
      ctx.fillStyle = '#ffaa44';
      ctx.font = 'bold 32px "JetBrains Mono", "Courier New", monospace';
      ctx.fillText(a.habitability, CARD_W - BORDER - 56, HEADER_Y + 130);

      // ---- Planet image (upscaled from current renderer canvas with smoothing) ----
      const PLANET_AREA_TOP = HEADER_Y + HEADER_H + 60;
      const PLANET_AREA_H = 1280;
      const PLANET_AREA_W = CARD_W - (BORDER+60)*2;
      // Background stars (also upscaled, fills the full panel)
      ctx.drawImage(renderer.starsCanvas, BORDER + 60, PLANET_AREA_TOP,
                    PLANET_AREA_W, PLANET_AREA_H);
      // Planet — center-crop a SQUARE from the source canvas (renderer's
      // canvas matches the user's viewport, which is rarely square) so the
      // planet itself isn't stretched. Then draw centered in the panel.
      const srcW = renderer.canvas.width;
      const srcH = renderer.canvas.height;
      const srcSize = Math.min(srcW, srcH);
      const srcX = (srcW - srcSize) / 2;
      const srcY = (srcH - srcSize) / 2;
      const dstSize = Math.min(PLANET_AREA_W, PLANET_AREA_H);
      const dstX = (CARD_W - dstSize) / 2;
      const dstY = PLANET_AREA_TOP + (PLANET_AREA_H - dstSize) / 2;
      ctx.drawImage(renderer.canvas, srcX, srcY, srcSize, srcSize,
                    dstX, dstY, dstSize, dstSize);
      ctx.strokeStyle = 'rgba(74, 214, 196, 0.4)';
      ctx.lineWidth = 2;
      ctx.strokeRect(BORDER + 60, PLANET_AREA_TOP, PLANET_AREA_W, PLANET_AREA_H);

      // ============================================================
      // STATS / INSTRUMENT PANEL — modular readout layout
      // Each section is rendered as a framed "module" with header strip,
      // status indicator, and corner ticks, like a real instrument panel.
      // ============================================================

      // Deterministic readout values from seed — stable across re-exports
      const det = (seed, salt, lo, hi) => {
        let h = (seed ^ salt ^ 0x9E3779B9) >>> 0;
        h = Math.imul(h ^ (h >>> 16), 2246822507);
        h = Math.imul(h ^ (h >>> 13), 3266489909);
        h = (h ^ (h >>> 16)) >>> 0;
        return lo + (h / 4294967295) * (hi - lo);
      };
      const seedN = planet.seedNum;
      const orbitAU      = det(seedN, 0x101, 0.4, 8.0);
      const orbitalDays  = orbitAU * orbitAU * Math.sqrt(orbitAU) * 365 * (0.85 + det(seedN, 0x102, 0, 0.3));
      const eccentricity = det(seedN, 0x103, 0.01, 0.35);
      const axialTilt    = det(seedN, 0x104, 0, 45);
      const magnetic     = det(seedN, 0x105, 0.0, 4.5);
      const solarFlux    = (1361 / (orbitAU * orbitAU)) * (0.7 + det(seedN, 0x106, 0, 0.6));
      const surveyEpoch  = `${Math.floor(det(seedN, 0x201, 2387, 2459))}.${String(Math.floor(det(seedN, 0x202, 1, 365))).padStart(3, '0')}`;
      const galCoordRA   = `${String(Math.floor(det(seedN, 0x203, 0, 24))).padStart(2,'0')}h${String(Math.floor(det(seedN, 0x204, 0, 60))).padStart(2,'0')}m`;
      const galCoordDec  = `${det(seedN, 0x205, -90, 90) >= 0 ? '+' : ''}${det(seedN, 0x205, -90, 90).toFixed(1)}°`;
      const observerID   = `WAS-${String(Math.floor(det(seedN, 0x206, 100, 999)))}`;
      const scanIntegrity = det(seedN, 0x207, 0.91, 0.999);

      // ---- Helper: draw a module frame ----
      // Returns the inner content rect {x, y, w, h} for the caller to draw into.
      const drawModule = (x, y, w, h, label, statusText, statusColor) => {
        // Outer frame
        ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = 'rgba(74, 214, 196, 0.55)';
        ctx.lineWidth = 2;
        ctx.strokeRect(x, y, w, h);

        // Header strip
        const HSTRIP = 38;
        ctx.fillStyle = 'rgba(74, 214, 196, 0.13)';
        ctx.fillRect(x, y, w, HSTRIP);
        ctx.strokeStyle = 'rgba(74, 214, 196, 0.45)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, y + HSTRIP);
        ctx.lineTo(x + w, y + HSTRIP);
        ctx.stroke();

        // Module label (left)
        ctx.fillStyle = '#4ad6c4';
        ctx.font = 'bold 22px "JetBrains Mono", "Courier New", monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, x + 16, y + HSTRIP / 2 + 1);

        // Status indicator (right) — small filled circle + text
        if (statusText) {
          ctx.font = '18px "JetBrains Mono", "Courier New", monospace';
          ctx.textAlign = 'right';
          ctx.fillStyle = statusColor || '#7fff95';
          // dot
          const dotX = x + w - 16;
          ctx.beginPath();
          ctx.arc(dotX, y + HSTRIP / 2, 5, 0, Math.PI * 2);
          ctx.fill();
          // text
          ctx.fillText(statusText, x + w - 32, y + HSTRIP / 2 + 1);
        }

        // Corner ticks on outer frame (4 corners, small)
        ctx.strokeStyle = '#4ad6c4';
        ctx.lineWidth = 2;
        const TKL = 12;
        // top-left
        ctx.beginPath();
        ctx.moveTo(x, y + TKL); ctx.lineTo(x, y); ctx.lineTo(x + TKL, y);
        ctx.stroke();
        // top-right
        ctx.beginPath();
        ctx.moveTo(x + w - TKL, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + TKL);
        ctx.stroke();
        // bottom-left
        ctx.beginPath();
        ctx.moveTo(x, y + h - TKL); ctx.lineTo(x, y + h); ctx.lineTo(x + TKL, y + h);
        ctx.stroke();
        // bottom-right
        ctx.beginPath();
        ctx.moveTo(x + w - TKL, y + h); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w, y + h - TKL);
        ctx.stroke();

        ctx.textBaseline = 'top';
        return { x: x + 24, y: y + HSTRIP + 16, w: w - 48, h: h - HSTRIP - 32 };
      };

      // Reset baseline (was 'top' from earlier code)
      ctx.textBaseline = 'top';

      // Layout constants
      const STATS_INNER_X = BORDER + 60;
      const STATS_INNER_W = CARD_W - (BORDER+60)*2;
      const MOD_GAP = 24;
      const COL_W = (STATS_INNER_W - MOD_GAP) / 2;

      let cursorY = PLANET_AREA_TOP + PLANET_AREA_H + 40;

      // =========================================================
      // MODULE 1 — SURVEY DATA (full-width)
      // 8 stats in 2 columns + atmospheric composition bar
      // =========================================================
      {
        const M_H = 460;
        const inner = drawModule(STATS_INNER_X, cursorY, STATS_INNER_W, M_H,
                                 '◆ SURVEY DATA / PHYSICAL', 'NOMINAL', '#7fff95');

        const fmt = (x, d=2) => Number(x).toFixed(d).replace(/\.?0+$/, '') || '0';
        const rows = [
          ['RADIUS',     `${fmt(a.radiusKm, 0)} km`],
          ['MASS',       `${fmt(a.massE, 2)} M⊕`],
          ['GRAVITY',    `${fmt(a.gravity, 2)} m/s²`],
          ['DAY LENGTH', `${fmt(a.dayHrs, 1)} hr`],
          ['ALBEDO',     fmt(a.albedo, 2)],
          ['MEAN TEMP',  `${fmt(a.tempC, 0)} °C`],
          ['ATMOSPHERE', planet.atmosphere.toUpperCase()],
          ['PRESSURE',   a.pressureAtm < 0.01 ? `${fmt(a.pressureAtm * 1000, 2)} mbar`
                         : a.pressureAtm > 100 ? `${fmt(a.pressureAtm, 0)} atm`
                         : `${fmt(a.pressureAtm, 2)} atm`],
        ];
        ctx.font = '26px "JetBrains Mono", "Courier New", monospace';
        const rowH = 44;
        const subColW = (inner.w - 32) / 2;
        for (let i = 0; i < rows.length; i++) {
          const col = i % 2;
          const rowI = Math.floor(i / 2);
          const rx = inner.x + col * (subColW + 32);
          const ry = inner.y + rowI * rowH;
          // Row baseline
          ctx.strokeStyle = 'rgba(74, 214, 196, 0.08)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(rx, ry + rowH - 10);
          ctx.lineTo(rx + subColW, ry + rowH - 10);
          ctx.stroke();
          ctx.fillStyle = '#888';
          ctx.textAlign = 'left';
          ctx.fillText(rows[i][0], rx, ry + 4);
          ctx.fillStyle = '#e8e8e8';
          ctx.textAlign = 'right';
          ctx.fillText(rows[i][1], rx + subColW, ry + 4);
        }

        // Atmospheric composition bar inside same module
        const ACY = inner.y + 4 * rowH + 20;
        ctx.fillStyle = '#ffaa44';
        ctx.font = 'bold 20px "JetBrains Mono", "Courier New", monospace';
        ctx.textAlign = 'left';
        ctx.fillText('ATMOSPHERIC COMPOSITION', inner.x, ACY);
        const BAR_W = inner.w;
        const BAR_H = 22;
        let bx = inner.x;
        for (const c of a.composition) {
          const wid = (c.pct / 100) * BAR_W;
          ctx.fillStyle = c.col;
          ctx.fillRect(bx, ACY + 28, wid, BAR_H);
          bx += wid;
        }
        ctx.strokeStyle = 'rgba(255,255,255,0.18)';
        ctx.lineWidth = 1;
        ctx.strokeRect(inner.x, ACY + 28, BAR_W, BAR_H);
        // Legend
        ctx.font = '20px "JetBrains Mono", "Courier New", monospace';
        let lx = inner.x;
        const ly = ACY + 70;
        for (const c of a.composition) {
          ctx.fillStyle = c.col;
          ctx.fillRect(lx, ly + 4, 14, 14);
          ctx.fillStyle = '#ccc';
          ctx.textAlign = 'left';
          ctx.fillText(`${c.name} ${c.pct}%`, lx + 22, ly);
          lx += ctx.measureText(`${c.name} ${c.pct}%`).width + 48;
          if (lx > inner.x + inner.w - 200) break;
        }

        cursorY += M_H + MOD_GAP;
      }

      // =========================================================
      // MODULE 2 — Resources (left) + Features (right)
      // =========================================================
      {
        const M_H = 320;
        const innerL = drawModule(STATS_INNER_X, cursorY, COL_W, M_H,
                                  '◆ DETECTED RESOURCES', 'SCAN OK', '#7fff95');
        const innerR = drawModule(STATS_INNER_X + COL_W + MOD_GAP, cursorY, COL_W, M_H,
                                  '◆ SURFACE FEATURES', 'CATALOGED', '#4ad6c4');

        // Resources
        ctx.font = '22px "JetBrains Mono", "Courier New", monospace';
        const resList = a.resources || [];
        for (let i = 0; i < resList.length && i < 6; i++) {
          const ry = innerL.y + i * 36;
          const r = resList[i];
          // Faint baseline
          ctx.strokeStyle = 'rgba(74, 214, 196, 0.06)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(innerL.x, ry + 30);
          ctx.lineTo(innerL.x + innerL.w, ry + 30);
          ctx.stroke();
          ctx.fillStyle = '#ccc';
          ctx.textAlign = 'left';
          ctx.fillText(r.name, innerL.x, ry);
          // Level pill
          const lvlColor = r.level === 'RICH' ? '#7fff95'
                         : r.level === 'ABUNDANT' ? '#4ad6c4'
                         : r.level === 'TRACE' ? '#888' : '#e0e0e0';
          ctx.fillStyle = lvlColor;
          ctx.textAlign = 'right';
          ctx.fillText(r.level, innerL.x + innerL.w, ry);
        }

        // Features
        const featList = a.features || [];
        ctx.fillStyle = '#ccc';
        ctx.textAlign = 'left';
        ctx.font = '22px "JetBrains Mono", "Courier New", monospace';
        for (let i = 0; i < featList.length && i < 6; i++) {
          const fy = innerR.y + i * 36;
          ctx.strokeStyle = 'rgba(74, 214, 196, 0.06)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(innerR.x, fy + 30);
          ctx.lineTo(innerR.x + innerR.w, fy + 30);
          ctx.stroke();
          ctx.fillStyle = '#4ad6c4';
          ctx.fillText('◇', innerR.x, fy);
          ctx.fillStyle = '#ccc';
          ctx.fillText(featList[i], innerR.x + 24, fy);
        }

        cursorY += M_H + MOD_GAP;
      }

      // =========================================================
      // MODULE 3 — Equirectangular surface map (full-width)
      // =========================================================
      {
        // Budget the module height; derive a true 2:1 equirectangular map
        // that fits inside, centered horizontally. Avoids stretching the
        // projection while keeping the overall card height in budget.
        const M_H = 740;
        const inner = drawModule(STATS_INNER_X, cursorY, STATS_INNER_W, M_H,
                                 '◆ SURFACE MAP / EQUIRECTANGULAR PROJECTION',
                                 `${planet.texW}×${planet.texH} BAKE`, '#4ad6c4');

        // Map: keep 2:1 aspect, fit within (inner.w x (inner.h - 36 for labels))
        const labelSpace = 36;
        const availH = inner.h - labelSpace;
        const availW = inner.w;
        let SM_W = availW;
        let SM_H = Math.floor(SM_W / 2);
        if (SM_H > availH) {
          SM_H = availH;
          SM_W = SM_H * 2;
        }
        const SM_X = inner.x + (inner.w - SM_W) / 2;
        const SM_Y = inner.y + 4;

        // Surface source — gas giants use the LIVE simulated dye (the finished
        // flowing map); everything else the baked colorMap.
        const TXW = planet.texW, TXH = planet.texH;
        const surfCanvas = document.createElement('canvas');
        if (surfEq) {
          surfCanvas.width = surfEq.w; surfCanvas.height = surfEq.h;
          const gctx = surfCanvas.getContext('2d');
          const gimg = gctx.createImageData(surfEq.w, surfEq.h);
          gimg.data.set(surfEq.data);
          gctx.putImageData(gimg, 0, 0);
        } else {
          surfCanvas.width = TXW; surfCanvas.height = TXH;
          const sctx = surfCanvas.getContext('2d');
          const surfImg = sctx.createImageData(TXW, TXH);
          const sd = surfImg.data;
          const cmap = planet.colorMap;
          for (let i = 0; i < TXW * TXH; i++) {
            sd[i*4] = cmap[i*3]; sd[i*4+1] = cmap[i*3+1]; sd[i*4+2] = cmap[i*3+2]; sd[i*4+3] = 255;
          }
          sctx.putImageData(surfImg, 0, 0);
        }

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(surfCanvas, SM_X, SM_Y, SM_W, SM_H);

        // Latitude grid overlay
        ctx.strokeStyle = 'rgba(74, 214, 196, 0.25)';
        ctx.lineWidth = 1;
        ctx.setLineDash([6, 8]);
        const latLines = [-66.5, -23.5, 0, 23.5, 66.5];
        for (const lat of latLines) {
          const v = (90 - lat) / 180;
          const ly = SM_Y + v * SM_H;
          ctx.beginPath(); ctx.moveTo(SM_X, ly); ctx.lineTo(SM_X + SM_W, ly); ctx.stroke();
        }
        for (let g = 1; g < 6; g++) {
          const lx = SM_X + (g / 6) * SM_W;
          ctx.beginPath(); ctx.moveTo(lx, SM_Y); ctx.lineTo(lx, SM_Y + SM_H); ctx.stroke();
        }
        ctx.setLineDash([]);
        // Map frame
        ctx.strokeStyle = 'rgba(74, 214, 196, 0.55)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(SM_X, SM_Y, SM_W, SM_H);

        // Latitude axis labels
        ctx.fillStyle = '#888';
        ctx.font = '16px "JetBrains Mono", "Courier New", monospace';
        ctx.textAlign = 'left';
        const latLabels = [['90°N', 0], ['45°N', 0.25], ['0°', 0.5], ['45°S', 0.75], ['90°S', 1.0]];
        for (const [lab, t] of latLabels) {
          ctx.fillText(lab, SM_X + 6, SM_Y + t * SM_H + 4);
        }
        ctx.textAlign = 'center';
        const lonLabels = [['-180°', 0], ['-90°', 0.25], ['0°', 0.5], ['+90°', 0.75], ['+180°', 1.0]];
        for (const [lab, t] of lonLabels) {
          ctx.fillText(lab, SM_X + t * SM_W, SM_Y + SM_H + 18);
        }

        cursorY += M_H + MOD_GAP;
      }

      // =========================================================
      // MODULE 4 — Spectral signature (left) + Thermal IR (right)
      // =========================================================
      {
        const M_H = 360;
        const innerL = drawModule(STATS_INNER_X, cursorY, COL_W, M_H,
                                  '◆ SPECTRAL SIGNATURE / λ 0.4–5.0μm', 'INTEG 12.4s', '#4ad6c4');
        const innerR = drawModule(STATS_INNER_X + COL_W + MOD_GAP, cursorY, COL_W, M_H,
                                  '◆ THERMAL MAP / IR 8–13μm', 'CALIBRATED', '#7fff95');

        // ---- Spectral plot ----
        const SPEC_PADX = 8;
        const spec_x0 = innerL.x + SPEC_PADX;
        const spec_x1 = innerL.x + innerL.w - SPEC_PADX;
        const spec_y0 = innerL.y;
        const spec_y1 = innerL.y + innerL.h - 28;

        // Background
        ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
        ctx.fillRect(spec_x0, spec_y0, spec_x1 - spec_x0, spec_y1 - spec_y0);
        // Vertical gridlines + labels (every 1μm)
        ctx.strokeStyle = 'rgba(74, 214, 196, 0.10)';
        ctx.lineWidth = 1;
        for (let g = 1; g <= 4; g++) {
          const gx = spec_x0 + (g / 4.6) * (spec_x1 - spec_x0);
          ctx.beginPath();
          ctx.moveTo(gx, spec_y0);
          ctx.lineTo(gx, spec_y1);
          ctx.stroke();
        }
        // Horizontal gridlines (intensity)
        for (let g = 1; g <= 3; g++) {
          const gy = spec_y0 + (g / 4) * (spec_y1 - spec_y0);
          ctx.beginPath();
          ctx.moveTo(spec_x0, gy);
          ctx.lineTo(spec_x1, gy);
          ctx.stroke();
        }

        const ABSORPTION_BANDS = {
          'H2O': [{l:1.4,w:0.18},{l:1.9,w:0.20},{l:2.7,w:0.24}],
          'CO2': [{l:2.0,w:0.06},{l:2.7,w:0.08},{l:4.3,w:0.12}],
          'CH4': [{l:1.65,w:0.10},{l:2.3,w:0.14},{l:3.3,w:0.18}],
          'N2':  [{l:4.3,w:0.05}],
          'O2':  [{l:0.76,w:0.05},{l:1.27,w:0.04}],
          'O3':  [{l:0.6,w:0.06},{l:4.7,w:0.10}],
          'NH3': [{l:1.5,w:0.10},{l:2.0,w:0.10},{l:3.0,w:0.18}],
          'H2':  [{l:2.4,w:0.12}],
          'He':  [], 'Ar': [],
          'SO2': [{l:4.0,w:0.20}],
          'CO':  [{l:2.35,w:0.06},{l:4.7,w:0.08}],
        };
        // Composition names use unicode subscripts (N₂, CO₂, CH₄/NH₃, …) but the
        // band table is keyed by ASCII (N2, CO2, CH4). Normalise: strip
        // subscripts and split composite labels so absorption features actually
        // appear (previously every world drew the identical baseline curve).
        const SUB = { '₀':'0','₁':'1','₂':'2','₃':'3','₄':'4','₅':'5','₆':'6','₇':'7','₈':'8','₉':'9' };
        const bandsForName = (name) => {
          const ascii = String(name).replace(/[₀-₉]/g, (ch) => SUB[ch] || ch);
          let out = [];
          for (let part of ascii.split('/')) {
            part = part.trim();
            const bb = ABSORPTION_BANDS[part];
            if (bb) out = out.concat(bb);
          }
          return out;
        };
        const N_SAMPLES = 240;
        const yvals = new Float32Array(N_SAMPLES);
        for (let s = 0; s < N_SAMPLES; s++) {
          const lam = 0.4 + (s / (N_SAMPLES - 1)) * 4.6;
          let intensity = 1.0 - Math.pow((lam - 0.4) / 4.6, 0.6) * 0.55;
          for (const c of a.composition) {
            const bands = bandsForName(c.name);
            for (const b of bands) {
              const dl = lam - b.l;
              intensity -= Math.exp(-(dl*dl) / (2 * b.w * b.w)) * (c.pct / 100) * 0.85;
            }
          }
          intensity += det(seedN, 0x300 + s, -1, 1) * 0.012;
          if (intensity < 0.02) intensity = 0.02;
          if (intensity > 1) intensity = 1;
          yvals[s] = intensity;
        }
        // Filled area
        ctx.beginPath();
        ctx.moveTo(spec_x0, spec_y1);
        for (let s = 0; s < N_SAMPLES; s++) {
          const px = spec_x0 + (s / (N_SAMPLES - 1)) * (spec_x1 - spec_x0);
          const py = spec_y1 - yvals[s] * (spec_y1 - spec_y0);
          ctx.lineTo(px, py);
        }
        ctx.lineTo(spec_x1, spec_y1);
        ctx.closePath();
        ctx.fillStyle = 'rgba(74, 214, 196, 0.22)';
        ctx.fill();
        // Curve
        ctx.beginPath();
        for (let s = 0; s < N_SAMPLES; s++) {
          const px = spec_x0 + (s / (N_SAMPLES - 1)) * (spec_x1 - spec_x0);
          const py = spec_y1 - yvals[s] * (spec_y1 - spec_y0);
          if (s === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.strokeStyle = '#4ad6c4';
        ctx.lineWidth = 1.8;
        ctx.stroke();
        // Frame
        ctx.strokeStyle = 'rgba(74,214,196,0.4)';
        ctx.lineWidth = 1;
        ctx.strokeRect(spec_x0, spec_y0, spec_x1 - spec_x0, spec_y1 - spec_y0);
        // X labels
        ctx.fillStyle = '#888';
        ctx.font = '16px "JetBrains Mono", "Courier New", monospace';
        ctx.textAlign = 'center';
        for (let g = 1; g <= 4; g++) {
          const gx = spec_x0 + (g / 4.6) * (spec_x1 - spec_x0);
          ctx.fillText(`${g}μm`, gx, spec_y1 + 6);
        }
        ctx.textAlign = 'left';
        ctx.fillText('I/I₀', spec_x0 + 4, spec_y0 + 4);

        // ---- Thermal map ----
        const THERM_W = 256, THERM_H = 128;
        const therm = document.createElement('canvas');
        therm.width = THERM_W; therm.height = THERM_H;
        const tctx = therm.getContext('2d');
        const timgData = tctx.createImageData(THERM_W, THERM_H);
        const td = timgData.data;
        const baseTemp = a.tempC;
        const hmRef = planet.heightMap;
        const HMW = planet.texW, HMH = planet.texH;
        const cfgRef = planet._cfg || {seaLevel: 0};
        const rampColor = (norm) => {
          const stops = [
            [0.00,[10,8,60]],[0.20,[40,80,200]],[0.40,[80,200,230]],
            [0.55,[120,230,110]],[0.70,[255,230,70]],[0.85,[255,110,40]],[1.00,[220,30,30]]
          ];
          for (let i = 0; i < stops.length - 1; i++) {
            if (norm >= stops[i][0] && norm <= stops[i+1][0]) {
              const f = (norm - stops[i][0]) / (stops[i+1][0] - stops[i][0]);
              return [
                stops[i][1][0]*(1-f) + stops[i+1][1][0]*f,
                stops[i][1][1]*(1-f) + stops[i+1][1][1]*f,
                stops[i][1][2]*(1-f) + stops[i+1][1][2]*f,
              ];
            }
          }
          return stops[stops.length-1][1];
        };
        const tempColor = (t) => rampColor(clamp((t + 100) / 200, 0, 1));
        // Gas giants: derive the IR map from an INVERTED cloud/dye brightness
        // (thick bright cloud tops read cold, dark rifts let faint heat from
        // the deep interior show through) plus a warm equatorial inner-heat
        // baseline — extreme temps, but structure visible on a calibrated scale.
        const isGasTherm = cfgRef.kind === 'gas';
        const gasThermSrc = isGasTherm ? (surfEq || { data: null }) : null;
        for (let j = 0; j < THERM_H; j++) {
          const v = (j + 0.5) / THERM_H;
          const lat = (v - 0.5) * Math.PI;
          const latFactor = -Math.cos(lat * 0.5) * 50;
          for (let i = 0; i < THERM_W; i++) {
            const u = (i + 0.5) / THERM_W;
            const hi = Math.floor(u * HMW) % HMW;
            const hj = Math.floor(v * HMH) % HMH;
            const h = hmRef[hj * HMW + hi];
            const altF = (h > cfgRef.seaLevel) ? -(h - cfgRef.seaLevel) * 30 : 0;
            const dayDelta = Math.cos((u - 0.5) * Math.PI * 2) * 18;
            let tr, tg, tb;
            if (isGasTherm) {
              // sample cloud brightness (live dye if available, else baked map)
              let L;
              if (gasThermSrc.data) {
                const gi = Math.floor(u * gasThermSrc.w) % gasThermSrc.w;
                const gj = Math.floor(v * gasThermSrc.h) % gasThermSrc.h;
                const gp = (gj * gasThermSrc.w + gi) * 4;
                L = (gasThermSrc.data[gp] * 0.299 + gasThermSrc.data[gp+1] * 0.587 + gasThermSrc.data[gp+2] * 0.114) / 255;
              } else {
                const ci = Math.floor(u * HMW) % HMW, cj = Math.floor(v * HMH) % HMH;
                const cp = (cj * HMW + ci) * 3;
                L = (planet.colorMap[cp] * 0.299 + planet.colorMap[cp+1] * 0.587 + planet.colorMap[cp+2] * 0.114) / 255;
              }
              // Brown dwarfs EMIT from the bright hot-rift dye (bright = hot
              // interior showing through), so heat tracks L directly. Ordinary
              // gas giants are the opposite: thick BRIGHT cloud tops read cold
              // and dark rifts let the warm interior through, so heat tracks
              // (1 - L). Without this split the brown-dwarf IR map is inverted
              // (its cool, non-emissive cloud bands print as the hottest).
              const heatL = cfgRef.selfEmit ? L : (1.0 - L);
              const inner = heatL * 0.55 + (1.0 - Math.abs(v - 0.5) * 2.0) * 0.22;
              const norm = clamp(0.10 + inner * 0.82 + det(seedN ^ (i * 31 + j * 7), 0x400, -0.02, 0.02), 0, 1);
              [tr, tg, tb] = rampColor(norm);
            } else {
              let tC = baseTemp + latFactor + altF + dayDelta;
              tC += det(seedN ^ (i * 31 + j * 7), 0x400, -3, 3);
              [tr, tg, tb] = tempColor(tC);
            }
            const idx = (j * THERM_W + i) * 4;
            td[idx]=tr; td[idx+1]=tg; td[idx+2]=tb; td[idx+3]=255;
          }
        }
        tctx.putImageData(timgData, 0, 0);
        // Map area inside module
        const TM_X = innerR.x + 8;
        const TM_Y = innerR.y;
        const TM_W = innerR.w - 16;
        const TM_H = innerR.h - 56;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'low';
        ctx.drawImage(therm, TM_X, TM_Y, TM_W, TM_H);
        ctx.imageSmoothingQuality = 'high';
        ctx.strokeStyle = 'rgba(74,214,196,0.4)';
        ctx.lineWidth = 1;
        ctx.strokeRect(TM_X, TM_Y, TM_W, TM_H);

        // Lat/lon grid
        ctx.strokeStyle = 'rgba(255,255,255,0.12)';
        ctx.setLineDash([4, 6]);
        for (const lat of [-66.5, -23.5, 0, 23.5, 66.5]) {
          const v = (90 - lat) / 180;
          ctx.beginPath();
          ctx.moveTo(TM_X, TM_Y + v * TM_H);
          ctx.lineTo(TM_X + TM_W, TM_Y + v * TM_H);
          ctx.stroke();
        }
        ctx.setLineDash([]);

        // Scale bar below thermal map
        const SC_Y = TM_Y + TM_H + 14;
        const SC_X = TM_X;
        const SC_W = TM_W;
        const SC_H = 8;
        const sg = ctx.createLinearGradient(SC_X, 0, SC_X + SC_W, 0);
        sg.addColorStop(0.00,'rgb(10,8,60)');sg.addColorStop(0.20,'rgb(40,80,200)');
        sg.addColorStop(0.40,'rgb(80,200,230)');sg.addColorStop(0.55,'rgb(120,230,110)');
        sg.addColorStop(0.70,'rgb(255,230,70)');sg.addColorStop(0.85,'rgb(255,110,40)');
        sg.addColorStop(1.00,'rgb(220,30,30)');
        ctx.fillStyle = sg;
        ctx.fillRect(SC_X, SC_Y, SC_W, SC_H);
        ctx.fillStyle = '#888';
        ctx.font = '14px "JetBrains Mono", "Courier New", monospace';
        ctx.textAlign = 'left';
        ctx.fillText('-100°C', SC_X, SC_Y + SC_H + 4);
        ctx.textAlign = 'center';
        ctx.fillText('0°C', SC_X + SC_W / 2, SC_Y + SC_H + 4);
        ctx.textAlign = 'right';
        ctx.fillText('+100°C', SC_X + SC_W, SC_Y + SC_H + 4);

        cursorY += M_H + MOD_GAP;
      }

      // =========================================================
      // MODULE 5 — Orbital/Geophysical (left) + Observation Log (right)
      // =========================================================
      {
        const M_H = 320;
        const innerL = drawModule(STATS_INNER_X, cursorY, COL_W, M_H,
                                  '◆ ORBITAL & GEOPHYSICAL', `${(scanIntegrity * 100).toFixed(1)}% INT`,
                                  scanIntegrity > 0.95 ? '#7fff95' : '#ffaa44');
        const innerR = drawModule(STATS_INNER_X + COL_W + MOD_GAP, cursorY, COL_W, M_H,
                                  '◆ OBSERVATION LOG', observerID, '#4ad6c4');

        ctx.font = '22px "JetBrains Mono", "Courier New", monospace';
        const orbitRows = [
          ['SEMI-MAJOR AXIS', `${orbitAU.toFixed(3)} AU`],
          ['ORBITAL PERIOD',  `${orbitalDays.toFixed(1)} d`],
          ['ECCENTRICITY',    eccentricity.toFixed(3)],
          ['AXIAL TILT',      `${axialTilt.toFixed(1)}°`],
          ['MAGNETIC FIELD',  `${magnetic.toFixed(2)} G`],
          ['SOLAR FLUX',      `${solarFlux.toFixed(0)} W/m²`],
        ];
        for (let i = 0; i < orbitRows.length; i++) {
          const oy = innerL.y + i * 36;
          ctx.strokeStyle = 'rgba(74, 214, 196, 0.06)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(innerL.x, oy + 30);
          ctx.lineTo(innerL.x + innerL.w, oy + 30);
          ctx.stroke();
          ctx.fillStyle = '#888';
          ctx.textAlign = 'left';
          ctx.fillText(orbitRows[i][0], innerL.x, oy);
          ctx.fillStyle = '#e8e8e8';
          ctx.textAlign = 'right';
          ctx.fillText(orbitRows[i][1], innerL.x + innerL.w, oy);
        }

        const logRows = [
          ['SCAN EPOCH',      surveyEpoch],
          ['CATALOG RA',      galCoordRA],
          ['CATALOG DEC',     galCoordDec],
          ['OBSERVER',        observerID],
          ['SCAN INTEGRITY',  `${(scanIntegrity * 100).toFixed(1)}%`],
          ['DATA REVISION',   `r${Math.floor(det(seedN, 0x208, 1, 99))}`],
        ];
        for (let i = 0; i < logRows.length; i++) {
          const oy = innerR.y + i * 36;
          ctx.strokeStyle = 'rgba(74, 214, 196, 0.06)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(innerR.x, oy + 30);
          ctx.lineTo(innerR.x + innerR.w, oy + 30);
          ctx.stroke();
          ctx.fillStyle = '#888';
          ctx.textAlign = 'left';
          ctx.fillText(logRows[i][0], innerR.x, oy);
          ctx.fillStyle = '#e8e8e8';
          ctx.textAlign = 'right';
          ctx.fillText(logRows[i][1], innerR.x + innerR.w, oy);
        }

        cursorY += M_H + MOD_GAP;
      }


      // Corner ticks
      ctx.strokeStyle = '#4ad6c4';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(BORDER + 4, BORDER + 50);
      ctx.lineTo(BORDER + 4, BORDER + 4);
      ctx.lineTo(BORDER + 50, BORDER + 4);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(CARD_W - BORDER - 50, BORDER + 4);
      ctx.lineTo(CARD_W - BORDER - 4, BORDER + 4);
      ctx.lineTo(CARD_W - BORDER - 4, BORDER + 50);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(BORDER + 4, CARD_H - BORDER - 50);
      ctx.lineTo(BORDER + 4, CARD_H - BORDER - 4);
      ctx.lineTo(BORDER + 50, CARD_H - BORDER - 4);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(CARD_W - BORDER - 50, CARD_H - BORDER - 4);
      ctx.lineTo(CARD_W - BORDER - 4, CARD_H - BORDER - 4);
      ctx.lineTo(CARD_W - BORDER - 4, CARD_H - BORDER - 50);
      ctx.stroke();

      ctx.fillStyle = '#666';
      ctx.font = '20px "JetBrains Mono", "Courier New", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('WAS · WORLD ATLAS SURVEYOR',
                   CARD_W / 2, CARD_H - BORDER - 50);

      // Trigger download via blob + anchor
      card.toBlob((blob) => {
        if (!blob) {
          console.error('Card export: toBlob returned null');
          alert('Card export failed — try again.');
          els.exportCard.disabled = false;
          els.exportCard.textContent = 'EXPORT CARD';
          return;
        }
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.download = `was_${a.designation.replace(/[^A-Z0-9_-]/gi, '_')}.png`;
        link.href = url;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(url), 1500);
        els.exportCard.disabled = false;
        els.exportCard.textContent = 'EXPORT CARD';
      }, 'image/png');
    } catch (e) {
      console.error('Card export error:', e);
      alert('Card export failed: ' + e.message);
      els.exportCard.disabled = false;
      els.exportCard.textContent = 'EXPORT CARD';
    }
  }, 30);
}

export { exportCard };
