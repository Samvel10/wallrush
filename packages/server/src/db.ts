/**
 * WallRush — persistence.
 *
 * Backed by `node:sqlite`, which ships with Node itself, so deployment needs no
 * native build step and no database server. Everything the product needs —
 * accounts, ratings, match history, replays — lives in one file.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { START_RATING } from '@wallrush/shared';

import { config } from './config.js';

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string | null;
  avatar: string;
  rating: number;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  streak: number;
  best_streak: number;
  lang: string;
  created_at: number;
  last_seen: number;
  guest: number;
}

export interface MatchRow {
  id: string;
  mode: string;
  size: number;
  seats: number;
  rated: number;
  winner_seat: number | null;
  ending: string;
  transcript: string;
  config_json: string;
  players_json: string;
  started_at: number;
  finished_at: number;
  plies: number;
}

let db: DatabaseSync;

export function openDatabase(file?: string): DatabaseSync {
  if (db) return db;
  const path = file ?? resolve(config.dataDir, 'wallrush.sqlite');
  if (path !== ':memory:') mkdirSync(config.dataDir, { recursive: true });
  db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

export function database(): DatabaseSync {
  if (!db) openDatabase();
  return db;
}

function migrate(d: DatabaseSync): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      username      TEXT UNIQUE,
      display_name  TEXT NOT NULL,
      password_hash TEXT,
      avatar        TEXT NOT NULL DEFAULT '🐦',
      rating        INTEGER NOT NULL DEFAULT ${START_RATING},
      games         INTEGER NOT NULL DEFAULT 0,
      wins          INTEGER NOT NULL DEFAULT 0,
      losses        INTEGER NOT NULL DEFAULT 0,
      draws         INTEGER NOT NULL DEFAULT 0,
      streak        INTEGER NOT NULL DEFAULT 0,
      best_streak   INTEGER NOT NULL DEFAULT 0,
      lang          TEXT NOT NULL DEFAULT 'hy',
      created_at    INTEGER NOT NULL,
      last_seen     INTEGER NOT NULL,
      guest         INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_users_rating ON users(rating DESC) WHERE guest = 0;
    CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

    CREATE TABLE IF NOT EXISTS matches (
      id           TEXT PRIMARY KEY,
      mode         TEXT NOT NULL,
      size         INTEGER NOT NULL,
      seats        INTEGER NOT NULL,
      rated        INTEGER NOT NULL DEFAULT 0,
      winner_seat  INTEGER,
      ending       TEXT NOT NULL,
      transcript   TEXT NOT NULL,
      config_json  TEXT NOT NULL,
      players_json TEXT NOT NULL,
      started_at   INTEGER NOT NULL,
      finished_at  INTEGER NOT NULL,
      plies        INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS match_players (
      match_id     TEXT NOT NULL,
      user_id      TEXT NOT NULL,
      seat         INTEGER NOT NULL,
      result       TEXT NOT NULL,
      rating_before INTEGER,
      rating_after  INTEGER,
      bot_level    TEXT,
      PRIMARY KEY (match_id, seat),
      FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_match_players_user
      ON match_players(user_id, match_id);

    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    -- Friendship is stored as one row per direction, both written when a
    -- request is accepted. That keeps "are we friends" a single indexed lookup
    -- in either direction, which is what every read here actually asks.
    CREATE TABLE IF NOT EXISTS friends (
      user_id    TEXT NOT NULL,
      friend_id  TEXT NOT NULL,
      status     TEXT NOT NULL,          -- 'pending' (outgoing) | 'accepted'
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, friend_id),
      FOREIGN KEY (user_id)   REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (friend_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_friends_friend ON friends(friend_id, status);

    CREATE TABLE IF NOT EXISTS stats_daily (
      day        TEXT PRIMARY KEY,
      games      INTEGER NOT NULL DEFAULT 0,
      players    INTEGER NOT NULL DEFAULT 0
    );
  `);
}

// ------------------------------------------------------------------ helpers

export function nowMs(): number {
  return Date.now();
}

export function getUserById(id: string): UserRow | null {
  const row = database().prepare('SELECT * FROM users WHERE id = ?').get(id);
  return (row as UserRow | undefined) ?? null;
}

export function getUserByUsername(username: string): UserRow | null {
  const row = database()
    .prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE')
    .get(username);
  return (row as UserRow | undefined) ?? null;
}

export function insertUser(row: {
  id: string;
  username: string | null;
  displayName: string;
  passwordHash: string | null;
  avatar: string;
  lang: string;
  guest: boolean;
}): UserRow {
  const now = nowMs();
  database()
    .prepare(
      `INSERT INTO users
        (id, username, display_name, password_hash, avatar, lang, created_at, last_seen, guest)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.username,
      row.displayName,
      row.passwordHash,
      row.avatar,
      row.lang,
      now,
      now,
      row.guest ? 1 : 0,
    );
  return getUserById(row.id)!;
}

export function touchUser(id: string): void {
  database().prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(nowMs(), id);
}

export function updateProfile(
  id: string,
  patch: { displayName?: string; avatar?: string; lang?: string },
): void {
  const sets: string[] = [];
  const values: (string | number)[] = [];
  if (patch.displayName !== undefined) {
    sets.push('display_name = ?');
    values.push(patch.displayName);
  }
  if (patch.avatar !== undefined) {
    sets.push('avatar = ?');
    values.push(patch.avatar);
  }
  if (patch.lang !== undefined) {
    sets.push('lang = ?');
    values.push(patch.lang);
  }
  if (sets.length === 0) return;
  values.push(id);
  database()
    .prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`)
    .run(...values);
}

export function applyMatchResult(
  userId: string,
  result: 'win' | 'loss' | 'draw',
  newRating: number,
): void {
  const user = getUserById(userId);
  if (!user) return;
  const streak = result === 'win' ? user.streak + 1 : 0;
  database()
    .prepare(
      `UPDATE users SET
         rating = ?,
         games = games + 1,
         wins = wins + ?,
         losses = losses + ?,
         draws = draws + ?,
         streak = ?,
         best_streak = MAX(best_streak, ?)
       WHERE id = ?`,
    )
    .run(
      newRating,
      result === 'win' ? 1 : 0,
      result === 'loss' ? 1 : 0,
      result === 'draw' ? 1 : 0,
      streak,
      streak,
      userId,
    );
}

export function leaderboard(limit = 100): UserRow[] {
  return database()
    .prepare(
      `SELECT * FROM users
        WHERE guest = 0 AND games >= 3
        ORDER BY rating DESC, wins DESC
        LIMIT ?`,
    )
    .all(limit) as unknown as UserRow[];
}

export function recordMatch(
  match: Omit<MatchRow, 'id'> & { id: string },
  players: {
    userId: string;
    seat: number;
    result: 'win' | 'loss' | 'draw';
    ratingBefore: number | null;
    ratingAfter: number | null;
    botLevel: string | null;
  }[],
): void {
  const d = database();
  d.prepare(
    `INSERT INTO matches
      (id, mode, size, seats, rated, winner_seat, ending, transcript,
       config_json, players_json, started_at, finished_at, plies)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    match.id,
    match.mode,
    match.size,
    match.seats,
    match.rated,
    match.winner_seat,
    match.ending,
    match.transcript,
    match.config_json,
    match.players_json,
    match.started_at,
    match.finished_at,
    match.plies,
  );
  const stmt = d.prepare(
    `INSERT OR REPLACE INTO match_players
      (match_id, user_id, seat, result, rating_before, rating_after, bot_level)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const p of players) {
    stmt.run(
      match.id,
      p.userId,
      p.seat,
      p.result,
      p.ratingBefore,
      p.ratingAfter,
      p.botLevel,
    );
  }
}

export interface HistoryEntryRow {
  id: string;
  mode: string;
  ending: string;
  finished_at: number;
  plies: number;
  rated: number;
  size: number;
  seats: number;
  seat: number;
  result: string;
  rating_before: number | null;
  rating_after: number | null;
  bot_level: string | null;
  players_json: string;
  transcript: string;
  config_json: string;
}

export function matchHistory(userId: string, limit = 30, offset = 0): HistoryEntryRow[] {
  return database()
    .prepare(
      `SELECT m.id, m.mode, m.ending, m.finished_at, m.plies, m.rated, m.size, m.seats,
              m.players_json, m.transcript, m.config_json,
              p.seat, p.result, p.rating_before, p.rating_after, p.bot_level
         FROM match_players p
         JOIN matches m ON m.id = p.match_id
        WHERE p.user_id = ?
        ORDER BY m.finished_at DESC
        LIMIT ? OFFSET ?`,
    )
    .all(userId, limit, offset) as unknown as HistoryEntryRow[];
}

export function matchById(id: string): MatchRow | null {
  const row = database().prepare('SELECT * FROM matches WHERE id = ?').get(id);
  return (row as MatchRow | undefined) ?? null;
}

// ------------------------------------------------------------------ sessions

export function saveSession(token: string, userId: string, ttlMs: number): void {
  const now = nowMs();
  database()
    .prepare(
      'INSERT OR REPLACE INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    )
    .run(token, userId, now, now + ttlMs);
}

export function sessionUser(token: string): UserRow | null {
  const row = database()
    .prepare('SELECT user_id, expires_at FROM sessions WHERE token = ?')
    .get(token) as { user_id: string; expires_at: number } | undefined;
  if (!row) return null;
  if (row.expires_at < nowMs()) {
    database().prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return getUserById(row.user_id);
}

export function dropSession(token: string): void {
  database().prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

/** Housekeeping: expired sessions and stale guest accounts with no games. */
export function sweep(): void {
  const d = database();
  const now = nowMs();
  d.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  d.prepare(
    `DELETE FROM users
      WHERE guest = 1 AND games = 0 AND last_seen < ?
        AND id NOT IN (SELECT user_id FROM match_players)`,
  ).run(now - 7 * 24 * 60 * 60 * 1000);
}

// ------------------------------------------------------------------- friends

export type FriendStatus = 'pending' | 'accepted';

export interface FriendRow {
  id: string;
  display_name: string;
  avatar: string;
  rating: number;
  last_seen: number;
  status: FriendStatus;
  /** True when they asked us, rather than the other way round. */
  incoming: number;
}

/** Have these two actually played each other? Friend requests require it. */
export function havePlayedTogether(a: string, b: string): boolean {
  const row = database()
    .prepare(
      `SELECT 1 AS ok
         FROM match_players p1
         JOIN match_players p2 ON p1.match_id = p2.match_id AND p2.user_id = ?
        WHERE p1.user_id = ?
        LIMIT 1`,
    )
    .get(b, a) as { ok: number } | undefined;
  return row !== undefined;
}

export function friendState(userId: string, otherId: string): FriendStatus | null {
  const row = database()
    .prepare('SELECT status FROM friends WHERE user_id = ? AND friend_id = ?')
    .get(userId, otherId) as { status: FriendStatus } | undefined;
  return row?.status ?? null;
}

/**
 * Sends a request, or accepts one that is already waiting. Returns what the
 * relationship became, so the caller does not have to ask again.
 */
export function requestFriend(userId: string, otherId: string): FriendStatus {
  const now = nowMs();
  const d = database();
  const theirs = friendState(otherId, userId);
  if (theirs === 'pending' || theirs === 'accepted') {
    // They already asked us (or we are re-accepting): make it mutual.
    d.prepare(
      `INSERT INTO friends (user_id, friend_id, status, created_at) VALUES (?, ?, 'accepted', ?)
       ON CONFLICT(user_id, friend_id) DO UPDATE SET status = 'accepted'`,
    ).run(userId, otherId, now);
    d.prepare(
      `INSERT INTO friends (user_id, friend_id, status, created_at) VALUES (?, ?, 'accepted', ?)
       ON CONFLICT(user_id, friend_id) DO UPDATE SET status = 'accepted'`,
    ).run(otherId, userId, now);
    return 'accepted';
  }
  d.prepare(
    `INSERT INTO friends (user_id, friend_id, status, created_at) VALUES (?, ?, 'pending', ?)
     ON CONFLICT(user_id, friend_id) DO NOTHING`,
  ).run(userId, otherId, now);
  return 'pending';
}

export function removeFriend(userId: string, otherId: string): void {
  const d = database();
  d.prepare('DELETE FROM friends WHERE user_id = ? AND friend_id = ?').run(userId, otherId);
  d.prepare('DELETE FROM friends WHERE user_id = ? AND friend_id = ?').run(otherId, userId);
}

/** Accepted friends plus any requests still waiting on us. */
export function listFriends(userId: string): FriendRow[] {
  return database()
    .prepare(
      `SELECT u.id, u.display_name, u.avatar, u.rating, u.last_seen,
              f.status, 0 AS incoming
         FROM friends f
         JOIN users u ON u.id = f.friend_id
        WHERE f.user_id = ? AND f.status IN ('pending', 'accepted')
        UNION
       SELECT u.id, u.display_name, u.avatar, u.rating, u.last_seen,
              'pending' AS status, 1 AS incoming
         FROM friends f
         JOIN users u ON u.id = f.user_id
        WHERE f.friend_id = ? AND f.status = 'pending'
          AND NOT EXISTS (
            SELECT 1 FROM friends mine
             WHERE mine.user_id = ? AND mine.friend_id = f.user_id
          )
        ORDER BY status, display_name COLLATE NOCASE`,
    )
    .all(userId, userId, userId) as unknown as FriendRow[];
}

export function counts(): { users: number; matches: number } {
  const d = database();
  const u = d.prepare('SELECT COUNT(*) AS n FROM users WHERE guest = 0').get() as {
    n: number;
  };
  const m = d.prepare('SELECT COUNT(*) AS n FROM matches').get() as { n: number };
  return { users: u.n, matches: m.n };
}
