from __future__ import annotations

import hashlib
import json
import os
import pathlib
import shutil
import subprocess

EVIDENCE = pathlib.Path(r"C:\maos\review-packets\baseten-reasoning-budget-2026-10-30\fresh-bootstrap-2cfdf9b-2026-10-30")
INSTALL_ROOT = pathlib.Path(r"C:\Users\AMITAKSHYA SUTAR\AppData\Local\Temp\MAOS installed mock 2cfdf9b retry3")
APP_ROOT = INSTALL_ROOT / "app"
SCRIPT = EVIDENCE / "installed-baseten-mock-smoke.cjs"
SYNTHETIC_ROOT = pathlib.Path(r"C:\Users\AMITAKSHYA SUTAR\AppData\Local\Temp\MAOS synthetic pilot projects 2cfdf9b retry3 engine final")
BUNDLE = EVIDENCE / "retry3-native-tar-maos-industrial-windows-x64.zip"
EXPECTED_BUNDLE_SHA256 = "797b3f89d94b37f9ddb765e413679d4ae8335aad18e5feac2d8d481a65cd1c59"
ENGINE = pathlib.Path(r"C:\Users\AMITAKSHYA SUTAR\.codex\worktrees\baseten-gate-validation-2026-10-29\rust\target\release\maos-engine.exe")
EXPECTED_ENGINE_SHA256 = "3dc07f0a5b097867e5e9b150d54e6490898b7465dcfe654a6e490d9c9b6da2a2"

if not APP_ROOT.is_dir() or not (APP_ROOT / "dist" / "service" / "index.js").is_file():
    raise SystemExit(f"installed application modules are missing: {APP_ROOT}")
if SYNTHETIC_ROOT.exists():
    raise SystemExit(f"refusing to reuse synthetic test root: {SYNTHETIC_ROOT}")
if not ENGINE.is_file():
    raise SystemExit(f"external test engine fixture is unavailable: {ENGINE}")
engine_sha = hashlib.sha256(ENGINE.read_bytes()).hexdigest()
if engine_sha != EXPECTED_ENGINE_SHA256:
    raise SystemExit(f"engine fixture hash mismatch: {engine_sha}")
health = subprocess.run([str(ENGINE)], input=b'{"version":"1.0","operation":"health"}\n', stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)
if health.returncode != 0:
    raise SystemExit(f"engine protocol health failed with exit {health.returncode}")
health_response = json.loads(health.stdout.decode("utf-8"))
if health_response.get("version") != "1.0" or health_response.get("data", {}).get("status") != "ok":
    raise SystemExit("engine fixture protocol health response did not match protocol 1.0")
engine_record = {
    "path": str(ENGINE),
    "bytes": ENGINE.stat().st_size,
    "sha256": engine_sha,
    "protocolHealthResponse": health_response,
    "classification": "External test fixture only; unsigned, unapproved, publisher provenance unavailable; not a product-bundle member.",
}
actual_bundle_sha = hashlib.sha256(BUNDLE.read_bytes()).hexdigest()
if actual_bundle_sha != EXPECTED_BUNDLE_SHA256:
    raise SystemExit(f"bundle hash changed before smoke: {actual_bundle_sha}")
path_entries = [r"C:\Windows\System32"]
path_entries.extend(os.environ.get("PATH", "").split(os.pathsep))
env = {key: os.environ[key] for key in ("PATH", "SYSTEMROOT", "PATHEXT") if key in os.environ}
env["PATH"] = os.pathsep.join(path_entries)
env.update({
    "OS": "Windows_NT",
    "WINDIR": r"C:\Windows",
    "TEMP": str(SYNTHETIC_ROOT),
    "TMP": str(SYNTHETIC_ROOT),
    "HOME": str(SYNTHETIC_ROOT),
    "USERPROFILE": str(SYNTHETIC_ROOT),
    "MAOS_TEST_ENGINE_PATH": str(ENGINE),
})
node = shutil.which("node.exe", path=env["PATH"])
if not node:
    raise SystemExit("node.exe unavailable")
command = [node, str(SCRIPT), str(APP_ROOT), str(SYNTHETIC_ROOT)]
label = "retry3-installed-smoke-final"
(EVIDENCE / f"{label}.command.txt").write_text(" ".join(command) + "\n", encoding="utf-8")
(EVIDENCE / f"{label}-context.json").write_text(json.dumps({
    "bundle": BUNDLE.name,
    "bundleSha256": actual_bundle_sha,
    "installedApp": str(APP_ROOT),
    "syntheticProjectRoot": str(SYNTHETIC_ROOT),
    "node": node,
    "externalEngine": engine_record,
    "hostedCredentialsInherited": False,
    "networkPolicy": "global fetch accepts only the exact configured Baseten URL and bridges it to 127.0.0.1; all other destinations throw",
}, indent=2) + "\n", encoding="utf-8")
result = subprocess.run(command, cwd=INSTALL_ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180)
(EVIDENCE / f"{label}.stdout.txt").write_bytes(result.stdout)
(EVIDENCE / f"{label}.stderr.txt").write_bytes(result.stderr)
(EVIDENCE / f"{label}.exit-code.txt").write_text(f"{result.returncode}\n", encoding="ascii")
print(f"installed_smoke_exit={result.returncode}")
print(result.stdout.decode("utf-8", "replace"))
print(result.stderr.decode("utf-8", "replace"))
if result.returncode != 0:
    raise SystemExit(result.returncode)
text = result.stdout.decode("utf-8")
marker = '\n{\n  "schemaVersion": 1,\n  "bundleCommit": '
index = text.rfind(marker)
if index < 0:
    raise SystemExit("could not locate final pretty-printed smoke summary")
summary, end = json.JSONDecoder().raw_decode(text[index + 1:])
if text[index + 1 + end:].strip():
    raise SystemExit("unexpected trailing stdout after smoke summary")
if not summary.get("passed") or summary.get("hostedRequests") != 0 or len(summary.get("cases", [])) != 7:
    raise SystemExit("installed smoke summary did not report seven passing cases and zero hosted requests")
if not all(case.get("passed") for case in summary["cases"]):
    raise SystemExit("one or more installed smoke cases failed")
for marker_text in ("synthetic-installed-baseten-smoke-key-not-real", "SYNTHETIC_INSTALLED_PRIVATE_REASONING_NOT_FOR_STORAGE"):
    if marker_text in text or marker_text in result.stderr.decode("utf-8", "replace"):
        raise SystemExit("synthetic credential or reasoning marker leaked into captured process output")
(EVIDENCE / f"{label}-summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
print(f"summary={label}-summary.json cases={len(summary['cases'])} all_passed=true hosted_requests=0")
