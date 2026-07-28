/**
 * "There is a newer version — reload."
 *
 * Two ways to end up running yesterday's code. A service worker updates in the
 * background, so an installed app can sit on an old bundle indefinitely until
 * something makes it reload. And the server announces the protocol it speaks
 * in `welcome`; if that is ahead of ours, this tab is a dialect behind and the
 * failures it produces will look like bugs rather than staleness.
 *
 * Neither is worth interrupting a game for, so this is an offer, not a forced
 * reload: the banner waits until the player is ready.
 */

import { useEffect, useState, type ReactNode } from 'react';

import { PROTOCOL_VERSION } from '@wallrush/shared';

import { useI18n } from '../i18n/index.js';
import { connection } from '../net/socket.js';

export function UpdateNotice(): ReactNode {
  const { t } = useI18n();
  const [stale, setStale] = useState(false);

  // The server is speaking a protocol we do not know yet.
  useEffect(
    () =>
      connection.onMessage((msg) => {
        if (msg.t === 'welcome' && msg.version > PROTOCOL_VERSION) setStale(true);
      }),
    [],
  );

  // A new service worker has taken over, so the files on disk have moved on.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    // On a first visit there is no controller yet and the handover is not an
    // update — it is the app arriving.
    const hadController = navigator.serviceWorker.controller !== null;
    const onChange = () => {
      if (hadController) setStale(true);
    };
    navigator.serviceWorker.addEventListener('controllerchange', onChange);
    return () => navigator.serviceWorker.removeEventListener('controllerchange', onChange);
  }, []);

  if (!stale) return null;

  return (
    <div
      className="toasts"
      style={{ bottom: 'auto', top: 'calc(64px + env(safe-area-inset-top))' }}
    >
      <div className="toast" style={{ gap: 10 }}>
        <span aria-hidden="true">✨</span>
        <span className="grow">{t.common.updateReady}</span>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={() => window.location.reload()}
        >
          {t.common.updateReload}
        </button>
      </div>
    </div>
  );
}
