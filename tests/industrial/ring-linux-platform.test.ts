/**
 * TASK LANE-B-LINUX-01: Linux platform test.
 *
 * On Linux the Windows-only adapters (firewall + socket observer) must
 * degrade honestly: every live-host method rejects with a "not available on
 * linux" error (never crashes with ENOENT, never reports false success), while
 * construction, platformName, and pure script synthesis stay side-effect free.
 * The platform factories must auto-select the Linux adapters, the default
 * engine path must resolve without `.exe`, and the T-07 scan PDF text layer
 * must extract deterministically (stdlib only, no OCR engine needed).
 *
 * Evidence-only: no live model calls, no elevation, no host changes.
 */
import { describe, expect, it } from 'vitest';
import * as path from 'path';
import { FIREWALL_ERROR_CODES } from '../../src/domain/firewall-policy';
import { NETWORK_MONITOR_ERROR_CODES } from '../../src/domain/network-monitor';
import { WindowsFirewallAdapter, createPlatformFirewallAdapter } from '../../src/industrial/firewall';
import { WindowsSocketObserver, createPlatformSocketObserver } from '../../src/industrial/network';
import { getDefaultEnginePath } from '../../src/industrial/rust-engine-bridge';
import { createOcrDocumentTool } from '../../src/service/ring-tools/ocr-document';
import { createIndustrialEndpointPolicy } from '../../src/domain/endpoint-allowlist';
import { synthesizeFirewallPlan } from '../../src/domain/firewall-policy';

const IS_LINUX = process.platform === 'linux';
const describeOnLinux = IS_LINUX ? describe : describe.skip;

describeOnLinux('LANE-B-LINUX-01: Windows adapters degrade honestly on linux', () => {
  it('WindowsFirewallAdapter constructs without side effects; script synthesis stays pure', () => {
    const adapter = new WindowsFirewallAdapter();
    expect(adapter.platformName).toBe('windows');
    const plan = synthesizeFirewallPlan(createIndustrialEndpointPolicy('linux-proof'), 'windows');
    const script = adapter.generatePowerShellScript(plan);
    expect(script).toContain('New-NetFirewallRule');
  });

  it('every live Windows firewall method rejects "not available on linux", never false success', async () => {
    const adapter = new WindowsFirewallAdapter();
    const plan = synthesizeFirewallPlan(createIndustrialEndpointPolicy('linux-proof'), 'windows');
    await expect(adapter.isElevated()).rejects.toThrow(/not available on linux/);
    await expect(adapter.captureSnapshot()).rejects.toThrow(/not available on linux/);
    await expect(adapter.inspectStatus()).rejects.toThrow(/not available on linux/);
    await expect(adapter.applyRules(plan, { dryRun: true })).rejects.toThrow(/not available on linux/);
    await expect(
      adapter.restoreSnapshot({
        schemaVersion: 1,
        snapshotId: 'snap-test',
        platform: 'windows',
        capturedAt: new Date().toISOString(),
        capturedRules: [],
        stateMetadata: {},
        snapshotHash: 'x',
      }),
    ).rejects.toThrow(/not available on linux/);
    await expect(adapter.verifyAppliedRules(plan)).rejects.toThrow(/not available on linux/);
    await expect(adapter.clearAppliedRules()).rejects.toThrow(/not available on linux/);
  });

  it('Windows firewall rejection carries FIREWALL_PLATFORM_UNSUPPORTED', async () => {
    const adapter = new WindowsFirewallAdapter();
    const err = await adapter.isElevated().then(
      () => null,
      (e: unknown) => e as { code?: string },
    );
    expect(err?.code).toBe(FIREWALL_ERROR_CODES.FIREWALL_PLATFORM_UNSUPPORTED);
    expect(FIREWALL_ERROR_CODES.FIREWALL_PLATFORM_UNSUPPORTED).toBe('FIREWALL_PLATFORM_UNSUPPORTED');
  });

  it('WindowsSocketObserver constructs without side effects but both live methods reject honestly', async () => {
    const observer = new WindowsSocketObserver();
    expect(observer.platformName).toBe('windows');
    await expect(observer.captureActiveSockets()).rejects.toThrow(/not available on linux/);
    await expect(observer.resolveProcessMetadata(1)).rejects.toThrow(/not available on linux/);
  });

  it('Windows socket rejection carries OBSERVER_ADAPTER_ERROR', async () => {
    const observer = new WindowsSocketObserver();
    const err = await observer.captureActiveSockets().then(
      () => null,
      (e: unknown) => e as { code?: string },
    );
    expect(err?.code).toBe(NETWORK_MONITOR_ERROR_CODES.OBSERVER_ADAPTER_ERROR);
  });

  it('platform factories auto-select the Linux adapters on linux', () => {
    expect(createPlatformFirewallAdapter().platformName).toBe('linux');
    expect(createPlatformSocketObserver().platformName).toBe('linux');
  });

  it('default Rust engine path resolves without .exe on linux', () => {
    const enginePath = getDefaultEnginePath('/tmp/probe-project');
    expect(enginePath).toBe(path.resolve('/tmp/probe-project', 'rust', 'target', 'release', 'maos-engine'));
    expect(enginePath.endsWith('.exe')).toBe(false);
  });

  it('T-07 scan PDF text layer extracts deterministically on linux (no OCR engine)', () => {
    const projectRoot = path.resolve(__dirname, '../../');
    const tool = createOcrDocumentTool({});
    const out = tool.execute(
      {
        projectRoot,
        evidenceRoot: path.join(projectRoot, 'demo', 'industrial'),
        runId: 'linux-text-layer-proof',
        runContext: {},
      },
      { path: 'turbine_inspection_scan.pdf' },
    ) as Record<string, unknown>;
    expect(out.ok).toBe(true);
    expect(out.method).toBe('text-layer');
    expect(typeof out.text === 'string' && out.text.length).toBeGreaterThan(0);
  });
});
