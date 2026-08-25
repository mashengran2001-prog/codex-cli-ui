export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";
export type RunState = "idle" | "running" | "done" | "error" | "stopped";
export type AppLanguage = "system" | "zh-CN" | "en-US";
export type TerminalThemeName = "nebula" | "silver" | "steel" | "limestone" | "coal" | "linen" | "moss";
export type TerminalCursorStyle = "bar" | "block" | "underline";
export type UiDensity = "compact" | "normal" | "comfortable";
export type KeybindingAction = "command-palette" | "new-terminal" | "split-right" | "split-down" | "pane-next" | "pane-prev" | "quick-terminal" | "open-settings";
export type AgentProviderId = "codex" | "deepseek" | (string & {});

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

export interface BackupResult {
  ok: boolean;
  message?: string;
  path?: string;
  error?: string;
}

export const DEFAULT_KEYBINDINGS: Record<KeybindingAction, string> = {
  "command-palette": "Ctrl+Shift+P",
  "new-terminal": "Ctrl+Shift+T",
  "split-right": "Ctrl+Shift+D",
  "split-down": "Ctrl+Shift+E",
  "pane-next": "Ctrl+Alt+ArrowRight",
  "pane-prev": "Ctrl+Alt+ArrowLeft",
  "quick-terminal": "Ctrl+`",
  "open-settings": "Ctrl+,",
};

const KEYBINDING_ACTIONS = Object.keys(DEFAULT_KEYBINDINGS) as KeybindingAction[];
const KEYBINDING_PATTERN = /^(?:(?:ctrl|control|cmd|meta|commandorcontrol|shift|alt)\+)*[^+\s](?:[^+]|\+(?!$))*$/i;

export function normalizeKeybindings(value: unknown): Record<KeybindingAction, string> {
  const result: Record<KeybindingAction, string> = { ...DEFAULT_KEYBINDINGS };
  if (!value || typeof value !== "object") return result;
  for (const action of KEYBINDING_ACTIONS) {
    const chord = (value as Record<string, unknown>)[action];
    if (typeof chord === "string" && KEYBINDING_PATTERN.test(chord.trim()) && chord.trim().length <= 40) {
      result[action] = chord.trim();
    }
  }
  return result;
}

export interface AgentProviderCapabilities {
  structuredChat: boolean;
  sessions: boolean;
  resume: boolean;
  models: boolean;
  reasoningEffort: boolean;
  sandboxMode: boolean;
  images: boolean;
  stop: boolean;
  webUi: boolean;
  terminal: boolean;
}

export interface AgentProviderInfo {
  id: AgentProviderId;
  name: string;
  shortName: string;
  description: string;
  available: boolean;
  configured: boolean;
  cliAvailable: boolean;
  version?: string;
  executable?: string;
  error?: string;
  installCommand?: string;
  defaultModel?: string;
  models?: Array<{ id: string; label: string }>;
  capabilities: AgentProviderCapabilities;
}

export type CodexInfo = AgentProviderInfo;

export interface CliProfile {
  id: string;
  name: string;
  command: string;
  args: string[];
  cwd?: string;
  icon?: "terminal" | "code" | "server";
}

export interface CliToolInfo extends CliProfile {
  description: string;
  builtIn: boolean;
  available: boolean;
  executable?: string;
  installCommand?: string;
}

export interface AppSettings {
  closeBehavior: "tray" | "quit";
  notifyOnCompletion: boolean;
  language: AppLanguage;
  theme: TerminalThemeName;
  density: UiDensity;
  backgroundBlur: boolean;
  backgroundImage?: string;
  backgroundOpacity: number;
  restoreTerminalTabs: boolean;
  resizablePanels: boolean;
  completionEnabled: boolean;
  copyOnSelect: boolean;
  powerlinePrompt: boolean;
  quickTerminal: boolean;
  shellStartupIntegration: boolean;
  defaultShellId: string;
  newTabPlacement: "after-active" | "end";
  cursorStyle: TerminalCursorStyle;
  cursorBlink: boolean;
  fontFamily: string;
  cellWidth: "compact" | "relaxed";
  completionStyle: "inline" | "popup";
  bellMode: "off" | "flash" | "sound" | "both";
  renderTerminalMath: boolean;
  tabPosition: "top" | "side";
  backgroundColor?: string;
  accentColor?: string;
  resumeAiSessions: boolean;
  loadShellProfile: boolean;
  proxyUrl: string;
  proxyBypass: string;
  cliProfiles: CliProfile[];
  keybindings: Record<KeybindingAction, string>;
}

export interface CompletionCandidate {
  value: string;
  source: "history" | "dir" | "file" | "command";
}

export interface LauncherStatus {
  installed: boolean;
  profilePath: string;
  rawCommand?: string;
  error?: string;
}

export interface CliLifecycleIntegrationStatus {
  id: "codex" | "claude";
  label: string;
  installed: boolean;
  configPath: string;
  error?: string;
}

export interface CliLifecycleStatus {
  enabled: boolean;
  supported: boolean;
  watching: boolean;
  integrations: CliLifecycleIntegrationStatus[];
  lastRepairedAt?: number;
  error?: string;
}

export interface LauncherRequest {
  cwd: string;
  args: string[];
  prompt?: string;
  model?: string;
}

export interface RunRequest {
  providerId: AgentProviderId;
  runId: string;
  prompt: string;
  cwd: string;
  threadId?: string;
  model?: string;
  reasoningEffort: ReasoningEffort;
  sandboxMode: SandboxMode;
  imagePaths?: string[];
}

export interface RunEvent {
  providerId: AgentProviderId;
  runId: string;
  type: "message" | "stderr" | "exit" | "error";
  data?: Record<string, unknown>;
  text?: string;
  code?: number | null;
  stopped?: boolean;
}

export interface Activity {
  id: string;
  kind: "command" | "file" | "tool" | "web" | "reasoning" | "other";
  name: string;
  summary: string;
  detail?: string;
  status: "running" | "done" | "error";
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  createdAt: number;
  activities?: Activity[];
  imagePaths?: string[];
  status?: RunState;
  error?: string;
}

export interface SessionSummary {
  providerId: AgentProviderId;
  id: string;
  title: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  model?: string;
  cliVersion?: string;
  source?: "cli" | "desktop";
  gitBranch?: string;
  messages?: ChatMessage[];
}

export interface ProjectRecord {
  id: string;
  name: string;
  path: string;
  createdAt: number;
}

export interface ConversationRecord extends SessionSummary {
  projectId: string;
  runState: RunState;
  runId?: string;
  isDraft?: boolean;
}

export type TerminalStatus = "running" | "exited";
export type TerminalKind = "local" | "ssh";
export type TerminalActivity = "idle" | "running" | "attention";

export interface TerminalInfo {
  id: string;
  title: string;
  cwd: string;
  shell: string;
  shellId: string;
  profileId?: string;
  sshProfileId?: string;
  kind: TerminalKind;
  remoteHost?: string;
  activity: TerminalActivity;
  activeCommand?: string;
  lastCommandDuration?: number;
  status: TerminalStatus;
  exitCode?: number;
  exitedAt?: number;
  createdAt: number;
  updatedAt: number;
  cols: number;
  rows: number;
  aiSource?: "codex" | "claude";
  aiSessionId?: string;
  aiTaskState?: "idle" | "running" | "waiting_input" | "attention" | "finished" | "failed" | "settled";
}

export interface TerminalCreateRequest {
  cwd: string;
  cols: number;
  rows: number;
  reuseExisting?: boolean;
  shellId?: string;
  profileId?: string;
  sshProfileId?: string;
  title?: string;
}

export interface AiForkRequest {
  sessionId: string;
  cols?: number;
  rows?: number;
}

export interface TerminalEvent {
  sessionId: string;
  type: "data" | "exit" | "error" | "bell" | "focus" | "meta" | "runtime";
  data?: string;
  code?: number;
  message?: string;
  terminal?: TerminalInfo;
  /** Runtime control action (type "runtime"). */
  action?: { kind: "split"; direction: "columns" | "rows"; actionId: string };
}

export interface TerminalQuarantineStatus {
  quarantined: boolean;
  snapshotPath?: string | null;
}

export interface ShellProfile {
  id: string;
  label: string;
  command: string;
  kind: "powershell" | "cmd" | "git-bash" | "wsl" | "nushell" | "custom";
  detail?: string;
}

export interface SshProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  identityFile?: string;
  /** 多个私钥文件（对标 Nebula 私钥列表，最多 4 个）。 */
  identityFiles?: string[];
  remotePath?: string;
  createdAt: number;
  updatedAt: number;
  source?: "saved" | "ssh-config";
}

export type SshStageName = "resolve" | "tcp" | "authenticate" | "session";

export interface SshConnectionStage {
  name: SshStageName;
  status: "pending" | "running" | "done" | "error";
  message?: string;
}

export interface SshTestResult {
  ok: boolean;
  stages: SshConnectionStage[];
  /** 连接测试耗时（毫秒）。 */
  elapsedMs?: number;
  error?: string;
}

export interface SftpEntry {
  name: string;
  path: string;
  type: "directory" | "file" | "link";
  size?: number;
  modifiedAt?: number;
}

export interface SftpActionRequest {
  profileId: string;
  action: "upload" | "download" | "mkdir" | "rename" | "delete";
  remotePath: string;
  destinationPath?: string;
}

export interface OperationResult {
  ok: boolean;
  message: string;
}

export interface GitActionRequest {
  root: string;
  action: "stage" | "unstage" | "commit" | "pull" | "push" | "update";
  paths?: string[];
  message?: string;
  /** Explicit repository kind; detected automatically when omitted. */
  vcs?: "git" | "svn";
}

export interface DocumentFile {
  path: string;
  name: string;
  kind: "markdown" | "json" | "text" | "image";
  content: string;
  size: number;
  modifiedAt: number;
  imageSrc?: string;
}

export interface FileSystemEntry {
  name: string;
  path: string;
  type: "directory" | "file" | "link";
  size?: number;
  modifiedAt?: number;
}

export interface DirectoryEntry {
  path: string;
  rank: number;
  lastAccessed: number;
  pinned: boolean;
  score: number;
  /** "wsl" = WSL 发行版快捷目录（对标 Nebula 目录选择器侧栏钉入）。 */
  source?: "wsl";
}

export interface GitStatusEntry {
  path: string;
  status: string;
}

export interface GitStatus {
  available: boolean;
  branch: string;
  entries: GitStatusEntry[];
  error?: string;
  /** "git" or "svn"; absent means legacy response (treated as git). */
  vcs?: "git" | "svn";
  /** SVN working-copy revision, e.g. "r1234". */
  revision?: string;
}

export interface PersistedState {
  version: 1;
  projects: ProjectRecord[];
  aliases: Record<string, string>;
  selectedProjectId?: string;
  selectedConversationId?: string;
  sidebarWidth: number;
  model: string;
  reasoningEffort: ReasoningEffort;
  sandboxMode: SandboxMode;
  activeProviderId: AgentProviderId;
}

export interface DiagnosticsInfo {
  /** 应用与运行环境版本。 */
  appVersion: string;
  electronVersion: string;
  /** Electron 用户数据目录（快照/运行时状态所在）。 */
  userData: string;
  bootTracePath: string;
  /** 主进程运行时长（毫秒）。 */
  uptimeMs: number;
  /** 当前存活终端 pane 数。 */
  ptyCount: number;
  /** 崩溃守卫的持久化运行时状态。 */
  runtimeState: { cleanExit?: boolean; failures?: number; startedAt?: number; exitedAt?: number };
  /** 终端快照崩溃隔离状态。 */
  quarantine: { quarantined: boolean; snapshotPath: string | null };
}

export interface LatencyProbeResult {
  ok: boolean;
  /** 输入到回显的往返毫秒数（DSR 光标位置查询）。 */
  latencyMs?: number;
  row?: number;
  col?: number;
  error?: string;
}

export interface ImportedFontInfo {
  fileName: string;
  family: string;
  size: number;
}

export interface ImportFontResult {
  ok: boolean;
  family?: string;
  fileName?: string;
  error?: string;
}

export interface UpdateAssetInfo {
  name: string;
  size: number;
  url: string;
}

export interface UpdateProgress {
  phase: "downloading" | "verifying" | "done" | "error";
  received?: number;
  total?: number;
  message?: string;
}

export interface UpdateDownloadResult {
  ok: boolean;
  path?: string;
  sha256?: string;
  error?: string;
}

export interface UpdateCheckResult {
  /** 最新发布 tag，例如 v1.3.0。 */
  latest?: string;
  name?: string;
  publishedAt?: string;
  url?: string;
  assets?: UpdateAssetInfo[];
  sha256?: string;
  error?: string;
}

export interface CodexBridge {
  /** 终端渲染器模式：webgl（默认，几何绘制制表符）或 dom（测试环境。 */
  rendererMode: "webgl" | "dom";
  getInfo(): Promise<CodexInfo>;
  listProviders(): Promise<AgentProviderInfo[]>;
  refreshProvider(providerId: AgentProviderId): Promise<AgentProviderInfo>;
  installProvider(providerId: AgentProviderId): Promise<OperationResult>;
  setProviderCredential(providerId: AgentProviderId, credential: string): Promise<AgentProviderInfo>;
  getAppSettings(): Promise<AppSettings>;
  setAppSettings(settings: AppSettings): Promise<AppSettings>;
  listSystemFonts(): Promise<string[]>;
  listImportedFonts(): Promise<ImportedFontInfo[]>;
  importFont(): Promise<ImportFontResult>;
  deleteImportedFont(fileName: string): Promise<boolean>;
  chooseDirectory(): Promise<string | null>;
  chooseImages(): Promise<string[]>;
  chooseBackgroundImage(): Promise<string | null>;
  revealPath(path: string): Promise<boolean>;
  probePath(path: string): Promise<{ kind: "file" | "directory"; name: string; path: string; size?: number } | null>;
  openPath(path: string): Promise<boolean>;
  copyText(text: string): Promise<boolean>;
  pasteClipboardImage(sshProfileId?: string): Promise<string | null>;
  readClipboardText(): Promise<string>;
  getAppUserModelId(): Promise<string>;
  getWindowIconSize(): Promise<{ width: number; height: number } | null>;
  getDefaultSettings(): Promise<Partial<AppSettings>>;
  checkForUpdates(): Promise<UpdateCheckResult>;
  downloadUpdate(): Promise<UpdateDownloadResult>;
  launchUpdateInstaller(installerPath: string): Promise<UpdateDownloadResult>;
  onUpdateProgress(listener: (progress: UpdateProgress) => void): () => void;
  getDiagnosticsInfo(): Promise<DiagnosticsInfo>;
  probeInputLatency(paneId?: string): Promise<LatencyProbeResult>;
  getShellProfilePath(shellId: string): Promise<string | null>;
  openShellProfile(shellId: string): Promise<boolean>;
  openTerminal(path: string): Promise<boolean>;
  listShells(): Promise<ShellProfile[]>;
  listCliTools(): Promise<CliToolInfo[]>;
  getCommandHistory(prefix: string, cwd: string): Promise<string[]>;
  getCompletions(prefix: string, cwd: string, sshProfileId?: string): Promise<CompletionCandidate[]>;
  listDirectories(): Promise<DirectoryEntry[]>;
  pinDirectory(path: string): Promise<DirectoryEntry[]>;
  unpinDirectory(path: string): Promise<DirectoryEntry[]>;
  removeDirectory(path: string): Promise<DirectoryEntry[]>;
  listTerminals(): Promise<TerminalInfo[]>;
  getTerminalQuarantineStatus(): Promise<TerminalQuarantineStatus>;
  createTerminal(request: TerminalCreateRequest): Promise<TerminalInfo>;
  resumeAiSession(id: string): Promise<boolean>;
  forkAiSession(request: AiForkRequest): Promise<TerminalInfo>;
  attachTerminal(id: string): Promise<{ terminal: TerminalInfo; snapshot: string } | null>;
  detachTerminal(id: string): Promise<boolean>;
  writeTerminal(id: string, data: string): Promise<boolean>;
  resizeTerminal(id: string, cols: number, rows: number): Promise<boolean>;
  closeTerminal(id: string): Promise<boolean>;
  listDirectory(root: string, path: string): Promise<FileSystemEntry[]>;
  readDocument(root: string, path: string): Promise<DocumentFile | null>;
  readDocumentImage(root: string, path: string): Promise<string | null>;
  exportTerminalSession(sessionId: string, content: string): Promise<string | null>;
  exportBackup(selection: BackupSelection, passphrase: string): Promise<BackupResult>;
  restoreBackup(passphrase: string): Promise<BackupResult>;
  onBackupRestored(listener: () => void): () => void;
  getGitStatus(path: string): Promise<GitStatus>;
  runGitAction(request: GitActionRequest): Promise<OperationResult>;
  listSshProfiles(): Promise<SshProfile[]>;
  saveSshProfile(profile: SshProfile): Promise<SshProfile>;
  deleteSshProfile(id: string): Promise<boolean>;
  testSshProfile(profile: SshProfile): Promise<SshTestResult>;
  /** 打开私钥文件选择器（pem/key/ppk，最多返回 4 个）。 */
  pickSshKeys(): Promise<string[]>;
  listSftp(profileId: string, path: string): Promise<SftpEntry[]>;
  runSftpAction(request: SftpActionRequest): Promise<OperationResult>;
  listSessions(cwd: string): Promise<SessionSummary[]>;
  getSession(id: string, cwd: string): Promise<SessionSummary | null>;
  listProviderSessions(providerId: AgentProviderId, cwd: string): Promise<SessionSummary[]>;
  getProviderSession(providerId: AgentProviderId, id: string, cwd: string): Promise<SessionSummary | null>;
  startRun(request: RunRequest): Promise<{ accepted: true }>;
  stopRun(runId: string): Promise<boolean>;
  getLauncherStatus(): Promise<LauncherStatus>;
  installLauncher(): Promise<LauncherStatus>;
  uninstallLauncher(): Promise<LauncherStatus>;
  getCliLifecycleStatus(): Promise<CliLifecycleStatus>;
  setCliLifecycleEnabled(enabled: boolean): Promise<CliLifecycleStatus>;
  onRunEvent(listener: (event: RunEvent) => void): () => void;
  onTerminalEvent(listener: (event: TerminalEvent) => void): () => void;
  resolveRuntimeAction(id: string, result: { ok: boolean; paneId?: string; error?: string }): void;
  onShellsChanged(listener: (shells: ShellProfile[]) => void): () => void;
  onQuickTerminal(listener: () => void): () => void;
  pullLauncherRequest(): Promise<LauncherRequest | null>;
  onLauncherRequest(listener: (request: LauncherRequest) => void): () => void;
}
