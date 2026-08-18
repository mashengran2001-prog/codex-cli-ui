export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";
export type RunState = "idle" | "running" | "done" | "error" | "stopped";
export type AppLanguage = "system" | "zh-CN" | "en-US";
export type TerminalThemeName = "nebula" | "silver" | "steel" | "limestone" | "coal" | "linen" | "moss";
export type TerminalCursorStyle = "bar" | "block" | "underline";
export type AgentProviderId = "codex" | "deepseek" | (string & {});

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
  cursorStyle: TerminalCursorStyle;
  cursorBlink: boolean;
  bellSound: boolean;
  loadShellProfile: boolean;
  cliProfiles: CliProfile[];
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
  kind: TerminalKind;
  remoteHost?: string;
  activity: TerminalActivity;
  activeCommand?: string;
  lastCommandDuration?: number;
  status: TerminalStatus;
  createdAt: number;
  updatedAt: number;
  cols: number;
  rows: number;
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

export interface TerminalEvent {
  sessionId: string;
  type: "data" | "exit" | "error" | "bell" | "focus" | "meta";
  data?: string;
  code?: number;
  message?: string;
  terminal?: TerminalInfo;
}

export interface ShellProfile {
  id: string;
  label: string;
  command: string;
  kind: "powershell" | "cmd" | "git-bash" | "wsl" | "custom";
  detail?: string;
}

export interface SshProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  identityFile?: string;
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
  action: "stage" | "unstage" | "commit" | "pull" | "push";
  paths?: string[];
  message?: string;
}

export interface DocumentFile {
  path: string;
  name: string;
  kind: "markdown" | "json" | "text";
  content: string;
  size: number;
  modifiedAt: number;
}

export interface FileSystemEntry {
  name: string;
  path: string;
  type: "directory" | "file" | "link";
  size?: number;
  modifiedAt?: number;
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

export interface CodexBridge {
  getInfo(): Promise<CodexInfo>;
  listProviders(): Promise<AgentProviderInfo[]>;
  refreshProvider(providerId: AgentProviderId): Promise<AgentProviderInfo>;
  installProvider(providerId: AgentProviderId): Promise<OperationResult>;
  setProviderCredential(providerId: AgentProviderId, credential: string): Promise<AgentProviderInfo>;
  getAppSettings(): Promise<AppSettings>;
  setAppSettings(settings: AppSettings): Promise<AppSettings>;
  chooseDirectory(): Promise<string | null>;
  chooseImages(): Promise<string[]>;
  chooseBackgroundImage(): Promise<string | null>;
  revealPath(path: string): Promise<boolean>;
  copyText(text: string): Promise<boolean>;
  openTerminal(path: string): Promise<boolean>;
  listShells(): Promise<ShellProfile[]>;
  listCliTools(): Promise<CliToolInfo[]>;
  getCommandHistory(prefix: string, cwd: string): Promise<string[]>;
  listTerminals(): Promise<TerminalInfo[]>;
  createTerminal(request: TerminalCreateRequest): Promise<TerminalInfo>;
  attachTerminal(id: string): Promise<{ terminal: TerminalInfo; snapshot: string } | null>;
  detachTerminal(id: string): Promise<boolean>;
  writeTerminal(id: string, data: string): Promise<boolean>;
  resizeTerminal(id: string, cols: number, rows: number): Promise<boolean>;
  closeTerminal(id: string): Promise<boolean>;
  listDirectory(root: string, path: string): Promise<FileSystemEntry[]>;
  readDocument(root: string, path: string): Promise<DocumentFile | null>;
  getGitStatus(path: string): Promise<GitStatus>;
  runGitAction(request: GitActionRequest): Promise<OperationResult>;
  listSshProfiles(): Promise<SshProfile[]>;
  saveSshProfile(profile: SshProfile): Promise<SshProfile>;
  deleteSshProfile(id: string): Promise<boolean>;
  testSshProfile(profile: SshProfile): Promise<SshTestResult>;
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
  onQuickTerminal(listener: () => void): () => void;
  onLauncherRequest(listener: (request: LauncherRequest) => void): () => void;
}
