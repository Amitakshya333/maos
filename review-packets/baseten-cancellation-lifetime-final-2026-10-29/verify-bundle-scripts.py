import hashlib,json,pathlib,subprocess,sys,tarfile,zipfile
packet=pathlib.Path(sys.argv[1]);bundle=packet/'candidate-artifacts-f201cfe'/'maos-industrial-bootstrap-windows-x64-commit-f201cfe-2026-10-29.zip';source_manifest=json.loads((packet/'complete-source-hashes.json').read_bytes());build=json.loads((packet/'build-results-f201cfe.json').read_bytes())
def sha(b):return hashlib.sha256(b).hexdigest()
def lf(b):return b.replace(b'\r\n',b'\n').replace(b'\r',b'\n')
with zipfile.ZipFile(bundle) as z:
 names=z.namelist(); manifest=json.loads(z.read('bundle-manifest.json')); archive=z.read(manifest['package']['archive'])
 if manifest['sourceRevision']!=build['sourceCommit'] or manifest['sourceDeltaSha256']!=build['sourceDeltaSha256']:raise RuntimeError('Bundle provenance differs from build result.')
 if sha(archive)!=manifest['package']['sha256'] or sha(archive)!=build['packageSha256']:raise RuntimeError('Embedded npm archive hash mismatch.')
 with tarfile.open(fileobj=__import__('io').BytesIO(archive),mode='r:gz') as t:
  entries=set(t.getnames());rows=[];files={x['path']:x for x in source_manifest['files']}
  for name in ['scripts/Start-BasetenSyntheticPilot.ps1','scripts/Windows-ProcessTree.ps1']:
   member='package/'+name
   if member not in entries:raise RuntimeError(f'Missing packaged script {member}')
   data=t.extractfile(member).read(); norm=sha(lf(data)); expected=files[name]['lfNormalizedSha256']
   if norm!=expected:raise RuntimeError(f'Packaged script hash mismatch for {name}')
   rows.append({'path':name,'packageEntry':member,'rawSha256':sha(data),'lfNormalizedSha256':norm,'reviewedCommitLfSha256':expected,'lfMatch':True,'rawMatch':sha(data)==files[name]['rawSha256']})
  required=['package/desktop/package.json','package/desktop/package-lock.json','package/scripts/Install-MaosIndustrial.ps1']
  for name in required:
   if name not in entries:raise RuntimeError(f'Missing required runtime/install asset {name}')
 result={'bundlePath':str(bundle),'bundleBytes':bundle.stat().st_size,'bundleSha256':sha(bundle.read_bytes()),'sourceRevision':manifest['sourceRevision'],'sourceDeltaSha256':manifest['sourceDeltaSha256'],'embeddedArchiveBytes':len(archive),'embeddedArchiveSha256':sha(archive),'packageEntriesChecked':required+['package/scripts/Start-BasetenSyntheticPilot.ps1','package/scripts/Windows-ProcessTree.ps1'],'pilotScripts':rows,'result':'PASS'}
(packet/'bundle-script-verification.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8',newline='\n');print(json.dumps(result,indent=2))