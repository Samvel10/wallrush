/**
 * Bot worker.
 *
 * The search runs off the main thread so the board never stutters, even when
 * the master level thinks for three seconds. Running the bot in the browser
 * also means solo play works with no server at all — including offline.
 */

import {
  Bot,
  Game,
  qualityOf,
  type BotLevel,
  type GameState,
  type Move,
  type MoveQuality,
} from '@wallrush/shared';

interface ThinkRequest {
  id: number;
  kind?: 'think';
  state: GameState;
  level: BotLevel;
  seed: number;
  strict?: boolean;
  timeMs?: number;
}

interface AnalyseRequest {
  id: number;
  kind: 'analyse';
  state: GameState;
  played: Move;
  level: BotLevel;
  seed: number;
  timeMs?: number;
}

type WorkerRequest = ThinkRequest | AnalyseRequest;

interface ThinkResponse {
  id: number;
  move: Move | null;
  score: number;
  depth: number;
  nodes: number;
  ms: number;
  error?: string;
  /** Present only for analyse requests. */
  analysis?: {
    best: Move;
    bestScore: number;
    playedScore: number;
    loss: number;
    quality: MoveQuality;
    mover: number;
  };
}

const bots = new Map<string, Bot>();

function botFor(level: BotLevel, size: number, seats: number, seed: number): Bot {
  const key = `${level}:${size}:${seats}`;
  let bot = bots.get(key);
  if (!bot) {
    bot = new Bot(level, size, seats, seed);
    bots.set(key, bot);
  }
  return bot;
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  const started = Date.now();
  try {
    const game = Game.fromState(req.state);
    const bot = botFor(req.level, game.size, game.config.players, req.seed);

    if (req.kind === 'analyse') {
      const a = bot.analyse(game, req.played, req.timeMs);
      const response: ThinkResponse = {
        id: req.id,
        move: a.best,
        score: a.bestScore,
        depth: 0,
        nodes: 0,
        ms: Date.now() - started,
        analysis: {
          best: a.best,
          bestScore: a.bestScore,
          playedScore: a.playedScore,
          loss: a.loss,
          quality: qualityOf(a.loss),
          mover: a.mover,
        },
      };
      (self as unknown as Worker).postMessage(response);
      return;
    }

    const result = bot.choose(game, { strict: req.strict, timeMs: req.timeMs });
    const response: ThinkResponse = {
      id: req.id,
      move: result.move,
      score: result.score,
      depth: result.depth,
      nodes: result.nodes,
      ms: Date.now() - started,
    };
    (self as unknown as Worker).postMessage(response);
  } catch (err) {
    const response: ThinkResponse = {
      id: req.id,
      move: null,
      score: 0,
      depth: 0,
      nodes: 0,
      ms: Date.now() - started,
      error: err instanceof Error ? err.message : 'bot-failed',
    };
    (self as unknown as Worker).postMessage(response);
  }
};

export type { AnalyseRequest, ThinkRequest, ThinkResponse, WorkerRequest };
