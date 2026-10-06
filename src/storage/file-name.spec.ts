import { safeFileName } from './file-name.js';

describe('safeFileName', () => {
  it('drops directories and control characters and caps the length', () => {
    expect(safeFileName('../../evil.txt')).toBe('evil.txt');
    expect(safeFileName('C:\\Users\\me\\report.pdf')).toBe('report.pdf');
    expect(safeFileName('we\u0000ird\nname.png')).toBe('weirdname.png');
    expect(safeFileName('')).toBe('file');
    expect(safeFileName(`${'a'.repeat(300)}.pdf`)).toHaveLength(200);
  });
});
