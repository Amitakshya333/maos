import React from 'react';
import { ModuleId } from '../../../domain/layout';
import {
  CodeIcon,
  TerminalIcon,
  FindingsIcon,
  DrawingIcon,
  DocumentsIcon,
  KnowledgeIcon,
  SandboxIcon,
  CockpitIcon,
} from '../components/icons';

interface ModuleMetadata {
  title: string;
  desc: string;
  icon: React.ReactNode;
  badge: string;
  details: string;
}

const MODULE_METADATA: Record<string, ModuleMetadata> = {
  code: {
    title: 'Code Workspace — Preview',
    desc: 'This screen is a prototype surface; live code editing and diff review are not connected in this MVP.',
    icon: <CodeIcon size={40} className="state-icon" />,
    badge: 'PREVIEW — NOT IN TOMORROW’S DEMO PATH',
    details:
      'For the working deterministic calculation demo, open Sandbox. Do not present this screen as a live code editor.',
  },
  terminal: {
    title: 'Terminal — Preview',
    desc: 'The GUI does not currently expose an interactive terminal or command runner.',
    icon: <TerminalIcon size={40} className="state-icon" />,
    badge: 'PREVIEW — NO COMMANDS RUN FROM THIS SCREEN',
    details: 'Use the documented PowerShell runbook for supported launch and verification commands.',
  },
  findings: {
    title: 'Findings — Preview',
    desc: 'A standalone findings dashboard is not connected in this MVP.',
    icon: <FindingsIcon size={40} className="state-icon" />,
    badge: 'PREVIEW — USE EVIDENCE WORKBENCH',
    details: 'The Evidence Workbench and Audit Trail are the connected places to inspect evidence and recorded events.',
  },
  drawing: {
    title: 'Drawing Viewer — Preview',
    desc: 'In-app drawing and diagram rendering is not connected in this MVP.',
    icon: <DrawingIcon size={40} className="state-icon" />,
    badge: 'PREVIEW — NOT IN TOMORROW’S DEMO PATH',
    details: 'Use the Agent Cockpit for the current workflow view and Evidence Workbench for source documents.',
  },
  documents: {
    title: 'Document Generator & Reports',
    desc: 'Automated compliance reports, technical specifications, and exportable project documentation.',
    icon: <DocumentsIcon size={40} className="state-icon" />,
    badge: 'DOCS: LOCAL GENERATOR',
    details: 'Generates markdown, structured PDFs, and compliance evidence packages locally.',
  },
  knowledge: {
    title: 'Knowledge Search & Semantic Context',
    desc: 'Project-local index search, vector embeddings, codebase symbol search, and documentation.',
    icon: <KnowledgeIcon size={40} className="state-icon" />,
    badge: 'SEARCH: ZERO-CLOUD EMBEDDINGS',
    details: 'Full-text and semantic retrieval powered by strictly local models.',
  },
  sandbox: {
    title: 'Container Sandbox & Security Boundary',
    desc: 'Container-isolated execution boundaries, resource limits, and network isolation.',
    icon: <SandboxIcon size={40} className="state-icon" />,
    badge: 'ISOLATION: CONTAINER-ISOLATED',
    details: 'Workflows run in container-isolated environments; external network egress is disabled.',
  },
  cockpit: {
    title: 'Agent Cockpit & Autonomous DAG',
    desc: 'Real-time multi-agent coordination, subagent trees, token consumption, and active execution status.',
    icon: <CockpitIcon size={40} className="state-icon" />,
    badge: 'ORCHESTRATION: MULTI-AGENT DAG',
    details: 'Displays parallel agent pipelines and deterministic execution trees.',
  },
};

export const GenericModuleView: React.FC<{ moduleId: ModuleId }> = ({ moduleId }) => {
  const meta = MODULE_METADATA[moduleId] || {
    title: `Module: ${moduleId}`,
    desc: 'Custom industrial module for workspace workflow.',
    icon: <CodeIcon size={40} className="state-icon" />,
    badge: 'MODULE: ACTIVE',
    details: 'Managed by MAOS role preset configuration.',
  };

  return (
    <div className="view-container" role="tabpanel" aria-label={`${meta.title} View`}>
      <div className="view-header">
        <h1 className="view-title">{meta.title}</h1>
        <p className="view-desc">{meta.desc}</p>
      </div>

      <div className="state-box">
        {meta.icon}
        <div className="state-title">{meta.title}</div>
        <p className="state-message">{meta.details}</p>
        <span className="state-badge">{meta.badge}</span>
      </div>
    </div>
  );
};
