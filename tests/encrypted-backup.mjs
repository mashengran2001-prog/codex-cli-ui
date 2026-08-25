import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKUP_MAGIC,
  collect,
  exportBackup,
  open,
  restoreBackup,
  safeArchivePath,
  seal,
  sanitizeSshBytes,
  sanitizeSettingsBytes,
  validateArchive,
} from "../dist-electron/electron/encrypted-backup.js";

const PASS = "correct horse battery";
let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log("ok -", name);
  } catch (error) {
    failures += 1;
    console.error("FAIL -", name, "-", error && error.message);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    console.log("ok -", name);
  } catch (error) {
    failures += 1;
    console.error("FAIL -", name, "-", error && error.message);
  }
}

function makeUserData() {
  const root = mkdtempSync(join(tmpdir(), "codex-ui-backup-"));
  mkdirSync(join(root, "fonts"), { recursive: true });
  writeFileSync(join(root, "settings.json"), JSON.stringify({
    theme: "nebula",
    language: "zh-CN",
    proxyUrl: "http://127.0.0.1:7890",
    proxyBypass: "localhost",
    proxyPassword: "secret-proxy",
  }, null, 2), "utf8");
  writeFileSync(join(root, "ssh-profiles.json"), JSON.stringify({
    version: 1,
    profiles: [
      { id: "1", name: "prod", host: "example.com", private_keys: ["C:\\keys\\id_rsa"], identityFiles: ["C:\\keys\\id_rsa"], proxy: { host: "p", port: 1080 }, password: "hunter2" },
      { id: "2", name: "dev", host: "dev.local" },
    ],
  }, null, 2), "utf8");
  writeFileSync(join(root, "directory-history.json"), JSON.stringify({ entries: [{ path: "C:\work", rank: 1 }] }), "utf8");
  writeFileSync(join(root, "terminal-history.jsonl"), JSON.stringify({ command: "codex", cwd: "C:\work", at: 1 }) + "\n", "utf8");
  writeFileSync(join(root, "fonts", "Cascadia.ttf"), Buffer.from("fake-font-bytes"));
  return root;
}

check("safeArchivePath rejects traversal", () => {
  assert.throws(() => safeArchivePath("C:\\data", "../evil"));
  assert.throws(() => safeArchivePath("C:\\data", "a/../../evil"));
  assert.throws(() => safeArchivePath("C:\\data", "C:\\absolute"));
  assert.throws(() => safeArchivePath("C:\\data", "\\\\server\\share"));
  assert.throws(() => safeArchivePath("C:\\data", ""));
  assert.equal(safeArchivePath("C:\\data", "fonts/a.ttf"), join("C:\\data", "fonts", "a.ttf"));
});

check("sanitizeSettings strips secrets", () => {
  const out = Buffer.from(sanitizeSettingsBytes(Buffer.from(JSON.stringify({ proxyUrl: "x", proxyPassword: "y", theme: "coal" }), "utf8"))).toString("utf8");
  assert.equal(JSON.parse(out).proxyUrl, undefined);
  assert.equal(JSON.parse(out).proxyPassword, undefined);
  assert.equal(JSON.parse(out).theme, "coal");
});

check("sanitizeSsh strips private keys and proxy", () => {
  const out = JSON.parse(Buffer.from(sanitizeSshBytes(Buffer.from(JSON.stringify({ profiles: [{ id: "1", private_keys: ["k"], identityFiles: ["k"], proxy: { host: "p" }, password: "pw", host: "h" }] }), "utf8"))).toString("utf8"));
  const profile = out.profiles[0];
  assert.equal(profile.private_keys, undefined);
  assert.equal(profile.identityFiles, undefined);
  assert.equal(profile.proxy, undefined);
  assert.equal(profile.password, undefined);
  assert.equal(profile.host, "h");
});

await checkAsync("seal/open roundtrip", async () => {
  const root = makeUserData();
  try {
    const selection = { appearance: true, config: true, ssh: true, session: true, directory_history: true, command_history: true, fonts: true };
    const archive = await collect(root, selection);
    const packet = await seal(archive, PASS);
    assert.ok(packet.length > BACKUP_MAGIC.length + 16 + 12);
    assert.equal(packet.subarray(0, 8).toString("ascii"), "NEBUBAK1");
    const opened = await open(packet, PASS);
    assert.equal(opened.manifest.version, 1);
    const names = opened.entries.map((entry) => entry.name).sort();
    assert.deepEqual(names, ["directory-history.json", "fonts/Cascadia.ttf", "settings.json", "ssh-profiles.json", "terminal-history.jsonl"]);
    const settings = opened.entries.find((entry) => entry.name === "settings.json");
    assert.equal(JSON.parse(Buffer.from(settings.bytes).toString("utf8")).proxyPassword, undefined);
    const ssh = opened.entries.find((entry) => entry.name === "ssh-profiles.json");
    const profiles = JSON.parse(Buffer.from(ssh.bytes).toString("utf8")).profiles;
    assert.equal(profiles[0].private_keys, undefined);
    assert.equal(profiles[0].password, undefined);
    assert.equal(profiles[0].host, "example.com");
    assert.equal(profiles[1].host, "dev.local");
    assert.equal(packet.includes(Buffer.from("secret-proxy")), false);
    assert.equal(packet.includes(Buffer.from("hunter2")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await checkAsync("wrong passphrase rejected", async () => {
  const root = makeUserData();
  try {
    const archive = await collect(root, { appearance: true, config: false, ssh: false, session: false, directory_history: false, command_history: false, fonts: false });
    const packet = await seal(archive, PASS);
    await assert.rejects(() => open(packet, "wrong password!!"));
    await assert.rejects(() => open(packet, "short"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await checkAsync("tampered packet rejected", async () => {
  const root = makeUserData();
  try {
    const archive = await collect(root, { appearance: true, config: false, ssh: false, session: false, directory_history: false, command_history: false, fonts: false });
    const packet = await seal(archive, PASS);
    const badMagic = Buffer.from(packet);
    badMagic[0] = "X".charCodeAt(0);
    await assert.rejects(() => open(badMagic, PASS));
    const tampered = Buffer.from(packet);
    tampered[tampered.length - 1] ^= 0xff;
    await assert.rejects(() => open(tampered, PASS));
    const badAad = Buffer.from(packet);
    badAad[badAad.length - 2] ^= 0x01;
    await assert.rejects(() => open(badAad, PASS));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await checkAsync("validateArchive rejects traversal entries", async () => {
  const root = makeUserData();
  try {
    const archive = {
      manifest: { version: 1, categories: ["appearance"] },
      entries: [{ category: "appearance", name: "../evil.json", bytes: Buffer.from("{}") }],
    };
    assert.throws(() => validateArchive(archive));
    await assert.rejects(() => seal(archive, PASS));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await checkAsync("validateArchive rejects disallowed entry names", async () => {
  assert.throws(() => validateArchive({
    manifest: { version: 1, categories: ["appearance"] },
    entries: [{ category: "appearance", name: "other.json", bytes: Buffer.from("{}") }],
  }));
  assert.throws(() => validateArchive({
    manifest: { version: 1, categories: ["ssh"] },
    entries: [{ category: "ssh", name: "ssh-profiles.json", bytes: Buffer.from(JSON.stringify({ profiles: [{ id: "1", private_keys: ["x"] }] })) }],
  }));
  assert.throws(() => validateArchive({
    manifest: { version: 1, categories: ["config"] },
    entries: [{ category: "config", name: "cli-profiles.json", bytes: Buffer.from("not json") }],
  }));
});

await checkAsync("exportBackup writes packet and restoreBackup restores atomically", async () => {
  const root = makeUserData();
  const outDir = mkdtempSync(join(tmpdir(), "codex-ui-backup-out-"));
  try {
    const outPath = join(outDir, "test.nebula-backup");
    const selection = { appearance: true, config: false, ssh: true, session: false, directory_history: true, command_history: true, fonts: true };
    const result = await exportBackup(root, selection, PASS, outPath);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(readFileSync(outPath).subarray(0, 8).toString("ascii"), "NEBUBAK1");

    writeFileSync(join(root, "settings.json"), JSON.stringify({ theme: "silver" }), "utf8");
    writeFileSync(join(root, "ssh-profiles.json"), JSON.stringify({ profiles: [] }), "utf8");
    writeFileSync(join(root, "fonts", "Cascadia.ttf"), Buffer.from("changed"));
    writeFileSync(join(root, "directory-history.json"), JSON.stringify({ entries: [] }), "utf8");

    const restored = await restoreBackup(root, PASS, outPath);
    assert.equal(restored.ok, true, JSON.stringify(restored));
    assert.equal(JSON.parse(readFileSync(join(root, "settings.json"), "utf8")).theme, "nebula");
    const profiles = JSON.parse(readFileSync(join(root, "ssh-profiles.json"), "utf8")).profiles;
    assert.equal(profiles[0].host, "example.com");
    assert.equal(profiles[0].private_keys, undefined);
    assert.equal(readFileSync(join(root, "fonts", "Cascadia.ttf")).toString(), "fake-font-bytes");
    assert.equal(readFileSync(join(root, "directory-history.json"), "utf8").includes("C:\work"), true);
    const leftovers = readdirSync(root).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

await checkAsync("restore rejects traversal archives without writing", async () => {
  const root = makeUserData();
  try {
    assert.throws(() => validateArchive({ manifest: { version: 1, categories: ["appearance"] }, entries: [{ category: "appearance", name: "../escaped.json", bytes: Buffer.from("{}") }] }));
    const before = readFileSync(join(root, "settings.json"), "utf8");
    const result = await restoreBackup(root, PASS, join(root, "bad.nebula-backup"));
    assert.equal(result.ok, false);
    assert.equal(readFileSync(join(root, "settings.json"), "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await checkAsync("restoreBackup reports errors without throwing", async () => {
  const root = makeUserData();
  try {
    const result = await restoreBackup(root, PASS, join(root, "missing.nebula-backup"));
    assert.equal(result.ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

if (failures > 0) {
  console.error(`encrypted-backup: ${failures} failure(s)`);
  process.exit(1);
}
console.log("encrypted-backup: all checks passed");