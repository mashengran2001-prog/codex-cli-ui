import { createHash } from "node:crypto";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getStaticTOMLValue, parseTOML, type AST } from "toml-eslint-parser";
import type { CliLifecycleIntegrationStatus, CliLifecycleStatus } from "../src/types";

export const CLI_LIFECYCLE_MARKER = "codex-cli-ui-hook-v1";
const CONFIG_VERSION = 1;
const CLAUDE_EVENTS = ["UserPromptSubmit", "Stop", "Notification"] as const;
const MAX_PIPE_MESSAGE = 128 * 1024;

interface ConfigEdit {
  changed: boolean;
  content: string;
}

interface HookRecord {
  type: "command";
  command: string;
  timeout: number;
}

interface HookGroup {
  matcher: string;
  hooks: HookRecord[];
}

interface BridgeState {
  version: 1;
  enabled: boolean;
}

interface BridgeWireMessage {
  version?: unknown;
  source?: unknown;
  sessionId?: unknown;
  payload?: unknown;
  timestamp?: unknown;
}

export interface CliLifecycleEvent {
  source: "codex" | "claude";
  sessionId?: string;
  aiSessionId?: string;
  kind: "started" | "done" | "attention";
  message?: string;
  timestamp: number;
}

export interface CliLifecycleBridgeOptions {
  userDataDir: string;
  helperTemplatePath: string;
  codexHome?: string;
  claudeHome?: string;
  onEvent(event: CliLifecycleEvent): void;
}

function keyName(key: AST.TOMLKey) {
  if (key.keys.length !== 1) return "";
  const value = key.keys[0];
  return value.type === "TOMLBare" ? value.name : value.value;
}

function topLevelNotify(source: string) {
  const ast = parseTOML(source);
  const top = ast.body[0];
  const node = top.body.find((item): item is AST.TOMLKeyValue => item.type === "TOMLKeyValue" && keyName(item.key) === "notify");
  if (!node) return { ast, node: undefined, value: undefined };
  const value = getStaticTOMLValue(node.value);
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error("Codex notify must be an array of strings");
  }
  return { ast, node, value: value as string[] };
}

function serializeTomlStringArray(value: string[]) {
  return JSON.stringify(value);
}

function chainFromCommand(command: string[]) {
  const index = command.indexOf("-ChainB64");
  if (index < 0 || typeof command[index + 1] !== "string") return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(command[index + 1], "base64").toString("utf8")) as unknown;
    return Array.isArray(parsed) && parsed.length > 0 && parsed.every((item) => typeof item === "string") ? parsed as string[] : undefined;
  } catch {
    return undefined;
  }
}

function isOwnCommand(command: string[] | undefined) {
  return Boolean(command?.includes(CLI_LIFECYCLE_MARKER));
}

export function codexNotifyCommand(helperPath: string, chain?: string[]) {
  const command = [
    "powershell.exe",
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    helperPath,
    "-Source",
    "codex",
    "-Marker",
    CLI_LIFECYCLE_MARKER,
  ];
  if (chain?.length) command.push("-ChainB64", Buffer.from(JSON.stringify(chain), "utf8").toString("base64"));
  return command;
}

function replaceNodeValue(source: string, node: AST.TOMLKeyValue, value: string) {
  return `${source.slice(0, node.value.range[0])}${value}${source.slice(node.value.range[1])}`;
}

function removeNodeLine(source: string, node: AST.TOMLKeyValue) {
  const lineStart = source.lastIndexOf("\n", Math.max(0, node.range[0] - 1)) + 1;
  const nextLine = source.indexOf("\n", node.range[1]);
  const lineEnd = nextLine < 0 ? source.length : nextLine + 1;
  return `${source.slice(0, lineStart)}${source.slice(lineEnd)}`;
}

function insertTopLevelNotify(source: string, ast: AST.TOMLProgram, value: string) {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const firstTable = ast.body[0].body.find((item) => item.type === "TOMLTable");
  const position = firstTable?.range[0] ?? source.length;
  const prefix = position > 0 && source[position - 1] !== "\n" ? newline : "";
  return `${source.slice(0, position)}${prefix}notify = ${value}${newline}${source.slice(position)}`;
}

export function installCodexNotify(source: string, helperPath: string): ConfigEdit {
  const { ast, node, value } = topLevelNotify(source);
  const chain = isOwnCommand(value) ? chainFromCommand(value!) : value;
  const command = codexNotifyCommand(helperPath, chain);
  const serialized = serializeTomlStringArray(command);
  if (node) {
    if (serializeTomlStringArray(value!) === serialized) return { changed: false, content: source };
    return { changed: true, content: replaceNodeValue(source, node, serialized) };
  }
  return { changed: true, content: insertTopLevelNotify(source, ast, serialized) };
}

export function uninstallCodexNotify(source: string): ConfigEdit {
  const { node, value } = topLevelNotify(source);
  if (!node || !isOwnCommand(value)) return { changed: false, content: source };
  const chain = chainFromCommand(value!);
  return chain?.length
    ? { changed: true, content: replaceNodeValue(source, node, serializeTomlStringArray(chain)) }
    : { changed: true, content: removeNodeLine(source, node) };
}

export function hasCodexNotify(source: string) {
  return isOwnCommand(topLevelNotify(source).value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneJsonRecord(value: unknown) {
  if (!isRecord(value)) throw new Error("Claude settings must contain a JSON object");
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function hookCommand(helperPath: string) {
  const safePath = helperPath.replaceAll('"', '""');
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${safePath}" -Source claude -Marker ${CLI_LIFECYCLE_MARKER}`;
}

function hookContainsMarker(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.hooks)) return false;
  return value.hooks.some((hook) => isRecord(hook) && typeof hook.command === "string" && hook.command.includes(CLI_LIFECYCLE_MARKER));
}

function cleanOwnHooks(groups: unknown, event: string) {
  if (groups === undefined) return [] as unknown[];
  if (!Array.isArray(groups)) throw new Error(`Claude hooks.${event} must be an array`);
  const result: unknown[] = [];
  for (const group of groups) {
    if (!isRecord(group) || !Array.isArray(group.hooks)) throw new Error(`Claude hooks.${event} contains an invalid hook group`);
    const hooks = group.hooks.filter((hook) => !(isRecord(hook) && typeof hook.command === "string" && hook.command.includes(CLI_LIFECYCLE_MARKER)));
    if (hooks.length > 0) result.push({ ...group, hooks });
  }
  return result;
}

function parseClaudeSettings(source: string) {
  if (!source.trim()) return {} as Record<string, unknown>;
  return cloneJsonRecord(JSON.parse(source) as unknown);
}

export function installClaudeHooks(source: string, helperPath: string): ConfigEdit {
  const root = parseClaudeSettings(source);
  if (root.hooks !== undefined && !isRecord(root.hooks)) throw new Error("Claude settings hooks must be an object");
  const hooks = { ...(root.hooks as Record<string, unknown> | undefined) };
  const command = hookCommand(helperPath);
  for (const event of CLAUDE_EVENTS) {
    const existing = cleanOwnHooks(hooks[event], event);
    const own: HookGroup = { matcher: "", hooks: [{ type: "command", command, timeout: 5 }] };
    hooks[event] = [...existing, own];
  }
  root.hooks = hooks;
  const content = `${JSON.stringify(root, null, 2)}\n`;
  const normalizedSource = source.trim() ? `${JSON.stringify(JSON.parse(source), null, 2)}\n` : "{}\n";
  return { changed: content !== normalizedSource, content: content === normalizedSource ? source : content };
}

export function uninstallClaudeHooks(source: string): ConfigEdit {
  if (!source.trim()) return { changed: false, content: source };
  const root = parseClaudeSettings(source);
  if (root.hooks === undefined) return { changed: false, content: source };
  if (!isRecord(root.hooks)) throw new Error("Claude settings hooks must be an object");
  const hooks = { ...root.hooks };
  let changed = false;
  for (const event of CLAUDE_EVENTS) {
    const before = hooks[event];
    const after = cleanOwnHooks(before, event);
    if (Array.isArray(before) && after.length !== before.length) changed = true;
    if (after.length > 0) hooks[event] = after;
    else delete hooks[event];
  }
  if (!changed) return { changed: false, content: source };
  if (Object.keys(hooks).length > 0) root.hooks = hooks;
  else delete root.hooks;
  return { changed: true, content: `${JSON.stringify(root, null, 2)}\n` };
}

export function hasClaudeHooks(source: string) {
  const root = parseClaudeSettings(source);
  if (!isRecord(root.hooks)) return false;
  const hooks = root.hooks as Record<string, unknown>;
  return CLAUDE_EVENTS.every((event) => Array.isArray(hooks[event]) && (hooks[event] as unknown[]).some(hookContainsMarker));
}

async function pathExists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function atomicWrite(path: string, content: string, backup: boolean) {
  await mkdir(dirname(path), { recursive: true });
  const existed = await pathExists(path);
  if (backup && existed && !await pathExists(`${path}.bak`)) await copyFile(path, `${path}.bak`);
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, content, "utf8");
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function messageText(payload: Record<string, unknown>) {
  for (const key of ["message", "last-assistant-message", "notification", "title"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 500);
  }
  return undefined;
}

function aiSessionIdFromPayload(payload: Record<string, unknown>) {
  for (const key of ["session_id", "thread_id", "thread-id"]) {
    const value = payload[key];
    if (typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9:_\-.]{0,199}$/.test(value)) return value.slice(0, 200);
  }
  return undefined;
}

export function decodeCliLifecycleEvent(message: BridgeWireMessage): CliLifecycleEvent | null {
  if (message.version !== CONFIG_VERSION || (message.source !== "codex" && message.source !== "claude") || typeof message.payload !== "string") return null;
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(message.payload) as unknown;
    if (isRecord(parsed)) payload = parsed;
  } catch {
    // Some CLI versions may send plain text; the lifecycle event still matters.
  }
  const eventName = String(payload.hook_event_name || payload.type || "").toLowerCase();
  const kind = eventName.includes("userpromptsubmit")
    ? "started"
    : eventName.includes("notification") || eventName.includes("permission")
      ? "attention"
      : "done";
  const sessionId = typeof message.sessionId === "string" && /^[0-9a-f-]{36}$/i.test(message.sessionId) ? message.sessionId : undefined;
  return {
    source: message.source,
    sessionId,
    aiSessionId: aiSessionIdFromPayload(payload),
    kind,
    message: messageText(payload),
    timestamp: typeof message.timestamp === "number" && Number.isFinite(message.timestamp) ? message.timestamp : Date.now(),
  };
}

export class CliLifecycleBridge {
  private readonly userDataDir: string;
  private readonly helperTemplatePath: string;
  private readonly helperPath: string;
  private readonly codexConfigPath: string;
  private readonly claudeSettingsPath: string;
  private readonly statePath: string;
  private readonly pipeName: string;
  private readonly pipePath: string;
  private readonly onEvent: (event: CliLifecycleEvent) => void;
  private enabled = false;
  private server?: Server;
  private watchers: FSWatcher[] = [];
  private repairTimer?: NodeJS.Timeout;
  private pollTimer?: NodeJS.Timeout;
  private repairPromise?: Promise<void>;
  private lastRepairedAt?: number;
  private error?: string;
  private integrationErrors = new Map<"codex" | "claude", string>();

  constructor(options: CliLifecycleBridgeOptions) {
    this.userDataDir = options.userDataDir;
    this.helperTemplatePath = options.helperTemplatePath;
    this.helperPath = join(options.userDataDir, "cli-lifecycle-hook.ps1");
    this.codexConfigPath = join(options.codexHome || process.env.CODEX_UI_CODEX_HOME || process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml");
    this.claudeSettingsPath = join(options.claudeHome || process.env.CODEX_UI_CLAUDE_HOME || join(homedir(), ".claude"), "settings.json");
    this.statePath = join(options.userDataDir, "cli-lifecycle.json");
    const pipeHash = createHash("sha256").update(options.userDataDir).digest("hex").slice(0, 12);
    this.pipeName = `codex-cli-ui-${pipeHash}-${process.pid}`;
    this.pipePath = process.platform === "win32" ? `\\\\.\\pipe\\${this.pipeName}` : join(tmpdir(), `${this.pipeName}.sock`);
    this.onEvent = options.onEvent;
  }

  getPipeName() {
    return this.pipeName;
  }

  async initialize() {
    await this.prepareHelper();
    await this.startServer();
    try {
      const state = JSON.parse(await readFile(this.statePath, "utf8")) as Partial<BridgeState>;
      this.enabled = state.version === CONFIG_VERSION && state.enabled === true;
    } catch {
      this.enabled = false;
    }
    if (this.enabled && process.platform === "win32") {
      await this.repairNow();
      await this.startWatchers();
    }
  }

  async setEnabled(enabled: boolean) {
    if (process.platform !== "win32") {
      this.error = "CLI lifecycle hooks currently require Windows PowerShell";
      return this.status();
    }
    this.enabled = enabled;
    await atomicWrite(this.statePath, `${JSON.stringify({ version: CONFIG_VERSION, enabled }, null, 2)}\n`, false);
    if (enabled) {
      await this.prepareHelper();
      await this.repairNow();
      await this.startWatchers();
    } else {
      this.stopWatchers();
      await this.applyConfigAction("uninstall");
    }
    return this.status();
  }

  async repairNow() {
    if (!this.enabled || process.platform !== "win32") return;
    if (!this.repairPromise) {
      this.repairPromise = this.applyConfigAction("install")
        .then(() => { this.lastRepairedAt = Date.now(); })
        .finally(() => { this.repairPromise = undefined; });
    }
    await this.repairPromise;
  }

  async status(): Promise<CliLifecycleStatus> {
    const integrations = await Promise.all([
      this.integrationStatus("codex", "Codex", this.codexConfigPath),
      this.integrationStatus("claude", "Claude Code", this.claudeSettingsPath),
    ]);
    return {
      enabled: this.enabled,
      supported: process.platform === "win32",
      watching: this.watchers.length > 0,
      integrations,
      lastRepairedAt: this.lastRepairedAt,
      error: this.error,
    };
  }

  async dispose() {
    this.stopWatchers();
    if (this.server) {
      await new Promise<void>((resolveClose) => this.server!.close(() => resolveClose()));
      this.server = undefined;
    }
    if (process.platform !== "win32" && existsSync(this.pipePath)) await unlink(this.pipePath).catch(() => undefined);
  }

  private async prepareHelper() {
    const source = await readFile(this.helperTemplatePath, "utf8");
    let current = "";
    try { current = await readFile(this.helperPath, "utf8"); } catch { /* First run. */ }
    if (current !== source) await atomicWrite(this.helperPath, source, false);
  }

  private async applyConfigAction(action: "install" | "uninstall") {
    await Promise.all([
      this.updateIntegration("codex", this.codexConfigPath, (source) => action === "install" ? installCodexNotify(source, this.helperPath) : uninstallCodexNotify(source)),
      this.updateIntegration("claude", this.claudeSettingsPath, (source) => action === "install" ? installClaudeHooks(source, this.helperPath) : uninstallClaudeHooks(source)),
    ]);
  }

  private async updateIntegration(id: "codex" | "claude", path: string, edit: (source: string) => ConfigEdit) {
    try {
      let source = "";
      try { source = await readFile(path, "utf8"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const result = edit(source);
      if (result.changed) await atomicWrite(path, result.content, true);
      this.integrationErrors.delete(id);
    } catch (error) {
      this.integrationErrors.set(id, error instanceof Error ? error.message : String(error));
    }
  }

  private async integrationStatus(id: "codex" | "claude", label: string, configPath: string): Promise<CliLifecycleIntegrationStatus> {
    let installed = false;
    let error = this.integrationErrors.get(id);
    try {
      const source = await readFile(configPath, "utf8");
      installed = id === "codex" ? hasCodexNotify(source) : hasClaudeHooks(source);
    } catch (reason) {
      if ((reason as NodeJS.ErrnoException).code !== "ENOENT") error = reason instanceof Error ? reason.message : String(reason);
    }
    return { id, label, installed, configPath, error };
  }

  private async startWatchers() {
    this.stopWatchers();
    for (const configPath of [this.codexConfigPath, this.claudeSettingsPath]) {
      const directory = dirname(configPath);
      await mkdir(directory, { recursive: true });
      try {
        const watcher = watch(directory, { persistent: false }, (_event, filename) => {
          if (filename && filename.toString().toLowerCase() !== configPath.slice(directory.length + 1).toLowerCase()) return;
          this.scheduleRepair();
        });
        watcher.on("error", (reason) => { this.error = reason.message; });
        this.watchers.push(watcher);
      } catch (reason) {
        this.error = reason instanceof Error ? reason.message : String(reason);
      }
    }
    this.pollTimer = setInterval(() => void this.repairNow(), 5 * 60 * 1000);
    this.pollTimer.unref();
  }

  private scheduleRepair() {
    if (this.repairTimer) clearTimeout(this.repairTimer);
    this.repairTimer = setTimeout(() => void this.repairNow(), 400);
    this.repairTimer.unref();
  }

  private stopWatchers() {
    if (this.repairTimer) clearTimeout(this.repairTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.repairTimer = undefined;
    this.pollTimer = undefined;
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
  }

  private async startServer() {
    if (process.platform !== "win32" && existsSync(this.pipePath)) await unlink(this.pipePath).catch(() => undefined);
    this.server = createServer((socket) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      socket.on("error", (reason) => { this.error = reason.message; });
      socket.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes <= MAX_PIPE_MESSAGE) chunks.push(chunk);
        else socket.destroy();
      });
      socket.on("end", () => {
        if (bytes === 0 || bytes > MAX_PIPE_MESSAGE) return;
        try {
          const wire = JSON.parse(Buffer.concat(chunks).toString("utf8")) as BridgeWireMessage;
          const event = decodeCliLifecycleEvent(wire);
          if (event) this.onEvent(event);
        } catch {
          // Malformed local messages are ignored.
        }
      });
    });
    this.server.on("error", (reason) => { this.error = reason.message; });
    await new Promise<void>((resolveListen, reject) => {
      const onError = (reason: Error) => reject(reason);
      this.server!.once("error", onError);
      this.server!.listen(this.pipePath, () => {
        this.server!.removeListener("error", onError);
        resolveListen();
      });
    }).catch((reason) => { this.error = reason instanceof Error ? reason.message : String(reason); });
  }
}
