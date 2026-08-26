import assert from "node:assert/strict";
import {
  ansiRgb,
  boxGlyphGeometry,
  boxStrokeSize,
  isBoxGlyph,
} from "../dist-electron/src/terminal/box-glyphs.js";

// ---- 码点识别范围（U+2500–U+259F） ----
assert.equal(isBoxGlyph(0x2500), true);
assert.equal(isBoxGlyph(0x2540), true);
assert.equal(isBoxGlyph(0x259f), true);
assert.equal(isBoxGlyph(0x2600), false);
assert.equal(isBoxGlyph(0x2499), false);

// ---- 线宽计算 ----
assert.equal(boxStrokeSize(8), 1);
assert.equal(boxStrokeSize(12), 2); // round(12/8) = 2（粗线）
assert.equal(boxStrokeSize(3), 1); // max(1, round(0.375)) 不下探到 0

// ---- 单线水平 ─：左右两段各占半格 ----
const horiz = boxGlyphGeometry(0x2500, 10, 20);
assert.equal(horiz.fills.length, 2);
assert.equal(horiz.strokes.length, 0);
assert.equal(horiz.arcs.length, 0);
for (const fill of horiz.fills) {
  assert.equal(fill.h, 1);
  assert.equal(fill.y, 9.5); // midY - 0.5
}
assert.equal(horiz.fills.reduce((sum, f) => sum + f.w, 0), 10); // 两段拼满整格

// ---- 单线垂直 │：上下两段 ----
const vert = boxGlyphGeometry(0x2502, 10, 20);
assert.equal(vert.fills.length, 2);
for (const fill of vert.fills) {
  assert.equal(fill.w, 1);
  assert.equal(fill.x, 4.5); // midX - 0.5
}

// ---- 单线角 ┌ ----
const corner = boxGlyphGeometry(0x250c, 10, 20);
assert.equal(corner.fills.length, 2);
assert.equal(corner.strokes.length, 0);

// ---- 双线 ═：左右各两条 ----
const double = boxGlyphGeometry(0x2550, 10, 20);
assert.equal(double.fills.length, 4);
assert.equal(double.strokes.length, 0);
for (const fill of double.fills) {
  assert.equal(fill.h, 1);
  assert.ok(fill.y === 8.5 || fill.y === 10.5); // 上下两条各隔一格线宽
}

// ---- 对角 ╱：单条 stroke ----
const diagonal = boxGlyphGeometry(0x2571, 10, 20);
assert.equal(diagonal.fills.length, 0);
assert.equal(diagonal.strokes.length, 1);
assert.equal(diagonal.strokes[0].x1, 0);
assert.equal(diagonal.strokes[0].y1, 20);
assert.equal(diagonal.strokes[0].x2, 10);
assert.equal(diagonal.strokes[0].y2, 0);
assert.equal(diagonal.strokes[0].width, 1);

// ---- 弧角 ╭：一条 arc，半径 = min(w,h)/2 ----
const arc = boxGlyphGeometry(0x256d, 10, 20);
assert.equal(arc.arcs.length, 1);
assert.equal(arc.arcs[0].cx, 0);
assert.equal(arc.arcs[0].cy, 0);
assert.equal(arc.arcs[0].r, 5);
assert.equal(arc.arcs[0].width, 1);

// ---- 满方块 █ ----
const block = boxGlyphGeometry(0x2588, 10, 20);
assert.equal(block.fills.length, 1);
assert.deepEqual(
  [block.fills[0].x, block.fills[0].y, block.fills[0].w, block.fills[0].h],
  [0, 0, 10, 20],
);

// ---- 左上象限 ▘（2598 = UL） ----
const quadrant = boxGlyphGeometry(0x2598, 10, 20);
assert.equal(quadrant.fills.length, 1);
assert.deepEqual(
  [quadrant.fills[0].x, quadrant.fills[0].y, quadrant.fills[0].w, quadrant.fills[0].h],
  [0, 0, 5, 10],
);

// ---- 对角象限 ▚（259a = UL + LR） ----
assert.equal(boxGlyphGeometry(0x259a, 10, 20).fills.length, 2);

// ---- 阴影 ░：固定灰度 ----
const shade = boxGlyphGeometry(0x2591, 10, 20);
assert.equal(shade.fills.length, 1);
assert.equal(shade.fills[0].gray, 191);

// ---- 256 色板 ----
assert.deepEqual(ansiRgb(1), [205, 0, 0]);
assert.deepEqual(ansiRgb(9), [255, 0, 0]);
assert.deepEqual(ansiRgb(196), [255, 0, 0]);
assert.deepEqual(ansiRgb(244), [128, 128, 128]);

// ---- 范围外字符返回空几何，交给字体渲染 ----
const empty = boxGlyphGeometry(0x2600, 10, 20);
assert.equal(empty.fills.length + empty.strokes.length + empty.arcs.length, 0);

console.log("box-glyphs tests passed");
