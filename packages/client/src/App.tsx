import { useEffect, type ReactNode } from 'react';

import { BOT_LEVELS, type BotLevel } from '@wallrush/shared';

import { FriendInvites, ReplacedNotice } from './components/Friends.js';
import { UpdateNotice } from './components/UpdateNotice.js';
import { BrandMark, LanguageSwitch, ThemeToggle } from './components/ui.js';
import { useI18n } from './i18n/index.js';
import { connection } from './net/socket.js';
import { Auth, Leaderboard, ProfileScreen } from './screens/Account.js';
import { BotPicker } from './screens/BotPicker.js';
import { CreateRoom } from './screens/CreateRoom.js';
import { Home } from './screens/Home.js';
import { Lobby, QuickMatch } from './screens/Lobby.js';
import { PlayLocal } from './screens/PlayLocal.js';
import { Room } from './screens/Room.js';
import { Replay } from './screens/Replay.js';
import { Rules } from './screens/Rules.js';
import { useRouter, type Route } from './state/router.js';
import { setSoundEnabled } from './state/sound.js';
import { useSettings } from './state/settings.js';

export function App(): ReactNode {
  const { route, go } = useRouter();
  const { t } = useI18n();
  const { settings } = useSettings();

  useEffect(() => setSoundEnabled(settings.sound), [settings.sound]);

  // Keep one socket for the whole session: it carries the guest identity, the
  // lobby feed and any game already in progress. The session provider listens
  // for the welcome message itself, so there is nothing to wire up here.
  useEffect(() => {
    connection.connect();
  }, []);

  // `/local` and `/play-local` are the same screen under two names; both need
  // the wide layout, or the board is squeezed into the narrow reading column.
  const inGame =
    route.name === 'play-bot' ||
    route.name === 'play-local' ||
    route.name === 'local' ||
    route.name === 'room' ||
    route.name === 'replay';

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <button
            type="button"
            className="brand"
            onClick={() => go({ name: 'home' })}
            aria-label={t.nav.home}
          >
            <BrandMark />
            <span>{t.app.title}</span>
          </button>
          <span className="grow" />
          <ThemeToggle />
          <LanguageSwitch compact />
        </div>
      </header>

      <main className={`app-main${inGame ? ' is-game' : ' is-narrow'}`}>
        <Screen route={route} />
      </main>
        <footer className={`app-footer${inGame ? ' is-game' : ''}`}>
          <div className="footer-inner">
          <div className="footer-brand">
            <BrandMark size={24} />
            <div>
              <span className="footer-wordmark">WallRush</span>
            </div>
          </div>
          <div className="footer-details">
            <div className="footer-credit">
              <p className="footer-label">{t.app.createdBy}</p>
              <p className="footer-name">Samvel Khachatryan</p>
            </div>
            <a className="footer-contact" href="tel:098213305">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3.1-8.7A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.9a2 2 0 0 1-.5 2.1L8 10a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c.9.3 1.9.6 2.9.7a2 2 0 0 1 1.7 2Z" />
              </svg>
              <span>
                <span className="visually-hidden">{t.app.contactCreator} </span>
                <span className="footer-number">098 213 305</span>
              </span>
              <span className="footer-arrow" aria-hidden="true">↗</span>
            </a>
          </div>
          </div>
        </footer>

      {!inGame ? <BottomNav /> : null}
      <UpdateNotice />
      <FriendInvites />
      <ReplacedNotice />
    </div>
  );
}

function Screen({ route }: { route: Route }): ReactNode {
  switch (route.name) {
    case 'home':
      return <Home />;
    case 'bots':
      return <BotPicker />;
    case 'play-bot': {
      const level = (BOT_LEVELS as string[]).includes(route.level)
        ? (route.level as BotLevel)
        : 'medium';
      const seats = route.seats === 4 ? 4 : 2;
      const mode = route.mode ?? 'duel';
      return (
        <PlayLocal key={`${level}-${seats}-${mode}`} botLevel={level} seats={seats} mode={mode} />
      );
    }
    case 'play-local':
    case 'local':
      return <PlayLocal key={route.mode ?? 'duel'} botLevel={null} mode={route.mode ?? 'duel'} />;
    case 'lobby':
      return <Lobby />;
    case 'quick':
      return <QuickMatch />;
    case 'create':
      return <CreateRoom />;
    case 'room':
      return <Room key={route.code} code={route.code} />;
    case 'leaderboard':
      return <Leaderboard />;
    case 'profile':
    case 'settings':
      return <ProfileScreen />;
    case 'auth':
      return <Auth mode={route.mode} />;
    case 'rules':
      return <Rules />;
    case 'replay':
      return <Replay key={route.id} id={route.id} />;
    default:
      return <Home />;
  }
}

function BottomNav(): ReactNode {
  const { t } = useI18n();
  const { route, go } = useRouter();
  const items: { name: Route['name']; icon: string; label: string; route: Route }[] = [
    { name: 'home', icon: '🏠', label: t.nav.home, route: { name: 'home' } },
    { name: 'lobby', icon: '🌐', label: t.nav.play, route: { name: 'lobby' } },
    {
      name: 'leaderboard',
      icon: '🏆',
      label: t.nav.leaderboard,
      route: { name: 'leaderboard' },
    },
    { name: 'profile', icon: '👤', label: t.nav.profile, route: { name: 'profile' } },
  ];

  return (
    <nav className="bottom-nav">
      <div className="bottom-nav-inner">
        {items.map((item) => (
          <button
            key={item.name}
            type="button"
            className="bottom-nav-item"
            aria-current={route.name === item.name ? 'page' : undefined}
            onClick={() => go(item.route)}
          >
            <span className="bottom-nav-icon" aria-hidden="true">
              {item.icon}
            </span>
            <span>{item.label}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}
