param([Parameter(Mandatory = $true)][string]$ValidationRoot)

$ErrorActionPreference = 'Stop'
$repo = 'C:\maos'
$packet = $PSScriptRoot
$metadata = Get-Content -LiteralPath (Join-Path $packet 'patch-generation.json') -Raw | ConvertFrom-Json
$fullPatch = Join-Path $packet 'complete-delta.patch'
$correctionPatch = Join-Path $packet 'correction-only.patch'
if ((Get-FileHash -LiteralPath $fullPatch -Algorithm SHA256).Hash.ToLowerInvariant() -ne $metadata.completePatchSha256) { throw 'Full patch hash changed after generation.' }
if ((Get-FileHash -LiteralPath $correctionPatch -Algorithm SHA256).Hash.ToLowerInvariant() -ne $metadata.correctionPatchSha256) { throw 'Correction patch hash changed after generation.' }

Get-ChildItem Env: | Where-Object { $_.Name -match '^GIT_' } | ForEach-Object { Remove-Item -LiteralPath ('Env:' + $_.Name) }
$baseSource = if ($env:MAOS_VERIFY_BASE) { $env:MAOS_VERIFY_BASE } else { Join-Path $ValidationRoot 'base-source-recheck' }
$priorSnapshot = if ($env:MAOS_VERIFY_PRIOR) { $env:MAOS_VERIFY_PRIOR } else { Join-Path $ValidationRoot 'prior-snapshot-recheck' }
$candidateScope = Join-Path $ValidationRoot 'candidate-scope-lf'
$fullManifest = Get-Content -LiteralPath (Join-Path $packet 'complete-source-hashes.json') -Raw | ConvertFrom-Json

& git -C $baseSource init | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not initialize isolated full-delta application root.' }
& git -C $baseSource config core.autocrlf false
& git -C $baseSource apply -p2 --check $fullPatch
$fullCheck = $LASTEXITCODE
if ($fullCheck -ne 0) { throw "Full delta apply check failed: $fullCheck" }
& git -C $baseSource apply -p2 $fullPatch
$fullApply = $LASTEXITCODE
if ($fullApply -ne 0) { throw "Full delta application failed: $fullApply" }

& git -C $priorSnapshot init | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not initialize isolated correction application root.' }
& git -C $priorSnapshot config core.autocrlf false
& git -C $priorSnapshot apply -p2 --check $correctionPatch
$correctionCheck = $LASTEXITCODE
if ($correctionCheck -ne 0) { throw "Correction-only apply check failed: $correctionCheck" }
& git -C $priorSnapshot apply -p2 $correctionPatch
$correctionApply = $LASTEXITCODE
if ($correctionApply -ne 0) { throw "Correction-only patch application failed: $correctionApply" }

$fullRawEqual = 0; $fullLfEqual = 0; $correctionRawEqual = 0; $correctionLfEqual = 0
$mismatches = [System.Collections.Generic.List[string]]::new()
$fullRawMismatches = [System.Collections.Generic.List[string]]::new()
$correctionRawMismatches = [System.Collections.Generic.List[string]]::new()
foreach ($entry in $fullManifest.files) {
  $fullFile = Join-Path $baseSource $entry.path
  $correctionFile = Join-Path $priorSnapshot $entry.path
  foreach ($target in @(@{ Path = $fullFile; Prefix = 'full' }, @{ Path = $correctionFile; Prefix = 'correction' })) {
    if (-not (Test-Path -LiteralPath $target.Path -PathType Leaf)) { $mismatches.Add("$($target.Prefix):$($entry.path)"); continue }
    $targetBytes = [System.IO.File]::ReadAllBytes($target.Path)
    $targetText = [System.Text.Encoding]::UTF8.GetString($targetBytes)
    $targetLf = [System.Text.Encoding]::UTF8.GetBytes([regex]::Replace($targetText, "`r`n?", "`n"))
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
      $targetRawHash = [BitConverter]::ToString($sha256.ComputeHash($targetBytes)).Replace('-', '').ToLowerInvariant()
      $targetLfHash = [BitConverter]::ToString($sha256.ComputeHash($targetLf)).Replace('-', '').ToLowerInvariant()
    }
    finally { $sha256.Dispose() }
    $rawMatch = $entry.rawSha256 -ceq $targetRawHash
    $lfMatch = $entry.lfSha256 -ceq $targetLfHash
    if (-not $lfMatch) { $mismatches.Add("$($target.Prefix):$($entry.path)") }
    if (-not $rawMatch) {
      if ($target.Prefix -eq 'full') { $fullRawMismatches.Add($entry.path) }
      else { $correctionRawMismatches.Add($entry.path) }
    }
    if ($target.Prefix -eq 'full') { if ($rawMatch) { $fullRawEqual++ }; if ($lfMatch) { $fullLfEqual++ } }
    else { if ($rawMatch) { $correctionRawEqual++ }; if ($lfMatch) { $correctionLfEqual++ } }
  }
}
if ($mismatches.Count -gt 0) { throw ('Reconstruction mismatch: ' + ($mismatches -join ', ')) }

$result = [ordered]@{
  baseCommit = '189e786ff0431b02b95ca618bb4791a5ad7b0215'
  fullPatchSha256 = $metadata.completePatchSha256
  correctionPatchSha256 = $metadata.correctionPatchSha256
  fullApplyCheckExitCode = $fullCheck
  fullApplyExitCode = $fullApply
  correctionApplyCheckExitCode = $correctionCheck
  correctionApplyExitCode = $correctionApply
  sourceFileCount = $fullManifest.files.Count
  comparedAgainst = 'current source manifest rawSha256/lfSha256 fields'
  fullRawByteEqualCount = $fullRawEqual
  fullLfNormalizedEqualCount = $fullLfEqual
  fullRawByteMismatchPaths = @($fullRawMismatches)
  correctionRawByteEqualCount = $correctionRawEqual
  correctionLfNormalizedEqualCount = $correctionLfEqual
  correctionRawByteMismatchPaths = @($correctionRawMismatches)
  mismatches = @()
  checkedAt = (Get-Date).ToString('o')
}
$result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $packet 'reconstruction-results.json') -Encoding UTF8
$result | ConvertTo-Json -Depth 5

