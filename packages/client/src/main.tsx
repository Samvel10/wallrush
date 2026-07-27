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
    void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}
