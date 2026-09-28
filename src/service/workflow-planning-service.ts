/**
 * MAOS Industrial — Workflow Planning Service (F7-03)
 *
 * Provides application-level workflow plan creation, persistent storage,
 * retrieval, and privacy-safe audit logging for deterministic workflow plans.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AuditService } from './audit-service';
import type {
  WorkflowPlan,
  WorkflowPlanningOutcome,
} from '../domain/workflow-plan';
import { validateWorkflowPlan } from '../domain/validators';
import {
  WorkflowPlanner,
  type WorkflowPlanningInput,
} from '../industrial/workflow-planner';

export interface WorkflowPlanningServiceOptions {
  readonly auditService?: AuditService;
  readonly planner?: WorkflowPlanner;
}

export class WorkflowPlanningService {
  private readonly plansDir: string;
  private readonly planner: WorkflowPlanner;
  private readonly auditService?: AuditService;

  constructor(
    private readonly projectRoot: string,
    options: WorkflowPlanningServiceOptions = {},
  ) {
    this.plansDir = path.join(this.projectRoot, '.maos', 'plans');
    this.planner = options.planner || new WorkflowPlanner();
    this.auditService = options.auditService;
  }

  private ensureDirectory(): void {
    if (!fs.existsSync(this.plansDir)) {
      fs.mkdirSync(this.plansDir, { recursive: true });
    }
  }

  /**
   * Plans a deterministic workflow from validated inference results.
   */
  public createPlan(input: WorkflowPlanningInput): WorkflowPlanningOutcome {
    const outcome = this.planner.plan(input);

    if (outcome.success) {
      this.savePlan(outcome.plan);

      if (this.auditService) {
        this.auditService.recordAuditEvent({
          category: 'stage',
          source: 'workflow-planning-service',
          data: {
            event: 'WORKFLOW_PLAN_CREATED',
            planId: outcome.plan.planId,
            status: outcome.plan.status,
            stepCount: outcome.plan.steps.length,
            planHash: outcome.plan.planHash,
            intent: outcome.plan.intent,
            projectId: outcome.plan.provenance.projectId,
            taskId: outcome.plan.provenance.taskId,
            runId: outcome.plan.provenance.runId,
          },
        });
      }
    } else {
      if (this.auditService) {
        this.auditService.recordAuditEvent({
          category: 'warning',
          source: 'workflow-planning-service',
          data: {
            event: 'WORKFLOW_PLAN_REJECTED',
            code: outcome.code,
            reason: outcome.reason,
            taskId: input.taskId,
            runId: input.runId,
          },
        });
      }
    }

    return outcome;
  }

  /**
   * Atomically saves a workflow plan to disk.
   */
  public savePlan(plan: WorkflowPlan): void {
    const val = validateWorkflowPlan(plan);
    if (!val.valid) {
      throw new Error(`Cannot save invalid WorkflowPlan: ${val.errors.join('; ')}`);
    }

    this.ensureDirectory();
    const filePath = path.join(this.plansDir, `${plan.planId}.json`);
    const tempPath = `${filePath}.tmp_${process.pid}_${Date.now()}`;

    const fd = fs.openSync(tempPath, 'wx');
    try {
      fs.writeFileSync(fd, JSON.stringify(plan, null, 2), 'utf-8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    fs.renameSync(tempPath, filePath);
  }

  /**
   * Retrieves a workflow plan by plan ID.
   */
  public getPlan(planId: string): WorkflowPlan | null {
    const filePath = path.join(this.plansDir, `${planId}.json`);
    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      const val = validateWorkflowPlan(parsed);
      if (!val.valid) {
        return null;
      }
      return parsed as WorkflowPlan;
    } catch {
      return null;
    }
  }

  /**
   * Lists all workflow plans stored in the project.
   */
  public listPlans(): WorkflowPlan[] {
    if (!fs.existsSync(this.plansDir)) {
      return [];
    }

    const files = fs.readdirSync(this.plansDir).filter((f) => f.endsWith('.json'));
    const plans: WorkflowPlan[] = [];

    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(this.plansDir, file), 'utf-8');
        const parsed = JSON.parse(raw);
        if (validateWorkflowPlan(parsed).valid) {
          plans.push(parsed as WorkflowPlan);
        }
      } catch {
        // Skip invalid file
      }
    }

    return plans;
  }
}
