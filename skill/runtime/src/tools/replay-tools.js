// @ts-check

import { readFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  parseYrpRouteFromBuffer,
} from '../replay/yrp-route-engine.js';
import { checkFileWriteAuthorization } from './file-write-policy.js';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_REPLAY_DIR = resolve(PROJECT_ROOT, 'replays', 'agent-generated');
const CURRENT_DUEL_RULE = 5;
const CURRENT_DUEL_OPTIONS = CURRENT_DUEL_RULE << 16;
const MIN_REPLAY_OPPONENT_MAIN_DECK_SIZE = 40;

const require = createRequire(import.meta.url);
const { requireOptionalSkillDependency } = require('../vendor-require.cjs');
const { createReplayExportApi } = require('../replay/replay-export.cjs');

const replayExportApi = createReplayExportApi({
  Buffer,
  CURRENT_DUEL_OPTIONS,
  makeXorshift32,
  getYgoproYrp,
});

/**
 * Save the current agent session runner history as a real .yrp replay file.
 *
 * @param {unknown} context
 * @param {unknown} input
 */
export async function saveReplayYrp(context, input = {}) {
  const authorization = checkFileWriteAuthorization(context, input, 'saveReplayYrp');
  if (!authorization.ok) return authorization;
  const runner = resolveRunner(context);
  if (!runner) return { ok: false, error: 'saveReplayYrp requires a session runner.' };

  const record = asRecord(input);
  const runnerRecord = asRecord(runner);
  const state = typeof runnerRecord.saveState === 'function'
    ? runnerRecord.saveState.call(runner, 'agent.saveReplayYrp')
    : { history: Array.isArray(runnerRecord.actionHistory) ? runnerRecord.actionHistory.slice() : [] };
  const stateRecord = asRecord(state);
  const rawHistory = stateRecord.history;
  const history = Array.isArray(rawHistory) ? rawHistory : [];
  const pendingDecision = readPendingDecision(stateRecord.decision ?? runnerRecord.currentDecision);
  if (history.length === 0) {
    return {
      ok: false,
      error: 'saveReplayYrp refused to export an empty replay: no executed action history is available.',
    };
  }

  const outputDir = DEFAULT_REPLAY_DIR;
  const fileName = buildSafeReplayFileName(
    readNonEmptyString(record.fileName) ?? readNonEmptyString(record.title) ?? `agent-replay-${new Date().toISOString()}`,
  );
  const outputPath = resolve(outputDir, fileName);
  if (!isInsideDirectory(outputPath, outputDir)) {
    return { ok: false, error: 'saveReplayYrp resolved outside the replay output directory.' };
  }

  const warnings = [];
  if (pendingDecision) {
    warnings.push([
      'Replay exported while the engine still has a pending decision.',
      `Current decision: ${pendingDecision.name}; actions: ${pendingDecision.actions.map((action) => `${action.index}:${action.label}`).join(' | ')}.`,
      'The .yrp contains the recorded response history so far; route completeness is not guaranteed.',
    ].join(' '));
  }
  const requestedVersion = normalizeYrpVersion(record.yrpVersion);
  const runnerVersion = normalizeYrpVersion(runnerRecord.yrpVersion) ?? 1;
  const yrpVersion = requestedVersion ?? 2;
  if (requestedVersion !== null && requestedVersion !== runnerVersion) {
    warnings.push(`Requested yrpVersion=${requestedVersion} differs from current runner yrpVersion=${runnerVersion}.`);
  }
  if (requestedVersion === null && runnerVersion !== 2) {
    warnings.push(`Current runner yrpVersion=${runnerVersion}; saveReplayYrp exported YRP2 by default for YGOPro2 compatibility.`);
  }

  let responsesEncoded = history;
  let responseBuildMode = 'raw-history';
  let restoreError = null;
  try {
    if (typeof runnerRecord.buildReplayResponseHistory === 'function') {
      responsesEncoded = runnerRecord.buildReplayResponseHistory.call(runner, state);
      responseBuildMode = 'replay-compatible-history';
    }
  } catch (error) {
    return {
      ok: false,
      error: `saveReplayYrp failed while building replay-compatible responses: ${formatError(error)}`,
      data: { historyLength: history.length, responseBuildMode },
    };
  } finally {
    if (typeof runnerRecord.restoreState === 'function') {
      try {
        runnerRecord.restoreState.call(runner, state);
      } catch (error) {
        restoreError = formatError(error);
      }
    }
  }

  if (restoreError) {
    return {
      ok: false,
      error: `saveReplayYrp built replay responses, but failed to restore the live runner state: ${restoreError}`,
    };
  }
  if (!Array.isArray(responsesEncoded) || responsesEncoded.length === 0) {
    return {
      ok: false,
      error: 'saveReplayYrp built no replay responses from the current history.',
      data: { historyLength: history.length, responseBuildMode },
    };
  }

  const drawCount = normalizeNonNegativeInteger(runnerRecord.drawCount) ?? readOpeningLength(runnerRecord.playerOpening) ?? 0;
  const opponentDeck = normalizeDeck(runnerRecord.opponentDeck);
  const opponentDeckFallback = shouldApplyOpponentDeckFallback(opponentDeck, drawCount);
  if (opponentDeckFallback) {
    warnings.push('Opponent deck was empty or too small for replay startup; saveReplayYrp inserted a generic 40-card opponent main deck for YGOPro compatibility.');
  }

  await mkdir(outputDir, { recursive: true });
  const replayInfo = replayExportApi.exportReplayYrp({
    seed: normalizeUInt32(runnerRecord.seed) ?? 0,
    drawCount,
    playerDeck: normalizeDeck(runnerRecord.playerDeck),
    opponentDeck,
    playerOpening: normalizeOpening(runnerRecord.playerOpening),
    opponentOpening: normalizeOpening(runnerRecord.opponentOpening),
    state,
    responsesEncoded,
    outPath: outputPath,
    yrpVersion,
    seedSequence: normalizeUInt32List(runnerRecord.seedSequence),
  });
  const replayCheck = await inspectSavedReplay(replayInfo.outPath);

  const data = {
    path: replayInfo.outPath,
    fileName,
    outputDir,
    yrpVersion,
    byteLength: replayInfo.byteLength,
    responseCount: replayInfo.responseCount,
    savedReplayCheck: replayCheck,
    historyLength: history.length,
    pendingDecision,
    responseBuildMode,
    opponentDeckFallbackApplied: opponentDeckFallback,
    warnings,
  };
  recordSavedReplay(context, data);
  return { ok: true, data };
}

/**
 * Parse an uploaded YRP replay into route/context output that the UI can
 * attach to the model session as reference context.
 *
 * Input source:
 * - `yrpBase64` + optional `fileName`
 *
 * @param {unknown} context
 * @param {unknown} input
 */
export async function parseYrpRoute(context, input = {}) {
  const record = asRecord(input);

  const source = await resolveParseSource(context, record);
  if (!source.ok) return source;

  const payload = source.payload;
  if (!(payload instanceof Uint8Array)) {
    return {
      ok: false,
      error: 'parseYrpRoute requires uploaded YRP bytes in yrpBase64.',
    };
  }

  const parseResult = await parseYrpRouteFromBuffer(payload, {
    fileName: source.fileName,
    sourcePath: null,
    cardsPaths: readPathArray(record.cardsDbPaths ?? record.dbPaths)
      ?? readPathArray(asRecord(asRecord(context).config).cardsDbPaths),
    scriptDirs: readPathArray(record.scriptDirs)
      ?? readPathArray(asRecord(asRecord(context).config).scriptDirs),
  });

  if (!parseResult.ok) {
    return {
      ok: false,
      error: parseResult.error,
      code: parseResult.code,
      sourcePath: parseResult.sourcePath ?? source.sourcePath ?? null,
    };
  }

  const output = createParsedRouteOutput(parseResult.data, {
    source,
  });
  recordParsedRoute(context, output, {
    appendContextMessage: record.appendContextMessage !== false,
  });
  return { ok: true, data: output };
}

/** @param {unknown} value */
function readPathArray(value) {
  if (!Array.isArray(value)) return null;
  const paths = value.map(readNonEmptyString).filter(Boolean);
  return paths.length > 0 ? paths : null;
}

export const saveReplayYrpTool = {
  name: 'saveReplayYrp',
  description: [
    'Export the current verified engine action history as a real .yrp replay file under replays/agent-generated.',
    'Use only when the user explicitly requests a saved replay and file writes are enabled.',
  ].join(' '),
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      fileName: { type: 'string' },
      yrpVersion: { type: 'integer', enum: [1, 2] },
    },
    additionalProperties: false,
  },
  execute: saveReplayYrp,
};

/** @param {unknown} context */
function resolveRunner(context) {
  const record = asRecord(context);
  if (isRunnerLike(record.runner)) return record.runner;
  if (isRunnerLike(asRecord(record.session).runner)) return asRecord(record.session).runner;
  if (isRunnerLike(context)) return context;
  return null;
}

/**
 * @param {unknown} context
 * @param {Record<string, unknown>} input
 */
async function resolveParseSource(context, input) {
  const yrpBase64 = readNonEmptyString(input.yrpBase64);
  if (yrpBase64) {
    return {
      ok: true,
      kind: 'inline-base64',
      fileName: readNonEmptyString(input.fileName) ?? 'uploaded-replay.yrp',
      sourcePath: null,
      resolveMode: 'inline-base64',
      payload: Buffer.from(yrpBase64, 'base64'),
    };
  }

  return {
    ok: false,
    error: 'parseYrpRoute only accepts a manually uploaded YRP file as yrpBase64.',
  };
}

/** @param {unknown} value */
function isRunnerLike(value) {
  const record = asRecord(value);
  return typeof record.saveState === 'function' ||
    typeof record.buildReplayResponseHistory === 'function' ||
    Array.isArray(record.actionHistory);
}

/**
 * @param {unknown} context
 * @param {Record<string, unknown>} data
 */
function recordSavedReplay(context, data) {
  const session = resolveSession(context);
  if (!session) return;
  const metadata = asRecord(session.metadata);
  const replays = Array.isArray(metadata.savedReplayYrps) ? metadata.savedReplayYrps.slice() : [];
  replays.push({
    path: data.path,
    fileName: data.fileName,
    yrpVersion: data.yrpVersion,
    responseCount: data.responseCount,
    byteLength: data.byteLength,
    savedAt: new Date().toISOString(),
  });
  if (typeof session.mergeMetadata === 'function') {
    session.mergeMetadata({ savedReplayYrps: replays });
  } else {
    session.metadata = { ...metadata, savedReplayYrps: replays };
  }
}

/**
 * @param {unknown} context
 * @param {Record<string, unknown>} output
 * @param {{ appendContextMessage?: boolean }} [options]
 */
function recordParsedRoute(context, output, options = {}) {
  const session = resolveSession(context);
  if (!session) return;
  const stamped = {
    ...output,
    parsedAt: new Date().toISOString(),
  };
  const metadata = asRecord(session.metadata);
  const history = Array.isArray(metadata.parsedReplayRoutes) ? metadata.parsedReplayRoutes.slice() : [];
  history.push(stamped);
  if (typeof session.mergeMetadata === 'function') {
    session.mergeMetadata({
      lastParsedYrpRoute: stamped,
      parsedReplayRoutes: history,
    });
  } else {
    session.metadata = {
      ...metadata,
      lastParsedYrpRoute: stamped,
      parsedReplayRoutes: history,
    };
  }
  if (options.appendContextMessage !== false) {
    appendParsedRouteContextMessage(session, stamped);
  }
}

/**
 * @param {Record<string, unknown>} session
 * @param {Record<string, unknown>} route
 */
function appendParsedRouteContextMessage(session, route) {
  if (typeof session.appendMessage !== 'function') return;
  const context = asRecord(route.context);
  const markdown = readNonEmptyString(context.markdown);
  if (!markdown) return;
  const source = asRecord(route.source);
  const summary = asRecord(route.summary);
  const fileName = readNonEmptyString(source.fileName) ?? 'YRP录像';
  const responseCount = normalizePositiveInteger(summary.responseCount);
  const phaseCount = normalizePositiveInteger(summary.phaseCount);
  const phaseOutline = Array.isArray(context.phaseOutline) ? context.phaseOutline : [];
  const header = [
    '[YRP参考路线]',
    `文件：${fileName}`,
    `响应：${responseCount ?? '未知'}`,
    `阶段：${phaseCount ?? phaseOutline.length}`,
    '以下内容来自已解析YRP，可作为后续回答的参考上下文：',
  ].join('\n');
  session.appendMessage('user', `${header}\n\n${markdown}`, {
    kind: 'yrp_route_context',
    source: source.resolveMode ?? null,
    fileName,
  });
}

/** @param {unknown} context */
function resolveSession(context) {
  const record = asRecord(context);
  if (record.metadata && typeof record.metadata === 'object') return record;
  const session = asRecord(record.session);
  return session.metadata && typeof session.metadata === 'object' ? session : null;
}

/**
 * @param {import('../replay/yrp-route-engine.js').YrpRouteData} data
 * @param {{ source: Record<string, unknown> }} options
 */
function createParsedRouteOutput(data, options) {
  const visibleSteps = Array.isArray(data.visibleSteps) ? data.visibleSteps : [];
  const rawEvents = Array.isArray(data.rawEvents) ? data.rawEvents : [];
  return {
    source: {
      fileName: readNonEmptyString(options.source.fileName) ?? data.fileName ?? null,
      sourcePath: readNonEmptyString(options.source.sourcePath) ?? data.sourcePath ?? null,
      resolveMode: readNonEmptyString(options.source.resolveMode) ?? 'unknown',
    },
    replay: data.replay,
    deck: data.deck,
    summary: data.summary,
    warnings: data.warnings,
    context: data.context,
    visibleSteps,
    rawEvents,
  };
}

/** @param {string} rawName */
function buildSafeReplayFileName(rawName) {
  const base = rawName
    .replace(/\.yrp$/i, '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'agent-replay';
  return `${base}.yrp`;
}

/**
 * @param {string} targetPath
 * @param {string} directory
 */
function isInsideDirectory(targetPath, directory) {
  const normalizedDirectory = normalizePathForComparison(directory);
  const normalizedTarget = normalizePathForComparison(targetPath);
  return normalizedTarget === normalizedDirectory || normalizedTarget.startsWith(`${normalizedDirectory}/`);
}

/** @param {string} targetPath */
function normalizePathForComparison(targetPath) {
  return resolve(targetPath).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** @param {unknown} value */
function normalizeYrpVersion(value) {
  const version = Number(value);
  if (version === 1 || version === 2) return version;
  return null;
}

/** @param {unknown} value */
function normalizeUInt32(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.trunc(number) >>> 0;
}

/** @param {unknown} value */
function normalizeNonNegativeInteger(value) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) && number >= 0 ? number : null;
}

/** @param {unknown} value */
function normalizePositiveInteger(value) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) && number > 0 ? number : null;
}

/** @param {unknown} value */
function normalizeUInt32List(value) {
  return Array.isArray(value)
    ? value.map((entry) => normalizeUInt32(entry)).filter((entry) => entry !== null)
    : [];
}

/** @param {unknown} value */
function normalizeDeck(value) {
  const record = asRecord(value);
  return {
    main: normalizeUInt32List(record.main),
    extra: normalizeUInt32List(record.extra),
    side: normalizeUInt32List(record.side),
  };
}

/**
 * @param {{ main: number[], extra: number[], side: number[] }} deck
 * @param {number} drawCount
 */
function shouldApplyOpponentDeckFallback(deck, drawCount) {
  return deck.main.length < Math.max(1, drawCount) || deck.main.length < MIN_REPLAY_OPPONENT_MAIN_DECK_SIZE;
}

/** @param {string} replayPath */
async function inspectSavedReplay(replayPath) {
  const ygoproYrp = getYgoproYrp();
  if (!ygoproYrp?.YGOProYrp) return { ok: false, error: 'ygopro-yrp-encode unavailable for replay self-check.' };
  try {
    const replay = new ygoproYrp.YGOProYrp().fromYrp(await readFile(replayPath));
    const flag = Number(replay.header?.flag ?? 0);
    const id = Number(replay.header?.id ?? 0);
    return {
      ok: true,
      id,
      flag,
      headerVersion: replay.header?.headerVersion ?? null,
      yrpVersion: id === ygoproYrp.REPLAY_ID_YRP2 || (flag & (ygoproYrp.REPLAY_UNIFORM ?? 16)) !== 0 ? 2 : 1,
      startHand: replay.startHand ?? null,
      drawCount: replay.drawCount ?? null,
      hostMain: Array.isArray(replay.hostDeck?.main) ? replay.hostDeck.main.length : null,
      clientMain: Array.isArray(replay.clientDeck?.main) ? replay.clientDeck.main.length : null,
      responseCount: Array.isArray(replay.responses) ? replay.responses.length : null,
      responses: Array.isArray(replay.responses)
        ? replay.responses.map((/** @type {Uint8Array | number[]} */ response) => Buffer.from(response).toString('hex'))
        : [],
    };
  } catch (error) {
    return { ok: false, error: formatError(error) };
  }
}

/** @param {unknown} value */
function normalizeOpening(value) {
  const record = asRecord(value);
  return {
    opening: normalizeUInt32List(record.opening),
    remain: normalizeUInt32List(record.remain),
    label: readNonEmptyString(record.label),
  };
}

/** @param {unknown} value */
function readOpeningLength(value) {
  const opening = asRecord(value).opening;
  return Array.isArray(opening) ? opening.length : null;
}

/** @param {unknown} error */
function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

/** @param {number} seed */
function makeXorshift32(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

function getYgoproYrp() {
  return requireOptionalSkillDependency('ygopro-yrp-encode');
}

/** @param {unknown} value */
function readNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/** @param {unknown} value */
function readPendingDecision(value) {
  const decision = asRecord(value);
  if (!decision || decision.terminal === true) return null;
  const actions = Array.isArray(decision.actions) ? decision.actions : [];
  if (actions.length === 0) return null;
  return {
    name: readNonEmptyString(decision.messageName) ??
      readNonEmptyString(asRecord(asRecord(decision.message).constructor).name) ??
      readNonEmptyString(decision.name) ??
      readNonEmptyString(decision.reason) ??
      'unknown',
    actions: actions.map((action, index) => ({
      index,
      label: readNonEmptyString(asRecord(action).label) ?? `Action #${index}`,
      kind: readNonEmptyString(asRecord(action).kind) ?? '',
    })),
  };
}

/** @param {unknown} value */
function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}
