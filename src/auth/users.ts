import crypto from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type UserRole = 'admin' | 'operator' | 'viewer';

export interface UserRecord {
  id: string;
  username: string;
  role: UserRole;
  salt: string;
  passwordHash: string;
  sessionVersion: number;
  createdAt: string;
}

export interface PublicUser {
  id: string;
  username: string;
  role: UserRole;
  createdAt: string;
}

export interface CreateUserInput {
  username: string;
  password: string;
  role: UserRole;
}

const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,32}$/;
const MIN_PASSWORD_CHARS = 8;
const roles = new Set<UserRole>(['admin', 'operator', 'viewer']);

const hashPassword = (password: string, salt: string): string => (
  crypto.scryptSync(password, salt, 64).toString('hex')
);

const toPublic = (user: UserRecord): PublicUser => ({
  id: user.id,
  username: user.username,
  role: user.role,
  createdAt: user.createdAt,
});

export interface UserStore {
  count(): number;
  list(): PublicUser[];
  create(input: CreateUserInput): Promise<PublicUser>;
  verify(username: string, password: string): PublicUser | undefined;
  findById(id: string): PublicUser | undefined;
  sessionVersion(id: string): number | undefined;
  revokeSessions(id: string): Promise<boolean>;
  remove(id: string): Promise<boolean>;
}

/**
 * File-backed user store with scrypt-hashed passwords. Passwords are never
 * stored or returned in plaintext; only salt + derived hash are persisted.
 */
export const createUserStore = async (filePath: string): Promise<UserStore> => {
  const resolved = path.resolve(filePath);
  let users: UserRecord[] = [];

  try {
    const raw = await readFile(resolved, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      users = parsed.filter((u): u is UserRecord => (
        u && typeof u.id === 'string' && typeof u.username === 'string' &&
        roles.has(u.role) && typeof u.salt === 'string' && typeof u.passwordHash === 'string'
      )).map((user) => ({
        ...user,
        sessionVersion: Number.isSafeInteger(user.sessionVersion) && user.sessionVersion >= 0
          ? user.sessionVersion : 0,
      }));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const persist = async (): Promise<void> => {
    await mkdir(path.dirname(resolved), { recursive: true });
    const temp = `${resolved}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(users, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temp, resolved);
  };

  return {
    count: () => users.length,
    list: () => users.map(toPublic),
    create: async (input) => {
      if (!USERNAME_PATTERN.test(input.username)) {
        throw new Error('Username must be 3-32 characters of letters, digits, dot, dash, or underscore.');
      }
      if (typeof input.password !== 'string' || input.password.length < MIN_PASSWORD_CHARS) {
        throw new Error(`Password must be at least ${MIN_PASSWORD_CHARS} characters.`);
      }
      if (!roles.has(input.role)) throw new Error('Role must be admin, operator, or viewer.');
      if (users.some((u) => u.username.toLowerCase() === input.username.toLowerCase())) {
        throw new Error('A user with that username already exists.');
      }
      const salt = crypto.randomBytes(16).toString('hex');
      const record: UserRecord = {
        id: `user_${crypto.randomUUID()}`,
        username: input.username,
        role: input.role,
        salt,
        passwordHash: hashPassword(input.password, salt),
        sessionVersion: 0,
        createdAt: new Date().toISOString(),
      };
      users = [...users, record];
      await persist();
      return toPublic(record);
    },
    verify: (username, password) => {
      const user = users.find((u) => u.username.toLowerCase() === username.toLowerCase());
      if (!user) return undefined;
      const candidate = hashPassword(password, user.salt);
      const expected = Buffer.from(user.passwordHash, 'hex');
      const actual = Buffer.from(candidate, 'hex');
      if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return undefined;
      return toPublic(user);
    },
    findById: (id) => {
      const user = users.find((candidate) => candidate.id === id);
      return user ? toPublic(user) : undefined;
    },
    sessionVersion: (id) => users.find((candidate) => candidate.id === id)?.sessionVersion,
    revokeSessions: async (id) => {
      const user = users.find((candidate) => candidate.id === id);
      if (!user) return false;
      users = users.map((candidate) => candidate.id === id
        ? { ...candidate, sessionVersion: candidate.sessionVersion + 1 }
        : candidate);
      await persist();
      return true;
    },
    remove: async (id) => {
      const target = users.find((user) => user.id === id);
      if (target?.role === 'admin' && users.filter((user) => user.role === 'admin').length === 1) {
        throw new Error('The final administrator account cannot be removed.');
      }
      const next = users.filter((u) => u.id !== id);
      if (next.length === users.length) return false;
      users = next;
      await persist();
      return true;
    },
  };
};
