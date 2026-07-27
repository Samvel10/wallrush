import { useEffect, useState, type ReactNode } from 'react';

import { useI18n } from '../i18n/index.js';
import { api } from '../net/api.js';
import { connection } from '../net/socket.js';
import { useRouter } from '../state/router.js';
import { useSession } from '../state/session.js';
import { BrandMark, Tile } from '../components/ui.js';

export function Home(): ReactNode {
  const { t } = useI18n();
  const { go } = useRouter();
  const { profile } = useSession();
  const [online, setOnline] = useState<number | null>(null);
  const [inGame, setInGame] = useState<number>(0);
  const [resumeCode, setResumeCode] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void api
      .health()
      .then((h) => {
        if (alive) setOnline(h.online);
      })
      .catch(() => {
        if (alive) setOnline(null);
      });
    const off = connection.onMessage((msg) => {
      if (msg.t === 'lobby') {
        setOnline(msg.online);
        setInGame(msg.inGame);
      } else if (msg.t === 'welcome') {
        setOnline(msg.online);
      } else if (msg.t === 'room' || msg.t === 'game.start') {
        // The server re-attaches us to a table we are still seated at, so this
        // arrives unprompted after a refresh or a dropped connection.
        setResumeCode(msg.room.code);
      } else if (msg.t === 'room.closed') {
        setResumeCode(null);
      }
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  return (
    <div className="stack-lg">
      <header className="stack-sm" style={{ alignItems: 'center', textAlign: 'center' }}>
        <BrandMark size={64} />
        <h1 style={{ fontSize: 'var(--text-3xl)', marginTop: 4 }}>{t.app.title}</h1>
        <p className="uppercase" style={{ marginTop: -4 }}>
          {t.app.tagline}
        </p>
        {online !== null ? (
          <span className="chip chip-live" style={{ marginTop: 4 }}>
            <span className="nums">{online}</span> {t.home.playersOnline}
            {inGame > 0 ? (
              <>
                {' · '}
                <span className="nums">{inGame}</span> {t.home.inGame}
              </>
            ) : null}
          </span>
        ) : null}
      </header>

      <div className="stack-sm">
        {resumeCode ? (
          <Tile
            icon="↩"
            title={t.home.continue}
            sub={resumeCode}
            tint="var(--success)"
            onClick={() => go({ name: 'room', code: resumeCode })}
          />
        ) : null}
        <Tile
          hero
          icon="⚡"
          title={t.home.quickPlay}
          sub={t.home.quickPlaySub}
          onClick={() => go({ name: 'quick' })}
        />
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: 'var(--space-2)',
          }}
        >
          <Tile
            icon="🌐"
            title={t.home.online}
            sub={t.home.onlineSub}
            tint="var(--p0)"
            onClick={() => go({ name: 'lobby' })}
          />
          <Tile
            icon="🤝"
            title={t.home.friend}
            sub={t.home.friendSub}
            tint="var(--p2)"
            onClick={() => go({ name: 'create' })}
          />
        </div>
        <Tile
          icon="🤖"
          title={t.home.bot}
          sub={t.home.botSub}
          tint="var(--p1)"
          onClick={() => go({ name: 'bots' })}
        />
        <Tile
          icon="👥"
          title={t.home.local}
          sub={t.home.localSub}
          tint="var(--p3)"
          onClick={() => go({ name: 'play-local' })}
        />
        <Tile
          icon="📖"
          title={t.home.howTo}
          sub={t.home.howToSub}
          onClick={() => go({ name: 'rules' })}
        />
      </div>

      {profile && profile.guest ? (
        <div className="card card-tight stack-sm">
          <p className="small muted" style={{ margin: 0 }}>
            {t.auth.guestNote}
          </p>
          <div className="row">
            <button
              type="button"
              className="btn btn-primary grow"
              onClick={() => go({ name: 'auth', mode: 'up' })}
            >
              {t.auth.signUp}
            </button>
            <button
              type="button"
              className="btn grow"
              onClick={() => go({ name: 'auth', mode: 'in' })}
            >
              {t.auth.signIn}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
