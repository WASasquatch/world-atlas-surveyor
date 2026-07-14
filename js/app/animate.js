// Animated 360° export — drives the GL renderer through one full rotation,
// captures a centered 1:1 square per frame, and hands the frames to the
// APNG/GIF/WebP encoders. Transparent mode captures only the alpha-bearing
// planet canvas; opaque mode composites the starfield behind it.
//
// WebP is real animated WebP: each frame is encoded to a still WebP by the
// browser (canvas.toBlob 'image/webp'), then muxed into an ANIM/ANMF
// container. If the browser can't produce WebP (older Safari), it falls back
// to APNG.

import { encodeAPNG, encodeGIF, muxAnimatedWebP } from './anim-encoders.js';

/**
 * @param {GLRenderer} renderer active GL renderer
 * @param {object} opts { frames, format ('apng'|'gif'|'webp'), alpha, size, delayMs, onProgress }
 * @returns {Promise<{bytes: Uint8Array, mime: string, ext: string}>}
 */
async function captureAnimation(renderer, opts) {
  const { frames, format, alpha, delayMs = 40, onProgress } = opts;
  const OUT = opts.size || 384;
  const glCanvas = renderer.canvas;
  const starsCanvas = renderer.starsCanvas;

  const off = document.createElement('canvas');
  off.width = OUT; off.height = OUT;
  const octx = off.getContext('2d');

  const toBlob = (q) => new Promise((res) => off.toBlob(res, 'image/webp', q));

  // Decide the WebP path ONCE up front — WebP encode support is browser-wide,
  // so probing a single frame avoids gathering BOTH a WebP and an RGBA frame
  // set (which at 1024px × 240 would retain ~1 GB). Only the chosen set is kept.
  let useWebp = false;
  if (format === 'webp') {
    octx.clearRect(0, 0, OUT, OUT);
    octx.fillRect(0, 0, 1, 1);
    const probe = await toBlob(0.9);
    useWebp = !!(probe && probe.type === 'image/webp');
  }

  // freeze all time-based animation so the 360 spin loops seamlessly
  renderer.beginCapture();

  const rgbaFrames = [];       // APNG / GIF (and WebP-unsupported fallback)
  const webpFrames = [];       // still-WebP bytes for the muxer

  for (let i = 0; i < frames; i++) {
    renderer.rotation = (i / frames) * Math.PI * 2;   // exact 2π/frames step; never emit the 2π frame
    renderer.render(0);                               // capture mode: only the rigid spin varies

    // centered square crops, recomputed each frame in case the canvas resized
    const gSize = Math.min(glCanvas.width, glCanvas.height);
    const gx = (glCanvas.width - gSize) / 2, gy = (glCanvas.height - gSize) / 2;
    const sSize = Math.min(starsCanvas.width, starsCanvas.height);
    const sx = (starsCanvas.width - sSize) / 2, sy = (starsCanvas.height - sSize) / 2;

    octx.clearRect(0, 0, OUT, OUT);
    if (!alpha) {
      octx.imageSmoothingEnabled = true;              // stars scale smoothly
      octx.drawImage(starsCanvas, sx, sy, sSize, sSize, 0, 0, OUT, OUT);
    }
    octx.imageSmoothingEnabled = false;               // planet keeps crisp pixels
    octx.drawImage(glCanvas, gx, gy, gSize, gSize, 0, 0, OUT, OUT);

    if (useWebp) {
      const blob = await toBlob(alpha ? 1.0 : 0.92);   // lossless-ish for alpha
      webpFrames.push(new Uint8Array(await blob.arrayBuffer()));
    } else {
      const img = octx.getImageData(0, 0, OUT, OUT);
      rgbaFrames.push(new Uint8ClampedArray(img.data));
    }
    if (onProgress) onProgress(i + 1, frames);
    await new Promise((r) => setTimeout(r, 0));        // yield so the progress text paints
  }

  renderer.endCapture();

  const encOpts = { width: OUT, height: OUT, delayMs, loop: 0, transparent: alpha };
  if (useWebp) {
    return { bytes: muxAnimatedWebP(webpFrames, { width: OUT, height: OUT, delayMs, loop: 0 }), mime: 'image/webp', ext: 'webp' };
  }
  if (format === 'gif') {
    return { bytes: encodeGIF(rgbaFrames, encOpts), mime: 'image/gif', ext: 'gif' };
  }
  // apng, or webp fallback (browser without WebP encode)
  return { bytes: encodeAPNG(rgbaFrames, encOpts), mime: 'image/png', ext: 'png' };
}

export { captureAnimation };
