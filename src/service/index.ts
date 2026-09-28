/**
 * MAOS Service Container
 *
 * Creates and exports a unified service container.
 * All adapters (CLI, Dashboard, GUI, REST API) use this container.
 *
 * Usage:
 *   const services = createServiceContainer(projectRoot);
 *   const tasks = services.task.listTasks();
 *   const config = services.project.loadConfig();
 */

import { ProjectService } from './project-service';
import { TaskService } from './task-service';
import { WorkflowService } from './workflow-service';
import { OrchestrationService } from './orchestration-service';
import { EventService } from './event-service';
import { MemoryService } from './memory-service';
import { HealthService } from './health-service';
import { ModelService } from './model-service';
import { ConversationService } from './conversation-service';
import { ApprovalService } from './approval-service';
import { ArtifactService } from './artifact-service';
import { AuditService } from './audit-service';
import { VerifierService } from './verifier-service';
import { DurableIdempotencyStore } from '../core/idempotency-store';
import { WorkspaceLayoutStore } from './project-service/layout-store';
import { SharedModelManager } from './model-manager';
import { PdfRasterService, PdfRasterServiceOptions } from './pdf-raster-service';
import { OcrService, OcrServiceOptions } from './ocr-service';
import { VisionService, VisionServiceOptions } from './vision-service';
import { ConflictReviewService, CompareObservationsParams } from './conflict-service';
import { KbIngestionService, KbIngestionServiceOptions } from './kb-ingestion-service';
import { EmbeddingService, EmbeddingServiceOptions } from './embedding-service';
import { KbVectorIndexService, KbVectorIndexServiceOptions } from './kb-vector-index-service';
import { KbSearchService, KbSearchServiceOptions } from './kb-search-service';
import { KbService } from './kb-service';
import { OfficeInputService } from './office-input-service';
import { DocxGeneratorService } from './docx-generator-service';
import { XlsxGeneratorService } from './xlsx-generator-service';
import { PptxGeneratorService } from './pptx-generator-service';
import { OfficeTemplateSafetyService } from './office-template-safety-service';
import {
  OfficeVisualReviewService,
  OfficeVisualReviewReport,
  OfficeVisualReviewOptions,
  VisualReviewError,
  VisualReviewIssue,
} from './office-visual-review-service';
import {
  InferenceService,
  InferenceServiceOptions,
  computeCanonicalInputHash,
} from './inference-service';
import {
  WorkflowPlanningService,
  WorkflowPlanningServiceOptions,
} from './workflow-planning-service';
import {
  WorkflowPlanner,
  WorkflowPlanningInput,
} from '../industrial/workflow-planner';
import {
  ToolApprovalPlanningService,
  ToolApprovalPlanningServiceOptions,
} from './tool-approval-planning-service';
import {
  ToolApprovalPlanner,
  ToolContractCreationOptions,
  ToolPreExecutionContext,
} from '../industrial/tool-approval-planner';
import { EvidenceModeService } from './evidence-mode-service';
import { RetentionService } from './retention-service';
import { FairQueueService } from './fair-queue-service';
import { ModelSwitchService } from './model-switch-service';
import { CockpitService } from './cockpit-service';
import { SandboxImageService } from './sandbox-image-service';
import { SandboxRunnerService } from './sandbox-runner-service';
import { ChatInferenceService } from './chat-inference-service';
import { CalculationTraceService } from './calculation-trace-service';
import { SovereigntyBoundaryService } from './sovereignty-boundary-service';
import { EndpointAllowlistService } from './endpoint-allowlist-service';
import { FirewallService } from './firewall-service';
import { ProcessBoundaryService } from './process-boundary-service';
import { NetworkMonitorService } from './network-monitor-service';
import { ServiceIdentityService } from './service-identity-service';
import { IndustrialFirewallRequirementService } from './industrial-firewall-requirement-service';
import {
  SovereigntyBundleService,
  GenerateBundleOptions,
  SignOffBundleInput,
} from './sovereignty-bundle-service';
import {
  AtomicCleanupCoordinator,
  AtomicCleanupCoordinatorOptions,
  AtomicCleanupReport,
} from '../industrial/atomic-cleanup-coordinator';

export interface ServiceContainer {
  readonly project: ProjectService;
  readonly task: TaskService;
  readonly queue: FairQueueService;
  readonly modelSwitch: ModelSwitchService;
  readonly workflow: WorkflowService;
  readonly orchestration: OrchestrationService;
  readonly event: EventService;
  readonly memory: MemoryService;
  readonly health: HealthService;
  readonly model: ModelService;
  readonly modelManager: SharedModelManager;
  readonly conversation: ConversationService;
  readonly approval: ApprovalService;
  readonly artifact: ArtifactService;
  readonly audit: AuditService;
  readonly verifier: VerifierService;
  readonly idempotency: DurableIdempotencyStore;
  readonly layout: WorkspaceLayoutStore;
  readonly pdfRaster: PdfRasterService;
  readonly ocr: OcrService;
  readonly vision: VisionService;
  readonly conflict: ConflictReviewService;
  readonly kbIngestion: KbIngestionService;
  readonly embedding: EmbeddingService;
  readonly kbIndex: KbVectorIndexService;
  readonly kbSearch: KbSearchService;
  readonly kb: KbService;
  readonly officeInput: OfficeInputService;
  readonly templateSafety: OfficeTemplateSafetyService;
  readonly docxGenerator: DocxGeneratorService;
  readonly xlsxGenerator: XlsxGeneratorService;
  readonly pptxGenerator: PptxGeneratorService;
  readonly officeVisualReview: OfficeVisualReviewService;
  readonly inference: InferenceService;
  readonly workflowPlanning: WorkflowPlanningService;
  readonly toolApprovalPlanning: ToolApprovalPlanningService;
  readonly evidenceMode: EvidenceModeService;
  readonly retention: RetentionService;
  readonly cockpit: CockpitService;
  readonly sandboxImage: SandboxImageService;
  readonly sandboxRunner: SandboxRunnerService;
  readonly chatInference: ChatInferenceService;
  readonly calculationTrace: CalculationTraceService;
  readonly sovereigntyBoundary: SovereigntyBoundaryService;
  readonly endpointAllowlist: EndpointAllowlistService;
  readonly firewall: FirewallService;
  /**
   * Process-scoped Industrial boundary (default). Never modifies host packet
   * filters and never requires elevation.
   */
  readonly processBoundary: ProcessBoundaryService;
  readonly networkMonitor: NetworkMonitorService;
  readonly serviceIdentity: ServiceIdentityService;
  readonly industrialFirewallRequirement: IndustrialFirewallRequirementService;
  readonly sovereigntyBundle: SovereigntyBundleService;
  readonly atomicCleanup: AtomicCleanupCoordinator;
}

/**
 * Create a service container bound to a project root directory.
 * All services share the same project root.
 */
export function createServiceContainer(projectRoot: string): ServiceContainer {
  const project = new ProjectService(projectRoot);
  const task = new TaskService(projectRoot);
  const workflow = new WorkflowService(projectRoot);
  const orchestration = new OrchestrationService(projectRoot);
  const event = new EventService(projectRoot);
  const memory = new MemoryService(projectRoot);
  const health = new HealthService(projectRoot);
  const audit = new AuditService(projectRoot);
  const modelManager = SharedModelManager.getInstance(projectRoot);
  const model = new ModelService(projectRoot, modelManager, audit);
  const conversation = new ConversationService(projectRoot);
  const approval = new ApprovalService(projectRoot);
  const artifact = new ArtifactService(projectRoot, event, approval);
  const idempotency = new DurableIdempotencyStore(projectRoot);
  const layout = new WorkspaceLayoutStore(projectRoot);
  const pdfRaster = new PdfRasterService(projectRoot, artifact, audit);
  const ocr = new OcrService(projectRoot, artifact, audit, pdfRaster);
  const vision = new VisionService(projectRoot, artifact, audit, modelManager);
  const conflict = new ConflictReviewService(projectRoot, artifact, audit);
  const kbIngestion = new KbIngestionService(projectRoot, audit, ocr, pdfRaster);
  const embedding = new EmbeddingService(projectRoot, audit, modelManager);
  const kbIndex = new KbVectorIndexService(projectRoot, audit, kbIngestion, embedding);
  const kbSearch = new KbSearchService(projectRoot, kbIndex, embedding, kbIngestion, audit);
  const kb = new KbService(projectRoot, kbIngestion, embedding, kbIndex, kbSearch, audit);
  const officeInput = new OfficeInputService(projectRoot, artifact, approval, audit);
  const templateSafety = new OfficeTemplateSafetyService(projectRoot, audit);
  const docxGenerator = new DocxGeneratorService(
    projectRoot,
    artifact,
    approval,
    audit,
    officeInput,
    idempotency,
    templateSafety,
  );
  const xlsxGenerator = new XlsxGeneratorService(
    projectRoot,
    artifact,
    approval,
    audit,
    officeInput,
    idempotency,
    templateSafety,
  );
  const pptxGenerator = new PptxGeneratorService(
    projectRoot,
    artifact,
    approval,
    audit,
    officeInput,
    idempotency,
    templateSafety,
  );
  const officeVisualReview = new OfficeVisualReviewService(projectRoot, audit);
  const inference = new InferenceService({ auditService: audit });
  const workflowPlanning = new WorkflowPlanningService(projectRoot, { auditService: audit });
  const toolApprovalPlanning = new ToolApprovalPlanningService(projectRoot, { auditService: audit });
  const verifier = new VerifierService(projectRoot, {
    project,
    task,
    workflow,
    artifact,
    event,
    approval,
    audit,
    model,
  });

  project.setDependencies({
    taskService: task,
    auditService: audit,
    artifactService: artifact,
    modelService: model,
  });

  const evidenceMode = new EvidenceModeService(projectRoot, audit);
  const retention = new RetentionService(projectRoot, audit, project.getSettingsStore());
  const queue = new FairQueueService(projectRoot, modelManager, audit, idempotency);
  const modelSwitch = new ModelSwitchService(projectRoot, modelManager, queue, audit);
  approval.setDependencies({
    auditService: audit,
    queueService: queue,
    taskService: task,
  });

  const cockpit = new CockpitService(projectRoot, {
    eventService: event,
    workflowPlanningService: workflowPlanning,
    approvalService: approval,
    modelManagerService: modelManager,
    auditService: audit,
  });

  const sandboxImage = new SandboxImageService(projectRoot);
  const sandboxRunner = new SandboxRunnerService(projectRoot, {
    imageService: sandboxImage,
    auditService: audit,
    idempotencyStore: idempotency,
  });
  const calculationTrace = new CalculationTraceService(projectRoot, {
    auditService: audit,
  });
  const sovereigntyBoundary = new SovereigntyBoundaryService(projectRoot, {
    auditService: audit,
  });
  const endpointAllowlist = new EndpointAllowlistService(projectRoot, {
    auditService: audit,
    sovereigntyBoundary,
  });
  const chatInference = new ChatInferenceService({
    auditService: audit,
    endpointAllowlist,
  });
  const firewall = new FirewallService(projectRoot, {
    auditService: audit,
    endpointAllowlist,
  });
  const networkMonitor = new NetworkMonitorService(projectRoot, {
    auditService: audit,
    endpointAllowlist,
    sovereigntyBoundary,
  });
  const serviceIdentity = new ServiceIdentityService(projectRoot, {
    auditService: audit,
    endpointAllowlist,
    sovereigntyBoundary,
  });

  // Process-scoped boundary is the SHIPPED DEFAULT for Industrial: it constrains
  // the MAOS process tree and its loopback endpoints without writing host packet
  // filter rules. The machine-wide FirewallService remains available, but is only
  // reachable by explicitly selecting the `host` scope.
  const processBoundary = new ProcessBoundaryService(projectRoot, {
    auditService: audit,
    endpointAllowlist,
    networkMonitor,
  });

  const industrialFirewallRequirement = new IndustrialFirewallRequirementService(projectRoot, {
    firewall,
    processBoundary,
    boundaryScope: 'process',
    endpointAllowlist,
    networkMonitor,
    serviceIdentity,
    auditService: audit,
  });

  const sovereigntyBundle = new SovereigntyBundleService(
    projectRoot,
    sovereigntyBoundary,
    endpointAllowlist,
    firewall,
    networkMonitor,
    serviceIdentity,
    calculationTrace,
    audit,
  );

  sandboxRunner.setIndustrialFirewallRequirement(industrialFirewallRequirement);

  const atomicCleanup = new AtomicCleanupCoordinator(projectRoot, {
    taskService: task,
    workflowService: workflow,
    firewallService: firewall,
    processBoundary,
    networkMonitor,
    modelService: model,
    artifactService: artifact,
    sovereigntyBundle,
    auditService: audit,
  });

  return {
    project,
    task,
    queue,
    modelSwitch,
    workflow,
    orchestration,
    event,
    memory,
    health,
    model,
    modelManager,
    conversation,
    approval,
    artifact,
    audit,
    verifier,
    idempotency,
    layout,
    pdfRaster,
    ocr,
    vision,
    conflict,
    kbIngestion,
    embedding,
    kbIndex,
    kbSearch,
    kb,
    officeInput,
    templateSafety,
    docxGenerator,
    xlsxGenerator,
    pptxGenerator,
    officeVisualReview,
    inference,
    workflowPlanning,
    toolApprovalPlanning,
    evidenceMode,
    retention,
    cockpit,
    sandboxImage,
    sandboxRunner,
    chatInference,
    calculationTrace,
    sovereigntyBoundary,
    endpointAllowlist,
    firewall,
    processBoundary,
    networkMonitor,
    serviceIdentity,
    industrialFirewallRequirement,
    sovereigntyBundle,
    atomicCleanup,
  };
}

// Re-export individual services for direct import
export { CalculationTraceService } from './calculation-trace-service';
export { ChatInferenceService, ChatInferenceError } from './chat-inference-service';
export { SandboxImageService } from './sandbox-image-service';
export { SandboxRunnerService } from './sandbox-runner-service';
export { CockpitService } from './cockpit-service';
export { FairQueueService } from './fair-queue-service';
export { ModelSwitchService } from './model-switch-service';
export { EvidenceModeService } from './evidence-mode-service';
export { RetentionService } from './retention-service';
export { SharedModelManager } from './model-manager';
export { ProjectService } from './project-service';
export { TaskService } from './task-service';
export { WorkflowService } from './workflow-service';
export { OrchestrationService } from './orchestration-service';
export { EventService } from './event-service';
export { MemoryService } from './memory-service';
export { HealthService } from './health-service';
export { ModelService } from './model-service';
export { ConversationService } from './conversation-service';
export { ApprovalService } from './approval-service';
export { ArtifactService } from './artifact-service';
export { AuditService } from './audit-service';
export { VerifierService } from './verifier-service';
export { DurableIdempotencyStore } from '../core/idempotency-store';
export { ProcessBoundaryService } from './process-boundary-service';
export {
  PROCESS_BOUNDARY_ERROR_CODES,
  ProcessBoundaryError,
  synthesizeProcessBoundaryPlan,
  validateProcessBoundaryPlan,
  computeCanonicalProcessBoundaryPlanHash,
} from '../domain/process-boundary';
export type {
  ProcessBoundaryPlan,
  ProcessBoundaryConstraint,
  ProcessBoundaryErrorCode,
} from '../domain/process-boundary';
export type {
  ProcessBoundaryServiceOptions,
  EnableProcessBoundaryOptions,
  ProcessBoundaryEnableResult,
  ProcessBoundaryDisableResult,
} from './process-boundary-service';
export { ProjectServiceHost, createProjectServiceHost } from './project-service/host';
export { SessionManager } from './project-service/session';
export {
  ServiceInstanceIdentity,
  computeProjectRootHash,
  recordServiceIdentity,
  readServiceIdentity,
  verifyServiceIdentity,
  clearServiceIdentity,
} from './project-service/instance-identity';
export {
  validateProjectFolder,
  assertValidProjectFolder,
  ProjectValidationError,
} from './project-service/validator';
export {
  ProjectHostLauncher,
  LauncherError,
  killProcessTree,
  isProcessAlive,
} from './project-service/launcher';
export {
  RecentProjectStore,
  RecentProject,
  RecentProjectStatus,
  RelocationConfirmationRequiredError,
  getDefaultRecentProjectsPath,
} from './project-service/recent-projects';
export {
  WorkspaceLayoutStore,
  WorkspaceLayoutStoreOptions,
} from './project-service/layout-store';
export {
  PdfRasterService,
  PdfRasterServiceOptions,
} from './pdf-raster-service';
export {
  OcrService,
  OcrServiceOptions,
} from './ocr-service';
export {
  VisionService,
  VisionServiceOptions,
} from './vision-service';
export {
  ConflictReviewService,
  CompareObservationsParams,
} from './conflict-service';
export {
  KbIngestionService,
  KbIngestionServiceOptions,
} from './kb-ingestion-service';
export {
  EmbeddingService,
  EmbeddingServiceOptions,
} from './embedding-service';
export {
  KbVectorIndexService,
  KbVectorIndexServiceOptions,
} from './kb-vector-index-service';
export {
  KbSearchService,
  KbSearchServiceOptions,
} from './kb-search-service';
export {
  KbService,
} from './kb-service';
export {
  OfficeInputService,
  OfficeInputValidationOptions,
  OfficeInputFreshnessResult,
} from './office-input-service';
export {
  DocxGeneratorService,
} from './docx-generator-service';
export {
  XlsxGeneratorService,
} from './xlsx-generator-service';
export {
  PptxGeneratorService,
} from './pptx-generator-service';
export {
  OfficeTemplateSafetyService,
  TemplateValidationSummary,
  OutputValidationSummary,
} from './office-template-safety-service';
export {
  OfficeVisualReviewService,
  OfficeVisualReviewReport,
  OfficeVisualReviewOptions,
  VisualReviewError,
  VisualReviewIssue,
} from './office-visual-review-service';
export {
  InferenceService,
  InferenceServiceOptions,
  computeCanonicalInputHash,
} from './inference-service';
export {
  WorkflowPlanningService,
  WorkflowPlanningServiceOptions,
} from './workflow-planning-service';
export {
  WorkflowPlanner,
  WorkflowPlanningInput,
} from '../industrial/workflow-planner';
export {
  ToolApprovalPlanningService,
  ToolApprovalPlanningServiceOptions,
} from './tool-approval-planning-service';
export {
  ToolApprovalPlanner,
  ToolContractCreationOptions,
  ToolPreExecutionContext,
} from '../industrial/tool-approval-planner';
export {
  SovereigntyBoundaryService,
  SovereigntyBoundaryServiceOptions,
} from './sovereignty-boundary-service';
export {
  EndpointAllowlistService,
  EndpointAllowlistServiceOptions,
  RegisteredServiceRecord,
} from './endpoint-allowlist-service';
export {
  FirewallService,
  FirewallServiceOptions,
  ApplyFirewallOptions,
} from './firewall-service';
export {
  NetworkMonitorService,
  NetworkMonitorServiceOptions,
} from './network-monitor-service';
export {
  ServiceIdentityService,
  ServiceIdentityServiceOptions,
  RegisterProcessParams,
  RegisterEndpointBindingParams,
} from './service-identity-service';
export {
  IndustrialFirewallRequirementService,
  IndustrialFirewallRequirementServiceOptions,
} from './industrial-firewall-requirement-service';
export {
  SovereigntyBundleService,
  GenerateBundleOptions,
  SignOffBundleInput,
  createDeterministicZip,
} from './sovereignty-bundle-service';
export {
  AtomicCleanupCoordinator,
  AtomicCleanupCoordinatorOptions,
  AtomicCleanupReport,
  SignalHandlerOptions,
} from '../industrial/atomic-cleanup-coordinator';






