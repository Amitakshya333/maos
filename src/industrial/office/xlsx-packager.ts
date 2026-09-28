/**
 * MAOS Industrial — Air-Gapped SpreadsheetML (XLSX) Packager & Validator
 *
 * Implements pure Node.js OpenXML SpreadsheetML (.xlsx) generation, decompression,
 * and offline verification without external npm packages, LibreOffice, Excel,
 * or shell dependencies.
 *
 * Enforces:
 * - Deterministic, valid ZIP archive creation with standard CRC-32 and raw Deflate
 * - Extraction and offline verification of package contents
 * - Strict rejection of macros, VBA code, binaries, and scripts
 * - Strict rejection of external relationships, remote hyperlinks, and unconfined URLs
 * - Strict defense against formula injection in formulas and text cells
 * - Offline XML well-formedness verification
 */

import {
  buildZipArchive,
  parseZipArchive,
  ZipFileInput,
  FORBIDDEN_FILE_EXTENSIONS,
  FORBIDDEN_PART_NAMES,
  FORBIDDEN_REL_URL_SCHEMES,
  verifyBasicXmlWellFormedness,
  verifyRelsSecurity,
} from './ooxml-packager';

export { parseZipArchive } from './ooxml-packager';

// ── Cell & Address Helpers ──────────────────────────────────────────

/**
 * Converts a 0-indexed column index to standard Excel column letters (0 -> "A", 25 -> "Z", 26 -> "AA").
 */
export function colIndexToLetters(colIndex: number): string {
  if (colIndex < 0) return 'A';
  let temp = colIndex;
  let letters = '';
  while (temp >= 0) {
    letters = String.fromCharCode((temp % 26) + 65) + letters;
    temp = Math.floor(temp / 26) - 1;
  }
  return letters;
}

/**
 * Converts column index and 1-indexed row number to standard cell reference (e.g., 0, 1 -> "A1").
 */
export function toCellRef(colIndex: number, rowNumber: number): string {
  return `${colIndexToLetters(colIndex)}${rowNumber}`;
}

/**
 * XML-sanitizes and escapes text for SpreadsheetML.
 * Strips control characters except standard whitespace (\t, \n, \r).
 */
export function escapeXml(val: unknown): string {
  if (val === null || val === undefined) return '';
  const text = String(val);
  // Strip control characters except \t, \n, \r
  const sanitized = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  return sanitized
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ── SpreadsheetML Data Interfaces ───────────────────────────────────

export interface XlsxCell {
  readonly value: unknown;
  readonly type?: 'string' | 'number' | 'boolean' | 'formula';
  readonly formula?: string;
  readonly styleId?: number;
}

export interface XlsxRow {
  readonly rowNumber: number;
  readonly cells: readonly (XlsxCell | null | undefined)[];
  readonly height?: number;
}

export interface XlsxColumnDef {
  readonly colIndex: number; // 0-indexed
  readonly width?: number;
}

export interface XlsxWorksheet {
  readonly name: string;
  readonly rows: readonly XlsxRow[];
  readonly columns?: readonly XlsxColumnDef[];
}

export interface XlsxWorkbookData {
  readonly title: string;
  readonly author: string;
  readonly company?: string;
  readonly created?: string;
  readonly sheets: readonly XlsxWorksheet[];
}

// ── OpenXML Style IDs Constants ─────────────────────────────────────

export const XLSX_STYLES = {
  DEFAULT: 0,
  TABLE_HEADER: 1,
  DATA_BORDERED: 2,
  DATA_BOLD: 3,
  PASS_BADGE: 4,
  WARNING_BADGE: 5,
  FAIL_BADGE: 6,
  NUMBER_2DEC: 7,
  INTEGER: 8,
  CODE_MONO: 9,
  TITLE: 10,
  SECTION_HEADER: 11,
  META_LABEL: 12,
  UNVERIFIED_PROSE_ALERT: 13,
} as const;

// ── XML Parts Generation ────────────────────────────────────────────

function buildContentTypesXml(sheetCount: number): string {
  const sheetOverrides: string[] = [];
  for (let i = 1; i <= sheetCount; i++) {
    sheetOverrides.push(
      `<Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
    );
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  ${sheetOverrides.join('\n  ')}
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;
}

function buildRootRelsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
}

function buildWorkbookRelsXml(sheetCount: number): string {
  const rels: string[] = [];
  for (let i = 1; i <= sheetCount; i++) {
    rels.push(
      `<Relationship Id="rId${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i}.xml"/>`
    );
  }
  const stylesRelId = `rId${sheetCount + 1}`;
  rels.push(
    `<Relationship Id="${stylesRelId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
  );

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${rels.join('\n  ')}
</Relationships>`;
}

function sanitizeSheetName(name: string, index: number): string {
  // Excel sheet names: max 31 chars, cannot contain: \ / ? * [ ] :
  let sanitized = name.replace(/[\\/?*\[\]:]/g, '_').trim();
  if (!sanitized) {
    sanitized = `Sheet${index + 1}`;
  }
  return sanitized.substring(0, 31);
}

function buildWorkbookXml(sheets: readonly XlsxWorksheet[]): string {
  const sheetTags: string[] = [];
  const seenNames = new Set<string>();

  sheets.forEach((s, idx) => {
    let cleanName = sanitizeSheetName(s.name, idx);
    if (seenNames.has(cleanName.toLowerCase())) {
      cleanName = `${cleanName.substring(0, 27)}_${idx + 1}`;
    }
    seenNames.add(cleanName.toLowerCase());
    sheetTags.push(
      `<sheet name="${escapeXml(cleanName)}" sheetId="${idx + 1}" r:id="rId${idx + 1}"/>`
    );
  });

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <bookViews>
    <workbookView xWindow="0" yWindow="0" windowWidth="20480" windowHeight="10240"/>
  </bookViews>
  <sheets>
    ${sheetTags.join('\n    ')}
  </sheets>
</workbook>`;
}

function buildStylesXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="3">
    <numFmt numFmtId="164" formatCode="0.00"/>
    <numFmt numFmtId="165" formatCode="0.0000"/>
    <numFmt numFmtId="166" formatCode="yyyy-mm-dd hh:mm:ss"/>
  </numFmts>
  <fonts count="9">
    <!-- 0: Default regular -->
    <font><sz val="11"/><name val="Calibri"/><family val="2"/></font>
    <!-- 1: Bold -->
    <font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font>
    <!-- 2: Title bold navy -->
    <font><b/><sz val="14"/><color rgb="FF1F4E79"/><name val="Calibri"/><family val="2"/></font>
    <!-- 3: Bold white (header) -->
    <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>
    <!-- 4: Pass green -->
    <font><b/><sz val="11"/><color rgb="FF155724"/><name val="Calibri"/><family val="2"/></font>
    <!-- 5: Warning yellow/brown -->
    <font><b/><sz val="11"/><color rgb="FF856404"/><name val="Calibri"/><family val="2"/></font>
    <!-- 6: Fail red -->
    <font><b/><sz val="11"/><color rgb="FF721C24"/><name val="Calibri"/><family val="2"/></font>
    <!-- 7: Monospace Consolas -->
    <font><sz val="10"/><color rgb="FF333333"/><name val="Consolas"/><family val="3"/></font>
    <!-- 8: Subtitle bold -->
    <font><b/><sz val="12"/><name val="Calibri"/><family val="2"/></font>
  </fonts>
  <fills count="8">
    <!-- 0: required none -->
    <fill><patternFill patternType="none"/></fill>
    <!-- 1: required gray125 -->
    <fill><patternFill patternType="gray125"/></fill>
    <!-- 2: Table header Navy #1F4E79 -->
    <fill><patternFill patternType="solid"><fgColor rgb="FF1F4E79"/><bgColor indexed="64"/></patternFill></fill>
    <!-- 3: Pass soft green #D4EDDA -->
    <fill><patternFill patternType="solid"><fgColor rgb="FFD4EDDA"/><bgColor indexed="64"/></patternFill></fill>
    <!-- 4: Warning soft yellow #FFF3CD -->
    <fill><patternFill patternType="solid"><fgColor rgb="FFFFF3CD"/><bgColor indexed="64"/></patternFill></fill>
    <!-- 5: Fail soft red #F8D7DA -->
    <fill><patternFill patternType="solid"><fgColor rgb="FFF8D7DA"/><bgColor indexed="64"/></patternFill></fill>
    <!-- 6: Light gray #F2F4F7 -->
    <fill><patternFill patternType="solid"><fgColor rgb="FFF2F4F7"/><bgColor indexed="64"/></patternFill></fill>
    <!-- 7: Slate header #2B3E50 -->
    <fill><patternFill patternType="solid"><fgColor rgb="FF2B3E50"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <!-- 0: none -->
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <!-- 1: Thin light gray -->
    <border>
      <left style="thin"><color rgb="FFD3D3D3"/></left>
      <right style="thin"><color rgb="FFD3D3D3"/></right>
      <top style="thin"><color rgb="FFD3D3D3"/></top>
      <bottom style="thin"><color rgb="FFD3D3D3"/></bottom>
      <diagonal/>
    </border>
  </borders>
  <cellStyleXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
  </cellStyleXfs>
  <cellXfs count="14">
    <!-- 0: Default -->
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <!-- 1: Table Header (white on navy, bordered, centered) -->
    <xf numFmtId="0" fontId="3" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center" vertical="center" wrapText="1"/>
    </xf>
    <!-- 2: Data Bordered -->
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1">
      <alignment vertical="center"/>
    </xf>
    <!-- 3: Data Bold Bordered -->
    <xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1">
      <alignment vertical="center"/>
    </xf>
    <!-- 4: Pass Badge -->
    <xf numFmtId="0" fontId="4" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center" vertical="center"/>
    </xf>
    <!-- 5: Warning Badge -->
    <xf numFmtId="0" fontId="5" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center" vertical="center"/>
    </xf>
    <!-- 6: Fail Badge -->
    <xf numFmtId="0" fontId="6" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center" vertical="center"/>
    </xf>
    <!-- 7: Number 2 Decimals -->
    <xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="right" vertical="center"/>
    </xf>
    <!-- 8: Integer -->
    <xf numFmtId="1" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="right" vertical="center"/>
    </xf>
    <!-- 9: Monospace Code / Hash -->
    <xf numFmtId="0" fontId="7" fillId="6" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment vertical="center"/>
    </xf>
    <!-- 10: Title -->
    <xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1">
      <alignment vertical="center"/>
    </xf>
    <!-- 11: Section Header -->
    <xf numFmtId="0" fontId="8" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1">
      <alignment vertical="center"/>
    </xf>
    <!-- 12: Meta Label (gray background, bold) -->
    <xf numFmtId="0" fontId="1" fillId="6" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment vertical="center"/>
    </xf>
    <!-- 13: Unverified Prose Alert (soft red, bold red text) -->
    <xf numFmtId="0" fontId="6" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment vertical="center" wrapText="1"/>
    </xf>
  </cellXfs>
  <cellStyles count="1">
    <cellStyle name="Normal" xfId="0" builtinId="0"/>
  </cellStyles>
</styleSheet>`;
}

function buildWorksheetXml(sheet: XlsxWorksheet): string {
  // Columns definition
  const colTags: string[] = [];
  if (sheet.columns && sheet.columns.length > 0) {
    for (const c of sheet.columns) {
      const colNum = c.colIndex + 1;
      const width = c.width || 18;
      colTags.push(`<col min="${colNum}" max="${colNum}" width="${width}" customWidth="1"/>`);
    }
  }

  // Sheet data rows
  const rowTags: string[] = [];
  for (const row of sheet.rows) {
    const cellTags: string[] = [];
    row.cells.forEach((cell, colIndex) => {
      if (!cell) return;
      const cellRef = toCellRef(colIndex, row.rowNumber);
      const styleAttr = typeof cell.styleId === 'number' ? ` s="${cell.styleId}"` : '';

      if (cell.type === 'formula' && cell.formula) {
        // Formula cell: <f>formula</f><v>evaluated</v>
        // Note: formulas in SpreadsheetML do NOT start with '='
        const cleanFormula = cell.formula.startsWith('=')
          ? cell.formula.substring(1)
          : cell.formula;
        const escapedF = escapeXml(cleanFormula);
        const escapedV = escapeXml(cell.value);
        cellTags.push(`<c r="${cellRef}"${styleAttr}><f>${escapedF}</f><v>${escapedV}</v></c>`);
      } else if (
        (cell.type === 'number' || typeof cell.value === 'number') &&
        cell.type !== 'string' &&
        typeof cell.value === 'number' &&
        !isNaN(cell.value)
      ) {
        // Numeric cell
        cellTags.push(`<c r="${cellRef}"${styleAttr}><v>${cell.value}</v></c>`);
      } else if (cell.type === 'boolean' || typeof cell.value === 'boolean') {
        // Boolean cell
        cellTags.push(`<c r="${cellRef}"${styleAttr} t="b"><v>${cell.value ? 1 : 0}</v></c>`);
      } else {
        // Inline string cell: completely standard and avoids formula execution
        const textVal = cell.value !== undefined && cell.value !== null ? String(cell.value) : '';
        const escapedText = escapeXml(textVal);
        cellTags.push(
          `<c r="${cellRef}"${styleAttr} t="inlineStr"><is><t xml:space="preserve">${escapedText}</t></is></c>`
        );
      }
    });

    const htAttr = row.height ? ` ht="${row.height}" customHeight="1"` : '';
    rowTags.push(`<row r="${row.rowNumber}"${htAttr}>${cellTags.join('')}</row>`);
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetViews>
    <sheetView tabSelected="1" workbookViewId="0"/>
  </sheetViews>
  <sheetFormatPr defaultRowHeight="20"/>
  ${colTags.length > 0 ? `<cols>${colTags.join('')}</cols>` : ''}
  <sheetData>
    ${rowTags.join('\n    ')}
  </sheetData>
</worksheet>`;
}

function buildCorePropsXml(metadata: { title: string; author: string; created?: string }): string {
  const createdDate = metadata.created || new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${escapeXml(metadata.title)}</dc:title>
  <dc:creator>${escapeXml(metadata.author)}</dc:creator>
  <cp:lastModifiedBy>${escapeXml(metadata.author)}</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${escapeXml(createdDate)}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${escapeXml(createdDate)}</dcterms:modified>
</cp:coreProperties>`;
}

function buildAppPropsXml(sheets: readonly XlsxWorksheet[]): string {
  const sheetTitles = sheets.map(
    (s, idx) => `<vt:lpstr>${escapeXml(sanitizeSheetName(s.name, idx))}</vt:lpstr>`
  );

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>MAOS Industrial</Application>
  <DocSecurity>0</DocSecurity>
  <ScaleCrop>false</ScaleCrop>
  <HeadingPairs>
    <vt:vector size="2" baseType="variant">
      <vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant>
      <vt:variant><vt:i4>${sheets.length}</vt:i4></vt:variant>
    </vt:vector>
  </HeadingPairs>
  <TitlesOfParts>
    <vt:vector size="${sheets.length}" baseType="lpstr">
      ${sheetTitles.join('\n      ')}
    </vt:vector>
  </TitlesOfParts>
  <Company>MAOS Industrial Verification</Company>
  <LinksUpToDate>false</LinksUpToDate>
  <SharedDoc>false</SharedDoc>
  <HyperlinksChanged>false</HyperlinksChanged>
  <AppVersion>1.0.0</AppVersion>
</Properties>`;
}

// ── Workbook Packager ───────────────────────────────────────────────

/**
 * Builds a compliant OpenXML SpreadsheetML (.xlsx) archive buffer in memory.
 */
export function buildXlsxArchive(workbook: XlsxWorkbookData): Buffer {
  const files: ZipFileInput[] = [];
  const sheetCount = Math.max(workbook.sheets.length, 1);

  // 1. [Content_Types].xml
  files.push({
    path: '[Content_Types].xml',
    data: buildContentTypesXml(sheetCount),
  });

  // 2. _rels/.rels
  files.push({
    path: '_rels/.rels',
    data: buildRootRelsXml(),
  });

  // 3. docProps/core.xml & app.xml
  files.push({
    path: 'docProps/core.xml',
    data: buildCorePropsXml({
      title: workbook.title,
      author: workbook.author,
      created: workbook.created,
    }),
  });
  files.push({
    path: 'docProps/app.xml',
    data: buildAppPropsXml(workbook.sheets),
  });

  // 4. xl/workbook.xml & xl/_rels/workbook.xml.rels
  files.push({
    path: 'xl/workbook.xml',
    data: buildWorkbookXml(workbook.sheets),
  });
  files.push({
    path: 'xl/_rels/workbook.xml.rels',
    data: buildWorkbookRelsXml(sheetCount),
  });

  // 5. xl/styles.xml
  files.push({
    path: 'xl/styles.xml',
    data: buildStylesXml(),
  });

  // 6. xl/worksheets/sheet*.xml
  workbook.sheets.forEach((sheet, idx) => {
    files.push({
      path: `xl/worksheets/sheet${idx + 1}.xml`,
      data: buildWorksheetXml(sheet),
    });
  });

  return buildZipArchive(files);
}

// ── Offline XLSX Package Validator ──────────────────────────────────

export interface XlsxValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly parts: Map<string, string>;
  readonly sheetCount: number;
}

const DANGEROUS_FORMULA_NAMES = [
  'DDE',
  'HYPERLINK',
  'WEBSERVICE',
  'IMPORTXML',
  'CMD',
  'EXEC',
  'SHELL',
  'POWERSHELL',
];

/**
 * Validates an in-memory buffer as a secure, air-gapped, conformant OOXML XLSX package.
 * Inspects all parts offline:
 * - Signature and ZIP integrity
 * - Mandatory OOXML parts
 * - Rejects macro parts (.bin, vbaProject, vbadata, activex)
 * - Rejects external relationships (TargetMode="External", remote URLs)
 * - Verifies XML well-formedness
 * - Rejects unescaped hyperlinks or script tags
 * - Rejects dangerous spreadsheet formulas (DDE, HYPERLINK, cmd, exec)
 */
export function validateXlsxPackage(buf: Buffer): XlsxValidationResult {
  const errors: string[] = [];
  const parts = new Map<string, string>();
  let sheetCount = 0;

  // 1. Signature check
  if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) {
    return {
      valid: false,
      errors: ['Invalid file signature: Not a valid ZIP/OOXML package (expected PK\\x03\\x04).'],
      parts,
      sheetCount: 0,
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
      sheetCount: 0,
    };
  }

  // 3. Required OOXML XLSX parts
  const requiredParts = [
    '[Content_Types].xml',
    '_rels/.rels',
    'xl/workbook.xml',
    'xl/_rels/workbook.xml.rels',
    'xl/worksheets/sheet1.xml',
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
        errors.push(`Forbidden binary or script part in XLSX: '${partPath}'.`);
      }
    }

    // Check forbidden part names
    for (const forbidden of FORBIDDEN_PART_NAMES) {
      if (lowerPath === forbidden || lowerPath.includes(forbidden)) {
        errors.push(`Forbidden macro or ActiveX component in XLSX: '${partPath}'.`);
      }
    }

    // Check path traversal in zip entry
    if (partPath.includes('..') || partPath.startsWith('/') || partPath.startsWith('\\')) {
      errors.push(`Path traversal or invalid path in ZIP entry: '${partPath}'.`);
    }

    // Count sheets
    if (lowerPath.startsWith('xl/worksheets/sheet') && lowerPath.endsWith('.xml')) {
      sheetCount++;
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

      // Security check for worksheets
      if (lowerPath.startsWith('xl/worksheets/')) {
        const sheetSecurityErrors = verifyWorksheetSecurity(xmlText, partPath);
        errors.push(...sheetSecurityErrors);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    parts,
    sheetCount,
  };
}

/**
 * Validates security of a worksheet XML content offline.
 */
function verifyWorksheetSecurity(xmlText: string, filename: string): string[] {
  const errors: string[] = [];

  // Check for external hyperlink elements
  if (/<hyperlink\b/i.test(xmlText)) {
    errors.push(`Security violation in '${filename}': Hyperlink element detected.`);
  }

  // Check for TargetMode="External"
  if (/TargetMode\s*=\s*["']External["']/i.test(xmlText)) {
    errors.push(`Security violation in '${filename}': External relationship detected.`);
  }

  // Check for forbidden script or macro keywords
  const scriptKeywords = [
    '<script',
    'wscript.shell',
    'powershell.exe',
    'cmd.exe',
    'vba_project',
    'vbaproject',
  ];
  const lower = xmlText.toLowerCase();
  for (const kw of scriptKeywords) {
    if (lower.includes(kw)) {
      errors.push(`Security violation in '${filename}': Forbidden script keyword '${kw}' detected.`);
    }
  }

  // Check formulas inside <f> tags
  const formulaRegex = /<f\b[^>]*>([\s\S]*?)<\/f>/gi;
  let fMatch: RegExpExecArray | null;
  while ((fMatch = formulaRegex.exec(xmlText)) !== null) {
    const rawFormula = fMatch[1].trim();
    // In OpenXML <f>, leading '=' or '@' indicates injection attempt
    if (rawFormula.startsWith('=') || rawFormula.startsWith('@')) {
      errors.push(
        `Security violation in '${filename}': Formula '${rawFormula}' starts with prohibited prefix in XML formula element.`
      );
    }

    // Check for dangerous formula functions/commands
    const upperF = rawFormula.toUpperCase();
    for (const danger of DANGEROUS_FORMULA_NAMES) {
      if (
        upperF.includes(danger + '(') ||
        upperF.startsWith(danger) ||
        new RegExp(`\\b${danger}\\b`, 'i').test(rawFormula)
      ) {
        errors.push(
          `Security violation in '${filename}': Formula contains prohibited function/command '${danger}': '${rawFormula}'.`
        );
      }
    }
  }

  // Check cell inline string text for forbidden URL protocols
  const textRunRegex = /<t\b[^>]*>([\s\S]*?)<\/t>/gi;
  let textMatch: RegExpExecArray | null;
  while ((textMatch = textRunRegex.exec(xmlText)) !== null) {
    const textContent = textMatch[1].toLowerCase();
    for (const scheme of FORBIDDEN_REL_URL_SCHEMES) {
      if (textContent.includes(scheme)) {
        errors.push(
          `Security violation in '${filename}': Forbidden URL protocol '${scheme}' detected in cell text.`
        );
      }
    }
  }

  return errors;
}
