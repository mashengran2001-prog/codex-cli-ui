# Codex CLI UI 使用手册

一个本地优先的 Windows CLI 工作台，用 Electron + React + TypeScript 统一运行 Codex、Claude Code、DeepSeek Harness 等命令行工具，并提供 Nebula 风格的终端、分屏、标签与设置体验。

> 本文档对应仓库 `mashengran2001-prog/codex-cli-ui`。界面语言支持简体中文与 English（设置 → 外观 → 界面语言）。

---

## 1. 启动应用

### 1.1 开发模式（改代码时用）

```powershell
cd "F:\codex pro\codex-ui"
npm install        # 首次运行前安装依赖
npm run dev
```

- 开发服务器固定使用端口 **4321**，占用时会直接报错退出（见第 12 节“端口被占用”）。
- 首次启动可能稍慢：主进程会非阻塞探测 PowerShell / CMD / Git Bash / WSL 发行版，窗口先显示，Shell 列表随后补齐。

### 1.2 直接运行成品（日常使用推荐）

```powershell
npm run launch     # 先构建再启动 Electron
```

或者双击已经打包好的可执行文件：

```
F:\codex pro\codex-ui\release\win-unpacked\Codex CLI UI.exe
```

成品模式不占用 4321 端口，启动也更快。

### 1.3 制作安装包 / 便携版

```powershell
npm run dist
```

产物输出到 `release\`：

- `Codex CLI UI Setup x.x.x.exe`（NSIS 安装包，可自选安装目录）
- `Codex CLI UI Portable x.x.x.exe`（便携版，解压即用）

### 1.4 关闭窗口与托盘

关闭窗口默认最小化到托盘，**不会终止正在运行的终端进程**。点击托盘图标恢复窗口；托盘菜单可直达任意终端标签。完全退出请使用托盘菜单的退出项（退出时会终止 PTY 进程）。

---

## 2. 首次使用：选择工作目录

打开应用后进入空工作台，有两个入口：

1. **选择工作目录**：打开系统文件夹对话框，选一个文件夹（例如你的项目目录），应用会：
   - 建立“项目”（Project）
   - 自动创建一个新会话并进入对话界面
   - 后续可在该项目下新建多个会话
2. **WSL 发行版**：如果你的电脑装有 WSL，点击后列出已注册的发行版（如 Ubuntu、Debian），选中即可：
   - 以 `\\wsl.localhost\<发行版>` 为工作目录建立项目
   - 直接进入对话界面；终端、文件面板、命令补全都会自动跟随 WSL 路径

> 提示：在“常用目录”抽屉里也能看到 WSL 根目录的快捷入口，收藏后下次一键进入。

---

## 3. 界面布局

- **左侧栏**：项目列表与会话列表；终端模式下是终端标签（默认侧边，可在设置里改成顶部）。
- **中部工作区**：对话 / 终端 / 设置，可切换。
- **右侧抽屉**：文件（Files）、常用目录、Git 状态，可拖拽调整宽度，拖到很窄会自动收起。

右上角三点菜单收纳常用操作：设置、命令面板、新建终端、分屏等（与 Nebula 一致，设置页以单例标签打开，不会出现两套三点菜单）。

---

## 4. AI 对话

### 4.1 支持的 CLI / Provider

内置 Provider：

- **Codex**（OpenAI，`codex` 命令）
- **Claude Code**（Anthropic，`claude` 命令）
- **Gemini**、**OpenCode**
- **DeepSeek Harness**（检测、安装提示、SDK 会话入口）
- 任意自定义命令：在设置 → CLI 工具中配置命令与参数

在侧栏或顶部切换 Provider；每个 Provider 有独立的会话列表。

### 4.2 发送任务

在底部输入框输入提示词，回车或点发送按钮即可：

- 可切换**模型**与**推理强度**（按 Provider 能力显示）
- 可切换**沙箱模式**：只读 / 工作目录写 / 完全访问
- 可附加**图片**（支持图片的模型）
- 运行中可随时**停止**（Stop）
- 任务输出按“回答 / 推理 / 命令 / 文件 / Web 活动”分块展示，命令块可展开查看执行详情

### 4.3 会话状态与恢复

- 标签/侧栏会显示 AI 回合四种状态：**运行中**（转圈）、**已完成**（圆点）、**等待输入**（三角）、**失败**（红叉）
- 重启应用后，恢复出的标签会自动重敲 `codex resume <id>` / `claude --resume <id>` 接续上次会话（设置 → AI 可关闭）
- 右键运行中的 AI 标签：**继续上次 AI 会话** 或 **分叉 AI 会话**（把当前对话复制成一个新标签）

### 4.4 Claude Code Provider（cc-switch 与桌面版同步）

**自动识别与认证**

- 自动查找本机 `claude` 命令（优先 npm 全局包里的原生 `claude.exe`；也可用 `CLAUDE_UI_CLI_PATH` 指定路径）
- 若检测到 `~/.claude/settings.json` 的 `env`（例如 cc-switch 写入的 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` 与模型覆盖），Provider 会**显式继承**该配置并删除全局 `ANTHROPIC_API_KEY`，避免代理模式下被全局密钥抢占导致 403
- Provider 会探测 `ANTHROPIC_BASE_URL` 指向的本地端口；cc-switch 未运行时侧栏会明确提示“cc-switch 代理未运行”，若保存过 API Key 会自动回退使用，无需改配置
- 未使用 cc-switch 时，可在侧栏 Claude 的 Provider 区输入 Anthropic API Key，加密保存在本机
- 会话通过 `claude -p --output-format stream-json --verbose` 以结构化事件流运行，界面解析为回答 / 推理 / 工具调用；`CLAUDE_CODE_MAX_RETRIES=0`，认证失败时不会长时间重试卡住

**Claude Desktop 会话同步**

- Claude Desktop 内嵌的 Claude Code 对话与 CLI **共用同一份本地转录**（`~/.claude/projects/<项目>/<会话id>.jsonl`），因此 Claude Provider 天然就能列出并打开桌面版产生的会话，可继续对话或分叉
- 对于本机没有 jsonl 转录的桌面版会话，UI 会扫描 `%LOCALAPPDATA%\Claude-3p\claude-code-sessions` 与 `Packages\Claude*\LocalCache\Roaming\Claude\claude-code-sessions` 的 `local_*.json` 元数据，补出标题 / 时间 / 模型，侧栏显示“桌面版”徽标；这类会话只同步元数据，打开后提示新建 CLI 会话继续
- 会话按**项目目录聚合**：项目下会同时列出该项目目录及其**子目录**里的 Claude 会话（含桌面版），无需为每个子目录单独建项目；会话仍保留各自的工作目录
- 本地没有转录时不会误传 `--resume`，而是自动开启新会话

---

## 5. 终端

### 5.1 打开终端

- 点击工作区顶部的“终端”视图
- `Ctrl+Shift+T` 新建终端标签
- `Ctrl+Shift+D` 向右分屏、`Ctrl+Shift+E` 向下分屏
- 全局 `Ctrl + 反引号` 呼出/隐藏快速终端（任何窗口都能用）

### 5.2 Shell 自动发现

自动发现并列为可选项：**PowerShell 7 / Windows PowerShell / CMD / Git Bash / WSL 发行版 / Nushell**。新建终端时选择即可，无需配置。

### 5.3 分屏与标签

- 最多 **四分屏**；把标签拖到 pane 边缘或舞台边缘即可停靠分屏
- 分屏树会持久化，重启后按原布局恢复；命令面板里可一键重置布局
- 标签操作：
  - **中键点击**标签关闭
  - 右键标签：重命名、7 色颜色标记、导出会话、继续/分叉 AI 会话
  - 标签可拖拽排序；新标签插入位置（当前标签之后 / 列表末尾）可在设置中配置
- 顶部标签模式支持选择、拖拽排序、停靠、分屏与水平自动滚动

### 5.4 终端内交互

| 操作 | 方式 |
| --- | --- |
| 选中复制 | 拖选即复制（可在设置关闭） |
| 复制 / 粘贴 | `Ctrl+Shift+C` / `Ctrl+Shift+V`，或右键菜单 |
| 搜索 | `Ctrl+F` |
| 缩放 | `Ctrl++` / `Ctrl+-` / `Ctrl+0` |
| 打开文件 / URL | 终端内路径与链接可点击；`Ctrl` + 悬停预览，`Ctrl` + 点击在资源管理器/浏览器打开 |
| 行内图片 | 支持 OSC 1337 行内图片（`imgcat` 等输出） |
| 粘贴截图 | 剪贴板只有图片时，粘贴会写出 PNG 并粘贴路径；SSH 会话先上传远端再粘贴远端路径 |
| 拖入文件 | 从文件抽屉拖文件/文件夹到终端，自动按当前 Shell 转义路径 |
| 广播输入 | 分屏数大于 1 时开启，把输入同时发给同标签所有 pane |
| 铃声 | 终端 BEL 可触发系统提示音，设置里可选关 / 闪烁 / 声音 / 两者 |

---

## 6. 文件与常用目录

- **Files 抽屉**：浏览当前项目目录，支持：
  - Markdown / GFM 富文本、KaTeX 数学公式
  - JSON / 纯文本 / 日志带行号查看
  - 图片单独开标签查看
  - 非图片文档（Markdown / JSON / 文本 / 日志）在**终端 pane 内分屏打开**，与终端并存，可关闭、可拖拽调整宽度
  - 点击文件/目录在终端中打开或跳转
- **常用目录抽屉**：
  - 自动按使用频率排序（frecency）
  - 收藏目录（固定在最前）
  - 一键在目录中新建终端
  - 移除历史记录
  - WSL 根目录也会出现在这里

---

## 7. Git / SVN

Git 状态抽屉支持：

- stage / unstage、commit、pull、push
- 兼容 WSL 或其它用户所有的仓库（自动加 `safe.directory=*`）
- 纯 SVN 仓库显示为 SVN 面板：状态、版本号、更新（update）、取消暂存等（以实际检测到的版本库类型为准）

---

## 8. SSH / SFTP

- 设置 → SSH：管理主机、导入 `~/.ssh/config`、四阶段连接测试（解析 / TCP / 认证 / 会话）
- 支持 SSH agent、IdentityFile、known_hosts 与交互式认证
- 新建 SSH 终端标签：选主机后进入远端 Shell
- SFTP 抽屉：浏览远端文件、上传/下载（批量操作要求密钥或 agent 可无交互认证）
- 连接失败时，在“关闭”按钮左侧会出现**重试**按钮，原位替换失败的 pane

---

## 9. 设置

设置以单例标签打开（右上角三点 → 设置，或 `Ctrl+,`）。主要分区：

| 分区 | 内容 |
| --- | --- |
| 外观 | 七套明暗主题、界面语言（跟随系统 / 简体中文 / English）、密度（紧凑/适中/舒适）、背景图片/透明度/模糊、字符宽度、强调色取色盘 |
| 字体 | 所见即所得字体选择器：每个字体族用自身字形预览，支持逗号分隔 fallback 链，中文字体可回退 |
| 终端 | 默认 Shell、打开配置文件入口、光标样式/闪烁、Powerline 提示符、新标签插入位置、标签栏位置（侧边/顶部）、铃声模式、终端回放恢复 |
| 快捷键 | 录制自定义键位：命令面板、新终端、分屏、快速终端、打开设置；支持搜索与冲突检测，一键恢复默认 |
| AI / Provider | 自动接续 AI 会话（resume）、Provider 凭证、CLI 工具检测与安装 |
| 启动集成 | PowerShell launcher、打开 PowerShell/CMD 时唤起工作台 |
| 通知 | 完成通知（90 秒自动关闭）、托盘 agent 提醒、CLI 生命周期 |
| 代理 | 代理地址与绕过列表（仅注入工作台内启动的 CLI 子进程） |
| 关于 | 版本、检查更新（GitHub Releases）、诊断（运行时长、崩溃恢复状态、输入延迟探针、启动日志目录） |

非默认值标记：设置项若被改过，行尾会显示“已修改”圆点，改回默认即消失，方便排查配置。

---

## 10. 从 PowerShell / CMD 直接唤起 UI

### 10.1 安装 launcher（推荐）

```powershell
npm run install:launcher
```

安装后**重开 PowerShell**，直接敲：

```powershell
codex "检查这个项目"
codex -m gpt-5.6-terra "修复测试"
codex-raw --version
```

- `codex ...`：自动打开 UI，并把当前目录、提示词、`-m` 模型带进界面
- `codex-raw ...`：保留原始终端 CLI，不弹 UI
- 安装器只维护 PowerShell profile 中 `# >>> codex-cli-ui >>>` 与 `# <<< codex-cli-ui <<<` 之间的区块，覆盖前会生成 `.codex-cli-ui.bak` 备份

卸载：

```powershell
npm run uninstall:launcher
```

### 10.2 打开 PowerShell/CMD 时唤起工作台

设置 → 启动集成 → 开启“打开 PowerShell/CMD 时唤起工作台”。开启后，新开的 PowerShell/CMD 会自动唤起（或聚焦）工作台窗口。该集成只维护自己的 profile / AutoRun 标记，应用内置终端通过环境变量自动跳过，不会无限弹窗；关闭后恢复原配置。

---

## 11. 环境变量与命令行参数

| 变量 | 作用 |
| --- | --- |
| `CODEX_UI_CLI_PATH` | 指定 Codex 可执行文件路径 |
| `CODEX_UI_CLI_PREFIX_ARGS` | JSON 字符串数组，放在 Codex 参数前 |
| `CODEX_UI_CODEX_HOME` | 指定只读扫描的 Codex 数据目录 |
| `CODEX_UI_USER_DATA_DIR` | 指定 Electron 用户数据目录 |
| `CODEX_UI_BOOT_TRACE=1` | 把启动阶段日志写入用户数据目录的 `boot-trace.log` |

---

## 12. 常见问题

### 12.1 端口 4321 被占用（`npm run dev` 报错）

说明上次的 dev 进程没退干净。找到并结束占用进程：

```powershell
Get-NetTCPConnection -LocalPort 4321 -State Listen | Select-Object OwningProcess
Stop-Process -Id <进程号> -Force
```

或者不使用 dev 模式：直接运行 `release\win-unpacked\Codex CLI UI.exe`，不占该端口。

### 12.2 启动慢 / 终端列表出现得慢

WSL 与 Shell 探测是非阻塞的，窗口会先显示，列表稍后补齐。若持续很慢，可设置 `CODEX_UI_BOOT_TRACE=1` 后查看 `boot-trace.log` 定位。

### 12.3 找不到 WSL 发行版

先确认系统已启用 WSL 且至少安装了一个发行版：

```powershell
wsl --list --quiet
```

有输出即正常；没有则先在 PowerShell 里执行 `wsl --install` 安装。

### 12.4 Codex 提示未登录 / 启动失败

UI 直接调用你本机安装的 Codex CLI，请先确认命令行可用且已登录：

```powershell
codex --version
codex login
```

### 12.5 为什么关闭窗口后终端还在运行

这是设计行为：关闭窗口默认最小化到托盘，终端进程不受影响；重新打开 UI 会附着到原有标签与回放缓冲。应用**完全退出**时 PTY 才会终止。

### 12.6 Claude 提示“cc-switch 代理未运行”

先确认 cc-switch 是否已启动（它通过 `~/.claude/settings.json` 的 env 注入本地代理）。未启动时：

- 侧栏 Claude 的 Provider 区会明确显示代理未运行
- 若之前在侧栏保存过 Anthropic API Key，发送任务会自动回退使用该 Key
- 否则先启动 cc-switch，或在侧栏 Claude 的凭据框里填写 API Key

### 12.7 修改源码后如何验证

```powershell
npm run build    # 类型检查 + 前端构建
npm test         # 全量测试（真实子进程/终端/UI 回归）
```

测试使用隔离的 fake Codex 与临时 session 目录，不会调用模型、不会修改真实历史。

---

## 13. 开发速查

```powershell
npm install              # 安装依赖
npm run dev              # 开发模式（Vite 4321 + Electron）
npm run typecheck        # 仅类型检查
npm run build            # 类型检查 + 生产构建（dist + dist-electron）
npm run test:workflow    # 构建 + 浏览器工作流测试
npm run test:visual      # 构建 + 视觉冒烟测试
npm test                 # 全量回归
npm run dist             # 打包安装包与便携版（release/）
npm run install:launcher # 安装 PowerShell 自动唤起
npm run uninstall:launcher
```

测试覆盖：终端 PTY 生命周期、标签/分屏/拖拽恢复、AI 回合状态、launcher 集成、SVN/Git、SSH、WSL、Runtime 控制（命名 agent / 进程树 / 控制键）、Agent worktree、剪贴板与导出、更新检查、设置持久化与视觉冒烟。