import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Bell, Bot, ChevronDown, ChevronLeft, ChevronRight, CircleX, Columns2, Command, Copy,
  Download, EllipsisVertical, FolderOpen, FolderTree, GitBranch, GitFork, Globe2, GripVertical, LoaderCircle, PanelLeftClose,
  PanelLeftOpen, Pencil, Plus, Radio, RefreshCw, Rows2, Search, Server, Settings2, SquareTerminal, TerminalSquare, TriangleAlert, Upload, X,
  RotateCcw, History,
  FileText, Folder,
} from "lucide-react";
import BrandIcon from "./BrandIcon";
import { sanitizeDisplayText } from "./text-encoding";
import type { AppSettings, CliLifecycleStatus, CliToolInfo, CompletionCandidate, DocumentFile, ProjectRecord, ShellProfile, SshProfile, TerminalEvent, TerminalInfo } from "./types";
import { getUiCopy, getWorkbenchCopy } from "./i18n";
import { keybindingCaptureActive, keybindingMatches } from "./keybindings";
import CommandPalette, { type PaletteAction } from "./terminal/CommandPalette";
import DocumentViewer from "./terminal/DocumentViewer";
import { DirectoriesDrawer, FilesDrawer, GitDrawer, SftpDrawer } from "./terminal/Drawers";
import SettingsPanel from "./terminal/SettingsPanel";
import SshEditor from "./terminal/SshEditor";
import TerminalPane from "./terminal/TerminalPane";
import type { Terminal as XTerm } from "@xterm/xterm";

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

type Drawer = "files" | "git" | "sftp" | "directories" | null;
type WorkspaceView = "terminal" | "settings" | "document";
type SplitDirection = "columns" | "rows";
type DockEdge = "center" | "left" | "right" | "top" | "bottom";

interface PaneLeaf {
  type: "leaf";
  sessionId: string;
  kind?: "terminal" | "document";
  document?: DocumentFile;
  root?: string;
}

/** Launch identity for a pane, used to rebuild leaves that lost their PTY. */
interface PaneLeafIdentity {
  cwd: string;
  shellId?: string;
  profileId?: string;
  sshProfileId?: string;
  title?: string;
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
  /** Per-pane launch identity for restoring the split tree without snapshots. */
  leaves?: Record<string, PaneLeafIdentity>;
}

const layoutKey = "codex-cli-ui:terminal-layout-v5";
const layoutV4Key = "codex-cli-ui:terminal-layout-v4";
const renameKey = "codex-cli-ui:terminal-renames-v1";
const colorKey = "codex-cli-ui:terminal-colors-v1";
const stageDockId = "_stage";

const TAB_COLORS = ["#e06c75", "#d19a66", "#e5c07b", "#98c379", "#56b6c2", "#61afef", "#c678dd"];

const completionSourceLabels = {
  history: "completionHistory",
  dir: "completionDir",
  file: "completionFile",
  command: "completionCommand",
} as const;

const completionSourceIcons: Record<keyof typeof completionSourceLabels, ReactNode> = {
  history: <History size={11} />,
  dir: <Folder size={11} />,
  file: <FileText size={11} />,
  command: <TerminalSquare size={11} />,
};

function loadLayout(): SavedLayout {
  try {
    const raw = localStorage.getItem(layoutKey) || localStorage.getItem(layoutV4Key) || "{}";
    return JSON.parse(raw) as SavedLayout;
  }
  catch { return {}; }
}

function isWslPath(value: string) {
  const lower = value.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  return lower.startsWith("\\\\wsl$\\") || lower.startsWith("\\\\wsl.localhost\\");
}

function leafIdentity(session: TerminalInfo): PaneLeafIdentity {
  return {
    cwd: session.cwd,
    shellId: session.shellId,
    profileId: session.profileId,
    sshProfileId: session.sshProfileId,
    title: session.title,
  };
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

const DOC_LEAF_PREFIX = "doc:";

function isDocumentLeafId(id: string) {
  return id.startsWith(DOC_LEAF_PREFIX);
}

function documentLeafId(path: string) {
  return `${DOC_LEAF_PREFIX}${path.replaceAll("\\", "/").toLowerCase()}`;
}

/** First terminal leaf id in the tree (skips in-pane document leaves). */
function firstTerminalLeaf(node: PaneNode | null): string | null {
  if (!node) return null;
  if (node.type === "leaf") return isDocumentLeafId(node.sessionId) ? null : node.sessionId;
  for (const child of node.children) {
    const found = firstTerminalLeaf(child);
    if (found) return found;
  }
  return null;
}

/** Document panes are transient: strip them when persisting the layout. */
function stripDocumentLeaves(node: PaneNode | null): PaneNode | null {
  if (!node) return null;
  if (node.type === "leaf") return isDocumentLeafId(node.sessionId) ? null : node;
  const children = node.children.map(stripDocumentLeaves).filter((child): child is PaneNode => child !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  return rebuildSplit(node, children, children.length === node.children.length);
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

function splitLeaf(node: PaneNode | null, targetId: string, direction: SplitDirection, leaf: PaneLeaf): PaneNode | null {
  if (!node) return leaf;
  if (node.type === "leaf") return node.sessionId === targetId ? { type: "split", direction, children: [node, leaf] } : node;
  const children = node.children.map((child) => splitLeaf(child, targetId, direction, leaf)).filter((child): child is PaneNode => child !== null);
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
  if (session.shellId === "nu" || session.shell.toLowerCase().includes("nushell") || /(^|[\\/])nu(?:\.exe)?$/i.test(session.shell)) return "nu";
  if (session.shell.toLowerCase().includes("bash")) return "bash";
  return session.shell.replace(/\.exe$/i, "").slice(0, 8);
}

export default function TerminalWorkspace({ project, settings, workspaceMode, chatSidebar, chatContent, chatTitle, providerName, cliLifecycleStatus, cliLifecycleBusy, onSettingsChange, onCliLifecycleToggle, onWorkspaceModeChange, onRefreshChat, onAddProject, onError }: TerminalWorkspaceProps) {
  const initialLayout = useMemo(loadLayout, []);
  const initialPaneState = useMemo(() => migrateLayout(initialLayout), [initialLayout]);
  const workbenchCopy = getWorkbenchCopy(settings.language);
  const directoriesCopy = getUiCopy(settings.language).directories;
  const [sessions, setSessions] = useState<TerminalInfo[]>([]);
  const [paneTree, setPaneTree] = useState<PaneNode | null>(initialPaneState.tree);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(initialPaneState.activeSessionId);
  const [shells, setShells] = useState<ShellProfile[]>([]);
  const [cliTools, setCliTools] = useState<CliToolInfo[]>([]);
  const [sshProfiles, setSshProfiles] = useState<SshProfile[]>([]);
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [view, setView] = useState<WorkspaceView>("terminal");
  const [settingsTabOpen, setSettingsTabOpen] = useState(false);
  const [document, setDocument] = useState<DocumentFile>();
  const [selectedSsh, setSelectedSsh] = useState<SshProfile>();
  const [sshEditor, setSshEditor] = useState<SshProfile | "new">();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shellPaletteOpen, setShellPaletteOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [quarantine, setQuarantine] = useState<{ quarantined: boolean; snapshotPath?: string | null }>();
  const [quarantineDismissed, setQuarantineDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (typeof window.codex.getTerminalQuarantineStatus !== "function") return undefined;
    window.codex.getTerminalQuarantineStatus().then((status) => {
      if (!cancelled) setQuarantine(status);
    }).catch(() => {
      // 主进程未暴露该通道时保持安静。
    });
    return () => { cancelled = true; };
  }, []);
  const [moreMenuPosition, setMoreMenuPosition] = useState({ left: 8, top: 48 });
  const [unread, setUnread] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<{ sessionId: string; title: string; message: string }>();
  const [sidebarWidth, setSidebarWidth] = useState(initialLayout.sidebarWidth || 230);
  const [drawerWidth, setDrawerWidth] = useState(initialLayout.drawerWidth || 300);
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
  const commandTextRef = useRef(commandText);
  const historyLinesRef = useRef<string[]>([]);
  const historyCursorRef = useRef(-1);
  const historyDraftRef = useRef("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [completionCandidates, setCompletionCandidates] = useState<CompletionCandidate[]>([]);
  const [completionDismissed, setCompletionDismissed] = useState(false);
  const [bellFlash, setBellFlash] = useState<Set<string>>(new Set());
  const [broadcastOn, setBroadcastOn] = useState(false);
  const broadcastOnRef = useRef(broadcastOn);
  const topTabsRef = useRef<HTMLDivElement>(null);
  const [topTabsOverflow, setTopTabsOverflow] = useState(false);
  const [topTabsAtStart, setTopTabsAtStart] = useState(true);
  const [topTabsAtEnd, setTopTabsAtEnd] = useState(true);
  const tabDragXRef = useRef(0);
  const tabScrollFrameRef = useRef(0);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [windowFocused, setWindowFocused] = useState(window.document.hasFocus());
  const [terminalStateLoaded, setTerminalStateLoaded] = useState(false);
  const sessionsRef = useRef(sessions);
  const treeRef = useRef(paneTree);
  const activeSessionIdRef = useRef(activeSessionId);
  const terminalInstancesRef = useRef<Map<string, XTerm>>(new Map());
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
  useEffect(() => { broadcastOnRef.current = broadcastOn; }, [broadcastOn]);
  useEffect(() => { commandTextRef.current = commandText; }, [commandText]);
  useEffect(() => { if (leafCount(paneTree) <= 1) setBroadcastOn(false); }, [paneTree]);
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
    if (!terminalStateLoaded) return;
    const leaves: Record<string, PaneLeafIdentity> = {};
    for (const id of collectLeafIds(paneTree)) {
      const session = sessionsRef.current.find((item) => item.id === id);
      if (session) leaves[id] = leafIdentity(session);
    }
    localStorage.setItem(layoutKey, JSON.stringify({ tree: stripDocumentLeaves(paneTree), activeSessionId, sidebarWidth, drawerWidth, sidebarCollapsed, tabsCollapsed, toolsCollapsed, sshCollapsed, leaves } satisfies SavedLayout));
  }, [activeSessionId, drawerWidth, paneTree, sidebarCollapsed, sidebarWidth, sshCollapsed, tabsCollapsed, terminalStateLoaded, toolsCollapsed]);

  const assignSession = useCallback((id: string, targetId?: string) => {
    setView("terminal");
    onWorkspaceModeChange("terminal");
    setPaneTree((current) => {
      if (!current) return { type: "leaf", sessionId: id };
      if (containsLeaf(current, id)) return current;
      const anchor = targetId ?? activeLeafId(current, activeSessionIdRef.current) ?? collectLeafIds(current)[0] ?? "";
      if (isDocumentLeafId(anchor)) return splitLeaf(current, anchor, "columns", { type: "leaf", sessionId: id });
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
    void Promise.all([window.codex.listShells(), window.codex.listCliTools(), window.codex.listSshProfiles(), window.codex.listTerminals()]).then(async ([shellItems, toolItems, sshItems, terminalItems]) => {
      if (cancelled) return;
      setShells(shellItems);
      setCliTools(toolItems);
      setSshProfiles(sshItems);
      const validIds = new Set(terminalItems.map((item) => item.id));
      const saved = loadLayout();
      const restorable = saved.leaves
        ? new Set(Object.entries(saved.leaves).filter(([id, identity]) => !validIds.has(id) && Boolean(identity?.cwd)).map(([id]) => id))
        : new Set<string>();
      let restored = pruneTree(saved.tree ?? null, new Set([...validIds, ...restorable]));
      if (leafCount(restored) > 4) restored = pruneTree(restored, new Set(collectLeafIds(restored).slice(0, 4)));
      const rebuilt: TerminalInfo[] = [...terminalItems];
      const restoredIds = new Set(collectLeafIds(restored));
      let missing = saved.leaves
        ? Object.entries(saved.leaves).filter(([id, identity]) => !validIds.has(id) && Boolean(identity?.cwd) && restoredIds.has(id))
        : [];
      if (!restored && saved.leaves) {
        missing = Object.entries(saved.leaves)
          .filter(([, identity]) => Boolean(identity?.cwd))
          .slice(0, 4);
      }
      if (missing.length > 0) {
        const created = await Promise.all(missing.map(([, identity]) => window.codex.createTerminal({
          cwd: identity!.cwd,
          cols: 100,
          rows: 30,
          reuseExisting: false,
          shellId: identity!.shellId,
          profileId: identity!.profileId,
          sshProfileId: identity!.sshProfileId,
          title: identity!.title,
        })));
        if (cancelled) return;
        for (let index = 0; index < missing.length; index++) {
          const session = created[index];
          if (!session) continue;
          rebuilt.push(session);
          restored = replaceLeaf(restored, missing[index][0], session.id);
          if (!restored || !containsLeaf(restored, session.id)) {
            const anchor = restored ? activeLeafId(restored, null) ?? collectLeafIds(restored)[0] ?? "" : "";
            restored = restored && anchor ? splitLeaf(restored, anchor, "columns", { type: "leaf", sessionId: session.id }) : { type: "leaf", sessionId: session.id };
          }
        }
      }
      if (cancelled) return;
      setSessions(rebuilt);
      setPaneTree(restored);
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

  const splitPaneRef = useRef<(direction: SplitDirection, sessionId?: string, anchorId?: string) => Promise<string | undefined>>(async () => undefined);
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
      setSessions((current) => current.map((item) => item.id === event.sessionId ? { ...item, status: "exited", activity: "idle", exitCode: event.code ?? item.exitCode, exitedAt: Date.now(), updatedAt: Date.now() } : item));
      setNotice({ sessionId: event.sessionId, title: previous?.title || workbenchCopy.terminal, message: workbenchCopy.processExited(event.code) });
    } else if (event.type === "runtime" && event.action?.kind === "split") {
      const target = event.sessionId;
      void splitPaneRef.current(event.action.direction, target, target).then((paneId) => {
        window.codex.resolveRuntimeAction(event.action!.actionId, paneId ? { ok: true, paneId } : { ok: false, error: "split failed" });
      });
    } else if (event.type === "bell") {
      setNotice({ sessionId: event.sessionId, title: previous?.title || workbenchCopy.terminal, message: previous?.activity === "attention" ? workbenchCopy.inputRequested : workbenchCopy.attentionRequested });
      if (settings.bellMode === "flash" || settings.bellMode === "both") {
        setBellFlash((current) => new Set(current).add(event.sessionId));
        window.setTimeout(() => setBellFlash((current) => {
          const next = new Set(current);
          next.delete(event.sessionId);
          return next;
        }), 700);
      }
    } else if (event.type === "focus") assignSession(event.sessionId);
    else if (event.type === "error" && event.message) onError(event.message);
  }), [assignSession, onError, settings.bellMode, workbenchCopy]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(undefined), 6_000);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  const splitPane = useCallback(async (direction: SplitDirection, sessionId?: string, anchorId?: string): Promise<string | undefined> => {
    if (leafCount(treeRef.current) >= 4) { onError(workbenchCopy.maxPanes); return undefined; }
    let id = sessionId;
    if (!id || containsLeaf(treeRef.current, id)) {
      const current = sessionsRef.current.find((item) => item.id === activeSessionIdRef.current);
      const created = await createTerminal(current?.cwd || projectPath, { reuseExisting: false, shellId: settings.defaultShellId, activate: false });
      id = created?.id;
    }
    if (!id) return undefined;
    setPaneTree((current) => {
      if (!current) return { type: "leaf", sessionId: id! };
      if (containsLeaf(current, id!)) return current;
      const anchor = anchorId && containsLeaf(current, anchorId) ? anchorId : activeLeafId(current, activeSessionIdRef.current) ?? collectLeafIds(current)[0];
      return splitLeaf(current, anchor, direction, { type: "leaf", sessionId: id! });
    });
    setActiveSessionId(id);
    setView("terminal");
    onWorkspaceModeChange("terminal");
  }, [createTerminal, onError, onWorkspaceModeChange, projectPath, settings.defaultShellId, workbenchCopy]);

  splitPaneRef.current = splitPane;

  const focusPane = useCallback((offset: number) => {
    const ids = collectLeafIds(treeRef.current);
    if (ids.length < 2) return;
    const index = ids.indexOf(activeSessionIdRef.current ?? "");
    const next = ids[(index < 0 ? 0 : index + offset + ids.length) % ids.length];
    setActiveSessionId(next);
    setView("terminal");
    onWorkspaceModeChange("terminal");
  }, [onWorkspaceModeChange]);

  const resetLayout = useCallback(() => {
    const ids = collectLeafIds(treeRef.current);
    const keep = activeSessionIdRef.current && ids.includes(activeSessionIdRef.current)
      ? activeSessionIdRef.current
      : ids[0] ?? sessionsRef.current[0]?.id;
    if (!keep) return;
    // Collapse back to a single pane; other sessions stay alive in the tab list
    // and can be re-docked by dragging them back in.
    setPaneTree({ type: "leaf", sessionId: keep });
    setActiveSessionId(keep);
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
      if (keybindingCaptureActive) return;
      if (keybindingMatches(event, settings.keybindings["command-palette"])) { event.preventDefault(); setPaletteOpen(true); }
      else if (keybindingMatches(event, settings.keybindings["new-terminal"])) { event.preventDefault(); void createTerminal(active?.cwd || projectPath, { shellId: settings.defaultShellId }); }
      else if (keybindingMatches(event, settings.keybindings["split-right"])) { event.preventDefault(); void splitPane("columns"); }
      else if (keybindingMatches(event, settings.keybindings["split-down"])) { event.preventDefault(); void splitPane("rows"); }
      else if (keybindingMatches(event, settings.keybindings["pane-next"])) { event.preventDefault(); focusPane(1); }
      else if (keybindingMatches(event, settings.keybindings["pane-prev"])) { event.preventDefault(); focusPane(-1); }
      else if (keybindingMatches(event, settings.keybindings["open-settings"])) { event.preventDefault(); setDrawer(null); setSettingsTabOpen(true); setView("settings"); }
      else if (event.key === "Escape") {
        if (paneResizing) { event.preventDefault(); cancelPaneResize(); return; }
        setPaletteOpen(false);
        setShellPaletteOpen(false);
        setMoreMenuOpen(false);
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
    if (!settings.completionEnabled || !active || !commandText.trim() || completionDismissed) { setSuggestions([]); setCompletionCandidates([]); return; }
    let cancelled = false;
    const timeout = window.setTimeout(async () => {
      if (settings.completionStyle === "popup") {
        const items = await window.codex.getCompletions(commandText, active.cwd, active.kind === "ssh" ? active.sshProfileId : undefined);
        if (!cancelled) { setCompletionCandidates(items); setSuggestionIndex(0); }
      } else {
        const history = await window.codex.getCommandHistory(commandText, active.cwd);
        if (!cancelled) { setSuggestions(history); setSuggestionIndex(0); }
      }
    }, 90);
    return () => { cancelled = true; window.clearTimeout(timeout); };
  }, [active?.cwd, active?.id, commandText, completionDismissed, settings.completionEnabled, settings.completionStyle]);

  useEffect(() => { setCompletionDismissed(false); }, [commandText]);

  const closePane = (sessionId: string) => {
    setPaneTree((current) => removeLeaf(current, sessionId));
    setActiveSessionId((current) => (current === sessionId ? null : current));
  };

  const openDocumentPane = useCallback((document: DocumentFile, root: string) => {
    setView("terminal");
    onWorkspaceModeChange("terminal");
    const docId = documentLeafId(document.path);
    setPaneTree((current) => {
      if (current && containsLeaf(current, docId)) return current;
      if (!current) return { type: "leaf", sessionId: docId, kind: "document", document, root };
      const anchor = activeLeafId(current, activeSessionIdRef.current) ?? firstTerminalLeaf(current) ?? collectLeafIds(current)[0] ?? "";
      return splitLeaf(current, anchor, "columns", { type: "leaf", sessionId: docId, kind: "document", document, root });
    });
    setActiveSessionId(docId);
  }, [onWorkspaceModeChange]);

  const closeDocumentPane = (docId: string) => {
    const next = removeLeaf(treeRef.current, docId);
    setPaneTree(next);
    if (activeSessionIdRef.current === docId) setActiveSessionId(activeLeafId(next, null));
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

  const exportSession = async (id: string) => {
    const session = sessionsRef.current.find((item) => item.id === id);
    if (!session) return;
    const terminal = terminalInstancesRef.current.get(id);
    let content = "";
    if (terminal) {
      const buffer = terminal.buffer.active;
      const lines: string[] = [];
      for (let y = 0; y < buffer.length; y += 1) {
        const line = buffer.getLine(y);
        lines.push(line ? line.translateToString(true) : "");
      }
      content = lines.join("\n");
    }
    try {
      const path = await window.codex.exportTerminalSession(id, content);
      if (path) setNotice({ sessionId: id, title: workbenchCopy.exportSession, message: path });
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : workbenchCopy.exportFailed);
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

  const terminalStateClass = (session: TerminalInfo) => {
    const failed = session.exitCode != null && session.exitCode !== 0;
    return `terminal-state ${session.status} ${session.activity}${failed ? " failed" : ""}${session.aiTaskState ? ` ai-${session.aiTaskState}` : ""}${unread.has(session.id) ? " unread" : ""}`;
  };
  const terminalStateIcon = (session: TerminalInfo) => {
    const failed = session.exitCode != null && session.exitCode !== 0;
    if (failed) return <CircleX size={11} />;
    if (session.aiTaskState === "running" || session.activity === "running") return <LoaderCircle className="spin" size={11} />;
    if (session.aiTaskState === "waiting_input" || session.aiTaskState === "attention") return <TriangleAlert size={11} />;
    if (session.aiTaskState === "finished") return undefined;
    if (session.activity === "attention") return <TriangleAlert size={11} />;
    return undefined;
  };

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

  // Broadcast input: forward the focused pane's bytes to every other pane in
  // the active split tree (Nebula v1.3 pane_header fan-out). The source pane
  // already wrote to its own PTY, so it is excluded.
  const broadcastInput = useCallback((sourceId: string, data: string) => {
    if (!broadcastOnRef.current || !data) return;
    const current = treeRef.current;
    if (!current) return;
    for (const id of collectLeafIds(current)) {
      if (id !== sourceId) void window.codex.writeTerminal(id, data);
    }
  }, []);

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
    historyCursorRef.current = -1;
    historyLinesRef.current = [];
    setSuggestions([]);
    setCompletionCandidates([]);
  };

  // Up/Down history fallback when neither the popup nor the inline ghost has
  // candidates — fixes #56 (popup mode could not cycle history records).
  const navigateHistory = useCallback(async (direction: -1 | 1, cwd?: string, draft?: string) => {
    if (!cwd) return;
    // 仅当尚未开始翻历史（cursor 在 -1）时记录草稿；翻动过程中不覆盖，
    // 否则 Down 回到草稿时会拿到历史项而非最初输入。
    if (historyCursorRef.current < 0) historyDraftRef.current = draft ?? commandTextRef.current;
    if (!historyLinesRef.current.length) {
      try {
        historyLinesRef.current = await window.codex.getCommandHistory("", cwd);
      } catch {
        historyLinesRef.current = [];
      }
      historyCursorRef.current = -1;
    }
    const lines = historyLinesRef.current;
    if (!lines.length) return;
    // direction: -1 = ArrowUp (older), +1 = ArrowDown (newer); cursor -1 表示回到草稿
    const next = Math.max(-1, Math.min(lines.length - 1, historyCursorRef.current - direction));
    historyCursorRef.current = next;
    setCommandText(next >= 0 ? lines[next] : historyDraftRef.current);
  }, []);

  const acceptCompletion = (value: string) => {
    setCommandText(value);
    setCompletionCandidates([]);
    setSuggestions([]);
    setCompletionDismissed(true);
  };

  const openSftp = (profile: SshProfile) => { setSelectedSsh(profile); setDrawer("sftp"); };
  const jumpToDirectory = (path: string) => {
    if (!path) return;
    if (active) {
      const quote = path.replaceAll("'", "''");
      const command = /powershell/i.test(active.shell) ? `Set-Location -LiteralPath '${quote}'`
        : /cmd/i.test(active.shell) ? `cd /d "${path.replaceAll('"', '""')}"`
          : `cd '${path.replaceAll("'", "'\\''")}'`;
      void window.codex.writeTerminal(active.id, `${command}\r`);
    } else {
      void createTerminal(path, { reuseExisting: false, shellId: settings.defaultShellId });
    }
  };
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
      if (kind === "sidebar") { if (next < 120) setSidebarCollapsed(true); else { setSidebarCollapsed(false); setSidebarWidth(Math.max(170, Math.min(420, next))); } }
      else if (next < 150) setDrawer(null); else setDrawerWidth(Math.max(220, Math.min(560, next)));
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const toggleMoreMenu = (anchor: HTMLButtonElement) => {
    if (moreMenuOpen) { setMoreMenuOpen(false); return; }
    const bounds = anchor.getBoundingClientRect();
    const width = 180;
    setMoreMenuPosition({
      left: Math.max(8, Math.min(bounds.right - width, window.innerWidth - width - 8)),
      top: Math.min(window.innerHeight - 8, bounds.bottom + 6),
    });
    setMoreMenuOpen(true);
  };

  const shellPaletteActions: PaletteAction[] = shells.map((shell) => ({ id: `shell:${shell.id}`, group: workbenchCopy.newTerminalGroup, label: shell.label, detail: shell.detail, icon: <TerminalSquare size={14} />, run: () => void createTerminal(active?.cwd || projectPath, { reuseExisting: false, shellId: shell.id }) }));
  const paletteActions: PaletteAction[] = [
    ...cliTools.map((tool) => ({ id: `tool:${tool.id}`, group: workbenchCopy.cliTools, label: tool.name, detail: tool.available ? tool.description : tool.installCommand || workbenchCopy.notDetected, icon: cliToolIcon(tool), run: () => void launchCliTool(tool) })),
    ...shellPaletteActions,
    { id: "close-terminal", group: workbenchCopy.terminalActions, label: workbenchCopy.closeTerminal, icon: <X size={14} />, run: () => { if (active) void closeTerminal(active.id); } },
    { id: "previous-terminal", group: workbenchCopy.terminalActions, label: workbenchCopy.previousTerminal, icon: <ChevronLeft size={14} />, run: () => { if (!sessions.length) return; const index = Math.max(0, sessions.findIndex((session) => session.id === active?.id)); assignSession(sessions[(index - 1 + sessions.length) % sessions.length].id); } },
    { id: "next-terminal", group: workbenchCopy.terminalActions, label: workbenchCopy.nextTerminal, icon: <ChevronRight size={14} />, run: () => { if (!sessions.length) return; const index = Math.max(0, sessions.findIndex((session) => session.id === active?.id)); assignSession(sessions[(index + 1) % sessions.length].id); } },
    { id: "split-columns", group: workbenchCopy.layout, label: workbenchCopy.splitRight, icon: <Columns2 size={14} />, run: () => void splitPane("columns") },
    { id: "split-rows", group: workbenchCopy.layout, label: workbenchCopy.splitDown, icon: <Rows2 size={14} />, run: () => void splitPane("rows") },
    { id: "reset-layout", group: workbenchCopy.layout, label: workbenchCopy.resetLayout, icon: <RotateCcw size={14} />, run: resetLayout },
    { id: "sidebar", group: workbenchCopy.layout, label: workbenchCopy.showTabSidebar, icon: sidebarCollapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />, checked: !sidebarCollapsed, run: () => setSidebarCollapsed((value) => !value) },
    { id: "resize", group: workbenchCopy.layout, label: workbenchCopy.resizePanels, icon: <GripVertical size={14} />, checked: settings.resizablePanels, run: () => onSettingsChange({ ...settings, resizablePanels: !settings.resizablePanels }) },
    { id: "files", group: workbenchCopy.workspace, label: workbenchCopy.files, icon: <FolderTree size={14} />, checked: drawer === "files", run: () => setDrawer((value) => value === "files" ? null : "files") },
    { id: "git", group: workbenchCopy.workspace, label: "Git", icon: <GitBranch size={14} />, checked: drawer === "git", run: () => setDrawer((value) => value === "git" ? null : "git") },
    { id: "directories", group: workbenchCopy.workspace, label: directoriesCopy.title, icon: <History size={14} />, checked: drawer === "directories", run: () => setDrawer((value) => value === "directories" ? null : "directories") },
    { id: "settings", group: workbenchCopy.workspace, label: workbenchCopy.settings, icon: <Settings2 size={14} />, run: () => { setSettingsTabOpen(true); setView("settings"); } },
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
    setSettingsTabOpen(true);
    setView("settings");
  };
  const closeSettingsTab = () => {
    setSettingsTabOpen(false);
    setView("terminal");
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
  const settingsViewSideMode = view === "settings" && settings.tabPosition === "side";
  const showTopTabs = settings.tabPosition === "top" && ((terminalView && sessions.length > 0) || (settingsTabOpen && view === "settings"));
  const showSidePanel = (primaryView || (settingsTabOpen && settingsViewSideMode)) && !sidebarCollapsed;
  const headingTitle = view === "settings" ? workbenchCopy.settings : view === "document" ? document?.name || workbenchCopy.document : chatView ? chatTitle || workbenchCopy.conversations : workbenchCopy.terminal;
  const headingLabel = view === "settings" ? workbenchCopy.settingsLabel : chatView ? workbenchCopy.conversationsLabel : workbenchCopy.terminalLabel;

  // Paged title-bar tabs (Nebula v1.3): show ‹ › when the strip overflows and
  // grey them out at either end; drag edge auto-scroll lives in the effect above.
  useEffect(() => {
    const strip = topTabsRef.current;
    if (!strip) return;
    const update = () => {
      const overflow = strip.scrollWidth > strip.clientWidth + 1;
      setTopTabsOverflow(overflow);
      setTopTabsAtStart(strip.scrollLeft <= 0);
      setTopTabsAtEnd(!overflow || strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 1);
    };
    update();
    strip.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(strip);
    const parentObserver = new ResizeObserver(update);
    if (strip.parentElement) parentObserver.observe(strip.parentElement);
    return () => {
      strip.removeEventListener("scroll", update);
      observer.disconnect();
      parentObserver.disconnect();
    };
  }, [showTopTabs, sessions.length]);

  const pageTopTabs = useCallback((direction: -1 | 1) => {
    const strip = topTabsRef.current;
    if (!strip) return;
    strip.scrollBy({ left: direction * 168, behavior: "smooth" });
  }, []);

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
    if (node.kind === "document" && node.document) {
      const isActive = activeId === node.sessionId;
      return (
        <div className={`terminal-pane-leaf document-pane-leaf${isActive ? " active" : ""}`} data-document-id={node.sessionId} key={node.sessionId}>
          <div className="pane-toolbar">
            <span title={node.document.path}><FileText size={12} /><strong>{node.document.name}</strong><small>{node.root}</small></span>
            <span className="pane-toolbar-actions">
              {leafCount(paneTree) > 1 && <button aria-label={workbenchCopy.closePane} title={workbenchCopy.closePane} onClick={() => closeDocumentPane(node.sessionId)}><X size={11} /></button>}
            </span>
          </div>
          <DocumentViewer document={node.document} root={node.root ?? projectPath} onClose={() => closeDocumentPane(node.sessionId)} onError={onError} />
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
        <div className={`pane-toolbar${bellFlash.has(session.id) ? " bell-flash" : ""}`}>
          <span draggable title={workbenchCopy.dragPaneToDetach} onDragStart={(event) => { event.stopPropagation(); setDraggingSession(session.id); event.dataTransfer.setData("text/terminal-session", session.id); event.dataTransfer.effectAllowed = "move"; }} onDragEnd={() => { setDraggingSession(undefined); setDockTarget(null); }}>{terminalIcon(session)}<strong>{tabDisplayTitle(session)}</strong><small>{session.remoteHost || session.cwd}</small>{session.activity === "attention" && <i />}</span>
          <span className="pane-toolbar-actions">
            {leafCount(paneTree) > 1 && <button className={broadcastOn ? "active" : ""} aria-label={workbenchCopy.broadcastInput} title={workbenchCopy.broadcastInput} onClick={() => setBroadcastOn((value) => !value)}><Radio size={11} /></button>}
            <button aria-label={workbenchCopy.splitPaneRight} title={workbenchCopy.splitPaneRight} onClick={() => void splitPane("columns", session.id, session.id)}><Columns2 size={11} /></button>
            <button aria-label={workbenchCopy.splitPaneDown} title={workbenchCopy.splitPaneDown} onClick={() => void splitPane("rows", session.id, session.id)}><Rows2 size={11} /></button>
            {session.kind === "ssh" && session.exitedAt && <button className="pane-retry" aria-label={workbenchCopy.xRetryTerminal} title={workbenchCopy.xRetryTerminal} onClick={() => void restartSsh(session)}><RefreshCw size={11} /></button>}
            {leafCount(paneTree) > 1 && <button aria-label={workbenchCopy.closePane} title={workbenchCopy.closePane} onClick={() => closePane(session.id)}><X size={11} /></button>}
          </span>
        </div>
        <TerminalPane session={session} theme={settings.theme} cursorStyle={settings.cursorStyle} cursorBlink={settings.cursorBlink} fontFamily={settings.fontFamily} cellWidth={settings.cellWidth} backgroundOverride={settings.backgroundColor} bellFlash={bellFlash.has(session.id)} copyOnSelect={settings.copyOnSelect} active={isActive && terminalView && windowFocused} onFocus={() => { setActiveSessionId(session.id); setUnread((current) => { const next = new Set(current); next.delete(session.id); return next; }); }} onTerminalReady={(id, terminal) => { if (terminal) terminalInstancesRef.current.set(id, terminal); else terminalInstancesRef.current.delete(id); }} onError={onError} onBroadcast={(data) => broadcastInput(session.id, data)} />
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
  const filesRoot = active && isWslPath(active.cwd) ? active.cwd : projectPath;
  const filesSshProfile = active?.kind === "ssh"
    ? selectedSsh || (active.sshProfileId ? sshProfiles.find((profile) => profile.id === active.sshProfileId) : undefined)
    : undefined;

  return (
    <main className="terminal-workspace" data-terminal-theme={settings.theme} data-tab-position={settings.tabPosition} data-density={settings.density} data-workspace-view={view} data-window-focused={windowFocused} style={{ "--terminal-sidebar-width": `${sidebarWidth}px`, "--terminal-drawer-width": `${drawerWidth}px`, "--terminal-bg-opacity": settings.backgroundOpacity, "--terminal-bg-image": pathToCssUrl(settings.backgroundImage), ...(settings.accentColor ? { "--t-accent": settings.accentColor } : {}) } as React.CSSProperties}>
      <header className="terminal-header">
        {showTopTabs ? (
          <>
        <div ref={topTabsRef} className="terminal-top-tabs" role="tablist" aria-label={workbenchCopy.topTabs} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; tabDragXRef.current = event.clientX; }} onDrop={(event) => { const source = event.dataTransfer.getData("text/terminal-session"); if (!source) return; if ((event.target as HTMLElement).closest(".terminal-top-tab")) return; event.preventDefault(); setDraggingSession(undefined); setPaneTree((current) => removeLeaf(current, source)); }}>
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
                <span className={terminalStateClass(session)} title={session.exitCode != null && session.exitCode !== 0 ? workbenchCopy.processExited(session.exitCode) : undefined}>{terminalStateIcon(session)}</span>
                {terminalIcon(session)}
                {renamingSession === session.id
                  ? <input className="terminal-rename-input" autoFocus value={renameDraft} aria-label={workbenchCopy.renameTerminal} placeholder={workbenchCopy.renameTabPlaceholder} onClick={(event) => event.stopPropagation()} onChange={(event) => setRenameDraft(event.target.value)} onBlur={commitRename} onKeyDown={(event) => { if (event.key === "Enter") commitRename(); else if (event.key === "Escape") setRenamingSession(undefined); }} />
                  : <span className="terminal-tab-title">{tabDisplayTitle(session)}</span>}
                {session.activity === "idle" && <em>{shellTag(session)}</em>}
                {session.status === "exited" && session.exitCode != null && session.exitCode !== 0 && <em className="terminal-exit-code failed">{workbenchCopy.processExited(session.exitCode)}</em>}
              </button>
              {session.kind === "ssh" && session.exitedAt && <button className="terminal-tab-retry" title={workbenchCopy.xRetryTerminal} onClick={() => void restartSsh(session)}><RefreshCw size={11} /></button>}
              <button className="terminal-tab-close" title={workbenchCopy.closeTerminal} onClick={() => void closeTerminal(session.id)}><X size={11} /></button>
            </div>
          ))}
          {settingsTabOpen && (
            <div className={`terminal-top-tab settings-tab${view === "settings" ? " active" : ""}`} data-tab-kind="settings" key="settings-tab" onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }} onAuxClick={(event) => { if (event.button !== 1) return; event.preventDefault(); event.stopPropagation(); closeSettingsTab(); }}>
              <button className="terminal-tab-main" title={workbenchCopy.settings} onClick={openSettings}><Settings2 size={13} /><span className="terminal-tab-title">{workbenchCopy.settings}</span></button>
              <button className="terminal-tab-close" title={workbenchCopy.closeSettings} onClick={closeSettingsTab}><X size={11} /></button>
            </div>
          )}
        </div>
        {topTabsOverflow && <div className="top-tabs-paging">
          <button className="terminal-header-action" title={workbenchCopy.pageTabsLeft} disabled={topTabsAtStart} onClick={() => pageTopTabs(-1)}><ChevronLeft size={14} /></button>
          <button className="terminal-header-action" title={workbenchCopy.pageTabsRight} disabled={topTabsAtEnd} onClick={() => pageTopTabs(1)}><ChevronRight size={14} /></button>
        </div>}
        <button className="terminal-header-action" title={workbenchCopy.newTerminal} onClick={() => void createTerminal(active?.cwd || projectPath, { reuseExisting: false, shellId: settings.defaultShellId })}><Plus size={15} /></button>
        <button className={`terminal-header-action top-tabs-menu${moreMenuOpen ? " active" : ""}`} title={workbenchCopy.moreActions} onClick={(event) => toggleMoreMenu(event.currentTarget)}><EllipsisVertical size={18} /></button>
          </>
        ) : (
        <div className="terminal-heading">
          <span className="terminal-brand">{view === "settings" ? <Settings2 size={17} /> : chatView ? <Bot size={17} /> : <TerminalSquare size={17} />}</span>
          <div>
            <h1 aria-label={headingLabel}>{headingTitle}</h1>
            {project ? <button title={projectPath} onClick={() => void window.codex.revealPath(projectPath)}><FolderOpen size={11} /><span>{projectLabel}</span><small>{chatView ? providerName : active?.cwd || projectPath}</small></button> : <button title={workbenchCopy.selectDirectory} onClick={() => void onAddProject()}><FolderOpen size={11} /><span>{workbenchCopy.selectDirectory}</span><small>{providerName}</small></button>}
          </div>
        </div>
        )}
        <div className="titlebar-drag" />
        <div className="terminal-actions">
          {primaryView && <div className="workspace-view-switch" role="tablist" aria-label={workbenchCopy.viewSwitcher}>
            <button role="tab" aria-selected={workspaceMode === "chat"} className={workspaceMode === "chat" ? "active" : ""} title={workbenchCopy.chat} onClick={() => void activateWorkspaceMode("chat")}><Bot size={13} /><span>{workbenchCopy.chat}</span></button>
            <button role="tab" aria-selected={workspaceMode === "terminal"} className={workspaceMode === "terminal" ? "active" : ""} title={workbenchCopy.terminal} onClick={() => void activateWorkspaceMode("terminal")}><TerminalSquare size={13} /><span>{workbenchCopy.terminal}</span></button>
          </div>}
          {chatView && <button title={workbenchCopy.refreshChat} disabled={!project} onClick={onRefreshChat}><RefreshCw size={14} /></button>}
          {terminalView && <>
            <button className={drawer === "files" ? "active" : ""} aria-label={workbenchCopy.files} title={workbenchCopy.files} onClick={() => setDrawer((value) => value === "files" ? null : "files")}><FolderTree size={14} /></button>
            <button className={drawer === "git" ? "active" : ""} aria-label={workbenchCopy.gitStatus} title={workbenchCopy.gitStatus} onClick={() => setDrawer((value) => value === "git" ? null : "git")}><GitBranch size={14} /></button>
            <button className={drawer === "directories" ? "active" : ""} aria-label={directoriesCopy.title} title={directoriesCopy.title} onClick={() => setDrawer((value) => value === "directories" ? null : "directories")}><History size={14} /></button>
            {active?.kind === "ssh" && selectedSsh && <button className={drawer === "sftp" ? "active" : ""} title="SFTP" onClick={() => openSftp(selectedSsh)}><Upload size={14} /></button>}
            <button title={workbenchCopy.splitRight} onClick={() => void splitPane("columns")}><Columns2 size={14} /></button>
            <button title={workbenchCopy.commandPalette} onClick={() => setPaletteOpen(true)}><Command size={14} /></button>
          </>}
          {primaryView && <button title={sidebarCollapsed ? workbenchCopy.showSidebar : workbenchCopy.hideSidebar} onClick={() => setSidebarCollapsed((value) => !value)}>{sidebarCollapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}</button>}
          {!showTopTabs && <button className={view === "settings" ? "active" : ""} title={workbenchCopy.openSettingsAction} onClick={openSettings}><Settings2 size={15} /></button>}
        </div>
      </header>
      {quarantine?.quarantined && !quarantineDismissed && (
        <div className="terminal-quarantine" role="alert">
          <TriangleAlert size={15} aria-hidden="true" />
          <span><strong>{workbenchCopy.quarantineTitle}</strong><small>{workbenchCopy.quarantineMessage}</small></span>
          {quarantine.snapshotPath && <button title={workbenchCopy.quarantineReveal} onClick={() => void window.codex.revealPath(quarantine.snapshotPath!)}><FolderOpen size={12} aria-hidden="true" /><em>{workbenchCopy.quarantineReveal}</em></button>}
          <button className="terminal-quarantine-dismiss" title={workbenchCopy.quarantineDismiss} onClick={() => setQuarantineDismissed(true)}><X size={13} aria-hidden="true" /></button>
        </div>
      )}
      {moreMenuOpen && (
        <div className="more-menu-overlay" onClick={() => setMoreMenuOpen(false)}>
          <div className="more-menu" role="menu" style={moreMenuPosition} onClick={(event) => event.stopPropagation()}>
            <button role="menuitem" onClick={() => { setMoreMenuOpen(false); setShellPaletteOpen(true); }}><SquareTerminal size={13} />{workbenchCopy.selectTerminal}</button>
            <div className="more-menu-separator" role="separator" />
            <button role="menuitem" onClick={() => { setMoreMenuOpen(false); openSettings(); }}><Settings2 size={13} />{workbenchCopy.openSettingsAction}</button>
          </div>
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
          <button onClick={() => { const id = tabMenu.sessionId; setTabMenu(undefined); void exportSession(id); }}><Download size={12} />{workbenchCopy.exportSession}</button>
          <button className="danger" onClick={() => { const id = tabMenu.sessionId; setTabMenu(undefined); void closeTerminal(id); }}><X size={12} />{workbenchCopy.closeTerminal}</button>
        </div>
      )}
      <div className="terminal-main">
        {showSidePanel && chatView && <aside className="terminal-side-panel chat-side-panel">{chatSidebar}</aside>}
        {showSidePanel && (terminalView || (settingsTabOpen && settingsViewSideMode)) && <aside className="terminal-side-panel">
          {(settings.tabPosition === "side") && <div className="side-section-heading tabs-heading"><button title={workbenchCopy.toggleTabs} onClick={() => setTabsCollapsed((value) => !value)}>{tabsCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}<strong>{workbenchCopy.tabs}</strong></button><span>{sessions.length + (settingsTabOpen ? 1 : 0)}</span><div className="side-heading-actions"><button title={workbenchCopy.newTerminal} onClick={() => void createTerminal(active?.cwd || projectPath, { reuseExisting: false, shellId: settings.defaultShellId })}><Plus size={18} /></button><button title={workbenchCopy.selectTerminal} onClick={() => setShellPaletteOpen(true)}><EllipsisVertical size={18} /></button></div></div>}
          {!tabsCollapsed && (settings.tabPosition === "side") && <div className="terminal-side-tabs">{sessions.map((session) => <div className={`terminal-tab ${containsLeaf(paneTree, session.id) ? "active" : ""}`} data-session-id={session.id} data-tab-color={tabColors[session.id] || ""} key={session.id} draggable onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }} onAuxClick={(event) => { if (event.button !== 1) return; event.preventDefault(); event.stopPropagation(); void closeTerminal(session.id); }} onContextMenu={(event) => { event.preventDefault(); setTabMenu({ sessionId: session.id, x: event.clientX, y: event.clientY }); }} onDragStart={(event) => { setDraggingSession(session.id); event.dataTransfer.setData("text/terminal-session", session.id); }} onDragEnd={() => { setDraggingSession(undefined); setDockTarget(null); }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const source = event.dataTransfer.getData("text/terminal-session"); if (source) reorderSession(source, session.id); }}>{tabColors[session.id] && <i className="terminal-tab-color" style={{ background: tabColors[session.id] }} />}<button className="terminal-tab-main" title={session.cwd} onClick={() => assignSession(session.id)}><span className={terminalStateClass(session)} title={session.exitCode != null && session.exitCode !== 0 ? workbenchCopy.processExited(session.exitCode) : undefined}>{terminalStateIcon(session)}</span>{terminalIcon(session)}<span><strong>{tabDisplayTitle(session)}</strong><small>{session.status === "exited" && session.exitCode != null && session.exitCode !== 0 ? workbenchCopy.processExited(session.exitCode) : session.activity === "running" ? session.activeCommand : session.remoteHost || session.cwd}</small></span>{session.activity === "idle" && <em>{shellTag(session)}</em>}</button>{session.kind === "ssh" && session.exitedAt && <button className="terminal-tab-retry" title={workbenchCopy.xRetryTerminal} onClick={() => void restartSsh(session)}><RefreshCw size={11} /></button>}<button className="terminal-tab-close" title={workbenchCopy.closeTerminal} onClick={() => void closeTerminal(session.id)}><X size={11} /></button></div>)}{settingsTabOpen && <div className={`terminal-tab settings-tab${view === "settings" ? " active" : ""}`} data-tab-kind="settings" key="settings-tab" onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }} onAuxClick={(event) => { if (event.button !== 1) return; event.preventDefault(); event.stopPropagation(); closeSettingsTab(); }}><button className="terminal-tab-main" title={workbenchCopy.settings} onClick={openSettings}><Settings2 size={13} /><span><strong>{workbenchCopy.settings}</strong></span></button><button className="terminal-tab-close" title={workbenchCopy.closeSettings} onClick={closeSettingsTab}><X size={11} /></button></div>}</div>}
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
            {active && <div className="command-dock"><Search size={13} /><div><input aria-label={workbenchCopy.commandInput} value={commandText} placeholder={workbenchCopy.runCommandPlaceholder} onChange={(event) => { historyCursorRef.current = -1; setCommandText(event.target.value); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); if (completionCandidates[suggestionIndex]) acceptCompletion(completionCandidates[suggestionIndex].value); else sendCommand(); } else if (event.key === "Tab" && completionCandidates.length) { event.preventDefault(); acceptCompletion(completionCandidates[suggestionIndex]?.value ?? completionCandidates[0].value); } else if (event.key === "Tab" && ghost) { event.preventDefault(); setCommandText(ghost); } else if (event.key === "ArrowDown" && completionCandidates.length) { event.preventDefault(); setSuggestionIndex((value) => (value + 1) % completionCandidates.length); } else if (event.key === "ArrowUp" && completionCandidates.length) { event.preventDefault(); setSuggestionIndex((value) => (value - 1 + completionCandidates.length) % completionCandidates.length); } else if (event.key === "ArrowDown" && suggestions.length) { event.preventDefault(); setSuggestionIndex((value) => (value + 1) % suggestions.length); } else if (event.key === "ArrowUp" && suggestions.length) { event.preventDefault(); setSuggestionIndex((value) => (value - 1 + suggestions.length) % suggestions.length); } else if (event.key === "ArrowDown" && !completionCandidates.length && !suggestions.length) { event.preventDefault(); void navigateHistory(1, active?.cwd, event.currentTarget.value); } else if (event.key === "ArrowUp" && !completionCandidates.length && !suggestions.length) { event.preventDefault(); void navigateHistory(-1, active?.cwd, event.currentTarget.value); } else if (event.key === "Escape" && completionCandidates.length) { event.preventDefault(); setCompletionCandidates([]); setCompletionDismissed(true); } }} />{!completionCandidates.length && ghostSuffix && <span aria-hidden="true"><b>{commandText}</b>{ghostSuffix}</span>}{completionCandidates.length > 0 && <div className="completion-popup" role="listbox" aria-label={workbenchCopy.commandSuggestions}>{completionCandidates.map((candidate, index) => <button key={`${candidate.source}:${candidate.value}`} role="option" aria-selected={index === suggestionIndex} className={`completion-src-${candidate.source}${index === suggestionIndex ? " selected" : ""}`} onMouseDown={(event) => { event.preventDefault(); acceptCompletion(candidate.value); }} onMouseEnter={() => setSuggestionIndex(index)}><i aria-hidden="true">{completionSourceIcons[candidate.source]}</i><span>{candidate.value}</span><em>{workbenchCopy[completionSourceLabels[candidate.source]]}</em></button>)}</div>}</div><button title={workbenchCopy.runCommand} disabled={!commandText.trim()} onClick={() => sendCommand()}><ChevronRight size={14} /></button></div>}
          </div>
          {view === "settings" && <SettingsPanel settings={settings} shells={shells} cliTools={cliTools} cliLifecycleStatus={cliLifecycleStatus} cliLifecycleBusy={cliLifecycleBusy} onChange={onSettingsChange} onCliLifecycleToggle={onCliLifecycleToggle} onConnectSsh={connectSsh} onClose={closeSettingsTab} />}
          {view === "document" && document && <DocumentViewer document={document} root={filesRoot} onClose={() => setView("terminal")} onError={onError} />}
        </section>
        {terminalView && drawer && settings.resizablePanels && <div className="panel-resizer drawer-resizer" onPointerDown={(event) => resizePanel("drawer", event)} />}
        {terminalView && drawer === "files" && project && (filesSshProfile
          ? <SftpDrawer profile={filesSshProfile} onClose={() => setDrawer(null)} onError={onError} />
          : <FilesDrawer root={filesRoot} onClose={() => setDrawer(null)} onNewTerminal={(path) => void createTerminal(path, { reuseExisting: false, shellId: settings.defaultShellId })} onDocument={(next) => {
  if (next.kind === "image") {
    setDocument(next);
    setDrawer(null);
    setView("document");
  } else {
    openDocumentPane(next, filesRoot);
    setDrawer(null);
  }
}} onError={onError} />)}
        {terminalView && drawer === "git" && project && <GitDrawer root={projectPath} onClose={() => setDrawer(null)} onError={onError} />}
        {terminalView && drawer === "sftp" && selectedSsh && <SftpDrawer profile={selectedSsh} onClose={() => setDrawer(null)} onError={onError} />}
        {terminalView && drawer === "directories" && <DirectoriesDrawer onClose={() => setDrawer(null)} onNewTerminal={(path) => void createTerminal(path, { reuseExisting: false, shellId: settings.defaultShellId })} onCd={jumpToDirectory} onError={onError} />}
      </div>
      {notice && <button className="terminal-notice" onClick={() => { assignSession(notice.sessionId); setNotice(undefined); }}><Bell size={15} /><span><strong>{sanitizeDisplayText(notice.title)}</strong><small>{sanitizeDisplayText(notice.message)}</small></span><ChevronLeft size={13} /></button>}
      {paletteOpen && <CommandPalette actions={paletteActions} onClose={() => setPaletteOpen(false)} />}
      {shellPaletteOpen && <CommandPalette actions={shellPaletteActions} onClose={() => setShellPaletteOpen(false)} />}
      {sshEditor && <SshEditor profile={sshEditor === "new" ? undefined : sshEditor} onClose={() => setSshEditor(undefined)} onError={onError} onSave={async (profile) => { const saved = await window.codex.saveSshProfile(profile); setSshEditor(undefined); await refreshSshProfiles(); setSelectedSsh(saved); }} onDelete={async (id) => { await window.codex.deleteSshProfile(id); setSshEditor(undefined); await refreshSshProfiles(); }} />}
    </main>
  );
}
