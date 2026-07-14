// Quality tiers — the single source of truth for render fidelity vs cost.
// The GL renderer, gas-giant sim, terraform panel, erosion bake, and
// animation export all read the resolved tier from here so one control moves
// every knob coherently.
//
// Two facets in one object: every field EXCEPT `droplets` is live render
// fidelity (safe to reapply any frame). `droplets` is generate-time — it
// changes baked geometry, so it is snapshotted onto the planet at bake and a
// tier change never retroactively re-erodes (that would break determinism).

const TIERS = {
  //         resScale bloom  simW simH steps cloudOct cloudWarp evolveOct auroraDetail terrainOct floe droplets  exportFrames
  low:    { name: 'Low',    resScale: 0.65, bloom: false, simW: 256, simH: 128, simSteps: 2, cloudOct: 2, cloudWarp: 1, evolveOct: 2, auroraDetail: 1, terrainOct: 2, floe: 0, droplets: 15000,  exportFrames: 60 },
  medium: { name: 'Medium', resScale: 0.85, bloom: true,  simW: 512, simH: 256, simSteps: 3, cloudOct: 3, cloudWarp: 2, evolveOct: 3, auroraDetail: 1, terrainOct: 3, floe: 1, droplets: 40000,  exportFrames: 120 },
  high:   { name: 'High',   resScale: 1.00, bloom: true,  simW: 640, simH: 320, simSteps: 4, cloudOct: 3, cloudWarp: 2, evolveOct: 4, auroraDetail: 2, terrainOct: 3, floe: 1, droplets: 80000,  exportFrames: 180 },
  ultra:  { name: 'Ultra',  resScale: 1.00, bloom: true,  simW: 768, simH: 384, simSteps: 4, cloudOct: 4, cloudWarp: 2, evolveOct: 5, auroraDetail: 2, terrainOct: 3, floe: 1, droplets: 120000, exportFrames: 240 },
};
const ORDER = ['low', 'medium', 'high', 'ultra'];

function median(arr) {
  const a = arr.slice().sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

const Quality = {
  tierName: 'medium',
  auto: true,                       // default = start Medium, probe up/down
  get() { return TIERS[this.tierName]; },
  names() { return ORDER; },

  set(name) {
    if (!TIERS[name]) return;
    this.tierName = name;
    this.auto = false;
    this._auto.active = false;
    this._notify();
  },
  enableAuto() {
    this.auto = true;
    this._auto.active = true;
    this._auto.samples.length = 0;
    this._auto.skip = 12;
  },

  _subs: [],
  onChange(fn) { this._subs.push(fn); },
  _notify() { for (const fn of this._subs) fn(this.get(), this.tierName); },

  // --- auto-detect: fast-down / slow-up, median window, cooldown, hysteresis
  _auto: { active: true, skip: 12, window: 30, samples: [], cooldown: 0, over: 20, under: 11, upStreak: 0 },
  sampleFrame(ms) {
    const a = this._auto;
    if (!a.active || !this.auto) return;
    if (a.cooldown > 0) { a.cooldown--; return; }
    if (a.skip > 0) { a.skip--; return; }        // ignore compile / warm-up spikes
    a.samples.push(ms);
    if (a.samples.length < a.window) return;
    const med = median(a.samples);
    a.samples.length = 0;
    const i = ORDER.indexOf(this.tierName);
    if (med > a.over && i > 0) {                  // too slow -> step down now
      this.tierName = ORDER[i - 1]; a.cooldown = 90; a.upStreak = 0; this._notify();
    } else if (med < a.under && i < ORDER.length - 1) {  // fast -> step up after 3 good windows
      if (++a.upStreak >= 3) { this.tierName = ORDER[i + 1]; a.cooldown = 90; a.upStreak = 0; this._notify(); }
    } else {
      a.upStreak = 0;
      if (med >= a.under && med <= a.over) a.active = false;   // settled — stop probing
    }
  },
};

export { Quality };
