param(
  [Parameter(Mandatory = $true)][string]$BundleRoot,
  [Parameter(Mandatory = $true)][string]$InstallRoot
)

$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This install bundle supports Windows x64 only.' }
$bundlePath = (Resolve-Path -LiteralPath $BundleRoot).Path
$targetRoot = [System.IO.Path]::GetFullPath($InstallRoot)
if ($targetRoot.StartsWith($bundlePath.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'InstallRoot must be outside the installer bundle directory.'
}
$manifestPath = Join-Path $bundlePath 'bundle-manifest.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.schemaVersion -ne 1 -or $manifest.sourceRevision -notmatch '^[0-9a-f]{40}$' -or $manifest.sourceDeltaSha256 -notmatch '^[0-9a-f]{64}$') { throw 'Unsupported or malformed bundle manifest.' }

function Assert-Hash([string]$Path, [string]$Expected, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Label is missing: $Path" }
  $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $Expected) { throw "$Label SHA-256 mismatch. Expected $Expected, found $actual." }
}

function Invoke-NpmCi([string]$WorkingDirectory, [string]$Component) {
  $previousErrorActionPreference = $ErrorActionPreference
  Push-Location $WorkingDirectory
  try {
    $ErrorActionPreference = 'Continue'
    & $npm.Source ci --omit=dev --no-audit --no-fund
    $npmExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
    Pop-Location
  }
  if ($npmExitCode -ne 0) { throw "Pinned $Component dependency install failed (exit $npmExitCode)." }
}

$archivePath = Join-Path $bundlePath $manifest.package.archive
$lockPath = Join-Path $bundlePath $manifest.applicationLock.path
$scriptPath = Join-Path $bundlePath $manifest.installer.path
Assert-Hash $archivePath $manifest.package.sha256 'Package archive'
Assert-Hash $lockPath $manifest.applicationLock.sha256 'Application lockfile'
Assert-Hash $scriptPath $manifest.installer.sha256 'Installer script'

$node = Get-Command node.exe -ErrorAction SilentlyContinue
$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
$tar = Get-Command tar.exe -ErrorAction SilentlyContinue
if (-not $node -or -not $npm -or -not $tar) { throw 'Install requires Node.js 22.12+, npm 9+, and Windows tar.exe on PATH.' }
$nodeVersion = (& $node.Source --version).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v?(\d+)\.(\d+)\.(\d+)') { throw 'Could not read Node.js version; install Node.js 22.12 or newer.' }
$version = [version]::new([int]$Matches[1], [int]$Matches[2], [int]$Matches[3])
if ($version -lt [version]'22.12.0') { throw "Node.js 22.12 or newer is required; found $nodeVersion." }
if ((& $node.Source -p 'process.arch').Trim() -ne 'x64') { throw 'This install bundle requires 64-bit Node.js on Windows x64.' }
$npmVersion = (& $npm.Source --version).Trim()
if ($LASTEXITCODE -ne 0 -or $npmVersion -notmatch '^(\d+)\.') { throw 'Could not read npm version.' }
if ([int]$Matches[1] -lt 9) { throw "npm 9 or newer is required for lockfileVersion 3; found $npmVersion." }

$entries = & $tar.Source -tzf $archivePath
if ($LASTEXITCODE -ne 0 -or $entries.Count -eq 0) { throw 'The npm package archive is invalid or empty.' }
$longestArchivePath = 0
foreach ($entry in $entries) {
  $normalized = $entry.Replace('\', '/')
  if (-not $normalized.StartsWith('package/', [System.StringComparison]::Ordinal) -or
      $normalized.StartsWith('/') -or $normalized -match '^[A-Za-z]:' -or
      ($normalized.Split('/') -contains '..')) {
    throw "Refusing unsafe package archive entry: $entry"
  }
  if ($normalized -eq 'package/') { continue }
  $relativeEntry = $normalized.Substring('package/'.Length).Replace('/', '\')
  $projectedEntry = Join-Path (Join-Path $targetRoot 'app') $relativeEntry
  if ($projectedEntry.Length -gt $longestArchivePath) { $longestArchivePath = $projectedEntry.Length }
}

$appRoot = Join-Path $targetRoot 'app'
$desktopRoot = Join-Path $appRoot 'desktop'
$lockPathProbe = @'
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const appLock = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const desktopText = cp.execFileSync(process.argv[5], ['-xOf', process.argv[2], 'package/desktop/package-lock.json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const desktopLock = JSON.parse(desktopText);
function longest(lock, base) {
  let max = 0;
  for (const relative of Object.keys(lock.packages || {})) {
    if (!relative.startsWith('node_modules/')) continue;
    const candidate = path.join(base, ...relative.split('/'), 'package.json');
    max = Math.max(max, candidate.length);
  }
  return max;
}
process.stdout.write(JSON.stringify({ app: longest(appLock, process.argv[3]), desktop: longest(desktopLock, process.argv[4]) }));
'@
$lockPathLengths = & $node.Source -e $lockPathProbe $lockPath $archivePath $appRoot $desktopRoot $tar.Source
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect pinned lockfile paths before installation.' }
try { $lockedPaths = $lockPathLengths | ConvertFrom-Json } catch { throw 'Could not parse pinned lockfile path lengths before installation.' }
$longestLockedPath = [Math]::Max([int]$lockedPaths.app, [int]$lockedPaths.desktop)
$electronExe = Join-Path $desktopRoot 'node_modules\electron\dist\electron.exe'
$longestPlannedPath = [Math]::Max($longestArchivePath, [Math]::Max($longestLockedPath, $electronExe.Length))
if ($longestPlannedPath -ge 240) {
  throw "InstallRoot path is too long for this Windows bootstrap (projected file path is $longestPlannedPath characters; limit is 239). Choose a shorter destination. No install files were written."
}

if (Test-Path -LiteralPath $targetRoot) {
  if (Get-ChildItem -LiteralPath $targetRoot -Force | Select-Object -First 1) { throw "InstallRoot must be empty: $targetRoot" }
} else {
  New-Item -ItemType Directory -Path $targetRoot | Out-Null
}

New-Item -ItemType Directory -Path $appRoot | Out-Null
& $tar.Source -xzf $archivePath -C $appRoot --strip-components=1
if ($LASTEXITCODE -ne 0) { throw 'Could not extract the npm package archive.' }
Copy-Item -LiteralPath $lockPath -Destination (Join-Path $appRoot 'package-lock.json')
$installedPackage = Get-Content -LiteralPath (Join-Path $appRoot 'package.json') -Raw | ConvertFrom-Json
if ($installedPackage.name -ne $manifest.package.name -or $installedPackage.version -ne $manifest.package.version) {
  throw 'Extracted npm package identity does not match the bundle manifest.'
}
Assert-Hash (Join-Path $appRoot 'desktop/package-lock.json') $manifest.desktopLock.sha256 'Packaged desktop lockfile'

Invoke-NpmCi $appRoot 'application'
Invoke-NpmCi (Join-Path $appRoot 'desktop') 'Electron'

$electronInstall = Join-Path $appRoot 'desktop/node_modules/electron/install.js'
if (-not (Test-Path -LiteralPath $electronInstall -PathType Leaf)) { throw 'Pinned Electron package is missing its install script.' }
Push-Location (Join-Path $appRoot 'desktop')
$electronLogRoot = Join-Path $env:TEMP ('maos-electron-install-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $electronLogRoot | Out-Null
try {
  try {
    # Capture native stderr so PowerShell does not treat it as a script error.
    $electronDownload = Start-Process -FilePath $node.Source -ArgumentList ('"' + $electronInstall + '"') -WorkingDirectory (Join-Path $appRoot 'desktop') -NoNewWindow -Wait -PassThru -RedirectStandardOutput (Join-Path $electronLogRoot 'stdout.log') -RedirectStandardError (Join-Path $electronLogRoot 'stderr.log')
    if ($electronDownload.ExitCode -ne 0) { throw "Pinned Electron runtime download failed (exit $($electronDownload.ExitCode)); check network access to the configured Electron release host." }
  } finally { Remove-Item -LiteralPath $electronLogRoot -Recurse -Force }
} finally { Pop-Location }

if (-not (Test-Path -LiteralPath $electronExe -PathType Leaf)) { throw 'Pinned Electron install completed without its Windows runtime binary.' }
if (Test-Path -LiteralPath (Join-Path $appRoot 'desktop/node_modules/playwright')) { throw 'Development-only Playwright was installed in the product runtime.' }

Write-Output "Installed MAOS Industrial $($manifest.package.version) from base $($manifest.sourceRevision) plus delta $($manifest.sourceDeltaSha256)."
Write-Output "Application: $appRoot"
Write-Output "Electron runtime: $electronExe"
Write-Output 'Rust Industrial engine remains a separate prerequisite; see desktop/README.md.'
