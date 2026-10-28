import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import type { IProvider } from '../backends/provider';
import { OpenAIProvider } from '../backends/openai-provider';
import { MetaApiPolicyError } from '../backends/meta-api-policy';
import { runAgent } from '../core/agent-runner';
import type { IndustrialAnalysisAgentRequest, IndustrialAnalysisAgentResult } from '../domain/industrial-analysis-agent';
import type { AuditService } from '../service/audit-service';
import type { EndpointAllowlistService } from '../service/endpoint-allowlist-service';
import { verifyTelemetryAnalysis } from './telemetry-analysis';

export type { IndustrialAnalysisAgentRequest, IndustrialAnalysisAgentResult } from '../domain/industrial-analysis-agent';

const ALLOWED_TOOLS = ['analyze_telemetry_csv', 'task_complete'];
const AGENT_DEADLINE_MS = 60_000;
const AGENT_TIMEOUT_MESSAGE = 'The analysis exceeded its 60-second deadline. No report was accepted; retry when the configured model is responsive.';

const PROMPT = `You are a read-only industrial telemetry analysis assistant. Use only the supplied analyze_telemetry_csv tool and the user-selected source path. After the tool returns, explain only what its deterministic evidence supports. Include the exact analysisId in your summary so the explanation is linked to its evidence. Do not infer causes, prescribe operation, or claim certification. Finish by calling task_complete with that evidence-linked summary.`;

export class IndustrialAnalysisAgentError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'IndustrialAnalysisAgentError';
  }
}

export interface IndustrialAnalysisAgentOptions {
  signal?: AbortSignal;
}

export interface IndustrialAnalysisAgentRuntime {
  provider?: IProvider;
  modelEndpoint?: string;
}

export class IndustrialAnalysisAgentService {
  constructor(
    private readonly provider: IProvider | undefined,
    private readonly modelEndpoint: string | undefined,
    private readonly audit: Pick<AuditService, 'recordAuditEvent'> & Partial<Pick<AuditService, 'getRecords' | 'verifyChain'>>,
    private readonly endpointAllowlist?: EndpointAllowlistService,
    private readonly resolveRuntime?: () => IndustrialAnalysisAgentRuntime,
  ) {}

  private replaceReport(root: string, reportPath: string, value: unknown): void {
    const reportFile = path.join(root, reportPath);
    const temporaryPath = `${reportFile}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporaryPath, reportFile);
    } finally {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    }
  }

  async analyze(
    projectRoot: string,
    input: IndustrialAnalysisAgentRequest,
    options: IndustrialAnalysisAgentOptions = {},
  ): Promise<IndustrialAnalysisAgentResult> {
    if (options.signal?.aborted) throw new IndustrialAnalysisAgentError('AGENT_CANCELLED', 'The analysis request was cancelled.');
    const deadlineAt = Date.now() + AGENT_DEADLINE_MS;
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    options.signal?.addEventListener('abort', forwardAbort, { once: true });
    if (options.signal?.aborted) forwardAbort();
    let timedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new IndustrialAnalysisAgentError('AGENT_TIMEOUT', AGENT_TIMEOUT_MESSAGE));
      }, AGENT_DEADLINE_MS);
    });
    try {
      return await Promise.race([
        this.analyzeWithinDeadline(projectRoot, input, { signal: controller.signal, deadlineAt }),
        timeout,
      ]);
    } catch (error) {
      if (timedOut || Date.now() >= deadlineAt) {
        throw new IndustrialAnalysisAgentError('AGENT_TIMEOUT', AGENT_TIMEOUT_MESSAGE);
      }
      throw error;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      options.signal?.removeEventListener('abort', forwardAbort);
    }
  }

  private async analyzeWithinDeadline(
    projectRoot: string,
    input: IndustrialAnalysisAgentRequest,
    options: IndustrialAnalysisAgentOptions & { deadlineAt: number },
  ): Promise<IndustrialAnalysisAgentResult> {
    const assertBeforeDeadline = () => {
      if (Date.now() >= options.deadlineAt) {
        throw new IndustrialAnalysisAgentError('AGENT_TIMEOUT', AGENT_TIMEOUT_MESSAGE);
      }
    };
    let provider = this.provider;
    let modelEndpoint = this.modelEndpoint;
    if (this.resolveRuntime) {
      try {
        ({ provider, modelEndpoint } = this.resolveRuntime());
      } catch (error) {
        if (error instanceof IndustrialAnalysisAgentError) throw error;
        if (error instanceof MetaApiPolicyError) {
          const code = error.code === 'META_API_OPT_IN_REQUIRED'
            ? 'MODEL_ENDPOINT_BLOCKED'
            : error.code === 'MODEL_CREDENTIAL_MISSING' ? error.code : 'PROJECT_CONFIG_INVALID';
          throw new IndustrialAnalysisAgentError(code, error.message);
        }
        const detail = error instanceof Error ? error.message : String(error);
        throw new IndustrialAnalysisAgentError(
          'PROJECT_CONFIG_INVALID',
          `Unable to load the configured Industrial analysis model. Check the project's MAOS configuration and permissions, then retry. ${detail}`,
        );
      }
    }
    if (!provider || !modelEndpoint) {
      throw new IndustrialAnalysisAgentError('MODEL_NOT_CONFIGURED', 'Configure ANALYST_AGENT and an approved local loopback model endpoint, or explicitly enable the exact Meta Model API model and endpoint.');
    }
    if (typeof input.request !== 'string' || input.request.trim().length === 0 || input.request.length > 4000) {
      throw new IndustrialAnalysisAgentError('INVALID_REQUEST', 'request must contain 1 to 4000 characters.');
    }
    if (typeof input.sourcePath !== 'string' || input.sourcePath.length === 0 || path.isAbsolute(input.sourcePath)) {
      throw new IndustrialAnalysisAgentError('INVALID_SOURCE_PATH', 'sourcePath must be a relative project path.');
    }

    let root: string;
    let selectedSource: string;
    try {
      root = fs.realpathSync(projectRoot);
      const candidate = path.resolve(root, input.sourcePath);
      const relative = path.relative(root, candidate);
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error('sourcePath must identify a file inside the project.');
      }
      selectedSource = fs.realpathSync(candidate);
      const realRelative = path.relative(root, selectedSource);
      if (!realRelative || realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
        throw new Error('sourcePath must resolve to a file inside the project.');
      }
      const stat = fs.statSync(selectedSource);
      if (!stat.isFile() || path.extname(selectedSource).toLowerCase() !== '.csv' || stat.size < 1 || stat.size > 5 * 1024 * 1024) {
        throw new Error('sourcePath must identify a project-local CSV between 1 byte and 5 MB.');
      }
      selectedSource = realRelative.split(path.sep).join('/');
    } catch (error) {
      throw new IndustrialAnalysisAgentError('INVALID_SOURCE_PATH', error instanceof Error ? error.message : String(error));
    }

    let modelUrl: URL;
    try {
      modelUrl = new URL(modelEndpoint);
    } catch {
      throw new IndustrialAnalysisAgentError('MODEL_ENDPOINT_BLOCKED', 'The configured model endpoint URL is invalid.');
    }
    const metaEndpointAllowed = provider instanceof OpenAIProvider && provider.isMetaApi && provider.baseURL === modelEndpoint;
    const loopbackEndpointAllowed = modelUrl.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(modelUrl.hostname.toLowerCase()) &&
      !modelUrl.username && !modelUrl.password && !modelUrl.search && !modelUrl.hash;
    if (!metaEndpointAllowed && !loopbackEndpointAllowed) {
      throw new IndustrialAnalysisAgentError('MODEL_ENDPOINT_BLOCKED', 'Only a credential-free HTTP loopback endpoint or a provider approved by the shared Meta API policy is allowed.');
    }
    // The one explicit hosted exception is config-bound to Meta's exact HTTPS URL and model.
    if (this.endpointAllowlist && !metaEndpointAllowed) {
      const port = modelUrl.port ? parseInt(modelUrl.port, 10) : 80;
      const validation = this.endpointAllowlist.validateSocketTarget({
        protocol: 'tcp',
        direction: 'connect',
        host: modelUrl.hostname,
        port,
        serviceId: 'industrial_analysis_agent',
      });
      if (!validation.allowed) {
        throw new IndustrialAnalysisAgentError('MODEL_ENDPOINT_BLOCKED', `The model endpoint is blocked by policy: ${validation.reason}`);
      }
    }

    const toolResults: string[] = [];
    const runId = randomUUID();
    const run = await runAgent(
      provider,
      {
        id: 'industrial-analysis-agent',
        role: 'industrial telemetry analysis assistant',
        provider: provider.name,
        model: provider.model,
        capabilities: ['deterministic telemetry analysis'],
        scope: [selectedSource],
        allowedTools: ALLOWED_TOOLS,
        maxIterations: 4,
        promptOverride: PROMPT,
      },
      {
        id: `industrial-analysis-${runId}`,
        description: `User request: ${input.request.trim()}\nAnalyze only this user-selected project file: ${selectedSource}`,
        branch: 'local',
      },
      root,
      0,
      undefined,
      (toolName, result) => {
        if (toolName === 'analyze_telemetry_csv') toolResults.push(result);
      },
      {
        signal: options.signal,
        deadlineAt: options.deadlineAt,
        maxTokens: 256,
        maxProviderRetries: 0,
        maxGenerationAttempts: 4,
        allowPartialSuccess: false,
        toolCallLimits: { analyze_telemetry_csv: 1 },
      },
    );

    if (run.error === 'TIMEOUT' || Date.now() >= options.deadlineAt) {
      throw new IndustrialAnalysisAgentError('AGENT_TIMEOUT', AGENT_TIMEOUT_MESSAGE);
    }
    if (options.signal?.aborted || run.error === 'ABORTED') {
      throw new IndustrialAnalysisAgentError('AGENT_CANCELLED', 'The analysis request was cancelled.');
    }
    if (!run.success) {
      if (run.error?.includes('PROVIDER_CREDENTIAL_CONTAMINATION')) {
        throw new IndustrialAnalysisAgentError(
          'PROVIDER_CREDENTIAL_CONTAMINATION',
          'The provider response contained the configured credential in tool-call metadata. Execution was blocked and no report was accepted.',
        );
      }
      throw new IndustrialAnalysisAgentError('AGENT_EXECUTION_FAILED', run.error || run.summary);
    }
    if (toolResults.length !== 1) {
      throw new IndustrialAnalysisAgentError('ANALYSIS_TOOL_NOT_USED', 'The model did not request exactly one allowed telemetry analysis tool call.');
    }

    let evidence: any;
    try {
      evidence = JSON.parse(toolResults[0]);
    } catch {
      throw new IndustrialAnalysisAgentError('INVALID_TOOL_RESULT', 'The telemetry analysis tool returned invalid evidence data.');
    }
    if (!evidence?.ok || typeof evidence.analysisId !== 'string' || typeof evidence.receiptPath !== 'string') {
      throw new IndustrialAnalysisAgentError('ANALYSIS_TOOL_FAILED', evidence?.message || 'The telemetry analysis tool did not produce evidence.');
    }
    if (typeof run.summary !== 'string' || !run.summary.includes(evidence.analysisId)) {
      throw new IndustrialAnalysisAgentError('EVIDENCE_REFERENCE_REQUIRED', 'The model explanation did not cite its analysisId.');
    }

    const verification = verifyTelemetryAnalysis(root, evidence.analysisId);
    if (
      !verification.valid ||
      verification.sourceSha256 !== evidence.source?.sha256 ||
      verification.sourcePath !== evidence.source?.evidencePath ||
      verification.receiptSha256 !== evidence.receiptSha256
    ) {
      throw new IndustrialAnalysisAgentError('EVIDENCE_VERIFICATION_FAILED', 'Persisted telemetry evidence did not verify against its source and rules.');
    }

    assertBeforeDeadline();
    if (options.signal?.aborted) throw new IndustrialAnalysisAgentError('AGENT_CANCELLED', 'The analysis request was cancelled.');
    const reportedModel = run.reportedModel || null;
    const report = {
      schemaVersion: 1,
      status: 'pending_audit',
      acceptance: 'unaccepted',
      runId,
      analysisId: evidence.analysisId,
      createdAt: new Date().toISOString(),
      model: { provider: provider.name, requested: provider.model, reported: reportedModel },
      source: evidence.source,
      numericFindings: {
        status: 'replay-matched',
        verificationMethod: verification.method,
        result: evidence.result,
        receiptPath: evidence.receiptPath,
        receiptSha256: evidence.receiptSha256,
        rulesetSha256: evidence.rulesetSha256,
      },
      explanation: { status: 'unverified', text: run.summary },
      verification: {
        method: verification.method,
        sourceHashMatched: verification.sourceHashMatched,
        rulesetHashMatched: verification.rulesetHashMatched,
        recomputationMatched: verification.recomputationMatched,
      },
    };
    const reportRoot = path.join(root, '.maos', 'industrial', 'telemetry-analyses', 'agent-reports');
    let reportPath: string;
    let reportSha256: string;
    let acceptedReport: Record<string, unknown>;
    try {
      fs.mkdirSync(reportRoot, { recursive: true });
      const realReportRoot = fs.realpathSync(reportRoot);
      const reportRelative = path.relative(root, realReportRoot);
      if (!reportRelative || reportRelative === '..' || reportRelative.startsWith(`..${path.sep}`) || path.isAbsolute(reportRelative)) {
        throw new Error('Agent report directory resolves outside the project.');
      }
      const reportFile = path.join(realReportRoot, `${evidence.analysisId}.json`);
      const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, 'utf8');
      assertBeforeDeadline();
      fs.writeFileSync(reportFile, reportBytes, { flag: 'wx', mode: 0o600 });
      reportPath = path.relative(root, reportFile).split(path.sep).join('/');
      acceptedReport = { ...report, status: 'completed', acceptance: 'accepted' };
      const acceptedBytes = Buffer.from(`${JSON.stringify(acceptedReport, null, 2)}\n`, 'utf8');
      reportSha256 = createHash('sha256').update(acceptedBytes).digest('hex');
    } catch (error) {
      throw new IndustrialAnalysisAgentError('AGENT_REPORT_FAILED', error instanceof Error ? error.message : String(error));
    }

    try {
      assertBeforeDeadline();
      this.replaceReport(root, reportPath, acceptedReport);
    } catch (error) {
      try {
        this.replaceReport(root, reportPath, {
          ...report,
          status: 'failed',
          acceptance: 'unaccepted',
          failure: { code: error instanceof IndustrialAnalysisAgentError ? error.code : 'REPORT_REPLACEMENT_FAILED' },
        });
      } catch {
        // The original pending report is still explicitly unaccepted.
      }
      if (error instanceof IndustrialAnalysisAgentError && error.code === 'AGENT_TIMEOUT') throw error;
      throw new IndustrialAnalysisAgentError(
        'AGENT_REPORT_ACCEPTANCE_FAILED',
        `The report remains unaccepted because its final replacement failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    let auditRecord;
    try {
      assertBeforeDeadline();
      auditRecord = this.audit.recordAuditEvent({
        source: 'industrial-analysis-agent',
        category: 'stage',
        data: {
          event: 'INDUSTRIAL_ANALYSIS_AGENT_COMPLETED',
          runId,
          analysisId: evidence.analysisId,
          sourceSha256: verification.sourceSha256,
          receiptSha256: verification.receiptSha256,
          reportSha256,
          outcome: 'completed',
        },
      });
    } catch (error) {
      const persisted = this.audit.getRecords?.().filter((record) => {
        const data = record.data as Record<string, unknown>;
        return data.event === 'INDUSTRIAL_ANALYSIS_AGENT_COMPLETED' && data.runId === runId &&
          data.analysisId === evidence.analysisId && data.reportSha256 === reportSha256 && data.outcome === 'completed';
      }) || [];
      const chainValid = this.audit.verifyChain?.().valid ?? false;
      if (persisted.length === 1 && chainValid) auditRecord = persisted[0];
      else {
        const timeoutError = error instanceof IndustrialAnalysisAgentError && error.code === 'AGENT_TIMEOUT';
        try {
          this.replaceReport(root, reportPath, {
            ...report,
            status: 'failed',
            acceptance: 'unaccepted',
            failure: { code: timeoutError ? 'AGENT_TIMEOUT' : 'AUDIT_PERSISTENCE_FAILED' },
          });
        } catch {
          // The accepted file remains unusable without a matching valid audit record.
        }
        if (timeoutError) throw error;
        throw new IndustrialAnalysisAgentError(
          'AUDIT_PERSISTENCE_FAILED',
          `The diagnostic report was retained as failed/unaccepted because its completion audit event could not be verified: ${error instanceof Error ? error.message : String(error)}. Restore audit-chain health and retry; this run was not accepted as successful.`,
        );
      }
    }

    return {
      runId,
      provider: provider.name,
      requestedModel: provider.model,
      reportedModel,
      execution: 'provider-tool-call',
      explanation: run.summary,
      reportPath,
      reportSha256,
      audit: { sequence: auditRecord.sequence, hash: auditRecord.hash },
      evidence: {
        analysisId: evidence.analysisId,
        receiptPath: evidence.receiptPath,
        receiptSha256: evidence.receiptSha256,
        source: evidence.source,
        rulesetSha256: evidence.rulesetSha256,
        disclaimer: evidence.disclaimer,
        result: evidence.result,
        verification: {
          valid: true,
          method: verification.method,
          sourceHashMatched: true,
          rulesetHashMatched: true,
          recomputationMatched: true,
        },
      },
    };
  }
}
