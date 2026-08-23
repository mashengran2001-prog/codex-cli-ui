import { execFile } from "node:child_process";

const FALLBACK_FONT_FAMILIES = [
  "Cascadia Mono",
  "Cascadia Code",
  "Consolas",
  "JetBrains Mono",
  "Menlo",
  "Monaco",
  "DejaVu Sans Mono",
];

function run(file: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 15_000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout));
    });
  });
}

export function normalizeSystemFontNames(values: unknown[]): string[] {
  const unique = new Map<string, string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const name = value.trim().replace(/\.(?:ttf|otf|ttc|otc|woff2?)$/i, "");
    if (!name || name.length > 160 || /[\r\n\0]/.test(name)) continue;
    const key = name.toLocaleLowerCase();
    if (!unique.has(key)) unique.set(key, name);
  }
  return [...unique.values()].sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }));
}

export function parseWindowsFontList(stdout: string): string[] {
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    return normalizeSystemFontNames(Array.isArray(parsed) ? parsed : [parsed]);
  } catch {
    return [];
  }
}

export function parseFontconfigList(stdout: string): string[] {
  return normalizeSystemFontNames(stdout.split(/\r?\n/).flatMap((line) => line.split(",")));
}

function collectMacFontFamilies(value: unknown, output: string[]) {
  if (Array.isArray(value)) {
    for (const item of value) collectMacFontFamilies(item, output);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  for (const key of ["family", "family_name", "familyName"]) {
    if (typeof record[key] === "string") output.push(record[key]);
  }
  for (const item of Object.values(record)) collectMacFontFamilies(item, output);
}

export function parseMacFontList(stdout: string): string[] {
  try {
    const output: string[] = [];
    collectMacFontFamilies(JSON.parse(stdout), output);
    return normalizeSystemFontNames(output);
  } catch {
    return [];
  }
}

export async function enumerateSystemFonts(platform = process.platform): Promise<string[]> {
  let fonts: string[] = [];
  try {
    if (platform === "win32") {
      const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
      const powershell = `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
      const script = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Drawing; $c = New-Object System.Drawing.Text.InstalledFontCollection; @($c.Families | ForEach-Object { $_.Name }) | Sort-Object -Unique | ConvertTo-Json -Compress";
      fonts = parseWindowsFontList(await run(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script]));
    } else if (platform === "darwin") {
      fonts = parseMacFontList(await run("system_profiler", ["SPFontsDataType", "-json"]));
    } else {
      fonts = parseFontconfigList(await run("fc-list", ["--format=%{family}\\n"]));
    }
  } catch {
    // The picker remains usable on minimal systems without a font enumeration command.
  }
  return fonts.length ? fonts : FALLBACK_FONT_FAMILIES;
}
