import { useMemo, useState } from "react";
import { Check, KeyRound, LoaderCircle, Server, Trash2, X } from "lucide-react";
import { useUiCopy } from "../i18n";
import type { SshConnectionStage, SshProfile } from "../types";

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
  const [testing, setTesting] = useState(false);
  const [stages, setStages] = useState<SshConnectionStage[]>([]);
  const update = (field: keyof SshProfile, next: string | number) => setValue((current) => ({ ...current, [field]: next }));
  const test = async () => {
    setTesting(true);
    try { const result = await window.codex.testSshProfile(value); setStages(result.stages); if (!result.ok && result.error) onError(result.error); }
    finally { setTesting(false); }
  };
  return (
    <div className="modal-overlay ssh-overlay" role="dialog" aria-modal="true" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <form className="ssh-editor" onSubmit={(event) => { event.preventDefault(); void onSave(value); }}>
        <header><span><Server size={17} /><strong>{profile ? copy.edit : copy.create}</strong></span><button type="button" title={copy.close} onClick={onClose}><X size={14} /></button></header>
        <div className="ssh-fields">
          <label><span>{copy.name}</span><input value={value.name} required onChange={(event) => update("name", event.target.value)} /></label>
          <label><span>{copy.host}</span><input value={value.host} required onChange={(event) => update("host", event.target.value)} /></label>
          <div><label><span>{copy.username}</span><input value={value.username} onChange={(event) => update("username", event.target.value)} /></label><label className="port-field"><span>{copy.port}</span><input type="number" min="1" max="65535" value={value.port} onChange={(event) => update("port", Number(event.target.value))} /></label></div>
          <label><span>{copy.identityFile}</span><div className="input-with-icon"><KeyRound size={13} /><input value={value.identityFile || ""} placeholder="~/.ssh/id_ed25519" onChange={(event) => update("identityFile", event.target.value)} /></div></label>
          <label><span>{copy.remotePath}</span><input value={value.remotePath || ""} placeholder="/home/user" onChange={(event) => update("remotePath", event.target.value)} /></label>
        </div>
        {stages.length > 0 && <div className="ssh-stages">{stages.map((stage) => <div className={stage.status} key={stage.name}><span>{stage.status === "running" ? <LoaderCircle className="spin" size={13} /> : stage.status === "done" ? <Check size={13} /> : <i />}</span><strong>{copy.stages[stage.name]}</strong>{stage.message && <small>{stage.message}</small>}</div>)}</div>}
        <footer>
          <span>{profile?.source !== "ssh-config" && profile && onDelete && <button className="delete" type="button" onClick={() => void onDelete(profile.id)}><Trash2 size={13} />{copy.delete}</button>}</span>
          <div><button type="button" disabled={testing || !value.host} onClick={() => void test()}>{testing ? <LoaderCircle className="spin" size={13} /> : null}{copy.test}</button><button className="primary" type="submit" disabled={!value.name.trim() || !value.host.trim()}>{copy.save}</button></div>
        </footer>
      </form>
    </div>
  );
}
