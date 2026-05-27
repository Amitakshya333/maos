import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { isMaosInitialized, getStatusDir, getLogsDir } from '../utils/paths';
import { getQueueCounts, getPendingTasks, getActiveTasks, getDoneTasks } from '../core/queue';
import { readTelemetry, summarizeTelemetry } from '../core/telemetry';
import { loadBrain } from '../core/brain';
import { getRetryQueueStatus, getDeadLetterQueue } from '../core/retry-queue';
import { EventStore } from '../core/event-store';
import { getHealthMonitor } from '../core/health-monitor';

const PORT = 3847;

export function runDashboard(): void {
  const cwd = process.cwd();

  if (!isMaosInitialized(cwd)) {
    console.log(chalk.red('❌ MAOS is not initialized. Run `maos init` first.'));
    process.exit(1);
  }

  const server = http.createServer((req, res) => {
    if (req.url === '/api/state') {
      // JSON API endpoint for live data
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
      res.end(JSON.stringify({
        agents: monitor ? monitor.getStatus() : [],
        summary: monitor ? monitor.getSummary() : null,
        alerts: monitor ? monitor.getAlerts(10) : [],
      }));
      return;
    }

    // Serve the dashboard HTML
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getDashboardHTML());
  });

  server.listen(PORT, () => {
    console.log('');
    console.log(chalk.bold.cyan('  🌐 MAOS Web Dashboard'));
    console.log(chalk.gray('  ─────────────────────────────────────────'));
    console.log(`  ${chalk.green('▶')} Running at ${chalk.cyan.underline(`http://localhost:${PORT}`)}`);
    console.log(`  ${chalk.gray('Press Ctrl+C to stop')}`);
    console.log('');
  });
}

function getDashboardState(cwd: string) {
  const counts = getQueueCounts(cwd);
  const pending = getPendingTasks(cwd);
  const active = getActiveTasks(cwd);
  const done = getDoneTasks(cwd);

  // Read agent statuses
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

  // Read config for agent metadata
  let config: any = {};
  const configPath = path.join(cwd, '.maos', 'maos.config.json');
  if (fs.existsSync(configPath)) {
    try { config = JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch {}
  }

  const telemetry = summarizeTelemetry(cwd);
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
    tasks: { pending, active, done },
    retryQueue,
    deadLetterQueue: deadLetterQueue.map(d => d.taskId),
    telemetry,
    events: eventStats,
  };
}

function getRecentLogs(cwd: string): string[] {
  const logFile = path.join(getLogsDir(cwd), 'orchestrator.log');
  if (!fs.existsSync(logFile)) return [];
  const content = fs.readFileSync(logFile, 'utf-8');
  return content.split('\n').filter(l => l.trim()).slice(-50);
}

function getDashboardHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>MAOS Dashboard</title>
<style>
  :root {
    --bg: #0a0a0f;
    --surface: #12121a;
    --surface2: #1a1a28;
    --border: #2a2a3a;
    --text: #e0e0e8;
    --text-dim: #8888a0;
    --accent: #6366f1;
    --accent2: #818cf8;
    --green: #22c55e;
    --yellow: #eab308;
    --red: #ef4444;
    --cyan: #06b6d4;
    --purple: #a855f7;
  }
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    min-height: 100vh;
  }
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');

  .header {
    background: linear-gradient(135deg, var(--surface) 0%, var(--surface2) 100%);
    border-bottom: 1px solid var(--border);
    padding: 20px 32px;
    display: flex; align-items: center; justify-content: space-between;
  }
  .header h1 {
    font-size: 24px; font-weight: 700;
    background: linear-gradient(135deg, var(--accent) 0%, var(--cyan) 100%);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
  }
  .header .meta { color: var(--text-dim); font-size: 13px; }
  .header .live-dot {
    display: inline-block; width: 8px; height: 8px; border-radius: 50%;
    background: var(--green); margin-right: 6px;
    animation: pulse 2s infinite;
  }
  @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.4; } }

  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr 1fr;
    gap: 16px;
    padding: 24px 32px;
  }
  .stat-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 20px;
    transition: transform 0.2s, box-shadow 0.2s;
  }
  .stat-card:hover {
    transform: translateY(-2px);
    box-shadow: 0 8px 24px rgba(99,102,241,0.15);
  }
  .stat-card .label { color: var(--text-dim); font-size: 12px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; }
  .stat-card .value { font-size: 32px; font-weight: 700; }
  .stat-card .value.green { color: var(--green); }
  .stat-card .value.yellow { color: var(--yellow); }
  .stat-card .value.cyan { color: var(--cyan); }
  .stat-card .value.purple { color: var(--purple); }

  .main-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
    padding: 0 32px 24px;
  }
  .panel {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
  }
  .panel-header {
    padding: 16px 20px;
    border-bottom: 1px solid var(--border);
    font-weight: 600; font-size: 14px;
    display: flex; align-items: center; gap: 8px;
  }
  .panel-body { padding: 16px 20px; }

  .agent-row {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 0;
    border-bottom: 1px solid var(--border);
  }
  .agent-row:last-child { border-bottom: none; }
  .agent-id { font-weight: 600; font-size: 14px; }
  .agent-model { color: var(--text-dim); font-size: 12px; font-family: 'JetBrains Mono', monospace; }
  .badge {
    font-size: 11px; font-weight: 600; padding: 3px 10px; border-radius: 20px;
    text-transform: uppercase; letter-spacing: 0.5px;
  }
  .badge-idle { background: #1a2a1a; color: var(--green); }
  .badge-busy { background: #2a2a1a; color: var(--yellow); animation: pulse 1.5s infinite; }
  .badge-done { background: #1a1a2a; color: var(--accent2); }
  .badge-failed { background: #2a1a1a; color: var(--red); }
  .badge-stuck { background: #2a1a1a; color: var(--red); animation: pulse 1s infinite; }

  /* Runtime type badges */
  .badge-rt {
    font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 12px;
    text-transform: uppercase; letter-spacing: 0.7px; margin-left: 6px;
  }
  .badge-rt-api   { background: rgba(99,102,241,0.2); color: #818cf8; border: 1px solid rgba(99,102,241,0.4); }
  .badge-rt-cli   { background: rgba(6,182,212,0.2);  color: #06b6d4; border: 1px solid rgba(6,182,212,0.4); }
  .badge-rt-local { background: rgba(168,85,247,0.2); color: #a855f7; border: 1px solid rgba(168,85,247,0.4); }

  /* Health state badges */
  .badge-health {
    font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 12px;
    text-transform: uppercase; letter-spacing: 0.5px; margin-left: 4px;
  }
  .badge-health-healthy  { background: rgba(34,197,94,0.15);  color: #22c55e; }
  .badge-health-degraded { background: rgba(234,179,8,0.15);  color: #eab308; animation: pulse 2s infinite; }
  .badge-health-dead     { background: rgba(239,68,68,0.2);   color: #ef4444; animation: pulse 0.8s infinite; }
  .badge-health-idle     { background: rgba(136,136,160,0.1); color: #8888a0; }

  /* Health panel table */
  .health-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .health-table th { text-align: left; color: var(--text-dim); font-weight: 600; padding: 4px 8px; border-bottom: 1px solid var(--border); }
  .health-table td { padding: 6px 8px; border-bottom: 1px solid rgba(42,42,58,0.4); }
  .health-table tr:last-child td { border-bottom: none; }
  .health-alert { padding: 6px 10px; background: rgba(239,68,68,0.1); border-left: 3px solid var(--red); margin-bottom: 6px; font-size: 12px; border-radius: 0 4px 4px 0; }

  .task-item {
    padding: 10px 0;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
  }
  .task-item:last-child { border-bottom: none; }
  .task-id { font-family: 'JetBrains Mono', monospace; color: var(--cyan); font-size: 11px; }
  .task-desc { margin-top: 4px; color: var(--text); }

  .log-panel { grid-column: 1 / -1; }
  .log-body {
    padding: 12px 16px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    max-height: 300px;
    overflow-y: auto;
    line-height: 1.6;
    color: var(--text-dim);
  }
  .log-body .log-info { color: var(--cyan); }
  .log-body .log-warn { color: var(--yellow); }
  .log-body .log-error { color: var(--red); }
  .log-body .log-success { color: var(--green); }
  .log-body .log-debug { color: #666; }

  .cost-row {
    display: flex; justify-content: space-between; align-items: center;
    padding: 8px 0; border-bottom: 1px solid var(--border);
    font-size: 13px;
  }
  .cost-row:last-child { border-bottom: none; }
  .cost-label { font-weight: 500; }
  .cost-value { font-family: 'JetBrains Mono', monospace; color: var(--yellow); }

  .footer {
    text-align: center; padding: 16px;
    color: var(--text-dim); font-size: 12px;
    border-top: 1px solid var(--border);
  }
</style>
</head>
<body>

<div class="header">
  <div>
    <h1>🤖 MAOS Dashboard</h1>
    <div class="meta" id="project-name">Loading...</div>
  </div>
  <div class="meta">
    <span class="live-dot"></span>
    <span id="refresh-time">Auto-refresh: 2s</span>
  </div>
</div>

<div class="grid">
  <div class="stat-card">
    <div class="label">📥 Pending</div>
    <div class="value yellow" id="stat-pending">-</div>
  </div>
  <div class="stat-card">
    <div class="label">⚡ Active</div>
    <div class="value cyan" id="stat-active">-</div>
  </div>
  <div class="stat-card">
    <div class="label">✅ Done</div>
    <div class="value green" id="stat-done">-</div>
  </div>
  <div class="stat-card">
    <div class="label">💰 Total Cost</div>
    <div class="value purple" id="stat-cost">-</div>
  </div>
  <div class="stat-card" id="stat-retry-card" style="display:none">
    <div class="label">🔄 Retrying</div>
    <div class="value" style="color:var(--red)" id="stat-retry">0</div>
  </div>
</div>

<div class="main-grid">
  <div class="panel">
    <div class="panel-header">🤖 Agent Fleet</div>
    <div class="panel-body" id="agents-list">
      <div style="color:var(--text-dim)">Loading...</div>
    </div>
  </div>

  <div class="panel">
    <div class="panel-header">📋 Task Queue</div>
    <div class="panel-body" id="tasks-list" style="max-height:300px;overflow-y:auto;">
      <div style="color:var(--text-dim)">Loading...</div>
    </div>
  </div>

  <div class="panel">
    <div class="panel-header">❤️ Health Monitor</div>
    <div class="panel-body" id="health-panel">
      <div style="color:var(--text-dim)">Waiting for orchestrator...</div>
    </div>
  </div>

  <div class="panel">
    <div class="panel-header">📊 Cost Analytics</div>
    <div class="panel-body" id="cost-analytics">
      <div style="color:var(--text-dim)">No telemetry data yet</div>
    </div>
  </div>

  <div class="panel">
    <div class="panel-header">🔀 Routing Decisions</div>
    <div class="panel-body" id="routing-info">
      <div style="color:var(--text-dim)">No routing data yet</div>
    </div>
  </div>

  <div class="panel log-panel">
    <div class="panel-header">📜 Live Logs</div>
    <div class="log-body" id="log-stream">Loading...</div>
  </div>
</div>

<div class="footer">
  MAOS v0.1.0 — Multi-Agent Orchestrator System — docker-compose for AI coding agents
</div>

<script>
async function refresh() {
  try {
    const [stateRes, logsRes, healthRes] = await Promise.all([
      fetch('/api/state'),
      fetch('/api/logs'),
      fetch('/api/health'),
    ]);
    const state = await stateRes.json();
    const logs = await logsRes.json();
    window._health = await healthRes.json();

    // Project name
    document.getElementById('project-name').textContent = 'Project: ' + state.project;

    // Stats
    document.getElementById('stat-pending').textContent = state.queue.pending;
    document.getElementById('stat-active').textContent = state.queue.active;
    document.getElementById('stat-done').textContent = state.queue.done;
    document.getElementById('stat-cost').textContent = '$' + (state.telemetry.totalCostUSD || 0).toFixed(4);

    // Retry / dead letter counts in stats bar (if non-zero)
    const retryCount = (state.queue.retry || 0) + (state.queue.failed || 0);
    const retryCard = document.getElementById('stat-retry-card');
    const retryVal = document.getElementById('stat-retry');
    if (retryCard && retryVal) {
      retryVal.textContent = retryCount;
      retryCard.style.display = retryCount > 0 ? 'flex' : 'none';
    }

    // Agents
    const agentsEl = document.getElementById('agents-list');
    if (state.agentDefs.length === 0) {
      agentsEl.innerHTML = '<div style="color:var(--text-dim)">No agents configured</div>';
    } else {
    agentsEl.innerHTML = state.agentDefs.map(a => {
        const st = state.agents[a.id] || { status: 'UNKNOWN', detail: '' };
        const badgeClass = st.status === 'IDLE' ? 'badge-idle' :
                          st.status === 'BUSY' ? 'badge-busy' :
                          st.status === 'DONE' ? 'badge-done' :
                          st.status === 'FAILED' ? 'badge-failed' :
                          st.status === 'STUCK' ? 'badge-stuck' : 'badge-idle';

        // Runtime type badge
        const rt = (a.runtime || 'api').toLowerCase();
        const rtBadge = '<span class="badge-rt badge-rt-' + rt + '">' + rt + '</span>';

        // Health badge (from /api/health)
        let healthBadge = '';
        if (window._health && window._health.agents) {
          const h = window._health.agents.find(x => x.agentId === a.id);
          if (h) {
            const hs = h.state.toLowerCase();
            const icon = hs === 'healthy' ? '\u2665' : hs === 'degraded' ? '\u26a0' : hs === 'dead' ? '\u2620' : '\u25cb';
            healthBadge = '<span class="badge-health badge-health-' + hs + '">' + icon + ' ' + h.state + '</span>';
          }
        }

        // Task detail
        const detail = st.detail ? '<div style="color:var(--text-dim);font-size:11px;margin-top:2px;">' + st.detail.substring(0,60) + '</div>' : '';

        return '<div class="agent-row">' +
          '<div><div class="agent-id">' + a.id + rtBadge + healthBadge + '</div>' +
          '<div class="agent-model">' + (a.provider || a.cliCommand || '?') + '/' + (a.model || a.cliCommand || '?') + '</div>' + detail + '</div>' +
          '<div><span class="badge ' + badgeClass + '">' + st.status + '</span></div>' +
          '</div>';
      }).join('');
    }

    // Tasks
    const tasksEl = document.getElementById('tasks-list');
    const allTasks = [
      ...state.tasks.active.map(t => ({...t, _status: '⚡ active'})),
      ...state.tasks.pending.map(t => ({...t, _status: '📥 pending'})),
      ...state.tasks.done.slice(-5).map(t => ({...t, _status: '✅ done'})),
    ];
    if (allTasks.length === 0) {
      tasksEl.innerHTML = '<div style="color:var(--text-dim)">No tasks in queue</div>';
    } else {
      tasksEl.innerHTML = allTasks.map(t =>
        '<div class="task-item">' +
        '<div class="task-id">' + t._status + ' · ' + (t.id || 'unknown') + '</div>' +
        '<div class="task-desc">' + (t.description || '').substring(0, 80) + '</div>' +
        '</div>'
      ).join('');
    }

    // Health Monitor panel
    const healthEl = document.getElementById('health-panel');
    if (window._health && window._health.agents && window._health.agents.length > 0) {
      const agents = window._health.agents;
      const alerts = (window._health.alerts || []).slice(-3);

      let html = '';

      // Alerts first (if any)
      if (alerts.length > 0) {
        for (const alert of alerts) {
          const ago = Math.round((Date.now() - alert.timestamp) / 1000);
          html += '<div class="health-alert">' +
            (alert.state === 'DEAD' ? '☠ ' : '⚠ ') +
            escapeHtml(alert.message) +
            ' <span style="color:var(--text-dim)">(' + ago + 's ago)</span>' +
            '</div>';
        }
      }

      // Agent health table
      html += '<table class="health-table"><thead><tr>' +
        '<th>Agent</th><th>State</th><th>Runtime</th><th>Task</th><th>Silent</th>' +
        '</tr></thead><tbody>';

      for (const h of agents) {
        const hs = h.state.toLowerCase();
        const icon = hs === 'healthy' ? '♥' : hs === 'degraded' ? '⚠' : hs === 'dead' ? '☠' : '○';
        const silentMs = h.lastHeartbeatAt ? Date.now() - h.lastHeartbeatAt : null;
        const silentStr = silentMs !== null
          ? (silentMs < 5000 ? 'just now' : Math.round(silentMs / 1000) + 's ago')
          : (hs === 'idle' ? '—' : 'never');
        const taskStr = h.currentTaskId ? h.currentTaskId.substring(0, 16) + '…' : '—';
        const rt = (h.runtimeType || 'api').toLowerCase();

        html += '<tr>' +
          '<td style="font-weight:600">' + h.agentId + '</td>' +
          '<td><span class="badge-health badge-health-' + hs + '">' + icon + ' ' + h.state + '</span></td>' +
          '<td><span class="badge-rt badge-rt-' + rt + '">' + rt + '</span></td>' +
          '<td style="font-family:monospace;font-size:11px;color:var(--cyan)">' + taskStr + '</td>' +
          '<td style="color:var(--text-dim);font-size:11px">' + silentStr + '</td>' +
          '</tr>';
      }

      html += '</tbody></table>';

      // Summary line
      const s = window._health.summary;
      if (s) {
        html += '<div style="margin-top:10px;font-size:11px;color:var(--text-dim)">' +
          '♥ ' + s.healthy + ' healthy · ' +
          '⚠ ' + s.degraded + ' degraded · ' +
          '☠ ' + s.dead + ' dead · ' +
          'alerts: ' + s.totalAlerts +
          '</div>';
      }

      healthEl.innerHTML = html;
    } else {
      healthEl.innerHTML = '<div style="color:var(--text-dim)">Waiting for orchestrator to start...</div>';
    }

    // Cost analytics
    const costEl = document.getElementById('cost-analytics');
    if (state.telemetry.totalRuns > 0) {
      let html = '';
      for (const [agent, stats] of Object.entries(state.telemetry.byAgent)) {
        const s = stats;
        html += '<div class="cost-row">' +
          '<span class="cost-label">' + agent + '</span>' +
          '<span class="cost-value">' + s.runs + ' tasks · $' + s.avgCost.toFixed(4) + '/task</span>' +
          '</div>';
      }
      html += '<div class="cost-row" style="font-weight:700">' +
        '<span>TOTAL</span>' +
        '<span class="cost-value">' + state.telemetry.totalRuns + ' runs · $' + state.telemetry.totalCostUSD.toFixed(4) + '</span>' +
        '</div>';
      costEl.innerHTML = html;
    }

    // Routing
    const routeEl = document.getElementById('routing-info');
    if (state.telemetry.topCapabilities && state.telemetry.topCapabilities.length > 0) {
      routeEl.innerHTML = state.telemetry.topCapabilities.map(c =>
        '<div class="cost-row">' +
        '<span class="cost-label">' + c.capability + '</span>' +
        '<span class="cost-value">' + c.count + ' tasks · ' + Math.round(c.successRate * 100) + '% success</span>' +
        '</div>'
      ).join('');
    }

    // Logs
    const logEl = document.getElementById('log-stream');
    logEl.innerHTML = logs.map(line => {
      let cls = '';
      if (line.includes('[INFO]')) cls = 'log-info';
      else if (line.includes('[WARN]')) cls = 'log-warn';
      else if (line.includes('[ERROR]')) cls = 'log-error';
      else if (line.includes('[SUCCESS]')) cls = 'log-success';
      else if (line.includes('[DEBUG]')) cls = 'log-debug';
      return '<div class="' + cls + '">' + escapeHtml(line) + '</div>';
    }).join('');
    logEl.scrollTop = logEl.scrollHeight;

  } catch (err) {
    console.error('Refresh error:', err);
  }
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>`;
}
