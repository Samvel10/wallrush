# WallRush — working notes

Read this before changing anything here.

## Shape

npm workspaces. `packages/shared` is a dependency-free TypeScript game engine
plus the bot; `packages/server` is the API, realtime layer and storage;
`packages/client` is the React app. The engine is imported verbatim by both
sides — there is exactly one implementation of the rules, and it must stay that
way. If a rule needs changing, change it in `packages/shared/src/engine.ts` and
nowhere else.

## Commands

```bash
npm run dev          # server :8787 + vite :5173
npm run build
npm start            # production shape on :8787
npm test             # 90 tests
npm run typecheck
bash scripts/serve-test.sh                 # production-shaped instance on :8791
node scripts/soak.mjs --games 400          # needs a running server
```

## Rules of the road

- **The server is authoritative.** Clients propose moves; rooms validate them
  against the engine and broadcast the result. Never trust a client-reported
  outcome — `POST /api/matches/local` accepts *moves* and replays them.
- **Guests are first-class.** Everything must work without an account. Signing
  up upgrades the existing row so nothing is lost.
- **Armenian is the source of truth for text.** `i18n/hy.ts` defines the
  `Dictionary` type; a key missing from `ru.ts` or `en.ts` is a compile error.
  Add new strings to Armenian first.
- **No new dependencies without a reason you would defend.** The server has
  one (`ws`); the whole point is that this deploys as a single process and a
  single file.
- **Touch first.** Wall gaps are ~7 px on a phone. Anything interactive needs a
  target of at least 24 px; see `SLOT_GROW` in `components/geometry.ts`.

## Things that have already bitten

These are documented at length in `docs/SETUP_LOG.md`; the short version:

- `const enum` does not exist at runtime — use a plain `enum`.
- `makeForSearch` must always hand the turn on, even after a winning move, or
  the negamax sign flips at terminal nodes.
- `.tsbuildinfo` must never be committed: tsc will believe the build is current
  and emit nothing, which breaks clean checkouts while local builds keep working.
- Per-package `tsc --noEmit` cannot typecheck the server on a clean tree; the
  root script uses build mode so project references resolve.
- `shortestPath` ignores pawns, so its next cell can be occupied — the rules
  call for a jump there. Drive test games from `pawnMoves`, not the path.
- `Intl.RelativeTimeFormat` has no Armenian data and silently returns English.

## Before pushing

`npm run typecheck && npm run build && npm test` — from a clean tree if you
touched build configuration. CI runs the same on Node 22 and 24, plus a boot
check and a short soak.
