import { basename } from "node:path";
import type { ShellProfile } from "../src/types";

interface LaunchShellProfile extends Pick<ShellProfile, "id" | "kind"> {
  args: string[];
}

export function terminalShellArguments(profile: LaunchShellProfile, cwd: string, loadShellProfile: boolean) {
  const args = profile.kind === "powershell" && loadShellProfile
    ? profile.args.filter((arg) => arg.toLowerCase() !== "-noprofile")
    : [...profile.args];
  if (profile.kind !== "wsl") return args;

  const distro = profile.id.startsWith("wsl:")
    ? Buffer.from(profile.id.slice(4), "base64url").toString("utf8")
    : "";
  const normalized = cwd.replaceAll("/", "\\");
  const unc = normalized.match(/^\\\\(?:wsl\$|wsl\.localhost)\\([^\\]+)(.*)$/i);
  const target = unc && (!distro || unc[1].toLowerCase() === distro.toLowerCase())
    ? `/${unc[2].replace(/^\\+/, "").replaceAll("\\", "/")}`
    : cwd;
  return [...args, "--cd", target || "/"];
}

export function terminalTitleFromPath(cwd: string) {
  return basename(cwd) || cwd.replace(/[\\/]+$/, "") || "Terminal";
}
