/**
 * MAOS OpenAPI 3.1.0 Specification Document
 *
 * Defines the complete OpenAPI REST contract for /api/v1 covering:
 * Projects, Chat, Tasks, Runs, Workflows, Approvals, Artifacts, Models, Settings, Health, and Sovereignty.
 */

export const OPENAPI_SPEC: Record<string, unknown> = {
  openapi: '3.1.0',
  info: {
    title: 'MAOS Industrial REST API',
    version: '1.0.0',
    description:
      'Typed application service HTTP API for MAOS orchestrator. Consumed by CLI, Web Dashboard, and future React GUI.',
    contact: {
      name: 'MAOS Architecture Team',
    },
  },
  servers: [
    {
      url: 'http://127.0.0.1:3847',
      description: 'Local Loopback Orchestration Server',
    },
  ],
  components: {
    securitySchemes: {
      LoopbackAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'X-Project-Root',
        description: 'Loopback interface authentication and project scope verification.',
      },
    },
    schemas: {
      ErrorEnvelope: {
        type: 'object',
        required: ['error'],
        properties: {
          error: {
            type: 'object',
            required: ['code', 'message', 'correlationId'],
            properties: {
              code: { type: 'string' },
              message: { type: 'string' },
              details: {},
              correlationId: { type: 'string' },
            },
          },
        },
      },
      RetentionSettings: {
        type: 'object',
        properties: {
          conversationDays: { type: 'integer', minimum: 1, maximum: 3650 },
          eventDisplayDays: { type: 'integer', minimum: 1, maximum: 3650 },
          artifactPreviewDays: { type: 'integer', minimum: 1, maximum: 3650 },
          redactSensitivePreviews: { type: 'boolean' },
          allowRawEvidencePreviews: { type: 'boolean' },
        },
        required: [
          'conversationDays',
          'eventDisplayDays',
          'artifactPreviewDays',
          'redactSensitivePreviews',
          'allowRawEvidencePreviews',
        ],
      },
      RuntimeSettings: {
        type: 'object',
        properties: {
          modelUnloadAfterSeconds: { type: 'integer', minimum: 30, maximum: 86400 },
          serviceStopAfterSeconds: { type: 'integer', minimum: 60, maximum: 86400 },
          stopMode: { type: 'string', enum: ['after-current-tasks', 'force'] },
        },
        required: ['modelUnloadAfterSeconds', 'serviceStopAfterSeconds', 'stopMode'],
      },
      AccessibilitySettings: {
        type: 'object',
        properties: {
          theme: { type: 'string', enum: ['dark', 'high-contrast'] },
          reducedMotion: { type: 'boolean' },
          fontScale: { type: 'number', minimum: 0.8, maximum: 2.0 },
          density: { type: 'string', enum: ['compact', 'comfortable'] },
        },
        required: ['theme', 'reducedMotion', 'fontScale', 'density'],
      },
      BasicSettings: {
        type: 'object',
        properties: {
          schemaVersion: { type: 'integer', enum: [1] },
          projectId: { type: 'string' },
          retention: { $ref: '#/components/schemas/RetentionSettings' },
          runtime: { $ref: '#/components/schemas/RuntimeSettings' },
          accessibility: { $ref: '#/components/schemas/AccessibilitySettings' },
          updatedAt: { type: 'string' },
        },
        required: ['schemaVersion', 'projectId', 'retention', 'runtime', 'accessibility', 'updatedAt'],
      },
      Project: {
        type: 'object',
        required: ['schemaVersion', 'projectName', 'routingMode', 'providers', 'agents', 'routing'],
        properties: {
          schemaVersion: { type: 'integer', const: 1 },
          projectName: { type: 'string' },
          profile: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              displayName: { type: 'string' },
              mode: { type: 'string', enum: ['sovereign-local', 'cloud', 'hybrid'] },
              zeroCloud: { type: 'boolean' },
              evidenceRoot: { type: 'string' },
            },
          },
          routingMode: { type: 'string' },
          providers: { type: 'object' },
          agents: { type: 'array' },
          routing: { type: 'object' },
        },
      },
      Conversation: {
        type: 'object',
        required: ['schemaVersion', 'id', 'projectId', 'agentId', 'messages', 'createdAt', 'updatedAt'],
        properties: {
          schemaVersion: { type: 'integer', const: 1 },
          id: { type: 'string' },
          projectId: { type: 'string' },
          agentId: { type: 'string' },
          taskId: { type: 'string' },
          messages: { type: 'array', items: { $ref: '#/components/schemas/Message' } },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      Message: {
        type: 'object',
        required: ['schemaVersion', 'id', 'role', 'content', 'timestamp'],
        properties: {
          schemaVersion: { type: 'integer', const: 1 },
          id: { type: 'string' },
          role: { type: 'string', enum: ['system', 'user', 'assistant', 'tool'] },
          content: { type: ['string', 'null'] },
          name: { type: 'string' },
          toolCallId: { type: 'string' },
          timestamp: { type: 'string', format: 'date-time' },
        },
      },
      Task: {
        type: 'object',
        required: ['schemaVersion', 'id', 'type', 'agent', 'branch', 'description', 'capabilities', 'complexity', 'status', 'createdAt'],
        properties: {
          schemaVersion: { type: 'integer', const: 1 },
          id: { type: 'string' },
          type: { type: 'string', enum: ['task', 'objective', 'subtask', 'review'] },
          agent: { type: 'string' },
          branch: { type: 'string' },
          description: { type: 'string' },
          capabilities: { type: 'array', items: { type: 'string' } },
          complexity: { type: 'string', enum: ['low', 'medium', 'high'] },
          status: { type: 'string', enum: ['pending', 'active', 'done', 'failed'] },
          category: { type: 'string' },
          dependsOn: { type: 'array', items: { type: 'string' } },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      WorkflowStage: {
        type: 'object',
        required: ['schemaVersion', 'id', 'goal', 'status', 'version', 'childTaskIds', 'planHistory', 'createdAt'],
        properties: {
          schemaVersion: { type: 'integer', const: 1 },
          id: { type: 'string' },
          goal: { type: 'string' },
          status: { type: 'string', enum: ['planning', 'executing', 'replanning', 'reviewing', 'done', 'failed'] },
          version: { type: 'integer' },
          childTaskIds: { type: 'array', items: { type: 'string' } },
          planHistory: { type: 'array' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      Approval: {
        type: 'object',
        required: ['schemaVersion', 'id', 'gateId', 'status', 'approvedBy', 'conditions'],
        properties: {
          schemaVersion: { type: 'integer', const: 1 },
          id: { type: 'string' },
          gateId: { type: 'string' },
          status: { type: 'string', enum: ['pending', 'approved', 'rejected', 'conditional'] },
          approvedBy: { type: 'string' },
          approvedAt: { type: ['string', 'null'] },
          conditions: { type: 'array', items: { type: 'string' } },
          evidenceId: { type: 'string' },
        },
      },
      Artifact: {
        type: 'object',
        required: ['schemaVersion', 'id', 'runId', 'path', 'type', 'hash', 'size', 'createdAt'],
        properties: {
          schemaVersion: { type: 'integer', const: 1 },
          id: { type: 'string' },
          runId: { type: 'string' },
          path: { type: 'string' },
          type: { type: 'string', enum: ['file', 'report', 'evidence', 'log', 'snapshot'] },
          hash: { type: 'string' },
          size: { type: 'integer' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      Model: {
        type: 'object',
        required: ['schemaVersion', 'id', 'name', 'provider', 'device', 'snapshotPath', 'hash'],
        properties: {
          schemaVersion: { type: 'integer', const: 1 },
          id: { type: 'string' },
          name: { type: 'string' },
          provider: { type: 'string' },
          device: { type: 'string' },
          snapshotPath: { type: 'string' },
          hash: { type: 'string' },
        },
      },
      ModelLease: {
        type: 'object',
        required: ['schemaVersion', 'id', 'modelId', 'agentId', 'grantedAt', 'port'],
        properties: {
          schemaVersion: { type: 'integer', const: 1 },
          id: { type: 'string' },
          modelId: { type: 'string' },
          agentId: { type: 'string' },
          grantedAt: { type: 'string', format: 'date-time' },
          expiresAt: { type: ['string', 'null'] },
          port: { type: 'integer' },
        },
      },
      SequencedEvent: {
        type: 'object',
        required: ['schemaVersion', 'eventId', 'eventType', 'projectId', 'sequence', 'occurredAt', 'correlationId', 'payload'],
        properties: {
          schemaVersion: { type: 'integer', const: 1 },
          eventId: { type: 'string' },
          eventType: { type: 'string' },
          projectId: { type: 'string' },
          runId: { type: 'string' },
          taskId: { type: 'string' },
          sequence: { type: 'integer' },
          occurredAt: { type: 'string', format: 'date-time' },
          correlationId: { type: 'string' },
          payload: { type: 'object' },
        },
      },
      AuditRecord: {
        type: 'object',
        required: ['schemaVersion', 'sequence', 'previous_hash', 'timestamp', 'source', 'category', 'data', 'hash'],
        properties: {
          schemaVersion: { type: 'integer', const: 1 },
          sequence: { type: 'integer' },
          previous_hash: { type: 'string' },
          timestamp: { type: 'string', format: 'date-time' },
          source: { type: 'string' },
          category: {
            type: 'string',
            enum: ['stage', 'tool', 'model', 'endpoint', 'lease', 'io_hash', 'duration', 'warning', 'approval', 'interruption'],
          },
          data: { type: 'object' },
          hash: { type: 'string' },
        },
      },
      AuditChainVerification: {
        type: 'object',
        required: ['valid', 'recordCount', 'errors', 'verifiedAt', 'latestHash', 'executableHash'],
        properties: {
          valid: { type: 'boolean' },
          recordCount: { type: 'integer' },
          errors: { type: 'array', items: { type: 'string' } },
          verifiedAt: { type: 'string', format: 'date-time' },
          latestHash: { type: 'string' },
          executableHash: { type: 'string' },
        },
      },
      VerificationCheck: {
        type: 'object',
        required: ['check', 'target', 'valid', 'details'],
        properties: {
          check: { type: 'string' },
          target: { type: 'string' },
          valid: { type: 'boolean' },
          details: { type: 'string' },
        },
      },
      RunVerificationResult: {
        type: 'object',
        required: ['valid', 'runId', 'projectId', 'checks', 'errors', 'verifiedAt'],
        properties: {
          valid: { type: 'boolean' },
          runId: { type: 'string' },
          projectId: { type: 'string' },
          checks: { type: 'array', items: { $ref: '#/components/schemas/VerificationCheck' } },
          errors: { type: 'array', items: { type: 'string' } },
          verifiedAt: { type: 'string', format: 'date-time' },
        },
      },
      ArtifactVerificationResult: {
        type: 'object',
        required: ['valid', 'artifactId', 'path', 'computedHash', 'errors', 'verifiedAt'],
        properties: {
          valid: { type: 'boolean' },
          artifactId: { type: 'string' },
          path: { type: 'string' },
          computedHash: { type: 'string' },
          expectedHash: { type: 'string' },
          errors: { type: 'array', items: { type: 'string' } },
          verifiedAt: { type: 'string', format: 'date-time' },
        },
      },
      ModelVerificationResult: {
        type: 'object',
        required: ['valid', 'modelId', 'errors', 'verifiedAt'],
        properties: {
          valid: { type: 'boolean' },
          modelId: { type: 'string' },
          revision: { type: 'string' },
          snapshotHash: { type: 'string' },
          errors: { type: 'array', items: { type: 'string' } },
          verifiedAt: { type: 'string', format: 'date-time' },
        },
      },
      WorkspaceLayout: {
        type: 'object',
        required: [
          'schemaVersion',
          'projectId',
          'role',
          'pinnedModules',
          'collapsedModules',
          'activeModule',
          'drawerOpen',
          'sidebarWidth',
          'drawerHeight',
          'updatedAt',
        ],
        properties: {
          schemaVersion: { type: 'integer', const: 1 },
          projectId: { type: 'string' },
          role: {
            type: 'string',
            enum: ['developer', 'inspector_analyst', 'architect', 'manager_reviewer'],
          },
          pinnedModules: { type: 'array', items: { type: 'string' } },
          collapsedModules: { type: 'array', items: { type: 'string' } },
          activeModule: { type: 'string' },
          drawerOpen: { type: 'boolean' },
          sidebarWidth: { type: 'integer', minimum: 160, maximum: 480 },
          drawerHeight: { type: 'integer', minimum: 120, maximum: 600 },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
  paths: {
    '/api/v1/openapi.json': {
      get: {
        summary: 'Get OpenAPI Specification',
        responses: {
          '200': { description: 'OpenAPI specification document.' },
        },
      },
    },
    '/api/v1/project': {
      get: {
        summary: 'Get Project Configuration',
        responses: {
          '200': { description: 'Current project details and profile.' },
          '403': { description: 'Forbidden non-loopback.' },
        },
      },
    },
    '/api/v1/settings': {
      get: {
        summary: 'Get Project Settings',
        responses: { '200': { description: 'Current settings.' } },
      },
      patch: {
        summary: 'Update Project Settings',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        responses: { '200': { description: 'Updated settings.' }, '400': { description: 'Validation failed.' } },
      },
      put: {
        summary: 'Replace Project Settings',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/BasicSettings' } } },
        },
        responses: { '200': { description: 'Updated settings.' }, '400': { description: 'Validation failed.' } },
      },
    },
    '/api/v1/settings/reset': {
      post: {
        summary: 'Reset Project Settings to Canonical Defaults',
        responses: { '200': { description: 'Default settings restored.' } },
      },
    },
    '/api/v1/service/stop': {
      post: {
        summary: 'Safely Stop Service or Force-Stop with Confirmation',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  mode: { type: 'string', enum: ['after-current-tasks', 'force'] },
                  confirm: { type: 'boolean' },
                  reason: { type: 'string' },
                },
                required: ['mode'],
              },
            },
          },
        },
        responses: {
          '200': { description: 'Service stopped or stopping.' },
          '400': { description: 'Confirmation required or invalid parameters.' },
        },
      },
    },
    '/api/v1/service/visibility': {
      get: {
        summary: 'Get Local Endpoint & Sovereignty Visibility',
        responses: { '200': { description: 'Loopback endpoint and sovereignty info without secret leakage.' } },
      },
    },
    '/api/v1/security/sovereignty': {
      get: {
        summary: 'Get Sovereignty and Zero-Cloud Status',
        responses: { '200': { description: 'Sovereignty verification details.' } },
      },
    },
    '/api/v1/layout': {
      get: {
        summary: 'Get Workspace Layout',
        description: 'Load active workspace layout preferences for project and role presentation.',
        parameters: [
          { name: 'role', in: 'query', schema: { type: 'string' }, required: false },
          { name: 'projectId', in: 'query', schema: { type: 'string' }, required: false },
        ],
        responses: {
          '200': {
            description: 'Active workspace layout and first-run status.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { $ref: '#/components/schemas/WorkspaceLayout' },
                    exists: { type: 'boolean' },
                  },
                },
              },
            },
          },
        },
      },
      put: {
        summary: 'Save Workspace Layout',
        description: 'Persist customized workspace layout preferences to project settings.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/WorkspaceLayout' },
            },
          },
        },
        responses: {
          '200': { description: 'Updated workspace layout.' },
          '400': { description: 'Validation failed.' },
        },
      },
    },
    '/api/v1/layout/reset': {
      post: {
        summary: 'Reset Workspace Layout',
        description: 'Reset project layout to canonical default for specified role.',
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  role: { type: 'string' },
                  projectId: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Reset workspace layout.' },
        },
      },
    },
    '/api/v1/conversations': {
      get: {
        summary: 'List Conversations',
        responses: { '200': { description: 'List of conversations.' } },
      },
      post: {
        summary: 'Create Conversation',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        responses: { '201': { description: 'Conversation created.' } },
      },
    },
    '/api/v1/conversations/{id}': {
      get: {
        summary: 'Get Conversation by ID',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Conversation found.' },
          '404': { description: 'Not found.' },
        },
      },
    },
    '/api/v1/conversations/{id}/messages': {
      post: {
        summary: 'Append Message to Conversation',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        responses: { '201': { description: 'Message added.' } },
      },
    },
    '/api/v1/tasks': {
      get: {
        summary: 'List Tasks',
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string' } },
          { name: 'type', in: 'query', schema: { type: 'string' } },
          { name: 'agentId', in: 'query', schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'List of tasks.' } },
      },
      post: {
        summary: 'Create Task',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        responses: { '201': { description: 'Task created.' } },
      },
    },
    '/api/v1/tasks/{id}': {
      get: {
        summary: 'Get Task by ID',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Task found.' },
          '404': { description: 'Not found.' },
        },
      },
    },
    '/api/v1/workflows': {
      get: {
        summary: 'List Workflows/Objectives',
        responses: { '200': { description: 'List of workflows.' } },
      },
      post: {
        summary: 'Create Workflow Objective',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        responses: { '201': { description: 'Workflow created.' } },
      },
    },
    '/api/v1/workflows/{id}': {
      get: {
        summary: 'Get Workflow by ID',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Workflow found.' }, '404': { description: 'Not found.' } },
      },
    },
    '/api/v1/runs': {
      get: {
        summary: 'List Runs and Recent Execution History',
        responses: { '200': { description: 'List of runs.' } },
      },
    },
    '/api/v1/runs/{id}': {
      get: {
        summary: 'Get Run Timeline / Details',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Run timeline found.' }, '404': { description: 'Not found.' } },
      },
    },
    '/api/v1/industrial/judged-runs': {
      post: {
        summary: 'Start T-07 Industrial Judged Run',
        description: 'Analyzes the bundled T-07 demo evidence and returns a pending human approval. Generates the report only after approval.',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { '202': { description: 'Analysis ready; awaiting human approval.' }, '422': { description: 'Preflight or analysis failed.' } },
      },
    },
    '/api/v1/industrial/judged-runs/{runId}': {
      get: {
        summary: 'Get T-07 Judged Run Status',
        parameters: [{ name: 'runId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Run status and evidence hashes.' }, '404': { description: 'Run not found.' } },
      },
    },
    '/api/v1/approvals': {
      get: {
        summary: 'List Governance Approvals',
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string' } },
          { name: 'scope', in: 'query', schema: { type: 'string' } },
          { name: 'projectId', in: 'query', schema: { type: 'string' } },
          { name: 'runId', in: 'query', schema: { type: 'string' } },
          { name: 'taskId', in: 'query', schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'List of approvals.' } },
      },
      post: {
        summary: 'Create Approval Request',
        description: 'Creates a pending approval request with 15 authoritative governance fields.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        responses: {
          '201': { description: 'Approval created.' },
          '400': { description: 'Validation failed or auto-approval attempted.' },
        },
      },
    },
    '/api/v1/approvals/force-stop': {
      post: {
        summary: 'Execute Confirmed Force-Stop Operation',
        description: 'Explicitly stops a running or queued execution, halting execution and preventing phantom success.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        responses: {
          '200': { description: 'Task force-stopped and marked interrupted.' },
          '400': { description: 'Missing confirmation or invalid parameters.' },
        },
      },
    },
    '/api/v1/approvals/{id}': {
      get: {
        summary: 'Get Approval by ID',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Approval found.' }, '404': { description: 'Not found.' } },
      },
    },
    '/api/v1/approvals/{id}/review': {
      post: {
        summary: 'Submit Human Governance Review Verdict',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        responses: {
          '200': { description: 'Approval reviewed and decided.' },
          '400': { description: 'Invalid review verdict or expired approval.' },
          '403': { description: 'Unauthorized reviewer role or untrusted model self-approval.' },
          '404': { description: 'Approval not found.' },
          '409': { description: 'Approval is not in pending state.' },
        },
      },
    },
    '/api/v1/approvals/{id}/validate': {
      post: {
        summary: 'Validate Approval for Specific Gated Execution',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        responses: {
          '200': { description: 'Validation check outcome.' },
        },
      },
    },
    '/api/v1/approvals/{id}/consume': {
      post: {
        summary: 'Mark Approval as Consumed (Single-Use Enforcement)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        responses: {
          '200': { description: 'Approval consumed.' },
          '404': { description: 'Approval not found.' },
          '409': { description: 'Approval already consumed.' },
        },
      },
    },
    '/api/v1/artifacts': {
      get: {
        summary: 'List Discovered Artifacts',
        responses: { '200': { description: 'List of artifacts.' } },
      },
      post: {
        summary: 'Finalize Artifact Safely',
        description: 'Durable, atomic finalization with Rust-backed SHA-256 and overwrite protection.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        responses: {
          '201': { description: 'Artifact finalized.' },
          '400': { description: 'Validation failed or path traversal.' },
          '403': { description: 'Unauthorized overwrite.' },
          '409': { description: 'Collision or duplicate finalization.' },
          '413': { description: 'Oversized artifact payload.' },
        },
      },
    },
    '/api/v1/artifacts/{id}': {
      get: {
        summary: 'Get Artifact Metadata',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Artifact metadata.' }, '404': { description: 'Not found.' } },
      },
    },
    '/api/v1/artifacts/{id}/content': {
      get: {
        summary: 'Get Artifact Content (Strictly Contained)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Artifact content stream or text.' },
          '400': { description: 'Path traversal attempted.' },
          '404': { description: 'Not found.' },
        },
      },
    },
    '/api/v1/models': {
      get: {
        summary: 'List Available Models',
        responses: { '200': { description: 'Configured models.' } },
      },
    },
    '/api/v1/models/active': {
      get: {
        summary: 'Get Authoritative Active Model Identity',
        responses: { '200': { description: 'Active resident model identity and capabilities.' } },
      },
    },
    '/api/v1/models/route': {
      post: {
        summary: 'Automatic Task-to-Model Routing',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        responses: { '200': { description: 'Recommended model route.' } },
      },
    },
    '/api/v1/models/switch': {
      post: {
        summary: 'Audited Manual Model Switch / Override',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        responses: {
          '200': { description: 'Switch result or confirmation requirement.' },
          '400': { description: 'Incompatible modality or unaudited override.' },
          '409': { description: 'Workflow-fixed or active lease conflict.' },
        },
      },
    },
    '/api/v1/models/leases': {
      get: {
        summary: 'List Active Model Leases',
        responses: { '200': { description: 'Active leases.' } },
      },
      post: {
        summary: 'Acquire Model Lease',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        responses: { '201': { description: 'Lease acquired.' } },
      },
    },
    '/api/v1/models/leases/{id}': {
      delete: {
        summary: 'Release Model Lease',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Lease released.' }, '404': { description: 'Not found.' } },
      },
    },
    '/api/v1/health': {
      get: {
        summary: 'Get Overall Health and Agent Pool Status',
        responses: { '200': { description: 'Health status.' } },
      },
    },
    '/api/v1/health/diagnostics': {
      get: {
        summary: 'Run Diagnostic Checks',
        responses: { '200': { description: 'Diagnostic check results.' } },
      },
    },
    '/api/v1/events': {
      get: {
        summary: 'Query Sequenced Events or Stream WebSocket',
        description: 'REST history fallback for sequenced event replay or upgrade target for RFC 6455 WebSocket streaming.',
        parameters: [
          { name: 'cursor', in: 'query', required: false, schema: { type: 'integer' } },
          { name: 'fromSeq', in: 'query', required: false, schema: { type: 'integer' } },
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer' } },
          { name: 'projectId', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'runId', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Batch of sequenced events.' },
          '409': { description: 'Sequence gap detected.' },
          '410': { description: 'Stale cursor older than retained events.' },
        },
      },
      post: {
        summary: 'Record Sequenced Event',
        description: 'Ingest a sequenced event, persisting to disk first before WebSocket dispatch.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/SequencedEvent' } } },
        },
        responses: {
          '201': { description: 'Event recorded.' },
          '400': { description: 'Validation failed or project mismatch.' },
        },
      },
    },
    '/api/v1/audit': {
      get: {
        summary: 'List and Filter Tamper-Evident Audit Records',
        parameters: [
          { name: 'category', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'source', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'fromSeq', in: 'query', required: false, schema: { type: 'integer' } },
          { name: 'toSeq', in: 'query', required: false, schema: { type: 'integer' } },
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer' } },
        ],
        responses: {
          '200': { description: 'Filtered audit records.' },
        },
      },
    },
    '/api/v1/audit/events': {
      post: {
        summary: 'Record Audit Event with Sensitive-Data Redaction',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['source', 'category', 'data'],
                properties: {
                  source: { type: 'string' },
                  category: {
                    type: 'string',
                    enum: ['stage', 'tool', 'model', 'endpoint', 'lease', 'io_hash', 'duration', 'warning', 'approval', 'interruption'],
                  },
                  data: { type: 'object' },
                  timestamp: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
        },
        responses: {
          '201': { description: 'Audit event recorded and chained.' },
          '400': { description: 'Validation failed (invalid category or source).' },
        },
      },
    },
    '/api/v1/audit/verify': {
      post: {
        summary: 'Verify Audit Chain via Rust Engine',
        responses: {
          '200': {
            description: 'Verification report from Rust engine.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/AuditChainVerification' } } },
          },
        },
      },
    },
    '/api/v1/verify/run': {
      post: {
        summary: 'Verify End-to-End Workflow Run',
        description: 'Comprehensive verification of stages, tasks, artifacts, events, and audit references.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['runId'],
                properties: { runId: { type: 'string' } },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Run verification result.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/RunVerificationResult' } } },
          },
          '400': { description: 'Missing runId or invalid payload.' },
        },
      },
    },
    '/api/v1/verify/artifact': {
      post: {
        summary: 'Verify Artifact Integrity and Disk Containment',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['artifactId'],
                properties: {
                  artifactId: { type: 'string' },
                  expectedHash: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Artifact verification result.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ArtifactVerificationResult' } } },
          },
          '400': { description: 'Missing artifactId.' },
        },
      },
    },
    '/api/v1/verify/model': {
      post: {
        summary: 'Verify Model Identity and Snapshot Manifest',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['modelId'],
                properties: {
                  modelId: { type: 'string' },
                  revision: { type: 'string' },
                  snapshotHash: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Model verification result.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ModelVerificationResult' } } },
          },
          '400': { description: 'Missing modelId.' },
        },
      },
    },
    '/api/v1/verify/audit': {
      post: {
        summary: 'Verify Audit Chain and Sequence Reference',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  sequence: { type: 'integer' },
                  expectedHash: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Audit reference verification report.' },
        },
      },
    },
    '/api/v1/verify/relationship': {
      post: {
        summary: 'Verify Hierarchical Scoping and Project Confinement',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  projectId: { type: 'string' },
                  taskId: { type: 'string' },
                  runId: { type: 'string' },
                  artifactId: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Relationship verification report.' },
        },
      },
    },
    '/api/v1/verify/service': {
      post: {
        summary: 'Verify Service Identity Manifest and Executable Hash',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['serviceId'],
                properties: {
                  serviceId: { type: 'string' },
                  expectedExecutableHash: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Service identity verification report.' },
          '400': { description: 'Missing serviceId.' },
        },
      },
    },
  },
};
