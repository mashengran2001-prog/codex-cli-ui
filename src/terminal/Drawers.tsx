import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  ChevronLeft,
  Copy,
  Download,
  ExternalLink,
  File,
  Folder,
  FolderPlus,
  FolderTree,
  GitBranch,
  GitCommitHorizontal,
  LoaderCircle,
  Pencil,
  RefreshCw,
  Search,
  Send,
  TerminalSquare,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useUiCopy } from "../i18n";
import type { DocumentFile, FileSystemEntry, GitStatus, SftpEntry, SshProfile } from "../types";

function samePath(left: string, right: string) {
  return left.replace(/[\\/]+$/, "").toLowerCase() === right.replace(/[\\/]+$/, "").toLowerCase();
}

function parentDirectory(path: string) {
  const value = path.replace(/[\\/]+$/, "");
  const index = Math.max(value.lastIndexOf("\\"), value.lastIndexOf("/"));
  return index > 2 ? value.slice(0, index) : value;
}

function formatSize(size?: number) {
  if (size === undefined) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function FilesDrawer({ root, onClose, onNewTerminal, onDocument, onError }: {
  root: string;
  onClose(): void;
  onNewTerminal(path: string): void;
  onDocument(document: DocumentFile): void;
  onError(message: string): void;
}) {
  const copy = useUiCopy().files;
  const [currentPath, setCurrentPath] = useState(root);
  const [entries, setEntries] = useState<FileSystemEntry[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => setCurrentPath(root), [root]);
  const refresh = useCallback(async () => {
    setLoading(true);
    try { setEntries(await window.codex.listDirectory(root, currentPath)); }
    catch (reason) { onError(reason instanceof Error ? reason.message : copy.readFailed); }
    finally { setLoading(false); }
  }, [copy, currentPath, onError, root]);
  useEffect(() => { void refresh(); }, [refresh]);
  const visibleEntries = useMemo(() => entries.filter((entry) => entry.name.toLowerCase().includes(query.trim().toLowerCase())), [entries, query]);
  const openEntry = async (entry: FileSystemEntry) => {
    if (entry.type === "directory") { setCurrentPath(entry.path); return; }
    const document = await window.codex.readDocument(root, entry.path);
    if (document) onDocument(document);
    else await window.codex.revealPath(entry.path);
  };
  return (
    <aside className="terminal-drawer" aria-label={copy.title}>
      <div className="drawer-heading"><div><FolderTree size={15} /><strong>{copy.title}</strong><span>{visibleEntries.length}</span></div><button title={copy.close} onClick={onClose}><X size={14} /></button></div>
      <div className="drawer-pathbar">
        <button title={copy.parent} disabled={samePath(currentPath, root)} onClick={() => setCurrentPath(parentDirectory(currentPath))}><ChevronLeft size={14} /></button>
        <code title={currentPath}>{samePath(currentPath, root) ? currentPath.split(/[\\/]/).at(-1) : currentPath.slice(root.length).replace(/^[\\/]+/, "")}</code>
        <button title={copy.copyPath} onClick={() => void window.codex.copyText(currentPath)}><Copy size={13} /></button>
        <button title={copy.reveal} onClick={() => void window.codex.revealPath(currentPath)}><ExternalLink size={13} /></button>
        <button title={copy.terminalHere} onClick={() => onNewTerminal(currentPath)}><TerminalSquare size={13} /></button>
        <button title={copy.refresh} onClick={() => void refresh()}><RefreshCw className={loading ? "spin" : ""} size={13} /></button>
      </div>
      <label className="drawer-search"><Search size={13} /><input value={query} placeholder={copy.filter} onChange={(event) => setQuery(event.target.value)} /></label>
      <div className="file-list">
        {visibleEntries.map((entry) => <button className="file-row" draggable key={entry.path} title={entry.path} onDragStart={(event) => { event.dataTransfer.effectAllowed = "copy"; event.dataTransfer.setData("application/x-codex-ui-path", entry.path); event.dataTransfer.setData("text/plain", entry.path); }} onClick={() => void openEntry(entry)}><span className={`file-kind ${entry.type}`}>{entry.type === "directory" ? <Folder size={14} /> : <File size={13} />}</span><strong>{entry.name}</strong><small>{entry.type === "file" ? formatSize(entry.size) : ""}</small></button>)}
        {!loading && visibleEntries.length === 0 && <div className="drawer-empty">{copy.empty}</div>}
      </div>
    </aside>
  );
}

export function GitDrawer({ root, onClose, onError }: { root: string; onClose(): void; onError(message: string): void }) {
  const copy = useUiCopy().git;
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const refresh = useCallback(async () => {
    setLoading(true);
    try { setStatus(await window.codex.getGitStatus(root)); }
    catch (reason) { onError(reason instanceof Error ? reason.message : copy.readFailed); }
    finally { setLoading(false); }
  }, [copy, onError, root]);
  useEffect(() => { void refresh(); }, [refresh]);
  const act = async (action: "stage" | "unstage" | "commit" | "pull" | "push") => {
    setLoading(true);
    try {
      const result = await window.codex.runGitAction({ root, action, paths: [...selected], message });
      if (!result.ok) onError(result.message);
      else { if (action === "commit") setMessage(""); setSelected(new Set()); await refresh(); }
    } finally { setLoading(false); }
  };
  return (
    <aside className="terminal-drawer git-drawer" aria-label="Git">
      <div className="drawer-heading"><div><GitBranch size={15} /><strong>Git</strong>{status?.branch && <span>{status.branch}</span>}</div><button title={copy.close} onClick={onClose}><X size={14} /></button></div>
      <div className="git-summary"><span>{status?.available ? copy.changes(status.entries.length) : copy.notRepository}</span><button title={copy.pull} disabled={loading || !status?.available} onClick={() => void act("pull")}><Download size={13} /></button><button title={copy.push} disabled={loading || !status?.available} onClick={() => void act("push")}><Send size={13} /></button><button title={copy.refresh} onClick={() => void refresh()}>{loading ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}</button></div>
      <div className="git-list">
        {status?.entries.map((entry, index) => {
          const checked = selected.has(entry.path);
          return <button className={`git-row ${checked ? "selected" : ""}`} key={`${entry.path}-${index}`} onClick={() => setSelected((current) => { const next = new Set(current); if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path); return next; })}><span className="git-check">{checked && <Check size={11} />}</span><span className="git-code">{entry.status}</span><strong title={entry.path}>{entry.path}</strong></button>;
        })}
        {status?.available && status.entries.length === 0 && <div className="drawer-empty">{copy.clean}</div>}
        {status && !status.available && <div className="drawer-empty error">{status.error || copy.unavailable}</div>}
      </div>
      {status?.available && <div className="git-actions"><div><button disabled={loading} onClick={() => void act("stage")}><ArrowDownToLine size={13} />{copy.stage}</button><button disabled={loading} onClick={() => void act("unstage")}><ArrowUpFromLine size={13} />{copy.unstage}</button></div><label><input value={message} placeholder={copy.commitMessage} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && message.trim()) void act("commit"); }} /><button title={copy.commit} disabled={!message.trim() || loading} onClick={() => void act("commit")}><GitCommitHorizontal size={14} /></button></label></div>}
    </aside>
  );
}

export function SftpDrawer({ profile, onClose, onError }: { profile: SshProfile; onClose(): void; onError(message: string): void }) {
  const copy = useUiCopy().sftp;
  const [path, setPath] = useState(profile.remotePath || "/");
  const [entries, setEntries] = useState<SftpEntry[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const refresh = useCallback(async () => {
    setLoading(true);
    try { setEntries(await window.codex.listSftp(profile.id, path)); }
    catch (reason) { onError(reason instanceof Error ? reason.message : copy.listFailed); }
    finally { setLoading(false); }
  }, [copy, onError, path, profile.id]);
  useEffect(() => { void refresh(); }, [refresh]);
  const action = async (actionName: "upload" | "download" | "mkdir" | "rename" | "delete", remotePath: string, destinationPath?: string) => {
    setLoading(true);
    try { const result = await window.codex.runSftpAction({ profileId: profile.id, action: actionName, remotePath, destinationPath }); if (!result.ok && !/cancelled/i.test(result.message)) onError(result.message); await refresh(); }
    finally { setLoading(false); }
  };
  const visible = entries.filter((entry) => entry.name.toLowerCase().includes(query.toLowerCase()));
  return (
    <aside className="terminal-drawer sftp-drawer" aria-label="SFTP">
      <div className="drawer-heading"><div><Upload size={15} /><strong>SFTP</strong><span>{profile.name}</span></div><button title={copy.close} onClick={onClose}><X size={14} /></button></div>
      <form className="drawer-pathbar" onSubmit={(event) => { event.preventDefault(); void refresh(); }}><button type="button" title={copy.parent} onClick={() => setPath(path.replace(/\/?[^/]+\/?$/, "") || "/")}><ChevronLeft size={14} /></button><input aria-label={copy.remotePath} value={path} onChange={(event) => setPath(event.target.value)} /><button type="button" title={copy.upload} onClick={() => void action("upload", path)}><Upload size={13} /></button><button type="button" title={copy.newFolder} onClick={() => { const name = window.prompt(copy.folderName); if (name) void action("mkdir", `${path.replace(/\/$/, "")}/${name}`); }}><FolderPlus size={13} /></button><button type="submit" title={copy.refresh}><RefreshCw className={loading ? "spin" : ""} size={13} /></button></form>
      <label className="drawer-search"><Search size={13} /><input value={query} placeholder={copy.filter} onChange={(event) => setQuery(event.target.value)} /></label>
      <div className="file-list">
        {visible.map((entry) => <div className="file-row sftp-row" key={entry.path}><button title={entry.path} onClick={() => entry.type === "directory" ? setPath(entry.path) : undefined}><span className={`file-kind ${entry.type}`}>{entry.type === "directory" ? <Folder size={14} /> : <File size={13} />}</span><strong>{entry.name}</strong><small>{formatSize(entry.size)}</small></button><span><button title={copy.download} onClick={() => void action("download", entry.path)}><Download size={12} /></button><button title={copy.rename} onClick={() => { const name = window.prompt(copy.newName, entry.name); if (name && name !== entry.name) void action("rename", entry.path, `${path.replace(/\/$/, "")}/${name}`); }}><Pencil size={12} /></button><button title={copy.delete} onClick={() => { if (window.confirm(copy.confirmDelete(entry.name))) void action("delete", entry.path); }}><Trash2 size={12} /></button></span></div>)}
        {!loading && visible.length === 0 && <div className="drawer-empty">{copy.empty}</div>}
      </div>
    </aside>
  );
}
