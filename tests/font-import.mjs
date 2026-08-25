import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteImportedFont,
  importFontFile,
  listImportedFonts,
  parseFontFamilyNames,
  supportedFontExtension,
} from "../dist-electron/electron/font-import.js";

// ---- 扩展名校验 ----
assert.equal(supportedFontExtension("a.ttf"), true);
assert.equal(supportedFontExtension("a.OTF"), true);
assert.equal(supportedFontExtension("a.ttc"), true);
assert.equal(supportedFontExtension("a.otc"), true);
assert.equal(supportedFontExtension("a.woff2"), false);
assert.equal(supportedFontExtension("a.txt"), false);

// ---- 合成 sfnt 字体 ----
function utf16be(str) {
  const buf = Buffer.alloc(str.length * 2);
  for (let i = 0; i < str.length; i += 1) buf.writeUInt16BE(str.charCodeAt(i), i * 2);
  return buf;
}

function buildSyntheticTtf(familyNames) {
  const records = [];
  const strings = [];
  let stringOffset = 0;
  const push = (nameId, value) => {
    const bytes = utf16be(value);
    records.push({ platformID: 3, encodingID: 1, languageID: 0x409, nameID: nameId, offset: stringOffset, length: bytes.length });
    strings.push(bytes);
    stringOffset += bytes.length;
  };
  familyNames.forEach((name) => { push(1, name); push(16, name); });

  const nameTable = Buffer.alloc(6 + records.length * 12 + stringOffset);
  nameTable.writeUInt16BE(0, 0);
  nameTable.writeUInt16BE(records.length, 2);
  nameTable.writeUInt16BE(6 + records.length * 12, 4);
  records.forEach((record, index) => {
    const offset = 6 + index * 12;
    nameTable.writeUInt16BE(record.platformID, offset);
    nameTable.writeUInt16BE(record.encodingID, offset + 2);
    nameTable.writeUInt16BE(record.languageID, offset + 4);
    nameTable.writeUInt16BE(record.nameID, offset + 6);
    nameTable.writeUInt16BE(record.length, offset + 8);
    nameTable.writeUInt16BE(record.offset, offset + 10);
  });
  strings.forEach((bytes, index) => bytes.copy(nameTable, 6 + records.length * 12 + records[index].offset));

  const numTables = 1;
  const dirOffset = 12;
  const nameOffset = dirOffset + 12 + 16;
  const ttf = Buffer.alloc(nameOffset + nameTable.length);
  ttf.writeUInt32BE(0x00010000, 0);
  ttf.writeUInt16BE(numTables, 4);
  ttf.writeUInt16BE(16, 6);
  ttf.writeUInt16BE(0, 8);
  ttf.writeUInt16BE(0, 10);
  ttf.write("name", dirOffset, "ascii");
  ttf.writeUInt32BE(0, dirOffset + 4);
  ttf.writeUInt32BE(nameOffset, dirOffset + 8);
  ttf.writeUInt32BE(nameTable.length, dirOffset + 12);
  nameTable.copy(ttf, nameOffset);
  return ttf;
}

function wrapCollection(ttf) {
  const head = Buffer.alloc(16);
  head.write("ttcf", 0, "ascii");
  head.writeUInt32BE(0x00010000, 4);
  head.writeUInt32BE(1, 8);
  head.writeUInt32BE(16, 12);
  return Buffer.concat([head, ttf]);
}

const mono = buildSyntheticTtf(["My Test Mono"]);
assert.deepEqual(parseFontFamilyNames(mono), ["My Test Mono"]);
assert.deepEqual(parseFontFamilyNames(wrapCollection(mono)), ["My Test Mono"]);

const multi = buildSyntheticTtf(["First Mono", "Second Mono"]);
const parsedMulti = parseFontFamilyNames(multi);
assert.deepEqual(parsedMulti, ["First Mono", "Second Mono"]);

// 无效输入
assert.deepEqual(parseFontFamilyNames(Buffer.alloc(8)), []);
assert.deepEqual(parseFontFamilyNames(Buffer.from("not a font at all")), []);
assert.deepEqual(parseFontFamilyNames(null), []);

// 非 sfnt 魔数
const garbage = Buffer.alloc(64);
garbage.write("GARB", 0, "ascii");
assert.deepEqual(parseFontFamilyNames(garbage), []);

// ---- 导入 / 列表 / 删除（临时 userData）----
const tmp = mkdtempSync(join(tmpdir(), "codex-font-import-"));
try {
  const userData = join(tmp, "userData");
  const source = join(tmp, "My Test Mono.ttf");
  writeFileSync(source, mono);

  const result = await importFontFile(source, userData);
  assert.equal(result.ok, true);
  assert.equal(result.family, "My Test Mono");
  assert.ok(result.fileName);
  assert.match(result.fileName, /^[0-9a-f]{24}\.ttf$/);

  // 重复导入幂等：同名文件已存在
  const again = await importFontFile(source, userData);
  assert.equal(again.ok, true);
  assert.equal(again.fileName, result.fileName);

  const listed = await listImportedFonts(userData);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].family, "My Test Mono");
  assert.equal(listed[0].fileName, result.fileName);
  assert.equal(listed[0].size, mono.length);

  // 不支持的类型 / 空文件
  const badExt = join(tmp, "note.txt");
  writeFileSync(badExt, "hello");
  assert.equal((await importFontFile(badExt, userData)).ok, false);
  const empty = join(tmp, "empty.ttf");
  writeFileSync(empty, Buffer.alloc(0));
  assert.equal((await importFontFile(empty, userData)).ok, false);

  // 删除
  assert.equal(await deleteImportedFont(userData, result.fileName), true);
  assert.equal(await deleteImportedFont(userData, result.fileName), false);
  assert.equal((await listImportedFonts(userData)).length, 0);
  // 路径穿越拒绝
  assert.equal(await deleteImportedFont(userData, "..\\..\\evil.ttf"), false);
  assert.equal(readdirSync(join(userData, "fonts")).length, 0);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log("font-import tests passed");