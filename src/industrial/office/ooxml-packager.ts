/**
 * MAOS Industrial — Air-Gapped OOXML Packager & Validator
 *
 * Implements pure Node.js PKZIP creation, decompression, and OOXML validation
 * for Office Open XML (.docx) packages without external libraries or shell dependencies.
 *
 * Enforces:
 * - Deterministic, valid ZIP archive creation with standard CRC-32 and DEFLATE
 * - Extraction and offline verification of package contents
 * - Strict rejection of macros, VBA code, binaries, and scripts
 * - Strict rejection of external relationships, remote hyperlinks, and unconfined URLs
 * - Offline XML well-formedness verification
 */

import * as zlib from 'zlib';

// ── CRC-32 Implementation ──────────────────────────────────────────

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[i] = c >>> 0;
}

export function computeCrc32(buf: Buffer): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = (CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ── ZIP Archive Builder ─────────────────────────────────────────────

export interface ZipFileInput {
  readonly path: string;
  readonly data: Buffer | string;
}

/**
 * Builds a valid, compliant PKZIP buffer containing the specified files.
 * Uses standard Deflate (method 8) with UTF-8 filename flag.
 */
export function buildZipArchive(files: readonly ZipFileInput[]): Buffer {
  const localHeaders: Buffer[] = [];
  const centralHeaders: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    // Standardize path to forward slashes without leading slash
    const normalizedPath = file.path.replace(/\\/g, '/').replace(/^\/+/, '');
    const filenameBuf = Buffer.from(normalizedPath, 'utf8');
    const uncompressedBuf = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'utf8');
    const compressedBuf = zlib.deflateRawSync(uncompressedBuf, { level: 6 });
    const fileCrc = computeCrc32(uncompressedBuf);

    // Local file header (30 bytes + filename)
    const localHeader = Buffer.alloc(30 + filenameBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0); // Local header signature
    localHeader.writeUInt16LE(20, 4);          // Version needed (2.0)
    localHeader.writeUInt16LE(0x0800, 6);      // General purpose bit flag (bit 11 = UTF-8)
    localHeader.writeUInt16LE(8, 8);           // Compression method: 8 (Deflate)
    localHeader.writeUInt16LE(0, 10);          // Last mod file time (00:00)
    localHeader.writeUInt16LE(0, 12);          // Last mod file date (1980-01-01)
    localHeader.writeUInt32LE(fileCrc, 14);     // CRC-32
    localHeader.writeUInt32LE(compressedBuf.length, 18);   // Compressed size
    localHeader.writeUInt32LE(uncompressedBuf.length, 22); // Uncompressed size
    localHeader.writeUInt16LE(filenameBuf.length, 26);     // Filename length
    localHeader.writeUInt16LE(0, 28);          // Extra field length
    filenameBuf.copy(localHeader, 30);

    localHeaders.push(localHeader, compressedBuf);

    // Central directory header (46 bytes + filename)
    const centralHeader = Buffer.alloc(46 + filenameBuf.length);
    centralHeader.writeUInt32LE(0x02014b50, 0); // Central directory signature
    centralHeader.writeUInt16LE(20, 4);          // Version made by (2.0)
    centralHeader.writeUInt16LE(20, 6);          // Version needed (2.0)
    centralHeader.writeUInt16LE(0x0800, 8);      // General purpose bit flag (UTF-8)
    centralHeader.writeUInt16LE(8, 10);          // Compression method: 8 (Deflate)
    centralHeader.writeUInt16LE(0, 12);          // Last mod file time
    centralHeader.writeUInt16LE(0, 14);          // Last mod file date
    centralHeader.writeUInt32LE(fileCrc, 16);     // CRC-32
    centralHeader.writeUInt32LE(compressedBuf.length, 20);   // Compressed size
    centralHeader.writeUInt32LE(uncompressedBuf.length, 24); // Uncompressed size
    centralHeader.writeUInt16LE(filenameBuf.length, 28);     // Filename length
    centralHeader.writeUInt16LE(0, 30);          // Extra field length
    centralHeader.writeUInt16LE(0, 32);          // File comment length
    centralHeader.writeUInt16LE(0, 34);          // Disk number start
    centralHeader.writeUInt16LE(0, 36);          // Internal file attributes
    centralHeader.writeUInt32LE(0, 38);          // External file attributes
    centralHeader.writeUInt32LE(offset, 42);     // Relative offset of local header
    filenameBuf.copy(centralHeader, 46);

    centralHeaders.push(centralHeader);
    offset += localHeader.length + compressedBuf.length;
  }

  const centralDirOffset = offset;
  let centralDirSize = 0;
  for (const ch of centralHeaders) {
    centralDirSize += ch.length;
  }

  // End of central directory record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);       // EOCD signature
  eocd.writeUInt16LE(0, 4);                 // Disk number
  eocd.writeUInt16LE(0, 6);                 // Disk where central dir starts
  eocd.writeUInt16LE(files.length, 8);      // Number of central dir records on this disk
  eocd.writeUInt16LE(files.length, 10);     // Total number of central dir records
  eocd.writeUInt32LE(centralDirSize, 12);   // Size of central directory
  eocd.writeUInt32LE(centralDirOffset, 16); // Offset of start of central directory
  eocd.writeUInt16LE(0, 20);                // Comment length

  return Buffer.concat([...localHeaders, ...centralHeaders, eocd]);
}

// ── ZIP Archive Parser ─────────────────────────────────────────────

/**
 * Parses and decompresses all entries from a PKZIP buffer.
 * Validates CRC-32 and uncompressed sizes.
 */
export function parseZipArchive(buf: Buffer): Map<string, Buffer> {
  if (buf.length < 22) {
    throw new Error('ZIP buffer too small to contain End of Central Directory record');
  }

  // Find EOCD by scanning backwards from end of buffer
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset === -1) {
    throw new Error('Invalid ZIP archive: End of Central Directory record not found');
  }

  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  if (cdOffset >= buf.length) {
    throw new Error('Corrupt ZIP archive: central directory offset out of bounds');
  }

  const files = new Map<string, Buffer>();
  let cdPos = cdOffset;

  for (let i = 0; i < totalEntries; i++) {
    if (cdPos + 46 > buf.length) {
      throw new Error('Corrupt ZIP archive: unexpected EOF in central directory');
    }

    if (buf.readUInt32LE(cdPos) !== 0x02014b50) {
      throw new Error(`Corrupt ZIP archive: invalid central directory header at offset ${cdPos}`);
    }

    const method = buf.readUInt16LE(cdPos + 10);
    const expectedCrc = buf.readUInt32LE(cdPos + 16);
    const compSize = buf.readUInt32LE(cdPos + 20);
    const uncompSize = buf.readUInt32LE(cdPos + 24);
    const nameLen = buf.readUInt16LE(cdPos + 28);
    const extraLen = buf.readUInt16LE(cdPos + 30);
    const commentLen = buf.readUInt16LE(cdPos + 32);
    const localOffset = buf.readUInt32LE(cdPos + 42);

    if (cdPos + 46 + nameLen > buf.length) {
      throw new Error('Corrupt ZIP archive: filename exceeds buffer bounds');
    }

    const filename = buf.toString('utf8', cdPos + 46, cdPos + 46 + nameLen);
    cdPos += 46 + nameLen + extraLen + commentLen;

    if (localOffset + 30 > buf.length) {
      throw new Error(`Corrupt ZIP archive: local header offset out of bounds for ${filename}`);
    }

    if (buf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`Corrupt ZIP archive: invalid local file header signature for ${filename}`);
    }

    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLen + localExtraLen;

    if (dataOffset + compSize > buf.length) {
      throw new Error(`Corrupt ZIP archive: compressed data out of bounds for ${filename}`);
    }

    const compData = buf.subarray(dataOffset, dataOffset + compSize);

    let uncompressedData: Buffer;
    if (method === 8) {
      uncompressedData = zlib.inflateRawSync(compData);
    } else if (method === 0) {
      uncompressedData = Buffer.from(compData);
    } else {
      throw new Error(`Unsupported compression method ${method} for file ${filename}`);
    }

    if (uncompressedData.length !== uncompSize) {
      throw new Error(
        `Corrupt ZIP entry: uncompressed size mismatch for ${filename} (expected ${uncompSize}, got ${uncompressedData.length})`
      );
    }

    const computedCrc = computeCrc32(uncompressedData);
    if (computedCrc !== expectedCrc) {
      throw new Error(
        `Corrupt ZIP entry: CRC-32 checksum mismatch for ${filename} (expected ${expectedCrc.toString(16)}, got ${computedCrc.toString(16)})`
      );
    }

    files.set(filename, uncompressedData);
  }

  return files;
}

// ── OOXML Document Validation ───────────────────────────────────────

export interface DocxValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly parts: Map<string, string>;
}

export const FORBIDDEN_FILE_EXTENSIONS = [
  '.bin',
  '.exe',
  '.dll',
  '.bat',
  '.cmd',
  '.vbs',
  '.ps1',
  '.sh',
  '.scr',
  '.msi',
  '.com',
  '.jar',
];

export const FORBIDDEN_PART_NAMES = [
  'vbaproject.bin',
  'vbadata.xml',
  'word/vbaproject.bin',
  'word/vbadata.xml',
  'word/activex',
  'xl/vbaproject.bin',
  'xl/vbadata.xml',
  'xl/activex',
  'ppt/vbaproject.bin',
  'ppt/vbadata.xml',
  'ppt/activex',
  'customui/customui.xml',
];

export const FORBIDDEN_REL_URL_SCHEMES = [
  'http://',
  'https://',
  'ftp://',
  'file://',
  'javascript:',
  'data:',
  'vbscript:',
  'ms-appx:',
];

/**
 * Validates an in-memory buffer as a secure, air-gapped, conformant OOXML DOCX package.
 */
export function validateDocxPackage(buf: Buffer): DocxValidationResult {
  const errors: string[] = [];
  const parts = new Map<string, string>();

  // 1. Signature check
  if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) {
    return {
      valid: false,
      errors: ['Invalid file signature: Not a valid ZIP/OOXML package (expected PK\\x03\\x04).'],
      parts,
    };
  }

  // 2. Parse ZIP archive
  let zipEntries: Map<string, Buffer>;
  try {
    zipEntries = parseZipArchive(buf);
  } catch (err: any) {
    return {
      valid: false,
      errors: [`ZIP extraction failed: ${err.message}`],
      parts,
    };
  }

  // 3. Required OOXML parts
  const requiredParts = [
    '[Content_Types].xml',
    '_rels/.rels',
    'word/document.xml',
  ];

  for (const req of requiredParts) {
    if (!zipEntries.has(req)) {
      errors.push(`Missing mandatory OOXML part: '${req}'.`);
    }
  }

  // 4. Inspect every entry in the archive
  for (const [partPath, partBuf] of zipEntries.entries()) {
    const lowerPath = partPath.toLowerCase();

    // Check forbidden extensions
    for (const ext of FORBIDDEN_FILE_EXTENSIONS) {
      if (lowerPath.endsWith(ext)) {
        errors.push(`Forbidden binary or script part in DOCX: '${partPath}'.`);
      }
    }

    // Check forbidden part names
    for (const forbidden of FORBIDDEN_PART_NAMES) {
      if (lowerPath === forbidden || lowerPath.includes(forbidden)) {
        errors.push(`Forbidden macro or ActiveX component in DOCX: '${partPath}'.`);
      }
    }

    // Check path traversal in zip entry
    if (partPath.includes('..') || partPath.startsWith('/') || partPath.startsWith('\\')) {
      errors.push(`Path traversal or invalid path in ZIP entry: '${partPath}'.`);
    }

    // Convert XML / RELS parts to string for inspection
    if (lowerPath.endsWith('.xml') || lowerPath.endsWith('.rels')) {
      const xmlText = partBuf.toString('utf8');
      parts.set(partPath, xmlText);

      // Verify well-formed XML basics
      const xmlError = verifyBasicXmlWellFormedness(xmlText, partPath);
      if (xmlError) {
        errors.push(xmlError);
      }

      // Security check for relationships (.rels)
      if (lowerPath.endsWith('.rels')) {
        const relSecurityError = verifyRelsSecurity(xmlText, partPath);
        if (relSecurityError) {
          errors.push(relSecurityError);
        }
      }

      // Security check for document.xml
      if (lowerPath === 'word/document.xml') {
        const docSecurityError = verifyDocumentXmlSecurity(xmlText);
        if (docSecurityError) {
          errors.push(docSecurityError);
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    parts,
  };
}

// ── Basic XML Well-Formedness Checker ──────────────────────────────

export function verifyBasicXmlWellFormedness(xmlText: string, filename: string): string | null {
  if (!xmlText.trim()) {
    return `XML part '${filename}' is empty.`;
  }

  // Check XML declaration
  if (!xmlText.startsWith('<?xml')) {
    return `XML part '${filename}' is missing standard XML declaration.`;
  }

  // Basic tag stack balancing check
  const tagRegex = /<([\/!]?)([a-zA-Z0-9_:\-]+)([^>]*?)(\/?)>/g;
  const stack: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(xmlText)) !== null) {
    const isClosing = match[1] === '/';
    const isSpecial = match[1] === '!';
    const tagName = match[2];
    const isSelfClosing = match[4] === '/' || match[3].trim().endsWith('/');

    if (isSpecial || isSelfClosing) {
      continue;
    }

    if (isClosing) {
      if (stack.length === 0) {
        return `Malformed XML in '${filename}': unexpected closing tag </${tagName}> without open tag.`;
      }
      const top = stack.pop();
      if (top !== tagName) {
        return `Malformed XML in '${filename}': mismatched tags <${top}> and </${tagName}>.`;
      }
    } else {
      stack.push(tagName);
    }
  }

  if (stack.length > 0) {
    return `Malformed XML in '${filename}': unclosed tag <${stack[stack.length - 1]}>.`;
  }

  return null;
}

// ── Relationship Security Checker ──────────────────────────────────

export function verifyRelsSecurity(relsText: string, filename: string): string | null {
  // Reject TargetMode="External"
  if (/TargetMode\s*=\s*["']External["']/i.test(relsText)) {
    return `Security violation in '${filename}': External relationship (TargetMode="External") is strictly forbidden in air-gapped environment.`;
  }

  // Parse Relationship tags and inspect the Target attribute specifically
  const relRegex = /<Relationship\b([^>]*?)>/gi;
  let match: RegExpExecArray | null;

  while ((match = relRegex.exec(relsText)) !== null) {
    const attrs = match[1];
    const targetMatch = /Target\s*=\s*["']([^"']*)["']/i.exec(attrs);
    if (targetMatch) {
      const target = targetMatch[1].toLowerCase().trim();
      for (const scheme of FORBIDDEN_REL_URL_SCHEMES) {
        if (target.startsWith(scheme) || target.includes(scheme)) {
          return `Security violation in '${filename}': External relationship target URL '${scheme}' is strictly forbidden.`;
        }
      }
    }
  }

  return null;
}

// ── Document XML Security Checker ──────────────────────────────────

function verifyDocumentXmlSecurity(docText: string): string | null {
  // Check for hyperlink elements (hyperlinks with external targets are forbidden)
  if (/<w:hyperlink\b/i.test(docText)) {
    return 'Security violation in word/document.xml: Hyperlink element detected.';
  }

  // Check for TargetMode="External" anywhere
  if (/TargetMode\s*=\s*["']External["']/i.test(docText)) {
    return 'Security violation in word/document.xml: External relationship detected.';
  }

  // Check for forbidden URL protocols in text runs (<w:t> content)
  const textRunRegex = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gi;
  let textMatch: RegExpExecArray | null;
  while ((textMatch = textRunRegex.exec(docText)) !== null) {
    const textContent = textMatch[1].toLowerCase();
    for (const scheme of FORBIDDEN_REL_URL_SCHEMES) {
      if (textContent.includes(scheme)) {
        return `Security violation in word/document.xml: Forbidden URL protocol '${scheme}' detected in document text run.`;
      }
    }
  }

  // Check for macro or script execution indicators
  const scriptKeywords = ['<script', 'wscript.shell', 'powershell.exe', 'cmd.exe', 'vba_project', 'vbaproject'];
  const lower = docText.toLowerCase();
  for (const kw of scriptKeywords) {
    if (lower.includes(kw)) {
      return `Security violation in word/document.xml: Forbidden script or macro keyword '${kw}' detected.`;
    }
  }

  return null;
}
