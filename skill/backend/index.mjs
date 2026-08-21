import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createYgoSession as createAdapterSession,
} from './source-adapter.mjs';
import { BACKEND_STATUS, createYgoBackend, resolveBackendConfig } from './factory.mjs';
import { createModelToolHost } from './model-tool-host.mjs';

const BACKEND_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(BACKEND_DIR, '..');
const PROMPT_REFERENCES = Object.freeze({
  global: 'prompt-global.md',
  planning: 'prompt-planning.md',
  truthfulness: 'prompt-truthfulness.md',
  routeReport: 'prompt-route-report.md',
  'route-report': 'prompt-route-report.md',
});

export { BACKEND_STATUS, createYgoBackend };

export function createYgoSession(input = {}) {
  const record = input && typeof input === 'object' ? input : {};
  const isSessionInitial = ['metadata', 'messages', 'runner', 'config'].some((key) => Object.hasOwn(record, key));
  const config = isSessionInitial ? record.config ?? {} : record;
  return createAdapterSession({
    ...(isSessionInitial ? record : {}),
    config: resolveBackendConfig(config),
  });
}

export function listTools() {
  return createModelToolHost().listTools().map((tool) => tool.name);
}

export function getToolSchema(name) {
  const tool = createModelToolHost().listTools().find((entry) => entry.name === name);
  return tool
    ? { ok: true, data: tool }
    : { ok: false, code: 'UNKNOWN_TOOL', error: `Unknown YGO model tool: ${name}` };
}

export function getAllToolSchemas() {
  return createModelToolHost().listTools();
}

export async function executeTool(name, context = {}, input = {}) {
  return createYgoBackend(context?.config ?? {}).executeTool(name, context, input);
}

export { createModelToolHost };
export { HOST_CONTROL_TOOL_NAMES, normalizeToolCall } from './model-tool-host.mjs';
export { createPersistentEngineClient } from './persistent-engine-client.mjs';
export { createPersistentEngineServer, DEFAULT_ENGINE_HOST, DEFAULT_ENGINE_PORT, ENGINE_HOST_PROTOCOL } from './persistent-engine-server.mjs';
export {
  PUBLIC_TOOL_DESCRIPTIONS,
  PUBLIC_TOOL_INPUT_SCHEMAS,
  PUBLIC_TOOL_NAMES,
  TOOL_DESCRIPTIONS,
  TOOL_INPUT_SCHEMAS,
  validatePublicToolInput,
  validateToolInput,
} from './tool-schemas.mjs';
export { discoverYgoPro2 } from './ygopro2-discovery.mjs';
export { buildComboAdaptationReport, normalizeComboArtifact, parseComboArtifactInput } from './combo-artifact.mjs';

export async function runToolSequence(steps = [], options = {}) {
  if (!Array.isArray(steps)) {
    return { ok: false, code: 'INVALID_WORKFLOW', error: 'runToolSequence requires an array of steps.' };
  }
  const backend = createYgoBackend(options.config ?? {});
  const session = options.session ?? backend.createSession({
    metadata: options.metadata,
    messages: options.messages,
  });
  const results = [];
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index] ?? {};
    const name = typeof step.tool === 'string' ? step.tool : typeof step.name === 'string' ? step.name : '';
    if (!name) {
      const result = { ok: false, code: 'INVALID_WORKFLOW_STEP', error: `Workflow step ${index + 1} is missing tool/name.` };
      results.push({ step: index + 1, tool: null, input: step.input ?? {}, result });
      return { ok: false, data: { results, session: summarizeSession(session) }, session };
    }
    const input = step.input && typeof step.input === 'object' ? step.input : {};
    const result = await backend.executeTool(name, { session, config: backend.config }, input);
    if (name === 'parseYrpRoute' && result.ok) {
      session.mergeMetadata({ lastParsedYrpRoute: result.data, lastParsedYrpRouteUpdatedAt: new Date().toISOString() });
    }
    results.push({ step: index + 1, tool: name, input, result });
    if (result.ok === false && step.continueOnError !== true && options.continueOnError !== true) {
      return { ok: false, data: { results, session: summarizeSession(session) }, session };
    }
  }
  return { ok: true, data: { results, session: summarizeSession(session) }, session };
}

export function summarizeSession(session) {
  const metadata = session?.metadata && typeof session.metadata === 'object' ? session.metadata : {};
  const parsedReplay = metadata.lastParsedYrpRoute && typeof metadata.lastParsedYrpRoute === 'object'
    ? metadata.lastParsedYrpRoute
    : null;
  const parsedCombo = metadata.lastParsedComboArtifact && typeof metadata.lastParsedComboArtifact === 'object'
    ? metadata.lastParsedComboArtifact
    : null;
  return {
    messageCount: Array.isArray(session?.messages) ? session.messages.length : 0,
    hasRunner: Boolean(session?.runner),
    loadedDeckName: typeof metadata.currentDeckName === 'string' ? metadata.currentDeckName : null,
    fixedOpeningCards: Array.isArray(metadata.fixedOpeningCards) ? metadata.fixedOpeningCards.slice() : [],
    lastParsedReplay: parsedReplay ? {
      fileName: parsedReplay.source?.fileName ?? null,
      responseCount: parsedReplay.summary?.responseCount ?? null,
      updatedAt: metadata.lastParsedYrpRouteUpdatedAt ?? null,
    } : null,
    lastParsedCombo: parsedCombo ? {
      schemaType: parsedCombo.schemaType ?? null,
      archiveStatus: parsedCombo.archiveStatus ?? null,
      stepCount: Array.isArray(parsedCombo.steps) ? parsedCombo.steps.length : 0,
      updatedAt: metadata.lastParsedComboArtifactUpdatedAt ?? null,
    } : null,
    ygoPro2Discovery: metadata.ygoPro2Discovery && typeof metadata.ygoPro2Discovery === 'object'
      ? {
        found: metadata.ygoPro2Discovery.found === true,
        selectedRoot: metadata.ygoPro2Discovery.selected?.root ?? null,
        confidence: metadata.ygoPro2Discovery.selected?.confidence ?? null,
        liveDuelBridge: metadata.ygoPro2Discovery.selected?.capabilities?.liveDuelBridge === true,
        updatedAt: metadata.ygoPro2DiscoveryUpdatedAt ?? metadata.ygoPro2Discovery.recordedAt ?? null,
      }
      : null,
  };
}

export async function loadPromptReference(name) {
  const fileName = PROMPT_REFERENCES[name];
  if (!fileName) {
    return {
      ok: false,
      code: 'UNKNOWN_PROMPT_REFERENCE',
      error: `Unknown YGO prompt reference: ${name}`,
      available: Object.keys(PROMPT_REFERENCES),
    };
  }
  const path = resolve(SKILL_ROOT, 'references', fileName);
  const content = await readFile(path, 'utf8');
  return {
    ok: true,
    data: {
      name,
      path,
      content,
    },
  };
}

export function listPromptReferences() {
  const names = Object.keys(PROMPT_REFERENCES);
  return {
    ok: true,
    data: {
      names,
      canonicalNames: ['global', 'planning', 'truthfulness', 'route-report'],
    },
  };
}

export async function buildAgentPrompt(parts = []) {
  const loaded = [];
  for (const part of parts) {
    if (typeof part === 'string' && PROMPT_REFERENCES[part]) {
      loaded.push((await loadPromptReference(part)).data.content);
    } else if (typeof part === 'string') {
      loaded.push(part);
    }
  }
  return { ok: true, data: { prompt: loaded.join('\n\n'), parts } };
}
