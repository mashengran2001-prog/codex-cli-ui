import type { ITheme } from "@xterm/xterm";
import type { TerminalThemeName } from "../types";

export const terminalThemes: Record<TerminalThemeName, { label: string; dark: boolean; terminal: ITheme }> = {
  nebula: {
    label: "Nebula",
    dark: true,
    terminal: { background: "#12151b", foreground: "#d8dee9", cursor: "#78aee8", cursorAccent: "#12151b", selectionBackground: "#334d69", black: "#171a21", red: "#e07a78", green: "#8fbc8f", yellow: "#d9bd79", blue: "#78aee8", magenta: "#b99bd0", cyan: "#77bdc3", white: "#d8dee9", brightBlack: "#667080", brightWhite: "#ffffff" },
  },
  silver: {
    label: "Silver Light",
    dark: false,
    terminal: { background: "#f5f6f7", foreground: "#262a2e", cursor: "#356f62", selectionBackground: "#b9d4ce", black: "#30343a", red: "#a53f3f", green: "#367157", yellow: "#8b681d", blue: "#356d91", magenta: "#79558c", cyan: "#28787b", white: "#d8dce0", brightBlack: "#6f7780", brightWhite: "#ffffff" },
  },
  steel: {
    label: "Steel Dark",
    dark: true,
    terminal: { background: "#20252a", foreground: "#e2e7eb", cursor: "#77b8aa", selectionBackground: "#4c6570", black: "#15191d", red: "#e37c78", green: "#82bd9b", yellow: "#dbc079", blue: "#81afd0", magenta: "#b897cf", cyan: "#73bec1", white: "#dce2e6", brightBlack: "#7f8992", brightWhite: "#ffffff" },
  },
  limestone: {
    label: "Limestone",
    dark: false,
    terminal: { background: "#f4f3ef", foreground: "#302f2b", cursor: "#6b7151", selectionBackground: "#cfd2be", black: "#36352f", red: "#a64a44", green: "#5d7145", yellow: "#8e6d29", blue: "#4e708c", magenta: "#765b81", cyan: "#3d7772", white: "#deddd7", brightBlack: "#7d7b72", brightWhite: "#ffffff" },
  },
  coal: {
    label: "Coal Dark",
    dark: true,
    terminal: { background: "#1d1d1b", foreground: "#e7e4dc", cursor: "#b2b88d", selectionBackground: "#58594e", black: "#121210", red: "#da8179", green: "#9caf7b", yellow: "#d3b56e", blue: "#88a9bd", magenta: "#b39ab8", cyan: "#79b0aa", white: "#dedbd3", brightBlack: "#78766f", brightWhite: "#ffffff" },
  },
  linen: {
    label: "Linen Light",
    dark: false,
    terminal: { background: "#f7f4ed", foreground: "#34312c", cursor: "#48735d", selectionBackground: "#c5d8c9", black: "#39352f", red: "#a95248", green: "#4f7457", yellow: "#8c6c2b", blue: "#526f8a", magenta: "#785d7d", cyan: "#41766e", white: "#e1ddd4", brightBlack: "#817b70", brightWhite: "#ffffff" },
  },
  moss: {
    label: "Moss Dark",
    dark: true,
    terminal: { background: "#1c211d", foreground: "#e3e7de", cursor: "#91b58d", selectionBackground: "#4f6652", black: "#121612", red: "#d78075", green: "#8fb28a", yellow: "#d0b36c", blue: "#82a8b6", magenta: "#ad96bd", cyan: "#77b4a4", white: "#d9ddd4", brightBlack: "#747c72", brightWhite: "#ffffff" },
  },
};
