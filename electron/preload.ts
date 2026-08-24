import { contextBridge, ipcRenderer } from "electron";
import type { AgentProviderId, AiForkRequest, AppSettings, CodexBridge, GitActionRequest, LauncherRequest, RunEvent, RunRequest, SftpActionRequest, ShellProfile, SshProfile, TerminalCreateRequest, TerminalEvent } from "../src/types";

const bridge: CodexBridge = {
  getInfo: () => ipcRenderer.invoke("codex:info"),
  listProviders: () => ipcRenderer.invoke("provider:list"),
  refreshProvider: (providerId: AgentProviderId) => ipcRenderer.invoke("provider:refresh", providerId),
  installProvider: (providerId: AgentProviderId) => ipcRenderer.invoke("provider:install", providerId),
  setProviderCredential: (providerId: AgentProviderId, credential: string) => ipcRenderer.invoke("provider:credential", providerId, credential),
  getAppSettings: () => ipcRenderer.invoke("app:settings:get"),
  setAppSettings: (settings: AppSettings) => ipcRenderer.invoke("app:settings:set", settings),
  listSystemFonts: () => ipcRenderer.invoke("fonts:list"),
  chooseDirectory: () => ipcRenderer.invoke("dialog:directory"),
  chooseImages: () => ipcRenderer.invoke("dialog:images"),
  chooseBackgroundImage: () => ipcRenderer.invoke("dialog:background-image"),
  revealPath: (path: string) => ipcRenderer.invoke("path:reveal", path),
  probePath: (path: string) => ipcRenderer.invoke("path:probe", path),
  openPath: (path: string) => ipcRenderer.invoke("path:open", path),
  copyText: (text: string) => ipcRenderer.invoke("clipboard:write", text),
  pasteClipboardImage: (sshProfileId?: string) => ipcRenderer.invoke("clipboard:paste-image", sshProfileId),
  openTerminal: (path: string) => ipcRenderer.invoke("path:terminal", path),
  listShells: () => ipcRenderer.invoke("terminal:shells"),
  listCliTools: () => ipcRenderer.invoke("terminal:cli-tools"),
  getCommandHistory: (prefix: string, cwd: string) => ipcRenderer.invoke("terminal:history", prefix, cwd),
  getCompletions: (prefix: string, cwd: string) => ipcRenderer.invoke("terminal:completions", prefix, cwd),
  listDirectories: () => ipcRenderer.invoke("directories:list"),
  pinDirectory: (path: string) => ipcRenderer.invoke("directories:pin", path),
  unpinDirectory: (path: string) => ipcRenderer.invoke("directories:unpin", path),
  removeDirectory: (path: string) => ipcRenderer.invoke("directories:remove", path),
  listTerminals: () => ipcRenderer.invoke("terminal:list"),
  createTerminal: (request: TerminalCreateRequest) => ipcRenderer.invoke("terminal:create", request),
  resumeAiSession: (id: string) => ipcRenderer.invoke("terminal:ai-resume", id),
  forkAiSession: (request: AiForkRequest) => ipcRenderer.invoke("terminal:ai-fork", request),
  attachTerminal: (id: string) => ipcRenderer.invoke("terminal:attach", id),
  detachTerminal: (id: string) => ipcRenderer.invoke("terminal:detach", id),
  writeTerminal: (id: string, data: string) => ipcRenderer.invoke("terminal:write", id, data),
  resizeTerminal: (id: string, cols: number, rows: number) => ipcRenderer.invoke("terminal:resize", id, cols, rows),
  closeTerminal: (id: string) => ipcRenderer.invoke("terminal:close", id),
  listDirectory: (root: string, path: string) => ipcRenderer.invoke("terminal:files", root, path),
  readDocument: (root: string, path: string) => ipcRenderer.invoke("terminal:document", root, path),
  readDocumentImage: (root: string, path: string) => ipcRenderer.invoke("terminal:document-image", root, path),
  exportTerminalSession: (sessionId: string, content: string) => ipcRenderer.invoke("terminal:export-session", sessionId, content),
  getGitStatus: (path: string) => ipcRenderer.invoke("terminal:git", path),
  runGitAction: (request: GitActionRequest) => ipcRenderer.invoke("terminal:git-action", request),
  listSshProfiles: () => ipcRenderer.invoke("terminal:ssh-profiles"),
  saveSshProfile: (profile: SshProfile) => ipcRenderer.invoke("terminal:ssh-save", profile),
  deleteSshProfile: (id: string) => ipcRenderer.invoke("terminal:ssh-delete", id),
  testSshProfile: (profile: SshProfile) => ipcRenderer.invoke("terminal:ssh-test", profile),
  pickSshKeys: () => ipcRenderer.invoke("dialog:ssh-key"),
  listSftp: (profileId: string, path: string) => ipcRenderer.invoke("terminal:sftp-list", profileId, path),
  runSftpAction: (request: SftpActionRequest) => ipcRenderer.invoke("terminal:sftp-action", request),
  listSessions: (cwd: string) => ipcRenderer.invoke("codex:sessions", cwd),
  getSession: (id: string, cwd: string) => ipcRenderer.invoke("codex:session", id, cwd),
  listProviderSessions: (providerId: AgentProviderId, cwd: string) => ipcRenderer.invoke("provider:sessions", providerId, cwd),
  getProviderSession: (providerId: AgentProviderId, id: string, cwd: string) => ipcRenderer.invoke("provider:session", providerId, id, cwd),
  startRun: (request: RunRequest) => ipcRenderer.invoke("provider:run", request),
  stopRun: (runId: string) => ipcRenderer.invoke("provider:stop", runId),
  getLauncherStatus: () => ipcRenderer.invoke("launcher:status"),
  installLauncher: () => ipcRenderer.invoke("launcher:install"),
  uninstallLauncher: () => ipcRenderer.invoke("launcher:uninstall"),
  getCliLifecycleStatus: () => ipcRenderer.invoke("cli-lifecycle:status"),
  setCliLifecycleEnabled: (enabled: boolean) => ipcRenderer.invoke("cli-lifecycle:set-enabled", enabled),
  onRunEvent: (listener: (event: RunEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: RunEvent) => listener(value);
    ipcRenderer.on("provider:event", handler);
    return () => ipcRenderer.removeListener("provider:event", handler);
  },
  onTerminalEvent: (listener: (event: TerminalEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: TerminalEvent) => listener(value);
    ipcRenderer.on("terminal:event", handler);
    return () => ipcRenderer.removeListener("terminal:event", handler);
  },
  resolveRuntimeAction: (id: string, result: { ok: boolean; paneId?: string; error?: string }) => {
    ipcRenderer.send("terminal:runtime-action-result", id, result);
  },
  onShellsChanged: (listener: (shells: ShellProfile[]) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: ShellProfile[]) => listener(value);
    ipcRenderer.on("terminal:shells-changed", handler);
    return () => ipcRenderer.removeListener("terminal:shells-changed", handler);
  },
  onQuickTerminal: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on("terminal:quick-open", handler);
    return () => ipcRenderer.removeListener("terminal:quick-open", handler);
  },
  pullLauncherRequest: () => ipcRenderer.invoke("launcher:pull"),
  onLauncherRequest: (listener: (request: LauncherRequest) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: LauncherRequest) => listener(value);
    ipcRenderer.on("launcher:request", handler);
    return () => ipcRenderer.removeListener("launcher:request", handler);
  },
};

contextBridge.exposeInMainWorld("codex", bridge);
contextBridge.exposeInMainWorld("workbench", bridge);
