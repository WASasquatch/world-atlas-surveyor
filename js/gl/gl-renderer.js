// GLRenderer — WebGL2 (Three.js) drop-in replacement for the CPU Renderer.
// Same public API (setPlanet / resize / render / sun fields / canvas /
// starsCanvas), same visual conventions, plus: HDR rendering with bloom,
// sun-relative bump lighting, Fresnel water glints, live gas-giant flow
// simulation, GG-warped clouds, and real-time terraform uniforms.
//
// Pipeline: planet impostor shader -> low-res HDR target (internal
// resolution keeps the chunky pixel aesthetic) -> bright pass -> two
// separable blur passes -> composite (bloom + mild tonemap) to the canvas
// with NEAREST upscaling. The starfield stays on the 2D starsCanvas behind,
// reusing the CPU renderer's starfield implementation wholesale.

import * as THREE from '../vendor/three.module.min.js';
import { Renderer as CpuRenderer } from '../renderer.js';
import { PLANET_VERT, PLANET_FRAG } from './planet-shader.js';
import { GasGiantSim } from './gas-giant-sim.js';
import { Quality } from '../core/quality.js';

const TEX_W = 768, TEX_H = 384;

const QUAD_VERT = /* glsl */ `
in vec3 position;
in vec2 uv;
out vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const BRIGHT_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv; out vec4 outColor;
uniform sampler2D uScene;
uniform float uThreshold;
void main() {
  vec4 s = texture(uScene, vUv);
  float lum = dot(s.rgb, vec3(0.2126, 0.7152, 0.0722));
  float k = smoothstep(uThreshold, uThreshold + 0.4, lum);
  outColor = vec4(s.rgb * k * s.a, 1.0);
}
`;

const BLUR_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv; out vec4 outColor;
uniform sampler2D uSrc;
uniform vec2 uDir;
void main() {
  vec3 sum = texture(uSrc, vUv).rgb * 0.227027;
  vec2 off1 = uDir * 1.3846153846;
  vec2 off2 = uDir * 3.2307692308;
  sum += texture(uSrc, vUv + off1).rgb * 0.3162162162;
  sum += texture(uSrc, vUv - off1).rgb * 0.3162162162;
  sum += texture(uSrc, vUv + off2).rgb * 0.0702702703;
  sum += texture(uSrc, vUv - off2).rgb * 0.0702702703;
  outColor = vec4(sum, 1.0);
}
`;

const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv; out vec4 outColor;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform float uBloomStrength;
void main() {
  vec4 s = texture(uScene, vUv);
  vec3 bloom = texture(uBloom, vUv).rgb * uBloomStrength;
  vec3 c = s.rgb + bloom;
  // gentle filmic shoulder — keeps the retro palette, tames HDR glints
  c = c / (1.0 + max(c - 1.0, 0.0) * 0.55);
  float a = clamp(s.a + dot(bloom, vec3(0.333)), 0.0, 1.0);
  outColor = vec4(c, a);
}
`;

function dataTexR(f32, w = TEX_W, h = TEX_H) {
  const half = new Uint16Array(f32.length);
  for (let i = 0; i < f32.length; i++) half[i] = THREE.DataUtils.toHalfFloat(f32[i]);
  const t = new THREE.DataTexture(half, w, h, THREE.RedFormat, THREE.HalfFloatType);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

function dataTexRGB(u8rgb, w = TEX_W, h = TEX_H) {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0, j = 0; i < u8rgb.length; i += 3, j += 4) {
    rgba[j] = u8rgb[i]; rgba[j + 1] = u8rgb[i + 1]; rgba[j + 2] = u8rgb[i + 2]; rgba[j + 3] = 255;
  }
  const t = new THREE.DataTexture(rgba, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

const BLACK_F32 = new Float32Array(4);
function tinyTex() { return dataTexR(BLACK_F32, 2, 2); }

const v3 = (rgb, fallback) => {
  const c = rgb || fallback;
  return new THREE.Vector3(c[0] / 255, c[1] / 255, c[2] / 255);
};

class GLRenderer {
  static isSupported() {
    try {
      const c = document.createElement('canvas');
      return !!c.getContext('webgl2');
    } catch { return false; }
  }

  constructor(canvas, starsCanvas) {
    this.canvas = canvas;
    this.starsCanvas = starsCanvas;
    this.planet = null;
    this.rotation = 0;
    this.frame = 0;
    this.lastFrameMs = 0;
    this.autoRotate = true;
    this.pixelScale = 3;
    this.viewW = 0; this.viewH = 0;
    this.internalW = 2; this.internalH = 2;
    this.sunAz = -28; this.sunEl = 18; this.viewTilt = 0;
    this.sunIntensity = 100; this.sunHue = 0;
    this.gasSim = null;
    this.starTime = 0;

    // terraform state (uniform mirror; null field = use baked default)
    this.terraform = {
      enabled: false, seaLevel: 0, iceLine: 0.65, vegetation: 1,
      cloudMul: 1, cloudCover: 0.5, cloudFlow: 1.0, evolveAmp: 0, evolve: 0, atmScale: 1,
      cloudAltLow: 0.03, cloudAltMid: 0.06, cloudAltHigh: 0.10, cloudAmtLow: 1.0, cloudAmtMid: 0.7, cloudAmtHigh: 0.5,
      cloudScatter: 0.6, cloudSeed: 0, atmDensity: 1,
      flowMul: 1, churn: 1, emission: 1, aurora: 1, snowOffset: 0, gasDensity: 1, riverStrength: 1,
    };
    this.flowChurn = 1;
    this.capturing = false;

    this.gl = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: false,
      premultipliedAlpha: false,     // straight alpha, like the CPU renderer
      preserveDrawingBuffer: true,   // export card reads the canvas
      powerPreference: 'high-performance',
    });
    this.gl.autoClear = false;
    // raw shaders own all color math — keep three's pipeline pass-through
    this.gl.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.gl.setClearColor(0x000000, 0);

    // starfield: reuse the CPU renderer's implementation against a dummy
    // planet canvas — starsCanvas is the shared visible layer
    this.stars = new CpuRenderer(document.createElement('canvas'), starsCanvas);

    // fullscreen quad scene shared by all passes
    this.scene = new THREE.Scene();
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const geo = new THREE.PlaneGeometry(2, 2);

    const mkMat = (frag, uniforms, vert = QUAD_VERT) => new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: vert,
      fragmentShader: frag,
      uniforms,
      depthTest: false,
      depthWrite: false,
      transparent: false,
    });

    this.emptyTex = tinyTex();
    const empty = this.emptyTex;
    this.u = {
      uResolution: { value: new THREE.Vector2(2, 2) },
      uRadius: { value: 1 },
      uCenter: { value: new THREE.Vector2(1, 1) },
      uCosT: { value: 1 }, uSinT: { value: 0 },
      uCosTilt: { value: 1 }, uSinTilt: { value: 0 },
      uRotation: { value: 0 },
      uAuroraTime: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0, 0, 1) },
      uSunColor: { value: new THREE.Vector3(1, 1, 1) },
      uSunFalloff: { value: 1 },
      uAtmThickness: { value: 0 },
      uAtmDensity: { value: 1 },
      uAtmColor: { value: new THREE.Vector3(0.47, 0.7, 0.86) },
      uKindGas: { value: 0 },
      uSelfEmit: { value: 0 },
      uSeaLevel: { value: -10 },
      uCfgSeaLevel: { value: -10 },
      uRelief: { value: 1 },
      uLavaGlow: { value: 0 },
      uHasAsh: { value: 0 },
      uAshCloud: { value: new THREE.Vector3(0.23, 0.18, 0.14) },
      uAuroraOn: { value: 0 },
      uAuroraColor: { value: new THREE.Vector3(0, 1, 0.5) },
      uAuroraBase: { value: 0 },
      uCloudColor: { value: new THREE.Vector3(1, 1, 1) },
      uHasClouds: { value: 0 },
      uCloudShift: { value: 0 },
      uHasWaterMask: { value: 0 },
      uAlbedoTex: { value: empty },
      uHeightTex: { value: empty },
      uCloudTex: { value: empty },
      uIceTex: { value: empty },
      uAshTex: { value: empty },
      uWaterTex: { value: empty },
      uShapeTex: { value: empty },
      uMoistTex: { value: empty },
      uHasShape: { value: 0 },
      uMaxShapeR: { value: 1 },
      uGasTex: { value: empty },
      uUseGasTex: { value: 0 },
      uVortexStrength: { value: 1 },
      uFlowTime: { value: 0 },
      uCloudSeed: { value: 0 },
      uEmission: { value: 1 },
      uGlowCol: { value: new THREE.Vector3(1, 0.5, 0.22) },
      uGlowHot: { value: new THREE.Vector3(1, 0.82, 0.47) },
      uAuroraStrength: { value: 1 },
      uSnowOffset: { value: 0 },
      uFlowTex: { value: empty },
      uHasRivers: { value: 0 },
      uRiverStrength: { value: 1 },
      uSurfaceMode: { value: 0 },
      uGradientLut: { value: empty },
      uHasGradient: { value: 0 },
      uGradientMix: { value: 1 },
      uGradientScale: { value: 1 },
      // per surface-class gradient targeting (0 water,1 rock,2 veg,3 ice,4 gas)
      uGradEnable: { value: [1, 1, 1, 1, 1] },
      uGradLo: { value: [0, 0, 0, 0, 0] },
      uGradHi: { value: [1, 1, 1, 1, 1] },
      uTerraform: { value: 0 },
      uIceLine: { value: 0.65 },
      uVegetation: { value: 1 },
      uCloudMul: { value: 1 },
      uCloudCover: { value: 0.5 },   // COVERAGE (area), 0.5 = baseline
      uCloudFlow: { value: 1.0 },    // subtle GG-flow warp on clouds by default
      // multi-deck clouds: LOW cumulus / MID banks / HIGH cirrus
      uCloudAltLow: { value: 0.03 }, uCloudAltMid: { value: 0.06 }, uCloudAltHigh: { value: 0.10 },
      uCloudAmtLow: { value: 1.0 }, uCloudAmtMid: { value: 0.7 }, uCloudAmtHigh: { value: 0.5 },
      uCloudScatter: { value: 0.6 },
      uEvolve: { value: 0 },
      uEvolveAmp: { value: 0 },
      uQCloudOct: { value: 3 },
      uQCloudWarp: { value: 2 },
      uQEvolveOct: { value: 3 },
      uQAuroraDetail: { value: 1 },
      uQTerrainOct: { value: 3 },
      uQFloe: { value: 1 },
      uPalDeepWater: { value: new THREE.Vector3() }, uPalWater: { value: new THREE.Vector3() },
      uPalShore: { value: new THREE.Vector3() }, uPalBeach: { value: new THREE.Vector3() },
      uPalLowland: { value: new THREE.Vector3() }, uPalPlains: { value: new THREE.Vector3() },
      uPalForest: { value: new THREE.Vector3() }, uPalArid: { value: new THREE.Vector3() },
      uPalHills: { value: new THREE.Vector3() }, uPalMountain: { value: new THREE.Vector3() },
      uPalPeak: { value: new THREE.Vector3() }, uPalPolarIce: { value: new THREE.Vector3() },
    };
    this.planetMat = mkMat(PLANET_FRAG, this.u, PLANET_VERT);

    this.brightMat = mkMat(BRIGHT_FRAG, {
      uScene: { value: null }, uThreshold: { value: 0.85 },
    });
    this.blurMat = mkMat(BLUR_FRAG, {
      uSrc: { value: null }, uDir: { value: new THREE.Vector2() },
    });
    this.compositeMat = mkMat(COMPOSITE_FRAG, {
      uScene: { value: null }, uBloom: { value: null }, uBloomStrength: { value: 0.55 },
    });

    this.quad = new THREE.Mesh(geo, this.planetMat);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);

    this.sceneRT = null; this.bloomA = null; this.bloomB = null;
    this.textures = [];
    this.bloomEnabled = true;
    Quality.onChange(() => this.applyQuality());
  }

  // ---------- lifecycle ----------

  setPlanet(planet) {
    this.planet = planet;
    this.rotation = planet.rotation;
    this.frame = 0;
    this.stars.planet = planet;
    if (this.stars.viewW > 0) this.stars.recreateStars();
    this.uploadPlanet(planet);
  }

  resize(viewW, viewH, pixelScale, aa) {
    this.viewW = Math.max(100, Math.floor(viewW));
    this.viewH = Math.max(100, Math.floor(viewH));
    this.pixelScale = pixelScale;
    if (aa != null) this.aa = aa;
    const ss = this.aa || 1;   // supersample factor (anti-aliasing)
    const q = Quality.get();
    this.internalW = Math.max(50, Math.floor(this.viewW / pixelScale * q.resScale * ss));
    this.internalH = Math.max(50, Math.floor(this.viewH / pixelScale * q.resScale * ss));
    this.bloomEnabled = q.bloom;

    this.gl.setPixelRatio(1);
    this.gl.setSize(this.internalW, this.internalH, false);
    this.canvas.style.width = this.viewW + 'px';
    this.canvas.style.height = this.viewH + 'px';

    const mk = (w, h) => new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: false, stencilBuffer: false,
    });
    for (const rt of [this.sceneRT, this.bloomA, this.bloomB]) rt && rt.dispose();
    this.sceneRT = mk(this.internalW, this.internalH);
    const bw = Math.max(8, this.internalW >> 1), bh = Math.max(8, this.internalH >> 1);
    this.bloomA = mk(bw, bh);
    this.bloomB = mk(bw, bh);

    this.u.uResolution.value.set(this.internalW, this.internalH);

    // stars layer at full viewport resolution (CPU implementation)
    this.stars.resize(this.viewW, this.viewH, pixelScale);
  }

  // push the current quality tier's per-fragment budgets to the shader
  _setQualityUniforms() {
    const q = Quality.get(), u = this.u;
    u.uQCloudOct.value = q.cloudOct;
    u.uQCloudWarp.value = q.cloudWarp;
    u.uQEvolveOct.value = q.evolveOct;
    u.uQAuroraDetail.value = q.auroraDetail;
    u.uQTerrainOct.value = q.terrainOct;
    u.uQFloe.value = q.floe;
  }

  // live tier change: reapply budgets, rebuild RTs (resScale/bloom) and the
  // gas sim at the new resolution
  applyQuality() {
    this._setQualityUniforms();
    if (this.viewW > 0) this.resize(this.viewW, this.viewH, this.pixelScale);
    if (this._isGasKind && this.planet) {
      const q = Quality.get();
      if (this.gasSim) this.gasSim.dispose();
      this.gasSim = new GasGiantSim(this.gl, this.planet, { simW: q.simW, simH: q.simH, bandColors: this._gasBandVecs() });
      // preserve all live flow state across the tier rebuild
      this.gasSim.setVortex(this.terraform.flowMul ?? 1);
      this.gasSim.setDensity(this.terraform.gasDensity ?? 1);
      if (this.terraform.gasScale != null) this.gasSim.setScale(this.terraform.gasScale);
      if (this.terraform.gasTurb != null) this.gasSim.setTurbulence(this.terraform.gasTurb);
      if (this.terraform.gasDetail != null) this.gasSim.setDetail(this.terraform.gasDetail);
      this.u.uGasTex.value = this.gasSim.texture;
      this.u.uUseGasTex.value = 1;
    }
  }

  // ---------- planet texture upload ----------

  uploadPlanet(planet) {
    for (const t of this.textures) t.dispose();
    this.textures = [];
    if (this.gasSim) { this.gasSim.dispose(); this.gasSim = null; }
    const u = this.u;
    const cfg = planet.getTypeConfig();
    const pal = planet.palette || {};
    const isGasKind = cfg.kind === 'gas';

    const keep = (t) => { this.textures.push(t); return t; };

    // albedo: rocky types use the unshaded rawColorMap (bump is done live,
    // sun-relative, in-shader); gas kinds use the fully baked colorMap
    const albSrc = (!isGasKind && planet.rawColorMap) ? planet.rawColorMap : planet.colorMap;
    u.uAlbedoTex.value = keep(dataTexRGB(albSrc));
    u.uHeightTex.value = keep(dataTexR(planet.heightMap));
    u.uCloudTex.value = keep(dataTexR(planet.cloudMap));
    u.uIceTex.value = keep(dataTexR(planet.iceMap));
    u.uMoistTex.value = planet.moistureMap ? keep(dataTexR(planet.moistureMap)) : this.emptyTex;
    u.uAshTex.value = planet.ashMap ? keep(dataTexR(planet.ashMap)) : this.emptyTex;
    u.uWaterTex.value = planet.waterMaskMap ? keep(dataTexR(planet.waterMaskMap)) : this.emptyTex;
    u.uFlowTex.value = planet.flowMap ? keep(dataTexR(planet.flowMap)) : this.emptyTex;
    u.uHasRivers.value = planet.flowMap ? 1 : 0;
    u.uHasAsh.value = planet.ashMap ? 1 : 0;
    // The CPU reference restricts water specular to terrestrial/ocean;
    // volcanic keeps the mask for its lava-glow path. Primordial and others
    // must NOT get ocean glints even though they bake a water mask.
    const specTypes = planet.type === 'terrestrial' || planet.type === 'ocean' || planet.type === 'volcanic';
    u.uHasWaterMask.value = (planet.waterMaskMap && specTypes) ? 1 : 0;

    u.uHasShape.value = planet.shapeMap ? 1 : 0;
    u.uMaxShapeR.value = planet.maxShapeR || 1;
    u.uShapeTex.value = planet.shapeMap ? keep(dataTexR(planet.shapeMap)) : this.emptyTex;

    u.uKindGas.value = isGasKind ? 1 : 0;
    u.uSelfEmit.value = cfg.selfEmit ? 1 : 0;
    u.uLavaGlow.value = (planet.type === 'volcanic' && planet.waterMaskMap) ? 1 : 0;
    u.uSeaLevel.value = cfg.seaLevel;
    u.uCfgSeaLevel.value = cfg.seaLevel;

    u.uAtmColor.value = v3(pal.atmCol, [120, 180, 220]);
    u.uAshCloud.value = v3(pal.ashCloud, [60, 45, 35]);
    u.uCloudColor.value = v3(pal.cloudCol, [255, 255, 255]);
    u.uHasClouds.value = (!isGasKind && pal.cloudCol) ? 1 : 0;
    u.uGlowCol.value = v3(pal.glow, [255, 128, 56]);
    u.uGlowHot.value = v3(pal.glowHot, [255, 208, 120]);
    // base cloud seed is unique per world; the CLOUD SEED slider adds an offset
    // so the pattern can be re-rolled without regenerating the planet.
    this._cloudSeedBase = ((planet.seedNum >>> 0) % 997) * 0.0137;
    u.uCloudSeed.value = this._cloudSeedBase;

    const atmLevels = { none: 0, thin: 0.08, thick: 0.20, dense: 0.36 };
    this.baseAtmThickness = atmLevels[planet.atmosphere] || 0;
    // aurora gating tracks the LIVE atmosphere thickness (terraform ATMO
    // slider), so the enable/strength uniforms are recomputed per frame in
    // render(); only the color and planet facts are fixed here
    this._hasAuroraCol = !!pal.auroraCol;
    this._isGasKind = isGasKind;
    u.uAuroraColor.value = v3(pal.auroraCol, [80, 255, 160]);

    // terraform palette + defaults
    u.uPalDeepWater.value = v3(pal.deepWater, [10, 40, 64]);
    u.uPalWater.value = v3(pal.water, [20, 80, 120]);
    u.uPalShore.value = v3(pal.shore, [60, 120, 150]);
    u.uPalBeach.value = v3(pal.beach, [194, 178, 128]);
    u.uPalLowland.value = v3(pal.lowland, [90, 120, 66]);
    u.uPalPlains.value = v3(pal.plains, [110, 140, 70]);
    u.uPalForest.value = v3(pal.forest, [40, 90, 40]);
    u.uPalArid.value = v3(pal.arid, [160, 140, 90]);
    u.uPalHills.value = v3(pal.hills, [120, 110, 80]);
    u.uPalMountain.value = v3(pal.mountain, [130, 120, 110]);
    u.uPalPeak.value = v3(pal.peak, [220, 220, 220]);
    u.uPalPolarIce.value = v3(pal.polarIce, [235, 245, 250]);
    // re-apply any live custom-colour override on top of the fresh seed palette
    // (gradient uniforms persist on their own — never reset here)
    if (this._palOverride) this._applyPaletteOverride();

    // reset terraform to this planet's baked defaults
    this.terraform.enabled = false;
    this.terraform.seaLevel = cfg.seaLevel;
    this.terraform.iceLine = (cfg.iceLine != null && cfg.iceLine > -1 && cfg.iceLine < 2) ? cfg.iceLine : 0.65;
    this.terraform.vegetation = 1;
    this.terraform.cloudMul = 1;
    this.terraform.cloudCover = 0.5;   // neutral cloud coverage
    this.terraform.cloudFlow = 1.0;    // subtle GG global-current warp
    this.terraform.evolveAmp = 0;
    this.terraform.atmScale = 1;
    this.terraform.flowMul = 1;
    this.terraform.churn = 1;
    this.terraform.gasScale = 1;     // neutral flow-shape defaults (GG controls)
    this.terraform.gasTurb = 0.35;
    this.terraform.gasDetail = 0.5;
    this.terraform.emission = 1;
    this.terraform.aurora = 1;
    this.terraform.snowOffset = 0;
    this.terraform.gasDensity = 1;
    this.terraform.riverStrength = 1;
    this.cfg = cfg;

    // Live flow for ALL gas kinds — gas/ice giants AND brown dwarfs (whose
    // hot-rift streaks ride the same advected dye). Sim resolution follows
    // the quality tier.
    if (isGasKind) {
      const q = Quality.get();
      this.gasSim = new GasGiantSim(this.gl, planet, { simW: q.simW, simH: q.simH, bandColors: this._gasBandVecs() });
      u.uGasTex.value = this.gasSim.texture;
      u.uUseGasTex.value = 1;
    } else {
      u.uUseGasTex.value = 0;
    }
    this._setQualityUniforms();
  }

  /** True when the current planet supports live re-classification. */
  get terraformable() {
    return !!this.planet && (this.planet.type === 'terrestrial' || this.planet.type === 'ocean');
  }

  // ---------- live appearance overrides (gradient map + custom colours) ----------
  // Gradient map — a 256x1 LUT the shader remaps albedo through by luminance.
  // Pure render-time uniforms; never touches the seed-deterministic bake.
  setGradient(tex, mix, scale, lut) {
    // dispose the previous LUT so repeated uploads don't leak a GPU texture
    if (this._grad && this._grad.tex && this._grad.tex !== tex) this._grad.tex.dispose();
    const s = (scale != null) ? scale : (this._grad ? this._grad.scale : 1);
    // `lut` is the CPU-side Uint8 ramp (256*3) so the layered map export can
    // reproduce the gradient off-GPU; keep the prior one if not re-supplied.
    const cpuLut = (lut !== undefined) ? lut : (this._grad ? this._grad.lut : null);
    this._grad = { tex, mix, scale: s, lut: cpuLut };
    this.u.uGradientLut.value = tex;
    this.u.uHasGradient.value = 1;
    this.u.uGradientMix.value = mix;
    this.u.uGradientScale.value = s;
  }
  setGradientMix(mix) { if (this._grad) { this._grad.mix = mix; this.u.uGradientMix.value = mix; } }
  setGradientScale(scale) { this.u.uGradientScale.value = scale; if (this._grad) this._grad.scale = scale; }
  // Per-class gradient targeting. `targets` = { enable:[5], lo:[5], hi:[5] }
  // (index 0 water,1 rock,2 veg,3 ice,4 gas). Live uniforms; no rebake.
  setGradientTargets(targets) {
    if (!targets) return;
    if (targets.enable) this.u.uGradEnable.value = targets.enable.slice();
    if (targets.lo) this.u.uGradLo.value = targets.lo.slice();
    if (targets.hi) this.u.uGradHi.value = targets.hi.slice();
  }

  // Gas cloud/band recolour — strip8 is an array of 8 [r,g,b] (0-255) or null to
  // restore the seed bands. Persisted (as _gasBandOverride) so it survives planet
  // regen / quality rebuilds; converted to THREE.Vector3[8] for the sim.
  _gasBandVecs() {
    return this._gasBandOverride
      ? this._gasBandOverride.map((c) => new THREE.Vector3(c[0] / 255, c[1] / 255, c[2] / 255))
      : undefined;
  }
  setGasBands(strip8) {
    this._gasBandOverride = (strip8 && strip8.length === 8) ? strip8 : null;
    if (this.gasSim) this.gasSim.setBandColors(this._gasBandVecs() || null);
  }
  clearGradient() {
    if (this._grad && this._grad.tex) this._grad.tex.dispose();
    this._grad = null;
    this.u.uHasGradient.value = 0;
    this.u.uGradientLut.value = this.emptyTex;
  }

  // Custom colours — override palette slots as live uniforms (no rebake, no rng).
  // `map` keys are palette slot names ({r,g,b} arrays 0-255). Persisted so they
  // survive planet regen / quality rebuilds (re-applied at the end of uploadPlanet).
  _applyPaletteOverride() {
    const m = this._palOverride; if (!m) return;
    const u = this.u;
    const set = (name, c) => { if (c) u[name].value.set(c[0] / 255, c[1] / 255, c[2] / 255); };
    set('uPalDeepWater', m.deepWater); set('uPalWater', m.water); set('uPalShore', m.shore);
    set('uPalBeach', m.beach); set('uPalLowland', m.lowland); set('uPalPlains', m.plains);
    set('uPalForest', m.forest); set('uPalArid', m.arid); set('uPalHills', m.hills);
    set('uPalMountain', m.mountain); set('uPalPeak', m.peak); set('uPalPolarIce', m.polarIce);
    set('uAtmColor', m.atmCol); set('uCloudColor', m.cloudCol);
  }
  setPaletteOverride(map) {
    this._palOverride = Object.assign({}, this._palOverride, map);
    // atmosphere / cloud + biome uniforms (the biome uniforms feed the live
    // classifyRocky path when terraform is active)
    this._applyPaletteOverride();
    // Biome colours live in the BAKED albedo (the default render path), so
    // re-bake + re-upload — but ONLY when the change actually touches a baked
    // slot. Atmosphere/cloud are pure live uniforms (never enter the surface
    // bake), so skip the expensive re-bake for atmos/cloud-only edits. Rocky
    // bodies only; gas kinds recolour via the gradient map. Never touches RNG.
    const bakeKeys = Object.keys(map).filter((k) => k !== 'atmCol' && k !== 'cloudCol');
    if (bakeKeys.length && this.planet && this.planet.setPaletteOverride) {
      this.planet.setPaletteOverride(this._palOverride);
      if (this.planet.getTypeConfig().kind === 'rocky') this.refreshMaps(this.planet);
    }
  }
  clearPaletteOverride() {
    this._palOverride = null;
    if (this.planet && this.planet.clearPaletteOverride) {
      this.planet.clearPaletteOverride();
      if (this.planet.getTypeConfig().kind === 'rocky') this.refreshMaps(this.planet);
    }
    const pal = this.planet && this.planet.palette; if (!pal) return;
    const u = this.u;
    const set = (name, c, d) => { const x = c || d; u[name].value.set(x[0] / 255, x[1] / 255, x[2] / 255); };
    set('uPalDeepWater', pal.deepWater, [10, 40, 64]); set('uPalWater', pal.water, [20, 80, 120]);
    set('uPalShore', pal.shore, [60, 120, 150]); set('uPalBeach', pal.beach, [194, 178, 128]);
    set('uPalLowland', pal.lowland, [90, 120, 66]); set('uPalPlains', pal.plains, [110, 140, 70]);
    set('uPalForest', pal.forest, [40, 90, 40]); set('uPalArid', pal.arid, [160, 140, 90]);
    set('uPalHills', pal.hills, [120, 110, 80]); set('uPalMountain', pal.mountain, [130, 120, 110]);
    set('uPalPeak', pal.peak, [220, 220, 220]); set('uPalPolarIce', pal.polarIce, [235, 245, 250]);
    set('uAtmColor', pal.atmCol, [120, 180, 220]); set('uCloudColor', pal.cloudCol, [255, 255, 255]);
  }

  // ---------- frame ----------

  render(dt) {
    if (!this.planet || !this.sceneRT) return;
    const t0 = performance.now();
    this.flowChurn = this.terraform.churn ?? 1;

    if (this.autoRotate) {
      const speed = (this.planet.type === 'asteroid') ? 0.00008 : 0.0003;
      this.rotation += dt * speed;
    }
    if (!this.capturing) this.starTime += dt * 0.001;   // freeze animation clocks for a seamless export loop
    this.stars.drawStars(this.starTime);

    if (this.gasSim) {
      if (!this.capturing) {
        // fixed ~60 Hz stepping (refresh-rate independent), scaled by CHURN;
        // steps/frame capped by the quality tier
        this._simAcc = (this._simAcc || 0) + dt * this.flowChurn;
        const maxSteps = Quality.get().simSteps;
        const steps = Math.min(maxSteps, Math.floor(this._simAcc / 16.7));
        if (steps > 0) { this._simAcc -= steps * 16.7; this.gasSim.step(steps); }
      }
      this.u.uGasTex.value = this.gasSim.texture;
    }

    const planet = this.planet, u = this.u;
    const W = this.internalW, H = this.internalH;
    const minDim = Math.min(W, H);
    u.uRadius.value = minDim * (0.32 + planet.size * 0.16);
    u.uCenter.value.set(W / 2, H / 2);
    u.uCosT.value = Math.cos(this.rotation);
    u.uSinT.value = Math.sin(this.rotation);
    const effTilt = planet.axialTilt + (this.viewTilt || 0) * Math.PI / 180;
    u.uCosTilt.value = Math.cos(effTilt);
    u.uSinTilt.value = Math.sin(effTilt);
    u.uRotation.value = this.rotation;
    // cloud drift + aurora morph freeze during capture so a 360 spin loops
    u.uCloudShift.value = this.capturing ? 0.0 : this.rotation * 0.02;
    u.uAuroraTime.value = this.capturing ? 0.0 : this.rotation;
    u.uFlowTime.value = this.starTime * 0.02 * this.flowChurn;

    // sun
    const az = (this.sunAz ?? -28) * Math.PI / 180;
    const el = (this.sunEl ?? 18) * Math.PI / 180;
    const cosE = Math.cos(el);
    u.uSunDir.value.set(cosE * Math.sin(az), -Math.sin(el), cosE * Math.cos(az));
    const hueT = (this.sunHue ?? 0) / 100;
    const inten = (this.sunIntensity ?? 100) / 100;
    let sr, sg, sb;
    if (hueT < 0) { const t = -hueT; sr = 1; sg = 1 - t * 0.55; sb = 1 - t * 0.85; }
    else { sr = 1 - hueT * 0.30; sg = 1 - hueT * 0.10; sb = 1; }
    u.uSunColor.value.set(sr * inten, sg * inten, sb * inten);
    const sunMag = (sr + sg + sb) / 3 * inten;
    u.uSunFalloff.value = Math.min(sunMag, 1);

    // terraform uniforms
    const tf = this.terraform;
    const atmEff = this.baseAtmThickness * tf.atmScale;
    u.uAtmThickness.value = atmEff;
    u.uAtmDensity.value = tf.atmDensity ?? 1;
    const auroraOn = this._hasAuroraCol && (this._isGasKind || atmEff >= 0.18);
    u.uAuroraOn.value = auroraOn ? 1 : 0;
    u.uAuroraBase.value = this._isGasKind ? 0.95 : atmEff * 2.6;
    u.uTerraform.value = (tf.enabled && this.terraformable) ? 1 : 0;
    u.uSeaLevel.value = tf.enabled ? tf.seaLevel : this.cfg.seaLevel;
    u.uIceLine.value = tf.iceLine;
    u.uVegetation.value = tf.vegetation;
    u.uCloudMul.value = tf.cloudMul;
    u.uCloudCover.value = tf.cloudCover ?? 0.5;
    u.uCloudFlow.value = tf.cloudFlow ?? 1.0;
    u.uCloudAltLow.value = tf.cloudAltLow ?? 0.03;
    u.uCloudAltMid.value = tf.cloudAltMid ?? 0.06;
    u.uCloudAltHigh.value = tf.cloudAltHigh ?? 0.10;
    u.uCloudAmtLow.value = tf.cloudAmtLow ?? 1.0;
    u.uCloudAmtMid.value = tf.cloudAmtMid ?? 0.7;
    u.uCloudAmtHigh.value = tf.cloudAmtHigh ?? 0.5;
    u.uCloudScatter.value = tf.cloudScatter ?? 0.6;
    u.uCloudSeed.value = (this._cloudSeedBase ?? 0) + (tf.cloudSeed ?? 0);
    u.uEvolve.value = tf.evolve;
    u.uEvolveAmp.value = tf.evolveAmp;
    u.uVortexStrength.value = tf.flowMul ?? 1;
    u.uEmission.value = tf.emission ?? 1;
    u.uAuroraStrength.value = tf.aurora ?? 1;
    u.uSnowOffset.value = tf.snowOffset ?? 0;
    u.uRiverStrength.value = tf.riverStrength ?? 1;
    u.uRelief.value = this._relief ?? 1;

    // --- passes ---
    const gl = this.gl;
    this.quad.material = this.planetMat;
    gl.setRenderTarget(this.sceneRT);
    gl.clear(true, false, false);
    gl.render(this.scene, this.cam);

    if (this.bloomEnabled) {
      this.quad.material = this.brightMat;
      this.brightMat.uniforms.uScene.value = this.sceneRT.texture;
      gl.setRenderTarget(this.bloomA);
      gl.render(this.scene, this.cam);

      this.quad.material = this.blurMat;
      this.blurMat.uniforms.uSrc.value = this.bloomA.texture;
      this.blurMat.uniforms.uDir.value.set(1 / this.bloomA.width, 0);
      gl.setRenderTarget(this.bloomB);
      gl.render(this.scene, this.cam);
      this.blurMat.uniforms.uSrc.value = this.bloomB.texture;
      this.blurMat.uniforms.uDir.value.set(0, 1 / this.bloomA.height);
      gl.setRenderTarget(this.bloomA);
      gl.render(this.scene, this.cam);
    }

    this.quad.material = this.compositeMat;
    this.compositeMat.uniforms.uScene.value = this.sceneRT.texture;
    this.compositeMat.uniforms.uBloom.value = this.bloomEnabled ? this.bloomA.texture : this.emptyTex;
    this.compositeMat.uniforms.uBloomStrength.value = this.bloomEnabled ? 0.55 : 0.0;
    gl.setRenderTarget(null);
    gl.clear(true, false, false);
    gl.render(this.scene, this.cam);

    this.frame++;
    this.lastFrameMs = performance.now() - t0;
  }

  // Freeze all time-based animation (cloud drift, aurora morph, flow evolution,
  // star twinkle) so an EXPORT ANIM 360 rotation loops seamlessly — only the
  // rigid spin varies, which returns to start after 2*PI.
  beginCapture() {
    this._capState = { autoRotate: this.autoRotate, rotation: this.rotation };
    this.autoRotate = false;
    this.capturing = true;
  }
  endCapture() {
    if (this._capState) { this.autoRotate = this._capState.autoRotate; this.rotation = this._capState.rotation; }
    this.capturing = false;
  }

  /** Relief slider (GL path: pure uniform, no rebake). */
  setDisplacement(v) { this._relief = v; }

  // Read the current gas-flow dye back as an equirect RGBA8 buffer (for the
  // export card's surface + thermal modules — the "finished" simulated map).
  // Best-effort: returns null if there's no sim or the float readback fails.
  readGasEquirect() {
    if (!this.gasSim || !this.gasSim.dyeA) return null;
    const w = this.gasSim.dyeA.width, h = this.gasSim.dyeA.height;
    try {
      // A HalfFloat RT can't be read into a Float32Array (invalid readPixels
      // format -> silent GL error -> black). Blit the dye through a trivial
      // copy shader into an UNSIGNED_BYTE RT, then read that (always valid).
      if (!this._readRT || this._readRT.width !== w || this._readRT.height !== h) {
        if (this._readRT) this._readRT.dispose();
        this._readRT = new THREE.WebGLRenderTarget(w, h, {
          type: THREE.UnsignedByteType, minFilter: THREE.NearestFilter,
          magFilter: THREE.NearestFilter, depthBuffer: false, stencilBuffer: false,
        });
      }
      if (!this._copyMat) {
        this._copyMat = new THREE.RawShaderMaterial({
          glslVersion: THREE.GLSL3,
          vertexShader: QUAD_VERT,
          fragmentShader: 'precision highp float;\nin vec2 vUv;\nout vec4 oc;\nuniform sampler2D uTex;\nvoid main(){ oc = vec4(clamp(texture(uTex, vUv).rgb, 0.0, 1.0), 1.0); }',
          uniforms: { uTex: { value: null } }, depthTest: false, depthWrite: false,
        });
      }
      this._copyMat.uniforms.uTex.value = this.gasSim.texture;
      const prevMat = this.quad.material, prevRT = this.gl.getRenderTarget();
      this.quad.material = this._copyMat;
      this.gl.setRenderTarget(this._readRT);
      this.gl.render(this.scene, this.cam);
      this.gl.setRenderTarget(prevRT);
      this.quad.material = prevMat;
      const buf = new Uint8Array(w * h * 4);
      this.gl.readRenderTargetPixels(this._readRT, 0, 0, w, h, buf);
      return { data: new Uint8ClampedArray(buf.buffer.slice(0)), w, h };
    } catch (e) { return null; }
  }

  // Render the current surface flat as an equirect RGBA8 map (biomes, relief,
  // rivers, live terraform, or the gas dye) — no sun/clouds/atmosphere. Used by
  // the export card's surface + thermal modules so the card matches the view.
  readSurfaceEquirect(w = 1024, h = 512) {
    if (!this.planet) return null;
    try {
      if (!this._surfRT || this._surfRT.width !== w || this._surfRT.height !== h) {
        if (this._surfRT) this._surfRT.dispose();
        this._surfRT = new THREE.WebGLRenderTarget(w, h, {
          type: THREE.UnsignedByteType, minFilter: THREE.LinearFilter,
          magFilter: THREE.LinearFilter, depthBuffer: false, stencilBuffer: false,
        });
      }
      const prevMat = this.quad.material, prevRT = this.gl.getRenderTarget();
      this.u.uSurfaceMode.value = 1;
      this.quad.material = this.planetMat;
      this.gl.setRenderTarget(this._surfRT);
      this.gl.render(this.scene, this.cam);
      this.gl.setRenderTarget(prevRT);
      this.quad.material = prevMat;
      this.u.uSurfaceMode.value = 0;
      const buf = new Uint8Array(w * h * 4);
      this.gl.readRenderTargetPixels(this._surfRT, 0, 0, w, h, buf);
      return { data: new Uint8ClampedArray(buf.buffer.slice(0)), w, h };
    } catch (e) { this.u.uSurfaceMode.value = 0; return null; }
  }

  // Re-upload the surface data textures after a live re-erosion (EROSION
  // slider). Rebuilds the full map set so no uniform points at a disposed
  // texture; leaves rotation, starfield and gas sim untouched.
  refreshMaps(planet) {
    for (const t of this.textures) t.dispose();
    this.textures = [];
    const u = this.u;
    const keep = (t) => { this.textures.push(t); return t; };
    const cfg = planet.getTypeConfig();
    const isGasKind = cfg.kind === 'gas';
    const albSrc = (!isGasKind && planet.rawColorMap) ? planet.rawColorMap : planet.colorMap;
    u.uAlbedoTex.value = keep(dataTexRGB(albSrc));
    u.uHeightTex.value = keep(dataTexR(planet.heightMap));
    u.uCloudTex.value = keep(dataTexR(planet.cloudMap));
    u.uIceTex.value = keep(dataTexR(planet.iceMap));
    u.uMoistTex.value = planet.moistureMap ? keep(dataTexR(planet.moistureMap)) : this.emptyTex;
    u.uAshTex.value = planet.ashMap ? keep(dataTexR(planet.ashMap)) : this.emptyTex;
    u.uWaterTex.value = planet.waterMaskMap ? keep(dataTexR(planet.waterMaskMap)) : this.emptyTex;
    u.uFlowTex.value = planet.flowMap ? keep(dataTexR(planet.flowMap)) : this.emptyTex;
    u.uHasRivers.value = planet.flowMap ? 1 : 0;
    u.uShapeTex.value = planet.shapeMap ? keep(dataTexR(planet.shapeMap)) : this.emptyTex;
  }

  dispose() {
    if (this.gasSim) { this.gasSim.dispose(); this.gasSim = null; }
    for (const t of this.textures) t.dispose();
    this.textures = [];
    this.emptyTex.dispose();
    for (const rt of [this.sceneRT, this.bloomA, this.bloomB]) rt && rt.dispose();
    this.sceneRT = this.bloomA = this.bloomB = null;
    for (const m of [this.planetMat, this.brightMat, this.blurMat, this.compositeMat]) m.dispose();
    this.quad.geometry.dispose();
    this.gl.dispose();
  }
}

export { GLRenderer };
