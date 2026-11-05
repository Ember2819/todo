// Draws the toolbar icon: a dark tile, a dithered accent glow rising from
// the bottom (Bayer 4x4), and a check mark. Run: node tools/make-icons.mjs
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
const png = (size, rgba) => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
};

const segDist = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};

const BG = [24, 24, 27];
const INK = [96, 140, 255];
const FG = [250, 250, 250];

const draw = (size) => {
  const out = Buffer.alloc(size * size * 4);
  const cell = Math.max(1, Math.round(size / 32));
  const radius = 0.24;
  const ss = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let tile = 0, check = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const u = (x + (sx + 0.5) / ss) / size;
          const v = (y + (sy + 0.5) / ss) / size;
          // Rounded square.
          const qx = Math.max(Math.abs(u - 0.5) - (0.5 - radius), 0);
          const qy = Math.max(Math.abs(v - 0.5) - (0.5 - radius), 0);
          if (Math.hypot(qx, qy) <= radius) tile++;
          const w = size <= 16 ? 0.085 : 0.065;
          const d = Math.min(segDist(u, v, 0.28, 0.52, 0.43, 0.67), segDist(u, v, 0.43, 0.67, 0.73, 0.35));
          if (d <= w) check++;
        }
      }
      tile /= ss * ss;
      check /= ss * ss;
      // Dithered glow, densest at the bottom.
      const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
      const v = (y + 0.5) / size;
      const tone = size >= 32 ? Math.max(0, Math.min(1, (v - 0.42) / 0.58)) ** 1.3 * 0.9 : 0;
      const inked = tone > (BAYER4[(cy % 4) * 4 + (cx % 4)] + 0.5) / 16;
      let color = inked ? INK : BG;
      color = color.map((c, i) => c + (FG[i] - c) * check);
      const o = (y * size + x) * 4;
      out[o] = color[0];
      out[o + 1] = color[1];
      out[o + 2] = color[2];
      out[o + 3] = Math.round(tile * 255);
    }
  }
  return png(size, out);
};

for (const size of [16, 32, 48, 128]) writeFileSync(new URL(`../icons/icon-${size}.png`, import.meta.url), draw(size));
console.log("icons written");
