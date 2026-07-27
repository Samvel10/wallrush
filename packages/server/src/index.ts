/**
 * WallRush — server entry point.
 *
 * One HTTP server does everything: the JSON API, the static client, and the
 * WebSocket upgrade for realtime play. Keeping it to a single process and a
 * single file-backed database means the whole game can be self-hosted for free
 * on the smallest machine you can rent.
 */

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

import { WebSocketServer, type WebSocket } from 'ws';

import {
  PROTOCOL_VERSION,
  decode,
  type ClientMessage,
  type ServerMessage,
} from '@wallrush/shared';

import { createGuest, issueToken, toPublicUser, userFromToken } from './auth.js';
import { config } from './config.js';
import { openDatabase, sweep, touchUser, type UserRow } from './db.js';
import { Hub } from './hub.js';
import { createHttpHandler } from './http.js';
import { normaliseConfig } from './room.js';

openDatabase();
const hub = new Hub();

interface Client {
  id: string;
  socket: WebSocket;
  user: UserRow;
  lang: string;
  alive: boolean;
  /** Sliding-window counters for the per-connection rate limit. */
  windowStart: number;
  windowCount: number;
  watchingLobby: boolean;
}

const clients = new Map<string, Client>();
const byUser = new Map<string, Client>();

function send(client: Client, msg: ServerMessage): void {
  if (client.socket.readyState !== 1) {
    if (config.debug) {
      process.stdout.write(`x dropped ${msg.t} to ${client.user.id.slice(0, 8)} (socket ${client.socket.readyState})\n`);
    }
    return;
  }
  if (config.debug) process.stdout.write(`> ${msg.t} to ${client.user.id.slice(0, 8)}\n`);
  client.socket.send(JSON.stringify(msg));
}

function sendToUser(userId: string, msg: ServerMessage): void {
  const client = byUser.get(userId);
  if (client) send(client, msg);
}

function fail(client: Client, code: string, message?: string): void {
  send(client, { t: 'error', code, message });
}

const server = createServer(createHttpHandler(hub));
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

server.on('upgrade', (req, socket, head) => {
  if (!req.url?.startsWith('/ws')) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (socket, req) => {
  const url = new URL(req.url ?? '/ws', 'http://localhost');
  const token = url.searchParams.get('token') ?? undefined;
  const lang = url.searchParams.get('lang') ?? 'hy';

  let user = userFromToken(token);
  // A connection with no usable token becomes a fresh guest — and gets a token
  // back, so the same identity survives a refresh, a dropped socket or a phone
  // locking its screen mid-game.
  let issuedToken: string | undefined;
  if (!user) {
    user = createGuest(lang);
    issuedToken = issueToken(user.id);
  }
  touchUser(user.id);

  // One live connection per identity: a second one replaces the first.
  const existing = byUser.get(user.id);
  if (existing) {
    try {
      existing.socket.close(4001, 'replaced');
    } catch {
      /* ignore */
    }
  }

  const client: Client = {
    id: randomUUID(),
    socket,
    user,
    lang,
    alive: true,
    windowStart: Date.now(),
    windowCount: 0,
    watchingLobby: false,
  };
  clients.set(client.id, client);
  byUser.set(user.id, client);
  hub.markOnline(user.id);

  send(client, {
    t: 'welcome',
    user: toPublicUser(user),
    version: PROTOCOL_VERSION,
    online: hub.onlineCount,
    ...(issuedToken ? { token: issuedToken } : {}),
  });

  // Re-attach to a game that is still running (survives refresh and mobile sleep).
  const existingRoom = hub.roomOf(user.id);
  if (existingRoom) {
    existingRoom.attach(participantFor(client));
    send(client, { t: 'room', room: existingRoom.toInfo() });
    if (existingRoom.game) {
      send(client, {
        t: 'game.start',
        room: existingRoom.toInfo(),
        state: existingRoom.game.toState(),
        seat: existingRoom.seatOf(user.id),
        serverNow: Date.now(),
      });
    }
  }

  socket.on('pong', () => {
    client.alive = true;
  });

  socket.on('message', (raw) => {
    if (!withinRateLimit(client)) {
      fail(client, 'rate-limited');
      return;
    }
    const msg = decode<ClientMessage>(raw.toString());
    if (!msg || typeof msg.t !== 'string') {
      fail(client, 'bad-message');
      return;
    }
    if (config.debug) {
      process.stdout.write(`< ${msg.t} from ${client.user.display_name} (${client.user.id.slice(0, 8)})\n`);
    }
    try {
      handleMessage(client, msg);
    } catch (err) {
      if (config.debug) process.stdout.write(`! ${String(err)}\n`);
      fail(client, 'server-error', err instanceof Error ? err.message : undefined);
    }
  });

  socket.on('close', () => {
    clients.delete(client.id);
    if (byUser.get(user.id) === client) {
      byUser.delete(user.id);
      hub.markOffline(user.id);
      hub.unwatchLobby(user.id);
      const room = hub.roomOf(user.id);
      if (room) room.detach(user.id);
    }
  });

  socket.on('error', () => {
    /* the close handler does the cleanup */
  });
});

function participantFor(client: Client) {
  return {
    userId: client.user.id,
    connectionId: client.id,
    send: (msg: ServerMessage) => send(client, msg),
  };
}

function withinRateLimit(client: Client): boolean {
  const now = Date.now();
  if (now - client.windowStart > 1000) {
    client.windowStart = now;
    client.windowCount = 0;
  }
  client.windowCount += 1;
  return client.windowCount <= config.rateLimit;
}

// ------------------------------------------------------------------ dispatch

function handleMessage(client: Client, msg: ClientMessage): void {
  switch (msg.t) {
    case 'hello': {
      send(client, {
        t: 'welcome',
        user: toPublicUser(client.user),
        version: PROTOCOL_VERSION,
        online: hub.onlineCount,
      });
      return;
    }

    case 'ping': {
      send(client, { t: 'pong', at: msg.at, server: Date.now() });
      return;
    }

    case 'lobby.subscribe': {
      client.watchingLobby = true;
      hub.watchLobby(client.user.id, (m) => send(client, m));
      return;
    }

    case 'lobby.unsubscribe': {
      client.watchingLobby = false;
      hub.unwatchLobby(client.user.id);
      return;
    }

    case 'room.create': {
      const room = hub.createRoom({
        name: msg.name,
        visibility: msg.visibility === 'public' ? 'public' : 'private',
        rated: msg.rated ?? true,
        config: normaliseConfig(msg.config),
        hostId: client.user.id,
      });
      if (!room) {
        fail(client, 'server-busy');
        return;
      }
      hub.join(room, participantFor(client), false);
      for (const bot of msg.bots ?? []) room.addBot(bot.seat, bot.level);
      send(client, { t: 'room', room: room.toInfo() });
      return;
    }

    case 'room.join': {
      const room = hub.roomByCode(msg.code ?? '');
      if (!room) {
        fail(client, 'room-not-found');
        return;
      }
      const seated = room.seatOf(client.user.id) !== null;
      const full = room.seats.every((s) => s.userId || s.bot);
      const spectate = msg.asSpectator === true || (full && !seated);
      hub.join(room, participantFor(client), spectate);
      send(client, { t: 'room', room: room.toInfo() });
      if (room.game) {
        send(client, {
          t: 'game.start',
          room: room.toInfo(),
          state: room.game.toState(),
          seat: room.seatOf(client.user.id),
          serverNow: Date.now(),
        });
      }
      return;
    }

    case 'room.leave': {
      const room = hub.roomOf(client.user.id);
      hub.leave(client.user.id);
      if (room) send(client, { t: 'room.closed', reason: 'left' });
      return;
    }

    case 'room.seat': {
      const room = hub.roomOf(client.user.id);
      if (!room) return fail(client, 'not-in-room');
      if (!room.takeSeat(client.user.id, msg.seat)) fail(client, 'seat-taken');
      return;
    }

    case 'room.addBot': {
      const room = hub.roomOf(client.user.id);
      if (!room) return fail(client, 'not-in-room');
      if (room.hostId !== client.user.id) return fail(client, 'not-host');
      if (!room.addBot(msg.seat, msg.level)) fail(client, 'seat-taken');
      return;
    }

    case 'room.removeBot': {
      const room = hub.roomOf(client.user.id);
      if (!room) return fail(client, 'not-in-room');
      if (room.hostId !== client.user.id) return fail(client, 'not-host');
      room.removeBot(msg.seat);
      return;
    }

    case 'room.config': {
      const room = hub.roomOf(client.user.id);
      if (!room) return fail(client, 'not-in-room');
      if (room.hostId !== client.user.id) return fail(client, 'not-host');
      room.updateConfig(msg.config, msg.rated);
      return;
    }

    case 'room.ready': {
      const room = hub.roomOf(client.user.id);
      if (!room) return fail(client, 'not-in-room');
      room.setReady(client.user.id, msg.ready);
      return;
    }

    case 'room.start': {
      const room = hub.roomOf(client.user.id);
      if (!room) return fail(client, 'not-in-room');
      if (room.hostId !== client.user.id) return fail(client, 'not-host');
      if (!room.start()) fail(client, 'cannot-start');
      return;
    }

    case 'room.rematch': {
      const room = hub.roomOf(client.user.id);
      if (!room) return fail(client, 'not-in-room');
      room.rematch(client.user.id);
      return;
    }

    case 'game.move': {
      const room = hub.roomOf(client.user.id);
      if (!room) return fail(client, 'not-in-room');
      const result = room.playMove(client.user.id, msg.move);
      if (!result.ok) {
        fail(client, result.error ?? 'illegal-move');
        // Re-sync the client so a rejected move cannot desync the board.
        if (room.game) {
          send(client, {
            t: 'game.move',
            move: room.game.history[room.game.history.length - 1]?.move ?? msg.move,
            by: room.game.turn,
            state: room.game.toState(),
            clocks: room.clocks(),
            serverNow: Date.now(),
          });
        }
      }
      return;
    }

    case 'game.resign': {
      const room = hub.roomOf(client.user.id);
      if (room) room.resign(client.user.id);
      return;
    }

    case 'game.drawOffer': {
      const room = hub.roomOf(client.user.id);
      if (room) room.offerDraw(client.user.id);
      return;
    }

    case 'game.drawAnswer': {
      const room = hub.roomOf(client.user.id);
      if (room) room.answerDraw(client.user.id, msg.accept === true);
      return;
    }

    case 'chat': {
      const room = hub.roomOf(client.user.id);
      if (!room) return fail(client, 'not-in-room');
      room.addChat(toPublicUser(client.user), msg.text ?? '', msg.emote);
      return;
    }

    case 'queue.join': {
      hub.joinQueue({
        userId: client.user.id,
        rating: client.user.rating,
        config: normaliseConfig(msg.config),
        rated: msg.rated ?? true,
        send: (m) => send(client, m),
      });
      return;
    }

    case 'queue.leave': {
      hub.leaveQueue(client.user.id);
      return;
    }

    default:
      fail(client, 'unknown-message');
  }
}

// Matchmaking hands us a fresh room; seat both players and let it start.
hub.onMatchFound((code, userIds) => {
  const room = hub.roomByCode(code);
  if (!room) return;
  userIds.forEach((userId, i) => {
    const client = byUser.get(userId);
    if (!client) return;
    hub.join(room, participantFor(client), false);
    room.takeSeat(userId, i);
    sendToUser(userId, { t: 'room', room: room.toInfo() });
  });
  for (const seat of room.seats) if (seat.userId) room.setReady(seat.userId, true);
});

// ---------------------------------------------------------------- heartbeats

const heartbeat = setInterval(() => {
  for (const client of clients.values()) {
    if (!client.alive) {
      client.socket.terminate();
      continue;
    }
    client.alive = false;
    try {
      client.socket.ping();
    } catch {
      /* ignore */
    }
  }
}, 30_000);
heartbeat.unref?.();

const housekeeping = setInterval(() => sweep(), 60 * 60 * 1000);
housekeeping.unref?.();

server.listen(config.port, config.host, () => {
  const where = `${config.host}:${config.port}`;
  process.stdout.write(`WallRush server listening on ${where}\n`);
  if (config.staticDir) process.stdout.write(`  serving client from ${config.staticDir}\n`);
});

function shutdown(signal: string): void {
  process.stdout.write(`\nReceived ${signal}, shutting down…\n`);
  clearInterval(heartbeat);
  clearInterval(housekeeping);
  for (const client of clients.values()) {
    try {
      client.socket.close(1001, 'server-restart');
    } catch {
      /* ignore */
    }
  }
  hub.dispose();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export { server, hub };
