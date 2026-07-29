import { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  LoaderCircle,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  RefreshCw,
  Settings,
  TerminalSquare,
  Trash2,
  X,
} from "lucide-react";
import type {
  AppSettings,
  CodexInfo,
  ConversationRecord,
  LauncherStatus,
  ProjectRecord,
} from "./types";

interface SidebarProps {
  projects: ProjectRecord[];
  conversations: ConversationRecord[];
  selectedProjectId?: string;
  selectedConversationId?: string;
  codexInfo: CodexInfo | null;
  launcherStatus: LauncherStatus | null;
  launcherBusy: boolean;
  appSettings: AppSettings;
  collapsed: boolean;
  width: number;
  onCollapsedChange(collapsed: boolean): void;
  onResizeStart(event: React.PointerEvent<HTMLDivElement>): void;
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
}

function timeLabel(timestamp: number) {
  const date = new Date(timestamp);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  return date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
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
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [renaming, setRenaming] = useState<{ type: "project" | "conversation"; id: string } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const grouped = useMemo(() => {
    const map = new Map<string, ConversationRecord[]>();
    for (const project of props.projects) map.set(project.id, []);
    for (const conversation of props.conversations) map.get(conversation.projectId)?.push(conversation);
    for (const values of map.values()) values.sort((a, b) => b.updatedAt - a.updatedAt);
    return map;
  }, [props.conversations, props.projects]);

  if (props.collapsed) {
    return (
      <aside className="sidebar sidebar-collapsed">
        <div className="collapsed-brand" aria-label="Codex CLI UI">
          <span /><span /><span /><span />
        </div>
        <button className="icon-button" title="展开侧栏" onClick={() => props.onCollapsedChange(false)}><PanelLeftOpen size={16} /></button>
        <button className="icon-button" title="添加项目" onClick={props.onAddProject}><FolderPlus size={16} /></button>
        <div className="collapsed-spacer" />
        <span className={`connection-dot ${props.codexInfo?.available ? "online" : "offline"}`} title={props.codexInfo?.available ? "Codex 已连接" : "Codex 不可用"} />
      </aside>
    );
  }

  return (
    <aside className="sidebar" style={{ width: props.width }}>
      <header className="sidebar-header">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true"><span /><span /><span /><span /></div>
          <div>
            <strong>Codex</strong>
            <small>CLI UI</small>
          </div>
        </div>
        <div className="sidebar-header-actions">
          <button className="icon-button" title="添加项目" onClick={props.onAddProject}><FolderPlus size={15} /></button>
          <button className="icon-button" title="收起侧栏" onClick={() => props.onCollapsedChange(true)}><PanelLeftClose size={15} /></button>
        </div>
      </header>

      <div className="sidebar-section-label"><span>工作区</span><button title="添加项目" onClick={props.onAddProject}><Plus size={13} /></button></div>
      <nav className="project-list" aria-label="工作区与会话">
        {props.projects.length === 0 && (
          <button className="empty-project-row" onClick={props.onAddProject}><FolderPlus size={15} />添加工作目录</button>
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
                  <button title="新会话" onClick={() => props.onNewConversation(project.id)}><Plus size={13} /></button>
                  <button title="刷新会话" onClick={() => props.onRefreshProject(project.id)}><RefreshCw size={12} /></button>
                  <button title="重命名项目" onClick={() => setRenaming({ type: "project", id: project.id })}><Pencil size={12} /></button>
                  <button title="移除项目" className="danger-action" onClick={() => props.onRemoveProject(project.id)}><Trash2 size={12} /></button>
                </div>
              </div>

              {isExpanded && (
                <div className="conversation-list">
                  {projectConversations.length === 0 && (
                    <button className="new-conversation-row" onClick={() => props.onNewConversation(project.id)}><Plus size={12} />新建会话</button>
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
                            <span><strong>{conversation.title}</strong><small>{conversation.model || (conversation.isDraft ? "草稿" : "Codex")} · {timeLabel(conversation.updatedAt)}</small></span>
                          )}
                        </button>
                        <button className="conversation-rename" title="重命名会话" onClick={() => setRenaming({ type: "conversation", id: conversation.id })}><Pencil size={11} /></button>
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
            <div className="popover-heading"><span>设置</span><button title="关闭" onClick={() => setSettingsOpen(false)}><X size={14} /></button></div>
            <div className="setting-block">
              <span className="setting-label">关闭窗口时</span>
              <div className="segmented-control">
                <button className={props.appSettings.closeBehavior === "tray" ? "active" : ""} onClick={() => props.onAppSettingsChange({ ...props.appSettings, closeBehavior: "tray" })}>后台运行</button>
                <button className={props.appSettings.closeBehavior === "quit" ? "active" : ""} onClick={() => props.onAppSettingsChange({ ...props.appSettings, closeBehavior: "quit" })}>退出</button>
              </div>
            </div>
            <label className="toggle-row">
              <span>任务完成通知</span>
              <input type="checkbox" checked={props.appSettings.notifyOnCompletion} onChange={(event) => props.onAppSettingsChange({ ...props.appSettings, notifyOnCompletion: event.target.checked })} />
              <span className="toggle-track"><span /></span>
            </label>
            <div className="setting-divider" />
            <div className="launcher-setting">
              <div><strong>命令接管</strong><small>{props.launcherStatus?.installed ? "codex 打开此界面 · codex-raw 直通" : "当前 codex 仍打开终端"}</small></div>
              <button disabled={props.launcherBusy} onClick={props.onLauncherToggle}>{props.launcherBusy ? "处理中" : props.launcherStatus?.installed ? "停用" : "启用"}</button>
            </div>
            {props.launcherStatus?.error && <p className="setting-error">{props.launcherStatus.error}</p>}
          </div>
        )}
        <button className={`settings-trigger ${settingsOpen ? "active" : ""}`} onClick={() => setSettingsOpen((value) => !value)}><Settings size={14} /><span>设置</span></button>
        <div className="sidebar-status">
          <span className={`connection-dot ${props.codexInfo?.available ? "online" : "offline"}`} />
          <span>{props.codexInfo?.available ? props.codexInfo.version || "Codex 已连接" : "Codex 不可用"}</span>
          <TerminalSquare size={12} />
        </div>
      </div>
      <div className="sidebar-resizer" onPointerDown={props.onResizeStart} />
    </aside>
  );
}
