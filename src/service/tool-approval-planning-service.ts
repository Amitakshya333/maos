/**
 * MAOS Industrial — Tool and Approval Planning Service (F7-04)
 *
 * Provides application-level lifecycle management for tool execution contracts:
 * - Atomic persistence to .maos/execution-plans/${contractId}.json
 * - Pre-execution validation against safety invariants
 * - Privacy-preserving audit logging
 */

import * as fs from 'fs';
import * as path from 'path';
import type { WorkflowPlan, WorkflowPlanStep } from '../domain/workflow-plan';
import type {
  ToolExecutionPlan,
  PreExecutionEvaluationOutcome,
} from '../domain/tool-plan';
import {
  ToolApprovalPlanner,
  ToolContractCreationOptions,
  ToolPreExecutionContext,
} from '../industrial/tool-approval-planner';
import { AuditService } from './audit-service';

export interface ToolApprovalPlanningServiceOptions {
  readonly auditService?: AuditService;
  readonly planner?: ToolApprovalPlanner;
}

export class ToolApprovalPlanningService {
  private readonly plansDir: string;
  private readonly auditService?: AuditService;
  private readonly planner: ToolApprovalPlanner;

  constructor(
    private readonly projectRoot: string,
    options: ToolApprovalPlanningServiceOptions = {},
  ) {
    this.plansDir = path.join(this.projectRoot, '.maos', 'execution-plans');
    this.auditService = options.auditService;
    this.planner = options.planner ?? new ToolApprovalPlanner();
    this.ensureDirectory();
  }

  private ensureDirectory(): void {
    if (!fs.existsSync(this.plansDir)) {
      fs.mkdirSync(this.plansDir, { recursive: true });
    }
  }

  /**
   * Creates an execution contract for a workflow step, validates it,
   * writes it atomically to disk, and logs an audit event.
   */
  public createContract(
    step: WorkflowPlanStep,
    plan: WorkflowPlan,
    options?: ToolContractCreationOptions,
  ): ToolExecutionPlan {
    const contract = this.planner.createExecutionContract(step, plan, options);
    this.saveContractToDisk(contract);

    if (this.auditService) {
      this.auditService.recordAuditEvent({
        category: 'stage',
        source: 'tool-approval-planning-service',
        data: {
          event: 'TOOL_EXECUTION_CONTRACT_CREATED',
          agent: contract.authorizedAgent,
          contractId: contract.contractId,
          stepId: contract.stepId,
          allowedTool: contract.allowedTool,
          approvalRequirement: contract.approvalRequirement,
          humanReviewRequirement: contract.humanReviewRequirement,
          contractHash: contract.contractHash,
          idempotencyKey: contract.idempotencyKey,
        },
      });
    }

    return contract;
  }

  /**
   * Evaluates pre-execution safety gates for a contract and records audit events.
   */
  public evaluatePreExecution(
    contractOrId: ToolExecutionPlan | string,
    context: ToolPreExecutionContext,
  ): PreExecutionEvaluationOutcome {
    const contract =
      typeof contractOrId === 'string'
        ? this.getContract(contractOrId)
        : contractOrId;

    if (!contract) {
      return {
        success: false,
        code: 'INVALID_CONTRACT_SCHEMA',
        reason: `Contract "${contractOrId}" not found on disk.`,
      };
    }

    const outcome = this.planner.evaluatePreExecution(contract, context);

    if (this.auditService) {
      if (outcome.success) {
        this.auditService.recordAuditEvent({
          category: 'tool',
          source: 'tool-approval-planning-service',
          data: {
            event: 'TOOL_PRE_EXECUTION_VALIDATED',
            agent: context.executingAgent.id,
            contractId: contract.contractId,
            toolName: context.requestedTool,
            status: outcome.code === 'IDEMPOTENCY_REPLAY' ? 'REPLAY' : 'APPROVED_FOR_EXECUTION',
            contractHash: contract.contractHash,
          },
        });
      } else {
        this.auditService.recordAuditEvent({
          category: 'warning',
          source: 'tool-approval-planning-service',
          data: {
            event: 'TOOL_PRE_EXECUTION_REJECTED',
            agent: context.executingAgent.id,
            contractId: contract.contractId,
            toolName: context.requestedTool,
            errorCode: outcome.code,
            reason: outcome.reason,
            contractHash: contract.contractHash,
          },
        });
      }
    }

    return outcome;
  }

  /**
   * Reads a stored execution contract from disk.
   */
  public getContract(contractId: string): ToolExecutionPlan | null {
    this.ensureDirectory();
    const filePath = path.join(this.plansDir, `${contractId}.json`);
    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(raw) as ToolExecutionPlan;
    } catch {
      return null;
    }
  }

  /**
   * Lists all execution contracts stored on disk, optionally filtered by workflowPlanId.
   */
  public listContracts(workflowPlanId?: string): ToolExecutionPlan[] {
    this.ensureDirectory();
    const files = fs.readdirSync(this.plansDir).filter((f) => f.endsWith('.json'));
    const contracts: ToolExecutionPlan[] = [];

    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(this.plansDir, file), 'utf-8');
        const c = JSON.parse(raw) as ToolExecutionPlan;
        if (!workflowPlanId || c.workflowPlanId === workflowPlanId) {
          contracts.push(c);
        }
      } catch {
        // Skip malformed files
      }
    }

    return contracts.sort((a, b) => a.contractId.localeCompare(b.contractId));
  }

  /**
   * Atomically writes an execution contract to disk.
   */
  private saveContractToDisk(contract: ToolExecutionPlan): void {
    this.ensureDirectory();
    const filePath = path.join(this.plansDir, `${contract.contractId}.json`);
    const tmpPath = path.join(
      this.plansDir,
      `.tmp_${contract.contractId}_${Date.now()}_${Math.random().toString(36).substring(2, 6)}.json`,
    );

    const data = JSON.stringify(contract, null, 2);
    const fd = fs.openSync(tmpPath, 'w');
    try {
      fs.writeFileSync(fd, data, 'utf-8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    fs.renameSync(tmpPath, filePath);
  }
}
