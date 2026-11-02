# Launch the PACKAGED Checkpoint-2 demo (key stays in the caller's env; evidence-only works without it).
$packet = 'C:\maos\review-packets\ring-demo-staging-2026-11-02'
$log = Join-Path $packet 'electron-launch-packaged.log'
$demoRoot = 'C:\clean\ring-demo-package-01'
$exe = Join-Path $demoRoot 'desktop\node_modules\electron\dist\electron.exe'
$entry = Join-Path $demoRoot 'desktop\main.cjs'
"key set: $([bool]$env:BASETEN_API_KEY)" | Out-File -FilePath $log -Encoding utf8
Push-Location $demoRoot
$proc = Start-Process -FilePath $exe -ArgumentList @($entry, '--project-root', $demoRoot, '--allow-temp') -NoNewWindow -Wait -PassThru -RedirectStandardOutput (Join-Path $packet 'electron-stdout-packaged.log') -RedirectStandardError (Join-Path $packet 'electron-stderr-packaged.log')
"electron exit code: $($proc.ExitCode)" | Out-File -FilePath $log -Append -Encoding utf8
Pop-Location
