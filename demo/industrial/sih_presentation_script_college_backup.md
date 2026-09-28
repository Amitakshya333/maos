# SIH 2025 — Presentation Script
## Team CodeSplinter · PS ID 26117 · Smart Automation

> **Total Duration**: 6–7 minutes  
> **Speaker Discipline**: No filler words. No rushed reading. Every sentence earns its place.  
> **Golden Rule**: Speak TO the judges, not AT the slides. Glance at the slide only to point.

---

## 📋 Quick Reference — Slide Map

| Slide | Title | Time | Core Job |
|-------|-------|------|----------|
| 1 | Title Page | 0:00 – 1:15 | Hook + Problem Framing |
| 2 | Proposed Solution | 1:15 – 2:45 | What we built & why it's different |
| 3 | Technical Approach | 2:45 – 4:15 | Under the hood — architecture & stack |
| 4 | Feasibility & Viability | 4:15 – 5:15 | Risk awareness & honest limitations |
| 5 | Impact & Benefits | 5:15 – 6:30 | Scale path & closing punch |
| 6 | Research & References | 6:30 – 7:00 | Validation evidence & final line |

---

## SLIDE 1 — TITLE PAGE
**⏱ 0:00 – 1:15 (75 seconds)**

> **Goal**: Create tension. Make judges FEEL the problem before you name the solution.

---

*(Walk to center. Make eye contact with judges. Hold one second of silence.)*

"Two thousand twenty-five. India operates nuclear reactors, launches satellites, builds hypersonic missiles.

The AI exists to analyse every sensor reading, every maintenance log, every safety threshold inside these systems.

But here is the paradox—"

*(Pause. Lower voice slightly.)*

"ISRO cannot send its telemetry to ChatGPT.  
DRDO cannot upload missile test data to Claude.  
A nuclear power plant cannot pipe reactor vibration logs through a cloud API."

*(Beat.)*

"So the question is NOT — 'Is AI powerful enough?'  
The question is — **can AI be powerful, intelligent, and completely sovereign?**"

*(Pause. Straighten posture.)*

"Good morning, respected judges.

We are **Team CodeSplinter**, and our solution is **MAOS Industrial** — a sovereign, evidence-based, multi-agent AI workbench for confidential industrial operations.

Problem Statement ID: 26117. Theme: Smart Automation. Category: Software."

*(Click to Slide 2.)*

---

## SLIDE 2 — PROPOSED SOLUTION
**⏱ 1:15 – 2:45 (90 seconds)**

> **Goal**: Explain WHAT we built in one clean mental model. Make the 4-agent pipeline unforgettable.

---

"So what did we actually build?

We built a **four-agent pipeline** that reads industrial sensor data and maintenance evidence, and produces a **deterministic PASS, WARNING, or FAIL** safety verdict — entirely on an offline workstation.

Let me walk you through one real scenario."

*(Point to pipeline diagram on slide.)*

"Imagine a gas turbine suddenly shows abnormal vibration at 2 AM. The engineer doesn't just need the AI to say 'there's a problem.' They need to know:  
*Which* sensor spiked?  
*Which* safety rule was violated?  
*What* evidence supports this conclusion?  
And — *can I trust it?*"

"This is where our four agents come in."

*(Point to each agent as you name it. Use your hand to trace the flow left-to-right.)*

"**Agent One — Sensor Ingest.** It reads the raw CSV logs and maintenance documents on an isolated, offline workstation. Zero external exposure.

**Agent Two — Rule Evaluator.** It checks every reading against **plant-owned** safety thresholds — not some generic model assumption — and computes a deterministic PASS, WARNING, or FAIL.

**Agent Three — Evidence Compiler.** It cross-references the finding with the specific sensor data point, the threshold rule that was violated, and the maintenance history — so every verdict has transparent backing.

**Agent Four — Report Generator.** It compiles everything into a structured diagnostic report that the plant engineer can review, question, and approve."

*(Pause. Look directly at judges.)*

"And here is the **critical design decision** — we do NOT allow the language model to be the final safety authority.

The AI provides intelligence.  
The deterministic rules control classification.  
The evidence explains the decision.  
And the **engineer signs off** before anything is finalized.

We are not replacing the engineer. We are building a co-pilot the engineer can actually **trust**."

*(Click to Slide 3.)*

---

## SLIDE 3 — TECHNICAL APPROACH
**⏱ 2:45 – 4:15 (90 seconds)**

> **Goal**: Show technical depth without drowning in jargon. Prove you BUILT this, not just designed a PPT.

---

"Now let me show you what's under the hood."

*(Gesture toward the tech stack grid on the left side of the slide.)*

"At the centre of MAOS is our orchestrator engine, written in **TypeScript on Node.js**. It coordinates all four agents, manages the task queue, and controls the flow of information between them.

For the intelligence layer, we run **open-weight models locally** — specifically Qwen 2.5 3B Instruct through HuggingFace Transformers, served via a FastAPI server running on a local GPU."

*(Point to the flowchart on the right side.)*

"This is the actual execution flow. When a task enters the system:

The **Adaptive Router** scores every available agent based on capability match, cost, and health status — then dispatches the task to the best fit.

The agent executes through a **tool-calling loop** — reading files, running Python analysis, checking compliance — while a **Supervisor** watches for stalls and automatically nudges or retries if anything gets stuck."

*(Pause. This is the money line.)*

"But here's what makes this architecture different from a typical AI wrapper:

**The safety logic is completely separated from the language model.**

We use plant-owned, versioned JSON threshold rulesets. So if Plant A in Gujarat has one vibration limit and Plant B in Tamil Nadu has a different one — the system doesn't assume a universal rule. **The plant owns its rules. The plant owns its evidence. The plant controls its AI.**"

*(Point to State Storage and Dashboard blocks.)*

"All state is stored on the local filesystem — JSON and Markdown files. No database dependency. No cloud sync. And we have a real-time **mission control dashboard** at localhost:3847 where the operator can watch agent execution, scrub sensor waveforms, and inspect the event log — live."

*(Deliver this line slowly, looking at judges.)*

"The model provides intelligence. But the **architecture** provides control. And in safety-critical environments, that distinction is everything."

*(Click to Slide 4.)*

---

## SLIDE 4 — FEASIBILITY & VIABILITY
**⏱ 4:15 – 5:15 (60 seconds)**

> **Goal**: Show maturity. Judges are TIRED of teams that oversell. Be the team that knows its limits. This earns more respect than any demo.

---

"Now — building an AI demo is easy. Building one **responsibly** for industry is the real challenge.

So we designed MAOS around failure scenarios from day one."

*(Point to the risk table. Go through ONLY the top two rows — don't read all four.)*

"**Risk one — false verdicts.** What if the AI hallucinates a safety classification? Our mitigation: deterministic thresholds, ground-truth regression tests, mandatory evidence fields, and human approval before any report is finalized.

**Risk two — unsafe execution.** What if the AI writes or executes something it shouldn't? We restrict it with project-root validation, tool allowlists, timeouts, and — in production — container isolation."

*(Point to the blue callout box.)*

"And our pilot scope is **intentionally conservative**:"

*(Read this slowly, counting on fingers.)*

"One asset class. Offline workstation. Read-only evidence. Engineer in the loop."

*(Look at judges.)*

"We are also very transparent about what this prototype is NOT.

It is not a certified safety system.  
It does not control live PLCs or SCADA.  
And the execution sandbox still needs production hardening."

*(Deliver with conviction.)*

"We believe this honesty is a **strength**, not a weakness. Because in safety-critical AI — knowing where **not** to deploy yet is just as important as knowing what you can build."

*(Click to Slide 5.)*

---

## SLIDE 5 — IMPACT & BENEFITS
**⏱ 5:15 – 6:30 (75 seconds)**

> **Goal**: Expand vision from "one turbine" to "national-scale sovereign AI." End with the big picture.

---

"So what does MAOS actually change for an organization?"

*(Point to the three columns. Touch each one briefly.)*

"**Operations and Safety** — engineers can correlate abnormal sensor events with maintenance evidence in minutes, not hours. They get a consistent PASS/WARNING/FAIL backed by explicit plant rules.

**Organization and Economics** — sensitive evidence stays on premises. Local open-weight models eliminate vendor lock-in and recurring cloud AI costs. And our MAOS Core engine is reusable for any future workflow.

**Governance** — every finding carries provenance. The rules are visible. The evidence is reviewable. The engineer remains accountable."

*(Point to the Prototype Evidence box.)*

"Our working prototype has processed **500 real sensor readings**, detected **4 ground-truth anomaly events**, across a **4-agent evidence pipeline** — fully offline, with zero cloud endpoints."

*(Point to the Scale Path box. Build momentum.)*

"And the scale path is clear:

Start with **one turbine**.  
Expand to **multiple assets**.  
Scale to **plant-wide workflows**.  
And ultimately — **cross-sector sovereign AI agent packs** for manufacturing, power, oil and gas, rail, mining, and utilities."

*(Pause. Lower your voice for the anchor line. This is what judges will remember.)*

"So the scalable product is not one turbine report.

The scalable product is the **governed pattern** — a repeatable, auditable, sovereign framework that can generate trusted reports across any industrial environment in India."

*(Click to Slide 6.)*

---

## SLIDE 6 — RESEARCH & REFERENCES (CLOSING)
**⏱ 6:30 – 7:00 (30 seconds)**

> **Goal**: Land the plane. Three words. One unforgettable closing.

---

"Our proposal is backed by reproducible project evidence — architecture documentation, an industrial build plan, sensor datasets, ground-truth validation, threshold rulesets, and a step-by-step runbook.

But let me close with the three principles that define MAOS."

*(Hold up one finger at a time. Speak each word deliberately.)*

"**One — Sovereignty.**  
Sensitive industrial data never leaves the premises.

**Two — Intelligence.**  
Open-weight agentic AI can understand and correlate complex industrial evidence.

**Three — Accountability.**  
Deterministic rules, evidence provenance, and human approval prevent AI from becoming an uncontrolled black box."

*(Final line. Make eye contact with each judge.)*

"Our vision is simple:

**AI should come to the data — not the data to the AI.**

Thank you."

*(Nod. Step back. Wait for questions.)*

---

## 🎯 DELIVERY CHEAT SHEET

### Voice & Body

| Moment | Technique |
|--------|-----------|
| Opening silence | Stand still. Let judges settle. 2-second pause before first word. |
| "ISRO cannot..." | Lower voice. Slow down. Let the weight land. |
| Naming the 4 agents | Point to each on the slide. Trace flow with hand. |
| "The engineer signs off" | Look directly at judges, not the slide. |
| Risk table | DON'T read all 4 rows. Pick 2. Show you prioritize. |
| "Intentionally conservative" | Count on fingers. Shows confidence, not weakness. |
| Scale path | Speed up slightly. Build energy. |
| Final 3 principles | Hold up fingers. One. Two. Three. Slow, deliberate. |
| "Thank you" | Don't mumble it. Say it clearly. Nod. Stop talking. |

### Common Judge Questions — Be Ready

| Question | Your Answer Anchor |
|----------|-------------------|
| "Why not just use GPT-4?" | "Sovereignty. In classified environments, not one byte can leave. Open-weight local models are the only option." |
| "How is this different from LangChain?" | "LangChain chains prompts. MAOS orchestrates specialized agents with deterministic safety logic SEPARATED from the LLM. The model never makes the safety call." |
| "What if the model hallucinates?" | "The model doesn't decide PASS/FAIL. Deterministic threshold rules do. The model helps interpret — the rules decide." |
| "Can this work on real plant data?" | "Our pilot scope is one asset, read-only, offline. We validate on de-identified data with plant-owned thresholds before any live deployment." |
| "What's the team's tech stack experience?" | *(Share genuinely. Judges like honest teams.)* |
| "Why Node.js and not Python?" | "The orchestrator needs async concurrency for parallel agents, event-driven architecture for the message bus, and native CLI tooling. Node.js is purpose-built for this. Python handles the LLM inference layer." |

---

> [!TIP]
> **The #1 thing that separates national winners from others**: You don't just present what you built. You present **why you made every decision**, what you **chose NOT to do**, and what **breaks if you're wrong**. That's engineering maturity. Judges can smell rehearsed fluff — give them honesty with conviction.
