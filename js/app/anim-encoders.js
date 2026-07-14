// Animated-image encoders — turn an array of RGBA frames into file bytes.
// Zero dependencies, pure ES module: runs offline from a static file server and
// in the browser. All encoders run synchronously on the main thread (call after
// capture is done). Memory stays near one frame's working set beyond the output.
//
// FRAME SHAPE (pick one, both accepted):
//   frames = [ buf0, buf1, ... ]                where bufN is a Uint8ClampedArray
//   frames = [ { data: buf0 }, { data: buf1 } ] |Uint8Array of RGBA, length
//                                                width*height*4, row-major, top
//                                                row first (canvas order).
//
// OPTS: { width, height, delayMs = 40, loop = 0, transparent = false }
//   width / height  REQUIRED — pixel dims of every frame.
//   delayMs         per-frame delay in ms (40 ≈ 25fps).
//   loop            0 = infinite (APNG num_plays / GIF NETSCAPE loop count).
//   transparent     preserve alpha. APNG keeps full 8-bit alpha ALWAYS; GIF only
//                   has 1-bit transparency (alpha < 128 -> transparent index).
//
// FORMAT SUMMARY:
//   encodeAPNG  — QUALITY path. Lossless RGBA, full 8-bit alpha. DEFLATE below is
//                 fixed-Huffman + LZ77 (real compression, valid zlib w/ Adler32).
//   encodeGIF   — COMPATIBILITY path. Global median-cut palette (<=256), LZW, 1-bit
//                 transparency. Hard alpha edges (fringing) vs APNG's soft alpha.
//   encodeAnimatedWebP — returns null (can't VP8-encode without the browser).
//   muxAnimatedWebP    — QUALITY WebP path. NOT an RGBA encoder: it muxes an array
//                 of per-frame still-WebP files (each from canvas.toBlob('image/webp'))
//                 into one animated WebP. See the ANIMATED WEBP section at the bottom.

// ============================================================
// SHARED HELPERS
// ============================================================

// Normalize a frame entry to its raw RGBA buffer.
function frameData(f) { return (f && f.data) ? f.data : f; }

// Concatenate an array of Uint8Arrays into one.
function concat(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function strBytes(s) {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}

// ---------- CRC32 (PNG chunks) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
// CRC32 over bytes[start..end) with the standard init/final xor.
function crc32(bytes, start, end) {
  let c = 0xFFFFFFFF;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ---------- Adler32 (zlib) ----------
function adler32(bytes) {
  let a = 1, b = 0;
  const MOD = 65521;
  let i = 0;
  const n = bytes.length;
  while (i < n) {
    const end = Math.min(i + 5552, n); // max iters before 32-bit overflow risk
    for (; i < end; i++) { a += bytes[i]; b += a; }
    a %= MOD; b %= MOD;
  }
  return (((b << 16) | a) >>> 0);
}

// ============================================================
// DEFLATE — fixed-Huffman + LZ77 (RFC 1951), zlib-wrapped (RFC 1950)
// One BFINAL block, BTYPE=01. Greedy match-finding via hash chains.
// ============================================================

// Bit writer, LSB-first within each byte (deflate's packing order).
class BitWriter {
  constructor(sizeHint = 1024) {
    this.buf = new Uint8Array(sizeHint);
    this.len = 0;
    this.acc = 0;   // pending bits (< 8 held between calls)
    this.nbits = 0;
  }
  _push(byte) {
    if (this.len >= this.buf.length) {
      const grown = new Uint8Array(this.buf.length * 2);
      grown.set(this.buf);
      this.buf = grown;
    }
    this.buf[this.len++] = byte;
  }
  // Write the low `n` bits of `val`, least-significant bit first.
  writeBits(val, n) {
    this.acc = (this.acc | (val << this.nbits)) >>> 0;
    this.nbits += n;
    while (this.nbits >= 8) { this._push(this.acc & 0xFF); this.acc >>>= 8; this.nbits -= 8; }
  }
  finish() {
    if (this.nbits > 0) { this._push(this.acc & 0xFF); this.acc = 0; this.nbits = 0; }
    return this.buf.subarray(0, this.len);
  }
}

// Reverse the low `len` bits of `code` (Huffman codes are defined MSB-first but
// packed into the LSB-first bitstream, so we pre-reverse and write normally).
function bitReverse(code, len) {
  let r = 0;
  for (let i = 0; i < len; i++) { r = (r << 1) | (code & 1); code >>= 1; }
  return r;
}

// Fixed literal/length codes (RFC 1951 §3.2.6), stored pre-reversed.
const LIT_CODE = new Uint16Array(288);
const LIT_LEN = new Uint8Array(288);
(function buildLit() {
  for (let s = 0;   s <= 143; s++) { LIT_LEN[s] = 8; LIT_CODE[s] = bitReverse(0x30 + s, 8); }
  for (let s = 144; s <= 255; s++) { LIT_LEN[s] = 9; LIT_CODE[s] = bitReverse(0x190 + (s - 144), 9); }
  for (let s = 256; s <= 279; s++) { LIT_LEN[s] = 7; LIT_CODE[s] = bitReverse(s - 256, 7); }
  for (let s = 280; s <= 287; s++) { LIT_LEN[s] = 8; LIT_CODE[s] = bitReverse(0xC0 + (s - 280), 8); }
})();
// Fixed distance codes: 5-bit, value == symbol, pre-reversed.
const DIST_CODE = new Uint8Array(30);
for (let s = 0; s < 30; s++) DIST_CODE[s] = bitReverse(s, 5);

// Length -> {symbol, extra-bits, extra-base} tables (match lengths 3..258).
const _LEN_BASE  = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
const _LEN_XBITS = [0,0,0,0,0,0,0,0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4,  4,  5,  5,  5,  5,  0];
const LEN_SYM   = new Uint16Array(259);
const LEN_XBITS = new Uint8Array(259);
const LEN_XBASE = new Uint16Array(259);
(function buildLen() {
  for (let i = 0; i < _LEN_BASE.length; i++) {
    const base = _LEN_BASE[i];
    const max = (i === _LEN_BASE.length - 1) ? base : _LEN_BASE[i + 1] - 1;
    for (let l = base; l <= max; l++) { LEN_SYM[l] = 257 + i; LEN_XBITS[l] = _LEN_XBITS[i]; LEN_XBASE[l] = base; }
  }
})();

// Distance -> {symbol, extra-bits, extra-base} tables (distances 1..32768).
const _DIST_BASE  = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
const _DIST_XBITS = [0,0,0,0,1,1,2, 2, 3, 3, 4, 4, 5, 5,  6,  6,  7,  7,  8,  8,   9,   9,  10,  10,  11,  11,  12,   12,   13,   13];
const DIST_SYM   = new Uint8Array(32769);
const DIST_XBITS = new Uint8Array(32769);
const DIST_XBASE = new Uint16Array(32769);
(function buildDist() {
  for (let i = 0; i < _DIST_BASE.length; i++) {
    const base = _DIST_BASE[i];
    const max = (i === _DIST_BASE.length - 1) ? 32768 : _DIST_BASE[i + 1] - 1;
    for (let d = base; d <= max; d++) { DIST_SYM[d] = i; DIST_XBITS[d] = _DIST_XBITS[i]; DIST_XBASE[d] = base; }
  }
})();

// Compress `data` into a raw fixed-Huffman DEFLATE stream.
function deflateFixed(data) {
  const n = data.length;
  const bw = new BitWriter(Math.max(64, n));
  bw.writeBits(1, 1); // BFINAL = 1
  bw.writeBits(1, 2); // BTYPE  = 01 (fixed Huffman)

  const WIN = 32768, MIN_MATCH = 3, MAX_MATCH = 258;
  const HASH_SIZE = 1 << 15;
  const MAX_CHAIN = 128; // caps match-search cost (avoids O(n^2))
  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(n > 0 ? n : 1).fill(-1);
  const hash = (i) => (((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) & (HASH_SIZE - 1));

  let i = 0;
  while (i < n) {
    let bestLen = 0, bestDist = 0;
    if (i + MIN_MATCH <= n) {
      const maxLen = Math.min(MAX_MATCH, n - i);
      let j = head[hash(i)];
      let chain = MAX_CHAIN;
      while (j >= 0 && chain-- > 0) {
        if (i - j > WIN) break;
        // Quick reject: only bother if we can beat the current best.
        if (data[j + bestLen] === data[i + bestLen]) {
          let l = 0;
          while (l < maxLen && data[j + l] === data[i + l]) l++;
          if (l > bestLen) { bestLen = l; bestDist = i - j; if (l >= maxLen) break; }
        }
        j = prev[j];
      }
    }
    if (bestLen >= MIN_MATCH) {
      const sym = LEN_SYM[bestLen];
      bw.writeBits(LIT_CODE[sym], LIT_LEN[sym]);
      if (LEN_XBITS[bestLen]) bw.writeBits(bestLen - LEN_XBASE[bestLen], LEN_XBITS[bestLen]);
      const dsym = DIST_SYM[bestDist];
      bw.writeBits(DIST_CODE[dsym], 5);
      if (DIST_XBITS[bestDist]) bw.writeBits(bestDist - DIST_XBASE[bestDist], DIST_XBITS[bestDist]);
      const end = i + bestLen;
      while (i < end) { // insert every covered position so future matches see them
        if (i + MIN_MATCH <= n) { const h = hash(i); prev[i] = head[h]; head[h] = i; }
        i++;
      }
    } else {
      const c = data[i];
      bw.writeBits(LIT_CODE[c], LIT_LEN[c]);
      if (i + MIN_MATCH <= n) { const h = hash(i); prev[i] = head[h]; head[h] = i; }
      i++;
    }
  }
  bw.writeBits(LIT_CODE[256], LIT_LEN[256]); // end-of-block
  return bw.finish();
}

// Wrap raw DEFLATE in a zlib stream (2-byte header + data + 4-byte Adler32).
function zlibCompress(data) {
  const body = deflateFixed(data);
  const out = new Uint8Array(2 + body.length + 4);
  out[0] = 0x78; out[1] = 0x01;            // CMF/FLG (0x7801 % 31 === 0)
  out.set(body, 2);
  const a = adler32(data);
  const o = 2 + body.length;
  out[o] = (a >>> 24) & 0xFF; out[o + 1] = (a >>> 16) & 0xFF;
  out[o + 2] = (a >>> 8) & 0xFF; out[o + 3] = a & 0xFF; // Adler32 big-endian
  return out;
}

// ============================================================
// APNG — animated PNG. RGBA/8-bit, filter type 0 (None) per scanline.
// ============================================================

// Build a PNG chunk: 4-byte length + 4-byte type + data + 4-byte CRC(type+data).
function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out[4] = type.charCodeAt(0); out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2); out[7] = type.charCodeAt(3);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

function encodeAPNG(frames, opts) {
  const { width, height, delayMs = 40, loop = 0 } = opts;
  const numFrames = frames.length;
  const parts = [];

  // PNG signature.
  parts.push(new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));

  // IHDR — RGBA, 8-bit, no interlace.
  const ihdr = new Uint8Array(13);
  const ihv = new DataView(ihdr.buffer);
  ihv.setUint32(0, width);
  ihv.setUint32(4, height);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  parts.push(pngChunk('IHDR', ihdr));

  // acTL — animation control (must precede IDAT).
  const actl = new Uint8Array(8);
  const acv = new DataView(actl.buffer);
  acv.setUint32(0, numFrames);
  acv.setUint32(4, loop >>> 0); // num_plays, 0 = infinite
  parts.push(pngChunk('acTL', actl));

  const rowStride = width * 4;
  const filtered = new Uint8Array(height * (1 + rowStride)); // reused each frame
  let seq = 0; // shared fcTL/fdAT sequence counter (must be gap-free from 0)

  for (let f = 0; f < numFrames; f++) {
    const px = frameData(frames[f]);

    // fcTL — frame control.
    const fctl = new Uint8Array(26);
    const fcv = new DataView(fctl.buffer);
    fcv.setUint32(0, seq++);
    fcv.setUint32(4, width);
    fcv.setUint32(8, height);
    fcv.setUint32(12, 0);        // x_offset
    fcv.setUint32(16, 0);        // y_offset
    fcv.setUint16(20, delayMs);  // delay_num
    fcv.setUint16(22, 1000);     // delay_den (ms)
    fctl[24] = 0;                // dispose_op = NONE
    fctl[25] = 0;                // blend_op   = SOURCE (full overwrite incl. alpha)
    parts.push(pngChunk('fcTL', fctl));

    // Filter each scanline with type 0 (None): [0, rowbytes...].
    for (let y = 0; y < height; y++) {
      const o = y * (1 + rowStride);
      filtered[o] = 0;
      filtered.set(px.subarray(y * rowStride, y * rowStride + rowStride), o + 1);
    }
    const zdata = zlibCompress(filtered);

    if (f === 0) {
      parts.push(pngChunk('IDAT', zdata));       // frame 0 uses IDAT
    } else {
      const fdat = new Uint8Array(4 + zdata.length);
      new DataView(fdat.buffer).setUint32(0, seq++);
      fdat.set(zdata, 4);
      parts.push(pngChunk('fdAT', fdat));         // later frames use fdAT (seq-prefixed)
    }
  }

  parts.push(pngChunk('IEND', new Uint8Array(0)));
  return concat(parts);
}

// ============================================================
// GIF89a — global median-cut palette, LZW, 1-bit transparency.
// ============================================================

// Subsample RGB pixels across all frames (capped) for palette building.
function collectSamples(frames, width, height, transparent) {
  const perFrame = width * height;
  const total = perFrame * frames.length;
  const CAP = 16384;
  const step = Math.max(1, Math.floor(total / CAP));
  const out = [];
  let idx = 0;
  for (let f = 0; f < frames.length; f++) {
    const px = frameData(frames[f]);
    for (let p = 0; p < perFrame; p++, idx++) {
      if (idx % step) continue;
      const o = p * 4;
      if (transparent && px[o + 3] < 128) continue;
      out.push((px[o] << 16) | (px[o + 1] << 8) | px[o + 2]);
    }
  }
  if (out.length === 0) out.push(0);
  return out;
}

// Median-cut quantization. `pix` = packed 0xRRGGBB ints; returns up to
// `maxColors` [r,g,b] entries.
function medianCut(pix, maxColors) {
  const boxes = [[0, pix.length]]; // half-open [start,end) index ranges into pix
  const rangeOf = (s, e) => {
    let rmin = 255, rmax = 0, gmin = 255, gmax = 0, bmin = 255, bmax = 0;
    for (let i = s; i < e; i++) {
      const v = pix[i], r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
      if (r < rmin) rmin = r; if (r > rmax) rmax = r;
      if (g < gmin) gmin = g; if (g > gmax) gmax = g;
      if (b < bmin) bmin = b; if (b > bmax) bmax = b;
    }
    return [rmax - rmin, gmax - gmin, bmax - bmin];
  };
  while (boxes.length < maxColors) {
    // Pick the splittable box with the widest channel spread.
    let bi = -1, best = -1, shift = 0;
    for (let k = 0; k < boxes.length; k++) {
      const [s, e] = boxes[k];
      if (e - s <= 1) continue;
      const [dr, dg, db] = rangeOf(s, e);
      const m = Math.max(dr, dg, db);
      if (m > best) { best = m; bi = k; shift = (dr >= dg && dr >= db) ? 16 : (dg >= db ? 8 : 0); }
    }
    if (bi < 0) break; // nothing left to split
    const [s, e] = boxes[bi];
    const sub = pix.slice(s, e).sort((a, b) => ((a >> shift) & 255) - ((b >> shift) & 255));
    for (let i = s; i < e; i++) pix[i] = sub[i - s];
    const mid = (s + e) >> 1;
    boxes.splice(bi, 1, [s, mid], [mid, e]);
  }
  const pal = [];
  for (const [s, e] of boxes) {
    const c = e - s;
    if (c === 0) { pal.push([0, 0, 0]); continue; }
    let r = 0, g = 0, b = 0;
    for (let i = s; i < e; i++) { const v = pix[i]; r += (v >> 16) & 255; g += (v >> 8) & 255; b += v & 255; }
    pal.push([Math.round(r / c), Math.round(g / c), Math.round(b / c)]);
  }
  return pal;
}

// Nearest-palette-index lookup with a per-color cache (planet frames reuse
// colors heavily, so the cache keeps mapping near O(unique-colors)).
function makeMapper(palette) {
  const cache = new Map();
  const n = palette.length;
  return (r, g, b) => {
    const key = (r << 16) | (g << 8) | b;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const p = palette[i];
      const dr = r - p[0], dg = g - p[1], db = b - p[2];
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) { bestD = d; best = i; if (d === 0) break; }
    }
    cache.set(key, best);
    return best;
  };
}

// GIF LZW (variable-width codes, no "early change"), returns a flat byte array.
function lzwEncode(indices, minCodeSize) {
  const CLEAR = 1 << minCodeSize;
  const EOI = CLEAR + 1;
  let codeSize = minCodeSize + 1;
  let next = CLEAR + 2;
  let dict = new Map();
  const out = [];
  let acc = 0, nbits = 0;
  const emit = (code) => {
    acc |= code << nbits; nbits += codeSize;
    while (nbits >= 8) { out.push(acc & 0xFF); acc >>>= 8; nbits -= 8; }
  };
  emit(CLEAR);
  if (indices.length === 0) { emit(EOI); if (nbits) out.push(acc & 0xFF); return out; }
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const c = indices[i];
    const key = prefix * 4096 + c;
    const found = dict.get(key);
    if (found !== undefined) {
      prefix = found;
    } else {
      emit(prefix);
      // Grow the code width BEFORE assigning the code that needs it (so the just-
      // emitted code and the decoder stay in lock-step — the standard GIF timing).
      if (next === (1 << codeSize) && codeSize < 12) codeSize++;
      if (next < 4096) {
        dict.set(key, next++);
      } else {
        emit(CLEAR); dict = new Map(); codeSize = minCodeSize + 1; next = CLEAR + 2;
      }
      prefix = c;
    }
  }
  emit(prefix);
  emit(EOI);
  if (nbits > 0) out.push(acc & 0xFF);
  return out;
}

// Package a byte array into GIF sub-blocks (<=255 bytes each) + terminator.
function subBlockify(bytes) {
  const out = [];
  let i = 0;
  while (i < bytes.length) {
    const n = Math.min(255, bytes.length - i);
    out.push(n);
    for (let j = 0; j < n; j++) out.push(bytes[i + j]);
    i += n;
  }
  out.push(0);
  return new Uint8Array(out);
}

function encodeGIF(frames, opts) {
  const { width, height, delayMs = 40, loop = 0, transparent = false } = opts;
  const maxColors = transparent ? 255 : 256; // reserve one slot for transparency

  // Build one global palette from a subsample of every frame.
  const palette = medianCut(collectSamples(frames, width, height, transparent), maxColors);
  let transIndex = -1;
  if (transparent) { transIndex = palette.length; palette.push([0, 0, 0]); }

  // Round the table up to a power of two (GIF color tables must be 2^k).
  const tableBits = Math.max(1, Math.ceil(Math.log2(Math.max(2, palette.length))));
  const tableSize = 1 << tableBits;
  const minCodeSize = Math.max(2, tableBits); // LZW min code size is >= 2 always
  const mapper = makeMapper(transIndex >= 0 ? palette.slice(0, transIndex) : palette);

  const parts = [];
  parts.push(strBytes('GIF89a'));

  // Logical Screen Descriptor + global color table flag.
  const lsd = new Uint8Array(7);
  lsd[0] = width & 255;  lsd[1] = (width >> 8) & 255;
  lsd[2] = height & 255; lsd[3] = (height >> 8) & 255;
  lsd[4] = 0x80 | ((tableBits - 1) << 4) | (tableBits - 1); // GCT flag, color res, size
  lsd[5] = 0;  // background color index
  lsd[6] = 0;  // pixel aspect ratio
  parts.push(lsd);

  // Global Color Table (padded to tableSize entries).
  const gct = new Uint8Array(tableSize * 3);
  for (let i = 0; i < tableSize; i++) {
    const c = palette[i] || [0, 0, 0];
    gct[i * 3] = c[0]; gct[i * 3 + 1] = c[1]; gct[i * 3 + 2] = c[2];
  }
  parts.push(gct);

  // NETSCAPE2.0 loop extension.
  parts.push(new Uint8Array([
    0x21, 0xFF, 0x0B,
    0x4E, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2E, 0x30, // "NETSCAPE2.0"
    0x03, 0x01, loop & 255, (loop >> 8) & 255, 0x00,
  ]));

  const delayCs = Math.max(1, Math.round(delayMs / 10)); // GIF delays are centiseconds
  const disposal = transparent ? 2 : 1; // restore-to-bg for transparency (avoids smear)
  const indices = new Uint8Array(width * height); // reused each frame

  for (let f = 0; f < frames.length; f++) {
    const px = frameData(frames[f]);
    for (let p = 0; p < width * height; p++) {
      const o = p * 4;
      indices[p] = (transparent && px[o + 3] < 128) ? transIndex : mapper(px[o], px[o + 1], px[o + 2]);
    }

    // Graphic Control Extension.
    parts.push(new Uint8Array([
      0x21, 0xF9, 0x04,
      (disposal << 2) | (transparent ? 0x01 : 0x00),
      delayCs & 255, (delayCs >> 8) & 255,
      transparent ? transIndex : 0,
      0x00,
    ]));

    // Image Descriptor (no local color table).
    parts.push(new Uint8Array([
      0x2C, 0, 0, 0, 0,
      width & 255, (width >> 8) & 255,
      height & 255, (height >> 8) & 255,
      0x00,
    ]));

    // LZW min code size + compressed image data.
    parts.push(new Uint8Array([minCodeSize]));
    parts.push(subBlockify(lzwEncode(indices, minCodeSize)));
  }

  parts.push(new Uint8Array([0x3B])); // trailer
  return concat(parts);
}

// ============================================================
// ANIMATED WEBP — browser-assisted muxer (muxAnimatedWebP).
// ------------------------------------------------------------
// We can't VP8-encode from RGBA offline (see encodeAnimatedWebP below), but the
// BROWSER can encode a single frame to WebP via canvas.toBlob(cb,'image/webp',q)
// / OffscreenCanvas.convertToBlob(). Each such blob is a COMPLETE still-WebP RIFF
// file holding one frame as either a simple 'VP8 ' (lossy) / 'VP8L' (lossless)
// chunk, or an extended 'VP8X'[+'ALPH']+'VP8 '/'VP8L'. muxAnimatedWebP stitches an
// array of those still files into ONE animated WebP by parsing out each frame's
// image chunks and re-wrapping them as 'ANMF' frames in a WEBP/VP8X/ANIM container.
// Payload bytes are copied verbatim, so output quality == the browser's per-frame
// quality. WebP is LITTLE-endian throughout (unlike PNG's big-endian chunks).
// ============================================================

// Read a 4-byte FourCC at `off` as an ASCII string.
function readFourCC(bytes, off) {
  return String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
}

// Read a little-endian uint32 at `off`.
function readU32LE(b, off) {
  return (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0;
}

// Write the low 24 bits of `val` little-endian into arr[off..off+2].
function writeU24LE(arr, off, val) {
  arr[off] = val & 0xFF; arr[off + 1] = (val >>> 8) & 0xFF; arr[off + 2] = (val >>> 16) & 0xFF;
}

// A 4-byte little-endian uint32 as its own array (for the outer RIFF size).
function u32le(v) {
  return new Uint8Array([v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF]);
}

// Build a RIFF chunk: 4-byte FourCC + 4-byte LE payload size + payload + one pad
// byte when the size is odd (RIFF chunks are 16-bit aligned; the pad is not
// counted in the size field). The trailing pad byte is left zero.
function riffChunk(fourcc, payload) {
  const size = payload.length;
  const out = new Uint8Array(8 + size + (size & 1));
  out[0] = fourcc.charCodeAt(0); out[1] = fourcc.charCodeAt(1);
  out[2] = fourcc.charCodeAt(2); out[3] = fourcc.charCodeAt(3);
  out[4] = size & 0xFF; out[5] = (size >>> 8) & 0xFF;
  out[6] = (size >>> 16) & 0xFF; out[7] = (size >>> 24) & 0xFF;
  out.set(payload, 8);
  return out;
}

// Does a VP8L bitstream declare an alpha channel? VP8L has no ALPH chunk — alpha
// is intrinsic. The 5-byte header is 1 signature byte (0x2f) then 32 bits read
// LSB-first: 14b width-1, 14b height-1, 1b alpha_is_used (bit 28), 3b version.
function vp8lUsesAlpha(payload) {
  if (payload.length < 5 || payload[0] !== 0x2f) return false;
  const bits = readU32LE(payload, 1);
  return ((bits >>> 28) & 1) === 1;
}

// Parse one still-WebP file (as returned by toBlob('image/webp')). Tolerates all
// three browser layouts — simple 'VP8 ', simple 'VP8L', or extended
// 'VP8X'[+'ALPH']+'VP8 '/'VP8L'. Returns the frame's image payload(s) ready to be
// dropped into an ANMF chunk. Container-level chunks (VP8X/ICCP/EXIF/XMP/ANIM/ANMF)
// are ignored — the animation supplies its own. Throws on non-WEBP / imageless input.
function parseStillWebP(file) {
  if (file.length < 12 || readFourCC(file, 0) !== 'RIFF' || readFourCC(file, 8) !== 'WEBP')
    throw new Error('muxAnimatedWebP: a frame is not a RIFF/WEBP file');
  const end = Math.min(file.length, 8 + readU32LE(file, 4)); // clamp to declared RIFF size
  let off = 12;
  let alph = null, image = null, fourcc = null, hasAlpha = false;
  while (off + 8 <= end) {
    const id = readFourCC(file, off);
    const size = readU32LE(file, off + 4);
    const payload = file.subarray(off + 8, off + 8 + size);
    if (id === 'ALPH') { alph = payload; hasAlpha = true; }
    else if (id === 'VP8 ') { image = payload; fourcc = 'VP8 '; }
    else if (id === 'VP8L') { image = payload; fourcc = 'VP8L'; if (vp8lUsesAlpha(payload)) hasAlpha = true; }
    off += 8 + size + (size & 1); // step past header + payload + pad
  }
  if (!image) throw new Error('muxAnimatedWebP: a frame has no VP8 /VP8L image chunk');
  return { alph, image, fourcc, hasAlpha };
}

// Mux an array of still-WebP files into one animated WebP.
//   frameFiles : Uint8Array[] — each a complete still-WebP file from
//                canvas.toBlob(cb,'image/webp',q) / OffscreenCanvas.convertToBlob().
//   opts       : { width, height, delayMs = 40, loop = 0 }
//                width/height REQUIRED (canvas dims = each full-frame's dims);
//                delayMs = per-frame delay in MILLISECONDS (WebP uses ms, not GIF's
//                centiseconds); loop = 0 for infinite.
// Returns the animated-WebP file as a Uint8Array.
function muxAnimatedWebP(frameFiles, opts) {
  const { width, height, delayMs = 40, loop = 0 } = opts;
  if (!frameFiles || frameFiles.length === 0) throw new Error('muxAnimatedWebP: no frames');

  // Parse every still up front so the container VP8X Alpha flag can reflect
  // whether ANY frame carries alpha (ALPH chunk, or VP8L alpha_is_used bit).
  const frames = frameFiles.map(parseStillWebP);
  const anyAlpha = frames.some(f => f.hasAlpha);

  // One ANMF chunk per frame. Payload = 16-byte frame header + the frame's image
  // chunks (ALPH first if present, then VP8 /VP8L), each a full RIFF sub-chunk.
  const anmfChunks = frames.map(f => {
    const hdr = new Uint8Array(16);
    writeU24LE(hdr, 0, 0);           // Frame X (actual x = 2*value = 0)
    writeU24LE(hdr, 3, 0);           // Frame Y
    writeU24LE(hdr, 6, width - 1);   // Frame Width  minus one
    writeU24LE(hdr, 9, height - 1);  // Frame Height minus one
    writeU24LE(hdr, 12, delayMs);    // Frame Duration, milliseconds
    hdr[15] = 0x02;                  // flags: B=1 (overwrite, no blend), D=0 (keep canvas)
    const inner = [hdr];
    if (f.alph) inner.push(riffChunk('ALPH', f.alph)); // VP8L carries alpha intrinsically
    inner.push(riffChunk(f.fourcc, f.image));
    return riffChunk('ANMF', concat(inner));
  });

  // VP8X: extended-format feature flags + canvas size. flags bit 0x02 = Animation,
  // 0x10 = Alpha; 3 reserved bytes 0; then canvas width-1 / height-1 (24-bit LE).
  const vp8x = new Uint8Array(10);
  vp8x[0] = 0x02 | (anyAlpha ? 0x10 : 0);
  writeU24LE(vp8x, 4, width - 1);
  writeU24LE(vp8x, 7, height - 1);

  // ANIM: 4-byte background color (BGRA 0x00000000 = transparent) + 2-byte LE loop.
  const anim = new Uint8Array(6);
  anim[4] = loop & 0xFF; anim[5] = (loop >>> 8) & 0xFF;

  // Assemble: 'RIFF' + (size = rest of file) + 'WEBP' + VP8X + ANIM + ANMF*N.
  const body = concat([riffChunk('VP8X', vp8x), riffChunk('ANIM', anim), ...anmfChunks]);
  const head = concat([strBytes('RIFF'), u32le(4 + body.length), strBytes('WEBP')]);
  return concat([head, body]);
}

// ------------------------------------------------------------
// encodeAnimatedWebP — kept as a null stub. VP8/VP8L can't be produced from raw
// RGBA offline without a large, hard-to-validate entropy coder, so this returns
// null and the app falls back to APNG. To get real WebP, gather per-frame
// toBlob('image/webp') results and call muxAnimatedWebP instead.
// ------------------------------------------------------------
function encodeAnimatedWebP(/* frames, opts */) {
  return null;
}

export { encodeAPNG, encodeGIF, encodeAnimatedWebP, muxAnimatedWebP };
