import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import {
  RolePreset,
  ModuleId,
  WorkspaceLayout,
  ROLE_PRESET_CONFIGS,
  getDefaultLayoutForRole,
  clampSidebarWidth,
  clampDrawerHeight,
} from '../../../domain/layout';
import { apiAdapter } from '../api';

export interface LayoutContextType {
  layout: WorkspaceLayout;
  role: RolePreset;
  pinnedModules: ModuleId[];
  collapsedModules: ModuleId[];
  activeModule: ModuleId;
  isDrawerOpen: boolean;
  isSidebarCollapsed: boolean;
  sidebarWidth: number;
  drawerHeight: number;
  needsOnboarding: boolean;
  isLoading: boolean;
  error: string | null;
  announcement: string;
  setRole: (role: RolePreset) => Promise<void>;
  setActiveModule: (moduleId: ModuleId) => Promise<void>;
  toggleDrawer: () => Promise<void>;
  setDrawerOpen: (open: boolean) => Promise<void>;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setSidebarWidth: (width: number) => Promise<void>;
  setDrawerHeight: (height: number) => Promise<void>;
  resetToDefault: () => Promise<void>;
  completeOnboarding: (selectedRole?: RolePreset) => Promise<void>;
  dismissOnboarding: () => Promise<void>;
}

const LayoutContext = createContext<LayoutContextType | undefined>(undefined);

export interface LayoutProviderProps {
  children: React.ReactNode;
  initialRole?: RolePreset;
  projectId?: string;
  autoFetch?: boolean;
  initialNeedsOnboarding?: boolean;
}

export const LayoutProvider: React.FC<LayoutProviderProps> = ({
  children,
  initialRole = 'developer',
  projectId = 'default',
  autoFetch = true,
  initialNeedsOnboarding,
}) => {
  const [layout, setLayout] = useState<WorkspaceLayout>(() =>
    getDefaultLayoutForRole(initialRole, projectId),
  );
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [needsOnboarding, setNeedsOnboarding] = useState(initialNeedsOnboarding ?? false);
  const [isLoading, setIsLoading] = useState(autoFetch);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');

  // Initial fetch from backend
  useEffect(() => {
    if (!autoFetch) return;

    let active = true;
    setIsLoading(true);
    apiAdapter
      .getLayout(initialRole)
      .then(({ layout: fetchedLayout, exists }) => {
        if (!active) return;
        setLayout(fetchedLayout);
        if (!exists) {
          setNeedsOnboarding(true);
        }
        setIsLoading(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setError((err as Error).message || 'Failed to load layout');
        setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [autoFetch, initialRole]);

  const setRole = useCallback(
    async (newRole: RolePreset) => {
      const defaultLayout = getDefaultLayoutForRole(newRole, layout.projectId);
      setLayout(defaultLayout);
      const roleLabel = ROLE_PRESET_CONFIGS[newRole]?.displayName || newRole;
      setAnnouncement(`Role preset switched to ${roleLabel}. Workspace layout updated.`);

      try {
        await apiAdapter.updateLayout(defaultLayout);
      } catch (err: unknown) {
        setError((err as Error).message || 'Failed to save role layout');
      }
    },
    [layout.projectId],
  );

  const setActiveModule = useCallback(
    async (moduleId: ModuleId) => {
      const updated: WorkspaceLayout = {
        ...layout,
        activeModule: moduleId,
        updatedAt: new Date().toISOString(),
      };
      setLayout(updated);

      try {
        await apiAdapter.updateLayout(updated);
      } catch (err: unknown) {
        setError((err as Error).message || 'Failed to persist active module');
      }
    },
    [layout],
  );

  const setDrawerOpen = useCallback(
    async (open: boolean) => {
      const updated: WorkspaceLayout = {
        ...layout,
        drawerOpen: open,
        updatedAt: new Date().toISOString(),
      };
      setLayout(updated);

      try {
        await apiAdapter.updateLayout(updated);
      } catch (err: unknown) {
        setError((err as Error).message || 'Failed to persist drawer state');
      }
    },
    [layout],
  );

  const toggleDrawer = useCallback(async () => {
    await setDrawerOpen(!layout.drawerOpen);
  }, [layout.drawerOpen, setDrawerOpen]);

  const toggleSidebar = useCallback(() => {
    setIsSidebarCollapsed((prev) => !prev);
  }, []);

  const setSidebarWidth = useCallback(
    async (width: number) => {
      const clamped = clampSidebarWidth(width);
      const updated: WorkspaceLayout = {
        ...layout,
        sidebarWidth: clamped,
        updatedAt: new Date().toISOString(),
      };
      setLayout(updated);

      try {
        await apiAdapter.updateLayout(updated);
      } catch (err: unknown) {
        setError((err as Error).message || 'Failed to persist sidebar width');
      }
    },
    [layout],
  );

  const setDrawerHeight = useCallback(
    async (height: number) => {
      const clamped = clampDrawerHeight(height);
      const updated: WorkspaceLayout = {
        ...layout,
        drawerHeight: clamped,
        updatedAt: new Date().toISOString(),
      };
      setLayout(updated);

      try {
        await apiAdapter.updateLayout(updated);
      } catch (err: unknown) {
        setError((err as Error).message || 'Failed to persist drawer height');
      }
    },
    [layout],
  );

  const resetToDefault = useCallback(async () => {
    try {
      const reset = await apiAdapter.resetLayout(layout.role);
      setLayout(reset);
      const roleLabel = ROLE_PRESET_CONFIGS[layout.role]?.displayName || layout.role;
      setAnnouncement(`Layout reset to default for role ${roleLabel}.`);
    } catch {
      // Fallback local reset
      const localDefault = getDefaultLayoutForRole(layout.role, layout.projectId);
      setLayout(localDefault);
    }
  }, [layout.role, layout.projectId]);

  const completeOnboarding = useCallback(
    async (selectedRole: RolePreset = 'developer') => {
      const initialLayout = getDefaultLayoutForRole(selectedRole, layout.projectId);
      setLayout(initialLayout);
      setNeedsOnboarding(false);
      const roleLabel = ROLE_PRESET_CONFIGS[selectedRole]?.displayName || selectedRole;
      setAnnouncement(`Role set to ${roleLabel}. Welcome to MAOS.`);

      try {
        await apiAdapter.updateLayout(initialLayout);
      } catch (err: unknown) {
        setError((err as Error).message || 'Failed to persist initial onboarding layout');
      }
    },
    [layout.projectId],
  );

  const dismissOnboarding = useCallback(async () => {
    await completeOnboarding('developer');
  }, [completeOnboarding]);

  const contextValue = useMemo<LayoutContextType>(
    () => ({
      layout,
      role: layout.role,
      pinnedModules: layout.pinnedModules,
      collapsedModules: layout.collapsedModules,
      activeModule: layout.activeModule,
      isDrawerOpen: layout.drawerOpen,
      isSidebarCollapsed,
      sidebarWidth: layout.sidebarWidth ?? 240,
      drawerHeight: layout.drawerHeight ?? 220,
      needsOnboarding,
      isLoading,
      error,
      announcement,
      setRole,
      setActiveModule,
      toggleDrawer,
      setDrawerOpen,
      toggleSidebar,
      setSidebarCollapsed: setIsSidebarCollapsed,
      setSidebarWidth,
      setDrawerHeight,
      resetToDefault,
      completeOnboarding,
      dismissOnboarding,
    }),
    [
      layout,
      isSidebarCollapsed,
      needsOnboarding,
      isLoading,
      error,
      announcement,
      setRole,
      setActiveModule,
      toggleDrawer,
      setDrawerOpen,
      toggleSidebar,
      setSidebarWidth,
      setDrawerHeight,
      resetToDefault,
      completeOnboarding,
      dismissOnboarding,
    ],
  );

  return (
    <LayoutContext.Provider value={contextValue}>
      {children}
      {/* Accessible screen reader announcement container */}
      <div
        aria-live="polite"
        aria-atomic="true"
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: 'hidden',
          clip: 'rect(0, 0, 0, 0)',
          whiteSpace: 'nowrap',
          border: 0,
        }}
        data-testid="role-announcement-live-region"
      >
        {announcement}
      </div>
    </LayoutContext.Provider>
  );
};

export function useLayout(): LayoutContextType {
  const context = useContext(LayoutContext);
  if (!context) {
    throw new Error('useLayout must be used within a LayoutProvider');
  }
  return context;
}
