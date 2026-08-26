# 分发接入：winget 与 scoop

对标 Nebula #47（自动更新或 scoop/winget 更新）。应用内已验证更新已实现；本目录提供
winget / scoop 分发所需清单与说明，并在应用内接入"安装来源探测 + 启动包管理器升级"。

## 发布前的替换占位符

- packaging/winget/*.yaml 与 packaging/scoop/codex-cli-ui.json 中的 0.2.0 版本号
  与 InstallerUrl / url 需替换为实际 GitHub Release 资产。
- 安装包文件名以 npm run dist（electron-builder）实际产物为准：
  NSIS 安装包形如 Codex CLI UI Setup <版本>.exe，portable 形如
  Codex CLI UI Portable <版本>.exe。URL 中的空格建议写为 %20。
- InstallerSha256 用发布资产的 SHA-256 填写（也可由仓库 CI 自动计算后回填）。

## 提交到官方源

1. winget：把 packaging/winget 下三个清单按版本目录结构提交到
   winget-pkgs 的 manifests/c/CodexCLIUI/CodexCLIUI/<版本>/。
2. scoop：把 packaging/scoop/codex-cli-ui.json 提交到目标 bucket
   （如 ScoopInstaller/Extras）的 bucket/ 目录。

提交后即对应用户通过 winget install CodexCLIUI.CodexCLIUI 或
scoop install codex-cli-ui 安装。

## 应用内行为

- 启动包管理器探测（updates:package-manager IPC，10 分钟缓存）：
  - 检查 winget --version 与 winget list --id CodexCLIUI.CodexCLIUI；
  - 检查 scoop --version 与 scoop list codex-cli-ui。
- 检查更新发现新版本时，若本应用确实由 winget/scoop 安装，更新提醒与设置页"关于"区
  会提供"通过 winget/scoop 升级"入口（updates:package-manager-run），
  在独立控制台窗口启动对应升级命令；未检测到包管理器时回退原有应用内下载。
- 测试环境可用 CODEX_UI_PACKAGE_MANAGER_DISABLE=1 关闭真实探测。
