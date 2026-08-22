import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { chromium } from "playwright";

const testsDirectory = dirname(fileURLToPath(import.meta.url));
export const root = resolve(testsDirectory, "..");
const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

export async function startPreview(port = 4322) {
  const vite = join(root, "node_modules", "vite", "bin", "vite.js");
  const child = spawn(process.execPath, [vite, "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: root,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { output += chunk.toString("utf8"); });
  const url = `http://127.0.0.1:${port}`;
  const startedAt = Date.now();
  while (Date.now() - startedAt < 20_000) {
    if (child.exitCode !== null) throw new Error(`Vite preview exited early:\n${output}`);
    try {
      const response = await fetch(url);
      if (response.ok) return { url, stop: () => child.kill() };
    } catch {
      // Server is not listening yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 120));
  }
  child.kill();
  throw new Error(`Timed out waiting for Vite preview:\n${output}`);
}

export async function launchBrowser() {
  const executablePath = process.env.CODEX_UI_BROWSER || (existsSync(edge) ? edge : chrome);
  if (!existsSync(executablePath)) throw new Error("No system Edge or Chrome executable found");
  return chromium.launch({ executablePath, headless: true, args: ["--disable-gpu"] });
}

export async function installMockBridge(page) {
  await page.addInitScript(() => {
    // Headless browsers cannot read the real clipboard; resolve with empty text
    // so Ctrl+V deterministically falls through to the image-paste bridge.
    if (navigator.clipboard?.readText) {
      navigator.clipboard.readText = async () => "";
    }
    const runListeners = [];
    const terminalListeners = [];
    const launcherListeners = [];
    let settings = {
      closeBehavior: "tray", notifyOnCompletion: true, language: "system", theme: "nebula", density: "normal",
      backgroundBlur: false, backgroundOpacity: 0.92, restoreTerminalTabs: true,
      resizablePanels: false, completionEnabled: true, copyOnSelect: true, powerlinePrompt: true,
      quickTerminal: true, shellStartupIntegration: false, defaultShellId: "powershell", cursorStyle: "bar", cursorBlink: true, fontFamily: "",
      bellSound: true, resumeAiSessions: true, loadShellProfile: false, newTabPlacement: "after-active", cliProfiles: [],
      keybindings: {
        "command-palette": "Ctrl+Shift+P", "new-terminal": "Ctrl+Shift+T", "split-right": "Ctrl+Shift+D",
        "split-down": "Ctrl+Shift+E", "pane-next": "Ctrl+Alt+ArrowRight", "pane-prev": "Ctrl+Alt+ArrowLeft",
        "quick-terminal": "Ctrl+`", "open-settings": "Ctrl+,",
      },
    };
    let cliLifecycleStatus = {
      enabled: false,
      supported: true,
      watching: false,
      integrations: [
        { id: "codex", label: "Codex", installed: false, configPath: "C:\\mock\\.codex\\config.toml" },
        { id: "claude", label: "Claude Code", installed: false, configPath: "C:\\mock\\.claude\\settings.json" },
      ],
    };
    const capabilities = { structuredChat: true, sessions: true, resume: true, models: true, reasoningEffort: true, sandboxMode: true, images: true, stop: true, webUi: false, terminal: true };
    const codexProvider = { id: "codex", name: "OpenAI Codex", shortName: "Codex", description: "Mock Codex Provider", available: true, configured: true, cliAvailable: true, version: "codex-cli 0.145.0", executable: "C:\\mock\\codex.exe", defaultModel: "", models: [{ id: "gpt-5.6-sol", label: "GPT-5.6 Sol" }], capabilities };
    const deepseekProvider = { id: "deepseek", name: "DeepSeek Harness", shortName: "DeepSeek", description: "Mock DeepSeek Provider", available: true, configured: false, cliAvailable: false, installCommand: "npm install -g @deepseek-ai/dsh@0.1.0-rc.7", defaultModel: "deepseek-v4-flash", models: [{ id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" }], capabilities: { ...capabilities, reasoningEffort: false, sandboxMode: false, images: false, webUi: true } };
    let terminalCounter = 0;
    const terminalSessions = [];
    const terminalWrites = [];
    const emit = (event) => runListeners.forEach((listener) => listener(event));
    const emitTerminal = (event) => terminalListeners.forEach((listener) => listener(event));
    const makeTerminal = (request, titleSuffix = "") => {
      terminalCounter += 1;
      return {
        id: `22222222-2222-4222-8222-${String(terminalCounter).padStart(12, "0")}`,
        title: `${request.cwd.split(/[\\/]/).at(-1) || "Terminal"}${titleSuffix}`,
        cwd: request.cwd,
        shell: "powershell.exe",
        shellId: request.sshProfileId ? `ssh:${request.sshProfileId}` : request.shellId || "powershell",
        profileId: request.profileId,
        sshProfileId: request.sshProfileId,
        kind: request.sshProfileId ? "ssh" : "local",
        remoteHost: request.sshProfileId ? "dev@example.com" : undefined,
        activity: "idle",
        status: "running",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        cols: request.cols,
        rows: request.rows,
        aiSource: request.aiSource,
        aiSessionId: request.aiSessionId,
      };
    };
    // WSL 测试种子：测试先写 localStorage 标志再 reload，init 脚本在此重建该会话
    if (localStorage.getItem("codex-cli-ui:test-wsl-terminal")) {
      terminalSessions.push({
        id: "33333333-3333-4333-8333-333333333333",
        title: "dev",
        cwd: "\\\\wsl.localhost\\Ubuntu\\home\\dev",
        shell: "wsl.exe",
        shellId: "wsl:Ubuntu",
        kind: "local",
        activity: "idle",
        status: "running",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        cols: 100,
        rows: 30,
      });
    }
    const completeRun = (request) => {
      const threadId = "11111111-1111-4111-8111-111111111111";
      window.setTimeout(() => emit({ providerId: request.providerId, runId: request.runId, type: "message", data: { type: "thread.started", thread_id: threadId } }), 20);
      window.setTimeout(() => emit({
        providerId: request.providerId,
        runId: request.runId,
        type: "message",
        data: { type: "item.started", item: { id: "cmd-1", type: "command_execution", command: "npm test", status: "in_progress", aggregated_output: "" } },
      }), 45);
      window.setTimeout(() => emit({
        providerId: request.providerId,
        runId: request.runId,
        type: "message",
        data: { type: "item.completed", item: { id: "cmd-1", type: "command_execution", command: "npm test", status: "completed", aggregated_output: "12 tests passed" } },
      }), 70);
      window.setTimeout(() => emit({
        providerId: request.providerId,
        runId: request.runId,
        type: "message",
        data: { type: "item.completed", item: { id: "msg-1", type: "agent_message", text: "## Done\n\nUpdated the parser and verified **12 tests**.\n\n```ts\nconst status = 'ready';\n```" } },
      }), 95);
      window.setTimeout(() => emit({ providerId: request.providerId, runId: request.runId, type: "exit", code: 0, stopped: false }), 115);
    };

    window.__mock = { runListeners, terminalListeners, launcherListeners, lastRun: null, launcherInstalled: false, terminalSessions, terminalWrites, clipboardImage: null, lastPasteProfileId: null, lastResumeId: null, lastFork: null, svnMode: false, lastGitAction: null, $$callLog: { readDocument: [], readDocumentImage: [] } };
    window.codex = {
      getInfo: async () => codexProvider,
      listProviders: async () => [codexProvider, deepseekProvider],
      refreshProvider: async (id) => id === "deepseek" ? deepseekProvider : codexProvider,
      installProvider: async () => ({ ok: true, message: "Installed" }),
      setProviderCredential: async () => ({ ...deepseekProvider, configured: true }),
      getAppSettings: async () => settings,
      setAppSettings: async (value) => { settings = value; return settings; },
      chooseDirectory: async () => "F:\\demo\\atlas-workspace",
      chooseImages: async () => ["F:\\demo\\ui-reference.png"],
      chooseBackgroundImage: async () => "F:\\demo\\background.png",
      revealPath: async () => true,
      copyText: async () => true,
      pasteClipboardImage: async (sshProfileId) => { window.__mock.lastPasteProfileId = sshProfileId ?? null; return window.__mock.clipboardImage; },
      openTerminal: async () => true,
      listShells: async () => [
        { id: "powershell", label: "Windows PowerShell", command: "powershell.exe", kind: "powershell" },
        { id: "cmd", label: "Command Prompt", command: "cmd.exe", kind: "cmd" },
      ],
      listCliTools: async () => [
        { id: "builtin:codex", name: "Codex", command: "codex", args: [], icon: "code", description: "OpenAI Codex CLI", builtIn: true, available: true, executable: "C:\\mock\\codex.exe", installCommand: "npm install -g @openai/codex" },
        { id: "builtin:claude", name: "Claude Code", command: "claude", args: [], icon: "code", description: "Anthropic Claude Code", builtIn: true, available: false, installCommand: "npm install -g @anthropic-ai/claude-code" },
      ],
      getCommandHistory: async (prefix) => prefix ? [`${prefix} --help`] : [],
      listDirectories: async () => (window.__mock.directoryEntries || [
        { path: "F:\\demo\\atlas-workspace", rank: 820, lastAccessed: Date.now() - 1000, pinned: true, score: 820 },
        { path: "F:\\demo\\docs", rank: 240, lastAccessed: Date.now() - 3600_000, pinned: false, score: 210 },
      ]),
      pinDirectory: async (path) => {
        window.__mock.directoryEntries = (window.__mock.directoryEntries || [
          { path: "F:\\demo\\atlas-workspace", rank: 820, lastAccessed: Date.now() - 1000, pinned: true, score: 820 },
          { path: "F:\\demo\\docs", rank: 240, lastAccessed: Date.now() - 3600_000, pinned: false, score: 210 },
        ]).map((entry) => entry.path === path ? { ...entry, pinned: true } : entry);
        return window.__mock.directoryEntries;
      },
      unpinDirectory: async (path) => {
        window.__mock.directoryEntries = (window.__mock.directoryEntries || [
          { path: "F:\\demo\\atlas-workspace", rank: 820, lastAccessed: Date.now() - 1000, pinned: true, score: 820 },
          { path: "F:\\demo\\docs", rank: 240, lastAccessed: Date.now() - 3600_000, pinned: false, score: 210 },
        ]).map((entry) => entry.path === path ? { ...entry, pinned: false } : entry);
        return window.__mock.directoryEntries;
      },
      removeDirectory: async (path) => {
        window.__mock.directoryEntries = (window.__mock.directoryEntries || [
          { path: "F:\\demo\\atlas-workspace", rank: 820, lastAccessed: Date.now() - 1000, pinned: true, score: 820 },
          { path: "F:\\demo\\docs", rank: 240, lastAccessed: Date.now() - 3600_000, pinned: false, score: 210 },
        ]).filter((entry) => entry.path !== path);
        return window.__mock.directoryEntries;
      },
      getCompletions: async (prefix) => prefix ? [
        { value: `${prefix} --help`, source: "history" },
        { value: `${prefix}.ps1`, source: "command" },
      ] : [],
      listTerminals: async () => [...terminalSessions],
      createTerminal: async (request) => {
        const existing = request.reuseExisting !== false && terminalSessions.find((item) => item.cwd.toLowerCase() === request.cwd.toLowerCase() && item.status === "running");
        if (existing) return existing;
        const session = makeTerminal(request);
        terminalSessions.push(session);
        return session;
      },
      resumeAiSession: async (id) => { window.__mock.lastResumeId = id; return true; },
      forkAiSession: async (request) => {
        const source = terminalSessions.find((item) => item.id === request.sessionId);
        const session = makeTerminal({
          cwd: source?.cwd || "F:\\demo\\atlas-workspace",
          cols: request.cols,
          rows: request.rows,
          aiSource: source?.aiSource || "codex",
          aiSessionId: request.sessionId,
        }, " (fork)");
        terminalSessions.push(session);
        window.__mock.lastFork = request;
        return session;
      },
      attachTerminal: async (id) => {
        const terminal = terminalSessions.find((item) => item.id === id);
        if (!terminal) return null;
        const wsl = String(terminal.cwd).toLowerCase().startsWith("\\\\wsl");
        return terminal
          ? { terminal, snapshot: wsl ? "Mock WSL\r\ncodex@ubuntu:~/dev$ " : "Mock PowerShell\r\nPS F:\\demo\\atlas-workspace> " }
          : null;
      },
      detachTerminal: async () => true,
      writeTerminal: async (id, data) => { terminalWrites.push({ id, data }); emitTerminal({ sessionId: id, type: "data", data }); return true; },
      resizeTerminal: async (id, cols, rows) => {
        const terminal = terminalSessions.find((item) => item.id === id);
        if (terminal) { terminal.cols = cols; terminal.rows = rows; }
        return !!terminal;
      },
      closeTerminal: async (id) => {
        const index = terminalSessions.findIndex((item) => item.id === id);
        if (index < 0) return false;
        terminalSessions.splice(index, 1);
        return true;
      },
      listDirectory: async (_root, path) => [
        { name: "src", path: `${path}\\src`, type: "directory" },
        { name: "README.md", path: `${path}\\README.md`, type: "file", size: 2113 },
      ],
      readDocument: async (_root, path) => {
        window.__mock.$$callLog.readDocument.push({ args: [_root, path] });
        return path.endsWith("README.md") ? { path, name: "README.md", kind: "markdown", content: "# Atlas\n\n![logo](logo.png)\n\n![remote](https://example.com/banner.png)\n\nInline math $x^2$.", size: 2113, modifiedAt: Date.now() } : null;
      },
      readDocumentImage: async (_root, path) => {
        window.__mock.$$callLog.readDocumentImage.push({ args: [_root, path] });
        return path.endsWith("logo.png") ? "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" : null;
      },
      getGitStatus: async () => window.__mock.svnMode
        ? { available: true, branch: "r124", revision: "124", vcs: "svn", entries: [{ status: "M", path: "src/App.tsx" }, { status: "A", path: "README.md" }] }
        : { available: true, branch: "main", vcs: "git", entries: [{ status: "M", path: "src/App.tsx" }] },
      runGitAction: async (request) => { window.__mock.lastGitAction = request; return { ok: true, message: `${request.action} completed` }; },
      listSshProfiles: async () => [{ id: "ssh-mock", name: "Dev server", host: "example.com", port: 22, username: "dev", remotePath: "/home/dev", createdAt: Date.now(), updatedAt: Date.now(), source: "saved" }],
      saveSshProfile: async (profile) => profile,
      deleteSshProfile: async () => true,
      testSshProfile: async () => ({ ok: true, stages: ["resolve", "tcp", "authenticate", "session"].map((name) => ({ name, status: "done" })) }),
      listSftp: async (_id, path) => [{ name: "remote.txt", path: `${path.replace(/\/$/, "")}/remote.txt`, type: "file", size: 512 }],
      runSftpAction: async (request) => ({ ok: true, message: `${request.action} completed` }),
      listSessions: async () => [],
      getSession: async () => null,
      listProviderSessions: async () => [],
      getProviderSession: async () => null,
      startRun: async (request) => {
        window.__mock.lastRun = request;
        completeRun(request);
        return { accepted: true };
      },
      stopRun: async (runId) => { emit({ providerId: "codex", runId, type: "exit", code: null, stopped: true }); return true; },
      getLauncherStatus: async () => ({ installed: false, profilePath: "C:\\mock\\profile.ps1", rawCommand: "C:\\mock\\codex.exe" }),
      installLauncher: async () => { window.__mock.launcherInstalled = true; return { installed: true, profilePath: "C:\\mock\\profile.ps1", rawCommand: "C:\\mock\\codex.exe" }; },
      uninstallLauncher: async () => { window.__mock.launcherInstalled = false; return { installed: false, profilePath: "C:\\mock\\profile.ps1", rawCommand: "C:\\mock\\codex.exe" }; },
      getCliLifecycleStatus: async () => cliLifecycleStatus,
      setCliLifecycleEnabled: async (enabled) => {
        cliLifecycleStatus = {
          ...cliLifecycleStatus,
          enabled,
          watching: enabled,
          integrations: cliLifecycleStatus.integrations.map((integration) => ({ ...integration, installed: enabled })),
        };
        return cliLifecycleStatus;
      },
      onRunEvent: (listener) => { runListeners.push(listener); return () => runListeners.splice(runListeners.indexOf(listener), 1); },
      onTerminalEvent: (listener) => { terminalListeners.push(listener); return () => terminalListeners.splice(terminalListeners.indexOf(listener), 1); },
      onQuickTerminal: () => () => {},
      onLauncherRequest: (listener) => { launcherListeners.push(listener); return () => launcherListeners.splice(launcherListeners.indexOf(listener), 1); },
    };
    window.workbench = window.codex;
  });
}

export async function createPopulatedPage(browser, url, viewport = { width: 1380, height: 880 }) {
  const context = await browser.newContext({ viewport, locale: "zh-CN" });
  const page = await context.newPage();
  await installMockBridge(page);
  await page.goto(url, { waitUntil: "networkidle" });
  const terminalTab = page.getByRole("tab", { name: "终端" });
  assert.equal(await terminalTab.isDisabled(), false);
  await terminalTab.click();
  await page.locator(".xterm-screen").waitFor();
  await page.getByRole("tab", { name: "对话" }).click();
  await page.locator(".composer textarea").fill("Fix the parser and run the test suite");
  await page.locator(".send-button").click();
  await page.getByText("Updated the parser").waitFor({ timeout: 10_000 });
  return { context, page };
}
