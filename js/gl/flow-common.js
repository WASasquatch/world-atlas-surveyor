// Shared machinery for the GPU flow sims (gaseous-giganticus technique).
//
// Both the gas-giant band sim and the aurora mask sim are the same pipeline —
// build a divergence-free tangential velocity field on the sphere, seed a dye
// texture, then advect it semi-Lagrangian in ping-pong render targets with a
// MacCormack correction and a periodic unsharp pass. Only the VELOCITY and
// INIT passes differ between them, so those stay in the respective sim files
// and everything below is shared.
//
// The one wrinkle is the map PROJECTION. The gas sim stores its dye in plain
// equirectangular space; the aurora only ever occupies the two polar caps, so
// it stores a pair of azimuthal-equidistant discs instead (isotropic texels
// exactly where the oval lives, and no pole singularity). Advection and
// sharpening are projection-agnostic — they only ever go through 3D directions
// — so they are emitted as functions that take the projection GLSL to inline.

import * as THREE from '../vendor/three.module.min.js';

const QUAD_VERT = /* glsl */ `
in vec3 position;
in vec2 uv;
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// --- projections -----------------------------------------------------------
// Each supplies uvToDir / dirToUv over the unit sphere, plus PI.

const EQUIRECT_PROJ = /* glsl */ `
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

// Dual polar caps, azimuthal equidistant, packed side by side in one texture:
// left half = +y (north) cap, right half = -y (south). Disc radius 1 == a
// colatitude of AU_COLAT_MAX, so texel size is uniform in colatitude and the
// pole is an ordinary interior point rather than a row of degenerate texels.
// Directions equatorward of AU_COLAT_MAX land outside the disc and read the
// (zero) rim — which is correct, there is no aurora there.
const AU_COLAT_MAX = 0.9599;   // 55 deg — comfortably outside any auroral oval

const POLARCAP_PROJ = /* glsl */ `
const float PI = 3.14159265358979;
const float COLAT_MAX = ${AU_COLAT_MAX};
vec3 uvToDir(vec2 uv) {
  float south = step(0.5, uv.x);
  vec2 p = vec2(fract(uv.x * 2.0), uv.y) * 2.0 - 1.0;
  float rr = length(p);
  float colat = rr * COLAT_MAX;
  float s = sin(colat);
  vec2 dirXZ = rr > 1e-6 ? (p / rr) * s : vec2(0.0);
  float cy = cos(colat) * mix(1.0, -1.0, south);
  return vec3(dirXZ.x, cy, dirXZ.y);
}
vec2 dirToUv(vec3 d) {
  float south = step(d.y, 0.0);
  float colat = acos(clamp(abs(d.y), 0.0, 1.0));
  float rr = colat / COLAT_MAX;
  vec2 xz = vec2(d.x, d.z);
  float m = length(xz);
  vec2 p = m > 1e-6 ? (xz / m) * rr : vec2(0.0);
  vec2 uv = p * 0.5 + 0.5;
  return vec2(uv.x * 0.5 + south * 0.5, uv.y);
}
`;

// --- advection -------------------------------------------------------------
// Semi-Lagrangian backtrace with a MacCormack correction (2nd order, barely
// diffusive, so swirls stay filamentary) and a monotonicity limiter clamping to
// the backtrace neighbourhood so the correction can never overshoot into
// ringing. uInject pulls slowly back toward the initial dye, which is what
// keeps band / oval identity against bilinear wash-out.
const advectFrag = (PROJ) => /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uDye;
uniform sampler2D uInitDye;
uniform sampler2D uVelocity;
uniform vec2 uTexel;
uniform float uDt;
uniform float uInject;
${PROJ}
vec3 dye(vec2 uv) { return texture(uDye, uv).rgb; }
void main() {
  vec3 dir = uvToDir(vUv);
  vec3 vel = texture(uVelocity, vUv).xyz;
  vec3 bpos = normalize(dir - vel * uDt);
  vec2 buv = dirToUv(bpos);
  vec3 phiHat = dye(buv);
  vec3 velB = texture(uVelocity, buv).xyz;
  vec2 fuv = dirToUv(normalize(bpos + velB * uDt));
  vec3 phiN = texture(uDye, vUv).rgb;
  vec3 corrected = phiHat + 0.5 * (phiN - dye(fuv));
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

// --- sharpen ---------------------------------------------------------------
// Mild unsharp mask applied periodically to counter the diffusion inherent in
// bilinear semi-Lagrangian advection. Offsets are taken in DIRECTION space at a
// fixed angular step (uAngStep) so seams and poles stay consistent whatever the
// projection. Limited to the neighbourhood so repeated passes can't ring.
const sharpenFrag = (PROJ) => /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uDye;
uniform float uAmount;
uniform float uAngStep;
uniform float uPoleFade;    // 1 = fade sharpening at |y|->1 (equirect poles)
${PROJ}
void main() {
  vec3 c = texture(uDye, vUv).rgb;
  vec3 dir = uvToDir(vUv);
  vec3 t = normalize(abs(dir.y) > 0.98 ? cross(dir, vec3(1, 0, 0)) : cross(dir, vec3(0, 1, 0)));
  vec3 b = normalize(cross(dir, t));
  float ang = uAngStep;
  vec3 n0 = texture(uDye, dirToUv(normalize(dir + t * ang))).rgb;
  vec3 n1 = texture(uDye, dirToUv(normalize(dir - t * ang))).rgb;
  vec3 n2 = texture(uDye, dirToUv(normalize(dir + b * ang))).rgb;
  vec3 n3 = texture(uDye, dirToUv(normalize(dir - b * ang))).rgb;
  // equirect only: fade out toward the poles, where a fixed angular offset
  // spans many texels of longitude and sharpening moires
  float amount = uAmount * mix(1.0, smoothstep(0.0, 0.15, length(dir.xz)), uPoleFade);
  vec3 sharpened = c + (c - (n0 + n1 + n2 + n3) * 0.25) * amount;
  vec3 lo = min(c, min(min(n0, n1), min(n2, n3)));
  vec3 hi = max(c, max(max(n0, n1), max(n2, n3)));
  outColor = vec4(clamp(sharpened, lo, hi), 1.0);
}
`;

// --- shared plumbing -------------------------------------------------------

const RT_OPTS = {
  type: THREE.HalfFloatType,
  minFilter: THREE.LinearFilter,
  magFilter: THREE.LinearFilter,
  wrapS: THREE.RepeatWrapping,
  wrapT: THREE.ClampToEdgeWrapping,
  depthBuffer: false,
  stencilBuffer: false,
};

function makeRT(w, h, overrides) {
  return new THREE.WebGLRenderTarget(w, h, { ...RT_OPTS, ...overrides });
}

function makeQuadMat(frag, uniforms) {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: QUAD_VERT,
    fragmentShader: frag,
    uniforms,
    depthTest: false,
    depthWrite: false,
  });
}

export {
  QUAD_VERT, EQUIRECT_PROJ, POLARCAP_PROJ, AU_COLAT_MAX,
  advectFrag, sharpenFrag, makeRT, makeQuadMat,
};
