/** Create a table: format presets plus every knob for people who want them. */

import { useEffect, useRef, useState, type ReactNode } from 'react';

import {
  defaultWallsFor,
  type BoardSize,
  type GameConfig,
  type GameMode,
} from '@wallrush/shared';

import { BackButton, Switch, useToast } from '../components/ui.js';
import { useI18n } from '../i18n/index.js';
import { connection } from '../net/socket.js';
import { useRouter } from '../state/router.js';

interface Preset {
  key: 'blitz' | 'rapid' | 'classic';
  clockMs: number;
  incrementMs: number;
  moveTimeoutMs: number;
}

const PRESETS: Preset[] = [
  { key: 'blitz', clockMs: 3 * 60_000, incrementMs: 2000, moveTimeoutMs: 20_000 },
  { key: 'rapid', clockMs: 5 * 60_000, incrementMs: 3000, moveTimeoutMs: 30_000 },
  { key: 'classic', clockMs: 10 * 60_000, incrementMs: 5000, moveTimeoutMs: 60_000 },
];

const SIZES: BoardSize[] = [5, 7, 9, 11];

export function CreateRoom(): ReactNode {
  const { t } = useI18n();
  const { go, back } = useRouter();
  const toast = useToast();
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'private'>('private');
  const [rated, setRated] = useState(true);
  const [mode, setMode] = useState<GameMode>('duel');
  const [players, setPlayers] = useState<2 | 4>(2);
  const [size, setSize] = useState<BoardSize>(9);
  const [walls, setWalls] = useState(10);
  const [preset, setPreset] = useState<Preset>(PRESETS[1]);
  const [creating, setCreating] = useState(false);
  // The server greets a reconnect with the room it still has us in. Only a
  // `room` that answers *our* create should move us on, or opening this screen
  // straight after a game bounces you back into the old table.
  const awaitingCreate = useRef(false);

  useEffect(() => setWalls(defaultWallsFor(players, size, mode)), [players, size, mode]);

  useEffect(() => {
    connection.connect();
    return connection.onMessage((msg) => {
      if (msg.t === 'room') {
        if (!awaitingCreate.current) return;
        awaitingCreate.current = false;
        setCreating(false);
        go({ name: 'room', code: msg.room.code });
      } else if (msg.t === 'error') {
        awaitingCreate.current = false;
        // Never leave the button spinning on a refusal — say what happened and
        // let the player try again.
        setCreating(false);
        const key = msg.code.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
        toast.push((t.errors as Record<string, string>)[key] ?? t.errors.generic, 'error');
      }
    });
  }, [go, toast, t]);

  // A dropped socket must not strand the player on a dead button either.
  useEffect(() => {
    if (!creating) return;
    const id = window.setTimeout(() => {
      setCreating(false);
      toast.push(t.errors.network, 'error');
      connection.connect();
    }, 6000);
    return () => window.clearTimeout(id);
  }, [creating, toast, t]);

  const create = () => {
    const config: Partial<GameConfig> = {
      size,
      mode,
      players,
      wallsPerPlayer: walls,
      clockMs: preset.clockMs,
      incrementMs: preset.incrementMs,
      moveTimeoutMs: preset.moveTimeoutMs,
    };
    setCreating(true);
    awaitingCreate.current = true;
    connection.send({ t: 'room.create', name, visibility, config, rated });
  };

  return (
    <div className="stack">
      <div className="row">
        <BackButton onClick={back} />
        <h1 className="grow" style={{ fontSize: 'var(--text-xl)' }}>
          {t.setup.title}
        </h1>
      </div>

      <div className="card stack">
        <div className="field">
          <label className="field-label" htmlFor="room-name">
            {t.setup.roomName}
          </label>
          <input
            id="room-name"
            className="input"
            value={name}
            maxLength={32}
            onChange={(e) => setName(e.target.value)}
            placeholder="…"
          />
        </div>

        <div className="field">
          <span className="field-label">{t.setup.mode}</span>
          <div className="segmented segmented-block">
            <button
              type="button"
              className="segmented-item"
              aria-pressed={mode === 'duel'}
              onClick={() => setMode('duel')}
            >
              <span className="seg-emoji">⚔️</span> {t.setup.duel}
            </button>
            <button
              type="button"
              className="segmented-item"
              aria-pressed={mode === 'race'}
              onClick={() => setMode('race')}
            >
              <span className="seg-emoji">🏁</span> {t.setup.race}
            </button>
          </div>
          <p className="tiny faint" style={{ margin: 0 }}>
            {mode === 'race' ? t.setup.raceHint : t.setup.duelHint}
          </p>
        </div>

        <div className="field">
          <span className="field-label">{t.setup.presets}</span>
          <div className="segmented segmented-block">
            {PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                className="segmented-item"
                aria-pressed={preset.key === p.key}
                onClick={() => setPreset(p)}
              >
                {t.setup[p.key]}
                <span className="tiny faint">
                  {p.clockMs / 60000}+{p.incrementMs / 1000}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="field" hidden={mode === 'race'}>
          <span className="field-label">{t.setup.players}</span>
          <div className="segmented segmented-block">
            <button
              type="button"
              className="segmented-item"
              aria-pressed={players === 2}
              onClick={() => setPlayers(2)}
            >
              {t.setup.twoPlayers}
            </button>
            <button
              type="button"
              className="segmented-item"
              aria-pressed={players === 4}
              onClick={() => setPlayers(4)}
            >
              {t.setup.fourPlayers}
            </button>
          </div>
        </div>

        <div className="field" hidden={mode === 'race'}>
          <span className="field-label">{t.setup.boardSize}</span>
          <div className="segmented segmented-block">
            {SIZES.map((s) => (
              <button
                key={s}
                type="button"
                className="segmented-item"
                aria-pressed={size === s}
                onClick={() => setSize(s)}
              >
                {s}×{s}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="walls">
            {t.setup.walls}: <span className="nums">{walls}</span>
          </label>
          <input
            id="walls"
            type="range"
            min={0}
            max={mode === 'race' ? 20 : size >= 9 ? 14 : 8}
            value={walls}
            onChange={(e) => setWalls(Number(e.target.value))}
            style={{ width: '100%', accentColor: 'var(--accent)' }}
          />
        </div>

        <div className="field">
          <span className="field-label">{t.setup.visibility}</span>
          <div className="segmented segmented-block">
            <button
              type="button"
              className="segmented-item"
              aria-pressed={visibility === 'private'}
              onClick={() => setVisibility('private')}
            >
              🔒 {t.setup.private}
            </button>
            <button
              type="button"
              className="segmented-item"
              aria-pressed={visibility === 'public'}
              onClick={() => setVisibility('public')}
            >
              🌐 {t.setup.public}
            </button>
          </div>
        </div>

        <Switch checked={rated} onChange={setRated} label={t.setup.rated} />
      </div>

      <button
        type="button"
        className="btn btn-primary btn-lg btn-block"
        onClick={create}
        disabled={creating}
      >
        {creating ? <span className="spinner" /> : null}
        {t.setup.create}
      </button>
    </div>
  );
}
