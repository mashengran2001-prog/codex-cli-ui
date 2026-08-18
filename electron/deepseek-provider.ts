import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, join, normalize, resolve } from "node:path";
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

type DeepSeekSdkModule = typeof import("@deepseek-ai/dsh-sdk-client");
type DeepSeekHarnessInstance = InstanceType<DeepSeekSdkModule["DeepSeekHarness"]>;

interface DeepSeekProviderOptions {
  runtimeBin: string;
  runtimeConfig: string;
  electronExecutable: string;
  sessionRoot: string;
  getCredential(): Promise<string | null>;
  setCredential(value: string): Promise<void>;
}

interface DeepSeekActiveRun {
  stopped: boolean;
  harness?: DeepSeekHarnessInstance;
}

interface SessionFile {
  path: string;
  modifiedAt: number;
}

const PROVIDER_ID = "deepseek" as const;
const MAX_SESSION_BYTES = 30 * 1024 * 1024;
const MAX_SESSION_FILES = 250;
const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<DeepSeekSdkModule>;

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

function contentText(value: unknown, type?: string) {
  if (!Array.isArray(value)) return "";
  return value.map((block) => {
    if (!isRecord(block) || (type && block.type !== type)) return "";
    return stringValue(block.text);
  }).filter(Boolean).join("\n");
}

function pathEntries() {
  return (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":").filter(Boolean);
}

function findExecutable(names: string[]) {
  const explicit = process.env.DEEPSEEK_UI_CLI_PATH;
  if (explicit && existsSync(explicit)) return explicit;
  const roots = [...pathEntries()];
  if (process.platform === "win32" && process.env.APPDATA) roots.unshift(join(process.env.APPDATA, "npm"));
  for (const root of roots) {
    for (const name of names) {
      const candidate = join(root.replace(/^"|"$/g, ""), name);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // Continue through PATH entries that disappear or are inaccessible.
      }
    }
  }
  return null;
}

function findDshExecutable() {
  return findExecutable(process.platform === "win32" ? ["dsh.exe", "dsh.cmd", "dsh.bat"] : ["dsh"]);
}

function runCommand(executable: string, args: string[], timeout = 20_000) {
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

function providerCapabilities() {
  return {
    structuredChat: true,
    sessions: true,
    resume: true,
    models: true,
    reasoningEffort: false,
    sandboxMode: false,
    images: false,
    stop: true,
    webUi: true,
    terminal: true,
  };
}

export class DeepSeekProvider implements AgentProvider {
  readonly id = PROVIDER_ID;
  private readonly activeRuns = new Map<string, DeepSeekActiveRun>();
  private cachedInfo?: { at: number; value: AgentProviderInfo };

  constructor(private readonly options: DeepSeekProviderOptions) {}

  async refresh() {
    this.cachedInfo = undefined;
    return this.getInfo();
  }

  async getInfo(): Promise<AgentProviderInfo> {
    if (this.cachedInfo && Date.now() - this.cachedInfo.at < 5_000) return this.cachedInfo.value;
    const executable = findDshExecutable();
    const runtimeAvailable = existsSync(this.options.runtimeBin) && existsSync(this.options.runtimeConfig);
    const credential = process.env.DEEPSEEK_API_KEY || await this.options.getCredential();
    let version: string | undefined;
    let cliError: string | undefined;
    if (executable) {
      const probe = await runCommand(executable, ["--version"]);
      if (probe.code === 0) version = (probe.stdout || probe.stderr).trim().split(/\r?\n/)[0];
      else cliError = (probe.stderr || probe.stdout).trim() || "dsh --version failed";
    }
    const value: AgentProviderInfo = {
      id: this.id,
      name: "DeepSeek Harness",
      shortName: "DeepSeek",
      description: "Official Harness SDK runtime with persistent structured sessions",
      available: runtimeAvailable,
      configured: Boolean(credential),
      cliAvailable: Boolean(executable),
      version,
      executable: executable || undefined,
      error: runtimeAvailable ? cliError : "DeepSeek SDK runtime is not bundled",
      installCommand: "npm install -g @deepseek-ai/dsh@0.1.0-rc.7",
      defaultModel: "deepseek-v4-flash",
      models: [
        { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
        { id: "deepseek-v4", label: "DeepSeek V4" },
      ],
      capabilities: providerCapabilities(),
    };
    this.cachedInfo = { at: Date.now(), value };
    return value;
  }

  async setCredential(credential: string) {
    await this.options.setCredential(credential.trim());
    this.cachedInfo = undefined;
    return this.getInfo();
  }

  async install(): Promise<OperationResult> {
    const npm = findExecutable(process.platform === "win32" ? ["npm.cmd", "npm.exe"] : ["npm"]);
    if (!npm) return { ok: false, message: "未找到 npm，请先安装 Node.js 22 或更高版本" };
    const result = await runCommand(npm, ["install", "-g", "@deepseek-ai/dsh@0.1.0-rc.7"], 10 * 60_000);
    this.cachedInfo = undefined;
    return result.code === 0
      ? { ok: true, message: "DeepSeek Harness CLI 已安装" }
      : { ok: false, message: (result.stderr || result.stdout).trim().slice(-2_000) || "DeepSeek Harness 安装失败" };
  }

  async listSessions(cwd: string) {
    const expected = normalizePath(cwd);
    const sessions: SessionSummary[] = [];
    for (const file of await this.collectSessionFiles()) {
      const session = await this.parseSessionFile(file, false);
      if (session && normalizePath(session.cwd) === expected) sessions.push(session);
    }
    return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async getSession(id: string, cwd: string) {
    const expected = normalizePath(cwd);
    for (const file of await this.collectSessionFiles()) {
      const session = await this.parseSessionFile(file, true);
      if (session?.id === id && normalizePath(session.cwd) === expected) return session;
    }
    return null;
  }

  async startRun(request: RunRequest, context: ProviderRunContext) {
    if (this.activeRuns.has(request.runId)) throw new Error("运行 ID 已存在");
    const info = await this.getInfo();
    if (!info.available) throw new Error(info.error || "DeepSeek Harness SDK 不可用");
    const credential = process.env.DEEPSEEK_API_KEY || await this.options.getCredential();
    if (!credential) throw new Error("请先在 Provider 设置中保存 DeepSeek API Key");
    const active: DeepSeekActiveRun = { stopped: false };
    this.activeRuns.set(request.runId, active);
    void this.executeRun(request, active, credential, context);
    return { accepted: true as const };
  }

  async stopRun(runId: string) {
    const run = this.activeRuns.get(runId);
    if (!run) return false;
    run.stopped = true;
    await run.harness?.close().catch(() => undefined);
    return true;
  }

  async dispose() {
    const runs = [...this.activeRuns.values()];
    for (const run of runs) run.stopped = true;
    await Promise.allSettled(runs.map((run) => run.harness?.close()));
    this.activeRuns.clear();
  }

  private async executeRun(request: RunRequest, active: DeepSeekActiveRun, credential: string, context: ProviderRunContext) {
    const sessionId = request.threadId || randomUUID();
    let streamedText = false;
    try {
      await mkdir(this.options.sessionRoot, { recursive: true });
      const sdk = await dynamicImport("@deepseek-ai/dsh-sdk-client");
      const env = {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        DEEPSEEK_API_KEY: credential,
        DSH_CWD: request.cwd,
        DSH_SESSION_ROOT: this.options.sessionRoot,
        DSH_TELEMETRY_DISABLED: "1",
      };
      const harness = new sdk.DeepSeekHarness({
        launch: {
          command: this.options.electronExecutable,
          args: [this.options.runtimeBin, this.options.runtimeConfig],
          cwd: request.cwd,
          env,
        },
        cwd: request.cwd,
        provider: "deepseek-official",
        model: request.model || "deepseek-v4-flash",
      });
      active.harness = harness;
      context.emit({ providerId: this.id, runId: request.runId, type: "message", data: { type: "thread.started", thread_id: sessionId } });
      const result = await harness.run(request.prompt, {
        sessionId,
        onNotification: (notification: { method: string; params: Record<string, unknown> }) => {
          const mapped = this.mapNotification(request.runId, notification);
          for (const event of mapped) {
            if (event.data?.type === "agent_message.delta") streamedText = true;
            context.emit(event);
          }
        },
      });
      if (!streamedText && result.finalResponse) {
        context.emit({
          providerId: this.id,
          runId: request.runId,
          type: "message",
          data: { type: "item.completed", item: { id: `${sessionId}-assistant`, type: "agent_message", text: result.finalResponse } },
        });
      }
      context.emit({ providerId: this.id, runId: request.runId, type: "exit", code: 0, stopped: false });
      context.notify("DeepSeek 已完成", basename(request.cwd));
    } catch (error) {
      if (active.stopped) {
        context.emit({ providerId: this.id, runId: request.runId, type: "exit", code: null, stopped: true });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        context.emit({ providerId: this.id, runId: request.runId, type: "error", text: message });
        context.emit({ providerId: this.id, runId: request.runId, type: "exit", code: 1, stopped: false });
      }
    } finally {
      this.activeRuns.delete(request.runId);
      await active.harness?.close().catch(() => undefined);
    }
  }

  private mapNotification(runId: string, notification: { method: string; params: Record<string, unknown> }): RunEvent[] {
    if (notification.method !== "session.event") return [];
    const event = isRecord(notification.params.event) ? notification.params.event : null;
    const data = event && isRecord(event.data) ? event.data : null;
    const type = event ? stringValue(event.type) : "";
    if (!data || !type) return [];
    if (type === "assistant/chunk") {
      const chunk = isRecord(data.chunk) ? data.chunk : null;
      const chunkType = chunk ? stringValue(chunk.type) : "";
      const text = chunk ? stringValue(chunk.text) : "";
      if (chunkType === "text-delta" && text) return [{ providerId: this.id, runId, type: "message", data: { type: "agent_message.delta", delta: text } }];
      if (chunkType === "reasoning-delta" && text) return [{ providerId: this.id, runId, type: "message", data: { type: "reasoning.delta", delta: text } }];
      return [];
    }
    if (type === "assistant/message") {
      const message = isRecord(data.message) ? data.message : null;
      const text = message ? contentText(message.content, "text") : "";
      const reasoning = message ? contentText(message.content, "reasoning") : "";
      const events: RunEvent[] = [];
      if (reasoning) events.push({ providerId: this.id, runId, type: "message", data: { type: "item.completed", item: { id: `${runId}-reasoning`, type: "reasoning", text: reasoning } } });
      if (text) events.push({ providerId: this.id, runId, type: "message", data: { type: "item.completed", item: { id: `${runId}-assistant`, type: "agent_message", text } } });
      return events;
    }
    if (type === "session/title") {
      return [{ providerId: this.id, runId, type: "message", data: { type: "provider.session.title", title: stringValue(data.title) } }];
    }
    if (type === "tool/call" || type === "tool/result") {
      const call = isRecord(data.call) ? data.call : data;
      const id = stringValue(call.callId) || stringValue(call.id) || `${runId}-${stringValue(event?.seq)}`;
      const name = stringValue(call.name) || stringValue(call.tool) || "tool";
      const item = {
        id,
        type: "mcp_tool_call",
        server: "deepseek-harness",
        tool: name,
        arguments: call.arguments,
        result: data.result,
        status: type === "tool/result" ? "completed" : "in_progress",
      };
      return [{ providerId: this.id, runId, type: "message", data: { type: type === "tool/result" ? "item.completed" : "item.started", item } }];
    }
    return [];
  }

  private async collectSessionFiles() {
    if (!existsSync(this.options.sessionRoot)) return [];
    const files: SessionFile[] = [];
    const walk = async (directory: string): Promise<void> => {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
      await Promise.all(entries.map(async (entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          try {
            const details = await stat(path);
            if (details.size <= MAX_SESSION_BYTES) files.push({ path, modifiedAt: details.mtimeMs });
          } catch {
            // Ignore files that are being rotated by the persistence plugin.
          }
        }
      }));
    };
    await walk(this.options.sessionRoot);
    return files.sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, MAX_SESSION_FILES);
  }

  private async parseSessionFile(file: SessionFile, includeMessages: boolean): Promise<SessionSummary | null> {
    let raw: string;
    try { raw = await readFile(file.path, "utf8"); } catch { return null; }
    let id = "";
    let cwd = "";
    let title = "";
    let model = "";
    let createdAt = file.modifiedAt;
    let firstPrompt = "";
    const messages: ChatMessage[] = [];
    let activities: Activity[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let row: Record<string, unknown>;
      try { row = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      const type = stringValue(row.type);
      const data = isRecord(row.data) ? row.data : null;
      if (type === "session") {
        id = stringValue(row.id) || id;
        cwd = stringValue(row.cwd) || cwd;
        createdAt = typeof row.createdAt === "number" ? row.createdAt : createdAt;
      } else if (type === "session/title" && data) {
        title = stringValue(data.title) || title;
      } else if (type === "request/context" && data) {
        model = stringValue(data.model) || model;
      } else if (type === "user/message" && data) {
        const content = contentText(data.content);
        if (!content) continue;
        firstPrompt ||= content;
        if (includeMessages) messages.push({ id: randomUUID(), role: "user", content, createdAt: typeof row.time === "number" ? row.time : file.modifiedAt, status: "done" });
      } else if (type === "tool/call" && data && includeMessages) {
        const call = isRecord(data.call) ? data.call : data;
        activities.push({
          id: stringValue(call.callId) || stringValue(call.id) || randomUUID(),
          kind: "tool",
          name: stringValue(call.name) || stringValue(call.tool) || "Tool",
          summary: JSON.stringify(call.arguments ?? {}).slice(0, 180),
          status: "running",
        });
      } else if (type === "tool/result" && includeMessages) {
        activities = activities.map((activity) => ({ ...activity, status: "done" }));
      } else if (type === "assistant/message" && data && includeMessages) {
        const message = isRecord(data.message) ? data.message : null;
        const content = message ? contentText(message.content, "text") : "";
        const reasoning = message ? contentText(message.content, "reasoning") : "";
        if (content) messages.push({
          id: randomUUID(),
          role: "assistant",
          content,
          reasoning: reasoning || undefined,
          activities: activities.length ? activities.map((activity) => ({ ...activity, status: "done" })) : undefined,
          createdAt: typeof row.time === "number" ? row.time : file.modifiedAt,
          status: "done",
        });
        activities = [];
      }
    }
    if (!id || !cwd) return null;
    return {
      providerId: this.id,
      id,
      title: title || compactTitle(firstPrompt) || `会话 ${id.slice(0, 8)}`,
      cwd,
      createdAt,
      updatedAt: file.modifiedAt,
      model: model || undefined,
      cliVersion: "DeepSeek Harness SDK",
      messages: includeMessages ? messages.slice(-240) : undefined,
    };
  }
}
