import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  downloadToFile,
  parseSha256AssetContent,
  parseSha256Checksum,
  pickInstallerAsset,
  sanitizeFileName,
  validatePeHeader,
  verifyInstallerFile,
} from "../dist-electron/electron/update-manager.js";

// ---- 安装包挑选 ----
assert.equal(pickInstallerAsset([]), undefined);
assert.equal(pickInstallerAsset(null), undefined);
assert.equal(pickInstallerAsset([{ name: "README.txt", size: 1, url: "https://x" }]), undefined);

const exeOnly = [{ name: "codex-cli-ui.exe", size: 10, url: "https://x/exe" }];
assert.equal(pickInstallerAsset(exeOnly)?.name, "codex-cli-ui.exe");

const mixed = [
  { name: "codex-cli-ui-portable.exe", size: 10, url: "https://x/p" },
  { name: "codex-cli-ui-setup.exe", size: 10, url: "https://x/s" },
  { name: "checksums.sha256", size: 1, url: "https://x/c" },
];
assert.equal(pickInstallerAsset(mixed)?.name, "codex-cli-ui-setup.exe");
const noSetup = mixed.filter((asset) => asset.name === "codex-cli-ui-portable.exe");
assert.equal(pickInstallerAsset(noSetup)?.name, "codex-cli-ui-portable.exe");

// ---- PE 头校验 ----
function makePe(size = 0x1000, peOffset = 0x80, withMZ = true) {
  const buf = Buffer.alloc(size);
  if (withMZ) buf.write("MZ", 0, "ascii");
  if (peOffset >= 0 && peOffset + 4 <= size) {
    buf.writeUInt32LE(peOffset, 0x3c);
    buf.write("PE\0\0", peOffset, "ascii");
  }
  return buf;
}
assert.equal(validatePeHeader(makePe(0x1000)), true);
assert.equal(validatePeHeader(makePe(0x44, 0x40)), true);
assert.equal(validatePeHeader(makePe(0x3f)), false);
assert.equal(validatePeHeader(makePe(0x1000, 0x80, false)), false);
assert.equal(validatePeHeader(makePe(0x1000, 0x1000)), false);

// ---- SHA-256 解析 ----
const hex = "a".repeat(64);
assert.equal(parseSha256Checksum(`SHA-256: ${hex.toUpperCase()}`), hex);
assert.equal(parseSha256Checksum(`SHA256:${hex}`), hex);
assert.equal(parseSha256Checksum("sha-256: deadbeef"), undefined);
assert.equal(parseSha256Checksum(null), undefined);
assert.equal(parseSha256Checksum(undefined), undefined);
assert.equal(parseSha256AssetContent(`${hex}  Codex CLI UI Setup.exe\n`), hex);
assert.equal(parseSha256AssetContent("no checksum here"), undefined);
assert.equal(parseSha256AssetContent(null), undefined);

// ---- 文件名清洗 ----
assert.equal(sanitizeFileName("Codex CLI UI Setup 1.0.0.exe"), "Codex-CLI-UI-Setup-1.0.0.exe");
assert.equal(sanitizeFileName("a/b\\c:d?*.exe"), "a-b-c-d-.exe");
assert.equal(sanitizeFileName("...."), "update.exe");

// ---- 安装包校验 ----
const tmp = mkdtempSync(join(tmpdir(), "codex-update-test-"));
try {
  const installer = join(tmp, "fake-setup.exe");
  const bytes = makePe(0x1000);
  writeFileSync(installer, bytes);
  const sha = createHash("sha256").update(bytes).digest("hex");

  const ok = await verifyInstallerFile(installer, bytes.length, sha);
  assert.equal(ok.ok, true);
  assert.equal(ok.sha256, sha);

  const badSize = await verifyInstallerFile(installer, bytes.length + 1, sha);
  assert.equal(badSize.ok, false);
  assert.match(badSize.error ?? "", /大小不匹配/);

  const badSha = await verifyInstallerFile(installer, bytes.length, "f".repeat(64));
  assert.equal(badSha.ok, false);
  assert.match(badSha.error ?? "", /SHA-256/);

  const garbage = join(tmp, "garbage.exe");
  writeFileSync(garbage, Buffer.from("not an executable"));
  const badHeader = await verifyInstallerFile(garbage, undefined, undefined);
  assert.equal(badHeader.ok, false);
  assert.match(badHeader.error ?? "", /PE 头|过小/);

  // 不传 sha 时仅做大小 + PE 头校验
  const noSha = await verifyInstallerFile(installer, bytes.length, undefined);
  assert.equal(noSha.ok, true);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// ---- 流式下载（本地 HTTP 服务器，含进度与长度校验）----
const payload = Buffer.from("MZ fake download payload");
const server = createServer((_req, res) => {
  res.writeHead(200, { "Content-Length": String(payload.length) });
  res.end(payload);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const tmp2 = mkdtempSync(join(tmpdir(), "codex-update-dl-"));
try {
  const port = server.address().port;
  const dest = join(tmp2, "installer.exe");
  const progress = [];
  await downloadToFile(`http://127.0.0.1:${port}/installer.exe`, dest, (received, total) => progress.push({ received, total }));
  assert.deepEqual(progress.at(-1), { received: payload.length, total: payload.length });
  assert.deepEqual(readFileSync(dest), payload);

  await assert.rejects(
    downloadToFile("http://127.0.0.1:65534/not-found.exe", join(tmp2, "never.exe")),
    /下载失败 HTTP|fetch failed|ECONNREFUSED|Failed to fetch/,
  );
} finally {
  server.close();
  rmSync(tmp2, { recursive: true, force: true });
}

console.log("update-manager tests passed");