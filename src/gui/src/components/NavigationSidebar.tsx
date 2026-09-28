import React from 'react';
import type { ActiveView } from './ActivityBar';

interface NavigationSidebarProps {
  activeView: ActiveView;
  collapsed?: boolean;
  width?: number;
  onSelectView?: (view: ActiveView) => void;
}

interface QuickLink {
  readonly label: string;
  readonly view: ActiveView;
}

const QUICK_LINKS: Partial<Record<ActiveView, readonly QuickLink[]>> = {
  chat: [
    { label: 'Knowledge Search', view: 'knowledge' },
    { label: 'Evidence Workbench', view: 'evidence' },
    { label: 'Tasks & Runs', view: 'tasks' },
  ],
  tasks: [
    { label: 'Agent Cockpit', view: 'cockpit' },
    { label: 'Approvals', view: 'approvals' },
    { label: 'Audit Trail', view: 'audit' },
  ],
  agents: [
    { label: 'Tasks & Runs', view: 'tasks' },
    { label: 'Models & Leases', view: 'models' },
    { label: 'Approvals', view: 'approvals' },
  ],
  cockpit: [
    { label: 'Tasks & Runs', view: 'tasks' },
    { label: 'Models & Leases', view: 'models' },
    { label: 'Approvals', view: 'approvals' },
  ],
  evidence: [
    { label: 'Knowledge Search', view: 'knowledge' },
    { label: 'Documents', view: 'documents' },
    { label: 'Audit Trail', view: 'audit' },
  ],
  documents: [
    { label: 'Evidence Workbench', view: 'evidence' },
    { label: 'Artifacts', view: 'artifacts' },
    { label: 'Knowledge Search', view: 'knowledge' },
  ],
  knowledge: [
    { label: 'Evidence Workbench', view: 'evidence' },
    { label: 'Documents', view: 'documents' },
    { label: 'Chat', view: 'chat' },
  ],
  sandbox: [
    { label: 'Agent Cockpit', view: 'cockpit' },
    { label: 'Tasks & Runs', view: 'tasks' },
    { label: 'Evidence Workbench', view: 'evidence' },
  ],
  artifacts: [
    { label: 'Documents', view: 'documents' },
    { label: 'Evidence Workbench', view: 'evidence' },
    { label: 'Audit Trail', view: 'audit' },
  ],
  approvals: [
    { label: 'Tasks & Runs', view: 'tasks' },
    { label: 'Evidence Workbench', view: 'evidence' },
    { label: 'Audit Trail', view: 'audit' },
  ],
  models: [
    { label: 'Agent Cockpit', view: 'cockpit' },
    { label: 'Chat', view: 'chat' },
    { label: 'Audit Trail', view: 'audit' },
  ],
  audit: [
    { label: 'Evidence Workbench', view: 'evidence' },
    { label: 'Approvals', view: 'approvals' },
    { label: 'Artifacts', view: 'artifacts' },
  ],
  settings: [
    { label: 'Models & Leases', view: 'models' },
    { label: 'Approvals', view: 'approvals' },
    { label: 'Audit Trail', view: 'audit' },
  ],
  code: [
    { label: 'Sandbox', view: 'sandbox' },
    { label: 'Tasks & Runs', view: 'tasks' },
    { label: 'Agent Cockpit', view: 'cockpit' },
  ],
  terminal: [
    { label: 'Sandbox', view: 'sandbox' },
    { label: 'Tasks & Runs', view: 'tasks' },
    { label: 'Agent Cockpit', view: 'cockpit' },
  ],
  drawing: [
    { label: 'Evidence Workbench', view: 'evidence' },
    { label: 'Documents', view: 'documents' },
    { label: 'Artifacts', view: 'artifacts' },
  ],
  findings: [
    { label: 'Evidence Workbench', view: 'evidence' },
    { label: 'Audit Trail', view: 'audit' },
    { label: 'Agent Cockpit', view: 'cockpit' },
  ],
};

const VIEW_TITLES: Record<ActiveView, string> = {
  chat: 'Chat',
  tasks: 'Tasks & Runs',
  agents: 'Agent Cockpit',
  cockpit: 'Agent Cockpit',
  code: 'Code & Sandbox',
  terminal: 'Terminal',
  evidence: 'Evidence Workbench',
  findings: 'Findings',
  documents: 'Documents',
  knowledge: 'Knowledge Search',
  drawing: 'Drawing Viewer',
  artifacts: 'Artifacts',
  approvals: 'Approvals',
  models: 'Models & Leases',
  sandbox: 'Sandbox',
  audit: 'Audit Trail',
  settings: 'Settings',
};

export const NavigationSidebar: React.FC<NavigationSidebarProps> = ({
  activeView,
  collapsed = false,
  width,
  onSelectView,
}) => {
  const links = QUICK_LINKS[activeView] || [];

  return (
    <aside
      className={`app-sidebar ${collapsed ? 'collapsed' : ''}`}
      role="complementary"
      aria-label="Quick navigation"
      style={{ width: !collapsed && width ? `${width}px` : undefined }}
    >
      <div className="sidebar-header">
        <span>Go from {VIEW_TITLES[activeView]}</span>
      </div>
      <nav className="sidebar-content" aria-label="Related MAOS sections">
        {links.map(({ label, view }) => (
          <button
            key={view}
            type="button"
            className="sidebar-item"
            aria-label={`Open ${label}`}
            onClick={() => onSelectView?.(view)}
            data-testid={`quick-link-${view}`}
          >
            <span>{label}</span>
            <span aria-hidden="true">›</span>
          </button>
        ))}
      </nav>
      <p className="sidebar-hint">These shortcuts open real sections. Use the icon rail for the full workspace.</p>
    </aside>
  );
};
