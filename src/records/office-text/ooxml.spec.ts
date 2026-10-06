import {
  deepNameDocx,
  deepNamePptx,
  deepSlideRelsKey,
  doctype,
  hugeShared,
  protoPollution,
  relsBomb,
  sharedTarget,
  zeroBomb,
} from '../../../test/helpers/ooxml-hostile.js';
import {
  buildZip,
  CONTENT_TYPE,
  contentTypesXml,
  docx,
  docxParts,
  pptx,
  pptxParts,
  type RelInput,
  relsXml,
  xlsx,
  xlsxParts,
} from '../../seed/ooxml-sample.js';
import { officeLimits } from './limits.js';
import { detectFormat, extractFromArchive, mainFormat, resolveTarget } from './ooxml.js';
import type { OfficeLimits, OfficeTextResult } from './types.js';
import { readZip, type ZipArchive } from './zip-reader.js';

const MIB = 1024 * 1024;

function run(
  bytes: Uint8Array,
  overrides: Partial<OfficeLimits> = {},
): { zip: ZipArchive; result: OfficeTextResult } {
  const limits = officeLimits(overrides);
  const zip = readZip(bytes, limits);
  if (typeof zip === 'string') throw new Error(`expected an archive, got ${zip}`);
  return { zip, result: extractFromArchive(zip, limits) };
}

function ok(result: OfficeTextResult): { text: string; truncated: boolean; format: string } {
  if (!result.ok) throw new Error(`expected text, got ${result.reason}`);
  return result;
}

function textOf(bytes: Uint8Array, overrides: Partial<OfficeLimits> = {}): string {
  return ok(run(bytes, overrides).result).text;
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function replacePart(
  parts: [string, string | Uint8Array][],
  name: string,
  data: string | Uint8Array,
): Buffer {
  return buildZip(parts.map(([n, d]) => ({ name: n, data: n === name ? data : d })));
}

function withoutPart(parts: [string, string | Uint8Array][], name: string): Buffer {
  return buildZip(parts.filter(([n]) => n !== name).map(([n, d]) => ({ name: n, data: d })));
}

function withParts(
  parts: [string, string | Uint8Array][],
  extra: [string, string | Uint8Array][],
): Buffer {
  return buildZip([...parts, ...extra].map(([name, data]) => ({ name, data })));
}

function sheetXml(cells: string): string {
  return `<worksheet><sheetData><row r="1">${cells}</row></sheetData></worksheet>`;
}

function measured<T>(work: () => T): { value: T; ms: number; heapGrowth: number } {
  const heap = process.memoryUsage().heapUsed;
  const start = performance.now();
  const value = work();
  const ms = performance.now() - start;
  return { value, ms, heapGrowth: process.memoryUsage().heapUsed - heap };
}

describe('DOCX (AC 2)', () => {
  it('reads the body, then footnotes, endnotes, headers and footers', () => {
    const { result } = run(
      docx({
        body: ['BODY phrase'],
        footnotes: ['FOOTNOTE phrase'],
        endnotes: ['ENDNOTE phrase'],
        headers: ['HEADER phrase'],
        footers: ['FOOTER phrase'],
      }),
    );
    const { text, truncated, format } = ok(result);
    expect(format).toBe('docx');
    expect(truncated).toBe(false);
    const order = ['BODY', 'FOOTNOTE', 'ENDNOTE', 'HEADER', 'FOOTER'].map((w) => text.indexOf(w));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('skips tracked deletions, field codes and moved-from text; keeps text-box text once', () => {
    const text = textOf(
      docx({
        body: ['kept phrase'],
        deleted: 'DELETED phrase',
        fieldCode: 'HYPERLINK "https://example.test"',
        moved: 'MOVED phrase',
        textBox: 'TEXTBOX phrase',
      }),
    );
    expect(text).toContain('kept phrase');
    expect(text).not.toContain('DELETED');
    expect(text).not.toContain('HYPERLINK');
    expect(count(text, 'MOVED phrase')).toBe(1);
    expect(count(text, 'TEXTBOX phrase')).toBe(1);
  });

  it('deduplicates identical header and footer texts', () => {
    const text = textOf(
      docx({
        body: ['b'],
        headers: ['same marginal', 'same marginal'],
        footers: ['same marginal'],
      }),
    );
    expect(count(text, 'same marginal')).toBe(1);
  });

  it('reads at most 30 header and footer parts and flags the rest', () => {
    const headers = Array.from({ length: 35 }, (_, i) => `marginal-${i + 1}-end`);
    const { text, truncated } = ok(run(docx({ body: ['b'], headers })).result);
    expect(text).toContain('marginal-30-end');
    expect(text).not.toContain('marginal-31-end');
    expect(truncated).toBe(true);
  });

  it('emits separators: paragraphs, run tabs (not tab stops), breaks, hyphens, cells', () => {
    const text = textOf(
      docx({
        bodyXml:
          '<w:p><w:r><w:t>a</w:t><w:br/><w:t>b</w:t><w:noBreakHyphen/><w:t>c</w:t><w:cr/>' +
          '<w:t>d</w:t></w:r></w:p>',
        tabbed: ['left', 'right'],
        table: ['cellA', 'cellB'],
      }),
    );
    expect(text).toContain('a\nb-c\nd\n');
    expect(text).toContain('left\tright\n');
    expect(text).not.toContain('\t\tleft');
    expect(text).toContain('cellA\n\tcellB\n\t');
  });

  it('includes hidden (vanish) text and keeps unknown entities literal', () => {
    const text = textOf(
      docx({
        bodyXml:
          '<w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>hidden phrase</w:t></w:r></w:p>' +
          '<w:p><w:r><w:t>a &nbsp; b &amp; c</w:t></w:r></w:p>',
      }),
    );
    expect(text).toContain('hidden phrase');
    expect(text).toContain('a &nbsp; b & c');
  });

  it('matches local names whatever the prefix (U3)', () => {
    const xml =
      '<?xml version="1.0"?><x:document xmlns:x="http://purl.oclc.org/ooxml/wordprocessingml/main">' +
      '<x:body><x:p><x:r><x:t>prefixed phrase</x:t></x:r></x:p></x:body></x:document>';
    expect(textOf(docx({ documentXml: xml }))).toContain('prefixed phrase');
  });

  it('keeps Arabic text intact', () => {
    expect(textOf(docx({ body: ['عقد توريد مع أحمد'] }))).toContain('عقد توريد مع أحمد');
  });

  it('decodes a UTF-16 main part by its BOM', () => {
    const xml =
      '<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>utf16 phrase</w:t></w:r></w:p>' +
      '</w:body></w:document>';
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]);
    expect(textOf(replacePart(docxParts({}), 'word/document.xml', bytes))).toContain(
      'utf16 phrase',
    );
  });

  it('drops a header with a DOCTYPE and flags truncation; a DOCTYPE main part is corrupt', () => {
    const { text, truncated } = ok(run(doctype('header')).result);
    expect(text).toContain('doctype safe body');
    expect(text).not.toContain('doctype header phrase');
    expect(truncated).toBe(true);
    expect(run(doctype('main')).result).toEqual({ ok: false, reason: 'corrupt' });
  });

  it('counts distinct header and footer parts, not rels, toward the cap of 30', () => {
    const again = Array.from({ length: 40 }, (_, i) => ({
      id: `rIdAgain${i}`,
      type: 'header',
      target: 'header1.xml',
    }));
    const { text, truncated } = ok(
      run(docx({ body: ['b'], headers: ['solo header'], documentRels: again })).result,
    );
    expect(count(text, 'solo header')).toBe(1);
    expect(truncated).toBe(false);
  });

  it('reports a main part named by .rels but missing from the ZIP as corrupt', () => {
    const bytes = withoutPart(docxParts({ body: ['gone'] }), 'word/document.xml');
    expect(run(bytes).result).toEqual({ ok: false, reason: 'corrupt' });
  });

  it('aborts a part whose skip regions nest deeper than 10,000', () => {
    const deep = (n: number): string =>
      `<w:document><w:body>${'<mc:Fallback>'.repeat(n)}${'</mc:Fallback>'.repeat(n)}` +
      '<w:p><w:r><w:t>after</w:t></w:r></w:p></w:body></w:document>';
    expect(run(docx({ documentXml: deep(10_001) })).result).toEqual({
      ok: false,
      reason: 'corrupt',
    });
    expect(textOf(docx({ documentXml: deep(10_000) }))).toContain('after');
  });
});

describe('XLSX (AC 3)', () => {
  it('reads each cell type into text; formulas, booleans, errors and phonetics are skipped', () => {
    const { text, truncated, format } = ok(
      run(
        xlsx({
          sheets: [
            {
              name: 'Cells',
              rows: [
                [
                  'shared phrase',
                  10045,
                  { inline: 'inline phrase' },
                  { str: 'formula string' },
                  { bool: true },
                  { error: '#DIV/0!' },
                  { formula: 'SUM(A1:A2)', value: '77' },
                  { ruby: '漢字', reading: 'かんじ' },
                ],
              ],
            },
          ],
        }),
      ).result,
    );
    expect(format).toBe('xlsx');
    expect(truncated).toBe(false);
    expect(text).toBe(
      'Cells\nshared phrase\t10045\tinline phrase\tformula string\t\t\t77\t漢字\t\n',
    );
  });

  it('follows workbook order, not part numbers, and skips chartsheets', () => {
    const text = textOf(
      xlsx({
        sheets: [
          { name: 'AlphaSheet', rows: [['alpha cell']] },
          { name: 'BetaSheet', rows: [[{ inline: 'beta cell' }]] },
        ],
        sheetNumbers: [10, 2],
        chartsheet: 'ChartOnlySheet',
      }),
    );
    expect(text.indexOf('AlphaSheet')).toBeLessThan(text.indexOf('BetaSheet'));
    expect(text.indexOf('alpha cell')).toBeLessThan(text.indexOf('beta cell'));
    expect(text).not.toContain('ChartOnlySheet');
  });

  const inlineSheet = (phrase: string): string =>
    sheetXml(`<c r="A1" t="inlineStr"><is><t>${phrase}</t></is></c>`);

  const workbookWith = (sheets: string, rels: RelInput[]): [string, string | Uint8Array][] =>
    xlsxParts({
      sheets: [{ name: 'Data', rows: [[{ inline: 'data cell' }]] }],
      workbookXml:
        '<workbook xmlns:r="r"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/>' +
        `${sheets}</sheets></workbook>`,
      workbookRels: [{ id: 'rId1', type: 'worksheet', target: 'worksheets/sheet1.xml' }, ...rels],
    });

  it('skips dialogsheets, macrosheets and every other non-worksheet sheet silently', () => {
    const parts = workbookWith(
      '<sheet name="DialogName" sheetId="2" r:id="rIdDialog"/>' +
        '<sheet name="MacroName" sheetId="3" r:id="rIdMacro"/>',
      [
        { id: 'rIdDialog', type: 'dialogsheet', target: 'dialogsheets/sheet1.xml' },
        {
          id: 'rIdMacro',
          type: 'http://schemas.microsoft.com/office/2006/relationships/xlMacrosheet',
          target: 'macrosheets/sheet1.xml',
        },
      ],
    );
    const { zip, result } = run(
      withParts(parts, [
        ['xl/dialogsheets/sheet1.xml', inlineSheet('dialog phrase')],
        ['xl/macrosheets/sheet1.xml', inlineSheet('macro phrase')],
      ]),
    );
    expect(ok(result)).toMatchObject({ text: 'Data\ndata cell\t\n', truncated: false });
    expect(zip.readLog).not.toContain('xl/dialogsheets/sheet1.xml');
    expect(zip.readLog).not.toContain('xl/macrosheets/sheet1.xml');
  });

  it('keeps the name of a listed sheet with no rel and flags truncation', () => {
    const parts = workbookWith('<sheet name="GhostSheet" sheetId="2" r:id="rIdGhost"/>', []);
    const { text, truncated } = ok(run(withParts(parts, [])).result);
    expect(text).toBe('Data\ndata cell\t\n\nGhostSheet\n');
    expect(truncated).toBe(true);
  });

  it('reads a `t="d"` cell as its raw value', () => {
    const parts = xlsxParts({ sheets: [{ name: 'Dates', rows: [] }] });
    const cell = '<c r="A1" t="d"><v>2026-10-01T00:00:00Z</v></c>';
    const text = textOf(replacePart(parts, 'xl/worksheets/sheet1.xml', sheetXml(cell)));
    expect(text).toBe('Dates\n2026-10-01T00:00:00Z\t\n');
  });

  it('skips a phonetic run (rPh) inside an inline string', () => {
    const parts = xlsxParts({ sheets: [{ name: 'Ruby', rows: [] }] });
    const cell =
      '<c r="A1" t="inlineStr"><is><t>漢字</t><rPh sb="0" eb="2"><t>かんじ</t></rPh></is></c>';
    const text = textOf(replacePart(parts, 'xl/worksheets/sheet1.xml', sheetXml(cell)));
    expect(text).toBe('Ruby\n漢字\t\n');
  });

  it('flags truncation when the sharedStrings rel names a missing part', () => {
    const parts = xlsxParts({
      sheets: [{ name: 'S', rows: [['lost shared', { inline: 'kept inline' }]] }],
    });
    const { text, truncated } = ok(run(withoutPart(parts, 'xl/sharedStrings.xml')).result);
    expect(text).toBe('S\n\tkept inline\t\n');
    expect(truncated).toBe(true);
  });

  it('falls back to a numeric sort of worksheets when the workbook rels are missing', () => {
    const text = textOf(
      xlsx({
        sheets: [
          { name: 'AlphaSheet', rows: [['alpha cell']] },
          { name: 'BetaSheet', rows: [[{ inline: 'beta cell' }]] },
        ],
        sheetNumbers: [10, 2],
        omitWorkbookRels: true,
      }),
    );
    expect(text).toContain('AlphaSheet');
    expect(text).toContain('BetaSheet');
    expect(text.indexOf('beta cell')).toBeLessThan(text.indexOf('alpha cell'));
  });

  it('caps shared strings: a later index reads as empty and sets truncated', () => {
    const { text, truncated } = ok(
      run(xlsx({ sheets: [{ name: 'S', rows: [['one', 'two', 'three']] }] }), {
        maxSharedStrings: 2,
      }).result,
    );
    expect(text).toBe('S\none\ttwo\t\t\n');
    expect(truncated).toBe(true);
  });

  it('keeps sheet text when sharedStrings exceeds the part cap (AC 11)', () => {
    const { text, truncated } = ok(run(hugeShared(), { maxPartBytes: 1 * MIB }).result);
    expect(truncated).toBe(true);
    expect(text).toContain('LedgerSheetName');
    expect(text).toContain('inline phrase kept');
    expect(text).toContain('10045');
    expect(text).not.toContain('shared phrase lost');
  });

  it('scans a part referenced by many rels once', () => {
    const { zip, result } = run(sharedTarget(1000, 'shared sheet phrase'));
    const { text } = ok(result);
    expect(count(text, 'shared sheet phrase')).toBe(1);
    expect(text).toContain('S1000');
    expect(zip.readLog.filter((name) => name === 'xl/worksheets/sheet1.xml')).toHaveLength(1);
  });

  it('survives 1000 sheet rels pointing at one bomb part in under 200 ms', () => {
    const bytes = relsBomb(zeroBomb(40 * MIB), 1000);
    const start = performance.now();
    const { zip, result } = run(bytes, { maxPartBytes: 1 * MIB });
    const elapsed = performance.now() - start;
    const { truncated } = ok(result);
    expect(truncated).toBe(true);
    expect(zip.readLog.filter((name) => name === 'xl/worksheets/sheet1.xml')).toHaveLength(1);
    expect(elapsed).toBeLessThan(200);
  });
});

describe('PPTX (AC 4)', () => {
  it('reads slides in sldIdLst order, then notes in slide order', () => {
    const { text, format } = ok(
      run(
        pptx({
          slides: ['ten slide', 'two slide'],
          notes: ['ten notes', 'two notes'],
          order: [10, 2],
        }),
      ).result,
    );
    expect(format).toBe('pptx');
    const at = ['ten slide', 'two slide', 'ten notes', 'two notes'].map((w) => text.indexOf(w));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(text).toContain('ten slide\n\n\ntwo slide');
  });

  it('falls back to a numeric sort of slides when the presentation rels are missing', () => {
    const text = textOf(
      pptx({ slides: ['ten slide', 'two slide'], order: [10, 2], omitPresentationRels: true }),
    );
    expect(text.indexOf('two slide')).toBeLessThan(text.indexOf('ten slide'));
  });

  it('skips mc:Fallback and emits breaks and cell tabs', () => {
    const shape = (t: string): string =>
      `<p:sp><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp>`;
    const text = textOf(
      pptx({
        slides: ['first'],
        shapeXml:
          `<mc:AlternateContent><mc:Choice Requires="x">${shape('choice phrase')}</mc:Choice>` +
          `<mc:Fallback>${shape('choice phrase')}</mc:Fallback></mc:AlternateContent>` +
          '<a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>c1</a:t></a:r></a:p></a:txBody></a:tc>' +
          '<a:tc><a:txBody><a:p><a:r><a:t>c2</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl>' +
          '<p:sp><p:txBody><a:p><a:r><a:t>up</a:t></a:r><a:br/><a:r><a:t>down</a:t></a:r></a:p>' +
          '</p:txBody></p:sp>',
      }),
    );
    expect(count(text, 'choice phrase')).toBe(1);
    expect(text).toContain('c1\n\tc2\n\t');
    expect(text).toContain('up\ndown\n');
  });

  it('keeps the other slides and flags truncation when a listed slide part is missing', () => {
    const parts = pptxParts({ slides: ['one slide', 'two slide'] });
    const { text, truncated } = ok(run(withoutPart(parts, 'ppt/slides/slide2.xml')).result);
    expect(text).toContain('one slide');
    expect(text).not.toContain('two slide');
    expect(truncated).toBe(true);
  });
});

describe('relationship resolution bounds', () => {
  it('resolves 10,000 rels against a near-cap base name in < 200 ms and < 64 MiB', () => {
    const bytes = deepNameDocx(10_000, 'deep name phrase');
    const { value, ms, heapGrowth } = measured(() => run(bytes).result);
    const { text, truncated } = ok(value);
    expect(text).toContain('deep name phrase');
    expect(truncated).toBe(true);
    expect(ms).toBeLessThan(200);
    expect(heapGrowth).toBeLessThan(64 * MIB);
  });

  it('stops resolving deep slides with many rels once the file budget is spent', () => {
    const bytes = deepNamePptx(40, 2_000);
    const { value, ms, heapGrowth } = measured(() => run(bytes));
    const { text, truncated } = ok(value.result);
    expect(text).toContain('deep slide 1\n');
    expect(text).toContain('deep slide 40\n');
    expect(truncated).toBe(true);
    expect(value.zip.readLog).toContain(deepSlideRelsKey(1));
    expect(value.zip.readLog).not.toContain(deepSlideRelsKey(40));
    expect(ms).toBeLessThan(200);
    expect(heapGrowth).toBeLessThan(64 * MIB);
  });

  it('keeps the rels resolved before the budget ran out and flags truncation', () => {
    const images = Array.from({ length: 1_000 }, (_, i) => ({
      id: `rIdImage${i}`,
      type: 'image',
      target: `media/image${i}.png`,
    }));
    const bytes = docx({ body: ['budget body'], footers: ['early footer'], documentRels: images });
    const { text, truncated } = ok(run(bytes, { maxCentralDirBytes: 1024 }).result);
    expect(text).toContain('budget body');
    expect(text).toContain('early footer');
    expect(truncated).toBe(true);
  });

  it('flags truncation when a rels part has more than maxEntries relationships', () => {
    const images = Array.from({ length: 20 }, (_, i) => ({
      id: `rIdImage${i}`,
      type: 'image',
      target: `media/image${i}.png`,
    }));
    const bytes = docx({ body: ['capped body'], footers: ['first footer'], documentRels: images });
    const { text, truncated } = ok(run(bytes, { maxEntries: 10 }).result);
    expect(text).toContain('first footer');
    expect(truncated).toBe(true);
  });

  it('flags truncation when [Content_Types].xml has more than maxEntries overrides', () => {
    const bytes = docx({
      body: ['content types body'],
      overrides: [
        ['/a.xml', 'application/xml'],
        ['/b.xml', 'application/xml'],
        ['/c.xml', 'application/xml'],
      ],
    });
    const { text, truncated } = ok(run(bytes, { maxEntries: 3 }).result);
    expect(text).toContain('content types body');
    expect(truncated).toBe(true);
  });
});

describe('macro-enabled files (AC 5)', () => {
  it.each([
    ['docm', () => docx({ body: ['docm phrase'], macro: true }), 'word/vbaproject.bin'],
    [
      'xlsm',
      () => xlsx({ sheets: [{ name: 'M', rows: [['xlsm phrase']] }], macro: true }),
      'xl/vbaproject.bin',
    ],
    ['pptm', () => pptx({ slides: ['pptm phrase'], macro: true }), 'ppt/vbaproject.bin'],
  ])('%s gives text and never reads vbaProject.bin', (kind, build, vba) => {
    const bytes = build();
    const { zip, result } = run(bytes);
    expect(zip.has(vba)).toBe(true);
    expect(ok(result).text).toContain(`${kind} phrase`);
    expect(zip.readLog).not.toContain(vba);
  });
});

describe('detection', () => {
  it.each([
    [CONTENT_TYPE.docx, 'docx'],
    [CONTENT_TYPE.docm, 'docx'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml', 'docx'],
    ['application/vnd.ms-word.template.macroEnabledTemplate.main+xml', 'docx'],
    [CONTENT_TYPE.xlsx, 'xlsx'],
    [CONTENT_TYPE.xlsm, 'xlsx'],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml', 'xlsx'],
    ['application/vnd.ms-excel.template.macroEnabled.main+xml', 'xlsx'],
    [CONTENT_TYPE.pptx, 'pptx'],
    [CONTENT_TYPE.pptm, 'pptx'],
    ['application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml', 'pptx'],
    ['application/vnd.openxmlformats-officedocument.presentationml.template.main+xml', 'pptx'],
    ['application/vnd.ms-powerpoint.slideshow.macroEnabled.main+xml', 'pptx'],
    [CONTENT_TYPE.xlsb, null],
    [CONTENT_TYPE.worksheet, null],
    ['application/xml', null],
  ])('%s → %s', (contentType, format) => {
    expect(mainFormat(contentType)).toBe(format);
  });

  const detect = (bytes: Uint8Array): unknown => {
    const limits = officeLimits();
    const zip = readZip(bytes, limits);
    return typeof zip === 'string' ? zip : detectFormat(zip, limits);
  };

  it('detects each family and its main part', () => {
    expect(detect(docx({ body: ['x'] }))).toEqual({ format: 'docx', main: 'word/document.xml' });
    expect(detect(xlsx({ sheets: [] }))).toEqual({ format: 'xlsx', main: 'xl/workbook.xml' });
    expect(detect(pptx({ slides: [] }))).toEqual({ format: 'pptx', main: 'ppt/presentation.xml' });
  });

  it('ignores a plain zip holding document.xml without [Content_Types].xml', () => {
    expect(detect(docx({ body: ['plain zip'], omitContentTypes: true }))).toBe('not-ooxml');
    expect(detect(buildZip([{ name: 'notes.txt', data: 'hello' }]))).toBe('not-ooxml');
  });

  it('uses the single main override when _rels/.rels is missing', () => {
    expect(textOf(docx({ body: ['no root rels'], omitRootRels: true }))).toContain('no root rels');
    expect(
      detect(docx({ omitRootRels: true, overrides: [['/word/second.xml', CONTENT_TYPE.docx]] })),
    ).toBe('not-ooxml');
  });

  it('needs an officeDocument rel and a main-part content type', () => {
    const parts = docxParts({ body: ['x'] });
    const coreOnly = relsXml([
      {
        id: 'rId1',
        type: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',
        target: 'docProps/core.xml',
      },
    ]);
    expect(detect(replacePart(parts, '_rels/.rels', coreOnly))).toBe('not-ooxml');
    const xlsbTypes = contentTypesXml([['/word/document.xml', CONTENT_TYPE.xlsb]]);
    expect(detect(replacePart(parts, '[Content_Types].xml', xlsbTypes))).toBe('not-ooxml');
  });

  it('reads a main part named by a Default extension when no override exists', () => {
    const parts = docxParts({ body: ['default typed'] });
    const types = contentTypesXml([], [['xml', CONTENT_TYPE.docx]]);
    expect(textOf(replacePart(parts, '[Content_Types].xml', types))).toContain('default typed');
  });
});

describe('relationship targets', () => {
  it.each([
    ['word', 'header1.xml', 'word/header1.xml'],
    ['word', 'Header1.XML', 'word/header1.xml'],
    ['ppt/slides', '../notesSlides/notesSlide1.xml', 'ppt/notesslides/notesslide1.xml'],
    ['word', '/word/media/x.xml', 'word/media/x.xml'],
    ['word', './sub/./y.xml', 'word/sub/y.xml'],
    ['word', 'a%20b.xml', 'word/a b.xml'],
    ['word', 'h.xml#fragment', 'word/h.xml'],
    ['', 'word/document.xml', 'word/document.xml'],
    ['word', '../../etc/passwd', null],
    ['', '..', null],
    ['word', '%E0%A4%A.xml', null],
    ['', '', null],
    ['word', '/', null],
  ])('(%s, %s) → %s', (base, target, expected) => {
    expect(resolveTarget(base, target)).toBe(expected);
  });

  it('never dereferences External targets or targets escaping the root', () => {
    const secret = (phrase: string): string =>
      `<w:ftr><w:p><w:r><w:t>${phrase}</w:t></w:r></w:p></w:ftr>`;
    const { zip, result } = run(
      docx({
        body: ['visible body'],
        documentRels: [
          { id: 'rIdExt', type: 'footer', target: 'secret.xml', external: true },
          { id: 'rIdUp', type: 'footer', target: '../../outside.xml' },
        ],
        extra: [
          { name: 'word/secret.xml', data: secret('external phrase') },
          { name: 'outside.xml', data: secret('escaped phrase') },
        ],
      }),
    );
    const { text } = ok(result);
    expect(text).toContain('visible body');
    expect(text).not.toContain('external phrase');
    expect(text).not.toContain('escaped phrase');
    expect(zip.readLog).not.toContain('word/secret.xml');
    expect(zip.readLog).not.toContain('outside.xml');
  });

  it('treats __proto__ ids, part names and attributes as plain keys', () => {
    const before = Object.getOwnPropertyNames(Object.prototype).sort();
    const text = textOf(protoPollution());
    expect(text).toContain('proto body phrase');
    expect(text).toContain('proto header phrase');
    expect(text).toContain('proto footer phrase');
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(before);
    const probe: Record<string, unknown> = {};
    expect(probe['rIdheader1']).toBeUndefined();
    expect(probe['polluted']).toBeUndefined();
    expect(Object.getPrototypeOf(probe)).toBe(Object.prototype);
  });
});

describe('structure parts are released after one scan (SEC re-check L-1)', () => {
  it('releases the content types, the root rels and the main part rels', () => {
    const { zip, result } = run(docx({ body: ['released'], footnotes: ['note'] }));
    expect(ok(result).text).toContain('released');
    expect(zip.failure('[content_types].xml')).toBe('released');
    expect(zip.failure('_rels/.rels')).toBe('released');
    expect(zip.failure('word/_rels/document.xml.rels')).toBe('released');
  });
});

describe('early stop (AC 11)', () => {
  it('stops at maxRawChars, flags truncation and inflates no further parts', () => {
    const body = Array.from({ length: 3_000 }, (_, i) => `${i}`.padEnd(100, '.'));
    const { zip, result } = run(docx({ body, footnotes: ['late footnote'] }));
    const { text, truncated } = ok(result);
    expect(text.length).toBe(200_000);
    expect(truncated).toBe(true);
    expect(zip.readLog).not.toContain('word/footnotes.xml');
    expect(zip.readLog).not.toContain('word/_rels/document.xml.rels');
  });

  it('treats an exact fill as full: truncated, and nothing after the body is read', () => {
    const bytes = docx({ body: ['abcd'], footers: ['late footer'] });
    const { zip, result } = run(bytes, { maxRawChars: 5 });
    expect(ok(result)).toMatchObject({ text: 'abcd\n', truncated: true });
    expect(zip.readLog).not.toContain('word/_rels/document.xml.rels');
    expect(zip.readLog).not.toContain('word/footer1.xml');
  });

  it('takes maxRawChars (2 × CONTENT_TEXT_MAX_CHARS) as a caller override', () => {
    const limits = officeLimits({ maxRawChars: 2 * 1_000 });
    expect(officeLimits().maxRawChars).toBe(200_000);
    const body = Array.from({ length: 100 }, () => 'x'.repeat(50));
    const zip = readZip(docx({ body }), limits);
    if (typeof zip === 'string') throw new Error(zip);
    expect(ok(extractFromArchive(zip, limits)).text.length).toBe(2_000);
  });

  it('never cuts between the halves of a surrogate pair', () => {
    const { text, truncated } = ok(run(docx({ body: ['abcd😀'] }), { maxRawChars: 5 }).result);
    expect(text).toBe('abcd');
    expect(truncated).toBe(true);
  });

  it('counts separators toward the cap', () => {
    const cells = Array.from({ length: 50_000 }, () => ({ inline: '' }));
    const { text, truncated } = ok(
      run(xlsx({ sheets: [{ name: 'Tabs', rows: [cells] }] }), { maxRawChars: 1_000 }).result,
    );
    expect(text.length).toBe(1_000);
    expect(truncated).toBe(true);
  });
});
