import { spawn } from "node:child_process";
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
    const runListeners = [];
    const launcherListeners = [];
    let settings = { closeBehavior: "tray", notifyOnCompletion: true };
    const emit = (event) => runListeners.forEach((listener) => listener(event));
    const completeRun = (request) => {
      const threadId = "11111111-1111-4111-8111-111111111111";
      window.setTimeout(() => emit({ runId: request.runId, type: "message", data: { type: "thread.started", thread_id: threadId } }), 20);
      window.setTimeout(() => emit({
        runId: request.runId,
        type: "message",
        data: { type: "item.started", item: { id: "cmd-1", type: "command_execution", command: "npm test", status: "in_progress", aggregated_output: "" } },
      }), 45);
      window.setTimeout(() => emit({
        runId: request.runId,
        type: "message",
        data: { type: "item.completed", item: { id: "cmd-1", type: "command_execution", command: "npm test", status: "completed", aggregated_output: "12 tests passed" } },
      }), 70);
      window.setTimeout(() => emit({
        runId: request.runId,
        type: "message",
        data: { type: "item.completed", item: { id: "msg-1", type: "agent_message", text: "## Done\n\nUpdated the parser and verified **12 tests**.\n\n```ts\nconst status = 'ready';\n```" } },
      }), 95);
      window.setTimeout(() => emit({ runId: request.runId, type: "exit", code: 0, stopped: false }), 115);
    };

    window.__mock = { runListeners, launcherListeners, lastRun: null, launcherInstalled: false };
    window.codex = {
      getInfo: async () => ({ available: true, version: "codex-cli 0.145.0", executable: "C:\\mock\\codex.exe" }),
      getAppSettings: async () => settings,
      setAppSettings: async (value) => { settings = value; return settings; },
      chooseDirectory: async () => "F:\\demo\\atlas-workspace",
      chooseImages: async () => ["F:\\demo\\ui-reference.png"],
      revealPath: async () => true,
      openTerminal: async () => true,
      listSessions: async () => [],
      getSession: async () => null,
      startRun: async (request) => {
        window.__mock.lastRun = request;
        completeRun(request);
        return { accepted: true };
      },
      stopRun: async (runId) => { emit({ runId, type: "exit", code: null, stopped: true }); return true; },
      getLauncherStatus: async () => ({ installed: false, profilePath: "C:\\mock\\profile.ps1", rawCommand: "C:\\mock\\codex.exe" }),
      installLauncher: async () => { window.__mock.launcherInstalled = true; return { installed: true, profilePath: "C:\\mock\\profile.ps1", rawCommand: "C:\\mock\\codex.exe" }; },
      uninstallLauncher: async () => { window.__mock.launcherInstalled = false; return { installed: false, profilePath: "C:\\mock\\profile.ps1", rawCommand: "C:\\mock\\codex.exe" }; },
      onRunEvent: (listener) => { runListeners.push(listener); return () => runListeners.splice(runListeners.indexOf(listener), 1); },
      onLauncherRequest: (listener) => { launcherListeners.push(listener); return () => launcherListeners.splice(launcherListeners.indexOf(listener), 1); },
    };
  });
}

export async function createPopulatedPage(browser, url, viewport = { width: 1380, height: 880 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await installMockBridge(page);
  await page.goto(url, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "添加工作目录" }).click();
  await page.locator("textarea").fill("Fix the parser and run the test suite");
  await page.locator(".send-button").click();
  await page.getByText("Updated the parser").waitFor({ timeout: 10_000 });
  return { context, page };
}
