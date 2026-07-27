/** Runtime configuration, all overridable through environment variables. */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

const rootDir = resolve(process.cwd());

export const config = {
  port: envInt('PORT', 8787),
  host: env('HOST', '0.0.0.0'),
  /** Directory holding the SQLite file. */
  dataDir: resolve(env('WALLRUSH_DATA', resolve(rootDir, 'data'))),
  /** Static client build to serve. Empty disables static serving. */
  staticDir: env('WALLRUSH_STATIC', resolve(rootDir, 'packages/client/dist')),
  /** Comma-separated list of allowed origins, or `*`. */
  origins: env('WALLRUSH_ORIGINS', '*'),
  /** Session lifetime for issued tokens. */
  tokenTtlMs: envInt('WALLRUSH_TOKEN_TTL', 60 * 24 * 60 * 60 * 1000),
  /** How long a finished room lingers so players can rematch. */
  roomLingerMs: envInt('WALLRUSH_ROOM_LINGER', 3 * 60 * 1000),
  /** Grace period before a disconnected player forfeits. */
  reconnectGraceMs: envInt('WALLRUSH_RECONNECT_GRACE', 45 * 1000),
  /** Maximum concurrent rooms. */
  maxRooms: envInt('WALLRUSH_MAX_ROOMS', 4000),
  /** Messages per second allowed per connection before throttling. */
  rateLimit: envInt('WALLRUSH_RATE_LIMIT', 25),
  trustProxy: env('WALLRUSH_TRUST_PROXY', '1') === '1',
  /** Logs every inbound and outbound realtime message. Development only. */
  debug: env('WALLRUSH_DEBUG', '0') === '1',
} as const;

/**
 * The signing secret. Persisted next to the database so restarts do not log
 * everybody out, and generated on first boot so there is no insecure default.
 */
export function loadSecret(): Buffer {
  const explicit = process.env.WALLRUSH_SECRET;
  if (explicit && explicit.length >= 16) return Buffer.from(explicit, 'utf8');
  const file = resolve(config.dataDir, 'secret.key');
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file)) {
    const raw = readFileSync(file);
    if (raw.length >= 32) return raw;
  }
  const generated = randomBytes(48);
  writeFileSync(file, generated, { mode: 0o600 });
  return generated;
}
