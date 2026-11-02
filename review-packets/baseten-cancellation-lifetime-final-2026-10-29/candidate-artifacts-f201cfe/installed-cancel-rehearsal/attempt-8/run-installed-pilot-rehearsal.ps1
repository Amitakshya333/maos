param(
  [Parameter(Mandatory=$true)][string]$InstallRoot,
  [Parameter(Mandatory=$true)][string]$EnginePath,
  [Parameter(Mandatory=$true)][string]$HookPath,
  [Parameter(Mandatory=$true)][string]$ServerPath,
  [Parameter(Mandatory=$true)][string]$EvidenceRoot,
  [Parameter(Mandatory=$true)][string]$TestRoot,
  [Parameter(Mandatory=$true)][ValidateSet('cancel','normal')][string]$Mode
)
$ErrorActionPreference='Stop'
$state=Join-Path $EvidenceRoot ('mock-state-'+$Mode)
New-Item -ItemType Directory -Path $state -Force | Out-Null
$stdoutPath=Join-Path $EvidenceRoot ('launcher-'+$Mode+'.stdout.log')
$stderrPath=Join-Path $EvidenceRoot ('launcher-'+$Mode+'.stderr.log')
$readyPath=Join-Path $EvidenceRoot ('launcher-'+$Mode+'-started.json')
$resultPath=Join-Path $EvidenceRoot ('launcher-'+$Mode+'-native-result.json')
$engineExpected='3dc07f0a5b097867e5e9b150d54e6490898b7465dcfe654a6e490d9c9b6da2a2'
$node=(Get-Command node.exe).Source
$pwsh=(Get-Command pwsh.exe).Source
$mock=$null
$child=$null
$childOutTask=$null
$childErrTask=$null
$mockOutTask=$null
$mockErrTask=$null
$ctrlEventSent=$false
$ctrlEventError=0
$mockServerPort=0
$syntheticCredential='synthetic-only-'+[guid]::NewGuid().ToString('N')
$syntheticWasLogged=$false
$forcedCleanup=$false
$hooks=@()
$activeBeforeCtrl=$false
$ownedBefore=@()
$ownedAfter=@()
function Write-DurableJson([string]$Path,$Value) {
  $json=ConvertTo-Json -InputObject $Value -Depth 8
  $bytes=[System.Text.UTF8Encoding]::new($false).GetBytes($json+[Environment]::NewLine)
  $stream=[System.IO.File]::Open($Path,[System.IO.FileMode]::Create,[System.IO.FileAccess]::Write,[System.IO.FileShare]::Read)
  try {$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)} finally {$stream.Dispose()}
}
function Get-Descendants([int]$RootPid) {
  $all=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CreationDate)
  $known=[System.Collections.Generic.HashSet[int]]::new()
  [void]$known.Add($RootPid)
  $result=[System.Collections.Generic.List[object]]::new()
  $changed=$true
  while($changed) {
    $changed=$false
    foreach($item in $all) {
      $pidValue=[int]$item.ProcessId
      if(-not $known.Contains($pidValue) -and $known.Contains([int]$item.ParentProcessId)) {
        [void]$known.Add($pidValue)
        $result.Add([pscustomobject]@{pid=$pidValue;parentPid=[int]$item.ParentProcessId;name=[string]$item.Name;creationDate=[string]$item.CreationDate})
        $changed=$true
      }
    }
  }
  return ,$result.ToArray()
}
function Read-Hooks {
  $p=Join-Path $state 'hook-loads.jsonl'
  if(-not (Test-Path -LiteralPath $p)){return @()}
  return @(Get-Content -LiteralPath $p | Where-Object {$_} | ForEach-Object {$_ | ConvertFrom-Json})
}
function Get-BaseEnvironment {
  $map=@{}
  foreach($name in @('PATH','SystemRoot','WINDIR','COMSPEC','PATHEXT','SystemDrive','ProgramFiles','ProgramFiles(x86)','CommonProgramFiles','CommonProgramFiles(x86)','NUMBER_OF_PROCESSORS')) {
    $v=[Environment]::GetEnvironmentVariable($name,'Process')
    if($null -ne $v){$map[$name]=$v}
  }
  $map['OS']='Windows_NT'
  $map['TEMP']=Join-Path $TestRoot 'pilot temp'
  $map['TMP']=$map['TEMP']
  $map['USERPROFILE']=Join-Path $TestRoot 'pilot profile'
  $map['APPDATA']=Join-Path $TestRoot 'pilot appdata'
  $map['LOCALAPPDATA']=Join-Path $TestRoot 'pilot localappdata'
  $map['HOME']=$map['USERPROFILE']
  return $map
}
function Stop-OwnProcess([System.Diagnostics.Process]$Process) {
  if($Process -and -not $Process.HasExited) {
    try {$Process.Kill($true);$Process.WaitForExit(10000);return $true} catch {return $false}
  }
  return $false
}
try {
  if((Get-FileHash -LiteralPath $EnginePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $engineExpected){throw 'External engine hash differs from the recorded fixture.'}
  foreach($d in @((Join-Path $TestRoot 'pilot temp'),(Join-Path $TestRoot 'pilot profile'),(Join-Path $TestRoot 'pilot appdata'),(Join-Path $TestRoot 'pilot localappdata'))){New-Item -ItemType Directory -Path $d -Force | Out-Null}
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MaosTestConsoleControl {
  public delegate bool HandlerRoutine(uint controlType);
  private static readonly HandlerRoutine Callback = Handle;
  [DllImport("kernel32.dll", SetLastError=true)] private static extern bool AllocConsole();
  [DllImport("kernel32.dll")] private static extern IntPtr GetConsoleWindow();
  [DllImport("kernel32.dll", SetLastError=true)] private static extern bool SetConsoleCtrlHandler(HandlerRoutine handler, bool add);
  [DllImport("kernel32.dll", SetLastError=true)] private static extern bool GenerateConsoleCtrlEvent(uint eventType, uint processGroupId);
  [DllImport("kernel32.dll", SetLastError=true)] private static extern bool FreeConsole();
  [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr window, int command);
  private static bool Handle(uint type) { return type == 0; }
  public static void Initialize() {
    if (GetConsoleWindow() == IntPtr.Zero) { FreeConsole(); if (!AllocConsole()) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "AllocConsole failed after detaching inherited console."); }
    IntPtr window = GetConsoleWindow();
    if (window != IntPtr.Zero) ShowWindow(window, 0);
    if (!SetConsoleCtrlHandler(Callback, true)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "SetConsoleCtrlHandler failed.");
  }
  public static int SendCtrlC() {
    if (GenerateConsoleCtrlEvent(0, 0)) return 0;
    return Marshal.GetLastWin32Error();
  }
  public static void Shutdown() {
    SetConsoleCtrlHandler(Callback, false);
    FreeConsole();
  }
}
'@
  [MaosTestConsoleControl]::Initialize()
  $base=Get-BaseEnvironment
  $serverPsi=[System.Diagnostics.ProcessStartInfo]::new()
  $serverPsi.FileName=$node;$serverPsi.UseShellExecute=$false;$serverPsi.CreateNoWindow=$true
  $serverPsi.RedirectStandardOutput=$true;$serverPsi.RedirectStandardError=$true
  $serverPsi.ArgumentList.Add($ServerPath);$serverPsi.ArgumentList.Add($state)
  $serverPsi.Environment.Clear()
  foreach($k in $base.Keys){$serverPsi.Environment[$k]=$base[$k]}
  $mock=[System.Diagnostics.Process]::new();$mock.StartInfo=$serverPsi
  if(-not $mock.Start()){throw 'Could not start the isolated loopback mock server.'}
  $mockOutTask=$mock.StandardOutput.ReadToEndAsync();$mockErrTask=$mock.StandardError.ReadToEndAsync()
  $serverReadyPath=Join-Path $state 'mock-server-ready.json'
  $watcher=[System.IO.FileSystemWatcher]::new($state,'mock-server-ready.json')
  $watcher.NotifyFilter=[System.IO.NotifyFilters]::FileName -bor [System.IO.NotifyFilters]::LastWrite
  $watcher.EnableRaisingEvents=$true
  try {
    $deadline=[DateTime]::UtcNow.AddSeconds(20)
    while(-not (Test-Path -LiteralPath $serverReadyPath) -and [DateTime]::UtcNow -lt $deadline) {
      if($mock.HasExited){throw "Mock server exited with code $($mock.ExitCode)."}
      [void]$watcher.WaitForChanged([System.IO.WatcherChangeTypes]::Created -bor [System.IO.WatcherChangeTypes]::Renamed,1000)
    }
  } finally {$watcher.Dispose()}
  if(-not (Test-Path -LiteralPath $serverReadyPath)){throw 'Loopback mock server did not become ready.'}
  $serverReady=Get-Content -LiteralPath $serverReadyPath -Raw | ConvertFrom-Json
  $mockServerPort=[int]$serverReady.port
  $health=Invoke-RestMethod -Uri ('http://127.0.0.1:'+$mockServerPort+'/_health') -Method Get -TimeoutSec 5
  if(-not $health.ok){throw 'Loopback mock health check failed.'}
  $childPsi=[System.Diagnostics.ProcessStartInfo]::new()
  $childPsi.FileName=$pwsh;$childPsi.UseShellExecute=$false;$childPsi.CreateNoWindow=$false
  $childPsi.WorkingDirectory=$TestRoot
  $childPsi.RedirectStandardOutput=$true;$childPsi.RedirectStandardError=$true
  foreach($arg in @('-NoLogo','-NoProfile','-NonInteractive','-File',(Join-Path (Join-Path $InstallRoot 'app') 'scripts\Start-BasetenSyntheticPilot.ps1'),'-InstallRoot',$InstallRoot,'-ExternalEnginePath',$EnginePath)){$childPsi.ArgumentList.Add($arg)}
  $childPsi.Environment.Clear()
  foreach($k in $base.Keys){$childPsi.Environment[$k]=$base[$k]}
  $childPsi.Environment['BASETEN_API_KEY']=$syntheticCredential
  $childPsi.Environment['MAOS_TEST_STATE_DIR']=$state
  $childPsi.Environment['MAOS_TEST_MOCK_PORT']=[string]$mockServerPort
  $childPsi.Environment['NODE_OPTIONS']='--require="'+$HookPath.Replace('\','/')+'"'
  $childPsi.Environment['ELECTRON_CACHE']=Join-Path $TestRoot 'electron cache'
  $childPsi.Environment['electron_config_cache']=$childPsi.Environment['ELECTRON_CACHE']
  $child=[System.Diagnostics.Process]::new();$child.StartInfo=$childPsi
  if(-not $child.Start()){throw 'Could not start the installed pilot launcher.'}
  $childOutTask=$child.StandardOutput.ReadToEndAsync();$childErrTask=$child.StandardError.ReadToEndAsync()
  Write-DurableJson $readyPath ([ordered]@{mode=$Mode;launcherPid=$child.Id;startedAt=[DateTime]::UtcNow.ToString('o');installRoot=$InstallRoot;mockHost='127.0.0.1';mockPort=$mockServerPort;hasSyntheticCredentialInCommandLine=$false;awaitingHookedInstalledProcesses=$true})
  $hooksWatcher=[System.IO.FileSystemWatcher]::new($state,'hook-loads.jsonl')
  $hooksWatcher.NotifyFilter=[System.IO.NotifyFilters]::FileName -bor [System.IO.NotifyFilters]::LastWrite -bor [System.IO.NotifyFilters]::Size
  $hooksWatcher.EnableRaisingEvents=$true
  try {
    $hookDeadline=[DateTime]::UtcNow.AddSeconds(45)
    while([DateTime]::UtcNow -lt $hookDeadline) {
      if($child.HasExited){throw "Installed launcher exited before GUI initialization with native code $($child.ExitCode)."}
      $hooks=Read-Hooks
      $electronHook=(@($hooks|Where-Object {$_.exe -ieq 'electron.exe' -and $_.processType -eq 'browser'}).Count -gt 0)
      $nodeHook=(@($hooks|Where-Object {$_.exe -ieq 'node.exe' -and -not $_.electron}).Count -gt 0)
      if($electronHook -and $nodeHook){break}
      [void]$hooksWatcher.WaitForChanged([System.IO.WatcherChangeTypes]::Created -bor [System.IO.WatcherChangeTypes]::Changed,1000)
    }
  } finally {$hooksWatcher.Dispose()}
  $hooks=Read-Hooks
  $electronHook=(@($hooks|Where-Object {$_.exe -ieq 'electron.exe' -and $_.processType -eq 'browser'}).Count -gt 0)
  $nodeHook=(@($hooks|Where-Object {$_.exe -ieq 'node.exe' -and -not $_.electron}).Count -gt 0)
  if(-not $electronHook -or -not $nodeHook){throw 'Installed Electron and Node service did not both load the loopback-only test hook; no model request will be sent.'}
  Write-DurableJson (Join-Path $EvidenceRoot ('launcher-'+$Mode+'-ui-ready.json')) ([ordered]@{electronHookLoaded=$electronHook;nodeServiceHookLoaded=$nodeHook;hookProcessCount=$hooks.Count;readyAt=[DateTime]::UtcNow.ToString('o')})
  if($Mode -eq 'cancel') {
    $activePath=Join-Path $state 'request-active.json'
    $activeWatcher=[System.IO.FileSystemWatcher]::new($state,'request-active.json')
    $activeWatcher.NotifyFilter=[System.IO.NotifyFilters]::FileName -bor [System.IO.NotifyFilters]::LastWrite
    $activeWatcher.EnableRaisingEvents=$true
    try {
      $activeDeadline=[DateTime]::UtcNow.AddSeconds(180)
      while(-not (Test-Path -LiteralPath $activePath) -and [DateTime]::UtcNow -lt $activeDeadline) {
        if($child.HasExited){throw "Installed launcher exited before a mock inference request became active (native code $($child.ExitCode))."}
        [void]$activeWatcher.WaitForChanged([System.IO.WatcherChangeTypes]::Created -bor [System.IO.WatcherChangeTypes]::Renamed -bor [System.IO.WatcherChangeTypes]::Changed,1000)
      }
    } finally {$activeWatcher.Dispose()}
    if(-not (Test-Path -LiteralPath $activePath)){throw 'No loopback mock inference request became active.'}
    $active=Get-Content -LiteralPath $activePath -Raw|ConvertFrom-Json
    if(-not $active.authorizationWasConfiguredAtClient -or $active.authorizationHeaderPresentAtLoopback){throw 'Mock credential boundary assertion failed.'}
    if($active.model -ne 'meta-models/muse-spark-open-1026'){throw 'Mock received an unexpected model identity.'}
    $activeBeforeCtrl=$true
    $ownedBefore=Get-Descendants $child.Id
    Write-DurableJson (Join-Path $EvidenceRoot 'owned-processes-before-ctrlc.json') ([ordered]@{launcherPid=$child.Id;descendants=$ownedBefore;names=@($ownedBefore|ForEach-Object {$_.name}|Sort-Object -Unique)})
    Write-DurableJson (Join-Path $EvidenceRoot 'before-ctrlc.json') ([ordered]@{requestActive=$activeBeforeCtrl;launcherPid=$child.Id;preparedAt=[DateTime]::UtcNow.ToString('o')})
    $ctrlEventError=[MaosTestConsoleControl]::SendCtrlC()
    $ctrlEventSent=($ctrlEventError -eq 0)
    Write-DurableJson (Join-Path $EvidenceRoot 'ctrlc-call-returned.json') ([ordered]@{apiCallSucceeded=($ctrlEventError -eq 0);lastError=$ctrlEventError;returnedAt=[DateTime]::UtcNow.ToString('o')})
    Write-DurableJson (Join-Path $EvidenceRoot 'ctrlc-event.json') ([ordered]@{mechanism='GenerateConsoleCtrlEvent(CTRL_C_EVENT, processGroupId=0)';apiCallSucceeded=($ctrlEventError -eq 0);lastError=$ctrlEventError;sentAt=[DateTime]::UtcNow.ToString('o');requestActiveBeforeSend=$true})
    if($ctrlEventError -ne 0){throw "GenerateConsoleCtrlEvent failed with Win32 error $ctrlEventError."}
    if(-not $child.WaitForExit(45000)) {
      $forcedCleanup=Stop-OwnProcess $child
      throw 'Installed launcher did not exit after actual Ctrl+C within 45 seconds.'
    }
  } else {
    $ownedBefore=Get-Descendants $child.Id
    Write-DurableJson (Join-Path $EvidenceRoot 'owned-processes-before-normal-exit.json') ([ordered]@{launcherPid=$child.Id;descendants=$ownedBefore;names=@($ownedBefore|ForEach-Object {$_.name}|Sort-Object -Unique)})
    if(-not $child.WaitForExit(180000)) {
      $forcedCleanup=Stop-OwnProcess $child
      throw 'Installed launcher did not exit normally within 180 seconds.'
    }
  }
  $child.Refresh()
  $nativeExitCode=[int]$child.ExitCode
  $out=$childOutTask.GetAwaiter().GetResult()
  $err=$childErrTask.GetAwaiter().GetResult()
  $syntheticWasLogged=($out.Contains($syntheticCredential) -or $err.Contains($syntheticCredential))
  $out=$out.Replace($syntheticCredential,'[REDACTED SYNTHETIC CREDENTIAL]')
  $err=$err.Replace($syntheticCredential,'[REDACTED SYNTHETIC CREDENTIAL]')
  $out -replace '(?i)Bearer\s+\S+','Bearer [REDACTED]' | Set-Content -LiteralPath $stdoutPath
  $err -replace '(?i)Bearer\s+\S+','Bearer [REDACTED]' | Set-Content -LiteralPath $stderrPath
  foreach($proc in $ownedBefore) {
    $current=Get-CimInstance Win32_Process -Filter ("ProcessId = "+[int]$proc.pid) -ErrorAction SilentlyContinue
    if($current -and [string]$current.CreationDate -eq [string]$proc.creationDate){$ownedAfter+=@([pscustomobject]@{pid=[int]$proc.pid;name=[string]$current.Name;creationDate=[string]$current.CreationDate})}
  }
  $activeFinal=$null
  if($Mode -eq 'cancel' -and (Test-Path -LiteralPath (Join-Path $state 'request-active.json'))){$activeFinal=Get-Content -LiteralPath (Join-Path $state 'request-active.json') -Raw|ConvertFrom-Json}
  $mutex=[System.Threading.Mutex]::new($false,'Local\MAOS.Baseten.SyntheticPilot')
  $mutexAvailable=$false
  try {$mutexAvailable=$mutex.WaitOne(0);if($mutexAvailable){$mutex.ReleaseMutex()}} finally {$mutex.Dispose()}
  $blockedCount=0
  $blockedPath=Join-Path $state 'blocked-nonloopback.jsonl'
  if(Test-Path -LiteralPath $blockedPath){$blockedCount=@(Get-Content -LiteralPath $blockedPath).Count}
  $result=[ordered]@{
    mode=$Mode
    launcherPid=$child.Id
    launcherNativeExitCode=$nativeExitCode
    exitCodeCapturedFromProcessHandle=$true
    capturedAt=[DateTime]::UtcNow.ToString('o')
    ctrlCEventSent=($Mode -eq 'cancel' -and $ctrlEventSent)
    ctrlCWin32Error=$ctrlEventError
    requestActiveBeforeCtrlC=$activeBeforeCtrl
    mockRequest=$activeFinal
    authorizationValuePersisted=$false
    syntheticCredentialAppearedInCapturedOutput=$syntheticWasLogged
    electronHookLoaded=$electronHook
    nodeServiceHookLoaded=$nodeHook
    unexpectedNonloopbackFetchCount=$blockedCount
    ownedProcessesBeforeCtrlC=$ownedBefore
    ownedProcessPidsStillPresentAfterExit=$ownedAfter
    noOwnedProcessesRemain=($ownedAfter.Count -eq 0)
    mutexReacquirable=$mutexAvailable
    forcedCleanup=$forcedCleanup
    mockServerPid=$mock.Id
    mockServerPort=$mockServerPort
  }
  Write-DurableJson $resultPath $result
  $codePath=Join-Path $EvidenceRoot ('launcher-'+$Mode+'-native-exit-code.txt')
  $codeStream=[System.IO.File]::Open($codePath,[System.IO.FileMode]::Create,[System.IO.FileAccess]::Write,[System.IO.FileShare]::Read)
  try {$codeBytes=[System.Text.Encoding]::ASCII.GetBytes([string]$nativeExitCode+[Environment]::NewLine);$codeStream.Write($codeBytes,0,$codeBytes.Length);$codeStream.Flush($true)} finally {$codeStream.Dispose()}
  if($Mode -eq 'cancel' -and $nativeExitCode -ne 130){throw "Native launcher exit code was $nativeExitCode; expected 130."}
  if($Mode -eq 'normal' -and $nativeExitCode -ne 0){throw "Normal launcher exit code was $nativeExitCode; expected 0."}
  if($Mode -eq 'cancel' -and (-not $activeFinal.connectionClosed -or -not $mutexAvailable -or $ownedAfter.Count -gt 0)){throw 'Cancellation cleanup assertions failed.'}
  if($syntheticWasLogged){throw 'Synthetic credential appeared in captured launcher output; sanitized log retained.'}
} catch {
  if ($child -and -not $child.HasExited) { $forcedCleanup=Stop-OwnProcess $child }
  $failure=$_.Exception.Message
  if($syntheticCredential){$failure=$failure.Replace($syntheticCredential,'[REDACTED SYNTHETIC CREDENTIAL]')}
  $rawOut='';$rawErr=''
  if($childOutTask){try{$rawOut=$childOutTask.GetAwaiter().GetResult()}catch{}}
  if($childErrTask){try{$rawErr=$childErrTask.GetAwaiter().GetResult()}catch{}}
  if($rawOut.Contains($syntheticCredential)-or$rawErr.Contains($syntheticCredential)){$syntheticWasLogged=$true}
  $rawOut=$rawOut.Replace($syntheticCredential,'[REDACTED SYNTHETIC CREDENTIAL]')
  $rawErr=$rawErr.Replace($syntheticCredential,'[REDACTED SYNTHETIC CREDENTIAL]')
  $rawOut -replace '(?i)Bearer\s+\S+','Bearer [REDACTED]' | Set-Content -LiteralPath $stdoutPath
  $rawErr -replace '(?i)Bearer\s+\S+','Bearer [REDACTED]' | Set-Content -LiteralPath $stderrPath
  $pidOnFail=$null;$nativeExitCode=$null;$mockPid=$null;$mockRecord=$null
  if($child){$pidOnFail=$child.Id;if($child.HasExited){$nativeExitCode=[int]$child.ExitCode}}
  if($mock){$mockPid=$mock.Id}
  $activeFile=Join-Path $state 'request-active.json'
  if(Test-Path -LiteralPath $activeFile){$mockRecord=Get-Content -LiteralPath $activeFile -Raw|ConvertFrom-Json}
  $failureResult=[ordered]@{mode=$Mode;launcherPid=$pidOnFail;launcherNativeExitCode=$nativeExitCode;failure=$failure;ctrlCEventSent=$ctrlEventSent;ctrlCWin32Error=$ctrlEventError;requestActiveBeforeCtrlC=$activeBeforeCtrl;mockRequest=$mockRecord;syntheticCredentialAppearedInCapturedOutput=$syntheticWasLogged;forcedCleanup=$forcedCleanup;mockServerPid=$mockPid}
  Write-DurableJson $resultPath $failureResult
  throw
} finally {
  if($child -and -not $child.HasExited){$forcedCleanup=Stop-OwnProcess $child}
  if($mock -and -not $mock.HasExited){
    try{Invoke-RestMethod -Uri ('http://127.0.0.1:'+$mockServerPort+'/_shutdown') -Method Get -TimeoutSec 3|Out-Null}catch{}
    if(-not $mock.WaitForExit(5000)){try{$mock.Kill();$mock.WaitForExit(5000)}catch{}}
  }
  if($mockOutTask){try{$mockOutTask.GetAwaiter().GetResult()|Set-Content -LiteralPath (Join-Path $EvidenceRoot ('mock-server-'+$Mode+'.stdout.log'))}catch{}}
  if($mockErrTask){try{$mockErrTask.GetAwaiter().GetResult()|Set-Content -LiteralPath (Join-Path $EvidenceRoot ('mock-server-'+$Mode+'.stderr.log'))}catch{}}
  try{[MaosTestConsoleControl]::Shutdown()}catch{}
}
