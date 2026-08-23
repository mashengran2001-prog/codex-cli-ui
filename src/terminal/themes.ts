import type { ITheme } from "@xterm/xterm";
import type { TerminalThemeName } from "../types";

export const terminalThemes: Record<TerminalThemeName, { label: string; dark: boolean; terminal: ITheme }> = {
  nebula: {
    label: "Nebula",
    dark: true,
    terminal: { background: "#0f111a", foreground: "#e2e8f0", cursor: "#52a8ff", cursorAccent: "#0f111a", selectionBackground: "#1b2c43", black: "#1c2129", red: "#c44a58", green: "#7db2a3", yellow: "#f5a623", blue: "#52a8ff", magenta: "#b99bd0", cyan: "#77bdc3", white: "#e2e8f0", brightBlack: "#64748b", brightWhite: "#f8fafc" },
  },
  silver: {
    label: "Silver Light",
    dark: false,
    terminal: { background: "#ffffff", foreground: "#24292f", cursor: "#495057", selectionBackground: "#e5e6e7", black: "#24292f", red: "#cf222e", green: "#1a7f37", yellow: "#9a6700", blue: "#0969da", magenta: "#8250df", cyan: "#1b7c83", white: "#6e7781", brightBlack: "#57606a", brightRed: "#a40e26", brightGreen: "#2da44e", brightYellow: "#bf8700", brightBlue: "#218bff", brightMagenta: "#a475f9", brightCyan: "#3192aa", brightWhite: "#8c959f" },
  },
  steel: {
    label: "Steel Dark",
    dark: true,
    terminal: { background: "#1a1c24", foreground: "#e2e8f0", cursor: "#94a3b8", selectionBackground: "#30343e", black: "#15191d", red: "#c44a58", green: "#82bd9b", yellow: "#dbc079", blue: "#94a3b8", magenta: "#b897cf", cyan: "#73bec1", white: "#e2e8f0", brightBlack: "#64748b", brightWhite: "#f8fafc" },
  },
  limestone: {
    label: "Limestone",
    dark: false,
    terminal: { background: "#ffffff", foreground: "#24292f", cursor: "#495057", selectionBackground: "#e5e6e7", black: "#24292f", red: "#cf222e", green: "#1a7f37", yellow: "#9a6700", blue: "#0969da", magenta: "#8250df", cyan: "#1b7c83", white: "#6e7781", brightBlack: "#57606a", brightRed: "#a40e26", brightGreen: "#2da44e", brightYellow: "#bf8700", brightBlue: "#218bff", brightMagenta: "#a475f9", brightCyan: "#3192aa", brightWhite: "#8c959f" },
  },
  coal: {
    label: "Coal Dark",
    dark: true,
    terminal: { background: "#171717", foreground: "#e2e8f0", cursor: "#d4d4d4", selectionBackground: "#393939", black: "#121210", red: "#c44a58", green: "#9caf7b", yellow: "#d3b56e", blue: "#d4d4d4", magenta: "#b39ab8", cyan: "#79b0aa", white: "#e2e8f0", brightBlack: "#64748b", brightWhite: "#f8fafc" },
  },
  linen: {
    label: "Linen Light",
    dark: false,
    terminal: { background: "#ffffff", foreground: "#24292f", cursor: "#495057", selectionBackground: "#e5e6e7", black: "#24292f", red: "#cf222e", green: "#1a7f37", yellow: "#9a6700", blue: "#0969da", magenta: "#8250df", cyan: "#1b7c83", white: "#6e7781", brightBlack: "#57606a", brightRed: "#a40e26", brightGreen: "#2da44e", brightYellow: "#bf8700", brightBlue: "#218bff", brightMagenta: "#a475f9", brightCyan: "#3192aa", brightWhite: "#8c959f" },
  },
  moss: {
    label: "Moss Dark",
    dark: true,
    terminal: { background: "#1e211e", foreground: "#e2e8f0", cursor: "#a3b3a3", selectionBackground: "#363b36", black: "#121612", red: "#c44a58", green: "#8fb28a", yellow: "#d0b36c", blue: "#a3b3a3", magenta: "#ad96bd", cyan: "#77b4a4", white: "#e2e8f0", brightBlack: "#64748b", brightWhite: "#f8fafc" },
  },
};
