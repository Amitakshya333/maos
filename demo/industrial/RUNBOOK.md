# Industrial demo runbook

1. Keep the generic `.maos` configuration backed up.
2. Start `python scripts/huggingface-openai-server.py`, then run `powershell -ExecutionPolicy Bypass -File scripts/industrial-preflight.ps1`.
3. Verify `expected_findings.json` still matches the CSV with the validation command below.
4. Activate the profile using `profiles/industrial/README.md`.
5. Start MAOS and submit the industrial workflow tasks.
6. Confirm the generated report says `FAIL`, cites all four anomaly rows, and includes the ruleset disclaimer.
7. Restore the generic profile after the demonstration.

Dataset validation:

```powershell
$rows = Import-Csv demo/industrial/turbine_vibration_log.csv
if ($rows.Count -ne 500) { throw "Expected 500 rows, got $($rows.Count)" }
$expected = Get-Content -Raw demo/industrial/expected_findings.json | ConvertFrom-Json
foreach ($finding in $expected.documentedAnomalies) {
  $row = $rows[$finding.row - 1]
  if ([DateTimeOffset]::Parse($row.timestamp) -ne [DateTimeOffset]$finding.timestamp) { throw "Timestamp mismatch at row $($finding.row)" }
  if ([double]$row.($finding.field) -ne [double]$finding.value) { throw "Value mismatch at row $($finding.row)" }
}
Write-Host "Industrial evidence validation passed."
```
