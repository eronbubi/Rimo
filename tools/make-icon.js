// Draws the app icon (blue gradient rounded square with a white "R") and writes build/icon.png and build/icon.ico.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;
const SS = 4; // supersampling per axis

function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

function segDist(px, py, ax, ay, bx, by) {
  const t = clamp(((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2), 0, 1);
  return Math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay)));
}

// 0 = outside, 1 = blue background, 2 = white letter
function inside(x, y) {
  const r = 58, lo = 8, hi = SIZE - 8;
  if (x < lo || x > hi || y < lo || y > hi) return 0;
  const cx = clamp(x, lo + r, hi - r), cy = clamp(y, lo + r, hi - r);
  if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) return 0;
  const stem = x >= 76 && x <= 106 && y >= 60 && y <= 196;
  const bars = x >= 76 && x <= 132 && ((y >= 60 && y <= 90) || (y >= 118 && y <= 148));
  const d = Math.hypot(x - 132, y - 104);
  const bowl = x >= 132 && d <= 44 && d >= 14;
  const leg = segDist(x, y, 128, 136, 176, 190) <= 15 && y <= 196;
  return stem || bars || bowl || leg ? 2 : 1;
}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    const t = (x + y) / (2 * SIZE); // diagonal gradient #3b82f6 -> #1e40af
    const bg = [59 + (30 - 59) * t, 130 + (64 - 130) * t, 246 + (175 - 246) * t];
    for (let i = 0; i < SS; i++) {
      for (let j = 0; j < SS; j++) {
        const hit = inside(x + (i + 0.5) / SS, y + (j + 0.5) / SS);
        if (hit === 1) { r += bg[0]; g += bg[1]; b += bg[2]; a += 255; }
        else if (hit === 2) { r += 255; g += 255; b += 255; a += 255; }
      }
    }
    const n = SS * SS, cover = a / 255 || 1, o = y * (SIZE * 4 + 1) + 1 + x * 4;
    raw[o] = r / cover; raw[o + 1] = g / cover; raw[o + 2] = b / cover; raw[o + 3] = a / n;
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc(body), body.length + 4);
  return out;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
]);

const ico = Buffer.alloc(22);
ico.writeUInt16LE(1, 2); // type: icon
ico.writeUInt16LE(1, 4); // one image; width/height bytes stay 0 = 256
ico.writeUInt16LE(1, 10);
ico.writeUInt16LE(32, 12);
ico.writeUInt32LE(png.length, 14);
ico.writeUInt32LE(22, 18);

const out = path.join(__dirname, '..', 'build');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'icon.png'), png);
fs.writeFileSync(path.join(out, 'icon.ico'), Buffer.concat([ico, png]));
console.log('icon written to', out);
