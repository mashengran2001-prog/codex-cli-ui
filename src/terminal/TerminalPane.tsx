import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import type { ILink } from "@xterm/xterm";
import { ImageAddon } from "@xterm/addon-image";
import { SearchAddon } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal as XTerm } from "@xterm/xterm";
import katex from "katex";
import { TerminalMathOverlay } from "./terminal-math";
import { BoxGlyphOverlay } from "./box-glyphs";
import { dragScrollStep } from "./drag-scroll";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import type { TerminalCursorStyle, TerminalInfo, TerminalThemeName } from "../types";
import { useUiCopy } from "../i18n";
import { terminalThemes } from "./themes";

interface TerminalPaneProps {
  session: TerminalInfo;
  theme: TerminalThemeName;
  cursorStyle: TerminalCursorStyle;
  cursorBlink: boolean;
  fontFamily: string;
  cellWidth: "compact" | "relaxed";
  backgroundOverride?: string;
  bellFlash: boolean;
  copyOnSelect: boolean;
  renderTerminalMath: boolean;
  builtinBoxDrawing: boolean;
  active: boolean;
  onFocus(): void;
  onTerminalReady?(id: string, terminal: XTerm | null): void;
  onError?(message: string): void;
  onBroadcast?(data: string): void;
}

// Tiny transient pane sizes (tab re-layout, window minimize) must never reach
// the PTY: ConPTY/PSReadLine loses its prompt state at 1-row sizes and later
// repaints erase the whole screen without redrawing.
const MIN_PTY_COLS = 10;
const MIN_PTY_ROWS = 3;
const draggedPathType = "application/x-codex-ui-path";
const LINK_PATTERN = /(?:https?:\/\/[^\s<>"']+|\b[a-zA-Z]:[\\/][^\s<>"']*|\\\\[^\s<>"']+|\.[\\/][^\s<>"']+|\.{2}[\\/][^\s<>"']+)/;

interface LinkPreviewState {
  path: string;
  resolved: string;
  info: { kind: "file" | "directory"; name: string; size?: number } | null;
  x: number;
  y: number;
}
const DEFAULT_FONT_STACK = '"Cascadia Code", "Cascadia Mono", "SFMono-Regular", Consolas, "Noto Sans Mono CJK SC", "Microsoft YaHei UI", monospace';

function pathForShell(path: string, session: TerminalInfo) {
  const shellId = session.shellId.toLowerCase();
  const shell = session.shell.toLowerCase();
  if (shellId.startsWith("wsl:") && /^[a-z]:[\\/]/i.test(path)) {
    const drive = path[0].toLowerCase();
    return `/mnt/${drive}/${path.slice(3).replaceAll("\\", "/")}`;
  }
  if ((shellId.includes("git-bash") || shell.includes("bash")) && /^[a-z]:[\\/]/i.test(path)) {
    const drive = path[0].toLowerCase();
    return `/${drive}/${path.slice(3).replaceAll("\\", "/")}`;
  }
  return path;
}

function quotePath(path: string, session: TerminalInfo) {
  const value = pathForShell(path, session);
  const shellId = session.shellId.toLowerCase();
  const shell = session.shell.toLowerCase();
  if (shellId.includes("cmd") || /(^|[\\/])cmd(?:\.exe)?$/i.test(shell)) return `"${value.replaceAll('"', '""')}"`;
  if (shellId.includes("powershell") || shellId.includes("pwsh") || shell.includes("powershell") || shell.includes("pwsh")) return `'${value.replaceAll("'", "''")}'`;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Windows-friendly path resolution for Ctrl+click link targets. */
function resolveTerminalPath(base: string, candidate: string) {
  if (/^[a-zA-Z]:[\\/]/.test(candidate) || candidate.startsWith("\\\\")) return candidate.replace(/[\\/]+$/, "");
  const segments = candidate.split(/[\\/]+/).filter(Boolean);
  const baseSegments = base.split(/[\\/]+/).filter(Boolean);
  const stack = baseSegments.slice(0, -1);
  for (const segment of segments) {
    if (segment === ".") continue;
    if (segment === "..") stack.pop();
    else stack.push(segment);
  }
  const drive = base.match(/^[a-zA-Z]:/)?.[0];
  return `${drive ? drive + "\\" : ""}${stack.join("\\")}`;
}

export default function TerminalPane({ session, theme, cursorStyle, cursorBlink, fontFamily, cellWidth, backgroundOverride, bellFlash, copyOnSelect, renderTerminalMath, builtinBoxDrawing, active, onFocus, onTerminalReady, onError, onBroadcast }: TerminalPaneProps) {
  const copy = useUiCopy().workbench;
  const copyRef = useRef(copy);
  useEffect(() => { copyRef.current = copy; }, [copy]);
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerm | undefined>(undefined);
  const fitRef = useRef<FitAddon | undefined>(undefined);
  const searchRef = useRef<SearchAddon | undefined>(undefined);
  const copyOnSelectRef = useRef(copyOnSelect);
  const mathOverlayRef = useRef<TerminalMathOverlay | null>(null);
  const glyphOverlayRef = useRef<BoxGlyphOverlay | null>(null);
  const onFocusRef = useRef(onFocus);
  const onErrorRef = useRef(onError);
  const onBroadcastRef = useRef(onBroadcast);
  const [searchOpen, setSearchOpen] = useState(false);
  const [linkPreview, setLinkPreview] = useState<LinkPreviewState | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => { copyOnSelectRef.current = copyOnSelect; }, [copyOnSelect]);
  useEffect(() => { onFocusRef.current = onFocus; }, [onFocus]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);
  useEffect(() => { onBroadcastRef.current = onBroadcast; }, [onBroadcast]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const terminal = new XTerm({
      cursorBlink,
      cursorStyle,
      cursorInactiveStyle: "outline",
      fontFamily: fontFamily.trim() || DEFAULT_FONT_STACK,
      fontSize: 12,
      lineHeight: cellWidth === "relaxed" ? 1.35 : 1.2,
      letterSpacing: cellWidth === "relaxed" ? 1 : 0,
      reflowCursorLine: true,
      rescaleOverlappingGlyphs: true,
      scrollback: 10_000,
      customGlyphs: true,
      convertEol: false,
      allowTransparency: false,
      theme: terminalThemes[theme].terminal,
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(search);
    terminal.loadAddon(new WebLinksAddon());
    try { terminal.loadAddon(new ImageAddon()); } catch { /* Canvas-less test browsers can skip image decoding. */ }
    terminal.open(container);
    let webgl: WebglAddon | undefined;
    const forceDom = Boolean((window as { __mock?: unknown }).__mock) || window.codex?.rendererMode === "dom";
    if (!forceDom) {
      try {
        const renderer = new WebglAddon();
        renderer.onContextLoss(() => renderer.dispose());
        terminal.loadAddon(renderer);
        webgl = renderer;
        container.dataset.renderer = "webgl";
      } catch {
        container.dataset.renderer = "dom";
      }
    } else {
      container.dataset.renderer = "dom";
    }
    terminalRef.current = terminal;
    container.dataset.cols = String(terminal.cols);
    container.dataset.rows = String(terminal.rows);
    onTerminalReady?.(session.id, terminal);
    fitRef.current = fit;
    searchRef.current = search;

    let lastCols = 0;
    let lastRows = 0;
    let fitFrame = 0;
    const resize = () => {
      window.cancelAnimationFrame(fitFrame);
      fitFrame = window.requestAnimationFrame(() => {
        if (!container.isConnected || container.clientWidth === 0 || container.clientHeight === 0) return;
        try {
          fit.fit();
          if (terminal.cols !== lastCols || terminal.rows !== lastRows) {
            if (terminal.cols < MIN_PTY_COLS || terminal.rows < MIN_PTY_ROWS) return;
            lastCols = terminal.cols;
            lastRows = terminal.rows;
            container.dataset.cols = String(terminal.cols);
            container.dataset.rows = String(terminal.rows);
            void window.codex.resizeTerminal(session.id, terminal.cols, terminal.rows);
          }
        } catch {
          // Resizing can race with disposal while rearranging panes.
        }
      });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    const input = terminal.onData((data) => {
      void window.codex.writeTerminal(session.id, data);
      onBroadcastRef.current?.(data);
    });
    let selectionTimer = 0;
    const copySelection = () => {
      const text = terminal.getSelection();
      if (!text) return;
      void navigator.clipboard.writeText(text).catch(() => window.codex.copyText(text));
    };
    const selection = terminal.onSelectionChange(() => {
      window.clearTimeout(selectionTimer);
      if (!copyOnSelectRef.current || !terminal.hasSelection()) return;
      selectionTimer = window.setTimeout(copySelection, 100);
    });
    const pasteFromClipboard = () => {
      // Reading the clipboard can hang (no document focus, locked clipboard) or
      // reject; resolve within a short window so the image fallback still runs.
      const readClipboard = () => new Promise<string>((resolve) => {
        let settled = false;
        const finish = (text: string) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          resolve(text);
        };
        const timer = window.setTimeout(() => finish(""), 400);
        navigator.clipboard.readText().then(
          (text) => finish(text),
          () => finish(""),
        );
      });
      // 优先走主进程剪贴板（Electron 渲染进程的 navigator.clipboard.readText 常因权限拿不到文本），
      // 拿不到再退回浏览器 API，最后才是剪贴板截图粘贴 —— 修复 SSH/普通会话右键粘贴失效（Nebula #65）。
      void window.codex.readClipboardText().then((text) => {
        if (text) { terminal.paste(text); return; }
        void readClipboard().then((fallback) => {
          if (fallback) { terminal.paste(fallback); return; }
          void window.codex.pasteClipboardImage(session.kind === "ssh" ? session.sshProfileId : undefined).then((path) => {
            if (path) return window.codex.writeTerminal(session.id, quotePath(path, session));
          });
        });
      });
    };
    const contextMenu = (event: MouseEvent) => {
      event.preventDefault();
      onFocusRef.current();
      if (terminal.hasSelection()) {
        copySelection();
        terminal.clearSelection();
        return;
      }
      pasteFromClipboard();
    };
    const dragOver = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes(draggedPathType)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "copy";
    };
    const drop = (event: DragEvent) => {
      const path = event.dataTransfer?.getData(draggedPathType);
      if (!path) return;
      event.preventDefault();
      event.stopPropagation();
      onFocusRef.current();
      void window.codex.writeTerminal(session.id, quotePath(path, session));
      terminal.focus();
    };
    container.addEventListener("contextmenu", contextMenu);
    container.addEventListener("dragover", dragOver);
    container.addEventListener("drop", drop);
    // Nebula 1.3：拖拽选择时视口自动滚动（边缘 1 行，每 20px +1，15ms 节奏）
    let dragScrollTimer = 0;
    let dragArmed = false;
    let dragDistance = 0;
    const stopDragScroll = () => {
      dragArmed = false;
      window.clearInterval(dragScrollTimer);
      dragScrollTimer = 0;
    };
    const updateDragDistance = (clientY: number) => {
      const screen = container.querySelector<HTMLElement>(".xterm-screen") ?? container;
      const rect = screen.getBoundingClientRect();
      dragDistance = clientY < rect.top ? clientY - rect.top : clientY > rect.bottom ? clientY - rect.bottom : 0;
      if (dragDistance === 0) {
        window.clearInterval(dragScrollTimer);
        dragScrollTimer = 0;
      } else if (!dragScrollTimer) {
        dragScrollTimer = window.setInterval(() => {
          if (!dragArmed) return;
          terminal.scrollLines(dragScrollStep(dragDistance));
        }, 15);
      }
    };
    const onDragMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) return;
      dragArmed = true;
      updateDragDistance(event.clientY);
    };
    const onDragMouseMove = (event: MouseEvent) => {
      if (!dragArmed || (event.buttons & 1) === 0) return;
      updateDragDistance(event.clientY);
    };
    const onDragMouseUp = () => stopDragScroll();
    container.addEventListener("mousedown", onDragMouseDown);
    window.addEventListener("mousemove", onDragMouseMove);
    window.addEventListener("mouseup", onDragMouseUp);
    window.addEventListener("blur", onDragMouseUp);
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      // IME composition (搜狗/微软拼音 etc.): keyCode 229 marks in-progress
      // candidates; let xterm feed the composition and never hijack Ctrl+C/V.
      if (event.isComposing || event.keyCode === 229) return true;
      const key = event.key.toLowerCase();
      if (event.ctrlKey && !event.shiftKey && key === "f") {
        setSearchOpen(true);
        return false;
      }
      if (event.ctrlKey && (key === "+" || key === "=")) {
        terminal.options.fontSize = Math.min(24, (terminal.options.fontSize || 12) + 1);
        resize();
        return false;
      }
      if (event.ctrlKey && key === "-") {
        terminal.options.fontSize = Math.max(8, (terminal.options.fontSize || 12) - 1);
        resize();
        return false;
      }
      if (event.ctrlKey && key === "0") {
        terminal.options.fontSize = 12;
        resize();
        return false;
      }
      if (event.ctrlKey && event.shiftKey && key === "c") {
        if (terminal.hasSelection()) {
          copySelection();
          terminal.clearSelection();
        }
        return false;
      }
      if (event.ctrlKey && !event.shiftKey && key === "c" && terminal.hasSelection()) {
        copySelection();
        terminal.clearSelection();
        return false;
      }
      if (event.ctrlKey && event.shiftKey && key === "v") {
        pasteFromClipboard();
        return false;
      }
      if (event.ctrlKey && !event.shiftKey && key === "v") {
        pasteFromClipboard();
        return false;
      }
      return true;
    });
    let cancelled = false;
    const removeEvents = window.codex.onTerminalEvent((event) => {
      if (event.sessionId !== session.id) return;
      if (event.type === "data" && event.data) terminal.write(event.data);
      else if (event.type === "exit") {
        const code = event.code;
        const color = code != null && code !== 0 ? "31" : "90";
        terminal.write(`\r\n\x1b[${color}m[process exited${code === undefined ? "" : ` (code ${code})`}]\x1b[0m\r\n`);
      }
      else if (event.type === "error" && event.message) terminal.write(`\r\n\x1b[31m${event.message}\x1b[0m\r\n`);
    });
    void window.codex.attachTerminal(session.id).then((attached) => {
      if (cancelled || !attached) return;
      if (attached.snapshot) terminal.write(attached.snapshot);
      if (attached.terminal.status === "exited") {
        const code = attached.terminal.exitCode ?? session.exitCode;
        const color = code != null && code !== 0 ? "31" : "90";
        terminal.write(`\r\n\x1b[${color}m[process exited${code === undefined ? "" : ` (code ${code})`}]\x1b[0m\r\n`);
      }
      window.requestAnimationFrame(() => { resize(); if (active) terminal.focus(); });
    });
    return () => {
      cancelled = true;
      window.clearTimeout(selectionTimer);
      window.cancelAnimationFrame(fitFrame);
      observer.disconnect();
      container.removeEventListener("contextmenu", contextMenu);
      container.removeEventListener("dragover", dragOver);
      container.removeEventListener("drop", drop);
      stopDragScroll();
      container.removeEventListener("mousedown", onDragMouseDown);
      window.removeEventListener("mousemove", onDragMouseMove);
      window.removeEventListener("mouseup", onDragMouseUp);
      window.removeEventListener("blur", onDragMouseUp);
      removeEvents();
      selection.dispose();
      input.dispose();
      try { webgl?.dispose(); } catch { /* Renderer may already be gone. */ }
      terminal.dispose();
      terminalRef.current = undefined;
      onTerminalReady?.(session.id, null);
      fitRef.current = undefined;
      searchRef.current = undefined;
    };
  }, [session.id]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    mathOverlayRef.current?.refresh();
    glyphOverlayRef.current?.refresh();
    terminal.options.theme = backgroundOverride
      ? { ...terminalThemes[theme].terminal, background: backgroundOverride }
      : terminalThemes[theme].terminal;
  }, [backgroundOverride, theme]);

  useEffect(() => {
    const terminal = terminalRef.current;
    const container = containerRef.current;
    if (!terminal || !container) return;
    if (!renderTerminalMath) {
      mathOverlayRef.current?.dispose();
      mathOverlayRef.current = null;
      return;
    }
    const xtermEl = container.querySelector<HTMLElement>(".xterm");
    if (!xtermEl) return;
    const overlay = new TerminalMathOverlay(terminal, xtermEl, (tex, display) =>
      katex.renderToString(tex, { displayMode: display, throwOnError: false, output: "html" }),
    );
    mathOverlayRef.current = overlay;
    overlay.refresh();
    return () => {
      overlay.dispose();
      if (mathOverlayRef.current === overlay) mathOverlayRef.current = null;
    };
  }, [renderTerminalMath, session.id]);

  useEffect(() => {
    const terminal = terminalRef.current;
    const container = containerRef.current;
    if (!terminal || !container) return;
    if (!builtinBoxDrawing) {
      glyphOverlayRef.current?.dispose();
      glyphOverlayRef.current = null;
      return;
    }
    const xtermEl = container.querySelector<HTMLElement>(".xterm");
    if (!xtermEl) return;
    const overlay = new BoxGlyphOverlay(terminal, xtermEl);
    glyphOverlayRef.current = overlay;
    overlay.refresh();
    return () => {
      overlay.dispose();
      if (glyphOverlayRef.current === overlay) glyphOverlayRef.current = null;
    };
  }, [builtinBoxDrawing, session.id]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const cwd = session.cwd;
    const container = containerRef.current;
    if (!container) return;
    const resolvePointerTarget = (clientX: number, clientY: number) => {
      const rowsEl = container.querySelector<HTMLElement>(".xterm-rows");
      const rowsRect = rowsEl?.getBoundingClientRect();
      if (!rowsRect || rowsRect.height <= 0) return null;
      const buffer = terminal.buffer.active;
      const rowEls = Array.from(rowsEl?.children ?? []) as HTMLElement[];
      let rowIndex: number;
      if (rowEls.length > 0) {
        const hit = rowEls.findIndex((el) => {
          const r = el.getBoundingClientRect();
          return clientY >= r.top && clientY < r.bottom;
        });
        if (hit < 0) return null;
        rowIndex = hit;
      } else {
        const measure = container.querySelector(".xterm-char-measure-element");
        const lineHeight = measure ? measure.getBoundingClientRect().height : 14;
        rowIndex = Math.floor((clientY - rowsRect.top) / lineHeight);
        const visibleRows = Math.max(1, Math.floor(rowsRect.height / lineHeight));
        if (rowIndex < 0 || rowIndex >= visibleRows) return null;
      }
      const charWidth = rowsRect.width / Math.max(1, terminal.cols);
      const column = Math.max(0, Math.floor((clientX - rowsRect.left) / charWidth));
      const line = buffer.getLine(rowIndex + buffer.viewportY);
      if (!line) return null;
      const text = line.translateToString(false);
      const start = text.slice(0, column).search(/[^\s]+$/);
      if (start < 0) return null;
      const token = text.slice(start).match(/^[^\s]+/)?.[0] ?? "";
      if (!token || token.length > 1_000) return null;
      if (!token.match(LINK_PATTERN)) return null;
      const candidate = token.trim().replace(/[;,)\]}>]+$/, "");
      return { token, resolved: resolveTerminalPath(cwd, candidate) };
    };
    const onMove = (event: MouseEvent) => {
      if (!event.ctrlKey) { setLinkPreview(null); return; }
      const target = resolvePointerTarget(event.clientX, event.clientY);
      if (target) { void window.codex.probePath(target.resolved).then((info) => { const rect = container.getBoundingClientRect(); setLinkPreview({ path: target.token, resolved: target.resolved, info, x: Math.min(rect.width - 240, Math.max(8, event.clientX - rect.left)), y: Math.min(rect.height - 70, Math.max(8, event.clientY - rect.top + 16)) }); }).catch(() => setLinkPreview(null)); }
    };
    const onClick = (event: MouseEvent) => {
      if (!event.ctrlKey) return;
      const target = resolvePointerTarget(event.clientX, event.clientY);
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      void window.codex.openPath(target.resolved).catch(() => false).then((opened) => {
        if (!opened) onErrorRef.current?.(copyRef.current.linkOpenFailed);
      });
    };
    container.addEventListener("mousemove", onMove, true);
    container.addEventListener("click", onClick, true);
    const provider = terminal.registerLinkProvider({
      provideLinks(bufferLineNumber: number, callback: (links: ILink[]) => void): void {
        const buffer = terminal.buffer.active;
        const line = buffer.getLine(bufferLineNumber);
        if (!line) { callback([]); return; }
        const lineText = line.translateToString(true);
        const found: ILink[] = [];
        for (const match of lineText.matchAll(LINK_PATTERN)) {
          const index = match.index ?? 0;
          const text = match[0];
          if (text.length > 1_000) continue;
          found.push({
            text,
            range: { start: { x: index + 1, y: bufferLineNumber + 1 }, end: { x: index + text.length + 1, y: bufferLineNumber + 1 } },
            activate: (_event, textToActivate) => {
              if (!_event.ctrlKey) return;
              const candidate = textToActivate.trim().replace(/[;,)\]}>]+$/, "");
              const resolved = resolveTerminalPath(cwd, candidate);
              void window.codex.openPath(resolved).catch(() => false).then((opened) => {
                if (!opened) onErrorRef.current?.(copyRef.current.linkOpenFailed);
              });
            },
            hover: (event, textToHover) => {
              if (!event.ctrlKey) { setLinkPreview(null); return; }
              const candidate = textToHover.trim().replace(/[;,)\]}>]+$/, "");
              const resolved = resolveTerminalPath(cwd, candidate);
              void window.codex.probePath(resolved).then((info) => {
                const containerRect = containerRef.current?.getBoundingClientRect();
                if (!containerRect) return;
                setLinkPreview({
                  path: textToHover,
                  resolved,
                  info,
                  x: Math.min(containerRect.width - 240, Math.max(8, event.clientX - containerRect.left)),
                  y: Math.min(containerRect.height - 70, Math.max(8, event.clientY - containerRect.top + 16)),
                });
              }).catch(() => setLinkPreview(null));
            },
            leave: () => setLinkPreview(null),
          });
        }
        callback(found);
      },
    });
    return () => {
      container.removeEventListener("mousemove", onMove, true);
      container.removeEventListener("click", onClick, true);
      provider.dispose();
      setLinkPreview(null);
    };
  }, [session.cwd, session.id]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.cursorStyle = cursorStyle;
    terminal.options.cursorInactiveStyle = "outline";
    terminal.options.cursorBlink = cursorBlink;
  }, [cursorBlink, cursorStyle]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const next = fontFamily.trim() || DEFAULT_FONT_STACK;
    if (terminal.options.fontFamily === next) return;
    terminal.options.fontFamily = next;
    window.requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
        if (terminal.cols < MIN_PTY_COLS || terminal.rows < MIN_PTY_ROWS) return;
        void window.codex.resizeTerminal(session.id, terminal.cols, terminal.rows);
      } catch { /* Font swap can race with layout changes. */ }
    });
  }, [fontFamily]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const relaxed = cellWidth === "relaxed";
    terminal.options.lineHeight = relaxed ? 1.35 : 1.2;
    terminal.options.letterSpacing = relaxed ? 1 : 0;
    window.requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
        if (terminal.cols < MIN_PTY_COLS || terminal.rows < MIN_PTY_ROWS) return;
        void window.codex.resizeTerminal(session.id, terminal.cols, terminal.rows);
      } catch { /* Cell-width swap can race with layout changes. */ }
    });
  }, [cellWidth, session.id]);

  useEffect(() => {
    if (!active) return;
    window.requestAnimationFrame(() => {
      try { fitRef.current?.fit(); terminalRef.current?.focus(); } catch { /* Pane can disappear during layout updates. */ }
    });
  }, [active]);

  useEffect(() => {
    if (!query) return;
    searchRef.current?.findNext(query, { incremental: true, caseSensitive: false });
  }, [query]);

  return (
    <div className={`terminal-pane-shell ${active ? "active" : ""}`} data-active={active} onMouseDown={onFocus}>
      <div className="terminal-canvas" ref={containerRef} />
      {linkPreview && (
        <div className="terminal-link-preview" style={{ left: linkPreview.x, top: linkPreview.y }}>
          <strong>{linkPreview.info ? linkPreview.info.name : linkPreview.path}</strong>
          <small>{linkPreview.info ? (linkPreview.info.kind === "directory" ? copyRef.current.linkDir : `${Math.max(1, Math.round((linkPreview.info.size || 0) / 1024))} KB`) : copyRef.current.linkNotFound}</small>
          <em>{copyRef.current.linkHint}</em>
        </div>
      )}
      {searchOpen && (
        <div className="terminal-search-popover">
          <Search size={13} />
          <input autoFocus value={query} aria-label={copy.searchTerminal} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setSearchOpen(false); if (event.key === "Enter") searchRef.current?.findNext(query); }} />
          <button title="Previous match" onClick={() => searchRef.current?.findPrevious(query)}><ChevronUp size={13} /></button>
          <button title="Next match" onClick={() => searchRef.current?.findNext(query)}><ChevronDown size={13} /></button>
          <button title="Close search" onClick={() => setSearchOpen(false)}><X size={13} /></button>
        </div>
      )}
    </div>
  );
}
