#!/usr/bin/env node
/**
 * One command to run the whole stack in development.
 *
 * Builds the shared engine, then starts the API/WebSocket server and the Vite
 * dev server side by side, forwarding both logs and shutting both down together.
 */

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const children = [];

function run(name, command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const prefix = `[${name}] `;
  const pipe = (stream, target) => {
    stream.setEncoding('utf8');
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) target.write(prefix + line + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => {
    process.stdout.write(`${prefix}exited with ${code}\n`);
  });
  children.push(child);
  return child;
}

function shutdown() {
  for (const child of children) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const build = spawn('npx', ['tsc', '-b', 'packages/shared'], { cwd: root, stdio: 'inherit' });
build.on('exit', (code) => {
  if (code !== 0) {
    process.stderr.write('shared build failed\n');
    process.exit(code ?? 1);
  }
  run('server', 'node', ['--watch', 'packages/server/dist/index.js'], {
    PORT: process.env.PORT ?? '8787',
    WALLRUSH_STATIC: '',
  });
  run('client', 'npx', ['vite', '--host'], {
    WALLRUSH_API: `http://127.0.0.1:${process.env.PORT ?? '8787'}`,
  });
  process.stdout.write('\n  WallRush dev: http://localhost:5173\n\n');
});
