import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createPopulatedPage, launchBrowser, root, startPreview } from "./browser-harness.mjs";

const artifacts = join(root, "artifacts");
await mkdir(artifacts, { recursive: true });
const server = await startPreview(4323);
const browser = await launchBrowser();

try {
  const desktop = await createPopulatedPage(browser, server.url, { width: 1380, height: 880 });
  await desktop.page.screenshot({ path: join(artifacts, "codex-ui-desktop.png"), fullPage: true });
  const desktopMetrics = await desktop.page.evaluate(() => {
    const composer = document.querySelector(".composer").getBoundingClientRect();
    const sidebar = document.querySelector(".sidebar").getBoundingClientRect();
    const body = document.body.getBoundingClientRect();
    return { composer, sidebar, body, text: document.body.innerText.length };
  });
  assert.ok(desktopMetrics.composer.width > 600);
  assert.ok(desktopMetrics.sidebar.width >= 238);
  assert.ok(desktopMetrics.text > 150);
  await desktop.context.close();

  const compact = await createPopulatedPage(browser, server.url, { width: 800, height: 720 });
  await compact.page.screenshot({ path: join(artifacts, "codex-ui-compact.png"), fullPage: true });
  const compactMetrics = await compact.page.evaluate(() => {
    const shell = document.querySelector(".app-shell");
    const toolbar = document.querySelector(".composer-toolbar").getBoundingClientRect();
    const send = document.querySelector(".send-button").getBoundingClientRect();
    const options = document.querySelector(".composer-options").getBoundingClientRect();
    return {
      overflow: shell.scrollWidth - shell.clientWidth,
      toolbarHeight: toolbar.height,
      sendLeft: send.left,
      optionsRight: options.right,
      sendVisible: send.right <= window.innerWidth && send.left >= 0,
    };
  });
  assert.ok(compactMetrics.overflow <= 1, `compact layout overflowed by ${compactMetrics.overflow}px`);
  assert.ok(compactMetrics.toolbarHeight >= 40);
  assert.ok(compactMetrics.sendVisible);
  assert.ok(compactMetrics.optionsRight <= compactMetrics.sendLeft + 1, "composer controls overlap send button");
  await compact.context.close();
  console.log("visual-smoke: desktop and 800px layouts passed");
} finally {
  await browser.close();
  server.stop();
}
