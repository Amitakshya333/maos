/**
 * MAOS Workspace Layout and Role Presets Domain Specification (UI1-07)
 *
 * Defines:
 *   - The 4 built-in role presets: Developer, Inspector/Analyst, Architect, Manager/Reviewer
 *   - Module identifiers across all roles
 *   - Versioned WorkspaceLayout interface (schemaVersion: 1)
 *   - Bounded panel dimension clamps (sidebarWidth: 160-480, drawerHeight: 120-600)
 *   - Validation and normalization routines with recovery to canonical defaults
 *
 * CRITICAL SAFETY INVARIANT:
 * Role presets control presentation and layout only.
 * They must NEVER control authorization, safety permissions, tool access,
 * sandbox execution, model leases, or approval requirements.
 */

export type RolePreset =
  | 'developer'
  | 'inspector_analyst'
  | 'architect'
  | 'manager_reviewer';

export const ALL_ROLE_PRESETS: readonly RolePreset[] = Object.freeze([
  'developer',
  'inspector_analyst',
  'architect',
  'manager_reviewer',
]);

export type ModuleId =
  | 'chat'
  | 'tasks'
  | 'agents'
  | 'evidence'
  | 'artifacts'
  | 'audit'
  | 'models'
  | 'settings'
  | 'cockpit'
  | 'code'
  | 'terminal'
  | 'sandbox'
  | 'findings'
  | 'documents'
  | 'drawing'
  | 'knowledge'
  | 'approvals';

export const ALL_MODULE_IDS: readonly ModuleId[] = Object.freeze([
  'chat',
  'tasks',
  'agents',
  'evidence',
  'artifacts',
  'audit',
  'models',
  'settings',
  'cockpit',
  'code',
  'terminal',
  'sandbox',
  'findings',
  'documents',
  'drawing',
  'knowledge',
  'approvals',
]);

export interface RolePresetConfig {
  readonly id: RolePreset;
  readonly displayName: string;
  readonly description: string;
  readonly pinnedModules: readonly ModuleId[];
  readonly collapsedModules: readonly ModuleId[];
  readonly defaultActiveModule: ModuleId;
  readonly defaultDrawerOpen: boolean;
}

export const ROLE_PRESET_CONFIGS: Readonly<Record<RolePreset, RolePresetConfig>> = Object.freeze({
  developer: Object.freeze({
    id: 'developer',
    displayName: 'Developer',
    description: 'Local coding, sandbox execution, task queueing, and agent cockpit monitoring.',
    pinnedModules: Object.freeze(['chat', 'tasks', 'code', 'terminal', 'cockpit'] as ModuleId[]),
    collapsedModules: Object.freeze(['evidence', 'documents', 'knowledge', 'audit'] as ModuleId[]),
    defaultActiveModule: 'chat' as ModuleId,
    defaultDrawerOpen: true,
  }),
  inspector_analyst: Object.freeze({
    id: 'inspector_analyst',
    displayName: 'Inspector / Analyst',
    description: 'Industrial evidence verification, telemetry inspection, findings, and compliance reporting.',
    pinnedModules: Object.freeze(['chat', 'evidence', 'findings', 'tasks', 'documents'] as ModuleId[]),
    collapsedModules: Object.freeze(['code', 'sandbox', 'cockpit'] as ModuleId[]),
    defaultActiveModule: 'evidence' as ModuleId,
    defaultDrawerOpen: false,
  }),
  architect: Object.freeze({
    id: 'architect',
    displayName: 'Architect',
    description: 'System diagrams, knowledge research, architectural evidence review, and artifact management.',
    pinnedModules: Object.freeze(['chat', 'drawing', 'knowledge', 'evidence', 'artifacts'] as ModuleId[]),
    collapsedModules: Object.freeze(['code', 'terminal', 'documents'] as ModuleId[]),
    defaultActiveModule: 'chat' as ModuleId,
    defaultDrawerOpen: false,
  }),
  manager_reviewer: Object.freeze({
    id: 'manager_reviewer',
    displayName: 'Manager / Reviewer',
    description: 'Governance, approval gates, audit trails, and high-level agent progress tracking.',
    pinnedModules: Object.freeze(['chat', 'cockpit', 'approvals', 'audit', 'tasks'] as ModuleId[]),
    collapsedModules: Object.freeze(['evidence', 'artifacts', 'models', 'code', 'terminal', 'documents', 'knowledge'] as ModuleId[]),
    defaultActiveModule: 'approvals' as ModuleId,
    defaultDrawerOpen: false,
  }),
});

export interface WorkspaceLayout {
  schemaVersion: 1;
  projectId: string;
  role: RolePreset;
  pinnedModules: ModuleId[];
  collapsedModules: ModuleId[];
  activeModule: ModuleId;
  drawerOpen: boolean;
  sidebarWidth?: number;
  drawerHeight?: number;
  updatedAt: string;
}

export const SIDEBAR_WIDTH_BOUNDS = { min: 160, max: 480, default: 240 } as const;
export const DRAWER_HEIGHT_BOUNDS = { min: 120, max: 600, default: 220 } as const;

export function isRolePreset(val: unknown): val is RolePreset {
  return typeof val === 'string' && ALL_ROLE_PRESETS.includes(val as RolePreset);
}

export function isModuleId(val: unknown): val is ModuleId {
  return typeof val === 'string' && ALL_MODULE_IDS.includes(val as ModuleId);
}

export function clampSidebarWidth(val?: number): number {
  if (typeof val !== 'number' || isNaN(val)) return SIDEBAR_WIDTH_BOUNDS.default;
  return Math.max(SIDEBAR_WIDTH_BOUNDS.min, Math.min(SIDEBAR_WIDTH_BOUNDS.max, Math.round(val)));
}

export function clampDrawerHeight(val?: number): number {
  if (typeof val !== 'number' || isNaN(val)) return DRAWER_HEIGHT_BOUNDS.default;
  return Math.max(DRAWER_HEIGHT_BOUNDS.min, Math.min(DRAWER_HEIGHT_BOUNDS.max, Math.round(val)));
}

export function getDefaultLayoutForRole(role: RolePreset, projectId: string): WorkspaceLayout {
  const safeRole: RolePreset = isRolePreset(role) ? role : 'developer';
  const config = ROLE_PRESET_CONFIGS[safeRole];

  return {
    schemaVersion: 1,
    projectId: projectId || 'default',
    role: safeRole,
    pinnedModules: [...config.pinnedModules],
    collapsedModules: [...config.collapsedModules],
    activeModule: config.defaultActiveModule,
    drawerOpen: config.defaultDrawerOpen,
    sidebarWidth: SIDEBAR_WIDTH_BOUNDS.default,
    drawerHeight: DRAWER_HEIGHT_BOUNDS.default,
    updatedAt: new Date().toISOString(),
  };
}

export interface LayoutValidationResult {
  valid: boolean;
  layout?: WorkspaceLayout;
  errors?: string[];
}

export function validateWorkspaceLayout(raw: unknown, expectedProjectId?: string): LayoutValidationResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, errors: ['Layout payload must be a non-null JSON object.'] };
  }

  const obj = raw as Record<string, any>;
  const errors: string[] = [];

  if (obj.schemaVersion !== 1) {
    errors.push(`Invalid schemaVersion: expected 1, received ${obj.schemaVersion}`);
  }

  if (typeof obj.projectId !== 'string' || !obj.projectId.trim()) {
    errors.push('projectId must be a non-empty string');
  } else if (expectedProjectId && obj.projectId !== expectedProjectId) {
    errors.push(`Cross-project layout mismatch: expected '${expectedProjectId}', got '${obj.projectId}'`);
  }

  if (!isRolePreset(obj.role)) {
    errors.push(`Invalid role preset: '${obj.role}'. Allowed: ${ALL_ROLE_PRESETS.join(', ')}`);
  }

  if (!Array.isArray(obj.pinnedModules)) {
    errors.push('pinnedModules must be an array');
  } else {
    for (const m of obj.pinnedModules) {
      if (!isModuleId(m)) {
        errors.push(`Invalid pinned module ID: '${m}'`);
      }
    }
  }

  if (!Array.isArray(obj.collapsedModules)) {
    errors.push('collapsedModules must be an array');
  } else {
    for (const m of obj.collapsedModules) {
      if (!isModuleId(m)) {
        errors.push(`Invalid collapsed module ID: '${m}'`);
      }
    }
  }

  if (!isModuleId(obj.activeModule)) {
    errors.push(`Invalid activeModule ID: '${obj.activeModule}'`);
  }

  if (typeof obj.drawerOpen !== 'boolean') {
    errors.push('drawerOpen must be a boolean');
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const validatedLayout: WorkspaceLayout = {
    schemaVersion: 1,
    projectId: obj.projectId.trim(),
    role: obj.role,
    pinnedModules: obj.pinnedModules,
    collapsedModules: obj.collapsedModules,
    activeModule: obj.activeModule,
    drawerOpen: obj.drawerOpen,
    sidebarWidth: clampSidebarWidth(obj.sidebarWidth),
    drawerHeight: clampDrawerHeight(obj.drawerHeight),
    updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : new Date().toISOString(),
  };

  return { valid: true, layout: validatedLayout };
}
