// Terrain erosion — deterministic hydraulic droplet erosion + thermal
// relaxation for equirectangular height fields, plus a water flow-accumulation
// map used to render rivers.
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
// accumulation (priority-flood + MFD-D8) over the *eroded* terrain. That yields
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
  // Skippable (computeFlow:false) for the coarse pyramid passes below, whose
  // flow maps are discarded — only the finest pass renders rivers.
  const flow = (o.computeFlow === false)
    ? null
    : buildFlowMap(height, runoff, W, H, seaLevel, o.flowBoost);
  return { height, flow };
}

// Priority-flood (Barnes et al. + epsilon) depression handling followed by
// MFD-D8 (multiple-flow-direction) drainage accumulation, weighted by per-cell
// runoff. Fractional multi-neighbour routing (vs single-receiver D4) is what
// keeps rendered rivers off the cardinal grid — flow follows the true downslope
// azimuth instead of a 90° staircase. Returns the normalised 0..1 flow map
// (0 over ocean). Everything here is X-wrap / Y-clamp aware.
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

  // Grow the drainage tree outward over the D8 (8-connected) surface, recording
  // each cell's downstream parent. Using diagonals here (not just cardinals)
  // gives the filled surface a diagonally-connected descent so the MFD pass
  // below can route flow along true-diagonal thalwegs instead of a cardinal
  // zigzag. Same X-wrap / Y-clamp math as everywhere; at pole rows a diagonal
  // collapses onto a cardinal cell (already `seen`), which is harmlessly skipped.
  while (hn > 0) {
    const c = heapPop();
    order[on++] = c;
    const j = (c / W) | 0, i = c - j * W;
    const jn = j > 0 ? j - 1 : 0, js = j < Hm1 ? j + 1 : Hm1;
    const iw = (i - 1 + W) % W, ie = (i + 1) % W;
    const nb0 = j * W + iw,  nb1 = j * W + ie,  nb2 = jn * W + i, nb3 = js * W + i;
    const nb4 = jn * W + iw, nb5 = jn * W + ie, nb6 = js * W + iw, nb7 = js * W + ie;
    if (!seen[nb0]) { seen[nb0] = 1; filled[nb0] = Math.max(height[nb0], filled[c] + EPS); down[nb0] = c; heapPush(nb0); }
    if (!seen[nb1]) { seen[nb1] = 1; filled[nb1] = Math.max(height[nb1], filled[c] + EPS); down[nb1] = c; heapPush(nb1); }
    if (!seen[nb2]) { seen[nb2] = 1; filled[nb2] = Math.max(height[nb2], filled[c] + EPS); down[nb2] = c; heapPush(nb2); }
    if (!seen[nb3]) { seen[nb3] = 1; filled[nb3] = Math.max(height[nb3], filled[c] + EPS); down[nb3] = c; heapPush(nb3); }
    if (!seen[nb4]) { seen[nb4] = 1; filled[nb4] = Math.max(height[nb4], filled[c] + EPS); down[nb4] = c; heapPush(nb4); }
    if (!seen[nb5]) { seen[nb5] = 1; filled[nb5] = Math.max(height[nb5], filled[c] + EPS); down[nb5] = c; heapPush(nb5); }
    if (!seen[nb6]) { seen[nb6] = 1; filled[nb6] = Math.max(height[nb6], filled[c] + EPS); down[nb6] = c; heapPush(nb6); }
    if (!seen[nb7]) { seen[nb7] = 1; filled[nb7] = Math.max(height[nb7], filled[c] + EPS); down[nb7] = c; heapPush(nb7); }
  }

  // MFD-D8 (multiple-flow-direction) accumulation. Iterate high→low (reverse of
  // the pop order = strictly decreasing filled height, so every cell's inflow is
  // complete before it distributes) and split each cell's discharge among ALL
  // strictly-lower D8 neighbours, weighted by slope^4 where slope = drop /
  // distance (distance 1 for cardinals, √2 for diagonals). Single-receiver D4
  // routing forced all discharge into a 1-cell cardinal chain, so a diagonal
  // valley could only be drawn as a 90° staircase; MFD lets flow follow the true
  // continuous downslope azimuth and spreads a little into off-axis neighbours,
  // which also gives bilinear texture sampling the sub-cell gradient it needs to
  // reconstruct a smooth curve after thresholding. Deterministic: only IEEE
  // add/sub/mul/div and the constant √2 (correctly-rounded sqrt), with the
  // exponent applied by integer repeated-squaring — no Math.pow, no atan/D∞
  // transcendentals, no RNG. `down[]` is the mass-conserving fallback for true
  // sinks (no lower neighbour), which only happens at outlets/ocean.
  const SQ2 = Math.SQRT2;
  const INVD = Float32Array.of(1, 1, 1, 1, 1 / SQ2, 1 / SQ2, 1 / SQ2, 1 / SQ2); // W E N S NW NE SW SE
  const NBi = new Int32Array(8), WTa = new Float32Array(8);
  for (let k = on - 1; k >= 0; k--) {
    const c = order[k];
    const ac = acc[c], fc = filled[c];
    const j = (c / W) | 0, i = c - j * W;
    const jn = j > 0 ? j - 1 : 0, js = j < Hm1 ? j + 1 : Hm1;
    const iw = (i - 1 + W) % W, ie = (i + 1) % W;
    NBi[0] = j * W + iw;  NBi[1] = j * W + ie;  NBi[2] = jn * W + i;  NBi[3] = js * W + i;
    NBi[4] = jn * W + iw; NBi[5] = jn * W + ie; NBi[6] = js * W + iw; NBi[7] = js * W + ie;
    // Pole rows: the clamped diagonals collapse onto the E/W cardinals (the
    // N/S cardinal collapses onto c itself, harmlessly filtered by drop>0).
    // Skip the collapsed diagonal slots so a cell isn't weighted twice.
    const topPole = jn === j, botPole = js === j;
    let wsum = 0, m = 0;
    for (let t = 0; t < 8; t++) {
      if ((topPole && (t === 4 || t === 5)) || (botPole && (t === 6 || t === 7))) continue;
      const drop = fc - filled[NBi[t]];
      if (drop > 0) {
        let s = drop * INVD[t];
        s = s * s; s = s * s;            // slope^4 (integer exponent, no Math.pow)
        WTa[m] = s; NBi[m] = NBi[t]; wsum += s; m++;
      }
    }
    if (wsum > 0) {
      const inv = ac / wsum;
      for (let t = 0; t < m; t++) acc[NBi[t]] += WTa[t] * inv;
    } else if (down[c] >= 0) {
      acc[down[c]] += ac;
    }
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

// ============================ MULTI-RESOLUTION ============================
// A single-resolution droplet sim can't carve both scales of drainage at once:
// with a fixed step of one cell and a bounded lifetime, a droplet at native
// resolution dies long before it can traverse a continent, so broad
// continental valleys never form — and simply cranking the erosion rate just
// smears the fine detail. The classic fix is a coarse→fine PYRAMID cascade:
//
//   1. Downsample the terrain to a coarse grid where one droplet lifetime spans
//      a whole continent, and erode there. Broad trunk valleys and basins form.
//      Take the height *change* (delta), upsample it, add it back to the full
//      field — this injects the large-scale drainage without touching fine
//      texel detail.
//   2. Repeat at an intermediate resolution to refine regional valleys.
//   3. Erode once more at NATIVE resolution. Water now follows the broad
//      valleys already carved into the field and incises crisp fluvial channels
//      and cuts on top of them. This finest pass also produces the flow map
//      (rivers) over the fully-combined terrain, so rivers are drawn from the
//      final surface, not an intermediate one.
//
// DETERMINISM: every level's droplet count is a fixed constant (derived from
// the base count by area ratio, not from any quality tier), and each level runs
// on its own salted mulberry32 stream. Same (seed, detail, erosionScale) →
// bit-identical terrain on every machine.

// Box-downsample an equirect field by an integer factor. X wraps (the seam is
// continuous); Y is treated as-is (rows average within the block). Requires
// W % f === 0 && H % f === 0 (callers guarantee this).
function downsampleField(src, W, H, f) {
  const w = (W / f) | 0, h = (H / f) | 0;
  const out = new Float32Array(w * h);
  const inv = 1 / (f * f);
  for (let j = 0; j < h; j++) {
    const y0 = j * f;
    for (let i = 0; i < w; i++) {
      const x0 = i * f;
      let s = 0;
      for (let dy = 0; dy < f; dy++) {
        const row = (y0 + dy) * W;
        for (let dx = 0; dx < f; dx++) s += src[row + ((x0 + dx) % W)];
      }
      out[j * w + i] = s * inv;
    }
  }
  return out;
}

// Bilinear-upsample a coarse (w×h) equirect field to W×H. X wraps, Y clamps.
// Pixel-center aligned so the round-trip stays registered with downsampleField.
function upsampleField(src, w, h, W, H) {
  const out = new Float32Array(W * H);
  const wm = w, hm1 = h - 1;
  for (let j = 0; j < H; j++) {
    const gy = ((j + 0.5) * h) / H - 0.5;
    const y0 = Math.floor(gy), fy = gy - y0;
    const y0c = y0 < 0 ? 0 : y0 > hm1 ? hm1 : y0;
    const y1 = y0 + 1, y1c = y1 < 0 ? 0 : y1 > hm1 ? hm1 : y1;
    const rowN = y0c * w, rowS = y1c * w;
    for (let i = 0; i < W; i++) {
      const gx = ((i + 0.5) * w) / W - 0.5;
      const x0 = Math.floor(gx), fx = gx - x0;
      const x0w = ((x0 % wm) + wm) % wm, x1w = (x0w + 1) % wm;
      const a = src[rowN + x0w], b = src[rowN + x1w];
      const c = src[rowS + x0w], d = src[rowS + x1w];
      out[j * W + i] = (a * (1 - fx) + b * fx) * (1 - fy)
                     + (c * (1 - fx) + d * fx) * fy;
    }
  }
  return out;
}

/**
 * Multi-resolution erosion — coarse→fine pyramid cascade (see block comment).
 *
 * @param {Float32Array} heightMap  length W*H, row-major (NOT mutated).
 * @param {number} W, H             equirect dims (longitude wraps, lat clamps).
 * @param {object} opts
 *   seed         {number}  required — deterministic RNG root.
 *   seaLevel     {number}  ocean / drainage-outlet level.
 *   droplets     {number}  base (native-level) droplet count; default 50000.
 *   detail       {number}  0..1 — fine-cut emphasis. Low = broad, smooth
 *                          valleys; high = crisp, deeply incised fluvial
 *                          channels. Scales the native pass's erosion rate.
 *   erosionScale {number}  overall intensity multiplier (the EROSION slider);
 *                          1 = default. Multiplies every level's erosion rate.
 * @returns {{ height: Float32Array, flow: Float32Array }}  final terrain + rivers.
 */
function erodeMultiRes(heightMap, W, H, opts) {
  opts = opts || {};
  if (typeof opts.seed !== 'number' || !isFinite(opts.seed)) {
    throw new Error('erodeMultiRes: opts.seed (finite number) is required');
  }
  const baseDrops = (opts.droplets != null ? opts.droplets : DEFAULTS.droplets) | 0;
  const detail = opts.detail == null ? 0.5 : Math.max(0, Math.min(1, opts.detail));
  const eScale = opts.erosionScale == null ? 1 : opts.erosionScale;
  const seaLevel = opts.seaLevel;

  // Pyramid levels, COARSE → FINE. `f` is the downsample factor (1 = native).
  //   erode  — base erosion rate at that level (before eScale / detail).
  //   thermal— relaxation passes (more at coarse levels → smoother broad valleys).
  //   dropScale — droplet-density boost (coarse levels get a little extra to
  //               define trunk drainage cleanly; still a fixed constant).
  // The native pass (f=1) alone emits the flow map, over the combined terrain.
  const LEVELS = [
    { f: 4, radius: 2, erode: 0.34, thermal: 5, dropScale: 1.5 },
    { f: 2, radius: 2, erode: 0.30, thermal: 3, dropScale: 1.2 },
    { f: 1, radius: 3, erode: 0.28, thermal: 3, dropScale: 1.0 },
  ].filter((L) => W % L.f === 0 && H % L.f === 0);

  const NB = W * H;
  let base = new Float32Array(heightMap);
  let flow = null;

  for (let li = 0; li < LEVELS.length; li++) {
    const L = LEVELS[li];
    const isNative = L.f === 1;
    const w = (W / L.f) | 0, h = (H / L.f) | 0;
    const cells = w * h;
    // DETAIL / erosion-scale knob — applied to the MID + NATIVE passes (the
    // coarse f>=4 pass stays fixed so continental drainage is stable at any
    // setting). It shifts the fine-and-regional erosion between BROAD/SMOOTH and
    // FINE/SHARP across four coupled levers so the change is clearly visible:
    //   rate  — deeper incision,      brush — narrower channels,
    //   thermal — fewer smoothing passes (sharp cuts survive),
    //   droplets — more tributaries.
    // detail 0.5 == each level's baseline, so the seed's generated look is
    // unchanged at the neutral setting (base generate uses detail 0.5).
    const dtl = L.f <= 2;   // mid + native carry DETAIL; coarse is fixed
    const rateMul = dtl ? (0.40 + 1.20 * detail) : 1.0;       // 0.4 .. 1.6 (mid = 1.0)
    const dropMul = dtl ? (0.50 + 1.00 * detail) : 1.0;       // 0.5 .. 1.5 (mid = 1.0)
    const radius = dtl ? Math.max(1, Math.round(L.radius + (0.5 - detail) * 4.0)) : L.radius;
    const thermal = dtl ? Math.max(1, Math.round(L.thermal + (0.5 - detail) * 4.0)) : L.thermal;
    // Constant droplet DENSITY across levels (count ∝ area) × per-level boost ×
    // the DETAIL density multiplier. Fixed integers → hardware-independent.
    const drops = Math.max(1500, Math.round(baseDrops * (cells / NB) * L.dropScale * dropMul));

    const src = isNative ? base : downsampleField(base, W, H, L.f);
    const res = erode(src, w, h, {
      seed: (opts.seed >>> 0) ^ (0x2C9E5 * (li + 1)),   // distinct stream / level
      seaLevel,
      droplets: drops,
      erosionRadius: radius,
      erosion: L.erode * eScale * rateMul,
      thermal,
      computeFlow: isNative,     // only the finest pass builds the river map
    });

    if (isNative) {
      base = res.height;         // src === base, so this already carries the
      flow = res.flow;           // upsampled coarse deltas from prior levels
    } else {
      // Inject only the coarse pass's CHANGE (delta), upsampled — this adds the
      // broad valley without disturbing the fine texel content of `base`.
      // The coarse pass is used for INCISION (carving continental drainage), not
      // for building land: its deposition, upsampled, would raise broad coastal
      // shelves above sea and inflate the land fraction. So carving (negative
      // delta) is kept in full while deposition (positive) is heavily damped —
      // local coastal deposition is left to the native pass, matching the
      // single-resolution land balance.
      const delta = new Float32Array(cells);
      const hgt = res.height;
      for (let k = 0; k < cells; k++) delta[k] = hgt[k] - src[k];
      const up = upsampleField(delta, w, h, W, H);
      for (let k = 0; k < NB; k++) { const d = up[k]; base[k] += d < 0 ? d : d * 0.15; }
    }
  }

  return { height: base, flow: flow || new Float32Array(NB) };
}

export { erode, erodeMultiRes };
