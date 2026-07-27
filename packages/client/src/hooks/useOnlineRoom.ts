/**
 * Online room state.
 *
 * Mirrors the authoritative server state. Moves are applied optimistically so
 * the board responds instantly on a slow connection; if the server rejects one,
 * its next broadcast overwrites the optimistic position, so a bad guess can
 * never desync the game.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  Game,
  type ChatLine,
  type GameEnding,
  type GameState,
  type Move,
  type PlayerIndex,
  type RoomInfo,
  type ServerMessage,
} from '@wallrush/shared';

import { connection, type ConnectionState } from '../net/socket.js';

export interface RoomResult {
  winner: PlayerIndex | null;
  ending: GameEnding;
  ratings?: { userId: string; before: number; after: number; delta: number }[];
  /** Set once the match has been stored, so the result screen can link to it. */
  matchId?: string;
}

export interface OnlineRoomApi {
  room: RoomInfo | null;
  game: Game | null;
  mySeat: number | null;
  clocks: number[];
  chat: ChatLine[];
  result: RoomResult | null;
  drawOfferBy: number | null;
  error: string | null;
  connectionState: ConnectionState;
  latencyMs: number;
  queueWaiting: number | null;
  lastMove: { move: Move; by: number } | null;
  play(move: Move): void;
  send: typeof connection.send;
  clearError(): void;
  clearResult(): void;
}

export function useOnlineRoom(myUserId: string | null): OnlineRoomApi {
  const [room, setRoom] = useState<RoomInfo | null>(null);
  const [game, setGame] = useState<Game | null>(null);
  const [mySeat, setMySeat] = useState<number | null>(null);
  const [clocks, setClocks] = useState<number[]>([]);
  const [chat, setChat] = useState<ChatLine[]>([]);
  const [result, setResult] = useState<RoomResult | null>(null);
  const [drawOfferBy, setDrawOfferBy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>(connection.state);
  const [latencyMs, setLatencyMs] = useState(0);
  const [queueWaiting, setQueueWaiting] = useState<number | null>(null);
  const [lastMove, setLastMove] = useState<{ move: Move; by: number } | null>(null);
  const clockBase = useRef<{ at: number; turn: number } | null>(null);

  useEffect(() => connection.onState((state, latency) => {
    setConnectionState(state);
    setLatencyMs(latency);
  }), []);

  useEffect(() => {
    const applyState = (state: GameState) => {
      setGame(Game.fromState(state));
    };

    return connection.onMessage((msg: ServerMessage) => {
      switch (msg.t) {
        case 'room':
          setRoom(msg.room);
          if (myUserId) {
            const seat = msg.room.seats.find((s) => s.user?.id === myUserId);
            setMySeat(seat ? seat.index : null);
          }
          setClocks(msg.room.seats.map((s) => s.clockMs));
          break;

        case 'game.start':
          setRoom(msg.room);
          setMySeat(msg.seat);
          applyState(msg.state);
          setClocks(msg.room.seats.map((s) => s.clockMs));
          clockBase.current = { at: Date.now(), turn: msg.state.turn };
          setResult(null);
          setDrawOfferBy(null);
          setLastMove(null);
          setQueueWaiting(null);
          break;

        case 'game.move':
          applyState(msg.state);
          setClocks(msg.clocks);
          clockBase.current = { at: Date.now(), turn: msg.state.turn };
          setLastMove({ move: msg.move, by: msg.by });
          setDrawOfferBy(null);
          break;

        case 'clock':
          setClocks(msg.clocks);
          clockBase.current = { at: Date.now(), turn: msg.turn };
          break;

        case 'game.over':
          applyState(msg.state);
          setResult({
            winner: msg.winner,
            ending: msg.ending,
            ratings: msg.ratings,
            matchId: msg.matchId,
          });
          break;

        case 'game.drawOffer':
          setDrawOfferBy(msg.by);
          break;

        case 'game.drawDeclined':
          setDrawOfferBy(null);
          break;

        case 'chat':
          setChat((prev) => [...prev.slice(-80), msg.line]);
          break;

        case 'queue.status':
          setQueueWaiting(msg.waiting);
          break;

        case 'room.closed':
          setRoom(null);
          setGame(null);
          setMySeat(null);
          setChat([]);
          break;

        case 'error':
          setError(msg.code);
          break;

        default:
          break;
      }
    });
  }, [myUserId]);

  // Smooth the clock between server ticks so the display counts down every
  // frame rather than jumping once a second.
  useEffect(() => {
    if (!game || game.isOver || !room || room.status !== 'playing') return;
    const id = window.setInterval(() => {
      setClocks((prev) => {
        const base = clockBase.current;
        if (!base) return prev;
        const copy = [...prev];
        const elapsed = Date.now() - base.at;
        if (copy[base.turn] !== undefined) {
          copy[base.turn] = Math.max(0, copy[base.turn] - elapsed);
        }
        clockBase.current = { at: Date.now(), turn: base.turn };
        return copy;
      });
    }, 200);
    return () => window.clearInterval(id);
  }, [game, room]);

  const play = useCallback(
    (move: Move) => {
      if (!game || mySeat === null) return;
      if (game.turn !== mySeat) return;
      const optimistic = game.clone();
      if (optimistic.apply(move).ok) {
        setGame(optimistic);
        setLastMove({ move, by: mySeat });
      }
      connection.send({ t: 'game.move', move, ply: game.ply });
    },
    [game, mySeat],
  );

  return {
    room,
    game,
    mySeat,
    clocks,
    chat,
    result,
    drawOfferBy,
    error,
    connectionState,
    latencyMs,
    queueWaiting,
    lastMove,
    play,
    send: connection.send.bind(connection),
    clearError: () => setError(null),
    clearResult: () => setResult(null),
  };
}
