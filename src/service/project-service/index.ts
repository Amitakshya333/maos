/**
 * UI1-03, UI1-04, UI1-05: Project Service Host, Launcher & Recent Projects Module
 */

export { ProjectServiceHost, createProjectServiceHost, ProjectServiceHostOptions } from './host';
export {
  SessionManager,
  SessionInfo,
  CreateSessionParams,
  VerifyTokenResult,
  DEFAULT_SESSION_TTL_MS,
} from './session';
export {
  ServiceInstanceIdentity,
  computeProjectRootHash,
  computeExecutableHash,
  recordServiceIdentity,
  readServiceIdentity,
  verifyServiceIdentity,
  clearServiceIdentity,
  getServiceIdentityPath,
} from './instance-identity';
export {
  validateProjectFolder,
  assertValidProjectFolder,
  ProjectValidationOptions,
  CanonicalProjectFolder,
  ProjectValidationResult,
  ProjectValidationError,
} from './validator';
export {
  ProjectHostLauncher,
  ProjectHostLauncherOptions,
  LaunchOptions,
  LaunchedProjectHost,
  LauncherError,
  isProcessAlive,
  killProcessTree,
  verifyTcpListening,
  resolveEntrypoint,
} from './launcher';
export {
  HostReadinessEnvelope,
  HostErrorEnvelope,
  HostSessionEnvelope,
  HostSessionErrorEnvelope,
  HostPongEnvelope,
  HostShutdownEnvelope,
} from './entrypoint';
export {
  RecentProject,
  RecentProjectStatus,
  RecentProjectsFile,
  RecentProjectStore,
  RecentProjectStoreOptions,
  RelocateProjectOptions,
  RecentProjectError,
  RelocationConfirmationRequiredError,
  getDefaultRecentProjectsPath,
  getOrGenerateProjectId,
} from './recent-projects';
export {
  WorkspaceLayoutStore,
  WorkspaceLayoutStoreOptions,
} from './layout-store';
export {
  BasicSettingsStore,
  BasicSettingsStoreOptions,
} from './settings-store';
