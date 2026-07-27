import { useEffect, type ReactNode } from 'react';

import { BOT_LEVELS, type BotLevel } from '@wallrush/shared';

import { BrandMark, LanguageSwitch } from './components/ui.js';
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
import { useSession } from './state/session.js';
import { setSoundEnabled } from './state/sound.js';
import { useSettings } from './state/settings.js';

export function App(): ReactNode {
  const { route, go } = useRouter();
  const { t } = useI18n();
  const { settings } = useSettings();
  const { refresh } = useSession();

  useEffect(() => setSoundEnabled(settings.sound), [settings.sound]);

  // Keep one socket for the whole session: it carries the guest identity, the
  // lobby feed and any game already in progress.
  useEffect(() => {
    connection.connect();
    const off = connection.onMessage((msg) => {
      if (msg.t === 'welcome') void refresh();
    });
    return off;
  }, [refresh]);

  const inGame =
    route.name === 'play-bot' ||
    route.name === 'play-local' ||
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
          <LanguageSwitch compact />
        </div>
      </header>

      <main className={`app-main${inGame ? ' is-game' : ' is-narrow'}`}>
        <Screen route={route} />
      </main>

      {!inGame ? <BottomNav /> : null}
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
      return <PlayLocal key={level} botLevel={level} />;
    }
    case 'play-local':
    case 'local':
      return <PlayLocal botLevel={null} />;
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
