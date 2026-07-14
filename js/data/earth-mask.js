// Earth preset — embedded NASA-derived water mask (gzip + base64).
// EARTH_MASK is populated asynchronously by decodeEarthMask(); importers
// see the update through the live module binding.

// ============================================================
// EARTH PRESET — embedded water mask
// 768x384 equirectangular bit-packed mask: bit=1 means LAND, bit=0 means WATER.
// Source: NASA Blue Marble derived water-mask, downsampled to texture res,
// then gzip-compressed and base64-encoded. Decoded asynchronously at startup.
// When a planet is generated with config.earthMode=true, the Perlin heightmap
// is biased per-texel using this mask: land texels get pushed above seaLevel,
// water texels get pushed below — producing real continent shapes while still
// retaining the procedural noise's mountain/coastline detail.
// ============================================================
const EARTH_MASK_GZ_B64 = "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";

// Decoded mask data — populated asynchronously at startup. Each entry is
// 0 (water) or 1 (land). Indexed [row*W + col] with W=768, H=384.
let EARTH_MASK = null;
const EARTH_MASK_W = 768;
const EARTH_MASK_H = 384;

async function decodeEarthMask() {
  try {
    const bin = atob(EARTH_MASK_GZ_B64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    // Use the browser's built-in DecompressionStream for gzip
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    const decompressed = new Uint8Array(await new Response(stream).arrayBuffer());
    // Unpack bits to a Uint8Array of 0/1 entries
    const total = EARTH_MASK_W * EARTH_MASK_H;
    const out = new Uint8Array(total);
    for (let i = 0; i < total; i++) {
      const byte = decompressed[i >> 3];
      const bit = 7 - (i & 7);
      out[i] = (byte >> bit) & 1;
    }
    EARTH_MASK = out;
    return true;
  } catch (e) {
    console.warn('Earth mask decode failed:', e);
    return false;
  }
}

export { EARTH_MASK, EARTH_MASK_W, EARTH_MASK_H, decodeEarthMask };
