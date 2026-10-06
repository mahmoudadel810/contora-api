import { cleanUserAgent, MAX_USER_AGENT_LENGTH } from './user-agent.js';

describe('cleanUserAgent', () => {
  it('keeps an ordinary user agent as it is', () => {
    const ua = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36';
    expect(cleanUserAgent(ua)).toBe(ua);
  });

  it('strips control characters and collapses whitespace', () => {
    expect(cleanUserAgent('Evil\u0000Agent\r\n\u001b[31mred\u007f  end\t')).toBe(
      'Evil Agent [31mred end',
    );
  });

  it('drops format characters: bidi overrides, isolates, zero-width marks and the BOM', () => {
    expect(cleanUserAgent('Safe‮gnp.exe‬ Agent')).toBe('Safegnp.exe Agent');
    expect(cleanUserAgent('⁦Iso⁩ ​Zero‍width﻿')).toBe('Iso Zerowidth');
    expect(cleanUserAgent('‮​﻿')).toBeNull();
  });

  it('caps the length at 200 characters, counted after cleaning', () => {
    expect(cleanUserAgent(`${'​'.repeat(300)}${'y'.repeat(250)}`)).toBe('y'.repeat(200));
  });

  it('caps the length at 200 characters', () => {
    const cleaned = cleanUserAgent('x'.repeat(500));
    expect(cleaned).toHaveLength(MAX_USER_AGENT_LENGTH);
  });

  it('answers null for a missing, empty or non-string value', () => {
    expect(cleanUserAgent(undefined)).toBeNull();
    expect(cleanUserAgent('')).toBeNull();
    expect(cleanUserAgent('\u0000\u0001  ')).toBeNull();
    expect(cleanUserAgent(42)).toBeNull();
    expect(cleanUserAgent(['First/1.0', 'Second/2.0'])).toBe('First/1.0');
  });
});
