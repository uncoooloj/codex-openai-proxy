// Verified feature names for the exact supported Codex CLI (0.146.0).
// Keep process and per-thread policy in one place so neither can drift.
const DISABLED_NATIVE_FEATURES = [
  'shell_tool', 'unified_exec', 'shell_snapshot', 'apps', 'multi_agent',
  'multi_agent_v2', 'remote_plugin', 'plugins', 'plugin_sharing', 'hooks',
  'goals', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access',
  'in_app_browser', 'computer_use', 'image_generation', 'memories',
  'skill_search', 'skill_mcp_dependency_install', 'tool_suggest',
  'workspace_dependencies', 'code_mode_host', 'auth_elicitation',
  'tool_call_mcp_elicitation', 'default_mode_request_user_input',
] as const;

export function disabledFeatureConfiguration(): Record<string, boolean | string> {
  return {
    ...Object.fromEntries(DISABLED_NATIVE_FEATURES.map((name) => [`features.${name}`, false])),
    web_search: 'disabled',
  };
}

export function codexAppServerArguments(): string[] {
  const settings = Object.entries(disabledFeatureConfiguration())
    .flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]);
  return ['app-server', ...settings, '--listen', 'stdio://'];
}

export function removeAdapterEnvironment(env: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(env)) {
    if (key.startsWith('CODEX_PROXY_') || key.startsWith('CODEX_OPENAI_PROXY_')) {
      delete env[key];
    }
  }
  // Codex uses its own authenticated login, not a client adapter key or URL.
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_BASE_URL;
  delete env.OPENAI_API_BASE;
}
