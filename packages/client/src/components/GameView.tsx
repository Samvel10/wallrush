/**
 * The playing surface.
 *
 * Shared by offline and online games: it knows how to draw a position and
 * collect input, and nothing about where the position came from.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

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
import { seatColorVar } from './geometry.js';
import { SeatBar, TurnBanner, WallTray, type SeatView } from './GameHud.js';

export interface GameViewProps {
  game: Game;
  seats: SeatView[];
  mySeat: number | null;
  /**
   * Two people sharing one screen, sitting across from each other. The board
   * stays put and the player on the far side gets a second, upside-down
   * toolbar above it, so both of them reach their own controls.
   */
  sharedDevice?: boolean;
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
  sharedDevice = false,
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
  /** Set while a wall is being carried from the tray to the board. */
  const [dragging, setDragging] = useState<0 | 1 | null>(null);
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

  // Show the board from the local player's side of the table.
  const flipped = mySeat === 1 || mySeat === 3;

  // On a shared device the board never turns, so whoever is not seat 0 is
  // sitting on the other side of it.
  const farSide = sharedDevice && controllingSeat !== null && controllingSeat !== 0;

  /**
   * Arrow keys move the pawn in the direction you see on screen — which is not
   * the direction in board coordinates once the board is flipped for seat 1.
   * Jumps are included: pressing towards an opponent standing next to you plays
   * the hop, because that is what "move that way" means in this game.
   */
  const stepInDirection = useCallback(
    (dr: number, dc: number): boolean => {
      if (controllingSeat === null) return false;
      const sign = flipped ? -1 : 1;
      const from = game.players[controllingSeat].pos;
      const wanted = { dr: dr * sign, dc: dc * sign };
      const options = game.pawnMoves(controllingSeat);
      const exact = options.find(
        (m) => m.r === from.r + wanted.dr && m.c === from.c + wanted.dc,
      );
      // A jump lands two squares away in the same direction.
      const jump = options.find(
        (m) => m.r === from.r + wanted.dr * 2 && m.c === from.c + wanted.dc * 2,
      );
      const target = exact ?? jump;
      if (!target) return false;
      onStepRef.current(target);
      return true;
    },
    [controllingSeat, flipped, game],
  );

  // Keyboard: arrows move, M/W switch modes, R rotates, P toggles the path hint.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;

      const arrows: Record<string, [number, number]> = {
        arrowup: [-1, 0],
        arrowdown: [1, 0],
        arrowleft: [0, -1],
        arrowright: [0, 1],
      };
      const key = e.key.toLowerCase();
      const dir = arrows[key];
      if (dir && mode === 'move') {
        if (stepInDirection(dir[0], dir[1])) e.preventDefault();
        return;
      }

      if (key === 'm') setMode('move');
      else if (key === 'w' && wallsLeft > 0) setMode('wall');
      else if (key === 'r') {
        setOrientation((o) => (o === 0 ? 1 : 0));
        if (wallsLeft > 0) setMode('wall');
      } else if (key === 'p') setShowPath((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [wallsLeft, mode, stepInDirection]);

  // Kept in a ref so the keyboard handler does not have to be rebuilt (and the
  // listener re-attached) every time a dependency of `handleStep` changes.
  const onStepRef = useRef<(to: Pos) => void>(() => undefined);

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

  onStepRef.current = handleStep;

  const handleWall = useCallback(
    (wall: Wall) => {
      if (settings.sound) sounds.wall();
      if (settings.haptics) vibrate([12, 24, 12]);
      onMove({ kind: MoveKind.Wall, wall });
      setMode('move');
    },
    [onMove, settings.sound, settings.haptics],
  );

  const hintLabel = useMemo(
    () => (hintMove ? moveName(hintMove, game.rows) : null),
    [hintMove, game.rows],
  );

  const opponents = seats.filter((s) => s.index !== mySeat);
  const mine = seats.find((s) => s.index === mySeat);

  return (
    <div className="game-layout">
      <div className="game-stage">
        <div className="stack-sm" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {opponents.map((s) => (
            <SeatBar
              key={s.index}
              seat={s}
              game={game}
              running={clockRunning}
              compact={seats.length > 2}
            />
          ))}
        </div>

        {/* The far player's controls, the right way up for their side. */}
        {sharedDevice && farSide ? (
          <div className="game-toolbar is-mirrored">
            <WallTray
              mode={mode}
              orientation={orientation}
              wallsLeft={wallsLeft}
              disabled={controllingSeat === null}
              onMode={setMode}
              onOrientation={setOrientation}
              onPickUp={setDragging}
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
          </div>
        ) : null}

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
          dragOrientation={dragging}
          onDragFinish={() => setDragging(null)}
          lastMove={lastMove}
          floatingEmote={floatingEmote}
          onStep={handleStep}
          onWall={handleWall}
        />

        {mine ? <SeatBar seat={mine} game={game} running={clockRunning} /> : null}

        <div className={`game-toolbar${sharedDevice && farSide ? ' is-dimmed' : ''}`}>
          <WallTray
            mode={mode}
            orientation={orientation}
            wallsLeft={wallsLeft}
            disabled={controllingSeat === null}
            onMode={setMode}
            onOrientation={setOrientation}
            onPickUp={setDragging}
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
  // One column per player. Pairing moves two-by-two would put unrelated
  // players on the same row of a four-player game.
  const seatCount = game.players.length;
  const rows: { n: number; cells: ({ name: string; ply: number } | null)[] }[] = [];
  game.history.forEach((entry, i) => {
    const index = Math.floor(i / seatCount);
    if (!rows[index]) {
      rows[index] = { n: index + 1, cells: Array.from({ length: seatCount }, () => null) };
    }
    rows[index].cells[i % seatCount] = { name: moveName(entry.move, game.rows), ply: i };
  });

  return (
    <div className="card card-tight">
      <div className="uppercase" style={{ marginBottom: 8 }}>
        {t.game.moveList}
      </div>
      {rows.length === 0 ? (
        <p className="small muted">—</p>
      ) : (
        <div className="move-log" style={{ '--log-cols': seatCount } as React.CSSProperties}>
          {rows.map((row) => (
            <FragmentRow
              key={row.n}
              row={row}
              seats={seatCount}
              onSelect={onSelect}
              last={game.ply}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FragmentRow({
  row,
  seats,
  onSelect,
  last,
}: {
  row: { n: number; cells: ({ name: string; ply: number } | null)[] };
  seats: number;
  onSelect?(ply: number): void;
  last: number;
}): ReactNode {
  return (
    <>
      <span className="move-log-num">{row.n}.</span>
      {row.cells.map((cell, seat) => (
        <button
          key={seat}
          type="button"
          className={`move-log-move${seats > 2 ? ' has-seat' : ''}${
            cell && cell.ply === last - 1 ? ' is-current' : ''
          }`}
          style={{ '--seat-color': seatColorVar(seat) } as React.CSSProperties}
          onClick={() => cell && onSelect?.(cell.ply)}
          disabled={!onSelect || !cell}
        >
          {cell?.name ?? ''}
        </button>
      ))}
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
