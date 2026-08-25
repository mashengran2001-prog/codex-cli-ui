import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, statSync, type Dirent } from "node:fs";
import { readFileSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { basename, join, normalize, resolve } from "node:path";
import type {
  Activity,
  AgentProviderInfo,
  ChatMessage,
  OperationResult,
  RunEvent,
  RunRequest,
  SessionSummary,
} from "../src/types";
import type { AgentProvider, ProviderRunContext } from "./provider-registry";

interface ClaudeProviderOptions {
  getCredential(): Promise<string | null>;
  setCredential(value: string): Promise<void>;
}

interface ClaudeActiveRun {
  child: ReturnType<typeof spawn>;
  stopped: boolean;
}

interface ClaudeSessionFile {
  path: string;
  modifiedAt: number;
}

const PROVIDER_ID = "claude" as const;
const MAX_SESSION_BYTES = 30 * 1024 * 1024;
const MAX_SESSION_FILES = 250;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function compactTitle(value: string) {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 54 ? `${compact.slice(0, 53)}…` : compact;
}

function normalizePath(value: string) {
  const path = normalize(resolve(value));
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function claudeHome() {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

function claudeSessionRoot() {
  return join(claudeHome(), "projects");
}
function claudeSettingsEnv() {
  try {
    const settings = JSON.parse(readFileSync(join(claudeHome(), "settings.json"), "utf8")) as Record<string, unknown>;
    const env = isRecord(settings.env) ? settings.env : null;
    if (!env) return {};
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) if (typeof value === "string") result[key] = value;
    return result;
  } catch {
    return {};
  }
}


function hasClaudeCredential() {
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY_FILE) return true;
  return existsSync(join(claudeHome(), ".credentials.json"));
}

function pathEntries() {
  return (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":").filter(Boolean);
}

function findClaudeExecutable() {
  const explicit = process.env.CLAUDE_UI_CLI_PATH;
  if (explicit && existsSync(explicit)) return explicit;
  const names = process.platform === "win32" ? ["claude.cmd", "claude.exe", "claude"] : ["claude"];
  const roots = [...pathEntries()];
  if (process.platform === "win32" && process.env.APPDATA) roots.unshift(join(process.env.APPDATA, "npm"));
  for (const rawRoot of roots) {
    const root = rawRoot.replace(/^"|"$/g, "");
    if (!root) continue;
    for (const name of names) {
      const candidate = join(root, name);
      try {
        if (statSync(candidate).isFile()) {
          if (process.platform === "win32" && name === "claude.cmd") {
            const native = join(root, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
            if (existsSync(native)) return native;
          }
          return candidate;
        }
      } catch {
        // PATH entries may be missing or inaccessible.
      }
    }
  }
  return process.platform === "win32" ? "claude.cmd" : "claude";
}

function spawnClaudeProcess(executable: string, args: string[], options: Parameters<typeof spawn>[2]) {
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(executable)) {
    const commandLine = `"${executable}" ${args.map((arg) => `"${arg.replaceAll('"', '\\"')}"`).join(" ")}`;
    return spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", commandLine], options);
  }
  return spawn(executable, args, options);
}

function stopProcessTree(child: ReturnType<typeof spawn>) {
  if (child.killed || child.pid === undefined) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    killer.unref();
  } else {
    child.kill("SIGTERM");
  }
}

function runClaudeVersion(executable: string) {
  return new Promise<{ code: number | null; output: string; errorOutput: string }>((resolveRun) => {
    const child = spawnClaudeProcess(executable, ["--version"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let errorOutput = "";
    child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { errorOutput += chunk.toString("utf8"); });
    child.on("error", (error) => resolveRun({ code: 1, output: "", errorOutput: error.message }));
    child.on("close", (code) => resolveRun({ code, output: output.trim(), errorOutput: errorOutput.trim() }));
  });
}

function claudeCapabilities() {
  return {
    structuredChat: true,
    sessions: true,
    resume: true,
    models: true,
    reasoningEffort: false,
    sandboxMode: false,
    images: false,
    stop: true,
    webUi: false,
    terminal: true,
  };
}

async function getClaudeInfo(): Promise<AgentProviderInfo> {
  const executable = findClaudeExecutable();
  const result = await runClaudeVersion(executable);
  const available = result.code === 0;
  const settingsEnv = claudeSettingsEnv();
  const managedAuth = Boolean(settingsEnv.ANTHROPIC_BASE_URL || settingsEnv.ANTHROPIC_AUTH_TOKEN);
  const configured = available && (hasClaudeCredential() || managedAuth);
  const modelOverrides: Array<[string, string, string]> = [
    ["ANTHROPIC_DEFAULT_OPUS_MODEL", "Claude Opus", "opus"],
    ["ANTHROPIC_DEFAULT_SONNET_MODEL", "Claude Sonnet", "sonnet"],
    ["ANTHROPIC_DEFAULT_HAIKU_MODEL", "Claude Haiku", "haiku"],
  ];
  return {
    id: PROVIDER_ID,
    name: "Anthropic Claude Code",
    shortName: "Claude",
    description: "Claude Code CLI with stream-json events and resumable sessions",
    available,
    configured,
    cliAvailable: available,
    version: available ? result.output : undefined,
    executable,
    error: available ? undefined : result.errorOutput || `Claude 退出码 ${result.code}`,
    installCommand: "npm install -g @anthropic-ai/claude-code",
    defaultModel: "",
    models: modelOverrides.map(([key, label, alias]) => ({
      id: settingsEnv[key] || alias,
      label,
    })),
    capabilities: claudeCapabilities(),
  };
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((block) => {
    if (!isRecord(block)) return "";
    if (block.type === "text") return stringValue(block.text);
    if (block.type === "thinking" && block.thinking) return stringValue(block.thinking);
    return "";
  }).filter(Boolean).join("\n");
}

function toolBlocks(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).filter((block) => block.type === "tool_use" || block.type === "tool_result");
}

function recordTimestamp(value: unknown) {
  const timestamp = stringValue(value);
  if (!timestamp) return 0;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

function contentForMessages(value: unknown) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((block) => {
    if (!isRecord(block)) return "";
    if (block.type === "text") return stringValue(block.text);
    return "";
  }).filter(Boolean).join("\n");
}

function claudeProjectKey(cwd: string) {
  return cwd.replace(/[\\/: ]/g, "-");
}

function localSessionFileExists(cwd: string, sessionId: string) {
  return existsSync(join(claudeSessionRoot(), claudeProjectKey(cwd), `${sessionId}.jsonl`));
}

function desktopSessionRoots() {
  const roots: string[] = [];
  if (process.env.CLAUDE_UI_DESKTOP_ROOT) roots.push(process.env.CLAUDE_UI_DESKTOP_ROOT);
  const local = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  roots.push(join(local, "Claude-3p", "claude-code-sessions"));
  const packages = join(local, "Packages");
  let entries: Dirent[] = [];
  try { entries = readdirSync(packages, { withFileTypes: true }); } catch { /* Packages may be inaccessible. */ }
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.toLowerCase().startsWith("claude")) {
      roots.push(join(packages, entry.name, "LocalCache", "Roaming", "Claude", "claude-code-sessions"));
    }
  }
  return roots;
}

async function collectDesktopSessions(): Promise<SessionSummary[]> {
  const results: SessionSummary[] = [];
  const seen = new Set<string>();
  for (const root of desktopSessionRoots()) {
    if (!existsSync(root)) continue;
    const walk = async (directory: string): Promise<void> => {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
      await Promise.all(entries.map(async (entry) => {
        const fullPath = join(directory, entry.name);
        if (entry.isDirectory()) await walk(fullPath);
        else if (entry.isFile() && /^local_[0-9a-f-]+\.json$/i.test(entry.name)) {
          try {
            const meta = JSON.parse(await readFile(fullPath, "utf8")) as Record<string, unknown>;
            const id = stringValue(meta.cliSessionId) || stringValue(meta.sessionId);
            const cwd = stringValue(meta.cwd);
            if (!id || !cwd || meta.isArchived === true || seen.has(id)) return;
            seen.add(id);
            const createdAt = typeof meta.createdAt === "number" ? meta.createdAt : 0;
            const updatedAt = typeof meta.lastActivityAt === "number" ? meta.lastActivityAt
              : typeof meta.lastFocusedAt === "number" ? meta.lastFocusedAt
              : createdAt;
            results.push({
              providerId: PROVIDER_ID,
              id,
              title: stringValue(meta.title) || "Claude 桌面版会话",
              cwd,
              createdAt,
              updatedAt,
              model: stringValue(meta.model) || undefined,
              cliVersion: "Claude 桌面版",
              source: "desktop",
            });
          } catch {
            // Ignore metadata files that are mid-write or malformed.
          }
        }
      }));
    };
    await walk(root);
  }
  return results.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_SESSION_FILES);
}

async function collectClaudeSessionFiles(): Promise<ClaudeSessionFile[]> {
  const root = claudeSessionRoot();
  if (!existsSync(root)) return [];
  const files: ClaudeSessionFile[] = [];
  const walk = async (directory: string): Promise<void> => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    await Promise.all(entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl") && !/summary/i.test(entry.name)) {
        try {
          const details = await stat(path);
          if (details.size <= MAX_SESSION_BYTES) files.push({ path, modifiedAt: details.mtimeMs });
        } catch {
          // Ignore files being written or rotated by Claude Code.
        }
      }
    }));
  };
  await walk(root);
  return files.sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, MAX_SESSION_FILES);
}

async function parseClaudeSessionFile(file: ClaudeSessionFile, includeMessages: boolean): Promise<SessionSummary | null> {
  let raw: string;
  try { raw = await readFile(file.path, "utf8"); } catch { return null; }
  let id = "";
  let cwd = "";
  let title = "";
  let model = "";
  let firstPrompt = "";
  let createdAt = file.modifiedAt;
  let updatedAt = file.modifiedAt;
  const messages: ChatMessage[] = [];
  const pendingActivities: Activity[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try { row = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const type = stringValue(row.type);
    const recordId = stringValue(row.sessionId) || stringValue(row.session_id);
    if (recordId) id ||= recordId;
    if (stringValue(row.cwd)) cwd ||= stringValue(row.cwd);
    const rowTime = recordTimestamp(row.timestamp);
    if (rowTime) {
      if (!createdAt || createdAt === file.modifiedAt) createdAt = rowTime;
      updatedAt = Math.max(updatedAt, rowTime);
    }
    if (type === "summary") {
      title = stringValue(row.summary) || title;
    } else if (type === "custom-title") {
      if (row.customTitle) title = compactTitle(stringValue(row.customTitle)) || title;
    } else if (type === "ai-title") {
      if (!title && row.aiTitle) title = compactTitle(stringValue(row.aiTitle));
    } else if (type === "last-prompt") {
      if (!title && row.lastPrompt) title = compactTitle(stringValue(row.lastPrompt));
    } else if (type === "user" && row.message) {
      const message = isRecord(row.message) ? row.message : null;
      if (!message) continue;
      const content = contentForMessages(message.content);
      if (content) {
        firstPrompt ||= content;
        if (includeMessages) messages.push({ id: randomUUID(), role: "user", content, createdAt: rowTime || updatedAt, status: "done" });
      }
      if (includeMessages && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (isRecord(block) && block.type === "tool_result" && block.tool_use_id) {
            const activityIndex = pendingActivities.findIndex((activity) => activity.id === stringValue(block.tool_use_id));
            if (activityIndex >= 0) {
              pendingActivities[activityIndex] = { ...pendingActivities[activityIndex], status: "done" };
            }
          }
        }
      }
    } else if (type === "assistant" && row.message) {
      const message = isRecord(row.message) ? row.message : null;
      if (!message) continue;
      if (stringValue(message.model) && stringValue(message.model) !== "<synthetic>") model ||= stringValue(message.model);
      const content = contentForMessages(message.content);
      if (includeMessages) {
        const activities = pendingActivities.length ? pendingActivities.map((activity) => ({ ...activity, status: "done" as const })) : undefined;
        if (content) messages.push({ id: randomUUID(), role: "assistant", content, activities, createdAt: rowTime || updatedAt, status: "done" });
        else if (activities) messages.push({ id: randomUUID(), role: "assistant", content: "", activities, createdAt: rowTime || updatedAt, status: "done" });
        if (Array.isArray(message.content)) {
          for (const block of message.content) {
            if (isRecord(block) && block.type === "tool_use" && block.id) {
              pendingActivities.push({
                id: stringValue(block.id),
                kind: "tool",
                name: stringValue(block.name) || "Tool",
                summary: JSON.stringify(block.input ?? {}).slice(0, 180),
                status: "running",
              });
            }
          }
        }
      }
    }
  }
  if (!id || !cwd) return null;
  return {
    providerId: PROVIDER_ID,
    id,
    title: title || compactTitle(firstPrompt) || `会话 ${id.slice(0, 8)}`,
    cwd,
    createdAt,
    updatedAt,
    model: model || undefined,
    cliVersion: "Claude Code",
    messages: includeMessages ? messages.slice(-240) : undefined,
  };
}

async function listSessionsForWorkspace(cwd: string) {
  const files = await collectClaudeSessionFiles();
  const expected = normalizePath(cwd);
  const results: SessionSummary[] = [];
  const cliIds = new Set<string>();
  for (const file of files) {
    const summary = await parseClaudeSessionFile(file, false);
    if (summary && normalizePath(summary.cwd) === expected) {
      results.push(summary);
      cliIds.add(summary.id);
    }
  }
  for (const desktop of await collectDesktopSessions()) {
    if (normalizePath(desktop.cwd) === expected && !cliIds.has(desktop.id)) results.push(desktop);
  }
  return results.sort((a, b) => b.updatedAt - a.updatedAt);
}

async function getSession(id: string, cwd: string) {
  const files = await collectClaudeSessionFiles();
  const expected = normalizePath(cwd);
  for (const file of files) {
    const summary = await parseClaudeSessionFile(file, true);
    if (summary?.id === id && normalizePath(summary.cwd) === expected) return summary;
  }
  const desktops = await collectDesktopSessions();
  return desktops.find((item) => item.id === id && normalizePath(item.cwd) === expected) ?? null;
}

function permissionModeFor(sandboxMode: RunRequest["sandboxMode"]) {
  if (sandboxMode === "danger-full-access") return "bypassPermissions";
  if (sandboxMode === "read-only") return "plan";
  return "acceptEdits";
}

function runCommand(executable: string, args: string[], timeout = 60_000) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveRun) => {
    const isScript = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(executable);
    const command = isScript ? (process.env.ComSpec || "cmd.exe") : executable;
    const commandArgs = isScript ? ["/d", "/s", "/c", `"${executable}" ${args.map((arg) => `"${arg.replaceAll('"', '\\"')}"`).join(" ")}`] : args;
    execFile(command, commandArgs, { windowsHide: true, timeout }, (error, stdout, stderr) => {
      const code = typeof (error as NodeJS.ErrnoException & { code?: unknown } | null)?.code === "number"
        ? (error as unknown as { code: number }).code
        : error ? 1 : 0;
      resolveRun({ code, stdout, stderr });
    });
  });
}

export class ClaudeProvider implements AgentProvider {
  readonly id = PROVIDER_ID;
  private readonly activeRuns = new Map<string, ClaudeActiveRun>();

  constructor(private readonly options: ClaudeProviderOptions) {}

  getInfo(): Promise<AgentProviderInfo> {
    return getClaudeInfo();
  }

  listSessions(cwd: string) {
    return listSessionsForWorkspace(cwd);
  }

  getSession(id: string, cwd: string) {
    return getSession(id, cwd);
  }

  async startRun(value: RunRequest, context: ProviderRunContext): Promise<{ accepted: true }> {
    if (this.activeRuns.has(value.runId)) throw new Error("运行 ID 已存在");
    const executable = findClaudeExecutable();
    const resumable = value.threadId ? localSessionFileExists(value.cwd, value.threadId) : false;
    const args: string[] = ["-p"];
    if (value.threadId && resumable) args.push("--resume", value.threadId);
    if (value.model) args.push("--model", value.model);
    args.push("--permission-mode", permissionModeFor(value.sandboxMode));
    args.push("--output-format", "stream-json", "--verbose");
    args.push(value.prompt);

    const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", CLAUDE_CODE_MAX_RETRIES: "0" };
    const settingsEnv = claudeSettingsEnv();
    if (settingsEnv.ANTHROPIC_BASE_URL || settingsEnv.ANTHROPIC_AUTH_TOKEN) {
      // cc-switch / settings.json 管理认证与本地代理：显式走配置里的端点，避免全局 API Key 抢占。
      delete env.ANTHROPIC_API_KEY;
      if (settingsEnv.ANTHROPIC_BASE_URL) env.ANTHROPIC_BASE_URL = settingsEnv.ANTHROPIC_BASE_URL;
      if (settingsEnv.ANTHROPIC_AUTH_TOKEN) env.ANTHROPIC_AUTH_TOKEN = settingsEnv.ANTHROPIC_AUTH_TOKEN;
    } else {
      const storedCredential = await this.options.getCredential();
      if (storedCredential && !env.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = storedCredential;
    }

    const child = spawnClaudeProcess(executable, args, {
      cwd: value.cwd,
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const run: ClaudeActiveRun = { child, stopped: false };
    this.activeRuns.set(value.runId, run);

    const output = createInterface({ input: child.stdout! });
    let sessionId = "";
    output.on("line", (line) => {
      if (!line.trim()) return;
      let event: Record<string, unknown>;
      try { event = JSON.parse(line) as Record<string, unknown>; } catch {
        context.emit({ providerId: PROVIDER_ID, runId: value.runId, type: "stderr", text: line });
        return;
      }
      const type = stringValue(event.type);
      if (type === "system") {
        const nextSessionId = stringValue(event.session_id);
        if (!sessionId && nextSessionId) {
          sessionId = nextSessionId;
          if (!resumable) {
            context.emit({ providerId: PROVIDER_ID, runId: value.runId, type: "message", data: { type: "thread.started", thread_id: sessionId } });
          }
        }
        return;
      }
      if (type === "assistant") {
        const message = isRecord(event.message) ? event.message : null;
        if (!message || !Array.isArray(message.content)) return;
        for (const block of message.content) {
          if (!isRecord(block)) continue;
          if (block.type === "text" && stringValue(block.text)) {
            context.emit({ providerId: PROVIDER_ID, runId: value.runId, type: "message", data: { type: "item.started", item: { type: "agent_message", text: stringValue(block.text) } } });
            context.emit({ providerId: PROVIDER_ID, runId: value.runId, type: "message", data: { type: "item.completed", item: { type: "agent_message", text: stringValue(block.text) } } });
          } else if (block.type === "thinking" && stringValue(block.thinking)) {
            context.emit({ providerId: PROVIDER_ID, runId: value.runId, type: "message", data: { type: "item.started", item: { type: "reasoning", text: stringValue(block.thinking) } } });
            context.emit({ providerId: PROVIDER_ID, runId: value.runId, type: "message", data: { type: "item.completed", item: { type: "reasoning", text: stringValue(block.thinking) } } });
          } else if (block.type === "tool_use" && stringValue(block.id)) {
            const toolId = stringValue(block.id);
            const toolName = stringValue(block.name) || "tool";
            context.emit({ providerId: PROVIDER_ID, runId: value.runId, type: "message", data: { type: "item.started", item: { id: toolId, type: "mcp_tool_call", server: "claude-code", tool: toolName, arguments: block.input, status: "in_progress" } } });
          }
        }
        return;
      }
      if (type === "user") {
        const message = isRecord(event.message) ? event.message : null;
        if (!message || !Array.isArray(message.content)) return;
        for (const block of message.content) {
          if (isRecord(block) && block.type === "tool_result" && stringValue(block.tool_use_id)) {
            context.emit({ providerId: PROVIDER_ID, runId: value.runId, type: "message", data: { type: "item.completed", item: { id: stringValue(block.tool_use_id), type: "mcp_tool_call", server: "claude-code", result: contentForMessages([block]), status: "completed" } } });
          }
        }
        return;
      }
      if (type === "result" && event.is_error === true) {
        const message = stringValue(event.result) || stringValue(event.error) || "Claude 运行失败";
        context.emit({ providerId: PROVIDER_ID, runId: value.runId, type: "error", text: message });
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => context.emit({ providerId: PROVIDER_ID, runId: value.runId, type: "stderr", text: chunk.toString("utf8") }));
    child.on("error", (error) => context.emit({ providerId: PROVIDER_ID, runId: value.runId, type: "error", text: error.message }));
    child.on("close", (code) => {
      this.activeRuns.delete(value.runId);
      context.emit({ providerId: PROVIDER_ID, runId: value.runId, type: "exit", code, stopped: run.stopped });
      if (code === 0 && !run.stopped) context.notify("Claude 已完成", basename(value.cwd));
    });
    child.stdin?.end();
    return { accepted: true as const };
  }

  stopRun(runId: string) {
    const run = this.activeRuns.get(runId);
    if (!run) return false;
    run.stopped = true;
    stopProcessTree(run.child);
    return true;
  }

  async install(): Promise<OperationResult> {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const result = await runCommand(npm, ["install", "-g", "@anthropic-ai/claude-code"]);
    return { ok: result.code === 0, message: result.code === 0 ? "Claude Code 已安装" : result.stderr.trim() || result.stdout.trim() || "安装失败" };
  }

  async setCredential(credential: string): Promise<AgentProviderInfo> {
    await this.options.setCredential(credential);
    return this.getInfo();
  }

  dispose() {
    for (const run of this.activeRuns.values()) {
      run.stopped = true;
      stopProcessTree(run.child);
    }
  }
}
