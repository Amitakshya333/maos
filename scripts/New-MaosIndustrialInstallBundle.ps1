param(
  [Parameter(Mandatory = $true)][string]$PackageArchive,
  [Parameter(Mandatory = $true)][string]$SourceRevision,
  [Parameter(Mandatory = $true)][string]$SourceDeltaSha256,
  [Parameter(Mandatory = $true)][string]$OutputBundle
)

$ErrorActionPreference = 'Stop'
$sourceRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$archivePath = (Resolve-Path -LiteralPath $PackageArchive).Path
$outputPath = [System.IO.Path]::GetFullPath($OutputBundle)
if (Test-Path -LiteralPath $outputPath) { throw "Output bundle already exists: $outputPath" }
if ($SourceRevision -notmatch '^[0-9a-f]{40}$') { throw 'SourceRevision must be a full 40-character Git commit.' }
if ($SourceDeltaSha256 -notmatch '^[0-9a-f]{64}$') { throw 'SourceDeltaSha256 must be a full lowercase SHA-256.' }

$package = Get-Content -LiteralPath (Join-Path $sourceRoot 'package.json') -Raw | ConvertFrom-Json
$packagePath = Join-Path $sourceRoot 'package.json'
$lockPath = Join-Path $sourceRoot 'package-lock.json'
$lockCheck = "const p=require(process.argv[1]); const l=require(process.argv[2]); const r=l.packages['']; if(p.name!==l.name||p.version!==l.version||r.name!==p.name||r.version!==p.version) process.exit(1); for(const group of ['dependencies','devDependencies']) for(const [name,range] of Object.entries(p[group]||{})) if((r[group]||{})[name]!==range) process.exit(1);"
& node.exe -e $lockCheck $packagePath $lockPath
if ($LASTEXITCODE -ne 0) { throw 'package.json and package-lock.json identity or direct dependencies do not match.' }

$archiveEntries = & tar.exe -tzf $archivePath
if ($LASTEXITCODE -ne 0) { throw 'Could not list the npm package archive.' }
if ($archiveEntries -notcontains 'package/desktop/package-lock.json' -or
    $archiveEntries -notcontains 'package/desktop/package.json') {
  throw 'The npm archive does not contain the pinned desktop package and lockfile.'
}

$parent = Split-Path -Parent $outputPath
if (-not (Test-Path -LiteralPath $parent)) { throw "Output directory does not exist: $parent" }
$stageRoot = Join-Path ([System.IO.Path]::GetFullPath($env:TEMP)) ('maos-install-bundle-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stageRoot | Out-Null
try {
  $bundleArchive = Join-Path $stageRoot 'maosorch.tgz'
  Copy-Item -LiteralPath $archivePath -Destination $bundleArchive
  Copy-Item -LiteralPath (Join-Path $sourceRoot 'package-lock.json') -Destination (Join-Path $stageRoot 'package-lock.json')
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Install-MaosIndustrial.ps1') -Destination (Join-Path $stageRoot 'Install-MaosIndustrial.ps1')

  $manifest = [ordered]@{
    schemaVersion = 1
    sourceRevision = $SourceRevision
    sourceDeltaSha256 = $SourceDeltaSha256
    package = @{ name = $package.name; version = $package.version; archive = 'maosorch.tgz'; sha256 = (Get-FileHash -LiteralPath $bundleArchive -Algorithm SHA256).Hash.ToLowerInvariant() }
    applicationLock = @{ path = 'package-lock.json'; sha256 = (Get-FileHash -LiteralPath (Join-Path $stageRoot 'package-lock.json') -Algorithm SHA256).Hash.ToLowerInvariant() }
    desktopLock = @{ path = 'package/desktop/package-lock.json'; sha256 = (Get-FileHash -LiteralPath (Join-Path $sourceRoot 'desktop/package-lock.json') -Algorithm SHA256).Hash.ToLowerInvariant() }
    installer = @{ path = 'Install-MaosIndustrial.ps1'; sha256 = (Get-FileHash -LiteralPath (Join-Path $stageRoot 'Install-MaosIndustrial.ps1') -Algorithm SHA256).Hash.ToLowerInvariant() }
  }
  $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $stageRoot 'bundle-manifest.json') -Encoding UTF8
  Compress-Archive -Path (Join-Path $stageRoot '*') -DestinationPath $outputPath
} finally {
  $tempRoot = [System.IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
  $resolvedStage = [System.IO.Path]::GetFullPath($stageRoot)
  if ($resolvedStage.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase) -and
      (Split-Path -Leaf $resolvedStage) -like 'maos-install-bundle-*') {
    Remove-Item -LiteralPath $resolvedStage -Recurse -Force
  }
}

Write-Output "Created lockfile bootstrap bundle: $outputPath"
