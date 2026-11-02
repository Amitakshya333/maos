# Ring reliability — live run card (demo machine, on camera, one command)

Scope: exactly the 5 instructions in `INSTRUCTIONS.md`, run live once
each (3-5 runs total per the task; 5/5 is the full set). No debugging on
camera: if the first command below fails, stop and reschedule — do not
troubleshoot live.

## 0. Preconditions (check off camera, before recording)

- Staging dir `C:/clean/ring-agent-demo-01` (engine staged, disposable
  `.maos` Baseten block) exists with `dist/` built and `node_modules/`
  installed.
- `scripts/ring-tool-reliability-check.mjs` present at the staging root
  and identical to base `64471c6`
  (`node -e "console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync('scripts/ring-tool-reliability-check.mjs')).digest('hex'))"`
  must print `2c474f6a56957bb4cd7b5b7a33b1f509aecbbd4e4b62348bb790c0b407689189`).
- Key is in the launcher shell ONLY (`$env:BASETEN_API_KEY` set in that
  PowerShell window; never pasted, never in a file).

## 1. THE command (paste exactly this, in the launcher shell, at the staging root)

```powershell
node scripts/ring-tool-reliability-check.mjs --live
```

What it does: runs the 4 built-in live instructions
(`telemetry-verdict`, `sop-read-and-search`, `memory-and-plan`,
`audit-verify`) against the REAL Baseten endpoint, then prints one
`[live] <id>:` line per instruction plus `live reliability: X/4 passed`.
Then, for the 5th PM run (`followup-recall` from `INSTRUCTIONS.md`),
paste that instruction into the demo agent and record its transcript
fields by hand per section 2.

Expected wall time: up to 4 min per instruction timeout
(`PER_INSTRUCTION_TIMEOUT_MS = 240000`); typical total well under that.
Exit `0` = all passed; exit `1` = at least one instruction failed (see
section 3); exit `2` = harness error. Any provider error exits non-zero
at once: one failure = stop (no retry loops — per direction).

## 2. What to record per run (all 5)

For each instruction, copy these fields from its `[live]` line (harness
runs 1-4) or the agent transcript (run 5, `followup-recall`):

| Field | Where | y/n or value |
|---|---|---|
| tools called | `tools=[...]` (must equal INSTRUCTIONS.md expected tools, in order) | |
| args valid | `argsOk=` | y / n |
| final answer | non-empty final answer present | y / n |
| delta count | count of `model.delta` transcript entries for the run (streaming fragments; evidence-only runs record none) | number |
| delta-count source | harness JSON report (`os.tmpdir()/maos-ring-reliab-report-*/live-report.json`) or run transcript `.maos/ring-runs/<runId>.jsonl` | path |
| leak check | `leakedRows` empty AND no `timestamp,asset_id,vibration_rms_mm_s` in final answer | y / n |
| latency | `elapsedMs` per instruction | ms |

Also record: exit code of the `--live` command, and the report path
printed on the `live reliability:` line.

## 3. The 4-of-5 decision rule (verbatim)

**PASS iff at least 4 of the 5 live runs each satisfy ALL of: expected
tools called in order, args valid = y, final answer = y, delta count
recorded, leak check = y. Otherwise FAIL.**

Notes:
- A consequential-gate auto-deny (`create_work_order` in run 3) is the
  expected stop and counts as its run's final answer = y, provided the
  denial is recorded and no file was written.
- Any provider error (auth/network/model) fails that run at once; the
  harness exits non-zero without retrying.
- Do NOT re-run a failed instruction on camera. Record the failure and
  apply the rule as written.

## 4. After the runs (off camera)

- Confirm the JSON report contains no key material (the harness already
  refuses to keep a report containing the key; spot-check the file for
  `[REDACTED]` absence of the raw key is NOT possible — instead verify
  the key value string does not appear; keep the report path only).
- File this packet's SHA-256s; report exit code + per-run table + PASS/FAIL.
