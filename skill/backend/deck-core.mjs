const DECK_SECTIONS = Object.freeze(['main', 'extra', 'side']);

export function parseYdkText(text) {
  let section = 'main';
  const deck = { main: [], extra: [], side: [] };

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line === '#main') {
      section = 'main';
      continue;
    }
    if (line === '#extra') {
      section = 'extra';
      continue;
    }
    if (line === '!side') {
      section = 'side';
      continue;
    }
    if (line.startsWith('#')) continue;
    if (/^\d+$/.test(line)) deck[section].push(Number(line));
  }

  return deck;
}

export function serializeYdkText(deck) {
  const normalized = normalizeDeck(deck);
  return [
    '#created by YGOagentskill',
    '#main',
    ...normalized.main.map(String),
    '#extra',
    ...normalized.extra.map(String),
    '!side',
    ...normalized.side.map(String),
    '',
  ].join('\n');
}

export function parseDeckInput(input, cardsDb) {
  const body = asRecord(input);
  const candidate = body.deck ?? body.deckList ?? body.ydk ?? body.deckText ?? input;

  if (typeof candidate === 'string') {
    const deck = parseYdkText(candidate);
    if (deck.main.length === 0 && deck.extra.length === 0 && deck.side.length === 0) {
      return { ok: false, error: 'Deck text does not contain any card IDs.' };
    }
    return { ok: true, deck, unknownCards: [] };
  }

  if (Array.isArray(candidate)) {
    return parseDeckObject({ main: candidate }, cardsDb);
  }

  const record = asRecord(candidate);
  if (typeof record.ydk === 'string' || typeof record.deckText === 'string') {
    return parseDeckInput(record.ydk ?? record.deckText, cardsDb);
  }

  if ('main' in record || 'extra' in record || 'side' in record) {
    return parseDeckObject(record, cardsDb);
  }

  return { ok: false, error: 'Deck input must include deck, deckList, ydk, deckText, or a parsed deck object.' };
}

export function analyzeDeck(deck, cardsDb, inputUnknownCards = []) {
  const normalized = normalizeDeck(deck);
  const entries = resolveDeckEntries(normalized, cardsDb);
  const unknownCards = [
    ...inputUnknownCards,
    ...entries
      .filter((entry) => !entry.card)
      .map((entry) => ({
        section: entry.section,
        index: entry.index,
        input: entry.id,
        error: `Unknown card ID: ${entry.id}`,
      })),
  ];
  const counts = countDeck(normalized);
  const cards = {
    main: entries.filter((entry) => entry.section === 'main').map(formatDeckCard),
    extra: entries.filter((entry) => entry.section === 'extra').map(formatDeckCard),
    side: entries.filter((entry) => entry.section === 'side').map(formatDeckCard),
    all: entries.map(formatDeckCard),
  };
  const cardCounts = buildCardCountSummaries(entries);
  const validation = validateDeck({ counts, duplicates: buildDuplicates(entries), unknownCards });

  return {
    deck: normalized,
    counts,
    validation,
    cards,
    cardNames: {
      main: cards.main.map((card) => card.name),
      extra: cards.extra.map((card) => card.name),
      side: cards.side.map((card) => card.name),
      all: cards.all.map((card) => card.name),
      unique: [...new Set(cards.all.map((card) => card.name))],
    },
    deckCardNames: [...new Set(cards.all.map((card) => card.name))],
    cardCounts,
    idsByName: Object.fromEntries(cardCounts.map((card) => [card.name, card.ids])),
    sampleCards: cards.all.slice(0, 12),
    unknownCards,
    ydk: serializeYdkText(normalized),
  };
}

export function normalizeDeck(value) {
  const record = asRecord(value);
  return {
    main: normalizeCardIds(record.main),
    extra: normalizeCardIds(record.extra),
    side: normalizeCardIds(record.side),
  };
}

export function countDeck(deck) {
  const normalized = normalizeDeck(deck);
  return {
    main: normalized.main.length,
    extra: normalized.extra.length,
    side: normalized.side.length,
    total: normalized.main.length + normalized.extra.length + normalized.side.length,
  };
}

function parseDeckObject(input, cardsDb) {
  const main = normalizeDeckSection(input.main ?? [], 'main', cardsDb);
  const extra = normalizeDeckSection(input.extra ?? [], 'extra', cardsDb);
  const side = normalizeDeckSection(input.side ?? [], 'side', cardsDb);
  if (!main.ok) return { ok: false, error: main.error };
  if (!extra.ok) return { ok: false, error: extra.error };
  if (!side.ok) return { ok: false, error: side.error };
  return {
    ok: true,
    deck: { main: main.codes, extra: extra.codes, side: side.codes },
    unknownCards: [...main.unknownCards, ...extra.unknownCards, ...side.unknownCards],
  };
}

function normalizeDeckSection(value, section, cardsDb) {
  if (!Array.isArray(value)) return { ok: false, error: `deck.${section} must be an array.` };
  const codes = [];
  const unknownCards = [];
  value.forEach((entry, index) => {
    const normalized = normalizeDeckEntry(entry, cardsDb);
    if (normalized.id !== null) {
      codes.push(normalized.id);
      return;
    }
    unknownCards.push({ section, index, input: entry, error: normalized.error });
  });
  return { ok: true, codes, unknownCards };
}

function normalizeDeckEntry(entry, cardsDb) {
  const directId = readCardId(entry);
  if (directId !== null) return { id: directId, error: '' };
  const record = asRecord(entry);
  const objectId = readCardId(record.id) ?? readCardId(record.cardId) ?? readCardId(record.passcode);
  if (objectId !== null) return { id: objectId, error: '' };
  const name = readNonEmptyString(entry) ?? readNonEmptyString(record.name) ?? readNonEmptyString(record.cardName);
  if (name && cardsDb) {
    const card = cardsDb.getByName(name);
    return card ? { id: card.id, error: '' } : { id: null, error: `Unknown card name: ${name}` };
  }
  return { id: null, error: 'Card entry must be a positive card ID or known card name.' };
}

function resolveDeckEntries(deck, cardsDb) {
  const entries = [];
  for (const section of DECK_SECTIONS) {
    deck[section].forEach((id, index) => {
      entries.push({
        section,
        index,
        id,
        card: cardsDb?.getById(id) ?? null,
      });
    });
  }
  return entries;
}

function buildCardCountSummaries(entries) {
  const byId = new Map();
  for (const entry of entries) {
    const existing = byId.get(entry.id) ?? {
      id: entry.id,
      name: entry.card?.name ?? `Unknown ${entry.id}`,
      ids: [entry.id],
      count: 0,
      sections: { main: 0, extra: 0, side: 0 },
      indices: { main: [], extra: [], side: [] },
      type: entry.card?.type ?? 'Unknown',
      typeTags: entry.card?.typeTags ?? [],
    };
    existing.count += 1;
    existing.sections[entry.section] += 1;
    existing.indices[entry.section].push(entry.index);
    byId.set(entry.id, existing);
  }
  return [...byId.values()]
    .sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN') || left.id - right.id);
}

function buildDuplicates(entries) {
  return buildCardCountSummaries(entries)
    .filter((card) => card.count > 1)
    .map((card) => ({ ...card, exceedsLimit: card.count > 3 }));
}

function validateDeck(analysis) {
  const errors = [];
  const warnings = [];
  if (analysis.counts.main < 40) errors.push(`Main deck has ${analysis.counts.main} cards; expected at least 40.`);
  if (analysis.counts.main > 60) errors.push(`Main deck has ${analysis.counts.main} cards; expected at most 60.`);
  if (analysis.counts.extra > 15) errors.push(`Extra deck has ${analysis.counts.extra} cards; expected at most 15.`);
  if (analysis.counts.side > 15) errors.push(`Side deck has ${analysis.counts.side} cards; expected at most 15.`);
  for (const duplicate of analysis.duplicates) {
    if (duplicate.exceedsLimit) {
      errors.push(`${duplicate.name} (${duplicate.id}) appears ${duplicate.count} times; copy limit is 3.`);
    }
  }
  if (analysis.unknownCards.length > 0) {
    errors.push(`${analysis.unknownCards.length} card entries could not be resolved in cards.cdb.`);
  }
  if (analysis.counts.main > 40) warnings.push('Main deck is above 40 cards; consistency may be lower.');
  return {
    legal: errors.length === 0,
    errors,
    warnings,
    limits: {
      main: { min: 40, max: 60 },
      extra: { min: 0, max: 15 },
      side: { min: 0, max: 15 },
      copiesPerCard: 3,
    },
  };
}

function formatDeckCard(entry) {
  return {
    section: entry.section,
    index: entry.index,
    id: entry.id,
    name: entry.card?.name ?? `Unknown ${entry.id}`,
    type: entry.card?.type ?? 'Unknown',
    typeTags: entry.card?.typeTags ?? [],
    level: entry.card?.level ?? 0,
    atk: normalizeStat(entry.card?.atk ?? -1),
    def: normalizeStat(entry.card?.def ?? -1),
  };
}

function normalizeCardIds(value) {
  return Array.isArray(value)
    ? value.map(readCardId).filter((id) => id !== null)
    : [];
}

function normalizeStat(value) {
  return value >= 0 ? value : null;
}

function readCardId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

function readNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
