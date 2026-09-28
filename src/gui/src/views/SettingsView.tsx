import React, { useState, useEffect } from 'react';
import { SettingsIcon } from '../components/icons';
import { useTheme } from '../components/ThemeContext';
import { useLayout } from '../components/LayoutContext';
import { ALL_ROLE_PRESETS, ROLE_PRESET_CONFIGS } from '../../../domain/layout';
import { apiAdapter } from '../api';
import {
  BasicSettings,
  getDefaultBasicSettings,
  SETTINGS_BOUNDS,
  validateBasicSettings,
} from '../../../domain/settings';
import type { RetentionStatus, PurgeResult } from '../../../domain/evidence-mode';
import { LifecyclePanel } from '../components/LifecyclePanel';

export const SettingsView: React.FC = () => {
  const {
    theme,
    setTheme,
    reducedMotion,
    setReducedMotion,
    fontScale,
    setFontScale,
    density,
    setDensity,
    applyAccessibility,
  } = useTheme();
  const { role, setRole, resetToDefault } = useLayout();

  // Settings state
  const [settings, setSettings] = useState<BasicSettings>(() => getDefaultBasicSettings('default'));
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Retention and Purge state
  const [retentionStatus, setRetentionStatus] = useState<RetentionStatus | null>(null);
  const [purgeResult, setPurgeResult] = useState<PurgeResult | null>(null);
  const [isPurging, setIsPurging] = useState<boolean>(false);
  const [isPurgeModalOpen, setIsPurgeModalOpen] = useState<boolean>(false);

  // Force stop confirmation modal
  const [isForceStopModalOpen, setIsForceStopModalOpen] = useState<boolean>(false);
  const [forceStopConfirmText, setForceStopConfirmText] = useState<string>('');
  const [serviceActionStatus, setServiceActionStatus] = useState<string | null>(null);

  // Sovereignty visibility state
  const [visibility, setVisibility] = useState<{
    loopbackEndpoint: string;
    instanceIdRedacted: string;
    modelInfo: { residentModels: string[]; totalConfigured: number };
    rustEngineHealth: boolean;
    sovereigntyStatus: Record<string, unknown>;
    projectRoot: string;
    canonicalPath: string;
  } | null>(null);

  // Load initial settings, visibility, and retention status on mount
  const refreshRetentionStatus = async () => {
    try {
      const status = await apiAdapter.getRetentionStatus();
      setRetentionStatus(status);
    } catch {
      // Ignore retention status error if offline or uninitialized
    }
  };

  useEffect(() => {
    let mounted = true;
    async function load() {
      try {
        const [basic, vis, ret] = await Promise.all([
          apiAdapter.getBasicSettings().catch(() => getDefaultBasicSettings('default')),
          apiAdapter.getServiceVisibility().catch(() => null),
          apiAdapter.getRetentionStatus().catch(() => null),
        ]);
        if (mounted) {
          setSettings(basic);
          if (basic.accessibility) {
            applyAccessibility(basic.accessibility);
          }
          if (vis) {
            setVisibility(vis as any);
          }
          if (ret) {
            setRetentionStatus(ret);
          }
        }
      } catch (err: any) {
        if (mounted) {
          setStatusMessage({ type: 'error', text: `Failed to load settings: ${err.message}` });
        }
      } finally {
        if (mounted) setIsLoading(false);
      }
    }
    load();
    return () => {
      mounted = false;
    };
  }, []);

  const handlePreviewPurge = async () => {
    setIsPurging(true);
    try {
      const res = await apiAdapter.executeRetentionPurge({ target: 'all_expired', dryRun: true });
      setPurgeResult(res);
      await refreshRetentionStatus();
      setStatusMessage({ type: 'success', text: `Dry-run purge preview: ${res.purgedConversations} conversation(s) and ${res.purgedArtifactPreviews} preview cache(s) eligible for purge.` });
    } catch (err: any) {
      setStatusMessage({ type: 'error', text: `Purge preview error: ${err.message}` });
    } finally {
      setIsPurging(false);
    }
  };

  const handleExecutePurge = async () => {
    setIsPurging(true);
    try {
      const res = await apiAdapter.executeRetentionPurge({ target: 'all_expired', dryRun: false });
      setPurgeResult(res);
      setIsPurgeModalOpen(false);
      await refreshRetentionStatus();
      setStatusMessage({
        type: 'success',
        text: `Purge executed: ${res.purgedConversations} conversation(s) and ${res.purgedArtifactPreviews} preview cache(s) safely deleted. Audit log recorded.`,
      });
    } catch (err: any) {
      setStatusMessage({ type: 'error', text: `Purge execution error: ${err.message}` });
    } finally {
      setIsPurging(false);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    setStatusMessage(null);
    try {
      const candidate: BasicSettings = {
        ...settings,
        accessibility: {
          theme,
          reducedMotion,
          fontScale,
          density,
        },
      };

      const validation = validateBasicSettings(candidate);
      if (!validation.valid) {
        setStatusMessage({
          type: 'error',
          text: `Validation failed: ${validation.errors?.join('; ') || 'Invalid settings'}`,
        });
        setIsSaving(false);
        return;
      }

      const updated = await apiAdapter.updateBasicSettings(candidate);
      setSettings(updated);
      applyAccessibility(updated.accessibility);
      setStatusMessage({ type: 'success', text: 'Settings saved and applied successfully.' });
    } catch (err: any) {
      setStatusMessage({ type: 'error', text: `Save error: ${err.message || 'Unknown error'}` });
    } finally {
      setIsSaving(false);
    }
  };

  const handleResetDefaults = async () => {
    setIsSaving(true);
    setStatusMessage(null);
    try {
      const defaults = await apiAdapter.resetSettings(settings.projectId);
      setSettings(defaults);
      applyAccessibility(defaults.accessibility);
      setStatusMessage({ type: 'success', text: 'Settings reset to canonical industrial defaults.' });
    } catch (err: any) {
      setStatusMessage({ type: 'error', text: `Reset error: ${err.message || 'Unknown error'}` });
    } finally {
      setIsSaving(false);
    }
  };

  const handleStopGraceful = async () => {
    setServiceActionStatus('Requesting graceful stop after current tasks...');
    try {
      const result = await apiAdapter.stopService({ mode: 'after-current-tasks' });
      setServiceActionStatus(
        result.status === 'stopping_after_tasks'
          ? `Service will stop once ${result.activeTasksCount ?? 0} active task(s) finish.`
          : 'Service stopped.',
      );
    } catch (err: any) {
      setServiceActionStatus(`Graceful stop error: ${err.message}`);
    }
  };

  const handleForceStop = async () => {
    if (forceStopConfirmText.trim().toUpperCase() !== 'CONFIRM') {
      setStatusMessage({ type: 'error', text: 'You must type "CONFIRM" to execute a force stop.' });
      return;
    }
    setServiceActionStatus('Executing force stop...');
    try {
      const result = await apiAdapter.stopService({
        mode: 'force',
        confirm: true,
        reason: 'Force stopped by operator from GUI Settings',
      });
      setIsForceStopModalOpen(false);
      setForceStopConfirmText('');
      setServiceActionStatus(
        `Force stop completed. ${result.interruptedTasksCount ?? 0} active task(s) marked INTERRUPTED, ${result.cleanedTempArtifacts ?? 0} temp artifact(s) cleaned, and audit event recorded.`,
      );
    } catch (err: any) {
      setServiceActionStatus(`Force stop error: ${err.message}`);
    }
  };

  return (
    <div className="view-container" role="tabpanel" aria-label="Settings View">
      <div className="view-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <SettingsIcon size={24} className="state-icon" />
          <h1 className="view-title">Settings & Industrial Preferences</h1>
        </div>
        <p className="view-desc">
          Retention rules, GPU idle model management, accessibility preferences, and local sovereignty visibility.
        </p>
      </div>

      {statusMessage && (
        <div
          role="alert"
          style={{
            padding: '10px 14px',
            marginBottom: 16,
            borderRadius: 6,
            backgroundColor:
              statusMessage.type === 'success'
                ? 'rgba(34, 197, 94, 0.15)'
                : 'rgba(239, 68, 68, 0.15)',
            border: `1px solid ${
              statusMessage.type === 'success' ? 'var(--status-green, #22c55e)' : 'var(--status-red, #ef4444)'
            }`,
            color: statusMessage.type === 'success' ? 'var(--status-green, #22c55e)' : 'var(--status-red, #ef4444)',
            fontSize: 13,
          }}
        >
          {statusMessage.text}
        </div>
      )}

      {serviceActionStatus && (
        <div
          style={{
            padding: '10px 14px',
            marginBottom: 16,
            borderRadius: 6,
            backgroundColor: 'rgba(59, 130, 246, 0.15)',
            border: '1px solid var(--status-blue, #3b82f6)',
            color: 'var(--status-blue, #3b82f6)',
            fontSize: 13,
          }}
        >
          {serviceActionStatus}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16 }}>
        {/* Section 1: Retention & Redaction */}
        <div className="state-box" style={{ alignItems: 'flex-start', textAlign: 'left' }}>
          <div className="state-title">1. Retention & Redaction</div>
          <p className="state-message">
            Configure local retention periods and preview redactions.
          </p>

          <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 12, marginTop: 8 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
              Conversation Retention (days) [1 - 365]:
              <input
                type="number"
                min={SETTINGS_BOUNDS.RETENTION_DAYS_MIN}
                max={SETTINGS_BOUNDS.RETENTION_DAYS_MAX}
                value={settings.retention.conversationDays}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    retention: {
                      ...settings.retention,
                      conversationDays: parseInt(e.target.value, 10) || 1,
                    },
                  })
                }
                data-testid="input-conversation-days"
              />
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
              Event Display Retention (days) [1 - 365]:
              <input
                type="number"
                min={SETTINGS_BOUNDS.RETENTION_DAYS_MIN}
                max={SETTINGS_BOUNDS.RETENTION_DAYS_MAX}
                value={settings.retention.eventDisplayDays}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    retention: {
                      ...settings.retention,
                      eventDisplayDays: parseInt(e.target.value, 10) || 1,
                    },
                  })
                }
                data-testid="input-event-display-days"
              />
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
              Artifact Preview Retention (days) [1 - 365]:
              <input
                type="number"
                min={SETTINGS_BOUNDS.RETENTION_DAYS_MIN}
                max={SETTINGS_BOUNDS.RETENTION_DAYS_MAX}
                value={settings.retention.artifactPreviewDays}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    retention: {
                      ...settings.retention,
                      artifactPreviewDays: parseInt(e.target.value, 10) || 1,
                    },
                  })
                }
                data-testid="input-artifact-preview-days"
              />
            </label>

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={settings.retention.redactSensitivePreviews}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    retention: {
                      ...settings.retention,
                      redactSensitivePreviews: e.target.checked,
                    },
                  })
                }
                data-testid="input-redact-sensitive"
              />
              Redact sensitive tokens and passwords in UI previews
            </label>

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={settings.retention.allowRawEvidencePreviews}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    retention: {
                      ...settings.retention,
                      allowRawEvidencePreviews: e.target.checked,
                    },
                  })
                }
                data-testid="input-allow-raw-evidence"
              />
              Allow raw evidence previews in current profile
            </label>

            {/* Scoped Purge Actions & Status */}
            <div
              style={{
                marginTop: 12,
                padding: 10,
                borderRadius: 4,
                backgroundColor: 'rgba(255, 255, 255, 0.03)',
                border: '1px solid var(--border)',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary, #fff)' }}>
                Scoped Local Purge (UI1-10)
              </div>
              <p style={{ fontSize: 11, color: 'var(--text-muted, #888)', margin: 0 }}>
                Clean expired unpinned conversations and preview files according to retention windows.
              </p>

              {retentionStatus && (
                <div style={{ fontSize: 11, color: 'var(--text-secondary, #ccc)', lineHeight: 1.4 }}>
                  <div>• Expired conversations: <strong>{retentionStatus.expiredConversations}</strong> (of {retentionStatus.totalConversations})</div>
                  <div>• Expired preview files: <strong>{retentionStatus.expiredArtifactPreviews}</strong> (of {retentionStatus.totalArtifactPreviews})</div>
                  <div>• Expired event records: <strong>{retentionStatus.expiredEventDisplayRecords}</strong> (of {retentionStatus.totalEventDisplayRecords})</div>
                  <div>• Immutable audit logs: <strong>{retentionStatus.immutableAuditRecordCount}</strong> | Final deliverables: <strong>{retentionStatus.immutableDeliverableCount}</strong></div>
                  <div>• Est. reclaimable space: <strong>{(retentionStatus.estimatedReclaimableBytes / 1024).toFixed(1)} KB</strong></div>
                </div>
              )}

              {purgeResult && (
                <div
                  style={{
                    fontSize: 11,
                    padding: '6px 8px',
                    borderRadius: 4,
                    backgroundColor: purgeResult.dryRun ? 'rgba(59, 130, 246, 0.1)' : 'rgba(34, 197, 94, 0.1)',
                    border: `1px solid ${purgeResult.dryRun ? 'var(--status-blue, #3b82f6)' : 'var(--status-green, #22c55e)'}`,
                    color: purgeResult.dryRun ? 'var(--status-blue, #3b82f6)' : 'var(--status-green, #22c55e)',
                  }}
                >
                  <strong>{purgeResult.dryRun ? 'Dry-Run Result:' : 'Purge Complete:'}</strong>{' '}
                  {purgeResult.purgedConversations} conversation(s), {purgeResult.purgedArtifactPreviews} preview(s) processed (freed {(purgeResult.freedBytes / 1024).toFixed(1)} KB).
                </div>
              )}

              <div style={{ display: 'flex', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={handlePreviewPurge}
                  disabled={isPurging}
                  style={{ fontSize: 11, padding: '4px 10px' }}
                  data-testid="btn-preview-purge"
                >
                  {isPurging ? 'Scanning...' : 'Preview Purge (Dry Run)'}
                </button>
                <button
                  type="button"
                  onClick={() => setIsPurgeModalOpen(true)}
                  disabled={isPurging}
                  style={{
                    fontSize: 11,
                    padding: '4px 10px',
                    borderRadius: 4,
                    backgroundColor: 'rgba(239, 68, 68, 0.15)',
                    border: '1px solid var(--status-red, #ef4444)',
                    color: 'var(--status-red, #ef4444)',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                  data-testid="btn-open-execute-purge"
                >
                  Execute Purge...
                </button>
              </div>
            </div>

            <div
              style={{
                fontSize: 11,
                color: 'var(--text-muted, #888)',
                borderTop: '1px solid var(--border)',
                paddingTop: 8,
              }}
            >
              <strong>Safety Invariant:</strong> Mandatory audit persistence (<code>.maos/audit/</code>) and finalized deliverables (<code>*.docx, *.xlsx, *.pptx</code>) are strictly immutable and never purged.
            </div>
          </div>
        </div>

        {/* Section 2: Runtime & Idle Model Behavior */}
        <div className="state-box" style={{ alignItems: 'flex-start', textAlign: 'left' }}>
          <div className="state-title">2. Runtime & Idle Model Behavior</div>
          <p className="state-message">
            Manage GPU model unload timeouts and service shutdown policies.
          </p>

          <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 12, marginTop: 8 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
              GPU Model Unload Timeout (seconds) [30 - 86400]:
              <input
                type="number"
                min={SETTINGS_BOUNDS.MODEL_UNLOAD_SECONDS_MIN}
                max={SETTINGS_BOUNDS.MODEL_UNLOAD_SECONDS_MAX}
                value={settings.runtime.modelUnloadAfterSeconds}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    runtime: {
                      ...settings.runtime,
                      modelUnloadAfterSeconds: parseInt(e.target.value, 10) || 30,
                    },
                  })
                }
                data-testid="input-model-unload-seconds"
              />
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
              Service Idle Grace Period (seconds) [60 - 86400]:
              <input
                type="number"
                min={SETTINGS_BOUNDS.SERVICE_STOP_SECONDS_MIN}
                max={SETTINGS_BOUNDS.SERVICE_STOP_SECONDS_MAX}
                value={settings.runtime.serviceStopAfterSeconds}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    runtime: {
                      ...settings.runtime,
                      serviceStopAfterSeconds: parseInt(e.target.value, 10) || 60,
                    },
                  })
                }
                data-testid="input-service-stop-seconds"
              />
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
              Default Stop Mode:
              <select
                value={settings.runtime.stopMode}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    runtime: {
                      ...settings.runtime,
                      stopMode: e.target.value as any,
                    },
                  })
                }
                data-testid="select-stop-mode"
              >
                <option value="after-current-tasks">Stop After Current Tasks (Graceful)</option>
                <option value="force">Force Stop (Requires Confirmation)</option>
              </select>
            </label>

            <div style={{ display: 'flex', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
              <button
                className="btn-secondary"
                onClick={handleStopGraceful}
                data-testid="btn-stop-graceful"
              >
                Stop After Tasks
              </button>
              <button
                style={{
                  padding: '6px 14px',
                  borderRadius: 4,
                  backgroundColor: 'rgba(239, 68, 68, 0.2)',
                  border: '1px solid var(--status-red, #ef4444)',
                  color: 'var(--status-red, #ef4444)',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
                onClick={() => setIsForceStopModalOpen(true)}
                data-testid="btn-open-force-stop"
              >
                Force Stop Service...
              </button>
            </div>
          </div>
        </div>

        {/* Section 3: Accessibility & Display */}
        <div className="state-box" style={{ alignItems: 'flex-start', textAlign: 'left' }}>
          <div className="state-title">3. Accessibility & Display</div>
          <p className="state-message">
            Visual presentation, contrast themes, reduced motion, and text scaling.
          </p>

          <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 12, marginTop: 8 }}>
            <div>
              <div style={{ fontSize: 12, marginBottom: 6 }}>Theme & Contrast:</div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  style={{
                    padding: '6px 14px',
                    border: '1px solid var(--border)',
                    borderRadius: 4,
                    backgroundColor: theme === 'dark' ? 'var(--surface-active)' : 'var(--surface)',
                    fontWeight: theme === 'dark' ? 600 : 400,
                  }}
                  onClick={() => setTheme('dark')}
                  data-testid="btn-theme-dark"
                >
                  Monochrome Dark
                </button>
                <button
                  style={{
                    padding: '6px 14px',
                    border: '1px solid var(--border)',
                    borderRadius: 4,
                    backgroundColor: theme === 'high-contrast' ? 'var(--surface-active)' : 'var(--surface)',
                    fontWeight: theme === 'high-contrast' ? 600 : 400,
                  }}
                  onClick={() => setTheme('high-contrast')}
                  data-testid="btn-theme-high-contrast"
                >
                  High-Contrast (AAA)
                </button>
              </div>
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={reducedMotion}
                onChange={(e) => setReducedMotion(e.target.checked)}
                data-testid="input-reduced-motion"
              />
              Reduced Motion (disables transitions & animations)
            </label>

            <div>
              <div style={{ fontSize: 12, marginBottom: 6 }}>Font Scale: {fontScale.toFixed(1)}x</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {[0.8, 1.0, 1.2, 1.5, 2.0].map((scale) => (
                  <button
                    key={scale}
                    style={{
                      padding: '4px 10px',
                      borderRadius: 4,
                      border: '1px solid var(--border)',
                      backgroundColor: Math.abs(fontScale - scale) < 0.05 ? 'var(--surface-active)' : 'var(--surface)',
                      fontSize: 12,
                    }}
                    onClick={() => setFontScale(scale)}
                    data-testid={`btn-font-scale-${scale}`}
                  >
                    {scale}x
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div style={{ fontSize: 12, marginBottom: 6 }}>Layout Density:</div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  style={{
                    padding: '6px 14px',
                    border: '1px solid var(--border)',
                    borderRadius: 4,
                    backgroundColor: density === 'comfortable' ? 'var(--surface-active)' : 'var(--surface)',
                    fontWeight: density === 'comfortable' ? 600 : 400,
                  }}
                  onClick={() => setDensity('comfortable')}
                  data-testid="btn-density-comfortable"
                >
                  Comfortable
                </button>
                <button
                  style={{
                    padding: '6px 14px',
                    border: '1px solid var(--border)',
                    borderRadius: 4,
                    backgroundColor: density === 'compact' ? 'var(--surface-active)' : 'var(--surface)',
                    fontWeight: density === 'compact' ? 600 : 400,
                  }}
                  onClick={() => setDensity('compact')}
                  data-testid="btn-density-compact"
                >
                  Compact
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Section 4: Local Endpoint & Sovereignty Visibility */}
        <div className="state-box" style={{ alignItems: 'flex-start', textAlign: 'left' }}>
          <div className="state-title">4. Endpoint & Sovereignty Visibility</div>
          <p className="state-message">
            Strict loopback confinement. Tokens and credentials are never exposed.
          </p>

          <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12, marginTop: 8 }}>
            <div>
              <strong>Loopback Endpoint: </strong>
              <code>{visibility?.loopbackEndpoint || 'http://127.0.0.1 (Loopback Only)'}</code>
            </div>
            <div>
              <strong>Instance ID: </strong>
              <code>{visibility?.instanceIdRedacted || 'inst-...'}</code>
            </div>
            <div>
              <strong>Rust Engine Health: </strong>
              <span
                style={{
                  color: visibility?.rustEngineHealth ? 'var(--status-green, #22c55e)' : 'var(--text-muted, #888)',
                  fontWeight: 600,
                }}
              >
                {visibility?.rustEngineHealth ? 'VERIFIED (SHA-256 Valid)' : 'NOT PRESENT / INERT'}
              </span>
            </div>
            <div>
              <strong>Model Residency: </strong>
              <span>
                {visibility?.modelInfo?.residentModels.length ?? 0} resident /{' '}
                {visibility?.modelInfo?.totalConfigured ?? 0} configured
              </span>
            </div>
            <div>
              <strong>Project Root: </strong>
              <code style={{ fontSize: 11 }}>{visibility?.canonicalPath || settings.projectId}</code>
            </div>
            <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <span className="state-badge">LOOPBACK: 127.0.0.1 ONLY</span>
              <span className="state-badge">ZERO REMOTE LEAKAGE</span>
            </div>
          </div>
        </div>

        {/* Section 5: Role Presets & Presentation (UI1-07) */}
        <div className="state-box" style={{ alignItems: 'flex-start', textAlign: 'left', gridColumn: '1 / -1' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
            <div className="state-title" style={{ margin: 0 }}>5. Workspace Role Presets & Layout</div>
            <button
              className="btn-secondary"
              onClick={resetToDefault}
              aria-label="Reset workspace layout to role default"
              data-testid="reset-layout-btn"
            >
              Reset Layout to Role Default
            </button>
          </div>
          <p className="state-message" style={{ margin: '8px 0 16px 0' }}>
            Choose a role preset to customize navigation order and context drawer defaults.
            <strong> Safety Boundary:</strong> Role presets customize presentation only and never alter backend authorization, permissions, or approval requirements.
          </p>

          <div
            role="radiogroup"
            aria-label="Workspace role presets"
            style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12, width: '100%' }}
          >
            {ALL_ROLE_PRESETS.map((preset) => {
              const config = ROLE_PRESET_CONFIGS[preset];
              const isSelected = role === preset;
              return (
                <div
                  key={preset}
                  role="radio"
                  aria-checked={isSelected}
                  tabIndex={0}
                  onClick={() => setRole(preset)}
                  onKeyDown={(e) => {
                    if (e.key === ' ' || e.key === 'Enter') {
                      e.preventDefault();
                      setRole(preset);
                    }
                  }}
                  data-testid={`settings-role-${preset}`}
                  style={{
                    padding: 14,
                    borderRadius: 6,
                    border: isSelected
                      ? '2px solid var(--accent, #007acc)'
                      : '1px solid var(--border, #333)',
                    backgroundColor: isSelected
                      ? 'var(--surface-active, rgba(0, 122, 204, 0.15))'
                      : 'var(--surface, #1e1e1e)',
                    cursor: 'pointer',
                    outline: 'none',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{config.displayName}</div>
                    <span
                      className="state-badge"
                      style={{
                        backgroundColor: isSelected ? 'var(--accent, #007acc)' : 'transparent',
                        color: isSelected ? '#fff' : 'var(--muted, #888)',
                        border: '1px solid var(--border, #444)',
                        fontSize: 10,
                        padding: '1px 6px',
                      }}
                    >
                      {isSelected ? 'ACTIVE' : 'SELECT'}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--muted, #aaa)', lineHeight: 1.4 }}>
                    {config.description}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Section 6: Service Lifecycle & Recovery Controls (UI1-19) */}
      <div
        className="state-box"
        style={{
          textAlign: 'left',
          alignItems: 'flex-start',
          padding: 20,
          marginTop: 20,
          backgroundColor: 'var(--surface-elevated, #1a1a1a)',
        }}
      >
        <LifecyclePanel />
      </div>

      {/* Global Actions Bar */}
      <div
        style={{
          marginTop: 24,
          padding: 16,
          borderTop: '1px solid var(--border)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 12,
        }}
      >
        <button
          className="btn-secondary"
          onClick={handleResetDefaults}
          disabled={isSaving}
          data-testid="btn-reset-defaults"
        >
          Reset Settings to Defaults
        </button>

        <div style={{ display: 'flex', gap: 12 }}>
          <button
            className="btn-primary"
            onClick={handleSave}
            disabled={isSaving}
            data-testid="btn-save-settings"
            style={{
              padding: '8px 20px',
              backgroundColor: 'var(--primary, #ffffff)',
              color: 'var(--primary-contrast, #000000)',
              fontWeight: 600,
              borderRadius: 4,
            }}
          >
            {isSaving ? 'Saving...' : 'Save Settings'}
          </button>
        </div>
      </div>

      {/* Force Stop Confirmation Modal */}
      {isForceStopModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="force-stop-title"
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.75)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: 20,
          }}
        >
          <div
            className="state-box"
            style={{
              maxWidth: 480,
              width: '100%',
              backgroundColor: 'var(--surface-elevated, #1a1a1a)',
              border: '2px solid var(--status-red, #ef4444)',
              textAlign: 'left',
              alignItems: 'flex-start',
              padding: 20,
            }}
          >
            <h2 id="force-stop-title" style={{ fontSize: 16, color: 'var(--status-red, #ef4444)', marginBottom: 8 }}>
              Confirm Immediate Force Stop
            </h2>
            <p style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 12 }}>
              Force stop terminates the running process immediately. Active tasks will be marked as{' '}
              <strong>INTERRUPTED</strong> to prevent phantom success. Partial artifacts will be cleaned up, and a tamper-evident audit record will be logged.
            </p>
            <p style={{ fontSize: 12, color: 'var(--text-muted, #888)', marginBottom: 8 }}>
              Type <code>CONFIRM</code> to execute force stop:
            </p>
            <input
              type="text"
              value={forceStopConfirmText}
              onChange={(e) => setForceStopConfirmText(e.target.value)}
              placeholder="CONFIRM"
              style={{ width: '100%', marginBottom: 16 }}
              data-testid="input-force-stop-confirm"
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, width: '100%' }}>
              <button
                className="btn-secondary"
                onClick={() => {
                  setIsForceStopModalOpen(false);
                  setForceStopConfirmText('');
                }}
                data-testid="btn-cancel-force-stop"
              >
                Cancel
              </button>
              <button
                style={{
                  padding: '6px 14px',
                  borderRadius: 4,
                  backgroundColor: 'var(--status-red, #ef4444)',
                  color: '#fff',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
                onClick={handleForceStop}
                disabled={forceStopConfirmText.trim().toUpperCase() !== 'CONFIRM'}
                data-testid="btn-confirm-force-stop"
              >
                Execute Force Stop
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Purge Confirmation Modal */}
      {isPurgeModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="purge-modal-title"
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.75)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: 20,
          }}
        >
          <div
            className="state-box"
            style={{
              maxWidth: 480,
              width: '100%',
              backgroundColor: 'var(--surface-elevated, #1a1a1a)',
              border: '2px solid var(--status-red, #ef4444)',
              textAlign: 'left',
              alignItems: 'flex-start',
              padding: 20,
            }}
          >
            <h2 id="purge-modal-title" style={{ fontSize: 16, color: 'var(--status-red, #ef4444)', marginBottom: 8 }}>
              Confirm Scoped Retention Purge
            </h2>
            <p style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 12 }}>
              Executing this purge will permanently delete unpinned conversations and temporary preview cache files older than your configured retention window.
            </p>
            <p style={{ fontSize: 12, color: 'var(--text-muted, #888)', marginBottom: 16 }}>
              <strong>Protected Assets:</strong> Pinned conversations, conversations with associated tasks, append-only audit records in <code>.maos/audit/</code>, and finalized deliverables (Word, Excel, PowerPoint) will <strong>NEVER</strong> be purged.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, width: '100%' }}>
              <button
                className="btn-secondary"
                onClick={() => setIsPurgeModalOpen(false)}
                data-testid="btn-cancel-purge"
              >
                Cancel
              </button>
              <button
                style={{
                  padding: '6px 14px',
                  borderRadius: 4,
                  backgroundColor: 'var(--status-red, #ef4444)',
                  color: '#fff',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
                onClick={handleExecutePurge}
                disabled={isPurging}
                data-testid="btn-confirm-purge"
              >
                {isPurging ? 'Purging...' : 'Execute Scoped Purge'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
