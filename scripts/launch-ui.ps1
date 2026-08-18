param(
  [Parameter(Mandatory = $true)]
  [string]$AppExecutable,

  [Parameter(Mandatory = $true)]
  [string]$ProjectRoot,

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$CliArgs,

  [string]$WorkingDirectory = "",
  [switch]$PassThruArguments
)

$ErrorActionPreference = "Stop"
$currentDirectory = if ($WorkingDirectory) { [IO.Path]::GetFullPath($WorkingDirectory) } else { (Get-Location).ProviderPath }
if (-not (Test-Path -LiteralPath $currentDirectory -PathType Container)) { throw "工作目录不存在: $currentDirectory" }
$cwdBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($currentDirectory)).TrimEnd("=").Replace("+", "-").Replace("/", "_")
$normalizedArgs = @($CliArgs)
$argsJson = if ($normalizedArgs.Count -eq 0) { "[]" } else { ConvertTo-Json -InputObject $normalizedArgs -Compress }
$argsBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($argsJson)).TrimEnd("=").Replace("+", "-").Replace("/", "_")
$launchArgs = @("--codex-cwd-b64=$cwdBase64", "--codex-args-b64=$argsBase64")

if ([IO.Path]::GetFileName($AppExecutable) -ieq "electron.exe") {
  $launchArgs = @("`"$ProjectRoot`"") + $launchArgs
}

if ($PassThruArguments) {
  [ordered]@{ cwd = $currentDirectory; arguments = @($launchArgs) } | ConvertTo-Json -Compress
  return
}

Start-Process -FilePath $AppExecutable -WorkingDirectory $ProjectRoot -ArgumentList $launchArgs -WindowStyle Hidden | Out-Null
