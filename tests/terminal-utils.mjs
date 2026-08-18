import assert from "node:assert/strict";
import { terminalShellArguments, terminalTitleFromPath } from "../dist-electron/electron/terminal-utils.js";

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
