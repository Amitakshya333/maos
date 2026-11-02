import hashlib,json,pathlib,subprocess,sys
repo=pathlib.Path(r'C:\maos');packet=pathlib.Path(sys.argv[1]);base='bb871cb191184b5de1b790d42fc452a29f8f072e';expected_commit='f201cfe38bf3a741b5d8c6b37793cc3c112c43a9';paths=['scripts/Start-BasetenSyntheticPilot.ps1','scripts/Windows-ProcessTree.ps1','tests/industrial/baseten-pilot-process-tree.test.ts','tests/industrial/meta-model-api-contract.test.ts']
def run(args):
 p=subprocess.run(args,cwd=repo,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 return p
def git(args):
 p=run(['git',*args])
 if p.returncode:raise RuntimeError(p.stderr.decode(errors='replace'))
 return p.stdout.decode().strip()
def sha(b):return hashlib.sha256(b).hexdigest()
manifest=json.loads((packet/'complete-source-hashes.json').read_bytes());expected={x['path']:x for x in manifest['files']}
commit=git(['rev-parse','HEAD']);parent=git(['rev-parse','HEAD^']);subject=git(['show','-s','--format=%s','HEAD']);branch=git(['branch','--show-current']);tree=git(['diff-tree','--no-commit-id','--name-only','-r','HEAD']).splitlines();index=run(['git','diff','--cached','--quiet']);allowlist_dirty=run(['git','diff','--name-only','HEAD','--',*paths]);rows=[]
for name in paths:
 blob=run(['git','show',f'{commit}:{name}'])
 if blob.returncode:raise RuntimeError(f'Unable to read committed blob {name}')
 blob_sha=sha(blob.stdout)
 if blob_sha!=expected[name]['lfNormalizedSha256']:raise RuntimeError(f'Committed blob mismatch for {name}: {blob_sha}')
 oid=git(['rev-parse',f'{commit}:{name}']);rows.append({'path':name,'gitBlob':oid,'sha256':blob_sha,'matchesReviewedLfHash':True})
exact=sorted(tree)==sorted(paths)
result={'commit':commit,'parent':parent,'subject':subject,'branch':branch,'committedPaths':tree,'exactAllowlist':exact,'committedBlobs':rows,'indexEmpty':index.returncode==0,'allowlistedWorkingTreeClean':not allowlist_dirty.stdout.strip(),'result':'PASS' if commit==expected_commit and parent==base and branch=='main' and exact and index.returncode==0 and not allowlist_dirty.stdout.strip() else 'FAIL'}
(packet/'checkpoint-verification.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8',newline='\n');print(json.dumps(result,indent=2));
if result['result']!='PASS':sys.exit(2)