import { deflateRawSync } from 'node:zlib';
import {
  buildZip,
  CONTENT_TYPE,
  contentTypesXml,
  DECL,
  docx,
  docxParts,
  escapeXml,
  REL,
  type RelInput,
  relsXml,
  S_NS,
  W_ROOT,
  wPara,
  xlsx,
  type ZipEntryInput,
} from '../../src/seed/ooxml-sample.js';

const MIB = 1024 * 1024;

export function encrypted(): Buffer {
  const magic = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  return Buffer.concat([magic, Buffer.alloc(504, 0x2a)]);
}

export function zeroBomb(size: number = 80 * MIB): Buffer {
  return deflateRawSync(Buffer.alloc(size), { level: 9 });
}

export function bomb(deflated: Uint8Array, where: 'main' | 'header' = 'main'): Buffer {
  const parts = docxParts({ body: ['bomb body phrase'], headers: ['bomb header phrase'] });
  const target = where === 'main' ? 'word/document.xml' : 'word/header1.xml';
  return buildZip(
    parts.map(([name, data]) =>
      name === target ? { name, deflated, declaredSize: 1234 } : { name, data },
    ),
  );
}

export function relsBomb(deflated: Uint8Array, count = 1000): Buffer {
  const parts = sharedTargetParts(count, 'worksheets/sheet1.xml');
  return buildZip(
    parts.map(([name, data]) =>
      name === 'xl/worksheets/sheet1.xml' ? { name, deflated, declaredSize: 99 } : { name, data },
    ),
  );
}

export function sharedTarget(count = 1000, phrase = 'shared sheet phrase'): Buffer {
  return buildZip(
    sharedTargetParts(count, 'worksheets/sheet1.xml', phrase).map(([name, data]) => ({
      name,
      data,
    })),
  );
}

function sharedTargetParts(
  count: number,
  target: string,
  phrase = 'shared sheet phrase',
): [string, string | Uint8Array][] {
  const sheets: string[] = [];
  const rels: RelInput[] = [];
  for (let i = 1; i <= count; i++) {
    sheets.push(`<sheet name="S${i}" sheetId="${i}" r:id="rId${i}"/>`);
    rels.push({ id: `rId${i}`, type: 'worksheet', target });
  }
  return [
    [
      '[Content_Types].xml',
      contentTypesXml([
        ['/xl/workbook.xml', CONTENT_TYPE.xlsx],
        ['/xl/worksheets/sheet1.xml', CONTENT_TYPE.worksheet],
      ]),
    ],
    ['_rels/.rels', relsXml([{ id: 'rId1', type: 'officeDocument', target: 'xl/workbook.xml' }])],
    [
      'xl/workbook.xml',
      `${DECL}<workbook xmlns="${S_NS}" xmlns:r="${REL}"><sheets>${sheets.join('')}</sheets></workbook>`,
    ],
    ['xl/_rels/workbook.xml.rels', relsXml(rels)],
    [
      'xl/worksheets/sheet1.xml',
      `${DECL}<worksheet xmlns="${S_NS}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>` +
        `${escapeXml(phrase)}</t></is></c></row></sheetData></worksheet>`,
    ],
  ];
}

export function overlapBomb(deflated: Uint8Array, count = 1000): Buffer {
  const parts = sharedTargetParts(1, 'worksheets/sheet1.xml');
  const entries: ZipEntryInput[] = parts
    .filter(([name]) => name !== 'xl/worksheets/sheet1.xml')
    .map(([name, data]) => ({ name, data }));
  const bombIndex = entries.length;
  entries.push({ name: 'xl/worksheets/sheet1.xml', deflated, declaredSize: 99 });
  for (let i = 2; i <= count; i++) {
    entries.push({ name: `xl/worksheets/sheet${i}.xml`, shareDataWith: bombIndex });
  }
  return buildZip(entries);
}

export function storedOverlap(count = 50): Buffer {
  const entries: ZipEntryInput[] = docxParts({ body: ['stored overlap phrase'] }).map(
    ([name, data]) => ({ name, data, method: 'store' }),
  );
  const main = entries.findIndex((entry) => entry.name === 'word/document.xml');
  for (let i = 1; i <= count; i++) {
    entries.push({ name: `word/copy${i}.xml`, shareDataWith: main });
  }
  return buildZip(entries);
}

export type CorruptKind =
  | 'truncated'
  | 'bad-eocd'
  | 'bad-local-offset'
  | 'bad-cd-signature'
  | 'bad-deflate'
  | 'entry-count'
  | 'no-local-signature';

export function corrupt(kind: CorruptKind): Buffer {
  const parts = docxParts({ body: ['corrupt body phrase'] });
  const entries: ZipEntryInput[] = parts.map(([name, data]) => ({ name, data }));
  const main = entries.findIndex((entry) => entry.name === 'word/document.xml');
  switch (kind) {
    case 'truncated': {
      const whole = buildZip(entries);
      return whole.subarray(0, Math.floor(whole.length * 0.6));
    }
    case 'bad-eocd':
      return buildZip(entries, { eocd: { cdOffset: 0x7fff0000 } });
    case 'entry-count':
      return buildZip(entries, {
        eocd: { entriesOnDisk: entries.length + 1, totalEntries: entries.length + 1 },
      });
    case 'bad-local-offset':
      entries[main] = { ...entries[main], localOffset: 7 };
      return buildZip(entries);
    case 'bad-deflate':
      entries[main] = {
        name: 'word/document.xml',
        deflated: Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
      };
      return buildZip(entries);
    case 'bad-cd-signature': {
      const whole = buildZip(entries);
      const cdOffset = whole.readUInt32LE(whole.length - 22 + 16);
      whole.writeUInt32LE(0x12345678, cdOffset);
      return whole;
    }
    case 'no-local-signature': {
      const whole = buildZip(entries);
      whole.writeUInt32LE(0x12345678, 0);
      return whole;
    }
  }
}

export function doctype(where: 'main' | 'header' = 'main'): Buffer {
  const dtd = '<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]>';
  if (where === 'main') {
    return docx({
      documentXml:
        `${DECL}${dtd}<w:document ${W_ROOT}><w:body>${wPara('doctype body phrase &lol2;')}` +
        '</w:body></w:document>',
    });
  }
  return docx({
    body: ['doctype safe body'],
    headers: ['unused'],
    headerXml: [`${DECL}${dtd}<w:hdr ${W_ROOT}>${wPara('doctype header phrase')}</w:hdr>`],
  });
}

export function hugeShared(): Buffer {
  const padding: string[] = [];
  for (let i = 0; i < 40_000; i++)
    padding.push(`padding shared string number ${i} ${'x'.repeat(24)}`);
  return xlsx({
    sheets: [
      {
        name: 'LedgerSheetName',
        rows: [['shared phrase lost'], [{ inline: 'inline phrase kept' }, 10045]],
      },
    ],
    sharedPadding: padding,
  });
}

export type Zip64Kind = 'sizes' | 'locator' | 'count' | 'offset';

export function zip64(kind: Zip64Kind): Buffer {
  const entries: ZipEntryInput[] = docxParts({ body: ['zip64 phrase'] }).map(([name, data]) => ({
    name,
    data,
  }));
  switch (kind) {
    case 'sizes':
      entries[0] = { ...entries[0], declaredSize: 0xffffffff };
      return buildZip(entries);
    case 'offset':
      entries[1] = { ...entries[1], localOffset: 0xffffffff };
      return buildZip(entries);
    case 'locator':
      return buildZip(entries, { zip64Locator: true });
    case 'count':
      return buildZip(entries, { eocd: { entriesOnDisk: 0xffff, totalEntries: 0xffff } });
  }
}

export function zipEncrypted(): Buffer {
  return docx({ body: ['encrypted phrase'], flags: 1 });
}

export function duplicateNames(caseOnly = false): Buffer {
  const entries: ZipEntryInput[] = docxParts({ body: ['duplicate phrase'] }).map(
    ([name, data]) => ({ name, data }),
  );
  entries.push({ name: caseOnly ? 'WORD/Document.XML' : 'word/document.xml', data: '<x/>' });
  return buildZip(entries);
}

export function mixedCaseNames(): Buffer {
  return docx({ body: ['mixed case phrase'], rename: (name) => name.toUpperCase() });
}

export function dataDescriptor(): Buffer {
  return docx({ body: ['descriptor phrase'], flags: 8 });
}

export function protoPollution(): Buffer {
  return docx({
    bodyXml: `<w:p __proto__="polluted" constructor="x"><w:r><w:t>proto body phrase</w:t></w:r></w:p>`,
    headers: ['proto header phrase'],
    documentRels: [
      { id: '__proto__', type: 'header', target: 'header1.xml' },
      { id: 'constructor', type: 'footer', target: '__proto__' },
    ],
    overrides: [
      ['/__proto__', CONTENT_TYPE.footer],
      ['/constructor', CONTENT_TYPE.footer],
    ],
    defaults: [['__proto__', 'application/x-proto']],
    extra: [
      {
        name: 'word/__proto__',
        data: `${DECL}<w:ftr ${W_ROOT}>${wPara('proto footer phrase')}</w:ftr>`,
      },
      { name: '__proto__', data: 'not xml' },
    ],
  });
}

export function fakeEocdInComment(): Buffer {
  const fake = Buffer.alloc(22);
  fake.writeUInt32LE(0x06054b50, 0);
  fake.writeUInt16LE(1, 8);
  fake.writeUInt16LE(1, 10);
  fake.writeUInt32LE(46, 12);
  fake.writeUInt32LE(0x7fff0000, 16);
  fake.writeUInt16LE(0, 20);
  return docx({
    body: ['fake eocd phrase'],
    zip: { comment: Buffer.concat([Buffer.from('comment:'), fake, Buffer.alloc(10, 0x20)]) },
  });
}

export function largeDocx(bytes: number, phrase: string): Buffer {
  const unit = '<w:bookmarkStart w:id="1" w:name="b"/><w:bookmarkEnd w:id="1"/>';
  const filler = unit.repeat(Math.max(1, Math.floor(bytes / unit.length)));
  return docx({
    method: 'store',
    documentXml:
      `${DECL}<w:document ${W_ROOT}><w:body><w:p>${filler}</w:p>${wPara(phrase)}` +
      '</w:body></w:document>',
  });
}

export function deepNameDocx(count = 10_000, phrase = 'deep name phrase'): Buffer {
  const dir = 'd/'.repeat(500);
  const main = `${dir}document.xml`;
  const rels: RelInput[] = [];
  for (let i = 0; i < count; i++) rels.push({ id: `rId${i}`, type: 'header', target: `h${i}.xml` });
  return buildZip([
    { name: '[Content_Types].xml', data: contentTypesXml([[`/${main}`, CONTENT_TYPE.docx]]) },
    { name: '_rels/.rels', data: relsXml([{ id: 'rId1', type: 'officeDocument', target: main }]) },
    {
      name: main,
      data: `${DECL}<w:document ${W_ROOT}><w:body>${wPara(phrase)}</w:body></w:document>`,
    },
    { name: `${dir}_rels/document.xml.rels`, data: relsXml(rels) },
  ]);
}

const DEEP_SLIDE_DIR = `ppt/${'s/'.repeat(490)}`;

export function deepSlideRelsKey(n: number): string {
  return `${DEEP_SLIDE_DIR}_rels/slide${n}.xml.rels`;
}

export function deepNamePptx(slides = 40, relsPerSlide = 2_000): Buffer {
  const entries: ZipEntryInput[] = [];
  const overrides: [string, string][] = [['/ppt/presentation.xml', CONTENT_TYPE.pptx]];
  const presentationRels: RelInput[] = [];
  const ids: string[] = [];
  for (let n = 1; n <= slides; n++) {
    const slide = `${DEEP_SLIDE_DIR}slide${n}.xml`;
    overrides.push([`/${slide}`, CONTENT_TYPE.slide]);
    presentationRels.push({ id: `rId${n}`, type: 'slide', target: slide.slice('ppt/'.length) });
    ids.push(`<p:sldId id="${255 + n}" r:id="rId${n}"/>`);
    entries.push({
      name: slide,
      data:
        `${DECL}<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>deep slide ${n}</a:t>` +
        '</a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
    });
    const rels: RelInput[] = [];
    for (let i = 0; i < relsPerSlide; i++) {
      rels.push({ id: `rId${i}`, type: 'image', target: `../media/image${i}.png` });
    }
    entries.push({ name: deepSlideRelsKey(n), data: relsXml(rels) });
  }
  const presentation =
    `${DECL}<p:presentation xmlns:r="${REL}"><p:sldIdLst>${ids.join('')}</p:sldIdLst>` +
    '</p:presentation>';
  return buildZip([
    { name: '[Content_Types].xml', data: contentTypesXml(overrides) },
    {
      name: '_rels/.rels',
      data: relsXml([{ id: 'rId1', type: 'officeDocument', target: 'ppt/presentation.xml' }]),
    },
    { name: 'ppt/presentation.xml', data: presentation },
    { name: 'ppt/_rels/presentation.xml.rels', data: relsXml(presentationRels) },
    ...entries,
  ]);
}

export function longEntryName(bytes: number): Buffer {
  return buildZip([{ name: `${'n'.repeat(bytes - 4)}.xml`, data: '<a/>' }]);
}
