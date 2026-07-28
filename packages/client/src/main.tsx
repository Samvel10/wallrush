import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import { connection } from './net/socket.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { ToastProvider } from './components/ui.js';
import { I18nProvider } from './i18n/index.js';
import { RouterProvider } from './state/router.js';
import { SessionProvider } from './state/session.js';
import { SettingsProvider } from './state/settings.js';

import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/board.css';

const container = document.getElementById('root');
if (!container) throw new Error('missing #root');

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <SettingsProvider>
        <I18nProvider>
          <SessionProvider>
            <RouterProvider>
              <ToastProvider>
                <App />
              </ToastProvider>
            </RouterProvider>
          </SessionProvider>
        </I18nProvider>
      </SettingsProvider>
    </ErrorBoundary>
  </StrictMode>,
);

// A tiny diagnostic handle. Support questions about multiplayer almost always
// come down to "is the socket up?", and this answers that from the console
// without a debug build.
declare global {
  interface Window {
    __wallrush?: { connection: typeof connection; state(): string };
  }
}
window.__wallrush = {
  connection,
  state: () => `${connection.state} latency=${connection.latencyMs}ms`,
};

// Offline play against a bot should survive a lost connection.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker
      .register('/sw.js')
      .then((registration) => {
        // A browser only looks for a new service worker when it navigates, and
        // this is a hash router: moving between screens never fetches anything.
        // Without asking, a tab left open can serve yesterday's build for a
        // day — and the "newer version" notice, which waits on the handover,
        // would never fire. Ask on a timer and whenever the tab comes back.
        const check = () => void registration.update().catch(() => undefined);
        window.setInterval(check, 30 * 60 * 1000);
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') check();
        });
      })
      .catch(() => undefined);
  });
}
