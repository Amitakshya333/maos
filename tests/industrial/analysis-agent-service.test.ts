import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuditEventParams, AuditRecord } from '../../src/domain';
import type { IProvider, ChatMessage, ProviderResponse, ToolDef } from '../../src/backends/provider';
import { IndustrialAnalysisAgentError, IndustrialAnalysisAgentService } from '../../src/industrial/analysis-agent-service';
import type { AuditService } from '../../src/service/audit-service';

const ROOT = path.resolve(__dirname, '../..');
const projects: string[] = [];

function createProject(): { root: string; sourcePath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-analysis-agent-'));
  projects.push(root);
  fs.mkdirSync(path.join(root, 'demo/industrial'), { recursive: true });
  fs.copyFileSync(
    path.join(ROOT, 'demo/industrial/safety_thresholds.json'),
    path.join(root, 'demo/industrial/safety_thresholds.json'),
  );
  fs.mkdirSync(path.join(root, 'held-out'), { recursive: true });
  const sourcePath = 'held-out/rotor-test-07.csv';
  fs.writeFileSync(
    path.join(root, sourcePath),
    'timestamp,vibration_rms_mm_s,bearing_temperature_c\n2026-01-01T00:00:00Z,2.1,70\n2026-01-01T00:01:00Z,7.4,96\n',
  );
  return { root, sourcePath };
}

function response(overrides: Partial<ProviderResponse>): ProviderResponse {
  return {
    content: null,
    toolCalls: [],
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    model: 'mock-analysis-model',
    latencyMs: 1,
    finishReason: 'tool_calls',
    ...overrides,
  };
}

class MockAnalysisProvider implements IProvider {
  readonly name = 'mock-transport';
  readonly model = 'mock-analysis-model';
  readonly messages: ChatMessage[][] = [];
  readonly toolSchemas: ToolDef[][] = [];
  private calls = 0;

  constructor(
    private readonly sourcePath: string,
    private readonly skipAnalysis = false,
    private readonly beforeCompletion?: (analysisId: string) => void,
    private readonly providerReportedModel: string | null = 'mock-analysis-model',
  ) {}

  async generate(messages: ChatMessage[], tools?: ToolDef[]): Promise<ProviderResponse> {
    this.messages.push(messages);
    this.toolSchemas.push(tools || []);
    this.calls += 1;
    if (this.calls === 1 && !this.skipAnalysis) {
      return response({
        reportedModel: this.providerReportedModel || undefined,
        toolCalls: [{
          id: 'call_analysis_1',
          type: 'function',
          function: { name: 'analyze_telemetry_csv', arguments: JSON.stringify({ sourcePath: this.sourcePath }) },
        }],
      });
    }

    const toolResult = [...messages].reverse().find((message) => message.role === 'tool' && message.name === 'analyze_telemetry_csv');
    const analysis = toolResult ? JSON.parse(toolResult.content || '{}') : undefined;
    if (analysis?.analysisId) this.beforeCompletion?.(analysis.analysisId);
    return response({
      reportedModel: this.providerReportedModel || undefined,
      toolCalls: [{
        id: 'call_complete_1',
        type: 'function',
        function: {
          name: 'task_complete',
          arguments: JSON.stringify({ summary: `The deterministic checks found ${analysis?.result?.verdict || 'no result'}; receipt ${analysis?.analysisId || 'missing'}.` }),
        },
      }],
    });
  }
}

function createAuditRecorder(records: AuditEventParams[] = []): Pick<AuditService, 'recordAuditEvent'> {
  return {
    recordAuditEvent(params) {
      records.push(params);
      return {
        schemaVersion: 1,
        sequence: records.length - 1,
        previous_hash: '',
        timestamp: new Date().toISOString(),
        source: params.source,
        category: params.category,
        data: params.data,
        hash: 'a'.repeat(64),
      } satisfies AuditRecord;
    },
  };
}

afterEach(() => {
  for (const root of projects.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Industrial analysis agent shared-provider path', () => {
  it('lets the mock model request the allowlisted deterministic tool and cite its same-implementation replay evidence', async () => {
    const project = createProject();
    const provider = new MockAnalysisProvider(project.sourcePath);
    const auditEvents: AuditEventParams[] = [];
    const service = new IndustrialAnalysisAgentService(provider, 'http://127.0.0.1:11434/v1', createAuditRecorder(auditEvents));

    const result = await service.analyze(project.root, {
      request: 'Check the peak telemetry against the demonstration thresholds and explain the evidence.',
      sourcePath: project.sourcePath,
    });

    expect(provider.toolSchemas[0].map((tool) => tool.function.name)).toEqual(['analyze_telemetry_csv', 'task_complete']);
    expect(provider.messages[0].some((message) => message.role === 'user' && message.content?.includes('Check the peak telemetry'))).toBe(true);
    expect(provider.messages[1].some((message) => message.role === 'tool' && message.name === 'analyze_telemetry_csv')).toBe(true);
    expect(result.execution).toBe('provider-tool-call');
    expect(result.provider).toBe('mock-transport');
    expect(result.requestedModel).toBe('mock-analysis-model');
    expect(result.reportedModel).toBe('mock-analysis-model');
    expect(result.reportPath).toContain(result.evidence.analysisId);
    const report = JSON.parse(fs.readFileSync(path.join(project.root, result.reportPath), 'utf8'));
    expect(report).toMatchObject({ status: 'completed', acceptance: 'accepted' });
    expect(report.numericFindings.status).toBe('replay-matched');
    expect(report.numericFindings.verificationMethod).toBe('same-implementation-replay');
    expect(report.numericFindings.receiptPath).toBe(result.evidence.receiptPath);
    expect(report.runId).toBe(result.runId);
    expect(report.model).toEqual({ provider: 'mock-transport', requested: 'mock-analysis-model', reported: 'mock-analysis-model' });
    expect(report.verification.method).toBe('same-implementation-replay');
    expect(report.explanation.status).toBe('unverified');
    expect(report.explanation.text).toBe(result.explanation);
    expect(result.evidence.source.selectedPath).toBe('held-out/rotor-test-07.csv');
    expect(result.evidence.result).toMatchObject({ rowsAnalyzed: 2, verdict: 'CRITICAL', criticalCount: 2 });
    expect(result.explanation).toContain(result.evidence.analysisId);
    expect(result.evidence.verification).toEqual({
      valid: true,
      method: 'same-implementation-replay',
      sourceHashMatched: true,
      rulesetHashMatched: true,
      recomputationMatched: true,
    });
    expect(result.audit).toEqual({ sequence: 0, hash: 'a'.repeat(64) });
    expect(auditEvents[0].data).toMatchObject({
      event: 'INDUSTRIAL_ANALYSIS_AGENT_COMPLETED',
      runId: result.runId,
      analysisId: result.evidence.analysisId,
      sourceSha256: result.evidence.source.sha256,
      receiptSha256: result.evidence.receiptSha256,
      reportSha256: result.reportSha256,
      outcome: 'completed',
    });
    expect(JSON.stringify(auditEvents[0].data)).not.toContain('Check the peak telemetry');
    expect(fs.existsSync(path.join(project.root, result.evidence.receiptPath))).toBe(true);
    expect(createHash('sha256').update(fs.readFileSync(path.join(project.root, result.reportPath))).digest('hex')).toBe(result.reportSha256);
  });

  it.each([
    ['provider omitted identity', null, null],
    ['provider reported a different identity', 'provider-alias-v9', 'provider-alias-v9'],
  ])('keeps requested and provider-reported identity separate when %s', async (_label, providerId, expectedReported) => {
    const project = createProject();
    const provider = new MockAnalysisProvider(project.sourcePath, false, undefined, providerId as string | null);
    const service = new IndustrialAnalysisAgentService(provider, 'http://127.0.0.1:11434/v1', createAuditRecorder());
    const result = await service.analyze(project.root, { request: 'Analyze this held-out CSV.', sourcePath: project.sourcePath });
    const report = JSON.parse(fs.readFileSync(path.join(project.root, result.reportPath), 'utf8'));
    expect(result.requestedModel).toBe('mock-analysis-model');
    expect(result.reportedModel).toBe(expectedReported);
    expect(report.model).toMatchObject({ requested: 'mock-analysis-model', reported: expectedReported });
  });

  it('retains an audit-failed report as unaccepted and a retry creates a separate accepted run', async () => {
    const project = createProject();
    const failedAudit: Pick<AuditService, 'recordAuditEvent'> = {
      recordAuditEvent() { throw new Error('simulated audit persistence failure'); },
    };
    const first = new IndustrialAnalysisAgentService(
      new MockAnalysisProvider(project.sourcePath),
      'http://127.0.0.1:11434/v1',
      failedAudit,
    );

    await expect(first.analyze(project.root, { request: 'Check this held-out CSV.', sourcePath: project.sourcePath }))
      .rejects.toMatchObject<Partial<IndustrialAnalysisAgentError>>({ code: 'AUDIT_PERSISTENCE_FAILED' });
    const reportRoot = path.join(project.root, '.maos', 'industrial', 'telemetry-analyses', 'agent-reports');
    const failedFiles = fs.readdirSync(reportRoot).filter((name) => name.endsWith('.json'));
    expect(failedFiles).toHaveLength(1);
    const failedReport = JSON.parse(fs.readFileSync(path.join(reportRoot, failedFiles[0]), 'utf8'));
    expect(failedReport).toMatchObject({
      status: 'failed',
      acceptance: 'unaccepted',
      failure: { code: 'AUDIT_PERSISTENCE_FAILED' },
    });

    const retry = new IndustrialAnalysisAgentService(
      new MockAnalysisProvider(project.sourcePath),
      'http://127.0.0.1:11434/v1',
      createAuditRecorder(),
    );
    const retried = await retry.analyze(project.root, { request: 'Retry this held-out CSV.', sourcePath: project.sourcePath });
    const retriedReport = JSON.parse(fs.readFileSync(path.join(project.root, retried.reportPath), 'utf8'));
    expect(retried.runId).not.toBe(failedReport.runId);
    expect(retried.evidence.analysisId).not.toBe(failedReport.analysisId);
    expect(retriedReport).toMatchObject({ status: 'completed', acceptance: 'accepted' });
    expect(fs.readdirSync(reportRoot).filter((name) => name.endsWith('.json'))).toHaveLength(2);
  });

  it('retains a failed/unaccepted report when its accepted replacement fails', async () => {
    const project = createProject();
    const auditEvents: AuditEventParams[] = [];
    const audit = createAuditRecorder(auditEvents);
    let rejectedAcceptedReplacement = false;
    const originalReplace = (IndustrialAnalysisAgentService.prototype as any).replaceReport;
    const replaceSpy = vi.spyOn(IndustrialAnalysisAgentService.prototype as any, 'replaceReport').mockImplementation(function(this: unknown, root: string, reportPath: string, value: any) {
      if (!rejectedAcceptedReplacement && value?.status === 'completed' && value?.acceptance === 'accepted') {
        rejectedAcceptedReplacement = true;
        throw new Error('simulated final report replacement failure');
      }
      return originalReplace.call(this, root, reportPath, value);
    });
    try {
      const service = new IndustrialAnalysisAgentService(
        new MockAnalysisProvider(project.sourcePath),
        'http://127.0.0.1:11434/v1',
        audit,
      );
      await expect(service.analyze(project.root, { request: 'Analyze this held-out CSV.', sourcePath: project.sourcePath }))
        .rejects.toMatchObject<Partial<IndustrialAnalysisAgentError>>({ code: 'AGENT_REPORT_ACCEPTANCE_FAILED' });
      const reportRoot = path.join(project.root, '.maos', 'industrial', 'telemetry-analyses', 'agent-reports');
      const reportFiles = fs.readdirSync(reportRoot).filter((name) => name.endsWith('.json'));
      expect(reportFiles).toHaveLength(1);
      expect(JSON.parse(fs.readFileSync(path.join(reportRoot, reportFiles[0]), 'utf8'))).toMatchObject({
        status: 'failed', acceptance: 'unaccepted', failure: { code: 'REPORT_REPLACEMENT_FAILED' },
      });
      expect(auditEvents.some((event) => event.data.event === 'INDUSTRIAL_ANALYSIS_AGENT_COMPLETED')).toBe(false);
    } finally {
      replaceSpy.mockRestore();
    }
  });

  it('rejects a receipt changed after the model tool captured its hash', async () => {
    const project = createProject();
    const provider = new MockAnalysisProvider(project.sourcePath, false, (analysisId) => {
      const receiptPath = path.join(project.root, '.maos', 'industrial', 'telemetry-analyses', `${analysisId}.json`);
      const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
      receipt.createdAt = '2026-10-27T00:00:00.000Z';
      fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
    });
    const service = new IndustrialAnalysisAgentService(provider, 'http://127.0.0.1:11434/v1', createAuditRecorder());

    await expect(service.analyze(project.root, {
      request: 'Check the peak telemetry against the demonstration thresholds.',
      sourcePath: project.sourcePath,
    })).rejects.toMatchObject<Partial<IndustrialAnalysisAgentError>>({ code: 'EVIDENCE_VERIFICATION_FAILED' });
  });

  it('rejects traversal before contacting the model', async () => {
    const project = createProject();
    const provider = new MockAnalysisProvider(project.sourcePath);
    const service = new IndustrialAnalysisAgentService(provider, 'http://127.0.0.1:11434/v1', createAuditRecorder());

    await expect(service.analyze(project.root, { request: 'Analyze this file.', sourcePath: '../outside.csv' }))
      .rejects.toMatchObject<Partial<IndustrialAnalysisAgentError>>({ code: 'INVALID_SOURCE_PATH' });
    expect(provider.messages).toHaveLength(0);
  });

  it('does not report success when the model skips the analysis tool', async () => {
    const project = createProject();
    const provider = new MockAnalysisProvider(project.sourcePath, true);
    const service = new IndustrialAnalysisAgentService(provider, 'http://127.0.0.1:11434/v1', createAuditRecorder());

    await expect(service.analyze(project.root, { request: 'Analyze this file.', sourcePath: project.sourcePath }))
      .rejects.toMatchObject<Partial<IndustrialAnalysisAgentError>>({ code: 'ANALYSIS_TOOL_NOT_USED' });
  });

});
