/**
 * F11-09: Judge Q&A & Technical Defense Test Suite
 *
 * Validates that the judge defense matrix and technical Q&A documentation
 * accurately reflect runtime contracts, honest boundary definitions,
 * and negative invariants across all 8 mandatory domains.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const CANARY_PATH = path.resolve(PROJECT_ROOT, 'rust', 'test.txt');
const DEFENSE_DOC_PATH = path.resolve(PROJECT_ROOT, 'artifacts', 'verification', 'F11-09.md');
const CANARY_EXPECTED_HASH = '1392245502333919f23e58b8f544f12470db3829aabd5336a011e58d2b733435';

function verifyCanary() {
  expect(fs.existsSync(CANARY_PATH)).toBe(true);
  const content = fs.readFileSync(CANARY_PATH);
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  expect(hash).toBe(CANARY_EXPECTED_HASH);
}

describe('F11-09: Judge Q&A & Technical Defense Verification', () => {
  verifyCanary();

  it('defense document F11-09.md exists in artifacts/verification/', () => {
    expect(fs.existsSync(DEFENSE_DOC_PATH)).toBe(true);
  });

  const doc = fs.readFileSync(DEFENSE_DOC_PATH, 'utf8');

  describe('Mandatory Topic Coverage', () => {
    it('Topic 1: covers Shared GPU Model Manager and serialized priority queues', () => {
      expect(doc).toContain('Shared GPU Model Manager & Model Selection');
      expect(doc).toContain('SharedModelManager');
      expect(doc).toContain('ModelLease');
      expect(doc).toContain('interactive');
      expect(doc).toContain('maxConcurrentLeases: 1');
    });

    it('Topic 2: covers Sovereign Prevention and explicit monitored boundary', () => {
      expect(doc).toContain('Sovereign Prevention & Monitored Network Boundary');
      expect(doc).toContain('127.0.0.1');
      expect(doc).toContain('No observed non-loopback application traffic');
      expect(doc).toContain('MAOS process tree');
    });

    it('Topic 3: covers Container Sandbox isolation and host execution disabled', () => {
      expect(doc).toContain('Container Sandbox vs. Host Execution');
      expect(doc).toContain('--network none');
      expect(doc).toContain('--read-only');
      expect(doc).toContain('no-new-privileges');
      expect(doc).toContain('container-isolated');
    });

    it('Topic 4: covers OCR Fact vs VLM Interpretation and explicit citations', () => {
      expect(doc).toContain('OCR Fact vs. VLM Interpretation & Document Citations');
      expect(doc).toContain('ocr_document');
      expect(doc).toContain('analyze_image');
      expect(doc).toContain('OCR_VLM_CONFLICT');
      expect(doc).toContain('HUMAN_REVIEW_REQUIRED');
    });

    it('Topic 5: covers Knowledge Base offline indexing and prompt injection safety', () => {
      expect(doc).toContain('Knowledge Base & Vector Indexing');
      expect(doc).toContain('NO_RUNTIME_DOWNLOAD');
      expect(doc).toContain('Data-Not-Instructions Policy');
      expect(doc).toContain('24-query frozen benchmark');
    });

    it('Topic 6: covers Human Governance and cryptographic payload locking', () => {
      expect(doc).toContain('Human Governance & Approval Gates');
      expect(doc).toContain('decideApproval');
      expect(doc).toContain('APPROVAL_STATUS_INVALID');
      expect(doc).toContain('APPROVAL_PAYLOAD_MISMATCH');
    });

    it('Topic 7: covers Rust Engine authority and boundary of guarantees', () => {
      expect(doc).toContain('Rust Engine Authority & Invariants');
      expect(doc).toContain('maos-engine');
      expect(doc).toContain('#![forbid(unsafe_code)]');
      expect(doc).toContain('RUST_ENGINE_REQUIRED');
    });

    it('Topic 8: covers Single-Project MVP and v1.1 architectural readiness', () => {
      expect(doc).toContain('Single-Project MVP vs. Version 1.1 Architecture');
      expect(doc).toContain('one project root per service instance');
      expect(doc).toContain('v1.1');
      expect(doc).toContain('UI1-24');
    });
  });

  describe('Prohibited Claims Rejection (Negative Invariants)', () => {
    it('strictly rejects "Zero data left" claims', () => {
      expect(doc).toContain('Zero data left on the device');
      expect(doc).toContain('compliance audit ledgers and output deliverables remain on disk');
    });

    it('strictly rejects "Certified standard" claims', () => {
      expect(doc).toContain('Certified to ISO / ASME standard');
      expect(doc).toContain('explicit demonstration rulesets');
    });

    it('strictly rejects "100% zero-leak across entire PC" claims', () => {
      expect(doc).toContain('100% zero-leak across entire PC');
      expect(doc).toContain('Impossible without custom OS kernel driver');
    });

    it('strictly rejects "Rust proves engineering truth" claims', () => {
      expect(doc).toContain('Rust proves engineering truth');
      expect(doc).toContain('software cannot verify sensor physical calibration');
    });

    it('strictly rejects "Multi-project concurrent GUI in MVP" claims', () => {
      expect(doc).toContain('Multi-project concurrent GUI in MVP');
      expect(doc).toContain('One project root per service in MVP');
    });
  });

  describe('Canary Preservation', () => {
    it('strictly preserves canary file rust/test.txt SHA-256', () => {
      verifyCanary();
    });
  });
});
