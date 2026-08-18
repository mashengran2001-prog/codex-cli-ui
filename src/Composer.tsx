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
import { useUiCopy } from "./i18n";
import type { AgentProviderInfo, ConversationRecord, ReasoningEffort, SandboxMode } from "./types";

interface ComposerSeed {
  id: string;
  text: string;
}

interface ComposerProps {
  conversation?: ConversationRecord;
  provider: AgentProviderInfo | null;
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

const commandDefinitions = [
  { command: "/new", action: "new" },
  { command: "/review", action: "review" },
  { command: "/test", action: "test" },
  { command: "/explain", action: "explain" },
] as const;

export default function Composer(props: ComposerProps) {
  const copy = useUiCopy().composer;
  const [value, setValue] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [commandIndex, setCommandIndex] = useState(0);
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const running = props.conversation?.runState === "running";
  const available = props.provider?.available === true && props.provider.configured;
  const capabilities = props.provider?.capabilities;
  const commandOptions = useMemo(() => commandDefinitions.map((item) => ({ ...item, label: copy.commands[item.action].label })), [copy]);
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

  const chooseCommand = (action: typeof commandDefinitions[number]["action"]) => {
    if (action === "new") {
      props.onNewConversation();
      setValue("");
    } else {
      setValue(copy.commands[action].prompt);
    }
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const submit = async () => {
    if (running) {
      props.onStop();
      return;
    }
    const prompt = value.trim();
    if (!prompt || sending || !props.conversation || !available) return;
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
                <button title={copy.removeImage} onClick={() => setImages((items) => items.filter((item) => item !== path))}><X size={12} /></button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={value}
          disabled={props.loadingHistory}
          placeholder={available
            ? copy.taskPlaceholder(props.provider?.shortName || "Provider")
            : props.provider?.available ? copy.notConfigured(props.provider.shortName) : copy.unavailable(props.provider?.shortName || "Provider")}
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
            {capabilities?.images && <button
              className="toolbar-icon-button"
              title={copy.addImage}
              disabled={running}
              onClick={() => void props.onChooseImages().then((paths) => setImages((items) => [...new Set([...items, ...paths])].slice(0, 10)))}
            ><ImagePlus size={15} /></button>}
            {capabilities?.models && <label className="select-control model-select" title={copy.model}>
              <span className="model-glyph">M</span>
              <select value={props.model} disabled={running} onChange={(event) => props.onModelChange(event.target.value)}>
                <option value="">{copy.configuredDefault}</option>
                {(props.provider?.models ?? []).map((model) => <option value={model.id} key={model.id}>{model.label}</option>)}
              </select>
              <ChevronDown size={12} />
            </label>}
            {capabilities?.reasoningEffort && <label className="select-control" title={copy.reasoning}>
              <BrainCircuit size={14} />
              <select value={props.reasoningEffort} disabled={running} onChange={(event) => props.onReasoningEffortChange(event.target.value as ReasoningEffort)}>
                <option value="low">{copy.reasoningLow}</option>
                <option value="medium">{copy.reasoningMedium}</option>
                <option value="high">{copy.reasoningHigh}</option>
                <option value="xhigh">{copy.reasoningXHigh}</option>
              </select>
              <ChevronDown size={12} />
            </label>}
            {capabilities?.sandboxMode && <label className={`select-control sandbox-select ${props.sandboxMode === "danger-full-access" ? "danger" : ""}`} title={copy.sandbox}>
              <Shield size={14} />
              <select value={props.sandboxMode} disabled={running} onChange={(event) => props.onSandboxModeChange(event.target.value as SandboxMode)}>
                <option value="read-only">{copy.readOnly}</option>
                <option value="workspace-write">{copy.workspaceWrite}</option>
                <option value="danger-full-access">{copy.fullAccess}</option>
              </select>
              <ChevronDown size={12} />
            </label>}
          </div>
          <button
            className={`send-button ${running ? "stop" : ""}`}
            title={running ? copy.stop : copy.send}
            disabled={!running && (!value.trim() || sending || !available || props.loadingHistory)}
            onClick={() => void submit()}
          >
            {sending ? <LoaderCircle className="spin" size={15} /> : running ? <Square size={12} fill="currentColor" /> : <ArrowUp size={16} />}
          </button>
        </div>
      </div>
      <div className="composer-status">
        <span>{props.conversation.isDraft ? copy.newSession : `${copy.thread} ${props.conversation.id.slice(0, 8)}`}</span>
        <span>{props.provider?.shortName || "Provider"}</span>
        {capabilities?.sandboxMode && <span>{props.sandboxMode === "read-only" ? copy.readOnlySandbox : props.sandboxMode === "workspace-write" ? copy.workspaceSandbox : copy.fullAccess}</span>}
      </div>
    </div>
  );
}
