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

import { SIMPLEX_3D, SIMPLEX_4D, FBM_4D, WORLEY_3D } from './noise-glsl.js';

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
uniform vec2  uTexel;          // 1/mapW, 1/mapH (baked-map texel size)
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
uniform float uRiverStyle;     // 0 = water, 1 = lava (volcanic), 2 = ice/glacial
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
// CLOUD SYSTEM — volumetric, multi-deck, height-displaced.
// Three altitude decks share one marched shell so clouds read as VOLUME (soft
// tops, self-shadowed bases, towering cumulus) rather than a flat clipped decal:
//   0 LOW  — cumulus / stratocumulus: perlin + voronoi BILLOW, cellular, towering
//   1 MID  — alto / frontal banks: perlin-billow banks, moderate coverage
//   2 HIGH — cirrus: latitudinally-stretched wispy streaks, thin/translucent
// Each deck's COLUMN height is a CONTINUOUS field (no hard threshold) built from
// low-freq perlin coverage, perlin billow (puffy bodies) and Worley erosion
// (voronoi cauliflower edges). A short vertical raymarch then integrates the
// three decks' vertical profiles with Beer self-shadowing, so height reads as
// tone: bright sunlit tops fading to shadowed bases, tall cumulus where dense.
// Flow-advected (polar-tapered so no pole spiral) with per-deck weather bands.
// ============================================================================

// latitude weather bands: +ITCZ (equator) −subtropical highs (~25°) +storm belt
// (~55°). Kept GENTLE — a subtle bias toward Earth-like cloudy/clear latitudes,
// not hard rings (the coverage noise + curl flow dominate the distribution).
float cloudLatBias(float aLat) {
  return 0.18 * exp(-aLat * aLat / 0.012)
       - 0.16 * exp(-(aLat - 0.27) * (aLat - 0.27) / 0.014)
       + 0.13 * exp(-(aLat - 0.58) * (aLat - 0.58) / 0.060);
}

// Cheap curl-noise flow for clouds. Same idea as the gas-giant sphereFlow
// (gradient of a noise field, projected onto the tangent plane, rotated 90°
// about the radial axis → divergence-free swirl) PLUS a zonal-band term — but
// built from a single snoise3 gradient instead of a 6-octave 4D fBm gradient.
// That matters for COMPILE time: the full sphereFlow unrolls to ~36 snoise4 per
// step, and warping every cloud deck with it made the D3D/ANGLE shader compiler
// take ~100 s (a browser lock-up). At the small default warp strengths the extra
// octaves were barely visible anyway; this keeps the swirl + banding for a
// fraction of the compiled instruction count.
vec3 cloudFlowVec(vec3 n, float scale, float phase, float bands, float bandAmp) {
  vec3 p = n * scale + phase;
  float e = 0.35;
  vec3 g = vec3(
    snoise3(p + vec3(e, 0.0, 0.0)) - snoise3(p - vec3(e, 0.0, 0.0)),
    snoise3(p + vec3(0.0, e, 0.0)) - snoise3(p - vec3(0.0, e, 0.0)),
    snoise3(p + vec3(0.0, 0.0, e)) - snoise3(p - vec3(0.0, 0.0, e)));
  vec3 v = cross(n, g - n * dot(g, n)) * 1.5;   // curl (tangential, divergence-free)
  if (bands > 0.0) {
    float lat = asin(clamp(n.y, -1.0, 1.0));
    vec3 east = vec3(-n.z, 0.0, n.x);
    float m = length(east);
    if (m > 1e-5) {
      float cb = cos(lat * bands);
      float env = 0.45 + 0.55 * cos(lat);
      v += (east / m) * (env * sign(cb) * abs(cb) * bandAmp);
    }
  }
  return v;
}

// polar-tapered flow advection. 'bands' sets the zonal-jet count and 'phase'
// offsets the flow clock per deck, so the three decks DON'T all band identically.
vec3 cloudWarp(vec3 dir, float strength, float bands, float phase, float scale) {
  float taper = 1.0 - smoothstep(0.70, 0.96, abs(dir.y));
  float perStep = strength * taper;
  if (perStep > 0.001) {
    for (int i = 0; i < 2; i++) {   // two cheap advection steps
      vec3 f = cloudFlowVec(dir, scale, uFlowTime + phase + float(i) * 4.1, bands, 0.55);
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

// Continuous cloud COLUMN height/potential (0..1) at a cloud-space direction
// (caller warps once). NOT hard-thresholded — the soft, wide coverage ramp is
// what lets the vertical march carve VOLUME out of it instead of stamping a flat
// decal. Structure = low-freq perlin coverage, perlin billow (puffy cauliflower
// bodies), and Worley erosion (voronoi cellular edges) on the two lower decks.
float cloudColumn(vec3 cdir, int deck) {
  float freq; int oct; float billow; vec3 stretch; float flow; float covBias; float seed;
  cloudDeckCfg(deck, freq, oct, billow, stretch, flow, covBias, seed);
  float t = uFlowTime;
  float aLat = abs(cdir.y);
  vec3 p = cdir * stretch * freq + seed;

  float fb = fbm4(vec4(p, t * 0.10 + seed), oct, 0.56) * 0.5 + 0.5;
  // perlin BILLOW — |fbm| makes rounded puffy lobes (dense interiors, thin dark
  // creases along the zero-crossings between them), the cauliflower cumulus look.
  // Must be abs(), NOT 1-abs(): 1-abs() is RIDGED noise, which inverts it into
  // bright meandering ridge-lines around hollow centres. Mixed in BEFORE the
  // coverage ramp so the shape survives instead of washing out to haze.
  if (billow > 0.01) {
    float bil = abs(fbm4(vec4(p * 1.9 + 11.0, t * 0.13), max(3, oct - 1), 0.55));
    fb = mix(fb, clamp(fb * 0.45 + bil * 0.72, 0.0, 1.0), billow);
  }
  // FINE high-frequency detail — two cheap snoise3 taps ABOVE the base fbm's
  // finest octave, so cloud edges and wisps read closer to the surface's
  // resolution instead of soft/low-res. snoise3 (3D) compiles far cheaper than
  // another 4D-fbm octave, so it stays within the D3D shader-compile budget.
  float hf = snoise3(cdir * stretch * (freq * 17.0) + seed + 400.0) * 0.6
           + snoise3(cdir * stretch * (freq * 38.0) + seed + 430.0) * 0.4;
  fb = clamp(fb + hf * 0.15, 0.0, 1.0);
  // broad weather systems — coherent cloudy vs. clear regions
  float sys = fbm4(vec4(cdir * 1.2 + seed + 40.0, t * 0.04), 3, 0.5) * 0.5 + 0.5;
  float cov = clamp(uCloudCover + covBias + cloudLatBias(aLat) + (sys - 0.5) * 0.55, 0.0, 1.0);
  // SOFT coverage remap — a WIDE band (vs. the old 0.20 clip) leaves a graded
  // shoulder the march turns into rounded volume rather than a clipped rim.
  float lo = 1.0 - cov;
  float h = smoothstep(lo, min(lo + 0.46, 1.0), fb);   // was 0.55; tighter → crisper edges

  // VORONOI billow erosion — Worley border-distance (1 at cell centres) eats the
  // thin edges into stacked cauliflower cells while leaving solid cores intact.
  // LOW deck / one tap only: each worley call unrolls a 27-cell loop, so extra
  // taps bloat the compiled shader. One on the cumulus deck carries the look.
  if (deck == 0 && h > 0.001) {
    float edge = 1.0 - smoothstep(0.0, 0.55, h);
    float wb = 1.0 - worley3(cdir * (freq * 2.4) + seed + 300.0);
    h *= mix(1.0, clamp(wb * 1.3, 0.0, 1.0), edge * 0.85);
  }

  return clamp(h, 0.0, 1.0);
}

// cheap column (no billow / worley / specks) for density-gradient shading taps
float cloudColumnCheap(vec3 cdir, int deck) {
  float freq; int oct; float billow; vec3 stretch; float flow; float covBias; float seed;
  cloudDeckCfg(deck, freq, oct, billow, stretch, flow, covBias, seed);
  float fb = fbm4(vec4(cdir * stretch * freq + seed, uFlowTime * 0.10 + seed), max(3, oct - 2), 0.56) * 0.5 + 0.5;
  float cov = clamp(uCloudCover + covBias + cloudLatBias(abs(cdir.y)), 0.0, 1.0);
  return smoothstep(1.0 - cov, min(1.0 - cov + 0.55, 1.0), fb);
}

// vertical density profile of a deck within the normalized shell (u in [0,1]):
// soft rounded base, dense middle, tapered/eroded top (anvil). 'top' is pushed
// up by the column height so denser columns tower higher.
float bandProfile(float u, float base, float top) {
  if (u <= base || u >= top) return 0.0;
  float t = (u - base) / max(top - base, 1e-4);
  return smoothstep(0.0, 0.14, t) * (1.0 - smoothstep(0.5, 1.0, t));
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
      vec2 tx = uTexel;
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
    // rivers (same rule as the live view: steep-pinch + style by world type).
    // Flat map — lava reads as a bright hot channel colour (no lighting here).
    if (uHasRivers > 0.5 && uRiverStrength > 0.01 && uKindGas < 0.5 && h >= uSeaLevel) {
      float flow = texture(uFlowTex, uv).r;
      float slope = length(vec2(dxT, dyT));
      float th = clamp(0.90 - 0.30 * uRiverStrength, 0.28, 0.92);
      float riverT = smoothstep(th, th + 0.16, flow) * (1.0 - smoothstep(0.10, 0.26, slope));
      riverT *= smoothstep(uSeaLevel, uSeaLevel + 0.015, h);
      if (uRiverStyle < 0.5) {
        float absLatR = abs(lat) * 0.63661977;
        float climate = absLatR + max(h - uSeaLevel, 0.0) * 0.85;
        // fade rivers INTO the ice (see live-view block for rationale)
        float coldFade = clamp(max(smoothstep(0.10, 0.55, iceCover),
                                   smoothstep(uIceLine - 0.02, uIceLine + 0.16, climate)), 0.0, 1.0);
        riverT *= (1.0 - coldFade);
      }
      if (riverT > 0.001) {
        float op = riverT * clamp(0.55 + 0.35 * uRiverStrength, 0.0, 1.0);
        vec3 rc = (uRiverStyle > 1.5) ? mix(uPalShore, vec3(0.80, 0.90, 1.0), clamp(flow, 0.0, 1.0))
                : (uRiverStyle > 0.5) ? mix(vec3(0.75, 0.16, 0.03), vec3(1.0, 0.62, 0.16), clamp(flow, 0.0, 1.0))
                                      : mix(uPalShore, uPalWater, clamp(flow, 0.0, 1.0));
        albedo = mix(albedo, rc, op);
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
    vec2 texel = uTexel;
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
  float lavaRiverT = 0.0;   // volcanic: emissive lava channels added after lighting
  if (uHasRivers > 0.5 && uRiverStrength > 0.01 && uKindGas < 0.5 && h >= uSeaLevel) {
    float flow = texture(uFlowTex, uv).r;
    float slope = length(vec2(dxT, dyT));   // shared central difference (above)
    // RIVERS slider lowers the discharge threshold (more tributaries appear)
    // and raises opacity; channels sit in valleys and pinch out on steep ground.
    float th = clamp(0.90 - 0.30 * uRiverStrength, 0.28, 0.92);
    float riverT = smoothstep(th, th + 0.16, flow) * (1.0 - smoothstep(0.10, 0.26, slope));
    riverT *= smoothstep(uSeaLevel, uSeaLevel + 0.015, h);
    // WATER rivers fade into ice/snow; LAVA (hot) and GLACIAL (already frozen)
    // channels do not vanish into cold.
    if (uRiverStyle < 0.5) {
      float absLatR = abs(lat) * 0.63661977;   // /(PI/2)
      float climate = absLatR + max(h - uSeaLevel, 0.0) * 0.85;
      // Rivers run INTO the ice and dwindle there, rather than dying out in the
      // temperate zone ahead of it: fade primarily by actual ice coverage (kept
      // ~full until ice appears, gone once it thickens), with a climate backstop
      // anchored AT the ice line so hard-edged sheets still get a gradient.
      float coldFade = clamp(max(smoothstep(0.10, 0.55, iceCover),
                                 smoothstep(uIceLine - 0.02, uIceLine + 0.16, climate)), 0.0, 1.0);
      riverT *= (1.0 - coldFade);
    }
    if (riverT > 0.001) {
      float op = riverT * clamp(0.55 + 0.35 * uRiverStrength, 0.0, 1.0);
      if (uRiverStyle > 1.5) {
        // ICE — glacial meltwater channels: pale blue, matte
        albedo = mix(albedo, mix(uPalShore, vec3(0.80, 0.90, 1.0), clamp(flow, 0.0, 1.0)), op);
      } else if (uRiverStyle > 0.5) {
        // LAVA — cool basalt crust in the channel here; the hot emissive glow is
        // added post-lighting (below) so it blooms and lights the night side.
        albedo = mix(albedo, vec3(0.12, 0.05, 0.03), op * 0.7);
        lavaRiverT = op;
      } else {
        // WATER — deeper/wider channels reflect more (drives specular below)
        albedo = mix(albedo, mix(uPalShore, uPalWater, clamp(flow, 0.0, 1.0)), op);
        riverCoverage = op;
      }
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

  // ---- clouds (volumetric, height-displaced multi-deck) ----
  // Kept deliberately FLAT (one shared warp, one shared gradient normal, decks
  // inlined as scalars, single noise-free march): the per-deck warp/gradient
  // version tripled the shader's most expensive term (curl-noise flow) and made
  // the D3D/ANGLE shader compiler take ~100 s — a browser lock-up on first load.
  if (uHasClouds > 0.5) {
    vec3 lC = viewToPlanet(l);                       // sun direction in planet/cloud space
    float ambient = 0.34 + 0.16 * uSunFalloff;
    vec3 ashTint = uCloudColor;
    if (uHasAsh > 0.5) { float ash = texture(uAshTex, vec2(fract(uv.x + uCloudShift), uv.y)).r; if (ash > 0.02) ashTint = mix(uCloudColor, uAshCloud, min(ash, 1.0)); }

    float amt0 = uCloudAmtLow, amt1 = uCloudAmtMid, amt2 = uCloudAmtHigh;
    // ONE shared flow-warp for all three decks; cloudColumn still applies each
    // deck's own frequency/stretch/billow, so the decks stay visually distinct.
    vec3 cdir = cloudDeckDir(viewToPlanet(normalize(vec3(n.xy / (1.0 + uCloudAltMid), n.z))), 0);

    // ground shadow cast by the LOW deck
    if (light > 0.05 && amt0 > 0.002) c *= 1.0 - cloudColumnCheap(cdir, 0) * amt0 * 0.32 * light;

    float H0 = amt0 > 0.002 ? cloudColumn(cdir, 0) : 0.0;
    float H1 = amt1 > 0.002 ? cloudColumn(cdir, 1) : 0.0;
    float H2 = amt2 > 0.002 ? cloudColumn(cdir, 2) : 0.0;
    float anyCloud = max(max(H0 * amt0, H1 * amt1), H2 * amt2);

    if (anyCloud > 0.004) {
      // ONE shared density-gradient normal → sun puffiness (3 cheap taps, not 9)
      vec3 tX = normalize(cross(vec3(0.0, 1.0, 0.0), cdir) + vec3(1e-4, 0.0, 0.0));
      vec3 tY = cross(cdir, tX);
      float c0 = cloudColumnCheap(cdir, 0);
      float gx = cloudColumnCheap(normalize(cdir + tX * 0.024), 0) - c0;
      float gy = cloudColumnCheap(normalize(cdir + tY * 0.024), 0) - c0;
      vec3 cn = normalize(cdir - (tX * gx + tY * gy) * 8.0);
      float sunLit = clamp(dot(cn, lC) * 0.7 + 0.35, 0.0, 1.0);
      float fwd = pow(clamp(dot(cn, lC), 0.0, 1.0), 3.0);
      float scat = 1.0 + uCloudScatter * (1.4 * fwd + 0.5 * pow(1.0 - light, 2.0));
      float cloudDay = smoothstep(-0.26, 0.12, ndotl + uCloudAltMid * 0.7);

      // LOW towers rise with density; MID/HIGH sit in fixed shell bands. Short
      // front→back (top→surface) march; Beer self-shadow from the cloud ABOVE
      // each sample makes tops bright and bases dark — that gradient IS the volume.
      float top0 = 0.16 + 0.55 * H0;
      int STEPS = 8 + uQCloudOct * 2;                      // 12 (low) .. 16 (ultra)
      float du = 1.0 / float(STEPS);
      float T = 1.0; vec3 Lsum = vec3(0.0); float odAbove = 0.0;
      float ext = 6.5 * max(uCloudMul, 0.0);
      for (int i = 0; i < 24; i++) {
        if (i >= STEPS) break;
        float u = 1.0 - (float(i) + 0.5) * du;
        float dens = bandProfile(u, 0.0, top0) * H0 * amt0
                   + bandProfile(u, 0.32, 0.62) * H1 * amt1
                   + bandProfile(u, 0.68, 1.0) * H2 * amt2;
        if (dens > 0.0008) {
          float od = dens * du * ext;
          float shadow = exp(-odAbove * ext * 0.55);        // Beer self-shadow from above
          // ambient is occluded by overlying cloud too, so shadowed bases sink
          // darker than sunlit tops — that deepened gradient reads as volume.
          float dayAmb = mix(0.045, ambient, cloudDay) * mix(0.5, 1.0, shadow);
          vec3 sunTerm = uSunColor * (sunLit * scat * shadow * light * 1.15);
          float powder = 1.0 - exp(-dens * du * 8.0);       // dark-edge powder
          float a = 1.0 - exp(-od);
          Lsum += T * (ashTint * (dayAmb + sunTerm)) * a * mix(0.75, 1.0, powder);
          T *= 1.0 - a;
        }
        odAbove += dens * du;
        if (T < 0.02) break;
      }
      c = c * T + clamp(Lsum, 0.0, 4.0);
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
  // lava RIVERS — emissive glowing channels the erosion flow carved into the
  // volcanic uplands. HDR-boosted so they bloom and light the night side, with
  // a hotter core (brighter where the discharge is strongest).
  if (lavaRiverT > 0.001) {
    // fade out right at the lava-sea shoreline so the river glow doesn't stack
    // with the lava-seas emissive into an over-bright seam at the coast
    float shoreFade = smoothstep(uSeaLevel + 0.006, uSeaLevel + 0.05, h);
    vec3 lavaHot = mix(vec3(0.85, 0.22, 0.03), vec3(1.0, 0.66, 0.18), clamp(lavaRiverT, 0.0, 1.0));
    c += lavaHot * lavaRiverT * shoreFade * (1.0 - 0.4 * light) * 1.7;
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
