#!/usr/bin/env node
/**
 * Development runner — starts the Express backend and the Vite dev server together.
 *
 * The backend runs through Node's native type-stripping (see CLAUDE.md), so no transpiler is
 * involved. This script exists because npm has no built-in way to run two long-lived processes
 * from one script, and ARCHITECTURE Section 2 lists no process-runner package to do it — adding
 * one purely for local development would widen the dependency set the architecture pins.
 *
 * Both processes are spawned directly (no shell) so signal handling and shutdown behave the same
 * on Windows and POSIX.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const processes = [
  {
    name: 'api',
    description: 'Express API',
    args: ['--watch', path.join(repoRoot, 'src', 'server.ts')],
  },
  {
    name: 'web',
    description: 'Vite dev server',
    args: [
      path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js'),
      '--config',
      path.join(repoRoot, 'frontend', 'vite.config.ts'),
    ],
  },
];

/** @type {Map<string, import('node:child_process').ChildProcess>} */
const children = new Map();
let shuttingDown = false;

/**
 * Stops every child exactly once. `process.exitCode` is set rather than calling `process.exit`,
 * so stdout and stderr finish flushing before the process ends.
 */
function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const child of children.values()) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
    }
  }

  process.exitCode = exitCode;
}

for (const { name, description, args } of processes) {
  const child = spawn(process.execPath, args, { cwd: repoRoot, stdio: 'inherit' });
  children.set(name, child);

  child.on('error', (error) => {
    console.error(`[dev] failed to start ${description} (${name}): ${error.message}`);
    shutdown(1);
  });

  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    const reason = signal ? `signal ${signal}` : `exit code ${code}`;
    console.error(`[dev] ${description} (${name}) stopped with ${reason} — stopping the other process`);
    shutdown(code ?? 1);
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n[dev] received ${signal} — shutting down`);
    shutdown(0);
  });
}
