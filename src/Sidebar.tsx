import { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Download,
  Folder,
  FolderPlus,
  LoaderCircle,
  MessageSquare,
  Pencil,
  Plus,
  RefreshCw,
  Settings,
  TerminalSquare,
  Trash2,
  X,
} from "lucide-react";
import { resolveAppLocale, useUiCopy } from "./i18n";
import type {
  AppSettings,
  AgentProviderId,
  AgentProviderInfo,
  ConversationRecord,
  LauncherStatus,
  ProjectRecord,
} from "./types";

interface SidebarProps {
  projects: ProjectRecord[];
  conversations: ConversationRecord[];
  selectedProjectId?: string;
  selectedConversationId?: string;
  providers: AgentProviderInfo[];
  activeProviderId: AgentProviderId;
  launcherStatus: LauncherStatus | null;
  launcherBusy: boolean;
  appSettings: AppSettings;
  onAddProject(): void;
  onSelectProject(projectId: string): void;
  onRemoveProject(projectId: string): void;
  onRenameProject(projectId: string, name: string): void;
  onRefreshProject(projectId: string): void;
  onNewConversation(projectId: string): void;
  onSelectConversation(conversationId: string): void;
  onRenameConversation(conversationId: string, name: string): void;
  onLauncherToggle(): void;
  onAppSettingsChange(settings: AppSettings): void;
  onProviderChange(providerId: AgentProviderId): void;
  onProviderRefresh(providerId: AgentProviderId): void;
  onProviderInstall(providerId: AgentProviderId): void;
  onProviderCredential(providerId: AgentProviderId, credential: string): void;
}

function timeLabel(timestamp: number, locale: "zh-CN" | "en-US") {
  const date = new Date(timestamp);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  return date.toLocaleDateString(locale, { month: "numeric", day: "numeric" });
}

function RenameInput({ value, onCommit, onCancel }: { value: string; onCommit(value: string): void; onCancel(): void }) {
  const [draft, setDraft] = useState(value);
  const commit = () => {
    const next = draft.trim();
    if (next) onCommit(next);
    else onCancel();
  };
  return (
    <input
      autoFocus
      className="rename-input"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
        if (event.key === "Escape") onCancel();
      }}
      onClick={(event) => event.stopPropagation()}
    />
  );
}

export default function Sidebar(props: SidebarProps) {
  const copy = useUiCopy().sidebar;
  const locale = resolveAppLocale(props.appSettings.language);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [renaming, setRenaming] = useState<{ type: "project" | "conversation"; id: string } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [credential, setCredential] = useState("");
  const activeProvider = props.providers.find((provider) => provider.id === props.activeProviderId) ?? null;
  const grouped = useMemo(() => {
    const map = new Map<string, ConversationRecord[]>();
    for (const project of props.projects) map.set(project.id, []);
    for (const conversation of props.conversations) map.get(conversation.projectId)?.push(conversation);
    for (const values of map.values()) values.sort((a, b) => b.updatedAt - a.updatedAt);
    return map;
  }, [props.conversations, props.projects]);

  return (
    <aside className="sidebar sidebar-embedded">
      <div className="sidebar-section-label"><span>{copy.workspace}</span><button title={copy.addProject} onClick={props.onAddProject}><Plus size={13} /></button></div>
      <nav className="project-list" aria-label={copy.workspaceAndSessions}>
        {props.projects.length === 0 && (
          <button className="empty-project-row" onClick={props.onAddProject}><FolderPlus size={15} />{copy.addProject}</button>
        )}
        {props.projects.map((project) => {
          const isExpanded = expanded[project.id] !== false;
          const projectConversations = grouped.get(project.id) ?? [];
          const isSelected = props.selectedProjectId === project.id;
          const isRunning = projectConversations.some((conversation) => conversation.runState === "running");
          return (
            <section className="project-group" key={project.id}>
              <div className={`project-row ${isSelected ? "selected" : ""}`}>
                <button
                  className="project-main"
                  onClick={() => {
                    props.onSelectProject(project.id);
                    setExpanded((value) => ({ ...value, [project.id]: !isExpanded }));
                  }}
                >
                  {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  <Folder size={14} />
                  {renaming?.type === "project" && renaming.id === project.id ? (
                    <RenameInput value={project.name} onCommit={(name) => { props.onRenameProject(project.id, name); setRenaming(null); }} onCancel={() => setRenaming(null)} />
                  ) : (
                    <span className="project-label"><strong>{project.name}</strong><small>{project.path}</small></span>
                  )}
                  {isRunning && <LoaderCircle className="spin project-run-indicator" size={13} />}
                </button>
                <div className="row-actions">
                  <button title={copy.newSession} onClick={() => props.onNewConversation(project.id)}><Plus size={13} /></button>
                  <button title={copy.refreshSessions} onClick={() => props.onRefreshProject(project.id)}><RefreshCw size={12} /></button>
                  <button title={copy.renameProject} onClick={() => setRenaming({ type: "project", id: project.id })}><Pencil size={12} /></button>
                  <button title={copy.removeProject} className="danger-action" onClick={() => props.onRemoveProject(project.id)}><Trash2 size={12} /></button>
                </div>
              </div>

              {isExpanded && (
                <div className="conversation-list">
                  {projectConversations.length === 0 && (
                    <button className="new-conversation-row" onClick={() => props.onNewConversation(project.id)}><Plus size={12} />{copy.newSession}</button>
                  )}
                  {projectConversations.map((conversation) => {
                    const active = props.selectedConversationId === conversation.id;
                    const running = conversation.runState === "running";
                    return (
                      <div className={`conversation-row ${active ? "active" : ""}`} key={conversation.id}>
                        <button className="conversation-main" onClick={() => props.onSelectConversation(conversation.id)}>
                          {running ? <LoaderCircle className="spin" size={13} /> : <MessageSquare size={13} />}
                          {renaming?.type === "conversation" && renaming.id === conversation.id ? (
                            <RenameInput value={conversation.title} onCommit={(name) => { props.onRenameConversation(conversation.id, name); setRenaming(null); }} onCancel={() => setRenaming(null)} />
                          ) : (
                            <span><strong>{conversation.title}</strong><small>{conversation.model || (conversation.isDraft ? copy.draft : activeProvider?.shortName || "Provider")} · {timeLabel(conversation.updatedAt, locale)}</small></span>
                          )}
                        </button>
                        <button className="conversation-rename" title={copy.renameSession} onClick={() => setRenaming({ type: "conversation", id: conversation.id })}><Pencil size={11} /></button>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          );
        })}
      </nav>

      <div className="sidebar-bottom">
        {settingsOpen && (
          <div className="settings-popover">
            <div className="popover-heading"><span>{copy.settings}</span><button title={copy.closeSettings} onClick={() => setSettingsOpen(false)}><X size={14} /></button></div>
            <div className="setting-block">
              <span className="setting-label">{copy.closeWindow}</span>
              <div className="segmented-control">
                <button className={props.appSettings.closeBehavior === "tray" ? "active" : ""} onClick={() => props.onAppSettingsChange({ ...props.appSettings, closeBehavior: "tray" })}>{copy.runInBackground}</button>
                <button className={props.appSettings.closeBehavior === "quit" ? "active" : ""} onClick={() => props.onAppSettingsChange({ ...props.appSettings, closeBehavior: "quit" })}>{copy.quit}</button>
              </div>
            </div>
            <label className="toggle-row">
              <span>{copy.completionNotifications}</span>
              <input type="checkbox" checked={props.appSettings.notifyOnCompletion} onChange={(event) => props.onAppSettingsChange({ ...props.appSettings, notifyOnCompletion: event.target.checked })} />
              <span className="toggle-track"><span /></span>
            </label>
            <div className="setting-divider" />
            {activeProvider && <div className="provider-setting">
              <div className="provider-setting-head"><div><strong>{activeProvider.name}</strong><small>{activeProvider.error || activeProvider.description}</small></div><button title={copy.refreshProvider} onClick={() => props.onProviderRefresh(activeProvider.id)}><RefreshCw size={12} /></button></div>
              {activeProvider.id === "deepseek" && <div className="provider-credential"><input type="password" value={credential} placeholder="DeepSeek API Key" onChange={(event) => setCredential(event.target.value)} /><button disabled={!credential.trim()} onClick={() => { props.onProviderCredential(activeProvider.id, credential); setCredential(""); }}>{copy.save}</button></div>}
              {!activeProvider.cliAvailable && activeProvider.installCommand && <button className="provider-install" onClick={() => props.onProviderInstall(activeProvider.id)}><Download size={12} />{copy.installCli}</button>}
            </div>}
            <div className="setting-divider" />
            <div className="launcher-setting">
              <div><strong>{copy.commandRouting}</strong><small>{props.launcherStatus?.installed ? copy.launcherInstalled : copy.launcherNotInstalled}</small></div>
              <button disabled={props.launcherBusy} onClick={props.onLauncherToggle}>{props.launcherBusy ? copy.processing : props.launcherStatus?.installed ? copy.disable : copy.enable}</button>
            </div>
            {props.launcherStatus?.error && <p className="setting-error">{props.launcherStatus.error}</p>}
          </div>
        )}
        <label className="provider-switcher" title={copy.switchProvider}><span className={`connection-dot ${activeProvider?.available && activeProvider.configured ? "online" : "offline"}`} /><select value={props.activeProviderId} onChange={(event) => props.onProviderChange(event.target.value as AgentProviderId)}>{props.providers.map((provider) => <option value={provider.id} key={provider.id}>{provider.shortName}</option>)}</select></label>
        <button className={`settings-trigger ${settingsOpen ? "active" : ""}`} onClick={() => setSettingsOpen((value) => !value)}><Settings size={14} /><span>{copy.settings}</span></button>
        <div className="sidebar-status">
          <span className={`connection-dot ${activeProvider?.available && activeProvider.configured ? "online" : "offline"}`} />
          <span>{activeProvider?.available ? activeProvider.version || (activeProvider.configured ? copy.connected : copy.configurationRequired) : copy.unavailable}</span>
          <TerminalSquare size={12} />
        </div>
      </div>
    </aside>
  );
}
