param(
  [ValidateSet("Status", "Install", "Uninstall")]
  [string]$Action = "Status",

  [string]$AppExecutable = "",
  [string]$ProjectRoot = "",
  [string]$LaunchScript = "",
  [string]$HookPath = "",
  [string]$WindowsPowerShellProfilePath = "",
  [string]$PowerShellProfilePath = "",
  [string]$RegistryPath = "HKCU:\Software\Microsoft\Command Processor"
)

$ErrorActionPreference = "Stop"
$startMarker = "# >>> codex-cli-ui-shell-startup >>>"
$endMarker = "# <<< codex-cli-ui-shell-startup <<<"
$documents = [Environment]::GetFolderPath("MyDocuments")
if (-not $documents) { $documents = Join-Path $HOME "Documents" }
if (-not $WindowsPowerShellProfilePath) { $WindowsPowerShellProfilePath = Join-Path $documents "WindowsPowerShell\profile.ps1" }
if (-not $PowerShellProfilePath) { $PowerShellProfilePath = Join-Path $documents "PowerShell\profile.ps1" }
if (-not $LaunchScript) { $LaunchScript = Join-Path $PSScriptRoot "launch-ui.ps1" }
if (-not $ProjectRoot) { $ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path }
if (-not $AppExecutable) { $AppExecutable = Join-Path $ProjectRoot "node_modules\electron\dist\electron.exe" }
if (-not $HookPath) { $HookPath = Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) "CodexCliUi\shell-startup.ps1" }
$cmdHookPath = [IO.Path]::ChangeExtension($HookPath, ".cmd")
$profilePaths = @($WindowsPowerShellProfilePath, $PowerShellProfilePath) | Select-Object -Unique
$cmdHookCommand = "call `"$cmdHookPath`""

function Get-FileText([string]$Path) {
  if (Test-Path -LiteralPath $Path -PathType Leaf) { return [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8) }
  return ""
}

function Remove-ProfileBlock([string]$Text) {
  $escapedStart = [Regex]::Escape($startMarker)
  $escapedEnd = [Regex]::Escape($endMarker)
  return [Regex]::Replace($Text, "(?ms)^$escapedStart\r?\n.*?^$escapedEnd\r?\n?", "").TrimEnd()
}

function Remove-CmdHook([string]$Text) {
  $value = $Text.Trim()
  if ($value.StartsWith($cmdHookCommand, [StringComparison]::OrdinalIgnoreCase)) {
    $value = $value.Substring($cmdHookCommand.Length).TrimStart()
    if ($value.StartsWith("&")) { $value = $value.Substring(1).TrimStart() }
  }
  return $value.Trim()
}

function Get-AutoRun {
  if (-not (Test-Path -LiteralPath $RegistryPath)) { return "" }
  $item = Get-ItemProperty -LiteralPath $RegistryPath -ErrorAction SilentlyContinue
  $property = $item.PSObject.Properties["AutoRun"]
  if ($property -and $null -ne $property.Value) { return [string]$property.Value }
  return ""
}

function Test-AutoRunProperty {
  if (-not (Test-Path -LiteralPath $RegistryPath)) { return $false }
  $item = Get-ItemProperty -LiteralPath $RegistryPath -ErrorAction SilentlyContinue
  return $null -ne $item.PSObject.Properties["AutoRun"]
}

function Write-Utf8([string]$Path, [string]$Text) {
  $directory = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $directory)) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
  [IO.File]::WriteAllText($Path, $Text, [Text.UTF8Encoding]::new($false))
}

function Escape-SingleQuoted([string]$Value) { return $Value.Replace("'", "''") }

function Get-Status {
  $powerShellInstalled = @($profilePaths | Where-Object {
    $text = Get-FileText $_
    $text.Contains($startMarker) -and $text.Contains($endMarker)
  }).Count -eq $profilePaths.Count
  $autoRun = Get-AutoRun
  $cmdInstalled = (Test-Path -LiteralPath $HookPath -PathType Leaf) -and
    (Test-Path -LiteralPath $cmdHookPath -PathType Leaf) -and
    $autoRun.StartsWith($cmdHookCommand, [StringComparison]::OrdinalIgnoreCase)
  return [ordered]@{
    enabled = $powerShellInstalled -and $cmdInstalled
    powershellInstalled = $powerShellInstalled
    cmdInstalled = $cmdInstalled
    profilePaths = @($profilePaths)
    registryPath = $RegistryPath
  }
}

function Write-Result([string]$ErrorMessage = "") {
  $result = Get-Status
  if ($ErrorMessage) { $result.error = $ErrorMessage }
  $result | ConvertTo-Json -Compress
}

$profileOriginals = @{}
$profileExisted = @{}
$hookOriginals = @{}
$hookExisted = @{}
$registryExisted = Test-Path -LiteralPath $RegistryPath
$autoRunExisted = Test-AutoRunProperty
$autoRunOriginal = Get-AutoRun
$mutationStarted = $false

try {
  if ($Action -eq "Status") {
    Write-Result
    exit 0
  }

  foreach ($path in $profilePaths) {
    $profileExisted[$path] = Test-Path -LiteralPath $path -PathType Leaf
    $profileOriginals[$path] = Get-FileText $path
  }
  foreach ($path in @($HookPath, $cmdHookPath)) {
    $hookExisted[$path] = Test-Path -LiteralPath $path -PathType Leaf
    $hookOriginals[$path] = Get-FileText $path
  }
  $mutationStarted = $true

  if ($Action -eq "Uninstall") {
    foreach ($path in $profilePaths) {
      $clean = Remove-ProfileBlock (Get-FileText $path)
      if ((Test-Path -LiteralPath $path -PathType Leaf) -or $clean) {
        Write-Utf8 $path $(if ($clean) { $clean + [Environment]::NewLine } else { "" })
      }
    }
    if (Test-Path -LiteralPath $RegistryPath) {
      $cleanAutoRun = Remove-CmdHook (Get-AutoRun)
      if ($cleanAutoRun) { Set-ItemProperty -LiteralPath $RegistryPath -Name AutoRun -Value $cleanAutoRun }
      else { Remove-ItemProperty -LiteralPath $RegistryPath -Name AutoRun -ErrorAction SilentlyContinue }
    }
    foreach ($path in @($HookPath, $cmdHookPath)) {
      if (Test-Path -LiteralPath $path -PathType Leaf) { Remove-Item -LiteralPath $path -Force }
    }
    Write-Result
    exit 0
  }

  if (-not (Test-Path -LiteralPath $AppExecutable -PathType Leaf)) { throw "找不到应用程序: $AppExecutable" }
  if (-not (Test-Path -LiteralPath $ProjectRoot -PathType Container)) { throw "找不到项目目录: $ProjectRoot" }
  if (-not (Test-Path -LiteralPath $LaunchScript -PathType Leaf)) { throw "找不到 UI 启动脚本: $LaunchScript" }

  $launchValue = Escape-SingleQuoted $LaunchScript
  $appValue = Escape-SingleQuoted $AppExecutable
  $rootValue = Escape-SingleQuoted $ProjectRoot
  $hookValue = Escape-SingleQuoted $HookPath
  $hookScript = @"
param(
  [string]`$WorkingDirectory = "",
  [ValidateSet("powershell", "cmd")][string]`$Origin = "powershell",
  [int]`$ShellProcessId = 0,
  [switch]`$SkipParentCheck
)
if (`$env:CODEX_UI_TERMINAL -eq "1" -or `$env:CODEX_UI_SHELL_STARTUP_GUARD -eq "1") { return }
function Get-ProcessRecord([int]`$Id) {
  if (`$Id -le 0) { return `$null }
  try { return Get-CimInstance Win32_Process -Filter "ProcessId=`$Id" -Property Name,ParentProcessId -ErrorAction Stop } catch { return `$null }
}
function Get-ExecutableName([object]`$Process) {
  if (-not `$Process) { return "" }
  return [IO.Path]::GetFileNameWithoutExtension([string]`$Process.Name).ToLowerInvariant()
}
function Test-UserShellParent {
  # Only shells opened by Windows' interactive shell/terminal hosts may launch
  # the workbench. Unknown parents are automation by default.
  `$allowed = @("explorer", "windowsterminal", "openconsole", "conhost", "wt")
  `$shell = if (`$ShellProcessId -gt 0) { Get-ProcessRecord `$ShellProcessId } else { Get-ProcessRecord `$PID | ForEach-Object { Get-ProcessRecord ([int]`$_.ParentProcessId) } }
  `$parent = if (`$shell) { Get-ProcessRecord ([int]`$shell.ParentProcessId) } else { `$null }
  return `$allowed -contains (Get-ExecutableName `$parent)
}
if (-not `$SkipParentCheck -and -not (Test-UserShellParent)) { return }
`$previousGuard = `$env:CODEX_UI_SHELL_STARTUP_GUARD
`$env:CODEX_UI_SHELL_STARTUP_GUARD = "1"
try {
  `$cwd = if (`$WorkingDirectory -and (Test-Path -LiteralPath `$WorkingDirectory -PathType Container)) { `$WorkingDirectory } else { `$HOME }
  & '$launchValue' -AppExecutable '$appValue' -ProjectRoot '$rootValue' -WorkingDirectory `$cwd
} catch {
  # Shell startup must remain usable when the UI cannot be launched.
} finally {
  if (`$null -eq `$previousGuard) { Remove-Item Env:CODEX_UI_SHELL_STARTUP_GUARD -ErrorAction SilentlyContinue }
  else { `$env:CODEX_UI_SHELL_STARTUP_GUARD = `$previousGuard }
}
"@
  $cmdHook = @"
@echo off
if /I "%CODEX_UI_TERMINAL%"=="1" exit /b 0
if /I "%CODEX_UI_SHELL_STARTUP_GUARD%"=="1" exit /b 0
start "" /b powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "$HookPath" -Origin cmd -WorkingDirectory "%CD%"
set "CODEX_UI_SHELL_STARTUP_GUARD=1"
exit /b 0
"@
  Write-Utf8 $HookPath ($hookScript + [Environment]::NewLine)
  Write-Utf8 $cmdHookPath ($cmdHook + [Environment]::NewLine)

  $profileBlock = @"
$startMarker
if (`$env:CODEX_UI_TERMINAL -ne '1' -and `$env:CODEX_UI_SHELL_STARTUP_GUARD -ne '1') {
  `$codexUiCwd = if (`$pwd.Provider.Name -eq 'FileSystem') { `$pwd.ProviderPath } else { `$HOME }
  & '$hookValue' -Origin powershell -ShellProcessId `$PID -WorkingDirectory `$codexUiCwd
  # Keep the marker in this shell so Codex and every child shell inherit it.
  `$env:CODEX_UI_SHELL_STARTUP_GUARD = '1'
}
$endMarker
"@
  foreach ($path in $profilePaths) {
    $existing = Get-FileText $path
    $clean = Remove-ProfileBlock $existing
    $prefix = if ($clean) { $clean + [Environment]::NewLine + [Environment]::NewLine } else { "" }
    if (Test-Path -LiteralPath $path -PathType Leaf) { Copy-Item -LiteralPath $path -Destination ($path + ".codex-cli-ui-shell.bak") -Force }
    Write-Utf8 $path ($prefix + $profileBlock + [Environment]::NewLine)
  }

  if (-not (Test-Path -LiteralPath $RegistryPath)) { New-Item -Path $RegistryPath -Force | Out-Null }
  $cleanAutoRun = Remove-CmdHook (Get-AutoRun)
  $nextAutoRun = if ($cleanAutoRun) { "$cmdHookCommand & $cleanAutoRun" } else { $cmdHookCommand }
  Set-ItemProperty -LiteralPath $RegistryPath -Name AutoRun -Value $nextAutoRun
  Write-Result
  exit 0
} catch {
  $errorMessage = $_.Exception.Message
  if ($mutationStarted) {
    foreach ($path in $profilePaths) {
      try {
        if ($profileExisted[$path]) { Write-Utf8 $path ([string]$profileOriginals[$path]) }
        elseif (Test-Path -LiteralPath $path -PathType Leaf) { Remove-Item -LiteralPath $path -Force }
      } catch {}
    }
    foreach ($path in @($HookPath, $cmdHookPath)) {
      try {
        if ($hookExisted[$path]) { Write-Utf8 $path ([string]$hookOriginals[$path]) }
        elseif (Test-Path -LiteralPath $path -PathType Leaf) { Remove-Item -LiteralPath $path -Force }
      } catch {}
    }
    try {
      if (-not (Test-Path -LiteralPath $RegistryPath) -and $registryExisted) { New-Item -Path $RegistryPath -Force | Out-Null }
      if (Test-Path -LiteralPath $RegistryPath) {
        if ($autoRunExisted) { Set-ItemProperty -LiteralPath $RegistryPath -Name AutoRun -Value $autoRunOriginal }
        else { Remove-ItemProperty -LiteralPath $RegistryPath -Name AutoRun -ErrorAction SilentlyContinue }
      }
    } catch {}
  }
  Write-Result $errorMessage
  exit 1
}
