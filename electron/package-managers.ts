import { execFile } from "node:child_process";

/**
 * Nebula #47 对照剩余项：scoop / winget 分发接入。
 * - 纯函数部分（版本输出解析、已安装列表匹配、升级命令构造）可单测；
 * - probePackageManager 在主进程做真实探测（超时保护），结果由 updates:package-manager IPC 暴露，
 *   渲染进程据此在更新提醒中给出"通过 winget/scoop 升级"入口，未安装包管理器时回退到应用内下载。
 */

/** winget 包标识（提交到 winget-pkgs 后生效，与 packaging/winget 清单保持一致）。 */
export const WINGET_PACKAGE_ID = "CodexCLIUI.CodexCLIUI";
/** scoop 应用名（提交到 bucket 后生效，与 packaging/scoop 清单保持一致）。 */
export const SCOOP_APP_NAME = "codex-cli-ui";

export interface PackageManagerInfo {
  source: "winget" | "scoop" | null;
  /** 对应包管理器的升级命令（用于控制台启动）。 */
  command: string | null;
  /** 简短来源名，用于文案。 */
  label: string | null;
}

export interface PackageManagerRunResult {
  ok: boolean;
  source?: "winget" | "scoop";
  command?: string;
  error?: string;
}

/** winget --version 首行形如 v1.9.4411 或 1.9.4411。 */
export function parseWingetVersionOutput(output: string | null | undefined): boolean {
  if (!output) return false;
  const first = output.split(/\r?\n/, 1)[0].trim();
  return /^v?\d+\.\d+/i.test(first);
}

/** winget list 输出中按包标识或产品名匹配。 */
export function wingetListContains(output: string | null | undefined, packageId: string = WINGET_PACKAGE_ID): boolean {
  if (!output) return false;
  const lower = output.toLowerCase();
  return lower.includes(packageId.toLowerCase()) || lower.includes("codex cli ui");
}

/** scoop --version 形如 "Scoop version v0.5.2"。 */
export function parseScoopVersionOutput(output: string | null | undefined): boolean {
  if (!output) return false;
  const first = output.split(/\r?\n/, 1)[0].trim();
  return /^scoop version v?\d+\.\d+/i.test(first) || /^v?\d+\.\d+/i.test(first);
}

/** scoop list 输出每行以应用名开头时判为已安装。 */
export function scoopListContains(output: string | null | undefined, appName: string = SCOOP_APP_NAME): boolean {
  if (!output) return false;
  const name = appName.toLowerCase();
  return output.toLowerCase().split(/\r?\n/).some((line) => line.trim().startsWith(name));
}

/** winget 静默升级命令（带源协议确认，避免交互卡住）。 */
export function buildWingetUpdateCommand(packageId: string = WINGET_PACKAGE_ID): string {
  return `winget upgrade --id "${packageId}" --silent --accept-package-agreements --accept-source-agreements`;
}

/** scoop 升级命令。 */
export function buildScoopUpdateCommand(appName: string = SCOOP_APP_NAME): string {
  return `scoop update ${appName}`;
}

/** 由探测结果纯函数地推导分发来源与命令（单测入口）。 */
export function detectPackageManager(options: {
  hasWinget: boolean;
  wingetListOutput?: string | null;
  hasScoop: boolean;
  scoopListOutput?: string | null;
}): PackageManagerInfo {
  if (options.hasWinget && wingetListContains(options.wingetListOutput)) {
    return { source: "winget", command: buildWingetUpdateCommand(), label: "winget" };
  }
  if (options.hasScoop && scoopListContains(options.scoopListOutput)) {
    return { source: "scoop", command: buildScoopUpdateCommand(), label: "scoop" };
  }
  return { source: null, command: null, label: null };
}

/** 通过 cmd.exe 执行并捕获输出；超时或失败返回空串（探测是尽力而为，不向用户报错）。 */
function cmdOutput(command: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      "cmd.exe",
      ["/d", "/s", "/c", command],
      { windowsHide: true, timeout: timeoutMs, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve(error ? "" : `${stdout}\n${stderr}`.trim());
      },
    );
  });
}

/** 真实探测：winget/scoop 是否可用且是否以该方式安装了本应用。 */
export async function probePackageManager(env: NodeJS.ProcessEnv = process.env): Promise<PackageManagerInfo> {
  if (env.CODEX_UI_PACKAGE_MANAGER_DISABLE === "1") {
    return { source: null, command: null, label: null };
  }
  const wingetVersion = await cmdOutput("winget --version", 4000);
  const hasWinget = parseWingetVersionOutput(wingetVersion);
  const wingetListOutput = hasWinget
    ? await cmdOutput(`winget list --id ${WINGET_PACKAGE_ID} --accept-source-agreements`, 8000)
    : "";
  const scoopVersion = await cmdOutput("scoop --version", 4000);
  const hasScoop = parseScoopVersionOutput(scoopVersion);
  const scoopListOutput = hasScoop ? await cmdOutput(`scoop list ${SCOOP_APP_NAME}`, 8000) : "";
  return detectPackageManager({ hasWinget, wingetListOutput, hasScoop, scoopListOutput });
}
