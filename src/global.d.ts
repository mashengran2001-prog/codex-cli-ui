import type { CodexBridge } from "./types";

declare global {
  interface Window {
    codex: CodexBridge;
    workbench: CodexBridge;
  }
}

export {};
