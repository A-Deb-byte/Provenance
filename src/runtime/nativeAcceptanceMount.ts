const MOUNT_FRAGMENT = 'provenance-native-acceptance-mount';
const ENDPOINT_FRAGMENT = 'provenance-native-acceptance-endpoint';
const MOUNT_TOKEN = /^[a-f0-9]{64}$/u;
const MOUNT_ENDPOINT = /^http:\/\/127\.0\.0\.1:(?:[1-9]\d{0,4})\/__provenance\/native\/mounted$/u;

export const reportNativeAcceptanceMount = async (): Promise<boolean> => {
  if (typeof window === 'undefined' || !window.location.hash) return false;
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  if (!fragment.has(MOUNT_FRAGMENT) && !fragment.has(ENDPOINT_FRAGMENT)) return false;
  const token = fragment.get(MOUNT_FRAGMENT);
  const endpoint = fragment.get(ENDPOINT_FRAGMENT);
  fragment.delete(MOUNT_FRAGMENT);
  fragment.delete(ENDPOINT_FRAGMENT);
  const remaining = fragment.toString();
  try {
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${window.location.search}${remaining ? `#${remaining}` : ''}`,
    );
  } catch {
    return false;
  }
  if (!token || !MOUNT_TOKEN.test(token) || !endpoint || !MOUNT_ENDPOINT.test(endpoint)) {
    return false;
  }
  const port = Number(new URL(endpoint).port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return false;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      headers: { 'content-type': 'text/plain;charset=UTF-8' },
      body: token,
    });
    return response.status === 204;
  } catch {
    return false;
  }
};
