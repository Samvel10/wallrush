/**
 * Offline games: against a bot, or two people sharing one device.
 *
 * The engine lives entirely in the browser here, so these modes need no server,
 * no account and no network — they work on a plane. Clocks tick locally and the
 * bot thinks in a worker.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  BOT_PROFILES,
  Game,
  MoveKind,
  type BotLevel,
  type GameConfig,
  type GameEnding,
  type Move,
} from '@wallrush/shared';

import { useBotWorker } from './useBotWorker.js';

export interface LocalSeat {
  index: number;
  name: string;
  bot: BotLevel | null;
  clockMs: number;
}

export interface LocalGameOptions {
  config: GameConfig;
  /** Bot level per seat; null means a human at this device. */
  bots: (BotLevel | null)[];
  names: string[];
}

export interface LocalGameApi {
  game: Game;
  seats: LocalSeat[];
  /** Seat the local human should be controlling right now, or null. */
  controllingSeat: number | null;
  thinking: boolean;
  ending: GameEnding | null;
  winner: number | null;
  lastMove: { move: Move; by: number } | null;
  play(move: Move): boolean;
  undo(): void;
  canUndo: boolean;
  reset(options?: Partial<LocalGameOptions>): void;
  resign(seat: number): void;
  hint(): Promise<Move | null>;
  hinting: boolean;
}

interface Snapshot {
  state: ReturnType<Game['toState']>;
  clocks: number[];
}

export function useLocalGame(initial: LocalGameOptions): LocalGameApi {
  const [options, setOptions] = useState(initial);
  const [game, setGame] = useState(() => new Game(initial.config));
  const [clocks, setClocks] = useState(() =>
    initial.bots.map(() => initial.config.clockMs),
  );
  const [thinking, setThinking] = useState(false);
  const [hinting, setHinting] = useState(false);
  const [lastMove, setLastMove] = useState<{ move: Move; by: number } | null>(null);
  const history = useRef<Snapshot[]>([]);
  const turnStartedAt = useRef(Date.now());
  const { think } = useBotWorker();
  const gameRef = useRef(game);
  gameRef.current = game;

  const seats = useMemo<LocalSeat[]>(
    () =>
      game.players.map((p) => ({
        index: p.index,
        name: options.names[p.index] ?? `#${p.index + 1}`,
        bot: options.bots[p.index] ?? null,
        clockMs: clocks[p.index] ?? 0,
      })),
    [game, options, clocks],
  );

  const currentIsBot = options.bots[game.turn] != null;
  const controllingSeat = game.isOver || currentIsBot ? null : game.turn;

  const commit = useCallback(
    (move: Move, bySeat: number): boolean => {
      const next = gameRef.current.clone();
      const before: Snapshot = {
        state: gameRef.current.toState(),
        clocks: [...clocks],
      };
      const elapsed = Date.now() - turnStartedAt.current;
      const result = next.apply(move, elapsed);
      if (!result.ok) return false;
      history.current.push(before);
      if (history.current.length > 200) history.current.shift();
      turnStartedAt.current = Date.now();
      setClocks((prev) => {
        if (options.config.clockMs <= 0) return prev;
        const copy = [...prev];
        copy[bySeat] = Math.max(0, copy[bySeat] - elapsed) + options.config.incrementMs;
        return copy;
      });
      setLastMove({ move, by: bySeat });
      setGame(next);
      return true;
    },
    [clocks, options.config.clockMs, options.config.incrementMs],
  );

  const play = useCallback(
    (move: Move): boolean => {
      if (gameRef.current.isOver) return false;
      if (options.bots[gameRef.current.turn] != null) return false;
      return commit(move, gameRef.current.turn);
    },
    [commit, options.bots],
  );

  // Let the bot move when it is its turn.
  useEffect(() => {
    const level = options.bots[game.turn];
    if (!level || game.isOver) return;
    let cancelled = false;
    setThinking(true);
    const startedAt = Date.now();
    const profile = BOT_PROFILES[level];
    void think(game, level).then((result) => {
      if (cancelled || !result.move) {
        if (!cancelled) setThinking(false);
        return;
      }
      // Hold weaker bots back a little so their play stays readable.
      const wait = Math.max(0, profile.minThinkMs - (Date.now() - startedAt));
      window.setTimeout(() => {
        if (cancelled) return;
        setThinking(false);
        commit(result.move!, gameRef.current.turn);
      }, wait);
    });
    return () => {
      cancelled = true;
    };
  }, [game, options.bots, think, commit]);

  // Clock. Only runs for a human seat: bots think in real time but are not
  // charged for it, which keeps solo play relaxed.
  useEffect(() => {
    if (game.isOver || options.config.clockMs <= 0) return;
    if (options.bots[game.turn] != null) return;
    const seat = game.turn;
    const id = window.setInterval(() => {
      setClocks((prev) => {
        const copy = [...prev];
        const spent = Date.now() - turnStartedAt.current;
        if (copy[seat] - spent <= 0) {
          copy[seat] = 0;
          window.setTimeout(() => {
            setGame((g) => {
              if (g.isOver) return g;
              const next = g.clone();
              next.eliminate(seat, 'timeout');
              return next;
            });
          }, 0);
        }
        return copy;
      });
    }, 500);
    return () => window.clearInterval(id);
  }, [game, options.bots, options.config.clockMs]);

  const undo = useCallback(() => {
    // Step back over the bot's reply as well, so one tap returns the board to
    // the position the player actually faced.
    let snapshot = history.current.pop();
    if (snapshot && options.bots.some((b) => b != null)) {
      const restored = Game.fromState(snapshot.state);
      if (options.bots[restored.turn] != null) {
        const previous = history.current.pop();
        if (previous) snapshot = previous;
      }
    }
    if (!snapshot) return;
    setGame(Game.fromState(snapshot.state));
    setClocks(snapshot.clocks);
    setLastMove(null);
    turnStartedAt.current = Date.now();
  }, [options.bots]);

  const reset = useCallback(
    (patch?: Partial<LocalGameOptions>) => {
      const next = { ...options, ...patch };
      setOptions(next);
      const fresh = new Game(next.config);
      history.current = [];
      turnStartedAt.current = Date.now();
      setGame(fresh);
      setClocks(fresh.players.map(() => next.config.clockMs));
      setLastMove(null);
      setThinking(false);
    },
    [options],
  );

  const resign = useCallback((seat: number) => {
    setGame((g) => {
      if (g.isOver) return g;
      const next = g.clone();
      next.eliminate(seat, 'resign');
      return next;
    });
  }, []);

  const hint = useCallback(async (): Promise<Move | null> => {
    if (game.isOver) return null;
    setHinting(true);
    try {
      const result = await think(game, 'expert', { strict: true, timeMs: 900 });
      return result.move;
    } finally {
      setHinting(false);
    }
  }, [game, think]);

  return {
    game,
    seats,
    controllingSeat,
    thinking,
    ending: game.ending,
    winner: game.winner,
    lastMove,
    play,
    undo,
    canUndo: history.current.length > 0 && !game.isOver,
    reset,
    resign,
    hint,
    hinting,
  };
}

export { MoveKind };
