param([string]$InstallScript,[string]$BundleRoot,[string]$InstallRoot,[string]$Evidence,[string]$TempRoot,[string]$UserRoot,[string]$AppData,[string]$LocalAppData,[string]$NpmCache,[string]$ElectronCache,[string]$NpmConfig,[string]$GlobalNpmConfig)
$ErrorActionPreference='Stop'
$stdout=Join-Path $Evidence 'installer.stdout.log'
$stderr=Join-Path $Evidence 'installer.stderr.log'
$pwsh=(Get-Command pwsh.exe).Source
$psi=[System.Diagnostics.ProcessStartInfo]::new()
$psi.FileName=$pwsh
$psi.UseShellExecute=$false
$psi.RedirectStandardOutput=$true
$psi.RedirectStandardError=$true
foreach($arg in @('-NoLogo','-NoProfile','-NonInteractive','-File',$InstallScript,'-BundleRoot',$BundleRoot,'-InstallRoot',$InstallRoot)){$psi.ArgumentList.Add($arg)}
$psi.Environment.Clear()
$copyNames=@('PATH','SystemRoot','WINDIR','COMSPEC','PATHEXT','SystemDrive','ProgramFiles','ProgramFiles(x86)','CommonProgramFiles','CommonProgramFiles(x86)','NUMBER_OF_PROCESSORS')
foreach($name in $copyNames){$value=[Environment]::GetEnvironmentVariable($name,'Process'); if($null -ne $value){$psi.Environment[$name]=$value}}
$psi.Environment['OS']='Windows_NT'
$psi.Environment['TEMP']=$TempRoot
$psi.Environment['TMP']=$TempRoot
$psi.Environment['USERPROFILE']=$UserRoot
$psi.Environment['APPDATA']=$AppData
$psi.Environment['LOCALAPPDATA']=$LocalAppData
$psi.Environment['NPM_CONFIG_CACHE']=$NpmCache
$psi.Environment['NPM_CONFIG_USERCONFIG']=$NpmConfig
$psi.Environment['NPM_CONFIG_GLOBALCONFIG']=$GlobalNpmConfig
$psi.Environment['ELECTRON_CACHE']=$ElectronCache
$psi.Environment['electron_config_cache']=$ElectronCache
$p=[System.Diagnostics.Process]::new()
$p.StartInfo=$psi
if(-not $p.Start()){throw 'Could not start isolated installer process.'}
$outTask=$p.StandardOutput.ReadToEndAsync()
$errTask=$p.StandardError.ReadToEndAsync()
$p.WaitForExit()
$outTask.GetAwaiter().GetResult() | Set-Content -LiteralPath $stdout
$errTask.GetAwaiter().GetResult() | Set-Content -LiteralPath $stderr
$result=[ordered]@{exitCode=$p.ExitCode; processId=$p.Id; stdout=$stdout; stderr=$stderr; installRoot=$InstallRoot; tempRoot=$TempRoot; npmCache=$NpmCache; electronCache=$ElectronCache}
$result | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $Evidence 'installer-result.json')
exit $p.ExitCode
