$ErrorActionPreference = "Stop"
$workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$testRoot = Join-Path $workspace ".tmp\launcher-test"
$expectedRoot = Join-Path $workspace ".tmp"
if (-not $testRoot.StartsWith($expectedRoot, [StringComparison]::OrdinalIgnoreCase)) { throw "launcher test path escaped workspace" }
if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
$profilePath = Join-Path $testRoot "profile.ps1"
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "fixtures\profile.ps1") -Destination $profilePath

$installScript = Join-Path $workspace "scripts\install-launcher.ps1"
$launchScript = Join-Path $workspace "scripts\launch-ui.ps1"
$parseErrors = @()
$tokens = @()
[void][Management.Automation.Language.Parser]::ParseFile($installScript, [ref]$tokens, [ref]$parseErrors)
[void][Management.Automation.Language.Parser]::ParseFile($launchScript, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw ($parseErrors | ForEach-Object Message | Out-String) }

$electron = Join-Path $workspace "node_modules\electron\dist\electron.exe"
$installJson = & $installScript -Action Install -AppExecutable $electron -ProjectRoot $workspace -RawCommand $electron -ProfilePath $profilePath
$install = $installJson | ConvertFrom-Json
if (-not $install.installed) { throw "launcher did not report installed" }
$installedText = [IO.File]::ReadAllText($profilePath)
if (-not $installedText.Contains("CodexUiFixtureValue")) { throw "existing profile content was removed" }
if (-not $installedText.Contains("# >>> codex-cli-ui >>>")) { throw "launcher marker missing" }

$statusJson = & $installScript -Action Status -AppExecutable $electron -ProjectRoot $workspace -RawCommand $electron -ProfilePath $profilePath
$status = $statusJson | ConvertFrom-Json
if (-not $status.installed) { throw "launcher status did not detect installation" }

. $profilePath
if ((Get-Command codex).CommandType -ne "Function") { throw "codex profile function missing" }
if ((Get-Command codex-raw).CommandType -ne "Function") { throw "codex-raw profile function missing" }

$uninstallJson = & $installScript -Action Uninstall -AppExecutable $electron -ProjectRoot $workspace -RawCommand $electron -ProfilePath $profilePath
$uninstall = $uninstallJson | ConvertFrom-Json
if ($uninstall.installed) { throw "launcher still reports installed after uninstall" }
$uninstalledText = [IO.File]::ReadAllText($profilePath)
if (-not $uninstalledText.Contains("CodexUiFixtureValue")) { throw "uninstall removed existing profile content" }
if ($uninstalledText.Contains("codex-cli-ui")) { throw "uninstall left launcher marker" }

Write-Output "launcher: syntax, install, status, profile preservation, and uninstall checks passed"
