# Launch the Ring demo rehearsal. Run from the PowerShell window where BASETEN_API_KEY is set.
$packet = 'C:\maos\review-packets\ring-demo-staging-2026-11-02'
$log = Join-Path $packet 'electron-launch.log'
$demoRoot = 'C:\clean\ring-demo-01'
$exe = Join-Path $demoRoot 'desktop\node_modules\electron\dist\electron.exe'
$entry = Join-Path $demoRoot 'desktop\main.cjs'
"key set: $([bool]$env:BASETEN_API_KEY)" | Out-File -FilePath $log -Encoding utf8
if (-not $env:BASETEN_API_KEY) { "STOP: BASETEN_API_KEY not set." | Out-File -FilePath $log -Append -Encoding utf8; exit 1 }
Push-Location $demoRoot
$proc = Start-Process -FilePath $exe -ArgumentList @($entry, '--project-root', $demoRoot, '--allow-temp') -NoNewWindow -Wait -PassThru -RedirectStandardOutput (Join-Path $packet 'electron-stdout.log') -RedirectStandardError (Join-Path $packet 'electron-stderr.log')
"electron exit code: $($proc.ExitCode)" | Out-File -FilePath $log -Append -Encoding utf8
Pop-Location
