import hashlib, json, pathlib, shutil, subprocess, sys
repo=pathlib.Path(sys.argv[1]); old=pathlib.Path(sys.argv[2]); packet=pathlib.Path(sys.argv[3]); base='bb871cb191184b5de1b790d42fc452a29f8f072e'
paths=['scripts/Start-BasetenSyntheticPilot.ps1','scripts/Windows-ProcessTree.ps1','tests/industrial/baseten-pilot-process-tree.test.ts','tests/industrial/meta-model-api-contract.test.ts']
full_patch=packet/'complete-correction.patch'; delta_patch=packet/'lifetime-delta-from-rejected-four-file-snapshot.patch'
full_root=pathlib.Path(r'C:\Users\AMITAKSHYA SUTAR\AppData\Local\Temp\maos-bb871-complete-final-20261029-01')
delta_root=pathlib.Path(r'C:\Users\AMITAKSHYA SUTAR\AppData\Local\Temp\maos-rejected-four-file-delta-final-20261029-01')

def run(args,cwd=None,check=True):
    p=subprocess.run(args,cwd=cwd,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    if check and p.returncode: raise RuntimeError(f'{args!r} failed ({p.returncode}): {p.stderr.decode(errors="replace")}')
    return p

def sha(b): return hashlib.sha256(b).hexdigest()
def lf(b): return b.replace(b'\r\n',b'\n').replace(b'\r',b'\n')
def write_json(p,v): p.write_text(json.dumps(v,indent=2)+'\n',encoding='utf-8',newline='\n')
def init(root):
    if root.exists(): raise RuntimeError(f'Reconstruction path already exists; refusing to overwrite: {root}')
    root.mkdir(parents=True)
    run(['git','init','--quiet'],cwd=root)

def source_from_base(name): return run(['git','show',f'{base}:{name}'],cwd=repo).stdout

def apply_and_check(root,patch):
    check=run(['git','apply','--check',str(patch)],cwd=root,check=False)
    apply=run(['git','apply',str(patch)],cwd=root,check=False) if check.returncode==0 else None
    return check,apply

init(full_root)
for name in paths:
    p=full_root/name; p.parent.mkdir(parents=True,exist_ok=True); p.write_bytes(source_from_base(name))
full_check,full_apply=apply_and_check(full_root,full_patch)
if full_check.returncode or full_apply is None or full_apply.returncode: raise RuntimeError(f'Complete patch apply failed: check={full_check.returncode}; apply={None if full_apply is None else full_apply.returncode}; {full_check.stderr.decode(errors="replace")} {b"" if full_apply is None else full_apply.stderr}')
full_rows=[]
for name in paths:
    reconstructed=(full_root/name).read_bytes(); current=(repo/name).read_bytes()
    full_rows.append({'path':name,'rawEqual':reconstructed==current,'rawSha256':sha(reconstructed),'candidateRawSha256':sha(current),'lfNormalizedEqual':lf(reconstructed)==lf(current),'lfNormalizedSha256':sha(lf(reconstructed)),'candidateLfNormalizedSha256':sha(lf(current))})
if any(not row['lfNormalizedEqual'] for row in full_rows): raise RuntimeError('Complete reconstruction content mismatch.')
full_files=sorted(str(p.relative_to(full_root)).replace('\\','/') for p in full_root.rglob('*') if p.is_file() and '.git' not in p.parts)
if full_files != sorted(paths): raise RuntimeError(f'Complete reconstruction wrote out-of-scope files: {full_files!r}')
full_status=run(['git','status','--short'],cwd=full_root).stdout.decode()

init(delta_root)
for name in paths:
    prior=lf((old/name).read_bytes()); p=delta_root/name; p.parent.mkdir(parents=True,exist_ok=True); p.write_bytes(prior)
delta_check,delta_apply=apply_and_check(delta_root,delta_patch)
if delta_check.returncode or delta_apply is None or delta_apply.returncode: raise RuntimeError(f'Delta patch apply failed: check={delta_check.returncode}; apply={None if delta_apply is None else delta_apply.returncode}; {delta_check.stderr.decode(errors="replace")} {b"" if delta_apply is None else delta_apply.stderr}')
delta_rows=[]
for name in paths:
    reconstructed=(delta_root/name).read_bytes(); current=(repo/name).read_bytes()
    delta_rows.append({'path':name,'rawEqual':reconstructed==current,'rawSha256':sha(reconstructed),'candidateRawSha256':sha(current),'lfNormalizedEqual':lf(reconstructed)==lf(current),'lfNormalizedSha256':sha(lf(reconstructed)),'candidateLfNormalizedSha256':sha(lf(current))})
if any(not row['lfNormalizedEqual'] for row in delta_rows): raise RuntimeError('Delta reconstruction content mismatch.')
delta_files=sorted(str(p.relative_to(delta_root)).replace('\\','/') for p in delta_root.rglob('*') if p.is_file() and '.git' not in p.parts)
if delta_files != sorted(paths): raise RuntimeError(f'Delta reconstruction wrote out-of-scope files: {delta_files!r}')
delta_status=run(['git','status','--short'],cwd=delta_root).stdout.decode()

packet.mkdir(exist_ok=True,parents=True)
write_json(packet/'complete-reconstruction-verification.json',{'baseCommit':base,'patchFile':full_patch.name,'patchSha256':sha(full_patch.read_bytes()),'reconstructionRoot':str(full_root),'applyCheckExitCode':full_check.returncode,'applyExitCode':full_apply.returncode,'reconstructedPaths':full_files,'workingTreeStatusAfterApply':full_status,'files':full_rows,'rawByteEquality':all(r['rawEqual'] for r in full_rows),'lfNormalizedEquality':True,'result':'PASS; full scoped candidate reconstructed from exact base blobs; raw-byte differences are reported per file.'})
write_json(packet/'delta-reconstruction-verification.json',{'baseSnapshotRoot':str(old),'baseSnapshotBasis':'previous rejected four-file snapshot, copied after LF normalization against its retained manifest','patchFile':delta_patch.name,'patchSha256':sha(delta_patch.read_bytes()),'reconstructionRoot':str(delta_root),'applyCheckExitCode':delta_check.returncode,'applyExitCode':delta_apply.returncode,'reconstructedPaths':delta_files,'workingTreeStatusAfterApply':delta_status,'files':delta_rows,'rawByteEquality':all(r['rawEqual'] for r in delta_rows),'lfNormalizedEquality':True,'result':'PASS; exact two-file delta applies to the four-file prior snapshot and reconstructs all four current scoped files after LF normalization.'})
print(json.dumps({'complete':{'root':str(full_root),'checkExitCode':full_check.returncode,'applyExitCode':full_apply.returncode,'paths':full_files,'lfAllEqual':True,'rawEqualPaths':[r['path'] for r in full_rows if r['rawEqual']]},'delta':{'root':str(delta_root),'checkExitCode':delta_check.returncode,'applyExitCode':delta_apply.returncode,'paths':delta_files,'lfAllEqual':True,'rawEqualPaths':[r['path'] for r in delta_rows if r['rawEqual']] }},indent=2))