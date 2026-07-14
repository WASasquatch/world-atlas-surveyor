# WAS — World Atlas Surveyor

Generate seeded exoplanets, dwarf planets, asteroids, and brown dwarfs with full atmospheric models, weather systems, dynamic lighting, and exportable survey cards. Built around a CRT / space-instrument console aesthetic.

Two rendering modes: **Enhanced** (WebGL2 — HDR bloom, sun-relative relief lighting, Fresnel ocean glints, live curl-noise flow simulation on gas giants, and real-time terraforming) and **Classic** (the original CPU rasterizer, kept pixel-exact as both an aesthetic option and a fallback for browsers without WebGL2).

## Quick Start

Run the launcher for your platform — it picks whatever is already installed (Python 3, else Node) and serves on `http://localhost:5654`, automatically stepping to a nearby port if that one is taken:

```bash
./serve.sh            # macOS / Linux / WSL          (optional: ./serve.sh 9000)
serve.bat             # Windows — double-click works and opens your browser
```

Or use any static file server (`python3 -m http.server`, `npx serve`, VS Code "Live Server") — no build step, no dependencies. It also deploys as-is to GitHub Pages (the repo root is the site root). A server is needed because the code is organized as native ES modules, which browsers refuse to load from `file://` URLs — double-clicking `index.html` no longer works.

The app auto-generates Earth on first load — type any string into the seed field and click Generate to roll a new world. Same seed always produces the same body.

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

### Enhanced Rendering (WebGL2)

The default renderer draws the planet as a ray-traced sphere impostor in a single fragment shader — a GPU port of the classic CPU rasterizer's math (same silhouette tests, including the precomputed shape maps for irregular asteroids; same per-channel stellar lighting; same atmosphere, aurora, and specular formulas) — then layers on what the CPU can't afford per-pixel: sun-relative bump lighting from the height field, HDR rendering with a bright-pass bloom (ocean sun glints, lava seas, and brown-dwarf glow actually *glow*), Fresnel water edges, and a gentle filmic tonemap. Rendering happens at the same chunky internal resolution as classic mode and is NEAREST-upscaled, so the pixel-art aesthetic survives intact.

### Gas Giant Flow Simulation

Gas and ice giants (and brown dwarfs) run a live flow simulation using the technique from Stephen M. Cameron's [gaseous-giganticus](https://github.com/smcameron/gaseous-giganticus) — a divergence-free curl-noise velocity field (the gradient of 4D simplex fBm, projected onto the sphere's tangent plane and rotated 90° about the radial axis) plus counter-rotating zonal jets whose speed follows `cos(latitude · bands)`. Where the original advects 8 million particles on the CPU, WAS advects a dye field on GPU ping-pong buffers using **low-diffusion MacCormack advection with a monotonicity limiter**, so vortex and iteration count *sharpen* the flow into filaments and storms rather than blurring it. The dye is seeded from the planet palette's band strip and everything (band count, jet speeds, noise scale, storm accents) derives deterministically from the seed. The VORTEX / CHURN / DENSITY / ITER sliders drive strength, evolution rate, ring count, and development depth respectively; the same wind field also shears terrestrial clouds.

### Terraforming (Live)

In Enhanced mode, the TERRAFORM panel re-classifies worlds per-fragment, per-frame — no re-bake, instant response. Controls grey out when they don't apply to the current body.

| Slider | Effect |
|--------|--------|
| SEA | Raise sea level to drown continents, or drain the oceans to exposed seabed |
| VEG | Vegetation density from dead-world zero to double overgrowth |
| ICE | Glaciation from ice-free to snowball, with live floe breakup at the cap edge |
| SNOW | Snow-line offset — from bare peaks to total coverage; snow lowers toward the poles, with volumetric shelf ice where it meets water |
| CLOUD | Cloud cover multiplier |
| ATMOS | Atmosphere density (haze, halo, pressure, and aurora gating) |
| EVOLVE | Morph the terrain — at full strength the planet becomes an **entirely new continent layout** (region-by-region wipe, not a dissolve) |
| VORTEX | Current-flow strength across a ~100× range — from a faint drift to violent shearing, on both clouds and gas-giant bands |
| CHURN | How fast the flow evolves over time; 0 freezes it |
| DENSITY | Gas / ice giant / brown-dwarf band count — 0 for pure swirl, 2× for twice the rings |
| ITER | Gas-flow iterations — how long the simulation develops; higher = finer, more filamentary swirls |
| EMISSION | Brown-dwarf interior glow shining through the cloud rifts (volumetric) |
| AURORA | Aurora strength (0 disables, 2× doubles); ribbons drift and morph on the flow field |
| RIVERS | River visibility — how much of the erosion flow network renders as rivers |
| EROSION | Erosion strength — re-carves the terrain and river network from a clean base |
| CLOUDS: PROCEDURAL | Replace the baked cloud map with an animated procedural cloud field |

Presets: **DEAD** (drained, sterile, dusty — the dead Earth), **FLOOD**, **EDEN**, **RESET**. Survey-panel readouts (temperature, pressure, habitability, water coverage) update live from the same pure formulas as generation; the planet's canonical attributes are never mutated.

### Rivers & Erosion

Rocky, water-bearing worlds run a hydraulic + thermal erosion pass at generation: droplets carve valleys into the height field, a priority-flood drainage solve accumulates discharge, and the resulting flow map renders as rivers — carved channels in the valleys, tinted toward the body's water color, terminating at the coast. Deterministic per seed; the droplet count scales with the quality tier.

### Animation Export

`EXPORT WORLD ANIM` records a full 360° rotation and encodes it with a zero-dependency in-browser encoder:

- **APNG** — full 8-bit alpha, lossless (the quality path).
- **GIF** — universal, 1-bit transparency.
- **WebP** — real animated WebP: each frame is encoded by the browser and muxed into an ANIM/ANMF container (falls back to APNG only on browsers without WebP encode, e.g. Safari ≤15).

Toggle **BG: TRANSPARENT** to drop the starfield and export the planet on a transparent background (APNG/WebP keep soft alpha; GIF keys it). Frame count and output **SIZE** (256–1024 px) are adjustable. Exports contain only the planet — no instrument overlays or text.

### Quality Tiers

A QUALITY control (Auto / Low / Medium / High / Ultra) scales render internal resolution, bloom, gas-sim resolution and step rate, per-fragment noise budgets (cloud / evolution / aurora / snow octaves), erosion droplet count, and default export frames — one setting, coherent across every subsystem. **Auto** starts at Medium and steps down on slow hardware (median-window sampling with hysteresis) and up when there's headroom. Only the erosion droplet count affects baked geometry, and it's snapshotted at generation so a tier change never silently alters an existing world.

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
| Mode | Enhanced (WebGL2, default) or Classic (original CPU rasterizer). |
| Pixel scale | 1×–4× downsampling for the chunky pixel-art look. |
| Terraform | Live sea level / vegetation / ice / clouds / atmosphere / evolution / cloud flow (Enhanced mode). |
| Displacement | Surface relief intensity for rocky bodies. |
| Generate | Re-rolls with a new random designation, or refreshes the current seed. |

## Project Structure

Plain ES modules, no bundler. Dependencies flow one way: `core` → `data` → `planet`/`renderer` → `app`. The `core`, `data`, and `planet.js` layers are DOM-free — the generation pipeline runs headless in Node or a worker; `renderer.js` needs canvases (they're injected, plus one internal `document.createElement` for its nebula cache).

```
index.html              Markup only
css/style.css           CRT / instrument-console styling
js/
  core/                 Reusable primitives (no dependencies)
    prng.js             FNV-1a seed hashing + mulberry32 PRNG
    noise.js            Perlin3D and Worley3D noise
    color.js            clamp / smoothstep / mix / mixRgb / hexToRgb
    quality.js          Quality tiers — single source of truth + auto-detect
  erosion.js            Hydraulic + thermal erosion -> eroded height + flow map
  data/
    palettes.js         Base color palettes per planet type
    variants.js         Palette variants + pickPalette() merging
    easter-eggs.js      Named-world seeds (VULCAN, ARRAKIS, ...)
    earth-mask.js       Embedded NASA-derived Earth water mask
    cloud-ref.js        Embedded Blue Marble cloud reference
  planet.js             Planet — deterministic generator, bakes all textures
  renderer.js           Renderer — CPU rasterizer, atmosphere, starfield
  gl/                   Enhanced WebGL2 renderer
    noise-glsl.js       GLSL chunks: simplex 3D/4D, fBm, sphere flow, Worley
    planet-shader.js    Ray-traced planet impostor fragment shader
    gas-giant-sim.js    Curl-noise dye advection (gaseous-giganticus technique)
    gl-renderer.js      GLRenderer — drop-in Renderer replacement, HDR bloom
  vendor/               Three.js r180 (MIT, vendored — works offline)
  app/
    dom.js              Element registry (els)
    format.js           Designations, labels, number formatting
    survey-panel.js     Survey-data panel updates
    terraform.js        Live terraform panel (Enhanced mode)
    anim-encoders.js    Zero-dependency APNG / GIF encoders
    animate.js          360° capture loop for animation export
    export-card.js      2048×4096 survey-card PNG export
    main.js             Entry point: renderers, wiring, animation loop
```

Common extension points:

- **New planet class** — add a palette in `data/palettes.js`, variants in `data/variants.js`, a generation branch in `planet.js`, and an `<option>` in `index.html`.
- **New named world** — one line in `data/easter-eggs.js` (plus a variant flagged `_easterEgg` if it needs a bespoke palette).
- **Reusing the generator elsewhere** — `import { Planet } from './js/planet.js'` and read its baked maps and `attributes`; no DOM required.

## Technical Notes

Deterministic generation comes from a mulberry32 PRNG seeded by FNV-1a hashing of the seed string, paired with multiple Perlin3D and Worley3D noise instances per planet.

At generation time, each planet bakes 768×384 equirectangular textures (height, color, moisture, cloud, ice, water mask, and optionally a shape factor map for non-spherical bodies). Both renderers consume the same bake. The classic renderer is a custom CPU rasterizer writing directly to ImageData: silhouette test (sphere or shape-map lookup for irregular bodies), bilinear texture sampling, per-channel lighting, clouds and cloud shadows, atmospheric scattering as continuous inner-haze plus outer-halo, auroras, water speculars, composited over a separately-cached starfield with twinkle and chromatic flicker. The enhanced renderer runs the same math as a WebGL2 fragment shader (a ray-traced sphere impostor on a fullscreen quad, via vendored Three.js), adds HDR bloom / relief lighting / live re-classification on top, and shares the CPU starfield layer unchanged.

The Earth water mask and NASA Blue Marble cloud reference are stored as base64-encoded gzipped data inline — roughly 5KB and 17KB respectively after compression, decoded asynchronously via the browser's `DecompressionStream` API.

Browser requirements: ES2020+, Canvas2D with ImageData, and `DecompressionStream`. Tested on recent Chrome, Firefox, Safari, and Edge.

## Credits

Cloud reference texture derived from NASA's Blue Marble project; Earth water mask similarly derived from public NASA imagery.

Gas giant flow rendering re-implements the curl-noise-on-a-sphere technique from Stephen M. Cameron's [gaseous-giganticus](https://github.com/smcameron/gaseous-giganticus) (an original GPU expression of the published technique — no GPL code is included). Simplex noise GLSL by Ian McEwan / Ashima Arts & Stefan Gustavson (MIT, [webgl-noise](https://github.com/ashima/webgl-noise)). [Three.js](https://threejs.org) r180 is vendored under MIT (see `js/vendor/README.txt`).
