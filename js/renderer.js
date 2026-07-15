// Renderer — custom CPU rasterizer writing directly to ImageData.
// Draws the planet with per-channel lighting, clouds, atmosphere,
// auroras, and a separately cached starfield.

import { mulberry32 } from './core/prng.js';
import { clamp } from './core/color.js';


// ============================================================
// RENDERER
// ============================================================
class Renderer {
  constructor(canvas, starsCanvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.starsCanvas = starsCanvas;
    this.starsCtx = starsCanvas.getContext('2d');
    this.planet = null;
    this.rotation = 0;
    this.viewW = 0;
    this.viewH = 0;
    this.internalW = 0;
    this.internalH = 0;
    this.imgData = null;
    this.dpr = 1;
    this.frame = 0;
    this.lastFrameMs = 0;
    this.autoRotate = true;
    this.pixelScale = 3;
  }

  setPlanet(planet) {
    this.planet = planet;
    this.rotation = planet.rotation;
    this.frame = 0;
    this.recreateStars();
  }

  resize(viewW, viewH, pixelScale, aa) {
    this.viewW = Math.max(100, Math.floor(viewW));
    this.viewH = Math.max(100, Math.floor(viewH));
    this.pixelScale = pixelScale;
    if (aa != null) this.aa = aa;
    const ss = this.aa || 1;   // supersample factor (anti-aliasing)
    // internal resolution is viewport / pixelScale, × the AA supersample factor
    this.internalW = Math.max(50, Math.floor(this.viewW / pixelScale * ss));
    this.internalH = Math.max(50, Math.floor(this.viewH / pixelScale * ss));
    this.canvas.width = this.internalW;
    this.canvas.height = this.internalH;
    this.canvas.style.width = this.viewW + 'px';
    this.canvas.style.height = this.viewH + 'px';
    this.imgData = this.ctx.createImageData(this.internalW, this.internalH);

    this.starsCanvas.width = this.viewW;
    this.starsCanvas.height = this.viewH;
    this.starsCanvas.style.width = this.viewW + 'px';
    this.starsCanvas.style.height = this.viewH + 'px';
    this.recreateStars();
  }

  recreateStars() {
    if (!this.starsCtx) return;
    const W = this.viewW, H = this.viewH;

    // Build star data once. drawStars() repaints each frame with time-based
    // twinkle and chromatic flicker.
    const seed = this.planet ? this.planet.seedNum : 0xC0FFEE;
    const rng = mulberry32(seed ^ 0x1234567);

    // Cache the seeded nebula gradient as a static background image so we
    // don't recompute it every frame (it's the slow part).
    this.nebulaCache = document.createElement('canvas');
    this.nebulaCache.width = W;
    this.nebulaCache.height = H;
    const nctx = this.nebulaCache.getContext('2d');
    nctx.fillStyle = '#000';
    nctx.fillRect(0, 0, W, H);
    const nebHue1 = Math.floor(rng() * 60) + 200;
    const nebHue2 = (nebHue1 + 60) % 360;
    const grad = nctx.createRadialGradient(W*0.7, H*0.3, 0, W*0.7, H*0.3, Math.max(W,H)*0.6);
    grad.addColorStop(0, `hsla(${nebHue1}, 60%, 25%, 0.18)`);
    grad.addColorStop(0.5, `hsla(${nebHue2}, 50%, 12%, 0.08)`);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    nctx.fillStyle = grad;
    nctx.fillRect(0, 0, W, H);

    // Build star table
    const starCount = Math.floor(W * H / 800);
    const stars = new Array(starCount);
    for (let i = 0; i < starCount; i++) {
      const r1 = rng();
      const size = r1 < 0.85 ? 1 : r1 < 0.97 ? 1.5 : 2;
      // Color class: white (most), blue-white, warm-yellow, deep-red (rare)
      const cr = rng();
      let baseR, baseG, baseB;
      if (cr < 0.70)      { baseR = 255; baseG = 255; baseB = 255; }
      else if (cr < 0.85) { baseR = 180; baseG = 210; baseB = 255; }
      else if (cr < 0.95) { baseR = 255; baseG = 220; baseB = 180; }
      else                { baseR = 255; baseG = 170; baseB = 150; }
      // Twinkle parameters per star (out-of-sync amplitudes, frequencies, phase)
      // Most stars twinkle subtly, a small fraction more strongly (atmospheric
      // scintillation is uneven across the sky in real telescopes/eyes).
      const strong = rng() < 0.18;
      stars[i] = {
        x: Math.floor(rng() * W),
        y: Math.floor(rng() * H),
        size,
        baseBright: 0.30 + rng() * 0.70,
        baseR, baseG, baseB,
        // Twinkle: amplitude (how much brightness varies) + freq + phase
        twAmp:   strong ? 0.45 + rng() * 0.35 : 0.10 + rng() * 0.25,
        twFreq:  0.6 + rng() * 2.2,    // Hz-like (combined with anim time)
        twPhase: rng() * Math.PI * 2,
        // Chromatic flicker — offset per channel to simulate atmospheric
        // dispersion / different propagation speeds. Most stars have very
        // small chromatic offsets; ~12% have noticeable color flicker.
        chromAmp:   rng() < 0.12 ? 0.35 + rng() * 0.30 : 0.05 + rng() * 0.10,
        chromFreq:  0.4 + rng() * 1.5,
        chromPhase: rng() * Math.PI * 2,
      };
    }
    this.stars = stars;

    // Bigger glowing stars (foreground accents) — also build as data
    const bigStars = new Array(8);
    for (let i = 0; i < 8; i++) {
      bigStars[i] = {
        x: rng() * W,
        y: rng() * H,
        baseBright: 0.85 + rng() * 0.15,
        twAmp: 0.20 + rng() * 0.20,
        twFreq: 0.3 + rng() * 0.8,
        twPhase: rng() * Math.PI * 2,
      };
    }
    this.bigStars = bigStars;

    // Initial paint
    this.drawStars(0);
  }

  // Per-frame starfield repaint with time-based twinkle + chromatic flicker.
  drawStars(timeSec) {
    if (!this.starsCtx || !this.stars) return;
    const ctx = this.starsCtx;
    const W = this.viewW, H = this.viewH;

    // Background nebula (cached)
    if (this.nebulaCache) {
      ctx.drawImage(this.nebulaCache, 0, 0);
    } else {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
    }

    // Use ImageData for the small dot-stars — direct pixel writes are much
    // faster than thousands of fillRect calls per frame.
    const stars = this.stars;
    const data = ctx.getImageData(0, 0, W, H);
    const buf = data.data;
    for (let i = 0; i < stars.length; i++) {
      const s = stars[i];
      // Brightness twinkle (sin wave + small nonlinear bump for sparkle)
      const tw = Math.sin(timeSec * s.twFreq + s.twPhase);
      const sparkle = Math.max(0, tw * tw * tw);  // peaks brighter than troughs darker
      const bright = clamp(s.baseBright + s.twAmp * tw + sparkle * 0.15, 0.05, 1.4);

      // Chromatic flicker — three out-of-phase sine waves per channel, the
      // amount of channel separation scales with star's chromAmp.
      const cP = s.chromPhase, cF = s.chromFreq;
      const dR = Math.sin(timeSec * cF + cP)               * s.chromAmp;
      const dG = Math.sin(timeSec * cF + cP + 2.094)       * s.chromAmp;  // +120°
      const dB = Math.sin(timeSec * cF + cP + 4.189)       * s.chromAmp;  // +240°

      // Apply chromatic shift around the base color, then scale by brightness
      const r = clamp(s.baseR * (1 + dR), 0, 255) * bright;
      const g = clamp(s.baseG * (1 + dG), 0, 255) * bright;
      const b = clamp(s.baseB * (1 + dB), 0, 255) * bright;

      // Write pixel(s). Size 1 = single pixel, size 1.5/2 = small block.
      const px = s.x, py = s.y;
      if (s.size <= 1) {
        const idx = (py * W + px) * 4;
        buf[idx]     = r;
        buf[idx + 1] = g;
        buf[idx + 2] = b;
        buf[idx + 3] = 255;
      } else {
        const sz = s.size === 2 ? 2 : 1;  // 1.5 -> draw 1x1 + brighter center
        for (let oy = 0; oy <= sz; oy++) {
          for (let ox = 0; ox <= sz; ox++) {
            const xx = px + ox, yy = py + oy;
            if (xx < 0 || xx >= W || yy < 0 || yy >= H) continue;
            const idx = (yy * W + xx) * 4;
            // Edges of bigger dots a bit dimmer
            const edge = (ox + oy === 0) ? 1 : 0.7;
            buf[idx]     = r * edge;
            buf[idx + 1] = g * edge;
            buf[idx + 2] = b * edge;
            buf[idx + 3] = 255;
          }
        }
      }
    }
    ctx.putImageData(data, 0, 0);

    // Bigger glowing stars (foreground) — drawn with radial gradients on top
    const bigs = this.bigStars;
    if (bigs) {
      for (let i = 0; i < bigs.length; i++) {
        const s = bigs[i];
        const tw = Math.sin(timeSec * s.twFreq + s.twPhase);
        const bright = clamp(s.baseBright + s.twAmp * tw, 0.3, 1.0);
        const radius = 7 + tw * 1.5;  // size also pulses slightly
        const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, radius);
        g.addColorStop(0, `rgba(255,255,255,${0.9 * bright})`);
        g.addColorStop(0.3, `rgba(180,200,255,${0.4 * bright})`);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(s.x - radius, s.y - radius, radius * 2, radius * 2);
      }
    }
  }

  render(dt) {
    const t0 = performance.now();
    if (!this.planet) return;

    if (this.autoRotate) {
      // Slow rotation for asteroids — the shape map is precomputed in world
      // space so rotation produces smooth shape evolution (different bumps
      // facing camera over time) without per-frame instability.
      const speed = (this.planet.type === 'asteroid') ? 0.00008 : 0.0003;
      this.rotation += dt * speed;
    }

    // Accumulate animation time for star twinkle (independent of rotation)
    this.starTime = (this.starTime || 0) + dt * 0.001;
    this.drawStars(this.starTime);

    const planet = this.planet;
    const W = this.internalW, H = this.internalH;
    const data = this.imgData.data;

    // Planet display radius based on size
    const minDim = Math.min(W, H);
    const radius = minDim * (0.32 + planet.size * 0.16);  // bigger for big planets
    const cx = W / 2;
    const cy = H / 2;

    // Atmosphere thickness as fraction of planet radius beyond the surface.
    // Larger values make the halo more visible at low render resolution.
    const atmLevels = { none: 0, thin: 0.08, thick: 0.20, dense: 0.36 };
    const atmThickness = atmLevels[planet.atmosphere] || 0;
    const atmRadius = radius * (1 + atmThickness);

    // Light direction from azimuth/elevation (settable via Star sliders).
    // Convention: azimuth around the view-Y axis (0° = front-lit from camera,
    // negative = light from the left), elevation tilts above (positive = above).
    // Screen-space convention: +x right, +y down, +z toward viewer.
    const az = (this.sunAz != null ? this.sunAz : -28) * Math.PI / 180;
    const el = (this.sunEl != null ? this.sunEl :  18) * Math.PI / 180;
    const cosE = Math.cos(el);
    const lx = cosE * Math.sin(az);
    const ly = -Math.sin(el);
    const lz = cosE * Math.cos(az);

    // Sun color from hue + intensity. Hue maps through stellar classes:
    // -100 = M (red dwarf), 0 = G (sun-like), +100 = B (blue giant).
    // Per-channel values are applied to the directional light component so
    // ambient (night side) stays neutral while lit side picks up the tint.
    const hueT = (this.sunHue != null ? this.sunHue : 0) / 100;
    const intensityNorm = (this.sunIntensity != null ? this.sunIntensity : 100) / 100;
    let sunR, sunG, sunB;
    if (hueT < 0) {
      // Cool stars — drop green and blue more aggressively than red
      const t = -hueT;
      sunR = 1.0;
      sunG = 1.0 - t * 0.55;
      sunB = 1.0 - t * 0.85;
    } else {
      // Hot stars — drop red, leave blue at full
      sunR = 1.0 - hueT * 0.30;
      sunG = 1.0 - hueT * 0.10;
      sunB = 1.0;
    }
    sunR *= intensityNorm;
    sunG *= intensityNorm;
    sunB *= intensityNorm;
    // Average channel brightness — used as a unitless "sun magnitude" for
    // alpha scaling on atmosphere/halo (dim suns scatter less light, so
    // atmospheric features become more transparent rather than just dim).
    const sunMag = (sunR + sunG + sunB) / 3;
    const sunFalloff = sunMag < 1 ? sunMag : 1;

    // Atmosphere color
    const cfg = planet.getTypeConfig();
    const pal = planet.palette;
    const atmCol = pal.atmCol || [120, 180, 220];
    const auroraCol = pal.auroraCol;
    // Auroras visible on gas giants always, and on rocky planets with thick+ atmosphere
    const auroraEnabled = !!auroraCol && (cfg.kind === 'gas' || atmThickness >= 0.18);

    const sinT = Math.sin(this.rotation);
    const cosT = Math.cos(this.rotation);
    // Effective tilt = planet's intrinsic axial tilt + user-controlled view tilt.
    // The view tilt rotates the camera around the X axis so the user can see
    // the polar regions properly (where auroras are most visible).
    const viewTiltRad = (this.viewTilt || 0) * Math.PI / 180;
    const effTilt = planet.axialTilt + viewTiltRad;
    const sinTilt = Math.sin(effTilt);
    const cosTilt = Math.cos(effTilt);

    const tex = planet.colorMap;
    const heightMap = planet.heightMap;
    const cloudMap = planet.cloudMap;
    const TW = planet.texW, TH = planet.texH;

    const cloudColor = (cfg.kind === 'gas') ? null : pal.cloudCol;
    const seaLevel = cfg.seaLevel;

    // Primordial ash overlay — clouds over magma provinces shift toward a
    // dark/brown tint and stay denser. ashMap is null for non-primordial
    // bodies, in which case the renderer skips the entire ash blend.
    const ashMap = planet.ashMap || null;
    const ashCloudColor = ashMap ? (pal.ashCloud || [60, 45, 35]) : null;

    // Render-time detail noise — adds resolution-independent sub-texel grit
    // to rocky surfaces. The texture map is 768×384 baked: when each rendered
    // pixel covers <1 texel, bilinear sampling smooths everything into mush.
    // Sampling one octave of Perlin at high frequency in world space gives
    // crisp surface micro-texture that survives any zoom level. Disabled for
    // gas bodies (they have their own banded structure) and ice (the smooth
    // ice cap should stay smooth).
    const detailEnabled = (cfg.kind === 'rocky' && planet.type !== 'ice');
    const detailPerlin = planet.perlin;          // hoist for inner loop
    const dOff = planet.detailOffsets || [0, 0, 0];
    const dOX = dOff[0], dOY = dOff[1], dOZ = dOff[2];
    // Detail strength varies by surface kind: more on rough/rocky terrain,
    // less on smooth water bodies (where it would read as JPEG noise).
    const DETAIL_FREQ = 22;        // texels of detail across the body
    const DETAIL_AMP_LAND = 0.09;  // ±9% brightness — strong micro-texture
    const DETAIL_AMP_WATER = 0.025; // ±2.5% — barely-perceptible water grain

    // Asteroid / dwarf-planet shape parameters — bring into local scope so
    // the per-pixel inner loop doesn't pay a property-lookup cost.
    const shapeMap = planet.shapeMap;       // null for spherical bodies
    const hasShape = !!shapeMap;
    const maxShapeR = planet.maxShapeR || 1;
    const maxR2 = maxShapeR * maxShapeR;
    const SMW = planet.texW, SMH = planet.texH;

    for (let py = 0; py < H; py++) {
      const dy = (py - cy) / radius;
      for (let px = 0; px < W; px++) {
        const dx = (px - cx) / radius;
        const r2 = dx*dx + dy*dy;
        const idx4 = (py * W + px) * 4;

        // ===== Shape-aware silhouette test =====
        // For round bodies, shapeR = 1 and the test is the standard r²>1.
        // For irregular bodies, look up the precomputed shape factor at the
        // sphere-assumed world direction. This is O(1) per pixel and fully
        // deterministic — same input always gives same output, no
        // iteration that could fail to converge.
        let shapeR = 1;
        if (hasShape) {
          // Outer bound — early reject pixels that can't possibly be inside
          if (r2 > maxR2) {
            data[idx4 + 3] = 0;
            continue;
          }
          // Iterative shape lookup (2 iterations).
          //
          // The challenge: at screen position (dx,dy), we want the world
          // direction of the ACTUAL surface point — but that depends on dz
          // which depends on shapeR which we're trying to find. The original
          // single-pass version used dz=sqrt(1-r²) (sphere assumption) which
          // gives the right direction only IF the body is a unit sphere. For
          // an asteroid with bulges in dark regions, the sphere lookup
          // returned a shapeR for the WRONG direction — typically smaller
          // than the actual local radius — causing the silhouette test to
          // reject pixels that should be inside the bulge. The visible
          // symptom was clean concave bites taken out of the dark side.
          //
          // Fix: after the first lookup, recompute dz from the looked-up
          // shapeR and re-sample. Two iterations converges close enough.
          let dz_guess = (r2 < 1) ? Math.sqrt(1 - r2) : 0;
          for (let iter = 0; iter < 2; iter++) {
            const _ty = dy * cosTilt - dz_guess * sinTilt;
            const _tz = dy * sinTilt + dz_guess * cosTilt;
            const _wx = dx * cosT + _tz * sinT;
            const _wy = _ty;
            const _wz = -dx * sinT + _tz * cosT;
            const wL = Math.sqrt(_wx*_wx + _wy*_wy + _wz*_wz);
            if (wL < 0.0001) { shapeR = maxShapeR; break; }
            const slat = Math.asin(clamp(_wy / wL, -1, 1));
            const slon = Math.atan2(_wz, _wx);
            const su = (slon / (Math.PI * 2)) + 0.5;
            const sv = (slat / Math.PI) + 0.5;
            const fu = su * SMW - 0.5;
            const fv = sv * SMH - 0.5;
            const i0 = Math.floor(fu);
            const j0 = Math.floor(fv);
            const fx = fu - i0;
            const fy = fv - j0;
            const i0w = ((i0 % SMW) + SMW) % SMW;
            const i1w = (i0w + 1) % SMW;
            const j0c = clamp(j0, 0, SMH - 1);
            const j1c = clamp(j0 + 1, 0, SMH - 1);
            const s00 = shapeMap[j0c * SMW + i0w];
            const s10 = shapeMap[j0c * SMW + i1w];
            const s01 = shapeMap[j1c * SMW + i0w];
            const s11 = shapeMap[j1c * SMW + i1w];
            shapeR = s00 * (1 - fx) * (1 - fy)
                   + s10 * fx       * (1 - fy)
                   + s01 * (1 - fx) * fy
                   + s11 * fx       * fy;
            // Refine dz from this shapeR estimate. If shapeR² <= r², we're
            // outside; bail out (the silhouette test below will reject).
            const sR2 = shapeR * shapeR;
            if (sR2 <= r2) break;
            dz_guess = Math.sqrt(sR2 - r2);
          }
        }
        const shapeR2 = shapeR * shapeR;

        if (r2 > shapeR2) {
          // Outside the body — atmosphere glow if applicable
          if (atmThickness > 0) {
            const dr2 = r2;
            const outerR2 = (shapeR + atmThickness) * (shapeR + atmThickness);
            if (dr2 < outerR2) {
              const tEdge = (dr2 - shapeR2) / (outerR2 - shapeR2);
              const falloff = Math.pow(1 - tEdge, 1.4);
              const glowSide = clamp(dx * lx + dy * ly + 0.3, 0, 1);
              const a = falloff * (0.5 + glowSide * 0.7) * (atmThickness * 3.0);
              const aClamp = Math.min(0.95, a) * sunFalloff;
              // Store straight (non-premultiplied) color — the canvas
              // composites with non-premul alpha, so multiplying the color
              // by alpha here would apply alpha twice (once in our store,
              // once during compositing) and the halo would fade off as
              // alpha² instead of alpha. That created a visible darkening
              // step between the inner haze and the outer halo.
              data[idx4]     = atmCol[0] * sunR;
              data[idx4 + 1] = atmCol[1] * sunG;
              data[idx4 + 2] = atmCol[2] * sunB;
              data[idx4 + 3] = aClamp * 255;
            } else {
              data[idx4 + 3] = 0;
            }
          } else {
            data[idx4 + 3] = 0;
          }
          continue;
        }

        // Inside the body — compute correct dz on the deformed surface.
        const dz = Math.sqrt(shapeR2 - r2);
        // Surface normal (unit vector in view space) — divide by shapeR so
        // the (nx,ny,nz) we pass to the rotation pipeline is unit-length,
        // representing the angular direction the surface point lies in.
        const invR = 1 / shapeR;
        let nx = dx * invR, ny = dy * invR, nz = dz * invR;

        // Apply axial tilt (rotate around X axis)
        // After tilt: y' = y*cos - z*sin, z' = y*sin + z*cos
        let tx = nx;
        let ty = ny * cosTilt - nz * sinTilt;
        let tz = ny * sinTilt + nz * cosTilt;

        // Rotate around Y axis (planet spin)
        const wx = tx * cosT + tz * sinT;
        const wy = ty;
        const wz = -tx * sinT + tz * cosT;

        // Convert to UV
        const lat = Math.asin(clamp(wy, -1, 1));
        const lon = Math.atan2(wz, wx);
        let u = (lon / (Math.PI * 2)) + 0.5;
        let v = (lat / Math.PI) + 0.5;
        if (u < 0) u += 1;
        if (u >= 1) u -= 1;
        v = clamp(v, 0, 0.99999);

        // ---- Bilinear texture sampling (prevents shimmer under sub-pixel rotation) ----
        const fu = u * TW - 0.5;
        const fv = v * TH - 0.5;
        let i0 = Math.floor(fu);
        let j0 = Math.floor(fv);
        const fx = fu - i0;
        const fy = fv - j0;
        // Wrap U (longitude), clamp V (latitude)
        let i1 = i0 + 1;
        i0 = ((i0 % TW) + TW) % TW;
        i1 = ((i1 % TW) + TW) % TW;
        let j1 = j0 + 1;
        if (j0 < 0) j0 = 0; else if (j0 > TH - 1) j0 = TH - 1;
        if (j1 < 0) j1 = 0; else if (j1 > TH - 1) j1 = TH - 1;

        const w00 = (1 - fx) * (1 - fy);
        const w10 = fx * (1 - fy);
        const w01 = (1 - fx) * fy;
        const w11 = fx * fy;

        const t00 = j0 * TW + i0;
        const t10 = j0 * TW + i1;
        const t01 = j1 * TW + i0;
        const t11 = j1 * TW + i1;

        const c00 = t00 * 3, c10 = t10 * 3, c01 = t01 * 3, c11 = t11 * 3;
        let cr = tex[c00]   * w00 + tex[c10]   * w10 + tex[c01]   * w01 + tex[c11]   * w11;
        let cg = tex[c00+1] * w00 + tex[c10+1] * w10 + tex[c01+1] * w01 + tex[c11+1] * w11;
        let cb = tex[c00+2] * w00 + tex[c10+2] * w10 + tex[c01+2] * w01 + tex[c11+2] * w11;

        // Bilinear height (used by specular + lava glow)
        const hSample = heightMap[t00] * w00 + heightMap[t10] * w10
                      + heightMap[t01] * w01 + heightMap[t11] * w11;

        // ---- Render-time detail noise — sub-texel surface grit ----
        // World-space Perlin at high frequency. World coords (wx,wy,wz) are
        // already in the planet's rotating frame so the pattern stays glued
        // to the surface as the planet spins. Single octave keeps cost low
        // (~one Perlin call per surface pixel). Less amplitude over water
        // since water should look smooth-ish.
        //
        // Heightmap warp — offsetting the noise input by the local height
        // makes the detail pattern FOLLOW underlying topography rather than
        // floating independently of it. Classic Terragen "power-fractal
        // colorize" technique: noise warped by heightmap reads as geologic
        // banding rather than random TV static. Mountain ridges develop
        // their own noise signature; valleys develop a different one.
        if (detailEnabled) {
          const hWarp = (hSample - seaLevel) * 6;  // strength of warp
          const dn = detailPerlin.fbm(
            wx * DETAIL_FREQ + dOX + hWarp,
            wy * DETAIL_FREQ + dOY + hWarp * 0.5,
            wz * DETAIL_FREQ + dOZ + hWarp,
            1
          );
          const amp = (hSample < seaLevel) ? DETAIL_AMP_WATER : DETAIL_AMP_LAND;
          const detailMul = 1 + dn * amp;
          cr *= detailMul;
          cg *= detailMul;
          cb *= detailMul;
        }

        // Lighting model — ambient is mostly reflected/scattered sunlight,
        // so it scales with sun brightness AND inherits sun color. A tiny
        // starfloor represents diffuse cosmic background (other stars,
        // airglow) so a planet around a dead/zero-power star is faintly
        // visible rather than pitch black, but barely. This makes "POWER 0.4"
        // produce a genuinely dim world instead of the previous full-brightness
        // ambient that ignored the sun.
        const ndotl = nx * lx + ny * ly + nz * lz;
        let light = clamp(ndotl, 0, 1);
        const STARFLOOR = 0.012;
        // Brown dwarfs glow from their internal heat — they don't depend on
        // an external star for visibility. Override ambient + light to be
        // mostly self-emission with a subtle directional component for
        // the disk-shape readability.
        const isSelfEmit = !!cfg.selfEmit;
        let ambR, ambG, ambB, dirCoeff;
        if (isSelfEmit) {
          // Strong floor (self-emission), subtle directional component to
          // make the limb fade slightly so the sphere reads as 3D
          ambR = 0.85; ambG = 0.85; ambB = 0.85;
          dirCoeff = 0.15;
        } else {
          const AMB_BASE = (cfg.kind === 'gas') ? 0.13 : 0.08;
          ambR = STARFLOOR + AMB_BASE * sunR;
          ambG = STARFLOOR + AMB_BASE * sunG;
          ambB = STARFLOOR + AMB_BASE * sunB;
          dirCoeff = 1 - AMB_BASE;
        }
        const litR = isSelfEmit
          ? ambR + dirCoeff * (0.6 + 0.4 * light)  // limb darkens slightly
          : ambR + dirCoeff * light * sunR;
        const litG = isSelfEmit
          ? ambG + dirCoeff * (0.6 + 0.4 * light)
          : ambG + dirCoeff * light * sunG;
        const litB = isSelfEmit
          ? ambB + dirCoeff * (0.6 + 0.4 * light)
          : ambB + dirCoeff * light * sunB;
        // Scalar 'lit' kept for any code that wants single-channel brightness
        const lit = (litR + litG + litB) / 3;

        cr *= litR;
        cg *= litG;
        cb *= litB;

        // Clouds (rocky planets only) — bilinear, with offset rotation
        if (cfg.kind !== 'gas' && cloudColor) {
          const cloudU = ((u + this.rotation * 0.02) % 1 + 1) % 1;
          const cfu = cloudU * TW - 0.5;
          let ci0 = Math.floor(cfu);
          const cfx = cfu - ci0;
          let ci1 = ci0 + 1;
          ci0 = ((ci0 % TW) + TW) % TW;
          ci1 = ((ci1 % TW) + TW) % TW;
          // Reuse j0/j1/fy from surface sampling for vertical
          const cv00 = cloudMap[j0 * TW + ci0];
          const cv10 = cloudMap[j0 * TW + ci1];
          const cv01 = cloudMap[j1 * TW + ci0];
          const cv11 = cloudMap[j1 * TW + ci1];
          const cw00 = (1 - cfx) * (1 - fy);
          const cw10 = cfx * (1 - fy);
          const cw01 = (1 - cfx) * fy;
          const cw11 = cfx * fy;
          const cv = cv00 * cw00 + cv10 * cw10 + cv01 * cw01 + cv11 * cw11;

          // Cloud SHADOW — sample the cloud map at a position offset along
          // the light direction. If a cloud "above" (between this surface
          // pixel and the sun) is opaque, the surface gets darkened.
          if (light > 0.05) {
            const SHADOW_OFS = 0.05;  // ~3% of planet radius — cloud-deck height proxy
            // Offset surface normal toward the light (view-space), then run
            // through the same tilt + rotation pipeline used for the surface
            // sample, so we land in the correct cloud-map frame.
            let snx = nx + lx * SHADOW_OFS;
            let sny = ny + ly * SHADOW_OFS;
            let snz = nz + lz * SHADOW_OFS;
            const sLen = Math.sqrt(snx*snx + sny*sny + snz*snz);
            snx /= sLen; sny /= sLen; snz /= sLen;
            // Apply tilt
            const stx = snx;
            const sty = sny * cosTilt - snz * sinTilt;
            const stz = sny * sinTilt + snz * cosTilt;
            // Apply Y-axis spin
            const swx = stx * cosT + stz * sinT;
            const swy = sty;
            const swz = -stx * sinT + stz * cosT;
            const sLon = Math.atan2(swz, swx);
            const sLat = Math.asin(clamp(swy, -1, 1));
            // Add the cloud-rotation offset (clouds rotate slightly faster
            // than ground via the +rotation*0.02 term in cloud sampling)
            let sU = (sLon / (Math.PI * 2)) + 0.5 + this.rotation * 0.02;
            sU = ((sU % 1) + 1) % 1;
            const sV = clamp((sLat / Math.PI) + 0.5, 0, 0.99999);
            // Bilinear sample
            const sFu = sU * TW - 0.5;
            const sFv = sV * TH - 0.5;
            let sci0 = Math.floor(sFu), scj0 = Math.floor(sFv);
            const stxx = sFu - sci0, styy = sFv - scj0;
            let sci1 = sci0 + 1;
            sci0 = ((sci0 % TW) + TW) % TW;
            sci1 = ((sci1 % TW) + TW) % TW;
            let scj1 = scj0 + 1;
            if (scj0 < 0) scj0 = 0; else if (scj0 > TH - 1) scj0 = TH - 1;
            if (scj1 < 0) scj1 = 0; else if (scj1 > TH - 1) scj1 = TH - 1;
            const shadowCv =
              cloudMap[scj0 * TW + sci0] * (1 - stxx) * (1 - styy) +
              cloudMap[scj0 * TW + sci1] * stxx       * (1 - styy) +
              cloudMap[scj1 * TW + sci0] * (1 - stxx) * styy       +
              cloudMap[scj1 * TW + sci1] * stxx       * styy;
            // Darken proportional to shadow density. (1 - cv) so a cloud
            // pixel doesn't shadow itself; light to fade shadows toward the
            // terminator/night side which are already dark from Lambert.
            const shadowStrength = shadowCv * 0.55 * (1 - cv) * light;
            if (shadowStrength > 0) {
              const sd = 1 - shadowStrength;
              cr *= sd;
              cg *= sd;
              cb *= sd;
            }
          }

          if (cv > 0.02) {
            // Cloud opacity IS the reference luminance — no boost so the
            // grey gradient renders as soft haze rather than getting clipped
            const a = cv > 1 ? 1 : cv;
            // Ash-tint blend (primordial only) — sample ashMap bilinearly
            // with the same cloud rotation offset, then mix the cream
            // cloudColor toward the dark ashCloudColor based on ash density.
            // This produces visible dark plumes drifting downwind of lava
            // provinces over otherwise-cream cloud cover.
            let ccR = cloudColor[0], ccG = cloudColor[1], ccB = cloudColor[2];
            if (ashMap) {
              const ash = ashMap[j0 * TW + ci0] * cw00
                        + ashMap[j0 * TW + ci1] * cw10
                        + ashMap[j1 * TW + ci0] * cw01
                        + ashMap[j1 * TW + ci1] * cw11;
              if (ash > 0.02) {
                const ashMix = ash > 1 ? 1 : ash;
                ccR = ccR * (1 - ashMix) + ashCloudColor[0] * ashMix;
                ccG = ccG * (1 - ashMix) + ashCloudColor[1] * ashMix;
                ccB = ccB * (1 - ashMix) + ashCloudColor[2] * ashMix;
              }
            }
            // Per-channel cloud lighting too
            cr = cr * (1 - a) + ccR * litR * a;
            cg = cg * (1 - a) + ccG * litG * a;
            cb = cb * (1 - a) + ccB * litB * a;
          }
        }

        // Atmospheric scattering — blend-based haze that matches the outer
        // halo's peak intensity at r2=1 for a continuous limb. Dense
        // atmospheres extend their haze inward across the visible disk so
        // the planet's face shows clear atmospheric color, not just a rim.
        if (atmThickness > 0) {
          // Limb concentration: 0 at planet center, 1 at the edge.
          // Lower exponent for thicker atmospheres = haze extends inward.
          const limbExp = atmThickness >= 0.30 ? 1.4
                        : atmThickness >= 0.18 ? 2.2
                        : atmThickness >= 0.08 ? 3.5
                        : 5.0;
          const limb = Math.pow(r2, limbExp);

          // Light-side bias matched to outer halo (+0.30, 0.5 + 0.7·side)
          // so inner and outer atmosphere brightness profiles connect
          // continuously at r2=1.
          const litBias = clamp(ndotl + 0.30, 0, 1);
          const sideMul = 0.5 + litBias * 0.7;

          // Rim haze — concentrated at the limb. Constants match outer
          // halo (atmThickness * 3.0) so brightness is continuous across
          // r2 = 1. Reduced from 5.5 after fixing the alpha² compositing
          // bug — the old value had been compensating for halo pixels
          // displaying at alpha² brightness, which made the saturated
          // plateau (haze=0.95) span a wide annulus near the limb.
          const rimHaze = limb * atmThickness * 3.0 * sideMul;

          // General lit-side haze for thicker atmospheres — washes the
          // whole daylit disk with atmospheric color so the planet
          // doesn't read as separate from its halo. Reduced multiplier
          // so dense atmospheres don't completely obscure cloud bands
          // away from the central disk.
          const generalHaze = atmThickness >= 0.10
            ? (atmThickness - 0.05) * 0.55 * Math.max(0, ndotl)
            : 0;

          // Total coverage as a blend factor (not additive). Dense
          // atmospheres can completely take over surface color near
          // the limb. Alpha scales with sun magnitude — dim suns produce
          // little atmospheric scattering, so haze becomes more
          // transparent rather than just dimmer in color.
          const haze = Math.min(0.95, rimHaze + generalHaze) * sunFalloff;
          // Atmospheric scattering is the gas's intrinsic color modulated
          // by incoming light wavelength — so atmCol times sun color.
          cr = cr * (1 - haze) + atmCol[0] * sunR * haze;
          cg = cg * (1 - haze) + atmCol[1] * sunG * haze;
          cb = cb * (1 - haze) + atmCol[2] * sunB * haze;
        }

        // Aurora — snaking curtain ribbons with altitude-based coloring.
        // Real auroras emit different colors at different altitudes:
        //   ~100km (low):  blue/violet  (molecular nitrogen)
        //   ~150km (mid):  green        (atomic O at 557 nm — palette default)
        //   ~250km (high): red/pink     (atomic O at 630 nm)
        // In our model, the equatorward edge of a curtain is the "bottom"
        // (lower altitude) and the poleward edge is the "top". Vertical
        // ray striations give the curtains internal detail rather than
        // smooth wash. ALL longitude multipliers MUST be integers so the
        // patterns wrap seamlessly at the ±π seam (sin(Nπ)=sin(-Nπ) only
        // when N is an integer; otherwise a visible seam appears).
        if (auroraEnabled) {
          const absLatN = wy < 0 ? -wy : wy;
          if (absLatN > 0.7) {
            const tt = this.rotation;
            const longitude = Math.atan2(wx, wz);

            // Two snaking ribbons at independent reference latitudes
            const c1Lat = 0.84
                        + Math.sin(longitude * 2 + tt * 0.4) * 0.045
                        + Math.sin(longitude * 4 - tt * 0.9) * 0.020;
            const c2Lat = 0.92
                        + Math.sin(longitude * 3 + tt * 0.6) * 0.030
                        + Math.sin(longitude * 6 - tt * 1.6) * 0.012;

            // Variable-width ribbons (organic thickness variation)
            const c1HW = 0.034 * (0.7 + 0.4 * Math.sin(longitude * 3 + tt * 0.8));
            const c2HW = 0.024 * (0.7 + 0.4 * Math.sin(longitude * 5 + tt * 1.4));

            // Signed offset within each ribbon (-1 = equatorward edge,
            // 0 = center, +1 = poleward edge). This is our altitude proxy.
            const off1 = (absLatN - c1Lat) / c1HW;
            const off2 = (absLatN - c2Lat) / c2HW;
            const a1 = off1 < 0 ? -off1 : off1;
            const a2 = off2 < 0 ? -off2 : off2;

            // Curtain strength with squared falloff (crisp ribbons)
            let curt1 = a1 < 1 ? (1 - a1) : 0;
            let curt2 = a2 < 1 ? (1 - a2) : 0;
            curt1 = curt1 * curt1;
            curt2 = curt2 * curt2;

            if (curt1 > 0.005 || curt2 > 0.005) {
              // Pick dominant ribbon at this pixel
              const useC2 = curt2 > curt1;
              const curtainStrength = useC2 ? curt2 : curt1;
              const sideOffset = useC2 ? off2 : off1;  // -1..+1 altitude proxy

              // Longitudinal activity gating — most sectors quiet
              const lon1 = Math.sin(longitude * 1 + tt * 0.2);
              const lon2 = Math.sin(longitude * 3 - tt * 0.9);
              const lon3 = Math.sin(longitude * 7 + tt * 1.8);
              const longRaw = lon1 + lon2 * 0.5 + lon3 * 0.25;
              const activity = longRaw > 0.05
                ? Math.min(1, (longRaw - 0.05) * 0.8)
                : 0;

              // Vertical ray striations — high-frequency longitudinal
              // wiggle, slightly skewed by sideOffset so rays "tilt"
              // through the curtain rather than running perfectly
              // perpendicular to its length. Two octaves for fine detail.
              const ray1 = Math.sin(longitude * 18 + tt * 3.0 + sideOffset * 4);
              const ray2 = Math.sin(longitude * 45 - tt * 5.5 + sideOffset * 2);
              const rayMod = 0.50 + 0.35 * ray1 + 0.15 * ray2;
              const rays = rayMod < 0.25 ? 0.25 : rayMod;

              const ribbon = curtainStrength * activity * rays;
              if (ribbon > 0.005) {
                // Limb fade — softens compressed away-pole projection
                const limbFade = dz > 0.30 ? 1 : (dz / 0.30) * (dz / 0.30);

                // Altitude-based coloring: blend palette aurora color
                // (mid altitude) with blue/violet at equatorward edge
                // and red/pink at poleward edge.
                let auR = auroraCol[0], auG = auroraCol[1], auB = auroraCol[2];
                if (sideOffset < 0) {
                  // equatorward edge → low altitude → blue/violet (N2)
                  const t = -sideOffset;
                  auR = auR * (1 - t) + 90  * t;
                  auG = auG * (1 - t) + 40  * t;
                  auB = auB * (1 - t) + 200 * t;
                } else {
                  // poleward edge → high altitude → red/pink (atomic O)
                  const t = sideOffset;
                  auR = auR * (1 - t) + 230 * t;
                  auG = auG * (1 - t) + 80  * t;
                  auB = auB * (1 - t) + 130 * t;
                }

                const nightBoost = 0.3 + (1 - light) * 1.8;
                const baseStr = (cfg.kind === 'gas') ? 0.95 : (atmThickness * 2.6);
                const aStr = ribbon * nightBoost * baseStr * limbFade;
                cr += auR * aStr;
                cg += auG * aStr;
                cb += auB * aStr;
              }
            }
          }
        }

        // Specular highlight on water (terrestrial / ocean only)
        // Uses pre-baked, blurred water-mask map -> stable under rotation
        if (cfg.kind === 'rocky' && (planet.type === 'terrestrial' || planet.type === 'ocean') && planet.waterMaskMap) {
          const wm = planet.waterMaskMap;
          const waterMask = wm[t00] * w00 + wm[t10] * w10 + wm[t01] * w01 + wm[t11] * w11;
          if (waterMask > 0.02) {
            const halfX = lx * 0.5;
            const halfY = ly * 0.5;
            const halfZ = (lz + 1) * 0.5;
            const hLen = Math.sqrt(halfX*halfX + halfY*halfY + halfZ*halfZ);
            const hx = halfX / hLen, hy = halfY / hLen, hz = halfZ / hLen;
            const ndoth = clamp(nx*hx + ny*hy + nz*hz, 0, 1);
            // Exponent 12 (vs 32 originally) — broader, gentler highlight that
            // doesn't intensity-pop under sub-pixel motion.
            const spec = Math.pow(ndoth, 12) * waterMask * 0.7;
            cr += spec * 190 * sunR;
            cg += spec * 215 * sunG;
            cb += spec * 240 * sunB;
          }
        }

        // Lava glow on volcanic (low areas glow) — also uses pre-baked mask
        if (planet.type === 'volcanic' && planet.waterMaskMap) {
          const wm = planet.waterMaskMap;
          const lavaMask = wm[t00] * w00 + wm[t10] * w10 + wm[t01] * w01 + wm[t11] * w11;
          if (lavaMask > 0.02) {
            const glow = (1 - light * 0.5) * lavaMask;
            cr += 200 * glow;
            cg += 60 * glow;
            cb += 10 * glow;
          }
        }

        data[idx4]     = clamp(cr, 0, 255);
        data[idx4 + 1] = clamp(cg, 0, 255);
        data[idx4 + 2] = clamp(cb, 0, 255);
        data[idx4 + 3] = 255;
      }
    }

    this.ctx.putImageData(this.imgData, 0, 0);
    this.frame++;
    this.lastFrameMs = performance.now() - t0;
  }
}

export { Renderer };
