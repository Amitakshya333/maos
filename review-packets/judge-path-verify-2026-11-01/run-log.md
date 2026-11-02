# Judge-Path Verification Report
## Task C — published event repo reconstruction
Agent: Antigravity (replacing Delta)
Date: 2026-11-01T11:18 IST
Temp base: C:\Users\AMITAKSHYA SUTAR\AppData\Local\Temp\maos-antigravity-20261101-111414

---

## Step 1: Clone event repo + confirm HEAD
- Command: git clone -c core.autocrlf=false https://github.com/Amitakshya333/maos-ind_.git <temp>\event
- Exit code: 0
- HEAD: c655cd01b8afda39f5f0605737bd002670f63cc9  ✓ (matches expected)

## Step 2: Compare file list and content vs staging
- Event clone file count: 300
- Staging (C:\maos\event-staging-2026-10-31) file count: 300
- Missing files (event not in staging): 0
- Missing files (staging not in event): 0
- Content differences (ignoring CRLF vs LF): 0
- Result: EXACT MATCH ✓

## Step 3: Clone core repo at pinned base
- Command: git clone -c core.autocrlf=false https://github.com/Amitakshya333/maos.git <temp>\core
- Exit code: 0
- Command: git -C <temp>\core checkout --detach f9525055c56a7f7771dd2fa029c147c2960a98a3
- Exit code: 0
- HEAD: f9525055c56a7f7771dd2fa029c147c2960a98a3  ✓ (pinned base)

## Step 4: Run apply-event-patches.ps1
- Command: <temp>\event\scripts\apply-event-patches.ps1 -CorePath <temp>\core
- Exit code: 0
- Output: "Applied overlays 0001-0003 to disposable Core checkout ...; tree verifies exactly against event tip 2cfdf9b81f56eada7df2041625da18e44531151e. No commit was created."

### CRLF Finding (resolved)
- First attempt with default clone (core.autocrlf=true) failed: patches were CRLF-converted on Windows checkout, causing SHA-256 mismatch against the script's LF-based manifest hashes.
- Resolution: re-cloned with -c core.autocrlf=false. All three patch hashes matched:
  - 0001-industrial-agent-workflow.patch: 40777ee7ea4edbf534377bbe3012ead6b2588b6b070681f1686003c699c03dd6 ✓
  - 0002-meta-provider-and-bounded-agent.patch: eb68e07bce21e9ac9d5245274bc5fcea787c0a2ae6ec7810e756f933b764d0ec ✓
  - 0003-install-workflows-pilot-baseten.patch: 99fbf264719871d0b25f4075fdfaba8d881963b0ac5af0749095d06613e4abe4 ✓
- Implication for judges: a Windows judge with core.autocrlf=true will hit this hash mismatch. The README should note that patches must be checked out with LF line endings, or a .gitattributes forcing *.patch to binary/LF should be added to the event repo.

## Step 5: Confirm tree hash
- Command: git -C <temp>\core add -A -- && git -C <temp>\core write-tree
- write-tree output: 53305f48e6a7fb039bcf72fa38ab102bcccb9cb8
- Expected:          53305f48e6a7fb039bcf72fa38ab102bcccb9cb8
- MATCH: YES ✓

---

## Summary
| Check | Result |
|-------|--------|
| Event clone HEAD matches expected | ✓ PASS |
| File list matches staging (300 files) | ✓ PASS |
| File content matches staging (ignoring line endings) | ✓ PASS |
| Core pinned base checkout clean | ✓ PASS |
| apply-event-patches.ps1 exit 0 | ✓ PASS |
| Reconstructed tree hash = 53305f48e6a7fb039bcf72fa38ab102bcccb9cb8 | ✓ PASS |

## Finding: CRLF Sensitivity (Severity: Medium)
The apply-event-patches.ps1 script hashes patch files byte-for-byte. On Windows with core.autocrlf=true (the default), git clone converts LF to CRLF, changing the hash. This will cause the script to fail for any judge who clones with the default Windows git config. Recommended: add a .gitattributes to the event repo with *.patch binary or *.patch eol=lf, or document the -c core.autocrlf=false requirement in README section 3.

## Hosts contacted
- github.com (Amitakshya333/maos-ind_.git clone x2, Amitakshya333/maos.git clone x2) — all on allowlist

## Lifecycle scripts run
- None (only git operations and the published apply script)

## What is NOT verified
- npm ci / build / test on the reconstructed tree (that is Task A/B scope)
- Electron/GUI launch (that is Task B scope)
- rust/test.txt canary (absent by owner decision)
