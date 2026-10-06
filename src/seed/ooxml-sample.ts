import { crc32, deflateRawSync } from 'node:zlib';

export interface ZipEntryInput {
  name: string;
  data?: string | Uint8Array;
  method?: 'store' | 'deflate';
  deflated?: Uint8Array;
  flags?: number;
  declaredSize?: number;
  compressedSize?: number;
  localOffset?: number;
  diskStart?: number;
  shareDataWith?: number;
}

export interface EocdFields {
  disk: number;
  cdDisk: number;
  entriesOnDisk: number;
  totalEntries: number;
  cdSize: number;
  cdOffset: number;
}

export interface ZipOptions {
  comment?: Uint8Array | string;
  eocd?: Partial<EocdFields>;
  zip64Locator?: boolean;
}

interface Placed {
  offset: number;
  crc: number;
  compressed: number;
  size: number;
  method: number;
  flags: number;
}

function bytesOf(data: string | Uint8Array | undefined): Buffer {
  if (data === undefined) return Buffer.alloc(0);
  return typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
}

export function buildZip(entries: ZipEntryInput[], options: ZipOptions = {}): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  const placed: Placed[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    let at: Placed;
    if (entry.shareDataWith !== undefined) {
      at = placed[entry.shareDataWith];
    } else {
      const raw = bytesOf(entry.data);
      const method = entry.deflated !== undefined || entry.method !== 'store' ? 8 : 0;
      const body =
        entry.deflated !== undefined
          ? Buffer.from(entry.deflated)
          : method === 8
            ? deflateRawSync(raw)
            : raw;
      const flags = entry.flags ?? 0;
      at = {
        offset,
        crc: entry.deflated !== undefined ? 0 : crc32(raw),
        compressed: entry.compressedSize ?? body.length,
        size: entry.declaredSize ?? raw.length,
        method,
        flags,
      };
      const descriptor = (flags & 8) !== 0;
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(flags, 6);
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(0, 10);
      local.writeUInt16LE(0x21, 12);
      local.writeUInt32LE(descriptor ? 0 : at.crc, 14);
      local.writeUInt32LE(descriptor ? 0 : at.compressed, 18);
      local.writeUInt32LE(descriptor ? 0 : at.size, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28);
      chunks.push(local, name, body);
      offset += local.length + name.length + body.length;
      if (descriptor) {
        const dd = Buffer.alloc(16);
        dd.writeUInt32LE(0x08074b50, 0);
        dd.writeUInt32LE(at.crc, 4);
        dd.writeUInt32LE(at.compressed, 8);
        dd.writeUInt32LE(at.size, 12);
        chunks.push(dd);
        offset += dd.length;
      }
    }
    placed.push(at);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(entry.flags ?? at.flags, 8);
    cd.writeUInt16LE(at.method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(at.crc, 16);
    cd.writeUInt32LE(entry.compressedSize ?? at.compressed, 20);
    cd.writeUInt32LE(entry.declaredSize ?? at.size, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(entry.diskStart ?? 0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(entry.localOffset ?? at.offset, 42);
    central.push(cd, name);
  }
  const cdOffset = offset;
  const cdBytes = Buffer.concat(central);
  const tail: Buffer[] = [];
  if (options.zip64Locator === true) {
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeUInt32LE(1, 16);
    tail.push(locator);
  }
  const comment = bytesOf(options.comment);
  const eocd = Buffer.alloc(22);
  const fields: EocdFields = {
    disk: 0,
    cdDisk: 0,
    entriesOnDisk: entries.length,
    totalEntries: entries.length,
    cdSize: cdBytes.length,
    cdOffset,
    ...options.eocd,
  };
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(fields.disk, 4);
  eocd.writeUInt16LE(fields.cdDisk, 6);
  eocd.writeUInt16LE(fields.entriesOnDisk, 8);
  eocd.writeUInt16LE(fields.totalEntries, 10);
  eocd.writeUInt32LE(fields.cdSize, 12);
  eocd.writeUInt32LE(fields.cdOffset, 16);
  eocd.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...chunks, cdBytes, ...tail, eocd, comment]);
}

export const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
export const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
export const S_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const P_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const MC_NS = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const OFFICE = 'application/vnd.openxmlformats-officedocument';

export const CONTENT_TYPE = Object.freeze({
  docx: `${OFFICE}.wordprocessingml.document.main+xml`,
  docm: 'application/vnd.ms-word.document.macroEnabled.main+xml',
  xlsx: `${OFFICE}.spreadsheetml.sheet.main+xml`,
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.main+xml',
  xlsb: 'application/vnd.ms-excel.sheet.binary.macroEnabled.main',
  pptx: `${OFFICE}.presentationml.presentation.main+xml`,
  pptm: 'application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml',
  header: `${OFFICE}.wordprocessingml.header+xml`,
  footer: `${OFFICE}.wordprocessingml.footer+xml`,
  footnotes: `${OFFICE}.wordprocessingml.footnotes+xml`,
  endnotes: `${OFFICE}.wordprocessingml.endnotes+xml`,
  worksheet: `${OFFICE}.spreadsheetml.worksheet+xml`,
  chartsheet: `${OFFICE}.spreadsheetml.chartsheet+xml`,
  sharedStrings: `${OFFICE}.spreadsheetml.sharedStrings+xml`,
  slide: `${OFFICE}.presentationml.slide+xml`,
  notesSlide: `${OFFICE}.presentationml.notesSlide+xml`,
  vba: 'application/vnd.ms-office.vbaProject',
});

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface RelInput {
  id: string;
  type: string;
  target: string;
  external?: boolean;
}

export function relsXml(rels: RelInput[]): string {
  const items = rels.map(
    (rel) =>
      `<Relationship Id="${escapeXml(rel.id)}" Type="${rel.type.includes('/') ? rel.type : `${REL}/${rel.type}`}"` +
      ` Target="${escapeXml(rel.target)}"${rel.external === true ? ' TargetMode="External"' : ''}/>`,
  );
  return `${DECL}<Relationships xmlns="${PKG_REL}">${items.join('')}</Relationships>`;
}

export function contentTypesXml(
  overrides: [string, string][],
  defaults: [string, string][] = [],
): string {
  const all: [string, string][] = [
    ...defaults,
    ['rels', 'application/vnd.openxmlformats-package.relationships+xml'],
    ['xml', 'application/xml'],
  ];
  return (
    `${DECL}<Types xmlns="${CT_NS}">` +
    all.map(([ext, type]) => `<Default Extension="${ext}" ContentType="${type}"/>`).join('') +
    overrides
      .map(([part, type]) => `<Override PartName="${escapeXml(part)}" ContentType="${type}"/>`)
      .join('') +
    '</Types>'
  );
}

export interface PackageOptions {
  method?: 'store' | 'deflate';
  flags?: number;
  extra?: ZipEntryInput[];
  zip?: ZipOptions;
  rename?: (name: string) => string;
}

function pack(parts: [string, string | Uint8Array][], options: PackageOptions): Buffer {
  const rename = options.rename ?? ((name: string) => name);
  const entries: ZipEntryInput[] = parts.map(([name, data]) => ({
    name: rename(name),
    data,
    method: options.method,
    flags: options.flags,
  }));
  return buildZip([...entries, ...(options.extra ?? [])], options.zip);
}

export function wPara(text: string): string {
  return `<w:p><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

export const W_ROOT = `xmlns:w="${W_NS}" xmlns:r="${REL}" xmlns:mc="${MC_NS}"`;

export interface DocxOptions extends PackageOptions {
  body?: string[];
  headers?: string[];
  footers?: string[];
  footnotes?: string[];
  endnotes?: string[];
  textBox?: string;
  deleted?: string;
  moved?: string;
  fieldCode?: string;
  tabbed?: [string, string];
  table?: string[];
  macro?: boolean;
  documentXml?: string;
  bodyXml?: string;
  headerXml?: string[];
  documentRels?: RelInput[];
  overrides?: [string, string][];
  defaults?: [string, string][];
  omitRootRels?: boolean;
  omitContentTypes?: boolean;
}

export function docxParts(options: DocxOptions = {}): [string, string | Uint8Array][] {
  const body: string[] = [options.bodyXml ?? ''];
  for (const text of options.body ?? []) body.push(wPara(text));
  if (options.tabbed !== undefined) {
    const [a, b] = options.tabbed.map(escapeXml);
    body.push(
      '<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/><w:tab w:val="right" w:pos="9000"/>' +
        `</w:tabs></w:pPr><w:r><w:t>${a}</w:t><w:tab/><w:t>${b}</w:t></w:r></w:p>`,
    );
  }
  if (options.table !== undefined) {
    const cells = options.table.map((text) => `<w:tc>${wPara(text)}</w:tc>`).join('');
    body.push(`<w:tbl><w:tr>${cells}</w:tr></w:tbl>`);
  }
  if (options.deleted !== undefined) {
    body.push(
      `<w:p><w:del w:id="1" w:author="a"><w:r><w:delText>${escapeXml(options.deleted)}` +
        '</w:delText></w:r></w:del></w:p>',
    );
  }
  if (options.moved !== undefined) {
    const t = escapeXml(options.moved);
    body.push(
      `<w:p><w:moveFrom w:id="2" w:author="a"><w:r><w:t>${t}</w:t></w:r></w:moveFrom>` +
        `<w:moveTo w:id="3" w:author="a"><w:r><w:t>${t}</w:t></w:r></w:moveTo></w:p>`,
    );
  }
  if (options.fieldCode !== undefined) {
    body.push(
      `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ` +
        `${escapeXml(options.fieldCode)} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`,
    );
  }
  if (options.textBox !== undefined) {
    const inner = `<w:txbxContent>${wPara(options.textBox)}</w:txbxContent>`;
    body.push(
      '<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wps:txbx ' +
        `xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">${inner}</wps:txbx>` +
        '</w:drawing></mc:Choice><mc:Fallback><w:pict><v:textbox xmlns:v="urn:schemas-microsoft-com:vml">' +
        `${inner}</v:textbox></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>`,
    );
  }
  const document =
    options.documentXml ??
    `${DECL}<w:document ${W_ROOT}><w:body>${body.join('')}<w:sectPr/></w:body></w:document>`;

  const parts: [string, string | Uint8Array][] = [];
  const overrides: [string, string][] = [
    ['/word/document.xml', options.macro === true ? CONTENT_TYPE.docm : CONTENT_TYPE.docx],
  ];
  const rels: RelInput[] = [];
  const notes = (kind: 'footnotes' | 'endnotes', texts: string[]): void => {
    const tag = kind === 'footnotes' ? 'footnote' : 'endnote';
    const items = texts
      .map((text, i) => `<w:${tag} w:id="${i + 1}">${wPara(text)}</w:${tag}>`)
      .join('');
    const separator = `<w:${tag} w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:${tag}>`;
    parts.push([
      `word/${kind}.xml`,
      `${DECL}<w:${kind} ${W_ROOT}>${separator}${items}</w:${kind}>`,
    ]);
    overrides.push([`/word/${kind}.xml`, CONTENT_TYPE[kind]]);
    rels.push({ id: `rId${kind}`, type: kind, target: `${kind}.xml` });
  };
  if (options.footnotes !== undefined) notes('footnotes', options.footnotes);
  if (options.endnotes !== undefined) notes('endnotes', options.endnotes);
  const marginal = (kind: 'header' | 'footer', texts: string[]): void => {
    const tag = kind === 'header' ? 'hdr' : 'ftr';
    texts.forEach((text, i) => {
      const xml =
        (kind === 'header' ? options.headerXml?.[i] : undefined) ??
        `${DECL}<w:${tag} ${W_ROOT}>${wPara(text)}</w:${tag}>`;
      parts.push([`word/${kind}${i + 1}.xml`, xml]);
      overrides.push([`/word/${kind}${i + 1}.xml`, CONTENT_TYPE[kind]]);
      rels.push({ id: `rId${kind}${i + 1}`, type: kind, target: `${kind}${i + 1}.xml` });
    });
  };
  marginal('header', options.headers ?? []);
  marginal('footer', options.footers ?? []);
  const defaults: [string, string][] = [...(options.defaults ?? [])];
  if (options.macro === true) {
    parts.push(['word/vbaProject.bin', new Uint8Array([0xcc, 0x61, 0xff, 0x00, 0x01, 0x02])]);
    rels.push({
      id: 'rIdVba',
      type: 'http://schemas.microsoft.com/office/2006/relationships/vbaProject',
      target: 'vbaProject.bin',
    });
    defaults.push(['bin', CONTENT_TYPE.vba]);
  }
  rels.push(...(options.documentRels ?? []));
  overrides.push(...(options.overrides ?? []));

  const out: [string, string | Uint8Array][] = [];
  if (options.omitContentTypes !== true) {
    out.push(['[Content_Types].xml', contentTypesXml(overrides, defaults)]);
  }
  if (options.omitRootRels !== true) {
    out.push([
      '_rels/.rels',
      relsXml([{ id: 'rId1', type: 'officeDocument', target: 'word/document.xml' }]),
    ]);
  }
  out.push(['word/document.xml', document]);
  if (rels.length > 0) out.push(['word/_rels/document.xml.rels', relsXml(rels)]);
  out.push(...parts);
  return out;
}

export function docx(options: DocxOptions = {}): Buffer {
  return pack(docxParts(options), options);
}

export type XlsxCell =
  | string
  | number
  | { inline: string }
  | { str: string }
  | { bool: boolean }
  | { error: string }
  | { formula: string; value: string }
  | { ruby: string; reading: string };

export interface XlsxSheet {
  name: string;
  rows: XlsxCell[][];
}

export interface XlsxOptions extends PackageOptions {
  sheets?: XlsxSheet[];
  sheetNumbers?: number[];
  sharedPadding?: string[];
  chartsheet?: string;
  macro?: boolean;
  omitWorkbookRels?: boolean;
  workbookXml?: string;
  workbookRels?: RelInput[];
}

function colName(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export function xlsxParts(options: XlsxOptions = {}): [string, string | Uint8Array][] {
  const sheets = options.sheets ?? [];
  const shared: string[] = [];
  const sharedIndex = new Map<string, number>();
  const sharedOf = (xml: string): number => {
    const known = sharedIndex.get(xml);
    if (known !== undefined) return known;
    shared.push(xml);
    sharedIndex.set(xml, shared.length - 1);
    return shared.length - 1;
  };
  const cellXml = (cell: XlsxCell, ref: string): string => {
    if (typeof cell === 'string') {
      return `<c r="${ref}" t="s"><v>${sharedOf(`<si><t xml:space="preserve">${escapeXml(cell)}</t></si>`)}</v></c>`;
    }
    if (typeof cell === 'number') return `<c r="${ref}"><v>${cell}</v></c>`;
    if ('inline' in cell) {
      return `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(cell.inline)}</t></is></c>`;
    }
    if ('str' in cell) {
      return `<c r="${ref}" t="str"><f>CONCAT("x")</f><v>${escapeXml(cell.str)}</v></c>`;
    }
    if ('bool' in cell) return `<c r="${ref}" t="b"><v>${cell.bool ? 1 : 0}</v></c>`;
    if ('error' in cell) return `<c r="${ref}" t="e"><v>${escapeXml(cell.error)}</v></c>`;
    if ('formula' in cell) {
      return `<c r="${ref}"><f>${escapeXml(cell.formula)}</f><v>${escapeXml(cell.value)}</v></c>`;
    }
    const si =
      `<si><t>${escapeXml(cell.ruby)}</t><rPh sb="0" eb="1"><t>${escapeXml(cell.reading)}</t></rPh>` +
      '</si>';
    return `<c r="${ref}" t="s"><v>${sharedOf(si)}</v></c>`;
  };

  const numbers = options.sheetNumbers ?? sheets.map((_, i) => i + 1);
  const parts: [string, string | Uint8Array][] = [];
  const overrides: [string, string][] = [
    ['/xl/workbook.xml', options.macro === true ? CONTENT_TYPE.xlsm : CONTENT_TYPE.xlsx],
  ];
  const rels: RelInput[] = [];
  const listed: string[] = [];
  sheets.forEach((sheet, i) => {
    const rows = sheet.rows
      .map(
        (row, r) =>
          `<row r="${r + 1}">${row.map((cell, c) => cellXml(cell, `${colName(c)}${r + 1}`)).join('')}</row>`,
      )
      .join('');
    const file = `worksheets/sheet${numbers[i]}.xml`;
    parts.push([
      `xl/${file}`,
      `${DECL}<worksheet xmlns="${S_NS}" xmlns:r="${REL}"><sheetData>${rows}</sheetData></worksheet>`,
    ]);
    overrides.push([`/xl/${file}`, CONTENT_TYPE.worksheet]);
    rels.push({ id: `rId${i + 1}`, type: 'worksheet', target: file });
    listed.push(`<sheet name="${escapeXml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`);
  });
  if (options.chartsheet !== undefined) {
    parts.push([
      'xl/chartsheets/sheet1.xml',
      `${DECL}<chartsheet xmlns="${S_NS}"><sheetPr/></chartsheet>`,
    ]);
    overrides.push(['/xl/chartsheets/sheet1.xml', CONTENT_TYPE.chartsheet]);
    rels.push({ id: 'rIdChart', type: 'chartsheet', target: 'chartsheets/sheet1.xml' });
    listed.push(`<sheet name="${escapeXml(options.chartsheet)}" sheetId="99" r:id="rIdChart"/>`);
  }
  for (const text of options.sharedPadding ?? []) {
    shared.push(`<si><t>${escapeXml(text)}</t></si>`);
  }
  if (shared.length > 0) {
    parts.push([
      'xl/sharedStrings.xml',
      `${DECL}<sst xmlns="${S_NS}" count="${shared.length}" uniqueCount="${shared.length}">` +
        `${shared.join('')}</sst>`,
    ]);
    overrides.push(['/xl/sharedStrings.xml', CONTENT_TYPE.sharedStrings]);
    rels.push({ id: 'rIdShared', type: 'sharedStrings', target: 'sharedStrings.xml' });
  }
  const workbook =
    options.workbookXml ??
    `${DECL}<workbook xmlns="${S_NS}" xmlns:r="${REL}"><bookViews/><sheets>${listed.join('')}` +
      '</sheets></workbook>';
  const defaults: [string, string][] = [];
  if (options.macro === true) {
    parts.push(['xl/vbaProject.bin', new Uint8Array([0xcc, 0x61, 0xff, 0x00])]);
    rels.push({
      id: 'rIdVba',
      type: 'http://schemas.microsoft.com/office/2006/relationships/vbaProject',
      target: 'vbaProject.bin',
    });
    defaults.push(['bin', CONTENT_TYPE.vba]);
  }
  const out: [string, string | Uint8Array][] = [
    ['[Content_Types].xml', contentTypesXml(overrides, defaults)],
    ['_rels/.rels', relsXml([{ id: 'rId1', type: 'officeDocument', target: 'xl/workbook.xml' }])],
    ['xl/workbook.xml', workbook],
  ];
  if (options.omitWorkbookRels !== true) {
    out.push(['xl/_rels/workbook.xml.rels', relsXml(options.workbookRels ?? rels)]);
  }
  out.push(...parts);
  return out;
}

export function xlsx(options: XlsxOptions = {}): Buffer {
  return pack(xlsxParts(options), options);
}

function aParas(text: string): string {
  return text
    .split('\n')
    .map((line) => `<a:p><a:r><a:t>${escapeXml(line)}</a:t></a:r></a:p>`)
    .join('');
}

function slideXml(root: 'p:sld' | 'p:notes', text: string, shapes = ''): string {
  return (
    `${DECL}<${root} xmlns:a="${A_NS}" xmlns:p="${P_NS}" xmlns:r="${REL}"><p:cSld><p:spTree>` +
    `<p:sp><p:txBody><a:bodyPr/>${aParas(text)}</p:txBody></p:sp>${shapes}</p:spTree></p:cSld></${root}>`
  );
}

export interface PptxOptions extends PackageOptions {
  slides?: string[];
  notes?: (string | undefined)[];
  order?: number[];
  macro?: boolean;
  omitPresentationRels?: boolean;
  shapeXml?: string;
}

export function pptxParts(options: PptxOptions = {}): [string, string | Uint8Array][] {
  const slides = options.slides ?? [];
  const numbers = options.order ?? slides.map((_, i) => i + 1);
  const parts: [string, string | Uint8Array][] = [];
  const overrides: [string, string][] = [
    ['/ppt/presentation.xml', options.macro === true ? CONTENT_TYPE.pptm : CONTENT_TYPE.pptx],
  ];
  const rels: RelInput[] = [
    { id: 'rIdMaster', type: 'slideMaster', target: 'slideMasters/slideMaster1.xml' },
  ];
  const ids: string[] = [];
  slides.forEach((text, i) => {
    const n = numbers[i];
    const shapes = i === 0 ? (options.shapeXml ?? '') : '';
    parts.push([`ppt/slides/slide${n}.xml`, slideXml('p:sld', text, shapes)]);
    overrides.push([`/ppt/slides/slide${n}.xml`, CONTENT_TYPE.slide]);
    rels.push({ id: `rId${i + 1}`, type: 'slide', target: `slides/slide${n}.xml` });
    ids.push(`<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`);
    const note = options.notes?.[i];
    if (note !== undefined) {
      parts.push([`ppt/notesSlides/notesSlide${n}.xml`, slideXml('p:notes', note)]);
      overrides.push([`/ppt/notesSlides/notesSlide${n}.xml`, CONTENT_TYPE.notesSlide]);
      parts.push([
        `ppt/slides/_rels/slide${n}.xml.rels`,
        relsXml([{ id: 'rId1', type: 'notesSlide', target: `../notesSlides/notesSlide${n}.xml` }]),
      ]);
    }
  });
  const defaults: [string, string][] = [];
  if (options.macro === true) {
    parts.push(['ppt/vbaProject.bin', new Uint8Array([0xcc, 0x61, 0xff, 0x00])]);
    rels.push({
      id: 'rIdVba',
      type: 'http://schemas.microsoft.com/office/2006/relationships/vbaProject',
      target: 'vbaProject.bin',
    });
    defaults.push(['bin', CONTENT_TYPE.vba]);
  }
  const presentation =
    `${DECL}<p:presentation xmlns:a="${A_NS}" xmlns:p="${P_NS}" xmlns:r="${REL}">` +
    '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdMaster"/></p:sldMasterIdLst>' +
    `<p:sldIdLst>${ids.join('')}</p:sldIdLst></p:presentation>`;
  const out: [string, string | Uint8Array][] = [
    ['[Content_Types].xml', contentTypesXml(overrides, defaults)],
    [
      '_rels/.rels',
      relsXml([{ id: 'rId1', type: 'officeDocument', target: 'ppt/presentation.xml' }]),
    ],
    ['ppt/presentation.xml', presentation],
  ];
  if (options.omitPresentationRels !== true) {
    out.push(['ppt/_rels/presentation.xml.rels', relsXml(rels)]);
  }
  out.push(...parts);
  return out;
}

export function pptx(options: PptxOptions = {}): Buffer {
  return pack(pptxParts(options), options);
}
