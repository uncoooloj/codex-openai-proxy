#!/usr/bin/env node
import type { Server } from 'node:http';
import { CodexAppServer } from './app-server.js';
import { CliCommand, HttpRoute } from './constants.js';
import { ConfigError, HELP, parseConfig } from './config.js';
import { logger } from './logger.js';
import { createProxyServer } from './server.js';

const STATUS_TIMEOUT_MS = 5_000;
const SHUTDOWN_TIMEOUT_MS = 2_000;

let backend: CodexAppServer | undefined;
let server: Server | undefined;
let shutdownPromise: Promise<void> | undefined;
let exitCode = 0;

process.once('SIGINT', () => requestShutdown(0));
process.once('SIGTERM', () => requestShutdown(0));

try {
  await run();
} catch (error) {
  if (shutdownPromise) {
    await shutDown(0);
  } else {
    logger.error('proxy_failed', { reason: safeFailureReason(error) });
    await shutDown(1);
  }
}

async function run(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(HELP);
    return;
  }

  const config = parseConfig();

  if (config.command === CliCommand.Status) {
    process.exitCode = await printStatus(config.host, config.port);
    return;
  }

  if (shutdownPromise) return;
  backend = new CodexAppServer({
    codexBin: config.codexBin,
    startupTimeoutMs: config.startupTimeoutMs,
    logger,
  });
  backend.onFailure(() => {
    if (!shutdownPromise) {
      logger.error('codex_backend_stopped', {});
      requestShutdown(1);
    }
  });

  await backend.initialize();
  if (shutdownPromise) return;

  server = createProxyServer(backend, { ...config, logger });
  await listen(server, config.port, config.host);
  if (shutdownPromise) return;

  console.error(
    `codex-openai-proxy ready at http://${config.host}:${config.port}/v1`,
  );
  console.error(`export OPENAI_BASE_URL=http://${config.host}:${config.port}/v1`);
  if (config.tokenGenerated) {
    console.error(`export OPENAI_API_KEY=${config.token}`);
  }
}

function requestShutdown(code: number): void {
  void shutDown(code);
}

async function shutDown(code: number): Promise<void> {
  exitCode = Math.max(exitCode, code);
  shutdownPromise ??= (async () => {
    if (server) await closeServer(server);
    await backend?.close();
    process.exitCode = exitCode;
  })();
  await shutdownPromise;
}

async function listen(serverToListen: Server, port: number, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    serverToListen.listen(port, host, resolve).once('error', reject);
  });
}

async function closeServer(serverToClose: Server): Promise<void> {
  await Promise.race([
    new Promise<void>((resolve) => serverToClose.close(() => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
  ]);
  serverToClose.closeAllConnections();
}

async function printStatus(host: string, port: number): Promise<number> {
  try {
    const response = await fetch(`http://${host}:${port}${HttpRoute.Readiness}`, {
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
    console.log(JSON.stringify(await response.json(), null, 2));
    return response.ok ? 0 : 1;
  } catch {
    logger.error('status_check_failed', {});
    return 1;
  }
}

function safeFailureReason(error: unknown): string {
  if (error instanceof ConfigError) return `${error.code}: ${error.message}`;
  const message = error instanceof Error ? error.message : '';
  if (message.includes('auth file not found')) return 'codex_auth_missing';
  if (message.includes('Unsupported Codex version')) return 'codex_version_unsupported';
  if (message.includes('version')) return 'codex_version_check_failed';
  if (message.includes('timed out')) return 'codex_startup_timed_out';
  if (message.includes('cancelled')) return 'shutdown_requested';
  if (
    message.startsWith('--')
    || message.includes('non-loopback')
    || message.includes('adapter token')
  ) return 'invalid_configuration';
  return 'startup_failed';
}
