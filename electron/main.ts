import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  safeStorage,
  shell,
  Tray,
  webContents,
} from "electron";
import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, statSync, writeFileSync, type Dirent } from "node:fs";
import { appendFile, lstat, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import type { IPty } from "node-pty";
import type {
  Activity,
  AgentProviderId,
  AgentProviderInfo,
  AppSettings,
  ChatMessage,
  CliProfile,
  CliToolInfo,
  CodexInfo,
  DocumentFile,
  FileSystemEntry,
  GitActionRequest,
  GitStatus,
  LauncherRequest,
  LauncherStatus,
  OperationResult,
  RunEvent,
  RunRequest,
  SessionSummary,
  SftpActionRequest,
  SftpEntry,
  ShellProfile,
  SshConnectionStage,
  SshProfile,
  SshTestResult,
  TerminalCreateRequest,
  TerminalEvent,
  TerminalInfo,
} from "../src/types";
import { DeepSeekProvider } from "./deepseek-provider";
import { CliLifecycleBridge, type CliLifecycleEvent } from "./cli-lifecycle";
import { ProviderRegistry, type AgentProvider, type ProviderRunContext } from "./provider-registry";
import { terminalShellArguments, terminalTitleFromPath } from "./terminal-utils";

interface ActiveRun {
  child: ReturnType<typeof spawn>;
  stopped: boolean;
}

interface SessionFile {
  path: string;
  modifiedAt: number;
}

interface TerminalSession {
  id: string;
  title: string;
  cwd: string;
  shell: string;
  shellId: string;
  profileId?: string;
  kind: "local" | "ssh";
  remoteHost?: string;
  sshProfileId?: string;
  activity: "idle" | "running" | "attention";
  activeCommand?: string;
  commandStartedAt?: number;
  lastCommandDuration?: number;
  inputBuffer: string;
  pty: IPty;
  status: "running" | "exited";
  createdAt: number;
  updatedAt: number;
  cols: number;
  rows: number;
  history: string;
  pending: string;
  subscribers: Set<number>;
  flushTimer?: NodeJS.Timeout;
  resizeTimer?: NodeJS.Timeout;
  pendingResize?: { cols: number; rows: number };
  lastBellAt: number;
}

interface TerminalSnapshot {
  id: string;
  title: string;
  cwd: string;
  cols: number;
  rows: number;
  shellId?: string;
  profileId?: string;
  sshProfileId?: string;
}

interface DetectedShell extends ShellProfile {
  args: string[];
}

interface ShellStartupStatus {
  enabled: boolean;
  powershellInstalled: boolean;
  cmdInstalled: boolean;
  profilePaths: string[];
  registryPath: string;
  error?: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,99}$/;
const PROVIDER_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,119}$/;
const SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,199}$/;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const MAX_PROMPT_LENGTH = 1_000_000;
const MAX_SESSION_BYTES = 30 * 1024 * 1024;
const MAX_SESSION_FILES = 250;
const MAX_TERMINAL_HISTORY = 300_000;
const MAX_TERMINAL_INPUT = 64 * 1024;
const MAX_TERMINALS = 16;
const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
const MAX_HISTORY_ENTRIES = 1_000;
const VALID_THEMES = new Set(["nebula", "silver", "steel", "limestone", "coal", "linen", "moss"]);
const DEFAULT_SETTINGS: AppSettings = {
  closeBehavior: "tray",
  notifyOnCompletion: true,
  language: "system",
  theme: "nebula",
  backgroundBlur: false,
  backgroundOpacity: 0.92,
  restoreTerminalTabs: true,
  resizablePanels: false,
  completionEnabled: true,
  copyOnSelect: true,
  powerlinePrompt: true,
  quickTerminal: true,
  shellStartupIntegration: false,
  defaultShellId: "powershell",
  cursorStyle: "bar",
  cursorBlink: true,
  bellSound: true,
  loadShellProfile: false,
  cliProfiles: [],
};
const BUILTIN_CLI_TOOLS: Array<CliProfile & { description: string; installCommand: string }> = [
  { id: "builtin:codex", name: "Codex", command: "codex", args: [], icon: "code", description: "OpenAI Codex CLI", installCommand: "npm install -g @openai/codex" },
  { id: "builtin:claude", name: "Claude Code", command: "claude", args: [], icon: "code", description: "Anthropic Claude Code", installCommand: "npm install -g @anthropic-ai/claude-code" },
  { id: "builtin:gemini", name: "Gemini CLI", command: "gemini", args: [], icon: "code", description: "Google Gemini CLI", installCommand: "npm install -g @google/gemini-cli" },
  { id: "builtin:opencode", name: "OpenCode", command: "opencode", args: [], icon: "code", description: "OpenCode terminal agent", installCommand: "npm install -g opencode-ai" },
  { id: "builtin:deepseek", name: "DeepSeek Harness", command: "dsh", args: [], icon: "code", description: "DeepSeek Harness CLI", installCommand: "npm install -g @deepseek-ai/dsh@0.1.0-rc.7" },
];
const activeRuns = new Map<string, ActiveRun>();
const activeProviderRuns = new Map<string, AgentProviderId>();
const sessionPathCache = new Map<string, string>();
const terminalSessions = new Map<string, TerminalSession>();

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let appSettings = DEFAULT_SETTINGS;
let queuedLauncherRequest: LauncherRequest | null = null;
let terminalRestorePromise: Promise<void> | null = null;
let terminalSaveQueue = Promise.resolve();
let ptyModule: typeof import("node-pty") | null = null;
let detectedShells: DetectedShell[] = [];
let sshProfiles: SshProfile[] = [];
let terminalRestoreQuarantined = false;
let providerRegistry: ProviderRegistry | null = null;
let cliLifecycleBridge: CliLifecycleBridge | null = null;
const bootStartedAt = Date.now();

app.setName("Codex CLI UI");
process.env.CODEX_UI_SHELL_STARTUP_GUARD = "1";
if (process.env.CODEX_UI_USER_DATA_DIR) app.setPath("userData", process.env.CODEX_UI_USER_DATA_DIR);

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.quit();

function bootTrace(stage: string) {
  if (process.env.CODEX_UI_BOOT_TRACE !== "1") return;
  const line = `${new Date().toISOString()} +${Date.now() - bootStartedAt}ms ${stage}\n`;
  try {
    const path = join(app.getPath("userData"), "boot-trace.log");
    void mkdir(dirname(path), { recursive: true }).then(() => appendFile(path, line, "utf8"));
  } catch {
    // Boot tracing must never block startup.
  }
}

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
  bootTrace("create-window:start");
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
  applyWindowAppearance(window);

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
  const rendererId = window.webContents.id;
  window.on("closed", () => {
    for (const session of terminalSessions.values()) session.subscribers.delete(rendererId);
    if (mainWindow === window) mainWindow = null;
  });
  mainWindow = window;
  if (queuedLauncherRequest) {
    sendLauncherRequest(window, queuedLauncherRequest);
    queuedLauncherRequest = null;
  }
  bootTrace("create-window:ready");
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
  markTerminalRuntimeClean();
  for (const run of activeRuns.values()) stopChild(run);
  void providerRegistry?.dispose();
  void cliLifecycleBridge?.dispose();
  for (const session of terminalSessions.values()) {
    if (session.flushTimer) clearTimeout(session.flushTimer);
    if (session.resizeTimer) clearTimeout(session.resizeTimer);
    try { session.pty.kill(); } catch { /* The terminal may already have exited. */ }
  }
  app.quit();
}

function settingsPath() {
  return join(app.getPath("userData"), "settings.json");
}

function providerCredentialsPath() {
  return join(app.getPath("userData"), "provider-credentials.json");
}

interface ProviderCredentialStore {
  version: 1;
  credentials: Record<string, string>;
}

async function loadProviderCredential(providerId: AgentProviderId) {
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    const store = JSON.parse(await readFile(providerCredentialsPath(), "utf8")) as Partial<ProviderCredentialStore>;
    const encrypted = store.version === 1 && store.credentials && typeof store.credentials[providerId] === "string"
      ? store.credentials[providerId]
      : "";
    return encrypted ? safeStorage.decryptString(Buffer.from(encrypted, "base64")) : null;
  } catch {
    return null;
  }
}

async function saveProviderCredential(providerId: AgentProviderId, credential: string) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("系统安全存储不可用，未保存 API Key");
  let store: ProviderCredentialStore = { version: 1, credentials: {} };
  try {
    const current = JSON.parse(await readFile(providerCredentialsPath(), "utf8")) as Partial<ProviderCredentialStore>;
    if (current.version === 1 && current.credentials && typeof current.credentials === "object") {
      store = { version: 1, credentials: { ...current.credentials } };
    }
  } catch {
    // A missing credential store is the normal first-run state.
  }
  const value = credential.trim();
  if (value) store.credentials[providerId] = safeStorage.encryptString(value).toString("base64");
  else delete store.credentials[providerId];
  const path = providerCredentialsPath();
  const temporary = `${path}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, JSON.stringify(store, null, 2), "utf8");
  try {
    await rename(temporary, path);
  } catch {
    await writeFile(path, JSON.stringify(store, null, 2), "utf8");
  }
}

function resolvePackageBin(packageName: string) {
  try {
    const packagePath = require.resolve(`${packageName}/package.json`);
    const manifest = JSON.parse(readFileSync(packagePath, "utf8")) as { bin?: string | Record<string, string> };
    const relativeBin = typeof manifest.bin === "string" ? manifest.bin : Object.values(manifest.bin ?? {})[0];
    return relativeBin ? resolve(dirname(packagePath), relativeBin) : "";
  } catch {
    return "";
  }
}

function deepSeekRuntimeConfigPath() {
  return app.isPackaged
    ? join(process.resourcesPath, "scripts", "deepseek-runtime.cordis.yml")
    : join(app.getAppPath(), "scripts", "deepseek-runtime.cordis.yml");
}

function cliLifecycleHelperTemplatePath() {
  return app.isPackaged
    ? join(process.resourcesPath, "scripts", "cli-lifecycle-hook.ps1")
    : join(app.getAppPath(), "scripts", "cli-lifecycle-hook.ps1");
}

function normalizeCliProfiles(value: unknown): CliProfile[] {
  if (!Array.isArray(value)) return [];
  const profiles: CliProfile[] = [];
  const ids = new Set<string>();
  for (const candidate of value.slice(0, 24)) {
    if (!candidate || typeof candidate !== "object") continue;
    const profile = candidate as Partial<CliProfile>;
    const id = typeof profile.id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,119}$/.test(profile.id) ? profile.id : "";
    const name = typeof profile.name === "string" ? profile.name.trim().slice(0, 80) : "";
    const command = typeof profile.command === "string" ? profile.command.trim().slice(0, 4096) : "";
    const args = Array.isArray(profile.args)
      ? profile.args.filter((arg): arg is string => typeof arg === "string" && arg.length <= 4096 && !/[\r\n]/.test(arg)).slice(0, 64)
      : [];
    if (!id || ids.has(id) || !name || !command || /[\r\n]/.test(command)) continue;
    ids.add(id);
    profiles.push({
      id,
      name,
      command,
      args,
      cwd: typeof profile.cwd === "string" && isDirectory(profile.cwd) ? resolve(profile.cwd) : undefined,
      icon: profile.icon === "code" || profile.icon === "server" ? profile.icon : "terminal",
    });
  }
  return profiles;
}

function normalizeAppSettings(value: Partial<AppSettings> | null | undefined): AppSettings {
  const opacity = typeof value?.backgroundOpacity === "number" && Number.isFinite(value.backgroundOpacity)
    ? Math.max(0.35, Math.min(1, value.backgroundOpacity))
    : DEFAULT_SETTINGS.backgroundOpacity;
  return {
    closeBehavior: value?.closeBehavior === "quit" ? "quit" : "tray",
    notifyOnCompletion: value?.notifyOnCompletion !== false,
    language: value?.language === "zh-CN" || value?.language === "en-US" ? value.language : "system",
    theme: typeof value?.theme === "string" && VALID_THEMES.has(value.theme) ? value.theme as AppSettings["theme"] : "nebula",
    backgroundBlur: value?.backgroundBlur === true,
    backgroundImage: typeof value?.backgroundImage === "string" && isImagePath(value.backgroundImage) ? value.backgroundImage : undefined,
    backgroundOpacity: opacity,
    restoreTerminalTabs: value?.restoreTerminalTabs !== false,
    resizablePanels: value?.resizablePanels === true,
    completionEnabled: value?.completionEnabled !== false,
    copyOnSelect: value?.copyOnSelect !== false,
    powerlinePrompt: value?.powerlinePrompt !== false,
    quickTerminal: value?.quickTerminal !== false,
    shellStartupIntegration: value?.shellStartupIntegration === true,
    defaultShellId: typeof value?.defaultShellId === "string" && /^[a-zA-Z0-9:_-]{1,120}$/.test(value.defaultShellId)
      ? value.defaultShellId
      : "powershell",
    cursorStyle: value?.cursorStyle === "block" || value?.cursorStyle === "underline" ? value.cursorStyle : "bar",
    cursorBlink: value?.cursorBlink !== false,
    bellSound: value?.bellSound !== false,
    loadShellProfile: value?.loadShellProfile === true,
    cliProfiles: normalizeCliProfiles(value?.cliProfiles),
  };
}

function applyWindowAppearance(window: BrowserWindow) {
  const titleBarThemes: Record<AppSettings["theme"], { color: string; symbolColor: string }> = {
    nebula: { color: "#171a21", symbolColor: "#d8dee9" },
    silver: { color: "#eaedef", symbolColor: "#262a2e" },
    steel: { color: "#272d33", symbolColor: "#e2e7eb" },
    limestone: { color: "#ebe9e3", symbolColor: "#302f2b" },
    coal: { color: "#252522", symbolColor: "#e7e4dc" },
    linen: { color: "#eeeae1", symbolColor: "#34312c" },
    moss: { color: "#232924", symbolColor: "#e3e7de" },
  };
  const light = appSettings.theme === "silver" || appSettings.theme === "limestone" || appSettings.theme === "linen";
  const titleBarTheme = titleBarThemes[appSettings.theme];
  window.setTitleBarOverlay({
    color: titleBarTheme.color,
    symbolColor: titleBarTheme.symbolColor,
    height: 44,
  });
  window.setBackgroundColor(light ? "#f7f7f5" : "#181a17");
  if (process.platform === "win32") {
    try { window.setBackgroundMaterial(appSettings.backgroundBlur ? "mica" : "none"); } catch { /* Unsupported Windows builds ignore blur. */ }
  }
}

function updateQuickTerminalShortcut() {
  globalShortcut.unregister("CommandOrControl+`");
  if (!appSettings.quickTerminal) return;
  globalShortcut.register("CommandOrControl+`", () => {
    const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createWindow();
    if (window.isVisible() && window.isFocused()) {
      window.hide();
      return;
    }
    showMainWindow();
    const send = () => window.webContents.send("terminal:quick-open");
    if (window.webContents.isLoading()) window.webContents.once("did-finish-load", send);
    else send();
  });
}

async function loadSettings() {
  try {
    const value = JSON.parse(await readFile(settingsPath(), "utf8")) as Partial<AppSettings>;
    appSettings = normalizeAppSettings(value);
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

function isExistingPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) return false;
  try {
    const details = statSync(value);
    return details.isDirectory() || details.isFile();
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

function terminalSnapshotsPath() {
  return join(app.getPath("userData"), "terminal-sessions.json");
}

function terminalRuntimeStatePath() {
  return join(app.getPath("userData"), "terminal-runtime.json");
}

function initializeTerminalCrashGuard() {
  let failures = 0;
  try {
    const previous = JSON.parse(readFileSync(terminalRuntimeStatePath(), "utf8")) as { cleanExit?: boolean; failures?: number };
    failures = previous.cleanExit === false ? Math.max(0, Number(previous.failures) || 0) + 1 : 0;
  } catch {
    failures = 0;
  }
  if (failures >= 3 && existsSync(terminalSnapshotsPath())) {
    const quarantine = join(dirname(terminalSnapshotsPath()), `terminal-sessions.crashed-${Date.now()}.json`);
    try {
      renameSync(terminalSnapshotsPath(), quarantine);
      terminalRestoreQuarantined = true;
      failures = 0;
    } catch {
      // An unreadable snapshot is already ignored by the restore path.
    }
  }
  try {
    writeFileSync(terminalRuntimeStatePath(), JSON.stringify({ cleanExit: false, failures, startedAt: Date.now() }, null, 2), "utf8");
  } catch {
    // Crash recovery remains best-effort on read-only profiles.
  }
}

function markTerminalRuntimeClean() {
  try {
    writeFileSync(terminalRuntimeStatePath(), JSON.stringify({ cleanExit: true, failures: 0, exitedAt: Date.now() }, null, 2), "utf8");
  } catch {
    // Shutdown must continue even when the state file is locked.
  }
}

function terminalInfo(session: TerminalSession): TerminalInfo {
  return {
    id: session.id,
    title: session.title,
    cwd: session.cwd,
    shell: session.shell,
    shellId: session.shellId,
    profileId: session.profileId,
    kind: session.kind,
    remoteHost: session.remoteHost,
    activity: session.activity,
    activeCommand: session.activeCommand,
    lastCommandDuration: session.lastCommandDuration,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    cols: session.cols,
    rows: session.rows,
  };
}

function sendTerminalMeta(session: TerminalSession) {
  sendTerminalEvent(session, { type: "meta", terminal: terminalInfo(session) });
}

function sendTerminalEvent(session: TerminalSession, event: Omit<TerminalEvent, "sessionId">) {
  for (const id of [...session.subscribers]) {
    const target = webContents.fromId(id);
    if (!target || target.isDestroyed()) {
      session.subscribers.delete(id);
      continue;
    }
    target.send("terminal:event", { sessionId: session.id, ...event } satisfies TerminalEvent);
  }
}

function flushTerminalOutput(session: TerminalSession) {
  if (session.flushTimer) clearTimeout(session.flushTimer);
  session.flushTimer = undefined;
  if (!session.pending) return;
  const data = session.pending;
  session.pending = "";
  sendTerminalEvent(session, { type: "data", data });
}

function notifyTerminalAttention(session: TerminalSession, message = "Attention requested", completion = false) {
  sendTerminalEvent(session, { type: "bell" });
  if (appSettings.bellSound) {
    try { shell.beep(); } catch { /* Some Linux desktop environments do not expose a system bell. */ }
  }
  if (!appSettings.notifyOnCompletion || !Notification.isSupported()) return;
  if (mainWindow?.isVisible() && mainWindow.isFocused()) return;
  const notification = new Notification({
    title: completion ? `${session.title} completed` : `${session.title} needs attention`,
    body: message,
    silent: true,
  });
  notification.on("click", () => {
    showMainWindow();
    sendTerminalEvent(session, { type: "focus" });
  });
  notification.show();
}

function handleCliLifecycleEvent(event: CliLifecycleEvent) {
  const session = event.sessionId ? terminalSessions.get(event.sessionId) : undefined;
  const source = event.source === "claude" ? "Claude Code" : "Codex";
  if (event.kind === "started") {
    if (session) {
      session.activity = "running";
      session.updatedAt = Date.now();
      sendTerminalMeta(session);
    }
    return;
  }

  const completion = event.kind === "done";
  const message = event.message || (completion ? "Turn completed and waiting for input" : "Your input is required");
  if (session) {
    session.activity = "attention";
    session.updatedAt = Date.now();
    sendTerminalMeta(session);
    notifyTerminalAttention(session, message, completion);
    return;
  }

  if (!appSettings.notifyOnCompletion || !Notification.isSupported()) return;
  if (mainWindow?.isVisible() && mainWindow.isFocused()) return;
  const notification = new Notification({
    title: completion ? `${source} completed` : `${source} needs attention`,
    body: message,
    silent: true,
  });
  notification.on("click", () => showMainWindow());
  notification.show();
}

function finishTerminalCommand(session: TerminalSession) {
  if (!session.commandStartedAt) return;
  const duration = Date.now() - session.commandStartedAt;
  const command = session.activeCommand || "Command";
  session.lastCommandDuration = duration;
  session.commandStartedAt = undefined;
  session.activeCommand = undefined;
  session.activity = "idle";
  sendTerminalMeta(session);
  if (duration >= 8_000) notifyTerminalAttention(session, `${command} (${Math.round(duration / 1000)}s)`, true);
}

function updateTerminalCwd(session: TerminalSession, data: string) {
  for (const match of data.matchAll(/\x1b\]7;file:\/\/[^/]*(\/[^\x07\x1b]*)[\x07\x1b\\]/g)) {
    try {
      let candidate = decodeURIComponent(match[1]);
      if (process.platform === "win32" && /^\/[a-zA-Z]:\//.test(candidate)) candidate = candidate.slice(1);
      candidate = candidate.replaceAll("/", sep);
      if (isDirectory(candidate)) session.cwd = resolve(candidate);
    } catch {
      // Invalid OSC 7 paths are ignored.
    }
  }
}

function appendTerminalOutput(session: TerminalSession, data: string) {
  session.updatedAt = Date.now();
  updateTerminalCwd(session, data);
  session.history = `${session.history}${data}`.slice(-MAX_TERMINAL_HISTORY);
  session.pending = `${session.pending}${data}`.slice(-MAX_TERMINAL_INPUT);
  if (data.includes("\u0007") && Date.now() - session.lastBellAt > 1_500) {
    session.lastBellAt = Date.now();
    notifyTerminalAttention(session);
  }
  if (/\x1b\]133;D(?:;[^\x07]*)?\x07/.test(data) || /\x1b\]133;A\x07/.test(data)) finishTerminalCommand(session);
  const plain = data.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  if (session.activity === "running" && /(?:do you want to continue|needs? your (?:input|approval)|press enter|\[[yY]\/[nN]\]|allow this command)/i.test(plain)) {
    session.activity = "attention";
    sendTerminalMeta(session);
    if (Date.now() - session.lastBellAt > 1_500) {
      session.lastBellAt = Date.now();
      notifyTerminalAttention(session, plain.trim().slice(-180) || "Input requested");
    }
  }
  if (session.pending.length >= MAX_TERMINAL_INPUT) flushTerminalOutput(session);
  else if (!session.flushTimer) session.flushTimer = setTimeout(() => flushTerminalOutput(session), 16);
}

function queueTerminalSnapshotSave() {
  if (isQuitting) return;
  const snapshots: TerminalSnapshot[] = (appSettings.restoreTerminalTabs ? [...terminalSessions.values()] : [])
    .filter((session) => session.status === "running")
    .map((session) => ({
      id: session.id,
      title: session.title,
      cwd: session.cwd,
      cols: session.cols,
      rows: session.rows,
      shellId: session.shellId,
      profileId: session.profileId,
      sshProfileId: session.sshProfileId,
    }));
  terminalSaveQueue = terminalSaveQueue.then(async () => {
    const path = terminalSnapshotsPath();
    const temporary = `${path}.tmp`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporary, JSON.stringify({ version: 1, sessions: snapshots }, null, 2), "utf8");
    try {
      await rename(temporary, path);
    } catch {
      await writeFile(path, JSON.stringify({ version: 1, sessions: snapshots }, null, 2), "utf8");
    }
  }).catch(() => undefined);
}

function terminalDimension(value: unknown, fallback: number, maximum: number) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= maximum ? value : fallback;
}

function terminalEnvironment(sessionId: string) {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) environment[key] = value;
  }
  environment.TERM = "xterm-256color";
  environment.COLORTERM = "truecolor";
  environment.CODEX_UI_TERMINAL = "1";
  environment.CODEX_UI_SESSION_ID = sessionId;
  if (cliLifecycleBridge) environment.CODEX_UI_NOTIFY_PIPE = cliLifecycleBridge.getPipeName();
  environment.CODEX_UI_POWERLINE = appSettings.powerlinePrompt ? "1" : "0";
  return environment;
}

function terminalIntegrationScriptPath() {
  return join(app.getPath("userData"), "codex-ui-terminal-profile.ps1");
}

async function prepareTerminalIntegration() {
  const script = [
    "$global:CodexUiPromptReady = $false",
    "function global:prompt {",
    "  $exitCode = $global:LASTEXITCODE",
    "  if ($global:CodexUiPromptReady) { [Console]::Write(\"$([char]27)]133;D;$exitCode$([char]7)\") }",
    "  $global:CodexUiPromptReady = $true",
    "  $uriPath = ($pwd.Path -replace '\\\\', '/')",
    "  [Console]::Write(\"$([char]27)]7;file:///$uriPath$([char]7)\")",
    "  [Console]::Write(\"$([char]27)]133;A$([char]7)\")",
    "  if ($env:CODEX_UI_POWERLINE -eq '1') {",
    "    $branch = ''",
    "    try { $branch = (& git branch --show-current 2>$null) } catch {}",
    "    $clock = Get-Date -Format 'HH:mm'",
    "    $gitPart = if ($branch) { \" $branch\" } else { '' }",
    "    return \"$([char]27)[48;2;50;72;58m$([char]27)[38;2;238;241;235m $($pwd.Path) $([char]27)[48;2;77;106;86m$gitPart $([char]27)[48;2;34;37;33m $clock $([char]27)[0m `r`n> \"",
    "  }",
    "  return \"PS $($pwd.Path)> \"",
    "}",
  ].join("\r\n");
  await mkdir(dirname(terminalIntegrationScriptPath()), { recursive: true });
  await writeFile(terminalIntegrationScriptPath(), script, "utf8");
}

function execFileText(file: string, args: string[], options: Parameters<typeof execFile>[2] = {}) {
  return new Promise<{ stdout: string; stderr: string }>((resolveResult, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 12_000, maxBuffer: 2 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolveResult({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function detectTerminalShells() {
  const profiles: DetectedShell[] = [];
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    const integration = terminalIntegrationScriptPath();
    const pwsh = join(programFiles, "PowerShell", "7", "pwsh.exe");
    if (existsSync(pwsh)) profiles.push({ id: "pwsh", label: "PowerShell 7", command: pwsh, args: ["-NoLogo", "-NoProfile", "-NoExit", "-File", integration], kind: "powershell" });
    const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    if (existsSync(powershell)) profiles.push({ id: "powershell", label: "Windows PowerShell", command: powershell, args: ["-NoLogo", "-NoProfile", "-NoExit", "-File", integration], kind: "powershell" });
    const cmd = process.env.COMSPEC || join(systemRoot, "System32", "cmd.exe");
    if (existsSync(cmd)) profiles.push({ id: "cmd", label: "Command Prompt", command: cmd, args: ["/Q"], kind: "cmd" });
    const gitBash = join(programFiles, "Git", "bin", "bash.exe");
    if (existsSync(gitBash)) profiles.push({ id: "git-bash", label: "Git Bash", command: gitBash, args: ["--noprofile", "--norc", "-i"], kind: "git-bash" });
    const wsl = join(systemRoot, "System32", "wsl.exe");
    if (existsSync(wsl)) {
      try {
        const { stdout } = await execFileText(wsl, ["--list", "--quiet"]);
        for (const distro of stdout.replaceAll("\0", "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
          const id = `wsl:${Buffer.from(distro).toString("base64url")}`;
          profiles.push({ id, label: distro, detail: "WSL", command: wsl, args: ["--distribution", distro], kind: "wsl" });
        }
      } catch {
        // WSL is optional.
      }
    }
  } else {
    const shell = process.env.SHELL || "/bin/bash";
    profiles.push({ id: "shell", label: basename(shell), command: shell, args: ["--noprofile"], kind: "custom" });
  }
  detectedShells = profiles.length ? profiles : [{ id: "shell", label: "Shell", command: process.env.SHELL || "powershell.exe", args: [], kind: "custom" }];
}

function selectedShell(id?: string) {
  return detectedShells.find((profile) => profile.id === id)
    || detectedShells.find((profile) => profile.id === appSettings.defaultShellId)
    || detectedShells[0];
}

function resolveCliExecutable(command: string) {
  const unquoted = command.replace(/^"|"$/g, "");
  if (isAbsolute(unquoted)) return existsSync(unquoted) ? unquoted : null;
  if (/[\\/]/.test(unquoted)) {
    const candidate = resolve(unquoted);
    return existsSync(candidate) ? candidate : null;
  }
  const extensions = process.platform === "win32" && !extname(unquoted)
    ? [".exe", ".cmd", ".bat", ""]
    : [""];
  const roots = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":").filter(Boolean);
  if (process.platform === "win32" && process.env.APPDATA) roots.unshift(join(process.env.APPDATA, "npm"));
  for (const root of roots) {
    for (const extension of extensions) {
      const candidate = join(root.replace(/^"|"$/g, ""), `${unquoted}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function cliProfileById(id?: string) {
  if (!id) return undefined;
  return BUILTIN_CLI_TOOLS.find((profile) => profile.id === id)
    || appSettings.cliProfiles.find((profile) => profile.id === id);
}

function cliToolsInfo(): CliToolInfo[] {
  const customIds = new Set(BUILTIN_CLI_TOOLS.map((profile) => profile.id));
  const custom = appSettings.cliProfiles.filter((profile) => !customIds.has(profile.id));
  return [
    ...BUILTIN_CLI_TOOLS.map((profile) => {
      const executable = (profile.id === "builtin:codex" ? findCodexExecutable() : resolveCliExecutable(profile.command)) || undefined;
      const available = Boolean(executable && (isAbsolute(executable) ? existsSync(executable) : resolveCliExecutable(executable)));
      return { ...profile, builtIn: true, available, executable: available ? executable : undefined };
    }),
    ...custom.map((profile) => {
      const executable = resolveCliExecutable(profile.command);
      return { ...profile, description: "Custom CLI profile", builtIn: false, available: Boolean(executable), executable: executable || undefined };
    }),
  ];
}

function quoteCliArgument(value: string, shellKind: DetectedShell["kind"]) {
  if (shellKind === "powershell") return `'${value.replaceAll("'", "''")}'`;
  if (shellKind === "cmd") return `"${value.replaceAll('"', '\\"')}"`;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function cliCommandLine(profile: CliProfile, shellKind: DetectedShell["kind"]) {
  const executable = profile.id === "builtin:codex" ? findCodexExecutable() : resolveCliExecutable(profile.command) || profile.command;
  const parts = [executable, ...profile.args].map((value) => quoteCliArgument(value, shellKind));
  return shellKind === "powershell" ? `& ${parts.join(" ")}` : parts.join(" ");
}

function sshExecutable() {
  if (process.platform === "win32") {
    const candidate = join(process.env.SystemRoot || "C:\\Windows", "System32", "OpenSSH", "ssh.exe");
    if (existsSync(candidate)) return candidate;
  }
  return "ssh";
}

function sshArguments(profile: SshProfile, batchMode = false) {
  const args = ["-p", String(profile.port || 22)];
  if (batchMode) args.push("-o", "BatchMode=yes", "-o", "ConnectTimeout=8");
  if (profile.identityFile) args.push("-i", profile.identityFile);
  args.push(`${profile.username ? `${profile.username}@` : ""}${profile.host}`);
  return args;
}

function commandHistoryPath() {
  return join(app.getPath("userData"), "terminal-history.jsonl");
}

function recordTerminalCommand(session: TerminalSession, command: string) {
  const record = JSON.stringify({ command, cwd: session.cwd, at: Date.now() });
  void mkdir(dirname(commandHistoryPath()), { recursive: true })
    .then(() => appendFile(commandHistoryPath(), `${record}\n`, "utf8"))
    .catch(() => undefined);
}

function trackTerminalInput(session: TerminalSession, data: string) {
  for (const character of data) {
    if (character === "\r" || character === "\n") {
      const command = session.inputBuffer.trim();
      session.inputBuffer = "";
      if (!command) continue;
      session.activeCommand = command.slice(0, 180);
      session.commandStartedAt = Date.now();
      session.activity = "running";
      recordTerminalCommand(session, command);
      sendTerminalMeta(session);
    } else if (character === "\x7f" || character === "\b") {
      session.inputBuffer = session.inputBuffer.slice(0, -1);
    } else if (character === "\x03") {
      session.inputBuffer = "";
      finishTerminalCommand(session);
    } else if (character >= " " && character !== "\x1b") {
      session.inputBuffer = `${session.inputBuffer}${character}`.slice(-4096);
    }
  }
}

function loadPtyModule() {
  ptyModule ??= require("node-pty") as typeof import("node-pty");
  return ptyModule;
}

function createTerminalSession(
  owner: Electron.WebContents,
  request: TerminalCreateRequest,
  restored?: TerminalSnapshot,
) {
  if (terminalSessions.size >= MAX_TERMINALS) throw new Error(`终端数量不能超过 ${MAX_TERMINALS} 个`);
  const profileId = request.profileId || restored?.profileId;
  const cliProfile = cliProfileById(profileId);
  if (request.profileId && !cliProfile) throw new Error("CLI profile not found");
  const builtinProfile = cliProfile && BUILTIN_CLI_TOOLS.find((profile) => profile.id === cliProfile.id);
  if (builtinProfile && !resolveCliExecutable(cliProfile.command) && cliProfile.id !== "builtin:codex") {
    throw new Error(`未找到 ${cliProfile.name}。安装命令：${builtinProfile.installCommand}`);
  }
  const cwd = resolve(cliProfile?.cwd || request.cwd);
  const cols = terminalDimension(request.cols, 100, 400);
  const rows = terminalDimension(request.rows, 30, 200);
  const sshProfileId = request.sshProfileId || restored?.sshProfileId;
  const sshProfile = sshProfileId ? sshProfiles.find((profile) => profile.id === sshProfileId) : undefined;
  if (sshProfileId && !sshProfile) throw new Error("SSH profile not found");
  if (sshProfile && cliProfile) throw new Error("CLI profile cannot be combined with SSH");
  const shellProfile = selectedShell(request.shellId || restored?.shellId);
  const shellPath = sshProfile ? sshExecutable() : shellProfile.command;
  const shellArgs = sshProfile ? sshArguments(sshProfile) : terminalShellArguments(shellProfile, cwd, appSettings.loadShellProfile);
  const id = restored?.id && UUID_PATTERN.test(restored.id) ? restored.id : randomUUID();
  const terminal = loadPtyModule().spawn(shellPath, shellArgs, {
    name: "xterm-256color",
    cwd,
    env: terminalEnvironment(id),
    cols,
    rows,
    useConpty: process.platform === "win32",
  });
  const now = Date.now();
  const session: TerminalSession = {
    id,
    title: request.title?.trim().slice(0, 120) || restored?.title?.trim().slice(0, 120) || cliProfile?.name || sshProfile?.name || terminalTitleFromPath(cwd),
    cwd,
    shell: basename(shellPath),
    shellId: sshProfile ? `ssh:${sshProfile.id}` : shellProfile.id,
    profileId: cliProfile?.id,
    kind: sshProfile ? "ssh" : "local",
    remoteHost: sshProfile ? `${sshProfile.username ? `${sshProfile.username}@` : ""}${sshProfile.host}` : undefined,
    sshProfileId: sshProfile?.id,
    activity: "idle",
    inputBuffer: "",
    pty: terminal,
    status: "running",
    createdAt: now,
    updatedAt: now,
    cols,
    rows,
    history: "",
    pending: "",
    subscribers: new Set([owner.id]),
    lastBellAt: 0,
  };
  terminalSessions.set(session.id, session);
  terminal.onData((data) => appendTerminalOutput(session, data));
  terminal.onExit(({ exitCode }) => {
    flushTerminalOutput(session);
    session.status = "exited";
    session.updatedAt = Date.now();
    sendTerminalEvent(session, { type: "exit", code: exitCode });
    if (!isQuitting) queueTerminalSnapshotSave();
  });
  if (cliProfile) {
    const command = cliCommandLine(cliProfile, shellProfile.kind);
    setTimeout(() => {
      if (session.status !== "running") return;
      trackTerminalInput(session, `${command}\r`);
      terminal.write(`${command}\r`);
    }, 80);
  }
  queueTerminalSnapshotSave();
  return session;
}

async function restoreTerminalSessions(owner: Electron.WebContents) {
  terminalRestorePromise ??= (async () => {
    if (!appSettings.restoreTerminalTabs || terminalRestoreQuarantined) return;
    try {
      const value = JSON.parse(await readFile(terminalSnapshotsPath(), "utf8")) as { version?: number; sessions?: TerminalSnapshot[] };
      if (value.version !== 1 || !Array.isArray(value.sessions)) return;
      for (const snapshot of value.sessions.slice(0, MAX_TERMINALS)) {
        if (!snapshot || !UUID_PATTERN.test(snapshot.id) || !isDirectory(snapshot.cwd) || terminalSessions.has(snapshot.id)) continue;
        try {
          createTerminalSession(owner, {
            cwd: snapshot.cwd,
            cols: terminalDimension(snapshot.cols, 100, 400),
            rows: terminalDimension(snapshot.rows, 30, 200),
          }, snapshot);
        } catch {
          // One invalid snapshot must not prevent the remaining terminals from restoring.
        }
      }
    } catch {
      // Terminal snapshots are optional on first launch.
    }
  })();
  await terminalRestorePromise;
}

function isPathWithin(root: string, target: string) {
  const difference = relative(resolve(root), resolve(target));
  return difference === "" || (difference !== ".." && !difference.startsWith(`..${sep}`) && !isAbsolute(difference));
}

async function listDirectoryEntries(rootValue: string, pathValue: string): Promise<FileSystemEntry[]> {
  const lexicalRoot = resolve(rootValue);
  const lexicalTarget = resolve(pathValue);
  if (!isDirectory(lexicalRoot) || !isDirectory(lexicalTarget) || !isPathWithin(lexicalRoot, lexicalTarget)) return [];
  const [root, target] = await Promise.all([realpath(lexicalRoot), realpath(lexicalTarget)]);
  if (!isPathWithin(root, target)) return [];
  const entries = (await readdir(target, { withFileTypes: true, encoding: "utf8" })).slice(0, 500);
  const results = await Promise.all(entries.map(async (entry) => {
    const path = join(target, entry.name);
    let details: Awaited<ReturnType<typeof lstat>> | null = null;
    try { details = await lstat(path); } catch { /* Entry disappeared while listing. */ }
    return {
      name: entry.name,
      path,
      type: entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "link" : "file",
      size: details?.size,
      modifiedAt: details?.mtimeMs,
    } satisfies FileSystemEntry;
  }));
  return results.sort((left, right) => {
    if (left.type === "directory" && right.type !== "directory") return -1;
    if (left.type !== "directory" && right.type === "directory") return 1;
    return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  });
}

async function readWorkspaceDocument(rootValue: string, pathValue: string): Promise<DocumentFile | null> {
  const lexicalRoot = resolve(rootValue);
  const lexicalTarget = resolve(pathValue);
  if (!isDirectory(lexicalRoot) || !isPathWithin(lexicalRoot, lexicalTarget)) return null;
  const [root, target] = await Promise.all([realpath(lexicalRoot), realpath(lexicalTarget)]);
  if (!isPathWithin(root, target)) return null;
  const details = await stat(target);
  if (!details.isFile() || details.size > MAX_DOCUMENT_BYTES) return null;
  const extension = extname(target).toLowerCase();
  const kind: DocumentFile["kind"] = extension === ".md" || extension === ".markdown"
    ? "markdown"
    : extension === ".json"
      ? "json"
      : "text";
  if (![".md", ".markdown", ".json", ".txt", ".log", ".ini", ".toml", ".yaml", ".yml"].includes(extension)) return null;
  let content = await readFile(target, "utf8");
  if (kind === "json") {
    try { content = JSON.stringify(JSON.parse(content), null, 2); } catch { /* Invalid JSON remains readable as text. */ }
  }
  return { path: target, name: basename(target), kind, content, size: details.size, modifiedAt: details.mtimeMs };
}

function sshProfilesPath() {
  return join(app.getPath("userData"), "ssh-profiles.json");
}

function normalizeSshProfile(value: Partial<SshProfile>, preserveId = true): SshProfile {
  const host = typeof value.host === "string" ? value.host.trim() : "";
  const username = typeof value.username === "string" ? value.username.trim() : "";
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!host || host.length > 255 || /[\r\n\0]/.test(host)) throw new Error("Invalid SSH host");
  if (username.length > 128 || /[\r\n\0]/.test(username)) throw new Error("Invalid SSH username");
  const port = Number.isInteger(value.port) && Number(value.port) > 0 && Number(value.port) <= 65535 ? Number(value.port) : 22;
  const identityFile = typeof value.identityFile === "string" && value.identityFile.trim()
    ? resolve(value.identityFile.trim().replace(/^~(?=[\\/])/, homedir()))
    : undefined;
  const remotePath = typeof value.remotePath === "string" && value.remotePath.trim() ? value.remotePath.trim().slice(0, 4096) : undefined;
  const now = Date.now();
  return {
    id: preserveId && typeof value.id === "string" && /^[a-zA-Z0-9:_-]{1,180}$/.test(value.id) ? value.id : randomUUID(),
    name: (name || host).slice(0, 120),
    host,
    port,
    username,
    identityFile,
    remotePath,
    createdAt: typeof value.createdAt === "number" ? value.createdAt : now,
    updatedAt: now,
    source: value.source === "ssh-config" ? "ssh-config" : "saved",
  };
}

async function discoverSshConfigProfiles() {
  try {
    const config = await readFile(join(homedir(), ".ssh", "config"), "utf8");
    const profiles: SshProfile[] = [];
    let current: Partial<SshProfile> | null = null;
    const push = () => {
      if (!current?.host || current.host.includes("*") || current.host.includes("?")) return;
      try {
        profiles.push(normalizeSshProfile({
          ...current,
          id: `config:${Buffer.from(current.host).toString("base64url")}`,
          name: current.host,
          source: "ssh-config",
        }));
      } catch { /* Ignore malformed blocks in ssh_config. */ }
    };
    for (const rawLine of config.split(/\r?\n/)) {
      const line = rawLine.replace(/\s+#.*$/, "").trim();
      if (!line) continue;
      const [rawKey, ...parts] = line.split(/\s+/);
      const key = rawKey.toLowerCase();
      const value = parts.join(" ");
      if (key === "host") {
        push();
        current = { host: value.split(/\s+/)[0], port: 22, username: "" };
      } else if (current && key === "user") current.username = value;
      else if (current && key === "port") current.port = Number(value);
      else if (current && key === "identityfile") current.identityFile = value;
    }
    push();
    return profiles;
  } catch {
    return [];
  }
}

async function loadSshProfiles() {
  let saved: SshProfile[] = [];
  try {
    const value = JSON.parse(await readFile(sshProfilesPath(), "utf8")) as { profiles?: Partial<SshProfile>[] };
    saved = (value.profiles || []).slice(0, 100).map((profile) => normalizeSshProfile(profile)).filter(Boolean);
  } catch {
    saved = [];
  }
  const discovered = await discoverSshConfigProfiles();
  const savedHosts = new Set(saved.map((profile) => profile.host.toLowerCase()));
  sshProfiles = [...saved, ...discovered.filter((profile) => !savedHosts.has(profile.host.toLowerCase()))];
}

async function persistSshProfiles() {
  const saved = sshProfiles.filter((profile) => profile.source !== "ssh-config");
  const path = sshProfilesPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ version: 1, profiles: saved }, null, 2), "utf8");
}

async function testSshConnection(value: Partial<SshProfile>): Promise<SshTestResult> {
  const stages: SshConnectionStage[] = ["resolve", "tcp", "authenticate", "session"].map((name) => ({ name: name as SshConnectionStage["name"], status: "pending" }));
  let profile: SshProfile;
  try { profile = normalizeSshProfile(value); } catch (reason) {
    stages[0] = { ...stages[0], status: "error", message: reason instanceof Error ? reason.message : "Invalid profile" };
    return { ok: false, stages, error: stages[0].message };
  }
  try {
    stages[0].status = "running";
    await execFileText(sshExecutable(), ["-G", ...sshArguments(profile).slice(0, -1), sshArguments(profile).at(-1)!]);
    stages[0] = { ...stages[0], status: "done", message: profile.host };
    stages[1].status = "running";
    const args = [...sshArguments(profile, true), "printf CODEX_UI_SSH_OK"];
    const { stdout } = await execFileText(sshExecutable(), args, { timeout: 12_000 });
    stages[1] = { ...stages[1], status: "done" };
    stages[2] = { ...stages[2], status: "done" };
    stages[3] = { ...stages[3], status: stdout.includes("CODEX_UI_SSH_OK") ? "done" : "error" };
    return { ok: stages[3].status === "done", stages, error: stages[3].status === "done" ? undefined : "Remote session did not answer" };
  } catch (reason) {
    const message = reason instanceof Error ? String((reason as Error & { stderr?: string }).stderr || reason.message) : "SSH connection failed";
    if (/permission denied|authentication/i.test(message)) {
      stages[1] = { ...stages[1], status: "done" };
      stages[2] = { ...stages[2], status: "error", message: message.trim() };
    } else {
      stages[1] = { ...stages[1], status: "error", message: message.trim() };
    }
    return { ok: false, stages, error: message.trim() };
  }
}

function isAuthorizedTerminalRoot(senderId: number, root: string) {
  const expected = normalizePath(root);
  return [...terminalSessions.values()].some((session) => (
    session.subscribers.has(senderId) && normalizePath(session.cwd) === expected
  ));
}

function gitStatus(path: string) {
  return new Promise<GitStatus>((resolveStatus) => {
    execFile("git", ["-C", path, "status", "--short", "--branch"], { windowsHide: true, timeout: 7_000, maxBuffer: 512 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        resolveStatus({ available: false, branch: "", entries: [], error: stderr.trim() || error.message });
        return;
      }
      const lines = stdout.split(/\r?\n/).filter(Boolean);
      const branch = lines[0]?.startsWith("## ") ? lines.shift()!.slice(3).split("...")[0] : "";
      resolveStatus({
        available: true,
        branch,
        entries: lines.map((line) => ({ status: line.slice(0, 2).trim() || "?", path: line.slice(3) })).filter((entry) => entry.path),
      });
    });
  });
}

async function runGitOperation(request: GitActionRequest): Promise<OperationResult> {
  const paths = (request.paths || []).slice(0, 500).filter((path) => typeof path === "string" && path.length > 0 && path.length < 4096 && !/[\r\n\0]/.test(path));
  let args: string[];
  switch (request.action) {
    case "stage":
      args = paths.length ? ["add", "--", ...paths] : ["add", "-A"];
      break;
    case "unstage":
      args = paths.length ? ["restore", "--staged", "--", ...paths] : ["reset", "--mixed", "HEAD"];
      break;
    case "commit": {
      const message = request.message?.trim();
      if (!message || message.length > 5_000) return { ok: false, message: "Commit message is required" };
      args = ["commit", "-m", message];
      break;
    }
    case "pull":
      args = ["pull", "--ff-only"];
      break;
    case "push":
      args = ["push"];
      break;
    default:
      return { ok: false, message: "Unsupported Git action" };
  }
  try {
    const { stdout, stderr } = await execFileText("git", ["-C", request.root, ...args], { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
    return { ok: true, message: (stdout || stderr || `${request.action} completed`).trim() };
  } catch (reason) {
    const error = reason as Error & { stdout?: string; stderr?: string };
    return { ok: false, message: String(error.stderr || error.stdout || error.message).trim() };
  }
}

function sftpExecutable() {
  if (process.platform === "win32") {
    const candidate = join(process.env.SystemRoot || "C:\\Windows", "System32", "OpenSSH", "sftp.exe");
    if (existsSync(candidate)) return candidate;
  }
  return "sftp";
}

function quoteSftpPath(value: string) {
  if (!value || value.length > 4096 || /[\r\n\0]/.test(value)) throw new Error("Invalid remote path");
  return `"${value.replace(/(["\\])/g, "\\$1")}"`;
}

function runSftpBatch(profile: SshProfile, commands: string[], timeout = 60_000) {
  return new Promise<{ stdout: string; stderr: string }>((resolveResult, reject) => {
    const args = ["-b", "-", "-P", String(profile.port || 22), "-o", "BatchMode=yes"];
    if (profile.identityFile) args.push("-i", profile.identityFile);
    args.push(`${profile.username ? `${profile.username}@` : ""}${profile.host}`);
    const child = spawn(sftpExecutable(), args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), timeout);
    child.stdout?.on("data", (chunk: Buffer) => { stdout = `${stdout}${chunk.toString("utf8")}`.slice(-4 * 1024 * 1024); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4 * 1024 * 1024); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolveResult({ stdout, stderr });
      else reject(Object.assign(new Error(stderr.trim() || `sftp exited ${code}`), { stdout, stderr }));
    });
    child.stdin?.end(`${commands.join("\n")}\nbye\n`, "utf8");
  });
}

async function listSftpEntries(profile: SshProfile, path: string): Promise<SftpEntry[]> {
  const { stdout } = await runSftpBatch(profile, [`ls -la ${quoteSftpPath(path)}`]);
  const entries: SftpEntry[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^([dl-])[rwxstST-]{9}\s+\d+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s+(.+)$/);
    if (!match) continue;
    const name = match[3].replace(/\s+->\s+.*$/, "");
    if (name === "." || name === "..") continue;
    entries.push({
      name,
      path: `${path.replace(/\/$/, "")}/${name}` || `/${name}`,
      type: match[1] === "d" ? "directory" : match[1] === "l" ? "link" : "file",
      size: Number(match[2]),
    });
  }
  return entries.sort((left, right) => left.type === right.type ? left.name.localeCompare(right.name) : left.type === "directory" ? -1 : 1);
}

async function runSftpOperation(profile: SshProfile, request: SftpActionRequest): Promise<OperationResult> {
  try {
    let commands: string[] = [];
    if (request.action === "mkdir") {
      commands = [`mkdir ${quoteSftpPath(request.remotePath)}`];
    } else if (request.action === "rename") {
      if (!request.destinationPath) throw new Error("Destination path is required");
      commands = [`rename ${quoteSftpPath(request.remotePath)} ${quoteSftpPath(request.destinationPath)}`];
    } else if (request.action === "delete") {
      try {
        await runSftpBatch(profile, [`rm ${quoteSftpPath(request.remotePath)}`]);
        return { ok: true, message: "Remote file deleted" };
      } catch {
        commands = [`rmdir ${quoteSftpPath(request.remotePath)}`];
      }
    } else if (request.action === "upload") {
      const options: Electron.OpenDialogOptions = { properties: ["openFile", "openDirectory", "multiSelections"] };
      const chosen = mainWindow && !mainWindow.isDestroyed() ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
      if (chosen.canceled || chosen.filePaths.length === 0) return { ok: false, message: "Upload cancelled" };
      commands = chosen.filePaths.map((file) => `put -r ${quoteSftpPath(file)} ${quoteSftpPath(request.remotePath)}`);
    } else if (request.action === "download") {
      const options: Electron.OpenDialogOptions = { properties: ["openDirectory", "createDirectory"] };
      const chosen = mainWindow && !mainWindow.isDestroyed() ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
      if (chosen.canceled || !chosen.filePaths[0]) return { ok: false, message: "Download cancelled" };
      commands = [`get -r ${quoteSftpPath(request.remotePath)} ${quoteSftpPath(chosen.filePaths[0])}`];
    }
    const { stdout, stderr } = await runSftpBatch(profile, commands, 10 * 60_000);
    return { ok: true, message: (stdout || stderr || `${request.action} completed`).trim() };
  } catch (reason) {
    const error = reason as Error & { stderr?: string };
    return { ok: false, message: String(error.stderr || error.message).trim() };
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
    typeof request.providerId === "string" && PROVIDER_ID_PATTERN.test(request.providerId) &&
    typeof request.runId === "string" && RUN_ID_PATTERN.test(request.runId) &&
    typeof request.prompt === "string" && request.prompt.trim().length > 0 && request.prompt.length <= MAX_PROMPT_LENGTH &&
    isDirectory(request.cwd) &&
    (request.threadId === undefined || (typeof request.threadId === "string" && SESSION_ID_PATTERN.test(request.threadId))) &&
    (request.model === undefined || (typeof request.model === "string" && request.model.length <= 160 && !/[\r\n]/.test(request.model))) &&
    validSandbox && validReasoning && validImages
  );
}

function emit(owner: BrowserWindow, event: RunEvent) {
  if (owner.isDestroyed()) return;
  owner.webContents.send("provider:event", event);
  owner.webContents.send("codex:event", event);
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
    providerId: "codex",
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

function shellStartupScriptPath() {
  return app.isPackaged
    ? join(process.resourcesPath, "scripts", "install-shell-startup.ps1")
    : join(app.getAppPath(), "scripts", "install-shell-startup.ps1");
}

function launchUiScriptPath() {
  return app.isPackaged
    ? join(process.resourcesPath, "scripts", "launch-ui.ps1")
    : join(app.getAppPath(), "scripts", "launch-ui.ps1");
}

function runShellStartupAction(action: "Status" | "Install" | "Uninstall") {
  return new Promise<ShellStartupStatus>((resolveStatus) => {
    const script = shellStartupScriptPath();
    if (!existsSync(script)) {
      resolveStatus({ enabled: false, powershellInstalled: false, cmdInstalled: false, profilePaths: [], registryPath: "", error: "找不到 Shell 启动集成脚本" });
      return;
    }
    const hookPath = process.env.CODEX_UI_SHELL_STARTUP_HOOK_PATH || join(app.getPath("userData"), "shell-startup.ps1");
    const args = [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", script,
      "-Action", action,
      "-AppExecutable", process.execPath,
      "-ProjectRoot", app.isPackaged ? dirname(process.execPath) : app.getAppPath(),
      "-LaunchScript", launchUiScriptPath(),
      "-HookPath", hookPath,
    ];
    const overrides: Array<[string, string | undefined]> = [
      ["-WindowsPowerShellProfilePath", process.env.CODEX_UI_SHELL_STARTUP_WINDOWS_PROFILE],
      ["-PowerShellProfilePath", process.env.CODEX_UI_SHELL_STARTUP_PWSH_PROFILE],
      ["-RegistryPath", process.env.CODEX_UI_SHELL_STARTUP_REGISTRY_PATH],
    ];
    for (const [name, value] of overrides) if (value) args.push(name, value);
    execFile("powershell.exe", args, { windowsHide: true, timeout: 20_000 }, (error, stdout, stderr) => {
      try {
        const status = JSON.parse(stdout.trim()) as ShellStartupStatus;
        resolveStatus(error ? { ...status, error: status.error || stderr.trim() || error.message } : status);
      } catch {
        resolveStatus({ enabled: false, powershellInstalled: false, cmdInstalled: false, profilePaths: [], registryPath: "", error: stderr.trim() || error?.message || "Shell 启动集成返回了无效结果" });
      }
    });
  });
}

function codexCapabilities() {
  return {
    structuredChat: true,
    sessions: true,
    resume: true,
    models: true,
    reasoningEffort: true,
    sandboxMode: true,
    images: true,
    stop: true,
    webUi: false,
    terminal: true,
  };
}

async function getCodexInfo(): Promise<CodexInfo> {
  const executable = findCodexExecutable();
  return new Promise((resolveInfo) => {
    const child = spawn(executable, [...codexPrefixArgs(), "--version"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let errorOutput = "";
    child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { errorOutput += chunk.toString("utf8"); });
    child.on("error", (error) => resolveInfo({
      id: "codex",
      name: "OpenAI Codex",
      shortName: "Codex",
      description: "Local Codex CLI with structured JSON events and native session history",
      available: false,
      configured: false,
      cliAvailable: false,
      executable,
      error: error.message,
      defaultModel: "",
      capabilities: codexCapabilities(),
    }));
    child.on("close", (code) => {
      const available = code === 0;
      resolveInfo({
        id: "codex",
        name: "OpenAI Codex",
        shortName: "Codex",
        description: "Local Codex CLI with structured JSON events and native session history",
        available,
        configured: available,
        cliAvailable: available,
        version: available ? output.trim() : undefined,
        executable,
        error: available ? undefined : errorOutput.trim() || `Codex 退出码 ${code}`,
        defaultModel: "",
        models: [
          { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
          { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
          { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
        ],
        capabilities: codexCapabilities(),
      });
    });
  });
}

function createCodexProvider(): AgentProvider {
  return {
    id: "codex",
    getInfo: getCodexInfo,
    listSessions: listSessionsForWorkspace,
    getSession,
    async startRun(value, context) {
      if (activeRuns.has(value.runId)) throw new Error("运行 ID 已存在");
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
      const run: ActiveRun = { child, stopped: false };
      activeRuns.set(value.runId, run);
      const output = createInterface({ input: child.stdout! });
      output.on("line", (line) => {
        if (!line.trim()) return;
        try {
          const data = JSON.parse(line) as Record<string, unknown>;
          context.emit({ providerId: "codex", runId: value.runId, type: "message", data });
        } catch {
          context.emit({ providerId: "codex", runId: value.runId, type: "stderr", text: line });
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => context.emit({ providerId: "codex", runId: value.runId, type: "stderr", text: chunk.toString("utf8") }));
      child.on("error", (error) => context.emit({ providerId: "codex", runId: value.runId, type: "error", text: error.message }));
      child.on("close", (code) => {
        activeRuns.delete(value.runId);
        context.emit({ providerId: "codex", runId: value.runId, type: "exit", code, stopped: run.stopped });
        if (code === 0 && !run.stopped) context.notify("Codex 已完成", basename(value.cwd));
      });
      child.stdin?.end(value.prompt, "utf8");
      return { accepted: true as const };
    },
    stopRun(runId) {
      const run = activeRuns.get(runId);
      if (!run) return false;
      stopChild(run);
      return true;
    },
    dispose() {
      for (const run of activeRuns.values()) stopChild(run);
    },
  };
}

function initializeProviderRegistry() {
  if (providerRegistry) return providerRegistry;
  const registry = new ProviderRegistry();
  registry.register(createCodexProvider());
  registry.register(new DeepSeekProvider({
    runtimeBin: resolvePackageBin("@deepseek-ai/dsh-sdk-jsonrpc-demo"),
    runtimeConfig: deepSeekRuntimeConfigPath(),
    electronExecutable: process.execPath,
    sessionRoot: join(app.getPath("userData"), "deepseek-sessions"),
    getCredential: () => loadProviderCredential("deepseek"),
    setCredential: (value) => saveProviderCredential("deepseek", value),
  }));
  providerRegistry = registry;
  return registry;
}

function providerIdValue(value: unknown): AgentProviderId | null {
  return typeof value === "string" && PROVIDER_ID_PATTERN.test(value) ? value as AgentProviderId : null;
}

function notifyProviderCompletion(owner: BrowserWindow, title: string, body: string) {
  if (!appSettings.notifyOnCompletion || (owner.isVisible() && owner.isFocused()) || !Notification.isSupported()) return;
  const notification = new Notification({ title, body, silent: true });
  notification.on("click", () => showMainWindow());
  notification.show();
}

async function startProviderRun(owner: BrowserWindow, value: RunRequest) {
  const registry = initializeProviderRegistry();
  const provider = registry.get(value.providerId);
  if (activeProviderRuns.has(value.runId)) throw new Error("运行 ID 已存在");
  activeProviderRuns.set(value.runId, value.providerId);
  try {
    return await provider.startRun(value, {
      emit: (runEvent) => {
        if (runEvent.type === "exit") activeProviderRuns.delete(value.runId);
        emit(owner, runEvent);
      },
      notify: (title, body) => notifyProviderCompletion(owner, title, body),
    });
  } catch (error) {
    activeProviderRuns.delete(value.runId);
    throw error;
  }
}

ipcMain.handle("provider:list", () => initializeProviderRegistry().listInfo());
ipcMain.handle("provider:refresh", (_event, value: unknown) => {
  const providerId = providerIdValue(value);
  if (!providerId) throw new Error("无效的 Provider");
  return initializeProviderRegistry().refresh(providerId);
});
ipcMain.handle("provider:install", async (_event, value: unknown): Promise<OperationResult> => {
  const providerId = providerIdValue(value);
  if (!providerId) return { ok: false, message: "无效的 Provider" };
  const provider = initializeProviderRegistry().get(providerId);
  return provider.install ? provider.install() : { ok: false, message: `${providerId} 不支持自动安装` };
});
ipcMain.handle("provider:credential", async (_event, id: unknown, credential: unknown) => {
  const providerId = providerIdValue(id);
  if (!providerId || typeof credential !== "string" || credential.length > 16_384) throw new Error("无效的 Provider 凭据");
  const provider = initializeProviderRegistry().get(providerId);
  if (!provider.setCredential) throw new Error(`${providerId} 不支持保存凭据`);
  return provider.setCredential(credential);
});
ipcMain.handle("provider:sessions", (_event, id: unknown, cwd: unknown) => {
  const providerId = providerIdValue(id);
  return providerId && isDirectory(cwd) ? initializeProviderRegistry().get(providerId).listSessions(cwd) : [];
});
ipcMain.handle("provider:session", (_event, id: unknown, sessionId: unknown, cwd: unknown) => {
  const providerId = providerIdValue(id);
  return providerId && typeof sessionId === "string" && SESSION_ID_PATTERN.test(sessionId) && isDirectory(cwd)
    ? initializeProviderRegistry().get(providerId).getSession(sessionId, cwd)
    : null;
});
ipcMain.handle("provider:run", async (event, value: unknown) => {
  if (!isValidRunRequest(value)) throw new Error("无效的 Provider 运行请求");
  const owner = BrowserWindow.fromWebContents(event.sender);
  if (!owner) throw new Error("窗口已关闭");
  return startProviderRun(owner, value);
});
ipcMain.handle("provider:stop", (_event, runId: unknown) => {
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) return false;
  const providerId = activeProviderRuns.get(runId);
  return providerId ? initializeProviderRegistry().get(providerId).stopRun(runId) : false;
});

ipcMain.handle("codex:info", () => initializeProviderRegistry().get("codex").getInfo());

ipcMain.handle("app:settings:get", () => appSettings);
ipcMain.handle("app:settings:set", async (_event, value: unknown) => {
  const previous = appSettings;
  const next = normalizeAppSettings(value && typeof value === "object" ? value as Partial<AppSettings> : undefined);
  const startupChanged = previous.shellStartupIntegration !== next.shellStartupIntegration;
  if (startupChanged) {
    const status = await runShellStartupAction(next.shellStartupIntegration ? "Install" : "Uninstall");
    if (status.error || status.enabled !== next.shellStartupIntegration) throw new Error(status.error || "Shell 启动集成状态不一致");
  }
  try {
    await saveSettings(next);
  } catch (reason) {
    if (startupChanged) await runShellStartupAction(previous.shellStartupIntegration ? "Install" : "Uninstall");
    throw reason;
  }
  appSettings = next;
  for (const window of BrowserWindow.getAllWindows()) applyWindowAppearance(window);
  updateQuickTerminalShortcut();
  queueTerminalSnapshotSave();
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

ipcMain.handle("dialog:background-image", async () => {
  const options: Electron.OpenDialogOptions = {
    properties: ["openFile"],
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }],
  };
  const result = mainWindow && !mainWindow.isDestroyed()
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  const path = result.canceled ? undefined : result.filePaths.find(isImagePath);
  return path || null;
});

ipcMain.handle("path:reveal", async (_event, value: unknown) => {
  if (!isExistingPath(value)) return false;
  shell.showItemInFolder(value);
  return true;
});

ipcMain.handle("clipboard:write", (_event, value: unknown) => {
  if (typeof value !== "string" || value.length > 1_000_000) return false;
  clipboard.writeText(value);
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

ipcMain.handle("terminal:list", async (event) => {
  await restoreTerminalSessions(event.sender);
  for (const session of terminalSessions.values()) session.subscribers.add(event.sender.id);
  return [...terminalSessions.values()].map(terminalInfo).sort((left, right) => left.createdAt - right.createdAt);
});

ipcMain.handle("terminal:shells", () => detectedShells.map(({ args: _args, ...profile }) => profile));
ipcMain.handle("terminal:cli-tools", () => cliToolsInfo());

ipcMain.handle("terminal:history", async (_event, prefix: unknown, cwd: unknown) => {
  if (typeof prefix !== "string" || prefix.length > 4096 || typeof cwd !== "string" || cwd.length > 4096) return [];
  try {
    const content = (await readFile(commandHistoryPath(), "utf8")).slice(-2 * 1024 * 1024);
    const expected = normalizePath(cwd);
    const seen = new Set<string>();
    const matches: string[] = [];
    for (const line of content.split(/\r?\n/).reverse()) {
      try {
        const value = JSON.parse(line) as { command?: unknown; cwd?: unknown };
        if (typeof value.command !== "string" || typeof value.cwd !== "string" || normalizePath(value.cwd) !== expected) continue;
        if (!value.command.toLowerCase().startsWith(prefix.toLowerCase()) || seen.has(value.command)) continue;
        seen.add(value.command);
        matches.push(value.command);
        if (matches.length >= 20) break;
      } catch { /* Skip partial history records. */ }
    }
    return matches;
  } catch {
    return [];
  }
});

ipcMain.handle("terminal:create", async (event, value: unknown) => {
  if (!value || typeof value !== "object") throw new Error("无效的终端请求");
  const request = value as Partial<TerminalCreateRequest>;
  if (!isDirectory(request.cwd)) throw new Error("终端工作目录不存在");
  await restoreTerminalSessions(event.sender);
  if (request.reuseExisting !== false) {
    const expected = normalizePath(request.cwd);
    const expectedShell = request.sshProfileId ? `ssh:${request.sshProfileId}` : (request.shellId || appSettings.defaultShellId);
    const expectedProfile = typeof request.profileId === "string" ? request.profileId : undefined;
    const existing = [...terminalSessions.values()].find((session) => session.status === "running" && normalizePath(session.cwd) === expected && session.shellId === expectedShell && session.profileId === expectedProfile);
    if (existing) {
      existing.subscribers.add(event.sender.id);
      return terminalInfo(existing);
    }
  }
  const session = createTerminalSession(event.sender, {
    cwd: request.cwd,
    cols: terminalDimension(request.cols, 100, 400),
    rows: terminalDimension(request.rows, 30, 200),
    reuseExisting: request.reuseExisting,
    shellId: typeof request.shellId === "string" ? request.shellId : undefined,
    profileId: typeof request.profileId === "string" && PROVIDER_ID_PATTERN.test(request.profileId) ? request.profileId : undefined,
    sshProfileId: typeof request.sshProfileId === "string" ? request.sshProfileId : undefined,
    title: typeof request.title === "string" ? request.title : undefined,
  });
  return terminalInfo(session);
});

ipcMain.handle("terminal:attach", async (event, id: unknown) => {
  await restoreTerminalSessions(event.sender);
  if (typeof id !== "string" || !UUID_PATTERN.test(id)) return null;
  const session = terminalSessions.get(id);
  if (!session) return null;
  session.subscribers.add(event.sender.id);
  return { terminal: terminalInfo(session), snapshot: session.history };
});

ipcMain.handle("terminal:detach", (event, id: unknown) => {
  if (typeof id !== "string" || !UUID_PATTERN.test(id)) return false;
  return terminalSessions.get(id)?.subscribers.delete(event.sender.id) ?? false;
});

ipcMain.handle("terminal:write", (event, id: unknown, data: unknown) => {
  if (typeof id !== "string" || !UUID_PATTERN.test(id) || typeof data !== "string" || data.length === 0 || data.length > MAX_TERMINAL_INPUT) return false;
  const session = terminalSessions.get(id);
  if (!session || session.status !== "running" || !session.subscribers.has(event.sender.id)) return false;
  try {
    trackTerminalInput(session, data);
    session.pty.write(data);
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle("terminal:resize", (event, id: unknown, cols: unknown, rows: unknown) => {
  if (typeof id !== "string" || !UUID_PATTERN.test(id)) return false;
  const session = terminalSessions.get(id);
  if (!session || session.status !== "running" || !session.subscribers.has(event.sender.id)) return false;
  const nextCols = terminalDimension(cols, session.cols, 400);
  const nextRows = terminalDimension(rows, session.rows, 200);
  session.cols = nextCols;
  session.rows = nextRows;
  session.pendingResize = { cols: nextCols, rows: nextRows };
  session.updatedAt = Date.now();
  if (session.resizeTimer) clearTimeout(session.resizeTimer);
  session.resizeTimer = setTimeout(() => {
    session.resizeTimer = undefined;
    const pending = session.pendingResize;
    session.pendingResize = undefined;
    if (!pending || session.status !== "running") return;
    try { session.pty.resize(pending.cols, pending.rows); } catch { /* PTY may exit during a drag. */ }
    queueTerminalSnapshotSave();
  }, 75);
  return true;
});

ipcMain.handle("terminal:close", (event, id: unknown) => {
  if (typeof id !== "string" || !UUID_PATTERN.test(id)) return false;
  const session = terminalSessions.get(id);
  if (!session || !session.subscribers.has(event.sender.id)) return false;
  terminalSessions.delete(id);
  if (session.flushTimer) clearTimeout(session.flushTimer);
  if (session.resizeTimer) clearTimeout(session.resizeTimer);
  session.status = "exited";
  session.subscribers.clear();
  try { session.pty.kill(); } catch { /* The terminal may already have exited. */ }
  queueTerminalSnapshotSave();
  return true;
});

ipcMain.handle("terminal:files", async (event, root: unknown, path: unknown) => (
  typeof root === "string" && typeof path === "string" && isAuthorizedTerminalRoot(event.sender.id, root)
    ? listDirectoryEntries(root, path)
    : []
));

ipcMain.handle("terminal:document", async (event, root: unknown, path: unknown) => (
  typeof root === "string" && typeof path === "string" && isAuthorizedTerminalRoot(event.sender.id, root)
    ? readWorkspaceDocument(root, path)
    : null
));

ipcMain.handle("terminal:git", async (event, path: unknown): Promise<GitStatus> => (
  isDirectory(path) && isAuthorizedTerminalRoot(event.sender.id, path)
    ? gitStatus(path)
    : { available: false, branch: "", entries: [], error: "工作目录未授权" }
));

ipcMain.handle("terminal:git-action", async (event, value: unknown): Promise<OperationResult> => {
  if (!value || typeof value !== "object") return { ok: false, message: "Invalid Git action" };
  const request = value as Partial<GitActionRequest>;
  if (typeof request.root !== "string" || !isDirectory(request.root) || !isAuthorizedTerminalRoot(event.sender.id, request.root)) {
    return { ok: false, message: "Working directory is not authorized" };
  }
  if (!request.action || !["stage", "unstage", "commit", "pull", "push"].includes(request.action)) {
    return { ok: false, message: "Unsupported Git action" };
  }
  return runGitOperation(request as GitActionRequest);
});

ipcMain.handle("terminal:ssh-profiles", () => sshProfiles);
ipcMain.handle("terminal:ssh-save", async (_event, value: unknown) => {
  if (!value || typeof value !== "object") throw new Error("Invalid SSH profile");
  const source = value as Partial<SshProfile>;
  const normalized = normalizeSshProfile({ ...source, source: "saved" }, source.source !== "ssh-config");
  const index = sshProfiles.findIndex((profile) => profile.id === normalized.id && profile.source !== "ssh-config");
  if (index >= 0) sshProfiles[index] = { ...normalized, createdAt: sshProfiles[index].createdAt };
  else sshProfiles.unshift(normalized);
  await persistSshProfiles();
  return normalized;
});
ipcMain.handle("terminal:ssh-delete", async (_event, id: unknown) => {
  if (typeof id !== "string") return false;
  const before = sshProfiles.length;
  sshProfiles = sshProfiles.filter((profile) => profile.id !== id || profile.source === "ssh-config");
  if (sshProfiles.length === before) return false;
  await persistSshProfiles();
  return true;
});
ipcMain.handle("terminal:ssh-test", (_event, value: unknown) => (
  value && typeof value === "object" ? testSshConnection(value as Partial<SshProfile>) : Promise.resolve({ ok: false, stages: [], error: "Invalid SSH profile" })
));
ipcMain.handle("terminal:sftp-list", async (_event, id: unknown, path: unknown) => {
  if (typeof id !== "string" || typeof path !== "string") return [];
  const profile = sshProfiles.find((item) => item.id === id);
  if (!profile) return [];
  return listSftpEntries(profile, path);
});
ipcMain.handle("terminal:sftp-action", async (_event, value: unknown): Promise<OperationResult> => {
  if (!value || typeof value !== "object") return { ok: false, message: "Invalid SFTP action" };
  const request = value as Partial<SftpActionRequest>;
  if (typeof request.profileId !== "string" || typeof request.remotePath !== "string" || !request.action) return { ok: false, message: "Invalid SFTP action" };
  const profile = sshProfiles.find((item) => item.id === request.profileId);
  if (!profile) return { ok: false, message: "SSH profile not found" };
  return runSftpOperation(profile, request as SftpActionRequest);
});

ipcMain.handle("codex:sessions", async (_event, value: unknown) => (
  isDirectory(value) ? initializeProviderRegistry().get("codex").listSessions(value) : []
));
ipcMain.handle("codex:session", async (_event, id: unknown, cwd: unknown) => (
  typeof id === "string" && UUID_PATTERN.test(id) && isDirectory(cwd)
    ? initializeProviderRegistry().get("codex").getSession(id, cwd)
    : null
));

ipcMain.handle("codex:run", async (event, value: unknown) => {
  const request = value && typeof value === "object"
    ? { ...(value as Record<string, unknown>), providerId: "codex" }
    : value;
  if (!isValidRunRequest(request)) throw new Error("无效的 Codex 运行请求");
  const owner = BrowserWindow.fromWebContents(event.sender);
  if (!owner) throw new Error("窗口已关闭");
  return startProviderRun(owner, request);
});

ipcMain.handle("codex:stop", (_event, runId: unknown) => {
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) return false;
  return activeProviderRuns.get(runId) === "codex"
    ? initializeProviderRegistry().get("codex").stopRun(runId)
    : false;
});

ipcMain.handle("launcher:status", () => runLauncherAction("Status"));
ipcMain.handle("launcher:install", () => runLauncherAction("Install"));
ipcMain.handle("launcher:uninstall", () => runLauncherAction("Uninstall"));
ipcMain.handle("cli-lifecycle:status", () => {
  if (!cliLifecycleBridge) throw new Error("CLI lifecycle bridge is not ready");
  return cliLifecycleBridge.status();
});
ipcMain.handle("cli-lifecycle:set-enabled", (_event, enabled: unknown) => {
  if (!cliLifecycleBridge) throw new Error("CLI lifecycle bridge is not ready");
  if (typeof enabled !== "boolean") throw new Error("Invalid CLI lifecycle setting");
  return cliLifecycleBridge.setEnabled(enabled);
});

app.on("second-instance", (_event, argv) => showMainWindow(parseLauncherRequest(argv)));
app.on("activate", () => showMainWindow());
app.on("before-quit", () => {
  if (isQuitting) return;
  isQuitting = true;
  markTerminalRuntimeClean();
  for (const run of activeRuns.values()) stopChild(run);
  void providerRegistry?.dispose();
  void cliLifecycleBridge?.dispose();
  for (const session of terminalSessions.values()) {
    if (session.flushTimer) clearTimeout(session.flushTimer);
    if (session.resizeTimer) clearTimeout(session.resizeTimer);
    try { session.pty.kill(); } catch { /* The terminal may already have exited. */ }
  }
});
app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && appSettings.closeBehavior === "quit") app.quit();
});

void app.whenReady().then(async () => {
  bootTrace("app-ready");
  await loadSettings();
  initializeTerminalCrashGuard();
  bootTrace("settings-loaded");
  cliLifecycleBridge = new CliLifecycleBridge({
    userDataDir: app.getPath("userData"),
    helperTemplatePath: cliLifecycleHelperTemplatePath(),
    onEvent: handleCliLifecycleEvent,
  });
  await Promise.all([prepareTerminalIntegration(), loadSshProfiles(), cliLifecycleBridge.initialize()]);
  bootTrace("profiles-loaded");
  await detectTerminalShells();
  bootTrace("shells-detected");
  updateQuickTerminalShortcut();
  queuedLauncherRequest = parseLauncherRequest(process.argv);
  createWindow();
});
