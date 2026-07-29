import { contextBridge, ipcRenderer } from "electron";
import type { AppSettings, CodexBridge, LauncherRequest, RunEvent, RunRequest } from "../src/types";

const bridge: CodexBridge = {
  getInfo: () => ipcRenderer.invoke("codex:info"),
  getAppSettings: () => ipcRenderer.invoke("app:settings:get"),
  setAppSettings: (settings: AppSettings) => ipcRenderer.invoke("app:settings:set", settings),
  chooseDirectory: () => ipcRenderer.invoke("dialog:directory"),
  chooseImages: () => ipcRenderer.invoke("dialog:images"),
  revealPath: (path: string) => ipcRenderer.invoke("path:reveal", path),
  openTerminal: (path: string) => ipcRenderer.invoke("path:terminal", path),
  listSessions: (cwd: string) => ipcRenderer.invoke("codex:sessions", cwd),
  getSession: (id: string, cwd: string) => ipcRenderer.invoke("codex:session", id, cwd),
  startRun: (request: RunRequest) => ipcRenderer.invoke("codex:run", request),
  stopRun: (runId: string) => ipcRenderer.invoke("codex:stop", runId),
  getLauncherStatus: () => ipcRenderer.invoke("launcher:status"),
  installLauncher: () => ipcRenderer.invoke("launcher:install"),
  uninstallLauncher: () => ipcRenderer.invoke("launcher:uninstall"),
  onRunEvent: (listener: (event: RunEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: RunEvent) => listener(value);
    ipcRenderer.on("codex:event", handler);
    return () => ipcRenderer.removeListener("codex:event", handler);
  },
  onLauncherRequest: (listener: (request: LauncherRequest) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: LauncherRequest) => listener(value);
    ipcRenderer.on("launcher:request", handler);
    return () => ipcRenderer.removeListener("launcher:request", handler);
  },
};

contextBridge.exposeInMainWorld("codex", bridge);
