/**
 * WallRush — the hub.
 *
 * Owns every live room, the public lobby feed and the matchmaking queue.
 * Rooms are addressed by their short join code; the lobby only ever exposes
 * public rooms, so a code stays a private invitation.
 */

import type { GameConfig, RoomInfo, ServerMessage } from '@wallrush/shared';

import { config } from './config.js';
import { Room, normaliseConfig, type Participant, type RoomEvent } from './room.js';

interface QueueEntry {
  userId: string;
  rating: number;
  config: GameConfig;
  rated: boolean;
  since: number;
  send(msg: ServerMessage): void;
}

export class Hub {
  private rooms = new Map<string, Room>();
  private byCode = new Map<string, Room>();
  /** Which room a user is currently in. */
  private location = new Map<string, string>();
  private lobbyWatchers = new Map<string, (msg: ServerMessage) => void>();
  private queue: QueueEntry[] = [];
  private online = new Set<string>();
  private lobbyDirty = false;
  private timer: NodeJS.Timeout;

  constructor() {
    this.timer = setInterval(() => this.maintain(), 1000);
    this.timer.unref?.();
  }

  // ------------------------------------------------------------------ people

  markOnline(userId: string): void {
    this.online.add(userId);
    this.lobbyDirty = true;
  }

  markOffline(userId: string): void {
    this.online.delete(userId);
    this.leaveQueue(userId);
    this.lobbyDirty = true;
  }

  get onlineCount(): number {
    return this.online.size;
  }

  isOnline(userId: string): boolean {
    return this.online.has(userId);
  }

  /** Lets the server push a friends-list refresh to whoever is affected. */
  private friendListener: ((userIds: string[]) => void) | null = null;

  onFriendsChanged(listener: (userIds: string[]) => void): void {
    this.friendListener = listener;
  }

  notifyFriends(...userIds: string[]): void {
    this.friendListener?.(userIds);
  }

  get inGameCount(): number {
    let n = 0;
    for (const room of this.rooms.values()) {
      if (room.status === 'playing') n += room.humanSeatCount;
    }
    return n;
  }

  // ------------------------------------------------------------------- rooms

  createRoom(opts: {
    name?: string;
    visibility: 'public' | 'private';
    rated?: boolean;
    config?: Partial<GameConfig>;
    hostId: string | null;
  }): Room | null {
    if (this.rooms.size >= config.maxRooms) return null;
    const room = new Room({
      ...opts,
      onEvent: (r, e) => this.handleRoomEvent(r, e),
    });
    this.rooms.set(room.id, room);
    this.byCode.set(room.code, room);
    this.lobbyDirty = true;
    return room;
  }

  roomByCode(code: string): Room | null {
    return this.byCode.get(code.trim().toUpperCase()) ?? null;
  }

  roomById(id: string): Room | null {
    return this.rooms.get(id) ?? null;
  }

  roomOf(userId: string): Room | null {
    const id = this.location.get(userId);
    return id ? (this.rooms.get(id) ?? null) : null;
  }

  join(room: Room, participant: Participant, asSpectator: boolean): boolean {
    const previous = this.roomOf(participant.userId);
    if (previous && previous.id !== room.id) this.leave(participant.userId);
    room.attach(participant);
    this.location.set(participant.userId, room.id);
    if (!asSpectator && room.seatOf(participant.userId) === null) {
      const free = room.seats.findIndex((s) => !s.userId && !s.bot);
      if (free >= 0) room.takeSeat(participant.userId, free);
    }
    this.lobbyDirty = true;
    return true;
  }

  /**
   * Removes a player from their room deliberately — leaving, or being moved to
   * another table. A live game they were seated at is forfeited; a socket that
   * merely dropped goes through `Room.detach` instead and keeps its grace period.
   */
  leave(userId: string): void {
    const room = this.roomOf(userId);
    if (!room) return;
    room.leave(userId);
    this.location.delete(userId);
    this.lobbyDirty = true;
  }

  private handleRoomEvent(room: Room, event: RoomEvent): void {
    if (event.type === 'update' || event.type === 'finished') {
      room.pushState();
      this.lobbyDirty = true;
    }
    if (event.type === 'empty') {
      // Deliberately not disposed here. A host who refreshes the page has an
      // empty room for a moment, and losing the code they just shared would be
      // worse than keeping a few kilobytes around. `maintain` reaps it later.
      this.lobbyDirty = true;
    }
  }

  private disposeRoom(room: Room): void {
    if (room.status === 'playing') return;
    room.dispose();
    this.rooms.delete(room.id);
    this.byCode.delete(room.code);
    for (const [userId, roomId] of this.location) {
      if (roomId === room.id) this.location.delete(userId);
    }
    this.lobbyDirty = true;
  }

  // ------------------------------------------------------------------- lobby

  watchLobby(userId: string, send: (msg: ServerMessage) => void): void {
    this.lobbyWatchers.set(userId, send);
    send(this.lobbyMessage());
  }

  unwatchLobby(userId: string): void {
    this.lobbyWatchers.delete(userId);
  }

  lobbyMessage(): ServerMessage {
    const rooms: RoomInfo[] = [];
    for (const room of this.rooms.values()) {
      if (room.visibility !== 'public') continue;
      if (room.status === 'finished') continue;
      // A room nobody is sitting in is still alive (its host may be
      // reconnecting) but there is nothing to advertise.
      if (room.isEmpty) continue;
      rooms.push(room.toInfo());
    }
    rooms.sort((a, b) => {
      // Tables that need one more player float to the top.
      const aOpen = a.seats.filter((s) => !s.user && !s.bot).length;
      const bOpen = b.seats.filter((s) => !s.user && !s.bot).length;
      if (aOpen !== bOpen) return (aOpen === 0 ? 99 : aOpen) - (bOpen === 0 ? 99 : bOpen);
      return b.createdAt - a.createdAt;
    });
    return {
      t: 'lobby',
      rooms: rooms.slice(0, 60),
      online: this.onlineCount,
      inGame: this.inGameCount,
    };
  }

  private flushLobby(): void {
    if (!this.lobbyDirty || this.lobbyWatchers.size === 0) {
      this.lobbyDirty = false;
      return;
    }
    const msg = this.lobbyMessage();
    for (const send of this.lobbyWatchers.values()) send(msg);
    this.lobbyDirty = false;
  }

  // ------------------------------------------------------------- matchmaking

  joinQueue(entry: Omit<QueueEntry, 'since'>): void {
    this.leaveQueue(entry.userId);
    const normalised: QueueEntry = {
      ...entry,
      config: normaliseConfig(entry.config),
      since: Date.now(),
    };
    this.queue.push(normalised);
    this.pumpQueue();
    for (const e of this.queue) {
      e.send({ t: 'queue.status', waiting: this.queue.length, since: e.since });
    }
  }

  leaveQueue(userId: string): void {
    const before = this.queue.length;
    this.queue = this.queue.filter((e) => e.userId !== userId);
    if (this.queue.length !== before) {
      for (const e of this.queue) {
        e.send({ t: 'queue.status', waiting: this.queue.length, since: e.since });
      }
    }
  }

  queueSize(): number {
    return this.queue.length;
  }

  /**
   * Pair waiting players. The rating window widens the longer someone waits,
   * so a quiet lobby still produces a game rather than an endless spinner.
   */
  private pumpQueue(): void {
    if (this.queue.length < 2) return;
    const now = Date.now();
    const used = new Set<string>();
    const pairs: [QueueEntry, QueueEntry][] = [];

    const sorted = [...this.queue].sort((a, b) => a.since - b.since);
    for (const a of sorted) {
      if (used.has(a.userId)) continue;
      let best: QueueEntry | null = null;
      let bestGap = Infinity;
      for (const b of sorted) {
        if (b.userId === a.userId || used.has(b.userId)) continue;
        if (!sameSetup(a.config, b.config) || a.rated !== b.rated) continue;
        const waited = Math.max(now - a.since, now - b.since);
        const window = 120 + Math.floor(waited / 1000) * 45;
        const gap = Math.abs(a.rating - b.rating);
        if (gap > window) continue;
        if (gap < bestGap) {
          bestGap = gap;
          best = b;
        }
      }
      if (best) {
        used.add(a.userId);
        used.add(best.userId);
        pairs.push([a, best]);
      }
    }

    for (const [a, b] of pairs) {
      this.queue = this.queue.filter((e) => e.userId !== a.userId && e.userId !== b.userId);
      const room = this.createRoom({
        visibility: 'private',
        rated: a.rated,
        config: a.config,
        hostId: a.userId,
      });
      if (!room) continue;
      this.pendingMatches.push({ room, users: [a.userId, b.userId] });
    }
    if (pairs.length > 0) this.drainPendingMatches();
  }

  /** Rooms created by matchmaking that still need their players attached. */
  private pendingMatches: { room: Room; users: string[] }[] = [];
  private matchListener: ((roomCode: string, userIds: string[]) => void) | null = null;

  onMatchFound(listener: (roomCode: string, userIds: string[]) => void): void {
    this.matchListener = listener;
  }

  private drainPendingMatches(): void {
    if (!this.matchListener) return;
    const pending = this.pendingMatches;
    this.pendingMatches = [];
    for (const { room, users } of pending) this.matchListener(room.code, users);
  }

  // -------------------------------------------------------------- background

  private maintain(): void {
    for (const room of [...this.rooms.values()]) {
      if (room.isAbandoned) this.disposeRoom(room);
      else if (room.isFinishedLongEnough && room.isEmpty) this.disposeRoom(room);
    }
    this.pumpQueue();
    this.flushLobby();
  }

  stats(): { rooms: number; playing: number; queue: number; online: number } {
    let playing = 0;
    for (const r of this.rooms.values()) if (r.status === 'playing') playing += 1;
    return {
      rooms: this.rooms.size,
      playing,
      queue: this.queue.length,
      online: this.online.size,
    };
  }

  dispose(): void {
    clearInterval(this.timer);
    for (const room of this.rooms.values()) room.dispose();
    this.rooms.clear();
    this.byCode.clear();
  }
}

function sameSetup(a: GameConfig, b: GameConfig): boolean {
  return (
    a.size === b.size &&
    a.players === b.players &&
    a.wallsPerPlayer === b.wallsPerPlayer &&
    a.clockMs === b.clockMs &&
    a.incrementMs === b.incrementMs
  );
}
