param(
  [Parameter(Mandatory = $true)]
  [string]$AppExecutable,

  [Parameter(Mandatory = $true)]
  [string]$ProjectRoot,

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$CliArgs
)

$ErrorActionPreference = "Stop"
$currentDirectory = (Get-Location).ProviderPath
$cwdBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($currentDirectory)).TrimEnd("=").Replace("+", "-").Replace("/", "_")
$argsJson = ConvertTo-Json -InputObject @($CliArgs) -Compress
$argsBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($argsJson)).TrimEnd("=").Replace("+", "-").Replace("/", "_")
$launchArgs = @("--codex-cwd-b64=$cwdBase64", "--codex-args-b64=$argsBase64")

if ([IO.Path]::GetFileName($AppExecutable) -ieq "electron.exe") {
  $launchArgs = @("`"$ProjectRoot`"") + $launchArgs
}

Start-Process -FilePath $AppExecutable -WorkingDirectory $ProjectRoot -ArgumentList $launchArgs -WindowStyle Hidden | Out-Null
