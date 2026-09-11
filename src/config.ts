import { randomBytes } from 'node:crypto';
import {
  constants as fsConstants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
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
  startupTimeoutMs: 60_000,
  maxConcurrency: 1,
  codexBin: 'codex',
} as const;

const MINIMUM_TOKEN_LENGTH = 24;
const TOKEN_BYTES = 32;
const MAX_TOKEN_FILE_BYTES = 4096;
const MAX_PORT = 65_535;
// Node timers use a signed 32-bit millisecond delay. Keep startup timeout
// values within that range so a large value cannot wrap into an immediate
// timeout.
const MAX_STARTUP_TIMEOUT_MS = 2_147_483_647;

const VALUE_FLAGS = new Set<CliFlag>([
  CliFlag.Host,
  CliFlag.Port,
  CliFlag.Token,
  CliFlag.TokenFile,
  CliFlag.CodexBin,
  CliFlag.BodyLimit,
  CliFlag.Timeout,
  CliFlag.StartupTimeout,
  CliFlag.MaxConcurrency,
]);

type FlagValues = Partial<Record<CliFlag, string | boolean>>;

interface ParsedArguments {
  command: CliCommand;
  flags: FlagValues;
}

interface TokenResolution {
  token: string;
  tokenGenerated: boolean;
}

interface TokenFileError extends Error {
  code?: string;
}

export class ConfigError extends Error {
  readonly code = 'invalid_configuration' as const;

  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
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

  const host = read(
    CliFlag.Host,
    EnvironmentVariable.ProxyHost,
    EnvironmentVariable.LegacyProxyHost,
  ) ?? DEFAULT_CONFIG.host;
  if (host !== DEFAULT_CONFIG.host) {
    throw new ConfigError(
      'only 127.0.0.1 is supported; non-loopback binding is refused',
    );
  }

  const port = readInteger(
    read(
      CliFlag.Port,
      EnvironmentVariable.ProxyPort,
      EnvironmentVariable.LegacyProxyPort,
    ),
    DEFAULT_CONFIG.port,
    CliFlag.Port,
    MAX_PORT,
  );
  const codexBin = read(
    CliFlag.CodexBin,
    EnvironmentVariable.ProxyCodexBin,
    EnvironmentVariable.CodexBin,
  ) ?? DEFAULT_CONFIG.codexBin;
  const bodyLimit = readInteger(
    read(
      CliFlag.BodyLimit,
      EnvironmentVariable.ProxyBodyLimit,
      EnvironmentVariable.LegacyProxyBodyLimit,
    ),
    DEFAULT_CONFIG.bodyLimit,
    CliFlag.BodyLimit,
  );
  const timeoutMs = readInteger(
    read(
      CliFlag.Timeout,
      EnvironmentVariable.ProxyTimeout,
      EnvironmentVariable.LegacyProxyTimeout,
    ),
    DEFAULT_CONFIG.timeoutMs,
    CliFlag.Timeout,
    MAX_STARTUP_TIMEOUT_MS,
  );
  const startupTimeoutMs = readInteger(
    read(
      CliFlag.StartupTimeout,
      EnvironmentVariable.ProxyStartupTimeout,
      EnvironmentVariable.LegacyProxyStartupTimeout,
    ),
    DEFAULT_CONFIG.startupTimeoutMs,
    CliFlag.StartupTimeout,
    MAX_STARTUP_TIMEOUT_MS,
  );
  const maxConcurrency = readInteger(
    read(
      CliFlag.MaxConcurrency,
      EnvironmentVariable.ProxyMaxConcurrency,
      EnvironmentVariable.LegacyProxyMaxConcurrency,
    ),
    DEFAULT_CONFIG.maxConcurrency,
    CliFlag.MaxConcurrency,
  );
  const tokenResolution = resolveToken(flags, env, command);

  return {
    command,
    host,
    port,
    token: tokenResolution.token,
    tokenGenerated: tokenResolution.tokenGenerated,
    codexBin,
    bodyLimit,
    timeoutMs,
    startupTimeoutMs,
    maxConcurrency,
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
      throw new ConfigError('unknown argument');
    }

    const equalsIndex = argument.indexOf('=');
    const rawName = equalsIndex >= 0
      ? argument.slice(2, equalsIndex)
      : argument.slice(2);
    if (!isCliFlag(rawName)) {
      throw new ConfigError('unknown option');
    }

    const name = rawName as CliFlag;
    if (name === CliFlag.Help) {
      if (equalsIndex >= 0) {
        throw new ConfigError('--help does not accept a value');
      }
      flags[name] = true;
      continue;
    }

    if (!VALUE_FLAGS.has(name)) {
      throw new ConfigError('unknown option');
    }

    const value = equalsIndex >= 0
      ? argument.slice(equalsIndex + 1)
      : readFlagValue(args, index, name);
    if (value.length === 0) {
      throw new ConfigError(`--${name} must not be empty`);
    }
    if (equalsIndex < 0) index += 1;
    flags[name] = value;
  }

  return { command, flags };
}

function readFlagValue(args: string[], index: number, name: CliFlag): string {
  const nextArgument = args[index + 1];
  if (nextArgument === undefined || nextArgument.startsWith('--')) {
    throw new ConfigError(`--${name} requires a value`);
  }
  return nextArgument;
}

function createConfigReader(
  flags: FlagValues,
  env: NodeJS.ProcessEnv,
): (flag: CliFlag, ...environmentNames: EnvironmentVariable[]) => string | undefined {
  return (flag, ...environmentNames) => {
    const flagValue = flags[flag];
    if (flagValue !== undefined) {
      if (typeof flagValue !== 'string') {
        throw new ConfigError(`--${flag} requires a value`);
      }
      return flagValue;
    }

    return readEnvironmentValue(env, environmentNames);
  };
}

function resolveToken(
  flags: FlagValues,
  env: NodeJS.ProcessEnv,
  command: CliCommand,
): TokenResolution {
  const flagToken = readFlagValueFromMap(flags, CliFlag.Token);
  const flagTokenFile = readFlagValueFromMap(flags, CliFlag.TokenFile);
  if (flagToken !== undefined && flagTokenFile !== undefined) {
    throw new ConfigError('--token and --token-file cannot be used together');
  }

  if (flagToken !== undefined) {
    return {
      token: validateToken(flagToken),
      tokenGenerated: false,
    };
  }
  if (flagTokenFile !== undefined) {
    return resolveTokenFile(
      flagTokenFile,
      command,
      flags[CliFlag.Help] === true,
    );
  }

  const envToken = readEnvironmentValue(env, [
    EnvironmentVariable.ProxyToken,
    EnvironmentVariable.LegacyProxyToken,
  ]);
  const envTokenFile = readEnvironmentValue(env, [
    EnvironmentVariable.ProxyTokenFile,
    EnvironmentVariable.LegacyProxyTokenFile,
  ]);
  if (envToken !== undefined && envTokenFile !== undefined) {
    throw new ConfigError(
      `${EnvironmentVariable.ProxyToken} and `
      + `${EnvironmentVariable.ProxyTokenFile} cannot be used together`,
    );
  }

  if (envToken !== undefined) {
    return {
      token: validateToken(envToken),
      tokenGenerated: false,
    };
  }
  if (envTokenFile !== undefined) {
    return resolveTokenFile(
      envTokenFile,
      command,
      flags[CliFlag.Help] === true,
    );
  }

  return {
    token: generateToken(),
    tokenGenerated: true,
  };
}

function readFlagValueFromMap(
  flags: FlagValues,
  flag: CliFlag,
): string | undefined {
  const value = flags[flag];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new ConfigError(`--${flag} requires a value`);
  }
  if (value.length === 0) {
    throw new ConfigError(`--${flag} must not be empty`);
  }
  return value;
}

function readEnvironmentValue(
  env: NodeJS.ProcessEnv,
  names: readonly EnvironmentVariable[],
): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value === undefined) continue;
    if (value.length === 0) {
      throw new ConfigError(`${name} must not be empty`);
    }
    return value;
  }
  return undefined;
}

function resolveTokenFile(
  pathValue: string,
  command: CliCommand,
  helpRequested: boolean,
): TokenResolution {
  const tokenPath = normalizeTokenFilePath(pathValue);

  // `status` only needs non-authentication settings. It must not create a
  // credential as a side effect, while retaining the explicit-source marker.
  if (command === CliCommand.Status || helpRequested) {
    return {
      token: generateToken(),
      tokenGenerated: false,
    };
  }

  assertTokenFileParent(tokenPath);

  try {
    return {
      token: readTokenFile(tokenPath),
      tokenGenerated: false,
    };
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      throw tokenFileError(error, 'read');
    }
  }

  const generated = generateToken();
  try {
    createTokenFile(tokenPath, generated);
    return { token: generated, tokenGenerated: false };
  } catch (error) {
    if (errorCode(error) === 'EEXIST') {
      return {
        token: readTokenFile(tokenPath),
        tokenGenerated: false,
      };
    }
    throw tokenFileError(error, 'create');
  }
}

function normalizeTokenFilePath(pathValue: string): string {
  if (pathValue.trim().length === 0) {
    throw new ConfigError(`--${CliFlag.TokenFile} must not be empty`);
  }
  if (pathValue.includes('\0')) {
    throw new ConfigError('token file path is invalid');
  }
  return resolve(pathValue);
}

function assertTokenFileParent(tokenPath: string): void {
  const parentPath = dirname(tokenPath);
  let parentStats: Stats;
  try {
    parentStats = lstatSync(parentPath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      throw new ConfigError('token file parent directory must already exist');
    }
    throw new ConfigError('token file parent directory cannot be accessed');
  }

  if (!parentStats.isDirectory()) {
    throw new ConfigError('token file parent must be a directory');
  }
}

function readTokenFile(tokenPath: string): string {
  let descriptor: number;
  try {
    descriptor = openTokenFile(
      tokenPath,
      fsConstants.O_RDONLY | fsConstants.O_NONBLOCK,
    );
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'EEXIST') {
      throw error;
    }
    throw tokenFileError(error, 'open');
  }

  try {
    validateTokenFileDescriptor(descriptor);
    const contents = readBounded(descriptor);
    // Validate the descriptor again after reading. This keeps a file that was
    // chmod'ed/chowned or grew while open from being accepted based only on a
    // stale pre-read stat result.
    validateTokenFileDescriptor(descriptor);
    return validateTokenFileContents(contents.toString('utf8').trim());
  } finally {
    closeSync(descriptor);
  }
}

function createTokenFile(tokenPath: string, token: string): void {
  const descriptor = openTokenFile(
    tokenPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
    0o600,
  );

  try {
    validateTokenFileDescriptor(descriptor);
    const data = Buffer.from(token, 'utf8');
    let offset = 0;
    while (offset < data.length) {
      offset += writeSync(descriptor, data, offset, data.length - offset);
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function openTokenFile(
  tokenPath: string,
  flags: number,
  mode?: number,
): number {
  const noFollow = process.platform === 'win32'
    ? 0
    : fsConstants.O_NOFOLLOW;
  return openSync(tokenPath, flags | noFollow, mode);
}

function validateTokenFileDescriptor(descriptor: number): void {
  const stats = fstatSync(descriptor);
  if (!stats.isFile()) {
    throw new ConfigError('token file must be a regular file');
  }
  if (stats.size > MAX_TOKEN_FILE_BYTES) {
    throw new ConfigError(`token file exceeds ${MAX_TOKEN_FILE_BYTES} bytes`);
  }

  if (process.platform !== 'win32') {
    const uid = process.getuid?.();
    if (uid !== undefined && stats.uid !== uid) {
      throw new ConfigError('token file must be owned by the current user');
    }
    if ((stats.mode & 0o077) !== 0 || (stats.mode & 0o400) === 0) {
      throw new ConfigError('token file permissions must be owner-only');
    }
  }
}

function readBounded(descriptor: number): Buffer {
  const buffer = Buffer.alloc(MAX_TOKEN_FILE_BYTES + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const bytesRead = readSync(
      descriptor,
      buffer,
      offset,
      buffer.length - offset,
      null,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > MAX_TOKEN_FILE_BYTES) {
    throw new ConfigError(`token file exceeds ${MAX_TOKEN_FILE_BYTES} bytes`);
  }
  return buffer.subarray(0, offset);
}

function validateToken(token: string): string {
  if (token.length < MINIMUM_TOKEN_LENGTH) {
    throw new ConfigError(
      `adapter token must be at least ${MINIMUM_TOKEN_LENGTH} characters`,
    );
  }
  if (token.length > MAX_TOKEN_FILE_BYTES) {
    throw new ConfigError(
      `adapter token must not exceed ${MAX_TOKEN_FILE_BYTES} characters`,
    );
  }
  if (!/^[A-Za-z0-9._~+/=-]+$/u.test(token)) {
    throw new ConfigError('adapter token contains invalid bearer-token characters');
  }
  return token;
}

function validateTokenFileContents(contents: string): string {
  if (contents.length === 0 || /\s/u.test(contents)) {
    throw new ConfigError('token file must contain one non-empty bearer token');
  }
  return validateToken(contents);
}

function tokenFileError(error: unknown, action: string): Error {
  if (
    error instanceof Error
    && (
      error.message.startsWith('token file')
      || error.message.startsWith('adapter token')
    )
  ) {
    return error;
  }
  if (errorCode(error) === 'ELOOP') {
    return new ConfigError('token file must not be a symlink');
  }
  return new ConfigError(`unable to ${action} token file`);
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as TokenFileError;
  return candidate.code;
}

function readInteger(
  value: string | undefined,
  fallback: number,
  name: CliFlag,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (value === undefined) return fallback;

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    if (maximum === Number.MAX_SAFE_INTEGER) {
      throw new ConfigError(`--${name} must be a positive integer`);
    }
    throw new ConfigError(`--${name} must be between 1 and ${maximum}`);
  }
  return parsed;
}

function isCliCommand(value: string): value is CliCommand {
  return value === CliCommand.Serve || value === CliCommand.Status;
}

function isCliFlag(value: string): value is CliFlag {
  return (Object.values(CliFlag) as string[]).includes(value);
}

export const HELP = `Usage: codex-openai-proxy [serve|status] [options]

Options (flags override environment variables):
  --host HOST              Bind host (default 127.0.0.1)
  --port PORT              Bind port (default 18080; 1-65535)
  --token TOKEN            Bearer token (generated when omitted)
  --token-file PATH        Persistent bearer token file (mode 0600)
  --codex-bin PATH         Codex executable (default codex)
  --body-limit BYTES       Maximum JSON body (default 1048576)
  --timeout MS              Completion timeout (default 120000)
  --startup-timeout MS     Codex startup timeout (default 60000)
  --max-concurrency N      In-flight requests (default 1; excess gets 429)
`;
