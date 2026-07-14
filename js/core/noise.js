// 3D noise primitives — Perlin gradient noise and Worley (Voronoi)
// cellular noise. Self-contained; seeded via constructor arguments.

// ---------- 3D PERLIN ----------
class Perlin3D {
  constructor(rng) {
    const perm = new Uint8Array(256);
    for (let i = 0; i < 256; i++) perm[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = perm[i]; perm[i] = perm[j]; perm[j] = t;
    }
    this.p = new Uint8Array(512);
    for (let i = 0; i < 512; i++) this.p[i] = perm[i & 255];
  }
  noise(x, y, z) {
    const fx = Math.floor(x), fy = Math.floor(y), fz = Math.floor(z);
    const X = fx & 255, Y = fy & 255, Z = fz & 255;
    x -= fx; y -= fy; z -= fz;
    const u = x * x * x * (x * (x * 6 - 15) + 10);
    const v = y * y * y * (y * (y * 6 - 15) + 10);
    const w = z * z * z * (z * (z * 6 - 15) + 10);
    const p = this.p;
    const A  = p[X    ] + Y, AA = p[A    ] + Z, AB = p[A + 1] + Z;
    const B  = p[X + 1] + Y, BA = p[B    ] + Z, BB = p[B + 1] + Z;
    const grad = (h, x, y, z) => {
      const hh = h & 15;
      const u = hh < 8 ? x : y;
      const v = hh < 4 ? y : (hh === 12 || hh === 14) ? x : z;
      return ((hh & 1) === 0 ? u : -u) + ((hh & 2) === 0 ? v : -v);
    };
    const lerp = (a, b, t) => a + t * (b - a);
    return lerp(
      lerp(
        lerp(grad(p[AA  ], x  , y  , z  ), grad(p[BA  ], x-1, y  , z  ), u),
        lerp(grad(p[AB  ], x  , y-1, z  ), grad(p[BB  ], x-1, y-1, z  ), u), v),
      lerp(
        lerp(grad(p[AA+1], x  , y  , z-1), grad(p[BA+1], x-1, y  , z-1), u),
        lerp(grad(p[AB+1], x  , y-1, z-1), grad(p[BB+1], x-1, y-1, z-1), u), v),
      w);
  }
  fbm(x, y, z, oct, persist, lac) {
    oct = oct || 6; persist = persist || 0.5; lac = lac || 2.0;
    let total = 0, freq = 1, amp = 1, max = 0;
    for (let i = 0; i < oct; i++) {
      total += this.noise(x*freq, y*freq, z*freq) * amp;
      max += amp; amp *= persist; freq *= lac;
    }
    return total / max;
  }
  // Ridged power-fractal — for canyon walls & mountain spines
  ridged(x, y, z, oct) {
    oct = oct || 5;
    let total = 0, freq = 1, amp = 1, max = 0;
    for (let i = 0; i < oct; i++) {
      const n = 1 - Math.abs(this.noise(x*freq, y*freq, z*freq));
      total += n * n * amp;
      max += amp; amp *= 0.5; freq *= 2;
    }
    return total / max;
  }
}

// ---------- 3D WORLEY (Voronoi) ----------
class Worley3D {
  constructor(seedOffset) {
    this.offset = (seedOffset >>> 0) || 1;
  }
  hash(ix, iy, iz) {
    let h = (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791) ^ this.offset) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
    h = (h ^ (h >>> 15)) >>> 0;
    return h;
  }
  noise(x, y, z) {
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    let f1 = Infinity;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const cx = ix + dx, cy = iy + dy, cz = iz + dz;
          const h = this.hash(cx, cy, cz);
          const px = cx + ((h         & 0xFF) / 255);
          const py = cy + (((h >>> 8) & 0xFF) / 255);
          const pz = cz + (((h >>> 16)& 0xFF) / 255);
          const ax = x - px, ay = y - py, az = z - pz;
          const d = ax*ax + ay*ay + az*az;
          if (d < f1) f1 = d;
        }
      }
    }
    return Math.sqrt(f1);
  }
}


export { Perlin3D, Worley3D };
