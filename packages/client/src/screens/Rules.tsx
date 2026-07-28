/** How to play — with a live miniature board that demonstrates each rule. */

import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { Game, MoveKind, Orientation } from '@wallrush/shared';

import { Board } from '../components/Board.js';
import { BackButton } from '../components/ui.js';
import { useI18n } from '../i18n/index.js';
import { useRouter } from '../state/router.js';

type DemoKey = 'move' | 'wall' | 'jump' | 'block';

function buildDemo(key: DemoKey): Game {
  const g = new Game({ size: 5, wallsPerPlayer: 3, clockMs: 0, moveTimeoutMs: 0 });
  switch (key) {
    case 'move':
      g.players[0].pos = { r: 2, c: 2 };
      g.players[1].pos = { r: 0, c: 0 };
      break;
    case 'wall': {
      const fresh = Game.fromState(g.toState());
      fresh.players[0].pos = { r: 3, c: 2 };
      fresh.players[1].pos = { r: 0, c: 2 };
      const copy = Game.fromState(fresh.toState());
      copy.apply({ kind: MoveKind.Wall, wall: { r: 2, c: 1, o: Orientation.Horizontal } });
      copy.turn = 0;
      return copy;
    }
    case 'jump': {
      const fresh = Game.fromState(g.toState());
      fresh.players[0].pos = { r: 3, c: 2 };
      fresh.players[1].pos = { r: 2, c: 2 };
      return Game.fromState(fresh.toState());
    }
    case 'block': {
      const fresh = Game.fromState(g.toState());
      fresh.players[0].pos = { r: 4, c: 2 };
      fresh.players[1].pos = { r: 0, c: 2 };
      const copy = Game.fromState(fresh.toState());
      copy.apply({ kind: MoveKind.Wall, wall: { r: 3, c: 1, o: Orientation.Vertical } });
      copy.turn = 0;
      copy.apply({ kind: MoveKind.Wall, wall: { r: 3, c: 2, o: Orientation.Vertical } });
      copy.turn = 0;
      return copy;
    }
  }
  return Game.fromState(g.toState());
}

export function Rules(): ReactNode {
  const { t } = useI18n();
  const { back, go } = useRouter();
  const [demo, setDemo] = useState<DemoKey>('move');
  const [mode, setMode] = useState<'move' | 'wall'>('move');

  const game = useMemo(() => buildDemo(demo), [demo]);

  useEffect(() => {
    setMode(demo === 'wall' || demo === 'block' ? 'wall' : 'move');
  }, [demo]);

  // The tab strip needs short labels; the full headings are far too long to fit
  // four across on a phone.
  const sections: { key: DemoKey; tab: string; title: string; body: string }[] = [
    { key: 'move', tab: t.rules.tabs.move, title: t.rules.moveTitle, body: t.rules.move },
    { key: 'wall', tab: t.rules.tabs.wall, title: t.rules.wallTitle, body: t.rules.wall },
    { key: 'jump', tab: t.rules.tabs.jump, title: t.rules.jumpTitle, body: t.rules.jump },
    { key: 'block', tab: t.rules.tabs.block, title: t.rules.blockTitle, body: t.rules.block },
  ];

  return (
    <div className="stack">
      <div className="row">
        <BackButton onClick={back} />
        <h1 className="grow" style={{ fontSize: 'var(--text-xl)' }}>
          {t.rules.title}
        </h1>
      </div>

      {/* Two modes exist, and a player who picks the race has no way to guess
          that both pawns start on the same edge unless we say so. */}
      <div className="card stack-sm">
        <h2 style={{ fontSize: 'var(--text-lg)' }}>{t.rules.modesTitle}</h2>
        <p className="muted">{t.rules.modeDuel}</p>
        <p className="muted">{t.rules.modeRace}</p>
      </div>

      <div className="card stack-sm">
        <h2 style={{ fontSize: 'var(--text-lg)' }}>{t.rules.goalTitle}</h2>
        <p className="muted">{t.rules.goal}</p>
        <h2 style={{ fontSize: 'var(--text-lg)', marginTop: 8 }}>{t.rules.turnTitle}</h2>
        <p className="muted">{t.rules.turn}</p>
      </div>

      <div className="segmented segmented-block scroll-x">
        {sections.map((s) => (
          <button
            key={s.key}
            type="button"
            className="segmented-item"
            aria-pressed={demo === s.key}
            onClick={() => setDemo(s.key)}
          >
            {s.tab}
          </button>
        ))}
      </div>

      <div className="card stack-sm">
        <div style={{ maxWidth: 340, margin: '0 auto', width: '100%' }}>
          <Board
            game={game}
            mySeat={0}
            activeSeat={0}
            interactive
            mode={mode}
            orientation={demo === 'block' ? Orientation.Horizontal : Orientation.Horizontal}
            confirmMoves={false}
            onStep={() => undefined}
            onWall={() => undefined}
          />
        </div>
        <h3 className="center" style={{ fontSize: 'var(--text-base)' }}>
          {sections.find((s) => s.key === demo)?.title}
        </h3>
        <p className="muted small center">
          {sections.find((s) => s.key === demo)?.body}
        </p>
      </div>

      <div className="card stack-sm">
        <h2 style={{ fontSize: 'var(--text-lg)' }}>{t.rules.timeTitle}</h2>
        <p className="muted">{t.rules.time}</p>
      </div>

      <div className="card stack-sm">
        <h2 style={{ fontSize: 'var(--text-lg)' }}>{t.rules.tipsTitle}</h2>
        <ul className="muted" style={{ paddingInlineStart: '1.1em', display: 'grid', gap: 8 }}>
          {t.rules.tips.map((tip) => (
            <li key={tip}>{tip}</li>
          ))}
        </ul>
      </div>

      <button
        type="button"
        className="btn btn-primary btn-lg btn-block"
        onClick={() => go({ name: 'bots' })}
      >
        {t.home.bot}
      </button>
    </div>
  );
}
