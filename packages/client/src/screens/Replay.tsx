/**
 * Replay.
 *
 * Every finished game is stored as a transcript, so a whole match is a string
 * and replaying it is just applying moves to a fresh board. That also means the
 * analysis view needs no extra storage: distances, walls and the move list are
 * all recomputed from the engine as you scrub.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import {
  Game,
  MoveKind,
  moveName,
  parseTranscript,
  type GameConfig,
  type Move,
  type MoveQuality,
} from '@wallrush/shared';

import { Board } from '../components/Board.js';
import { seatColorVar } from '../components/geometry.js';
import { BackButton, formatRelative, useToast } from '../components/ui.js';
import { useBotWorker } from '../hooks/useBotWorker.js';
import { useI18n } from '../i18n/index.js';
import { api } from '../net/api.js';
import { useRouter } from '../state/router.js';
import { useSettings } from '../state/settings.js';

interface MatchData {
  id: string;
  transcript: string;
  config: GameConfig;
  players: { seat: number; name: string; bot: string | null }[];
  winnerSeat: number | null;
  ending: string;
  plies: number;
  finishedAt: number;
}

export function Replay({ id }: { id: string }): ReactNode {
  const { t, lang } = useI18n();
  const { back } = useRouter();
  const { settings } = useSettings();
  const toast = useToast();
  const [match, setMatch] = useState<MatchData | null>(null);
  const [error, setError] = useState(false);
  const [ply, setPly] = useState(0);
  const [playing, setPlaying] = useState(false);
  const timer = useRef<number | null>(null);
  const { analyse } = useBotWorker();
  const [review, setReview] = useState<(MoveReview | null)[]>([]);
  const [reviewing, setReviewing] = useState(false);
  const cancelReview = useRef(false);

  useEffect(() => {
    let alive = true;
    void api
      .match(id)
      .then((r) => {
        if (!alive) return;
        setMatch(r.match as unknown as MatchData);
        setPly(r.match.plies);
      })
      .catch(() => {
        if (alive) setError(true);
      });
    return () => {
      alive = false;
    };
  }, [id]);

  const moves = useMemo(
    () => (match ? parseTranscript(match.transcript, match.config.size) : []),
    [match],
  );
  const seatCount = match?.config.players ?? 2;

  // Rebuild the position from scratch at the requested ply. Replaying up to a
  // hundred moves is microseconds, so there is nothing to cache.
  const game = useMemo(() => {
    if (!match) return null;
    const g = new Game(match.config);
    for (let i = 0; i < Math.min(ply, moves.length); i++) {
      if (!g.apply(moves[i]).ok) break;
    }
    return g;
  }, [match, moves, ply]);

  // Analysis walks the game once, asking the engine what it would have played
  // at each turn and what the move actually chosen was worth. Results stream in
  // ply by ply so the list fills up as it goes rather than after a long wait.
  const runReview = useCallback(async () => {
    if (!match || reviewing) return;
    setReviewing(true);
    cancelReview.current = false;
    setReview(new Array(moves.length).fill(null));
    const board = new Game(match.config);
    for (let i = 0; i < moves.length; i++) {
      if (cancelReview.current) break;
      const move = moves[i];
      if (board.isOver) break;
      const result = await analyse(board, move, 'hard', 260);
      if (cancelReview.current) break;
      if (result.analysis) {
        const a = result.analysis;
        setReview((prev) => {
          const next = [...prev];
          next[i] = {
            quality: a.quality,
            loss: a.loss,
            best: a.best,
            mover: a.mover,
          };
          return next;
        });
      }
      if (!board.apply(move).ok) break;
    }
    setReviewing(false);
  }, [match, moves, analyse, reviewing]);

  useEffect(
    () => () => {
      cancelReview.current = true;
    },
    [],
  );

  const step = useCallback(
    (delta: number) => {
      setPly((p) => Math.max(0, Math.min(moves.length, p + delta)));
    },
    [moves.length],
  );

  useEffect(() => {
    if (!playing) return;
    if (ply >= moves.length) {
      setPlaying(false);
      return;
    }
    timer.current = window.setTimeout(() => setPly((p) => p + 1), 750);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [playing, ply, moves.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') step(-1);
      else if (e.key === 'ArrowRight') step(1);
      else if (e.key === 'Home') setPly(0);
      else if (e.key === 'End') setPly(moves.length);
      else if (e.key === ' ') {
        e.preventDefault();
        setPlaying((p) => !p);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step, moves.length]);

  if (error) {
    return (
      <div className="stack">
        <div className="row">
          <BackButton onClick={back} />
          <h1 style={{ fontSize: 'var(--text-xl)' }}>{t.profile.replay}</h1>
        </div>
        <div className="empty-state">
          <span className="empty-state-icon">🔍</span>
          <p>{t.errors.generic}</p>
        </div>
      </div>
    );
  }

  if (!match || !game) {
    return (
      <div className="stack" style={{ alignItems: 'center', paddingTop: 48 }}>
        <span className="spinner" style={{ width: 28, height: 28 }} />
        <p className="muted">{t.common.loading}</p>
      </div>
    );
  }

  const current = ply > 0 ? (review[ply - 1] ?? null) : null;

  const nameOf = (seat: number): string => {
    const p = match.players.find((x) => x.seat === seat);
    if (!p) return `#${seat + 1}`;
    if (p.bot) return `${t.common.bot} · ${(t.bot as Record<string, string>)[p.bot] ?? p.bot}`;
    return p.name;
  };

  return (
    <div className="stack">
      <div className="row">
        <BackButton onClick={back} />
        <h1 className="grow truncate" style={{ fontSize: 'var(--text-lg)' }}>
          {t.profile.replay}
        </h1>
        <span className="chip tiny">{formatRelative(match.finishedAt, lang)}</span>
      </div>

      <div className="game-layout">
        <div className="game-stage">
          <div className="row row-wrap" style={{ gap: 6, justifyContent: 'center' }}>
            {match.players.map((p) => (
              <span
                key={p.seat}
                className="chip"
                style={
                  {
                    color: `var(--p${p.seat})`,
                    borderColor: `color-mix(in oklab, var(--p${p.seat}) 35%, transparent)`,
                    fontWeight: match.winnerSeat === p.seat ? 800 : 600,
                  } as React.CSSProperties
                }
              >
                {match.winnerSeat === p.seat ? '🏆 ' : ''}
                {nameOf(p.seat)}
                {' · '}
                <span className="nums">{game.players[p.seat]?.walls ?? 0}</span>🧱
              </span>
            ))}
          </div>

          <Board
            game={game}
            mySeat={null}
            activeSeat={null}
            interactive={false}
            mode="move"
            orientation={0}
            showCoordinates={settings.showCoordinates}
            onStep={() => undefined}
            onWall={() => undefined}
          />

          <div className="game-toolbar">
            <button type="button" className="btn btn-sm" onClick={() => setPly(0)} title="⏮">
              ⏮
            </button>
            <button type="button" className="btn btn-sm" onClick={() => step(-1)} disabled={ply === 0}>
              ‹
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => setPlaying((p) => !p)}
              disabled={ply >= moves.length}
              style={{ minWidth: 64 }}
            >
              {playing ? '⏸' : '▶'}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => step(1)}
              disabled={ply >= moves.length}
            >
              ›
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setPly(moves.length)} title="⏭">
              ⏭
            </button>
            <span className="chip mono">
              {ply}/{moves.length}
            </span>
          </div>

          <input
            type="range"
            min={0}
            max={moves.length}
            value={ply}
            onChange={(e) => {
              setPlaying(false);
              setPly(Number(e.target.value));
            }}
            style={{ width: '100%', accentColor: 'var(--accent)' }}
            aria-label={t.game.moveList}
          />
        </div>

        <aside className="game-side stack">
          <div className="card card-tight">
            <div className="uppercase" style={{ marginBottom: 8 }}>
              {t.game.moveList}
            </div>
            <div
              className="move-log"
              style={{ '--log-cols': seatCount } as React.CSSProperties}
            >
              {Array.from({ length: Math.ceil(moves.length / seatCount) }, (_, row) => (
                <ReplayRow
                  key={row}
                  row={row}
                  seats={seatCount}
                  moves={moves}
                  size={match.config.size}
                  ply={ply}
                  review={review}
                  onSelect={(p) => {
                    setPlaying(false);
                    setPly(p);
                  }}
                />
              ))}
            </div>
          </div>

          <div className="card card-tight stack-sm">
            <div className="row row-between">
              <span className="uppercase" style={{ margin: 0 }}>
                {t.profile.analysis}
              </span>
              {review.some(Boolean) ? (
                <span className="tiny faint nums">
                  {review.filter(Boolean).length}/{moves.length}
                </span>
              ) : null}
            </div>

            {review.length === 0 ? (
              <button type="button" className="btn btn-block btn-sm" onClick={() => void runReview()}>
                🔎 {t.profile.analyse}
              </button>
            ) : (
              <>
                {reviewing ? (
                  <button
                    type="button"
                    className="btn btn-block btn-sm"
                    onClick={() => {
                      cancelReview.current = true;
                      setReviewing(false);
                    }}
                  >
                    <span className="spinner" /> {t.profile.analysing}
                  </button>
                ) : null}
                <ReviewSummary review={review} match={match} nameOf={nameOf} />
                {current ? (
                  <p className="tiny muted" style={{ margin: 0 }}>
                    {t.profile.bestMove}:{' '}
                    <span className="mono">{moveName(current.best, match.config.size)}</span>
                    {current.loss > 15 ? (
                      <>
                        {' · '}
                        <span className="nums">{(current.loss / 110).toFixed(1)}</span>{' '}
                        {t.profile.lostTempo}
                      </>
                    ) : null}
                  </p>
                ) : null}
              </>
            )}
          </div>

          <div className="card card-tight stack-sm">
            <div className="uppercase">{t.game.distance}</div>
            {game.players.map((p) => {
              const d = game.distanceFor(p.index);
              return (
                <div key={p.index} className="row row-between">
                  <span className="small truncate" style={{ color: `var(--p${p.index})` }}>
                    {nameOf(p.index)}
                  </span>
                  <span className="nums" style={{ fontWeight: 700 }}>
                    {d < 0 ? '—' : d}
                  </span>
                </div>
              );
            })}
          </div>

          <button
            type="button"
            className="btn btn-block btn-sm"
            onClick={() => {
              void navigator.clipboard
                .writeText(match.transcript)
                .then(() => toast.push(t.room.copied, 'success'))
                .catch(() => toast.push(match.transcript));
            }}
          >
            📋 {match.transcript.split(' ').length} {t.result.moves}
          </button>
        </aside>
      </div>
    </div>
  );
}

interface MoveReview {
  quality: MoveQuality;
  loss: number;
  best: Move;
  mover: number;
}

/** Chess-style shorthand, so the marker reads at a glance. */
const QUALITY_MARK: Record<MoveQuality, string> = {
  best: '',
  good: '',
  inaccuracy: '?!',
  mistake: '?',
  blunder: '??',
};

const QUALITY_COLOR: Record<MoveQuality, string> = {
  best: 'var(--success)',
  good: 'var(--text-muted)',
  inaccuracy: 'var(--warning)',
  mistake: 'var(--p1)',
  blunder: 'var(--danger)',
};

function ReplayRow({
  row,
  seats,
  moves,
  size,
  ply,
  review,
  onSelect,
}: {
  row: number;
  seats: number;
  moves: ReturnType<typeof parseTranscript>;
  size: number;
  ply: number;
  review: (MoveReview | null)[];
  onSelect(ply: number): void;
}): ReactNode {
  const cell = (index: number, seat: number): ReactNode => {
    const move = moves[index];
    if (!move) return null;
    const r = review[index];
    const mark = r ? QUALITY_MARK[r.quality] : '';
    return (
      <button
        key={seat}
        type="button"
        className={`move-log-move${seats > 2 ? ' has-seat' : ''}${
          ply === index + 1 ? ' is-current' : ''
        }`}
        style={{ '--seat-color': seatColorVar(seat) } as React.CSSProperties}
        onClick={() => onSelect(index + 1)}
        title={r ? `${r.quality} · ${(r.loss / 110).toFixed(1)}` : undefined}
      >
        {moveName(move, size)}
        {mark ? (
          <span style={{ color: r ? QUALITY_COLOR[r.quality] : undefined, fontWeight: 800 }}>
            {mark}
          </span>
        ) : null}
      </button>
    );
  };
  return (
    <>
      <span className="move-log-num">{row + 1}.</span>
      {Array.from({ length: seats }, (_, seat) => cell(row * seats + seat, seat) ?? (
        <span key={seat} />
      ))}
    </>
  );
}

/** Per-player tally of how the game was actually played. */
function ReviewSummary({
  review,
  match,
  nameOf,
}: {
  review: (MoveReview | null)[];
  match: MatchData;
  nameOf(seat: number): string;
}): ReactNode {
  const { t } = useI18n();
  const seats = Array.from({ length: match.config.players }, (_, seat) => {
    const mine = review.filter((r, i) => r && i % match.config.players === seat) as MoveReview[];
    const count = (q: MoveQuality) => mine.filter((r) => r.quality === q).length;
    const avgLoss = mine.length
      ? mine.reduce((sum, r) => sum + r.loss, 0) / mine.length / 110
      : 0;
    return { seat, mine, count, avgLoss };
  });

  return (
    <div className="stack-sm">
      {seats.map(({ seat, mine, count, avgLoss }) =>
        mine.length === 0 ? null : (
          <div key={seat} className="stack-sm" style={{ gap: 2 }}>
            <div className="row row-between">
              <span className="small truncate" style={{ color: `var(--p${seat})`, fontWeight: 700 }}>
                {nameOf(seat)}
              </span>
              <span className="tiny faint nums" title={t.profile.lostTempo}>
                ⌀ {avgLoss.toFixed(2)}
              </span>
            </div>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              {(['best', 'good', 'inaccuracy', 'mistake', 'blunder'] as MoveQuality[]).map((q) =>
                count(q) === 0 ? null : (
                  <span
                    key={q}
                    className="chip tiny"
                    style={{ color: QUALITY_COLOR[q], borderColor: 'transparent' }}
                    title={t.profile.quality[q]}
                  >
                    {t.profile.quality[q]} <span className="nums">{count(q)}</span>
                  </span>
                ),
              )}
            </div>
          </div>
        ),
      )}
    </div>
  );
}

export { MoveKind };
