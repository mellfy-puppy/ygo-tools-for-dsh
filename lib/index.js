// ygo-tools-for-dsh — native DeepSeek Harness tools for Yu-Gi-Oh.
//
// Architecture (hot-pluggable engine):
//   - This plugin stays THIN inside the DSH host process: it holds only the
//     tool schemas and a small HTTP client.
//   - The heavy engine (card database, scripts, WASM core, duel sessions,
//     YGOPro2 bridge) runs in a DETACHED persistent engine host process
//     (`skill/backend/persistent-engine-server.mjs`) on a loopback port.
//   - The engine process starts lazily on the FIRST YGO tool call
//     (autoStart), survives DSH restarts, and is restarted automatically by
//     the client on the next call when it crashed or was shut down.
//   - `manageEngineSession {action:"shutdown",confirm:true}` ends the engine process; the next
//     tool call starts a fresh one. That is the hot-unplug/replug path.
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { renderSkillContent } from '@deepseek-ai/dsh-skill';
import { createModelToolHost } from '../skill/backend/index.mjs';
import { createPersistentEngineClient } from '../skill/backend/persistent-engine-client.mjs';
import { attachDuelWatcher, startDuelWatcher } from './duel-watcher.js';

const LIB_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(LIB_DIR, '..');
const SKILL_DIR = join(PACKAGE_DIR, 'skill');
const SKILL_BODY_FILE = join(LIB_DIR, 'dsh-skill.md');

export const name = 'ygo-tools';
export const inject = ['tools', 'skills'];

export default {
  name,
  inject,
  *apply(ctx, config = {}) {
    const options = resolvePluginConfig(config);
    const activeDeckContexts = new Map();

    // In-process host is used ONLY to read the authoritative tool schemas.
    // No engine session is ever executed through it; the real backend is the
    // detached engine host process the client below manages.
    const schemaHost = createModelToolHost();
    // Cordis owns every yielded disposer, including rollback if a later
    // registration fails. Dispose the thin schema host after its tools.
    yield () => {
      activeDeckContexts.clear();
      schemaHost.clearSessions();
    };
    const engineClient = createPersistentEngineClient({
      hostname: options.engineHostname,
      port: options.enginePort,
      autoStart: options.engineAutoStart,
      startupTimeoutMs: options.engineStartupTimeoutMs,
      serverEnv: options.serverEnv,
    });

    // Optional: when the job registry is mounted, a hosted room wakes the
    // session as soon as the opponent starts the duel.
    const jobsRef = { current: undefined };
    ctx.inject?.(['jobs'], (jobCtx) => {
      jobsRef.current = jobCtx.jobs;
      jobCtx.effect?.(() => () => { jobsRef.current = undefined; });
    });

    for (const schema of schemaHost.listTools()) {
      const toolName = schema.name;
      yield ctx.tools.register(defineTool({
        name: toolName,
        description: schema.description ?? `YGO backend tool ${toolName}.`,
        parameters: translateParameters(schema.input_schema),
        timeoutMs: options.timeoutMs,
        output: {
          schema: {
            type: 'object',
            properties: { ok: { type: 'boolean', required: true } },
            additionalProperties: true,
          },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        async execute(args, exec) {
          assertNotAborted(exec.signal, toolName);
          const sessionId = sessionKeyFor(exec);
          let response;
          try {
            response = await engineClient.execute(
              { name: toolName, input: args ?? {} },
              { sessionId, signal: exec.signal, timeoutMs: options.timeoutMs },
            );
          } catch (error) {
            assertNotAborted(exec.signal, toolName);
            return engineFailure(toolName, error);
          }
          assertNotAborted(exec.signal, toolName);
          deferDeckContext(exec, sessionId, response, activeDeckContexts, toolName, args);
          const result = publicResult(response);
          if (toolName === 'manageYgoPro2' && args?.action === 'host' && result?.ok) {
            attachDuelWatcher(result, startDuelWatcher(jobsRef.current, engineClient, exec, sessionId));
          }
          return result;
        },
      }));
    }



    yield ctx.skills.register(loadPackagedSkill());
    // The detached engine deliberately outlives plugin disposal. Only an
    // explicitly confirmed manageEngineSession action clears its live state.
  },
};

// ── config resolution ──────────────────────────────────────────────────────

export function resolvePluginConfig(config = {}) {
  const record = config && typeof config === 'object' ? config : {};
  // The data root MUST share a volume with the installed package: the card
  // data updater stages downloads under <cacheDir> and finishes with an
  // atomic directory rename into the package's resources/lib, and Windows
  // rejects cross-drive rename (EXDEV). The deployment home (DSH_HOME) is
  // always on the same drive as the profile's node_modules, so it is the
  // right default; os.homedir() is not (it can sit on another volume).
  const defaultDataRoot = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'ygo-tools-for-dsh');
  const dataRoot = resolve(String(
    record.dataRoot
    ?? process.env.YGO_DSH_DATA_ROOT
    ?? defaultDataRoot,
  ));

  // Writable output roots travel to the engine process through environment
  // variables (the engine host resolves its own config from its env).
  const serverEnv = {
    YGO_CACHE_DIR: resolve(String(record.cacheDir ?? process.env.YGO_CACHE_DIR ?? join(dataRoot, 'cache'))),
    YGO_REPLAY_DIR: resolve(String(record.replayDir ?? process.env.YGO_REPLAY_DIR ?? join(dataRoot, 'replays'))),
    YGO_ROUTE_DIR: resolve(String(record.routeDir ?? process.env.YGO_ROUTE_DIR ?? join(dataRoot, 'routes'))),
    YGO_DECK_DIR: resolve(String(record.deckDir ?? process.env.YGO_DECK_DIR ?? join(dataRoot, 'decks'))),
    YGO_DECK_SKILL_DIR: resolve(String(record.deckSkillDir ?? process.env.YGO_DECK_SKILL_DIR ?? join(dataRoot, 'deck-skills'))),
  };
  if (record.cardsDbPath !== undefined) serverEnv.YGO_CARDS_DB = String(record.cardsDbPath);
  if (record.scriptsDir !== undefined) serverEnv.YGO_SCRIPTS_DIR = String(record.scriptsDir);
  if (record.engineBackend !== undefined) serverEnv.YGO_ENGINE_BACKEND = String(record.engineBackend);
  if (record.allowNetworkUpdate !== undefined) serverEnv.YGO_ALLOW_NETWORK_UPDATE = record.allowNetworkUpdate ? '1' : '0';

  return {
    engineHostname: String(record.engineHostname ?? process.env.YGO_ENGINE_HOST ?? '127.0.0.1'),
    enginePort: Number(record.enginePort ?? process.env.YGO_ENGINE_HOST_PORT ?? 19981),
    engineAutoStart: record.engineAutoStart !== false,
    engineStartupTimeoutMs: positiveInt(record.engineStartupTimeoutMs, 30000),
    timeoutMs: positiveInt(record.timeoutMs, 300000),
    serverEnv,
  };
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

// ── JSON Schema → DSH parameter DSL ─────────────────────────────────────────
//
// The backend is the authoritative validator (`validateToolInput`); the DSH
// DSL carries the model-facing shape. Keywords the DSL cannot express
// (min/max bounds, minLength, required-combos at the root) are dropped here
// and still enforced by the engine host.

function translateParameters(schema) {
  if (!schema || typeof schema !== 'object') return {};
  const converted = convertNode(schema);
  if (converted && converted.type === 'object' && converted.properties) {
    return converted.properties;
  }
  return {};
}

function convertNode(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return { type: 'json' };
  const union = node.oneOf ?? node.anyOf;
  const hasShape = node.type !== undefined || node.properties !== undefined;
  if (!hasShape && Array.isArray(union) && union.length >= 2) {
    return { oneOf: union.map(convertNode) };
  }
  const type = node.type ?? (node.properties !== undefined ? 'object' : undefined);
  switch (type) {
    case 'object': {
      const properties = {};
      const required = new Set(Array.isArray(node.required) ? node.required : []);
      const source = node.properties && typeof node.properties === 'object' ? node.properties : {};
      for (const [key, prop] of Object.entries(source)) {
        const converted = convertNode(prop);
        properties[key] = required.has(key) ? { ...converted, required: true } : converted;
      }
      return {
        type: 'object',
        properties,
        additionalProperties: node.additionalProperties !== false,
      };
    }
    case 'array': {
      const result = { type: 'array' };
      if (node.items !== undefined) result.items = convertNode(node.items);
      return result;
    }
    case 'string':
    case 'integer':
    case 'number':
    case 'boolean':
      return {
        type,
        ...pickScalarAnnotations(node),
      };
    case 'null':
      return { type: 'null' };
    default:
      return { type: 'json' };
  }
}

function pickScalarAnnotations(node) {
  const output = {};
  for (const key of ['enum', 'const', 'default', 'description', 'title', 'examples']) {
    if (node[key] !== undefined) output[key] = node[key];
  }
  return output;
}

// ── session binding and result shaping ──────────────────────────────────────

function sessionKeyFor(exec) {
  // DSH 0.1.7's live Agent owns the durable Session. Agent.id is the same
  // session identity and remains a fallback for narrower execution handles.
  const sessionId = exec?.agent?.session?.id;
  if (typeof sessionId === 'string' && sessionId.trim()) return `dsh-${sessionId}`;
  const agentId = exec?.agent?.id;
  if (typeof agentId === 'string' && agentId.trim()) return `dsh-${agentId}`;
  throw new Error('YGO tools require a DSH agent session identity; refusing to share an anonymous engine session.');
}

function assertNotAborted(signal, toolName) {
  if (signal?.aborted) throw new Error(`YGO tool ${toolName} was cancelled.`);
}

function publicResult(result) {
  // Keep the canonical value structured for DSH's native and PTC runtimes.
  // The host-owned engine routing identity is never a model argument/result.
  return JSON.parse(JSON.stringify(result, (key, value) => (key === 'sessionId' ? undefined : value)));
}

function engineFailure(toolName, error) {
  return {
    ok: false,
    code: 'ENGINE_HOST_FAILURE',
    error: `YGO engine host failed while executing ${toolName}: ${error instanceof Error ? error.message : String(error)}`,
    hint: 'The persistent engine host is unreachable or died. The next YGO tool call automatically starts a fresh engine host (previous sessions are lost). Call manageEngineSession with action:"status" to resync; when exists:false, reload the deck with manageSessionDeck action:"set" before continuing. If the host is alive but wedged, call manageEngineSession with action:"shutdown" and confirm:true; the next call restarts the engine.',
  };
}

function deferDeckContext(exec, sessionId, response, activeDeckContexts, toolName, args) {
  if (response?.ok === false || response?.result?.ok === false) return;
  const data = response?.result?.data;
  let deckSkills = data?.context?.deckSkills ?? data?.deckSkills;
  if (toolName === 'manageEngineSession'
    && (args?.action === 'clear' || args?.action === 'shutdown' || data?.exists === false)) {
    deckSkills = { deckFingerprint: null, skills: [] };
  }
  if (!deckSkills || !Array.isArray(deckSkills.skills)) return;
  const skills = deckSkills.skills.filter((skill) => typeof skill?.name === 'string'
    && typeof skill?.content === 'string' && skill.content.trim());
  const fingerprint = typeof deckSkills.deckFingerprint === 'string' ? deckSkills.deckFingerprint : null;
  const digest = createHash('sha256').update(JSON.stringify({ fingerprint, skills })).digest('hex');
  const previous = activeDeckContexts.get(sessionId);
  if (previous?.digest === digest) return;
  // Publish the first empty snapshot too: a resumed conversation can retain
  // learned instructions from before this plugin instance or engine restarted.
  if (typeof exec.deferContext !== 'function') {
    throw new Error('YGO deck learning requires DSH ToolRunContext.deferContext().');
  }
  const sections = [{
    name: 'current-deck',
    text: skills.length
      ? `Active learned YGO skills for deck ${fingerprint ?? '(current deck)'}. This snapshot replaces earlier learned-deck context. Use these replay-derived operations as guidance and verify each action against the current legal actions.`
      : 'No learned YGO skill is active for the current deck. Earlier learned-deck context is inactive.',
  }, ...skills.map((skill) => ({
    name: skill.name,
    text: renderSkillContent({
      name: skill.name,
      provider: 'ygo-deck-learning',
      ...(typeof skill.path === 'string' ? { resourceBase: { kind: 'directory', path: dirname(skill.path) } } : {}),
      content: skill.content,
    }),
  }))];
  exec.deferContext(createUserMessage({
    content: [{ type: 'text', text: sections.map((section) => section.text).join('\n\n') }],
    source: { kind: 'ygo-deck-skills', form: 'snapshot', deckFingerprint: fingerprint, sections },
  }));
  activeDeckContexts.set(sessionId, { digest });
}

// ── packaged skill registration ─────────────────────────────────────────────

const SKILL_FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;

function loadPackagedSkill() {
  const raw = readFileSync(SKILL_BODY_FILE, 'utf8');
  const match = SKILL_FRONTMATTER.exec(raw);
  const frontmatter = {};
  if (match) {
    for (const line of match[1].split(/\r?\n/)) {
      const separator = line.indexOf(':');
      if (separator <= 0) continue;
      const key = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim();
      if (key && value) frontmatter[key] = value;
    }
  }
  return {
    name: frontmatter.name ?? 'ygoagentskill',
    description: frontmatter.description ?? 'Yu-Gi-Oh engine work through the mounted YGO tools.',
    source: 'runtime',
    provider: 'ygo-tools',
    invocation: { modelInvocable: true, userInvocable: true },
    path: SKILL_BODY_FILE,
    resourceBase: { kind: 'directory', path: SKILL_DIR },
    content: raw.slice(match ? match[0].length : 0).trim(),
  };
}
