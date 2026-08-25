import assert from "node:assert/strict";
import { createWindowsTextDecoder, decodeWindowsText, sanitizeDisplayText } from "../dist-electron/src/text-encoding.js";

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

// 渲染层防御：残留替换字符与杂散控制字节被清理
assert.equal(sanitizeDisplayText("错误\uFFFD\uFFFD信息"), "错误信息");
assert.equal(sanitizeDisplayText("a\u0085b\u009Cc"), "abc");
assert.equal(sanitizeDisplayText("干净文本"), "干净文本");

// 流式解码：GBK 双字节被 chunk 截断时跨块正确还原（“乱码警报”GBK 字节）
{
  const gbkBytes = Buffer.from([0xC2, 0xD2, 0xC2, 0xEB, 0xBE, 0xAF, 0xB1, 0xA8]);
  const decoder = createWindowsTextDecoder();
  assert.equal(decoder.push(gbkBytes.subarray(0, 3)), "乱");
  assert.equal(decoder.push(gbkBytes.subarray(3, 7)), "码警");
  assert.equal(decoder.push(gbkBytes.subarray(7)), "报");
  assert.equal(decoder.flush(), "");
}

// 流式解码：GBK 首字节在块尾、次字节在下一块
{
  const decoder = createWindowsTextDecoder();
  assert.equal(decoder.push(Buffer.from([0xC2])), "");
  assert.equal(decoder.push(Buffer.from([0xD2])), "乱");
  assert.equal(decoder.flush(), "");
}

// 流式解码：UTF-8 中文字符被截断
{
  const utf8 = Buffer.from("中文", "utf8");
  const decoder = createWindowsTextDecoder();
  assert.equal(decoder.push(utf8.subarray(0, 4)), "中");
  assert.equal(decoder.push(utf8.subarray(4)), "文");
  assert.equal(decoder.flush(), "");
}

// 流式解码：ASCII 前缀 + GBK 内容跨块（git/svn 错误输出典型形态）
{
  const gbk = Buffer.from([0xC2, 0xD2, 0xC2, 0xEB]);
  const decoder = createWindowsTextDecoder();
  assert.equal(decoder.push(Buffer.from("fatal: ", "utf8")), "fatal: ");
  assert.equal(decoder.push(gbk.subarray(0, 3)), "乱");
  assert.equal(decoder.push(gbk.subarray(3)), "码");
  assert.equal(decoder.flush(), "");
}

// 完整 UTF-8 块不应被误判暂存
{
  const decoder = createWindowsTextDecoder();
  assert.equal(decoder.push(Buffer.from("中文 UTF8 正常", "utf8")), "中文 UTF8 正常");
  assert.equal(decoder.flush(), "");
}

console.log("text-encoding.mjs ok");
