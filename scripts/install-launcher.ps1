param(
  [ValidateSet("Status", "Install", "Uninstall")]
  [string]$Action = "Status",

  [string]$AppExecutable = "",
  [string]$ProjectRoot = "",
  [string]$RawCommand = "",
  [string]$ProfilePath = ""
)

$ErrorActionPreference = "Stop"
$startMarker = "# >>> codex-cli-ui >>>"
$endMarker = "# <<< codex-cli-ui <<<"
$profilePath = if ($ProfilePath) { $ProfilePath } else { $PROFILE.CurrentUserAllHosts }

function Get-ProfileText {
  if (Test-Path -LiteralPath $profilePath) {
    return [IO.File]::ReadAllText($profilePath, [Text.Encoding]::UTF8)
  }
  return ""
}

function Remove-LauncherBlock([string]$Text) {
  $escapedStart = [Regex]::Escape($startMarker)
  $escapedEnd = [Regex]::Escape($endMarker)
  return [Regex]::Replace($Text, "(?ms)^$escapedStart\r?\n.*?^$escapedEnd\r?\n?", "").TrimEnd()
}

function Write-Result([bool]$Installed, [string]$ErrorMessage = "") {
  $result = [ordered]@{
    installed = $Installed
    profilePath = $profilePath
    rawCommand = $RawCommand
  }
  if ($ErrorMessage) { $result.error = $ErrorMessage }
  $result | ConvertTo-Json -Compress
}

try {
  $existing = Get-ProfileText
  $installed = $existing.Contains($startMarker) -and $existing.Contains($endMarker)
  if ($Action -eq "Status") {
    Write-Result $installed
    exit 0
  }

  $profileDirectory = Split-Path -Parent $profilePath
  if (-not (Test-Path -LiteralPath $profileDirectory)) {
    New-Item -ItemType Directory -Path $profileDirectory -Force | Out-Null
  }

  $clean = Remove-LauncherBlock $existing
  if ($Action -eq "Uninstall") {
    $newText = if ($clean) { $clean + [Environment]::NewLine } else { "" }
    [IO.File]::WriteAllText($profilePath, $newText, [Text.UTF8Encoding]::new($false))
    Write-Result $false
    exit 0
  }

  if (-not $ProjectRoot) { $ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path }
  if (-not $AppExecutable) { $AppExecutable = Join-Path $ProjectRoot "node_modules\electron\dist\electron.exe" }
  if (-not $RawCommand) {
    $appData = [Environment]::GetFolderPath("ApplicationData")
    $npmNative = Join-Path $appData "npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe"
    if (Test-Path -LiteralPath $npmNative) {
      $RawCommand = $npmNative
    } else {
      $rawCandidate = Get-Command codex.cmd -CommandType Application -All -ErrorAction SilentlyContinue | Select-Object -First 1
      if (-not $rawCandidate) { $rawCandidate = Get-Command codex.exe -CommandType Application -All -ErrorAction SilentlyContinue | Select-Object -First 1 }
      if ($rawCandidate) { $RawCommand = $rawCandidate.Source }
    }
  }

  if (-not $AppExecutable -or -not (Test-Path -LiteralPath $AppExecutable)) {
    throw "找不到 Codex CLI UI 可执行文件: $AppExecutable"
  }
  if (-not $ProjectRoot) { throw "缺少项目路径" }
  if (-not $RawCommand -or -not (Test-Path -LiteralPath $RawCommand)) {
    throw "找不到原始 Codex CLI: $RawCommand"
  }

  $launchScript = Join-Path $PSScriptRoot "launch-ui.ps1"
  if (-not (Test-Path -LiteralPath $launchScript)) { throw "找不到 UI 启动脚本" }
  $escape = { param([string]$Value) $Value.Replace("'", "''") }
  $launchValue = & $escape $launchScript
  $appValue = & $escape $AppExecutable
  $rootValue = & $escape $ProjectRoot
  $rawValue = & $escape $RawCommand

$block = @"
$startMarker
function global:codex {
  & '$launchValue' -AppExecutable '$appValue' -ProjectRoot '$rootValue' -CliArgs `$args
}

function global:codex-raw {
  & '$rawValue' @args
}
$endMarker
"@

  if (Test-Path -LiteralPath $profilePath) {
    Copy-Item -LiteralPath $profilePath -Destination ($profilePath + ".codex-cli-ui.bak") -Force
  }
  $prefix = if ($clean) { $clean + [Environment]::NewLine + [Environment]::NewLine } else { "" }
  [IO.File]::WriteAllText($profilePath, $prefix + $block + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
  Write-Result $true
} catch {
  Write-Result $false $_.Exception.Message
  exit 1
}
