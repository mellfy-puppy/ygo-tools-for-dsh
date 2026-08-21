// @ts-check

/**
 * Runner factory for creating real YGO game runners.
 *
 * This integrates with combo-simulator.cjs to create actual game instances.
 */

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SKILL_ROOT = resolve(PROJECT_ROOT, '..');
const require = createRequire(import.meta.url);

const DEFAULT_CARDS_DB = resolve(SKILL_ROOT, 'resources/lib/cards.cdb');
const DEFAULT_SCRIPTS_DIR = resolve(SKILL_ROOT, 'resources/lib/ygopro-scripts');
const DEFAULT_DECK = resolve(SKILL_ROOT, 'resources/lib/slm.ydk');
const DEFAULT_DRAW_COUNT = 5;
const DEFAULT_MAX_DEPTH = 150;
const DEFAULT_MAX_NODES = 10000;
const DEFAULT_BEAM_WIDTH = 50;
const DEFAULT_MAX_ACTIONS_PER_NODE = 100;
const DEFAULT_SNAPSHOT_POOL_SIZE = 1000;

/** @typedef {{ main: number[], extra: number[], side: number[] }} ParsedDeck */
/** @typedef {{ opening: number[], remain: number[], label?: string | null }} OpeningState */
/** @typedef {{ deck?: string, cardsDb?: string, cardsDbs?: string[], scriptsDir?: string, scriptDirs?: string[], seed?: number, yrpVersion?: number, drawCount?: number, playerDeck?: ParsedDeck, opponentDeck?: ParsedDeck, playerOpening?: OpeningState, opponentOpening?: OpeningState, quiet?: boolean }} RunnerFactoryOptions */

/**
 * Load deck from .ydk file
 * @param {string} deckPath
 * @returns {Promise<{ main: number[], extra: number[], side: number[] }>}
 */
async function loadDeck(deckPath) {
  const content = await readFile(deckPath, 'utf-8');
  const main = [];
  const extra = [];
  const side = [];

  let currentSection = null;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      // Handle section markers
      if (trimmed === '#main') {
        currentSection = 'main';
      } else if (trimmed === '#extra') {
        currentSection = 'extra';
      }
      continue;
    }

    if (trimmed === '!side') {
      currentSection = 'side';
      continue;
    }

    const cardId = parseInt(trimmed, 10);
    if (Number.isFinite(cardId) && cardId > 0) {
      if (currentSection === 'side') {
        side.push(cardId);
      } else if (currentSection === 'extra') {
        extra.push(cardId);
      } else {
        // Default to main if no section specified
        main.push(cardId);
      }
    }
  }

  return { main, extra, side };
}

/** @param {unknown} value */
function normalizeDeckOption(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = /** @type {Record<string, unknown>} */ (value);
  if (!Array.isArray(record.main)) return null;
  return {
    main: normalizeCardCodes(record.main),
    extra: normalizeCardCodes(Array.isArray(record.extra) ? record.extra : []),
    side: normalizeCardCodes(Array.isArray(record.side) ? record.side : []),
  };
}

/** @param {unknown} value */
function normalizeOpeningOption(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = /** @type {Record<string, unknown>} */ (value);
  if (!Array.isArray(record.opening) || !Array.isArray(record.remain)) return null;
  return {
    opening: normalizeCardCodes(record.opening),
    remain: normalizeCardCodes(record.remain),
    label: typeof record.label === 'string' ? record.label : null,
  };
}

/** @param {unknown[]} values */
function normalizeCardCodes(values) {
  return values
    .map((value) => Math.trunc(Number(value)))
    .filter((value) => Number.isSafeInteger(value) && value > 0);
}

/**
 * Create a real YGO game runner using combo-simulator
 * @param {RunnerFactoryOptions} [options]
 * @returns {Promise<any>}
 */
export async function createRealRunner(options = {}) {
  const deckPath = options.deck ?? DEFAULT_DECK;
  const cardsPaths = Array.isArray(options.cardsDbs) && options.cardsDbs.length > 0
    ? options.cardsDbs.filter((value) => typeof value === 'string' && value.trim())
    : [options.cardsDb ?? DEFAULT_CARDS_DB];
  const cardsPath = cardsPaths[cardsPaths.length - 1];
  const scriptsDir = options.scriptsDir ?? DEFAULT_SCRIPTS_DIR;
  const scriptDirs = Array.isArray(options.scriptDirs)
    ? options.scriptDirs.filter((value) => typeof value === 'string' && value.trim())
    : [scriptsDir];
  const seed = options.seed ?? Math.floor(Math.random() * 1000000);
  const drawCount = options.drawCount ?? DEFAULT_DRAW_COUNT;
  const yrpVersion = options.yrpVersion === 1 ? 1 : 2;

  // Load deck
  const deck = normalizeDeckOption(options.playerDeck) ?? await loadDeck(deckPath);
  const opponentDeck = normalizeDeckOption(options.opponentDeck) ?? { main: [], extra: [], side: [] };
  const playerOpening = normalizeOpeningOption(options.playerOpening) ?? { opening: [], remain: [], label: null };
  const opponentOpening = normalizeOpeningOption(options.opponentOpening) ?? { opening: [], remain: [], label: null };

  if (!options.quiet) {
    console.log(`[RunnerFactory] Creating real runner with deck: ${deckPath}`);
    console.log(`[RunnerFactory] Main deck: ${deck.main.length} cards`);
    console.log(`[RunnerFactory] Extra deck: ${deck.extra.length} cards`);
    console.log(`[RunnerFactory] Seed: ${seed}`);
  }

  // Import combo-simulator functions
  const comboSimulator = require(resolve(PROJECT_ROOT, 'combo-simulator.cjs'));

  // Build job object for createSearchContext
  const job = {
    cardsPath,
    cardsPaths,
    scriptDirs: scriptDirs.length > 0 ? scriptDirs : [scriptsDir],
    seed,
    drawCount,
    yrpVersion,
    maxDepth: DEFAULT_MAX_DEPTH,
    maxNodes: DEFAULT_MAX_NODES,
    maxBeamWidth: DEFAULT_BEAM_WIDTH,
    maxActionsPerNode: DEFAULT_MAX_ACTIONS_PER_NODE,
    factorizeLargeSelections: true,
    snapshotPoolSize: DEFAULT_SNAPSHOT_POOL_SIZE,
    expandScriptKeywords: false,
    playerDeck: deck,
    opponentDeck,
    playerOpening,
    opponentOpening,
    engineBackend: 'js', // Use JS engine, not native
    exactSingleSearch: false,
  };

  // Create search context (runtime + runner)
  const { runtime, runner } = await comboSimulator.createSearchContext(job);

  if (!options.quiet) {
    console.log(`[RunnerFactory] Runner created successfully`);
    console.log(`[RunnerFactory] Runner type: ${runner.constructor.name}`);
  }

  return runner;
}

/**
 * Create runner factory function
 * @param {RunnerFactoryOptions} [defaultOptions]
 * @returns {(options?: RunnerFactoryOptions) => Promise<any>}
 */
export function createRunnerFactory(defaultOptions = {}) {
  return async (options = {}) => {
    return createRealRunner({ ...defaultOptions, ...options });
  };
}
