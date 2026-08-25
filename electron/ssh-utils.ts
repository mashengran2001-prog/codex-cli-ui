/**
 * SSH 传输参数（对标 Nebula ssh_proxy.rs / ssh_session.rs）：
 * - 跳板机 ProxyJump（单跳，-J；上游暂不支持多级链，这里同样拒绝逗号链）
 * - 自定义代理命令 ProxyCommand（无跳板时生效，跳板优先）
 * - 保活 ServerAliveInterval / ServerAliveCountMax
 * - 首选认证方式 PreferredAuthentications
 * 全部映射为系统 OpenSSH 参数，应用内不重复实现隧道；ssh / sftp / 连接测试共用。
 */
import type { SshPreferredAuth, SshProfile } from "../src/types";

export const SSH_JUMP_MAX_LEN = 255;
export const SSH_PROXY_COMMAND_MAX_LEN = 500;
export const SSH_KEEPALIVE_INTERVAL_MAX = 86_400;
export const SSH_KEEPALIVE_COUNT_MAX = 1_000;
export const SSH_DEFAULT_KEEPALIVE_COUNT = 6;

const SSH_AUTH_MODES: SshPreferredAuth[] = ["auto", "publickey", "password", "keyboard-interactive"];

export function normalizeJumpHost(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("跳板机格式无效");
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > SSH_JUMP_MAX_LEN || /[\r\n\0]/.test(trimmed)) throw new Error("跳板机格式无效");
  // 单跳（对标上游“暂不支持多级跳板链”）：ProxyJump 的逗号会组成链。
  if (trimmed.includes(",")) throw new Error("暂不支持多级跳板链（ProxyJump）");
  if (trimmed.includes("@") && trimmed.split("@").length > 2) throw new Error("跳板机格式无效");
  const hostPart = trimmed.includes("@") ? trimmed.split("@").pop()! : trimmed;
  if (!hostPart || hostPart.length > SSH_JUMP_MAX_LEN || /[\s\r\n\0]/.test(hostPart)) throw new Error("跳板机格式无效");
  return trimmed;
}

export function normalizeProxyCommand(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("代理命令格式无效");
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > SSH_PROXY_COMMAND_MAX_LEN || /[\r\n\0]/.test(trimmed)) throw new Error("代理命令格式无效");
  return trimmed;
}

export function normalizeKeepAliveInterval(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const num = Number(value);
  if (!Number.isInteger(num) || num < 0 || num > SSH_KEEPALIVE_INTERVAL_MAX) throw new Error("保活间隔需要是 0–86400 之间的整数");
  return num;
}

export function normalizeKeepAliveMax(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const num = Number(value);
  if (!Number.isInteger(num) || num < 1 || num > SSH_KEEPALIVE_COUNT_MAX) throw new Error("保活最大失败次数需要是 1–1000 之间的整数");
  return num;
}

export function normalizePreferredAuth(value: unknown): SshPreferredAuth | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !SSH_AUTH_MODES.includes(value as SshPreferredAuth)) throw new Error("认证方式无效");
  return value as SshPreferredAuth;
}

export function identityFilesOf(profile: SshProfile): string[] {
  return profile.identityFiles?.length ? profile.identityFiles : profile.identityFile ? [profile.identityFile] : [];
}

/** 组装传输层参数（跳板 / 代理 / 保活 / 认证 / 私钥），ssh 与 sftp 共用。 */
export function sshTransportOptions(profile: SshProfile): string[] {
  const args: string[] = [];
  if (profile.jumpHost) {
    args.push("-J", profile.jumpHost);
  } else if (profile.proxyCommand) {
    args.push("-o", `ProxyCommand=${profile.proxyCommand}`);
  }
  if (typeof profile.keepAliveInterval === "number" && profile.keepAliveInterval > 0) {
    args.push("-o", `ServerAliveInterval=${Math.round(profile.keepAliveInterval)}`);
    args.push("-o", `ServerAliveCountMax=${Math.max(1, Math.round(profile.keepAliveMax ?? SSH_DEFAULT_KEEPALIVE_COUNT))}`);
  } else if (profile.keepAliveInterval === 0) {
    args.push("-o", "ServerAliveInterval=0");
  }
  if (profile.preferredAuth && profile.preferredAuth !== "auto") {
    args.push("-o", `PreferredAuthentications=${profile.preferredAuth}`);
  }
  for (const identity of identityFilesOf(profile)) args.push("-i", identity);
  return args;
}

/** 形如 user@host 的目标串（端口单独由 -p/-P 提供）。 */
export function sshProfileTarget(profile: SshProfile): string {
  return `${profile.username ? `${profile.username}@` : ""}${profile.host}`;
}
