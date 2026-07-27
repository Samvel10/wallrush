/**
 * WallRush — accounts and tokens.
 *
 * Passwords use scrypt from node:crypto (memory-hard, no native dependency) and
 * tokens are compact HMAC-signed blobs verified in constant time. Accounts are
 * entirely optional: everyone gets a guest identity on first connect, and
 * registering later upgrades that same identity so nothing is lost.
 */

import {
  createHmac,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

import type { PublicUser } from '@wallrush/shared';

import { config, loadSecret } from './config.js';
import {
  database,
  dropSession,
  getUserById,
  getUserByUsername,
  insertUser,
  saveSession,
  sessionUser,
  touchUser,
  type UserRow,
} from './db.js';

const SECRET = loadSecret();

const SCRYPT_N = 16384;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const KEY_LEN = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password.normalize('NFKC'), salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_r,
    p: SCRYPT_p,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_r}$${SCRYPT_p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export function verifyPassword(password: string, stored: string | null): boolean {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, keyB64] = parts;
  try {
    const salt = Buffer.from(saltB64, 'base64url');
    const expected = Buffer.from(keyB64, 'base64url');
    const actual = scryptSync(password.normalize('NFKC'), salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// --------------------------------------------------------------------- tokens

interface TokenPayload {
  sub: string;
  exp: number;
  /** Random nonce so two tokens for the same user differ. */
  jti: string;
}

export function issueToken(userId: string, ttlMs = config.tokenTtlMs): string {
  const payload: TokenPayload = {
    sub: userId,
    exp: Date.now() + ttlMs,
    jti: randomBytes(9).toString('base64url'),
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = createHmac('sha256', SECRET).update(body).digest('base64url');
  const token = `${body}.${sig}`;
  saveSession(token, userId, ttlMs);
  return token;
}

export function verifyToken(token: string): string | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload;
    if (!payload.sub || payload.exp < Date.now()) return null;
    return payload.sub;
  } catch {
    return null;
  }
}

export function revokeToken(token: string): void {
  dropSession(token);
}

// ------------------------------------------------------------------- accounts

const GUEST_ADJECTIVES = [
  'Swift',
  'Clever',
  'Quiet',
  'Bold',
  'Bright',
  'Nimble',
  'Steady',
  'Keen',
  'Lucky',
  'Brave',
];
const GUEST_NOUNS = [
  'Falcon',
  'Otter',
  'Fox',
  'Heron',
  'Lynx',
  'Marten',
  'Raven',
  'Ibex',
  'Badger',
  'Crane',
];
const AVATARS = [
  '🦊',
  '🦉',
  '🐺',
  '🦅',
  '🐢',
  '🦌',
  '🐝',
  '🦔',
  '🐬',
  '🦩',
  '🐿️',
  '🦇',
  '🐙',
  '🦎',
];

export function randomAvatar(): string {
  return AVATARS[Math.floor(Math.random() * AVATARS.length)];
}

export const AVATAR_CHOICES = AVATARS;

function guestName(): string {
  const a = GUEST_ADJECTIVES[Math.floor(Math.random() * GUEST_ADJECTIVES.length)];
  const n = GUEST_NOUNS[Math.floor(Math.random() * GUEST_NOUNS.length)];
  return `${a}${n}${Math.floor(Math.random() * 90 + 10)}`;
}

export function createGuest(lang = 'hy', name?: string): UserRow {
  return insertUser({
    id: randomUUID(),
    username: null,
    displayName: sanitiseName(name) ?? guestName(),
    passwordHash: null,
    avatar: randomAvatar(),
    lang,
    guest: true,
  });
}

export type RegisterError =
  | 'username-taken'
  | 'username-invalid'
  | 'password-weak'
  | 'name-invalid';

const USERNAME_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{2,19}$/;

export function validateUsername(username: string): boolean {
  return USERNAME_RE.test(username);
}

export function validatePassword(password: string): boolean {
  return typeof password === 'string' && password.length >= 6 && password.length <= 200;
}

/** Trim, collapse whitespace and cap length. Returns null when nothing is left. */
export function sanitiseName(name: string | undefined | null): string | null {
  if (!name) return null;
  const clean = name.replace(/\s+/g, ' ').trim().slice(0, 24);
  return clean.length >= 1 ? clean : null;
}

export function register(input: {
  username: string;
  password: string;
  displayName?: string;
  lang?: string;
  /** Existing guest account to upgrade in place, preserving history. */
  upgradeUserId?: string;
}): { ok: true; user: UserRow; token: string } | { ok: false; error: RegisterError } {
  const username = input.username.trim();
  if (!validateUsername(username)) return { ok: false, error: 'username-invalid' };
  if (!validatePassword(input.password)) return { ok: false, error: 'password-weak' };
  if (getUserByUsername(username)) return { ok: false, error: 'username-taken' };

  const displayName = sanitiseName(input.displayName) ?? username;
  const passwordHash = hashPassword(input.password);

  const existing = input.upgradeUserId ? getUserById(input.upgradeUserId) : null;
  if (existing && existing.guest === 1) {
    database()
      .prepare(
        `UPDATE users SET username = ?, password_hash = ?, display_name = ?,
                          guest = 0, lang = COALESCE(?, lang)
          WHERE id = ?`,
      )
      .run(username, passwordHash, displayName, input.lang ?? null, existing.id);
    const user = getUserById(existing.id)!;
    return { ok: true, user, token: issueToken(user.id) };
  }

  const user = insertUser({
    id: randomUUID(),
    username,
    displayName,
    passwordHash,
    avatar: randomAvatar(),
    lang: input.lang ?? 'hy',
    guest: false,
  });
  return { ok: true, user, token: issueToken(user.id) };
}

export function login(
  username: string,
  password: string,
): { ok: true; user: UserRow; token: string } | { ok: false; error: 'bad-credentials' } {
  const user = getUserByUsername(username.trim());
  if (!user || !verifyPassword(password, user.password_hash)) {
    // Burn comparable time so timing does not reveal whether the name exists.
    if (!user) verifyPassword(password, hashPassword('placeholder-value'));
    return { ok: false, error: 'bad-credentials' };
  }
  touchUser(user.id);
  return { ok: true, user, token: issueToken(user.id) };
}

export function userFromToken(token: string | undefined): UserRow | null {
  if (!token) return null;
  const viaSession = sessionUser(token);
  if (viaSession) return viaSession;
  const id = verifyToken(token);
  return id ? getUserById(id) : null;
}

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    name: row.display_name,
    rating: row.rating,
    avatar: row.avatar,
    guest: row.guest === 1,
  };
}
