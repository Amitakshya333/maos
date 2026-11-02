from __future__ import annotations

import hashlib
import json
import pathlib
import subprocess
import tarfile
import zipfile

REPO = pathlib.Path(r"C:\maos")
EVIDENCE = REPO / "review-packets" / "baseten-reasoning-budget-2026-10-30" / "fresh-bootstrap-2cfdf9b-2026-10-30"
SOURCE_MANIFEST_PATH = REPO / "review-packets" / "baseten-reasoning-budget-2026-10-30" / "source-hashes.json"
BUNDLE = EVIDENCE / "retry3-native-tar-maos-industrial-windows-x64.zip"
PACKAGE = EVIDENCE / "retry3-native-tar-maosorch-0.3.0.tgz"
DELTA = EVIDENCE / "source-delta-4-paths-retry3.patch"
INSTALL_ROOT = pathlib.Path(r"C:\Users\AMITAKSHYA SUTAR\AppData\Local\Temp\MAOS installed mock 2cfdf9b retry3")
EXPECTED_COMMIT = "2cfdf9b81f56eada7df2041625da18e44531151e"
EXPECTED_PARENT = "f201cfe38bf3a741b5d8c6b37793cc3c112c43a9"
EXPECTED_BUNDLE_SHA256 = "797b3f89d94b37f9ddb765e413679d4ae8335aad18e5feac2d8d481a65cd1c59"


def git(*args: str) -> str:
    result = subprocess.run(["git", "--no-pager", *args], cwd=REPO, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
    return result.stdout.decode("utf-8", "replace").strip()


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

root = git("rev-parse", "--show-toplevel").replace("/", "\\")
branch = git("branch", "--show-current")
head = git("rev-parse", "HEAD")
parent = git("rev-parse", "HEAD^")
index_paths = git("diff", "--cached", "--name-only")
commit_paths = git("diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD").splitlines()
expected_paths = [
    "src/backends/openai-provider.ts",
    "tests/backends/baseten-api-provider-boundary.test.ts",
    "tests/backends/openai-provider-local-tool-call.test.ts",
    "tests/industrial/meta-model-api-contract.test.ts",
]
if root.lower() != str(REPO).lower() or branch != "main" or head != EXPECTED_COMMIT or parent != EXPECTED_PARENT:
    raise SystemExit(f"repository identity mismatch: root={root}, branch={branch}, HEAD={head}, parent={parent}")
if index_paths or sorted(commit_paths) != sorted(expected_paths):
    raise SystemExit(f"commit/index scope mismatch: staged={index_paths!r}, commit_paths={commit_paths!r}")

manifest = json.loads(SOURCE_MANIFEST_PATH.read_text(encoding="utf-8"))
source_results = []
for item in manifest["files"]:
    if item["path"] not in expected_paths:
        continue
    raw = subprocess.run(["git", "show", f"HEAD:{item['path']}"], cwd=REPO, stdout=subprocess.PIPE, check=True).stdout
    lf = raw.replace(b"\r\n", b"\n")
    raw_sha = sha256(raw)
    lf_sha = sha256(lf)
    if raw_sha != item["rawSha256"] or lf_sha != item["lfSha256"]:
        raise SystemExit(f"committed source hash mismatch for {item['path']}")
    source_results.append({"path": item["path"], "rawSha256": raw_sha, "lfSha256": lf_sha, "bytes": len(raw)})
if len(source_results) != 4:
    raise SystemExit(f"manifest did not verify all four source paths: {len(source_results)}")

bundle_bytes = BUNDLE.read_bytes()
bundle_sha = sha256(bundle_bytes)
if bundle_sha != EXPECTED_BUNDLE_SHA256:
    raise SystemExit(f"bundle hash mismatch: {bundle_sha}")
package_sha = sha256(PACKAGE.read_bytes())
delta_sha = sha256(DELTA.read_bytes())
with zipfile.ZipFile(BUNDLE) as archive:
    members = sorted(archive.namelist())
    bundle_manifest = json.loads(archive.read("bundle-manifest.json"))
    if bundle_manifest["sourceRevision"] != EXPECTED_COMMIT or bundle_manifest["sourceDeltaSha256"] != delta_sha:
        raise SystemExit("bundle source identity mismatch")
    if bundle_manifest["package"]["sha256"] != package_sha:
        raise SystemExit("bundle package hash mismatch")
    if "maos-engine.exe" in members or any("maos-engine" in member for member in members):
        raise SystemExit("external Rust engine unexpectedly entered the bundle")

app = INSTALL_ROOT / "app"
installed_lock_sha = sha256((app / "package-lock.json").read_bytes())
if installed_lock_sha != bundle_manifest["applicationLock"]["sha256"]:
    raise SystemExit("installed application lockfile hash differs from bundle manifest")
with tarfile.open(PACKAGE, "r:gz") as package_tar:
    members_to_check = [
        ("package/dist/backends/openai-provider.js", app / "dist" / "backends" / "openai-provider.js"),
        ("package/dist/service/index.js", app / "dist" / "service" / "index.js"),
    ]
    installed_module_hashes = []
    for member, installed in members_to_check:
        source = package_tar.extractfile(member)
        if source is None:
            raise SystemExit(f"package tarball is missing {member}")
        package_member_sha = sha256(source.read())
        installed_sha = sha256(installed.read_bytes())
        if package_member_sha != installed_sha:
            raise SystemExit(f"installed module differs from package member: {member}")
        installed_module_hashes.append({"member": member, "sha256": installed_sha})

install_exit = (EVIDENCE / "retry3-install.exit-code.txt").read_text(encoding="ascii").strip()
smoke_exit = (EVIDENCE / "retry3-installed-smoke-final.exit-code.txt").read_text(encoding="ascii").strip()
smoke = json.loads((EVIDENCE / "retry3-installed-smoke-final-summary.json").read_text(encoding="utf-8"))
if install_exit != "0" or smoke_exit != "0" or not smoke.get("passed") or len(smoke.get("cases", [])) != 7:
    raise SystemExit("install or final installed smoke evidence did not pass")

status_names = git("status", "--short")
verification = {
    "repositoryRoot": root,
    "branch": branch,
    "head": head,
    "parent": parent,
    "stagedPaths": [],
    "committedPaths": sorted(commit_paths),
    "sourceManifestPath": str(SOURCE_MANIFEST_PATH.relative_to(REPO)).replace("\\", "/"),
    "sourceManifestSha256": sha256(SOURCE_MANIFEST_PATH.read_bytes()),
    "sourceHashes": source_results,
    "sourceDeltaSha256": delta_sha,
    "package": {"path": PACKAGE.name, "bytes": PACKAGE.stat().st_size, "sha256": package_sha},
    "bundle": {"path": BUNDLE.name, "bytes": BUNDLE.stat().st_size, "sha256": bundle_sha, "members": members, "manifest": bundle_manifest},
    "installExit": int(install_exit),
    "installedLockSha256": installed_lock_sha,
    "installedModules": installed_module_hashes,
    "installedSmokeExit": int(smoke_exit),
    "installedSmokeCases": smoke["cases"],
    "unrelatedWorkingTreeStatusNamesOnly": status_names.splitlines(),
    "indexEmpty": True,
}
(EVIDENCE / "final-checkpoint-bundle-smoke-verification.json").write_text(json.dumps(verification, indent=2) + "\n", encoding="utf-8")
print(json.dumps({
    "root": root, "branch": branch, "HEAD": head, "parent": parent,
    "commitPaths": sorted(commit_paths), "indexEmpty": True,
    "bundleBytes": BUNDLE.stat().st_size, "bundleSha256": bundle_sha,
    "packageBytes": PACKAGE.stat().st_size, "packageSha256": package_sha,
    "installExit": int(install_exit), "installedSmokeExit": int(smoke_exit),
    "smokeCases": len(smoke["cases"]), "allSmokePassed": all(case["passed"] for case in smoke["cases"]),
}, sort_keys=True))
