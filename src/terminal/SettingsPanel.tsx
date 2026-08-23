import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { BellRing, Check, Image, LoaderCircle, Plus, RotateCcw, Settings2, Trash2, X } from "lucide-react";
import BrandIcon, { type BrandIconName } from "../BrandIcon";
import { chordFromEvent, isModifierOnly, KEYBINDING_ACTIONS } from "../keybindings";
import type { AppSettings, CliLifecycleStatus, CliProfile, CliToolInfo, KeybindingAction, ShellProfile, TerminalThemeName } from "../types";
import { DEFAULT_KEYBINDINGS } from "../types";
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
  const recordKeybinding = (action: KeybindingAction, chord: string) => update("keybindings", { ...settings.keybindings, [action]: chord });
  const resetKeybinding = (action: KeybindingAction) => update("keybindings", { ...settings.keybindings, [action]: DEFAULT_KEYBINDINGS[action] });
  const resetAllKeybindings = () => update("keybindings", { ...DEFAULT_KEYBINDINGS });
  const addProfile = () => {
    const name = newName.trim();
    const command = newCommand.trim();
    if (!name || !command) return;
    update("cliProfiles", [...settings.cliProfiles, { id: `custom:${crypto.randomUUID()}`, name, command, args: [], icon: "terminal" }]);
    setNewName("");
    setNewCommand("");
  };
  const fontFamilies = settings.fontFamily.split(",").map((item) => item.trim()).filter(Boolean);
  const removeFontFamily = (index: number) => update("fontFamily", fontFamilies.filter((_, item) => item !== index).join(", "));
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
          <div className="settings-row color-picker-row"><label>{copy.backgroundCustomColor}</label><HsvPicker copy={copy} value={settings.backgroundColor} onChange={(color) => update("backgroundColor", color)} onReset={() => update("backgroundColor", undefined)} /></div>
          <div className="settings-row color-picker-row"><label>{copy.accentColor}</label><HsvPicker copy={copy} value={settings.accentColor} onChange={(color) => update("accentColor", color)} onReset={() => update("accentColor", undefined)} /></div>
          <div className="settings-row">
            <label>{copy.language}</label>
            <select aria-label={copy.language} value={settings.language} onChange={(event) => update("language", event.target.value as AppSettings["language"])}><option value="system">{copy.followSystem}</option><option value="zh-CN">简体中文</option><option value="en-US">English</option></select>
          </div>
          <div className="settings-row">
            <label>{copy.density}</label>
            <select aria-label={copy.density} value={settings.density} onChange={(event) => update("density", event.target.value as AppSettings["density"])}><option value="compact">{copy.densityCompact}</option><option value="normal">{copy.densityNormal}</option><option value="comfortable">{copy.densityComfortable}</option></select>
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
          <div className="settings-row"><label>{copy.newTabPlacement}</label><select aria-label={copy.newTabPlacement} value={settings.newTabPlacement} onChange={(event) => update("newTabPlacement", event.target.value as AppSettings["newTabPlacement"])}><option value="after-active">{copy.afterActiveTab}</option><option value="end">{copy.appendToEnd}</option></select></div>
          <div className="settings-row"><label>{copy.tabPosition}</label><select aria-label={copy.tabPosition} value={settings.tabPosition} onChange={(event) => update("tabPosition", event.target.value as AppSettings["tabPosition"])}><option value="side">{copy.tabPositionSide}</option><option value="top">{copy.tabPositionTop}</option><option value="both">{copy.tabPositionBoth}</option></select></div>
          <div className="settings-row"><label>{copy.cursorShape}</label><select aria-label={copy.cursorShape} value={settings.cursorStyle} onChange={(event) => update("cursorStyle", event.target.value as AppSettings["cursorStyle"])}><option value="bar">{copy.cursorBar}</option><option value="block">{copy.cursorBlock}</option><option value="underline">{copy.cursorUnderline}</option></select></div>
          <Toggle label={copy.cursorBlink} checked={settings.cursorBlink} onChange={(value) => update("cursorBlink", value)} />
          <div className="settings-row font-family-row">
            <label>{copy.fontFamily}</label>
            <div className="font-family-editor">
              <input aria-label={copy.fontFamily} value={settings.fontFamily} placeholder={copy.fontFamilyPlaceholder} onChange={(event) => update("fontFamily", event.target.value)} />
              {fontFamilies.length > 0 && (
                <div className="font-chips" role="list">
                  {fontFamilies.map((family, index) => (
                    <span className="font-chip" role="listitem" key={`${index}-${family}`}>
                      <span className="font-chip-sample" style={{ fontFamily: family }}>Ag 永 0123</span>
                      <span className="font-chip-name" style={{ fontFamily: family }}>{family}</span>
                      <button type="button" className="font-chip-remove" title={`${copy.removeFont} ${family}`} aria-label={`${copy.removeFont} ${family}`} onClick={() => removeFontFamily(index)}><X size={10} /></button>
                    </span>
                  ))}
                </div>
              )}
              {fontFamilies.length > 1 && <small className="font-fallback-hint">{copy.fontFallbackHint}</small>}
            </div>
          </div>
          <div className="settings-row"><label>{copy.bellMode}</label><select aria-label={copy.bellMode} value={settings.bellMode} onChange={(event) => update("bellMode", event.target.value as AppSettings["bellMode"])}><option value="off">{copy.bellModeOff}</option><option value="flash">{copy.bellModeFlash}</option><option value="sound">{copy.bellModeSound}</option><option value="both">{copy.bellModeBoth}</option></select></div>
          <Toggle label={copy.loadPowerShellProfile} checked={settings.loadShellProfile} onChange={(value) => update("loadShellProfile", value)} />
          <Toggle label={copy.completions} checked={settings.completionEnabled} onChange={(value) => update("completionEnabled", value)} />
          <div className="settings-row"><label>{copy.completionStyle}</label><select aria-label={copy.completionStyle} value={settings.completionStyle} onChange={(event) => update("completionStyle", event.target.value as AppSettings["completionStyle"])}><option value="inline">{copy.completionInline}</option><option value="popup">{copy.completionPopup}</option></select></div>
          <div className="settings-row"><label>{copy.cellWidth}</label><select aria-label={copy.cellWidth} value={settings.cellWidth} onChange={(event) => update("cellWidth", event.target.value as AppSettings["cellWidth"])}><option value="compact">{copy.cellWidthCompact}</option><option value="relaxed">{copy.cellWidthRelaxed}</option></select></div>
          <Toggle label={copy.copyOnSelect} checked={settings.copyOnSelect} onChange={(value) => update("copyOnSelect", value)} />
          <Toggle label={copy.powerlinePrompt} checked={settings.powerlinePrompt} onChange={(value) => update("powerlinePrompt", value)} />
          <Toggle label={copy.restoreTabs} checked={settings.restoreTerminalTabs} onChange={(value) => update("restoreTerminalTabs", value)} />
          <Toggle label={copy.resumeAiSessions} checked={settings.resumeAiSessions} onChange={(value) => update("resumeAiSessions", value)} />
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
          <Toggle label={copy.shellStartupIntegration} checked={settings.shellStartupIntegration} onChange={(value) => update("shellStartupIntegration", value)} />
          <Toggle label={copy.completionNotifications} checked={settings.notifyOnCompletion} onChange={(value) => update("notifyOnCompletion", value)} />
          <div className="settings-row"><label>{copy.closeWindow}</label><select value={settings.closeBehavior} onChange={(event) => update("closeBehavior", event.target.value as AppSettings["closeBehavior"])}><option value="tray">{copy.keepRunning}</option><option value="quit">{copy.quitApplication}</option></select></div>
        </section>
        <section>
          <h2>{copy.proxy}</h2>
          <div className="settings-row"><label>{copy.proxyUrl}</label><input aria-label={copy.proxyUrl} type="text" value={settings.proxyUrl} placeholder={copy.proxyUrlPlaceholder} onChange={(event) => update("proxyUrl", event.target.value)} /></div>
          <div className="settings-row"><label>{copy.proxyBypass}</label><input aria-label={copy.proxyBypass} type="text" value={settings.proxyBypass} placeholder={copy.proxyBypassPlaceholder} onChange={(event) => update("proxyBypass", event.target.value)} /></div>
          <p className="settings-hint">{copy.proxyHint}</p>
        </section>
        <section>
          <h2>{copy.keybindings}</h2>
          <p className="settings-hint">{copy.keybindingsHint}</p>
          <div className="keybinding-list">
            {KEYBINDING_ACTIONS.map((action) => (
              <KeybindingRow
                key={action}
                action={action}
                chord={settings.keybindings[action]}
                label={copy.keybindingActions[action]}
                hint={action === "quick-terminal" ? copy.quickTerminalGlobalHint : undefined}
                copy={copy}
                onRecord={recordKeybinding}
                onReset={resetKeybinding}
              />
            ))}
          </div>
          <div className="keybinding-list-footer">
            <button className="keybinding-reset" onClick={resetAllKeybindings}><RotateCcw size={12} />{copy.resetAllKeybindings}</button>
          </div>
        </section>
      </div>
    </section>
  );
}

function KeybindingRow({ action, chord, label, hint, copy, onRecord, onReset }: {
  action: KeybindingAction;
  chord: string;
  label: string;
  hint?: string;
  copy: ReturnType<typeof getSettingsCopy>;
  onRecord(action: KeybindingAction, chord: string): void;
  onReset(action: KeybindingAction): void;
}) {
  const [recording, setRecording] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const begin = () => { setRecording(true); buttonRef.current?.focus(); };
  const cancel = () => setRecording(false);
  return (
    <div className="keybinding-row">
      <span className="keybinding-label"><strong>{label}</strong>{hint && <small>{hint}</small>}</span>
      <span className="keybinding-controls">
        <button
          ref={buttonRef}
          className={`keybinding-record${recording ? " recording" : ""}`}
          onClick={begin}
          onBlur={cancel}
          onKeyDown={(event) => {
            if (event.key === "Escape" || (event.key === "Tab" && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey)) {
              event.preventDefault();
              event.stopPropagation();
              cancel();
              return;
            }
            if (isModifierOnly(event.nativeEvent)) { event.preventDefault(); return; }
            event.preventDefault();
            event.stopPropagation();
            setRecording(false);
            onRecord(action, chordFromEvent(event.nativeEvent));
          }}
        >
          {recording ? copy.recordingKeybinding : <kbd>{chord}</kbd>}
        </button>
        <button className="keybinding-reset-one" title={copy.resetAllKeybindings} onClick={() => onReset(action)}><RotateCcw size={12} /></button>
      </span>
    </div>
  );
}

function hexToHsv(hex: string): { h: number; s: number; v: number } {
  const match = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!match) return { h: 220, s: 0.3, v: 0.18 };
  const value = parseInt(match[1], 16);
  const r = ((value >> 16) & 255) / 255;
  const g = ((value >> 8) & 255) / 255;
  const b = (value & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let h = 0;
  if (delta !== 0) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : delta / max, v: max };
}

function hsvToHex(h: number, s: number, v: number): string {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  const toHex = (channel: number) => Math.round((channel + m) * 255).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function HsvPicker({ copy, value, onChange, onReset }: {
  copy: ReturnType<typeof getSettingsCopy>;
  value?: string;
  onChange(color: string): void;
  onReset(): void;
}) {
  const initial = hexToHsv(value || "#78aee8");
  const [hue, setHue] = useState(initial.h);
  const [sat, setSat] = useState(initial.s);
  const [val, setVal] = useState(initial.v);
  const [draft, setDraft] = useState(value || "");
  const squareRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const next = hexToHsv(value || "#78aee8");
    setHue(next.h);
    setSat(next.s);
    setVal(next.v);
    setDraft(value || "");
  }, [value]);
  const color = value || hsvToHex(hue, sat, val);
  const pickSquare = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = squareRef.current?.getBoundingClientRect();
    if (!rect) return;
    const s = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const v = Math.min(1, Math.max(0, 1 - (event.clientY - rect.top) / rect.height));
    setSat(s);
    setVal(v);
    onChange(hsvToHex(hue, s, v));
  };
  const pickHue = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = hueRef.current?.getBoundingClientRect();
    if (!rect) return;
    const h = Math.min(360, Math.max(0, ((event.clientX - rect.left) / rect.width) * 360));
    setHue(h);
    onChange(hsvToHex(h, sat, val));
  };
  return (
    <div className="hsv-picker">
      <div
        className="hsv-square"
        ref={squareRef}
        style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hue} 100% 50%))` }}
        onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); pickSquare(event); }}
        onPointerMove={(event) => { if (event.buttons === 1) pickSquare(event); }}
      >
        <i style={{ left: `${sat * 100}%`, top: `${(1 - val) * 100}%`, background: color }} />
      </div>
      <div
        className="hsv-hue"
        ref={hueRef}
        style={{ background: "linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)" }}
        onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); pickHue(event); }}
        onPointerMove={(event) => { if (event.buttons === 1) pickHue(event); }}
      >
        <i style={{ left: `${(hue / 360) * 100}%` }} />
      </div>
      <div className="hsv-footer">
        <span className="hsv-swatch" style={{ background: color }} />
        <input
          value={draft}
          aria-label={copy.hexColor}
          placeholder="#RRGGBB"
          spellCheck={false}
          onChange={(event) => {
            setDraft(event.target.value);
            const next = event.target.value.trim();
            if (/^#[0-9a-fA-F]{6}$/.test(next)) onChange(next.toLowerCase());
          }}
          onBlur={() => setDraft(value || "")}
        />
        {value && <button title={copy.resetColor} onClick={onReset}><RotateCcw size={12} /></button>}
      </div>
    </div>
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
