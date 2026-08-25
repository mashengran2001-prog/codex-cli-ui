import assert from "node:assert/strict";
import {
  normalizeJumpHost,
  normalizeKeepAliveInterval,
  normalizeKeepAliveMax,
  normalizePreferredAuth,
  normalizeProxyCommand,
  sshProfileTarget,
  sshTransportOptions,
} from "../dist-electron/electron/ssh-utils.js";

const base = {
  id: "s1",
  name: "prod",
  host: "example.com",
  port: 22,
  username: "ops",
  createdAt: 0,
  updatedAt: 0,
  source: "saved",
};

// 目标串
const targetBase = { ...base };
delete targetBase.username;
assert.equal(sshProfileTarget(targetBase), "example.com");
assert.equal(sshProfileTarget({ ...base }), "ops@example.com");

// 跳板机：-J 单跳
{
  const args = sshTransportOptions({ ...base, jumpHost: "bastion:2222" });
  assert.deepEqual(args, ["-J", "bastion:2222"]);
  const argsUser = sshTransportOptions({ ...base, jumpHost: "jump@bastion" });
  assert.deepEqual(argsUser, ["-J", "jump@bastion"]);
}

// 代理命令：-o ProxyCommand
{
  const args = sshTransportOptions({ ...base, proxyCommand: "ssh -W %h:%p jump@proxy" });
  assert.deepEqual(args, ["-o", "ProxyCommand=ssh -W %h:%p jump@proxy"]);
}

// 跳板机优先于代理命令（对标上游 ProxyJump 优先）
{
  const args = sshTransportOptions({ ...base, jumpHost: "jump@bastion", proxyCommand: "nc %h %p" });
  assert.equal(args[0], "-J");
  assert.ok(!args.some((arg) => arg.includes("ProxyCommand")));
}

// 保活：间隔 >0 时同时给出 ServerAliveInterval 与 ServerAliveCountMax（默认 6）
{
  const args = sshTransportOptions({ ...base, keepAliveInterval: 30 });
  assert.deepEqual(args, ["-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=6"]);
  const argsCustom = sshTransportOptions({ ...base, keepAliveInterval: 15, keepAliveMax: 3 });
  assert.deepEqual(argsCustom, ["-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"]);
}

// 保活：0 = 显式关闭
{
  const args = sshTransportOptions({ ...base, keepAliveInterval: 0 });
  assert.deepEqual(args, ["-o", "ServerAliveInterval=0"]);
}

// 认证偏好：auto 不输出，指定方式输出 -o PreferredAuthentications
{
  assert.deepEqual(sshTransportOptions({ ...base, preferredAuth: "auto" }), []);
  assert.deepEqual(sshTransportOptions({ ...base, preferredAuth: "publickey" }), ["-o", "PreferredAuthentications=publickey"]);
  assert.deepEqual(sshTransportOptions({ ...base, preferredAuth: "keyboard-interactive" }), ["-o", "PreferredAuthentications=keyboard-interactive"]);
}

// 私钥
{
  const args = sshTransportOptions({ ...base, identityFile: "C:\\keys\\id_ed25519" });
  assert.deepEqual(args, ["-i", "C:\\keys\\id_ed25519"]);
  const argsMulti = sshTransportOptions({ ...base, identityFiles: ["a", "b"] });
  assert.deepEqual(argsMulti, ["-i", "a", "-i", "b"]);
}

// 归一化：空值视为未设置
assert.equal(normalizeJumpHost(""), undefined);
assert.equal(normalizeJumpHost("  "), undefined);
assert.equal(normalizeProxyCommand(""), undefined);
assert.equal(normalizeKeepAliveInterval(""), undefined);
assert.equal(normalizeKeepAliveMax(undefined), undefined);
assert.equal(normalizePreferredAuth("auto"), "auto");

// 归一化：合法值
assert.equal(normalizeJumpHost("user@bastion:2222"), "user@bastion:2222");
assert.equal(normalizeProxyCommand("ssh -W %h:%p j@b"), "ssh -W %h:%p j@b");
assert.equal(normalizeKeepAliveInterval(30), 30);
assert.equal(normalizeKeepAliveMax(6), 6);
assert.equal(normalizePreferredAuth("password"), "password");

// 归一化：非法值拒绝
assert.throws(() => normalizeJumpHost("a,b"), /多级跳板/);
assert.throws(() => normalizeJumpHost("a\nb"), /格式无效/);
assert.throws(() => normalizeJumpHost("a".repeat(300)), /格式无效/);
assert.throws(() => normalizeProxyCommand("a\0b"), /格式无效/);
assert.throws(() => normalizeKeepAliveInterval(-1), /保活间隔/);
assert.throws(() => normalizeKeepAliveInterval(86_401), /保活间隔/);
assert.throws(() => normalizeKeepAliveInterval(1.5), /保活间隔/);
assert.throws(() => normalizeKeepAliveMax(0), /保活最大失败次数/);
assert.throws(() => normalizePreferredAuth("gssapi"), /认证方式无效/);

console.log("ssh-utils.mjs ok");
