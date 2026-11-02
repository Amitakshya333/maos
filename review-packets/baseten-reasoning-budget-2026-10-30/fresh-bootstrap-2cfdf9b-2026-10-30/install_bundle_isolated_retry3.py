from __future__ import annotations

import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import zipfile
from pathlib import PurePosixPath

EVIDENCE = pathlib.Path(r"C:\maos\review-packets\baseten-reasoning-budget-2026-10-30\fresh-bootstrap-2cfdf9b-2026-10-30")
BUNDLE = EVIDENCE / "retry3-native-tar-maos-industrial-windows-x64.zip"
EXPECTED_BUNDLE_SHA256 = "797b3f89d94b37f9ddb765e413679d4ae8335aad18e5feac2d8d481a65cd1c59"
TEMP = pathlib.Path(r"C:\Users\AMITAKSHYA SUTAR\AppData\Local\Temp")
BUNDLE_ROOT = TEMP / "MAOS bundle 2cfdf9b retry3"
INSTALL_ROOT = TEMP / "MAOS installed mock 2cfdf9b retry3"
INSTALL_HOME = TEMP / "MAOS install home 2cfdf9b retry3"

for destination in (BUNDLE_ROOT, INSTALL_ROOT, INSTALL_HOME):
    if destination.exists():
        raise SystemExit(f"refusing to reuse existing path: {destination}")
if not BUNDLE.is_file():
    raise SystemExit(f"bundle is missing: {BUNDLE}")
bundle_bytes = BUNDLE.read_bytes()
bundle_sha256 = hashlib.sha256(bundle_bytes).hexdigest()
if bundle_sha256 != EXPECTED_BUNDLE_SHA256:
    raise SystemExit(f"bundle hash mismatch: {bundle_sha256}")

with zipfile.ZipFile(BUNDLE) as archive:
    members = archive.namelist()
    for member in members:
        pure = PurePosixPath(member)
        if pure.is_absolute() or ".." in pure.parts or "\\" in member:
            raise SystemExit(f"unsafe ZIP member: {member}")
    required = {"Install-MaosIndustrial.ps1", "bundle-manifest.json", "maosorch.tgz", "package-lock.json"}
    if set(members) != required:
        raise SystemExit(f"unexpected bundle members: {sorted(members)}")
    manifest = json.loads(archive.read("bundle-manifest.json"))
    if manifest.get("sourceRevision") != "2cfdf9b81f56eada7df2041625da18e44531151e":
        raise SystemExit("bundle source commit mismatch")
    if manifest.get("sourceDeltaSha256") != "c916ddc30baf3b35c80fbe099fb97ee568431a6bc663cf612e3114f2f8f5bac1":
        raise SystemExit("bundle source delta mismatch")
    BUNDLE_ROOT.mkdir(parents=False, exist_ok=False)
    archive.extractall(BUNDLE_ROOT)

for subdir in ("temp", "cache", "appdata", "localappdata"):
    (INSTALL_HOME / subdir).mkdir(parents=True, exist_ok=False)
user_config = INSTALL_HOME / "user.npmrc"
global_config = INSTALL_HOME / "global.npmrc"
config_text = "registry=https://registry.npmjs.org/\naudit=false\nfund=false\n"
user_config.write_text(config_text, encoding="utf-8")
global_config.write_text(config_text, encoding="utf-8")

if not os.environ.get("PATHEXT"):
    raise SystemExit("PATHEXT is unavailable; refusing native installer execution")
path_entries = [r"C:\Windows\System32"]
path_entries.extend(os.environ.get("PATH", "").split(os.pathsep))
env = {key: os.environ[key] for key in ("PATH", "SYSTEMROOT", "PATHEXT") if key in os.environ}
env["PATH"] = os.pathsep.join(path_entries)
env.update({
    "OS": "Windows_NT",
    "WINDIR": r"C:\Windows",
    "COMSPEC": r"C:\Windows\System32\cmd.exe",
    "TEMP": str(INSTALL_HOME / "temp"),
    "TMP": str(INSTALL_HOME / "temp"),
    "USERPROFILE": str(INSTALL_HOME),
    "HOME": str(INSTALL_HOME),
    "APPDATA": str(INSTALL_HOME / "appdata"),
    "LOCALAPPDATA": str(INSTALL_HOME / "localappdata"),
    "NPM_CONFIG_USERCONFIG": str(user_config),
    "NPM_CONFIG_GLOBALCONFIG": str(global_config),
    "NPM_CONFIG_CACHE": str(INSTALL_HOME / "cache"),
    "NPM_CONFIG_REGISTRY": "https://registry.npmjs.org/",
    "NPM_CONFIG_AUDIT": "false",
    "NPM_CONFIG_FUND": "false",
    "HUSKY": "0",
})
pwsh = shutil.which("pwsh.exe", path=env["PATH"])
node = shutil.which("node.exe", path=env["PATH"])
npm = shutil.which("npm.cmd", path=env["PATH"])
tar = shutil.which("tar.exe", path=env["PATH"])
if not all((pwsh, node, npm, tar)):
    raise SystemExit(f"required commands unavailable: pwsh={pwsh!r}, node={node!r}, npm={npm!r}, tar={tar!r}")
if pathlib.Path(tar).resolve() != pathlib.Path(r"C:\Windows\System32\tar.exe").resolve():
    raise SystemExit(f"expected Windows tar.exe first on PATH, found {tar}")
command = [pwsh, "-NoProfile", "-NonInteractive", "-File", str(BUNDLE_ROOT / "Install-MaosIndustrial.ps1"), "-BundleRoot", str(BUNDLE_ROOT), "-InstallRoot", str(INSTALL_ROOT)]
(EVIDENCE / "retry3-install.command.txt").write_text(" ".join(command) + "\n", encoding="utf-8")
(EVIDENCE / "retry3-install-context.json").write_text(json.dumps({
    "bundle": str(BUNDLE), "bundleSha256": bundle_sha256,
    "bundleRoot": str(BUNDLE_ROOT), "installRoot": str(INSTALL_ROOT), "isolatedNpmCache": str(INSTALL_HOME / "cache"),
    "node": node, "npm": npm, "tar": tar, "pwsh": pwsh, "registry": "https://registry.npmjs.org/",
    "hostedProviderCredentialsInherited": False,
}, indent=2) + "\n", encoding="utf-8")
result = subprocess.run(command, cwd=BUNDLE_ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=1_200)
(EVIDENCE / "retry3-install.stdout.txt").write_bytes(result.stdout)
(EVIDENCE / "retry3-install.stderr.txt").write_bytes(result.stderr)
(EVIDENCE / "retry3-install.exit-code.txt").write_text(f"{result.returncode}\n", encoding="ascii")
print(f"install_exit={result.returncode}")
print(result.stdout.decode("utf-8", "replace"))
print(result.stderr.decode("utf-8", "replace"))
if result.returncode != 0:
    raise SystemExit(result.returncode)

app_root = INSTALL_ROOT / "app"
installed_package = json.loads((app_root / "package.json").read_text(encoding="utf-8"))
manifest_lock_hash = hashlib.sha256((app_root / "package-lock.json").read_bytes()).hexdigest()
checks = {
    "packageName": installed_package.get("name"),
    "packageVersion": installed_package.get("version"),
    "applicationLockSha256": manifest_lock_hash,
    "applicationLockMatchesManifest": manifest_lock_hash == manifest["applicationLock"]["sha256"],
    "providerBundleExists": (app_root / "dist" / "backends" / "openai-provider.js").is_file(),
    "serviceContainerBundleExists": (app_root / "dist" / "service" / "index.js").is_file(),
    "electronExeExists": (app_root / "desktop" / "node_modules" / "electron" / "dist" / "electron.exe").is_file(),
    "bundleSha256": bundle_sha256,
    "sourceRevision": manifest["sourceRevision"],
    "sourceDeltaSha256": manifest["sourceDeltaSha256"],
}
(EVIDENCE / "retry3-install-verification.json").write_text(json.dumps(checks, indent=2) + "\n", encoding="utf-8")
print("install_verification=" + json.dumps(checks, sort_keys=True))
if not all((checks["applicationLockMatchesManifest"], checks["providerBundleExists"], checks["serviceContainerBundleExists"], checks["electronExeExists"])):
    raise SystemExit("installed product verification failed")
