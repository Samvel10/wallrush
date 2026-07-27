/** Sign in / sign up, profile, settings and the leaderboard. */

import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { tierOf } from '@wallrush/shared';

import { BackButton, LanguageSwitch, Switch, formatRelative, useToast } from '../components/ui.js';
import { useI18n, LANGS, dictionaryFor } from '../i18n/index.js';
import { ApiError, api, type HistoryItem, type LeaderboardRow } from '../net/api.js';
import { useRouter } from '../state/router.js';
import { useSession } from '../state/session.js';
import { useSettings, type Theme } from '../state/settings.js';

const AVATARS = ['🦊', '🦉', '🐺', '🦅', '🐢', '🦌', '🐝', '🦔', '🐬', '🦩', '🐿️', '🦇', '🐙', '🦎'];

function errorKeyFor(code: string): string {
  return code.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

export function Auth({ mode }: { mode: 'in' | 'up' }): ReactNode {
  const { t, lang } = useI18n();
  const { go, back } = useRouter();
  const { signIn, signUp } = useSession();
  const toast = useToast();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'in') await signIn(username, password);
      else await signUp({ username, password, displayName: displayName || undefined, lang });
      toast.push(mode === 'in' ? t.auth.welcomeBack.replace('{name}', username) : t.auth.accountCreated, 'success');
      go({ name: 'profile' }, true);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'generic';
      const key = errorKeyFor(code);
      setError((t.errors as Record<string, string>)[key] ?? t.errors.generic);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <div className="row">
        <BackButton onClick={back} />
        <h1 className="grow" style={{ fontSize: 'var(--text-xl)' }}>
          {mode === 'in' ? t.auth.signIn : t.auth.signUp}
        </h1>
      </div>

      <form className="card stack" onSubmit={submit}>
        <div className="field">
          <label className="field-label" htmlFor="username">
            {t.auth.username}
          </label>
          <input
            id="username"
            className="input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
          />
          {mode === 'up' ? <span className="field-hint">{t.auth.usernameHint}</span> : null}
        </div>

        {mode === 'up' ? (
          <div className="field">
            <label className="field-label" htmlFor="display-name">
              {t.auth.displayName}
            </label>
            <input
              id="display-name"
              className="input"
              value={displayName}
              maxLength={24}
              onChange={(e) => setDisplayName(e.target.value)}
              autoComplete="nickname"
            />
          </div>
        ) : null}

        <div className="field">
          <label className="field-label" htmlFor="password">
            {t.auth.password}
          </label>
          <input
            id="password"
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'in' ? 'current-password' : 'new-password'}
            required
          />
          {mode === 'up' ? <span className="field-hint">{t.auth.passwordHint}</span> : null}
        </div>

        {error ? <p className="field-error">{error}</p> : null}

        <button type="submit" className="btn btn-primary btn-lg" disabled={busy}>
          {busy ? <span className="spinner" /> : null}
          {mode === 'in' ? t.auth.signIn : t.auth.signUp}
        </button>

        {mode === 'up' ? <p className="field-hint center">{t.auth.upgradeNote}</p> : null}
      </form>

      <div className="center small">
        <span className="muted">{mode === 'in' ? t.auth.noAccount : t.auth.haveAccount}</span>{' '}
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => go({ name: 'auth', mode: mode === 'in' ? 'up' : 'in' }, true)}
        >
          {mode === 'in' ? t.auth.signUp : t.auth.signIn}
        </button>
      </div>

      <button type="button" className="btn btn-ghost" onClick={() => go({ name: 'home' })}>
        {t.auth.playAsGuest}
      </button>
    </div>
  );
}

export function ProfileScreen(): ReactNode {
  const { t, lang, setLang } = useI18n();
  const { go } = useRouter();
  const { profile, signedIn, signOut, update } = useSession();
  const { settings, set, reset } = useSettings();
  const toast = useToast();
  const [history, setHistory] = useState<HistoryItem[] | null>(null);

  useEffect(() => {
    if (!signedIn) return;
    void api
      .history(30)
      .then((r) => setHistory(r.matches))
      .catch(() => setHistory([]));
  }, [signedIn]);

  const changeAvatar = useCallback(
    async (avatar: string) => {
      try {
        await update({ avatar });
        toast.push(t.profile.saved, 'success');
      } catch {
        toast.push(t.errors.generic, 'error');
      }
    },
    [update, toast, t],
  );

  const winRate =
    profile && profile.games > 0 ? Math.round((profile.wins / profile.games) * 100) : 0;

  return (
    <div className="stack">
      <h1 style={{ fontSize: 'var(--text-xl)' }}>{t.profile.title}</h1>

      {profile ? (
        <div className="card stack">
          <div className="row">
            <span className="avatar avatar-lg">{profile.avatar}</span>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="row" style={{ gap: 6 }}>
                <span style={{ fontWeight: 800, fontSize: 'var(--text-lg)' }} className="truncate">
                  {profile.name}
                </span>
                {!profile.guest ? (
                  <span className={`badge-tier tier-${tierOf(profile.rating)}`}>
                    {t.leaderboard.tiers[tierOf(profile.rating)]}
                  </span>
                ) : (
                  <span className="chip">{t.common.guest}</span>
                )}
              </div>
              <div className="small muted">
                {profile.username ? `@${profile.username} · ` : ''}
                <span className="nums">{profile.rating}</span>
              </div>
            </div>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(72px, 1fr))',
              gap: 'var(--space-2)',
            }}
          >
            <Stat label={t.profile.games} value={profile.games} />
            <Stat label={t.profile.wins} value={profile.wins} tone="var(--success)" />
            <Stat label={t.profile.losses} value={profile.losses} tone="var(--danger)" />
            <Stat label={t.profile.winRate} value={`${winRate}%`} />
            <Stat label={t.profile.bestStreak} value={profile.bestStreak} />
          </div>

          {signedIn ? (
            <div className="field">
              <span className="field-label">{t.profile.avatar}</span>
              <div className="row row-wrap" style={{ gap: 6 }}>
                {AVATARS.map((a) => (
                  <button
                    key={a}
                    type="button"
                    className="avatar"
                    aria-pressed={profile.avatar === a}
                    style={{
                      borderColor: profile.avatar === a ? 'var(--accent)' : undefined,
                      boxShadow: profile.avatar === a ? 'var(--shadow-glow)' : undefined,
                    }}
                    onClick={() => void changeAvatar(a)}
                  >
                    {a}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {!signedIn ? (
        <div className="card card-tight stack-sm">
          <p className="small muted" style={{ margin: 0 }}>
            {t.profile.signInToSee}
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

      <div className="card stack">
        <h2 style={{ fontSize: 'var(--text-lg)' }}>{t.settings.title}</h2>

        <div className="field">
          <span className="field-label">{t.settings.language}</span>
          <div className="segmented segmented-block">
            {LANGS.map((code) => (
              <button
                key={code}
                type="button"
                className="segmented-item"
                aria-pressed={lang === code}
                onClick={() => {
                  setLang(code);
                  if (signedIn) void update({ lang: code }).catch(() => undefined);
                }}
              >
                {dictionaryFor(code).meta.flag} {dictionaryFor(code).meta.name}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <span className="field-label">{t.settings.theme}</span>
          <div className="segmented segmented-block">
            {(['auto', 'light', 'dark'] as Theme[]).map((th) => (
              <button
                key={th}
                type="button"
                className="segmented-item"
                aria-pressed={settings.theme === th}
                onClick={() => set('theme', th)}
              >
                {th === 'auto' ? '🌗' : th === 'light' ? '☀️' : '🌙'}{' '}
                {th === 'auto'
                  ? t.profile.themeAuto
                  : th === 'light'
                    ? t.profile.themeLight
                    : t.profile.themeDark}
              </button>
            ))}
          </div>
        </div>

        <Switch checked={settings.sound} onChange={(v) => set('sound', v)} label={t.settings.sound} />
        <Switch
          checked={settings.haptics}
          onChange={(v) => set('haptics', v)}
          label={t.settings.haptics}
        />
        <Switch
          checked={settings.animations}
          onChange={(v) => set('animations', v)}
          label={t.settings.animations}
        />
        <Switch
          checked={settings.showCoordinates}
          onChange={(v) => set('showCoordinates', v)}
          label={t.settings.showCoordinates}
        />
        <Switch
          checked={settings.showPath}
          onChange={(v) => set('showPath', v)}
          label={t.settings.showPath}
        />
        <Switch
          checked={settings.confirmMoves}
          onChange={(v) => set('confirmMoves', v)}
          label={t.settings.confirmMoves}
          hint={t.settings.confirmMovesHint}
        />

        <div className="row">
          <button type="button" className="btn btn-ghost btn-sm" onClick={reset}>
            {t.settings.reset}
          </button>
          {signedIn ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm btn-danger"
              onClick={() => void signOut()}
              style={{ marginInlineStart: 'auto' }}
            >
              {t.auth.signOut}
            </button>
          ) : null}
        </div>
      </div>

      {signedIn ? (
        <div className="card stack">
          <h2 style={{ fontSize: 'var(--text-lg)' }}>{t.profile.history}</h2>
          {history === null ? (
            <div className="stack-sm">
              {[0, 1, 2].map((i) => (
                <div key={i} className="skeleton" style={{ height: 44 }} />
              ))}
            </div>
          ) : history.length === 0 ? (
            <p className="muted small">{t.profile.noHistory}</p>
          ) : (
            <div className="stack-sm">
              {history.map((h) => {
                const opponent = h.players.find((p) => p.seat !== h.seat);
                const delta =
                  h.ratingBefore !== null && h.ratingAfter !== null
                    ? h.ratingAfter - h.ratingBefore
                    : 0;
                return (
                  <div key={h.id} className="row card-tight" style={{ gap: 10 }}>
                    <span
                      className="chip"
                      style={{
                        color:
                          h.result === 'win'
                            ? 'var(--success)'
                            : h.result === 'loss'
                              ? 'var(--danger)'
                              : 'var(--text-muted)',
                        minWidth: 34,
                        justifyContent: 'center',
                      }}
                    >
                      {h.result === 'win' ? 'W' : h.result === 'loss' ? 'L' : 'D'}
                    </span>
                    <span className="grow truncate small">
                      {t.profile.vs}{' '}
                      {opponent?.bot
                        ? `${t.common.bot} · ${t.bot[opponent.bot as keyof typeof t.bot] ?? opponent.bot}`
                        : (opponent?.name ?? '—')}
                    </span>
                    {delta !== 0 ? (
                      <span
                        className="tiny nums"
                        style={{ color: delta > 0 ? 'var(--success)' : 'var(--danger)' }}
                      >
                        {delta > 0 ? '+' : ''}
                        {delta}
                      </span>
                    ) : null}
                    <span className="tiny faint">{formatRelative(h.finishedAt, lang)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number;
  tone?: string;
}): ReactNode {
  return (
    <div
      style={{
        background: 'var(--surface-2)',
        borderRadius: 'var(--radius-md)',
        padding: '10px 8px',
        textAlign: 'center',
      }}
    >
      <div className="nums" style={{ fontWeight: 800, fontSize: 'var(--text-lg)', color: tone }}>
        {value}
      </div>
      <div className="tiny faint truncate">{label}</div>
    </div>
  );
}

export function Leaderboard(): ReactNode {
  const { t } = useI18n();
  const { profile } = useSession();
  const [rows, setRows] = useState<LeaderboardRow[] | null>(null);

  useEffect(() => {
    void api
      .leaderboard(100)
      .then((r) => setRows(r.players))
      .catch(() => setRows([]));
  }, []);

  return (
    <div className="stack">
      <h1 style={{ fontSize: 'var(--text-xl)' }}>{t.leaderboard.title}</h1>
      {rows === null ? (
        <div className="stack-sm">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="skeleton" style={{ height: 44 }} />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="empty-state">
          <span className="empty-state-icon">🏆</span>
          <p>{t.leaderboard.empty}</p>
        </div>
      ) : (
        <div className="card card-flush" style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 48 }}>#</th>
                <th>{t.leaderboard.player}</th>
                <th style={{ textAlign: 'end' }}>{t.leaderboard.rating}</th>
                <th style={{ textAlign: 'end' }}>{t.leaderboard.games}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className={row.id === profile?.id ? 'is-me' : undefined}>
                  <td className="nums faint">{row.rank}</td>
                  <td>
                    <div className="row" style={{ gap: 8 }}>
                      <span className="avatar avatar-sm">{row.avatar}</span>
                      <span className="truncate" style={{ fontWeight: 600 }}>
                        {row.name}
                      </span>
                      <span className={`badge-tier tier-${row.tier}`}>
                        {t.leaderboard.tiers[row.tier]}
                      </span>
                    </div>
                  </td>
                  <td className="nums" style={{ textAlign: 'end', fontWeight: 700 }}>
                    {row.rating}
                  </td>
                  <td className="nums faint" style={{ textAlign: 'end' }}>
                    {row.games}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="center">
        <LanguageSwitch />
      </p>
    </div>
  );
}
