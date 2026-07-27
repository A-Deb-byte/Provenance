import { afterEach, describe, expect, it, vi } from 'vitest';
import { reportNativeAcceptanceMount } from './nativeAcceptanceMount';

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
});

describe('native acceptance mount reporter', () => {
  it('removes the one-launch fragment before reporting a mounted dashboard', async () => {
    const token = 'a'.repeat(64);
    const endpoint = 'http://127.0.0.1:43124/__provenance/native/mounted';
    window.history.replaceState({}, '', `/#provenance-first-admin=kept&provenance-native-acceptance-mount=${token}&provenance-native-acceptance-endpoint=${endpoint}`);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    await expect(reportNativeAcceptanceMount()).resolves.toBe(true);
    expect(window.location.hash).toBe('#provenance-first-admin=kept');
    expect(fetchMock).toHaveBeenCalledWith(endpoint, expect.objectContaining({
      method: 'POST',
      credentials: 'omit',
      headers: { 'content-type': 'text/plain;charset=UTF-8' },
      body: token,
    }));
  });

  it('removes but never sends an invalid mount token', async () => {
    window.history.replaceState({}, '', '/#provenance-native-acceptance-mount=invalid');
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await expect(reportNativeAcceptanceMount()).resolves.toBe(false);
    expect(window.location.hash).toBe('');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never sends a valid bearer to an invalid or non-loopback endpoint', async () => {
    window.history.replaceState(
      {},
      '',
      `/#provenance-native-acceptance-mount=${'a'.repeat(64)}&provenance-native-acceptance-endpoint=https://example.com/mounted`,
    );
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await expect(reportNativeAcceptanceMount()).resolves.toBe(false);
    expect(window.location.hash).toBe('');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
