/**
 * Nebula encrypted_backup.rs 对照实现：口令加密的工作区导出/恢复。
 * - 文件格式：NEBUBAK1 | salt(16) | nonce(12) | AES-256-GCM(JSON, AAD=NEBUBAK1)
 * - 密钥派生：Argon2id(19_456 KiB, t=2, p=1) → Node scrypt(N=2^14, r=8, p=1) 近似
 * - 导出只读 userData 内的白名单文件；SSH 私钥/凭据永不进包
 * - 恢复先完整解密 + 校验（magic/版本/分类白名单/路径/内容），再逐文件原子写
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync, type Stats } from "node:fs";
import { mkdir, readFile, readdir, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";


export const BACKUP_MAGIC = Buffer.from("NEBUBAK1", "ascii");
export const BACKUP_ARCHIVE_VERSION = 1;
const SALT_LEN = 16;
const NONCE_LEN = 12;
const KEY_LEN = 32;
const MAX_PACKET_BYTES = 512 * 1024 * 1024;
const MIN_PASSPHRASE = 8;

export type BackupCategory =
  | "appearance"
  | "config"
  | "ssh"
  | "session"
  | "directory_history"
  | "command_history"
  | "fonts";

export interface BackupSelection {
  appearance: boolean;
  config: boolean;
  ssh: boolean;
  session: boolean;
  directory_history: boolean;
  command_history: boolean;
  fonts: boolean;
}

export const DEFAULT_BACKUP_SELECTION: BackupSelection = {
  appearance: true,
  config: false,
  ssh: false,
  session: false,
  directory_history: false,
  command_history: false,
  fonts: false,
};

export interface BackupEntry {
  category: BackupCategory;
  name: string;
  bytes: Uint8Array;
}

export interface BackupManifest {
  version: number;
  categories: BackupCategory[];
}

export interface BackupArchive {
  manifest: BackupManifest;
  entries: BackupEntry[];
}

export interface BackupResult {
  ok: boolean;
  message?: string;
  path?: string;
  error?: string;
}

export interface BackupPreviewEntry {
  category: BackupCategory;
  name: string;
  size: number;
  /** 目标位置当前已存在（恢复时会覆盖）。 */
  exists: boolean;
}

export interface BackupPreview {
  ok: boolean;
  filePath?: string;
  entries?: BackupPreviewEntry[];
  message?: string;
  error?: string;
}

const CATEGORY_ORDER: BackupCategory[] = [
  "appearance",
  "config",
  "ssh",
  "session",
  "directory_history",
  "command_history",
  "fonts",
];

/** 恢复时每个分类允许的文件名（白名单即安全边界）。 */
const ALLOWED_NAMES: Record<BackupCategory, (name: string) => boolean> = {
  appearance: (name) => name === "settings.json",
  config: (name) => name === "cli-profiles.json",
  ssh: (name) => name === "ssh-profiles.json",
  session: (name) => name === "terminal-sessions.json",
  directory_history: (name) => name === "directory-history.json",
  command_history: (name) => name === "terminal-history.jsonl",
  fonts: (name) => name.startsWith("fonts/") && name.length > "fonts/".length,
};

function selectedCategories(selection: BackupSelection): BackupCategory[] {
  return CATEGORY_ORDER.filter((category) => selection[category]);
}

export function backupSelectionEmpty(selection: BackupSelection): boolean {
  return selectedCategories(selection).length === 0;
}

function validatePassphrase(passphrase: string): void {
  if (passphrase.length < MIN_PASSPHRASE) {
    throw new Error("备份密码至少 8 位");
  }
}

/** Argon2id(19_456 KiB, t=2, p=1) 的参数近似：scrypt N=2^14, r=8, p=1（16 MiB）。 */
function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_LEN, { N: 1 << 14, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

export function safeArchivePath(root: string, name: string): string {
  if (!name || name.length > 4096 || isAbsolute(name) || /^[a-zA-Z]:[\\/]/.test(name) || name.startsWith("\\\\")) throw new Error(`unsafe backup path: ${JSON.stringify(name)}`);
  const resolved = resolve(root, name);
  const rootPrefix = `${resolve(root)}${sep}`;
  if (resolved !== resolve(root) && !resolved.toLowerCase().startsWith(rootPrefix.toLowerCase())) {
    throw new Error(`unsafe backup path: ${JSON.stringify(name)}`);
  }
  const normalized = name.split(/[\\/]+/).filter(Boolean);
  if (normalized.length === 0 || normalized.some((part) => part === "." || part === "..")) {
    throw new Error(`unsafe backup path: ${JSON.stringify(name)}`);
  }
  return resolved;
}

/** 解密前只做结构检查；解密后再用 validateArchive 做分类白名单校验。 */
export function checkPacketHeader(packet: Buffer): { salt: Buffer; nonce: Buffer; ciphertext: Buffer } {
  const headerLen = BACKUP_MAGIC.length + SALT_LEN + NONCE_LEN;
  if (packet.length <= headerLen || packet.length > MAX_PACKET_BYTES) {
    throw new Error("不是有效的加密备份或版本不受支持");
  }
  if (!timingSafeEqual(packet.subarray(0, BACKUP_MAGIC.length), BACKUP_MAGIC)) {
    throw new Error("不是有效的加密备份或版本不受支持");
  }
  return {
    salt: packet.subarray(BACKUP_MAGIC.length, BACKUP_MAGIC.length + SALT_LEN),
    nonce: packet.subarray(BACKUP_MAGIC.length + SALT_LEN, headerLen),
    ciphertext: packet.subarray(headerLen),
  };
}

/** 序列化并加密：NEBUBAK1 | salt | nonce | ciphertext(AAD=NEBUBAK1)。 */
export async function seal(archive: BackupArchive, passphrase: string): Promise<Buffer> {
  validatePassphrase(passphrase);
  if (archive.manifest.version !== BACKUP_ARCHIVE_VERSION) {
    throw new Error("不支持该备份归档版本");
  }
  validateArchive(archive);
  const plaintext = Buffer.from(JSON.stringify(archive), "utf8");
  const salt = randomBytes(SALT_LEN);
  const nonce = randomBytes(NONCE_LEN);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(BACKUP_MAGIC);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return Buffer.concat([BACKUP_MAGIC, salt, nonce, ciphertext]);
}

/** 认证并解密整个归档，再校验内容。 */
export async function open(packet: Buffer, passphrase: string): Promise<BackupArchive> {
  validatePassphrase(passphrase);
  const { salt, nonce, ciphertext } = checkPacketHeader(packet);
  const key = deriveKey(passphrase, salt);
  const authTag = ciphertext.subarray(ciphertext.length - 16);
  const payload = ciphertext.subarray(0, ciphertext.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(BACKUP_MAGIC);
  decipher.setAuthTag(authTag);
  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([decipher.update(payload), decipher.final()]);
  } catch {
    throw new Error("备份认证失败（口令错误或文件被篡改）");
  }
  let archive: BackupArchive;
  try {
    archive = JSON.parse(plaintext.toString("utf8")) as BackupArchive;
  } catch {
    throw new Error("备份归档内容无效");
  }
  validateArchive(archive);
  return archive;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 设置文件导出前脱敏：去掉代理凭据与密钥类字段（对标上游 ssh_proxy_* 过滤）。 */
export function sanitizeSettingsBytes(bytes: Uint8Array): Uint8Array {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new Error("设置文件不是有效 JSON");
  }
  if (!isJsonObject(value)) return bytes;
  for (const key of ["proxyUrl", "proxyBypass", "proxyPassword", "proxyUsername", "apiKey"]) {
    delete value[key];
  }
  return Buffer.from(JSON.stringify(value, null, 2), "utf8");
}

/** SSH 配置文件导出前脱敏：剥离私钥与代理字段（对标上游 ssh_is_sanitized）。 */
export function sanitizeSshBytes(bytes: Uint8Array): Uint8Array {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new Error("SSH 配置文件不是有效 JSON");
  }
  if (isJsonObject(value) && Array.isArray(value.profiles)) {
    value.profiles = value.profiles.map((profile) => {
      if (!isJsonObject(profile)) return profile;
      const copy = { ...profile };
      delete copy.private_keys;
      delete copy.privateKeys;
      delete copy.identityFiles;
      delete copy.identityFile;
      delete copy.proxy;
      delete copy.password;
      delete copy.passphrase;
      return copy;
    });
  }
  return Buffer.from(JSON.stringify(value, null, 2), "utf8");
}

function addFile(root: string, category: BackupCategory, name: string, entries: BackupEntry[], transform?: (bytes: Uint8Array) => Uint8Array): void {
  const path = join(root, name);
  if (!existsSync(path)) return;
  let bytes = readFileSync(path);
  if (transform) bytes = Buffer.from(transform(bytes));
  entries.push({ category, name, bytes });
}

async function collectFonts(root: string, entries: BackupEntry[]): Promise<void> {
  const fontsRoot = join(root, "fonts");
  if (!existsSync(fontsRoot)) return;
  const stack = [fontsRoot];
  while (stack.length > 0) {
    const directory = stack.pop()!;
    let items: string[];
    try {
      items = readdirSync(directory);
    } catch (error) {
      throw new Error(`读取字体目录失败：${error instanceof Error ? error.message : String(error)}`);
    }
    for (const item of items) {
      const path = join(directory, item);
      let stats: Stats;
      try {
        stats = lstatSync(path);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        stack.push(path);
      } else if (stats.isFile()) {
        const name = relative(root, path).split(sep).join("/");
        if (!name.startsWith("fonts/")) continue;
        entries.push({ category: "fonts", name, bytes: readFileSync(path) });
      }
    }
  }
}

/** 收集选定分类的文件（只读 userData 白名单）。 */
export async function collect(userData: string, selection: BackupSelection): Promise<BackupArchive> {
  const entries: BackupEntry[] = [];
  for (const category of selectedCategories(selection)) {
    switch (category) {
      case "appearance":
        addFile(userData, category, "settings.json", entries, sanitizeSettingsBytes);
        break;
      case "config":
        addFile(userData, category, "cli-profiles.json", entries);
        break;
      case "ssh":
        addFile(userData, category, "ssh-profiles.json", entries, sanitizeSshBytes);
        break;
      case "session":
        addFile(userData, category, "terminal-sessions.json", entries);
        break;
      case "directory_history":
        addFile(userData, category, "directory-history.json", entries);
        break;
      case "command_history":
        addFile(userData, category, "terminal-history.jsonl", entries);
        break;
      case "fonts":
        await collectFonts(userData, entries);
        break;
    }
  }
  return {
    manifest: { version: BACKUP_ARCHIVE_VERSION, categories: selectedCategories(selection) },
    entries,
  };
}

/** 导出：collect + seal，写入用户选择的路径。 */
export async function exportBackup(userData: string, selection: BackupSelection, passphrase: string, outputPath: string): Promise<BackupResult> {
  try {
    if (backupSelectionEmpty(selection)) throw new Error("请至少勾选一个备份类别");
    const archive = await collect(userData, selection);
    const packet = await seal(archive, passphrase);
    const target = resolve(outputPath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, packet);
    return { ok: true, message: `已导出加密备份：${target}`, path: target };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message, error: message };
  }
}

/** 恢复前预览：解密并列出将写入的文件（含是否已存在，即是否会覆盖）。 */
export async function previewArchive(packet: Buffer, passphrase: string, userData: string): Promise<BackupPreviewEntry[]> {
  const archive = await open(packet, passphrase);
  return archive.entries.map((entry) => {
    const path = safeArchivePath(userData, entry.name);
    return {
      category: entry.category,
      name: entry.name,
      size: entry.bytes.byteLength,
      exists: existsSync(path),
    };
  });
}

export async function previewBackup(userData: string, passphrase: string, inputPath: string): Promise<BackupPreviewEntry[]> {
  const packet = await readFile(resolve(inputPath));
  return previewArchive(packet, passphrase, userData);
}

/** 恢复：解密 + 全量校验，写前把将被覆盖的原文件挪到安全副本目录，失败自动回滚。 */
export async function restoreBackup(userData: string, passphrase: string, inputPath: string): Promise<BackupResult> {
  try {
    const packet = await readFile(resolve(inputPath));
    const archive = await open(packet, passphrase);
    const paths = archive.entries.map((entry) => safeArchivePath(userData, entry.name));
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const safetyRoot = join(userData, `.codex-cli-ui-backup-${stamp}`);
    await mkdir(safetyRoot, { recursive: true });
    const written: Array<{ path: string; safetyPath?: string; existed: boolean }> = [];
    try {
      for (let index = 0; index < archive.entries.length; index += 1) {
        const entry = archive.entries[index];
        const path = paths[index];
        await mkdir(dirname(path), { recursive: true });
        // 防止通过符号链接把文件写到 data 目录之外。
        let current = userData;
        const parts = entry.name.split("/");
        for (let i = 0; i < parts.length - 1; i += 1) {
          current = join(current, parts[i]);
          if (!existsSync(current)) break;
          const stats = lstatSync(current);
          if (stats.isSymbolicLink() || !stats.isDirectory()) {
            throw new Error(`备份目标路径不安全：${entry.name}`);
          }
        }
        let safetyPath: string | undefined;
        const existed = existsSync(path);
        if (existed) {
          const targetStats = lstatSync(path);
          if (targetStats.isSymbolicLink() || targetStats.isDirectory()) {
            throw new Error(`备份目标不安全：${entry.name}`);
          }
          const partsForSafety = entry.name.split("/");
          safetyPath = join(safetyRoot, ...partsForSafety.slice(0, -1).filter(Boolean), partsForSafety[partsForSafety.length - 1]!);
          await mkdir(dirname(safetyPath), { recursive: true });
          await rename(path, safetyPath);
        }
        written.push({ path, safetyPath, existed });
        await atomicWrite(path, entry.bytes);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // 回滚：覆盖过的文件原样放回，新增的文件删除，尽量恢复原状。
      let rollbackFailed = false;
      for (let i = written.length - 1; i >= 0; i -= 1) {
        const item = written[i]!;
        try {
          if (item.existed && item.safetyPath) {
            try { await unlink(item.path); } catch { /* 文件可能尚未写入 */ }
            await rename(item.safetyPath, item.path);
          } else {
            try { await unlink(item.path); } catch { /* 文件可能尚未写入 */ }
          }
        } catch {
          rollbackFailed = true;
        }
      }
      try { await rmdir(safetyRoot); } catch { /* 回滚后非空则保留，便于人工处理 */ }
      const message = rollbackFailed ? `恢复失败，部分回滚未完成：${detail}` : `恢复失败，已回滚：${detail}`;
      return { ok: false, message, error: detail };
    }
    return { ok: true, message: `已从备份恢复；被覆盖的原文件保留在 ${safetyRoot}（部分设置重启后完全生效）`, path: safetyRoot };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message, error: message };
  }
}

/** 原子写：先写临时文件再 rename，避免中途崩溃留下半截文件。 */
async function atomicWrite(path: string, bytes: Uint8Array): Promise<void> {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, bytes);
  try {
    await rename(temp, path);
  } catch (error) {
    try { await readFile(temp); } catch { /* ignore */ }
    throw error;
  }
}

/** 归档结构校验：版本、分类唯一、条目名称唯一、分类白名单、路径安全、内容合规。 */
export function validateArchive(archive: BackupArchive): void {
  if (!isJsonObject(archive) || !isJsonObject(archive.manifest) || !Array.isArray(archive.entries)) {
    throw new Error("备份归档结构无效");
  }
  if (archive.manifest.version !== BACKUP_ARCHIVE_VERSION) {
    throw new Error("不支持该备份归档版本");
  }
  const categories = new Set<BackupCategory>(archive.manifest.categories);
  if (categories.size !== archive.manifest.categories.length) {
    throw new Error("备份分类重复");
  }
  for (const category of categories) {
    if (!CATEGORY_ORDER.includes(category)) throw new Error(`未知备份分类：${category}`);
  }
  const names = new Set<string>();
  for (const entry of archive.entries) {
    if (!isJsonObject(entry)) throw new Error("备份条目结构无效");
    if (!categories.has(entry.category as BackupCategory)) throw new Error(`条目不属于清单分类：${entry.category}`);
    if (typeof entry.name !== "string" || names.has(entry.name)) throw new Error("备份条目无效或重复");
    names.add(entry.name);
    safeArchivePath(".", entry.name);
    if (!ALLOWED_NAMES[entry.category as BackupCategory]?.(entry.name)) {
      throw new Error(`分类 ${entry.category} 不允许该条目：${entry.name}`);
    }
    const rawBytes = entry.bytes as unknown;
    let bytes: Buffer;
    if (rawBytes instanceof Uint8Array) {
      bytes = Buffer.from(rawBytes);
    } else if (rawBytes && typeof rawBytes === "object" && Array.isArray((rawBytes as { data?: unknown }).data)) {
      bytes = Buffer.from((rawBytes as { data: number[] }).data);
    } else if (Array.isArray(rawBytes)) {
      bytes = Buffer.from(rawBytes as number[]);
    } else {
      throw new Error("备份条目字节内容无效");
    }
    (entry.bytes as Uint8Array) = bytes;
    if (entry.category === "appearance") {
      const sanitized = Buffer.from(sanitizeSettingsBytes(bytes));
      if (!sanitized.equals(bytes)) throw new Error("设置文件包含不允许的敏感字段");
    }
    if (entry.category === "ssh") {
      const sanitized = Buffer.from(sanitizeSshBytes(bytes));
      if (!sanitized.equals(bytes)) throw new Error("SSH 配置文件包含私钥或代理字段");
    }
    if (entry.category === "config") {
      try { JSON.parse(bytes.toString("utf8")); } catch { throw new Error("CLI 配置文件不是有效 JSON"); }
    }
    if (entry.category === "directory_history") {
      try { JSON.parse(bytes.toString("utf8")); } catch { throw new Error("目录历史文件不是有效 JSON"); }
    }
  }
}
