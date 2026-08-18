$ErrorActionPreference = "Stop"
$workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$testRoot = Join-Path $workspace ".tmp\shell-startup-test"
$expectedRoot = Join-Path $workspace ".tmp"
if (-not $testRoot.StartsWith($expectedRoot, [StringComparison]::OrdinalIgnoreCase)) { throw "shell startup test path escaped workspace" }
if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
New-Item -ItemType Directory -Path $testRoot -Force | Out-Null

$installScript = Join-Path $workspace "scripts\install-shell-startup.ps1"
$launchScript = Join-Path $workspace "scripts\launch-ui.ps1"
$fakeLaunchScript = Join-Path $testRoot "fake-launch-ui.ps1"
$launchCapture = Join-Path $testRoot "launch-capture.json"
$electron = Join-Path $workspace "node_modules\electron\dist\electron.exe"
$windowsProfile = Join-Path $testRoot "WindowsPowerShell\profile.ps1"
$powerShellProfile = Join-Path $testRoot "PowerShell\profile.ps1"
$hookPath = Join-Path $testRoot "hooks\shell-startup.ps1"
$cmdHookPath = [IO.Path]::ChangeExtension($hookPath, ".cmd")
$registryPath = "HKCU:\Software\CodexCliUiTest\ShellStartup-$PID-$([Guid]::NewGuid().ToString('N'))"
$originalAutoRun = "doskey ll=dir"
$windowsOriginal = "`$global:WindowsProfileFixture = 'preserved'`r`n"
$powerShellOriginal = "`$global:PowerShellProfileFixture = 'preserved'`r`n"

function Invoke-Installer([string]$ActionName, [string]$WinProfile = $windowsProfile, [string]$PwshProfile = $powerShellProfile, [string]$Hook = $hookPath, [string]$Registry = $registryPath) {
  $json = & $installScript -Action $ActionName -AppExecutable $electron -ProjectRoot $workspace -LaunchScript $fakeLaunchScript -HookPath $Hook -WindowsPowerShellProfilePath $WinProfile -PowerShellProfilePath $PwshProfile -RegistryPath $Registry
  if ($LASTEXITCODE -ne 0) { throw "shell startup installer $ActionName failed: $json" }
  return $json | ConvertFrom-Json
}

try {
  $parseErrors = @()
  $tokens = @()
  [void][Management.Automation.Language.Parser]::ParseFile($installScript, [ref]$tokens, [ref]$parseErrors)
  [void][Management.Automation.Language.Parser]::ParseFile($launchScript, [ref]$tokens, [ref]$parseErrors)
  if ($parseErrors.Count -gt 0) { throw ($parseErrors | ForEach-Object Message | Out-String) }

  $captureValue = $launchCapture.Replace("'", "''")
  $fakeLauncher = @"
param([string]`$AppExecutable, [string]`$ProjectRoot, [string]`$WorkingDirectory)
`$result = [ordered]@{ cwd = `$WorkingDirectory; guard = `$env:CODEX_UI_SHELL_STARTUP_GUARD; terminal = `$env:CODEX_UI_TERMINAL }
[IO.File]::WriteAllText('$captureValue', (`$result | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new(`$false))
"@
  [IO.File]::WriteAllText($fakeLaunchScript, $fakeLauncher, [Text.UTF8Encoding]::new($false))

  New-Item -ItemType Directory -Path (Split-Path -Parent $windowsProfile) -Force | Out-Null
  New-Item -ItemType Directory -Path (Split-Path -Parent $powerShellProfile) -Force | Out-Null
  [IO.File]::WriteAllText($windowsProfile, $windowsOriginal, [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText($powerShellProfile, $powerShellOriginal, [Text.UTF8Encoding]::new($false))
  New-Item -Path $registryPath -Force | Out-Null
  Set-ItemProperty -LiteralPath $registryPath -Name AutoRun -Value $originalAutoRun

  $install = Invoke-Installer "Install"
  if (-not $install.enabled -or -not $install.powershellInstalled -or -not $install.cmdInstalled) { throw "shell startup install status is incomplete" }
  foreach ($profile in @($windowsProfile, $powerShellProfile)) {
    $text = [IO.File]::ReadAllText($profile)
    if (-not $text.Contains("Fixture = 'preserved'")) { throw "existing profile content was removed" }
    if ([Regex]::Matches($text, "# >>> codex-cli-ui-shell-startup >>>").Count -ne 1) { throw "profile startup marker count is invalid" }
    if (-not (Test-Path -LiteralPath ($profile + ".codex-cli-ui-shell.bak"))) { throw "profile backup was not created" }
  }
  if (-not (Test-Path -LiteralPath $hookPath) -or -not (Test-Path -LiteralPath $cmdHookPath)) { throw "startup hooks were not written" }
  $autoRun = [string](Get-ItemPropertyValue -LiteralPath $registryPath -Name AutoRun)
  if (-not $autoRun.StartsWith("call `"$cmdHookPath`"", [StringComparison]::OrdinalIgnoreCase)) { throw "CMD AutoRun hook is missing" }
  if (-not $autoRun.EndsWith($originalAutoRun, [StringComparison]::Ordinal)) { throw "existing CMD AutoRun content was not preserved" }

  $previousTerminal = $env:CODEX_UI_TERMINAL
  $env:CODEX_UI_TERMINAL = "1"
  try {
    . $windowsProfile
    . $powerShellProfile
    & $hookPath -WorkingDirectory $workspace
    $cmdOutput = & cmd.exe /d /c "set CODEX_UI_TERMINAL=1&&call `"$cmdHookPath`"&&echo guard-ok"
    if (($cmdOutput -join "`n") -notmatch "guard-ok") { throw "CMD recursion guard did not return control" }
  } finally {
    if ($null -eq $previousTerminal) { Remove-Item Env:CODEX_UI_TERMINAL -ErrorAction SilentlyContinue }
    else { $env:CODEX_UI_TERMINAL = $previousTerminal }
  }

  Remove-Item Env:CODEX_UI_TERMINAL -ErrorAction SilentlyContinue
  Remove-Item Env:CODEX_UI_SHELL_STARTUP_GUARD -ErrorAction SilentlyContinue
  & $hookPath -WorkingDirectory $workspace
  if (-not (Test-Path -LiteralPath $launchCapture)) { throw "external PowerShell startup did not request a UI launch" }
  $capture = [IO.File]::ReadAllText($launchCapture) | ConvertFrom-Json
  if ($capture.cwd -ne $workspace) { throw "startup hook did not preserve the external shell directory" }
  if ($capture.guard -ne "1") { throw "startup hook did not guard the launched UI process" }
  if ($env:CODEX_UI_SHELL_STARTUP_GUARD) { throw "startup hook leaked its recursion guard into the shell" }

  $reinstall = Invoke-Installer "Install"
  if (-not $reinstall.enabled) { throw "idempotent reinstall disabled integration" }
  foreach ($profile in @($windowsProfile, $powerShellProfile)) {
    if ([Regex]::Matches([IO.File]::ReadAllText($profile), "# >>> codex-cli-ui-shell-startup >>>").Count -ne 1) { throw "reinstall duplicated a profile block" }
  }
  $autoRun = [string](Get-ItemPropertyValue -LiteralPath $registryPath -Name AutoRun)
  if ([Regex]::Matches($autoRun, [Regex]::Escape($cmdHookPath), [Text.RegularExpressions.RegexOptions]::IgnoreCase).Count -ne 1) { throw "reinstall duplicated CMD AutoRun" }

  $rollbackWindows = Join-Path $testRoot "rollback\win.ps1"
  $rollbackPowerShell = Join-Path $testRoot "rollback\pwsh.ps1"
  $rollbackHook = Join-Path $testRoot "rollback\hook.ps1"
  New-Item -ItemType Directory -Path (Split-Path -Parent $rollbackWindows) -Force | Out-Null
  [IO.File]::WriteAllText($rollbackWindows, "rollback-win`r`n", [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText($rollbackPowerShell, "rollback-pwsh`r`n", [Text.UTF8Encoding]::new($false))
  $rollbackOutput = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installScript -Action Install -AppExecutable $electron -ProjectRoot $workspace -LaunchScript $launchScript -HookPath $rollbackHook -WindowsPowerShellProfilePath $rollbackWindows -PowerShellProfilePath $rollbackPowerShell -RegistryPath "Z:\CodexCliUiInvalidRegistry" 2>$null
  if ($LASTEXITCODE -eq 0) { throw "invalid registry path unexpectedly installed" }
  if ([IO.File]::ReadAllText($rollbackWindows) -ne "rollback-win`r`n" -or [IO.File]::ReadAllText($rollbackPowerShell) -ne "rollback-pwsh`r`n") { throw "failed install did not roll back profiles" }
  if (Test-Path -LiteralPath $rollbackHook) { throw "failed install did not roll back hook files" }
  if (($rollbackOutput -join "`n") -notmatch '"error"') { throw "failed install did not report an error" }

  $uninstall = Invoke-Installer "Uninstall"
  if ($uninstall.enabled -or $uninstall.powershellInstalled -or $uninstall.cmdInstalled) { throw "shell startup integration remained enabled after uninstall" }
  if ([IO.File]::ReadAllText($windowsProfile) -notmatch "WindowsProfileFixture") { throw "Windows PowerShell profile content was lost on uninstall" }
  if ([IO.File]::ReadAllText($powerShellProfile) -notmatch "PowerShellProfileFixture") { throw "PowerShell profile content was lost on uninstall" }
  if (([IO.File]::ReadAllText($windowsProfile) + [IO.File]::ReadAllText($powerShellProfile)).Contains("codex-cli-ui-shell-startup")) { throw "uninstall left profile markers" }
  if ([string](Get-ItemPropertyValue -LiteralPath $registryPath -Name AutoRun) -ne $originalAutoRun) { throw "uninstall did not restore CMD AutoRun" }
  if ((Test-Path -LiteralPath $hookPath) -or (Test-Path -LiteralPath $cmdHookPath)) { throw "uninstall left startup hooks" }

  Write-Output "shell-startup: PowerShell/CMD install, guard, idempotency, rollback, preservation, and uninstall checks passed"
} finally {
  Remove-Item -LiteralPath $registryPath -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
}
