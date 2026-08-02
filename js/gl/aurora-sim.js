// Aurora precipitation-mask simulation.
//
// Rather than drawing auroras as analytic rings, this seeds a Feldstein-style
// auroral OVAL into a dye texture and hands it to the same gaseous-giganticus
// flow machinery the gas giants use (flow-common.js). The ionospheric
// convection field then shears, folds and curls that oval exactly the way the
// real one behaves — discrete arcs peel off the poleward edge, fold into the
// S-curves and spirals of a substorm, and break into curtains — and the planet
// shader just reads the result. Every organic shape in the render comes out of
// the advection; nothing in the shader knows what an "arc" is.
//
// PROJECTION. The oval only ever occupies the polar caps, so the dye lives in
// two azimuthal-equidistant discs packed side by side (left = north cap, right
// = south) instead of an equirectangular map. Texels are then isotropic and
// uniformly sized right where the arcs are, and the pole is an ordinary point.
//
// CHANNEL PACKING. The three dye channels are the three quantities that
// actually set what an aurora looks like, so advection transports them together
// and a folded arc keeps its character:
//   R — energy FLUX          overall brightness of the column
//   G — CHARACTERISTIC ENERGY of the precipitating electrons. Hard (fast)
//       electrons punch deeper, so emission peaks LOW: green over a violet
//       N2+ fringe. Soft electrons stop high, where the slow 630.0 nm oxygen
//       line survives: deep red. This is the channel that drives the shader's
//       colour-with-altitude gradient.
//   B — DISCRETE fraction    1 = sharp curtain with rays, 0 = smooth diffuse
//       glow (the equatorward mantle).
//
// All parameters are derived deterministically from the planet seed.

import * as THREE from '../vendor/three.module.min.js';
import { mulberry32 } from '../core/prng.js';
import { SIMPLEX_3D, SIMPLEX_4D, FBM_4D, SPHERE_FLOW } from './noise-glsl.js';
import {
  POLARCAP_PROJ, AU_COLAT_MAX, advectFrag, sharpenFrag, makeRT, makeQuadMat,
} from './flow-common.js';

const ADVECT_FRAG = advectFrag(POLARCAP_PROJ);
const SHARPEN_FRAG = sharpenFrag(POLARCAP_PROJ);

// Pass 1 — velocity: two-cell ionospheric convection + curl noise.
//
// The real high-latitude plasma flow is a twin-vortex pattern: antisunward
// across the polar cap, returning sunward down the dawn and dusk flanks. That
// is a divergence-free field on the sphere, so it drops straight out of a
// stream function psi: v = n x grad(psi), with psi ~ sin(magnetic local time)
// shaped radially to vanish at the pole and at the oval's outer edge. Curl
// noise on top supplies the folding that turns a smooth ring into arcs.
const VELOCITY_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform float uNoiseScale;
uniform float uW;
uniform float uCurlAmp;
uniform float uConvection;   // twin-vortex strength
uniform float uShear;        // extra azimuthal shear (arc stretching)
uniform float uTurb;
${SIMPLEX_3D}
${SIMPLEX_4D}
${FBM_4D}
${SPHERE_FLOW}
${POLARCAP_PROJ}

// Twin-vortex convection stream function at a cap direction. noonAz is the
// azimuth of local noon in the cap's own frame.
float convectionPsi(vec3 d, float noonAz) {
  float colat = acos(clamp(abs(d.y), 0.0, 1.0));
  float t = clamp(colat / COLAT_MAX, 0.0, 1.0);
  // radial shape: zero at the pole, zero past the oval, peak over the cap
  float radial = sin(PI * t) * smoothstep(1.0, 0.72, t);
  float az = atan(d.z, d.x) - noonAz;
  return sin(az) * radial;
}

void main() {
  vec3 dir = uvToDir(vUv);
  float hemi = dir.y >= 0.0 ? 1.0 : -1.0;
  vec3 axis = vec3(0.0, hemi, 0.0);

  // v = n x grad(psi), by central differences in the tangent plane
  vec3 t1 = normalize(cross(axis, dir) + vec3(1e-5, 0.0, 0.0));
  vec3 t2 = normalize(cross(dir, t1));
  float e = 0.01;
  float p0 = convectionPsi(normalize(dir + t1 * e), 0.0) - convectionPsi(normalize(dir - t1 * e), 0.0);
  float p1 = convectionPsi(normalize(dir + t2 * e), 0.0) - convectionPsi(normalize(dir - t2 * e), 0.0);
  vec3 grad = (t1 * p0 + t2 * p1) / (2.0 * e);
  // the two caps mirror (convection is antisunward in BOTH), so flip one
  vec3 vel = cross(dir, grad) * (uConvection * hemi);

  // azimuthal shear about the magnetic axis — differential rotation between the
  // polar cap and the oval, which is what draws arcs out into long thin ribbons
  vec3 east = cross(axis, dir);
  float m = length(east);
  if (m > 1e-5) {
    float colat = acos(clamp(abs(dir.y), 0.0, 1.0));
    float t = clamp(colat / COLAT_MAX, 0.0, 1.0);
    vel += (east / m) * (uShear * (0.35 - t) * hemi);
  }

  vel += curlOnSphere(dir, uNoiseScale, uW, 3, 0.5) * uCurlAmp;
  if (uTurb > 0.001) {
    vel += curlOnSphere(dir, uNoiseScale * 3.1, uW * 1.6 + 7.0, 2, 0.5) * (uCurlAmp * 0.9 * uTurb);
  }
  outColor = vec4(vel, 1.0);
}
`;

// Pass 2 — initial dye: the auroral oval.
//
// A Feldstein oval, not a circle. Its centre is displaced toward midnight and
// it is broader on the nightside (where the magnetotail maps down) and pinched
// on the dayside (where the magnetosphere is compressed), so the ring is a
// teardrop. On top of that: several discrete arcs with a knife-sharp poleward
// boundary and a soft equatorward one, a broad diffuse mantle below them, and
// high-frequency azimuthal striations that seed the curtain rays. The
// striations matter — the flow stretches them into the filament structure that
// reads as individual rays in the final render.
const INIT_DYE_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform float uSeedOffset;
uniform float uActivity;     // Kp analogue: oval radius + width + brightness
uniform float uArcCount;
uniform float uRayFreq;
uniform float uDetail;
${SIMPLEX_3D}
${SIMPLEX_4D}
${FBM_4D}
${POLARCAP_PROJ}

void main() {
  vec3 dir = uvToDir(vUv);
  float hemi = dir.y >= 0.0 ? 1.0 : -1.0;
  float colat = acos(clamp(abs(dir.y), 0.0, 1.0));
  float t = colat / COLAT_MAX;                      // 0 pole .. 1 rim
  if (t > 1.0) { outColor = vec4(0.0); return; }
  float az = atan(dir.z, dir.x);

  // --- oval geometry (in units of t) -------------------------------------
  // Radius grows with activity; midnight (az = PI) sits further equatorward
  // than noon, and the ring is fattest there. The seam-free way to say
  // "nightside" is cos(az), which is +1 at noon and -1 at midnight.
  float day = cos(az);
  float base = (0.34 + 0.30 * uActivity) * (1.0 - 0.20 * day);
  float halfW = (0.055 + 0.075 * uActivity) * (1.0 - 0.35 * day);
  // break the ring: low-frequency wander so it is never a clean ellipse
  float wander = fbm4(vec4(dir * 2.3 + 30.0, uSeedOffset + hemi * 8.0), 4, 0.55);
  base += wander * (0.045 + 0.05 * uActivity);
  float off = (t - base) / halfW;                   // -1 poleward .. +1 equatorward

  // --- discrete arcs ------------------------------------------------------
  // Several concentric sheets inside the oval band. The poleward edge of each
  // is sharp (that is the boundary photographs show as a hard line) and the
  // equatorward edge trails off.
  float arcs = 0.0;
  if (abs(off) < 1.6) {
    float phase = off * uArcCount + fbm4(vec4(dir * 5.5 + 70.0, uSeedOffset), 3, 0.5) * 1.4;
    float s = fract(phase);
    arcs = smoothstep(0.0, 0.16, s) * (1.0 - smoothstep(0.22, 1.0, s));
    arcs *= 1.0 - smoothstep(0.7, 1.6, abs(off));   // confine to the band
  }
  // envelope: bright core, hard poleward cut-off, soft equatorward tail
  float envel = smoothstep(-1.25, -0.85, off) * (1.0 - smoothstep(0.35, 1.5, off));

  // --- diffuse mantle -----------------------------------------------------
  // The equatorward glow from pitch-angle-scattered plasma-sheet electrons:
  // broad, structureless, dimmer, and much softer in energy.
  float diffuse = smoothstep(-0.4, 0.6, off) * (1.0 - smoothstep(0.9, 2.4, off)) * 0.42;

  // --- longitudinal activity ---------------------------------------------
  // Auroras are not uniformly bright around the oval; substorm activity
  // concentrates near midnight and comes in patches.
  float patch = fbm4(vec4(dir * vec3(4.0, 1.4, 4.0) + 110.0, uSeedOffset), 4, 0.55) * 0.5 + 0.5;
  float midnight = 0.55 + 0.45 * (0.5 - 0.5 * day);
  float act = midnight * mix(0.35, 1.25, patch);

  // --- curtain ray seeds --------------------------------------------------
  // High-frequency striations across the arc. These are what the flow draws
  // out into the vertical ray structure; without them the folded arcs would
  // read as smooth ribbons.
  float rays = 0.5 + 0.5 * sin(az * uRayFreq + fbm4(vec4(dir * 9.0 + 5.0, uSeedOffset), 3, 0.5) * 6.0);
  rays = mix(1.0, 0.35 + 0.85 * rays, 0.35 + 0.5 * uDetail);
  float fine = snoise3(dir * vec3(uRayFreq * 1.9, 6.0, uRayFreq * 1.9) + uSeedOffset);
  rays *= 1.0 + 0.30 * uDetail * fine;

  // --- pack ---------------------------------------------------------------
  float flux = (arcs * envel * 1.15 + diffuse) * act;
  flux *= rays;
  flux *= smoothstep(1.0, 0.88, t);                 // fade into the disc rim
  flux *= smoothstep(0.0, 0.06, t);                 // no singular spot at the pole

  // Characteristic energy: hardest in the discrete arcs (deep green/violet),
  // softest in the diffuse mantle and along the poleward edge, where the
  // 630.0 nm red dominates. This is what gives the render red tops over green.
  float energy = clamp(0.72 * arcs * envel + 0.10 - 0.30 * diffuse - 0.22 * smoothstep(0.0, -1.0, off), 0.0, 1.0);
  energy = mix(energy, energy * 0.55 + 0.10, 1.0 - uActivity);   // quiet = softer

  float discrete = clamp(arcs * envel * 1.4 - diffuse * 0.8, 0.0, 1.0);

  outColor = vec4(clamp(flux, 0.0, 2.0), energy, discrete, 1.0);
}
`;

class AuroraSim {
  /**
   * @param {THREE.WebGLRenderer} renderer shared GL renderer
   * @param {object} planet the generated planet (seedNum)
   * @param {object} opts { size, iterations }
   */
  constructor(renderer, planet, opts = {}) {
    this.renderer = renderer;
    // one square disc per cap, packed side by side
    this.simH = opts.size || 384;
    this.simW = this.simH * 2;

    const rng = mulberry32((planet.seedNum ^ 0x4A17) >>> 0);

    // Step size is pinned to the TEXEL, not the clock. A semi-Lagrangian
    // backtrace is unconditionally stable but bilinear-diffusive, and arcs are
    // the thinnest thing in this whole renderer — at more than ~2 texels per
    // step they smear into a smooth ring within a second. So dt tracks the disc
    // resolution and the iteration count rises to match, keeping the *developed*
    // state identical across quality tiers while higher tiers stay crisper.
    const texel = AU_COLAT_MAX / (this.simH / 2);
    const dt = 1.5 * texel;                       // ~1.5 texels per step at |v| = 1

    this.params = {
      noiseScale: 2.2 + rng() * 2.0,
      // Velocities are calibrated so |v| lands near 1: grad(psi) peaks around
      // pi / COLAT_MAX = 3.3 and typically runs ~1.5, so the convection
      // coefficient belongs in tenths. curlOnSphere returns ~0.07, hence the
      // much larger multiplier there for a comparable contribution.
      curlAmp: 2.5 + rng() * 2.5,
      convection: 0.22 + rng() * 0.18,
      shear: 0.35 + rng() * 0.35,
      arcCount: 2.0 + Math.floor(rng() * 4),      // 2..5 discrete sheets
      rayFreq: 60.0 + rng() * 90.0,               // curtain striation count
      dt,
      inject: 0.012,        // stronger than the gas sim: the oval must persist
      sharpenEvery: 4,
      sharpenAmount: 0.22,
    };
    // total angular advection to develop at construction (radians), so a fresh
    // planet already shows folded arcs rather than a clean seeded ring
    this.targetIterations = opts.iterations || Math.round(2.4 / dt);
    this.w = rng() * 10.0;
    this.seedOffset = rng() * 100;

    // Magnetic dipole axis, in planet space. Offsetting it from the spin axis
    // is the single biggest reason the result stops reading as "a ring around
    // the pole" — the oval then swings around as the planet turns.
    const tilt = (6 + rng() * 16) * Math.PI / 180;      // 6..22 degrees
    const mlon = rng() * Math.PI * 2;
    this.magAxis = new THREE.Vector3(
      Math.sin(tilt) * Math.cos(mlon), Math.cos(tilt), Math.sin(tilt) * Math.sin(mlon));

    // Seeded at the caller's activity, not a neutral default — the warm-up
    // below develops 2.4 rad of shear, and re-seeding afterwards would drag
    // all of that back toward a fresh ring.
    this.activity = opts.activity != null ? Math.max(0, Math.min(1, opts.activity)) : 0.5;
    this.detail = 0.6;
    this.turb = 0.4;
    this._injectBoost = 0;

    this.velRT  = makeRT(this.simW, this.simH, { wrapS: THREE.ClampToEdgeWrapping });
    this.initRT = makeRT(this.simW, this.simH, { wrapS: THREE.ClampToEdgeWrapping });
    this.dyeA   = makeRT(this.simW, this.simH, { wrapS: THREE.ClampToEdgeWrapping });
    this.dyeB   = makeRT(this.simW, this.simH, { wrapS: THREE.ClampToEdgeWrapping });

    this.quadScene = new THREE.Scene();
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const geo = new THREE.PlaneGeometry(2, 2);

    this.velMat = makeQuadMat(VELOCITY_FRAG, {
      uNoiseScale: { value: this.params.noiseScale },
      uW: { value: this.w },
      uCurlAmp: { value: this.params.curlAmp },
      uConvection: { value: this.params.convection },
      uShear: { value: this.params.shear },
      uTurb: { value: this.turb },
    });
    this.initMat = makeQuadMat(INIT_DYE_FRAG, {
      uSeedOffset: { value: this.seedOffset },
      uActivity: { value: this.activity },
      uArcCount: { value: this.params.arcCount },
      uRayFreq: { value: this.params.rayFreq },
      uDetail: { value: this.detail },
    });
    this.advectMat = makeQuadMat(ADVECT_FRAG, {
      uDye: { value: null },
      uInitDye: { value: this.initRT.texture },
      uVelocity: { value: this.velRT.texture },
      uTexel: { value: new THREE.Vector2(1 / this.simW, 1 / this.simH) },
      uDt: { value: this.params.dt },
      uInject: { value: this.params.inject },
    });
    this.sharpenMat = makeQuadMat(SHARPEN_FRAG, {
      uDye: { value: null },
      uAmount: { value: this.params.sharpenAmount },
      // one texel of the disc, in radians of colatitude
      uAngStep: { value: (2.0 / this.simH) * AU_COLAT_MAX },
      uPoleFade: { value: 0 },     // no equirect pole singularity here
    });

    this.quad = new THREE.Mesh(geo, this.velMat);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);

    this.stepCount = 0;
    this.disposed = false;

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

  /** ACTIVITY (Kp analogue) — oval radius, width and arc brightness. 0..1.
   *  Re-seeds the init dye and lets it migrate in over ~1.5 s, so dragging the
   *  slider expands the oval smoothly instead of snapping the pattern. */
  setActivity(a) {
    a = Math.max(0, Math.min(1, a));
    if (a === this.activity) return;
    this.activity = a;
    this.initMat.uniforms.uActivity.value = a;
    this.renderPass(this.initMat, this.initRT);
    this._injectBoost = 70;
  }

  setDetail(d) {
    if (d === this.detail) return;
    this.detail = d;
    this.initMat.uniforms.uDetail.value = d;
    this.renderPass(this.initMat, this.initRT);
    this._injectBoost = 60;
  }

  /** Advance the flow n frames. */
  step(n = 1) {
    if (this.disposed) return;
    this.advectMat.uniforms.uDt.value = this.params.dt;
    this.advectMat.uniforms.uInject.value = this._injectBoost > 0 ? 0.07 : this.params.inject;
    for (let f = 0; f < n; f++) {
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
    if (this._injectBoost > 0) this._injectBoost -= n;
    // Convection reconfigures on substorm timescales — much livelier than a gas
    // giant's banding, but slow enough not to shimmer between velocity rebuilds.
    this.w += 0.00012 * n;
    if (this.stepCount % 20 === 0) this.renderVelocity();
  }

  /** Current mask texture — dual polar caps, sample via dirToAuroraUv. */
  get texture() { return this.dyeA.texture; }

  dispose() {
    this.disposed = true;
    for (const rt of [this.velRT, this.initRT, this.dyeA, this.dyeB]) rt.dispose();
    for (const m of [this.velMat, this.initMat, this.advectMat, this.sharpenMat]) m.dispose();
    this.quad.geometry.dispose();
  }
}

export { AuroraSim };
