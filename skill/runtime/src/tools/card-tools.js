// @ts-check

import { openCardsDatabase } from '../database/cards-db.js';
import {
  getBanStatusForCardSync,
  getCardScriptStatusSync,
  inspectCardDataSources,
  readBanlistContext,
  refreshCardDataSources,
} from '../database/card-data-updater.js';

/** @typedef {{ id: number, name: string, effectText: string, strings: string[], type: string, typeTags: string[], attributeText: string | null, raceText: string | null, atk: number, def: number, level: number, alias: number }} CardRecord */
/** @typedef {{ main: number[], extra: number[], side: number[] }} ParsedDeck */
/** @typedef {string | number | Array<string | number>} TypeFilter */
/** @typedef {{ getByName: (name: string) => CardRecord | null, getById: (id: number | string) => CardRecord | null, searchByName?: (query: string, options?: { limit?: number, type?: TypeFilter }) => CardRecord[], searchByText?: (query: string, options?: { limit?: number, type?: TypeFilter }) => CardRecord[], searchCards?: (query: string, options?: { limit?: number, type?: TypeFilter }) => CardRecord[], findByType?: (type: TypeFilter, options?: { limit?: number }) => CardRecord[], close?: () => void }} CardsDbLike */
/** @typedef {{ cardName?: string, name?: string, id?: number | string, cardId?: number | string, passcode?: number | string, dbPath?: string, cardsDb?: CardsDbLike }} GetCardEffectInput */
/** @typedef {{ deckLoaded: boolean, inCurrentDeck: boolean, totalCopies: number, sections: { main: number, extra: number, side: number }, matches: Array<{ id: number, name: string, count: number, sections: { main: number, extra: number, side: number }, indices: { main: number[], extra: number[], side: number[] }, type: string, typeTags: string[] }>, warning: string | null }} CurrentDeckMembership */
/** @typedef {{ id: number, name: string, quantity: number, status: string, statusText: string, listName: string, listHash: number | null, sourcePath: string | null }} BanlistStatusSummary */
/** @typedef {{ id: number, name: string, path: string, scriptsDir: string, requiredFile: string, available: boolean, readable: boolean, hasInitialEffect: boolean, sha256: string | null, bytes: number, source: string | null, error: string | null, note: string | null }} ScriptStatusSummary */
/** @typedef {{ id: number, name: string, effectText: string, effectStrings: string[], type: string, typeTags: string[], attribute: string | null, race: string | null, atk: number | null, def: number | null, atkText: string, defText: string, level: number, alias: number | null, matchedBy: 'id' | 'name', query: string, dataSource: { dbPath: string | null }, sameName: { selectedId: number, count: number, ids: number[], returnedFirst: boolean }, currentDeck: CurrentDeckMembership | null, banlistStatus: BanlistStatusSummary | null, scriptStatus: ScriptStatusSummary | null }} CardEffectSummary */
/** @typedef {{ ok: true, data: CardEffectSummary } | { ok: false, error: string }} GetCardEffectResult */
/** @typedef {'all' | 'name' | 'text'} SearchMode */
/** @typedef {{ query?: string, cardName?: string, name?: string, keyword?: string, text?: string, mode?: string, searchMode?: string, type?: TypeFilter, cardType?: TypeFilter, limit?: number, dbPath?: string, cardsDb?: CardsDbLike }} SearchCardsInput */
/** @typedef {{ id: number, name: string, type: string, typeTags: string[], attribute: string | null, race: string | null, atk: number | null, def: number | null, atkText: string, defText: string, level: number, effectSnippet: string, currentDeck: CurrentDeckMembership | null, banlistStatus: BanlistStatusSummary | null, scriptStatus: ScriptStatusSummary | null }} CardSearchSummary */
/** @typedef {{ query: string, expandedQueries: string[], mode: SearchMode, type: TypeFilter | null, limit: number, dataSource: { dbPath: string | null }, returnedResults: number, limitReached: boolean, currentDeck: { deckLoaded: boolean, matchingResults: number, missingResults: number } | null, results: CardSearchSummary[] }} SearchCardsSummary */
/** @typedef {{ ok: true, data: SearchCardsSummary } | { ok: false, error: string }} SearchCardsResult */

const SAME_NAME_LIMIT = 20;
const DEFAULT_CARD_SEARCH_LIMIT = 20;
const MAX_CARD_SEARCH_LIMIT = 100;
const EFFECT_SNIPPET_LIMIT = 220;
const UNKNOWN_STAT_TEXT = '?';
const SESSION_DECK_KEY = 'currentDeck';
const CARD_NAME_ALIASES = Object.freeze({
  '卡通阴影': '影子卡通',
  '不信妄想症': 'Distrust Paranoia',
});

/** @type {{ cacheKey: string, db: CardsDbLike } | null} */
let sharedCardsDb = null;

/**
 * Query one card by name or ID and return LLM-friendly effect text plus stats.
 *
 * The function accepts either direct tool input (`{ cardName: "灰流丽" }`) or
 * the later tool-router shape (`context, { cardName: "灰流丽" }`).
 *
 * @param {string | number | GetCardEffectInput | unknown} contextOrInput
 * @param {GetCardEffectInput | string | number} [options]
 * @returns {GetCardEffectResult}
 */
export function getCardEffect(contextOrInput, options = {}) {
  const lookup = normalizeLookup(contextOrInput, options);
  if (!lookup.name && lookup.id === null) {
    return { ok: false, error: 'getCardEffect requires cardName or id.' };
  }

  try {
    const cardsDb = resolveCardsDb(contextOrInput, options);
    const deck = readSessionDeck(contextOrInput, options);
    const effectiveName = resolveCardNameAlias(lookup.name);
    const card = lookup.id !== null
      ? cardsDb.getById(lookup.id)
      : cardsDb.getByName(effectiveName ?? '');

    if (!card) {
      return {
        ok: false,
        error: `Card not found: ${lookup.query}.`,
      };
    }

    return {
      ok: true,
      data: formatCardEffect(card, {
        matchedBy: lookup.id !== null ? 'id' : 'name',
        query: lookup.query,
        sameNameIds: findSameNameIds(cardsDb, card),
        deck,
        cardsDb,
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
 * Search the card database by fuzzy name, effect text, and optional type filter.
 *
 * @param {string | SearchCardsInput | unknown} contextOrInput
 * @param {SearchCardsInput | string} [options]
 * @returns {SearchCardsResult}
 */
export function searchCards(contextOrInput, options = {}) {
  const search = normalizeCardSearch(contextOrInput, options);
  if (!search.query && search.type === null) {
    return { ok: false, error: 'searchCards requires query or type.' };
  }

  try {
    const cardsDb = resolveCardsDb(contextOrInput, options);
    const deck = readSessionDeck(contextOrInput, options);
    const expandedQueries = expandSearchQueries(search.query, search.mode);
    const cards = executeCardSearch(cardsDb, search, expandedQueries);
    const summaries = cards.map((card) => formatCardSearchSummary(card, expandedQueries, { deck, cardsDb }));
    const currentDeck = deck
      ? {
          deckLoaded: true,
          matchingResults: summaries.filter((summary) => summary.currentDeck?.inCurrentDeck).length,
          missingResults: summaries.filter((summary) => summary.currentDeck && !summary.currentDeck.inCurrentDeck).length,
        }
      : null;

    return {
      ok: true,
      data: {
        query: search.query,
        expandedQueries: expandedQueries.filter((query) => query !== search.query),
        mode: search.mode,
        type: search.type,
        limit: search.limit,
        dataSource: {
          dbPath: readString(asRecord(cardsDb).dbPath),
        },
        returnedResults: summaries.length,
        limitReached: summaries.length >= search.limit,
        currentDeck,
        results: summaries,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function closeSharedCardsDatabase() {
  if (sharedCardsDb?.db.close) sharedCardsDb.db.close();
  sharedCardsDb = null;
}

/**
 * @param {CardRecord} card
 * @param {{ matchedBy: 'id' | 'name', query: string, sameNameIds: number[], deck: ParsedDeck | null, cardsDb: CardsDbLike }} meta
 * @returns {CardEffectSummary}
 */
function formatCardEffect(card, meta) {
  return {
    id: card.id,
    name: card.name,
    effectText: card.effectText,
    effectStrings: card.strings,
    type: card.type,
    typeTags: card.typeTags,
    attribute: card.attributeText,
    race: card.raceText,
    atk: normalizeStat(card.atk),
    def: normalizeStat(card.def),
    atkText: formatStat(card.atk),
    defText: formatStat(card.def),
    level: card.level,
    alias: card.alias > 0 ? card.alias : null,
    matchedBy: meta.matchedBy,
    query: meta.query,
    dataSource: {
      dbPath: readString(asRecord(meta.cardsDb).dbPath),
    },
    sameName: {
      selectedId: card.id,
      count: meta.sameNameIds.length,
      ids: meta.sameNameIds,
      returnedFirst: meta.sameNameIds.length > 1 && meta.sameNameIds[0] === card.id,
    },
    currentDeck: buildCurrentDeckMembership(card, meta.deck, meta.cardsDb),
    banlistStatus: formatBanlistStatus(card),
    scriptStatus: formatScriptStatus(card),
  };
}

/**
 * @param {CardsDbLike} cardsDb
 * @param {{ query: string, mode: SearchMode, type: TypeFilter | null, limit: number }} search
 * @param {string[]} queries
 * @returns {CardRecord[]}
 */
function executeCardSearch(cardsDb, search, queries) {
  /** @type {CardRecord[]} */
  const results = [];
  const seenIds = new Set();

  if (!search.query && search.type !== null) {
    return runSingleCardSearch(cardsDb, '', search).slice(0, search.limit);
  }

  for (const query of queries) {
    const batch = runSingleCardSearch(cardsDb, query, search);
    for (const card of batch) {
      if (seenIds.has(card.id)) continue;
      seenIds.add(card.id);
      results.push(card);
      if (results.length >= search.limit) return results;
    }
  }

  return results;
}

/**
 * @param {CardsDbLike} cardsDb
 * @param {string} query
 * @param {{ mode: SearchMode, type: TypeFilter | null, limit: number }} search
 * @returns {CardRecord[]}
 */
function runSingleCardSearch(cardsDb, query, search) {
  const options = search.type === null
    ? { limit: search.limit }
    : { limit: search.limit, type: search.type };

  if (!query && search.type !== null) {
    if (typeof cardsDb.findByType === 'function') return cardsDb.findByType(search.type, { limit: search.limit });
    if (typeof cardsDb.searchCards === 'function') return cardsDb.searchCards('', options);
  }

  if (search.mode === 'name') {
    if (typeof cardsDb.searchByName !== 'function') throw new Error('searchCards requires cardsDb.searchByName().');
    return cardsDb.searchByName(query, options);
  }

  if (search.mode === 'text') {
    if (typeof cardsDb.searchByText !== 'function') throw new Error('searchCards requires cardsDb.searchByText().');
    return cardsDb.searchByText(query, options);
  }

  if (typeof cardsDb.searchCards !== 'function') throw new Error('searchCards requires cardsDb.searchCards().');
  return cardsDb.searchCards(query, options);
}

/**
 * @param {CardRecord} card
 * @param {string[]} queries
 * @param {{ deck: ParsedDeck | null, cardsDb: CardsDbLike }} meta
 * @returns {CardSearchSummary}
 */
function formatCardSearchSummary(card, queries, meta) {
  return {
    id: card.id,
    name: card.name,
    type: card.type,
    typeTags: card.typeTags,
    attribute: card.attributeText,
    race: card.raceText,
    atk: normalizeStat(card.atk),
    def: normalizeStat(card.def),
    atkText: formatStat(card.atk),
    defText: formatStat(card.def),
    level: card.level,
    effectSnippet: buildEffectSnippet(card, queries),
    currentDeck: buildCurrentDeckMembership(card, meta.deck, meta.cardsDb),
    banlistStatus: formatBanlistStatus(card),
    scriptStatus: formatScriptStatus(card),
  };
}

/**
 * @param {CardRecord} card
 * @param {ParsedDeck | null} deck
 * @param {CardsDbLike} cardsDb
 * @returns {CurrentDeckMembership | null}
 */
function buildCurrentDeckMembership(card, deck, cardsDb) {
  if (!deck) return null;

  const matchingIds = new Set([card.id]);
  const sameNameIds = findSameNameIds(cardsDb, card);
  for (const id of sameNameIds) matchingIds.add(id);

  const sections = { main: 0, extra: 0, side: 0 };
  const matchesById = new Map();
  for (const section of /** @type {const} */ (['main', 'extra', 'side'])) {
    deck[section].forEach((id, index) => {
      if (!matchingIds.has(id)) return;
      const matchedCard = cardsDb.getById(id);
      const existing = matchesById.get(id) ?? {
        id,
        name: matchedCard?.name ?? `Unknown ${id}`,
        count: 0,
        sections: { main: 0, extra: 0, side: 0 },
        indices: { main: [], extra: [], side: [] },
        type: matchedCard?.type ?? 'Unknown',
        typeTags: Array.isArray(matchedCard?.typeTags) ? matchedCard.typeTags : [],
      };
      existing.count += 1;
      existing.sections[section] += 1;
      existing.indices[section].push(index);
      sections[section] += 1;
      matchesById.set(id, existing);
    });
  }

  const totalCopies = sections.main + sections.extra + sections.side;
  return {
    deckLoaded: true,
    inCurrentDeck: totalCopies > 0,
    totalCopies,
    sections,
    matches: [...matchesById.values()],
    warning: totalCopies > 0 ? null : `当前上传卡组未携带「${card.name}」，不能把它作为已验证路线中的可用卡。`,
  };
}

/**
 * @param {CardRecord} card
 * @param {string[]} queries
 */
function buildEffectSnippet(card, queries) {
  const texts = [card.effectText, ...card.strings].filter((text) => text.length > 0);
  const terms = queries.flatMap((query) => query.split(/\s+/))
    .map((term) => term.trim())
    .filter((term) => term.length > 0)
    .sort((left, right) => right.length - left.length);

  for (const term of terms) {
    for (const text of texts) {
      const index = text.indexOf(term);
      if (index >= 0) return sliceSnippet(text, index, term.length);
    }
  }

  return truncateText(texts[0] ?? '', EFFECT_SNIPPET_LIMIT);
}

/**
 * @param {string} text
 * @param {number} matchIndex
 * @param {number} matchLength
 */
function sliceSnippet(text, matchIndex, matchLength) {
  const contextSize = Math.max(40, Math.floor((EFFECT_SNIPPET_LIMIT - matchLength) / 2));
  const start = Math.max(0, matchIndex - contextSize);
  const end = Math.min(text.length, matchIndex + matchLength + contextSize);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < text.length ? '...' : '';
  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}

/**
 * @param {CardsDbLike} cardsDb
 * @param {CardRecord} card
 * @returns {number[]}
 */
function findSameNameIds(cardsDb, card) {
  if (typeof cardsDb.searchByName !== 'function') return [card.id];

  const ids = cardsDb.searchByName(card.name, { limit: SAME_NAME_LIMIT })
    .filter((candidate) => candidate.name === card.name)
    .map((candidate) => candidate.id);
  return [...new Set(ids.length > 0 ? ids : [card.id])];
}

/**
 * @param {unknown} contextOrInput
 * @param {unknown} options
 * @returns {ParsedDeck | null}
 */
function readSessionDeck(contextOrInput, options) {
  const first = asRecord(contextOrInput);
  const second = asRecord(options);
  const candidates = [
    asRecord(first.metadata)[SESSION_DECK_KEY],
    asRecord(asRecord(first.session).metadata)[SESSION_DECK_KEY],
    asRecord(second.metadata)[SESSION_DECK_KEY],
    asRecord(asRecord(second.session).metadata)[SESSION_DECK_KEY],
  ];

  for (const candidate of candidates) {
    const deck = normalizeDeck(candidate);
    if (deck) return deck;
  }

  return null;
}

/** @param {unknown} value */
function normalizeDeck(value) {
  const record = asRecord(value);
  if (!Array.isArray(record.main) || !Array.isArray(record.extra) || !Array.isArray(record.side)) return null;
  return {
    main: normalizeCardIds(record.main),
    extra: normalizeCardIds(record.extra),
    side: normalizeCardIds(record.side),
  };
}

/** @param {unknown} value */
function normalizeCardIds(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => Number(entry))
    .filter((entry) => Number.isSafeInteger(entry) && entry > 0);
}

/**
 * @param {unknown} contextOrInput
 * @param {unknown} options
 * @returns {{ name: string | null, id: number | null, query: string }}
 */
function normalizeLookup(contextOrInput, options) {
  const first = asRecord(contextOrInput);
  const second = asRecord(options);

  const directName = typeof contextOrInput === 'string' && !isIntegerString(contextOrInput)
    ? contextOrInput
    : typeof options === 'string' && !isIntegerString(options)
      ? options
      : null;
  const directId = typeof contextOrInput === 'number' || (typeof contextOrInput === 'string' && isIntegerString(contextOrInput))
    ? contextOrInput
    : typeof options === 'number' || (typeof options === 'string' && isIntegerString(options))
      ? options
      : null;

  const id = readId(second.id) ??
    readId(second.cardId) ??
    readId(second.passcode) ??
    readId(first.id) ??
    readId(first.cardId) ??
    readId(first.passcode) ??
    readId(directId);
  const name = readString(second.cardName) ??
    readString(second.name) ??
    readString(first.cardName) ??
    readString(first.name) ??
    readString(directName);

  return {
    name,
    id,
    query: id !== null ? String(id) : name ?? '',
  };
}

/**
 * @param {unknown} contextOrInput
 * @param {unknown} options
 * @returns {{ query: string, mode: SearchMode, type: TypeFilter | null, limit: number }}
 */
function normalizeCardSearch(contextOrInput, options) {
  const first = asRecord(contextOrInput);
  const second = asRecord(options);
  const directQuery = typeof contextOrInput === 'string'
    ? contextOrInput
    : typeof options === 'string'
      ? options
      : null;
  const query = readString(second.query) ??
    readString(second.keyword) ??
    readString(second.text) ??
    readString(second.cardName) ??
    readString(second.name) ??
    readString(first.query) ??
    readString(first.keyword) ??
    readString(first.text) ??
    readString(first.cardName) ??
    readString(first.name) ??
    readString(directQuery) ??
    '';
  const type = readTypeFilter(second.type) ??
    readTypeFilter(second.cardType) ??
    readTypeFilter(first.type) ??
    readTypeFilter(first.cardType);

  return {
    query: resolveCardNameAlias(query) ?? query,
    mode: normalizeSearchMode(readString(second.mode) ?? readString(second.searchMode) ?? readString(first.mode) ?? readString(first.searchMode)),
    type,
    limit: normalizeSearchLimit(second.limit ?? first.limit),
  };
}

/** @param {string | null} value */
function normalizeSearchMode(value) {
  switch (value?.toLowerCase().replace(/[-\s]/g, '_')) {
    case 'name':
    case 'names':
      return /** @type {SearchMode} */ ('name');
    case 'text':
    case 'effect':
    case 'effects':
    case 'desc':
    case 'description':
      return /** @type {SearchMode} */ ('text');
    default:
      return /** @type {SearchMode} */ ('all');
  }
}

/** @param {unknown} value */
function readTypeFilter(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string') return readString(value);
  if (Array.isArray(value)) {
    const values = value.filter((item) => (typeof item === 'string' && readString(item)) || (typeof item === 'number' && Number.isFinite(item) && item > 0));
    return values.length > 0 ? /** @type {Array<string | number>} */ (values) : null;
  }
  return null;
}

/** @param {unknown} value */
function normalizeSearchLimit(value) {
  const limit = Math.trunc(Number(value ?? DEFAULT_CARD_SEARCH_LIMIT));
  if (!Number.isFinite(limit) || limit <= 0) return DEFAULT_CARD_SEARCH_LIMIT;
  return Math.min(limit, MAX_CARD_SEARCH_LIMIT);
}

/**
 * @param {string} query
 * @param {SearchMode} mode
 */
function expandSearchQueries(query, mode) {
  const normalizedQuery = readString(query);
  if (!normalizedQuery) return [''];
  if (mode === 'name') return [normalizedQuery];

  const expanded = [normalizedQuery];
  const expansions = [
    { trigger: '特召', queries: ['特殊召唤'] },
    { trigger: '检索', queries: ['加入手卡', '从卡组'] },
    { trigger: '堆墓', queries: ['送去墓地'] },
    { trigger: '除外', queries: ['除外'] },
  ];

  for (const expansion of expansions) {
    if (!normalizedQuery.includes(expansion.trigger)) continue;
    for (const expandedQuery of expansion.queries) {
      expanded.push(expandedQuery);
      expanded.push(normalizedQuery.replaceAll(expansion.trigger, expandedQuery));
    }
  }

  return [...new Set(expanded.map((value) => readString(value)).filter(isString))];
}

/**
 * @param {unknown} contextOrInput
 * @param {unknown} options
 * @returns {CardsDbLike}
 */
function resolveCardsDb(contextOrInput, options) {
  const first = asRecord(contextOrInput);
  const second = asRecord(options);
  const runner = asRecord(first.runner);
  const candidates = [
    second.cardsDb,
    first.cardsDb,
    runner.cardsDb,
    first.cardDatabase,
    runner.cardDatabase,
  ];

  for (const candidate of candidates) {
    if (isCardsDbLike(candidate)) return candidate;
  }

  const dbPaths = readStringArray(second.dbPaths) ??
    readStringArray(first.dbPaths) ??
    readStringArray(second.cardsDbPaths) ??
    readStringArray(first.cardsDbPaths);
  const dbPath = readString(second.dbPath) ??
    readString(first.dbPath) ??
    readString(second.cardsDbPath) ??
    readString(first.cardsDbPath);
  return getSharedCardsDb(dbPaths ?? (dbPath ? [dbPath] : []));
}

/** @param {string[]} dbPaths */
function getSharedCardsDb(dbPaths) {
  const cacheKey = JSON.stringify(dbPaths);
  if (sharedCardsDb?.cacheKey === cacheKey) return sharedCardsDb.db;

  if (sharedCardsDb?.db.close) sharedCardsDb.db.close();
  sharedCardsDb = {
    cacheKey,
    db: openCardsDatabase(dbPaths.length > 0 ? { dbPaths } : {}),
  };
  return sharedCardsDb.db;
}

/**
 * @param {unknown} value
 * @returns {value is CardsDbLike}
 */
function isCardsDbLike(value) {
  const record = asRecord(value);
  return typeof record.getByName === 'function' && typeof record.getById === 'function';
}

/** @param {number} value */
function normalizeStat(value) {
  return value >= 0 ? value : null;
}

/** @param {number} value */
function formatStat(value) {
  return value >= 0 ? String(value) : UNKNOWN_STAT_TEXT;
}

/**
 * @param {string} text
 * @param {number} maxLength
 */
function truncateText(text, maxLength) {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

/** @param {unknown} value */
function readString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/** @param {unknown} value */
function readStringArray(value) {
  if (!Array.isArray(value)) return null;
  const values = value.map(readString).filter(Boolean);
  return values.length > 0 ? values : null;
}

/** @param {string | null} name */
function resolveCardNameAlias(name) {
  if (!name) return null;
  return CARD_NAME_ALIASES[/** @type {keyof typeof CARD_NAME_ALIASES} */ (name)] ?? name;
}

/** @param {unknown} value */
function readId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string' && isIntegerString(value)) return Number(value.trim());
  return null;
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isString(value) {
  return typeof value === 'string';
}

/** @param {string} value */
function isIntegerString(value) {
  return /^\d+$/.test(value.trim());
}

/** @param {unknown} value */
function asRecord(value) {
  return value && typeof value === 'object' ? /** @type {Record<string, unknown>} */ (value) : {};
}

/** @param {CardRecord} card */
function formatBanlistStatus(card) {
  const status = getBanStatusForCardSync(card);
  if (!status) return null;
  return {
    id: status.id,
    name: card.name,
    quantity: status.quantity,
    status: status.status,
    statusText: status.statusText,
    listName: status.listName,
    listHash: status.listHash,
    sourcePath: status.sourcePath,
  };
}

/** @param {CardRecord} card */
function formatScriptStatus(card) {
  const status = getCardScriptStatusSync(card);
  if (!status) return null;
  return {
    id: status.id,
    name: card.name,
    path: status.path,
    scriptsDir: status.scriptsDir,
    requiredFile: status.requiredFile,
    available: status.available,
    readable: status.readable,
    hasInitialEffect: status.hasInitialEffect,
    sha256: status.sha256,
    bytes: status.bytes,
    source: status.source,
    error: status.error,
    note: status.note,
  };
}

export const getCardEffectTool = {
  name: 'getCardEffect',
  description: 'Return effect text, type, attribute, ATK, and DEF for a card by name or ID.',
  input_schema: {
    type: 'object',
    properties: {
      cardName: {
        type: 'string',
        description: 'Card name to query. Exact matches are preferred; fuzzy name matching falls back when needed.',
      },
      id: {
        type: 'number',
        description: 'Optional YGO card passcode. If provided, it takes precedence over cardName.',
      },
    },
    additionalProperties: false,
  },
  execute: getCardEffect,
};

export const searchCardsTool = {
  name: 'searchCards',
  description: 'Search cards by fuzzy name, effect text keyword, and optional YGO card type.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Name fragment or effect keyword to search, such as 灰流, 检索, or 特召.',
      },
      mode: {
        type: 'string',
        enum: ['all', 'name', 'text'],
        description: 'Search scope. all searches names and effect text; name searches names only; text searches effect text only.',
      },
      type: {
        type: 'string',
        description: 'Optional card type filter such as monster, spell, trap, effect_monster, quick_play_spell, or counter_trap.',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of cards to return. Defaults to 20.',
        minimum: 1,
        maximum: MAX_CARD_SEARCH_LIMIT,
      },
    },
    additionalProperties: false,
  },
  execute: searchCards,
};

export const refreshCardDataSourcesTool = {
  name: 'refreshCardDataSources',
  description: 'When explicitly requested by the user, download the current official formal and MyCard prerelease resources, validate the complete downloaded card/script sets, run a dynamically selected engine probe, and atomically install the update.',
  input_schema: {
    type: 'object',
    properties: {
      force: {
        type: 'boolean',
        description: 'Accepted for compatibility; the updater always verifies the remote files when called.',
      },
      allowNetworkUpdate: {
        type: 'boolean',
        description: 'Must be true when the user explicitly requested a network-backed card data update.',
      },
      progress: {
        type: 'boolean',
        description: 'Emit progress messages while the update is running.',
      },
      timeoutMs: {
        type: 'integer',
        minimum: 1000,
        maximum: 600000,
        description: 'Network request timeout in milliseconds.',
      },
      retryCount: {
        type: 'integer',
        minimum: 0,
        maximum: 5,
        description: 'Number of retry attempts after the initial request. Defaults to 2.',
      },
    },
    additionalProperties: false,
  },
  execute: async (/** @type {unknown} */ _context, /** @type {unknown} */ input = {}) => refreshCardDataSources(asRecord(input)),
};

export const inspectCardDataSourcesTool = {
  name: 'inspectCardDataSources',
  description: 'Inspect the installed formal and prerelease card layers, banlists, and complete script coverage without downloading.',
  input_schema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  execute: async (/** @type {unknown} */ _context, /** @type {unknown} */ input = {}) => inspectCardDataSources(asRecord(input)),
};

export const getBanlistContextTool = {
  name: 'getBanlistContext',
  description: 'Return the current parsed banlist context and optionally resolve the status of a caller-provided card name or ID.',
  input_schema: {
    type: 'object',
    properties: {
      listName: {
        type: 'string',
        description: 'Optional exact banlist name. Defaults to the first/latest list in lflist.conf.',
      },
      listIndex: {
        type: 'number',
        description: 'Optional zero-based banlist index. Defaults to 0.',
      },
    },
    additionalProperties: false,
  },
  execute: async (/** @type {unknown} */ _context, /** @type {unknown} */ input = {}) => readBanlistContext(asRecord(input)),
};
