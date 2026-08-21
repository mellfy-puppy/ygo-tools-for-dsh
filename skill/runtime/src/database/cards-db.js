// @ts-check

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { requireSkillDependency } = require('../vendor-require.cjs');
const initSqlJsModule = requireSkillDependency('sql.js');
const initSqlJs = typeof initSqlJsModule === 'function' ? initSqlJsModule : initSqlJsModule.default;
if (typeof initSqlJs !== 'function') {
  throw new Error('sql.js initialization function is unavailable.');
}
const SQL = await initSqlJs();
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(MODULE_DIR, '../../..');

export const DEFAULT_CARDS_DB_PATH = resolve(SKILL_ROOT, 'resources/lib/cards.cdb');
export const DEFAULT_PRERELEASE_RELEASE_DB_PATH = resolve(SKILL_ROOT, 'resources/lib/prerelease/test-release.cdb');
export const DEFAULT_PRERELEASE_UPDATE_DB_PATH = resolve(SKILL_ROOT, 'resources/lib/prerelease/test-update.cdb');
export const DEFAULT_CACHE_SIZE = 1000;
const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 100;
const LIKE_ESCAPE = '\\';
const TEXT_STRING_COLUMNS = Array.from({ length: 16 }, (_, index) => `str${index + 1}`);
const NAME_SEARCH_COLUMNS = ['texts.name'];
const EFFECT_SEARCH_COLUMNS = ['texts.desc', ...TEXT_STRING_COLUMNS.map((column) => `texts.${column}`)];
const ALL_SEARCH_COLUMNS = [...NAME_SEARCH_COLUMNS, ...EFFECT_SEARCH_COLUMNS];

const TYPE_FLAGS = [
  { bit: 0x1, key: 'monster', label: 'Monster' },
  { bit: 0x2, key: 'spell', label: 'Spell' },
  { bit: 0x4, key: 'trap', label: 'Trap' },
  { bit: 0x10, key: 'normal', label: 'Normal' },
  { bit: 0x20, key: 'effect', label: 'Effect' },
  { bit: 0x40, key: 'fusion', label: 'Fusion' },
  { bit: 0x80, key: 'ritual', label: 'Ritual' },
  { bit: 0x100, key: 'trap_monster', label: 'Trap Monster' },
  { bit: 0x200, key: 'spirit', label: 'Spirit' },
  { bit: 0x400, key: 'union', label: 'Union' },
  { bit: 0x800, key: 'gemini', label: 'Gemini' },
  { bit: 0x1000, key: 'tuner', label: 'Tuner' },
  { bit: 0x2000, key: 'synchro', label: 'Synchro' },
  { bit: 0x4000, key: 'token', label: 'Token' },
  { bit: 0x10000, key: 'quick_play', label: 'Quick-Play' },
  { bit: 0x20000, key: 'continuous', label: 'Continuous' },
  { bit: 0x40000, key: 'equip', label: 'Equip' },
  { bit: 0x80000, key: 'field', label: 'Field' },
  { bit: 0x100000, key: 'counter', label: 'Counter' },
  { bit: 0x200000, key: 'flip', label: 'Flip' },
  { bit: 0x400000, key: 'toon', label: 'Toon' },
  { bit: 0x800000, key: 'xyz', label: 'Xyz' },
  { bit: 0x1000000, key: 'pendulum', label: 'Pendulum' },
  { bit: 0x2000000, key: 'special_summon', label: 'Special Summon' },
  { bit: 0x4000000, key: 'link', label: 'Link' },
];

const RACE_FLAGS = [
  { bit: 0x1, label: 'Warrior' },
  { bit: 0x2, label: 'Spellcaster' },
  { bit: 0x4, label: 'Fairy' },
  { bit: 0x8, label: 'Fiend' },
  { bit: 0x10, label: 'Zombie' },
  { bit: 0x20, label: 'Machine' },
  { bit: 0x40, label: 'Aqua' },
  { bit: 0x80, label: 'Pyro' },
  { bit: 0x100, label: 'Rock' },
  { bit: 0x200, label: 'Winged Beast' },
  { bit: 0x400, label: 'Plant' },
  { bit: 0x800, label: 'Insect' },
  { bit: 0x1000, label: 'Thunder' },
  { bit: 0x2000, label: 'Dragon' },
  { bit: 0x4000, label: 'Beast' },
  { bit: 0x8000, label: 'Beast-Warrior' },
  { bit: 0x10000, label: 'Dinosaur' },
  { bit: 0x20000, label: 'Fish' },
  { bit: 0x40000, label: 'Sea Serpent' },
  { bit: 0x80000, label: 'Reptile' },
  { bit: 0x100000, label: 'Psychic' },
  { bit: 0x200000, label: 'Divine-Beast' },
  { bit: 0x400000, label: 'Creator God' },
  { bit: 0x800000, label: 'Wyrm' },
  { bit: 0x1000000, label: 'Cyberse' },
  { bit: 0x2000000, label: 'Illusion' },
];

const ATTRIBUTE_FLAGS = [
  { bit: 0x1, label: 'Earth' },
  { bit: 0x2, label: 'Water' },
  { bit: 0x4, label: 'Fire' },
  { bit: 0x8, label: 'Wind' },
  { bit: 0x10, label: 'Light' },
  { bit: 0x20, label: 'Dark' },
  { bit: 0x40, label: 'Divine' },
];

const TYPE_MASK_BY_ALIAS = new Map([
  ['monster', 0x1],
  ['monsters', 0x1],
  ['spell', 0x2],
  ['spells', 0x2],
  ['magic', 0x2],
  ['trap', 0x4],
  ['traps', 0x4],
  ['normal', 0x10],
  ['effect', 0x20],
  ['fusion', 0x40],
  ['ritual', 0x80],
  ['trap_monster', 0x100],
  ['spirit', 0x200],
  ['union', 0x400],
  ['gemini', 0x800],
  ['tuner', 0x1000],
  ['synchro', 0x2000],
  ['token', 0x4000],
  ['quick_play', 0x10000],
  ['quickplay', 0x10000],
  ['continuous', 0x20000],
  ['equip', 0x40000],
  ['field', 0x80000],
  ['counter', 0x100000],
  ['flip', 0x200000],
  ['toon', 0x400000],
  ['xyz', 0x800000],
  ['pendulum', 0x1000000],
  ['special_summon', 0x2000000],
  ['spsummon', 0x2000000],
  ['link', 0x4000000],
  ['normal_monster', 0x1 | 0x10],
  ['effect_monster', 0x1 | 0x20],
  ['normal_spell', 0x2 | 0x10],
  ['quick_play_spell', 0x2 | 0x10000],
  ['continuous_spell', 0x2 | 0x20000],
  ['equip_spell', 0x2 | 0x40000],
  ['field_spell', 0x2 | 0x80000],
  ['normal_trap', 0x4 | 0x10],
  ['continuous_trap', 0x4 | 0x20000],
  ['counter_trap', 0x4 | 0x100000],
]);

const CARD_SELECT_COLUMNS = [
  'datas.id AS id',
  'datas.ot AS ot',
  'datas.alias AS alias',
  'datas.setcode AS setcode',
  'datas.type AS rawType',
  'datas.atk AS atk',
  'datas.def AS def',
  'datas.level AS level',
  'datas.race AS race',
  'datas.attribute AS attribute',
  'datas.category AS category',
  'texts.name AS name',
  'texts.desc AS desc',
  ...TEXT_STRING_COLUMNS.map((column) => `texts.${column} AS ${column}`),
].join(',\n  ');

const CARD_FROM_SQL = `
FROM datas
JOIN texts ON texts.id = datas.id
`;

/** @typedef {{ name: string, type: string, notnull: number, dflt_value: unknown, pk: number }} SchemaColumn */
/** @typedef {{ datas: SchemaColumn[], texts: SchemaColumn[] }} CardsDbSchema */
/** @typedef {{ dbPath?: string, dbPaths?: string[], cacheSize?: number }} CardsDatabaseOptions */
/** @typedef {{ limit?: number, type?: string | number | Array<string | number> }} CardSearchOptions */
/** @typedef {{ count?: number, limit?: number, type?: string | number | Array<string | number> }} CardRandomOptions */
/** @typedef {{ id: number, name: string, description: string, effectText: string, strings: string[], rawType: number, type: string, typeTags: string[], ot: number, alias: number, setcode: number, atk: number, def: number, level: number, race: number, raceText: string | null, attribute: number, attributeText: string | null, category: number }} CardRecord */
/** @typedef {{ get: (...params: unknown[]) => unknown, all: (...params: unknown[]) => unknown[] }} SqliteStatement */
/** @typedef {{ prepare: (sql: string) => SqliteStatement, close: () => void }} SqliteDatabase */
/** @typedef {{ prepare: (sql: string) => SqljsStatementHandle, close: () => void }} SqljsDatabaseHandle */
/** @typedef {{ bind: (params?: unknown) => boolean, step: () => boolean, getAsObject: () => Record<string, unknown>, free: () => void }} SqljsStatementHandle */

class SqljsFileDatabase {
  /** @param {string} dbPath */
  constructor(dbPath) {
    if (!existsSync(dbPath)) {
      throw new Error(`cards.cdb not found: ${dbPath}`);
    }
    this.db = new SQL.Database(readFileSync(dbPath));
  }

  /** @param {string} sql */
  prepare(sql) {
    return new SqljsPreparedStatement(this.db, sql);
  }

  close() {
    this.db.close();
  }
}

/** @param {SqljsStatementHandle} statement @param {unknown[]} params */
function bindSqljsParams(statement, params) {
  if (params.length === 0) {
    statement.bind();
    return;
  }

  if (params.length === 1) {
    const first = params[0];
    if (Array.isArray(first)) {
      statement.bind(first);
      return;
    }
    if (isPlainRecord(first)) {
      statement.bind(prefixSqljsNamedParams(first));
      return;
    }
  }

  statement.bind(params);
}

/** @param {Record<string, unknown>} params */
function prefixSqljsNamedParams(params) {
  /** @type {Record<string, unknown>} */
  const result = {};
  for (const [key, value] of Object.entries(params)) {
    const prefixedKey = key.startsWith('@') || key.startsWith(':') || key.startsWith('$') ? key : `@${key}`;
    result[prefixedKey] = value;
  }
  return result;
}

class SqljsPreparedStatement {
  /**
   * @param {SqljsDatabaseHandle} db
   * @param {string} sql
   */
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
  }

  /** @param {...unknown} params */
  get(...params) {
    const statement = this.db.prepare(this.sql);
    try {
      bindSqljsParams(statement, params);
      return statement.step() ? statement.getAsObject() : undefined;
    } finally {
      statement.free();
    }
  }

  /** @param {...unknown} params */
  all(...params) {
    const statement = this.db.prepare(this.sql);
    try {
      bindSqljsParams(statement, params);
      /** @type {Record<string, unknown>[]} */
      const rows = [];
      while (statement.step()) {
        rows.push(statement.getAsObject());
      }
      return rows;
    } finally {
      statement.free();
    }
  }
}

/**
 * Small Map-backed LRU cache. Map preserves insertion order, so refreshing a key
 * is enough to move it to the most-recently-used end.
 *
 * @template T
 */
export class LruCache {
  /** @param {number} [maxSize] */
  constructor(maxSize = DEFAULT_CACHE_SIZE) {
    this.maxSize = normalizeCacheSize(maxSize);
    /** @type {Map<string, T>} */
    this.values = new Map();
  }

  /** @param {string} key */
  get(key) {
    if (!this.values.has(key)) return undefined;
    const value = this.values.get(key);
    this.values.delete(key);
    this.values.set(key, /** @type {T} */ (value));
    return value;
  }

  /**
   * @param {string} key
   * @param {T} value
   */
  set(key, value) {
    if (this.values.has(key)) this.values.delete(key);
    this.values.set(key, value);
    while (this.values.size > this.maxSize) {
      const first = this.values.keys().next();
      if (first.done) break;
      this.values.delete(first.value);
    }
  }

  clear() {
    this.values.clear();
  }

  stats() {
    return {
      size: this.values.size,
      maxSize: this.maxSize,
    };
  }
}

export class CardsDatabase {
  /** @param {CardsDatabaseOptions} [options] */
  constructor(options = {}) {
    this.dbPath = resolveCardsDbPath(options.dbPath);
    /** @type {LruCache<CardRecord | CardRecord[] | CardsDbSchema | null>} */
    this.cache = new LruCache(options.cacheSize);
    this.db = new SqljsFileDatabase(this.dbPath);
    this.schema = readSchema(this.db);
    validateSchema(this.schema);
    this.statements = prepareStatements(this.db);
  }

  getSchema() {
    return this.schema;
  }

  cacheStats() {
    return this.cache.stats();
  }

  clearCache() {
    this.cache.clear();
  }

  close() {
    this.db.close();
  }

  /** @param {number | string} id */
  getById(id) {
    const normalizedId = normalizeId(id);
    if (normalizedId === null) return null;

    const cacheKey = `id:${normalizedId}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) return /** @type {CardRecord | null} */ (cached);

    const row = this.statements.byId.get(normalizedId);
    const card = row ? formatCardRow(row) : null;
    this.cache.set(cacheKey, card);
    return card;
  }

  /** @param {string} name */
  getByName(name) {
    const normalizedName = readString(name);
    if (!normalizedName) return null;

    const cacheKey = `name:${normalizedName}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) return /** @type {CardRecord | null} */ (cached);

    const exactRow = this.statements.byExactName.get(normalizedName);
    const row = exactRow ?? this.statements.byNameLike.get({
      exactName: normalizedName,
      prefixLike: `${escapeLike(normalizedName)}%`,
      nameLike: `%${escapeLike(normalizedName)}%`,
    });
    const card = row ? formatCardRow(row) : null;
    this.cache.set(cacheKey, card);
    return card;
  }

  /**
   * Search names only and return the best matching cards.
   *
   * @param {string} query
   * @param {CardSearchOptions} [options]
   */
  searchByName(query, options = {}) {
    return this.searchInternal('name', query, NAME_SEARCH_COLUMNS, options);
  }

  /**
   * Search effect text, including desc and action strings str1-str16.
   *
   * @param {string} query
   * @param {CardSearchOptions} [options]
   */
  searchByText(query, options = {}) {
    return this.searchInternal('text', query, EFFECT_SEARCH_COLUMNS, options);
  }

  /**
   * Search names, effect text, and action strings with LIKE-based matching.
   *
   * @param {string} query
   * @param {CardSearchOptions} [options]
   */
  searchCards(query, options = {}) {
    return this.searchInternal('all', query, ALL_SEARCH_COLUMNS, options);
  }

  /**
   * Return cards matching a YGOPro type mask or type alias.
   *
   * @param {string | number | Array<string | number>} type
   * @param {{ limit?: number }} [options]
   */
  findByType(type, options = {}) {
    return this.searchCards('', { type, limit: options.limit });
  }

  /**
   * Return random cards, optionally filtered by a YGOPro type mask or alias.
   *
   * @param {CardRandomOptions} [options]
   */
  randomCards(options = {}) {
    const limit = normalizeSearchLimit(options.count ?? options.limit);
    const typeMask = normalizeTypeMask(options.type);
    const params = typeMask === null ? { limit } : { limit, typeMask };
    const rows = this.db.prepare(buildRandomCardsSql(typeMask !== null)).all(params);
    return rows.map((row) => formatCardRow(row));
  }

  /**
   * @param {CardRandomOptions} [options]
   */
  getRandomCards(options = {}) {
    return this.randomCards(options);
  }

  /** @param {number | string} id */
  queryById(id) {
    return this.getById(id);
  }

  /** @param {string} name */
  queryByName(name) {
    return this.getByName(name);
  }

  /**
   * @param {string | number | Array<string | number>} type
   * @param {{ limit?: number }} [options]
   */
  queryByType(type, options = {}) {
    return this.findByType(type, options);
  }

  /**
   * @param {'name' | 'text' | 'all'} mode
   * @param {string} query
   * @param {string[]} searchColumns
   * @param {CardSearchOptions} options
   * @returns {CardRecord[]}
   */
  searchInternal(mode, query, searchColumns, options) {
    const normalizedQuery = readString(query) ?? '';
    const terms = tokenizeQuery(normalizedQuery);
    const limit = normalizeSearchLimit(options.limit);
    const typeMask = normalizeTypeMask(options.type);
    const cacheKey = `search:${mode}:${terms.join('\u0001')}:type:${typeMask ?? ''}:limit:${limit}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) return /** @type {CardRecord[]} */ (cached);

    if (terms.length === 0 && typeMask === null) {
      this.cache.set(cacheKey, []);
      return [];
    }

    const params = buildSearchParams(normalizedQuery, terms, typeMask, limit);
    const sql = buildSearchSql(searchColumns, terms, typeMask !== null);
    const rows = this.db.prepare(sql).all(params);
    const cards = rows.map((row) => formatCardRow(row));
    this.cache.set(cacheKey, cards);
    return cards;
  }
}

/** @param {CardsDatabaseOptions} [options] */
export function openCardsDatabase(options = {}) {
  const dbPaths = resolveCardsDbPaths(options);
  if (dbPaths.length === 1) return new CardsDatabase({ ...options, dbPath: dbPaths[0] });
  return new LayeredCardsDatabase({ ...options, dbPaths });
}

export class LayeredCardsDatabase {
  /** @param {CardsDatabaseOptions} options */
  constructor(options) {
    this.dbPaths = resolveCardsDbPaths(options);
    this.dbPath = this.dbPaths.join(';');
    this.layers = this.dbPaths.map((dbPath) => new CardsDatabase({ dbPath, cacheSize: options.cacheSize }));
  }

  getSchema() {
    return this.layers[0].getSchema();
  }

  cacheStats() {
    const stats = this.layers.map((layer) => layer.cacheStats());
    return {
      size: stats.reduce((sum, item) => sum + item.size, 0),
      maxSize: stats.reduce((sum, item) => sum + item.maxSize, 0),
      layers: stats.length,
    };
  }

  clearCache() {
    for (const layer of this.layers) layer.clearCache();
  }

  close() {
    for (const layer of this.layers) layer.close();
  }

  /** @param {number | string} id */
  getById(id) {
    for (const layer of this.layers) {
      const card = layer.getById(id);
      if (card) return card;
    }
    return null;
  }

  /** @param {string} name */
  getByName(name) {
    const candidates = [];
    for (const layer of this.layers) {
      const card = layer.getByName(name);
      if (!card) continue;
      if (card.name === name) return card;
      candidates.push(card);
    }
    return candidates[0] ?? null;
  }

  /** @param {string} query @param {CardSearchOptions} [options] */
  searchByName(query, options = {}) {
    return collectLayeredCards(this.layers, 'searchByName', [query, options], options.limit);
  }

  /** @param {string} query @param {CardSearchOptions} [options] */
  searchByText(query, options = {}) {
    return collectLayeredCards(this.layers, 'searchByText', [query, options], options.limit);
  }

  /** @param {string} query @param {CardSearchOptions} [options] */
  searchCards(query, options = {}) {
    return collectLayeredCards(this.layers, 'searchCards', [query, options], options.limit);
  }

  /** @param {string | number | Array<string | number>} type @param {{ limit?: number }} [options] */
  findByType(type, options = {}) {
    return collectLayeredCards(this.layers, 'findByType', [type, options], options.limit);
  }

  /** @param {CardRandomOptions} [options] */
  randomCards(options = {}) {
    return this.layers[this.layers.length - 1].randomCards(options);
  }

  /** @param {CardRandomOptions} [options] */
  getRandomCards(options = {}) {
    return this.randomCards(options);
  }

  /** @param {number | string} id */
  queryById(id) {
    return this.getById(id);
  }

  /** @param {string} name */
  queryByName(name) {
    return this.getByName(name);
  }

  /** @param {string | number | Array<string | number>} type @param {{ limit?: number }} [options] */
  queryByType(type, options = {}) {
    return this.findByType(type, options);
  }
}

/**
 * @param {CardsDatabase[]} layers
 * @param {'searchByName' | 'searchByText' | 'searchCards' | 'findByType'} method
 * @param {unknown[]} args
 * @param {unknown} requestedLimit
 */
function collectLayeredCards(layers, method, args, requestedLimit) {
  const limit = normalizeSearchLimit(requestedLimit);
  const cards = [];
  const seen = new Set();
  for (const layer of layers) {
    const batch = layer[method](...args);
    for (const card of batch) {
      if (seen.has(card.id)) continue;
      seen.add(card.id);
      cards.push(card);
      if (cards.length >= limit) return cards;
    }
  }
  return cards;
}

/** @param {number} typeValue */
export function decodeCardType(typeValue) {
  const tags = decodeTypeTags(typeValue);
  return {
    value: typeValue,
    tags,
    text: tags.length > 0 ? tags.map((tag) => typeLabelForTag(tag)).join(' / ') : 'Unknown',
  };
}

/** @param {unknown} dbPath */
function resolveCardsDbPath(dbPath) {
  const path = readString(dbPath);
  return path ? resolve(path) : DEFAULT_CARDS_DB_PATH;
}

/** @param {CardsDatabaseOptions} options */
function resolveCardsDbPaths(options) {
  const candidates = Array.isArray(options.dbPaths) && options.dbPaths.length > 0
    ? options.dbPaths
    : options.dbPath
      ? [options.dbPath]
      : [DEFAULT_PRERELEASE_UPDATE_DB_PATH, DEFAULT_PRERELEASE_RELEASE_DB_PATH, DEFAULT_CARDS_DB_PATH];
  const paths = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const path = resolveCardsDbPath(candidate);
    if (seen.has(path) || !existsSync(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  if (paths.length === 0) {
    throw new Error(`No readable card database found in: ${candidates.map((value) => resolveCardsDbPath(value)).join(', ')}`);
  }
  return paths;
}

/** @param {unknown} value */
function normalizeCacheSize(value) {
  const size = Math.trunc(Number(value ?? DEFAULT_CACHE_SIZE));
  if (!Number.isFinite(size) || size <= 0) return DEFAULT_CACHE_SIZE;
  return size;
}

/** @param {unknown} value */
function normalizeSearchLimit(value) {
  const limit = Math.trunc(Number(value ?? DEFAULT_SEARCH_LIMIT));
  if (!Number.isFinite(limit) || limit <= 0) return DEFAULT_SEARCH_LIMIT;
  return Math.min(limit, MAX_SEARCH_LIMIT);
}

/** @param {unknown} value */
function normalizeId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

/**
 * @param {SqliteDatabase} db
 * @returns {CardsDbSchema}
 */
function readSchema(db) {
  return {
    datas: db.prepare('PRAGMA table_info(datas)').all().map(formatSchemaColumn),
    texts: db.prepare('PRAGMA table_info(texts)').all().map(formatSchemaColumn),
  };
}

/** @param {unknown} value */
function formatSchemaColumn(value) {
  const record = asRecord(value);
  return {
    name: readString(record.name) ?? '',
    type: readString(record.type) ?? '',
    notnull: readInteger(record.notnull) ?? 0,
    dflt_value: record.dflt_value ?? null,
    pk: readInteger(record.pk) ?? 0,
  };
}

/** @param {CardsDbSchema} schema */
function validateSchema(schema) {
  const datas = new Set(schema.datas.map((column) => column.name));
  const texts = new Set(schema.texts.map((column) => column.name));
  const requiredDatas = ['id', 'ot', 'alias', 'setcode', 'type', 'atk', 'def', 'level', 'race', 'attribute', 'category'];
  const requiredTexts = ['id', 'name', 'desc', ...TEXT_STRING_COLUMNS];
  const missingDatas = requiredDatas.filter((column) => !datas.has(column));
  const missingTexts = requiredTexts.filter((column) => !texts.has(column));

  if (missingDatas.length > 0 || missingTexts.length > 0) {
    throw new Error(
      `cards.cdb schema mismatch. Missing datas columns: ${missingDatas.join(', ') || 'none'}; missing texts columns: ${missingTexts.join(', ') || 'none'}.`,
    );
  }
}

/** @param {SqliteDatabase} db */
function prepareStatements(db) {
  return {
    byId: db.prepare(`
SELECT
  ${CARD_SELECT_COLUMNS}
${CARD_FROM_SQL}
WHERE datas.id = ?
LIMIT 1
`),
    byExactName: db.prepare(`
SELECT
  ${CARD_SELECT_COLUMNS}
${CARD_FROM_SQL}
WHERE texts.name = ?
ORDER BY datas.id
LIMIT 1
`),
    byNameLike: db.prepare(`
SELECT
  ${CARD_SELECT_COLUMNS}
${CARD_FROM_SQL}
WHERE texts.name LIKE @nameLike ESCAPE '${LIKE_ESCAPE}'
ORDER BY
  CASE
    WHEN texts.name = @exactName THEN 0
    WHEN texts.name LIKE @prefixLike ESCAPE '${LIKE_ESCAPE}' THEN 1
    ELSE 2
  END,
  length(texts.name),
  datas.id
LIMIT 1
`),
  };
}

/**
 * @param {string[]} searchColumns
 * @param {string[]} terms
 * @param {boolean} hasTypeFilter
 */
function buildSearchSql(searchColumns, terms, hasTypeFilter) {
  const whereParts = [];
  for (let index = 0; index < terms.length; index += 1) {
    const termKey = `@term${index}`;
    whereParts.push(`(${searchColumns.map((column) => `${column} LIKE ${termKey} ESCAPE '${LIKE_ESCAPE}'`).join(' OR ')})`);
  }

  if (hasTypeFilter) {
    whereParts.push('(datas.type & @typeMask) = @typeMask');
  }

  const whereSql = whereParts.length > 0 ? `WHERE ${whereParts.join('\n  AND ')}` : '';
  return `
SELECT
  ${CARD_SELECT_COLUMNS}
${CARD_FROM_SQL}
${whereSql}
ORDER BY
  CASE
    WHEN texts.name = @exactQuery THEN 0
    WHEN texts.name LIKE @prefixQuery ESCAPE '${LIKE_ESCAPE}' THEN 1
    WHEN texts.name LIKE @likeQuery ESCAPE '${LIKE_ESCAPE}' THEN 2
    ELSE 3
  END,
  length(texts.name),
  texts.name,
  datas.id
LIMIT @limit
`;
}

/** @param {boolean} hasTypeFilter */
function buildRandomCardsSql(hasTypeFilter) {
  const whereSql = hasTypeFilter ? 'WHERE (datas.type & @typeMask) = @typeMask' : '';
  return `
SELECT
  ${CARD_SELECT_COLUMNS}
${CARD_FROM_SQL}
${whereSql}
ORDER BY random()
LIMIT @limit
`;
}

/**
 * @param {string} query
 * @param {string[]} terms
 * @param {number | null} typeMask
 * @param {number} limit
 */
function buildSearchParams(query, terms, typeMask, limit) {
  /** @type {Record<string, string | number>} */
  const params = {
    exactQuery: query,
    prefixQuery: `${escapeLike(query)}%`,
    likeQuery: `%${escapeLike(query)}%`,
    limit,
  };

  if (typeMask !== null) params.typeMask = typeMask;
  terms.forEach((term, index) => {
    params[`term${index}`] = `%${escapeLike(term)}%`;
  });

  return params;
}

/** @param {unknown} row */
function formatCardRow(row) {
  const record = asRecord(row);
  const id = readInteger(record.id);
  if (id === null) throw new Error('Card row is missing a numeric id.');

  const rawType = readInteger(record.rawType) ?? 0;
  const type = decodeCardType(rawType);
  const race = readInteger(record.race) ?? 0;
  const attribute = readInteger(record.attribute) ?? 0;
  const description = readString(record.desc) ?? '';

  return {
    id,
    name: readString(record.name) ?? `Card ${id}`,
    description,
    effectText: description,
    strings: TEXT_STRING_COLUMNS.map((column) => readString(record[column])).filter(isString),
    rawType,
    type: type.text,
    typeTags: type.tags,
    ot: readInteger(record.ot) ?? 0,
    alias: readInteger(record.alias) ?? 0,
    setcode: readInteger(record.setcode) ?? 0,
    atk: readInteger(record.atk) ?? 0,
    def: readInteger(record.def) ?? 0,
    level: readInteger(record.level) ?? 0,
    race,
    raceText: decodeExactFlag(RACE_FLAGS, race),
    attribute,
    attributeText: decodeExactFlag(ATTRIBUTE_FLAGS, attribute),
    category: readInteger(record.category) ?? 0,
  };
}

/** @param {unknown} value */
function normalizeTypeMask(value) {
  if (value === undefined || value === null || value === '') return null;

  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value >>> 0 : null;
  }

  if (Array.isArray(value)) {
    const mask = value.reduce((combined, item) => {
      const itemMask = normalizeTypeMask(item);
      return itemMask === null ? combined : combined | itemMask;
    }, 0);
    return mask || null;
  }

  const rawText = readString(value);
  if (!rawText) return null;

  const normalized = rawText.toLowerCase().replace(/[-\s]+/g, '_');
  if (/^0x[0-9a-f]+$/i.test(normalized)) return Number.parseInt(normalized, 16) >>> 0;
  if (/^\d+$/.test(normalized)) return Number(normalized) >>> 0;

  const splitParts = normalized.split(/[,+|/]/).map((part) => part.trim()).filter(Boolean);
  if (splitParts.length > 1) {
    const mask = splitParts.reduce((combined, part) => {
      const partMask = TYPE_MASK_BY_ALIAS.get(part) ?? null;
      return partMask === null ? combined : combined | partMask;
    }, 0);
    return mask || null;
  }

  return TYPE_MASK_BY_ALIAS.get(normalized) ?? null;
}

/** @param {number} typeValue */
function decodeTypeTags(typeValue) {
  return TYPE_FLAGS
    .filter((flag) => (typeValue & flag.bit) !== 0)
    .map((flag) => flag.key);
}

/** @param {string} tag */
function typeLabelForTag(tag) {
  return TYPE_FLAGS.find((flag) => flag.key === tag)?.label ?? tag;
}

/**
 * @param {{ bit: number, label: string }[]} flags
 * @param {number} value
 */
function decodeExactFlag(flags, value) {
  return flags.find((flag) => flag.bit === value)?.label ?? null;
}

/** @param {string} query */
function tokenizeQuery(query) {
  return query.split(/\s+/).map((term) => term.trim()).filter(Boolean);
}

/** @param {string} value */
function escapeLike(value) {
  return value.replace(/[\\%_]/g, (character) => `${LIKE_ESCAPE}${character}`);
}

/** @param {unknown} value */
function readString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/** @param {unknown} value */
function readInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

/** @param {unknown} value */
function isString(value) {
  return typeof value === 'string';
}

/** @param {unknown} value */
function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} value */
function asRecord(value) {
  return value && typeof value === 'object' ? /** @type {Record<string, unknown>} */ (value) : {};
}
