import type { Logger } from './types.js';

const SECRET_KEYS = /token|authorization|api[-_]?key|credential|password|secret|body/i;

function safeFields(fields: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!fields) return {};
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    output[key] = SECRET_KEYS.test(key) ? '[redacted]' : value;
  }
  return output;
}

export const logger: Logger = {
  info(event, fields) {
    console.error(JSON.stringify({ level: 'info', event, ...safeFields(fields) }));
  },
  warn(event, fields) {
    console.error(JSON.stringify({ level: 'warn', event, ...safeFields(fields) }));
  },
  error(event, fields) {
    console.error(JSON.stringify({ level: 'error', event, ...safeFields(fields) }));
  },
};
