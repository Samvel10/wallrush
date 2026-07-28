/**
 * "Install this" — offered only when the browser says it is possible.
 *
 * Chrome fires `beforeinstallprompt` when a site meets the install criteria
 * and lets you defer it; the deferred event is the only way to open the
 * dialog from a button of your own. Everything here is conditional on that
 * event, so browsers that do not fire it (Safari, and Chrome once the app is
 * installed) simply see nothing.
 */

import { useEffect, useState, type ReactNode } from 'react';

import { useI18n } from '../i18n/index.js';

interface InstallEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function alreadyInstalled(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // iOS reports it here instead.
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

export function InstallPrompt(): ReactNode {
  const { t } = useI18n();
  const [event, setEvent] = useState<InstallEvent | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (alreadyInstalled()) return;
    const onPrompt = (e: Event) => {
      // Without this the browser shows its own banner on its own schedule,
      // which is easy to miss and impossible to place.
      e.preventDefault();
      setEvent(e as InstallEvent);
    };
    const onInstalled = () => setEvent(null);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (!event) return null;

  return (
    <div className="card row" style={{ gap: 10 }}>
      <span aria-hidden="true" style={{ fontSize: 22 }}>
        📲
      </span>
      <span className="grow small">
        <span style={{ fontWeight: 600 }}>{t.home.install}</span>
        <br />
        <span className="muted tiny">{t.home.installSub}</span>
      </span>
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
            if (outcome === 'accepted' || outcome === 'dismissed') setEvent(null);
          } catch {
            setEvent(null);
          } finally {
            setBusy(false);
          }
        }}
      >
        {t.home.installAction}
      </button>
    </div>
  );
}
