from __future__ import annotations

import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import zipfile

WORKTREE = pathlib.Path(r"C:\Users\AMITAKSHYA SUTAR\AppData\Local\Temp\maos-baseten-budget-2cfdf9b-retry3-checkout")
EVIDENCE = pathlib.Path(r"C:\maos\review-packets\baseten-reasoning-budget-2026-10-30\fresh-bootstrap-2cfdf9b-2026-10-30")
BUILD_HOME = pathlib.Path(r"C:\Users\AMITAKSHYA SUTAR\AppData\Local\Temp\maos-baseten-budget-2cfdf9b-build-home-retry3")
COMMIT = "2cfdf9b81f56eada7df2041625da18e44531151e"
OUT = WORKTREE / "out-retry3"
ARCHIVE = OUT / "maosorch-0.3.0.tgz"
BUNDLE = OUT / "maos-industrial-windows-x64-commit-2cfdf9b-2026-10-30-native-tar.zip"
DIAGNOSTIC = EVIDENCE / "diagnose-bundle-lockcheck-retry3.ps1"
BUILDER = WORKTREE / "scripts" / "New-MaosIndustrialInstallBundle.ps1"

if not os.environ.get("PATHEXT"):
    raise SystemExit("PATHEXT is unavailable; refusing native command invocation")
if BUNDLE.exists():
    raise SystemExit(f"refusing to overwrite bundle: {BUNDLE}")

path_entries = [r"C:\Windows\System32"]
path_entries.extend(os.environ["PATH"].split(os.pathsep))
env = {key: os.environ[key] for key in ("PATH", "SYSTEMROOT", "PATHEXT") if key in os.environ}
env["PATH"] = os.pathsep.join(path_entries)
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
pwsh = shutil.which("pwsh.exe", path=env["PATH"])
resolved_tar = shutil.which("tar.exe", path=env["PATH"])
if not pwsh or pathlib.Path(resolved_tar or "").resolve() != pathlib.Path(r"C:\Windows\System32\tar.exe").resolve():
    raise SystemExit(f"expected PowerShell and Windows tar resolution, got pwsh={pwsh!r}, tar={resolved_tar!r}")
if not ARCHIVE.is_file():
    raise SystemExit(f"expected previously packed npm archive is absent: {ARCHIVE}")


def run(label: str, command: list[str]) -> subprocess.CompletedProcess[bytes]:
    (EVIDENCE / f"{label}.command.txt").write_text(" ".join(command) + "\n", encoding="utf-8")
    result = subprocess.run(command, cwd=WORKTREE, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    (EVIDENCE / f"{label}.stdout.txt").write_bytes(result.stdout)
    (EVIDENCE / f"{label}.stderr.txt").write_bytes(result.stderr)
    (EVIDENCE / f"{label}.exit-code.txt").write_text(f"{result.returncode}\n", encoding="ascii")
    print(f"{label}: exit={result.returncode}")
    print("stdout=" + result.stdout.decode("utf-8", "replace"))
    print("stderr=" + result.stderr.decode("utf-8", "replace"))
    return result

check = run("retry3-lockcheck-native-tar", [pwsh, "-NoProfile", "-NonInteractive", "-File", str(DIAGNOSTIC), "-PackagePath", str(WORKTREE / "package.json"), "-LockPath", str(WORKTREE / "package-lock.json")])
if check.returncode != 0 or b"MISMATCHES=[]" not in check.stdout or b"NATIVE_EXIT=0" not in check.stdout:
    raise SystemExit("PowerShell/Node lock check did not pass; builder not invoked")

commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=WORKTREE, stdout=subprocess.PIPE, check=True).stdout.decode().strip()
if commit != COMMIT:
    raise SystemExit(f"unexpected source commit: {commit}")
patch = subprocess.run(
    ["git", "diff", "--binary", "--full-index", "--no-ext-diff", "--unified=3", "HEAD^", "HEAD", "--", "src/backends/openai-provider.ts", "tests/backends/baseten-api-provider-boundary.test.ts", "tests/backends/openai-provider-local-tool-call.test.ts", "tests/industrial/meta-model-api-contract.test.ts"],
    cwd=WORKTREE,
    stdout=subprocess.PIPE,
    check=True,
).stdout
delta_sha = hashlib.sha256(patch).hexdigest()
builder_command = [pwsh, "-NoProfile", "-NonInteractive", "-File", str(BUILDER), "-PackageArchive", str(ARCHIVE), "-SourceRevision", COMMIT, "-SourceDeltaSha256", delta_sha, "-OutputBundle", str(BUNDLE)]
built = run("retry3-build-bootstrap-zip-native-tar", builder_command)
if built.returncode != 0:
    raise SystemExit(built.returncode)

with zipfile.ZipFile(BUNDLE) as archive:
    names = archive.namelist()
    manifest = json.loads(archive.read("bundle-manifest.json"))
    if manifest.get("sourceRevision") != COMMIT or manifest.get("sourceDeltaSha256") != delta_sha:
        raise SystemExit("bundle manifest source identity mismatch")
    required = {"maosorch.tgz", "package-lock.json", "Install-MaosIndustrial.ps1"}
    if not required.issubset(set(names)):
        raise SystemExit(f"bundle missing required payloads: {sorted(required - set(names))}")
    (EVIDENCE / "retry3-native-tar-bundle-manifest.json").write_bytes(archive.read("bundle-manifest.json"))

package_copy = EVIDENCE / "retry3-native-tar-maosorch-0.3.0.tgz"
bundle_copy = EVIDENCE / "retry3-native-tar-maos-industrial-windows-x64.zip"
if package_copy.exists() or bundle_copy.exists():
    raise SystemExit("refusing to overwrite retained evidence copies")
shutil.copyfile(ARCHIVE, package_copy)
shutil.copyfile(BUNDLE, bundle_copy)
identity = {
    "commit": COMMIT,
    "sourceDeltaSha256": delta_sha,
    "package": {"path": package_copy.name, "bytes": package_copy.stat().st_size, "sha256": hashlib.sha256(package_copy.read_bytes()).hexdigest()},
    "bundle": {"path": bundle_copy.name, "bytes": bundle_copy.stat().st_size, "sha256": hashlib.sha256(bundle_copy.read_bytes()).hexdigest()},
    "bundleManifest": manifest,
    "bundleMembers": sorted(names),
    "buildContext": {"path": str(WORKTREE), "runtime": "PowerShell 7", "PATHEXTProvided": True, "tarExecutable": resolved_tar, "PATHPrefixedSystem32": True},
}
(EVIDENCE / "retry3-native-tar-bundle-identity.json").write_text(json.dumps(identity, indent=2) + "\n", encoding="utf-8")
print("identity=" + json.dumps(identity, sort_keys=True))
