<#
.SYNOPSIS
  TASK RELEASE-CLI-01: install the Ring CLI release (Windows).

.EXAMPLE
  $env:RELEASE_TARBALL_URL = '<website-tarball-url>'
  $env:MAOS_ENGINE_URL = '<website-windows-engine-url>'
  .\install-ring-release.ps1

  Optional: $env:MAOS_ENGINE_SHA256 = '<expected-sha256>'
  Optional: $env:MAOS_DEMO_DIR = 'D:\demos\maos-industrial-demo'

  Steps: check Node 22+ and npm; npm i -g the release tarball (URL from
  RELEASE_TARBALL_URL, which the website fills in; never a guessed URL);
  download the Windows engine binary to the exact path the bridge expects
  and report it; SELF-CHECK (node version, engineHealth status ok, demo pack
  present, `ring -p` brief returns CRITICAL, Python reported honestly).
  Exits non-zero naming the exact missing piece on any check failure.
#>
$ErrorActionPreference = 'Stop'

function Fail([string]$Message) {
  Write-Error "INSTALL FAILED: $Message"
  exit 1
}

$ReleaseTarballUrl = $env:RELEASE_TARBALL_URL
if ([string]::IsNullOrWhiteSpace($ReleaseTarballUrl)) { $ReleaseTarballUrl = '__MAOS_RELEASE_TARBALL_URL__' }
$EngineUrl = $env:MAOS_ENGINE_URL
if ([string]::IsNullOrWhiteSpace($EngineUrl)) { $EngineUrl = '__MAOS_ENGINE_URL__' }
$ExpectedEngineSha = $env:MAOS_ENGINE_SHA256

# --- 1. Node 22+ and npm -------------------------------------------------------
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) { Fail 'node.exe is not on PATH (Node.js 22+ required)' }
$nodeVersion = (& $node.Source --version).Trim()
if ($nodeVersion -notmatch '^v?(\d+)\.') { Fail "could not parse node version from '$nodeVersion' (Node.js 22+ required)" }
if ([int]$Matches[1] -lt 22) { Fail "Node.js 22+ required; found $nodeVersion" }
$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) { Fail 'npm.cmd is not on PATH (required alongside Node.js 22+)' }
Write-Host "node $nodeVersion ok; npm $(& $npm.Source --version) ok"

# --- 2. Install the release tarball ----------------------------------------------
if ([string]::IsNullOrWhiteSpace($ReleaseTarballUrl) -or $ReleaseTarballUrl.Contains('__MAOS_RELEASE_TARBALL_URL__')) {
  Fail 'RELEASE_TARBALL_URL is not set (website placeholder __MAOS_RELEASE_TARBALL_URL__ was not filled in); refusing to guess a download URL'
}
& $npm.Source install -g $ReleaseTarballUrl
if ($LASTEXITCODE -ne 0) { Fail "npm install -g $ReleaseTarballUrl failed (exit $LASTEXITCODE)" }
$cli = Get-Command maos-industrial -ErrorAction SilentlyContinue
if (-not $cli) { Fail 'maos-industrial not on PATH after install (check your global npm bin dir)' }

# --- 3. Place the engine where the bridge expects it -------------------------------
$pkgRoot = node -p "require('path').dirname(require('path').dirname(require.resolve('maosorch/package.json')))"
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($pkgRoot)) { Fail 'could not resolve installed maosorch package root' }
$enginePath = Join-Path $pkgRoot 'rust\target\release\maos-engine.exe'
Write-Host "package root: $pkgRoot"
Write-Host "engine path (bridge default): $enginePath"
if ([string]::IsNullOrWhiteSpace($EngineUrl) -or $EngineUrl.Contains('__MAOS_ENGINE_URL__')) {
  Fail 'MAOS_ENGINE_URL is not set (website placeholder __MAOS_ENGINE_URL__ was not filled in); refusing to guess a download URL'
}
New-Item -ItemType Directory -Force -Path (Split-Path $enginePath) | Out-Null
Invoke-WebRequest -Uri $EngineUrl -OutFile $enginePath -UseBasicParsing
$engineSha = (Get-FileHash -LiteralPath $enginePath -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Host "engine sha256: $engineSha"
if (-not [string]::IsNullOrWhiteSpace($ExpectedEngineSha) -and $engineSha -ne $ExpectedEngineSha.ToLowerInvariant()) {
  Fail "engine SHA-256 mismatch: expected $ExpectedEngineSha, got $engineSha"
}

# --- 4. SELF-CHECK -----------------------------------------------------------------
Write-Host '--- self-check ---'
Write-Host "node version: $(& $node.Source --version)"

$healthJson = node -e @"
const b = require(process.argv[1] + '/dist/industrial/rust-engine-bridge.js');
const m = b.verifyExecutable(b.getDefaultEnginePath(process.argv[1]));
const res = b.engineHealth(m);
if ('error' in res) { console.error('ENGINE_HEALTH_ERROR: ' + res.message); process.exit(1); }
console.log(JSON.stringify(res.data));
"@ $pkgRoot
if ($LASTEXITCODE -ne 0) { Fail "engine health check failed: $healthJson" }
if ($healthJson -notmatch '"status":"ok"') { Fail "engine health not ok: $healthJson" }
Write-Host "engine health: $healthJson"

$setupOut = (& maos-industrial setup-demo 2>&1 | Out-String)
if ($setupOut -match 'RING_DEMO_TARGET_NOT_EMPTY') {
  Write-Host 'demo pack already present (target non-empty); verifying files'
} elseif ($LASTEXITCODE -ne 0) {
  Fail "setup-demo failed: $setupOut"
} else {
  Write-Host "setup-demo: $setupOut"
}
if ($env:MAOS_DEMO_DIR) { $demoDir = $env:MAOS_DEMO_DIR } else { $demoDir = Join-Path $HOME 'maos-industrial-demo' }
$csvProbe = Join-Path $demoDir 'demo\industrial\turbine_vibration_log.csv'
if (-not (Test-Path -LiteralPath $csvProbe -PathType Leaf)) { Fail "demo pack missing: $csvProbe not found" }
Write-Host "demo pack present: $demoDir"

Push-Location $demoDir
try {
  $briefOut = (& maos-industrial ring -p 'Give me the turbine vibration brief' 2>&1 | Out-String)
  $briefRc = $LASTEXITCODE
} finally {
  Pop-Location
}
if ($briefRc -ne 0) { Fail "ring -p brief failed (exit $briefRc): $briefOut" }
if ($briefOut -notmatch 'CRITICAL') { Fail "brief did not return CRITICAL: $briefOut" }
Write-Host 'brief verdict: CRITICAL ok'

$py = Get-Command python.exe, python3.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if ($py) {
  Write-Host "python: present ($((& $py.Source --version 2>&1)))"
} else {
  Write-Host 'python: missing (optional; deterministic T-07 brief does not need it)'
}

Write-Host 'INSTALL OK: maos-industrial release installed, engine healthy, demo brief CRITICAL'
