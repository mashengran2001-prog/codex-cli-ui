import type { PersistedState } from "./types";

const STORAGE_KEY = "codex-cli-ui/state/v1";

export const defaultState: PersistedState = {
  version: 1,
  projects: [],
  aliases: {},
  sidebarWidth: 292,
  model: "",
  reasoningEffort: "medium",
  sandboxMode: "workspace-write",
  activeProviderId: "codex",
};

export function loadState(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState;
    const value = JSON.parse(raw) as Partial<PersistedState>;
    if (value.version !== 1 || !Array.isArray(value.projects)) return defaultState;
    return {
      ...defaultState,
      ...value,
      projects: value.projects.filter((project) => (
        project && typeof project.id === "string" && typeof project.name === "string" && typeof project.path === "string"
      )),
      aliases: value.aliases && typeof value.aliases === "object" ? value.aliases : {},
    };
  } catch {
    return defaultState;
  }
}

export function saveState(state: PersistedState) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}
