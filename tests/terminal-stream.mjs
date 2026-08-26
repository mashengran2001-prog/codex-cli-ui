import assert from "node:assert/strict";
import { analyzeTerminalChunk } from "../dist-electron/electron/terminal-stream.js";

// 无 ESC 快检：普通文本块不触发任何转义扫描
let r = analyzeTerminalChunk("Hello world\n");
assert.equal(r.hasEscape, false);
assert.equal(r.commandFinished, false);
assert.deepEqual(r.osc7, []);
assert.equal(r.attention, false);

// 等待输入的语义识别（无 ESC 块直接全文快检）
r = analyzeTerminalChunk("Do you want to continue? [Y/n] ");
assert.equal(r.attention, true);
assert.equal(r.attentionMessage, "Do you want to continue? [Y/n]");
r = analyzeTerminalChunk("ls -la");
assert.equal(r.attention, false);

// 长消息截断到 180 字符
const long = "press enter to continue " + "x".repeat(300);
r = analyzeTerminalChunk(long);
assert.equal(r.attention, true);
assert.equal(r.attentionMessage?.length, 180);

// OSC 7 当前目录（file:// 编码路径，BEL 或 ST 结尾）
r = analyzeTerminalChunk("\x1b]7;file:///C:/Users/test/repo\x07");
assert.equal(r.hasEscape, true);
assert.deepEqual(r.osc7, ["/C:/Users/test/repo"]);
r = analyzeTerminalChunk("\x1b]7;file:///C:/my%20repo\x1b\\");
assert.deepEqual(r.osc7, ["/C:/my%20repo"]);

// 133;D / 133;A 命令收尾标记
assert.equal(analyzeTerminalChunk("\x1b]133;D;0\x07").commandFinished, true);
assert.equal(analyzeTerminalChunk("\x1b]133;A\x07").commandFinished, true);
assert.equal(analyzeTerminalChunk("\x1b]2;title\x07").commandFinished, false);

// 剥离 OSC/CSI 后的 attention 判定与消息
r = analyzeTerminalChunk("\x1b]0;codex\x07\x1b[31mAllow this command?\x1b[0m");
assert.equal(r.attention, true);
assert.equal(r.attentionMessage, "Allow this command?");

// 含 ESC 但不含命令收尾/attention
r = analyzeTerminalChunk("\x1b[38;2;50;72;58mPS> \x1b[0m");
assert.equal(r.commandFinished, false);
assert.equal(r.attention, false);
assert.equal(r.osc7.length, 0);

console.log("terminal-stream tests passed");
