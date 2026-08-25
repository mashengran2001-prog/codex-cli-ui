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
// Fake Nushell for shell detection (Nebula v1.2 shell 分类注入): presence via PATH.
writeFileSync(join(fakeBin, "nu.exe"), "fake-nushell", "utf8");
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
  const detectedShells = await window.evaluate(async () => window.codex.listShells());
  assert.ok(detectedShells.some((shell) => shell.id === "nu" && shell.kind === "nushell" && shell.label === "Nushell"), JSON.stringify(detectedShells.map((shell) => ({ id: shell.id, kind: shell.kind }))));
  console.log("electron-shells: Nushell detected via PATH (Nebula v1.2 shell 分类注入)");

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
  await window.locator('.terminal-top-tab[data-tab-kind="settings"]').waitFor();
  await window.locator(".terminal-top-tab[data-session-id] .terminal-tab-main").first().click();
  await window.waitForFunction(() => document.querySelectorAll(".terminal-top-tabs").length === 1 && document.querySelectorAll(".terminal-side-tabs").length === 0);
  await window.locator(".xterm-helper-textarea").waitFor({ timeout: 15_000 });
  await window.locator(".xterm-helper-textarea").focus();
  await window.keyboard.type('Write-Output ("NEBULA" + "_PTY_OK")', { delay: 12 });
  await window.keyboard.press("Enter");
  await window.waitForFunction(() => document.querySelector(".xterm-rows")?.textContent?.includes("NEBULA_PTY_OK"), undefined, { timeout: 15_000 });
 assert.equal(await window.evaluate(async () => (await window.codex.listTerminals()).length), 1);
  // 通过真实终端执行官方 hook 脚本注入 CLI 生命周期事件（对标 Nebula runtime_task_state）：
  // 终端 PTY 环境自带 CODEX_UI_NOTIFY_PIPE / CODEX_UI_SESSION_ID，调用形态与生产 config.toml 的 notify 命令一致
  const aiTerminalId = (await window.evaluate(async () => (await window.codex.listTerminals())[0].id));
  const aiThreadId = "33333333-3333-4333-8333-333333333333";
  const lifecycleHookPath = join(root, "scripts", "cli-lifecycle-hook.ps1").replaceAll("'", "''");
  const waitForTerminal = async (match, label) => {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const terminals = await window.evaluate(async () => await window.codex.listTerminals());
      const terminal = terminals.find((item) => item.id === aiTerminalId);
      if (terminal && match(terminal)) return terminal;
      if (Date.now() > deadline) {
        const xtermText = await window.evaluate(() => document.querySelector(".xterm-rows")?.textContent ?? "");
        throw new Error(`${label} timeout; terminals=${JSON.stringify(terminals)}; xterm=${JSON.stringify(xtermText.slice(-600))}`);
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
  };
  const injectHookEvent = async (hookEventName) => {
    const payload = JSON.stringify({ hook_event_name: hookEventName, thread_id: aiThreadId });
    // payload 经管道 stdin 传给 hook，避开 Windows 原生 argv 对双引号 JSON 的破坏（hook 对 codex 无位置参数时读 stdin）
    const command = `'${payload}' | powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File '${lifecycleHookPath}' -Source codex -Marker codex-cli-ui-hook-v1`;
    await window.evaluate(async ([id, cmd]) => window.codex.writeTerminal(id, `${cmd}\r`), [aiTerminalId, command]);
  };
  await injectHookEvent("UserPromptSubmit");
  await waitForTerminal((terminal) => terminal?.aiSource === "codex" && terminal?.aiSessionId === aiThreadId && terminal?.aiTaskState === "running", "ai running");
  await injectHookEvent("Stop");
  await waitForTerminal((terminal) => terminal?.aiSource === "codex" && terminal?.aiSessionId === aiThreadId && terminal?.aiTaskState === "finished", "ai finished");
  // 触发设置持久化（同时排队保存终端快照），确保 AI 身份随快照跨重启
  await window.evaluate(async () => window.codex.setAppSettings(await window.codex.getAppSettings()));
  const snapshotPath = join(userData, "terminal-sessions.json");
  const snapshotDeadline = Date.now() + 15_000;
  while (Date.now() < snapshotDeadline) {
    try {
      const rawSnapshot = readFileSync(snapshotPath, "utf8");
      if (rawSnapshot.includes(aiThreadId) && rawSnapshot.includes('"aiSource": "codex"')) break;
    } catch { /* snapshot not written yet */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  }
  assert.ok(readFileSync(snapshotPath, "utf8").includes(aiThreadId), `terminal snapshot must persist AI identity before restart (${snapshotPath})`);
  console.log("electron-ai-identity: hook in real terminal marked the project terminal as a codex session");
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
    // 图片单独开标签查看（对标 Nebula open_image_tab）：文件树双击 PNG 进入图片文档标签
    await window.getByRole("button", { name: "文件", exact: true }).click();
    const probeRow = window.locator(".file-row").filter({ hasText: "probe-img-test.png" });
    await probeRow.waitFor({ timeout: 10_000 });
    await probeRow.click();
    await window.locator(".document-viewer").waitFor({ timeout: 10_000 });
    const imageDocSrc = await window.locator(".document-viewer img.document-image").getAttribute("src");
    assert.match(imageDocSrc ?? "", /^data:image\/png;base64,/);
    assert.equal(await window.locator(".document-viewer").count(), 1);
    await window.getByTitle("关闭文档").click();
    await window.locator(".terminal-pane-leaf").waitFor();
    console.log("electron-image: image opens as its own document tab");
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
  await window.locator('.terminal-top-tab[data-tab-kind="settings"] .terminal-tab-close').click();
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
  assert.ok(describe.result.capabilities.includes("agents.list"));
  assert.ok(describe.result.capabilities.includes("agent.wait"));
  assert.ok(describe.result.capabilities.includes("pane.procs"));
  assert.ok(describe.result.capabilities.includes("pane.send_key"));
  assert.ok(describe.result.capabilities.includes("events.pane_lifecycle"));
  // Runtime orchestrate 测试使用专用普通终端：项目终端此时带 AI 身份（finished），按 Nebula 语义 pane 状态保持 finished 而非 idle
  const runtimeTerminalId = await window.evaluate(async (cwd) => (await window.codex.createTerminal({ cwd, cols: 100, rows: 30, shellId: "powershell", reuseExisting: false })).id, root);
  let runtimePane;
  {
    const paneDeadline = Date.now() + 10_000;
    while (Date.now() < paneDeadline) {
      const runtimeSnapshotProbe = JSON.parse(execFileSync(process.execPath, [join(root, "scripts", "runtime-ctl.mjs"), "snapshot", "--endpoint", runtimeEndpointPath], { encoding: "utf8" }));
      runtimePane = runtimeSnapshotProbe.result.panes.find((pane) => pane.pane_id === runtimeTerminalId);
      if (runtimePane) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  assert.ok(runtimePane && runtimePane.pane_id, "runtime snapshot should expose the dedicated runtime pane");
  // 等待专用终端进入 idle，避免 PowerShell 启动期状态抖动影响 revision 稳定性断言
  const waitIdle = JSON.parse(execFileSync(process.execPath, [join(root, "scripts", "runtime-ctl.mjs"), "pane.wait", "--pane", runtimeTerminalId, "--state", "idle", "--timeout-ms", "8000", "--endpoint", runtimeEndpointPath], { encoding: "utf8" }));
  assert.equal(waitIdle.ok, true, JSON.stringify(waitIdle.error));
  const runtimeSnapshot = JSON.parse(execFileSync(process.execPath, [join(root, "scripts", "runtime-ctl.mjs"), "snapshot", "--endpoint", runtimeEndpointPath], { encoding: "utf8" }));
  // 修订号语义（对标 Nebula RuntimeHub::publish）：语义状态未变化时重复快照保持同一 revision
  const runtimeSnapshotRepeat = JSON.parse(execFileSync(process.execPath, [join(root, "scripts", "runtime-ctl.mjs"), "snapshot", "--endpoint", runtimeEndpointPath], { encoding: "utf8" }));
  assert.equal(runtimeSnapshotRepeat.result.revision, runtimeSnapshot.result.revision);
  // window.create 不假装成功：单窗口 runtime 返回 runtime_unavailable
  const windowCreateRun = spawnSync(process.execPath, [join(root, "scripts", "runtime-ctl.mjs"), "window.create", "--endpoint", runtimeEndpointPath], { encoding: "utf8" });
  assert.equal(windowCreateRun.status, 1, windowCreateRun.stderr);
  const windowCreate = JSON.parse(windowCreateRun.stdout);
  assert.equal(windowCreate.ok, false, JSON.stringify(windowCreate.error));
  assert.equal(windowCreate.error.code, "runtime_unavailable");
  const processTree = JSON.parse(execFileSync(process.execPath, [join(root, "scripts", "runtime-ctl.mjs"), "pane.procs", "--pane", runtimePane.pane_id, "--endpoint", runtimeEndpointPath], { encoding: "utf8" }));
  assert.equal(processTree.ok, true, JSON.stringify(processTree.error));
  assert.equal(processTree.result.pane_id, runtimePane.pane_id);
  assert.ok(Array.isArray(processTree.result.processes) && processTree.result.processes.length >= 1);
  const keyResult = JSON.parse(execFileSync(process.execPath, [join(root, "scripts", "runtime-ctl.mjs"), "pane.send_key", "--pane", runtimePane.pane_id, "--key", "c", "--control", "--endpoint", runtimeEndpointPath], { encoding: "utf8" }));
  assert.equal(keyResult.ok, true, JSON.stringify(keyResult.error));
  assert.ok(keyResult.result.bytes_sent >= 1);
  const waitResult = JSON.parse(execFileSync(process.execPath, [join(root, "scripts", "runtime-ctl.mjs"), "pane.wait", "--pane", runtimePane.pane_id, "--state", "idle", "--timeout-ms", "5000", "--endpoint", runtimeEndpointPath], { encoding: "utf8" }));
  assert.equal(waitResult.ok, true, JSON.stringify(waitResult.error));
  const lifecycleResult = JSON.parse(execFileSync(process.execPath, [join(root, "scripts", "runtime-ctl.mjs"), "snapshot", "--endpoint", runtimeEndpointPath], { encoding: "utf8" }));
  assert.ok(Array.isArray(lifecycleResult.result.pane_lifecycles) && lifecycleResult.result.pane_lifecycles.some((event) => event.event === "created"));
  const subscribeResult = JSON.parse(execFileSync(process.execPath, [join(root, "scripts", "runtime-ctl.mjs"), "events.subscribe", "--since-seq", "0", "--timeout-ms", "1000", "--endpoint", runtimeEndpointPath], { encoding: "utf8" }));
  assert.equal(subscribeResult.ok, true, JSON.stringify(subscribeResult.error));
  assert.ok(Array.isArray(subscribeResult.result.events) && subscribeResult.result.events.length >= 1);
  const startAgent = JSON.parse(execFileSync(process.execPath, [join(root, "scripts", "runtime-ctl.mjs"), "agent.start", "--name", "runtime-agent", "--kind", "codex", "--cwd", root, "--endpoint", runtimeEndpointPath], { encoding: "utf8" }));
  assert.equal(startAgent.ok, true, JSON.stringify(startAgent.error));
  assert.equal(startAgent.result.agent.name, "runtime-agent");
  assert.equal(startAgent.result.agent.kind, "codex");
  assert.equal(typeof startAgent.result.agent.generation, "number");
  const agentGeneration = String(startAgent.result.agent.generation);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const agentsList = JSON.parse(execFileSync(process.execPath, [join(root, "scripts", "runtime-ctl.mjs"), "agents.list", "--endpoint", runtimeEndpointPath], { encoding: "utf8" }));
  assert.equal(agentsList.ok, true, JSON.stringify(agentsList.error));
  assert.ok(agentsList.result.agents.some((agent) => agent.name === "runtime-agent"));
  // 新 Agent pane 是语义状态变化：revision 必须大于初始快照
  assert.ok(agentsList.result.revision > runtimeSnapshot.result.revision, `agents.list revision ${agentsList.result.revision} should exceed initial ${runtimeSnapshot.result.revision}`);
  const agentGet = JSON.parse(execFileSync(process.execPath, [join(root, "scripts", "runtime-ctl.mjs"), "agent.get", "--agent", "runtime-agent", "--generation", agentGeneration, "--endpoint", runtimeEndpointPath], { encoding: "utf8" }));
  assert.equal(agentGet.ok, true, JSON.stringify(agentGet.error));
  assert.equal(agentGet.result.agent.name, "runtime-agent");
  const agentRead = JSON.parse(execFileSync(process.execPath, [join(root, "scripts", "runtime-ctl.mjs"), "agent.read", "--agent", "runtime-agent", "--generation", agentGeneration, "--lines", "20", "--endpoint", runtimeEndpointPath], { encoding: "utf8" }));
  assert.equal(agentRead.ok, true, JSON.stringify(agentRead.error));
  const agentWait = JSON.parse(execFileSync(process.execPath, [join(root, "scripts", "runtime-ctl.mjs"), "agent.wait", "--agent", "runtime-agent", "--generation", agentGeneration, "--state", "idle", "--timeout-ms", "5000", "--endpoint", runtimeEndpointPath], { encoding: "utf8" }));
  assert.equal(agentWait.ok, true, JSON.stringify(agentWait.error));
  console.log("electron-runtime-orchestrate: named agents, process tree, control keys, waits, and lifecycle events passed");
  await window.evaluate((paneId) => window.codex.closeTerminal(paneId), startAgent.result.pane_id);

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
  const nonZero = spawnSync(process.execPath, [join(root, "scripts", "runtime-ctl.mjs"), "pane.run", "--pane", runtimePane.pane_id, "--command", "cmd /c exit 7", "--timeout-ms", "10000", "--endpoint", runtimeEndpointPath], { encoding: "utf8", timeout: 20_000 });
  assert.notEqual(nonZero.status, 0, nonZero.stdout);
  const nonZeroReceipt = JSON.parse(nonZero.stdout);
  assert.equal(nonZeroReceipt.ok, false);
  assert.equal(nonZeroReceipt.error.code, "command_failed");
  assert.equal(nonZeroReceipt.error.details.exit_code, 7, JSON.stringify(nonZeroReceipt));
  console.log("electron-runtime-exit-code: non-zero pane.run exit code preserved");
  // Runtime 专用终端用完即关，保证恢复断言仍只看到项目终端
  assert.equal(await window.evaluate((paneId) => window.codex.closeTerminal(paneId), runtimeTerminalId), true);

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

  // --- SSH 旧格式 user@host:port（Nebula v1.2 修复）：保存后拆分为 user/host/port ---
  const sshFormat = await window.evaluate(async () => {
    await window.codex.saveSshProfile({ name: "old-format", host: "dev@example.com:2222", username: "", port: 22 });
    const profiles = await window.codex.listSshProfiles();
    const found = profiles.find((item) => item.name === "old-format");
    if (!found) throw new Error("old-format profile was not persisted");
    return found;
  });
  assert.equal(sshFormat.host, "example.com", JSON.stringify(sshFormat));
  assert.equal(sshFormat.username, "dev", JSON.stringify(sshFormat));
  assert.equal(sshFormat.port, 2222, JSON.stringify(sshFormat));
  assert.equal(await window.evaluate((id) => window.codex.deleteSshProfile(id), sshFormat.id), true);
  console.log("electron-ssh-format: user@host:port normalization passed");

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
  // AI 对话跨重启接续：恢复出的终端自动重敲 codex resume（对标 Nebula resume 注入）
  await window.waitForFunction(() => (document.querySelector(".xterm-rows")?.textContent ?? "").includes("codex resume 33333333-3333-4333-8333-333333333333"), undefined, { timeout: 20_000 });
  console.log("electron-restore: terminal snapshot recreated the project tab and re-issued the AI resume command");
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
