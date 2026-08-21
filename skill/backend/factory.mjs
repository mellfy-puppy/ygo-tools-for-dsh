import { resolveSkillConfig } from './config.mjs';
import { createSourceAdapter } from './source-adapter.mjs';

export const BACKEND_STATUS = Object.freeze({
  ok: true,
  code: 'BACKEND_ADAPTER_READY',
  message: 'YGOagentskill backend adapter can load bundled runtime modules without a fixed frontend or LLM provider.',
});

export function createYgoBackend(config = {}) {
  const adapter = createSourceAdapter(resolveBackendConfig(config));
  return {
    config: adapter.config,
    status: BACKEND_STATUS,
    listTools: adapter.listTools,
    getToolSchema: adapter.getToolSchema,
    getAllToolSchemas: adapter.getAllToolSchemas,
    executeTool: adapter.executeTool,
    createSession: adapter.createSession,
    createRunner: adapter.createRunner,
    ensureRunner: adapter.ensureRunner,
    loadModule: adapter.loadModule,
  };
}

export function resolveBackendConfig(config = {}) {
  return {
    ...resolveSkillConfig(config.env ?? process.env),
    ...config,
  };
}
