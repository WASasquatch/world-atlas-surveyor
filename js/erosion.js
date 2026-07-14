// Terrain erosion — deterministic hydraulic droplet erosion + thermal
// relaxation for equirectangular height fields, plus a water flow-accumulation
// map used to render rivers. Self-contained: no external deps, pure JS.
//
// Model (Beyer / Sebastian Lague style): thousands of rain droplets are
// dropped at seeded random positions, each rolls downhill along the bilinearly
// interpolated height gradient (with inertia), eroding sediment when it
// accelerates into steeper descent and depositing it when it slows or climbs.
// A brush spreads erosion/deposition so channels carve smoothly. Every cell a
// droplet visits banks that droplet's remaining water into a `runoff` buffer.
//
// FLOW MAP (the key deliverable — used later to render rivers): pure droplet
// counting produces a flow field whose contrast drifts with the droplet count
// (more rain lifts the whole log-normalised map toward 1, so overland never
// reads faint). Instead we treat the droplet `runoff` as a per-cell rainfall
// weight and route it downhill with a depression-filling drainage
// accumulation (priority-flood + D8) over the *eroded* terrain. That yields
// true discharge with a large dynamic range — a handful of trunk rivers drain
// thousands of cells and read ~1, diffuse hillslope flow reads faint — and is
// stable across quality settings. The result is then log-scaled and
// normalised to 0..1 exactly as `log(1+acc)/log(1+maxAcc)`.
//
// TOPOLOGY: the field is equirectangular. Longitude (X) wraps modulo W — the
// seam is continuous — so all sampling, gradients, brush writes and drainage
// neighbours wrap in X. Latitude (Y) clamps at the poles; a droplet that steps
// off the top/bottom edge dies. Droplet spawn is cosine-weighted in latitude
// (density proportional to cos(lat)) via exact inverse-CDF sampling, so the
// equirect-compressed pole rows — where many texels map to nearly the same
// physical point — are not over-eroded.
//
// DETERMINISM is sacred: every random value comes from mulberry32(seed). No
// Date / Math.random. Same seed => bit-identical output. The input heightMap
// is never mutated; a fresh Float32Array is returned.

import { mulberry32 } from './core/prng.js';

// Quality tiers for the `droplets` knob (documented, not enforced):
//   Low ~15000 · Medium ~40000 · High ~70000 · Ultra ~120000
const DEFAULTS = {
  droplets:      50000,  // number of simulated droplets (main quality knob)
  inertia:       0.05,   // 0 = water instantly follows gradient, →1 = ballistic
  capacity:      4.0,    // sediment carry factor (higher = deeper channels)
  minSlope:      0.01,   // slope floor so flats still grant a little capacity
  deposition:    0.30,   // fraction of surplus sediment dropped per step
  erosion:       0.30,   // fraction of free capacity eroded per step
  evaporation:   0.01,   // water lost per step (0..1)
  gravity:       4.0,    // converts descent into speed
  maxLifetime:   64,     // hard cap on steps per droplet (bounds O(n·life))
  erosionRadius: 3,      // brush radius for smooth erosion (cells)
  seaLevel:      -0.05,  // droplets reaching below this deposit + die; also the
                         // drainage outlet level and the river/ocean cutoff
  thermal:       3,      // thermal relaxation passes (0/false = skip)
  talus:         0.04,   // thermal: max stable neighbour height difference
  thermalRate:   0.5,    // thermal: fraction of excess moved per pass
  flowBoost:     0.75,   // how strongly droplet traffic weights the flow map
                         // (0 = pure drainage area; runoff is mean-normalised
                         //  first so this stays independent of droplet count)
};

// Seed salt — keeps the erosion RNG stream distinct from the planet's own
// mulberry32(seedNum) stream even when handed the same numeric seed.
const SEED_SALT = 0x7E5051;

// Precompute a radial brush (relative offsets + normalised falloff weights).
// Erosion is spread across the brush so channels carve smoothly instead of
// punching single-texel pits. Offsets are applied with X-wrap / Y-clamp at
// use time, so one small brush serves every cell (cheap vs a per-cell table).
function buildBrush(radius) {
  const dxs = [], dys = [], ws = [];
  let wsum = 0;
  const r = Math.max(1, radius | 0);
  const r2 = r * r;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const w = 1 - Math.sqrt(d2) / r;   // 1 at centre → 0 at rim
      if (w <= 0) continue;
      dxs.push(dx); dys.push(dy); ws.push(w); wsum += w;
    }
  }
  const n = ws.length;
  const dx = new Int32Array(dxs);
  const dy = new Int32Array(dys);
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = ws[i] / wsum;   // normalise to sum 1
  return { dx, dy, w, n };
}

/**
 * Erode an equirectangular height field.
 *
 * @param {Float32Array} heightMap  length W*H, row-major (NOT mutated).
 * @param {number} W                texture width  (longitude, wraps).
 * @param {number} H                texture height (latitude, clamps).
 * @param {object} opts             see DEFAULTS; `seed` is required.
 * @returns {{ height: Float32Array, flow: Float32Array }}
 *          `height` — new eroded field (length W*H).
 *          `flow`   — normalised 0..1 water flow-accumulation map (length W*H;
 *                     0 over ocean cells below seaLevel).
 */
function erode(heightMap, W, H, opts) {
  opts = opts || {};
  if (typeof opts.seed !== 'number' || !isFinite(opts.seed)) {
    throw new Error('erode: opts.seed (finite number) is required for determinism');
  }
  const o = Object.assign({}, DEFAULTS, opts);
  const N = W * H;
  const Hm1 = H - 1;

  // Working buffers. The input is copied, never written through.
  const height = new Float32Array(heightMap);   // eroded output
  const runoff = new Float32Array(N);           // droplet water banked per cell
  const rng    = mulberry32((o.seed >>> 0) ^ SEED_SALT);
  const brush  = buildBrush(o.erosionRadius);
  const { dx: bdx, dy: bdy, w: bw, n: bn } = brush;

  const inertia    = o.inertia;
  const invInertia = 1 - inertia;
  const capacity   = o.capacity;
  const minSlope   = o.minSlope;
  const deposition = o.deposition;
  const erosion    = o.erosion;
  const evap       = o.evaporation;
  const gravity    = o.gravity;
  const maxLife    = o.maxLifetime | 0;
  const seaLevel   = o.seaLevel;

  // Bilinear height + gradient sampler. Writes results into these closure
  // scalars instead of returning an object, so the hot loop allocates nothing.
  let sH = 0, sGx = 0, sGy = 0;
  function sampleHG(px, py) {
    // X wraps, Y clamps. px in [0,W), py in [0,H-1].
    const x0 = Math.floor(px);
    const y0 = Math.floor(py);
    const fx = px - x0;
    const fy = py - y0;
    const x0w = ((x0 % W) + W) % W;
    const x1w = (x0w + 1) % W;
    const y0c = y0 < 0 ? 0 : (y0 > Hm1 ? Hm1 : y0);
    const y1 = y0 + 1;
    const y1c = y1 < 0 ? 0 : (y1 > Hm1 ? Hm1 : y1);
    const rowN = y0c * W, rowS = y1c * W;
    const hNW = height[rowN + x0w], hNE = height[rowN + x1w];
    const hSW = height[rowS + x0w], hSE = height[rowS + x1w];
    sGx = (hNE - hNW) * (1 - fy) + (hSE - hSW) * fy;
    sGy = (hSW - hNW) * (1 - fx) + (hSE - hNE) * fx;
    sH  = hNW * (1 - fx) * (1 - fy) + hNE * fx * (1 - fy)
        + hSW * (1 - fx) * fy       + hSE * fx * fy;
  }

  // Deposit `amount` at a fractional position, split bilinearly across the four
  // surrounding cells (fills pits / lays down sediment smoothly).
  function deposit(px, py, amount) {
    const x0 = Math.floor(px), y0 = Math.floor(py);
    const fx = px - x0, fy = py - y0;
    const x0w = ((x0 % W) + W) % W, x1w = (x0w + 1) % W;
    const y0c = y0 < 0 ? 0 : (y0 > Hm1 ? Hm1 : y0);
    const y1 = y0 + 1, y1c = y1 > Hm1 ? Hm1 : (y1 < 0 ? 0 : y1);
    const rowN = y0c * W, rowS = y1c * W;
    height[rowN + x0w] += amount * (1 - fx) * (1 - fy);
    height[rowN + x1w] += amount * fx       * (1 - fy);
    height[rowS + x0w] += amount * (1 - fx) * fy;
    height[rowS + x1w] += amount * fx       * fy;
  }

  // ---------- 1. HYDRAULIC DROPLET EROSION ----------
  const droplets = o.droplets | 0;
  for (let d = 0; d < droplets; d++) {
    // Spawn: X uniform (wraps), Y cosine-weighted in latitude via inverse-CDF.
    // density ∝ cos(lat) = sin(π·yNorm); CDF⁻¹ → yNorm = acos(1-2u)/π.
    let posX = rng() * W;
    const u = rng();
    let posY = (Math.acos(1 - 2 * u) / Math.PI) * H - 0.5;
    if (posY < 0) posY = 0; else if (posY > Hm1) posY = Hm1;

    let dirX = 0, dirY = 0;
    let speed = 1, water = 1, sediment = 0;

    for (let life = 0; life < maxLife; life++) {
      const nodeX = Math.floor(posX);
      const nodeY = Math.floor(posY);
      const cell = ((nodeY < 0 ? 0 : nodeY > Hm1 ? Hm1 : nodeY) * W)
                 + (((nodeX % W) + W) % W);

      // Bank this droplet's water at the cell it occupies — the per-cell
      // runoff that later weights drainage accumulation into the flow map.
      runoff[cell] += water;

      // Height + gradient at the current (pre-move) position.
      sampleHG(posX, posY);
      const oldHeight = sH;
      const gX = sGx, gY = sGy;

      // Blend flow direction with the downhill gradient (−grad) by inertia.
      dirX = dirX * inertia - gX * invInertia;
      dirY = dirY * inertia - gY * invInertia;
      const len = Math.sqrt(dirX * dirX + dirY * dirY);
      if (len < 1e-8) break;      // sitting in a flat/pit — settle & stop
      dirX /= len; dirY /= len;

      // Step exactly one cell along the flow direction.
      const oldPosX = posX, oldPosY = posY;
      posX += dirX; posY += dirY;
      // X wraps; leaving top/bottom kills the droplet (deposit remainder first).
      posX = ((posX % W) + W) % W;
      if (posY < 0 || posY > Hm1) {
        if (sediment > 0) deposit(oldPosX, oldPosY, sediment);
        break;
      }

      // Height at the new position and the height delta of the move.
      sampleHG(posX, posY);
      const newHeight = sH;
      const deltaHeight = newHeight - oldHeight;   // <0 downhill, >0 uphill

      // Reached the sea: rivers terminate at the coast. Drop load and die.
      if (newHeight < seaLevel) {
        if (sediment > 0) deposit(oldPosX, oldPosY, sediment);
        break;
      }

      // Sediment capacity scales with descent, speed and water volume.
      const cap = Math.max(-deltaHeight, minSlope) * speed * water * capacity;

      if (sediment > cap || deltaHeight > 0) {
        // Over capacity, or moving uphill: deposit. When climbing, only fill up
        // to the lip of the pit (min with deltaHeight) so we never build spires.
        const drop = (deltaHeight > 0)
          ? Math.min(deltaHeight, sediment)
          : (sediment - cap) * deposition;
        sediment -= drop;
        deposit(oldPosX, oldPosY, drop);
      } else {
        // Under capacity on a descent: erode, but never more than the drop
        // itself (keeps the channel from cutting below its downstream cell).
        const grab = Math.min((cap - sediment) * erosion, -deltaHeight);
        sediment += grab;
        // Spread the removal across the brush around the old cell.
        const cx = Math.floor(oldPosX), cy = Math.floor(oldPosY);
        for (let b = 0; b < bn; b++) {
          const iy = cy + bdy[b];
          if (iy < 0 || iy > Hm1) continue;          // clamp at poles
          const ix = (((cx + bdx[b]) % W) + W) % W;  // wrap in longitude
          height[iy * W + ix] -= grab * bw[b];
        }
      }

      // Gravity accelerates on descent (−deltaHeight>0); water evaporates.
      speed = Math.sqrt(Math.max(0, speed * speed - deltaHeight * gravity));
      water *= (1 - evap);
      if (water < 1e-4) break;   // dried out
    }
  }

  // ---------- 2. THERMAL EROSION ----------
  // Relaxation passes that shed material from any cell whose drop to its
  // steepest 4-neighbour exceeds the talus threshold, softening cliffs and
  // the raw walls the droplets carved. X-wrap / Y-clamp aware. A scratch delta
  // buffer makes each pass order-independent (Jacobi, not Gauss-Seidel).
  const thermalPasses = (o.thermal === true) ? 3 : (o.thermal | 0);
  if (thermalPasses > 0) {
    const talus = o.talus;
    const rate = o.thermalRate;
    const delta = new Float32Array(N);
    for (let p = 0; p < thermalPasses; p++) {
      delta.fill(0);
      for (let j = 0; j < H; j++) {
        const jn = j > 0 ? j - 1 : 0;        // clamp
        const js = j < Hm1 ? j + 1 : Hm1;
        const row = j * W;
        for (let i = 0; i < W; i++) {
          const iw = (i - 1 + W) % W;         // wrap
          const ie = (i + 1) % W;
          const h = height[row + i];
          // Find the single lowest neighbour (most stable, avoids oscillation).
          let lowIdx = -1, lowDiff = talus;
          const d0 = h - height[row + iw];
          const d1 = h - height[row + ie];
          const d2 = h - height[jn * W + i];
          const d3 = h - height[js * W + i];
          if (d0 > lowDiff) { lowDiff = d0; lowIdx = row + iw; }
          if (d1 > lowDiff) { lowDiff = d1; lowIdx = row + ie; }
          if (d2 > lowDiff) { lowDiff = d2; lowIdx = jn * W + i; }
          if (d3 > lowDiff) { lowDiff = d3; lowIdx = js * W + i; }
          if (lowIdx >= 0) {
            const move = (lowDiff - talus) * 0.5 * rate;  // half the excess
            delta[row + i] -= move;
            delta[lowIdx]  += move;
          }
        }
      }
      for (let k = 0; k < N; k++) height[k] += delta[k];
    }
  }

  // ---------- 3. FLOW MAP: drainage accumulation → log-normalise ----------
  const flow = buildFlowMap(height, runoff, W, H, seaLevel, o.flowBoost);
  return { height, flow };
}

// Priority-flood (Barnes et al. + epsilon) depression handling followed by D8
// drainage accumulation, weighted by per-cell runoff. Returns the normalised
// 0..1 flow map (0 over ocean). Everything here is X-wrap / Y-clamp aware.
//
// Why priority-flood: real terrain (and freshly eroded terrain) is riddled
// with closed depressions. A naive steepest-descent router dead-ends every
// river in the first pit it meets, so no cell ever accumulates a large basin
// and the map has almost no dynamic range. Priority-flood grows a drainage
// tree outward from the outlets (ocean, or the lowest cell if landlocked) in
// order of increasing (depression-filled) elevation; the order in which cells
// are reached gives each a guaranteed downstream neighbour, so flow always
// finds the sea. A tiny epsilon lift across filled flats keeps directions
// well-defined.
function buildFlowMap(height, runoff, W, H, seaLevel, flowBoost) {
  const N = W * H, Hm1 = H - 1, EPS = 1e-5;

  // Per-cell runoff weight. Mean-normalise the droplet runoff so its influence
  // (flowBoost) is independent of how many droplets were simulated; every land
  // cell also gets a base area of 1 so un-visited cells still drain.
  let rSum = 0;
  for (let k = 0; k < N; k++) rSum += runoff[k];
  const rMeanInv = rSum > 0 ? N / rSum : 0;
  const acc = new Float32Array(N);
  for (let k = 0; k < N; k++) acc[k] = 1 + flowBoost * runoff[k] * rMeanInv;

  const filled = new Float32Array(N);
  const down = new Int32Array(N);   // downstream cell index, -1 for outlets
  down.fill(-1);
  const seen = new Uint8Array(N);
  const order = new Int32Array(N);  // cells in pop (increasing-height) order
  let on = 0;

  // Binary min-heap of cell indices keyed by filled[]. Sized N+1 (1-based).
  const heap = new Int32Array(N + 1);
  let hn = 0;
  function heapPush(c) {
    heap[++hn] = c;
    let i = hn;
    while (i > 1) {
      const p = i >> 1;
      if (filled[heap[p]] <= filled[heap[i]]) break;
      const t = heap[p]; heap[p] = heap[i]; heap[i] = t; i = p;
    }
  }
  function heapPop() {
    const top = heap[1];
    heap[1] = heap[hn--];
    let i = 1;
    for (;;) {
      const l = i * 2, r = l + 1; let s = i;
      if (l <= hn && filled[heap[l]] < filled[heap[s]]) s = l;
      if (r <= hn && filled[heap[r]] < filled[heap[s]]) s = r;
      if (s === i) break;
      const t = heap[s]; heap[s] = heap[i]; heap[i] = t; i = s;
    }
    return top;
  }

  // Seed outlets: every ocean cell (below seaLevel). If the body has no ocean
  // (e.g. deserts with seaLevel far below the terrain), seed the single lowest
  // cell so landlocked drainage still resolves.
  let anyOcean = false;
  for (let k = 0; k < N; k++) {
    if (height[k] < seaLevel) {
      filled[k] = height[k]; seen[k] = 1; heapPush(k); anyOcean = true;
    }
  }
  if (!anyOcean) {
    let lo = 0;
    for (let k = 1; k < N; k++) if (height[k] < height[lo]) lo = k;
    filled[lo] = height[lo]; seen[lo] = 1; heapPush(lo);
  }

  // Grow the drainage tree outward, recording each cell's downstream neighbour.
  while (hn > 0) {
    const c = heapPop();
    order[on++] = c;
    const j = (c / W) | 0, i = c - j * W;
    const jn = j > 0 ? j - 1 : 0, js = j < Hm1 ? j + 1 : Hm1;
    const iw = (i - 1 + W) % W, ie = (i + 1) % W;
    const nb0 = j * W + iw, nb1 = j * W + ie, nb2 = jn * W + i, nb3 = js * W + i;
    if (!seen[nb0]) { seen[nb0] = 1; filled[nb0] = Math.max(height[nb0], filled[c] + EPS); down[nb0] = c; heapPush(nb0); }
    if (!seen[nb1]) { seen[nb1] = 1; filled[nb1] = Math.max(height[nb1], filled[c] + EPS); down[nb1] = c; heapPush(nb1); }
    if (!seen[nb2]) { seen[nb2] = 1; filled[nb2] = Math.max(height[nb2], filled[c] + EPS); down[nb2] = c; heapPush(nb2); }
    if (!seen[nb3]) { seen[nb3] = 1; filled[nb3] = Math.max(height[nb3], filled[c] + EPS); down[nb3] = c; heapPush(nb3); }
  }

  // Accumulate discharge from high to low (reverse of pop order): by the time a
  // cell pushes its total downstream, all cells draining into it have summed in.
  for (let k = on - 1; k >= 0; k--) {
    const c = order[k], d = down[c];
    if (d >= 0) acc[d] += acc[c];
  }

  // Log-scale + normalise over LAND only. Ocean cells are drainage sinks that
  // pool many rivers together — they'd blow out maxAcc and are rendered as sea
  // anyway — so they're excluded from the max and zeroed in the output.
  let maxAcc = 0;
  for (let k = 0; k < N; k++) if (height[k] >= seaLevel && acc[k] > maxAcc) maxAcc = acc[k];
  const flow = new Float32Array(N);
  if (maxAcc > 0) {
    const invLogMax = 1 / Math.log(1 + maxAcc);
    for (let k = 0; k < N; k++) {
      if (height[k] < seaLevel) continue;   // ocean → 0
      const v = Math.log(1 + acc[k]) * invLogMax;
      flow[k] = v > 1 ? 1 : v;
    }
  }
  return flow;
}

export { erode };
