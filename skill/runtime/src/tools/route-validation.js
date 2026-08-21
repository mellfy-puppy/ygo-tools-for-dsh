// @ts-check

import { openCardsDatabase } from '../database/cards-db.js';

const SESSION_DECK_KEY = 'currentDeck';
const VERIFIED_CLAIM_PATTERN = /引擎实测|实机验证|实际可打出|已验证|最优路线|终场一览|路线报告/;
const ENGINE_CLAIM_PATTERN = /引擎实测|实机验证|实际可打出/;
const COMPLETED_ROUTE_CLAIM_PATTERN = /引擎实测|实机验证|实际可打出|已验证|最优路线|终场一览|路线报告|已保存|\.yrp|录像|完整推导|路线已|核心验证|单卡展开|展开路线|推导完成|完成路线/;
const EXECUTION_VERB_PATTERN = /检索|发动|苏生|召唤|特召|通常召唤|超量|链接|盖放|送墓|加入手牌|上场|取除素材|位于|场上|墓地|手牌/;
const NEGATIVE_OR_HYPOTHETICAL_PATTERN = /不可达|无法|不能|未能|没有|不在|至少需要|额外|补卡|方案|假设|如果|建议|例如/;
const HYPOTHETICAL_HEADING_PATTERN = /补卡|方案|假设|建议|改进|至少需要|如果/;
const QUOTED_NAME_PATTERN = /[「《“"]([^」》”"]{2,60})[」》”"]/g;

/** @type {{ dbPath: string, db: ReturnType<typeof openCardsDatabase> } | null} */
let sharedCardsDb = null;

/**
 * Validate that a final route/report does not present unsupported claims as
 * engine-verified facts.
 *
 * @param {unknown} context
 * @param {string} content
 */
export function validateVerifiedRouteReport(context, content) {
  const session = resolveSession(context);
  if (!session) return { ok: true, warnings: [] };

  const text = content.trim();
  if (!text) return { ok: true, warnings: [] };

  const errors = [];
  const warnings = [];
  const evidence = collectToolEvidence(session);
  const deck = readSessionDeck(session);
  const pendingDecision = readBlockingPendingDecision(session);

  if (ENGINE_CLAIM_PATTERN.test(text) && evidence.engineAdvanceCount === 0) {
    errors.push('Report claims an engine-tested route, but this session has no successful executeAction or simulateActions tool result.');
  }

  if (pendingDecision && COMPLETED_ROUTE_CLAIM_PATTERN.test(text)) {
    errors.push([
      'Report claims a completed/saved route while the engine is still waiting for an unresolved decision.',
      `Current decision: ${pendingDecision.name}; actions: ${pendingDecision.actions.map((action) => `${action.index}:${action.label}`).join(' | ')}.`,
      'Resolve the pending engine choice with executeAction, or explicitly report that the route/replay is not complete yet.',
    ].join(' '));
  }

  if (deck && VERIFIED_CLAIM_PATTERN.test(text)) {
    const unavailableMentions = findUnavailableExecutedCardMentions(text, deck, resolveCardsDb(context));
    for (const mention of unavailableMentions) {
      errors.push(`Verified route mentions unavailable card "${mention.name}" in an executed step: ${mention.line.trim()}`);
    }
  } else if (!deck && VERIFIED_CLAIM_PATTERN.test(text)) {
    warnings.push('No loaded session deck was found while validating a verified route report.');
  }

  return errors.length > 0
    ? { ok: false, error: buildValidationError(errors), data: { errors, warnings, evidence } }
    : { ok: true, warnings, data: { evidence } };
}

/**
 * @param {string[]} errors
 */
function buildValidationError(errors) {
  return [
    'Verified route report rejected because it is not fully supported by tool evidence.',
    ...errors.map((error) => `- ${error}`),
    'Re-check the loaded deck and engine actions before saving or finishing.',
  ].join('\n');
}

/**
 * @param {string} text
 * @param {{ main: number[], extra: number[], side: number[] }} deck
 * @param {ReturnType<typeof openCardsDatabase>} cardsDb
 */
function findUnavailableExecutedCardMentions(text, deck, cardsDb) {
  const legalDeckIds = new Set([...deck.main, ...deck.extra]);
  const lines = text.split(/\r?\n/);
  const findings = [];
  let inHypotheticalSection = false;

  for (const line of lines) {
    const heading = /^(#{1,6})\s*(.+)$/.exec(line);
    if (heading) {
      inHypotheticalSection = HYPOTHETICAL_HEADING_PATTERN.test(heading[2]);
    }

    if (inHypotheticalSection) continue;
    if (!EXECUTION_VERB_PATTERN.test(line)) continue;
    if (NEGATIVE_OR_HYPOTHETICAL_PATTERN.test(line)) continue;

    QUOTED_NAME_PATTERN.lastIndex = 0;
    for (const match of line.matchAll(QUOTED_NAME_PATTERN)) {
      const name = match[1].trim();
      const card = safeGetCardByName(cardsDb, name);
      if (!card) continue;
      const id = Number(card.id);
      if (!Number.isSafeInteger(id) || legalDeckIds.has(id)) continue;
      findings.push({ id, name: card.name ?? name, line });
    }
  }

  return findings;
}

/** @param {unknown} session */
function collectToolEvidence(session) {
  const toolNamesById = new Map();
  let successfulExecuteAction = 0;
  let successfulSimulateActions = 0;
  let successfulResetGame = 0;

  for (const message of arrayValue(asRecord(session).conversationHistory)) {
    for (const block of arrayValue(asRecord(message).content)) {
      const record = asRecord(block);
      if (record.type === 'tool_use') {
        const id = readNonEmptyString(record.id);
        const name = readNonEmptyString(record.name);
        if (id && name) toolNamesById.set(id, name);
      } else if (record.type === 'tool_result') {
        const id = readNonEmptyString(record.tool_use_id);
        const name = id ? toolNamesById.get(id) : null;
        const result = parseToolResult(record.content);
        if (!name || asRecord(result).ok === false) continue;
        if (name === 'executeAction') successfulExecuteAction += 1;
        if (name === 'simulateActions') successfulSimulateActions += 1;
        if (name === 'resetGame') successfulResetGame += 1;
      }
    }
  }

  return {
    successfulExecuteAction,
    successfulSimulateActions,
    successfulResetGame,
    engineAdvanceCount: successfulExecuteAction + successfulSimulateActions,
  };
}

/** @param {unknown} value */
function parseToolResult(value) {
  const text = readNonEmptyString(value);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** @param {unknown} context */
function resolveCardsDb(context) {
  const record = asRecord(context);
  const candidates = [
    record.cardsDb,
    asRecord(record.runner).cardsDb,
    asRecord(asRecord(record.session).runner).cardsDb,
  ];
  for (const candidate of candidates) {
    if (isCardsDbLike(candidate)) return /** @type {ReturnType<typeof openCardsDatabase>} */ (candidate);
  }

  const dbPaths = readPathArray(record.dbPaths) ?? readPathArray(record.cardsDbPaths);
  const dbPath = readNonEmptyString(record.dbPath) ?? '<default>';
  const cacheKey = dbPaths ? JSON.stringify(dbPaths) : dbPath;
  if (sharedCardsDb?.dbPath === cacheKey) return sharedCardsDb.db;
  if (sharedCardsDb?.db.close) sharedCardsDb.db.close();
  sharedCardsDb = {
    dbPath: cacheKey,
    db: dbPaths ? openCardsDatabase({ dbPaths }) : openCardsDatabase(dbPath === '<default>' ? {} : { dbPath }),
  };
  return sharedCardsDb.db;
}

/** @param {unknown} value */
function readPathArray(value) {
  if (!Array.isArray(value)) return null;
  const paths = value.map(readNonEmptyString).filter(Boolean);
  return paths.length > 0 ? paths : null;
}

/**
 * @param {ReturnType<typeof openCardsDatabase>} cardsDb
 * @param {string} name
 */
function safeGetCardByName(cardsDb, name) {
  try {
    return cardsDb.getByName(name);
  } catch {
    return null;
  }
}

/** @param {unknown} value */
function isCardsDbLike(value) {
  const record = asRecord(value);
  return typeof record.getByName === 'function' && typeof record.getById === 'function';
}

/** @param {unknown} context */
function resolveSession(context) {
  const record = asRecord(context);
  if (isRecord(record.metadata)) return record;
  const session = asRecord(record.session);
  return isRecord(session.metadata) ? session : null;
}

/** @param {unknown} session */
function readSessionDeck(session) {
  const deck = asRecord(asRecord(session).metadata)[SESSION_DECK_KEY];
  if (!Array.isArray(asRecord(deck).main) || !Array.isArray(asRecord(deck).extra)) return null;
  return {
    main: normalizeCardIds(asRecord(deck).main),
    extra: normalizeCardIds(asRecord(deck).extra),
    side: normalizeCardIds(asRecord(deck).side),
  };
}

/** @param {unknown} session */
function readBlockingPendingDecision(session) {
  const decision = asRecord(asRecord(asRecord(session).runner).currentDecision);
  if (!decision || decision.terminal === true) return null;
  const actions = Array.isArray(decision.actions) ? decision.actions : [];
  if (actions.length === 0) return null;

  const name = readNonEmptyString(decision.messageName) ??
    readNonEmptyString(asRecord(asRecord(decision.message).constructor).name) ??
    readNonEmptyString(decision.name) ??
    readNonEmptyString(decision.reason) ??
    'unknown';
  if (/SelectIdleCmd/i.test(name)) return null;
  if (actions.every(isPhaseLikeAction)) return null;

  return {
    name,
    actions: actions.map((action, index) => ({
      index,
      label: readNonEmptyString(asRecord(action).label) ?? `Action #${index}`,
      kind: readNonEmptyString(asRecord(action).kind) ?? '',
    })),
  };
}

/** @param {unknown} action */
function isPhaseLikeAction(action) {
  const record = asRecord(action);
  const kind = (readNonEmptyString(record.kind) ?? '').toLowerCase();
  const text = `${readNonEmptyString(record.label) ?? ''} ${readNonEmptyString(record.text) ?? ''}`;
  return kind.includes('phase') || /结束回合|进入.*阶段|主要阶段|end turn|phase/i.test(text);
}

/** @param {unknown} value */
function normalizeCardIds(value) {
  return arrayValue(value)
    .map((entry) => Number(entry))
    .filter((entry) => Number.isSafeInteger(entry) && entry > 0);
}

/** @param {unknown} value */
function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

/** @param {unknown} value */
function readNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/** @param {unknown} value */
function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} value */
function asRecord(value) {
  return isRecord(value) ? /** @type {Record<string, unknown>} */ (value) : {};
}
