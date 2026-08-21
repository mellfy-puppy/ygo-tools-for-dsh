// @ts-check

import {
  getCurrentState,
  listActions,
} from './state-tools.js';

const CHECKPOINT_METADATA_KEY = 'exploreCheckpoints';
const DEFAULT_GRAVEYARD_LIMIT = 6;
const MAX_NAME_LENGTH = 80;
const MAX_NOTE_LENGTH = 240;

/** @typedef {{ id: string, name: string, note: string | null, kind: 'manual' | 'auto', createdAt: string, updatedAt: string, restoredAt?: string | null, state: unknown, runnerConfig: unknown, summary: CheckpointStateSummary }} CheckpointRecord */
/** @typedef {{ historyLength: number | null, decision: string | null, terminal: boolean, actionCount: number | null }} CheckpointStateSummary */
/** @typedef {{ counter: number, checkpoints: Map<string, CheckpointRecord> }} CheckpointStore */
/** @typedef {{ name?: unknown, note?: unknown, overwrite?: unknown, graveyardLimit?: unknown }} SaveCheckpointInput */
/** @typedef {{ id?: unknown, name?: unknown, graveyardLimit?: unknown }} RestoreCheckpointInput */
/** @typedef {{ includeAutomatic?: unknown }} ListCheckpointsInput */
/** @typedef {{ id?: unknown, name?: unknown, all?: unknown, includeAutomatic?: unknown }} DeleteCheckpointInput */

/** @type {WeakMap<object, CheckpointStore>} */
const checkpointStores = new WeakMap();

/**
 * Save the current runner state under a model-visible checkpoint.
 *
 * @param {unknown} context
 * @param {SaveCheckpointInput} [input]
 */
export function saveCheckpoint(context, input = {}) {
  const resolved = resolveSessionAndRunner(context);
  if (!resolved.ok) return resolved;

  return saveCheckpointInternal(resolved.session, resolved.runner, {
    name: normalizeCheckpointName(input.name) ?? undefined,
    note: readLimitedString(input.note, MAX_NOTE_LENGTH),
    overwrite: input.overwrite === true,
    kind: 'manual',
  });
}

/**
 * Save a hidden automatic rollback point before a mutating game action.
 *
 * @param {unknown} context
 * @param {{ name?: string, note?: string }} [options]
 */
export function saveAutomaticCheckpoint(context, options = {}) {
  const resolved = resolveSessionAndRunner(context);
  if (!resolved.ok) return resolved;

  const historyLength = readHistoryLength(resolved.runner);
  const nextHistory = historyLength === null ? 'unknown' : String(historyLength + 1);
  const nextId = getCheckpointStore(resolved.session).counter + 1;
  return saveCheckpointInternal(resolved.session, resolved.runner, {
    name: normalizeCheckpointName(options.name) ?? `auto-before-action-${nextHistory}-${nextId}`,
    note: readLimitedString(options.note, MAX_NOTE_LENGTH) ?? 'Automatic checkpoint before executeAction.',
    overwrite: false,
    kind: 'auto',
  });
}

/**
 * Restore a saved runner checkpoint by id, by name, or the latest checkpoint.
 *
 * @param {unknown} context
 * @param {RestoreCheckpointInput} [input]
 */
export function restoreCheckpoint(context, input = {}) {
  const resolved = resolveSessionAndRunner(context);
  if (!resolved.ok) return resolved;

  const store = getCheckpointStore(resolved.session);
  const selected = findCheckpoint(store, {
    id: readNonEmptyString(input.id),
    name: normalizeCheckpointName(input.name),
    latestIfEmpty: true,
  });
  if (!selected) {
    return { ok: false, error: 'No matching checkpoint found. Call listCheckpoints to inspect available save points.' };
  }

  try {
    restoreRunnerConfig(resolved.runner, selected.runnerConfig);
    resolved.runner.restoreState(cloneRunnerState(selected.state));
  } catch (error) {
    return {
      ok: false,
      error: `Failed to restore checkpoint ${selected.id}: ${formatError(error)}`,
      data: { checkpoint: summarizeCheckpoint(selected) },
    };
  }

  selected.restoredAt = new Date().toISOString();
  selected.updatedAt = selected.restoredAt;
  syncCheckpointMetadata(resolved.session, store);

  return {
    ok: true,
    data: {
      action: 'restore',
      checkpoint: summarizeCheckpoint(selected),
      current: captureCurrentToolContext(resolved.runner, input),
    },
  };
}

/**
 * List saved runner checkpoints for this session.
 *
 * @param {unknown} context
 * @param {ListCheckpointsInput} [input]
 */
export function listCheckpoints(context, input = {}) {
  const session = resolveSession(context);
  if (!session) return { ok: false, error: 'listCheckpoints requires an agent session context.' };

  const includeAutomatic = input.includeAutomatic !== false;
  const checkpoints = listCheckpointSummaries(getCheckpointStore(session), { includeAutomatic });
  return {
    ok: true,
    data: {
      count: checkpoints.length,
      checkpoints,
    },
  };
}

/**
 * Delete one or more saved runner checkpoints.
 *
 * @param {unknown} context
 * @param {DeleteCheckpointInput} [input]
 */
export function deleteCheckpoint(context, input = {}) {
  const session = resolveSession(context);
  if (!session) return { ok: false, error: 'deleteCheckpoint requires an agent session context.' };

  const store = getCheckpointStore(session);
  if (input.all === true) {
    const includeAutomatic = input.includeAutomatic !== false;
    const deleted = [...store.checkpoints.values()].filter((checkpoint) =>
      includeAutomatic || checkpoint.kind !== 'auto');
    for (const checkpoint of deleted) store.checkpoints.delete(checkpoint.id);
    syncCheckpointMetadata(session, store);
    return {
      ok: true,
      data: {
        action: 'delete',
        deletedCount: deleted.length,
        checkpoints: listCheckpointSummaries(store, { includeAutomatic: true }),
      },
    };
  }

  const selected = findCheckpoint(store, {
    id: readNonEmptyString(input.id),
    name: normalizeCheckpointName(input.name),
    latestIfEmpty: false,
  });
  if (!selected) {
    return { ok: false, error: 'No matching checkpoint found. Provide id, name, or all:true.' };
  }

  store.checkpoints.delete(selected.id);
  syncCheckpointMetadata(session, store);
  return {
    ok: true,
    data: {
      action: 'delete',
      checkpoint: summarizeCheckpoint(selected),
      checkpoints: listCheckpointSummaries(store, { includeAutomatic: true }),
    },
  };
}

/**
 * @param {object} session
 * @param {Record<string, unknown>} runner
 * @param {{ name?: string, note?: string | null, overwrite: boolean, kind: 'manual' | 'auto' }} options
 */
function saveCheckpointInternal(session, runner, options) {
  if (typeof runner.saveState !== 'function' || typeof runner.restoreState !== 'function') {
    return { ok: false, error: 'Checkpoint tools require runner.saveState() and runner.restoreState(state).' };
  }

  const store = getCheckpointStore(session);
  const name = options.name ?? `checkpoint-${store.counter + 1}`;
  const existing = findCheckpoint(store, { name, latestIfEmpty: false });
  if (existing && !options.overwrite) {
    return {
      ok: false,
      error: `Checkpoint name already exists: ${name}. Use overwrite:true or choose a different name.`,
      data: { existing: summarizeCheckpoint(existing) },
    };
  }

  let state;
  try {
    state = cloneRunnerState(runner.saveState(`agent.${options.kind}.checkpoint`));
  } catch (error) {
    return { ok: false, error: `Failed to save checkpoint state: ${formatError(error)}` };
  }

  const now = new Date().toISOString();
  const id = existing?.id ?? makeCheckpointId(store);
  const checkpoint = {
    id,
    name,
    note: options.note ?? null,
    kind: options.kind,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    restoredAt: existing?.restoredAt ?? null,
    state,
    runnerConfig: captureRunnerConfig(runner),
    summary: captureRunnerSummary(runner),
  };

  store.checkpoints.set(id, checkpoint);
  syncCheckpointMetadata(session, store);

  return {
    ok: true,
    data: {
      action: existing ? 'overwrite' : 'save',
      checkpoint: summarizeCheckpoint(checkpoint),
      checkpoints: listCheckpointSummaries(store, { includeAutomatic: true }),
    },
  };
}

/**
 * @param {unknown} context
 * @returns {{ ok: true, session: object, runner: Record<string, unknown> } | { ok: false, error: string }}
 */
function resolveSessionAndRunner(context) {
  const session = resolveSession(context);
  if (!session) return { ok: false, error: 'Checkpoint tools require an agent session context.' };

  const runner = resolveRunner(context, session);
  if (!runner) return { ok: false, error: 'Checkpoint tools require a session runner.' };
  return { ok: true, session, runner };
}

/** @param {unknown} context */
function resolveSession(context) {
  const record = asRecord(context);
  if (isRecord(record.metadata)) return /** @type {object} */ (record);

  const nested = asRecord(record.session);
  if (isRecord(nested.metadata)) return /** @type {object} */ (nested);

  return null;
}

/**
 * @param {unknown} context
 * @param {object} session
 * @returns {Record<string, unknown> | null}
 */
function resolveRunner(context, session) {
  const direct = asRecord(context);
  if (isRunnerLike(direct)) return direct;

  const directRunner = asRecord(direct.runner);
  if (isRunnerLike(directRunner)) return directRunner;

  const sessionRunner = asRecord(asRecord(session).runner);
  if (isRunnerLike(sessionRunner)) return sessionRunner;

  return null;
}

/** @param {Record<string, unknown>} value */
function isRunnerLike(value) {
  return typeof value.saveState === 'function' &&
    typeof value.restoreState === 'function';
}

/** @param {object} session */
function getCheckpointStore(session) {
  let store = checkpointStores.get(session);
  if (!store) {
    store = { counter: 0, checkpoints: new Map() };
    checkpointStores.set(session, store);
  }
  return store;
}

/** @param {CheckpointStore} store */
function makeCheckpointId(store) {
  store.counter += 1;
  return `cp_${store.counter}`;
}

/**
 * @param {CheckpointStore} store
 * @param {{ id?: string | null, name?: string | null, latestIfEmpty: boolean }} input
 * @returns {CheckpointRecord | null}
 */
function findCheckpoint(store, input) {
  if (input.id) return store.checkpoints.get(input.id) ?? null;

  if (input.name) {
    const matches = [...store.checkpoints.values()].filter((checkpoint) => checkpoint.name === input.name);
    return matches.length > 0 ? matches[matches.length - 1] : null;
  }

  if (!input.latestIfEmpty) return null;
  const checkpoints = [...store.checkpoints.values()];
  return checkpoints.length > 0 ? checkpoints[checkpoints.length - 1] : null;
}

/**
 * @param {object} session
 * @param {CheckpointStore} store
 */
function syncCheckpointMetadata(session, store) {
  const summaries = listCheckpointSummaries(store, { includeAutomatic: true });
  const record = asRecord(session);
  if (typeof record.mergeMetadata === 'function') {
    record.mergeMetadata({ [CHECKPOINT_METADATA_KEY]: summaries });
    return;
  }

  const metadata = asRecord(record.metadata);
  metadata[CHECKPOINT_METADATA_KEY] = cloneJson(summaries);
}

/**
 * @param {CheckpointStore} store
 * @param {{ includeAutomatic: boolean }} options
 */
function listCheckpointSummaries(store, options) {
  return [...store.checkpoints.values()]
    .filter((checkpoint) => options.includeAutomatic || checkpoint.kind !== 'auto')
    .map(summarizeCheckpoint);
}

/** @param {CheckpointRecord} checkpoint */
function summarizeCheckpoint(checkpoint) {
  return {
    id: checkpoint.id,
    name: checkpoint.name,
    note: checkpoint.note,
    kind: checkpoint.kind,
    createdAt: checkpoint.createdAt,
    updatedAt: checkpoint.updatedAt,
    restoredAt: checkpoint.restoredAt ?? null,
    ...checkpoint.summary,
  };
}

/** @param {Record<string, unknown>} runner */
function captureRunnerSummary(runner) {
  const decision = asRecord(runner.currentDecision);
  return {
    historyLength: readHistoryLength(runner),
    decision: getDecisionName(decision),
    terminal: Boolean(decision.terminal),
    actionCount: Array.isArray(decision.actions) ? decision.actions.length : null,
  };
}

/** @param {Record<string, unknown>} runner */
function captureRunnerConfig(runner) {
  return {
    seed: cloneBinaryAware(runner.seed, new WeakMap()),
    seedSequence: cloneBinaryAware(runner.seedSequence, new WeakMap()),
    yrpVersion: cloneBinaryAware(runner.yrpVersion, new WeakMap()),
    drawCount: cloneBinaryAware(runner.drawCount, new WeakMap()),
    playerDeck: cloneBinaryAware(runner.playerDeck, new WeakMap()),
    opponentDeck: cloneBinaryAware(runner.opponentDeck, new WeakMap()),
    playerOpening: cloneBinaryAware(runner.playerOpening, new WeakMap()),
    opponentOpening: cloneBinaryAware(runner.opponentOpening, new WeakMap()),
    playerDeckInstances: cloneBinaryAware(runner.playerDeckInstances, new WeakMap()),
  };
}

/**
 * @param {Record<string, unknown>} runner
 * @param {unknown} configValue
 */
function restoreRunnerConfig(runner, configValue) {
  const config = asRecord(configValue);
  let needsRebuild = false;
  if ('seed' in config) runner.seed = cloneBinaryAware(config.seed, new WeakMap());
  if ('seedSequence' in config) runner.seedSequence = cloneBinaryAware(config.seedSequence, new WeakMap());
  if ('yrpVersion' in config) {
    runner.yrpVersion = cloneBinaryAware(config.yrpVersion, new WeakMap());
    needsRebuild = true;
  }
  if ('drawCount' in config) {
    runner.drawCount = cloneBinaryAware(config.drawCount, new WeakMap());
    needsRebuild = true;
  }
  if ('playerDeck' in config) {
    runner.playerDeck = cloneBinaryAware(config.playerDeck, new WeakMap());
    needsRebuild = true;
  }
  if ('opponentDeck' in config) {
    runner.opponentDeck = cloneBinaryAware(config.opponentDeck, new WeakMap());
    needsRebuild = true;
  }
  if ('playerOpening' in config) {
    runner.playerOpening = cloneBinaryAware(config.playerOpening, new WeakMap());
    needsRebuild = true;
  }
  if ('opponentOpening' in config) {
    runner.opponentOpening = cloneBinaryAware(config.opponentOpening, new WeakMap());
    needsRebuild = true;
  }
  if ('playerDeckInstances' in config) runner.playerDeckInstances = cloneBinaryAware(config.playerDeckInstances, new WeakMap());
  if (typeof runner.clearStatePool === 'function') runner.clearStatePool();
  if (typeof runner.clearNativeSnapshotPool === 'function') runner.clearNativeSnapshotPool();

  // When deck/opening/drawCount/yrpVersion changes, destroy live duel to prevent
  // historyKey collision (different deck configs sharing same root history=[])
  if (needsRebuild && runner.duel != null) {
    if (typeof runner.duel.endDuel === 'function') {
      try {
        runner.duel.endDuel();
      } catch {
        // ignore
      }
    }
    runner.duel = null;
    runner.currentDecision = null;
    if (typeof runner.setActionHistory === 'function') {
      runner.setActionHistory([], '');
    }
  }
}

/**
 * @param {Record<string, unknown>} runner
 * @param {{ graveyardLimit?: unknown }} input
 */
function captureCurrentToolContext(runner, input) {
  const graveyardLimit = normalizePositiveInteger(input.graveyardLimit, DEFAULT_GRAVEYARD_LIMIT, DEFAULT_GRAVEYARD_LIMIT);
  const state = getCurrentState(runner, { graveyardLimit });
  const actions = listActions(runner);
  return {
    state: state.ok ? state.data : null,
    actions: actions.ok ? actions.data : null,
    errors: [
      ...(state.ok ? [] : [`getCurrentState: ${state.error}`]),
      ...(actions.ok ? [] : [`listActions: ${actions.error}`]),
    ],
  };
}

/** @param {unknown} runner */
function readHistoryLength(runner) {
  const history = asRecord(runner).actionHistory;
  return Array.isArray(history) ? history.length : null;
}

/** @param {unknown} value */
function normalizeCheckpointName(value) {
  return readLimitedString(value, MAX_NAME_LENGTH)
    ?.replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {unknown} value
 * @param {number} maxLength
 */
function readLimitedString(value, maxLength) {
  const text = readNonEmptyString(value);
  if (!text) return null;
  return text.length <= maxLength ? text : text.slice(0, maxLength).trimEnd();
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} max
 */
function normalizePositiveInteger(value, fallback, max) {
  const number = Math.trunc(Number(value ?? fallback));
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(number, max);
}

/** @param {unknown} value */
function getDecisionName(value) {
  const decision = asRecord(value);
  const message = asRecord(decision.message);
  const constructorValue = message.constructor;
  const constructorName = typeof constructorValue === 'function'
    ? constructorValue.name
    : asRecord(constructorValue).name;
  return (
    readNonEmptyString(decision.reason) ??
    readNonEmptyString(decision.name) ??
    readNonEmptyString(constructorName)
  );
}

/** @param {unknown} value */
function readNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** @param {unknown} value */
function readNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/** @param {unknown} error */
function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

/** @param {unknown} value */
function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

/** @param {unknown} value */
function cloneRunnerState(value) {
  return cloneBinaryAware(value, new WeakMap());
}

/**
 * Clone runner state without destroying Uint8Array/Buffer action responses.
 *
 * @param {unknown} value
 * @param {WeakMap<object, unknown>} seen
 * @returns {unknown}
 */
function cloneBinaryAware(value, seen) {
  if (value === null || typeof value !== 'object') return value;

  if (value instanceof Uint8Array) return Uint8Array.from(value);
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (value instanceof DataView) {
    const buffer = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    return new DataView(buffer);
  }

  if (seen.has(value)) return seen.get(value);

  if (Array.isArray(value)) {
    const output = [];
    seen.set(value, output);
    for (const item of value) output.push(cloneBinaryAware(item, seen));
    return output;
  }

  if (value instanceof Date) return new Date(value.getTime());

  const output = {};
  seen.set(value, output);
  for (const [key, entry] of Object.entries(value)) {
    output[key] = cloneBinaryAware(entry, seen);
  }
  return output;
}

/** @param {unknown} value */
function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} value */
function asRecord(value) {
  return isRecord(value) ? /** @type {Record<string, unknown>} */ (value) : {};
}

export const saveCheckpointTool = {
  name: 'saveCheckpoint',
  description: 'Save the current duel runner state as a named checkpoint for backtracking and branch exploration.',
  input_schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Short checkpoint name, for example "before-normal-summon" or "branch-a-start".',
        maxLength: MAX_NAME_LENGTH,
      },
      note: {
        type: 'string',
        description: 'Short reason for saving this point.',
        maxLength: MAX_NOTE_LENGTH,
      },
      overwrite: {
        type: 'boolean',
        description: 'Set true to replace an existing checkpoint with the same name.',
      },
    },
    additionalProperties: false,
  },
  execute: saveCheckpoint,
};

export const restoreCheckpointTool = {
  name: 'restoreCheckpoint',
  description: 'Restore a saved duel runner checkpoint by id, by name, or the latest checkpoint when neither is provided.',
  input_schema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Checkpoint id returned by saveCheckpoint or listCheckpoints.',
      },
      name: {
        type: 'string',
        description: 'Checkpoint name returned by saveCheckpoint or listCheckpoints.',
      },
      graveyardLimit: {
        type: 'number',
        description: 'Maximum recent graveyard cards to include after restore.',
        minimum: 1,
      },
    },
    additionalProperties: false,
  },
  execute: restoreCheckpoint,
};

export const listCheckpointsTool = {
  name: 'listCheckpoints',
  description: 'List lightweight checkpoint summaries for the current session.',
  input_schema: {
    type: 'object',
    properties: {
      includeAutomatic: {
        type: 'boolean',
        description: 'Include automatic pre-action rollback checkpoints. Defaults to true.',
      },
    },
    additionalProperties: false,
  },
  execute: listCheckpoints,
};

export const deleteCheckpointTool = {
  name: 'deleteCheckpoint',
  description: 'Delete a checkpoint by id/name, or delete all checkpoints with all:true.',
  input_schema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Checkpoint id to delete.',
      },
      name: {
        type: 'string',
        description: 'Checkpoint name to delete.',
      },
      all: {
        type: 'boolean',
        description: 'Delete all matching checkpoints.',
      },
      includeAutomatic: {
        type: 'boolean',
        description: 'When all:true, include automatic checkpoints. Defaults to true.',
      },
    },
    additionalProperties: false,
  },
  execute: deleteCheckpoint,
};
