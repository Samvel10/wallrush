# Architecture

> Ճարտարապետությունը՝ ինչո՞ւ հենց այսպես։

## The shape of it

```
┌──────────────────────────── browser ────────────────────────────┐
│  React app                                                      │
│    ├── screens/        home, lobby, room, game, profile, rules   │
│    ├── components/     Board, GameView, HUD, ui primitives       │
│    ├── state/          router, session, settings, sound          │
│    ├── net/            REST client + reconnecting WebSocket      │
│    └── worker/         bot.worker.ts  ← runs the engine off-main │
│                                                                  │
│  @wallrush/shared  (the very same engine the server runs)        │
└────────────────────────────┬────────────────────────────────────┘
                             │ JSON over WebSocket  +  REST
┌────────────────────────────┴────────────────────────────────────┐
│  Node process                                                    │
│    ├── http.ts     JSON API + static client (SPA fallback)       │
│    ├── index.ts    WebSocket dispatch, heartbeats, shutdown      │
│    ├── hub.ts      room registry, lobby feed, matchmaking queue  │
│    ├── room.ts     one table: seats, clocks, bots, chat, Elo     │
│    ├── auth.ts     scrypt passwords, HMAC tokens, guest identity │
│    └── db.ts       node:sqlite — users, matches, sessions        │
└──────────────────────────────────────────────────────────────────┘
```

## Decisions and why

### One engine, two runtimes

`packages/shared` has no dependencies and no environment assumptions, so the
identical `Game` class enforces the rules in the browser and on the server.
There is no second implementation to drift, and the client can validate a move
before sending it — which is what makes optimistic updates safe.

### The server is authoritative, the client is optimistic

A client applies its own move immediately and sends it. The server validates
against the engine and broadcasts the resulting state to everyone. If a move is
rejected, the server's next broadcast overwrites the optimistic board, so a bad
guess costs a frame rather than desyncing the game. This is why moves feel
instant on a slow connection without opening the door to cheating.

### `node:sqlite` instead of a database server

Node 22 ships SQLite in core. That removes a native build step (`better-sqlite3`
needs a compiler or prebuilds), removes an operational dependency, and means the
whole product is one process and one file — which is what "free to host" really
requires. WAL mode keeps reads from blocking the game loop.

### No authentication library

Passwords use `scrypt` from `node:crypto` (memory-hard, in core). Sessions are
`base64url(payload).base64url(hmac)` verified with `timingSafeEqual`, plus a
server-side session row so tokens can be revoked. The signing key is generated
on first boot and persisted next to the database, so a restart does not log
everyone out and there is no insecure default to forget about.

### Guests are first-class

Every connection gets an identity immediately, with no sign-up. Registering
later *upgrades that same row* rather than creating a new one, so a guest's
games, streak and rating survive the transition. Accounts exist to persist
history, not to gate play.

### The bot runs in a Web Worker

Solo play never touches the server: no load, no latency, and it works with the
network off. The worker also keeps a three-second Master-level search from
janking the board. If workers are unavailable the hook falls back to the main
thread rather than failing.

### Percentage geometry instead of canvas

The board is absolutely-positioned percentages inside an `aspect-ratio: 1`
container. Consequences: it is resolution independent with no resize listeners,
every cell and wall is a real DOM node (so it is focusable, labelled and
screen-reader visible), and CSS transitions animate the pieces for free.

The one thing this makes hard is hit targets: the wall gap is 20 % of a cell,
roughly 7 px on a phone. So each wall slot has a touch target grown by 0.42 of a
cell perpendicular to the wall, while the *visible* bar stays slim inside it —
and at rest it is a short pip rather than the full two-cell bar, because
adjacent slots overlap and a row of full-length bars is unreadable.

## Data model

```sql
users          id, username, display_name, password_hash, avatar,
               rating, games, wins, losses, draws, streak, best_streak,
               lang, created_at, last_seen, guest

matches        id, mode, size, seats, rated, winner_seat, ending,
               transcript, config_json, players_json,
               started_at, finished_at, plies

match_players  match_id, user_id, seat, result,
               rating_before, rating_after, bot_level

sessions       token, user_id, created_at, expires_at
```

`transcript` stores the whole game in standard notation, so any match can be
replayed from the database without storing per-move rows.

## The realtime protocol

One WebSocket per client, JSON messages with a short `t` discriminator. The
full set lives in `packages/shared/src/protocol.ts` and is shared by both sides,
so an unhandled message type is a compile error rather than a runtime surprise.

Reconnection matters more than usual on mobile: phones suspend sockets when the
screen locks. The client reconnects with jittered exponential backoff and also
on `visibilitychange` and `online`; the server keeps a disconnected player's
seat warm for a grace period (default 45 s) before forfeiting.

## The bot

Negamax with alpha–beta, iterative deepening, a Zobrist transposition table,
killer moves and late-move reductions. Evaluation is dominated by the race —
the difference between my shortest route and my nearest rival's — with walls in
hand, board progress and centre control as tie-breakers.

The expensive part of Quoridor search is the branching factor: ~128 wall
placements plus a handful of steps, and every wall needs a path check per player
to prove it is legal. Two things make it tractable:

1. **Relevance filtering.** Only walls touching a pawn's neighbourhood or lying
   across somebody's current shortest route are considered at all.
2. **Breadth budgeting.** The root gets the full candidate set; the first
   replies get most of it; the deep tail gets a handful.

Difficulty is not a crippled search. Each level is a differently *shaped*
player: horizon, how many wall ideas it entertains, how often it deliberately
plays the second- or third-best move, and how willing it is to spend a wall at
all. That keeps a beginner bot beatable without making it feel broken.

| Level | Depth | Budget | Deliberate error rate |
|---|---|---|---|
| novice | 1 | 60 ms | 55 % |
| easy | 2 | 150 ms | 30 % |
| medium | 4 | 400 ms | 12 % |
| hard | 6 | 900 ms | 3.5 % |
| expert | 13 | 1.8 s | 0 |
| master | 20 | 3.0 s | 0 |

## Testing strategy

- **Engine** — rules, jumps, wall legality, the "cannot seal anyone in" rule,
  make/unmake symmetry, serialisation round-trips, and randomised games that
  assert every player always retains a route.
- **Bot** — legality under long games, tactical positions with a known correct
  answer, time-budget compliance, determinism under a fixed seed, and the
  guarantee that `choose()` never mutates the caller's board.
- **Server** — a real server on a random port with a throwaway database, driven
  over real WebSockets: full games, illegal moves, resign, draw offers, bots,
  lobby visibility, matchmaking, chat, Elo settlement and rate limiting.
