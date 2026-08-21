import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { resolveSkillConfig } from './config.mjs';
import { createPortableSession } from './session.mjs';
import {
  analyzeDeck,
  parseDeckInput,
  serializeYdkText,
} from './deck-core.mjs';
import { loadIdMigrationMap, migrateCardEntries, migrateDeckIds, resolveCurrentCardId } from './deck-migration.mjs';
import { getToolInputSchema, TOOL_DESCRIPTIONS, validateToolInput } from './tool-schemas.mjs';
import { buildComboAdaptationReport, parseComboArtifactInput } from './combo-artifact.mjs';
import { discoverYgoPro2 } from './ygopro2-discovery.mjs';
import {
  createYgoPro2DuelRunner,
  executeYgoPro2Action,
  getYgoPro2BridgeStatus,
  isYgoPro2DuelRunner,
} from './ygopro2-duel.mjs';

const CORE_MODULES = Object.freeze({
  cardsDb: 'src/database/cards-db.js',
  cardTools: 'src/tools/card-tools.js',
  dataTools: 'src/database/card-data-updater.js',
  stateTools: 'src/tools/state-tools.js',
  actionTools: 'src/tools/action-tools.js',
  checkpointTools: 'src/tools/checkpoint-tools.js',
  replayTools: 'src/tools/replay-tools.js',
  routeTools: 'src/tools/route-tools.js',
  routeValidation: 'src/tools/route-validation.js',
  runnerFactory: 'src/runner/factory.js',
  yrpRouteEngine: 'src/replay/yrp-route-engine.js',
});

const CURRENT_DUEL_RULE = 5;
const CURRENT_DUEL_OPTIONS = CURRENT_DUEL_RULE << 16;
const MIN_REPLAY_OPPONENT_MAIN_DECK_SIZE = 40;
const MAX_ROUTE_CONTENT_LENGTH = 200000;

const CORE_TOOL_NAMES = Object.freeze([
  'getCardEffect',
  'searchCards',
  'inspectCardDataSources',
  'discoverYgoPro2',
  'getYgoPro2BridgeStatus',
  'refreshCardDataSources',
  'getBanlistContext',
  'setSessionDeck',
  'getSessionDeck',
  'checkDeckCards',
  'editSessionDeck',
  'exportSessionDeck',
  'setFixedOpening',
  'resetGame',
  'getCurrentState',
  'listActions',
  'executeAction',
  'simulateActions',
  'saveCheckpoint',
  'restoreCheckpoint',
  'listCheckpoints',
  'deleteCheckpoint',
  'parseYrpRoute',
  'buildRouteContext',
  'parseComboArtifact',
  'buildComboAdaptationContext',
]);
const FILE_WRITE_TOOL_NAMES = Object.freeze(['saveReplayYrp', 'saveRouteFile']);
const ALL_TOOL_NAMES = Object.freeze([...CORE_TOOL_NAMES, ...FILE_WRITE_TOOL_NAMES]);

const RUNNER_TOOL_NAMES = new Set([
  'resetGame',
  'getCurrentState',
  'listActions',
  'executeAction',
  'simulateActions',
  'saveCheckpoint',
  'restoreCheckpoint',
  'saveReplayYrp',
]);
const SESSION_MIGRATION_TOOL_NAMES = new Set([
  'getCardEffect', 'searchCards', 'getSessionDeck', 'checkDeckCards', 'editSessionDeck', 'exportSessionDeck', 'setFixedOpening', 'buildComboAdaptationContext',
  ...RUNNER_TOOL_NAMES,
]);

export function createSourceAdapter(configInput = {}) {
  const config = normalizeConfig(configInput);
  const moduleCache = new Map();
  const availableToolNames = ALL_TOOL_NAMES;
  const toolDefinitions = buildToolDefinitions(config, moduleCache, availableToolNames);

  return {
    config,
    status: { ok: true, code: 'BACKEND_ADAPTER_READY' },
    listTools: () => availableToolNames.slice(),
    getToolDefinition: (name) => toolDefinitions.get(name) ?? null,
    getToolSchema: (name) => {
      const tool = toolDefinitions.get(name);
      if (!tool) {
        return { ok: false, code: 'UNKNOWN_TOOL', error: `Unknown YGO tool: ${name}` };
      }
      return { ok: true, data: toToolSchema(tool) };
    },
    getAllToolSchemas: () => [...toolDefinitions.values()].map(toToolSchema),
    executeTool: async (name, context = {}, input = {}) => {
      const tool = toolDefinitions.get(name);
      if (!tool) {
        return {
          ok: false,
          code: 'UNKNOWN_TOOL',
          error: `Unknown YGO tool: ${name}`,
          availableTools: availableToolNames.slice(),
        };
      }
      try {
        const validation = validateToolInput(name, asRecord(input));
        if (!validation.ok) {
          const details = validation.errors.map((entry) => `${entry.path}: ${entry.message}`).join(' ');
          return {
            ok: false,
            code: 'INVALID_TOOL_INPUT',
            error: `Invalid input for ${name}. ${details}`,
            data: { errors: validation.errors },
          };
        }
        const preparedContext = prepareContext(context, config);
        if (SESSION_MIGRATION_TOOL_NAMES.has(name)) await migrateLegacySession(preparedContext, config, moduleCache);
        let preparedInput = injectInputDefaults(name, input, config);
        if (name === 'resetGame') preparedInput = await migrateExplicitResetInput(preparedInput, config, moduleCache);
        if (name === 'resetGame') resetExistingExternalRunner(preparedContext);
        if (RUNNER_TOOL_NAMES.has(name)) {
          await ensurePreparedRunner(preparedContext, config, moduleCache, preparedInput);
        }
        if (name === 'resetGame') {
          preparedInput = injectSessionResetDefaults(preparedContext, preparedInput);
        }
        return await tool.execute(preparedContext, preparedInput);
      } catch (error) {
        return {
          ok: false,
          code: readString(error?.code) ?? 'TOOL_EXECUTION_FAILED',
          error: `Tool ${name} failed: ${error instanceof Error ? error.message : String(error)}`,
          ...(error?.data ? { data: error.data } : {}),
        };
      }
    },
    createSession: (initial = {}) => createYgoSession({ ...initial, config }),
    createRunner: (options = {}) => createConfiguredRunner(config, moduleCache, options),
    ensureRunner: async (context = {}, options = {}) => {
      const preparedContext = prepareContext(context, config);
      await ensurePreparedRunner(preparedContext, config, moduleCache, options);
      return preparedContext.session.runner;
    },
    loadModule: (key) => loadCoreModule(config, moduleCache, key),
  };
}

export function createYgoSession(initial = {}) {
  const session = createPortableSession({
    metadata: initial.metadata,
    messages: initial.messages,
    runner: initial.runner,
  });
  session.config = initial.config ?? {};
  return session;
}

export function listCoreTools() {
  return CORE_TOOL_NAMES.slice();
}

function normalizeConfig(configInput) {
  const envConfig = resolveSkillConfig(configInput.env ?? process.env);
  const merged = { ...envConfig, ...configInput };
  const runtimeRoot = resolve(merged.runtimeRoot);
  const resourceRoot = resolve(merged.resourceRoot);
  const prereleaseDir = resolve(merged.prereleaseDir ?? resolve(resourceRoot, 'lib', 'prerelease'));
  const cardsDbPath = resolve(merged.cardsDbPath);
  const scriptsDir = resolve(merged.scriptsDir);
  const prereleaseReleaseDbPath = resolve(merged.prereleaseReleaseDbPath ?? resolve(prereleaseDir, 'test-release.cdb'));
  const prereleaseUpdateDbPath = resolve(merged.prereleaseUpdateDbPath ?? resolve(prereleaseDir, 'test-update.cdb'));
  const prereleaseScriptsDir = resolve(merged.prereleaseScriptsDir ?? resolve(prereleaseDir, 'script'));
  return {
    ...merged,
    runtimeRoot,
    resourceRoot,
    cardsDbPath,
    cardsDbPaths: normalizePathList(configInput.cardsDbPaths ?? merged.cardsDbPaths ?? [prereleaseUpdateDbPath, prereleaseReleaseDbPath, cardsDbPath]),
    scriptsDir,
    scriptDirs: normalizePathList(configInput.scriptDirs ?? merged.scriptDirs ?? [prereleaseScriptsDir, scriptsDir]),
    prereleaseDir,
    prereleaseReleaseDbPath,
    prereleaseUpdateDbPath,
    prereleaseScriptsDir,
    cacheDir: resolve(merged.cacheDir),
    replayDir: resolve(merged.replayDir),
    routeDir: resolve(merged.routeDir),
    deckDir: resolve(merged.deckDir),
    deckPath: resolve(merged.deckPath),
    idMigrationsPath: resolve(merged.idMigrationsPath),
    allowNetworkUpdate: Boolean(merged.allowNetworkUpdate),
  };
}

function buildToolDefinitions(config, moduleCache, toolNames) {
  return new Map(toolNames.map((name) => [name, makeToolDefinition(name, config, moduleCache)]));
}

function makeToolDefinition(name, config, moduleCache) {
  const base = {
    name,
    description: TOOL_DESCRIPTIONS[name] ?? `Portable YGO backend tool ${name}.`,
    input_schema: getToolInputSchema(name),
  };
  return {
    ...base,
    execute: (context, input) => executeCoreTool(name, config, moduleCache, context, input),
  };
}

async function executeCoreTool(name, config, moduleCache, context, input) {
  switch (name) {
    case 'getCardEffect':
      return executeCardEffectWithMigration(config, moduleCache, context, input);
    case 'searchCards':
      return executeNamedExport(config, moduleCache, 'cardTools', name, context, input);
    case 'inspectCardDataSources':
    case 'getBanlistContext':
      return executeDataTool(name, config, moduleCache, input);
    case 'discoverYgoPro2': {
      const result = await discoverYgoPro2(input, config.env ?? process.env);
      const session = asRecord(context).session;
      if (result.ok && session && typeof session.mergeMetadata === 'function') {
        session.mergeMetadata({
          ygoPro2Discovery: result.data,
          ygoPro2DiscoveryUpdatedAt: result.data.recordedAt,
        });
      }
      return result;
    }
    case 'getYgoPro2BridgeStatus':
      return getYgoPro2BridgeStatus(context);
    case 'refreshCardDataSources':
      if (!config.allowNetworkUpdate && input.allowNetworkUpdate !== true) {
        return {
          ok: false,
          code: 'NETWORK_UPDATE_DISABLED',
          error: 'refreshCardDataSources requires YGO_ALLOW_NETWORK_UPDATE=1 or input.allowNetworkUpdate=true.',
        };
      }
      return executeDataTool(name, config, moduleCache, {
        dataDir: config.cacheDir,
        activeDataDir: config.resourceRoot ? resolve(config.resourceRoot, 'lib') : undefined,
        ...asRecord(input),
      });
    case 'setSessionDeck':
      return setSessionDeck(context, input, config, moduleCache);
    case 'getSessionDeck':
      return getSessionDeck(context);
    case 'checkDeckCards':
      return checkDeckCards(context, input, config, moduleCache);
    case 'editSessionDeck':
      return editSessionDeck(context, input, config, moduleCache);
    case 'exportSessionDeck':
      return exportSessionDeck(context, input, config);
    case 'setFixedOpening':
      return setFixedOpening(context, input, config, moduleCache);
    case 'resetGame':
      return readString(input.duelBackend)?.toLowerCase() === 'ygopro2'
        ? resetYgoPro2Game(config, moduleCache, context, input)
        : executeNamedExport(config, moduleCache, 'actionTools', 'resetGame', context, input);
    case 'getCurrentState':
    case 'listActions':
      return executeNamedExport(config, moduleCache, 'stateTools', name, context, input);
    case 'executeAction':
      return executeActionWithAutomaticCheckpoint(config, moduleCache, context, input);
    case 'simulateActions':
      if (isYgoPro2DuelRunner(resolveRunner(context))) return unsupportedExternalDuelTool(name);
      return executeNamedExport(config, moduleCache, 'actionTools', name, context, input);
    case 'saveCheckpoint':
    case 'restoreCheckpoint':
    case 'listCheckpoints':
    case 'deleteCheckpoint':
      if (isYgoPro2DuelRunner(resolveRunner(context))) return unsupportedExternalDuelTool(name);
      return executeNamedExport(config, moduleCache, 'checkpointTools', name, context, input);
    case 'saveReplayYrp':
      if (isYgoPro2DuelRunner(resolveRunner(context))) return saveYgoPro2ReplayPortable(config, context, input);
      return saveReplayYrpPortable(config, moduleCache, context, input);
    case 'parseYrpRoute':
      return executeReplayTool(name, config, moduleCache, context, input);
    case 'saveRouteFile':
      return saveRouteFilePortable(config, moduleCache, context, input);
    case 'buildRouteContext':
      return buildRouteContext(context, input);
    case 'parseComboArtifact':
      return executeParseComboArtifact(context, input);
    case 'buildComboAdaptationContext':
      return executeBuildComboAdaptationContext(context, input, config, moduleCache);
    default:
      return { ok: false, code: 'UNKNOWN_TOOL', error: `Unknown YGO tool: ${name}` };
  }
}

async function executeActionWithAutomaticCheckpoint(config, moduleCache, context, input) {
  const runner = resolveRunner(context);
  if (isYgoPro2DuelRunner(runner)) {
    const stateModule = await loadCoreModule(config, moduleCache, 'stateTools');
    return executeYgoPro2Action(runner, input, stateModule.formatCurrentState);
  }
  const checkpointModule = await loadCoreModule(config, moduleCache, 'checkpointTools');
  if (typeof checkpointModule.saveAutomaticCheckpoint !== 'function') {
    return {
      ok: false,
      code: 'AUTOMATIC_CHECKPOINT_UNAVAILABLE',
      error: 'executeAction refused to mutate the duel because an automatic pre-action checkpoint could not be created.',
    };
  }
  const saved = await checkpointModule.saveAutomaticCheckpoint(context);
  if (!saved?.ok) {
    return {
      ok: false,
      code: 'AUTOMATIC_CHECKPOINT_FAILED',
      error: `executeAction refused to mutate the duel because its automatic checkpoint failed: ${saved?.error ?? 'unknown error'}`,
      data: saved?.data,
    };
  }
  const checkpoint = saved.data?.checkpoint;
  try {
    const result = await executeNamedExport(config, moduleCache, 'actionTools', 'executeAction', context, input);
    if (!result?.ok) {
      if (checkpoint?.id && typeof checkpointModule.deleteCheckpoint === 'function') {
        await checkpointModule.deleteCheckpoint(context, { id: checkpoint.id });
      }
      return result;
    }
    return {
      ...result,
      data: {
        ...asRecord(result.data),
        automaticCheckpoint: checkpoint ?? null,
      },
    };
  } catch (error) {
    if (checkpoint?.id && typeof checkpointModule.deleteCheckpoint === 'function') {
      await checkpointModule.deleteCheckpoint(context, { id: checkpoint.id });
    }
    throw error;
  }
}

async function resetYgoPro2Game(config, moduleCache, context, input) {
  const session = requireSession(context, 'resetGame');
  const enumerator = resolveRunner(context);
  if (!enumerator || typeof enumerator.tryBuildDecisionFromMessage !== 'function') {
    return { ok: false, code: 'YGOPRO2_ENUMERATOR_UNAVAILABLE', error: 'Unable to create the legal-action enumerator required by the YGOPro2 bridge.' };
  }
  if (input.playerOpening || input.opponentOpening || input.openingCards || input.playerOpeningCards || input.opponentOpeningCards) {
    return {
      ok: false,
      code: 'YGOPRO2_FIXED_OPENING_UNSUPPORTED',
      error: 'YGOPro2 AI.Server mode does not support fixed opening injection. Remove fixed-opening fields or use duelBackend:"embedded".',
    };
  }
  const playerTurnOrder = readString(input.playerTurnOrder);
  if (playerTurnOrder !== 'first' && playerTurnOrder !== 'second') {
    return {
      ok: false,
      code: 'YGOPRO2_TURN_ORDER_REQUIRED',
      error: 'YGOPro2 mode requires playerTurnOrder:"first" or playerTurnOrder:"second" so the model explicitly chooses its seat.',
    };
  }
  const discovery = await discoverYgoPro2({
    ...(readString(input.ygoPro2Root) ? { root: input.ygoPro2Root, scan: false } : {}),
    ...(readString(input.externalPolicyRoot) ? { externalPolicyRoot: input.externalPolicyRoot } : {}),
  }, config.env ?? process.env);
  session.mergeMetadata({ ygoPro2Discovery: discovery.data, ygoPro2DiscoveryUpdatedAt: discovery.data.recordedAt });
  const installation = discovery.data.selected;
  const externalPolicyClient = discovery.data.selectedExternalPolicyClient;
  if (!installation?.capabilities?.bridgeLaunchReady || !externalPolicyClient?.verified) {
    return {
      ok: false,
      code: 'YGOPRO2_BRIDGE_NOT_READY',
      error: 'A complete AI.Server + stock WindBot + verified external-policy WindBot installation was not found.',
      data: discovery.data,
    };
  }
  const playerDeck = asDeck(input.playerDeck) ?? asDeck(input.deck) ?? asDeck(enumerator.playerDeck);
  const opponentDeck = asDeck(input.opponentDeck);
  if (!playerDeck) return { ok: false, code: 'YGOPRO2_PLAYER_DECK_REQUIRED', error: 'YGOPro2 mode requires a playerDeck or loaded session deck.' };
  const opponentAiProfile = readString(input.opponentAiProfile) ?? 'Lucky';
  try { enumerator.destroyDuel?.(); } catch { }
  try {
    const runner = await createYgoPro2DuelRunner({
      enumerator,
      playerDeck,
      opponentDeck,
      opponentAiProfile,
      playerTurnOrder,
      installation,
      externalPolicyClient,
      startupTimeoutMs: input.startupTimeoutMs,
      decisionTimeoutMs: input.decisionTimeoutMs,
    });
    session.runner = runner;
    context.runner = runner;
    session.mergeMetadata({ duelBackend: runner.duelBackend, opponentAiProfile, playerTurnOrder, ygoPro2Bridge: runner.getBridgeStatus() });
    const stateModule = await loadCoreModule(config, moduleCache, 'stateTools');
    const state = stateModule.getCurrentState(runner, { graveyardLimit: input.graveyardLimit });
    const actions = stateModule.listActions(runner, { limit: 100 });
    return {
      ok: true,
      data: {
        state: state.ok ? state.data : null,
        nextDecision: actions.ok ? {
          terminal: actions.data.terminal,
          reason: actions.data.reason,
          decision: actions.data.decision,
          actionCount: actions.data.totalActions,
          actions: actions.data.actions,
          truncated: actions.data.truncated,
          factorizedSelection: actions.data.factorizedSelection,
          estimatedLegalCandidateCount: actions.data.estimatedLegalCandidateCount,
          selectionConstraints: actions.data.selectionConstraints,
        } : null,
        seed: null,
        deck: {
          playerMain: playerDeck.main.length,
          playerExtra: playerDeck.extra.length,
          opponentMain: opponentDeck?.main.length ?? null,
          opponentExtra: opponentDeck?.extra.length ?? null,
        },
        historyLength: 0,
        applied: { seed: false, deck: true, opening: false, drawCount: false, drawCountForcedByFixedOpening: false },
        duelBackend: runner.duelBackend,
        opponentAiProfile,
        playerTurnOrder,
        opponentControlledBy: 'windbot',
        bridge: runner.getBridgeStatus(),
      },
    };
  } catch (error) {
    session.runner = null;
    context.runner = null;
    return {
      ok: false,
      code: 'YGOPRO2_BRIDGE_START_FAILED',
      error: error instanceof Error ? error.message : String(error),
      data: { installation, externalPolicyClient },
    };
  }
}

function resetExistingExternalRunner(context) {
  const runner = resolveRunner(context);
  if (!isYgoPro2DuelRunner(runner)) return;
  runner.destroyDuel?.();
  const session = resolveSession(context);
  if (session) session.runner = null;
  if (context && typeof context === 'object') context.runner = null;
}

function unsupportedExternalDuelTool(name) {
  return {
    ok: false,
    code: 'UNSUPPORTED_FOR_EXTERNAL_DUEL',
    error: `${name} is unavailable for an authoritative AI.Server duel because the external server cannot be snapshotted or rolled back.`,
  };
}

async function createConfiguredRunner(config, moduleCache, options = {}) {
  const module = await loadCoreModule(config, moduleCache, 'runnerFactory');
  const fn = module.createRealRunner;
  if (typeof fn !== 'function') {
    throw new Error('runnerFactory.createRealRunner is not available.');
  }

  const session = resolveSession(options);
  if (session) await migrateLegacySession({ session }, config, moduleCache);
  const migratedOptions = await migrateRunnerOptions(options, config, moduleCache);
  const runnerOptions = buildRunnerOptions(config, migratedOptions);
  const originalLog = console.log;
  const originalInfo = console.info;
  const originalCwd = process.cwd();
  try {
    if (options.showRunnerLogs !== true) {
      console.log = () => {};
      console.info = () => {};
    }
    process.chdir(config.runtimeRoot);
    return await fn(runnerOptions);
  } finally {
    process.chdir(originalCwd);
    console.log = originalLog;
    console.info = originalInfo;
  }
}

async function executeCardEffectWithMigration(config, moduleCache, context, input) {
  const record = asRecord(input);
  const direct = readCardId(record.id) ?? readCardId(record.cardId) ?? readCardId(record.passcode);
  if (!direct) return executeNamedExport(config, moduleCache, 'cardTools', 'getCardEffect', context, input);
  const cardsDb = await openCardsDb(config, moduleCache);
  try {
    const migrations = await loadIdMigrationMap(config);
    const resolved = resolveCurrentCardId(direct, cardsDb, migrations.map);
    if (!resolved.ok || resolved.id === direct) {
      return executeNamedExport(config, moduleCache, 'cardTools', 'getCardEffect', context, input);
    }
    const result = await executeNamedExport(config, moduleCache, 'cardTools', 'getCardEffect', context, {
      ...record,
      id: resolved.id,
      cardId: undefined,
      passcode: undefined,
    });
    if (result?.ok && result.data) result.data.idMigration = {
      applied: true,
      oldId: direct,
      newId: resolved.id,
      chain: resolved.chain,
      migrationSource: migrations.path,
      migrationSourceUpdatedAt: migrations.updatedAt,
    };
    return result;
  } finally {
    cardsDb.close?.();
  }
}

async function migrateRunnerOptions(options, config, moduleCache) {
  const record = asRecord(options);
  const candidates = [record.playerDeck, typeof record.deck === 'object' ? record.deck : null, record.opponentDeck];
  const openingCandidates = [record.playerOpening, record.opponentOpening];
  const openingArrayKeys = ['playerOpeningCards', 'openingCards', 'opponentOpeningCards'].filter((key) => Array.isArray(record[key]));
  const session = resolveSession(record);
  const deckFile = !asDeck(record.playerDeck) && !asDeck(record.deck) && !readSessionDeck(session)
    ? readString(record.deckPath) ?? readString(record.deck) ?? config.deckPath
    : null;
  if (!candidates.some((deck) => asDeck(deck)) && !openingCandidates.some(hasOpeningState) && openingArrayKeys.length === 0 && !deckFile) return options;
  const cardsDb = await openCardsDb(config, moduleCache);
  try {
    const migrations = await loadIdMigrationMap(config);
    const output = { ...record };
    for (const key of ['playerDeck', 'opponentDeck']) {
      const deck = asDeck(record[key]);
      if (!deck) continue;
      const parsed = parseDeckInput({ deck: record[key] }, cardsDb);
      if (!parsed.ok) throwMigrationError('RUNNER_DECK_INVALID', `${key} is invalid.`, { error: parsed.error });
      const migrated = migrateDeckIds(parsed.deck, cardsDb, migrations, parsed.unknownCards);
      if (!migrated.ok) throwMigrationError('RUNNER_DECK_MIGRATION_UNRESOLVED', `${key} contains card IDs that cannot be migrated.`, migrated.report);
      output[key] = migrated.deck;
    }
    if (typeof record.deck === 'object') {
      const deck = asDeck(record.deck);
      if (deck) {
        const parsed = parseDeckInput({ deck: record.deck }, cardsDb);
        if (!parsed.ok) throwMigrationError('RUNNER_DECK_INVALID', 'deck is invalid.', { error: parsed.error });
        const migrated = migrateDeckIds(parsed.deck, cardsDb, migrations, parsed.unknownCards);
        if (!migrated.ok) throwMigrationError('RUNNER_DECK_MIGRATION_UNRESOLVED', 'deck contains card IDs that cannot be migrated.', migrated.report);
        output.deck = migrated.deck;
      }
    }
    if (deckFile) {
      const deckText = await readFile(resolve(deckFile), 'utf8');
      const parsed = parseDeckInput(deckText, cardsDb);
      if (!parsed.ok) throwMigrationError('RUNNER_DECK_INVALID', `Deck file is invalid: ${deckFile}`, { error: parsed.error, deckFile });
      const migrated = migrateDeckIds(parsed.deck, cardsDb, migrations, parsed.unknownCards);
      if (!migrated.ok) throwMigrationError('RUNNER_DECK_MIGRATION_UNRESOLVED', `Deck file contains card IDs that cannot be migrated: ${deckFile}`, { ...migrated.report, deckFile });
      output.playerDeck = migrated.deck;
      output.deckMigration = migrated.report;
    }
    for (const key of ['playerOpening', 'opponentOpening']) {
      if (!hasOpeningState(record[key])) continue;
      const opening = asRecord(record[key]);
      const migratedOpening = migrateCardEntries(opening.opening, cardsDb, migrations, `${key}.opening`);
      const migratedRemain = migrateCardEntries(opening.remain, cardsDb, migrations, `${key}.remain`);
      if (!migratedOpening.ok || !migratedRemain.ok) throwMigrationError('RUNNER_OPENING_MIGRATION_UNRESOLVED', `${key} contains card IDs that cannot be migrated.`, mergeMigrationReports(migratedOpening.report, migratedRemain.report));
      output[key] = { ...opening, opening: migratedOpening.cards, remain: migratedRemain.cards };
    }
    for (const key of openingArrayKeys) {
      const migrated = migrateCardEntries(record[key], cardsDb, migrations, key);
      if (!migrated.ok) throwMigrationError('RUNNER_OPENING_MIGRATION_UNRESOLVED', `${key} contains card IDs that cannot be migrated.`, migrated.report);
      output[key] = migrated.cards;
    }
    return output;
  } finally {
    cardsDb.close?.();
  }
}

function throwMigrationError(code, message, data) {
  const error = new Error(message);
  error.code = code;
  error.data = data;
  throw error;
}

async function ensurePreparedRunner(context, config, moduleCache, input = {}) {
  if (resolveRunner(context)) return;
  const session = resolveSession(context) ?? context.session ?? createYgoSession({ config });
  context.session = session;
  const runner = await createConfiguredRunner(config, moduleCache, {
    ...asRecord(input),
    session,
  });
  session.runner = runner;
  context.runner = runner;
}

function buildRunnerOptions(config, options = {}) {
  const record = asRecord(options);
  const session = resolveSession(record);
  const currentDeck = readSessionDeck(session);
  const fixedOpening = readFixedOpeningCards(session);
  const playerDeck = asDeck(record.playerDeck) ?? asDeck(record.deck) ?? currentDeck ?? undefined;
  const opponentDeck = asDeck(record.opponentDeck) ?? undefined;
  const explicitPlayerOpeningCards = readArray(record.playerOpeningCards).length > 0
    ? readArray(record.playerOpeningCards)
    : readArray(record.openingCards);
  const explicitOpponentOpeningCards = readArray(record.opponentOpeningCards);
  return {
    deck: readString(record.deckPath) ?? readString(record.deck) ?? config.deckPath,
    cardsDb: readString(record.cardsDbPath) ?? readString(record.cardsDb) ?? config.cardsDbPath,
    cardsDbs: normalizePathList(record.cardsDbPaths ?? record.cardsDbs ?? config.cardsDbPaths),
    scriptsDir: readString(record.scriptsDir) ?? config.scriptsDir,
    scriptDirs: normalizePathList(record.scriptDirs ?? config.scriptDirs),
    seed: readNumber(record.seed) ?? undefined,
    yrpVersion: readNumber(record.yrpVersion) ?? undefined,
    drawCount: readNumber(record.drawCount) ?? (explicitPlayerOpeningCards.length > 0 ? explicitPlayerOpeningCards.length : fixedOpening.length > 0 ? fixedOpening.length : undefined),
    playerDeck,
    opponentDeck,
    playerOpening: asOpening(record.playerOpening) ?? buildFixedOpeningState(playerDeck, explicitPlayerOpeningCards.length > 0 ? explicitPlayerOpeningCards : fixedOpening) ?? undefined,
    opponentOpening: asOpening(record.opponentOpening) ?? buildFixedOpeningState(opponentDeck, explicitOpponentOpeningCards) ?? undefined,
  };
}

function buildFixedOpeningState(deck, openingCards) {
  if (!deck || openingCards.length === 0) return null;
  const remain = deck.main.slice();
  for (const id of openingCards) {
    const index = remain.indexOf(id);
    if (index < 0) return null;
    remain.splice(index, 1);
  }
  return { opening: openingCards.slice(), remain, label: 'session-fixed-opening' };
}

function injectSessionResetDefaults(context, input) {
  const session = resolveSession(context);
  if (!session) return input;
  const record = asRecord(input);
  const deck = readSessionDeck(session);
  const fixedOpening = readFixedOpeningCards(session);
  const hasExplicitPlayerDeck = Boolean(record.playerDeck || record.deck);
  const hasExplicitOpening = Boolean(
    record.playerOpeningCards ||
    record.openingCards ||
    record.playerOpening ||
    record.opponentOpening ||
    record.opponentOpeningCards,
  );
  return {
    ...record,
    ...(!hasExplicitPlayerDeck && deck ? { playerDeck: deck } : {}),
    ...(fixedOpening.length > 0 && !hasExplicitOpening
      ? { drawCount: fixedOpening.length, playerOpeningCards: fixedOpening }
      : {}),
  };
}

async function executeNamedExport(config, moduleCache, moduleKey, exportName, context, input) {
  const module = await loadCoreModule(config, moduleCache, moduleKey);
  const fn = module[exportName];
  if (typeof fn !== 'function') {
    return { ok: false, code: 'MISSING_EXPORT', error: `${moduleKey}.${exportName} is not available.` };
  }
  return fn(context, input);
}

async function executeDataTool(name, config, moduleCache, input) {
  const module = await loadCoreModule(config, moduleCache, 'dataTools');
  const fn = name === 'getBanlistContext' ? module.readBanlistContext : module[name];
  if (typeof fn !== 'function') {
    return { ok: false, code: 'MISSING_EXPORT', error: `Data tool export missing: ${name}` };
  }
  return fn(toDataOptions(input, config));
}

async function executeReplayTool(name, config, moduleCache, context, input) {
  if (name === 'parseYrpRoute' && input.file && !input.yrpBase64) {
    const payload = await readFile(resolve(String(input.file)));
    return executeNamedExport(config, moduleCache, 'replayTools', name, context, {
      ...input,
      yrpBase64: payload.toString('base64'),
      fileName: input.fileName ?? String(input.file).split(/[\\/]/).pop(),
    });
  }
  return executeNamedExport(config, moduleCache, 'replayTools', name, context, input);
}

async function loadCoreModule(config, moduleCache, key) {
  const relative = CORE_MODULES[key];
  if (!relative) throw new Error(`Unknown core module key: ${key}`);
  const fullPath = resolve(config.runtimeRoot, relative);
  const href = pathToFileURL(fullPath).href;
  if (!moduleCache.has(href)) {
    moduleCache.set(href, importWithSourceCwd(href, config.runtimeRoot));
  }
  return moduleCache.get(href);
}

async function importWithSourceCwd(href, cwd) {
  const originalCwd = process.cwd();
  try {
    process.chdir(cwd);
    return await import(href);
  } finally {
    process.chdir(originalCwd);
  }
}

function prepareContext(context, config) {
  const session = resolveSession(context) ?? createYgoSession({ config });
  const runner = resolveRunner(context) ?? session.runner ?? null;
  return {
    ...asRecord(context),
    config,
    session,
    runner,
    cardsDbPath: config.cardsDbPath,
    cardsDbPaths: config.cardsDbPaths,
    dbPath: config.cardsDbPath,
    dbPaths: config.cardsDbPaths,
    scriptsDir: config.scriptsDir,
    scriptDirs: config.scriptDirs,
  };
}

function injectInputDefaults(name, input, config) {
  if (name === 'inspectCardDataSources' || name === 'getBanlistContext' || name === 'refreshCardDataSources') {
    return asRecord(input);
  }
  return {
    ...asRecord(input),
    dbPath: asRecord(input).dbPath ?? config.cardsDbPath,
    dbPaths: asRecord(input).dbPaths ?? config.cardsDbPaths,
    cardsDbPath: asRecord(input).cardsDbPath ?? config.cardsDbPath,
    cardsDbPaths: asRecord(input).cardsDbPaths ?? config.cardsDbPaths,
    scriptsDir: asRecord(input).scriptsDir ?? config.scriptsDir,
    scriptDirs: asRecord(input).scriptDirs ?? config.scriptDirs,
    replayDir: asRecord(input).replayDir ?? config.replayDir,
    routeDir: asRecord(input).routeDir ?? config.routeDir,
  };
}

function toDataOptions(input, config) {
  const record = asRecord(input);
  return {
    ...record,
    scriptsDir: record.scriptsDir ?? config.scriptsDir,
    scriptDirs: record.scriptDirs ?? config.scriptDirs,
    prereleaseDir: record.prereleaseDir ?? config.prereleaseDir,
    activeDataDir: record.activeDataDir ?? resolve(config.resourceRoot, 'lib'),
  };
}

async function openCardsDb(config, moduleCache) {
  const module = await loadCoreModule(config, moduleCache, 'cardsDb');
  return module.openCardsDatabase({ dbPaths: config.cardsDbPaths });
}

function normalizePathList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const paths = [];
  for (const item of value) {
    const text = readString(item);
    if (!text) continue;
    const path = resolve(text);
    if (seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  return paths;
}

async function setSessionDeck(context, input, config, moduleCache) {
  const session = requireSession(context, 'setSessionDeck');
  const cardsDb = await openCardsDb(config, moduleCache);
  try {
    const parsed = parseDeckInput(input, cardsDb);
    if (!parsed.ok) return parsed;
    const migrations = await loadIdMigrationMap(config);
    const migrated = migrateDeckIds(parsed.deck, cardsDb, migrations, parsed.unknownCards);
    if (!migrated.ok) {
      return { ok: false, code: 'DECK_MIGRATION_UNRESOLVED', error: 'Deck contains card IDs that cannot be migrated to the current database.', data: { migration: migrated.report, originalDeck: migrated.originalDeck } };
    }
    const deckName = readString(input.name) ?? readString(input.fileName) ?? readString(input.deckName) ?? 'uploaded.ydk';
    session.mergeMetadata({
      currentDeck: migrated.deck,
      currentDeckName: deckName,
      currentDeckUpdatedAt: new Date().toISOString(),
      currentDeckOriginal: migrated.originalDeck,
      currentDeckOriginalYdk: serializeYdkText(migrated.originalDeck),
      currentDeckMigration: migrated.report,
      currentDeckMigratedAt: migrated.report.applied ? new Date().toISOString() : null,
    });
    return {
      ok: true,
      data: {
        action: 'set',
        name: deckName,
        message: `Deck loaded into session: ${deckName}`,
        migration: migrated.report,
        originalDeck: migrated.report.applied ? migrated.originalDeck : null,
        ...analyzeDeck(migrated.deck, cardsDb, []),
      },
    };
  } finally {
    cardsDb.close?.();
  }
}

function getSessionDeck(context) {
  const session = requireSession(context, 'getSessionDeck');
  const deck = readSessionDeck(session);
  if (!deck) return { ok: false, error: 'No deck is loaded for this session. Call setSessionDeck first.' };
  return {
    ok: true,
    data: {
      name: readString(session.metadata.currentDeckName) ?? 'uploaded.ydk',
      deck,
      counts: countDeck(deck),
      ydk: serializeYdkText(deck),
      updatedAt: readString(session.metadata.currentDeckUpdatedAt),
      migration: asRecord(session.metadata.currentDeckMigration),
      originalDeck: session.metadata.currentDeckOriginal ?? null,
      originalYdk: readString(session.metadata.currentDeckOriginalYdk),
    },
  };
}

async function checkDeckCards(context, input, config, moduleCache) {
  const session = requireSession(context, 'checkDeckCards');
  const deck = readSessionDeck(session);
  if (!deck) return { ok: false, error: 'No deck is loaded for this session. Call setSessionDeck first.' };
  const cardsDb = await openCardsDb(config, moduleCache);
  try {
    const migrations = await loadIdMigrationMap(config);
    const queries = [
      ...readArray(input.cards),
      ...readArray(input.cardNames),
      ...readArray(input.names),
      ...readArray(input.ids),
      ...readArray(input.cardIds),
      ...readArray(input.passcodes),
    ];
    if (queries.length === 0) {
      return { ok: false, error: 'checkDeckCards requires cards, cardNames, names, ids, cardIds, or passcodes.' };
    }
    const allIds = [...deck.main, ...deck.extra, ...deck.side];
    const results = queries.map((query, index) => checkOneDeckCard(query, index, allIds, cardsDb, migrations));
    return {
      ok: true,
      data: {
        deckName: readString(session.metadata.currentDeckName) ?? 'uploaded.ydk',
        counts: countDeck(deck),
        checked: results.length,
        allInCurrentDeck: results.every((result) => result.inCurrentDeck),
        missingFromDeck: results.filter((result) => result.foundInDatabase && !result.inCurrentDeck),
        unknown: results.filter((result) => !result.foundInDatabase),
        results,
      },
    };
  } finally {
    cardsDb.close?.();
  }
}

async function editSessionDeck(context, input, config, moduleCache) {
  const session = requireSession(context, 'editSessionDeck');
  const deck = readSessionDeck(session);
  if (!deck) return { ok: false, error: 'No deck is loaded for this session. Call setSessionDeck first.' };
  const operation = readString(input.operation)?.toLowerCase();
  const section = normalizeSection(input.section) ?? 'main';
  if (!['add', 'remove', 'set', 'clear'].includes(operation ?? '')) {
    return { ok: false, error: 'editSessionDeck operation must be add, remove, set, or clear.' };
  }
  const next = cloneDeck(deck);
  let editMigration = { applied: false, changes: [], unresolved: [] };
  if (operation === 'clear') {
    next[section] = [];
  } else {
    const cardsDb = await openCardsDb(config, moduleCache);
    try {
      const migrations = await loadIdMigrationMap(config);
      const resolved = resolveInputCard(input, cardsDb, migrations);
      if (!resolved.ok) return { ok: false, code: 'CARD_MIGRATION_UNRESOLVED', error: resolved.error, data: { migration: resolved.report } };
      editMigration = resolved.report;
      const cardId = resolved.id;
      const quantity = Math.max(0, Math.min(60, Math.trunc(Number(input.quantity ?? input.count ?? 1))));
      next[section] = next[section].filter((id) => id !== cardId);
      if (operation === 'add') next[section] = deck[section].concat(Array(quantity).fill(cardId));
      if (operation === 'set') next[section] = next[section].concat(Array(quantity).fill(cardId));
    } finally {
      cardsDb.close?.();
    }
  }
  session.mergeMetadata({
    currentDeck: next,
    currentDeckUpdatedAt: new Date().toISOString(),
    ...(editMigration.applied ? { currentDeckMigration: mergeMigrationReports(session.metadata.currentDeckMigration, editMigration) } : {}),
  });
  return { ok: true, data: { action: operation, deck: next, counts: countDeck(next), ydk: serializeYdkText(next), migration: editMigration } };
}

async function exportSessionDeck(context, input, config) {
  const session = requireSession(context, 'exportSessionDeck');
  const deck = readSessionDeck(session);
  if (!deck) return { ok: false, error: 'No deck is loaded for this session. Call setSessionDeck first.' };
  const ydk = serializeYdkText(deck);
  const requested = readString(input.file) ?? readString(input.outputPath) ?? readString(input.fileName);
  let savedPath = null;
  if (input.save === true || requested) {
    const authorization = checkFileWriteAuthorization(config, input, 'exportSessionDeck');
    if (!authorization.ok) return authorization;
    const baseDir = readString(config.deckDir) ?? resolve(config.skillRoot, 'output', 'decks');
    const target = requested ?? readString(session.metadata.currentDeckName) ?? 'deck.ydk';
    savedPath = resolve(baseDir, /\.ydk$/i.test(target) ? target : `${target}.ydk`);
    await mkdir(dirname(savedPath), { recursive: true });
    await writeFile(savedPath, ydk, 'utf8');
  }
  return { ok: true, data: { name: readString(session.metadata.currentDeckName) ?? 'uploaded.ydk', deck, counts: countDeck(deck), ydk, migration: asRecord(session.metadata.currentDeckMigration), originalDeckPreserved: Boolean(session.metadata.currentDeckOriginal), originalDeck: session.metadata.currentDeckOriginal ?? null, originalYdk: readString(session.metadata.currentDeckOriginalYdk), saved: savedPath !== null, savedPath } };
}

async function setFixedOpening(context, input, config, moduleCache) {
  const session = requireSession(context, 'setFixedOpening');
  if (input.clear === true) {
    session.mergeMetadata({ fixedOpeningCards: [], fixedOpeningUpdatedAt: new Date().toISOString() });
    return { ok: true, data: { action: 'clear', fixedOpeningCards: [], playerOpeningCards: [] } };
  }
  const cardsDb = await openCardsDb(config, moduleCache);
  try {
    const entries = [
      ...readArray(input.cards),
      ...readArray(input.cardIds),
      ...readArray(input.playerOpeningCards),
      ...readArray(input.openingCards),
      ...readArray(input.cardNames),
      ...readArray(input.names),
    ];
    if (entries.length === 0) {
      return { ok: false, error: 'setFixedOpening requires cards, cardIds, playerOpeningCards, openingCards, cardNames, names, or clear:true.' };
    }
    const migrations = await loadIdMigrationMap(config);
    const migrated = migrateCardEntries(entries, cardsDb, migrations, 'fixedOpening');
    if (!migrated.ok) return { ok: false, code: 'OPENING_MIGRATION_UNRESOLVED', error: 'Fixed opening contains cards that cannot be migrated.', data: { migration: migrated.report } };
    const cards = migrated.cards;
    const deck = readSessionDeck(session);
    const availability = deck ? checkOpeningAvailability(deck.main, cards) : null;
    if (availability && !availability.ok) {
      return { ok: false, error: 'Fixed opening cards are not all available in the loaded main deck.', data: { requestedOpeningCards: cards, deckAvailability: availability } };
    }
    session.mergeMetadata({ fixedOpeningCards: cards, fixedOpeningOriginal: entries, fixedOpeningMigration: migrated.report, fixedOpeningUpdatedAt: new Date().toISOString() });
    return { ok: true, data: { action: 'set', fixedOpeningCards: cards, playerOpeningCards: cards, migration: migrated.report, deckAvailability: availability } };
  } finally {
    cardsDb.close?.();
  }
}

function buildRouteContext(context, input) {
  const inputRecord = asRecord(input);
  const route = firstNonEmptyRecord([
    asRecord(inputRecord.route),
    isRouteLikeRecord(inputRecord) ? inputRecord : {},
    asRecord(asRecord(context).lastParsedYrpRoute),
    asRecord(resolveSession(context)?.metadata?.lastParsedYrpRoute),
  ]);
  const markdown = readString(asRecord(route.context).markdown);
  return {
    ok: true,
    data: {
      route,
      markdown,
      summary: asRecord(route.summary),
      source: asRecord(route.source),
    },
  };
}

async function executeParseComboArtifact(context, input) {
  const result = await parseComboArtifactInput(input);
  if (result.ok) {
    const session = resolveSession(context);
    session?.mergeMetadata({
      lastParsedComboArtifact: result.data,
      lastParsedComboArtifactUpdatedAt: new Date().toISOString(),
    });
  }
  return result;
}

async function executeBuildComboAdaptationContext(context, input, config, moduleCache) {
  const session = requireSession(context, 'buildComboAdaptationContext');
  let parsed = asRecord(input.parsed);
  if (Object.keys(parsed).length === 0 && ['artifact', 'json', 'content', 'text', 'file'].some((key) => input[key] !== undefined)) {
    const result = await parseComboArtifactInput(input);
    if (!result.ok) return result;
    parsed = result.data;
    session.mergeMetadata({ lastParsedComboArtifact: parsed, lastParsedComboArtifactUpdatedAt: new Date().toISOString() });
  }
  if (Object.keys(parsed).length === 0) parsed = asRecord(session.metadata.lastParsedComboArtifact);
  if (Object.keys(parsed).length === 0) {
    return { ok: false, code: 'NO_PARSED_COMBO', error: 'Call parseComboArtifact first or provide parsed/artifact/content/file input.' };
  }
  const currentDeck = readSessionDeck(session);
  if (!currentDeck) {
    return { ok: false, code: 'NO_SESSION_DECK', error: 'Load the new/current deck with setSessionDeck before building combo adaptation context.' };
  }
  const cardsDb = await openCardsDb(config, moduleCache);
  try {
    return buildComboAdaptationReport(parsed, currentDeck, {
      byId: (id) => cardsDb.getById(id),
      byName: (name) => cardsDb.getByName(name),
    });
  } finally {
    cardsDb.close?.();
  }
}

function isRouteLikeRecord(record) {
  return Boolean(
    record.summary ||
    record.context ||
    record.source ||
    record.replay ||
    record.deck ||
    record.visibleSteps ||
    record.rawEvents ||
    record.warnings,
  );
}

async function saveReplayYrpPortable(config, _moduleCache, context, input) {
  const authorization = checkFileWriteAuthorization(config, input, 'saveReplayYrp');
  if (!authorization.ok) return authorization;
  const runner = resolveRunner(context);
  if (!runner) return { ok: false, error: 'saveReplayYrp requires a session runner.' };

  const record = asRecord(input);
  const runnerRecord = asRecord(runner);
  const state = typeof runnerRecord.saveState === 'function'
    ? runnerRecord.saveState.call(runner, 'ygoagentskill.saveReplayYrp')
    : { history: Array.isArray(runnerRecord.actionHistory) ? runnerRecord.actionHistory.slice() : [] };
  const stateRecord = asRecord(state);
  const history = Array.isArray(stateRecord.history) ? stateRecord.history : [];
  const pendingDecision = readPendingDecision(stateRecord.decision ?? runnerRecord.currentDecision);
  if (history.length === 0) {
    return {
      ok: false,
      error: 'saveReplayYrp refused to export an empty replay: no executed action history is available.',
    };
  }

  const outputDir = resolve(readString(record.replayDir) ?? config.replayDir);
  const fileName = buildSafeReplayFileName(
    readString(record.fileName) ?? readString(record.title) ?? `agent-replay-${new Date().toISOString()}`,
  );
  const outputPath = resolve(outputDir, fileName);
  if (!isInsideDirectory(outputPath, outputDir)) {
    return { ok: false, error: 'saveReplayYrp resolved outside the configured replay output directory.' };
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
  const opponentDeck = normalizeReplayDeck(runnerRecord.opponentDeck);
  const opponentDeckFallback = shouldApplyOpponentDeckFallback(opponentDeck, drawCount);
  if (opponentDeckFallback) {
    warnings.push('Opponent deck was empty or too small for replay startup; saveReplayYrp inserted a generic 40-card opponent main deck for YGOPro compatibility.');
  }

  const replayExportApi = createPortableReplayExportApi(config);
  let replayInfo;
  try {
    replayInfo = replayExportApi.exportReplayYrp({
      seed: normalizeUInt32(runnerRecord.seed) ?? 0,
      drawCount,
      playerDeck: normalizeReplayDeck(runnerRecord.playerDeck),
      opponentDeck,
      playerOpening: normalizeOpening(runnerRecord.playerOpening),
      opponentOpening: normalizeOpening(runnerRecord.opponentOpening),
      state,
      responsesEncoded,
      outPath: outputPath,
      yrpVersion,
      seedSequence: normalizeUInt32List(runnerRecord.seedSequence),
    });
  } catch (error) {
    return {
      ok: false,
      error: `saveReplayYrp failed while exporting replay bytes: ${formatError(error)}`,
      data: { historyLength: history.length, responseBuildMode },
    };
  }
  const replayCheck = await inspectSavedReplay(config, replayInfo.outPath);

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

async function saveYgoPro2ReplayPortable(config, context, input) {
  const authorization = checkFileWriteAuthorization(config, input, 'saveReplayYrp');
  if (!authorization.ok) return authorization;
  const runner = resolveRunner(context);
  if (!isYgoPro2DuelRunner(runner)) {
    return { ok: false, code: 'YGOPRO2_REPLAY_RUNNER_REQUIRED', error: 'A real YGOPro2 AI.Server runner is required.' };
  }
  const record = asRecord(input);
  const expectedModelResponseCount = Array.isArray(runner.actionHistory)
    ? runner.actionHistory.filter((entry) => entry?.kind !== 'surrender').length
    : 0;
  let surrenderedForExport = false;
  if (runner.currentDecision?.terminal !== true || !runner.terminalResult) {
    if (record.surrenderIfRunning !== true) {
      return {
        ok: false,
        code: 'YGOPRO2_REPLAY_NOT_TERMINAL',
        error: 'AI.Server replay export requires a terminal result. Set surrenderIfRunning:true to surrender this live duel, receive the authoritative server replay, and save it in one call.',
      };
    }
    if (typeof runner.surrenderAndWaitForReplay !== 'function') {
      return {
        ok: false,
        code: 'YGOPRO2_SURRENDER_UNAVAILABLE',
        error: 'This YGOPro2 runner cannot submit a protocol surrender.',
      };
    }
    try {
      const surrendered = await runner.surrenderAndWaitForReplay(record.surrenderTimeoutMs);
      surrenderedForExport = surrendered?.surrendered === true && surrendered?.alreadyTerminal !== true;
    } catch (error) {
      return {
        ok: false,
        code: 'YGOPRO2_SURRENDER_FAILED',
        error: `AI.Server surrender failed before replay export: ${formatError(error)}`,
      };
    }
  }

  const replayBytes = typeof runner.waitForReplayBytes === 'function'
    ? await runner.waitForReplayBytes(5000)
    : runner.replayBytes;
  if (!(replayBytes instanceof Uint8Array) || replayBytes.length === 0) {
    return {
      ok: false,
      code: 'YGOPRO2_REPLAY_NOT_RECEIVED',
      error: 'The duel is terminal, but the authoritative AI.Server replay payload has not been received.',
    };
  }

  const outputDir = resolve(readString(record.replayDir) ?? config.replayDir);
  const fileName = buildSafeReplayFileName(
    readString(record.fileName) ?? readString(record.title) ?? `ai-server-replay-${new Date().toISOString()}`,
  );
  const outputPath = resolve(outputDir, fileName);
  if (!isInsideDirectory(outputPath, outputDir)) {
    return { ok: false, error: 'saveReplayYrp resolved outside the configured replay output directory.' };
  }

  await mkdir(outputDir, { recursive: true });
  const stagingPath = resolve(outputDir, `.${fileName}.partial-${process.pid}-${Date.now()}`);
  let replayCheck;
  try {
    await writeFile(stagingPath, replayBytes);
    replayCheck = await inspectSavedReplay(config, stagingPath);
    if (!replayCheck.ok) {
      return {
        ok: false,
        code: 'YGOPRO2_REPLAY_INVALID',
        error: `AI.Server returned replay bytes that failed local parsing: ${replayCheck.error ?? 'unknown parser error'}`,
        data: { byteLength: replayBytes.length, expectedModelResponseCount, saved: false },
      };
    }
    if (!Number.isInteger(replayCheck.responseCount) || replayCheck.responseCount === 0) {
      return {
        ok: false,
        code: 'YGOPRO2_REPLAY_EMPTY',
        error: 'AI.Server returned a zero-response replay. The file was not published because it cannot represent a progressed duel.',
        data: { byteLength: replayBytes.length, responseCount: replayCheck.responseCount, expectedModelResponseCount, saved: false },
      };
    }
    if (replayCheck.responseCount < expectedModelResponseCount) {
      return {
        ok: false,
        code: 'YGOPRO2_REPLAY_INCOMPLETE',
        error: `AI.Server replay contains ${replayCheck.responseCount} responses, fewer than the ${expectedModelResponseCount} model responses submitted before export. The file was not published.`,
        data: { byteLength: replayBytes.length, responseCount: replayCheck.responseCount, expectedModelResponseCount, saved: false },
      };
    }
    await rm(outputPath, { force: true });
    await rename(stagingPath, outputPath);
  } finally {
    await rm(stagingPath, { force: true });
  }
  const data = {
    path: outputPath,
    fileName,
    outputDir,
    yrpVersion: replayCheck.ok ? replayCheck.yrpVersion : null,
    byteLength: replayBytes.length,
    responseCount: replayCheck.ok ? replayCheck.responseCount : null,
    savedReplayCheck: replayCheck,
    historyLength: runner.actionHistory.length,
    pendingDecision: null,
    responseBuildMode: 'ai-server-raw',
    authoritative: true,
    source: 'AI.Server STOC_REPLAY',
    terminalResult: runner.terminalResult,
    surrenderedForExport,
    replayCoverage: {
      expectedModelResponseCount,
      replayResponseCount: replayCheck.responseCount,
      complete: replayCheck.responseCount >= expectedModelResponseCount,
      nonEmpty: replayCheck.responseCount > 0,
    },
    warnings: [],
  };
  recordSavedReplay(context, data);
  return { ok: true, data };
}

async function saveRouteFilePortable(config, moduleCache, context, input) {
  const authorization = checkFileWriteAuthorization(config, input, 'saveRouteFile');
  if (!authorization.ok) return authorization;
  const record = asRecord(input);
  const content = typeof record.content === 'string' ? record.content : '';
  if (!content.trim()) return { ok: false, error: 'saveRouteFile requires non-empty content.' };
  if (content.length > MAX_ROUTE_CONTENT_LENGTH) {
    return { ok: false, error: `saveRouteFile content is too large; max ${MAX_ROUTE_CONTENT_LENGTH} characters.` };
  }

  const module = await loadCoreModule(config, moduleCache, 'routeValidation');
  const validate = module.validateVerifiedRouteReport;
  if (typeof validate !== 'function') {
    return { ok: false, code: 'MISSING_EXPORT', error: 'routeValidation.validateVerifiedRouteReport is not available.' };
  }
  const validation = validate(context, content);
  if (!validation.ok) return validation;

  const format = normalizeRouteFormat(record.format);
  const outputDir = resolve(readString(record.routeDir) ?? config.routeDir);
  const fileName = buildSafeRouteFileName(
    readString(record.fileName) ?? readString(record.title) ?? 'route',
    format,
  );
  const outputPath = resolve(outputDir, fileName);
  if (!isInsideDirectory(outputPath, outputDir)) {
    return { ok: false, error: 'saveRouteFile resolved outside the configured route output directory.' };
  }

  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, content, 'utf8');
  return {
    ok: true,
    data: {
      path: outputPath,
      fileName,
      bytes: Buffer.byteLength(content, 'utf8'),
      format,
      warnings: validation.warnings ?? [],
    },
  };
}

function firstNonEmptyRecord(records) {
  for (const record of records) {
    if (Object.keys(record).length > 0) return record;
  }
  return {};
}

function checkFileWriteAuthorization(config, input, operation) {
  void config;
  void input;
  void operation;
  return { ok: true };
}

function toToolSchema(tool) {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema,
  };
}

function requireSession(context, toolName) {
  const session = resolveSession(context);
  if (!session) throw new Error(`${toolName} requires a portable session context.`);
  return session;
}

function resolveSession(context) {
  const record = asRecord(context);
  if (record.metadata && typeof record.mergeMetadata === 'function') return record;
  const session = asRecord(record.session);
  if (session.metadata && typeof session.mergeMetadata === 'function') return session;
  return null;
}

function resolveRunner(context) {
  const record = asRecord(context);
  return record.runner ?? asRecord(record.session).runner ?? null;
}

function readSessionDeck(session) {
  const deck = session?.metadata?.currentDeck;
  if (!deck || !Array.isArray(deck.main) || !Array.isArray(deck.extra) || !Array.isArray(deck.side)) return null;
  return cloneDeck(deck);
}

function readFixedOpeningCards(session) {
  const cards = session?.metadata?.fixedOpeningCards;
  return Array.isArray(cards)
    ? cards.map((id) => Number(id)).filter((id) => Number.isSafeInteger(id) && id > 0)
    : [];
}

function checkOneDeckCard(query, index, deckIds, cardsDb, migrations) {
  const direct = readCardId(query) ?? readCardId(asRecord(query).id) ?? readCardId(asRecord(query).cardId) ?? readCardId(asRecord(query).passcode);
  const resolved = direct ? resolveCurrentCardId(direct, cardsDb, migrations.map) : null;
  const id = resolved?.ok ? resolved.id : resolveOpeningEntry(query, cardsDb);
  const card = id === null ? null : cardsDb.getById(id);
  const count = id === null ? 0 : deckIds.filter((deckId) => deckId === id).length;
  return {
    queryIndex: index,
    query,
    migratedFrom: resolved?.ok && resolved.id !== direct ? direct : null,
    foundInDatabase: Boolean(card),
    matchedCards: card ? [{ id: card.id, name: card.name, type: card.type, typeTags: card.typeTags }] : [],
    inCurrentDeck: count > 0,
    totalCopies: count,
    note: card ? (count > 0 ? `Current deck contains ${count} copy/copies.` : `Card is known but not in current deck: ${card.name}`) : `Unknown card: ${String(query)}`,
  };
}

async function migrateLegacySession(context, config, moduleCache) {
  const session = resolveSession(context);
  if (!session) return;
  const deck = readSessionDeck(session);
  const opening = readFixedOpeningCards(session);
  if (!deck && opening.length === 0) return;
  const cardsDb = await openCardsDb(config, moduleCache);
  try {
    const migrations = await loadIdMigrationMap(config);
    if (deck) {
      const migrated = migrateDeckIds(deck, cardsDb, migrations);
      if (!migrated.ok) {
        const error = new Error('Saved session deck contains card IDs that cannot be migrated to the current database.');
        error.code = 'SESSION_DECK_MIGRATION_UNRESOLVED';
        error.data = migrated.report;
        throw error;
      }
      if (migrated.report.applied) session.mergeMetadata({
        currentDeckOriginal: session.metadata.currentDeckOriginal ?? migrated.originalDeck,
        currentDeckOriginalYdk: session.metadata.currentDeckOriginalYdk ?? serializeYdkText(migrated.originalDeck),
        currentDeck: migrated.deck,
        currentDeckMigration: mergeMigrationReports(session.metadata.currentDeckMigration, migrated.report),
        currentDeckMigratedAt: new Date().toISOString(),
        currentDeckUpdatedAt: new Date().toISOString(),
      });
    }
    if (opening.length > 0) {
      const migratedOpening = migrateCardEntries(opening, cardsDb, migrations, 'fixedOpening');
      if (!migratedOpening.ok) throwMigrationError('SESSION_OPENING_MIGRATION_UNRESOLVED', 'Saved session fixed opening contains card IDs that cannot be migrated.', migratedOpening.report);
      if (migratedOpening.report.applied) session.mergeMetadata({
        fixedOpeningOriginal: session.metadata.fixedOpeningOriginal ?? opening,
        fixedOpeningCards: migratedOpening.cards,
        fixedOpeningMigration: mergeMigrationReports(session.metadata.fixedOpeningMigration, migratedOpening.report),
        fixedOpeningUpdatedAt: new Date().toISOString(),
      });
    }
    const currentDeck = readSessionDeck(session);
    const currentOpening = readFixedOpeningCards(session);
    if (currentDeck && currentOpening.length > 0) {
      const availability = checkOpeningAvailability(currentDeck.main, currentOpening);
      if (!availability.ok) throwMigrationError('SESSION_OPENING_NOT_IN_DECK', 'Saved session fixed opening is not available in the migrated main deck.', availability);
    }
  } finally {
    cardsDb.close?.();
  }
}

async function migrateExplicitResetInput(input, config, moduleCache) {
  const record = asRecord(input);
  const deckKeys = ['playerDeck', 'deck', 'opponentDeck'].filter((key) => asDeck(record[key]));
  const openingArrayKeys = ['playerOpeningCards', 'openingCards', 'opponentOpeningCards'].filter((key) => Array.isArray(record[key]));
  const openingStateKeys = ['playerOpening', 'opponentOpening'].filter((key) => hasOpeningState(record[key]));
  if (deckKeys.length === 0 && openingArrayKeys.length === 0 && openingStateKeys.length === 0) return input;
  const cardsDb = await openCardsDb(config, moduleCache);
  try {
    const migrations = await loadIdMigrationMap(config);
    const output = { ...record };
    const reports = [];
    for (const key of deckKeys) {
      const parsed = parseDeckInput({ deck: record[key] }, cardsDb);
      if (!parsed.ok) throwMigrationError('RESET_DECK_INVALID', `${key} is invalid.`, { error: parsed.error });
      const migrated = migrateDeckIds(parsed.deck, cardsDb, migrations, parsed.unknownCards);
      if (!migrated.ok) throwMigrationError('RESET_DECK_MIGRATION_UNRESOLVED', `${key} contains card IDs that cannot be migrated.`, migrated.report);
      output[key] = migrated.deck;
      reports.push(migrated.report);
    }
    for (const key of openingArrayKeys) {
      const migrated = migrateCardEntries(record[key], cardsDb, migrations, key);
      if (!migrated.ok) throwMigrationError('RESET_OPENING_MIGRATION_UNRESOLVED', `${key} contains card IDs that cannot be migrated.`, migrated.report);
      output[key] = migrated.cards;
      reports.push(migrated.report);
    }
    for (const key of openingStateKeys) {
      const opening = asRecord(record[key]);
      const migratedOpening = migrateCardEntries(opening.opening, cardsDb, migrations, `${key}.opening`);
      const migratedRemain = migrateCardEntries(opening.remain, cardsDb, migrations, `${key}.remain`);
      const report = mergeMigrationReports(migratedOpening.report, migratedRemain.report);
      if (!migratedOpening.ok || !migratedRemain.ok) throwMigrationError('RESET_OPENING_MIGRATION_UNRESOLVED', `${key} contains card IDs that cannot be migrated.`, report);
      output[key] = { ...opening, opening: migratedOpening.cards, remain: migratedRemain.cards };
      reports.push(report);
    }
    output.migration = reports.reduce((all, report) => mergeMigrationReports(all, report), {});
    return output;
  } finally {
    cardsDb.close?.();
  }
}

function hasOpeningState(value) {
  const opening = asRecord(value);
  return Array.isArray(opening.opening) && Array.isArray(opening.remain);
}

function resolveInputCard(input, cardsDb, migrations) {
  const record = asRecord(input);
  const direct = readCardId(record.id) ?? readCardId(record.cardId) ?? readCardId(record.passcode);
  if (direct) {
    const resolution = resolveCurrentCardId(direct, cardsDb, migrations.map);
    return resolution.ok
      ? { ok: true, id: resolution.id, report: { applied: resolution.id !== direct, changes: resolution.id !== direct ? [{ oldId: direct, newId: resolution.id, name: resolution.name }] : [] } }
      : { ok: false, error: resolution.reason, report: { unresolved: [{ oldId: direct, reason: resolution.reason, chain: resolution.chain }] } };
  }
  const name = readString(record.cardName) ?? readString(record.name);
  const card = name ? cardsDb.getByName(name) : null;
  return card ? { ok: true, id: card.id, report: { applied: false, changes: [] } } : { ok: false, error: 'editSessionDeck requires a known id, cardId, passcode, cardName, or name.', report: { unresolved: [{ input }] } };
}

function mergeMigrationReports(existing, current) {
  const previous = asRecord(existing);
  return {
    ...current,
    applied: Boolean(previous.applied || current.applied),
    migratedCards: Number(previous.migratedCards ?? 0) + Number(current.migratedCards ?? 0),
    migrations: [...readArray(previous.migrations), ...readArray(current.migrations)],
    changes: [...readArray(previous.changes), ...readArray(current.changes)],
    unresolved: readArray(current.unresolved),
  };
}

function checkOpeningAvailability(mainDeck, openingCards) {
  const missing = [];
  const counts = countCopies(mainDeck);
  for (const [id, requested] of countCopies(openingCards)) {
    const available = counts.get(id) ?? 0;
    if (available < requested) missing.push({ id, requested, available });
  }
  return { ok: missing.length === 0, missing };
}

function countCopies(cards) {
  const counts = new Map();
  for (const id of cards) counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
}

function resolveOpeningEntry(entry, cardsDb) {
  const direct = readCardId(entry);
  if (direct !== null) return direct;
  const record = asRecord(entry);
  const objectId = readCardId(record.id) ?? readCardId(record.cardId) ?? readCardId(record.passcode);
  if (objectId !== null) return objectId;
  const name = readString(entry) ?? readString(record.name) ?? readString(record.cardName);
  if (!name) return null;
  return cardsDb.getByName(name)?.id ?? null;
}

function resolveCardId(input, cardsDb) {
  const record = asRecord(input);
  return readCardId(record.id) ?? readCardId(record.cardId) ?? readCardId(record.passcode) ??
    (readString(record.cardName) || readString(record.name) ? cardsDb.getByName(readString(record.cardName) ?? readString(record.name))?.id ?? null : null);
}

function readArray(value) {
  return Array.isArray(value) ? value : [];
}

function readCardId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

function readString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function readNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function asDeck(value) {
  const deck = asRecord(value);
  if (!Array.isArray(deck.main)) return null;
  return {
    main: deck.main.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0),
    extra: Array.isArray(deck.extra) ? deck.extra.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0) : [],
    side: Array.isArray(deck.side) ? deck.side.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0) : [],
  };
}

function asOpening(value) {
  const opening = asRecord(value);
  if (!Array.isArray(opening.opening) || !Array.isArray(opening.remain)) return null;
  return {
    opening: opening.opening.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0),
    remain: opening.remain.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0),
    ...(readString(opening.label) ? { label: readString(opening.label) } : {}),
  };
}

function normalizeSection(value) {
  const section = readString(value)?.toLowerCase();
  return section === 'main' || section === 'extra' || section === 'side' ? section : null;
}

function cloneDeck(deck) {
  return {
    main: Array.isArray(deck.main) ? deck.main.slice() : [],
    extra: Array.isArray(deck.extra) ? deck.extra.slice() : [],
    side: Array.isArray(deck.side) ? deck.side.slice() : [],
  };
}

function countDeck(deck) {
  const normalized = cloneDeck(deck);
  return {
    main: normalized.main.length,
    extra: normalized.extra.length,
    side: normalized.side.length,
    total: normalized.main.length + normalized.extra.length + normalized.side.length,
  };
}

function createPortableReplayExportApi(config) {
  const require = createRequire(pathToFileURL(resolve(config.runtimeRoot, 'src', 'tools', 'replay-tools.js')));
  const { createReplayExportApi } = require(resolve(config.runtimeRoot, 'src', 'replay', 'replay-export.cjs'));
  const { requireOptionalSkillDependency } = require(resolve(config.runtimeRoot, 'src', 'vendor-require.cjs'));
  return createReplayExportApi({
    Buffer,
    CURRENT_DUEL_OPTIONS,
    makeXorshift32,
    getYgoproYrp: () => safeRequireYgoproYrp(requireOptionalSkillDependency),
  });
}

function safeRequireYgoproYrp(requireOptionalSkillDependency) {
  return requireOptionalSkillDependency('ygopro-yrp-encode');
}

async function inspectSavedReplay(config, replayPath) {
  const require = createRequire(pathToFileURL(resolve(config.runtimeRoot, 'src', 'tools', 'replay-tools.js')));
  const { requireOptionalSkillDependency } = require(resolve(config.runtimeRoot, 'src', 'vendor-require.cjs'));
  const ygoproYrp = safeRequireYgoproYrp(requireOptionalSkillDependency);
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
        ? replay.responses.map((response) => Buffer.from(response).toString('hex'))
        : [],
    };
  } catch (error) {
    return { ok: false, error: formatError(error) };
  }
}

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
  session.mergeMetadata({ savedReplayYrps: replays });
}

function buildSafeReplayFileName(rawName) {
  const base = rawName
    .replace(/\.yrp$/i, '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'agent-replay';
  return `${base}.yrp`;
}

function buildSafeRouteFileName(rawName, format) {
  const extension = format === 'json' ? '.json' : format === 'txt' ? '.txt' : '.md';
  const base = rawName
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'route';
  return base.toLowerCase().endsWith(extension) ? base : `${base}${extension}`;
}

function isInsideDirectory(targetPath, directory) {
  const normalizedDirectory = normalizePathForComparison(directory);
  const normalizedTarget = normalizePathForComparison(targetPath);
  return normalizedTarget === normalizedDirectory || normalizedTarget.startsWith(`${normalizedDirectory}/`);
}

function normalizePathForComparison(targetPath) {
  return resolve(targetPath).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function normalizeRouteFormat(value) {
  const format = readString(value)?.toLowerCase();
  if (format === 'json' || format === 'txt') return format;
  return 'markdown';
}

function normalizeYrpVersion(value) {
  const version = Number(value);
  if (version === 1 || version === 2) return version;
  return null;
}

function normalizeUInt32(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.trunc(number) >>> 0;
}

function normalizeNonNegativeInteger(value) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function normalizeUInt32List(value) {
  return Array.isArray(value)
    ? value.map((entry) => normalizeUInt32(entry)).filter((entry) => entry !== null)
    : [];
}

function normalizeReplayDeck(value) {
  const record = asRecord(value);
  return {
    main: normalizeUInt32List(record.main),
    extra: normalizeUInt32List(record.extra),
    side: normalizeUInt32List(record.side),
  };
}

function shouldApplyOpponentDeckFallback(deck, drawCount) {
  return deck.main.length < Math.max(1, drawCount) || deck.main.length < MIN_REPLAY_OPPONENT_MAIN_DECK_SIZE;
}

function normalizeOpening(value) {
  const opening = asRecord(value);
  return {
    opening: normalizeUInt32List(opening.opening),
    remain: normalizeUInt32List(opening.remain),
    label: readString(opening.label),
  };
}

function readOpeningLength(value) {
  const opening = asRecord(value).opening;
  return Array.isArray(opening) ? opening.length : null;
}

function readPendingDecision(value) {
  const decision = asRecord(value);
  if (!decision || decision.terminal === true) return null;
  const actions = Array.isArray(decision.actions) ? decision.actions : [];
  if (actions.length === 0) return null;
  return {
    name: readString(decision.messageName) ??
      readString(asRecord(asRecord(decision.message).constructor).name) ??
      readString(decision.name) ??
      readString(decision.reason) ??
      'unknown',
    actions: actions.map((action, index) => ({
      index,
      label: readString(asRecord(action).label) ?? `Action #${index}`,
      kind: readString(asRecord(action).kind) ?? '',
    })),
  };
}

function makeXorshift32(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
