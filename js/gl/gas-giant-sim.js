// Gas giant flow simulation — GPU re-implementation of the technique from
// Stephen M. Cameron's gaseous-giganticus: a divergence-free curl-noise flow
// with counter-rotating zonal bands advects a color field over the sphere.
// Where the original moves 8M particles on the CPU, we advect a dye texture
// semi-Lagrangian style in ping-pong render targets, which converges to the
// same characteristic banded, storm-swirled look and runs in real time.
//
// The dye lives in plain equirectangular space (like every other planet
// map): all advection math goes through 3D directions, so the U seam wraps
// naturally and there are no cubemap face borders to manage. Pole texels
// stretch, but zonal band speeds are pole-attenuated exactly as in GG, so
// nothing dramatic happens there visually.
//
// All parameters are derived deterministically from the planet seed.

import * as THREE from '../vendor/three.module.min.js';
import { mulberry32 } from '../core/prng.js';
import { SIMPLEX_3D, SIMPLEX_4D, FBM_4D, SPHERE_FLOW } from './noise-glsl.js';

const SIM_W = 512, SIM_H = 256;

const QUAD_VERT = /* glsl */ `
in vec3 position;
in vec2 uv;
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const EQUIRECT_COMMON = /* glsl */ `
const float PI = 3.14159265358979;
vec3 uvToDir(vec2 uv) {
  float lon = (uv.x - 0.5) * 2.0 * PI;
  float lat = (uv.y - 0.5) * PI;
  float cl = cos(lat);
  return vec3(cl * cos(lon), sin(lat), cl * sin(lon));
}
vec2 dirToUv(vec3 d) {
  float lat = asin(clamp(d.y, -1.0, 1.0));
  float lon = atan(d.z, d.x);
  return vec2(lon / (2.0 * PI) + 0.5, lat / PI + 0.5);
}
`;

// Pass 1 — velocity field: tangential flow vector per equirect texel.
const VELOCITY_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform float uNoiseScale;
uniform float uW;
uniform float uCurlAmp;
uniform float uNumBands;
uniform float uBandAmp;
uniform float uPoleAtt;
uniform float uBandPower;
uniform float uTurb;        // TURBULENCE: secondary high-freq curl (KH billows)
${SIMPLEX_3D}
${SIMPLEX_4D}
${FBM_4D}
${SPHERE_FLOW}
${EQUIRECT_COMMON}
void main() {
  vec3 dir = uvToDir(vUv);
  vec3 vel = sphereFlow(dir, uNoiseScale, uW, 3, 0.5,
                        uCurlAmp, uNumBands, uBandAmp, uPoleAtt, uBandPower);
  // Secondary, finer, low-amplitude curl layered on top. This adds the
  // transverse wiggle at the zonal shear lines that rolls up into
  // Kelvin-Helmholtz billows (the fine curls GG shows at band boundaries),
  // which a single smooth curl can't seed. uTurb 0 = none (pure bands+curl).
  if (uTurb > 0.001) {
    vel += curlOnSphere(dir, uNoiseScale * 3.3, uW * 1.7 + 11.0, 2, 0.5)
         * (uCurlAmp * 0.5 * uTurb);
  }
  outColor = vec4(vel, 1.0);
}
`;

// Pass 2 — initial dye: latitude color bands with noise-jittered edges,
// mirroring gaseous-giganticus' vertical-gradient-strip input images.
const INIT_DYE_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform vec3 uBandColors[8];
uniform float uBandCount;
uniform float uJitter;
uniform float uSeedOffset;
uniform float uStripeFreq;
uniform float uDetail;      // DETAIL: init contrast/roughness the flow shears
${SIMPLEX_3D}
${SIMPLEX_4D}
${FBM_4D}
${EQUIRECT_COMMON}
void main() {
  vec3 dir = uvToDir(vUv);
  // jitter band edges so the stripes aren't perfect circles
  float j = fbm4(vec4(dir * 3.0, uSeedOffset), 3, 0.5);
  float t = clamp(vUv.y + j * uJitter, 0.0, 1.0);
  float per = uBandCount - 1.0;
  float fi = t * per * uStripeFreq;                 // stripeFreq scales ring count
  float m = mod(fi, per);
  int i0 = int(floor(m));
  int i1 = int(mod(floor(m) + 1.0, per));
  // band edge sharpens with DETAIL — crisper stripes give the shear more
  // contrast to fold into filaments instead of a smooth gradient to smear
  float e = 0.12 - 0.09 * uDetail;                  // 0.12 (soft) .. 0.03 (crisp)
  float f = smoothstep(0.5 - e, 0.5 + e, fract(m));
  vec3 col = mix(uBandColors[i0], uBandColors[i1], f);
  // multi-octave detail — because ADVECT re-seeds toward uInitDye every step,
  // whatever structure lives here is continuously refreshed and sheared into
  // persistent filaments rather than diffusing away.
  float d = fbm4(vec4(dir * (18.0 + 40.0 * uDetail), uSeedOffset), 3, 0.6);
  col *= 1.0 + (0.08 + 0.22 * uDetail) * d;
  // anisotropic streaks (fine in longitude, broad in latitude) that the zonal
  // shear stretches lengthwise into GG-style banded filaments
  col *= 1.0 + 0.12 * uDetail * snoise3(dir * vec3(64.0, 7.0, 64.0) + uSeedOffset);
  outColor = vec4(col, 1.0);
}
`;

// Pass 3 — advection: backtrace along the velocity field and resample,
// with a slight pull back toward the initial dye to keep band identity
// (particles in the original never lose their color; bilinear advection
// diffuses, so the injection counteracts wash-out).
const ADVECT_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uDye;
uniform sampler2D uInitDye;
uniform sampler2D uVelocity;
uniform vec2 uTexel;
uniform float uDt;
uniform float uInject;
${EQUIRECT_COMMON}
vec3 dye(vec2 uv) { return texture(uDye, uv).rgb; }
void main() {
  vec3 dir = uvToDir(vUv);
  vec3 vel = texture(uVelocity, vUv).xyz;
  // semi-Lagrangian backtrace
  vec3 bpos = normalize(dir - vel * uDt);
  vec2 buv = dirToUv(bpos);
  vec3 phiHat = dye(buv);
  // MacCormack correction: re-advect forward, estimate + halve the error.
  // This is 2nd-order and barely diffusive, so swirls stay filamentary.
  vec3 velB = texture(uVelocity, buv).xyz;
  vec2 fuv = dirToUv(normalize(bpos + velB * uDt));
  vec3 phiN = texture(uDye, vUv).rgb;
  vec3 corrected = phiHat + 0.5 * (phiN - dye(fuv));
  // monotonicity limiter: clamp to the backtrace neighbourhood so the
  // correction never overshoots (no ringing / colour speckle)
  vec3 c0 = dye(buv + vec2(uTexel.x, 0.0));
  vec3 c1 = dye(buv - vec2(uTexel.x, 0.0));
  vec3 c2 = dye(buv + vec2(0.0, uTexel.y));
  vec3 c3 = dye(buv - vec2(0.0, uTexel.y));
  vec3 lo = min(phiHat, min(min(c0, c1), min(c2, c3)));
  vec3 hi = max(phiHat, max(max(c0, c1), max(c2, c3)));
  corrected = clamp(corrected, lo, hi);
  vec3 initC = texture(uInitDye, buv).rgb;
  outColor = vec4(mix(corrected, initC, uInject), 1.0);
}
`;

// Pass 4 — sharpen (mild unsharp mask), applied periodically to counter
// the diffusion inherent in bilinear semi-Lagrangian advection. Offsets
// are taken in direction space so the U seam and poles stay consistent.
const SHARPEN_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uDye;
uniform vec2 uTexel;
uniform float uAmount;
${EQUIRECT_COMMON}
void main() {
  vec3 c = texture(uDye, vUv).rgb;
  vec3 dir = uvToDir(vUv);
  vec3 t = normalize(abs(dir.y) > 0.98 ? cross(dir, vec3(1, 0, 0)) : cross(dir, vec3(0, 1, 0)));
  vec3 b = normalize(cross(dir, t));
  float ang = uTexel.y * PI * 1.2;
  vec3 n0 = texture(uDye, dirToUv(normalize(dir + t * ang))).rgb;
  vec3 n1 = texture(uDye, dirToUv(normalize(dir - t * ang))).rgb;
  vec3 n2 = texture(uDye, dirToUv(normalize(dir + b * ang))).rgb;
  vec3 n3 = texture(uDye, dirToUv(normalize(dir - b * ang))).rgb;
  // fade out toward the poles, where the fixed angular offset spans many
  // texels of longitude and sharpening moires
  float amount = uAmount * smoothstep(0.0, 0.15, length(dir.xz));
  vec3 sharpened = c + (c - (n0 + n1 + n2 + n3) * 0.25) * amount;
  // limiter: never create new extrema, so repeated sharpening can't ring
  vec3 lo = min(c, min(min(n0, n1), min(n2, n3)));
  vec3 hi = max(c, max(max(n0, n1), max(n2, n3)));
  outColor = vec4(clamp(sharpened, lo, hi), 1.0);
}
`;

class GasGiantSim {
  /**
   * @param {THREE.WebGLRenderer} renderer shared GL renderer
   * @param {object} planet the generated planet (seedNum, palette)
   */
  constructor(renderer, planet, opts = {}) {
    this.renderer = renderer;
    this.simW = opts.simW || SIM_W;
    this.simH = opts.simH || SIM_H;
    this.targetIterations = opts.iterations || 400;

    const rng = mulberry32((planet.seedNum ^ 0x6A57) >>> 0);
    const pal = planet.palette || {};
    const isBrownDwarf = !!pal.glow;

    // --- deterministic flow parameters (ranges bracket the GG defaults:
    // noise_scale 2.6, num_bands 6, band_speed_factor 2.9, pole_att 0.5).
    // Bands must dominate curl (~5-10x, as in GG) or the zonal structure
    // dissolves into undifferentiated turbulence.
    this.params = {
      noiseScale: 1.8 + rng() * 2.2,
      numBands: Math.floor(4 + rng() * 6),
      bandPower: 1 + Math.floor(rng() * 3),
      poleAtt: 0.35 + rng() * 0.3,
      curlAmp: 4.0 + rng() * 5.0,
      bandAmp: 2.8 + rng() * 1.4,
      wDrift: 0.00002 + rng() * 0.00004,
      // dt sized so a step backtraces multiple texels — sub-texel steps
      // through bilinear filtering diffuse the dye to mush within seconds
      dt: 0.006,
      inject: 0.005,
      sharpenEvery: 4,
      sharpenAmount: 0.20,
    };
    this.w = rng() * 10.0;

    // brown dwarfs: sharper, narrower, more turbulent bands (still band-dominant)
    if (isBrownDwarf) {
      this.params.numBands = Math.floor(4 + rng() * 3);   // 4..6 (broad, readable)
      this.params.bandPower = 1 + Math.floor(rng() * 2);
      this.params.curlAmp = 5.0 + rng() * 4.0;
      this.params.bandAmp = 3.2 + rng() * 1.2;
      this.params.sharpenAmount = 0.24;
      this.params.inject = 0.012;                          // keep hot rifts crisp
    }
    this.baseNumBands = this.params.numBands;   // AFTER the tweak
    // Base values captured AFTER all seed-derived rng() draws so the live
    // SCALE / TURBULENCE / DETAIL sliders are pure multipliers over the seed
    // baseline (no new rng() here → the per-seed flow character is unchanged;
    // these are appearance controls, fixed constants at their neutral point).
    this.baseNoiseScale = this.params.noiseScale;
    this.baseSharpenAmount = this.params.sharpenAmount;
    this.detail = 0.5;    // DETAIL neutral — init roughness/contrast + sharpen
    this.turb = 0.35;     // TURBULENCE neutral — secondary KH-billow curl fraction
    this.params.sharpenAmount = Math.min(0.32, this.baseSharpenAmount * (0.7 + 0.6 * this.detail));
    this.stripeFreq = 1.0;
    this.vortexStrength = 1.0;
    this._injectBoost = 0;

    // --- band colors: the palette's ordered band strip, mirrored across the
    // equator with mild per-band jitter — the analogue of the vertical
    // gradient strip images gaseous-giganticus takes as input ---
    const fallback = [[200, 152, 96], [232, 184, 120], [160, 104, 64], [216, 168, 104], [138, 88, 40], [240, 208, 152]];
    const src = (pal.bands && pal.bands.length >= 3) ? pal.bands : fallback;
    const colors = [];
    for (let i = 0; i < 8; i++) {
      // mirror: south pole -> equator -> north pole runs the strip out and back
      const t = i / 7;
      const fold = 1.0 - Math.abs(t * 2 - 1);           // 0 at poles, 1 at equator
      const idx = Math.min(src.length - 1, Math.floor(fold * (src.length - 0.001)));
      const c = src[idx];
      const v = 0.92 + rng() * 0.16;
      colors.push(new THREE.Vector3(c[0] / 255 * v, c[1] / 255 * v, c[2] / 255 * v));
    }
    // brown dwarfs: overwrite ~2 bands with the glow ramp so the advected dye
    // carries bright hot-rift streaks (dye luminance = the emission rift mask)
    if (isBrownDwarf && pal.glow && pal.glowHot) {
      const g = pal.glow, gh = pal.glowHot;
      // three bright hot slots so the advected dye carries broad glow rifts
      colors[3] = new THREE.Vector3(g[0] / 255, g[1] / 255, g[2] / 255);
      colors[4] = new THREE.Vector3(gh[0] / 255, gh[1] / 255, gh[2] / 255);
      colors[6] = new THREE.Vector3(g[0] / 255, g[1] / 255, g[2] / 255);
    }
    // occasional storm-color accent band off the equator (Great-Red-Spot-ish
    // latitudes) — the flow stretches it into an oval
    if (pal.storm && rng() < 0.6) {
      const slot = rng() < 0.5 ? 2 : 5;
      const s = pal.storm;
      colors[slot] = new THREE.Vector3(s[0] / 255, s[1] / 255, s[2] / 255);
    }
    this._paletteBandColors = colors;   // seed-derived strip (restore target)
    // a custom-colour override (vec3[8]) supplied by the appearance panel takes
    // precedence over the seed strip and survives quality/regen rebuilds
    this.bandColors = (opts.bandColors && opts.bandColors.length === 8) ? opts.bandColors : colors;
    this.bandCount = 8;
    this.jitter = 0.02 + rng() * 0.05;
    this.seedOffset = rng() * 100;

    // --- render targets (equirect; x wraps, y clamps) ---
    const rtOpts = {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
    };
    this.velRT  = new THREE.WebGLRenderTarget(this.simW, this.simH, rtOpts);
    this.initRT = new THREE.WebGLRenderTarget(this.simW, this.simH, rtOpts);
    this.dyeA   = new THREE.WebGLRenderTarget(this.simW, this.simH, rtOpts);
    this.dyeB   = new THREE.WebGLRenderTarget(this.simW, this.simH, rtOpts);

    // --- fullscreen quad machinery ---
    this.quadScene = new THREE.Scene();
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const geo = new THREE.PlaneGeometry(2, 2);

    const mkMat = (frag, uniforms) => new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: QUAD_VERT,
      fragmentShader: frag,
      uniforms,
      depthTest: false,
      depthWrite: false,
    });

    this.velMat = mkMat(VELOCITY_FRAG, {
      uNoiseScale: { value: this.params.noiseScale },
      uW: { value: this.w },
      uCurlAmp: { value: this.params.curlAmp },
      uNumBands: { value: this.params.numBands },
      uBandAmp: { value: this.params.bandAmp },
      uPoleAtt: { value: this.params.poleAtt },
      uBandPower: { value: this.params.bandPower },
      uTurb: { value: this.turb },
    });
    this.initMat = mkMat(INIT_DYE_FRAG, {
      uBandColors: { value: this.bandColors },
      uBandCount: { value: this.bandCount },
      uJitter: { value: this.jitter },
      uSeedOffset: { value: this.seedOffset },
      uStripeFreq: { value: 1.0 },
      uDetail: { value: this.detail },
    });
    this.advectMat = mkMat(ADVECT_FRAG, {
      uDye: { value: null },
      uInitDye: { value: this.initRT.texture },
      uVelocity: { value: this.velRT.texture },
      uTexel: { value: new THREE.Vector2(1 / this.simW, 1 / this.simH) },
      uDt: { value: this.params.dt },
      uInject: { value: this.params.inject },
    });
    this.sharpenMat = mkMat(SHARPEN_FRAG, {
      uDye: { value: null },
      uTexel: { value: new THREE.Vector2(1 / this.simW, 1 / this.simH) },
      uAmount: { value: this.params.sharpenAmount },
    });

    this.quad = new THREE.Mesh(geo, this.velMat);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);

    this.stepCount = 0;
    this.disposed = false;

    // velocity + initial dye + warm-up so a freshly generated planet
    // already shows developed flow rather than flat stripes
    this.renderVelocity();
    this.renderPass(this.initMat, this.initRT);
    this.renderPass(this.initMat, this.dyeA);
    this.step(this.targetIterations);
  }

  renderPass(material, target) {
    const prev = this.renderer.getRenderTarget();
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.quadScene, this.quadCam);
    this.renderer.setRenderTarget(prev);
  }

  renderVelocity() {
    this.velMat.uniforms.uW.value = this.w;
    this.renderPass(this.velMat, this.velRT);
  }

  setVortex(s) { this.vortexStrength = s; }        // s in 0.1..10

  // SCALE — swirl/feature size. Multiplier over the seed noiseScale (higher =
  // finer, more intricate flow). Re-renders only the cheap velocity pass.
  setScale(mult) {
    const v = this.baseNoiseScale * mult;
    if (v !== this.params.noiseScale) {
      this.params.noiseScale = v;
      this.velMat.uniforms.uNoiseScale.value = v;
      this.renderVelocity();
    }
  }

  // TURBULENCE — secondary high-freq curl fraction (Kelvin-Helmholtz billows /
  // chaotic mixing at band boundaries). Velocity pass only.
  setTurbulence(t) {
    if (t !== this.turb) {
      this.turb = t;
      this.velMat.uniforms.uTurb.value = t;
      this.renderVelocity();
    }
  }

  // DETAIL — initial-dye roughness/contrast + edge crispness + sharpen strength
  // (filament fineness). Re-renders the init pass and boosts injection so the
  // richer detail migrates into the live dye over ~1.5s with no black frame.
  setDetail(d) {
    if (d === this.detail) return;
    this.detail = d;
    this.initMat.uniforms.uDetail.value = d;
    this.params.sharpenAmount = Math.min(0.32, this.baseSharpenAmount * (0.7 + 0.6 * d));
    this.sharpenMat.uniforms.uAmount.value = this.params.sharpenAmount;
    this.renderPass(this.initMat, this.initRT);
    this._injectBoost = 90;
  }

  // Recolour the gas bands/clouds live (custom-colour override). cols =
  // THREE.Vector3[8] (0..1) or null to restore the seed-derived strip. Re-seeds
  // the init dye and lets the new colours migrate into the live flow over ~1.5s
  // (same no-black-frame mechanism as setDensity / setDetail).
  setBandColors(cols) {
    this.bandColors = (cols && cols.length === 8) ? cols : this._paletteBandColors;
    this.initMat.uniforms.uBandColors.value = this.bandColors;
    this.renderPass(this.initMat, this.initRT);
    this._injectBoost = 90;
  }

  // ITERATIONS — develop the flow to exactly n advection steps from the seed.
  // More iterations = more sheared, filamentary detail (like GG's -i count).
  setIterations(n) {
    n = Math.max(0, Math.round(n));
    if (n === this.stepCount) return;
    if (n < this.stepCount) {                        // rewind: re-seed, re-develop
      this.renderVelocity();
      this.renderPass(this.initMat, this.initRT);
      this.renderPass(this.initMat, this.dyeA);
      this.stepCount = 0;
    }
    if (n > this.stepCount) this.step(n - this.stepCount);
  }

  // Change band count live (DENSITY). Re-renders the (cheap) velocity + init
  // passes; leaves the live dye alone and boosts injection so the new bands
  // migrate in over ~1.5s with no black-frame reset.
  setDensity(d) {
    const n = Math.max(0, Math.round(this.baseNumBands * d));
    if (n !== this.params.numBands) {
      this.params.numBands = n;
      this.velMat.uniforms.uNumBands.value = n;
      this.renderVelocity();
    }
    const sf = Math.max(0.05, d);
    if (sf !== this.stripeFreq) {
      this.stripeFreq = sf;
      this.initMat.uniforms.uStripeFreq.value = sf;
      this.renderPass(this.initMat, this.initRT);
      this._injectBoost = 90;
    }
  }

  /** Advance the flow n frames. VORTEX scales dt via stable sub-steps so the
   *  same field can drift minimally or shear violently without instability. */
  step(n = 1) {
    if (this.disposed) return;
    const s = this.vortexStrength ?? 1.0;
    const dtMax = 0.014;                             // ~1.2 texels — stable backtrace
    const want = this.params.dt * s;
    let sub = Math.max(1, Math.ceil(want / dtMax));
    sub = Math.min(sub, Math.max(1, Math.floor(8 / n)));  // cap passes/frame
    const subDt = want / sub;
    this.advectMat.uniforms.uDt.value = subDt;
    this.advectMat.uniforms.uInject.value = this._injectBoost > 0 ? 0.06 : this.params.inject;
    for (let f = 0; f < n; f++) {
      for (let k = 0; k < sub; k++) {
        this.advectMat.uniforms.uDye.value = this.dyeA.texture;
        this.renderPass(this.advectMat, this.dyeB);
        [this.dyeA, this.dyeB] = [this.dyeB, this.dyeA];
        this.stepCount++;
        if (this.stepCount % this.params.sharpenEvery === 0) {
          this.sharpenMat.uniforms.uDye.value = this.dyeA.texture;
          this.renderPass(this.sharpenMat, this.dyeB);
          [this.dyeA, this.dyeB] = [this.dyeB, this.dyeA];
        }
      }
    }
    if (this._injectBoost > 0) this._injectBoost -= n;
    this.w += this.params.wDrift * n;               // field morph = churn (via cadence)
    if (this.stepCount % 30 === 0) this.renderVelocity();
  }

  /** Current dye texture — plain equirect, sample with the surface UV. */
  get texture() { return this.dyeA.texture; }

  dispose() {
    this.disposed = true;
    for (const rt of [this.velRT, this.initRT, this.dyeA, this.dyeB]) rt.dispose();
    for (const m of [this.velMat, this.initMat, this.advectMat, this.sharpenMat]) m.dispose();
    this.quad.geometry.dispose();
  }
}

export { GasGiantSim };
