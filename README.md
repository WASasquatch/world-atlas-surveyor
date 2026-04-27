# WAS — World Atlas Surveyor

Generate seeded exoplanets, dwarf planets, asteroids, and brown dwarfs with full atmospheric models, weather systems, dynamic lighting, and exportable survey cards. Built around a CRT / space-instrument console aesthetic.

## Quick Start

Open `index.html` in any modern browser. No build step, no dependencies, no internet connection required. The app auto-generates Earth on first load — type any string into the seed field and click Generate to roll a new world. Same seed always produces the same body.

## Features

### Body Classes

Eleven generated planetary types, each with their own pipeline:

| Class | Notes |
|-------|-------|
| **Terrestrial** | Continents, oceans, biome-zoned vegetation, polar caps, mountain snowcaps, alpine belts |
| **Ocean World** | Globe-spanning seas with sparse archipelagos |
| **Desert** | Dune seas, salt flats, wind-carved mesas |
| **Ice / Frozen** | Fully glaciated cryo-world surfaces |
| **Volcanic** | Lava seas with active flows and ash clouds |
| **Cratered** | Heavily-impacted airless rocky bodies |
| **Dwarf Planet** | Pluto/Eris/Ceres-scale bodies, occasional Y-axis oblation (Haumea-like) |
| **Asteroid** | Irregular silhouettes via precomputed 3D shape-deformation map |
| **Gas Giant** | Banded atmospheres with storms (Jupiter-class) |
| **Ice Giant** | Smooth methane atmospheres (Neptune-class) |
| **Brown Dwarf** | Self-emitting failed stars with hot interior glow visible through cloud rifts |

Each class has 2–4 mineralogical or atmospheric variants determined by the seed: terrestrial worlds roll Tropical / Verdant / Violet Biosphere / Autumnal palettes; asteroids roll S / C / M / Iron-Rich types; brown dwarfs roll L / T / Y class temperature ranges; and so on.

### Earth Mode

Type `EARTH` as the seed and the generator switches to a recognizable Earth using an embedded NASA Blue Marble water mask and cloud reference. Changing any control automatically rolls a new random designation, leaving Earth mode behind.

### Atmosphere & Surface Modeling

The atmospheric model uses a unified blend-based scattering pipeline with continuous inner-haze and outer-halo, sun-tinted by stellar class, with limb darkening and per-channel lighting. Atmospheres come in four thicknesses (none / thin / thick / dense) and class-appropriate compositions. Polar ice caps use a hard-thresholded boundary with Voronoi cell breakup at the transition zone, producing distinct icebergs and floes rather than a smooth gradient. Mountain snow respects exposed rock through high-frequency surface noise. Cloud shadows project onto the surface based on sun direction. Aurora ribbons render at high latitudes on bodies with sufficient atmospheric thickness or gas-kind composition, with vertical ray striations and altitude-tinted coloring.

### Star System Controls

The simulated parent star supports azimuth, elevation, intensity (POWER), and stellar-class hue spanning M-K-G-F-A-B. Hue affects per-channel lighting so a red M-dwarf produces warmer surface tones and dimmer atmospheric scattering, while a blue B-class star washes lit hemispheres with cool light. A separate view-tilt slider controls camera angle for inspecting polar regions or auroras.

### Card Export

The `EXPORT WORLD` button produces a 2048×4096 PNG survey card laid out as a multi-module instrument panel: physical and atmospheric data in the upper section, detected resources and surface features as side-by-side modules, an unwrapped equirectangular surface map, spectral signature with absorption bands at real wavelengths for detected gases, a thermal IR map, orbital and geophysical parameters, and an observation log with galactic coordinates and observer ID. The center planet image is cropped from the live render.

## Controls Reference

| Control | Effect |
|---------|--------|
| Seed | Any string. Same seed → same world. Type `EARTH` for Earth mode. |
| Type | `Auto` lets the seed pick a class, or force a specific class. |
| Atmosphere | `Auto` for class-appropriate atmosphere, or override (thin/thick/dense/none). |
| Size | Affects radius, mass, gravity. Biases `Auto` classification toward larger or smaller body types. |
| Star azimuth / elevation | Light direction. |
| Star intensity | Sun brightness. Low values produce dim, faintly-lit worlds. |
| Star hue | Stellar class color (M = red, G = sun-like, B = blue). |
| View tilt | Camera angle (positive = view from above). |
| Auto-rotate | Slow continuous rotation animation. |
| Pixel scale | 1×–4× downsampling for the chunky pixel-art look. |
| Displacement | Surface relief intensity for rocky bodies. |
| Generate | Re-rolls with a new random designation, or refreshes the current seed. |

## Technical Notes

The entire application is one HTML file (~5,000 lines, ~200KB) with no external dependencies — all code, fonts, and embedded reference data are inline. Deterministic generation comes from a mulberry32 PRNG seeded by FNV-1a hashing of the seed string, paired with multiple Perlin3D and Worley3D noise instances per planet.

Rendering is a custom CPU rasterizer that writes directly to ImageData, with no WebGL. At generation time, each planet bakes 768×384 equirectangular textures (height, color, cloud, ice, water mask, and optionally a shape factor map for non-spherical bodies). The frame loop performs the silhouette test (sphere or shape-map lookup for irregular bodies), bilinearly samples textures, applies per-channel lighting, overlays clouds and cloud shadows, computes atmospheric scattering as continuous inner-haze plus outer-halo, draws auroras, adds specular highlights on water surfaces, and composites the result over a separately-cached starfield with twinkle and chromatic flicker.

The Earth water mask and NASA Blue Marble cloud reference are stored as base64-encoded gzipped data inline — roughly 5KB and 17KB respectively after compression, decoded asynchronously via the browser's `DecompressionStream` API.

Browser requirements: ES2020+, Canvas2D with ImageData, and `DecompressionStream`. Tested on recent Chrome, Firefox, Safari, and Edge.

## Credits

Cloud reference texture derived from NASA's Blue Marble project; Earth water mask similarly derived from public NASA imagery.
