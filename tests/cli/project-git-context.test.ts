import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const gitCalls = vi.hoisted(() => ({ calls: [] as any[] }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn((...args: any[]) => {
      gitCalls.calls.push(args);
      return (actual.execFileSync as any)(...args);
    }),
  };
});

import { runDoctor } from '../../src/cli/doctor';
import { resolveProjectGitContext } from '../../src/utils/project-git-context';

const temporaryRoots: string[] = [];
let originalCwd = '';
const cleanEnv = () => Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)),
) as NodeJS.ProcessEnv;

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maos git context '));
  temporaryRoots.push(root);
  return root;
}

function git(args: string[], cwd?: string): string {
  const result = childProcess.spawnSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function createRepository(root: string, branch: string): void {
  fs.mkdirSync(root, { recursive: true });
  git(['init', root]);
  git(['-C', root, 'config', 'user.name', 'MAOS Temporary Test']);
  git(['-C', root, 'config', 'user.email', 'maos-temporary-test@example.invalid']);
  fs.writeFileSync(path.join(root, 'synthetic.txt'), 'temporary test content\n');
  git(['-C', root, 'add', 'synthetic.txt']);
  git(['-C', root, '-c', 'commit.gpgsign=false', 'commit', '-m', 'synthetic test repository']);
  git(['-C', root, 'branch', '-M', branch]);
}

function addProjectConfig(root: string): void {
  const maos = path.join(root, '.maos');
  fs.mkdirSync(maos, { recursive: true });
  fs.writeFileSync(path.join(maos, 'maos.config.json'), JSON.stringify({
    schemaVersion: 1,
    projectName: 'temporary-git-boundary-test',
    providers: {},
    agents: [],
  }));
}

afterEach(() => {
  if (originalCwd) process.chdir(originalCwd);
  originalCwd = '';
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  gitCalls.calls.length = 0;
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('explicit project Git context', () => {
  it('does not query branch or status when a non-repository child sits under a repository', async () => {
    const temp = makeRoot();
    const parent = path.join(temp, 'parent repo');
    const child = path.join(parent, 'selected project');
    const ambient = path.join(temp, 'unrelated ambient directory');
    createRepository(parent, 'synthetic-parent-branch');
    fs.mkdirSync(child);
    fs.mkdirSync(ambient);
    addProjectConfig(child);

    gitCalls.calls.length = 0;
    expect(resolveProjectGitContext(child)).toEqual({ kind: 'none' });
    const gitArgs = gitCalls.calls.map(([, args]) => (args as string[]).join(' '));
    expect(gitArgs).toHaveLength(1);
    expect(gitArgs[0]).toContain('rev-parse --show-toplevel');
    expect(gitArgs.join('\n')).not.toMatch(/symbolic-ref|status --porcelain/);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    originalCwd = process.cwd();
    process.chdir(ambient);
    const report = await runDoctor(child);
    const gitCheck = report.checks.find((check) => check.label === 'Git');
    expect(report.checks.find((check) => check.label === 'Config')?.status).toBe('pass');
    expect(gitCheck?.detail).toBe('No project repository');
    expect(log.mock.calls.flat().join('\n')).not.toContain('synthetic-parent-branch');
    expect(gitCalls.calls.map(([, args]) => (args as string[]).join(' ')).some((args) => args.includes('status --porcelain'))).toBe(false);
  });

  it('reports branch and changes for a normal repository whose path contains spaces', () => {
    const root = path.join(makeRoot(), 'normal repository with spaces');
    createRepository(root, 'selected-project-branch');
    fs.writeFileSync(path.join(root, 'changed.txt'), 'changed\n');

    const result = resolveProjectGitContext(root);
    expect(root).toContain(' ');
    expect(result).toEqual({ kind: 'repository', branch: 'selected-project-branch', changedFiles: 1 });
  });

  it('supports a Git worktree whose .git entry is a file', () => {
    const temp = makeRoot();
    const source = path.join(temp, 'source repository');
    const worktree = path.join(temp, 'selected worktree with spaces');
    createRepository(source, 'source-branch');
    git(['-C', source, 'worktree', 'add', '-b', 'selected-worktree-branch', worktree]);

    expect(fs.statSync(path.join(worktree, '.git')).isFile()).toBe(true);
    expect(resolveProjectGitContext(worktree)).toEqual({ kind: 'repository', branch: 'selected-worktree-branch', changedFiles: 0 });
  });

  it('ignores inherited Git directory and work-tree overrides', () => {
    const temp = makeRoot();
    const selected = path.join(temp, 'selected repository');
    const hostile = path.join(temp, 'other repository');
    createRepository(selected, 'selected-branch');
    createRepository(hostile, 'redirected-parent-branch');
    vi.stubEnv('GIT_DIR', path.join(hostile, '.git'));
    vi.stubEnv('GIT_WORK_TREE', hostile);
    vi.stubEnv('GIT_INDEX_FILE', path.join(hostile, 'redirected.index'));

    gitCalls.calls.length = 0;
    expect(resolveProjectGitContext(selected)).toEqual({ kind: 'repository', branch: 'selected-branch', changedFiles: 0 });
    expect(gitCalls.calls.every(([, , options]) => !Object.keys((options as any).env || {}).some((name) => /^GIT_/i.test(name)))).toBe(true);
  });

  it('keeps the REPL on its explicit child project instead of the ambient parent repository', () => {
    const temp = makeRoot();
    const parent = path.join(temp, 'parent repository');
    const child = path.join(parent, 'child project with spaces');
    createRepository(parent, 'synthetic-parent-branch');
    fs.mkdirSync(child);
    addProjectConfig(child);

    const replModule = path.join(process.cwd(), 'src', 'cli', 'repl.ts');
    const tsNodeRegister = require.resolve('ts-node/register/transpile-only');
    const script = 'require(process.argv[1]).runRepl(process.argv[2]);';
    const result = childProcess.spawnSync(process.execPath, ['-r', tsNodeRegister, '-e', script, replModule, child], {
      cwd: parent,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        NO_COLOR: '1',
        TS_NODE_PROJECT: path.join(process.cwd(), 'tsconfig.json'),
        TS_NODE_TRANSPILE_ONLY: 'true',
        GIT_DIR: path.join(parent, '.git'),
        GIT_WORK_TREE: parent,
      },
      input: 'exit\n',
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).not.toContain('synthetic-parent-branch');
  });
});
