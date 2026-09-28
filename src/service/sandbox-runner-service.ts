/**
 * MAOS Industrial — Sandbox Runner Application Service (F8-02)
 *
 * Coordinates authoritative container execution:
 *   1. Enforces caller authorization (approved agents only).
 *   2. Enforces non-root execution and verified image digest matching.
 *   3. Enforces fail-closed blocking of host executor in Industrial mode.
 *   4. Performs static analysis of script for safety violations.
 *   5. Guarantees durable mutation idempotency and conflict rejection.
 *   6. Safely stages temporary workspace directories with traversal defense.
 *   7. Executes containers via low-level ContainerRunner without shell interpolation.
 *   8. Durably records privacy-preserving audit events in AuditService.
 *   9. Guarantees workspace and container cleanup in finally blocks.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  AUTHORIZED_CODE_SANDBOX_AGENTS,
  assertSafeWorkspaceMount,
  computeExecutionInputHash,
  computeExecutionOutputHash,
  ContainerRunOptions,
  CONTAINER_RUNNER_ERROR_CODES,
  ContainerRunnerError,
  SandboxExecutionRequest,
  SandboxExecutionResult,
  validateSandboxRunInput,
} from '../domain/sandbox-run';
import {
  assertIndustrialNoHostExecutor,
  SandboxError,
} from '../domain/sandbox';
import { SandboxImageService } from './sandbox-image-service';
import { AuditService } from './audit-service';
import { DurableIdempotencyStore } from '../core/idempotency-store';
import { ContainerRunner, RawContainerRunResult } from '../industrial/container-runner';
import type { IndustrialFirewallRequirementService } from './industrial-firewall-requirement-service';

export interface SandboxRunnerServiceOptions {
  imageService?: SandboxImageService;
  auditService?: AuditService;
  idempotencyStore?: DurableIdempotencyStore;
  containerRunner?: ContainerRunner;
  industrialFirewallRequirement?: IndustrialFirewallRequirementService;
  enforceFirewallRequirement?: boolean;
  profileMode?: string;
  defaultTimeoutMs?: number;
  defaultMaxOutputBytes?: number;
}

export interface SandboxRunExecutionOptions {
  idempotencyKey?: string;
  abortSignal?: AbortSignal;
  observedDigest?: string;
  executorType?: 'host' | 'sandbox';
  enforceFirewallRequirement?: boolean;
}

export class SandboxRunnerService {
  private readonly projectRoot: string;
  private readonly imageService: SandboxImageService;
  private readonly auditService: AuditService;
  private readonly idempotencyStore: DurableIdempotencyStore;
  private readonly containerRunner: ContainerRunner;
  private readonly profileMode: string;
  private readonly stagingBaseDir: string;
  private industrialFirewallRequirement?: IndustrialFirewallRequirementService;
  private enforceFirewallRequirement: boolean;

  constructor(
    projectRoot: string,
    options: SandboxRunnerServiceOptions = {},
  ) {
    this.projectRoot = path.resolve(projectRoot);
    this.imageService = options.imageService || new SandboxImageService(this.projectRoot);
    this.auditService = options.auditService || new AuditService(this.projectRoot);
    this.idempotencyStore = options.idempotencyStore || new DurableIdempotencyStore(this.projectRoot);
    this.containerRunner = options.containerRunner || new ContainerRunner();
    this.profileMode = options.profileMode || 'industrial';
    this.stagingBaseDir = path.join(this.projectRoot, '.maos', 'sandbox', 'runs');
    this.industrialFirewallRequirement = options.industrialFirewallRequirement;
    this.enforceFirewallRequirement = options.enforceFirewallRequirement ?? false;
  }

  setIndustrialFirewallRequirement(service: IndustrialFirewallRequirementService, enforce: boolean = false): void {
    this.industrialFirewallRequirement = service;
    this.enforceFirewallRequirement = enforce;
  }

  getProjectRoot(): string {
    return this.projectRoot;
  }

  getImageService(): SandboxImageService {
    return this.imageService;
  }

  getAuditService(): AuditService {
    return this.auditService;
  }

  getIdempotencyStore(): DurableIdempotencyStore {
    return this.idempotencyStore;
  }

  getContainerRunner(): ContainerRunner {
    return this.containerRunner;
  }

  /**
   * Prepares and stages container execution with all security gates and invariants.
   */
  private prepareExecution(
    rawInput: unknown,
    options: SandboxRunExecutionOptions = {},
  ): {
    req: SandboxExecutionRequest;
    manifest: any;
    inputHash: string;
    runId: string;
    stagedDir: string;
    stagedFiles: string[];
    runOptions: ContainerRunOptions;
    cachedResult?: SandboxExecutionResult;
  } {
    // 1. Enforce host executor prohibition in industrial mode
    const requestedExecutorType = options.executorType || (rawInput as any)?.executorType;
    if (requestedExecutorType === 'host' || (requestedExecutorType && requestedExecutorType !== 'sandbox')) {
      try {
        assertIndustrialNoHostExecutor(requestedExecutorType, this.profileMode);
      } catch (err: any) {
        throw new ContainerRunnerError(
          CONTAINER_RUNNER_ERROR_CODES.HOST_EXECUTOR_FORBIDDEN_IN_INDUSTRIAL,
          err.message,
          { executorType: requestedExecutorType, profileMode: this.profileMode },
        );
      }
    }

    // 2. Validate input payload
    const validation = validateSandboxRunInput(rawInput);
    if (!validation.valid || !validation.request) {
      throw new ContainerRunnerError(
        CONTAINER_RUNNER_ERROR_CODES.INVALID_INPUT,
        `Invalid sandbox execution request: ${validation.errors.join('; ')}`,
        { errors: validation.errors },
      );
    }
    const req: SandboxExecutionRequest = validation.request;

    // 3. Authorization check
    if (req.callerIdentity?.agentId) {
      const agentId = req.callerIdentity.agentId.toLowerCase();
      const isAuthorized = AUTHORIZED_CODE_SANDBOX_AGENTS.some(
        (a) => a.toLowerCase() === agentId,
      );
      if (!isAuthorized) {
        throw new ContainerRunnerError(
          CONTAINER_RUNNER_ERROR_CODES.UNAUTHORIZED_AGENT,
          `Agent '${req.callerIdentity.agentId}' is not authorized to execute code in sandbox. Approved agents: ${AUTHORIZED_CODE_SANDBOX_AGENTS.join(', ')}`,
          { agentId: req.callerIdentity.agentId, approved: AUTHORIZED_CODE_SANDBOX_AGENTS },
        );
      }
    }

    // 4. Confinement & Cross-Project checks
    if (req.workspacePath) {
      const candidateWorkspace = path.resolve(req.workspacePath);

      // Check cross-project boundaries using exact path segments, not substring
      // matching (for example, project-alpha must not match project-alpha-evil).
      // Perform this classification before the existence check so a forged or
      // missing cross-project path still receives the precise boundary error.
      if (req.projectId) {
        const projectRoots = [
          path.join(this.projectRoot, 'projects'),
          path.join(this.projectRoot, '.maos', 'projects'),
        ];
        for (const projectsRoot of projectRoots) {
          const relativeToProjects = path.relative(projectsRoot, candidateWorkspace);
          if (relativeToProjects === '' || relativeToProjects.startsWith('..') || path.isAbsolute(relativeToProjects)) {
            continue;
          }
          const [workspaceProjectId] = relativeToProjects.split(path.sep);
          if (workspaceProjectId && workspaceProjectId !== req.projectId) {
            throw new ContainerRunnerError(
              CONTAINER_RUNNER_ERROR_CODES.CROSS_PROJECT_WORKSPACE_FORBIDDEN,
              `Cross-project workspace access forbidden. Project '${req.projectId}' cannot access workspace '${req.workspacePath}'.`,
              { projectId: req.projectId, workspacePath: req.workspacePath, workspaceProjectId },
            );
          }
        }
      }

      assertSafeWorkspaceMount(req.workspacePath, this.projectRoot);
    }

    // 5. Load and verify sandbox image manifest
    let manifest;
    try {
      manifest = this.imageService.getManifest();
    } catch (err: any) {
      if (err instanceof SandboxError) {
        throw new ContainerRunnerError(
          err.code as any,
          err.message,
          err.detail,
        );
      }
      throw new ContainerRunnerError(
        CONTAINER_RUNNER_ERROR_CODES.SANDBOX_IMAGE_MISSING,
        `Failed to load sandbox manifest: ${err.message}`,
        { error: err.message },
      );
    }

    // Independently observe the digest Docker resolves for the image tag. The
    // tag is used only for inspection; execution below is digest-bound.
    const taggedImageRef = `${manifest.imageName}:${manifest.tag}`;
    if (options.observedDigest) {
      const suppliedDigest = options.observedDigest.toLowerCase().trim();
      if (suppliedDigest !== manifest.imageDigest.toLowerCase().trim()) {
        throw new ContainerRunnerError(
          CONTAINER_RUNNER_ERROR_CODES.IMAGE_DIGEST_MISMATCH,
          `Container image digest '${options.observedDigest}' does not match pinned manifest digest '${manifest.imageDigest}'`,
          { expected: manifest.imageDigest, actual: options.observedDigest },
        );
      }
    }

    let observedRuntimeDigest: string;
    try {
      observedRuntimeDigest = this.containerRunner.inspectImageDigest(taggedImageRef);
    } catch (err: any) {
      if (err instanceof ContainerRunnerError) throw err;
      throw new ContainerRunnerError(
        CONTAINER_RUNNER_ERROR_CODES.IMAGE_DIGEST_OBSERVATION_FAILED,
        `Unable to independently observe the sandbox image digest: ${err.message}`,
        { imageRef: taggedImageRef },
      );
    }

    if (observedRuntimeDigest !== manifest.imageDigest.toLowerCase().trim()) {
      throw new ContainerRunnerError(
        CONTAINER_RUNNER_ERROR_CODES.IMAGE_DIGEST_MISMATCH,
        `Docker resolved '${taggedImageRef}' to '${observedRuntimeDigest}', not pinned digest '${manifest.imageDigest}'.`,
        { expected: manifest.imageDigest, actual: observedRuntimeDigest, imageRef: taggedImageRef },
      );
    }

    // 6. Static script inspection for safety violations
    const scriptInspection = this.imageService.verifyScriptSafety(req.script);
    if (!scriptInspection.safe) {
      const violation = scriptInspection.violations[0];
      throw new ContainerRunnerError(
        (violation.type as any) || CONTAINER_RUNNER_ERROR_CODES.SECURITY_POLICY_VIOLATION,
        `Script execution blocked by sandbox safety policy: ${violation.detail}`,
        { violations: scriptInspection.violations },
      );
    }

    // 7. Canonical input hash computation & Idempotency claim
    const inputHash = computeExecutionInputHash(req.script, req.args, req.files);

    if (options.idempotencyKey) {
      const claim = this.idempotencyStore.claim({
        key: options.idempotencyKey,
        requestHash: inputHash,
        operation: 'sandbox.execute',
        projectId: req.projectId || 'default',
        authContext: req.callerIdentity?.agentId,
      });

      if (claim.outcome === 'replay') {
        return {
          req,
          manifest,
          inputHash,
          runId: '',
          stagedDir: '',
          stagedFiles: [],
          runOptions: null as any,
          cachedResult: claim.record.responsePayload as SandboxExecutionResult,
        };
      }
      if (claim.outcome === 'conflict') {
        throw new ContainerRunnerError(
          CONTAINER_RUNNER_ERROR_CODES.IDEMPOTENCY_CONFLICT,
          claim.message,
          { key: options.idempotencyKey, reason: claim.reason },
        );
      }
      if (claim.outcome === 'in_progress') {
        throw new ContainerRunnerError(
          CONTAINER_RUNNER_ERROR_CODES.IDEMPOTENCY_CONFLICT,
          claim.message,
          { key: options.idempotencyKey, reason: claim.reason },
        );
      }
    }

    // 8. Workspace staging
    const runId = crypto.randomUUID();
    const stagedDir = path.join(this.stagingBaseDir, runId);
    fs.mkdirSync(stagedDir, { recursive: true });

    const stagedFiles: string[] = ['main.py'];

    try {
      // Write script to main.py
      fs.writeFileSync(path.join(stagedDir, 'main.py'), req.script, 'utf8');

      // Write auxiliary files
      if (req.files) {
        for (const [relPath, content] of Object.entries(req.files)) {
          const filePath = path.resolve(stagedDir, relPath);
          const relCheck = path.relative(stagedDir, filePath);
          if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
            throw new ContainerRunnerError(
              CONTAINER_RUNNER_ERROR_CODES.PROJECT_ESCAPE_DETECTED,
              `Staged file path '${relPath}' escapes workspace root`,
              { relPath },
            );
          }
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          fs.writeFileSync(filePath, content, 'utf8');
          stagedFiles.push(relPath);
        }
      }
    } catch (err: any) {
      this.cleanupStagedDir(stagedDir);
      throw err;
    }

    const containerName = `maos-sandbox-${runId}`;
    const runOptions: ContainerRunOptions = {
      containerName,
      imageRef: `${manifest.imageName}@${observedRuntimeDigest}`,
      stagedWorkspacePath: stagedDir,
      scriptFileName: 'main.py',
      scriptArgs: req.args,
      limits: {
        maxMemoryMb: manifest.limits.maxMemoryMb,
        maxCpuCores: manifest.limits.maxCpuCores,
        maxExecutionTimeMs: Math.min(
          req.timeoutMs || 30000,
          manifest.limits.maxExecutionTimeMs || 30000,
        ),
        maxOutputBytes: Math.min(
          req.maxOutputBytes || 50000,
          manifest.limits.maxOutputBytes || 50000,
        ),
        maxProcesses: 32,
      },
    };

    return {
      req,
      manifest,
      inputHash,
      runId,
      stagedDir,
      stagedFiles,
      runOptions,
    };
  }

  /**
   * Completes execution lifecycle: calculates output hash, emits audit record,
   * completes idempotency record, and returns typed result.
   */
  private completeExecution(
    runId: string,
    req: SandboxExecutionRequest,
    manifest: any,
    inputHash: string,
    stagedFiles: string[],
    rawResult: RawContainerRunResult,
    idempotencyKey?: string,
  ): SandboxExecutionResult {
    // 10. Canonical output hash computation
    const outputHash = computeExecutionOutputHash(
      rawResult.status,
      rawResult.exitCode,
      rawResult.stdout,
      rawResult.stderr,
    );

    // 11. Record immutable audit record
    let auditEventId: string | undefined;
    try {
      const auditRes = this.auditService.recordAuditEvent({
        source: 'sandbox-runner',
        category: 'tool',
        data: {
          runId,
          agentId: req.callerIdentity?.agentId,
          taskId: req.callerIdentity?.taskId,
          imageDigest: manifest.imageDigest,
          inputHash,
          outputHash,
          status: rawResult.status,
          exitCode: rawResult.exitCode,
          durationMs: rawResult.durationMs,
          containerName: rawResult.containerName,
          stagedFilesCount: stagedFiles.length,
        },
      });
      auditEventId = auditRes.hash;
    } catch {
      // Audit append failure must not mask execution result
    }

    const result: SandboxExecutionResult = {
      ok: rawResult.status === 'COMPLETED' && rawResult.exitCode === 0,
      exitCode: rawResult.exitCode,
      status: rawResult.status,
      stdout: rawResult.stdout,
      stderr: rawResult.stderr,
      durationMs: rawResult.durationMs,
      containerName: rawResult.containerName,
      imageDigest: manifest.imageDigest,
      inputHash,
      outputHash,
      stagedFiles: Object.freeze(stagedFiles),
      auditEventId,
    };

    // 12. Complete idempotency record
    if (idempotencyKey) {
      this.idempotencyStore.complete(idempotencyKey, 200, result);
    }

    return result;
  }

  private cleanupStagedDir(stagedDir: string): void {
    try {
      if (stagedDir && fs.existsSync(stagedDir)) {
        fs.rmSync(stagedDir, { recursive: true, force: true });
      }
    } catch {
      // best effort directory cleanup
    }
  }

  /**
   * Authoritative asynchronous execution gateway for sandbox scripts.
   */
  async execute(
    rawInput: unknown,
    options: SandboxRunExecutionOptions = {},
  ): Promise<SandboxExecutionResult> {
    if (
      this.profileMode === 'industrial' &&
      (options.enforceFirewallRequirement || this.enforceFirewallRequirement) &&
      this.industrialFirewallRequirement
    ) {
      const projectId = (rawInput as any)?.projectId || 'default';
      await this.industrialFirewallRequirement.assertSandboxExecutionAllowed(projectId);
    }

    const prep = this.prepareExecution(rawInput, options);
    if (prep.cachedResult) {
      return prep.cachedResult;
    }

    try {
      const rawResult = await this.containerRunner.run(
        prep.runOptions,
        options.abortSignal,
      );

      return this.completeExecution(
        prep.runId,
        prep.req,
        prep.manifest,
        prep.inputHash,
        prep.stagedFiles,
        rawResult,
        options.idempotencyKey,
      );
    } finally {
      this.cleanupStagedDir(prep.stagedDir);
    }
  }

  /**
   * Authoritative synchronous execution gateway for sandbox scripts.
   */
  executeSync(
    rawInput: unknown,
    options: SandboxRunExecutionOptions = {},
  ): SandboxExecutionResult {
    const prep = this.prepareExecution(rawInput, options);
    if (prep.cachedResult) {
      return prep.cachedResult;
    }

    try {
      const rawResult = this.containerRunner.runSync(prep.runOptions);

      return this.completeExecution(
        prep.runId,
        prep.req,
        prep.manifest,
        prep.inputHash,
        prep.stagedFiles,
        rawResult,
        options.idempotencyKey,
      );
    } finally {
      this.cleanupStagedDir(prep.stagedDir);
    }
  }
}
