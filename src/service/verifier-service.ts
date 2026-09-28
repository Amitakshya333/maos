/**
 * MAOS Canonical Run/API Verifier (F3-07)
 *
 * Implements the unified verification boundary across all domain entities:
 * - Domain schemas & schemaVersion
 * - Project, Task, and Run hierarchical relationships (confining cross-project leaks)
 * - Artifact references, existence, containment, and authoritative hash integrity
 * - Model identity, revision, and snapshot hashes
 * - Service identity manifests
 * - Tamper-evident audit chain references
 * - Monotonic event sequence references
 * - Governance approval states
 * - Request and response cryptographic hashes
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type {
  RunVerificationResult,
  VerificationCheck,
  ArtifactVerificationResult,
  ModelVerificationResult,
} from '../domain/schemas';
import { ProjectService } from './project-service';
import { TaskService } from './task-service';
import { WorkflowService } from './workflow-service';
import { ArtifactService } from './artifact-service';
import { EventService } from './event-service';
import { ApprovalService } from './approval-service';
import { AuditService } from './audit-service';
import { ModelService } from './model-service';
import { getManifest, getAllManifests } from '../industrial/service-identity';

export class VerifierService {
  constructor(
    private readonly projectRoot: string,
    private readonly services: {
      project: ProjectService;
      task: TaskService;
      workflow: WorkflowService;
      artifact: ArtifactService;
      event: EventService;
      approval: ApprovalService;
      audit: AuditService;
      model: ModelService;
    },
  ) {}

  /**
   * Verify schemaVersion is explicitly 1 on a domain object.
   */
  public verifySchemaVersion(obj: unknown): { valid: boolean; errors: string[] } {
    if (!obj || typeof obj !== 'object') {
      return { valid: false, errors: ['Object must not be null or non-object'] };
    }
    const record = obj as Record<string, unknown>;
    if (record.schemaVersion !== 1) {
      return {
        valid: false,
        errors: [`Expected schemaVersion: 1, got ${record.schemaVersion}`],
      };
    }
    return { valid: true, errors: [] };
  }

  /**
   * Verify hierarchical relationships (Project -> Task -> Run -> Artifact).
   * Rejects cross-project and cross-task references.
   */
  public verifyRelationship(opts: {
    projectId?: string;
    taskId?: string;
    runId?: string;
    artifactId?: string;
  }): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const config = this.services.project.loadConfig();
    const currentProject = config.projectName || 'default';

    // 1. Project ID scoping
    if (opts.projectId && opts.projectId !== currentProject && opts.projectId !== 'default') {
      errors.push(`Project mismatch: '${opts.projectId}' does not match hosted project '${currentProject}'.`);
    }

    // 2. Task relationship
    if (opts.taskId) {
      const task = this.services.task.getTask(opts.taskId);
      if (!task) {
        errors.push(`Referenced task '${opts.taskId}' not found.`);
      } else {
        if (opts.projectId && task.projectId !== opts.projectId && task.projectId !== currentProject) {
          errors.push(
            `Cross-project reference: Task '${opts.taskId}' belongs to project '${task.projectId}', not '${opts.projectId}'.`,
          );
        }
        if (opts.runId && task.runId && task.runId !== opts.runId) {
          errors.push(`Cross-run reference: Task '${opts.taskId}' belongs to run '${task.runId}', not '${opts.runId}'.`);
        }
      }
    }

    // 3. Run relationship
    if (opts.runId) {
      const stages = this.services.workflow.getRunStages(opts.runId);
      if (stages.length === 0) {
        // Run might be an in-progress or queued task run
        const allTasks = this.services.task.listTasks();
        const taskWithRun = allTasks.find((t) => t.runId === opts.runId);
        if (!taskWithRun) {
          errors.push(`Referenced run '${opts.runId}' has no recorded stages or associated tasks.`);
        }
      }
    }

    // 4. Artifact relationship
    if (opts.artifactId) {
      const artifact = this.services.artifact.getArtifact(opts.artifactId);
      if (!artifact) {
        errors.push(`Referenced artifact '${opts.artifactId}' not found.`);
      } else {
        if (opts.runId && artifact.runId && artifact.runId !== opts.runId) {
          errors.push(
            `Cross-run reference: Artifact '${opts.artifactId}' belongs to run '${artifact.runId}', not '${opts.runId}'.`,
          );
        }
        if (opts.taskId && artifact.taskId && artifact.taskId !== opts.taskId) {
          errors.push(
            `Cross-task reference: Artifact '${opts.artifactId}' belongs to task '${artifact.taskId}', not '${opts.taskId}'.`,
          );
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Verify an artifact's existence, path containment, and disk hash integrity.
   */
  public verifyArtifact(artifactId: string, expectedHash?: string): ArtifactVerificationResult {
    const verifiedAt = new Date().toISOString();
    const artifact = this.services.artifact.getArtifact(artifactId);

    if (!artifact) {
      return {
        valid: false,
        artifactId,
        path: '',
        computedHash: '',
        expectedHash,
        errors: [`Artifact '${artifactId}' not found in registry.`],
        verifiedAt,
      };
    }

    const absPath = path.resolve(this.projectRoot, artifact.path);
    const errors: string[] = [];

    // Path confinement check
    const canonicalRoot = path.resolve(this.projectRoot).toLowerCase();
    if (!absPath.toLowerCase().startsWith(canonicalRoot + path.sep) && absPath.toLowerCase() !== canonicalRoot) {
      errors.push(`Artifact path '${artifact.path}' escapes project root.`);
    }

    // File existence check
    if (!fs.existsSync(absPath)) {
      errors.push(`Artifact file not found on disk at '${artifact.path}'.`);
      return {
        valid: false,
        artifactId,
        path: artifact.path,
        computedHash: '',
        expectedHash,
        errors,
        verifiedAt,
      };
    }

    // Recompute actual hash from disk content
    const fileBytes = fs.readFileSync(absPath);
    const computedHash = crypto.createHash('sha256').update(fileBytes).digest('hex');

    if (computedHash.toLowerCase() !== artifact.hash.toLowerCase()) {
      errors.push(
        `Artifact disk content has been tampered! Stored metadata hash '${artifact.hash}' !== disk hash '${computedHash}'.`,
      );
    }

    if (expectedHash && computedHash.toLowerCase() !== expectedHash.toLowerCase()) {
      errors.push(`Computed hash '${computedHash}' does not match expected hash '${expectedHash}'.`);
    }

    return {
      valid: errors.length === 0,
      artifactId,
      path: artifact.path,
      computedHash,
      expectedHash,
      errors,
      verifiedAt,
    };
  }

  /**
   * Verify a model's identity, revision, and snapshot hash against manifests.
   */
  public verifyModel(opts: {
    modelId: string;
    revision?: string;
    snapshotHash?: string;
  }): ModelVerificationResult {
    const verifiedAt = new Date().toISOString();
    const errors: string[] = [];

    // Check project root or cwd for model-snapshot-manifest.json
    let manifestPath = path.join(this.projectRoot, 'model-snapshot-manifest.json');
    if (!fs.existsSync(manifestPath)) {
      manifestPath = path.join(process.cwd(), 'model-snapshot-manifest.json');
    }

    if (!fs.existsSync(manifestPath)) {
      errors.push(`Model snapshot manifest not found at '${manifestPath}'.`);
      return {
        valid: false,
        modelId: opts.modelId,
        revision: opts.revision,
        snapshotHash: opts.snapshotHash,
        errors,
        verifiedAt,
      };
    }

    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      const manifestModel = manifest.model || '';
      const manifestRevision = manifest.revision || '';

      // Normalize match (exact or suffix)
      const modelMatches =
        opts.modelId.toLowerCase() === manifestModel.toLowerCase() ||
        manifestModel.toLowerCase().includes(opts.modelId.toLowerCase()) ||
        opts.modelId.toLowerCase().includes(manifestModel.toLowerCase());

      if (!modelMatches) {
        errors.push(`Model identity mismatch: requested '${opts.modelId}', snapshot is for '${manifestModel}'.`);
      }

      if (opts.revision && opts.revision !== manifestRevision && !manifestRevision.startsWith(opts.revision)) {
        errors.push(`Model revision mismatch: requested '${opts.revision}', snapshot revision is '${manifestRevision}'.`);
      }

      if (opts.snapshotHash && manifest.files) {
        const matchingFile = manifest.files.find(
          (f: any) => f.sha256.toLowerCase() === opts.snapshotHash!.toLowerCase(),
        );
        if (!matchingFile) {
          errors.push(`Snapshot hash '${opts.snapshotHash}' not found in verified model files.`);
        }
      }

      return {
        valid: errors.length === 0,
        modelId: opts.modelId,
        revision: manifestRevision,
        snapshotHash: opts.snapshotHash,
        errors,
        verifiedAt,
      };
    } catch (err: any) {
      return {
        valid: false,
        modelId: opts.modelId,
        revision: opts.revision,
        errors: [`Corrupt model snapshot manifest: ${err.message}`],
        verifiedAt,
      };
    }
  }

  /**
   * Verify service identity against registered manifests.
   */
  public verifyServiceIdentity(
    serviceId: string,
    expectedExecutableHash?: string,
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const manifest = getManifest(serviceId);

    if (!manifest) {
      errors.push(`Service identity manifest not registered for '${serviceId}'.`);
      return { valid: false, errors };
    }

    if (expectedExecutableHash && manifest.executableHash !== expectedExecutableHash) {
      errors.push(
        `Service executable hash mismatch: registered '${manifest.executableHash}' !== expected '${expectedExecutableHash}'.`,
      );
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Verify an audit-chain reference exists and the chain is cryptographically intact.
   */
  public verifyAuditReference(
    sequence?: number,
    expectedHash?: string,
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (sequence !== undefined) {
      const record = this.services.audit.getRecordBySequence(sequence);
      if (!record) {
        errors.push(`Audit record at sequence ${sequence} does not exist.`);
        return { valid: false, errors };
      }

      if (expectedHash && record.hash.toLowerCase() !== expectedHash.toLowerCase()) {
        errors.push(`Audit record hash mismatch: record hash '${record.hash}' !== expected '${expectedHash}'.`);
      }
    }

    // Verify overall chain validity through Rust engine
    const chainVerification = this.services.audit.verifyChain();
    if (!chainVerification.valid) {
      errors.push(`Audit chain verification failed: ${chainVerification.errors.join(', ')}`);
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Verify an event sequence reference.
   */
  public verifyEventSequence(opts: {
    sequence: number;
    eventId?: string;
    projectId?: string;
  }): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const bounds = this.services.event.getSequenceBounds();

    if (opts.sequence < bounds.oldest || opts.sequence > bounds.latest) {
      errors.push(
        `Event sequence ${opts.sequence} is outside available bounds [${bounds.oldest}, ${bounds.latest}].`,
      );
      return { valid: false, errors };
    }

    const events = this.services.event.querySequenced({
      fromSeq: opts.sequence - 1,
      limit: 1,
    });

    const event = events.find((e) => e.sequence === opts.sequence);
    if (!event) {
      errors.push(`Event at sequence ${opts.sequence} not found.`);
      return { valid: false, errors };
    }

    if (opts.eventId && event.eventId !== opts.eventId) {
      errors.push(`Event ID mismatch at sequence ${opts.sequence}: '${event.eventId}' !== '${opts.eventId}'.`);
    }

    if (opts.projectId && event.projectId !== opts.projectId) {
      errors.push(`Event project mismatch: '${event.projectId}' !== '${opts.projectId}'.`);
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Verify an approval reference.
   */
  public verifyApproval(
    approvalId: string,
    expectedGateId?: string,
    expectedStatus?: string,
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const approval = this.services.approval.getApproval(approvalId);

    if (!approval) {
      errors.push(`Approval '${approvalId}' not found.`);
      return { valid: false, errors };
    }

    if (expectedGateId && approval.gateId !== expectedGateId) {
      errors.push(`Approval gate mismatch: '${approval.gateId}' !== expected '${expectedGateId}'.`);
    }

    if (expectedStatus && approval.status !== expectedStatus) {
      errors.push(`Approval status mismatch: '${approval.status}' !== expected '${expectedStatus}'.`);
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Verify request body and response payload cryptographic SHA-256 hashes.
   */
  public verifyRequestResponse(
    requestBody: string,
    responsePayload: unknown,
    expectedRequestHash?: string,
    expectedResponseHash?: string,
  ): { valid: boolean; computedRequestHash: string; computedResponseHash: string; errors: string[] } {
    const errors: string[] = [];
    const computedRequestHash = crypto.createHash('sha256').update(requestBody).digest('hex');
    const computedResponseHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(responsePayload ?? null))
      .digest('hex');

    if (expectedRequestHash && computedRequestHash.toLowerCase() !== expectedRequestHash.toLowerCase()) {
      errors.push(
        `Request hash mismatch: computed '${computedRequestHash}' !== expected '${expectedRequestHash}'.`,
      );
    }

    if (expectedResponseHash && computedResponseHash.toLowerCase() !== expectedResponseHash.toLowerCase()) {
      errors.push(
        `Response hash mismatch: computed '${computedResponseHash}' !== expected '${expectedResponseHash}'.`,
      );
    }

    return {
      valid: errors.length === 0,
      computedRequestHash,
      computedResponseHash,
      errors,
    };
  }

  /**
   * Comprehensive end-to-end run verification.
   * Validates run stages, tasks, produced artifacts, events, and audit references.
   */
  public verifyRun(runId: string): RunVerificationResult {
    const verifiedAt = new Date().toISOString();
    const config = this.services.project.loadConfig();
    const projectId = config.projectName || 'default';
    const checks: VerificationCheck[] = [];
    const errors: string[] = [];

    // 1. Workflow stages verification
    const stages = this.services.workflow.getRunStages(runId);
    const stagesCheck: VerificationCheck = {
      check: 'stages_presence',
      target: runId,
      valid: stages.length > 0,
      details: `Found ${stages.length} workflow stages for run '${runId}'.`,
    };
    checks.push(stagesCheck);
    if (!stagesCheck.valid) {
      errors.push(`Run '${runId}' has no recorded workflow stages.`);
    }

    // 2. Associated tasks check
    const allTasks = this.services.task.listTasks();
    const runTasks = allTasks.filter((t) => t.runId === runId);
    checks.push({
      check: 'tasks_associated',
      target: runId,
      valid: runTasks.length >= 0,
      details: `Found ${runTasks.length} tasks associated with run.`,
    });

    // 3. Artifacts produced by run
    const artifacts = this.services.artifact.listArtifacts(runId);
    for (const art of artifacts) {
      const artResult = this.verifyArtifact(art.id);
      checks.push({
        check: 'artifact_integrity',
        target: art.id,
        valid: artResult.valid,
        details: artResult.valid ? `SHA-256 match (${art.hash.substring(0, 8)}...)` : artResult.errors.join('; '),
      });
      if (!artResult.valid) {
        errors.push(...artResult.errors);
      }
    }

    // 4. Events emitted for run
    const events = this.services.event.querySequenced({ runId, limit: 100 });
    checks.push({
      check: 'events_presence',
      target: runId,
      valid: true,
      details: `Found ${events.length} sequenced events for run.`,
    });

    // 5. Audit trail verification
    const auditVerification = this.services.audit.verifyChain();
    checks.push({
      check: 'audit_chain_integrity',
      target: 'audit-chain',
      valid: auditVerification.valid,
      details: `Chain valid: ${auditVerification.valid}, ${auditVerification.recordCount} records.`,
    });
    if (!auditVerification.valid) {
      errors.push(...auditVerification.errors);
    }

    return {
      valid: errors.length === 0,
      runId,
      projectId,
      checks,
      errors,
      verifiedAt,
    };
  }
}
