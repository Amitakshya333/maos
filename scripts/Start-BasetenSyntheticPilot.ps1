param(
  [Parameter(Mandatory = $true)][string]$InstallRoot,
  [Parameter(Mandatory = $true)][string]$ExternalEnginePath
)

$ErrorActionPreference = 'Stop'

$pilotMutex = [System.Threading.Mutex]::new($false, 'Local\MAOS.Baseten.SyntheticPilot')
try {
  $pilotMutexAcquired = $pilotMutex.WaitOne(0)
} catch [System.Threading.AbandonedMutexException] {
  $pilotMutexAcquired = $true
}
if (-not $pilotMutexAcquired) {
  $pilotMutex.Dispose()
  throw 'Another Baseten synthetic pilot launcher is already running in this Windows session.'
}

$applicationExitCode = 1
try {
if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable('BASETEN_API_KEY'))) {
  throw 'BASETEN_API_KEY is not set in this PowerShell session. Load it from your credential manager in this session, then rerun; never pass it as an argument.'
}

$install = (Resolve-Path -LiteralPath $InstallRoot).Path
$appRoot = Join-Path $install 'app'
$electron = Join-Path $appRoot 'desktop/node_modules/electron/dist/electron.exe'
$main = Join-Path $appRoot 'desktop/main.cjs'
$policy = Join-Path $appRoot 'dist/backends/meta-api-policy.js'
foreach ($required in @($electron, $main, $policy)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "The installed application is incomplete or outdated: $required"
  }
}

$policyText = Get-Content -LiteralPath $policy -Raw
foreach ($requiredText in @('https://inference.baseten.co/v1', 'meta-models/muse-spark-open-1026', 'BASETEN_API_KEY')) {
  if (-not $policyText.Contains($requiredText)) {
    throw 'The installed application does not contain the reviewed Baseten hackathon model policy. Build and install the reviewed candidate first.'
  }
}

$engine = (Resolve-Path -LiteralPath $ExternalEnginePath).Path
if (-not (Test-Path -LiteralPath $engine -PathType Leaf)) {
  throw 'Supply the separately obtained external MAOS engine with -ExternalEnginePath. The launcher never downloads or substitutes an engine.'
}

$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js 22.12 or newer must be on PATH for the installed MAOS service host.' }
$nodeVersion = (& $node.Source --version).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v?(\d+)\.(\d+)\.(\d+)') {
  throw 'Could not read the Node.js version required by the installed MAOS service host.'
}
if ([version]::new([int]$Matches[1], [int]$Matches[2], [int]$Matches[3]) -lt [version]'22.12.0') {
  throw "Node.js 22.12 or newer is required; found $nodeVersion."
}

$pilotRoot = Join-Path $env:TEMP ('maos-baseten-synthetic-pilot-' + [guid]::NewGuid().ToString('N'))
$projectRoot = Join-Path $pilotRoot 'project'
$userDataRoot = Join-Path $pilotRoot 'electron-user-data'
$engineTarget = Join-Path $projectRoot 'rust/target/release/maos-engine.exe'
New-Item -ItemType Directory -Path (Join-Path $projectRoot '.maos') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $projectRoot 'synthetic') -Force | Out-Null
New-Item -ItemType Directory -Path (Split-Path -Parent $engineTarget) -Force | Out-Null
New-Item -ItemType Directory -Path $userDataRoot -Force | Out-Null
Copy-Item -LiteralPath $engine -Destination $engineTarget

$config = @{
  schemaVersion = 1
  projectName = 'baseten-synthetic-pilot'
  profile = @{
    id = 'industrial'
    displayName = 'MAOS Industrial Synthetic Pilot'
    mode = 'cloud'
    zeroCloud = $false
    evidenceRoot = 'synthetic'
  }
  routingMode = 'manual'
  providers = @{
    baseten = @{
      baseURL = 'https://inference.baseten.co/v1'
      basetenApiEnabled = $true
    }
  }
  agents = @(@{
    id = 'ANALYST_AGENT'
    role = 'synthetic telemetry analyst'
    runtime = 'api'
    provider = 'baseten'
    model = 'meta-models/muse-spark-open-1026'
    timeoutMs = 60000
    maxIterations = 4
    allowedTools = @('analyze_telemetry_csv', 'task_complete')
    capabilities = @('deterministic telemetry analysis')
    scope = @('synthetic/')
  })
  routing = @{
    strategy = 'capability_score'
    costWeight = 0
    capabilityWeight = 1
    maxParallelAgents = 1
    fallbackProvider = 'none'
  }
}
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText((Join-Path $projectRoot '.maos/maos.config.json'), ($config | ConvertTo-Json -Depth 12), $utf8NoBom)

$thresholds = @{
  rulesetId = 'SYNTHETIC-PILOT-V1'
  title = 'Synthetic demonstration thresholds'
  disclaimer = 'Synthetic demonstration only; not an operational threshold or authorization.'
  assetType = 'synthetic_turbine'
  thresholds = @{
    vibration_rms_mm_s = @{
      unit = 'mm/s RMS'; warning = 4.5; critical = 7.1
      recommendations = @{ WARNING = 'Synthetic warning only.'; FAIL = 'Synthetic critical result only.' }
    }
    bearing_temperature_c = @{
      unit = 'deg C'; warning = 85.0; critical = 95.0
      recommendations = @{ WARNING = 'Synthetic warning only.'; FAIL = 'Synthetic critical result only.' }
    }
  }
}
$demoRoot = Join-Path $projectRoot 'demo/industrial'
New-Item -ItemType Directory -Path $demoRoot -Force | Out-Null
[System.IO.File]::WriteAllText((Join-Path $demoRoot 'safety_thresholds.json'), ($thresholds | ConvertTo-Json -Depth 8), $utf8NoBom)
$csv = @'
sample_time,vibration_rms_mm_s,bearing_temperature_c
2026-10-01T10:00:00Z,1.1,68
2026-10-01T10:01:00Z,4.8,88
2026-10-01T10:02:00Z,8.3,97
'@
[System.IO.File]::WriteAllText((Join-Path $projectRoot 'synthetic/pilot.csv'), $csv, $utf8NoBom)

$engineHash = (Get-FileHash -LiteralPath $engineTarget -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Output 'Prepared a synthetic-only Baseten pilot project. The external engine is operator-supplied; this SHA-256 identifies bytes but does not attest publisher trust or approval.'
Write-Output "Engine SHA-256: $engineHash"
Write-Output "Synthetic project: $projectRoot"
Write-Output "Synthetic CSV to select in MAOS: $(Join-Path $projectRoot 'synthetic/pilot.csv')"
Write-Output 'The key value is inherited from this PowerShell session and is not written to files or process arguments.'
Write-Output 'The GUI allows one analysis request at a time. Stop after any failure; do not retry this pilot.'

$arguments = @(
  "--user-data-dir=$userDataRoot",
  $main,
  '--project-root',
  $projectRoot,
  '--allow-temp'
)
$processTreeHelper = Join-Path $PSScriptRoot 'Windows-ProcessTree.ps1'
if (-not (Test-Path -LiteralPath $processTreeHelper -PathType Leaf)) {
  throw 'The task-owned process-tree helper is missing from this installation.'
}
. $processTreeHelper
$cancelSource = [System.Threading.CancellationTokenSource]::new()
$cancelHandler = [System.ConsoleCancelEventHandler] {
  param($sender, $eventArgs)
  $eventArgs.Cancel = $true
  $cancelSource.Cancel()
}
[Console]::add_CancelKeyPress($cancelHandler)
try {
  $applicationExitCode = Invoke-MaosOwnedProcessTree -FilePath $electron -ArgumentList $arguments -WorkingDirectory $projectRoot -CancellationToken $cancelSource.Token
} catch [System.OperationCanceledException] {
  Write-Output 'Pilot cancelled; the task-owned application process tree was terminated and waited before releasing the launcher lock.'
  $applicationExitCode = 130
} finally {
  [Console]::remove_CancelKeyPress($cancelHandler)
  $cancelSource.Dispose()
}
} finally {
  $pilotMutex.ReleaseMutex()
  $pilotMutex.Dispose()
}
exit $applicationExitCode
