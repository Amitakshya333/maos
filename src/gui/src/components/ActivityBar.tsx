import React, { useState, useRef, useEffect } from 'react';
import {
  ChatIcon,
  TasksIcon,
  AgentsIcon,
  EvidenceIcon,
  ArtifactsIcon,
  AuditIcon,
  ModelsIcon,
  SettingsIcon,
  CodeIcon,
  TerminalIcon,
  CockpitIcon,
  FindingsIcon,
  DrawingIcon,
  DocumentsIcon,
  KnowledgeIcon,
  ApprovalsIcon,
  SandboxIcon,
  PlusIcon,
} from './icons';
import { useLayout } from './LayoutContext';
import { ALL_MODULE_IDS, ModuleId } from '../../../domain/layout';

export type ActiveView =
  | ModuleId
  | 'agents';

interface ActivityBarProps {
  activeView: ActiveView;
  onSelectView: (view: ActiveView) => void;
}

interface NavConfig {
  label: string;
  icon: React.ReactNode;
}

const MODULE_REGISTRY: Record<string, NavConfig> = {
  chat: { label: 'Chat & Sessions', icon: <ChatIcon size={20} /> },
  tasks: { label: 'Tasks & Runs', icon: <TasksIcon size={20} /> },
  code: { label: 'Code & Sandbox', icon: <CodeIcon size={20} /> },
  terminal: { label: 'Terminal / Shell', icon: <TerminalIcon size={20} /> },
  cockpit: { label: 'Agent Cockpit', icon: <CockpitIcon size={20} /> },
  evidence: { label: 'Evidence Workbench', icon: <EvidenceIcon size={20} /> },
  findings: { label: 'Findings & Telemetry', icon: <FindingsIcon size={20} /> },
  documents: { label: 'Document Generator', icon: <DocumentsIcon size={20} /> },
  knowledge: { label: 'Knowledge Search', icon: <KnowledgeIcon size={20} /> },
  drawing: { label: 'Drawing & Viewer', icon: <DrawingIcon size={20} /> },
  artifacts: { label: 'Artifact Store', icon: <ArtifactsIcon size={20} /> },
  approvals: { label: 'Approval Queue', icon: <ApprovalsIcon size={20} /> },
  models: { label: 'Models & Leases', icon: <ModelsIcon size={20} /> },
  sandbox: { label: 'Container Sandbox', icon: <SandboxIcon size={20} /> },
  audit: { label: 'Audit Trail', icon: <AuditIcon size={20} /> },
  agents: { label: 'Industrial Agents', icon: <AgentsIcon size={20} /> },
  settings: { label: 'Settings & Roles', icon: <SettingsIcon size={20} /> },
};

export const ActivityBar: React.FC<ActivityBarProps> = ({ activeView, onSelectView }) => {
  const { pinnedModules, collapsedModules } = useLayout();
  const [isMoreOpen, setIsMoreOpen] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement>(null);

  // Close more menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
        setIsMoreOpen(false);
      }
    };
    if (isMoreOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isMoreOpen]);

  // Display pinned items from layout (fallback to default top items if empty).
  // Every module remains discoverable even when an older or role-specific layout
  // omitted it from both pinnedModules and collapsedModules.
  const effectivePinned = (pinnedModules.length > 0
    ? pinnedModules
    : ['chat', 'tasks', 'agents', 'evidence', 'artifacts', 'audit', 'models']
  ).filter((id) => id !== 'settings' && ALL_MODULE_IDS.includes(id as ModuleId));

  // Collapsed modules are discoverable via "+ More". Append unlisted modules so
  // persisted role layouts can never strand a view behind an inaccessible route.
  const configuredCollapsed = collapsedModules.filter(
    (id) => id !== 'settings' && !effectivePinned.includes(id) && ALL_MODULE_IDS.includes(id as ModuleId),
  );
  const unlistedModules = ALL_MODULE_IDS.filter(
    (id) => id !== 'settings' && !effectivePinned.includes(id) && !configuredCollapsed.includes(id),
  );
  const effectiveCollapsed = [...configuredCollapsed, ...unlistedModules];

  return (
    <aside className="app-activity-bar" role="navigation" aria-label="Activity Bar" style={{ position: 'relative' }}>
      {/* Top Pinned Modules Group */}
      <div className="activity-group" role="tablist" aria-orientation="vertical">
        {effectivePinned.map((moduleId, index) => {
          const config = MODULE_REGISTRY[moduleId] || {
            label: moduleId,
            icon: <CodeIcon size={20} />,
          };
          const isActive = activeView === moduleId;
          const shortcut = index < 7 ? `Alt+${index + 1}` : undefined;
          const labelWithShortcut = shortcut ? `${config.label} (${shortcut})` : config.label;

          return (
            <button
              key={moduleId}
              role="tab"
              aria-selected={isActive}
              aria-label={labelWithShortcut}
              className={`activity-btn ${isActive ? 'active' : ''}`}
              onClick={() => onSelectView(moduleId as ActiveView)}
              title={labelWithShortcut}
              data-testid={`activity-btn-${moduleId}`}
            >
              {config.icon}
            </button>
          );
        })}

        {/* "+ More Modules" button for discoverability */}
        {effectiveCollapsed.length > 0 && (
          <div ref={moreMenuRef} style={{ position: 'relative' }}>
            <button
              role="button"
              aria-haspopup="true"
              aria-expanded={isMoreOpen}
              aria-label="More modules"
              className={`activity-btn ${isMoreOpen ? 'active' : ''}`}
              onClick={() => setIsMoreOpen((prev) => !prev)}
              title="More Modules"
              data-testid="more-modules-btn"
            >
              <PlusIcon size={20} />
            </button>

            {/* Popover Menu for Collapsed Modules */}
            {isMoreOpen && (
              <div
                role="menu"
                aria-label="Secondary modules"
                data-testid="more-modules-popover"
                style={{
                  position: 'absolute',
                  left: '100%',
                  top: 0,
                  marginLeft: 8,
                  backgroundColor: 'var(--surface, #1e1e1e)',
                  border: '1px solid var(--border, #333)',
                  borderRadius: 6,
                  padding: '6px 0',
                  minWidth: 200,
                  boxShadow: '0 4px 16px rgba(0, 0, 0, 0.4)',
                  zIndex: 200,
                }}
              >
                <div
                  style={{
                    padding: '4px 12px',
                    fontSize: 11,
                    fontWeight: 600,
                    color: 'var(--muted, #888)',
                    textTransform: 'uppercase',
                    letterSpacing: 0.5,
                  }}
                >
                  Secondary Modules
                </div>
                {effectiveCollapsed.map((modId) => {
                  const itemConfig = MODULE_REGISTRY[modId] || {
                    label: modId,
                    icon: <CodeIcon size={16} />,
                  };
                  const isItemActive = activeView === modId;
                  return (
                    <button
                      key={modId}
                      role="menuitem"
                      onClick={() => {
                        onSelectView(modId as ActiveView);
                        setIsMoreOpen(false);
                      }}
                      data-testid={`more-module-item-${modId}`}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        width: '100%',
                        padding: '8px 12px',
                        border: 'none',
                        background: isItemActive ? 'var(--surface-active, rgba(0, 122, 204, 0.2))' : 'transparent',
                        color: isItemActive ? 'var(--accent, #007acc)' : 'inherit',
                        cursor: 'pointer',
                        textAlign: 'left',
                        fontSize: 13,
                      }}
                    >
                      {itemConfig.icon}
                      <span>{itemConfig.label}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Bottom Group (Settings & Roles) */}
      <div className="activity-group" role="tablist" aria-orientation="vertical">
        <button
          role="tab"
          aria-selected={activeView === 'settings'}
          aria-label="Settings & Roles (Alt+8)"
          className={`activity-btn ${activeView === 'settings' ? 'active' : ''}`}
          onClick={() => onSelectView('settings')}
          title="Settings & Roles (Alt+8)"
          data-testid="activity-btn-settings"
        >
          <SettingsIcon size={20} />
        </button>
      </div>
    </aside>
  );
};
