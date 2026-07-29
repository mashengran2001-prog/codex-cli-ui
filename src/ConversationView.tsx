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
  RefreshCw,
  TerminalSquare,
  Wrench,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Activity, ChatMessage, ConversationRecord, ProjectRecord } from "./types";

interface ConversationViewProps {
  project?: ProjectRecord;
  conversation?: ConversationRecord;
  loading: boolean;
  onNewConversation(): void;
  onRevealPath(): void;
  onOpenTerminal(): void;
  onRefresh(): void;
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
  if (!activities.length) return null;
  return (
    <div className="activity-list">
      {activities.map((activity) => (
        <details className={`activity-row ${activity.status}`} key={activity.id}>
          <summary>
            <span className="activity-chevron"><ChevronRight size={12} /></span>
            <span className="activity-icon">{activityIcon(activity)}</span>
            <strong>{activity.name}</strong>
            <code>{activity.summary || (activity.status === "running" ? "运行中" : "完成")}</code>
            {activity.status === "done" && <Check className="activity-check" size={13} />}
          </summary>
          {activity.detail && <pre>{activity.detail}</pre>}
        </details>
      ))}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="message-action"
      title={copied ? "已复制" : "复制回答"}
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

function AssistantMessage({ message }: { message: ChatMessage }) {
  const running = message.status === "running";
  return (
    <article className="message assistant-message">
      <div className="assistant-avatar"><Bot size={14} /></div>
      <div className="assistant-message-body">
        {message.reasoning && (
          <details className="reasoning-block">
            <summary><ChevronRight size={12} /><span>推理</span></summary>
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
          <div className="assistant-thinking"><LoaderCircle className="spin" size={14} /><span>Codex 正在处理</span></div>
        ) : null}
        {message.error && <div className="message-error">{message.error}</div>}
        {!!message.content && <div className="message-actions"><CopyButton text={message.content} /></div>}
      </div>
    </article>
  );
}

export default function ConversationView(props: ConversationViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const followOutputRef = useRef(true);
  const messages = props.conversation?.messages ?? [];
  const lastMessage = messages.at(-1);

  useEffect(() => {
    if (!followOutputRef.current) return;
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages.length, lastMessage?.content, lastMessage?.reasoning, lastMessage?.activities?.length]);

  const header = props.project && (
    <header className="conversation-header">
      <div className="conversation-heading">
        <h1>{props.conversation?.title || props.project.name}</h1>
        <button className="workspace-path" title={props.project.path} onClick={props.onRevealPath}>
          <FolderOpen size={12} />
          <span>{props.project.name}</span>
          <small>{props.project.path}</small>
        </button>
      </div>
      <div className="header-actions">
        <button title="刷新会话" onClick={props.onRefresh}><RefreshCw size={14} /></button>
        <button title="打开终端" onClick={props.onOpenTerminal}><TerminalSquare size={14} /></button>
        <button title="在资源管理器中显示" onClick={props.onRevealPath}><FolderOpen size={14} /></button>
      </div>
    </header>
  );

  if (!props.project) {
    return (
      <main className="main-panel">
        <div className="window-drag-region" />
        <section className="empty-workspace">
          <div className="hero-mark" aria-hidden="true"><span /><span /><span /><span /></div>
          <h1>Codex CLI UI</h1>
          <button className="primary-button" onClick={props.onNewConversation}><FolderOpen size={15} />选择工作目录</button>
        </section>
      </main>
    );
  }

  if (!props.conversation) {
    return (
      <main className="main-panel">
        {header}
        <section className="empty-conversation">
          <div className="empty-symbol"><MessageSquarePlus size={20} /></div>
          <h2>{props.project.name}</h2>
          <button className="primary-button" onClick={props.onNewConversation}><MessageSquarePlus size={15} />新建会话</button>
        </section>
      </main>
    );
  }

  return (
    <main className="main-panel">
      {header}
      <div
        className="conversation-scroll"
        ref={scrollRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          followOutputRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96;
        }}
      >
        {props.loading ? (
          <div className="history-loading"><LoaderCircle className="spin" size={17} /><span>载入会话</span></div>
        ) : messages.length === 0 ? (
          <div className="conversation-start">
            <div className="conversation-start-mark"><Clipboard size={18} /></div>
            <h2>开始一个新任务</h2>
          </div>
        ) : (
          <div className="conversation-content">
            {messages.map((message) => message.role === "user"
              ? <UserMessage key={message.id} message={message} />
              : <AssistantMessage key={message.id} message={message} />)}
          </div>
        )}
      </div>
    </main>
  );
}
