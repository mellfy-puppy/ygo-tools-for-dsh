import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const DEFAULT_MAX_STEPS = 500;
const MAX_STEPS = 2000;
const MAX_ACTION_CANDIDATES = 100;

export async function parseComboArtifactInput(input = {}) {
  const record = asRecord(input);
  const source = await resolveArtifactSource(record);
  if (!source.ok) return source;
  try {
    const normalized = normalizeComboArtifact(source.value, {
      maxSteps: normalizeLimit(record.maxSteps, DEFAULT_MAX_STEPS, MAX_STEPS),
      sourceKind: source.kind,
      sourcePath: source.path,
    });
    return { ok: true, data: normalized };
  } catch (error) {
    return {
      ok: false,
      code: 'COMBO_ARTIFACT_PARSE_FAILED',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function buildComboAdaptationReport(parsed, currentDeck, cardLookup = {}) {
  const artifact = asRecord(parsed);
  const oldDeck = normalizeDeck(artifact.oldDeck);
  const nextDeck = normalizeDeck(currentDeck);
  if (!nextDeck) {
    return { ok: false, code: 'NO_SESSION_DECK', error: 'A current session deck must be loaded before building combo adaptation context.' };
  }

  const deckComparison = compareDecks(oldDeck, nextDeck, cardLookup);
  const opening = compareOpening(artifact.fixedOpeningCards, nextDeck, cardLookup);
  const referencedCards = resolveReferencedCards(artifact.steps, nextDeck, cardLookup);
  const markdown = buildMarkdown(artifact, deckComparison, opening, referencedCards);
  return {
    ok: true,
    data: {
      source: artifact.source ?? {},
      schemaType: artifact.schemaType ?? 'unknown',
      archiveStatus: artifact.archiveStatus ?? null,
      deckComparison,
      opening,
      referencedCards,
      semanticSteps: Array.isArray(artifact.steps) ? artifact.steps : [],
      unsafeBindings: artifact.unsafeBindings ?? {},
      rules: {
        replayRawResponses: false,
        reuseActionIndices: false,
        requireLatestLegalActions: true,
        requireEngineVerification: true,
      },
      markdown,
    },
  };
}

export function normalizeComboArtifact(value, options = {}) {
  const parsed = parseValue(value);
  if (isWebArchive(parsed)) return normalizeWebArchive(parsed, options);
  return normalizeGenericArtifact(parsed, options);
}

async function resolveArtifactSource(input) {
  if (input.artifact && typeof input.artifact === 'object') {
    return { ok: true, kind: 'inline-object', path: null, value: input.artifact };
  }
  if (input.json && typeof input.json === 'object') {
    return { ok: true, kind: 'inline-object', path: null, value: input.json };
  }
  const content = readString(input.content) ?? readString(input.text);
  if (content) return { ok: true, kind: 'inline-text', path: null, value: content };
  const file = readString(input.file);
  if (file) {
    const path = resolve(file);
    return { ok: true, kind: 'file', path, value: await readFile(path, 'utf8') };
  }
  return {
    ok: false,
    code: 'COMBO_ARTIFACT_REQUIRED',
    error: 'parseComboArtifact requires artifact/json, content/text, or file.',
  };
}

function normalizeWebArchive(archive, options) {
  const request = asRecord(archive.request);
  const current = asRecord(archive.currentOpening);
  const resume = asRecord(current.resumeState);
  const progress = asRecord(archive.progress);
  const bestTopPath = asRecord(firstArray([asRecord(resume.best).topPaths])[0]);
  const completed = asRecord(firstArray([archive.completedOpenings])[0]);
  const completedTopPath = asRecord(firstArray([asRecord(completed.searchResult).topPaths])[0]);
  const chain = firstArray([
    resume.chain,
    bestTopPath.chain,
    completedTopPath.chain,
  ]);
  const steps = normalizeSteps(chain, options.maxSteps);
  const stack = Array.isArray(resume.stack) ? resume.stack : [];
  const latestFrame = asRecord(stack.at(-1));
  const actionCandidates = normalizeActionCandidates(latestFrame.actions);
  const openingCodes = normalizeCardIds(current.openingCodes).length > 0
    ? normalizeCardIds(current.openingCodes)
    : normalizeCardIds(asRecord(current.opening).opening);
  const fixedFromRequest = parseInstanceIds(request.fixedOpeningInstanceIds);
  const fixedOpeningCards = openingCodes.length > 0 ? openingCodes : fixedFromRequest;
  const responseBindings = stack.reduce((count, frame) => count + readArray(asRecord(frame).actions)
    .filter((action) => readString(asRecord(action).responseBase64)).length, 0);

  return {
    normalizedVersion: 1,
    schemaType: 'web-combo-archive',
    source: { kind: options.sourceKind, path: options.sourcePath },
    archiveSchemaVersion: archive.schemaVersion ?? null,
    archiveStatus: readString(archive.status) ?? 'unknown',
    requestSignature: readString(archive.requestSignature),
    oldDeck: normalizeDeck(request.playerDeck),
    opponentDeck: normalizeDeck(request.opponentDeck),
    fixedOpeningCards,
    scoringRules: readArray(request.scoringRules).map(normalizeScoringRule),
    progress: {
      exploredOpenings: toNumber(progress.exploredOpenings),
      totalOpenings: toNumber(progress.totalOpenings),
      totalNodes: toNumber(progress.totalNodes),
      totalTerminals: toNumber(progress.totalTerminals),
      checkpointNodes: toNumber(progress.checkpointNodes),
    },
    steps,
    actionCandidates,
    unsafeBindings: {
      responseBase64Count: responseBindings,
      fixedOpeningInstanceIdCount: readArray(request.fixedOpeningInstanceIds).length,
      actionIndicesPortable: false,
      responseBytesPortable: false,
      instanceIdsPortable: false,
    },
    warnings: [
      ...(archive.status === 'partial' ? ['The source archive is partial and does not prove a completed or optimal route.'] : []),
      'Action indices, instance IDs, and responseBase64 values are bound to the old duel state and must not be replayed into a new deck.',
    ],
  };
}

function normalizeGenericArtifact(value, options) {
  const record = Array.isArray(value) ? { steps: value } : asRecord(value);
  const rawSteps = firstArray([record.steps, record.actions, record.chain, Array.isArray(record.route) ? record.route : null]);
  const text = typeof value === 'string' ? value : readString(record.content) ?? readString(record.text);
  const steps = rawSteps.length > 0 ? normalizeSteps(rawSteps, options.maxSteps) : normalizeTextSteps(text, options.maxSteps);
  const oldDeck = normalizeDeck(record.playerDeck ?? record.deck ?? asRecord(record.request).playerDeck);
  const fixedOpeningCards = normalizeCardIds(
    record.fixedOpeningCards ?? record.openingCodes ?? record.opening ?? asRecord(record.request).fixedOpeningCards,
  );
  const responseBase64Count = steps.filter((step) => step.hasResponseBinding).length;
  return {
    normalizedVersion: 1,
    schemaType: Array.isArray(value) ? 'action-array' : text ? 'text-route' : 'structured-combo',
    source: { kind: options.sourceKind, path: options.sourcePath },
    archiveStatus: readString(record.status),
    oldDeck,
    opponentDeck: normalizeDeck(record.opponentDeck),
    fixedOpeningCards,
    scoringRules: readArray(record.scoringRules).map(normalizeScoringRule),
    progress: {},
    steps,
    actionCandidates: [],
    unsafeBindings: {
      responseBase64Count,
      fixedOpeningInstanceIdCount: readArray(record.fixedOpeningInstanceIds).length,
      actionIndicesPortable: false,
      responseBytesPortable: false,
      instanceIdsPortable: false,
    },
    warnings: responseBase64Count > 0
      ? ['Raw response bindings were detected and must be remapped through current legal actions.']
      : [],
  };
}

function normalizeSteps(value, maxSteps) {
  return readArray(value).slice(0, maxSteps).map((entry, index) => {
    const record = asRecord(entry);
    const label = readString(entry) ?? readString(record.label) ?? readString(record.actionLabel) ??
      readString(record.name) ?? readString(record.text) ?? `Step ${index + 1}`;
    return {
      index,
      label,
      kind: readString(record.kind),
      text: readString(record.text),
      oldActionIndex: Number.isInteger(record.actionIndex) ? record.actionIndex : null,
      hasResponseBinding: Boolean(readString(record.responseBase64)),
      referencedNames: extractNames(label),
    };
  });
}

function normalizeTextSteps(text, maxSteps) {
  if (!text) return [];
  return String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, maxSteps)
    .map((line, index) => {
      const label = line.replace(/^[-*+]\s+/, '').replace(/^\d+[.)、]\s*/, '').trim();
      return { index, label, kind: null, text: null, oldActionIndex: null, hasResponseBinding: false, referencedNames: extractNames(label) };
    });
}

function normalizeActionCandidates(value) {
  return readArray(value).slice(0, MAX_ACTION_CANDIDATES).map((entry, index) => {
    const record = asRecord(entry);
    return {
      oldIndex: index,
      label: readString(record.label) ?? `Candidate ${index}`,
      kind: readString(record.kind),
      text: readString(record.text),
      hasResponseBinding: Boolean(readString(record.responseBase64)),
    };
  });
}

function compareDecks(oldDeck, currentDeck, lookup) {
  if (!oldDeck) return { available: false, oldDeck: null, currentDeck: summarizeDeck(currentDeck), shared: [], oldOnly: [], newOnly: [] };
  const oldCounts = countCards(oldDeck);
  const currentCounts = countCards(currentDeck);
  const ids = new Set([...oldCounts.keys(), ...currentCounts.keys()]);
  const rows = [...ids].map((id) => ({
    id,
    name: lookupName(lookup, id),
    oldCount: oldCounts.get(id) ?? 0,
    currentCount: currentCounts.get(id) ?? 0,
  }));
  return {
    available: true,
    oldDeck: summarizeDeck(oldDeck),
    currentDeck: summarizeDeck(currentDeck),
    shared: rows.filter((row) => row.oldCount > 0 && row.currentCount > 0),
    oldOnly: rows.filter((row) => row.oldCount > 0 && row.currentCount === 0),
    newOnly: rows.filter((row) => row.oldCount === 0 && row.currentCount > 0),
  };
}

function compareOpening(value, deckValue, lookup) {
  const cards = normalizeCardIds(value);
  const counts = countCards({ main: deckValue.main, extra: [], side: [] });
  const requested = countCards({ main: cards, extra: [], side: [] });
  const entries = [...requested].map(([id, count]) => ({
    id,
    name: lookupName(lookup, id),
    requested: count,
    available: counts.get(id) ?? 0,
    sufficient: (counts.get(id) ?? 0) >= count,
  }));
  return { cards, entries, availableInCurrentMainDeck: entries.every((entry) => entry.sufficient) };
}

function resolveReferencedCards(stepsValue, currentDeck, lookup) {
  const deckIds = new Set([...currentDeck.main, ...currentDeck.extra, ...currentDeck.side]);
  const names = [...new Set(readArray(stepsValue).flatMap((step) => readArray(asRecord(step).referencedNames)))];
  return names.map((name) => {
    const card = typeof lookup.byName === 'function' ? lookup.byName(name) : null;
    const id = Number(card?.id);
    return {
      name: readString(card?.name) ?? name,
      id: Number.isSafeInteger(id) && id > 0 ? id : null,
      inCurrentDeck: Number.isSafeInteger(id) && deckIds.has(id),
      resolved: Boolean(card),
    };
  });
}

function buildMarkdown(artifact, comparison, opening, referencedCards) {
  const lines = [
    '# Combo Adaptation Context',
    '',
    `- Source type: ${artifact.schemaType ?? 'unknown'}`,
    `- Source status: ${artifact.archiveStatus ?? 'not provided'}`,
    `- Semantic steps extracted: ${readArray(artifact.steps).length}`,
    `- Old deck available: ${comparison.available ? 'yes' : 'no'}`,
    `- Shared cards: ${comparison.shared.length}`,
    `- Old-only cards: ${comparison.oldOnly.length}`,
    `- New-only cards: ${comparison.newOnly.length}`,
    `- Fixed opening available in current main deck: ${opening.availableInCurrentMainDeck ? 'yes' : 'no'}`,
    '',
    '## Non-portable bindings',
    '',
    '- Do not replay old action indices, card instance IDs, candidate positions, or responseBase64 bytes.',
    '- Match each semantic step against the latest listActions result from the new live runner.',
    '- Treat partial archives and unexecuted text routes as reference evidence, not completed or optimal routes.',
  ];
  if (comparison.oldOnly.length > 0) {
    lines.push('', '## Old-only cards', '', ...comparison.oldOnly.slice(0, 100).map((card) => `- ${card.name} (${card.id}) x${card.oldCount}`));
  }
  const missingRefs = referencedCards.filter((card) => card.resolved && !card.inCurrentDeck);
  if (missingRefs.length > 0) {
    lines.push('', '## Referenced cards absent from current deck', '', ...missingRefs.map((card) => `- ${card.name} (${card.id})`));
  }
  lines.push('', '## Semantic route', '');
  lines.push(...readArray(artifact.steps).map((step) => `${Number(asRecord(step).index) + 1}. ${readString(asRecord(step).label) ?? 'Unknown step'}`));
  return lines.join('\n');
}

function parseValue(value) {
  if (typeof value !== 'string') return value;
  const text = value.replace(/^\uFEFF/, '').trim();
  if (!text) throw new Error('Combo artifact content is empty.');
  if (!/^[\[{]/.test(text)) return text;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Combo artifact JSON is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isWebArchive(value) {
  const record = asRecord(value);
  return Boolean(record.requestSignature || record.currentOpening || record.completedOpenings) && Boolean(record.request);
}

function normalizeDeck(value) {
  const record = asRecord(value);
  if (!Array.isArray(record.main)) return null;
  return { main: normalizeCardIds(record.main), extra: normalizeCardIds(record.extra), side: normalizeCardIds(record.side) };
}

function summarizeDeck(deck) {
  return deck ? { main: deck.main.length, extra: deck.extra.length, side: deck.side.length } : null;
}

function countCards(deck) {
  const counts = new Map();
  if (!deck) return counts;
  for (const id of [...deck.main, ...deck.extra, ...deck.side]) counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
}

function normalizeScoringRule(value) {
  const record = asRecord(value);
  return {
    name: readString(record.name),
    targetCode: readPositiveInteger(record.targetCode),
    targetLocation: readString(record.targetLocation),
    score: toNumber(record.score),
    priority: toNumber(record.priority),
  };
}

function parseInstanceIds(value) {
  return readArray(value).map((entry) => /^\w+:(\d+):\d+$/.exec(String(entry))?.[1]).map(Number)
    .filter((entry) => Number.isSafeInteger(entry) && entry > 0);
}

function extractNames(text) {
  const names = [];
  for (const pattern of [/\[([^\]]{1,80})\]/g, /[「《“"]([^」》”"]{1,80})[」》”"]/g]) {
    for (const match of String(text).matchAll(pattern)) names.push(match[1].trim());
  }
  return [...new Set(names.filter(Boolean))];
}

function lookupName(lookup, id) {
  const card = typeof lookup.byId === 'function' ? lookup.byId(id) : null;
  return readString(card?.name) ?? `Card ${id}`;
}

function firstArray(values) {
  for (const value of values) if (Array.isArray(value) && value.length > 0) return value;
  return [];
}

function normalizeCardIds(value) {
  return readArray(value).map(Number).filter((entry) => Number.isSafeInteger(entry) && entry > 0);
}

function normalizeLimit(value, fallback, maximum) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) && number > 0 ? Math.min(number, maximum) : fallback;
}

function readPositiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function readArray(value) {
  return Array.isArray(value) ? value : [];
}

function readString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
