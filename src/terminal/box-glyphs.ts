import type { IDisposable, IBufferCell, Terminal as XTerm } from "@xterm/xterm";

/**
 * Nebula 对照实现：内置制表符字形。
 * - 边框（单线/粗线/双线/虚线/弧角/对角）、方块与象限字符按几何绘制，
 *   不依赖字体字形，任何字体下都能对齐（对标上游 renderer/text/builtin_font/glyphs.rs）。
 * - 线宽：stroke = max(1, round(cellWidth / 8))，粗线 = stroke * 2。
 * - 覆盖层随终端写入/滚动/缩放重绘，颜色取自 cell 前景色（RGB / 256 色板 / 主题前景）。
 */

export const BOX_GLYPH_CODEPOINT_START = 0x2500;
export const BOX_GLYPH_CODEPOINT_END = 0x259f;

export interface BoxGlyphFill {
  kind: "fill";
  x: number;
  y: number;
  w: number;
  h: number;
  /** 灰度值（阴影字符 ░▒▓ 使用固定灰度，与其他字体行为一致） */
  gray?: number;
}
export interface BoxGlyphStroke {
  kind: "stroke";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
}
export interface BoxGlyphArc {
  kind: "arc";
  cx: number;
  cy: number;
  r: number;
  start: number;
  end: number;
  width: number;
}
export interface BoxGlyphGeometry {
  fills: BoxGlyphFill[];
  strokes: BoxGlyphStroke[];
  arcs: BoxGlyphArc[];
}

export function isBoxGlyph(code: number): boolean {
  return code >= BOX_GLYPH_CODEPOINT_START && code <= BOX_GLYPH_CODEPOINT_END;
}

export function boxStrokeSize(cellWidth: number): number {
  return Math.max(1, Math.round(cellWidth / 8));
}

// 上游主表四方向线宽集：左/右水平线、上/下垂直线，各含 light/heavy 两组码点。
// prettier-ignore
const H1_LIGHT = new Set([0x2500, 0x2510, 0x2512, 0x2518, 0x251a, 0x2524, 0x2526, 0x2527, 0x2528, 0x252c, 0x252e, 0x2530, 0x2532, 0x2534, 0x2536, 0x2538, 0x253a, 0x253c, 0x253e, 0x2540, 0x2541, 0x2542, 0x2544, 0x2546, 0x254a, 0x2574, 0x257c]);
const H1_HEAVY = new Set([0x2501, 0x2511, 0x2513, 0x2519, 0x251b, 0x2525, 0x2529, 0x252a, 0x252b, 0x252d, 0x252f, 0x2531, 0x2533, 0x2535, 0x2537, 0x2539, 0x253b, 0x253d, 0x253f, 0x2543, 0x2545, 0x2547, 0x2548, 0x2549, 0x254b, 0x2578, 0x257e]);
const H2_LIGHT = new Set([0x2500, 0x250c, 0x250e, 0x2514, 0x2516, 0x251c, 0x251e, 0x251f, 0x2520, 0x252c, 0x252d, 0x2530, 0x2531, 0x2534, 0x2535, 0x2538, 0x2539, 0x253c, 0x253d, 0x2540, 0x2541, 0x2542, 0x2543, 0x2545, 0x2549, 0x2576, 0x257e]);
const H2_HEAVY = new Set([0x2501, 0x250d, 0x250f, 0x2515, 0x2517, 0x251d, 0x2521, 0x2522, 0x2523, 0x252e, 0x252f, 0x2532, 0x2533, 0x2536, 0x2537, 0x253a, 0x253b, 0x253e, 0x253f, 0x2544, 0x2546, 0x2547, 0x2548, 0x254a, 0x254b, 0x257a, 0x257c]);
const V1_LIGHT = new Set([0x2502, 0x2514, 0x2515, 0x2518, 0x2519, 0x251c, 0x251d, 0x251f, 0x2522, 0x2524, 0x2525, 0x2527, 0x252a, 0x2534, 0x2535, 0x2536, 0x2537, 0x253c, 0x253d, 0x253e, 0x253f, 0x2541, 0x2545, 0x2546, 0x2548, 0x2575, 0x257d]);
const V1_HEAVY = new Set([0x2503, 0x2516, 0x2517, 0x251a, 0x251b, 0x251e, 0x2520, 0x2521, 0x2523, 0x2526, 0x2528, 0x2529, 0x252b, 0x2538, 0x2539, 0x253a, 0x253b, 0x2540, 0x2542, 0x2543, 0x2544, 0x2547, 0x2549, 0x254a, 0x254b, 0x2579, 0x257f]);
const V2_LIGHT = new Set([0x2502, 0x250c, 0x250d, 0x2510, 0x2511, 0x251c, 0x251d, 0x251e, 0x2521, 0x2524, 0x2525, 0x2526, 0x2529, 0x252c, 0x252d, 0x252e, 0x252f, 0x253c, 0x253d, 0x253e, 0x253f, 0x2540, 0x2543, 0x2544, 0x2547, 0x2577, 0x257f]);
const V2_HEAVY = new Set([0x2503, 0x250e, 0x250f, 0x2512, 0x2513, 0x251f, 0x2520, 0x2522, 0x2523, 0x2527, 0x2528, 0x252a, 0x252b, 0x2530, 0x2531, 0x2532, 0x2533, 0x2541, 0x2542, 0x2545, 0x2546, 0x2548, 0x2549, 0x254a, 0x254b, 0x257b, 0x257d]);

// 双线表：[code, 上(顶), 下(底), 左, 右]，0=无 1=单线 2=双线
const DOUBLE_TABLE: ReadonlyArray<readonly [number, number, number, number, number]> = [
  [0x2550, 0, 0, 2, 2],
  [0x2551, 2, 2, 0, 0],
  [0x2552, 1, 0, 0, 2],
  [0x2553, 2, 0, 0, 1],
  [0x2554, 2, 0, 0, 2],
  [0x2555, 1, 0, 2, 0],
  [0x2556, 2, 0, 1, 0],
  [0x2557, 2, 0, 2, 0],
  [0x2558, 0, 1, 0, 2],
  [0x2559, 0, 2, 0, 1],
  [0x255a, 0, 2, 0, 2],
  [0x255b, 0, 1, 2, 0],
  [0x255c, 0, 2, 1, 0],
  [0x255d, 0, 2, 2, 0],
  [0x255e, 1, 1, 0, 2],
  [0x255f, 2, 2, 0, 1],
  [0x2560, 2, 2, 0, 2],
  [0x2561, 1, 1, 2, 0],
  [0x2562, 2, 2, 1, 0],
  [0x2563, 2, 2, 2, 0],
  [0x2564, 0, 1, 2, 2],
  [0x2565, 0, 2, 1, 1],
  [0x2566, 0, 2, 2, 2],
  [0x2567, 1, 0, 2, 2],
  [0x2568, 2, 0, 1, 1],
  [0x2569, 2, 0, 2, 2],
  [0x256a, 1, 1, 2, 2],
  [0x256b, 2, 2, 1, 1],
  [0x256c, 2, 2, 2, 2],
];
const DOUBLE_BY_CODE = new Map<number, readonly [number, number, number, number, number]>(
  DOUBLE_TABLE.map((row) => [row[0], row]),
);

// 水平/垂直虚线：缺口数与粗细
const H_DASH: Record<number, { gaps: number; heavy: boolean }> = {
  0x2504: { gaps: 2, heavy: false },
  0x2505: { gaps: 2, heavy: true },
  0x2508: { gaps: 3, heavy: false },
  0x2509: { gaps: 3, heavy: true },
  0x254c: { gaps: 1, heavy: false },
  0x254d: { gaps: 1, heavy: true },
};
const V_DASH: Record<number, { gaps: number; heavy: boolean }> = {
  0x2506: { gaps: 2, heavy: false },
  0x2507: { gaps: 2, heavy: true },
  0x250a: { gaps: 3, heavy: false },
  0x250b: { gaps: 3, heavy: true },
  0x254e: { gaps: 1, heavy: false },
  0x254f: { gaps: 1, heavy: true },
};

// 阴影字符固定灰度
const SHADES: Record<number, number> = { 0x2591: 191, 0x2592: 127, 0x2593: 63 };

// 象限块（2596–259f）：位掩码 UL=1 UR=2 LL=4 LR=8
const QUADRANTS: Record<number, number> = {
  0x2596: 4,
  0x2597: 8,
  0x2598: 1,
  0x2599: 13,
  0x259a: 9,
  0x259b: 3,
  0x259c: 11,
  0x259d: 2,
  0x259e: 6,
  0x259f: 14,
};

/**
 * 计算单个制表符/方块字符的几何绘制形状（像素坐标，相对该单元格左上角）。
 * 空集合表示该字符不由几何层绘制（由字体正常渲染）。
 */
export function boxGlyphGeometry(code: number, cellWidth: number, cellHeight: number): BoxGlyphGeometry {
  const out: BoxGlyphGeometry = { fills: [], strokes: [], arcs: [] };
  if (!isBoxGlyph(code)) return out;
  const w = Math.max(1, cellWidth);
  const h = Math.max(1, cellHeight);
  const s = boxStrokeSize(w);
  const hs = s * 2;
  const midX = w / 2;
  const midY = h / 2;
  const addFill = (x: number, y: number, fw: number, fh: number, gray?: number): void => {
    out.fills.push({ kind: "fill", x, y, w: fw, h: fh, gray });
  };
  const addStroke = (x1: number, y1: number, x2: number, y2: number, width: number): void => {
    out.strokes.push({ kind: "stroke", x1, y1, x2, y2, width });
  };
  const addArc = (cx: number, cy: number, r: number, start: number, end: number, width: number): void => {
    out.arcs.push({ kind: "arc", cx, cy, r, start, end, width });
  };

  // 对角：╱ ╲ ╳
  if (code === 0x2571 || code === 0x2573) addStroke(0, h, w, 0, s);
  if (code === 0x2572 || code === 0x2573) addStroke(0, 0, w, h, s);

  // 弧角：╭ ╮ ╰ ╯
  if (code >= 0x256d && code <= 0x2570) {
    const r = Math.min(w, h) * 0.5;
    if (code === 0x256d) addArc(0, 0, r, 0, Math.PI / 2, s);
    if (code === 0x256e) addArc(w, 0, r, Math.PI / 2, Math.PI, s);
    if (code === 0x256f) addArc(0, h, r, -Math.PI / 2, 0, s);
    if (code === 0x2570) addArc(w, h, r, Math.PI, Math.PI * 1.5, s);
  }

  // 虚线
  const hDash = H_DASH[code];
  if (hDash) {
    const gap = Math.max(1, Math.round(w / 8));
    const dashLen = Math.max(1, Math.round((w - gap * hDash.gaps) / (hDash.gaps + 1)));
    const width = hDash.heavy ? hs : s;
    for (let i = 0; i <= hDash.gaps; i += 1) {
      const x = Math.min(i * (dashLen + gap), w);
      addFill(x, midY - width / 2, dashLen, width);
    }
  }
  const vDash = V_DASH[code];
  if (vDash) {
    const gap = Math.max(1, Math.round(h / 8));
    const dashLen = Math.max(1, Math.round((h - gap * vDash.gaps) / (vDash.gaps + 1)));
    const width = vDash.heavy ? hs : s;
    for (let i = 0; i <= vDash.gaps; i += 1) {
      const y = Math.min(i * (dashLen + gap), h);
      addFill(midX - width / 2, y, width, dashLen);
    }
  }

  // 方块元素（2580–259f）
  if (code === 0x2580) addFill(0, 0, w, h / 2);
  if (code >= 0x2581 && code <= 0x2587) {
    const fraction = (code - 0x2581 + 1) / 8;
    addFill(0, h - h * fraction, w, h * fraction);
  }
  if (code === 0x2588) addFill(0, 0, w, h);
  if (code >= 0x2589 && code <= 0x258f) {
    const fraction = (0x2590 - code) / 8;
    addFill(0, 0, w * fraction, h);
  }
  if (code === 0x2590) addFill(w / 2, 0, w / 2, h);
  if (code === 0x2594) addFill(0, 0, w, h / 8);
  if (code === 0x2595) addFill((w * 7) / 8, 0, w / 8, h);
  const gray = SHADES[code];
  if (gray !== undefined) addFill(0, 0, w, h, gray);
  const quadrant = QUADRANTS[code];
  if (quadrant) {
    const hw = w / 2;
    const hh = h / 2;
    if (quadrant & 1) addFill(0, 0, hw, hh);
    if (quadrant & 2) addFill(hw, 0, hw, hh);
    if (quadrant & 4) addFill(0, hh, hw, hh);
    if (quadrant & 8) addFill(hw, hh, hw, hh);
  }

  // 双线（2550–256c）
  const doubleRow = DOUBLE_BY_CODE.get(code);
  if (doubleRow) {
    const t = doubleRow[1];
    const b = doubleRow[2];
    const l = doubleRow[3];
    const r = doubleRow[4];
    if (l === 1) addFill(0, midY - s / 2, midX, s);
    if (r === 1) addFill(midX, midY - s / 2, w - midX, s);
    if (t === 1) addFill(midX - s / 2, 0, s, midY);
    if (b === 1) addFill(midX - s / 2, midY, s, h - midY);
    if (l === 2) {
      addFill(0, midY - s * 1.5, midX, s);
      addFill(0, midY + s * 0.5, midX, s);
    }
    if (r === 2) {
      addFill(midX, midY - s * 1.5, w - midX, s);
      addFill(midX, midY + s * 0.5, w - midX, s);
    }
    if (t === 2) {
      addFill(midX - s * 1.5, 0, s, midY);
      addFill(midX + s * 0.5, 0, s, midY);
    }
    if (b === 2) {
      addFill(midX - s * 1.5, midY, s, h - midY);
      addFill(midX + s * 0.5, midY, s, h - midY);
    }
    return out;
  }

  // 单线/粗线混合（2500–2503、250c–254b、2574–257f）
  const h1w = H1_HEAVY.has(code) ? hs : H1_LIGHT.has(code) ? s : 0;
  const h2w = H2_HEAVY.has(code) ? hs : H2_LIGHT.has(code) ? s : 0;
  const v1w = V1_HEAVY.has(code) ? hs : V1_LIGHT.has(code) ? s : 0;
  const v2w = V2_HEAVY.has(code) ? hs : V2_LIGHT.has(code) ? s : 0;
  if (h1w) addFill(0, midY - h1w / 2, midX, h1w);
  if (h2w) addFill(midX, midY - h2w / 2, w - midX, h2w);
  if (v1w) addFill(midX - v1w / 2, 0, v1w, midY);
  if (v2w) addFill(midX - v2w / 2, midY, v2w, h - midY);

  return out;
}

// xterm 默认 16 色（与上游终端一致的近似值）
const ANSI_BASE: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0],
  [205, 0, 0],
  [0, 205, 0],
  [205, 205, 0],
  [0, 0, 238],
  [205, 0, 205],
  [0, 205, 205],
  [229, 229, 229],
  [127, 127, 127],
  [255, 0, 0],
  [0, 255, 0],
  [255, 255, 0],
  [92, 92, 255],
  [255, 0, 255],
  [0, 255, 255],
  [255, 255, 255],
];

/** 256 色板索引转 RGB（0–15 基础色、16–231 立方体、232–255 灰阶）。 */
export function ansiRgb(index: number): [number, number, number] {
  let value = Math.floor(index);
  if (!Number.isFinite(value)) value = 0;
  value = Math.max(0, Math.min(255, value));
  if (value < 16) return [ANSI_BASE[value][0], ANSI_BASE[value][1], ANSI_BASE[value][2]];
  if (value >= 232) {
    const gray = 8 + 10 * (value - 232);
    return [gray, gray, gray];
  }
  const n = value - 16;
  const levels = [0, 51, 102, 153, 204, 255];
  return [levels[Math.floor(n / 36)], levels[Math.floor(n / 6) % 6], levels[n % 6]];
}

function cellColor(cell: IBufferCell, terminal: XTerm): string {
  try {
    if (typeof cell.isFgRGB === "function" && cell.isFgRGB()) {
      const value = cell.getFgColor();
      return "rgb(" + ((value >> 16) & 255) + "," + ((value >> 8) & 255) + "," + (value & 255) + ")";
    }
    if (typeof cell.isFgDefault === "function" && !cell.isFgDefault()) {
      const rgb = ansiRgb(cell.getFgColor());
      return "rgb(" + rgb[0] + "," + rgb[1] + "," + rgb[2] + ")";
    }
  } catch {
    // 忽略个别 xterm 版本的 API 差异，回退主题前景色
  }
  return terminal.options.theme?.foreground ?? "#cccccc";
}

function isInverseCell(cell: IBufferCell): boolean {
  const probe = cell as unknown as { isInverse?: () => boolean };
  return typeof probe.isInverse === "function" ? probe.isInverse() : false;
}

const GLYPH_LAYER_CLASS = "codex-terminal-glyph-layer";

/**
 * 几何字形覆盖层：监听终端写入/滚动/缩放，把可见区域内的制表符
 * 与方块字符绘制到透明 canvas 上（z-index 5，位于数学公式层之下）。
 */
export class BoxGlyphOverlay {
  private layer: HTMLCanvasElement | null = null;
  private timer = 0;
  private disposed = false;
  private readonly disposables: IDisposable[] = [];

  constructor(
    private readonly terminal: XTerm,
    private readonly container: HTMLElement,
  ) {
    this.disposables.push(
      terminal.onWriteParsed(() => this.schedule()),
      terminal.onScroll(() => this.schedule()),
      terminal.onResize(() => this.schedule()),
    );
  }

  /** 立即重绘（主题、背景、设置变化后调用）。 */
  refresh(): void {
    this.schedule(0);
  }

  private schedule(delay = 60): void {
    if (this.disposed) return;
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.update(), delay);
  }

  private ensureLayer(): HTMLCanvasElement {
    if (this.layer && this.layer.isConnected) return this.layer;
    const canvas = document.createElement("canvas");
    canvas.className = GLYPH_LAYER_CLASS;
    canvas.style.cssText =
      "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:5;";
    this.container.appendChild(canvas);
    this.layer = canvas;
    return canvas;
  }

  private update(): void {
    if (this.disposed || !this.container.isConnected) return;
    const terminal = this.terminal;
    const rows = terminal.rows;
    const cols = terminal.cols;
    if (rows <= 0 || cols <= 0) return;
    const rowsEl = this.container.querySelector<HTMLElement>(".xterm-rows");
    if (!rowsEl) return;
    const rect = rowsEl.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) return;
    const cellWidth = rect.width / cols;
    const cellHeight = rect.height / rows;
    const canvas = this.ensureLayer();
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const targetWidth = Math.max(1, Math.round(rect.width * dpr));
    const targetHeight = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== targetWidth) canvas.width = targetWidth;
    if (canvas.height !== targetHeight) canvas.height = targetHeight;
    canvas.style.width = Math.round(rect.width) + "px";
    canvas.style.height = Math.round(rect.height) + "px";
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    const buffer = terminal.buffer.active;
    const viewportStart = buffer.viewportY;
    const fallback = terminal.options.theme?.foreground ?? "#cccccc";
    for (let y = 0; y < rows; y += 1) {
      const line = buffer.getLine(viewportStart + y);
      if (!line) continue;
      for (let x = 0; x < cols; x += 1) {
        const cell = line.getCell(x);
        if (!cell) continue;
        const chars = cell.getChars();
        if (!chars) continue;
        const code = chars.codePointAt(0);
        if (code === undefined || !isBoxGlyph(code)) continue;
        if (isInverseCell(cell)) continue;
        const geometry = boxGlyphGeometry(code, cellWidth, cellHeight);
        const shapeCount = geometry.fills.length + geometry.strokes.length + geometry.arcs.length;
        if (!shapeCount) continue;
        const color = cellColor(cell, terminal) || fallback;
        const dim = cell.isDim() ? 0.55 : 1;
        const originX = x * cellWidth;
        const originY = y * cellHeight;
        ctx.save();
        ctx.globalAlpha = dim;
        for (const fill of geometry.fills) {
          if (fill.gray !== undefined) {
            ctx.fillStyle = "rgb(" + fill.gray + "," + fill.gray + "," + fill.gray + ")";
          } else {
            ctx.fillStyle = color;
          }
          ctx.fillRect(originX + fill.x, originY + fill.y, fill.w, fill.h);
        }
        ctx.strokeStyle = color;
        for (const stroke of geometry.strokes) {
          ctx.lineWidth = stroke.width;
          ctx.beginPath();
          ctx.moveTo(originX + stroke.x1, originY + stroke.y1);
          ctx.lineTo(originX + stroke.x2, originY + stroke.y2);
          ctx.stroke();
        }
        for (const arc of geometry.arcs) {
          ctx.lineWidth = arc.width;
          ctx.beginPath();
          ctx.arc(originX + arc.cx, originY + arc.cy, arc.r, arc.start, arc.end);
          ctx.stroke();
        }
        ctx.restore();
      }
    }
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
