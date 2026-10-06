import { csvCell, csvRow } from './csv.js';

describe('csv', () => {
  it('quotes separators, quotes and newlines', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
  });

  it('renders empty, numbers, booleans and objects', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(12.5)).toBe('12.5');
    expect(csvCell(false)).toBe('false');
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
  });

  it('neutralises spreadsheet formulas', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-2')).toBe("'-2");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell(-2)).toBe('-2');
  });

  it('joins a row', () => {
    expect(csvRow(['a', 1, null, 'b,c'])).toBe('a,1,,"b,c"');
  });
});
