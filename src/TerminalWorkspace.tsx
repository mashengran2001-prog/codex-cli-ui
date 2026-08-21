import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Bell, Bot, ChevronDown, ChevronLeft, ChevronRight, CircleX, Columns2, Command, Copy,
  FolderOpen, FolderTree, GitBranch, GitFork, Globe2, GripVertical, LoaderCircle, PanelLeftClose,
  PanelLeftOpen, Pencil, Plus, RefreshCw, Rows2, Search, Server, Settings2, SquareTerminal, TerminalSquare, TriangleAlert, Upload, X,
  RotateCcw,
} from "lucide-react";
import BrandIcon from "./BrandIcon";
import type { AppSettings, CliLifecycleStatus, CliToolInfo, DocumentFile, ProjectRecord, ShellProfile, SshProfile, TerminalEvent, TerminalInfo } from "./types";
import { getWorkbenchCopy } from "./i18n";
import { keybindingMatches } from "./keybindings";
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
  onAddProject(): Promise<boolean>;
  onError(message: string): void;
}

type Drawer = "files" | "git" | "sftp" | null;
type WorkspaceView = "terminal" | "settings" | "document";
type SplitDirection = "columns" | "rows";
type DockEdge = "center" | "left" | "right" | "top" | "bottom";

interface PaneLeaf {
  type: "leaf";
  sessionId: string;
}

interface PaneSplit {
  type: "split";
  direction: SplitDirection;
  children: PaneNode[];
  /** Optional flex percentages (sum ≈ 100). Absent means equal split. */
  sizes?: number[];
}

type PaneNode = PaneLeaf | PaneSplit;

interface SavedLayout {
  tree?: PaneNode | null;
  activeSessionId?: string | null;
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

const layoutKey = "codex-cli-ui:terminal-layout-v4";
const renameKey = "codex-cli-ui:terminal-renames-v1";
const colorKey = "codex-cli-ui:terminal-colors-v1";
const stageDockId = "_stage";

const TAB_COLORS = ["#e06c75", "#d19a66", "#e5c07b", "#98c379", "#56b6c2", "#61afef", "#c678dd"];

function loadLayout(): SavedLayout {
  try { return JSON.parse(localStorage.getItem(layoutKey) || "{}") as SavedLayout; }
  catch { return {}; }
}

function samePath(left: string, right: string) {
  return left.replace(/[\\/]+$/, "").toLowerCase() === right.replace(/[\\/]+$/, "").toLowerCase();
}

function leafCount(node: PaneNode | null): number {
  if (!node) return 0;
  if (node.type === "leaf") return 1;
  return node.children.reduce((sum, child) => sum + leafCount(child), 0);
}

function collectLeafIds(node: PaneNode | null): string[] {
  if (!node) return [];
  if (node.type === "leaf") return [node.sessionId];
  return node.children.flatMap(collectLeafIds);
}

function nodeKey(node: PaneNode): string {
  return node.type === "leaf" ? node.sessionId : collectLeafIds(node).join(",");
}

function containsLeaf(node: PaneNode | null, sessionId: string): boolean {
  return collectLeafIds(node).includes(sessionId);
}

function rebuildSplit(node: PaneSplit, children: PaneNode[], keepSizes: boolean): PaneSplit {
  const sizes = keepSizes && node.sizes && node.sizes.length === children.length ? node.sizes : undefined;
  return sizes ? { type: "split", direction: node.direction, children, sizes } : { type: "split", direction: node.direction, children };
}

function removeLeaf(node: PaneNode | null, sessionId: string): PaneNode | null {
  if (!node) return null;
  if (node.type === "leaf") return node.sessionId === sessionId ? null : node;
  const children = node.children
    .map((child) => removeLeaf(child, sessionId))
    .filter((child): child is PaneNode => child !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  return rebuildSplit(node, children, false);
}

function replaceLeaf(node: PaneNode | null, targetId: string, newSessionId: string): PaneNode | null {
  if (!node) return { type: "leaf", sessionId: newSessionId };
  if (node.type === "leaf") return node.sessionId === targetId ? { type: "leaf", sessionId: newSessionId } : node;
  const children = node.children.map((child) => replaceLeaf(child, targetId, newSessionId)).filter((child): child is PaneNode => child !== null);
  return rebuildSplit(node, children, true);
}

function splitLeaf(node: PaneNode | null, targetId: string, direction: SplitDirection, newSessionId: string): PaneNode | null {
  const leaf: PaneNode = { type: "leaf", sessionId: newSessionId };
  if (!node) return leaf;
  if (node.type === "leaf") return node.sessionId === targetId ? { type: "split", direction, children: [node, leaf] } : node;
  const children = node.children.map((child) => splitLeaf(child, targetId, direction, newSessionId)).filter((child): child is PaneNode => child !== null);
  return rebuildSplit(node, children, true);
}

function insertLeafAt(node: PaneNode | null, targetId: string, edge: DockEdge, draggedId: string): PaneNode | null {
  const dragged: PaneNode = { type: "leaf", sessionId: draggedId };
  if (!node) return dragged;
  const direction: SplitDirection = edge === "left" || edge === "right" ? "columns" : "rows";
  const before = edge === "left" || edge === "top";
  const walk = (current: PaneNode): PaneNode => {
    if (current.type === "leaf") {
      if (current.sessionId !== targetId) return current;
      return { type: "split", direction, children: before ? [dragged, current] : [current, dragged] };
    }
    return rebuildSplit(current, current.children.map(walk), true);
  };
  return walk(node);
}

function dockLeaf(node: PaneNode | null, draggedId: string, targetId: string, edge: DockEdge): PaneNode | null {
  if (edge === "center" || draggedId === targetId) return node;
  const without = removeLeaf(node, draggedId);
  return insertLeafAt(without, targetId, edge, draggedId);
}

function pruneTree(node: PaneNode | null, validIds: ReadonlySet<string>): PaneNode | null {
  if (!node) return null;
  if (node.type === "leaf") return validIds.has(node.sessionId) ? node : null;
  const children = node.children
    .map((child) => pruneTree(child, validIds))
    .filter((child): child is PaneNode => child !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  return rebuildSplit(node, children, children.length === node.children.length);
}

function activeLeafId(node: PaneNode | null, fallback: string | null): string | null {
  if (!node) return null;
  const ids = collectLeafIds(node);
  return ids.includes(fallback ?? "") ? fallback : ids[0];
}

function findSplit(node: PaneNode | null, splitKey: string): PaneSplit | null {
  if (!node) return null;
  if (node.type === "split") {
    if (collectLeafIds(node).join(",") === splitKey) return node;
    for (const child of node.children) {
      const found = findSplit(child, splitKey);
      if (found) return found;
    }
  }
  return null;
}

/** Adjust the sizes of a single divider pair (index, index + 1) inside a split node. */
function updateSplitSizes(node: PaneNode | null, splitKey: string, index: number, deltaPct: number): PaneNode | null {
  if (!node) return node;
  if (node.type === "leaf") return node;
  if (collectLeafIds(node).join(",") !== splitKey) {
    const children = node.children.map((child) => updateSplitSizes(child, splitKey, index, deltaPct)).filter((child): child is PaneNode => child !== null);
    return { ...node, children };
  }
  const count = node.children.length;
  const sizes = node.sizes ? [...node.sizes] : Array.from({ length: count }, () => 100 / count);
  if (index < 0 || index + 1 >= count) return node;
  const pairTotal = sizes[index] + sizes[index + 1];
  const minPct = pairTotal * 0.12;
  const maxPct = pairTotal * 0.88;
  sizes[index] = Math.min(maxPct, Math.max(minPct, sizes[index] + deltaPct));
  sizes[index + 1] = Math.max(minPct, Math.min(maxPct, pairTotal - sizes[index]));
  sizes[index] = pairTotal - sizes[index + 1];
  return { ...node, sizes };
}

function legacyPanesToTree(panes: string[], direction: SplitDirection): PaneNode | null {
  if (panes.length === 0) return null;
  if (panes.length === 1) return { type: "leaf", sessionId: panes[0] };
  const leaf = (sessionId: string): PaneNode => ({ type: "leaf", sessionId });
  if (panes.length === 2) return { type: "split", direction, children: panes.map(leaf) };
  const top: PaneNode = { type: "split", direction: "columns", children: panes.slice(0, 2).map(leaf) };
  const bottom: PaneNode = panes.length === 3 ? leaf(panes[2]) : { type: "split", direction: "columns", children: panes.slice(2, 4).map(leaf) };
  return { type: "split", direction: "rows", children: [top, bottom] };
}

function migrateLayout(layout: SavedLayout): { tree: PaneNode | null; activeSessionId: string | null } {
  if (layout.tree) return { tree: layout.tree, activeSessionId: layout.activeSessionId ?? null };
  const panes = (layout.panes || []).filter(Boolean).slice(0, 4);
  const tree = legacyPanesToTree(panes, layout.splitDirection || "columns");
  const activeIndex = Math.max(0, Math.min(layout.activePane ?? 0, panes.length - 1));
  return { tree, activeSessionId: panes[activeIndex] ?? null };
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
  const initialPaneState = useMemo(() => migrateLayout(initialLayout), [initialLayout]);
  const workbenchCopy = getWorkbenchCopy(settings.language);
  const [sessions, setSessions] = useState<TerminalInfo[]>([]);
  const [paneTree, setPaneTree] = useState<PaneNode | null>(initialPaneState.tree);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(initialPaneState.activeSessionId);
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
  const [renames, setRenames] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem(renameKey) || "{}") as Record<string, string>; }
    catch { return {}; }
  });
  const [renamingSession, setRenamingSession] = useState<string>();
  const [renameDraft, setRenameDraft] = useState("");
  const [tabColors, setTabColors] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem(colorKey) || "{}") as Record<string, string>; }
    catch { return {}; }
  });
  const [tabMenu, setTabMenu] = useState<{ sessionId: string; x: number; y: number }>();
  const [dockTarget, setDockTarget] = useState<{ sessionId: string; edge: DockEdge } | null>(null);
  const [commandText, setCommandText] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const tabDragXRef = useRef(0);
  const tabScrollFrameRef = useRef(0);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [windowFocused, setWindowFocused] = useState(window.document.hasFocus());
  const [terminalStateLoaded, setTerminalStateLoaded] = useState(false);
  const sessionsRef = useRef(sessions);
  const treeRef = useRef(paneTree);
  const activeSessionIdRef = useRef(activeSessionId);
  const mountedRef = useRef(true);
  const paneResizeRef = useRef<{ splitKey: string; index: number; startX: number; startY: number; startSizes: number[]; direction: SplitDirection; containerSize: number } | null>(null);
  const paneResizeCleanupRef = useRef<(() => void) | null>(null);
  const [paneResizing, setPaneResizing] = useState(false);

  const visibleIds = collectLeafIds(paneTree);
  const activeId = activeSessionId && containsLeaf(paneTree, activeSessionId) ? activeSessionId : visibleIds[0] ?? null;
  const active = sessions.find((session) => session.id === activeId);
  const projectPath = project?.path ?? "";
  const projectLabel = project?.name ?? "CLI Workbench";
  useEffect(() => { sessionsRef.current = sessions; }, [sessions]);
  useEffect(() => { treeRef.current = paneTree; }, [paneTree]);
  useEffect(() => { activeSessionIdRef.current = activeSessionId; }, [activeSessionId]);
  useEffect(() => {
    setActiveSessionId((current) => (current && containsLeaf(treeRef.current, current) ? current : activeLeafId(treeRef.current, null)));
  }, [paneTree]);
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
    localStorage.setItem(layoutKey, JSON.stringify({ tree: paneTree, activeSessionId, sidebarWidth, drawerWidth, sidebarCollapsed, tabsCollapsed, toolsCollapsed, sshCollapsed } satisfies SavedLayout));
  }, [activeSessionId, drawerWidth, paneTree, sidebarCollapsed, sidebarWidth, sshCollapsed, tabsCollapsed, toolsCollapsed]);

  const assignSession = useCallback((id: string, targetId?: string) => {
    setView("terminal");
    onWorkspaceModeChange("terminal");
    setPaneTree((current) => {
      if (!current) return { type: "leaf", sessionId: id };
      if (containsLeaf(current, id)) return current;
      const anchor = targetId ?? activeLeafId(current, activeSessionIdRef.current) ?? collectLeafIds(current)[0] ?? "";
      return replaceLeaf(current, anchor, id);
    });
    setActiveSessionId(id);
    setUnread((current) => { const next = new Set(current); next.delete(id); return next; });
  }, [onWorkspaceModeChange]);

  const createTerminal = useCallback(async (path: string, options: { reuseExisting?: boolean; shellId?: string; profileId?: string; sshProfileId?: string; title?: string; activate?: boolean } = {}) => {
    if (!path) { onError(workbenchCopy.chooseDirectoryFirst); return null; }
    try {
      const session = await window.codex.createTerminal({ cwd: path, cols: 100, rows: 30, reuseExisting: options.reuseExisting, shellId: options.shellId, profileId: options.profileId, sshProfileId: options.sshProfileId, title: options.title });
      if (!mountedRef.current) { await window.codex.detachTerminal(session.id); return null; }
      setSessions((current) => {
        if (current.some((item) => item.id === session.id)) return current.map((item) => item.id === session.id ? session : item);
        if (settings.newTabPlacement === "end") return [...current, session];
        const activeIndex = current.findIndex((item) => item.id === activeSessionIdRef.current);
        const insertAt = activeIndex >= 0 ? activeIndex + 1 : current.length;
        const next = [...current];
        next.splice(insertAt, 0, session);
        return next;
      });
      if (options.activate !== false) assignSession(session.id);
      return session;
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : workbenchCopy.createTerminalFailed);
      return null;
    }
  }, [assignSession, onError, settings.newTabPlacement, workbenchCopy]);

  const refreshSshProfiles = useCallback(() => window.codex.listSshProfiles().then(setSshProfiles).catch((reason) => onError(reason instanceof Error ? reason.message : workbenchCopy.loadSshFailed)), [onError, workbenchCopy]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([window.codex.listShells(), window.codex.listCliTools(), window.codex.listSshProfiles(), window.codex.listTerminals()]).then(([shellItems, toolItems, sshItems, terminalItems]) => {
      if (cancelled) return;
      setShells(shellItems);
      setCliTools(toolItems);
      setSshProfiles(sshItems);
      setSessions(terminalItems);
      const validIds = new Set(terminalItems.map((item) => item.id));
      setPaneTree((current) => {
        const pruned = pruneTree(current, validIds);
        if (leafCount(pruned) <= 4) return pruned;
        return pruneTree(pruned, new Set(collectLeafIds(pruned).slice(0, 4)));
      });
      setTerminalStateLoaded(true);
    }).catch((reason) => onError(reason instanceof Error ? reason.message : workbenchCopy.restoreTerminalFailed));
    return () => { cancelled = true; };
  }, [onError, workbenchCopy]);

  useEffect(() => {
    if (typeof window.codex.onShellsChanged !== "function") return undefined;
    return window.codex.onShellsChanged(setShells);
  }, []);

  useEffect(() => {
    if (!terminalStateLoaded || workspaceMode !== "terminal" || !projectPath) return;
    const currentIds = collectLeafIds(treeRef.current).filter((id) => sessionsRef.current.some((session) => session.id === id));
    if (currentIds.some((id) => {
      const session = sessionsRef.current.find((item) => item.id === id);
      return session && samePath(session.cwd, projectPath);
    })) return;
    const preferred = sessionsRef.current.find((item) => item.status === "running" && samePath(item.cwd, projectPath));
    if (preferred) assignSession(preferred.id);
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
      if (previous?.activity === "running" && event.terminal.activity === "idle" && event.sessionId !== activeSessionIdRef.current) {
        setUnread((current) => new Set(current).add(event.sessionId));
        setNotice({ sessionId: event.sessionId, title: event.terminal.title, message: event.terminal.lastCommandDuration ? workbenchCopy.completedIn(Math.max(1, Math.round(event.terminal.lastCommandDuration / 1000))) : workbenchCopy.completed });
      }
    } else if (event.type === "data") {
      setSessions((current) => current.map((item) => item.id === event.sessionId ? { ...item, updatedAt: Date.now() } : item));
      if (!containsLeaf(treeRef.current, event.sessionId)) setUnread((current) => new Set(current).add(event.sessionId));
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

  const splitPane = useCallback(async (direction: SplitDirection, sessionId?: string, anchorId?: string) => {
    if (leafCount(treeRef.current) >= 4) { onError(workbenchCopy.maxPanes); return; }
    let id = sessionId;
    if (!id || containsLeaf(treeRef.current, id)) {
      const current = sessionsRef.current.find((item) => item.id === activeSessionIdRef.current);
      const created = await createTerminal(current?.cwd || projectPath, { reuseExisting: false, shellId: settings.defaultShellId, activate: false });
      id = created?.id;
    }
    if (!id) return;
    setPaneTree((current) => {
      if (!current) return { type: "leaf", sessionId: id! };
      if (containsLeaf(current, id!)) return current;
      const anchor = anchorId && containsLeaf(current, anchorId) ? anchorId : activeLeafId(current, activeSessionIdRef.current) ?? collectLeafIds(current)[0];
      return splitLeaf(current, anchor, direction, id!);
    });
    setActiveSessionId(id);
    setView("terminal");
    onWorkspaceModeChange("terminal");
  }, [createTerminal, onError, onWorkspaceModeChange, projectPath, settings.defaultShellId, workbenchCopy]);

  const focusPane = useCallback((offset: number) => {
    const ids = collectLeafIds(treeRef.current);
    if (ids.length < 2) return;
    const index = ids.indexOf(activeSessionIdRef.current ?? "");
    const next = ids[(index < 0 ? 0 : index + offset + ids.length) % ids.length];
    setActiveSessionId(next);
    setView("terminal");
    onWorkspaceModeChange("terminal");
  }, [onWorkspaceModeChange]);

  const startPaneResize = (event: React.PointerEvent<HTMLDivElement>, splitKey: string, index: number) => {
    event.preventDefault();
    const splitEl = event.currentTarget.closest<HTMLElement>("[data-pane-split-key]");
    const splitNode = findSplit(treeRef.current, splitKey);
    if (!splitEl || !splitNode) return;
    const rect = splitEl.getBoundingClientRect();
    const count = splitNode.children.length;
    const startSizes = splitNode.sizes ? [...splitNode.sizes] : Array.from({ length: count }, () => 100 / count);
    const direction = splitNode.direction;
    paneResizeRef.current = { splitKey, index, startX: event.clientX, startY: event.clientY, startSizes, direction, containerSize: direction === "columns" ? rect.width : rect.height };
    setPaneResizing(true);
    window.document.body.style.cursor = direction === "columns" ? "col-resize" : "row-resize";
    window.document.body.style.userSelect = "none";
    const move = (pointer: PointerEvent) => {
      const ref = paneResizeRef.current;
      if (!ref) return;
      const delta = ref.direction === "columns" ? pointer.clientX - ref.startX : pointer.clientY - ref.startY;
      const deltaPct = ref.containerSize > 0 ? (delta / ref.containerSize) * 100 : 0;
      setPaneTree((current) => updateSplitSizes(current, ref.splitKey, ref.index, deltaPct));
    };
    const up = () => {
      paneResizeRef.current = null;
      paneResizeCleanupRef.current = null;
      setPaneResizing(false);
      window.document.body.style.cursor = "";
      window.document.body.style.userSelect = "";
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    paneResizeCleanupRef.current = up;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const cancelPaneResize = () => {
    paneResizeCleanupRef.current?.();
  };

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (keybindingMatches(event, settings.keybindings["command-palette"])) { event.preventDefault(); setPaletteOpen(true); }
      else if (keybindingMatches(event, settings.keybindings["new-terminal"])) { event.preventDefault(); void createTerminal(active?.cwd || projectPath, { shellId: settings.defaultShellId }); }
      else if (keybindingMatches(event, settings.keybindings["split-right"])) { event.preventDefault(); void splitPane("columns"); }
      else if (keybindingMatches(event, settings.keybindings["split-down"])) { event.preventDefault(); void splitPane("rows"); }
      else if (keybindingMatches(event, settings.keybindings["pane-next"])) { event.preventDefault(); focusPane(1); }
      else if (keybindingMatches(event, settings.keybindings["pane-prev"])) { event.preventDefault(); focusPane(-1); }
      else if (keybindingMatches(event, settings.keybindings["open-settings"])) { event.preventDefault(); setDrawer(null); setView("settings"); }
      else if (event.key === "Escape") {
        if (paneResizing) { event.preventDefault(); cancelPaneResize(); return; }
        setPaletteOpen(false);
        setRenamingSession(undefined);
        setTabMenu(undefined);
      }
    };
    // Capture phase so app shortcuts still run while an xterm textarea is focused
    // (xterm consumes arrow keys and stops propagation during bubbling).
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [active?.cwd, cancelPaneResize, createTerminal, focusPane, paneResizing, projectPath, settings.defaultShellId, settings.keybindings, splitPane]);

  useEffect(() => {
    if (!tabMenu) return;
    const handler = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) return;
      if (event.target.closest(".terminal-tab-menu")) return;
      setTabMenu(undefined);
    };
    window.addEventListener("pointerdown", handler, true);
    return () => window.removeEventListener("pointerdown", handler, true);
  }, [tabMenu]);

  useEffect(() => {
    if (!settings.completionEnabled || !active || !commandText.trim()) { setSuggestions([]); return; }
    let cancelled = false;
    const timeout = window.setTimeout(async () => {
      const history = await window.codex.getCommandHistory(commandText, active.cwd);
      if (!cancelled) { setSuggestions(history); setSuggestionIndex(0); }
    }, 90);
    return () => { cancelled = true; window.clearTimeout(timeout); };
  }, [active?.cwd, active?.id, commandText, settings.completionEnabled]);

  const closePane = (sessionId: string) => {
    setPaneTree((current) => removeLeaf(current, sessionId));
    setActiveSessionId((current) => (current === sessionId ? null : current));
  };

  const closeTerminal = async (id: string) => {
    if (!await window.codex.closeTerminal(id)) return;
    const index = sessions.findIndex((item) => item.id === id);
    const remaining = sessions.filter((item) => item.id !== id);
    setSessions(remaining);
    const closingVisible = containsLeaf(treeRef.current, id);
    setPaneTree((current) => removeLeaf(current, id));
    if (remaining.length === 0) {
      setActiveSessionId((current) => (current === id ? null : current));
      if (projectPath) void createTerminal(projectPath, { reuseExisting: false, shellId: settings.defaultShellId });
      return;
    }
    if (closingVisible && leafCount(treeRef.current) === 1) {
      const fallback = remaining[Math.min(index, remaining.length - 1)];
      if (fallback) {
        setPaneTree({ type: "leaf", sessionId: fallback.id });
        setActiveSessionId(fallback.id);
        return;
      }
    }
    setActiveSessionId((current) => (current === id ? null : current));
  };

  const dropSessionState = (id: string) => {
    setRenames((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      try { localStorage.setItem(renameKey, JSON.stringify(next)); } catch { /* Renames are cosmetic and safe to drop. */ }
      return next;
    });
    setTabColors((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      try { localStorage.setItem(colorKey, JSON.stringify(next)); } catch { /* Colors are cosmetic and safe to drop. */ }
      return next;
    });
    setUnread((current) => { const next = new Set(current); next.delete(id); return next; });
  };

  const restartSsh = async (session: TerminalInfo) => {
    if (!session.sshProfileId) return;
    await window.codex.closeTerminal(session.id);
    setSessions((current) => current.filter((item) => item.id !== session.id));
    setPaneTree((current) => removeLeaf(current, session.id));
    dropSessionState(session.id);
    await createTerminal(session.cwd, { reuseExisting: false, sshProfileId: session.sshProfileId, shellId: settings.defaultShellId });
  };

  const resumeAiSession = async (id: string) => {
    try {
      await window.codex.resumeAiSession(id);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : workbenchCopy.resumeAiSession);
    }
    setTabMenu(undefined);
    assignSession(id);
  };

  const forkAiSession = async (id: string) => {
    const source = sessions.find((session) => session.id === id);
    setTabMenu(undefined);
    if (!source) return;
    try {
      const session = await window.codex.forkAiSession({ sessionId: id, cols: 100, rows: 30 });
      if (!mountedRef.current) { await window.codex.detachTerminal(session.id); return; }
      setSessions((current) => {
        if (current.some((item) => item.id === session.id)) return current;
        if (settings.newTabPlacement === "end") return [...current, session];
        const activeIndex = current.findIndex((item) => item.id === activeSessionIdRef.current);
        const insertAt = activeIndex >= 0 ? activeIndex + 1 : current.length;
        const next = [...current];
        next.splice(insertAt, 0, session);
        return next;
      });
      assignSession(session.id);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : workbenchCopy.createTerminalFailed);
    }
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

  const persistRenames = (next: Record<string, string>) => {
    setRenames(next);
    try { localStorage.setItem(renameKey, JSON.stringify(next)); } catch { /* Renames are cosmetic and safe to drop. */ }
  };

  const setTabColor = (sessionId: string, color?: string) => {
    setTabColors((current) => {
      const next = { ...current };
      if (color) next[sessionId] = color;
      else delete next[sessionId];
      try { localStorage.setItem(colorKey, JSON.stringify(next)); } catch { /* Colors are cosmetic and safe to drop. */ }
      return next;
    });
    setTabMenu(undefined);
  };

  const startRename = (sessionId: string) => {
    setRenamingSession(sessionId);
    setRenameDraft(renames[sessionId] || sessions.find((item) => item.id === sessionId)?.title || "");
    setTabMenu(undefined);
  };

  const commitRename = () => {
    if (renamingSession) {
      const next = { ...renames };
      const value = renameDraft.trim();
      if (value) next[renamingSession] = value;
      else delete next[renamingSession];
      persistRenames(next);
    }
    setRenamingSession(undefined);
  };

  const tabDisplayTitle = (session: TerminalInfo) => renames[session.id] || session.title;

  useEffect(() => {
    if (!draggingSession) {
      cancelAnimationFrame(tabScrollFrameRef.current);
      return;
    }
    const tick = () => {
      const strip = window.document.querySelector<HTMLElement>(".terminal-top-tabs");
      if (!strip || !draggingSession) return;
      const rect = strip.getBoundingClientRect();
      const edge = 44;
      const left = Math.max(0, edge - (tabDragXRef.current - rect.left));
      const right = Math.max(0, edge - (rect.right - tabDragXRef.current));
      const speed = Math.min(18, Math.max(3, (left || right) / 3));
      if (left > 0) strip.scrollLeft -= speed;
      else if (right > 0) strip.scrollLeft += speed;
      tabScrollFrameRef.current = requestAnimationFrame(tick);
    };
    tabScrollFrameRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(tabScrollFrameRef.current);
  }, [draggingSession]);

  const dockSession = (sessionId: string, targetId: string, edge: DockEdge) => {
    if (edge === "center") { assignSession(sessionId, targetId); return; }
    if (leafCount(treeRef.current) >= 4) { assignSession(sessionId, targetId); return; }
    setPaneTree((current) => dockLeaf(current, sessionId, targetId, edge));
    setActiveSessionId(sessionId);
    setView("terminal");
  };

  const dockToStage = (sessionId: string, edge: DockEdge) => {
    if (edge === "center") { assignSession(sessionId); return; }
    if (leafCount(treeRef.current) >= 4) { assignSession(sessionId); return; }
    setPaneTree((current) => {
      const rest = removeLeaf(current, sessionId);
      const dragged: PaneNode = { type: "leaf", sessionId };
      if (!rest) return dragged;
      const direction: SplitDirection = edge === "left" || edge === "right" ? "columns" : "rows";
      return { type: "split", direction, children: edge === "left" || edge === "top" ? [dragged, rest] : [rest, dragged] };
    });
    setActiveSessionId(sessionId);
    setView("terminal");
  };

  const handlePaneDragOver = (event: React.DragEvent<HTMLDivElement>, sessionId: string) => {
    if (!draggingSession || draggingSession === sessionId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return;
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    const zone = 0.26;
    let edge: DockEdge = "center";
    if (x < zone) edge = "left";
    else if (x > 1 - zone) edge = "right";
    else if (y < zone) edge = "top";
    else if (y > 1 - zone) edge = "bottom";
    setDockTarget((current) => (current?.sessionId === sessionId && current.edge === edge ? current : { sessionId, edge }));
  };

  const handlePaneDrop = (event: React.DragEvent<HTMLDivElement>, sessionId: string) => {
    event.preventDefault();
    event.stopPropagation();
    const id = event.dataTransfer.getData("text/terminal-session");
    const edge = dockTarget?.sessionId === sessionId ? dockTarget.edge : "center";
    setDockTarget(null);
    if (!id) return;
    dockSession(id, sessionId, edge);
  };

  const isOverPaneLeaf = (event: React.DragEvent<HTMLDivElement>) => {
    const target = event.target as Element | null;
    return Boolean(target?.closest?.(".terminal-pane-leaf"));
  };

  const handleStageDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!draggingSession || isOverPaneLeaf(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return;
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    const zone = 0.18;
    let edge: DockEdge = "center";
    if (x < zone) edge = "left";
    else if (x > 1 - zone) edge = "right";
    else if (y < zone) edge = "top";
    else if (y > 1 - zone) edge = "bottom";
    setDockTarget((current) => (current?.sessionId === stageDockId && current.edge === edge ? current : { sessionId: stageDockId, edge }));
  };

  const handleStageDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (isOverPaneLeaf(event)) return;
    event.preventDefault();
    const id = event.dataTransfer.getData("text/terminal-session");
    const edge = dockTarget?.sessionId === stageDockId ? dockTarget.edge : "center";
    setDockTarget(null);
    if (!id) return;
    dockToStage(id, edge);
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
  const activateWorkspaceMode = async (mode: "chat" | "terminal") => {
    if (mode === "terminal" && !projectPath) {
      if (await onAddProject()) onWorkspaceModeChange("terminal");
      return;
    }
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

  const renderPaneNode = (node: PaneNode): ReactNode => {
    if (node.type === "split") {
      const splitKey = collectLeafIds(node).join(",");
      return (
        <div className={`terminal-pane-split ${node.direction}`} data-pane-split-key={splitKey} key={`${node.direction}:${splitKey}`}>
          {node.children.map((child, index) => (
            <Fragment key={nodeKey(child)}>
              {index > 0 && <div className={`pane-divider ${node.direction}`} onPointerDown={(event) => startPaneResize(event, splitKey, index - 1)} />}
              <div className="pane-slot" style={{ flex: node.sizes ? `0 1 ${node.sizes[index]}%` : "1 1 0" }}>
                {renderPaneNode(child)}
              </div>
            </Fragment>
          ))}
        </div>
      );
    }
    const session = sessions.find((item) => item.id === node.sessionId);
    if (!session) return null;
    const isActive = activeId === session.id;
    const hoverEdge = dockTarget?.sessionId === session.id ? dockTarget.edge : null;
    return (
      <div
        className={`terminal-pane-leaf ${isActive ? "active" : ""}${hoverEdge ? ` dock-${hoverEdge}` : ""}`}
        data-session-id={session.id}
        key={session.id}
        onDragOver={(event) => handlePaneDragOver(event, session.id)}
        onDrop={(event) => handlePaneDrop(event, session.id)}
      >
        <div className="pane-toolbar">
          <span>{terminalIcon(session)}<strong>{tabDisplayTitle(session)}</strong><small>{session.remoteHost || session.cwd}</small>{session.activity === "attention" && <i />}</span>
          <span className="pane-toolbar-actions">
            <button aria-label={workbenchCopy.splitPaneRight} title={workbenchCopy.splitPaneRight} onClick={() => void splitPane("columns", session.id, session.id)}><Columns2 size={11} /></button>
            <button aria-label={workbenchCopy.splitPaneDown} title={workbenchCopy.splitPaneDown} onClick={() => void splitPane("rows", session.id, session.id)}><Rows2 size={11} /></button>
            {leafCount(paneTree) > 1 && <button aria-label={workbenchCopy.closePane} title={workbenchCopy.closePane} onClick={() => closePane(session.id)}><X size={11} /></button>}
          </span>
        </div>
        <TerminalPane session={session} theme={settings.theme} cursorStyle={settings.cursorStyle} cursorBlink={settings.cursorBlink} fontFamily={settings.fontFamily} copyOnSelect={settings.copyOnSelect} active={isActive && terminalView && windowFocused} onFocus={() => { setActiveSessionId(session.id); setUnread((current) => { const next = new Set(current); next.delete(session.id); return next; }); }} />
        {draggingSession && draggingSession !== session.id && <div className="dock-overlay">
          <button className={`dock-top${hoverEdge === "top" ? " active" : ""}`} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.stopPropagation(); dockSession(draggingSession, session.id, "top"); }} />
          <button className={`dock-right${hoverEdge === "right" ? " active" : ""}`} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.stopPropagation(); dockSession(draggingSession, session.id, "right"); }} />
          <button className={`dock-bottom${hoverEdge === "bottom" ? " active" : ""}`} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.stopPropagation(); dockSession(draggingSession, session.id, "bottom"); }} />
          <button className={`dock-left${hoverEdge === "left" ? " active" : ""}`} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.stopPropagation(); dockSession(draggingSession, session.id, "left"); }} />
        </div>}
      </div>
    );
  };

  const tabMenuSession = tabMenu ? sessions.find((session) => session.id === tabMenu.sessionId) : undefined;

  return (
    <main className="terminal-workspace" data-terminal-theme={settings.theme} data-density={settings.density} data-workspace-view={view} data-window-focused={windowFocused} style={{ "--terminal-sidebar-width": `${sidebarWidth}px`, "--terminal-drawer-width": `${drawerWidth}px`, "--terminal-bg-opacity": settings.backgroundOpacity, "--terminal-bg-image": pathToCssUrl(settings.backgroundImage) } as React.CSSProperties}>
      <header className="terminal-header">
        <div className="terminal-heading">
          <span className="terminal-brand">{view === "settings" ? <Settings2 size={17} /> : chatView ? <Bot size={17} /> : <TerminalSquare size={17} />}</span>
          <div>
            <h1 aria-label={headingLabel}>{headingTitle}</h1>
            {project ? <button title={projectPath} onClick={() => void window.codex.revealPath(projectPath)}><FolderOpen size={11} /><span>{projectLabel}</span><small>{chatView ? providerName : active?.cwd || projectPath}</small></button> : <button title={workbenchCopy.selectDirectory} onClick={() => void onAddProject()}><FolderOpen size={11} /><span>{workbenchCopy.selectDirectory}</span><small>{providerName}</small></button>}
          </div>
        </div>
        <div className="terminal-actions">
          {primaryView && <div className="workspace-view-switch" role="tablist" aria-label={workbenchCopy.viewSwitcher}>
            <button role="tab" aria-selected={workspaceMode === "chat"} className={workspaceMode === "chat" ? "active" : ""} title={workbenchCopy.chat} onClick={() => void activateWorkspaceMode("chat")}><Bot size={13} /><span>{workbenchCopy.chat}</span></button>
            <button role="tab" aria-selected={workspaceMode === "terminal"} className={workspaceMode === "terminal" ? "active" : ""} title={workbenchCopy.terminal} onClick={() => void activateWorkspaceMode("terminal")}><TerminalSquare size={13} /><span>{workbenchCopy.terminal}</span></button>
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
      {primaryView && terminalView && sessions.length > 0 && (
        <div className="terminal-top-tabs" role="tablist" aria-label={workbenchCopy.topTabs} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; tabDragXRef.current = event.clientX; }}>
          {sessions.map((session) => (
            <div
              className={`terminal-top-tab ${containsLeaf(paneTree, session.id) ? "active" : ""}`}
              data-session-id={session.id}
              data-tab-color={tabColors[session.id] || ""}
              key={session.id}
              draggable
              onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }}
              onAuxClick={(event) => { if (event.button !== 1) return; event.preventDefault(); event.stopPropagation(); void closeTerminal(session.id); }}
              onContextMenu={(event) => { event.preventDefault(); setTabMenu({ sessionId: session.id, x: event.clientX, y: event.clientY }); }}
              onDragStart={(event) => { setDraggingSession(session.id); event.dataTransfer.setData("text/terminal-session", session.id); event.dataTransfer.effectAllowed = "move"; }}
              onDragEnd={() => { setDraggingSession(undefined); setDockTarget(null); }}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => { event.preventDefault(); event.stopPropagation(); const source = event.dataTransfer.getData("text/terminal-session"); if (source) reorderSession(source, session.id); setDraggingSession(undefined); }}
            >
              {tabColors[session.id] && <i className="terminal-tab-color" style={{ background: tabColors[session.id] }} />}
              <button className="terminal-tab-main" title={session.cwd} onClick={() => assignSession(session.id)}>
                <span className={`terminal-state ${session.status} ${session.activity} ${unread.has(session.id) ? "unread" : ""}`}>{session.activity === "running" ? <LoaderCircle className="spin" size={11} /> : session.activity === "attention" ? <TriangleAlert size={11} /> : session.status === "exited" ? <CircleX size={11} /> : undefined}</span>
                {terminalIcon(session)}
                {renamingSession === session.id
                  ? <input className="terminal-rename-input" autoFocus value={renameDraft} aria-label={workbenchCopy.renameTerminal} placeholder={workbenchCopy.renameTabPlaceholder} onClick={(event) => event.stopPropagation()} onChange={(event) => setRenameDraft(event.target.value)} onBlur={commitRename} onKeyDown={(event) => { if (event.key === "Enter") commitRename(); else if (event.key === "Escape") setRenamingSession(undefined); }} />
                  : <span className="terminal-tab-title">{tabDisplayTitle(session)}</span>}
                {session.activity === "idle" && <em>{shellTag(session)}</em>}
              </button>
              {session.kind === "ssh" && session.exitedAt && <button className="terminal-tab-retry" title={workbenchCopy.xRetryTerminal} onClick={() => void restartSsh(session)}><RefreshCw size={11} /></button>}
              <button className="terminal-tab-close" title={workbenchCopy.closeTerminal} onClick={() => void closeTerminal(session.id)}><X size={11} /></button>
            </div>
          ))}
        </div>
      )}
      {tabMenu && (
        <div className="terminal-tab-menu" style={{ left: tabMenu.x, top: tabMenu.y }} onClick={(event) => event.stopPropagation()}>
          <button onClick={() => startRename(tabMenu.sessionId)}><Pencil size={12} />{workbenchCopy.renameTerminal}</button>
          <div className="terminal-tab-colors" role="group" aria-label={workbenchCopy.tabColor}>
            {TAB_COLORS.map((color) => <button key={color} className={tabColors[tabMenu.sessionId] === color ? "selected" : ""} title={workbenchCopy.tabColor} onClick={() => setTabColor(tabMenu.sessionId, color)} style={{ background: color }} />)}
            <button className="clear" title={workbenchCopy.clearTabColor} onClick={() => setTabColor(tabMenu.sessionId)}><X size={10} /></button>
          </div>
          {tabMenuSession?.aiSource && tabMenuSession.status === "running" && (tabMenuSession.aiSessionId || tabMenuSession.aiSource === "claude") && <button onClick={() => void resumeAiSession(tabMenu.sessionId)}><RotateCcw size={12} />{workbenchCopy.resumeAiSession}</button>}
          {tabMenuSession?.aiSource && tabMenuSession.aiSessionId && tabMenuSession.status === "running" && <button onClick={() => void forkAiSession(tabMenu.sessionId)}><GitFork size={12} />{workbenchCopy.forkAiSession}</button>}
          <button className="danger" onClick={() => { const id = tabMenu.sessionId; setTabMenu(undefined); void closeTerminal(id); }}><X size={12} />{workbenchCopy.closeTerminal}</button>
        </div>
      )}
      <div className="terminal-main">
        {showSidePanel && chatView && <aside className="terminal-side-panel chat-side-panel">{chatSidebar}</aside>}
        {showSidePanel && terminalView && <aside className="terminal-side-panel">
          <div className="side-section-heading"><button title={workbenchCopy.toggleTabs} onClick={() => setTabsCollapsed((value) => !value)}>{tabsCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}<strong>{workbenchCopy.tabs}</strong></button><span>{sessions.length}</span><button title={workbenchCopy.newTerminal} onClick={() => void createTerminal(active?.cwd || projectPath, { reuseExisting: false, shellId: settings.defaultShellId })}><Plus size={13} /></button></div>
          {!tabsCollapsed && <div className="terminal-side-tabs">{sessions.map((session) => <div className={`terminal-tab ${containsLeaf(paneTree, session.id) ? "active" : ""}`} data-session-id={session.id} data-tab-color={tabColors[session.id] || ""} key={session.id} draggable onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }} onAuxClick={(event) => { if (event.button !== 1) return; event.preventDefault(); event.stopPropagation(); void closeTerminal(session.id); }} onContextMenu={(event) => { event.preventDefault(); setTabMenu({ sessionId: session.id, x: event.clientX, y: event.clientY }); }} onDragStart={(event) => { setDraggingSession(session.id); event.dataTransfer.setData("text/terminal-session", session.id); }} onDragEnd={() => { setDraggingSession(undefined); setDockTarget(null); }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const source = event.dataTransfer.getData("text/terminal-session"); if (source) reorderSession(source, session.id); }}>{tabColors[session.id] && <i className="terminal-tab-color" style={{ background: tabColors[session.id] }} />}<button className="terminal-tab-main" title={session.cwd} onClick={() => assignSession(session.id)}><span className={`terminal-state ${session.status} ${session.activity} ${unread.has(session.id) ? "unread" : ""}`}>{session.activity === "running" ? <LoaderCircle className="spin" size={11} /> : session.activity === "attention" ? <TriangleAlert size={11} /> : session.status === "exited" ? <CircleX size={11} /> : undefined}</span>{terminalIcon(session)}<span><strong>{tabDisplayTitle(session)}</strong><small>{session.activity === "running" ? session.activeCommand : session.remoteHost || session.cwd}</small></span>{session.activity === "idle" && <em>{shellTag(session)}</em>}</button>{session.kind === "ssh" && session.exitedAt && <button className="terminal-tab-retry" title={workbenchCopy.xRetryTerminal} onClick={() => void restartSsh(session)}><RefreshCw size={11} /></button>}<button className="terminal-tab-close" title={workbenchCopy.closeTerminal} onClick={() => void closeTerminal(session.id)}><X size={11} /></button></div>)}</div>}
          <div className="side-section-heading cli-tools-heading"><button title={workbenchCopy.toggleCliTools} onClick={() => setToolsCollapsed((value) => !value)}>{toolsCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}<strong>{workbenchCopy.cliTools}</strong></button><span>{cliTools.length}</span><button title={workbenchCopy.cliToolSettings} onClick={openSettings}><Settings2 size={12} /></button></div>
          {!toolsCollapsed && <div className="cli-tool-list">{cliTools.map((tool) => <button className={tool.available ? "available" : "unavailable"} title={tool.available ? workbenchCopy.launchTool(tool.name) : tool.installCommand || workbenchCopy.toolNotDetected(tool.name)} onClick={() => void launchCliTool(tool)} key={tool.id}>{cliToolIcon(tool)}<span className="cli-tool-copy"><strong>{tool.name}</strong><small>{tool.available ? tool.description : workbenchCopy.toolNotInstalled}</small></span><i className={tool.available ? "online" : "offline"} /></button>)}</div>}
          <div className="side-section-heading ssh-heading"><button title={workbenchCopy.toggleSshHosts} onClick={() => setSshCollapsed((value) => !value)}>{sshCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}<strong>{workbenchCopy.sshHosts}</strong></button><span>{sshProfiles.length}</span><button title={workbenchCopy.newSshHost} onClick={() => setSshEditor("new")}><Plus size={13} /></button></div>
          {!sshCollapsed && <div className="ssh-host-list">{sshProfiles.map((profile) => <div key={profile.id}><button title={workbenchCopy.connectHost(profile.name)} onClick={() => void connectSsh(profile)}><Server size={13} /><span><strong>{profile.name}</strong><small>{profile.username ? `${profile.username}@${profile.host}` : profile.host}</small></span></button><button title={workbenchCopy.browseSftp} onClick={() => openSftp(profile)}><Upload size={11} /></button><button title={workbenchCopy.editSshHost} onClick={() => setSshEditor(profile)}><Settings2 size={11} /></button></div>)}{sshProfiles.length === 0 && <button className="empty-ssh" onClick={() => setSshEditor("new")}><Plus size={12} />{workbenchCopy.addSshHost}</button>}</div>}
        </aside>}
        {settings.resizablePanels && showSidePanel && <div className="panel-resizer sidebar-resizer" onPointerDown={(event) => resizePanel("sidebar", event)} />}
        {primaryView && sidebarCollapsed && <button className="restore-side-panel" title={workbenchCopy.showSidebar} onClick={() => setSidebarCollapsed(false)}><PanelLeftOpen size={14} /></button>}
        <section className="terminal-stage">
          {chatView && <div className="chat-session-view">{chatContent}</div>}
          <div className={`terminal-session-view ${terminalView ? "visible" : "hidden"}${dockTarget?.sessionId === stageDockId ? ` stage-dock-${dockTarget.edge}` : ""}`} aria-hidden={!terminalView} onDragOver={handleStageDragOver} onDrop={handleStageDrop}>
            <div className={`terminal-pane-tree${paneResizing ? " pane-resizing" : ""}`}>
              {paneTree ? renderPaneNode(paneTree) : <div className="terminal-empty"><TerminalSquare size={24} /><button onClick={() => void createTerminal(projectPath, { reuseExisting: false, shellId: settings.defaultShellId })}><Plus size={14} />{workbenchCopy.newTerminal}</button></div>}
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
