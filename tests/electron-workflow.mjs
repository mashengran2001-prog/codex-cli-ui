import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { _electron as electron } from "playwright";
import electronPath from "electron";
import { createElectronFixture, launcherArgs } from "./electron-fixture.mjs";
import { root } from "./browser-harness.mjs";

const testRoot = join(root, ".tmp", "electron-workflow");
const codexHome = join(testRoot, "codex-home");
const userData = join(testRoot, "user-data");
const shellStartupRoot = join(testRoot, "shell-startup");
const shellStartupRegistry = `HKCU:\\Software\\CodexCliUiTest\\Electron-${process.pid}`;
const exportProbe = join(testRoot, "export-probe.txt");
await rm(testRoot, { recursive: true, force: true });
await mkdir(testRoot, { recursive: true });
await createElectronFixture(root, codexHome);
const fakeBin = join(testRoot, "fake-bin");
await mkdir(fakeBin, { recursive: true });
writeFileSync(join(fakeBin, "codex.cmd"), "@echo off\r\necho FAKE_CODEX_AGENT_OK\r\nexit /b 0\r\n", "utf8");
writeFileSync(join(fakeBin, "codex.ps1"), "Write-Output 'FAKE_CODEX_AGENT_OK'\r\n", "utf8");

const electronEnv = {
  ...process.env,
  PATH: fakeBin + ";" + (process.env.PATH ?? ""),
  CODEX_UI_CLI_PATH: process.execPath,
  CODEX_UI_CLI_PREFIX_ARGS: JSON.stringify([join(root, "tests", "fake-codex.mjs")]),
  CODEX_UI_CODEX_HOME: codexHome,
  CODEX_UI_USER_DATA_DIR: userData,
  TEMP: join(root, ".tmp"),
  TMP: join(root, ".tmp"),
  CODEX_UI_SHELL_STARTUP_WINDOWS_PROFILE: join(shellStartupRoot, "WindowsPowerShell", "profile.ps1"),
  CODEX_UI_SHELL_STARTUP_PWSH_PROFILE: join(shellStartupRoot, "PowerShell", "profile.ps1"),
  CODEX_UI_SHELL_STARTUP_HOOK_PATH: join(shellStartupRoot, "hooks", "shell-startup.ps1"),
  CODEX_UI_SHELL_STARTUP_REGISTRY_PATH: shellStartupRegistry,
  CODEX_UI_RENDERER: "dom",
  CODEX_UI_EXPORT_PATH: exportProbe,
};

const app = await electron.launch({
  executablePath: electronPath,
  args: [root, ...launcherArgs(root)],
  cwd: root,
  env: electronEnv,
  timeout: 30_000,
});

try {
  const window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  await window.getByText("Imported session").waitFor({ timeout: 15_000 });
  await window.getByText("Imported session").click();
  await window.getByText("Imported response is ready.").waitFor();
  assert.match(await window.locator(".reasoning-content").textContent(), /Checking the parser/);
  assert.match(await window.locator(".activity-row").textContent(), /shell_command/);
  const systemFonts = await window.evaluate(async () => window.codex.listSystemFonts());
  assert.ok(systemFonts.length >= 4);
  assert.equal(new Set(systemFonts.map((name) => name.toLocaleLowerCase())).size, systemFonts.length);
  assert.ok(systemFonts.every((name) => typeof name === "string" && name.length > 0));
  console.log(`electron-fonts: ${systemFonts.length} system font families enumerated through real IPC`);
  const quarantineStatus = await window.evaluate(async () => window.codex.getTerminalQuarantineStatus());
  assert.deepEqual(quarantineStatus, { quarantined: false, snapshotPath: null });
  console.log("electron-quarantine: IPC status channel answers normally");

  await window.getByText("Fix the parser from CLI").first().click();
  const textarea = window.locator("textarea");
  await textarea.waitFor();
  assert.equal(await textarea.inputValue(), "Fix the parser from CLI");
  await window.locator(".send-button").click();
  await window.getByText(/Completed from fake Codex/).waitFor({ timeout: 15_000 });
  assert.match(await window.locator(".composer-status").textContent(), /(?:会话|Session) 33333333/);
  assert.match(await window.locator(".activity-row").last().textContent(), /npm test/);
  assert.match(await window.locator(".sidebar-status").textContent(), /0.145.0-test/);

  await window.getByRole("tab", { name: "终端" }).click();
  // 与 Nebula 一致，默认侧边；本用例其余部分基于顶部标签，先切到顶部
  await window.getByTitle("CLI 工具设置").click();
  await window.locator(".terminal-settings").waitFor();
  await window.getByLabel("标签栏位置").selectOption("top");
  await window.getByRole("button", { name: "返回工作台" }).click();
  await window.waitForFunction(() => document.querySelectorAll(".terminal-top-tabs").length === 1 && document.querySelectorAll(".terminal-side-tabs").length === 0);
  await window.locator(".xterm-helper-textarea").waitFor({ timeout: 15_000 });
  await window.locator(".xterm-helper-textarea").focus();
  await window.keyboard.type('Write-Output ("NEBULA" + "_PTY_OK")', { delay: 12 });
  await window.keyboard.press("Enter");
  await window.waitForFunction(() => document.querySelector(".xterm-rows")?.textContent?.includes("NEBULA_PTY_OK"), undefined, { timeout: 15_000 });
 assert.equal(await window.evaluate(async () => (await window.codex.listTerminals()).length), 1);
  // 真实 readDocumentImage IPC 验证
  const probeImg = join(root, "probe-img-test.png");
  const { writeFile, readFile, rm: rmFile } = await import("node:fs/promises");
  await writeFile(probeImg, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
  try {
    const result = await window.evaluate(async ([r, p]) => await window.codex.readDocumentImage(r, p), [root, probeImg]);
    assert.match(result, /^data:image\/png;base64,/);
    const resultNull = await window.evaluate(async ([r, p]) => await window.codex.readDocumentImage(r, p), [root, "C:\\Windows\\win.ini"]);
    assert.equal(resultNull, null);
    console.log("electron-image: readDocumentImage IPC verified");
  } finally {
    await rmFile(probeImg).catch(() => {});
  }
  // 真实 terminal:export-session IPC 验证（通过 CODEX_UI_EXPORT_PATH 绕过保存对话框）
  const sessionId = (await window.evaluate(async () => (await window.codex.listTerminals())[0].id));
  const exportedPath = await window.evaluate(async (id) => window.codex.exportTerminalSession(id, "NEBULA_PTY_OK line\nsecond line"), sessionId);
  assert.equal(exportedPath, exportProbe);
  assert.match(await readFile(exportProbe, "utf8"), /NEBULA_PTY_OK line/);
  console.log("electron-export: terminal:export-session IPC verified");
  await window.getByTitle("更多操作").click(); await window.getByRole("menuitem", { name: "打开设置" }).click();
  await window.getByLabel("打开 PowerShell/CMD 时唤起工作台").check();
  await window.waitForFunction(async () => (await window.codex.getAppSettings()).shellStartupIntegration === true, undefined, { timeout: 15_000 });
  await window.getByLabel("打开 PowerShell/CMD 时唤起工作台").uncheck();
  await window.waitForFunction(async () => (await window.codex.getAppSettings()).shellStartupIntegration === false, undefined, { timeout: 15_000 });
  // 代理仅注入工作台子进程：设置代理后新建终端，子进程应看到 HTTPS_PROXY，且清空后新终端不再携带
  await window.getByLabel("代理地址").fill("http://127.0.0.1:7890");
  await window.getByLabel("不走代理的地址").fill("localhost,127.0.0.1");
  await window.waitForFunction(async () => (await window.codex.getAppSettings()).proxyUrl === "http://127.0.0.1:7890", undefined, { timeout: 15_000 });
  await window.getByRole("button", { name: "返回工作台" }).click();
  const proxySessionCount = await window.evaluate(async () => (await window.codex.listTerminals()).length);
  await window.getByTitle("新建终端").first().click();
  await window.waitForFunction((count) => (async () => (await window.codex.listTerminals()).length === count + 1)(), proxySessionCount, { timeout: 15_000 });
  // 新标签默认不激活，点击新标签让其 xterm 挂载后再输入
  const newSessionId = await window.evaluate(async () => (await window.codex.listTerminals()).at(-1).id);
  await window.locator(`.terminal-top-tab[data-session-id="${newSessionId}"] .terminal-tab-main`).click();
  await window.locator(".terminal-pane-leaf[data-session-id='" + newSessionId + "'] .xterm-helper-textarea").waitFor({ timeout: 15_000 });
  await window.locator(".terminal-pane-leaf[data-session-id='" + newSessionId + "'] .xterm-helper-textarea").focus();
  await window.keyboard.type('Write-Output ("PROXY=" + $env:HTTPS_PROXY)', { delay: 8 });
  await window.keyboard.press("Enter");
  await window.waitForFunction(() => document.querySelector(".xterm-rows")?.textContent?.includes("PROXY=http://127.0.0.1:7890"), undefined, { timeout: 15_000 });
  // 关闭代理测试终端，避免它进入会话快照影响重启恢复断言
  const sessionIdsBeforeClose = await window.evaluate(async () => (await window.codex.listTerminals()).map((terminal) => terminal.id));
  assert.equal(sessionIdsBeforeClose.length, proxySessionCount + 1);
  const lastSessionId = sessionIdsBeforeClose.at(-1);
  const closed = await window.evaluate((id) => {
    const tab = document.querySelector(`.terminal-tab[data-session-id="${id}"]`) || document.querySelector(`.terminal-top-tab[data-session-id="${id}"]`);
    if (!tab) return "no-tab";
    const button = tab.querySelector(".terminal-tab-close");
    if (!button) return "no-button";
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    return "clicked";
  }, lastSessionId);
  assert.equal(closed, "clicked");
  await window.waitForFunction(async (expected) => (await window.codex.listTerminals()).length === expected, proxySessionCount, { timeout: 10_000 });
  await window.getByTitle("更多操作").click(); await window.getByRole("menuitem", { name: "打开设置" }).click();
  await window.getByLabel("代理地址").fill("");
  await window.getByLabel("不走代理的地址").fill("");
  await window.waitForFunction(async () => (await window.codex.getAppSettings()).proxyUrl === "", undefined, { timeout: 15_000 });
  // Runtime control server: endpoint file + TCP describe + orchestrate workflow
  const runtimeEndpointPath = join(userData, "runtime-endpoint.json");
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 15_000;
    const poll = () => {
      if (existsSync(runtimeEndpointPath)) return resolve();
      if (Date.now() > deadline) return reject(new Error("runtime endpoint file was not written"));
      setTimeout(poll, 200);
    };
    poll();
  });
  const endpoint = JSON.parse(readFileSync(runtimeEndpointPath, "utf8"));
  assert.equal(typeof endpoint.port, "number");
  assert.equal(typeof endpoint.token, "string");
  const describe = JSON.parse(execFileSync(process.execPath, [join(root, "scripts", "runtime-ctl.mjs"), "describe", "--endpoint", runtimeEndpointPath], { encoding: "utf8" }));
  assert.equal(describe.ok, true);
  assert.ok(describe.result.capabilities.includes("runtime.orchestrate"));
  const workflow = {
    steps: [
      { id: "tab_a", op: "new_tab", cwd: root },
      { id: "say_hi", op: "run", target: { step: "tab_a", field: "pane_id" }, command: "echo RUNTIME_CTL_OK", wait: true, timeout_ms: 20000 },
      { id: "focus_back", op: "focus", target: { step: "tab_a", field: "pane_id" } },
    ],
    on_error: "stop",
  };
  const workflowPath = join(testRoot, "runtime-workflow.json");
  writeFileSync(workflowPath, JSON.stringify(workflow));
  const receipt = JSON.parse(execFileSync(process.execPath, [join(root, "scripts", "runtime-ctl.mjs"), "orchestrate", "--file", workflowPath, "--endpoint", runtimeEndpointPath], { encoding: "utf8" }));
  assert.equal(receipt.ok, true, JSON.stringify(receipt.error || receipt.result));
  assert.equal(receipt.result.ok, true, JSON.stringify(receipt.result));
  assert.equal(receipt.result.completed, 3);
  assert.equal(receipt.result.failed_step, null);
  assert.ok(receipt.result.steps.every((step) => step.ok));
  assert.equal(receipt.result.steps[0].op, "new_tab");
  assert.ok(typeof receipt.result.steps[0].action.pane_id === "string" && receipt.result.steps[0].action.pane_id.length > 0);
  // validation: forward reference must be rejected
  const badWorkflow = { steps: [{ id: "later", op: "focus", target: { step: "tab_a", field: "pane_id" } }] };
  const badResult = spawnSync(process.execPath, [join(root, "scripts", "runtime-ctl.mjs"), "orchestrate", "--spec", JSON.stringify(badWorkflow), "--endpoint", runtimeEndpointPath], { encoding: "utf8", timeout: 10_000 });
  assert.notEqual(badResult.status, 0, badResult.stdout);
  const badReceipt = JSON.parse(badResult.stdout);
  assert.equal(badReceipt.ok, false);
  assert.equal(badReceipt.error.code, "invalid_params");
  console.log("electron-runtime: runtime control TCP server, CLI describe/orchestrate, and validation passed");

  // The orchestrate workflow created a real tab; close it before the app exits so the
  // session-restore assertion below still sees exactly the one project terminal.
  const createdPane = receipt.result.steps.find((step) => step.id === "tab_a")?.action?.pane_id;
  assert.ok(typeof createdPane === "string" && createdPane.length > 0, "workflow did not report a created pane");
  assert.equal(await window.evaluate((paneId) => window.codex.closeTerminal(paneId), createdPane), true);

  // --- agent.fork: 事务式托管 worktree（对标 Nebula git_worktree.rs + agent.fork） ---
  const forkRepo = join(testRoot, "fork-repo");
  await rm(forkRepo, { recursive: true, force: true });
  await mkdir(forkRepo, { recursive: true });
  execFileSync("git", ["-C", forkRepo, "init", "--initial-branch=main"], { windowsHide: true });
  writeFileSync(join(forkRepo, "tracked.txt"), "tracked");
  execFileSync("git", ["-C", forkRepo, "add", "tracked.txt"], { windowsHide: true });
  execFileSync("git", ["-C", forkRepo, "-c", "user.name=Workflow Test", "-c", "user.email=workflow@example.invalid", "commit", "-m", "initial"], { windowsHide: true });
  const forkEndpoint = join(userData, "runtime-endpoint.json");
  const forkReceipt = JSON.parse(execFileSync(process.execPath, [join(root, "scripts", "runtime-ctl.mjs"), "agent.fork", "--name", "reviewer", "--kind", "codex", "--source-cwd", forkRepo, "--branch", "nebula/reviewer", "--endpoint", forkEndpoint], { encoding: "utf8" }));
  assert.equal(forkReceipt.ok, true, JSON.stringify(forkReceipt.error || forkReceipt.result));
  const forkAction = forkReceipt.result;
  assert.ok(typeof forkAction.pane_id === "string" && forkAction.pane_id.length > 0);
  const forkProvenance = forkAction.worktree;
  assert.ok(forkProvenance && typeof forkProvenance.path === "string");
  assert.equal(forkProvenance.branch, "nebula/reviewer");
  assert.equal(String(forkProvenance.source_root).replaceAll("\\", "/"), String(forkRepo).replaceAll("\\", "/"));
  assert.equal(String(forkProvenance.repo_root).replaceAll("\\", "/"), String(forkRepo).replaceAll("\\", "/"));
  assert.equal(forkProvenance.created, true);
  assert.ok(existsSync(join(forkProvenance.path, "tracked.txt")));
  const forkSnapshot = JSON.parse(execFileSync(process.execPath, [join(root, "scripts", "runtime-ctl.mjs"), "snapshot", "--endpoint", forkEndpoint], { encoding: "utf8" }));
  assert.equal(forkSnapshot.ok, true, JSON.stringify(forkSnapshot.error));
  const forkPane = forkSnapshot.result.panes.find((pane) => pane.pane_id === forkAction.pane_id);
  assert.ok(forkPane, "agent.fork pane must appear in the runtime snapshot");
  assert.equal(forkPane.cwd, forkProvenance.path);
  // 已确认成功 → 资源保留（提交语义）；关闭 pane 后 worktree 与分支仍在
  assert.ok(existsSync(forkProvenance.path));
  assert.doesNotThrow(() => execFileSync("git", ["-C", forkRepo, "show-ref", "--verify", "--quiet", "refs/heads/nebula/reviewer"], { windowsHide: true }));
  assert.equal(await window.evaluate((paneId) => window.codex.closeTerminal(paneId), forkAction.pane_id), true);
  assert.ok(existsSync(forkProvenance.path));
  assert.doesNotThrow(() => execFileSync("git", ["-C", forkRepo, "show-ref", "--verify", "--quiet", "refs/heads/nebula/reviewer"], { windowsHide: true }));
  // 脏工作区未显式允许 → 拒绝且不创建分支
  writeFileSync(join(forkRepo, "untracked.txt"), "dirty");
  const dirtyResult = spawnSync(process.execPath, [join(root, "scripts", "runtime-ctl.mjs"), "agent.fork", "--name", "dirty-agent", "--kind", "codex", "--source-cwd", forkRepo, "--branch", "nebula/dirty-agent", "--endpoint", forkEndpoint], { encoding: "utf8", timeout: 10_000 });
  assert.notEqual(dirtyResult.status, 0, dirtyResult.stdout);
  const dirtyReceipt = JSON.parse(dirtyResult.stdout);
  assert.equal(dirtyReceipt.ok, false);
  assert.equal(dirtyReceipt.error.code, "dirty_source");
  assert.throws(() => execFileSync("git", ["-C", forkRepo, "show-ref", "--verify", "--quiet", "refs/heads/nebula/dirty-agent"], { windowsHide: true }));
  console.log("electron-agent-fork: transactional worktree creation, commit, and dirty-source rejection passed");

} finally {
  await app.close();
}

const restoredApp = await electron.launch({
  executablePath: electronPath,
  args: [root],
  cwd: root,
  env: electronEnv,
  timeout: 30_000,
});

try {
  const window = await restoredApp.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  await window.getByRole("tab", { name: "终端" }).waitFor({ timeout: 15_000 });
  await window.getByRole("tab", { name: "终端" }).click();
  await window.locator(".xterm-screen").waitFor({ timeout: 15_000 });
  assert.equal(await window.evaluate(async () => (await window.codex.listTerminals()).length), 1);
  assert.match(await window.locator(".terminal-tab, .terminal-top-tab").first().textContent(), /codex-ui/);
  console.log("electron-restore: terminal snapshot recreated the project tab after restart");
} finally {
  await restoredApp.close();
  try { execFileSync("powershell.exe", ["-NoProfile", "-Command", `Remove-Item -LiteralPath '${shellStartupRegistry}' -Recurse -Force -ErrorAction SilentlyContinue`], { windowsHide: true }); } catch {}
}

// --- 崩溃隔离：连续崩溃后快照被隔离，UI 显示横幅且不恢复标签 ---
const quarantineUserData = join(testRoot, "quarantine-user-data");
await rm(quarantineUserData, { recursive: true, force: true });
await mkdir(quarantineUserData, { recursive: true });
writeFileSync(join(quarantineUserData, "terminal-runtime.json"), JSON.stringify({ cleanExit: false, failures: 2, startedAt: Date.now() }), "utf8");
writeFileSync(join(quarantineUserData, "terminal-sessions.json"), JSON.stringify({ version: 1, sessions: [] }), "utf8");

const quarantineApp = await electron.launch({
  executablePath: electronPath,
  args: [root],
  cwd: root,
  env: { ...electronEnv, CODEX_UI_USER_DATA_DIR: quarantineUserData },
  timeout: 30_000,
});

try {
  const qWindow = await quarantineApp.firstWindow();
  await qWindow.waitForLoadState("domcontentloaded");
  await qWindow.locator(".terminal-quarantine").waitFor({ timeout: 15_000 });
  assert.match(await qWindow.locator(".terminal-quarantine strong").textContent(), /会话快照已隔离/);
  const qStatus = await qWindow.evaluate(async () => window.codex.getTerminalQuarantineStatus());
  assert.equal(qStatus.quarantined, true);
  assert.ok(typeof qStatus.snapshotPath === "string" && qStatus.snapshotPath.includes("terminal-sessions.crashed-"));
  assert.equal(await qWindow.evaluate(async () => (await window.codex.listTerminals()).length), 0);
  await qWindow.getByTitle("知道了").click();
  await qWindow.waitForFunction(() => document.querySelectorAll(".terminal-quarantine").length === 0);
  console.log("electron-quarantine: 崩溃隔离横幅显示/关闭与快照隔离通过");
} finally {
  await quarantineApp.close();
}
