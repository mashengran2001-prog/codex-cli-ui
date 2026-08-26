import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, LoaderCircle, ShieldAlert, X } from "lucide-react";
import Composer from "./Composer";
import { sanitizeDisplayText } from "./text-encoding";
import { loadImportedFonts } from "./importedFonts";
import ConversationView from "./ConversationView";
import Sidebar from "./Sidebar";
import ConfirmDialog from "./ConfirmDialog";
import { getUiCopy, UiLocaleContext, useResolvedAppLocale } from "./i18n";
import { defaultState, loadState, saveState } from "./storage";
import {
  Activity,
  AgentProviderId,
  AgentProviderInfo,
  AppSettings,
  CliLifecycleStatus,
  ConversationRecord,
  DEFAULT_KEYBINDINGS,
  LauncherRequest,
  LauncherStatus,
  PersistedState,
  ProjectRecord,
  ReasoningEffort,
  RunEvent,
  SandboxMode,
} from "./types";

const TerminalWorkspace = lazy(() => import("./TerminalWorkspace"));

const DEFAULT_APP_SETTINGS: AppSettings = {
  closeBehavior: "tray",
  notifyOnCompletion: true,
  language: "system",
  theme: "nebula",
  density: "normal",
  fontFamily: "",
  backgroundBlur: false,
  backgroundOpacity: 0.92,
  backgroundColor: undefined,
  accentColor: undefined,
  restoreTerminalTabs: true,
  resizablePanels: false,
  completionEnabled: true,
  copyOnSelect: true,
  powerlinePrompt: true,
  quickTerminal: true,
  shellStartupIntegration: false,
  defaultShellId: "powershell",
  newTabPlacement: "after-active",
  cursorStyle: "bar",
  cursorBlink: true,
  cellWidth: "compact",
  completionStyle: "inline",
  bellMode: "both",
  renderTerminalMath: true,
  tabPosition: "side",
  builtinBoxDrawing: true,

  resumeAiSessions: true,
  loadShellProfile: false,
  proxyUrl: "",
  proxyBypass: "",
  cliProfiles: [],
  keybindings: { ...DEFAULT_KEYBINDINGS },
};

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

function aliasKey(providerId: AgentProviderId, sessionId: string) {
  return `${providerId}:${sessionId}`;
}

function providerLabel(providerId: AgentProviderId) {
  if (providerId === "codex") return "Codex";
  if (providerId === "claude") return "Claude";
  if (providerId === "deepseek") return "DeepSeek";
  return providerId;
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
  const [sidebarWidth] = useState(initial.sidebarWidth);
  const [workspaceMode, setWorkspaceMode] = useState<"chat" | "terminal">("chat");
  const [model, setModel] = useState(initial.model);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(initial.reasoningEffort);
  const [sandboxMode, setSandboxMode] = useState<SandboxMode>(initial.sandboxMode);
  const [providers, setProviders] = useState<AgentProviderInfo[]>([]);
  const [activeProviderId, setActiveProviderId] = useState<AgentProviderId>(initial.activeProviderId);
  const [launcherStatus, setLauncherStatus] = useState<LauncherStatus | null>(null);
  const [launcherBusy, setLauncherBusy] = useState(false);
  const [cliLifecycleStatus, setCliLifecycleStatus] = useState<CliLifecycleStatus | null>(null);
  const [cliLifecycleBusy, setCliLifecycleBusy] = useState(false);
  const [appSettings, setAppSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const locale = useResolvedAppLocale(appSettings.language);
  const copy = getUiCopy(locale).app;
  const [loadingConversationId, setLoadingConversationId] = useState<string | null>(null);
  const [refreshingProjects, setRefreshingProjects] = useState<Set<string>>(new Set());
  const [composerSeed, setComposerSeed] = useState<{ id: string; text: string }>();
  const [pendingDanger, setPendingDanger] = useState<PendingDanger | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showCompletionToast = useCallback((value: ToastState) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(value);
    // 对齐 Nebula v1.3：完成通知 90 秒自动关闭，避免常驻遮挡终端控件。
    toastTimerRef.current = setTimeout(() => {
      toastTimerRef.current = null;
      setToast(null);
    }, 90_000);
  }, []);
  useEffect(() => () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current); }, []);
  const projectsRef = useRef(projects);
  const conversationsRef = useRef(conversations);
  const selectedConversationRef = useRef(selectedConversationId);
  const runConversationRef = useRef(new Map<string, string>());
  const runStderrRef = useRef(new Map<string, string>());

  useEffect(() => { projectsRef.current = projects; }, [projects]);
  useEffect(() => { conversationsRef.current = conversations; }, [conversations]);
  useEffect(() => { selectedConversationRef.current = selectedConversationId; }, [selectedConversationId]);
  useEffect(() => { document.documentElement.lang = locale; }, [locale]);

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
      activeProviderId,
    };
    saveState(state);
  }, [activeProviderId, aliases, model, projects, reasoningEffort, sandboxMode, selectedConversationId, selectedProjectId, sidebarWidth]);

  const refreshProject = useCallback(async (projectId: string, providerId: AgentProviderId = activeProviderId) => {
    const project = projectsRef.current.find((item) => item.id === projectId);
    if (!project) return;
    setRefreshingProjects((value) => new Set(value).add(projectId));
    try {
      const sessions = await window.workbench.listProviderSessions(providerId, project.path);
      setConversations((current) => {
        const outsideProject = current.filter((conversation) => conversation.projectId !== projectId || conversation.providerId !== providerId);
        const currentProject = current.filter((conversation) => conversation.projectId === projectId && conversation.providerId === providerId);
        const activeOrDraft = currentProject.filter((conversation) => conversation.isDraft || conversation.runState === "running");
        const imported = sessions.map<ConversationRecord>((session) => {
          const existing = currentProject.find((conversation) => conversation.id === session.id);
          return {
            ...session,
            providerId,
            title: aliases[aliasKey(providerId, session.id)] || (providerId === "codex" ? aliases[session.id] : undefined) || session.title,
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
      setError(reason instanceof Error ? reason.message : "刷新 Provider 会话失败");
    } finally {
      setRefreshingProjects((value) => {
        const next = new Set(value);
        next.delete(projectId);
        return next;
      });
    }
  }, [activeProviderId, aliases]);

  useEffect(() => {
    void loadImportedFonts();
  }, []);

  useEffect(() => {
    void Promise.all([
      window.workbench.listProviders().then(setProviders),
      window.codex.getLauncherStatus().then(setLauncherStatus),
      window.codex.getCliLifecycleStatus().then(setCliLifecycleStatus),
      window.codex.getAppSettings().then((settings) => setAppSettings({ ...DEFAULT_APP_SETTINGS, ...settings })),
    ]).catch((reason) => setError(reason instanceof Error ? reason.message : "初始化失败"));
  }, []);

  useEffect(() => {
    for (const project of projectsRef.current) void refreshProject(project.id, activeProviderId);
  }, [activeProviderId, projects.length, refreshProject]);

  useEffect(() => {
    const conversation = conversations.find((item) => item.id === selectedConversationId);
    if (!conversation || conversation.isDraft || conversation.messages !== undefined || loadingConversationId === conversation.id) return;
    setLoadingConversationId(conversation.id);
    void window.workbench.getProviderSession(conversation.providerId, conversation.id, conversation.cwd)
      .then((session) => {
        setConversations((current) => current.map((item) => item.id === conversation.id
          ? { ...item, ...session, title: aliases[aliasKey(item.providerId, item.id)] || (item.providerId === "codex" ? aliases[item.id] : undefined) || session?.title || item.title, projectId: item.projectId, runState: item.runState, messages: session?.messages ?? [] }
          : item));
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "载入会话失败"))
      .finally(() => setLoadingConversationId((id) => id === conversation.id ? null : id));
  }, [aliases, conversations, loadingConversationId, selectedConversationId]);

  const handleRunEvent = useCallback((event: RunEvent) => {
    const data = event.data ?? {};
    const eventType = asString(data.type);
    const providerName = providerLabel(event.providerId);
    if (event.type === "stderr") {
      const previous = runStderrRef.current.get(event.runId) ?? "";
      runStderrRef.current.set(event.runId, `${previous}${event.text ?? ""}`.slice(-12_000));
      return;
    }
    if (event.type === "error") {
      setConversations((current) => current.map((conversation) => conversation.runId === event.runId
        ? updateAssistant(conversation, event.runId, (message) => ({ ...message, status: "error", error: event.text || `${providerName} 启动失败` }))
        : conversation));
      return;
    }
    if (event.type === "exit") {
      const state = event.stopped ? "stopped" : event.code === 0 ? "done" : "error";
      const stderr = runStderrRef.current.get(event.runId)?.trim();
      const conversationId = runConversationRef.current.get(event.runId);
      let completedTitle = `${providerName} 已完成`;
      setConversations((current) => current.map((conversation) => {
        if (conversation.runId !== event.runId) return conversation;
        completedTitle = conversation.title;
        return updateAssistant({ ...conversation, runState: state, runId: undefined }, event.runId, (message) => ({
          ...message,
          status: state,
          error: state === "stopped" ? "任务已停止" : state === "error" ? stderr || `${providerName} 退出码 ${event.code}` : message.error,
        }));
      }));
      if (conversationId && selectedConversationRef.current !== conversationId && state === "done") {
        showCompletionToast({ id: conversationId, title: completedTitle });
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
      const message = textFromUnknown(data.message || data.error) || `${providerName} 运行失败`;
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
      providerId: "codex",
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
    setActiveProviderId("codex");
    setWorkspaceMode("chat");
    if (request.model) setModel(request.model);
    if (request.prompt) setComposerSeed({ id: crypto.randomUUID(), text: request.prompt });
    void refreshProject(project.id, "codex");
  }, [refreshProject]);

  useEffect(() => {
    const removeRun = window.codex.onRunEvent(handleRunEvent);
    const removeLauncher = window.codex.onLauncherRequest(handleLauncherRequest);
    // Startup launcher requests are pulled once listeners are registered so a
    // slow first paint can never drop the request (main no longer pushes it).
    void window.codex.pullLauncherRequest().then((request) => {
      if (request) handleLauncherRequest(request);
    });
    const removeQuickTerminal = window.codex.onQuickTerminal(() => {
      const project = projectsRef.current.find((item) => item.id === selectedProjectId) || projectsRef.current[0];
      if (!project) return;
      setSelectedProjectId(project.id);
      setWorkspaceMode("terminal");
    });
    return () => { removeRun(); removeLauncher(); removeQuickTerminal(); };
  }, [handleLauncherRequest, handleRunEvent, selectedProjectId]);

  useEffect(() => {
    document.documentElement.dataset.terminalTheme = appSettings.theme;
  }, [appSettings.theme]);

  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  const activeProvider = providers.find((provider) => provider.id === activeProviderId) ?? null;
  const visibleConversations = conversations.filter((conversation) => conversation.providerId === activeProviderId);
  const selectedConversation = visibleConversations.find((conversation) => conversation.id === selectedConversationId);

  const openPathAsProject = async (path: string) => {
    const existing = projectsRef.current.find((project) => project.path.toLowerCase() === path.toLowerCase());
    if (existing) {
      setSelectedProjectId(existing.id);
      const conversation = conversationsRef.current.filter((item) => item.projectId === existing.id && item.providerId === activeProviderId).sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (conversation) setSelectedConversationId(conversation.id);
      return true;
    }
    const project: ProjectRecord = { id: crypto.randomUUID(), name: projectName(path), path, createdAt: Date.now() };
    projectsRef.current = [...projectsRef.current, project];
    setProjects(projectsRef.current);
    setSelectedProjectId(project.id);
    const draft: ConversationRecord = {
      providerId: activeProviderId,
      id: crypto.randomUUID(), projectId: project.id, title: "新会话", cwd: path,
      createdAt: Date.now(), updatedAt: Date.now(), messages: [], runState: "idle", isDraft: true,
    };
    setConversations((current) => [...current, draft]);
    setSelectedConversationId(draft.id);
    setWorkspaceMode("chat");
    void refreshProject(project.id, activeProviderId);
    return true;
  };

  const addProject = async () => {
    const path = await window.codex.chooseDirectory();
    if (!path) return false;
    return openPathAsProject(path);
  };

  // WSL 发行版快捷入口：把 \\wsl.localhost\<发行版> 当作工作目录直接进入对话。
  const newWslConversation = (distroName: string) => {
    const path = `\\\\wsl.localhost\\${distroName}`;
    void openPathAsProject(path);
  };

  const newConversation = (projectId?: string) => {
    const project = projectsRef.current.find((item) => item.id === (projectId || selectedProjectId));
    if (!project) {
      void addProject();
      return;
    }
    const draft: ConversationRecord = {
      providerId: activeProviderId,
      id: crypto.randomUUID(), projectId: project.id, title: "新会话", cwd: project.path,
      createdAt: Date.now(), updatedAt: Date.now(), messages: [], runState: "idle", isDraft: true,
    };
    setConversations((current) => [...current, draft]);
    setSelectedProjectId(project.id);
    setSelectedConversationId(draft.id);
    setWorkspaceMode("chat");
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
        providerId: conversation.providerId,
        runId,
        prompt,
        cwd: conversation.cwd,
        threadId: conversation.isDraft || conversation.source === "desktop" ? undefined : conversation.id,
        model: model || undefined,
        reasoningEffort,
        sandboxMode,
        imagePaths,
      });
      return true;
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Provider 启动失败";
      setConversations((current) => current.map((item) => item.runId === runId
        ? updateAssistant({ ...item, runState: "error", runId: undefined }, runId, (assistant) => ({ ...assistant, status: "error", error: message }))
        : item));
      setError(message);
      return false;
    }
  };

  const send = async (prompt: string, imagePaths: string[]) => {
    if (!selectedConversation) return false;
    if (!activeProvider?.capabilities.sandboxMode || sandboxMode !== "danger-full-access") return executeRun(selectedConversation, prompt, imagePaths);
    return new Promise<boolean>((resolve) => setPendingDanger({ conversation: selectedConversation, prompt, imagePaths, resolve }));
  };

  const selectProvider = (providerId: AgentProviderId) => {
    setActiveProviderId(providerId);
    const next = conversationsRef.current
      .filter((conversation) => conversation.providerId === providerId && (!selectedProjectId || conversation.projectId === selectedProjectId))
      .sort((left, right) => right.updatedAt - left.updatedAt)[0];
    setSelectedConversationId(next?.id);
    setModel(providers.find((provider) => provider.id === providerId)?.defaultModel || "");
  };

  const refreshProvider = async (providerId: AgentProviderId) => {
    try {
      const info = await window.workbench.refreshProvider(providerId);
      setProviders((current) => current.map((provider) => provider.id === providerId ? info : provider));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "刷新 Provider 失败");
    }
  };

  const installProvider = async (providerId: AgentProviderId) => {
    const result = await window.workbench.installProvider(providerId);
    if (!result.ok) setError(result.message);
    else await refreshProvider(providerId);
  };

  const saveProviderCredential = async (providerId: AgentProviderId, credential: string) => {
    try {
      const info = await window.workbench.setProviderCredential(providerId, credential);
      setProviders((current) => current.map((provider) => provider.id === providerId ? info : provider));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.saveCredentialFailed);
    }
  };

  const updateAppSettings = (settings: AppSettings) => {
    const previous = appSettings;
    setAppSettings(settings);
    void window.codex.setAppSettings(settings)
      .then(setAppSettings)
      .catch((reason) => {
        setAppSettings(previous);
        setError(reason instanceof Error ? reason.message : copy.saveSettingsFailed);
      });
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

  const toggleCliLifecycle = async () => {
    setCliLifecycleBusy(true);
    try {
      const status = await window.codex.setCliLifecycleEnabled(!(cliLifecycleStatus?.enabled ?? false));
      setCliLifecycleStatus(status);
      const issue = status.error || status.integrations.find((integration) => integration.error)?.error;
      if (issue) setError(issue);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.lifecycleFailed);
    } finally {
      setCliLifecycleBusy(false);
    }
  };

  const removeProject = (projectId: string) => {
    if (conversationsRef.current.some((conversation) => conversation.projectId === projectId && conversation.runState === "running")) {
      setError(copy.projectBusy);
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

  return (
    <UiLocaleContext.Provider value={locale}>
    <div className="app-shell nebula-shell">
      <Suspense fallback={<div className="terminal-loading"><LoaderCircle className="spin" size={18} /><span>{copy.launching}</span></div>}>
        <TerminalWorkspace
          project={selectedProject}
          settings={appSettings}
          workspaceMode={workspaceMode}
          chatTitle={selectedConversation?.title || selectedProject?.name}
          providerName={activeProvider?.shortName || "Provider"}
          cliLifecycleStatus={cliLifecycleStatus}
          cliLifecycleBusy={cliLifecycleBusy}
          onSettingsChange={updateAppSettings}
          onCliLifecycleToggle={() => void toggleCliLifecycle()}
          onWorkspaceModeChange={setWorkspaceMode}
          onRefreshChat={() => { if (selectedProject) void refreshProject(selectedProject.id, activeProviderId); }}
          onAddProject={addProject}
          onError={setError}
          chatSidebar={(
            <Sidebar
              projects={projects}
              conversations={visibleConversations}
              selectedProjectId={selectedProjectId}
              selectedConversationId={selectedConversationId}
              providers={providers}
              activeProviderId={activeProviderId}
              launcherStatus={launcherStatus}
              launcherBusy={launcherBusy}
              appSettings={appSettings}
              onAddProject={() => void addProject()}
              onSelectProject={(id) => {
                setSelectedProjectId(id);
                const first = visibleConversations.filter((conversation) => conversation.projectId === id).sort((a, b) => b.updatedAt - a.updatedAt)[0];
                setSelectedConversationId(first?.id);
              }}
              onRemoveProject={removeProject}
              onRenameProject={(id, name) => setProjects((current) => current.map((project) => project.id === id ? { ...project, name } : project))}
              onRefreshProject={(id) => void refreshProject(id)}
              onNewConversation={newConversation}
              onSelectConversation={(id) => {
                setSelectedConversationId(id);
                setWorkspaceMode("chat");
                const conversation = visibleConversations.find((item) => item.id === id);
                if (conversation) setSelectedProjectId(conversation.projectId);
              }}
              onRenameConversation={(id, name) => {
                setConversations((current) => current.map((conversation) => conversation.id === id ? { ...conversation, title: name } : conversation));
                const conversation = visibleConversations.find((item) => item.id === id);
                if (conversation && !conversation.isDraft) setAliases((current) => ({ ...current, [aliasKey(conversation.providerId, id)]: name }));
              }}
              onLauncherToggle={() => void toggleLauncher()}
              onAppSettingsChange={updateAppSettings}
              onProviderChange={selectProvider}
              onProviderRefresh={(id) => void refreshProvider(id)}
              onProviderInstall={(id) => void installProvider(id)}
              onProviderCredential={(id, value) => void saveProviderCredential(id, value)}
            />
          )}
          chatContent={(
            <div className="chat-workspace">
            <ConversationView
              project={selectedProject}
              conversation={selectedConversation}
              providerName={activeProvider?.shortName || "Provider"}
              loading={loadingConversationId === selectedConversation?.id}
              onNewConversation={() => newConversation()}
              onPickWslWorkspace={(name) => newWslConversation(name)}
            />
            <Composer
              conversation={selectedConversation}
              provider={activeProvider}
              loadingHistory={loadingConversationId === selectedConversation?.id}
              model={model}
              reasoningEffort={reasoningEffort}
              sandboxMode={sandboxMode}
              seed={composerSeed}
              onModelChange={setModel}
              onReasoningEffortChange={setReasoningEffort}
              onSandboxModeChange={setSandboxMode}
              onChooseImages={() => activeProvider?.capabilities.images ? window.codex.chooseImages() : Promise.resolve([])}
              onSend={send}
              onStop={() => { if (selectedConversation?.runId) void window.codex.stopRun(selectedConversation.runId); }}
              onNewConversation={() => newConversation()}
            />
            </div>
          )}
        />
      </Suspense>

      {error && (
        <div className="error-toast"><AlertTriangle size={15} /><span>{sanitizeDisplayText(error)}</span><button title={copy.close} onClick={() => setError(null)}><X size={13} /></button></div>
      )}
      {toast && (
        <button className="completion-toast" onClick={() => { setSelectedConversationId(toast.id); setToast(null); if (toastTimerRef.current) { clearTimeout(toastTimerRef.current); toastTimerRef.current = null; } }}>
          <CheckCircle2 size={17} /><span><strong>{copy.completed}</strong><small>{sanitizeDisplayText(toast.title)}</small></span>
        </button>
      )}
      {pendingDanger && (
        <ConfirmDialog
          danger
          icon={<ShieldAlert size={19} />}
          title={copy.dangerTitle}
          body={<>{copy.dangerBody}<div className="confirm-scope"><strong>{projectName(pendingDanger.conversation.cwd)}</strong><code>{pendingDanger.conversation.cwd}</code></div></>}
          confirmLabel={copy.dangerRun}
          cancelLabel={copy.cancel}
          onCancel={() => { pendingDanger.resolve(false); setPendingDanger(null); }}
          onConfirm={() => {
            const pending = pendingDanger;
            setPendingDanger(null);
            void executeRun(pending.conversation, pending.prompt, pending.imagePaths).then(pending.resolve);
          }}
        />
      )}
    </div>
    </UiLocaleContext.Provider>
  );
}
