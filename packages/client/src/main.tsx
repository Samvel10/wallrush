import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
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
  </StrictMode>,
);

// Offline play against a bot should survive a lost connection.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}
