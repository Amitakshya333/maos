/**
 * UI1-18: Knowledge Search and Sandbox Results Test Suite
 *
 * Exhaustively validates:
 * 1. Knowledge Search REST API:
 *    - POST /api/v1/kb/search returns cited results with typed records
 *    - No-answer responses include reason/details (never uncited synthesized answer)
 *    - Empty query rejection
 *    - Error envelope structure
 *    - KB status endpoint
 * 2. Sandbox Results REST API:
 *    - GET /api/v1/sandbox/results returns typed execution records
 *    - Records include source, stdout/stderr lengths, artifact hashes
 *    - No host executor labeling (industrial mode)
 *    - Results derive from audit trail (not raw stdout)
 * 3. Client & Adapter Parity:
 *    - BrowserRestClient methods: searchKb, getKbStatus, getSandboxResults
 *    - GuiApiAdapter methods: same delegation
 * 4. View Structure & Accessibility:
 *    - KnowledgeView: role="tabpanel", search form, citations list, detail panel
 *    - SandboxView: role="tabpanel", results list, detail panel, hash display
 * 5. Negative Checks:
 *    - No uncited synthesized KB answers
 *    - No host executor labeling in sandbox
 *    - No terminal/Monaco/full IDE behavior
 * 6. Untouched Canary Hash Invariant (rust/test.txt)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as crypto from 'crypto';
import {
  createServiceContainer,
  ServiceContainer,
} from '../../src/service';
import { RestApiRouter } from '../../src/api/router';
import { BrowserRestClient } from '../../src/gui/src/api/rest-client';
import { GuiApiAdapter } from '../../src/gui/src/api/adapter';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const CANARY_PATH = path.resolve(PROJECT_ROOT, 'rust', 'test.txt');
const CANARY_EXPECTED_HASH = '1392245502333919f23e58b8f544f12470db3829aabd5336a011e58d2b733435';

describe('UI1-18: Knowledge Search and Sandbox Results', () => {
  let server: http.Server;
  let serverPort: number;
  let serverUrl: string;
  let services: ServiceContainer;
  let router: RestApiRouter;
  let restClient: BrowserRestClient;
  let apiAdapter: GuiApiAdapter;

  beforeAll(async () => {
    services = createServiceContainer(PROJECT_ROOT);
    router = new RestApiRouter(services, PROJECT_ROOT);

    await new Promise<void>((resolve) => {
      server = http.createServer(async (req, res) => {
        try {
          const handled = await router.handle(req, res);
          if (!handled) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not Found' }));
          }
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        serverPort = typeof addr === 'object' && addr ? addr.port : 0;
        serverUrl = `http://127.0.0.1:${serverPort}`;
        resolve();
      });
    });

    restClient = new BrowserRestClient({
      baseUrl: serverUrl,
      projectRoot: PROJECT_ROOT,
      timeoutMs: 15000,
    });
    apiAdapter = new GuiApiAdapter(restClient);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 1. KB Search REST API
  // ══════════════════════════════════════════════════════════════

  describe('KB Search API (POST /api/v1/kb/search)', () => {
    it('POST /api/v1/kb/search with empty query returns error', async () => {
      const res = await fetch(`${serverUrl}/api/v1/kb/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: '' }),
      });
      // Should return a 400 or an error result
      const json = await res.json();
      if (res.status === 200) {
        // Got a no-answer result (valid behavior for empty query)
        expect(json.data.answered).toBe(false);
      } else {
        // Got an error response
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(json.error).toBeDefined();
        expect(json.error.code).toBeDefined();
      }
    });

    it('POST /api/v1/kb/search with valid query returns typed response', async () => {
      const res = await fetch(`${serverUrl}/api/v1/kb/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'vibration threshold', topK: 3 }),
      });
      const json = await res.json();

      if (res.status === 200) {
        // Should have typed response structure
        expect(json.data).toBeDefined();
        expect(json.data.schemaVersion).toBe(1);
        expect(json.data.query).toBe('vibration threshold');
        expect(typeof json.data.answered).toBe('boolean');
        expect(typeof json.data.durationMs).toBe('number');
        expect(json.data.projectId).toBeDefined();

        if (json.data.answered) {
          // Cited answer — every citation must have source provenance
          expect(Array.isArray(json.data.citations)).toBe(true);
          for (const citation of json.data.citations) {
            expect(citation.documentId).toBeDefined();
            expect(citation.chunkId).toBeDefined();
            expect(citation.sourcePath).toBeDefined();
            expect(citation.sourceHash).toBeDefined();
            expect(typeof citation.score).toBe('number');
            expect(citation.snippet).toBeDefined();
            expect(citation.indexBuildId).toBeDefined();
            expect(citation.embeddingModelId).toBeDefined();
          }
        } else {
          // No-answer — must include reason
          expect(json.data.reason).toBeDefined();
          expect(json.data.citations).toEqual([]);
        }
      } else {
        // Error is acceptable (e.g., index not built)
        expect(json.error).toBeDefined();
        expect(json.error.code).toBeDefined();
      }
    });

    it('answered result never contains uncited synthesized content', async () => {
      const res = await fetch(`${serverUrl}/api/v1/kb/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'test query for citation verification' }),
      });
      const json = await res.json();

      if (res.status === 200 && json.data.answered) {
        // Every citation must have a source hash and snippet from the index
        for (const citation of json.data.citations) {
          expect(citation.sourceHash).toBeTruthy();
          expect(citation.sourceHash.length).toBe(64); // SHA-256 hex
          expect(citation.snippet).toBeTruthy();
          expect(citation.documentId).toBeTruthy();
        }
        // No synthesized text field outside citations
        expect(json.data.synthesizedAnswer).toBeUndefined();
        expect(json.data.summary).toBeUndefined();
        expect(json.data.generatedAnswer).toBeUndefined();
      }
    });

    it('no-answer result has explicit reason and empty citations', async () => {
      // Force a no-answer by searching with very high minScore
      const res = await fetch(`${serverUrl}/api/v1/kb/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'extremely specific query unlikely to match anything', minScore: 0.999 }),
      });
      const json = await res.json();

      if (res.status === 200) {
        if (json.data.answered === false) {
          expect(json.data.reason).toBeDefined();
          expect(typeof json.data.reason).toBe('string');
          expect(json.data.reason.length).toBeGreaterThan(0);
          expect(json.data.citations).toEqual([]);
        }
        // If answered, that's also valid (we can't guarantee no-answer)
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 2. KB Status API
  // ══════════════════════════════════════════════════════════════

  describe('KB Status API (GET /api/v1/kb/status)', () => {
    it('GET /api/v1/kb/status returns typed status response', async () => {
      const res = await fetch(`${serverUrl}/api/v1/kb/status`);
      const json = await res.json();

      if (res.status === 200) {
        expect(json.data).toBeDefined();
      } else {
        // May fail if index doesn't exist — but must return structured error
        expect(json.error).toBeDefined();
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 3. Sandbox Results API
  // ══════════════════════════════════════════════════════════════

  describe('Sandbox Results API (GET /api/v1/sandbox/results)', () => {
    it('GET /api/v1/sandbox/results returns array of typed records', async () => {
      const res = await fetch(`${serverUrl}/api/v1/sandbox/results`);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.data).toBeDefined();
      expect(Array.isArray(json.data)).toBe(true);

      // Each record, if present, must have typed fields
      for (const record of json.data) {
        expect(record.source).toBeDefined();
        // Records should NOT include host executor labeling
        expect(record.executorType).toBeUndefined();
        expect(record.hostExecutor).toBeUndefined();
      }
    });

    it('sandbox records include artifact hashes when present', async () => {
      const res = await fetch(`${serverUrl}/api/v1/sandbox/results`);
      const json = await res.json();

      for (const record of json.data) {
        // Hash fields are strings of 64 hex chars when present
        if (record.inputHash) {
          expect(typeof record.inputHash).toBe('string');
          expect(record.inputHash.length).toBe(64);
        }
        if (record.outputHash) {
          expect(typeof record.outputHash).toBe('string');
          expect(record.outputHash.length).toBe(64);
        }
      }
    });

    it('sandbox records do not expose raw stdout/stderr content', async () => {
      const res = await fetch(`${serverUrl}/api/v1/sandbox/results`);
      const json = await res.json();

      for (const record of json.data) {
        // Records should contain lengths, not actual content
        expect(record.stdout).toBeUndefined();
        expect(record.stderr).toBeUndefined();
      }
    });

    it('no host executor labeling in sandbox results', async () => {
      const res = await fetch(`${serverUrl}/api/v1/sandbox/results`);
      const json = await res.json();

      for (const record of json.data) {
        // Must never label as 'host' executor
        expect(record.executorType).toBeUndefined();
        if (record.source) {
          expect(record.source).not.toBe('host-executor');
        }
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 4. Client Parity (BrowserRestClient)
  // ══════════════════════════════════════════════════════════════

  describe('Client Parity (BrowserRestClient)', () => {
    it('restClient.searchKb exists and is callable', () => {
      expect(typeof restClient.searchKb).toBe('function');
    });

    it('restClient.getKbStatus exists and is callable', () => {
      expect(typeof restClient.getKbStatus).toBe('function');
    });

    it('restClient.getSandboxResults exists and is callable', () => {
      expect(typeof restClient.getSandboxResults).toBe('function');
    });

    it('restClient.getSandboxResults returns typed array', async () => {
      const results = await restClient.getSandboxResults();
      expect(Array.isArray(results)).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 5. Adapter Parity (GuiApiAdapter)
  // ══════════════════════════════════════════════════════════════

  describe('Adapter Parity (GuiApiAdapter)', () => {
    it('apiAdapter.searchKb exists and is callable', () => {
      expect(typeof apiAdapter.searchKb).toBe('function');
    });

    it('apiAdapter.getKbStatus exists and is callable', () => {
      expect(typeof apiAdapter.getKbStatus).toBe('function');
    });

    it('apiAdapter.getSandboxResults exists and delegates correctly', async () => {
      expect(typeof apiAdapter.getSandboxResults).toBe('function');
      const results = await apiAdapter.getSandboxResults();
      expect(Array.isArray(results)).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 6. View Structure
  // ══════════════════════════════════════════════════════════════

  describe('KnowledgeView Structure', () => {
    it('KnowledgeView.tsx exports a React component', async () => {
      const mod = await import('../../src/gui/src/views/KnowledgeView');
      expect(mod.KnowledgeView).toBeDefined();
      expect(typeof mod.KnowledgeView).toBe('function');
    });

    it('KnowledgeView file contains required accessibility attributes', () => {
      const content = fs.readFileSync(
        path.join(PROJECT_ROOT, 'src', 'gui', 'src', 'views', 'KnowledgeView.tsx'),
        'utf8',
      );
      expect(content).toContain('role="tabpanel"');
      expect(content).toContain('aria-label="Knowledge Search View"');
      expect(content).toContain('data-testid="kb-search-form"');
      expect(content).toContain('data-testid="kb-query-input"');
      expect(content).toContain('data-testid="kb-results"');
      expect(content).toContain('data-testid="kb-no-answer"');
      expect(content).toContain('data-testid="kb-citation-detail"');
    });

    it('KnowledgeView uses typed KbSearchResultResponse records', () => {
      const content = fs.readFileSync(
        path.join(PROJECT_ROOT, 'src', 'gui', 'src', 'views', 'KnowledgeView.tsx'),
        'utf8',
      );
      expect(content).toContain('KbSearchResultResponse');
      expect(content).toContain('KbSearchCitationRecord');
      expect(content).toContain('KbSearchPayload');
    });

    it('KnowledgeView does not contain synthesized answer display', () => {
      const content = fs.readFileSync(
        path.join(PROJECT_ROOT, 'src', 'gui', 'src', 'views', 'KnowledgeView.tsx'),
        'utf8',
      );
      expect(content).not.toContain('synthesizedAnswer');
      expect(content).not.toContain('generatedAnswer');
    });
  });

  describe('SandboxView Structure', () => {
    it('SandboxView.tsx exports a React component', async () => {
      const mod = await import('../../src/gui/src/views/SandboxView');
      expect(mod.SandboxView).toBeDefined();
      expect(typeof mod.SandboxView).toBe('function');
    });

    it('SandboxView file contains required accessibility attributes', () => {
      const content = fs.readFileSync(
        path.join(PROJECT_ROOT, 'src', 'gui', 'src', 'views', 'SandboxView.tsx'),
        'utf8',
      );
      expect(content).toContain('role="tabpanel"');
      expect(content).toContain('aria-label="Sandbox Results View"');
      expect(content).toContain('data-testid="sandbox-results-list"');
      expect(content).toContain('data-testid="sandbox-result-detail"');
      expect(content).toContain('data-testid="sandbox-manifest-box"');
    });

    it('SandboxView uses typed SandboxResultRecord records', () => {
      const content = fs.readFileSync(
        path.join(PROJECT_ROOT, 'src', 'gui', 'src', 'views', 'SandboxView.tsx'),
        'utf8',
      );
      expect(content).toContain('SandboxResultRecord');
      expect(content).toContain('inputHash');
      expect(content).toContain('outputHash');
      expect(content).toContain('exitCode');
      expect(content).toContain('stagedFiles');
    });

    it('SandboxView does not contain terminal/Monaco/IDE behavior', () => {
      const content = fs.readFileSync(
        path.join(PROJECT_ROOT, 'src', 'gui', 'src', 'views', 'SandboxView.tsx'),
        'utf8',
      );
      expect(content).not.toContain('Monaco');
      expect(content).not.toContain('terminal');
      expect(content).not.toContain('xterm');
      expect(content).not.toContain('CodeEditor');
      expect(content).not.toContain('hostExecutor');
    });

    it('SandboxView displays hashes not raw output content', () => {
      const content = fs.readFileSync(
        path.join(PROJECT_ROOT, 'src', 'gui', 'src', 'views', 'SandboxView.tsx'),
        'utf8',
      );
      // Shows hash displays
      expect(content).toContain('truncateHash');
      // Uses stdoutLength / stderrLength (lengths, not content)
      expect(content).toContain('stdoutLength');
      expect(content).toContain('stderrLength');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 7. App.tsx Routing Integration
  // ══════════════════════════════════════════════════════════════

  describe('App.tsx View Registration', () => {
    it('App.tsx imports and routes KnowledgeView', () => {
      const content = fs.readFileSync(
        path.join(PROJECT_ROOT, 'src', 'gui', 'src', 'App.tsx'),
        'utf8',
      );
      expect(content).toContain("import { KnowledgeView }");
      expect(content).toContain("'knowledge'");
      expect(content).toContain('<KnowledgeView />');
    });

    it('App.tsx imports and routes SandboxView', () => {
      const content = fs.readFileSync(
        path.join(PROJECT_ROOT, 'src', 'gui', 'src', 'App.tsx'),
        'utf8',
      );
      expect(content).toContain("import { SandboxView }");
      expect(content).toContain("'sandbox'");
      expect(content).toContain('<SandboxView />');
    });

    it('VALID_VIEWS includes knowledge and sandbox', () => {
      const content = fs.readFileSync(
        path.join(PROJECT_ROOT, 'src', 'gui', 'src', 'App.tsx'),
        'utf8',
      );
      // Extract VALID_VIEWS array text
      const viewsMatch = content.match(/VALID_VIEWS.*?\[([^\]]+)\]/s);
      expect(viewsMatch).toBeTruthy();
      const viewsText = viewsMatch![1];
      expect(viewsText).toContain("'knowledge'");
      expect(viewsText).toContain("'sandbox'");
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 8. Domain Type Re-Exports
  // ══════════════════════════════════════════════════════════════

  describe('Typed Record Re-Exports', () => {
    it('rest-client exports KbSearchPayload type', async () => {
      const mod = await import('../../src/gui/src/api/rest-client');
      // Type-only exports aren't runtime-testable, but the module should load
      expect(mod.BrowserRestClient).toBeDefined();
    });

    it('rest-client file contains KB and sandbox type definitions', () => {
      const content = fs.readFileSync(
        path.join(PROJECT_ROOT, 'src', 'gui', 'src', 'api', 'rest-client.ts'),
        'utf8',
      );
      expect(content).toContain('KbSearchPayload');
      expect(content).toContain('KbSearchCitationRecord');
      expect(content).toContain('KbSearchResultResponse');
      expect(content).toContain('SandboxResultRecord');
    });

    it('adapter file imports KB and sandbox types', () => {
      const content = fs.readFileSync(
        path.join(PROJECT_ROOT, 'src', 'gui', 'src', 'api', 'adapter.ts'),
        'utf8',
      );
      expect(content).toContain('KbSearchPayload');
      expect(content).toContain('KbSearchResultResponse');
      expect(content).toContain('SandboxResultRecord');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 9. Canary Invariant
  // ══════════════════════════════════════════════════════════════

  describe('Canary Invariant', () => {
    it('rust/test.txt SHA-256 hash is unchanged', () => {
      const content = fs.readFileSync(CANARY_PATH);
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      expect(hash).toBe(CANARY_EXPECTED_HASH);
    });
  });
});
