/**
 * MAOS Git Worktree Manager
 *
 * Provides true parallel branch isolation using git worktrees.
 * Each agent gets its own working directory with its own checkout,
 * so agents can work on different branches simultaneously without
 * conflicts or git checkout races.
 *
 * Worktree layout:
 *   .maos/worktrees/{agentId}/   ← linked worktree for each agent
 *
 * Lifecycle:
 *   1. Orchestrator calls `ensureWorktree(agentId, branchName, cwd)`
 *   2. Agent gets back a `worktreePath` to use as its working directory
 *   3. Agent works exclusively in its worktree
 *   4. On task complete, `removeWorktree(agentId, cwd)` cleans up
 *
 * Falls back to shared-directory mode if git worktrees are unavailable.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getMaosRoot } from '../utils/paths';

// ---- Types ----

export interface WorktreeInfo {
  /** Absolute path to the worktree directory */
  worktreePath: string;
  /** Branch name checked out in this worktree */
  branch: string;
  /** Agent ID that owns this worktree */
  agentId: string;
  /** Whether this worktree is currently active */
  active: boolean;
}

// ---- Helpers ----

function gitExec(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    timeout: 30000,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function gitSafe(args: string[], cwd: string): string | null {
  try {
    return gitExec(args, cwd);
  } catch {
    return null;
  }
}

// ---- Worktree Directory ----

function getWorktreeBaseDir(projectRoot: string): string {
  return path.join(getMaosRoot(projectRoot), 'worktrees');
}

function getWorktreePath(projectRoot: string, agentId: string): string {
  const safeId = agentId.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
  return path.join(getWorktreeBaseDir(projectRoot), safeId);
}

// ---- Public API ----

/**
 * Check if git worktrees are supported in this repository.
 */
export function isWorktreeSupported(cwd: string): boolean {
  const result = gitSafe(['worktree', 'list', '--porcelain'], cwd);
  return result !== null;
}

/**
 * Create or reuse a worktree for an agent.
 *
 * If the worktree already exists on the correct branch, reuse it.
 * If it exists on a different branch, remove and recreate.
 * If it doesn't exist, create it fresh.
 *
 * Returns the absolute path to the worktree directory.
 */
export function ensureWorktree(agentId: string, branchName: string, cwd: string): WorktreeInfo {
  const wtPath = getWorktreePath(cwd, agentId);

  // Check if worktree already exists
  if (fs.existsSync(wtPath)) {
    // Verify it's on the right branch
    const currentBranch = gitSafe(['rev-parse', '--abbrev-ref', 'HEAD'], wtPath);
    if (currentBranch === branchName) {
      return { worktreePath: wtPath, branch: branchName, agentId, active: true };
    }
    // Wrong branch — remove and recreate
    removeWorktree(agentId, cwd);
  }

  // Ensure the base directory exists
  const baseDir = getWorktreeBaseDir(cwd);
  if (!fs.existsSync(baseDir)) {
    fs.mkdirSync(baseDir, { recursive: true });
  }

  // Ensure the branch exists (create from HEAD if not)
  const branchExists = gitSafe(['rev-parse', '--verify', branchName], cwd);
  if (!branchExists) {
    gitExec(['branch', branchName], cwd);
  }

  // Create the worktree
  gitExec(['worktree', 'add', wtPath, branchName], cwd);

  return { worktreePath: wtPath, branch: branchName, agentId, active: true };
}

/**
 * Remove a worktree for an agent.
 * Safe to call even if the worktree doesn't exist.
 */
export function removeWorktree(agentId: string, cwd: string): void {
  const wtPath = getWorktreePath(cwd, agentId);

  if (fs.existsSync(wtPath)) {
    try {
      gitExec(['worktree', 'remove', wtPath, '--force'], cwd);
    } catch {
      // If git worktree remove fails, try manual cleanup
      try {
        fs.rmSync(wtPath, { recursive: true, force: true });
        gitSafe(['worktree', 'prune'], cwd);
      } catch {
        /* best effort */
      }
    }
  }
}

/**
 * List all active MAOS worktrees.
 */
export function listWorktrees(cwd: string): WorktreeInfo[] {
  const baseDir = getWorktreeBaseDir(cwd);
  if (!fs.existsSync(baseDir)) return [];

  const results: WorktreeInfo[] = [];
  try {
    for (const entry of fs.readdirSync(baseDir)) {
      const wtPath = path.join(baseDir, entry);
      if (!fs.statSync(wtPath).isDirectory()) continue;

      const branch = gitSafe(['rev-parse', '--abbrev-ref', 'HEAD'], wtPath);
      results.push({
        worktreePath: wtPath,
        branch: branch || 'unknown',
        agentId: entry,
        active: branch !== null,
      });
    }
  } catch {
    /* skip */
  }

  return results;
}

/**
 * Clean up all MAOS worktrees (for shutdown / reset).
 */
export function cleanupAllWorktrees(cwd: string): number {
  const worktrees = listWorktrees(cwd);
  let cleaned = 0;
  for (const wt of worktrees) {
    removeWorktree(wt.agentId, cwd);
    cleaned++;
  }
  // Prune any dangling references
  gitSafe(['worktree', 'prune'], cwd);
  return cleaned;
}
