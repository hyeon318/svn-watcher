'use strict';
// 외부 의존 없이 PNG 아이콘 생성 (앱 아이콘 + 트레이 상태별 아이콘)
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

// 도형: 좌표는 0~1 정규화
const roundRect = (inset, r) => (x, y) => {
  const cx = Math.min(Math.max(x, inset + r), 1 - inset - r);
  const cy = Math.min(Math.max(y, inset + r), 1 - inset - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r && x >= inset && x <= 1 - inset && y >= inset && y <= 1 - inset;
};
const disk = (cx, cy, r) => (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
const rect = (x0, y0, x1, y1) => (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1;

function render(size, layers) {
  const SS = 4;
  const out = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          let col = null;
          for (const [shape, c] of layers) if (shape(x, y)) col = c;
          if (col) { r += col[0]; g += col[1]; b += col[2]; a += 1; }
        }
      }
      const n = SS * SS;
      const i = (py * size + px) * 4;
      if (a > 0) {
        out[i] = Math.round(r / a); out[i + 1] = Math.round(g / a); out[i + 2] = Math.round(b / a);
        out[i + 3] = Math.round((a / n) * 255);
      }
    }
  }
  return encodePng(size, size, out);
}

const WHITE = [255, 255, 255];
function icon(baseHex, badgeHex, { small = false } = {}) {
  const base = hex(baseHex);
  // 커밋 그래프 모양: 세로선 + 노드(링)
  const lineW = small ? 0.06 : 0.045;
  const layers = [
    [roundRect(small ? 0.02 : 0.04, small ? 0.2 : 0.22), base],
    [rect(0.5 - lineW, 0.16, 0.5 + lineW, 0.84), WHITE],
    [disk(0.5, 0.5, small ? 0.22 : 0.2), WHITE],
    [disk(0.5, 0.5, small ? 0.11 : 0.11), base],
  ];
  if (badgeHex) {
    layers.push([disk(0.79, 0.21, small ? 0.23 : 0.2), WHITE]);
    layers.push([disk(0.79, 0.21, small ? 0.17 : 0.155), hex(badgeHex)]);
  }
  return layers;
}

const root = path.join(__dirname, '..', 'assets');
fs.mkdirSync(path.join(root, 'tray'), { recursive: true });

fs.writeFileSync(path.join(root, 'icon.png'), render(256, icon('#2563eb')));

// Windows 용 .ico (PNG 압축 엔트리, Vista 이상) — 작은 크기는 굵은 선 버전으로 선명하게
function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // 아이콘
  header.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + dir.length;
  images.forEach(({ size, png }, i) => {
    const o = i * 16;
    dir[o] = size >= 256 ? 0 : size;
    dir[o + 1] = size >= 256 ? 0 : size;
    dir[o + 2] = 0;
    dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4); // planes
    dir.writeUInt16LE(32, o + 6); // bpp
    dir.writeUInt32LE(png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...images.map((x) => x.png)]);
}
const icoImages = [16, 24, 32, 48, 64, 128, 256].map((size) => ({
  size,
  png: render(size, icon('#2563eb', null, { small: size <= 32 })),
}));
fs.writeFileSync(path.join(root, 'icon.ico'), encodeIco(icoImages));

const states = {
  normal: ['#2563eb', null],
  new: ['#2563eb', '#16a34a'],
  error: ['#2563eb', '#dc2626'],
  paused: ['#64748b', null],
};
for (const [name, [base, badge]] of Object.entries(states)) {
  fs.writeFileSync(path.join(root, 'tray', `tray-${name}.png`), render(16, icon(base, badge, { small: true })));
  fs.writeFileSync(path.join(root, 'tray', `tray-${name}@2x.png`), render(32, icon(base, badge, { small: true })));
}
console.log('icons generated');
