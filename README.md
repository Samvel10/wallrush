# WallRush

**Փակի՛ր նրա ճանապարհը** · *Перекрой ему путь* · *Block their way*

[![CI](https://github.com/Samvel10/wallrush/actions/workflows/ci.yml/badge.svg)](https://github.com/Samvel10/wallrush/actions/workflows/ci.yml)

A fast, beautiful, genuinely free web version of Quoridor — playable with
friends online, against six levels of bot, or two people on one phone.
Trilingual (հայերեն · русский · English), works offline, no ads, no tracking.

<p align="center">
  <img src="packages/client/public/icon.svg" width="96" alt="WallRush">
</p>

---

## What it is

Two to four players race to the opposite edge of a 9×9 board. On your turn you
either **step one square** or **place one wall**. Walls block movement but can
never seal a player off completely — there is always a route home. Simple rules,
deep play.

## What is in the box

| | |
|---|---|
| **Online with friends** | Create a table, share a five-character code. Public lobby too. |
| **Quick play** | Rating-matched queue that widens its window the longer you wait. |
| **Six bot levels** | Novice → Master. The top level searches ~15 plies deep, and the ladder is measured, not guessed. |
| **2 and 4 players** | Classic duel, or a four-way race from all four edges. |
| **Board sizes** | 5×5, 7×7, 9×9 and 11×11, with configurable walls and clocks. |
| **Three languages** | Armenian, Russian and English, switchable anywhere. |
| **Accounts are optional** | Play as a guest forever; sign up to keep history and Elo. |
| **Works offline** | The bot runs in a Web Worker; the PWA caches the shell. |
| **Built for phones** | Every screen is designed touch-first, from 320 px up. |
| **Game review** | Replay any finished game and have the engine mark every inaccuracy, mistake and blunder. |
| **Keyboard** | Arrows move, `W`/`R` place and rotate walls, `P` shows your route; replays scrub with arrows and `Space`. |

## Running it

```bash
npm install
npm run dev          # server on :8787, client on :5173
```

For a production-shaped run:

```bash
npm run build
npm start            # serves the built client and the API on :8787
```

Open <http://localhost:8787>.

### Configuration

Everything is an environment variable with a sensible default.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | HTTP + WebSocket port |
| `HOST` | `0.0.0.0` | Bind address |
| `WALLRUSH_DATA` | `./data` | Directory for the SQLite file and signing key |
| `WALLRUSH_STATIC` | `packages/client/dist` | Client build to serve; empty disables |
| `WALLRUSH_SECRET` | generated | Token signing secret (persisted on first boot) |
| `WALLRUSH_ORIGINS` | `*` | Allowed CORS origins |
| `WALLRUSH_RATE_LIMIT` | `25` | Messages per second per connection |

## How it is built

```
packages/
  shared/   game engine + bot        — pure TypeScript, zero dependencies
  server/   API + realtime + storage — Node 22+, one dependency (ws)
  client/   the app                  — React 19 + Vite, hand-written CSS
```

**The engine** is shared verbatim between the browser and the server, so there
is exactly one implementation of the rules. Walls are stored as bitsets, path
finding is a reused-buffer BFS, and make/unmake is cheap enough to search on.

**The bot** is negamax with alpha–beta, iterative deepening, a Zobrist
transposition table, killer moves and late-move reductions. The trick that makes
it affordable in a browser is candidate filtering: of the ~128 placeable walls,
only those near a pawn or across somebody's shortest route are ever considered.

**The server** is authoritative. Clients propose moves; rooms validate them
against the engine and broadcast the result. Storage is `node:sqlite`, which
ships inside Node, so there is no native build step and no database to run.
Passwords use scrypt from `node:crypto` and sessions are HMAC-signed tokens —
no authentication library involved.

**The client** renders the board with absolutely-positioned percentages inside a
square container, so one layout serves a 320 px phone and a 4K monitor with no
breakpoints. Wall slots rest as small pips and expand to their real two-cell
footprint on hover or first tap, which is what makes wall placement workable
with a thumb.

## Testing

```bash
npm test          # 94 tests: engine, bot, analysis, notation, Elo, geometry, server
npm run typecheck
```

The server tests boot a real server on a random port with a throwaway database
and drive it over real WebSockets — the same path a browser takes. They cover
full games, illegal moves, resignation, draw offers, bot seats, matchmaking,
losing on time, reconnecting into a seat mid-game, hostile payloads and path
traversal.

There is also a soak test, kept out of `npm test` because it needs a running
server:

```bash
npm start &
node scripts/soak.mjs --games 400
```

On a single ordinary machine, 400 concurrent games (800 sockets, 5 600 moves):

```
games:      400 finished, 0 failed
wall clock: 4.2s
latency:    p50 2ms  p95 4ms  p99 18ms  max 25ms
rooms:      0 before -> 0 after      (nothing leaked)
memory:     87 MB -> 104 MB
```

## Notation

Standard Quoridor notation: files `a`–`i` from the left, ranks `1`–`9` from the
bottom. A pawn move is its destination (`e8`); a wall is its anchor square plus
`h` or `v` (`e3h`). Every finished game is stored as a transcript, so any match
can be replayed move by move.

## Licence

Apache-2.0. See [LICENSE](LICENSE).
