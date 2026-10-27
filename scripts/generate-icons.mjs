// Renders the Ordo mark (public/favicon.svg) to the PNG icons the web app manifest and push
// notifications need. Run after changing the mark: node scripts/generate-icons.mjs
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const out = new URL('../apps/web/public/', import.meta.url);
const hex = (h) => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const PINK = [hex('#ff5cb8'), hex('#ff1493'), hex('#c6006f')];
const gradient = (t) =>
  t < 0.55 ? mix(PINK[0], PINK[1], t / 0.55) : mix(PINK[1], PINK[2], (t - 0.55) / 0.45);
const BG = hex('#09090b');
const EDGE = hex('#49313e');
const CYAN = hex('#2de2e6');

/** Colour (or null) at a point of the 32×32 mark; `full` fills the square (maskable icons). */
function sample(x, y, { full, mono, scale = 1 }) {
  // The mark sits centred, scaled down for maskable icons' safe zone.
  const mx = (x - 16) / scale + 16;
  const my = (y - 16) / scale + 16;
  if (mx >= 9 && mx < 14 && my >= 7 && my < 25)
    return mono ? [255, 255, 255] : gradient((my - 7) / 18);
  if (mx >= 18 && mx < 23 && my >= 19 && my < 24) return mono ? [255, 255, 255] : CYAN;
  if (mono) return null;
  if (full) return BG;
  // Chamfered tile: top-right and bottom-left corners cut at 6 units.
  const inside = x - y < 26 && y - x < 26;
  if (!inside) return null;
  const edge = x < 1 || y < 1 || x > 31 || y > 31 || x - y > 25 || y - x > 25;
  return edge ? EDGE : BG;
}

function render(size, opts) {
  const ss = 4; // supersampling per axis
  const rows = [];
  for (let py = 0; py < size; py++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let px = 0; px < size; px++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          const c = sample(
            ((px + (sx + 0.5) / ss) / size) * 32,
            ((py + (sy + 0.5) / ss) / size) * 32,
            opts,
          );
          if (c) {
            r += c[0];
            g += c[1];
            b += c[2];
            a += 255;
          }
        }
      const n = ss * ss;
      const cover = a / n / 255;
      const i = 1 + px * 4;
      row[i] = cover ? r / n / cover : 0;
      row[i + 1] = cover ? g / n / cover : 0;
      row[i + 2] = cover ? b / n / cover : 0;
      row[i + 3] = a / n;
    }
    rows.push(row);
  }
  return png(size, Buffer.concat(rows));
}

function png(size, raw) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const icons = {
  'icon-192.png': [192, {}],
  'icon-512.png': [512, {}],
  'icon-maskable-512.png': [512, { full: true, scale: 0.72 }],
  'apple-touch-icon.png': [180, { full: true, scale: 0.72 }],
  'badge-96.png': [96, { mono: true }],
};
for (const [name, [size, opts]] of Object.entries(icons)) {
  writeFileSync(new URL(name, out), render(size, opts));
  console.log(`wrote ${name}`);
}
