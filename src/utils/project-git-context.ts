import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type ProjectGitContext =
  | { kind: 'repository'; branch: string; changedFiles: number }
  | { kind: 'none' }
  | { kind: 'unavailable' };

export function resolveProjectGitContext(projectRoot: string): ProjectGitContext {
  let root: string;
  try {
    root = fs.realpathSync.native(path.resolve(projectRoot));
  } catch {
    return { kind: 'none' };
  }

  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)),
  ) as NodeJS.ProcessEnv;
  env.LC_ALL = 'C';
  env.LANG = 'C';

  const git = (args: string[]): string => childProcess.execFileSync(
    'git',
    ['--no-optional-locks', '-C', root, ...args],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000, windowsHide: true, env },
  );

  let repositoryRoot: string;
  try {
    repositoryRoot = fs.realpathSync.native(git(['rev-parse', '--show-toplevel']).trim());
  } catch (error: any) {
    if (error?.code === 'ENOENT' || error?.code === 'EACCES') return { kind: 'unavailable' };
    if (String(error?.stderr || '').includes('not a git repository')) return { kind: 'none' };
    return { kind: 'unavailable' };
  }

  // A project nested inside another repository is not itself a repository root.
  if (path.relative(root, repositoryRoot) !== '') return { kind: 'none' };

  let branch = 'unknown';
  try {
    branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD']).trim();
  } catch {
    try {
      branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    } catch {
      branch = 'main (no commits yet)';
    }
  }

  try {
    const status = git(['status', '--porcelain']).trim();
    return { kind: 'repository', branch, changedFiles: status ? status.split('\n').length : 0 };
  } catch {
    return { kind: 'unavailable' };
  }
}
