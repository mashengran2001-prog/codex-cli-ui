import type { ImportedFontInfo } from "./types";

let styleElement: HTMLStyleElement | null = null;

function escapeFamily(name: string): string {
  return name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** 把导入字体注册成 @font-face，让终端 canvas 与预览都能直接使用。 */
export function registerImportedFontFaces(fonts: ImportedFontInfo[]): void {
  if (!styleElement) {
    styleElement = document.createElement("style");
    styleElement.dataset.importedFonts = "true";
    document.head.appendChild(styleElement);
  }
  styleElement.textContent = fonts.map((font) =>
    `@font-face{font-family:"${escapeFamily(font.family)}";src:url("font://${encodeURIComponent(font.fileName)}");font-display:swap}`
  ).join("\n");
  for (const font of fonts) {
    // 预热字体，xterm canvas 立即可用，避免首帧回退。
    void document.fonts.load(`16px "${escapeFamily(font.family)}"`).catch(() => {});
  }
}

/** 从主进程拉取已导入字体并注册 @font-face，返回列表供设置页使用。 */
export async function loadImportedFonts(): Promise<ImportedFontInfo[]> {
  const fonts = await window.codex.listImportedFonts().catch<ImportedFontInfo[]>(() => []);
  registerImportedFontFaces(fonts);
  return fonts;
}
