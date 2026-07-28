/**
 * Friends.
 *
 * Deliberately small: a list of people you have played, who is online, and a
 * button to pull them into your table. Requests are only possible between
 * players who have actually met over a board, which is the whole social graph
 * this game needs and leaves no way to pester a stranger from the leaderboard.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { useI18n } from '../i18n/index.js';
import { ApiError, api, type Friend } from '../net/api.js';
import { connection } from '../net/socket.js';
import { useRouter } from '../state/router.js';
import { useToast } from './ui.js';

export function useFriends(enabled: boolean): {
  friends: Friend[];
  loading: boolean;
  reload(): void;
} {
  const [friends, setFriends] = useState<Friend[]>([]);
  const [loading, setLoading] = useState(enabled);

  const reload = useCallback(() => {
    if (!enabled) {
      setFriends([]);
      setLoading(false);
      return;
    }
    void api
      .friends()
      .then((r) => setFriends(r.friends))
      .catch(() => setFriends([]))
      .finally(() => setLoading(false));
  }, [enabled]);

  useEffect(() => reload(), [reload]);

  // The server tells us when a request is accepted, and a fresh connection
  // means somebody's online state may have changed.
  useEffect(
    () =>
      connection.onMessage((msg) => {
        if (msg.t === 'friends.changed' || msg.t === 'welcome') reload();
      }),
    [reload],
  );

  return { friends, loading, reload };
}

export function FriendsCard({ signedIn }: { signedIn: boolean }): ReactNode {
  const { t } = useI18n();
  const { go } = useRouter();
  const toast = useToast();
  const { friends, loading, reload } = useFriends(signedIn);
  const [busy, setBusy] = useState<string | null>(null);

  const act = useCallback(
    async (id: string, what: 'accept' | 'remove' | 'invite') => {
      setBusy(id);
      try {
        if (what === 'remove') {
          await api.removeFriend(id);
        } else if (what === 'accept') {
          await api.addFriend(id);
        } else {
          connection.send({ t: 'friend.invite', userId: id });
          toast.push(t.friends.invited, 'success');
        }
        if (what !== 'invite') reload();
      } catch (err) {
        const code = err instanceof ApiError ? err.code : 'generic';
        const message =
          code === 'not-played'
            ? t.friends.notPlayed
            : code === 'guest'
              ? t.friends.guestCannot
              : t.errors.generic;
        toast.push(message, 'error');
      } finally {
        setBusy(null);
      }
    },
    [reload, toast, t],
  );

  if (!signedIn) return null;

  const accepted = friends.filter((f) => f.status === 'accepted');
  const requests = friends.filter((f) => f.status === 'pending');

  return (
    <div className="card stack">
      <div className="row row-between">
        <h2 style={{ fontSize: 'var(--text-lg)' }}>{t.friends.title}</h2>
        {accepted.length > 0 ? (
          <span className="chip tiny">
            <span className="nums">{accepted.filter((f) => f.online).length}</span>/
            <span className="nums">{accepted.length}</span> {t.friends.online.toLowerCase()}
          </span>
        ) : null}
      </div>

      {loading ? (
        <div className="skeleton" style={{ height: 44 }} />
      ) : friends.length === 0 ? (
        <p className="small muted" style={{ margin: 0 }}>
          {t.friends.none}
        </p>
      ) : (
        <div className="stack-sm">
          {requests.map((f) => (
            <div key={f.id} className="row" style={{ gap: 8 }}>
              <span className="avatar avatar-sm">{f.avatar}</span>
              <span className="grow truncate small" style={{ fontWeight: 600 }}>
                {f.name}
                <span className="tiny faint">
                  {' · '}
                  {f.incoming ? t.friends.incoming : t.friends.pending}
                </span>
              </span>
              {f.incoming ? (
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={busy === f.id}
                  onClick={() => void act(f.id, 'accept')}
                >
                  {t.friends.accept}
                </button>
              ) : null}
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={busy === f.id}
                onClick={() => void act(f.id, 'remove')}
                title={t.friends.remove}
              >
                ✕
              </button>
            </div>
          ))}

          {accepted.map((f) => (
            <div key={f.id} className="row" style={{ gap: 8 }}>
              <span
                className="seat-dot"
                style={
                  {
                    '--seat-color': f.online ? 'var(--success)' : 'var(--text-faint)',
                    width: 9,
                    height: 9,
                  } as React.CSSProperties
                }
                title={f.online ? t.friends.online : t.friends.offline}
              />
              <span className="avatar avatar-sm">{f.avatar}</span>
              <span className="grow truncate small" style={{ fontWeight: 600 }}>
                {f.name}
                <span className="tiny faint"> · {f.rating}</span>
              </span>
              <button
                type="button"
                className="btn btn-sm"
                disabled={!f.online || busy === f.id}
                onClick={() => void act(f.id, 'invite')}
                title={f.online ? t.friends.invite : t.friends.friendOffline}
              >
                {t.friends.invite}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={busy === f.id}
                onClick={() => void act(f.id, 'remove')}
                title={t.friends.remove}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <p className="tiny faint" style={{ margin: 0 }}>
        {t.friends.notPlayed}
      </p>
      <button type="button" className="btn btn-sm" onClick={() => go({ name: 'create' })}>
        {t.home.friend}
      </button>
    </div>
  );
}

/**
 * Shown when the server hands this account to another tab.
 *
 * Without this the two tabs would kick each other off forever, each reconnect
 * evicting the other. The connection stops on purpose; this is how the player
 * says which one they meant.
 */
export function ReplacedNotice(): ReactNode {
  const { t } = useI18n();
  const [replaced, setReplaced] = useState(connection.state === 'replaced');

  useEffect(() => connection.onState((state) => setReplaced(state === 'replaced')), []);

  if (!replaced) return null;
  return (
    <div className="toasts" style={{ bottom: 'auto', top: 'calc(64px + env(safe-area-inset-top))' }}>
      <div className="toast" style={{ gap: 10 }}>
        <span>🪟</span>
        <span className="grow">{t.errors.replaced}</span>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={() => connection.reclaim()}
        >
          {t.errors.useHere}
        </button>
      </div>
    </div>
  );
}

/**
 * The banner that appears when a friend pulls you into their table.
 *
 * Mounted once at the app level so an invitation is never missed because you
 * happened to be on another screen.
 */
export function FriendInvites(): ReactNode {
  const { t, f } = useI18n();
  const { go } = useRouter();
  const [invite, setInvite] = useState<{ name: string; code: string; at: number } | null>(
    null,
  );

  useEffect(
    () =>
      connection.onMessage((msg) => {
        if (msg.t === 'friend.invite') {
          setInvite({ name: msg.from.name, code: msg.code, at: msg.at });
        }
      }),
    [],
  );

  useEffect(() => {
    if (!invite) return;
    const id = window.setTimeout(() => setInvite(null), 45_000);
    return () => window.clearTimeout(id);
  }, [invite]);

  if (!invite) return null;
  return (
    <div className="toasts" style={{ bottom: 'auto', top: 'calc(64px + env(safe-area-inset-top))' }}>
      <div className="toast" style={{ gap: 10 }}>
        <span>🤝</span>
        <span className="grow">{f(t.friends.inviteFrom, { name: invite.name })}</span>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={() => {
            const code = invite.code;
            setInvite(null);
            go({ name: 'room', code });
          }}
        >
          {t.friends.join}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => setInvite(null)}
          aria-label={t.nav.close}
        >
          ✕
        </button>
      </div>
    </div>
  );
}
