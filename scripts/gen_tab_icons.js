/**
 * Generate WeChat tabBar icons (zero-dependency). v2
 * SDF rasterization at 6x supersample -> 81x81 RGBA PNG.
 */
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

const OUT_DIR = path.join(__dirname, "..", "assets", "tab");
const SIZE = 81;
const SS = 6;

const clamp = (v, a, b) => Math.min(Math.max(v, a), b);

// ---------- SDF primitives ----------
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(ax, ay) - r;
}
function sdCircle(px, py, cx, cy, r) {
  return Math.hypot(px - cx, py - cy) - r;
}
function sdSegment(px, py, ax, ay, bx, by) {
  const pax = px - ax, pay = py - ay, bax = bx - ax, bay = by - ay;
  const h = clamp((pax * bax + pay * bay) / (bax * bax + bay * bay), 0, 1);
  return Math.hypot(pax - bax * h, pay - bay * h);
}
function sdArc(px, py, cx, cy, r, a0, a1) {
  const dx = px - cx, dy = py - cy;
  const ang = Math.atan2(dy, dx);
  let a = ang;
  while (a < a0) a += Math.PI * 2;
  while (a > a1) a -= Math.PI * 2;
  const px2 = cx + r * Math.cos(a), py2 = cy + r * Math.sin(a);
  return Math.hypot(px - px2, py - py2);
}

// ---------- icons (filled / solid style) ----------
const icons = {
  // 日记: solid notebook — filled rounded rect, negative-space spine + text lines
  diary(x, y) {
    return sdRoundRect(x, y, 40.5, 40.5, 22, 25, 10);
  },
  // 旅行: solid location pin — filled head + thick tapered tail
  travel(x, y) {
    const head = sdCircle(x, y, 40.5, 31, 16.5);
    const tailL = sdSegment(x, y, 30.5, 41.5, 40.5, 65) - 7.5;
    const tailR = sdSegment(x, y, 50.5, 41.5, 40.5, 65) - 7.5;
    return Math.min(head, tailL, tailR);
  },
  // 我的: solid person — filled head + dome shoulders
  my(x, y) {
    const head = sdCircle(x, y, 40.5, 25, 13);
    const body = sdCircle(x, y, 40.5, 67, 21);
    const dome = body < 0 && y > 47;
    return head < 0 || dome ? -1 : 1;
  },
};

// per-icon cutouts (negative space) and additive details
const holes = {
  diary(x, y) {
    // spine groove + text lines
    const spine = sdSegment(x, y, 29.5, 15, 29.5, 66);
    const l1 = sdSegment(x, y, 35, 30, 56, 30);
    const l2 = sdSegment(x, y, 35, 40, 56, 40);
    const l3 = sdSegment(x, y, 35, 50, 48, 50);
    return Math.min(spine, l1, l2, l3);
  },
  travel(x, y) {
    return sdCircle(x, y, 40.5, 31, 7);
  },
};
const holeHalfWidth = {
  diary: 1.8,
  travel: 0, // fill hole
};

// ---------- PNG encode ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0;
    rgba.copy(raw, y * (1 + w * 4) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- render ----------
function hexToRgb(hex) {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

function renderIconFull(name, shapeFn, colorTop, colorBottom) {
  const holeFn = holes[name];
  const hw = holeHalfWidth[name];
  const big = SIZE * SS;
  const cov = new Float32Array(SIZE * SIZE);
  const rCov = new Float32Array(SIZE * SIZE);
  const gCov = new Float32Array(SIZE * SIZE);
  const bCov = new Float32Array(SIZE * SIZE);
  for (let sy = 0; sy < big; sy++) {
    for (let sx = 0; sx < big; sx++) {
      const x = (sx + 0.5) / SS;
      const y = (sy + 0.5) / SS;
      let inside = shapeFn(x, y) < 0;
      if (inside && holeFn && holeFn(x, y) < hw) inside = false;
      const idx = Math.floor(sy / SS) * SIZE + Math.floor(sx / SS);
      if (!inside) continue;
      const t = y / SIZE;
      cov[idx] += 1;
      rCov[idx] += colorTop[0] + (colorBottom[0] - colorTop[0]) * t;
      gCov[idx] += colorTop[1] + (colorBottom[1] - colorTop[1]) * t;
      bCov[idx] += colorTop[2] + (colorBottom[2] - colorTop[2]) * t;
    }
  }
  const rgba = Buffer.alloc(SIZE * SIZE * 4);
  for (let i = 0; i < SIZE * SIZE; i++) {
    const a = cov[i] / (SS * SS);
    rgba[i * 4] = Math.round(rCov[i] / (SS * SS));
    rgba[i * 4 + 1] = Math.round(gCov[i] / (SS * SS));
    rgba[i * 4 + 2] = Math.round(bCov[i] / (SS * SS));
    rgba[i * 4 + 3] = Math.round(a * 255);
  }
  return encodePNG(SIZE, SIZE, rgba);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
// default: solid soft gray; active: vertical gradient blue
const GRAY = [hexToRgb("#a9aebc")[0], hexToRgb("#a9aebc")[1], hexToRgb("#a9aebc")[2]];
const BLUE_TOP = hexToRgb("#8ec3ff");
const BLUE_BOT = hexToRgb("#5b9bfc");

for (const [name, fn] of Object.entries(icons)) {
  fs.writeFileSync(path.join(OUT_DIR, `${name}.png`), renderIconFull(name, fn, GRAY, GRAY));
  fs.writeFileSync(path.join(OUT_DIR, `${name}-active.png`), renderIconFull(name, fn, BLUE_TOP, BLUE_BOT));
  console.log(`done: ${name}`);
}
