import assert from "node:assert/strict";
import {
  bareRecoveryEvidence,
  hasTeXEvidence,
  normalizeTeX,
  scanTerminalMath,
} from "../dist-electron/src/terminal/terminal-math.js";

// ---- hasTeXEvidence：中等证据 ----
assert.equal(hasTeXEvidence("x^2"), true);
assert.equal(hasTeXEvidence("\\frac{1}{2}"), true);
assert.equal(hasTeXEvidence("E=mc^2"), true);
assert.equal(hasTeXEvidence("5 and 6"), false);
assert.equal(hasTeXEvidence("   "), false);

// ---- bareRecoveryEvidence：保守证据 ----
assert.equal(bareRecoveryEvidence("\\frac{1}{2}"), true);
assert.equal(bareRecoveryEvidence("x^2 + y^2"), true);
assert.equal(bareRecoveryEvidence("a + b"), false);
assert.equal(bareRecoveryEvidence("a + b - c"), true);

// ---- normalizeTeX ----
assert.equal(normalizeTeX("\\frac13"), "\\frac{1}{3}");
assert.equal(normalizeTeX("\\sqrt2"), "\\sqrt{2}");
assert.equal(normalizeTeX("a &amp;&amp; b"), "a && b");
assert.equal(normalizeTeX("x \n 2"), "x2");
assert.equal(normalizeTeX("\\frac{1}{2}"), "\\frac{1}{2}");

// ---- 单行内联 $...$ ----
const inline = scanTerminalMath(["answer: $x^2$ ok"]);
assert.equal(inline.length, 1);
assert.equal(inline[0].startRow, 0);
assert.equal(inline[0].startCol, 8);
assert.equal(inline[0].endRow, 0);
assert.equal(inline[0].endCol, 12);
assert.equal(inline[0].source, "x^2");
assert.equal(inline[0].display, false);

// ---- 行内 $$ 与 $ 区分 ----
const mixed = scanTerminalMath(["$$a^2$$ and $b^2$"]);
assert.equal(mixed.length, 2);
assert.equal(mixed[0].display, true);
assert.equal(mixed[0].source, "a^2");
assert.equal(mixed[1].display, false);
assert.equal(mixed[1].source, "b^2");

// ---- \(...\) 与 \[...\] ----
const paren = scanTerminalMath(["inline \\(a^2\\), display \\[\\int_0^1 x\\,dx\\]"]);
assert.ok(paren.some((span) => span.source === "a^2" && !span.display));
assert.ok(paren.some((span) => span.source.includes("\\int_0^1") && span.display));

// ---- 裸括号恢复（Markdown 剥掉定界符） ----
const bare = scanTerminalMath(["value (\\frac{1}{2}) here"]);
assert.equal(bare.length, 1);
assert.equal(bare[0].source, "\\frac{1}{2}");
const bareNo = scanTerminalMath(["(a + b) is not math evidence"]);
assert.equal(bareNo.length, 0);

// ---- 跨行硬换行公式 ----
const wrapped = scanTerminalMath(["text $x^", "2$ end"]);
assert.equal(wrapped.length, 1);
assert.equal(wrapped[0].startRow, 0);
assert.equal(wrapped[0].endRow, 1);
assert.equal(wrapped[0].source, "x^2");

// ---- 跨 $$ 显示公式 ----
const displayWrapped = scanTerminalMath(["$$E=mc^2", "$$ done"]);
assert.equal(displayWrapped.length, 1);
assert.equal(displayWrapped[0].display, true);
assert.equal(displayWrapped[0].endRow, 1);

// ---- dim 行不渲染 ----
const dimmed = scanTerminalMath(["$x^2$", "$y^2$"], [true, false]);
assert.equal(dimmed.length, 1);
assert.equal(dimmed[0].source, "y^2");

// ---- 货币 $ 不误判 ----
const currency = scanTerminalMath(["Price $5 and $6"]);
assert.equal(currency.length, 0);

console.log("terminal-math.mjs ok");