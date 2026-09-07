/**
 * MAOS CLI — Objective Command
 *
 * Manages high-level objectives that get decomposed by ARCHITECT agents.
 *
 * Usage:
 *   objective "Build a REST API"     → Create a new objective
 *   objective list                   → Show all objectives
 *   objective status <id>            → Show objective details
 */

import chalk from 'chalk';
import {
  createObjective,
  loadAllObjectives,
  loadObjective,
  getObjectiveProgress,
  ObjectiveState,
} from '../core/objective-store';
import { createTask } from '../core/queue';

// ── Status Colors ─────────────────────────────────────────────

function statusColor(status: string): string {
  switch (status) {
    case 'planning':
      return chalk.yellow('⏳ PLANNING');
    case 'executing':
      return chalk.blue('⚡ EXECUTING');
    case 'replanning':
      return chalk.magenta('🔄 REPLANNING');
    case 'reviewing':
      return chalk.cyan('🔍 REVIEWING');
    case 'done':
      return chalk.green('✅ DONE');
    case 'failed':
      return chalk.red('❌ FAILED');
    default:
      return chalk.gray(status);
  }
}

// ── Subcommands ───────────────────────────────────────────────

function listObjectives(): void {
  const objectives = loadAllObjectives();
  if (objectives.length === 0) {
    console.log(chalk.gray('  No objectives found.'));
    console.log(chalk.gray('  Create one with: objective "Build a REST API"'));
    return;
  }

  console.log(chalk.bold('  Objectives'));
  console.log(chalk.gray('  ─────────────────────────────────────────'));

  for (const obj of objectives) {
    const progress = getObjectiveProgress(obj);
    const bar = progressBar(progress);
    console.log(
      `  ${chalk.white(obj.id.substring(0, 20))} ${statusColor(obj.status)} ` +
        `${bar} ${chalk.gray(obj.goal.substring(0, 40))}`,
    );
    console.log(
      chalk.gray(`    Children: ${obj.childTaskIds.length} total, `) +
        chalk.green(`${obj.completedChildIds.length} done, `) +
        chalk.red(`${obj.failedChildIds.length} failed, `) +
        chalk.gray(`${obj.cancelledChildIds.length} cancelled`),
    );
  }
}

function showObjectiveStatus(id: string): void {
  const obj = loadObjective(id);
  if (!obj) {
    // Try partial match
    const all = loadAllObjectives();
    const match = all.find((o) => o.id.startsWith(id));
    if (!match) {
      console.log(chalk.red(`  Objective not found: ${id}`));
      return;
    }
    showObjectiveDetail(match);
    return;
  }
  showObjectiveDetail(obj);
}

function showObjectiveDetail(obj: ObjectiveState): void {
  const progress = getObjectiveProgress(obj);

  console.log(chalk.bold(`  Objective: ${obj.id}`));
  console.log(chalk.gray('  ─────────────────────────────────────────'));
  console.log(`  Goal:     ${chalk.white(obj.goal)}`);
  console.log(`  Status:   ${statusColor(obj.status)}`);
  console.log(`  Progress: ${progressBar(progress)} ${progress}%`);
  console.log(`  Version:  ${obj.version} (${obj.replanCount} replans of ${obj.maxReplanAttempts} max)`);
  console.log(`  Created:  ${chalk.gray(obj.createdAt)}`);

  if (obj.planCompletedAt) {
    console.log(`  Planned:  ${chalk.gray(obj.planCompletedAt)}`);
  }
  if (obj.doneAt) {
    console.log(`  Done:     ${chalk.gray(obj.doneAt)}`);
  }

  // Children
  console.log('');
  console.log(chalk.bold('  Children'));

  if (obj.childTaskIds.length === 0) {
    console.log(chalk.gray('    No subtasks yet (waiting for ARCHITECT decomposition)'));
  } else {
    for (const childId of obj.childTaskIds) {
      const icon = obj.completedChildIds.includes(childId)
        ? chalk.green('✅')
        : obj.failedChildIds.includes(childId)
          ? chalk.red('❌')
          : obj.cancelledChildIds.includes(childId)
            ? chalk.gray('⊘')
            : chalk.yellow('⏳');
      console.log(`    ${icon} ${childId}`);
    }
  }

  // Plan history
  if (obj.planHistory.length > 0) {
    console.log('');
    console.log(chalk.bold('  Plan History'));
    for (const plan of obj.planHistory) {
      console.log(`    v${plan.version} — ${chalk.gray(plan.createdAt)} — ${plan.reason}`);
      console.log(chalk.gray(`      Tasks: ${plan.taskIds.join(', ')}`));
    }
  }
}

function createNewObjective(goal: string): void {
  // ── Pre-flight: verify ARCHITECT agent can actually process this ──
  try {
    const fs = require('fs');
    const { getConfigPath } = require('../utils/paths');
    const config = JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'));
    const { getAllCredentialStatuses } = require('../core/credentials');

    // Check that a planner agent exists
    const plannerAgent = (config.agents || []).find((a: any) => a.role === 'planner');
    if (!plannerAgent) {
      console.log(chalk.red('  ❌ No ARCHITECT agent configured.'));
      console.log(chalk.gray('     Objectives require a planner agent to decompose work.'));
      console.log(chalk.cyan('     Run: maos init  (choose "team" or "mixed" preset)'));
      return;
    }

    // Check planner credentials
    const credStatuses = getAllCredentialStatuses(config);
    const plannerCred = credStatuses.find((s: any) => s.agentId === plannerAgent.id);
    if (plannerCred && plannerCred.status !== 'valid') {
      console.log(chalk.red(`  ❌ ${plannerAgent.id} has no valid API key.`));
      console.log(chalk.gray(`     ${plannerCred.detail}`));
      console.log(chalk.cyan('     Run: maos configure'));
      return;
    }
  } catch {
    // If credential check fails, proceed anyway — don't block on module errors
  }

  // Create the objective task (this goes to pending/ for ARCHITECT)
  const task = createTask({
    type: 'objective',
    description: `## Objective: ${goal}\n\nDecompose this objective into concrete subtasks.\nFor each subtask, call task_complete with a structured plan.\n\n### Goal\n${goal}\n\n### Instructions\n1. Analyze the goal and identify all required work.\n2. Create subtasks using share_knowledge with type DECISION.\n3. Each subtask should be independently executable by a single agent.\n4. Specify dependencies between subtasks where needed.\n5. Call task_complete with the complete plan.`,
    capabilities: ['planning', 'decomposition', 'architecture'],
    complexity: 'high',
    category: 'planning',
  });

  // Create the objective state
  const obj = createObjective({
    id: task.id,
    goal,
    plannerAgentId: 'AUTO',
  });

  console.log(chalk.green(`  ✅ Objective created: ${task.id}`));
  console.log(chalk.gray(`     Goal: ${goal}`));
  console.log(chalk.gray(`     Status: ${obj.status}`));
  console.log(chalk.gray(`     Next: ARCHITECT will decompose this into subtasks`));
}

// ── Helpers ───────────────────────────────────────────────────

function progressBar(percent: number): string {
  const width = 15;
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  const bar = chalk.green('█'.repeat(filled)) + chalk.gray('░'.repeat(empty));
  return `[${bar}]`;
}

// ── Main Entry ────────────────────────────────────────────────

export function runObjective(args: string[]): void {
  const subcommand = args[0] || 'list';

  switch (subcommand) {
    case 'list':
    case 'ls':
      listObjectives();
      break;

    case 'status':
    case 'show':
      if (!args[1]) {
        console.log(chalk.yellow('  Usage: objective status <id>'));
        return;
      }
      showObjectiveStatus(args[1]);
      break;

    default:
      // If the first arg doesn't match a subcommand, treat the entire input as a goal
      const goal = args.join(' ');
      createNewObjective(goal);
      break;
  }
}
