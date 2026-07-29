export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";
export type RunState = "idle" | "running" | "done" | "error" | "stopped";

export interface CodexInfo {
  available: boolean;
  version?: string;
  executable?: string;
  error?: string;
}

export interface AppSettings {
  closeBehavior: "tray" | "quit";
  notifyOnCompletion: boolean;
}

export interface LauncherStatus {
  installed: boolean;
  profilePath: string;
  rawCommand?: string;
  error?: string;
}

export interface LauncherRequest {
  cwd: string;
  args: string[];
  prompt?: string;
  model?: string;
}

export interface RunRequest {
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
}

export interface CodexBridge {
  getInfo(): Promise<CodexInfo>;
  getAppSettings(): Promise<AppSettings>;
  setAppSettings(settings: AppSettings): Promise<AppSettings>;
  chooseDirectory(): Promise<string | null>;
  chooseImages(): Promise<string[]>;
  revealPath(path: string): Promise<boolean>;
  openTerminal(path: string): Promise<boolean>;
  listSessions(cwd: string): Promise<SessionSummary[]>;
  getSession(id: string, cwd: string): Promise<SessionSummary | null>;
  startRun(request: RunRequest): Promise<{ accepted: true }>;
  stopRun(runId: string): Promise<boolean>;
  getLauncherStatus(): Promise<LauncherStatus>;
  installLauncher(): Promise<LauncherStatus>;
  uninstallLauncher(): Promise<LauncherStatus>;
  onRunEvent(listener: (event: RunEvent) => void): () => void;
  onLauncherRequest(listener: (request: LauncherRequest) => void): () => void;
}
