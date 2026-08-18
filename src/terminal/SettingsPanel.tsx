import { useState } from "react";
import { BellRing, Check, Image, LoaderCircle, Plus, RotateCcw, Settings2, Trash2, X } from "lucide-react";
import BrandIcon, { type BrandIconName } from "../BrandIcon";
import type { AppSettings, CliLifecycleStatus, CliProfile, CliToolInfo, ShellProfile, TerminalThemeName } from "../types";
import { getSettingsCopy } from "../i18n";
import { terminalThemes } from "./themes";

interface SettingsPanelProps {
  settings: AppSettings;
  shells: ShellProfile[];
  cliTools: CliToolInfo[];
  cliLifecycleStatus: CliLifecycleStatus | null;
  cliLifecycleBusy: boolean;
  onChange(settings: AppSettings): void;
  onCliLifecycleToggle(): void;
  onClose(): void;
}

export default function SettingsPanel({ settings, shells, cliTools, cliLifecycleStatus, cliLifecycleBusy, onChange, onCliLifecycleToggle, onClose }: SettingsPanelProps) {
  const [newName, setNewName] = useState("");
  const [newCommand, setNewCommand] = useState("");
  const copy = getSettingsCopy(settings.language);
  const update = <Key extends keyof AppSettings>(key: Key, value: AppSettings[Key]) => onChange({ ...settings, [key]: value });
  const saveProfile = (next: CliProfile) => update("cliProfiles", settings.cliProfiles.map((profile) => profile.id === next.id ? next : profile));
  const addProfile = () => {
    const name = newName.trim();
    const command = newCommand.trim();
    if (!name || !command) return;
    update("cliProfiles", [...settings.cliProfiles, { id: `custom:${crypto.randomUUID()}`, name, command, args: [], icon: "terminal" }]);
    setNewName("");
    setNewCommand("");
  };
  return (
    <section className="terminal-settings">
      <header><span><Settings2 size={16} /><strong>{copy.title}</strong></span><button title={copy.close} onClick={onClose}><X size={14} /></button></header>
      <div className="settings-scroll">
        <section>
          <h2>{copy.appearance}</h2>
          <div className="theme-grid">
            {(Object.keys(terminalThemes) as TerminalThemeName[]).map((name) => {
              const item = terminalThemes[name];
              return (
                <button className={settings.theme === name ? "selected" : ""} key={name} onClick={() => update("theme", name)}>
                  <span className="theme-swatches"><i style={{ background: item.terminal.background }} /><i style={{ background: item.terminal.green }} /><i style={{ background: item.terminal.blue }} /></span>
                  <strong>{copy.themes[name]}</strong>{settings.theme === name && <Check size={13} />}
                </button>
              );
            })}
          </div>
          <div className="settings-row">
            <label>{copy.language}</label>
            <select aria-label={copy.language} value={settings.language} onChange={(event) => update("language", event.target.value as AppSettings["language"])}><option value="system">{copy.followSystem}</option><option value="zh-CN">简体中文</option><option value="en-US">English</option></select>
          </div>
          <div className="settings-row">
            <label>{copy.backgroundImage}</label>
            <div className="settings-inline-actions">
              <button onClick={() => void window.codex.chooseBackgroundImage().then((path) => { if (path) update("backgroundImage", path); })}><Image size={13} />{copy.choose}</button>
              {settings.backgroundImage && <button title={copy.clearBackground} onClick={() => update("backgroundImage", undefined)}><RotateCcw size={13} /></button>}
            </div>
          </div>
          <div className="settings-row range-row"><label>{copy.opacity} <output>{Math.round(settings.backgroundOpacity * 100)}%</output></label><input type="range" min="35" max="100" value={Math.round(settings.backgroundOpacity * 100)} onChange={(event) => update("backgroundOpacity", Number(event.target.value) / 100)} /></div>
          <Toggle label={copy.backgroundBlur} checked={settings.backgroundBlur} onChange={(value) => update("backgroundBlur", value)} />
        </section>
        <section>
          <h2>{copy.terminal}</h2>
          <div className="settings-row"><label>{copy.defaultShell}</label><select value={settings.defaultShellId} onChange={(event) => update("defaultShellId", event.target.value)}>{shells.map((shell) => <option value={shell.id} key={shell.id}>{shell.label}</option>)}</select></div>
          <div className="settings-row"><label>{copy.cursorShape}</label><select aria-label={copy.cursorShape} value={settings.cursorStyle} onChange={(event) => update("cursorStyle", event.target.value as AppSettings["cursorStyle"])}><option value="bar">{copy.cursorBar}</option><option value="block">{copy.cursorBlock}</option><option value="underline">{copy.cursorUnderline}</option></select></div>
          <Toggle label={copy.cursorBlink} checked={settings.cursorBlink} onChange={(value) => update("cursorBlink", value)} />
          <Toggle label={copy.terminalBell} checked={settings.bellSound} onChange={(value) => update("bellSound", value)} />
          <Toggle label={copy.loadPowerShellProfile} checked={settings.loadShellProfile} onChange={(value) => update("loadShellProfile", value)} />
          <Toggle label={copy.completions} checked={settings.completionEnabled} onChange={(value) => update("completionEnabled", value)} />
          <Toggle label={copy.copyOnSelect} checked={settings.copyOnSelect} onChange={(value) => update("copyOnSelect", value)} />
          <Toggle label={copy.powerlinePrompt} checked={settings.powerlinePrompt} onChange={(value) => update("powerlinePrompt", value)} />
          <Toggle label={copy.restoreTabs} checked={settings.restoreTerminalTabs} onChange={(value) => update("restoreTerminalTabs", value)} />
        </section>
        <section>
          <h2>{copy.cliTools}</h2>
          <div className="builtin-tool-grid">{cliTools.filter((tool) => tool.builtIn).map((tool) => { const brand = (["codex", "claude"] as BrandIconName[]).find((name) => tool.id.includes(name)); return <div key={tool.id}>{brand ? <BrandIcon brand={brand} size={14} /> : null}<span className="builtin-tool-copy"><strong>{tool.name}</strong><small>{tool.available ? tool.executable : tool.installCommand}</small></span><i className={`tool-status ${tool.available ? "online" : "offline"}`} /></div>; })}</div>
          <div className="custom-cli-list">{settings.cliProfiles.map((profile) => <CliProfileEditor copy={copy} profile={profile} onSave={saveProfile} onDelete={() => update("cliProfiles", settings.cliProfiles.filter((item) => item.id !== profile.id))} key={profile.id} />)}</div>
          <div className="custom-cli-add"><input value={newName} placeholder={copy.toolName} onChange={(event) => setNewName(event.target.value)} /><input value={newCommand} placeholder={copy.executable} onChange={(event) => setNewCommand(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") addProfile(); }} /><button disabled={!newName.trim() || !newCommand.trim()} onClick={addProfile}><Plus size={13} />{copy.add}</button></div>
        </section>
        <section>
          <h2>{copy.aiIntegration}</h2>
          <div className="cli-lifecycle-setting">
            <div className="cli-lifecycle-heading"><BellRing size={15} /><span><strong>{copy.lifecycleTitle}</strong><small>{copy.lifecycleDetail}</small></span></div>
            <label className="settings-toggle cli-lifecycle-toggle">
              <span>{cliLifecycleBusy ? copy.updating : cliLifecycleStatus?.enabled ? copy.enabled : copy.disabled}</span>
              <input aria-label={copy.lifecycleTitle} type="checkbox" checked={cliLifecycleStatus?.enabled === true} disabled={cliLifecycleBusy || cliLifecycleStatus?.supported === false} onChange={onCliLifecycleToggle} />
              {cliLifecycleBusy && <LoaderCircle className="spin" size={11} />}
              <i />
            </label>
            <div className="cli-lifecycle-integrations">
              {(cliLifecycleStatus?.integrations ?? []).map((integration) => (
                <div key={integration.id} title={integration.error || integration.configPath}>
                  <span className={`tool-status ${integration.installed ? "online" : "offline"}`} />
                  <span><strong>{integration.label}</strong><small>{integration.error || (integration.installed ? copy.connected : copy.notConfigured)}</small></span>
                </div>
              ))}
            </div>
            {cliLifecycleStatus?.error && <p className="cli-lifecycle-error">{cliLifecycleStatus.error}</p>}
          </div>
        </section>
        <section>
          <h2>{copy.interaction}</h2>
          <Toggle label={copy.resizablePanels} checked={settings.resizablePanels} onChange={(value) => update("resizablePanels", value)} />
          <Toggle label={copy.quickTerminal} checked={settings.quickTerminal} onChange={(value) => update("quickTerminal", value)} />
          <Toggle label={copy.completionNotifications} checked={settings.notifyOnCompletion} onChange={(value) => update("notifyOnCompletion", value)} />
          <div className="settings-row"><label>{copy.closeWindow}</label><select value={settings.closeBehavior} onChange={(event) => update("closeBehavior", event.target.value as AppSettings["closeBehavior"])}><option value="tray">{copy.keepRunning}</option><option value="quit">{copy.quitApplication}</option></select></div>
        </section>
      </div>
    </section>
  );
}

function CliProfileEditor({ copy, profile, onSave, onDelete }: { copy: ReturnType<typeof getSettingsCopy>; profile: CliProfile; onSave(profile: CliProfile): void; onDelete(): void }) {
  const [name, setName] = useState(profile.name);
  const [command, setCommand] = useState(profile.command);
  const [args, setArgs] = useState(profile.args.join("\n"));
  const [cwd, setCwd] = useState(profile.cwd || "");
  const valid = Boolean(name.trim() && command.trim() && !/[\r\n]/.test(command));
  return <div className="custom-cli-editor">
    <input aria-label={copy.profileName} value={name} placeholder={copy.name} onChange={(event) => setName(event.target.value)} />
    <input aria-label={copy.profileExecutable} value={command} placeholder={copy.executablePath} onChange={(event) => setCommand(event.target.value)} />
    <textarea aria-label={copy.profileArguments} value={args} placeholder={copy.argumentsHint} onChange={(event) => setArgs(event.target.value)} />
    <input aria-label={copy.profileCwd} value={cwd} placeholder={copy.cwdHint} onChange={(event) => setCwd(event.target.value)} />
    <div className="custom-cli-actions"><button title={copy.saveProfile} disabled={!valid} onClick={() => onSave({ ...profile, name: name.trim(), command: command.trim(), args: args.split(/\r?\n/).filter(Boolean), cwd: cwd.trim() || undefined })}><Check size={13} /></button><button title={copy.deleteProfile} onClick={onDelete}><Trash2 size={13} /></button></div>
  </div>;
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange(value: boolean): void }) {
  return <label className="settings-toggle"><span>{label}</span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><i /></label>;
}
