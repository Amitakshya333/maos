param([Parameter(Mandatory = $true)][string]$CorePath)
# Applies event patches 0001-0003 in order onto a clean Core checkout at the
# pinned base f9525055, reconstructing exactly the event tip 2cfdf9b.
# Fail-closed: ambient GIT_INDEX_FILE/GIT_DIR/GIT_WORK_TREE overrides, wrong
# base, dirty checkout, staged-only index differences, patch hash mismatch,
# partial application, or result mismatch all abort with no commit, no reset,
# and no modification beyond the patches applied so far (a failed patch
# applies nothing: git apply is atomic per file set). This script never
# resets, checks out, deletes, or overwrites user files outside the patch
# contents. Verification always targets the checkout's real repository and
# index (explicitly resolved, never an override).
$ErrorActionPreference = 'Stop'

$Base = 'f9525055c56a7f7771dd2fa029c147c2960a98a3'
$Tip = '2cfdf9b81f56eada7df2041625da18e44531151e'
$Patches = @(
  @{ File = '0001-industrial-agent-workflow.patch'; Sha256 = '40777ee7ea4edbf534377bbe3012ead6b2588b6b070681f1686003c699c03dd6'; Result = '239a0042b08a3960d3c89f890f01ab194ff82f1f' },
  @{ File = '0002-meta-provider-and-bounded-agent.patch'; Sha256 = 'eb68e07bce21e9ac9d5245274bc5fcea787c0a2ae6ec7810e756f933b764d0ec'; Result = '189e786ff0431b02b95ca618bb4791a5ad7b0215' },
  @{ File = '0003-install-workflows-pilot-baseten.patch'; Sha256 = '99fbf264719871d0b25f4075fdfaba8d881963b0ac5af0749095d06613e4abe4'; Result = '2cfdf9b81f56eada7df2041625da18e44531151e' }
)

function Assert-CleanGitEnv([string]$action) {
  # Any of these overrides would redirect git at the checkout elsewhere:
  # fail closed before any inspection. Called at startup and re-checked at
  # every verification.
  foreach ($v in @('GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE')) {
    $val = [Environment]::GetEnvironmentVariable($v)
    if ($val) { throw "Refusing to $action with $v set in the environment ('$val'): every git inspection in this script must target the given checkout's real repository and index. Unset it and retry; nothing was inspected or changed." }
  }
}

Assert-CleanGitEnv 'run'

function Invoke-Git([string]$core, [string[]]$gitArgs) {
  # Function-local Continue: stderr merged via 2>&1 arrives as error records
  # and must not terminate probing calls (exit code carries the result).
  $ErrorActionPreference = 'Continue'
  $out = & git -C $core @gitArgs 2>&1
  $code = $LASTEXITCODE
  return @{ Exit = $code; Out = ($out | Out-String).Trim() }
}

function Confirm-TreeEquals([string]$core, [string]$rev, [string]$stage) {
  # Exact worktree-vs-tree comparison via a THROWAWAY index: stages the
  # worktree into a temp index file and compares write-tree output with the
  # expected tree SHA. Never touches the real index or any worktree file.
  # (Plain `git diff <rev>` cannot be used: it reports patch-added files as
  # deleted because they are absent from the real index.) Throws on mismatch.
  # The environment and real index path are explicitly verified first: any
  # GIT_INDEX_FILE/GIT_DIR/GIT_WORK_TREE override fails closed here.
  Assert-CleanGitEnv "verify $stage"
  $probe = Invoke-Git $core @('cat-file', '-e', "$rev^{commit}")
  if ($probe.Exit -ne 0) { throw "Cannot verify ${stage}: commit $rev is not present locally. Fetch refs/tags/event-core-2cfdf9b first; no changes were reverted." }
  $want = (Invoke-Git $core @('rev-parse', "$rev^{tree}")).Out
  $gitDir = (Invoke-Git $core @('rev-parse', '--absolute-git-dir')).Out
  # Request absolute formatting (normal clones otherwise return a relative
  # ".git/index"); fall back to plain output on old git. Either way,
  # normalize a still-relative result against the target checkout before
  # comparing, so ordinary clones and linked worktrees both verify.
  $resolved = Invoke-Git $core @('rev-parse', '--path-format=absolute', '--git-path', 'index')
  if ($resolved.Exit -ne 0) { $resolved = Invoke-Git $core @('rev-parse', '--git-path', 'index') }
  $resolvedIndex = $resolved.Out
  if (-not [IO.Path]::IsPathRooted($resolvedIndex)) { $resolvedIndex = Join-Path $core $resolvedIndex }
  $intendedIndex = Join-Path $gitDir 'index'
  try {
    $resolvedIndex = [IO.Path]::GetFullPath($resolvedIndex)
    $intendedIndex = [IO.Path]::GetFullPath($intendedIndex)
  } catch {
    throw "Refusing to verify ${stage}: cannot normalize index paths ('$($resolved.Out)' vs '$gitDir/index'). Unset GIT_INDEX_FILE and retry."
  }
  if (-not $resolvedIndex.Equals($intendedIndex, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to verify ${stage}: git resolves the index to '$($resolved.Out)' instead of the checkout's real index '$intendedIndex'. Unset GIT_INDEX_FILE and retry."
  }
  $tempIndex = [IO.Path]::Combine([IO.Path]::GetTempPath(), "maos-event-verify-$([IO.Path]::GetRandomFileName()).idx")
  $oldIndex = $env:GIT_INDEX_FILE
  try {
    Copy-Item -LiteralPath $intendedIndex -Destination $tempIndex -Force -ErrorAction Stop
    $env:GIT_INDEX_FILE = $tempIndex
    $add = Invoke-Git $core @('add', '-A', '--')
    if ($add.Exit -ne 0) { throw "Cannot verify ${stage}: temporary staging failed." }
    $got = (Invoke-Git $core @('write-tree')).Out
  } finally {
    if ($null -eq $oldIndex) { Remove-Item Env:\GIT_INDEX_FILE -ErrorAction SilentlyContinue } else { $env:GIT_INDEX_FILE = $oldIndex }
    if (Test-Path -LiteralPath $tempIndex) { Remove-Item -LiteralPath $tempIndex -Force -ErrorAction SilentlyContinue }
  }
  if ($want -ne $got) { throw "Result mismatch after ${stage}: reconstructed tree $got differs from $rev tree $want. Restore a clean base checkout and retry; this script will not reset anything." }
}

$core = (Resolve-Path -LiteralPath $CorePath).Path
$patchRoot = Join-Path $PSScriptRoot '..\patches'
foreach ($p in $Patches) {
  $p.Path = (Resolve-Path -LiteralPath (Join-Path $patchRoot $p.File) -ErrorAction Stop).Path
  $actual = (Get-FileHash -LiteralPath $p.Path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $p.Sha256) { throw "Patch mismatch: $($p.File) SHA-256 $actual does not match manifest $($p.Sha256). Nothing was applied." }
}

$head = Invoke-Git $core @('rev-parse', 'HEAD')
if ($head.Exit -ne 0 -or $head.Out -ne $Base) { throw "Expected clean Core base $Base; found '$($head.Out)'. Use a disposable checkout at the pinned base." }
$tipProbe = Invoke-Git $core @('cat-file', '-e', "$Tip^{commit}")
if ($tipProbe.Exit -ne 0) { throw "Tip commit $Tip is not present locally. Fetch refs/tags/event-core-2cfdf9b first; nothing was applied." }
$clean = Invoke-Git $core @('status', '--porcelain')
if ($clean.Out.Length -eq 0) {
  # HEAD is the base and the tree is clean, so this is a pristine base:
  # fall through to apply all three overlays below.
} else {
  # Dirty tree. First: the real index must equal HEAD — staged-only
  # differences make overlay-state classification ambiguous, so they fail
  # closed here and are NEVER reported as idempotent application.
  $cached = Invoke-Git $core @('diff', '--cached', '--quiet', 'HEAD', '--')
  if ($cached.Exit -ne 0) { throw 'The real index contains staged changes differing from HEAD. Unstage them (or restore a clean base checkout) and retry; the overlay cannot be classified while staged-only differences exist. Nothing was applied or reverted.' }
  # Index == HEAD, so all dirt is worktree-only: distinguish fully-applied
  # (idempotent success), partial (precise failure), and foreign
  # modifications (generic failure) by exact tree comparison.
  $resolved = $true
  try { Confirm-TreeEquals $core $Tip 're-run check' } catch { $resolved = $false }
  if ($resolved) {
    Write-Output "All three overlays were already applied to $core and the tree verifies exactly against $Tip. No commit was created."
    return
  }
  $stage = $null
  try { Confirm-TreeEquals $core $Patches[0].Result 'partial check'; $stage = '0001 applied; 0002 and 0003 pending' } catch { }
  if (-not $stage) {
    try { Confirm-TreeEquals $core $Patches[1].Result 'partial check'; $stage = '0001 and 0002 applied; 0003 pending' } catch { }
  }
  if ($stage) { throw "Partial application detected ($stage). Restore a clean base checkout and retry; this script will not reset anything." }
  throw 'Core checkout is not clean (unrecognized modifications). Use a disposable checkout; nothing was applied and nothing was reverted.'
}

for ($i = 0; $i -lt $Patches.Count; $i++) {
  $p = $Patches[$i]
  $pre = Invoke-Git $core @('apply', '--check', '--', $p.Path)
  if ($pre.Exit -ne 0) { throw "Overlay $($p.File) did not apply cleanly: $($pre.Out). Earlier overlays are untouched by this failure; restore a clean base checkout and retry." }
  $run = Invoke-Git $core @('apply', '--', $p.Path)
  if ($run.Exit -ne 0) { throw "Overlay $($p.File) application failed: $($run.Out). Restore a clean base checkout and retry." }
  Confirm-TreeEquals $core $p.Result $p.File
}
Write-Output "Applied overlays 0001-0003 to disposable Core checkout $core; tree verifies exactly against event tip $Tip. No commit was created."
