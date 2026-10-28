import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { withJudgedRunLock } from '../../src/industrial/judged-run-lock';

const REPO_ROOT = path.resolve(__dirname, '../..');
const roots: string[] = [];

function createRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-judged-run-lock-'));
  roots.push(root);
  return root;
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function startLockHolder(root: string, runId: string): ChildProcessWithoutNullStreams {
  const lockModule = path.join(REPO_ROOT, 'src', 'industrial', 'judged-run-lock.ts');
  const script = [
    "const fs = require('node:fs');",
    "const ts = require('typescript');",
    "require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText, filename);",
    "const { withJudgedRunLock } = require(process.argv[1]);",
    "withJudgedRunLock(process.argv[2], process.argv[3], async () => { process.stdout.write('ready\\n'); await new Promise(resolve => process.stdin.once('data', resolve)); });",
  ].join('\n');
  return spawn(process.execPath, ['-e', script, lockModule, root, runId], { cwd: REPO_ROOT, stdio: 'pipe' });
}

function waitForReady(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (output.includes('ready\n')) resolve();
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (!output.includes('ready\n')) reject(new Error(`Lock holder exited before acquiring its lock (${code}).`));
    });
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('error', reject);
    child.once('exit', () => resolve());
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('judged-run cross-process lock', () => {
  it('holds the lock across awaited work and fails closed when storage is unavailable', async () => {
    const root = createRoot();
    const entered = deferred();
    const release = deferred();
    const first = withJudgedRunLock(root, 'judged-run-test-held', async () => {
      entered.resolve();
      await release.promise;
      return 'done';
    });

    await entered.promise;
    expect(() => withJudgedRunLock(root, 'judged-run-test-held', () => 'must-not-run')).toThrowError(/already being changed/);
    const rootAlias = path.join(root, 'root-alias');
    fs.symlinkSync(root, rootAlias, 'junction');
    expect(() => withJudgedRunLock(rootAlias, 'judged-run-test-held', () => 'must-not-run')).toThrowError(/already being changed/);
    release.resolve();
    await expect(first).resolves.toBe('done');
    expect(withJudgedRunLock(root, 'judged-run-test-held', () => 'released')).toBe('released');

    const blockedRoot = createRoot();
    fs.mkdirSync(path.join(blockedRoot, '.maos'), { recursive: true });
    fs.writeFileSync(path.join(blockedRoot, '.maos', 'industrial-runs'), 'not a directory');
    let executed = false;
    expect(() => withJudgedRunLock(blockedRoot, 'judged-run-lock-failure', () => { executed = true; })).toThrowError(/Could not acquire judged-run lock/);
    expect(executed).toBe(false);
  });

  it('does not steal a live process lock and reclaims an interrupted finalizer lock', async () => {
    const liveRoot = createRoot();
    const liveRunId = 'judged-run-cross-process-live';
    const holder = startLockHolder(liveRoot, liveRunId);
    try {
      await waitForReady(holder);
      expect(() => withJudgedRunLock(liveRoot, liveRunId, () => 'must-not-run')).toThrowError(/already being changed/);
      holder.stdin.end('release');
      await waitForExit(holder);
      expect(withJudgedRunLock(liveRoot, liveRunId, () => 'acquired-after-release')).toBe('acquired-after-release');
    } finally {
      if (holder.exitCode === null && holder.signalCode === null) holder.kill();
      await waitForExit(holder);
    }

    const interruptedRoot = createRoot();
    const interruptedRunId = 'judged-run-cross-process-interrupted';
    const interrupted = startLockHolder(interruptedRoot, interruptedRunId);
    await waitForReady(interrupted);
    interrupted.kill();
    await waitForExit(interrupted);
    expect(withJudgedRunLock(interruptedRoot, interruptedRunId, () => 'recovered')).toBe('recovered');
    expect(fs.existsSync(path.join(interruptedRoot, '.maos', 'industrial-runs', `${interruptedRunId}.lock`))).toBe(false);
  });
});
