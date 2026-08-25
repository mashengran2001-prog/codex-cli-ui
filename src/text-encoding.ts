/**
 * Windows 下子进程输出编码容错解码。
 * - 优先严格 UTF-8（应用内协议、CLI JSON 均为 UTF-8）
 * - 失败时整块按 GBK 解码（中文 Windows 的 cmd/powershell/git/svn/sftp 常输出 CP936）
 * - GBK 也产生替换字符时，逐字节兜底，避免出现 U+FFFD 乱码
 * - createWindowsTextDecoder 用于多块输出流：跨块截断的 GBK/UTF-8 字符会暂存到下一块
 * 解码后仍残留的替换字符由 sanitizeDisplayText 在渲染层清理。
 */

const utf8Strict = new TextDecoder("utf-8", { fatal: true });
const gbk = new TextDecoder("gbk");

function isStrictUtf8(chunk: Uint8Array): boolean {
  try {
    utf8Strict.decode(chunk);
    return true;
  } catch {
    return false;
  }
}

export function decodeWindowsText(chunk: Uint8Array | string): string {
  if (typeof chunk === "string") return chunk;
  if (!chunk || chunk.length === 0) return "";
  return decodeBlock(chunk);
}

/** 流式解码器：跨 chunk 保留未完成的 GBK/UTF-8 尾部字节，避免“乱码”字符被截断成两个乱码字符。 */
export interface WindowsTextStream {
  push(chunk: Uint8Array | string): string;
  flush(): string;
}

export function createWindowsTextDecoder(): WindowsTextStream {
  let pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  return {
    push(chunk: Uint8Array | string): string {
      if (typeof chunk === "string") return chunk;
      if (!chunk || chunk.length === 0) return "";
      const combined = concatBytes(pending, chunk);
      const tail = trailingIncompleteTail(combined);
      pending = combined.subarray(combined.length - tail);
      const body = combined.subarray(0, combined.length - tail);
      return body.length > 0 ? decodeBlock(body) : "";
    },
    flush(): string {
      if (pending.length === 0) return "";
      const text = decodeBlock(pending);
      pending = new Uint8Array(0) as Uint8Array<ArrayBufferLike>;
      return text;
    },
  };
}

function concatBytes(a: Uint8Array<ArrayBufferLike>, b: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBufferLike> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function decodeBlock(chunk: Uint8Array): string {
  if (isStrictUtf8(chunk)) return utf8Strict.decode(chunk);
  const gbkText = gbk.decode(chunk);
  if (!gbkText.includes("\uFFFD")) return gbkText;
  return decodeMixed(chunk);
}

function decodeMixed(chunk: Uint8Array): string {
  let out = "";
  let i = 0;
  while (i < chunk.length) {
    const byte = chunk[i]!;
    // GBK 双字节：首字节 0x81-0xFE，次字节 0x40-0xFE 且非 0x7F
    if (i + 1 < chunk.length && byte >= 0x81 && byte <= 0xFE && chunk[i + 1]! >= 0x40 && chunk[i + 1]! <= 0xFE && chunk[i + 1]! !== 0x7F) {
      try {
        out += gbk.decode(chunk.subarray(i, i + 2));
        i += 2;
        continue;
      } catch {
        // 无效 GBK 对，按单字节保留
      }
    }
    out += String.fromCharCode(byte);
    i += 1;
  }
  return out;
}

/** 返回 buffer 末尾疑似未完成 UTF-8 序列的字节数（0-3），供流式解码暂存。 */
function utf8IncompleteTail(buf: Uint8Array): number {
  const len = buf.length;
  if (len === 0) return 0;
  let tail = 0;
  const isCont = (byte: number) => byte >= 0x80 && byte <= 0xBF;
  const b0 = len >= 1 ? buf[len - 1]! : -1;
  const b1 = len >= 2 ? buf[len - 2]! : -1;
  const b2 = len >= 3 ? buf[len - 3]! : -1;
  // 1 字节在块尾：它是 2/3/4 字节序列的引导字节（续字节尚未到来）
  if (b0 >= 0xC2 && b0 <= 0xDF) tail = Math.max(tail, 1);
  if (b0 >= 0xE0 && b0 <= 0xEF) tail = Math.max(tail, 1);
  if (b0 >= 0xF0 && b0 <= 0xF4) tail = Math.max(tail, 1);
  // 2 字节在块尾：[引导, 续]（如 E4 B8 是“中”的前两字节）
  if (b1 >= 0xE0 && b1 <= 0xEF && isCont(b0) && !(b1 === 0xE0 && b0 < 0xA0) && !(b1 === 0xED && b0 > 0x9F)) tail = Math.max(tail, 2);
  if (b1 >= 0xF0 && b1 <= 0xF4 && isCont(b0) && !(b1 === 0xF0 && b0 < 0x90) && !(b1 === 0xF4 && b0 > 0x8F)) tail = Math.max(tail, 2);
  // 3 字节在块尾：[引导, 续, 续]（4 字节序列的前三字节）
  if (b2 >= 0xF0 && b2 <= 0xF4 && isCont(b1) && isCont(b0) && !(b2 === 0xF0 && b1 < 0x90) && !(b2 === 0xF4 && b1 > 0x8F)) tail = Math.max(tail, 3);
  return tail;
}

/** 返回 buffer 末尾应暂存给下一块的字节数（0-3）。优先级：完整 UTF-8 > 完整 GBK > UTF-8 截断 > GBK 截断。 */
function trailingIncompleteTail(buf: Uint8Array): number {
  const len = buf.length;
  if (len === 0) return 0;
  // 1) 整块是完整 UTF-8：立即输出，无需暂存。
  if (isStrictUtf8(buf)) return 0;
  const tailU = utf8IncompleteTail(buf);
  const last = buf[len - 1]!;
  const gbkWhole = gbk.decode(buf);
  const gbkWholeClean = !gbkWhole.includes("\uFFFD");
  let utf8Plausible = false;
  if (tailU > 0) {
    const bodyU = buf.subarray(0, len - tailU);
    utf8Plausible = isStrictUtf8(bodyU);
  }
  // 2) 整块 GBK 可干净解码，且末尾不是明显的 UTF-8 截断 → 当作完整 GBK 块。
  if (gbkWholeClean && !utf8Plausible) return 0;
  // 3) UTF-8 截断（跨块中文字符）优先暂存。
  if (utf8Plausible) return tailU;
  // 4) GBK 首字节在块尾未配对（GBK 解码在末尾产生替换符）。
  if (last >= 0x81 && last <= 0xFE && gbkWhole.endsWith("\uFFFD")) {
    const bodyG = buf.subarray(0, len - 1);
    if (bodyG.length > 0 && !gbk.decode(bodyG).includes("\uFFFD")) return 1;
  }
  // 5) 兜底：按 UTF-8 截断暂存。
  return tailU;
}

/** 清理解码产生的替换字符与杂散控制字节，避免警报/通知展示乱码。 */
export function sanitizeDisplayText(value: string): string {
  if (!value) return value;
  return value
    .replace(/[\uFFFD\u0080-\u009F]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}
