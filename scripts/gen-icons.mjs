// Draws the app icon (an rpm arc with a boost arc inside) to PNG with no dependencies.
// usage: node scripts/gen-icons.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

mkdirSync('public/icons', { recursive: true });

function crc32(buf) {
  let c, crc = ~0;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return ~crc >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// angle measured clockwise from the arc start at 135 degrees, sweep 270
function arcCoverage(px, py, cx, cy, r, w, fracEnd) {
  const dx = px - cx, dy = py - cy;
  const d = Math.hypot(dx, dy);
  let a = Math.atan2(dy, dx) - Math.PI * 0.75;
  while (a < 0) a += Math.PI * 2;
  const sweep = Math.PI * 1.5;
  if (a > sweep * fracEnd) return 0;
  const edge = Math.max(0, Math.min(1, w / 2 - Math.abs(d - r) + 0.5));
  return edge;
}

function icon(size) {
  return png(size, (x, y) => {
    const c = size / 2;
    const bg = [8, 9, 11];
    let col = bg.slice();
    const mixIn = (rgb, cov) => { for (let i = 0; i < 3; i++) col[i] = col[i] * (1 - cov) + rgb[i] * cov; };
    // faint track
    mixIn([28, 32, 39], arcCoverage(x, y, c, c, size * 0.36, size * 0.085, 1));
    mixIn([244, 245, 247], arcCoverage(x, y, c, c, size * 0.36, size * 0.085, 0.72));
    mixIn([28, 32, 39], arcCoverage(x, y, c, c, size * 0.23, size * 0.05, 1));
    mixIn([255, 166, 77], arcCoverage(x, y, c, c, size * 0.23, size * 0.05, 0.55));
    return [Math.round(col[0]), Math.round(col[1]), Math.round(col[2]), 255];
  });
}

writeFileSync('public/icons/icon-192.png', icon(192));
writeFileSync('public/icons/icon-512.png', icon(512));
writeFileSync('public/favicon.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#08090b"/><path d="M14.5 49.5A25 25 0 1 1 49.5 49.5" fill="none" stroke="#1c2027" stroke-width="6"/><path d="M14.5 49.5A25 25 0 0 1 41 8.2" fill="none" stroke="#f4f5f7" stroke-width="6"/><path d="M20 44A16 16 0 0 1 23 20" fill="none" stroke="#ffa64d" stroke-width="4"/></svg>\n`);
console.log('icons written to public/icons and public/favicon.svg');
