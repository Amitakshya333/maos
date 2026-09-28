/**
 * Template and Output Safety Validation Engine
 *
 * Implements pure Node.js (zero external dependencies) deep inspection for:
 *   1. User-supplied office templates (.docx, .dotx, .xlsx, .xltx, .pptx, .potx)
 *   2. Generated office deliverable packages before atomic finalization
 *
 * Enforces strict industrial safety:
 *   - Rejection of macro formats (.docm, .xlsm, .pptm, .dotm, .xltm, .potm)
 *   - Rejection of VBA macro parts (vbaProject.bin, vbaData.xml, activeX)
 *   - Rejection of embedded OLE active objects (<w:object>, <p:oleObj>, <a:oleObj>, oleObject.bin)
 *   - Rejection of external relationships (TargetMode="External" and remote URLs)
 *   - Rejection of executable command patterns and script elements
 *   - Rejection of spreadsheet formula injection in templates
 *   - Rejection of path traversal, null bytes, absolute paths, and symlink/junction escapes
 *   - Strict XML well-formedness and UTF-8 encoding verification
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  parseZipArchive,
  FORBIDDEN_FILE_EXTENSIONS,
  FORBIDDEN_PART_NAMES,
  FORBIDDEN_REL_URL_SCHEMES,
  verifyBasicXmlWellFormedness,
  verifyRelsSecurity,
} from './ooxml-packager';
import {
  isSafeIndustrialPath,
  isPotentialFormulaInjection,
  TemplateSafetyError,
  TemplateSafetyErrorCode,
} from '../../domain/office-artifact';

// ── Bounds and Limits ───────────────────────────────────────────────

export const TEMPLATE_SAFETY_BOUNDS = {
  MAX_TEMPLATE_BYTES: 50 * 1024 * 1024, // 50 MB
  MAX_PART_COUNT: 2000,
  MAX_UNCOMPRESSED_PART_BYTES: 30 * 1024 * 1024, // 30 MB single part
  MAX_PATH_LENGTH: 512,
} as const;

// ── Extension Allowlists and Blocklists ──────────────────────────────

export const ALLOWED_TEMPLATE_EXTENSIONS: Record<'docx' | 'xlsx' | 'pptx', readonly string[]> = {
  docx: ['.docx', '.dotx'],
  xlsx: ['.xlsx', '.xltx'],
  pptx: ['.pptx', '.potx'],
};

export const FORBIDDEN_MACRO_EXTENSIONS = [
  '.docm',
  '.dotm',
  '.xlsm',
  '.xltm',
  '.xlam',
  '.pptm',
  '.potm',
  '.ppam',
] as const;

export const DANGEROUS_EXECUTABLE_KEYWORDS = [
  'powershell',
  'cmd.exe',
  'cscript',
  'wscript',
  'wscript.shell',
  '<script',
  '</script>',
  'auto_open',
  'autoopen',
  'document_open',
  'workbook_open',
] as const;

// ── Validation Result Types ─────────────────────────────────────────

export interface TemplatePathValidationResult {
  readonly valid: boolean;
  readonly resolvedAbsPath?: string;
  readonly errors: readonly string[];
}

export interface PackageValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly partCount: number;
  readonly parts: Map<string, string>;
}

// ── Path & Confinement Validation ───────────────────────────────────

/**
 * Validates that a user-supplied template path is strictly confined within the project root,
 * uses an approved extension, is not a symlink/junction escape, and points to an existing file.
 */
export function validateTemplatePath(
  templatePath: string,
  projectRoot: string,
  expectedType: 'docx' | 'xlsx' | 'pptx',
): TemplatePathValidationResult {
  const errors: string[] = [];

  if (!templatePath || typeof templatePath !== 'string') {
    return {
      valid: false,
      errors: ['[TEMPLATE_PATH_TRAVERSAL] Template path must be a non-empty string.'],
    };
  }

  // 1. Check length
  if (templatePath.length > TEMPLATE_SAFETY_BOUNDS.MAX_PATH_LENGTH) {
    errors.push(`[TEMPLATE_PATH_TRAVERSAL] Template path exceeds maximum length of ${TEMPLATE_SAFETY_BOUNDS.MAX_PATH_LENGTH} characters.`);
  }

  // 2. Safe industrial path constraints (no traversal, no null bytes, no drive letters, no URL schemes)
  if (!isSafeIndustrialPath(templatePath)) {
    errors.push(
      `[TEMPLATE_PATH_TRAVERSAL] Template path '${templatePath}' violates path safety constraints (traversal, null bytes, or URL schemes detected).`
    );
  }

  // 3. Extension check
  const lowerPath = templatePath.toLowerCase().replace(/\\/g, '/');

  // Check forbidden macro extensions explicitly
  for (const macroExt of FORBIDDEN_MACRO_EXTENSIONS) {
    if (lowerPath.endsWith(macroExt)) {
      errors.push(
        `[TEMPLATE_FORBIDDEN_EXTENSION] Macro-enabled template extension '${macroExt}' is strictly forbidden in air-gapped environment.`
      );
    }
  }

  // Check allowed extensions for expectedType
  const allowed = ALLOWED_TEMPLATE_EXTENSIONS[expectedType];
  const hasAllowedExt = allowed.some((ext) => lowerPath.endsWith(ext));
  if (!hasAllowedExt) {
    errors.push(
      `[TEMPLATE_FORBIDDEN_EXTENSION] Invalid template extension for type '${expectedType}'. Allowed extensions: ${allowed.join(', ')}.`
    );
  }

  // 4. Resolve absolute path and verify boundary confinement
  const canonicalProjectRoot = path.resolve(projectRoot);
  const candidateAbsPath = path.resolve(canonicalProjectRoot, templatePath);

  // Must start with canonical project root directory
  const relativeFromRoot = path.relative(canonicalProjectRoot, candidateAbsPath);
  if (relativeFromRoot.startsWith('..') || path.isAbsolute(relativeFromRoot)) {
    errors.push(
      `[TEMPLATE_PATH_OUTSIDE_PROJECT] Template path '${templatePath}' resolves outside project root '${canonicalProjectRoot}'.`
    );
  }

  // 5. Check physical file existence and symlink / junction escapes
  if (errors.length === 0) {
    if (!fs.existsSync(candidateAbsPath)) {
      errors.push(`[TEMPLATE_FILE_NOT_FOUND] Template file '${templatePath}' does not exist on disk.`);
    } else {
      try {
        const stats = fs.statSync(candidateAbsPath);
        if (!stats.isFile()) {
          errors.push(`[TEMPLATE_PATH_TRAVERSAL] Template target '${templatePath}' is not a regular file.`);
        } else if (stats.size > TEMPLATE_SAFETY_BOUNDS.MAX_TEMPLATE_BYTES) {
          errors.push(
            `[TEMPLATE_INVALID_ZIP] Template file size (${stats.size} bytes) exceeds maximum limit of ${TEMPLATE_SAFETY_BOUNDS.MAX_TEMPLATE_BYTES} bytes.`
          );
        }

        // Symlink / junction verification: realpath must also be inside project root
        const realAbsPath = fs.realpathSync(candidateAbsPath);
        const relativeReal = path.relative(canonicalProjectRoot, realAbsPath);
        if (relativeReal.startsWith('..') || path.isAbsolute(relativeReal)) {
          errors.push(
            `[TEMPLATE_PATH_OUTSIDE_PROJECT] Template path '${templatePath}' links outside project root via symlink or directory junction.`
          );
        }
      } catch (err: any) {
        errors.push(`[TEMPLATE_FILE_NOT_FOUND] Failed to inspect template file '${templatePath}': ${err.message}`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    resolvedAbsPath: errors.length === 0 ? candidateAbsPath : undefined,
    errors,
  };
}

// ── Package Security Inspection ─────────────────────────────────────

/**
 * Deep inspection of an OpenXML archive buffer (template or generated deliverable).
 * Validates PK structure, part names, relationships, embedded OLE objects, scripts, macros,
 * external URLs, formula injections, and XML well-formedness.
 */
export function inspectOfficePackageBuffer(
  buffer: Buffer,
  expectedType: 'docx' | 'xlsx' | 'pptx',
  isTemplate = false,
): PackageValidationResult {
  const errors: string[] = [];
  const parts = new Map<string, string>();

  // 1. Verify buffer existence & PKZIP header
  if (!buffer || buffer.length < 22) {
    return {
      valid: false,
      errors: ['[TEMPLATE_INVALID_ZIP] Buffer too small to be a valid OpenXML ZIP package.'],
      partCount: 0,
      parts,
    };
  }

  if (buffer.readUInt32LE(0) !== 0x04034b50) {
    return {
      valid: false,
      errors: ['[TEMPLATE_INVALID_ZIP] Invalid ZIP local file header signature.'],
      partCount: 0,
      parts,
    };
  }

  // 2. Parse ZIP entries
  let zipEntries: Map<string, Buffer>;
  try {
    zipEntries = parseZipArchive(buffer);
  } catch (err: any) {
    return {
      valid: false,
      errors: [`[TEMPLATE_INVALID_ZIP] Failed to decompress ZIP package: ${err.message}`],
      partCount: 0,
      parts,
    };
  }

  if (zipEntries.size > TEMPLATE_SAFETY_BOUNDS.MAX_PART_COUNT) {
    errors.push(
      `[TEMPLATE_INVALID_ZIP] Package part count (${zipEntries.size}) exceeds limit of ${TEMPLATE_SAFETY_BOUNDS.MAX_PART_COUNT}.`
    );
  }

  // 3. Scan entry names against forbidden extensions and macro part names
  for (const [partPath, rawBuf] of zipEntries.entries()) {
    const lowerPath = partPath.toLowerCase().replace(/\\/g, '/');

    // Single part size check
    if (rawBuf.length > TEMPLATE_SAFETY_BOUNDS.MAX_UNCOMPRESSED_PART_BYTES) {
      errors.push(
        `[TEMPLATE_INVALID_ZIP] Part '${partPath}' uncompressed size (${rawBuf.length} bytes) exceeds limit of ${TEMPLATE_SAFETY_BOUNDS.MAX_UNCOMPRESSED_PART_BYTES} bytes.`
      );
    }

    // Forbidden file extensions inside package
    for (const ext of FORBIDDEN_FILE_EXTENSIONS) {
      if (lowerPath.endsWith(ext)) {
        errors.push(
          `[TEMPLATE_FORBIDDEN_EXTENSION] Package contains forbidden file extension: '${partPath}' (${ext}).`
        );
      }
    }

    // Forbidden macro & active content part names
    for (const forbidden of FORBIDDEN_PART_NAMES) {
      if (lowerPath === forbidden || lowerPath.endsWith(`/${forbidden}`)) {
        errors.push(
          `[TEMPLATE_MACRO_DETECTED] Package contains forbidden macro or active part: '${partPath}'.`
        );
      }
    }

    // Check for OLE binary parts
    if (
      lowerPath.includes('oleobject') ||
      lowerPath.endsWith('.bin') ||
      lowerPath.includes('activex')
    ) {
      errors.push(
        `[TEMPLATE_ACTIVE_CONTENT_DETECTED] Package contains forbidden OLE or active binary part: '${partPath}'.`
      );
    }
  }

  // 4. Decode and inspect text / XML / rels parts
  for (const [partPath, rawBuf] of zipEntries.entries()) {
    const lowerPath = partPath.toLowerCase().replace(/\\/g, '/');

    if (
      lowerPath.endsWith('.xml') ||
      lowerPath.endsWith('.rels') ||
      lowerPath === '[content_types].xml'
    ) {
      const xmlText = rawBuf.toString('utf8');
      parts.set(partPath, xmlText);

      // Check XML well-formedness
      const wellFormedError = verifyBasicXmlWellFormedness(xmlText, partPath);
      if (wellFormedError) {
        errors.push(`[TEMPLATE_XML_MALFORMED] ${wellFormedError}`);
      }

      // Check Relationships (.rels)
      if (lowerPath.endsWith('.rels')) {
        const relError = verifyRelsSecurity(xmlText, partPath);
        if (relError) {
          errors.push(`[TEMPLATE_EXTERNAL_RELATIONSHIP] ${relError}`);
        }
      }

      // Check for embedded OLE tags across all XML
      if (
        /<w:object\b/i.test(xmlText) ||
        /<p:oleObj\b/i.test(xmlText) ||
        /<a:oleObj\b/i.test(xmlText) ||
        /<oleObjects\b/i.test(xmlText) ||
        /<oleObject\b/i.test(xmlText)
      ) {
        errors.push(
          `[TEMPLATE_ACTIVE_CONTENT_DETECTED] Part '${partPath}' contains prohibited embedded OLE object tag.`
        );
      }

      // Check for script tags and executable patterns
      for (const kw of DANGEROUS_EXECUTABLE_KEYWORDS) {
        if (xmlText.toLowerCase().includes(kw)) {
          errors.push(
            `[TEMPLATE_ACTIVE_CONTENT_DETECTED] Part '${partPath}' contains prohibited executable or script pattern: '${kw}'.`
          );
        }
      }

      // Check for external relationships in document body
      if (/TargetMode\s*=\s*["']External["']/i.test(xmlText)) {
        errors.push(
          `[TEMPLATE_EXTERNAL_RELATIONSHIP] Part '${partPath}' contains prohibited external relationship (TargetMode="External").`
        );
      }

      // Check text runs for forbidden URL protocols
      // DOCX: <w:t>, XLSX: <t>, PPTX: <a:t>
      const textRunRegex = /<(?:w:t|a:t|t)\b[^>]*>([\s\S]*?)<\/(?:w:t|a:t|t)>/gi;
      let textMatch: RegExpExecArray | null;
      while ((textMatch = textRunRegex.exec(xmlText)) !== null) {
        const textContent = textMatch[1].toLowerCase();
        for (const scheme of FORBIDDEN_REL_URL_SCHEMES) {
          if (textContent.includes(scheme)) {
            errors.push(
              `[TEMPLATE_EXTERNAL_RELATIONSHIP] Part '${partPath}' contains prohibited URL scheme '${scheme}' in text run.`
            );
          }
        }
      }

      // If XLSX template or output, check formula elements for dangerous commands
      if (expectedType === 'xlsx') {
        const formulaRegex = /<f\b[^>]*>([\s\S]*?)<\/f>/gi;
        let fMatch: RegExpExecArray | null;
        while ((fMatch = formulaRegex.exec(xmlText)) !== null) {
          const formulaStr = fMatch[1].trim();
          if (isPotentialFormulaInjection(formulaStr)) {
            errors.push(
              `[TEMPLATE_FORMULA_INJECTION] Part '${partPath}' contains dangerous formula injection in <f> element: '${formulaStr}'.`
            );
          }
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    partCount: zipEntries.size,
    parts,
  };
}

/**
 * Validates a user-supplied template buffer against all security rules.
 */
export function validateOfficeTemplatePackage(
  buffer: Buffer,
  expectedType: 'docx' | 'xlsx' | 'pptx',
): PackageValidationResult {
  return inspectOfficePackageBuffer(buffer, expectedType, true);
}

/**
 * Validates a generated office deliverable package before disk finalization.
 */
export function validateOfficeOutputPackage(
  buffer: Buffer,
  expectedType: 'docx' | 'xlsx' | 'pptx',
): PackageValidationResult {
  return inspectOfficePackageBuffer(buffer, expectedType, false);
}
