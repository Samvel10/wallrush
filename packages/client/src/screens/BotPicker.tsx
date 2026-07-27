import { useState, type ReactNode } from 'react';

import { BOT_LEVELS, BOT_RATING, type BotLevel } from '@wallrush/shared';

import { useI18n } from '../i18n/index.js';
import { useRouter } from '../state/router.js';
import { BackButton } from '../components/ui.js';

const ICONS: Record<BotLevel, string> = {
  novice: '🐣',
  easy: '🙂',
  medium: '😎',
  hard: '🔥',
  expert: '🧠',
  master: '💀',
};

const TINTS: Record<BotLevel, string> = {
  novice: 'var(--p2)',
  easy: 'var(--p2)',
  medium: 'var(--p0)',
  hard: 'var(--warning)',
  expert: 'var(--p1)',
  master: 'var(--p3)',
};

export function BotPicker(): ReactNode {
  const { t } = useI18n();
  const { go, back } = useRouter();
  const [seats, setSeats] = useState<2 | 4>(2);

  return (
    <div className="stack">
      <div className="row">
        <BackButton onClick={back} />
        <h1 style={{ fontSize: 'var(--text-xl)' }}>{t.bot.title}</h1>
      </div>

      <div className="segmented segmented-block">
        {([2, 4] as const).map((n) => (
          <button
            key={n}
            type="button"
            className="segmented-item"
            aria-pressed={seats === n}
            onClick={() => setSeats(n)}
          >
            {n === 2 ? t.setup.twoPlayers : t.setup.fourPlayers}
          </button>
        ))}
      </div>

      <div className="stack-sm">
        {BOT_LEVELS.map((level) => (
          <button
            key={level}
            type="button"
            className="tile"
            style={{ '--tile-tint': TINTS[level] } as React.CSSProperties}
            onClick={() => go({ name: 'play-bot', level, seats })}
          >
            <span className="tile-icon">{ICONS[level]}</span>
            <span className="tile-body">
              <span className="tile-title">{t.bot[level]}</span>
              <span className="tile-sub">{t.bot[`${level}Sub` as const]}</span>
            </span>
            <span className="chip" style={{ marginInlineEnd: 6 }}>
              <span className="nums">{BOT_RATING[level]}</span>
            </span>
            <span className="tile-chevron" aria-hidden="true">
              ›
            </span>
          </button>
        ))}
      </div>

      <p className="small muted center">{t.bot.approxRating}</p>
    </div>
  );
}
