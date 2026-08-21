import type { KeybindingAction } from "./types";

export const KEYBINDING_ACTIONS: KeybindingAction[] = [
  "command-palette",
  "new-terminal",
  "split-right",
  "split-down",
  "pane-next",
  "pane-prev",
  "quick-terminal",
  "open-settings",
];

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "CapsLock", "NumLock"]);

/** Convert a keydown event into the stored chord format, e.g. "Ctrl+Shift+K". */
export function chordFromEvent(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push(event.metaKey && !event.ctrlKey ? "Cmd" : "Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  const key = event.key;
  if (key === " ") parts.push("Space");
  else if (key.length === 1) parts.push(key.toUpperCase());
  else parts.push(key);
  return parts.join("+");
}

/** Match a keydown event against a stored chord (case-insensitive, Electron-style). */
export function keybindingMatches(event: KeyboardEvent, chord: string | undefined): boolean {
  if (!chord) return false;
  const tokens = chord.split("+").map((token) => token.trim().toLowerCase()).filter(Boolean);
  if (tokens.length < 1) return false;
  const last = tokens[tokens.length - 1] ?? "";
  const eventKey = event.key.toLowerCase();
  if (last === "space") {
    if (event.key !== " " && eventKey !== "spacebar") return false;
  } else if (last === "esc" || last === "escape") {
    if (eventKey !== "escape") return false;
  } else if (last.length === 1) {
    if (eventKey !== last) return false;
  } else {
    if (eventKey !== last) return false;
  }

  const modifiers = new Set(tokens.slice(0, -1));
  const wantsCtrl = modifiers.has("ctrl") || modifiers.has("control") || modifiers.has("commandorcontrol");
  const wantsCmd = modifiers.has("cmd") || modifiers.has("meta") || modifiers.has("commandorcontrol");
  const wantsAlt = modifiers.has("alt");
  const wantsShift = modifiers.has("shift");

  const ctrlHeld = event.ctrlKey || event.metaKey;
  if (wantsCtrl && !ctrlHeld) return false;
  if (wantsCmd && !event.metaKey && !event.ctrlKey) return false;
  if (wantsAlt !== event.altKey) return false;
  if (wantsShift !== event.shiftKey) return false;
  if (!wantsCtrl && !wantsCmd && (event.ctrlKey || event.metaKey)) return false;
  return true;
}

/** Whether a keydown is only a modifier key, which cannot be a chord on its own. */
export function isModifierOnly(event: KeyboardEvent): boolean {
  return MODIFIER_KEYS.has(event.key);
}
