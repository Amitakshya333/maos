import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { getStatusDir, getLogsDir } from '../utils/paths';
import { getQueueCounts, getPendingTasks, getActiveTasks, getDoneTasks } from '../core/queue';
import { readTelemetry, summarizeTelemetry } from '../core/telemetry';
import { loadBrain } from '../core/brain';
import { getRetryQueueStatus, getDeadLetterQueue } from '../core/retry-queue';
import { EventStore } from '../core/event-store';

const INDUSTRIAL_EVIDENCE_EXTENSIONS = new Set(['.txt', '.csv', '.json', '.pdf']);
const INDUSTRIAL_EVIDENCE_MAX_BYTES = 5 * 1024 * 1024;

export interface IndustrialPresentation {
  enabled: boolean;
  provider: string | null;
  model: string | null;
  endpoint: string | null;
  endpointClass: 'local' | 'remote' | 'mixed' | 'unknown';
  allConfiguredProvidersLocal: boolean;
  zeroCloudCost: boolean;
  evidence: {
    enabled: boolean;
    extensions: string[];
    maxBytes: number;
  };
}

// ---- Cached Config Reader ----
// Dashboard polls every 2-3s. Config rarely changes during a session.
// Cache for 5s to avoid repeated readFileSync + JSON.parse on every poll.
let _cachedConfig: any = null;
let _cachedConfigPath: string = '';
let _cachedConfigMtime: number = 0;

function getCachedConfig(cwd: string): any {
  const configPath = path.join(cwd, '.maos', 'maos.config.json');
  try {
    if (!fs.existsSync(configPath)) return {};
    const mtime = fs.statSync(configPath).mtimeMs;
    // Return cache if same file and not modified
    if (_cachedConfig && _cachedConfigPath === configPath && mtime === _cachedConfigMtime) {
      return _cachedConfig;
    }
    _cachedConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    _cachedConfigPath = configPath;
    _cachedConfigMtime = mtime;
    return _cachedConfig;
  } catch {
    return {};
  }
}

export function getDashboardState(cwd: string) {
  const counts = getQueueCounts(cwd);
  const pending = getPendingTasks(cwd);
  const active = getActiveTasks(cwd);
  const done = getDoneTasks(cwd);

  const statusDir = getStatusDir(cwd);
  const agents: Record<string, { status: string; detail: string }> = {};
  if (fs.existsSync(statusDir)) {
    for (const f of fs.readdirSync(statusDir)) {
      if (f.endsWith('.status')) {
        const content = fs.readFileSync(path.join(statusDir, f), 'utf-8').trim();
        const agentId = f.replace('.status', '');
        const [status, ...rest] = content.split(':');
        agents[agentId] = { status: status.trim(), detail: rest.join(':').trim() };
      }
    }
  }

  const config = getCachedConfig(cwd);

  const telemetry = summarizeTelemetry(cwd);
  const telemetryRecords = readTelemetry(cwd);
  const retryQueue = getRetryQueueStatus(cwd);
  const deadLetterQueue = getDeadLetterQueue(cwd);
  const eventStats = new EventStore(cwd).stats();

  return {
    timestamp: new Date().toISOString(),
    project: config.projectName || path.basename(cwd),
    queue: {
      ...counts,
      retry: retryQueue.length,
      failed: deadLetterQueue.length,
    },
    agents,
    agentDefs: config.agents || [],
    telemetry: {
      ...telemetry,
      recent: telemetryRecords.slice(-5),
    },
    events: eventStats,
    tasks: {
      pending: pending.map((t) => ({ id: t.id, description: t.description, agent: t.agent })),
      active: active.map((t) => ({ id: t.id, description: t.description, agent: t.agent })),
      done: done.map((t) => ({ id: t.id, description: t.description, agent: t.agent })),
    },
    industrial: getIndustrialPresentation(config),
    workflow: getWorkflowState(active, agents, telemetryRecords),
  };
}

export function getIndustrialPresentation(config: any): IndustrialPresentation {
  const profile = config?.profile || {};
  const isIndustrialProfile = profile.id === 'industrial' || profile.mode === 'sovereign-local';
  const hasIndustrialEvidenceRoot = typeof profile.evidenceRoot === 'string' && profile.evidenceRoot.length > 0;
  if (!isIndustrialProfile && !hasIndustrialEvidenceRoot) {
    return {
      enabled: false,
      provider: null,
      model: null,
      endpoint: null,
      endpointClass: 'unknown',
      allConfiguredProvidersLocal: false,
      zeroCloudCost: false,
      evidence: {
        enabled: false,
        extensions: Array.from(INDUSTRIAL_EVIDENCE_EXTENSIONS),
        maxBytes: INDUSTRIAL_EVIDENCE_MAX_BYTES,
      },
    };
  }

  const agents: any[] = Array.isArray(config?.agents) ? config.agents : [];
  const providers = config?.providers || {};
  const providerNames = Array.from(new Set(agents.map((a: any) => a.provider).filter(Boolean)));
  const models = Array.from(new Set(agents.map((a: any) => a.model).filter(Boolean)));
  const endpoints = Array.from(
    new Set(
      providerNames
        .map((name: any) => providers[name]?.baseURL)
        .filter((url: any) => typeof url === 'string' && url.length > 0),
    ),
  );

  const allLocal =
    providerNames.length > 0 && providerNames.every((name: any) => isLocalProvider(name, providers[name]?.baseURL));
  const hasRemote = providerNames.some((name: any) => !isLocalProvider(name, providers[name]?.baseURL));
  const endpointClass = allLocal ? 'local' : hasRemote ? 'remote' : providerNames.length === 0 ? 'unknown' : 'mixed';
  const zeroCloudCost =
    providerNames.length > 0 &&
    providerNames.every((name: any) => {
      const p = providers[name];
      return isLocalProvider(name, p?.baseURL) || p?.costPerMillionTokens === 0;
    });

  return {
    enabled: true,
    provider: providerNames.length === 1 ? providerNames[0] : providerNames.join(', ') || null,
    model: models.length === 1 ? models[0] : models.join(', ') || null,
    endpoint: endpoints.length === 1 ? endpoints[0] : endpoints.length > 1 ? 'Multiple configured endpoints' : null,
    endpointClass,
    allConfiguredProvidersLocal: allLocal,
    zeroCloudCost,
    evidence: {
      enabled: config?.industrial?.evidenceUpload !== false,
      extensions: Array.from(INDUSTRIAL_EVIDENCE_EXTENSIONS),
      maxBytes: INDUSTRIAL_EVIDENCE_MAX_BYTES,
    },
  };
}

export function isLocalProvider(provider: string, baseURL?: string): boolean {
  if (provider.toLowerCase() === 'ollama' && !baseURL) return true;
  if (!baseURL) return false;
  try {
    const hostname = new URL(baseURL).hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

export function getWorkflowState(
  activeTasks: any[],
  agentStatuses: Record<string, { status: string; detail: string }>,
  telemetryRecords: any[],
) {
  const task = activeTasks[0] || null;
  const activeAgentId =
    task?.agent && task.agent !== 'AUTO'
      ? task.agent
      : Object.entries(agentStatuses).find(([, state]) => state.status === 'BUSY')?.[0] || null;
  const statusDetail = activeAgentId ? agentStatuses[activeAgentId]?.detail || '' : '';
  const toolMatch = statusDetail.match(/(?:tool|executing)[\s:]+([a-zA-Z0-9_-]+)/i);
  const latestRecord =
    [...telemetryRecords]
      .reverse()
      .find(
        (record) => (task?.id && record.taskId === task.id) || (activeAgentId && record.agentId === activeAgentId),
      ) ||
    telemetryRecords[telemetryRecords.length - 1] ||
    null;

  return {
    activeAgent: activeAgentId,
    currentTask: task ? { id: task.id, description: task.description } : null,
    phase: null,
    tool: toolMatch?.[1] || null,
    tokens: latestRecord?.totalTokens ?? null,
    latencyMs: latestRecord?.latencyMs ?? null,
    metricsTaskId: latestRecord?.taskId ?? null,
  };
}

export async function handleEvidenceUpload(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cwd: string,
): Promise<void> {
  const remoteAddress = req.socket.remoteAddress || '';
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddress)) {
    sendJson(res, 403, { error: 'Evidence intake is available only from this machine.' });
    return;
  }
  const config = getCachedConfig(cwd);
  const industrial = getIndustrialPresentation(config);
  if (!industrial.enabled || !industrial.evidence.enabled) {
    sendJson(res, 404, { error: 'Industrial evidence intake is not enabled.' });
    return;
  }
  if (
    !String(req.headers['content-type'] || '')
      .toLowerCase()
      .startsWith('application/json')
  ) {
    sendJson(res, 415, { error: 'Expected application/json.' });
    return;
  }

  const maxBodyBytes = Math.ceil((INDUSTRIAL_EVIDENCE_MAX_BYTES * 4) / 3) + 4096;
  const chunks: Buffer[] = [];
  let bodyBytes = 0;
  try {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bodyBytes += buffer.length;
      if (bodyBytes > maxBodyBytes) throw new Error('PAYLOAD_TOO_LARGE');
      chunks.push(buffer);
    }

    const payload = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
    const originalName = typeof payload.name === 'string' ? path.basename(payload.name) : '';
    const extension = path.extname(originalName).toLowerCase();
    if (!originalName || !INDUSTRIAL_EVIDENCE_EXTENSIONS.has(extension)) {
      sendJson(res, 400, { error: 'Allowed evidence types: TXT, CSV, JSON, and PDF.' });
      return;
    }
    if (typeof payload.contentBase64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload.contentBase64)) {
      sendJson(res, 400, { error: 'Evidence content is not valid base64.' });
      return;
    }

    const content = Buffer.from(payload.contentBase64, 'base64');
    if (content.length === 0 || content.length > INDUSTRIAL_EVIDENCE_MAX_BYTES) {
      sendJson(res, 413, { error: 'Evidence must be between 1 byte and 5 MB.' });
      return;
    }

    const base =
      path
        .basename(originalName, extension)
        .replace(/[^a-zA-Z0-9._-]+/g, '_')
        .replace(/^\.+/, '')
        .slice(0, 80) || 'evidence';
    const evidenceDir = path.resolve(cwd, '.maos', 'industrial', 'evidence');
    const destination = path.resolve(evidenceDir, Date.now() + '-' + base + extension);
    if (path.dirname(destination) !== evidenceDir) {
      sendJson(res, 400, { error: 'Invalid evidence filename.' });
      return;
    }
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(destination, content, { flag: 'wx' });
    sendJson(res, 201, {
      stored: path.relative(cwd, destination).split(path.sep).join('/'),
      bytes: content.length,
    });
  } catch (error: any) {
    if (error?.message === 'PAYLOAD_TOO_LARGE') {
      sendJson(res, 413, { error: 'Evidence exceeds the 5 MB size limit.' });
      return;
    }
    sendJson(res, 400, { error: 'Could not accept evidence payload.' });
  }
}

export function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

export function getIndustrialChartData(cwd: string) {
  const csvPath = path.join(cwd, 'demo', 'industrial', 'turbine_vibration_log.csv');
  const threshPath = path.join(cwd, 'demo', 'industrial', 'safety_thresholds.json');

  const thresholds = {
    vibration: { warning: 4.5, critical: 7.1 },
    temperature: { warning: 85.0, critical: 95.0 },
  };

  if (fs.existsSync(threshPath)) {
    try {
      const t = JSON.parse(fs.readFileSync(threshPath, 'utf-8'));
      if (t.thresholds?.vibration_rms_mm_s) {
        thresholds.vibration.warning = t.thresholds.vibration_rms_mm_s.warning;
        thresholds.vibration.critical = t.thresholds.vibration_rms_mm_s.critical;
      }
      if (t.thresholds?.bearing_temperature_c) {
        thresholds.temperature.warning = t.thresholds.bearing_temperature_c.warning;
        thresholds.temperature.critical = t.thresholds.bearing_temperature_c.critical;
      }
    } catch {}
  }

  const points: any[] = [];
  const anomalies: any[] = [];
  const rawRows: any[] = [];

  if (fs.existsSync(csvPath)) {
    try {
      const raw = fs.readFileSync(csvPath, 'utf-8');
      const lines = raw
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      if (lines.length > 1) {
        const headers = lines[0].split(',').map((h) => h.trim());
        const vibIdx = headers.indexOf('vibration_rms_mm_s');
        const tempIdx = headers.indexOf('bearing_temperature_c');
        const rpmIdx = headers.indexOf('rpm');
        const loadIdx = headers.indexOf('load_percent');
        const timeIdx = headers.indexOf('timestamp');

        for (let i = 1; i < lines.length; i++) {
          const parts = lines[i].split(',').map((p) => p.trim());
          const vib = parseFloat(parts[vibIdx]);
          const temp = parseFloat(parts[tempIdx]);
          const rpm = parseFloat(parts[rpmIdx]) || 3600;
          const load = parseFloat(parts[loadIdx]) || 85.0;
          const time = parts[timeIdx];
          const row = i;

          let anomaly = false;
          let severity = 'NORMAL';
          let desc = '';

          if (vib >= thresholds.vibration.critical) {
            anomaly = true;
            severity = 'FAIL';
            desc = `Critical vibration ${vib.toFixed(2)} mm/s >= ${thresholds.vibration.critical} mm/s`;
          } else if (temp >= thresholds.temperature.critical) {
            anomaly = true;
            severity = 'FAIL';
            desc = `Critical bearing temp ${temp.toFixed(2)} °C >= ${thresholds.temperature.critical} °C`;
          } else if (vib >= thresholds.vibration.warning) {
            anomaly = true;
            severity = 'WARNING';
            desc = `Elevated vibration ${vib.toFixed(2)} mm/s >= ${thresholds.vibration.warning} mm/s`;
          } else if (temp >= thresholds.temperature.warning) {
            anomaly = true;
            severity = 'WARNING';
            desc = `Elevated bearing temp ${temp.toFixed(2)} °C >= ${thresholds.temperature.warning} °C`;
          }

          const point = { row, time, vib, temp, rpm, load, anomaly, severity, desc };
          rawRows.push(point);
          if (anomaly) {
            anomalies.push(point);
          }
          if (i % 2 === 0 || anomaly) {
            points.push(point);
          }
        }
      }
    } catch {}
  }

  return {
    thresholds,
    totalRows: rawRows.length || 500,
    anomalies,
    points,
    rawRows: rawRows.slice(0, 100),
  };
}

export function getIndustrialReport(cwd: string): { exists: boolean; content: string } {
  const reportPath = path.join(cwd, 'demo', 'industrial', 'generated', 'turbine_t07_safety_report.md');
  if (fs.existsSync(reportPath)) {
    try {
      return { exists: true, content: fs.readFileSync(reportPath, 'utf-8') };
    } catch {}
  }
  return { exists: false, content: '' };
}

export function getRecentLogs(cwd: string): string[] {
  const logFile = path.join(getLogsDir(cwd), 'orchestrator.log');
  if (!fs.existsSync(logFile)) return [];

  try {
    const stat = fs.statSync(logFile);
    // Tail-read: only read the last 32KB to find ~100 lines (avoids loading multi-MB logs)
    const TAIL_BYTES = 32 * 1024;
    if (stat.size <= TAIL_BYTES) {
      // Small file — read it all
      const content = fs.readFileSync(logFile, 'utf-8');
      return content
        .split('\n')
        .filter((l) => l.trim())
        .slice(-100);
    }

    // Large file — read only the tail
    const fd = fs.openSync(logFile, 'r');
    const buffer = Buffer.alloc(TAIL_BYTES);
    fs.readSync(fd, buffer, 0, TAIL_BYTES, stat.size - TAIL_BYTES);
    fs.closeSync(fd);

    const tail = buffer.toString('utf-8');
    // Skip the first (likely partial) line
    const lines = tail.split('\n');
    lines.shift();
    return lines.filter((l) => l.trim()).slice(-100);
  } catch {
    return [];
  }
}

export function readPersistedHealthState(cwd: string): {
  agents: any[];
  summary: any;
  alerts: any[];
  activeIncidents: any[];
  archivedIncidents: any[];
  _source: string;
} {
  const healthFile = path.join(cwd, '.maos', 'health-state.json');
  if (!fs.existsSync(healthFile)) {
    return {
      agents: [],
      summary: null,
      alerts: [],
      activeIncidents: [],
      archivedIncidents: [],
      _source: 'no-state-file',
    };
  }
  try {
    const raw = fs.readFileSync(healthFile, 'utf-8');
    const state = JSON.parse(raw);
    const ageMs = Date.now() - (state.updatedAt || 0);
    return {
      agents: state.agents || [],
      summary: state.summary || null,
      alerts: (state.alerts || []).slice(-10),
      activeIncidents: state.activeIncidents || [],
      archivedIncidents: (state.archivedIncidents || []).slice(-10),
      _source: ageMs > 60_000 ? 'stale-disk' : 'disk',
    };
  } catch {
    return {
      agents: [],
      summary: null,
      alerts: [],
      activeIncidents: [],
      archivedIncidents: [],
      _source: 'parse-error',
    };
  }
}
