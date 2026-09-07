/**
 * MAOS Dashboard — HTTP server for the mission control web UI.
 *
 * Split into modules for maintainability:
 *   - dashboard-state.ts  — Data fetching, API helpers, evidence handling
 *   - dashboard-template.ts — HTML/CSS/JS template generation
 */
import * as http from 'http';
import chalk from 'chalk';
import { isMaosInitialized } from '../utils/paths';
import { createTask } from '../core/queue';
import { getHealthMonitor } from '../core/health-monitor';
import {
  getDashboardState,
  getIndustrialChartData,
  getIndustrialReport,
  getRecentLogs,
  handleEvidenceUpload,
  readPersistedHealthState,
} from './dashboard-state';
import { getDashboardHTML } from './dashboard-template';

const PORT = 3847;

export function runDashboard(): void {
  const cwd = process.cwd();

  if (!isMaosInitialized(cwd)) {
    console.log(chalk.red('❌ MAOS is not initialized. Run `maos init` first.'));
    process.exit(1);
  }

  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/industrial/evidence') {
      void handleEvidenceUpload(req, res, cwd);
      return;
    }

    if (req.url === '/api/industrial/chart-data') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(getIndustrialChartData(cwd)));
      return;
    }

    if (req.url === '/api/industrial/report') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(getIndustrialReport(cwd)));
      return;
    }

    if (req.method === 'POST' && req.url === '/api/industrial/trigger') {
      try {
        const task = createTask({
          agent: 'INGEST_AGENT',
          description:
            'Turbine T-07 Safety Audit: ingest telemetry & maintenance report, run anomaly analysis, audit ISO thresholds, and synthesize sovereign safety report',
          capabilities: [
            'document-ingestion',
            'evidence-normalization',
            'time-series-analysis',
            'threshold-audit',
            'evidence-synthesis',
          ],
          complexity: 'high',
          category: 'industrial-safety',
          cwd: cwd,
        });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ success: true, task }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return;
    }

    if (req.url === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(getDashboardState(cwd)));
      return;
    }

    if (req.url === '/api/logs') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(getRecentLogs(cwd)));
      return;
    }

    if (req.url === '/api/health') {
      const monitor = getHealthMonitor();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
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

    if (req.url === '/' || req.url === '' || req.url === '/dashboard' || req.url?.startsWith('/dashboard?')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getDashboardHTML());
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getDashboardHTML());
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
