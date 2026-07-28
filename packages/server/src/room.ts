/**
 * WallRush — a room.
 *
 * A room owns one table: its seats, its clock, its chat and (once started) its
 * game. The server is authoritative — clients propose moves, the room validates
 * them against the shared engine and broadcasts the resulting state.
 */

import { randomUUID } from 'node:crypto';

import {
  applyElo,
  Bot,
  BOT_PROFILES,
  BOT_RATING,
  cloneConfig,
  DEFAULT_CONFIG,
  Game,
  MoveKind,
  transcript,
  type BotLevel,
  type ChatLine,
  type GameConfig,
  type GameEnding,
  type Move,
  type PublicUser,
  type RoomInfo,
  type RoomVisibility,
  type SeatInfo,
  type ServerMessage,
} from '@wallrush/shared';

import { config } from './config.js';
import {
  applyMatchResult,
  getUserById,
  recordMatch,
  type UserRow,
} from './db.js';
import { toPublicUser } from './auth.js';

export interface Participant {
  userId: string;
  send(msg: ServerMessage): void;
  /** Connection identity, so a reconnect can replace a dead socket. */
  connectionId: string;
}

interface Seat {
  index: number;
  userId: string | null;
  bot: BotLevel | null;
  clockMs: number;
  ready: boolean;
  /** Wall-clock timestamp of the last disconnect, for the grace period. */
  disconnectedAt: number | null;
}

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function makeRoomCode(): string {
  let out = '';
  for (let i = 0; i < 5; i++) {
    out += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
  }
  return out;
}

export type RoomEvent =
  | { type: 'update' }
  | { type: 'finished' }
  | { type: 'empty' };

export class Room {
  readonly id = randomUUID();
  readonly code = makeRoomCode();
  readonly createdAt = Date.now();

  name: string;
  visibility: RoomVisibility;
  rated: boolean;
  config: GameConfig;
  hostId: string | null;
  seats: Seat[];
  game: Game | null = null;
  status: 'waiting' | 'playing' | 'finished' = 'waiting';
  chat: ChatLine[] = [];

  /** Connected participants keyed by user id (players and spectators). */
  private members = new Map<string, Participant>();
  private spectators = new Set<string>();
  private bots = new Map<number, Bot>();
  private turnStartedAt = 0;
  private startedAt = 0;
  private drawOfferBy: number | null = null;
  private botTimer: NodeJS.Timeout | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private finishedAt = 0;
  /** When the last member left, or null while somebody is here. */
  emptySince: number | null = Date.now();
  private onEvent: (room: Room, event: RoomEvent) => void;

  constructor(opts: {
    name?: string;
    visibility: RoomVisibility;
    rated?: boolean;
    config?: Partial<GameConfig>;
    hostId: string | null;
    onEvent: (room: Room, event: RoomEvent) => void;
  }) {
    this.config = normaliseConfig(opts.config);
    this.name = (opts.name ?? '').slice(0, 32);
    this.visibility = opts.visibility;
    this.rated = opts.rated ?? true;
    this.hostId = opts.hostId;
    this.onEvent = opts.onEvent;
    this.seats = Array.from({ length: this.config.players }, (_, index) => ({
      index,
      userId: null,
      bot: null,
      clockMs: this.config.clockMs,
      ready: false,
      disconnectedAt: null,
    }));
  }

  // ------------------------------------------------------------- membership

  get memberCount(): number {
    return this.members.size;
  }

  get humanSeatCount(): number {
    return this.seats.filter((s) => s.userId !== null).length;
  }

  get isEmpty(): boolean {
    return this.members.size === 0;
  }

  get isFinishedLongEnough(): boolean {
    return (
      this.status === 'finished' && Date.now() - this.finishedAt > config.roomLingerMs
    );
  }

  /** True once an empty room has waited out its grace period. */
  get isAbandoned(): boolean {
    if (this.status === 'playing') return false;
    if (this.emptySince === null) return false;
    return Date.now() - this.emptySince > config.emptyGraceMs;
  }

  attach(participant: Participant): void {
    this.emptySince = null;
    this.members.set(participant.userId, participant);
    const seat = this.seats.find((s) => s.userId === participant.userId);
    if (seat) seat.disconnectedAt = null;
    else this.spectators.add(participant.userId);
  }

  /**
   * An explicit departure, as opposed to a socket dropping.
   *
   * These are different things and must not be treated the same: a dropped
   * connection deserves the reconnect grace period, but pressing "leave" is a
   * decision, and the opponent should not be left staring at a frozen board
   * for forty-five seconds waiting for someone who is not coming back.
   */
  leave(userId: string): void {
    if (this.status === 'playing' && this.seatOf(userId) !== null) {
      this.resign(userId);
    }
    this.detach(userId);
  }

  detach(userId: string): void {
    this.members.delete(userId);
    this.spectators.delete(userId);
    if (this.members.size === 0) this.emptySince = Date.now();
    const seat = this.seats.find((s) => s.userId === userId);
    if (!seat) {
      this.emit({ type: 'update' });
      return;
    }
    if (this.status === 'playing') {
      // Keep the seat warm; a reconnect within the grace period resumes play.
      seat.disconnectedAt = Date.now();
    } else {
      seat.userId = null;
      seat.ready = false;
      if (this.hostId === userId) {
        this.hostId = this.seats.find((s) => s.userId)?.userId ?? null;
      }
    }
    this.emit({ type: 'update' });
    if (this.isEmpty) this.emit({ type: 'empty' });
  }

  hasMember(userId: string): boolean {
    return this.members.has(userId);
  }

  seatOf(userId: string): number | null {
    const seat = this.seats.find((s) => s.userId === userId);
    return seat ? seat.index : null;
  }

  // ------------------------------------------------------------------ seats

  takeSeat(userId: string, index: number | null): boolean {
    if (this.status === 'playing') return false;
    const current = this.seats.find((s) => s.userId === userId);
    if (current) {
      current.userId = null;
      current.ready = false;
    }
    if (index === null) {
      this.spectators.add(userId);
      this.emit({ type: 'update' });
      return true;
    }
    const target = this.seats[index];
    if (!target || target.userId || target.bot) return false;
    target.userId = userId;
    target.ready = false;
    this.spectators.delete(userId);
    if (!this.hostId) this.hostId = userId;
    this.emit({ type: 'update' });
    return true;
  }

  addBot(index: number, level: BotLevel): boolean {
    if (this.status === 'playing') return false;
    const seat = this.seats[index];
    if (!seat || seat.userId) return false;
    if (!BOT_PROFILES[level]) return false;
    seat.bot = level;
    seat.ready = true;
    this.emit({ type: 'update' });
    return true;
  }

  removeBot(index: number): boolean {
    if (this.status === 'playing') return false;
    const seat = this.seats[index];
    if (!seat || !seat.bot) return false;
    seat.bot = null;
    seat.ready = false;
    this.emit({ type: 'update' });
    return true;
  }

  setReady(userId: string, ready: boolean): void {
    const seat = this.seats.find((s) => s.userId === userId);
    if (!seat) return;
    seat.ready = ready;
    this.emit({ type: 'update' });
    this.maybeAutoStart();
  }

  updateConfig(patch: Partial<GameConfig>, rated?: boolean): void {
    if (this.status === 'playing') return;
    const next = normaliseConfig({ ...this.config, ...patch });
    const seatCountChanged = next.players !== this.config.players;
    this.config = next;
    if (typeof rated === 'boolean') this.rated = rated;
    if (seatCountChanged) {
      const old = this.seats;
      this.seats = Array.from({ length: next.players }, (_, index) => ({
        index,
        userId: old[index]?.userId ?? null,
        bot: old[index]?.bot ?? null,
        clockMs: next.clockMs,
        ready: old[index]?.ready ?? false,
        disconnectedAt: null,
      }));
    } else {
      for (const s of this.seats) s.clockMs = next.clockMs;
    }
    for (const s of this.seats) if (!s.bot) s.ready = false;
    this.emit({ type: 'update' });
  }

  get canStart(): boolean {
    if (this.status === 'playing') return false;
    const filled = this.seats.every((s) => s.userId !== null || s.bot !== null);
    if (!filled) return false;
    const humans = this.seats.filter((s) => s.userId !== null);
    return humans.every((s) => s.ready);
  }

  private maybeAutoStart(): void {
    if (this.canStart) this.start();
  }

  // ------------------------------------------------------------------- game

  start(): boolean {
    if (!this.canStart) return false;
    this.game = new Game(this.config);
    this.status = 'playing';
    this.startedAt = Date.now();
    this.turnStartedAt = Date.now();
    this.drawOfferBy = null;
    this.bots.clear();
    for (const seat of this.seats) {
      seat.clockMs = this.config.clockMs;
      seat.disconnectedAt = null;
      if (seat.bot) {
        this.bots.set(
          seat.index,
          new Bot(seat.bot, this.config.size, this.config.players, (Math.random() * 2 ** 31) | 0),
        );
      }
    }
    this.broadcastStart();
    this.startTicking();
    this.scheduleBot();
    this.emit({ type: 'update' });
    return true;
  }

  private broadcastStart(): void {
    const info = this.toInfo();
    const state = this.game!.toState();
    for (const [userId, participant] of this.members) {
      participant.send({
        t: 'game.start',
        room: info,
        state,
        seat: this.seatOf(userId),
        serverNow: Date.now(),
      });
    }
  }

  /** Remaining clock for a seat, accounting for time spent on the current move. */
  clockFor(index: number): number {
    const seat = this.seats[index];
    if (!seat) return 0;
    if (this.status !== 'playing' || !this.game) return seat.clockMs;
    if (this.game.turn !== index) return seat.clockMs;
    return Math.max(0, seat.clockMs - (Date.now() - this.turnStartedAt));
  }

  clocks(): number[] {
    return this.seats.map((s) => this.clockFor(s.index));
  }

  playMove(userId: string | null, move: Move, seatIndex?: number): { ok: boolean; error?: string } {
    if (!this.game || this.status !== 'playing') return { ok: false, error: 'not-playing' };
    const seat = seatIndex ?? (userId ? this.seatOf(userId) : null);
    if (seat === null || seat === undefined) return { ok: false, error: 'not-seated' };
    if (this.game.turn !== seat) return { ok: false, error: 'not-your-turn' };

    const elapsed = Date.now() - this.turnStartedAt;
    const result = this.game.apply(move, elapsed);
    if (!result.ok) return { ok: false, error: result.reason };

    const seatState = this.seats[seat];
    if (this.config.clockMs > 0) {
      seatState.clockMs = Math.max(0, seatState.clockMs - elapsed) + this.config.incrementMs;
    }
    this.turnStartedAt = Date.now();
    this.drawOfferBy = null;

    const payload: ServerMessage = {
      t: 'game.move',
      move,
      by: seat,
      state: this.game.toState(),
      clocks: this.clocks(),
      serverNow: Date.now(),
    };
    this.broadcast(payload);

    if (this.game.isOver) this.finish(this.game.winner, this.game.ending ?? 'goal');
    else this.scheduleBot();
    return { ok: true };
  }

  resign(userId: string): void {
    if (!this.game || this.status !== 'playing') return;
    const seat = this.seatOf(userId);
    if (seat === null) return;
    this.game.eliminate(seat, 'resign');
    this.finish(this.game.winner, 'resign');
  }

  offerDraw(userId: string): void {
    if (!this.game || this.status !== 'playing') return;
    const seat = this.seatOf(userId);
    if (seat === null || this.drawOfferBy === seat) return;
    this.drawOfferBy = seat;
    this.broadcast({ t: 'game.drawOffer', by: seat });
  }

  answerDraw(userId: string, accept: boolean): void {
    if (!this.game || this.status !== 'playing' || this.drawOfferBy === null) return;
    const seat = this.seatOf(userId);
    if (seat === null || seat === this.drawOfferBy) return;
    if (accept) {
      this.game.ending = 'draw';
      this.finish(null, 'draw');
    } else {
      this.drawOfferBy = null;
      this.broadcast({ t: 'game.drawDeclined' });
    }
  }

  rematch(userId: string): void {
    if (this.status !== 'finished') return;
    const seat = this.seats.find((s) => s.userId === userId);
    if (!seat) return;
    seat.ready = true;

    // Free the seats of anyone who is no longer here. Otherwise a rematch waits
    // forever on a player who closed the tab, and the button does nothing with
    // no explanation.
    for (const s of this.seats) {
      if (s.userId && s.userId !== userId && !this.members.has(s.userId)) {
        s.userId = null;
        s.ready = false;
      }
    }
    if (!this.seats.some((s) => s.userId === this.hostId)) this.hostId = userId;

    const humans = this.seats.filter((s) => s.userId !== null);
    const everySeatTaken = this.seats.every((s) => s.userId !== null || s.bot !== null);
    if (!everySeatTaken) {
      // Back to the waiting room, where the code is on screen and someone else
      // can be invited.
      this.status = 'waiting';
      this.game = null;
      this.emit({ type: 'update' });
      return;
    }
    if (humans.length > 0 && humans.every((s) => s.ready)) {
      // Swap sides so the first-move advantage alternates between games.
      const ids = this.seats.map((s) => s.userId);
      const bots = this.seats.map((s) => s.bot);
      for (let i = 0; i < this.seats.length; i++) {
        const from = (i + 1) % this.seats.length;
        this.seats[i].userId = ids[from];
        this.seats[i].bot = bots[from];
      }
      this.status = 'waiting';
      for (const s of this.seats) s.ready = true;
      this.start();
    } else {
      this.emit({ type: 'update' });
    }
  }

  // ------------------------------------------------------------------ clocks

  private startTicking(): void {
    this.stopTicking();
    this.tickTimer = setInterval(() => this.tick(), 1000);
  }

  private stopTicking(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  private tick(): void {
    if (!this.game || this.status !== 'playing') {
      this.stopTicking();
      return;
    }
    const turn = this.game.turn;
    const elapsed = Date.now() - this.turnStartedAt;

    // Per-move cap.
    if (this.config.moveTimeoutMs > 0 && elapsed > this.config.moveTimeoutMs) {
      this.forceMove(turn, 'move-timeout');
      return;
    }
    // Whole-game clock.
    if (this.config.clockMs > 0 && this.clockFor(turn) <= 0) {
      this.game.eliminate(turn, 'timeout');
      this.finish(this.game.winner, 'timeout');
      return;
    }
    // Disconnect grace period.
    const seat = this.seats[turn];
    if (
      seat.disconnectedAt !== null &&
      Date.now() - seat.disconnectedAt > config.reconnectGraceMs
    ) {
      this.game.eliminate(turn, 'disconnect');
      this.finish(this.game.winner, 'disconnect');
      return;
    }

    this.broadcast({
      t: 'clock',
      clocks: this.clocks(),
      turn,
      serverNow: Date.now(),
    });
  }

  /**
   * A player ran out of thinking time for this move. Rather than ending the
   * game on a technicality we play a sensible move for them — the whole-game
   * clock still governs the real result.
   */
  private forceMove(seat: number, _reason: string): void {
    if (!this.game) return;
    const helper = new Bot('medium', this.config.size, this.config.players);
    const pick = helper.choose(this.game, { strict: true, timeMs: 120 });
    this.playMove(null, pick.move, seat);
  }

  // -------------------------------------------------------------------- bots

  private scheduleBot(): void {
    if (this.botTimer) clearTimeout(this.botTimer);
    this.botTimer = null;
    if (!this.game || this.status !== 'playing') return;
    const seat = this.seats[this.game.turn];
    if (!seat?.bot) return;
    const profile = BOT_PROFILES[seat.bot];
    // A short, level-dependent pause keeps bot play readable rather than instant.
    const delay = profile.minThinkMs + Math.floor(Math.random() * 220);
    this.botTimer = setTimeout(() => this.runBot(seat.index), delay);
  }

  private runBot(seatIndex: number): void {
    if (!this.game || this.status !== 'playing' || this.game.turn !== seatIndex) return;
    const bot = this.bots.get(seatIndex);
    if (!bot) return;
    try {
      const result = bot.choose(this.game);
      this.playMove(null, result.move, seatIndex);
    } catch (err) {
      // Never let a bot failure freeze a table: fall back to any legal move.
      const fallback = this.game.legalMoves(seatIndex)[0];
      if (fallback) this.playMove(null, fallback, seatIndex);
    }
  }

  // ------------------------------------------------------------------ finish

  private finish(winner: number | null, ending: GameEnding): void {
    if (this.status === 'finished' || !this.game) return;
    this.status = 'finished';
    this.finishedAt = Date.now();
    this.stopTicking();
    if (this.botTimer) clearTimeout(this.botTimer);
    this.botTimer = null;
    for (const s of this.seats) s.ready = false;

    const settled = this.settleRatings(winner, ending);
    this.broadcast({
      t: 'game.over',
      winner,
      ending,
      state: this.game.toState(),
      ratings: settled.ratings,
      ...(settled.matchId ? { matchId: settled.matchId } : {}),
    });
    this.emit({ type: 'finished' });
    this.emit({ type: 'update' });
  }

  /**
   * Update Elo and persist the match. Only rated games between two identified
   * humans move the ladder; bot games and guest games are recorded for history
   * but leave ratings untouched.
   */
  private settleRatings(
    winner: number | null,
    ending: GameEnding,
  ): {
    ratings: { userId: string; before: number; after: number; delta: number }[];
    matchId: string | null;
  } {
    const game = this.game!;
    const out: { userId: string; before: number; after: number; delta: number }[] = [];
    const rows = new Map<number, UserRow>();
    for (const seat of this.seats) {
      if (!seat.userId) continue;
      const row = getUserById(seat.userId);
      if (row) rows.set(seat.index, row);
    }

    const humans = [...rows.entries()];
    const twoHumans = this.config.players === 2 && humans.length === 2;
    const bothRegistered = humans.every(([, row]) => row.guest === 0);
    const isRated = this.rated && twoHumans && bothRegistered && ending !== 'abort';

    const resultFor = (seat: number): 'win' | 'loss' | 'draw' => {
      if (winner === null) return 'draw';
      return winner === seat ? 'win' : 'loss';
    };

    if (isRated) {
      const [[seatA, rowA], [seatB, rowB]] = humans;
      const scoreA = winner === null ? 0.5 : winner === seatA ? 1 : 0;
      const changeA = applyElo(rowA.rating, rowA.games, rowB.rating, scoreA);
      const changeB = applyElo(rowB.rating, rowB.games, rowA.rating, 1 - scoreA);
      applyMatchResult(rowA.id, resultFor(seatA), changeA.after);
      applyMatchResult(rowB.id, resultFor(seatB), changeB.after);
      out.push({ userId: rowA.id, ...changeA });
      out.push({ userId: rowB.id, ...changeB });
    } else {
      // Unrated (or a bot game, or a guest at the table): keep the win/loss
      // record, leave the rating alone. Guests count too — registering later
      // upgrades the same row, and the promise on the sign-up screen is that
      // nothing is lost.
      for (const [seat, row] of humans) {
        applyMatchResult(row.id, resultFor(seat), row.rating);
        out.push({ userId: row.id, before: row.rating, after: row.rating, delta: 0 });
      }
    }

    let matchId: string | null = randomUUID();
    try {
      recordMatch(
        {
          id: matchId,
          mode: this.seats.some((s) => s.bot) ? 'bot' : this.visibility === 'public' ? 'public' : 'private',
          size: this.config.size,
          seats: this.config.players,
          rated: isRated ? 1 : 0,
          winner_seat: winner,
          ending,
          transcript: transcript(
            game.history.map((h) => h.move),
            this.config.size,
          ),
          config_json: JSON.stringify(this.config),
          players_json: JSON.stringify(
            this.seats.map((s) => ({
              seat: s.index,
              bot: s.bot,
              userId: s.userId,
              name: s.userId ? (rows.get(s.index)?.display_name ?? '?') : s.bot,
            })),
          ),
          started_at: this.startedAt,
          finished_at: this.finishedAt,
          plies: game.ply,
        },
        this.seats
          .filter((s) => s.userId)
          .map((s) => {
            const change = out.find((o) => o.userId === s.userId);
            return {
              userId: s.userId!,
              seat: s.index,
              result: resultFor(s.index),
              ratingBefore: change?.before ?? null,
              ratingAfter: change?.after ?? null,
              botLevel:
                this.seats.find((x) => x.bot && x.index !== s.index)?.bot ?? null,
            };
          }),
      );
    } catch {
      // History is a nice-to-have; never let it take a live table down.
      matchId = null;
    }
    return { ratings: out, matchId };
  }

  abort(reason: GameEnding = 'abort'): void {
    if (this.status === 'playing' && this.game) {
      this.game.ending = reason;
      this.finish(null, reason);
    }
    this.stopTicking();
    if (this.botTimer) clearTimeout(this.botTimer);
  }

  // ------------------------------------------------------------------- chat

  addChat(user: PublicUser, text: string, emote = false): ChatLine | null {
    const clean = text.replace(/\s+/g, ' ').trim().slice(0, 240);
    if (!clean) return null;
    const line: ChatLine = {
      id: randomUUID(),
      userId: user.id,
      name: user.name,
      text: clean,
      at: Date.now(),
      emote,
    };
    this.chat.push(line);
    if (this.chat.length > 120) this.chat.shift();
    this.broadcast({ t: 'chat', line });
    return line;
  }

  // -------------------------------------------------------------- broadcast

  broadcast(msg: ServerMessage): void {
    for (const participant of this.members.values()) participant.send(msg);
  }

  sendTo(userId: string, msg: ServerMessage): void {
    this.members.get(userId)?.send(msg);
  }

  toInfo(): RoomInfo {
    const seats: SeatInfo[] = this.seats.map((s) => {
      let user: PublicUser | null = null;
      if (s.userId) {
        const row = getUserById(s.userId);
        if (row) user = toPublicUser(row);
      }
      return {
        index: s.index,
        user,
        bot: s.bot,
        connected: s.userId ? this.members.has(s.userId) : s.bot !== null,
        clockMs: this.clockFor(s.index),
        ready: s.ready,
      };
    });
    return {
      id: this.id,
      code: this.code,
      name: this.name,
      visibility: this.visibility,
      status: this.status,
      config: this.config,
      seats,
      hostId: this.hostId,
      watchers: this.spectators.size,
      rated: this.rated,
      createdAt: this.createdAt,
    };
  }

  pushState(): void {
    const info = this.toInfo();
    this.broadcast({ t: 'room', room: info });
  }

  dispose(): void {
    this.stopTicking();
    if (this.botTimer) clearTimeout(this.botTimer);
    this.members.clear();
    this.spectators.clear();
  }

  private emit(event: RoomEvent): void {
    this.onEvent(this, event);
  }
}

const ALLOWED_SIZES = new Set([5, 7, 9, 11]);

export function normaliseConfig(patch?: Partial<GameConfig>): GameConfig {
  const merged = { ...DEFAULT_CONFIG, ...patch };
  const size = ALLOWED_SIZES.has(merged.size) ? merged.size : 9;
  const players = merged.players === 4 ? 4 : 2;
  const base = cloneConfig({ size, players });
  const walls = Number.isFinite(merged.wallsPerPlayer)
    ? Math.max(0, Math.min(20, Math.round(merged.wallsPerPlayer)))
    : base.wallsPerPlayer;
  const clockMs = clampNumber(merged.clockMs, 0, 60 * 60 * 1000, DEFAULT_CONFIG.clockMs);
  const incrementMs = clampNumber(merged.incrementMs, 0, 60 * 1000, DEFAULT_CONFIG.incrementMs);
  const moveTimeoutMs = clampNumber(
    merged.moveTimeoutMs,
    0,
    10 * 60 * 1000,
    DEFAULT_CONFIG.moveTimeoutMs,
  );
  return { size, players, wallsPerPlayer: walls, clockMs, incrementMs, moveTimeoutMs };
}

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

export { MoveKind };
