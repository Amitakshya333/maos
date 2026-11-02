import hashlib,json,pathlib,subprocess,sys
repo=pathlib.Path(r'C:\maos');packet=pathlib.Path(sys.argv[1]);paths=['scripts/Start-BasetenSyntheticPilot.ps1','scripts/Windows-ProcessTree.ps1','tests/industrial/baseten-pilot-process-tree.test.ts','tests/industrial/meta-model-api-contract.test.ts']
def run(args):
 p=subprocess.run(args,cwd=repo,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 return p
def sha(b):return hashlib.sha256(b).hexdigest()
def lf(b):return b.replace(b'\r\n',b'\n').replace(b'\r',b'\n')
manifest=json.loads((packet/'complete-source-hashes.json').read_bytes());expected={x['path']:x for x in manifest['files']}
staged=run(['git','diff','--cached','--name-only']);names=staged.stdout.decode().splitlines()
if staged.returncode or sorted(names)!=sorted(paths):raise RuntimeError(f'Staged paths mismatch: {names!r}')
rows=[]
for name in paths:
 blob=run(['git','show',f':{name}'])
 if blob.returncode:raise RuntimeError(f'Unable to read staged blob {name}: {blob.stderr!r}')
 actual=sha(blob.stdout); target=expected[name]['lfNormalizedSha256']
 if actual!=target:raise RuntimeError(f'Staged LF blob mismatch: {name}; {actual} != {target}')
 gitblob=run(['git','rev-parse',f':{name}']).stdout.decode().strip()
 rows.append({'path':name,'stagedGitBlob':gitblob,'stagedBlobSha256':actual,'reviewedLfSha256':target,'matches':True})
check=run(['git','diff','--cached','--check']);unstaged=run(['git','diff','--name-only','--',*paths]);patch=run(['git','diff','--cached','--binary','--full-index','bb871cb191184b5de1b790d42fc452a29f8f072e','--',*paths])
if check.returncode or unstaged.returncode or unstaged.stdout.strip() or patch.returncode:raise RuntimeError('Staged diff check or staged/unstaged state failed.')
patch_bytes=lf(patch.stdout);approved_bytes=lf((packet/'complete-correction.patch').read_bytes());(packet/'staged-review.patch').write_bytes(patch_bytes)
result={'repository':str(repo),'baseHead':'bb871cb191184b5de1b790d42fc452a29f8f072e','stagedPaths':names,'exactAllowlist':True,'files':rows,'stagedDiffCheckExitCode':check.returncode,'unstagedAllowlistedPaths':unstaged.stdout.decode().splitlines(),'stagedPatchSha256':sha(patch_bytes),'approvedPatchSha256':sha(approved_bytes),'stagedPatchLfEqualToApprovedPatch':patch_bytes==approved_bytes,'result':'PASS' if patch_bytes==approved_bytes else 'FAIL'}
(packet/'staged-verification.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8',newline='\n')
print(json.dumps(result,indent=2))
if result['result']!='PASS':sys.exit(2)