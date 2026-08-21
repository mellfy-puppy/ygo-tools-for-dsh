// @ts-check

import { formatCurrentState } from './state-tools.js';

const MAX_SIMULATION_ACTIONS = 50;
const DEFAULT_ACTION_SUMMARY_LIMIT = 100;

/** @typedef {{ index: number, label: string, kind: string, description?: string }} ExecutedActionSummary */
/** @typedef {{ label?: unknown, kind?: unknown, text?: unknown, response?: unknown, intResponse?: unknown }} RawAction */
/** @typedef {{ main: number[], extra: number[], side: number[] }} ParsedDeck */
/** @typedef {{ opening: number[], remain: number[], label?: string }} OpeningState */
/** @typedef {{ currentDecision?: unknown, step: (action: unknown) => unknown, captureSnapshot?: () => unknown, saveState?: (reason?: string) => unknown, restoreState?: (state: unknown) => unknown, init?: () => unknown, reset?: (options?: unknown) => unknown, destroyDuel?: () => unknown, clearStatePool?: () => unknown, clearNativeSnapshotPool?: () => unknown, setActionHistory?: (history: unknown[], historyKey?: string) => unknown, actionHistory?: unknown, seed?: unknown, seedSequence?: unknown, yrpVersion?: unknown, drawCount?: unknown, playerDeck?: unknown, opponentDeck?: unknown, playerOpening?: unknown, opponentOpening?: unknown, playerDeckInstances?: unknown, cardText?: unknown } & Record<string, unknown>} ActionRunner */
/** @typedef {{ actionLabel?: string, label?: string, actionIndex?: number, index?: number, selectionIndexes?: number[], graveyardLimit?: number, includeDescriptions?: boolean }} ExecuteActionOptions */
/** @typedef {{ executedAction: ExecutedActionSummary, nextDecision: { terminal: boolean, reason: string | null, decision: string | null, actionCount: number, actions: ExecutedActionSummary[], truncated: boolean }, state: import('./state-tools.js').CurrentStateSummary | null, historyLength: { before: number | null, after: number | null } }} ExecuteActionSummary */
/** @typedef {{ ok: true, data: ExecuteActionSummary } | { ok: false, error: string, availableActions?: ExecutedActionSummary[], matchingIndexes?: number[], restored?: boolean, fatal?: boolean, requiresReset?: boolean, errorType?: string, retryAttempted?: boolean, retrySkippedReason?: string }} ExecuteActionResult */
/** @typedef {{ actionLabel?: string, label?: string, actionIndex?: number, index?: number }} SimulatedActionObject */
/** @typedef {string | number | SimulatedActionObject} SimulatedActionInput */
/** @typedef {{ actionLabels?: SimulatedActionInput[], actions?: SimulatedActionInput[], graveyardLimit?: number }} SimulateActionsOptions */
/** @typedef {{ actionLabel: string | null, actionIndex: number | null }} NormalizedActionRequest */
/** @typedef {{ step: number, actionRequest: NormalizedActionRequest, executedAction: ExecutedActionSummary, nextDecision: ExecuteActionSummary['nextDecision'], state: import('./state-tools.js').CurrentStateSummary | null, historyLength: { before: number | null, after: number | null } }} SimulatedActionStep */
/** @typedef {{ steps: SimulatedActionStep[], simulatedActions: number, restored: boolean }} SimulateActionsSummary */
/** @typedef {{ ok: true, data: SimulateActionsSummary } | { ok: false, error: string, steps?: SimulatedActionStep[], failedStep?: number, availableActions?: ExecutedActionSummary[], matchingIndexes?: number[], restored?: boolean, restoreError?: string }} SimulateActionsResult */
/** @typedef {{ seed?: number | string, deck?: unknown, playerDeck?: unknown, opponentDeck?: unknown, drawCount?: number | string, openingCards?: unknown, playerOpeningCards?: unknown, opponentOpeningCards?: unknown, playerOpening?: unknown, opponentOpening?: unknown, graveyardLimit?: number }} ResetGameOptions */
/** @typedef {{ seed: number | undefined, seedProvided: boolean, drawCount: number | undefined, drawCountForcedByFixedOpening: boolean, deckProvided: boolean, playerDeck: ParsedDeck | undefined, opponentDeck: ParsedDeck | undefined, playerOpening: OpeningState | undefined, opponentOpening: OpeningState | undefined, playerOpeningCards: number[] | undefined, opponentOpeningCards: number[] | undefined, graveyardLimit: number | undefined }} NormalizedResetInput */
/** @typedef {{ state: import('./state-tools.js').CurrentStateSummary | null, nextDecision: ExecuteActionSummary['nextDecision'], seed: number | null, deck: { playerMain: number | null, playerExtra: number | null, opponentMain: number | null, opponentExtra: number | null }, historyLength: number | null, applied: { seed: boolean, deck: boolean, opening: boolean, drawCount: boolean, drawCountForcedByFixedOpening: boolean } }} ResetGameSummary */
/** @typedef {{ ok: true, data: ResetGameSummary } | { ok: false, error: string }} ResetGameResult */

/**
 * Execute one currently available runner action by label or index.
 *
 * @param {unknown} runnerOrContext Runner instance, or an object with a `runner` property.
 * @param {ExecuteActionOptions | string | number} [options]
 * @returns {ExecuteActionResult}
 */
export function executeAction(runnerOrContext, options = {}) {
  const runner = resolveRunner(runnerOrContext);
  if (!runner) {
    return { ok: false, error: 'executeAction requires a runner with currentDecision.actions and step(action).' };
  }

  const input = normalizeExecuteInput(runnerOrContext, options);
  if (!input.actionLabel && input.actionIndex === null && input.selectionIndexes === null) {
    return { ok: false, error: 'executeAction requires actionLabel, actionIndex, or selectionIndexes.' };
  }

  const currentDecision = asRecord(runner.currentDecision);
  if (Boolean(currentDecision.terminal)) {
    return { ok: false, error: `Cannot execute action because the current decision is terminal: ${readString(currentDecision.reason) ?? 'terminal'}.` };
  }

  const rawActions = arrayValue(currentDecision.actions);
  if (currentDecision.factorizedSelection === true && input.selectionIndexes === null) {
    const requested = selectAction(rawActions, input);
    if (!requested.ok || readString(asRecord(requested.action).kind) === 'factorized_select_card_candidate') {
      return {
        ok: false,
        error: 'This multi-card decision is factorized. Call executeAction with selectionIndexes from listActions; only explicit cancel/default actions may still be executed by label or actionIndex.',
        selectionConstraints: asRecord(currentDecision.selectionConstraints),
        availableActions: summarizeActions(rawActions),
      };
    }
  }
  const factorizedAction = input.selectionIndexes
    ? buildFactorizedSelectionAction(currentDecision, input.selectionIndexes)
    : null;
  if (factorizedAction && !factorizedAction.ok) return factorizedAction;
  if (rawActions.length === 0) {
    return { ok: false, error: 'Cannot execute action because there are no available actions.' };
  }

  const selection = factorizedAction?.ok
    ? { ok: true, action: factorizedAction.action, index: -1 }
    : selectAction(rawActions, input);
  if (!selection.ok) {
    return {
      ok: false,
      error: selection.error,
      availableActions: summarizeActions(rawActions),
      matchingIndexes: selection.matchingIndexes,
    };
  }

  const historyBefore = readHistoryLength(runner);
  const rollbackState = saveRollbackState(runner);
  const stateBefore = captureComparableState(runner, input.graveyardLimit);
  try {
    runner.step(selection.action);
    const nextDecision = asRecord(runner.currentDecision);
    const state = captureFormattedState(runner, input.graveyardLimit);
    const rejected = detectRejectedNoProgressAction(selection.action, nextDecision, stateBefore, state);
    if (rejected) {
      const rollback = restoreRollbackState(runner, rollbackState);
      return {
        ok: false,
        error: `${rejected} The action was rolled back; inspect listActions/getCurrentState and choose another legal branch.`,
        availableActions: summarizeActions(rawActions),
        ...(rollback ? { restored: true } : { restored: false }),
      };
    }

    return {
      ok: true,
      data: {
        executedAction: formatActionSummary(selection.action, selection.index, input.includeDescriptions),
        nextDecision: summarizeDecision(nextDecision, input.includeDescriptions),
        state,
        historyLength: {
          before: historyBefore,
          after: readHistoryLength(runner),
        },
      },
    };
  } catch (error) {
    const rollback = restoreRollbackState(runner, rollbackState);
    const message = error instanceof Error ? error.message : String(error);
    const classification = classifyActionFailure(message);
    return {
      ok: false,
      error: [
        message,
        classification.note,
        `The action failed and ${rollback ? 'was rolled back to the pre-action state' : 'could not be rolled back automatically'}.`,
        classification.fatal
          ? 'The duel runner is considered unsafe for further live actions in this chat turn; resetGame or restore a checkpoint before continuing.'
          : 'Inspect getCurrentState/listActions or restore a checkpoint before trying another branch.',
      ].filter(Boolean).join(' '),
      availableActions: summarizeActions(rawActions),
      restored: rollback,
      fatal: classification.fatal,
      requiresReset: classification.requiresReset,
      errorType: classification.errorType,
      retryAttempted: false,
      retrySkippedReason: classification.fatal
        ? 'fatal_engine_error_after_runner_internal_retry'
        : 'executeAction_rolled_back_without_replaying_the_failed_mutation',
    };
  }
}

/**
 * Simulate a sequence of currently available runner actions without leaving state changes behind.
 *
 * @param {unknown} runnerOrContext Runner instance, or an object with a `runner` property.
 * @param {SimulateActionsOptions | SimulatedActionInput[]} [options]
 * @returns {SimulateActionsResult}
 */
export function simulateActions(runnerOrContext, options = {}) {
  const runner = resolveRunner(runnerOrContext);
  if (!runner) {
    return { ok: false, error: 'simulateActions requires a runner with currentDecision.actions and step(action).' };
  }

  if (typeof runner.saveState !== 'function' || typeof runner.restoreState !== 'function') {
    return { ok: false, error: 'simulateActions requires runner.saveState() and runner.restoreState(state).' };
  }

  if (typeof runner.captureSnapshot !== 'function') {
    return { ok: false, error: 'simulateActions requires runner.captureSnapshot().' };
  }

  const input = normalizeSimulationInput(runnerOrContext, options);
  if (!input.ok) return { ok: false, error: input.error };

  let savedState;
  try {
    savedState = runner.saveState('agent.simulateActions');
  } catch (error) {
    return {
      ok: false,
      error: `Failed to save current state before simulation: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  /** @type {SimulatedActionStep[]} */
  const steps = [];
  /** @type {Omit<Extract<SimulateActionsResult, { ok: false }>, 'steps' | 'restored' | 'restoreError'> | null} */
  let failure = null;
  let restored = false;
  let restoreError = null;

  try {
    for (let stepIndex = 0; stepIndex < input.actions.length; stepIndex += 1) {
      const actionRequest = input.actions[stepIndex];
      const currentDecision = asRecord(runner.currentDecision);
      if (Boolean(currentDecision.terminal)) {
        failure = {
          ok: false,
          error: `Simulation stopped before step ${stepIndex + 1} because the current decision is terminal: ${readString(currentDecision.reason) ?? 'terminal'}.`,
          failedStep: stepIndex + 1,
        };
        break;
      }

      const rawActions = arrayValue(currentDecision.actions);
      if (rawActions.length === 0) {
        failure = {
          ok: false,
          error: `Simulation stopped before step ${stepIndex + 1} because there are no available actions.`,
          failedStep: stepIndex + 1,
        };
        break;
      }

      const selection = selectAction(rawActions, actionRequest);
      if (!selection.ok) {
        failure = {
          ok: false,
          error: `Simulation stopped at step ${stepIndex + 1}: ${selection.error}`,
          failedStep: stepIndex + 1,
          availableActions: summarizeActions(rawActions),
          matchingIndexes: selection.matchingIndexes,
        };
        break;
      }

      const historyBefore = readHistoryLength(runner);
      try {
        const stateBefore = captureComparableState(runner, input.graveyardLimit);
        runner.step(selection.action);
        const snapshot = runner.captureSnapshot();
        const nextDecision = asRecord(runner.currentDecision);
        const state = formatSimulationState(runner, snapshot, input.graveyardLimit);

        const simulatedStep = {
          step: stepIndex + 1,
          actionRequest,
          executedAction: formatActionSummary(selection.action, selection.index),
          nextDecision: summarizeDecision(nextDecision),
          state,
          historyLength: {
            before: historyBefore,
            after: readHistoryLength(runner),
          },
        };
        steps.push(simulatedStep);

        const rejected = detectRejectedNoProgressAction(selection.action, nextDecision, stateBefore, state);
        if (rejected) {
          failure = {
            ok: false,
            error: `Simulation stopped at step ${stepIndex + 1}: ${rejected}`,
            failedStep: stepIndex + 1,
            availableActions: summarizeActions(rawActions),
          };
          break;
        }
      } catch (error) {
        failure = {
          ok: false,
          error: `Simulation failed at step ${stepIndex + 1}: ${error instanceof Error ? error.message : String(error)}`,
          failedStep: stepIndex + 1,
          availableActions: summarizeActions(rawActions),
        };
        break;
      }
    }
  } finally {
    try {
      runner.restoreState(savedState);
      restored = true;
    } catch (error) {
      restoreError = error instanceof Error ? error.message : String(error);
    }
  }

  if (restoreError) {
    return {
      ok: false,
      error: `Simulation ended but failed to restore the original state: ${restoreError}`,
      steps,
      restored,
      restoreError,
      ...(failure?.failedStep ? { failedStep: failure.failedStep } : {}),
    };
  }

  if (failure) {
    return {
      ...failure,
      steps,
      restored,
    };
  }

  return {
    ok: true,
    data: {
      steps,
      simulatedActions: steps.length,
      restored,
    },
  };
}

/**
 * Reset the duel runner to an initial state, optionally changing seed and deck.
 *
 * @param {unknown} runnerOrContext Runner instance, or an object with a `runner` property.
 * @param {ResetGameOptions} [options]
 * @returns {ResetGameResult}
 */
export function resetGame(runnerOrContext, options = {}) {
  const runner = resolveRunner(runnerOrContext);
  if (!runner) {
    return { ok: false, error: 'resetGame requires a runner with currentDecision and step(action).' };
  }

  if (typeof runner.captureSnapshot !== 'function') {
    return { ok: false, error: 'resetGame requires runner.captureSnapshot().' };
  }

  const input = normalizeResetInput(runnerOrContext, options);
  if (!input.ok) return { ok: false, error: input.error };
  const hasFixedOpeningRequest = input.data.playerOpeningCards !== undefined ||
    input.data.playerOpening !== undefined;

  const originalConfig = captureRunnerResetConfig(runner);
  try {
    let resetRunner = runner;
    if (typeof runner.reset === 'function') {
      const resetResult = runner.reset(buildRunnerResetOptions(input.data));
      if (isPromiseLike(resetResult)) {
        return { ok: false, error: 'resetGame does not support async runner.reset(); reset the session runner before calling this tool.' };
      }
      resetRunner = resolveRunner(resetResult) ?? resolveRunner(asRecord(resetResult).runner) ?? runner;
    } else if (typeof runner.init === 'function') {
      applyResetInputToRunner(runner, input.data);
      clearRunnerForReset(runner);
      runner.init();
    } else {
      return { ok: false, error: 'resetGame requires runner.init() or runner.reset(options).' };
    }

    const summary = buildResetGameSummary(resetRunner, input.data);
    return {
      ok: true,
      data: summary,
    };
  } catch (error) {
    restoreRunnerResetConfig(runner, originalConfig);
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: hasFixedOpeningRequest
        ? `${message} Fixed opening reset failed; do not clear the fixed opening or retry with a random seed unless the user explicitly asks.`
        : message,
    };
  }
}

/**
 * @param {unknown} value
 * @returns {ActionRunner | null}
 */
function resolveRunner(value) {
  const record = asRecord(value);
  if (typeof record.step === 'function' && 'currentDecision' in record) {
    return /** @type {ActionRunner} */ (record);
  }

  const nested = asRecord(record.runner);
  if (typeof nested.step === 'function' && 'currentDecision' in nested) {
    return /** @type {ActionRunner} */ (nested);
  }

  return null;
}

/**
 * @param {unknown} runnerOrContext
 * @param {unknown} options
 * @returns {{ actionLabel: string | null, actionIndex: number | null, selectionIndexes: number[] | null, graveyardLimit: number | undefined, includeDescriptions: boolean }}
 */
function normalizeExecuteInput(runnerOrContext, options) {
  const second = asRecord(options);
  const directLabel = typeof options === 'string'
    ? options
    : typeof runnerOrContext === 'string'
      ? runnerOrContext
      : null;
  const directIndex = typeof options === 'number'
    ? options
    : typeof runnerOrContext === 'number'
      ? runnerOrContext
      : null;

  return {
    actionLabel: readString(second.actionLabel) ??
      readString(second.label) ??
      readString(directLabel),
    actionIndex: readIndex(second.actionIndex) ??
      readIndex(second.index) ??
      readIndex(directIndex),
    selectionIndexes: normalizeSelectionIndexes(second.selectionIndexes),
    graveyardLimit: normalizeOptionalPositiveInteger(second.graveyardLimit),
    includeDescriptions: second.includeDescriptions === true,
  };
}

/**
 * @param {unknown} runnerOrContext
 * @param {unknown} options
 * @returns {{ ok: true, actions: NormalizedActionRequest[], graveyardLimit: number | undefined } | { ok: false, error: string }}
 */
function normalizeSimulationInput(runnerOrContext, options) {
  const context = asRecord(runnerOrContext);
  const optionRecord = asRecord(options);
  const rawActions = Array.isArray(options)
    ? options
    : readActionInputArray(optionRecord, 'actionLabels') ??
      readActionInputArray(optionRecord, 'actions') ??
      readActionInputArray(context, 'actionLabels') ??
      readActionInputArray(context, 'actions') ??
      [];

  if (rawActions.length === 0) {
    return { ok: false, error: 'simulateActions requires a non-empty actionLabels array.' };
  }

  if (rawActions.length > MAX_SIMULATION_ACTIONS) {
    return { ok: false, error: `simulateActions supports at most ${MAX_SIMULATION_ACTIONS} actions per call.` };
  }

  /** @type {NormalizedActionRequest[]} */
  const actions = [];
  for (let index = 0; index < rawActions.length; index += 1) {
    const normalized = normalizeSimulationAction(rawActions[index]);
    if (!normalized) {
      return { ok: false, error: `Invalid action at actionLabels[${index}]. Use a label string, an index number, or an object with actionLabel/actionIndex.` };
    }
    actions.push(normalized);
  }

  return {
    ok: true,
    actions,
    graveyardLimit: normalizeOptionalPositiveInteger(optionRecord.graveyardLimit ?? context.graveyardLimit),
  };
}

/**
 * @param {Record<string, unknown>} record
 * @param {'actionLabels' | 'actions'} key
 * @returns {unknown[] | null}
 */
function readActionInputArray(record, key) {
  return Array.isArray(record[key]) ? record[key] : null;
}

/**
 * @param {unknown} value
 * @returns {NormalizedActionRequest | null}
 */
function normalizeSimulationAction(value) {
  if (typeof value === 'string') {
    const actionLabel = readString(value);
    return actionLabel ? { actionLabel, actionIndex: null } : null;
  }

  if (typeof value === 'number') {
    const actionIndex = readIndex(value);
    return actionIndex === null ? null : { actionLabel: null, actionIndex };
  }

  const record = asRecord(value);
  if (Object.keys(record).length === 0) return null;

  const actionLabel = readString(record.actionLabel) ?? readString(record.label);
  const actionIndex = readIndex(record.actionIndex) ?? readIndex(record.index);
  if (!actionLabel && actionIndex === null) return null;
  return { actionLabel, actionIndex };
}

/**
 * @param {unknown} runnerOrContext
 * @param {unknown} options
 * @returns {{ ok: true, data: NormalizedResetInput } | { ok: false, error: string }}
 */
function normalizeResetInput(runnerOrContext, options) {
  const optionRecord = asRecord(options);
  const contextRecord = asRecord(runnerOrContext);
  const readContext = resolveRunner(runnerOrContext) !== runnerOrContext;

  const seedRaw = readOptionValue(optionRecord, contextRecord, 'seed', readContext);
  const seed = normalizeOptionalSeed(seedRaw);
  if (seedRaw !== undefined && seed === null) {
    return { ok: false, error: 'resetGame seed must be a finite unsigned 32-bit integer.' };
  }

  const drawCountRaw = readOptionValue(optionRecord, contextRecord, 'drawCount', readContext);
  const drawCount = normalizeOptionalPositiveInteger(drawCountRaw);
  if (drawCountRaw !== undefined && drawCount === undefined) {
    return { ok: false, error: 'resetGame drawCount must be a positive integer.' };
  }

  const deckRaw = readOptionValue(optionRecord, contextRecord, 'deck', readContext);
  const playerDeckRaw = readOptionValue(optionRecord, contextRecord, 'playerDeck', readContext) ?? deckRaw;
  const opponentDeckRaw = readOptionValue(optionRecord, contextRecord, 'opponentDeck', readContext) ?? deckRaw;
  const playerDeck = normalizeDeckInput(playerDeckRaw, 'playerDeck');
  if (!playerDeck.ok) return { ok: false, error: playerDeck.error };
  const opponentDeck = normalizeDeckInput(opponentDeckRaw, 'opponentDeck');
  if (!opponentDeck.ok) return { ok: false, error: opponentDeck.error };

  const openingCardsRaw =
    readOptionValue(optionRecord, contextRecord, 'openingCards', readContext);
  const playerOpeningCards = normalizeOptionalCardCodeArray(
    readOptionValue(optionRecord, contextRecord, 'playerOpeningCards', readContext) ?? openingCardsRaw,
    'playerOpeningCards',
  );
  if (!playerOpeningCards.ok) return { ok: false, error: playerOpeningCards.error };
  const opponentOpeningCards = normalizeOptionalCardCodeArray(
    readOptionValue(optionRecord, contextRecord, 'opponentOpeningCards', readContext),
    'opponentOpeningCards',
  );
  if (!opponentOpeningCards.ok) return { ok: false, error: opponentOpeningCards.error };

  const playerOpening = normalizeOpeningInput(
    readOptionValue(optionRecord, contextRecord, 'playerOpening', readContext),
    'playerOpening',
  );
  if (!playerOpening.ok) return { ok: false, error: playerOpening.error };
  const opponentOpening = normalizeOpeningInput(
    readOptionValue(optionRecord, contextRecord, 'opponentOpening', readContext),
    'opponentOpening',
  );
  if (!opponentOpening.ok) return { ok: false, error: opponentOpening.error };
  const fixedPlayerOpeningCount = readOpeningCardCount(playerOpening.value, playerOpeningCards.value);
  const effectiveDrawCount = fixedPlayerOpeningCount ?? drawCount;

  return {
    ok: true,
    data: {
      seed: seed ?? undefined,
      seedProvided: seedRaw !== undefined,
      drawCount: effectiveDrawCount,
      drawCountForcedByFixedOpening: fixedPlayerOpeningCount !== null,
      deckProvided: deckRaw !== undefined || playerDeckRaw !== undefined || opponentDeckRaw !== undefined,
      playerDeck: playerDeck.value,
      opponentDeck: opponentDeck.value,
      playerOpening: playerOpening.value,
      opponentOpening: opponentOpening.value,
      playerOpeningCards: playerOpeningCards.value,
      opponentOpeningCards: opponentOpeningCards.value,
      graveyardLimit: normalizeOptionalPositiveInteger(readOptionValue(optionRecord, contextRecord, 'graveyardLimit', readContext)),
    },
  };
}

/**
 * @param {Record<string, unknown>} options
 * @param {Record<string, unknown>} context
 * @param {string} key
 * @param {boolean} readContext
 */
function readOptionValue(options, context, key, readContext) {
  if (Object.prototype.hasOwnProperty.call(options, key)) return options[key];
  if (readContext && Object.prototype.hasOwnProperty.call(context, key)) return context[key];
  return undefined;
}

/**
 * @param {OpeningState | undefined} opening
 * @param {number[] | undefined} fixedCards
 */
function readOpeningCardCount(opening, fixedCards) {
  if (fixedCards !== undefined) return fixedCards.length;
  if (opening && Array.isArray(opening.opening)) return opening.opening.length;
  return null;
}

/**
 * @param {unknown} value
 * @param {string} fieldName
 * @returns {{ ok: true, value: ParsedDeck | undefined } | { ok: false, error: string }}
 */
function normalizeDeckInput(value, fieldName) {
  if (value === undefined || value === null || value === '') {
    return { ok: true, value: undefined };
  }

  if (Array.isArray(value)) {
    const main = normalizeCardCodeArray(value, fieldName);
    if (!main.ok) return main;
    return { ok: true, value: { main: main.value, extra: [], side: [] } };
  }

  const record = asRecord(value);
  if (!Array.isArray(record.main)) {
    return { ok: false, error: `resetGame ${fieldName} must be a parsed deck object with a main array, or a main deck array.` };
  }

  const main = normalizeCardCodeArray(record.main, `${fieldName}.main`);
  if (!main.ok) return main;
  const extra = normalizeCardCodeArray(arrayValue(record.extra), `${fieldName}.extra`);
  if (!extra.ok) return extra;
  const side = normalizeCardCodeArray(arrayValue(record.side), `${fieldName}.side`);
  if (!side.ok) return side;

  return { ok: true, value: { main: main.value, extra: extra.value, side: side.value } };
}

/**
 * @param {unknown} value
 * @param {string} fieldName
 * @returns {{ ok: true, value: number[] | undefined } | { ok: false, error: string }}
 */
function normalizeOptionalCardCodeArray(value, fieldName) {
  if (value === undefined || value === null || value === '') return { ok: true, value: undefined };
  if (!Array.isArray(value)) return { ok: false, error: `resetGame ${fieldName} must be an array of card codes.` };
  return normalizeCardCodeArray(value, fieldName);
}

/**
 * @param {unknown[]} values
 * @param {string} fieldName
 * @returns {{ ok: true, value: number[] } | { ok: false, error: string }}
 */
function normalizeCardCodeArray(values, fieldName) {
  /** @type {number[]} */
  const codes = [];
  for (let index = 0; index < values.length; index += 1) {
    const code = normalizeCardCode(values[index]);
    if (code === null) {
      return { ok: false, error: `resetGame ${fieldName}[${index}] must be a positive integer card code.` };
    }
    codes.push(code);
  }
  return { ok: true, value: codes };
}

/**
 * @param {unknown} value
 * @param {string} fieldName
 * @returns {{ ok: true, value: OpeningState | undefined } | { ok: false, error: string }}
 */
function normalizeOpeningInput(value, fieldName) {
  if (value === undefined || value === null || value === '') return { ok: true, value: undefined };
  const record = asRecord(value);
  if (!Array.isArray(record.opening) || !Array.isArray(record.remain)) {
    return { ok: false, error: `resetGame ${fieldName} must contain opening and remain arrays.` };
  }

  const opening = normalizeCardCodeArray(record.opening, `${fieldName}.opening`);
  if (!opening.ok) return opening;
  const remain = normalizeCardCodeArray(record.remain, `${fieldName}.remain`);
  if (!remain.ok) return remain;
  return {
    ok: true,
    value: {
      opening: opening.value,
      remain: remain.value,
      ...(readString(record.label) ? { label: readString(record.label) ?? undefined } : {}),
    },
  };
}

/**
 * @param {unknown[]} actions
 * @param {{ actionLabel: string | null, actionIndex: number | null }} input
 * @returns {{ ok: true, action: unknown, index: number } | { ok: false, error: string, matchingIndexes?: number[] }}
 */
function selectAction(actions, input) {
  if (input.actionIndex !== null) {
    if (input.actionIndex < 0 || input.actionIndex >= actions.length) {
      return {
        ok: false,
        error: `Action index ${input.actionIndex} is out of range. Available indexes: 0-${actions.length - 1}.`,
      };
    }
    return { ok: true, action: actions[input.actionIndex], index: input.actionIndex };
  }

  const label = input.actionLabel ?? '';
  const exactIndexes = matchingActionIndexes(actions, label, 'exact');
  if (exactIndexes.length === 1) return { ok: true, action: actions[exactIndexes[0]], index: exactIndexes[0] };
  if (exactIndexes.length > 1) {
    return {
      ok: false,
      error: `Action label "${label}" matches multiple actions. Use actionIndex to disambiguate.`,
      matchingIndexes: exactIndexes,
    };
  }

  const normalizedIndexes = matchingActionIndexes(actions, label, 'normalized');
  if (normalizedIndexes.length === 1) return { ok: true, action: actions[normalizedIndexes[0]], index: normalizedIndexes[0] };
  if (normalizedIndexes.length > 1) {
    return {
      ok: false,
      error: `Action label "${label}" matches multiple normalized actions. Use actionIndex to disambiguate.`,
      matchingIndexes: normalizedIndexes,
    };
  }

  const containsIndexes = matchingActionIndexes(actions, label, 'contains');
  if (containsIndexes.length === 1) return { ok: true, action: actions[containsIndexes[0]], index: containsIndexes[0] };
  if (containsIndexes.length > 1) {
    return {
      ok: false,
      error: `Action label "${label}" partially matches multiple actions. Use the exact label or actionIndex.`,
      matchingIndexes: containsIndexes,
    };
  }

  return { ok: false, error: `Action not found: ${label}.` };
}

/**
 * @param {unknown[]} actions
 * @param {string} label
 * @param {'exact' | 'normalized' | 'contains'} mode
 */
function matchingActionIndexes(actions, label, mode) {
  const normalizedLabel = normalizeLabel(label);
  /** @type {number[]} */
  const indexes = [];

  actions.forEach((action, index) => {
    const actionLabel = readString(asRecord(action).label) ?? '';
    const normalizedActionLabel = normalizeLabel(actionLabel);
    const matches = mode === 'exact'
      ? actionLabel === label
      : mode === 'normalized'
        ? normalizedActionLabel === normalizedLabel
        : normalizedActionLabel.includes(normalizedLabel);
    if (matches) indexes.push(index);
  });

  return indexes;
}

/**
 * @param {Record<string, unknown>} decision
 */
function summarizeDecision(decision, includeDescriptions = false) {
  const actions = arrayValue(decision.actions);
  const returnedActions = actions.slice(0, DEFAULT_ACTION_SUMMARY_LIMIT);
  return {
    terminal: Boolean(decision.terminal),
    reason: readString(decision.reason),
    decision: getDecisionName(decision),
    actionCount: actions.length,
    actions: returnedActions.map((action, index) => formatActionSummary(action, index, includeDescriptions)),
    truncated: returnedActions.length < actions.length,
    factorizedSelection: decision.factorizedSelection === true,
    estimatedLegalCandidateCount: readOptionalNumber(decision.estimatedLegalCandidateCount),
    selectionConstraints: asRecord(decision.selectionConstraints),
  };
}

/**
 * @param {unknown[]} actions
 * @param {number | undefined} [_limit]
 */
function summarizeActions(actions, limit = DEFAULT_ACTION_SUMMARY_LIMIT) {
  return actions.slice(0, limit).map((action, index) => formatActionSummary(action, index));
}

/**
 * @param {unknown} action
 * @param {number} index
 * @returns {ExecutedActionSummary}
 */
function formatActionSummary(action, index, includeDescription = false) {
  const record = asRecord(action);
  return {
    index,
    ...(Number.isInteger(record.selectionIndex) ? { selectionIndex: Number(record.selectionIndex) } : {}),
    label: readString(record.label) ?? `Action #${index}`,
    kind: readString(record.kind) ?? '',
    ...(includeDescription
      ? { description: truncateText(readString(record.text)?.replace(/\s+/g, ' ') ?? '', 180) }
      : {}),
  };
}

function buildFactorizedSelectionAction(decision, selectionIndexes) {
  if (decision.factorizedSelection !== true) {
    return { ok: false, error: 'selectionIndexes is only valid for a factorized multi-card decision.' };
  }
  const constraints = asRecord(decision.selectionConstraints);
  const min = Math.max(0, Math.trunc(Number(constraints.min) || 0));
  const max = Math.max(min, Math.trunc(Number(constraints.max) || min));
  const available = Math.max(0, Math.trunc(Number(constraints.available) || 0));
  if (selectionIndexes.length < min || selectionIndexes.length > max) {
    return { ok: false, error: `Factorized selection requires ${min}-${max} indexes; received ${selectionIndexes.length}.` };
  }
  if (selectionIndexes.some((index) => index >= available)) {
    return { ok: false, error: `Factorized selection index is out of range. Available indexes: 0-${available - 1}.` };
  }
  const response = Uint8Array.from([selectionIndexes.length, ...selectionIndexes]);
  return {
    ok: true,
    action: {
      label: `分层选择${selectionIndexes.length}张卡片(indices=${selectionIndexes.join(',')})`,
      kind: 'factorized_select_card',
      response,
      text: '',
    },
  };
}

function normalizeSelectionIndexes(value) {
  if (!Array.isArray(value)) return null;
  const indexes = value.map((entry) => readIndex(entry));
  if (indexes.some((entry) => entry === null)) return null;
  const normalized = indexes.map(Number);
  return new Set(normalized).size === normalized.length ? normalized : null;
}

function readOptionalNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * @param {{ captureSnapshot?: () => unknown } & Record<string, unknown>} runner
 * @param {number | undefined} graveyardLimit
 */
function captureFormattedState(runner, graveyardLimit) {
  if (typeof runner.captureSnapshot !== 'function') return null;
  const snapshot = runner.captureSnapshot();
  return formatCurrentState(snapshot, {
    runner,
    ...(graveyardLimit === undefined ? {} : { graveyardLimit }),
  });
}

/**
 * @param {Record<string, unknown>} runner
 * @param {unknown} snapshot
 * @param {number | undefined} graveyardLimit
 */
function formatSimulationState(runner, snapshot, graveyardLimit) {
  return formatCurrentState(snapshot, {
    runner,
    ...(graveyardLimit === undefined ? {} : { graveyardLimit }),
  });
}

/**
 * @param {ActionRunner} runner
 * @returns {unknown | null}
 */
function saveRollbackState(runner) {
  if (typeof runner.saveState !== 'function') return null;
  try {
    return runner.saveState('agent.executeAction.rollback');
  } catch {
    return null;
  }
}

/**
 * @param {ActionRunner} runner
 * @param {unknown} state
 * @returns {boolean}
 */
function restoreRollbackState(runner, state) {
  if (!state || typeof runner.restoreState !== 'function') return false;
  try {
    runner.restoreState(state);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} message
 * @returns {{ fatal: boolean, requiresReset: boolean, errorType: string, note: string }}
 */
function classifyActionFailure(message) {
  if (/memory access out of bounds|null function or function signature mismatch|unreachable|wasm/i.test(message)) {
    return {
      fatal: true,
      requiresReset: true,
      errorType: 'engine_memory_trap',
      note: 'This is an ocgcore/wasm trap, usually caused by an invalid response for the current engine prompt or by a corrupted duel state after a failed step.',
    };
  }

  if (/\[search-step-failed\]/i.test(message)) {
    return {
      fatal: true,
      requiresReset: true,
      errorType: 'engine_step_failed',
      note: 'The runner failed while applying an action to the current ocgcore decision after its internal rebuild retry.',
    };
  }

  return {
    fatal: false,
    requiresReset: false,
    errorType: 'action_failed',
    note: '',
  };
}

/**
 * @param {ActionRunner} runner
 * @param {number | undefined} graveyardLimit
 * @returns {import('./state-tools.js').CurrentStateSummary | null}
 */
function captureComparableState(runner, graveyardLimit) {
  try {
    return captureFormattedState(runner, graveyardLimit);
  } catch {
    return null;
  }
}

/**
 * @param {unknown} action
 * @param {Record<string, unknown>} nextDecision
 * @param {import('./state-tools.js').CurrentStateSummary | null} before
 * @param {import('./state-tools.js').CurrentStateSummary | null} after
 * @returns {string | null}
 */
function detectRejectedNoProgressAction(action, nextDecision, before, after) {
  const reason = readString(nextDecision.reason) ?? getDecisionName(nextDecision);
  if (reason !== 'STATUS_END') return null;
  const kind = readString(asRecord(action).kind);
  if (kind === 'phase_end') return null;
  if (!statesEquivalentForProgress(before, after)) return null;
  const label = readString(asRecord(action).label) ?? 'selected action';
  return `Engine rejected "${label}": ocgcore returned STATUS_END without changing hand/field/graveyard/extra deck.`;
}

/**
 * @param {import('./state-tools.js').CurrentStateSummary | null} before
 * @param {import('./state-tools.js').CurrentStateSummary | null} after
 */
function statesEquivalentForProgress(before, after) {
  if (!before || !after) return false;
  return comparableStateKey(before) === comparableStateKey(after);
}

/** @param {import('./state-tools.js').CurrentStateSummary} state */
function comparableStateKey(state) {
  return JSON.stringify({
    player: comparablePlayerState(state.player),
    opponent: comparablePlayerState(state.opponent),
    lp: state.lp,
  });
}

/** @param {import('./state-tools.js').PlayerStateSummary} player */
function comparablePlayerState(player) {
  return {
    hand: player.hand,
    handCount: player.handCount,
    deckCount: player.deckCount,
    monsters: player.monsters,
    spellsTraps: player.spellsTraps,
    graveyard: player.graveyard,
    graveyardCount: player.graveyardCount,
    banished: player.banished,
    extraDeck: player.extraDeck,
    extraDeckCount: player.extraDeckCount,
  };
}

/** @param {NormalizedResetInput} input */
function buildRunnerResetOptions(input) {
  return {
    ...(input.seed === undefined ? {} : { seed: input.seed }),
    ...(input.drawCount === undefined ? {} : { drawCount: input.drawCount }),
    ...(input.playerDeck === undefined ? {} : { playerDeck: input.playerDeck }),
    ...(input.opponentDeck === undefined ? {} : { opponentDeck: input.opponentDeck }),
    ...(input.playerOpening === undefined ? {} : { playerOpening: input.playerOpening }),
    ...(input.opponentOpening === undefined ? {} : { opponentOpening: input.opponentOpening }),
    ...(input.playerOpeningCards === undefined ? {} : { playerOpeningCards: input.playerOpeningCards }),
    ...(input.opponentOpeningCards === undefined ? {} : { opponentOpeningCards: input.opponentOpeningCards }),
  };
}

/**
 * @param {ActionRunner} runner
 * @param {NormalizedResetInput} input
 */
function applyResetInputToRunner(runner, input) {
  if (input.seed !== undefined) {
    runner.seed = input.seed;
    if (readNumber(runner.yrpVersion) === 2) {
      runner.seedSequence = makeSeedSequence(input.seed);
    }
  }

  if (input.drawCount !== undefined) {
    runner.drawCount = input.drawCount;
  }

  if (input.playerDeck) {
    runner.playerDeck = cloneDeck(input.playerDeck);
    runner.playerDeckInstances = createDeckCardInstancesForReset(input.playerDeck, runner.cardText);
  }

  if (input.opponentDeck) {
    runner.opponentDeck = cloneDeck(input.opponentDeck);
  }

  const shouldRebuildOpening =
    input.seedProvided ||
    input.deckProvided ||
    input.drawCount !== undefined ||
    input.playerOpeningCards !== undefined ||
    input.opponentOpeningCards !== undefined;
  const drawCount = normalizeOptionalPositiveInteger(runner.drawCount) ?? 1;
  const seed = normalizeOptionalSeed(runner.seed) ?? 0;

  if (input.playerOpening) {
    runner.playerOpening = cloneOpening(input.playerOpening);
  } else if (shouldRebuildOpening) {
    const opening = buildOpeningFromDeck(runner.playerDeck, drawCount, seed, input.playerOpeningCards, '我方重置起手');
    if (opening) runner.playerOpening = opening;
  }

  if (input.opponentOpening) {
    runner.opponentOpening = cloneOpening(input.opponentOpening);
  } else if (shouldRebuildOpening) {
    const opening = buildOpeningFromDeck(
      runner.opponentDeck,
      drawCount,
      (seed ^ 0x9e3779b9) >>> 0,
      input.opponentOpeningCards,
      '对方重置起手',
    );
    if (opening) runner.opponentOpening = opening;
  }
}

/** @param {ActionRunner} runner */
function clearRunnerForReset(runner) {
  if (typeof runner.destroyDuel === 'function') {
    runner.destroyDuel();
    return;
  }

  if (typeof runner.setActionHistory === 'function') runner.setActionHistory([], '');
  else runner.actionHistory = [];
  runner.currentDecision = null;
  if (typeof runner.clearStatePool === 'function') runner.clearStatePool();
  if (typeof runner.clearNativeSnapshotPool === 'function') runner.clearNativeSnapshotPool();
}

/** @param {ActionRunner} runner */
function captureRunnerResetConfig(runner) {
  return {
    seed: runner.seed,
    seedSequence: Array.isArray(runner.seedSequence) ? runner.seedSequence.slice() : runner.seedSequence,
    drawCount: runner.drawCount,
    playerDeck: cloneDeckLikeValue(runner.playerDeck),
    opponentDeck: cloneDeckLikeValue(runner.opponentDeck),
    playerOpening: cloneOpeningLikeValue(runner.playerOpening),
    opponentOpening: cloneOpeningLikeValue(runner.opponentOpening),
    playerDeckInstances: runner.playerDeckInstances,
    actionHistory: Array.isArray(runner.actionHistory) ? runner.actionHistory.slice() : runner.actionHistory,
    currentDecision: runner.currentDecision,
  };
}

/**
 * @param {ActionRunner} runner
 * @param {ReturnType<typeof captureRunnerResetConfig>} config
 */
function restoreRunnerResetConfig(runner, config) {
  runner.seed = config.seed;
  runner.seedSequence = config.seedSequence;
  runner.drawCount = config.drawCount;
  runner.playerDeck = config.playerDeck;
  runner.opponentDeck = config.opponentDeck;
  runner.playerOpening = config.playerOpening;
  runner.opponentOpening = config.opponentOpening;
  runner.playerDeckInstances = config.playerDeckInstances;
  runner.actionHistory = config.actionHistory;
  runner.currentDecision = config.currentDecision;
}

/**
 * @param {ActionRunner} runner
 * @param {NormalizedResetInput} input
 * @returns {ResetGameSummary}
 */
function buildResetGameSummary(runner, input) {
  const snapshot = typeof runner.captureSnapshot === 'function' ? runner.captureSnapshot() : null;
  return {
    state: snapshot ? formatSimulationState(runner, snapshot, input.graveyardLimit) : null,
    nextDecision: summarizeDecision(asRecord(runner.currentDecision)),
    seed: normalizeOptionalSeed(runner.seed) ?? null,
    deck: summarizeResetDeck(runner),
    historyLength: readHistoryLength(runner),
    applied: {
      seed: input.seedProvided,
      deck: input.deckProvided,
      opening: input.playerOpening !== undefined ||
        input.opponentOpening !== undefined ||
        input.playerOpeningCards !== undefined ||
        input.opponentOpeningCards !== undefined,
      drawCount: input.drawCount !== undefined,
      drawCountForcedByFixedOpening: input.drawCountForcedByFixedOpening,
    },
  };
}

/** @param {ActionRunner} runner */
function summarizeResetDeck(runner) {
  const playerDeck = asRecord(runner.playerDeck);
  const opponentDeck = asRecord(runner.opponentDeck);
  return {
    playerMain: Array.isArray(playerDeck.main) ? playerDeck.main.length : null,
    playerExtra: Array.isArray(playerDeck.extra) ? playerDeck.extra.length : null,
    opponentMain: Array.isArray(opponentDeck.main) ? opponentDeck.main.length : null,
    opponentExtra: Array.isArray(opponentDeck.extra) ? opponentDeck.extra.length : null,
  };
}

/**
 * @param {unknown} deckValue
 * @param {number} drawCount
 * @param {number} seed
 * @param {number[] | undefined} fixedOpening
 * @param {string} label
 * @returns {OpeningState | null}
 */
function buildOpeningFromDeck(deckValue, drawCount, seed, fixedOpening, label) {
  const deck = asRecord(deckValue);
  if (!Array.isArray(deck.main)) return null;
  const main = normalizeCardCodeArray(deck.main, 'deck.main');
  if (!main.ok) return null;

  if (fixedOpening) {
    const remain = main.value.slice();
    /** @type {number[]} */
    const opening = [];
    for (const code of fixedOpening) {
      const index = remain.indexOf(code);
      if (index < 0) {
        throw new Error(`resetGame fixed opening card ${code} is not available in the deck.`);
      }
      opening.push(code);
      remain.splice(index, 1);
    }
    return { opening, remain, label };
  }

  const shuffled = main.value.slice();
  const random = makeXorshift32(seed);
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    const current = shuffled[index];
    shuffled[index] = shuffled[swapIndex];
    shuffled[swapIndex] = current;
  }
  const count = Math.min(Math.max(0, drawCount), shuffled.length);
  return {
    opening: shuffled.slice(0, count),
    remain: shuffled.slice(count),
    label,
  };
}

/** @param {ParsedDeck} deck */
function cloneDeck(deck) {
  return {
    main: deck.main.slice(),
    extra: deck.extra.slice(),
    side: deck.side.slice(),
  };
}

/** @param {OpeningState} opening */
function cloneOpening(opening) {
  return {
    opening: opening.opening.slice(),
    remain: opening.remain.slice(),
    ...(opening.label ? { label: opening.label } : {}),
  };
}

/** @param {unknown} value */
function cloneDeckLikeValue(value) {
  const record = asRecord(value);
  if (!Array.isArray(record.main)) return value;
  return {
    ...record,
    main: record.main.slice(),
    extra: arrayValue(record.extra).slice(),
    side: arrayValue(record.side).slice(),
  };
}

/** @param {unknown} value */
function cloneOpeningLikeValue(value) {
  const record = asRecord(value);
  if (!Array.isArray(record.opening) || !Array.isArray(record.remain)) return value;
  return {
    ...record,
    opening: record.opening.slice(),
    remain: record.remain.slice(),
  };
}

/**
 * @param {ParsedDeck} deck
 * @param {unknown} cardText
 */
function createDeckCardInstancesForReset(deck, cardText) {
  const textRuntime = asRecord(cardText);
  const getName = typeof textRuntime.getName === 'function'
    ? (/** @type {(code: number) => string} */ (textRuntime.getName)).bind(textRuntime)
    : null;
  const buildSection = (/** @type {string} */ section, /** @type {number[]} */ codes) => {
    const seen = new Map();
    return codes.map((code, index) => {
      const ordinal = (seen.get(code) ?? 0) + 1;
      seen.set(code, ordinal);
      return {
        instanceId: `${section}:${code >>> 0}:${ordinal}`,
        code: code >>> 0,
        name: getName ? getName(code >>> 0) : String(code >>> 0),
        section,
        ordinal,
        index,
      };
    });
  };
  const main = buildSection('main', deck.main);
  const extra = buildSection('extra', deck.extra);
  const side = buildSection('side', deck.side);
  const all = [...main, ...extra, ...side];
  return { main, extra, side, all, byId: new Map(all.map((card) => [card.instanceId, card])) };
}

/** @param {Record<string, unknown>} runner */
function readHistoryLength(runner) {
  return Array.isArray(runner.actionHistory) ? runner.actionHistory.length : null;
}

/** @param {string} value */
function normalizeLabel(value) {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** @param {unknown} value */
function readString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/** @param {unknown} value */
function readNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** @param {unknown} value */
function normalizeOptionalSeed(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) && number >= 0 && number <= 0xffffffff ? number >>> 0 : null;
}

/** @param {unknown} value */
function normalizeCardCode(value) {
  const number = Math.trunc(Number(value));
  return Number.isSafeInteger(number) && number > 0 ? number >>> 0 : null;
}

/** @param {unknown} value */
function readIndex(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

/** @param {unknown} value */
function normalizeOptionalPositiveInteger(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) && number > 0 ? number : undefined;
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
    readString(decision.reason) ??
    readString(decision.name) ??
    readString(constructorName)
  );
}

/**
 * @param {string} text
 * @param {number} maxLength
 */
function truncateText(text, maxLength) {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
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

/**
 * @param {number} seed
 * @param {number} [count]
 */
function makeSeedSequence(seed, count = 8) {
  const random = makeXorshift32((seed ^ 0x6a09e667) >>> 0);
  /** @type {number[]} */
  const values = [];
  for (let index = 0; index < count; index += 1) {
    values.push(Math.floor(random() * 0x100000000) >>> 0);
  }
  return values;
}

/** @param {unknown} value */
function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

/** @param {unknown} value */
function asRecord(value) {
  return value && typeof value === 'object' ? /** @type {Record<string, unknown>} */ (value) : {};
}

/** @param {unknown} value */
function isPromiseLike(value) {
  return value !== null && typeof value === 'object' && typeof asRecord(value).then === 'function';
}

export const executeActionTool = {
  name: 'executeAction',
  description: 'Execute one legal action and return the updated state plus next legal actions; use that result directly instead of immediately calling state/action tools again.',
  input_schema: {
    type: 'object',
    properties: {
      actionLabel: {
        type: 'string',
        description: 'Exact action label from listActions. Required unless actionIndex is provided.',
      },
      actionIndex: {
        type: 'number',
        description: 'Zero-based action index from listActions. Useful when labels are duplicated.',
        minimum: 0,
      },
      selectionIndexes: {
        type: 'array',
        description: 'Original candidate indexes returned by listActions for a factorized multi-card decision.',
        minItems: 1,
        maxItems: 255,
        uniqueItems: true,
        items: { type: 'integer', minimum: 0, maximum: 255 },
      },
      graveyardLimit: {
        type: 'number',
        description: 'Maximum recent graveyard cards to include in the returned state.',
        minimum: 1,
      },
      includeDescriptions: {
        type: 'boolean',
        description: 'Include text summaries for the executed and next actions. Defaults to false to conserve context.',
      },
    },
    anyOf: [
      { required: ['actionLabel'] },
      { required: ['actionIndex'] },
      { required: ['selectionIndexes'] },
    ],
    additionalProperties: false,
  },
  execute: executeAction,
};

export const simulateActionsTool = {
  name: 'simulateActions',
  description: 'Simulate multiple duel actions in sequence, return the resulting states and decisions, and restore the original state afterward.',
  input_schema: {
    type: 'object',
    properties: {
      actionLabels: {
        type: 'array',
        description: 'Action sequence to simulate. Each item can be an exact action label, a zero-based action index, or an object with actionLabel/actionIndex.',
        minItems: 1,
        maxItems: MAX_SIMULATION_ACTIONS,
        items: {
          anyOf: [
            { type: 'string' },
            { type: 'number', minimum: 0 },
            {
              type: 'object',
              properties: {
                actionLabel: {
                  type: 'string',
                  description: 'Exact action label from the decision at this simulated step.',
                },
                actionIndex: {
                  type: 'number',
                  description: 'Zero-based action index from the decision at this simulated step.',
                  minimum: 0,
                },
              },
              additionalProperties: false,
            },
          ],
        },
      },
      graveyardLimit: {
        type: 'number',
        description: 'Maximum recent graveyard cards to include in each returned state.',
        minimum: 1,
      },
    },
    required: ['actionLabels'],
    additionalProperties: false,
  },
  execute: simulateActions,
};

const deckInputSchema = {
  anyOf: [
    {
      type: 'object',
      properties: {
        main: { type: 'array', items: { type: 'number', minimum: 1 } },
        extra: { type: 'array', items: { type: 'number', minimum: 1 } },
        side: { type: 'array', items: { type: 'number', minimum: 1 } },
      },
      required: ['main'],
      additionalProperties: true,
    },
    {
      type: 'array',
      items: { type: 'number', minimum: 1 },
    },
  ],
};

export const resetGameTool = {
  name: 'resetGame',
  description: 'Reset the duel runner to its initial state, optionally changing seed, deck, draw count, or fixed opening cards. Fixed opening cards are exact: they define both the card identities and opening hand size, and resetGame must not add random cards to fill a 5-card hand.',
  input_schema: {
    type: 'object',
    properties: {
      seed: {
        type: 'number',
        description: 'Unsigned 32-bit random seed for rebuilding the opening hand.',
        minimum: 0,
        maximum: 0xffffffff,
      },
      deck: {
        ...deckInputSchema,
        description: 'Parsed deck object or main-deck card-code array to use for both players unless playerDeck/opponentDeck are provided.',
      },
      playerDeck: {
        ...deckInputSchema,
        description: 'Parsed deck object or main-deck card-code array for player 0.',
      },
      opponentDeck: {
        ...deckInputSchema,
        description: 'Parsed deck object or main-deck card-code array for player 1.',
      },
      drawCount: {
        type: 'number',
        description: 'Number of opening hand cards to draw when rebuilding random openings. Ignored/overridden by the exact number of fixed playerOpeningCards/openingCards.',
        minimum: 1,
      },
      openingCards: {
        type: 'array',
        description: 'Exact fixed player opening card codes. Cards are removed from the remaining deck in order; no random cards are added to fill 5.',
        items: { type: 'number', minimum: 1 },
      },
      playerOpeningCards: {
        type: 'array',
        description: 'Exact fixed player opening card codes. Overrides openingCards; no random cards are added to fill 5.',
        items: { type: 'number', minimum: 1 },
      },
      opponentOpeningCards: {
        type: 'array',
        description: 'Fixed opponent opening card codes.',
        items: { type: 'number', minimum: 1 },
      },
      graveyardLimit: {
        type: 'number',
        description: 'Maximum recent graveyard cards to include in the returned initial state.',
        minimum: 1,
      },
    },
    additionalProperties: false,
  },
  execute: resetGame,
};
