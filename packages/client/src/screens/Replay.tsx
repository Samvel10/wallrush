/**
 * Replay.
 *
 * Every finished game is stored as a transcript, so a whole match is a string
 * and replaying it is just applying moves to a fresh board. That also means the
 * analysis view needs no extra storage: distances, walls and the move list are
 * all recomputed from the engine as you scrub.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { Game, MoveKind, moveName, parseTranscript, type GameConfig } from '@wallrush/shared';

import { Board } from '../components/Board.js';
import { BackButton, formatRelative, useToast } from '../components/ui.js';
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
            <div className="move-log">
              {Array.from({ length: Math.ceil(moves.length / 2) }, (_, row) => (
                <ReplayRow
                  key={row}
                  row={row}
                  moves={moves}
                  size={match.config.size}
                  ply={ply}
                  onSelect={(p) => {
                    setPlaying(false);
                    setPly(p);
                  }}
                />
              ))}
            </div>
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

function ReplayRow({
  row,
  moves,
  size,
  ply,
  onSelect,
}: {
  row: number;
  moves: ReturnType<typeof parseTranscript>;
  size: number;
  ply: number;
  onSelect(ply: number): void;
}): ReactNode {
  const a = moves[row * 2];
  const b = moves[row * 2 + 1];
  return (
    <>
      <span className="move-log-num">{row + 1}.</span>
      <button
        type="button"
        className={`move-log-move${ply === row * 2 + 1 ? ' is-current' : ''}`}
        onClick={() => onSelect(row * 2 + 1)}
      >
        {a ? moveName(a, size) : ''}
      </button>
      <button
        type="button"
        className={`move-log-move${ply === row * 2 + 2 ? ' is-current' : ''}`}
        onClick={() => onSelect(row * 2 + 2)}
        disabled={!b}
      >
        {b ? moveName(b, size) : ''}
      </button>
    </>
  );
}

export { MoveKind };
