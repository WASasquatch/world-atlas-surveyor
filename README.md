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

Rocky terrain is built from **multi-scale** noise: a base continental fBm sets the land/sea layout, then small-scale rough ridged noise is added as discrete mountain *ranges* — gated to already-elevated ground and broken into belts by a mid-frequency mask, with lowland plains between — so the uplands read as scattered ranges rather than one continent-sized mountainous field. Erosion then carves valleys and rivers into that relief.

The atmospheric model uses a unified blend-based scattering pipeline with continuous inner-haze and outer-halo, sun-tinted by stellar class, with limb darkening and per-channel lighting. Atmospheres come in four thicknesses (none / thin / thick / dense) and class-appropriate compositions. Polar ice caps use a hard-thresholded boundary with Voronoi cell breakup at the transition zone, producing distinct icebergs and floes rather than a smooth gradient. Mountain snow respects exposed rock through high-frequency surface noise. **Coastlines** vary rather than ringing every shore with uniform sand: gentle shores get sandy beaches, while steep shores and a fraction of coasts (by a regional mask plus fine speckle) become rocky cliffs and outcrops, with a meandering sand/rock boundary. **Clouds** are multi-scale and varied: a many-octave shape field mixed with a large-scale cluster mask produces cloud sizes from tiny wisps through small puffs to large systems (with clear sky between), and a per-region *character* field blends crisp defined cumulus against soft, semi-transparent feathered/streaky cirrus. A **COVERAGE** control sets how much of the sky is clouded (independent of the **CLOUD** opacity), and a subtle gaseous-giganticus curl-flow warp is applied by default so the deck reads as swept global currents / zonal bands (the VORTEX slider adds more shear). Cloud shadows project onto the surface based on sun direction. Aurora ribbons render at high latitudes on bodies with sufficient atmospheric thickness or gas-kind composition, with vertical ray striations and altitude-tinted coloring.

### Star System Controls

The simulated parent star supports azimuth, elevation, intensity (POWER), and stellar-class hue spanning M-K-G-F-A-B. Hue affects per-channel lighting so a red M-dwarf produces warmer surface tones and dimmer atmospheric scattering, while a blue B-class star washes lit hemispheres with cool light. A separate view-tilt slider controls camera angle for inspecting polar regions or auroras.

### Enhanced Rendering (WebGL2)

The default renderer draws the planet as a ray-traced sphere impostor in a single fragment shader — a GPU port of the classic CPU rasterizer's math (same silhouette tests, including the precomputed shape maps for irregular asteroids; same per-channel stellar lighting; same atmosphere, aurora, and specular formulas) — then layers on what the CPU can't afford per-pixel: sun-relative bump lighting from the height field, HDR rendering with a bright-pass bloom (ocean sun glints, lava seas, and brown-dwarf glow actually *glow*), Fresnel water edges, and a gentle filmic tonemap. Rendering happens at the same chunky internal resolution as classic mode and is NEAREST-upscaled, so the pixel-art aesthetic survives intact.

### Gas Giant Flow Simulation

Gas and ice giants (and brown dwarfs) run a live flow simulation using the technique from Stephen M. Cameron's [gaseous-giganticus](https://github.com/smcameron/gaseous-giganticus) — a divergence-free curl-noise velocity field (the gradient of 4D simplex fBm, projected onto the sphere's tangent plane and rotated 90° about the radial axis) plus counter-rotating zonal jets whose speed follows `cos(latitude · bands)`. Where the original advects 8 million particles on the CPU, WAS advects a dye field on GPU ping-pong buffers using **low-diffusion MacCormack advection with a monotonicity limiter**, so vortex and iteration count *sharpen* the flow into filaments and storms rather than blurring it. The dye is seeded from the planet palette's band strip and everything (band count, jet speeds, noise scale, storm accents) derives deterministically from the seed. To push Eulerian dye closer to the reference's crisp filaments, the initial dye carries multi-octave contrast and anisotropic (longitude-fine) streaks that the shear folds into persistent filaments, and a **secondary high-frequency curl** layered on the zonal jets seeds the Kelvin-Helmholtz billows that roll up at band boundaries. The VORTEX / CHURN / DENSITY / ITER sliders drive strength, evolution rate, ring count, and development depth; **SCALE / TURB / DETAIL** dial swirl size, KH-billow turbulence, and filament fineness. The same wind field also shears terrestrial clouds.

### Terraforming (Live)

In Enhanced mode, the TERRAFORM panel re-classifies worlds per-fragment, per-frame — no re-bake, instant response. Controls grey out when they don't apply to the current body.

| Slider | Effect |
|--------|--------|
| SEA | Raise sea level to drown continents, or drain the oceans to exposed seabed |
| VEG | Vegetation density from dead-world zero to double overgrowth |
| ICE | Glaciation from ice-free through baked baseline to a **full snowball** (the whole globe frozen over, equator included), with live floe breakup at the cap edge |
| SNOW | Snow-line offset — from bare peaks to total coverage; snow lowers toward the poles, with volumetric shelf ice where it meets water. Snow sheds off steep faces (exposing rock) and holds on gentle slopes and ridgetops, so a snowed range reads as 3D ridges and cut valleys rather than a flat white plain |
| CLOUD | Cloud cover multiplier |
| ATMOS | Atmosphere density (haze, halo, pressure, and aurora gating) |
| EVOLVE | Morph the terrain toward a new large-scale continent layout (re-bakes on release, **before** erosion, so rivers and erosion follow the new shape); full strength = an entirely new world |
| E.SCALE | Evolution feature scale — BROAD for large continents, FINE for smaller landmasses / more islands |
| VORTEX | Current-flow strength across a ~100× range — from a faint drift to violent shearing, on both clouds and gas-giant bands |
| CHURN | How fast the flow evolves over time; 0 freezes it |
| DENSITY | Gas / ice giant / brown-dwarf band count — 0 for pure swirl, 2× for twice the rings |
| SCALE | Gas flow feature size — higher = finer, more intricate swirl structure (gaseous-giganticus noise scale) |
| TURB | Gas turbulence — a secondary high-frequency curl that rolls up into Kelvin-Helmholtz billows and chaotic mixing at the band boundaries |
| DETAIL (gas) | Gas initial-dye roughness / contrast / filament fineness the flow shears into detail |
| ITER | Gas-flow iterations — how long the simulation develops; higher = finer, more filamentary swirls |
| EMISSION | Brown-dwarf interior glow shining through the cloud rifts (volumetric) |
| AURORA | Aurora strength (0 disables, 2× doubles); ribbons drift and morph on the flow field |
| RIVERS | River visibility — how much of the erosion flow network renders as rivers |
| EROSION | Erosion strength — re-carves the terrain and river network from a clean base |
| DETAIL | Erosion detail / scale (multi-resolution balance) — SMOOTH = broad, soft, low-relief valleys; SHARP = crisp, deeply-incised, densely-branched fluvial channels. Drives the mid + fine passes together (rate, brush width, thermal, droplet density) for a strong visible range; the coarse pass always carves continental drainage so the shape stays stable |
| CLOUDS | OPACITY / COVER, three DECKS (LOW/MID/HIGH — altitude + amount each), SCATTER (silver lining), FLOW (current-warp strength), SEED (re-roll the pattern) |

Presets: **DEAD** (drained, sterile, dusty — the dead Earth), **FLOOD**, **EDEN**, **RESET**. Survey-panel readouts (temperature, pressure, habitability, water coverage) update live from the same pure formulas as generation; the planet's canonical attributes are never mutated.

### Clouds

The cloud system is a **multi-deck volumetric generator**, not a single warped noise field. Three decks sit on independent shell altitudes and composite bottom-to-top: **LOW** (cumulus / stratocumulus — puffy billow noise, cellular, broken, opaque), **MID** (alto / frontal banks), and **HIGH** (cirrus — latitudinally-stretched wispy streaks, thin/translucent). Each deck has its own **altitude** and **amount** slider (CLOUD DECKS in the terraform panel), is advected along the atmospheric flow (polar-tapered so the zonal jets never spiral into a pole vortex), carries a full multi-octave shape with value-driven multi-scale breakup (solid cores → cellular stipple at the thin edges, down to near-pixel flecks), and is biased by latitude weather bands (wet ITCZ, dry subtropics, mid-latitude storm belts). Each deck is shaded volumetrically — a density-gradient normal gives sun-facing puffiness, a short sun-march self-shadow (Beer) darkens the undersides, a powder term darkens edges, and a **SCATTER** control adds forward-scatter silver lining. The LOW deck also scatters tiny **fair-weather cumulus specks** (~1–5 px) across the clearer zones. Each deck flows on a *different* band count + phase so they don't all align, a global **FLOW** slider sets the current-warp strength, and a **SEED** slider re-rolls the whole cloud pattern without regenerating the world. Altitude also drives parallax (decks float above the terrain and drift relative to it) and cast-shadow length. The system is always procedural (there is no baked-cloud mode).

### Rivers & Erosion

Rocky, water-bearing worlds run **multi-resolution** hydraulic + thermal erosion at generation. A single-resolution droplet sim can't carve both scales of drainage at once — a droplet at native texel size dies long before it can traverse a continent, so broad valleys never form, and simply cranking the rate just smears the fine detail. Instead a coarse→fine pyramid cascade runs: the terrain is downsampled so one droplet lifetime spans a whole continent and eroded there (broad trunk valleys and basins form; the incision is upsampled and added back), refined at an intermediate resolution, then eroded once more at native resolution where water follows the broad valleys already carved and incises crisp fluvial channels on top. The finest pass also runs the priority-flood drainage solve that accumulates discharge into the flow map, so rivers are drawn from the fully-combined terrain — carved channels in the valleys, tinted toward the body's water color, terminating at the coast.

Rivers use **MFD-D8 (multiple-flow-direction)** routing over the depression-filled surface: each cell splits its discharge among all strictly-lower 8-connected neighbours weighted by slope⁴, rather than dumping it into a single cardinal receiver. Single-receiver D4 routing confined every river to a one-cell chain of N/S/E/W steps, so a diagonal valley could only be drawn as a 90° staircase — the "square stepping" you'd otherwise see. Multiple-flow-direction lets discharge follow the true continuous downslope azimuth and seeds the sub-cell gradient that bilinear texture sampling needs to reconstruct a smooth curve. It stays deterministic — only IEEE add/mul/div and √2, with the slope exponent applied by integer squaring (no `Math.pow`, no `atan`/D-infinity transcendentals).

Deterministic per seed: every pyramid level's droplet count is a fixed constant (derived by area ratio, **not** the quality tier) on its own salted RNG stream, so `same seed + same terraform params → bit-identical terrain on every machine`. The **DETAIL** slider tunes the **mid + fine passes together** — erosion rate, brush width, thermal relaxation, and droplet density — to trade broad soft low-relief valleys against crisp, deeply-incised, densely-branched channels (a strong, visible range; neutral 0.5 reproduces the generated look). The coarse pass stays fixed so continental drainage is present at any setting, and the coarse passes carve only (their deposition is damped) so they don't inflate the land fraction.

Rivers and lakes fold their coverage into the water-specular mask, so they catch the sun's Fresnel glint exactly like the oceans instead of reading as matte painted lines.

### Surface Colour (Custom Colours & Gradient Map)

The **SURFACE COLOUR** panel (Enhanced/GL mode) recolours a world two ways. **Custom colours** are per-group swatches — WATER, LAND, VEG, ROCK, ICE, plus ATMOS and CLOUD — that override the seed palette live; biome colours re-bake into the surface map, atmosphere/cloud are live uniforms. On **gas giants / ice giants / brown dwarfs** the first five swatches are relabelled **BAND 1–5** and recolour the flowing cloud bands directly (they drive the gas-flow band-colour strip and migrate into the live dye), so the palette is useful there instead of editing invisible ground colours. A **gradient map** takes any uploaded image, collapses it to a 256×1 colour ramp, and remaps the world by luminance through it (Photoshop-style) with an intensity (**GRADE**) blend — a single post-albedo pass so it recolours *every* body type, gas giants included, and the export card inherits it automatically. A **SCALE** control spreads the ramp across the world's tonal range: raise it to widen tight topographic contour banding into broad, smooth colour zones, lower it for higher-contrast tighter bands. **TARGETS** stop the gradient from flattening everything into one look: per surface class — WATER, LAND, VEG, ICE — you can toggle whether the gradient touches it and set a LO/HI *slice* of the ramp it maps into, so (e.g.) oceans keep their palette blue while only the land is recoloured, or rock takes the ramp's dark half and vegetation its bright half — classes stay distinct instead of ice ≈ shallow water ≈ continent. Both the **survey card** and the **layered map export** reproduce the gradient (the map export applies it per class on the CPU, matching the viewport). Because the gradient is a global look it **persists across regenerations**; since a loaded gradient remaps the final albedo by luminance it will *override* the custom swatches, so an explicit **GRADIENT ACTIVE** indicator appears whenever one is loaded (CLEAR GRADIENT to return to custom colours). Both features are explicit user overrides applied as pure render-time / re-bake passes: they never touch the seed RNG, so the same seed still generates the same base world (custom colours live in a side field, never mutating the seed palette). Classic (CPU) mode shows the baked seed colours.

### Animation Export

`EXPORT WORLD ANIM` records a full 360° rotation and encodes it with a zero-dependency in-browser encoder:

- **APNG** — full 8-bit alpha, lossless (the quality path).
- **GIF** — universal, 1-bit transparency.
- **WebP** — real animated WebP: each frame is encoded by the browser and muxed into an ANIM/ANMF container (falls back to APNG only on browsers without WebP encode, e.g. Safari ≤15).

Toggle **BG: TRANSPARENT** to drop the starfield and export the planet on a transparent background (APNG/WebP keep soft alpha; GIF keys it). Frame count and output **SIZE** (256–1024 px) are adjustable. Each frame is rendered at 2× the output size and box-downscaled (supersampled anti-aliasing) so the limb and coastlines are smooth, not jagged. Exports contain only the planet — no instrument overlays or text.

### Quality Tiers

A QUALITY control (Auto / Low / Medium / High / Ultra) scales render internal resolution, bloom, gas-sim resolution and step rate, per-fragment noise budgets (cloud / evolution / aurora / snow octaves), erosion droplet count, and default export frames — one setting, coherent across every subsystem. **Auto** starts at Medium and steps down on slow hardware (median-window sampling with hysteresis) and up when there's headroom. Only the erosion droplet count affects baked geometry, and it's snapshotted at generation so a tier change never silently alters an existing world.

### Card Export

The `EXPORT WORLD` button produces a 2048×4096 PNG survey card laid out as a multi-module instrument panel: physical and atmospheric data in the upper section, detected resources and surface features as side-by-side modules, an unwrapped equirectangular surface map (rendered from the actual surface — biomes, erosion, rivers, live terraform, and the gas-giant flow — flat, without lighting/clouds/atmosphere), spectral signature with absorption bands at real wavelengths for detected gases, a thermal IR map (gas giants read cold bright cloud-tops with warm interior showing through the dark rifts; brown dwarfs are the inverse — their bright emissive hot-rifts read hottest), orbital and geophysical parameters, and an observation log with galactic coordinates and observer ID. The center planet image is cropped from the live render.

### Map Export

`EXPORT MAP` writes an equirectangular PNG decomposed into separable **layers**, so a world can be dropped straight into a compositor or game engine. The surface is broken into **GROUND** (bare terrain — rock, sand, coast, no vegetation or snow), **VEGETATION** (green biomes), **SNOW / ICE** (polar sheets + mountain snowcaps), **RIVERS + OCEANS** (water together), and **CLOUDS**. Enable one for a clean isolated pass on transparency, or several to combine — coverage lives entirely in each layer's alpha, and every layer's colour is defined everywhere, so exports upscale without dark fringing. **MASK** mode swaps colour for an opaque white-on-black coverage matte (grey = partial), directly usable as a luminance/layer mask. Output **SIZE** is 1024/2048/4096 px (height auto ½ width). The bake is pure CPU and renders **at the chosen resolution** — it bilinearly samples the baked height/moisture/ice/flow/cloud maps while evaluating the procedural biome/coast/snow/river detail at full output resolution and thresholding coastlines and rivers per output pixel (matching the GL shader), so a 2K/4K export is crisp rather than a blurry upscale of the 768-wide bake. Up to 2048 px it renders at 2× and box-downsamples for anti-aliasing. The layers track live terraform + custom-colour/gradient looks, stay deterministic, and need no GPU readback. Gas giants export their banded albedo as a single GROUND layer (clouds are already baked into the bands).

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
| Pixel scale | 1×–6× downsampling for the chunky pixel-art look. |
| AA | Anti-aliasing — OFF / 2× / 4× supersample (renders above the display resolution and downsamples for smooth edges). Applies to the live view; the map and animation exports supersample automatically. |
| Map res | Generation resolution for every baked map (terrain / erosion / colour / clouds), 768–2048. Higher = crisper terrain, coasts, rivers and sharper exports, at a heavier bake. Re-generates on change. Same seed at the same resolution is bit-identical. |
| Preview | Fast-iteration toggle: bakes at 768, forces the Low quality tier + chunky 3× pixels + no AA. Turn off for a full-resolution, full-quality render to view/export. |
| Post FX (GL) | **Bloom** strength, **Chroma** (chromatic aberration — radial RGB lens split, strongest at the limb), and **Grain** (animated film grain / dither that breaks up banding on smooth gradients). |
| Terraform | Live sea level / vegetation / ice / clouds / atmosphere height + density / evolution / cloud flow (Enhanced mode). Atmosphere **A.HEIGHT** sets how far the haze/halo extends; **A.DENSITY** sets its opacity (a thin dense shell vs a tall faint one, independently). Clouds are advected along the atmospheric flow so cloud shapes stream with the currents. |
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
    color-grade.js      Gradient-map LUT builder + luminance remap (GL + CPU)
    quality.js          Quality tiers — single source of truth + auto-detect
  erosion.js            Multi-resolution hydraulic + thermal erosion -> eroded height + flow map
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
    appearance.js       Surface-colour panel — gradient map + custom colours
    anim-encoders.js    Zero-dependency APNG / GIF encoders
    animate.js          360° capture loop for animation export
    export-card.js      2048×4096 survey-card PNG export
    map-export.js       Layered equirect PNG export (ground/veg/snow/water/clouds + mask)
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
