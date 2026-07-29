import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  BrainCircuit,
  ChevronDown,
  ImagePlus,
  LoaderCircle,
  Shield,
  Square,
  X,
} from "lucide-react";
import type { ConversationRecord, ReasoningEffort, SandboxMode } from "./types";

interface ComposerSeed {
  id: string;
  text: string;
}

interface ComposerProps {
  conversation?: ConversationRecord;
  codexAvailable: boolean;
  loadingHistory: boolean;
  model: string;
  reasoningEffort: ReasoningEffort;
  sandboxMode: SandboxMode;
  seed?: ComposerSeed;
  onModelChange(value: string): void;
  onReasoningEffortChange(value: ReasoningEffort): void;
  onSandboxModeChange(value: SandboxMode): void;
  onChooseImages(): Promise<string[]>;
  onSend(prompt: string, imagePaths: string[]): Promise<boolean>;
  onStop(): void;
  onNewConversation(): void;
}

const commandOptions = [
  { command: "/new", label: "新建会话", action: "new" },
  { command: "/review", label: "审查当前工作区", action: "review" },
  { command: "/test", label: "运行并修复测试", action: "test" },
  { command: "/explain", label: "解释选定代码", action: "explain" },
] as const;

export default function Composer(props: ComposerProps) {
  const [value, setValue] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [commandIndex, setCommandIndex] = useState(0);
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const running = props.conversation?.runState === "running";
  const commandQuery = value.startsWith("/") && !value.includes(" ") ? value.toLowerCase() : "";
  const matchingCommands = useMemo(() => commandQuery
    ? commandOptions.filter((item) => item.command.startsWith(commandQuery))
    : [], [commandQuery]);

  useEffect(() => {
    if (!props.seed) return;
    setValue(props.seed.text);
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  }, [props.seed]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(180, Math.max(58, textarea.scrollHeight))}px`;
  }, [value]);

  useEffect(() => setCommandIndex(0), [commandQuery]);

  const chooseCommand = (action: typeof commandOptions[number]["action"]) => {
    if (action === "new") {
      props.onNewConversation();
      setValue("");
    } else if (action === "review") {
      setValue("Review the current workspace. Prioritize correctness, regressions, security risks, and missing tests. Fix confirmed issues.");
    } else if (action === "test") {
      setValue("Run the relevant test suite, diagnose any failures, and fix the underlying issues.");
    } else {
      setValue("Explain the relevant code path, including its data flow, assumptions, and failure modes.");
    }
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const submit = async () => {
    if (running) {
      props.onStop();
      return;
    }
    const prompt = value.trim();
    if (!prompt || sending || !props.conversation || !props.codexAvailable) return;
    setSending(true);
    try {
      const accepted = await props.onSend(prompt, images);
      if (accepted) {
        setValue("");
        setImages([]);
      }
    } finally {
      setSending(false);
    }
  };

  if (!props.conversation) return null;

  return (
    <div className="composer-region">
      <div className={`composer ${props.sandboxMode === "danger-full-access" ? "danger-mode" : ""}`}>
        {!!images.length && (
          <div className="attachment-strip">
            {images.map((path) => (
              <div className="attachment-chip" key={path}>
                <span><ImagePlus size={13} />{path.split(/[\\/]/).at(-1)}</span>
                <button title="移除图片" onClick={() => setImages((items) => items.filter((item) => item !== path))}><X size={12} /></button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={value}
          disabled={props.loadingHistory}
          placeholder={props.codexAvailable ? "交给 Codex 一个任务…" : "未找到 Codex CLI"}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (matchingCommands.length) {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setCommandIndex((index) => (index + 1) % matchingCommands.length);
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setCommandIndex((index) => (index - 1 + matchingCommands.length) % matchingCommands.length);
                return;
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                chooseCommand(matchingCommands[commandIndex].action);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setValue("");
                return;
              }
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        {!!matchingCommands.length && (
          <div className="command-menu">
            {matchingCommands.map((item, index) => (
              <button key={item.command} className={index === commandIndex ? "active" : ""} onMouseDown={(event) => event.preventDefault()} onClick={() => chooseCommand(item.action)}>
                <code>{item.command}</code><span>{item.label}</span>
              </button>
            ))}
          </div>
        )}
        <div className="composer-toolbar">
          <div className="composer-options">
            <button
              className="toolbar-icon-button"
              title="添加图片"
              disabled={running}
              onClick={() => void props.onChooseImages().then((paths) => setImages((items) => [...new Set([...items, ...paths])].slice(0, 10)))}
            ><ImagePlus size={15} /></button>
            <label className="select-control model-select" title="模型">
              <span className="model-glyph">M</span>
              <select value={props.model} disabled={running} onChange={(event) => props.onModelChange(event.target.value)}>
                <option value="">配置默认</option>
                <option value="gpt-5.6-sol">GPT-5.6 Sol</option>
                <option value="gpt-5.6-terra">GPT-5.6 Terra</option>
                <option value="gpt-5.6-luna">GPT-5.6 Luna</option>
              </select>
              <ChevronDown size={12} />
            </label>
            <label className="select-control" title="推理强度">
              <BrainCircuit size={14} />
              <select value={props.reasoningEffort} disabled={running} onChange={(event) => props.onReasoningEffortChange(event.target.value as ReasoningEffort)}>
                <option value="low">低推理</option>
                <option value="medium">中推理</option>
                <option value="high">高推理</option>
                <option value="xhigh">超高推理</option>
              </select>
              <ChevronDown size={12} />
            </label>
            <label className={`select-control sandbox-select ${props.sandboxMode === "danger-full-access" ? "danger" : ""}`} title="沙箱权限">
              <Shield size={14} />
              <select value={props.sandboxMode} disabled={running} onChange={(event) => props.onSandboxModeChange(event.target.value as SandboxMode)}>
                <option value="read-only">只读</option>
                <option value="workspace-write">工作区</option>
                <option value="danger-full-access">完全访问</option>
              </select>
              <ChevronDown size={12} />
            </label>
          </div>
          <button
            className={`send-button ${running ? "stop" : ""}`}
            title={running ? "停止" : "发送"}
            disabled={!running && (!value.trim() || sending || !props.codexAvailable || props.loadingHistory)}
            onClick={() => void submit()}
          >
            {sending ? <LoaderCircle className="spin" size={15} /> : running ? <Square size={12} fill="currentColor" /> : <ArrowUp size={16} />}
          </button>
        </div>
      </div>
      <div className="composer-status">
        <span>{props.conversation.isDraft ? "新会话" : `Thread ${props.conversation.id.slice(0, 8)}`}</span>
        <span>{props.sandboxMode === "read-only" ? "只读沙箱" : props.sandboxMode === "workspace-write" ? "工作区沙箱" : "完全访问"}</span>
      </div>
    </div>
  );
}
