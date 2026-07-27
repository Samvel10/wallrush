/** Seat cards, wall tray and the in-game toolbar. */

import type { ReactNode } from 'react';

import { BOT_RATING, type BotLevel, type Game } from '@wallrush/shared';

import { useI18n } from '../i18n/index.js';
import { formatClock } from './ui.js';

export interface SeatView {
  index: number;
  name: string;
  avatar?: string;
  rating?: number;
  bot: BotLevel | null;
  clockMs: number;
  connected?: boolean;
  isMe?: boolean;
}

export function SeatBar({
  seat,
  game,
  running,
  compact = false,
}: {
  seat: SeatView;
  game: Game;
  running: boolean;
  compact?: boolean;
}): ReactNode {
  const { t } = useI18n();
  const player = game.players[seat.index];
  const isTurn = game.turn === seat.index && !game.isOver;
  const walls = player?.walls ?? 0;
  const total = game.config.wallsPerPlayer;
  const distance = player && !game.isOver ? game.distanceFor(seat.index) : -1;
  const lowTime = seat.clockMs > 0 && seat.clockMs < 30_000;

  return (
    <div
      className={[
        'seat-bar',
        isTurn ? 'is-turn' : '',
        compact ? 'is-compact' : '',
        seat.connected === false ? 'is-offline' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ '--seat-color': `var(--p${seat.index})` } as React.CSSProperties}
    >
      <span className="seat-dot" aria-hidden="true" />
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="seat-name truncate">
          {seat.avatar ? <span style={{ marginInlineEnd: 6 }}>{seat.avatar}</span> : null}
          {seat.bot ? `${t.common.bot} · ${t.bot[seat.bot]}` : seat.name}
          {seat.isMe && seat.name !== t.common.you ? (
            <span className="faint tiny"> · {t.common.you}</span>
          ) : null}
        </div>
        {compact ? null : (
          <div className="seat-meta">
            <span className="wall-pips" aria-label={`${walls} ${t.game.walls}`}>
              {Array.from({ length: total }, (_, i) => (
                <span key={i} className={`wall-pip${i >= walls ? ' is-spent' : ''}`} />
              ))}
            </span>
            <span className="nums">{walls}</span>
            {distance >= 0 ? (
              <span className="faint">
                · {t.game.distance}: <span className="nums">{distance}</span>
              </span>
            ) : null}
          </div>
        )}
      </div>
      {compact ? (
        <span className="seat-meta">
          <span aria-label={t.game.walls}>🧱</span>
          <span className="nums">{walls}</span>
          {distance >= 0 ? (
            <span className="faint">
              · <span className="nums">{distance}</span>
            </span>
          ) : null}
        </span>
      ) : null}
      {game.config.clockMs > 0 ? (
        <span
          className={`clock${isTurn && running ? ' is-running' : ''}${
            lowTime && isTurn ? ' is-low' : ''
          }`}
        >
          {formatClock(seat.clockMs)}
        </span>
      ) : null}
    </div>
  );
}

export function WallTray({
  mode,
  orientation,
  wallsLeft,
  disabled,
  onMode,
  onOrientation,
}: {
  mode: 'move' | 'wall';
  orientation: 0 | 1;
  wallsLeft: number;
  disabled: boolean;
  onMode(mode: 'move' | 'wall'): void;
  onOrientation(o: 0 | 1): void;
}): ReactNode {
  const { t } = useI18n();
  const noWalls = wallsLeft <= 0;
  return (
    <div className="wall-tray">
      <button
        type="button"
        className="wall-tray-btn"
        aria-pressed={mode === 'move'}
        onClick={() => onMode('move')}
        disabled={disabled}
        title={t.game.moveMode}
      >
        <span aria-hidden="true" style={{ fontSize: 20 }}>
          ⬤
        </span>
        <span className="visually-hidden">{t.game.moveMode}</span>
      </button>
      <span className="chip" title={t.game.wallsLeft}>
        <span aria-hidden="true">🧱</span>
        <span className="nums">{wallsLeft}</span>
      </span>
      <button
        type="button"
        className="wall-tray-btn"
        aria-pressed={mode === 'wall' && orientation === 0}
        onClick={() => {
          onMode('wall');
          onOrientation(0);
        }}
        disabled={disabled || noWalls}
        title={t.game.horizontal}
      >
        <span className="wall-glyph is-h" aria-hidden="true" />
        <span className="visually-hidden">{t.game.horizontal}</span>
      </button>
      <button
        type="button"
        className="wall-tray-btn"
        aria-pressed={mode === 'wall' && orientation === 1}
        onClick={() => {
          onMode('wall');
          onOrientation(1);
        }}
        disabled={disabled || noWalls}
        title={t.game.vertical}
      >
        <span className="wall-glyph is-v" aria-hidden="true" />
        <span className="visually-hidden">{t.game.vertical}</span>
      </button>
    </div>
  );
}

export function TurnBanner({
  game,
  mySeat,
  thinking,
  seats,
}: {
  game: Game;
  mySeat: number | null;
  thinking: boolean;
  seats: SeatView[];
}): ReactNode {
  const { t, f } = useI18n();
  if (game.isOver) return null;
  const current = seats.find((s) => s.index === game.turn);
  const isMine = mySeat !== null && game.turn === mySeat;
  const label = thinking
    ? `${current?.bot ? t.bot[current.bot] : (current?.name ?? '')} · ${t.bot.thinking}`
    : isMine
      ? t.game.yourTurn
      : current
        ? f(t.game.waitingFor, { name: current.bot ? t.bot[current.bot] : current.name })
        : t.game.theirTurn;

  return (
    <div
      className="chip"
      style={
        {
          alignSelf: 'center',
          background: isMine ? `color-mix(in oklab, var(--p${game.turn}) 16%, transparent)` : undefined,
          color: isMine ? `var(--p${game.turn})` : undefined,
          borderColor: isMine ? `color-mix(in oklab, var(--p${game.turn}) 32%, transparent)` : undefined,
          fontSize: 'var(--text-sm)',
          padding: '5px 14px',
        } as React.CSSProperties
      }
    >
      {thinking ? <span className="spinner" /> : null}
      {label}
    </div>
  );
}

export function botLabel(level: BotLevel, dict: ReturnType<typeof useI18n>['t']): string {
  return dict.bot[level];
}

export function botRatingOf(level: BotLevel): number {
  return BOT_RATING[level] ?? 1200;
}
