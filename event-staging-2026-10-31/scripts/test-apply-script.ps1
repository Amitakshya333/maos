param([Parameter(Mandatory = $true)][string]$CoreRepo, [Parameter(Mandatory = $true)][string]$WorkRoot)
# Durable regression test for scripts/apply-event-patches.ps1 (APPLY-SCRIPT-07).
# Covers: index-path verification in a NORMAL CLONE (the demonstrated bug),
# linked-worktree positive, idempotent rerun, staged-index refusal, ambient
# GIT_INDEX_FILE refusal, wrong-base refusal. All fixtures are disposable
# local clones/worktrees under WorkRoot (no network). Never point WorkRoot
# or CoreRepo at a retained checkout such as C:\clean\core.
$ErrorActionPreference = 'Stop'

$Base = 'f9525055c56a7f7771dd2fa029c147c2960a98a3'
$Tip = '2cfdf9b81f56eada7df2041625da18e44531151e'
$TipTree = '53305f48e6a7fb039bcf72fa38ab102bcccb9cb8'
$ApplyScript = Join-Path $PSScriptRoot 'apply-event-patches.ps1'
$failures = @()

function Invoke-Git([string[]]$gitArgs) {
  # Local Continue: git writes progress/diagnostics to stderr, which merged
  # via 2>&1 must not terminate fixture setup (exit code carries the result).
  $ErrorActionPreference = 'Continue'
  $out = & git @gitArgs 2>&1
  $code = $LASTEXITCODE
  return @{ Exit = $code; Out = ($out | Out-String).Trim() }
}

function Assert-Case([string]$name, [bool]$cond, [string]$detail) {
  if ($cond) { Write-Output "PASS: $name" } else { Write-Output "FAIL: $name -- $detail"; $script:failures += $name }
}

function New-CleanClone([string]$dest) {
  if ((Invoke-Git @('clone', '--no-checkout', $CoreRepo, $dest)).Exit -ne 0) { throw "clone to $dest failed" }
  if ((Invoke-Git @('-C', $dest, 'checkout', $Base)).Exit -ne 0) { throw "checkout in $dest failed" }
}

function Invoke-Apply([string]$target, [string]$envName, [string]$envVal) {
  if ($envName) { Set-Item -Path "Env:\$envName" -Value $envVal }
  try {
    $o = Join-Path $env:TEMP 't-apply.out'; $e = Join-Path $env:TEMP 't-apply.err'
    $p = Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile', '-NonInteractive', '-File', $ApplyScript, '-CorePath', $target -NoNewWindow -Wait -PassThru -RedirectStandardOutput $o -RedirectStandardError $e
    $text = ((Get-Content $o, $e -Raw -ErrorAction SilentlyContinue | Out-String))
    Remove-Item $o, $e -Force -ErrorAction SilentlyContinue
    return @{ Exit = $p.ExitCode; Text = $text }
  } finally {
    if ($envName) { Remove-Item "Env:\$envName" -ErrorAction SilentlyContinue }
  }
}

foreach ($p in @($CoreRepo, $WorkRoot)) {
  $full = [IO.Path]::GetFullPath($p)
  if ($full.Equals('C:\clean\core', [StringComparison]::OrdinalIgnoreCase) -or $full.StartsWith('C:\clean\core\', [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing: $p touches the retained C:\clean\core checkout. Use disposable paths only."
  }
}
if (-not (Test-Path -LiteralPath $CoreRepo)) { throw "CoreRepo not found: $CoreRepo" }
New-Item -ItemType Directory -Path $WorkRoot -Force | Out-Null

try {
  # T1: normal-clone positive with independent tree confirmation.
  $pos = Join-Path $WorkRoot 'pos'
  New-CleanClone $pos
  $r1 = Invoke-Apply $pos '' ''
  Assert-Case 'clone-positive-exit-0' ($r1.Exit -eq 0) ("exit=$($r1.Exit)")
  $null = Invoke-Git @('-C', $pos, 'add', '-A')
  $tree = (Invoke-Git @('-C', $pos, 'write-tree')).Out
  Assert-Case 'clone-positive-tree' ($tree -eq $TipTree) ("tree=$tree")
  # T2: idempotent rerun on an unmodified post-run tree needs a fresh clone
  # (T1 staged the index for its independent check).
  $idem = Join-Path $WorkRoot 'idem'
  New-CleanClone $idem
  $ra = Invoke-Apply $idem '' ''
  $rb = Invoke-Apply $idem '' ''
  Assert-Case 'clone-idempotent' ($ra.Exit -eq 0 -and $rb.Exit -eq 0 -and $rb.Text -match 'already applied') ("first=$($ra.Exit) second=$($rb.Exit)")
  # T3: staged-index refusal (worktree == tip but staged).
  $st = Join-Path $WorkRoot 'staged'
  New-CleanClone $st
  $null = Invoke-Apply $st '' ''
  $null = Invoke-Git @('-C', $st, 'add', '-A')
  $r3 = Invoke-Apply $st '' ''
  Assert-Case 'clone-staged-refusal' ($r3.Exit -eq 1 -and $r3.Text -match 'staged changes differing from HEAD' -and $r3.Text -notmatch 'already applied') ("exit=$($r3.Exit)")
  # T4: ambient GIT_INDEX_FILE refusal.
  $r4 = Invoke-Apply (Join-Path $WorkRoot 'pos') 'GIT_INDEX_FILE' 'C:\bogus\index.lock'
  Assert-Case 'clone-envguard-refusal' ($r4.Exit -eq 1 -and $r4.Text -match 'GIT_INDEX_FILE') ("exit=$($r4.Exit)")
  # T5: wrong-base refusal.
  $wb = Join-Path $WorkRoot 'wrongbase'
  if ((Invoke-Git @('clone', '--no-checkout', $CoreRepo, $wb)).Exit -ne 0) { throw "clone to $wb failed" }
  if ((Invoke-Git @('-C', $wb, 'checkout', '256befbbf6d54c660281bc2a5100f0c6aa01668b')).Exit -ne 0) { throw "checkout in $wb failed" }
  $r5 = Invoke-Apply $wb '' ''
  Assert-Case 'clone-wrongbase-refusal' ($r5.Exit -eq 1 -and $r5.Text -match 'Expected clean Core base') ("exit=$($r5.Exit)")
  # T6: linked-worktree positive regression (absolute --git-path already).
  $wt = Join-Path $WorkRoot 'wt-pos'
  if ((Invoke-Git @('-C', $CoreRepo, 'worktree', 'add', '--detach', $wt, $Base)).Exit -ne 0) { throw "worktree add $wt failed" }
  try {
    $r6 = Invoke-Apply $wt '' ''
    Assert-Case 'worktree-positive' ($r6.Exit -eq 0) ("exit=$($r6.Exit)")
  } finally {
    $null = Invoke-Git @('-C', $CoreRepo, 'worktree', 'remove', '--force', $wt)
  }
} finally {
  Remove-Item -Recurse -Force $WorkRoot -ErrorAction SilentlyContinue
}

if ($failures.Count -gt 0) { Write-Output "RESULT: FAIL ($($failures.Count) cases)"; exit 1 }
Write-Output 'RESULT: PASS (all 6 checks)'
exit 0
