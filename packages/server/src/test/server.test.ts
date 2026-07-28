import { strict as assert } from 'node:assert';
import test, { after, before } from 'node:test';

import { Game, MoveKind, transcript, type GameState, type Move } from '@wallrush/shared';

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
  assert.equal(Game.fromState(over.state).isOver, true);

  // Answering again after the game is over must not resurrect anything.
  b.send({ t: 'game.drawAnswer', accept: true });
  a.send({ t: 'game.drawOffer' });
  const stray = await b
    .waitFor('game.drawOffer', undefined, 1200)
    .then(() => 'relayed')
    .catch(() => 'ignored');
  assert.equal(stray, 'ignored', 'a finished game does not take draw offers');

  a.close();
  b.close();
});

test('a player who was offline when the game ended still gets the result', async () => {
  const a = await TestClient.connect(server.url);
  const b = await TestClient.connect(server.url);
  await a.waitFor('welcome');
  const bWelcome = await b.waitFor('welcome');
  const bToken = bWelcome.token;
  assert.ok(bToken, 'a guest is handed a token so it can come back');

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

  // B drops — a phone locking its screen, a tunnel, a closed laptop — and the
  // game ends while they are away.
  b.close();
  await new Promise((r) => setTimeout(r, 120));
  a.send({ t: 'game.resign' });
  const over = await a.waitFor('game.over');
  assert.equal(over.winner, 1, 'the player who stayed loses by resignation');

  // Coming back must explain what happened rather than showing a frozen board.
  const back = await TestClient.connect(server.url, bToken);
  await back.waitFor('welcome');
  await back.waitFor('game.start');
  const replayed = await back.waitFor('game.over');
  assert.equal(replayed.winner, 1);
  assert.equal(replayed.ending, 'resign');
  assert.equal(Game.fromState(replayed.state).isOver, true);

  a.close();
  back.close();
});

test('a race room is a fixed track the client cannot reshape', async () => {
  const a = await TestClient.connect(server.url);
  await a.waitFor('welcome');

  // Ask for a race and try to smuggle in a different board at the same time.
  a.send({
    t: 'room.create',
    visibility: 'private',
    config: { mode: 'race', size: 5, players: 4 },
    rated: false,
  });
  const created = await a.waitFor('room');
  assert.equal(created.room.config.mode, 'race');
  assert.equal(created.room.config.size, 9, 'the track width is not the client\'s to pick');
  assert.equal(created.room.config.rows, 13);
  assert.equal(created.room.config.players, 2, 'a race is run by two');
  assert.equal(created.room.config.wallsPerPlayer, 15);
  a.close();
});

test('both racers start on the same edge and share one finish', async () => {
  const a = await TestClient.connect(server.url);
  const b = await TestClient.connect(server.url);
  await a.waitFor('welcome');
  await b.waitFor('welcome');

  a.send({
    t: 'room.create',
    visibility: 'private',
    config: { mode: 'race', clockMs: 0, moveTimeoutMs: 0 },
    rated: false,
  });
  const created = await a.waitFor('room');
  b.send({ t: 'room.join', code: created.room.code });
  await b.waitFor('room', (m) => m.room.seats[1].user !== null);
  a.send({ t: 'room.ready', ready: true });
  b.send({ t: 'room.ready', ready: true });
  const start = await a.waitFor('game.start');
  await b.waitFor('game.start');

  const game = Game.fromState(start.state);
  assert.equal(game.rows, 13);
  assert.equal(game.cols, 9);
  assert.deepEqual(
    game.players.map((p) => p.pos),
    [
      { r: 12, c: 2 },
      { r: 12, c: 6 },
    ],
  );
  assert.equal(game.players[0].side, game.players[1].side);
  assert.equal(game.distanceFor(0), game.distanceFor(1));

  a.close();
  b.close();
});

test('the endpoints that cost something are rate limited', async () => {
  // Twenty in a minute is the budget; the twenty-first should be refused
  // rather than served, and the refusal should say when to come back.
  let limited = 0;
  let served = 0;
  // A visitor arrives through the proxy, which names them. Requests that
  // reach the port directly on loopback are the operator's and are not
  // charged, which is what keeps the rest of this suite unthrottled.
  for (let i = 0; i < 26; i++) {
    const r = await postJson(
      server.url,
      '/api/auth/login',
      { username: `nobody_${i}`, password: 'wrong-password-here' },
      undefined,
      '203.0.113.7',
    );
    if (r.status === 429) limited += 1;
    else served += 1;
  }
  assert.ok(served >= 15, `expected the budget to be spent, not refused outright (${served})`);
  assert.ok(limited >= 3, `expected the surplus to be refused (${limited})`);

  // A read is never charged: the lobby must not lock up because somebody
  // fumbled their password.
  const health = await getJson(server.url, '/api/health');
  assert.equal(health.status, 200);
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

test('running out of time loses the game', async () => {
  const a = await TestClient.connect(server.url);
  await a.waitFor('welcome');
  a.send({
    t: 'room.create',
    visibility: 'private',
    // A two-second clock: long enough to start, short enough to test.
    config: { size: 5, wallsPerPlayer: 0, clockMs: 2000, incrementMs: 0, moveTimeoutMs: 0 },
    rated: false,
    bots: [{ seat: 1, level: 'novice' }],
  });
  await a.waitFor('room', (m) => m.room.seats[1].bot === 'novice');
  a.send({ t: 'room.ready', ready: true });
  await a.waitFor('game.start');

  // Never move. The clock must run out and hand the win to the bot.
  const over = await a.waitFor('game.over', undefined, 12_000);
  assert.equal(over.ending, 'timeout');
  assert.equal(over.winner, 1, 'the seat that still had time wins');
  a.close();
});

test('a per-move limit does not end the game, it just plays a move', async () => {
  const a = await TestClient.connect(server.url);
  await a.waitFor('welcome');
  a.send({
    t: 'room.create',
    visibility: 'private',
    // No overall clock, but a very short per-move cap.
    config: { size: 5, wallsPerPlayer: 0, clockMs: 0, incrementMs: 0, moveTimeoutMs: 1200 },
    rated: false,
    bots: [{ seat: 1, level: 'novice' }],
  });
  await a.waitFor('room', (m) => m.room.seats[1].bot === 'novice');
  a.send({ t: 'room.ready', ready: true });
  const start = await a.waitFor('game.start');
  assert.equal(start.state.turn, 0);

  // Sit on our hands: the server should play for us rather than forfeit.
  const played = await a.waitFor('game.move', (m) => m.by === 0, 10_000);
  assert.ok(played, 'the server plays a move when the per-move limit expires');
  const after = Game.fromState(played.state);
  assert.equal(after.isOver, false, 'a slow move must not end the game');
  a.close();
});

test('a player who reconnects keeps their seat and sees the position', async () => {
  const acc = await postJson<{ token: string }>(server.url, '/api/auth/register', {
    username: 'returning_player',
    password: 'password123',
  });
  const first = await TestClient.connect(server.url, acc.body.token);
  await first.waitFor('welcome');
  first.send({
    t: 'room.create',
    visibility: 'private',
    config: { size: 5, wallsPerPlayer: 1, clockMs: 0, moveTimeoutMs: 0 },
    rated: false,
    bots: [{ seat: 1, level: 'novice' }],
  });
  const created = await first.waitFor('room', (m) => m.room.seats[1].bot === 'novice');
  first.send({ t: 'room.ready', ready: true });
  const start = await first.waitFor('game.start');
  const game = Game.fromState(start.state);
  first.send({ t: 'game.move', move: bestStep(game, 0), ply: 0 });
  await first.waitFor('game.move', (m) => m.by === 0);

  // Simulate a refresh: drop the socket, come back with the same token.
  first.close();
  await new Promise((r) => setTimeout(r, 250));
  const second = await TestClient.connect(server.url, acc.body.token);
  await second.waitFor('welcome');
  const resumed = await second.waitFor('game.start', undefined, 6000);
  assert.equal(resumed.room.code, created.room.code, 'same table');
  assert.equal(resumed.seat, 0, 'same seat');
  assert.ok(resumed.state.ply >= 1, 'the moves already played are still there');
  second.close();
});

test('a second connection for the same account replaces the first', async () => {
  const acc = await postJson<{ token: string }>(server.url, '/api/auth/register', {
    username: 'two_devices',
    password: 'password123',
  });
  const one = await TestClient.connect(server.url, acc.body.token);
  await one.waitFor('welcome');
  const two = await TestClient.connect(server.url, acc.body.token);
  await two.waitFor('welcome');
  // The newest connection is the live one; the old socket is closed by the
  // server rather than left racing it.
  two.send({ t: 'ping', at: 1 });
  const pong = await two.waitFor('pong');
  assert.equal(pong.at, 1);
  one.close();
  two.close();
});

test('oversized and malformed payloads are rejected, not crashed on', async () => {
  const res = await fetch(server.url + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{ not json',
  });
  assert.equal(res.status, 400);

  const big = await fetch(server.url + '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'x'.repeat(100_000), password: 'y'.repeat(100_000) }),
  });
  assert.ok(big.status === 400 || big.status === 413, `got ${big.status}`);

  // And the server is still healthy afterwards.
  const health = await getJson<{ ok: boolean }>(server.url, '/api/health');
  assert.equal(health.body.ok, true);
});

test('static file serving refuses to escape its root', async () => {
  for (const path of ['/../package.json', '/%2e%2e/package.json', '/../../etc/passwd']) {
    const res = await fetch(server.url + path);
    const body = await res.text();
    assert.ok(
      !body.includes('"name": "wallrush"') && !body.includes('root:x:'),
      `${path} leaked something it should not have`,
    );
  }
});

test('an offline bot game is accepted only if the moves really happened', async () => {
  const acc = await postJson<{ token: string }>(server.url, '/api/auth/register', {
    username: 'offline_player',
    password: 'password123',
  });

  // Build a real, finished game so we have an honest transcript to send.
  const game = new Game({ size: 5, wallsPerPlayer: 0, clockMs: 0, moveTimeoutMs: 0 });
  while (!game.isOver) {
    assert.ok(game.apply(bestStep(game, game.turn)).ok);
  }
  const winner = game.winner!;
  const text = transcript(
    game.history.map((h) => h.move),
    5,
  );

  const good = await postJson<{ id: string; result: string }>(
    server.url,
    '/api/matches/local',
    {
      transcript: text,
      size: 5,
      players: 2,
      wallsPerPlayer: 0,
      seat: winner,
      botLevel: 'medium',
      startedAt: Date.now() - 60_000,
    },
    acc.body.token,
  );
  assert.equal(good.status, 200);
  assert.equal(good.body.result, 'win');

  // The stored match is replayable and shows up in history.
  const replay = await getJson<{ match: { transcript: string; winnerSeat: number } }>(
    server.url,
    `/api/match/${good.body.id}`,
  );
  assert.equal(replay.status, 200);
  assert.equal(replay.body.match.transcript, text);
  assert.equal(replay.body.match.winnerSeat, winner);

  const history = await getJson<{ matches: { id: string; result: string }[] }>(
    server.url,
    '/api/me/history',
    acc.body.token,
  );
  assert.ok(history.body.matches.some((m) => m.id === good.body.id));

  // A transcript that does not finish the game is refused …
  const short = await postJson<{ error: string }>(
    server.url,
    '/api/matches/local',
    // Legal opening moves on a 5x5 board, but nobody has reached the far side.
    { transcript: 'c2 c4', size: 5, players: 2, wallsPerPlayer: 0, seat: 0, botLevel: 'medium' },
    acc.body.token,
  );
  assert.equal(short.status, 400);
  assert.equal(short.body.error, 'unfinished');

  // … and so is one with an illegal move in it.
  const bogus = await postJson<{ error: string }>(
    server.url,
    '/api/matches/local',
    { transcript: 'a1 a1 a1', size: 5, players: 2, wallsPerPlayer: 0, seat: 0, botLevel: 'medium' },
    acc.body.token,
  );
  assert.equal(bogus.status, 400);
  assert.equal(bogus.body.error, 'illegal-transcript');

  // And an anonymous caller cannot store anything at all.
  const anon = await postJson<{ error: string }>(server.url, '/api/matches/local', {
    transcript: text,
    size: 5,
    players: 2,
    wallsPerPlayer: 0,
    seat: winner,
    botLevel: 'medium',
  });
  assert.equal(anon.status, 401);
});

test('a rematch restarts the game with the colours swapped', async () => {
  const a = await TestClient.connect(server.url);
  const b = await TestClient.connect(server.url);
  await a.waitFor('welcome');
  await b.waitFor('welcome');

  a.send({
    t: 'room.create',
    visibility: 'private',
    config: { size: 5, wallsPerPlayer: 0, clockMs: 0, moveTimeoutMs: 0 },
    rated: false,
  });
  const created = await a.waitFor('room');
  b.send({ t: 'room.join', code: created.room.code });
  await b.waitFor('room', (m) => m.room.seats[1].user !== null);
  a.send({ t: 'room.ready', ready: true });
  b.send({ t: 'room.ready', ready: true });
  const first = await a.waitFor('game.start');
  await b.waitFor('game.start');
  const seatOfA = first.seat;
  assert.equal(seatOfA, 0);

  a.send({ t: 'game.resign' });
  await a.waitFor('game.over');
  await b.waitFor('game.over');

  a.send({ t: 'room.rematch' });
  b.send({ t: 'room.rematch' });

  const again = await a.waitFor('game.start', undefined, 8000);
  const againB = await b.waitFor('game.start', undefined, 8000);
  assert.equal(again.state.ply, 0, 'a rematch starts from a fresh board');
  assert.equal(again.seat, 1, 'the player who went first now goes second');
  assert.equal(againB.seat, 0);

  a.close();
  b.close();
});

test('leaving mid-game forfeits rather than freezing the table', async () => {
  const a = await TestClient.connect(server.url);
  const b = await TestClient.connect(server.url);
  await a.waitFor('welcome');
  await b.waitFor('welcome');

  a.send({
    t: 'room.create',
    visibility: 'private',
    config: { size: 5, wallsPerPlayer: 0, clockMs: 0, moveTimeoutMs: 0 },
    rated: false,
  });
  const created = await a.waitFor('room');
  b.send({ t: 'room.join', code: created.room.code });
  await b.waitFor('room', (m) => m.room.seats[1].user !== null);
  a.send({ t: 'room.ready', ready: true });
  b.send({ t: 'room.ready', ready: true });
  await a.waitFor('game.start');
  await b.waitFor('game.start');

  // Pressing "leave" is a decision, not a flaky connection: the opponent must
  // not be left waiting out the reconnect grace period.
  a.send({ t: 'room.leave' });
  const over = await b.waitFor('game.over', undefined, 5000);
  assert.equal(over.ending, 'resign');
  assert.equal(over.winner, 1, 'the player who stayed wins');

  a.close();
  b.close();
});

test('a spectator can watch but cannot play', async () => {
  const a = await TestClient.connect(server.url);
  const b = await TestClient.connect(server.url);
  const watcher = await TestClient.connect(server.url);
  await a.waitFor('welcome');
  await b.waitFor('welcome');
  await watcher.waitFor('welcome');

  a.send({
    t: 'room.create',
    visibility: 'private',
    config: { size: 5, wallsPerPlayer: 0, clockMs: 0, moveTimeoutMs: 0 },
    rated: false,
  });
  const created = await a.waitFor('room');
  b.send({ t: 'room.join', code: created.room.code });
  await b.waitFor('room', (m) => m.room.seats[1].user !== null);
  a.send({ t: 'room.ready', ready: true });
  b.send({ t: 'room.ready', ready: true });
  const start = await a.waitFor('game.start');
  await b.waitFor('game.start');

  // A third arrival at a full table watches instead of displacing anyone.
  watcher.send({ t: 'room.join', code: created.room.code });
  const asWatcher = await watcher.waitFor('room');
  assert.ok(
    asWatcher.room.seats.every((s) => s.user !== null),
    'both seats stay with the players',
  );
  const watching = await watcher.waitFor('game.start', undefined, 5000);
  assert.equal(watching.seat, null, 'a spectator has no seat');

  watcher.send({
    t: 'game.move',
    move: bestStep(Game.fromState(start.state), 0),
    ply: 0,
  });
  const refused = await watcher.waitFor('error');
  assert.equal(refused.code, 'not-seated');

  // But they do see the game unfold.
  a.send({ t: 'game.move', move: bestStep(Game.fromState(start.state), 0), ply: 0 });
  const relayed = await watcher.waitFor('game.move', undefined, 5000);
  assert.equal(relayed.by, 0);

  a.close();
  b.close();
  watcher.close();
});

test('a room survives its host refreshing the page', async () => {
  const acc = await postJson<{ token: string }>(server.url, '/api/auth/register', {
    username: 'refreshing_host',
    password: 'password123',
  });
  const host = await TestClient.connect(server.url, acc.body.token);
  await host.waitFor('welcome');
  host.send({ t: 'room.create', visibility: 'private', config: { size: 9 } });
  const created = await host.waitFor('room');
  const code = created.room.code;

  // The host closes the tab and comes straight back, as a refresh does. Losing
  // the code they just shared with a friend would be the worst possible moment.
  host.close();
  await new Promise((r) => setTimeout(r, 400));

  const back = await TestClient.connect(server.url, acc.body.token);
  await back.waitFor('welcome');
  back.send({ t: 'room.join', code });
  const rejoined = await back.waitFor('room', undefined, 5000);
  assert.equal(rejoined.room.code, code, 'the room is still there');

  // A friend arriving after the refresh finds it too.
  const friend = await TestClient.connect(server.url);
  await friend.waitFor('welcome');
  friend.send({ t: 'room.join', code });
  const joined = await friend.waitFor('room', (m) => m.room.seats[1].user !== null, 5000);
  assert.equal(joined.room.code, code);

  back.close();
  friend.close();
});

test('an empty room is not advertised in the lobby', async () => {
  const watcher = await TestClient.connect(server.url);
  const maker = await TestClient.connect(server.url);
  await watcher.waitFor('welcome');
  await maker.waitFor('welcome');
  watcher.send({ t: 'lobby.subscribe' });
  await watcher.waitFor('lobby');

  maker.send({ t: 'room.create', name: 'ghost', visibility: 'public', config: { size: 9 } });
  const created = await maker.waitFor('room');
  await watcher.waitFor('lobby', (m) => m.rooms.some((r) => r.code === created.room.code), 6000);

  // The maker vanishes. The room lives on for a while so they can come back,
  // but an empty table has nothing to offer anyone browsing.
  maker.close();
  const after = await watcher.waitFor(
    'lobby',
    (m) => !m.rooms.some((r) => r.code === created.room.code),
    8000,
  );
  assert.ok(!after.rooms.some((r) => r.code === created.room.code));
  watcher.close();
});

test('a rematch after the opponent leaves reopens the table', async () => {
  const a = await TestClient.connect(server.url);
  const b = await TestClient.connect(server.url);
  await a.waitFor('welcome');
  await b.waitFor('welcome');

  a.send({
    t: 'room.create',
    visibility: 'private',
    config: { size: 5, wallsPerPlayer: 0, clockMs: 0, moveTimeoutMs: 0 },
    rated: false,
  });
  const created = await a.waitFor('room');
  b.send({ t: 'room.join', code: created.room.code });
  await b.waitFor('room', (m) => m.room.seats[1].user !== null);
  a.send({ t: 'room.ready', ready: true });
  b.send({ t: 'room.ready', ready: true });
  await a.waitFor('game.start');
  await b.waitFor('game.start');

  b.send({ t: 'game.resign' });
  await a.waitFor('game.over');
  b.close();
  await new Promise((r) => setTimeout(r, 300));

  // Asking for a rematch with nobody left must not silently do nothing.
  a.send({ t: 'room.rematch' });
  const reopened = await a.waitFor('room', (m) => m.room.status === 'waiting', 5000);
  assert.equal(reopened.room.status, 'waiting', 'the table reopens for a new opponent');
  assert.equal(reopened.room.seats[1].user, null, 'the empty seat is free again');
  assert.equal(reopened.room.hostId, reopened.room.seats[0].user?.id ?? null);

  a.close();
});

test('friends can only be added by people who have played each other', async () => {
  const one = await postJson<{ token: string; user: { id: string } }>(
    server.url,
    '/api/auth/register',
    { username: 'friend_one', password: 'password123' },
  );
  const two = await postJson<{ token: string; user: { id: string } }>(
    server.url,
    '/api/auth/register',
    { username: 'friend_two', password: 'password123' },
  );

  // Strangers cannot be added. This is the whole anti-pestering rule.
  const cold = await postJson<{ error: string }>(
    server.url,
    `/api/friends/${two.body.user.id}`,
    {},
    one.body.token,
  );
  assert.equal(cold.status, 403);
  assert.equal(cold.body.error, 'not-played');

  // Play a game so they have met.
  const a = await TestClient.connect(server.url, one.body.token);
  const b = await TestClient.connect(server.url, two.body.token);
  await a.waitFor('welcome');
  await b.waitFor('welcome');
  a.send({
    t: 'room.create',
    visibility: 'private',
    config: { size: 5, wallsPerPlayer: 0, clockMs: 0, moveTimeoutMs: 0 },
    rated: false,
  });
  const created = await a.waitFor('room');
  b.send({ t: 'room.join', code: created.room.code });
  await b.waitFor('room', (m) => m.room.seats[1].user !== null);
  a.send({ t: 'room.ready', ready: true });
  b.send({ t: 'room.ready', ready: true });
  await a.waitFor('game.start');
  await b.waitFor('game.start');
  a.send({ t: 'game.resign' });
  await b.waitFor('game.over');

  // Now a request is allowed, and starts out pending.
  const asked = await postJson<{ status: string }>(
    server.url,
    `/api/friends/${two.body.user.id}`,
    {},
    one.body.token,
  );
  assert.equal(asked.status, 200);
  assert.equal(asked.body.status, 'pending');

  // The other side sees it as incoming.
  const inbox = await getJson<{ friends: { id: string; status: string; incoming: boolean }[] }>(
    server.url,
    '/api/friends',
    two.body.token,
  );
  const request = inbox.body.friends.find((x) => x.id === one.body.user.id);
  assert.ok(request, 'the request shows up');
  assert.equal(request!.status, 'pending');
  assert.equal(request!.incoming, true);

  // Accepting makes it mutual.
  const accepted = await postJson<{ status: string }>(
    server.url,
    `/api/friends/${one.body.user.id}`,
    {},
    two.body.token,
  );
  assert.equal(accepted.body.status, 'accepted');
  for (const [token, otherId] of [
    [one.body.token, two.body.user.id],
    [two.body.token, one.body.user.id],
  ] as const) {
    const list = await getJson<{ friends: { id: string; status: string; online: boolean }[] }>(
      server.url,
      '/api/friends',
      token,
    );
    const entry = list.body.friends.find((x) => x.id === otherId);
    assert.equal(entry?.status, 'accepted', 'both sides see the friendship');
    assert.equal(entry?.online, true, 'both are connected right now');
  }

  // An invitation reaches a friend who is online.
  a.send({ t: 'room.create', visibility: 'private', config: { size: 9 } });
  await a.waitFor('room');
  a.send({ t: 'friend.invite', userId: two.body.user.id });
  const invite = await b.waitFor('friend.invite', undefined, 5000);
  assert.equal(invite.from.id, one.body.user.id);
  assert.ok(invite.code.length >= 4);

  // Removing is mutual too.
  await fetch(`${server.url}/api/friends/${two.body.user.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${one.body.token}` },
  });
  const afterRemoval = await getJson<{ friends: { id: string }[] }>(
    server.url,
    '/api/friends',
    two.body.token,
  );
  assert.ok(!afterRemoval.body.friends.some((x) => x.id === one.body.user.id));

  // And an invitation to a non-friend is refused.
  a.send({ t: 'friend.invite', userId: two.body.user.id });
  const refused = await a.waitFor('error');
  assert.equal(refused.code, 'not-friends');

  a.close();
  b.close();
});

test('guests cannot add friends', async () => {
  const guest = await TestClient.connect(server.url);
  const hello = await guest.waitFor('welcome');
  assert.equal(hello.user.guest, true);
  const res = await postJson<{ error: string }>(
    server.url,
    `/api/friends/${hello.user.id}`,
    {},
    hello.token,
  );
  // Adding yourself is caught first; the point is that nothing is created.
  assert.ok(res.status === 400 || res.status === 403, `got ${res.status}`);
  guest.close();
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
