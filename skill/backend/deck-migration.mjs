import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const SECTIONS = Object.freeze(['main', 'extra', 'side']);

export async function loadIdMigrationMap(config) {
  const path = resolve(config.idMigrationsPath ?? resolve(config.resourceRoot, 'lib', 'id-migrations.json'));
  try {
    const payload = JSON.parse(await readFile(path, 'utf8'));
    const entries = Array.isArray(payload?.migrations) ? payload.migrations : [];
    return {
      path,
      updatedAt: typeof payload.updatedAt === 'string' ? payload.updatedAt : null,
      map: new Map(entries.flatMap((entry) => {
        const oldId = readId(entry?.oldId);
        const newId = readId(entry?.newId);
        return oldId && newId && oldId !== newId
          ? [[oldId, { oldId, newId, name: readText(entry?.name) }]]
          : [];
      })),
    };
  } catch {
    return { path, updatedAt: null, map: new Map() };
  }
}

export function migrateDeckIds(deck, cardsDb, migrations, inputUnknownCards = []) {
  const originalDeck = cloneDeck(deck);
  const migratedDeck = { main: [], extra: [], side: [] };
  const changes = [];
  const unresolved = [...inputUnknownCards.map((entry) => ({ ...entry, reason: entry.error ?? 'Unresolved deck entry.' }))];

  for (const section of SECTIONS) {
    originalDeck[section].forEach((oldId, index) => {
      const resolution = resolveCurrentCardId(oldId, cardsDb, migrations.map);
      if (!resolution.ok) {
        unresolved.push({ section, index, oldId, reason: resolution.reason, chain: resolution.chain });
        return;
      }
      migratedDeck[section].push(resolution.id);
      if (resolution.id !== oldId) {
        changes.push({ section, index, oldId, newId: resolution.id, name: resolution.name, chain: resolution.chain });
      }
    });
  }

  return {
    ok: unresolved.length === 0,
    originalDeck,
    deck: migratedDeck,
    report: summarizeMigration(changes, unresolved, migrations),
  };
}

export function migrateCardEntries(entries, cardsDb, migrations, label = 'cards') {
  const cards = [];
  const changes = [];
  const unresolved = [];
  entries.forEach((entry, index) => {
    const direct = readEntryId(entry);
    if (direct) {
      const resolution = resolveCurrentCardId(direct, cardsDb, migrations.map);
      if (!resolution.ok) unresolved.push({ label, index, input: entry, oldId: direct, reason: resolution.reason, chain: resolution.chain });
      else {
        cards.push(resolution.id);
        if (resolution.id !== direct) changes.push({ label, index, oldId: direct, newId: resolution.id, name: resolution.name, chain: resolution.chain });
      }
      return;
    }
    const name = readText(entry) ?? readText(entry?.name) ?? readText(entry?.cardName);
    const card = name ? cardsDb.getByName(name) : null;
    if (card) cards.push(card.id);
    else unresolved.push({ label, index, input: entry, reason: name ? `Unknown card name: ${name}` : 'Card must be a known name or positive ID.' });
  });
  return { ok: unresolved.length === 0, cards, report: summarizeMigration(changes, unresolved, migrations) };
}

export function resolveCurrentCardId(id, cardsDb, migrationMap) {
  const start = readId(id);
  if (!start) return { ok: false, reason: `Invalid card ID: ${String(id)}`, chain: [] };
  const direct = cardsDb.getById(start);
  if (direct) return { ok: true, id: start, name: direct.name, chain: [start] };
  const chain = [start];
  const visited = new Set(chain);
  let current = start;
  while (migrationMap.has(current)) {
    const next = migrationMap.get(current).newId;
    chain.push(next);
    if (visited.has(next)) return { ok: false, reason: `Card ID migration cycle: ${chain.join(' -> ')}`, chain };
    visited.add(next);
    const card = cardsDb.getById(next);
    if (card) return { ok: true, id: next, name: card.name, chain };
    current = next;
  }
  return { ok: false, reason: `Unknown card ID ${start}; no migration reaches the current database.`, chain };
}

function summarizeMigration(changes, unresolved, migrations) {
  const byPair = new Map();
  for (const change of changes) {
    const key = `${change.oldId}:${change.newId}`;
    const item = byPair.get(key) ?? { oldId: change.oldId, newId: change.newId, name: change.name, count: 0, locations: [] };
    item.count += 1;
    item.locations.push({ section: change.section ?? change.label, index: change.index });
    byPair.set(key, item);
  }
  return {
    applied: changes.length > 0,
    migratedCards: changes.length,
    migrations: [...byPair.values()],
    changes,
    unresolved,
    migrationSource: migrations.path,
    migrationSourceUpdatedAt: migrations.updatedAt,
  };
}

function cloneDeck(deck) {
  return Object.fromEntries(SECTIONS.map((section) => [section, Array.isArray(deck?.[section]) ? deck[section].map(Number) : []]));
}

function readEntryId(entry) {
  return readId(entry) ?? readId(entry?.id) ?? readId(entry?.cardId) ?? readId(entry?.passcode);
}

function readId(value) {
  const number = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value;
  return typeof number === 'number' && Number.isSafeInteger(number) && number > 0 ? number : null;
}

function readText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
