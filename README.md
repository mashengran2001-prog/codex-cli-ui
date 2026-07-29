# Codex CLI UI

一个本地优先的 Windows 桌面界面，用 Electron、React 和 TypeScript 调用本机已经安装并登录的 Codex CLI。

## 已实现

- 以工作目录组织项目，每个项目支持多个独立 Codex thread
- 只读发现并恢复 `CODEX_HOME/sessions` 中的现有会话
- 通过 `codex exec --json` 展示回答、推理、命令、文件、MCP 和 Web 活动
- 支持模型、推理强度、只读/工作区/完全访问沙箱、图片附件和主动停止
- 支持后台运行、任务完成通知、工作目录与终端快捷操作
- PowerShell 中运行 `codex` 自动打开 UI；`codex-raw` 保留原始终端 CLI
- CLI 中的当前目录、普通 prompt 和 `-m/--model` 会带入 UI

应用不提供托管后端、不收集 telemetry，也不会把导入的会话正文复制到 `localStorage`。历史正文始终从 Codex 自己的 session JSONL 读取。

## 环境

- Windows 10/11
- Node.js 22 或更高版本
- 已安装并完成登录的 Codex CLI

## 开发

```powershell
npm install
npm run dev
```

生产构建和测试：

```powershell
npm run build
npm test
```

测试使用隔离的 fake Codex 和临时 session 目录，不会调用模型或修改真实 Codex 历史。

## 自动打开 UI

安装 PowerShell launcher：

```powershell
npm run install:launcher
```

重新打开 PowerShell 后：

```powershell
codex "检查这个项目"
codex -m gpt-5.6-terra "修复测试"
codex-raw --version
```

安装器只维护 PowerShell profile 中以下两个标记之间的区块，并在覆盖前创建 `.codex-cli-ui.bak` 备份：

```text
# >>> codex-cli-ui >>>
# <<< codex-cli-ui <<<
```

卸载 launcher：

```powershell
npm run uninstall:launcher
```

## 配置覆盖

- `CODEX_UI_CLI_PATH`: 指定 Codex 可执行文件
- `CODEX_UI_CLI_PREFIX_ARGS`: JSON 字符串数组，放在 Codex 参数前
- `CODEX_UI_CODEX_HOME`: 指定只读扫描的 Codex 数据目录
- `CODEX_UI_USER_DATA_DIR`: 指定 Electron 用户数据目录

## 构建安装包

```powershell
npm run dist
```

输出位于 `release/`，包含 NSIS 安装包和 portable 版本。
