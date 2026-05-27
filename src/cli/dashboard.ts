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
    const [stateRes, logsRes] = await Promise.all([
      fetch('/api/state'),
      fetch('/api/logs'),
    ]);
    const state = await stateRes.json();
    const logs = await logsRes.json();

    // Project name
    document.getElementById('project-name').textContent = 'Project: ' + state.project;

    // Stats
    document.getElementById('stat-pending').textContent = state.queue.pending;
    document.getElementById('stat-active').textContent = state.queue.active;
    document.getElementById('stat-done').textContent = state.queue.done;
    document.getElementById('stat-cost').textContent = '$' + (state.telemetry.totalCostUSD || 0).toFixed(4);

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
                          st.status === 'FAILED' ? 'badge-failed' : 'badge-idle';
        return '<div class="agent-row">' +
          '<div><div class="agent-id">' + a.id + '</div>' +
          '<div class="agent-model">' + (a.provider || '?') + '/' + (a.model || '?') + '</div></div>' +
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
