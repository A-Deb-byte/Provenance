import crypto from 'node:crypto';

export const FIRST_ADMIN_BOOTSTRAP_HEADER = 'x-provenance-first-admin-bootstrap';

const FIRST_ADMIN_BOOTSTRAP_SECRET = /^[A-Za-z0-9_-]{43}$/u;

export interface FirstAdminBootstrapAuthority {
  isPending(): boolean;
  authorize(supplied: string | undefined): boolean;
  completeAfterPersistence(): void;
}

const timingSafeEqual = (left: string, right: string): boolean => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

/** Process-local, one-use authority for a native desktop launch. */
export const createFirstAdminBootstrapAuthority = (
  configuredSecret: string | undefined,
  options: { required?: boolean } = {},
): FirstAdminBootstrapAuthority | undefined => {
  if (configuredSecret === undefined) {
    if (options.required) {
      throw new Error('Native desktop launches require a per-launch first-admin bootstrap authority.');
    }
    return undefined;
  }
  if (!FIRST_ADMIN_BOOTSTRAP_SECRET.test(configuredSecret)) {
    throw new Error('Configured first-admin bootstrap secret is invalid.');
  }
  let activeSecret: string | undefined = configuredSecret;

  return {
    isPending: () => Boolean(activeSecret),
    authorize: (supplied) => Boolean(
      activeSecret && supplied && timingSafeEqual(supplied, activeSecret),
    ),
    completeAfterPersistence: () => {
      activeSecret = undefined;
    },
  };
};
