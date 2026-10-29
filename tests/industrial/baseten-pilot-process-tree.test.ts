import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const helperPath = path.resolve(__dirname, '../../scripts/Windows-ProcessTree.ps1');
const launcherPath = path.resolve(__dirname, '../../scripts/Start-BasetenSyntheticPilot.ps1');
const cancellationRaceHarness = String.raw`using System;
using System.Reflection;
using System.Threading;

public static class MaosPilotCancellationTestHarness
{
    private const int WaitMilliseconds = 5000;
    public static Exception DispatchFailure;

    private static ConsoleCancelEventHandler Handler(object adapter)
    {
        var field = adapter.GetType().GetField("handler", BindingFlags.Instance | BindingFlags.NonPublic);
        if (field == null) throw new InvalidOperationException("Console handler field was not found.");
        return (ConsoleCancelEventHandler)field.GetValue(adapter);
    }

    private static void Invoke(object adapter, ConsoleCancelEventHandler handler) { handler(adapter, null); }
    private static void Dispose(object adapter) { ((IDisposable)adapter).Dispose(); }

    private static bool IsSourceDisposed(object adapter)
    {
        var field = adapter.GetType().GetField("sourceDisposed", BindingFlags.Instance | BindingFlags.NonPublic);
        if (field == null) throw new InvalidOperationException("Cancellation source state was not found.");
        return (bool)field.GetValue(adapter);
    }

    private static void Require(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }

    private static Thread Background(ThreadStart start)
    {
        var thread = new Thread(start);
        thread.IsBackground = true;
        return thread;
    }

    public static void ExerciseLifetime(object active, object late, object concurrent)
    {
        ExerciseCallbackDuringDisposal(active);
        ExerciseDispatchAfterDisposal(late);
        ExerciseConcurrentDisposal(concurrent);
    }

    private static void ExerciseCallbackDuringDisposal(object adapter)
    {
        var handler = Handler(adapter);
        var token = (CancellationToken)adapter.GetType().GetProperty("Token").GetValue(adapter, null);
        var entered = new ManualResetEventSlim(false);
        var reentrantReturned = new ManualResetEventSlim(false);
        var release = new ManualResetEventSlim(false);
        var disposeReturned = new ManualResetEventSlim(false);
        var callbackError = new Exception[1];
        var dispatchError = new Exception[1];
        var disposeError = new Exception[1];
        var registration = token.Register(new Action(delegate
        {
            entered.Set();
            try { Dispose(adapter); }
            catch (Exception error) { callbackError[0] = error; }
            reentrantReturned.Set();
            if (!release.Wait(WaitMilliseconds)) callbackError[0] = new TimeoutException("Callback release barrier expired.");
        }));
        var dispatch = Background(new ThreadStart(delegate
        {
            try { Invoke(adapter, handler); }
            catch (Exception error) { dispatchError[0] = error; }
        }));
        Thread dispose = null;
        try
        {
            dispatch.Start();
            Require(entered.Wait(WaitMilliseconds), "Cancellation callback did not enter.");
            Require(reentrantReturned.Wait(WaitMilliseconds), "Reentrant Dispose deadlocked during Cancel.");
            dispose = Background(new ThreadStart(delegate
            {
                try { Dispose(adapter); }
                catch (Exception error) { disposeError[0] = error; }
                finally { disposeReturned.Set(); }
            }));
            dispose.Start();
            var waitingForCallbackDrain = SpinWait.SpinUntil(delegate { return (dispose.ThreadState & ThreadState.WaitSleepJoin) != 0; }, WaitMilliseconds);
            var sourceDisposedBeforeRelease = IsSourceDisposed(adapter);
            var disposeReturnedBeforeRelease = disposeReturned.IsSet;
            release.Set();
            Require(dispatch.Join(WaitMilliseconds), "Cancellation callback did not finish.");
            Require(dispose.Join(WaitMilliseconds), "Concurrent Dispose did not finish.");
            Require(waitingForCallbackDrain, "External Dispose did not wait for the active callback.");
            Require(!sourceDisposedBeforeRelease && !disposeReturnedBeforeRelease, "Dispose completed before the active callback drained.");
            Require(disposeReturned.IsSet, "Dispose did not return after the callback drained.");
            Require(callbackError[0] == null, "Reentrant Dispose threw: " + callbackError[0]);
            Require(disposeError[0] == null, "Concurrent Dispose threw: " + disposeError[0]);
            Require(dispatchError[0] == null, "Cancellation callback threw: " + dispatchError[0]);
            Require(IsSourceDisposed(adapter), "Cancellation source was not disposed after callback exit.");
        }
        finally
        {
            release.Set();
            if (dispatch.IsAlive) dispatch.Join(WaitMilliseconds);
            if (dispose != null && dispose.IsAlive) dispose.Join(WaitMilliseconds);
            registration.Dispose();
            entered.Dispose();
            reentrantReturned.Dispose();
            release.Dispose();
            disposeReturned.Dispose();
        }
    }

    private static void ExerciseDispatchAfterDisposal(object adapter)
    {
        var handler = Handler(adapter);
        var dispatched = new ManualResetEventSlim(false);
        var allowEntry = new ManualResetEventSlim(false);
        var callbackError = new Exception[1];
        var callback = Background(new ThreadStart(delegate
        {
            dispatched.Set();
            if (!allowEntry.Wait(WaitMilliseconds)) { callbackError[0] = new TimeoutException("Callback entry barrier expired."); return; }
            try { Invoke(adapter, handler); }
            catch (Exception error) { callbackError[0] = error; }
        }));
        try
        {
            callback.Start();
            Require(dispatched.Wait(WaitMilliseconds), "Callback dispatch barrier was not reached.");
            Dispose(adapter);
            Require(IsSourceDisposed(adapter), "Cancellation source was not disposed before late callback entry.");
            allowEntry.Set();
            Require(callback.Join(WaitMilliseconds), "Late callback did not finish.");
            Require(callbackError[0] == null, "Late callback touched disposed state: " + callbackError[0]);
        }
        finally
        {
            allowEntry.Set();
            if (callback.IsAlive) callback.Join(WaitMilliseconds);
            dispatched.Dispose();
            allowEntry.Dispose();
        }
    }

    private static void ExerciseConcurrentDisposal(object adapter)
    {
        const int count = 8;
        var ready = new CountdownEvent(count);
        var start = new ManualResetEventSlim(false);
        var errors = new Exception[count];
        var threads = new Thread[count];
        try
        {
            for (var i = 0; i < count; i++)
            {
                var index = i;
                threads[i] = Background(new ThreadStart(delegate
                {
                    ready.Signal();
                    start.Wait();
                    try { Dispose(adapter); }
                    catch (Exception error) { errors[index] = error; }
                }));
                threads[i].Start();
            }
            Require(ready.Wait(WaitMilliseconds), "Dispose workers did not reach the barrier.");
            start.Set();
            for (var i = 0; i < count; i++) Require(threads[i].Join(WaitMilliseconds), "Dispose worker did not finish.");
            Dispose(adapter);
            Dispose(adapter);
            for (var i = 0; i < count; i++) Require(errors[i] == null, "Concurrent Dispose threw: " + errors[i]);
            Require(IsSourceDisposed(adapter), "Concurrent Dispose did not release the token source.");
        }
        finally
        {
            start.Set();
            for (var i = 0; i < count; i++) if (threads[i] != null && threads[i].IsAlive) threads[i].Join(WaitMilliseconds);
            ready.Dispose();
            start.Dispose();
        }
    }

    public static Thread DispatchAfterSignal(EventWaitHandle signal, object adapter)
    {
        DispatchFailure = null;
        var handler = Handler(adapter);
        var thread = Background(new ThreadStart(delegate
        {
            try
            {
                if (!signal.WaitOne(WaitMilliseconds)) throw new TimeoutException("Child process did not signal readiness.");
                Invoke(adapter, handler);
            }
            catch (Exception error) { DispatchFailure = error; }
        }));
        thread.Start();
        return thread;
    }
}`;

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

function writeCancellationRaceHarness(root: string) {
  const harnessPath = path.join(root, 'MaosPilotCancellationTestHarness.cs');
  fs.writeFileSync(harnessPath, cancellationRaceHarness, 'utf8');
  return harnessPath;
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

  it.each(powershells)('$file $version synchronizes cancellation callback and disposal', ({ file }) => {
    const root = tempRoot();
    const harnessPath = writeCancellationRaceHarness(root);
    const script = [
      '$ErrorActionPreference = "Stop"',
      '. ' + psLiteral(helperPath),
      'Add-Type -Path ' + psLiteral(harnessPath),
      '$active = [MaosPilotConsoleCancellation]::new()',
      '$late = [MaosPilotConsoleCancellation]::new()',
      '$concurrent = [MaosPilotConsoleCancellation]::new()',
      '[MaosPilotCancellationTestHarness]::ExerciseLifetime($active, $late, $concurrent)',
      '$active.Dispose(); $late.Dispose(); $concurrent.Dispose()',
      "Write-Output 'CANCELLATION_LIFETIME_OK'",
      'exit 0',
    ].join('\n');
    const result = runPowerShell(file, script, 20000);
    expect(result.error, result.stdout + '\n' + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + '\n' + result.stderr).toBe(0);
    expect(result.stdout).toContain('CANCELLATION_LIFETIME_OK');
  });
  it.each(powershells)('$file $version cancels through the adapter and waits for the launched process tree', ({ file }) => {
    const root = tempRoot();
    const harnessPath = writeCancellationRaceHarness(root);
    const signalName = 'Local\\MAOS.PilotTest.' + process.pid + '.' + Math.random().toString(16).slice(2);
    const marker = path.join(root, 'tree-pids.txt');
    const child = path.join(root, 'parent-child.ps1');
    fs.writeFileSync(child, [
      '$grandchild = Start-Process -FilePath ' + psLiteral(file) + " -ArgumentList @('-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 300') -PassThru",
      '[System.IO.File]::WriteAllText(' + psLiteral(marker) + ', "$PID,$($grandchild.Id)")',
      '$ready = [System.Threading.EventWaitHandle]::OpenExisting(' + psLiteral(signalName) + ')',
      '$ready.Set()',
      '$ready.Dispose()',
      'while ($true) { Start-Sleep -Seconds 1 }',
    ].join('\n'), 'utf8');
    const script = [
      '$ErrorActionPreference = "Stop"',
      '. ' + psLiteral(helperPath),
      'Add-Type -Path ' + psLiteral(harnessPath),
      '$ready = [System.Threading.EventWaitHandle]::new($false, [System.Threading.EventResetMode]::ManualReset, ' + psLiteral(signalName) + ')',
      '$adapter = [MaosPilotConsoleCancellation]::new()',
      '$dispatcher = [MaosPilotCancellationTestHarness]::DispatchAfterSignal($ready, $adapter)',
      '$exitCode = 1',
      'try {',
      '  $null = Invoke-MaosOwnedProcessTree -FilePath ' + psLiteral(file) + " -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File'," + psLiteral(child) + ') -WorkingDirectory ' + psLiteral(root) + ' -CancellationToken $adapter.Token',
      '  $exitCode = 0',
      '} catch [System.OperationCanceledException] { $exitCode = 130 }',
      'catch { [Console]::Error.WriteLine($_.Exception.Message); $exitCode = 1 }',
      'finally {',
      '  if ($dispatcher -and -not $dispatcher.Join(5000)) { [Console]::Error.WriteLine("cancellation dispatcher did not finish"); $exitCode = 1 }',
      '  if ([MaosPilotCancellationTestHarness]::DispatchFailure) { [Console]::Error.WriteLine([MaosPilotCancellationTestHarness]::DispatchFailure); $exitCode = 1 }',
      '  $adapter.Dispose()',
      '  $ready.Dispose()',
      '}',
      'exit $exitCode',
    ].join('\n');
    const result = runPowerShell(file, script, 20000);

    expect(result.error, result.stdout + '\n' + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + '\n' + result.stderr).toBe(130);
    expect(fs.existsSync(marker)).toBe(true);
    const pids = fs.readFileSync(marker, 'utf8').split(',').map((value) => Number(value));
    expect(pids).toHaveLength(2);
    const check = [
      '$ids = @(' + pids.join(',') + ')',
      '$running = @($ids | ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })',
      'if ($running.Count -gt 0) { exit 1 } else { exit 0 }',
    ].join('\n');
    const remaining = runPowerShell(file, check);
    expect(remaining.error, remaining.stdout + '\n' + remaining.stderr).toBeUndefined();
    expect(remaining.status, remaining.stdout + '\n' + remaining.stderr).toBe(0);
  });
  it.each(powershells)('$file $version holds the launcher mutex through adapter cancellation and process shutdown', ({ file }) => {
    const root = tempRoot();
    const harnessPath = writeCancellationRaceHarness(root);
    const signalName = 'Local\\MAOS.PilotTest.Mutex.' + process.pid + '.' + Math.random().toString(16).slice(2);
    const marker = path.join(root, 'tree-ready.txt');
    const child = path.join(root, 'active-child.ps1');
    fs.writeFileSync(child, [
      '[System.IO.File]::WriteAllText(' + psLiteral(marker) + ', "$PID")',
      '$ready = [System.Threading.EventWaitHandle]::OpenExisting(' + psLiteral(signalName) + ')',
      '$ready.Set()',
      '$ready.Dispose()',
      'while ($true) { Start-Sleep -Seconds 1 }',
    ].join('\n'), 'utf8');
    const secondAttempt = path.join(root, 'second-launch.ps1');
    fs.writeFileSync(secondAttempt, [
      '$ready = [System.Threading.EventWaitHandle]::OpenExisting(' + psLiteral(signalName) + ')',
      '$ready.WaitOne()',
      '$ready.Dispose()',
      "$mutex = [System.Threading.Mutex]::new($false, 'Local\\MAOS.Baseten.SyntheticPilot')",
      'if ($mutex.WaitOne(0)) { $mutex.ReleaseMutex(); exit 0 } else { exit 42 }',
    ].join('\n'), 'utf8');
    const script = [
      '$ErrorActionPreference = "Stop"',
      '$mutex = [System.Threading.Mutex]::new($false, \'Local\\MAOS.Baseten.SyntheticPilot\')',
      'if (-not $mutex.WaitOne(0)) { exit 41 }',
      '. ' + psLiteral(helperPath),
      'Add-Type -Path ' + psLiteral(harnessPath),
      '$ready = [System.Threading.EventWaitHandle]::new($false, [System.Threading.EventResetMode]::ManualReset, ' + psLiteral(signalName) + ')',
      '$second = Start-Process -FilePath ' + psLiteral(file) + " -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File'," + psLiteral(secondAttempt) + ') -PassThru',
      '$adapter = [MaosPilotConsoleCancellation]::new()',
      '$dispatcher = [MaosPilotCancellationTestHarness]::DispatchAfterSignal($ready, $adapter)',
      '$operationCode = 1',
      'try {',
      '  $null = Invoke-MaosOwnedProcessTree -FilePath ' + psLiteral(file) + " -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File'," + psLiteral(child) + ') -WorkingDirectory ' + psLiteral(root) + ' -CancellationToken $adapter.Token',
      '  $operationCode = 0',
      '} catch [System.OperationCanceledException] { $operationCode = 130 }',
      'catch { [Console]::Error.WriteLine($_.Exception.Message); $operationCode = 1 }',
      'finally {',
      '  if ($dispatcher -and -not $dispatcher.Join(5000)) { [Console]::Error.WriteLine("cancellation dispatcher did not finish"); $operationCode = 1 }',
      '  if ([MaosPilotCancellationTestHarness]::DispatchFailure) { [Console]::Error.WriteLine([MaosPilotCancellationTestHarness]::DispatchFailure); $operationCode = 1 }',
      '  $adapter.Dispose()',
      '  $ready.Dispose()',
      '}',
      '$second.WaitForExit()',
      '$secondCode = $second.ExitCode',
      '$mutex.ReleaseMutex()',
      'if ($operationCode -eq 130 -and $secondCode -eq 42) { exit 0 } else { exit 1 }',
    ].join('\n');
    const result = runPowerShell(file, script, 20000);

    expect(result.error, result.stdout + '\n' + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + '\n' + result.stderr).toBe(0);
    expect(fs.existsSync(marker)).toBe(true);
  });
  it('keeps the supported launcher bound to the same mutex and task-owned helper', () => {
    const source = fs.readFileSync(launcherPath, 'utf8');
    expect(source).toContain("Local\\MAOS.Baseten.SyntheticPilot");
    expect(source).toContain('Invoke-MaosOwnedProcessTree');
    expect(source).not.toContain('Start-Process -FilePath $electron -ArgumentList $arguments -WorkingDirectory $projectRoot -Wait');
  });
  it('uses a runspace-free console cancel adapter', () => {
    const launcher = fs.readFileSync(launcherPath, 'utf8');
    const helper = fs.readFileSync(helperPath, 'utf8');
    expect(launcher).toContain('[MaosPilotConsoleCancellation]::new()');
    expect(launcher).not.toContain('[System.ConsoleCancelEventHandler]');
    expect(launcher).not.toContain('[Console]::remove_CancelKeyPress()');
    expect(helper).toContain('Console.CancelKeyPress += handler;');
    expect(helper).toContain('eventArgs.Cancel = true;');
    expect(helper).toContain('cancellation.Cancel();');
    expect(helper).toContain('Console.CancelKeyPress -= handler;');
  });
});
