/**
 * WallRush — realtime protocol.
 *
 * One WebSocket connection per client. Messages are JSON objects with a `t`
 * (type) discriminator kept short, because these travel on every move.
 */

import type {
  BotLevel,
  GameConfig,
  GameEnding,
  GameState,
  Move,
  PlayerIndex,
} from './types.js';

export const PROTOCOL_VERSION = 1;

export type RoomVisibility = 'public' | 'private';
export type RoomStatus = 'waiting' | 'playing' | 'finished';

export interface PublicUser {
  id: string;
  name: string;
  rating: number;
  /** Avatar identifier (emoji or preset id). */
  avatar: string;
  guest: boolean;
  title?: string;
}

export interface SeatInfo {
  index: PlayerIndex;
  user: PublicUser | null;
  bot: BotLevel | null;
  connected: boolean;
  /** Remaining clock in milliseconds. */
  clockMs: number;
  ready: boolean;
}

export interface RoomInfo {
  id: string;
  code: string;
  name: string;
  visibility: RoomVisibility;
  status: RoomStatus;
  config: GameConfig;
  seats: SeatInfo[];
  hostId: string | null;
  /** Spectator count. */
  watchers: number;
  rated: boolean;
  createdAt: number;
}

export interface ChatLine {
  id: string;
  userId: string;
  name: string;
  text: string;
  at: number;
  /** Quick emoji reactions are flagged so the UI can animate them. */
  emote?: boolean;
}

// ------------------------------------------------------------ client → server

export type ClientMessage =
  /**
   * Ask for the greeting again. It carried a `token` once; authentication is
   * the `auth` frame's job now, and a field the server ignores is worse than
   * no field — it reads like a way in.
   */
  | { t: 'hello' }
  /**
   * Prove who you are after connecting.
   *
   * The alternative is a token in the socket URL, and a URL is written down
   * everywhere — proxy logs, referrers, browser history. A first frame is
   * seen by the server and nothing else.
   */
  | { t: 'auth'; token: string }
  | { t: 'ping'; at: number }
  | { t: 'lobby.subscribe' }
  | { t: 'lobby.unsubscribe' }
  | {
      t: 'room.create';
      name?: string;
      visibility: RoomVisibility;
      config: Partial<GameConfig>;
      rated?: boolean;
      bots?: { seat: number; level: BotLevel }[];
    }
  | { t: 'room.join'; code: string; asSpectator?: boolean }
  | { t: 'room.leave' }
  | { t: 'room.seat'; seat: number | null }
  | { t: 'room.addBot'; seat: number; level: BotLevel }
  | { t: 'room.removeBot'; seat: number }
  | { t: 'room.config'; config: Partial<GameConfig>; rated?: boolean }
  | { t: 'room.ready'; ready: boolean }
  | { t: 'room.start' }
  | { t: 'room.rematch' }
  | { t: 'game.move'; move: Move; ply: number }
  | { t: 'game.resign' }
  | { t: 'game.drawOffer' }
  | { t: 'game.drawAnswer'; accept: boolean }
  | { t: 'chat'; text: string; emote?: boolean }
  | { t: 'queue.join'; config: Partial<GameConfig>; rated?: boolean }
  | { t: 'queue.leave' }
  /** Asks the server to tell a friend about the room we are sitting in. */
  | { t: 'friend.invite'; userId: string };

// ------------------------------------------------------------ server → client

export type ServerMessage =
  | {
      t: 'welcome';
      user: PublicUser;
      version: number;
      online: number;
      /**
       * Issued when the connection had no valid token — i.e. a brand new guest.
       * Storing it is what lets a guest keep their identity (and their seat)
       * across a refresh or a dropped connection.
       */
      token?: string;
    }
  | { t: 'pong'; at: number; server: number }
  | { t: 'error'; code: string; message?: string }
  | { t: 'lobby'; rooms: RoomInfo[]; online: number; inGame: number }
  | { t: 'room'; room: RoomInfo }
  | { t: 'room.closed'; reason: string }
  | {
      t: 'game.start';
      room: RoomInfo;
      state: GameState;
      /** Your seat, or null when spectating. */
      seat: PlayerIndex | null;
      serverNow: number;
    }
  | {
      t: 'game.move';
      move: Move;
      by: PlayerIndex;
      state: GameState;
      clocks: number[];
      serverNow: number;
    }
  | {
      t: 'game.over';
      winner: PlayerIndex | null;
      ending: GameEnding;
      state: GameState;
      ratings?: { userId: string; before: number; after: number; delta: number }[];
      /** Id of the stored match, so the result screen can link to its replay. */
      matchId?: string;
    }
  | { t: 'game.drawOffer'; by: PlayerIndex }
  | { t: 'game.drawDeclined' }
  | { t: 'chat'; line: ChatLine }
  | { t: 'queue.status'; waiting: number; since: number }
  | { t: 'clock'; clocks: number[]; turn: PlayerIndex; serverNow: number }
  /** A friend wants you at their table. */
  | { t: 'friend.invite'; from: PublicUser; code: string; at: number }
  /** Something about your friends changed; re-read the list. */
  | { t: 'friends.changed' };

export function encode(msg: ServerMessage | ClientMessage): string {
  return JSON.stringify(msg);
}

export function decode<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
