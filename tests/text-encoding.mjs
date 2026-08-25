import assert from "node:assert/strict";
import { decodeWindowsText, sanitizeDisplayText } from "../dist-electron/src/text-encoding.js";

// UTF-8 内容应原样直通
assert.equal(decodeWindowsText(Buffer.from("中文 utf8 正常", "utf8")), "中文 utf8 正常");
assert.equal(decodeWindowsText(Buffer.from([])), "");

// GBK（中文 Windows 控制台常见 CP936）应回退解码，不再出现替换字符
// "乱码警报" 的 GBK 字节：C2 D2 C2 EB BE AF B1 A8
const gbk = Buffer.from([0xC2, 0xD2, 0xC2, 0xEB, 0xBE, 0xAF, 0xB1, 0xA8]);
const decoded = decodeWindowsText(gbk);
assert.equal(decoded, "乱码警报");
assert.ok(!decoded.includes("\uFFFD"));

// ASCII 前缀 + GBK 内容（git/svn 错误输出的典型形态）
const asciiPrefix = Buffer.concat([Buffer.from("fatal: ", "utf8"), gbk]);
assert.equal(decodeWindowsText(asciiPrefix), "fatal: 乱码警报");
assert.ok(!decodeWindowsText(asciiPrefix).includes("\uFFFD"));

// 残留替换字符的兜底（GBK 也无法解释的字节尾）不再泄漏 U+FFFD
const oddTail = decodeWindowsText(Buffer.concat([gbk, Buffer.from([0x81])]));
assert.ok(!oddTail.includes("\uFFFD"));

// 渲染层防御：残留替换字符被清理
assert.equal(sanitizeDisplayText("错误\uFFFD\uFFFD信息"), "错误信息");
assert.equal(sanitizeDisplayText("干净文本"), "干净文本");

console.log("text-encoding.mjs ok");
