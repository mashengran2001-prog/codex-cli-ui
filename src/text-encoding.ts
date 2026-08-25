/**
 * Windows 下子进程输出编码容错解码。
 * - 优先严格 UTF-8（应用内协议、CLI JSON 均为 UTF-8）
 * - 失败时整块按 GBK 解码（中文 Windows 的 cmd/powershell/git/svn/sftp 常输出 CP936）
 * - GBK 也产生替换字符时，逐字节兜底，避免出现 U+FFFD 乱码
 * 解码后仍残留的替换字符由 sanitizeDisplayText 在渲染层清理。
 */

const utf8Strict = new TextDecoder("utf-8", { fatal: true });
const gbk = new TextDecoder("gbk");

export function decodeWindowsText(chunk: Uint8Array | string): string {
  if (typeof chunk === "string") return chunk;
  if (!chunk || chunk.length === 0) return "";
  try {
    return utf8Strict.decode(chunk);
  } catch {
    // 非纯 UTF-8，尝试 GBK
  }
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

/** 清理解码产生的替换字符，避免警报/通知展示乱码。 */
export function sanitizeDisplayText(value: string): string {
  if (!value) return value;
  return value.replace(/\uFFFD+/g, "");
}
