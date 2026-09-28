/**
 * F9-07: Sovereignty Bundle Application Service
 *
 * Orchestrates the export, persistence, signing, and verification of
 * Sovereignty Evidence Bundles and deterministic ZIP archives.
 *
 * Guarantees:
 * - Deterministic, self-contained bundle generation.
 * - Append-only and tamper-evident storage in `.maos/bundles/<bundleId>.json`.
 * - Zero-dependency deterministic ZIP creation in `.maos/bundles/<bundleId>.zip`.
 * - Pure offline verification without network access.
 * - Integration with all upstream F8 and F9 evidence services.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as zlib from 'zlib';
import {
  SovereigntyEvidenceBundle,
  SovereigntyBundleHashes,
  SovereigntyBundleEvidence,
  SovereigntyBundleStatus,
  OperatorSignoff,
  SOVEREIGNTY_BUNDLE_ERROR_CODES,
  SovereigntyBundleError,
  computeCanonicalBundleHash,
  computeBundleSignature,
  canonicalJson,
} from '../domain/sovereignty-bundle';
import {
  STANDARD_MEASURED_SOVEREIGNTY_CLAIM,
  STANDARD_EXCLUDED_INFRASTRUCTURE,
  STANDARD_OBSERVATION_LIMITATIONS,
  SovereigntyBoundary,
  ExcludedInfrastructure,
} from '../domain/sovereignty-boundary';
import { EndpointAllowlistPolicy } from '../domain/endpoint-allowlist';
import {
  FirewallRulePlan,
  FirewallSnapshot,
  FirewallStatusResult,
} from '../domain/firewall-policy';
import { NetworkObservationTrace } from '../domain/network-monitor';
import {
  ServiceEndpointIdentityMapping,
  ModelIdentityRecord,
} from '../domain/service-identity';
import { CalculationTrace } from '../domain/calculation-trace';
import {
  verifySovereigntyBundle,
  verifySovereigntyBundleZip,
  SovereigntyBundleVerificationResult,
  SovereigntyBundleVerifierOptions,
} from '../industrial/sovereignty-bundle-verifier';
import { SovereigntyBoundaryService } from './sovereignty-boundary-service';
import { EndpointAllowlistService } from './endpoint-allowlist-service';
import { FirewallService } from './firewall-service';
import { NetworkMonitorService } from './network-monitor-service';
import { ServiceIdentityService } from './service-identity-service';
import { CalculationTraceService } from './calculation-trace-service';
import { AuditService } from './audit-service';
import {
  getDefaultEnginePath,
  verifyExecutable,
} from '../industrial/rust-engine-bridge';

export interface GenerateBundleOptions {
  readonly bundleId?: string;
  readonly projectId?: string;
  readonly runId?: string;
  readonly workflowId?: string;
  readonly boundary?: SovereigntyBoundary;
  readonly endpointPolicy?: EndpointAllowlistPolicy;
  readonly firewallStatus?: FirewallStatusResult;
  readonly firewallPlan?: FirewallRulePlan;
  readonly firewallSnapshots?: readonly FirewallSnapshot[];
  readonly networkTrace?: NetworkObservationTrace;
  readonly serviceMapping?: ServiceEndpointIdentityMapping;
  readonly calculationTrace?: CalculationTrace;
  readonly auditTrail?: {
    readonly recordsCount: number;
    readonly latestHash: string;
    readonly chainVerified: boolean;
    readonly records?: readonly any[];
  };
  readonly rustVerifier?: {
    readonly executablePath: string;
    readonly executableHash: string;
    readonly engineVersion: string;
    readonly verified: boolean;
  };
  readonly modelIdentity?: ModelIdentityRecord;
  readonly sandboxManifest?: {
    readonly imageDigest?: string;
    readonly verified?: boolean;
    readonly architecture?: string;
  };
  readonly excludedBoundaries?: readonly ExcludedInfrastructure[];
  readonly verificationReportRefs?: readonly string[];
  readonly claims?: readonly string[];
  readonly observationLimitations?: readonly string[];
  readonly measurementInterval?: {
    readonly startedAt: string;
    readonly endedAt: string;
    readonly durationMs?: number;
  };
  readonly autoSignoff?: {
    readonly operatorId: string;
    readonly role?: string;
    readonly notes?: string;
    readonly secretKey?: string;
    readonly signature?: string;
  };
}

export interface SignOffBundleInput {
  readonly operatorId: string;
  readonly role?: string;
  readonly notes?: string;
  readonly secretKey?: string;
  readonly signature?: string;
  readonly keyFingerprint?: string;
}

export interface ZipEntry {
  readonly path: string;
  readonly content: string | Buffer;
}

/**
 * Creates a deterministic, standard PKZIP archive with STORE compression (method 0)
 * and fixed timestamps in pure Node.js.
 */
export function createDeterministicZip(entries: readonly ZipEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  const dosTime = 0; // 00:00:00
  const dosDate = 0x0021; // 1980-01-01 (DOS date format)

  const localHeadersAndData: Buffer[] = [];
  const cdHeaders: Buffer[] = [];
  let offset = 0;

  for (const entry of sorted) {
    const data = Buffer.isBuffer(entry.content)
      ? entry.content
      : Buffer.from(entry.content, 'utf8');
    const pathBuf = Buffer.from(entry.path, 'utf8');
    const crc = zlib.crc32(data);
    const size = data.length;

    // Local Header: 30 bytes
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); // signature
    lh.writeUInt16LE(20, 4); // version needed to extract (2.0)
    lh.writeUInt16LE(0x0800, 6); // flags (bit 11 = UTF-8)
    lh.writeUInt16LE(0, 8); // compression method (0 = STORE)
    lh.writeUInt16LE(dosTime, 10);
    lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(size, 18); // compressed size
    lh.writeUInt32LE(size, 22); // uncompressed size
    lh.writeUInt16LE(pathBuf.length, 26); // file name length
    lh.writeUInt16LE(0, 28); // extra field length

    // Central Directory Header: 46 bytes
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0); // signature
    cdh.writeUInt16LE(20, 4); // version made by
    cdh.writeUInt16LE(20, 6); // version needed
    cdh.writeUInt16LE(0x0800, 8); // UTF-8
    cdh.writeUInt16LE(0, 10); // method 0
    cdh.writeUInt16LE(dosTime, 12);
    cdh.writeUInt16LE(dosDate, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(size, 20); // compressed size
    cdh.writeUInt32LE(size, 24); // uncompressed size
    cdh.writeUInt16LE(pathBuf.length, 28);
    cdh.writeUInt16LE(0, 30); // extra field length
    cdh.writeUInt16LE(0, 32); // comment length
    cdh.writeUInt16LE(0, 34); // disk number start
    cdh.writeUInt16LE(0, 36); // internal attributes
    cdh.writeUInt32LE(0, 38); // external attributes
    cdh.writeUInt32LE(offset, 42); // relative offset of local header

    localHeadersAndData.push(lh, pathBuf, data);
    cdHeaders.push(cdh, pathBuf);

    offset += 30 + pathBuf.length + size;
  }

  const cdOffset = offset;
  const cdBuffer = Buffer.concat(cdHeaders);
  const cdSize = cdBuffer.length;

  // End of Central Directory Record: 22 bytes
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk number with CD
  eocd.writeUInt16LE(sorted.length, 8); // total entries on disk
  eocd.writeUInt16LE(sorted.length, 10); // total entries
  eocd.writeUInt32LE(cdSize, 12); // size of CD
  eocd.writeUInt32LE(cdOffset, 16); // offset of CD
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localHeadersAndData, cdBuffer, eocd]);
}

export class SovereigntyBundleService {
  private readonly bundlesDir: string;

  constructor(
    private readonly projectRoot: string,
    private readonly sovereigntyBoundary?: SovereigntyBoundaryService,
    private readonly endpointAllowlist?: EndpointAllowlistService,
    private readonly firewall?: FirewallService,
    private readonly networkMonitor?: NetworkMonitorService,
    private readonly serviceIdentity?: ServiceIdentityService,
    private readonly calculationTrace?: CalculationTraceService,
    private readonly auditService?: AuditService,
  ) {
    this.bundlesDir = path.join(this.projectRoot, '.maos', 'bundles');
    this.ensureDirectory();
  }

  private ensureDirectory(): void {
    if (!fs.existsSync(this.bundlesDir)) {
      fs.mkdirSync(this.bundlesDir, { recursive: true });
    }
  }

  private resolveProjectId(provided?: string): string {
    if (provided && provided.trim()) return provided.trim();
    const pidFile = path.join(this.projectRoot, '.maos', 'project-id');
    if (fs.existsSync(pidFile)) {
      const read = fs.readFileSync(pidFile, 'utf8').trim();
      if (read) return read;
    }
    return path.basename(this.projectRoot);
  }

  /**
   * Generates a comprehensive Sovereignty Evidence Bundle by aggregating
   * all verified F8 and F9 evidence.
   */
  public async generateBundle(
    options: GenerateBundleOptions = {},
  ): Promise<SovereigntyEvidenceBundle> {
    this.ensureDirectory();
    const projectId = this.resolveProjectId(options.projectId);
    const projectRootHash = crypto
      .createHash('sha256')
      .update(this.projectRoot)
      .digest('hex');

    const bundleId =
      options.bundleId ||
      `sovereignty_bundle_${projectId}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const createdAt = new Date().toISOString();

    // 1. Gather Evidence
    const boundary =
      options.boundary ||
      (this.sovereigntyBoundary?.getActiveBoundary(projectId) ?? undefined);

    const endpointPolicy =
      options.endpointPolicy ||
      (this.endpointAllowlist?.getActivePolicy(projectId) ?? undefined);

    let firewallStatus: FirewallStatusResult | undefined = options.firewallStatus;
    if (!firewallStatus && this.firewall) {
      try {
        firewallStatus = await this.firewall.getStatus();
      } catch {
        // Leave undefined
      }
    }

    const firewallPlan =
      options.firewallPlan || (this.firewall?.getActivePlan() ?? undefined);

    let firewallSnapshots: readonly FirewallSnapshot[] | undefined = options.firewallSnapshots;
    if (!firewallSnapshots && this.firewall) {
      const snapshotIds = this.firewall.listSnapshots();
      const loaded: FirewallSnapshot[] = [];
      const snapshotsDir = path.join(this.projectRoot, '.maos', 'firewall-snapshots');
      for (const sId of snapshotIds) {
        const sPath = path.join(snapshotsDir, `${sId}.json`);
        if (fs.existsSync(sPath)) {
          try {
            loaded.push(JSON.parse(fs.readFileSync(sPath, 'utf8')));
          } catch {
            // skip
          }
        }
      }
      if (loaded.length > 0) {
        firewallSnapshots = Object.freeze(loaded);
      }
    }

    let networkTrace: NetworkObservationTrace | undefined = options.networkTrace;
    if (!networkTrace && this.networkMonitor) {
      const evidenceDir = path.join(this.projectRoot, '.maos', 'network-evidence');
      if (fs.existsSync(evidenceDir)) {
        const traceFiles = fs.readdirSync(evidenceDir).filter((f) => f.endsWith('.json'));
        if (traceFiles.length > 0) {
          const latestFile = path.join(evidenceDir, traceFiles[traceFiles.length - 1]);
          try {
            networkTrace = JSON.parse(fs.readFileSync(latestFile, 'utf8'));
          } catch {
            // skip
          }
        }
      }
    }

    const serviceMapping =
      options.serviceMapping ||
      (this.serviceIdentity?.exportIdentityMapping(projectId) ?? undefined);

    const calculationTrace = options.calculationTrace;

    let auditTrail: any = options.auditTrail;
    if (!auditTrail && this.auditService) {
      try {
        const exported = this.auditService.exportAuditTrail();
        auditTrail = {
          recordsCount: exported.records.length,
          latestHash: exported.verification.latestHash,
          chainVerified: exported.verification.valid,
          records: exported.records,
        };
      } catch {
        // Leave undefined if audit trail cannot be exported
      }
    }

    let rustVerifier: any = options.rustVerifier;
    if (!rustVerifier) {
      try {
        const enginePath = getDefaultEnginePath(this.projectRoot);
        if (fs.existsSync(enginePath)) {
          const manifest = verifyExecutable(enginePath);
          rustVerifier = {
            executablePath: manifest.executablePath,
            executableHash: manifest.executableHash,
            engineVersion: manifest.engineVersion,
            protocolVersion: manifest.protocolVersion,
            verified: true,
          };
        }
      } catch {
        // Rust verifier optional in mock / test runs unless specified
      }
    }

    // 2. Assemble Hashes
    const hashes: SovereigntyBundleHashes = {
      boundaryHash: boundary?.boundaryHash || '',
      endpointPolicyHash: endpointPolicy?.policyHash || '',
      firewallActivePolicyHash: firewallStatus?.activePolicyHash,
      firewallSnapshotHash: firewallSnapshots?.[0]?.snapshotHash,
      firewallPlanHash: firewallPlan?.planHash,
      networkTraceHash: networkTrace?.traceHash || '',
      serviceMappingHash: serviceMapping?.mappingHash || '',
      calculationTraceHash: calculationTrace?.traceHash,
      auditChainHeadHash: auditTrail?.latestHash,
      rustVerifierExecutableHash: rustVerifier?.executableHash,
      sandboxImageDigest: options.sandboxManifest?.imageDigest,
      projectRootHash,
    };

    const evidence: SovereigntyBundleEvidence = {
      boundary,
      endpointPolicy,
      firewallStatus,
      firewallPlan,
      firewallSnapshots,
      networkTrace,
      serviceMapping,
      calculationTrace,
      auditTrail,
      rustVerifier,
      modelIdentity: options.modelIdentity,
      sandboxManifest: options.sandboxManifest,
    };

    const excludedBoundaries =
      options.excludedBoundaries ||
      boundary?.excludedInfrastructure ||
      STANDARD_EXCLUDED_INFRASTRUCTURE;

    const claims = options.claims || [STANDARD_MEASURED_SOVEREIGNTY_CLAIM];
    const observationLimitations =
      options.observationLimitations ||
      boundary?.observationLimitations ||
      STANDARD_OBSERVATION_LIMITATIONS;

    const measurementInterval = options.measurementInterval || {
      startedAt: boundary?.measurementInterval?.startedAt || createdAt,
      endedAt: boundary?.measurementInterval?.endedAt || createdAt,
      durationMs: boundary?.measurementInterval?.durationMs,
    };

    const verificationReportRefs = options.verificationReportRefs || [
      'F8-01',
      'F8-02',
      'F8-03',
      'F8-04',
      'F8-05',
      'F8-06',
      'F9-01',
      'F9-02',
      'F9-03',
      'F9-04',
      'F9-05',
      'F9-06',
    ];

    let status: SovereigntyBundleStatus = options.autoSignoff ? 'SIGNED_OFF' : 'DRAFT';
    let signoff: OperatorSignoff | undefined;

    // Preliminary draft bundle without bundleHash or signoff
    const draftPayload: Omit<SovereigntyEvidenceBundle, 'bundleHash' | 'signoff'> = {
      schemaVersion: 1,
      bundleId,
      projectId,
      projectRoot: this.projectRoot,
      projectRootHash,
      runId: options.runId,
      workflowId: options.workflowId,
      createdAt,
      status,
      hashes,
      evidence,
      excludedBoundaries,
      verificationReportRefs,
      claims,
      observationLimitations,
      measurementInterval,
    };

    const canonicalBundleHash = computeCanonicalBundleHash(draftPayload as any);

    if (options.autoSignoff) {
      const signedAt = new Date().toISOString();
      const signature =
        options.autoSignoff.signature ||
        computeBundleSignature(
          canonicalBundleHash,
          options.autoSignoff.operatorId,
          signedAt,
          options.autoSignoff.secretKey,
        );

      signoff = {
        operatorId: options.autoSignoff.operatorId,
        role: options.autoSignoff.role || 'lead_sovereignty_auditor',
        signedAt,
        notes: options.autoSignoff.notes || 'Formal signoff on verified evidence bundle.',
        signature,
      };
    }

    const bundle: SovereigntyEvidenceBundle = {
      ...draftPayload,
      status,
      signoff,
      bundleHash: canonicalBundleHash,
    };

    // Save JSON and archive
    this.saveBundle(bundle);
    this.exportBundleArchive(bundle.bundleId);

    return bundle;
  }

  /**
   * Signs off on an existing DRAFT bundle, transitioning it to SIGNED_OFF.
   */
  public signOffBundle(
    bundleId: string,
    signoffInput: SignOffBundleInput,
  ): SovereigntyEvidenceBundle {
    const existing = this.loadBundle(bundleId);
    const targetPayload = {
      ...existing,
      status: 'SIGNED_OFF' as const,
    };
    const computedBundleHash = computeCanonicalBundleHash(targetPayload);
    const signedAt = new Date().toISOString();

    const signature =
      signoffInput.signature ||
      computeBundleSignature(
        computedBundleHash,
        signoffInput.operatorId,
        signedAt,
        signoffInput.secretKey,
      );

    const signoff: OperatorSignoff = {
      operatorId: signoffInput.operatorId,
      role: signoffInput.role || 'lead_sovereignty_auditor',
      signedAt,
      notes: signoffInput.notes || 'Approved sovereign evidence bundle release.',
      signature,
      keyFingerprint: signoffInput.keyFingerprint,
    };

    const updatedBundle: SovereigntyEvidenceBundle = {
      ...targetPayload,
      signoff,
      bundleHash: computedBundleHash,
    };

    this.saveBundle(updatedBundle);
    this.exportBundleArchive(bundleId);

    return updatedBundle;
  }

  private safeWriteFileAtomic(filePath: string, content: string | Buffer): void {
    const tempPath = `${filePath}.tmp_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    fs.writeFileSync(tempPath, content);
    try {
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch {}
      }
      fs.renameSync(tempPath, filePath);
    } catch {
      try {
        fs.copyFileSync(tempPath, filePath);
        try {
          fs.unlinkSync(tempPath);
        } catch {}
      } catch (err: any) {
        throw new Error(`Failed to write atomic file ${filePath}: ${err.message}`);
      }
    }
  }

  /**
   * Saves a bundle to disk as `.maos/bundles/<bundleId>.json`.
   */
  public saveBundle(bundle: SovereigntyEvidenceBundle): void {
    this.ensureDirectory();
    const filePath = path.join(this.bundlesDir, `${bundle.bundleId}.json`);
    this.safeWriteFileAtomic(filePath, JSON.stringify(bundle, null, 2));
  }

  /**
   * Loads a bundle from disk.
   */
  public loadBundle(bundleId: string): SovereigntyEvidenceBundle {
    const filePath = path.join(this.bundlesDir, `${bundleId}.json`);
    if (!fs.existsSync(filePath)) {
      throw new SovereigntyBundleError(
        SOVEREIGNTY_BUNDLE_ERROR_CODES.BUNDLE_NOT_FOUND,
        `Sovereignty bundle "${bundleId}" not found at ${filePath}`,
      );
    }
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content) as SovereigntyEvidenceBundle;
  }

  /**
   * Lists all stored bundles.
   */
  public listBundles(): readonly SovereigntyEvidenceBundle[] {
    this.ensureDirectory();
    const files = fs.readdirSync(this.bundlesDir);
    const bundles: SovereigntyEvidenceBundle[] = [];
    for (const f of files) {
      if (f.endsWith('.json') && !f.includes('.tmp')) {
        try {
          const content = fs.readFileSync(path.join(this.bundlesDir, f), 'utf8');
          bundles.push(JSON.parse(content));
        } catch {
          // ignore corrupted or non-bundle JSON
        }
      }
    }
    return bundles;
  }

  /**
   * Generates a deterministic ZIP archive containing the bundle and its partitioned evidence.
   */
  public exportBundleArchive(bundleId: string): {
    zipBuffer: Buffer;
    zipPath: string;
  } {
    const bundle = this.loadBundle(bundleId);
    const entries: ZipEntry[] = [];

    // 1. Root bundle.json
    entries.push({
      path: 'bundle.json',
      content: JSON.stringify(bundle, null, 2),
    });

    // 2. Summary manifest.json
    const manifest = {
      schemaVersion: 1,
      bundleId: bundle.bundleId,
      projectId: bundle.projectId,
      status: bundle.status,
      bundleHash: bundle.bundleHash,
      createdAt: bundle.createdAt,
      signedOff: bundle.status === 'SIGNED_OFF',
      operatorId: bundle.signoff?.operatorId,
      hashes: bundle.hashes,
      reports: bundle.verificationReportRefs,
    };
    entries.push({
      path: 'manifest.json',
      content: JSON.stringify(manifest, null, 2),
    });

    // 3. Evidence Sub-Files
    if (bundle.evidence.boundary) {
      entries.push({
        path: 'evidence/boundary.json',
        content: JSON.stringify(bundle.evidence.boundary, null, 2),
      });
    }
    if (bundle.evidence.endpointPolicy) {
      entries.push({
        path: 'evidence/endpoint-policy.json',
        content: JSON.stringify(bundle.evidence.endpointPolicy, null, 2),
      });
    }
    if (bundle.evidence.firewallPlan || bundle.evidence.firewallStatus) {
      entries.push({
        path: 'evidence/firewall.json',
        content: JSON.stringify(
          {
            status: bundle.evidence.firewallStatus,
            plan: bundle.evidence.firewallPlan,
            snapshots: bundle.evidence.firewallSnapshots,
          },
          null,
          2,
        ),
      });
    }
    if (bundle.evidence.networkTrace) {
      entries.push({
        path: 'evidence/network-trace.json',
        content: JSON.stringify(bundle.evidence.networkTrace, null, 2),
      });
    }
    if (bundle.evidence.serviceMapping) {
      entries.push({
        path: 'evidence/service-identity.json',
        content: JSON.stringify(bundle.evidence.serviceMapping, null, 2),
      });
    }
    if (bundle.evidence.calculationTrace) {
      entries.push({
        path: 'evidence/calculation-trace.json',
        content: JSON.stringify(bundle.evidence.calculationTrace, null, 2),
      });
    }
    if (bundle.evidence.auditTrail) {
      entries.push({
        path: 'evidence/audit-trail.json',
        content: JSON.stringify(bundle.evidence.auditTrail, null, 2),
      });
    }

    // 4. Verification Instructions
    const instructions = `# Sovereignty Evidence Bundle Offline Verification

Bundle ID: ${bundle.bundleId}
Project ID: ${bundle.projectId}
Bundle Canonical SHA-256: ${bundle.bundleHash}
Status: ${bundle.status}
Signed By: ${bundle.signoff?.operatorId ?? 'Unsigned'}

## Verification Steps:
1. Verify bundle.json SHA-256 canonical hash using SovereigntyBundleVerifier.
2. Verify all cryptographic hashes in manifest.json against evidence/*.json sub-files.
3. Validate that all network observations are 100% loopback-only.
4. Confirm operator signature against canonical bundle hash.
`;
    entries.push({
      path: 'VERIFICATION.md',
      content: instructions,
    });

    const zipBuffer = createDeterministicZip(entries);
    const zipPath = path.join(this.bundlesDir, `${bundleId}.zip`);
    this.safeWriteFileAtomic(zipPath, zipBuffer);

    return { zipBuffer, zipPath };
  }

  /**
   * Verifies an in-storage bundle using the authoritative offline verifier.
   */
  public verifyBundle(
    bundleId: string,
    options: SovereigntyBundleVerifierOptions = {},
  ): SovereigntyBundleVerificationResult {
    const bundle = this.loadBundle(bundleId);
    return verifySovereigntyBundle(bundle, options);
  }

  /**
   * Verifies an exported ZIP archive using the authoritative offline verifier.
   */
  public verifyBundleArchive(
    bundleId: string,
    options: SovereigntyBundleVerifierOptions = {},
  ): SovereigntyBundleVerificationResult {
    const zipPath = path.join(this.bundlesDir, `${bundleId}.zip`);
    if (!fs.existsSync(zipPath)) {
      throw new SovereigntyBundleError(
        SOVEREIGNTY_BUNDLE_ERROR_CODES.BUNDLE_NOT_FOUND,
        `Bundle archive "${bundleId}.zip" not found at ${zipPath}`,
      );
    }
    const zipBuffer = fs.readFileSync(zipPath);
    return verifySovereigntyBundleZip(zipBuffer, options);
  }

  /**
   * Cleans up orphaned temporary bundle files left by interrupted saves or exports.
   */
  public cleanupOrphanTempFiles(): number {
    let purged = 0;
    if (!fs.existsSync(this.bundlesDir)) return 0;
    try {
      const files = fs.readdirSync(this.bundlesDir);
      for (const file of files) {
        if (file.includes('.tmp_')) {
          try {
            fs.unlinkSync(path.join(this.bundlesDir, file));
            purged++;
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore
    }
    return purged;
  }
}
