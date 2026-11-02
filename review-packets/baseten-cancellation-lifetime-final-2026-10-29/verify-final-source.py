import hashlib,json,pathlib,subprocess,sys
repo=pathlib.Path(sys.argv[1]);packet=pathlib.Path(sys.argv[2]);base='bb871cb191184b5de1b790d42fc452a29f8f072e';main=pathlib.Path(r'C:\maos')
paths=['scripts/Start-BasetenSyntheticPilot.ps1','scripts/Windows-ProcessTree.ps1','tests/industrial/baseten-pilot-process-tree.test.ts','tests/industrial/meta-model-api-contract.test.ts']
def run(args,cwd):
 p=subprocess.run(args,cwd=cwd,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 return p
def sha(b):return hashlib.sha256(b).hexdigest()
def lf(b):return b.replace(b'\r\n',b'\n').replace(b'\r',b'\n')
def git(args,cwd):
 p=run(['git',*args],cwd)
 if p.returncode:raise RuntimeError(p.stderr.decode(errors='replace'))
 return p.stdout.decode().strip()
manifest_bytes=(packet/'complete-source-hashes.json').read_bytes();manifest=json.loads(manifest_bytes)
full_patch=(packet/'complete-correction.patch').read_bytes();delta_manifest_bytes=(packet/'delta-source-hashes.json').read_bytes();delta_manifest=json.loads(delta_manifest_bytes);delta_patch=(packet/delta_manifest['patchFile']).read_bytes()
rows=[]
for item in manifest['files']:
 b=(repo/item['path']).read_bytes();rows.append({'path':item['path'],'rawMatch':sha(b)==item['rawSha256'],'lfNormalizedMatch':sha(lf(b))==item['lfNormalizedSha256'],'rawSha256':sha(b),'lfNormalizedSha256':sha(lf(b))})
head=git(['rev-parse','HEAD'],repo);branch=git(['branch','--show-current'],repo);index=run(['git','diff','--cached','--quiet'],repo)
main_head=git(['rev-parse','HEAD'],main);main_branch=git(['branch','--show-current'],main);main_index=run(['git','diff','--cached','--quiet'],main)
tracked=git(['diff','--name-only',base],repo).splitlines()
diffcheck=run(['git','diff','--check',base,'--',*paths],repo)
old_patch=pathlib.Path(r'C:\maos\review-packets\baseten-pilot-correction-close-2026-10-29\complete-correction.patch').read_bytes();old_manifest=pathlib.Path(r'C:\maos\review-packets\baseten-pilot-correction-close-2026-10-29\source-hashes.json').read_bytes()
result={
 'candidateHead':head,'candidateBranch':'detached' if not branch else branch,'candidateIndexEmpty':index.returncode==0,
 'candidateTrackedDiffPaths':tracked,'candidateTrackedScopeExact':tracked==sorted(paths),
 'mainHead':main_head,'mainBranch':main_branch,'mainIndexEmpty':main_index.returncode==0,
 'completePatchSha256':sha(full_patch),'completePatchMatchesManifest':sha(full_patch)==manifest['patchSha256'],
 'completeManifestSha256':sha(manifest_bytes),'deltaPatchSha256':sha(delta_patch),'deltaPatchMatchesManifest':sha(delta_patch)==delta_manifest['patchSha256'],
 'deltaManifestSha256':sha(delta_manifest_bytes),'sourceFiles':rows,
 'allCurrentRawSourceHashesMatch':all(x['rawMatch'] for x in rows),'allCurrentLfSourceHashesMatch':all(x['lfNormalizedMatch'] for x in rows),
 'diffCheckExitCode':diffcheck.returncode,'diffCheckStderr':diffcheck.stderr.decode(errors='replace'),
 'historicalRejectedPatchSha256':sha(old_patch),'historicalRejectedManifestSha256':sha(old_manifest),
 'result':'PASS' if head==base and not branch and index.returncode==0 and main_head==base and main_branch=='main' and main_index.returncode==0 and tracked==sorted(paths) and sha(full_patch)==manifest['patchSha256'] and sha(delta_patch)==delta_manifest['patchSha256'] and all(x['rawMatch'] and x['lfNormalizedMatch'] for x in rows) and diffcheck.returncode==0 else 'FAIL'
}
(packet/'final-source-verification.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8',newline='\n')
print(json.dumps(result,indent=2))
if result['result']!='PASS':sys.exit(2)