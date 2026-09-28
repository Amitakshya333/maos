/**
 * F10-07: Open-Artifact Integration for MAOS Industrial
 *
 * Implements safe, validated local deliverable opening using installed
 * desktop office applications (Microsoft Office / LibreOffice / system viewer).
 *
 * Requirements & Negative Invariants:
 * 1. Strictly local artifacts: Rejects remote URLs (http, https, ftp, file, etc.).
 * 2. No shell injection: Arguments are sanitized; uses child_process.spawn with argument arrays, never shell string concatenation.
 * 3. No path traversal: Rejects path traversal (..) and unconfined paths outside projectRoot.
 * 4. Strictly allowed extensions: Only .docx, .xlsx, .pptx, .pdf.
 * 5. No executable execution: Rejects .exe, .bat, .cmd, .ps1, .sh, .vbs, etc.
 * 6. Explicit user action only: No implicit/automatic execution.
 * 7. No embedded editor claim: Explicitly documents delegation to installed desktop software.
 * 8. Cryptographic verification: Calculates SHA-256 of target deliverable and verifies hash against artifact store when available.
 * 9. Privacy-preserving audit: Records ARTIFACT_OPENED audit event with deliverable hash and path.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as child_process from 'child_process';
import chalk from 'chalk';
import { createServiceContainer, ServiceContainer } from '../service';
import { AuditService } from '../service/audit-service';
import { INDUSTRIAL_CLI_EXIT, IndustrialCliExitCode } from './industrial-cli';

export const ALLOWED_DELIVERABLE_EXTENSIONS = new Set(['.docx', '.xlsx', '.pptx', '.pdf']);

export const NO_EMBEDDED_EDITOR_DISCLAIMER =
  'MAOS Industrial provides verifiable, deterministic deliverable generation and delegates viewing/editing to installed desktop office applications (Microsoft Office / LibreOffice). No embedded editor claim.';

export const FORBIDDEN_SHELL_PATTERNS = /[;&|`$><\r\n\0]/;

export interface OpenArtifactParams {
  readonly projectRoot?: string;
  readonly target: string; // Artifact ID or relative file path
  readonly launcher?: 'auto' | 'office' | 'libreoffice' | 'system';
  readonly dryRun?: boolean;
  readonly auditService?: AuditService;
  readonly services?: ServiceContainer;
}

export interface OpenArtifactResult {
  readonly success: boolean;
  readonly exitCode: IndustrialCliExitCode;
  readonly message: string;
  readonly target: string;
  readonly resolvedRelativePath?: string;
  readonly resolvedAbsPath?: string;
  readonly artifactId?: string;
  readonly fileExtension?: string;
  readonly sha256?: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly launched: boolean;
  readonly dryRun: boolean;
  readonly disclaimer: string;
}

/**
 * Validates target string against remote URLs and shell injection patterns.
 */
export function validateOpenTargetSafety(target: string): { valid: boolean; reason?: string } {
  if (!target || typeof target !== 'string' || target.trim().length === 0) {
    return { valid: false, reason: 'Target path or artifact ID cannot be empty.' };
  }

  const trimmed = target.trim();

  // Reject remote URLs and protocol schemes
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//i.test(trimmed) || /^(file|http|https|ftp|smb):/i.test(trimmed)) {
    return { valid: false, reason: 'REMOTE_URL_FORBIDDEN: Opening remote or URL-based targets is strictly prohibited.' };
  }

  // Reject UNC paths or double slashes
  if (trimmed.startsWith('\\\\') || trimmed.startsWith('//')) {
    return { valid: false, reason: 'REMOTE_URL_FORBIDDEN: UNC network paths are not allowed.' };
  }

  // Reject shell injection control characters
  if (FORBIDDEN_SHELL_PATTERNS.test(trimmed)) {
    return { valid: false, reason: 'SHELL_INJECTION_DETECTED: Target contains illegal shell control characters.' };
  }

  // Reject traversal sequences
  const normalized = trimmed.replace(/\\/g, '/');
  if (normalized.split('/').includes('..')) {
    return { valid: false, reason: 'PATH_TRAVERSAL_DETECTED: Directory traversal sequences (..) are strictly prohibited.' };
  }

  return { valid: true };
}

/**
 * Formulates the platform-specific desktop launch command safely.
 */
export function formulateLaunchCommand(
  targetAbsPath: string,
  launcher: 'auto' | 'office' | 'libreoffice' | 'system' = 'auto',
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  const ext = path.extname(targetAbsPath).toLowerCase();

  if (platform === 'win32') {
    if (launcher === 'libreoffice') {
      return { command: 'soffice', args: [targetAbsPath] };
    }
    if (launcher === 'office') {
      let officeApp = 'winword';
      if (ext === '.xlsx') officeApp = 'excel';
      if (ext === '.pptx') officeApp = 'powerpnt';
      return { command: officeApp, args: [targetAbsPath] };
    }
    // Default safe Windows desktop handler: cmd.exe /c start "" <path>
    return {
      command: 'cmd.exe',
      args: ['/c', 'start', '', targetAbsPath],
    };
  }

  if (platform === 'darwin') {
    if (launcher === 'libreoffice') {
      return { command: 'open', args: ['-a', 'LibreOffice', targetAbsPath] };
    }
    if (launcher === 'office') {
      let appName = 'Microsoft Word';
      if (ext === '.xlsx') appName = 'Microsoft Excel';
      if (ext === '.pptx') appName = 'Microsoft PowerPoint';
      return { command: 'open', args: ['-a', appName, targetAbsPath] };
    }
    return { command: 'open', args: [targetAbsPath] };
  }

  // Linux / POSIX default
  if (launcher === 'libreoffice') {
    return { command: 'libreoffice', args: [targetAbsPath] };
  }
  return { command: 'xdg-open', args: [targetAbsPath] };
}

/**
 * Safely opens a validated local deliverable artifact.
 */
export async function openLocalArtifact(
  params: OpenArtifactParams,
): Promise<OpenArtifactResult> {
  const projectRoot = path.resolve(params.projectRoot || process.cwd());
  const services = params.services || createServiceContainer(projectRoot);
  const auditService = params.auditService || services.audit;
  const launcher = params.launcher || 'auto';
  const dryRun = Boolean(params.dryRun);

  // 1. Validate Target Safety
  const safetyCheck = validateOpenTargetSafety(params.target);
  if (!safetyCheck.valid) {
    return {
      success: false,
      exitCode: INDUSTRIAL_CLI_EXIT.INVALID_ARGS,
      message: safetyCheck.reason || 'Invalid target parameter.',
      target: params.target,
      launched: false,
      dryRun,
      disclaimer: NO_EMBEDDED_EDITOR_DISCLAIMER,
    };
  }

  const rawTarget = params.target.trim();

  // 2. Resolve Target (by Artifact ID or relative file path)
  let resolvedRelativePath = rawTarget;
  let artifactId: string | undefined;

  const existingArtifact = services.artifact.getArtifact(rawTarget);
  if (existingArtifact && existingArtifact.id === rawTarget) {
    resolvedRelativePath = existingArtifact.path;
    artifactId = existingArtifact.id;
  } else {
    // If not found strictly by ID, look for matching artifact in artifact service listings
    const allArtifacts = services.artifact.listArtifacts();
    const matchingArtifacts = allArtifacts
      .filter((a) => a.id === rawTarget || a.path.replace(/\\/g, '/') === rawTarget.replace(/\\/g, '/'))
      .sort((a, b) => Date.parse(b.finalizedAt || b.createdAt) - Date.parse(a.finalizedAt || a.createdAt));

    if (matchingArtifacts.length > 0) {
      resolvedRelativePath = matchingArtifacts[0].path;
      artifactId = matchingArtifacts[0].id;
    }
  }

  // 3. Extension Validation
  const ext = path.extname(resolvedRelativePath).toLowerCase();
  if (!ALLOWED_DELIVERABLE_EXTENSIONS.has(ext)) {
    const msg = `UNSUPPORTED_ARTIFACT_TYPE: Extension '${ext}' is not a supported deliverable format. Supported: ${Array.from(ALLOWED_DELIVERABLE_EXTENSIONS).join(', ')}`;
    return {
      success: false,
      exitCode: INDUSTRIAL_CLI_EXIT.INVALID_ARGS,
      message: msg,
      target: params.target,
      resolvedRelativePath,
      fileExtension: ext,
      launched: false,
      dryRun,
      disclaimer: NO_EMBEDDED_EDITOR_DISCLAIMER,
    };
  }

  // 4. Resolve and Confinement Check
  const resolvedAbsPath = path.resolve(projectRoot, resolvedRelativePath);
  const relativeFromRoot = path.relative(projectRoot, resolvedAbsPath);

  if (relativeFromRoot.startsWith('..') || path.isAbsolute(relativeFromRoot)) {
    const msg = `PATH_TRAVERSAL_DETECTED: Target path '${resolvedRelativePath}' escapes project containment.`;
    return {
      success: false,
      exitCode: INDUSTRIAL_CLI_EXIT.INVALID_ARGS,
      message: msg,
      target: params.target,
      resolvedRelativePath,
      fileExtension: ext,
      launched: false,
      dryRun,
      disclaimer: NO_EMBEDDED_EDITOR_DISCLAIMER,
    };
  }

  // 5. File Existence & Hash Verification
  if (!fs.existsSync(resolvedAbsPath)) {
    const msg = `NOT_FOUND: Deliverable file does not exist on disk: ${resolvedRelativePath}`;
    return {
      success: false,
      exitCode: INDUSTRIAL_CLI_EXIT.NOT_FOUND,
      message: msg,
      target: params.target,
      resolvedRelativePath,
      resolvedAbsPath,
      fileExtension: ext,
      launched: false,
      dryRun,
      disclaimer: NO_EMBEDDED_EDITOR_DISCLAIMER,
    };
  }

  const stat = fs.statSync(resolvedAbsPath);
  if (!stat.isFile() || stat.size === 0) {
    const msg = `INVALID_FILE: Target '${resolvedRelativePath}' is empty or not a valid file.`;
    return {
      success: false,
      exitCode: INDUSTRIAL_CLI_EXIT.FAILURE,
      message: msg,
      target: params.target,
      resolvedRelativePath,
      resolvedAbsPath,
      fileExtension: ext,
      launched: false,
      dryRun,
      disclaimer: NO_EMBEDDED_EDITOR_DISCLAIMER,
    };
  }

  const fileBytes = fs.readFileSync(resolvedAbsPath);
  const sha256 = crypto.createHash('sha256').update(fileBytes).digest('hex');

  // Verify hash matches artifact registry if resolved strictly from artifact ID
  if (existingArtifact && existingArtifact.id === rawTarget && existingArtifact.hash && existingArtifact.hash.toLowerCase() !== sha256.toLowerCase()) {
    const msg = `TAMPER_DETECTED: Artifact file hash on disk (${sha256.substring(0, 16)}...) does not match registered hash (${existingArtifact.hash.substring(0, 16)}...).`;
    return {
      success: false,
      exitCode: INDUSTRIAL_CLI_EXIT.FAILURE,
      message: msg,
      target: params.target,
      resolvedRelativePath,
      resolvedAbsPath,
      fileExtension: ext,
      sha256,
      launched: false,
      dryRun,
      disclaimer: NO_EMBEDDED_EDITOR_DISCLAIMER,
    };
  }

  // 6. Formulate Launch Command
  const { command, args } = formulateLaunchCommand(resolvedAbsPath, launcher, process.platform);

  // 7. Audit Event
  try {
    auditService.recordAuditEvent({
      category: 'tool',
      source: 'open-artifact',
      data: {
        event: 'ARTIFACT_OPENED',
        target: params.target,
        relativePath: resolvedRelativePath,
        sha256,
        artifactId,
        launcher,
        dryRun,
        timestamp: new Date().toISOString(),
      },
    });
  } catch {
    // Non-fatal if audit record fails in test mode
  }

  // 8. Execute or Dry-Run
  let launched = false;
  if (!dryRun) {
    try {
      const child = child_process.spawn(command, args, {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      launched = true;
    } catch (err: any) {
      return {
        success: false,
        exitCode: INDUSTRIAL_CLI_EXIT.FAILURE,
        message: `LAUNCH_FAILED: Failed to spawn desktop viewer: ${err.message}`,
        target: params.target,
        resolvedRelativePath,
        resolvedAbsPath,
        artifactId,
        fileExtension: ext,
        sha256,
        command,
        args,
        launched: false,
        dryRun: false,
        disclaimer: NO_EMBEDDED_EDITOR_DISCLAIMER,
      };
    }
  }

  const successMessage = dryRun
    ? `Validated deliverable '${resolvedRelativePath}' for launch (dry-run).`
    : `Opened '${path.basename(resolvedAbsPath)}' in local desktop application.`;

  return {
    success: true,
    exitCode: INDUSTRIAL_CLI_EXIT.SUCCESS,
    message: successMessage,
    target: params.target,
    resolvedRelativePath,
    resolvedAbsPath,
    artifactId,
    fileExtension: ext,
    sha256,
    command,
    args,
    launched,
    dryRun,
    disclaimer: NO_EMBEDDED_EDITOR_DISCLAIMER,
  };
}
