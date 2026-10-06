import { uaFamilyOf } from './ua-family.js';

const AGENTS = {
  chrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  chromeIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0.6668.69 Mobile/15E148 Safari/604.1',
  firefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
  firefoxIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/131.0 Mobile/15E148 Safari/605.1.15',
  safari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.2792.65',
  opera:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 OPR/114.0.0.0',
  curl: 'curl/8.9.1',
};

describe('uaFamilyOf', () => {
  it('maps the common browsers to their family', () => {
    expect(uaFamilyOf(AGENTS.chrome)).toBe('chrome');
    expect(uaFamilyOf(AGENTS.chromeIos)).toBe('chrome');
    expect(uaFamilyOf(AGENTS.firefox)).toBe('firefox');
    expect(uaFamilyOf(AGENTS.firefoxIos)).toBe('firefox');
    expect(uaFamilyOf(AGENTS.safari)).toBe('safari');
    expect(uaFamilyOf(AGENTS.edge)).toBe('edge');
  });

  it('answers other for anything else, including a missing or odd header', () => {
    expect(uaFamilyOf(AGENTS.opera)).toBe('other');
    expect(uaFamilyOf(AGENTS.curl)).toBe('other');
    expect(uaFamilyOf('')).toBe('other');
    expect(uaFamilyOf(undefined)).toBe('other');
    expect(uaFamilyOf(42)).toBe('other');
    expect(uaFamilyOf([AGENTS.firefox])).toBe('firefox');
  });
});
