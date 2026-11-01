import fs from 'node:fs';
import path from 'node:path';
import type { AuditService } from './audit-service';
import type { EndpointAllowlistService } from './endpoint-allowlist-service';
import type { Project } from '../domain/schemas';
import type { ChatMessage } from '../backends/provider';
import {
  BASETEN_API_BASE_URL,
  BASETEN_API_KEY_ENV,
  BASETEN_API_MODEL,
  ProviderApiPolicyError,
} from '../backends/meta-api-policy';
import { OpenAIProvider } from '../backends/openai-provider';
import {
  TelemetryAnalysisReceipt,
  TelemetryMetrics,
  analyzeTelemetryCsv,
  loadTelemetryDemoThresholds,
} from '../industrial/telemetry-analysis';

export interface RingAskRequest {
  question: string;
  analysisId?: string;
}

export type RingSourceKind = 'sop' | 'incident' | 'telemetry' | 'config';

export interface RingSource {
  kind: RingSourceKind;
  label: string;
  path: string;
}

export interface RingDeterministic {
  attempted: boolean;
  verdict?: string;
  overallRms?: number;
  analysisId?: string;
}

export interface RingAskResult {
  mode: 'hosted' | 'evidence-only';
  providerName?: string;
  modelId?: string;
  servedModelId?: string;
  answer: string;
  sources: RingSource[];
  deterministic: RingDeterministic;
  refusalTest: { prepared: boolean };
}

export interface RingInferenceServiceOptions {
  projectRoot: string;
  auditService?: AuditService;
  endpointAllowlist?: EndpointAllowlistService;
  loadProjectConfig?: () => Project | undefined;
  fetch?: typeof globalThis.fetch;
}

export class RingInferenceService {
  private readonly projectRoot: string;
  private readonly auditService?: AuditService;
  private readonly endpointAllowlist?: EndpointAllowlistService;
  private readonly loadProjectConfig: () => Project | undefined;
  private readonly fetchImpl?: typeof globalThis.fetch;

  constructor(options: RingInferenceServiceOptions) {
    this.projectRoot = path.resolve(options.projectRoot);
    this.auditService = options.auditService;
    this.endpointAllowlist = options.endpointAllowlist;
    this.fetchImpl = options.fetch;
    this.loadProjectConfig =
      options.loadProjectConfig ||
      (() => {
        const configPath = path.resolve(this.projectRoot, '.maos', 'maos.config.json');
        if (fs.existsSync(configPath)) {
          try {
            return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
          } catch {
            return undefined;
          }
        }
        return undefined;
      });
  }

  /**
   * Evaluates whether the Baseten hosted provider is armed according to shared policy:
   * - basetenApiEnabled === true
   * - baseURL === BASETEN_API_BASE_URL
   * - model === BASETEN_API_MODEL
   * - process.env[BASETEN_API_KEY_ENV] is non-empty
   *
   * If opt-in is enabled but configuration is invalid, mirrors meta-api-policy validation
   * error codes (e.g. BASETEN_API_CONFIGURATION_INVALID).
   */
  private checkBasetenArming(): {
    isArmed: boolean;
    providerConfig?: Record<string, unknown>;
    apiKey?: string;
  } {
    const projectConfig = this.loadProjectConfig();
    const baseten = projectConfig?.providers?.baseten as Record<string, unknown> | undefined;

    if (!baseten || baseten.basetenApiEnabled !== true) {
      return { isArmed: false };
    }

    // Explicit opt-in present: enforce exact endpoint and model configuration
    if (baseten.baseURL !== BASETEN_API_BASE_URL) {
      throw new ProviderApiPolicyError(
        'BASETEN_API_CONFIGURATION_INVALID',
        `Baseten Model API is limited to provider "baseten", ${BASETEN_API_BASE_URL}, and model ${BASETEN_API_MODEL}.`,
      );
    }

    const requestedModel =
      (typeof baseten.model === 'string' && baseten.model) ||
      projectConfig?.agents?.find((a) => a.provider === 'baseten')?.model ||
      BASETEN_API_MODEL;

    if (requestedModel !== BASETEN_API_MODEL) {
      throw new ProviderApiPolicyError(
        'BASETEN_API_CONFIGURATION_INVALID',
        `Baseten Model API is limited to provider "baseten", ${BASETEN_API_BASE_URL}, and model ${BASETEN_API_MODEL}.`,
      );
    }

    const apiKey = process.env[BASETEN_API_KEY_ENV];
    if (!apiKey || !apiKey.trim()) {
      // Key missing -> not armed (falls back to evidence-only)
      return { isArmed: false, providerConfig: baseten };
    }

    return { isArmed: true, providerConfig: baseten, apiKey: apiKey.trim() };
  }

  /**
   * Deterministic prefetch: loads demo SOP, incident note, thresholds config, and
   * recomputes/retrieves the deterministic telemetry verdict for the given analysisId
   * or the bundled turbine vibration sample.
   */
  private prefetchEvidence(analysisId?: string): {
    sources: RingSource[];
    verdict?: string;
    overallRms?: number;
    resolvedAnalysisId?: string;
    telemetryMetrics?: TelemetryMetrics;
    sopText: string;
    incidentText: string;
  } {
    const sources: RingSource[] = [];

    // 1. Demo SOP
    const sopRel = 'demo/industrial/sop_turbine_vibration_monitoring.md';
    const sopFull = path.resolve(this.projectRoot, sopRel);
    let sopText = '';
    if (fs.existsSync(sopFull)) {
      sopText = fs.readFileSync(sopFull, 'utf-8');
      sources.push({
        kind: 'sop',
        label: 'Turbine Vibration & Temperature Safety Audit SOP',
        path: sopRel,
      });
    }

    // 2. Incident Note / Maintenance Report
    const incidentRel = 'demo/industrial/maintenance_report.txt';
    const incidentFull = path.resolve(this.projectRoot, incidentRel);
    let incidentText = '';
    if (fs.existsSync(incidentFull)) {
      incidentText = fs.readFileSync(incidentFull, 'utf-8');
      sources.push({
        kind: 'incident',
        label: 'Turbine T-07 Maintenance Report',
        path: incidentRel,
      });
    }

    // 3. Safety Thresholds Config
    const configRel = 'demo/industrial/safety_thresholds.json';
    const configFull = path.resolve(this.projectRoot, configRel);
    if (fs.existsSync(configFull)) {
      sources.push({
        kind: 'config',
        label: 'Safety Thresholds Configuration',
        path: configRel,
      });
    }

    // 4. Telemetry Analysis Verdict
    let verdict: string | undefined;
    let overallRms: number | undefined;
    let resolvedAnalysisId: string | undefined;
    let telemetryPath = 'demo/industrial/turbine_vibration_log.csv';
    let telemetryMetrics: TelemetryMetrics | undefined;

    if (analysisId) {
      const receiptPath = path.resolve(
        this.projectRoot,
        '.maos',
        'industrial',
        'telemetry-analyses',
        `${analysisId}.json`,
      );
      if (fs.existsSync(receiptPath)) {
        try {
          const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf-8')) as TelemetryAnalysisReceipt;
          if (receipt.result) {
            verdict = receipt.result.verdict;
            overallRms = receipt.result.overallVibrationRms;
            telemetryMetrics = receipt.result;
            resolvedAnalysisId = analysisId;
            if (receipt.source?.relativePath) {
              telemetryPath = receipt.source.relativePath;
            }
          }
        } catch {
          // Non-fatal: fallback to bundled sample
        }
      }
    }

    if (!telemetryMetrics) {
      const bundledCsvPath = path.resolve(this.projectRoot, 'demo/industrial/turbine_vibration_log.csv');
      if (fs.existsSync(bundledCsvPath)) {
        try {
          const thresholds = loadTelemetryDemoThresholds(this.projectRoot);
          const csvBuffer = fs.readFileSync(bundledCsvPath);
          telemetryMetrics = analyzeTelemetryCsv(csvBuffer, thresholds);
          verdict = telemetryMetrics.verdict;
          overallRms = telemetryMetrics.overallVibrationRms;
          telemetryPath = 'demo/industrial/turbine_vibration_log.csv';
        } catch {
          // If analysis fails, verdict remains undefined
        }
      }
    }

    sources.push({
      kind: 'telemetry',
      label: resolvedAnalysisId ? `Telemetry Analysis (${resolvedAnalysisId})` : 'Turbine Vibration Log (Bundled Sample)',
      path: telemetryPath,
    });

    return {
      sources,
      verdict,
      overallRms,
      resolvedAnalysisId,
      telemetryMetrics,
      sopText,
      incidentText,
    };
  }

  /**
   * Assembles a composed deterministic summary from prefetched evidence sources and
   * engine calculations with zero model wording.
   */
  private buildDeterministicSummary(evidence: ReturnType<typeof this.prefetchEvidence>): string {
    const { verdict, overallRms, telemetryMetrics } = evidence;
    const findingsList = telemetryMetrics && telemetryMetrics.findings.length > 0
      ? telemetryMetrics.findings
          .map((f) => `- Row ${f.row} [${f.timestamp || 'no-time'}]: ${f.field} = ${f.value} ${f.unit} (threshold: ${f.threshold} ${f.unit}) -> ${f.severity}`)
          .join('\n')
      : 'No threshold violations recorded.';

    const lines = [
      '### Deterministic Evidence Summary',
      'Asset: Steam Turbine T-07, drive-end bearing assembly',
      'Standard Operating Procedure: SOP-TURBINE-VIB-DEMO-V1 (Turbine Vibration & Temperature Safety Audit)',
      'Maintenance Record: MR-T07-2026-0822',
      '',
      '### Maintenance Observations',
      '- Light intermittent metallic sound near drive-end bearing housing.',
      '- Drive-end bearing housing felt warmer than non-drive-end housing.',
      '- Small dark lubricant residue below drive-end seal.',
      '- Two vibration alarms reported during preceding shift.',
      '',
      '### Telemetry Engine Verdict (ISO 10816-3)',
      `Engineering Verdict: ${verdict ?? 'UNAVAILABLE'}`,
      `Overall Vibration RMS: ${overallRms !== undefined ? `${overallRms.toFixed(3)} mm/s` : 'UNAVAILABLE'}`,
      telemetryMetrics ? `Peak Vibration: ${telemetryMetrics.peakVibration.toFixed(2)} mm/s` : '',
      telemetryMetrics ? `Peak Temperature: ${telemetryMetrics.peakTemperature.toFixed(1)} °C` : '',
      telemetryMetrics ? `Violations Count: ${telemetryMetrics.warningCount} Warnings / ${telemetryMetrics.criticalCount} Critical` : '',
      '',
      '### Specific Threshold Breaches',
      findingsList,
      '',
      'Regulatory Notice: Synthetic offline demonstration benchmark only. Negative clearance. Not a certified standard.',
    ];

    return lines.filter(Boolean).join('\n');
  }

  /**
   * Main entrypoint for Ring inquiry.
   */
  async ask(input: RingAskRequest): Promise<RingAskResult> {
    const question = input.question?.trim();
    if (!question) {
      throw new Error('RING_ASK_INVALID: question is required and must be a non-empty string.');
    }

    // Step 2: Deterministic prefetch always attempted
    const evidence = this.prefetchEvidence(input.analysisId);
    const deterministicSummary = this.buildDeterministicSummary(evidence);

    const deterministicObj: RingDeterministic = {
      attempted: true,
      verdict: evidence.verdict,
      overallRms: evidence.overallRms,
      analysisId: evidence.resolvedAnalysisId,
    };

    // Step 1: Check arming policy
    const arming = this.checkBasetenArming();

    // Step 3: Not armed -> return evidence-only result
    if (!arming.isArmed) {
      return {
        mode: 'evidence-only',
        answer: deterministicSummary,
        sources: evidence.sources,
        deterministic: deterministicObj,
        refusalTest: { prepared: false },
      };
    }

    // Step 4: Hosted path (armed only)
    try {
      const provider = new OpenAIProvider({
        name: 'baseten',
        apiKey: arming.apiKey!,
        model: BASETEN_API_MODEL,
        baseURL: BASETEN_API_BASE_URL,
        basetenApiEnabled: true,
        fetch: this.fetchImpl,
      });

      // Prompt strictly includes ONLY deterministic summary and the user's question.
      // NEVER includes raw telemetry CSV rows.
      const messages: ChatMessage[] = [
        {
          role: 'system',
          content: 'You are the MAOS Industrial Ring Assistant. Answer the question using ONLY the provided deterministic engineering summary. Never contradict or invent engineering data.',
        },
        {
          role: 'user',
          content: `Deterministic Engineering Context:\n${deterministicSummary}\n\nQuestion:\n${question}`,
        },
      ];

      const response = await provider.generate(messages);
      const answer = typeof response.content === 'string' && response.content.trim()
        ? response.content
        : deterministicSummary;

      // Return servedModelId only if echoed by provider response
      const servedModelId = response.reportedModel && response.reportedModel.trim()
        ? response.reportedModel
        : undefined;

      return {
        mode: 'hosted',
        providerName: 'baseten',
        modelId: BASETEN_API_MODEL,
        servedModelId,
        answer,
        sources: evidence.sources,
        deterministic: deterministicObj,
        refusalTest: { prepared: false },
      };
    } catch (err: unknown) {
      // Never throw in a way that takes Ring down: fallback to evidence-only on inference error
      const message = err instanceof Error ? err.message : String(err);
      if (this.auditService) {
        this.auditService.recordAuditEvent({
          category: 'warning',
          source: 'ring-inference',
          data: {
            event: 'RING_HOSTED_INFERENCE_FAILED',
            error: message,
          },
        });
      }

      return {
        mode: 'evidence-only',
        modelId: BASETEN_API_MODEL,
        answer: `${deterministicSummary}\n\n[Hosted inference unavailable: ${message}]`,
        sources: evidence.sources,
        deterministic: deterministicObj,
        refusalTest: { prepared: false },
      };
    }
  }
}
