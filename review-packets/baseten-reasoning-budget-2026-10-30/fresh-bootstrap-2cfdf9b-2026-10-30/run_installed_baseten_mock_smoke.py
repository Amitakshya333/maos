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
SYNTHETIC_ROOT = pathlib.Path(r"C:\Users\AMITAKSHYA SUTAR\AppData\Local\Temp\MAOS synthetic pilot projects 2cfdf9b retry3")
BUNDLE = EVIDENCE / "retry3-native-tar-maos-industrial-windows-x64.zip"
EXPECTED_BUNDLE_SHA256 = "797b3f89d94b37f9ddb765e413679d4ae8335aad18e5feac2d8d481a65cd1c59"

if not APP_ROOT.is_dir() or not (APP_ROOT / "dist" / "service" / "index.js").is_file():
    raise SystemExit(f"installed application modules are missing: {APP_ROOT}")
if SYNTHETIC_ROOT.exists():
    raise SystemExit(f"refusing to reuse synthetic test root: {SYNTHETIC_ROOT}")
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
})
node = shutil.which("node.exe", path=env["PATH"])
if not node:
    raise SystemExit("node.exe unavailable")
command = [node, str(SCRIPT), str(APP_ROOT), str(SYNTHETIC_ROOT)]
(EVIDENCE / "retry3-installed-smoke.command.txt").write_text(" ".join(command) + "\n", encoding="utf-8")
(EVIDENCE / "retry3-installed-smoke-context.json").write_text(json.dumps({
    "bundle": BUNDLE.name,
    "bundleSha256": actual_bundle_sha,
    "installedApp": str(APP_ROOT),
    "syntheticProjectRoot": str(SYNTHETIC_ROOT),
    "node": node,
    "hostedCredentialsInherited": False,
    "networkPolicy": "global fetch accepts only the exact configured Baseten URL and bridges it to 127.0.0.1; all other destinations throw",
}, indent=2) + "\n", encoding="utf-8")
result = subprocess.run(command, cwd=INSTALL_ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180)
(EVIDENCE / "retry3-installed-smoke.stdout.txt").write_bytes(result.stdout)
(EVIDENCE / "retry3-installed-smoke.stderr.txt").write_bytes(result.stderr)
(EVIDENCE / "retry3-installed-smoke.exit-code.txt").write_text(f"{result.returncode}\n", encoding="ascii")
print(f"installed_smoke_exit={result.returncode}")
print(result.stdout.decode("utf-8", "replace"))
print(result.stderr.decode("utf-8", "replace"))
if result.returncode != 0:
    raise SystemExit(result.returncode)

summary = json.loads(result.stdout.decode("utf-8").strip().splitlines()[-1])
if not summary.get("passed") or summary.get("hostedRequests") != 0:
    raise SystemExit("installed mock smoke summary assertions failed")
(EVIDENCE / "retry3-installed-smoke-summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
