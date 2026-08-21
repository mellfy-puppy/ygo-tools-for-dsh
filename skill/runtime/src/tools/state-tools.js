// @ts-check

const DEFAULT_GRAVEYARD_LIMIT = 10;
const MAX_GRAVEYARD_LIMIT = 20;
const UNKNOWN_CARD_NAME = 'Unknown card';
const ACTION_CATEGORIES = ['summon', 'spsummon', 'activate', 'set', 'battle', 'phase', 'other'];
const DEFAULT_ACTION_LIMIT = 100;
const MAX_ACTION_LIMIT = 500;
const TYPE_LINK = 0x4000000;
const LINK_MARKERS = [
  { bit: 0x001, label: '左下' },
  { bit: 0x002, label: '下' },
  { bit: 0x004, label: '右下' },
  { bit: 0x008, label: '左' },
  { bit: 0x020, label: '右' },
  { bit: 0x040, label: '左上' },
  { bit: 0x080, label: '上' },
  { bit: 0x100, label: '右上' },
];
const P0_LINK_TARGETS_BY_SEQUENCE = new Map([
  [0, { 0x020: 1 }],
  [1, { 0x008: 0, 0x020: 2, 0x080: 5 }],
  [2, { 0x008: 1, 0x020: 3, 0x040: 5, 0x100: 6 }],
  [3, { 0x008: 2, 0x020: 4, 0x080: 6 }],
  [4, { 0x008: 3 }],
  [5, { 0x001: 1, 0x002: 2 }],
  [6, { 0x002: 2, 0x004: 3 }],
]);

/** @typedef {{ player: number | null, opponent: number | null }} LifePoints */
/** @typedef {{ hand: string[], handCount: number, handHidden: boolean, deckCount: number, monsters: string[], spellsTraps: string[], graveyard: string[], graveyardCount: number, graveyardTruncated: boolean, banished: string[], extraDeck: string[], extraDeckCount: number }} PlayerStateSummary */
/** @typedef {{ player: 'P0' | 'P1', name: string, code: number | null, zone: string, sequence: number | null, linkMarker: number, arrows: string[], pointedZones: string[] }} LinkMonsterSummary */
/** @typedef {{ currentLinkZones: string[], linkMonsters: LinkMonsterSummary[], summary: string }} FieldContextSummary */
/** @typedef {{ lp: LifePoints, player: PlayerStateSummary, opponent: PlayerStateSummary, fieldContext: FieldContextSummary, phase: string | null, turn: number | null, decision: string | null, terminal: boolean }} CurrentStateSummary */
/** @typedef {{ graveyardLimit?: number }} CurrentStateOptions */
/** @typedef {{ ok: true, data: CurrentStateSummary } | { ok: false, error: string }} CurrentStateResult */
/** @typedef {'summon' | 'spsummon' | 'activate' | 'set' | 'battle' | 'phase' | 'other'} ActionCategory */
/** @typedef {{ index: number, selectionIndex?: number, label: string, category: ActionCategory, kind: string, description?: string }} ActionSummary */
/** @typedef {{ actions: ActionSummary[], grouped?: Record<string, ActionSummary[]>, fieldContext: FieldContextSummary | null, totalActions: number, matchingActions: number, returnedActions: number, truncated: boolean, category: ActionCategory | null, decision: string | null, terminal: boolean, reason: string | null }} ListActionsSummary */
/** @typedef {{ category?: string, offset?: number, limit?: number, includeDescriptions?: boolean, includeGrouped?: boolean }} ListActionsOptions */
/** @typedef {{ ok: true, data: ListActionsSummary } | { ok: false, error: string }} ListActionsResult */

/**
 * Capture and format the current YGO runner state for LLM consumption.
 *
 * @param {unknown} runnerOrContext Runner instance, or an object with a `runner` property.
 * @param {CurrentStateOptions} [options]
 * @returns {CurrentStateResult}
 */
export function getCurrentState(runnerOrContext, options = {}) {
  const runner = resolveRunner(runnerOrContext);
  if (!runner) {
    return { ok: false, error: 'getCurrentState requires a runner with captureSnapshot().' };
  }

  try {
    const snapshot = runner.captureSnapshot();
    return {
      ok: true,
      data: formatCurrentState(snapshot, {
        ...options,
        runner,
      }),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * List currently available actions, grouped for LLM tool use.
 *
 * @param {unknown} runnerOrContext Runner instance, or an object with a `runner` property.
 * @param {ListActionsOptions} [options]
 * @returns {ListActionsResult}
 */
export function listActions(runnerOrContext, options = {}) {
  const runner = resolveActionRunner(runnerOrContext);
  if (!runner) {
    return { ok: false, error: 'listActions requires a runner with currentDecision.actions.' };
  }

  const decision = asRecord(runner.currentDecision);
  const rawActions = arrayValue(decision.actions);
  const category = normalizeActionCategory(options.category);
  if (options.category && !category) {
    return {
      ok: false,
      error: `Unknown action category "${options.category}". Expected one of: ${ACTION_CATEGORIES.join(', ')}.`,
    };
  }

  const includeDescriptions = options.includeDescriptions === true;
  const formattedActions = rawActions.map((action, index) => formatActionSummary(action, index, includeDescriptions));
  const matchingActions = category
    ? formattedActions.filter((action) => action.category === category)
    : formattedActions;
  const offset = normalizeActionOffset(options.offset);
  const limit = normalizeActionLimit(options.limit);
  const actions = matchingActions.slice(offset, offset + limit);
  const fieldContext = captureFieldContextForRunner(runner);
  const engineDiagnostics = arrayValue(runner.engineMessages)
    .slice(-20)
    .map((entry) => {
      const record = asRecord(entry);
      return {
        type: Number(record.type),
        message: readString(record.message) ?? '',
      };
    });

  return {
    ok: true,
    data: {
      actions,
      ...(options.includeGrouped === true ? { grouped: groupActionSummaries(actions) } : {}),
      fieldContext,
      totalActions: rawActions.length,
      matchingActions: matchingActions.length,
      returnedActions: actions.length,
      truncated: offset > 0 || offset + actions.length < matchingActions.length,
      offset,
      limit,
      nextOffset: offset + actions.length < matchingActions.length ? offset + actions.length : null,
      category,
      decision: getDecisionName(runner.currentDecision),
      factorizedSelection: decision.factorizedSelection === true,
      estimatedLegalCandidateCount: readNumber(decision.estimatedLegalCandidateCount),
      selectionConstraints: asRecord(decision.selectionConstraints),
      terminal: Boolean(decision.terminal),
      reason: readString(decision.reason),
      engineDiagnostics,
    },
  };
}

/**
 * Convert a raw runner snapshot into compact, card-name-only state.
 *
 * @param {unknown} snapshot
 * @param {CurrentStateOptions & { runner?: Record<string, unknown> }} [options]
 * @returns {CurrentStateSummary}
 */
export function formatCurrentState(snapshot, options = {}) {
  const snapshotRecord = asRecord(snapshot);
  const runner = options.runner ?? {};
  const graveyardLimit = normalizeLimit(options.graveyardLimit);
  const resolveCardName = createCardNameResolver(runner, snapshotRecord);

  return {
    lp: normalizeLifePoints(snapshotRecord.lp),
    player: buildPlayerState(snapshotRecord, 'p0', resolveCardName, graveyardLimit),
    opponent: buildPlayerState(snapshotRecord, 'p1', resolveCardName, graveyardLimit),
    fieldContext: buildFieldContext(snapshotRecord, resolveCardName),
    phase: readString(snapshotRecord.phase) ?? readString(runner.phase),
    turn: readNumber(snapshotRecord.turn) ?? readNumber(runner.turn),
    decision: getDecisionName(runner.currentDecision),
    terminal: Boolean(asRecord(runner.currentDecision).terminal),
  };
}

/**
 * @param {unknown} value
 * @returns {{ captureSnapshot: () => unknown, currentDecision?: unknown } & Record<string, unknown> | null}
 */
function resolveRunner(value) {
  const record = asRecord(value);
  if (typeof record.captureSnapshot === 'function') {
    return /** @type {{ captureSnapshot: () => unknown, currentDecision?: unknown } & Record<string, unknown>} */ (record);
  }

  const nested = asRecord(record.runner);
  if (typeof nested.captureSnapshot === 'function') {
    return /** @type {{ captureSnapshot: () => unknown, currentDecision?: unknown } & Record<string, unknown>} */ (nested);
  }

  return null;
}

/**
 * @param {unknown} value
 * @returns {{ currentDecision?: unknown } & Record<string, unknown> | null}
 */
function resolveActionRunner(value) {
  const record = asRecord(value);
  if ('currentDecision' in record || typeof record.captureSnapshot === 'function') {
    return /** @type {{ currentDecision?: unknown } & Record<string, unknown>} */ (record);
  }

  const nested = asRecord(record.runner);
  if ('currentDecision' in nested || typeof nested.captureSnapshot === 'function') {
    return /** @type {{ currentDecision?: unknown } & Record<string, unknown>} */ (nested);
  }

  return null;
}

/**
 * @param {Record<string, unknown>} snapshot
 * @param {'p0' | 'p1'} playerKey
 * @param {(card: unknown) => string} resolveCardName
 * @param {number} graveyardLimit
 * @returns {PlayerStateSummary}
 */
function buildPlayerState(snapshot, playerKey, resolveCardName, graveyardLimit) {
  const handCards = readZone(snapshot, playerKey, 'hand');
  const deckCards = readZone(snapshot, playerKey, 'deck');
  const graveyardCards = readZone(snapshot, playerKey, 'grave');
  const graveyard = namesForZone(graveyardCards, resolveCardName).slice(-graveyardLimit);
  const extraDeck = namesForZone(readZone(snapshot, playerKey, 'extra'), resolveCardName);
  const handHidden = playerKey === 'p1';

  return {
    hand: handHidden ? [] : namesForZone(handCards, resolveCardName),
    handCount: handCards.length,
    handHidden,
    deckCount: deckCards.length,
    monsters: namesForZone(readZone(snapshot, playerKey, 'mzone'), resolveCardName),
    spellsTraps: namesForZone(readZone(snapshot, playerKey, 'szone'), resolveCardName),
    graveyard,
    graveyardCount: graveyardCards.length,
    graveyardTruncated: graveyardCards.length > graveyard.length,
    banished: namesForZone(readZone(snapshot, playerKey, 'banished'), resolveCardName),
    extraDeck,
    extraDeckCount: extraDeck.length,
  };
}

/**
 * @param {Record<string, unknown>} runner
 * @returns {FieldContextSummary | null}
 */
function captureFieldContextForRunner(runner) {
  if (typeof runner.captureSnapshot !== 'function') return null;
  try {
    const snapshot = runner.captureSnapshot();
    const snapshotRecord = asRecord(snapshot);
    return buildFieldContext(snapshotRecord, createCardNameResolver(runner, snapshotRecord));
  } catch {
    return null;
  }
}

/**
 * @param {Record<string, unknown>} snapshot
 * @param {(card: unknown) => string} resolveCardName
 * @returns {FieldContextSummary}
 */
function buildFieldContext(snapshot, resolveCardName) {
  const linkMonsters = [
    ...buildPlayerLinkMonsters(snapshot, 'p0', resolveCardName),
    ...buildPlayerLinkMonsters(snapshot, 'p1', resolveCardName),
  ];
  const currentLinkZones = uniqStrings(linkMonsters.flatMap((monster) => monster.pointedZones));
  const summary = currentLinkZones.length > 0
    ? `当前linkzone为：${currentLinkZones.join('、')}。${linkMonsters.map(formatLinkMonsterReason).join('；')}`
    : '当前linkzone为：无。场上没有可从快照确认箭头的Link怪兽。';
  return { currentLinkZones, linkMonsters, summary };
}

/**
 * @param {Record<string, unknown>} snapshot
 * @param {'p0' | 'p1'} playerKey
 * @param {(card: unknown) => string} resolveCardName
 * @returns {LinkMonsterSummary[]}
 */
function buildPlayerLinkMonsters(snapshot, playerKey, resolveCardName) {
  return readZone(snapshot, playerKey, 'mzone')
    .map((card, index) => buildLinkMonsterSummary(card, index, playerKey, resolveCardName))
    .filter((summary) => summary !== null);
}

/**
 * @param {unknown} card
 * @param {number} fallbackSequence
 * @param {'p0' | 'p1'} playerKey
 * @param {(card: unknown) => string} resolveCardName
 * @returns {LinkMonsterSummary | null}
 */
function buildLinkMonsterSummary(card, fallbackSequence, playerKey, resolveCardName) {
  const type = readCardType(card);
  const linkMarker = readLinkMarker(card);
  if ((type & TYPE_LINK) === 0 && linkMarker === 0) return null;
  const sequence = readCardSequence(card) ?? fallbackSequence;
  const arrows = LINK_MARKERS
    .filter((marker) => (linkMarker & marker.bit) !== 0)
    .map((marker) => marker.label);
  const pointedZones = playerKey === 'p0'
    ? linkedMainMonsterZonesForP0(sequence, linkMarker)
    : [];
  return {
    player: playerKey === 'p0' ? 'P0' : 'P1',
    name: resolveCardName(card),
    code: readCardCode(card),
    zone: monsterZoneLabel(playerKey, sequence),
    sequence,
    linkMarker,
    arrows,
    pointedZones,
  };
}

/**
 * @param {number} sequence
 * @param {number} linkMarker
 * @returns {string[]}
 */
function linkedMainMonsterZonesForP0(sequence, linkMarker) {
  if (!Number.isFinite(sequence)) return [];
  const targetsByMarker = P0_LINK_TARGETS_BY_SEQUENCE.get(sequence);
  if (!targetsByMarker) return [];
  const zones = [];
  for (const marker of LINK_MARKERS) {
    if ((linkMarker & marker.bit) === 0) continue;
    const target = targetsByMarker[marker.bit];
    if (Number.isInteger(target)) zones.push(`P0 主怪兽区${target}`);
  }
  return uniqStrings(zones);
}

/**
 * @param {LinkMonsterSummary} monster
 * @returns {string}
 */
function formatLinkMonsterReason(monster) {
  const arrows = monster.arrows.length > 0 ? monster.arrows.join('/') : '未知箭头';
  const targets = monster.pointedZones.length > 0 ? monster.pointedZones.join('、') : '未指向我方可用主怪兽区';
  return `${monster.name}位于${monster.zone}，箭头${arrows}，指向${targets}`;
}

/**
 * @param {Record<string, unknown>} snapshot
 * @param {'p0' | 'p1'} playerKey
 * @param {'hand' | 'deck' | 'mzone' | 'szone' | 'grave' | 'banished' | 'extra'} zoneKey
 * @returns {unknown[]}
 */
function readZone(snapshot, playerKey, zoneKey) {
  const enrichedZones = asRecord(snapshot[`${playerKey}Zones`]);
  const enrichedCards = arrayValue(enrichedZones[zoneKey]);
  if (enrichedCards.length > 0) return enrichedCards;

  const player = asRecord(snapshot[playerKey]);
  for (const alias of zoneAliases(zoneKey)) {
    const cards = arrayValue(player[alias]);
    if (cards.length > 0) return cards;
  }

  return [];
}

/**
 * @param {'hand' | 'mzone' | 'szone' | 'grave' | 'banished' | 'extra'} zoneKey
 * @returns {string[]}
 */
function zoneAliases(zoneKey) {
  switch (zoneKey) {
    case 'mzone':
      return ['mzone', 'monsters', 'monsterZone'];
    case 'szone':
      return ['szone', 'spellsTraps', 'spellTrapZone', 'spells', 'traps'];
    case 'grave':
      return ['grave', 'graveyard', 'gy'];
    case 'banished':
      return ['banished', 'removed'];
    case 'extra':
      return ['extra', 'extraDeck'];
    default:
      return [zoneKey];
  }
}

/**
 * @param {unknown[]} cards
 * @param {(card: unknown) => string} resolveCardName
 * @returns {string[]}
 */
function namesForZone(cards, resolveCardName) {
  return cards.map((card) => resolveCardName(card));
}

/**
 * @param {unknown} action
 * @param {number} index
 * @param {boolean} [includeDescription]
 * @returns {ActionSummary}
 */
function formatActionSummary(action, index, includeDescription = false) {
  const record = asRecord(action);
  const label = readString(record.label) ?? `Action #${index + 1}`;
  const kind = readString(record.kind) ?? '';
  const category = classifyAction(kind, label);

  return {
    index,
    ...(Number.isInteger(record.selectionIndex) ? { selectionIndex: Number(record.selectionIndex) } : {}),
    label,
    category,
    kind,
    ...(includeDescription ? { description: summarizeActionDescription(record.text, category) } : {}),
  };
}

/**
 * @param {ActionSummary[]} actions
 * @returns {Record<string, ActionSummary[]>}
 */
function groupActionSummaries(actions) {
  /** @type {Record<string, ActionSummary[]>} */
  const grouped = {};
  for (const category of ACTION_CATEGORIES) grouped[category] = [];
  for (const action of actions) grouped[action.category].push(action);
  return grouped;
}

/**
 * @param {string} kind
 * @param {string} label
 * @returns {ActionCategory}
 */
function classifyAction(kind, label) {
  const normalizedKind = kind.toLowerCase();
  const normalizedLabel = label.toLowerCase();

  if (normalizedKind === 'summon' || /^通常召唤/.test(label) || normalizedLabel.startsWith('normal summon')) {
    return 'summon';
  }

  if (
    normalizedKind === 'spsummon' ||
    normalizedKind === 'special_summon' ||
    normalizedKind === 'special summon' ||
    /^特殊召唤/.test(label) ||
    normalizedLabel.startsWith('special summon')
  ) {
    return 'spsummon';
  }

  if (
    normalizedKind === 'set' ||
    normalizedKind === 'mset' ||
    normalizedKind === 'sset' ||
    /^盖放/.test(label) ||
    normalizedLabel.startsWith('set ')
  ) {
    return 'set';
  }

  if (
    normalizedKind === 'phase' ||
    normalizedKind === 'phase_end' ||
    normalizedKind === 'end_phase' ||
    /结束回合|战阶结束|进入.*阶段|主要阶段2/.test(label) ||
    normalizedLabel.includes('phase') ||
    normalizedLabel.includes('end turn')
  ) {
    return 'phase';
  }

  if (
    normalizedKind === 'attack' ||
    normalizedKind === 'battle' ||
    /^攻击/.test(label) ||
    normalizedLabel.startsWith('attack')
  ) {
    return 'battle';
  }

  if (
    normalizedKind === 'activate' ||
    normalizedKind === 'chain' ||
    (/发动|连锁/.test(label) && !/^不发动/.test(label)) ||
    normalizedLabel.includes('activate') ||
    normalizedLabel.includes('chain')
  ) {
    return 'activate';
  }

  return 'other';
}

/**
 * @param {unknown} text
 * @param {ActionCategory} category
 * @returns {string}
 */
function summarizeActionDescription(text, category) {
  const normalized = readString(text)?.replace(/\s+/g, ' ');
  if (normalized) return truncateText(normalized, 180);

  switch (category) {
    case 'summon':
      return 'Normal summon action.';
    case 'spsummon':
      return 'Special summon action.';
    case 'activate':
      return 'Effect or chain activation action.';
    case 'set':
      return 'Set a monster, spell, or trap.';
    case 'battle':
      return 'Battle phase action.';
    case 'phase':
      return 'Phase or turn transition.';
    default:
      return 'Selection or utility action.';
  }
}

/**
 * @param {Record<string, unknown>} runner
 * @param {Record<string, unknown>} snapshot
 * @returns {(card: unknown) => string}
 */
function createCardNameResolver(runner, snapshot) {
  const namesByCode = new Map();
  collectKnownNames(namesByCode, runner.playerDeckInstances);
  collectKnownNames(namesByCode, runner.deckInstances);
  collectKnownNames(namesByCode, runner.deckView);
  collectKnownNames(namesByCode, snapshot.p0Zones);
  collectKnownNames(namesByCode, snapshot.p1Zones);

  const resolvers = [
    runner.cardText,
    runner.cardTextResolver,
    runner.cardTexts,
    runner.cardDatabase,
    runner.cardsDb,
  ];

  return (card) => {
    const directName = readCardName(card);
    if (directName) return directName;

    const code = readCardCode(card);
    if (code === null) return UNKNOWN_CARD_NAME;

    const mapped = namesByCode.get(code);
    if (mapped) return mapped;

    for (const resolver of resolvers) {
      const resolved = resolveNameFromSource(resolver, code);
      if (resolved) return resolved;
    }

    return UNKNOWN_CARD_NAME;
  };
}

/**
 * @param {Map<number, string>} namesByCode
 * @param {unknown} source
 * @returns {void}
 */
function collectKnownNames(namesByCode, source) {
  if (!source) return;
  if (Array.isArray(source)) {
    for (const item of source) addKnownName(namesByCode, item);
    return;
  }

  const record = asRecord(source);
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) {
      for (const item of value) addKnownName(namesByCode, item);
    }
  }
}

/**
 * @param {Map<number, string>} namesByCode
 * @param {unknown} card
 * @returns {void}
 */
function addKnownName(namesByCode, card) {
  const code = readCardCode(card);
  const name = readCardName(card);
  if (code !== null && name && !namesByCode.has(code)) {
    namesByCode.set(code, name);
  }
}

/**
 * @param {unknown} source
 * @param {number} code
 * @returns {string | null}
 */
function resolveNameFromSource(source, code) {
  if (!source) return null;
  const record = asRecord(source);

  if (typeof record.getName === 'function') {
    try {
      return normalizeName(record.getName(code));
    } catch {
      return null;
    }
  }

  if (typeof record.getCard === 'function') {
    try {
      return readCardName(record.getCard(code));
    } catch {
      return null;
    }
  }

  return readCardName(record[String(code)]);
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function readCardName(value) {
  if (typeof value === 'string') return normalizeName(value);
  const record = asRecord(value);
  return (
    normalizeName(record.name) ??
    normalizeName(record.cardName) ??
    normalizeName(record.label)
  );
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function readCardCode(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value >>> 0;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value) >>> 0;

  const record = asRecord(value);
  for (const key of ['code', 'id', 'cardId', 'cardCode', 'passcode']) {
    const raw = record[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw >>> 0;
    if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) return Number(raw) >>> 0;
  }

  return null;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function readCardType(value) {
  const record = asRecord(value);
  return readNumber(record.type) ?? readNumber(record.cardType) ?? 0;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function readLinkMarker(value) {
  const record = asRecord(value);
  return (
    readNumber(record.link_marker) ??
    readNumber(record.linkMarker) ??
    readNumber(record.link_markers) ??
    readNumber(record.linkMarkers) ??
    0
  );
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function readCardSequence(value) {
  const record = asRecord(value);
  return readNumber(record.sequence) ?? readNumber(record.seq) ?? readNumber(record.zoneSequence) ?? readNumber(record.snapshotIndex);
}

/**
 * @param {'p0' | 'p1'} playerKey
 * @param {number | null} sequence
 * @returns {string}
 */
function monsterZoneLabel(playerKey, sequence) {
  const player = playerKey === 'p0' ? 'P0' : 'P1';
  if (sequence === 5 || sequence === 6) return `${player} 额外怪兽区${sequence}`;
  return `${player} 主怪兽区${sequence ?? '?'}`;
}

/**
 * @param {string[]} values
 * @returns {string[]}
 */
function uniqStrings(values) {
  return [...new Set(values)];
}

/**
 * @param {unknown} value
 * @returns {LifePoints}
 */
function normalizeLifePoints(value) {
  if (Array.isArray(value)) {
    return {
      player: readNumber(value[0]),
      opponent: readNumber(value[1]),
    };
  }

  const record = asRecord(value);
  return {
    player: readNumber(record.player) ?? readNumber(record.p0) ?? readNumber(record[0]),
    opponent: readNumber(record.opponent) ?? readNumber(record.p1) ?? readNumber(record[1]),
  };
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
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
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function asRecord(value) {
  return value && typeof value === 'object' ? /** @type {Record<string, unknown>} */ (value) : {};
}

/**
 * @param {unknown} value
 * @returns {unknown[]}
 */
function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function normalizeName(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || /^\d+$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function readString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function readNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function normalizeLimit(value) {
  const number = Math.trunc(Number(value ?? DEFAULT_GRAVEYARD_LIMIT));
  if (!Number.isFinite(number) || number <= 0) return DEFAULT_GRAVEYARD_LIMIT;
  return Math.min(number, MAX_GRAVEYARD_LIMIT);
}

function normalizeActionOffset(value) {
  const number = Math.trunc(Number(value ?? 0));
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function normalizeActionLimit(value) {
  const number = Math.trunc(Number(value ?? DEFAULT_ACTION_LIMIT));
  if (!Number.isFinite(number) || number <= 0) return DEFAULT_ACTION_LIMIT;
  return Math.min(number, MAX_ACTION_LIMIT);
}

/**
 * @param {unknown} value
 * @returns {ActionCategory | null}
 */
function normalizeActionCategory(value) {
  const category = readString(value);
  if (!category) return null;

  const normalized = category.toLowerCase().replace(/[-\s]/g, '_');
  switch (normalized) {
    case 'summon':
    case 'normal_summon':
      return 'summon';
    case 'spsummon':
    case 'sp_summon':
    case 'special':
    case 'special_summon':
      return 'spsummon';
    case 'activate':
    case 'chain':
    case 'effect':
      return 'activate';
    case 'set':
      return 'set';
    case 'battle':
    case 'attack':
      return 'battle';
    case 'phase':
    case 'phase_end':
    case 'turn':
      return 'phase';
    case 'other':
    case 'selection':
      return 'other';
    default:
      return null;
  }
}

/**
 * @param {string} text
 * @param {number} maxLength
 * @returns {string}
 */
function truncateText(text, maxLength) {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

export const getCurrentStateTool = {
  name: 'getCurrentState',
  description: 'Return a compact current duel summary with public cards and hand/deck/graveyard counts; opponent hand identities remain hidden.',
  input_schema: {
    type: 'object',
    properties: {
      graveyardLimit: {
        type: 'number',
        description: 'Maximum recent graveyard cards to include per player.',
        minimum: 1,
        maximum: MAX_GRAVEYARD_LIMIT,
      },
    },
    additionalProperties: false,
  },
  execute: getCurrentState,
};

export const listActionsTool = {
  name: 'listActions',
  description: 'Return a bounded page of current legal actions. Results are compact by default; request descriptions or duplicate category grouping only when needed.',
  input_schema: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        enum: ACTION_CATEGORIES,
        description: 'Optional action category filter.',
      },
      offset: { type: 'integer', minimum: 0, description: 'Zero-based action-page offset.' },
      limit: { type: 'integer', minimum: 1, maximum: MAX_ACTION_LIMIT, description: 'Maximum actions returned in this page.' },
      includeDescriptions: { type: 'boolean', description: 'Include action text summaries. Defaults to false to conserve context.' },
      includeGrouped: { type: 'boolean', description: 'Also duplicate returned actions into category groups. Defaults to false.' },
    },
    additionalProperties: false,
  },
  execute: listActions,
};
