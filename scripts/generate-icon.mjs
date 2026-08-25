// scripts/generate-icon.mjs — 生成应用图标：256x256 PNG + PNG-in-ICO（Electron 任务栏/Alt+Tab、安装包图标）
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = 256;
const SS = 4;
const N = OUT * SS;

let crcTable;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function encodePng(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}
function encodeIco(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry[0] = 0; entry[1] = 0;
  entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png.length, 8); entry.writeUInt32LE(22, 12);
  return Buffer.concat([header, entry, png]);
}
function roundedRectSdf(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

const acc = new Float64Array(N * N * 4);
const segs = [[80, 104, 146, 128], [146, 128, 80, 152], [82, 176, 146, 176]];
const stroke = 15;
for (let y = 0; y < N; y++) {
  const py = (y + 0.5) / SS;
  const t = py / OUT;
  const bgR = 138 + (79 - 138) * t;
  const bgG = 123 + (70 - 123) * t;
  const bgB = 255 + (229 - 255) * t;
  for (let x = 0; x < N; x++) {
    const px = (x + 0.5) / SS;
    const d = roundedRectSdf(px, py, 128, 128, 120, 120, 58);
    const a = Math.max(0, Math.min(1, 0.5 - d));
    if (a <= 0) continue;
    let gd = Infinity;
    for (const [ax, ay, bx, by] of segs) gd = Math.min(gd, segDist(px, py, ax, ay, bx, by));
    const ga = Math.max(0, Math.min(1, 0.5 - (gd - stroke / 2)));
    const r = bgR + (255 - bgR) * ga;
    const g = bgG + (255 - bgG) * ga;
    const b = bgB + (255 - bgB) * ga;
    const i = (y * N + x) * 4;
    acc[i] += r * a; acc[i + 1] += g * a; acc[i + 2] += b * a; acc[i + 3] += a;
  }
}
const rgba = Buffer.alloc(OUT * OUT * 4);
for (let y = 0; y < OUT; y++) {
  for (let x = 0; x < OUT; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const i = (((y * SS + sy) * N) + (x * SS + sx)) * 4;
        r += acc[i]; g += acc[i + 1]; b += acc[i + 2]; a += acc[i + 3];
      }
    }
    const i = (y * OUT + x) * 4;
    const div = SS * SS;
    const alpha = Math.min(255, Math.round((a / div) * 255));
    rgba[i + 3] = alpha;
    if (alpha > 0) {
      const k = 255 / alpha;
      rgba[i] = Math.round((r / div) * k);
      rgba[i + 1] = Math.round((g / div) * k);
      rgba[i + 2] = Math.round((b / div) * k);
    }
  }
}
mkdirSync(join(root, "build"), { recursive: true });
const png = encodePng(OUT, OUT, rgba);
writeFileSync(join(root, "build", "icon.png"), png);
writeFileSync(join(root, "build", "icon.ico"), encodeIco(png));
writeFileSync(join(root, "build", "icon-base64.txt"), png.toString("base64"));
console.log(`icon: ${png.length} bytes png, ${OUT}x${OUT}`);