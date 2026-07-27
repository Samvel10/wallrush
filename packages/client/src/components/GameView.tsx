/**
 * The playing surface.
 *
 * Shared by offline and online games: it knows how to draw a position and
 * collect input, and nothing about where the position came from.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import {
  Game,
  MoveKind,
  moveName,
  type GameEnding,
  type Move,
  type Pos,
  type Wall,
} from '@wallrush/shared';

import { useI18n } from '../i18n/index.js';
import { useSettings } from '../state/settings.js';
import { sounds, vibrate } from '../state/sound.js';
import { Board } from './Board.js';
import { SeatBar, TurnBanner, WallTray, type SeatView } from './GameHud.js';

export interface GameViewProps {
  game: Game;
  seats: SeatView[];
  mySeat: number | null;
  /** Seat whose input is accepted right now (null = board locked). */
  controllingSeat: number | null;
  thinking?: boolean;
  clockRunning?: boolean;
  lastMove?: { move: Move; by: number } | null;
  floatingEmote?: { emoji: string; seat: number; id: number } | null;
  banner?: ReactNode;
  side?: ReactNode;
  actions?: ReactNode;
  onMove(move: Move): void;
  /** Highlighted hint move, if the player asked for one. */
  hintMove?: Move | null;
}

export function GameView({
  game,
  seats,
  mySeat,
  controllingSeat,
  thinking = false,
  clockRunning = true,
  lastMove = null,
  floatingEmote = null,
  banner,
  side,
  actions,
  onMove,
  hintMove = null,
}: GameViewProps): ReactNode {
  const { t } = useI18n();
  const { settings } = useSettings();
  const [mode, setMode] = useState<'move' | 'wall'>('move');
  const [orientation, setOrientation] = useState<0 | 1>(0);
  const [showPath, setShowPath] = useState(settings.showPath);

  useEffect(() => setShowPath(settings.showPath), [settings.showPath]);

  // A player who has run out of walls can only walk. Fall back to `mySeat` so
  // the tray still shows the right count while the board is locked — waiting
  // for the opponent, or after the game has ended.
  const traySeat = controllingSeat ?? mySeat;
  const wallsLeft = traySeat !== null ? (game.players[traySeat]?.walls ?? 0) : 0;
  useEffect(() => {
    if (wallsLeft <= 0 && mode === 'wall') setMode('move');
  }, [wallsLeft, mode]);

  // Keyboard: M/W switch modes, R rotates, P toggles the path hint.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
      const key = e.key.toLowerCase();
      if (key === 'm') setMode('move');
      else if (key === 'w' && wallsLeft > 0) setMode('wall');
      else if (key === 'r') {
        setOrientation((o) => (o === 0 ? 1 : 0));
        if (wallsLeft > 0) setMode('wall');
      } else if (key === 'p') setShowPath((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [wallsLeft]);

  const handleStep = useCallback(
    (to: Pos) => {
      if (controllingSeat === null) return;
      const from = game.players[controllingSeat].pos;
      const isJump = Math.abs(to.r - from.r) + Math.abs(to.c - from.c) > 1;
      if (settings.sound) (isJump ? sounds.jump : sounds.step)();
      if (settings.haptics) vibrate(10);
      onMove({ kind: MoveKind.Step, to });
    },
    [controllingSeat, game, onMove, settings.sound, settings.haptics],
  );

  const handleWall = useCallback(
    (wall: Wall) => {
      if (settings.sound) sounds.wall();
      if (settings.haptics) vibrate([12, 24, 12]);
      onMove({ kind: MoveKind.Wall, wall });
      setMode('move');
    },
    [onMove, settings.sound, settings.haptics],
  );

  // Show the board from the local player's side of the table.
  const flipped = mySeat === 1 || mySeat === 3;

  const hintLabel = useMemo(
    () => (hintMove ? moveName(hintMove, game.size) : null),
    [hintMove, game.size],
  );

  const opponents = seats.filter((s) => s.index !== mySeat);
  const mine = seats.find((s) => s.index === mySeat);

  return (
    <div className="game-layout">
      <div className="game-stage">
        <div className="stack-sm" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {opponents.map((s) => (
            <SeatBar key={s.index} seat={s} game={game} running={clockRunning} />
          ))}
        </div>

        {banner ?? <TurnBanner game={game} mySeat={mySeat} thinking={thinking} seats={seats} />}

        <Board
          game={game}
          mySeat={mySeat}
          activeSeat={controllingSeat}
          interactive={controllingSeat !== null}
          mode={mode}
          orientation={orientation}
          flipped={flipped}
          showCoordinates={settings.showCoordinates}
          showPath={showPath}
          confirmMoves={settings.confirmMoves}
          lastMove={lastMove}
          floatingEmote={floatingEmote}
          onStep={handleStep}
          onWall={handleWall}
        />

        {mine ? <SeatBar seat={mine} game={game} running={clockRunning} /> : null}

        <div className="game-toolbar">
          <WallTray
            mode={mode}
            orientation={orientation}
            wallsLeft={wallsLeft}
            disabled={controllingSeat === null}
            onMode={setMode}
            onOrientation={setOrientation}
          />
          <button
            type="button"
            className="btn btn-sm"
            aria-pressed={showPath}
            onClick={() => setShowPath((v) => !v)}
            title={showPath ? t.game.hidePath : t.game.showPath}
          >
            🧭
            <span className="visually-hidden">
              {showPath ? t.game.hidePath : t.game.showPath}
            </span>
          </button>
          {actions}
        </div>

        {hintLabel ? (
          <p className="center small muted">
            {t.game.hint}: <span className="mono">{hintLabel}</span>
          </p>
        ) : null}
      </div>

      {side ? <aside className="game-side stack">{side}</aside> : null}
    </div>
  );
}

export function MoveLog({
  game,
  onSelect,
}: {
  game: Game;
  onSelect?(ply: number): void;
}): ReactNode {
  const { t } = useI18n();
  const rows: { n: number; a?: string; b?: string; aPly?: number; bPly?: number }[] = [];
  game.history.forEach((entry, i) => {
    const index = Math.floor(i / 2);
    if (!rows[index]) rows[index] = { n: index + 1 };
    const name = moveName(entry.move, game.size);
    if (i % 2 === 0) {
      rows[index].a = name;
      rows[index].aPly = i;
    } else {
      rows[index].b = name;
      rows[index].bPly = i;
    }
  });

  return (
    <div className="card card-tight">
      <div className="uppercase" style={{ marginBottom: 8 }}>
        {t.game.moveList}
      </div>
      {rows.length === 0 ? (
        <p className="small muted">—</p>
      ) : (
        <div className="move-log">
          {rows.map((row) => (
            <FragmentRow key={row.n} row={row} onSelect={onSelect} last={game.ply} />
          ))}
        </div>
      )}
    </div>
  );
}

function FragmentRow({
  row,
  onSelect,
  last,
}: {
  row: { n: number; a?: string; b?: string; aPly?: number; bPly?: number };
  onSelect?(ply: number): void;
  last: number;
}): ReactNode {
  return (
    <>
      <span className="move-log-num">{row.n}.</span>
      <button
        type="button"
        className={`move-log-move${row.aPly === last - 1 ? ' is-current' : ''}`}
        onClick={() => row.aPly !== undefined && onSelect?.(row.aPly)}
        disabled={!onSelect || row.a === undefined}
      >
        {row.a ?? ''}
      </button>
      <button
        type="button"
        className={`move-log-move${row.bPly === last - 1 ? ' is-current' : ''}`}
        onClick={() => row.bPly !== undefined && onSelect?.(row.bPly)}
        disabled={!onSelect || row.b === undefined}
      >
        {row.b ?? ''}
      </button>
    </>
  );
}

export function endingLabel(
  ending: GameEnding | null,
  t: ReturnType<typeof useI18n>['t'],
): string {
  switch (ending) {
    case 'goal':
      return t.result.byGoal;
    case 'resign':
      return t.result.byResign;
    case 'timeout':
      return t.result.byTimeout;
    case 'disconnect':
      return t.result.byDisconnect;
    case 'draw':
      return t.result.byDraw;
    case 'abort':
      return t.result.byAbort;
    default:
      return '';
  }
}
