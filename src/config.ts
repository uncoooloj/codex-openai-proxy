import { randomBytes } from 'node:crypto';
import type { ProxyConfig } from './types.js';

const DEFAULTS = {
  host: '127.0.0.1',
  port: 18080,
  bodyLimit: 1024 * 1024,
  timeoutMs: 120_000,
  maxConcurrency: 1,
  codexBin: 'codex',
} as const;

function envValue(env: NodeJS.ProcessEnv, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export interface ParseConfigInput {
  args?: string[];
  env?: NodeJS.ProcessEnv;
}

export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export function parseConfig({ args = process.argv.slice(2), env = process.env }: ParseConfigInput = {}): ProxyConfig & { command: 'serve' | 'status' } {
  const flags: Record<string, string | boolean> = {};
  let command: 'serve' | 'status' = 'serve';
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === 'serve' || arg === 'status') {
      command = arg;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      flags.help = true;
      continue;
    }
    if (!arg.startsWith('--')) throw new Error(`unknown argument: ${arg}`);
    const equals = arg.indexOf('=');
    if (equals >= 0) flags[arg.slice(2, equals)] = arg.slice(equals + 1);
    else {
      const name = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[name] = next;
        i += 1;
      } else flags[name] = true;
    }
  }
  const read = (name: string, ...envNames: string[]): string | undefined => {
    const flag = flags[name];
    if (typeof flag === 'string') return flag;
    return envValue(env, ...envNames);
  };
  const tokenValue = read('token', 'CODEX_PROXY_TOKEN', 'CODEX_OPENAI_PROXY_TOKEN');
  const tokenGenerated = !tokenValue;
  if (tokenValue && tokenValue.length < 24) throw new Error('adapter token must be at least 24 characters');
  const host = read('host', 'CODEX_PROXY_HOST', 'CODEX_OPENAI_PROXY_HOST') ?? DEFAULTS.host;
  if (host !== '127.0.0.1') throw new Error('only 127.0.0.1 is supported; non-loopback binding is refused');
  return {
    command,
    host,
    port: positiveInt(read('port', 'CODEX_PROXY_PORT', 'CODEX_OPENAI_PROXY_PORT'), DEFAULTS.port, 'port'),
    token: tokenValue ?? generateToken(),
    tokenGenerated,
    codexBin: read('codex-bin', 'CODEX_BIN', 'CODEX_PROXY_CODEX_BIN') ?? DEFAULTS.codexBin,
    bodyLimit: positiveInt(read('body-limit', 'CODEX_PROXY_BODY_LIMIT', 'CODEX_OPENAI_PROXY_BODY_LIMIT'), DEFAULTS.bodyLimit, 'body-limit'),
    timeoutMs: positiveInt(read('timeout', 'CODEX_PROXY_TIMEOUT_MS', 'CODEX_OPENAI_PROXY_TIMEOUT_MS'), DEFAULTS.timeoutMs, 'timeout'),
    maxConcurrency: positiveInt(read('max-concurrency', 'CODEX_PROXY_MAX_CONCURRENCY', 'CODEX_OPENAI_PROXY_MAX_CONCURRENCY'), DEFAULTS.maxConcurrency, 'max-concurrency'),
  };
}

export const HELP = `Usage: codex-openai-proxy [serve|status] [options]

Options (flags override environment variables):
  --host HOST              Bind host (default 127.0.0.1)
  --port PORT              Bind port (default 18080)
  --token TOKEN            Bearer token (generated when omitted)
  --codex-bin PATH         Codex executable (default codex)
  --body-limit BYTES       Maximum JSON body (default 1048576)
  --timeout MS             Completion timeout (default 120000)
  --max-concurrency N      In-flight requests (default 1; excess gets 429)
`;
