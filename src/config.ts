import { randomBytes } from 'node:crypto';
import {
  CliCommand,
  CliFlag,
  EnvironmentVariable,
} from './constants.js';
import type { ProxyConfig } from './types.js';

const DEFAULT_CONFIG = {
  host: '127.0.0.1',
  port: 18_080,
  bodyLimit: 1024 * 1024,
  timeoutMs: 120_000,
  maxConcurrency: 1,
  codexBin: 'codex',
} as const;

const MINIMUM_TOKEN_LENGTH = 24;
const TOKEN_BYTES = 32;

type FlagValues = Partial<Record<CliFlag, string | boolean>>;

interface ParsedArguments {
  command: CliCommand;
  flags: FlagValues;
}

export interface ParseConfigInput {
  args?: string[];
  env?: NodeJS.ProcessEnv;
}

export interface ParsedConfig extends ProxyConfig {
  command: CliCommand;
}

export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function parseConfig({
  args = process.argv.slice(2),
  env = process.env,
}: ParseConfigInput = {}): ParsedConfig {
  const { command, flags } = parseArguments(args);
  const read = createConfigReader(flags, env);

  const suppliedToken = read(
    CliFlag.Token,
    EnvironmentVariable.ProxyToken,
    EnvironmentVariable.LegacyProxyToken,
  );
  if (suppliedToken && suppliedToken.length < MINIMUM_TOKEN_LENGTH) {
    throw new Error(
      `adapter token must be at least ${MINIMUM_TOKEN_LENGTH} characters`,
    );
  }

  const host = read(
    CliFlag.Host,
    EnvironmentVariable.ProxyHost,
    EnvironmentVariable.LegacyProxyHost,
  ) ?? DEFAULT_CONFIG.host;
  if (host !== DEFAULT_CONFIG.host) {
    throw new Error(
      'only 127.0.0.1 is supported; non-loopback binding is refused',
    );
  }

  return {
    command,
    host,
    port: readPositiveInteger(
      read(
        CliFlag.Port,
        EnvironmentVariable.ProxyPort,
        EnvironmentVariable.LegacyProxyPort,
      ),
      DEFAULT_CONFIG.port,
      CliFlag.Port,
    ),
    token: suppliedToken ?? generateToken(),
    tokenGenerated: !suppliedToken,
    codexBin: read(
      CliFlag.CodexBin,
      EnvironmentVariable.CodexBin,
      EnvironmentVariable.ProxyCodexBin,
    ) ?? DEFAULT_CONFIG.codexBin,
    bodyLimit: readPositiveInteger(
      read(
        CliFlag.BodyLimit,
        EnvironmentVariable.ProxyBodyLimit,
        EnvironmentVariable.LegacyProxyBodyLimit,
      ),
      DEFAULT_CONFIG.bodyLimit,
      CliFlag.BodyLimit,
    ),
    timeoutMs: readPositiveInteger(
      read(
        CliFlag.Timeout,
        EnvironmentVariable.ProxyTimeout,
        EnvironmentVariable.LegacyProxyTimeout,
      ),
      DEFAULT_CONFIG.timeoutMs,
      CliFlag.Timeout,
    ),
    maxConcurrency: readPositiveInteger(
      read(
        CliFlag.MaxConcurrency,
        EnvironmentVariable.ProxyMaxConcurrency,
        EnvironmentVariable.LegacyProxyMaxConcurrency,
      ),
      DEFAULT_CONFIG.maxConcurrency,
      CliFlag.MaxConcurrency,
    ),
  };
}

function parseArguments(args: string[]): ParsedArguments {
  const flags: FlagValues = {};
  let command = CliCommand.Serve;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;

    if (isCliCommand(argument)) {
      command = argument;
      continue;
    }

    if (argument === '--help' || argument === '-h') {
      flags[CliFlag.Help] = true;
      continue;
    }

    if (!argument.startsWith('--')) {
      throw new Error(`unknown argument: ${argument}`);
    }

    const equalsIndex = argument.indexOf('=');
    if (equalsIndex >= 0) {
      const name = argument.slice(2, equalsIndex) as CliFlag;
      flags[name] = argument.slice(equalsIndex + 1);
      continue;
    }

    const name = argument.slice(2) as CliFlag;
    const nextArgument = args[index + 1];
    if (nextArgument && !nextArgument.startsWith('--')) {
      flags[name] = nextArgument;
      index += 1;
    } else {
      flags[name] = true;
    }
  }

  return { command, flags };
}

function createConfigReader(
  flags: FlagValues,
  env: NodeJS.ProcessEnv,
): (flag: CliFlag, ...environmentNames: EnvironmentVariable[]) => string | undefined {
  return (flag, ...environmentNames) => {
    const flagValue = flags[flag];
    if (typeof flagValue === 'string') return flagValue;

    for (const name of environmentNames) {
      const value = env[name];
      if (value !== undefined && value !== '') return value;
    }
    return undefined;
  };
}

function readPositiveInteger(
  value: string | undefined,
  fallback: number,
  name: CliFlag,
): number {
  if (value === undefined) return fallback;

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function isCliCommand(value: string): value is CliCommand {
  return value === CliCommand.Serve || value === CliCommand.Status;
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
