/**
 * Nebula 对照实现：拖拽选择时视口自动滚动。
 * - 按住鼠标左键拖动选择并把指针拖出终端网格的上/下边缘时，
 *   视口持续向该方向滚动（对标上游 1.3.0 changelog 的 legacy shell 行为）。
 * - 节奏：15ms 一拍；斜率：边缘处 1 行，之后每 20px +1 行，上限 16 行/拍防失控。
 * - 计时器在鼠标按下时武装，避免快速甩出边缘后不触发；松开或窗口失焦即停止。
 */
export const DRAG_SCROLL_PX_PER_LINE = 20;
export const DRAG_SCROLL_TICK_MS = 15;
export const DRAG_SCROLL_MAX_LINES = 16;
export function dragScrollStep(distancePx: number): number {
  if (!Number.isFinite(distancePx) || distancePx === 0) return 0;
  const lines = Math.min(DRAG_SCROLL_MAX_LINES, Math.floor(Math.abs(distancePx) / DRAG_SCROLL_PX_PER_LINE) + 1);
  return distancePx < 0 ? -lines : lines;
}
