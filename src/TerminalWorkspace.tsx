import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Bell, Bot, ChevronDown, ChevronLeft, ChevronRight, Columns2, Command, Copy,
  FolderOpen, FolderTree, GitBranch, Globe2, GripVertical, LoaderCircle, PanelLeftClose,
  PanelLeftOpen, Plus, RefreshCw, Rows2, Search, Server, Settings2, SquareTerminal, TerminalSquare, Upload, X,
} from "lucide-react";
import BrandIcon from "./BrandIcon";
import type { AppSettings, CliLifecycleStatus, CliToolInfo, DocumentFile, ProjectRecord, ShellProfile, SshProfile, TerminalEvent, TerminalInfo } from "./types";
import { getWorkbenchCopy } from "./i18n";
import CommandPalette, { type PaletteAction } from "./terminal/CommandPalette";
import DocumentViewer from "./terminal/DocumentViewer";
import { FilesDrawer, GitDrawer, SftpDrawer } from "./terminal/Drawers";
import SettingsPanel from "./terminal/SettingsPanel";
import SshEditor from "./terminal/SshEditor";
import TerminalPane from "./terminal/TerminalPane";

interface TerminalWorkspaceProps {
  project?: ProjectRecord;
  settings: AppSettings;
  workspaceMode: "chat" | "terminal";
  chatSidebar: ReactNode;
  chatContent: ReactNode;
  chatTitle?: string;
  providerName?: string;
  cliLifecycleStatus: CliLifecycleStatus | null;
  cliLifecycleBusy: boolean;
  onSettingsChange(settings: AppSettings): void;
  onCliLifecycleToggle(): void;
  onWorkspaceModeChange(mode: "chat" | "terminal"): void;
  onRefreshChat(): void;
  onAddProject(): void;
  onError(message: string): void;
}

type Drawer = "files" | "git" | "sftp" | null;
type WorkspaceView = "terminal" | "settings" | "document";
type SplitDirection = "columns" | "rows";

interface SavedLayout {
  panes?: string[];
  activePane?: number;
  sidebarWidth?: number;
  drawerWidth?: number;
  sidebarCollapsed?: boolean;
  splitDirection?: SplitDirection;
  tabsCollapsed?: boolean;
  toolsCollapsed?: boolean;
  sshCollapsed?: boolean;
}

const layoutKey = "codex-cli-ui:terminal-layout-v3";

function loadLayout(): SavedLayout {
  try { return JSON.parse(localStorage.getItem(layoutKey) || "{}") as SavedLayout; }
  catch { return {}; }
}

function samePath(left: string, right: string) {
  return left.replace(/[\\/]+$/, "").toLowerCase() === right.replace(/[\\/]+$/, "").toLowerCase();
}

function pathToCssUrl(path?: string) {
  if (!path) return undefined;
  return `url("file:///${path.replaceAll("\\", "/").replaceAll('"', "%22")}")`;
}

function terminalIcon(session: TerminalInfo) {
  const command = session.activeCommand?.trim().split(/\s+/)[0]?.toLowerCase().replace(/\.exe$/, "");
  if (command === "codex") return <BrandIcon brand="codex" size={13} />;
  if (command === "claude") return <BrandIcon brand="claude" size={13} />;
  if (command === "gemini" || command === "copilot") return <Bot size={13} />;
  if (session.kind === "ssh") return <Globe2 size={13} />;
  if (session.shellId.startsWith("wsl:")) return <SquareTerminal size={13} />;
  return <TerminalSquare size={13} />;
}

function cliToolIcon(tool: CliToolInfo) {
  if (tool.id.includes("claude")) return <BrandIcon brand="claude" size={13} />;
  if (tool.id.includes("codex")) return <BrandIcon brand="codex" size={13} />;
  if (tool.id.includes("gemini") || tool.id.includes("deepseek")) return <Bot size={13} />;
  return <SquareTerminal size={13} />;
}

function shellTag(session: TerminalInfo) {
  if (session.kind === "ssh") return "ssh";
  if (session.shellId.startsWith("wsl:")) return "wsl";
  if (session.shell.toLowerCase().includes("pwsh")) return "pwsh";
  if (session.shell.toLowerCase().includes("powershell")) return "ps";
  if (session.shell.toLowerCase().includes("cmd")) return "cmd";
  if (session.shell.toLowerCase().includes("bash")) return "bash";
  return session.shell.replace(/\.exe$/i, "").slice(0, 8);
}

export default function TerminalWorkspace({ project, settings, workspaceMode, chatSidebar, chatContent, chatTitle, providerName, cliLifecycleStatus, cliLifecycleBusy, onSettingsChange, onCliLifecycleToggle, onWorkspaceModeChange, onRefreshChat, onAddProject, onError }: TerminalWorkspaceProps) {
  const initialLayout = useMemo(loadLayout, []);
  const workbenchCopy = getWorkbenchCopy(settings.language);
  const [sessions, setSessions] = useState<TerminalInfo[]>([]);
  const [panes, setPanes] = useState<string[]>(initialLayout.panes || []);
  const [activePane, setActivePane] = useState(initialLayout.activePane || 0);
  const [splitDirection, setSplitDirection] = useState<SplitDirection>(initialLayout.splitDirection || "columns");
  const [shells, setShells] = useState<ShellProfile[]>([]);
  const [cliTools, setCliTools] = useState<CliToolInfo[]>([]);
  const [sshProfiles, setSshProfiles] = useState<SshProfile[]>([]);
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [view, setView] = useState<WorkspaceView>("terminal");
  const [document, setDocument] = useState<DocumentFile>();
  const [selectedSsh, setSelectedSsh] = useState<SshProfile>();
  const [sshEditor, setSshEditor] = useState<SshProfile | "new">();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [unread, setUnread] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<{ sessionId: string; title: string; message: string }>();
  const [sidebarWidth, setSidebarWidth] = useState(initialLayout.sidebarWidth || 250);
  const [drawerWidth, setDrawerWidth] = useState(initialLayout.drawerWidth || 330);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(initialLayout.sidebarCollapsed || false);
  const [tabsCollapsed, setTabsCollapsed] = useState(initialLayout.tabsCollapsed || false);
  const [toolsCollapsed, setToolsCollapsed] = useState(initialLayout.toolsCollapsed || false);
  const [sshCollapsed, setSshCollapsed] = useState(initialLayout.sshCollapsed || false);
  const [draggingSession, setDraggingSession] = useState<string>();
  const [commandText, setCommandText] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [windowFocused, setWindowFocused] = useState(window.document.hasFocus());
  const [terminalStateLoaded, setTerminalStateLoaded] = useState(false);
  const sessionsRef = useRef(sessions);
  const panesRef = useRef(panes);
  const activePaneRef = useRef(activePane);
  const mountedRef = useRef(true);

  const activeId = panes[activePane];
  const active = sessions.find((session) => session.id === activeId);
  const projectPath = project?.path ?? "";
  const projectLabel = project?.name ?? "CLI Workbench";
  useEffect(() => { sessionsRef.current = sessions; }, [sessions]);
  useEffect(() => { panesRef.current = panes; }, [panes]);
  useEffect(() => { activePaneRef.current = activePane; }, [activePane]);
  useEffect(() => () => {
    mountedRef.current = false;
    for (const session of sessionsRef.current) void window.codex.detachTerminal(session.id);
  }, []);
  useEffect(() => {
    const focus = () => setWindowFocused(true);
    const blur = () => setWindowFocused(false);
    window.addEventListener("focus", focus);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("focus", focus);
      window.removeEventListener("blur", blur);
    };
  }, []);
  useEffect(() => {
    localStorage.setItem(layoutKey, JSON.stringify({ panes, activePane, sidebarWidth, drawerWidth, sidebarCollapsed, splitDirection, tabsCollapsed, toolsCollapsed, sshCollapsed } satisfies SavedLayout));
  }, [activePane, drawerWidth, panes, sidebarCollapsed, sidebarWidth, splitDirection, sshCollapsed, tabsCollapsed, toolsCollapsed]);

  const assignSession = useCallback((id: string, paneIndex = activePaneRef.current) => {
    setView("terminal");
    onWorkspaceModeChange("terminal");
    setPanes((current) => {
      if (current.length === 0) return [id];
      const next = [...current];
      const duplicate = next.indexOf(id);
      if (duplicate >= 0) { setActivePane(duplicate); return next; }
      next[Math.min(paneIndex, next.length - 1)] = id;
      return next;
    });
    setUnread((current) => { const next = new Set(current); next.delete(id); return next; });
  }, [onWorkspaceModeChange]);

  const createTerminal = useCallback(async (path: string, options: { reuseExisting?: boolean; shellId?: string; profileId?: string; sshProfileId?: string; title?: string; activate?: boolean } = {}) => {
    if (!path) { onError(workbenchCopy.chooseDirectoryFirst); return null; }
    try {
      const session = await window.codex.createTerminal({ cwd: path, cols: 100, rows: 30, reuseExisting: options.reuseExisting, shellId: options.shellId, profileId: options.profileId, sshProfileId: options.sshProfileId, title: options.title });
      if (!mountedRef.current) { await window.codex.detachTerminal(session.id); return null; }
      setSessions((current) => current.some((item) => item.id === session.id) ? current.map((item) => item.id === session.id ? session : item) : [...current, session]);
      if (options.activate !== false) assignSession(session.id);
      return session;
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : workbenchCopy.createTerminalFailed);
      return null;
    }
  }, [assignSession, onError, workbenchCopy]);

  const refreshSshProfiles = useCallback(() => window.codex.listSshProfiles().then(setSshProfiles).catch((reason) => onError(reason instanceof Error ? reason.message : workbenchCopy.loadSshFailed)), [onError, workbenchCopy]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([window.codex.listShells(), window.codex.listCliTools(), window.codex.listSshProfiles(), window.codex.listTerminals()]).then(([shellItems, toolItems, sshItems, terminalItems]) => {
      if (cancelled) return;
      setShells(shellItems);
      setCliTools(toolItems);
      setSshProfiles(sshItems);
      setSessions(terminalItems);
      const valid = panesRef.current.filter((id) => terminalItems.some((session) => session.id === id));
      if (valid.length) { setPanes(valid.slice(0, 4)); setActivePane((index) => Math.min(index, valid.length - 1)); }
      setTerminalStateLoaded(true);
    }).catch((reason) => onError(reason instanceof Error ? reason.message : workbenchCopy.restoreTerminalFailed));
    return () => { cancelled = true; };
  }, [onError, workbenchCopy]);

  useEffect(() => {
    if (!terminalStateLoaded || workspaceMode !== "terminal" || !projectPath) return;
    const currentPanes = panesRef.current.filter((id) => sessionsRef.current.some((session) => session.id === id));
    if (currentPanes.some((id) => {
      const session = sessionsRef.current.find((item) => item.id === id);
      return session && samePath(session.cwd, projectPath);
    })) return;
    const preferred = sessionsRef.current.find((item) => item.status === "running" && samePath(item.cwd, projectPath));
    if (preferred) assignSession(preferred.id, 0);
    else void createTerminal(projectPath, { reuseExisting: true, shellId: settings.defaultShellId });
  }, [assignSession, createTerminal, projectPath, settings.defaultShellId, terminalStateLoaded, workspaceMode]);

  useEffect(() => {
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      void window.codex.listCliTools().then((items) => { if (!cancelled) setCliTools(items); });
    }, 180);
    return () => { cancelled = true; window.clearTimeout(timeout); };
  }, [settings.cliProfiles]);

  useEffect(() => window.codex.onTerminalEvent((event: TerminalEvent) => {
    const previous = sessionsRef.current.find((item) => item.id === event.sessionId);
    if (event.type === "meta" && event.terminal) {
      setSessions((current) => current.map((item) => item.id === event.sessionId ? event.terminal! : item));
      if (previous?.activity === "running" && event.terminal.activity === "idle" && event.sessionId !== panesRef.current[activePaneRef.current]) {
        setUnread((current) => new Set(current).add(event.sessionId));
        setNotice({ sessionId: event.sessionId, title: event.terminal.title, message: event.terminal.lastCommandDuration ? workbenchCopy.completedIn(Math.max(1, Math.round(event.terminal.lastCommandDuration / 1000))) : workbenchCopy.completed });
      }
    } else if (event.type === "data") {
      setSessions((current) => current.map((item) => item.id === event.sessionId ? { ...item, updatedAt: Date.now() } : item));
      if (!panesRef.current.includes(event.sessionId)) setUnread((current) => new Set(current).add(event.sessionId));
    } else if (event.type === "exit") {
      setSessions((current) => current.map((item) => item.id === event.sessionId ? { ...item, status: "exited", activity: "idle", updatedAt: Date.now() } : item));
      setNotice({ sessionId: event.sessionId, title: previous?.title || workbenchCopy.terminal, message: workbenchCopy.processExited(event.code) });
    } else if (event.type === "bell") {
      setNotice({ sessionId: event.sessionId, title: previous?.title || workbenchCopy.terminal, message: previous?.activity === "attention" ? workbenchCopy.inputRequested : workbenchCopy.attentionRequested });
    } else if (event.type === "focus") assignSession(event.sessionId);
    else if (event.type === "error" && event.message) onError(event.message);
  }), [assignSession, onError, workbenchCopy]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(undefined), 6_000);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  const splitPane = useCallback(async (direction: SplitDirection, sessionId?: string) => {
    if (panesRef.current.length >= 4) { onError(workbenchCopy.maxPanes); return; }
    setSplitDirection(direction);
    let id = sessionId;
    if (!id || panesRef.current.includes(id)) {
      const current = sessionsRef.current.find((item) => item.id === panesRef.current[activePaneRef.current]);
      const created = await createTerminal(current?.cwd || projectPath, { reuseExisting: false, shellId: settings.defaultShellId, activate: false });
      id = created?.id;
    }
    if (!id) return;
    const nextIndex = panesRef.current.length;
    setPanes((current) => current.includes(id!) ? current : [...current, id!]);
    setActivePane(nextIndex);
    setView("terminal");
    onWorkspaceModeChange("terminal");
  }, [createTerminal, onError, onWorkspaceModeChange, projectPath, settings.defaultShellId, workbenchCopy]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "p") { event.preventDefault(); setPaletteOpen(true); }
      else if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "t") { event.preventDefault(); void createTerminal(active?.cwd || projectPath, { shellId: settings.defaultShellId }); }
      else if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "d") { event.preventDefault(); void splitPane("columns"); }
      else if (event.ctrlKey && event.key === ",") { event.preventDefault(); setDrawer(null); setView("settings"); }
      else if (event.key === "Escape") setPaletteOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [active?.cwd, createTerminal, projectPath, settings.defaultShellId, splitPane]);

  useEffect(() => {
    if (!settings.completionEnabled || !active || !commandText.trim()) { setSuggestions([]); return; }
    let cancelled = false;
    const timeout = window.setTimeout(async () => {
      const history = await window.codex.getCommandHistory(commandText, active.cwd);
      if (!cancelled) { setSuggestions(history); setSuggestionIndex(0); }
    }, 90);
    return () => { cancelled = true; window.clearTimeout(timeout); };
  }, [active?.cwd, active?.id, commandText, settings.completionEnabled]);

  const closePane = (index: number) => {
    setPanes((current) => current.filter((_, itemIndex) => itemIndex !== index));
    setActivePane((current) => Math.max(0, Math.min(current, panes.length - 2)));
  };

  const closeTerminal = async (id: string) => {
    const index = sessions.findIndex((item) => item.id === id);
    if (!await window.codex.closeTerminal(id)) return;
    const remaining = sessions.filter((item) => item.id !== id);
    setSessions(remaining);
    setPanes((current) => current.map((paneId) => paneId === id ? "" : paneId).filter(Boolean));
    if (remaining.length === 0 && projectPath) void createTerminal(projectPath, { reuseExisting: false, shellId: settings.defaultShellId });
    else if (panes.includes(id)) assignSession(remaining[Math.min(index, remaining.length - 1)].id, 0);
  };

  const reorderSession = (sourceId: string, targetId: string) => setSessions((current) => {
    const source = current.findIndex((item) => item.id === sourceId);
    const target = current.findIndex((item) => item.id === targetId);
    if (source < 0 || target < 0 || source === target) return current;
    const next = [...current];
    const [item] = next.splice(source, 1);
    next.splice(target, 0, item);
    return next;
  });

  const dockSession = (sessionId: string, paneIndex: number, edge: "center" | "left" | "right" | "top" | "bottom") => {
    if (edge === "center") { assignSession(sessionId, paneIndex); return; }
    if (panes.length >= 4) { assignSession(sessionId, paneIndex); return; }
    setSplitDirection(edge === "left" || edge === "right" ? "columns" : "rows");
    setPanes((current) => {
      const without = current.filter((id) => id !== sessionId);
      const insertAt = edge === "left" || edge === "top" ? paneIndex : paneIndex + 1;
      without.splice(Math.min(insertAt, without.length), 0, sessionId);
      return without;
    });
    setView("terminal");
  };

  const sendCommand = (value = commandText) => {
    if (!active || !value.trim()) return;
    let command = value.trim();
    if (/powershell/i.test(active.shell)) {
      const cd = command.match(/^cd\s+(.+\s.+)$/i);
      if (cd && !/^['"]/.test(cd[1])) command = `Set-Location -LiteralPath '${cd[1].replaceAll("'", "''")}'`;
      const assignment = command.match(/^(\$env:[A-Za-z_][A-Za-z0-9_]*)=(.+\s.+)$/);
      if (assignment && !/^['"]/.test(assignment[2])) command = `${assignment[1]}='${assignment[2].replaceAll("'", "''")}'`;
    }
    void window.codex.writeTerminal(active.id, `${command}\r`);
    setCommandText("");
    setSuggestions([]);
  };

  const openSftp = (profile: SshProfile) => { setSelectedSsh(profile); setDrawer("sftp"); };
  const connectSsh = async (profile: SshProfile) => {
    setSelectedSsh(profile);
    await createTerminal(active?.cwd || projectPath, { reuseExisting: false, sshProfileId: profile.id, title: profile.name });
  };

  const launchCliTool = async (tool: CliToolInfo) => {
    if (tool.builtIn && !tool.available) {
      if (tool.installCommand) await window.codex.copyText(tool.installCommand);
      onError(`${workbenchCopy.toolNotDetected(tool.name)}${tool.installCommand ? workbenchCopy.installCommandCopied : ""}`);
      return;
    }
    await createTerminal(tool.cwd || active?.cwd || projectPath, {
      reuseExisting: false,
      shellId: settings.defaultShellId,
      profileId: tool.id,
      title: tool.name,
    });
  };

  const resizePanel = (kind: "sidebar" | "drawer", event: React.PointerEvent<HTMLDivElement>) => {
    if (!settings.resizablePanels) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const start = kind === "sidebar" ? sidebarWidth : drawerWidth;
    const move = (pointer: PointerEvent) => {
      const next = kind === "sidebar" ? start + pointer.clientX - startX : start - pointer.clientX + startX;
      if (kind === "sidebar") { if (next < 90) setSidebarCollapsed(true); else { setSidebarCollapsed(false); setSidebarWidth(Math.max(210, Math.min(390, next))); } }
      else if (next < 150) setDrawer(null); else setDrawerWidth(Math.max(270, Math.min(520, next)));
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const paletteActions: PaletteAction[] = [
    ...cliTools.map((tool) => ({ id: `tool:${tool.id}`, group: workbenchCopy.cliTools, label: tool.name, detail: tool.available ? tool.description : tool.installCommand || workbenchCopy.notDetected, icon: cliToolIcon(tool), run: () => void launchCliTool(tool) })),
    ...shells.map((shell) => ({ id: `shell:${shell.id}`, group: workbenchCopy.newTerminalGroup, label: shell.label, detail: shell.detail, icon: <TerminalSquare size={14} />, run: () => void createTerminal(active?.cwd || projectPath, { reuseExisting: false, shellId: shell.id }) })),
    { id: "close-terminal", group: workbenchCopy.terminalActions, label: workbenchCopy.closeTerminal, icon: <X size={14} />, run: () => { if (active) void closeTerminal(active.id); } },
    { id: "previous-terminal", group: workbenchCopy.terminalActions, label: workbenchCopy.previousTerminal, icon: <ChevronLeft size={14} />, run: () => { if (!sessions.length) return; const index = Math.max(0, sessions.findIndex((session) => session.id === active?.id)); assignSession(sessions[(index - 1 + sessions.length) % sessions.length].id); } },
    { id: "next-terminal", group: workbenchCopy.terminalActions, label: workbenchCopy.nextTerminal, icon: <ChevronRight size={14} />, run: () => { if (!sessions.length) return; const index = Math.max(0, sessions.findIndex((session) => session.id === active?.id)); assignSession(sessions[(index + 1) % sessions.length].id); } },
    { id: "split-columns", group: workbenchCopy.layout, label: workbenchCopy.splitRight, icon: <Columns2 size={14} />, run: () => void splitPane("columns") },
    { id: "split-rows", group: workbenchCopy.layout, label: workbenchCopy.splitDown, icon: <Rows2 size={14} />, run: () => void splitPane("rows") },
    { id: "sidebar", group: workbenchCopy.layout, label: workbenchCopy.showTabSidebar, icon: sidebarCollapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />, checked: !sidebarCollapsed, run: () => setSidebarCollapsed((value) => !value) },
    { id: "resize", group: workbenchCopy.layout, label: workbenchCopy.resizePanels, icon: <GripVertical size={14} />, checked: settings.resizablePanels, run: () => onSettingsChange({ ...settings, resizablePanels: !settings.resizablePanels }) },
    { id: "files", group: workbenchCopy.workspace, label: workbenchCopy.files, icon: <FolderTree size={14} />, checked: drawer === "files", run: () => setDrawer((value) => value === "files" ? null : "files") },
    { id: "git", group: workbenchCopy.workspace, label: "Git", icon: <GitBranch size={14} />, checked: drawer === "git", run: () => setDrawer((value) => value === "git" ? null : "git") },
    { id: "settings", group: workbenchCopy.workspace, label: workbenchCopy.settings, icon: <Settings2 size={14} />, run: () => setView("settings") },
    { id: "new-ssh-host", group: workbenchCopy.sshHosts, label: workbenchCopy.newSshHost, icon: <Plus size={14} />, run: () => setSshEditor("new") },
    { id: "quick-terminal", group: workbenchCopy.workspace, label: workbenchCopy.quickTerminalAction, icon: <TerminalSquare size={14} />, checked: settings.quickTerminal, run: () => onSettingsChange({ ...settings, quickTerminal: !settings.quickTerminal }) },
    { id: "command-suggestions", group: workbenchCopy.workspace, label: workbenchCopy.commandSuggestions, icon: <Search size={14} />, checked: settings.completionEnabled, run: () => onSettingsChange({ ...settings, completionEnabled: !settings.completionEnabled }) },
    { id: "copy-path", group: `${workbenchCopy.workingDirectory} · ${active?.cwd || projectPath}`, label: workbenchCopy.copyPath, icon: <Copy size={14} />, run: () => void window.codex.copyText(active?.cwd || projectPath) },
    { id: "reveal-path", group: `${workbenchCopy.workingDirectory} · ${active?.cwd || projectPath}`, label: workbenchCopy.revealPath, icon: <FolderOpen size={14} />, run: () => void window.codex.revealPath(active?.cwd || projectPath) },
    ...sshProfiles.map((profile) => ({ id: `ssh:${profile.id}`, group: workbenchCopy.sshHosts, label: profile.name, detail: `${profile.username ? `${profile.username}@` : ""}${profile.host}`, icon: <Server size={14} />, run: () => void connectSsh(profile) })),
  ];

  const ghost = suggestions[suggestionIndex];
  const ghostSuffix = ghost?.toLowerCase().startsWith(commandText.toLowerCase()) ? ghost.slice(commandText.length) : "";
  const openSettings = () => {
    setDrawer(null);
    setView("settings");
  };
  const activateWorkspaceMode = (mode: "chat" | "terminal") => {
    if (mode === "terminal" && !projectPath) return;
    setDrawer(null);
    setView("terminal");
    onWorkspaceModeChange(mode);
  };
  const primaryView = view === "terminal";
  const chatView = primaryView && workspaceMode === "chat";
  const terminalView = primaryView && workspaceMode === "terminal";
  const showSidePanel = primaryView && !sidebarCollapsed;
  const headingTitle = view === "settings" ? workbenchCopy.settings : view === "document" ? document?.name || workbenchCopy.document : chatView ? chatTitle || workbenchCopy.conversations : workbenchCopy.terminal;
  const headingLabel = view === "settings" ? workbenchCopy.settingsLabel : chatView ? workbenchCopy.conversationsLabel : workbenchCopy.terminalLabel;

  return (
    <main className="terminal-workspace" data-terminal-theme={settings.theme} data-workspace-view={view} data-window-focused={windowFocused} style={{ "--terminal-sidebar-width": `${sidebarWidth}px`, "--terminal-drawer-width": `${drawerWidth}px`, "--terminal-bg-opacity": settings.backgroundOpacity, "--terminal-bg-image": pathToCssUrl(settings.backgroundImage) } as React.CSSProperties}>
      <header className="terminal-header">
        <div className="terminal-heading">
          <span className="terminal-brand">{view === "settings" ? <Settings2 size={17} /> : chatView ? <Bot size={17} /> : <TerminalSquare size={17} />}</span>
          <div>
            <h1 aria-label={headingLabel}>{headingTitle}</h1>
            {project ? <button title={projectPath} onClick={() => void window.codex.revealPath(projectPath)}><FolderOpen size={11} /><span>{projectLabel}</span><small>{chatView ? providerName : active?.cwd || projectPath}</small></button> : <button title={workbenchCopy.selectDirectory} onClick={onAddProject}><FolderOpen size={11} /><span>{workbenchCopy.selectDirectory}</span><small>{providerName}</small></button>}
          </div>
        </div>
        <div className="terminal-actions">
          {primaryView && <div className="workspace-view-switch" role="tablist" aria-label={workbenchCopy.viewSwitcher}>
            <button role="tab" aria-selected={workspaceMode === "chat"} className={workspaceMode === "chat" ? "active" : ""} title={workbenchCopy.chat} onClick={() => activateWorkspaceMode("chat")}><Bot size={13} /><span>{workbenchCopy.chat}</span></button>
            <button role="tab" aria-selected={workspaceMode === "terminal"} className={workspaceMode === "terminal" ? "active" : ""} title={workbenchCopy.terminal} disabled={!projectPath} onClick={() => activateWorkspaceMode("terminal")}><TerminalSquare size={13} /><span>{workbenchCopy.terminal}</span></button>
          </div>}
          {chatView && <button title={workbenchCopy.refreshChat} disabled={!project} onClick={onRefreshChat}><RefreshCw size={14} /></button>}
          {terminalView && <>
            <button className={drawer === "files" ? "active" : ""} aria-label={workbenchCopy.files} title={workbenchCopy.files} onClick={() => setDrawer((value) => value === "files" ? null : "files")}><FolderTree size={14} /></button>
            <button className={drawer === "git" ? "active" : ""} aria-label={workbenchCopy.gitStatus} title={workbenchCopy.gitStatus} onClick={() => setDrawer((value) => value === "git" ? null : "git")}><GitBranch size={14} /></button>
            {active?.kind === "ssh" && selectedSsh && <button className={drawer === "sftp" ? "active" : ""} title="SFTP" onClick={() => openSftp(selectedSsh)}><Upload size={14} /></button>}
            <button title={workbenchCopy.splitRight} onClick={() => void splitPane("columns")}><Columns2 size={14} /></button>
            <button title={workbenchCopy.commandPalette} onClick={() => setPaletteOpen(true)}><Command size={14} /></button>
          </>}
          {primaryView && <button title={sidebarCollapsed ? workbenchCopy.showSidebar : workbenchCopy.hideSidebar} onClick={() => setSidebarCollapsed((value) => !value)}>{sidebarCollapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}</button>}
          <button className={view === "settings" ? "active" : ""} title={view === "settings" ? workbenchCopy.back : workbenchCopy.settings} onClick={() => view === "settings" ? setView("terminal") : openSettings()}>{view === "settings" ? (workspaceMode === "chat" ? <Bot size={14} /> : <TerminalSquare size={14} />) : <Settings2 size={14} />}</button>
        </div>
      </header>
      <div className="terminal-main">
        {showSidePanel && chatView && <aside className="terminal-side-panel chat-side-panel">{chatSidebar}</aside>}
        {showSidePanel && terminalView && <aside className="terminal-side-panel">
          <div className="side-section-heading"><button title={workbenchCopy.toggleTabs} onClick={() => setTabsCollapsed((value) => !value)}>{tabsCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}<strong>{workbenchCopy.tabs}</strong></button><span>{sessions.length}</span><button title={workbenchCopy.newTerminal} onClick={() => void createTerminal(active?.cwd || projectPath, { reuseExisting: false, shellId: settings.defaultShellId })}><Plus size={13} /></button></div>
          {!tabsCollapsed && <div className="terminal-side-tabs">{sessions.map((session) => <div className={`terminal-tab ${panes.includes(session.id) ? "active" : ""}`} data-session-id={session.id} key={session.id} draggable onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }} onAuxClick={(event) => { if (event.button !== 1) return; event.preventDefault(); event.stopPropagation(); void closeTerminal(session.id); }} onDragStart={(event) => { setDraggingSession(session.id); event.dataTransfer.setData("text/terminal-session", session.id); }} onDragEnd={() => setDraggingSession(undefined)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const source = event.dataTransfer.getData("text/terminal-session"); if (source) reorderSession(source, session.id); }}><button className="terminal-tab-main" title={session.cwd} onClick={() => assignSession(session.id)}><span className={`terminal-state ${session.status} ${session.activity} ${unread.has(session.id) ? "unread" : ""}`}>{session.activity === "running" && <LoaderCircle className="spin" size={11} />}</span>{terminalIcon(session)}<span><strong>{session.title}</strong><small>{session.activity === "running" ? session.activeCommand : session.remoteHost || session.cwd}</small></span>{session.activity === "idle" && <em>{shellTag(session)}</em>}</button><button className="terminal-tab-close" title={workbenchCopy.closeTerminal} onClick={() => void closeTerminal(session.id)}><X size={11} /></button></div>)}</div>}
          <div className="side-section-heading cli-tools-heading"><button title={workbenchCopy.toggleCliTools} onClick={() => setToolsCollapsed((value) => !value)}>{toolsCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}<strong>{workbenchCopy.cliTools}</strong></button><span>{cliTools.length}</span><button title={workbenchCopy.cliToolSettings} onClick={openSettings}><Settings2 size={12} /></button></div>
          {!toolsCollapsed && <div className="cli-tool-list">{cliTools.map((tool) => <button className={tool.available ? "available" : "unavailable"} title={tool.available ? workbenchCopy.launchTool(tool.name) : tool.installCommand || workbenchCopy.toolNotDetected(tool.name)} onClick={() => void launchCliTool(tool)} key={tool.id}>{cliToolIcon(tool)}<span className="cli-tool-copy"><strong>{tool.name}</strong><small>{tool.available ? tool.description : workbenchCopy.toolNotInstalled}</small></span><i className={tool.available ? "online" : "offline"} /></button>)}</div>}
          <div className="side-section-heading ssh-heading"><button title={workbenchCopy.toggleSshHosts} onClick={() => setSshCollapsed((value) => !value)}>{sshCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}<strong>{workbenchCopy.sshHosts}</strong></button><span>{sshProfiles.length}</span><button title={workbenchCopy.newSshHost} onClick={() => setSshEditor("new")}><Plus size={13} /></button></div>
          {!sshCollapsed && <div className="ssh-host-list">{sshProfiles.map((profile) => <div key={profile.id}><button title={workbenchCopy.connectHost(profile.name)} onClick={() => void connectSsh(profile)}><Server size={13} /><span><strong>{profile.name}</strong><small>{profile.username ? `${profile.username}@${profile.host}` : profile.host}</small></span></button><button title={workbenchCopy.browseSftp} onClick={() => openSftp(profile)}><Upload size={11} /></button><button title={workbenchCopy.editSshHost} onClick={() => setSshEditor(profile)}><Settings2 size={11} /></button></div>)}{sshProfiles.length === 0 && <button className="empty-ssh" onClick={() => setSshEditor("new")}><Plus size={12} />{workbenchCopy.addSshHost}</button>}</div>}
        </aside>}
        {settings.resizablePanels && showSidePanel && <div className="panel-resizer sidebar-resizer" onPointerDown={(event) => resizePanel("sidebar", event)} />}
        {primaryView && sidebarCollapsed && <button className="restore-side-panel" title={workbenchCopy.showSidebar} onClick={() => setSidebarCollapsed(false)}><PanelLeftOpen size={14} /></button>}
        <section className="terminal-stage">
          {chatView && <div className="chat-session-view">{chatContent}</div>}
          <div className={`terminal-session-view ${terminalView ? "visible" : "hidden"}`} aria-hidden={!terminalView}>
            <div className={`terminal-pane-grid count-${panes.length} split-${splitDirection}`}>
              {sessions.map((session) => {
                const index = panes.indexOf(session.id);
                const visible = index >= 0;
                return <div className={visible ? `terminal-grid-cell ${index === activePane ? "active" : ""}` : "terminal-grid-cache-cell"} style={visible ? { order: index } : undefined} key={session.id} onDragOver={visible ? (event) => event.preventDefault() : undefined} onDrop={visible ? (event) => { event.preventDefault(); const id = event.dataTransfer.getData("text/terminal-session"); if (id) dockSession(id, index, "center"); } : undefined}>{visible && <div className="pane-toolbar"><span>{terminalIcon(session)}<strong>{session.title}</strong><small>{session.remoteHost || session.cwd}</small>{session.activity === "attention" && <i />}</span>{panes.length > 1 && <button title={workbenchCopy.closePane} onClick={() => closePane(index)}><X size={11} /></button>}</div>}<TerminalPane session={session} theme={settings.theme} cursorStyle={settings.cursorStyle} cursorBlink={settings.cursorBlink} copyOnSelect={settings.copyOnSelect} active={visible && index === activePane && terminalView && windowFocused} onFocus={() => { if (!visible) return; setActivePane(index); setUnread((current) => { const next = new Set(current); next.delete(session.id); return next; }); }} />{visible && draggingSession && draggingSession !== session.id && <div className="dock-overlay"><button className="dock-top" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.stopPropagation(); dockSession(draggingSession, index, "top"); }} /><button className="dock-right" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.stopPropagation(); dockSession(draggingSession, index, "right"); }} /><button className="dock-bottom" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.stopPropagation(); dockSession(draggingSession, index, "bottom"); }} /><button className="dock-left" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.stopPropagation(); dockSession(draggingSession, index, "left"); }} /></div>}</div>;
              })}
              {panes.length === 0 && <div className="terminal-empty"><TerminalSquare size={24} /><button onClick={() => void createTerminal(projectPath, { reuseExisting: false, shellId: settings.defaultShellId })}><Plus size={14} />{workbenchCopy.newTerminal}</button></div>}
            </div>
            {active && <div className="command-dock"><Search size={13} /><div><input aria-label={workbenchCopy.commandInput} value={commandText} placeholder={workbenchCopy.runCommandPlaceholder} onChange={(event) => setCommandText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); sendCommand(); } else if (event.key === "Tab" && ghost) { event.preventDefault(); setCommandText(ghost); } else if (event.key === "ArrowDown" && suggestions.length) { event.preventDefault(); setSuggestionIndex((value) => (value + 1) % suggestions.length); } else if (event.key === "ArrowUp" && suggestions.length) { event.preventDefault(); setSuggestionIndex((value) => (value - 1 + suggestions.length) % suggestions.length); } }} />{ghostSuffix && <span aria-hidden="true"><b>{commandText}</b>{ghostSuffix}</span>}</div><button title={workbenchCopy.runCommand} disabled={!commandText.trim()} onClick={() => sendCommand()}><ChevronRight size={14} /></button></div>}
          </div>
          {view === "settings" && <SettingsPanel settings={settings} shells={shells} cliTools={cliTools} cliLifecycleStatus={cliLifecycleStatus} cliLifecycleBusy={cliLifecycleBusy} onChange={onSettingsChange} onCliLifecycleToggle={onCliLifecycleToggle} onClose={() => setView("terminal")} />}
          {view === "document" && document && <DocumentViewer document={document} onClose={() => setView("terminal")} />}
        </section>
        {terminalView && drawer && settings.resizablePanels && <div className="panel-resizer drawer-resizer" onPointerDown={(event) => resizePanel("drawer", event)} />}
        {terminalView && drawer === "files" && project && <FilesDrawer root={projectPath} onClose={() => setDrawer(null)} onNewTerminal={(path) => void createTerminal(path, { reuseExisting: false, shellId: settings.defaultShellId })} onDocument={(next) => { setDocument(next); setDrawer(null); setView("document"); }} onError={onError} />}
        {terminalView && drawer === "git" && project && <GitDrawer root={projectPath} onClose={() => setDrawer(null)} onError={onError} />}
        {terminalView && drawer === "sftp" && selectedSsh && <SftpDrawer profile={selectedSsh} onClose={() => setDrawer(null)} onError={onError} />}
      </div>
      {notice && <button className="terminal-notice" onClick={() => { assignSession(notice.sessionId); setNotice(undefined); }}><Bell size={15} /><span><strong>{notice.title}</strong><small>{notice.message}</small></span><ChevronLeft size={13} /></button>}
      {paletteOpen && <CommandPalette actions={paletteActions} onClose={() => setPaletteOpen(false)} />}
      {sshEditor && <SshEditor profile={sshEditor === "new" ? undefined : sshEditor} onClose={() => setSshEditor(undefined)} onError={onError} onSave={async (profile) => { const saved = await window.codex.saveSshProfile(profile); setSshEditor(undefined); await refreshSshProfiles(); setSelectedSsh(saved); }} onDelete={async (id) => { await window.codex.deleteSshProfile(id); setSshEditor(undefined); await refreshSshProfiles(); }} />}
    </main>
  );
}
