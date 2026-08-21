// @ts-check

import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openCardsDatabase } from '../database/cards-db.js';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SKILL_ROOT = resolve(PROJECT_ROOT, '..');
const DEFAULT_CARDS_DB = resolve(SKILL_ROOT, 'resources/lib/cards.cdb');
const DEFAULT_SCRIPTS_DIR = resolve(SKILL_ROOT, 'resources/lib/ygopro-scripts');
const DEFAULT_PRERELEASE_ROOT = resolve(SKILL_ROOT, 'resources/lib/prerelease');
const DEFAULT_YGOPRO2_ROOT = process.env.YGO_YGOPRO2_ROOT || '';
const DEFAULT_YGOPRO2_SCRIPT_CACHE_ROOT = resolve(PROJECT_ROOT, '.cache/ygopro2-script-root');
const DEFAULT_SNAPSHOT_POOL_SIZE = 64;
const DEFAULT_MAX_REPLAY_CANDIDATES = 2048;
const UNBOUNDED_REPLAY_PARSE_BUDGET = Number.POSITIVE_INFINITY;
const REPLAY_PROCESS_GUARD = 200000;
const REPLAY_ID_YRP1 = 0x31707279;
const REPLAY_ID_YRP2 = 0x32707279;

const require = createRequire(import.meta.url);
const { requireSkillDependency } = require('../vendor-require.cjs');
const { YGOProYrp } = requireSkillDependency('ygopro-yrp-encode');
const ygoproMsg = requireSkillDependency('ygopro-msg-encode');
const comboSimulator = require(resolve(PROJECT_ROOT, 'combo-simulator.cjs'));

/**
 * @typedef {{ main: number[], extra: number[], side: number[] }} PlainDeck
 * @typedef {{ opening: number[], remain: number[], label: string }} OpeningState
 * @typedef {{ code: number, name: string }} NamedCard
 * @typedef {{ stepIndex: number, responseIndex: number, responseHex: string, responseBase64: string, decisionName: string | null, label: string, kind: string | null, text: string, actionCount: number }} YrpRouteStep
 * @typedef {{ eventIndex: number, responseIndex: number, visibility: 'visible' | 'hidden', source: 'action' | 'recorded-response', responseHex: string, responseBase64: string, decisionName?: string | null, label?: string, kind?: string | null, text?: string, actionCount?: number, responsePlayer?: number | null }} YrpRouteEvent
 * @typedef {{ code: string, message: string, details?: Record<string, unknown> }} YrpRouteWarning
 * @typedef {{ unitIndex: number, responseIndex: number, label: string, kind: string | null, trailingStepCount: number }} YrpContextActionOutline
 * @typedef {{ phaseIndex: number, title: string, summary: string, headlinerCards: string[], mentionedCards: string[], stepRange: [number, number], unitRange: [number, number], responseCount: number, actionUnitCount: number, actions: YrpContextActionOutline[] }} YrpRoutePhaseOutline
 * @typedef {{ title: string, summary: string, markdown: string, visibleStepCount: number, hiddenEventCount: number, phaseCount: number, actionUnitCount: number, phaseOutline: YrpRoutePhaseOutline[] }} YrpRouteContext
 * @typedef {{ unitIndex: number, anchorStepIndex: number, endStepIndex: number, anchorKind: string | null, anchorDecisionName: string | null, anchorCard: string | null, anchorLabel: string, anchorText: string, responseIndices: number[], trailingStepCount: number, steps: YrpRouteStep[] }} YrpActionUnit
 * @typedef {{ phaseIndex: number, title: string, headlinerCards: string[], unitRange: [number, number], stepRange: [number, number], unitCount: number, responseCount: number, units: YrpActionUnit[], summary: string }} YrpPhaseGroup
 * @typedef {{ packetIndex: number, packetOffset: number, type: number, messageName: string, kind: string, label: string, code?: number | null, cardName?: string | null, details?: Record<string, unknown> }} YgoPro2TraceEvent
 * @typedef {{ source: 'ygopro2-client-message-stream', packetCount: number, eventCount: number, markdown: string, events: YgoPro2TraceEvent[], warnings: YrpRouteWarning[] }} YgoPro2ClientTrace
 * @typedef {{ fileName: string | null, sourcePath: string | null, container: Record<string, unknown> | null, clientTrace?: YgoPro2ClientTrace | null, replay: Record<string, unknown>, deck: { player: { counts: { main: number, extra: number, side: number }, opening: NamedCard[] }, opponent: { counts: { main: number, extra: number, side: number }, openingCount: number, hiddenInformation: true } }, summary: Record<string, unknown>, visibleSteps: YrpRouteStep[], actionUnits: YrpActionUnit[], phaseGroups: YrpPhaseGroup[], rawEvents: YrpRouteEvent[], warnings: YrpRouteWarning[], context: YrpRouteContext }} YrpRouteData
 * @typedef {{ ok: true, data: YrpRouteData } | { ok: false, error: string, code: string, sourcePath?: string | null }} YrpRouteParseResult
 * @typedef {{ label?: string, kind?: string, text?: string, response?: Uint8Array | number[], intResponse?: number }} ReplayAction
 * @typedef {{ terminal?: boolean, reason?: string | null, actions?: ReplayAction[], message?: { constructor?: { name?: string }, responsePlayer?: () => number }, responsePlayer?: number | null, lazyReplayDecision?: boolean, estimatedLegalCandidateCount?: number }} ReplayDecision
 * @typedef {{ getName?: (code: number) => string }} CardTextLike
 * @typedef {{ cardText?: CardTextLike, currentDecision?: ReplayDecision | null, replayCollector?: null, duel?: { setResponse?: (response: Uint8Array) => void }, destroyDuel?: () => void, createReplayCompatibleDuelInstance?: () => unknown, advanceUntilDecision?: () => ReplayDecision, captureSnapshot?: () => unknown, setActionHistory?: (history: unknown[], key: string) => void, actionHistory?: unknown[], actionHistoryKey?: string, seedSequence?: number[], tryAutoRespondDecisionMessage?: (message: unknown, backend?: unknown) => unknown, tryBuildDecisionFromMessage?: (message: unknown, backend?: unknown) => ReplayDecision | null, isMsgType?: (message: unknown, type: string) => boolean }} RunnerLike
 * @typedef {{ action: ReplayAction, decisionName: string | null, response: Uint8Array, responseIndex: number, stepIndex: number, actionCount: number }} BuildVisibleStepInput
 */

/**
 * Parse a YRP/YRP2 file into replay metadata, raw response events, visible route
 * steps, and a complete context block.
 *
 * @param {string} filePath
 * @param {Record<string, unknown>} [options]
 * @returns {Promise<YrpRouteParseResult>}
 */
export async function parseYrpRouteFromFile(filePath, options = {}) {
  const record = asRecord(options);
  const sourcePath = readNonEmptyString(filePath);
  if (!sourcePath) {
    return {
      ok: false,
      code: 'INVALID_INPUT',
      error: 'parseYrpRouteFromFile requires a non-empty file path.',
    };
  }

  const resolvedPath = resolve(sourcePath);
  try {
    const payload = await readFile(resolvedPath);
    return await parseYrpRouteFromBuffer(payload, {
      ...record,
      sourcePath: resolvedPath,
      fileName: readNonEmptyString(record.fileName) ?? basename(resolvedPath),
    });
  } catch (error) {
    return formatParseError(error, resolvedPath);
  }
}

/**
 * Parse YRP/YRP2 bytes into replay metadata, raw response events, visible route
 * steps, and a complete context block.
 *
 * @param {Uint8Array | ArrayBuffer | Buffer} payload
 * @param {Record<string, unknown>} [options]
 * @returns {Promise<YrpRouteParseResult>}
 */
export async function parseYrpRouteFromBuffer(payload, options = {}) {
  const record = asRecord(options);
  try {
    const bytes = normalizePayload(payload);
    const replayPayload = extractEmbeddedYrpPayload(bytes);
    const replay = new YGOProYrp().fromYrp(replayPayload.bytes);
    const data = await buildRouteDataFromReplay(replay, {
      ...record,
      container: replayPayload.container,
      originalPayload: bytes,
    });
    data.context = createYrpRouteContext(data);
    return { ok: true, data };
  } catch (error) {
    return formatParseError(error, readNonEmptyString(record.sourcePath));
  }
}

/**
 * Build a complete, model-readable reference block from parsed route data.
 *
 * @param {YrpRouteData} data
 * @returns {YrpRouteContext}
 */
export function createYrpRouteContext(data) {
  const visibleSteps = Array.isArray(data?.visibleSteps) ? data.visibleSteps : [];
  const hiddenCount = Array.isArray(data?.rawEvents)
    ? data.rawEvents.filter((event) => event.visibility === 'hidden').length
    : 0;
  const title = `YRP路线参考: ${data?.fileName ?? 'uploaded replay'}`;
  const responseCount = Number(data?.summary?.responseCount ?? 0);
  const consumedCount = Number(data?.summary?.consumedResponseCount ?? 0);
  const actionUnitCount = Number(data?.summary?.actionUnitCount ?? 0);
  const phaseCount = Number(data?.summary?.phaseCount ?? data?.phaseGroups?.length ?? 0);
  const lines = [
    `# ${title}`,
    '',
    `- Response: ${consumedCount}/${responseCount}`,
    `- 阶段: ${phaseCount}（${actionUnitCount} 个主要动作）`,
    `- 可见步骤: ${visibleSteps.length}`,
    `- 对手/隐藏响应: ${hiddenCount}`,
    `- Seed: ${String(data?.replay?.seed ?? '')}`,
  ];
  if (data?.clientTrace?.markdown) {
    lines.push('- 客户端消息流: YGOPro2 录像内嵌消息流可用，路线复述优先参考该消息流。');
  } else {
    lines.push('- 客户端消息流: 不可用；普通 YRP 只包含响应序列，不能用消息流校正路线。');
  }

  const opening = data?.deck?.player?.opening ?? [];
  if (opening.length > 0) {
    lines.push(`- 起手: ${opening.map((card) => `${card.name}(${card.code})`).join(', ')}`);
  }
  if (Array.isArray(data?.warnings) && data.warnings.length > 0) {
    lines.push(`- 警告: ${data.warnings.map((warning) => warning.message).join(' | ')}`);
  }
  lines.push('- 使用要求: 复述时只引用下列YRP解析出的动作和可见步骤；不要根据卡名、常识或卡组套路补全未列出的处理。');

  if (data?.clientTrace?.markdown) {
    lines.push(
      '',
      '## YGOPro2客户端消息流（优先参考）',
      data.clientTrace.markdown,
      '',
      '## 重放推演解析（辅助参考）',
    );
  }

  const phaseGroups = Array.isArray(data?.phaseGroups) ? data.phaseGroups : [];
  /** @type {YrpRoutePhaseOutline[]} */
  const phaseOutline = [];
  if (phaseGroups.length > 0) {
    lines.push('', '## 路线阶段（精细度与解说一致）');
    for (const phase of phaseGroups) {
      const mentionedCards = collectPhaseCardMentions(phase);

      phaseOutline.push({
        phaseIndex: phase.phaseIndex,
        title: phase.title,
        summary: phase.summary,
        headlinerCards: phase.headlinerCards,
        mentionedCards,
        stepRange: phase.stepRange,
        unitRange: phase.unitRange,
        responseCount: phase.responseCount,
        actionUnitCount: phase.units.length,
        actions: phase.units.map((unit) => ({
          unitIndex: unit.unitIndex,
          responseIndex: Array.isArray(unit.responseIndices) ? (unit.responseIndices[0] ?? -1) : -1,
          label: unit.anchorLabel,
          kind: unit.anchorKind,
          trailingStepCount: unit.trailingStepCount,
        })),
      });

      lines.push('', `### 阶段${phase.phaseIndex}: ${phase.title}`);
      lines.push(`- 主要动作: ${phase.summary}`);
      lines.push(`- 响应区间: 动作 ${phase.unitRange[0]}..${phase.unitRange[1]}（共 ${phase.responseCount} 响应）`);
      if (mentionedCards.length > 0) {
        lines.push(`- 涉及卡牌: ${mentionedCards.join('、')}`);
      }
      lines.push('- 动作明细:');
      for (const unit of phase.units) {
        const firstResp = Array.isArray(unit.responseIndices) ? unit.responseIndices[0] : -1;
        const tail = unit.trailingStepCount > 0 ? `（+${unit.trailingStepCount} 个选择/确认）` : '';
        lines.push(`  ${unit.unitIndex}. [resp#${firstResp}] ${unit.anchorLabel}${tail}`);
      }
    }
  } else {
    lines.push('', '## 可见路线步骤');
    for (const step of visibleSteps) {
      const kind = step.kind ? ` / ${step.kind}` : '';
      lines.push(`${step.stepIndex}. [response ${step.responseIndex}${kind}] ${step.label}`);
    }
  }

  if (phaseGroups.length > 0) {
    lines.push('', '## 按YRP响应顺序的可见步骤');
    for (const step of visibleSteps) {
      const kind = step.kind ? ` / ${step.kind}` : '';
      lines.push(`${step.stepIndex}. [resp#${step.responseIndex}${kind}] ${step.label}`);
    }
  }

  const summary = [
    `${phaseCount} phases`,
    `${actionUnitCount} action units`,
    `${visibleSteps.length} visible steps`,
    `${hiddenCount} hidden/automatic responses`,
    `${consumedCount}/${responseCount} responses consumed`,
  ].join('; ');

  return {
    title,
    summary,
    markdown: lines.join('\n'),
    visibleStepCount: visibleSteps.length,
    hiddenEventCount: hiddenCount,
    phaseCount,
    actionUnitCount,
    phaseOutline,
  };
}

/**
 * @param {InstanceType<typeof YGOProYrp>} replay
 * @param {Record<string, unknown>} options
 * @returns {Promise<YrpRouteData>}
 */
async function buildRouteDataFromReplay(replay, options) {
  const responses = Array.isArray(replay.responses) ? replay.responses.map(toUint8Array) : [];
  const replayBackend = await resolveReplayBackendOptions(options);
  const playerDeck = toPlainDeck(replay.hostDeck);
  const opponentDeck = toPlainDeck(replay.clientDeck);
  const startHand = normalizeNonNegativeInteger(replay.startHand, 0);
  const playerOpening = deriveOpeningFromReplayMain(playerDeck.main, startHand, 'player-opening-from-yrp');
  const opponentOpening = deriveOpeningFromReplayMain(opponentDeck.main, startHand, 'opponent-opening-from-yrp');
  const seed = normalizeUInt32(replay.header?.seed, 0);
  const yrpVersion = inferYrpVersion(replay);
  const clientTrace = buildYgoPro2ClientTrace(options, replayBackend);
  const warnings = /** @type {YrpRouteWarning[]} */ ([]);
  const rawEvents = /** @type {YrpRouteEvent[]} */ ([]);
  const visibleSteps = /** @type {YrpRouteStep[]} */ ([]);
  const maxLegalCandidates = normalizePositiveInteger(
    options.maxLegalCandidates,
    DEFAULT_MAX_REPLAY_CANDIDATES,
  );

  let runtime = null;
  /** @type {RunnerLike | null} */
  let runner = null;
  let cursor = 0;
  let playerDecisionCount = 0;
  let opponentDecisionCount = 0;
  let unknownDecisionCount = 0;
  let oversizedDecisionCount = 0;
  let unmatchedDecisionCount = 0;
  let initialCounts = null;
  let finalCounts = null;

  try {
    const context = await comboSimulator.createSearchContext({
      cardsPath: replayBackend.cardsPath,
      cardsPaths: replayBackend.cardsPaths,
      scriptDirs: normalizeScriptDirs(replayBackend.scriptDirs),
      nativeScriptsRoot: replayBackend.nativeScriptsRoot,
      nativeOcgcoreDllPath: replayBackend.nativeOcgcoreDllPath,
      seed,
      seedSequence: Array.isArray(replay.header?.seedSequence)
        ? replay.header.seedSequence.map((value) => normalizeUInt32(value, 0))
        : [],
      drawCount: startHand,
      yrpVersion,
      duelOptions: normalizeUInt32(replay.opt, 0),
      maxDepth: UNBOUNDED_REPLAY_PARSE_BUDGET,
      maxNodes: UNBOUNDED_REPLAY_PARSE_BUDGET,
      maxBeamWidth: UNBOUNDED_REPLAY_PARSE_BUDGET,
      maxActionsPerNode: UNBOUNDED_REPLAY_PARSE_BUDGET,
      snapshotPoolSize: normalizeNonNegativeInteger(options.snapshotPoolSize, DEFAULT_SNAPSHOT_POOL_SIZE),
      maxProcessPerStep: normalizePositiveInteger(options.maxProcessPerStep, REPLAY_PROCESS_GUARD),
      expandScriptKeywords: [],
      playerDeck,
      opponentDeck,
      playerOpening,
      opponentOpening,
      engineBackend: replayBackend.engineBackend,
      exactSingleSearch: false,
    });
    runtime = context.runtime;
    runner = /** @type {RunnerLike} */ (context.runner);
    removeReplayParseBudgets(runner);

    runner.destroyDuel?.();
    if (typeof runner.createReplayCompatibleDuelInstance !== 'function') {
      throw new Error('Runner does not support replay-compatible startup.');
    }
    if (typeof runner.advanceUntilDecision !== 'function') {
      throw new Error('Runner does not support decision advancement.');
    }
    if (Array.isArray(replay.header?.seedSequence) && replay.header.seedSequence.length > 0) {
      runner.seedSequence = replay.header.seedSequence.map((value) => normalizeUInt32(value, 0));
    }
    exposeBothPlayersDecisions(runner, maxLegalCandidates);
    runner.replayCollector = null;
    runner.duel = runner.createReplayCompatibleDuelInstance();
    if (typeof runner.duel?.setResponse !== 'function') {
      throw new Error('Runner does not support replay response injection.');
    }
    runner.currentDecision = runner.advanceUntilDecision();
    setRunnerActionHistory(runner, [], '');
    initialCounts = capturePublicCounts(runner);

    while (cursor < responses.length) {
      if (!runner.currentDecision || runner.currentDecision.terminal) break;

      const actions = Array.isArray(runner.currentDecision.actions) ? runner.currentDecision.actions : [];
      const response = responses[cursor];
      const lazyReplayDecision = Boolean(runner.currentDecision.lazyReplayDecision);
      const action = lazyReplayDecision ? null : findMatchingAction(actions, response);
      const decisionName = runner.currentDecision?.message?.constructor?.name ?? null;
      const responsePlayer = Number.isInteger(runner.currentDecision.responsePlayer)
        ? runner.currentDecision.responsePlayer
        : null;
      if (responsePlayer === 0) playerDecisionCount += 1;
      else if (responsePlayer === 1) opponentDecisionCount += 1;
      else unknownDecisionCount += 1;
      if (lazyReplayDecision) oversizedDecisionCount += 1;

      if (responsePlayer === 0 && (action || lazyReplayDecision)) {
        const recordedAction = action ?? createLazyReplayAction(
          decisionName,
          runner.currentDecision.estimatedLegalCandidateCount ?? actions.length,
        );
        const step = buildVisibleStep({
          action: recordedAction,
          decisionName,
          response,
          responseIndex: cursor,
          stepIndex: visibleSteps.length + 1,
          actionCount: runner.currentDecision.estimatedLegalCandidateCount ?? actions.length,
        });
        visibleSteps.push(step);
        rawEvents.push({
          eventIndex: rawEvents.length,
          responseIndex: step.responseIndex,
          visibility: 'visible',
          source: 'action',
          responseHex: step.responseHex,
          responseBase64: step.responseBase64,
          decisionName: step.decisionName,
          label: step.label,
          kind: step.kind,
          text: step.text,
          actionCount: step.actionCount,
          responsePlayer,
        });
      } else {
        rawEvents.push({
          eventIndex: rawEvents.length,
          responseIndex: cursor,
          visibility: 'hidden',
          source: 'recorded-response',
          responseHex: toHex(response),
          responseBase64: toBase64(response),
          decisionName,
          actionCount: runner.currentDecision.estimatedLegalCandidateCount ?? actions.length,
          responsePlayer,
        });
      }

      if (!action && !lazyReplayDecision) {
        unmatchedDecisionCount += 1;
        const actionCandidates = summarizeDecisionActions(actions);
        warnings.push({
          code: 'VISIBLE_RESPONSE_MISS',
          message: [
            `No visible action matched response ${cursor} (${toHex(response)})`,
            `at ${decisionName ?? 'unknown decision'}.`,
            `Current actions: ${formatActionCandidateList(actionCandidates)}`,
          ].join(' '),
          details: {
            responseIndex: cursor,
            responseHex: toHex(response),
            decisionName,
            responsePlayer,
            actionCount: runner.currentDecision.estimatedLegalCandidateCount ?? actions.length,
            lazyReplayDecision,
            actions: actionCandidates,
          },
        });
      }

      // YRP records one response for every decision. Never synthesize a player
      // response or resynchronize the stream: inject this exact response once.
      runner.duel.setResponse(response);
      cursor += 1;
      runner.currentDecision = runner.advanceUntilDecision();
    }
    finalCounts = capturePublicCounts(runner);

    const actionUnits = groupVisibleStepsIntoActionUnits(visibleSteps);
    const phaseGroups = groupActionUnitsIntoPhases(actionUnits);

    return {
      fileName: readNonEmptyString(options.fileName) ?? null,
      sourcePath: readNonEmptyString(options.sourcePath) ?? null,
      container: readContainer(options.container),
      clientTrace,
      replay: summarizeReplay(replay, yrpVersion),
      deck: {
        player: {
          counts: countDeck(playerDeck),
          opening: nameCards(playerOpening.opening, runner?.cardText),
        },
        opponent: {
          counts: countDeck(opponentDeck),
          openingCount: opponentOpening.opening.length,
          hiddenInformation: true,
        },
      },
      summary: {
        responseCount: responses.length,
        consumedResponseCount: cursor,
        fullyConsumed: cursor === responses.length,
        clientTraceAvailable: Boolean(clientTrace),
        clientTraceSource: clientTrace?.source ?? null,
        clientTraceUnavailableReason: clientTrace
          ? null
          : 'NO_CLIENT_MESSAGE_STREAM_IN_PLAIN_YRP',
        visibleStepCount: visibleSteps.length,
        actionUnitCount: actionUnits.length,
        phaseCount: phaseGroups.length,
        hiddenResponseCount: rawEvents.filter((event) => event.visibility === 'hidden').length,
        playerDecisionCount,
        opponentDecisionCount,
        unknownDecisionCount,
        oversizedDecisionCount,
        unmatchedDecisionCount,
        strictResponseOrder: true,
        resyncEvents: 0,
        skippedResponses: 0,
        initialCounts,
        finalCounts,
        warningCount: warnings.length,
        terminal: Boolean(runner?.currentDecision?.terminal),
        terminalReason: runner?.currentDecision?.reason ?? null,
      },
      visibleSteps,
      actionUnits,
      phaseGroups,
      rawEvents,
      warnings: clientTrace ? [...clientTrace.warnings, ...warnings] : warnings,
      context: {
        title: '',
        summary: '',
        markdown: '',
        visibleStepCount: 0,
        hiddenEventCount: 0,
        phaseCount: 0,
        actionUnitCount: 0,
        phaseOutline: [],
      },
    };
  } finally {
    if (runner) runner.replayCollector = null;
    if (runtime || runner) {
      await comboSimulator.cleanupRuntime(runtime, runner);
    }
  }
}

const ANCHOR_KINDS = ['summon', 'spsummon', 'activate'];
const IDLE_CMD_DECISION = 'YGOProMsgSelectIdleCmd';
const NON_CARD_TOKENS = new Set(['是', '否']);

/**
 * Collapse fine-grained visible steps into coarse "action units" anchored on
 * each meaningful primary action (summon / spsummon / activate). Trivial placement,
 * position, chain-choice and target-selection decisions fold under their anchor so
 * the resulting unit list matches the granularity of a human route narration.
 *
 * @param {YrpRouteStep[]} visibleSteps
 * @returns {YrpActionUnit[]}
 */
function groupVisibleStepsIntoActionUnits(visibleSteps) {
  const steps = Array.isArray(visibleSteps) ? visibleSteps : [];
  /** @type {YrpActionUnit[]} */
  const units = [];
  /** @type {YrpActionUnit | null} */
  let current = null;
  for (const step of steps) {
    const isAnchor = step && typeof step.kind === 'string' && ANCHOR_KINDS.includes(step.kind);
    if (isAnchor) {
      current = {
        unitIndex: units.length + 1,
        anchorStepIndex: step.stepIndex,
        endStepIndex: step.stepIndex,
        anchorKind: step.kind,
        anchorDecisionName: step.decisionName,
        anchorCard: extractCardFromLabel(step.label),
        anchorLabel: String(step.label ?? ''),
        anchorText: String(step.text ?? ''),
        responseIndices: [step.responseIndex],
        trailingStepCount: 0,
        steps: [step],
      };
      units.push(current);
    } else if (current) {
      current.endStepIndex = step.stepIndex;
      current.responseIndices.push(step.responseIndex);
      current.trailingStepCount += 1;
      current.steps.push(step);
    } else {
      current = {
        unitIndex: units.length + 1,
        anchorStepIndex: step.stepIndex,
        endStepIndex: step.stepIndex,
        anchorKind: null,
        anchorDecisionName: step.decisionName,
        anchorCard: extractCardFromLabel(step.label),
        anchorLabel: String(step.label ?? ''),
        anchorText: String(step.text ?? ''),
        responseIndices: [step.responseIndex],
        trailingStepCount: 0,
        steps: [step],
      };
      units.push(current);
    }
  }
  return units;
}

/**
 * Group action units into high-level combo phases aligned with the model's own
 * route narration. A new phase opens on a normal summon, on the first summon
 * following an effect resolution, or on an idle-cmd activation of a card that
 * was not fielded as the current phase's headliner.
 *
 * @param {YrpActionUnit[]} actionUnits
 * @returns {YrpPhaseGroup[]}
 */
function groupActionUnitsIntoPhases(actionUnits) {
  const units = Array.isArray(actionUnits) ? actionUnits : [];
  /** @type {YrpPhaseGroup[]} */
  const phases = [];
  /** @type {YrpPhaseGroup | null} */
  let current = null;
  let prevAnchorKind = null;

  for (const unit of units) {
    const kind = unit?.anchorKind ?? null;
    const cardName = typeof unit?.anchorCard === 'string' && unit.anchorCard
      ? unit.anchorCard
      : null;
    let openNew = false;

    if (!current) {
      openNew = true;
    } else if (kind === 'summon') {
      openNew = true;
    } else if (kind === 'spsummon') {
      openNew = prevAnchorKind !== 'spsummon';
    } else if (kind === 'activate') {
      openNew = Boolean(
        unit?.anchorDecisionName === IDLE_CMD_DECISION &&
          cardName !== null &&
          !current.headlinerCards.includes(cardName),
      );
    }

    if (openNew) {
      const headliners = cardName ? [cardName] : [];
      current = {
        phaseIndex: phases.length + 1,
        title: buildPhaseTitle(unit),
        headlinerCards: headliners,
        unitRange: [unit.unitIndex, unit.unitIndex],
        stepRange: [unit.anchorStepIndex, unit.endStepIndex],
        unitCount: 1,
        responseCount: unit.responseIndices.length,
        units: [unit],
        summary: unit.anchorLabel,
      };
      phases.push(current);
    } else if (current) {
      current.unitRange[1] = unit.unitIndex;
      current.stepRange[1] = unit.endStepIndex;
      current.unitCount += 1;
      current.responseCount += unit.responseIndices.length;
      current.units.push(unit);
      current.summary = `${current.summary} → ${unit.anchorLabel}`;
      if (
        (kind === 'summon' || kind === 'spsummon') &&
        cardName !== null &&
        !current.headlinerCards.includes(cardName)
      ) {
        current.headlinerCards.push(cardName);
      }
    }

    prevAnchorKind = kind;
  }

  return phases;
}

/** @param {YrpActionUnit | null | undefined} unit */
function buildPhaseTitle(unit) {
  if (!unit) return '未知阶段';
  const kind = unit.anchorKind;
  const card = unit.anchorCard ?? '';
  if (kind === 'summon') return card ? `通常召唤「${card}」` : '通常召唤';
  if (kind === 'spsummon') return card ? `特殊召唤「${card}」` : '特殊召唤';
  if (kind === 'activate') return card ? `发动「${card}」效果` : '发动效果';
  return unit.anchorLabel || '未知阶段';
}

/** @param {string | null | undefined} label */
function extractCardFromLabel(label) {
  if (typeof label !== 'string' || !label) return null;
  const match = label.match(/\[([^\]]+)\]\s*$/);
  return match ? match[1] : null;
}

/** @param {YrpPhaseGroup | null | undefined} phase */
function collectPhaseCardMentions(phase) {
  if (!phase || !Array.isArray(phase.units)) return [];
  const seen = new Set();
  const result = [];
  for (const unit of phase.units) {
    const steps = Array.isArray(unit?.steps) ? unit.steps : [];
    for (const step of steps) {
      const card = extractCardFromLabel(step?.label);
      if (card && !NON_CARD_TOKENS.has(card) && !seen.has(card)) {
        seen.add(card);
        result.push(card);
      }
    }
  }
  return result;
}

/** @param {BuildVisibleStepInput} input */
function buildVisibleStep({ action, decisionName, response, responseIndex, stepIndex, actionCount }) {
  return {
    stepIndex,
    responseIndex,
    responseHex: toHex(response),
    responseBase64: toBase64(response),
    decisionName,
    label: String(action?.label ?? ''),
    kind: typeof action?.kind === 'string' ? action.kind : null,
    text: typeof action?.text === 'string' ? action.text : '',
    actionCount,
  };
}

/**
 * @param {ReplayAction[]} actions
 * @param {Uint8Array} response
 */
function findMatchingAction(actions, response) {
  const exact = actions.find((action) => action?.response && sameBytes(toUint8Array(action.response), response));
  if (exact) return exact;

  if (response.byteLength === 4) {
    const intResponse = new DataView(response.buffer, response.byteOffset, response.byteLength).getInt32(0, true);
    return actions.find((action) => typeof action?.intResponse === 'number' && (action.intResponse | 0) === intResponse) ?? null;
  }
  return null;
}

/** @param {ReplayAction[]} actions */
function summarizeDecisionActions(actions) {
  return actions.map((action, index) => ({
    index,
    label: String(action?.label ?? ''),
    kind: typeof action?.kind === 'string' ? action.kind : null,
    responseHex: action?.response ? toHex(toUint8Array(action.response)) : null,
    intResponse: typeof action?.intResponse === 'number' ? action.intResponse : null,
  }));
}

/** @param {ReturnType<typeof summarizeDecisionActions>} actions */
function formatActionCandidateList(actions) {
  if (actions.length === 0) return '<none>';
  return actions
    .map((action) => {
      const response = action.responseHex ?? (action.intResponse === null ? 'n/a' : `int:${action.intResponse}`);
      return `${action.index}:${response}:${action.label}`;
    })
    .join(' | ');
}

export function getDefaultReplayResourcePaths() {
  return {
    cardsPath: DEFAULT_CARDS_DB,
    cardsPaths: resolveDefaultCardsDbPaths(),
    scriptDirs: resolveDefaultScriptDirs(),
    nativeScriptsRoot: DEFAULT_SCRIPTS_DIR,
  };
}

/**
 * Replay parsing must expose both players' decisions. The normal simulator
 * auto-responds for P1 so search can focus on P0, which corrupts a recorded
 * YRP response stream by consuming decisions the file still represents.
 *
 * @param {RunnerLike} runner
 * @param {number} maxLegalCandidates
 */
function exposeBothPlayersDecisions(runner, maxLegalCandidates) {
  if (typeof runner.tryBuildDecisionFromMessage !== 'function') {
    throw new Error('Runner does not support replay decision construction.');
  }
  const buildDecision = runner.tryBuildDecisionFromMessage.bind(runner);
  runner.tryAutoRespondDecisionMessage = () => null;
  runner.tryBuildDecisionFromMessage = (message, backend = null) => {
    const estimatedLegalCandidateCount = estimateSelectionCount(message, runner, maxLegalCandidates);
    const decision = estimatedLegalCandidateCount > maxLegalCandidates
      ? {
          terminal: false,
          reason: null,
          actions: [],
          message,
          lazyReplayDecision: true,
          estimatedLegalCandidateCount,
        }
      : buildDecision(message, backend);
    if (decision) {
      decision.responsePlayer = typeof message?.responsePlayer === 'function'
        ? message.responsePlayer()
        : null;
      if (!decision.estimatedLegalCandidateCount) {
        decision.estimatedLegalCandidateCount = Array.isArray(decision.actions) ? decision.actions.length : 0;
      }
    }
    return decision;
  };
}

/** @param {unknown} message @param {RunnerLike} runner @param {number} cap */
function estimateSelectionCount(message, runner, cap) {
  if (typeof runner.isMsgType !== 'function' || !runner.isMsgType(message, 'SelectCard')) return 0;
  const record = asRecord(message);
  const cards = Array.isArray(record.cards) ? record.cards : [];
  const cardCount = cards.length;
  const min = Math.max(0, Number(record.min ?? 1));
  const max = Math.max(min, Math.min(Number(record.max ?? min), cardCount));
  let total = min === 0 ? 1 : 0;
  for (let count = Math.max(1, min); count <= max; count += 1) {
    let selections = 1;
    for (let index = 0; index < count; index += 1) {
      selections *= cardCount - index;
      if (selections > cap) return selections;
    }
    total += selections;
    if (total > cap) return total;
  }
  return total;
}

/** @param {string | null} decisionName @param {number} candidateCount */
function createLazyReplayAction(decisionName, candidateCount) {
  return {
    label: `${decisionName ?? 'YGOPro decision'} (recorded large selection)`,
    kind: 'recorded-response',
    text: `Recorded response was injected directly; ${candidateCount} candidates were not expanded.`,
  };
}

/**
 * @param {InstanceType<typeof YGOProYrp>} replay
 * @param {number} yrpVersion
 */
function summarizeReplay(replay, yrpVersion) {
  return {
    yrpVersion,
    id: replay.header?.id ?? null,
    version: replay.header?.version ?? null,
    flag: replay.header?.flag ?? null,
    seed: replay.header?.seed ?? null,
    headerVersion: replay.header?.headerVersion ?? null,
    seedSequence: Array.isArray(replay.header?.seedSequence)
      ? replay.header.seedSequence.map((value) => value >>> 0)
      : [],
    hostName: replay.hostName ?? '',
    clientName: replay.clientName ?? '',
    startLp: replay.startLp ?? null,
    startHand: replay.startHand ?? null,
    drawCount: replay.drawCount ?? null,
    opt: replay.opt ?? null,
  };
}

/** @param {InstanceType<typeof YGOProYrp>} replay */
function inferYrpVersion(replay) {
  const headerVersion = Number(replay.header?.headerVersion ?? 0);
  const seedSequence = replay.header?.seedSequence;
  return headerVersion > 0 || (Array.isArray(seedSequence) && seedSequence.length > 0) ? 2 : 1;
}

/** @param {unknown} deck */
function toPlainDeck(deck) {
  const record = asRecord(deck);
  return {
    main: normalizeCodeList(record.main),
    extra: normalizeCodeList(record.extra),
    side: normalizeCodeList(record.side),
  };
}

/**
 * @param {number[]} main
 * @param {number} startHand
 * @param {string} label
 */
function deriveOpeningFromReplayMain(main, startHand, label) {
  const safeStartHand = Math.max(0, Math.min(main.length, startHand));
  return {
    opening: main.slice(main.length - safeStartHand).reverse(),
    remain: main.slice(0, main.length - safeStartHand),
    label,
  };
}

/**
 * @param {number[]} codes
 * @param {CardTextLike | undefined} cardText
 */
function nameCards(codes, cardText) {
  return codes.map((code) => ({
    code,
    name: safeCardName(cardText, code),
  }));
}

/**
 * @param {CardTextLike | undefined} cardText
 * @param {number} code
 */
function safeCardName(cardText, code) {
  try {
    if (cardText && typeof cardText.getName === 'function') {
      const name = cardText.getName(code);
      if (typeof name === 'string' && name.trim()) return name.trim();
    }
  } catch {
    // Fall back to the passcode below.
  }
  return String(code >>> 0);
}

/** @param {PlainDeck} deck */
function countDeck(deck) {
  return {
    main: deck.main.length,
    extra: deck.extra.length,
    side: deck.side.length,
  };
}

/** @param {RunnerLike} runner */
function capturePublicCounts(runner) {
  if (typeof runner.captureSnapshot !== 'function') return null;
  const snapshot = asRecord(runner.captureSnapshot());
  return {
    lp: Array.isArray(snapshot.lp) ? snapshot.lp.map((value) => Number(value)) : null,
    player: countSnapshotZones(snapshot.p0),
    opponent: countSnapshotZones(snapshot.p1),
  };
}

/** @param {unknown} value */
function countSnapshotZones(value) {
  const player = asRecord(value);
  return {
    hand: Array.isArray(player.hand) ? player.hand.length : 0,
    deck: Array.isArray(player.deck) ? player.deck.length : 0,
    extra: Array.isArray(player.extra) ? player.extra.length : 0,
    grave: Array.isArray(player.grave) ? player.grave.length : 0,
    banished: Array.isArray(player.banished) ? player.banished.length : 0,
    monsterZone: Array.isArray(player.mzone) ? player.mzone.length : 0,
    spellTrapZone: Array.isArray(player.szone) ? player.szone.length : 0,
  };
}

/**
 * @param {RunnerLike} runner
 * @param {unknown[]} history
 * @param {string} key
 */
function setRunnerActionHistory(runner, history, key) {
  if (typeof runner?.setActionHistory === 'function') {
    runner.setActionHistory(history, key);
    return;
  }
  runner.actionHistory = history;
  runner.actionHistoryKey = key;
}

/** @param {RunnerLike} runner */
function removeReplayParseBudgets(runner) {
  const record = asRecord(runner);
  const config = asRecord(record.config);
  record.config = {
    ...config,
    maxDepth: UNBOUNDED_REPLAY_PARSE_BUDGET,
    maxNodes: UNBOUNDED_REPLAY_PARSE_BUDGET,
    maxBeamWidth: UNBOUNDED_REPLAY_PARSE_BUDGET,
    maxActionsPerNode: UNBOUNDED_REPLAY_PARSE_BUDGET,
    maxProcessPerStep: UNBOUNDED_REPLAY_PARSE_BUDGET,
  };
}

function buildYgoPro2ClientTrace(options, replayBackend) {
  const container = readContainer(options.container);
  const payload = options.originalPayload;
  if (container?.format !== 'embedded-yrp' || !(payload instanceof Uint8Array)) return null;
  const embeddedOffset = Number(container.embeddedOffset ?? 0);
  if (!Number.isSafeInteger(embeddedOffset) || embeddedOffset <= 0) return null;

  const cardNames = createTraceCardNameResolver(replayBackend.cardsPaths ?? [replayBackend.cardsPath]);
  const packets = readYgoPro2ClientPackets(payload.subarray(0, embeddedOffset));
  /** @type {YrpRouteWarning[]} */
  const warnings = [];
  /** @type {YgoPro2TraceEvent[]} */
  const events = [];

  for (const packet of packets) {
    const parsed = parseYgoPro2PacketMessage(packet, warnings);
    if (!parsed) continue;
    const event = buildClientTraceEvent(parsed, cardNames);
    if (event) events.push(event);
  }

  return {
    source: 'ygopro2-client-message-stream',
    packetCount: packets.length,
    eventCount: events.length,
    markdown: buildClientTraceMarkdown(events, packets.length),
    events,
    warnings,
  };
}

function createTraceCardNameResolver(cardsPaths) {
  let db = null;
  try {
    db = openCardsDatabase({ dbPaths: cardsPaths });
  } catch {
    db = null;
  }
  /** @type {Map<number, string>} */
  const cache = new Map();
  return (code) => {
    const normalized = Number(code) >>> 0;
    if (!normalized) return '';
    if (cache.has(normalized)) return cache.get(normalized);
    let name = String(normalized);
    try {
      const card = db?.getById(normalized);
      if (card?.name) name = card.name;
    } catch {
      // Fall back to passcode.
    }
    cache.set(normalized, name);
    return name;
  };
}

/** @param {Uint8Array} bytes */
function readYgoPro2ClientPackets(bytes) {
  const packets = [];
  let offset = 0;
  while (offset + 5 <= bytes.byteLength) {
    const type = bytes[offset] ?? 0;
    const length = readUInt32Le(bytes, offset + 1);
    const payloadOffset = offset + 5;
    const end = payloadOffset + length;
    if (!Number.isSafeInteger(length) || length < 0 || end > bytes.byteLength) break;
    packets.push({
      packetIndex: packets.length,
      packetOffset: offset,
      type,
      length,
      payload: bytes.subarray(payloadOffset, end),
    });
    offset = end;
  }
  return packets;
}

function parseYgoPro2PacketMessage(packet, warnings) {
  const registry = ygoproMsg?.YGOProMessages;
  if (!registry || typeof registry.getInstanceFromPayload !== 'function') return null;
  if (!isRouteRelevantYgoPro2Packet(packet.type)) return null;
  const body = new Uint8Array(packet.payload.byteLength + 1);
  body[0] = packet.type;
  body.set(packet.payload, 1);
  try {
    const message = registry.getInstanceFromPayload(body);
    return { packet, message };
  } catch (error) {
    warnings.push({
      code: 'YGOPRO2_PACKET_PARSE_FAILED',
      message: `YGOPro2 packet ${packet.packetIndex} type ${packet.type} parse failed: ${String(error?.message ?? error)}`,
      details: {
        packetIndex: packet.packetIndex,
        packetOffset: packet.packetOffset,
        type: packet.type,
        length: packet.length,
      },
    });
    return null;
  }
}

function isRouteRelevantYgoPro2Packet(type) {
  return [
    11, // MSG_SELECT_IDLECMD
    15, // MSG_SELECT_CARD
    16, // MSG_SELECT_CHAIN
    18, // MSG_SELECT_PLACE
    19, // MSG_SELECT_POSITION
    26, // MSG_SELECT_UNSELECT_CARD
    50, // MSG_MOVE
    60, // MSG_SUMMONING
    61, // MSG_SUMMONED
    62, // MSG_SPSUMMONING
    63, // MSG_SPSUMMONED
    70, // MSG_CHAINING
  ].includes(type);
}

function buildClientTraceEvent(parsed, cardName) {
  const { packet, message } = parsed;
  const messageName = message?.constructor?.name ?? `MSG_${packet.type}`;
  const base = {
    packetIndex: packet.packetIndex,
    packetOffset: packet.packetOffset,
    type: packet.type,
    messageName,
  };

  if (messageName === 'YGOProMsgMove') {
    const code = Number(message.code) >>> 0;
    const name = cardName(code);
    return {
      ...base,
      kind: 'move',
      code,
      cardName: name,
      label: `移动[${name}] ${formatLocation(message.previous)} -> ${formatLocation(message.current)} reason=${message.reason ?? ''}`,
      details: compactMessageDetails(message),
    };
  }
  if (messageName === 'YGOProMsgSummoning') {
    const code = Number(message.code) >>> 0;
    const name = cardName(code);
    return { ...base, kind: 'summon', code, cardName: name, label: `通常召唤中[${name}]`, details: compactMessageDetails(message) };
  }
  if (messageName === 'YGOProMsgSpSummoning') {
    const code = Number(message.code) >>> 0;
    const name = cardName(code);
    return { ...base, kind: 'spsummon', code, cardName: name, label: `特殊召唤中[${name}]`, details: compactMessageDetails(message) };
  }
  if (messageName === 'YGOProMsgChaining') {
    const code = Number(message.code) >>> 0;
    const name = cardName(code);
    return {
      ...base,
      kind: 'activate',
      code,
      cardName: name,
      label: `发动/连锁[${name}] chain=${message.chainCount ?? ''} desc=${message.desc ?? ''}`,
      details: compactMessageDetails(message),
    };
  }
  if (messageName === 'YGOProMsgSelectCard') {
    const cards = normalizeTraceCards(message.cards, cardName);
    return {
      ...base,
      kind: 'select-card',
      label: `选择卡片 ${message.min ?? '?'}..${message.max ?? '?'} / 候选: ${cards.map((card) => card.name).join('、')}`,
      details: {
        player: message.player ?? null,
        min: message.min ?? null,
        max: message.max ?? null,
        count: message.count ?? cards.length,
        cards,
      },
    };
  }
  if (messageName === 'YGOProMsgSelectUnselectCard') {
    const selectable = normalizeTraceCards(message.selectableCards, cardName);
    const unselectable = normalizeTraceCards(message.unselectableCards, cardName);
    return {
      ...base,
      kind: 'select-unselect-card',
      label: `选择/取消选择卡片 ${message.min ?? '?'}..${message.max ?? '?'} / 可选: ${selectable.map((card) => card.name).join('、')} / 已选: ${unselectable.map((card) => card.name).join('、')}`,
      details: {
        player: message.player ?? null,
        min: message.min ?? null,
        max: message.max ?? null,
        selectable,
        unselectable,
      },
    };
  }
  if (messageName === 'YGOProMsgSelectChain') {
    const chains = normalizeTraceCards(message.chains, cardName);
    return {
      ...base,
      kind: 'select-chain',
      label: chains.length > 0 ? `选择连锁候选: ${chains.map((card) => card.name).join('、')}` : '选择连锁: 无候选/不连锁',
      details: {
        player: message.player ?? null,
        count: message.count ?? chains.length,
        chains,
      },
    };
  }
  if (messageName === 'YGOProMsgSelectIdleCmd') {
    const summonable = normalizeTraceCards(message.summonableCards, cardName);
    const spSummonable = normalizeTraceCards(message.spSummonableCards, cardName);
    const activatable = normalizeTraceCards(message.activatableCards, cardName);
    return {
      ...base,
      kind: 'select-idle',
      label: [
        summonable.length ? `可通召: ${summonable.map((card) => card.name).join('、')}` : '',
        spSummonable.length ? `可特召: ${spSummonable.map((card) => card.name).join('、')}` : '',
        activatable.length ? `可发动: ${activatable.map((card) => card.name).join('、')}` : '',
      ].filter(Boolean).join(' / ') || '空闲命令选择',
      details: { summonable, spSummonable, activatable },
    };
  }
  if (messageName === 'YGOProMsgSelectPlace' || messageName === 'YGOProMsgSelectPosition') {
    const places = messageName === 'YGOProMsgSelectPlace' ? normalizeTracePlaces(message.places ?? message.selectablePlaces ?? message.getSelectablePlaces?.()) : [];
    const positionText = messageName === 'YGOProMsgSelectPosition' ? formatPositionMask(message.positions ?? message.position) : '';
    return {
      ...base,
      kind: 'select-place',
      label: messageName === 'YGOProMsgSelectPlace'
        ? `选择区域: ${places.length ? places.map(formatPlaceChoiceLabel).join(' / ') : '未知区域'}`
        : `选择表示形式[${cardName(Number(message.code) >>> 0)}] ${positionText}`.trim(),
      details: {
        ...compactMessageDetails(message),
        ...(places.length ? { places } : {}),
      },
    };
  }
  if (messageName === 'YGOProMsgSummoned' || messageName === 'YGOProMsgSpSummoned') {
    return { ...base, kind: 'summon-complete', label: messageName === 'YGOProMsgSummoned' ? '通常召唤完成' : '特殊召唤完成', details: {} };
  }
  return null;
}

function normalizeTraceCards(cards, cardName) {
  if (!Array.isArray(cards)) return [];
  return cards.map((card, index) => {
    const code = Number(card?.code) >>> 0;
    return {
      index,
      code,
      name: cardName(code),
      controller: Number.isFinite(Number(card?.controller)) ? Number(card.controller) : null,
      location: Number.isFinite(Number(card?.location)) ? Number(card.location) : null,
      sequence: Number.isFinite(Number(card?.sequence)) ? Number(card.sequence) : null,
      subsequence: Number.isFinite(Number(card?.subsequence)) ? Number(card.subsequence) : null,
      desc: Number.isFinite(Number(card?.desc)) ? Number(card.desc) : null,
    };
  });
}

function normalizeTracePlaces(places) {
  if (!Array.isArray(places)) return [];
  return places.map((place) => ({
    player: normalizeNullableNumber(place?.player ?? place?.controller),
    location: normalizeNullableNumber(place?.location),
    sequence: normalizeNullableNumber(place?.sequence),
    position: normalizeNullableNumber(place?.position),
  }));
}

function compactMessageDetails(message) {
  const out = {};
  for (const [key, value] of Object.entries(message ?? {})) {
    if (typeof value === 'function') continue;
    if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
      out[key] = value;
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = Object.fromEntries(Object.entries(value).filter(([, nested]) => typeof nested !== 'function'));
    }
  }
  return out;
}

function buildClientTraceMarkdown(events, packetCount) {
  const lines = [
    `- 来源: YGOPro2 .yrp3d 客户端消息流`,
    `- 消息包: ${packetCount}`,
    `- 路线事件: ${events.length}`,
    '- 说明: 这些事件来自 YGOPro2 已保存的客户端过程消息，优先于重新推演候选顺序。',
    '',
    '### 客户端事件序列',
  ];
  for (const event of events) {
    lines.push(`${event.packetIndex}. [${event.kind}] ${event.label}`);
  }
  return lines.join('\n');
}

function formatLocation(location) {
  if (!location || typeof location !== 'object') return '?';
  return formatPlaceChoiceLabel({
    player: location.player ?? location.controller,
    location: location.location,
    sequence: location.sequence,
    position: location.position,
  });
}

function formatPlaceChoiceLabel(place) {
  const player = normalizeNullableNumber(place?.player ?? place?.controller);
  const location = normalizeNullableNumber(place?.location);
  const sequence = normalizeNullableNumber(place?.sequence);
  const position = normalizeNullableNumber(place?.position);
  const parts = [
    `P${player ?? '?'}`,
    describePlaceZone(location, sequence),
    `seq=${sequence ?? '?'}`,
  ];
  if (position !== null) parts.push(`pos=${position}`);
  return parts.join(' ');
}

function describePlaceZone(location, sequence = null) {
  switch (location) {
    case 0x04:
      return sequence === 5 || sequence === 6 ? `额外怪兽区${sequence}` : `主怪兽区${sequence ?? '?'}`;
    case 0x08:
      return `魔法陷阱区${sequence ?? '?'}`;
    case 0x10:
      return `场地区${sequence ?? '?'}`;
    case 0x20:
      return `墓地区${sequence ?? '?'}`;
    case 0x40:
      return `除外区${sequence ?? '?'}`;
    default:
      return `区域L${location ?? '?'}`;
  }
}

function formatPositionMask(value) {
  const mask = Number(value);
  if (!Number.isFinite(mask)) return '';
  const positions = [];
  if ((mask & 0x1) !== 0) positions.push('表攻');
  if ((mask & 0x2) !== 0) positions.push('里攻');
  if ((mask & 0x4) !== 0) positions.push('表守');
  if ((mask & 0x8) !== 0) positions.push('里守');
  return positions.length ? `候选: ${positions.join('/')}` : `mask=${mask}`;
}

function normalizeNullableNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function readUInt32Le(bytes, offset) {
  if (offset + 4 > bytes.byteLength) return 0;
  return (
    (bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16) |
    ((bytes[offset + 3] ?? 0) << 24)
  ) >>> 0;
}

async function resolveReplayBackendOptions(options) {
  const explicitBackend = readNonEmptyString(options.engineBackend);
  const explicitCardsPath = readNonEmptyString(options.cardsPath);
  const explicitCardsPaths = normalizeScriptDirs(options.cardsPaths ?? options.cardsDbs ?? options.cardsDbPaths ?? options.dbPaths);
  const explicitScriptDirs = normalizeScriptDirs(options.scriptDirs ?? options.scriptsDir);
  const explicitNativeScriptsRoot = readNonEmptyString(options.nativeScriptsRoot);
  const explicitNativeOcgcoreDllPath = readNonEmptyString(options.nativeOcgcoreDllPath ?? options.ocgcoreDllPath);
  const wantsYgoPro2 = readBoolean(options.ygopro2Compatible) || explicitBackend === 'ygopro2';
  const ygopro2Root = detectYgoPro2Root(options);
  const ygopro2Paths = ygopro2Root ? getYgoPro2ResourcePaths(ygopro2Root) : null;
  const canUseYgoPro2 =
    Boolean(ygopro2Paths?.cardsPath && existsSync(ygopro2Paths.cardsPath)) &&
    Boolean(ygopro2Paths?.scriptsDir && existsSync(ygopro2Paths.scriptsDir)) &&
    Boolean(ygopro2Paths?.ocgcoreDllPath && existsSync(ygopro2Paths.ocgcoreDllPath));

  if (wantsYgoPro2 && canUseYgoPro2) {
    const ygopro2ScriptRoot = await prepareYgoPro2ScriptRoot(ygopro2Paths);
    return {
      engineBackend: explicitBackend && explicitBackend !== 'ygopro2' ? explicitBackend : 'native',
      cardsPath: explicitCardsPath ?? ygopro2Paths.cardsPath,
      cardsPaths: explicitCardsPaths.length > 0 ? explicitCardsPaths : [explicitCardsPath ?? ygopro2Paths.cardsPath],
      scriptDirs: explicitScriptDirs.length > 0 ? explicitScriptDirs : [join(ygopro2ScriptRoot, 'script')],
      nativeScriptsRoot: explicitNativeScriptsRoot ?? ygopro2ScriptRoot,
      nativeOcgcoreDllPath: explicitNativeOcgcoreDllPath ?? ygopro2Paths.ocgcoreDllPath,
    };
  }

  return {
    engineBackend: explicitBackend === 'ygopro2' ? 'native' : (explicitBackend ?? 'js'),
    cardsPath: explicitCardsPath ?? (explicitCardsPaths.at(-1) ?? DEFAULT_CARDS_DB),
    cardsPaths: explicitCardsPaths.length > 0
      ? explicitCardsPaths
      : (explicitCardsPath ? [explicitCardsPath] : resolveDefaultCardsDbPaths()),
    scriptDirs: explicitScriptDirs.length > 0 ? explicitScriptDirs : resolveDefaultScriptDirs(),
    nativeScriptsRoot: explicitNativeScriptsRoot ?? (explicitScriptDirs[0] ?? DEFAULT_SCRIPTS_DIR),
    nativeOcgcoreDllPath: explicitNativeOcgcoreDllPath ?? null,
  };
}

function resolveDefaultCardsDbPaths() {
  return [
    resolve(DEFAULT_PRERELEASE_ROOT, 'test-update.cdb'),
    resolve(DEFAULT_PRERELEASE_ROOT, 'test-release.cdb'),
    DEFAULT_CARDS_DB,
  ].filter((path) => existsSync(path));
}

function resolveDefaultScriptDirs() {
  return [
    resolve(DEFAULT_PRERELEASE_ROOT, 'script'),
    DEFAULT_SCRIPTS_DIR,
  ].filter((path) => existsSync(path));
}

function detectYgoPro2Root(options) {
  const explicitRoot = readNonEmptyString(options.ygopro2Root ?? options.ygoPro2Root);
  const candidates = [
    explicitRoot,
    readNonEmptyString(process.env.YGOPRO2_ROOT),
    readNonEmptyString(process.env.YGO_PRO2_ROOT),
    DEFAULT_YGOPRO2_ROOT,
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function getYgoPro2ResourcePaths(root) {
  const base = resolve(root);
  return {
    root: base,
    cardsPath: join(base, 'cdb', 'cards.cdb'),
    scriptsDir: join(base, 'script'),
    scriptZipPath: join(base, 'data', 'script.zip'),
    ocgcoreDllPath: join(base, 'YGOPro2_Data', 'Plugins', 'ocgcore.dll'),
  };
}

async function prepareYgoPro2ScriptRoot(paths) {
  const cacheRoot = DEFAULT_YGOPRO2_SCRIPT_CACHE_ROOT;
  const requiredScript = join(cacheRoot, 'script', 'c68353324.lua');
  const requiredUtility = join(cacheRoot, 'script', 'constant.lua');
  if (existsSync(requiredScript) && existsSync(requiredUtility)) {
    return cacheRoot;
  }
  if (!existsSync(paths.scriptZipPath)) {
    return paths.root;
  }
  await mkdir(cacheRoot, { recursive: true });
  execFileSync('tar.exe', ['-xf', paths.scriptZipPath, '-C', cacheRoot], { stdio: 'ignore' });
  return cacheRoot;
}

function readBoolean(value) {
  if (value === true) return true;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
  }
  return false;
}

/** @param {unknown} payload */
function normalizePayload(payload) {
  if (payload instanceof Uint8Array) return payload;
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
  throw Object.assign(new Error('YRP payload must be a Uint8Array, Buffer, or ArrayBuffer.'), {
    code: 'INVALID_PAYLOAD',
  });
}

/**
 * @param {Uint8Array} bytes
 * @returns {{ bytes: Uint8Array, container: Record<string, unknown> | null }}
 */
function extractEmbeddedYrpPayload(bytes) {
  const offset = findReplayHeaderOffset(bytes);
  if (offset <= 0) {
    return { bytes, container: null };
  }
  return {
    bytes: bytes.subarray(offset),
    container: {
      format: 'embedded-yrp',
      embeddedOffset: offset,
      embeddedLength: bytes.byteLength - offset,
      originalLength: bytes.byteLength,
    },
  };
}

/** @param {Uint8Array} bytes */
function findReplayHeaderOffset(bytes) {
  if (bytes.byteLength < 4) return -1;
  if (isReplayHeaderAt(bytes, 0)) return 0;
  for (let offset = 1; offset <= bytes.byteLength - 4; offset += 1) {
    if (isReplayHeaderAt(bytes, offset)) return offset;
  }
  return -1;
}

/**
 * @param {Uint8Array} bytes
 * @param {number} offset
 */
function isReplayHeaderAt(bytes, offset) {
  const id =
    (bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16) |
    ((bytes[offset + 3] ?? 0) << 24);
  return (id >>> 0) === REPLAY_ID_YRP1 || (id >>> 0) === REPLAY_ID_YRP2;
}

/** @param {unknown} value */
function toUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return Uint8Array.from(value);
  return new Uint8Array(0);
}

/**
 * @param {Uint8Array | null | undefined} left
 * @param {Uint8Array | null | undefined} right
 */
function sameBytes(left, right) {
  if (!left || !right || left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/** @param {Uint8Array | null | undefined} bytes */
function toHex(bytes) {
  return Buffer.from(bytes ?? new Uint8Array(0)).toString('hex');
}

/** @param {Uint8Array | null | undefined} bytes */
function toBase64(bytes) {
  return Buffer.from(bytes ?? new Uint8Array(0)).toString('base64');
}

/** @param {unknown} values */
function normalizeCodeList(values) {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => Number(value) >>> 0)
    .filter((value) => Number.isSafeInteger(value) && value > 0);
}

/** @param {unknown} value */
function normalizeScriptDirs(value) {
  if (Array.isArray(value)) {
    const dirs = value.map(readNonEmptyString).filter(Boolean);
    return dirs;
  }
  const single = readNonEmptyString(value);
  return single ? [single] : [];
}

/**
 * @param {unknown} value
 * @param {number} fallback
 */
function normalizeUInt32(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number >>> 0 : fallback >>> 0;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 */
function normalizeNonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : fallback;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 */
function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : fallback;
}

/** @param {unknown} value */
function readNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/** @param {unknown} value */
function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/** @param {unknown} value */
function readContainer(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = /** @type {Record<string, unknown>} */ (value);
  return Object.keys(record).length > 0 ? record : null;
}

/**
 * @param {unknown} error
 * @param {string | null} [sourcePath]
 * @returns {YrpRouteParseResult}
 */
function formatParseError(error, sourcePath = null) {
  const record = asRecord(error);
  return {
    ok: false,
    code: typeof record.code === 'string' ? record.code : 'YRP_ROUTE_PARSE_FAILED',
    error: error instanceof Error ? error.message : String(error),
    ...(sourcePath ? { sourcePath } : {}),
  };
}
