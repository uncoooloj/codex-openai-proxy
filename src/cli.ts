#!/usr/bin/env node
import { CodexAppServer } from './app-server.js';
import { CliCommand, HttpRoute } from './constants.js';
import { HELP, parseConfig } from './config.js';
import { logger } from './logger.js';
import { createProxyServer } from './server.js';

const config = parseConfig();

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(HELP);
  process.exit(0);
}

if (config.command === CliCommand.Status) {
  await printStatusAndExit(config.host, config.port);
}

const backend = new CodexAppServer({
  codexBin: config.codexBin,
  logger,
});

try {
  await backend.initialize();
} catch (error) {
  await backend.close();
  throw error;
}

const server = createProxyServer(backend, { ...config, logger });
try {
  await new Promise<void>((resolve, reject) => {
    server.listen(config.port, config.host, resolve).once('error', reject);
  });
} catch (error) {
  await backend.close();
  throw error;
}

console.error(
  `codex-openai-proxy ready at http://${config.host}:${config.port}/v1`,
);
console.error(`export OPENAI_BASE_URL=http://${config.host}:${config.port}/v1`);
console.error(`export OPENAI_API_KEY=${config.token}`);

let shuttingDown = false;

async function shutDown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await backend.close();
}

async function printStatusAndExit(host: string, port: number): Promise<never> {
  const response = await fetch(`http://${host}:${port}${HttpRoute.Readiness}`);
  console.log(JSON.stringify(await response.json(), null, 2));
  process.exit(response.ok ? 0 : 1);
}

process.once('SIGINT', () => {
  void shutDown().then(() => process.exit(0));
});
process.once('SIGTERM', () => {
  void shutDown().then(() => process.exit(0));
});
