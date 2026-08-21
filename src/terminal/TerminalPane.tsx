import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { ImageAddon } from "@xterm/addon-image";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal as XTerm } from "@xterm/xterm";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import type { TerminalCursorStyle, TerminalInfo, TerminalThemeName } from "../types";
import { useUiCopy } from "../i18n";
import { terminalThemes } from "./themes";

interface TerminalPaneProps {
  session: TerminalInfo;
  theme: TerminalThemeName;
  cursorStyle: TerminalCursorStyle;
  cursorBlink: boolean;
  copyOnSelect: boolean;
  active: boolean;
  onFocus(): void;
}

const draggedPathType = "application/x-codex-ui-path";

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

export default function TerminalPane({ session, theme, cursorStyle, cursorBlink, copyOnSelect, active, onFocus }: TerminalPaneProps) {
  const copy = useUiCopy().workbench;
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerm | undefined>(undefined);
  const fitRef = useRef<FitAddon | undefined>(undefined);
  const searchRef = useRef<SearchAddon | undefined>(undefined);
  const copyOnSelectRef = useRef(copyOnSelect);
  const onFocusRef = useRef(onFocus);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => { copyOnSelectRef.current = copyOnSelect; }, [copyOnSelect]);
  useEffect(() => { onFocusRef.current = onFocus; }, [onFocus]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const terminal = new XTerm({
      cursorBlink,
      cursorStyle,
      cursorInactiveStyle: "outline",
      fontFamily: '"Cascadia Code", "Cascadia Mono", "SFMono-Regular", Consolas, "Noto Sans Mono CJK SC", "Microsoft YaHei UI", monospace',
      fontSize: 12,
      lineHeight: 1.2,
      reflowCursorLine: true,
      rescaleOverlappingGlyphs: true,
      scrollback: 10_000,
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
    terminalRef.current = terminal;
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
            lastCols = terminal.cols;
            lastRows = terminal.rows;
            void window.codex.resizeTerminal(session.id, terminal.cols, terminal.rows);
          }
        } catch {
          // Resizing can race with disposal while rearranging panes.
        }
      });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    const input = terminal.onData((data) => { void window.codex.writeTerminal(session.id, data); });
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
      void readClipboard().then((text) => {
        if (text) { terminal.paste(text); return; }
        if (session.kind === "ssh") return;
        void window.codex.pasteClipboardImage().then((path) => {
          if (path) return window.codex.writeTerminal(session.id, quotePath(path, session));
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
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
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
      else if (event.type === "exit") terminal.write(`\r\n\x1b[90m[process exited ${event.code ?? ""}]\x1b[0m\r\n`);
      else if (event.type === "error" && event.message) terminal.write(`\r\n\x1b[31m${event.message}\x1b[0m\r\n`);
    });
    void window.codex.attachTerminal(session.id).then((attached) => {
      if (cancelled || !attached) return;
      if (attached.snapshot) terminal.write(attached.snapshot);
      if (attached.terminal.status === "exited") terminal.write("\r\n\x1b[90m[process exited]\x1b[0m\r\n");
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
      removeEvents();
      selection.dispose();
      input.dispose();
      terminal.dispose();
      terminalRef.current = undefined;
      fitRef.current = undefined;
      searchRef.current = undefined;
    };
  }, [session.id]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.theme = terminalThemes[theme].terminal;
  }, [theme]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.cursorStyle = cursorStyle;
    terminal.options.cursorInactiveStyle = "outline";
    terminal.options.cursorBlink = cursorBlink;
  }, [cursorBlink, cursorStyle]);

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
