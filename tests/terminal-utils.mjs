import assert from "node:assert/strict";
import { terminalShellArguments, terminalTitleFromPath, wslQuickDirectoryEntries } from "../dist-electron/electron/terminal-utils.js";

const powershell = {
  id: "pwsh",
  kind: "powershell",
  args: ["-NoLogo", "-NoProfile", "-NoExit", "-File", "integration.ps1"],
};
assert.ok(terminalShellArguments(powershell, "D:\\", false).includes("-NoProfile"));
assert.ok(!terminalShellArguments(powershell, "D:\\", true).includes("-NoProfile"));

const distro = "Arch Linux";
const wsl = {
  id: `wsl:${Buffer.from(distro).toString("base64url")}`,
  kind: "wsl",
  args: ["--distribution", distro],
};
assert.deepEqual(terminalShellArguments(wsl, "D:\\", false).slice(-2), ["--cd", "D:\\"]);
assert.deepEqual(
  terminalShellArguments(wsl, "\\\\wsl.localhost\\Arch Linux\\home\\codex", false).slice(-2),
  ["--cd", "/home/codex"],
);
assert.equal(terminalTitleFromPath("D:\\"), "D:");
assert.equal(terminalTitleFromPath("D:\\work\\codex-ui"), "codex-ui");

console.log("terminal-utils: PowerShell profile, drive roots, and WSL paths passed");

// WSL 发行版快捷目录：UNC 根、pinned、source=wsl、按发行版顺序置顶
const wslQuick = wslQuickDirectoryEntries(["Arch Linux", "Ubuntu"]);
assert.equal(wslQuick.length, 2);
assert.equal(wslQuick[0].path, "\\\\wsl.localhost\\Arch Linux");
assert.equal(wslQuick[1].path, "\\\\wsl.localhost\\Ubuntu");
assert.equal(wslQuick[0].pinned, true);
assert.equal(wslQuick[0].source, "wsl");
assert.ok(wslQuick[0].score > wslQuick[1].score);
assert.deepEqual(wslQuickDirectoryEntries([]), []);
