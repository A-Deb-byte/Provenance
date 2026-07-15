import path from 'node:path';
import { isLoopbackDesktopBridgeUrl } from './ipc';

export interface DesktopAllowedApplication {
  id: string;
  executablePath: string;
}

export interface DesktopBridgeConfiguration {
  baseUrl: string;
  token: string;
  applications: DesktopAllowedApplication[];
}

export interface DesktopBridgeConfigurationResult {
  status: 'unavailable' | 'configured';
  reason: string;
  configuration?: DesktopBridgeConfiguration;
}

const APP_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const parseDesktopApplicationAllowlist = (value: string): DesktopAllowedApplication[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Desktop application allowlist must be valid JSON.');
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 32) {
    throw new Error('Desktop application allowlist must contain between 1 and 32 entries.');
  }
  const applications = parsed.map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error('Desktop application entries must be JSON objects.');
    }
    const record = entry as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== 'appId' && key !== 'executablePath') ||
      typeof record.appId !== 'string' || typeof record.executablePath !== 'string') {
      throw new Error('Desktop application entries require only appId and executablePath strings.');
    }
    const id = record.appId.trim();
    const executablePath = record.executablePath.trim();
    if (!APP_ID.test(id)) throw new Error(`Desktop application id is invalid: ${id || '(blank)'}.`);
    if (!path.win32.isAbsolute(executablePath) || path.win32.extname(executablePath).toLowerCase() !== '.exe') {
      throw new Error(`Desktop application ${id} must name an absolute .exe path.`);
    }
    const normalized = path.win32.normalize(executablePath);
    if (normalized !== executablePath || executablePath.includes('..')) {
      throw new Error(`Desktop application ${id} path must already be canonical.`);
    }
    return { id, executablePath };
  });
  if (new Set(applications.map((application) => application.id)).size !== applications.length) {
    throw new Error('Desktop application ids must be unique.');
  }
  if (new Set(applications.map((application) => application.executablePath.toLowerCase())).size !== applications.length) {
    throw new Error('Desktop application executable paths must be unique.');
  }
  return applications;
};

export const resolveDesktopBridgeConfiguration = (
  env: Readonly<Record<string, string | undefined>>,
): DesktopBridgeConfigurationResult => {
  const baseUrl = env.DESKTOP_BRIDGE_URL?.trim() ?? '';
  const token = env.DESKTOP_BRIDGE_TOKEN?.trim() ?? '';
  const allowlist = env.DESKTOP_APP_ALLOWLIST?.trim() ?? '';
  if (!baseUrl && !token && !allowlist) {
    return {
      status: 'unavailable',
      reason: 'No native desktop host launch credentials or application allowlist are configured.',
    };
  }
  if (!baseUrl || !token || !allowlist) {
    return {
      status: 'unavailable',
      reason: 'Desktop bridge configuration is incomplete; URL, token, and application allowlist are all required.',
    };
  }
  if (!isLoopbackDesktopBridgeUrl(baseUrl)) {
    return { status: 'unavailable', reason: 'Desktop bridge URL is not an explicit loopback HTTP origin.' };
  }
  if (token.length < 32) {
    return { status: 'unavailable', reason: 'Desktop bridge token is shorter than 32 characters.' };
  }
  try {
    const applications = parseDesktopApplicationAllowlist(allowlist);
    return {
      status: 'configured',
      reason: 'Native desktop bridge credentials and an executable allowlist are configured.',
      configuration: { baseUrl, token, applications },
    };
  } catch (error) {
    return {
      status: 'unavailable',
      reason: error instanceof Error ? error.message : 'Desktop application allowlist is invalid.',
    };
  }
};
