param(
  [Parameter(Mandatory = $true)][string]$PackagePath,
  [Parameter(Mandatory = $true)][string]$LockPath
)

$lockCheck = @'
console.log('ARGV=' + JSON.stringify(process.argv));
const p=require(process.argv[1]);
const l=require(process.argv[2]);
const r=l.packages[''];
console.log('IDENTITY=' + JSON.stringify({packageName:p.name,lockName:l.name,rootName:r.name,packageVersion:p.version,lockVersion:l.version,rootVersion:r.version}));
const mismatches=[];
for(const group of ['dependencies','devDependencies']) {
  for(const [name,range] of Object.entries(p[group]||{})) {
    if((r[group]||{})[name]!==range) mismatches.push(group+':'+name+':package='+range+':lock='+(r[group]||{})[name]);
  }
}
console.log('MISMATCHES=' + JSON.stringify(mismatches));
if(mismatches.length) process.exit(1);
'@
& node.exe -e $lockCheck $PackagePath $LockPath
$nativeExit = $LASTEXITCODE
Write-Output "NATIVE_EXIT=$nativeExit"
exit $nativeExit
