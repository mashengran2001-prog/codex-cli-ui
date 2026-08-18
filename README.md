# Codex CLI UI

一个本地优先的 Windows CLI 工作台，用 Electron、React 和 TypeScript 统一运行 Codex、Claude Code、DeepSeek Harness 和其他命令行工具。

## 已实现

- 以工作目录组织项目，每个项目支持多个独立 Codex thread
- Provider 架构承载结构化对话；Codex 保持原有行为，DeepSeek Harness 提供检测、安装提示、SDK 会话入口
- 内置 Codex、Claude Code、Gemini、OpenCode、DeepSeek Harness，并可添加任意命令和参数
- 只读发现并恢复 `CODEX_HOME/sessions` 中的现有会话
- 通过 `codex exec --json` 展示回答、推理、命令、文件、MCP 和 Web 活动
- 支持模型、推理强度、只读/工作区/完全访问沙箱、图片附件和主动停止
- Windows ConPTY 常驻终端：隐藏窗口不终止进程、单实例、冷启动恢复和崩溃循环隔离
- 终端标签侧栏、拖拽排序、最多四分屏、拖拽停靠、后台活动/等待输入状态和点击直达通知
- PowerShell 7、Windows PowerShell、CMD、Git Bash 与已注册 WSL 发行版自动发现
- 分组与最近使用命令面板、全局 Ctrl + 反引号键快速终端、终端内搜索、Web/OSC 8 链接和 OSC 1337 行内图片
- 终端支持选中复制、右键复制/粘贴，以及从文件抽屉拖入经过当前 Shell 安全转义的路径
- JSONL 命令历史、前缀幽灵补全、Powerline 提示符、OSC 133 生命周期跟踪和合并式 resize
- SSH 主机管理、`~/.ssh/config` 导入、四阶段连接测试、交互式 SSH 标签和 SFTP 文件抽屉
- Files 抽屉、Markdown/GFM/JSON/文本预览、KaTeX 数学公式，以及 Git stage/unstage/commit/pull/push
- 七套明暗主题、背景图片/透明度/模糊、可拖拽侧栏与抽屉、设置持久化
- 跟随系统、简体中文和 English 三种界面语言
- Codex notify 与 Claude hooks 统一管理，保留已有钩子链并在配置被覆盖后自动修复
- PowerShell 中运行 `codex` 自动打开 UI；`codex-raw` 保留原始终端 CLI
- CLI 中的当前目录、普通 prompt 和 `-m/--model` 会带入 UI

应用不提供托管后端、不收集 telemetry，也不会把导入的会话正文复制到 `localStorage`。历史正文始终从 Codex 自己的 session JSONL 读取。

## 环境

- Windows 10/11
- Node.js 22 或更高版本
- 已安装并完成登录的 Codex CLI

## Codex Nebula 终端

在会话标题栏点击终端图标进入全宽终端工作区。终端由 Electron 主进程中的 `node-pty` 驱动，Windows 下使用 ConPTY；关闭窗口到托盘不会中断终端进程，重新打开 UI 会附着到原有标签和回放缓冲。

- `Ctrl+Shift+P` 打开命令面板；`Ctrl+Shift+T` 新建终端；`Ctrl+Shift+D` 向右分屏
- 终端内 `Ctrl+F` 搜索，`Ctrl+Shift+C/V` 复制粘贴，`Ctrl++/-/0` 缩放
- 全局 Ctrl + 反引号键显示或隐藏快速终端
- SFTP 使用系统 OpenSSH 的 `ssh.exe` / `sftp.exe`，支持 SSH agent、IdentityFile、known_hosts 和交互式 SSH 认证；批量文件操作要求密钥或 agent 可无交互认证
- 应用完全退出时 PTY 会终止；冷启动恢复标签、工作目录、Shell 和 SSH profile，不会伪装成恢复已结束的进程
- 设置 `CODEX_UI_BOOT_TRACE=1` 可将启动阶段写入用户数据目录的 `boot-trace.log`

功能设计参考 [Kuddev/nebula](https://github.com/Kuddev/nebula) 的终端工作流，使用本项目的 Electron/React 架构独立实现，没有复制其 Rust/GPL 源码。详细对照见 [Nebula 功能对照](docs/nebula-parity.md)。项目本身使用 [MIT License](LICENSE)。

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

测试使用隔离的 fake Codex 和临时 session 目录，不会调用模型或修改真实 Codex 历史；Electron 工作流会启动隔离的 PowerShell PTY，验证真实终端输入、输出和冷启动恢复。

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

`node-pty` 使用与 Electron ABI 匹配的 Windows 预构建模块，构建配置会将其从 ASAR 中解包。发布前建议同时运行 `npm test` 和 unpacked 产物的 ConPTY smoke test。
