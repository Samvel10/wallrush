/** The online table: lobby view before the start, board after it. */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import {
  BOT_LEVELS,
  defaultWallsFor,
  type BoardSize,
  type BotLevel,
  type Move,
  type RoomInfo,
  type SeatInfo,
} from '@wallrush/shared';

import type { SeatView } from '../components/GameHud.js';
import { GameView, MoveLog } from '../components/GameView.js';
import { BackButton, Modal, Switch, useToast } from '../components/ui.js';
import { useOnlineRoom } from '../hooks/useOnlineRoom.js';
import { useI18n } from '../i18n/index.js';
import { connection } from '../net/socket.js';
import { useRouter } from '../state/router.js';
import { useSession } from '../state/session.js';
import { useSettings } from '../state/settings.js';
import { sounds } from '../state/sound.js';
import { ResultModal } from './PlayLocal.js';

const EMOTES = ['👏', '😂', '🫡', '🤝', '😮', '🔥', '🤔', '😅'];

export function Room({ code }: { code: string }): ReactNode {
  const { t, f } = useI18n();
  const { go, back } = useRouter();
  const { profile } = useSession();
  const { settings } = useSettings();
  const toast = useToast();
  const online = useOnlineRoom(profile?.id ?? null);
  const [chatText, setChatText] = useState('');
  const [copied, setCopied] = useState(false);
  const [showResult, setShowResult] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [floatingEmote, setFloatingEmote] = useState<
    { emoji: string; seat: number; id: number } | null
  >(null);
  const joinedRef = useRef<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Join once per room code; reconnects re-attach automatically server-side.
  useEffect(() => {
    connection.connect();
    if (joinedRef.current !== code) {
      joinedRef.current = code;
      connection.send({ t: 'room.join', code });
    }
  }, [code]);

  useEffect(() => {
    if (!online.error) return;
    const key = online.error.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    const message =
      (t.errors as Record<string, string>)[key] ?? t.errors.generic;
    toast.push(message, 'error');
    if (online.error === 'room-not-found') go({ name: 'lobby' }, true);
    online.clearError();
  }, [online, toast, t, go]);

  useEffect(() => {
    if (online.result) {
      setShowResult(true);
      if (settings.sound) {
        const won = online.result.winner !== null && online.result.winner === online.mySeat;
        (won ? sounds.win : sounds.lose)();
      }
    }
  }, [online.result, online.mySeat, settings.sound]);

  useEffect(() => {
    const last = online.chat[online.chat.length - 1];
    if (last?.emote) {
      const seat =
        online.room?.seats.find((s) => s.user?.id === last.userId)?.index ?? 0;
      setFloatingEmote({ emoji: last.text, seat, id: Date.now() });
      const id = window.setTimeout(() => setFloatingEmote(null), 2300);
      return () => window.clearTimeout(id);
    }
    chatEndRef.current?.scrollIntoView({ block: 'nearest' });
  }, [online.chat, online.room]);

  const room = online.room;
  const game = online.game;

  // The server can move us to a different table — matchmaking pairs us into a
  // fresh room, and a rematch reseats everyone. Keep the URL honest so the
  // page can be reloaded or shared at any moment.
  useEffect(() => {
    if (room && room.code !== code) {
      joinedRef.current = room.code;
      go({ name: 'room', code: room.code }, true);
    }
  }, [room, code, go]);

  const seats: SeatView[] = useMemo(() => {
    if (!room) return [];
    return room.seats.map((s: SeatInfo, i) => ({
      index: s.index,
      name: s.user?.name ?? (s.bot ? t.bot[s.bot] : t.room.empty),
      avatar: s.user?.avatar ?? (s.bot ? '🤖' : '➕'),
      rating: s.user?.rating,
      bot: s.bot,
      clockMs: online.clocks[i] ?? s.clockMs,
      connected: s.connected,
      isMe: s.user != null && profile != null && s.user.id === profile.id,
    }));
  }, [room, online.clocks, profile, t]);

  const isHost = room?.hostId === profile?.id;
  const myReady = room?.seats.find((s) => s.user?.id === profile?.id)?.ready ?? false;

  const copyLink = useCallback(async () => {
    const url = `${window.location.origin}${window.location.pathname}#/room/${code}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: 'WallRush', text: `${t.room.code}: ${code}`, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.push(url);
    }
  }, [code, t, toast]);

  const leave = useCallback(() => {
    connection.send({ t: 'room.leave' });
    joinedRef.current = null;
    go({ name: 'home' });
  }, [go]);

  const onMove = useCallback((move: Move) => online.play(move), [online]);

  const sendChat = useCallback(() => {
    const text = chatText.trim();
    if (!text) return;
    connection.send({ t: 'chat', text });
    setChatText('');
  }, [chatText]);

  if (!room) {
    return (
      <div className="stack" style={{ alignItems: 'center', paddingTop: 48 }}>
        <span className="spinner" style={{ width: 28, height: 28 }} />
        <p className="muted">{t.common.loading}</p>
        <button type="button" className="btn" onClick={() => go({ name: 'lobby' })}>
          {t.nav.back}
        </button>
      </div>
    );
  }

  // ------------------------------------------------------------- waiting room
  if (room.status !== 'playing' && !game) {
    return (
      <div className="stack">
        <div className="row">
          <BackButton onClick={leave} />
          <h1 className="grow" style={{ fontSize: 'var(--text-lg)' }}>
            {room.name || t.room.title}
          </h1>
          <span className="chip">{room.rated ? '★' : '☆'}</span>
        </div>

        <div className="card stack" style={{ textAlign: 'center' }}>
          <div className="uppercase" style={{ margin: 0 }}>
            {t.room.code}
          </div>
          <div
            className="mono"
            style={{ fontSize: 'var(--text-3xl)', letterSpacing: '0.22em', fontWeight: 800 }}
          >
            {room.code}
          </div>
          <button type="button" className="btn btn-primary" onClick={() => void copyLink()}>
            {copied ? `✓ ${t.room.copied}` : `🔗 ${t.room.share}`}
          </button>
        </div>

        <div className="stack-sm">
          {room.seats.map((seat) => (
            <SeatRow
              key={seat.index}
              seat={seat}
              isHost={isHost}
              isMe={seat.user != null && profile != null && seat.user.id === profile.id}
              onSit={() => connection.send({ t: 'room.seat', seat: seat.index })}
              onAddBot={(level) =>
                connection.send({ t: 'room.addBot', seat: seat.index, level })
              }
              onRemoveBot={() => connection.send({ t: 'room.removeBot', seat: seat.index })}
            />
          ))}
        </div>

        <RoomSetup room={room} isHost={isHost} />

        <div className="row">
          <button
            type="button"
            className={`btn grow ${myReady ? '' : 'btn-primary'}`}
            onClick={() => connection.send({ t: 'room.ready', ready: !myReady })}
            disabled={!room.seats.some((s) => s.user?.id === profile?.id)}
          >
            {myReady ? `✓ ${t.room.ready}` : t.room.ready}
          </button>
          {isHost ? (
            <button
              type="button"
              className="btn btn-primary grow"
              onClick={() => connection.send({ t: 'room.start' })}
            >
              {t.room.start}
            </button>
          ) : null}
        </div>

        <p className="center small muted">{t.room.waiting}</p>
      </div>
    );
  }

  // -------------------------------------------------------------------- game
  const controllingSeat =
    game && online.mySeat !== null && game.turn === online.mySeat && !game.isOver
      ? online.mySeat
      : null;

  return (
    <div className="stack">
      <div className="row">
        <BackButton onClick={() => setConfirmLeave(true)} />
        <h1 className="grow truncate" style={{ fontSize: 'var(--text-lg)' }}>
          {room.name || `${t.room.title} ${room.code}`}
        </h1>
        {online.connectionState !== 'open' ? (
          <span className="chip" style={{ color: 'var(--warning)' }}>
            <span className="spinner" /> {t.game.reconnecting}
          </span>
        ) : (
          <span className="chip tiny">{online.latencyMs} ms</span>
        )}
        {/* Destructive actions sit away from the controls the thumb uses. */}
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => connection.send({ t: 'game.drawOffer' })}
          disabled={!game || game.isOver || online.mySeat === null}
          title={t.game.offerDraw}
        >
          ½
        </button>
        <button
          type="button"
          className="btn btn-sm btn-danger"
          onClick={() => setConfirmLeave(true)}
          disabled={!game || game.isOver || online.mySeat === null}
          title={t.game.resign}
        >
          ⚑<span className="label-wide">{t.game.resign}</span>
        </button>
      </div>

      {game ? (
        <GameView
          game={game}
          seats={seats}
          mySeat={online.mySeat}
          controllingSeat={controllingSeat}
          clockRunning
          lastMove={online.lastMove}
          floatingEmote={floatingEmote}
          onMove={onMove}
          banner={
            online.mySeat === null ? (
              <span className="chip" style={{ alignSelf: 'center' }}>
                👁 {t.game.spectating}
              </span>
            ) : undefined
          }
          side={
            <>
              <MoveLog game={game} />
              <div className="card card-tight stack-sm">
                <div className="uppercase">{t.game.chat}</div>
                <div className="chat-log">
                  {online.chat.map((line) => (
                    <div key={line.id} className="chat-line">
                      {line.emote ? (
                        <>
                          <span className="chat-name">{line.name}</span>
                          <span className="chat-emote">{line.text}</span>
                        </>
                      ) : (
                        <>
                          <span className="chat-name">{line.name}:</span>
                          {line.text}
                        </>
                      )}
                    </div>
                  ))}
                  <div ref={chatEndRef} />
                </div>
                <div className="emote-bar">
                  {EMOTES.map((e) => (
                    <button
                      key={e}
                      type="button"
                      className="emote-btn"
                      onClick={() => connection.send({ t: 'chat', text: e, emote: true })}
                    >
                      {e}
                    </button>
                  ))}
                </div>
                <form
                  className="row"
                  onSubmit={(ev) => {
                    ev.preventDefault();
                    sendChat();
                  }}
                >
                  <input
                    className="input grow"
                    value={chatText}
                    maxLength={240}
                    onChange={(e) => setChatText(e.target.value)}
                    placeholder="…"
                    aria-label={t.game.chat}
                  />
                  <button type="submit" className="btn btn-icon" aria-label="send">
                    ➤
                  </button>
                </form>
              </div>
            </>
          }
        />
      ) : null}

      <Modal
        open={online.drawOfferBy !== null && online.drawOfferBy !== online.mySeat}
        onClose={() => connection.send({ t: 'game.drawAnswer', accept: false })}
        title={t.game.drawOffered}
      >
        <div className="row" style={{ marginTop: 16 }}>
          <button
            type="button"
            className="btn grow"
            onClick={() => connection.send({ t: 'game.drawAnswer', accept: false })}
          >
            {t.game.declineDraw}
          </button>
          <button
            type="button"
            className="btn btn-primary grow"
            onClick={() => connection.send({ t: 'game.drawAnswer', accept: true })}
          >
            {t.game.acceptDraw}
          </button>
        </div>
      </Modal>

      <Modal open={confirmLeave} onClose={() => setConfirmLeave(false)} title={t.game.resign}>
        <div className="row" style={{ marginTop: 16 }}>
          <button type="button" className="btn grow" onClick={() => setConfirmLeave(false)}>
            {t.game.cancel}
          </button>
          <button
            type="button"
            className="btn btn-danger grow"
            onClick={() => {
              connection.send({ t: 'game.resign' });
              setConfirmLeave(false);
            }}
          >
            {t.game.resign}
          </button>
        </div>
      </Modal>

      <ResultModal
        open={showResult && online.result !== null}
        winner={online.result?.winner ?? null}
        mySeat={online.mySeat}
        seats={seats}
        ending={online.result?.ending ?? null}
        plies={game?.ply ?? 0}
        ratingDelta={
          online.result?.ratings?.find((r) => r.userId === profile?.id) ?? null
        }
        onClose={() => setShowResult(false)}
        onRematch={() => {
          connection.send({ t: 'room.rematch' });
          setShowResult(false);
        }}
        onHome={leave}
        onReview={
          online.result?.matchId
            ? () => {
                const id = online.result!.matchId!;
                connection.send({ t: 'room.leave' });
                go({ name: 'replay', id });
              }
            : undefined
        }
      />
    </div>
  );
}

/**
 * The host can still change the format while everyone is waiting — nobody
 * should have to tear the room down and re-share a code just to switch to a
 * bigger board.
 */
function RoomSetup({ room, isHost }: { room: RoomInfo; isHost: boolean }): ReactNode {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const summary = `${room.config.size}×${room.config.size} · ${room.config.wallsPerPlayer} ${t.game.walls} · ${
    room.config.clockMs > 0
      ? `${Math.round(room.config.clockMs / 60000)} ${t.setup.minutes}`
      : t.setup.unlimited
  }`;

  const patch = (config: Partial<RoomInfo['config']>, rated?: boolean) =>
    connection.send({ t: 'room.config', config, rated });

  return (
    <div className="card card-tight stack-sm">
      <div className="row row-between">
        <span className="small muted">{summary}</span>
        <div className="row" style={{ gap: 6 }}>
          {room.watchers > 0 ? (
            <span className="chip">
              👁 {room.watchers} {t.room.watching}
            </span>
          ) : null}
          {isHost ? (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
            >
              ⚙ {t.settings.title}
            </button>
          ) : null}
        </div>
      </div>

      {isHost && open ? (
        <div className="stack-sm" style={{ paddingTop: 6 }}>
          <div className="field">
            <span className="field-label">{t.setup.players}</span>
            <div className="segmented segmented-block">
              {([2, 4] as const).map((n) => (
                <button
                  key={n}
                  type="button"
                  className="segmented-item"
                  aria-pressed={room.config.players === n}
                  onClick={() =>
                    patch({ players: n, wallsPerPlayer: defaultWallsFor(n, room.config.size) })
                  }
                >
                  {n === 2 ? t.setup.twoPlayers : t.setup.fourPlayers}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <span className="field-label">{t.setup.boardSize}</span>
            <div className="segmented segmented-block">
              {([5, 7, 9, 11] as BoardSize[]).map((size) => (
                <button
                  key={size}
                  type="button"
                  className="segmented-item"
                  aria-pressed={room.config.size === size}
                  onClick={() =>
                    patch({ size, wallsPerPlayer: defaultWallsFor(room.config.players, size) })
                  }
                >
                  {size}×{size}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <label className="field-label" htmlFor="room-walls">
              {t.setup.walls}: <span className="nums">{room.config.wallsPerPlayer}</span>
            </label>
            <input
              id="room-walls"
              type="range"
              min={0}
              max={room.config.size >= 9 ? 14 : 8}
              value={room.config.wallsPerPlayer}
              onChange={(e) => patch({ wallsPerPlayer: Number(e.target.value) })}
              style={{ width: '100%', accentColor: 'var(--accent)' }}
            />
          </div>

          <div className="field">
            <span className="field-label">{t.setup.time}</span>
            <div className="segmented segmented-block">
              {[
                { label: `3+2`, clockMs: 180_000, incrementMs: 2000, moveTimeoutMs: 20_000 },
                { label: `5+3`, clockMs: 300_000, incrementMs: 3000, moveTimeoutMs: 30_000 },
                { label: `10+5`, clockMs: 600_000, incrementMs: 5000, moveTimeoutMs: 60_000 },
                { label: '∞', clockMs: 0, incrementMs: 0, moveTimeoutMs: 0 },
              ].map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  className="segmented-item"
                  aria-pressed={room.config.clockMs === preset.clockMs}
                  onClick={() =>
                    patch({
                      clockMs: preset.clockMs,
                      incrementMs: preset.incrementMs,
                      moveTimeoutMs: preset.moveTimeoutMs,
                    })
                  }
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          <Switch
            checked={room.rated}
            onChange={(rated) => patch({}, rated)}
            label={t.setup.rated}
          />
        </div>
      ) : null}
    </div>
  );
}

function SeatRow({
  seat,
  isHost,
  isMe,
  onSit,
  onAddBot,
  onRemoveBot,
}: {
  seat: SeatInfo;
  isHost: boolean;
  isMe: boolean;
  onSit(): void;
  onAddBot(level: BotLevel): void;
  onRemoveBot(): void;
}): ReactNode {
  const { t } = useI18n();
  const [picking, setPicking] = useState(false);
  const occupied = seat.user !== null || seat.bot !== null;

  return (
    <div
      className="card card-tight row"
      style={
        {
          borderColor: occupied
            ? `color-mix(in oklab, var(--p${seat.index}) 40%, var(--border))`
            : undefined,
        } as React.CSSProperties
      }
    >
      <span
        className="seat-dot"
        style={{ '--seat-color': `var(--p${seat.index})` } as React.CSSProperties}
      />
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="row" style={{ gap: 6 }}>
          <span className="avatar avatar-sm">
            {seat.user?.avatar ?? (seat.bot ? '🤖' : '·')}
          </span>
          <span className="truncate" style={{ fontWeight: 700 }}>
            {seat.user?.name ?? (seat.bot ? t.bot[seat.bot] : t.room.empty)}
          </span>
          {isMe ? <span className="chip tiny">{t.common.you}</span> : null}
          {seat.ready ? <span className="chip chip-accent tiny">✓</span> : null}
        </div>
        {seat.user ? (
          <div className="tiny faint">
            {seat.user.guest ? t.common.guest : `★ ${seat.user.rating}`}
          </div>
        ) : null}
      </div>

      {!occupied ? (
        <div className="row" style={{ gap: 6 }}>
          <button type="button" className="btn btn-sm btn-primary" onClick={onSit}>
            {t.room.sit}
          </button>
          {isHost ? (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setPicking((v) => !v)}
            >
              🤖
            </button>
          ) : null}
        </div>
      ) : seat.bot && isHost ? (
        <button type="button" className="btn btn-sm btn-ghost" onClick={onRemoveBot}>
          ✕
        </button>
      ) : null}

      {picking ? (
        <Modal open onClose={() => setPicking(false)} title={t.bot.title}>
          <div className="stack-sm">
            {BOT_LEVELS.map((level) => (
              <button
                key={level}
                type="button"
                className="btn btn-block"
                onClick={() => {
                  onAddBot(level);
                  setPicking(false);
                }}
              >
                {t.bot[level]}
              </button>
            ))}
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
