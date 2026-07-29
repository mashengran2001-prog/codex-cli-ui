import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  shell,
  Tray,
} from "electron";
import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, statSync, type Dirent } from "node:fs";
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, normalize, resolve } from "node:path";
import { createInterface } from "node:readline";
import type {
  Activity,
  AppSettings,
  ChatMessage,
  CodexInfo,
  LauncherRequest,
  LauncherStatus,
  RunEvent,
  RunRequest,
  SessionSummary,
} from "../src/types";

interface ActiveRun {
  child: ReturnType<typeof spawn>;
  stopped: boolean;
  owner: BrowserWindow;
  cwd: string;
}

interface SessionFile {
  path: string;
  modifiedAt: number;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,99}$/;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const MAX_PROMPT_LENGTH = 1_000_000;
const MAX_SESSION_BYTES = 30 * 1024 * 1024;
const MAX_SESSION_FILES = 250;
const DEFAULT_SETTINGS: AppSettings = { closeBehavior: "tray", notifyOnCompletion: true };
const activeRuns = new Map<string, ActiveRun>();
const sessionPathCache = new Map<string, string>();

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let appSettings = DEFAULT_SETTINGS;
let queuedLauncherRequest: LauncherRequest | null = null;

app.setName("Codex CLI UI");
if (process.env.CODEX_UI_USER_DATA_DIR) app.setPath("userData", process.env.CODEX_UI_USER_DATA_DIR);

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.quit();

function decodeBase64Json<T>(value: string): T | null {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

function parseLauncherRequest(argv: string[]): LauncherRequest | null {
  const cwdValue = argv.find((arg) => arg.startsWith("--codex-cwd-b64="))?.slice(16);
  const argsValue = argv.find((arg) => arg.startsWith("--codex-args-b64="))?.slice(17);
  if (!cwdValue) return null;
  try {
    const cwd = Buffer.from(cwdValue, "base64url").toString("utf8");
    const args = argsValue ? decodeBase64Json<unknown>(argsValue) : [];
    if (!existsSync(cwd) || !statSync(cwd).isDirectory() || !Array.isArray(args) || !args.every((arg) => typeof arg === "string")) {
      return null;
    }

    const cleanArgs = [...args];
    if (cleanArgs[0] === "exec") cleanArgs.shift();
    let model: string | undefined;
    const promptParts: string[] = [];
    for (let index = 0; index < cleanArgs.length; index += 1) {
      const arg = cleanArgs[index];
      if ((arg === "-m" || arg === "--model") && cleanArgs[index + 1]) {
        model = cleanArgs[index + 1];
        index += 1;
      } else if ((arg === "-C" || arg === "--cd") && cleanArgs[index + 1]) {
        index += 1;
      } else if (!arg.startsWith("-")) {
        promptParts.push(arg);
      }
    }
    return { cwd, args: cleanArgs, prompt: promptParts.join(" ").trim() || undefined, model };
  } catch {
    return null;
  }
}

function sendLauncherRequest(window: BrowserWindow, request: LauncherRequest) {
  const send = () => setTimeout(() => {
    if (!window.isDestroyed()) window.webContents.send("launcher:request", request);
  }, 250);
  if (window.webContents.isLoading()) window.webContents.once("did-finish-load", send);
  else send();
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1380,
    height: 880,
    minWidth: 760,
    minHeight: 620,
    backgroundColor: "#f7f7f5",
    title: "Codex CLI UI",
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#f0f0ec",
      symbolColor: "#33332f",
      height: 44,
    },
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const devServer = process.env.VITE_DEV_SERVER_URL;
  if (devServer) void window.loadURL(devServer);
  else void window.loadFile(join(__dirname, "../../dist/index.html"));

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    const line = `${new Date().toISOString()} renderer ${details.reason} (${details.exitCode})\n`;
    void appendFile(join(app.getPath("userData"), "renderer-errors.log"), line, "utf8");
  });
  window.on("close", (event) => {
    if (isQuitting || appSettings.closeBehavior === "quit") return;
    event.preventDefault();
    ensureTray();
    window.hide();
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
  mainWindow = window;
  if (queuedLauncherRequest) {
    sendLauncherRequest(window, queuedLauncherRequest);
    queuedLauncherRequest = null;
  }
  return window;
}

function showMainWindow(request?: LauncherRequest | null) {
  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createWindow();
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  if (request) sendLauncherRequest(window, request);
}

function ensureTray() {
  if (tray && !tray.isDestroyed()) return tray;
  const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const icon = nativeImage.createFromBuffer(Buffer.from(pixel, "base64")).resize({ width: 18, height: 18 });
  tray = new Tray(icon);
  tray.setToolTip("Codex CLI UI");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开 Codex CLI UI", click: () => showMainWindow() },
    { type: "separator" },
    { label: "退出", click: () => quitApplication() },
  ]));
  tray.on("click", () => showMainWindow());
  return tray;
}

function quitApplication() {
  isQuitting = true;
  for (const run of activeRuns.values()) stopChild(run);
  app.quit();
}

function settingsPath() {
  return join(app.getPath("userData"), "settings.json");
}

async function loadSettings() {
  try {
    const value = JSON.parse(await readFile(settingsPath(), "utf8")) as Partial<AppSettings>;
    appSettings = {
      closeBehavior: value.closeBehavior === "quit" ? "quit" : "tray",
      notifyOnCompletion: value.notifyOnCompletion !== false,
    };
  } catch {
    appSettings = DEFAULT_SETTINGS;
  }
}

async function saveSettings(settings: AppSettings) {
  await mkdir(dirname(settingsPath()), { recursive: true });
  await writeFile(settingsPath(), JSON.stringify(settings, null, 2), "utf8");
}

function normalizePath(value: string) {
  const result = normalize(resolve(value));
  return process.platform === "win32" ? result.toLowerCase() : result;
}

function isDirectory(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) return false;
  try {
    return existsSync(value) && statSync(value).isDirectory();
  } catch {
    return false;
  }
}

function isImagePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || !IMAGE_EXTENSIONS.has(extname(value).toLowerCase())) return false;
  try {
    return existsSync(value) && statSync(value).isFile();
  } catch {
    return false;
  }
}

function nativeCodexFromNpm() {
  const appData = process.env.APPDATA;
  if (!appData) return null;
  const candidate = join(
    appData,
    "npm",
    "node_modules",
    "@openai",
    "codex",
    "node_modules",
    "@openai",
    "codex-win32-x64",
    "vendor",
    "x86_64-pc-windows-msvc",
    "bin",
    "codex.exe",
  );
  return existsSync(candidate) ? candidate : null;
}

function findCodexExecutable() {
  if (process.env.CODEX_UI_CLI_PATH) return process.env.CODEX_UI_CLI_PATH;
  const npmNative = process.platform === "win32" ? nativeCodexFromNpm() : null;
  if (npmNative) return npmNative;
  const executableName = process.platform === "win32" ? "codex.exe" : "codex";
  for (const entry of (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":")) {
    if (!entry) continue;
    const candidate = join(entry, executableName);
    if (existsSync(candidate)) return candidate;
  }
  return executableName;
}

function codexPrefixArgs() {
  try {
    const value: unknown = JSON.parse(process.env.CODEX_UI_CLI_PREFIX_ARGS ?? "[]");
    return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
  } catch {
    return [];
  }
}

function codexHome() {
  return process.env.CODEX_UI_CODEX_HOME || process.env.CODEX_HOME || join(homedir(), ".codex");
}

function isValidRunRequest(value: unknown): value is RunRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<RunRequest>;
  const validSandbox = request.sandboxMode === "read-only" || request.sandboxMode === "workspace-write" || request.sandboxMode === "danger-full-access";
  const validReasoning = request.reasoningEffort === "low" || request.reasoningEffort === "medium" || request.reasoningEffort === "high" || request.reasoningEffort === "xhigh";
  const validImages = request.imagePaths === undefined || (
    Array.isArray(request.imagePaths) && request.imagePaths.length <= 10 && request.imagePaths.every(isImagePath)
  );
  return (
    typeof request.runId === "string" && RUN_ID_PATTERN.test(request.runId) &&
    typeof request.prompt === "string" && request.prompt.trim().length > 0 && request.prompt.length <= MAX_PROMPT_LENGTH &&
    isDirectory(request.cwd) &&
    (request.threadId === undefined || (typeof request.threadId === "string" && UUID_PATTERN.test(request.threadId))) &&
    (request.model === undefined || (typeof request.model === "string" && request.model.length <= 160 && !/[\r\n]/.test(request.model))) &&
    validSandbox && validReasoning && validImages
  );
}

function emit(owner: BrowserWindow, event: RunEvent) {
  if (!owner.isDestroyed()) owner.webContents.send("codex:event", event);
}

function stopChild(run: ActiveRun) {
  run.stopped = true;
  if (run.child.killed || run.child.pid === undefined) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/pid", String(run.child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    killer.unref();
  } else {
    run.child.kill("SIGTERM");
  }
}

async function collectSessionFiles(): Promise<SessionFile[]> {
  const root = join(codexHome(), "sessions");
  if (!existsSync(root)) return [];
  const files: SessionFile[] = [];
  const walk = async (directory: string) => {
    let entries: Dirent<string>[];
    try {
      entries = await readdir(directory, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return;
    }
    await Promise.all(entries.map(async (entry) => {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) await walk(fullPath);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          const details = await stat(fullPath);
          if (details.size <= MAX_SESSION_BYTES) files.push({ path: fullPath, modifiedAt: details.mtimeMs });
        } catch {
          // Ignore files that disappear during a Codex write.
        }
      }
    }));
  };
  await walk(root);
  return files.sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, MAX_SESSION_FILES);
}

async function loadThreadNames() {
  const names = new Map<string, string>();
  const path = join(codexHome(), "session_index.jsonl");
  try {
    for (const line of (await readFile(path, "utf8")).split(/\r?\n/)) {
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        if (typeof value.id === "string" && typeof value.thread_name === "string" && value.thread_name.trim()) {
          names.set(value.id, value.thread_name.trim());
        }
      } catch {
        // A partially-written final line is expected while Codex is running.
      }
    }
  } catch {
    // Session names are optional.
  }
  return names;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function activityFromResponse(payload: Record<string, unknown>, timestamp: number): Activity | null {
  if (payload.type === "function_call") {
    const name = stringValue(payload.name) || "tool";
    const detail = stringValue(payload.arguments);
    return {
      id: stringValue(payload.call_id) || stringValue(payload.id) || `${timestamp}-${name}`,
      kind: name.includes("shell") || name.includes("command") ? "command" : name.includes("file") || name.includes("patch") ? "file" : "tool",
      name,
      summary: detail.slice(0, 180),
      detail,
      status: "running",
    };
  }
  if (payload.type === "web_search_call") {
    const action = asRecord(payload.action);
    const query = action ? stringValue(action.query) : "";
    return {
      id: stringValue(payload.id) || `${timestamp}-web`,
      kind: "web",
      name: "Web search",
      summary: query || stringValue(payload.status),
      status: payload.status === "failed" ? "error" : payload.status === "completed" ? "done" : "running",
    };
  }
  return null;
}

function sessionTitle(value: string) {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 54 ? `${compact.slice(0, 53)}…` : compact;
}

async function parseSessionFile(file: SessionFile, names: Map<string, string>, includeMessages: boolean): Promise<SessionSummary | null> {
  let raw: string;
  try {
    raw = await readFile(file.path, "utf8");
  } catch {
    return null;
  }
  let id = "";
  let cwd = "";
  let createdAt = file.modifiedAt;
  let model = "";
  let cliVersion = "";
  let gitBranch = "";
  let firstPrompt = "";
  const messages: ChatMessage[] = [];
  let reasoning = "";
  let activities: Activity[] = [];
  let turnStartedAt = file.modifiedAt;

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const payload = asRecord(row.payload);
    if (!payload) continue;
    const timestamp = Date.parse(stringValue(row.timestamp)) || file.modifiedAt;
    if (row.type === "session_meta") {
      id = stringValue(payload.id) || stringValue(payload.session_id) || id;
      cwd = stringValue(payload.cwd) || cwd;
      createdAt = Date.parse(stringValue(payload.timestamp)) || timestamp || createdAt;
      cliVersion = stringValue(payload.cli_version) || cliVersion;
      model = stringValue(payload.model) || model;
      gitBranch = stringValue(payload.git_branch) || gitBranch;
      continue;
    }
    if (row.type === "turn_context") {
      model = stringValue(payload.model) || model;
      cwd = stringValue(payload.cwd) || cwd;
      continue;
    }
    if (row.type === "response_item") {
      if (includeMessages) {
        const activity = activityFromResponse(payload, timestamp);
        if (activity) activities.push(activity);
        if (payload.type === "function_call_output") {
          const callId = stringValue(payload.call_id);
          activities = activities.map((item) => item.id === callId ? { ...item, status: "done" } : item);
        }
      }
      continue;
    }
    if (row.type !== "event_msg") continue;
    if (payload.type === "task_started") {
      turnStartedAt = Date.parse(stringValue(payload.started_at)) || timestamp;
      reasoning = "";
      activities = [];
    } else if (payload.type === "user_message") {
      const content = stringValue(payload.message);
      if (!content) continue;
      if (!firstPrompt) firstPrompt = content;
      if (includeMessages) {
        messages.push({ id: randomUUID(), role: "user", content, createdAt: timestamp, status: "done" });
      }
    } else if (payload.type === "agent_reasoning") {
      if (includeMessages) reasoning = [reasoning, stringValue(payload.text)].filter(Boolean).join("\n");
    } else if (payload.type === "agent_message") {
      const content = stringValue(payload.message);
      if (includeMessages && content) {
        messages.push({
          id: randomUUID(),
          role: "assistant",
          content,
          reasoning: reasoning || undefined,
          activities: activities.length ? activities.map((item) => ({ ...item, status: item.status === "running" ? "done" : item.status })) : undefined,
          createdAt: timestamp || turnStartedAt,
          status: "done",
        });
        reasoning = "";
        activities = [];
      }
    } else if (payload.type === "task_complete" && includeMessages && messages.at(-1)?.role !== "assistant") {
      const content = stringValue(payload.last_agent_message);
      if (content) messages.push({ id: randomUUID(), role: "assistant", content, reasoning: reasoning || undefined, activities, createdAt: timestamp, status: "done" });
    }
  }

  if (!id || !cwd) return null;
  sessionPathCache.set(id, file.path);
  const title = names.get(id) || sessionTitle(firstPrompt) || `会话 ${id.slice(0, 8)}`;
  return {
    id,
    title,
    cwd,
    createdAt,
    updatedAt: file.modifiedAt,
    model: model || undefined,
    cliVersion: cliVersion || undefined,
    gitBranch: gitBranch || undefined,
    messages: includeMessages ? messages.slice(-240) : undefined,
  };
}

async function listSessionsForWorkspace(cwd: string) {
  const [files, names] = await Promise.all([collectSessionFiles(), loadThreadNames()]);
  const expected = normalizePath(cwd);
  const results: SessionSummary[] = [];
  for (const file of files) {
    const summary = await parseSessionFile(file, names, false);
    if (summary && normalizePath(summary.cwd) === expected) results.push(summary);
  }
  return results.sort((a, b) => b.updatedAt - a.updatedAt);
}

async function getSession(id: string, cwd: string) {
  const names = await loadThreadNames();
  const expected = normalizePath(cwd);
  const cached = sessionPathCache.get(id);
  if (cached && existsSync(cached)) {
    const details = await stat(cached);
    const result = await parseSessionFile({ path: cached, modifiedAt: details.mtimeMs }, names, true);
    if (result && normalizePath(result.cwd) === expected) return result;
  }
  for (const file of await collectSessionFiles()) {
    const result = await parseSessionFile(file, names, true);
    if (result?.id === id && normalizePath(result.cwd) === expected) return result;
  }
  return null;
}

function launcherScriptPath() {
  return app.isPackaged
    ? join(process.resourcesPath, "scripts", "install-launcher.ps1")
    : join(app.getAppPath(), "scripts", "install-launcher.ps1");
}

function runLauncherAction(action: "Status" | "Install" | "Uninstall") {
  return new Promise<LauncherStatus>((resolveStatus) => {
    const script = launcherScriptPath();
    if (!existsSync(script)) {
      resolveStatus({ installed: false, profilePath: "", error: "找不到 launcher 安装脚本" });
      return;
    }
    const args = [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", script,
      "-Action", action,
      "-AppExecutable", process.execPath,
      "-ProjectRoot", app.isPackaged ? dirname(process.execPath) : app.getAppPath(),
      "-RawCommand", findCodexExecutable(),
    ];
    execFile("powershell.exe", args, { windowsHide: true, timeout: 20_000 }, (error, stdout, stderr) => {
      try {
        const status = JSON.parse(stdout.trim()) as LauncherStatus;
        resolveStatus(error ? { ...status, error: stderr.trim() || error.message } : status);
      } catch {
        resolveStatus({ installed: false, profilePath: "", error: stderr.trim() || error?.message || "launcher 返回了无效结果" });
      }
    });
  });
}

ipcMain.handle("codex:info", async (): Promise<CodexInfo> => new Promise((resolveInfo) => {
  const executable = findCodexExecutable();
  const child = spawn(executable, [...codexPrefixArgs(), "--version"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let errorOutput = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  child.stderr?.on("data", (chunk: Buffer) => { errorOutput += chunk.toString("utf8"); });
  child.on("error", (error) => resolveInfo({ available: false, executable, error: error.message }));
  child.on("close", (code) => resolveInfo(code === 0
    ? { available: true, version: output.trim(), executable }
    : { available: false, executable, error: errorOutput.trim() || `Codex 退出码 ${code}` }));
}));

ipcMain.handle("app:settings:get", () => appSettings);
ipcMain.handle("app:settings:set", async (_event, value: unknown) => {
  const source = value as Partial<AppSettings>;
  appSettings = {
    closeBehavior: source?.closeBehavior === "quit" ? "quit" : "tray",
    notifyOnCompletion: source?.notifyOnCompletion !== false,
  };
  await saveSettings(appSettings);
  return appSettings;
});

ipcMain.handle("dialog:directory", async () => {
  const options: Electron.OpenDialogOptions = { properties: ["openDirectory", "createDirectory"] };
  const result = mainWindow && !mainWindow.isDestroyed()
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? null : result.filePaths[0] ?? null;
});

ipcMain.handle("dialog:images", async () => {
  const options: Electron.OpenDialogOptions = {
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }],
  };
  const result = mainWindow && !mainWindow.isDestroyed()
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? [] : result.filePaths.filter(isImagePath).slice(0, 10);
});

ipcMain.handle("path:reveal", async (_event, value: unknown) => {
  if (!isDirectory(value)) return false;
  shell.showItemInFolder(value);
  return true;
});

ipcMain.handle("path:terminal", async (_event, value: unknown) => {
  if (!isDirectory(value)) return false;
  const escaped = value.replace(/'/g, "''");
  const child = spawn("powershell.exe", ["-NoExit", "-Command", `Set-Location -LiteralPath '${escaped}'`], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
  return true;
});

ipcMain.handle("codex:sessions", async (_event, value: unknown) => isDirectory(value) ? listSessionsForWorkspace(value) : []);
ipcMain.handle("codex:session", async (_event, id: unknown, cwd: unknown) => (
  typeof id === "string" && UUID_PATTERN.test(id) && isDirectory(cwd) ? getSession(id, cwd) : null
));

ipcMain.handle("codex:run", async (event, value: unknown) => {
  if (!isValidRunRequest(value)) throw new Error("无效的 Codex 运行请求");
  if (activeRuns.has(value.runId)) throw new Error("运行 ID 已存在");
  const owner = BrowserWindow.fromWebContents(event.sender);
  if (!owner) throw new Error("窗口已关闭");

  const args: string[] = [...codexPrefixArgs()];
  if (value.sandboxMode === "danger-full-access") args.push("--dangerously-bypass-approvals-and-sandbox");
  else args.push("--sandbox", value.sandboxMode);
  args.push("exec");
  if (value.threadId) args.push("resume");
  args.push("--json", "--skip-git-repo-check");
  if (value.model) args.push("--model", value.model);
  args.push("-c", `model_reasoning_effort=\"${value.reasoningEffort}\"`);
  for (const imagePath of value.imagePaths ?? []) args.push("--image", imagePath);
  if (value.threadId) args.push(value.threadId);
  args.push("-");

  const child = spawn(findCodexExecutable(), args, {
    cwd: value.cwd,
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const run: ActiveRun = { child, stopped: false, owner, cwd: value.cwd };
  activeRuns.set(value.runId, run);
  const output = createInterface({ input: child.stdout! });
  output.on("line", (line) => {
    if (!line.trim()) return;
    try {
      const data = JSON.parse(line) as Record<string, unknown>;
      emit(owner, { runId: value.runId, type: "message", data });
    } catch {
      emit(owner, { runId: value.runId, type: "stderr", text: line });
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => emit(owner, { runId: value.runId, type: "stderr", text: chunk.toString("utf8") }));
  child.on("error", (error) => emit(owner, { runId: value.runId, type: "error", text: error.message }));
  child.on("close", (code) => {
    activeRuns.delete(value.runId);
    emit(owner, { runId: value.runId, type: "exit", code, stopped: run.stopped });
    if (appSettings.notifyOnCompletion && (!owner.isVisible() || !owner.isFocused()) && Notification.isSupported()) {
      const notification = new Notification({ title: "Codex 已完成", body: basename(value.cwd), silent: true });
      notification.on("click", () => showMainWindow());
      notification.show();
    }
  });
  child.stdin?.end(value.prompt, "utf8");
  return { accepted: true as const };
});

ipcMain.handle("codex:stop", (_event, runId: unknown) => {
  if (typeof runId !== "string") return false;
  const run = activeRuns.get(runId);
  if (!run) return false;
  stopChild(run);
  return true;
});

ipcMain.handle("launcher:status", () => runLauncherAction("Status"));
ipcMain.handle("launcher:install", () => runLauncherAction("Install"));
ipcMain.handle("launcher:uninstall", () => runLauncherAction("Uninstall"));

app.on("second-instance", (_event, argv) => showMainWindow(parseLauncherRequest(argv)));
app.on("activate", () => showMainWindow());
app.on("before-quit", () => { isQuitting = true; });
app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && appSettings.closeBehavior === "quit") app.quit();
});

void app.whenReady().then(async () => {
  await loadSettings();
  queuedLauncherRequest = parseLauncherRequest(process.argv);
  createWindow();
});
