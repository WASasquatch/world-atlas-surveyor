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
uniform float uAtmThickness;   // 0 / .08 / .20 / .36 (x atmosphere slider) — HEIGHT/extent
uniform float uAtmDensity;     // haze/halo OPACITY multiplier (1 = default)
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
uniform float uSurfaceMode;    // 1 = render flat equirect surface (for export card)
uniform float uRiverStrength;  // RIVERS slider (0 = none .. 2 = prominent)
uniform sampler2D uGradientLut; // 256x1 colour-grade ramp (gradient map)
uniform float uHasGradient;     // 1 = gradient map active
uniform float uGradientMix;     // 0..1 blend toward the remapped colour
uniform float uGradientScale;   // luminance spread around mid-grey (1 = none)
// Per surface-class gradient targeting (index: 0 water, 1 land/rock, 2 veg,
// 3 ice/snow, 4 gas/other). Enable gates whether the gradient touches that
// class; Lo/Hi remap the class's luminance into a SLICE of the ramp so classes
// occupy distinct colour ranges (ice ≠ shallow water ≠ continent).
uniform float uGradEnable[5];
uniform float uGradLo[5];
uniform float uGradHi[5];
uniform float uHasShape;
uniform float uMaxShapeR;

// --- gas giant flow texture (equirect, from GasGiantSim) ---
uniform sampler2D uGasTex;
uniform float uUseGasTex;

// --- flow / clouds / emission / aurora (live controls) ---
uniform float uVortexStrength; // 0.1 .. 10 (VORTEX slider, exponential)
uniform float uFlowTime;       // churn-scaled flow clock
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

// --- clouds (multi-deck) ---
uniform float uCloudAltLow, uCloudAltMid, uCloudAltHigh;   // shell heights (parallax + shadow)
uniform float uCloudAmtLow, uCloudAmtMid, uCloudAmtHigh;   // per-deck opacity/coverage
uniform float uCloudScatter;                               // forward-scatter / silver-lining

// --- terraform ---
uniform float uTerraform;      // 1 = live classification (terrestrial/ocean)
uniform float uIceLine;        // live ice line (lower = more ice)
uniform float uVegetation;     // 1 = baked default
uniform float uCloudMul;       // cloud opacity/density multiplier vs baked
uniform float uCloudCover;     // cloud COVERAGE (area) 0..1, 0.5 = baseline
uniform float uCloudFlow;      // GG-flow warp strength on clouds (global currents)
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

// equirect uv (matching the baked map row/col convention) -> sphere direction
vec3 uvToDirEquirect(vec2 uv) {
  float lon = uv.x * 2.0 * PI;
  float lat = uv.y * PI - PI * 0.5;
  float cl = cos(lat);
  return vec3(cl * cos(lon), sin(lat), cl * sin(lon));
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

// Gradient-map post-process: remap albedo by luminance through the 256x1 LUT,
// blended by uGradientMix (Photoshop-style luminance gradient map). Applied to
// UNLIT albedo so relief + lighting stack on top; hooks the single resolved-
// albedo point so it recolours every body type (rocky biomes AND gas dye).
// Classify a surface pixel from the live height/moisture/latitude so the
// gradient map can target specific classes. Mirrors the biome classifier's
// water / ice / veg / rock decision (tracks terraform sea level + ice line).
int surfaceClass(float h, float m, float lat) {
  if (h < uSeaLevel) return 0;                         // WATER
  float absLat = abs(lat) / (PI * 0.5);
  if (absLat > uIceLine - 0.02) return 3;              // polar ICE sheet
  float aboveSea = h - uSeaLevel;
  float climate = absLat + max(aboveSea, 0.0) * 0.85;
  float iceTrigger = uIceLine - 0.05;
  float ice = clamp((climate - iceTrigger) * 5.0, 0.0, 1.0);
  if (ice > 0.5) return 3;                             // cold high-altitude ICE
  float tundra = clamp((climate - (iceTrigger - 0.20)) * 5.0, 0.0, 1.0) * (1.0 - ice);
  float tropical = clamp(1.0 - absLat / 0.40, 0.0, 1.0);
  float subDry = exp(-pow(absLat - 0.27, 2.0) / 0.018) * (1.0 - ice) * (1.0 - tundra);
  float mEff = clamp(clamp(m * uVegetation - subDry * 0.55, 0.0, 1.0) + tropical * 0.15, 0.0, 1.0);
  float altVeg = clamp(1.0 - (aboveSea - 0.25) / 0.20, 0.0, 1.0);
  float vegAmt = smoothstep(0.3, 0.7, mEff) * (1.0 - ice) * (1.0 - 0.65 * tundra) * altVeg;
  return vegAmt > 0.35 ? 2 : 1;                        // VEG : ROCK
}

vec3 applyGradient(vec3 c, int cls) {
  if (uHasGradient < 0.5 || uGradientMix <= 0.0) return c;
  if (uGradEnable[cls] < 0.5) return c;                // class not targeted → keep palette
  float L = clamp(dot(c, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
  // Global scale/spread around mid-grey — >1 softens tight banding, <1 adds contrast.
  L = clamp((L - 0.5) / uGradientScale + 0.5, 0.0, 1.0);
  // Per-class sub-range: map this class into a SLICE of the ramp so different
  // classes read as different colours from the same image.
  L = clamp(mix(uGradLo[cls], uGradHi[cls], L), 0.0, 1.0);
  vec3 m = texture(uGradientLut, vec2(L, 0.5)).rgb;
  return mix(c, m, uGradientMix);
}

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
// Organic colour-detail multiplier — mirrors Planet._colorDetail() on the CPU
// (patchwork amplitude + domain-warped multi-scale detail) so the live terraform
// view mottles biome colours the same way the baked albedo / map export do.
float colorDetail(vec3 w) {
  float patchMask = clamp(fbm4(vec4(w * 1.7 + 210.0, 0.0), 3, 0.5) * 0.5 + 0.5, 0.0, 1.0);
  float amp = (0.30 + 0.70 * patchMask) * 0.13;
  float wx = fbm4(vec4(w * 2.3 + 41.0, 0.0), 2, 0.5) * 0.20;
  float d = fbm4(vec4(w * 6.5 + wx + 90.0, 0.0), 4, 0.5);
  return 1.0 + clamp(d, -1.0, 1.0) * amp;
}

vec3 classifyRocky(float h, float m, float lat, vec3 w, float slope, out float iceCover) {
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

    if (aboveSea < 0.08) {
      // coastline: gentle shores → sandy beach; steep/rocky shores → cliffs &
      // outcrops (slope + regional noise + speckle), matching the CPU bake
      vec3 lowBiome = mix(uPalLowland, uPalPlains, mEff);
      float coastNoise = snoise3(w * 3.4 + 130.0) * 0.5;
      float speckle = snoise3(w * 20.0 + 9.0) * 0.5;
      float rk = clamp(smoothstep(0.045, 0.16, slope) + smoothstep(0.14, 0.42, coastNoise) + speckle * 0.22, 0.0, 1.0);
      vec3 cliffCol = mix(uPalHills, uPalMountain, 0.35);
      vec3 coastMat = mix(uPalBeach, cliffCol, smoothstep(0.35, 0.65, rk));
      col = (aboveSea < 0.02) ? coastMat : mix(coastMat, lowBiome, (aboveSea - 0.02) / 0.06);
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
      // organic colour-detail mottling (before the snowcap so caps stay clean)
      col *= colorDetail(w);
      // snowcap — snow line lowers toward the poles and shifts with uSnowOffset
      {
        float snowNoise = fbm4(vec4(w * 8.0 + 31.0, 0.0), uQTerrainOct, 0.5) * 0.5;
        float snowLine = 0.50 - 0.42 * absLat + uSnowOffset;   // pole: 0.08, equator: 0.50
        float effAlt = aboveSea - snowNoise * 0.10;
        float cover = clamp((effAlt - snowLine) / 0.05, 0.0, 1.0);
        if (cover > 0.001) {
          float rocky = fbm4(vec4(w * 22.0 + 7.0, 0.0), uQTerrainOct, 0.5) * 0.5;
          if (rocky > 0.18) cover *= clamp(1.0 - (rocky - 0.18) * 3.0, 0.0, 1.0);
          // steep faces shed snow, exposing bare rock — this is what makes a
          // snow-covered mountain range read as 3D ridges and cut valleys
          // rather than a flat white plain. Gentle slopes / ridgetops hold it.
          float steep = smoothstep(0.035, 0.13, slope);
          cover *= 1.0 - 0.85 * steep;
          if (cover > 0.02) { col = mix(col, uPalPolarIce, cover); snowCover = cover; }
        }
      }
    }
    // tundra desaturation — applies to all land bands, beach included (CPU parity)
    col = mix(col, mix(uPalHills, uPalArid, 0.4), tundra * 0.65);
  }

  // polar ice sheet — hard threshold + floe breakup. Multi-scale edge
  // displacement so the boundary reads as ragged embayments/peninsulas and
  // tongues rather than one smooth latitude circle.
  // Multi-scale edge displacement — large lobes down to fine crenellation. The
  // finer octaves are ALWAYS applied (not quality-gated) so the boundary reads
  // ragged at every tier instead of a smooth circle with a couple of big wobbles.
  float e = snoise3(w * 1.5 + 21.0) * 0.10;   // large embayments / broad lobes
  e += snoise3(w * 3.2 + 11.0) * 0.060;
  e += snoise3(w * 7.0 + 33.0) * 0.034;
  e += snoise3(w * 15.0 + 77.0) * 0.018;
  e += snoise3(w * 31.0 + 50.0) * 0.010;      // fine crenellation
  float sheetLat = absLat + e;
  float hardThr = uIceLine - 0.02;
  float overshoot = sheetLat - hardThr;
  float cover = 0.0;
  if (overshoot >= 0.09) {
    cover = 1.0;
  } else if (overshoot > -0.02) {
    // wider ragged floe/island band: Worley cells punch the sheet into discrete
    // floes AND scatter detached bergs just OUTSIDE the main edge (overshoot<0)
    float wCell = worley3(w * 5.0 + 88.0);
    float wCellFine = (uQFloe > 0) ? worley3(w * 14.0 + 101.0) : wCell;
    float band = smoothstep(-0.02, 0.09, overshoot);            // more solid deeper in
    float floe = max(clamp((wCell - 0.14) / 0.05, 0.0, 1.0), clamp((wCellFine - 0.27) / 0.05, 0.0, 1.0));
    if (overshoot > 0.0 && (wCell > 0.19 || wCellFine > 0.31)) cover = 1.0;
    else cover = clamp(max(band * band, floe * smoothstep(-0.02, 0.05, overshoot)), 0.0, 1.0);
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

// ============================================================================
// CLOUD SYSTEM — multi-deck, multi-scale, volumetrically shaded.
// Three physically-inspired decks, each on its own shell altitude (parallax +
// shadow scale with height):
//   0 LOW  — cumulus / stratocumulus: puffy (billow noise), cellular, broken, opaque
//   1 MID  — alto / frontal banks: medium fbm banks, moderate coverage
//   2 HIGH — cirrus: latitudinally-stretched wispy streaks, thin/translucent
// Every deck: flow-advected (polar-tapered so no pole spiral), multi-octave
// shape, weather-band coverage (ITCZ wet / subtropics dry / mid-lat storm belt),
// and value-driven multi-scale breakup (solid cores → cellular stipple at edges).
// Shaded with a density-gradient normal (sun puffiness), a short sun-march
// self-shadow (Beer), a powder dark-edge term, and forward scatter (silver lining).
// ============================================================================

// latitude weather bands: +ITCZ (equator) −subtropical highs (~25°) +storm belt (~55°)
float cloudLatBias(float aLat) {
  return 0.34 * exp(-aLat * aLat / 0.010)
       - 0.30 * exp(-(aLat - 0.27) * (aLat - 0.27) / 0.012)
       + 0.24 * exp(-(aLat - 0.58) * (aLat - 0.58) / 0.050);
}

// polar-tapered flow advection. 'bands' sets the zonal-jet count and 'phase'
// offsets the flow clock per deck, so the three decks DON'T all band identically
// (low = few broad bands, mid = more/tighter, high = a couple of wide streams).
vec3 cloudWarp(vec3 dir, float strength, float bands, float phase, float scale) {
  float taper = 1.0 - smoothstep(0.70, 0.96, abs(dir.y));
  float perStep = strength * taper;
  if (perStep > 0.001) {
    int steps = max(3, uQCloudWarp * 2);
    for (int i = 0; i < 8; i++) {
      if (i >= steps) break;
      vec3 f = sphereFlow(dir, scale, uFlowTime + phase, uQCloudOct, 0.5, 1.0, bands, 1.7, 0.55, 1.0);
      dir = normalize(dir - f * perStep);
    }
  }
  return dir;
}

// per-deck config
void cloudDeckCfg(int deck, out float freq, out int oct, out float billow, out vec3 stretch, out float flow, out float covBias, out float seed) {
  if (deck == 0)      { freq = 4.2; oct = min(7, uQCloudOct + 3); billow = 0.85; stretch = vec3(1.0);           flow = uCloudFlow * 0.050; covBias =  0.02; seed = uCloudSeed +   0.0; }
  else if (deck == 1) { freq = 2.5; oct = min(6, uQCloudOct + 2); billow = 0.35; stretch = vec3(1.0);           flow = uCloudFlow * 0.075; covBias = -0.06; seed = uCloudSeed + 300.0; }
  else                { freq = 3.0; oct = min(6, uQCloudOct + 2); billow = 0.0;  stretch = vec3(2.8, 0.55, 2.8); flow = uCloudFlow * 0.110; covBias = -0.13; seed = uCloudSeed + 600.0; }
}

// warp + drift a surface direction into a deck's cloud space
vec3 cloudDeckDir(vec3 w, int deck) {
  float freq; int oct; float billow; vec3 stretch; float flow; float covBias; float seed;
  cloudDeckCfg(deck, freq, oct, billow, stretch, flow, covBias, seed);
  float extra = (uVortexStrength > 0.12) ? min(0.02 * uVortexStrength, 0.30) : 0.0;
  // per-deck flow character so the decks distribute differently
  float bands = (deck == 0) ? 3.0 : (deck == 1) ? 5.0 : 2.0;
  float phase = (deck == 0) ? 0.0 : (deck == 1) ? 13.0 : 27.0;
  float fscale = (deck == 0) ? 2.4 : (deck == 1) ? 3.4 : 1.8;
  vec3 dir = cloudWarp(w, flow + extra, bands, phase, fscale);
  float a = uCloudShift * 6.28318530718;
  float ca = cos(a), sa = sin(a);
  return vec3(ca * dir.x - sa * dir.z, dir.y, sa * dir.x + ca * dir.z);
}

// full deck coverage at a cloud-space direction (no warp — caller warps once)
float cloudDeckCover(vec3 cdir, int deck) {
  float freq; int oct; float billow; vec3 stretch; float flow; float covBias; float seed;
  cloudDeckCfg(deck, freq, oct, billow, stretch, flow, covBias, seed);
  float t = uFlowTime;
  float aLat = abs(cdir.y);
  vec3 p = cdir * stretch * freq + seed;
  float f = fbm4(vec4(p, t * 0.10 + seed), oct, 0.56) * 0.5 + 0.5;
  float shape = f;
  if (billow > 0.01) {
    float b = 1.0 - abs(fbm4(vec4(p * 1.7 + 11.0, t * 0.13), max(3, oct - 2), 0.55));  // puffy tops
    shape = mix(f, clamp(f * b * 1.35, 0.0, 1.0), billow);
  }
  float sys = fbm4(vec4(cdir * 1.2 + seed + 40.0, t * 0.04), 3, 0.5) * 0.5 + 0.5;     // weather systems
  float cov = clamp(uCloudCover + covBias + cloudLatBias(aLat) + (sys - 0.5) * 0.55, 0.0, 1.0);
  float thr = mix(0.92, 0.22, cov);
  float density = smoothstep(thr, thr + 0.20, shape);
  // value-driven multi-scale breakup (solid cores, cellular stipple at edges)
  float amt = smoothstep(0.72, 0.14, density);
  if (amt > 0.01) {
    float cellN = fbm4(vec4(cdir * 7.0 + seed + 80.0, t * 0.2), 3, 0.55) * 0.55
                + fbm4(vec4(cdir * 20.0 + seed + 100.0, t * 0.4), 3, 0.6) * 0.30
                + fbm4(vec4(cdir * 42.0 + seed + 120.0, t * 0.6), 2, 0.62) * 0.15;   // tiny/near-pixel
    cellN = cellN * 0.5 + 0.5;
    float cells = mix(0.28, 1.0, smoothstep(0.32, 0.62, cellN));
    density *= mix(1.0, cells, amt);
  }
  // fair-weather cumulus SPECKS — tiny isolated puffs (~1–5 px from orbit) that
  // stipple the clearer fair-weather zones (the "prairie sky" dotting). Only on
  // the LOW deck, clustered by a low-freq mask, and only where the main deck is
  // thin so they populate open sky rather than piling onto solid banks. Two very
  // high frequencies AND-ed → sparse, small, size-varied dots.
  if (deck == 0) {
    float fair = fbm4(vec4(cdir * 1.7 + seed + 200.0, t * 0.05), 2, 0.5) * 0.5 + 0.5;
    float fairCov = clamp(uCloudCover + cloudLatBias(aLat), 0.0, 1.0);
    float s1 = fbm4(vec4(cdir * 26.0 + seed + 210.0, t * 0.30), 2, 0.60) * 0.5 + 0.5;
    float s2 = fbm4(vec4(cdir * 52.0 + seed + 230.0, t * 0.45), 2, 0.62) * 0.5 + 0.5;
    float specks = smoothstep(0.60, 0.72, s1) * smoothstep(0.58, 0.74, s2);
    specks *= smoothstep(0.30, 0.62, fair) * smoothstep(0.10, 0.45, fairCov) * (1.0 - density);
    density = max(density, specks * 0.85);
  }
  return clamp(density, 0.0, 1.0);
}

// cheap shape-only coverage for gradient/shadow taps (no billow/sys/breakup)
float cloudDeckCheap(vec3 cdir, int deck) {
  float freq; int oct; float billow; vec3 stretch; float flow; float covBias; float seed;
  cloudDeckCfg(deck, freq, oct, billow, stretch, flow, covBias, seed);
  float f = fbm4(vec4(cdir * stretch * freq + seed, uFlowTime * 0.10 + seed), max(3, oct - 2), 0.56) * 0.5 + 0.5;
  float cov = clamp(uCloudCover + covBias + cloudLatBias(abs(cdir.y)), 0.0, 1.0);
  float thr = mix(0.92, 0.22, cov);
  return smoothstep(thr, thr + 0.20, f);
}

void main() {
  if (uSurfaceMode > 0.5) {
    vec3 w = uvToDirEquirect(vUv);
    vec2 uv = vUv;
    float iceCover = texture(uIceTex, uv).r;
    float lat = asin(clamp(w.y, -1.0, 1.0));
    float h = heightAt(uv);
    // shared terrain central-difference (reused by snow slope-break, relief,
    // and river slope — one set of neighbour fetches instead of three).
    float dxT = 0.0, dyT = 0.0, slopeSnow = 0.0;
    if (uKindGas < 0.5) {
      vec2 tx = vec2(1.0 / 768.0, 1.0 / 384.0);
      float hpx = heightAt(vec2(fract(uv.x + tx.x), uv.y));
      float hmx = heightAt(vec2(fract(uv.x - tx.x), uv.y));
      float hpy = heightAt(vec2(uv.x, clamp(uv.y + tx.y, 0.0, 1.0)));
      float hmy = heightAt(vec2(uv.x, clamp(uv.y - tx.y, 0.0, 1.0)));
      dxT = hpx - hmx; dyT = hpy - hmy;
      slopeSnow = length(vec2(dxT * max(0.05, cos(lat)), dyT));
    }
    vec3 albedo;
    int gcls = 4;   // gas/other → single class
    if (uUseGasTex > 0.5) albedo = texture(uGasTex, uv).rgb;
    else if (uTerraform > 0.5) { albedo = classifyRocky(h, texture(uMoistTex, uv).r, lat, w, slopeSnow, iceCover); gcls = surfaceClass(h, texture(uMoistTex, uv).r, lat); }
    else { albedo = texture(uAlbedoTex, uv).rgb; gcls = surfaceClass(h, texture(uMoistTex, uv).r, lat); }
    albedo = applyGradient(albedo, gcls);   // colour-grade / gradient map (per-class targeting)
    // baked-style relief shade (fixed light so terrain reads 3D; no sun spot)
    if (uKindGas < 0.5 && uRelief > 0.001) {
      float kk = 1.5 * uRelief, kx = kk * max(0.05, cos(lat));
      float isWater = (h < uSeaLevel) ? 1.0 : 0.0;
      float shade = clamp(0.5 - dxT * kx * (1.0 - iceCover) - dyT * kk * (1.0 - iceCover), 0.0, 1.0);
      float factor = isWater > 0.5 ? 0.92 + shade * 0.16 : 0.7 + shade * 0.6;
      factor = 1.0 + (factor - 1.0) * (1.0 - iceCover);
      albedo *= factor;
    }
    // rivers (same rule as the live view: steep-pinch + fade into ice/snow)
    if (uHasRivers > 0.5 && uRiverStrength > 0.01 && uKindGas < 0.5 && h >= uSeaLevel) {
      float flow = texture(uFlowTex, uv).r;
      float slope = length(vec2(dxT, dyT));
      float th = clamp(0.90 - 0.30 * uRiverStrength, 0.28, 0.92);
      float riverT = smoothstep(th, th + 0.16, flow) * (1.0 - smoothstep(0.10, 0.26, slope));
      riverT *= smoothstep(uSeaLevel, uSeaLevel + 0.015, h);
      float absLatR = abs(lat) * 0.63661977;
      float climate = absLatR + max(h - uSeaLevel, 0.0) * 0.85;
      float coldFade = clamp(max(iceCover, smoothstep(uIceLine - 0.20, uIceLine + 0.02, climate)), 0.0, 1.0);
      riverT *= (1.0 - coldFade);
      if (riverT > 0.001) {
        vec3 rc = mix(uPalShore, uPalWater, clamp(flow, 0.0, 1.0));
        albedo = mix(albedo, rc, riverT * clamp(0.55 + 0.35 * uRiverStrength, 0.0, 1.0));
      }
    }
    outColor = vec4(clamp(albedo, 0.0, 1.0), 1.0);
    return;
  }

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
      // penumbra: the halo is the atmosphere lit from the side, so it glows on
      // the day limb and falls into shadow on the night limb along a soft curve
      // (a faint floor keeps a thin night rim + warm sunset tint at the boundary)
      float sideRaw = dx * l.x + dy * l.y;
      float glowSide = smoothstep(-0.40, 0.30, sideRaw);
      float alpha = min(0.98, falloff * (0.10 + 0.95 * glowSide) * (uAtmThickness * 3.0) * uAtmDensity) * uSunFalloff;
      float band = clamp(1.0 - abs(sideRaw) * 3.0, 0.0, 1.0);
      vec3 haloC = mix(uAtmColor, vec3(1.0, 0.52, 0.30), band * 0.45);
      outColor = vec4(haloC * uSunColor, alpha);
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

  float h = heightAt(uv);

  // ---- albedo ----
  vec3 albedo;
  float iceCover = texture(uIceTex, uv).r;
  float lat = asin(clamp(w.y, -1.0, 1.0));
  // Shared terrain central-difference for rocky bodies — one set of neighbour
  // fetches reused by the snow slope-break, relief shading, and river slope
  // (previously each of the three re-fetched the same four texels).
  float dxT = 0.0, dyT = 0.0, slopeSnow = 0.0;
  if (uKindGas < 0.5) {
    vec2 texel = vec2(1.0 / 768.0, 1.0 / 384.0);
    float hpx = heightAt(vec2(fract(uv.x + texel.x), uv.y));
    float hmx = heightAt(vec2(fract(uv.x - texel.x), uv.y));
    float hpy = heightAt(vec2(uv.x, clamp(uv.y + texel.y, 0.0, 1.0)));
    float hmy = heightAt(vec2(uv.x, clamp(uv.y - texel.y, 0.0, 1.0)));
    dxT = hpx - hmx; dyT = hpy - hmy;
    slopeSnow = length(vec2(dxT * max(0.05, cos(lat)), dyT));
  }
  int gcls = 4;   // gas/other → single class
  if (uUseGasTex > 0.5) {
    albedo = texture(uGasTex, uv).rgb;
  } else if (uTerraform > 0.5) {
    float m = texture(uMoistTex, uv).r;
    albedo = classifyRocky(h, m, lat, w, slopeSnow, iceCover);
    gcls = surfaceClass(h, m, lat);
  } else {
    albedo = texture(uAlbedoTex, uv).rgb;
    gcls = surfaceClass(h, texture(uMoistTex, uv).r, lat);
  }
  // brown-dwarf emission uses albedo luminance as the hot-rift mask; capture it
  // BEFORE the grade so recolouring doesn't move where the interior shows through
  float baseLuma = dot(albedo, vec3(0.299, 0.587, 0.114));
  albedo = applyGradient(albedo, gcls);   // colour-grade / gradient map (per-class targeting)

  // ---- relief shading ----
  // Two components: (1) the CPU renderer's exact baked shade formula, applied
  // live as an albedo factor — this carries the visible terrain texture and
  // matches classic mode's relief strength; (2) an enhanced-only normal
  // perturbation so grazing light additionally rakes across mountains.
  if (uKindGas < 0.5 && uRelief > 0.001) {
    // dxT/dyT are the shared central differences computed above (unhalved; the
    // x-gradient gets cos(lat) damping via kx below — equirect texels shrink
    // toward the poles), matching the CPU relief convention.
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
  // riverCoverage is exported to the water-specular block so rivers/lakes catch
  // the sun's Fresnel glint exactly like the oceans do (no dead matte water).
  float riverCoverage = 0.0;
  if (uHasRivers > 0.5 && uRiverStrength > 0.01 && uKindGas < 0.5 && h >= uSeaLevel) {
    float flow = texture(uFlowTex, uv).r;
    float slope = length(vec2(dxT, dyT));   // shared central difference (above)
    // RIVERS slider lowers the discharge threshold (more tributaries appear)
    // and raises opacity; rivers sit in valleys and fade into the sea at the
    // coast so they blend seamlessly
    float th = clamp(0.90 - 0.30 * uRiverStrength, 0.28, 0.92);
    // pinch out on steep ground (waterfalls/gorges, not open channels)
    float riverT = smoothstep(th, th + 0.16, flow) * (1.0 - smoothstep(0.10, 0.26, slope));
    riverT *= smoothstep(uSeaLevel, uSeaLevel + 0.015, h);
    // fade into ice/snow: full polar ice (iceCover) AND cold snowy uplands
    // (climate = latitude + altitude approaching the ice line), so rivers
    // vanish into the frozen interiors instead of drawing over the snow
    float absLatR = abs(lat) * 0.63661977;   // /(PI/2)
    float climate = absLatR + max(h - uSeaLevel, 0.0) * 0.85;
    float coldFade = clamp(max(iceCover, smoothstep(uIceLine - 0.20, uIceLine + 0.02, climate)), 0.0, 1.0);
    riverT *= (1.0 - coldFade);
    if (riverT > 0.001) {
      vec3 riverCol = mix(uPalShore, uPalWater, clamp(flow, 0.0, 1.0));
      albedo = mix(albedo, riverCol, riverT * clamp(0.55 + 0.35 * uRiverStrength, 0.0, 1.0));
      // how "wet" the surface reads here — drives specular below (deeper/wider
      // channels reflect more). Opacity-matched to the tint so a faint river
      // gets a faint glint.
      riverCoverage = riverT * clamp(0.55 + 0.35 * uRiverStrength, 0.0, 1.0);
    }
  }

  // ---- per-channel sun lighting / volumetric self-emission ----
  float ambBase = uKindGas > 0.5 ? 0.13 : 0.08;
  vec3 lit = vec3(1.0);
  vec3 c;
  if (uSelfEmit > 0.5) {
    // albedo = the live flow dye (dark cloud bands + advected hot-rift streaks).
    // Dye luminance is the rift mask: bright dye lets the hot interior through.
    // Use the PRE-grade luminance so a gradient map recolours the glow without
    // moving where the hot interior shows through.
    float rift = baseLuma;
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

  // ---- clouds (multi-deck, volumetric) ----
  if (uHasClouds > 0.5) {
    vec3 lC = viewToPlanet(l);                       // sun direction in planet/cloud space
    float ambient = 0.34 + 0.16 * uSunFalloff;
    vec3 ashTint = uCloudColor;
    if (uHasAsh > 0.5) { float ash = texture(uAshTex, vec2(fract(uv.x + uCloudShift), uv.y)).r; if (ash > 0.02) ashTint = mix(uCloudColor, uAshCloud, min(ash, 1.0)); }
    // ground shadow cast by the LOW deck (sampled offset toward the sun), applied
    // before the decks so it darkens the surface but not the clouds themselves
    if (light > 0.05 && uCloudAmtLow > 0.002) {
      vec3 nS = normalize(vec3(n.xy / (1.0 + uCloudAltLow), n.z));
      vec3 sw = viewToPlanet(normalize(nS + l * (0.05 + uCloudAltLow * 1.5)));
      float shc = cloudDeckCover(cloudDeckDir(sw, 0), 0) * uCloudAmtLow;
      c *= 1.0 - shc * 0.32 * light;
    }
    // composite decks bottom → top: LOW (opaque cumulus) → MID → HIGH (thin cirrus)
    for (int deck = 0; deck < 3; deck++) {
      float amt = (deck == 0) ? uCloudAmtLow : (deck == 1) ? uCloudAmtMid : uCloudAmtHigh;
      if (amt <= 0.002) continue;
      float alt = (deck == 0) ? uCloudAltLow : (deck == 1) ? uCloudAltMid : uCloudAltHigh;
      vec3 nD = normalize(vec3(n.xy / (1.0 + alt), n.z));    // per-deck parallax shell
      vec3 cdir = cloudDeckDir(viewToPlanet(nD), deck);
      float d = cloudDeckCover(cdir, deck) * amt * uCloudMul;
      if (d <= 0.01) continue;
      // density-gradient normal → sun puffiness (cheap shape taps)
      vec3 tX = normalize(cross(vec3(0.0, 1.0, 0.0), cdir) + vec3(1e-4, 0.0, 0.0));
      vec3 tY = cross(cdir, tX);
      float eps = (deck == 2) ? 0.04 : 0.022;
      float c0 = cloudDeckCheap(cdir, deck);
      float gx = cloudDeckCheap(normalize(cdir + tX * eps), deck) - c0;
      float gy = cloudDeckCheap(normalize(cdir + tY * eps), deck) - c0;
      float bumpK = (deck == 2) ? 3.0 : 8.0;                 // cirrus flatter than cumulus
      vec3 cn = normalize(cdir - (tX * gx + tY * gy) * bumpK);
      float sunLit = clamp(dot(cn, lC) * 0.7 + 0.35, 0.0, 1.0);
      // self-shadow (Beer) — short march toward the sun; low deck is thickest
      float sh = cloudDeckCheap(normalize(cdir + lC * 0.03), deck)
               + cloudDeckCheap(normalize(cdir + lC * 0.07), deck) * 0.6;
      float trans = exp(-sh * ((deck == 0) ? 2.2 : 1.2));
      float powder = 1.0 - exp(-d * 3.5);                    // dark-edge powder
      // FORWARD SCATTER — the SCATTER slider multiplies the sunward lit term so
      // sun-facing cloud brightens toward a hot silver, plus a terminator rim
      // lift (silver lining). Scatter 0 = flat lit; higher = strong glow.
      float fwd = pow(clamp(dot(cn, lC), 0.0, 1.0), 3.0);
      float scatBoost = 1.0 + uCloudScatter * (1.4 * fwd + 0.5 * pow(1.0 - light, 2.0));
      vec3 sunTerm = uSunColor * (sunLit * trans * scatBoost);
      // dark-side PENUMBRA: the planet blocks sunlight, so clouds fall into
      // shadow past the terminator along a soft curve. Higher decks catch light
      // a little further round the limb (altitude → later sunset), and a thin
      // starlit floor keeps night clouds barely visible rather than pure black.
      float cloudDay = smoothstep(-0.26, 0.12, ndotl + alt * 0.7);
      float dayAmb = mix(0.045, ambient, cloudDay);
      vec3 shade = ashTint * (dayAmb + sunTerm * light * 1.15);
      c = mix(c, clamp(shade, 0.0, 3.0), clamp(d * mix(0.8, 1.0, powder), 0.0, 1.0));
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
    // dark-side PENUMBRA: the atmosphere scatters little on the night side, so
    // fade the haze along a soft terminator curve (a faint floor keeps a thin
    // night limb). A warm SUNSET tint blooms in the terminator band.
    float atmDay = smoothstep(-0.30, 0.16, ndotl);
    float haze = min(0.97, (rimHaze + generalHaze) * uAtmDensity) * uSunFalloff * mix(0.10, 1.0, atmDay);
    float band = clamp(1.0 - abs(ndotl) * 3.2, 0.0, 1.0);   // peaks at the terminator
    vec3 atmC = mix(uAtmColor, vec3(1.0, 0.52, 0.30), band * 0.5);
    c = mix(c, atmC * uSunColor, haze);
  }

  // ---- water specular + Fresnel glint ----
  // (composited after clouds/haze like the CPU renderer: highlights stay
  // visible through limb haze rather than being lerped away)
  if (uHasWaterMask > 0.5) {
    float mask = (uTerraform > 0.5)
      ? smoothstep(0.0, 0.10, clamp(uSeaLevel + 0.05 - h, 0.0, 0.10)) * (1.0 - iceCover)
      : texture(uWaterTex, uv).r;
    // rivers & lakes are open water too — fold their coverage into the specular
    // mask so they glint like the seas instead of reading as matte painted lines
    mask = max(mask, riverCoverage);
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
