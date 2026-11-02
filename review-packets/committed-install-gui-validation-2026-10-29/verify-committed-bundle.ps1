param([Parameter(Mandatory=$true)][string]$TaskRoot,[Parameter(Mandatory=$true)][string]$BundleRoot,[Parameter(Mandatory=$true)][string]$EvidenceRoot)
$ErrorActionPreference='Stop'
$TaskRoot=[System.IO.Path]::GetFullPath($TaskRoot)
$BundleRoot=[System.IO.Path]::GetFullPath($BundleRoot)
if(-not $BundleRoot.StartsWith($TaskRoot.TrimEnd('\')+'\',[System.StringComparison]::OrdinalIgnoreCase)){throw 'Bundle root is outside the isolated task directory.'}
if(-not $EvidenceRoot.StartsWith('C:\maos\review-packets\committed-install-gui-validation-2026-10-29',[System.StringComparison]::OrdinalIgnoreCase)){throw 'Evidence path is outside the authorized packet.'}
$manifestPath=Join-Path $BundleRoot 'bundle-manifest.json'
$manifest=Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$expectedDelta='d3b267f3e1032eb26b1e814876d4ab17ccd74df63bee62bab4ab27f6e7180622'
if($manifest.sourceRevision -ne '27dd1711f47e6278a1b84a6089e900dbe79f1459' -or $manifest.sourceDeltaSha256 -ne $expectedDelta){throw 'Bundle source identity does not match the final reviewed source packet.'}
$packageArchive=Join-Path $BundleRoot $manifest.package.archive
$packageSha=(Get-FileHash -LiteralPath $packageArchive -Algorithm SHA256).Hash.ToLowerInvariant()
if($packageSha -ne $manifest.package.sha256){throw 'Package archive hash does not match the bundle manifest.'}
$applicationLock=Join-Path $BundleRoot $manifest.applicationLock.path
if((Get-FileHash -LiteralPath $applicationLock -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.applicationLock.sha256){throw 'Application lock hash mismatch.'}
$packageRoot=Join-Path $TaskRoot 'package contents with spaces'
if(Test-Path -LiteralPath $packageRoot){throw 'Package extraction directory already exists.'}
New-Item -ItemType Directory -Path $packageRoot | Out-Null
$entries=& tar.exe -tzf $packageArchive
if($LASTEXITCODE -ne 0 -or $entries.Count -eq 0){throw 'Could not list the npm tarball.'}
$entryLog=Join-Path $EvidenceRoot 'npm-package-entries-committed.txt'
$entries | Set-Content -LiteralPath $entryLog -Encoding utf8
$unsafe=@($entries | Where-Object {$n=$_.Replace('\','/'); -not $n.StartsWith('package/') -or $n.StartsWith('/') -or $n -match '^[A-Za-z]:' -or ($n.Split('/') -contains '..')})
if($unsafe.Count -gt 0){throw 'The package contains unsafe archive paths.'}
& tar.exe -xzf $packageArchive -C $packageRoot
if($LASTEXITCODE -ne 0){throw 'Could not extract the npm tarball.'}
$pkg=Join-Path $packageRoot 'package'
$required=@(
  'dist/cli/index.js','dist/cli/repl.js','dist/backends/factory.js',
  'dist/industrial/entrypoint.js','dist/industrial/industrial-repl.js',
  'dist/gui/index.html','desktop/main.cjs','desktop/preload.cjs',
  'desktop/package.json','desktop/package-lock.json',
  'profiles/industrial/maos.config.json',
  'demo/industrial/safety_thresholds.json','demo/industrial/turbine_vibration_log.csv',
  'demo/industrial/maintenance_report.txt','demo/industrial/turbine_inspection_scan.pdf',
  'dist/industrial/python/embedding_engine.py','dist/industrial/python/ocr_engine.py',
  'scripts/Install-MaosIndustrial.ps1','scripts/New-MaosIndustrialInstallBundle.ps1'
)
$missing=@($required | Where-Object {-not (Test-Path -LiteralPath (Join-Path $pkg $_) -PathType Leaf)})
$guiJs=@(Get-ChildItem -LiteralPath (Join-Path $pkg 'dist/gui/assets') -Filter 'index-*.js' -File -ErrorAction SilentlyContinue)
$guiCss=@(Get-ChildItem -LiteralPath (Join-Path $pkg 'dist/gui/assets') -Filter 'index-*.css' -File -ErrorAction SilentlyContinue)
if($missing.Count -gt 0 -or $guiJs.Count -eq 0 -or $guiCss.Count -eq 0){throw 'Required backend, GUI, Electron, CLI, fixture, or Python runtime assets are missing.'}
$forbidden=@($entries | Where-Object {$_ -match '(^|/)(\.maos|review-packets|node_modules)(/|$)|(^|/)\.env($|\.)|\.(pem|p12|key)$|(^|/)id_(rsa|ed25519)($|\.)'})
$enginePresent=@($entries | Where-Object {$_ -match '(^|/)maos-engine\.exe$|(^|/)rust/target/release/'})
$bundleFiles=@(Get-ChildItem -LiteralPath $BundleRoot -Force -File)
if($forbidden.Count -gt 0 -or $enginePresent.Count -gt 0){throw 'Forbidden private state, credentials, dependency tree, or Rust executable found in the npm tarball.'}
$desktopLock=Join-Path $pkg 'desktop/package-lock.json'
if((Get-FileHash -LiteralPath $desktopLock -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.desktopLock.sha256){throw 'Desktop lockfile hash mismatch.'}
$packagedInstaller=Join-Path $pkg 'scripts/Install-MaosIndustrial.ps1'
$bootstrapInstaller=Join-Path $BundleRoot 'Install-MaosIndustrial.ps1'
$installerHashesEqual=((Get-FileHash -LiteralPath $packagedInstaller -Algorithm SHA256).Hash.ToLowerInvariant() -eq (Get-FileHash -LiteralPath $bootstrapInstaller -Algorithm SHA256).Hash.ToLowerInvariant())
if(-not $installerHashesEqual){throw 'Bootstrap and npm package installer scripts differ.'}
$credentialPatterns=@('sk-[A-Za-z0-9]{20,}','gh[pousr]_[A-Za-z0-9]{20,}','xox[baprs]-[A-Za-z0-9-]{20,}','AIza[0-9A-Za-z\-_]{30,}','-----BEGIN (RSA |EC )?PRIVATE KEY-----')
$rg=(Get-Command rg.exe -ErrorAction Stop).Source
$rgArgs=@('-l','--hidden','--no-messages')
foreach($pattern in $credentialPatterns){$rgArgs+=@('-e',$pattern)}
$rgArgs+=@($pkg)
$credentialMatchFiles=@(& $rg $rgArgs 2>$null)
$credentialScanExit=$LASTEXITCODE
if($credentialScanExit -notin @(0,1)){throw "Credential-pattern scan failed with exit $credentialScanExit."}
if($credentialMatchFiles.Count -gt 0){throw 'Credential-shaped content matched in the package; values suppressed from output.'}
$report=[ordered]@{
  checkedAt=(Get-Date).ToString('o')
  sourceRevision=$manifest.sourceRevision
  sourceDeltaSha256=$manifest.sourceDeltaSha256
  bundlePath=(Join-Path (Split-Path -Parent $BundleRoot) 'exact final6 bundle with spaces.zip')
  packagePath=$packageArchive
  bundleBytes=(Get-Item -LiteralPath (Join-Path (Split-Path -Parent $BundleRoot) 'exact final6 bundle with spaces.zip')).Length
  bundleSha256=(Get-FileHash -LiteralPath (Join-Path (Split-Path -Parent $BundleRoot) 'exact final6 bundle with spaces.zip') -Algorithm SHA256).Hash.ToLowerInvariant()
  packageBytes=(Get-Item -LiteralPath $packageArchive).Length
  packageSha256=$packageSha
  packageEntryCount=$entries.Count
  requiredAssetCount=$required.Count
  requiredAssetsPresent=$required.Count
  guiJsAssetCount=$guiJs.Count
  guiCssAssetCount=$guiCss.Count
  PythonAssetCount=@($entries | Where-Object {$_ -match '^package/dist/industrial/python/.*\.py$'}).Count
  fixtureAssetCount=@($entries | Where-Object {$_ -match '^package/demo/industrial/'}).Count
  forbiddenPathCount=$forbidden.Count
  credentialPatternFileCount=$credentialMatchFiles.Count
  credentialPatternScanExitCode=$credentialScanExit
  rustEngineBundled=$false
  rustEnginePrerequisite='External; no binary included.'
  installerMatchesPackage=$installerHashesEqual
  applicationLockVerified=$true
  desktopLockVerified=$true
  bundleExtractedFileCount=$bundleFiles.Count
}
$report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $EvidenceRoot 'bundle-contents-verification-committed.json') -Encoding utf8
$report | ConvertTo-Json -Depth 5

