/**
 * WallRush — the board.
 *
 * Presentational: it renders a `Game` and reports intent (`onStep`, `onWall`)
 * upwards. All rule checking has already happened in the engine, so the board's
 * only job is to make the legal options obvious and easy to hit — including on
 * a phone, where the wall gaps are far too thin to tap directly.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Game, MoveKind, isGoal, type Pos, type Wall } from '@wallrush/shared';

import {
  SLOT_THICKNESS_PCT,
  cellBox,
  cellCentre,
  metricsFor,
  slotBox,
  wallBox,
  type BoardMetrics,
} from './geometry.js';

export type WallOrientation = 0 | 1;

export interface BoardProps {
  game: Game;
  /** Seat the human is playing, or null when spectating/replaying. */
  mySeat: number | null;
  /** Whose input is currently accepted. Null locks the board. */
  activeSeat: number | null;
  interactive: boolean;
  mode: 'move' | 'wall';
  orientation: WallOrientation;
  /** Rotate the view so the local player always sits at the bottom. */
  flipped?: boolean;
  showCoordinates?: boolean;
  showPath?: boolean;
  /** Require a second tap to commit — safer on touch screens. */
  confirmMoves?: boolean;
  lastMove?: { move: { kind: MoveKind; to?: Pos; wall?: Wall }; by: number } | null;
  floatingEmote?: { emoji: string; seat: number; id: number } | null;
  onStep(to: Pos): void;
  onWall(wall: Wall): void;
  onPreviewChange?(wall: Wall | null): void;
}

function BoardImpl({
  game,
  mySeat,
  activeSeat,
  interactive,
  mode,
  orientation,
  flipped = false,
  showCoordinates = false,
  showPath = false,
  confirmMoves = false,
  lastMove = null,
  floatingEmote = null,
  onStep,
  onWall,
  onPreviewChange,
}: BoardProps) {
  const size = game.size;
  const m = useMemo(() => metricsFor(size), [size]);
  const [pending, setPending] = useState<Wall | null>(null);
  const [pendingStep, setPendingStep] = useState<Pos | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);

  const controllingSeat = activeSeat ?? mySeat ?? 0;
  const canAct = interactive && activeSeat !== null && !game.isOver;

  // Anything the player was in the middle of choosing is stale once the
  // position changes.
  useEffect(() => {
    setPending(null);
    setPendingStep(null);
    onPreviewChange?.(null);
  }, [game.ply, game.turn, onPreviewChange]);

  useEffect(() => {
    setPending(null);
    onPreviewChange?.(null);
  }, [mode, orientation, onPreviewChange]);

  const legalSteps = useMemo(
    () => (canAct && mode === 'move' ? game.pawnMoves(controllingSeat) : []),
    [canAct, mode, game, controllingSeat],
  );

  const legalWallSlots = useMemo(() => {
    if (!canAct || mode !== 'wall') return new Set<string>();
    const out = new Set<string>();
    if (game.players[controllingSeat].walls <= 0) return out;
    for (let r = 0; r <= size - 2; r++) {
      for (let c = 0; c <= size - 2; c++) {
        if (game.isWallLegal({ r, c, o: orientation }, controllingSeat).ok) {
          out.add(`${r}:${c}`);
        }
      }
    }
    return out;
  }, [canAct, mode, game, controllingSeat, orientation, size]);

  const path = useMemo(() => {
    if (!showPath || mySeat === null || game.isOver) return [];
    return game.shortestPath(mySeat).slice(1, -1);
  }, [showPath, mySeat, game]);

  const commitWall = useCallback(
    (wall: Wall) => {
      onWall(wall);
      setPending(null);
      onPreviewChange?.(null);
    },
    [onWall, onPreviewChange],
  );

  const handleSlot = useCallback(
    (r: number, c: number) => {
      const wall: Wall = { r, c, o: orientation };
      if (!legalWallSlots.has(`${r}:${c}`)) return;
      if (!confirmMoves) {
        commitWall(wall);
        return;
      }
      if (pending && pending.r === r && pending.c === c && pending.o === orientation) {
        commitWall(wall);
        return;
      }
      setPending(wall);
      onPreviewChange?.(wall);
    },
    [orientation, legalWallSlots, confirmMoves, pending, commitWall, onPreviewChange],
  );

  const handleStep = useCallback(
    (to: Pos) => {
      if (!confirmMoves) {
        onStep(to);
        return;
      }
      if (pendingStep && pendingStep.r === to.r && pendingStep.c === to.c) {
        onStep(to);
        setPendingStep(null);
        return;
      }
      setPendingStep(to);
    },
    [confirmMoves, onStep, pendingStep],
  );

  // Rotating the board 180° keeps "forward" pointing away from the player.
  const view = useCallback(
    (r: number, c: number): [number, number] => (flipped ? [size - 1 - r, size - 1 - c] : [r, c]),
    [flipped, size],
  );
  const viewWall = useCallback(
    (w: Wall): { r: number; c: number } =>
      flipped ? { r: size - 2 - w.r, c: size - 2 - w.c } : { r: w.r, c: w.c },
    [flipped, size],
  );

  const goalOwners = useMemo(() => {
    const owners = new Map<string, number>();
    for (const p of game.players) {
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
          if (isGoal(p.side, r, c, size)) owners.set(`${r}:${c}`, p.index);
        }
      }
    }
    return owners;
  }, [game, size]);

  const [topGoal, bottomGoal] = useMemo(() => {
    // Whoever must reach row 0 owns the top edge on screen (after flipping).
    const north = game.players.find((p) => isGoal(p.side, 0, 0, size))?.index ?? 0;
    const south = game.players.find((p) => isGoal(p.side, size - 1, 0, size))?.index ?? 1;
    return flipped ? [south, north] : [north, south];
  }, [game, size, flipped]);

  const cells: React.ReactNode[] = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const [vr, vc] = view(r, c);
      const owner = goalOwners.get(`${r}:${c}`);
      const isLast =
        lastMove?.move.kind === MoveKind.Step &&
        lastMove.move.to?.r === r &&
        lastMove.move.to?.c === c;
      cells.push(
        <div
          key={`cell-${r}-${c}`}
          className={[
            'cell',
            owner !== undefined ? `is-goal-${owner}` : '',
            isLast ? 'is-last-move' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          style={cellBox(m, vr, vc)}
        >
          {showCoordinates && c === 0 ? (
            <span className="cell-coord">{size - r}</span>
          ) : null}
          {showCoordinates && r === size - 1 ? (
            <span className="cell-coord" style={{ insetInlineStart: 'auto', insetInlineEnd: 4, insetBlockStart: 'auto', insetBlockEnd: 2 }}>
              {String.fromCharCode(97 + c)}
            </span>
          ) : null}
        </div>,
      );
    }
  }

  return (
    <div
      ref={frameRef}
      className={`board-frame${canAct ? '' : ' is-locked'}`}
      style={
        {
          '--goal-top': `var(--p${topGoal})`,
          '--goal-bottom': `var(--p${bottomGoal})`,
          '--seat-color': `var(--p${controllingSeat})`,
          '--slot-thickness': `${SLOT_THICKNESS_PCT}%`,
        } as React.CSSProperties
      }
    >
      <div className="board">
        {cells}

        {path.map((cell, i) => {
          const [vr, vc] = view(cell.r, cell.c);
          const centre = cellCentre(m, vr, vc);
          const dot = m.cell * 0.2;
          return (
            <div
              key={`path-${cell.r}-${cell.c}`}
              className="path-node"
              style={{
                left: `${centre.x - dot / 2}%`,
                top: `${centre.y - dot / 2}%`,
                width: `${dot}%`,
                height: `${dot}%`,
                animationDelay: `${i * 24}ms`,
              }}
            />
          );
        })}

        {mode === 'wall' && canAct
          ? renderSlots(m, size, orientation, legalWallSlots, viewWallSlot(flipped, size), handleSlot)
          : null}

        {game.walls.map((w, i) => {
          const v = viewWall(w);
          const isLatest = i === game.walls.length - 1;
          return (
            <div
              key={`wall-${w.r}-${w.c}-${w.o}`}
              className={`wall${w.o === 1 ? ' is-v' : ''}${isLatest ? ' is-latest' : ''}`}
              style={{ ...wallBox(m, v.r, v.c, w.o), animationDelay: `${Math.min(i, 6) * 10}ms` }}
            />
          );
        })}

        {pending
          ? (() => {
              const v = viewWall(pending);
              return (
                <div
                  className={`wall is-preview${pending.o === 1 ? ' is-v' : ''}`}
                  style={wallBox(m, v.r, v.c, pending.o)}
                />
              );
            })()
          : null}

        {mode === 'move' && canAct
          ? legalSteps.map((to) => {
              const [vr, vc] = view(to.r, to.c);
              const from = game.players[controllingSeat].pos;
              const isJump = Math.abs(to.r - from.r) + Math.abs(to.c - from.c) > 1;
              const armed = pendingStep?.r === to.r && pendingStep?.c === to.c;
              return (
                <button
                  key={`step-${to.r}-${to.c}`}
                  type="button"
                  className={`move-dot${isJump ? ' is-jump' : ''}`}
                  style={{
                    ...cellBox(m, vr, vc),
                    ...(armed ? { transform: 'scale(1.08)' } : null),
                  }}
                  aria-label={`${String.fromCharCode(97 + to.c)}${size - to.r}`}
                  onClick={() => handleStep(to)}
                />
              );
            })
          : null}

        {game.players.map((p) => {
          if (p.eliminated) return null;
          const [vr, vc] = view(p.pos.r, p.pos.c);
          const box = cellBox(m, vr, vc);
          return (
            <div
              key={`pawn-${p.index}`}
              className={[
                'pawn',
                `seat-${p.index}`,
                game.turn === p.index && !game.isOver ? 'is-active' : '',
                game.winner === p.index ? 'is-winner' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              style={
                {
                  ...box,
                  '--pawn-color': `var(--p${p.index})`,
                  '--pawn-deep': `var(--p${p.index}-deep)`,
                } as React.CSSProperties
              }
            >
              <div className="pawn-body" />
            </div>
          );
        })}

        {floatingEmote
          ? (() => {
              const p = game.players[floatingEmote.seat];
              if (!p) return null;
              const [vr, vc] = view(p.pos.r, p.pos.c);
              const centre = cellCentre(m, vr, vc);
              return (
                <span
                  key={floatingEmote.id}
                  className="emote-float"
                  style={{ left: `${centre.x}%`, top: `${centre.y - m.cell}%` }}
                >
                  {floatingEmote.emoji}
                </span>
              );
            })()
          : null}
      </div>
    </div>
  );
}

function viewWallSlot(flipped: boolean, size: number) {
  return (r: number, c: number): [number, number] =>
    flipped ? [size - 2 - r, size - 2 - c] : [r, c];
}

function renderSlots(
  m: BoardMetrics,
  size: number,
  orientation: WallOrientation,
  legal: Set<string>,
  view: (r: number, c: number) => [number, number],
  onSlot: (r: number, c: number) => void,
): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  for (let r = 0; r <= size - 2; r++) {
    for (let c = 0; c <= size - 2; c++) {
      const available = legal.has(`${r}:${c}`);
      const [vr, vc] = view(r, c);
      nodes.push(
        <button
          key={`slot-${r}-${c}`}
          type="button"
          className={`wall-slot ${orientation === 0 ? 'is-h' : 'is-v'} ${
            available ? 'is-available' : 'is-blocked'
          }`}
          style={slotBox(m, vr, vc, orientation)}
          disabled={!available}
          aria-label={`${String.fromCharCode(97 + c)}${size - r - 1}${orientation === 0 ? 'h' : 'v'}`}
          onClick={() => onSlot(r, c)}
        />,
      );
    }
  }
  return nodes;
}

export const Board = memo(BoardImpl);
