// GLSL noise library — shader chunks shared by the GL renderer and the
// gas-giant flow simulation. Exported as template strings; concatenate the
// chunks you need ahead of your shader's main().
//
// snoise3/snoise4 are the simplex implementations from webgl-noise by
// Ian McEwan (Ashima Arts) & Stefan Gustavson — MIT licensed; full license
// text in THIRD_PARTY_LICENSES.md at the repo root.
//
// The sphere flow field (curlOnSphere + zonal bands) reimplements the
// technique from Stephen M. Cameron's gaseous-giganticus: take the gradient
// of an fBm noise field, project it onto the sphere's tangent plane, then
// rotate it 90 degrees about the radial axis. The result is a divergence-free
// tangential flow; adding latitude-based counter-rotating band velocities
// gives Jupiter-style banding. (Clean re-implementation of the published
// technique, not a translation of the GPL source.)

const SIMPLEX_3D = /* glsl */ `
vec3 mod289v3(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289v4(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute4(vec4 x) { return mod289v4(((x * 34.0) + 10.0) * x); }
vec4 taylorInvSqrt4(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise3(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);

  vec3 g  = step(x0.yzx, x0.xyz);
  vec3 l  = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);

  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;

  i = mod289v3(i);
  vec4 p = permute4(permute4(permute4(
            i.z + vec4(0.0, i1.z, i2.z, 1.0))
          + i.y + vec4(0.0, i1.y, i2.y, 1.0))
          + i.x + vec4(0.0, i1.x, i2.x, 1.0));

  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;

  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);

  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);

  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);

  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);

  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));

  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);

  vec4 norm = taylorInvSqrt4(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;

  vec4 m = max(0.5 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 105.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
`;

const SIMPLEX_4D = /* glsl */ `
vec4 mod289v4b(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
float mod289f(float x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute4b(vec4 x) { return mod289v4b(((x * 34.0) + 10.0) * x); }
float permutef(float x) { return mod289f(((x * 34.0) + 10.0) * x); }
vec4 taylorInvSqrt4b(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
float taylorInvSqrtf(float r) { return 1.79284291400159 - 0.85373472095314 * r; }

vec4 grad4(float j, vec4 ip) {
  const vec4 ones = vec4(1.0, 1.0, 1.0, -1.0);
  vec4 p, s;
  p.xyz = floor(fract(vec3(j) * ip.xyz) * 7.0) * ip.z - 1.0;
  p.w = 1.5 - dot(abs(p.xyz), ones.xyz);
  s = vec4(lessThan(p, vec4(0.0)));
  p.xyz = p.xyz + (s.xyz * 2.0 - 1.0) * s.www;
  return p;
}

float snoise4(vec4 v) {
  const vec4 C = vec4(0.138196601125011, 0.276393202250021,
                      0.414589803375032, -0.447213595499958);

  float F4 = 0.309016994374947451;
  vec4 i  = floor(v + dot(v, vec4(F4)));
  vec4 x0 = v - i + dot(i, C.xxxx);

  vec4 i0;
  vec3 isX = step(x0.yzw, x0.xxx);
  vec3 isYZ = step(x0.zww, x0.yyz);
  i0.x = isX.x + isX.y + isX.z;
  i0.yzw = 1.0 - isX;
  i0.y += isYZ.x + isYZ.y;
  i0.zw += 1.0 - isYZ.xy;
  i0.z += isYZ.z;
  i0.w += 1.0 - isYZ.z;

  vec4 i3 = clamp(i0, 0.0, 1.0);
  vec4 i2 = clamp(i0 - 1.0, 0.0, 1.0);
  vec4 i1 = clamp(i0 - 2.0, 0.0, 1.0);

  vec4 x1 = x0 - i1 + C.xxxx;
  vec4 x2 = x0 - i2 + C.yyyy;
  vec4 x3 = x0 - i3 + C.zzzz;
  vec4 x4 = x0 + C.wwww;

  i = mod289v4b(i);
  float j0 = permutef(permutef(permutef(permutef(i.w) + i.z) + i.y) + i.x);
  vec4 j1 = permute4b(permute4b(permute4b(permute4b(
            i.w + vec4(i1.w, i2.w, i3.w, 1.0))
          + i.z + vec4(i1.z, i2.z, i3.z, 1.0))
          + i.y + vec4(i1.y, i2.y, i3.y, 1.0))
          + i.x + vec4(i1.x, i2.x, i3.x, 1.0));

  vec4 ip = vec4(1.0 / 294.0, 1.0 / 49.0, 1.0 / 7.0, 0.0);

  vec4 p0 = grad4(j0, ip);
  vec4 p1 = grad4(j1.x, ip);
  vec4 p2 = grad4(j1.y, ip);
  vec4 p3 = grad4(j1.z, ip);
  vec4 p4 = grad4(j1.w, ip);

  vec4 norm = taylorInvSqrt4b(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  p4 *= taylorInvSqrtf(dot(p4, p4));

  vec3 m0 = max(0.6 - vec3(dot(x0, x0), dot(x1, x1), dot(x2, x2)), 0.0);
  vec2 m1 = max(0.6 - vec2(dot(x3, x3), dot(x4, x4)), 0.0);
  m0 = m0 * m0;
  m1 = m1 * m1;
  return 49.0 * (dot(m0 * m0, vec3(dot(p0, x0), dot(p1, x1), dot(p2, x2)))
               + dot(m1 * m1, vec2(dot(p3, x3), dot(p4, x4))));
}
`;

// fBm over 4D simplex — matches gaseous-giganticus' multi-octave shape
// (default 3 octaves, falloff 0.5, doubling frequency).
const FBM_4D = /* glsl */ `
float fbm4(vec4 p, int octaves, float falloff) {
  float sum = 0.0;
  float amp = 1.0;
  float norm = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= octaves) break;
    sum += amp * snoise4(p);
    norm += amp;
    amp *= falloff;
    p *= 2.0;
  }
  return sum / max(norm, 1e-6);
}
`;

// Divergence-free tangential flow on the unit sphere (gaseous-giganticus
// technique): gradient of fBm -> project to tangent plane -> rotate 90 deg
// about the radial axis (== cross(n, gradTangent)), then add counter-rotating
// zonal bands. dir must be normalized; w is the evolution dimension.
const SPHERE_FLOW = /* glsl */ `
vec3 noiseGradient4(vec3 p, float w, float eps, int octaves, float falloff) {
  float nx = fbm4(vec4(p.x + eps, p.y, p.z, w), octaves, falloff)
           - fbm4(vec4(p.x - eps, p.y, p.z, w), octaves, falloff);
  float ny = fbm4(vec4(p.x, p.y + eps, p.z, w), octaves, falloff)
           - fbm4(vec4(p.x, p.y - eps, p.z, w), octaves, falloff);
  float nz = fbm4(vec4(p.x, p.y, p.z + eps, w), octaves, falloff)
           - fbm4(vec4(p.x, p.y, p.z - eps, w), octaves, falloff);
  return vec3(nx, ny, nz);
}

// Curl-style tangential velocity at unit direction n.
vec3 curlOnSphere(vec3 n, float noiseScale, float w, int octaves, float falloff) {
  vec3 p = n * noiseScale;
  float eps = noiseScale * 0.012;
  vec3 g = noiseGradient4(p, w, eps, octaves, falloff);
  vec3 gTan = g - n * dot(g, n);      // project onto tangent plane
  return cross(n, gTan);              // rotate 90 deg about radial axis
}

// Counter-rotating zonal band speed. lat in radians (-pi/2..pi/2).
// poleAtt attenuates speed toward the poles; power > 1 widens the calm
// regions between bands. Sign alternates per band (counter-rotation).
float zonalBandSpeed(float lat, float numBands, float poleAtt, float power) {
  float c = cos(lat * numBands);
  float envelope = (1.0 - poleAtt) + poleAtt * cos(lat);
  return envelope * sign(c) * pow(abs(c), power);
}

// Full flow field: curl noise + eastward band velocity (y = pole axis).
vec3 sphereFlow(vec3 n, float noiseScale, float w, int octaves, float falloff,
                float curlAmp, float numBands, float bandAmp, float poleAtt, float bandPower) {
  vec3 v = curlOnSphere(n, noiseScale, w, octaves, falloff) * curlAmp;
  if (numBands > 0.0) {
    float lat = asin(clamp(n.y, -1.0, 1.0));
    vec3 east = vec3(-n.z, 0.0, n.x);
    float m = length(east);
    if (m > 1e-5) {
      v += (east / m) * (zonalBandSpeed(lat, numBands, poleAtt, bandPower) * bandAmp);
    }
  }
  return v;
}
`;

// Cheap 3D Worley (cellular) noise — returns distance to nearest feature
// point, ~0 at cell centers rising toward ~1. Used for ice floe breakup.
const WORLEY_3D = /* glsl */ `
// pcg3d (Jarzynski & Olano, JCGT 2020) — integer hash, stable on every
// GLES3 GPU (the classic fract(sin(big)) trick bands on mobile drivers)
uvec3 pcg3d(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}
vec3 worleyHash3(vec3 p) {
  uvec3 h = pcg3d(uvec3(ivec3(floor(p + 0.5)) + 512));
  return vec3(h >> 16u) / 65535.0;
}

float worley3(vec3 p) {
  vec3 id = floor(p);
  vec3 fd = fract(p);
  float minDist = 1.0;
  for (int zi = -1; zi <= 1; zi++)
  for (int yi = -1; yi <= 1; yi++)
  for (int xi = -1; xi <= 1; xi++) {
    vec3 off = vec3(float(xi), float(yi), float(zi));
    vec3 fp = worleyHash3(id + off);
    float d = length(off + fp - fd);
    minDist = min(minDist, d);
  }
  return clamp(minDist, 0.0, 1.0);
}
`;

export { SIMPLEX_3D, SIMPLEX_4D, FBM_4D, SPHERE_FLOW, WORLEY_3D };
