import { useEffect, useRef, useState } from "react";
import {
  Bot,
  Check,
  ChevronRight,
  Clipboard,
  Code2,
  Copy,
  ExternalLink,
  FileCode2,
  FolderOpen,
  Globe2,
  Image,
  LoaderCircle,
  MessageSquarePlus,
  TerminalSquare,
  Wrench,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useUiCopy } from "./i18n";
import type { Activity, ChatMessage, ConversationRecord, ProjectRecord, ShellProfile } from "./types";

interface ConversationViewProps {
  project?: ProjectRecord;
  conversation?: ConversationRecord;
  providerName: string;
  loading: boolean;
  onNewConversation(): void;
  onPickWslWorkspace(distroName: string): void;
}

function activityIcon(activity: Activity) {
  const props = { size: 14, strokeWidth: 1.8 };
  if (activity.status === "running") return <LoaderCircle {...props} className="spin" />;
  if (activity.kind === "command") return <TerminalSquare {...props} />;
  if (activity.kind === "file") return <FileCode2 {...props} />;
  if (activity.kind === "web") return <Globe2 {...props} />;
  if (activity.kind === "reasoning") return <Code2 {...props} />;
  return <Wrench {...props} />;
}

function ActivityList({ activities }: { activities: Activity[] }) {
  const copy = useUiCopy().conversation;
  if (!activities.length) return null;
  return (
    <div className="activity-list">
      {activities.map((activity) => (
        <details className={`activity-row ${activity.status}`} key={activity.id}>
          <summary>
            <span className="activity-chevron"><ChevronRight size={12} /></span>
            <span className="activity-icon">{activityIcon(activity)}</span>
            <strong>{activity.name}</strong>
            <code>{activity.summary || (activity.status === "running" ? copy.running : copy.done)}</code>
            {activity.status === "done" && <Check className="activity-check" size={13} />}
          </summary>
          {activity.detail && <pre>{activity.detail}</pre>}
        </details>
      ))}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const copy = useUiCopy().conversation;
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="message-action"
      title={copied ? copy.copied : copy.copyAnswer}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

function UserMessage({ message }: { message: ChatMessage }) {
  return (
    <article className="message user-message">
      <div className="user-message-body">
        {!!message.imagePaths?.length && (
          <div className="sent-images">
            {message.imagePaths.map((path) => <span key={path}><Image size={13} />{path.split(/[\\/]/).at(-1)}</span>)}
          </div>
        )}
        <div>{message.content}</div>
      </div>
    </article>
  );
}

function AssistantMessage({ message, providerName }: { message: ChatMessage; providerName: string }) {
  const copy = useUiCopy().conversation;
  const running = message.status === "running";
  return (
    <article className="message assistant-message">
      <div className="assistant-avatar"><Bot size={14} /></div>
      <div className="assistant-message-body">
        {message.reasoning && (
          <details className="reasoning-block">
            <summary><ChevronRight size={12} /><span>{copy.reasoning}</span></summary>
            <div className="reasoning-content">{message.reasoning}</div>
          </details>
        )}
        <ActivityList activities={message.activities ?? []} />
        {message.content ? (
          <div className="markdown-body">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ children, ...linkProps }) => <a {...linkProps} target="_blank" rel="noreferrer">{children}<ExternalLink size={10} /></a>,
                pre: ({ children }) => <pre>{children}</pre>,
              }}
            >
              {message.content}
            </ReactMarkdown>
          </div>
        ) : running ? (
          <div className="assistant-thinking"><LoaderCircle className="spin" size={14} /><span>{copy.processing(providerName)}</span></div>
        ) : null}
        {message.error && <div className="message-error">{message.error}</div>}
        {!!message.content && <div className="message-actions"><CopyButton text={message.content} /></div>}
      </div>
    </article>
  );
}

export default function ConversationView(props: ConversationViewProps) {
  const copy = useUiCopy().conversation;
  const scrollRef = useRef<HTMLDivElement>(null);
  const followOutputRef = useRef(true);
  const messages = props.conversation?.messages ?? [];
  const lastMessage = messages.at(-1);
  const [wslPickerOpen, setWslPickerOpen] = useState(false);
  const [wslDistros, setWslDistros] = useState<ShellProfile[] | null>(null);
  const toggleWslPicker = async () => {
    if (!wslDistros) {
      const shells = await window.codex.listShells().catch(() => []);
      setWslDistros(shells.filter((shell) => shell.kind === "wsl"));
    }
    setWslPickerOpen((open) => !open);
  };

  useEffect(() => {
    if (!followOutputRef.current) return;
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages.length, lastMessage?.content, lastMessage?.reasoning, lastMessage?.activities?.length]);

  if (!props.project) {
    return (
      <main className="main-panel">
        <section className="empty-workspace">
          <div className="hero-mark" aria-hidden="true"><span /><span /><span /><span /></div>
          <h1>CLI Workbench</h1>
          <div className="workspace-picker-actions">
            <button className="primary-button" onClick={props.onNewConversation}><FolderOpen size={15} />{copy.chooseDirectory}</button>
            <button className="wsl-picker-toggle" onClick={() => void toggleWslPicker()}><TerminalSquare size={15} />{copy.wslDistributions}</button>
          </div>
          {wslPickerOpen && (
            <div className="wsl-distro-picker" role="listbox" aria-label={copy.wslDistributions}>
              {wslDistros && wslDistros.length > 0 ? wslDistros.map((shell) => (
                <button key={shell.id} className="wsl-distro-row" role="option" onClick={() => props.onPickWslWorkspace(shell.label)}>
                  <TerminalSquare size={13} /><span>{shell.label}</span><small>WSL</small>
                </button>
              )) : (
                <span className="wsl-distro-empty">{copy.noWslDistributions}</span>
              )}
            </div>
          )}
        </section>
      </main>
    );
  }

  if (!props.conversation) {
    return (
      <main className="main-panel">
        <section className="empty-conversation">
          <div className="empty-symbol"><MessageSquarePlus size={20} /></div>
          <h2>{props.project.name}</h2>
          <button className="primary-button" onClick={props.onNewConversation}><MessageSquarePlus size={15} />{copy.newSession}</button>
        </section>
      </main>
    );
  }

  return (
    <main className="main-panel">
      <div
        className="conversation-scroll"
        ref={scrollRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          followOutputRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96;
        }}
      >
        {props.loading ? (
          <div className="history-loading"><LoaderCircle className="spin" size={17} /><span>{copy.loading}</span></div>
        ) : messages.length === 0 ? (
          <div className="conversation-start">
            <div className="conversation-start-mark"><Clipboard size={18} /></div>
            {props.conversation?.source === "desktop" ? <h2>{copy.desktopSessionTitle}</h2> : <h2>{copy.startTask}</h2>}
            {props.conversation?.source === "desktop" && <p className="desktop-session-hint">{copy.desktopSessionHint}</p>}
          </div>
        ) : (
          <div className="conversation-content">
            {messages.map((message) => message.role === "user"
              ? <UserMessage key={message.id} message={message} />
              : <AssistantMessage key={message.id} message={message} providerName={props.providerName} />)}
          </div>
        )}
      </div>
    </main>
  );
}
