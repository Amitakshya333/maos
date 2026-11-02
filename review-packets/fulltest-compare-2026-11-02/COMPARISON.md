# FULLTEST-DIFF-01 — a573e2a (base) vs b666518 (lanes) failure comparison

- Old (base): `a573e2a722a2db31dbb453ab43c9f36d0e0d6c30` — "Add the Ring agent loop and workspace"
- New (lanes): `b66651882a4648b81fe2c44a2a408a1e3fe6d67c` — "Add Ring roles, skills, and safety" (contract + Dev A/B/C lanes)
- Packet dir: `C:/maos/review-packets/fulltest-compare-2026-11-02/`
- Question answered: did the lanes introduce any NEW test failures?
- Scope: read-only. No code changes, no commits, no pushes, no live calls.

## 1. Inputs (SHA-256)

| File | SHA-256 |
|---|---|
| `a573e2a-results.txt` | `f91773bb1c8ca38c1f006dc8003e50579546e0ea3280355763c505655` |
| `a573e2a-results.json` | `fc2583a3b840dc644faab50afecc4a561fe9ce91da351897446346bdce27d22c` |
| `a573e2a-summary.md` | `ea0b7d66f1e4d8ceaf024811430dd1e43b52a3ba1faf0e44a5f3352f997343d9` |
| `b666518-results.txt` | `b24f07c490de95432819d47917921407b4529ac39dce69ba27917521407bca` |
| `b666518-results.json` | `9ce1598f31795f8a4f54a1c254eb8a9c0648d5bb648dcde440d4b55c6440c` |
| `b666518-failing-tests.txt` | `d87e5d0a6d48ac6a34cfc343759485294a9acc8defa9ac4e92aafc97539d32` |
| `b666518-failing-tests-json-run.txt` | `e4974b53813c3899f6cfbf3c7d2a6c8450fbef3946a3484392b51a6aa30c3c` |
| `b666518-failing-files.txt` | `a934f5c3e53fb8cb4d7ea3431175868bf34681c1d252a89d3b5fce1d2725b` |
| `b666518-summary.md` | `e2bc2bccccc04d27d43de73c7f9d2f997344bd0e3fc6cb9a9cbfffffe` |
| `b666518-json-stderr.txt` | `41f4c06569b503559f9f05810bc5e72c6e8801a4ece01ac8e798eec01` |

## 2. Method notes (how names were normalized)

- Both result files are ANSI-colored vitest output / JSON; normalization = strip ANSI escape
  sequences (`ESC[...m`), collapse all whitespace runs to single spaces, trim. Trailing
  durations (`NNms`) stripped where present. No path rewriting was needed: both runs already
  record names as `tests/... > Suite > ... > test-name` (the b666518 JSON `name` field holds the
  absolute worktree path `C:/clean/fulltest-b666518/...`, which was reduced to the same
  `tests/...`-relative form before comparison).
- Set A (old failing names, n=767) = `a573e2a-results.json` → `failingNamedTestsFromFailHeaders`
  (all 767 entries unique after normalization; this header-derived list includes 5 two-segment
  enclosing-suite headers and 1 three-segment section header alongside leaf test names).
- Set B (new failing names, n=763) = `b666518-failing-tests.txt` (all 763 entries unique).
  Cross-check: `b666518-failing-tests-json-run.txt` has 762 entries; the single TXT-only entry
  is the ui1-04 concurrency test that failed with `STARTUP_TIMEOUT` in the text run and passed
  in the JSON rerun (29/29 ui1-04 assertions `passed` in `b666518-results.json`) — a timing flake.
- Set operations are exact-match on the normalized full `file > suite-chain > test` string.
  File-level operations use `a573e2a-results.json` → `failingFiles` (92) vs
  `b666518-failing-files.txt` (94). Lane-file existence at each commit verified with
  `git show <commit>:<path>` / `git diff a573e2a b666518 --name-status`.
- Failure signatures sampled from `b666518-results.txt` FAIL detail blocks and the per-assertion
  `failureMessages` in `b666518-results.json` (`testResults[].assertionResults[]`).
- Raw totals differ (3257 vs 3311, +54) because the lanes ADDED tests; comparison is therefore
  strictly by NAME, per the assignment. The +54 delta is consistent with the added lane suites
  (ring-devb-surface 28 + ring-dev-a 10 + ring-dev-c-safety 8 + ring-contract 5 +
  ring-dev-audit-proxy 1 = 52, plus ring-workspace additions).

## 3. Counts

| | a573e2a (old) | b666518 (new) |
|---|---|---|
| Test files failed / passed / skipped (total) | 92 / 59 / 1 (152) | 95 / 61 / 1 (157) text run; 94 files in JSON + failing-files list |
| Tests failed / passed / skipped (total) | 761 / 2378 / 118 (3257) | 763 / 2430 / 118 (3311) text run; 762 / 2431 JSON rerun |
| Normalized unique failing names | 767 | 763 (incl. 1 flake, see above) |
| Unhandled errors | 1 (`EngineError` via f10-02) | unhandled engine-binary error recorded |
| Name-set intersection (BOTH) | 760 | 760 |
| Names only in new (ONLY-B) | — | 3 |
| Names only in old (ONLY-A) | 7 | — |
| Failing files only in new | — | 2 (both lane-added test files) |
| Failing files only in old | 0 | — |

## 4. The three sets (name-normalized, sorted)

### 4a. BOTH — failures present in both runs (pre-existing): 760

```text
tests/f2-05-package-assets.test.ts > F2-05: Package Industrial Assets > Build package manifest > should deny .tgz files
tests/f3-03-rest-contract.test.ts > F3-03 OpenAPI REST Contract > Approvals API: should create approval and execute valid decision transition
tests/f3-03-rest-contract.test.ts > F3-03 OpenAPI REST Contract > Negative: Unauthorized approval transition should return 400
tests/f3-03-rest-contract.test.ts > F3-03 OpenAPI REST Contract > binds approval URL targets and operation paths into idempotency replay identity
tests/f3-06-audit-events.test.ts > Bounded audit-chain verification > verifies and detects tampering across request windows without raising the engine limit
tests/f3-06-audit-events.test.ts > F3-06 Append-Only Redacted Audit Events > 2. Audit Service & 10 Categories Coverage > should query audit records with category and sequence filters
tests/f3-06-audit-events.test.ts > F3-06 Append-Only Redacted Audit Events > 2. Audit Service & 10 Categories Coverage > should record events across all 10 required audit categories
tests/f3-06-audit-events.test.ts > F3-06 Append-Only Redacted Audit Events > 2. Audit Service & 10 Categories Coverage > should verify an empty chain
tests/f3-06-audit-events.test.ts > F3-06 Append-Only Redacted Audit Events > 3. Zero Plaintext Secrets Invariant on Disk > should never write raw secrets to .maos/audit/audit-chain.jsonl
tests/f3-06-audit-events.test.ts > F3-06 Append-Only Redacted Audit Events > 4. Negative & Adversarial Tamper Tests > should detect data payload tampering via Rust engine
tests/f3-06-audit-events.test.ts > F3-06 Append-Only Redacted Audit Events > 4. Negative & Adversarial Tamper Tests > should detect deletion of the first record (sequence starts > 0)
tests/f3-06-audit-events.test.ts > F3-06 Append-Only Redacted Audit Events > 4. Negative & Adversarial Tamper Tests > should detect middle record deletion (broken link & sequence jump)
tests/f3-06-audit-events.test.ts > F3-06 Append-Only Redacted Audit Events > 4. Negative & Adversarial Tamper Tests > should detect record reordering / swap
tests/f3-06-audit-events.test.ts > F3-06 Append-Only Redacted Audit Events > 4. Negative & Adversarial Tamper Tests > should detect stored hash tampering via Rust engine
tests/f3-06-audit-events.test.ts > F3-06 Append-Only Redacted Audit Events > 4. Negative & Adversarial Tamper Tests > should fail closed when Rust engine fails during append or verify
tests/f3-06-audit-events.test.ts > F3-06 Append-Only Redacted Audit Events > 4. Negative & Adversarial Tamper Tests > should reject missing source identifier
tests/f3-06-audit-events.test.ts > F3-06 Append-Only Redacted Audit Events > 4. Negative & Adversarial Tamper Tests > should reject unknown audit category
tests/f3-06-audit-events.test.ts > F3-06 Append-Only Redacted Audit Events > 5. REST API Contract Integration > GET /api/v1/audit: should list and filter audit records
tests/f3-06-audit-events.test.ts > F3-06 Append-Only Redacted Audit Events > 5. REST API Contract Integration > Idempotency: duplicate request with same key should return cached response
tests/f3-06-audit-events.test.ts > F3-06 Append-Only Redacted Audit Events > 5. REST API Contract Integration > POST /api/v1/audit/events: should record an event with sensitive-data redaction
tests/f3-06-audit-events.test.ts > F3-06 Append-Only Redacted Audit Events > 5. REST API Contract Integration > POST /api/v1/audit/verify: should verify audit chain through HTTP
tests/f3-07-verifier-idempotency.test.ts > F3-07 Run/API Verifier and Idempotency > 2. Canonical Verifier Service > should execute comprehensive verifyRun end-to-end check
tests/f3-07-verifier-idempotency.test.ts > F3-07 Run/API Verifier and Idempotency > 2. Canonical Verifier Service > should verify approval references and gate status
tests/f3-07-verifier-idempotency.test.ts > F3-07 Run/API Verifier and Idempotency > 2. Canonical Verifier Service > should verify tamper-evident audit chain references
tests/f3-07-verifier-idempotency.test.ts > F3-07 Run/API Verifier and Idempotency > 3. REST Verification & Idempotent Mutations > POST /api/v1/verify/run should verify complete run via REST
tests/f5-03-kb-embedding.test.ts > F5-03: Local Knowledge-Base CPU Embedding Model > 9. Audit Logging > records EMBEDDING_GENERATED audit event without logging raw text
tests/f5-04-kb-vector-index.test.ts > F5-04: Bounded Local Knowledge-Base Vector Index > 14. Audit Trail Integration > records INDEX_BUILT, INDEX_LOADED, and INDEX_INVALIDATED events without raw text
tests/f5-04-kb-vector-index.test.ts > F5-04: Bounded Local Knowledge-Base Vector Index > 14. Audit Trail Integration > records INDEX_REJECTED event when an index fails load validation
tests/f5-05-kb-search.test.ts > F5-05: Register search_knowledge_base Tool & Service > 14. Immutable Audit Trail (Zero Raw Text Logged) > records KB_SEARCH_EXECUTED with queryHash and zero raw query text
tests/f5-05-kb-search.test.ts > F5-05: Register search_knowledge_base Tool & Service > 14. Immutable Audit Trail (Zero Raw Text Logged) > records KB_SEARCH_NO_ANSWER with reason and zero raw text
tests/f5-05-kb-search.test.ts > F5-05: Register search_knowledge_base Tool & Service > 16. Canary File Protection Invariant > preserves rust/test.txt SHA-256 integrity
tests/gui/ui1-01-spa-shell.test.ts > UI1-01: React SPA Shell with Local Assets > Disconnected & Sovereign Guarantees > should enforce strict loopback-only Content Security Policy
tests/gui/ui1-01-spa-shell.test.ts > UI1-01: React SPA Shell with Local Assets > Disconnected & Sovereign Guarantees > should have zero remote imports in bundled CSS
tests/gui/ui1-01-spa-shell.test.ts > UI1-01: React SPA Shell with Local Assets > Disconnected & Sovereign Guarantees > should not contain any external CDN, font, or script URLs in index.html
tests/gui/ui1-01-spa-shell.test.ts > UI1-01: React SPA Shell with Local Assets > Industrial VM Rehearsal Check > should pass checkReactAssets step when check=true and isRequired=true
tests/gui/ui1-01-spa-shell.test.ts > UI1-01: React SPA Shell with Local Assets > Loopback Static Serving & Fallback > should fall back to index.html for client route /chat
tests/gui/ui1-01-spa-shell.test.ts > UI1-01: React SPA Shell with Local Assets > Loopback Static Serving & Fallback > should fall back to index.html for client route /tasks
tests/gui/ui1-01-spa-shell.test.ts > UI1-01: React SPA Shell with Local Assets > Loopback Static Serving & Fallback > should reject path traversal attempts with 403 Forbidden
tests/gui/ui1-01-spa-shell.test.ts > UI1-01: React SPA Shell with Local Assets > Loopback Static Serving & Fallback > should serve SPA index.html at root route /
tests/gui/ui1-01-spa-shell.test.ts > UI1-01: React SPA Shell with Local Assets > Loopback Static Serving & Fallback > should serve bundled static JS asset with application/javascript
tests/gui/ui1-01-spa-shell.test.ts > UI1-01: React SPA Shell with Local Assets > SPA Build Output > should have bundled assets in dist/gui/assets
tests/gui/ui1-01-spa-shell.test.ts > UI1-01: React SPA Shell with Local Assets > SPA Build Output > should have index.html in dist/gui
tests/gui/ui1-01-spa-shell.test.ts > UI1-01: React SPA Shell with Local Assets > SPA Build Output > should have index.html in gui/dist for vm-rehearsal checkReactAssets
tests/gui/ui1-06-csp-token-hygiene.test.ts > UI1-06: Content Security Policy & Token Hygiene > 11. Bundled GUI Assets Offline & Security Audit > verifies dist/gui/index.html exists and contains strict CSP meta tag
tests/gui/ui1-06-csp-token-hygiene.test.ts > UI1-06: Content Security Policy & Token Hygiene > 3. Static SPA Serving & Asset Security Headers > rejects path traversal attempts with 403 and security headers
tests/gui/ui1-07-role-presets.test.ts > UI1-07: Role Presets and Layout Persistence > 8. Critical Safety Boundary Invariant Proofs > PROVE: UI role switching does NOT alter or corrupt the immutable audit chain
tests/gui/ui1-07-role-presets.test.ts > UI1-07: Role Presets and Layout Persistence > 9. Bundle Verification, Accessibility, and Invariants > compiled GUI bundle contains role presets, onboarding modal, and accessibility structures
tests/gui/ui1-07-role-presets.test.ts > UI1-07: Role Presets and Layout Persistence > 9. Bundle Verification, Accessibility, and Invariants > strictly preserves rust/test.txt SHA-256 invariant
tests/gui/ui1-08-basic-settings.test.ts > UI1-08: Basic Settings & Service Management > 3. ProjectService & Safe Stop Behavior > executes confirmed force-stop, marks tasks as INTERRUPTED, and preserves audit log
tests/gui/ui1-08-basic-settings.test.ts > UI1-08: Basic Settings & Service Management > 6. Security Invariants & Rust Hash Integrity > strictly preserves rust/test.txt SHA-256 hash invariant
tests/gui/ui1-10-evidence-retention.test.ts > UI1-10: Evidence / Brainstorm Modes and Retention > 3. RetentionService & Scoped Purge Safety Invariants > SAFETY INVARIANT: append-only audit records (.maos/audit/) are strictly immutable and never purged
tests/gui/ui1-10-evidence-retention.test.ts > UI1-10: Evidence / Brainstorm Modes and Retention > 3. RetentionService & Scoped Purge Safety Invariants > preserves pinned conversations and task-linked conversations while purging expired unpinned sessions
tests/gui/ui1-10-evidence-retention.test.ts > UI1-10: Evidence / Brainstorm Modes and Retention > 7. Safety Invariants & Canary Check > verifies canary test.txt SHA-256 is unchanged
tests/gui/ui1-11-model-manager.test.ts > UI1-11: Shared GPU Model Manager and Leases > 6. Security Invariants > verifies canary rust/test.txt SHA-256 hash preservation
tests/gui/ui1-12-fair-queue.test.ts > UI1-12: Fair Priority and Cancellation Queue > 2. FairQueueService Core Logic > blocks dispatch when dependencies are unmet
tests/gui/ui1-12-fair-queue.test.ts > UI1-12: Fair Priority and Cancellation Queue > 2. FairQueueService Core Logic > caps aging priority promotion at user_task (P2) to protect interactive chat (P1)
tests/gui/ui1-12-fair-queue.test.ts > UI1-12: Fair Priority and Cancellation Queue > 2. FairQueueService Core Logic > enforces FIFO tie-breaking within equivalent priority
tests/gui/ui1-12-fair-queue.test.ts > UI1-12: Fair Priority and Cancellation Queue > 2. FairQueueService Core Logic > enforces chat burst limit: yields after 3 consecutive chat turns
tests/gui/ui1-12-fair-queue.test.ts > UI1-12: Fair Priority and Cancellation Queue > 2. FairQueueService Core Logic > enforces project boundary isolation on cancellation
tests/gui/ui1-12-fair-queue.test.ts > UI1-12: Fair Priority and Cancellation Queue > 2. FairQueueService Core Logic > enforces run boundary isolation on cancellation
tests/gui/ui1-12-fair-queue.test.ts > UI1-12: Fair Priority and Cancellation Queue > 2. FairQueueService Core Logic > enqueues tasks with correct priority weights and positions
tests/gui/ui1-12-fair-queue.test.ts > UI1-12: Fair Priority and Cancellation Queue > 2. FairQueueService Core Logic > phantom success defense: rejects reporting completion on cancelled task
tests/gui/ui1-12-fair-queue.test.ts > UI1-12: Fair Priority and Cancellation Queue > 2. FairQueueService Core Logic > promotes effective priority by 1 class after 60 seconds (anti-starvation)
tests/gui/ui1-12-fair-queue.test.ts > UI1-12: Fair Priority and Cancellation Queue > 2. FairQueueService Core Logic > records audited events for queue operations
tests/gui/ui1-12-fair-queue.test.ts > UI1-12: Fair Priority and Cancellation Queue > 2. FairQueueService Core Logic > rejects duplicate active task IDs
tests/gui/ui1-12-fair-queue.test.ts > UI1-12: Fair Priority and Cancellation Queue > 2. FairQueueService Core Logic > safely cancels queued entry with position 0
tests/gui/ui1-12-fair-queue.test.ts > UI1-12: Fair Priority and Cancellation Queue > 2. FairQueueService Core Logic > safely cancels running entry, aborts controller, and releases model lease
tests/gui/ui1-12-fair-queue.test.ts > UI1-12: Fair Priority and Cancellation Queue > 2. FairQueueService Core Logic > service restart recovery marks stranded running tasks as interrupted
tests/gui/ui1-12-fair-queue.test.ts > UI1-12: Fair Priority and Cancellation Queue > 3. REST API Router & Endpoints > GET /api/v1/queue/:id returns single queue entry
tests/gui/ui1-12-fair-queue.test.ts > UI1-12: Fair Priority and Cancellation Queue > 3. REST API Router & Endpoints > POST /api/v1/queue enqueues a request
tests/gui/ui1-12-fair-queue.test.ts > UI1-12: Fair Priority and Cancellation Queue > 3. REST API Router & Endpoints > POST /api/v1/queue/:id/cancel cancels the entry
tests/gui/ui1-12-fair-queue.test.ts > UI1-12: Fair Priority and Cancellation Queue > 4. 4-Way Client Parity > verifies BrowserRestClient queue operations
tests/gui/ui1-12-fair-queue.test.ts > UI1-12: Fair Priority and Cancellation Queue > 4. 4-Way Client Parity > verifies GuiApiAdapter queue operations
tests/gui/ui1-12-fair-queue.test.ts > UI1-12: Fair Priority and Cancellation Queue > 5. Security & Gate Invariants > verifies canary rust/test.txt SHA-256 hash preservation
tests/gui/ui1-13-model-switcher.test.ts > UI1-13: Model Switcher and Auto-Routing > 2. ModelSwitchService Core Routing & Residency Protection > requires explicit confirmation for disruptive switch when model is resident with 0 leases
tests/gui/ui1-13-model-switcher.test.ts > UI1-13: Model Switcher and Auto-Routing > 5. Security & Gate Invariants > preserves canary rust/test.txt SHA-256 hash
tests/gui/ui1-14-approvals.test.ts > UI1-14: Approval APIs and UI > 3. ApprovalService Core Lifecycle & Force-Stop Defense > creates and persistently saves an approval record with all 15 fields
tests/gui/ui1-14-approvals.test.ts > UI1-14: Approval APIs and UI > 3. ApprovalService Core Lifecycle & Force-Stop Defense > detects and rejects expired approvals dynamically
tests/gui/ui1-14-approvals.test.ts > UI1-14: Approval APIs and UI > 3. ApprovalService Core Lifecycle & Force-Stop Defense > executes force-stop with confirmation and prevents phantom success
tests/gui/ui1-14-approvals.test.ts > UI1-14: Approval APIs and UI > 3. ApprovalService Core Lifecycle & Force-Stop Defense > prevents operation reuse via single-use consumeApproval
tests/gui/ui1-14-approvals.test.ts > UI1-14: Approval APIs and UI > 3. ApprovalService Core Lifecycle & Force-Stop Defense > reviews approval and enforces authorized human reviewer roles
tests/gui/ui1-14-approvals.test.ts > UI1-14: Approval APIs and UI > 4. REST API Router Endpoints > GET /api/v1/approvals lists approvals with query filtering
tests/gui/ui1-14-approvals.test.ts > UI1-14: Approval APIs and UI > 4. REST API Router Endpoints > GET /api/v1/approvals/:id returns individual approval
tests/gui/ui1-14-approvals.test.ts > UI1-14: Approval APIs and UI > 4. REST API Router Endpoints > POST /api/v1/approvals creates pending approval record
tests/gui/ui1-14-approvals.test.ts > UI1-14: Approval APIs and UI > 4. REST API Router Endpoints > POST /api/v1/approvals/:id/consume marks approval consumed
tests/gui/ui1-14-approvals.test.ts > UI1-14: Approval APIs and UI > 4. REST API Router Endpoints > POST /api/v1/approvals/:id/review executes human decision
tests/gui/ui1-14-approvals.test.ts > UI1-14: Approval APIs and UI > 4. REST API Router Endpoints > POST /api/v1/approvals/:id/validate succeeds after approval
tests/gui/ui1-14-approvals.test.ts > UI1-14: Approval APIs and UI > 4. REST API Router Endpoints > POST /api/v1/approvals/:id/validate validates against action context
tests/gui/ui1-14-approvals.test.ts > UI1-14: Approval APIs and UI > 4. REST API Router Endpoints > POST /api/v1/approvals/force-stop handles force stop requests
tests/gui/ui1-14-approvals.test.ts > UI1-14: Approval APIs and UI > 5. 4-Way Client Parity & Runtime Validations > verifies createApproval parity across ServiceContainer, MaosRestClient, BrowserRestClient, and GuiApiAdapter
tests/gui/ui1-14-approvals.test.ts > UI1-14: Approval APIs and UI > 5. 4-Way Client Parity & Runtime Validations > verifies listApprovals parity across all clients
tests/gui/ui1-14-approvals.test.ts > UI1-14: Approval APIs and UI > 5. 4-Way Client Parity & Runtime Validations > verifies reviewApproval and validateApproval parity across all clients
tests/gui/ui1-14-approvals.test.ts > UI1-14: Approval APIs and UI > 6. Security & Gate Invariants > preserves canary rust/test.txt SHA-256 hash
tests/gui/ui1-15-cockpit.test.ts > UI1-15: Read-Only Agent Cockpit > Tier 4: CockpitService Persistence & State Assembly > executes confirmed force stop and emits authoritative event
tests/gui/ui1-15-cockpit.test.ts > UI1-15: Read-Only Agent Cockpit > Tier 5: REST API Router Endpoints > POST /api/v1/cockpit/:runId/stop enforces confirmation for force-stop
tests/gui/ui1-15-cockpit.test.ts > UI1-15: Read-Only Agent Cockpit > Tier 8: Security & Gate Invariants > preserves canary rust/test.txt SHA-256 hash
tests/gui/ui1-16-evidence-workbench.test.ts > UI1-16: Evidence & Telemetry Workbench > 2. ConflictReviewService & Persistence > compareAndPersist saves artifact and logs audit event
tests/gui/ui1-16-evidence-workbench.test.ts > UI1-16: Evidence & Telemetry Workbench > 2. ConflictReviewService & Persistence > resolveConflict retains full provenance and requires mandatory rationale
tests/gui/ui1-16-evidence-workbench.test.ts > UI1-16: Evidence & Telemetry Workbench > 3. REST API Router Endpoints > GET /api/v1/evidence/conflicts/:id retrieves specific report
tests/gui/ui1-16-evidence-workbench.test.ts > UI1-16: Evidence & Telemetry Workbench > 3. REST API Router Endpoints > GET /api/v1/evidence/resolved returns all resolved observations
tests/gui/ui1-16-evidence-workbench.test.ts > UI1-16: Evidence & Telemetry Workbench > 3. REST API Router Endpoints > POST /api/v1/evidence/conflicts/:id/resolve resolves conflict and generates safety_verdict approval
tests/gui/ui1-16-evidence-workbench.test.ts > UI1-16: Evidence & Telemetry Workbench > 3. REST API Router Endpoints > POST /api/v1/evidence/conflicts/compare creates and returns conflict report
tests/gui/ui1-16-evidence-workbench.test.ts > UI1-16: Evidence & Telemetry Workbench > 5. Safety Invariants & Security > canary file rust/test.txt is unmodified
tests/gui/ui1-17-document-generator.test.ts > UI1-17: Document Generator > Canary Hash Protection > rust/test.txt is untouched and matches canonical SHA-256
tests/gui/ui1-17-document-generator.test.ts > UI1-17: Document Generator > Deliverable Generation > successfully generates DOCX deliverable with valid approval and finalizes to Safe Artifact Store
tests/gui/ui1-17-document-generator.test.ts > UI1-17: Document Generator > Deliverable Generation > successfully generates PPTX presentation briefing deck
tests/gui/ui1-17-document-generator.test.ts > UI1-17: Document Generator > Deliverable Generation > successfully generates XLSX workbook with multiple sheets and deterministic calculations
tests/gui/ui1-17-document-generator.test.ts > UI1-17: Document Generator > Mandatory Approval Enforcement > rejects unapproved document generation with HTTP 403 APPROVAL_REQUIRED
tests/gui/ui1-17-document-generator.test.ts > UI1-17: Document Generator > Mandatory Approval Enforcement > rejects when approved payload hash does not match current input hash (tampered after approval)
tests/gui/ui1-17-document-generator.test.ts > UI1-17: Document Generator > Template Safety > rejects macro-enabled template extensions (.docm)
tests/gui/ui1-17-document-generator.test.ts > UI1-17: Document Generator > Template Safety > rejects path traversal attempts on template path
tests/gui/ui1-17-document-generator.test.ts > UI1-17: Document Generator > Validation & Freshness Verification > detects staled source hash when physical file differs
tests/gui/ui1-17-document-generator.test.ts > UI1-17: Document Generator > Validation & Freshness Verification > rejects input with missing title or invalid schemaVersion
tests/gui/ui1-17-document-generator.test.ts > UI1-17: Document Generator > Validation & Freshness Verification > validates a correct preset input and returns canonical hash and fresh sources
tests/gui/ui1-18-knowledge-sandbox.test.ts > UI1-18: Knowledge Search and Sandbox Results > Canary Invariant > rust/test.txt SHA-256 hash is unchanged
tests/gui/ui1-19-service-lifecycle.test.ts > UI1-19: Service Lifecycle and Recovery Controls > 5. Stop Controls & Interruption Defense > confirmed force stop marks active tasks INTERRUPTED and records audit event
tests/gui/ui1-19-service-lifecycle.test.ts > UI1-19: Service Lifecycle and Recovery Controls > 6. Interactive Disconnect & Client Abort > cancels chat completion on client abort without breaking service
tests/gui/ui1-19-service-lifecycle.test.ts > UI1-19: Service Lifecycle and Recovery Controls > 9. Canary Invariant > rust/test.txt SHA-256 hash is strictly preserved
tests/gui/ui1-20-audit-sovereign-panel.test.ts > UI1-20: Audit Trail and Sovereign Boundary Panel > 1. Audit Trail REST API & Export > GET /api/v1/audit/export exports entire audit trail with verification bundle
tests/gui/ui1-20-audit-sovereign-panel.test.ts > UI1-20: Audit Trail and Sovereign Boundary Panel > 1. Audit Trail REST API & Export > POST /api/v1/audit/verify cryptographically verifies the audit chain
tests/gui/ui1-20-audit-sovereign-panel.test.ts > UI1-20: Audit Trail and Sovereign Boundary Panel > 2. Sovereign Panel REST API > GET /api/v1/sovereignty/panel returns aggregated boundary, processes, and allowlist
tests/gui/ui1-20-audit-sovereign-panel.test.ts > UI1-20: Audit Trail and Sovereign Boundary Panel > 2. Sovereign Panel REST API > includes active loopback endpoints in endpoint policy
tests/gui/ui1-20-audit-sovereign-panel.test.ts > UI1-20: Audit Trail and Sovereign Boundary Panel > 2. Sovereign Panel REST API > tracked processes have executable hashes and trust status
tests/gui/ui1-20-audit-sovereign-panel.test.ts > UI1-20: Audit Trail and Sovereign Boundary Panel > 5. Client & Adapter Parity > apiAdapter delegates exportAuditTrail correctly
tests/gui/ui1-20-audit-sovereign-panel.test.ts > UI1-20: Audit Trail and Sovereign Boundary Panel > 5. Client & Adapter Parity > apiAdapter delegates getSovereignPanelData correctly
tests/gui/ui1-20-audit-sovereign-panel.test.ts > UI1-20: Audit Trail and Sovereign Boundary Panel > 5. Client & Adapter Parity > apiAdapter delegates verifyAuditChain correctly
tests/gui/ui1-20-audit-sovereign-panel.test.ts > UI1-20: Audit Trail and Sovereign Boundary Panel > 7. Canary Invariant > rust/test.txt SHA-256 hash is strictly preserved
tests/gui/ui1-21-project-isolation.test.ts > UI1-21: Project, Root & Data Isolation Security Suite > 1. Session & Token Swap Attack Prevention > allows authenticated access with matching session token on Host A
tests/gui/ui1-21-project-isolation.test.ts > UI1-21: Project, Root & Data Isolation Security Suite > 1. Session & Token Swap Attack Prevention > allows authenticated access with matching session token on Host B
tests/gui/ui1-21-project-isolation.test.ts > UI1-21: Project, Root & Data Isolation Security Suite > 1. Session & Token Swap Attack Prevention > rejects Token A when presented to Host B (Token Swap Attack)
tests/gui/ui1-21-project-isolation.test.ts > UI1-21: Project, Root & Data Isolation Security Suite > 1. Session & Token Swap Attack Prevention > rejects Token B when presented to Host A (Token Swap Attack)
tests/gui/ui1-21-project-isolation.test.ts > UI1-21: Project, Root & Data Isolation Security Suite > 1. Session & Token Swap Attack Prevention > rejects URL token parameters with FORBIDDEN_URL_TOKEN (Token Leakage Defense)
tests/gui/ui1-21-project-isolation.test.ts > UI1-21: Project, Root & Data Isolation Security Suite > 2. Header & Project Scope Verification > rejects request when X-Project-ID mismatches authenticated project ID
tests/gui/ui1-21-project-isolation.test.ts > UI1-21: Project, Root & Data Isolation Security Suite > 2. Header & Project Scope Verification > rejects request when X-Project-Root mismatches authenticated service instance
tests/gui/ui1-21-project-isolation.test.ts > UI1-21: Project, Root & Data Isolation Security Suite > 3. Artifact Store & Confinement Isolation > allows Project Alpha to query its own artifact
tests/gui/ui1-21-project-isolation.test.ts > UI1-21: Project, Root & Data Isolation Security Suite > 3. Artifact Store & Confinement Isolation > rejects Project Beta from downloading Project Alpha artifact content
tests/gui/ui1-21-project-isolation.test.ts > UI1-21: Project, Root & Data Isolation Security Suite > 3. Artifact Store & Confinement Isolation > rejects Project Beta from querying Project Alpha artifact ID (404 NOT_FOUND)
tests/gui/ui1-21-project-isolation.test.ts > UI1-21: Project, Root & Data Isolation Security Suite > 3. Artifact Store & Confinement Isolation > rejects path traversal attempting to escape project root into another project
tests/gui/ui1-21-project-isolation.test.ts > UI1-21: Project, Root & Data Isolation Security Suite > 4. Conversation & Task Isolation > allows Project Alpha to access its conversation
tests/gui/ui1-21-project-isolation.test.ts > UI1-21: Project, Root & Data Isolation Security Suite > 4. Conversation & Task Isolation > rejects Project Beta from accessing Project Alpha conversation ID (404 NOT_FOUND)
tests/gui/ui1-21-project-isolation.test.ts > UI1-21: Project, Root & Data Isolation Security Suite > 4. Conversation & Task Isolation > rejects Project Beta from appending messages to Project Alpha conversation
tests/gui/ui1-21-project-isolation.test.ts > UI1-21: Project, Root & Data Isolation Security Suite > 5. Settings Isolation > mutates settings in Project Alpha without affecting Project Beta
tests/gui/ui1-21-project-isolation.test.ts > UI1-21: Project, Root & Data Isolation Security Suite > 5. Settings Isolation > rejects cross-project settings query (CROSS_PROJECT_FORBIDDEN)
tests/gui/ui1-21-project-isolation.test.ts > UI1-21: Project, Root & Data Isolation Security Suite > 6. Cockpit Run & Event Replay Isolation > allows Project Alpha to view its cockpit run
tests/gui/ui1-21-project-isolation.test.ts > UI1-21: Project, Root & Data Isolation Security Suite > 6. Cockpit Run & Event Replay Isolation > rejects Project Beta from querying Project Alpha run (404 NOT_FOUND)
tests/gui/ui1-21-project-isolation.test.ts > UI1-21: Project, Root & Data Isolation Security Suite > 6. Cockpit Run & Event Replay Isolation > rejects Project Beta from replaying Project Alpha run events
tests/gui/ui1-21-project-isolation.test.ts > UI1-21: Project, Root & Data Isolation Security Suite > 7. Recent Projects Registry & Path Canonicalization > stores recent projects with canonical paths and distinct project hashes
tests/gui/ui1-22-accessibility-errors.test.ts > UI1-22: Accessibility and Actionable Error States > 1. Actionable Recovery Error States across 6 Mandatory Domains > renders approval required error with gate review action
tests/gui/ui1-22-accessibility-errors.test.ts > UI1-22: Accessibility and Actionable Error States > 1. Actionable Recovery Error States across 6 Mandatory Domains > renders model exhaustion error with switch model action
tests/gui/ui1-22-accessibility-errors.test.ts > UI1-22: Accessibility and Actionable Error States > 1. Actionable Recovery Error States across 6 Mandatory Domains > renders offline boundary defense error with explanation and zero cloud leakage
tests/gui/ui1-22-accessibility-errors.test.ts > UI1-22: Accessibility and Actionable Error States > 1. Actionable Recovery Error States across 6 Mandatory Domains > renders reconnect error with recovery action and assertive live region
tests/gui/ui1-22-accessibility-errors.test.ts > UI1-22: Accessibility and Actionable Error States > 1. Actionable Recovery Error States across 6 Mandatory Domains > renders sandbox execution error with inspect trace action
tests/gui/ui1-22-accessibility-errors.test.ts > UI1-22: Accessibility and Actionable Error States > 1. Actionable Recovery Error States across 6 Mandatory Domains > renders service fault error with restart action
tests/gui/ui1-22-accessibility-errors.test.ts > UI1-22: Accessibility and Actionable Error States > 2. Negative Invariants: Sanitization & Indefinite Spinners > TimeoutSpinner halts spinning after timeoutMs and offers recovery action (No indefinite spinners)
tests/gui/ui1-22-accessibility-errors.test.ts > UI1-22: Accessibility and Actionable Error States > 2. Negative Invariants: Sanitization & Indefinite Spinners > sanitizes raw JavaScript stack traces from error messages
tests/gui/ui1-22-accessibility-errors.test.ts > UI1-22: Accessibility and Actionable Error States > 2. Negative Invariants: Sanitization & Indefinite Spinners > sanitizes sensitive credentials, Bearer tokens, and API keys from error messages
tests/gui/ui1-22-accessibility-errors.test.ts > UI1-22: Accessibility and Actionable Error States > 3. Accessible Labels, ARIA & Color-Only State Defense > ActionableErrorBanner includes explicit ARIA role="alert" and aria-live attributes
tests/gui/ui1-22-accessibility-errors.test.ts > UI1-22: Accessibility and Actionable Error States > 3. Accessible Labels, ARIA & Color-Only State Defense > dismiss button defines accessible aria-label and title
tests/gui/ui1-22-accessibility-errors.test.ts > UI1-22: Accessibility and Actionable Error States > 3. Accessible Labels, ARIA & Color-Only State Defense > every category in CATEGORY_METADATA defines a non-empty human-readable text badge (no color-only)
tests/gui/ui1-22-accessibility-errors.test.ts > UI1-22: Accessibility and Actionable Error States > 4. Modal Dialogs & Keyboard Trapping Defense > FilePickerModal renders with role="dialog", aria-modal="true", and aria-labelledby
tests/gui/ui1-22-accessibility-errors.test.ts > UI1-22: Accessibility and Actionable Error States > 4. Modal Dialogs & Keyboard Trapping Defense > RoleOnboardingModal renders with accessible dialog attributes
tests/gui/ui1-22-accessibility-errors.test.ts > UI1-22: Accessibility and Actionable Error States > 5. Contrast Ratios & WCAG Compliance > high-contrast mode tokens satisfy WCAG AAA contrast (>= 7:1)
tests/gui/ui1-22-accessibility-errors.test.ts > UI1-22: Accessibility and Actionable Error States > 5. Contrast Ratios & WCAG Compliance > standard dark theme tokens satisfy WCAG AA contrast (>= 4.5:1)
tests/gui/ui1-22-accessibility-errors.test.ts > UI1-22: Accessibility and Actionable Error States > 6. Reduced Motion CSS Enforcement > theme.css defines near-zero animation and transition duration under reduced motion
tests/gui/ui1-23-component-interruption.test.ts > UI1-23: Component, Integration & Interruption Security Tests > 1. Anonymous & Remote Access Defense > rejects anonymous access without Authorization header with 401 AUTH_REQUIRED
tests/gui/ui1-23-component-interruption.test.ts > UI1-23: Component, Integration & Interruption Security Tests > 1. Anonymous & Remote Access Defense > rejects foreign or forged session token with 401 INVALID_TOKEN
tests/gui/ui1-23-component-interruption.test.ts > UI1-23: Component, Integration & Interruption Security Tests > 1. Anonymous & Remote Access Defense > rejects malformed Authorization header with 401 MALFORMED_TOKEN
tests/gui/ui1-23-component-interruption.test.ts > UI1-23: Component, Integration & Interruption Security Tests > 2. Event Loss, Monotonic Sequencing & Replay Cursor > assigns strictly monotonic sequence numbers to persisted events
tests/gui/ui1-23-component-interruption.test.ts > UI1-23: Component, Integration & Interruption Security Tests > 2. Event Loss, Monotonic Sequencing & Replay Cursor > idempotently ignores duplicate or out-of-order sequence events (seq <= cursor)
tests/gui/ui1-23-component-interruption.test.ts > UI1-23: Component, Integration & Interruption Security Tests > 2. Event Loss, Monotonic Sequencing & Replay Cursor > retrieves accurate event subset when querying with fromSeq cursor
tests/gui/ui1-23-component-interruption.test.ts > UI1-23: Component, Integration & Interruption Security Tests > 3. Atomic Artifact Finalization & Interruption Rollback > rolls back cleanly before atomic rename and cleans up orphaned temp files
tests/gui/ui1-23-component-interruption.test.ts > UI1-23: Component, Integration & Interruption Security Tests > 3. Atomic Artifact Finalization & Interruption Rollback > rolls back cleanly on simulated interruption during write (no corrupt destination file)
tests/gui/ui1-23-component-interruption.test.ts > UI1-23: Component, Integration & Interruption Security Tests > 3. Atomic Artifact Finalization & Interruption Rollback > successfully finalizes artifact and persists metadata when uninterrupted
tests/gui/ui1-23-component-interruption.test.ts > UI1-23: Component, Integration & Interruption Security Tests > 4. Force-Stop & Phantom Success Defense > confirmed force-stop transitions run to cancelled state and prevents phantom completion
tests/gui/ui1-23-component-interruption.test.ts > UI1-23: Component, Integration & Interruption Security Tests > 4. Force-Stop & Phantom Success Defense > rejects unconfirmed force-stop with FORCE_STOP_CONFIRMATION_REQUIRED
tests/gui/ui1-23-component-interruption.test.ts > UI1-23: Component, Integration & Interruption Security Tests > 5. Stale & Cross-Run Approval Rejection > rejects attempt to review already approved record with 409 or 400
tests/gui/ui1-23-component-interruption.test.ts > UI1-23: Component, Integration & Interruption Security Tests > 5. Stale & Cross-Run Approval Rejection > rejects cross-project approval review attempt with 403 or 404
tests/gui/ui1-23-component-interruption.test.ts > UI1-23: Component, Integration & Interruption Security Tests > 5. Stale & Cross-Run Approval Rejection > rejects query for non-existent approval ID with 404 NOT_FOUND
tests/gui/ui1-24-one-project-v1-1.test.ts > UI1-24: One-Project MVP & v1.1 Multi-Window Readiness > 1. D7 Judged Operator Journey Execution & Timing > completes the full judged operator journey well within the 15-minute budget
tests/gui/ui1-24-one-project-v1-1.test.ts > UI1-24: One-Project MVP & v1.1 Multi-Window Readiness > 2. Judged UI Single-Project MVP Contract > Header renders strictly one project path and contains no multi-project selector
tests/gui/ui1-24-one-project-v1-1.test.ts > UI1-24: One-Project MVP & v1.1 Multi-Window Readiness > 2. Judged UI Single-Project MVP Contract > StatusBar renders the runtime API endpoint and readiness contract
tests/gui/ui1-24-one-project-v1-1.test.ts > UI1-24: One-Project MVP & v1.1 Multi-Window Readiness > 2. Judged UI Single-Project MVP Contract > runtime environment contains zero global mutable current-project singleton
tests/gui/ui1-24-one-project-v1-1.test.ts > UI1-24: One-Project MVP & v1.1 Multi-Window Readiness > 3. Parallel-Service Isolation Harness (v1.1 Hooks) > proves data isolation: conversations created on Host A never appear on Host B
tests/gui/ui1-24-one-project-v1-1.test.ts > UI1-24: One-Project MVP & v1.1 Multi-Window Readiness > 3. Parallel-Service Isolation Harness (v1.1 Hooks) > proves data isolation: tasks created on Host A never appear on Host B
tests/gui/ui1-24-one-project-v1-1.test.ts > UI1-24: One-Project MVP & v1.1 Multi-Window Readiness > 3. Parallel-Service Isolation Harness (v1.1 Hooks) > proves filesystem isolation: artifacts written to Root A do not exist in Root B
tests/gui/ui1-24-one-project-v1-1.test.ts > UI1-24: One-Project MVP & v1.1 Multi-Window Readiness > 3. Parallel-Service Isolation Harness (v1.1 Hooks) > proves settings isolation: updating settings on Host A does not mutate Host B
tests/gui/ui1-24-one-project-v1-1.test.ts > UI1-24: One-Project MVP & v1.1 Multi-Window Readiness > 3. Parallel-Service Isolation Harness (v1.1 Hooks) > rejects cross-project X-Project-ID header spoofing with 400 or 403
tests/gui/ui1-24-one-project-v1-1.test.ts > UI1-24: One-Project MVP & v1.1 Multi-Window Readiness > 3. Parallel-Service Isolation Harness (v1.1 Hooks) > rejects cross-project session tokens (Token A on Host B -> 401)
tests/gui/ui1-24-one-project-v1-1.test.ts > UI1-24: One-Project MVP & v1.1 Multi-Window Readiness > 3. Parallel-Service Isolation Harness (v1.1 Hooks) > stable project-scoped APIs: both hosts respond to identical REST contract without schema modification
tests/gui/ui1-24-one-project-v1-1.test.ts > UI1-24: One-Project MVP & v1.1 Multi-Window Readiness > 3. Parallel-Service Isolation Harness (v1.1 Hooks) > two isolated services run concurrently on distinct ports without conflict
tests/industrial/analysis-agent-auth-http.test.ts > authenticated Industrial analysis agent HTTP integration > fails closed when the completion audit append fails
tests/industrial/analysis-agent-auth-http.test.ts > authenticated Industrial analysis agent HTTP integration > keeps a successful replay record intact while reset and replay contend across service and CLI processes
tests/industrial/f10-01-industrial-cli.test.ts > F10-01: Industrial CLI Namespace > 3. Verify Execution > verifies audit chain via application services
tests/industrial/f10-01-industrial-cli.test.ts > F10-01: Industrial CLI Namespace > 4. Stop Execution & Confirmation Defense > confirmed force stop succeeds and records audit event
tests/industrial/f10-01-industrial-cli.test.ts > F10-01: Industrial CLI Namespace > 5. KB CLI Integration > runKbVerify executes through application services
tests/industrial/f10-01-industrial-cli.test.ts > F10-01: Industrial CLI Namespace > 7. Canary Invariant > rust/test.txt SHA-256 hash is strictly preserved
tests/industrial/f10-02-dashboard-trigger.test.ts > F10-02: Typed Dashboard Workflow Trigger > HTTP endpoint execution > handles POST /api/industrial/trigger via server and returns JSON with run/stage links
tests/industrial/f10-02-dashboard-trigger.test.ts > F10-02: Typed Dashboard Workflow Trigger > handleIndustrialTrigger execution > creates objective task accessible through TaskService without direct fake INGEST assignment
tests/industrial/f10-02-dashboard-trigger.test.ts > F10-02: Typed Dashboard Workflow Trigger > handleIndustrialTrigger execution > creates persistent workflow objective accessible through WorkflowService
tests/industrial/f10-02-dashboard-trigger.test.ts > F10-02: Typed Dashboard Workflow Trigger > handleIndustrialTrigger execution > dispatches typed workflow stage and returns run and stage links
tests/industrial/f10-02-dashboard-trigger.test.ts > F10-02: Typed Dashboard Workflow Trigger > handleIndustrialTrigger execution > records audited event in audit trail
tests/industrial/f10-02-dashboard-trigger.test.ts > F10-02: Typed Dashboard Workflow Trigger > handleIndustrialTrigger execution > supports custom goal parameter
tests/industrial/f10-04-public-demo-pack.test.ts > F10-04: Public Demo Pack Finalization & Provenance > Negative Clearance & Non-Proprietary Invariants > preserves canary hash byte-for-byte
tests/industrial/f10-04-public-demo-pack.test.ts > F10-04: Public Demo Pack Finalization & Provenance > guarantees cryptographic SHA-256 integrity for every cataloged asset
tests/industrial/f10-05-deterministic-reset.test.ts > F10-05: Deterministic Reset for Industrial Generated Test State > CLI Wrapper: runIndustrialReset > defaults to dry-run when --yes is omitted
tests/industrial/f10-05-deterministic-reset.test.ts > F10-05: Deterministic Reset for Industrial Generated Test State > CLI Wrapper: runIndustrialReset > executes confirmed live reset with --yes and returns exit code 0
tests/industrial/f10-05-deterministic-reset.test.ts > F10-05: Deterministic Reset for Industrial Generated Test State > CLI Wrapper: runIndustrialReset > rejects invalid category with INVALID_ARGS exit code 2
tests/industrial/f10-05-deterministic-reset.test.ts > F10-05: Deterministic Reset for Industrial Generated Test State > Confirmation & Live Execution > deletes allowlisted files when live reset is explicitly confirmed
tests/industrial/f10-05-deterministic-reset.test.ts > F10-05: Deterministic Reset for Industrial Generated Test State > Confirmation & Live Execution > rejects live execution when confirmed is false or omitted
tests/industrial/f10-05-deterministic-reset.test.ts > F10-05: Deterministic Reset for Industrial Generated Test State > Discovery & Category Allowlist > discovers all generated files when category is all
tests/industrial/f10-05-deterministic-reset.test.ts > F10-05: Deterministic Reset for Industrial Generated Test State > Discovery & Category Allowlist > filters discovery by runId when specified
tests/industrial/f10-05-deterministic-reset.test.ts > F10-05: Deterministic Reset for Industrial Generated Test State > Discovery & Category Allowlist > filters discovery strictly to specified allowlist categories
tests/industrial/f10-05-deterministic-reset.test.ts > F10-05: Deterministic Reset for Industrial Generated Test State > Dry-Run Safety Guarantee > reports candidates without removing any files during dry-run
tests/industrial/f10-05-deterministic-reset.test.ts > F10-05: Deterministic Reset for Industrial Generated Test State > Reset categories without coordinated writers > refuses conversation even in dry-run mode
tests/industrial/f10-05-deterministic-reset.test.ts > F10-05: Deterministic Reset for Industrial Generated Test State > Reset categories without coordinated writers > refuses index even in dry-run mode
tests/industrial/f10-05-deterministic-reset.test.ts > F10-05: Deterministic Reset for Industrial Generated Test State > Reset categories without coordinated writers > refuses sandbox even in dry-run mode
tests/industrial/f10-05-deterministic-reset.test.ts > F10-05: Deterministic Reset for Industrial Generated Test State > Reset categories without coordinated writers > returns an actionable failure from the Industrial CLI for a disabled category
tests/industrial/f10-05-deterministic-reset.test.ts > F10-05: Deterministic Reset for Industrial Generated Test State > Shared publication/reset boundary > counts only successful unlinks when one candidate cannot be removed
tests/industrial/f10-05-deterministic-reset.test.ts > F10-05: Deterministic Reset for Industrial Generated Test State > Shared publication/reset boundary > keeps an active generic publisher temp file out of cleanup and serializes CLI reset across processes
tests/industrial/f10-05-deterministic-reset.test.ts > F10-05: Deterministic Reset for Industrial Generated Test State > Shared publication/reset boundary > queue reset clears old checkpoints before a reused task ID can be recovered
tests/industrial/f10-05-deterministic-reset.test.ts > F10-05: Deterministic Reset for Industrial Generated Test State > Shared publication/reset boundary > refuses queue reset after TaskService interrupt until worker exit is established
tests/industrial/f10-05-deterministic-reset.test.ts > F10-05: Deterministic Reset for Industrial Generated Test State > Shared publication/reset boundary > refuses queue reset while a normal TaskService task is active
tests/industrial/f10-05-deterministic-reset.test.ts > F10-05: Deterministic Reset for Industrial Generated Test State > Shared publication/reset boundary > rejects a cross-process retry-queue writer while the project reset lock is held
tests/industrial/f10-05-deterministic-reset.test.ts > F10-05: Deterministic Reset for Industrial Generated Test State > Shared publication/reset boundary > rejects cross-process event and checkpoint writers while the reset lock is held
tests/industrial/f10-05-deterministic-reset.test.ts > F10-05: Deterministic Reset for Industrial Generated Test State > Shared publication/reset boundary > reports scanned and actually removed bytes separately when candidates disappear
tests/industrial/f10-05-deterministic-reset.test.ts > F10-05: Deterministic Reset for Industrial Generated Test State > Strict Negative Invariants > isForbiddenPath allows demo/industrial/generated outputs
tests/industrial/f10-05-deterministic-reset.test.ts > F10-05: Deterministic Reset for Industrial Generated Test State > Strict Negative Invariants > isForbiddenPath rejects anything in fixtures/
tests/industrial/f10-05-deterministic-reset.test.ts > F10-05: Deterministic Reset for Industrial Generated Test State > Strict Negative Invariants > isForbiddenPath rejects audit logs and root configs
tests/industrial/f10-05-deterministic-reset.test.ts > F10-05: Deterministic Reset for Industrial Generated Test State > Strict Negative Invariants > isForbiddenPath rejects canary file rust/test.txt
tests/industrial/f10-05-deterministic-reset.test.ts > F10-05: Deterministic Reset for Industrial Generated Test State > Strict Negative Invariants > isForbiddenPath rejects demo/industrial source files
tests/industrial/f10-05-deterministic-reset.test.ts > F10-05: Deterministic Reset for Industrial Generated Test State > Strict Negative Invariants > never scans or deletes review packets
tests/industrial/f10-05-deterministic-reset.test.ts > F10-05: Deterministic Reset for Industrial Generated Test State > Strict Negative Invariants > preserves canary hash byte-for-byte throughout all operations
tests/industrial/f10-06-judged-run.test.ts > F10-06: One-Command Judged Run > 1. Full End-to-End Judged Run Flow > executes all 6 stages in exact sequence with --auto-approve --yes
tests/industrial/f10-06-judged-run.test.ts > F10-06: One-Command Judged Run > 2. Confirmation & Human Gate Boundaries > halts with CONFIRMATION_REQUIRED (exit code 4) when --auto-approve is missing --yes
tests/industrial/f10-06-judged-run.test.ts > F10-06: One-Command Judged Run > 2. Confirmation & Human Gate Boundaries > halts with GATE_REJECTED (exit code 10) in interactive run without auto-approve
tests/industrial/f10-06-judged-run.test.ts > F10-06: One-Command Judged Run > 3. Fail-Closed Preflight Checks > aborts with PREFLIGHT_BLOCKED when health diagnostics fail
tests/industrial/f10-06-judged-run.test.ts > F10-06: One-Command Judged Run > 3. Fail-Closed Preflight Checks > aborts with PREFLIGHT_BLOCKED when the boundary cannot be established
tests/industrial/f10-06-judged-run.test.ts > F10-06: One-Command Judged Run > 3. Fail-Closed Preflight Checks > establishes a boundary for the run and leaves observation evidence behind
tests/industrial/f10-06-judged-run.test.ts > F10-06: One-Command Judged Run > 4. Fail-Closed Policy Checks > aborts with POLICY_VIOLATION (exit code 9) when safety_thresholds.json is missing
tests/industrial/f10-06-judged-run.test.ts > F10-06: One-Command Judged Run > 4. Fail-Closed Policy Checks > aborts with POLICY_VIOLATION when safety thresholds file is malformed
tests/industrial/f10-06-judged-run.test.ts > F10-06: One-Command Judged Run > 5. Fail-Closed Ingest Checks > aborts when demo telemetry files are missing
tests/industrial/f10-06-judged-run.test.ts > F10-06: One-Command Judged Run > 6. CLI Subcommand Wrapper & Output > fails verification when an auto-approved run cannot persist its finalizing manifest
tests/industrial/f10-06-judged-run.test.ts > F10-06: One-Command Judged Run > 6. CLI Subcommand Wrapper & Output > persists an auto-approved run manifest that same-run verification accepts
tests/industrial/f10-06-judged-run.test.ts > F10-06: One-Command Judged Run > 6. CLI Subcommand Wrapper & Output > reports the separate Rust engine prerequisite in structured CLI failures
tests/industrial/f10-06-judged-run.test.ts > F10-06: One-Command Judged Run > refuses to resume an approved run after report input changes
tests/industrial/f10-06-judged-run.test.ts > F10-06: One-Command Judged Run > refuses to resume an approved run after source evidence changes
tests/industrial/f10-06-judged-run.test.ts > F10-06: One-Command Judged Run > refuses to resume an approved run after threshold rules changes
tests/industrial/f10-06-judged-run.test.ts > F10-06: One-Command Judged Run > resumes an unchanged report only after a reviewer decision and independently verifies it
tests/industrial/f10-07-open-artifact.test.ts > F10-07: Open-Artifact Integration > 1. Target Safety Validation > approves alphanumeric artifact IDs
tests/industrial/f10-07-open-artifact.test.ts > F10-07: Open-Artifact Integration > 1. Target Safety Validation > approves clean relative paths
tests/industrial/f10-07-open-artifact.test.ts > F10-07: Open-Artifact Integration > 1. Target Safety Validation > rejects UNC network paths (REMOTE_URL_FORBIDDEN)
tests/industrial/f10-07-open-artifact.test.ts > F10-07: Open-Artifact Integration > 1. Target Safety Validation > rejects directory traversal sequences (PATH_TRAVERSAL_DETECTED)
tests/industrial/f10-07-open-artifact.test.ts > F10-07: Open-Artifact Integration > 1. Target Safety Validation > rejects empty or whitespace targets
tests/industrial/f10-07-open-artifact.test.ts > F10-07: Open-Artifact Integration > 1. Target Safety Validation > rejects http/https/ftp/file URLs (REMOTE_URL_FORBIDDEN)
tests/industrial/f10-07-open-artifact.test.ts > F10-07: Open-Artifact Integration > 1. Target Safety Validation > rejects shell injection characters (SHELL_INJECTION_DETECTED)
tests/industrial/f10-07-open-artifact.test.ts > F10-07: Open-Artifact Integration > 2. Launch Command Formulation > formulates Linux xdg-open / libreoffice command
tests/industrial/f10-07-open-artifact.test.ts > F10-07: Open-Artifact Integration > 2. Launch Command Formulation > formulates Windows LibreOffice command
tests/industrial/f10-07-open-artifact.test.ts > F10-07: Open-Artifact Integration > 2. Launch Command Formulation > formulates Windows Microsoft Office specific commands
tests/industrial/f10-07-open-artifact.test.ts > F10-07: Open-Artifact Integration > 2. Launch Command Formulation > formulates Windows default desktop launch command using cmd.exe start
tests/industrial/f10-07-open-artifact.test.ts > F10-07: Open-Artifact Integration > 2. Launch Command Formulation > formulates macOS open command
tests/industrial/f10-07-open-artifact.test.ts > F10-07: Open-Artifact Integration > 3. Positive Path Deliverable Opening (Dry Run) > validates XLSX and PPTX deliverables in dry-run mode
tests/industrial/f10-07-open-artifact.test.ts > F10-07: Open-Artifact Integration > 3. Positive Path Deliverable Opening (Dry Run) > validates existing PDF scan in dry-run mode
tests/industrial/f10-07-open-artifact.test.ts > F10-07: Open-Artifact Integration > 3. Positive Path Deliverable Opening (Dry Run) > validates existing turbine_safety_approval_note.docx in dry-run mode
tests/industrial/f10-07-open-artifact.test.ts > F10-07: Open-Artifact Integration > 4. Artifact Registry Resolution & Tamper Detection > detects tampering when on-disk file hash differs from registered artifact hash
tests/industrial/f10-07-open-artifact.test.ts > F10-07: Open-Artifact Integration > 4. Artifact Registry Resolution & Tamper Detection > resolves deliverable by registered artifact ID and checks hash
tests/industrial/f10-07-open-artifact.test.ts > F10-07: Open-Artifact Integration > 5. Negative Security & Confinement Invariants > rejects 0-byte empty file with exit code 1 (FAILURE)
tests/industrial/f10-07-open-artifact.test.ts > F10-07: Open-Artifact Integration > 5. Negative Security & Confinement Invariants > rejects directory traversal escaping project containment with exit code 2
tests/industrial/f10-07-open-artifact.test.ts > F10-07: Open-Artifact Integration > 5. Negative Security & Confinement Invariants > rejects executable formats (.exe, .bat, .cmd, .ps1, .sh, etc.)
tests/industrial/f10-07-open-artifact.test.ts > F10-07: Open-Artifact Integration > 5. Negative Security & Confinement Invariants > rejects non-existent file with exit code 11 (NOT_FOUND)
tests/industrial/f10-07-open-artifact.test.ts > F10-07: Open-Artifact Integration > 5. Negative Security & Confinement Invariants > rejects remote URLs with exit code 2 (INVALID_ARGS)
tests/industrial/f10-07-open-artifact.test.ts > F10-07: Open-Artifact Integration > 5. Negative Security & Confinement Invariants > rejects shell injection with exit code 2 (INVALID_ARGS)
tests/industrial/f10-07-open-artifact.test.ts > F10-07: Open-Artifact Integration > 6. Audit Logging & Disclaimer Verification > always includes explicit no-embedded-editor disclaimer
tests/industrial/f10-07-open-artifact.test.ts > F10-07: Open-Artifact Integration > 6. Audit Logging & Disclaimer Verification > records ARTIFACT_OPENED audit event with delivery hash upon open
tests/industrial/f10-07-open-artifact.test.ts > F10-07: Open-Artifact Integration > 7. Industrial CLI Command Wrapper (runIndustrialOpen) > executes CLI wrapper successfully with valid deliverable in json mode
tests/industrial/f10-07-open-artifact.test.ts > F10-07: Open-Artifact Integration > 7. Industrial CLI Command Wrapper (runIndustrialOpen) > returns exit code 11 on missing target via CLI wrapper
tests/industrial/f10-07-open-artifact.test.ts > F10-07: Open-Artifact Integration > 7. Industrial CLI Command Wrapper (runIndustrialOpen) > returns exit code 2 on invalid target via CLI wrapper
tests/industrial/f10-09-cli-gui-equivalence.test.ts > F10-09: CLI / GUI Equivalence Fixtures & Invariants > 1. Zero GUI Shell-Out Invariant > verifies equivalence fixture contract file is present and valid
tests/industrial/f10-09-cli-gui-equivalence.test.ts > F10-09: CLI / GUI Equivalence Fixtures & Invariants > 1. Zero GUI Shell-Out Invariant > verifies no GUI source file imports child_process, exec, or spawn
tests/industrial/f10-09-cli-gui-equivalence.test.ts > F10-09: CLI / GUI Equivalence Fixtures & Invariants > 2. Workflow & DAG Projection Equivalence > produces identical typed workflow projections via CockpitService and REST API
tests/industrial/f10-09-cli-gui-equivalence.test.ts > F10-09: CLI / GUI Equivalence Fixtures & Invariants > 3. Approval Governance Equivalence > processes approval decisions with identical schemas and validations across CLI & REST
tests/industrial/f10-09-cli-gui-equivalence.test.ts > F10-09: CLI / GUI Equivalence Fixtures & Invariants > 3. Approval Governance Equivalence > rejects unauthorized actor roles with equivalent fail-closed errors
tests/industrial/f10-09-cli-gui-equivalence.test.ts > F10-09: CLI / GUI Equivalence Fixtures & Invariants > 4. Artifact Integrity & SHA-256 Equivalence > computes identical authoritative SHA-256 hashes for CLI and REST artifact paths
tests/industrial/f10-09-cli-gui-equivalence.test.ts > F10-09: CLI / GUI Equivalence Fixtures & Invariants > 4. Artifact Integrity & SHA-256 Equivalence > rejects path traversal attempts across both interfaces
tests/industrial/f10-09-cli-gui-equivalence.test.ts > F10-09: CLI / GUI Equivalence Fixtures & Invariants > 5. Lifecycle Stop & Interruption Equivalence > enforces mandatory confirmation for force-stop across CLI and REST adapters
tests/industrial/f10-09-cli-gui-equivalence.test.ts > F10-09: CLI / GUI Equivalence Fixtures & Invariants > 5. Lifecycle Stop & Interruption Equivalence > executes confirmed stop identically across CLI and REST
tests/industrial/f11-01-full-e2e-automation.test.ts > F11-01: Full End-to-End Automation (D1–D7) > D1: Ingestion & Host Boundary Preflight > executes preflight diagnostics and validates offline boundary status
tests/industrial/f11-01-full-e2e-automation.test.ts > F11-01: Full End-to-End Automation (D1–D7) > D1: Ingestion & Host Boundary Preflight > verifies model manager local registry and endpoint identity
tests/industrial/f11-01-full-e2e-automation.test.ts > F11-01: Full End-to-End Automation (D1–D7) > D2: Agentic Document Task & OCR Citations > synthesizes verified approval note with explicit citations and source hashes
tests/industrial/f11-01-full-e2e-automation.test.ts > F11-01: Full End-to-End Automation (D1–D7) > D2: Agentic Document Task & OCR Citations > verifies public inspection sample presence and provenance hash
tests/industrial/f11-01-full-e2e-automation.test.ts > F11-01: Full End-to-End Automation (D1–D7) > D3: Coding Sandbox RMS Calculation > verifies RMS calculation algorithm against ground truth and calculation trace
tests/industrial/f11-01-full-e2e-automation.test.ts > F11-01: Full End-to-End Automation (D1–D7) > D4: Multimodal Analysis & Conflict Review > verifies public demo pack provenance manifest and asset integrity
tests/industrial/f11-01-full-e2e-automation.test.ts > F11-01: Full End-to-End Automation (D1–D7) > D5: Office Artifacts Suite (.docx, .xlsx, .pptx) > generates valid OOXML .pptx presentation deliverable
tests/industrial/f11-01-full-e2e-automation.test.ts > F11-01: Full End-to-End Automation (D1–D7) > D5: Office Artifacts Suite (.docx, .xlsx, .pptx) > generates valid OOXML .xlsx spreadsheet deliverable
tests/industrial/f11-01-full-e2e-automation.test.ts > F11-01: Full End-to-End Automation (D1–D7) > D6: Sovereign Evidence Bundle & Audit Chain > cryptographically verifies hash chain integrity of the audit log
tests/industrial/f11-01-full-e2e-automation.test.ts > F11-01: Full End-to-End Automation (D1–D7) > D6: Sovereign Evidence Bundle & Audit Chain > exports complete audit trail containing sealed cryptographic records
tests/industrial/f11-01-full-e2e-automation.test.ts > F11-01: Full End-to-End Automation (D1–D7) > D7: Judged Operator Journey & Client Parity > completes the full judged operator journey with verified verdict and artifacts
tests/industrial/f11-01-full-e2e-automation.test.ts > F11-01: Full End-to-End Automation (D1–D7) > Negative Requirements & Safety Invariants > halts with CONFIRMATION_REQUIRED when auto-approval is not explicitly confirmed
tests/industrial/f11-01-full-e2e-automation.test.ts > F11-01: Full End-to-End Automation (D1–D7) > Negative Requirements & Safety Invariants > halts with GATE_REJECTED when interactive approval is rejected
tests/industrial/f11-01-full-e2e-automation.test.ts > F11-01: Full End-to-End Automation (D1–D7) > Negative Requirements & Safety Invariants > verifies GUI source code contains zero shell-out commands
tests/industrial/f11-02-cold-warm-performance.test.ts > F11-02: Cold/Warm Performance Suite > 1. Launcher Startup Performance (Budget: < 2,000 ms) > measures 3 consecutive runs and verifies all are under budget
tests/industrial/f11-02-cold-warm-performance.test.ts > F11-02: Cold/Warm Performance Suite > 10. Sandbox RMS Calculation & Trace (Budget: < 30,000 ms) > measures 3 consecutive RMS calculation trace evaluations
tests/industrial/f11-02-cold-warm-performance.test.ts > F11-02: Cold/Warm Performance Suite > 11. Office Deliverables Generation (Budget: < 3,000 ms each) > measures 3 consecutive DOCX generations
tests/industrial/f11-02-cold-warm-performance.test.ts > F11-02: Cold/Warm Performance Suite > 11. Office Deliverables Generation (Budget: < 3,000 ms each) > measures 3 consecutive PPTX generations
tests/industrial/f11-02-cold-warm-performance.test.ts > F11-02: Cold/Warm Performance Suite > 11. Office Deliverables Generation (Budget: < 3,000 ms each) > measures 3 consecutive XLSX generations
tests/industrial/f11-02-cold-warm-performance.test.ts > F11-02: Cold/Warm Performance Suite > 12. GUI Shell Rendering Performance (Budgets: < 3,000 ms first paint, < 5,000 ms interactive) > measures 3 consecutive renders of the shell components
tests/industrial/f11-02-cold-warm-performance.test.ts > F11-02: Cold/Warm Performance Suite > 13. Total Judged D7 Operator Journey (Budget: < 900,000 ms / 15 min) > executes 3 complete runs of the full judged operator journey and checks each against 15 min budget
tests/industrial/f11-02-cold-warm-performance.test.ts > F11-02: Cold/Warm Performance Suite > 14. Negative Anti-Averaging Invariant > strictly rejects hidden averaging: a single budget violation must fail validation regardless of average
tests/industrial/f11-02-cold-warm-performance.test.ts > F11-02: Cold/Warm Performance Suite > 2. Project Service Startup Performance (Budget: < 3,000 ms) > measures 3 consecutive startup/shutdown cycles and verifies all are under budget
tests/industrial/f11-02-cold-warm-performance.test.ts > F11-02: Cold/Warm Performance Suite > 3. Model Manager Lease & Resolution (Budget: < 15,000 ms) > measures 3 consecutive model registry listing and lease lookups
tests/industrial/f11-02-cold-warm-performance.test.ts > F11-02: Cold/Warm Performance Suite > 4. Rust Engine CSV Parse (Budget: < 100 ms) > measures 3 consecutive sensor CSV parse calls across 500 rows
tests/industrial/f11-02-cold-warm-performance.test.ts > F11-02: Cold/Warm Performance Suite > 5. Rust Engine Threshold Evaluation (Budget: < 50 ms) > measures 3 consecutive threshold evaluations
tests/industrial/f11-02-cold-warm-performance.test.ts > F11-02: Cold/Warm Performance Suite > 6. Rust Engine Hash & Chain Verification (Budget: < 200 ms) > measures 3 consecutive hash-chain evaluations
tests/industrial/f11-02-cold-warm-performance.test.ts > F11-02: Cold/Warm Performance Suite > 7. Printed-Text OCR per Page (Budget: < 5,000 ms) > measures 3 consecutive single-page OCR extractions
tests/industrial/f11-02-cold-warm-performance.test.ts > F11-02: Cold/Warm Performance Suite > 8. Knowledge-Base Retrieval (Budget: < 2,000 ms) > measures 3 consecutive top-5 search queries
tests/industrial/f11-02-cold-warm-performance.test.ts > F11-02: Cold/Warm Performance Suite > 9. Text / Task Inference Route (Budget: < 15,000 ms) > measures 3 consecutive inference executions
tests/industrial/f11-03-failure-matrix.test.ts > F11-03: System Failure Matrix & Safe Recovery > 1. Missing or Tampered Rust Executable > fails closed when Rust executable does not exist
tests/industrial/f11-03-failure-matrix.test.ts > F11-03: System Failure Matrix & Safe Recovery > 1. Missing or Tampered Rust Executable > fails closed when Rust executable hash is tampered
tests/industrial/f11-03-failure-matrix.test.ts > F11-03: System Failure Matrix & Safe Recovery > 10. Service Crash Recovery & Atomic Cleanup > transitions active tasks to INTERRUPTED and cleans temporary artifacts on emergency teardown
tests/industrial/f11-03-failure-matrix.test.ts > F11-03: System Failure Matrix & Safe Recovery > 11. Firewall Interruption & Boundary Violation > halts industrial preflight with PREFLIGHT_BLOCKED when firewall is inactive
tests/industrial/f11-03-failure-matrix.test.ts > F11-03: System Failure Matrix & Safe Recovery > 12. Negative Invariants: Anti-False-Success, Anti-Data-Mixing, Anti-Unbounded-Retry > strictly bounds maximum retry count to prevent infinite retry loops
tests/industrial/f11-03-failure-matrix.test.ts > F11-03: System Failure Matrix & Safe Recovery > 12. Negative Invariants: Anti-False-Success, Anti-Data-Mixing, Anti-Unbounded-Retry > strictly forbids false success: errors never report ok: true or status: completed
tests/industrial/f11-03-failure-matrix.test.ts > F11-03: System Failure Matrix & Safe Recovery > 12. Negative Invariants: Anti-False-Success, Anti-Data-Mixing, Anti-Unbounded-Retry > strictly limits retries: non-retryable errors are dead-lettered immediately
tests/industrial/f11-03-failure-matrix.test.ts > F11-03: System Failure Matrix & Safe Recovery > 2. Missing or Tampered Model Registry > rejects unverified or nonexistent model IDs
tests/industrial/f11-03-failure-matrix.test.ts > F11-03: System Failure Matrix & Safe Recovery > 3. Corrupt Knowledge-Base Index > fails closed and refuses to fabricate citations when index is unbuilt or corrupt
tests/industrial/f11-03-failure-matrix.test.ts > F11-03: System Failure Matrix & Safe Recovery > 4. OCR / VLM Timeout & Corrupted Input > cleans up scratch artifacts on OCR failure without leaving orphan temp files
tests/industrial/f11-03-failure-matrix.test.ts > F11-03: System Failure Matrix & Safe Recovery > 4. OCR / VLM Timeout & Corrupted Input > fails safely and cleanly when given corrupted PDF bytes
tests/industrial/f11-03-failure-matrix.test.ts > F11-03: System Failure Matrix & Safe Recovery > 5. No Route / Unsupported Capability > demands structured clarification when user intent is ambiguous or vague
tests/industrial/f11-03-failure-matrix.test.ts > F11-03: System Failure Matrix & Safe Recovery > 5. No Route / Unsupported Capability > returns UNSUPPORTED or CLARIFICATION_REQUIRED instead of hallucinating execution steps
tests/industrial/f11-03-failure-matrix.test.ts > F11-03: System Failure Matrix & Safe Recovery > 6. Sandbox Execution Failure & Safety Rejection > propagates nonzero exit codes or fails closed when runner is unavailable, never fabricating success
tests/industrial/f11-03-failure-matrix.test.ts > F11-03: System Failure Matrix & Safe Recovery > 6. Sandbox Execution Failure & Safety Rejection > rejects forbidden host executor requests in industrial mode
tests/industrial/f11-03-failure-matrix.test.ts > F11-03: System Failure Matrix & Safe Recovery > 7. Path Traversal & Unauthorized Scope Escape > fails closed when attempting path traversal outside project root
tests/industrial/f11-03-failure-matrix.test.ts > F11-03: System Failure Matrix & Safe Recovery > 7. Path Traversal & Unauthorized Scope Escape > rejects unapproved overwrite of finalized artifacts
tests/industrial/f11-03-failure-matrix.test.ts > F11-03: System Failure Matrix & Safe Recovery > 8. Loopback Port Collision & Port Hijack Defense > detects occupied loopback port and fails closed without hijacking
tests/industrial/f11-03-failure-matrix.test.ts > F11-03: System Failure Matrix & Safe Recovery > 8. Loopback Port Collision & Port Hijack Defense > ephemeral port 0 safely finds an unoccupied port without collision
tests/industrial/f11-03-failure-matrix.test.ts > F11-03: System Failure Matrix & Safe Recovery > 9. Event Sequence Gap & Replay Defense > detects sequence gaps in event stream and avoids inventing completions
tests/industrial/f11-04-quality-security-suite.test.ts > F11-04: Full Quality & Security Suite > 1. TypeScript & React Quality > GUI TypeScript project config compiles cleanly with no emit errors
tests/industrial/f11-04-quality-security-suite.test.ts > F11-04: Full Quality & Security Suite > 1. TypeScript & React Quality > production GUI distribution bundle exists and is valid
tests/industrial/f11-04-quality-security-suite.test.ts > F11-04: Full Quality & Security Suite > 2. Rust Engine Security & Quality > Rust codebase contains zero unsafe blocks across all source files
tests/industrial/f11-04-quality-security-suite.test.ts > F11-04: Full Quality & Security Suite > 2. Rust Engine Security & Quality > Rust codebase passes cargo fmt format check cleanly
tests/industrial/f11-04-quality-security-suite.test.ts > F11-04: Full Quality & Security Suite > 2. Rust Engine Security & Quality > Rust compiler and clippy pass with zero warnings under -D warnings
tests/industrial/f11-04-quality-security-suite.test.ts > F11-04: Full Quality & Security Suite > 2. Rust Engine Security & Quality > Rust engine enforces #![forbid(unsafe_code)] at crate root
tests/industrial/f11-04-quality-security-suite.test.ts > F11-04: Full Quality & Security Suite > 2. Rust Engine Security & Quality > all Rust workspace unit and integration tests pass
tests/industrial/f11-04-quality-security-suite.test.ts > F11-04: Full Quality & Security Suite > 3. Python Syntax & Compilation > all project Python scripts compile cleanly with python -m py_compile
tests/industrial/f11-04-quality-security-suite.test.ts > F11-04: Full Quality & Security Suite > 4. Container & Sandbox Security Manifest > enforces non-root execution and dropAll capabilities
tests/industrial/f11-04-quality-security-suite.test.ts > F11-04: Full Quality & Security Suite > 4. Container & Sandbox Security Manifest > lists essential prohibited networking packages and shell binaries
tests/industrial/f11-04-quality-security-suite.test.ts > F11-04: Full Quality & Security Suite > 4. Container & Sandbox Security Manifest > sandbox manifest exists and matches version 1 schema
tests/industrial/f11-04-quality-security-suite.test.ts > F11-04: Full Quality & Security Suite > 4. Container & Sandbox Security Manifest > strictly confines resource bounds
tests/industrial/f11-04-quality-security-suite.test.ts > F11-04: Full Quality & Security Suite > 5. Package Dependencies, Vulnerabilities & Licensing > npm audit reports zero production vulnerabilities
tests/industrial/f11-04-quality-security-suite.test.ts > F11-04: Full Quality & Security Suite > 5. Package Dependencies, Vulnerabilities & Licensing > package.json has valid permissive open source license (MIT)
tests/industrial/f11-04-quality-security-suite.test.ts > F11-04: Full Quality & Security Suite > 5. Package Dependencies, Vulnerabilities & Licensing > root LICENSE file exists and specifies MIT license
tests/industrial/f11-04-quality-security-suite.test.ts > F11-04: Full Quality & Security Suite > 6. Secret Shield & Credential Defense > no active unencrypted private keys or cloud keys in repository source files
tests/industrial/f11-04-quality-security-suite.test.ts > F11-04: Full Quality & Security Suite > 6. Secret Shield & Credential Defense > pre-commit secrets script exists and defines credential detection regexes
tests/industrial/f11-04-quality-security-suite.test.ts > F11-04: Full Quality & Security Suite > 7. Negative Invariants & Canary Protection > canary hash fails assertion if tampered
tests/industrial/f11-04-quality-security-suite.test.ts > F11-04: Full Quality & Security Suite > 7. Negative Invariants & Canary Protection > strict preservation of canary file rust/test.txt SHA-256
tests/industrial/f4-01-pdf-rasterization.test.ts > F4-01: Bounded PDF Rasterization > 1. Valid Scanned & Content PDF Rasterization > rasterizes a scanned PDF with embedded raster image stream
tests/industrial/f4-01-pdf-rasterization.test.ts > F4-01: Bounded PDF Rasterization > 1. Valid Scanned & Content PDF Rasterization > rasterizes a valid single-page PDF to PNG with deterministic metadata
tests/industrial/f4-01-pdf-rasterization.test.ts > F4-01: Bounded PDF Rasterization > 1. Valid Scanned & Content PDF Rasterization > rasterizes multi-page PDF documents in correct 1-indexed order
tests/industrial/f4-01-pdf-rasterization.test.ts > F4-01: Bounded PDF Rasterization > 1. Valid Scanned & Content PDF Rasterization > renders specific target pages when targetPages option is supplied
tests/industrial/f4-01-pdf-rasterization.test.ts > F4-01: Bounded PDF Rasterization > 1. Valid Scanned & Content PDF Rasterization > supports JPEG output format when explicitly requested
tests/industrial/f4-01-pdf-rasterization.test.ts > F4-01: Bounded PDF Rasterization > 5. Safe Artifact Store & Audit Trail Integrity > finalizes all rendered pages via Safe Artifact Store with atomic rename
tests/industrial/f4-01-pdf-rasterization.test.ts > F4-01: Bounded PDF Rasterization > 5. Safe Artifact Store & Audit Trail Integrity > produces deterministic output across repeated rasterization calls
tests/industrial/f4-01-pdf-rasterization.test.ts > F4-01: Bounded PDF Rasterization > 5. Safe Artifact Store & Audit Trail Integrity > records an immutable audit event on success and zero events on error
tests/industrial/f4-01-pdf-rasterization.test.ts > F4-01: Bounded PDF Rasterization > 6. Protected Invariant Preservation > strictly preserves rust/test.txt SHA-256 hash invariant
tests/industrial/f4-02-printed-text-ocr.test.ts > F4-02: Printed-Text OCR > applies custom confidence thresholds when provided
tests/industrial/f4-02-printed-text-ocr.test.ts > F4-02: Printed-Text OCR > detects noisy/blurred scans and attaches warning with adjusted confidence
tests/industrial/f4-02-printed-text-ocr.test.ts > F4-02: Printed-Text OCR > detects rotated text and corrects orientation with appropriate warning
tests/industrial/f4-02-printed-text-ocr.test.ts > F4-02: Printed-Text OCR > extracts printed text from a clean image with high confidence and bounding boxes
tests/industrial/f4-02-printed-text-ocr.test.ts > F4-02: Printed-Text OCR > filters specific target pages when targetPages is supplied to ocrDocument
tests/industrial/f4-02-printed-text-ocr.test.ts > F4-02: Printed-Text OCR > finalizes OCR result JSON in Safe Artifact Store with atomic rename
tests/industrial/f4-02-printed-text-ocr.test.ts > F4-02: Printed-Text OCR > flags unsupported handwriting with explicit warning and low confidence
tests/industrial/f4-02-printed-text-ocr.test.ts > F4-02: Printed-Text OCR > handles empty/blank page gracefully without failure or phantom text
tests/industrial/f4-02-printed-text-ocr.test.ts > F4-02: Printed-Text OCR > processes multi-page documents end-to-end via bounded PDF rasterization
tests/industrial/f4-02-printed-text-ocr.test.ts > F4-02: Printed-Text OCR > produces deterministic output across repeated OCR calls
tests/industrial/f4-02-printed-text-ocr.test.ts > F4-02: Printed-Text OCR > propagates source SHA-256 hash accurately and checks expected hash
tests/industrial/f4-02-printed-text-ocr.test.ts > F4-02: Printed-Text OCR > records an immutable audit event on success and zero events on error
tests/industrial/f4-03-ocr-document-tool.test.ts > F4-03: Register ocr_document Tool > Authorized Tool Execution & Provenance > executes ocr_document via executeTool for an authorized agent and returns typed result
tests/industrial/f4-03-ocr-document-tool.test.ts > F4-03: Register ocr_document Tool > Authorized Tool Execution & Provenance > processes multi-page documents via programmatic executeOcrDocumentTool
tests/industrial/f4-03-ocr-document-tool.test.ts > F4-03: Register ocr_document Tool > Authorized Tool Execution & Provenance > supports async execution via executeOcrDocumentToolAsync
tests/industrial/f4-03-ocr-document-tool.test.ts > F4-03: Register ocr_document Tool > Durable Idempotency & Replay > rejects authorization context mismatch with identical requestId (UNAUTHORIZED_TOOL_CALL)
tests/industrial/f4-03-ocr-document-tool.test.ts > F4-03: Register ocr_document Tool > Durable Idempotency & Replay > rejects conflicting request payload with identical requestId (IDEMPOTENCY_CONFLICT)
tests/industrial/f4-03-ocr-document-tool.test.ts > F4-03: Register ocr_document Tool > Durable Idempotency & Replay > returns cached result on exact replay with matching requestId
tests/industrial/f4-03-ocr-document-tool.test.ts > F4-03: Register ocr_document Tool > Invariant Protection > strictly preserves rust/test.txt SHA-256 hash invariant
tests/industrial/f4-03-ocr-document-tool.test.ts > F4-03: Register ocr_document Tool > Page Range & Language Validation > restricts OCR to requested pageRange
tests/industrial/f4-03-ocr-document-tool.test.ts > F4-03: Register ocr_document Tool > Page Range & Language Validation > supports confidenceMode: strict
tests/industrial/f4-04-vlm-benchmark.test.ts > F4-04: Benchmark and Pin VLM > Integration with ModelService and ServiceContainer > wires ModelService to delegate lease lifecycle to SharedModelManager
tests/industrial/f4-04-vlm-benchmark.test.ts > F4-04: Benchmark and Pin VLM > Negative Guardrails & Edge Cases > rejects unqueued concurrent GPU residency with CONCURRENCY_VIOLATION
tests/industrial/f4-04-vlm-benchmark.test.ts > F4-04: Benchmark and Pin VLM > Protected Invariant Integrity > strictly preserves rust/test.txt SHA-256 hash invariant
tests/industrial/f4-04-vlm-benchmark.test.ts > F4-04: Benchmark and Pin VLM > Shared GPU Model Manager Ownership & Residency > enforces serialized residency: switching models unloads previous when no active leases
tests/industrial/f4-04-vlm-benchmark.test.ts > F4-04: Benchmark and Pin VLM > Shared GPU Model Manager Ownership & Residency > releases all leases and unloads residency on releaseAllLeases
tests/industrial/f4-04-vlm-benchmark.test.ts > F4-04: Benchmark and Pin VLM > Shared GPU Model Manager Ownership & Residency > supports cancelling queued requests
tests/industrial/f4-05-analyze-image-tool.test.ts > F4-05: Register analyze_image Tool > 10. Invariant Integrity > preserves rust/test.txt SHA-256 integrity strictly
tests/industrial/f4-05-analyze-image-tool.test.ts > F4-05: Register analyze_image Tool > 5. Shared Model Manager Lease Protocol & Invariants > acquires and releases lease in finally on success
tests/industrial/f4-05-analyze-image-tool.test.ts > F4-05: Register analyze_image Tool > 6. Task Types & Structured Observations > executes drawing-observation task with requiresReview = true
tests/industrial/f4-05-analyze-image-tool.test.ts > F4-05: Register analyze_image Tool > 6. Task Types & Structured Observations > executes general-observation task
tests/industrial/f4-05-analyze-image-tool.test.ts > F4-05: Register analyze_image Tool > 6. Task Types & Structured Observations > executes label-reading task with visual observations
tests/industrial/f4-05-analyze-image-tool.test.ts > F4-05: Register analyze_image Tool > 6. Task Types & Structured Observations > executes measurement task: enforces requiresReview = true (Safety Invariant)
tests/industrial/f4-05-analyze-image-tool.test.ts > F4-05: Register analyze_image Tool > 7. Safe Artifact Store & Audit Trail Integration > atomically finalizes observations artifact in evidence/vision/<hash>/
tests/industrial/f4-05-analyze-image-tool.test.ts > F4-05: Register analyze_image Tool > 7. Safe Artifact Store & Audit Trail Integration > records IMAGE_ANALYZED audit event strictly after artifact finalization
tests/industrial/f4-05-analyze-image-tool.test.ts > F4-05: Register analyze_image Tool > 8. Durable Mutation Idempotency > rejects different authContext on same requestId with UNAUTHORIZED_TOOL_CALL
tests/industrial/f4-05-analyze-image-tool.test.ts > F4-05: Register analyze_image Tool > 8. Durable Mutation Idempotency > rejects different payload on same requestId with IDEMPOTENCY_CONFLICT
tests/industrial/f4-05-analyze-image-tool.test.ts > F4-05: Register analyze_image Tool > 8. Durable Mutation Idempotency > replays exact cached response on identical requestId
tests/industrial/f4-05-analyze-image-tool.test.ts > F4-05: Register analyze_image Tool > 9. Async Execution & Dispatch > executes asynchronously via executeAnalyzeImageToolAsync
tests/industrial/f4-05-analyze-image-tool.test.ts > F4-05: Register analyze_image Tool > 9. Async Execution & Dispatch > invokes tool through executeTool dispatcher
tests/industrial/f4-06-conflict-review.test.ts > F4-06: OCR/VLM Conflict Review > 5. Human Review Decisions > executes decision accept_ocr: accepts OCR value and sets status accepted_ocr
tests/industrial/f4-06-conflict-review.test.ts > F4-06: OCR/VLM Conflict Review > 5. Human Review Decisions > executes decision accept_vision: accepts Vision value and sets status accepted_vision
tests/industrial/f4-06-conflict-review.test.ts > F4-06: OCR/VLM Conflict Review > 5. Human Review Decisions > executes decision enter_corrected_value: sets manual value and status manually_corrected
tests/industrial/f4-06-conflict-review.test.ts > F4-06: OCR/VLM Conflict Review > 5. Human Review Decisions > executes decision mark_unresolved: sets null value and status unresolved
tests/industrial/f4-06-conflict-review.test.ts > F4-06: OCR/VLM Conflict Review > 5. Human Review Decisions > executes decision reject_both: sets null value and status rejected
tests/industrial/f4-06-conflict-review.test.ts > F4-06: OCR/VLM Conflict Review > 5. Human Review Decisions > rejects enter_corrected_value if correctedValue is missing or empty
tests/industrial/f4-06-conflict-review.test.ts > F4-06: OCR/VLM Conflict Review > 5. Human Review Decisions > throws error when accept_ocr requested for item with no OCR observation
tests/industrial/f4-06-conflict-review.test.ts > F4-06: OCR/VLM Conflict Review > 5. Human Review Decisions > throws error when accept_vision requested for item with no Vision observation
tests/industrial/f4-06-conflict-review.test.ts > F4-06: OCR/VLM Conflict Review > 6. Full Provenance Retention > ResolvedObservation retains both original OCR and VLM source records
tests/industrial/f4-06-conflict-review.test.ts > F4-06: OCR/VLM Conflict Review > 7. Safe Artifact Store & Immutable Audit Trail > persists conflict reports under evidence/conflicts/<hash>/
tests/industrial/f4-06-conflict-review.test.ts > F4-06: OCR/VLM Conflict Review > 7. Safe Artifact Store & Immutable Audit Trail > persists resolutions under evidence/resolved/<hash>/
tests/industrial/f4-06-conflict-review.test.ts > F4-06: OCR/VLM Conflict Review > 7. Safe Artifact Store & Immutable Audit Trail > records immutable audit events strictly AFTER atomic artifact finalization
tests/industrial/f4-06-conflict-review.test.ts > F4-06: OCR/VLM Conflict Review > 7. Safe Artifact Store & Immutable Audit Trail > retrieves reports and resolved observations accurately via service methods
tests/industrial/f4-06-conflict-review.test.ts > F4-06: OCR/VLM Conflict Review > 8. Guardrails & Isolation > throws ITEM_NOT_FOUND when resolving non-existent item in valid report
tests/industrial/f4-07-multimodal-benchmark.test.ts > F4-07: Multimodal Benchmark Suite > 2. Pipeline Execution & 3-Run Determinism > executes 3-run benchmark and achieves deterministic output across supported fixtures
tests/industrial/f4-07-multimodal-benchmark.test.ts > F4-07: Multimodal Benchmark Suite > 3. Resource & Latency Budgets > enforces peak VRAM <= 6144 MiB across all benchmark runs
tests/industrial/f4-07-multimodal-benchmark.test.ts > F4-07: Multimodal Benchmark Suite > 3. Resource & Latency Budgets > respects latency budgets for cold start and inference
tests/industrial/f4-07-multimodal-benchmark.test.ts > F4-07: Multimodal Benchmark Suite > 5. Safe Artifact Store & Audit Verification > atomically finalizes report in Safe Artifact Store under evidence/benchmarks/
tests/industrial/f4-07-multimodal-benchmark.test.ts > F4-07: Multimodal Benchmark Suite > 5. Safe Artifact Store & Audit Verification > records MULTIMODAL_BENCHMARK_COMPLETED audit event verified by Rust engine
tests/industrial/f4-07-multimodal-benchmark.test.ts > F4-07: Multimodal Benchmark Suite > 6. Complete 24 Negative Tests > 17. Conflict report tampering: detected when artifact content is modified post-finalization
tests/industrial/f4-07-multimodal-benchmark.test.ts > F4-07: Multimodal Benchmark Suite > 6. Complete 24 Negative Tests > 18. Audit-chain tampering: detected by Rust engine chain verification
tests/industrial/f5-06-kb-retrieval-benchmark.test.ts > F5-06: Retrieval Evaluation & Knowledge-Base Search Benchmarking > 12. Atomic Evidence Persistence & Interruption Recovery > atomically saves report file and cleans up temporary files
tests/industrial/f5-06-kb-retrieval-benchmark.test.ts > F5-06: Retrieval Evaluation & Knowledge-Base Search Benchmarking > 13. Privacy-Safe Audit Trail Integration > records KB_EVALUATION_EXECUTED audit event with zero raw text
tests/industrial/f5-06-kb-retrieval-benchmark.test.ts > F5-06: Retrieval Evaluation & Knowledge-Base Search Benchmarking > 14. Tri-Modal Execution & Honest Assessment > honestly marks productionLiveBlocked = true when offline weights are absent
tests/industrial/f5-06-kb-retrieval-benchmark.test.ts > F5-06: Retrieval Evaluation & Knowledge-Base Search Benchmarking > 15. Protected File Invariant > preserves rust/test.txt SHA-256 integrity
tests/industrial/f5-06-kb-retrieval-benchmark.test.ts > F5-06: Retrieval Evaluation & Knowledge-Base Search Benchmarking > 4. End-to-End Benchmark Execution via Real Search Path > executes the full 24-query benchmark and produces a validated report
tests/industrial/f5-06-kb-retrieval-benchmark.test.ts > F5-06: Retrieval Evaluation & Knowledge-Base Search Benchmarking > 5. 3-Iteration Determinism Across Repeated Runs > records 3 complete iterations with 100% determinism rate
tests/industrial/f5-07-kb-cli.test.ts > F5-07: Knowledge-Base CLI and Service Operations > 2. Command: industrial kb build > builds knowledge base index successfully and returns exit code 0
tests/industrial/f5-07-kb-cli.test.ts > F5-07: Knowledge-Base CLI and Service Operations > 2. Command: industrial kb build > fails closed with MISSING_MODEL (code 12) when offline embedding snapshot is absent
tests/industrial/f5-07-kb-cli.test.ts > F5-07: Knowledge-Base CLI and Service Operations > 2. Command: industrial kb build > handles idempotent repeated build without corrupting state
tests/industrial/f5-07-kb-cli.test.ts > F5-07: Knowledge-Base CLI and Service Operations > 2. Command: industrial kb build > produces structured JSON output when --json is passed
tests/industrial/f5-07-kb-cli.test.ts > F5-07: Knowledge-Base CLI and Service Operations > 3. Command: industrial kb status > reports up_to_date state after successful build
tests/industrial/f5-07-kb-cli.test.ts > F5-07: Knowledge-Base CLI and Service Operations > 4. Command: industrial kb verify > detects stale index when source document is modified and fails with STALE_INDEX (code 15)
tests/industrial/f5-07-kb-cli.test.ts > F5-07: Knowledge-Base CLI and Service Operations > 4. Command: industrial kb verify > detects tampered index float and fails with INDEX_CORRUPT (code 14)
tests/industrial/f5-07-kb-cli.test.ts > F5-07: Knowledge-Base CLI and Service Operations > 4. Command: industrial kb verify > fails verification with INDEX_CORRUPT (code 14) before build
tests/industrial/f5-07-kb-cli.test.ts > F5-07: Knowledge-Base CLI and Service Operations > 4. Command: industrial kb verify > passes verification with exit code 0 after valid build
tests/industrial/f5-07-kb-cli.test.ts > F5-07: Knowledge-Base CLI and Service Operations > 4. Command: industrial kb verify > produces structured JSON output for verify when --json is passed
tests/industrial/f5-07-kb-cli.test.ts > F5-07: Knowledge-Base CLI and Service Operations > 5. Command: industrial kb clear > clears only generated KB artifacts when confirmed with --yes
tests/industrial/f5-07-kb-cli.test.ts > F5-07: Knowledge-Base CLI and Service Operations > 5. Command: industrial kb clear > handles idempotent repeated clear safely
tests/industrial/f5-07-kb-cli.test.ts > F5-07: Knowledge-Base CLI and Service Operations > 5. Command: industrial kb clear > requires confirmation and fails with CONFIRMATION_REQUIRED (code 16) when --yes is omitted
tests/industrial/f5-07-kb-cli.test.ts > F5-07: Knowledge-Base CLI and Service Operations > 5. Command: industrial kb clear > supports safe dry-run preview mode without deleting files
tests/industrial/f5-07-kb-cli.test.ts > F5-07: Knowledge-Base CLI and Service Operations > 6. Privacy & Audit Trail Verification > records privacy-preserving audit events without raw document or query text
tests/industrial/f5-07-kb-cli.test.ts > F5-07: Knowledge-Base CLI and Service Operations > 7. Cross-Project Isolation > fails closed when attempting to build or verify across project boundaries
tests/industrial/f5-07-kb-cli.test.ts > F5-07: Knowledge-Base CLI and Service Operations > 8. Protected File Invariant > preserves rust/test.txt SHA-256 integrity
tests/industrial/f6-01-office-artifact-inputs.test.ts > F6-01: Validated Office Artifact Inputs > 1. Valid Complete Inputs for Output Types > strictly preserves separation between structured data, prose, corrections, and conclusions
tests/industrial/f6-01-office-artifact-inputs.test.ts > F6-01: Validated Office Artifact Inputs > 1. Valid Complete Inputs for Output Types > validates a complete DOCX input successfully
tests/industrial/f6-01-office-artifact-inputs.test.ts > F6-01: Validated Office Artifact Inputs > 1. Valid Complete Inputs for Output Types > validates a complete PPTX input with slide presentation structure
tests/industrial/f6-01-office-artifact-inputs.test.ts > F6-01: Validated Office Artifact Inputs > 1. Valid Complete Inputs for Output Types > validates a complete XLSX input with tabular sheets
tests/industrial/f6-01-office-artifact-inputs.test.ts > F6-01: Validated Office Artifact Inputs > 10. Bounds and Limits Enforcement > rejects findings count exceeding limit
tests/industrial/f6-01-office-artifact-inputs.test.ts > F6-01: Validated Office Artifact Inputs > 10. Bounds and Limits Enforcement > rejects sections count exceeding limit
tests/industrial/f6-01-office-artifact-inputs.test.ts > F6-01: Validated Office Artifact Inputs > 10. Bounds and Limits Enforcement > rejects title exceeding maximum length
tests/industrial/f6-01-office-artifact-inputs.test.ts > F6-01: Validated Office Artifact Inputs > 10. Bounds and Limits Enforcement > rejects title shorter than minimum length
tests/industrial/f6-01-office-artifact-inputs.test.ts > F6-01: Validated Office Artifact Inputs > 12. Dynamic Freshness and Stale-Input Verification > detects missing source file on disk
tests/industrial/f6-01-office-artifact-inputs.test.ts > F6-01: Validated Office Artifact Inputs > 12. Dynamic Freshness and Stale-Input Verification > detects stale input when source file on disk is modified
tests/industrial/f6-01-office-artifact-inputs.test.ts > F6-01: Validated Office Artifact Inputs > 12. Dynamic Freshness and Stale-Input Verification > detects unapproved or revoked approval in approval store
tests/industrial/f6-01-office-artifact-inputs.test.ts > F6-01: Validated Office Artifact Inputs > 12. Dynamic Freshness and Stale-Input Verification > verifies freshness when all disk sources match citation hashes
tests/industrial/f6-01-office-artifact-inputs.test.ts > F6-01: Validated Office Artifact Inputs > 13. Privacy-Safe Audit Trail Integration > records audit events with cryptographic input hash and zero raw prose
tests/industrial/f6-01-office-artifact-inputs.test.ts > F6-01: Validated Office Artifact Inputs > 14. Protected Canary File Invariant > preserves rust/test.txt SHA-256 integrity unchanged
tests/industrial/f6-01-office-artifact-inputs.test.ts > F6-01: Validated Office Artifact Inputs > 2. Citations and Provenance Validation > rejects citation with invalid or tampered SHA-256 hash
tests/industrial/f6-01-office-artifact-inputs.test.ts > F6-01: Validated Office Artifact Inputs > 2. Citations and Provenance Validation > rejects finding referencing non-existent citationId
tests/industrial/f6-01-office-artifact-inputs.test.ts > F6-01: Validated Office Artifact Inputs > 2. Citations and Provenance Validation > rejects finding with empty citationIds
tests/industrial/f6-01-office-artifact-inputs.test.ts > F6-01: Validated Office Artifact Inputs > 2. Citations and Provenance Validation > rejects measurement with empty citationIds
tests/industrial/f6-01-office-artifact-inputs.test.ts > F6-01: Validated Office Artifact Inputs > 3. Units and Numeric Validation > rejects calculation with missing resultUnit
tests/industrial/f6-01-office-artifact-inputs.test.ts > F6-01: Validated Office Artifact Inputs > 3. Units and Numeric Validation > rejects finding with metric but missing unit
tests/industrial/f6-01-office-artifact-inputs.test.ts > F6-01: Validated Office Artifact Inputs > 3. Units and Numeric Validation > rejects measurement with NaN numericValue
tests/industrial/f6-01-office-artifact-inputs.test.ts > F6-01: Validated Office Artifact Inputs > 3. Units and Numeric Validation > rejects measurement with missing unit
tests/industrial/f6-01-office-artifact-inputs.test.ts > F6-01: Validated Office Artifact Inputs > 4. OCR/VLM Confidence and Conflict Guardrails > accepts low OCR confidence when reviewedByHuman is true with warning
tests/industrial/f6-01-office-artifact-inputs.test.ts > F6-01: Validated Office Artifact Inputs > 4. OCR/VLM Confidence and Conflict Guardrails > accepts low VLM confidence when reviewedByHuman is true with warning
tests/industrial/f6-01-office-artifact-inputs.test.ts > F6-01: Validated Office Artifact Inputs > 4. OCR/VLM Confidence and Conflict Guardrails > rejects input referencing quarantined evidence
tests/industrial/f6-01-office-artifact-inputs.test.ts > F6-01: Validated Office Artifact Inputs > 4. OCR/VLM Confidence and Conflict Guardrails > rejects input with REQUIRES_HUMAN_REVIEW that is still unresolved
tests/industrial/f6-01-office-artifact-inputs.test.ts > F6-01: Validated Office Artifact Inputs > 4. OCR/VLM Confidence and Conflict Guardrails > rejects input with unresolved conflicts
tests/industrial/f6-01-office-artifact-inputs.test.ts > F6-01: Validated Office Artifact Inputs > 4. OCR/VLM Confidence and Conflict Guardrails > rejects low OCR confidence without human review
tests/industrial/f6-01-office-artifact-inputs.test.ts > F6-01: Validated Office Artifact Inputs > 4. OCR/VLM Confidence and Conflict Guardrails > rejects low VLM confidence without human review
tests/industrial/f6-01-office-artifact-inputs.test.ts > F6-01: Validated Office Artifact Inputs > 5. Approval Enforcement > accepts input when approval is not required
tests/industrial/f6-01-office-artifact-inputs.test.ts > F6-01: Validated Office Artifact Inputs > 5. Approval Enforcement > accepts input when approval is required and status is approved
tests/industrial/f6-01-office-artifact-inputs.test.ts > F6-01: Validated Office Artifact Inputs > 5. Approval Enforcement > rejects input when approval is required but status is pending
tests/industrial/f6-01-office-artifact-inputs.test.ts > F6-01: Validated Office Artifact Inputs > 5. Approval Enforcement > rejects input when approval is required but status is rejected
tests/industrial/f6-01-office-artifact-inputs.test.ts > F6-01: Validated Office Artifact Inputs > 6. Cross-Project Confinement > permits matching projectId
tests/industrial/f6-01-office-artifact-inputs.test.ts > F6-01: Validated Office Artifact Inputs > 6. Cross-Project Confinement > rejects input whose projectId does not match active projectRoot
tests/industrial/f6-01-office-artifact-inputs.test.ts > F6-01: Validated Office Artifact Inputs > 7. Path Traversal & External Path Confinement > rejects citation sourcePath with absolute Windows path
tests/industrial/f6-01-office-artifact-inputs.test.ts > F6-01: Validated Office Artifact Inputs > 7. Path Traversal & External Path Confinement > rejects citation sourcePath with null byte
tests/industrial/f6-01-office-artifact-inputs.test.ts > F6-01: Validated Office Artifact Inputs > 7. Path Traversal & External Path Confinement > rejects citation sourcePath with path traversal (..)
tests/industrial/f6-01-office-artifact-inputs.test.ts > F6-01: Validated Office Artifact Inputs > 8. Spreadsheet Security: Formula Injection > rejects formula injection in finding statement
tests/industrial/f6-01-office-artifact-inputs.test.ts > F6-01: Validated Office Artifact Inputs > 8. Spreadsheet Security: Formula Injection > rejects formula injection in spreadsheet table cells
tests/industrial/f6-01-office-artifact-inputs.test.ts > F6-01: Validated Office Artifact Inputs > 9. Document Security: Macros, Scripts, and External URLs > rejects external URL in document title
tests/industrial/f6-01-office-artifact-inputs.test.ts > F6-01: Validated Office Artifact Inputs > 9. Document Security: Macros, Scripts, and External URLs > rejects macro reference in section content
tests/industrial/f6-01-office-artifact-inputs.test.ts > F6-01: Validated Office Artifact Inputs > 9. Document Security: Macros, Scripts, and External URLs > rejects script injection in section content
tests/industrial/f6-02-generate-docx.test.ts > F6-02: generate_docx Tool > allows overwrite when allowOverwrite is true and approval is valid
tests/industrial/f6-02-generate-docx.test.ts > F6-02: generate_docx Tool > authorizes approved agents (report_agent, doc_agent, supervisor_agent)
tests/industrial/f6-02-generate-docx.test.ts > F6-02: generate_docx Tool > dispatches generate_docx via executeTool
tests/industrial/f6-02-generate-docx.test.ts > F6-02: generate_docx Tool > executes generate_docx asynchronously via executeGenerateDocxToolAsync
tests/industrial/f6-02-generate-docx.test.ts > F6-02: generate_docx Tool > generates a valid, complete, editable .docx approval note locally and offline
tests/industrial/f6-02-generate-docx.test.ts > F6-02: generate_docx Tool > records privacy-safe audit events containing hashes and IDs without raw prose or secrets
tests/industrial/f6-02-generate-docx.test.ts > F6-02: generate_docx Tool > rejects collision when destination file already exists without allowOverwrite
tests/industrial/f6-02-generate-docx.test.ts > F6-02: generate_docx Tool > rejects document generation across project boundaries
tests/industrial/f6-02-generate-docx.test.ts > F6-02: generate_docx Tool > rejects document generation when a measurement lacks a unit
tests/industrial/f6-02-generate-docx.test.ts > F6-02: generate_docx Tool > rejects document generation when approval in store has been revoked or rejected
tests/industrial/f6-02-generate-docx.test.ts > F6-02: generate_docx Tool > rejects document generation when approval status is pending or rejected
tests/industrial/f6-02-generate-docx.test.ts > F6-02: generate_docx Tool > rejects document generation when cited source file on disk is missing
tests/industrial/f6-02-generate-docx.test.ts > F6-02: generate_docx Tool > rejects document generation when cited source file on disk is modified
tests/industrial/f6-02-generate-docx.test.ts > F6-02: generate_docx Tool > rejects document generation when evidence has low confidence and no human review
tests/industrial/f6-02-generate-docx.test.ts > F6-02: generate_docx Tool > rejects document generation when evidence has unresolved conflicts
tests/industrial/f6-02-generate-docx.test.ts > F6-02: generate_docx Tool > rejects document generation when evidence is quarantined
tests/industrial/f6-02-generate-docx.test.ts > F6-02: generate_docx Tool > rejects document generation when input changes after approval (tampered payloadHash)
tests/industrial/f6-02-generate-docx.test.ts > F6-02: generate_docx Tool > rejects inputs containing external URLs or protocols
tests/industrial/f6-02-generate-docx.test.ts > F6-02: generate_docx Tool > rejects inputs containing macro or executable references
tests/industrial/f6-02-generate-docx.test.ts > F6-02: generate_docx Tool > returns cached result on exact idempotent replay
tests/industrial/f6-02-generate-docx.test.ts > F6-02: generate_docx Tool > throws IDEMPOTENCY_CONFLICT when same requestId is used with conflicting parameters
tests/industrial/f6-03-generate-xlsx.test.ts > F6-03: generate_xlsx Tool > accepts low confidence evidence when human review override is provided
tests/industrial/f6-03-generate-xlsx.test.ts > F6-03: generate_xlsx Tool > allows overwrite when allowOverwrite is true and approval is provided
tests/industrial/f6-03-generate-xlsx.test.ts > F6-03: generate_xlsx Tool > authorizes approved agents (report_agent, doc_agent, supervisor_agent)
tests/industrial/f6-03-generate-xlsx.test.ts > F6-03: generate_xlsx Tool > dispatches generate_xlsx via executeTool
tests/industrial/f6-03-generate-xlsx.test.ts > F6-03: generate_xlsx Tool > generates a valid, complete XLSX workbook package with all mandatory sheets
tests/industrial/f6-03-generate-xlsx.test.ts > F6-03: generate_xlsx Tool > generates separate worksheet for embedded section tables
tests/industrial/f6-03-generate-xlsx.test.ts > F6-03: generate_xlsx Tool > preserves exact findings, measurements with units, calculations, and citations
tests/industrial/f6-03-generate-xlsx.test.ts > F6-03: generate_xlsx Tool > rejects calculations missing mandatory result units
tests/industrial/f6-03-generate-xlsx.test.ts > F6-03: generate_xlsx Tool > rejects conflicting request parameters with same requestId
tests/industrial/f6-03-generate-xlsx.test.ts > F6-03: generate_xlsx Tool > rejects cross-project access when input projectId does not match request
tests/industrial/f6-03-generate-xlsx.test.ts > F6-03: generate_xlsx Tool > rejects generation when OCR confidence is low and unreviewed by human
tests/industrial/f6-03-generate-xlsx.test.ts > F6-03: generate_xlsx Tool > rejects generation when approval status is pending
tests/industrial/f6-03-generate-xlsx.test.ts > F6-03: generate_xlsx Tool > rejects generation when cited physical source file is missing
tests/industrial/f6-03-generate-xlsx.test.ts > F6-03: generate_xlsx Tool > rejects generation when cited physical source file on disk is modified
tests/industrial/f6-03-generate-xlsx.test.ts > F6-03: generate_xlsx Tool > rejects generation when evidence is quarantined
tests/industrial/f6-03-generate-xlsx.test.ts > F6-03: generate_xlsx Tool > rejects generation when unresolved conflicts exist in evidence state
tests/industrial/f6-03-generate-xlsx.test.ts > F6-03: generate_xlsx Tool > rejects input containing external URLs
tests/industrial/f6-03-generate-xlsx.test.ts > F6-03: generate_xlsx Tool > rejects input containing macro indicators (.xlsm, vbaproject)
tests/industrial/f6-03-generate-xlsx.test.ts > F6-03: generate_xlsx Tool > rejects input with HYPERLINK execution injection in statements
tests/industrial/f6-03-generate-xlsx.test.ts > F6-03: generate_xlsx Tool > rejects input with formula injection pattern in findings
tests/industrial/f6-03-generate-xlsx.test.ts > F6-03: generate_xlsx Tool > rejects input with leading tab character in statements
tests/industrial/f6-03-generate-xlsx.test.ts > F6-03: generate_xlsx Tool > rejects measurements missing mandatory units
tests/industrial/f6-03-generate-xlsx.test.ts > F6-03: generate_xlsx Tool > rejects silent overwrite when file already exists and allowOverwrite is false
tests/industrial/f6-03-generate-xlsx.test.ts > F6-03: generate_xlsx Tool > replays identical cached result on exact idempotent duplicate request
tests/industrial/f6-03-generate-xlsx.test.ts > F6-03: generate_xlsx Tool > safely escapes benign text starting with formula characters by prepending single quote
tests/industrial/f6-03-generate-xlsx.test.ts > F6-03: generate_xlsx Tool > supports asynchronous execution via executeGenerateXlsxToolAsync
tests/industrial/f6-04-generate-pptx.test.ts > F6-04: generate_pptx Tool > accepts low confidence evidence when human review override is provided
tests/industrial/f6-04-generate-pptx.test.ts > F6-04: generate_pptx Tool > allows overwrite when allowOverwrite is true and approved approvalId is provided
tests/industrial/f6-04-generate-pptx.test.ts > F6-04: generate_pptx Tool > authorizes approved agents (report_agent, doc_agent, supervisor_agent, lead-inspector, auditor, test-agent, verification, admin)
tests/industrial/f6-04-generate-pptx.test.ts > F6-04: generate_pptx Tool > dispatches generate_pptx via synchronous executeTool
tests/industrial/f6-04-generate-pptx.test.ts > F6-04: generate_pptx Tool > generates a valid, complete PPTX presentation package with all mandatory slides and offline validation
tests/industrial/f6-04-generate-pptx.test.ts > F6-04: generate_pptx Tool > generates dedicated presentation slides for embedded section tables
tests/industrial/f6-04-generate-pptx.test.ts > F6-04: generate_pptx Tool > guarantees rust/test.txt canary file hash remains strictly intact
tests/industrial/f6-04-generate-pptx.test.ts > F6-04: generate_pptx Tool > offline package validator rejects packages containing malicious macro parts or external relationships
tests/industrial/f6-04-generate-pptx.test.ts > F6-04: generate_pptx Tool > preserves exact findings, measurements with units, calculations, citations, author, and approval metadata
tests/industrial/f6-04-generate-pptx.test.ts > F6-04: generate_pptx Tool > records privacy-safe audit events containing hashes and IDs without raw prose or secrets
tests/industrial/f6-04-generate-pptx.test.ts > F6-04: generate_pptx Tool > rejects calculations missing mandatory result units
tests/industrial/f6-04-generate-pptx.test.ts > F6-04: generate_pptx Tool > rejects conflicting request parameters with same requestId
tests/industrial/f6-04-generate-pptx.test.ts > F6-04: generate_pptx Tool > rejects cross-project access when input projectId does not match request
tests/industrial/f6-04-generate-pptx.test.ts > F6-04: generate_pptx Tool > rejects generation when OCR confidence is low and unreviewed by human
tests/industrial/f6-04-generate-pptx.test.ts > F6-04: generate_pptx Tool > rejects generation when approval status is pending or rejected
tests/industrial/f6-04-generate-pptx.test.ts > F6-04: generate_pptx Tool > rejects generation when evidence is quarantined
tests/industrial/f6-04-generate-pptx.test.ts > F6-04: generate_pptx Tool > rejects generation when unresolved conflicts exist in evidence state
tests/industrial/f6-04-generate-pptx.test.ts > F6-04: generate_pptx Tool > rejects input containing external URLs or protocols
tests/industrial/f6-04-generate-pptx.test.ts > F6-04: generate_pptx Tool > rejects input containing macro or executable indicators
tests/industrial/f6-04-generate-pptx.test.ts > F6-04: generate_pptx Tool > rejects measurements missing mandatory units
tests/industrial/f6-04-generate-pptx.test.ts > F6-04: generate_pptx Tool > rejects presentation generation when cited physical source file is missing
tests/industrial/f6-04-generate-pptx.test.ts > F6-04: generate_pptx Tool > rejects presentation generation when cited physical source file on disk is modified
tests/industrial/f6-04-generate-pptx.test.ts > F6-04: generate_pptx Tool > rejects silent overwrite when file already exists and allowOverwrite is false
tests/industrial/f6-04-generate-pptx.test.ts > F6-04: generate_pptx Tool > replays identical cached result on exact idempotent duplicate request
tests/industrial/f6-04-generate-pptx.test.ts > F6-04: generate_pptx Tool > supports asynchronous execution via executeGeneratePptxToolAsync
tests/industrial/f6-05-template-output-safety.test.ts > F6-05: Template and Output Safety > 3. OfficeTemplateSafetyService > assertTemplateSafety throws TemplateSafetyError on invalid template
tests/industrial/f6-05-template-output-safety.test.ts > F6-05: Template and Output Safety > 3. OfficeTemplateSafetyService > rejects an invalid template file and emits TEMPLATE_REJECTED audit event
tests/industrial/f6-05-template-output-safety.test.ts > F6-05: Template and Output Safety > 3. OfficeTemplateSafetyService > validates a valid template file and emits TEMPLATE_VALIDATED audit event
tests/industrial/f6-05-template-output-safety.test.ts > F6-05: Template and Output Safety > 4. Generator Integration Tests with Templates > generateDocx fails closed when template contains embedded OLE active content
tests/industrial/f6-05-template-output-safety.test.ts > F6-05: Template and Output Safety > 4. Generator Integration Tests with Templates > generateDocx fails closed when templatePath uses prohibited macro extension (.docm)
tests/industrial/f6-05-template-output-safety.test.ts > F6-05: Template and Output Safety > 4. Generator Integration Tests with Templates > generateDocx succeeds with approved template and records templatePath in artifact metadata
tests/industrial/f6-05-template-output-safety.test.ts > F6-05: Template and Output Safety > 4. Generator Integration Tests with Templates > generatePptx fails closed when template contains executable command pattern
tests/industrial/f6-05-template-output-safety.test.ts > F6-05: Template and Output Safety > 4. Generator Integration Tests with Templates > generatePptx fails closed when templatePath is macro-enabled (.pptm)
tests/industrial/f6-05-template-output-safety.test.ts > F6-05: Template and Output Safety > 4. Generator Integration Tests with Templates > generatePptx succeeds with approved template and records templatePath in artifact metadata
tests/industrial/f6-05-template-output-safety.test.ts > F6-05: Template and Output Safety > 4. Generator Integration Tests with Templates > generateXlsx fails closed when template contains formula injection
tests/industrial/f6-05-template-output-safety.test.ts > F6-05: Template and Output Safety > 4. Generator Integration Tests with Templates > generateXlsx fails closed when templatePath is macro-enabled (.xlsm)
tests/industrial/f6-05-template-output-safety.test.ts > F6-05: Template and Output Safety > 4. Generator Integration Tests with Templates > generateXlsx succeeds with approved template and records templatePath in artifact metadata
tests/industrial/f6-05-template-output-safety.test.ts > F6-05: Template and Output Safety > 5. Pre-Finalization Output Package Safety > rejects output packages that fail package safety before finalization
tests/industrial/f6-05-template-output-safety.test.ts > F6-05: Template and Output Safety > 5. Pre-Finalization Output Package Safety > verifies generated DOCX, XLSX, and PPTX pass pre-finalization output safety
tests/industrial/f6-05-template-output-safety.test.ts > F6-05: Template and Output Safety > 6. Tool Boundary and Scope Confinement for templatePath > dispatches tool call with valid templatePath via executeTool
tests/industrial/f6-05-template-output-safety.test.ts > F6-05: Template and Output Safety > 7. Invariants and Canary File Integrity > guarantees rust/test.txt canary file hash remains strictly intact
tests/industrial/f6-05-template-output-safety.test.ts > F6-05: Template and Output Safety > 7. Invariants and Canary File Integrity > records privacy-safe audit events containing hashes and IDs without raw prose or secrets
tests/industrial/f6-06-visual-regression.test.ts > F6-06: Visual Regression and Quality Review > 1. Minimal Valid Deliverables Visual Quality > validates minimal valid DOCX with approved verdict and zero blocking errors
tests/industrial/f6-06-visual-regression.test.ts > F6-06: Visual Regression and Quality Review > 1. Minimal Valid Deliverables Visual Quality > validates minimal valid PPTX with approved verdict, 16:9 canvas, and governance slides
tests/industrial/f6-06-visual-regression.test.ts > F6-06: Visual Regression and Quality Review > 1. Minimal Valid Deliverables Visual Quality > validates minimal valid XLSX with approved verdict and organized sheets
tests/industrial/f6-06-visual-regression.test.ts > F6-06: Visual Regression and Quality Review > 10. Invariants and Canary File Integrity > guarantees rust/test.txt canary file hash remains strictly intact
tests/industrial/f6-06-visual-regression.test.ts > F6-06: Visual Regression and Quality Review > 2. Long Titles and Section Paragraphs Layout Bounds > DOCX correctly bounds long title and lengthy multiline paragraph
tests/industrial/f6-06-visual-regression.test.ts > F6-06: Visual Regression and Quality Review > 2. Long Titles and Section Paragraphs Layout Bounds > PPTX title stays within title-safe canvas area with long title
tests/industrial/f6-06-visual-regression.test.ts > F6-06: Visual Regression and Quality Review > 2. Long Titles and Section Paragraphs Layout Bounds > XLSX column widths accommodate extended titles and headings without clipping
tests/industrial/f6-06-visual-regression.test.ts > F6-06: Visual Regression and Quality Review > 3. Large Findings and Measurement Tables > DOCX table grid remains strictly bounded within printable width with 15 findings
tests/industrial/f6-06-visual-regression.test.ts > F6-06: Visual Regression and Quality Review > 3. Large Findings and Measurement Tables > PPTX renders dedicated slides for embedded section tables within 16:9 canvas
tests/industrial/f6-06-visual-regression.test.ts > F6-06: Visual Regression and Quality Review > 4. Multiple Citations and Provenance Ledger > verifies visual layout of citations ledger with 10 cryptographic citations
tests/industrial/f6-06-visual-regression.test.ts > F6-06: Visual Regression and Quality Review > 5. Empty Optional Sections Fallback Handling > DOCX gracefully renders clean fallbacks with empty optional collections
tests/industrial/f6-06-visual-regression.test.ts > F6-06: Visual Regression and Quality Review > 5. Empty Optional Sections Fallback Handling > PPTX renders standard boundary cards when warnings and prose blocks are empty
tests/industrial/f6-06-visual-regression.test.ts > F6-06: Visual Regression and Quality Review > 6. XLSX Column Auto-Widths & Bounds > verifies column widths dynamically scale and bounds are correctly formed
tests/industrial/f6-06-visual-regression.test.ts > F6-06: Visual Regression and Quality Review > 7. Negative Fault & Overflow Detection > detects and flags missing verdict banner and reviewer sign-off block in DOCX
tests/industrial/f6-06-visual-regression.test.ts > F6-06: Visual Regression and Quality Review > 7. Negative Fault & Overflow Detection > detects and flags unsegregated model prose lacking warning disclaimer
tests/industrial/f6-06-visual-regression.test.ts > F6-06: Visual Regression and Quality Review > 7. Negative Fault & Overflow Detection > detects and rejects intentional table layout overflow in DOCX
tests/industrial/f6-06-visual-regression.test.ts > F6-06: Visual Regression and Quality Review > 7. Negative Fault & Overflow Detection > detects and rejects shape placed out-of-bounds in PPTX
tests/industrial/f6-06-visual-regression.test.ts > F6-06: Visual Regression and Quality Review > 8. Repeated Generation Determinism > DOCX repeated generation produces identical visual snapshot hashes
tests/industrial/f6-06-visual-regression.test.ts > F6-06: Visual Regression and Quality Review > 8. Repeated Generation Determinism > PPTX repeated generation produces identical visual snapshot hashes
tests/industrial/f6-06-visual-regression.test.ts > F6-06: Visual Regression and Quality Review > 8. Repeated Generation Determinism > XLSX repeated generation produces identical visual snapshot hashes
tests/industrial/f6-06-visual-regression.test.ts > F6-06: Visual Regression and Quality Review > 9. Service Container & Privacy Audit Trail > records privacy-safe audit records with hashes and scores without leaking secrets
tests/industrial/f7-01-task-requirements.test.ts > F7-01: Extend Task Requirements & Non-Degradation Authority > 7. Canary File Protection Invariant > preserves rust/test.txt canary SHA-256 hash strictly
tests/industrial/f7-02-deterministic-inference.test.ts > F7-02: Deterministic Inference & Routing Engine > 2. Text-Only Requests (Fixtures 1-6) > Fixture 1: resolves DOCX generation request
tests/industrial/f7-02-deterministic-inference.test.ts > F7-02: Deterministic Inference & Routing Engine > 2. Text-Only Requests (Fixtures 1-6) > Fixture 2: resolves XLSX spreadsheet creation request
tests/industrial/f7-02-deterministic-inference.test.ts > F7-02: Deterministic Inference & Routing Engine > 2. Text-Only Requests (Fixtures 1-6) > Fixture 3: resolves PPTX presentation creation request
tests/industrial/f7-02-deterministic-inference.test.ts > F7-02: Deterministic Inference & Routing Engine > 2. Text-Only Requests (Fixtures 1-6) > Fixture 4: resolves OCR extraction text directive
tests/industrial/f7-02-deterministic-inference.test.ts > F7-02: Deterministic Inference & Routing Engine > 2. Text-Only Requests (Fixtures 1-6) > Fixture 5: resolves Knowledge Base search query
tests/industrial/f7-02-deterministic-inference.test.ts > F7-02: Deterministic Inference & Routing Engine > 2. Text-Only Requests (Fixtures 1-6) > Fixture 6: resolves code development request
tests/industrial/f7-02-deterministic-inference.test.ts > F7-02: Deterministic Inference & Routing Engine > 3. Attachment-Only Requests (Fixtures 7-12) > Fixture 10: passive DOCX deliverable attachment infers Office Inspection
tests/industrial/f7-02-deterministic-inference.test.ts > F7-02: Deterministic Inference & Routing Engine > 3. Attachment-Only Requests (Fixtures 7-12) > Fixture 11: passive XLSX spreadsheet attachment infers Office Inspection
tests/industrial/f7-02-deterministic-inference.test.ts > F7-02: Deterministic Inference & Routing Engine > 3. Attachment-Only Requests (Fixtures 7-12) > Fixture 12: passive TypeScript source code attachment infers Code Analysis
tests/industrial/f7-02-deterministic-inference.test.ts > F7-02: Deterministic Inference & Routing Engine > 3. Attachment-Only Requests (Fixtures 7-12) > Fixture 7: passive PDF attachment infers Document OCR
tests/industrial/f7-02-deterministic-inference.test.ts > F7-02: Deterministic Inference & Routing Engine > 3. Attachment-Only Requests (Fixtures 7-12) > Fixture 8: passive TIFF scan attachment infers Document OCR
tests/industrial/f7-02-deterministic-inference.test.ts > F7-02: Deterministic Inference & Routing Engine > 3. Attachment-Only Requests (Fixtures 7-12) > Fixture 9: passive PNG image attachment infers Image Inspection
tests/industrial/f7-02-deterministic-inference.test.ts > F7-02: Deterministic Inference & Routing Engine > 4. Multimodal Combinations (Fixtures 13-18) > Fixture 13: visual diagram directive + attached JPG image
tests/industrial/f7-02-deterministic-inference.test.ts > F7-02: Deterministic Inference & Routing Engine > 4. Multimodal Combinations (Fixtures 13-18) > Fixture 14: OCR directive + attached PDF document
tests/industrial/f7-02-deterministic-inference.test.ts > F7-02: Deterministic Inference & Routing Engine > 4. Multimodal Combinations (Fixtures 13-18) > Fixture 15: code review directive + attached Python script
tests/industrial/f7-02-deterministic-inference.test.ts > F7-02: Deterministic Inference & Routing Engine > 4. Multimodal Combinations (Fixtures 13-18) > Fixture 16: presentation generation directive with source data attachment
tests/industrial/f7-02-deterministic-inference.test.ts > F7-02: Deterministic Inference & Routing Engine > 4. Multimodal Combinations (Fixtures 13-18) > Fixture 17: KB ingestion directive with corpus files
tests/industrial/f7-02-deterministic-inference.test.ts > F7-02: Deterministic Inference & Routing Engine > 4. Multimodal Combinations (Fixtures 13-18) > Fixture 18: visual regression directive with screenshot attachment
tests/industrial/f7-02-deterministic-inference.test.ts > F7-02: Deterministic Inference & Routing Engine > 5. Ambiguity & Clarification Protocol (Fixtures 19-22) > Fixture 19: short vague prompt "fix this" returns CLARIFICATION_REQUIRED
tests/industrial/f7-02-deterministic-inference.test.ts > F7-02: Deterministic Inference & Routing Engine > 5. Ambiguity & Clarification Protocol (Fixtures 19-22) > Fixture 20: single word directive "check" returns CLARIFICATION_REQUIRED
tests/industrial/f7-02-deterministic-inference.test.ts > F7-02: Deterministic Inference & Routing Engine > 5. Ambiguity & Clarification Protocol (Fixtures 19-22) > Fixture 21: conflicting deliverable intents returns structured clarification
tests/industrial/f7-02-deterministic-inference.test.ts > F7-02: Deterministic Inference & Routing Engine > 5. Ambiguity & Clarification Protocol (Fixtures 19-22) > Fixture 22: uninformative 2-letter prompt "do" requests clarification
tests/industrial/f7-02-deterministic-inference.test.ts > F7-02: Deterministic Inference & Routing Engine > 6. Unsupported Requests & Safety Gates (Fixtures 23-26) > Fixture 23: cloud deployment request is rejected safely as UNSUPPORTED
tests/industrial/f7-02-deterministic-inference.test.ts > F7-02: Deterministic Inference & Routing Engine > 6. Unsupported Requests & Safety Gates (Fixtures 23-26) > Fixture 24: live internet scraping request is rejected safely as UNSUPPORTED
tests/industrial/f7-02-deterministic-inference.test.ts > F7-02: Deterministic Inference & Routing Engine > 6. Unsupported Requests & Safety Gates (Fixtures 23-26) > Fixture 25: cryptocurrency mining request is rejected safely as UNSUPPORTED
tests/industrial/f7-02-deterministic-inference.test.ts > F7-02: Deterministic Inference & Routing Engine > 6. Unsupported Requests & Safety Gates (Fixtures 23-26) > Fixture 26: air-gap safety bypass attempt is rejected safely as UNSUPPORTED
tests/industrial/f7-02-deterministic-inference.test.ts > F7-02: Deterministic Inference & Routing Engine > 7. Prompt Injection Neutralization (Fixtures 27-29) > Fixture 27: malicious directive inside attachment body does not hijack prompt intent
tests/industrial/f7-02-deterministic-inference.test.ts > F7-02: Deterministic Inference & Routing Engine > 7. Prompt Injection Neutralization (Fixtures 27-29) > Fixture 28: passive PDF containing injected prompt text resolves strictly as OCR data
tests/industrial/f7-02-deterministic-inference.test.ts > F7-02: Deterministic Inference & Routing Engine > 7. Prompt Injection Neutralization (Fixtures 27-29) > Fixture 29: direct prompt injection in user text is caught by unsupported rule
tests/industrial/f7-02-deterministic-inference.test.ts > F7-02: Deterministic Inference & Routing Engine > 8. Determinism & Non-Degradation Router Integration (Fixtures 30-35) > Fixture 30: 100-run exact determinism and canonical SHA-256 hash
tests/industrial/f7-02-deterministic-inference.test.ts > F7-02: Deterministic Inference & Routing Engine > 8. Determinism & Non-Degradation Router Integration (Fixtures 30-35) > Fixture 31: Router.routeInference routes vision task to eligible vision agent
tests/industrial/f7-02-deterministic-inference.test.ts > F7-02: Deterministic Inference & Routing Engine > 8. Determinism & Non-Degradation Router Integration (Fixtures 30-35) > Fixture 32: Router.routeInference fails closed (no silent degradation) if no agent supports vision
tests/industrial/f7-02-deterministic-inference.test.ts > F7-02: Deterministic Inference & Routing Engine > 8. Determinism & Non-Degradation Router Integration (Fixtures 30-35) > Fixture 33: Router.routeInference returns null for ambiguous or unsupported requests
tests/industrial/f7-02-deterministic-inference.test.ts > F7-02: Deterministic Inference & Routing Engine > 8. Determinism & Non-Degradation Router Integration (Fixtures 30-35) > Fixture 34: Router.routeInference respects targeted agent eligibility
tests/industrial/f7-02-deterministic-inference.test.ts > F7-02: Deterministic Inference & Routing Engine > 8. Determinism & Non-Degradation Router Integration (Fixtures 30-35) > Fixture 35: ServiceContainer integration & audit logging verification
tests/industrial/f7-02-deterministic-inference.test.ts > F7-02: Deterministic Inference & Routing Engine > 9. Protected Canary File Invariant > verifies rust/test.txt SHA-256 hash is unmodified
tests/industrial/f7-03-workflow-planning.test.ts > F7-03: Typed Workflow Planning & Safety Engine > 2. Deterministic Recipe Workflows > builds valid Code Development workflow plan with approval gate
tests/industrial/f7-03-workflow-planning.test.ts > F7-03: Typed Workflow Planning & Safety Engine > 2. Deterministic Recipe Workflows > builds valid Document OCR workflow plan
tests/industrial/f7-03-workflow-planning.test.ts > F7-03: Typed Workflow Planning & Safety Engine > 2. Deterministic Recipe Workflows > builds valid Image Inspection workflow plan
tests/industrial/f7-03-workflow-planning.test.ts > F7-03: Typed Workflow Planning & Safety Engine > 2. Deterministic Recipe Workflows > builds valid Knowledge Base ingestion workflow plan
tests/industrial/f7-03-workflow-planning.test.ts > F7-03: Typed Workflow Planning & Safety Engine > 2. Deterministic Recipe Workflows > builds valid Knowledge Base search workflow plan
tests/industrial/f7-03-workflow-planning.test.ts > F7-03: Typed Workflow Planning & Safety Engine > 2. Deterministic Recipe Workflows > builds valid Multimodal Conflict Review workflow plan
tests/industrial/f7-03-workflow-planning.test.ts > F7-03: Typed Workflow Planning & Safety Engine > 3. Office Deliverables & Mandatory Approval Gates > builds DOCX deliverable workflow with mandatory REQUEST_APPROVAL gate
tests/industrial/f7-03-workflow-planning.test.ts > F7-03: Typed Workflow Planning & Safety Engine > 3. Office Deliverables & Mandatory Approval Gates > builds PPTX presentation workflow with mandatory REQUEST_APPROVAL gate
tests/industrial/f7-03-workflow-planning.test.ts > F7-03: Typed Workflow Planning & Safety Engine > 3. Office Deliverables & Mandatory Approval Gates > builds XLSX calculation workbook workflow with mandatory REQUEST_APPROVAL gate
tests/industrial/f7-03-workflow-planning.test.ts > F7-03: Typed Workflow Planning & Safety Engine > 4. Hard Safety Invariants & Fail-Closed Gates > fails closed on cross-project access violation
tests/industrial/f7-03-workflow-planning.test.ts > F7-03: Typed Workflow Planning & Safety Engine > 4. Hard Safety Invariants & Fail-Closed Gates > fails closed on non-degradation when vision task has only text agents available
tests/industrial/f7-03-workflow-planning.test.ts > F7-03: Typed Workflow Planning & Safety Engine > 4. Hard Safety Invariants & Fail-Closed Gates > fails closed when a required tool is forbidden by policy
tests/industrial/f7-03-workflow-planning.test.ts > F7-03: Typed Workflow Planning & Safety Engine > 4. Hard Safety Invariants & Fail-Closed Gates > fails closed when a step attempts tool escalation outside declared tools
tests/industrial/f7-03-workflow-planning.test.ts > F7-03: Typed Workflow Planning & Safety Engine > 4. Hard Safety Invariants & Fail-Closed Gates > fails closed when evidence is quarantined
tests/industrial/f7-03-workflow-planning.test.ts > F7-03: Typed Workflow Planning & Safety Engine > 4. Hard Safety Invariants & Fail-Closed Gates > fails closed when evidence is stale or expired
tests/industrial/f7-03-workflow-planning.test.ts > F7-03: Typed Workflow Planning & Safety Engine > 4. Hard Safety Invariants & Fail-Closed Gates > fails closed when inference status is CLARIFICATION_REQUIRED (ambiguous)
tests/industrial/f7-03-workflow-planning.test.ts > F7-03: Typed Workflow Planning & Safety Engine > 4. Hard Safety Invariants & Fail-Closed Gates > fails closed when inference status is UNSUPPORTED
tests/industrial/f7-03-workflow-planning.test.ts > F7-03: Typed Workflow Planning & Safety Engine > 4. Hard Safety Invariants & Fail-Closed Gates > fails closed when no eligible agent possesses required tool
tests/industrial/f7-03-workflow-planning.test.ts > F7-03: Typed Workflow Planning & Safety Engine > 4. Hard Safety Invariants & Fail-Closed Gates > fails closed when pinned model revision is mismatched
tests/industrial/f7-03-workflow-planning.test.ts > F7-03: Typed Workflow Planning & Safety Engine > 4. Hard Safety Invariants & Fail-Closed Gates > neutralizes prompt injection inside attachments (treated as data only)
tests/industrial/f7-03-workflow-planning.test.ts > F7-03: Typed Workflow Planning & Safety Engine > 5. Determinism & Router Integration > Fixture: 100-run exact determinism produces identical planHash
tests/industrial/f7-03-workflow-planning.test.ts > F7-03: Typed Workflow Planning & Safety Engine > 5. Determinism & Router Integration > Router.resolvePlanStepAgent fails closed if candidate missing required tools
tests/industrial/f7-03-workflow-planning.test.ts > F7-03: Typed Workflow Planning & Safety Engine > 5. Determinism & Router Integration > Router.resolvePlanStepAgent routes plan step to eligible agent
tests/industrial/f7-03-workflow-planning.test.ts > F7-03: Typed Workflow Planning & Safety Engine > 6. WorkflowPlanningService & Persistence Integration > ServiceContainer provides workflowPlanning service
tests/industrial/f7-03-workflow-planning.test.ts > F7-03: Typed Workflow Planning & Safety Engine > 6. WorkflowPlanningService & Persistence Integration > creates, saves to disk, retrieves, and audits a workflow plan
tests/industrial/f7-03-workflow-planning.test.ts > F7-03: Typed Workflow Planning & Safety Engine > 6. WorkflowPlanningService & Persistence Integration > records warning audit event when plan is rejected
tests/industrial/f7-03-workflow-planning.test.ts > F7-03: Typed Workflow Planning & Safety Engine > 7. Protected Canary File Invariant > verifies rust/test.txt SHA-256 hash is unmodified
tests/industrial/f7-04-tool-approval-planning.test.ts > F7-04: Tool and Approval Planning Engine > 6. Service Layer Persistence & Privacy Audit Trail > creates, atomically saves to disk, and retrieves a ToolExecutionPlan
tests/industrial/f7-04-tool-approval-planning.test.ts > F7-04: Tool and Approval Planning Engine > 6. Service Layer Persistence & Privacy Audit Trail > records privacy-preserving audit events without raw document text
tests/industrial/f7-04-tool-approval-planning.test.ts > F7-04: Tool and Approval Planning Engine > 6. Service Layer Persistence & Privacy Audit Trail > records warning audit event when tool execution is rejected
tests/industrial/f7-04-tool-approval-planning.test.ts > F7-04: Tool and Approval Planning Engine > 7. Integration & Parity > verifies rust/test.txt SHA-256 canary is unmodified
tests/industrial/f7-05-adversarial-routing.test.ts > F7-05: Adversarial Routing & Pipeline Hardening > 7. Canary Invariant Verification > confirms rust/test.txt SHA-256 canary is unmodified
tests/industrial/f7-05-cli-gui-parity.test.ts > F7-05: 4-Way Interface Parity & Idempotency Hardening > 1. Inference Parity across Direct, REST, and GUI > returns identical CLARIFICATION_REQUIRED across Direct, REST, and GUI for vague prompt
tests/industrial/f7-05-cli-gui-parity.test.ts > F7-05: 4-Way Interface Parity & Idempotency Hardening > 1. Inference Parity across Direct, REST, and GUI > returns identical MATCHED result and hash for valid DOCX generation input
tests/industrial/f7-05-cli-gui-parity.test.ts > F7-05: 4-Way Interface Parity & Idempotency Hardening > 1. Inference Parity across Direct, REST, and GUI > returns identical UNSUPPORTED status across Direct, REST, and GUI for cloud egress attempt
tests/industrial/f7-05-cli-gui-parity.test.ts > F7-05: 4-Way Interface Parity & Idempotency Hardening > 2. Workflow Planning Parity across Direct, Orchestrator, REST, and GUI > produces identical workflow plan and planHash across all 4 interfaces
tests/industrial/f7-05-cli-gui-parity.test.ts > F7-05: 4-Way Interface Parity & Idempotency Hardening > 3. Tool Execution Contract & Pre-Execution Parity > creates identical execution contracts and enforces fail-closed pre-execution evaluation
tests/industrial/f7-05-cli-gui-parity.test.ts > F7-05: 4-Way Interface Parity & Idempotency Hardening > 4. Durable Idempotency Replay & Conflict Detection > returns replay on identical idempotency key and conflict on modified payload
tests/industrial/f8-01-sandbox-image.test.ts > F8-01: Build the Pinned Sandbox Image > Tier 2: Mandatory Fail-Closed Rejection Behavior > exhaustively validates Docker save archive structure (validateDockerArchiveStructure)
tests/industrial/f8-01-sandbox-image.test.ts > F8-01: Build the Pinned Sandbox Image > Tier 5: SandboxImageService & ServiceContainer Integration > verifies SandboxImageService loads manifest and performs disk audit
tests/industrial/f8-01-sandbox-image.test.ts > F8-01: Build the Pinned Sandbox Image > Tier 6: Gate Preconditions & Canary Hash Integrity > preserves canary rust/test.txt SHA-256 hash verbatim
tests/industrial/f8-02-container-runner.test.ts > MAOS Industrial — Container Runner Test Suite (F8-02) > Tier 7: Invariants Verification > preserves canary file rust/test.txt SHA-256 hash strictly unchanged
tests/industrial/f8-03-execute-code-sandbox-tool.test.ts > MAOS Industrial — execute_code_sandbox Tool Test Suite (F8-03) > Tier 7: Protected Invariants > preserves canary file rust/test.txt SHA-256 hash strictly
tests/industrial/f8-04-sandbox-adversarial.test.ts > MAOS Industrial — Sandbox Adversarial Test Suite (F8-04) > Tier 10: Lifecycle Cleanup & Protected Invariants > V10.3: strictly preserves canary file rust/test.txt SHA-256 hash
tests/industrial/f8-06-calculation-trace.test.ts > F8-06: Formal Calculation Trace > 1. Trace Generation & Schema Invariants > verifies the on-disk canonical artifact F8-06-RMS-turbine-vibration.json
tests/industrial/f8-06-calculation-trace.test.ts > F8-06: Formal Calculation Trace > 2. Native Rust Deterministic Verifier > authoritatively reproduces 2.6371099711616126 mm/s via Rust engine
tests/industrial/f8-06-calculation-trace.test.ts > F8-06: Formal Calculation Trace > 4. Audit Trail & Provenance Invariants > records privacy-preserving audit events for generation and verification
tests/industrial/f8-06-calculation-trace.test.ts > F8-06: Formal Calculation Trace > 5. Reproducibility & Invariant Verification > records and verifies container/sandbox identity in calculation trace provenance
tests/industrial/f8-07-host-executor-disabled.test.ts > F8-07: Disable Host Executor in Industrial Mode > 3. REST API Route Enforcement > POST /api/v1/execution-plans/evaluate returns HTTP 403 when requestedTool is execute_python
tests/industrial/f8-07-host-executor-disabled.test.ts > F8-07: Disable Host Executor in Industrial Mode > 3. REST API Route Enforcement > POST /api/v1/plans returns HTTP 403 when task requires execute_python
tests/industrial/f8-07-host-executor-disabled.test.ts > F8-07: Disable Host Executor in Industrial Mode > 9. Invariants & Cryptographic Integrity > verifies audit trail records security rejection events without leakage
tests/industrial/f8-07-host-executor-disabled.test.ts > F8-07: Disable Host Executor in Industrial Mode > 9. Invariants & Cryptographic Integrity > verifies rust/test.txt canary SHA-256 hash is strictly preserved
tests/industrial/f9-01-threat-measurement-boundary.test.ts > F9-01: Threat and Measurement Boundary > 10. Invariants & Cryptographic Integrity > verifies rust/test.txt canary SHA-256 is strictly preserved
tests/industrial/f9-01-threat-measurement-boundary.test.ts > F9-01: Threat and Measurement Boundary > 9. Audit Trail & Redacted Sensitive Fields > logs boundary lifecycle events with endpoint category and sovereignty-boundary source
tests/industrial/f9-01-threat-measurement-boundary.test.ts > F9-01: Threat and Measurement Boundary > 9. Audit Trail & Redacted Sensitive Fields > verifies standard redacted audit fields protect secrets and prose prompts
tests/industrial/f9-02-endpoint-allowlist.test.ts > F9-02: Explicit Endpoint Allowlist > 13. Privacy-Safe Audit Trail > records privacy-safe endpoint audit events with category endpoint and warning
tests/industrial/f9-02-endpoint-allowlist.test.ts > F9-02: Explicit Endpoint Allowlist > 14. Invariants & Cryptographic Integrity > verifies rust/test.txt canary SHA-256 is strictly preserved
tests/industrial/f9-03-firewall-enforcement.test.ts > F9-03: Firewall Boundary Enforcement > 7. Privacy-Safe Audit Trail > records firewall lifecycle events with category endpoint
tests/industrial/f9-03-firewall-enforcement.test.ts > F9-03: Firewall Boundary Enforcement > 8. Invariants & Cryptographic Integrity > verifies rust/test.txt canary SHA-256 is strictly preserved
tests/industrial/f9-04-network-monitor.test.ts > F9-04: Process-Attributed Network Monitor > 7. Privacy-Safe Audit Trail Integration > records start, violation, and stop events in append-only audit log
tests/industrial/f9-04-network-monitor.test.ts > F9-04: Process-Attributed Network Monitor > 8. Protected Canary Invariant > rust/test.txt canary SHA-256 remains strictly unchanged
tests/industrial/f9-05-service-process-identity.test.ts > F9-05: Service and Process Endpoint Identity > 11. Audit Trail Integration > records identity registration and revocation in append-only audit log
tests/industrial/f9-05-service-process-identity.test.ts > F9-05: Service and Process Endpoint Identity > 12. Protected Canary Invariant > rust/test.txt canary SHA-256 remains strictly unchanged
tests/industrial/f9-06-industrial-firewall-requirement.test.ts > F9-06: Industrial Firewall Requirement > 10. Canary & Cryptographic Invariants > strictly preserves rust/test.txt canary SHA-256
tests/industrial/f9-06-industrial-firewall-requirement.test.ts > F9-06: Industrial Firewall Requirement > 9. Privacy-Safe Audit Trail > durably records INDUSTRIAL_BOUNDARY_CHECK_FAILED audit events upon failure
tests/industrial/f9-07-sovereignty-evidence-bundle.test.ts > F9-07: Sovereignty Evidence Bundle > 19. Canary & Cryptographic Invariants > strictly preserves the rust/test.txt canary SHA-256 hash
tests/industrial/f9-08-interruption-atomic-cleanup.test.ts > F9-08: Interruption and Atomic Cleanup > 1. Chat Completion Cancellation & Interruption > aborts in-flight inference on client cancellation via AbortSignal
tests/industrial/f9-08-interruption-atomic-cleanup.test.ts > F9-08: Interruption and Atomic Cleanup > 1. Chat Completion Cancellation & Interruption > handles server timeout cleanly without phantom success
tests/industrial/f9-08-interruption-atomic-cleanup.test.ts > F9-08: Interruption and Atomic Cleanup > 1. Chat Completion Cancellation & Interruption > rejects immediately when AbortSignal is already aborted before starting
tests/industrial/f9-08-interruption-atomic-cleanup.test.ts > F9-08: Interruption and Atomic Cleanup > 10. Canary Invariant > rust/test.txt SHA-256 remains strictly untouched and unmodified
tests/industrial/f9-08-interruption-atomic-cleanup.test.ts > F9-08: Interruption and Atomic Cleanup > 7. Model Lease Reclamation > releases all active model leases and resets lease count to zero
tests/industrial/f9-08-interruption-atomic-cleanup.test.ts > F9-08: Interruption and Atomic Cleanup > 9. Unified Atomic Cleanup Coordinator Integration > orchestrates complete atomic cleanup across all subsystems simultaneously
tests/industrial/f9-09-disconnected-full-rehearsal.test.ts > F9-09: Disconnected Full Rehearsal > 11. Canary & Cryptographic Invariants > strictly preserves rust/test.txt SHA-256 hash invariant
tests/industrial/f9-09-disconnected-full-rehearsal.test.ts > F9-09: Disconnected Full Rehearsal > 12. Generate & Save Rehearsal Report JSON > writes artifacts/verification/F9-09-rehearsal.json with full D1–D6 rehearsal data
tests/industrial/f9-09-disconnected-full-rehearsal.test.ts > F9-09: Disconnected Full Rehearsal > 4. Stage D3 — RMS Coding Sandbox and Calculation Trace > reproduces calculation trace using native Rust industrial engine
tests/industrial/f9-09-disconnected-full-rehearsal.test.ts > F9-09: Disconnected Full Rehearsal > 6. Stage D5 — Approved DOCX/XLSX/PPTX Artifact Generation > generates DOCX deliverable and verifies OOXML package safety
tests/industrial/f9-09-disconnected-full-rehearsal.test.ts > F9-09: Disconnected Full Rehearsal > 6. Stage D5 — Approved DOCX/XLSX/PPTX Artifact Generation > generates PPTX deliverable and verifies non-overlapping shapes
tests/industrial/f9-09-disconnected-full-rehearsal.test.ts > F9-09: Disconnected Full Rehearsal > 6. Stage D5 — Approved DOCX/XLSX/PPTX Artifact Generation > generates XLSX deliverable and verifies package & formula safety
tests/industrial/f9-09-disconnected-full-rehearsal.test.ts > F9-09: Disconnected Full Rehearsal > 7. Stage D6 — Sovereignty Evidence Bundle Generation & Export > aggregates complete D1–D5 evidence into formal SovereigntyEvidenceBundle
tests/industrial/f9-09-disconnected-full-rehearsal.test.ts > F9-09: Disconnected Full Rehearsal > 7. Stage D6 — Sovereignty Evidence Bundle Generation & Export > applies operator sign-off with cryptographic binding
tests/industrial/f9-09-disconnected-full-rehearsal.test.ts > F9-09: Disconnected Full Rehearsal > 7. Stage D6 — Sovereignty Evidence Bundle Generation & Export > exports deterministic PKZIP archive of the sovereignty bundle
tests/industrial/f9-09-disconnected-full-rehearsal.test.ts > F9-09: Disconnected Full Rehearsal > 7. Stage D6 — Sovereignty Evidence Bundle Generation & Export > verifies exported sovereignty bundle offline with standalone verifiers
tests/industrial/f9-09-disconnected-full-rehearsal.test.ts > F9-09: Disconnected Full Rehearsal > 8. Post-Rehearsal Controls & Atomic Cleanup > verifies audit trail integrity across the entire rehearsal lifecycle
tests/industrial/f9-10-process-boundary.test.ts > F9-10: Process-Scoped Boundary > 8. Canary & cryptographic invariants > strictly preserves rust/test.txt canary SHA-256
tests/industrial/f9-11-audit-append-lock.test.ts > F9-11: Audit chain append lock > 1. Serialisation > appends a linear, head-consistent chain
tests/industrial/f9-11-audit-append-lock.test.ts > F9-11: Audit chain append lock > 1. Serialisation > verifies the chain through the product verifier
tests/industrial/f9-11-audit-append-lock.test.ts > F9-11: Audit chain append lock > 2. Fail-closed on a held lock > refuses to append while another live process holds the lock
tests/industrial/f9-11-audit-append-lock.test.ts > F9-11: Audit chain append lock > 3. Recovery from abandoned locks > reclaims a lock whose owner process is dead
tests/industrial/f9-11-audit-append-lock.test.ts > F9-11: Audit chain append lock > 4. Lock hygiene > releases the lock after a successful append
tests/industrial/f9-11-audit-append-lock.test.ts > F9-11: Audit chain append lock > 5. Concurrent OS processes > two concurrent processes produce a linear chain with a consistent head
tests/industrial/g5-knowledge-grounding-gate.test.ts > Gate G5: Knowledge Grounding Readiness Verification > 1. Production Offline Gate Verification > production build fails closed with NO_RUNTIME_DOWNLOAD (code 12) without mock
tests/industrial/g5-knowledge-grounding-gate.test.ts > Gate G5: Knowledge Grounding Readiness Verification > 2. Retrieval Evaluation Benchmark & Determinism > executes full 24-query benchmark meeting recall targets and 100% determinism
tests/industrial/g5-knowledge-grounding-gate.test.ts > Gate G5: Knowledge Grounding Readiness Verification > 3. Strict Multi-Project Isolation > strictly isolates corpora between Project Alpha and Project Beta
tests/industrial/g5-knowledge-grounding-gate.test.ts > Gate G5: Knowledge Grounding Readiness Verification > 4. Full CLI / Service Operations Parity > executes build -> status -> verify -> clear through CLI with machine-readable JSON
tests/industrial/g5-knowledge-grounding-gate.test.ts > Gate G5: Knowledge Grounding Readiness Verification > 5. Privacy & Audit Trail Verification > verifies audit trail contains query hashes without sensitive text
tests/industrial/g5-knowledge-grounding-gate.test.ts > Gate G5: Knowledge Grounding Readiness Verification > 6. Protected File Invariant > preserves rust/test.txt SHA-256 integrity
tests/industrial/g5-real-offline-embedding.test.ts > Gate G5: Real Offline Embedding Weights Verification > 1. Model Manifest & Staged Snapshot Integrity > EmbeddingService.validateSnapshot() passes with zero errors on staged weights
tests/industrial/g5-real-offline-embedding.test.ts > Gate G5: Real Offline Embedding Weights Verification > 1. Model Manifest & Staged Snapshot Integrity > verifies all staged snapshot files exist with matching SHA-256 and byte size
tests/industrial/g5-real-offline-embedding.test.ts > Gate G5: Real Offline Embedding Weights Verification > 2. Real Offline Embedding Inference Execution > generates 384-d normalized float vectors using real CPU weights without network
tests/industrial/g5-real-offline-embedding.test.ts > Gate G5: Real Offline Embedding Weights Verification > 2. Real Offline Embedding Inference Execution > produces deterministic embedding vectors for identical text inputs
tests/industrial/g5-real-offline-embedding.test.ts > Gate G5: Real Offline Embedding Weights Verification > 3. Real Knowledge Base Build & Vector Index Generation > ingests demo SOP and builds vector index with real weights
tests/industrial/g5-real-offline-embedding.test.ts > Gate G5: Real Offline Embedding Weights Verification > 5. Security Guardrails & Privacy-Preserving Audit > preserves privacy in audit logs: records SHA-256 queryHash and zero raw text
tests/industrial/g5-real-offline-embedding.test.ts > Gate G5: Real Offline Embedding Weights Verification > 6. Protected File Invariant > preserves rust/test.txt SHA-256 integrity
tests/industrial/g6-deliverable-readiness-gate.test.ts > Gate G6: Deliverable Readiness Verification > 1. Unified Approved Run Contract & Reopen in Parser/Viewer > generates valid DOCX, XLSX, and PPTX deliverables from one approved run contract
tests/industrial/g6-deliverable-readiness-gate.test.ts > Gate G6: Deliverable Readiness Verification > 2. Ground Truth, Values, Citations, and Hashes Parity > fails closed when citation source content is modified or tampered on disk
tests/industrial/g6-deliverable-readiness-gate.test.ts > Gate G6: Deliverable Readiness Verification > 2. Ground Truth, Values, Citations, and Hashes Parity > verifies exact measurements, units, calculations, and cryptographic citations in generated artifacts
tests/industrial/g6-deliverable-readiness-gate.test.ts > Gate G6: Deliverable Readiness Verification > 3. Strict Output & Template Safety (No Macros, No External Links, No Injection) > guarantees generated packages have zero external relationships or remote URLs
tests/industrial/g6-deliverable-readiness-gate.test.ts > Gate G6: Deliverable Readiness Verification > 3. Strict Output & Template Safety (No Macros, No External Links, No Injection) > rejects spreadsheet formula injection patterns in findings metric / statement
tests/industrial/g6-deliverable-readiness-gate.test.ts > Gate G6: Deliverable Readiness Verification > 3. Strict Output & Template Safety (No Macros, No External Links, No Injection) > rejects unauthorized file overwrite when file already exists
tests/industrial/g6-deliverable-readiness-gate.test.ts > Gate G6: Deliverable Readiness Verification > 4. Visual Quality, Safety Boundaries & Layout Acceptance > passes visual review across DOCX, XLSX, and PPTX with zero layout errors
tests/industrial/g6-deliverable-readiness-gate.test.ts > Gate G6: Deliverable Readiness Verification > 4. Visual Quality, Safety Boundaries & Layout Acceptance > produces 100% deterministic visual layout snapshot hashes across repeated generations
tests/industrial/g6-deliverable-readiness-gate.test.ts > Gate G6: Deliverable Readiness Verification > 5. Privacy-Preserving Audit Trail > records deliverable generation and visual review events without raw text or tokens
tests/industrial/g6-deliverable-readiness-gate.test.ts > Gate G6: Deliverable Readiness Verification > 6. Protected Canary Invariant > strictly preserves rust/test.txt SHA-256 hash intact
tests/industrial/gate-g9-sovereignty-gate.test.ts > Gate G9: Sovereignty & Prevention Gate Acceptance Evaluation > Area 5: Workflow and Artifact Integrity (D1–D6) > verifies D3 sandbox RMS calculation and native Rust engine verification
tests/industrial/gate-g9-sovereignty-gate.test.ts > Gate G9: Sovereignty & Prevention Gate Acceptance Evaluation > Area 6: Recovery and Cleanup > verifies audit trail integrity across the entire lifecycle
tests/industrial/gate-g9-sovereignty-gate.test.ts > Gate G9: Sovereignty & Prevention Gate Acceptance Evaluation > Area 7: Sovereignty Evidence Bundle Formal Export > generates, signs, exports, and independently verifies G9 evidence bundle and zip archive
tests/industrial/gate-g9-sovereignty-gate.test.ts > Gate G9: Sovereignty & Prevention Gate Acceptance Evaluation > Area 7: Sovereignty Evidence Bundle Formal Export > strictly confirms exact wording of the standard measured sovereignty claim
tests/industrial/gate-g9-sovereignty-gate.test.ts > Gate G9: Sovereignty & Prevention Gate Acceptance Evaluation > Protected Canary Invariant > strictly preserves rust/test.txt SHA-256 hash invariant
tests/industrial/industrial-repl.test.ts > MAOS Industrial bounded REPL > runs the selected-file mock analysis through persisted review, report and verification
tests/industrial/meta-model-api-contract.test.ts > Meta Model API opt-in and OpenAI-compatible contract (loopback mock only) > redacts successful prose and provider model identity before service output, report, audit and logs
tests/industrial/meta-model-api-contract.test.ts > Meta Model API opt-in and OpenAI-compatible contract (loopback mock only) > uses the documented Chat Completions tool-call round trip when configured Muse temperature is sent
tests/industrial/meta-model-api-contract.test.ts > Meta Model API opt-in and OpenAI-compatible contract (loopback mock only) > uses the documented Chat Completions tool-call round trip when default Muse temperature is omitted
tests/industrial/read-only-completion.test.ts > read-only completion at the root cause (mock only) > recovers the observed live sequence: tool success, plain text, then read-only completion
```

### 4b. ONLY-b666518 — candidate regressions: 3

```text
tests/gui/ui1-04-launcher-handshake.test.ts > UI1-04: Launcher Handshake and Project Validation > 4. Concurrency, Lifecycle & Zero Orphans > spawns two distinct projects concurrently on different ports without interference
tests/industrial/ring-dev-a.test.ts > lane audit proxy (helper, no tests) > exposes the fixture helpers
tests/industrial/ring-dev-audit-proxy.test.ts > lane audit proxy (helper, no tests) > exposes the fixture helpers
```

### 4c. ONLY-a573e2a — absent from the new run: 7

```text
tests/f2-05-package-assets.test.ts > F2-05: Package Industrial Assets > Custom extensions > should support extra allowlist entries
tests/gui/ui1-09-chat-task-feed.test.ts > UI1-09: Chat and Task Feed Home Test Suite
tests/industrial/f11-05-release-identities-sbom.test.ts > F11-05: Release Identities & SBOM Verification
tests/industrial/f11-06-clean-machine-rehearsal.test.ts > F11-06: Clean-Machine Release Rehearsal
tests/industrial/f11-07-three-consecutive-rehearsals.test.ts > F11-07: Three Consecutive Live Rehearsals
tests/industrial/g5-real-offline-embedding.test.ts > Gate G5: Real Offline Embedding Weights Verification > 4. Real Semantic Retrieval Quality & Provenance
tests/industrial/judge-verifier.test.ts > W1: Judge Audit Export Verifier
```
## 5. Classification of each ONLY-b666518 failure

### 5.1 `tests/gui/ui1-04-launcher-handshake.test.ts > UI1-04: ... > 4. Concurrency, Lifecycle & Zero Orphans > spawns two distinct projects concurrently on different ports without interference`
- Pre-existing test (file exists at both commits; all 29 ui1-04 assertions `passed` in the
  b666518 JSON rerun). Text-run signature: `LauncherError: [STARTUP_TIMEOUT] Project service
  host failed to start within 8000ms` (`src/service/project-service/launcher.ts:488`).
- Classification: **timing flake under parallel load, healed on rerun — NOT a regression.**
  Standing failure count contributed: 0 (passes in the JSON run; the packet summary notes the
  same). Raw-count deltas (+2 tests) that include this line must be discounted for it.

### 5.2 `tests/industrial/ring-dev-a.test.ts > lane audit proxy (helper, no tests) > exposes the fixture helpers` — LANE-ADDED TEST, FAILS
- New file: `git show a573e2a:tests/industrial/ring-dev-a.test.ts` → does not exist at base;
  added by the lanes (`git diff --name-status` → `A`). In the b666518 JSON run the file is
  9/10 passed — all nine real Dev-A functional tests pass
  (threads persist/restart, streaming fan-out, loopback-mock, registry dispatch, OCR/memory,
  both demo paths, refusal safety, telemetry); only the `lane audit proxy` helper assertion fails.
- Signature: `AssertionError: expected 'undefined' to be 'string'` at
  `tests/industrial/ring-dev-audit-proxy.test.ts:41` — `engineFixturePath()` returned
  `undefined` because no `rust/target/release/maos-engine[.exe]` exists in the worktree or at
  `/c/maos` (the helper's own documented fallback is to "give up", but the test asserts a
  `string`). The b666518 worktree documents `rust/target/` absent.
- Classification: **lane-added test failing on a missing engine-binary fixture (environment /
  engine-fixture family, same root cause as the 395 pre-existing engine detail blocks) — NOT a
  product-logic regression, but explicitly called out: a lane-added test fails.**

### 5.3 `tests/industrial/ring-dev-audit-proxy.test.ts > lane audit proxy (helper, no tests) > exposes the fixture helpers` — LANE-ADDED TEST, FAILS
- Same single assertion as 5.2 (the file contains only this helper check; the failure trace
  points at the same line 41). New file, absent at base.
- Classification: **same as 5.2 — engine-fixture/environment, NOT genuine logic. Called out
  explicitly as the second lane-added failing test.**

No ONLY-b666518 failure classifies as genuine logic or canary corruption. The shared-failure
signatures sampled in the new run all match the pre-existing root causes: `EngineError: Engine
executable not found` (e.g. ui1-12 via `AuditService → FairQueueService.enqueue`; g5 KB build),
`[NO_RUNTIME_DOWNLOAD] Offline embedding model snapshot is unavailable` (g5 inference),
and the approval/packaging assertion deltas that are byte-identical names red in both runs
(e.g. f3-03 `expected 500 to be 201`, f2-05 `.tgz`). Membership of each sampled name in set A
was verified individually.

## 6. Disposition of each ONLY-a573e2a entry (absent from the new run)

- `tests/f2-05-package-assets.test.ts > ... Custom extensions > should support extra allowlist entries` —
  **genuinely fixed by the lanes' side effects.** Old signature: `expected undefined to be
  defined` for `HACKATHON_SUBMISSION.md`; the lanes added `HACKATHON_SUBMISSION.md` at the repo
  root (diff stat: new file, +134 lines), and in b666518 the f2-05 file is 43/44 passed with
  only the pre-existing `should deny .tgz files` still failing.
- Five two-segment enclosing-suite headers (`tests/gui/ui1-09-chat-task-feed.test.ts`,
  `tests/industrial/f11-05-release-identities-sbom.test.ts`, `f11-06`, `f11-07`,
  `tests/industrial/judge-verifier.test.ts`) — **list-construction artifacts, NOT fixed.**
  These are suite-level FAIL headers from canary-aborted / all-skipped files; the new run's
  list records only leaf names, but all five FILES still fail in b666518 (present in
  `b666518-failing-files.txt`; JSON shows all-assertions-`skipped`, suite `failed`).
- `tests/industrial/g5-real-offline-embedding.test.ts > ... > 4. Real Semantic Retrieval Quality & Provenance` —
  **section-header artifact, NOT fixed.** A three-segment section header; in b666518 the g5 file
  still fails (7 failed / 4 passed / 4 skipped: sections 1–3 fail on missing staged snapshot /
  `NO_RUNTIME_DOWNLOAD` / engine binary, section 4 skipped).
- File level corroborates: every one of the 92 old failing files still fails in the new run
  (ONLY-A files = 0); the new run adds exactly the 2 lane-added files from 5.2–5.3.

## 7. Lane-tests verdict (from `b666518-results.json` assertion statuses)

| Suite | File status | Assertions |
|---|---|---|
| ring-devb-surface (`tests/gui/ring-devb-surface.test.ts`) | passed | 28/28 passed |
| ring-workspace (`tests/gui/ring-workspace.test.ts`) | passed | 11/11 passed |
| ring-contract (`tests/industrial/ring-contract.test.ts`) | passed | 5/5 passed |
| ring-dev-a (`tests/industrial/ring-dev-a.test.ts`) | **failed** | 9/10 passed; only `lane audit proxy > exposes the fixture helpers` fails (env fixture, §5.2) |
| ring-dev-audit-proxy (`tests/industrial/ring-dev-audit-proxy.test.ts`) | **failed** | 0/1 (same env-fixture assertion, §5.3) |
| ring-dev-c-safety (`tests/industrial/ring-dev-c-safety.test.ts`) | passed | 8/8 passed |
| ring-agent (`tests/industrial/ring-agent.test.ts`) | passed | 7/7 passed |
| ring-wire-contract (`tests/industrial/ring-wire-contract.test.ts`) | passed | 2/2 passed |
| ring-impl-01 / ring-inference | passed | 12/12, 6/6 passed |
| ring-adapter | — | **no such test file exists at either commit** (only `src/.../adapter.ts` sources) |

Dev A/B/C functional coverage and the contract suite are green; the only red inside lane
suites is the environment-dependent fixture-presence assertion, whose 1-line check fails while
every functional assertion around it passes.

## 8. Failures in files the lanes touched

Touched non-test sources (from `git diff a573e2a b666518 --name-only`): `src/api/openapi-spec.ts`,
`src/api/router.ts`, `src/gui/src/api/adapter.ts`, `src/gui/src/api/rest-client.ts`,
`src/service/ring-agent-service.ts`, `src/service/memory-service.ts`, `src/service/index.ts`,
`src/gui/src/components/RingWorkspace.tsx`, `ChatView.tsx`, plus new ring services/components.
Spot checks against FAIL headers in `b666518-results.txt` (e.g. `GuiApiAdapter` parity in
ui1-12, all f3-03 approval failures) show engine-fixture signatures, and **every such failing
name is a member of set A (verified by probe: `GuiApiAdapter queue operations`, the f3-03
approval tests, `should deny .tgz files`, the g5 section — all present in the old list).**
The name-diff is exhaustive here: any pre-existing test newly broken by a lane-touched file
would appear in ONLY-B, which contains exactly the 3 entries classified in §5 (1 flake +
2 new-file env assertions). **No pre-existing test newly fails in any lane-touched area.**

## 9. Bottom line

REGRESSIONS: 0
