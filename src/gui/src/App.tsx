import React, { useState, useEffect, useCallback } from 'react';
import { apiAdapter } from './api';
import { Header } from './components/Header';
import { ActivityBar, ActiveView, INDUSTRIAL_DEMO_VIEWS } from './components/ActivityBar';
import { NavigationSidebar } from './components/NavigationSidebar';
import { ContextDrawer } from './components/ContextDrawer';
import { StatusBar } from './components/StatusBar';
import { useTheme } from './components/ThemeContext';
import { LayoutProvider, useLayout } from './components/LayoutContext';
import { RoleOnboardingModal } from './components/RoleOnboardingModal';
import { ModuleId, ALL_MODULE_IDS } from '../../domain/layout';

// Views
import { ChatView } from './views/ChatView';
import { TasksView } from './views/TasksView';
import { AgentsView } from './views/AgentsView';
import { EvidenceView } from './views/EvidenceView';
import { ArtifactsView } from './views/ArtifactsView';
import { AuditView } from './views/AuditView';
import { ModelsView } from './views/ModelsView';
import { SettingsView } from './views/SettingsView';
import { ApprovalsView } from './views/ApprovalsView';
import { CockpitView } from './views/CockpitView';
import { DocumentsView } from './views/DocumentsView';
import { KnowledgeView } from './views/KnowledgeView';
import { SandboxView } from './views/SandboxView';
import { GenericModuleView } from './views/GenericModuleView';

function readStatus(record: unknown, label: string, fallback = 'NOT REPORTED'): string {
  if (record && typeof record === 'object' && 'status' in record && typeof record.status === 'string') {
    return `${label}: ${record.status.toUpperCase()}`;
  }
  return `${label}: ${fallback}`;
}

function getApiEndpoint(): string {
  try {
    const url = new URL(apiAdapter.rest.getBaseUrl());
    return `${url.hostname}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`;
  } catch {
    return 'UNVERIFIED';
  }
}

const VALID_VIEWS: ActiveView[] = [
  'chat',
  'tasks',
  'agents',
  'cockpit',
  'evidence',
  'documents',
  'knowledge',
  'sandbox',
  'artifacts',
  'audit',
  'models',
  'approvals',
  'settings',
];

function getViewFromHash(): ActiveView | null {
  const hash = window.location.hash.replace(/^#\/?/, '').toLowerCase();
  if (!hash) return null;
  if (hash === 'agents') return 'agents';
  if (ALL_MODULE_IDS.includes(hash as ModuleId)) {
    return hash as ModuleId;
  }
  return null;
}

const AppContent: React.FC<{ industrialDemo: boolean }> = ({ industrialDemo }) => {
  const {
    activeModule,
    setActiveModule,
    isDrawerOpen,
    toggleDrawer,
    setDrawerOpen,
    isSidebarCollapsed,
    toggleSidebar,
    sidebarWidth,
    drawerHeight,
    pinnedModules,
  } = useLayout();

  const setIsDrawerOpen = useCallback(
    (val: boolean | ((prev: boolean) => boolean)) => {
      if (typeof val === 'function') {
        setDrawerOpen(val(isDrawerOpen));
      } else {
        setDrawerOpen(val);
      }
    },
    [isDrawerOpen, setDrawerOpen],
  );

  const [activeView, setActiveView] = useState<ActiveView>(() => {
    const fromHash = getViewFromHash();
    if (industrialDemo) {
      return fromHash && INDUSTRIAL_DEMO_VIEWS.includes(fromHash as (typeof INDUSTRIAL_DEMO_VIEWS)[number])
        ? fromHash
        : 'cockpit';
    }
    return fromHash || activeModule || 'chat';
  });

  const { toggleTheme } = useTheme();
  const [readiness, setReadiness] = useState({
    apiStatus: 'CHECKING',
        modelStatus: 'MODEL: NOT VERIFIED',
    engineStatus: 'ENGINE: NOT REPORTED',
    projectRoot: 'UNVERIFIED',
    apiEndpoint: getApiEndpoint(),
    sessionStatus: apiAdapter.rest.getSessionToken() ? 'PRESENT' : 'NO TOKEN',
  });

  useEffect(() => {
    let active = true;
    const sessionStatus = apiAdapter.rest.getSessionToken() ? 'PRESENT' : 'NO TOKEN';
    apiAdapter
      .getHealth()
      .then((health) => {
        if (!active) return;
        setReadiness({
          apiStatus: String(health.status).toUpperCase(),
          modelStatus: readStatus(health.model, 'MODEL', 'NOT VERIFIED'),
          engineStatus: readStatus(health.rust, 'ENGINE'),
          projectRoot: apiAdapter.rest.getProjectRoot(),
          apiEndpoint: getApiEndpoint(),
          sessionStatus,
        });
        apiAdapter
          .getChatHealth()
          .then((chatHealth) => {
            if (!active) return;
            setReadiness((current) => ({
              ...current,
              modelStatus:
                typeof chatHealth.available === 'boolean'
                  ? `MODEL: ${chatHealth.available ? 'AVAILABLE' : 'UNAVAILABLE'}`
                  : 'MODEL: NOT VERIFIED',
            }));
          })
          .catch(() => {
            if (active) setReadiness((current) => ({ ...current, modelStatus: 'MODEL: NOT VERIFIED' }));
          });
      })
      .catch(() => {
        if (!active) return;
        setReadiness({
          apiStatus: 'UNAVAILABLE',
          modelStatus: 'MODEL: NOT VERIFIED',
          engineStatus: 'ENGINE: NOT REPORTED',
          projectRoot: 'UNVERIFIED',
          apiEndpoint: getApiEndpoint(),
          sessionStatus,
        });
      });
    return () => {
      active = false;
    };
  }, []);

  // Sync route on hash change
  useEffect(() => {
    const handleHashChange = () => {
      const fromHash = getViewFromHash();
      if (fromHash) {
        const nextView = industrialDemo && !INDUSTRIAL_DEMO_VIEWS.includes(fromHash as (typeof INDUSTRIAL_DEMO_VIEWS)[number])
          ? 'cockpit'
          : fromHash;
        setActiveView(nextView);
        setActiveModule(nextView as ModuleId);
      }
    };
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, [setActiveModule, industrialDemo]);

  useEffect(() => {
    if (industrialDemo && window.location.hash !== `#/${activeView}`) {
      window.location.hash = `#/${activeView}`;
    }
  }, [activeView, industrialDemo]);

  // Sync when activeModule in layout changes (e.g. role switch)
  useEffect(() => {
    if (industrialDemo) return;
    if (activeModule && activeModule !== activeView) {
      setActiveView(activeModule);
      window.location.hash = `#/${activeModule}`;
    }
  }, [activeModule, industrialDemo]);

  const handleSelectView = useCallback(
    (view: ActiveView) => {
      setActiveView(view);
      window.location.hash = `#/${view}`;
      setActiveModule(view as ModuleId);
    },
    [setActiveModule],
  );

  // Keyboard navigation shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore when typing inside input/textarea
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement)?.tagName)) {
        return;
      }

      // Alt+1 .. Alt+8 view switching
      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        const num = parseInt(e.key, 10);
        const shortcutCount = industrialDemo ? INDUSTRIAL_DEMO_VIEWS.length : VALID_VIEWS.length;
        if (num >= 1 && num <= shortcutCount) {
          const target = industrialDemo
            ? INDUSTRIAL_DEMO_VIEWS[num - 1]
            : (num <= 7 ? pinnedModules[num - 1] : undefined) || VALID_VIEWS[num - 1];
          if (target) {
            e.preventDefault();
            handleSelectView(target as ActiveView);
            return;
          }
        }

        // Alt+T: Toggle Theme
        if (e.key.toLowerCase() === 't') {
          e.preventDefault();
          toggleTheme();
          return;
        }

        // Alt+C: Toggle Drawer
        if (e.key.toLowerCase() === 'c') {
          e.preventDefault();
          setIsDrawerOpen((prev) => !prev);
          return;
        }

        // Alt+B: Toggle Sidebar
        if (e.key.toLowerCase() === 'b') {
          e.preventDefault();
          toggleSidebar();
          return;
        }
      }

      // Ctrl+J: Toggle Drawer (VS Code standard)
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        setIsDrawerOpen((prev) => !prev);
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleSelectView, toggleTheme, toggleDrawer, toggleSidebar, pinnedModules, industrialDemo]);

  const renderActiveView = () => {
    switch (activeView) {
      case 'chat':
        return <ChatView />;
      case 'tasks':
        return <TasksView />;
      case 'agents':
      case 'cockpit':
        return <CockpitView />;
      case 'evidence':
        return <EvidenceView />;
      case 'documents':
        return <DocumentsView />;
      case 'knowledge':
        return <KnowledgeView />;
      case 'sandbox':
        return <SandboxView />;
      case 'artifacts':
        return <ArtifactsView />;
      case 'audit':
        return <AuditView />;
      case 'models':
        return <ModelsView />;
      case 'settings':
        return <SettingsView />;
      case 'approvals':
        return <ApprovalsView />;
      default:
        return <GenericModuleView moduleId={activeView as ModuleId} />;
    }
  };

  return (
    <div className="app-shell" data-testid="maos-app-shell">
      {/* 1. First-Run Role Onboarding Modal */}
      <RoleOnboardingModal />

      {/* 2. Header */}
      <Header
        projectRoot={readiness.projectRoot}
        apiStatus={readiness.apiStatus}
        modelStatus={readiness.modelStatus}
        engineStatus={readiness.engineStatus}
        sessionStatus={readiness.sessionStatus}
      />

      {/* Middle Layout Body */}
      <div className="app-body">
        {/* 3. Activity Bar */}
        <ActivityBar activeView={activeView} onSelectView={handleSelectView} industrialDemo={industrialDemo} />

        {/* 4. Navigation Sidebar */}
        <NavigationSidebar
          activeView={activeView}
          collapsed={isSidebarCollapsed}
          width={sidebarWidth}
          onSelectView={handleSelectView}
          industrialDemo={industrialDemo}
        />

        {/* 5. Center Container (Workspace + Drawer) */}
        <div className="app-center">
          {/* Main Workspace View */}
          <main className="app-workspace" role="main">
            {renderActiveView()}
          </main>

          {/* 6. Context / Cockpit Drawer */}
          <ContextDrawer
            isOpen={isDrawerOpen}
            onToggle={toggleDrawer}
            height={drawerHeight}
            lastEventSeq={3}
          />
        </div>
      </div>

      {/* 7. Status Bar */}
      <StatusBar
        projectRoot={readiness.projectRoot}
        apiEndpoint={readiness.apiEndpoint}
        apiStatus={readiness.apiStatus}
      />
    </div>
  );
};

export const App: React.FC<{ industrialDemo?: boolean }> = ({ industrialDemo = false }) => {
  return (
    <LayoutProvider>
      <AppContent industrialDemo={industrialDemo} />
    </LayoutProvider>
  );
};
