/** Talks to the bot worker, with a synchronous fallback if workers are blocked. */

import { useCallback, useEffect, useRef } from 'react';

import { Bot, Game, qualityOf, type BotLevel, type Move, type MoveQuality } from '@wallrush/shared';

import type { ThinkResponse, WorkerRequest } from '../worker/bot.worker.js';

export interface ThinkResult {
  move: Move | null;
  score: number;
  depth: number;
  nodes: number;
  ms: number;
  analysis?: {
    best: Move;
    bestScore: number;
    playedScore: number;
    loss: number;
    quality: MoveQuality;
    mover: number;
  };
}

export function useBotWorker(): {
  think(game: Game, level: BotLevel, opts?: { strict?: boolean; timeMs?: number }): Promise<ThinkResult>;
  analyse(game: Game, played: Move, level: BotLevel, timeMs?: number): Promise<ThinkResult>;
  cancel(): void;
} {
  const workerRef = useRef<Worker | null>(null);
  const pending = useRef(new Map<number, (r: ThinkResult) => void>());
  const nextId = useRef(1);

  useEffect(() => {
    let worker: Worker | null = null;
    try {
      worker = new Worker(new URL('../worker/bot.worker.ts', import.meta.url), {
        type: 'module',
      });
      worker.onmessage = (event: MessageEvent<ThinkResponse>) => {
        const resolve = pending.current.get(event.data.id);
        if (!resolve) return;
        pending.current.delete(event.data.id);
        resolve(event.data);
      };
      worker.onerror = () => {
        // Fall back to the main thread; a stuttering board beats no bot at all.
        worker?.terminate();
        workerRef.current = null;
      };
      workerRef.current = worker;
    } catch {
      workerRef.current = null;
    }
    return () => {
      worker?.terminate();
      workerRef.current = null;
      pending.current.clear();
    };
  }, []);

  const think = useCallback(
    (game: Game, level: BotLevel, opts?: { strict?: boolean; timeMs?: number }) =>
      new Promise<ThinkResult>((resolve) => {
        const worker = workerRef.current;
        const seed = (Math.random() * 2 ** 31) | 0;
        if (!worker) {
          const bot = new Bot(level, game.size, game.config.players, seed);
          const result = bot.choose(game, opts);
          resolve(result);
          return;
        }
        const id = nextId.current++;
        pending.current.set(id, resolve);
        const req: WorkerRequest = {
          id,
          kind: 'think',
          state: game.toState(),
          level,
          seed,
          strict: opts?.strict,
          timeMs: opts?.timeMs,
        };
        worker.postMessage(req);
      }),
    [],
  );

  const analyse = useCallback(
    (game: Game, played: Move, level: BotLevel, timeMs?: number) =>
      new Promise<ThinkResult>((resolve) => {
        const worker = workerRef.current;
        const seed = 0x51ed270b;
        if (!worker) {
          const bot = new Bot(level, game.size, game.config.players, seed);
          const a = bot.analyse(game, played, timeMs);
          resolve({
            move: a.best,
            score: a.bestScore,
            depth: 0,
            nodes: 0,
            ms: 0,
            analysis: { ...a, quality: qualityOf(a.loss) },
          });
          return;
        }
        const id = nextId.current++;
        pending.current.set(id, resolve);
        const req: WorkerRequest = {
          id,
          kind: 'analyse',
          state: game.toState(),
          played,
          level,
          seed,
          timeMs,
        };
        worker.postMessage(req);
      }),
    [],
  );

  const cancel = useCallback(() => {
    pending.current.clear();
  }, []);

  return { think, analyse, cancel };
}
