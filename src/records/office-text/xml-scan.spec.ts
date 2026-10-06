import {
  decodeEntities,
  decodeXml,
  type HaltSignal,
  scanXml,
  type XmlHandler,
} from './xml-scan.js';

type Event = ['open', string, [string, string][]] | ['close', string] | ['text', string];

function scan(xml: string, maxTagChars = 64 * 1024): { status: string; events: Event[] } {
  const events: Event[] = [];
  const status = scanXml(
    xml,
    {
      open: (local, attrs) => events.push(['open', local, [...attrs]]),
      close: (local) => events.push(['close', local]),
      text: (value) => events.push(['text', value]),
    },
    maxTagChars,
  );
  return { status, events };
}

function texts(xml: string): string[] {
  return scan(xml)
    .events.filter((event) => event[0] === 'text')
    .map((event) => event[1]);
}

describe('scanXml', () => {
  it('reports local names, qualified attributes and self-closing tags', () => {
    expect(scan('<w:p w:rsidR="00A1"><w:t xml:space="preserve">Hi</w:t><w:br/></w:p>')).toEqual({
      status: 'ok',
      events: [
        ['open', 'p', [['w:rsidR', '00A1']]],
        ['open', 't', [['xml:space', 'preserve']]],
        ['text', 'Hi'],
        ['close', 't'],
        ['open', 'br', []],
        ['close', 'br'],
        ['close', 'p'],
      ],
    });
  });

  it('keeps `id` and `r:id` apart', () => {
    const { events } = scan('<p:sldId id="256" r:id="rId2"/>');
    expect(events[0]).toEqual([
      'open',
      'sldId',
      [
        ['id', '256'],
        ['r:id', 'rId2'],
      ],
    ]);
  });

  it('is quote-aware: `>` inside attribute values does not end the tag', () => {
    const { status, events } = scan(`<a b="x>y" c='1>2' d = "sp aced">t</a>`);
    expect(status).toBe('ok');
    expect(events[0]).toEqual([
      'open',
      'a',
      [
        ['b', 'x>y'],
        ['c', '1>2'],
        ['d', 'sp aced'],
      ],
    ]);
    expect(events[1]).toEqual(['text', 't']);
  });

  it('decodes entities in attribute values', () => {
    expect(scan('<a v="&lt;&#x41;&amp;"/>').events[0]).toEqual(['open', 'a', [['v', '<A&']]]);
  });

  it('gives attributes as a Map, so `__proto__` is just a key', () => {
    let seen: ReadonlyMap<string, string> | null = null;
    scanXml(
      '<a __proto__="x" constructor="y"/>',
      {
        open: (_local, attrs) => {
          seen = new Map(attrs);
        },
        close: () => {},
        text: () => {},
      },
      1000,
    );
    expect(seen).toEqual(
      new Map([
        ['__proto__', 'x'],
        ['constructor', 'y'],
      ]),
    );
    expect(Object.prototype).not.toHaveProperty('x');
  });

  it('treats CDATA content as raw text', () => {
    expect(texts('<t><![CDATA[a < b & c &amp;]]></t>')).toEqual(['a < b & c &amp;']);
  });

  it('skips comments and processing instructions', () => {
    expect(texts('<?xml version="1.0"?><!-- c <t>no</t> --><?pi x?><t>yes</t>')).toEqual(['yes']);
  });

  it('aborts on DOCTYPE and every other `<!` construct', () => {
    for (const xml of [
      '<!DOCTYPE x [<!ENTITY e "boom">]><t>&e;</t>',
      '<t>a</t><!ENTITY e "x">',
      '<!ELEMENT a ANY>',
      '<![INCLUDE[ <t>x</t> ]]>',
      '<!-x-->',
      '<!doctype x>',
    ]) {
      const { status, events } = scan(xml);
      expect(status).toBe('corrupt');
      expect(events.some((event) => event[0] === 'text' && event[1].includes('boom'))).toBe(false);
    }
  });

  it('aborts on unterminated constructs and never re-reads them as text', () => {
    for (const xml of [
      '<t>a</t><!-- open <t>hidden</t>',
      '<t>a</t><![CDATA[ hidden',
      '<t>a</t><?pi hidden',
      '<t>a</t><a b="hidden>',
      '<t>a</t><a',
      '<t>a</t> <',
    ]) {
      const { status, events } = scan(xml);
      expect(status).toBe('corrupt');
      expect(events.some((event) => event[0] === 'text' && event[1].includes('hidden'))).toBe(
        false,
      );
    }
  });

  it('aborts a tag longer than maxTagChars', () => {
    const tag = `<a ${'b="1" '.repeat(200)}/>`;
    expect(scan(tag, 1000).status).toBe('corrupt');
    expect(scan(tag, 2000).status).toBe('ok');
  });

  it('stops early or aborts when the handler says so', () => {
    const run = (signal: HaltSignal): { status: string; seen: string[] } => {
      const seen: string[] = [];
      const handler: XmlHandler = {
        open: () => {},
        close: () => {},
        text: (value) => seen.push(value),
        halt: () => (seen.length > 0 ? signal : null),
      };
      return { status: scanXml('<t>one</t><t>two</t>', handler, 1000), seen };
    };
    expect(run('stop')).toEqual({ status: 'stopped', seen: ['one'] });
    expect(run('corrupt')).toEqual({ status: 'corrupt', seen: ['one'] });
    expect(run(null)).toEqual({ status: 'ok', seen: ['one', 'two'] });
  });

  it('keeps malformed attributes from breaking the scan', () => {
    const { status, events } = scan('<a b c="1" =x d/><t>ok</t>');
    expect(status).toBe('ok');
    expect(events.at(-2)).toEqual(['text', 'ok']);
  });

  it('never decodes or passes on text while textRoom() is 0', () => {
    const seen: string[] = [];
    let collecting = false;
    const handler: XmlHandler = {
      open: (local) => {
        collecting = local === 't';
      },
      close: () => {
        collecting = false;
      },
      text: (value) => seen.push(value),
      textRoom: () => (collecting ? Number.POSITIVE_INFINITY : 0),
    };
    const xml = '<x>skip &amp; me<![CDATA[raw]]></x><t>keep &amp; me</t>';
    const status = scanXml(xml, handler, 1000);
    expect(status).toBe('ok');
    expect(seen).toEqual(['keep & me']);
  });

  it('decodes no further than textRoom() asks', () => {
    const seen: string[] = [];
    const handler: XmlHandler = {
      open: () => {},
      close: () => {},
      text: (value) => seen.push(value),
      textRoom: () => 4,
    };
    scanXml(`<t>${'&amp;'.repeat(1_000)}</t>`, handler, 1000);
    expect(seen).toEqual(['&&&&&']);
  });
});

describe('decodeEntities', () => {
  it.each([
    ['a &amp; b', 'a & b'],
    ['&lt;&gt;&quot;&apos;', `<>"'`],
    ['&#1571;', 'أ'],
    ['&#x645;', 'م'],
    ['&#0001571;', 'أ'],
    ['&#0;', ''],
    ['&#xD800;', ''],
    ['&#xDFFF;', ''],
    ['&#x110000;', ''],
    ['&foo;', '&foo;'],
    ['&nbsp;', '&nbsp;'],
    ['AT&T', 'AT&T'],
    ['&amp', '&amp'],
    ['&#;', '&#;'],
    ['&#x;', '&#x;'],
    ['&#X41;', '&#X41;'],
    ['&#1e3;', '&#1e3;'],
    ['&#12345678;', '&#12345678;'],
    ['&#x1234567;', '&#x1234567;'],
    [`&${'a'.repeat(20)};`, `&${'a'.repeat(20)};`],
    ['&&amp;&', '&&&'],
  ])('%s → %s', (input, expected) => {
    expect(decodeEntities(input)).toBe(expected);
  });

  it('joins across chunk boundaries without losing or reordering text', () => {
    expect(decodeEntities('عقد&amp;'.repeat(3_000))).toBe('عقد&'.repeat(3_000));
    expect(decodeEntities('&#x645;x'.repeat(2_500))).toBe('مx'.repeat(2_500));
  });

  it.each([
    ['a &amp; b', 100, 'a & b'],
    ['a &amp; b', 5, 'a & b'],
    ['a &amp; b', 4, 'a & b'],
    ['a &amp; b', 3, 'a & '],
    ['&amp;&amp;&amp;', 1, '&&'],
    ['&amp;&#x1F600;', 1, '&😀'],
    ['xyz&amp;', 0, 'x'],
    ['no entities at all', 2, 'no entities at all'],
  ])('decodeEntities(%j, max %d) → %j', (input, max, expected) => {
    expect(decodeEntities(input, max)).toBe(expected);
  });

  it('returns either the whole decoding or a prefix of it longer than max', () => {
    const input = 'ab&lt;cd&#x41;ef&gt;gh&amp;';
    const full = decodeEntities(input);
    for (let max = 0; max <= full.length + 1; max++) {
      const out = decodeEntities(input, max);
      expect(full.startsWith(out)).toBe(true);
      expect(out === full || out.length > max).toBe(true);
    }
  });

  it('decodes an astral code point to a surrogate pair', () => {
    const smile = decodeEntities('&#x1F600;');
    expect(smile).toBe('😀');
    expect(smile.length).toBe(2);
    expect(smile.charCodeAt(0)).toBe(0xd83d);
    expect(decodeEntities('&#128512;')).toBe('😀');
  });
});

describe('decodeXml', () => {
  it('decodes UTF-8 and strips its BOM', () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<t>أحمد</t>')]);
    expect(decodeXml(bytes)).toBe('<t>أحمد</t>');
  });

  it('decodes UTF-16 LE and BE by their BOM', () => {
    const xml = '<t>عقد</t>';
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]);
    const be = Buffer.from(xml, 'utf16le').swap16();
    expect(decodeXml(le)).toBe(xml);
    expect(decodeXml(Buffer.concat([Buffer.from([0xfe, 0xff]), be]))).toBe(xml);
  });

  it('keeps Arabic intact across byte offset 65,536 (one decode call)', () => {
    const lead = 'a'.repeat(65_535 - 3);
    const bytes = Buffer.from(`<t>${lead}أحمد</t>`);
    expect(bytes[65_535]).not.toBe(0x61);
    expect(texts(decodeXml(bytes))[0].endsWith('أحمد')).toBe(true);
  });

  it('substitutes U+FFFD for invalid bytes instead of throwing', () => {
    expect(decodeXml(Buffer.from([0x3c, 0x74, 0x3e, 0xc3, 0x28, 0x3c]))).toContain('�');
  });
});

describe('scanXml bounds (AC 18)', () => {
  const noop: XmlHandler = { open: () => {}, close: () => {}, text: () => {} };

  function bestOf3(xml: string): number {
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      scanXml(xml, noop, 64 * 1024);
      best = Math.min(best, performance.now() - start);
    }
    return best;
  }

  const adversarial: [string, (n: number) => string][] = [
    ['runs of &', (n) => `<t>${'&'.repeat(n)}</t>`],
    ['runs of &#1', (n) => `<t>${'&#1'.repeat(n / 3)}</t>`],
    ['runs of entities', (n) => `<t>${'&amp;'.repeat(n / 5)}</t>`],
    ['runs of <', (n) => '<'.repeat(n)],
    ['runs of <a', (n) => '<a'.repeat(n / 2)],
    ['unterminated comment', (n) => `<!--${'-'.repeat(n)}`],
    ['unterminated CDATA', (n) => `<![CDATA[${']'.repeat(n)}`],
    ['unterminated PI', (n) => `<?${'?'.repeat(n)}`],
    ['unterminated quote', (n) => `<a b="${'x'.repeat(n)}`],
    ['deep nesting', (n) => '<a>'.repeat(n / 3)],
    ['huge run of <c/>', (n) => '<c/>'.repeat(n / 4)],
    ['attribute-heavy tags', (n) => '<c r="A1" t="s" s="3"/>'.repeat(n / 24)],
    ['text between tags', (n) => '<t>x</t>'.repeat(n / 8)],
  ];

  it.each(adversarial)('%s scales linearly (10× input ≤ 15× time)', (_name, build) => {
    const small = build(200_000);
    const large = build(2_000_000);
    bestOf3(small);
    const t1 = bestOf3(small);
    const t10 = bestOf3(large);
    expect(t10).toBeLessThanOrEqual(15 * t1 + 25);
    expect(t10).toBeLessThan(2_000);
  });
});
