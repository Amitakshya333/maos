from __future__ import annotations

import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
import zipfile

WORKTREE = pathlib.Path(r"C:\Users\AMITAKSHYA SUTAR\AppData\Local\Temp\maos-baseten-budget-2cfdf9b-checkout")
EVIDENCE = pathlib.Path(r"C:\maos\review-packets\baseten-reasoning-budget-2026-10-30\fresh-bootstrap-2cfdf9b-2026-10-30")
BUILD_HOME = pathlib.Path(r"C:\Users\AMITAKSHYA SUTAR\AppData\Local\Temp\maos-baseten-budget-2cfdf9b-build-home-retry2")
EXPECTED_COMMIT = "2cfdf9b81f56eada7df2041625da18e44531151e"
SCOPED_PATHS = [
    "src/backends/openai-provider.ts",
    "tests/backends/baseten-api-provider-boundary.test.ts",
    "tests/backends/openai-provider-local-tool-call.test.ts",
    "tests/industrial/meta-model-api-contract.test.ts",
]


def run(label: str, command: list[str], env: dict[str, str]) -> subprocess.CompletedProcess[bytes]:
    (EVIDENCE / f"{label}.command.txt").write_text(" ".join(command) + "\n", encoding="utf-8")
    result = subprocess.run(command, cwd=WORKTREE, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    (EVIDENCE / f"{label}.stdout.txt").write_bytes(result.stdout)
    (EVIDENCE / f"{label}.stderr.txt").write_bytes(result.stderr)
    (EVIDENCE / f"{label}.exit-code.txt").write_text(f"{result.returncode}\n", encoding="ascii")
    print(f"{label}: exit={result.returncode}")
    if result.stdout:
        print(result.stdout.decode("utf-8", "replace")[-2500:])
    if result.stderr:
        print(result.stderr.decode("utf-8", "replace")[-2500:], file=sys.stderr)
    if result.returncode != 0:
        raise SystemExit(result.returncode)
    return result


commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=WORKTREE, stdout=subprocess.PIPE, check=True).stdout.decode().strip()
parent = subprocess.run(["git", "rev-parse", "HEAD^"], cwd=WORKTREE, stdout=subprocess.PIPE, check=True).stdout.decode().strip()
if commit != EXPECTED_COMMIT:
    raise SystemExit(f"unexpected isolated checkout HEAD: {commit}")

out = WORKTREE / "out-retry2"
out.mkdir(exist_ok=False)
patch = subprocess.run(
    ["git", "diff", "--binary", "--full-index", "--no-ext-diff", "--unified=3", "HEAD^", "HEAD", "--", *SCOPED_PATHS],
    cwd=WORKTREE,
    stdout=subprocess.PIPE,
    check=True,
).stdout
(EVIDENCE / "source-delta-4-paths-retry2.patch").write_bytes(patch)
delta_sha = hashlib.sha256(patch).hexdigest()

if BUILD_HOME.exists():
    raise SystemExit(f"refusing to reuse an existing isolated build home: {BUILD_HOME}")
for subdir in ("temp", "cache", "appdata", "localappdata"):
    (BUILD_HOME / subdir).mkdir(parents=True, exist_ok=False)
user_config = BUILD_HOME / "user.npmrc"
global_config = BUILD_HOME / "global.npmrc"
config_text = "registry=https://registry.npmjs.org/\naudit=false\nfund=false\n"
user_config.write_text(config_text, encoding="utf-8")
global_config.write_text(config_text, encoding="utf-8")

base_env = {key: os.environ[key] for key in ("PATH", "SYSTEMROOT") if key in os.environ}
base_env.update({
    "OS": "Windows_NT",
    "WINDIR": r"C:\Windows",
    "COMSPEC": r"C:\Windows\System32\cmd.exe",
    "TEMP": str(BUILD_HOME / "temp"),
    "TMP": str(BUILD_HOME / "temp"),
    "USERPROFILE": str(BUILD_HOME),
    "HOME": str(BUILD_HOME),
    "APPDATA": str(BUILD_HOME / "appdata"),
    "LOCALAPPDATA": str(BUILD_HOME / "localappdata"),
    "NPM_CONFIG_USERCONFIG": str(user_config),
    "NPM_CONFIG_GLOBALCONFIG": str(global_config),
    "NPM_CONFIG_CACHE": str(BUILD_HOME / "cache"),
    "NPM_CONFIG_REGISTRY": "https://registry.npmjs.org/",
    "NPM_CONFIG_AUDIT": "false",
    "NPM_CONFIG_FUND": "false",
    "HUSKY": "0",
})

node = shutil.which("node.exe", path=base_env.get("PATH"))
npm = shutil.which("npm.cmd", path=base_env.get("PATH"))
pwsh = shutil.which("pwsh.exe", path=base_env.get("PATH"))
cmd = shutil.which("cmd.exe", path=base_env.get("PATH")) or r"C:\Windows\System32\cmd.exe"
if not node or not npm or not pwsh:
    raise SystemExit("node.exe, npm.cmd, or pwsh.exe is unavailable on PATH")

for label, command in (
    ("retry2-build-node-version", [node, "--version"]),
    ("retry2-build-npm-version", [cmd, "/d", "/s", "/c", "npm.cmd --version"]),
):
    run(label, command, base_env)

run("retry2-build-npm-ci", [cmd, "/d", "/s", "/c", "npm.cmd ci --no-audit --no-fund"], base_env)
run("retry2-build-production", [cmd, "/d", "/s", "/c", "npm.cmd run build"], base_env)
run("retry2-build-npm-pack", [cmd, "/d", "/s", "/c", "npm.cmd pack --ignore-scripts --pack-destination out-retry2"], base_env)

archives = list(out.glob("*.tgz"))
if len(archives) != 1:
    raise SystemExit(f"expected one npm tarball in out, found {len(archives)}")
package_archive = archives[0]
package_json = json.loads((WORKTREE / "package.json").read_text(encoding="utf-8"))
bundle = out / "maos-industrial-windows-x64-commit-2cfdf9b-2026-10-30-retry2.zip"
if bundle.exists():
    raise SystemExit(f"refusing to overwrite bundle: {bundle}")

bundle_command = [
    pwsh,
    "-NoProfile",
    "-NonInteractive",
    "-File",
    str(WORKTREE / "scripts" / "New-MaosIndustrialInstallBundle.ps1"),
    "-PackageArchive",
    str(package_archive),
    "-SourceRevision",
    commit,
    "-SourceDeltaSha256",
    delta_sha,
    "-OutputBundle",
    str(bundle),
]
run("retry2-build-bootstrap-zip", bundle_command, base_env)

for produced in (package_archive, bundle):
    destination = EVIDENCE / produced.name
    if destination.exists():
        raise SystemExit(f"refusing to overwrite retained evidence: {destination}")
    shutil.copyfile(produced, destination)

with zipfile.ZipFile(bundle) as archive:
    names = archive.namelist()
    manifest = json.loads(archive.read("bundle-manifest.json"))
    if manifest.get("sourceRevision") != commit or manifest.get("sourceDeltaSha256") != delta_sha:
        raise SystemExit("bundle manifest source identity mismatch")
    if "maosorch.tgz" not in names or "package-lock.json" not in names or "Install-MaosIndustrial.ps1" not in names:
        raise SystemExit("bundle missing a required bootstrap payload")
    (EVIDENCE / "bundle-manifest.json").write_bytes(archive.read("bundle-manifest.json"))

package_copy = EVIDENCE / package_archive.name
bundle_copy = EVIDENCE / bundle.name
identity = {
    "commit": commit,
    "parent": parent,
    "sourceDeltaSha256": delta_sha,
    "sourceDeltaPath": "source-delta-4-paths-retry2.patch",
    "package": {
        "path": package_copy.name,
        "bytes": package_copy.stat().st_size,
        "sha256": hashlib.sha256(package_copy.read_bytes()).hexdigest(),
        "version": package_json["version"],
    },
    "bundle": {
        "path": bundle_copy.name,
        "bytes": bundle_copy.stat().st_size,
        "sha256": hashlib.sha256(bundle_copy.read_bytes()).hexdigest(),
    },
    "bundleManifest": manifest,
    "bundleMembers": sorted(names),
}
(EVIDENCE / "bundle-identity.json").write_text(json.dumps(identity, indent=2) + "\n", encoding="utf-8")
print("bundle-identity=" + json.dumps({"commit": commit, "sourceDeltaSha256": delta_sha, "packageSha256": identity["package"]["sha256"], "bundleSha256": identity["bundle"]["sha256"]}, sort_keys=True))
