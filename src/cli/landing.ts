/**
 * MAOS Landing Page
 * Beautiful, interactive introduction to MAOS for new users
 */

export function getLandingHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>MAOS — Multi-Agent Orchestrator System</title>
<style>
  :root {
    --bg: #0a0a0f;
    --surface: #12121a;
    --surface2: #1a1a28;
    --surface3: #22222f;
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
    --pink: #ec4899;
  }

  * {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
  }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    overflow-x: hidden;
  }

  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600&display=swap');

  /* ─── Navigation ─── */
  .navbar {
    position: sticky;
    top: 0;
    z-index: 100;
    background: rgba(10, 10, 15, 0.8);
    backdrop-filter: blur(10px);
    border-bottom: 1px solid var(--border);
    padding: 16px 32px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .navbar-brand {
    font-size: 24px;
    font-weight: 800;
    background: linear-gradient(135deg, var(--accent) 0%, var(--cyan) 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .navbar-links {
    display: flex;
    gap: 32px;
    align-items: center;
  }

  .navbar-links a {
    color: var(--text-dim);
    text-decoration: none;
    font-size: 14px;
    font-weight: 500;
    transition: color 0.3s;
  }

  .navbar-links a:hover {
    color: var(--accent);
  }

  .btn-primary {
    background: linear-gradient(135deg, var(--accent) 0%, var(--accent2) 100%);
    color: white;
    padding: 10px 20px;
    border-radius: 8px;
    border: none;
    font-weight: 600;
    cursor: pointer;
    transition: transform 0.2s, box-shadow 0.2s;
    font-size: 14px;
  }

  .btn-primary:hover {
    transform: translateY(-2px);
    box-shadow: 0 8px 24px rgba(99, 102, 241, 0.3);
  }

  /* ─── Hero Section ─── */
  .hero {
    padding: 80px 32px;
    text-align: center;
    background: linear-gradient(135deg, rgba(99, 102, 241, 0.05) 0%, rgba(6, 182, 212, 0.05) 100%);
    border-bottom: 1px solid var(--border);
  }

  .hero-badge {
    display: inline-block;
    background: rgba(99, 102, 241, 0.1);
    color: var(--accent2);
    padding: 8px 16px;
    border-radius: 20px;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 1px;
    margin-bottom: 24px;
    border: 1px solid rgba(99, 102, 241, 0.2);
  }

  .hero h1 {
    font-size: 56px;
    font-weight: 900;
    margin-bottom: 16px;
    background: linear-gradient(135deg, #e0e0e8 0%, var(--accent2) 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    letter-spacing: -1px;
  }

  .hero p {
    font-size: 20px;
    color: var(--text-dim);
    max-width: 700px;
    margin: 0 auto 32px;
    line-height: 1.6;
  }

  .hero-buttons {
    display: flex;
    gap: 16px;
    justify-content: center;
    flex-wrap: wrap;
  }

  .btn-secondary {
    background: var(--surface);
    color: var(--text);
    padding: 12px 24px;
    border-radius: 8px;
    border: 1px solid var(--border);
    font-weight: 600;
    cursor: pointer;
    transition: all 0.3s;
    font-size: 14px;
  }

  .btn-secondary:hover {
    border-color: var(--accent);
    background: var(--surface2);
    transform: translateY(-2px);
  }

  /* ─── Features Grid ─── */
  .features {
    padding: 80px 32px;
    max-width: 1200px;
    margin: 0 auto;
  }

  .section-title {
    font-size: 36px;
    font-weight: 800;
    margin-bottom: 48px;
    text-align: center;
  }

  .features-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 24px;
    margin-bottom: 60px;
  }

  .feature-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 32px;
    transition: all 0.3s;
  }

  .feature-card:hover {
    border-color: var(--accent);
    transform: translateY(-4px);
    box-shadow: 0 16px 48px rgba(99, 102, 241, 0.1);
  }

  .feature-icon {
    font-size: 32px;
    margin-bottom: 16px;
  }

  .feature-card h3 {
    font-size: 18px;
    font-weight: 700;
    margin-bottom: 12px;
  }

  .feature-card p {
    color: var(--text-dim);
    font-size: 14px;
    line-height: 1.6;
  }

  /* ─── Problem/Solution Section ─── */
  .problem-solution {
    padding: 80px 32px;
    background: linear-gradient(135deg, rgba(99, 102, 241, 0.03) 0%, rgba(6, 182, 212, 0.03) 100%);
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
  }

  .problem-solution-content {
    max-width: 1200px;
    margin: 0 auto;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 48px;
    align-items: center;
  }

  .problem-solution h2 {
    font-size: 28px;
    font-weight: 800;
    margin-bottom: 24px;
  }

  .problem-solution ul {
    list-style: none;
    gap: 16px;
    display: flex;
    flex-direction: column;
  }

  .problem-solution li {
    display: flex;
    gap: 12px;
    font-size: 14px;
    line-height: 1.6;
  }

  .problem-solution li:before {
    content: '✓';
    color: var(--green);
    font-weight: 700;
    flex-shrink: 0;
  }

  .problem-section h2 { color: var(--red); }
  .solution-section h2 { color: var(--green); }

  /* ─── How It Works ─── */
  .how-it-works {
    padding: 80px 32px;
    max-width: 1200px;
    margin: 0 auto;
  }

  .workflow-diagram {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 40px;
    margin-top: 40px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    overflow-x: auto;
    line-height: 1.8;
  }

  .workflow-step {
    color: var(--cyan);
    margin: 8px 0;
  }

  .workflow-arrow {
    color: var(--text-dim);
    margin: 4px 0;
    text-align: center;
  }

  /* ─── Quick Start ─── */
  .quick-start {
    padding: 80px 32px;
    background: linear-gradient(135deg, rgba(99, 102, 241, 0.05) 0%, rgba(168, 85, 247, 0.05) 100%);
    border-top: 1px solid var(--border);
  }

  .quick-start-content {
    max-width: 800px;
    margin: 0 auto;
  }

  .quick-start h2 {
    font-size: 28px;
    font-weight: 800;
    margin-bottom: 32px;
    text-align: center;
  }

  .steps {
    display: grid;
    gap: 24px;
  }

  .step {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 24px;
    display: flex;
    gap: 20px;
  }

  .step-number {
    flex-shrink: 0;
    width: 40px;
    height: 40px;
    background: linear-gradient(135deg, var(--accent) 0%, var(--accent2) 100%);
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 18px;
  }

  .step-content h3 {
    font-weight: 600;
    margin-bottom: 8px;
  }

  .step-content p {
    color: var(--text-dim);
    font-size: 13px;
    line-height: 1.6;
  }

  .code-snippet {
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px 16px;
    margin-top: 8px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    color: var(--cyan);
    overflow-x: auto;
  }

  /* ─── Agents Showcase ─── */
  .agents-showcase {
    padding: 80px 32px;
    max-width: 1200px;
    margin: 0 auto;
  }

  .agents-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
    gap: 20px;
    margin-top: 40px;
  }

  .agent-badge {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 24px;
    text-align: center;
    transition: all 0.3s;
  }

  .agent-badge:hover {
    border-color: var(--accent);
    background: var(--surface2);
    transform: scale(1.05);
  }

  .agent-emoji {
    font-size: 48px;
    margin-bottom: 12px;
  }

  .agent-badge h3 {
    font-weight: 700;
    margin-bottom: 8px;
  }

  .agent-badge p {
    color: var(--text-dim);
    font-size: 13px;
    line-height: 1.6;
  }

  /* ─── CTA Section ─── */
  .cta {
    padding: 60px 32px;
    background: linear-gradient(135deg, var(--accent) 0%, var(--purple) 100%);
    text-align: center;
    border-top: 1px solid var(--border);
  }

  .cta h2 {
    font-size: 32px;
    font-weight: 800;
    margin-bottom: 16px;
    color: white;
  }

  .cta p {
    font-size: 16px;
    color: rgba(255, 255, 255, 0.9);
    margin-bottom: 24px;
  }

  .btn-cta {
    background: white;
    color: var(--accent);
    padding: 14px 32px;
    border-radius: 8px;
    border: none;
    font-weight: 700;
    font-size: 16px;
    cursor: pointer;
    transition: all 0.3s;
    display: inline-block;
  }

  .btn-cta:hover {
    transform: scale(1.05);
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.3);
  }

  /* ─── Footer ─── */
  .footer {
    background: var(--surface);
    border-top: 1px solid var(--border);
    padding: 40px 32px;
    text-align: center;
    color: var(--text-dim);
    font-size: 13px;
  }

  .footer a {
    color: var(--accent);
    text-decoration: none;
    transition: color 0.3s;
  }

  .footer a:hover {
    color: var(--accent2);
  }

  /* ─── Responsive ─── */
  @media (max-width: 768px) {
    .hero h1 {
      font-size: 36px;
    }

    .hero p {
      font-size: 16px;
    }

    .navbar {
      flex-direction: column;
      gap: 16px;
    }

    .problem-solution-content {
      grid-template-columns: 1fr;
    }

    .features-grid {
      grid-template-columns: 1fr;
    }

    .hero-buttons {
      flex-direction: column;
    }

    .section-title {
      font-size: 28px;
    }
  }

  /* ─── Animations ─── */
  @keyframes fadeIn {
    from {
      opacity: 0;
      transform: translateY(20px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .hero {
    animation: fadeIn 0.8s ease-out;
  }

  .feature-card {
    animation: fadeIn 0.6s ease-out;
    animation-fill-mode: both;
  }

  .feature-card:nth-child(1) { animation-delay: 0s; }
  .feature-card:nth-child(2) { animation-delay: 0.1s; }
  .feature-card:nth-child(3) { animation-delay: 0.2s; }
  .feature-card:nth-child(4) { animation-delay: 0.3s; }
  .feature-card:nth-child(5) { animation-delay: 0.4s; }
  .feature-card:nth-child(6) { animation-delay: 0.5s; }
</style>
</head>
<body>

<!-- Navigation -->
<nav class="navbar">
  <div class="navbar-brand">🤖 MAOS</div>
  <div class="navbar-links">
    <a href="#features">Features</a>
    <a href="#how">How It Works</a>
    <a href="#quickstart">Get Started</a>
    <a href="https://github.com/Amitakshya333/maos" target="_blank">GitHub</a>
    <button class="btn-primary" onclick="location.href='/dashboard'">Dashboard →</button>
  </div>
</nav>

<!-- Hero Section -->
<section class="hero">
  <div class="hero-badge">ORCHESTRATE AI AGENTS</div>
  <h1>Multi-Agent Orchestrator System</h1>
  <p>Docker-Compose for AI coding agents. Define, decompose, and execute a fleet of AI agents in parallel on a single codebase.</p>
  <div class="hero-buttons">
    <button class="btn-primary" onclick="document.getElementById('quickstart').scrollIntoView({behavior:'smooth'})">Get Started →</button>
    <button class="btn-secondary" onclick="location.href='https://github.com/Amitakshya333/maos#readme'" target="_blank">Learn More</button>
  </div>
</section>

<!-- Features Section -->
<section class="features" id="features">
  <h2 class="section-title">Why MAOS?</h2>
  <div class="features-grid">
    <div class="feature-card">
      <div class="feature-icon">🧠</div>
      <h3>Intelligent Routing</h3>
      <p>AI-powered capability matching automatically routes tasks to the best agent based on skills, complexity, and cost.</p>
    </div>
    <div class="feature-card">
      <div class="feature-icon">⚡</div>
      <h3>Parallel Execution</h3>
      <p>Run multiple agents concurrently on isolated git branches. No conflicts, no waiting. Maximum throughput.</p>
    </div>
    <div class="feature-card">
      <div class="feature-icon">🔗</div>
      <h3>Multi-Provider Support</h3>
      <p>12+ LLM providers (GPT-5, Claude, Gemini, DeepSeek, local models) through one unified interface.</p>
    </div>
    <div class="feature-card">
      <div class="feature-icon">📊</div>
      <h3>Cost & Token Analytics</h3>
      <p>Real-time spend tracking, cost-aware routing, and detailed telemetry across your entire fleet.</p>
    </div>
    <div class="feature-card">
      <div class="feature-icon">🔐</div>
      <h3>Safety & Isolation</h3>
      <p>Git branch isolation, scope enforcement, credential protection, and automatic crash recovery.</p>
    </div>
    <div class="feature-card">
      <div class="feature-icon">🌐</div>
      <h3>Web Dashboard</h3>
      <p>Real-time fleet visualization with live task tracking, agent status, and health monitoring.</p>
    </div>
  </div>
</section>

<!-- Problem/Solution Section -->
<section class="problem-solution">
  <div class="problem-solution-content">
    <div class="problem-section">
      <h2>The Problem</h2>
      <ul>
        <li><strong>Single-threaded:</strong> One AI model at a time, one task at a time</li>
        <li><strong>Context wall:</strong> Large goals exceed token limits of any single model</li>
        <li><strong>Write conflicts:</strong> Multiple agents corrupt files when working in parallel</li>
        <li><strong>Invisible chaos:</strong> No visibility into concurrent agent execution</li>
        <li><strong>Cost black hole:</strong> No tracking of tokens, spending, or efficiency</li>
      </ul>
    </div>
    <div class="solution-section">
      <h2>The MAOS Solution</h2>
      <ul>
        <li><strong>Multi-threaded:</strong> Unlimited parallel agents, each with their own branch</li>
        <li><strong>Task decomposition:</strong> AI breaks complex goals into capability-tagged subtasks</li>
        <li><strong>Conflict prevention:</strong> Semantic file locking and branch isolation</li>
        <li><strong>Full observability:</strong> Real-time dashboard with health monitoring</li>
        <li><strong>Cost optimization:</strong> Intelligent routing + detailed spend analytics</li>
      </ul>
    </div>
  </div>
</section>

<!-- How It Works -->
<section class="how-it-works" id="how">
  <h2 class="section-title">How It Works</h2>
  <p style="text-align: center; color: var(--text-dim); margin-bottom: 32px;">MAOS follows a simple Plan → Route → Execute → Report cycle</p>
  <div class="workflow-diagram">
    <div class="workflow-step">┌─ User Goal: "Build a landing page with auth"</div>
    <div class="workflow-arrow">  │</div>
    <div class="workflow-step">├─ Decomposer breaks it into subtasks</div>
    <div class="workflow-step">│  ├─ Task 1: "Create auth backend" (backend)</div>
    <div class="workflow-step">│  ├─ Task 2: "Build login UI" (frontend)</div>
    <div class="workflow-step">│  └─ Task 3: "Write tests" (testing)</div>
    <div class="workflow-arrow">  │</div>
    <div class="workflow-step">├─ Router scores agents by capability match</div>
    <div class="workflow-arrow">  │</div>
    <div class="workflow-step">├─ Agents execute in parallel on isolated branches</div>
    <div class="workflow-step">│  ├─ DEV (Claude) → maos/dev/task-1</div>
    <div class="workflow-step">│  ├─ DESIGNER (Gemini) → maos/designer/task-2</div>
    <div class="workflow-step">│  └─ TESTER (GPT-5) → maos/tester/task-3</div>
    <div class="workflow-arrow">  │</div>
    <div class="workflow-step">├─ Health monitor tracks agent status & incidents</div>
    <div class="workflow-arrow">  │</div>
    <div class="workflow-step">└─ Telemetry aggregates cost, tokens, and timing</div>
  </div>
</section>

<!-- Agents Showcase -->
<section class="agents-showcase">
  <h2 class="section-title">Meet Your Fleet</h2>
  <div class="agents-grid">
    <div class="agent-badge">
      <div class="agent-emoji">🧠</div>
      <h3>ARCHITECT</h3>
      <p>Strategic planning and system design. Decomposes goals into capability-tagged subtasks.</p>
    </div>
    <div class="agent-badge">
      <div class="agent-emoji">⚙️</div>
      <h3>BACKEND_DEV</h3>
      <p>API design, database schema, business logic, and server-side implementation.</p>
    </div>
    <div class="agent-badge">
      <div class="agent-emoji">🎨</div>
      <h3>FRONTEND_DEV</h3>
      <p>UI components, styling, layout, and client-side interactivity.</p>
    </div>
    <div class="agent-badge">
      <div class="agent-emoji">🧪</div>
      <h3>TESTER</h3>
      <p>Unit tests, integration tests, and quality assurance automation.</p>
    </div>
    <div class="agent-badge">
      <div class="agent-emoji">💻</div>
      <h3>CLI_AGENT</h3>
      <p>Runs any CLI tool or local model. Copilot, Codex, Claude Code integration.</p>
    </div>
    <div class="agent-badge">
      <div class="agent-emoji">🤖</div>
      <h3>CUSTOM</h3>
      <p>Define your own agents with custom roles, capabilities, and cost parameters.</p>
    </div>
  </div>
</section>

<!-- Quick Start -->
<section class="quick-start" id="quickstart">
  <div class="quick-start-content">
    <h2>Quick Start in 5 Steps</h2>
    <div class="steps">
      <div class="step">
        <div class="step-number">1</div>
        <div class="step-content">
          <h3>Install MAOS</h3>
          <p>Install the CLI globally or use with npx</p>
          <div class="code-snippet">npm install -g maosorch</div>
        </div>
      </div>
      <div class="step">
        <div class="step-number">2</div>
        <div class="step-content">
          <h3>Initialize Your Project</h3>
          <p>Set up MAOS in your project directory</p>
          <div class="code-snippet">cd your-project && maos init</div>
        </div>
      </div>
      <div class="step">
        <div class="step-number">3</div>
        <div class="step-content">
          <h3>Configure API Keys</h3>
          <p>Add your LLM provider credentials</p>
          <div class="code-snippet">maos configure</div>
        </div>
      </div>
      <div class="step">
        <div class="step-number">4</div>
        <div class="step-content">
          <h3>Decompose Your Goal</h3>
          <p>Let AI break your goal into subtasks</p>
          <div class="code-snippet">maos plan "Build a todo app with auth"</div>
        </div>
      </div>
      <div class="step">
        <div class="step-number">5</div>
        <div class="step-content">
          <h3>Run the Orchestrator</h3>
          <p>Watch your fleet work in parallel</p>
          <div class="code-snippet">maos start && maos dashboard</div>
        </div>
      </div>
    </div>
  </div>
</section>

<!-- CTA Section -->
<section class="cta">
  <h2>Ready to Orchestrate Your AI Fleet?</h2>
  <p>Start building with MAOS today. Free tier available through Freemodel API.</p>
  <button class="btn-cta" onclick="location.href='https://github.com/Amitakshya333/maos#readme'">Get Started Now</button>
</section>

<!-- Footer -->
<footer class="footer">
  <p>MAOS v0.3.0 © <a href="https://github.com/Amitakshya333">Amitakshya Sutar</a></p>
  <p style="margin-top: 8px;">Multi-Agent Orchestrator System — <a href="https://github.com/Amitakshya333/maos">GitHub</a> · <a href="https://www.npmjs.com/package/maosorch">npm</a></p>
</footer>

<script>
  // Smooth scroll for navigation links
  document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function(e) {
      const href = this.getAttribute('href');
      if (href !== '#') {
        e.preventDefault();
        const target = document.querySelector(href);
        if (target) {
          target.scrollIntoView({ behavior: 'smooth' });
        }
      }
    });
  });

  // Detect if user can access /dashboard and show it as active
  fetch('/api/state', { method: 'HEAD' })
    .then(() => {
      // Dashboard is available, maybe highlight it
    })
    .catch(() => {
      // Dashboard not available yet
    });
</script>

</body>
</html>`;
}
