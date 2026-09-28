/**
 * MAOS Industrial — F9-02: Explicit Endpoint Allowlist Test Suite
 *
 * Verifies the deterministic socket-level endpoint policy:
 * 1. Loopback TCP/UDP acceptance (127.0.0.1, ::1, localhost)
 * 2. Approved Windows named pipes acceptance (npipe:////./pipe/docker_engine)
 * 3. Public IP rejection (8.8.8.8, 1.1.1.1, etc.) -> NON_LOOPBACK_ENDPOINT
 * 4. Private LAN rejection (10.0.0.1, 192.168.1.1, 172.16.0.1) -> NON_LOOPBACK_ENDPOINT
 * 5. Link-local and multicast rejection (169.254.169.254, 224.0.0.1, 0.0.0.0) -> NON_LOOPBACK_ENDPOINT
 * 6. DNS resolution blocking -> DNS_RESOLUTION_FORBIDDEN
 * 7. Unallowlisted loopback port rejection -> ENDPOINT_NOT_ALLOWLISTED
 * 8. Undeclared bind port rejection -> UNDECLARED_EPHEMERAL_SERVICE
 * 9. HTTP redirect escape rejection -> REDIRECTED_ENDPOINT_REJECTED
 * 10. Service rebinding defense -> REBINDING_DETECTED
 * 11. ChatInferenceService integration (blocks non-loopback model endpoints before fetch)
 * 12. Canonical hashing determinism and tamper evidence
 * 13. Cross-project endpoint isolation
 * 14. Privacy-safe audit trail (valid categories, no secret leakage)
 * 15. Invariants & cryptographic integrity (rust/test.txt canary)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

import {
  createServiceContainer,
  ServiceContainer,
  ChatInferenceService,
  ChatInferenceError,
} from '../../src/service';
import {
  ENDPOINT_POLICY_ERROR_CODES,
  createIndustrialEndpointPolicy,
  validateEndpointPolicy,
  validateSocketEndpoint,
  validateHttpRedirect,
  classifyIpAddress,
  isLoopbackHost,
  extractNamedPipeName,
  computeCanonicalPolicyHash,
  EndpointPolicyError,
} from '../../src/domain/endpoint-allowlist';

describe('F9-02: Explicit Endpoint Allowlist', () => {
  const TEST_PROJECT_ROOT = path.resolve(__dirname, '../../');
  const CANARY_PATH = path.join(TEST_PROJECT_ROOT, 'rust/test.txt');
  const EXPECTED_CANARY_SHA256 =
    '1392245502333919f23e58b8f544f12470db3829aabd5336a011e58d2b733435';

  const testTempDir = path.join(
    TEST_PROJECT_ROOT,
    '.maos',
    'test-temp-f902-' + Date.now(),
  );

  let services: ServiceContainer;

  beforeAll(() => {
    if (!fs.existsSync(testTempDir)) {
      fs.mkdirSync(testTempDir, { recursive: true });
    }
    services = createServiceContainer(testTempDir);
  });

  afterAll(() => {
    if (fs.existsSync(testTempDir)) {
      try {
        fs.rmSync(testTempDir, { recursive: true, force: true });
      } catch {
        // Best effort cleanup
      }
    }
  });

  // ── 1. Loopback IPv4 & IPv6 Acceptance ─────────────────────────────

  describe('1. Loopback IPv4 & IPv6 Acceptance', () => {
    it('accepts declared 127.0.0.1 TCP bind on backend port 3847', () => {
      const res = services.endpointAllowlist.validateSocketTarget({
        protocol: 'tcp',
        direction: 'bind',
        host: '127.0.0.1',
        port: 3847,
        serviceId: 'maos_backend',
      });

      expect(res.allowed).toBe(true);
      expect(res.matchedEndpointId).toBe('ep_backend_rest');
      expect(res.classification).toBe('loopback');
    });

    it('accepts declared 127.0.0.1 TCP connect to model server port 8000', () => {
      const res = services.endpointAllowlist.validateSocketTarget({
        protocol: 'tcp',
        direction: 'connect',
        host: '127.0.0.1',
        port: 8000,
        serviceId: 'local_model_server',
      });

      expect(res.allowed).toBe(true);
      expect(res.matchedEndpointId).toBe('ep_model_server');
    });

    it('accepts declared 127.0.0.1 TCP connect to Ollama port 11434', () => {
      const res = services.endpointAllowlist.validateSocketTarget({
        protocol: 'tcp',
        direction: 'connect',
        host: '127.0.0.1',
        port: 11434,
      });

      expect(res.allowed).toBe(true);
      expect(res.matchedEndpointId).toBe('ep_ollama_server');
    });

    it('accepts declared IPv6 ::1 TCP bind on backend port 3847', () => {
      const res = services.endpointAllowlist.validateSocketTarget({
        protocol: 'tcp',
        direction: 'bind',
        host: '::1',
        port: 3847,
        serviceId: 'maos_backend',
      });

      expect(res.allowed).toBe(true);
      expect(res.matchedEndpointId).toBe('ep_backend_ipv6');
    });

    it('accepts localhost hostname mapped to loopback', () => {
      const res = services.endpointAllowlist.validateSocketTarget({
        protocol: 'tcp',
        direction: 'connect',
        host: 'localhost',
        port: 3847,
      });

      expect(res.allowed).toBe(true);
      expect(res.classification).toBe('loopback');
    });

    it('accepts client connect on loopback ephemeral ports (49152-65535)', () => {
      const res = services.endpointAllowlist.validateSocketTarget({
        protocol: 'tcp',
        direction: 'connect',
        host: '127.0.0.1',
        port: 52140,
      });

      expect(res.allowed).toBe(true);
      expect(res.matchedEndpointId).toBe('ep_ephemeral_client');
    });
  });

  // ── 2. Approved Windows Named Pipes Acceptance ────────────────────

  describe('2. Approved Windows Named Pipes Acceptance', () => {
    it('accepts approved docker_engine named pipe via URL and UNC path', () => {
      const resUrl = services.endpointAllowlist.validateSocketTarget({
        protocol: 'pipe',
        direction: 'connect',
        host: 'npipe:////./pipe/docker_engine',
      });
      expect(resUrl.allowed).toBe(true);
      expect(resUrl.matchedEndpointId).toBe('ep_named_pipe');

      const resUnc = services.endpointAllowlist.validateSocketTarget({
        protocol: 'pipe',
        direction: 'connect',
        pipeName: '\\\\.\\pipe\\docker_engine',
      });
      expect(resUnc.allowed).toBe(true);
    });

    it('accepts standard internal IPC named pipe', () => {
      const res = services.endpointAllowlist.validateSocketTarget({
        protocol: 'pipe',
        direction: 'connect',
        host: 'npipe:////./pipe/maos_ipc_default',
      });
      expect(res.allowed).toBe(true);
    });

    it('rejects unapproved or foreign named pipe with ENDPOINT_NOT_ALLOWLISTED', () => {
      const res = services.endpointAllowlist.validateSocketTarget({
        protocol: 'pipe',
        direction: 'connect',
        host: 'npipe:////./pipe/unauthorized_external_pipe',
      });

      expect(res.allowed).toBe(false);
      expect(res.errorCode).toBe(ENDPOINT_POLICY_ERROR_CODES.ENDPOINT_NOT_ALLOWLISTED);
      expect(res.reason).toContain('is not in approved list');
    });

    it('rejects malformed named pipe paths', () => {
      const res = services.endpointAllowlist.validateSocketTarget({
        protocol: 'pipe',
        direction: 'connect',
        host: 'not_a_valid_pipe_path/../../escape',
      });

      expect(res.allowed).toBe(false);
      expect(res.errorCode).toBe(ENDPOINT_POLICY_ERROR_CODES.ENDPOINT_NOT_ALLOWLISTED);
    });
  });

  // ── 3. Public IP Address Rejection ────────────────────────────────

  describe('3. Public IP Address Rejection (NON_LOOPBACK_ENDPOINT)', () => {
    it('rejects public DNS and cloud IPs (8.8.8.8, 1.1.1.1, 93.184.216.34)', () => {
      const publicIps = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '142.250.190.46'];

      for (const ip of publicIps) {
        const res = services.endpointAllowlist.validateSocketTarget({
          protocol: 'tcp',
          direction: 'connect',
          host: ip,
          port: 443,
        });

        expect(res.allowed).toBe(false);
        expect(res.errorCode).toBe(ENDPOINT_POLICY_ERROR_CODES.NON_LOOPBACK_ENDPOINT);
        expect(res.classification).toBe('public');
      }
    });

    it('classifies public IPv6 addresses correctly and rejects them', () => {
      const publicIpv6 = '2606:4700:4700::1111';
      expect(classifyIpAddress(publicIpv6)).toBe('public');

      const res = services.endpointAllowlist.validateSocketTarget({
        protocol: 'tcp',
        direction: 'connect',
        host: publicIpv6,
        port: 443,
      });

      expect(res.allowed).toBe(false);
      expect(res.errorCode).toBe(ENDPOINT_POLICY_ERROR_CODES.NON_LOOPBACK_ENDPOINT);
      expect(res.classification).toBe('public');
    });
  });

  // ── 4. Private LAN Address Rejection ──────────────────────────────

  describe('4. Private LAN Address Rejection (NON_LOOPBACK_ENDPOINT)', () => {
    it('rejects 10.0.0.0/8, 192.168.0.0/16, and 172.16.0.0/12 private networks', () => {
      const privateIps = [
        '10.0.0.1',
        '10.254.1.99',
        '192.168.1.1',
        '192.168.100.50',
        '172.16.0.1',
        '172.31.255.254',
      ];

      for (const ip of privateIps) {
        expect(classifyIpAddress(ip)).toBe('private_lan');

        const res = services.endpointAllowlist.validateSocketTarget({
          protocol: 'tcp',
          direction: 'connect',
          host: ip,
          port: 8080,
        });

        expect(res.allowed).toBe(false);
        expect(res.errorCode).toBe(ENDPOINT_POLICY_ERROR_CODES.NON_LOOPBACK_ENDPOINT);
        expect(res.classification).toBe('private_lan');
      }
    });

    it('rejects carrier-grade NAT addresses (100.64.0.0/10)', () => {
      const cgnatIp = '100.64.1.1';
      expect(classifyIpAddress(cgnatIp)).toBe('carrier_nat');

      const res = services.endpointAllowlist.validateSocketTarget({
        protocol: 'tcp',
        direction: 'connect',
        host: cgnatIp,
        port: 80,
      });

      expect(res.allowed).toBe(false);
      expect(res.errorCode).toBe(ENDPOINT_POLICY_ERROR_CODES.NON_LOOPBACK_ENDPOINT);
      expect(res.classification).toBe('carrier_nat');
    });
  });

  // ── 5. Link-Local, Multicast, and Wildcard Rejection ───────────────

  describe('5. Link-Local, Multicast, and Wildcard Rejection', () => {
    it('rejects cloud metadata link-local address (169.254.169.254)', () => {
      const linkLocal = '169.254.169.254';
      expect(classifyIpAddress(linkLocal)).toBe('link_local');

      const res = services.endpointAllowlist.validateSocketTarget({
        protocol: 'tcp',
        direction: 'connect',
        host: linkLocal,
        port: 80,
      });

      expect(res.allowed).toBe(false);
      expect(res.errorCode).toBe(ENDPOINT_POLICY_ERROR_CODES.NON_LOOPBACK_ENDPOINT);
      expect(res.classification).toBe('link_local');
    });

    it('rejects IPv6 link-local addresses (fe80::1)', () => {
      const linkLocalIpv6 = 'fe80::1';
      expect(classifyIpAddress(linkLocalIpv6)).toBe('link_local');

      const res = services.endpointAllowlist.validateSocketTarget({
        protocol: 'tcp',
        direction: 'connect',
        host: linkLocalIpv6,
        port: 80,
      });

      expect(res.allowed).toBe(false);
      expect(res.errorCode).toBe(ENDPOINT_POLICY_ERROR_CODES.NON_LOOPBACK_ENDPOINT);
    });

    it('rejects multicast targets (224.0.0.1, ff02::1)', () => {
      const resV4 = services.endpointAllowlist.validateSocketTarget({
        protocol: 'udp',
        direction: 'connect',
        host: '224.0.0.1',
        port: 5353,
      });
      expect(resV4.allowed).toBe(false);
      expect(resV4.errorCode).toBe(ENDPOINT_POLICY_ERROR_CODES.NON_LOOPBACK_ENDPOINT);
      expect(resV4.classification).toBe('multicast');

      const resV6 = services.endpointAllowlist.validateSocketTarget({
        protocol: 'udp',
        direction: 'connect',
        host: 'ff02::1',
        port: 5353,
      });
      expect(resV6.allowed).toBe(false);
      expect(resV6.errorCode).toBe(ENDPOINT_POLICY_ERROR_CODES.NON_LOOPBACK_ENDPOINT);
      expect(resV6.classification).toBe('multicast');
    });

    it('rejects wildcard bind to 0.0.0.0 or ::', () => {
      const res0 = services.endpointAllowlist.validateSocketTarget({
        protocol: 'tcp',
        direction: 'bind',
        host: '0.0.0.0',
        port: 3847,
      });
      expect(res0.allowed).toBe(false);
      expect(res0.errorCode).toBe(ENDPOINT_POLICY_ERROR_CODES.NON_LOOPBACK_ENDPOINT);
      expect(res0.classification).toBe('unspecified');

      const resColons = services.endpointAllowlist.validateSocketTarget({
        protocol: 'tcp',
        direction: 'bind',
        host: '::',
        port: 3847,
      });
      expect(resColons.allowed).toBe(false);
      expect(resColons.errorCode).toBe(ENDPOINT_POLICY_ERROR_CODES.NON_LOOPBACK_ENDPOINT);
      expect(resColons.classification).toBe('unspecified');
    });
  });

  // ── 6. DNS Resolution Denial ──────────────────────────────────────

  describe('6. DNS Resolution Denial (DNS_RESOLUTION_FORBIDDEN)', () => {
    it('rejects arbitrary external hostnames before network dispatch', () => {
      const hostnames = [
        'api.openai.com',
        'google.com',
        'raw.githubusercontent.com',
        'huggingface.co',
        'internal-corp.net',
      ];

      for (const hostname of hostnames) {
        const socketRes = services.endpointAllowlist.validateSocketTarget({
          protocol: 'tcp',
          direction: 'connect',
          host: hostname,
          port: 443,
        });

        expect(socketRes.allowed).toBe(false);
        expect(socketRes.errorCode).toBe(ENDPOINT_POLICY_ERROR_CODES.DNS_RESOLUTION_FORBIDDEN);

        const dnsRes = services.endpointAllowlist.validateDnsResolution(hostname);
        expect(dnsRes.allowed).toBe(false);
        expect(dnsRes.errorCode).toBe(ENDPOINT_POLICY_ERROR_CODES.DNS_RESOLUTION_FORBIDDEN);
      }
    });

    it('rejects DNS resolution if returned IPs contain non-loopback addresses', () => {
      const res = services.endpointAllowlist.validateDnsResolution('my-local-server.lan', [
        '192.168.1.100',
      ]);
      expect(res.allowed).toBe(false);
      expect(res.errorCode).toBe(ENDPOINT_POLICY_ERROR_CODES.NON_LOOPBACK_ENDPOINT);
    });

    it('accepts DNS resolution if resolving strictly to 127.0.0.1 or ::1', () => {
      const res = services.endpointAllowlist.validateDnsResolution('localhost', [
        '127.0.0.1',
        '::1',
      ]);
      expect(res.allowed).toBe(true);
      expect(res.classification).toBe('loopback');
    });
  });

  // ── 7. Unallowlisted Loopback Ports & Undeclared Binds ─────────────

  describe('7. Unallowlisted Loopback Ports & Undeclared Binds', () => {
    it('rejects connect to undeclared loopback port outside ephemeral range with ENDPOINT_NOT_ALLOWLISTED', () => {
      const res = services.endpointAllowlist.validateSocketTarget({
        protocol: 'tcp',
        direction: 'connect',
        host: '127.0.0.1',
        port: 4444, // Not 3847, 8000, 11434, and not in 49152-65535
      });

      expect(res.allowed).toBe(false);
      expect(res.errorCode).toBe(ENDPOINT_POLICY_ERROR_CODES.ENDPOINT_NOT_ALLOWLISTED);
      expect(res.reason).toContain('is not allowlisted');
    });

    it('rejects bind to undeclared loopback port with UNDECLARED_EPHEMERAL_SERVICE', () => {
      const res = services.endpointAllowlist.validateSocketTarget({
        protocol: 'tcp',
        direction: 'bind',
        host: '127.0.0.1',
        port: 9999,
      });

      expect(res.allowed).toBe(false);
      expect(res.errorCode).toBe(ENDPOINT_POLICY_ERROR_CODES.UNDECLARED_EPHEMERAL_SERVICE);
    });
  });

  // ── 8. HTTP Redirect Validation ───────────────────────────────────

  describe('8. HTTP Redirect Validation (REDIRECTED_ENDPOINT_REJECTED)', () => {
    it('accepts safe redirect within approved loopback endpoint', () => {
      const res = services.endpointAllowlist.validateRedirect(
        'http://127.0.0.1:8000/v1',
        'http://127.0.0.1:8000/v1/chat/completions',
      );
      expect(res.allowed).toBe(true);
    });

    it('rejects redirect attempting to jump from loopback to private LAN', () => {
      const res = services.endpointAllowlist.validateRedirect(
        'http://127.0.0.1:8000/v1',
        'http://192.168.1.50:8000/v1',
      );

      expect(res.allowed).toBe(false);
      expect(res.errorCode).toBe(ENDPOINT_POLICY_ERROR_CODES.REDIRECTED_ENDPOINT_REJECTED);
      expect(res.reason).toContain('classified as "private_lan"');
    });

    it('rejects redirect attempting to jump to public host', () => {
      const res = services.endpointAllowlist.validateRedirect(
        'http://127.0.0.1:8000/v1',
        'https://api.openai.com/v1',
      );

      expect(res.allowed).toBe(false);
      expect(res.errorCode).toBe(ENDPOINT_POLICY_ERROR_CODES.REDIRECTED_ENDPOINT_REJECTED);
    });

    it('rejects redirect attempting to switch to an unallowlisted loopback port', () => {
      const res = services.endpointAllowlist.validateRedirect(
        'http://127.0.0.1:8000/v1',
        'http://127.0.0.1:7777/v1',
      );

      expect(res.allowed).toBe(false);
      expect(res.errorCode).toBe(ENDPOINT_POLICY_ERROR_CODES.REDIRECTED_ENDPOINT_REJECTED);
      expect(res.reason).toContain('is not allowlisted');
    });
  });

  // ── 9. Service Rebinding Defense ──────────────────────────────────

  describe('9. Service Rebinding Defense (REBINDING_DETECTED)', () => {
    it('registers valid service endpoint on allowlisted port', () => {
      const reg = services.endpointAllowlist.registerServiceEndpoint(
        'backend_daemon',
        '127.0.0.1',
        3847,
        12345,
      );

      expect(reg.allowed).toBe(true);
      const registry = services.endpointAllowlist.getRegisteredServices();
      expect(registry['backend_daemon']).toBeDefined();
      expect(registry['backend_daemon'].port).toBe(3847);
    });

    it('detects and rejects sudden service rebinding to a different port or host', () => {
      // Rebind to different port
      const rebindPort = services.endpointAllowlist.registerServiceEndpoint(
        'backend_daemon',
        '127.0.0.1',
        8000, // unexpected port change
      );

      expect(rebindPort.allowed).toBe(false);
      expect(rebindPort.errorCode).toBe(ENDPOINT_POLICY_ERROR_CODES.REBINDING_DETECTED);
      expect(rebindPort.reason).toContain('rebind detected');

      // Rebind to different host
      const rebindHost = services.endpointAllowlist.registerServiceEndpoint(
        'backend_daemon',
        '127.0.0.2',
        3847,
      );

      expect(rebindHost.allowed).toBe(false);
      expect(rebindHost.errorCode).toBe(ENDPOINT_POLICY_ERROR_CODES.REBINDING_DETECTED);
    });
  });

  // ── 10. ChatInference & Model Endpoint Integration ────────────────

  describe('10. ChatInference & Model Endpoint Integration', () => {
    it('permits loopback model endpoint configured in ChatInferenceService', async () => {
      // Service instantiated with loopback endpoint
      const chat = new ChatInferenceService({
        endpointAllowlist: services.endpointAllowlist,
        modelEndpoint: 'http://127.0.0.1:8000',
        timeoutMs: 100, // short timeout since server is offline
      });

      // The call will fail with MODEL_SERVER_UNAVAILABLE (network refused), NOT NON_LOOPBACK_ENDPOINT!
      // This proves it passed endpoint allowlist validation.
      await expect(
        chat.chatCompletion({
          conversationId: 'test-conv-loopback',
          messages: [{ role: 'user', content: 'hello' }],
        }),
      ).rejects.toThrow();

      try {
        await chat.chatCompletion({
          conversationId: 'test-conv-loopback',
          messages: [{ role: 'user', content: 'hello' }],
        });
      } catch (err: any) {
        // Must NOT be NON_LOOPBACK_ENDPOINT or DNS_RESOLUTION_FORBIDDEN
        expect(err.code).not.toBe(ENDPOINT_POLICY_ERROR_CODES.NON_LOOPBACK_ENDPOINT);
        expect(err.code).not.toBe(ENDPOINT_POLICY_ERROR_CODES.DNS_RESOLUTION_FORBIDDEN);
      }
    });

    it('rejects external/cloud model endpoint BEFORE making any network call', async () => {
      const rogueChat = new ChatInferenceService({
        endpointAllowlist: services.endpointAllowlist,
        modelEndpoint: 'https://api.openai.com/v1',
      });

      await expect(
        rogueChat.chatCompletion({
          conversationId: 'test-conv-rogue',
          messages: [{ role: 'user', content: 'leak test' }],
        }),
      ).rejects.toThrow(ChatInferenceError);

      try {
        await rogueChat.chatCompletion({
          conversationId: 'test-conv-rogue',
          messages: [{ role: 'user', content: 'leak test' }],
        });
      } catch (err: any) {
        expect(err.code).toBe(ENDPOINT_POLICY_ERROR_CODES.DNS_RESOLUTION_FORBIDDEN);
        expect(err.message).toContain('rejected by endpoint allowlist');
      }
    });

    it('rejects private LAN model endpoint BEFORE making any network call', async () => {
      const lanChat = new ChatInferenceService({
        endpointAllowlist: services.endpointAllowlist,
        modelEndpoint: 'http://192.168.1.100:8000',
      });

      try {
        await lanChat.chatCompletion({
          conversationId: 'test-conv-lan',
          messages: [{ role: 'user', content: 'lan test' }],
        });
      } catch (err: any) {
        expect(err.code).toBe(ENDPOINT_POLICY_ERROR_CODES.NON_LOOPBACK_ENDPOINT);
        expect(err.message).toContain('rejected by endpoint allowlist');
      }
    });
  });

  // ── 11. Canonical Hashing & Tamper Evidence ───────────────────────

  describe('11. Canonical Hashing & Tamper Evidence', () => {
    it('computes deterministic canonical hash regardless of object key order', () => {
      const fixedDate = '2026-09-24T12:00:00.000Z';
      const policyA = createIndustrialEndpointPolicy('proj-canon', {
        policyId: 'policy-canon-1',
        createdAt: fixedDate,
      });

      const rearranged: any = {
        profileMode: policyA.profileMode,
        createdAt: policyA.createdAt,
        policyId: policyA.policyId,
        schemaVersion: policyA.schemaVersion,
        disallowDnsResolution: policyA.disallowDnsResolution,
        enforceLoopbackStrict: policyA.enforceLoopbackStrict,
        allowEphemeralPorts: policyA.allowEphemeralPorts,
        ephemeralPortRange: policyA.ephemeralPortRange,
        projectId: policyA.projectId,
        declaredEndpoints: policyA.declaredEndpoints,
        allowedNamedPipes: policyA.allowedNamedPipes,
      };

      const hashA = computeCanonicalPolicyHash(policyA);
      const hashB = computeCanonicalPolicyHash(rearranged);

      expect(hashA).toBe(hashB);
      expect(hashA).toBe(policyA.policyHash);
    });

    it('alters canonical hash when declared endpoints or named pipes are modified', () => {
      const base = createIndustrialEndpointPolicy('proj-canon-mod', {
        policyId: 'policy-mod-1',
        createdAt: '2026-09-24T12:00:00.000Z',
      });
      const originalHash = computeCanonicalPolicyHash(base);

      const modifiedPipes = [...base.allowedNamedPipes, 'extra_test_pipe'];
      const modifiedPolicy = { ...base, allowedNamedPipes: modifiedPipes };
      const newHash = computeCanonicalPolicyHash(modifiedPolicy);

      expect(newHash).not.toBe(originalHash);
    });

    it('fails closed when policyHash has been tampered with', () => {
      const policy = createIndustrialEndpointPolicy('proj-tamper-ep');
      const tampered = {
        ...policy,
        policyHash: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      };

      const res = validateEndpointPolicy(tampered);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('Policy hash mismatch'))).toBe(true);
    });
  });

  // ── 12. Cross-Project Endpoint Isolation ──────────────────────────

  describe('12. Cross-Project Endpoint Isolation', () => {
    it('rejects endpoint policy with mismatched project ID', () => {
      const policy = createIndustrialEndpointPolicy('project-one');
      const res = validateEndpointPolicy(policy, { expectedProjectId: 'project-two' });

      expect(res.valid).toBe(false);
      expect(
        res.errors.some((e) =>
          e.includes('Cross-project endpoint violation: policy belongs to project "project-one"'),
        ),
      ).toBe(true);
    });
  });

  // ── 13. Privacy-Safe Audit Trail ──────────────────────────────────

  describe('13. Privacy-Safe Audit Trail', () => {
    it('records privacy-safe endpoint audit events with category endpoint and warning', () => {
      const audit = services.audit;
      const initialCount = audit.getRecords().length;

      // Frozen policy
      services.endpointAllowlist.freezePolicy('proj-audit-test');

      // Rejected connect
      services.endpointAllowlist.validateSocketTarget({
        protocol: 'tcp',
        direction: 'connect',
        host: '8.8.8.8',
        port: 53,
      });

      const records = audit.getRecords().slice(initialCount);
      const endpointRecords = records.filter((r) => r.source === 'endpoint-allowlist');

      expect(endpointRecords.length).toBeGreaterThanOrEqual(2);
      expect(endpointRecords.some((r) => r.category === 'endpoint')).toBe(true);
      expect(endpointRecords.some((r) => r.category === 'warning')).toBe(true);

      // Verify audit chain remains strictly valid
      const chainVerification = services.audit.verifyChain();
      expect(chainVerification.valid).toBe(true);
    });
  });

  // ── 14. Invariants & Cryptographic Integrity ──────────────────────

  describe('14. Invariants & Cryptographic Integrity', () => {
    it('verifies rust/test.txt canary SHA-256 is strictly preserved', () => {
      expect(fs.existsSync(CANARY_PATH)).toBe(true);
      const canaryBytes = fs.readFileSync(CANARY_PATH);
      const computedHash = crypto.createHash('sha256').update(canaryBytes).digest('hex');
      expect(computedHash).toBe(EXPECTED_CANARY_SHA256);
    });
  });
});
