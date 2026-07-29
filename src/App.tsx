import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, ShieldAlert, X } from "lucide-react";
import Composer from "./Composer";
import ConversationView from "./ConversationView";
import Sidebar from "./Sidebar";
import { defaultState, loadState, saveState } from "./storage";
import type {
  Activity,
  AppSettings,
  CodexInfo,
  ConversationRecord,
  LauncherRequest,
  LauncherStatus,
  PersistedState,
  ProjectRecord,
  ReasoningEffort,
  RunEvent,
  SandboxMode,
} from "./types";

interface PendingDanger {
  conversation: ConversationRecord;
  prompt: string;
  imagePaths: string[];
  resolve(value: boolean): void;
}

interface ToastState {
  id: string;
  title: string;
}

function projectName(path: string) {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || path;
}

function compactTitle(prompt: string) {
  const value = prompt.replace(/\s+/g, " ").trim();
  return value.length > 46 ? `${value.slice(0, 45)}…` : value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function textFromUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFromUnknown).filter(Boolean).join("\n");
  const record = asRecord(value);
  if (!record) return "";
  for (const key of ["text", "output_text", "message", "content"]) {
    const text = textFromUnknown(record[key]);
    if (text) return text;
  }
  return "";
}

function activityFromItem(item: Record<string, unknown>, eventType: string): Activity | null {
  const itemType = asString(item.type);
  const id = asString(item.id) || `${itemType}-${Date.now()}`;
  const rawStatus = asString(item.status);
  const status: Activity["status"] = rawStatus === "failed" || rawStatus === "error"
    ? "error"
    : eventType.includes("completed") || rawStatus === "completed"
      ? "done"
      : "running";

  if (itemType === "command_execution") {
    const command = asString(item.command);
    return { id, kind: "command", name: "Shell", summary: command, detail: asString(item.aggregated_output), status };
  }
  if (itemType === "file_change") {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const files = changes.map((change) => {
      const record = asRecord(change);
      return record ? asString(record.path) : "";
    }).filter(Boolean);
    return { id, kind: "file", name: "Files", summary: files.join(", ") || "更新文件", detail: textFromUnknown(item.changes), status };
  }
  if (itemType === "mcp_tool_call") {
    const server = asString(item.server);
    const tool = asString(item.tool);
    return { id, kind: "tool", name: server ? `${server} · ${tool}` : tool || "MCP", summary: textFromUnknown(item.arguments).slice(0, 180), detail: textFromUnknown(item.result), status };
  }
  if (itemType === "web_search") {
    return { id, kind: "web", name: "Web search", summary: asString(item.query), status };
  }
  if (itemType && itemType !== "agent_message" && itemType !== "reasoning") {
    return { id, kind: "other", name: itemType.replaceAll("_", " "), summary: textFromUnknown(item).slice(0, 180), status };
  }
  return null;
}

function updateAssistant(
  conversation: ConversationRecord,
  runId: string,
  updater: (message: NonNullable<ConversationRecord["messages"]>[number]) => NonNullable<ConversationRecord["messages"]>[number],
) {
  return {
    ...conversation,
    updatedAt: Date.now(),
    messages: (conversation.messages ?? []).map((message) => message.id === `assistant-${runId}` ? updater(message) : message),
  };
}

export default function App() {
  const initial = useMemo(loadState, []);
  const [projects, setProjects] = useState<ProjectRecord[]>(initial.projects);
  const [conversations, setConversations] = useState<ConversationRecord[]>([]);
  const [aliases, setAliases] = useState<Record<string, string>>(initial.aliases);
  const [selectedProjectId, setSelectedProjectId] = useState<string | undefined>(initial.selectedProjectId);
  const [selectedConversationId, setSelectedConversationId] = useState<string | undefined>(initial.selectedConversationId);
  const [sidebarWidth, setSidebarWidth] = useState(initial.sidebarWidth);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [model, setModel] = useState(initial.model);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(initial.reasoningEffort);
  const [sandboxMode, setSandboxMode] = useState<SandboxMode>(initial.sandboxMode);
  const [codexInfo, setCodexInfo] = useState<CodexInfo | null>(null);
  const [launcherStatus, setLauncherStatus] = useState<LauncherStatus | null>(null);
  const [launcherBusy, setLauncherBusy] = useState(false);
  const [appSettings, setAppSettings] = useState<AppSettings>({ closeBehavior: "tray", notifyOnCompletion: true });
  const [loadingConversationId, setLoadingConversationId] = useState<string | null>(null);
  const [refreshingProjects, setRefreshingProjects] = useState<Set<string>>(new Set());
  const [composerSeed, setComposerSeed] = useState<{ id: string; text: string }>();
  const [pendingDanger, setPendingDanger] = useState<PendingDanger | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const projectsRef = useRef(projects);
  const conversationsRef = useRef(conversations);
  const selectedConversationRef = useRef(selectedConversationId);
  const runConversationRef = useRef(new Map<string, string>());
  const runStderrRef = useRef(new Map<string, string>());

  useEffect(() => { projectsRef.current = projects; }, [projects]);
  useEffect(() => { conversationsRef.current = conversations; }, [conversations]);
  useEffect(() => { selectedConversationRef.current = selectedConversationId; }, [selectedConversationId]);

  useEffect(() => {
    const state: PersistedState = {
      version: 1,
      projects,
      aliases,
      selectedProjectId,
      selectedConversationId,
      sidebarWidth,
      model,
      reasoningEffort,
      sandboxMode,
    };
    saveState(state);
  }, [aliases, model, projects, reasoningEffort, sandboxMode, selectedConversationId, selectedProjectId, sidebarWidth]);

  const refreshProject = useCallback(async (projectId: string) => {
    const project = projectsRef.current.find((item) => item.id === projectId);
    if (!project) return;
    setRefreshingProjects((value) => new Set(value).add(projectId));
    try {
      const sessions = await window.codex.listSessions(project.path);
      setConversations((current) => {
        const outsideProject = current.filter((conversation) => conversation.projectId !== projectId);
        const currentProject = current.filter((conversation) => conversation.projectId === projectId);
        const activeOrDraft = currentProject.filter((conversation) => conversation.isDraft || conversation.runState === "running");
        const imported = sessions.map<ConversationRecord>((session) => {
          const existing = currentProject.find((conversation) => conversation.id === session.id);
          return {
            ...session,
            title: aliases[session.id] || session.title,
            projectId,
            runState: existing?.runState ?? "idle",
            runId: existing?.runId,
            messages: existing?.messages,
            isDraft: false,
          };
        });
        const importedIds = new Set(imported.map((conversation) => conversation.id));
        return [...outsideProject, ...activeOrDraft.filter((conversation) => !importedIds.has(conversation.id)), ...imported];
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "刷新 Codex 会话失败");
    } finally {
      setRefreshingProjects((value) => {
        const next = new Set(value);
        next.delete(projectId);
        return next;
      });
    }
  }, [aliases]);

  useEffect(() => {
    void Promise.all([
      window.codex.getInfo().then(setCodexInfo),
      window.codex.getLauncherStatus().then(setLauncherStatus),
      window.codex.getAppSettings().then(setAppSettings),
    ]).catch((reason) => setError(reason instanceof Error ? reason.message : "初始化失败"));
    for (const project of projectsRef.current) void refreshProject(project.id);
  }, [refreshProject]);

  useEffect(() => {
    const conversation = conversations.find((item) => item.id === selectedConversationId);
    if (!conversation || conversation.isDraft || conversation.messages !== undefined || loadingConversationId === conversation.id) return;
    setLoadingConversationId(conversation.id);
    void window.codex.getSession(conversation.id, conversation.cwd)
      .then((session) => {
        setConversations((current) => current.map((item) => item.id === conversation.id
          ? { ...item, ...session, title: aliases[item.id] || session?.title || item.title, projectId: item.projectId, runState: item.runState, messages: session?.messages ?? [] }
          : item));
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "载入会话失败"))
      .finally(() => setLoadingConversationId((id) => id === conversation.id ? null : id));
  }, [aliases, conversations, loadingConversationId, selectedConversationId]);

  const handleRunEvent = useCallback((event: RunEvent) => {
    const data = event.data ?? {};
    const eventType = asString(data.type);
    if (event.type === "stderr") {
      const previous = runStderrRef.current.get(event.runId) ?? "";
      runStderrRef.current.set(event.runId, `${previous}${event.text ?? ""}`.slice(-12_000));
      return;
    }
    if (event.type === "error") {
      setConversations((current) => current.map((conversation) => conversation.runId === event.runId
        ? updateAssistant(conversation, event.runId, (message) => ({ ...message, status: "error", error: event.text || "Codex 启动失败" }))
        : conversation));
      return;
    }
    if (event.type === "exit") {
      const state = event.stopped ? "stopped" : event.code === 0 ? "done" : "error";
      const stderr = runStderrRef.current.get(event.runId)?.trim();
      const conversationId = runConversationRef.current.get(event.runId);
      let completedTitle = "Codex 已完成";
      setConversations((current) => current.map((conversation) => {
        if (conversation.runId !== event.runId) return conversation;
        completedTitle = conversation.title;
        return updateAssistant({ ...conversation, runState: state, runId: undefined }, event.runId, (message) => ({
          ...message,
          status: state,
          error: state === "stopped" ? "任务已停止" : state === "error" ? stderr || `Codex 退出码 ${event.code}` : message.error,
        }));
      }));
      if (conversationId && selectedConversationRef.current !== conversationId && state === "done") {
        setToast({ id: conversationId, title: completedTitle });
      }
      runConversationRef.current.delete(event.runId);
      runStderrRef.current.delete(event.runId);
      return;
    }
    if (event.type !== "message") return;

    if (eventType === "thread.started") {
      const threadId = asString(data.thread_id);
      const oldId = runConversationRef.current.get(event.runId);
      if (!threadId || !oldId) return;
      runConversationRef.current.set(event.runId, threadId);
      setConversations((current) => current.map((conversation) => conversation.runId === event.runId
        ? { ...conversation, id: threadId, isDraft: false }
        : conversation));
      setSelectedConversationId((current) => current === oldId ? threadId : current);
      return;
    }

    if (eventType.includes("agent_message") && eventType.endsWith("delta")) {
      const delta = asString(data.delta);
      if (!delta) return;
      setConversations((current) => current.map((conversation) => conversation.runId === event.runId
        ? updateAssistant(conversation, event.runId, (message) => ({ ...message, content: message.content + delta }))
        : conversation));
      return;
    }
    if (eventType.includes("reasoning") && eventType.endsWith("delta")) {
      const delta = asString(data.delta);
      if (!delta) return;
      setConversations((current) => current.map((conversation) => conversation.runId === event.runId
        ? updateAssistant(conversation, event.runId, (message) => ({ ...message, reasoning: `${message.reasoning ?? ""}${delta}` }))
        : conversation));
      return;
    }

    if (eventType === "item.started" || eventType === "item.updated" || eventType === "item.completed") {
      const item = asRecord(data.item);
      if (!item) return;
      const itemType = asString(item.type);
      setConversations((current) => current.map((conversation) => {
        if (conversation.runId !== event.runId) return conversation;
        return updateAssistant(conversation, event.runId, (message) => {
          if (itemType === "agent_message") {
            const text = textFromUnknown(item.text || item.content || item.message);
            return text ? { ...message, content: text } : message;
          }
          if (itemType === "reasoning") {
            const text = textFromUnknown(item.text || item.summary || item.content);
            return text ? { ...message, reasoning: text } : message;
          }
          const activity = activityFromItem(item, eventType);
          if (!activity) return message;
          const activities = [...(message.activities ?? [])];
          const index = activities.findIndex((value) => value.id === activity.id);
          if (index >= 0) activities[index] = { ...activities[index], ...activity };
          else activities.push(activity);
          return { ...message, activities };
        });
      }));
    } else if (eventType === "error" || eventType === "turn.failed") {
      const message = textFromUnknown(data.message || data.error) || "Codex 运行失败";
      setConversations((current) => current.map((conversation) => conversation.runId === event.runId
        ? updateAssistant(conversation, event.runId, (item) => ({ ...item, status: "error", error: message }))
        : conversation));
    }
  }, []);

  const handleLauncherRequest = useCallback((request: LauncherRequest) => {
    const normalized = request.cwd.toLowerCase();
    let project = projectsRef.current.find((item) => item.path.toLowerCase() === normalized);
    if (!project) {
      project = { id: crypto.randomUUID(), name: projectName(request.cwd), path: request.cwd, createdAt: Date.now() };
      projectsRef.current = [...projectsRef.current, project];
      setProjects(projectsRef.current);
    }
    const draft: ConversationRecord = {
      id: crypto.randomUUID(),
      projectId: project.id,
      title: request.prompt ? compactTitle(request.prompt) : "新会话",
      cwd: project.path,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      runState: "idle",
      isDraft: true,
    };
    setConversations((current) => [...current, draft]);
    setSelectedProjectId(project.id);
    setSelectedConversationId(draft.id);
    if (request.model) setModel(request.model);
    if (request.prompt) setComposerSeed({ id: crypto.randomUUID(), text: request.prompt });
    void refreshProject(project.id);
  }, [refreshProject]);

  useEffect(() => {
    const removeRun = window.codex.onRunEvent(handleRunEvent);
    const removeLauncher = window.codex.onLauncherRequest(handleLauncherRequest);
    return () => { removeRun(); removeLauncher(); };
  }, [handleLauncherRequest, handleRunEvent]);

  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  const selectedConversation = conversations.find((conversation) => conversation.id === selectedConversationId);

  const addProject = async () => {
    const path = await window.codex.chooseDirectory();
    if (!path) return;
    const existing = projectsRef.current.find((project) => project.path.toLowerCase() === path.toLowerCase());
    if (existing) {
      setSelectedProjectId(existing.id);
      const conversation = conversationsRef.current.filter((item) => item.projectId === existing.id).sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (conversation) setSelectedConversationId(conversation.id);
      return;
    }
    const project: ProjectRecord = { id: crypto.randomUUID(), name: projectName(path), path, createdAt: Date.now() };
    projectsRef.current = [...projectsRef.current, project];
    setProjects(projectsRef.current);
    setSelectedProjectId(project.id);
    const draft: ConversationRecord = {
      id: crypto.randomUUID(), projectId: project.id, title: "新会话", cwd: path,
      createdAt: Date.now(), updatedAt: Date.now(), messages: [], runState: "idle", isDraft: true,
    };
    setConversations((current) => [...current, draft]);
    setSelectedConversationId(draft.id);
    void refreshProject(project.id);
  };

  const newConversation = (projectId?: string) => {
    const project = projectsRef.current.find((item) => item.id === (projectId || selectedProjectId));
    if (!project) {
      void addProject();
      return;
    }
    const draft: ConversationRecord = {
      id: crypto.randomUUID(), projectId: project.id, title: "新会话", cwd: project.path,
      createdAt: Date.now(), updatedAt: Date.now(), messages: [], runState: "idle", isDraft: true,
    };
    setConversations((current) => [...current, draft]);
    setSelectedProjectId(project.id);
    setSelectedConversationId(draft.id);
    setComposerSeed({ id: crypto.randomUUID(), text: "" });
  };

  const executeRun = async (conversation: ConversationRecord, prompt: string, imagePaths: string[]) => {
    const runId = crypto.randomUUID();
    const now = Date.now();
    runConversationRef.current.set(runId, conversation.id);
    runStderrRef.current.set(runId, "");
    setConversations((current) => current.map((item) => item.id === conversation.id ? {
      ...item,
      title: item.isDraft && item.title === "新会话" ? compactTitle(prompt) : item.title,
      updatedAt: now,
      runId,
      runState: "running",
      messages: [
        ...(item.messages ?? []),
        { id: `user-${runId}`, role: "user", content: prompt, imagePaths, createdAt: now, status: "done" },
        { id: `assistant-${runId}`, role: "assistant", content: "", createdAt: now + 1, activities: [], status: "running" },
      ],
    } : item));
    try {
      await window.codex.startRun({
        runId,
        prompt,
        cwd: conversation.cwd,
        threadId: conversation.isDraft ? undefined : conversation.id,
        model: model || undefined,
        reasoningEffort,
        sandboxMode,
        imagePaths,
      });
      return true;
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Codex 启动失败";
      setConversations((current) => current.map((item) => item.runId === runId
        ? updateAssistant({ ...item, runState: "error", runId: undefined }, runId, (assistant) => ({ ...assistant, status: "error", error: message }))
        : item));
      setError(message);
      return false;
    }
  };

  const send = async (prompt: string, imagePaths: string[]) => {
    if (!selectedConversation) return false;
    if (sandboxMode !== "danger-full-access") return executeRun(selectedConversation, prompt, imagePaths);
    return new Promise<boolean>((resolve) => setPendingDanger({ conversation: selectedConversation, prompt, imagePaths, resolve }));
  };

  const updateAppSettings = (settings: AppSettings) => {
    setAppSettings(settings);
    void window.codex.setAppSettings(settings).catch((reason) => setError(reason instanceof Error ? reason.message : "保存设置失败"));
  };

  const toggleLauncher = async () => {
    setLauncherBusy(true);
    try {
      const status = launcherStatus?.installed ? await window.codex.uninstallLauncher() : await window.codex.installLauncher();
      setLauncherStatus(status);
      if (status.error) setError(status.error);
    } finally {
      setLauncherBusy(false);
    }
  };

  const removeProject = (projectId: string) => {
    if (conversationsRef.current.some((conversation) => conversation.projectId === projectId && conversation.runState === "running")) {
      setError("项目仍有运行中的任务");
      return;
    }
    setProjects((current) => current.filter((project) => project.id !== projectId));
    setConversations((current) => current.filter((conversation) => conversation.projectId !== projectId));
    if (selectedProjectId === projectId) {
      const next = projects.find((project) => project.id !== projectId);
      setSelectedProjectId(next?.id);
      setSelectedConversationId(next ? conversations.find((conversation) => conversation.projectId === next.id)?.id : undefined);
    }
  };

  const resizeSidebar = (event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    const move = (pointerEvent: PointerEvent) => setSidebarWidth(Math.max(238, Math.min(430, startWidth + pointerEvent.clientX - startX)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div className="app-shell">
      <Sidebar
        projects={projects}
        conversations={conversations}
        selectedProjectId={selectedProjectId}
        selectedConversationId={selectedConversationId}
        codexInfo={codexInfo}
        launcherStatus={launcherStatus}
        launcherBusy={launcherBusy}
        appSettings={appSettings}
        collapsed={sidebarCollapsed}
        width={sidebarWidth}
        onCollapsedChange={setSidebarCollapsed}
        onResizeStart={resizeSidebar}
        onAddProject={() => void addProject()}
        onSelectProject={(id) => {
          setSelectedProjectId(id);
          const first = conversations.filter((conversation) => conversation.projectId === id).sort((a, b) => b.updatedAt - a.updatedAt)[0];
          setSelectedConversationId(first?.id);
        }}
        onRemoveProject={removeProject}
        onRenameProject={(id, name) => setProjects((current) => current.map((project) => project.id === id ? { ...project, name } : project))}
        onRefreshProject={(id) => void refreshProject(id)}
        onNewConversation={newConversation}
        onSelectConversation={(id) => {
          setSelectedConversationId(id);
          const conversation = conversations.find((item) => item.id === id);
          if (conversation) setSelectedProjectId(conversation.projectId);
        }}
        onRenameConversation={(id, name) => {
          setConversations((current) => current.map((conversation) => conversation.id === id ? { ...conversation, title: name } : conversation));
          const conversation = conversations.find((item) => item.id === id);
          if (conversation && !conversation.isDraft) setAliases((current) => ({ ...current, [id]: name }));
        }}
        onLauncherToggle={() => void toggleLauncher()}
        onAppSettingsChange={updateAppSettings}
      />
      <section className="workspace-panel">
        <ConversationView
          project={selectedProject}
          conversation={selectedConversation}
          loading={loadingConversationId === selectedConversation?.id}
          onNewConversation={() => newConversation()}
          onRevealPath={() => { if (selectedProject) void window.codex.revealPath(selectedProject.path); }}
          onOpenTerminal={() => { if (selectedProject) void window.codex.openTerminal(selectedProject.path); }}
          onRefresh={() => { if (selectedProject) void refreshProject(selectedProject.id); }}
        />
        <Composer
          conversation={selectedConversation}
          codexAvailable={codexInfo?.available === true}
          loadingHistory={loadingConversationId === selectedConversation?.id}
          model={model}
          reasoningEffort={reasoningEffort}
          sandboxMode={sandboxMode}
          seed={composerSeed}
          onModelChange={setModel}
          onReasoningEffortChange={setReasoningEffort}
          onSandboxModeChange={setSandboxMode}
          onChooseImages={() => window.codex.chooseImages()}
          onSend={send}
          onStop={() => { if (selectedConversation?.runId) void window.codex.stopRun(selectedConversation.runId); }}
          onNewConversation={() => newConversation()}
        />
      </section>

      {error && (
        <div className="error-toast"><AlertTriangle size={15} /><span>{error}</span><button title="关闭" onClick={() => setError(null)}><X size={13} /></button></div>
      )}
      {toast && (
        <button className="completion-toast" onClick={() => { setSelectedConversationId(toast.id); setToast(null); }}>
          <CheckCircle2 size={17} /><span><strong>任务已完成</strong><small>{toast.title}</small></span>
        </button>
      )}
      {pendingDanger && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="danger-title">
          <div className="danger-dialog">
            <div className="danger-heading"><span><ShieldAlert size={19} /></span><div><h2 id="danger-title">允许完全访问？</h2><p>此任务将绕过 Codex 的审批和沙箱限制。</p></div></div>
            <div className="danger-scope"><strong>{projectName(pendingDanger.conversation.cwd)}</strong><code>{pendingDanger.conversation.cwd}</code></div>
            <div className="dialog-actions">
              <button onClick={() => { pendingDanger.resolve(false); setPendingDanger(null); }}>取消</button>
              <button className="danger-confirm" onClick={() => {
                const pending = pendingDanger;
                setPendingDanger(null);
                void executeRun(pending.conversation, pending.prompt, pending.imagePaths).then(pending.resolve);
              }}>完全访问并运行</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
