import assert from "node:assert/strict";
import { DRAG_SCROLL_MAX_LINES, DRAG_SCROLL_PX_PER_LINE, DRAG_SCROLL_TICK_MS, dragScrollStep } from "../dist-electron/src/terminal/drag-scroll.js";
assert.equal(DRAG_SCROLL_PX_PER_LINE, 20);
assert.equal(DRAG_SCROLL_TICK_MS, 15);
assert.equal(DRAG_SCROLL_MAX_LINES, 16);
assert.equal(dragScrollStep(0), 0);
assert.equal(dragScrollStep(5), 1);
assert.equal(dragScrollStep(19), 1);
assert.equal(dragScrollStep(20), 2);
assert.equal(dragScrollStep(39), 2);
assert.equal(dragScrollStep(40), 3);
assert.equal(dragScrollStep(-5), -1);
assert.equal(dragScrollStep(-60), -4);
assert.equal(dragScrollStep(300), DRAG_SCROLL_MAX_LINES);
assert.equal(dragScrollStep(-300), -DRAG_SCROLL_MAX_LINES);
assert.equal(dragScrollStep(Number.POSITIVE_INFINITY), 0); // 非有限输入按保护逻辑返回 0
assert.equal(dragScrollStep(Number.NaN), 0);
console.log("drag-scroll tests passed");
