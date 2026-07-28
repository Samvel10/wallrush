/** Public tables, join-by-code, and the quick-play queue. */

import { useEffect, useState, type ReactNode } from 'react';

import type { RoomInfo, ServerMessage } from '@wallrush/shared';

import { BackButton, useToast } from '../components/ui.js';
import { useI18n } from '../i18n/index.js';
import { connection } from '../net/socket.js';
import { useRouter } from '../state/router.js';

export function Lobby(): ReactNode {
  const { t } = useI18n();
  const { go, back } = useRouter();
  const toast = useToast();
  const [rooms, setRooms] = useState<RoomInfo[]>([]);
  const [online, setOnline] = useState(0);
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    connection.connect();
    connection.send({ t: 'lobby.subscribe' });
    const off = connection.onMessage((msg: ServerMessage) => {
      if (msg.t === 'lobby') {
        setRooms(msg.rooms);
        setOnline(msg.online);
        setLoading(false);
      } else if (msg.t === 'room') {
        go({ name: 'room', code: msg.room.code });
      } else if (msg.t === 'error' && msg.code === 'room-not-found') {
        toast.push(t.errors.roomNotFound, 'error');
      }
    });
    return () => {
      connection.send({ t: 'lobby.unsubscribe' });
      off();
    };
  }, [go, toast, t]);

  const join = (value: string) => {
    const clean = value.trim().toUpperCase();
    if (clean.length < 4) return;
    go({ name: 'room', code: clean });
  };

  return (
    <div className="stack">
      <div className="row">
        <BackButton onClick={back} />
        <h1 className="grow" style={{ fontSize: 'var(--text-xl)' }}>
          {t.home.online}
        </h1>
        <span className="chip chip-live">
          <span className="nums">{online}</span>
        </span>
      </div>

      <form
        className="card card-tight stack-sm"
        onSubmit={(e) => {
          e.preventDefault();
          join(code);
        }}
      >
        <label className="field-label" htmlFor="join-code">
          {t.room.joinByCode}
        </label>
        <div className="row">
          <input
            id="join-code"
            className="input input-code grow"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 5))}
            placeholder="—————"
            maxLength={5}
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            inputMode="text"
          />
          <button type="submit" className="btn btn-primary" disabled={code.length < 4}>
            {t.room.join}
          </button>
        </div>
      </form>

      <div className="row row-between">
        <span className="uppercase">{t.room.title}</span>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={() => go({ name: 'create' })}
        >
          + {t.setup.create}
        </button>
      </div>

      {loading ? (
        <div className="stack-sm">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton" style={{ height: 72 }} />
          ))}
        </div>
      ) : rooms.length === 0 ? (
        <div className="empty-state">
          <span className="empty-state-icon">🪑</span>
          <p>{t.room.noRooms}</p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => go({ name: 'create' })}
          >
            {t.setup.create}
          </button>
        </div>
      ) : (
        <div className="stack-sm">
          {rooms.map((room) => {
            const open = room.seats.filter((s) => !s.user && !s.bot).length;
            const players = room.seats.filter((s) => s.user || s.bot);
            return (
              <button
                key={room.id}
                type="button"
                className="tile"
                onClick={() => go({ name: 'room', code: room.code })}
              >
                <span className="tile-icon">{room.status === 'playing' ? '▶' : '🪑'}</span>
                <span className="tile-body">
                  <span className="tile-title truncate">
                    {room.name || `${t.room.title} ${room.code}`}
                  </span>
                  <span className="tile-sub">
                    {players.map((s) => s.user?.name ?? (s.bot ? '🤖' : '')).join(' · ') || '—'}
                    {' · '}
                    {room.config.mode === 'race'
                      ? `🏁 ${t.setup.race}`
                      : `${room.config.size}×${room.config.size}`}
                    {room.rated ? ' · ★' : ''}
                  </span>
                </span>
                <span className="chip">
                  {open > 0 ? `${open} ${t.room.openSeats}` : t.room.spectate}
                </span>
                <span className="tile-chevron" aria-hidden="true">
                  ›
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function QuickMatch(): ReactNode {
  const { t } = useI18n();
  const { go, back } = useRouter();
  const [waiting, setWaiting] = useState(0);
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    connection.connect();
    connection.send({
      t: 'queue.join',
      config: { size: 9, players: 2, clockMs: 5 * 60 * 1000, incrementMs: 2000 },
      rated: true,
    });
    const off = connection.onMessage((msg) => {
      if (msg.t === 'queue.status') setWaiting(msg.waiting);
      else if (msg.t === 'room') go({ name: 'room', code: msg.room.code });
      else if (msg.t === 'welcome') {
        // A reconnect drops us out of the queue server-side, so rejoin it.
        connection.send({
          t: 'queue.join',
          config: { size: 9, players: 2, clockMs: 5 * 60 * 1000, incrementMs: 2000 },
          rated: true,
        });
      }
    });
    const tick = window.setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => {
      connection.send({ t: 'queue.leave' });
      off();
      window.clearInterval(tick);
    };
  }, [go]);

  return (
    <div className="stack" style={{ alignItems: 'center', paddingTop: 32 }}>
      <div className="row" style={{ alignSelf: 'stretch' }}>
        <BackButton onClick={back} />
        <h1 className="grow" style={{ fontSize: 'var(--text-lg)' }}>
          {t.home.quickPlay}
        </h1>
      </div>

      <div className="card stack" style={{ textAlign: 'center', width: '100%', maxWidth: 400 }}>
        <div style={{ fontSize: 48 }}>⚡</div>
        <span className="spinner" style={{ width: 26, height: 26, margin: '0 auto' }} />
        <p style={{ fontWeight: 700 }}>{t.room.waiting}</p>
        <p className="muted small">
          {waiting > 1 ? `${waiting} · ` : ''}
          <span className="nums mono">
            {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
          </span>
        </p>
        <button type="button" className="btn" onClick={back}>
          {t.game.cancel}
        </button>
      </div>

      <p className="small muted center" style={{ maxWidth: 380 }}>
        {t.home.quickPlaySub}
      </p>
      <button type="button" className="btn btn-ghost" onClick={() => go({ name: 'bots' })}>
        🤖 {t.home.bot}
      </button>
    </div>
  );
}
