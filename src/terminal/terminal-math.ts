import type { IBufferLine, IDisposable, Terminal as XTerm } from "@xterm/xterm";

/**
 * Nebula #55 对照实现：终端内 TeX 公式渲染。
 * - 识别 $...$ / $$...$$ / \(...\) / \[...\]（含跨软换行与 Agent TUI 硬换行）
 * - 保守恢复被 Markdown 层剥掉定界符的 (...)/[...] 公式
 * - 归一化终端损伤的 TeX（HTML 实体、行断折叠、\frac13 无括号参数）
 * - 暗色（dim）推理行保持原文不渲染
 */

export interface TerminalMathSpan {
  /** 视口内起始行（0 起） */
  startRow: number;
  /** 起始列（0 起） */
  startCol: number;
  /** 结束行（含） */
  endRow: number;
  /** 结束列（含） */
  endCol: number;
  /** 归一化后的 TeX 源码 */
  source: string;
  display: boolean;
}

export const MAX_FORMULA_LENGTH = 800;

const STRONG_MATH = /(\\[a-zA-Z]+|[\^_{}~]|[αβγδθλμπσφω∞√∫∑∏±×÷])/;
const MATH_OPERATORS = /[=+\-*/<>~|]/g;

/** 标准定界符内容的中等证据：命令、上下标、数学符号，或字母搭配运算符。 */
export function hasTeXEvidence(text: string): boolean {
  const value = text.trim();
  if (!value || value.length > MAX_FORMULA_LENGTH) return false;
  if (/^[\\\s]+$/.test(value)) return false;
  if (STRONG_MATH.test(value)) return true;
  return /[a-zA-Z0-9]/.test(value) && (value.match(MATH_OPERATORS) ?? []).length >= 1;
}

/** 裸括号恢复的保守证据：命令/强符号，或至少两个运算符。 */
export function bareRecoveryEvidence(text: string): boolean {
  const value = text.trim();
  if (!value || value.length > MAX_FORMULA_LENGTH || value.length < 2) return false;
  if (STRONG_MATH.test(value)) return true;
  return (value.match(MATH_OPERATORS) ?? []).length >= 2;
}

/** 归一化终端损伤的 TeX 源码。 */
export function normalizeTeX(source: string): string {
  return source
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD]/g, "")
    .replace(/[ \t]*\r?\n[ \t]*/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/(\\frac)(\d)(\d)/g, "$1{$2}{$3}")
    .replace(/(\\sqrt)([a-zA-Z0-9])(?![a-zA-Z0-9{])/g, "$1{$2}")
    .trim();
}

/**
 * 扫描终端可见行中的 TeX 公式跨度。
 * @param rows 每行文本（与视口行一一对应）
 * @param dimmedRows 可选：对应行是否处于 dim（推理）样式
 */
export function scanTerminalMath(rows: readonly string[], dimmedRows: readonly boolean[] = []): TerminalMathSpan[] {
  const spans: TerminalMathSpan[] = [];
  if (!rows.length) return spans;
  const text = rows.join("\n");
  const rowStarts: number[] = [];
  {
    let offset = 0;
    for (const row of rows) {
      rowStarts.push(offset);
      offset += row.length + 1;
    }
  }

  const posToRC = (pos: number): { row: number; col: number } => {
    let row = 0;
    while (row + 1 < rowStarts.length && rowStarts[row + 1] <= pos) row += 1;
    return { row, col: pos - rowStarts[row] };
  };

  const tryAdd = (
    raw: string,
    contentStart: number,
    contentEnd: number,
    display: boolean,
    evidence: (value: string) => boolean,
  ): void => {
    const source = normalizeTeX(raw);
    if (!source || !evidence(source)) return;
    const start = posToRC(contentStart);
    const end = posToRC(contentEnd);
    if (start.row > end.row || (start.row === end.row && start.col > end.col)) return;
    for (let row = start.row; row <= end.row; row += 1) {
      if (dimmedRows[row]) return;
    }
    spans.push({ startRow: start.row, startCol: start.col, endRow: end.row, endCol: end.col, source, display });
  };

  // 标准定界符：$$...$$ / \[...\] / $...$ / \(...\)
  const DELIM_RE = /(?<!\\)\$\$(.+?)(?<!\\)\$\$|(?<!\\)\\\[(.+?)(?<!\\)\\\]|(?<!\\)\$(.+?)(?<!\\)\$|(?<!\\)\\\((.+?)(?<!\\)\\\)/gs;
  const groups: Array<{ opener: number; closer: number; display: boolean }> = [
    { opener: 2, closer: 2, display: true },
    { opener: 2, closer: 2, display: true },
    { opener: 1, closer: 1, display: false },
    { opener: 2, closer: 2, display: false },
  ];
  for (const match of text.matchAll(DELIM_RE)) {
    const index = match.index ?? 0;
    const group = groups.findIndex((_, i) => match[i + 1] !== undefined);
    if (group < 0) continue;
    const raw = match[group + 1]!;
    const { display } = groups[group]!;
    const contentStart = index;
    const contentEnd = index + match[0].length - 1;
    tryAdd(raw, contentStart, contentEnd, display, hasTeXEvidence);
  }

  // 保守恢复被剥掉定界符的 (...)/[...] 公式
  const BARE_RE = /(?<!\\)\((.+?)\)|(?<!\\)\[(.+?)\]/gs;
  for (const match of text.matchAll(BARE_RE)) {
    const index = match.index ?? 0;
    const group = match[1] !== undefined ? 0 : 1;
    const raw = match[group + 1]!;
    const contentStart = index;
    const contentEnd = index + match[0].length - 1;
    const start = posToRC(contentStart);
    const end = posToRC(contentEnd);
    let overlaps = false;
    for (const span of spans) {
      if (!(end.row < span.startRow || start.row > span.endRow)) {
        overlaps = true;
        break;
      }
    }
    if (overlaps) continue;
    tryAdd(raw, contentStart, contentEnd, false, bareRecoveryEvidence);
  }

  return spans;
}

export type MathRenderer = (tex: string, display: boolean) => string;

interface OverlayMetrics {
  cellWidth: number;
  cellHeight: number;
  background: string;
}

/** 把扫描到的公式渲染为覆盖层（不改动终端 buffer，选区/复制仍是原始 TeX 源码）。 */
export class TerminalMathOverlay {
  private layer: HTMLDivElement | null = null;
  private timer = 0;
  private disposed = false;
  private readonly disposables: IDisposable[] = [];

  constructor(
    private readonly terminal: XTerm,
    private readonly container: HTMLElement,
    private readonly render: MathRenderer,
  ) {
    this.disposables.push(
      terminal.onWriteParsed(() => this.schedule()),
      terminal.onScroll(() => this.schedule()),
      terminal.onResize(() => this.schedule()),
    );
  }

  /** 立即重新扫描（设置切换、主题/背景变化后调用）。 */
  refresh(): void {
    this.schedule(0);
  }

  private schedule(delay = 120): void {
    if (this.disposed) return;
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.update(), delay);
  }

  private metrics(): OverlayMetrics {
    const terminal = this.terminal;
    let cellWidth = 9;
    let cellHeight = 15;
    const rowsEl = this.container.querySelector<HTMLElement>(".xterm-rows");
    if (rowsEl) {
      const rect = rowsEl.getBoundingClientRect();
      if (rect.height > 0 && rect.width > 0) {
        cellHeight = rect.height / Math.max(1, terminal.rows);
        cellWidth = rect.width / Math.max(1, terminal.cols);
      }
    }
    let background = terminal.options.theme?.background || "#000000";
    if (!terminal.options.theme?.background) {
      const screen = this.container.querySelector<HTMLElement>(".xterm-screen");
      const computed = screen ? getComputedStyle(screen).backgroundColor : "";
      if (computed && computed !== "transparent" && computed !== "rgba(0, 0, 0, 0)") background = computed;
    }
    return { cellWidth, cellHeight, background };
  }

  private update(): void {
    if (this.disposed) return;
    const terminal = this.terminal;
    const buffer = terminal.buffer.active;
    const rowCount = terminal.rows;
    if (rowCount <= 0 || !this.container.isConnected) return;
    const viewportStart = buffer.viewportY;
    const rows: string[] = [];
    const dimmedRows: boolean[] = [];
    for (let y = 0; y < rowCount; y += 1) {
      const line = buffer.getLine(viewportStart + y);
      rows.push(line ? line.translateToString(true) : "");
      dimmedRows.push(line ? rowIsDimmed(line) : false);
    }
    this.renderSpans(scanTerminalMath(rows, dimmedRows));
  }

  private renderSpans(spans: TerminalMathSpan[]): void {
    this.ensureLayer();
    const layer = this.layer!;
    layer.textContent = "";
    if (!spans.length) {
      layer.style.display = "none";
      return;
    }
    layer.style.display = "block";
    const { cellWidth, cellHeight, background } = this.metrics();
    const cols = Math.max(1, this.terminal.cols);
    const fontSize = Math.max(8, cellHeight / 1.21);
    for (const span of spans) {
      let html: string;
      try {
        html = this.render(span.source, span.display);
      } catch {
        continue;
      }
      if (!html) continue;
      const left = span.startCol * cellWidth;
      const rightEdge = span.endRow > span.startRow ? cols * cellWidth : (span.endCol + 1) * cellWidth;
      const width = Math.max(cellWidth, rightEdge - left);
      const top = span.startRow * cellHeight;
      const height = (span.endRow - span.startRow + 1) * cellHeight;
      const box = document.createElement("div");
      box.className = "codex-terminal-math";
      box.style.cssText = [
        "position:absolute",
        "left:" + left.toFixed(2) + "px",
        "top:" + top.toFixed(2) + "px",
        "width:" + width.toFixed(2) + "px",
        "height:" + height.toFixed(2) + "px",
        "background:" + background,
        "display:flex",
        "align-items:center",
        "justify-content:flex-start",
        "overflow:hidden",
        "font-size:" + fontSize.toFixed(2) + "px",
        "line-height:1",
        "box-sizing:border-box",
        "padding:0 4px",
        "white-space:nowrap",
      ].join(";");
      box.innerHTML = html;
      layer.appendChild(box);
    }
  }

  private ensureLayer(): void {
    if (this.layer && this.layer.isConnected) return;
    const layer = document.createElement("div");
    layer.className = "codex-terminal-math-layer";
    layer.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:6;overflow:hidden;";
    this.container.appendChild(layer);
    this.layer = layer;
  }

  dispose(): void {
    this.disposed = true;
    window.clearTimeout(this.timer);
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables.length = 0;
    this.layer?.remove();
    this.layer = null;
  }
}

function rowIsDimmed(line: IBufferLine): boolean {
  let dim = 0;
  let cells = 0;
  for (let x = 0; x < line.length; x += 1) {
    const cell = line.getCell(x);
    if (!cell) continue;
    cells += 1;
    if (cell.isDim()) dim += 1;
  }
  return cells > 0 && dim / cells >= 0.5;
}