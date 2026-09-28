/**
 * F9-03: Firewall Boundary Enforcement Application Service
 *
 * Manages host firewall boundary enforcement, state inspection, rule synthesis
 * from sealed endpoint policies, atomic application with pre-change snapshotting,
 * automated failure rollback, and crash recovery.
 *
 * Safety Constraints:
 * 1. Never changes host firewall merely because MAOS starts.
 * 2. Requires explicit operator confirmation (`confirm: true`).
 * 3. Requires administrator / root privileges.
 * 4. Never reports ACTIVE based solely on a stored plan file.
 * 5. Atomically rolls back to pre-change snapshot on any rule failure.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AuditService } from './audit-service';
import type { EndpointAllowlistService } from './endpoint-allowlist-service';
import {
  FirewallAdapter,
  createPlatformFirewallAdapter,
} from '../industrial/firewall';
import {
  FirewallStatusState,
  FirewallStatusResult,
  FirewallRulePlan,
  FirewallSnapshot,
  FirewallApplyResult,
  FirewallRestoreResult,
  FirewallVerificationResult,
  FirewallError,
  FIREWALL_ERROR_CODES,
  synthesizeFirewallPlan,
  computeCanonicalFirewallPlanHash,
  computeCanonicalSnapshotHash,
} from '../domain/firewall-policy';

export interface FirewallServiceOptions {
  readonly auditService?: AuditService;
  readonly endpointAllowlist?: EndpointAllowlistService;
  readonly adapter?: FirewallAdapter;
  readonly platformOverride?: 'windows' | 'linux' | 'mock';
}

export interface ApplyFirewallOptions {
  readonly confirm: boolean;
  readonly dryRun?: boolean;
  readonly projectId?: string;
}

interface StoredFirewallState {
  status: FirewallStatusState;
  interrupted: boolean;
  activePlanId?: string;
  activeSnapshotId?: string;
  lastUpdatedAt: string;
}

export class FirewallService {
  private readonly firewallDir: string;
  private readonly snapshotsDir: string;
  private readonly activePlanPath: string;
  private readonly stateFilePath: string;

  private readonly adapter: FirewallAdapter;
  private readonly auditService?: AuditService;
  private readonly endpointAllowlist?: EndpointAllowlistService;

  constructor(
    private readonly projectRoot: string,
    options: FirewallServiceOptions = {},
  ) {
    this.firewallDir = path.join(this.projectRoot, '.maos', 'firewall');
    this.snapshotsDir = path.join(this.firewallDir, 'snapshots');
    this.activePlanPath = path.join(this.firewallDir, 'active-plan.json');
    this.stateFilePath = path.join(this.firewallDir, 'state.json');

    this.auditService = options.auditService;
    this.endpointAllowlist = options.endpointAllowlist;
    this.adapter =
      options.adapter ||
      createPlatformFirewallAdapter(options.platformOverride);

    this.ensureDirectories();
    this.recoverStateOnStartup();
  }

  private ensureDirectories(): void {
    if (!fs.existsSync(this.snapshotsDir)) {
      fs.mkdirSync(this.snapshotsDir, { recursive: true });
    }
  }

  /**
   * On startup, inspects on-disk transaction state.
   * If a previous application was interrupted before completion, flags RESTORE_REQUIRED.
   */
  private recoverStateOnStartup(): void {
    if (!fs.existsSync(this.stateFilePath)) {
      this.writeState({
        status: 'INACTIVE',
        interrupted: false,
        lastUpdatedAt: new Date().toISOString(),
      });
      return;
    }

    try {
      const raw = fs.readFileSync(this.stateFilePath, 'utf8');
      const state: StoredFirewallState = JSON.parse(raw);

      if (state.interrupted) {
        state.status = 'RESTORE_REQUIRED';
        this.writeState(state);

        if (this.auditService) {
          try {
            this.auditService.recordAuditEvent({
              category: 'warning',
              source: 'firewall-service',
              data: {
                event: 'FIREWALL_INTERRUPTED_TRANSACTION_DETECTED',
                message: 'Interrupted firewall transaction detected on startup. Status set to RESTORE_REQUIRED.',
              },
            });
          } catch {
            // Fail-safe
          }
        }
      }
    } catch {
      // Corrupt state file requires restore
      this.writeState({
        status: 'RESTORE_REQUIRED',
        interrupted: true,
        lastUpdatedAt: new Date().toISOString(),
      });
    }
  }

  private readState(): StoredFirewallState {
    if (fs.existsSync(this.stateFilePath)) {
      try {
        return JSON.parse(fs.readFileSync(this.stateFilePath, 'utf8'));
      } catch {
        // Fall through
      }
    }
    return {
      status: 'INACTIVE',
      interrupted: false,
      lastUpdatedAt: new Date().toISOString(),
    };
  }

  private writeState(state: StoredFirewallState): void {
    this.ensureDirectories();
    fs.writeFileSync(this.stateFilePath, JSON.stringify(state, null, 2), 'utf8');
  }

  /**
   * Inspects the host firewall and returns measured status.
   * Never reports ACTIVE based solely on a stored plan file.
   */
  public async getStatus(): Promise<FirewallStatusResult> {
    const storedState = this.readState();

    if (storedState.status === 'RESTORE_REQUIRED' || storedState.interrupted) {
      const adapterStatus = await this.adapter.inspectStatus();
      return {
        ...adapterStatus,
        state: 'RESTORE_REQUIRED',
        restoreRequired: true,
        details: 'Interrupted or unverified firewall state detected. Restoration required.',
      };
    }

    const adapterStatus = await this.adapter.inspectStatus();

    // Verify consistency: If active plan exists on disk, check if adapter confirms rules
    let verifiedActive = false;
    let activePlan: FirewallRulePlan | undefined;

    if (fs.existsSync(this.activePlanPath)) {
      try {
        activePlan = JSON.parse(fs.readFileSync(this.activePlanPath, 'utf8'));
        if (activePlan) {
          const verification = await this.adapter.verifyAppliedRules(activePlan);
          verifiedActive = verification.verified;
        }
      } catch {
        verifiedActive = false;
      }
    }

    let finalState: FirewallStatusState = 'INACTIVE';
    if (adapterStatus.state === 'ACTIVE' && verifiedActive) {
      finalState = 'ACTIVE';
    } else if (adapterStatus.state === 'ACTIVE' && !verifiedActive) {
      finalState = 'RESTORE_REQUIRED';
    } else if (adapterStatus.state === 'UNKNOWN') {
      finalState = 'UNKNOWN';
    }

    return {
      state: finalState,
      platform: this.adapter.platformName,
      isElevated: adapterStatus.isElevated,
      activeRuleCount: adapterStatus.activeRuleCount,
      activePlanId: activePlan?.planId,
      activePolicyHash: activePlan?.policyHash,
      snapshotCount: this.listSnapshots().length,
      restoreRequired: finalState === 'RESTORE_REQUIRED',
      checkedAt: new Date().toISOString(),
      details: adapterStatus.details,
    };
  }

  /**
   * Synthesizes a FirewallRulePlan from the active EndpointAllowlistPolicy.
   */
  public synthesizePlan(projectId = 'default'): FirewallRulePlan {
    if (!this.endpointAllowlist) {
      throw new FirewallError(
        FIREWALL_ERROR_CODES.FIREWALL_POLICY_TAMPERED,
        'Cannot synthesize firewall plan: EndpointAllowlistService is not configured.',
      );
    }

    const endpointPolicy = this.endpointAllowlist.getActivePolicy(projectId);
    return synthesizeFirewallPlan(endpointPolicy, this.adapter.platformName);
  }

  /**
   * Applies the firewall rule plan to the host firewall.
   * Enforces operator confirmation, elevation check, snapshot capture,
   * post-apply verification, and automated rollback on failure.
   */
  public async applyPlan(
    plan: FirewallRulePlan,
    options: ApplyFirewallOptions,
  ): Promise<FirewallApplyResult> {
    // 1. Explicit operator confirmation check
    if (!options.confirm) {
      throw new FirewallError(
        FIREWALL_ERROR_CODES.FIREWALL_CONFIRMATION_REQUIRED,
        'Firewall modification requires explicit operator confirmation (confirm: true).',
      );
    }

    // 2. Validate plan hash integrity
    const expectedPlanHash = computeCanonicalFirewallPlanHash(plan);
    if (plan.planHash && plan.planHash !== expectedPlanHash) {
      throw new FirewallError(
        FIREWALL_ERROR_CODES.FIREWALL_POLICY_TAMPERED,
        `Firewall rule plan hash mismatch: expected ${expectedPlanHash}, found ${plan.planHash}.`,
      );
    }

    // 3. Elevation check
    const isElevated = await this.adapter.isElevated();
    if (!isElevated) {
      throw new FirewallError(
        FIREWALL_ERROR_CODES.FIREWALL_PRIVILEGE_REQUIRED,
        'Administrator or root privileges are required to apply host firewall rules.',
      );
    }

    // 4. Mark transaction as interrupted before beginning mutation
    const previousState = this.readState();
    this.writeState({
      ...previousState,
      interrupted: true,
      lastUpdatedAt: new Date().toISOString(),
    });

    // 5. Capture pre-change snapshot
    let snapshot: FirewallSnapshot;
    try {
      snapshot = await this.adapter.captureSnapshot();
      const snapshotPath = path.join(this.snapshotsDir, `${snapshot.snapshotId}.json`);
      fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), 'utf8');
    } catch (err: any) {
      this.writeState({ ...previousState, interrupted: false });
      if (err instanceof FirewallError) throw err;
      throw new FirewallError(
        FIREWALL_ERROR_CODES.FIREWALL_SNAPSHOT_FAILED,
        `Failed to capture pre-change firewall snapshot: ${err.message}`,
      );
    }

    // 6. Apply rules via adapter with automated rollback on failure
    let applyResult: FirewallApplyResult;
    try {
      applyResult = await this.adapter.applyRules(plan, { dryRun: options.dryRun });
    } catch (applyErr: any) {
      // Initiate automated rollback
      try {
        await this.adapter.restoreSnapshot(snapshot);
        this.writeState({ ...previousState, interrupted: false });
      } catch (rollbackErr: any) {
        this.writeState({
          status: 'RESTORE_REQUIRED',
          interrupted: true,
          activeSnapshotId: snapshot.snapshotId,
          lastUpdatedAt: new Date().toISOString(),
        });
        throw new FirewallError(
          FIREWALL_ERROR_CODES.FIREWALL_ROLLBACK_FAILED,
          `Firewall apply failed (${applyErr.message}) AND rollback failed: ${rollbackErr.message}. RESTORE_REQUIRED.`,
        );
      }

      if (applyErr instanceof FirewallError) throw applyErr;
      throw new FirewallError(
        FIREWALL_ERROR_CODES.FIREWALL_APPLY_FAILED,
        `Firewall apply failed and rolled back cleanly: ${applyErr.message}`,
      );
    }

    // 7. Post-apply verification check
    const verify = await this.adapter.verifyAppliedRules(plan);
    if (!verify.verified) {
      // Mismatch: initiate rollback
      try {
        await this.adapter.restoreSnapshot(snapshot);
        this.writeState({ ...previousState, interrupted: false });
      } catch (rollbackErr: any) {
        this.writeState({
          status: 'RESTORE_REQUIRED',
          interrupted: true,
          activeSnapshotId: snapshot.snapshotId,
          lastUpdatedAt: new Date().toISOString(),
        });
        throw new FirewallError(
          FIREWALL_ERROR_CODES.FIREWALL_ROLLBACK_FAILED,
          `Post-apply verification failed AND rollback failed: ${rollbackErr.message}. RESTORE_REQUIRED.`,
        );
      }

      throw new FirewallError(
        FIREWALL_ERROR_CODES.FIREWALL_STATE_MISMATCH,
        `Post-apply verification failed: missing [${verify.missingRules.join(', ')}]. Rolled back cleanly.`,
      );
    }

    // 8. Commit active plan to disk
    fs.writeFileSync(this.activePlanPath, JSON.stringify(plan, null, 2), 'utf8');

    this.writeState({
      status: 'ACTIVE',
      interrupted: false,
      activePlanId: plan.planId,
      activeSnapshotId: snapshot.snapshotId,
      lastUpdatedAt: new Date().toISOString(),
    });

    // 9. Record privacy-safe audit event
    if (this.auditService) {
      try {
        this.auditService.recordAuditEvent({
          category: 'endpoint',
          source: 'firewall-service',
          data: {
            event: 'FIREWALL_RULES_APPLIED',
            planId: plan.planId,
            planHash: plan.planHash,
            policyHash: plan.policyHash,
            rulesCount: plan.rules.length,
            snapshotId: snapshot.snapshotId,
            platform: this.adapter.platformName,
          },
        });
      } catch {
        // Fail-safe
      }
    }

    return {
      ...applyResult,
      snapshotId: snapshot.snapshotId,
    };
  }

  /**
   * Restores host firewall state from a previously captured snapshot.
   */
  public async restorePreviousState(snapshotId?: string): Promise<FirewallRestoreResult> {
    const isElevated = await this.adapter.isElevated();
    if (!isElevated) {
      throw new FirewallError(
        FIREWALL_ERROR_CODES.FIREWALL_PRIVILEGE_REQUIRED,
        'Administrator or root privileges required to restore host firewall.',
      );
    }

    // Find snapshot
    const targetSnapshotId = snapshotId || this.getLatestSnapshotId();
    if (!targetSnapshotId) {
      throw new FirewallError(
        FIREWALL_ERROR_CODES.FIREWALL_RESTORE_REQUIRED,
        'No firewall snapshot available to restore from.',
      );
    }

    const snapshotPath = path.join(this.snapshotsDir, `${targetSnapshotId}.json`);
    if (!fs.existsSync(snapshotPath)) {
      throw new FirewallError(
        FIREWALL_ERROR_CODES.FIREWALL_RESTORE_REQUIRED,
        `Firewall snapshot file not found: ${snapshotPath}.`,
      );
    }

    const snapshot: FirewallSnapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));

    const expectedHash = computeCanonicalSnapshotHash(snapshot);
    if (snapshot.snapshotHash && snapshot.snapshotHash !== expectedHash) {
      throw new FirewallError(
        FIREWALL_ERROR_CODES.FIREWALL_POLICY_TAMPERED,
        `Firewall snapshot hash mismatch: expected ${expectedHash}, found ${snapshot.snapshotHash}.`,
      );
    }

    const restoreResult = await this.adapter.restoreSnapshot(snapshot);

    // Clean up active plan
    if (fs.existsSync(this.activePlanPath)) {
      try {
        fs.unlinkSync(this.activePlanPath);
      } catch {
        // ignore
      }
    }

    this.writeState({
      status: 'INACTIVE',
      interrupted: false,
      lastUpdatedAt: new Date().toISOString(),
    });

    if (this.auditService) {
      try {
        this.auditService.recordAuditEvent({
          category: 'endpoint',
          source: 'firewall-service',
          data: {
            event: 'FIREWALL_RULES_RESTORED',
            snapshotId: snapshot.snapshotId,
            rulesRestoredCount: restoreResult.rulesRestoredCount,
          },
        });
      } catch {
        // Fail-safe
      }
    }

    return restoreResult;
  }

  /**
   * Verifies the currently applied firewall state against the stored active plan.
   */
  public async verifyAppliedState(): Promise<FirewallVerificationResult> {
    if (!fs.existsSync(this.activePlanPath)) {
      return {
        verified: false,
        matchingRules: 0,
        expectedRules: 0,
        missingRules: ['NO_ACTIVE_PLAN'],
        unexpectedRules: [],
        verifiedAt: new Date().toISOString(),
      };
    }

    const activePlan: FirewallRulePlan = JSON.parse(fs.readFileSync(this.activePlanPath, 'utf8'));
    return this.adapter.verifyAppliedRules(activePlan);
  }

  public getActivePlan(): FirewallRulePlan | null {
    if (fs.existsSync(this.activePlanPath)) {
      try {
        return JSON.parse(fs.readFileSync(this.activePlanPath, 'utf8'));
      } catch {
        return null;
      }
    }
    return null;
  }

  public listSnapshots(): readonly string[] {
    if (!fs.existsSync(this.snapshotsDir)) return [];
    return fs
      .readdirSync(this.snapshotsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''));
  }

  private getLatestSnapshotId(): string | null {
    const list = this.listSnapshots();
    if (list.length === 0) return null;
    return list[list.length - 1];
  }
}
