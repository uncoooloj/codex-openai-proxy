#!/usr/bin/env node
import { CodexAppServer } from './app-server.js';
import { parseConfig, HELP } from './config.js';
import { logger } from './logger.js';
import { createProxyServer } from './server.js';

const config = parseConfig();
if (process.argv.includes('--help') || process.argv.includes('-h')) { console.log(HELP); process.exit(0); }
if (config.command === 'status') {
  const response = await fetch(`http://${config.host}:${config.port}/readyz`);
  console.log(JSON.stringify(await response.json(), null, 2));
  process.exit(response.ok ? 0 : 1);
}
const backend = new CodexAppServer({ codexBin: config.codexBin, logger });
try { await backend.initialize(); } catch (error) { await backend.close(); throw error; }
const server = createProxyServer(backend, { ...config, logger });
try { await new Promise<void>((resolve, reject) => server.listen(config.port, config.host, resolve).once('error', reject)); }
catch (error) { await backend.close(); throw error; }
console.error(`codex-openai-proxy ready at http://${config.host}:${config.port}/v1`);
console.error(`export OPENAI_BASE_URL=http://${config.host}:${config.port}/v1`);
console.error(`export OPENAI_API_KEY=${config.token}`);
let closing = false;
async function close() { if (closing) return; closing = true; await new Promise<void>((resolve) => server.close(() => resolve())); await backend.close(); }
process.once('SIGINT', () => void close().then(() => process.exit(0)));
process.once('SIGTERM', () => void close().then(() => process.exit(0)));
