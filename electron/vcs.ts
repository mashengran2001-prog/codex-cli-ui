import type { GitActionRequest, GitStatusEntry } from "../src/types";

/** Repository kinds the workbench panel can talk to. */
export type VcsKind = "git" | "svn";

/**
 * Parse `svn status` text into drawer entries.
 *
 * Plain `svn status` prints one line per change with seven status columns
 * followed by a space and the (working-copy-root relative) path, e.g.
 * `M       src/main.rs`. The first column is the item state, the second is
 * the property state, so the combined code mirrors the Git drawer's two
 * character codes while staying readable for a single change.
 */
export function parseSvnStatus(stdout: string): GitStatusEntry[] {
  const entries: GitStatusEntry[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    if (!raw || raw.startsWith("Status against revision")) continue;
    const line = raw.replace(/\s+$/, "");
    if (!line) continue;
    const code = line.slice(0, 7).trim() || "?";
    const path = line.slice(7).trim();
    if (!path) continue;
    entries.push({ status: code.slice(0, 2) || "?", path });
  }
  return entries;
}

/** Parse the revision number from plain `svn info` output, e.g. "Revision: 123". */
export function parseSvnRevision(stdout: string): string | null {
  const match = stdout.match(/^Revision:\s*(\d+)\s*$/m);
  return match ? match[1] : null;
}

/** Parse the working-copy root from plain `svn info` output. */
export function parseSvnWorkingCopyRoot(stdout: string): string | null {
  const match = stdout.match(/^Working Copy Root Path:\s*(.+)$/m);
  return match ? match[1].trim() : null;
}

/**
 * Restrict working-copy-relative entries to a subtree of the working copy.
 * `scopePrefix` is the drawer root relative to the WC root ("" for the WC
 * root itself, "sub/dir" for a nested project). Entries outside the scope are
 * dropped and the rest are rewritten to be drawer-root relative.
 */
export function scopeSvnEntries(entries: GitStatusEntry[], scopePrefix: string): GitStatusEntry[] {
  const prefix = scopePrefix.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!prefix) return entries;
  const needle = `${prefix}/`;
  return entries
    .filter((entry) => entry.path === prefix || entry.path.startsWith(needle))
    .map((entry) => (entry.path === prefix ? { ...entry, path: "." } : { ...entry, path: entry.path.slice(needle.length) }));
}

/**
 * Translate a drawer action into an `svn` argument list.
 *
 * Callers run the result with the working-copy root as the process cwd, so
 * relative entry paths work unchanged. Actions that make no sense for a
 * centralized VCS (pull/push) or need a selection (revert) return an error
 * string instead of arguments.
 */
export function svnActionArgs(request: Pick<GitActionRequest, "action" | "paths" | "message">): { args?: string[]; error?: string } {
  const paths = (request.paths || []).filter((path) => path.length > 0 && path.length < 4096);
  switch (request.action) {
    case "stage":
      return { args: paths.length ? ["add", "--force", ...paths] : ["add", "--force", "."] };
    case "unstage":
      return paths.length
        ? { args: ["revert", ...paths] }
        : { error: "请先选择要还原的文件" };
    case "commit": {
      const message = request.message?.trim();
      if (!message || message.length > 5_000) return { error: "提交说明不能为空" };
      return { args: paths.length ? ["commit", "-m", message, ...paths] : ["commit", "-m", message] };
    }
    case "update":
      return { args: ["update", "--non-interactive"] };
    case "pull":
    case "push":
      return { error: "SVN 仓库不支持拉取/推送，请使用更新与提交" };
    default:
      return { error: "Unsupported SVN action" };
  }
}
