// Planet — deterministic procedural body generator. Bakes equirectangular
// height / color / cloud / ice / water-mask textures at generation time.
//
// Standalone use: EARTH_MASK / CLOUD_REF are decoded asynchronously. Await
// decodeEarthMask() / decodeCloudRef() (js/data/*) before constructing a
// Planet if you need earthMode continents or Blue-Marble-style clouds;
// otherwise the bake silently falls back to fully procedural output.

import { hashString, mulberry32 } from './core/prng.js';
import { Perlin3D, Worley3D } from './core/noise.js';
import { clamp, smoothstep, mix, mixRgb } from './core/color.js';
import { erodeMultiRes } from './erosion.js';
import { PALETTES } from './data/palettes.js';
import { pickPalette } from './data/variants.js';
import { EARTH_MASK, EARTH_MASK_W } from './data/earth-mask.js';
import { CLOUD_REF, sampleCloudRef } from './data/cloud-ref.js';

// ---------- PLANET ----------
class Planet {
  constructor(config) {
    this.config = config;
    const seedNum = (typeof config.seed === 'string')
      ? hashString(config.seed)
      : (config.seed >>> 0);
    this.seedNum = seedNum;
    this.rng = mulberry32(seedNum);
    this.perlin = new Perlin3D(this.rng);
    this.perlin2 = new Perlin3D(this.rng);
    this.perlin3 = new Perlin3D(this.rng);
    this.worley = new Worley3D(seedNum ^ 0xA5A5A5A5);

    // Earth mode — biases heightmap with the real water mask
    this.earthMode = !!config.earthMode;

    // resolve type/atmosphere
    this.size = config.size; // 0..1
    this.type = this.earthMode ? 'terrestrial'
              : (config.type === 'auto') ? this.pickType() : config.type;
    this.atmosphere = this.earthMode ? 'thick'
              : (config.atmosphere === 'auto') ? this.pickAtmosphere() : config.atmosphere;

    // Force-variant override — used by the easter-egg seed system to lock
    // specific named worlds to their intended palette (e.g. seed VULCAN
    // forces variant 'Vulcan' on a desert body). Null for normal generation.
    this.forceVariant = config.forceVariant || null;

    // pick a palette variant for this seed (e.g. tropical / violet / autumnal terrestrial)
    this.palette = this.earthMode
      ? Object.assign({}, PALETTES.terrestrial, { _variantName: 'Earth' })
      : pickPalette(this.type, this.rng, this.forceVariant);
    this.variantName = this.palette._variantName;

    // axial tilt for visual interest
    this.axialTilt = (this.rng() - 0.5) * 0.7;
    // rotation start
    this.rotation = this.rng() * Math.PI * 2;

    this.attributes = this.computeAttributes();

    // texture maps (equirectangular, 2:1). Resolution is a generation parameter
    // (MAP RES): 768 default, up to 2048. Higher = crisper terrain/coasts/rivers
    // and sharper exports, at more bake time + memory. Same seed at the SAME
    // resolution is bit-identical; a different resolution is a different sampling
    // grid, so it's a distinct (but still deterministic) world.
    const mapW = Math.max(384, Math.min(2048, (config.mapRes | 0) || 768));
    this.texW = mapW;
    this.texH = mapW >> 1;
    const N = this.texW * this.texH;
    this.heightMap = new Float32Array(N);
    this.moistureMap = new Float32Array(N);  // biome moisture — read by the GL terraform shader
    this.colorMap  = new Uint8ClampedArray(N * 3);
    this.cloudMap  = new Float32Array(N);
    this.iceMap    = new Float32Array(N);   // per-pixel polar ice coverage 0..1
    this.shapeMap  = null;                   // precomputed shape factor for non-spherical bodies
    this.maxShapeR = 1;                      // outer bound for silhouette test
    // Primordial planets only: parallel cloud-tint map. 0 = normal cream
    // cloud, 1 = dark ash plume (volcanic particulate). Allocated lazily
    // since most planet types don't need it.
    this.ashMap = (this.type === 'primordial') ? new Float32Array(N) : null;

    this.generateTextures();
    this.generateShapeMap();
  }

  // Precompute shape factor as a 2D equirectangular map (texW × texH). Done
  // once at generation time so the renderer's silhouette test is a simple
  // O(1) lookup — no iteration, no convergence, no per-frame instability.
  // Only populated for non-spherical body types (asteroid, dwarf_planet
  // with oblation). For spherical bodies, shapeMap stays null and the
  // renderer falls back to the standard r²>1 sphere check.
  generateShapeMap() {
    const cfg = this.getTypeConfig();
    const shapeIrregular = cfg.shapeIrregular || 0;
    const oblateY = cfg.shapeOblateY || 1;
    if (shapeIrregular === 0 && oblateY === 1) {
      this.shapeMap = null;
      this.maxShapeR = 1;
      return;
    }
    const W = this.texW, H = this.texH;
    const map = new Float32Array(W * H);
    let maxR = 0;
    for (let j = 0; j < H; j++) {
      const lat = ((j + 0.5) / H) * Math.PI - Math.PI / 2;
      const sinLat = Math.sin(lat);
      const cosLat = Math.cos(lat);
      for (let i = 0; i < W; i++) {
        const lon = ((i + 0.5) / W) * 2 * Math.PI;
        const x = cosLat * Math.cos(lon);
        const y = sinLat;
        const z = cosLat * Math.sin(lon);
        // Smooth low-frequency Perlin — features at ~0.5-1.0 scale on the
        // unit sphere. Single octave for absolute smoothness.
        let r = 1.0;
        if (shapeIrregular > 0) {
          const sn = this.perlin.fbm(x*1.0, y*1.0, z*1.0, 2);
          r = 1.0 + sn * shapeIrregular;
        }
        // Y-axis ellipsoid factor — analytical, exact
        if (oblateY !== 1) {
          const ay = 1 / (oblateY * oblateY);
          const denom = Math.sqrt(x*x + ay*y*y + z*z);
          if (denom > 0.0001) r /= denom;
        }
        map[j * W + i] = r;
        if (r > maxR) maxR = r;
      }
    }
    this.shapeMap = map;
    this.maxShapeR = maxR;
  }

  pickType() {
    const r = this.rng();
    const s = this.size;
    if (s > 0.92) {
      // Largest tier: brown dwarfs, gas giants
      if (r < 0.30) return 'brown_dwarf';
      if (r < 0.75) return 'gas_giant';
      return 'ice_giant';
    }
    if (s > 0.78) {
      if (r < 0.55) return 'gas_giant';
      if (r < 0.85) return 'ice_giant';
      return 'ocean';
    }
    if (s < 0.10) {
      // Smallest: asteroids dominate
      if (r < 0.65) return 'asteroid';
      return 'dwarf_planet';
    }
    if (s < 0.22) {
      if (r < 0.30) return 'cratered';
      if (r < 0.55) return 'dwarf_planet';
      if (r < 0.75) return 'ice';
      return 'desert';
    }
    const types = ['terrestrial','desert','ice','volcanic','cratered','ocean','primordial','terrestrial','terrestrial'];
    return types[Math.floor(r * types.length)];
  }

  pickAtmosphere() {
    if (this.type === 'gas_giant' || this.type === 'ice_giant' || this.type === 'brown_dwarf') return 'dense';
    if (this.type === 'cratered' || this.type === 'asteroid') return 'none';
    if (this.type === 'dwarf_planet') return this.rng() < 0.03 ? 'thin' : 'none';
    if (this.type === 'volcanic') return this.rng() < 0.5 ? 'thick' : 'thin';
    if (this.type === 'primordial') return this.rng() < 0.30 ? 'thin' : 'thick'; // Earth-like haze; no dense (visually too large)
    if (this.type === 'ocean')    return 'thick';
    if (this.type === 'ice')      return this.rng() < 0.6 ? 'thin' : 'thick';
    const r = this.rng();
    if (r < 0.15) return 'none';
    if (r < 0.45) return 'thin';
    if (r < 0.85) return 'thick';
    return 'dense';
  }

  // ----- rendering config per type -----
  // CRITICAL: this method generates config values from the planet's RNG.
  // Each call advances rng state, so calling it multiple times produces
  // DIFFERENT cfg values (different seaLevel, cloudDensity, iceLine, etc).
  // The renderer calls this every frame, which previously caused the planet's
  // surface to pulsate as detail-noise thresholds, cloud density, and other
  // cfg values silently jittered between frames. Memoize the first result so
  // every later call returns the same object — surface stays stable.
  getTypeConfig() {
    if (this._cfg) return this._cfg;
    const t = this.type;
    if (t === 'gas_giant' || t === 'ice_giant' || t === 'brown_dwarf') {
      const cfg = {
        kind: 'gas',
        bandFreq: 5 + this.rng() * 8,
        turbulence: 0.18 + this.rng() * 0.12,
        stormChance: t === 'gas_giant' ? 0.6 : 0.25,
      };
      if (t === 'brown_dwarf') {
        // Brown dwarfs have much sharper, narrower bands and high turbulence
        // (the dark cloud layers are more chaotic). The hot interior glow is
        // handled separately in the gas-texture pass via palette.glow.
        cfg.bandFreq = 8 + this.rng() * 10;
        cfg.turbulence = 0.30 + this.rng() * 0.20;
        cfg.stormChance = 0.4;
        cfg.selfEmit = true;  // hot interior glows even on the night side
      }
      this._cfg = cfg;
      return cfg;
    }
    const cfg = {
      kind: 'rocky',
      noiseScale: 1.6 + this.rng() * 1.8,
      mountainAmount: 0,
      ridgeAmount: 0,
      exponent: 1.0,
      seaLevel: -0.05,
      craterDensity: 0,
      iceLine: 0.62,
      cloudDensity: 0.3,
      moistureScale: 1.4,
      polarBleach: 0.5,
    };
    if (t === 'terrestrial') {
      cfg.seaLevel    = -0.05 + (this.rng() - 0.5) * 0.18;
      cfg.mountainAmount = 0.25;
      cfg.ridgeAmount = 0.18;
      cfg.exponent    = 1.0;
      cfg.cloudDensity = 0.35 + this.rng() * 0.35;
      cfg.iceLine     = 0.58 + this.rng() * 0.15;
      // Earth-specific overrides — fixed values for consistent rendering
      if (this.earthMode) {
        cfg.seaLevel     = 0.0;     // fixed reference so bias arithmetic is stable
        cfg.mountainAmount = 0.30;  // bit more relief on continents
        cfg.ridgeAmount  = 0.20;
        cfg.cloudDensity = 0.45;    // earthly cloud cover
        cfg.iceLine      = 0.80;    // ice past Antarctica/Arctic latitudes
      }
    } else if (t === 'ocean') {
      cfg.seaLevel    = 0.18 + this.rng() * 0.15;  // very high water
      cfg.mountainAmount = 0.18;
      cfg.cloudDensity = 0.55;
      cfg.iceLine     = 0.65;
    } else if (t === 'primordial') {
      // Young Earth: continents ~30%, dense ash-tinted clouds, moderate
      // bombardment legacy, and a low-frequency "magma province" map that
      // marks where flood basalts and active lava lakes live. Vegetation
      // is suppressed and only survives between flows.
      cfg.seaLevel    = -0.02 + (this.rng() - 0.5) * 0.12;
      cfg.mountainAmount = 0.30;
      cfg.ridgeAmount = 0.20;
      cfg.exponent    = 1.05;
      cfg.cloudDensity = 0.55 + this.rng() * 0.20;  // dense ash-haze
      cfg.iceLine     = 0.85 + this.rng() * 0.10;   // hot — ice rare
      cfg.craterDensity = 0.30 + this.rng() * 0.30; // late-bombardment scars
      cfg.polarBleach = 0.2;                         // poles barely cool
      // Magma-province controls — fraction of the surface dominated by
      // active flood basalts. Higher value = more lava, less vegetation.
      cfg.magmaCoverage = 0.25 + this.rng() * 0.30;  // 25-55% of land
      cfg.magmaScale    = 0.9 + this.rng() * 0.7;    // few large provinces
    } else if (t === 'desert') {
      cfg.seaLevel    = -10;  // no water
      cfg.ridgeAmount = 0.30;
      cfg.mountainAmount = 0.20;
      cfg.exponent    = 1.2;
      cfg.cloudDensity = 0.05 + this.rng() * 0.1;
      cfg.iceLine     = 0.85;
      cfg.craterDensity = this.rng() < 0.4 ? 0.3 : 0;
    } else if (t === 'ice') {
      cfg.seaLevel    = -10;
      cfg.mountainAmount = 0.15;
      cfg.ridgeAmount = 0.25;
      cfg.cloudDensity = 0.2;
      cfg.iceLine     = -2;  // entire surface
      cfg.craterDensity = this.rng() < 0.5 ? 0.2 : 0;
    } else if (t === 'volcanic') {
      cfg.seaLevel    = -0.15 + this.rng() * 0.15;  // lava seas
      cfg.mountainAmount = 0.35;
      cfg.ridgeAmount = 0.30;
      cfg.exponent    = 1.4;
      cfg.cloudDensity = 0.45;  // ash clouds
      cfg.iceLine     = 5;  // none
    } else if (t === 'cratered') {
      cfg.seaLevel    = -10;
      cfg.mountainAmount = 0.1;
      cfg.ridgeAmount = 0.1;
      cfg.cloudDensity = 0;
      cfg.craterDensity = 0.8 + this.rng() * 0.4;
      cfg.iceLine     = 0.78;
      cfg.polarBleach = 0.3;
    } else if (t === 'dwarf_planet') {
      // Mostly round body, heavy cratering, often partial ice cover.
      // Slight ellipsoid stretch for some seeds (Haumea-like rotational
      // flattening). Carries more variety than 'cratered' in palette.
      cfg.seaLevel    = -10;
      cfg.mountainAmount = 0.18;
      cfg.ridgeAmount = 0.12;
      cfg.cloudDensity = 0;
      cfg.craterDensity = 0.5 + this.rng() * 0.5;
      cfg.iceLine     = 0.55 + this.rng() * 0.30;  // varies — some are ice-capped, some bare
      cfg.polarBleach = 0.5;
      // Shape oblation — most are round (factor 1), but some are
      // rotationally flattened (Haumea-like). Only deform along Y so the
      // silhouette doesn't shift through rotation.
      cfg.shapeOblateY = (this.rng() < 0.20) ? 0.78 + this.rng() * 0.10 : 1.0;
      cfg.shapeOblateX = 1.0;
    } else if (t === 'asteroid') {
      // Irregular rocky/metallic body, no atmosphere, very heavy cratering,
      // strongly non-spherical silhouette. Rendered with low-frequency
      // shape deformation in the renderer.
      cfg.seaLevel    = -10;
      cfg.mountainAmount = 0.30;  // large lumpy variation
      cfg.ridgeAmount = 0.20;
      cfg.exponent    = 1.3;
      cfg.cloudDensity = 0;
      cfg.craterDensity = 1.0 + this.rng() * 0.6;
      cfg.iceLine     = 5;  // no ice caps
      cfg.polarBleach = 0;
      // Strong silhouette deformation — noise-driven radius scaling.
      // Only deform along Y axis (vertical in screen space). Deforming along
      // X/Z would cycle through "visible squash" and "hidden squash" as the
      // planet rotates around Y, making the silhouette aspect ratio change
      // dramatically (looks like the asteroid is morphing rather than
      // rotating). With Y-only oblation, the vertical squash is constant
      // regardless of rotation angle.
      cfg.shapeIrregular = 0.16 + this.rng() * 0.08;  // 0.16..0.24 — subtle bumps
      cfg.shapeOblateY = 0.85 + this.rng() * 0.10;    // 0.85..0.95 — slight squash
      cfg.shapeOblateX = 1.0;                          // no rotation-plane deformation
    }
    this._cfg = cfg;
    return cfg;
  }

  // Generate craters as positions on unit sphere
  generateCraters(density) {
    const craters = [];
    if (density <= 0) return craters;
    // count scales with density
    const count = Math.floor(40 + density * 320);
    for (let i = 0; i < count; i++) {
      const u = this.rng() * 2 - 1;
      const t = this.rng() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      const x = r * Math.cos(t);
      const y = u;
      const z = r * Math.sin(t);
      // Crater radius (angular). Power distribution -> mostly small with rare large
      const sizeRoll = this.rng();
      const radius = 0.005 + Math.pow(sizeRoll, 4) * 0.18;
      const depth = 0.04 + radius * 0.6;
      craters.push({ x, y, z, r: radius, d: depth });
    }
    return craters;
  }

  applyCraters(x, y, z, craters) {
    let h = 0;
    for (let i = 0; i < craters.length; i++) {
      const c = craters[i];
      const dot = x * c.x + y * c.y + z * c.z;
      // fast bailout
      if (dot < Math.cos(c.r * 1.3)) continue;
      const ang = Math.acos(clamp(dot, -1, 1));
      const t = ang / c.r;
      if (t < 0.85) {
        // bowl
        h -= c.d * Math.cos(t * Math.PI / 1.7);
      } else if (t < 1.25) {
        // raised rim
        const rim = (t - 0.85) / 0.4;
        h += c.d * 0.45 * Math.sin(rim * Math.PI);
      }
    }
    return h;
  }

  generateTextures() {
    const cfg = this.getTypeConfig();
    const W = this.texW, H = this.texH;
    const heightMap = this.heightMap;
    const colorMap = this.colorMap;
    const cloudMap = this.cloudMap;
    this.iceMap.fill(0);  // reset polar coverage from any prior generation

    const craters = (cfg.kind === 'rocky') ? this.generateCraters(cfg.craterDensity) : [];

    // Storm spots for gas giants
    let storms = [];
    if (cfg.kind === 'gas') {
      const stormCount = Math.floor(2 + this.rng() * 5);
      for (let i = 0; i < stormCount; i++) {
        if (this.rng() > cfg.stormChance) continue;
        storms.push({
          lat: (this.rng() - 0.5) * 1.4,
          lon: this.rng() * Math.PI * 2,
          rLat: 0.05 + this.rng() * 0.08,
          rLon: 0.05 + this.rng() * 0.18,
          intensity: 0.3 + this.rng() * 0.5,
        });
      }
    }

    // Random offset to vary noise per seed
    const nOffX = this.rng() * 100;
    const nOffY = this.rng() * 100;
    const nOffZ = this.rng() * 100;
    this._nOffX = nOffX; this._nOffY = nOffY; this._nOffZ = nOffZ;
    // Stash on planet so the renderer can use them for resolution-independent
    // surface detail noise (sub-texel grit). Without this, every render-time
    // detail call would produce the same pattern regardless of seed.
    this.detailOffsets = [nOffX * 0.13, nOffY * 0.27, nOffZ * 0.41];

    if (cfg.kind === 'gas') {
      this.generateGasTexture(cfg, storms, nOffX, nOffY, nOffZ);
      this.softenColorMap();
      this.waterMaskMap = null;
      return;
    }

    const pal = this.palette;
    // First: compute heightmap (for blur/bump)
    for (let j = 0; j < H; j++) {
      const lat = ((j + 0.5) / H) * Math.PI - Math.PI / 2;
      const cosLat = Math.cos(lat);
      const sinLat = Math.sin(lat);
      for (let i = 0; i < W; i++) {
        const lon = ((i + 0.5) / W) * 2 * Math.PI;
        const x = cosLat * Math.cos(lon);
        const y = sinLat;
        const z = cosLat * Math.sin(lon);

        const s = cfg.noiseScale;
        // Base power-fractal terrain
        let h = this.perlin.fbm(x*s + nOffX, y*s + nOffY, z*s + nOffZ, 7);
        // Power fractal flavor
        h = Math.sign(h) * Math.pow(Math.abs(h), cfg.exponent);

        // ---- Multi-scale mountains ----
        // SMALL-scale, rough ridged noise CONFINED to high ground and BROKEN
        // into discrete orogenic belts — so mountains read as scattered ranges
        // on the uplands with plains between, instead of one continent-sized
        // mountainous field. (The old layer added a single LOW-frequency
        // ridge/Worley field masked by ×0.5 noise, which blanketed whole
        // continents in "mountain".)
        if (cfg.mountainAmount > 0) {
          // 1) altitude gate — ranges only grow on already-elevated terrain,
          //    so coasts and lowlands stay smooth (the base fBm keeps continents)
          const altMask = smoothstep(0.05, 0.30, h);
          // 2) belt gate — mid-frequency + thresholded so mountains cluster into
          //    discrete belts with lowland gaps (much higher freq than old ×0.5)
          const beltMask = smoothstep(-0.05, 0.42, this.perlin2.fbm(x*1.7 + 50, y*1.7 + 50, z*1.7 + 50, 4));
          // 3) rough ridges at a SMALL scale (high freq → many small peaks) plus
          //    a finer craggy octave for internal roughness within each range
          const ridge = this.perlin.ridged(x*s*3.4 + nOffX*0.5, y*s*3.4 + nOffY*0.5, z*s*3.4 + nOffZ*0.5, 6);
          const crag  = this.perlin3.ridged(x*s*7.0 + nOffZ, y*s*7.0 + nOffX, z*s*7.0 + nOffY, 4);
          const mtn = ridge * 0.72 + crag * 0.28;                 // 0..1, ~1 on ridge crests
          // subtract a baseline so inter-ridge saddles sit lower (peaks+valleys,
          // i.e. broken up) rather than lifting the whole upland into a plateau
          h += (mtn - 0.28) * altMask * beltMask * cfg.mountainAmount * 2.2;
        }
        // Fine ridged texture — subtle craggy detail on the uplands, gated so it
        // never smothers lowlands into a uniform rough field.
        if (cfg.ridgeAmount > 0) {
          const r = this.perlin.ridged(x*s*2.4 + nOffX*0.5, y*s*2.4 + nOffY*0.5, z*s*2.4 + nOffZ*0.5, 5);
          const gate = smoothstep(0.0, 0.5, this.perlin2.fbm(x*1.4 + 20, y*1.4 + 20, z*1.4 + 20, 3))
                     * smoothstep(0.02, 0.25, h);
          h += (r - 0.35) * cfg.ridgeAmount * gate * 0.7;
        }

        // Craters
        if (craters.length > 0) {
          h += this.applyCraters(x, y, z, craters);
        }

        // Earth-mode bias — push h above/below seaLevel based on the
        // real water mask while preserving Perlin detail for coastline
        // shape, mountain ranges, and seafloor variation.
        if (this.earthMode && EARTH_MASK) {
          // Texture coords (i,j) align 1:1 with mask coords since both are
          // equirectangular at 768x384. We mirror i because the renderer's
          // longitude convention runs the opposite direction from the source
          // PNG (otherwise N. America ends up where Asia should be).
          const flipI = (EARTH_MASK_W - 1 - i);
          const isLand = EARTH_MASK[j * EARTH_MASK_W + flipI];
          const baseAbove = 0.14;  // mean elevation above seaLevel for land
          const baseBelow = 0.20;  // mean depth below seaLevel for ocean
          // Land relief was compressed (0.45) -> flat mountains. Give land a
          // wider elevation range so ranges/valleys read in relief; keep the
          // ocean floor gentler.
          const landScale = 1.05, oceanScale = 0.5;
          if (isLand) {
            const detail = h * landScale + baseAbove;
            // EARTH continents must never flood: deep Perlin troughs / mountain
            // -valley subtraction can drive detail below 0, which would punch
            // ocean holes into the landmasses. Floor it to a thin coastal band
            // so the real continents stay intact while keeping upland relief.
            h = cfg.seaLevel + Math.max(detail, 0.012);
          } else {
            const detail = h * oceanScale - baseBelow;
            h = cfg.seaLevel + detail;
          }
        }

        heightMap[j * W + i] = h;

        // Moisture (independent low-freq) — warped by heightmap so biome
        // boundaries hug the terrain. Without warp, moisture noise floated
        // independently of mountains/valleys, producing forests cut weirdly
        // across ridge lines. With warp, wet zones cluster predictably with
        // elevation features (rain shadows, orographic uplift, etc).
        const hWarpM = (h - cfg.seaLevel) * 1.6;
        const m = clamp(this.perlin2.fbm(
          x*cfg.moistureScale + nOffZ + hWarpM * 0.5,
          y*cfg.moistureScale + nOffX + hWarpM * 0.3,
          z*cfg.moistureScale + nOffY + hWarpM * 0.5,
          4) * 1.4 + 0.5, 0, 1);
        this.moistureMap[j * W + i] = m;
        // Clouds — base pattern from embedded reference (NASA Blue Marble
        // cloud mosaic) for realistic cyclones / ITCZ band / mid-latitude
        // westerlies, perturbed per-planet by seam-safe domain warp and a
        // unique high-freq noise injection so every world has unique-but-
        // Earth-like cloud structure. If the reference isn't loaded yet,
        // fall back to the original pure-Perlin cloud field.
        let cloud;
        if (CLOUD_REF) {
          // Equirectangular UV — same projection as the texture maps.
          // Compute u from atan2(z,x) so it wraps continuously across the
          // U=0/U=1 seam (avoids the visible meridian line a naive `i/W`
          // lookup would produce after warping).
          const lon = Math.atan2(z, x);  // -PI..PI
          // Mirror longitude so the reference cloud features align with the
          // same orientation as the earth water mask (and the renderer's UV
          // convention). Without this, Pacific cyclones would appear over
          // the Atlantic on Earth.
          const baseU = 1.0 - ((lon / (2 * Math.PI)) + 0.5);
          const baseV = (lat + Math.PI / 2) / Math.PI;

          // Domain warp — sample 3D Perlin in the unit-sphere coords so the
          // warp itself is seamless. This stretches/twists the reference
          // pattern uniquely per seed without ever crossing the U-seam.
          // Two octaves of warp at different scales for organic distortion.
          const w1u = this.perlin3.fbm(x*1.4 + nOffX*0.7, y*1.4, z*1.4 + nOffZ*0.5, 3);
          const w1v = this.perlin3.fbm(x*1.4 + 7.3, y*1.4 + 4.1, z*1.4 + 2.7, 3);
          const w2u = this.perlin3.fbm(x*3.5 + nOffY*0.4, y*3.5, z*3.5 + nOffX*0.3, 2);
          const w2v = this.perlin3.fbm(x*3.5 + 1.1, y*3.5 + 9.6, z*3.5 + 5.5, 2);
          // Warp magnitude — small in earth mode so we keep the recognizable
          // satellite cloud pattern; moderate for procedural worlds so each
          // seed produces unique structure without over-distorting cyclone
          // shapes into unrecognizable smears.
          const wU = this.earthMode ? 0.025 : 0.05;
          const wV = this.earthMode ? 0.010 : 0.02;
          const wU2 = this.earthMode ? 0.010 : 0.02;
          const wV2 = this.earthMode ? 0.005 : 0.01;
          const u = baseU + w1u * wU + w2u * wU2;
          const v = clamp(baseV + w1v * wV + w2v * wV2, 0, 1);

          // Sample the reference at warped coordinates
          let cRef = sampleCloudRef(u, v);

          // Per-planet high-freq detail — small modulation that preserves
          // the reference's grey gradient. Centered at zero so it adds
          // texture without lifting/dropping the whole field.
          const detail = this.perlin3.fbm(x*8 + nOffZ*1.7, y*8 + nOffX*1.3, z*8 + nOffY*0.9, 4);
          // Detail modulates LOCALLY proportional to existing cloud — adds
          // wisps inside cloudy regions, leaves clear regions clear.
          cRef = cRef + detail * 0.08 * cRef;
          if (cRef < 0) cRef = 0; else if (cRef > 1) cRef = 1;

          // Intensity remap — translate raw luminance to cloud opacity.
          // The reference has 29% of pixels below luminance 0.20 representing
          // CLEAR SKY (not thin haze). A linear mapping gave uniform faint
          // haze everywhere; we want a curve that:
          //   - Drops the dark tail (< ~0.18) to zero (clear sky reads clear)
          //   - Has a soft knee through mid-greys (thin cloud reads as thin)
          //   - Reaches full opacity for bright cloud cores (~0.85+)
          // Smoothstep with a low floor + gamma > 1 on the result gives this.
          const FLOOR = 0.18, KNEE = 0.55;
          let opacity;
          if (cRef <= FLOOR) {
            opacity = 0;
          } else if (cRef >= KNEE) {
            // From knee to 1.0, ramp toward full opacity
            const t = (cRef - KNEE) / (1 - KNEE);
            opacity = 0.55 + 0.45 * (t * t * (3 - 2 * t));
          } else {
            // Floor → knee: smooth ramp from 0 to 55% opacity
            const t = (cRef - FLOOR) / (KNEE - FLOOR);
            opacity = 0.55 * (t * t * (3 - 2 * t));
          }

          // Density control — multiplicative on the remapped opacity
          cloud = opacity * cfg.cloudDensity;
          if (cloud > 1) cloud = 1;
        } else {
          // Fallback: pure-Perlin cloud field (original behavior)
          const c0 = this.perlin3.fbm(x*3.5+nOffY, y*3.5+nOffZ, z*3.5+nOffX, 5);
          cloud = clamp((c0 + 0.5) * cfg.cloudDensity * 1.5 - (1 - cfg.cloudDensity) * 0.2, 0, 1);
        }
        // Primordial planets: secondary "ash cloud" layer concentrated over
        // active magma provinces. Where the magma map is high, boost cloud
        // opacity (volcanism feeds atmospheric particulates) and write into
        // ashMap so the renderer can tint those clouds dark/brown instead of
        // the default cream. Outside provinces, ash is 0 and clouds render
        // normally.
        if (this.type === 'primordial' && this.ashMap) {
          const mScale = cfg.magmaScale || 1.0;
          const magmaRaw = this.perlin2.fbm(x * mScale + 200, y * mScale + 200, z * mScale + 200, 4);
          const magmaThr = 0.5 - (cfg.magmaCoverage || 0.3) * 0.6;
          const magma = clamp((magmaRaw - magmaThr) * 5, 0, 1);
          // Spread ash slightly beyond the lava itself with a softer falloff,
          // simulating downwind plumes and high-altitude carry.
          const ashSpread = clamp((magmaRaw - magmaThr + 0.18) * 3, 0, 1);
          this.ashMap[j * W + i] = ashSpread;
          // Cloud thickening over active provinces
          if (magma > 0.05) {
            cloud = clamp(cloud + magma * 0.45, 0, 1);
          }
        }
        cloudMap[j * W + i] = cloud;

      }
    }

    // Hydraulic + thermal erosion — runs BEFORE coloring so the baked colors,
    // relief, water mask, and river flow map all describe the SAME carved
    // terrain. Deterministic per seed; droplet count follows the quality tier.
    const waterType = this.type === 'terrestrial' || this.type === 'ocean' || this.type === 'primordial';
    // Volcanic and ice worlds ALSO erode — lava carves channels (rivers of
    // lava!), glaciers carve valleys — just gentler by default than a wet world.
    const eroType = waterType || this.type === 'volcanic' || this.type === 'ice';
    this.baseHeightMap = null;
    if (cfg.kind === 'rocky' && eroType) {
      this.baseHeightMap = new Float32Array(this.heightMap);   // clean base for the live EROSION slider
      // pristine seed moisture so EVOLVE is reversible: bakeMoisture() overwrites
      // this.moistureMap for evolved coastlines; dialing EVOLVE back to 0 restores
      // the generated biome layout from this backup (see reTerrain).
      if (this.moistureMap) this.baseMoistureMap = new Float32Array(this.moistureMap);
      const eroOpts = {
        seed: this.seedNum,
        seaLevel: cfg.seaLevel,
        // FIXED droplet count (not the live/auto quality tier) so a seed
        // erodes to identical terrain on every machine — "same seed = same
        // world" must not depend on hardware or on when auto-detect stepped.
        // Scale with pixel count so erosion DENSITY is constant across MAP RES
        // (768² → 50k; higher res gets proportionally more droplets).
        droplets: Math.round(50000 * (W * H) / (768 * 384)),
        // Coarse→fine pyramid: broad continental drainage + crisp fluvial cuts.
        // Default DETAIL (0.5) is fixed here so the initial generate stays
        // deterministic; the DETAIL slider drives it live via reTerrain().
        detail: 0.5,
      };
      // Water worlds keep the original (unscaled) carve — untouched for
      // determinism. Volcanic/ice get a lighter default so the channels read
      // as lava/glacial cuts rather than a full hydraulic drainage basin.
      // Persist the per-type base scale so the live EROSION slider's neutral
      // 1.0× reproduces THIS generated carve (see reTerrain) — otherwise the
      // first terraform edit / RESET would re-carve volcanic/ice deeper.
      this._eroBaseScale = waterType ? 1 : (this.type === 'volcanic' ? 0.8 : 0.5);
      if (!waterType) eroOpts.erosionScale = this._eroBaseScale;
      const { height, flow } = erodeMultiRes(this.heightMap, W, H, eroOpts);
      this.heightMap = height;
      this.flowMap = flow;
    } else {
      this.flowMap = null;
    }

    // colour the surface from the (eroded) maps (extracted so live EROSION
    // can re-colour without a full regenerate)
    this.bakeSurfaceColors(cfg, pal);
    this._cfg = cfg;
    this._displacement = 1.0;

    // Apply soft bump-shading from heightMap (height differential -> normal)
    this.applyBumpShading(cfg, 1.0);
    // Mild blur on color map to smooth high-frequency content under sample rate
    this.softenColorMap();
    // Pre-bake a heavily smoothed water mask for stable specular under rotation
    this.bakeWaterMask(cfg);
  }

  // Colour the surface from the (eroded) height + moisture maps. Reads
  // this.heightMap / this.moistureMap; writes this.colorMap + rawColorMap.
  bakeSurfaceColors(cfg, pal) {
    const W = this.texW, H = this.texH;
    const heightMap = this.heightMap;
    const colorMap = this.colorMap;
    for (let j = 0; j < H; j++) {
      const lat = ((j + 0.5) / H) * Math.PI - Math.PI / 2;
      const cosLat = Math.cos(lat);
      const sinLat = Math.sin(lat);
      for (let i = 0; i < W; i++) {
        const lon = ((i + 0.5) / W) * 2 * Math.PI;
        const x = cosLat * Math.cos(lon);
        const y = sinLat;
        const z = cosLat * Math.sin(lon);
        const h = heightMap[j * W + i];
        const m = this.moistureMap[j * W + i];

        // Local terrain slope (2-texel central diff, longitude cos-lat
        // corrected) — lets the snowcap shed off steep faces so ranges read as
        // 3D relief, matching the GL shader's live classifyRocky path.
        const im = (i - 1 + W) % W, ip = (i + 1) % W;
        const jm = j > 0 ? j - 1 : 0, jp = j < H - 1 ? j + 1 : H - 1;
        const sx = heightMap[j * W + ip] - heightMap[j * W + im];
        const sy = heightMap[jp * W + i] - heightMap[jm * W + i];
        // correctly-rounded sqrt only (NOT Math.hypot — that's an
        // implementation-approximated function and would break the
        // bit-identical-bake determinism contract across JS engines)
        const gx = sx * Math.max(0.05, cosLat);
        const slope = Math.sqrt(gx * gx + sy * sy);

        // Color
        let [r, g, b] = this.colorPixelRocky(h, m, lat, cfg, pal, x, y, z, slope);

        // Polar ice sheet overlay — applied AFTER biome coloring. Uses a
        // HARD-threshold boundary with multi-scale noise + Worley cells so
        // the edge breaks into discrete icebergs/floes rather than fading
        // smoothly. Inside the cap, crevasses and pressure ridges add
        // texture so it doesn't read as flat paint.
        if (pal.polarIce && (this.type === 'terrestrial' || this.type === 'ocean')) {
          const absLatLocal = Math.abs(lat) / (Math.PI / 2);
          // Multi-scale latitude displacement — large embayments + medium
          // tongues + fine fractures. Sum of three scales gives complex
          // edges at every viewing scale.
          // Multi-scale edge displacement (large lobes → fine crenellation), all
          // scales always applied so the boundary is ragged at every zoom — mirrors
          // the GL shader's polar `e`. Deterministic (perlin add/mul only).
          const e1 = this.perlin2.fbm(x*1.5+21, y*1.5+21, z*1.5+21, 2) * 0.10;
          const e2 = this.perlin2.fbm(x*3.2+11, y*3.2+11, z*3.2+11, 2) * 0.060;
          const e3 = this.perlin3.fbm(x*7.0+33, y*7.0+33, z*7.0+33, 2) * 0.034;
          const e4 = this.perlin3.fbm(x*15+77, y*15+77, z*15+77, 2) * 0.018;
          const e5 = this.perlin3.fbm(x*31+50, y*31+50, z*31+50, 2) * 0.010;
          const sheetLat = absLatLocal + e1 + e2 + e3 + e4 + e5;

          // HARD threshold — pixel is either ice or not ice, with only a
          // tiny anti-aliased boundary band. This is the key change from
          // the previous gradient-fade behavior.
          const HARD_THR = cfg.iceLine - 0.02;
          const AA_BAND = 0.008;  // ~1-2 pixels of soft transition

          // Worley breakup — used as an additional cut on the threshold.
          // Inside the consolidated cap (well past iceLine) this doesn't
          // remove anything; near the edge, it punches the sheet into
          // distinct floes/icebergs.
          // wCell ranges 0..1: low near cell centers, higher at boundaries.
          const wCell = this.worley.noise(x*5+88, y*5+88, z*5+88);
          const wCellFine = this.worley.noise(x*14+101, y*14+101, z*14+101);
          // How far past the threshold are we?
          const overshoot = sheetLat - HARD_THR;
          // In the first 0.06 of overshoot, allow Worley to break the
          // sheet into floes. Beyond that, the sheet is consolidated.
          let coverHard;
          if (overshoot < -AA_BAND) {
            coverHard = 0;
          } else if (overshoot < 0) {
            // Anti-aliased outer edge
            coverHard = (overshoot + AA_BAND) / AA_BAND;
          } else if (overshoot < 0.07) {
            // Floe zone — Worley cells break up the sheet here.
            // Combine two Worley scales: large (wCell) for major floes,
            // small (wCellFine) for finer ice debris. A pixel is ice
            // if either scale's distance is above a threshold.
            const floePresent = (wCell > 0.18) ? 1 : 0;
            const debrisPresent = (wCellFine > 0.30) ? 1 : 0;
            const eitherIce = Math.max(floePresent, debrisPresent);
            // Soft AA at floe edges
            const cellEdgeAA = clamp((wCell - 0.13) / 0.05, 0, 1);
            const debrisEdgeAA = clamp((wCellFine - 0.25) / 0.05, 0, 1);
            const aaCover = Math.max(cellEdgeAA, debrisEdgeAA);
            coverHard = eitherIce ? 1 : aaCover;
          } else {
            // Consolidated ice sheet — fully covered
            coverHard = 1;
          }

          if (coverHard > 0.001) {
            // Record ice coverage so the bump-shader can skip these pixels —
            // a thick polar ice sheet should hide the underlying terrain
            // bumpiness, not show through it as radial streaks.
            this.iceMap[j * W + i] = coverHard;
            // Polar texture fade — at very high latitudes, equirectangular
            // distortion compresses many texels into the same physical
            // point. Fade detail aggressively near the pole.
            // Use cos²(lat) for steeper falloff than linear.
            const cosL = Math.cos(lat);
            const polarFade = clamp(cosL * cosL * 2.5, 0, 1);
            // Interior crevasses / leads — only inside the consolidated cap.
            // Use isotropic 3D noise (same scale on all axes) so features
            // don't get stretched into longitudinal streaks at the pole.
            let texDarken = 0;
            if (overshoot > 0.04) {
              const crev = this.perlin3.fbm(x*16+5, y*16+5, z*16+5, 3);
              if (crev < -0.18) {
                texDarken = smoothstep(-0.35, -0.18, crev) * 0.10 * polarFade;
              }
              // Mid-scale ice surface roughness — also isotropic, much subtler
              const rough = this.perlin3.fbm(x*9+101, y*9+101, z*9+101, 2);
              texDarken += clamp(-rough, 0, 1) * 0.03 * polarFade;
            }
            // Glacier-blue tint inside the cap — also fades near pole so
            // the very pole reads as smooth uniform ice.
            const blueShift = (overshoot > 0.04)
              ? smoothstep(-0.2, 0.4, this.perlin2.fbm(x*4+9, y*4+9, z*4+9, 2)) * 0.08 * polarFade
              : 0;
            // Pole-center brightening
            const poleBoost = clamp((absLatLocal - cfg.iceLine) / 0.10, 0, 1);
            const baseLift = 0.05 * poleBoost;
            let sheetR = pal.polarIce[0] * (1 - baseLift) + 255 * baseLift;
            let sheetG = pal.polarIce[1] * (1 - baseLift) + 255 * baseLift;
            let sheetB = pal.polarIce[2] * (1 - baseLift) + 255 * baseLift;
            sheetR *= (1 - blueShift - texDarken);
            sheetG *= (1 - blueShift * 0.5 - texDarken);
            sheetB *= (1 - texDarken);
            r = r * (1 - coverHard) + sheetR * coverHard;
            g = g * (1 - coverHard) + sheetG * coverHard;
            b = b * (1 - coverHard) + sheetB * coverHard;
          }
        }

        const idx = (j * W + i) * 3;
        colorMap[idx] = r;
        colorMap[idx+1] = g;
        colorMap[idx+2] = b;
      }
    }
    this.rawColorMap = new Uint8ClampedArray(this.colorMap);
  }

  // Morph the base terrain toward an independent LARGE-SCALE continental
  // layout. amt 0..1 (region-wipe blend so coastlines stay crisp mid-morph);
  // scale sets continent size (scale < 1 = larger continents, > 1 = smaller /
  // more islands). Runs on CPU BEFORE erosion so rivers + erosion follow the
  // final shape rather than the original one.
  computeEvolvedHeight(base, amt, scale) {
    const W = this.texW, H = this.texH;
    const out = new Float32Array(W * H);
    const sc = Math.max(0.25, scale);
    const contFreq = 0.85 * sc;                    // low freq -> big continents
    const ph = (this.seedNum % 997) * 0.021;       // fixed target world per seed
    const edge = 0.20;
    const t = amt * (1 + 2 * edge) - edge;
    const P = this.perlin, P2 = this.perlin2, P3 = this.perlin3;
    for (let j = 0; j < H; j++) {
      const lat = ((j + 0.5) / H) * Math.PI - Math.PI / 2;
      const cosLat = Math.cos(lat), sinLat = Math.sin(lat);
      for (let i = 0; i < W; i++) {
        const lon = ((i + 0.5) / W) * 2 * Math.PI;
        const x = cosLat * Math.cos(lon), y = sinLat, z = cosLat * Math.sin(lon);
        // low-freq domain warp -> organic (non-blobby) coastlines
        const wx = P.fbm(x + ph, y, z, 2) * 0.5;
        const wy = P.fbm(x + 5.2, y + ph, z, 2) * 0.5;
        const wz = P.fbm(x + 2.7, y, z + ph, 2) * 0.5;
        const px = x + wx, py = y + wy, pz = z + wz;
        const cont = P.fbm(px * contFreq + ph, py * contFreq, pz * contFreq, 5) * 1.9;
        const detail = P2.fbm(px * 3.0 + 12, py * 3.0, pz * 3.0, 3) * 0.16;
        const rid = 1 - Math.abs(P3.fbm(px * 2.2 * sc + 40, py * 2.2 * sc, pz * 2.2 * sc, 3));
        const mtn = Math.max(rid - 0.5, 0) * 0.6;
        const target = cont + detail + mtn - 0.42;   // bias for a balanced land/sea fraction
        const region = P2.fbm(x * 1.2 + 60, y * 1.2, z * 1.2, 4) * 0.5 + 0.5;
        const b = smoothstep(region - edge, region + edge, t);
        const idx = j * W + i;
        out[idx] = base[idx] * (1 - b) + target * b;
      }
    }
    return out;
  }

  // Recompute moisture from the current heightMap so biome boundaries track
  // evolved coastlines (moisture is height-warped, so it must follow terrain).
  bakeMoisture(cfg) {
    const W = this.texW, H = this.texH;
    const nOffX = this._nOffX || 0, nOffY = this._nOffY || 0, nOffZ = this._nOffZ || 0;
    const mScale = cfg.moistureScale || 1.4;
    for (let j = 0; j < H; j++) {
      const lat = ((j + 0.5) / H) * Math.PI - Math.PI / 2;
      const cosLat = Math.cos(lat), sinLat = Math.sin(lat);
      for (let i = 0; i < W; i++) {
        const lon = ((i + 0.5) / W) * 2 * Math.PI;
        const x = cosLat * Math.cos(lon), y = sinLat, z = cosLat * Math.sin(lon);
        const hWarpM = (this.heightMap[j * W + i] - cfg.seaLevel) * 1.6;
        this.moistureMap[j * W + i] = clamp(this.perlin2.fbm(
          x * mScale + nOffZ + hWarpM * 0.5,
          y * mScale + nOffX + hWarpM * 0.3,
          z * mScale + nOffY + hWarpM * 0.5, 4) * 1.4 + 0.5, 0, 1);
      }
    }
  }

  // Live terrain re-bake: EVOLVE (terrain morph) FIRST, then multi-resolution
  // EROSION, then moisture / colour / shade / water-mask — so the whole chain
  // (rivers, erosion, biomes) describes the SAME final terrain. Rocky water
  // types only. evolveAmt 0..1, evolveScale (~0.3..2), erosionStrength 0..2
  // (1 = generated), detail 0..1 (broad valleys ↔ crisp fluvial cuts).
  reTerrain(evolveAmt, evolveScale, erosionStrength, detail) {
    const cfg = this._cfg;
    if (!this.baseHeightMap || !cfg || cfg.kind !== 'rocky') return;
    const W = this.texW, H = this.texH;
    const working = (evolveAmt > 0.001)
      ? this.computeEvolvedHeight(this.baseHeightMap, evolveAmt, evolveScale)
      : new Float32Array(this.baseHeightMap);
    if (erosionStrength < 0.03) {
      this.heightMap = working;
      this.flowMap = new Float32Array(W * H);
    } else {
      // Fixed base droplet count + erosionScale for the intensity so the result
      // stays hardware-independent; DETAIL biases coarse-vs-fine carving.
      const { height, flow } = erodeMultiRes(working, W, H, {
        seed: this.seedNum,
        seaLevel: cfg.seaLevel,
        droplets: Math.round(50000 * (W * H) / (768 * 384)),
        detail: (detail == null ? 0.5 : detail),
        // fold in the per-type base scale (volcanic 0.8 / ice 0.5 / water 1.0)
        // so the slider's neutral 1.0× reproduces the as-generated carve.
        erosionScale: erosionStrength * (this._eroBaseScale || 1),
      });
      this.heightMap = height;
      this.flowMap = flow;
    }
    if (evolveAmt > 0.001) this.bakeMoisture(cfg);
    else if (this.baseMoistureMap) this.moistureMap.set(this.baseMoistureMap);   // restore seed biomes
    this.bakeSurfaceColors(cfg, this._activePalette());
    this.applyBumpShading(cfg, this._displacement || 1.0);
    this.softenColorMap();
    this.bakeWaterMask(cfg);
  }

  // The palette actually used for baking: the seed palette merged with any live
  // custom-colour override (a side field — the seed palette is never mutated, so
  // base generation stays deterministic).
  _activePalette() {
    return this._palOverride ? Object.assign({}, this.palette, this._palOverride) : this.palette;
  }

  // Live custom-colour override — re-bake the surface colours (and water mask)
  // from the merged palette. Rocky bodies only (gas recolours via the gradient
  // map / band colours). overrides is a partial palette map ({slot:[r,g,b]}).
  setPaletteOverride(overrides) {
    if (!this._cfg || this._cfg.kind !== 'rocky') return;
    this._palOverride = overrides || null;
    this._rebakeColors();
  }
  clearPaletteOverride() {
    if (!this._cfg || this._cfg.kind !== 'rocky' || !this._palOverride) return;
    this._palOverride = null;
    this._rebakeColors();
  }
  _rebakeColors() {
    if (!this.rawColorMap || !this._cfg) return;
    this.bakeSurfaceColors(this._cfg, this._activePalette());
    this.applyBumpShading(this._cfg, this._displacement || 1.0);
    this.softenColorMap();
    this.bakeWaterMask(this._cfg);
  }

  // Re-apply bump shading at a new strength. Used by the Relief slider.
  // strength = 0 → flat (no shading), 1 → default, 2.5 → exaggerated relief.
  setDisplacement(strength) {
    if (this._displacement === strength) return;
    this._displacement = strength;
    if (!this.rawColorMap || !this._cfg || this._cfg.kind !== 'rocky') return;
    // Restore raw color, re-shade, re-soften.
    this.colorMap.set(this.rawColorMap);
    this.applyBumpShading(this._cfg, strength);
    this.softenColorMap();
  }

  // Weighted [1,6,1]/8 separable blur on colorMap. Combined kernel center
  // weight is 36/64 = 56%, vs the 11% (1/9) of an equal-weight 3×3 box.
  // Strong enough to anti-alias sub-texel shimmer; gentle enough to keep
  // biome boundaries, mountain bump shading, and high-freq surface texture
  // from washing out into mush.
  softenColorMap() {
    const W = this.texW, H = this.texH;
    const src = this.colorMap;
    const tmp = new Uint8ClampedArray(src.length);
    // Horizontal pass (wraps in U) — kernel [1,6,1]/8
    for (let j = 0; j < H; j++) {
      const row = j * W;
      for (let i = 0; i < W; i++) {
        const im = ((i - 1) % W + W) % W;
        const ip = (i + 1) % W;
        const a = (row + im) * 3, b = (row + i) * 3, c = (row + ip) * 3;
        const o = b;
        tmp[o]     = (src[a]     + src[b]     * 6 + src[c])     / 8;
        tmp[o + 1] = (src[a + 1] + src[b + 1] * 6 + src[c + 1]) / 8;
        tmp[o + 2] = (src[a + 2] + src[b + 2] * 6 + src[c + 2]) / 8;
      }
    }
    // Vertical pass (clamps in V) — kernel [1,6,1]/8
    for (let j = 0; j < H; j++) {
      const jm = j > 0 ? j - 1 : 0;
      const jp = j < H - 1 ? j + 1 : H - 1;
      for (let i = 0; i < W; i++) {
        const a = (jm * W + i) * 3, b = (j * W + i) * 3, c = (jp * W + i) * 3;
        src[b]     = (tmp[a]     + tmp[b]     * 6 + tmp[c])     / 8;
        src[b + 1] = (tmp[a + 1] + tmp[b + 1] * 6 + tmp[c + 1]) / 8;
        src[b + 2] = (tmp[a + 2] + tmp[b + 2] * 6 + tmp[c + 2]) / 8;
      }
    }
  }

  // Pre-bake a smoothed water-mask map. For each texel, computes the soft
  // water mask (1 = deep water, 0 = high land) then heavily box-blurs it
  // (radius 3 = 7-tap separable). This stable map is what the renderer
  // samples for the specular gate, so sub-pixel terrain features near the
  // shoreline can't pop the highlight on/off as the planet rotates.
  bakeWaterMask(cfg) {
    const W = this.texW, H = this.texH;
    const N = W * H;
    const sea = cfg.seaLevel;
    const band = 0.05;  // height range over which mask transitions
    const heightMap = this.heightMap;

    // Step 1: raw soft mask
    const raw = new Float32Array(N);
    for (let k = 0; k < N; k++) {
      const m = (sea + band - heightMap[k]) / (2 * band);
      raw[k] = m < 0 ? 0 : m > 1 ? 1 : m;
    }

    // Step 2: separable box blur, radius 3 (wraps in U, clamps in V)
    const radius = 3;
    const denom = radius * 2 + 1;
    const tmp = new Float32Array(N);
    for (let j = 0; j < H; j++) {
      const row = j * W;
      for (let i = 0; i < W; i++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) {
          const ii = ((i + k) % W + W) % W;
          sum += raw[row + ii];
        }
        tmp[row + i] = sum / denom;
      }
    }
    const out = new Float32Array(N);
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) {
          let jj = j + k;
          if (jj < 0) jj = 0;
          else if (jj >= H) jj = H - 1;
          sum += tmp[jj * W + i];
        }
        out[j * W + i] = sum / denom;
      }
    }
    this.waterMaskMap = out;
  }

  // Organic colour-detail multiplier (~[1-a, 1+a]) that mottles a flat biome
  // colour into naturalistic tonal variation. A low-frequency PATCHWORK mask
  // varies the amplitude so some regions are richly textured and others nearly
  // flat (never a uniform grain), and the detail noise is domain-warped so the
  // mottling flows organically with the terrain instead of reading as a screen
  // overlay. Kept subtle (≤ ~±13%). Seed-driven → fully deterministic. Matches
  // the GL shader's colorDetail() so the live view and the export agree.
  _colorDetail(x, y, z) {
    const patch = clamp(this.perlin2.fbm(x * 1.7 + 210, y * 1.7 + 210, z * 1.7 + 210, 3) * 0.5 + 0.5, 0, 1);
    const amp = (0.35 + 0.65 * patch) * 0.17;
    const wx = this.perlin3.fbm(x * 2.3 + 41, y * 2.3 + 41, z * 2.3 + 41, 2) * 0.20;
    const d = this.perlin3.fbm(x * 7.5 + wx + 90, y * 7.5 + wx + 90, z * 7.5 + wx + 90, 5);
    return 1 + clamp(d, -1, 1) * amp;
  }

  // Color a rocky-planet pixel based on height/moisture/latitude.
  // `slope` (optional) is the local terrain gradient magnitude; where given, the
  // snowcap sheds off steep faces so mountains read as 3D relief, not flat snow.
  colorPixelRocky(h, m, lat, cfg, pal, x, y, z, slope = 0) {
    const absLat = Math.abs(lat) / (Math.PI / 2);  // 0 equator -> 1 pole

    // ----- VOLCANIC -----
    if (this.type === 'volcanic') {
      const lavaPal = pal;
      if (h < cfg.seaLevel) {
        // Lava sea: depth modulates color
        const depth = clamp((cfg.seaLevel - h) / 0.4, 0, 1);
        const lava = mixRgb(lavaPal.lavaHot, lavaPal.lava, depth);
        // hot cracks at edges
        return lava;
      }
      // crust
      const t = clamp((h - cfg.seaLevel) / 0.5, 0, 1);
      let col = mixRgb(lavaPal.ash, lavaPal.rock, t);
      col = mixRgb(col, lavaPal.crust, smoothstep(0.4, 0.9, t));
      // sulfur deposits in moist regions
      if (m > 0.7 && h < 0.3) col = mixRgb(col, lavaPal.sulfur, smoothstep(0.7, 0.95, m) * 0.6);
      // lava cracks (network from worley)
      const crack = this.worley.noise(x*8+10, y*8+10, z*8+10);
      if (crack < 0.05 && h > cfg.seaLevel && h < 0.2) {
        col = mixRgb(col, lavaPal.lavaHot, (0.05 - crack) * 12);
      }
      return col;
    }

    // ----- PRIMORDIAL -----
    // Young Earth-like: water (where below sea), vegetation/basalt on land,
    // and a 3D "magma province" map carved out of the surface. In magma
    // provinces, low-elevation land becomes lava lakes; higher ground is
    // scorched basalt; vegetation is suppressed. Outside magma provinces,
    // the surface looks like sparse-life early Earth.
    if (this.type === 'primordial') {
      const pp = pal;
      // Magma province map — low-frequency 3D Perlin gating where flood
      // basalts dominate. Threshold against magmaCoverage so a planet's
      // overall lava coverage matches the seed's magmaCoverage value.
      // (mScale is fed from cfg.magmaScale so seeds vary in province size.)
      const mScale = cfg.magmaScale || 1.0;
      const magmaRaw = this.perlin2.fbm(x * mScale + 200, y * mScale + 200, z * mScale + 200, 4);
      // Threshold: high values = active magma. magmaCoverage=0.4 means about
      // 40% of the surface area is in a province; that fraction of `magmaRaw`
      // crosses the threshold.
      const magmaThr = 0.5 - (cfg.magmaCoverage || 0.3) * 0.6;
      const magma = clamp((magmaRaw - magmaThr) * 5, 0, 1);

      // ---- Water (only outside magma provinces; provinces eat the sea) ----
      if (h < cfg.seaLevel && magma < 0.4) {
        const depth = clamp((cfg.seaLevel - h) / 0.45, 0, 1);
        let water = mixRgb(pp.shore, pp.water, smoothstep(0, 0.15, depth));
        water = mixRgb(water, pp.deepWater, smoothstep(0.2, 0.7, depth));
        // No bright shore foam — primitive seas look murkier
        return water;
      }

      // ---- Lava lake (low ground, inside magma province) ----
      if (h < cfg.seaLevel + 0.04 && magma > 0.4) {
        // How "deep" we are into the province AND how low the elevation —
        // both push toward hot lava. Province edges are cooler crust.
        const depthBelow = clamp((cfg.seaLevel + 0.04 - h) / 0.20, 0, 1);
        const heatFactor = magma * (0.5 + depthBelow * 0.5);
        // Hot rivers in deepest, most-magmatic spots; cool basalt in shallows
        let col = mixRgb(pp.basalt, pp.lava, heatFactor);
        if (heatFactor > 0.7) {
          col = mixRgb(col, pp.lavaHot, smoothstep(0.7, 1.0, heatFactor));
        }
        return col;
      }

      // ---- Land (sparse vegetation + basalt + lava-province scarring) ----
      const aboveSea = h - cfg.seaLevel;
      // Base biome by altitude — primitive vegetation in lowlands
      let col;
      if (aboveSea < 0.05)        col = mixRgb(pp.beach, pp.lowland, smoothstep(0, 0.05, aboveSea));
      else if (aboveSea < 0.15)   col = mixRgb(pp.lowland, pp.plains, (aboveSea - 0.05) / 0.10);
      else if (aboveSea < 0.35)   col = mixRgb(pp.plains, pp.hills, (aboveSea - 0.15) / 0.20);
      else if (aboveSea < 0.6)    col = mixRgb(pp.hills, pp.mountain, (aboveSea - 0.35) / 0.25);
      else                         col = mixRgb(pp.mountain, pp.peak, smoothstep(0.6, 0.9, aboveSea));

      // Vegetation density modulator — moisture biases toward lush forest in
      // wet lowlands; fades out toward poles, mountains, and dry interiors.
      if (aboveSea > 0 && aboveSea < 0.4 && m > 0.45) {
        const veg = smoothstep(0.45, 0.75, m) * smoothstep(0.40, 0.10, aboveSea) * (1 - magma);
        col = mixRgb(col, pp.forest, veg * 0.55);
      }

      // Magma-province darkening — even ABOVE sea level, scorched land near
      // active flows reads as ash-stained basalt with rare vegetation.
      if (magma > 0.2) {
        const scorch = smoothstep(0.2, 0.7, magma);
        col = mixRgb(col, pp.basalt, scorch * 0.85);
        // Hot crust cracks — Worley network producing glowing fissures
        // through province interiors.
        if (magma > 0.6) {
          const crack = this.worley.noise(x * 10 + 40, y * 10 + 40, z * 10 + 40);
          if (crack < 0.06) {
            col = mixRgb(col, pp.lavaHot, (0.06 - crack) * 12);
          }
        }
      }

      // Polar bleach — minimal, since primordial planets are hot. Just a
      // hint of dirty ice on the absolute pole.
      if (absLat > cfg.iceLine - 0.04) {
        col = mixRgb(col, pp.polarIce,
          smoothstep(cfg.iceLine - 0.04, cfg.iceLine + 0.06, absLat) * cfg.polarBleach);
      }
      return col;
    }

    // ----- WATER (terrestrial / ocean) -----
    if (h < cfg.seaLevel) {
      const depth = clamp((cfg.seaLevel - h) / 0.45, 0, 1);
      let water = mixRgb(pal.shore, pal.water, smoothstep(0, 0.15, depth));
      water = mixRgb(water, pal.deepWater, smoothstep(0.2, 0.7, depth));
      // tiny shore foam — bright pixels right at sea edge
      if (depth < 0.04) {
        water = mixRgb(water, [220, 235, 240], (0.04 - depth) * 12);
      }
      // (Polar ice sheet for terrestrial/ocean is now applied as a unified
      // overlay after this function returns — see the bake loop. This keeps
      // sea-ice and land-ice as one continuous sheet.)
      return water;
    }

    // ----- ICE -----
    if (this.type === 'ice') {
      const icePal = pal;
      let col;
      if (h < 0.05) col = icePal.lowland;
      else if (h < 0.25) col = mixRgb(icePal.lowland, icePal.plains, (h - 0.05) / 0.2);
      else if (h < 0.45) col = mixRgb(icePal.plains, icePal.hills, (h - 0.25) / 0.2);
      else if (h < 0.65) col = mixRgb(icePal.hills, icePal.mountain, (h - 0.45) / 0.2);
      else col = mixRgb(icePal.mountain, icePal.peak, smoothstep(0.65, 0.95, h));
      // Crevices (deep negative perlin)
      const crev = this.perlin3.fbm(x*6+5, y*6+5, z*6+5, 3);
      if (crev < -0.35) {
        col = mixRgb(col, icePal.crevice, smoothstep(-0.5, -0.35, crev) * 0.7);
      }
      return col;
    }

    // ----- CRATERED -----
    if (this.type === 'cratered') {
      const cp = pal;
      let col;
      if (h < -0.1) col = mixRgb(cp.crater, cp.lowland, smoothstep(-0.3, -0.1, h));
      else if (h < 0.05) col = cp.lowland;
      else if (h < 0.2) col = mixRgb(cp.lowland, cp.plains, (h - 0.05) / 0.15);
      else if (h < 0.4) col = mixRgb(cp.plains, cp.hills, (h - 0.2) / 0.2);
      else col = mixRgb(cp.hills, cp.peak, smoothstep(0.4, 0.7, h));
      // Polar bleach
      if (absLat > cfg.iceLine - 0.04) {
        col = mixRgb(col, cp.polarIce, smoothstep(cfg.iceLine - 0.04, cfg.iceLine + 0.06, absLat) * cfg.polarBleach);
      }
      return col;
    }

    // ----- DESERT -----
    if (this.type === 'desert') {
      const dp = pal;
      let col;
      if (h < 0)        col = mixRgb(dp.lowland, dp.plains, h + 0.5);
      else if (h < 0.1) col = mixRgb(dp.plains, dp.arid, h * 10);
      else if (h < 0.3) col = mixRgb(dp.arid, dp.hills, (h - 0.1) / 0.2);
      else if (h < 0.55) col = mixRgb(dp.hills, dp.mountain, (h - 0.3) / 0.25);
      else col = mixRgb(dp.mountain, dp.peak, smoothstep(0.55, 0.85, h));
      // Dune ripples — high-freq perlin
      const dune = this.perlin3.fbm(x*40, y*4, z*40, 2);
      col = mixRgb(col, mixRgb(col, dp.peak, 0.3), clamp(dune * 0.4, 0, 0.4));
      // Polar bleach
      if (absLat > cfg.iceLine - 0.04) {
        col = mixRgb(col, dp.polarIce, smoothstep(cfg.iceLine - 0.04, cfg.iceLine + 0.06, absLat) * cfg.polarBleach);
      }
      return col;
    }

    // ----- TERRESTRIAL / OCEAN (land portion) -----
    const aboveSea = h - cfg.seaLevel;

    // Climate factor: latitude (cold poles) + altitude (cold mountains).
    // Drives both vegetation suppression (tundra desaturation) and snow/ice
    // cover. This unified formula means:
    //   - high mountains get snow caps even near the equator
    //   - gullies and lowlands near the poles glaciate
    //   - subpolar zones get a tundra band before turning to ice
    const altBoost = aboveSea > 0 ? aboveSea * 0.85 : 0;
    const climate = absLat + altBoost;
    const iceTrigger = cfg.iceLine - 0.05;
    const ice    = clamp((climate - iceTrigger) * 5, 0, 1);
    const tundra = clamp((climate - (iceTrigger - 0.20)) * 5, 0, 1) * (1 - ice);

    // Latitude zones — model Earth-like climate bands:
    //   absLat 0.0  : equatorial (lush rainforest, very saturated greens)
    //   absLat 0.25 : subtropical highs / horse latitudes (deserts cluster
    //                 here — Sahara, Australian outback, Atacama, Kalahari)
    //   absLat 0.45 : temperate (less saturated greens, mixed forest/grass)
    //   absLat 0.65+: subpolar / tundra (handled by `tundra` above)
    // tropical: 1 at equator -> 0 by absLat 0.4
    const tropical = clamp(1 - absLat / 0.40, 0, 1);
    // subtropicalDry: gaussian-like peak at absLat ~0.27 (24° latitude)
    const sLat = (absLat - 0.27);
    const subtropicalDry = Math.exp(-(sLat * sLat) / 0.018) * (1 - ice) * (1 - tundra);
    // temperateBand: peak around absLat 0.45-0.55, fades toward equator and tundra
    const tempD = absLat - 0.50;
    const temperate = Math.exp(-(tempD * tempD) / 0.025) * (1 - ice) * (1 - tundra);

    // Effective moisture — subtropical highs reduce moisture (creates
    // continent-interior deserts at the right latitudes), tropical zones
    // boost moisture for rainforest density.
    let mEff = m;
    mEff = clamp(mEff - subtropicalDry * 0.55, 0, 1);
    mEff = clamp(mEff + tropical * 0.15, 0, 1);

    let col;
    // ---- Coastline ----
    // Gentle shores get sandy BEACHES; steep shores and a fraction of coasts
    // (by a regional low-freq mask + fine speckle) become rocky CLIFFS and
    // outcrops, so the shoreline isn't a uniform sand ribbon. `slope` is the
    // local terrain gradient (steep coast → cliff); the noises break the
    // sand/rock boundary into a meandering, speckled edge.
    if (aboveSea < 0.08) {
      const lowBiome = mixRgb(pal.lowland, pal.plains, mEff);
      const coastNoise = this.perlin2.fbm(x * 3.4 + 130, y * 3.4 + 130, z * 3.4 + 130, 4);
      const speckle = this.perlin3.fbm(x * 20 + 9, y * 20 + 9, z * 20 + 9, 2);
      const rk = clamp(smoothstep(0.045, 0.16, slope) + smoothstep(0.14, 0.42, coastNoise) + speckle * 0.22, 0, 1);
      const cliffCol = mixRgb(pal.hills, pal.mountain, 0.35);   // rocky/cliff tone
      const coastMat = mixRgb(pal.beach, cliffCol, smoothstep(0.35, 0.65, rk));
      col = (aboveSea < 0.02) ? coastMat : mixRgb(coastMat, lowBiome, (aboveSea - 0.02) / 0.06);
    } else {
      // Biome by moisture + altitude
      const dryLand = mixRgb(pal.arid, pal.hills, smoothstep(0.05, 0.3, aboveSea));
      const wetLand = mixRgb(pal.plains, pal.forest, smoothstep(0.4, 0.85, mEff));
      let lowMid = mixRgb(dryLand, wetLand, smoothstep(0.3, 0.7, mEff));

      // Tropical saturation boost — push wet equatorial vegetation toward
      // a deeper, more saturated forest tone. Affects only mid-low altitude
      // wet biomes (jungle proxy).
      if (tropical > 0.05 && mEff > 0.4 && aboveSea < 0.4) {
        const jungleAmount = tropical * smoothstep(0.4, 0.7, mEff);
        // Darker, more saturated forest by mixing toward forest with a
        // saturation boost: scale RGB nonlinearly to deepen color.
        const deepForest = [
          pal.forest[0] * 0.65,
          pal.forest[1] * 1.05,
          pal.forest[2] * 0.55,
        ];
        lowMid = mixRgb(lowMid, deepForest, jungleAmount * 0.55);
      }

      // Temperate desaturation — temperate vegetation reads less saturated
      // than tropical (think pine-belt vs rainforest). Pull mid greens
      // toward a muted olive/sage tone.
      if (temperate > 0.05 && mEff > 0.3 && aboveSea < 0.5) {
        const tempVeg = temperate * smoothstep(0.3, 0.6, mEff);
        const lum = (lowMid[0] + lowMid[1] + lowMid[2]) / 3;
        const muted = [
          lowMid[0] * 0.88 + lum * 0.12,
          lowMid[1] * 0.88 + lum * 0.12,
          lowMid[2] * 0.88 + lum * 0.12,
        ];
        lowMid = mixRgb(lowMid, muted, tempVeg * 0.55);
      }

      // Subtropical aridity push — beyond the moisture suppression above,
      // also tint dry subtropical land toward warmer arid hues so dry
      // regions read as ochre/tan rather than just "less green".
      if (subtropicalDry > 0.1 && mEff < 0.5 && aboveSea < 0.5) {
        const aridTint = subtropicalDry * (1 - smoothstep(0.3, 0.55, mEff));
        lowMid = mixRgb(lowMid, pal.arid, aridTint * 0.5);
      }

      // Mid-altitude
      if (aboveSea < 0.25) {
        col = lowMid;
      } else if (aboveSea < 0.45) {
        col = mixRgb(lowMid, pal.hills, (aboveSea - 0.25) / 0.2);
      } else if (aboveSea < 0.7) {
        col = mixRgb(pal.hills, pal.mountain, (aboveSea - 0.45) / 0.25);
      } else {
        col = mixRgb(pal.mountain, pal.peak, smoothstep(0.7, 0.95, aboveSea));
      }

      // Alpine vegetation belt — real mountains in temperate/tropical
      // zones get MORE precipitation than lowlands due to orographic uplift,
      // not less. The lowMid → hills → mountain ramp by itself reads as
      // arid rock at all altitudes; this overlay paints coniferous forest /
      // alpine meadow over moderate-altitude land where temperature and
      // moisture allow vegetation. Caps below the snow line so it doesn't
      // fight the snowcap pass.
      if (aboveSea > 0.18 && aboveSea < 0.55 && (1 - tundra - ice) > 0.3) {
        // Orographic moisture boost — base moisture + altitude bonus
        const orographic = clamp(mEff + (aboveSea - 0.18) * 0.6, 0, 1);
        // Vegetation strength: needs moisture, NOT in the dry subtropical
        // belt, NOT polar tundra, fades out as altitude approaches snow line.
        const altFade = smoothstep(0.55, 0.40, aboveSea);  // 1 at 0.40, 0 at 0.55
        const climateOk = (1 - tundra) * (1 - ice);
        const moistureOk = smoothstep(0.30, 0.55, orographic);
        const dryPenalty = clamp(1 - subtropicalDry * 0.8, 0, 1);
        const alpineAmount = altFade * climateOk * moistureOk * dryPenalty;
        if (alpineAmount > 0.05) {
          // Coniferous tone — desaturated dark green derived from forest
          // palette but pulled toward gray-green (pine/spruce vs jungle)
          const conifer = [
            pal.forest[0] * 0.55 + 35,
            pal.forest[1] * 0.75 + 25,
            pal.forest[2] * 0.55 + 30,
          ];
          // Tropical mountains get LUSHER greens (cloud forest) rather than
          // muted boreal greens — boost saturation toward forest in the
          // tropical band.
          const targetVeg = mixRgb(conifer, pal.forest, tropical * 0.6);
          col = mixRgb(col, targetVeg, alpineAmount * 0.65);
        }
      }
    }

    // Tundra desaturation — muted brown/gray transition zone between
    // full vegetation and full ice. Without this, lush forests run
    // straight into glaciers, which looks unnatural.
    if (tundra > 0) {
      const tundraTone = mixRgb(pal.hills, pal.arid, 0.4);
      col = mixRgb(col, tundraTone, tundra * 0.65);
    }

    // Organic colour-detail mottling — breaks the flat biome gradients into
    // naturalistic tonal variation (applied before the snowcap so caps stay
    // clean). Deterministic, seed-driven; adds apparent detail at any zoom.
    const cd = this._colorDetail(x, y, z);
    col = [col[0] * cd, col[1] * cd, col[2] * cd];

    // Mountain snowcap — altitude-driven with noisy breakup so caps look
    // like real snow on rugged terrain (rock outcrops on south faces,
    // exposed ridges, accumulation in basins) rather than uniform white
    // blobs on every peak. The polar overlay handles latitude-driven ice.
    if (aboveSea > 0.42) {
      // Base altitude ramp (where snow CAN exist)
      const altBand = clamp((aboveSea - 0.42) / 0.30, 0, 1);
      // Snow-line noise — ragged irregular boundary based on terrain
      // exposure. Real snow lines aren't constant elevation; they vary
      // with aspect, wind exposure, and shading.
      const snowNoise = this.perlin2.fbm(x*8 + 31, y*8 + 31, z*8 + 31, 3);
      // Effective threshold per-pixel: shift the snow line up or down
      // by ±0.10 based on the noise. Some patches get snow at lower
      // altitudes (sheltered basins, lee slopes); some don't get snow
      // even at high altitudes (windswept ridges, sun-exposed faces).
      const lineShift = snowNoise * 0.10;
      const effAlt = aboveSea - lineShift;
      if (effAlt > 0.50) {
        // Hard transition with anti-aliasing — small soft band so
        // pixels on the boundary aren't aliased
        let cover = clamp((effAlt - 0.50) / 0.04, 0, 1);
        // Multiply by altitude band so very low altitudes still don't
        // get snow even with strong negative noise
        cover *= altBand;
        // High-frequency rocky breakup — exposed rock punches through
        // the snow on steep faces. Fine ridge fbm.
        const rocky = this.perlin3.fbm(x*22 + 7, y*22 + 7, z*22 + 7, 3);
        if (rocky > 0.18) {
          // Above this threshold, expose rock — reduce snow coverage
          cover *= clamp(1 - (rocky - 0.18) * 3, 0, 1);
        }
        // Slope-driven rock exposure — steep faces shed snow so ridges and cut
        // valleys read as 3D relief rather than a flat white cap. Matches the
        // GL shader's classifyRocky slope break (0.035..0.13 → up to 85% off).
        const steep = smoothstep(0.035, 0.13, slope);
        cover *= 1 - 0.85 * steep;
        // Snow-surface texture — isotropic mid-frequency variation
        const surfTex = this.perlin3.fbm(x*14 + 1, y*14 + 1, z*14 + 1, 2);
        let texDarken = 0;
        if (surfTex < -0.10 && cover > 0.5) {
          texDarken = (-surfTex - 0.10) * 0.20;
        }
        if (cover > 0.02) {
          // Slight blue cast on snow (similar to glacier, less intense)
          const snowR = pal.polarIce[0] * (1 - texDarken);
          const snowG = pal.polarIce[1] * (1 - texDarken * 0.7);
          const snowB = pal.polarIce[2] * (1 - texDarken * 0.4);
          col = [
            col[0] * (1 - cover) + snowR * cover,
            col[1] * (1 - cover) + snowG * cover,
            col[2] * (1 - cover) + snowB * cover,
          ];
        }
      }
    }
    return col;
  }

  // Decompose the surface into separable equirect LAYERS for the map export:
  // GROUND (bare land), VEGETATION, SNOW/ICE, WATER (rivers+oceans together),
  // CLOUDS. Each is { rgb: Uint8ClampedArray(N*3), alpha: Float32Array(N) } at
  // texW×texH, re-running the exact classifier math so composited layers match
  // the rendered planet. rgb is DEFINED EVERYWHERE (coverage lives only in
  // alpha) so bilinear upscaling never fringes. opts carries live-look values
  // (riverStrength, cloudCover, cloudMul, cloudColor[0-255], ashCloud[0-255],
  // vegetation) so the export tracks the current view; terrain constants come
  // from the baked cfg. Deterministic (same seeded noise as generation).
  bakeExportLayers(opts = {}) {
    const SW = this.texW, SH = this.texH;               // source (baked map) resolution
    const OW = Math.max(1, Math.floor(opts.width || SW));  // output resolution
    const OH = Math.max(1, Math.floor(opts.height || SH));
    const N = OW * OH;
    const mk = () => ({ rgb: new Uint8ClampedArray(N * 3), alpha: new Float32Array(N) });
    const L = { ground: mk(), veg: mk(), snow: mk(), water: mk(), clouds: mk() };
    const cfg = this._cfg || this.getTypeConfig();
    const pal = this._activePalette ? this._activePalette() : this.palette;
    const put = (layer, k, c, a) => { const o = k * 3; layer.rgb[o] = c[0]; layer.rgb[o + 1] = c[1]; layer.rgb[o + 2] = c[2]; layer.alpha[k] = a; };

    // Gradient-map application (per surface class), so the EXPORT reproduces the
    // gradient look the viewport shows — including per-class targeting (index
    // 0 water,1 rock,2 veg,3 ice,4 gas). Inlined (no color-grade import) to keep
    // Planet free of the GL/DOM dependency. opts.gradient = {lut,mix,scale,enable,lo,hi}.
    const G = opts.gradient && opts.gradient.lut && opts.gradient.mix > 0 ? opts.gradient : null;
    const grade = (c, cls) => {
      if (!G || !G.enable[cls]) return c;
      let Lb = (c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722) / 255;
      Lb = Lb < 0 ? 0 : Lb > 1 ? 1 : Lb;
      if (G.scale && G.scale !== 1) { Lb = (Lb - 0.5) / G.scale + 0.5; Lb = Lb < 0 ? 0 : Lb > 1 ? 1 : Lb; }
      Lb = G.lo[cls] + (G.hi[cls] - G.lo[cls]) * Lb; Lb = Lb < 0 ? 0 : Lb > 1 ? 1 : Lb;
      const i = (Lb * 255) | 0, mr = G.lut[i * 3], mg = G.lut[i * 3 + 1], mb = G.lut[i * 3 + 2];
      return [c[0] + (mr - c[0]) * G.mix, c[1] + (mg - c[1]) * G.mix, c[2] + (mb - c[2]) * G.mix];
    };

    // Bilinear sampler over an equirect source map (single channel): u wraps in
    // longitude, v clamps in latitude. Sampling the 768-wide baked maps at the
    // higher OUTPUT resolution — while evaluating the procedural noise below at
    // full output resolution and thresholding coasts/rivers per output pixel —
    // is what makes a 2K/4K export crisp instead of a blurry upscale of the bake.
    const SH1 = SH - 1, dU = 1 / SW, dV = 1 / SH;
    const sm = (map, u, v, fb) => {
      if (!map) return fb;
      const fx = u * SW - 0.5, fy = v * SH - 0.5;
      const xf = Math.floor(fx), yf = Math.floor(fy), tx = fx - xf, ty = fy - yf;
      const x0 = ((xf % SW) + SW) % SW, x1 = ((xf + 1) % SW + SW) % SW;
      const y0 = yf < 0 ? 0 : yf > SH1 ? SH1 : yf, y1 = (yf + 1) < 0 ? 0 : (yf + 1) > SH1 ? SH1 : (yf + 1);
      const a = map[y0 * SW + x0], b = map[y0 * SW + x1], c = map[y1 * SW + x0], d = map[y1 * SW + x1];
      const top = a + (b - a) * tx, bot = c + (d - c) * tx;
      return top + (bot - top) * ty;
    };
    // 3-channel bilinear for the interleaved colorMap (gas albedo upsample).
    const smC = (u, v, ch) => {
      const cm3 = this.colorMap; const fx = u * SW - 0.5, fy = v * SH - 0.5;
      const xf = Math.floor(fx), yf = Math.floor(fy), tx = fx - xf, ty = fy - yf;
      const x0 = ((xf % SW) + SW) % SW, x1 = ((xf + 1) % SW + SW) % SW;
      const y0 = yf < 0 ? 0 : yf > SH1 ? SH1 : yf, y1 = (yf + 1) < 0 ? 0 : (yf + 1) > SH1 ? SH1 : (yf + 1);
      const a = cm3[(y0 * SW + x0) * 3 + ch], b = cm3[(y0 * SW + x1) * 3 + ch], cc = cm3[(y1 * SW + x0) * 3 + ch], d = cm3[(y1 * SW + x1) * 3 + ch];
      const top = a + (b - a) * tx, bot = cc + (cc !== undefined ? (d - cc) * tx : 0);
      return top + (bot - top) * ty;
    };

    // Gas kinds: the banded albedo already bakes clouds in — expose it as GROUND.
    if (cfg.kind === 'gas') {
      for (let j = 0; j < OH; j++) { const v = (j + 0.5) / OH; for (let i = 0; i < OW; i++) { const u = (i + 0.5) / OW, k = j * OW + i;
        const gc = grade([smC(u, v, 0), smC(u, v, 1), smC(u, v, 2)], 4);
        const o = k * 3; L.ground.rgb[o] = gc[0]; L.ground.rgb[o + 1] = gc[1]; L.ground.rgb[o + 2] = gc[2]; L.ground.alpha[k] = 1; } }
      return L;
    }

    const sea = cfg.seaLevel;
    const COAST_AA = 0.0035;   // half-width (height units) of the crisp coast AA band
    const iceLine = (cfg.iceLine != null) ? cfg.iceLine : 0.65;
    const isTerr = (this.type === 'terrestrial' || this.type === 'ocean');
    // Only terrestrial/ocean get a separable WATER layer. Exotic rocky types
    // (ice/desert/cratered) have no ocean concept; primordial has magma-province
    // lava lakes below sea level that a height-only ocean mask would wrongly
    // paint as water — so those all fall through to the whole-colorPixelRocky
    // GROUND layer instead (which paints their seas/lava correctly).
    const palHasWater = isTerr && !!(pal.shore && pal.water && pal.deepWater);
    const waterFallback = pal.water || [30, 60, 90];
    const hm = this.heightMap, mm = this.moistureMap, im = this.iceMap, fm = this.flowMap, cm = this.cloudMap, am = this.ashMap;
    const riverStrength = opts.riverStrength != null ? opts.riverStrength : 1;
    const cloudCover = opts.cloudCover != null ? opts.cloudCover : 0.5;
    const cloudMul = opts.cloudMul != null ? opts.cloudMul : 1;
    const cloudCol = opts.cloudColor || [255, 255, 255];
    const ashCol = opts.ashCloud || [58, 46, 36];
    const vegMul = opts.vegetation != null ? opts.vegetation : 1;

    for (let j = 0; j < OH; j++) {
      const v = (j + 0.5) / OH;
      const lat = v * Math.PI - Math.PI / 2;
      const cosLat = Math.cos(lat), sinLat = Math.sin(lat);
      const absLat = Math.abs(lat) / (Math.PI / 2);
      for (let i = 0; i < OW; i++) {
        const k = j * OW + i;
        const u = (i + 0.5) / OW;
        const lon = u * 2 * Math.PI;
        const x = cosLat * Math.cos(lon), y = sinLat, z = cosLat * Math.sin(lon);
        // Fine organic detail-warp of the MAP lookups (not the procedural noise):
        // the 768-baked height/flow are bilinearly smooth, so at high export
        // resolution coastlines read as soft curves and rivers as chunky bilinear
        // paths. Displacing the sample point by a small multi-scale noise (~2
        // source texels) crenellates coasts and meanders rivers at sub-texel
        // scale, so a 4K export gains organic detail instead of looking 768-native.
        const wU = this.perlin3.fbm(x * 13 + 330, y * 13 + 330, z * 13 + 330, 3) * (1.4 / SW) + this.perlin3.fbm(x * 5 + 31, y * 5 + 31, z * 5 + 31, 2) * (0.9 / SW);
        const wV = this.perlin3.fbm(x * 13 + 540, y * 13 + 540, z * 13 + 540, 3) * (1.4 / SH) + this.perlin3.fbm(x * 5 + 61, y * 5 + 61, z * 5 + 61, 2) * (0.9 / SH);
        const uS = u + wU, vS = v + wV;
        // High-frequency DETAIL SYNTHESIS — the baked height is only 768 wide, so
        // add fine multi-octave fractal relief (evaluated at full export
        // resolution). The sea-level threshold then crenellates the coastline and
        // the altitude/colour ramps gain sub-768 texture, so a 4K export shows
        // real detail instead of smooth 768 blobs. Small amplitude so it textures
        // rather than inventing land in deep ocean.
        const hDetail = this.perlin3.fbm(x * 30 + 610, y * 30 + 610, z * 30 + 610, 4) * 0.019
                      + this.perlin2.fbm(x * 82 + 630, y * 82 + 630, z * 82 + 630, 2) * 0.007;
        const h = sm(hm, uS, vS, sea) + hDetail, m = sm(mm, uS, vS, 0.5);
        // high-frequency colour GRAIN — fine surface texture (down to a few px
        // at 4K) so land/veg read as detailed ground, not flat gradient.
        const grainMul = 1
          + clamp(this.perlin3.fbm(x * 70 + 700, y * 70 + 700, z * 70 + 700, 3), -1, 1) * 0.075
          + clamp(this.perlin2.noise(x * 190 + 9, y * 190 + 9, z * 190 + 9), -1, 1) * 0.05;
        // slope from the SOURCE-resolution central diff (cos-lat corrected) so
        // slope-driven effects are identical at any export resolution
        const gx = (sm(hm, uS + dU, vS, sea) - sm(hm, uS - dU, vS, sea)) * Math.max(0.05, cosLat);
        const gy = sm(hm, uS, vS + dV, sea) - sm(hm, uS, vS - dV, sea);
        const slope = Math.sqrt(gx * gx + gy * gy);
        const aboveSea = h - sea;

        // ---- WATER: oceans + rivers ----
        // Crisp per-pixel coastline from the interpolated height threshold
        // (matches the shader's h < seaLevel), not the pre-smoothed 768 mask.
        const oceanCover = palHasWater ? clamp((sea + COAST_AA - h) / (2 * COAST_AA), 0, 1) : 0;
        let waterCol = waterFallback;
        if (palHasWater) {
          const depth = clamp((sea - h) / 0.45, 0, 1);
          waterCol = mixRgb(pal.shore, pal.water, smoothstep(0, 0.15, depth));
          waterCol = mixRgb(waterCol, pal.deepWater, smoothstep(0.2, 0.7, depth));
          if (depth < 0.04) waterCol = mixRgb(waterCol, [220, 235, 240], (0.04 - depth) * 12);
        }

        // ---- SNOW: polar sheet (iceMap) + mountain snowcap ----
        const polarIce = clamp(sm(im, uS, vS, 0), 0, 1);
        let snowCover = polarIce;
        if (isTerr && aboveSea > 0.42) {
          const altBand = clamp((aboveSea - 0.42) / 0.30, 0, 1);
          const snowNoise = this.perlin2.fbm(x * 8 + 31, y * 8 + 31, z * 8 + 31, 3);
          const effAlt = aboveSea - snowNoise * 0.10;
          if (effAlt > 0.50) {
            let cover = clamp((effAlt - 0.50) / 0.04, 0, 1) * altBand;
            const rocky = this.perlin3.fbm(x * 22 + 7, y * 22 + 7, z * 22 + 7, 3);
            if (rocky > 0.18) cover *= clamp(1 - (rocky - 0.18) * 3, 0, 1);
            cover *= 1 - 0.85 * smoothstep(0.035, 0.13, slope);
            snowCover = Math.max(snowCover, cover);
          }
        }

        // ---- rivers (shader rule, on CPU) ----
        let riverCover = 0, riverCol = null;
        if (fm && palHasWater && aboveSea >= 0) {
          const flow = sm(fm, uS, vS, 0);
          const th = clamp(0.90 - 0.30 * riverStrength, 0.28, 0.92);
          let rt = smoothstep(th, th + 0.16, flow) * (1 - smoothstep(0.10, 0.26, slope));
          rt *= smoothstep(sea, sea + 0.015, h);
          const climate = absLat + Math.max(aboveSea, 0) * 0.85;
          // Match the shader river rule: cold-fade uses the polar ICE sheet
          // (iceMap), NOT the combined snowCover (which includes mountain caps).
          const coldFade = clamp(Math.max(polarIce, smoothstep(iceLine - 0.20, iceLine + 0.02, climate)), 0, 1);
          rt *= (1 - coldFade);
          riverCover = rt * clamp(0.55 + 0.35 * riverStrength, 0, 1);
          riverCol = mixRgb(pal.shore, pal.water, clamp(flow, 0, 1));
        }
        if (riverCover > oceanCover) put(L.water, k, grade(riverCol, 0), clamp(riverCover, 0, 1));
        else put(L.water, k, grade(waterCol, 0), oceanCover);

        const landMask = clamp(1 - oceanCover, 0, 1);

        // ---- GROUND (bare) + VEGETATION ----
        if (isTerr) {
          const altBoost = aboveSea > 0 ? aboveSea * 0.85 : 0;
          const climate = absLat + altBoost;
          const iceTrigger = iceLine - 0.05;
          const ice = clamp((climate - iceTrigger) * 5, 0, 1);
          const tundra = clamp((climate - (iceTrigger - 0.20)) * 5, 0, 1) * (1 - ice);
          const tropical = clamp(1 - absLat / 0.40, 0, 1);
          const sLat = absLat - 0.27;
          const subtropicalDry = Math.exp(-(sLat * sLat) / 0.018) * (1 - ice) * (1 - tundra);
          const tempD = absLat - 0.50;
          const temperate = Math.exp(-(tempD * tempD) / 0.025) * (1 - ice) * (1 - tundra);
          let mEff = clamp(m - subtropicalDry * 0.55, 0, 1);
          mEff = clamp(mEff + tropical * 0.15, 0, 1);

          // bare ground: coast material, or the DRY altitude ramp (no green)
          let groundCol;
          if (aboveSea < 0.08) {
            const coastNoise = this.perlin2.fbm(x * 3.4 + 130, y * 3.4 + 130, z * 3.4 + 130, 4);
            const speckle = this.perlin3.fbm(x * 20 + 9, y * 20 + 9, z * 20 + 9, 2);
            const rk = clamp(smoothstep(0.045, 0.16, slope) + smoothstep(0.14, 0.42, coastNoise) + speckle * 0.22, 0, 1);
            const coastMat = mixRgb(pal.beach, mixRgb(pal.hills, pal.mountain, 0.35), smoothstep(0.35, 0.65, rk));
            groundCol = (aboveSea < 0.02) ? coastMat : mixRgb(coastMat, mixRgb(pal.arid, pal.hills, 0.25), (aboveSea - 0.02) / 0.06);
          } else {
            const dryLand = mixRgb(pal.arid, pal.hills, smoothstep(0.05, 0.3, aboveSea));
            if (aboveSea < 0.25) groundCol = dryLand;
            else if (aboveSea < 0.45) groundCol = mixRgb(dryLand, pal.hills, (aboveSea - 0.25) / 0.2);
            else if (aboveSea < 0.7) groundCol = mixRgb(pal.hills, pal.mountain, (aboveSea - 0.45) / 0.25);
            else groundCol = mixRgb(pal.mountain, pal.peak, smoothstep(0.7, 0.95, aboveSea));
          }
          if (tundra > 0) groundCol = mixRgb(groundCol, mixRgb(pal.hills, pal.arid, 0.4), tundra * 0.65);
          // organic colour-detail mottling (identical factor applied to veg
          // below, so the composited layers match colorPixelRocky's baked look)
          const cd = this._colorDetail(x, y, z) * grainMul;
          groundCol = [groundCol[0] * cd, groundCol[1] * cd, groundCol[2] * cd];
          put(L.ground, k, grade(groundCol, 1), landMask);

          // vegetation overlay — folds in the classifier's tropical/temperate
          // green tints so the tone matches, and fades the base green with
          // altitude the same way the ground ramp turns lowMid → hills → rock
          // (green lives at low altitude; the alpine belt is the only green above).
          let vegA = 0, vegCol = mixRgb(pal.plains, pal.forest, smoothstep(0.4, 0.85, mEff));
          if (tropical > 0.05 && mEff > 0.4 && aboveSea < 0.4) {
            const deepForest = [pal.forest[0] * 0.65, pal.forest[1] * 1.05, pal.forest[2] * 0.55];
            vegCol = mixRgb(vegCol, deepForest, tropical * smoothstep(0.4, 0.7, mEff) * 0.55);
          }
          if (temperate > 0.05 && mEff > 0.3 && aboveSea < 0.5) {
            const lum = (vegCol[0] + vegCol[1] + vegCol[2]) / 3;
            const muted = [vegCol[0] * 0.88 + lum * 0.12, vegCol[1] * 0.88 + lum * 0.12, vegCol[2] * 0.88 + lum * 0.12];
            vegCol = mixRgb(vegCol, muted, temperate * smoothstep(0.3, 0.6, mEff) * 0.55);
          }
          if (aboveSea >= 0.02) {
            const altVeg = clamp(1 - (aboveSea - 0.25) / 0.20, 0, 1);   // full ≤0.25, gone by 0.45
            vegA = smoothstep(0.3, 0.7, mEff) * (1 - ice) * (1 - 0.65 * tundra) * altVeg;
            if (aboveSea > 0.18 && aboveSea < 0.55 && (1 - tundra - ice) > 0.3) {
              const orographic = clamp(mEff + (aboveSea - 0.18) * 0.6, 0, 1);
              const alpineAmount = smoothstep(0.55, 0.40, aboveSea) * (1 - tundra) * (1 - ice) * smoothstep(0.30, 0.55, orographic) * clamp(1 - subtropicalDry * 0.8, 0, 1);
              if (alpineAmount > 0.05) {
                const conifer = [pal.forest[0] * 0.55 + 35, pal.forest[1] * 0.75 + 25, pal.forest[2] * 0.55 + 30];
                vegCol = mixRgb(vegCol, mixRgb(conifer, pal.forest, tropical * 0.6), 0.5);
                vegA = Math.max(vegA, alpineAmount * 0.65);
              }
            }
            vegA = clamp(vegA * (1 - snowCover) * landMask * vegMul, 0, 1);
          }
          vegCol = [vegCol[0] * cd, vegCol[1] * cd, vegCol[2] * cd];
          put(L.veg, k, grade(vegCol, 2), vegA);
        } else {
          const c0 = this.colorPixelRocky(h, m, lat, cfg, pal, x, y, z, slope);
          let c = [c0[0] * grainMul, c0[1] * grainMul, c0[2] * grainMul];
          // volcanic lava / ice glacial rivers carved by the flow (matches the
          // shader's uRiverStyle branches; water types handle rivers in L.water)
          if (fm && aboveSea >= 0 && (this.type === 'volcanic' || this.type === 'ice')) {
            const flow = sm(fm, uS, vS, 0);
            const th = clamp(0.90 - 0.30 * riverStrength, 0.28, 0.92);
            const rt = smoothstep(th, th + 0.16, flow) * (1 - smoothstep(0.10, 0.26, slope)) * smoothstep(sea, sea + 0.015, h);
            const op = clamp(rt * clamp(0.55 + 0.35 * riverStrength, 0, 1), 0, 1);
            if (op > 0.01) {
              const rc = (this.type === 'volcanic')
                ? mixRgb([191, 41, 8], [255, 158, 41], clamp(flow, 0, 1))
                : mixRgb(pal.shore || [150, 180, 200], [204, 230, 255], clamp(flow, 0, 1));
              c = mixRgb(c, rc, op);
            }
          }
          put(L.ground, k, grade(c, 1), landMask);
          put(L.veg, k, c, 0);
        }

        // ---- SNOW colour ----
        put(L.snow, k, grade(pal.polarIce || [232, 240, 248], 3), snowCover);

        // ---- CLOUDS ----
        let cc = 0;
        if (cm) { const covShift = (cloudCover - 0.5) * 0.55; cc = clamp(clamp(sm(cm, u, v, 0) + covShift, 0, 1) * cloudMul, 0, 1); }
        const ashHere = am ? clamp(sm(am, u, v, 0), 0, 1) : 0;
        const cloudRgb = (ashHere > 0.02) ? mixRgb(cloudCol, ashCol, ashHere) : cloudCol;
        put(L.clouds, k, grade(cloudRgb, 4), cc);
      }
    }
    return L;
  }

  // Apply soft bump shading from height map (used to create height/relief).
  // `strength` scales the bump effect: 0 = flat, 1 = default, 2+ = exaggerated.
  applyBumpShading(cfg, strength = 1.0) {
    const W = this.texW, H = this.texH;
    const heightMap = this.heightMap;
    const colorMap = this.colorMap;
    const iceMap = this.iceMap;
    const sea = cfg.seaLevel;
    const k = 1.5 * strength;

    for (let j = 1; j < H - 1; j++) {
      // Compensate for longitude squashing near the poles: the U-direction
      // gradient must be scaled by cos(lat) because adjacent U-pixels at
      // high latitudes represent nearly the same physical point on the
      // sphere. Without this, every pixel of horizontal noise variance
      // becomes a huge apparent slope at the pole, producing radial
      // starburst artifacts.
      const lat = ((j + 0.5) / H - 0.5) * Math.PI;
      const cosLat = Math.max(0.05, Math.cos(lat));
      const kx = k * cosLat;  // attenuates dx contribution at high latitudes
      const ky = k;
      for (let i = 0; i < W; i++) {
        const im = (i - 1 + W) % W;
        const ip = (i + 1) % W;
        const c = heightMap[j * W + i];
        // Skip water (mostly flat) — but small shimmer ok
        const isWater = c < sea;
        // Polar ice mask — where the ice cap is opaque, suppress bump
        // shading entirely. A thick ice sheet visually flattens the
        // underlying terrain bumpiness; without this suppression, the
        // heightmap noise would print radial streaks through the cap
        // because of equirectangular distortion at the pole.
        const ice = iceMap ? iceMap[j * W + i] : 0;
        const bumpAttenuation = 1 - ice;
        const dx = heightMap[j * W + ip] - heightMap[j * W + im];
        const dy = heightMap[(j + 1) * W + i] - heightMap[(j - 1) * W + i];
        // light from upper-left
        let shade = 0.5 - dx * kx * bumpAttenuation - dy * ky * bumpAttenuation;
        shade = clamp(shade, 0, 1);
        // mix shading: 0.5 = neutral, <0.5 darkens, >0.5 brightens.
        // For ice pixels, attenuate the deviation from neutral so the
        // surface reads as smooth.
        const baseFactor = isWater ? 0.92 + shade * 0.16 : 0.7 + shade * 0.6;
        const factor = 1 + (baseFactor - 1) * bumpAttenuation;
        const idx = (j * W + i) * 3;
        colorMap[idx]     = clamp(colorMap[idx]     * factor, 0, 255);
        colorMap[idx + 1] = clamp(colorMap[idx + 1] * factor, 0, 255);
        colorMap[idx + 2] = clamp(colorMap[idx + 2] * factor, 0, 255);
      }
    }
  }

  // Gas giant — banded with turbulence + storms
  generateGasTexture(cfg, storms, nOffX, nOffY, nOffZ) {
    const W = this.texW, H = this.texH;
    const colorMap = this.colorMap;
    const cloudMap = this.cloudMap;
    const heightMap = this.heightMap;

    const palette = this.palette;
    const bands = palette.bands;

    for (let j = 0; j < H; j++) {
      const lat = ((j + 0.5) / H) * Math.PI - Math.PI / 2;
      const cosLat = Math.cos(lat);
      const sinLat = Math.sin(lat);
      for (let i = 0; i < W; i++) {
        const lon = ((i + 0.5) / W) * 2 * Math.PI;
        const x = cosLat * Math.cos(lon);
        const y = sinLat;
        const z = cosLat * Math.sin(lon);

        // Domain-warp by perlin (creates the swirl)
        const warpY = this.perlin.fbm(x*1.8 + nOffX, y*1.8 + nOffY, z*1.8 + nOffZ, 4) * cfg.turbulence;
        const warpX = this.perlin2.fbm(x*1.2 + nOffY, y*1.2 + nOffZ, z*1.2 + nOffX, 4) * cfg.turbulence * 0.5;

        // banded latitude sample
        const bandY = sinLat + warpY;  // distorted latitude
        // map bandY (-1..1) onto color bands
        let bandT = (bandY + 1) * 0.5 * cfg.bandFreq;
        // Mathematical modulo — domain warping can drive bandT negative,
        // and JS's % keeps the sign, which would index bands[-1] and explode.
        bandT = ((bandT % bands.length) + bands.length) % bands.length;
        const bi = Math.floor(bandT);
        const bf = bandT - bi;
        // Smoothstep between band colors
        const c0 = bands[bi];
        const c1 = bands[(bi + 1) % bands.length];
        let col = mixRgb(c0, c1, smoothstep(0.3, 0.7, bf));

        // Fine swirls within bands
        const swirl = this.perlin3.fbm(x*5 + warpX*5, y*15, z*5, 4);
        col = mixRgb(col, palette.cloud, clamp(swirl * 0.6, -0.2, 0.4));

        // Brown dwarf — show hot interior glow where the upper cloud deck
        // is thinnest. We sample a separate "thinness" noise: where it's
        // high, the dark cloud opacity drops and we see the bright
        // incandescent layer below. Combined with the band pattern so the
        // glow runs in horizontal bands matching the cloud structure.
        if (palette.glow) {
          // Thinness comes from another noise band — concentrate around
          // band centers to show "rifts" in the cloud cover.
          const bandCenter = Math.abs(bf - 0.5);  // 0 at band center, 0.5 at edge
          const thinNoise = this.perlin3.fbm(x*3 + 17, y*8 + 17, z*3 + 17, 3);
          // Combine: band-centered + noise. Hot rifts appear where both align.
          const rift = clamp((1 - bandCenter * 2) + thinNoise * 0.6, 0, 1.6);
          if (rift > 0.6) {
            // Hot interior color — interpolate from glow → glowHot for the
            // brightest spots. Apply on top of the cloud band color.
            const heat = smoothstep(0.6, 1.4, rift);
            const veryHot = smoothstep(1.0, 1.5, rift);
            const glowCol = mixRgb(palette.glow, palette.glowHot, veryHot);
            col = mixRgb(col, glowCol, heat);
          }
        }

        // Storms — elliptical regions
        for (let s = 0; s < storms.length; s++) {
          const st = storms[s];
          const dLat = lat - st.lat;
          let dLon = lon - st.lon;
          if (dLon > Math.PI) dLon -= 2 * Math.PI;
          if (dLon < -Math.PI) dLon += 2 * Math.PI;
          const dist = (dLat / st.rLat) * (dLat / st.rLat) + (dLon / st.rLon) * (dLon / st.rLon);
          if (dist < 1.0) {
            const inner = 1 - dist;
            const t = smoothstep(0, 0.5, inner) * st.intensity;
            // swirl inside the storm
            const stSwirl = this.perlin3.fbm((dLon)*8, (dLat)*8, 0, 3);
            const stCol = mixRgb(palette.storm, palette.cloud, stSwirl * 0.5 + 0.5);
            col = mixRgb(col, stCol, t);
          }
        }

        // Heightmap (used for subtle 3d-band shading)
        heightMap[j * W + i] = swirl * 0.3 + warpY;
        cloudMap[j * W + i] = 0;  // gas giants: clouds baked in

        const idx = (j * W + i) * 3;
        colorMap[idx]     = clamp(col[0], 0, 255);
        colorMap[idx + 1] = clamp(col[1], 0, 255);
        colorMap[idx + 2] = clamp(col[2], 0, 255);
      }
    }
  }

  // ----- COMPUTE PHYSICAL ATTRIBUTES -----
  computeAttributes() {
    const r = () => this.rng();
    const t = this.type;
    const sz = this.size;

    // Radius in km
    let radiusKm;
    if (t === 'gas_giant')        radiusKm = 40000 + sz * 60000 + r() * 20000;
    else if (t === 'ice_giant')   radiusKm = 18000 + sz * 35000 + r() * 8000;
    else if (t === 'brown_dwarf') radiusKm = 65000 + sz * 25000 + r() * 15000;  // ~Jupiter to slightly larger
    else if (t === 'dwarf_planet')radiusKm = 200 + sz * 1200 + r() * 400;       // 200-1800 km
    else if (t === 'asteroid')    radiusKm = 5 + sz * 250 + r() * 80;           // 5-330 km
    else                          radiusKm = 600 + sz * 8000 + r() * 1500;

    // Density (g/cm³) and gravity
    let density;
    if (t === 'gas_giant')        density = 0.6 + r() * 1.0;
    else if (t === 'ice_giant')   density = 1.2 + r() * 0.6;
    else if (t === 'brown_dwarf') density = 30 + r() * 50;       // very high — degenerate matter
    else if (t === 'ice')         density = 1.5 + r() * 0.5;
    else if (t === 'volcanic')    density = 4.5 + r() * 1.2;
    else if (t === 'dwarf_planet')density = 1.6 + r() * 0.8;     // mix of ice & rock
    else if (t === 'asteroid')    density = 2.0 + r() * 4.0;     // varies wildly by composition
    else                          density = 3.5 + r() * 2.0;

    // Mass relative to Earth
    const re = 6371;  // earth radius
    const massE = Math.pow(radiusKm / re, 3) * (density / 5.51);
    const gravity = (massE / Math.pow(radiusKm / re, 2)) * 9.81;

    // Day length
    const dayHrs = (t === 'gas_giant' || t === 'ice_giant' || t === 'brown_dwarf')
      ? 6 + r() * 14
      : (t === 'asteroid')
        ? 2 + r() * 30   // short rotational periods, sometimes very fast
        : 8 + r() * 80;

    // Surface temperature
    let temp;  // celsius, mean surface
    if (t === 'volcanic')        temp = 400 + r() * 600;
    else if (t === 'ice')        temp = -150 + r() * 60;
    else if (t === 'desert')     temp = -20 + r() * 80;
    else if (t === 'cratered')   temp = -180 + r() * 220;
    else if (t === 'ocean')      temp = -10 + r() * 35;
    else if (t === 'gas_giant')  temp = -150 + r() * 100;
    else if (t === 'ice_giant')  temp = -200 + r() * 60;
    else if (t === 'brown_dwarf')temp = 700 + r() * 1800;     // 700-2500 °C — they glow
    else if (t === 'dwarf_planet')temp = -230 + r() * 100;    // very cold (Pluto ~-230)
    else if (t === 'asteroid')   temp = -200 + r() * 250;     // depends on orbit
    else                         temp = -30 + r() * 60; // terrestrial

    // Pressure (atm) by atmosphere thickness
    let pressureAtm;
    switch (this.atmosphere) {
      case 'none':  pressureAtm = r() * 0.001; break;
      case 'thin':  pressureAtm = 0.01 + r() * 0.4; break;
      case 'thick': pressureAtm = 0.6 + r() * 1.8; break;
      case 'dense': pressureAtm = 2 + r() * 90; break;
      default:      pressureAtm = 1;
    }
    if (t === 'gas_giant' || t === 'ice_giant') pressureAtm = 1000 + r() * 9000;

    // Albedo
    const albedo = (t === 'ice') ? 0.55 + r() * 0.3
      : (t === 'volcanic') ? 0.05 + r() * 0.1
      : (t === 'cratered') ? 0.08 + r() * 0.18
      : (t === 'desert') ? 0.25 + r() * 0.2
      : (t === 'ocean') ? 0.15 + r() * 0.1
      : (t === 'gas_giant') ? 0.4 + r() * 0.2
      : (t === 'ice_giant') ? 0.5 + r() * 0.15
      : 0.25 + r() * 0.2;

    // Atmospheric composition
    const composition = this.computeComposition();

    // Notable features
    const features = this.computeFeatures();

    // Detected resources
    const resources = this.computeResources();

    // Habitability score
    const hab = this.computeHabitability(temp, pressureAtm, t);

    return {
      designation: this.config.seed.toString().toUpperCase(),
      radiusKm, massE, gravity, dayHrs,
      tempC: temp, pressureAtm, albedo, composition, features, resources,
      habitability: hab,
    };
  }

  computeComposition() {
    const t = this.type;
    const r = () => this.rng();
    if (t === 'gas_giant' || t === 'ice_giant') {
      const h = 70 + r() * 20;
      const he = (100 - h) * (0.7 + r() * 0.25);
      const rest = 100 - h - he;
      return [
        { name: 'H₂', pct: h.toFixed(1), col: '#4ad6c4' },
        { name: 'He', pct: he.toFixed(1), col: '#ffaa44' },
        { name: 'CH₄/NH₃', pct: rest.toFixed(1), col: '#ff5c8a' },
      ];
    }
    if (this.atmosphere === 'none') {
      return [{ name: 'TRACE', pct: '100', col: '#5a6e72' }];
    }
    // pick a profile
    const profile = Math.floor(r() * 4);
    if (profile === 0) {
      // Earth-like
      const n = 65 + r() * 15;
      const o = 18 + r() * 8;
      const co2 = r() * 5;
      const rest = 100 - n - o - co2;
      return [
        { name: 'N₂', pct: n.toFixed(1), col: '#4ad6c4' },
        { name: 'O₂', pct: o.toFixed(1), col: '#5cff8a' },
        { name: 'CO₂', pct: co2.toFixed(2), col: '#ffaa44' },
        { name: 'Ar/Other', pct: rest.toFixed(1), col: '#ff5c8a' },
      ];
    }
    if (profile === 1) {
      // CO2-dominated (Venus/Mars-like)
      const co2 = 88 + r() * 10;
      const n = (100 - co2) * 0.6;
      const rest = 100 - co2 - n;
      return [
        { name: 'CO₂', pct: co2.toFixed(1), col: '#ffaa44' },
        { name: 'N₂', pct: n.toFixed(1), col: '#4ad6c4' },
        { name: 'SO₂/Other', pct: rest.toFixed(1), col: '#ff5c8a' },
      ];
    }
    if (profile === 2) {
      // Methane/sulfur
      const ch = 35 + r() * 30;
      const so = 20 + r() * 25;
      const n = 100 - ch - so;
      return [
        { name: 'CH₄', pct: ch.toFixed(1), col: '#ff5c8a' },
        { name: 'SO₂', pct: so.toFixed(1), col: '#ffaa44' },
        { name: 'N₂', pct: n.toFixed(1), col: '#4ad6c4' },
      ];
    }
    // Reducing
    const h = 25 + r() * 35;
    const n = 30 + r() * 25;
    const rest = 100 - h - n;
    return [
      { name: 'H₂', pct: h.toFixed(1), col: '#4ad6c4' },
      { name: 'N₂', pct: n.toFixed(1), col: '#5cff8a' },
      { name: 'NH₃', pct: rest.toFixed(1), col: '#ff5c8a' },
    ];
  }

  computeFeatures() {
    const t = this.type;
    const r = () => this.rng();
    const features = [];
    const all = {
      terrestrial: ['Continents', 'Oceans', 'Polar Caps', 'Mountain Ranges', 'River Systems',
                    'Forest Belts', 'Coastal Cliffs', 'Mid-Ocean Ridges'],
      ocean: ['Global Ocean', 'Archipelagos', 'Storm Bands', 'Tidal Locks', 'Polar Caps'],
      desert: ['Dune Seas', 'Salt Flats', 'Wind Carved Mesas', 'Dust Storms', 'Dry Riverbeds'],
      ice: ['Ice Sheets', 'Crevasse Fields', 'Frozen Methane Lakes', 'Ridged Plains', 'Glacial Flows'],
      volcanic: ['Lava Lakes', 'Active Volcanoes', 'Sulfur Plains', 'Magma Channels', 'Pyroclastic Belts'],
      cratered: ['Impact Basins', 'Rille Networks', 'Ejecta Rays', 'Regolith Plains', 'Crater Chains'],
      gas_giant: ['Banded Atmosphere', 'Anticyclonic Storms', 'Jet Streams', 'Aurora Belts', 'Ring System'],
      ice_giant: ['Smooth Cloud Decks', 'Methane Storms', 'Diamond Rain', 'Ring Arcs', 'Polar Vortex'],
      dwarf_planet: ['Tholin Plains', 'Nitrogen Glaciers', 'Cryovolcanic Vents', 'Impact Basins',
                     'Bright Albedo Spots', 'Methane Frost', 'Sublimation Pits'],
      asteroid: ['Regolith Coating', 'Impact Pits', 'Loose Rubble', 'Metal Veins',
                 'Tumbling Rotation', 'Dust Mantle', 'Rilles & Grooves'],
      brown_dwarf: ['Methane Belts', 'Ammonia Storms', 'Lithium Resonance', 'Convective Cells',
                    'Hot Spots', 'Cloud Holes', 'Differential Rotation'],
    };
    const pool = all[t] || all.terrestrial;
    const n = 3 + Math.floor(r() * 2);
    const shuffled = [...pool].sort(() => r() - 0.5);
    return shuffled.slice(0, n);
  }

  // Detected resources by planet type — speculative-realism mix of bulk
  // industrial materials, rare metals, gases, and exotic compounds. Each
  // entry has {name, level} where level is 'TRACE' / 'MODERATE' / 'ABUNDANT' / 'RICH'.
  computeResources() {
    const t = this.type;
    const r = () => this.rng();
    const levels = ['TRACE', 'MODERATE', 'ABUNDANT', 'RICH'];
    const pickLevel = () => {
      const x = r();
      if (x < 0.40) return levels[0];
      if (x < 0.75) return levels[1];
      if (x < 0.93) return levels[2];
      return levels[3];
    };
    const pools = {
      terrestrial: ['Iron', 'Silicates', 'Fresh Water', 'Hydrocarbons', 'Rare Earths',
                    'Copper', 'Lithium', 'Uranium', 'Gold', 'Biomass', 'Helium-3'],
      ocean:       ['Hydrogen', 'Deuterium', 'Halophilic Biomass', 'Salts', 'Methane Clathrates',
                    'Sulfur Compounds', 'Dissolved Metals', 'Helium-3'],
      desert:      ['Iron Oxide', 'Silica', 'Rare Earths', 'Phosphates', 'Subsurface Ice',
                    'Uranium', 'Thorium', 'Gold', 'Solar Yield'],
      ice:         ['Water Ice', 'Methane Ice', 'Ammonia', 'Nitrogen Ice', 'Hydrogen',
                    'Subglacial Saltwater', 'Volatiles', 'Helium-3'],
      volcanic:    ['Sulfur', 'Basalt', 'Rare Earths', 'Geothermal Yield', 'Heavy Metals',
                    'Iridium', 'Platinum Group', 'Magma Glass', 'Tellurium'],
      cratered:    ['Iron-Nickel', 'Regolith', 'Helium-3', 'Platinum Group', 'Iridium',
                    'Silicates', 'Solar Yield', 'Rare Earths'],
      gas_giant:   ['Hydrogen', 'Helium', 'Helium-3', 'Methane', 'Ammonia',
                    'Atmospheric Diamonds', 'Deuterium', 'Tritium'],
      ice_giant:   ['Methane', 'Hydrogen', 'Ammonia', 'Helium-3', 'Water Ice',
                    'Atmospheric Diamonds', 'Deuterium', 'Tholins'],
      dwarf_planet:['Water Ice', 'Methane Ice', 'Tholins', 'Nitrogen Ice',
                    'Carbonates', 'Silicates', 'Volatiles', 'Helium-3'],
      asteroid:    ['Iron-Nickel', 'Platinum Group', 'Silicates', 'Cobalt',
                    'Rare Earths', 'Iridium', 'Carbonaceous Chondrites', 'Olivine',
                    'Hydrated Minerals', 'Gold'],
      brown_dwarf: ['Hydrogen', 'Lithium', 'Helium', 'Helium-3', 'Methane',
                    'Deuterium', 'Tritium', 'Heavy Metal Vapor'],
    };
    const pool = pools[t] || pools.terrestrial;
    const n = 4 + Math.floor(r() * 3);  // 4..6 resources
    const shuffled = [...pool].sort(() => r() - 0.5).slice(0, n);
    return shuffled.map(name => ({ name, level: pickLevel() }));
  }

  computeHabitability(temp, press, type) {
    if (type === 'gas_giant' || type === 'ice_giant') return 'NIL';
    if (type === 'brown_dwarf') return 'EXTREME';
    if (type === 'volcanic') return temp > 200 ? 'HOSTILE' : 'EXTREME';
    if (type === 'cratered' || type === 'asteroid') return 'BARREN';
    if (type === 'dwarf_planet') return 'BARREN';
    let score = 0;
    if (temp >= -10 && temp <= 40) score += 40;
    else if (temp >= -50 && temp <= 80) score += 15;
    if (press >= 0.4 && press <= 3) score += 30;
    else if (press >= 0.1 && press <= 10) score += 10;
    if (type === 'terrestrial') score += 30;
    else if (type === 'ocean') score += 20;
    else if (type === 'ice') score += 5;
    else if (type === 'desert') score += 10;
    if (score >= 80) return 'HIGH';
    if (score >= 55) return 'MODERATE';
    if (score >= 30) return 'MARGINAL';
    return 'HOSTILE';
  }
}

export { Planet };
