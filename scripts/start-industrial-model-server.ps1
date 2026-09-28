param(
  [ValidateSet('auto', 'cuda', 'cpu')]
  [string]$Device = 'auto'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$manifest = Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'model-snapshot-manifest.json') | ConvertFrom-Json
$hfHome = if ($env:HF_HOME) { $env:HF_HOME } else { Join-Path $env:USERPROFILE '.cache\huggingface' }
$snapshot = Join-Path $hfHome ('hub\' + $manifest.snapshotRelativePath)
$python = Get-Command python.exe -ErrorAction SilentlyContinue
if (-not $python) { $python = Get-Command python -ErrorAction SilentlyContinue }

if (-not $python) { throw 'Python is unavailable. Install the pinned MAOS Industrial Python runtime first.' }
if (-not (Test-Path -LiteralPath $snapshot -PathType Container)) {
  throw "Pinned model snapshot is missing: $snapshot. Runtime downloads are disabled."
}

$server = Join-Path $projectRoot 'scripts\huggingface-openai-server.py'
Write-Host "Starting the pinned local model at http://127.0.0.1:8000 using device '$Device'."
Write-Host 'The server verifies the snapshot and keeps model traffic on loopback. Press Ctrl+C to stop.'
& $python.Source $server --host 127.0.0.1 --port 8000 --model-path $snapshot --device $Device
exit $LASTEXITCODE
