from __future__ import annotations

import json
import pathlib

EVIDENCE = pathlib.Path(r"C:\maos\review-packets\baseten-reasoning-budget-2026-10-30\fresh-bootstrap-2cfdf9b-2026-10-30")
stdout_path = EVIDENCE / "retry3-installed-smoke-engine.stdout.txt"
stderr_path = EVIDENCE / "retry3-installed-smoke-engine.stderr.txt"
exit_path = EVIDENCE / "retry3-installed-smoke-engine.exit-code.txt"
text = stdout_path.read_text(encoding="utf-8")
stderr = stderr_path.read_text(encoding="utf-8")
if exit_path.read_text(encoding="ascii").strip() != "0":
    raise SystemExit("installed Node smoke did not exit zero")
marker = '\n{\n  "schemaVersion": 1,\n  "bundleCommit": '
index = text.rfind(marker)
if index < 0:
    raise SystemExit("could not locate final pretty-printed smoke summary")
summary, end = json.JSONDecoder().raw_decode(text[index + 1:])
if text[index + 1 + end:].strip():
    raise SystemExit("unexpected trailing data after smoke summary")
if not summary.get("passed") or summary.get("hostedRequests") != 0 or len(summary.get("cases", [])) != 7:
    raise SystemExit("installed smoke summary did not match the expected seven passing cases")
if not all(case.get("passed") for case in summary["cases"]):
    raise SystemExit("one or more installed smoke cases failed")
for marker_text in ("synthetic-installed-baseten-smoke-key-not-real", "SYNTHETIC_INSTALLED_PRIVATE_REASONING_NOT_FOR_STORAGE"):
    if marker_text in text or marker_text in stderr:
        raise SystemExit("synthetic credential/reasoning marker leaked into captured process output")
(EVIDENCE / "retry3-installed-smoke-engine-summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"passed": True, "cases": len(summary["cases"]), "childExit": 0, "stdoutCredentialMarkersAbsent": True, "summaryPath": "retry3-installed-smoke-engine-summary.json"}, sort_keys=True))
