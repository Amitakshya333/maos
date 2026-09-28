import React, { useState, useEffect, useCallback } from 'react';
import { Header } from './components/Header';
import { ActivityBar, ActiveView } from './components/ActivityBar';
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

const AppContent: React.FC = () => {
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
    return getViewFromHash() || activeModule || 'chat';
  });

  const { toggleTheme } = useTheme();

  // Sync route on hash change
  useEffect(() => {
    const handleHashChange = () => {
      const fromHash = getViewFromHash();
      if (fromHash) {
        setActiveView(fromHash);
        setActiveModule(fromHash as ModuleId);
      }
    };
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, [setActiveModule]);

  // Sync when activeModule in layout changes (e.g. role switch)
  useEffect(() => {
    if (activeModule && activeModule !== activeView) {
      setActiveView(activeModule);
      window.location.hash = `#/${activeModule}`;
    }
  }, [activeModule]);

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
        if (num >= 1 && num <= VALID_VIEWS.length) {
          const target = (num <= 7 ? pinnedModules[num - 1] : undefined) || VALID_VIEWS[num - 1];
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
  }, [handleSelectView, toggleTheme, toggleDrawer, toggleSidebar, pinnedModules]);

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
      <Header />

      {/* Middle Layout Body */}
      <div className="app-body">
        {/* 3. Activity Bar */}
        <ActivityBar activeView={activeView} onSelectView={handleSelectView} />

        {/* 4. Navigation Sidebar */}
        <NavigationSidebar
          activeView={activeView}
          collapsed={isSidebarCollapsed}
          width={sidebarWidth}
          onSelectView={handleSelectView}
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
      <StatusBar />
    </div>
  );
};

export const App: React.FC = () => {
  return (
    <LayoutProvider>
      <AppContent />
    </LayoutProvider>
  );
};
