/**
 * MAOS Dashboard — HTTP server for the mission control web UI.
 *
 * Split into modules for maintainability:
 *   - dashboard-state.ts  — Data fetching, API helpers, evidence handling
 *   - dashboard-template.ts — HTML/CSS/JS template generation
 */
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { isMaosInitialized } from '../utils/paths';
import { getHealthMonitor } from '../core/health-monitor';
import {
  getDashboardState,
  getIndustrialChartData,
  getIndustrialReport,
  getRecentLogs,
  handleEvidenceUpload,
  handleTelemetryAnalysis,
  readPersistedHealthState,
} from './dashboard-state';
import { getDashboardHTML } from './dashboard-template';
import { createServiceContainer, ServiceContainer } from '../service';
import type { WorkflowStage } from '../domain/schemas';
import { RestApiRouter } from '../api';
import { SECURITY_HEADERS, CONTENT_SECURITY_POLICY } from '../api/security-headers';
import { executeJudgedRun } from '../industrial/judged-run';

const PORT = 3847;

function getLegacyCorsHeaders(req: http.IncomingMessage): Record<string, string> {
  const origin = req.headers['origin'];
  const headers: Record<string, string> = {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
  };
  if (typeof origin === 'string' && origin.trim() && origin !== 'null' && !origin.startsWith('file:')) {
    try {
      const url = new URL(origin);
      const host = url.hostname.toLowerCase();
      if (host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]') {
        headers['Access-Control-Allow-Origin'] = origin.trim();
        headers['Vary'] = 'Origin';
      }
    } catch {
      // ignore invalid origin
    }
  }
  return headers;
}

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'application/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.png':
      return 'image/png';
    case '.ico':
      return 'image/x-icon';
    default:
      return 'application/octet-stream';
  }
}

export function serveSpaOrFallback(req: http.IncomingMessage, res: http.ServerResponse, cwd: string): void {
  const guiRoots = [
    path.resolve(cwd, 'dist', 'gui'),
    path.resolve(cwd, 'gui', 'dist'),
    path.resolve(__dirname, '..', '..', 'dist', 'gui'),
    path.resolve(__dirname, '..', '..', 'gui', 'dist'),
  ];
  const guiRoot = guiRoots.find((r) => fs.existsSync(path.join(r, 'index.html')));

  if (!guiRoot) {
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/html; charset=utf-8',
    });
    res.end(getDashboardHTML());
    return;
  }

  const rawUrl = req.url || '/';
  if (rawUrl.includes('..') || rawUrl.toLowerCase().includes('%2e%2e')) {
    res.writeHead(403, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/plain',
    });
    res.end('Forbidden: Path traversal attempt rejected.');
    return;
  }

  const urlPath = rawUrl.split('?')[0];
  const reqRelative = urlPath.startsWith('/') ? urlPath.slice(1) : urlPath;
  const targetFile = path.resolve(guiRoot, reqRelative);

  // Security: prevent path traversal outside guiRoot
  if (!targetFile.startsWith(guiRoot)) {
    res.writeHead(403, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/plain',
    });
    res.end('Forbidden: Access outside GUI root is denied.');
    return;
  }

  if (reqRelative && fs.existsSync(targetFile) && fs.statSync(targetFile).isFile()) {
    const isAsset = reqRelative.startsWith('assets/');
    res.writeHead(200, {
      'Content-Type': getMimeType(targetFile),
      'Content-Security-Policy': CONTENT_SECURITY_POLICY,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Permissions-Policy':
        'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
      'Cache-Control': isAsset
        ? 'public, max-age=31536000, immutable'
        : 'no-store',
    });
    res.end(fs.readFileSync(targetFile));
    return;
  }

  // SPA fallback for all client routes (e.g. /chat, /tasks, etc.)
  const indexHtml = path.join(guiRoot, 'index.html');
  if (fs.existsSync(indexHtml)) {
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/html; charset=utf-8',
    });
    res.end(fs.readFileSync(indexHtml));
    return;
  }

  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/html; charset=utf-8',
  });
  res.end(getDashboardHTML());
}

export interface IndustrialTriggerResult {
  readonly success: boolean;
  readonly runId: string;
  readonly stageId: string;
  readonly stage: WorkflowStage;
  readonly task?: Record<string, unknown>;
  readonly links: {
    readonly run: string;
    readonly stage: string;
    readonly stages: string;
    readonly cockpit: string;
  };
}

export function handleIndustrialTrigger(
  services: ServiceContainer,
  cwd: string,
  customGoal?: string,
): IndustrialTriggerResult {
  const goal =
    customGoal ||
    'Turbine T-07 Safety Audit: ingest telemetry & maintenance report, run anomaly analysis, audit ISO thresholds, and synthesize sovereign safety report';

  // 1. Create typed objective task via TaskService
  const task = services.task.createTask({
    type: 'objective',
    description: `## Objective: Turbine T-07 Safety Audit\n\nIngest telemetry & maintenance report, run anomaly analysis, audit ISO thresholds, and synthesize sovereign safety report.\n\n### Goal\n${goal}`,
    capabilities: [
      'planning',
      'decomposition',
      'architecture',
      'document-ingestion',
      'evidence-normalization',
      'time-series-analysis',
      'threshold-audit',
      'evidence-synthesis',
    ],
    complexity: 'high',
    category: 'industrial-safety',
  });

  const runId = task.id;

  // 2. Create typed workflow stage via WorkflowService
  const stage = services.workflow.createObjective({
    id: runId,
    goal,
    plannerAgentId: 'AUTO',
  });

  // 3. Record audit event for sovereign workflow initiation
  services.audit.recordAuditEvent({
    category: 'stage',
    source: 'industrial-dashboard',
    data: {
      event: 'WORKFLOW_TRIGGERED',
      runId,
      stageId: stage.id,
      goal,
      taskType: task.type,
      capabilities: task.capabilities,
    },
  });

  return {
    success: true,
    runId,
    stageId: stage.id,
    stage,
    task: {
      id: task.id,
      type: task.type,
      status: task.status,
      capabilities: task.capabilities,
    },
    links: {
      run: `/api/v1/runs/${runId}`,
      stage: `/api/v1/workflows/${stage.id}`,
      stages: `/api/v1/workflows/${stage.id}`,
      cockpit: `/api/v1/cockpit/${runId}`,
    },
  };
}

export function runDashboard(): void {
  const cwd = process.cwd();

  if (!isMaosInitialized(cwd)) {
    console.log(chalk.red('❌ MAOS is not initialized. Run `maos init` first.'));
    process.exit(1);
  }

  const services = createServiceContainer(cwd);
  const v1Router = new RestApiRouter(services, cwd);

  const server = http.createServer((req, res) => {
    // Mount versioned OpenAPI REST contract
    if (req.url?.startsWith('/api/v1')) {
      void v1Router.handle(req, res);
      return;
    }

    if (req.method === 'POST' && req.url === '/api/industrial/evidence') {
      void handleEvidenceUpload(req, res, cwd);
      return;
    }

    if (req.method === 'POST' && req.url === '/api/industrial/telemetry/analyze') {
      void handleTelemetryAnalysis(req, res, cwd);
      return;
    }

    if (req.url === '/api/industrial/chart-data') {
      res.writeHead(200, getLegacyCorsHeaders(req));
      res.end(JSON.stringify(getIndustrialChartData(cwd)));
      return;
    }

    if (req.url === '/api/industrial/report') {
      res.writeHead(200, getLegacyCorsHeaders(req));
      res.end(JSON.stringify(getIndustrialReport(cwd)));
      return;
    }

    if (req.method === 'POST' && req.url === '/api/industrial/trigger') {
      void executeJudgedRun({
        projectRoot: cwd,
        services,
        demoName: 'safety-audit',
        json: true,
      }).then((result) => {
        const waiting = result.approvalStatus === 'pending' && Boolean(result.details?.approvalId);
        res.writeHead(waiting ? 202 : (result.success ? 200 : 422), getLegacyCorsHeaders(req));
        res.end(JSON.stringify({
          success: waiting || result.success,
          runId: result.runId,
          status: waiting ? 'pending_approval' : (result.success ? 'completed' : 'failed'),
          verdict: result.overallVerdict,
          details: result.details,
          message: result.message,
        }));
      }).catch((err: any) => {
        res.writeHead(500, getLegacyCorsHeaders(req));
        res.end(JSON.stringify({ success: false, error: err.message }));
      });
      return;
    }

    if (req.url === '/api/state') {
      res.writeHead(200, getLegacyCorsHeaders(req));
      res.end(JSON.stringify(getDashboardState(cwd)));
      return;
    }

    if (req.url === '/api/logs') {
      res.writeHead(200, getLegacyCorsHeaders(req));
      res.end(JSON.stringify(getRecentLogs(cwd)));
      return;
    }

    if (req.url === '/api/health') {
      const monitor = getHealthMonitor();
      res.writeHead(200, getLegacyCorsHeaders(req));
      if (monitor) {
        res.end(
          JSON.stringify({
            agents: monitor.getStatus(),
            summary: monitor.getSummary(),
            alerts: monitor.getAlerts(10),
            activeIncidents: monitor.getActiveIncidents(),
            archivedIncidents: monitor.getArchivedIncidents(10),
          }),
        );
      } else {
        res.end(JSON.stringify(readPersistedHealthState(cwd)));
      }
      return;
    }

    if (req.url === '/dashboard' || req.url?.startsWith('/dashboard?')) {
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': 'text/html; charset=utf-8',
      });
      res.end(getDashboardHTML());
      return;
    }

    // Serve React SPA or fall back to legacy HTML dashboard
    serveSpaOrFallback(req, res, cwd);
  });

  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      console.error(chalk.red(`\n  ❌ Port ${PORT} is already in use.`));
      console.error(chalk.gray(`  To free the port on Windows (PowerShell):`));
      console.error(
        chalk.cyan(
          `  Get-NetTCPConnection -LocalPort ${PORT} -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }\n`,
        ),
      );
      process.exit(1);
    } else {
      console.error(chalk.red(`\n  ❌ Dashboard server error: ${err.message}\n`));
      process.exit(1);
    }
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log('');
    console.log(chalk.bold.white('  MAOS // MONOCHROME MISSION CONTROL'));
    console.log(chalk.gray('  ─────────────────────────────────────────'));
    console.log(`  ${chalk.white('▶')} Dashboard running at ${chalk.underline(`http://127.0.0.1:${PORT}`)}`);
    console.log(`  ${chalk.gray('Press Ctrl+C to stop')}`);
    console.log('');
  });
}
