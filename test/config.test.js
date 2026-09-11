import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseConfig } from '../dist/config.js';

const TOKEN = 'configured-token-that-is-long-enough-123456';
const OTHER_TOKEN = 'another-configured-token-that-is-long-enough-123456';

function inTempDirectory(callback) {
  const directory = mkdtempSync(join(tmpdir(), 'codex-proxy-config-'));
  try {
    return callback(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('uses the startup timeout default and preserves legacy environment aliases', () => {
  const config = parseConfig({
    args: [],
    env: {
      CODEX_OPENAI_PROXY_TOKEN: TOKEN,
      CODEX_OPENAI_PROXY_STARTUP_TIMEOUT_MS: '2500',
    },
  });

  assert.equal(config.startupTimeoutMs, 2500);
  assert.equal(config.token, TOKEN);
  assert.equal(config.tokenGenerated, false);
});

test('flags take precedence over environment values for token and startup timeout', () => {
  inTempDirectory((directory) => {
    const ignoredTokenFile = join(directory, 'ignored-token');
    const config = parseConfig({
      args: ['--token', TOKEN, '--startup-timeout', '1500'],
      env: {
        CODEX_PROXY_TOKEN: OTHER_TOKEN,
        CODEX_PROXY_TOKEN_FILE: ignoredTokenFile,
        CODEX_PROXY_STARTUP_TIMEOUT_MS: '2500',
      },
    });

    assert.equal(config.token, TOKEN);
    assert.equal(config.tokenGenerated, false);
    assert.equal(config.startupTimeoutMs, 1500);
    assert.equal(existsSync(ignoredTokenFile), false);
  });
});

test('rejects unknown, missing, and empty flag values', () => {
  assert.throws(
    () => parseConfig({ args: ['--not-a-config-option'], env: {} }),
    /unknown option/,
  );
  assert.throws(
    () => parseConfig({ args: ['--port'], env: {} }),
    /--port requires a value/,
  );
  assert.throws(
    () => parseConfig({ args: ['--token='], env: {} }),
    /--token must not be empty/,
  );
  assert.throws(
    () => parseConfig({ args: ['--startup-timeout', '--port', '18081'], env: {} }),
    /--startup-timeout requires a value/,
  );
});

test('enforces port and startup timeout bounds', () => {
  assert.equal(
    parseConfig({ args: ['--port', '65535'], env: {} }).port,
    65535,
  );
  assert.throws(
    () => parseConfig({ args: ['--port', '65536'], env: {} }),
    /--port must be between 1 and 65535/,
  );
  assert.throws(
    () => parseConfig({ args: ['--port', '0'], env: {} }),
    /--port must be between 1 and 65535/,
  );
  assert.throws(
    () => parseConfig({ args: ['--startup-timeout', '0'], env: {} }),
    /--startup-timeout must be between 1/,
  );
  assert.throws(
    () => parseConfig({ args: ['--startup-timeout', '2147483648'], env: {} }),
    /--startup-timeout must be between 1/,
  );
});

test('creates a token file with stable owner-only credentials', () => {
  inTempDirectory((directory) => {
    const tokenPath = join(directory, 'adapter-token');
    const first = parseConfig({ args: ['--token-file', tokenPath], env: {} });
    const second = parseConfig({ args: ['--token-file', tokenPath], env: {} });
    const mode = lstatSync(tokenPath).mode & 0o777;

    assert.equal(first.tokenGenerated, false);
    assert.match(first.token, /^[A-Za-z0-9_-]{43}$/u);
    assert.equal(second.token, first.token);
    assert.equal(second.tokenGenerated, false);
    assert.equal(mode, 0o600);
    assert.equal(readFileSync(tokenPath, 'utf8'), first.token);
  });
});

test('reads an existing token file and gives token-file precedence over env token', () => {
  inTempDirectory((directory) => {
    const tokenPath = join(directory, 'adapter-token');
    writeFileSync(tokenPath, `${TOKEN}\n`, { mode: 0o600 });

    const config = parseConfig({
      args: ['--token-file', tokenPath],
      env: { CODEX_PROXY_TOKEN: OTHER_TOKEN },
    });
    assert.equal(config.token, TOKEN);
    assert.equal(config.tokenGenerated, false);
  });
});

test('rejects conflicting environment token sources', () => {
  inTempDirectory((directory) => {
    assert.throws(
      () => parseConfig({
        args: [],
        env: {
          CODEX_PROXY_TOKEN: TOKEN,
          CODEX_PROXY_TOKEN_FILE: join(directory, 'adapter-token'),
        },
      }),
      /cannot be used together/,
    );
  });
});

test('rejects token-file symlinks, insecure permissions, non-files, and missing parents', () => {
  inTempDirectory((directory) => {
    const target = join(directory, 'target');
    writeFileSync(target, TOKEN, { mode: 0o600 });

    const symlinkPath = join(directory, 'symlink');
    symlinkSync(target, symlinkPath);
    assert.throws(
      () => parseConfig({ args: ['--token-file', symlinkPath], env: {} }),
      /symlink/,
    );

    const insecure = join(directory, 'insecure');
    writeFileSync(insecure, TOKEN, { mode: 0o644 });
    chmodSync(insecure, 0o644);
    assert.throws(
      () => parseConfig({ args: ['--token-file', insecure], env: {} }),
      /owner-only/,
    );

    const tokenDirectory = join(directory, 'directory');
    mkdirSync(tokenDirectory);
    assert.throws(
      () => parseConfig({ args: ['--token-file', tokenDirectory], env: {} }),
      /regular file|read token file/,
    );

    assert.throws(
      () => parseConfig({
        args: ['--token-file', join(directory, 'missing', 'adapter-token')],
        env: {},
      }),
      /parent directory must already exist/,
    );
  });
});

test('rejects named pipes without blocking on POSIX', {
  skip: process.platform === 'win32',
}, () => {
  inTempDirectory((directory) => {
    const fifoPath = join(directory, 'named-pipe');
    const fifo = spawnSync('mkfifo', [fifoPath], { timeout: 1000 });
    assert.equal(fifo.error, undefined);
    assert.equal(fifo.status, 0);

    const moduleUrl = new URL('../dist/config.js', import.meta.url).href;
    const script = `
      import { parseConfig } from ${JSON.stringify(moduleUrl)};
      try {
        parseConfig({ args: ['--token-file', process.argv[1]], env: {} });
        process.exitCode = 2;
      } catch (error) {
        process.exitCode = error.message.includes('regular file') ? 0 : 3;
      }
    `;
    const child = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', script, fifoPath],
      { timeout: 1000, encoding: 'utf8' },
    );
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0);
  });
});

test('rejects empty and oversized token files without generating replacement credentials', () => {
  inTempDirectory((directory) => {
    const emptyPath = join(directory, 'empty');
    writeFileSync(emptyPath, '', { mode: 0o600 });
    assert.throws(
      () => parseConfig({ args: ['--token-file', emptyPath], env: {} }),
      /non-empty|at least 24/,
    );
    assert.equal(readFileSync(emptyPath, 'utf8'), '');

    const oversizedPath = join(directory, 'oversized');
    writeFileSync(oversizedPath, 'x'.repeat(4097), { mode: 0o600 });
    assert.throws(
      () => parseConfig({ args: ['--token-file', oversizedPath], env: {} }),
      /exceeds 4096 bytes/,
    );
  });
});

test('status and help do not create a configured token file', () => {
  inTempDirectory((directory) => {
    const statusPath = join(directory, 'status-token');
    const helpPath = join(directory, 'help-token');

    const status = parseConfig({
      args: ['status', '--token-file', statusPath],
      env: {},
    });
    const help = parseConfig({
      args: ['--help', '--token-file', helpPath],
      env: {},
    });

    assert.equal(status.tokenGenerated, false);
    assert.equal(help.tokenGenerated, false);
    assert.equal(existsSync(statusPath), false);
    assert.equal(existsSync(helpPath), false);
  });
});

test('does not create a token file when another explicit setting is malformed', () => {
  inTempDirectory((directory) => {
    const tokenPath = join(directory, 'adapter-token');
    assert.throws(
      () => parseConfig({
        args: ['--token-file', tokenPath, '--port', '65536'],
        env: {},
      }),
      /--port must be between 1 and 65535/,
    );
    assert.equal(existsSync(tokenPath), false);
  });
});
