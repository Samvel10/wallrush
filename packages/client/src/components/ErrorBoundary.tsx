/**
 * Last line of defence.
 *
 * A thrown render error would otherwise leave a blank page with no way out —
 * the worst possible outcome mid-game. This catches it, shows something honest
 * in the player's own language, and offers the two things that actually help:
 * go back to the home screen, or reload.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';

import { dictionaryFor, detectLanguage } from '../i18n/index.js';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Kept in the console rather than sent anywhere: the project collects no
    // telemetry, and a player debugging their own crash can read this.
    console.error('WallRush crashed while rendering', error, info.componentStack);
  }

  private reset = (): void => {
    window.location.hash = '#/';
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const t = dictionaryFor(detectLanguage());
    return (
      <div
        className="app-main is-narrow"
        style={{ minHeight: '100dvh', justifyContent: 'center' }}
      >
        <div className="card stack" style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 48 }}>🧱</div>
          <h1 style={{ fontSize: 'var(--text-xl)' }}>{t.errors.generic}</h1>
          <p className="muted small" style={{ margin: 0 }}>
            <code className="mono">{error.message}</code>
          </p>
          <div className="row">
            <button type="button" className="btn grow" onClick={this.reset}>
              {t.result.backHome}
            </button>
            <button
              type="button"
              className="btn btn-primary grow"
              onClick={() => window.location.reload()}
            >
              {t.common.retry}
            </button>
          </div>
        </div>
      </div>
    );
  }
}
