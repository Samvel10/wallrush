import { strict as assert } from 'node:assert';
import test, { after, before } from 'node:test';

import { Game, MoveKind, type GameState, type Move } from '@wallrush/shared';

import { TestClient, getJson, postJson, startServer, type TestServer } from './harness.js';

/**
 * The legal step that shortens the route the most. `shortestPath` ignores
 * pawns, so its next cell can be occupied when the two racers meet head-on —
 * the engine expects a jump there, not a walk.
 */
function bestStep(game: Game, seat: number): Move {
  const player = game.players[seat];
  let best = game.pawnMoves(seat)[0];
  let bestDist = Infinity;
  for (const to of game.pawnMoves(seat)) {
    const d = game.distanceToGoal(to.r, to.c, player.side);
    if (d >= 0 && d < bestDist) {
      bestDist = d;
      best = to;
    }
  }
  return { kind: MoveKind.Step, to: best };
}

let server: TestServer;

before(async () => {
  server = await startServer();
});

after(async () => {
  await server.close();
});

// --------------------------------------------------------------------- HTTP

test('health endpoint reports a running server', async () => {
  const { status, body } = await getJson<{ ok: boolean; rooms: number }>(
    server.url,
    '/api/health',
  );
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(typeof body.rooms, 'number');
});

test('registration, login and profile round-trip', async () => {
  const reg = await postJson<{ token: string; user: { name: string; rating: number } }>(
    server.url,
    '/api/auth/register',
    { username: 'anahit', password: 'correct-horse', displayName: 'Անահիտ', lang: 'hy' },
  );
  assert.equal(reg.status, 200);
  assert.equal(reg.body.user.name, 'Անահիտ');
  assert.equal(reg.body.user.rating, 1200);

  const me = await getJson<{ user: { username: string } }>(
    server.url,
    '/api/me',
    reg.body.token,
  );
  assert.equal(me.status, 200);
  assert.equal(me.body.user.username, 'anahit');

  const login = await postJson<{ token: string }>(server.url, '/api/auth/login', {
    username: 'anahit',
    password: 'correct-horse',
  });
  assert.equal(login.status, 200);
  assert.ok(login.body.token.length > 20);
  assert.notEqual(login.body.token, reg.body.token, 'each login issues a fresh token');
});

test('duplicate usernames and weak passwords are rejected', async () => {
  await postJson(server.url, '/api/auth/register', {
    username: 'taken_name',
    password: 'longenough',
  });
  const dup = await postJson<{ error: string }>(server.url, '/api/auth/register', {
    username: 'TAKEN_NAME',
    password: 'longenough',
  });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error, 'username-taken');

  const weak = await postJson<{ error: string }>(server.url, '/api/auth/register', {
    username: 'someone_new',
    password: '123',
  });
  assert.equal(weak.status, 400);
  assert.equal(weak.body.error, 'password-weak');

  const bad = await postJson<{ error: string }>(server.url, '/api/auth/register', {
    username: 'no spaces allowed',
    password: 'longenough',
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'username-invalid');
});

test('a wrong password is rejected', async () => {
  await postJson(server.url, '/api/auth/register', {
    username: 'vahan',
    password: 'the-right-one',
  });
  const res = await postJson<{ error: string }>(server.url, '/api/auth/login', {
    username: 'vahan',
    password: 'the-wrong-one',
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'bad-credentials');
});

test('protected endpoints reject a missing or bogus token', async () => {
  assert.equal((await getJson(server.url, '/api/me')).status, 401);
  assert.equal((await getJson(server.url, '/api/me', 'not.a.token')).status, 401);
  assert.equal((await getJson(server.url, '/api/me/history', 'nope')).status, 401);
});

// ---------------------------------------------------------------- WebSocket

test('a fresh connection is greeted with a guest identity', async () => {
  const client = await TestClient.connect(server.url);
  const welcome = await client.waitFor('welcome');
  assert.ok(welcome.user.id);
  assert.equal(welcome.user.guest, true);
  assert.ok(welcome.user.name.length > 0);
  client.close();
});

test('two players can create, join and finish a game', async () => {
  const host = await TestClient.connect(server.url);
  const guest = await TestClient.connect(server.url);
  await host.waitFor('welcome');
  await guest.waitFor('welcome');

  host.send({
    t: 'room.create',
    visibility: 'private',
    config: { size: 5, players: 2, wallsPerPlayer: 2, clockMs: 0, moveTimeoutMs: 0 },
    rated: false,
  });
  const created = await host.waitFor('room');
  const code = created.room.code;
  assert.equal(created.room.seats.length, 2);
  assert.equal(created.room.seats[0].user?.id !== undefined, true);

  guest.send({ t: 'room.join', code });
  await guest.waitFor('room', (m) => m.room.seats.some((s) => s.user && s.index === 1));

  host.send({ t: 'room.ready', ready: true });
  guest.send({ t: 'room.ready', ready: true });

  const start = await host.waitFor('game.start');
  const guestStart = await guest.waitFor('game.start');
  assert.equal(start.seat, 0);
  assert.equal(guestStart.seat, 1);
  assert.equal(start.state.config.size, 5);

  // Race both pawns straight down the board; seat 0 gets there first.
  const clients = [host, guest];
  let state: GameState = start.state;
  for (let i = 0; i < 40; i++) {
    const game = Game.fromState(state);
    if (game.isOver) break;
    const seat = game.turn;
    const move = bestStep(game, seat);
    clients[seat].send({ t: 'game.move', move, ply: game.ply });
    const echo = await clients[0].waitFor('game.move');
    state = echo.state;
  }

  // Either side may get there first — the pawn that is behind can hop over the
  // one in front and steal a tempo — so assert the shape of the result, not a
  // predetermined winner.
  const over = await host.waitFor('game.over');
  assert.equal(over.ending, 'goal');
  assert.ok(over.winner === 0 || over.winner === 1, 'somebody must win');
  const guestOver = await guest.waitFor('game.over');
  assert.equal(guestOver.winner, over.winner, 'both sides are told the same result');
  assert.equal(Game.fromState(over.state).isOver, true);

  host.close();
  guest.close();
});

test('the server rejects an illegal move and resyncs the client', async () => {
  const host = await TestClient.connect(server.url);
  const guest = await TestClient.connect(server.url);
  await host.waitFor('welcome');
  await guest.waitFor('welcome');

  host.send({
    t: 'room.create',
    visibility: 'private',
    config: { size: 5, players: 2, clockMs: 0, moveTimeoutMs: 0 },
    rated: false,
  });
  const created = await host.waitFor('room');
  guest.send({ t: 'room.join', code: created.room.code });
  await guest.waitFor('room', (m) => m.room.seats[1].user !== null);
  host.send({ t: 'room.ready', ready: true });
  guest.send({ t: 'room.ready', ready: true });
  await host.waitFor('game.start');
  await guest.waitFor('game.start');

  // Teleporting across the board is not a legal step.
  host.send({ t: 'game.move', move: { kind: MoveKind.Step, to: { r: 0, c: 0 } }, ply: 0 });
  const err = await host.waitFor('error');
  assert.equal(err.code, 'blocked');

  // Moving out of turn is refused too.
  guest.send({ t: 'game.move', move: { kind: MoveKind.Step, to: { r: 1, c: 2 } }, ply: 0 });
  const err2 = await guest.waitFor('error');
  assert.equal(err2.code, 'not-your-turn');

  host.close();
  guest.close();
});

test('resigning ends the game for both players', async () => {
  const host = await TestClient.connect(server.url);
  const guest = await TestClient.connect(server.url);
  await host.waitFor('welcome');
  await guest.waitFor('welcome');

  host.send({
    t: 'room.create',
    visibility: 'private',
    config: { size: 5, clockMs: 0, moveTimeoutMs: 0 },
    rated: false,
  });
  const created = await host.waitFor('room');
  guest.send({ t: 'room.join', code: created.room.code });
  await guest.waitFor('room', (m) => m.room.seats[1].user !== null);
  host.send({ t: 'room.ready', ready: true });
  guest.send({ t: 'room.ready', ready: true });
  await host.waitFor('game.start');
  await guest.waitFor('game.start');

  host.send({ t: 'game.resign' });
  const over = await guest.waitFor('game.over');
  assert.equal(over.winner, 1);
  assert.equal(over.ending, 'resign');

  host.close();
  guest.close();
});

test('a draw needs both players to agree', async () => {
  const a = await TestClient.connect(server.url);
  const b = await TestClient.connect(server.url);
  await a.waitFor('welcome');
  await b.waitFor('welcome');

  a.send({
    t: 'room.create',
    visibility: 'private',
    config: { size: 5, clockMs: 0, moveTimeoutMs: 0 },
    rated: false,
  });
  const created = await a.waitFor('room');
  b.send({ t: 'room.join', code: created.room.code });
  await b.waitFor('room', (m) => m.room.seats[1].user !== null);
  a.send({ t: 'room.ready', ready: true });
  b.send({ t: 'room.ready', ready: true });
  await a.waitFor('game.start');
  await b.waitFor('game.start');

  a.send({ t: 'game.drawOffer' });
  const offer = await b.waitFor('game.drawOffer');
  assert.equal(offer.by, 0);

  b.send({ t: 'game.drawAnswer', accept: false });
  await a.waitFor('game.drawDeclined');

  a.send({ t: 'game.drawOffer' });
  await b.waitFor('game.drawOffer');
  b.send({ t: 'game.drawAnswer', accept: true });
  const over = await a.waitFor('game.over');
  assert.equal(over.winner, null);
  assert.equal(over.ending, 'draw');

  a.close();
  b.close();
});

test('a bot fills a seat and plays on its own', async () => {
  const host = await TestClient.connect(server.url);
  await host.waitFor('welcome');
  host.send({
    t: 'room.create',
    visibility: 'private',
    config: { size: 5, wallsPerPlayer: 1, clockMs: 0, moveTimeoutMs: 0 },
    rated: false,
    bots: [{ seat: 1, level: 'easy' }],
  });
  // Seating the host and adding the bot each broadcast a room update, so wait
  // for the one that actually has the bot in it.
  const created = await host.waitFor('room', (m) => m.room.seats[1].bot === 'easy');
  assert.equal(created.room.seats[1].bot, 'easy');

  host.send({ t: 'room.ready', ready: true });
  const start = await host.waitFor('game.start');
  assert.equal(start.state.turn, 0);

  // Play one move and expect the bot's reply without any further prompting.
  const game = Game.fromState(start.state);
  host.send({ t: 'game.move', move: bestStep(game, 0), ply: 0 });
  await host.waitFor('game.move', (m) => m.by === 0);
  const botMove = await host.waitFor('game.move', (m) => m.by === 1, 8000);
  assert.equal(botMove.by, 1);
  const after = Game.fromState(botMove.state);
  assert.equal(after.turn, 0, 'the turn comes back to the human');

  host.close();
});

test('public rooms appear in the lobby, private ones do not', async () => {
  const watcher = await TestClient.connect(server.url);
  const maker = await TestClient.connect(server.url);
  await watcher.waitFor('welcome');
  await maker.waitFor('welcome');

  watcher.send({ t: 'lobby.subscribe' });
  await watcher.waitFor('lobby');

  maker.send({
    t: 'room.create',
    name: 'Open table',
    visibility: 'public',
    config: { size: 9 },
  });
  const created = await maker.waitFor('room');
  const lobby = await watcher.waitFor(
    'lobby',
    (m) => m.rooms.some((r) => r.code === created.room.code),
    6000,
  );
  assert.ok(lobby.rooms.find((r) => r.name === 'Open table'));

  maker.send({ t: 'room.leave' });
  const secret = await TestClient.connect(server.url);
  await secret.waitFor('welcome');
  secret.send({ t: 'room.create', visibility: 'private', config: { size: 9 } });
  const hidden = await secret.waitFor('room');
  const lobby2 = await watcher.waitFor('lobby', undefined, 6000);
  assert.ok(
    !lobby2.rooms.some((r) => r.code === hidden.room.code),
    'a private room must never be listed',
  );

  watcher.close();
  maker.close();
  secret.close();
});

test('joining a nonexistent room fails cleanly', async () => {
  const client = await TestClient.connect(server.url);
  await client.waitFor('welcome');
  client.send({ t: 'room.join', code: 'ZZZZZ' });
  const err = await client.waitFor('error');
  assert.equal(err.code, 'room-not-found');
  client.close();
});

test('only the host can change the setup or add bots', async () => {
  const host = await TestClient.connect(server.url);
  const guest = await TestClient.connect(server.url);
  await host.waitFor('welcome');
  await guest.waitFor('welcome');

  host.send({ t: 'room.create', visibility: 'private', config: { size: 9 } });
  const created = await host.waitFor('room');
  guest.send({ t: 'room.join', code: created.room.code });
  await guest.waitFor('room');
  guest.drain();

  guest.send({ t: 'room.config', config: { size: 5 } });
  const err = await guest.waitFor('error');
  assert.equal(err.code, 'not-host');

  host.close();
  guest.close();
});

test('chat is delivered to everyone in the room and trimmed', async () => {
  const a = await TestClient.connect(server.url);
  const b = await TestClient.connect(server.url);
  await a.waitFor('welcome');
  await b.waitFor('welcome');
  a.send({ t: 'room.create', visibility: 'private', config: { size: 9 } });
  const created = await a.waitFor('room');
  b.send({ t: 'room.join', code: created.room.code });
  await b.waitFor('room');

  a.send({ t: 'chat', text: '   բարև    բոլորին   ' });
  const line = await b.waitFor('chat');
  assert.equal(line.line.text, 'բարև բոլորին');

  a.send({ t: 'chat', text: 'x'.repeat(500) });
  const long = await b.waitFor('chat');
  assert.ok(long.line.text.length <= 240, 'chat is capped');

  a.close();
  b.close();
});

test('matchmaking pairs two waiting players', async () => {
  const a = await TestClient.connect(server.url);
  const b = await TestClient.connect(server.url);
  await a.waitFor('welcome');
  await b.waitFor('welcome');

  const config = { size: 9 as const, players: 2 as const, clockMs: 60_000, incrementMs: 1000 };
  a.send({ t: 'queue.join', config, rated: false });
  b.send({ t: 'queue.join', config, rated: false });

  const roomA = await a.waitFor('room', undefined, 8000);
  const roomB = await b.waitFor('room', undefined, 8000);
  assert.equal(roomA.room.code, roomB.room.code);
  const startA = await a.waitFor('game.start', undefined, 8000);
  assert.notEqual(startA.seat, null);

  a.close();
  b.close();
});

test('a rated game between two accounts moves both ratings', async () => {
  const one = await postJson<{ token: string; user: { id: string } }>(
    server.url,
    '/api/auth/register',
    { username: 'rated_one', password: 'password123' },
  );
  const two = await postJson<{ token: string; user: { id: string } }>(
    server.url,
    '/api/auth/register',
    { username: 'rated_two', password: 'password123' },
  );

  const a = await TestClient.connect(server.url, one.body.token);
  const b = await TestClient.connect(server.url, two.body.token);
  await a.waitFor('welcome');
  await b.waitFor('welcome');

  a.send({
    t: 'room.create',
    visibility: 'private',
    config: { size: 5, wallsPerPlayer: 0, clockMs: 0, moveTimeoutMs: 0 },
    rated: true,
  });
  const created = await a.waitFor('room');
  b.send({ t: 'room.join', code: created.room.code });
  await b.waitFor('room', (m) => m.room.seats[1].user !== null);
  a.send({ t: 'room.ready', ready: true });
  b.send({ t: 'room.ready', ready: true });
  const start = await a.waitFor('game.start');
  await b.waitFor('game.start');

  const clients = [a, b];
  let state: GameState = start.state;
  for (let i = 0; i < 30; i++) {
    const game = Game.fromState(state);
    if (game.isOver) break;
    const seat = game.turn;
    clients[seat].send({ t: 'game.move', move: bestStep(game, seat), ply: game.ply });
    state = (await a.waitFor('game.move')).state;
  }

  const over = await a.waitFor('game.over');
  assert.equal(over.ending, 'goal');
  assert.ok(over.ratings && over.ratings.length === 2, 'both ratings are reported');
  const winnerId = over.winner === 0 ? one.body.user.id : two.body.user.id;
  const loserId = over.winner === 0 ? two.body.user.id : one.body.user.id;
  const winner = over.ratings!.find((r) => r.userId === winnerId)!;
  const loser = over.ratings!.find((r) => r.userId === loserId)!;
  assert.ok(winner.delta > 0, `winner should gain, got ${winner.delta}`);
  assert.ok(loser.delta < 0, `loser should lose, got ${loser.delta}`);
  assert.equal(winner.after, winner.before + winner.delta);

  // The result is persisted and visible in the history endpoint.
  const winnerToken = over.winner === 0 ? one.body.token : two.body.token;
  const history = await getJson<{ matches: { result: string; rated: boolean }[] }>(
    server.url,
    '/api/me/history',
    winnerToken,
  );
  assert.equal(history.status, 200);
  assert.equal(history.body.matches[0].result, 'win');
  assert.equal(history.body.matches[0].rated, true);

  const board = await getJson<{ players: { name: string }[] }>(
    server.url,
    '/api/leaderboard',
  );
  assert.equal(board.status, 200);

  a.close();
  b.close();
});

test('an unrated game still updates the win/loss record', async () => {
  const acc = await postJson<{ token: string; user: { id: string } }>(
    server.url,
    '/api/auth/register',
    { username: 'record_keeper', password: 'password123' },
  );
  const a = await TestClient.connect(server.url, acc.body.token);
  await a.waitFor('welcome');

  a.send({
    t: 'room.create',
    visibility: 'private',
    config: { size: 5, wallsPerPlayer: 0, clockMs: 0, moveTimeoutMs: 0 },
    rated: false,
    bots: [{ seat: 1, level: 'novice' }],
  });
  await a.waitFor('room', (m) => m.room.seats[1].bot === 'novice');
  a.send({ t: 'room.ready', ready: true });
  const start = await a.waitFor('game.start');

  let state = start.state;
  for (let i = 0; i < 40; i++) {
    const game = Game.fromState(state);
    if (game.isOver) break;
    if (game.turn === 0) a.send({ t: 'game.move', move: bestStep(game, 0), ply: game.ply });
    const echo = await a.waitFor('game.move', undefined, 9000);
    state = echo.state;
  }
  await a.waitFor('game.over', undefined, 9000);

  const me = await getJson<{ user: { games: number; wins: number; losses: number } }>(
    server.url,
    '/api/me',
    acc.body.token,
  );
  assert.equal(me.body.user.games, 1, 'the game must be counted even when unrated');
  assert.equal(me.body.user.wins + me.body.user.losses, 1);

  a.close();
});

test('a malformed message does not take the connection down', async () => {
  const client = await TestClient.connect(server.url);
  await client.waitFor('welcome');
  // @ts-expect-error deliberately invalid payload
  client.send({ t: 'nonsense', foo: 1 });
  const err = await client.waitFor('error');
  assert.equal(err.code, 'unknown-message');
  // The socket is still usable afterwards.
  client.send({ t: 'ping', at: 123 });
  const pong = await client.waitFor('pong');
  assert.equal(pong.at, 123);
  client.close();
});

test('a flood of messages is rate limited rather than accepted', async () => {
  const client = await TestClient.connect(server.url);
  await client.waitFor('welcome');
  for (let i = 0; i < 80; i++) client.send({ t: 'ping', at: i });
  const err = await client.waitFor('error');
  assert.equal(err.code, 'rate-limited');
  client.close();
});
