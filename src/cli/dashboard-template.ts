/**
 * Dashboard HTML template — contains all inline CSS and client-side JavaScript.
 * Extracted from the monolithic dashboard.ts for maintainability.
 */
export function getDashboardHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>MAOS // Sovereign Industrial Mission Control</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&family=Space+Grotesk:wght@500;600;700;800&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #000000;
    --surface: #0a0a0a;
    --surface-elevated: #121212;
    --surface-hover: #181818;
    --border: #222222;
    --border-subtle: #141414;
    --border-bright: #3a3a3a;
    --text: #ffffff;
    --text-muted: #888888;
    --text-dim: #444444;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    background-color: var(--bg);
    color: var(--text);
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    min-height: 100vh;
    letter-spacing: -0.01em;
    -webkit-font-smoothing: antialiased;
    overflow-x: hidden;
    position: relative;
  }

  canvas#bg-particles {
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    pointer-events: none;
    z-index: 0;
    opacity: 0.65;
  }

  header {
    height: 60px;
    border-bottom: 1px solid var(--border);
    background: rgba(0, 0, 0, 0.92);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 28px;
    position: sticky;
    top: 0;
    z-index: 50;
  }

  .brand-group {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .brand-box {
    width: 28px;
    height: 28px;
    background: #ffffff;
    color: #000000;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: 'Space Grotesk', sans-serif;
    font-weight: 800;
    font-size: 14px;
  }

  .brand-title {
    font-family: 'Space Grotesk', sans-serif;
    font-size: 15px;
    font-weight: 700;
    letter-spacing: -0.02em;
    color: #ffffff;
  }

  .tag-mono {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: var(--text-muted);
    border: 1px solid var(--border);
    padding: 2px 7px;
    border-radius: 4px;
    background: var(--surface);
  }

  .cli-prompt-pill {
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--surface);
    border: 1px solid var(--border);
    padding: 4px 10px;
    border-radius: 4px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: var(--text-muted);
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .cli-prompt-pill:hover {
    border-color: #ffffff;
    color: #ffffff;
  }

  .header-pills {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .pill-b-w {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    padding: 4px 10px;
    border-radius: 4px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text-muted);
  }

  .pill-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #ffffff;
    box-shadow: 0 0 6px rgba(255, 255, 255, 0.9);
  }

  .layout {
    max-width: 1400px;
    margin: 0 auto;
    padding: 24px 28px;
    display: flex;
    flex-direction: column;
    gap: 18px;
    position: relative;
    z-index: 1;
  }

  .banner-sovereign {
    border: 1px solid var(--border);
    background: var(--surface);
    border-radius: 8px;
    padding: 18px 22px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 16px;
  }

  .banner-text h2 {
    font-family: 'Space Grotesk', sans-serif;
    font-size: 17px;
    font-weight: 700;
    letter-spacing: -0.02em;
    color: #ffffff;
  }
  .banner-text p {
    font-size: 12.5px;
    color: var(--text-muted);
    margin-top: 3px;
  }

  .specs-row {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }

  .spec-item {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    padding: 6px 12px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--surface-elevated);
    color: var(--text-muted);
  }
  .spec-item strong { color: #ffffff; }

  .live-stats {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 10px;
  }
  .live-stat {
    border: 1px solid var(--border); background: var(--surface);
    border-radius: 6px; padding: 10px 12px;
  }
  .live-stat-label { color: var(--text-muted); font: 10px 'JetBrains Mono', monospace; text-transform: uppercase; }
  .live-stat-value { color: #fff; font: 700 20px 'Space Grotesk', sans-serif; margin-top: 4px; }
  .live-stat-note { color: var(--text-muted); font: 10px 'JetBrains Mono', monospace; margin-top: 2px; }
  .data-error { color: #ffb4b4; border-color: #733; background: #1d1010; }
  @media (max-width: 900px) { .live-stats { grid-template-columns: repeat(2, 1fr); } }

  .nav-tabs {
    display: flex;
    align-items: center;
    gap: 8px;
    border-bottom: 1px solid var(--border);
    padding-bottom: 12px;
  }

  .tab-btn {
    background: transparent;
    border: 1px solid transparent;
    color: var(--text-muted);
    font-family: 'Space Grotesk', sans-serif;
    font-size: 13px;
    font-weight: 600;
    padding: 7px 14px;
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .tab-btn:hover {
    color: #ffffff;
    background: var(--surface);
  }
  .tab-btn.active {
    color: #000000;
    background: #ffffff;
    border-color: #ffffff;
  }

  .btn-bw-primary {
    margin-left: auto;
    background: #ffffff;
    color: #000000;
    font-family: 'Space Grotesk', sans-serif;
    font-size: 13px;
    font-weight: 700;
    padding: 8px 22px;
    border-radius: 4px;
    border: 1px solid #ffffff;
    cursor: pointer;
    transition: all 0.15s ease;
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .btn-bw-primary:hover {
    background: #dddddd;
  }
  .btn-bw-primary:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .audit-toast {
    display: none;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    padding: 6px 12px;
    border-radius: 4px;
    background: #111;
    border: 1px solid #333;
    color: #fff;
  }

  .dag-container {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 12px;
  }

  .node-bw {
    border: 1px solid var(--border);
    background: var(--surface);
    border-radius: 6px;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    transition: all 0.15s ease;
  }
  .node-bw:hover {
    border-color: var(--border-bright);
  }
  .node-bw.active {
    border-color: #ffffff;
    background: var(--surface-elevated);
    box-shadow: 0 0 15px rgba(255, 255, 255, 0.1);
  }
  .node-bw.done {
    border-color: #444444;
  }

  .node-meta {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .node-idx {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    color: var(--text-dim);
  }

  .node-badge {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    font-weight: 700;
    padding: 1px 6px;
    border-radius: 2px;
    border: 1px solid var(--border);
  }
  .badge-idle { color: var(--text-dim); }
  .badge-active { background: #ffffff; color: #000000; border-color: #ffffff; }
  .badge-done { color: var(--text-muted); border-color: #444444; }

  .node-name {
    font-family: 'Space Grotesk', sans-serif;
    font-size: 14px;
    font-weight: 700;
    color: #ffffff;
  }

  .node-desc {
    font-size: 11.5px;
    color: var(--text-muted);
    line-height: 1.45;
    min-height: 34px;
  }

  .node-details {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding-top: 8px;
    border-top: 1px solid var(--border-subtle);
    font-family: 'JetBrains Mono', monospace;
    font-size: 10.5px;
    color: var(--text-dim);
  }

  .grid-2col {
    display: grid;
    grid-template-columns: 1.45fr 1fr;
    gap: 14px;
  }

  .panel-bw {
    border: 1px solid var(--border);
    background: var(--surface);
    border-radius: 8px;
    padding: 18px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .panel-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .panel-title {
    font-family: 'Space Grotesk', sans-serif;
    font-size: 14px;
    font-weight: 700;
    color: #ffffff;
  }

  .canvas-box {
    background: #000000;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 10px;
    position: relative;
  }

  canvas#telemetryCanvas {
    width: 100%;
    height: 230px;
    display: block;
    cursor: crosshair;
  }

  .chart-tooltip {
    position: absolute;
    display: none;
    background: #000000;
    border: 1px solid #ffffff;
    border-radius: 4px;
    padding: 8px 12px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: #ffffff;
    pointer-events: none;
    z-index: 100;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.9);
  }

  .anomaly-deck {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 8px;
  }

  .anom-card {
    border: 1px solid var(--border);
    background: var(--surface-elevated);
    border-radius: 4px;
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .anom-card:hover {
    border-color: #ffffff;
    background: var(--surface-hover);
  }
  .anom-card.fail {
    border-left: 2px solid #ffffff;
  }

  .anom-tag { font-family: 'JetBrains Mono', monospace; font-size: 9.5px; color: var(--text-dim); }
  .anom-reading { font-family: 'JetBrains Mono', monospace; font-size: 12.5px; font-weight: 700; color: #ffffff; }
  .anom-thresh { font-size: 9.5px; color: var(--text-muted); }

  .report-box {
    background: #000000;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 16px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11.5px;
    height: 322px;
    overflow-y: auto;
    line-height: 1.6;
    color: var(--text-muted);
  }

  .stamp-fail {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10.5px;
    font-weight: 700;
    padding: 2px 7px;
    border-radius: 3px;
    border: 1px solid #ffffff;
    background: #ffffff;
    color: #000000;
  }

  .report-box table {
    width: 100%;
    border-collapse: collapse;
    margin: 12px 0;
    font-size: 11px;
  }
  .report-box th {
    text-align: left;
    padding: 6px 8px;
    border-bottom: 1px solid #333;
    color: #ffffff;
    font-weight: 700;
  }
  .report-box td {
    padding: 6px 8px;
    border-bottom: 1px solid #1a1a1a;
    color: #aaaaaa;
  }
  .report-box tr:hover td {
    background: #0a0a0a;
    color: #ffffff;
  }

  .raw-table-box {
    background: #000000;
    border: 1px solid var(--border);
    border-radius: 6px;
    height: 380px;
    overflow-y: auto;
  }
  .raw-table-box table {
    width: 100%;
    border-collapse: collapse;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
  }
  .raw-table-box th {
    position: sticky;
    top: 0;
    background: #111111;
    text-align: left;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    color: #ffffff;
    z-index: 10;
  }
  .raw-table-box td {
    padding: 6px 12px;
    border-bottom: 1px solid #141414;
    color: #888888;
  }
  .raw-table-box tr.anomaly-row td {
    background: #161616;
    color: #ffffff;
    font-weight: 700;
    border-left: 2px solid #ffffff;
  }

  .grid-bottom {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px;
  }

  .console-box {
    background: #000000;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 12px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 10.5px;
    height: 220px;
    overflow-y: auto;
    line-height: 1.6;
    color: var(--text-dim);
  }
  .log-white { color: #ffffff; }
  .log-gray { color: #999999; }
  .log-info { color: #cccccc; }
  .log-warn { color: #ffffff; font-weight: 600; }
  .log-error { color: #ffffff; font-weight: 700; background: #222222; }

  @media (max-width: 1024px) {
    .dag-container { grid-template-columns: repeat(2, 1fr); }
    .grid-2col { grid-template-columns: 1fr; }
    .grid-bottom { grid-template-columns: 1fr; }
    .anomaly-deck { grid-template-columns: repeat(2, 1fr); }
  }
  .health-tbl { width:100%;border-collapse:collapse;font-family:'JetBrains Mono',monospace;font-size:11px; }
  .health-tbl th { text-align:left;padding:6px 0; }
  .health-hdr { color:var(--text-dim);border-bottom:1px solid var(--border); }
  .health-row { border-bottom:1px solid var(--border-subtle); }
  .health-agent { padding:6px 0;font-weight:700;color:#ffffff; }
  .health-rt { color:var(--text-muted); }
  .health-hb { color:var(--text-dim); }
  .md-h2 { font-family:'Space Grotesk',sans-serif;color:#ffffff;font-size:14px;font-weight:800;margin:16px 0 8px;border-bottom:1px solid #222;padding-bottom:4px; }
  .md-h3 { font-family:'Space Grotesk',sans-serif;color:#ffffff;font-size:13px;font-weight:700;margin:14px 0 6px; }
  .md-h4 { font-family:'Space Grotesk',sans-serif;color:#cccccc;font-size:12px;font-weight:700;margin:10px 0 4px; }
  .md-li { margin-left:14px;margin-bottom:4px;color:#aaaaaa; }
  .md-p { margin-bottom:8px;color:#888888; }
  .md-pre { background:#0a0a0a;border:1px solid #222;padding:10px;border-radius:4px;overflow-x:auto;margin:8px 0; }
  .md-code { background:#141414;padding:1px 5px;border-radius:3px;border:1px solid #282828;color:#ffffff; }
  .md-fail { background:#ffffff;color:#000000;font-weight:800;padding:1px 5px;border-radius:2px; }
  .md-warn { border:1px solid #ffffff;color:#ffffff;font-weight:700;padding:1px 5px;border-radius:2px; }
  .md-pass { color:#aaaaaa; }
  .md-bold { color:#ffffff; }

  @media (max-width: 600px) {
    .dag-container { grid-template-columns: 1fr; }
    .anomaly-deck { grid-template-columns: 1fr; }
    header { padding: 0 16px; }
    .layout { padding: 16px; }
  }
</style>
</head>
<body>

<canvas id="bg-particles"></canvas>

<header>
  <div class="brand-group">
    <div class="brand-box">M</div>
    <div class="brand-title">MAOS // SOVEREIGN MISSION CONTROL</div>
    <span class="tag-mono">v0.3.0</span>
  </div>

  <div class="header-pills">
    <div class="cli-prompt-pill" onclick="copyCli()" title="Click to copy CLI command">
      <span>$ maos run turbine-safety</span>
      <span style="font-size:10px;border:1px solid #333;padding:1px 4px;border-radius:2px">COPY</span>
    </div>
    <div class="pill-b-w">
      <span class="pill-dot"></span>
      <span>AIR-GAPPED SOVEREIGN</span>
    </div>
    <div class="pill-b-w">
      <span>RTX 4060 · CUDA 12.8</span>
    </div>
  </div>
</header>

<main class="layout">

  <section class="banner-sovereign">
    <div class="banner-text">
      <h2>Turbine T-07 Condition Monitoring & Anomaly Detection</h2>
      <p>Local Model Inference · Zero Internet Egress · Deterministic ISO 10816-3 Threshold Compliance</p>
    </div>

    <div class="specs-row">
      <div class="spec-item">Model: <strong>Qwen2.5-3B-Instruct (Cache-Only)</strong></div>
      <div class="spec-item">Latency: <strong>~1.6s / turn (GPU)</strong></div>
      <div class="spec-item">Cloud Data Leak: <strong>0 Bytes</strong></div>
      <div class="spec-item">Cloud Cost: <strong>$0.0000</strong></div>
    </div>
  </section>

  <div class="nav-tabs">
    <button class="tab-btn active" id="tab-overview" onclick="switchTab('overview')">Telemetry & Waveform</button>
    <button class="tab-btn" id="tab-raw" onclick="switchTab('raw')">Raw Sensor Logs (500 Rows)</button>
    <button class="tab-btn" id="tab-dossier" onclick="switchTab('dossier')">Executive Dossier</button>
    <button class="tab-btn" id="tab-stream" onclick="switchTab('stream')">Event Stream</button>

    <button class="btn-bw-primary" id="btn-trigger-bw" onclick="runSovereignAudit()">
      <span>▶</span> RUN SOVEREIGN AUDIT
    </button>
  </div>

  <div id="audit-status-toast" class="audit-toast"></div>

  <section class="live-stats" aria-label="Live MAOS statistics">
    <div class="live-stat"><div class="live-stat-label">Pending</div><div class="live-stat-value" id="stat-pending">—</div><div class="live-stat-note">queue</div></div>
    <div class="live-stat"><div class="live-stat-label">Active</div><div class="live-stat-value" id="stat-active">—</div><div class="live-stat-note">running tasks</div></div>
    <div class="live-stat"><div class="live-stat-label">Completed</div><div class="live-stat-value" id="stat-done">—</div><div class="live-stat-note">done tasks</div></div>
    <div class="live-stat"><div class="live-stat-label">Inference</div><div class="live-stat-value" id="stat-runs">—</div><div class="live-stat-note" id="stat-tokens">tokens: —</div></div>
    <div class="live-stat"><div class="live-stat-label">Cloud cost</div><div class="live-stat-value" id="stat-cost">$0.0000</div><div class="live-stat-note" id="stat-updated">waiting for state</div></div>
  </section>

  <div class="dag-container">
    <div class="node-bw" id="node-INGEST_AGENT">
      <div class="node-meta">
        <span class="node-idx">01 // INTAKE</span>
        <span class="node-badge badge-idle" id="badge-INGEST_AGENT">READY</span>
      </div>
      <div class="node-name">INGEST_AGENT</div>
      <div class="node-desc">Normalizes 500 vibration/temperature records and maintenance log with provenance tags.</div>
      <div class="node-details">
        <span>huggingface-local</span>
        <span>evidenceRoot</span>
      </div>
    </div>

    <div class="node-bw" id="node-ANALYST_AGENT">
      <div class="node-meta">
        <span class="node-idx">02 // COMPUTATION</span>
        <span class="node-badge badge-idle" id="badge-ANALYST_AGENT">READY</span>
      </div>
      <div class="node-name">ANALYST_AGENT</div>
      <div class="node-desc">Executes statistical calculations inside an isolated Python 3.14 sandbox to identify deviations.</div>
      <div class="node-details">
        <span>Python 3.14 Sandbox</span>
        <span>deterministic</span>
      </div>
    </div>

    <div class="node-bw" id="node-AUDITOR_AGENT">
      <div class="node-meta">
        <span class="node-idx">03 // COMPLIANCE</span>
        <span class="node-badge badge-idle" id="badge-AUDITOR_AGENT">READY</span>
      </div>
      <div class="node-name">AUDITOR_AGENT</div>
      <div class="node-desc">Evaluates observations strictly against configured ISO 10816-3 safety limits (PASS / WARN / FAIL).</div>
      <div class="node-details">
        <span>ISO 10816-3</span>
        <span>rule-engine</span>
      </div>
    </div>

    <div class="node-bw" id="node-SYNTHESIZER_AGENT">
      <div class="node-meta">
        <span class="node-idx">04 // REPORTING</span>
        <span class="node-badge badge-idle" id="badge-SYNTHESIZER_AGENT">READY</span>
      </div>
      <div class="node-name">SYNTHESIZER_AGENT</div>
      <div class="node-desc">Synthesizes evidence inventory, deterministic audits, and maintenance notes into final dossier.</div>
      <div class="node-details">
        <span>Markdown Dossier</span>
        <span>executive-verdict</span>
      </div>
    </div>
  </div>

  <div id="view-overview" class="grid-2col">
    <div class="panel-bw">
      <div class="panel-top">
        <span class="panel-title">Turbine Sensor Waveform (500 Records)</span>
        <div style="display:flex;gap:12px;font-family:'JetBrains Mono',monospace;font-size:10.5px;color:var(--text-muted)">
          <span><strong style="color:#ffffff">—</strong> Vibration (mm/s)</span>
          <span><span style="color:#888888">--</span> Temp (°C)</span>
          <span><span style="color:#444444">..</span> Limits</span>
        </div>
      </div>

      <div class="canvas-box">
        <canvas id="telemetryCanvas" width="1200" height="230"></canvas>
        <div class="chart-tooltip" id="chartTooltip"></div>
      </div>

      <div class="anomaly-deck">
        <div class="anom-card" onclick="highlightPoint(121)">
          <span class="anom-tag">ROW 121 · 09:30:00</span>
          <span class="anom-reading">5.20 mm/s</span>
          <span class="anom-thresh">Warning Limit: 4.50 mm/s</span>
        </div>
        <div class="anom-card" onclick="highlightPoint(238)">
          <span class="anom-tag">ROW 238 · 09:59:15</span>
          <span class="anom-reading">88.40 °C</span>
          <span class="anom-thresh">Warning Limit: 85.00 °C</span>
        </div>
        <div class="anom-card fail" onclick="highlightPoint(367)">
          <span class="anom-tag">ROW 367 · 10:31:30</span>
          <span class="anom-reading">8.30 mm/s (FAIL)</span>
          <span class="anom-thresh">Critical Limit: 7.10 mm/s</span>
        </div>
        <div class="anom-card fail" onclick="highlightPoint(442)">
          <span class="anom-tag">ROW 442 · 10:50:15</span>
          <span class="anom-reading">97.20 °C (FAIL)</span>
          <span class="anom-thresh">Critical Limit: 95.00 °C</span>
        </div>
      </div>
    </div>

    <div class="panel-bw">
      <div class="panel-top">
        <span class="panel-title">Executive Safety Dossier</span>
        <span class="stamp-fail">VERDICT: FAIL</span>
      </div>

      <div class="report-box" id="dossier-report">
        Loading generated sovereign safety report...
      </div>
    </div>
  </div>

  <div id="view-raw" style="display:none" class="panel-bw">
    <div class="panel-top">
      <span class="panel-title">Raw Telemetry Records (Turbine T-07 Sensor Log)</span>
      <span style="font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text-muted)">Showing Rows 1 to 100</span>
    </div>
    <div class="raw-table-box" id="raw-table-container">
      Loading sensor table...
    </div>
  </div>

  <div id="view-dossier-full" style="display:none" class="panel-bw">
    <div class="panel-top">
      <span class="panel-title">Executive Safety Dossier — Full Document</span>
      <span class="stamp-fail">VERDICT: FAIL</span>
    </div>
    <div class="report-box" id="dossier-report-full" style="height:550px">
      Loading dossier...
    </div>
  </div>

  <div id="view-stream-full" style="display:none" class="panel-bw">
    <div class="panel-top">
      <span class="panel-title">Orchestrator Live Event Log</span>
      <span style="font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text-muted)">Real-Time Matrix</span>
    </div>
    <div class="console-box" id="event-stream-full" style="height:550px">
      Initializing log stream...
    </div>
  </div>

  <div class="grid-bottom" id="view-bottom">
    <div class="panel-bw">
      <div class="panel-top">
        <span class="panel-title">Agent Health Matrix</span>
      </div>
      <div id="health-panel" style="font-size:11.5px">
        <div style="color:var(--text-dim)">Synchronizing telemetries...</div>
      </div>
    </div>

    <div class="panel-bw">
      <div class="panel-top">
        <span class="panel-title">Orchestrator Event Stream</span>
        <span style="font-family:'JetBrains Mono',monospace;font-size:10.5px;color:var(--text-dim)">Live</span>
      </div>
      <div class="console-box" id="event-stream">
        Initializing event stream...
      </div>
    </div>
  </div>

</main>

<script>
(function initParticles() {
  const canvas = document.getElementById('bg-particles');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let w = (canvas.width = window.innerWidth);
  let h = (canvas.height = window.innerHeight);

  window.addEventListener('resize', () => {
    w = canvas.width = window.innerWidth;
    h = canvas.height = window.innerHeight;
  });

  const particles = [];
  const count = 45;
  for (let i = 0; i < count; i++) {
    particles.push({
      x: Math.random() * w,
      y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.35,
      vy: (Math.random() - 0.5) * 0.35,
      r: Math.random() * 1.5 + 0.5,
    });
  }

  function render() {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#ffffff';
    for (let i = 0; i < count; i++) {
      const p = particles[i];
      p.x += p.vx;
      p.y += p.vy;
      if (p.x < 0) p.x = w;
      if (p.x > w) p.x = 0;
      if (p.y < 0) p.y = h;
      if (p.y > h) p.y = 0;

      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();

      for (let j = i + 1; j < count; j++) {
        const p2 = particles[j];
        const dist = Math.hypot(p.x - p2.x, p.y - p2.y);
        if (dist < 110) {
          ctx.strokeStyle = 'rgba(255, 255, 255, ' + (1 - dist / 110) * 0.08 + ')';
          ctx.lineWidth = 0.5;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p2.x, p2.y);
          ctx.stroke();
        }
      }
    }
    requestAnimationFrame(render);
  }
  render();
})();

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById('tab-' + tab);
  if (btn) btn.classList.add('active');

  const viewOverview = document.getElementById('view-overview');
  const viewRaw = document.getElementById('view-raw');
  const viewDossierFull = document.getElementById('view-dossier-full');
  const viewStreamFull = document.getElementById('view-stream-full');
  const viewBottom = document.getElementById('view-bottom');

  if (tab === 'overview') {
    if (viewOverview) viewOverview.style.display = 'grid';
    if (viewRaw) viewRaw.style.display = 'none';
    if (viewDossierFull) viewDossierFull.style.display = 'none';
    if (viewStreamFull) viewStreamFull.style.display = 'none';
    if (viewBottom) viewBottom.style.display = 'grid';
  } else if (tab === 'raw') {
    if (viewOverview) viewOverview.style.display = 'none';
    if (viewRaw) viewRaw.style.display = 'flex';
    if (viewDossierFull) viewDossierFull.style.display = 'none';
    if (viewStreamFull) viewStreamFull.style.display = 'none';
    if (viewBottom) viewBottom.style.display = 'none';
  } else if (tab === 'dossier') {
    if (viewOverview) viewOverview.style.display = 'none';
    if (viewRaw) viewRaw.style.display = 'none';
    if (viewDossierFull) viewDossierFull.style.display = 'flex';
    if (viewStreamFull) viewStreamFull.style.display = 'none';
    if (viewBottom) viewBottom.style.display = 'none';
    loadReport();
  } else if (tab === 'stream') {
    if (viewOverview) viewOverview.style.display = 'none';
    if (viewRaw) viewRaw.style.display = 'none';
    if (viewDossierFull) viewDossierFull.style.display = 'none';
    if (viewStreamFull) viewStreamFull.style.display = 'flex';
    if (viewBottom) viewBottom.style.display = 'none';
  }
}

function copyCli() {
  navigator.clipboard.writeText('maos run turbine-safety');
  alert('Copied to clipboard: maos run turbine-safety');
}

async function refresh() {
  try {
    const [stateResponse, logsResponse, healthResponse] = await Promise.all([
      fetch('/api/state'),
      fetch('/api/logs'),
      fetch('/api/health'),
    ]);
    if (!stateResponse.ok) throw new Error('State API returned HTTP ' + stateResponse.status);
    if (!logsResponse.ok) throw new Error('Logs API returned HTTP ' + logsResponse.status);
    const state = await stateResponse.json();
    const logsResult = await logsResponse.json();
    const logs = Array.isArray(logsResult) ? logsResult : [];
    window._health = healthResponse.ok ? await healthResponse.json() : { agents: [] };

    const setText = (id, value) => {
      const el = document.getElementById(id);
      if (el) el.textContent = String(value);
    };
    setText('stat-pending', state.queue?.pending ?? 0);
    setText('stat-active', state.queue?.active ?? 0);
    setText('stat-done', state.queue?.done ?? 0);
    setText('stat-runs', state.telemetry?.totalRuns ?? 0);
    const recent = Array.isArray(state.telemetry?.recent) ? state.telemetry.recent : [];
    const tokenTotal = recent.reduce((sum, run) => sum + Number(run.totalTokens || 0), 0);
    setText('stat-tokens', 'recent tokens: ' + tokenTotal.toLocaleString());
    setText('stat-cost', '$' + Number(state.telemetry?.totalCostUSD || 0).toFixed(4));
    setText('stat-updated', 'updated ' + new Date(state.timestamp || Date.now()).toLocaleTimeString());
    document.querySelectorAll('.live-stat').forEach(el => el.classList.remove('data-error'));

    try {
      const stages = ['INGEST_AGENT', 'ANALYST_AGENT', 'AUDITOR_AGENT', 'SYNTHESIZER_AGENT'];
      const activeAgent = state.workflow && state.workflow.activeAgent;

      for (const agentId of stages) {
        const node = document.getElementById('node-' + agentId);
        const badge = document.getElementById('badge-' + agentId);
        if (!node || !badge) continue;

        const st = (state.agents && state.agents[agentId] && state.agents[agentId].status) ? state.agents[agentId].status : 'IDLE';
        const isActive = activeAgent === agentId || st === 'BUSY';
        const isDone = st === 'DONE';

        node.classList.toggle('active', isActive);
        node.classList.toggle('done', isDone);

        if (isActive) {
          badge.className = 'node-badge badge-active';
          badge.textContent = 'ACTIVE';
        } else if (isDone) {
          badge.className = 'node-badge badge-done';
          badge.textContent = 'DONE';
        } else {
          badge.className = 'node-badge badge-idle';
          badge.textContent = 'READY';
        }
      }
    } catch (e) {
      console.warn('DAG state update error:', e);
    }

    try {
      const healthEl = document.getElementById('health-panel');
      if (healthEl && window._health && Array.isArray(window._health.agents) && window._health.agents.length > 0) {
        let html = '<table class="health-tbl">';
        html += '<tr class="health-hdr"><th>AGENT</th><th>STATE</th><th>RUNTIME</th><th>HEARTBEAT</th></tr>';
        for (const h of window._health.agents) {
          const hs = (h.state || 'idle').toLowerCase();
          const silent = h.lastHeartbeatAt ? Math.round((Date.now() - h.lastHeartbeatAt) / 1000) + 's' : (h.lastEventAt ? Math.round((Date.now() - h.lastEventAt) / 1000) + 's' : 'active');
          html += '<tr class="health-row">' +
            '<td class="health-agent">' + escapeHtml(h.agentId) + '</td>' +
            '<td style="color:' + (hs === 'healthy' ? '#ffffff' : 'var(--text-muted)') + '">&#9679; ' + escapeHtml(h.state || 'IDLE') + '</td>' +
            '<td class="health-rt">' + escapeHtml(h.runtimeType || 'local') + '</td>' +
            '<td class="health-hb">' + silent + '</td>' +
            '</tr>';
        }
        html += '</table>';
        healthEl.innerHTML = html;
      }
    } catch (e) {
      console.warn('Health matrix render error:', e);
    }

    try {
      const logHtml = logs.map(line => {
        let cls = 'log-gray';
        if (line.includes('[SUCCESS]') || line.includes('[ERROR]')) cls = 'log-white';
        return '<div class="' + cls + '">' + escapeHtml(line) + '</div>';
      }).join('');

      const logEl = document.getElementById('event-stream');
      const emptyLogs = '<div class="log-gray">No orchestrator log entries yet.</div>';
      if (logEl) {
        logEl.innerHTML = logHtml || emptyLogs;
        logEl.scrollTop = logEl.scrollHeight;
      }

      const logFullEl = document.getElementById('event-stream-full');
      if (logFullEl) {
        logFullEl.innerHTML = logHtml || emptyLogs;
        logFullEl.scrollTop = logFullEl.scrollHeight;
      }
    } catch (e) {
      console.warn('Log stream render error:', e);
    }

  } catch (err) {
    console.error('Refresh error:', err);
    const message = 'Dashboard data unavailable: ' + (err && err.message ? err.message : String(err));
    const logEl = document.getElementById('event-stream');
    const logFullEl = document.getElementById('event-stream-full');
    if (logEl) logEl.innerHTML = '<div class="log-white">' + escapeHtml(message) + '</div>';
    if (logFullEl) logFullEl.innerHTML = '<div class="log-white">' + escapeHtml(message) + '</div>';
    document.querySelectorAll('.live-stat').forEach(el => el.classList.add('data-error'));
  }
}

async function runSovereignAudit() {
  const btn = document.getElementById('btn-trigger-bw');
  const toast = document.getElementById('audit-status-toast');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span>⏳</span> DISPATCHING FLEET...';
  }
  if (toast) {
    toast.style.display = 'block';
    toast.innerHTML = '⚡ Enqueueing Sovereign Task (INGEST_AGENT)...';
  }
  try {
    const res = await fetch('/api/industrial/trigger', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      if (btn) btn.innerHTML = '<span>⚡</span> AUDIT ACTIVE...';
      if (toast) {
        toast.innerHTML = '● Task Dispatched [ID: ' + (data.task?.id || 'INGEST_AGENT') + '] — Fleet Processing';
      }
      setTimeout(refresh, 400);
      setTimeout(() => {
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = '<span>▶</span> RUN SOVEREIGN AUDIT';
        }
      }, 12000);
    } else {
      if (toast) toast.innerHTML = '❌ Error: ' + (data.error || 'Failed to dispatch');
      if (btn) { btn.disabled = false; btn.innerHTML = '<span>▶</span> RUN SOVEREIGN AUDIT'; }
    }
  } catch (err) {
    if (toast) toast.innerHTML = '❌ Network Error: ' + err.message;
    if (btn) { btn.disabled = false; btn.innerHTML = '<span>▶</span> RUN SOVEREIGN AUDIT'; }
  }
}

let chartDataCache = null;
let hoveredIndex = -1;

async function initTelemetry() {
  const canvas = document.getElementById('telemetryCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  try {
    const res = await fetch('/api/industrial/chart-data');
    chartDataCache = await res.json();
    drawBwChart(canvas, ctx, chartDataCache);
    renderRawTable(chartDataCache);

    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      const mouseX = (e.clientX - rect.left) * (canvas.width / rect.width);
      const padL = 34, padR = 24;
      const gW = canvas.width - padL - padR;

      if (mouseX >= padL && mouseX <= canvas.width - padR) {
        const ratio = (mouseX - padL) / gW;
        hoveredIndex = Math.round(ratio * (chartDataCache.points.length - 1));
        drawBwChart(canvas, ctx, chartDataCache);
        showTooltip(e, chartDataCache.points[hoveredIndex]);
      }
    });

    canvas.addEventListener('mouseleave', () => {
      hoveredIndex = -1;
      drawBwChart(canvas, ctx, chartDataCache);
      const tooltip = document.getElementById('chartTooltip');
      if (tooltip) tooltip.style.display = 'none';
    });

  } catch (err) {
    console.error('Chart load error:', err);
  }
}

function showTooltip(e, p) {
  const tooltip = document.getElementById('chartTooltip');
  if (!tooltip || !p) return;
  const canvas = document.getElementById('telemetryCanvas');
  const rect = canvas.getBoundingClientRect();

  tooltip.innerHTML = 
    '<div style="font-weight:700;color:#ffffff;margin-bottom:3px">Row ' + p.row + ' · ' + p.time + '</div>' +
    '<div>Vibration: <strong>' + p.vib.toFixed(2) + ' mm/s</strong> (Limit: 7.10)</div>' +
    '<div>Bearing Temp: <strong>' + p.temp.toFixed(2) + ' °C</strong> (Limit: 95.0)</div>' +
    '<div style="color:var(--text-muted);margin-top:2px">RPM: ' + p.rpm + ' · Load: ' + p.load + '%</div>' +
    '<div style="margin-top:3px;font-weight:700">Verdict: ' + p.severity + '</div>';

  tooltip.style.display = 'block';
  tooltip.style.left = Math.min(e.clientX - rect.left + 15, rect.width - 200) + 'px';
  tooltip.style.top = Math.max(e.clientY - rect.top - 70, 10) + 'px';
}

function highlightPoint(row) {
  if (!chartDataCache) return;
  const idx = chartDataCache.points.findIndex(p => p.row === row);
  if (idx !== -1) {
    hoveredIndex = idx;
    const canvas = document.getElementById('telemetryCanvas');
    const ctx = canvas.getContext('2d');
    drawBwChart(canvas, ctx, chartDataCache);
  }
}

function drawBwChart(canvas, ctx, data) {
  if (!data || !data.points || data.points.length === 0) return;
  const pts = data.points;
  const w = canvas.width;
  const h = canvas.height;
  const padL = 34, padR = 24, padT = 18, padB = 24;
  const gW = w - padL - padR;
  const gH = h - padT - padB;

  ctx.clearRect(0, 0, w, h);

  ctx.strokeStyle = '#181818';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = padT + (gH / 4) * i;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
  }

  const vibMax = 10;
  const tempMin = 50, tempMax = 110;

  function xFor(i) { return padL + (i / (pts.length - 1)) * gW; }
  function yVib(v) { return padT + gH - (Math.min(v, vibMax) / vibMax) * gH; }
  function yTemp(t) { return padT + gH - ((Math.min(Math.max(t, tempMin), tempMax) - tempMin) / (tempMax - tempMin)) * gH; }

  const vibWarnY = yVib(data.thresholds.vibration.warning);
  const vibCritY = yVib(data.thresholds.vibration.critical);

  ctx.setLineDash([3, 3]);
  ctx.strokeStyle = '#444444';
  ctx.beginPath(); ctx.moveTo(padL, vibWarnY); ctx.lineTo(w - padR, vibWarnY); ctx.stroke();

  ctx.strokeStyle = '#666666';
  ctx.beginPath(); ctx.moveTo(padL, vibCritY); ctx.lineTo(w - padR, vibCritY); ctx.stroke();
  ctx.setLineDash([]);

  const grad = ctx.createLinearGradient(0, padT, 0, padT + gH);
  grad.addColorStop(0, 'rgba(255, 255, 255, 0.12)');
  grad.addColorStop(1, 'rgba(255, 255, 255, 0.0)');

  ctx.beginPath();
  ctx.moveTo(xFor(0), yVib(pts[0].vib));
  for (let i = 1; i < pts.length; i++) {
    ctx.lineTo(xFor(i), yVib(pts[i].vib));
  }
  ctx.lineTo(xFor(pts.length - 1), padT + gH);
  ctx.lineTo(xFor(0), padT + gH);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const x = xFor(i);
    const y = yVib(pts[i].vib);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  ctx.strokeStyle = '#777777';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const x = xFor(i);
    const y = yTemp(pts[i].temp);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  if (hoveredIndex >= 0 && hoveredIndex < pts.length) {
    const hx = xFor(hoveredIndex);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    ctx.beginPath(); ctx.moveTo(hx, padT); ctx.lineTo(hx, padT + gH); ctx.stroke();
    ctx.setLineDash([]);
  }

  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (!p.anomaly) continue;
    const x = xFor(i);
    const y = p.vib >= data.thresholds.vibration.warning ? yVib(p.vib) : yTemp(p.temp);
    const isFail = p.severity === 'FAIL';

    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.fillStyle = isFail ? 'rgba(255, 255, 255, 0.25)' : 'rgba(255, 255, 255, 0.12)';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 9px monospace';
    ctx.fillText('R' + p.row, x - 8, y - 10);
  }
}

function renderRawTable(data) {
  const container = document.getElementById('raw-table-container');
  if (!container || !data || !data.rawRows) return;
  const rows = data.rawRows;

  let html = '<table><thead><tr><th>ROW</th><th>TIMESTAMP</th><th>VIBRATION RMS</th><th>BEARING TEMP</th><th>RPM</th><th>LOAD %</th><th>STATUS</th></tr></thead><tbody>';
  for (const r of rows) {
    const isAnom = r.anomaly;
    html += '<tr class="' + (isAnom ? 'anomaly-row' : '') + '">' +
      '<td>' + r.row + '</td>' +
      '<td>' + r.time + '</td>' +
      '<td>' + r.vib.toFixed(2) + ' mm/s</td>' +
      '<td>' + r.temp.toFixed(2) + ' °C</td>' +
      '<td>' + r.rpm + '</td>' +
      '<td>' + r.load + '%</td>' +
      '<td>' + (isAnom ? '<strong>' + r.severity + '</strong>' : 'NORMAL') + '</td>' +
      '</tr>';
  }
  html += '</tbody></table>';
  container.innerHTML = html;
}

function parseMarkdown(md) {
  if (!md) return '';
  const lines = md.split('\\n');
  let html = '';
  let inTable = false;
  let inCode = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.startsWith('\x60\x60\x60')) {
      inCode = !inCode;
      html += inCode ? '<pre class="md-pre">' : '</pre>';
      continue;
    }
    if (inCode) {
      html += escapeHtml(line) + '\\n';
      continue;
    }

    if (line.startsWith('|') && line.endsWith('|')) {
      if (!inTable) {
        inTable = true;
        html += '<table>';
      }
      if (line.includes('---')) continue;
      const cells = line.split('|').map(c => c.trim()).filter((_, idx, arr) => idx > 0 && idx < arr.length - 1);
      const isHeader = !html.includes('<tbody>');
      if (isHeader && !html.includes('<thead>')) {
        html += '<thead><tr>' + cells.map(c => '<th>' + formatInline(c) + '</th>').join('') + '</tr></thead><tbody>';
      } else {
        html += '<tr>' + cells.map(c => '<td>' + formatInline(c) + '</td>').join('') + '</tr>';
      }
      continue;
    } else if (inTable) {
      inTable = false;
      html += '</tbody></table>';
    }

    if (line.startsWith('# ')) {
      html += '<h2 class="md-h2">' + formatInline(line.slice(2)) + '</h2>';
    } else if (line.startsWith('## ')) {
      html += '<h3 class="md-h3">' + formatInline(line.slice(3)) + '</h3>';
    } else if (line.startsWith('### ')) {
      html += '<h4 class="md-h4">' + formatInline(line.slice(4)) + '</h4>';
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      html += '<div class="md-li">' + formatInline(line.slice(2)) + '</div>';
    } else if (line.length > 0) {
      html += '<p class="md-p">' + formatInline(line) + '</p>';
    }
  }

  if (inTable) html += '</tbody></table>';
  return html;
}

function formatInline(str) {
  return escapeHtml(str)
    .replace(/\*\*(.*?)\*\*/g, '<strong class="md-bold">$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(new RegExp('\x60([^\x60]+)\x60', 'g'), '<code class="md-code">$1</code>')
    .replace(/\bFAIL\b/g, '<span class="md-fail">FAIL</span>')
    .replace(/\bWARNING\b/g, '<span class="md-warn">WARNING</span>')
    .replace(/\bPASS\b/g, '<span class="md-pass">PASS</span>');
}

async function loadReport() {
  const el = document.getElementById('dossier-report');
  const fullEl = document.getElementById('dossier-report-full');
  try {
    const res = await fetch('/api/industrial/report');
    const data = await res.json();
    if (data.exists && data.content) {
      const parsed = parseMarkdown(data.content);
      if (el) el.innerHTML = parsed;
      if (fullEl) fullEl.innerHTML = parsed;
    } else {
      if (el) el.textContent = 'Report not yet compiled. Click "RUN SOVEREIGN AUDIT" above.';
      if (fullEl) fullEl.textContent = 'Report not yet compiled. Click "RUN SOVEREIGN AUDIT" above.';
    }
  } catch {
    if (el) el.textContent = 'Unable to load report.';
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

refresh();
setInterval(refresh, 2000);
initTelemetry();
loadReport();
setInterval(loadReport, 5000);
</script>
</body>
</html>`;
}
