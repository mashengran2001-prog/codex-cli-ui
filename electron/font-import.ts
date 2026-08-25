import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

/**
 * Nebula font_install.rs 对照实现：字体文件导入 / 私有字体安装。
 * - 只接受 .ttf/.otf/.ttc/.otc，空文件或超过 64 MB 拒绝
 * - 按内容 SHA-256 前 12 字节命名，重复导入幂等
 * - 从 sfnt 容器直接解析字体族名（无需系统注册），供 @font-face 与字体选择器使用
 */

export interface ImportedFontInfo {
  fileName: string;
  family: string;
  size: number;
}

export interface ImportFontResult {
  ok: boolean;
  family?: string;
  fileName?: string;
  size?: number;
  error?: string;
}

const SUPPORTED_EXTENSIONS = new Set(["ttf", "otf", "ttc", "otc"]);
const MAX_FONT_BYTES = 64 * 1024 * 1024;

export function supportedFontExtension(name: string): boolean {
  return SUPPORTED_EXTENSIONS.has(extname(name).slice(1).toLowerCase());
}

export function importedFontDirectory(userData: string): string {
  return join(userData, "fonts");
}

function u16(buffer: Uint8Array, offset: number): number {
  return (buffer[offset] << 8) | buffer[offset + 1];
}

function u32(buffer: Uint8Array, offset: number): number {
  return (((buffer[offset] << 24) | (buffer[offset + 1] << 16) | (buffer[offset + 2] << 8) | buffer[offset + 3]) >>> 0);
}

function decodeUtf16Be(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-16be").decode(bytes).replace(/\u0000/g, "");
  } catch {
    return "";
  }
}

/** MacRoman 近似解码：非 ASCII 字符按 Latin-1 兜底，族名通常为 ASCII。 */
function decodeMacRomanApprox(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

interface NameCandidate {
  nameId: number;
  platformId: number;
  value: string;
}

/**
 * 解析 sfnt（TTF/OTF/TTC/OTC）容器中的字体族名。
 * 优先 nameID 16（typographic family），其次 nameID 1（family）；
 * 同一名字只返回一次。无法解析时返回空数组。
 */
export function parseFontFamilyNames(buffer: Uint8Array): string[] {
  if (!buffer || buffer.length < 16) return [];
  const tag = String.fromCharCode(buffer[0], buffer[1], buffer[2], buffer[3]);
  let dirOffset = 12;
  let fontBase = 0;
  if (tag === "ttcf") {
    const numFonts = u32(buffer, 8);
    if (numFonts < 1) return [];
    const fontOffset = u32(buffer, 12);
    if (fontOffset + 12 > buffer.length) return [];
    fontBase = fontOffset;
    dirOffset = fontOffset + 12; // 记录区起点
  } else if (tag !== "OTTO" && tag !== "true" && tag !== "\u0000\u0001\u0000\u0000") {
    return [];
  }

  const numTables = u16(buffer, dirOffset - 8);
  let nameOffset = -1;
  for (let i = 0; i < numTables; i += 1) {
    const record = dirOffset + i * 16;
    if (record + 16 > buffer.length) break;
    const tableTag = String.fromCharCode(buffer[record], buffer[record + 1], buffer[record + 2], buffer[record + 3]);
    if (tableTag === "name") {
      nameOffset = fontBase + u32(buffer, record + 8);
      break;
    }
  }
  if (nameOffset < 0 || nameOffset + 6 > buffer.length) return [];

  const count = u16(buffer, nameOffset + 2);
  const stringOffset = u16(buffer, nameOffset + 4);
  const candidates: NameCandidate[] = [];
  for (let i = 0; i < count; i += 1) {
    const record = nameOffset + 6 + i * 12;
    if (record + 12 > buffer.length) break;
    const platformId = u16(buffer, record);
    const nameId = u16(buffer, record + 6);
    const length = u16(buffer, record + 8);
    const offset = u16(buffer, record + 10);
    const start = nameOffset + stringOffset + offset;
    if (length === 0 || start + length > buffer.length) continue;
    const raw = buffer.subarray(start, start + length);
    const value = (platformId === 0 || platformId === 3
      ? decodeUtf16Be(raw)
      : platformId === 1 ? decodeMacRomanApprox(raw) : "").trim();
    if (value) candidates.push({ nameId, platformId, value });
  }

  const familyScore = (candidate: NameCandidate) => (candidate.nameId === 16 ? 2 : candidate.nameId === 1 ? 1 : 0);
  const platformScore = (candidate: NameCandidate) => (candidate.platformId === 0 || candidate.platformId === 3 ? 1 : 0);
  candidates.sort((left, right) =>
    platformScore(right) - platformScore(left) || familyScore(right) - familyScore(left));

  const names: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (familyScore(candidate) === 0) continue;
    const key = candidate.value.toLocaleLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      names.push(candidate.value);
    }
  }
  return names;
}

/** 导入字体文件：校验扩展名/大小，按内容哈希复制到 userData/fonts，返回族名。 */
export async function importFontFile(source: string, userData: string): Promise<ImportFontResult> {
  if (!supportedFontExtension(source)) {
    return { ok: false, error: "只支持 .ttf、.otf、.ttc 和 .otc 字体文件" };
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(source);
  } catch {
    return { ok: false, error: "无法读取字体文件" };
  }
  if (bytes.length === 0 || bytes.length > MAX_FONT_BYTES) {
    return { ok: false, error: "字体文件为空或超过 64 MB 限制" };
  }
  const families = parseFontFamilyNames(bytes);
  const family = families[0];
  if (!family) return { ok: false, error: "字体文件不含可用的字体族" };

  const digest = createHash("sha256").update(bytes).digest("hex");
  const extension = extname(source).slice(1).toLowerCase();
  const fileName = `${digest.slice(0, 24)}.${extension}`;
  const directory = importedFontDirectory(userData);
  try {
    await mkdir(directory, { recursive: true });
  } catch {
    return { ok: false, error: "无法创建字体目录" };
  }
  const target = join(directory, fileName);
  try {
    await writeFile(target, bytes);
  } catch {
    return { ok: false, error: "无法保存导入字体" };
  }
  return { ok: true, family, fileName, size: bytes.length };
}

/** 列出已导入字体（读取族名与大小，按族名排序）。 */
export async function listImportedFonts(userData: string): Promise<ImportedFontInfo[]> {
  const directory = importedFontDirectory(userData);
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return [];
  }
  const fonts: ImportedFontInfo[] = [];
  for (const name of entries) {
    if (!supportedFontExtension(name)) continue;
    try {
      const bytes = await readFile(join(directory, name));
      const family = parseFontFamilyNames(bytes)[0];
      if (!family) continue;
      fonts.push({ fileName: name, family, size: bytes.length });
    } catch {
      // 单个损坏字体跳过，不影响其余字体。
    }
  }
  fonts.sort((left, right) => left.family.localeCompare(right.family, undefined, { sensitivity: "base" }));
  return fonts;
}

/** 删除一个已导入字体；文件名只取 basename，防路径穿越。 */
export async function deleteImportedFont(userData: string, fileName: string): Promise<boolean> {
  const name = basename(fileName);
  if (!supportedFontExtension(name)) return false;
  try {
    await unlink(join(importedFontDirectory(userData), name));
    return true;
  } catch {
    return false;
  }
}