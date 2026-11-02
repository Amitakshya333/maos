import difflib, hashlib, json, pathlib, subprocess, sys

repo = pathlib.Path(sys.argv[1])
old = pathlib.Path(sys.argv[2])
packet = pathlib.Path(sys.argv[3])
base = 'bb871cb191184b5de1b790d42fc452a29f8f072e'
main_repo = pathlib.Path(r'C:\maos')
old_packet = main_repo / 'review-packets' / 'baseten-pilot-correction-close-2026-10-29'
paths = [
    'scripts/Start-BasetenSyntheticPilot.ps1',
    'scripts/Windows-ProcessTree.ps1',
    'tests/industrial/baseten-pilot-process-tree.test.ts',
    'tests/industrial/meta-model-api-contract.test.ts',
]

def run(args, cwd=None, check=True):
    result = subprocess.run(args, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if check and result.returncode:
        raise RuntimeError(f'{args!r} failed ({result.returncode}): {result.stderr.decode(errors="replace")}')
    return result

def sha(data):
    return hashlib.sha256(data).hexdigest()

def lf(data):
    return data.replace(b'\r\n', b'\n').replace(b'\r', b'\n')

def git(args, cwd=repo):
    return run(['git', *args], cwd=cwd).stdout.decode().strip()

def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n', encoding='utf-8', newline='\n')

packet.mkdir(parents=True, exist_ok=True)
(packet / 'validation').mkdir(exist_ok=True)
head = git(['rev-parse', 'HEAD'])
branch = git(['branch', '--show-current'])
index = run(['git', 'diff', '--cached', '--quiet'], cwd=repo, check=False)
main_head = git(['rev-parse', 'HEAD'], cwd=main_repo)
main_branch = git(['branch', '--show-current'], cwd=main_repo)
main_index = run(['git', 'diff', '--cached', '--quiet'], cwd=main_repo, check=False)
if head != base or branch or index.returncode != 0:
    raise RuntimeError('Candidate identity or index changed before packet generation.')
if main_head != base or main_branch != 'main' or main_index.returncode != 0:
    raise RuntimeError('Main checkout identity or index changed before packet generation.')
tracked = git(['diff', '--name-only', base], cwd=repo).splitlines()
if tracked != sorted(paths):
    raise RuntimeError(f'Unexpected tracked source scope: {tracked!r}')

old_patch = (old_packet / 'complete-correction.patch').read_bytes()
old_manifest_bytes = (old_packet / 'source-hashes.json').read_bytes()
old_manifest = json.loads(old_manifest_bytes)
if sha(old_patch) != 'dbb62ab351b474cd158071b34f47be173f890cb869391b6befa0e9ddb45b8ad1':
    raise RuntimeError('The prior rejected four-file patch hash changed.')
if sha(old_manifest_bytes) != '2f089126d37461c4bcb60633bfd35f3845a2b3274d99567c28984a147af64a92':
    raise RuntimeError('The prior rejected four-file manifest hash changed.')
old_by_path = {entry['path']: entry for entry in old_manifest['files']}
if set(old_by_path) != set(paths):
    raise RuntimeError('Prior rejected snapshot manifest scope is not exactly four files.')

snapshot_rows = []
current_rows = []
delta_rows = []
for name in paths:
    prior = (old / name).read_bytes()
    current = (repo / name).read_bytes()
    prior_lf, current_lf = lf(prior), lf(current)
    old_entry = old_by_path[name]
    if sha(prior_lf) != old_entry['lfNormalizedSha256']:
        raise RuntimeError(f'Prior four-file snapshot does not match its retained LF manifest: {name}')
    snapshot_rows.append({
        'path': name,
        'retainedManifestRawSha256': old_entry['rawSha256'],
        'reconstructionRawSha256': sha(prior),
        'retainedManifestLfNormalizedSha256': old_entry['lfNormalizedSha256'],
        'reconstructionLfNormalizedSha256': sha(prior_lf),
        'rawEqualToRetainedManifest': sha(prior) == old_entry['rawSha256'],
        'lfNormalizedEqualToRetainedManifest': sha(prior_lf) == old_entry['lfNormalizedSha256'],
    })
    base_blob = git(['rev-parse', f'{base}:{name}'])
    current_rows.append({
        'path': name,
        'status': 'modified',
        'baseGitBlob': base_blob,
        'rawSha256': sha(current),
        'lfNormalizedSha256': sha(current_lf),
        'rawBytes': len(current),
    })
    if prior_lf != current_lf:
        delta_rows.append({
            'path': name,
            'priorSnapshotRawSha256': sha(prior),
            'priorSnapshotLfNormalizedSha256': sha(prior_lf),
            'currentRawSha256': sha(current),
            'currentLfNormalizedSha256': sha(current_lf),
        })
if [row['path'] for row in delta_rows] != ['scripts/Windows-ProcessTree.ps1', 'tests/industrial/baseten-pilot-process-tree.test.ts']:
    raise RuntimeError(f'Unexpected delta from the rejected snapshot: {[x["path"] for x in delta_rows]!r}')

full_result = run(['git', 'diff', '--binary', '--full-index', base, '--', *paths], cwd=repo)
full_patch = lf(full_result.stdout)
full_patch_path = packet / 'complete-correction.patch'
full_patch_path.write_bytes(full_patch)
(packet / 'validation' / 'complete-patch-generation-stderr.txt').write_bytes(full_result.stderr)
full_patch_sha = sha(full_patch)
full_manifest = {
    'schemaVersion': 1,
    'candidate': 'Cancellation callback/disposal lifetime correction plus preserved four-file contract correction',
    'baseCommit': base,
    'candidateHead': head,
    'candidateBranch': 'detached',
    'patchFile': full_patch_path.name,
    'patchSha256': full_patch_sha,
    'hashConvention': 'sha256 fields are full lowercase SHA-256; lfNormalizedSha256 converts CRLF and lone CR to LF before hashing.',
    'files': current_rows,
}
write_json(packet / 'complete-source-hashes.json', full_manifest)

parts = []
for entry in delta_rows:
    name = entry['path']
    from_lines = lf((old / name).read_bytes()).decode('utf-8').splitlines(keepends=True)
    to_lines = lf((repo / name).read_bytes()).decode('utf-8').splitlines(keepends=True)
    parts.append(f'diff --git a/{name} b/{name}\n')
    parts.extend(difflib.unified_diff(from_lines, to_lines, fromfile=f'a/{name}', tofile=f'b/{name}', n=3, lineterm='\n'))
delta_patch = ''.join(parts).encode('utf-8')
delta_path = packet / 'lifetime-delta-from-rejected-four-file-snapshot.patch'
delta_path.write_bytes(delta_patch)
delta_manifest = {
    'schemaVersion': 1,
    'baseSnapshot': {
        'description': 'Exact previously rejected four-file snapshot, verified against retained manifest after LF normalization.',
        'baseCommit': base,
        'historicalPatchSha256': sha(old_patch),
        'historicalManifestSha256': sha(old_manifest_bytes),
    },
    'candidateHead': head,
    'patchFile': delta_path.name,
    'patchSha256': sha(delta_patch),
    'hashConvention': 'Full lowercase SHA-256; normalized hashes convert CRLF and lone CR to LF before hashing.',
    'files': delta_rows,
}
write_json(packet / 'delta-source-hashes.json', delta_manifest)

write_json(packet / 'prior-snapshot-verification.json', {
    'snapshotRoot': str(old),
    'retainedPriorPatchSha256': sha(old_patch),
    'retainedPriorManifestSha256': sha(old_manifest_bytes),
    'files': snapshot_rows,
    'result': 'All four reconstructed files match the retained source manifest after LF normalization; raw differences are newline-style only where recorded.'
})
write_json(packet / 'current-source-verification.json', {
    'candidateRoot': str(repo),
    'mainRoot': str(main_repo),
    'expectedBase': base,
    'candidate': {'head': head, 'branch': 'detached', 'indexEmpty': True, 'trackedDiffPaths': tracked},
    'main': {'head': main_head, 'branch': main_branch, 'indexEmpty': True, 'unrelatedWorkingTreeChangesPreserved': True},
    'sourceManifestSha256': sha((packet / 'complete-source-hashes.json').read_bytes()),
    'allTrackedCandidateChangesAccountedFor': tracked == sorted(paths),
})
print(json.dumps({
    'completePatchSha256': full_patch_sha,
    'completeManifestSha256': sha((packet / 'complete-source-hashes.json').read_bytes()),
    'completePatchBytes': len(full_patch),
    'deltaPatchSha256': sha(delta_patch),
    'deltaManifestSha256': sha((packet / 'delta-source-hashes.json').read_bytes()),
    'deltaFiles': [row['path'] for row in delta_rows],
    'trackedScope': tracked,
    'priorSnapshotLfReconstructionVerified': True,
    'candidateIndexEmpty': True,
    'mainIndexEmpty': True,
}, indent=2))