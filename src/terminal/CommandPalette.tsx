import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, Search } from "lucide-react";
import { useUiCopy } from "../i18n";

const recentActionsKey = "codex-cli-ui:command-palette-recent-v1";

function loadRecentActions() {
  try {
    const value = JSON.parse(localStorage.getItem(recentActionsKey) || "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string").slice(0, 8) : [];
  } catch {
    return [];
  }
}

export interface PaletteAction {
  id: string;
  group: string;
  label: string;
  detail?: string;
  icon: ReactNode;
  checked?: boolean;
  run(): void;
}

export default function CommandPalette({ actions, onClose }: { actions: PaletteAction[]; onClose(): void }) {
  const copy = useUiCopy().palette;
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [recentIds, setRecentIds] = useState(loadRecentActions);
  const filtered = useMemo(() => actions.filter((action) => `${action.group} ${action.label} ${action.detail || ""}`.toLowerCase().includes(query.trim().toLowerCase())), [actions, query]);
  useEffect(() => setSelected(0), [query]);
  const groups = useMemo(() => {
    const result = new Map<string, PaletteAction[]>();
    const recent = query.trim() ? [] : recentIds.map((id) => actions.find((action) => action.id === id)).filter((action): action is PaletteAction => !!action);
    if (recent.length) result.set(copy.recent, recent);
    const recentSet = new Set(recent.map((action) => action.id));
    for (const action of filtered) {
      if (recentSet.has(action.id)) continue;
      result.set(action.group, [...(result.get(action.group) || []), action]);
    }
    return result;
  }, [actions, copy.recent, filtered, query, recentIds]);
  const visible = useMemo(() => [...groups.values()].flat(), [groups]);
  const run = (action?: PaletteAction) => {
    if (!action) return;
    const next = [action.id, ...recentIds.filter((id) => id !== action.id)].slice(0, 8);
    setRecentIds(next);
    try { localStorage.setItem(recentActionsKey, JSON.stringify(next)); } catch { /* Storage can be unavailable in hardened renderers. */ }
    action.run();
    onClose();
  };
  return (
    <div className="palette-overlay" role="dialog" aria-modal="true" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="command-palette">
        <label><Search size={15} /><input autoFocus value={query} placeholder={copy.placeholder} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
          else if (event.key === "ArrowDown") { event.preventDefault(); setSelected((value) => Math.min(visible.length - 1, value + 1)); }
          else if (event.key === "ArrowUp") { event.preventDefault(); setSelected((value) => Math.max(0, value - 1)); }
          else if (event.key === "Enter") { event.preventDefault(); run(visible[selected]); }
        }} /></label>
        <div className="palette-list">
          {[...groups.entries()].map(([group, items]) => <section key={group}><h3>{group}</h3>{items.map((action) => {
            const index = visible.indexOf(action);
            return <button className={index === selected ? "selected" : ""} key={action.id} onMouseEnter={() => setSelected(index)} onClick={() => run(action)}><span>{action.icon}</span><strong>{action.label}</strong>{action.detail && <small>{action.detail}</small>}{action.checked && <Check size={14} />}</button>;
          })}</section>)}
          {visible.length === 0 && <div className="palette-empty">{copy.empty}</div>}
        </div>
      </div>
    </div>
  );
}
