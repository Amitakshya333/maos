from __future__ import annotations

import os
import pathlib
import shutil
import subprocess

WORKTREE = pathlib.Path(r"C:\Users\AMITAKSHYA SUTAR\AppData\Local\Temp\maos-baseten-budget-2cfdf9b-retry3-checkout")
EVIDENCE = pathlib.Path(r"C:\maos\review-packets\baseten-reasoning-budget-2026-10-30\fresh-bootstrap-2cfdf9b-2026-10-30")
BUILD_HOME = pathlib.Path(r"C:\Users\AMITAKSHYA SUTAR\AppData\Local\Temp\maos-baseten-budget-2cfdf9b-build-home-retry3")
script = EVIDENCE / "diagnose-bundle-lockcheck-retry3.ps1"
package = WORKTREE / "package.json"
lock = WORKTREE / "package-lock.json"
pwsh = shutil.which("pwsh.exe", path=os.environ.get("PATH"))
if not pwsh:
    raise SystemExit("pwsh.exe unavailable")

env = {key: os.environ[key] for key in ("PATH", "SYSTEMROOT") if key in os.environ}
env.update({
    "OS": "Windows_NT",
    "WINDIR": r"C:\Windows",
    "COMSPEC": r"C:\Windows\System32\cmd.exe",
    "TEMP": str(BUILD_HOME / "temp"),
    "TMP": str(BUILD_HOME / "temp"),
    "USERPROFILE": str(BUILD_HOME),
    "HOME": str(BUILD_HOME),
    "APPDATA": str(BUILD_HOME / "appdata"),
    "LOCALAPPDATA": str(BUILD_HOME / "localappdata"),
    "NPM_CONFIG_USERCONFIG": str(BUILD_HOME / "user.npmrc"),
    "NPM_CONFIG_GLOBALCONFIG": str(BUILD_HOME / "global.npmrc"),
    "NPM_CONFIG_CACHE": str(BUILD_HOME / "cache"),
    "NPM_CONFIG_REGISTRY": "https://registry.npmjs.org/",
    "NPM_CONFIG_AUDIT": "false",
    "NPM_CONFIG_FUND": "false",
    "HUSKY": "0",
})
command = [pwsh, "-NoProfile", "-NonInteractive", "-File", str(script), "-PackagePath", str(package), "-LockPath", str(lock)]
(EVIDENCE / "retry3-lockcheck-cwd.command.txt").write_text(" ".join(command) + "\n", encoding="utf-8")
result = subprocess.run(command, cwd=WORKTREE, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
(EVIDENCE / "retry3-lockcheck-cwd.stdout.txt").write_bytes(result.stdout)
(EVIDENCE / "retry3-lockcheck-cwd.stderr.txt").write_bytes(result.stderr)
(EVIDENCE / "retry3-lockcheck-cwd.exit-code.txt").write_text(f"{result.returncode}\n", encoding="ascii")
print(f"exit={result.returncode}")
print(result.stdout.decode("utf-8", "replace"))
print(result.stderr.decode("utf-8", "replace"))
