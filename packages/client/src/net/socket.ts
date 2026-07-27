/**
 * WallRush — realtime connection.
 *
 * A small reconnecting WebSocket wrapper. Reconnection matters more than usual
 * here: phones suspend sockets whenever the screen locks, and a player who
 * comes back within the server's grace period must find their game still
 * running rather than a forfeit.
 */

import type { ClientMessage, ServerMessage } from '@wallrush/shared';

import { API_BASE, storedToken } from './api.js';

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'closed';

type Listener = (msg: ServerMessage) => void;
type StateListener = (state: ConnectionState, latencyMs: number) => void;

function socketUrl(): string {
  const base = API_BASE || window.location.origin;
  const url = new URL('/ws', base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const token = storedToken();
  if (token) url.searchParams.set('token', token);
  const lang = window.localStorage.getItem('wallrush.lang');
  if (lang) url.searchParams.set('lang', lang);
  return url.toString();
}

export class Connection {
  private socket: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private stateListeners = new Set<StateListener>();
  private queue: ClientMessage[] = [];
  private retries = 0;
  private reconnectTimer: number | null = null;
  private pingTimer: number | null = null;
  private closedByUs = false;

  state: ConnectionState = 'idle';
  latencyMs = 0;

  connect(): void {
    if (this.socket && (this.socket.readyState === 0 || this.socket.readyState === 1)) return;
    this.closedByUs = false;
    this.setState('connecting');
    let socket: WebSocket;
    try {
      socket = new WebSocket(socketUrl());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.retries = 0;
      this.setState('open');
      const pending = this.queue;
      this.queue = [];
      for (const msg of pending) this.send(msg);
      this.startPinging();
    };

    socket.onmessage = (event) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      if (msg.t === 'pong') {
        this.latencyMs = Math.max(0, Date.now() - msg.at);
        this.setState(this.state);
        return;
      }
      for (const listener of this.listeners) listener(msg);
    };

    socket.onclose = () => {
      this.stopPinging();
      this.socket = null;
      if (this.closedByUs) {
        this.setState('closed');
        return;
      }
      this.setState('connecting');
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      // `onclose` always follows; nothing to do here.
    };
  }

  disconnect(): void {
    this.closedByUs = true;
    this.stopPinging();
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close(1000, 'bye');
    this.socket = null;
    this.setState('closed');
  }

  send(msg: ClientMessage): void {
    if (this.socket?.readyState === 1) {
      this.socket.send(JSON.stringify(msg));
      return;
    }
    // Buffer a bounded amount so a flaky link does not lose the player's intent.
    if (this.queue.length < 24) this.queue.push(msg);
    this.connect();
  }

  onMessage(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onState(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    listener(this.state, this.latencyMs);
    return () => this.stateListeners.delete(listener);
  }

  private setState(state: ConnectionState): void {
    this.state = state;
    for (const listener of this.stateListeners) listener(state, this.latencyMs);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    // Exponential backoff with jitter, capped so a returning player waits at
    // most a couple of seconds.
    const delay = Math.min(2400, 220 * 2 ** Math.min(this.retries, 4));
    const jitter = Math.random() * 220;
    this.retries += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay + jitter);
  }

  private startPinging(): void {
    this.stopPinging();
    this.pingTimer = window.setInterval(() => {
      this.send({ t: 'ping', at: Date.now() });
    }, 15_000);
  }

  private stopPinging(): void {
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}

export const connection = new Connection();

// A phone that wakes from sleep should resume immediately rather than waiting
// for the next backoff tick.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && connection.state !== 'closed') {
      connection.connect();
    }
  });
  window.addEventListener('online', () => {
    if (connection.state !== 'closed') connection.connect();
  });
}
