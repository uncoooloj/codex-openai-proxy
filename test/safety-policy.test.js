import assert from 'node:assert/strict';
import test from 'node:test';
import { codexAppServerArguments, disabledFeatureConfiguration, removeAdapterEnvironment } from '../dist/safety-policy.js';

test('process and thread use the same explicit native-tool restrictions', () => {
  const args = codexAppServerArguments();
  const policy = disabledFeatureConfiguration();
  for (const [key, value] of Object.entries(policy)) {
    assert.ok(args.includes(`${key}=${JSON.stringify(value)}`));
  }
  for (const feature of ['shell_tool', 'browser_use', 'computer_use', 'plugins', 'multi_agent_v2', 'image_generation']) {
    assert.equal(policy[`features.${feature}`], false);
  }
});

test('Codex child environment excludes adapter credentials and routing', () => {
  const env = {
    CODEX_PROXY_TOKEN: 'private', CODEX_OPENAI_PROXY_TOKEN: 'private',
    CODEX_PROXY_TOKEN_FILE: '/private/token', OPENAI_API_KEY: 'private',
    OPENAI_BASE_URL: 'http://127.0.0.1:18080/v1', OPENAI_API_BASE: 'private',
    CODEX_HOME: '/isolated', PATH: '/usr/bin',
  };
  removeAdapterEnvironment(env);
  assert.deepEqual(env, { CODEX_HOME: '/isolated', PATH: '/usr/bin' });
});
