/**
 * WallRush — HTTP surface.
 *
 * A small hand-rolled router: a JSON API for accounts, profiles, leaderboards
 * and replays, plus static hosting for the built client with SPA fallback.
 * No framework, because there is nothing here a framework would do better.
 */

import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

import {
  BOT_LEVELS,
  BOT_RATING,
  Game,
  cloneConfig,
  parseTranscript,
  tierOf,
  type BotLevel,
} from '@wallrush/shared';

import {
  AVATAR_CHOICES,
  login,
  register,
  revokeToken,
  sanitiseName,
  toPublicUser,
  userFromToken,
  validatePassword,
  validateUsername,
} from './auth.js';
import { config } from './config.js';
import {
  applyMatchResult,
  counts,
  getUserById,
  leaderboard,
  matchById,
  matchHistory,
  recordMatch,
  touchUser,
  updateProfile,
  type UserRow,
} from './db.js';
import type { Hub } from './hub.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
};

const MAX_BODY = 64 * 1024;

export function corsHeaders(origin: string | undefined): Record<string, string> {
  const allowed = config.origins === '*' ? (origin ?? '*') : config.origins;
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  origin?: string,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...corsHeaders(origin),
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  // Reject early when the sender announces an oversized body, so we never even
  // start buffering it.
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY) {
    req.resume();
    throw new Error('payload-too-large');
  }
  return new Promise((resolvePromise, reject) => {
    let size = 0;
    let overflowed = false;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      if (overflowed) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        // Drain the rest instead of destroying the socket: the client deserves
        // a real 413 rather than a connection reset it cannot interpret.
        overflowed = true;
        chunks.length = 0;
        req.resume();
        reject(new Error('payload-too-large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (overflowed) return;
      if (chunks.length === 0) return resolvePromise({});
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('bad-json'));
      }
    });
    req.on('error', reject);
  });
}

function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) return header.slice(7).trim();
  return undefined;
}

function profilePayload(user: UserRow) {
  return {
    ...toPublicUser(user),
    username: user.username,
    tier: tierOf(user.rating),
    games: user.games,
    wins: user.wins,
    losses: user.losses,
    draws: user.draws,
    streak: user.streak,
    bestStreak: user.best_streak,
    lang: user.lang,
    createdAt: user.created_at,
  };
}

export function createHttpHandler(hub: Hub) {
  const staticRoot = config.staticDir ? resolve(config.staticDir) : '';

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = req.headers.origin;
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders(origin));
      res.end();
      return;
    }

    if (path.startsWith('/api/')) {
      try {
        await handleApi(req, res, url, hub, origin);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'server-error';
        sendJson(res, message === 'payload-too-large' ? 413 : 400, { error: message }, origin);
      }
      return;
    }

    if (!staticRoot || !existsSync(staticRoot)) {
      sendJson(res, 404, { error: 'not-found' }, origin);
      return;
    }
    serveStatic(res, staticRoot, path);
  };
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  hub: Hub,
  origin: string | undefined,
): Promise<void> {
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // ---------------------------------------------------------------- health
  if (path === '/api/health') {
    const c = counts();
    sendJson(
      res,
      200,
      { ok: true, uptime: Math.round(process.uptime()), ...hub.stats(), ...c },
      origin,
    );
    return;
  }

  if (path === '/api/meta') {
    sendJson(
      res,
      200,
      { avatars: AVATAR_CHOICES, botRatings: BOT_RATING, online: hub.onlineCount },
      origin,
    );
    return;
  }

  // ------------------------------------------------------------------ auth
  if (path === '/api/auth/register' && method === 'POST') {
    const body = (await readBody(req)) as {
      username?: string;
      password?: string;
      displayName?: string;
      lang?: string;
      guestToken?: string;
    };
    if (!body.username || !body.password) {
      sendJson(res, 400, { error: 'missing-fields' }, origin);
      return;
    }
    if (!validateUsername(body.username)) {
      sendJson(res, 400, { error: 'username-invalid' }, origin);
      return;
    }
    if (!validatePassword(body.password)) {
      sendJson(res, 400, { error: 'password-weak' }, origin);
      return;
    }
    const guest = body.guestToken ? userFromToken(body.guestToken) : null;
    const result = register({
      username: body.username,
      password: body.password,
      displayName: body.displayName,
      lang: body.lang,
      upgradeUserId: guest && guest.guest === 1 ? guest.id : undefined,
    });
    if (!result.ok) {
      sendJson(res, 409, { error: result.error }, origin);
      return;
    }
    sendJson(res, 200, { token: result.token, user: profilePayload(result.user) }, origin);
    return;
  }

  if (path === '/api/auth/login' && method === 'POST') {
    const body = (await readBody(req)) as { username?: string; password?: string };
    if (!body.username || !body.password) {
      sendJson(res, 400, { error: 'missing-fields' }, origin);
      return;
    }
    const result = login(body.username, body.password);
    if (!result.ok) {
      sendJson(res, 401, { error: result.error }, origin);
      return;
    }
    sendJson(res, 200, { token: result.token, user: profilePayload(result.user) }, origin);
    return;
  }

  if (path === '/api/auth/logout' && method === 'POST') {
    const token = bearer(req);
    if (token) revokeToken(token);
    sendJson(res, 200, { ok: true }, origin);
    return;
  }

  // --------------------------------------------------------------- profile
  if (path === '/api/me') {
    const user = userFromToken(bearer(req));
    if (!user) {
      sendJson(res, 401, { error: 'unauthorized' }, origin);
      return;
    }
    if (method === 'GET') {
      touchUser(user.id);
      sendJson(res, 200, { user: profilePayload(user) }, origin);
      return;
    }
    if (method === 'PATCH') {
      const body = (await readBody(req)) as {
        displayName?: string;
        avatar?: string;
        lang?: string;
      };
      const name = sanitiseName(body.displayName);
      updateProfile(user.id, {
        displayName: name ?? undefined,
        avatar:
          body.avatar && AVATAR_CHOICES.includes(body.avatar) ? body.avatar : undefined,
        lang: body.lang && ['hy', 'ru', 'en'].includes(body.lang) ? body.lang : undefined,
      });
      sendJson(res, 200, { user: profilePayload(getUserById(user.id)!) }, origin);
      return;
    }
  }

  if (path === '/api/me/history' && method === 'GET') {
    const user = userFromToken(bearer(req));
    if (!user) {
      sendJson(res, 401, { error: 'unauthorized' }, origin);
      return;
    }
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 25));
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    const rows = matchHistory(user.id, limit, offset).map((row) => ({
      id: row.id,
      mode: row.mode,
      ending: row.ending,
      finishedAt: row.finished_at,
      plies: row.plies,
      rated: row.rated === 1,
      size: row.size,
      seats: row.seats,
      seat: row.seat,
      result: row.result,
      ratingBefore: row.rating_before,
      ratingAfter: row.rating_after,
      botLevel: row.bot_level,
      players: safeJson(row.players_json, []),
    }));
    sendJson(res, 200, { matches: rows }, origin);
    return;
  }

  // ---------------------------------------------------- offline bot games
  if (path === '/api/matches/local' && method === 'POST') {
    const user = userFromToken(bearer(req));
    if (!user) {
      sendJson(res, 401, { error: 'unauthorized' }, origin);
      return;
    }
    const body = (await readBody(req)) as {
      transcript?: string;
      size?: number;
      players?: number;
      wallsPerPlayer?: number;
      seat?: number;
      botLevel?: string;
      startedAt?: number;
    };

    // The client reports the moves, not the result. Replaying the transcript
    // through the same engine the server uses is what makes this trustworthy:
    // a forged win would have to be an actual legal winning game.
    const config = cloneConfig({
      size: (body.size === 5 || body.size === 7 || body.size === 11 ? body.size : 9),
      players: body.players === 4 ? 4 : 2,
      wallsPerPlayer: body.wallsPerPlayer,
      clockMs: 0,
      incrementMs: 0,
      moveTimeoutMs: 0,
    });
    const seat = Number(body.seat) === 0 ? 0 : Number(body.seat);
    const level = BOT_LEVELS.includes(body.botLevel as BotLevel)
      ? (body.botLevel as BotLevel)
      : null;
    if (!body.transcript || !level || !Number.isInteger(seat) || seat < 0 || seat >= config.players) {
      sendJson(res, 400, { error: 'bad-request' }, origin);
      return;
    }

    const moves = parseTranscript(body.transcript, config.size);
    if (moves.length === 0 || moves.length > 400) {
      sendJson(res, 400, { error: 'bad-transcript' }, origin);
      return;
    }
    const game = new Game(config);
    for (const move of moves) {
      if (!game.apply(move).ok) {
        sendJson(res, 400, { error: 'illegal-transcript' }, origin);
        return;
      }
    }
    if (game.winner === null) {
      sendJson(res, 400, { error: 'unfinished' }, origin);
      return;
    }

    const result = game.winner === seat ? 'win' : 'loss';
    const id = randomUUID();
    const finishedAt = Date.now();
    const startedAt =
      Number.isFinite(body.startedAt) && Number(body.startedAt) < finishedAt
        ? Number(body.startedAt)
        : finishedAt;
    try {
      recordMatch(
        {
          id,
          mode: 'bot-local',
          size: config.size,
          seats: config.players,
          rated: 0,
          winner_seat: game.winner,
          ending: game.ending ?? 'goal',
          transcript: body.transcript,
          config_json: JSON.stringify(config),
          players_json: JSON.stringify(
            Array.from({ length: config.players }, (_, i) => ({
              seat: i,
              bot: i === seat ? null : level,
              userId: i === seat ? user.id : null,
              name: i === seat ? user.display_name : level,
            })),
          ),
          started_at: startedAt,
          finished_at: finishedAt,
          plies: game.ply,
        },
        [
          {
            userId: user.id,
            seat,
            result,
            ratingBefore: null,
            ratingAfter: null,
            botLevel: level,
          },
        ],
      );
      // Counts toward the personal record, never toward the rating.
      applyMatchResult(user.id, result, user.rating);
    } catch {
      sendJson(res, 500, { error: 'store-failed' }, origin);
      return;
    }
    sendJson(res, 200, { id, result }, origin);
    return;
  }

  // ---------------------------------------------------------- leaderboard
  if (path === '/api/leaderboard' && method === 'GET') {
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
    const rows = leaderboard(limit).map((u, i) => ({
      rank: i + 1,
      id: u.id,
      name: u.display_name,
      avatar: u.avatar,
      rating: u.rating,
      tier: tierOf(u.rating),
      games: u.games,
      wins: u.wins,
      losses: u.losses,
      streak: u.streak,
    }));
    sendJson(res, 200, { players: rows }, origin);
    return;
  }

  // -------------------------------------------------------------- replays
  const replayMatch = /^\/api\/match\/([\w-]{6,64})$/.exec(path);
  if (replayMatch && method === 'GET') {
    const row = matchById(replayMatch[1]);
    if (!row) {
      sendJson(res, 404, { error: 'not-found' }, origin);
      return;
    }
    sendJson(
      res,
      200,
      {
        match: {
          id: row.id,
          mode: row.mode,
          ending: row.ending,
          winnerSeat: row.winner_seat,
          transcript: row.transcript,
          config: safeJson(row.config_json, {}),
          players: safeJson(row.players_json, []),
          startedAt: row.started_at,
          finishedAt: row.finished_at,
          plies: row.plies,
          rated: row.rated === 1,
        },
      },
      origin,
    );
    return;
  }

  sendJson(res, 404, { error: 'not-found' }, origin);
}

function safeJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// ------------------------------------------------------------------- static

function serveStatic(res: ServerResponse, root: string, urlPath: string): void {
  const decoded = safeDecode(urlPath);
  const rel = normalize(decoded).replace(/^([/\\])+/, '');
  const target = join(root, rel);
  // Refuse anything that escapes the static root.
  if (!target.startsWith(root + sep) && target !== root) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  let file = target;
  if (!existsSync(file) || statSync(file).isDirectory()) {
    const indexed = join(file, 'index.html');
    file = existsSync(indexed) ? indexed : join(root, 'index.html');
  }
  if (!existsSync(file)) {
    res.writeHead(404).end('Not found');
    return;
  }

  const ext = extname(file).toLowerCase();
  const isHtml = ext === '.html';
  // Vite emits content-hashed asset names, so those can be cached hard.
  const immutable = /\.[0-9a-f]{8,}\./i.test(file) || rel.startsWith('assets/');
  const stats = statSync(file);
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Content-Length': stats.size,
    'Cache-Control': isHtml
      ? 'no-cache'
      : immutable
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
  });
  createReadStream(file).pipe(res);
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
