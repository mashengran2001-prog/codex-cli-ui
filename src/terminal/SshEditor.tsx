import { useMemo, useState } from "react";
import { Check, KeyRound, LoaderCircle, Plus, Server, Trash2, X } from "lucide-react";
import { useUiCopy } from "../i18n";
import type { SshConnectionStage, SshProfile } from "../types";

/** 私钥最多 4 个（对标 Nebula SSH_EDITOR_KEY_ROWS_MAX）。 */
const MAX_PRIVATE_KEYS = 4;

export default function SshEditor({ profile, onSave, onDelete, onClose, onError }: {
  profile?: SshProfile;
  onSave(profile: SshProfile): Promise<void>;
  onDelete?(id: string): Promise<void>;
  onClose(): void;
  onError(message: string): void;
}) {
  const copy = useUiCopy().ssh;
  const initial = useMemo<SshProfile>(() => profile || { id: crypto.randomUUID(), name: "", host: "", port: 22, username: "", createdAt: Date.now(), updatedAt: Date.now(), source: "saved" }, [profile]);
  const [value, setValue] = useState(initial);
  const [keys, setKeys] = useState<string[]>(() => {
    if (profile?.identityFiles?.length) return profile.identityFiles;
    return profile?.identityFile ? [profile.identityFile] : [];
  });
  const [testing, setTesting] = useState(false);
  const [testStatus, setTestStatus] = useState<{ message: string; error?: boolean }>();
  const [stages, setStages] = useState<SshConnectionStage[]>([]);
  const update = (field: keyof SshProfile, next: string | number) => setValue((current) => ({ ...current, [field]: next }));
  const updatePort = (raw: string) => {
    // 端口只接受至多 5 位数字（对标 Nebula 键入即过滤）。
    const digits = raw.replace(/[^0-9]/g, "").slice(0, 5);
    setValue((current) => ({ ...current, port: digits ? Number(digits) : 0 }));
  };
  const addKeys = async () => {
    try {
      const picked = await window.codex.pickSshKeys();
      if (picked.length) setKeys((current) => [...current, ...picked].slice(0, MAX_PRIVATE_KEYS));
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "无法选择私钥文件");
    }
  };
  const test = async () => {
    setTesting(true);
    setTestStatus({ message: copy.testing });
    try {
      const result = await window.codex.testSshProfile({ ...value, port: value.port || 22, identityFiles: keys.length ? keys : undefined, identityFile: keys[0] });
      setStages(result.stages);
      if (result.ok) setTestStatus({ message: copy.testSuccess(result.elapsedMs ?? 0) });
      else { setTestStatus({ message: result.error || copy.testFailed, error: true }); if (result.error) onError(result.error); }
    } finally {
      setTesting(false);
    }
  };
  const submit = () => {
    const port = value.port || 22;
    if (port < 1 || port > 65535) { setTestStatus({ message: copy.portRange, error: true }); return; }
    void onSave({ ...value, port, identityFiles: keys.length ? keys : undefined, identityFile: keys[0] });
  };
  return (
    <div className="modal-overlay ssh-overlay" role="dialog" aria-modal="true" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <form className="ssh-editor" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <header><span><Server size={17} /><strong>{profile ? copy.edit : copy.create}</strong></span><button type="button" title={copy.close} onClick={onClose}><X size={14} /></button></header>
        <div className="ssh-fields">
          <label><span>{copy.name}</span><input value={value.name} required onChange={(event) => update("name", event.target.value)} /></label>
          <label><span>{copy.host}</span><input value={value.host} required onChange={(event) => update("host", event.target.value)} /></label>
          <div><label><span>{copy.username}</span><input value={value.username} onChange={(event) => update("username", event.target.value)} /></label><label className="port-field"><span>{copy.port}</span><input type="text" inputMode="numeric" value={value.port ? String(value.port) : ""} placeholder="22" onChange={(event) => updatePort(event.target.value)} /></label></div>
          <div className="ssh-key-field"><span>{copy.identityFiles}</span><div className="ssh-key-list">
            {keys.map((keyPath, index) => <div className="ssh-key-row" key={keyPath + ":" + index}><KeyRound size={12} /><span title={keyPath}>{keyPath}</span><button type="button" title={copy.removeKey} onClick={() => setKeys((current) => current.filter((_, i) => i !== index))}><X size={12} /></button></div>)}
            {keys.length === 0 && <div className="ssh-key-empty">{copy.emptyKeys}</div>}
            {keys.length < MAX_PRIVATE_KEYS && <button type="button" className="ssh-key-add" onClick={() => void addKeys()}><Plus size={12} />{copy.addKey}</button>}
          </div></div>
          <label><span>{copy.remotePath}</span><input value={value.remotePath || ""} placeholder="/home/user" onChange={(event) => update("remotePath", event.target.value)} /></label>
        </div>
        {stages.length > 0 && <div className="ssh-stages">{stages.map((stage) => <div className={stage.status} key={stage.name}><span>{stage.status === "running" ? <LoaderCircle className="spin" size={13} /> : stage.status === "done" ? <Check size={13} /> : <i />}</span><strong>{copy.stages[stage.name]}</strong>{stage.message && <small>{stage.message}</small>}</div>)}</div>}
        {testStatus && <div className={"ssh-test-status" + (testStatus.error ? " error" : "")}>{testStatus.message}</div>}
        <footer>
          <span>{profile?.source !== "ssh-config" && profile && onDelete && <button className="delete" type="button" onClick={() => void onDelete(profile.id)}><Trash2 size={13} />{copy.delete}</button>}</span>
          <div><button type="button" disabled={testing || !value.host} onClick={() => void test()}>{testing ? <LoaderCircle className="spin" size={13} /> : null}{copy.test}</button><button className="primary" type="submit" disabled={!value.name.trim() || !value.host.trim()}>{copy.save}</button></div>
        </footer>
      </form>
    </div>
  );
}
