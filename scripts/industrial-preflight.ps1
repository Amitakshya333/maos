param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Fail([string]$Message) {
    throw "MAOS_PREFLIGHT_FAILED: $Message"
}

$bundleRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\")).Path
$manifestPath = Join-Path $bundleRoot "manifest.json"
$modelManifestPath = Join-Path $bundleRoot "model-snapshot-manifest.json"
$requirementsPath = Join-Path $bundleRoot "requirements.lock"

if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { Fail "bundle manifest is missing" }
if (-not (Test-Path -LiteralPath $modelManifestPath -PathType Leaf)) { Fail "model snapshot manifest is missing" }
if (-not (Test-Path -LiteralPath $requirementsPath -PathType Leaf)) { Fail "Python requirements lockfile is missing" }

$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
if ($manifest.schemaVersion -ne 1 -or $manifest.workflowId -ne "maos-industrial-report") { Fail "bundle manifest identity is invalid" }
foreach ($entry in @($manifest.entries)) {
    if ([string]::IsNullOrWhiteSpace([string]$entry.path) -or [int64]$entry.size -le 0 -or [string]$entry.sha256 -notmatch '^[A-Fa-f0-9]{64}$') {
        Fail "bundle manifest contains an invalid entry"
    }
    $candidate = Join-Path $bundleRoot ([string]$entry.path)
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { Fail "missing bundled file: $($entry.path)" }
    $item = Get-Item -LiteralPath $candidate
    if ($item.Length -ne [int64]$entry.size) { Fail "size mismatch: $($entry.path)" }
    $hash = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash
    if ($hash -ne ([string]$entry.sha256).ToUpperInvariant()) { Fail "hash mismatch: $($entry.path)" }
}

$python = Get-Command python.exe -ErrorAction SilentlyContinue
if (-not $python) { $python = Get-Command python -ErrorAction SilentlyContinue }
if (-not $python -or -not [IO.Path]::IsPathRooted($python.Source)) { Fail "Python executable is unavailable" }

$dependencyCode = 'import importlib,sys; expected={"accelerate":"1.14.0","fastapi":"0.141.1","torch":"2.11.0+cu128","transformers":"5.15.1","uvicorn":"0.52.3"}; bad=[]; [bad.append("{}={}".format(m,getattr(importlib.import_module(m),"__version__","unknown"))) for m,v in expected.items() if getattr(importlib.import_module(m),"__version__","unknown") != v]; print(";".join(bad)); sys.exit(1 if bad else 0)'
$dependencyOutput = & $python.Source -c $dependencyCode 2>&1
if ($LASTEXITCODE -ne 0 -or -not [string]::IsNullOrWhiteSpace(($dependencyOutput -join ""))) { Fail "Python dependency versions do not match requirements.lock: $dependencyOutput" }

$modelManifest = Get-Content -Raw -LiteralPath $modelManifestPath | ConvertFrom-Json
if ($modelManifest.model -ne "Qwen/Qwen2.5-3B-Instruct" -or $modelManifest.revision -ne "aa8e72537993ba99e69dfaafa59ed015b17504d1") { Fail "model snapshot manifest identity is invalid" }
$hfHome = if ($env:HF_HOME) { $env:HF_HOME } else { Join-Path $env:USERPROFILE ".cache\huggingface" }
$snapshot = Join-Path $hfHome "hub\models--Qwen--Qwen2.5-3B-Instruct\snapshots\$($modelManifest.revision)"
if (-not (Test-Path -LiteralPath $snapshot -PathType Container)) { Fail "pinned model snapshot is missing: $snapshot" }
foreach ($entry in @($modelManifest.files)) {
    $candidate = Join-Path $snapshot ([string]$entry.path)
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { Fail "missing model file: $($entry.path)" }
    $item = Get-Item -LiteralPath $candidate
    if ($item.Length -ne [int64]$entry.size) { Fail "model size mismatch: $($entry.path)" }
    $hash = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash
    if ($hash -ne ([string]$entry.sha256).ToUpperInvariant()) { Fail "model hash mismatch: $($entry.path)" }
}

$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Parse("127.0.0.1"), 8000)
try { $listener.Start(); Fail "port 8000 is not occupied by the owned runtime" } catch [System.Net.Sockets.SocketException] { } finally { $listener.Stop() }
$health = Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:8000/health" -TimeoutSec 5
if ($health.status -ne "ok" -or $health.model -ne "qwen2.5-3b-instruct-local" -or $health.offline -ne $true) { Fail "local runtime health response is invalid" }
$models = Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:8000/v1/models" -TimeoutSec 5
if (-not $models.data -or $models.data[0].id -ne "qwen2.5-3b-instruct-local") { Fail "local runtime model list is invalid" }
$body = @{ model = "qwen2.5-3b-instruct-local"; messages = @(@{ role = "user"; content = "Reply with exactly: LOCAL_OK" }); temperature = 0; top_p = 1; max_tokens = 32; stream = $false } | ConvertTo-Json -Depth 6
$completion = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8000/v1/chat/completions" -ContentType "application/json" -Body $body -TimeoutSec 180
if (-not $completion.choices[0].message.content) { Fail "local completion returned no content" }

Write-Host "MAOS Industrial preflight passed: bundle, model snapshot, pinned Python dependencies, loopback health, model list, and completion verified." -ForegroundColor Green
