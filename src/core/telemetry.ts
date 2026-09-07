import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../utils/logger';

const logger = createLogger();

/**
 * MAOS Telemetry System
 *
 * Append-only JSONL log of every task execution.
 * Drives the "self-improving routing" pitch — we track which
 * models perform best on which task types.
 *
 * File: .maos/telemetry/runs.jsonl
 */

export interface TelemetryRecord {
  timestamp: string;
  taskId: string;
  agentId: string;
  provider: string;
  model: string;
  routingStrategy: string;
  routingScore: number;
  capabilities: string[];
  complexity: string;
  category: string;
  iterations: number;
  totalTokens: number;
  promptTokens?: number;
  completionTokens?: number;
  costUSD: number;
  latencyMs: number;
  success: boolean;
  error?: string;
  filesChanged: string[];
  summary: string;
  taskResult?: 'success' | 'partial_success' | 'failed' | 'no_mutation';
  exitCode?: number;
}

export interface TelemetrySummary {
  totalRuns: number;
  successRate: number;
  totalTokens: number;
  totalCostUSD: number;
  avgLatencyMs: number;
  avgIterations: number;
  byAgent: Record<
    string,
    {
      runs: number;
      successRate: number;
      avgTokens: number;
      avgCost: number;
      avgLatency: number;
    }
  >;
  byProvider: Record<
    string,
    {
      runs: number;
      successRate: number;
      totalCost: number;
    }
  >;
  topCapabilities: Array<{ capability: string; count: number; successRate: number }>;
}

/**
 * Get the telemetry file path.
 */
function getTelemetryPath(projectRoot: string): string {
  return path.join(projectRoot, '.maos', 'telemetry', 'runs.jsonl');
}

/**
 * Ensure the telemetry directory exists.
 */
function ensureTelemetryDir(projectRoot: string): void {
  const dir = path.join(projectRoot, '.maos', 'telemetry');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Record a telemetry event for a completed task.
 */
export function recordTelemetry(projectRoot: string, record: TelemetryRecord): void {
  try {
    ensureTelemetryDir(projectRoot);
    const filePath = getTelemetryPath(projectRoot);
    const line = JSON.stringify(record) + '\n';
    fs.appendFileSync(filePath, line, 'utf-8');
    logger.debug('TELEMETRY', `Recorded: ${record.taskId} → ${record.agentId} (${record.success ? '✅' : '❌'})`);
  } catch (err: any) {
    logger.warn('TELEMETRY', `Failed to write telemetry: ${err.message}`);
  }
}

/**
 * Read all telemetry records from the JSONL file.
 */
export function readTelemetry(projectRoot: string): TelemetryRecord[] {
  const filePath = getTelemetryPath(projectRoot);
  if (!fs.existsSync(filePath)) return [];

  const lines = fs
    .readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter((l) => l.trim().length > 0);

  const records: TelemetryRecord[] = [];
  for (const line of lines) {
    try {
      records.push(JSON.parse(line));
    } catch {
      // Skip malformed lines
    }
  }
  return records;
}

/**
 * Generate a summary dashboard from telemetry data.
 */
export function summarizeTelemetry(projectRoot: string): TelemetrySummary {
  const records = readTelemetry(projectRoot);

  if (records.length === 0) {
    return {
      totalRuns: 0,
      successRate: 0,
      totalTokens: 0,
      totalCostUSD: 0,
      avgLatencyMs: 0,
      avgIterations: 0,
      byAgent: {},
      byProvider: {},
      topCapabilities: [],
    };
  }

  const successes = records.filter((r) => r.success).length;
  const totalTokens = records.reduce((sum, r) => sum + r.totalTokens, 0);
  const totalCost = records.reduce((sum, r) => sum + r.costUSD, 0);
  const totalLatency = records.reduce((sum, r) => sum + r.latencyMs, 0);
  const totalIterations = records.reduce((sum, r) => sum + r.iterations, 0);

  // By agent
  const byAgent: TelemetrySummary['byAgent'] = {};
  for (const r of records) {
    if (!byAgent[r.agentId]) {
      byAgent[r.agentId] = { runs: 0, successRate: 0, avgTokens: 0, avgCost: 0, avgLatency: 0 };
    }
    byAgent[r.agentId].runs++;
  }
  for (const agentId of Object.keys(byAgent)) {
    const agentRecords = records.filter((r) => r.agentId === agentId);
    const agentSuccesses = agentRecords.filter((r) => r.success).length;
    byAgent[agentId].successRate = agentSuccesses / agentRecords.length;
    byAgent[agentId].avgTokens = agentRecords.reduce((s, r) => s + r.totalTokens, 0) / agentRecords.length;
    byAgent[agentId].avgCost = agentRecords.reduce((s, r) => s + r.costUSD, 0) / agentRecords.length;
    byAgent[agentId].avgLatency = agentRecords.reduce((s, r) => s + r.latencyMs, 0) / agentRecords.length;
  }

  // By provider
  const byProvider: TelemetrySummary['byProvider'] = {};
  for (const r of records) {
    if (!byProvider[r.provider]) {
      byProvider[r.provider] = { runs: 0, successRate: 0, totalCost: 0 };
    }
    byProvider[r.provider].runs++;
    byProvider[r.provider].totalCost += r.costUSD;
  }
  for (const prov of Object.keys(byProvider)) {
    const provRecords = records.filter((r) => r.provider === prov);
    byProvider[prov].successRate = provRecords.filter((r) => r.success).length / provRecords.length;
  }

  // Top capabilities
  const capCount: Record<string, { total: number; success: number }> = {};
  for (const r of records) {
    for (const cap of r.capabilities) {
      if (!capCount[cap]) capCount[cap] = { total: 0, success: 0 };
      capCount[cap].total++;
      if (r.success) capCount[cap].success++;
    }
  }
  const topCapabilities = Object.entries(capCount)
    .map(([capability, stats]) => ({
      capability,
      count: stats.total,
      successRate: stats.success / stats.total,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    totalRuns: records.length,
    successRate: successes / records.length,
    totalTokens,
    totalCostUSD: totalCost,
    avgLatencyMs: totalLatency / records.length,
    avgIterations: totalIterations / records.length,
    byAgent,
    byProvider,
    topCapabilities,
  };
}
