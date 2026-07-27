/**
 * Generates the PWA PNG icons.
 *
 * Written by hand rather than pulled from a library: the icon is a handful of
 * rounded rectangles and a circle over a gradient, and a 60-line rasteriser
 * plus zlib beats adding an image toolchain to the build.
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../packages/client/public');

function crc32(buf) {
  let c;
  const table = crc32.table ?? (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Signed distance to a rounded rectangle, used for cheap anti-aliasing. */
function roundedRectSdf(px, py, x, y, w, h, r) {
  const cx = Math.abs(px - (x + w / 2)) - (w / 2 - r);
  const cy = Math.abs(py - (y + h / 2)) - (h / 2 - r);
  const dx = Math.max(cx, 0);
  const dy = Math.max(cy, 0);
  return Math.min(Math.max(cx, cy), 0) + Math.sqrt(dx * dx + dy * dy) - r;
}

function circleSdf(px, py, cx, cy, r) {
  return Math.hypot(px - cx, py - cy) - r;
}

function mix(a, b, t) {
  return a + (b - a) * t;
}

function draw(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const s = size / 32; // the artwork is authored on a 32×32 grid
  const aa = 0.8 * s;

  const put = (i, r, g, b, a) => {
    const prev = rgba[i + 3] / 255;
    const alpha = a + prev * (1 - a);
    if (alpha <= 0) return;
    rgba[i] = Math.round((r * a + rgba[i] * prev * (1 - a)) / alpha);
    rgba[i + 1] = Math.round((g * a + rgba[i + 1] * prev * (1 - a)) / alpha);
    rgba[i + 2] = Math.round((b * a + rgba[i + 2] * prev * (1 - a)) / alpha);
    rgba[i + 3] = Math.round(alpha * 255);
  };

  const coverage = (d) => Math.max(0, Math.min(1, 0.5 - d / aa));

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const px = x + 0.5;
      const py = y + 0.5;

      // Background plate with the brand gradient.
      const plate = coverage(roundedRectSdf(px, py, 0, 0, size, size, 9 * s));
      if (plate > 0) {
        const t = (x / size + y / size) / 2;
        put(i, Math.round(mix(32, 116, t)), Math.round(mix(129, 68, t)), Math.round(mix(239, 232, t)), plate);
      }

      const white = (d, alpha) => {
        const cov = coverage(d) * alpha;
        if (cov > 0) put(i, 255, 255, 255, cov);
      };

      white(roundedRectSdf(px, py, 6.5 * s, 7 * s, 9 * s, 5 * s, 2.5 * s), 0.95);
      white(roundedRectSdf(px, py, 17 * s, 7 * s, 8.5 * s, 5 * s, 2.5 * s), 0.6);
      white(roundedRectSdf(px, py, 6.5 * s, 14 * s, 5 * s, 11 * s, 2.5 * s), 0.6);
      white(circleSdf(px, py, 19.2 * s, 19.5 * s, 5.6 * s), 1);
    }
  }
  return rgba;
}

mkdirSync(outDir, { recursive: true });
for (const size of [192, 512, 180]) {
  const png = encodePng(size, size, draw(size));
  const name = size === 180 ? 'apple-touch-icon.png' : `icon-${size}.png`;
  writeFileSync(resolve(outDir, name), png);
  process.stdout.write(`wrote ${name} (${png.length} bytes)\n`);
}
