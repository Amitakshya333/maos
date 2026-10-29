import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const helperPath = path.resolve(__dirname, '../../scripts/Windows-ProcessTree.ps1');
const launcherPath = path.resolve(__dirname, '../../scripts/Start-BasetenSyntheticPilot.ps1');
const temporaryRoots: string[] = [];
const powershells = process.platform === 'win32'
  ? ['pwsh.exe', 'powershell.exe'].flatMap((file) => {
      const probe = spawnSync(file, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8' });
      const location = spawnSync('where.exe', [file], { encoding: 'utf8' });
      const executable = location.stdout.split(/\r?\n/).find((line) => line.trim())?.trim();
      return probe.error || probe.status !== 0 || !executable ? [] : [{ file: executable, version: probe.stdout.trim() }];
    })
  : [];

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-pilot-process-tree-'));
  temporaryRoots.push(root);
  return root;
}

function psLiteral(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function sanitizedEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of [
    'BASETEN_API_KEY',
    'META_API_KEY',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
  ]) delete environment[name];
  return environment;
}

function runPowerShell(file: string, script: string, timeout = 20000) {
  const root = temporaryRoots[temporaryRoots.length - 1];
  const scriptPath = path.join(root, `runner-${Date.now()}-${Math.random().toString(16).slice(2)}.ps1`);
  fs.writeFileSync(scriptPath, script, 'utf8');
  const result = spawnSync(file, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
    cwd: root,
    encoding: 'utf8',
    timeout,
    env: sanitizedEnvironment(),
  });
  return result;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe.skipIf(powershells.length === 0)('Baseten pilot task-owned Windows process tree', () => {
  it.each(powershells)('$file $version preserves normal and nonzero application exit codes', ({ file }) => {
    const root = tempRoot();
    const childZero = path.join(root, 'normal-child.ps1');
    const childFailure = path.join(root, 'failed-child.ps1');
    fs.writeFileSync(childZero, 'exit 0\n', 'utf8');
    fs.writeFileSync(childFailure, 'exit 23\n', 'utf8');

    for (const [child, expected] of [[childZero, 0], [childFailure, 23]] as const) {
      const script = [
        '$ErrorActionPreference = "Stop"',
        `. ${psLiteral(helperPath)}`,
        '$cancel = [System.Threading.CancellationTokenSource]::new()',
        `try { $code = Invoke-MaosOwnedProcessTree -FilePath ${psLiteral(file)} -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',${psLiteral(child)}) -WorkingDirectory ${psLiteral(root)} -CancellationToken $cancel.Token; exit $code }`,
        'catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }',
      ].join('\n');
      const result = runPowerShell(file, script);
      expect(result.error, `${result.stdout}\n${result.stderr}`).toBeUndefined();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(expected);
    }
  });

  it.each(powershells)('$file $version cancels and waits for the launched process tree', ({ file }) => {
    const root = tempRoot();
    const marker = path.join(root, 'tree-pids.txt');
    const child = path.join(root, 'parent-child.ps1');
    fs.writeFileSync(child, [
      `$grandchild = Start-Process -FilePath ${psLiteral(file)} -ArgumentList @('-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 300') -PassThru`,
      `[System.IO.File]::WriteAllText(${psLiteral(marker)}, "$PID,$($grandchild.Id)")`,
      'while ($true) { Start-Sleep -Seconds 1 }',
    ].join('\n'), 'utf8');
    const script = [
      '$ErrorActionPreference = "Stop"',
      `. ${psLiteral(helperPath)}`,
      '$cancel = [System.Threading.CancellationTokenSource]::new()',
      '$cancel.CancelAfter(2500)',
      `try { $null = Invoke-MaosOwnedProcessTree -FilePath ${psLiteral(file)} -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',${psLiteral(child)}) -WorkingDirectory ${psLiteral(root)} -CancellationToken $cancel.Token; exit 0 }`,
      'catch [System.OperationCanceledException] { exit 130 }',
      'catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }',
    ].join('\n');
    const result = runPowerShell(file, script, 15000);

    expect(result.error, `${result.stdout}\n${result.stderr}`).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(130);
    expect(fs.existsSync(marker)).toBe(true);
    const pids = fs.readFileSync(marker, 'utf8').split(',').map((value) => Number(value));
    expect(pids).toHaveLength(2);
    const check = [
      `$ids = @(${pids.join(',')})`,
      '$running = @($ids | ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })',
      'if ($running.Count -gt 0) { exit 1 } else { exit 0 }',
    ].join('\n');
    const remaining = runPowerShell(file, check);
    expect(remaining.error, `${remaining.stdout}\n${remaining.stderr}`).toBeUndefined();
    expect(remaining.status, `${remaining.stdout}\n${remaining.stderr}`).toBe(0);
  });

  it.each(powershells)('$file $version refuses a second pilot launch while the first process tree is active', ({ file }) => {
    const root = tempRoot();
    const marker = path.join(root, 'tree-ready.txt');
    const child = path.join(root, 'active-child.ps1');
    fs.writeFileSync(child, [
      `[System.IO.File]::WriteAllText(${psLiteral(marker)}, "$PID")`,
      'while ($true) { Start-Sleep -Seconds 1 }',
    ].join('\n'), 'utf8');
    const secondAttempt = path.join(root, 'second-launch.ps1');
    fs.writeFileSync(secondAttempt, [
      `while (-not (Test-Path -LiteralPath ${psLiteral(marker)})) { Start-Sleep -Milliseconds 20 }`,
      "$mutex = [System.Threading.Mutex]::new($false, 'Local\\MAOS.Baseten.SyntheticPilot')",
      'if ($mutex.WaitOne(0)) { $mutex.ReleaseMutex(); exit 0 } else { exit 42 }',
    ].join('\n'), 'utf8');
    const script = [
      '$ErrorActionPreference = "Stop"',
      `$mutex = [System.Threading.Mutex]::new($false, 'Local\\MAOS.Baseten.SyntheticPilot')`,
      'if (-not $mutex.WaitOne(0)) { exit 41 }',
      `. ${psLiteral(helperPath)}`,
      `$second = Start-Process -FilePath ${psLiteral(file)} -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',${psLiteral(secondAttempt)}) -PassThru`,
      '$cancel = [System.Threading.CancellationTokenSource]::new()',
      '$cancel.CancelAfter(2500)',
      `try { $null = Invoke-MaosOwnedProcessTree -FilePath ${psLiteral(file)} -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',${psLiteral(child)}) -WorkingDirectory ${psLiteral(root)} -CancellationToken $cancel.Token } catch [System.OperationCanceledException] { }`,
      '$second.WaitForExit()',
      '$code = $second.ExitCode',
      '$mutex.ReleaseMutex()',
      'if ($code -eq 42) { exit 0 } else { exit 1 }',
    ].join('\n');
    const result = runPowerShell(file, script, 15000);

    expect(result.error, `${result.stdout}\n${result.stderr}`).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(fs.existsSync(marker)).toBe(true);
  });

  it('keeps the supported launcher bound to the same mutex and task-owned helper', () => {
    const source = fs.readFileSync(launcherPath, 'utf8');
    expect(source).toContain("Local\\MAOS.Baseten.SyntheticPilot");
    expect(source).toContain('Invoke-MaosOwnedProcessTree');
    expect(source).not.toContain('Start-Process -FilePath $electron -ArgumentList $arguments -WorkingDirectory $projectRoot -Wait');
  });
});
