/** Offline play: against a bot, or two people on one device. */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import {
  BOT_LEVELS,
  DEFAULT_CONFIG,
  cloneConfig,
  type BotLevel,
  type GameConfig,
  type Move,
} from '@wallrush/shared';

import { GameView } from '../components/GameView.js';
import { MoveLog, endingLabel } from '../components/GameView.js';
import type { SeatView } from '../components/GameHud.js';
import { BackButton, Modal, useToast } from '../components/ui.js';
import { useLocalGame } from '../hooks/useLocalGame.js';
import { useI18n } from '../i18n/index.js';
import { useRouter } from '../state/router.js';
import { useSession } from '../state/session.js';
import { useSettings } from '../state/settings.js';
import { sounds } from '../state/sound.js';

export function PlayLocal({
  botLevel,
  seats: seatCount = 2,
}: {
  /** null means hot-seat: humans sharing the device. */
  botLevel: BotLevel | null;
  /** 2 or 4 seats. With a bot level, every other seat is filled by a bot. */
  seats?: 2 | 4;
}): ReactNode {
  const { t } = useI18n();
  const { go, back } = useRouter();
  const { profile } = useSession();
  const { settings } = useSettings();
  const toast = useToast();

  // Only the fields we actually want to pin are passed: `cloneConfig` derives
  // the wall count from the seat count and board size, and spreading the whole
  // default would pin it to the two-player value.
  const config: GameConfig = useMemo(
    () =>
      cloneConfig({
        size: DEFAULT_CONFIG.size,
        players: seatCount,
        clockMs: 0,
        incrementMs: 0,
        moveTimeoutMs: 0,
      }),
    [seatCount],
  );

  // Seat 0 is always the person holding the device. In a bot game every other
  // seat is a bot; in hot-seat every seat is a human taking turns.
  const bots = useMemo<(BotLevel | null)[]>(
    () =>
      Array.from({ length: seatCount }, (_, i) => (i === 0 ? null : botLevel)),
    [seatCount, botLevel],
  );

  const names = useMemo(
    () =>
      Array.from({ length: seatCount }, (_, i) => {
        if (i === 0) return botLevel ? (profile?.name ?? t.common.you) : `${t.room.seat} 1`;
        return botLevel ? t.bot[botLevel] : `${t.room.seat} ${i + 1}`;
      }),
    [seatCount, botLevel, profile, t],
  );

  const local = useLocalGame({ config, bots, names });

  const [hint, setHint] = useState<Move | null>(null);
  const [showResult, setShowResult] = useState(false);
  const [confirmResign, setConfirmResign] = useState(false);

  useEffect(() => {
    if (!local.game.isOver) {
      setShowResult(false);
      return;
    }
    setShowResult(true);
    if (settings.sound) {
      const won = local.winner === 0;
      (won ? sounds.win : sounds.lose)();
    }
  }, [local.game.isOver, local.winner, settings.sound]);

  const seats: SeatView[] = local.seats.map((s) => ({
    index: s.index,
    name: s.name,
    bot: s.bot,
    clockMs: s.clockMs,
    isMe: botLevel ? s.index === 0 : s.index === local.game.turn,
    avatar: s.bot ? '🤖' : (profile?.avatar ?? '🙂'),
  }));

  const askHint = useCallback(async () => {
    const move = await local.hint();
    setHint(move);
    if (!move) toast.push(t.errors.generic, 'error');
    window.setTimeout(() => setHint(null), 5000);
  }, [local, toast, t]);

  const onMove = useCallback(
    (move: Move) => {
      setHint(null);
      if (!local.play(move)) {
        toast.push(t.errors.illegalMove, 'error');
        sounds.error();
      }
    },
    [local, toast, t],
  );

  // In hot-seat mode the board always belongs to whoever is on turn.
  const mySeat = botLevel ? 0 : local.game.turn;

  return (
    <div className="stack">
      <div className="row">
        <BackButton onClick={back} />
        <h1 className="grow truncate" style={{ fontSize: 'var(--text-lg)' }}>
          {botLevel ? `${t.modes.vsBot} · ${t.bot[botLevel]}` : t.home.local}
          {seatCount === 4 ? ` · ${t.setup.fourPlayers}` : ''}
        </h1>
      </div>

      <GameView
        game={local.game}
        seats={seats}
        mySeat={mySeat}
        controllingSeat={local.controllingSeat}
        thinking={local.thinking}
        clockRunning={false}
        lastMove={local.lastMove}
        hintMove={hint}
        onMove={onMove}
        actions={
          <>
            <button
              type="button"
              className="btn btn-sm"
              onClick={local.undo}
              disabled={!local.canUndo}
              title={t.game.undo}
            >
              ⟲<span className="visually-hidden">{t.game.undo}</span>
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void askHint()}
              disabled={local.hinting || local.game.isOver}
              title={t.game.hint}
            >
              {local.hinting ? <span className="spinner" /> : '💡'}
              <span className="visually-hidden">{t.game.hint}</span>
            </button>
            <button
              type="button"
              className="btn btn-sm btn-danger"
              onClick={() => setConfirmResign(true)}
              disabled={local.game.isOver}
              title={t.game.resign}
            >
              ⚑<span className="label-wide">{t.game.resign}</span>
            </button>
          </>
        }
        side={
          <>
            <MoveLog game={local.game} />
            <div className="card card-tight stack-sm">
              <div className="uppercase">{t.game.newGame}</div>
              <button
                type="button"
                className="btn btn-block"
                onClick={() => {
                  local.reset();
                  setShowResult(false);
                }}
              >
                ⟳ {t.game.rematch}
              </button>
              {botLevel ? (
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(78px, 1fr))',
                    gap: 4,
                  }}
                >
                  {BOT_LEVELS.map((level) => (
                    <button
                      key={level}
                      type="button"
                      className="btn btn-sm"
                      aria-pressed={level === botLevel}
                      style={
                        level === botLevel
                          ? {
                              borderColor: 'var(--accent)',
                              background: 'var(--accent-soft)',
                              color: 'var(--accent)',
                            }
                          : undefined
                      }
                      onClick={() => go({ name: 'play-bot', level, seats: seatCount })}
                    >
                      {t.bot[level]}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </>
        }
      />

      <Modal
        open={confirmResign}
        onClose={() => setConfirmResign(false)}
        title={t.game.resign}
      >
        <div className="row" style={{ marginTop: 16 }}>
          <button
            type="button"
            className="btn grow"
            onClick={() => setConfirmResign(false)}
          >
            {t.game.cancel}
          </button>
          <button
            type="button"
            className="btn btn-danger grow"
            onClick={() => {
              local.resign(mySeat);
              setConfirmResign(false);
            }}
          >
            {t.game.resign}
          </button>
        </div>
      </Modal>

      <ResultModal
        open={showResult}
        winner={local.winner}
        mySeat={botLevel ? 0 : null}
        seats={seats}
        ending={local.ending}
        plies={local.game.ply}
        onClose={() => setShowResult(false)}
        onRematch={() => {
          local.reset();
          setShowResult(false);
        }}
        onHome={() => go({ name: 'home' })}
      />
    </div>
  );
}

export function ResultModal({
  open,
  winner,
  mySeat,
  seats,
  ending,
  plies,
  ratingDelta,
  onClose,
  onRematch,
  onHome,
  onReview,
}: {
  open: boolean;
  winner: number | null;
  mySeat: number | null;
  seats: SeatView[];
  ending: string | null;
  plies: number;
  ratingDelta?: { before: number; after: number; delta: number } | null;
  onClose(): void;
  onRematch(): void;
  onHome(): void;
  /** Opens the stored replay. Absent for offline games, which are not stored. */
  onReview?(): void;
}): ReactNode {
  const { t, f } = useI18n();
  const winnerSeat = winner !== null ? seats.find((s) => s.index === winner) : null;
  const outcome =
    winner === null
      ? t.result.draw
      : mySeat === null
        ? f(t.result.winner, {
            name: winnerSeat?.bot ? t.bot[winnerSeat.bot] : (winnerSeat?.name ?? ''),
          })
        : winner === mySeat
          ? t.result.youWin
          : t.result.youLose;

  const tone =
    winner === null ? 'var(--text-muted)' : winner === mySeat || mySeat === null
      ? `var(--p${winner})`
      : 'var(--text-muted)';

  return (
    <Modal open={open} onClose={onClose} title={undefined}>
      <div className="stack" style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 52, lineHeight: 1 }}>
          {winner === null ? '🤝' : winner === mySeat || mySeat === null ? '🏆' : '🫡'}
        </div>
        <h2 style={{ fontSize: 'var(--text-2xl)', color: tone }}>{outcome}</h2>
        <p className="muted small" style={{ marginTop: -8 }}>
          {endingLabel(ending as never, t)} · <span className="nums">{Math.ceil(plies / 2)}</span>{' '}
          {t.result.moves}
        </p>

        {ratingDelta ? (
          <div className="card card-tight row row-center" style={{ gap: 12 }}>
            <span className="uppercase" style={{ margin: 0 }}>
              {t.result.ratingChange}
            </span>
            <span className="nums" style={{ fontWeight: 700 }}>
              {ratingDelta.before} → {ratingDelta.after}
            </span>
            <span
              className="chip"
              style={{
                color: ratingDelta.delta >= 0 ? 'var(--success)' : 'var(--danger)',
              }}
            >
              {ratingDelta.delta >= 0 ? '+' : ''}
              {ratingDelta.delta}
            </span>
          </div>
        ) : null}

        <div className="row" style={{ marginTop: 8 }}>
          <button type="button" className="btn grow" onClick={onHome}>
            {t.result.backHome}
          </button>
          <button type="button" className="btn btn-primary grow" onClick={onRematch}>
            {t.game.rematch}
          </button>
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={onReview ?? onClose}
        >
          {onReview ? `▶ ${t.profile.replay}` : t.result.analyse}
        </button>
      </div>
    </Modal>
  );
}
