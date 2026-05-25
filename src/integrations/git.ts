import { execSync } from 'child_process';

/**
 * MAOS Git Operations
 *
 * Provides git branch isolation for agents.
 * Each agent works on its own branch, preventing conflicts
 * when multiple agents modify the same project simultaneously.
 */

export interface GitBranchInfo {
  name: string;
  current: boolean;
  lastCommit?: string;
  lastMessage?: string;
}

export interface GitDiffSummary {
  filesChanged: number;
  insertions: number;
  deletions: number;
  files: string[];
}

// ─── Helpers ──────────────────────────────────────────────────

function git(cmd: string, cwd: string): string {
  try {
    return execSync(`git ${cmd}`, {
      cwd,
      encoding: 'utf-8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (err: any) {
    const stderr = err.stderr?.trim() || err.message;
    throw new Error(`git ${cmd.split(' ')[0]} failed: ${stderr}`);
  }
}

function gitSafe(cmd: string, cwd: string): string | null {
  try {
    return git(cmd, cwd);
  } catch {
    return null;
  }
}

// ─── Branch Operations ────────────────────────────────────────

/**
 * Get the current branch name.
 */
export function getCurrentBranch(cwd: string): string {
  return git('rev-parse --abbrev-ref HEAD', cwd);
}

/**
 * Check if a branch exists (local).
 */
export function branchExists(branchName: string, cwd: string): boolean {
  const result = gitSafe(`rev-parse --verify ${branchName}`, cwd);
  return result !== null;
}

/**
 * Create a new branch from the current HEAD and switch to it.
 * If branch already exists, just switches to it.
 */
export function createBranch(branchName: string, cwd: string): void {
  if (branchExists(branchName, cwd)) {
    git(`checkout ${branchName}`, cwd);
  } else {
    git(`checkout -b ${branchName}`, cwd);
  }
}

/**
 * Create a branch from a specific base branch.
 * Useful for creating agent branches from main.
 */
export function createBranchFrom(
  branchName: string,
  baseBranch: string,
  cwd: string,
): void {
  if (branchExists(branchName, cwd)) {
    git(`checkout ${branchName}`, cwd);
  } else {
    git(`checkout -b ${branchName} ${baseBranch}`, cwd);
  }
}

/**
 * Switch to an existing branch.
 */
export function switchBranch(branchName: string, cwd: string): void {
  git(`checkout ${branchName}`, cwd);
}

/**
 * Get a list of all local branches with metadata.
 */
export function getBranchList(cwd: string): GitBranchInfo[] {
  const raw = git(
    'branch --format="%(refname:short)|%(HEAD)|%(objectname:short)|%(subject)"',
    cwd,
  );
  
  if (!raw) return [];

  return raw.split('\n').filter(Boolean).map(line => {
    // Remove surrounding quotes if present
    const clean = line.replace(/^"|"$/g, '');
    const [name, head, commit, ...messageParts] = clean.split('|');
    return {
      name: name.trim(),
      current: head.trim() === '*',
      lastCommit: commit?.trim(),
      lastMessage: messageParts.join('|').trim(),
    };
  });
}

/**
 * Get branches that match a MAOS pattern (maos/*)
 */
export function getMaosBranches(cwd: string): GitBranchInfo[] {
  return getBranchList(cwd).filter(b => b.name.startsWith('maos/'));
}

// ─── Stash Operations ─────────────────────────────────────────

/**
 * Stash any uncommitted changes.
 * Returns true if something was stashed.
 */
export function stashChanges(cwd: string, message?: string): boolean {
  const statusBefore = git('stash list', cwd);
  const msg = message ? `save "${message}"` : 'save "MAOS auto-stash"';
  gitSafe(`stash ${msg}`, cwd);
  const statusAfter = git('stash list', cwd);
  return statusBefore !== statusAfter;
}

/**
 * Pop the most recent stash.
 */
export function stashPop(cwd: string): void {
  gitSafe('stash pop', cwd);
}

// ─── Diff & Status ────────────────────────────────────────────

/**
 * Check if there are uncommitted changes.
 */
export function hasUncommittedChanges(cwd: string): boolean {
  const status = git('status --porcelain', cwd);
  return status.length > 0;
}

/**
 * Get a summary of uncommitted changes.
 */
export function getDiffSummary(cwd: string): GitDiffSummary {
  const files = git('diff --name-only HEAD', cwd)
    .split('\n')
    .filter(Boolean);
  
  // Also include untracked files
  const untracked = git('ls-files --others --exclude-standard', cwd)
    .split('\n')
    .filter(Boolean);

  const allFiles = [...new Set([...files, ...untracked])];

  // Get stat if there are staged/modified files
  let insertions = 0;
  let deletions = 0;
  if (files.length > 0) {
    const stat = gitSafe('diff --stat HEAD', cwd) || '';
    const statMatch = stat.match(/(\d+) insertions?\(\+\)/);
    const delMatch = stat.match(/(\d+) deletions?\(-\)/);
    insertions = statMatch ? parseInt(statMatch[1]) : 0;
    deletions = delMatch ? parseInt(delMatch[1]) : 0;
  }

  return {
    filesChanged: allFiles.length,
    insertions,
    deletions,
    files: allFiles,
  };
}

/**
 * Get the diff between current branch and a base branch.
 */
export function getBranchDiff(
  targetBranch: string,
  baseBranch: string,
  cwd: string,
): string {
  return gitSafe(`diff ${baseBranch}...${targetBranch} --stat`, cwd) || 'No differences';
}

/**
 * Get the full patch diff between branches.
 */
export function getBranchPatch(
  targetBranch: string,
  baseBranch: string,
  cwd: string,
): string {
  const patch = gitSafe(`diff ${baseBranch}...${targetBranch}`, cwd) || '';
  // Truncate if too large (>50KB)
  if (patch.length > 50000) {
    return patch.substring(0, 50000) + '\n... [truncated, full diff too large]';
  }
  return patch;
}

// ─── Commit Operations ────────────────────────────────────────

/**
 * Stage all changes and commit.
 */
export function commitAll(message: string, cwd: string): string {
  git('add -A', cwd);
  git(`commit -m "${message.replace(/"/g, '\\"')}"`, cwd);
  return git('rev-parse --short HEAD', cwd);
}

/**
 * Get the last N commits on the current branch.
 */
export function getRecentCommits(cwd: string, count: number = 5): Array<{
  hash: string;
  message: string;
  date: string;
}> {
  const raw = gitSafe(
    `log -${count} --pretty=format:"%h|%s|%ci"`,
    cwd,
  );
  
  if (!raw) return [];

  return raw.split('\n').filter(Boolean).map(line => {
    const clean = line.replace(/^"|"$/g, '');
    const [hash, message, date] = clean.split('|');
    return {
      hash: hash?.trim() || '',
      message: message?.trim() || '',
      date: date?.trim() || '',
    };
  });
}

// ─── Merge Operations ─────────────────────────────────────────

/**
 * Check if a branch can be cleanly merged into the current branch.
 */
export function canMerge(branchName: string, cwd: string): boolean {
  // Try a merge dry-run
  const result = gitSafe(`merge --no-commit --no-ff ${branchName}`, cwd);
  // Abort the merge regardless
  gitSafe('merge --abort', cwd);
  return result !== null;
}

// ─── Agent Branch Lifecycle ───────────────────────────────────

/**
 * Prepare a branch for an agent to work on.
 * This is called by the orchestrator before dispatching an agent.
 *
 * Strategy: Each agent gets its own branch from main.
 * Branch naming: maos/{agent_id_lower}/{task_id_lower}
 *
 * NOTE: Since agents share the same working directory,
 * we DON'T actually switch branches during parallel execution.
 * Instead, we create the branch reference and let the agent
 * commit to it after switching. For true parallel isolation,
 * we'd need git worktrees (Day 5+ stretch goal).
 *
 * For now: agents work on main, and we create branches
 * post-completion by branching from the agent's commits.
 */
export function prepareAgentBranch(
  agentId: string,
  taskId: string,
  baseBranch: string,
  cwd: string,
): string {
  const branchName = `maos/${agentId.toLowerCase()}/${taskId.toLowerCase().replace(/[^a-z0-9_-]/g, '_')}`;

  // Don't switch branches here — just record the branch name.
  // The agent-runner will switch when it starts (if running solo)
  // or we'll create the branch from commits post-completion.
  return branchName;
}

/**
 * After an agent completes its work on the main branch,
 * create a named branch pointing at the current HEAD.
 * This preserves the agent's work under a descriptive branch name.
 */
export function tagAgentWork(
  branchName: string,
  cwd: string,
): void {
  // If we're on main and have commits, create a branch at HEAD
  if (!branchExists(branchName, cwd)) {
    gitSafe(`branch ${branchName}`, cwd);
  }
}

/**
 * Check if the git repo is in a clean state (no conflicts, not mid-merge).
 */
export function isRepoClean(cwd: string): boolean {
  const status = gitSafe('status --porcelain', cwd);
  return status !== null && status.length === 0;
}

/**
 * Ensure we're on the expected branch, or switch to it.
 */
export function ensureBranch(branchName: string, cwd: string): void {
  const current = getCurrentBranch(cwd);
  if (current !== branchName) {
    switchBranch(branchName, cwd);
  }
}
