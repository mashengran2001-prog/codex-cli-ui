import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Activity, BellRing, Brain, Check, CheckCircle2, ChevronDown, Command, Download, ExternalLink, FileCode2, FolderOpen, Globe, Image, Keyboard, LoaderCircle, MousePointerClick, Package, Palette, Pencil, Plug, Plus, RotateCcw, Search, Server, Shield, TerminalSquare, Trash2, Undo2, X, type LucideIcon } from "lucide-react";
import BrandIcon, { type BrandIconName } from "../BrandIcon";
import { chordFromEvent, isModifierOnly, modifierPrefix, setKeybindingCaptureActive } from "../keybindings";
import type { AppSettings, BackupPreview, BackupResult, BackupSelection, CliLifecycleStatus, CliProfile, CliToolInfo, DiagnosticsInfo, KeybindingAction, LatencyProbeResult, ShellProfile, SshProfile, TerminalThemeName, ImportedFontInfo, ImportFontResult, SettingsUpdateState } from "../types";
import { DEFAULT_KEYBINDINGS } from "../types";
import { getSettingsCopy } from "../i18n";
import { registerImportedFontFaces } from "../importedFonts";
import { terminalThemes } from "./themes";
import SshEditor from "./SshEditor";

const KEYMAP_GROUPS: { id: "global" | "tabs" | "panes"; actions: KeybindingAction[] }[] = [
  { id: "global", actions: ["quick-terminal", "command-palette", "open-settings"] },
  { id: "tabs", actions: ["new-terminal"] },
  { id: "panes", actions: ["split-right", "split-down", "pane-next", "pane-prev"] },
];

const KEYMAP_ORDER: KeybindingAction[] = KEYMAP_GROUPS.flatMap((group) => group.actions);

const KEYBINDING_NAMES_EN: Record<KeybindingAction, string> = {
  "quick-terminal": "Quick terminal",
  "command-palette": "Command palette",
  "open-settings": "Open settings",
  "new-terminal": "New terminal",
  "split-right": "Split right",
  "split-down": "Split down",
  "pane-next": "Focus next pane",
  "pane-prev": "Focus previous pane",
};

function keycapChips(chord: string): ReactNode[] {
  const labels = chord.split("+").filter((label) => label.length > 0);
  const chips: ReactNode[] = [];
  labels.forEach((label, index) => {
    if (index > 0) chips.push(<i className="keycap-sep" key={`sep-${index}`} aria-label="+">+</i>);
    chips.push(<kbd className="keycap" key={label}>{label}</kbd>);
  });
  return chips;
}

interface SettingsPanelProps {
  settings: AppSettings;
  shells: ShellProfile[];
  cliTools: CliToolInfo[];
  cliLifecycleStatus: CliLifecycleStatus | null;
  cliLifecycleBusy: boolean;
  onChange(settings: AppSettings): void;
  onCliLifecycleToggle(): void;
  onConnectSsh?(profile: SshProfile): void;
  update: SettingsUpdateState;
  onUpdateAction(action: "check" | "download" | "install" | "package"): void;
  onClose(): void;
}

function formatDuration(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** index;
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

export default function SettingsPanel({ settings, shells, cliTools, cliLifecycleStatus, cliLifecycleBusy, onChange, onCliLifecycleToggle, onConnectSsh, update: updateInfo, onUpdateAction, onClose }: SettingsPanelProps) {
  const [newName, setNewName] = useState("");
  const [newCommand, setNewCommand] = useState("");
  const copy = getSettingsCopy(settings.language);
  const update = <Key extends keyof AppSettings>(key: Key, value: AppSettings[Key]) => onChange({ ...settings, [key]: value });
  const [defaultSettings, setDefaultSettings] = useState<Partial<AppSettings> | null>(null);
  useEffect(() => {
    let cancelled = false;
    void window.codex.getDefaultSettings().then((next) => { if (!cancelled) setDefaultSettings(next); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);
  const modifiedKeys = useMemo(() => {
    const changed = new Set<string>();
    if (!defaultSettings) return changed;
    const allKeys = new Set<string>([...Object.keys(defaultSettings), ...Object.keys(settings as unknown as Record<string, unknown>)]);
    const norm = (value: unknown) => (value === undefined ? null : value);
    for (const key of allKeys) {
      if (key === "cliProfiles" || key === "keybindings") continue;
      const current = (settings as unknown as Record<string, unknown>)[key];
      const def = (defaultSettings as Record<string, unknown>)[key];
      if (JSON.stringify(norm(current)) !== JSON.stringify(norm(def))) changed.add(key);
    }
    return changed;
  }, [defaultSettings, settings]);
  const isModified = (key: string) => modifiedKeys.has(key);
  const Mod = ({ k }: { k: string }) => (isModified(k) ? <span className="settings-modified-dot" data-key={k} title={copy.settingModified} /> : null);
  const saveProfile = (next: CliProfile) => update("cliProfiles", settings.cliProfiles.map((profile) => profile.id === next.id ? next : profile));
  const recordKeybinding = (action: KeybindingAction, chord: string) => update("keybindings", { ...settings.keybindings, [action]: chord });
  const resetKeybinding = (action: KeybindingAction) => update("keybindings", { ...settings.keybindings, [action]: DEFAULT_KEYBINDINGS[action] });
  const resetAllKeybindings = () => update("keybindings", { ...DEFAULT_KEYBINDINGS });
  const [keymapQuery, setKeymapQuery] = useState("");
  const [keymapCapture, setKeymapCapture] = useState<KeybindingAction | null>(null);
  const [sshHosts, setSshHosts] = useState<SshProfile[]>([]);
  const [sshEditor, setSshEditor] = useState<SshProfile | "new">();
  const [sshDeleteConfirm, setSshDeleteConfirm] = useState<string>();
  const [sshUndo, setSshUndo] = useState<{ host: SshProfile; seq: number }>();
  const [sshStatus, setSshStatus] = useState<{ message: string; error?: boolean }>();
  const [profilePath, setProfilePath] = useState<string | null>(null);
  const [profileError, setProfileError] = useState(false);
  const [importedFonts, setImportedFonts] = useState<ImportedFontInfo[]>([]);
  const [fontImportStatus, setFontImportStatus] = useState<{ message: string; error?: boolean }>();
  const [fontImportBusy, setFontImportBusy] = useState(false);
  const [backupSelection, setBackupSelection] = useState<BackupSelection>({ appearance: true, config: false, ssh: false, session: false, directory_history: false, command_history: false, fonts: false });
  const [backupPassphrase, setBackupPassphrase] = useState("");
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupStatus, setBackupStatus] = useState<{ message: string; error?: boolean }>();
  const [backupPreview, setBackupPreview] = useState<BackupPreview | null>(null);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsInfo | null>(null);
  const [latency, setLatency] = useState<LatencyProbeResult | null>(null);
  const [latencyBusy, setLatencyBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void window.codex.getDiagnosticsInfo()
      .then((next) => { if (!cancelled) setDiagnostics(next); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  const measureLatency = async () => {
    setLatencyBusy(true);
    setLatency(null);
    try {
      setLatency(await window.codex.probeInputLatency());
    } catch (error) {
      setLatency({ ok: false, error: error instanceof Error ? error.message : String(error) });
    } finally {
      setLatencyBusy(false);
    }
  };
  const refreshSshHosts = useCallback(() => {
    void window.codex.listSshProfiles()
      .then(setSshHosts)
      .catch(() => setSshStatus({ message: copy.loadSshFailed, error: true }));
  }, [copy.loadSshFailed]);
  useEffect(() => { refreshSshHosts(); }, [refreshSshHosts]);
  useEffect(() => {
    let cancelled = false;
    void window.codex.getShellProfilePath(settings.defaultShellId)
      .then((path) => { if (!cancelled) { setProfilePath(path); setProfileError(false); } })
      .catch(() => { if (!cancelled) { setProfilePath(null); setProfileError(false); } });
    return () => { cancelled = true; };
  }, [settings.defaultShellId]);
  const openShellProfile = async (shellId: string) => {
    setProfileError(false);
    const ok = await window.codex.openShellProfile(shellId).catch(() => false);
    setProfileError(!ok);
  };
  const refreshImportedFonts = useCallback(async () => {
    const fonts = await window.codex.listImportedFonts().catch<ImportedFontInfo[]>(() => []);
    setImportedFonts(fonts);
    registerImportedFontFaces(fonts);
  }, []);
  useEffect(() => { void refreshImportedFonts(); }, [refreshImportedFonts]);
  const importFont = async () => {
    setFontImportBusy(true);
    setFontImportStatus(undefined);
    const result = await window.codex.importFont().catch<ImportFontResult>(() => ({ ok: false, error: copy.importFontFailed }));
    if (result.ok && result.family) {
      await refreshImportedFonts();
      setFontImportStatus({ message: copy.importFontSuccess(result.family) });
    } else {
      setFontImportStatus({ message: result.error || copy.importFontFailed, error: true });
    }
    setFontImportBusy(false);
  };
  const BACKUP_CATEGORY_ROWS: Array<{ key: keyof BackupSelection; label: string }> = [
    { key: "appearance", label: copy.backupAppearance },
    { key: "config", label: copy.backupConfig },
    { key: "ssh", label: copy.backupSsh },
    { key: "session", label: copy.backupSession },
    { key: "directory_history", label: copy.backupDirectoryHistory },
    { key: "command_history", label: copy.backupCommandHistory },
    { key: "fonts", label: copy.backupFonts },
  ];
  const exportBackup = async () => {
    if (backupBusy) return;
    if (backupPassphrase.length < 8) { setBackupStatus({ message: copy.backupPassphraseTooShort, error: true }); return; }
    if (!Object.values(backupSelection).some(Boolean)) { setBackupStatus({ message: copy.backupSelectAtLeastOne, error: true }); return; }
    setBackupBusy(true);
    setBackupStatus(undefined);
    const result = await window.codex.exportBackup(backupSelection, backupPassphrase).catch<BackupResult>(() => ({ ok: false, message: copy.backupCanceled, error: copy.backupCanceled }));
    setBackupBusy(false);
    if (result.ok) setBackupStatus({ message: result.message || copy.backupExportSuccess });
    else setBackupStatus({ message: result.error || result.message || copy.backupCanceled, error: true });
  };
  const previewBackupFile = async () => {
    if (backupBusy) return;
    if (backupPassphrase.length < 8) { setBackupStatus({ message: copy.backupPassphraseTooShort, error: true }); return; }
    setBackupBusy(true);
    setBackupStatus(undefined);
    setBackupPreview(null);
    const result = await window.codex.previewBackup(backupPassphrase).catch<BackupPreview>(() => ({ ok: false, error: copy.backupCanceled }));
    setBackupBusy(false);
    if (result.ok) setBackupPreview(result);
    else setBackupStatus({ message: result.error || result.message || copy.backupCanceled, error: true });
  };
  const confirmRestore = async () => {
    if (backupBusy || !backupPreview?.filePath) return;
    setBackupBusy(true);
    setBackupStatus(undefined);
    const result = await window.codex.restoreBackup(backupPassphrase, backupPreview.filePath).catch<BackupResult>(() => ({ ok: false, message: copy.backupCanceled, error: copy.backupCanceled }));
    setBackupBusy(false);
    setBackupPreview(null);
    if (result.ok) {
      setBackupStatus({ message: result.message || copy.backupRestoreSuccess });
      const restored = await window.codex.getAppSettings().catch(() => null);
      if (restored) onChange(restored);
    } else {
      setBackupStatus({ message: result.error || result.message || copy.backupRestoreFailed, error: true });
    }
  };
  const removeImportedFont = async (fileName: string) => {
    const removed = await window.codex.deleteImportedFont(fileName).catch(() => false);
    if (removed) await refreshImportedFonts();
  };
  useEffect(() => {
    if (!sshUndo) return;
    const timer = window.setTimeout(() => {
      setSshUndo(undefined);
      void window.codex.deleteSshProfile(sshUndo.host.id).then((removed) => { if (removed) refreshSshHosts(); });
    }, 8000);
    return () => window.clearTimeout(timer);
  }, [refreshSshHosts, sshUndo]);
  const deleteSshHost = (profile: SshProfile) => {
    if (sshDeleteConfirm !== profile.id) { setSshDeleteConfirm(profile.id); return; }
    setSshDeleteConfirm(undefined);
    setSshHosts((current) => current.filter((item) => item.id !== profile.id));
    setSshUndo({ host: profile, seq: Date.now() });
  };
  const undoDeleteSshHost = () => {
    const undo = sshUndo;
    if (!undo) return;
    setSshHosts((current) => [undo.host, ...current.filter((item) => item.id !== undo.host.id)]);
    setSshUndo(undefined);
    setSshStatus({ message: copy.restoredHost(undo.host.name) });
  };
  const importSshConfig = async () => {
    try {
      const hosts = await window.codex.listSshProfiles();
      setSshHosts(hosts);
      const count = hosts.filter((item) => item.source === "ssh-config").length;
      setSshStatus({ message: copy.importedConfig(count) });
    } catch {
      setSshStatus({ message: copy.loadSshFailed, error: true });
    }
  };

  const [keymapCapturePreview, setKeymapCapturePreview] = useState("");
  const keymapVisible = useMemo(() => {
    const query = keymapQuery.trim().toLocaleLowerCase();
    if (!query) return new Set(KEYMAP_ORDER);
    return new Set(KEYMAP_ORDER.filter((action) => {
      const haystack = `${copy.keybindingActions[action]} ${KEYBINDING_NAMES_EN[action]} ${settings.keybindings[action] ?? ""}`.toLocaleLowerCase();
      return haystack.includes(query);
    }));
  }, [keymapQuery, settings.keybindings, copy]);
  const keymapClash = useMemo(() => {
    const rows = new Set<KeybindingAction>();
    let note: string | null = null;
    for (let a = 0; a < KEYMAP_ORDER.length; a += 1) {
      const comboA = settings.keybindings[KEYMAP_ORDER[a]] ?? "";
      if (!comboA) continue;
      for (let b = a + 1; b < KEYMAP_ORDER.length; b += 1) {
        const comboB = settings.keybindings[KEYMAP_ORDER[b]] ?? "";
        if (!comboB || comboA.toLocaleLowerCase() !== comboB.toLocaleLowerCase()) continue;
        rows.add(KEYMAP_ORDER[a]);
        rows.add(KEYMAP_ORDER[b]);
        if (!note) {
          note = copy.keymapConflictNote
            .replace("{combo}", comboA)
            .replace("{a}", copy.keybindingActions[KEYMAP_ORDER[a]])
            .replace("{b}", copy.keybindingActions[KEYMAP_ORDER[b]]);
        }
      }
    }
    return { rows, note };
  }, [settings.keybindings, copy]);
  useEffect(() => {
    if (!keymapCapture) return;
    setKeybindingCaptureActive(true);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" || (event.key === "Tab" && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey)) {
        event.preventDefault();
        event.stopPropagation();
        setKeymapCapture(null);
        setKeymapCapturePreview("");
        return;
      }
      if (event.key === "Backspace") {
        event.preventDefault();
        event.stopPropagation();
        setKeymapCapture(null);
        setKeymapCapturePreview("");
        resetKeybinding(keymapCapture);
        return;
      }
      if (isModifierOnly(event)) {
        event.preventDefault();
        setKeymapCapturePreview(modifierPrefix(event));
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      recordKeybinding(keymapCapture, chordFromEvent(event));
      setKeymapCapture(null);
      setKeymapCapturePreview("");
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Control" || event.key === "Alt" || event.key === "Shift" || event.key === "Meta") setKeymapCapturePreview("");
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      setKeybindingCaptureActive(false);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
    // recordKeybinding/resetKeybinding 每次渲染都会重建，这里只需本次渲染的 settings 闭包。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keymapCapture, settings.keybindings]);
  const addProfile = () => {
    const name = newName.trim();
    const command = newCommand.trim();
    if (!name || !command) return;
    update("cliProfiles", [...settings.cliProfiles, { id: `custom:${crypto.randomUUID()}`, name, command, args: [], icon: "terminal" }]);
    setNewName("");
    setNewCommand("");
  };
  const sections: Array<{ id: string; label: string }> = [
    { id: "settings-appearance", label: copy.appearance },
    { id: "settings-terminal", label: copy.terminal },
    { id: "settings-cli", label: copy.cliTools },
    { id: "settings-ssh", label: copy.ssh },
    { id: "settings-ai", label: copy.aiIntegration },
    { id: "settings-interaction", label: copy.interaction },
    { id: "settings-proxy", label: copy.proxy },
    { id: "settings-keybindings", label: copy.keybindings },
    { id: "settings-backup", label: copy.backup },
  ];
  const [activeSection, setActiveSection] = useState("settings-appearance");
  const settingsScrollRef = useRef<HTMLDivElement>(null);
  const updateActiveSection = () => {
    const container = settingsScrollRef.current;
    if (!container) return;
    const items = container.querySelectorAll<HTMLElement>("section[id^=\"settings-\"]");
    let current = items[0]?.id ?? "settings-appearance";
    const containerTop = container.getBoundingClientRect().top;
    for (const item of items) {
      if (item.getBoundingClientRect().top - containerTop <= 10) current = item.id;
    }
    setActiveSection(current);
  };
  const jumpToSection = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setActiveSection(id);
  };
  const navIcons: Record<string, LucideIcon> = {
    "settings-appearance": Palette,
    "settings-terminal": TerminalSquare,
    "settings-cli": Command,
    "settings-ssh": Server,
    "settings-ai": Brain,
    "settings-interaction": MousePointerClick,
    "settings-proxy": Globe,
    "settings-keybindings": Keyboard,
    "settings-backup": Shield,
  };
  const activeLabel = sections.find((item) => item.id === activeSection)?.label ?? sections[0].label;
  return (
    <section className="terminal-settings">
      <div className="settings-layout">
        <nav className="settings-nav" aria-label={copy.title}>
          <div className="settings-nav-brand">{copy.title}</div>
          {sections.map((item) => {
            const Icon = navIcons[item.id];
            return <button key={item.id} className={activeSection === item.id ? "active" : ""} onClick={() => jumpToSection(item.id)}><Icon size={16} /><span>{item.label}</span></button>;
          })}
        </nav>
        <div className="settings-main">
          <header className="settings-header">
            <strong>{activeLabel}</strong>
            <div className="settings-header-actions">
              {activeSection === "settings-keybindings" && <button title={copy.resetAllKeybindings} onClick={resetAllKeybindings}><RotateCcw size={14} /></button>}
              <button title={copy.close} onClick={onClose}><X size={14} /></button>
            </div>
          </header>
          <div className="settings-scroll" ref={settingsScrollRef} onScroll={updateActiveSection}>
        <section id="settings-appearance">
          <h2>{copy.appearance}</h2><Mod k="theme" />
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
          <div className="settings-row color-picker-row"><label>{copy.backgroundCustomColor}</label><Mod k="backgroundColor" /><HsvPicker copy={copy} value={settings.backgroundColor} onChange={(color) => update("backgroundColor", color)} onReset={() => update("backgroundColor", undefined)} /></div>
          <div className="settings-row color-picker-row"><label>{copy.accentColor}</label><Mod k="accentColor" /><HsvPicker copy={copy} value={settings.accentColor} onChange={(color) => update("accentColor", color)} onReset={() => update("accentColor", undefined)} /></div>
          <div className="settings-row">
            <label>{copy.language}</label><Mod k="language" />
            <select aria-label={copy.language} value={settings.language} onChange={(event) => update("language", event.target.value as AppSettings["language"])}><option value="system">{copy.followSystem}</option><option value="zh-CN">简体中文</option><option value="en-US">English</option></select>
          </div>
          <div className="settings-row">
            <label>{copy.density}</label><Mod k="density" />
            <select aria-label={copy.density} value={settings.density} onChange={(event) => update("density", event.target.value as AppSettings["density"])}><option value="compact">{copy.densityCompact}</option><option value="normal">{copy.densityNormal}</option><option value="comfortable">{copy.densityComfortable}</option></select>
          </div>
          <div className="settings-row">
            <label>{copy.backgroundImage}</label><Mod k="backgroundImage" />
            <div className="settings-inline-actions">
              <button onClick={() => void window.codex.chooseBackgroundImage().then((path) => { if (path) update("backgroundImage", path); })}><Image size={13} />{copy.choose}</button>
              {settings.backgroundImage && <button title={copy.clearBackground} onClick={() => update("backgroundImage", undefined)}><RotateCcw size={13} /></button>}
            </div>
          </div>
          <div className="settings-row range-row"><label>{copy.opacity} <output>{Math.round(settings.backgroundOpacity * 100)}%</output></label><Mod k="backgroundOpacity" /><input type="range" min="35" max="100" value={Math.round(settings.backgroundOpacity * 100)} onChange={(event) => update("backgroundOpacity", Number(event.target.value) / 100)} /></div>
          <Toggle label={copy.backgroundBlur} checked={settings.backgroundBlur} onChange={(value) => update("backgroundBlur", value)} modified={isModified("backgroundBlur")} />
        </section>
          <div className="settings-group-divider" />
        <section id="settings-terminal">
          <h2>{copy.terminal}</h2>
          <div className="settings-row shell-profile-row"><label>{copy.defaultShell}</label><Mod k="defaultShellId" /><select aria-label={copy.defaultShell} value={settings.defaultShellId} onChange={(event) => update("defaultShellId", event.target.value)}>{shells.map((shell) => <option value={shell.id} key={shell.id}>{shell.label}</option>)}</select><button title={profilePath || copy.profileUnavailable} disabled={!profilePath} onClick={() => void openShellProfile(settings.defaultShellId)}><FileCode2 size={12} />{copy.openProfile}</button>{profileError && <small className="settings-update-result error">{copy.profileOpenFailed}</small>}</div>
          <div className="settings-row"><label>{copy.newTabPlacement}</label><Mod k="newTabPlacement" /><select aria-label={copy.newTabPlacement} value={settings.newTabPlacement} onChange={(event) => update("newTabPlacement", event.target.value as AppSettings["newTabPlacement"])}><option value="after-active">{copy.afterActiveTab}</option><option value="end">{copy.appendToEnd}</option></select></div>
          <div className="settings-row"><label>{copy.tabPosition}</label><Mod k="tabPosition" /><select aria-label={copy.tabPosition} value={settings.tabPosition} onChange={(event) => update("tabPosition", event.target.value as AppSettings["tabPosition"])}><option value="side">{copy.tabPositionSide}</option><option value="top">{copy.tabPositionTop}</option></select></div>
          <div className="settings-row"><label>{copy.cursorShape}</label><Mod k="cursorStyle" /><select aria-label={copy.cursorShape} value={settings.cursorStyle} onChange={(event) => update("cursorStyle", event.target.value as AppSettings["cursorStyle"])}><option value="bar">{copy.cursorBar}</option><option value="block">{copy.cursorBlock}</option><option value="underline">{copy.cursorUnderline}</option></select></div>
          <Toggle label={copy.cursorBlink} checked={settings.cursorBlink} onChange={(value) => update("cursorBlink", value)} modified={isModified("cursorBlink")} />
          <div className="settings-row font-family-row">
            <label>{copy.fontFamily}</label><Mod k="fontFamily" />
            <FontPicker copy={copy} imported={importedFonts.map((font) => font.family)} value={settings.fontFamily} onChange={(value) => update("fontFamily", value)} />
            <button className="settings-update-button" disabled={fontImportBusy} onClick={() => void importFont()}><Plus size={12} />{copy.importFont}</button>
          </div>
          {importedFonts.length > 0 ? (
            <div className="settings-imported-fonts">
              <span className="settings-imported-fonts-title">{copy.importedFonts}</span>
              {importedFonts.map((font) => (
                <div className="settings-imported-font" key={font.fileName}>
                  <span className="settings-imported-font-name" style={{ fontFamily: font.family }}>{font.family}</span>
                  <small>{formatBytes(font.size)}</small>
                  <button title={copy.removeImportedFont} aria-label={copy.removeImportedFont} onClick={() => void removeImportedFont(font.fileName)}><Trash2 size={12} /></button>
                </div>
              ))}
            </div>
          ) : null}
          {fontImportStatus ? <p className={`settings-import-font-status ${fontImportStatus.error ? "error" : ""}`}>{fontImportStatus.message}</p> : null}
          <div className="settings-row"><label>{copy.bellMode}</label><Mod k="bellMode" /><select aria-label={copy.bellMode} value={settings.bellMode} onChange={(event) => update("bellMode", event.target.value as AppSettings["bellMode"])}><option value="off">{copy.bellModeOff}</option><option value="flash">{copy.bellModeFlash}</option><option value="sound">{copy.bellModeSound}</option><option value="both">{copy.bellModeBoth}</option></select></div>
          <Toggle label={copy.renderTerminalMath} checked={settings.renderTerminalMath} onChange={(value) => update("renderTerminalMath", value)} modified={isModified("renderTerminalMath")} />
          <p className="settings-hint">{copy.renderTerminalMathHint}</p>
          <Toggle label={copy.builtinBoxDrawing} checked={settings.builtinBoxDrawing} onChange={(value) => update("builtinBoxDrawing", value)} modified={isModified("builtinBoxDrawing")} />
          <p className="settings-hint">{copy.builtinBoxDrawingHint}</p>
          <Toggle label={copy.loadPowerShellProfile} checked={settings.loadShellProfile} onChange={(value) => update("loadShellProfile", value)} modified={isModified("loadShellProfile")} />
          <Toggle label={copy.completions} checked={settings.completionEnabled} onChange={(value) => update("completionEnabled", value)} modified={isModified("completionEnabled")} />
          <div className="settings-row"><label>{copy.completionStyle}</label><Mod k="completionStyle" /><select aria-label={copy.completionStyle} value={settings.completionStyle} onChange={(event) => update("completionStyle", event.target.value as AppSettings["completionStyle"])}><option value="inline">{copy.completionInline}</option><option value="popup">{copy.completionPopup}</option></select></div>
          <div className="settings-row"><label>{copy.cellWidth}</label><Mod k="cellWidth" /><select aria-label={copy.cellWidth} value={settings.cellWidth} onChange={(event) => update("cellWidth", event.target.value as AppSettings["cellWidth"])}><option value="compact">{copy.cellWidthCompact}</option><option value="relaxed">{copy.cellWidthRelaxed}</option></select></div>
          <Toggle label={copy.copyOnSelect} checked={settings.copyOnSelect} onChange={(value) => update("copyOnSelect", value)} modified={isModified("copyOnSelect")} />
          <Toggle label={copy.powerlinePrompt} checked={settings.powerlinePrompt} onChange={(value) => update("powerlinePrompt", value)} modified={isModified("powerlinePrompt")} />
          <Toggle label={copy.restoreTabs} checked={settings.restoreTerminalTabs} onChange={(value) => update("restoreTerminalTabs", value)} modified={isModified("restoreTerminalTabs")} />
          <Toggle label={copy.resumeAiSessions} checked={settings.resumeAiSessions} onChange={(value) => update("resumeAiSessions", value)} modified={isModified("resumeAiSessions")} />
        </section>
          <div className="settings-group-divider" />
        <section id="settings-cli">
          <h2>{copy.cliTools}</h2>
          <div className="builtin-tool-grid">{cliTools.filter((tool) => tool.builtIn).map((tool) => { const brand = (["codex", "claude"] as BrandIconName[]).find((name) => tool.id.includes(name)); return <div key={tool.id}>{brand ? <BrandIcon brand={brand} size={14} /> : null}<span className="builtin-tool-copy"><strong>{tool.name}</strong><small>{tool.available ? tool.executable : tool.installCommand}</small></span><i className={`tool-status ${tool.available ? "online" : "offline"}`} /></div>; })}</div>
          <div className="custom-cli-list">{settings.cliProfiles.map((profile) => <CliProfileEditor copy={copy} profile={profile} onSave={saveProfile} onDelete={() => update("cliProfiles", settings.cliProfiles.filter((item) => item.id !== profile.id))} key={profile.id} />)}</div>
          <div className="custom-cli-add"><input value={newName} placeholder={copy.toolName} onChange={(event) => setNewName(event.target.value)} /><input value={newCommand} placeholder={copy.executable} onChange={(event) => setNewCommand(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") addProfile(); }} /><button disabled={!newName.trim() || !newCommand.trim()} onClick={addProfile}><Plus size={13} />{copy.add}</button></div>
        </section>
        <section id="settings-ssh">
          <h2>{copy.ssh}</h2>
          <div className="settings-ssh-head">
            <strong>{copy.savedHosts}</strong>
            {sshHosts.length > 0 && <span className="settings-ssh-count">{sshHosts.length}</span>}
            <span className="settings-ssh-head-spacer" />
            <button className="settings-ssh-add" onClick={() => setSshEditor("new")}><Plus size={13} />{copy.addHost}</button>
          </div>
          <div className="settings-ssh-card">
            {sshHosts.map((profile) => (
              <div className={"settings-ssh-row" + (sshDeleteConfirm === profile.id ? " confirm" : "")} key={profile.id}>
                <span className="settings-ssh-icon"><Server size={16} /></span>
                <button className="settings-ssh-main" title={copy.connectHost(profile.name)} onClick={() => void onConnectSsh?.(profile)}>
                  <strong>{profile.name}</strong>
                  <small>{profile.username ? profile.username + "@" + profile.host : profile.host}{profile.port && profile.port !== 22 ? " :" + profile.port : ""}{profile.source === "ssh-config" ? " · " + copy.fromConfig : ""}</small>
                </button>
                <span className="settings-ssh-actions">
                  <button title={copy.connectHost(profile.name)} onClick={() => void onConnectSsh?.(profile)}><Plug size={13} /></button>
                  <button title={copy.editHost} onClick={() => setSshEditor(profile)}><Pencil size={13} /></button>
                  <button className={sshDeleteConfirm === profile.id ? "danger" : ""} title={sshDeleteConfirm === profile.id ? copy.confirmDeleteHost : copy.deleteHost} onClick={() => deleteSshHost(profile)}>
                    {sshDeleteConfirm === profile.id ? <Check size={13} /> : <Trash2 size={13} />}
                  </button>
                </span>
              </div>
            ))}
            {sshHosts.length === 0 && (
              <div className="settings-ssh-empty">
                <strong>{copy.emptyHosts}</strong>
                <small>{copy.emptyHostsHint}</small>
              </div>
            )}
          </div>
          <div className="settings-ssh-foot">
            <button onClick={() => void importSshConfig()}><Download size={12} />{copy.importConfig}</button>
            <span>{copy.configHint}</span>
          </div>
          {sshUndo && (
            <div className="ssh-undo-bar">
              <Undo2 size={13} /><span>{copy.deletedUndo(sshUndo.host.name)}</span>
              <button onClick={undoDeleteSshHost}>{copy.undo}</button>
            </div>
          )}
          {sshStatus && <div className={"settings-ssh-status" + (sshStatus.error ? " error" : "")}>{sshStatus.message}</div>}
        </section>
          <div className="settings-group-divider" />
        <section id="settings-ai">
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
          <div className="settings-group-divider" />
        <section id="settings-interaction">
          <h2>{copy.interaction}</h2>
          <Toggle label={copy.resizablePanels} checked={settings.resizablePanels} onChange={(value) => update("resizablePanels", value)} modified={isModified("resizablePanels")} />
          <Toggle label={copy.quickTerminal} checked={settings.quickTerminal} onChange={(value) => update("quickTerminal", value)} modified={isModified("quickTerminal")} />
          <Toggle label={copy.shellStartupIntegration} checked={settings.shellStartupIntegration} onChange={(value) => update("shellStartupIntegration", value)} modified={isModified("shellStartupIntegration")} />
          <Toggle label={copy.completionNotifications} checked={settings.notifyOnCompletion} onChange={(value) => update("notifyOnCompletion", value)} modified={isModified("notifyOnCompletion")} />
          <div className="settings-row"><label>{copy.closeWindow}</label><Mod k="closeBehavior" /><select value={settings.closeBehavior} onChange={(event) => update("closeBehavior", event.target.value as AppSettings["closeBehavior"])}><option value="tray">{copy.keepRunning}</option><option value="quit">{copy.quitApplication}</option></select></div>
        </section>
          <div className="settings-group-divider" />
        <section id="settings-proxy">
          <h2>{copy.proxy}</h2>
          <div className="settings-row"><label>{copy.proxyUrl}</label><Mod k="proxyUrl" /><input aria-label={copy.proxyUrl} type="text" value={settings.proxyUrl} placeholder={copy.proxyUrlPlaceholder} onChange={(event) => update("proxyUrl", event.target.value)} /></div>
          <div className="settings-row"><label>{copy.proxyBypass}</label><Mod k="proxyBypass" /><input aria-label={copy.proxyBypass} type="text" value={settings.proxyBypass} placeholder={copy.proxyBypassPlaceholder} onChange={(event) => update("proxyBypass", event.target.value)} /></div>
          <p className="settings-hint">{copy.proxyHint}</p>
        </section>
          <div className="settings-group-divider" />
        <section id="settings-keybindings">
          <label className="keymap-search">
            <Search size={14} />
            <input value={keymapQuery} aria-label={copy.keymapSearchPlaceholder} placeholder={copy.keymapSearchPlaceholder} onChange={(event) => setKeymapQuery(event.target.value)} spellCheck={false} />
            {keymapQuery && <button type="button" className="keymap-search-clear" onClick={() => setKeymapQuery("")}><X size={12} /></button>}
          </label>
          {keymapClash.note && (
            <div className="keymap-clash" role="status">
              <span className="keymap-clash-beam" />
              <span className="keymap-clash-mark">!</span>
              <span className="keymap-clash-copy">{keymapClash.note}</span>
            </div>
          )}
          <div className="keymap-groups">
            {KEYMAP_GROUPS.map((group) => {
              const actions = group.actions.filter((action) => keymapVisible.has(action));
              if (actions.length === 0) return null;
              return (
                <div className="keymap-group" key={group.id}>
                  <h3 className="keymap-group-title">{copy.keymapGroups[group.id]}</h3>
                  <div className="keymap-group-frame">
                    {actions.map((action) => (
                      <KeybindingRow
                        key={action}
                        action={action}
                        chord={settings.keybindings[action]}
                        label={copy.keybindingActions[action]}
                        hint={action === "quick-terminal" ? copy.quickTerminalGlobalHint : undefined}
                        copy={copy}
                        clash={keymapClash.rows.has(action)}
                        capturing={keymapCapture === action}
                        capturePreview={keymapCapturePreview}
                        onBegin={setKeymapCapture}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
            {keymapVisible.size === 0 && <div className="keymap-empty">{copy.keymapNoMatches}</div>}
          </div>
          <p className="keymap-footer-hint">{copy.keymapFooterHint}</p>
        </section>
          <div className="settings-group-divider" />
        <section id="settings-backup">
          <h2>{copy.backup}</h2>
          <p className="keymap-footer-hint">{copy.backupHint}</p>
          <div className="settings-group-divider" />
          <h3>{copy.backupCategories}</h3>
          <div className="settings-backup-categories">
            {BACKUP_CATEGORY_ROWS.map((row) => (
              <label className="settings-check-row" key={row.key}>
                <input type="checkbox" checked={backupSelection[row.key]} disabled={backupBusy} onChange={(event) => setBackupSelection((prev) => ({ ...prev, [row.key]: event.target.checked }))} />
                <span>{row.label}</span>
              </label>
            ))}
          </div>
          <div className="settings-row">
            <label>{copy.backupPassphrase}</label>
            <input type="password" className="settings-backup-passphrase" value={backupPassphrase} disabled={backupBusy} placeholder={copy.backupPassphrasePlaceholder} onChange={(event) => setBackupPassphrase(event.target.value)} />
          </div>
          <div className="settings-row settings-update-row">
            <button className="settings-update-button" disabled={backupBusy} onClick={() => void exportBackup()}><Download size={12} />{backupBusy ? copy.backupBusy : copy.backupExport}</button>
            <button className="settings-update-button" disabled={backupBusy} onClick={() => void previewBackupFile()}><Undo2 size={12} />{backupBusy ? copy.backupBusy : copy.backupRestore}</button>
            {backupStatus ? <span className={`settings-update-result ${backupStatus.error ? "error" : ""}`}>{backupStatus.message}</span> : null}
          </div>
          {backupPreview?.ok && backupPreview.entries ? (
            <div className="settings-backup-preview">
              <h4>{copy.backupPreviewTitle}</h4>
              <ul>
                {backupPreview.entries.map((entry) => (
                  <li key={entry.name} title={entry.name}>
                    <span className="settings-backup-preview-name">{entry.name}</span>
                    <span className={`settings-backup-preview-badge${entry.exists ? " overwrite" : ""}`}>{entry.exists ? copy.backupOverwrite : copy.backupNewFile}</span>
                    <span className="settings-backup-preview-size">{formatBytes(entry.size)}</span>
                  </li>
                ))}
              </ul>
              <p className="keymap-footer-hint">{copy.backupPreviewHint}</p>
              <div className="settings-backup-preview-actions">
                <button className="settings-update-button" disabled={backupBusy} onClick={() => void confirmRestore()}>{backupBusy ? <LoaderCircle className="spin" size={12} /> : <CheckCircle2 size={12} />}{copy.backupConfirmRestore}</button>
                <button className="settings-update-button" disabled={backupBusy} onClick={() => setBackupPreview(null)}>{copy.backupCancel}</button>
              </div>
            </div>
          ) : null}
        </section>
          <div className="settings-group-divider" />
        <section id="settings-about">
          <h2>{copy.about}</h2>
          <div className="settings-row settings-update-row">
            <button className="settings-update-button" disabled={updateInfo.state === "checking" || updateInfo.busy} onClick={() => onUpdateAction("check")}>
              {updateInfo.state === "checking" ? <LoaderCircle className="spin" size={12} /> : <Download size={12} />}
              {updateInfo.state === "checking" ? copy.checkingUpdates : copy.checkForUpdates}
            </button>
            {updateInfo.state === "done" && updateInfo.result?.latest ? (
              <span className="settings-update-result">
                <strong>{copy.updateAvailable(updateInfo.result.latest)}</strong>
                {updateInfo.result?.url ? <button title={copy.updateOpenDownload} onClick={() => void window.codex.openPath(updateInfo.result?.url as string)}><ExternalLink size={12} />{copy.updateOpenDownload}</button> : null}
                {updateInfo.result.assets?.length ? <button disabled={updateInfo.busy} onClick={() => onUpdateAction("download")}><Download size={12} />{copy.updateDownloadInstall}</button> : null}
                {updateInfo.pkgMgr?.source === "winget" || updateInfo.pkgMgr?.source === "scoop" ? (
                  <button className="settings-update-button" onClick={() => onUpdateAction("package")}><Package size={12} />{updateInfo.pkgMgr.source === "winget" ? copy.updateViaWinget : copy.updateViaScoop}</button>
                ) : null}
              </span>
            ) : null}
            {updateInfo.state === "done" && !updateInfo.result?.latest ? <span className="settings-update-result">{copy.updateNone}</span> : null}
            {updateInfo.state === "error" ? <span className="settings-update-result error">{updateInfo.result?.error || copy.updateCheckFailed}</span> : null}
            {updateInfo.download?.phase === "downloading" || updateInfo.download?.phase === "verifying" ? (
              <div className="settings-update-download">
                <div className="settings-update-progress"><i style={{ width: updateInfo.download.phase === "verifying" ? "100%" : `${updateInfo.download.total ? Math.min(100, Math.round(((updateInfo.download.received ?? 0) / updateInfo.download.total) * 100)) : 6}%` }} /></div>
                <span>{updateInfo.download.phase === "verifying" ? copy.updateVerifying : `${copy.updateDownloading}${updateInfo.download.total ? ` ${formatBytes(updateInfo.download.received ?? 0)} / ${formatBytes(updateInfo.download.total)}` : ""}`}</span>
              </div>
            ) : null}
            {updateInfo.download?.phase === "done" && updateInfo.download.path ? (
              <button className="settings-update-install" onClick={() => onUpdateAction("install")}><Download size={12} />{copy.updateInstallNow}</button>
            ) : null}
            {updateInfo.download?.phase === "error" ? <span className="settings-update-result error">{updateInfo.download.error || copy.updateDownloadFailed}</span> : null}
          </div>
          <div className="settings-group-divider" />
          <h3>{copy.diagnostics}</h3>
          <div className="settings-row"><label>{copy.diagnosticsUptime}</label><span>{formatDuration(diagnostics?.uptimeMs ?? 0)}</span></div>
          <div className="settings-row"><label>{copy.diagnosticsPtyCount}</label><span>{diagnostics?.ptyCount ?? 0}</span></div>
          <div className="settings-row">
            <label>{copy.diagnosticsLatency}</label>
            <button className="settings-update-button" disabled={latencyBusy} onClick={() => void measureLatency()}>
              {latencyBusy ? <LoaderCircle className="spin" size={12} /> : <Activity size={12} />}
              {copy.measureLatency}
            </button>
            {latency && <span className={latency.ok ? "settings-update-result" : "settings-update-result error"}>{latency.ok ? copy.latencyResult(latency.latencyMs ?? 0) : latency.error === "pane_not_found" ? copy.latencyProbeNoTerminal : latency.error === "busy" ? copy.latencyProbeBusy : latency.error}</span>}
          </div>
          <div className="settings-row">
            <label>{copy.diagnosticsQuarantine}</label>
            <span>{diagnostics?.quarantine.quarantined ? copy.quarantineActive : copy.quarantineOk}</span>
            {typeof diagnostics?.runtimeState.failures === "number" && diagnostics.runtimeState.failures > 0 && <small className="settings-update-result">{copy.diagnosticsFailures(diagnostics.runtimeState.failures)}</small>}
          </div>
          <div className="settings-row">
            <label>{copy.diagnosticsBootLog}</label>
            <button className="settings-update-button" onClick={() => { if (diagnostics?.userData) void window.codex.revealPath(diagnostics.userData); }}><FolderOpen size={12} />{copy.openBootTrace}</button>
          </div>
          <p className="keymap-footer-hint">{copy.latencyProbeHint}</p>
        </section>
          </div>
        </div>
      </div>
      {sshEditor && <SshEditor profile={sshEditor === "new" ? undefined : sshEditor} onClose={() => setSshEditor(undefined)} onError={(message) => setSshStatus({ message, error: true })} onSave={async (profile) => { const saved = await window.codex.saveSshProfile(profile); setSshEditor(undefined); await refreshSshHosts(); setSshStatus({ message: copy.savedHost(saved.name) }); }} onDelete={async (id) => { await window.codex.deleteSshProfile(id); setSshEditor(undefined); await refreshSshHosts(); setSshStatus({ message: copy.deletedHost }); }} />}
    </section>
  );
}

const fontWidthCache = new Map<string, boolean>();

function fontChain(value: string) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function isMonospacedFont(family: string) {
  const cached = fontWidthCache.get(family.toLocaleLowerCase());
  if (cached !== undefined) return cached;
  if (/(?:\bmono\b|\bcode\b|consolas?|courier|terminal|typewriter|fixed)/i.test(family)) {
    fontWidthCache.set(family.toLocaleLowerCase(), true);
    return true;
  }
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return false;
  context.font = `32px ${JSON.stringify(family)}`;
  const monospaced = Math.abs(context.measureText("iiiiiiii").width - context.measureText("WWWWWWWW").width) < 0.5;
  fontWidthCache.set(family.toLocaleLowerCase(), monospaced);
  return monospaced;
}

function replacePrimaryFont(value: string, family: string) {
  const chain = fontChain(value);
  const rest = chain.slice(1).filter((item) => item.toLocaleLowerCase() !== family.toLocaleLowerCase());
  return [family, ...rest].join(", ");
}

function FontPicker({ value, onChange, copy, imported }: {
  value: string;
  onChange(value: string): void;
  copy: ReturnType<typeof getSettingsCopy>;
  imported?: string[];
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [fonts, setFonts] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [panelPosition, setPanelPosition] = useState({ left: 8, top: 8, width: 400 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const primary = fontChain(value)[0] || "Cascadia Mono";

  const updatePanelPosition = () => {
    const bounds = triggerRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const width = Math.min(400, Math.max(220, window.innerWidth - 16));
    const left = Math.min(window.innerWidth - width - 8, Math.max(8, bounds.right - width));
    const below = bounds.bottom + 6;
    const panelHeight = Math.min(panelRef.current?.getBoundingClientRect().height || 410, window.innerHeight - 16);
    const top = below + panelHeight <= window.innerHeight - 8
      ? below
      : Math.max(8, bounds.top - panelHeight - 6);
    setPanelPosition({ left, top, width });
  };

  const loadFonts = async () => {
    if (fonts || loading) return;
    setLoading(true);
    try {
      setFonts(await window.codex.listSystemFonts());
    } catch {
      setFonts([]);
    } finally {
      setLoading(false);
    }
  };

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    setQuery("");
    setShowAll(false);
    updatePanelPosition();
    setOpen(true);
    void loadFonts();
  };

  useEffect(() => {
    if (!open) return;
    const reposition = () => updatePanelPosition();
    const dismiss = (event: globalThis.PointerEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !panelRef.current?.contains(target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(updatePanelPosition);
    return () => cancelAnimationFrame(frame);
  }, [fonts, loading, open, query, showAll]);

  const catalog = useMemo(() => {
    const importedKeys = new Set((imported ?? []).map((name) => name.toLocaleLowerCase()));
    const unique = new Map<string, string>();
    for (const family of [...(imported ?? []), primary, ...(fonts ?? [])]) {
      const normalized = family.trim();
      if (normalized) unique.set(normalized.toLocaleLowerCase(), normalized);
    }
    const needle = query.trim().toLocaleLowerCase();
    return [...unique.values()]
      .map((family) => {
        const importedEntry = importedKeys.has(family.toLocaleLowerCase());
        return { family, monospaced: importedEntry || isMonospacedFont(family), imported: importedEntry, current: family.toLocaleLowerCase() === primary.toLocaleLowerCase() };
      })
      .filter((entry) => entry.current || ((showAll || entry.monospaced) && (!needle || entry.family.toLocaleLowerCase().includes(needle))))
      .sort((left, right) => Number(right.current) - Number(left.current) || left.family.localeCompare(right.family, undefined, { sensitivity: "base" }));
  }, [fonts, imported, primary, query, showAll]);

  const panel = open ? (
    <div className="font-picker-panel" ref={panelRef} style={panelPosition} role="dialog" aria-label={copy.fontFamily}>
      <div className="font-picker-tools">
        <label className="font-picker-search"><Search size={13} /><input autoFocus value={query} placeholder={copy.fontSearchPlaceholder} onChange={(event) => setQuery(event.target.value)} /></label>
        <span>{copy.showAllFonts}</span>
        <label className="font-show-all-toggle">
          <input type="checkbox" checked={showAll} aria-label={copy.showAllFonts} onChange={(event) => setShowAll(event.target.checked)} />
          <i />
        </label>
      </div>
      {loading ? <div className="font-picker-loading"><LoaderCircle className="spin" size={13} />{copy.loadingFonts}</div> : (
        <div className="font-picker-list" role="listbox" aria-label={copy.fontFamily}>
          {catalog.map((entry) => (
            <button
              className={entry.current ? "selected" : ""}
              style={{ fontFamily: entry.family }}
              role="option"
              aria-selected={entry.current}
              title={entry.family}
              key={entry.family}
              onClick={() => { onChange(replacePrimaryFont(value, entry.family)); setOpen(false); }}
            >
              <span>{entry.family}</span>
              {entry.imported ? <em className="imported">{copy.importedBadge}</em> : null}
              {entry.current && <em>{copy.currentFont}</em>}
              {!entry.monospaced && <em className="warning">{copy.proportionalFont}</em>}
              {entry.current && <Check size={13} />}
            </button>
          ))}
          {catalog.length === 0 && <div className="font-picker-empty">{copy.noMatchingFonts}</div>}
        </div>
      )}
    </div>
  ) : null;

  return (
    <div className="font-family-picker">
      <button className={open ? "font-picker-trigger selected" : "font-picker-trigger"} ref={triggerRef} type="button" aria-label={copy.fontFamily} aria-expanded={open} aria-haspopup="listbox" onClick={toggle}>
        <span style={{ fontFamily: primary }} title={primary}>{primary}</span><ChevronDown className={open ? "open" : ""} size={13} />
      </button>
      {fontChain(value).length > 1 && <small className="font-fallback-hint">{copy.fontFallbackHint}</small>}
      {panel}
    </div>
  );
}

function KeybindingRow({ action, chord, label, hint, copy, clash, capturing, capturePreview, onBegin }: {
  action: KeybindingAction;
  chord: string;
  label: string;
  hint?: string;
  copy: ReturnType<typeof getSettingsCopy>;
  clash: boolean;
  capturing: boolean;
  capturePreview: string;
  onBegin(action: KeybindingAction): void;
}) {
  const customized = chord !== DEFAULT_KEYBINDINGS[action];
  const bound = chord.length > 0;
  const className = [
    "keybinding-row",
    clash ? "clash" : "",
    capturing ? "capturing" : "",
    customized ? "custom" : "",
    bound ? "bound" : "unbound",
  ].filter(Boolean).join(" ");
  const value = capturing
    ? (capturePreview ? `${capturePreview}…` : copy.keymapRecordingPlaceholder)
    : bound ? chord : copy.keymapUnbound;
  return (
    <div className={className} onClick={() => onBegin(action)}>
      <span className="keybinding-label"><strong>{label}</strong>{hint && <small>{hint}</small>}</span>
      <span className="keybinding-controls">
        <span className="keymap-rebind-hint">{copy.keymapRebind}</span>
        <button
          type="button"
          className={[
            "keybinding-record",
            clash ? "clash" : "",
            capturing ? "recording" : "",
            customized ? "custom" : "",
            bound ? "bound" : "unbound",
          ].filter(Boolean).join(" ")}
          aria-label={capturing ? copy.keymapRecordingPlaceholder : bound ? chord : copy.keymapUnbound}
          onClick={(event) => { event.stopPropagation(); onBegin(action); }}
        >
          {capturing || !bound ? value : keycapChips(chord)}
        </button>
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

function Toggle({ label, checked, modified, onChange }: { label: string; checked: boolean; modified?: boolean; onChange(value: boolean): void }) {
  return <label className="settings-toggle"><span>{label}{modified ? <span className="settings-modified-dot" /> : null}</span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><i /></label>;
}
