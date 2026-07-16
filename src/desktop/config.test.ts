import { describe, expect, it } from 'vitest';
import { parseDesktopApplicationAllowlist, resolveDesktopBridgeConfiguration } from './config';

describe('desktop bridge configuration', () => {
  it('parses a bounded canonical executable allowlist', () => {
    expect(parseDesktopApplicationAllowlist(
      JSON.stringify([
        { appId: 'notepad', executablePath: 'C:\\Windows\\System32\\notepad.exe' },
        { appId: 'calculator', executablePath: 'C:\\Windows\\System32\\calc.exe' },
      ]),
    )).toEqual([
      { id: 'notepad', executablePath: 'C:\\Windows\\System32\\notepad.exe' },
      { id: 'calculator', executablePath: 'C:\\Windows\\System32\\calc.exe' },
    ]);
  });

  it('rejects aliases, duplicates, traversal, relative paths, and non-executables', () => {
    const encoded = (entries: unknown) => JSON.stringify(entries);
    expect(() => parseDesktopApplicationAllowlist(encoded([
      { appId: 'Bad ID', executablePath: 'C:\\x.exe' },
    ]))).toThrow(/id/);
    expect(() => parseDesktopApplicationAllowlist(encoded([
      { appId: 'a', executablePath: 'C:\\x.exe' },
      { appId: 'a', executablePath: 'C:\\y.exe' },
    ]))).toThrow(/unique/);
    expect(() => parseDesktopApplicationAllowlist(encoded([
      { appId: 'a', executablePath: 'C:\\x.exe' },
      { appId: 'b', executablePath: 'C:\\x.exe' },
    ]))).toThrow(/unique/);
    expect(() => parseDesktopApplicationAllowlist(encoded([
      { appId: 'a', executablePath: '.\\x.exe' },
    ]))).toThrow(/absolute/);
    expect(() => parseDesktopApplicationAllowlist(encoded([
      { appId: 'a', executablePath: 'C:\\Windows\\..\\x.exe' },
    ]))).toThrow(/canonical/);
    expect(() => parseDesktopApplicationAllowlist(encoded([
      { appId: 'a', executablePath: 'C:\\x.txt' },
    ]))).toThrow(/\.exe/);
    expect(() => parseDesktopApplicationAllowlist('{bad-json')).toThrow(/valid JSON/);
  });

  it('fails closed for absent, partial, remote, or weak launch credentials', () => {
    expect(resolveDesktopBridgeConfiguration({}).status).toBe('unavailable');
    expect(resolveDesktopBridgeConfiguration({ DESKTOP_BRIDGE_URL: 'http://127.0.0.1:42/' }).reason)
      .toMatch(/incomplete/);
    expect(resolveDesktopBridgeConfiguration({
      DESKTOP_BRIDGE_URL: 'http://example.com:42/',
      DESKTOP_BRIDGE_TOKEN: 'x'.repeat(64),
      DESKTOP_APP_ALLOWLIST: JSON.stringify([{ appId: 'a', executablePath: 'C:\\x.exe' }]),
    }).reason).toMatch(/loopback/);
    expect(resolveDesktopBridgeConfiguration({
      DESKTOP_BRIDGE_URL: 'http://127.0.0.1:42/',
      DESKTOP_BRIDGE_TOKEN: 'short',
      DESKTOP_APP_ALLOWLIST: JSON.stringify([{ appId: 'a', executablePath: 'C:\\x.exe' }]),
    }).reason).toMatch(/32/);
  });

  it('returns sanitized configuration state without altering the token', () => {
    const result = resolveDesktopBridgeConfiguration({
      DESKTOP_BRIDGE_URL: 'http://127.0.0.1:43123/',
      DESKTOP_BRIDGE_TOKEN: 'x'.repeat(64),
      DESKTOP_APP_ALLOWLIST: JSON.stringify([{
        appId: 'notepad', executablePath: 'C:\\Windows\\System32\\notepad.exe',
      }]),
    });
    expect(result.status).toBe('configured');
    expect(result.configuration?.applications.map(({ id }) => id)).toEqual(['notepad']);
  });
});
