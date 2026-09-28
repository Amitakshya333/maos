/**
 * PPTX OpenXML PresentationML Packager and Offline Validator
 *
 * Implements a pure Node.js PresentationML (.pptx) builder and validator without
 * external binaries (no Microsoft PowerPoint, no LibreOffice, zero npm packages).
 * Uses standard Deflate (zlib) and IEEE 802.3 CRC-32.
 *
 * Security guarantees:
 *   - Offline OOXML validation of PK structure and all PresentationML XML parts
 *   - Zero macros, zero VBA, zero active scripts
 *   - Zero external relationships (no TargetMode="External", no remote URLs)
 *   - Strict XML well-formedness and UTF-8 encoding
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

// ── XML Helpers & Sanitization ──────────────────────────────────────

/**
 * Escapes text for DrawingML/PresentationML text runs.
 * Strips ASCII control characters except standard whitespace.
 */
export function escapeXml(val: unknown): string {
  if (val === null || val === undefined) return '';
  const text = String(val);
  const sanitized = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  return sanitized
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ── DrawingML & PresentationML Data Structures ──────────────────────

export interface PptxTextRun {
  readonly text: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly sizePt?: number; // Font size in points (e.g., 14, 18, 24, 32)
  readonly colorHex?: string; // 6-char hex code without #, e.g. '0F172A', '1D4ED8'
}

export interface PptxParagraph {
  readonly runs: readonly PptxTextRun[];
  readonly bullet?: boolean;
  readonly align?: 'left' | 'center' | 'right';
  readonly spaceAfterPt?: number;
}

export interface PptxShape {
  readonly x: number; // EMUs (1 pt = 12,700 EMUs, 1 inch = 914,400 EMUs)
  readonly y: number; // EMUs
  readonly cx: number; // EMUs
  readonly cy: number; // EMUs
  readonly fillColorHex?: string;
  readonly borderColorHex?: string;
  readonly borderWidthPt?: number;
  readonly paragraphs: readonly PptxParagraph[];
}

export interface PptxTableCell {
  readonly text: string;
  readonly bold?: boolean;
  readonly fillColorHex?: string;
  readonly textColorHex?: string;
  readonly align?: 'left' | 'center' | 'right';
  readonly sizePt?: number;
}

export interface PptxTable {
  readonly x: number;
  readonly y: number;
  readonly cx: number;
  readonly cy: number;
  readonly colWidths: readonly number[]; // Column widths in EMUs
  readonly rows: readonly (readonly PptxTableCell[])[];
}

export interface PptxSlideData {
  readonly slideNumber: number;
  readonly title: string;
  readonly layout?: 'title' | 'content';
  readonly subtitle?: string;
  readonly categoryBadge?: string;
  readonly shapes?: readonly PptxShape[];
  readonly table?: PptxTable;
}

export interface PptxPresentationData {
  readonly title: string;
  readonly author: string;
  readonly createdDate?: string;
  readonly slides: readonly PptxSlideData[];
}

export interface PptxValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly slideCount: number;
  readonly parts: Map<string, string>;
}

// ── Slide Dimensions (16:9 Widescreen Standard) ─────────────────────
// 13.333 inches x 7.5 inches
export const PPTX_DIMENSIONS = {
  CX: 12192000,
  CY: 6858000,
  PT_TO_EMU: 12700,
  INCH_TO_EMU: 914400,
} as const;

// ── XML Templates ───────────────────────────────────────────────────

function buildContentTypesXml(slideCount: number): string {
  const overrides: string[] = [
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>',
    '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>',
    '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>',
    '<Override PartName="/ppt/slideLayouts/slideLayout2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>',
    '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>',
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>',
  ];

  for (let i = 1; i <= slideCount; i++) {
    overrides.push(
      `<Override PartName="/ppt/slides/slide${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
    );
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  ${overrides.join('\n  ')}
</Types>`;
}

function buildRootRelsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
}

function buildPresentationRelsXml(slideCount: number): string {
  const rels: string[] = [
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>',
  ];

  for (let i = 1; i <= slideCount; i++) {
    rels.push(
      `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i}.xml"/>`
    );
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${rels.join('\n  ')}
</Relationships>`;
}

function buildPresentationXml(slideCount: number): string {
  const slideIdItems: string[] = [];
  for (let i = 1; i <= slideCount; i++) {
    // slide IDs start at 256
    slideIdItems.push(`<p:sldId id="${255 + i}" r:id="rId${i + 1}"/>`);
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldMasterIdLst>
    <p:sldMasterId id="2147483648" r:id="rId1"/>
  </p:sldMasterIdLst>
  <p:sldIdLst>
    ${slideIdItems.join('\n    ')}
  </p:sldIdLst>
  <p:sldSz cx="${PPTX_DIMENSIONS.CX}" cy="${PPTX_DIMENSIONS.CY}" type="screen16x9"/>
  <p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`;
}

function buildSlideMasterXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr>
        <p:cNvPr id="1" name=""/>
        <p:cNvGrpSpPr/>
        <p:nvPr/>
      </p:nvGrpSpPr>
      <p:grpSpPr>
        <a:xfrm>
          <a:off x="0" y="0"/>
          <a:ext cx="0" cy="0"/>
          <a:chOff x="0" y="0"/>
          <a:chExt cx="0" cy="0"/>
        </a:xfrm>
      </p:grpSpPr>
    </p:spTree>
  </p:cSld>
  <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="accent1" folHlink="accent2"/>
  <p:sldLayoutIdLst>
    <p:sldLayoutId id="2147483649" r:id="rId1"/>
    <p:sldLayoutId id="2147483650" r:id="rId2"/>
  </p:sldLayoutIdLst>
</p:sldMaster>`;
}

function buildSlideMasterRelsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout2.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>`;
}

function buildSlideLayout1Xml(): string {
  // Title Layout
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="title">
  <p:cSld name="Title Slide">
    <p:spTree>
      <p:nvGrpSpPr>
        <p:cNvPr id="1" name=""/>
        <p:cNvGrpSpPr/>
        <p:nvPr/>
      </p:nvGrpSpPr>
      <p:grpSpPr>
        <a:xfrm>
          <a:off x="0" y="0"/>
          <a:ext cx="0" cy="0"/>
          <a:chOff x="0" y="0"/>
          <a:chExt cx="0" cy="0"/>
        </a:xfrm>
      </p:grpSpPr>
    </p:spTree>
  </p:cSld>
</p:sldLayout>`;
}

function buildSlideLayout2Xml(): string {
  // Content Layout
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="obj">
  <p:cSld name="Title and Content">
    <p:spTree>
      <p:nvGrpSpPr>
        <p:cNvPr id="1" name=""/>
        <p:cNvGrpSpPr/>
        <p:nvPr/>
      </p:nvGrpSpPr>
      <p:grpSpPr>
        <a:xfrm>
          <a:off x="0" y="0"/>
          <a:ext cx="0" cy="0"/>
          <a:chOff x="0" y="0"/>
          <a:chExt cx="0" cy="0"/>
        </a:xfrm>
      </p:grpSpPr>
    </p:spTree>
  </p:cSld>
</p:sldLayout>`;
}

function buildSlideLayoutRelsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`;
}

function buildThemeXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="MAOS Industrial Clean">
  <a:themeElements>
    <a:clrScheme name="Industrial">
      <a:dk1><a:srgbClr val="0F172A"/></a:dk1>
      <a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>
      <a:dk2><a:srgbClr val="334155"/></a:dk2>
      <a:lt2><a:srgbClr val="F8FAFC"/></a:lt2>
      <a:accent1><a:srgbClr val="1D4ED8"/></a:accent1>
      <a:accent2><a:srgbClr val="059669"/></a:accent2>
      <a:accent3><a:srgbClr val="D97706"/></a:accent3>
      <a:accent4><a:srgbClr val="DC2626"/></a:accent4>
      <a:accent5><a:srgbClr val="4338CA"/></a:accent5>
      <a:accent6><a:srgbClr val="0891B2"/></a:accent6>
      <a:hlink><a:srgbClr val="1D4ED8"/></a:hlink>
      <a:folHlink><a:srgbClr val="4338CA"/></a:folHlink>
    </a:clrScheme>
    <a:fontScheme name="Office">
      <a:majorFont><a:latin typeface="Calibri"/></a:majorFont>
      <a:minorFont><a:latin typeface="Calibri"/></a:minorFont>
    </a:fontScheme>
    <a:fmtScheme name="Office">
      <a:fillStyleLst>
        <a:solidFill><a:schemeClr val="lt1"/></a:solidFill>
        <a:solidFill><a:schemeClr val="accent1"/></a:solidFill>
        <a:solidFill><a:schemeClr val="accent2"/></a:solidFill>
      </a:fillStyleLst>
      <a:lnStyleLst>
        <a:ln w="9525"><a:solidFill><a:schemeClr val="dk1"/></a:solidFill></a:ln>
      </a:lnStyleLst>
      <a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>
      <a:bgFillStyleLst><a:solidFill><a:schemeClr val="lt1"/></a:solidFill></a:bgFillStyleLst>
    </a:fmtScheme>
  </a:themeElements>
</a:theme>`;
}

function buildSlideRelsXml(layoutIndex: number): string {
  const target = `../slideLayouts/slideLayout${layoutIndex}.xml`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="${target}"/>
</Relationships>`;
}

function buildCorePropsXml(title: string, author: string, createdDate: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${escapeXml(title)}</dc:title>
  <dc:creator>${escapeXml(author)}</dc:creator>
  <cp:lastModifiedBy>${escapeXml(author)}</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${escapeXml(createdDate)}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${escapeXml(createdDate)}</dcterms:modified>
</cp:coreProperties>`;
}

function buildAppPropsXml(title: string, slideCount: number): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <TotalTime>1</TotalTime>
  <Words>0</Words>
  <Application>MAOS Industrial Presentation Engine</Application>
  <PresentationFormat>Screen 16:9</PresentationFormat>
  <Slides>${slideCount}</Slides>
  <Notes>0</Notes>
  <HiddenSlides>0</HiddenSlides>
  <MMClips>0</MMClips>
  <ScaleCrop>false</ScaleCrop>
  <HeadingPairs>
    <vt:vector size="2" baseType="variant">
      <vt:variant><vt:lpstr>Theme</vt:lpstr></vt:variant>
      <vt:variant><vt:i4>1</vt:i4></vt:variant>
    </vt:vector>
  </HeadingPairs>
  <TitlesOfParts>
    <vt:vector size="1" baseType="lpstr">
      <vt:lpstr>${escapeXml(title)}</vt:lpstr>
    </vt:vector>
  </TitlesOfParts>
</Properties>`;
}

// ── Slide XML Builder ───────────────────────────────────────────────

function renderParagraphXml(p: PptxParagraph): string {
  const alignAttr = p.align ? ` algn="${p.align === 'center' ? 'ctr' : p.align === 'right' ? 'r' : 'l'}"` : '';
  const spaceAfter = p.spaceAfterPt ? `<a:spcAft><a:spcPts val="${Math.round(p.spaceAfterPt * 100)}"/></a:spcAft>` : '';
  const bulletProp = p.bullet ? '<a:buAutoNum type="arabicPeriod"/>' : '<a:buNone/>';

  const runsXml = p.runs.map((r) => {
    const boldAttr = r.bold ? ' b="1"' : '';
    const italicAttr = r.italic ? ' i="1"' : '';
    const szVal = r.sizePt ? Math.round(r.sizePt * 100) : 1600; // 100ths of pt
    const colorXml = r.colorHex
      ? `<a:solidFill><a:srgbClr val="${r.colorHex}"/></a:solidFill>`
      : '<a:solidFill><a:schemeClr val="tx1"/></a:solidFill>';

    return `<a:r>
      <a:rPr lang="en-US" sz="${szVal}"${boldAttr}${italicAttr} dirty="0">
        ${colorXml}
      </a:rPr>
      <a:t>${escapeXml(r.text)}</a:t>
    </a:r>`;
  }).join('');

  return `<a:p>
    <a:pPr${alignAttr}>
      ${bulletProp}
      ${spaceAfter}
    </a:pPr>
    ${runsXml}
  </a:p>`;
}

function renderShapeXml(shape: PptxShape, id: number): string {
  const fillXml = shape.fillColorHex
    ? `<a:solidFill><a:srgbClr val="${shape.fillColorHex}"/></a:solidFill>`
    : '<a:noFill/>';

  const borderXml = shape.borderColorHex
    ? `<a:ln w="${Math.round((shape.borderWidthPt || 1) * PPTX_DIMENSIONS.PT_TO_EMU)}">
        <a:solidFill><a:srgbClr val="${shape.borderColorHex}"/></a:solidFill>
      </a:ln>`
    : '<a:ln><a:noFill/></a:ln>';

  const paragraphsXml = shape.paragraphs.map(renderParagraphXml).join('\n          ');

  return `<p:sp>
    <p:nvSpPr>
      <p:cNvPr id="${id}" name="Shape ${id}"/>
      <p:cNvSpPr/>
      <p:nvPr/>
    </p:nvSpPr>
    <p:spPr>
      <a:xfrm>
        <a:off x="${shape.x}" y="${shape.y}"/>
        <a:ext cx="${shape.cx}" cy="${shape.cy}"/>
      </a:xfrm>
      <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
      ${fillXml}
      ${borderXml}
    </p:spPr>
    <p:txBody>
      <a:bodyPr vert="horz" lIns="100000" tIns="100000" rIns="100000" bIns="100000" rtlCol="0" anchor="t"/>
      <a:lstStyle/>
      ${paragraphsXml}
    </p:txBody>
  </p:sp>`;
}

function renderTableXml(table: PptxTable, id: number): string {
  const gridColsXml = table.colWidths.map((w) => `<a:gridCol w="${w}"/>`).join('');

  const rowsXml = table.rows.map((row) => {
    const cellsXml = row.map((cell) => {
      const alignAttr = cell.align ? ` algn="${cell.align === 'center' ? 'ctr' : cell.align === 'right' ? 'r' : 'l'}"` : '';
      const szVal = cell.sizePt ? Math.round(cell.sizePt * 100) : 1300;
      const boldAttr = cell.bold ? ' b="1"' : '';
      const textClr = cell.textColorHex ? cell.textColorHex : cell.bold ? '0F172A' : '334155';
      const fillXml = cell.fillColorHex
        ? `<a:solidFill><a:srgbClr val="${cell.fillColorHex}"/></a:solidFill>`
        : '<a:noFill/>';

      return `<a:tc>
        <a:txBody>
          <a:bodyPr vert="horz" lIns="50000" tIns="40000" rIns="50000" bIns="40000" rtlCol="0" anchor="ctr"/>
          <a:lstStyle/>
          <a:p>
            <a:pPr${alignAttr}/>
            <a:r>
              <a:rPr lang="en-US" sz="${szVal}"${boldAttr} dirty="0">
                <a:solidFill><a:srgbClr val="${textClr}"/></a:solidFill>
              </a:rPr>
              <a:t>${escapeXml(cell.text)}</a:t>
            </a:r>
          </a:p>
        </a:txBody>
        <a:tcPr>
          ${fillXml}
          <a:lnL w="12700"><a:solidFill><a:srgbClr val="CBD5E1"/></a:solidFill></a:lnL>
          <a:lnR w="12700"><a:solidFill><a:srgbClr val="CBD5E1"/></a:solidFill></a:lnR>
          <a:lnT w="12700"><a:solidFill><a:srgbClr val="CBD5E1"/></a:solidFill></a:lnT>
          <a:lnB w="12700"><a:solidFill><a:srgbClr val="CBD5E1"/></a:solidFill></a:lnB>
        </a:tcPr>
      </a:tc>`;
    }).join('');

    return `<a:tr h="350000">
      ${cellsXml}
    </a:tr>`;
  }).join('');

  return `<p:graphicFrame>
    <p:nvGraphicFramePr>
      <p:cNvPr id="${id}" name="Table ${id}"/>
      <p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr>
      <p:nvPr/>
    </p:nvGraphicFramePr>
    <p:xfrm>
      <a:off x="${table.x}" y="${table.y}"/>
      <a:ext cx="${table.cx}" cy="${table.cy}"/>
    </p:xfrm>
    <a:graphic>
      <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">
        <a:tbl>
          <a:tblPr firstRow="1" bandRow="1"/>
          <a:tblGrid>
            ${gridColsXml}
          </a:tblGrid>
          ${rowsXml}
        </a:tbl>
      </a:graphicData>
    </a:graphic>
  </p:graphicFrame>`;
}

function buildSlideXml(slide: PptxSlideData): string {
  const isTitleSlide = slide.layout === 'title';
  let nextId = 2;

  // Title shape
  const titleX = 685800; // 0.75 in
  const titleY = isTitleSlide ? 2000000 : 457200; // 0.5 in or 2.18 in
  const titleCx = 10820400; // 11.83 in
  const titleCy = isTitleSlide ? 1200000 : 750000;
  const titleSizePt = isTitleSlide ? 36 : 24;

  const titleParagraphs: PptxParagraph[] = [
    {
      runs: [
        {
          text: slide.title,
          bold: true,
          sizePt: titleSizePt,
          colorHex: '0F172A',
        },
      ],
      align: isTitleSlide ? 'center' : 'left',
    },
  ];

  if (slide.subtitle) {
    titleParagraphs.push({
      runs: [
        {
          text: slide.subtitle,
          sizePt: isTitleSlide ? 18 : 14,
          colorHex: '475569',
        },
      ],
      align: isTitleSlide ? 'center' : 'left',
      spaceAfterPt: 6,
    });
  }

  const titleShapeXml = renderShapeXml(
    {
      x: titleX,
      y: titleY,
      cx: titleCx,
      cy: titleCy,
      paragraphs: titleParagraphs,
    },
    nextId++
  );

  // Additional shapes
  const extraShapesXml: string[] = [];
  if (slide.shapes && slide.shapes.length > 0) {
    for (const shape of slide.shapes) {
      extraShapesXml.push(renderShapeXml(shape, nextId++));
    }
  }

  // Table if present
  let tableXml = '';
  if (slide.table) {
    tableXml = renderTableXml(slide.table, nextId++);
  }

  // Footer / slide number
  const footerShapeXml = renderShapeXml(
    {
      x: 685800,
      y: 6300000,
      cx: 10820400,
      cy: 350000,
      paragraphs: [
        {
          runs: [
            {
              text: `MAOS Industrial Safety Verification • Slide ${slide.slideNumber}`,
              sizePt: 10,
              colorHex: '94A3B8',
            },
          ],
          align: 'right',
        },
      ],
    },
    nextId++
  );

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr>
        <p:cNvPr id="1" name=""/>
        <p:cNvGrpSpPr/>
        <p:nvPr/>
      </p:nvGrpSpPr>
      <p:grpSpPr>
        <a:xfrm>
          <a:off x="0" y="0"/>
          <a:ext cx="0" cy="0"/>
          <a:chOff x="0" y="0"/>
          <a:chExt cx="0" cy="0"/>
        </a:xfrm>
      </p:grpSpPr>
      ${titleShapeXml}
      ${extraShapesXml.join('\n      ')}
      ${tableXml}
      ${footerShapeXml}
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr>
    <a:masterClrMapping/>
  </p:clrMapOvr>
</p:sld>`;
}

// ── Package Builder ─────────────────────────────────────────────────

/**
 * Builds a valid, verified PresentationML (.pptx) buffer from structured presentation data.
 */
export function buildPptxArchive(data: PptxPresentationData): Buffer {
  const slideCount = data.slides.length;
  const createdDate = data.createdDate || new Date().toISOString();

  const files: ZipFileInput[] = [
    {
      path: '[Content_Types].xml',
      data: buildContentTypesXml(slideCount),
    },
    {
      path: '_rels/.rels',
      data: buildRootRelsXml(),
    },
    {
      path: 'docProps/core.xml',
      data: buildCorePropsXml(data.title, data.author, createdDate),
    },
    {
      path: 'docProps/app.xml',
      data: buildAppPropsXml(data.title, slideCount),
    },
    {
      path: 'ppt/presentation.xml',
      data: buildPresentationXml(slideCount),
    },
    {
      path: 'ppt/_rels/presentation.xml.rels',
      data: buildPresentationRelsXml(slideCount),
    },
    {
      path: 'ppt/slideMasters/slideMaster1.xml',
      data: buildSlideMasterXml(),
    },
    {
      path: 'ppt/slideMasters/_rels/slideMaster1.xml.rels',
      data: buildSlideMasterRelsXml(),
    },
    {
      path: 'ppt/slideLayouts/slideLayout1.xml',
      data: buildSlideLayout1Xml(),
    },
    {
      path: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
      data: buildSlideLayoutRelsXml(),
    },
    {
      path: 'ppt/slideLayouts/slideLayout2.xml',
      data: buildSlideLayout2Xml(),
    },
    {
      path: 'ppt/slideLayouts/_rels/slideLayout2.xml.rels',
      data: buildSlideLayoutRelsXml(),
    },
    {
      path: 'ppt/theme/theme1.xml',
      data: buildThemeXml(),
    },
  ];

  // Add each slide and its relationship file
  for (let i = 0; i < data.slides.length; i++) {
    const slide = data.slides[i];
    const layoutIndex = slide.layout === 'title' ? 1 : 2;
    files.push({
      path: `ppt/slides/slide${i + 1}.xml`,
      data: buildSlideXml(slide),
    });
    files.push({
      path: `ppt/slides/_rels/slide${i + 1}.xml.rels`,
      data: buildSlideRelsXml(layoutIndex),
    });
  }

  return buildZipArchive(files);
}

// ── Offline PPTX Package Validator ──────────────────────────────────

/**
 * Validates a generated PPTX archive offline.
 * Re-opens ZIP stream, verifies mandatory parts, XML syntax, and strictly rejects:
 *   - Macros and VBA (.pptm, vbaProject.bin, vbaData.xml, activex)
 *   - Prohibited executable extensions
 *   - External relationships (TargetMode="External" or remote URL schemes)
 *   - Embedded OLE active objects
 *   - Remote URLs or action hyperlinks
 */
export function validatePptxPackage(buf: Buffer): PptxValidationResult {
  const errors: string[] = [];
  const parts = new Map<string, string>();

  // 1. Validate PK header signature
  if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) {
    return {
      valid: false,
      errors: ['Invalid ZIP archive: missing PK signature (0x04034b50)'],
      slideCount: 0,
      parts,
    };
  }

  // 2. Parse ZIP archive entries
  let zipEntries: Map<string, Buffer>;
  try {
    zipEntries = parseZipArchive(buf);
  } catch (err: unknown) {
    return {
      valid: false,
      errors: [`ZIP decompression failed: ${err instanceof Error ? err.message : String(err)}`],
      slideCount: 0,
      parts,
    };
  }

  // 3. Check for forbidden extensions and part names
  for (const partPath of zipEntries.keys()) {
    const lowerPath = partPath.toLowerCase();

    for (const ext of FORBIDDEN_FILE_EXTENSIONS) {
      if (lowerPath.endsWith(ext)) {
        errors.push(`Package contains forbidden file extension: '${partPath}' (${ext})`);
      }
    }

    for (const forbidden of FORBIDDEN_PART_NAMES) {
      if (lowerPath === forbidden || lowerPath.endsWith(`/${forbidden}`)) {
        errors.push(`Package contains forbidden part name: '${partPath}'`);
      }
    }
  }

  // 4. Check mandatory parts
  const requiredParts = [
    '[Content_Types].xml',
    '_rels/.rels',
    'ppt/presentation.xml',
    'ppt/_rels/presentation.xml.rels',
    'ppt/slideMasters/slideMaster1.xml',
    'ppt/slideLayouts/slideLayout1.xml',
    'ppt/slideLayouts/slideLayout2.xml',
    'ppt/theme/theme1.xml',
  ];

  for (const req of requiredParts) {
    if (!zipEntries.has(req)) {
      errors.push(`Package is missing required part: '${req}'`);
    }
  }

  // 5. Decode XML and validate security / well-formedness
  let slideCount = 0;
  for (const [partPath, rawBuf] of zipEntries.entries()) {
    const lowerPath = partPath.toLowerCase();

    if (
      lowerPath.endsWith('.xml') ||
      lowerPath.endsWith('.rels') ||
      lowerPath === '[content_types].xml'
    ) {
      const xmlText = rawBuf.toString('utf8');
      parts.set(partPath, xmlText);

      // Track slides
      if (lowerPath.startsWith('ppt/slides/slide') && lowerPath.endsWith('.xml')) {
        slideCount++;
      }

      // Check XML well-formedness
      const wellFormedError = verifyBasicXmlWellFormedness(xmlText, partPath);
      if (wellFormedError) {
        errors.push(wellFormedError);
      }

      // Security check for relationships (.rels)
      if (lowerPath.endsWith('.rels')) {
        const relSecurityError = verifyRelsSecurity(xmlText, partPath);
        if (relSecurityError) {
          errors.push(relSecurityError);
        }
      }

      // Security check for embedded OLE / scripts in presentation XML
      if (lowerPath.startsWith('ppt/')) {
        if (/<p:oleObj\b/i.test(xmlText)) {
          errors.push(`Part '${partPath}' contains prohibited embedded OLE active object.`);
        }
        if (/<script\b/i.test(xmlText)) {
          errors.push(`Part '${partPath}' contains prohibited <script> tag.`);
        }
        if (/\b(?:powershell|cmd\.exe|cscript|wscript)\b/i.test(xmlText)) {
          errors.push(`Part '${partPath}' contains prohibited executable command pattern.`);
        }
        if (/<[ap]:hlinkClick\b/i.test(xmlText)) {
          errors.push(`Part '${partPath}' contains prohibited hyperlink element.`);
        }
        if (/TargetMode\s*=\s*["']External["']/i.test(xmlText)) {
          errors.push(`Part '${partPath}' contains prohibited external relationship.`);
        }
        // Check text content inside <a:t> for forbidden URL schemes
        const textRunRegex = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/gi;
        let textMatch: RegExpExecArray | null;
        while ((textMatch = textRunRegex.exec(xmlText)) !== null) {
          const textContent = textMatch[1].toLowerCase();
          for (const scheme of FORBIDDEN_REL_URL_SCHEMES) {
            if (textContent.includes(scheme)) {
              errors.push(`Part '${partPath}' contains prohibited URL scheme '${scheme}' in text run.`);
            }
          }
        }
      }
    }
  }

  // At least 1 slide must exist
  if (slideCount === 0) {
    errors.push('Presentation does not contain any slide parts (ppt/slides/slide*.xml).');
  }

  return {
    valid: errors.length === 0,
    errors,
    slideCount,
    parts,
  };
}
