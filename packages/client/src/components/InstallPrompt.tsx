/**
 * "Install this" — offered only when the browser says it is possible.
 *
 * Chrome fires `beforeinstallprompt` when a site meets the install criteria
 * and lets you defer it; the deferred event is the only way to open the
 * dialog from a button of your own. Everything here is conditional on that
 * event. Safari on iOS does not expose that event, so it gets its own compact
 * instruction instead: Share → Add to Home Screen.
 */

import { useEffect, useState, type ReactNode } from 'react';

import { useI18n } from '../i18n/index.js';

interface InstallEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferredInstall: InstallEvent | null = null;
const installListeners = new Set<(event: InstallEvent | null) => void>();

function publishInstallEvent(event: InstallEvent | null): void {
  deferredInstall = event;
  for (const listener of installListeners) listener(event);
}

// Keep this at module scope. `beforeinstallprompt` fires only once per page
// visit, and a route change must not throw away the browser's one install
// request before the player taps the button.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    publishInstallEvent(event as InstallEvent);
  });
  window.addEventListener('appinstalled', () => publishInstallEvent(null));
}

function alreadyInstalled(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // iOS reports it here instead.
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

function isIOS(): boolean {
  const { userAgent, platform, maxTouchPoints } = window.navigator;
  return /iPad|iPhone|iPod/.test(userAgent) || (platform === 'MacIntel' && maxTouchPoints > 1);
}

function isAndroid(): boolean {
  return /Android/i.test(window.navigator.userAgent);
}

export function InstallPrompt(): ReactNode {
  const { t } = useI18n();
  const [event, setEvent] = useState<InstallEvent | null>(() => deferredInstall);
  const [busy, setBusy] = useState(false);
  const [ios, setIos] = useState(false);

  useEffect(() => {
    if (alreadyInstalled()) return;
    setIos(isIOS());
    const onEvent = (next: InstallEvent | null) => setEvent(next);
    installListeners.add(onEvent);
    return () => {
      installListeners.delete(onEvent);
    };
  }, []);

  const android = !ios && isAndroid();
  if (!event && !ios && !android) return null;

  return (
    <div className="card row" style={{ gap: 10 }}>
      <span aria-hidden="true" style={{ fontSize: 22 }}>
        📲
      </span>
      <span className="grow small">
        <span style={{ fontWeight: 600 }}>{t.home.install}</span>
        <br />
        <span className="muted tiny">
          {event ? t.home.installSub : ios ? t.home.installIos : t.home.installAndroid}
        </span>
      </span>
      {event ? (
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await event.prompt();
              const { outcome } = await event.userChoice;
              // The event is single-use whatever they chose.
              if (outcome === 'accepted' || outcome === 'dismissed') publishInstallEvent(null);
            } catch {
              publishInstallEvent(null);
            } finally {
              setBusy(false);
            }
          }}
        >
          {t.home.installAction}
        </button>
      ) : null}
    </div>
  );
}
