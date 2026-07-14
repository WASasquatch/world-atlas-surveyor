// Planet shader — a GPU port of the CPU rasterizer (js/renderer.js) as a
// ray-traced sphere impostor on a fullscreen quad, plus the "enhanced"
// layer the CPU path can't afford: sun-relative bump lighting, Fresnel
// water glints, HDR output for bloom, gaseous-giganticus flow textures for
// gas giants, live GG-warped clouds, and real-time terraform
// re-classification (sea level / vegetation / ice / evolution) for
// terrestrial-family worlds.
//
// Conventions match the CPU renderer exactly: screen +x right / +y down /
// +z toward viewer; view ray -> tilt (X) -> spin (Y) -> planet frame;
// u = lon/2pi + 0.5, v = lat/pi + 0.5; all maps 768x384 equirect.

import { SIMPLEX_3D, SIMPLEX_4D, FBM_4D, SPHERE_FLOW, WORLEY_3D } from './noise-glsl.js';

const PLANET_VERT = /* glsl */ `
in vec3 position;
in vec2 uv;
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const PLANET_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 outColor;

// --- frame / geometry ---
uniform vec2  uResolution;     // internal render resolution
uniform float uRadius;         // planet radius in internal pixels
uniform vec2  uCenter;         // planet center in internal pixels (y-down)
uniform float uCosT, uSinT;    // spin
uniform float uCosTilt, uSinTilt; // axial + view tilt
uniform float uRotation;       // rotation
uniform float uAuroraTime;     // aurora morph clock (frozen during capture)

// --- sun ---
uniform vec3  uSunDir;         // view space, CPU convention (y-down)
uniform vec3  uSunColor;       // per-channel, intensity premultiplied
uniform float uSunFalloff;

// --- body config ---
uniform float uAtmThickness;   // 0 / .08 / .20 / .36 (x atmosphere slider)
uniform vec3  uAtmColor;
uniform float uKindGas;        // 1 = gas kind
uniform float uSelfEmit;       // brown dwarf
uniform float uSeaLevel;       // live (terraform) sea level
uniform float uCfgSeaLevel;    // baked sea level (water mask reference)
uniform float uRelief;         // displacement slider
uniform float uLavaGlow;       // 1 = volcanic lava emissive
uniform float uHasAsh;
uniform vec3  uAshCloud;
uniform float uAuroraOn;
uniform vec3  uAuroraColor;
uniform float uAuroraBase;
uniform vec3  uCloudColor;
uniform float uHasClouds;
uniform float uCloudShift;     // rotation * 0.02
uniform float uHasWaterMask;

// --- textures ---
uniform sampler2D uAlbedoTex;  // rawColorMap (rocky) or colorMap (gas)
uniform sampler2D uHeightTex;
uniform sampler2D uCloudTex;
uniform sampler2D uIceTex;
uniform sampler2D uAshTex;
uniform sampler2D uWaterTex;
uniform sampler2D uShapeTex;
uniform sampler2D uMoistTex;
uniform sampler2D uFlowTex;    // erosion flow / river map
uniform float uHasRivers;
uniform float uRiverStrength;  // RIVERS slider (0 = none .. 2 = prominent)
uniform float uHasShape;
uniform float uMaxShapeR;

// --- gas giant flow texture (equirect, from GasGiantSim) ---
uniform sampler2D uGasTex;
uniform float uUseGasTex;

// --- flow / clouds / emission / aurora (live controls) ---
uniform float uVortexStrength; // 0.1 .. 10 (VORTEX slider, exponential)
uniform float uFlowTime;       // churn-scaled flow clock
uniform float uProcClouds;     // 1 = animated procedural clouds
uniform float uCloudSeed;
uniform float uEmission;       // brown dwarf emission 0..2
uniform vec3  uGlowCol;
uniform vec3  uGlowHot;
uniform float uAuroraStrength; // aurora multiplier 0..2
uniform float uSnowOffset;     // snow-line shift (aboveSea units)
// quality budgets (integers, set per tier)
uniform int uQCloudOct;
uniform int uQCloudWarp;
uniform int uQEvolveOct;
uniform int uQAuroraDetail;
uniform int uQTerrainOct;
uniform int uQFloe;

// --- terraform ---
uniform float uTerraform;      // 1 = live classification (terrestrial/ocean)
uniform float uIceLine;        // live ice line (lower = more ice)
uniform float uVegetation;     // 1 = baked default
uniform float uCloudMul;       // cloud density multiplier vs baked
uniform float uEvolve;         // evolution offset (w dimension)
uniform float uEvolveAmp;      // evolution strength 0..1
// palette (0..1)
uniform vec3 uPalDeepWater, uPalWater, uPalShore, uPalBeach, uPalLowland,
             uPalPlains, uPalForest, uPalArid, uPalHills, uPalMountain,
             uPalPeak, uPalPolarIce;

${SIMPLEX_3D}
${SIMPLEX_4D}
${FBM_4D}
${SPHERE_FLOW}
${WORLEY_3D}

const float PI = 3.14159265358979;

vec2 dirToUV(vec3 w) {
  float lat = asin(clamp(w.y, -1.0, 1.0));
  float lon = atan(w.z, w.x);
  return vec2(fract(lon / (2.0 * PI) + 0.5), clamp(lat / PI + 0.5, 0.0, 0.99999));
}

// view ray direction -> planet-frame direction (tilt about X, then spin about Y)
vec3 viewToPlanet(vec3 n) {
  float ty = n.y * uCosTilt - n.z * uSinTilt;
  float tz = n.y * uSinTilt + n.z * uCosTilt;
  float tx = n.x;
  return vec3(tx * uCosT + tz * uSinT, ty, -tx * uSinT + tz * uCosT);
}

float sampleShapeR(vec3 w) {
  return texture(uShapeTex, dirToUV(normalize(w))).r;
}

float heightAt(vec2 uv) { return texture(uHeightTex, uv).r; }

// Independent "evolved" terrain: domain-warped continental fbm + ridged
// mountains. phase (== uEvolve) slides the world through 4D noise so higher
// EVOLVE reveals a genuinely different layout. oc = octave count.
float proceduralHeight(vec3 w, float phase, int oc) {
  vec3 q = w * 1.7;
  vec3 warp = vec3(
    fbm4(vec4(q,           phase), 2, 0.5),
    fbm4(vec4(q + 5.2,     phase), 2, 0.5),
    fbm4(vec4(q.zxy + 2.7, phase), 2, 0.5));
  vec3 wp = w + warp * 0.40;                                    // fold coastlines
  float cont   = fbm4(vec4(wp * 1.5, phase), oc, 0.5) * 2.0;    // continents ~[-1.2,1.2]
  float detail = fbm4(vec4(wp * 4.3 + 12.0, phase * 0.8), 3, 0.5) * 0.25;
  float ridN   = 1.0 - abs(fbm4(vec4(wp * 3.1 + 40.0, phase * 0.6), 3, 0.5));
  float mtn    = max(ridN - 0.45, 0.0) * 1.10;                  // ridge-gated peaks
  return cont + detail + mtn - 0.10;                            // land-fraction bias
}

// region-wipe selector: a coherent low-freq field decides per-region when it
// flips base->new as EVOLVE rises, so coastlines stay crisp mid-morph rather
// than the whole globe dissolving at once.
float evolveBlend(vec3 w) {
  const float edge = 0.18;
  float region = fbm4(vec4(w * 1.3 + 60.0, uEvolve * 0.3), 4, 0.5) * 0.5 + 0.5;
  float t = uEvolveAmp * (1.0 + 2.0 * edge) - edge;
  return smoothstep(region - edge, region + edge, t);
}

float evolvedHeight(vec2 uv, vec3 w) {
  float hBase = heightAt(uv);
  if (uEvolveAmp <= 0.001) return hBase;
  float hNew = proceduralHeight(w, uEvolve, uQEvolveOct);
  return mix(hBase, hNew, evolveBlend(w));
}

// ---- terraform classification (terrestrial / ocean family) ----
// Direct port of planet.js colorPixelRocky + polar sheet, driven by live
// uniforms. Small CPU noise fields (snow line, floes, crevasses) are
// approximated with GPU noise — coherent look, not bit-identical.
vec3 classifyRocky(float h, float m, float lat, vec3 w, out float iceCover) {
  float absLat = abs(lat) / (PI * 0.5);
  iceCover = 0.0;
  float snowCover = 0.0;

  m = clamp(m * uVegetation, 0.0, 1.0);

  vec3 col;
  if (h < uSeaLevel) {
    float depth = clamp((uSeaLevel - h) / 0.45, 0.0, 1.0);
    col = mix(uPalShore, uPalWater, smoothstep(0.0, 0.15, depth));
    col = mix(col, uPalDeepWater, smoothstep(0.2, 0.7, depth));
    if (depth < 0.04) col = mix(col, vec3(0.863, 0.922, 0.941), clamp((0.04 - depth) * 12.0, 0.0, 1.0));
  } else {
    float aboveSea = h - uSeaLevel;
    float climate = absLat + max(aboveSea, 0.0) * 0.85;
    float iceTrigger = uIceLine - 0.05;
    float ice = clamp((climate - iceTrigger) * 5.0, 0.0, 1.0);
    float tundra = clamp((climate - (iceTrigger - 0.20)) * 5.0, 0.0, 1.0) * (1.0 - ice);
    float tropical = clamp(1.0 - absLat / 0.40, 0.0, 1.0);
    float subtropicalDry = exp(-pow(absLat - 0.27, 2.0) / 0.018) * (1.0 - ice) * (1.0 - tundra);
    float temperate = exp(-pow(absLat - 0.50, 2.0) / 0.025) * (1.0 - ice) * (1.0 - tundra);
    float mEff = clamp(m - subtropicalDry * 0.55, 0.0, 1.0);
    mEff = clamp(mEff + tropical * 0.15, 0.0, 1.0);

    if (aboveSea < 0.02) {
      col = uPalBeach;
    } else if (aboveSea < 0.08) {
      col = mix(uPalBeach, mix(uPalLowland, uPalPlains, mEff), (aboveSea - 0.02) / 0.06);
    } else {
      vec3 dryLand = mix(uPalArid, uPalHills, smoothstep(0.05, 0.3, aboveSea));
      vec3 wetLand = mix(uPalPlains, uPalForest, smoothstep(0.4, 0.85, mEff));
      vec3 lowMid = mix(dryLand, wetLand, smoothstep(0.3, 0.7, mEff));
      // jungle
      if (tropical > 0.05 && mEff > 0.4 && aboveSea < 0.4) {
        vec3 deepForest = uPalForest * vec3(0.65, 1.05, 0.55);
        lowMid = mix(lowMid, deepForest, tropical * smoothstep(0.4, 0.7, mEff) * 0.55);
      }
      // temperate desaturation
      if (temperate > 0.05 && mEff > 0.3 && aboveSea < 0.5) {
        float lum = (lowMid.r + lowMid.g + lowMid.b) / 3.0;
        vec3 muted = lowMid * 0.88 + lum * 0.12;
        lowMid = mix(lowMid, muted, temperate * smoothstep(0.3, 0.6, mEff) * 0.55);
      }
      // subtropical arid tint
      if (subtropicalDry > 0.1 && mEff < 0.5 && aboveSea < 0.5) {
        lowMid = mix(lowMid, uPalArid, subtropicalDry * (1.0 - smoothstep(0.3, 0.55, mEff)) * 0.5);
      }
      // altitude ramp
      if (aboveSea < 0.25)      col = lowMid;
      else if (aboveSea < 0.45) col = mix(lowMid, uPalHills, (aboveSea - 0.25) / 0.2);
      else if (aboveSea < 0.7)  col = mix(uPalHills, uPalMountain, (aboveSea - 0.45) / 0.25);
      else                      col = mix(uPalMountain, uPalPeak, smoothstep(0.7, 0.95, aboveSea));
      // alpine vegetation belt
      if (aboveSea > 0.18 && aboveSea < 0.55 && (1.0 - tundra - ice) > 0.3) {
        float orographic = clamp(mEff + (aboveSea - 0.18) * 0.6, 0.0, 1.0);
        float alpineAmount = (1.0 - smoothstep(0.40, 0.55, aboveSea)) * (1.0 - tundra) * (1.0 - ice)
                           * smoothstep(0.30, 0.55, orographic)
                           * clamp(1.0 - subtropicalDry * 0.8, 0.0, 1.0);
        if (alpineAmount > 0.05) {
          vec3 conifer = vec3(uPalForest.r * 0.55 + 0.137, uPalForest.g * 0.75 + 0.098, uPalForest.b * 0.55 + 0.118);
          vec3 targetVeg = mix(conifer, uPalForest, tropical * 0.6);
          col = mix(col, targetVeg, alpineAmount * 0.65 * clamp(uVegetation, 0.0, 1.0));
        }
      }
      // snowcap — snow line lowers toward the poles and shifts with uSnowOffset
      {
        float snowNoise = fbm4(vec4(w * 8.0 + 31.0, 0.0), uQTerrainOct, 0.5) * 0.5;
        float snowLine = 0.50 - 0.42 * absLat + uSnowOffset;   // pole: 0.08, equator: 0.50
        float effAlt = aboveSea - snowNoise * 0.10;
        float cover = clamp((effAlt - snowLine) / 0.05, 0.0, 1.0);
        if (cover > 0.001) {
          float rocky = fbm4(vec4(w * 22.0 + 7.0, 0.0), uQTerrainOct, 0.5) * 0.5;
          if (rocky > 0.18) cover *= clamp(1.0 - (rocky - 0.18) * 3.0, 0.0, 1.0);
          if (cover > 0.02) { col = mix(col, uPalPolarIce, cover); snowCover = cover; }
        }
      }
    }
    // tundra desaturation — applies to all land bands, beach included (CPU parity)
    col = mix(col, mix(uPalHills, uPalArid, 0.4), tundra * 0.65);
  }

  // polar ice sheet — hard threshold + floe breakup
  float e = snoise3(w * 3.0 + 11.0) * 0.060;
  if (uQTerrainOct >= 3) e += snoise3(w * 9.0 + 33.0) * 0.030 + snoise3(w * 22.0 + 77.0) * 0.014;
  float sheetLat = absLat + e;
  float hardThr = uIceLine - 0.02;
  float overshoot = sheetLat - hardThr;
  float cover = 0.0;
  if (overshoot >= 0.07) {
    cover = 1.0;
  } else if (overshoot > 0.0) {
    float wCell = worley3(w * 5.0 + 88.0);
    float wCellFine = (uQFloe > 0) ? worley3(w * 14.0 + 101.0) : wCell;
    if (wCell > 0.18 || wCellFine > 0.30) cover = 1.0;
    else cover = max(clamp((wCell - 0.13) / 0.05, 0.0, 1.0), clamp((wCellFine - 0.25) / 0.05, 0.0, 1.0));
  } else if (overshoot > -0.008) {
    cover = (overshoot + 0.008) / 0.008;
  }
  if (cover > 0.001) {
    float polarFade = clamp(pow(cos(lat), 2.0) * 2.5, 0.0, 1.0);
    float texDarken = 0.0;
    if (overshoot > 0.04) {
      float crev = fbm4(vec4(w * 16.0 + 5.0, 0.0), uQTerrainOct, 0.5) * 0.5;
      if (crev < -0.18) texDarken += smoothstep(-0.35, -0.18, crev) * 0.10 * polarFade;
    }
    float blueShift = (overshoot > 0.04) ? smoothstep(-0.2, 0.4, snoise3(w * 4.0 + 9.0) * 0.5) * 0.08 * polarFade : 0.0;
    float poleBoost = clamp((absLat - uIceLine) / 0.10, 0.0, 1.0);
    vec3 sheet = mix(uPalPolarIce, vec3(1.0), 0.05 * poleBoost);
    sheet *= vec3(1.0 - blueShift - texDarken, 1.0 - blueShift * 0.5 - texDarken, 1.0 - texDarken);
    col = mix(col, sheet, cover);
    iceCover = cover;
  }
  // volumetric shelf ice — where ice/snow meets sea-level flats, break the
  // flat white into a slab with perlin thickness, pressure ridges, and a
  // seaward rim so coastal/ocean ice reads as voluminous rather than painted.
  float iceHere = max(iceCover, snowCover);
  float nearSea = 1.0 - smoothstep(0.0, 0.12, abs(h - uSeaLevel));
  float shelf = nearSea * iceHere;
  if (shelf > 0.02) {
    float slab = fbm4(vec4(w * 10.0 + 51.0, 0.0), uQTerrainOct, 0.5) * 0.5 + 0.5;
    float rdg  = 1.0 - abs(fbm4(vec4(w * 26.0 + 5.0, 0.0), 2, 0.5));
    float bright = 0.06 * slab + 0.06 * smoothstep(0.72, 1.0, rdg);
    float rim = smoothstep(0.55, 0.95, nearSea) * (h < uSeaLevel ? 0.12 : 0.06);
    vec3 iceCol = mix(uPalPolarIce, vec3(1.0), clamp(bright + rim, 0.0, 1.0));
    float amt = shelf * (0.35 + 0.35 * slab);
    col = mix(col, iceCol, amt);
    iceCover = max(iceCover, amt);
  }
  return col;
}

// cloud field — baked map, or animated procedural fbm when uProcClouds is on
float cloudField(vec3 dir, float shift) {
  if (uProcClouds > 0.5) {
    float a = shift * 6.28318530718;
    float ca = cos(a), sa = sin(a);
    vec3 d = dir; d.xz = mat2(ca, -sa, sa, ca) * d.xz;
    float t = uFlowTime;
    vec3 p = d * 2.2 + uCloudSeed;
    float base   = fbm4(vec4(p, t * 0.5 + uCloudSeed), uQCloudOct, 0.5);
    float detail = fbm4(vec4(p * 3.3 + 11.0, t * 0.9), max(2, uQCloudOct - 1), 0.55);
    float f = (base * 0.65 + detail * 0.35) * 0.5 + 0.5;
    float cover = smoothstep(0.42, 0.72, f);
    return clamp(cover * uCloudMul, 0.0, 1.0);
  }
  vec2 cuv = dirToUV(dir);
  cuv.x = fract(cuv.x + shift);
  return min(texture(uCloudTex, cuv).r * uCloudMul, 1.0);
}

// cloud sample with optional gaseous-giganticus flow warp (VORTEX strength)
float sampleCloud(vec3 w, float shift, float doWarp) {
  vec3 dir = w;
  if (doWarp > 0.5 && uVortexStrength > 0.12) {
    float perStep = min(0.02 * uVortexStrength, 0.35);
    for (int i = 0; i < 4; i++) {
      if (i >= uQCloudWarp * 2) break;
      vec3 f = sphereFlow(dir, 2.4, uFlowTime, uQCloudOct, 0.5, 1.0, 5.0, 0.35, 0.5, 1.0);
      dir = normalize(dir - f * perStep);
    }
  }
  return cloudField(dir, shift);
}

void main() {
  vec2 frag = vUv * uResolution;
  // CPU convention is y-down from the top-left; GL frag coords are y-up.
  float dx = (frag.x - uCenter.x) / uRadius;
  float dy = ((uResolution.y - frag.y) - uCenter.y) / uRadius;
  float r2 = dx * dx + dy * dy;

  // ---------- silhouette ----------
  float shapeR = 1.0;
  if (uHasShape > 0.5) {
    if (r2 > uMaxShapeR * uMaxShapeR) { outColor = vec4(0.0); return; }
    float dzg = r2 < 1.0 ? sqrt(1.0 - r2) : 0.0;
    for (int it = 0; it < 2; it++) {
      vec3 g = viewToPlanet(vec3(dx, dy, dzg));
      float len = length(g);
      if (len < 0.0001) { shapeR = uMaxShapeR; break; }
      shapeR = sampleShapeR(g / len);
      if (shapeR * shapeR <= r2) break;
      dzg = sqrt(shapeR * shapeR - r2);
    }
  }

  float atmR = shapeR + uAtmThickness;
  vec3 l = uSunDir;

  if (r2 > shapeR * shapeR) {
    // ---------- outer halo ----------
    if (uAtmThickness > 0.0 && r2 < atmR * atmR) {
      float tEdge = (r2 - shapeR * shapeR) / (atmR * atmR - shapeR * shapeR);
      float falloff = pow(1.0 - tEdge, 1.4);
      float glowSide = clamp(dx * l.x + dy * l.y + 0.3, 0.0, 1.0);
      float alpha = min(0.95, falloff * (0.5 + 0.7 * glowSide) * (uAtmThickness * 3.0)) * uSunFalloff;
      outColor = vec4(uAtmColor * uSunColor, alpha);
      return;
    }
    outColor = vec4(0.0);
    return;
  }

  // ---------- surface ----------
  float dz = sqrt(max(shapeR * shapeR - r2, 0.0));
  vec3 n = vec3(dx, dy, dz) / max(shapeR, 1e-5);
  vec3 w = viewToPlanet(n);
  vec2 uv = dirToUV(w);

  float ndotl = dot(n, l);
  float light = clamp(ndotl, 0.0, 1.0);

  float h = (uTerraform > 0.5) ? evolvedHeight(uv, w) : heightAt(uv);

  // ---- albedo ----
  vec3 albedo;
  float iceCover = texture(uIceTex, uv).r;
  float lat = asin(clamp(w.y, -1.0, 1.0));
  if (uUseGasTex > 0.5) {
    albedo = texture(uGasTex, uv).rgb;
  } else if (uTerraform > 0.5) {
    float m = texture(uMoistTex, uv).r;
    albedo = classifyRocky(h, m, lat, w, iceCover);
  } else {
    albedo = texture(uAlbedoTex, uv).rgb;
  }

  // ---- relief shading ----
  // Two components: (1) the CPU renderer's exact baked shade formula, applied
  // live as an albedo factor — this carries the visible terrain texture and
  // matches classic mode's relief strength; (2) an enhanced-only normal
  // perturbation so grazing light additionally rakes across mountains.
  if (uKindGas < 0.5 && uRelief > 0.001) {
    vec2 texel = vec2(1.0 / 768.0, 1.0 / 384.0);
    float hpx = heightAt(vec2(fract(uv.x + texel.x), uv.y));
    float hmx = heightAt(vec2(fract(uv.x - texel.x), uv.y));
    float hpy = heightAt(vec2(uv.x, clamp(uv.y + texel.y, 0.0, 1.0)));
    float hmy = heightAt(vec2(uv.x, clamp(uv.y - texel.y, 0.0, 1.0)));
    // CPU convention: unhalved central differences, x-gradient damped by
    // cos(lat) (equirect texels shrink toward the poles)
    float dxT = hpx - hmx;
    float dyT = hpy - hmy;
    // when evolving, the visible height IS the procedural field — take the
    // relief gradient from it (blended by the region-wipe) so new mountains
    // rake correctly instead of shading the old baked continents
    if (uTerraform > 0.5 && uEvolveAmp > 0.001) {
      vec3 dwLon = vec3(-w.z, 0.0, w.x);
      vec3 dwLat = cross(w, normalize(dwLon + vec3(1e-6)));
      float sLon = 2.0 * PI / 768.0, sLat = PI / 384.0;
      int go = max(2, uQEvolveOct - 2);
      float pE = proceduralHeight(normalize(w + dwLon * sLon), uEvolve, go);
      float pW = proceduralHeight(normalize(w - dwLon * sLon), uEvolve, go);
      float pN = proceduralHeight(normalize(w + dwLat * sLat), uEvolve, go);
      float pS = proceduralHeight(normalize(w - dwLat * sLat), uEvolve, go);
      float bb = evolveBlend(w);
      dxT = mix(dxT, pE - pW, bb);
      dyT = mix(dyT, pN - pS, bb);
    }
    float ice = iceCover;
    float kk = 1.5 * uRelief;
    float kx = kk * max(0.05, cos(lat));
    float isWater = (h < uSeaLevel) ? 1.0 : 0.0;
    float shade = clamp(0.5 - dxT * kx * (1.0 - ice) - dyT * kk * (1.0 - ice), 0.0, 1.0);
    float factor = isWater > 0.5 ? 0.92 + shade * 0.16 : 0.7 + shade * 0.6;
    factor = 1.0 + (factor - 1.0) * (1.0 - ice);
    albedo *= factor;

    // sun-relative rake (subtle, land only)
    vec3 east = normalize(vec3(-w.z, 0.0, w.x));
    vec3 north = normalize(cross(w, east));
    // planet -> view rotation (inverse of viewToPlanet)
    vec3 eastV, northV;
    {
      // viewToPlanet = spin(tilt(n)), so planetToView(v) = tiltInv(spinInv(v))
      vec3 s1 = vec3(east.x * uCosT - east.z * uSinT, east.y, east.x * uSinT + east.z * uCosT);
      eastV = vec3(s1.x, s1.y * uCosTilt + s1.z * uSinTilt, -s1.y * uSinTilt + s1.z * uCosTilt);
      vec3 s2 = vec3(north.x * uCosT - north.z * uSinT, north.y, north.x * uSinT + north.z * uCosT);
      northV = vec3(s2.x, s2.y * uCosTilt + s2.z * uSinTilt, -s2.y * uSinTilt + s2.z * uCosTilt);
    }
    float bumpK = 3.0 * uRelief * (1.0 - ice) * (1.0 - isWater * 0.85);
    vec3 nPerturbed = normalize(n - eastV * (dxT * 0.5 * bumpK) - northV * (dyT * 0.5 * bumpK));
    light = clamp(dot(nPerturbed, l), 0.0, 1.0);
  }

  // ---- rivers (from the erosion flow map) ----
  // River channels sit in valleys (high discharge, low slope), carved a touch
  // darker and tinted toward the body's water color. Land only; skips ice.
  if (uHasRivers > 0.5 && uRiverStrength > 0.01 && uKindGas < 0.5 && h >= uSeaLevel && iceCover < 0.5) {
    float flow = texture(uFlowTex, uv).r;
    vec2 tx = vec2(1.0 / 768.0, 1.0 / 384.0);
    float sx = heightAt(vec2(fract(uv.x + tx.x), uv.y)) - heightAt(vec2(fract(uv.x - tx.x), uv.y));
    float sy = heightAt(vec2(uv.x, clamp(uv.y + tx.y, 0.0, 1.0))) - heightAt(vec2(uv.x, clamp(uv.y - tx.y, 0.0, 1.0)));
    float slope = length(vec2(sx, sy));
    // RIVERS slider lowers the discharge threshold (more tributaries appear)
    // and raises opacity; rivers sit in valleys and fade into the sea at the
    // coast so they blend seamlessly
    float th = clamp(0.90 - 0.30 * uRiverStrength, 0.28, 0.92);
    float riverT = smoothstep(th, th + 0.10, flow) * (1.0 - smoothstep(0.18, 0.42, slope));
    riverT *= smoothstep(uSeaLevel, uSeaLevel + 0.015, h);
    if (riverT > 0.001) {
      vec3 riverCol = mix(uPalShore, uPalWater, clamp(flow, 0.0, 1.0));
      albedo = mix(albedo, riverCol, riverT * clamp(0.55 + 0.35 * uRiverStrength, 0.0, 1.0));
    }
  }

  // ---- per-channel sun lighting / volumetric self-emission ----
  float ambBase = uKindGas > 0.5 ? 0.13 : 0.08;
  vec3 lit = vec3(1.0);
  vec3 c;
  if (uSelfEmit > 0.5) {
    // albedo = the live flow dye (dark cloud bands + advected hot-rift streaks).
    // Dye luminance is the rift mask: bright dye lets the hot interior through.
    float rift = dot(albedo, vec3(0.299, 0.587, 0.114));
    float openness = smoothstep(0.08, 0.42, rift);   // thin cloud / rift -> interior shows
    vec3 hot = mix(uGlowCol, uGlowHot, smoothstep(0.40, 0.90, rift));
    float mu = clamp(n.z, 0.0, 1.0);                 // cos(view angle) — limb darkening
    float limbDark = 0.35 + 0.65 * pow(mu, 0.5);
    vec3 emit = hot * openness * limbDark * uEmission * 1.6;
    float fres = pow(1.0 - mu, 3.0);                 // backlit optically-thick limb
    emit += uGlowCol * fres * 0.7 * uEmission;
    vec3 deck = albedo * (0.20 + 0.14 * light);      // dark visible cloud deck
    c = deck + emit;                                 // HDR: rifts exceed 1 -> bloom
  } else {
    vec3 amb = vec3(0.012) + ambBase * uSunColor;
    lit = amb + (1.0 - ambBase) * light * uSunColor;
    c = albedo * lit;
  }

  // ---- cloud shadows, then clouds ----
  if (uHasClouds > 0.5) {
    float cv = sampleCloud(w, uCloudShift, 1.0);
    if (light > 0.05) {
      vec3 sn = normalize(n + l * 0.05);
      vec3 sw = viewToPlanet(sn);
      float shadowCv = sampleCloud(sw, uCloudShift, 1.0);
      float shadowStrength = shadowCv * 0.55 * (1.0 - cv) * light;
      c *= 1.0 - shadowStrength;
    }
    if (cv > 0.02) {
      float a = min(cv, 1.0);
      vec3 cloudCol = uCloudColor;
      if (uHasAsh > 0.5) {
        float ash = texture(uAshTex, vec2(fract(uv.x + uCloudShift), uv.y)).r;
        if (ash > 0.02) cloudCol = mix(cloudCol, uAshCloud, min(ash, 1.0));
      }
      c = mix(c, cloudCol * lit, a);
    }
  }

  // ---- atmosphere inner haze ----
  if (uAtmThickness > 0.0) {
    float limbExp = uAtmThickness >= 0.30 ? 1.4 : uAtmThickness >= 0.18 ? 2.2 : uAtmThickness >= 0.08 ? 3.5 : 5.0;
    float limb = pow(r2, limbExp);
    float litBias = clamp(ndotl + 0.30, 0.0, 1.0);
    float sideMul = 0.5 + 0.7 * litBias;
    float rimHaze = limb * uAtmThickness * 3.0 * sideMul;
    float generalHaze = uAtmThickness >= 0.10 ? (uAtmThickness - 0.05) * 0.55 * max(ndotl, 0.0) : 0.0;
    float haze = min(0.95, rimHaze + generalHaze) * uSunFalloff;
    c = mix(c, uAtmColor * uSunColor, haze);
  }

  // ---- water specular + Fresnel glint ----
  // (composited after clouds/haze like the CPU renderer: highlights stay
  // visible through limb haze rather than being lerped away)
  if (uHasWaterMask > 0.5) {
    float mask = (uTerraform > 0.5)
      ? smoothstep(0.0, 0.10, clamp(uSeaLevel + 0.05 - h, 0.0, 0.10)) * (1.0 - iceCover)
      : texture(uWaterTex, uv).r;
    if (mask > 0.02 && uLavaGlow < 0.5) {
      vec3 hv = normalize(vec3(l.x * 0.5, l.y * 0.5, (l.z + 1.0) * 0.5));
      float ndoth = clamp(dot(n, hv), 0.0, 1.0);
      float spec = pow(ndoth, 12.0) * mask * 0.7;
      c += spec * vec3(0.745, 0.843, 0.941) * uSunColor;
      // tight HDR sun glint with Fresnel edge boost (enhanced-only)
      float fres = pow(1.0 - clamp(dz, 0.0, 1.0), 2.0);
      float glint = pow(ndoth, 260.0) * mask * light;
      c += glint * (0.9 + fres * 1.4) * uSunColor * 1.2;
    }
    // lava emissive (volcanic seas)
    if (uLavaGlow > 0.5 && mask > 0.02) {
      float glow = (1.0 - 0.5 * light) * mask;
      c += vec3(0.784, 0.235, 0.039) * glow * 1.5; // 1.5 = deliberate HDR boost so lava blooms
    }
  }

  // ---- auroras — strength slider + flow-driven organic morph ----
  if (uAuroraOn > 0.5 && uAuroraStrength > 0.001 && abs(w.y) > 0.7) {
    float tt = uAuroraTime;
    float alon = atan(w.x, w.z);
    float hemi = sign(w.y);
    float nLat = snoise3(vec3(cos(alon), sin(alon), uFlowTime * 3.0 + hemi * 5.0)) * 0.022;
    float nAct = snoise3(vec3(cos(alon) * 2.0, sin(alon) * 2.0 + hemi * 3.1, uFlowTime * 2.0));
    float c1Lat = 0.84 + nLat       + 0.030 * sin(2.0 * alon + 0.4 * tt);
    float c2Lat = 0.92 + nLat * 0.7 + 0.020 * sin(3.0 * alon + 0.6 * tt);
    float c1HW = 0.034 * (0.7 + 0.4 * sin(3.0 * alon + 0.8 * tt));
    float c2HW = 0.024 * (0.7 + 0.4 * sin(5.0 * alon + 1.4 * tt));
    float off1 = (abs(w.y) - c1Lat) / max(c1HW, 1e-4);
    float off2 = (abs(w.y) - c2Lat) / max(c2HW, 1e-4);
    float curt1 = abs(off1) < 1.0 ? (1.0 - abs(off1)) * (1.0 - abs(off1)) : 0.0;
    float curt2 = abs(off2) < 1.0 ? (1.0 - abs(off2)) * (1.0 - abs(off2)) : 0.0;
    float curt = max(curt1, curt2);
    float offD = curt1 >= curt2 ? off1 : off2;
    float longRaw = sin(alon + 0.2 * tt) + 0.5 * sin(3.0 * alon - 0.9 * tt);
    if (uQAuroraDetail >= 2) longRaw += 0.25 * sin(7.0 * alon + 1.8 * tt);
    float sinAct = longRaw > 0.05 ? min(1.0, (longRaw - 0.05) * 0.8) : 0.0;
    float activity = sinAct * (0.35 + 0.65 * (0.5 + 0.5 * nAct));
    float rayMod = 0.50 + 0.35 * sin(18.0 * alon + 3.0 * tt + 4.0 * offD);
    if (uQAuroraDetail >= 2) rayMod += 0.15 * sin(45.0 * alon - 5.5 * tt + 2.0 * offD);
    float rays = max(0.25, rayMod);
    float ribbon = curt * activity * rays;
    if (ribbon > 0.005) {
      float limbFade = dz > 0.30 ? 1.0 : (dz / 0.30) * (dz / 0.30);
      vec3 auCol = offD < 0.0
        ? mix(uAuroraColor, vec3(0.353, 0.157, 0.784), clamp(-offD, 0.0, 1.0))
        : mix(uAuroraColor, vec3(0.902, 0.314, 0.510), clamp(offD, 0.0, 1.0));
      float nightBoost = 0.3 + 1.8 * (1.0 - light);
      c += auCol * ribbon * nightBoost * uAuroraBase * limbFade * uAuroraStrength;
    }
  }

  outColor = vec4(c, 1.0);
}
`;

export { PLANET_VERT, PLANET_FRAG };
