import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

function runSmoke(env) {
  const result = spawnSync(process.execPath, ['examples/smoke.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, ...env, OPENAI_API_KEY: '', CODEX_PROXY_TOKEN_FILE: '' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  return JSON.parse(result.stdout);
}

test('smoke rejects non-loopback base URLs without exposing details', () => {
  const summary = runSmoke({ OPENAI_BASE_URL: 'http://example.test/v1' });
  assert.deepEqual(summary.capabilities, {
    setup: { status: 'failed', category: 'setup_failed' },
  });
});

test('smoke rejects empty section selection without exposing details', () => {
  const summary = runSmoke({ PROXY_SMOKE_SECTIONS: '' });
  assert.deepEqual(summary.capabilities, {
    setup: { status: 'failed', category: 'setup_failed' },
  });
});
