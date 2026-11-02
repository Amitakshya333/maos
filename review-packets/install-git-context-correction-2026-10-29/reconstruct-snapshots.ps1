$ErrorActionPreference = 'Stop'
$repo = 'C:\maos'
$base = '189e786ff0431b02b95ca618bb4791a5ad7b0215'
$oldDirectory = Join-Path $repo 'review-packets\install-reliability-2026-10-29'
$oldPatch = Join-Path $oldDirectory 'install-reliability.patch'
$oldManifestPath = Join-Path $oldDirectory 'install-reliability-source-hashes.json'
$packet = $PSScriptRoot
$log = Join-Path $packet 'snapshot-reconstruction.log'
Get-ChildItem Env: | Where-Object { $_.Name -match '^GIT_' } | ForEach-Object { Remove-Item -LiteralPath ("Env:" + $_.Name) }

if ((Get-FileHash -LiteralPath $oldPatch -Algorithm SHA256).Hash.ToLowerInvariant() -ne 'f2edd4658fcdba9716050d2a377ed941498300177656f3ff91a77e45fdd4b3e5') { throw 'Historical installation patch hash mismatch.' }
if ((Get-FileHash -LiteralPath $oldManifestPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne '771081758b5747aeabd21f040ac98d75ecaea7c18db794883acefa9570955e75') { throw 'Historical source manifest hash mismatch.' }

$taskRoot = Join-Path $env:TEMP ('MAOS install correction validation ' + [guid]::NewGuid().ToString('N'))
$baseSource = Join-Path $taskRoot 'base-source'
$priorApply = Join-Path $taskRoot 'prior-snapshot-apply'
$priorSnapshot = Join-Path $taskRoot 'prior-snapshot'
$candidateSnapshot = Join-Path $taskRoot 'candidate-source'
$baseScope = Join-Path $taskRoot 'base-scope'
$candidateScope = Join-Path $taskRoot 'candidate-scope'
New-Item -ItemType Directory -Path $baseSource, $priorApply, $priorSnapshot, $candidateSnapshot, $baseScope, $candidateScope | Out-Null
Write-Output "TEMP_WORKSPACE=$taskRoot"

try {
  $trackedPaths = @(& git -C $repo ls-tree -r --name-only $base)
  $nestedPrivate = @($trackedPaths | Where-Object { $parts = $_.Split('/'); $parts.Length -gt 1 -and $parts[0] -ne '.maos' -and $parts -contains '.maos' })
  if ($nestedPrivate.Count -gt 0) { throw 'Archive blocked: nested .maos path exists outside the excluded repository root.' }
  $topLevelPaths = @(& git -C $repo ls-tree --name-only $base | Where-Object { $_ -and $_ -ne '.maos' })
  $archivePath = Join-Path $taskRoot 'base-source.tar'
  & git -C $repo archive --format=tar "--output=$archivePath" $base -- $topLevelPaths
  if ($LASTEXITCODE -ne 0) { throw 'Could not archive the declared base.' }
  & tar.exe -xf $archivePath -C $baseSource
  if ($LASTEXITCODE -ne 0) { throw 'Could not extract the declared base.' }
  Write-Output 'BASE_ARCHIVE_EXTRACTED; repository root .maos was excluded.'

  Get-ChildItem -LiteralPath $baseSource -Force | Copy-Item -Destination $priorApply -Recurse -Force
  & git -C $repo init $priorApply | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not initialize the isolated reconstruction repository.' }
  & git -C $priorApply config core.autocrlf false
  & git -C $priorApply apply --check $oldPatch
  if ($LASTEXITCODE -ne 0) { throw 'Historical patch does not apply to the declared base.' }
  & git -C $priorApply apply $oldPatch
  if ($LASTEXITCODE -ne 0) { throw 'Historical patch application failed.' }
  Write-Output 'HISTORICAL_PATCH_APPLIED.'

  $oldManifest = Get-Content -LiteralPath $oldManifestPath -Raw | ConvertFrom-Json
  $lfMismatches = [System.Collections.Generic.List[string]]::new()
  $rawEqualCount = 0
  foreach ($entry in $oldManifest.files) {
    $file = Join-Path $priorApply $entry.path
    $rawHash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
    $text = [System.Text.Encoding]::UTF8.GetString([System.IO.File]::ReadAllBytes($file))
    $lfBytes = [System.Text.Encoding]::UTF8.GetBytes([regex]::Replace($text, "`r`n?", "`n"))
    $lfHash = [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($lfBytes)).ToLowerInvariant()
    if ($rawHash -eq $entry.rawSha256) { $rawEqualCount++ }
    if ($lfHash -ne $entry.lfSha256) { $lfMismatches.Add($entry.path) }
  }
  if ($lfMismatches.Count -gt 0) { throw ('Historical LF-normalized hash mismatch: ' + ($lfMismatches -join ', ')) }
  Write-Output "HISTORICAL_HASHES_VERIFIED; LF_EQUAL=$($oldManifest.files.Count); RAW_EQUAL=$rawEqualCount."

  & robocopy $priorApply $candidateSnapshot /E /XD .git /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw 'Could not copy the reconstructed snapshot for candidate build.' }

  $scope = @($oldManifest.files | ForEach-Object { $_.path }) + @('src/utils/project-git-context.ts', 'tests/cli/project-git-context.test.ts')
  foreach ($relativePath in $scope) {
    $source = Join-Path $repo $relativePath
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Candidate source is missing: $relativePath" }
    $destination = Join-Path $candidateSnapshot $relativePath
    $parent = Split-Path -Parent $destination
    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    Copy-Item -LiteralPath $source -Destination $destination -Force
  }

  foreach ($entry in $oldManifest.files) {
    foreach ($pair in @(@{ Root = $baseSource; Directory = $baseScope }, @{ Root = $priorApply; Directory = $priorSnapshot })) {
      $source = Join-Path $pair.Root $entry.path
      if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { continue }
      $destination = Join-Path $pair.Directory $entry.path
      $parent = Split-Path -Parent $destination
      if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
      Copy-Item -LiteralPath $source -Destination $destination -Force
    }
  }
  foreach ($relativePath in $scope) {
    $source = Join-Path $repo $relativePath
    $destination = Join-Path $candidateScope $relativePath
    $parent = Split-Path -Parent $destination
    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    Copy-Item -LiteralPath $source -Destination $destination -Force
  }

  @(
    "timestamp=$((Get-Date).ToString('o'))",
    "base=$base",
    "priorPatchSha256=$((Get-FileHash -LiteralPath $oldPatch -Algorithm SHA256).Hash.ToLowerInvariant())",
    "priorManifestSha256=$((Get-FileHash -LiteralPath $oldManifestPath -Algorithm SHA256).Hash.ToLowerInvariant())",
    "priorSnapshotPathCount=$($oldManifest.files.Count)",
    "priorSnapshotLfNormalizedMismatchCount=$($lfMismatches.Count)",
    "priorSnapshotRawByteEqualCount=$rawEqualCount",
    "nestedPrivatePathCount=$($nestedPrivate.Count)",
    "candidateSourcePathCount=$($scope.Count)",
    "taskRoot=$taskRoot"
  ) | Set-Content -LiteralPath $log -Encoding utf8NoBOM
  Get-Content -LiteralPath $log
} catch {
  "timestamp=$((Get-Date).ToString('o'))`nerror=$($_.Exception.Message)`ntaskRoot=$taskRoot" | Set-Content -LiteralPath $log -Encoding utf8NoBOM
  throw
}
