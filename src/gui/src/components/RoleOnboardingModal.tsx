import React, { useState, useEffect, useRef } from 'react';
import {
  RolePreset,
  ALL_ROLE_PRESETS,
  ROLE_PRESET_CONFIGS,
} from '../../../domain/layout';
import { useLayout } from './LayoutContext';
import { ShieldIcon, CloseIcon } from './icons';

export const RoleOnboardingModal: React.FC = () => {
  const { needsOnboarding, completeOnboarding, dismissOnboarding } = useLayout();
  const [selectedRole, setSelectedRole] = useState<RolePreset>('developer');
  const dialogRef = useRef<HTMLDivElement>(null);

  // Trap focus inside modal when open
  useEffect(() => {
    if (needsOnboarding && dialogRef.current) {
      dialogRef.current.focus();
    }
  }, [needsOnboarding]);

  // Keyboard shortcut: Escape to dismiss with developer default
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!needsOnboarding) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        dismissOnboarding();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [needsOnboarding, dismissOnboarding]);

  if (!needsOnboarding) {
    return null;
  }

  const handleConfirm = () => {
    completeOnboarding(selectedRole);
  };

  return (
    <div
      className="modal-overlay"
      data-testid="role-onboarding-modal"
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
        padding: 16,
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="role-onboarding-title"
        aria-describedby="role-onboarding-desc"
        tabIndex={-1}
        style={{
          backgroundColor: 'var(--surface, #1e1e1e)',
          border: '1px solid var(--border, #333)',
          borderRadius: 8,
          maxWidth: 640,
          width: '100%',
          padding: 24,
          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)',
          color: 'var(--foreground, #eee)',
          outline: 'none',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <ShieldIcon size={24} />
            <h2 id="role-onboarding-title" style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>
              Select Initial Workspace Role
            </h2>
          </div>
          <button
            onClick={dismissOnboarding}
            aria-label="Close and use default Developer role"
            className="btn-icon"
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--muted, #888)',
              cursor: 'pointer',
              padding: 4,
            }}
          >
            <CloseIcon size={20} />
          </button>
        </div>

        <p id="role-onboarding-desc" style={{ fontSize: 13, color: 'var(--muted, #aaa)', marginBottom: 20 }}>
          Welcome to MAOS. Select your primary role preset to tailor pinned modules, active panels, and drawer defaults.
          You can change this anytime in Settings.
        </p>

        <div
          role="radiogroup"
          aria-label="Available role presets"
          style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 20 }}
        >
          {ALL_ROLE_PRESETS.map((preset) => {
            const config = ROLE_PRESET_CONFIGS[preset];
            const isSelected = selectedRole === preset;
            return (
              <div
                key={preset}
                role="radio"
                aria-checked={isSelected}
                tabIndex={0}
                onClick={() => setSelectedRole(preset)}
                onKeyDown={(e) => {
                  if (e.key === ' ' || e.key === 'Enter') {
                    e.preventDefault();
                    setSelectedRole(preset);
                  }
                }}
                data-testid={`role-option-${preset}`}
                style={{
                  padding: 12,
                  borderRadius: 6,
                  border: isSelected
                    ? '2px solid var(--accent, #007acc)'
                    : '1px solid var(--border, #333)',
                  backgroundColor: isSelected
                    ? 'var(--surface-active, rgba(0, 122, 204, 0.15))'
                    : 'var(--surface-card, #252526)',
                  cursor: 'pointer',
                  outline: 'none',
                  transition: 'border-color 0.15s ease',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>
                    {config.displayName}
                    {preset === 'developer' && (
                      <span
                        style={{
                          marginLeft: 8,
                          fontSize: 10,
                          padding: '2px 6px',
                          borderRadius: 3,
                          backgroundColor: 'var(--border, #444)',
                          color: 'var(--muted, #aaa)',
                        }}
                      >
                        Default
                      </span>
                    )}
                  </div>
                  <input
                    type="radio"
                    name="role-preset"
                    checked={isSelected}
                    onChange={() => setSelectedRole(preset)}
                    tabIndex={-1}
                    aria-hidden="true"
                    style={{ cursor: 'pointer' }}
                  />
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted, #aaa)', marginTop: 4 }}>
                  {config.description}
                </div>
                <div style={{ fontSize: 11, color: 'var(--muted, #888)', marginTop: 6 }}>
                  Pinned: <code>{config.pinnedModules.join(', ')}</code>
                </div>
              </div>
            );
          })}
        </div>

        {/* Safety Boundary Notice */}
        <div
          style={{
            fontSize: 11,
            color: 'var(--muted, #888)',
            backgroundColor: 'var(--surface-card, #252526)',
            border: '1px solid var(--border, #333)',
            padding: '10px 12px',
            borderRadius: 4,
            marginBottom: 20,
          }}
        >
          <strong>Industrial Safety Boundary:</strong> Role presets configure presentation only.
          Changing roles does not alter backend authorization, sandbox policies, approval gates, or project scoping.
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
          <button
            type="button"
            className="btn-secondary"
            onClick={dismissOnboarding}
            aria-label="Skip onboarding and use default developer preset"
          >
            Skip (Use Developer)
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={handleConfirm}
            aria-label={`Confirm selection of ${ROLE_PRESET_CONFIGS[selectedRole].displayName}`}
          >
            Apply Role Preset
          </button>
        </div>
      </div>
    </div>
  );
};
