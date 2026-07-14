// Math / color helpers shared across generation and rendering.

// ---------- COLOR HELPERS ----------
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function smoothstep(a, b, t) {
  t = clamp((t - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}
function mix(a, b, t) { return a + (b - a) * t; }
function mixRgb(a, b, t) {
  return [a[0] + (b[0]-a[0])*t, a[1] + (b[1]-a[1])*t, a[2] + (b[2]-a[2])*t];
}
function hexToRgb(h) {
  const n = parseInt(h.replace('#',''), 16);
  return [(n>>16)&255, (n>>8)&255, n&255];
}


export { clamp, smoothstep, mix, mixRgb, hexToRgb };
