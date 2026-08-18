[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("codex", "claude")]
  [string]$Source,

  [string]$Marker = "codex-cli-ui-hook-v1",
  [string]$ChainB64 = "",

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Remaining
)

$payload = ""
try {
  if ($Source -eq "codex" -and $Remaining.Count -gt 0) {
    $payload = [string]$Remaining[-1]
  }
  elseif ([Console]::IsInputRedirected) {
    $payload = [Console]::In.ReadToEnd()
  }

  if ($payload.Length -gt 65536) {
    $payload = $payload.Substring(0, 65536)
  }

  $pipeName = $env:CODEX_UI_NOTIFY_PIPE
  if ($pipeName) {
    $message = @{
      version = 1
      source = $Source
      sessionId = $env:CODEX_UI_SESSION_ID
      payload = $payload
      timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    } | ConvertTo-Json -Compress
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($message)
    $pipe = [IO.Pipes.NamedPipeClientStream]::new(
      ".",
      $pipeName,
      [IO.Pipes.PipeDirection]::Out,
      [IO.Pipes.PipeOptions]::Asynchronous
    )
    try {
      $pipe.Connect(300)
      $pipe.Write($bytes, 0, $bytes.Length)
      $pipe.Flush()
    }
    finally {
      $pipe.Dispose()
    }
  }
}
catch {
  # Notifications are best-effort and must never block the CLI.
}

if ($Source -eq "codex" -and $ChainB64) {
  try {
    $chainJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ChainB64))
    $chain = @($chainJson | ConvertFrom-Json)
    if ($chain.Count -gt 0) {
      $program = [string]$chain[0]
      $arguments = if ($chain.Count -gt 1) { @($chain[1..($chain.Count - 1)]) } else { @() }
      & $program @arguments $payload
      exit $LASTEXITCODE
    }
  }
  catch {
    # A broken previous notifier must not break Codex itself.
  }
}

exit 0
