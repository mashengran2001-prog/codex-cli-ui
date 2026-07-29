import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { _electron as electron } from "playwright";
import electronPath from "electron";
import { createElectronFixture, launcherArgs } from "./electron-fixture.mjs";
import { root } from "./browser-harness.mjs";

const testRoot = join(root, ".tmp", "electron-visual");
const codexHome = join(testRoot, "codex-home");
const userData = join(testRoot, "user-data");
const artifacts = join(root, "artifacts");
await rm(testRoot, { recursive: true, force: true });
await mkdir(artifacts, { recursive: true });
await createElectronFixture(root, codexHome);

const app = await electron.launch({
  executablePath: electronPath,
  args: [root, ...launcherArgs(root, "Review the renderer layout")],
  cwd: root,
  env: {
    ...process.env,
    CODEX_UI_CLI_PATH: process.execPath,
    CODEX_UI_CLI_PREFIX_ARGS: JSON.stringify([join(root, "tests", "fake-codex.mjs")]),
    CODEX_UI_CODEX_HOME: codexHome,
    CODEX_UI_USER_DATA_DIR: userData,
    TEMP: join(root, ".tmp"),
    TMP: join(root, ".tmp"),
  },
  timeout: 30_000,
});

try {
  const window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  await window.locator("textarea").waitFor({ timeout: 15_000 });
  await window.locator(".send-button").click();
  await window.getByText(/Completed from fake Codex/).waitFor({ timeout: 15_000 });
  await window.screenshot({ path: join(artifacts, "codex-ui-electron.png") });
  const metrics = await window.evaluate(() => {
    const shell = document.querySelector(".app-shell");
    const composer = document.querySelector(".composer").getBoundingClientRect();
    return { overflow: shell.scrollWidth - shell.clientWidth, composerWidth: composer.width, bodyText: document.body.innerText.length };
  });
  assert.ok(metrics.overflow <= 1);
  assert.ok(metrics.composerWidth > 600);
  assert.ok(metrics.bodyText > 150);
  console.log("electron-visual: real Electron window screenshot and layout checks passed");
} finally {
  await app.close();
}
