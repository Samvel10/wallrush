/**
 * Test harness: boots a real server on a random port with a throwaway database
 * and gives tests a small WebSocket client. Everything here talks to the actual
 * protocol, so the tests exercise the same code paths a browser would.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import WebSocket from 'ws';

import type { ClientMessage, ServerMessage } from '@wallrush/shared';

export interface TestServer {
  port: number;
  url: string;
  close(): Promise<void>;
}

let started = false;

/**
 * Starts the server in-process. `index.ts` reads its configuration at import
 * time, so the environment has to be set before the dynamic import — and the
 * module can only be imported once per test process.
 */
export async function startServer(): Promise<TestServer> {
  if (started) throw new Error('the server module can only be started once per process');
  started = true;
  const dir = mkdtempSync(join(tmpdir(), 'wallrush-test-'));
  process.env.WALLRUSH_DATA = dir;
  process.env.WALLRUSH_STATIC = '';
  process.env.PORT = '0';
  process.env.HOST = '127.0.0.1';
  process.env.WALLRUSH_SECRET = 'test-secret-value-please-ignore';

  const mod = (await import('../index.js')) as typeof import('../index.js');
  const server = mod.server;
  await new Promise<void>((resolve) => {
    if (server.listening) return resolve();
    server.once('listening', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export class TestClient {
  private socket: WebSocket;
  private queue: ServerMessage[] = [];
  private waiters: { match(m: ServerMessage): boolean; resolve(m: ServerMessage): void; timer: NodeJS.Timeout }[] = [];
  readonly seen: ServerMessage[] = [];

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as ServerMessage;
      this.seen.push(msg);
      const i = this.waiters.findIndex((w) => w.match(msg));
      if (i >= 0) {
        const [waiter] = this.waiters.splice(i, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(msg);
        return;
      }
      this.queue.push(msg);
    });
  }

  static async connect(url: string, token?: string): Promise<TestClient> {
    const wsUrl = url.replace(/^http/, 'ws') + '/ws' + (token ? `?token=${token}` : '');
    const socket = new WebSocket(wsUrl);
    // Attach the listener *before* awaiting `open`: the server greets a new
    // connection immediately, and an event emitted with no listener is simply
    // dropped — which would silently lose the very first message.
    const client = new TestClient(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    return client;
  }

  send(msg: ClientMessage): void {
    this.socket.send(JSON.stringify(msg));
  }

  /** Waits for the next message matching `type` (optionally further filtered). */
  waitFor<T extends ServerMessage['t']>(
    type: T,
    filter?: (msg: Extract<ServerMessage, { t: T }>) => boolean,
    timeoutMs = 5000,
  ): Promise<Extract<ServerMessage, { t: T }>> {
    const match = (m: ServerMessage): boolean =>
      m.t === type && (!filter || filter(m as Extract<ServerMessage, { t: T }>));
    const buffered = this.queue.findIndex(match);
    if (buffered >= 0) {
      const [msg] = this.queue.splice(buffered, 1);
      return Promise.resolve(msg as Extract<ServerMessage, { t: T }>);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.timer === timer);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(
          new Error(
            `timed out waiting for "${type}"; saw: ${this.seen.map((m) => m.t).join(', ')}`,
          ),
        );
      }, timeoutMs);
      this.waiters.push({ match, resolve: resolve as (m: ServerMessage) => void, timer });
    });
  }

  drain(): void {
    this.queue.length = 0;
  }

  close(): void {
    this.socket.close();
  }
}

export async function postJson<T>(url: string, path: string, body: unknown, token?: string): Promise<{ status: number; body: T }> {
  const res = await fetch(url + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

export async function getJson<T>(url: string, path: string, token?: string): Promise<{ status: number; body: T }> {
  const res = await fetch(url + path, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, body: (await res.json()) as T };
}
