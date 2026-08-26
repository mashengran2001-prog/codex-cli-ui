import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Nebula v1.3.1 对照实现：应用内验证更新。
 * - 从 GitHub latest release 挑选官方 Windows x64 安装包（优先 NSIS Setup exe）
 * - 后台下载并上报进度
 * - 校验大小、PE 头（MZ + PE\\0\\0）与 SHA-256（发布体或 .sha256 资产中声明时）
 * - 全部通过后才允许启动安装程序（由用户显式确认）
 */

export interface UpdateAsset {
  name: string;
  size: number;
  url: string;
}

export interface UpdateRelease {
  tag: string;
  body: string;
  assets: UpdateAsset[];
}

export interface VerifyResult {
  ok: boolean;
  sha256?: string;
  error?: string;
}

/** 挑选 Windows 安装包：优先 Setup（NSIS），其次 Portable，最后任意 .exe。 */
export function pickInstallerAsset(assets: readonly UpdateAsset[] | undefined | null): UpdateAsset | undefined {
  if (!assets || !assets.length) return undefined;
  const exe = assets.filter((asset) => /\.exe$/i.test(asset.name));
  if (!exe.length) return undefined;
  return exe.find((asset) => /setup/i.test(asset.name))
    ?? exe.find((asset) => /portable/i.test(asset.name))
    ?? exe[0];
}

/** 校验 PE 可执行文件头：MZ 魔数 + 0x3C 处指向的 PE\\0\\0 签名。 */
export function validatePeHeader(buffer: Uint8Array): boolean {
  if (!buffer || buffer.length < 0x40) return false;
  if (buffer[0] !== 0x4D || buffer[1] !== 0x5A) return false; // MZ
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const peOffset = view.getUint32(0x3C, true);
  if (peOffset + 4 > buffer.byteLength) return false;
  return buffer[peOffset] === 0x50
    && buffer[peOffset + 1] === 0x45
    && buffer[peOffset + 2] === 0x00
    && buffer[peOffset + 3] === 0x00;
}

/** 从发布说明中解析声明的 SHA-256（支持 SHA-256: / SHA256: / sha-256 等写法）。 */
export function parseSha256Checksum(body: string | undefined | null): string | undefined {
  if (!body) return undefined;
  const match = body.match(/(?:sha-?256|sha256)[:\s]+([0-9a-fA-F]{64})/i);
  return match?.[1]?.toLowerCase();
}

/** 从 .sha256 资产内容中解析校验和（首段 64 位 hex）。 */
export function parseSha256AssetContent(content: string | undefined | null): string | undefined {
  if (!content) return undefined;
  const match = content.match(/\b[0-9a-fA-F]{64}\b/);
  return match?.[0]?.toLowerCase();
}

export function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 160) || "update.exe";
}

/** 流式下载到目标文件，报告已接收/总字节。 */
export async function downloadToFile(
  url: string,
  dest: string,
  onProgress?: (received: number, total: number | undefined) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(url, { signal, headers: { "User-Agent": "codex-cli-ui" } });
  if (!response.ok || !response.body) throw new Error(`下载失败 HTTP ${response.status}`);
  const total = Number(response.headers.get("content-length")) || undefined;
  await mkdir(dirname(dest), { recursive: true });
  const reader = response.body.getReader();
  let received = 0;
  await new Promise<void>((resolve, reject) => {
    const sink = createWriteStream(dest);
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      sink.destroy();
      reject(error);
    };
    sink.on("error", fail);
    const pump = async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.length) {
            received += value.length;
            onProgress?.(received, total);
            if (!sink.write(Buffer.from(value))) {
              await new Promise<void>((drainResolve) => sink.once("drain", () => drainResolve()));
            }
          }
        }
        sink.end();
        sink.on("finish", () => {
          if (settled) return;
          settled = true;
          resolve();
        });
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    };
    void pump();
  });
  if (total !== undefined && received !== total) {
    throw new Error(`下载不完整 ${received}/${total}`);
  }
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function readHeader(file: string, bytes: number): Promise<Uint8Array> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** 校验安装包：大小、PE 头、SHA-256（声明时）。 */
export async function verifyInstallerFile(
  file: string,
  expectedSize: number | undefined,
  expectedSha256?: string | undefined,
): Promise<VerifyResult> {
  try {
    const info = await stat(file);
    if (expectedSize !== undefined && info.size !== expectedSize) {
      return { ok: false, error: `大小不匹配 ${info.size} != ${expectedSize}` };
    }
    if (info.size < 0x40) return { ok: false, error: "文件过小，不是有效的安装包" };
    const header = await readHeader(file, 0x1000);
    if (!validatePeHeader(header)) return { ok: false, error: "PE 头校验失败" };
    const sha256 = await sha256File(file);
    if (expectedSha256 && sha256 !== expectedSha256.toLowerCase()) {
      return { ok: false, error: "SHA-256 校验失败" };
    }
    return { ok: true, sha256 };
  } catch (reason) {
    return { ok: false, error: reason instanceof Error ? reason.message : String(reason) };
  }
}

export interface InstallerMetadata {
  name?: string;
  size?: number;
  sha256?: string;
}

/** 安装包旁路校验元数据文件：记录下载时通过的大小与 SHA-256，供启动安装前二次校验。 */
export function installerMetadataPath(installerPath: string): string {
  return `${installerPath}.verified.json`;
}

/** 把下载时校验通过的大小与 SHA-256 原子写入旁路元数据。 */
export async function writeInstallerMetadata(
  installerPath: string,
  metadata: { name: string; size: number; sha256?: string | undefined },
): Promise<void> {
  const metaPath = installerMetadataPath(installerPath);
  const temporary = `${metaPath}.tmp`;
  const payload = {
    name: metadata.name,
    size: metadata.size,
    sha256: metadata.sha256 ? metadata.sha256.toLowerCase() : undefined,
    verifiedAt: new Date().toISOString(),
  };
  await mkdir(dirname(installerPath), { recursive: true });
  await writeFile(temporary, JSON.stringify(payload, null, 2), "utf8");
  await rename(temporary, metaPath);
}

/** 读取旁路元数据；文件缺失、JSON 损坏或字段类型非法时按字段宽容降级，全空返回 null。 */
export async function readInstallerMetadata(installerPath: string): Promise<InstallerMetadata | null> {
  try {
    const raw = await readFile(installerMetadataPath(installerPath), "utf8");
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || typeof value !== "object") return null;
    const size = typeof value.size === "number" && Number.isFinite(value.size) && value.size >= 0 ? value.size : undefined;
    const sha256 = typeof value.sha256 === "string" && /^[0-9a-fA-F]{64}$/.test(value.sha256) ? value.sha256.toLowerCase() : undefined;
    const name = typeof value.name === "string" && value.name.length > 0 && value.name.length <= 200 ? value.name : undefined;
    if (size === undefined && sha256 === undefined) return null;
    return { name, size, sha256 };
  } catch {
    return null;
  }
}

/** 替换目标文件（Windows 上先删旧文件再改名）。 */
export async function replaceFile(source: string, target: string): Promise<void> {
  await unlink(target).catch(() => {});
  await rename(source, target);
}