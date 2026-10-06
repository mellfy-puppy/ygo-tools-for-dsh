import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { normalizeDeck } from './deck-core.mjs';

const MAX_SKILL_BYTES = 180000;
const SKILL_PREFIX = 'deck-learning-';

export async function learnDeckSkill(input = {}, options = {}) {
  try {
    const record = asRecord(input);
    switch (readString(record.action)?.toLowerCase()) {
      case 'learn': return await createAndStoreDeckSkill(record, options);
      case 'list': {
        const deck = normalizeCandidateDeck(record.deck) ?? normalizeCandidateDeck(options.session?.metadata?.currentDeck);
        if (record.matchingOnly === true && !deck) return failure('DECK_LEARNING_DECK_REQUIRED', 'Load or supply a deck before listing matching skills.');
        return await listDeckSkills(options, record.matchingOnly === true ? deck : null);
      }
      case 'get': return await getDeckSkill(record, options);
      case 'delete': return await deleteDeckSkill(record, options);
      case 'activate': return await activateDeckSkill(record, options);
      default: return failure('DECK_LEARNING_ACTION_REQUIRED', 'learnDeck action must be learn, list, get, delete, or activate.');
    }
  } catch (error) { return failure(error.code ?? 'DECK_LEARNING_FAILED', error.message ?? String(error)); }
}

// Order is irrelevant; card multiplicity and the section containing each card are not.
export function deckFingerprint(deck) {
  const normalized = normalizeDeck(deck);
  const canonical = Object.fromEntries(['main', 'extra', 'side'].map((section) => [section, normalized[section].slice().sort((a, b) => a - b)]));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 20);
}

export function renderDeckSkill({ name, description, deckName, fingerprint, source, steps, strategyNotes, generatedAt, replaySummary = {} }) {
  const metadata = {
    name: normalizeSkillName(name ?? `${SKILL_PREFIX}${fingerprint}`),
    description: cleanInline(description ?? `Learned operations for the ${deckName || 'current'} deck.`),
    deckFingerprint: fingerprint, deckName: cleanInline(deckName || 'unnamed deck'),
    sourceReplay: cleanInline(source || 'provided replay'), generatedAt: generatedAt || new Date().toISOString(),
    fingerprintScope: 'main-extra-side',
  };
  const lines = ['---', ...Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`), '---', '',
    '# Learned Deck Operations', '', `This context is bound to deck fingerprint \`${fingerprint}\`.`,
    'Use the observations and model notes as planning references. Check every operation against the current legal actions.',
    'Never reuse replay action indexes, response bytes, instance IDs or hidden opponent information.', '',
    `Recorded visible operations included here: ${steps.length}.`];
  if (replaySummary.fullyConsumed === false) lines.push('The parser did not consume all responses; these observations cover only the parsed prefix.');
  if (Number.isInteger(replaySummary.visibleStepCount) && replaySummary.visibleStepCount > steps.length) lines.push(`The parsed replay contains ${replaySummary.visibleStepCount} visible operations; this file contains the first ${steps.length}.`);
  lines.push('', '## Observed Operations', '');
  for (const [index, step] of steps.entries()) lines.push(`${index + 1}. ${step.label}${step.actor ? ` [${step.actor}]` : ''}`);
  if (readString(strategyNotes)) lines.push('', '## Model Strategy Notes', '', 'These are model-authored interpretations, not engine-verified conclusions.', '', strategyNotes.trim());
  lines.push('', '## Use Rules', '', '- Treat this route as observed evidence, not a guaranteed or optimal line.',
    '- Re-read the latest `observeDuel` actions before each operation.',
    '- Prefer semantic card names and effect purposes over stale positions or indexes.',
    '- If the current deck differs from this fingerprint, do not apply this context.', '');
  const content = lines.join('\n');
  if (Buffer.byteLength(content, 'utf8') > MAX_SKILL_BYTES) throw codedError('DECK_SKILL_TOO_LARGE', `Deck skills must be at most ${MAX_SKILL_BYTES} bytes.`);
  return content;
}

export function extractLearnedSteps(route, maxSteps = 160) {
  const record = asRecord(route);
  const candidates = [record.visibleSteps, record.steps, record.semanticSteps, asRecord(record.context).visibleSteps, record.rawEvents];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    const steps = candidate.flatMap((entry) => {
      const item = asRecord(entry);
      if (item.visibility === 'hidden') return [];
      const nested = asRecord(item.action ?? item.operation ?? item.event);
      const label = cleanInline(readString(entry) ?? readString(item.label) ?? readString(item.actionLabel)
        ?? readString(item.description) ?? readString(item.text) ?? readString(nested.label) ?? readString(nested.name) ?? '');
      if (!label) return [];
      const rawActor = item.actor ?? item.player ?? item.controller;
      const actor = cleanInline(typeof rawActor === 'number' ? `player ${rawActor}` : readString(rawActor) ?? '');
      return [{ label, ...(actor ? { actor } : {}) }];
    });
    if (steps.length) return steps.slice(0, normalizeLimit(maxSteps)).map((step, index) => ({ index, ...step }));
  }
  return [];
}

export function extractReplayDeck(route) {
  const record = asRecord(route);
  return [asRecord(record.deck).player, asRecord(record.deck).host, record.playerDeck, asRecord(record.deck).playerDeck,
    record.hostDeck, asRecord(record.replay).hostDeck, record.deck].map(normalizeCandidateDeck).find(Boolean) ?? null;
}

export function parseDeckSkillFrontmatter(content) {
  const text = String(content);
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  const metadata = {};
  if (match) for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z][A-Za-z0-9]*):\s*(.*?)\s*$/.exec(line);
    if (!pair) continue;
    let value = pair[2];
    if (value.startsWith('"')) { try { value = JSON.parse(value); } catch { continue; } }
    else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1).replace(/''/g, "'");
    if (typeof value === 'string') metadata[pair[1]] = value;
  }
  return { metadata, content: text };
}

export async function listMatchingDeckSkills(deck, options = {}) { return listDeckSkills(options, deck); }

export async function loadMatchingDeckSkills(deck, options = {}) {
  const listed = await listDeckSkills(options, deck);
  const skills = [];
  for (const summary of listed.data.skills) {
    const loaded = await getDeckSkill({ skillName: summary.name }, options);
    if (loaded.ok && loaded.data.deckFingerprint === listed.data.fingerprint) skills.push(loaded.data);
  }
  return { ok: true, data: { ...listed.data, skills } };
}

export async function refreshActiveDeckSkills(options = {}) {
  const session = options.session;
  const deck = normalizeCandidateDeck(session?.metadata?.currentDeck);
  const result = deck ? await loadMatchingDeckSkills(deck, options) : null;
  const deckSkills = { deckFingerprint: deck ? deckFingerprint(deck) : null, skills: result?.data.skills ?? [] };
  session?.mergeMetadata?.({ deckSkills, activeDeckSkills: deckSkills.skills, activeDeckSkillsUpdatedAt: new Date().toISOString() });
  return deckSkills;
}

async function createAndStoreDeckSkill(input, options) {
  const route = asRecord(input.route);
  if (!Object.keys(route).length) return failure('DECK_LEARNING_REPLAY_REQUIRED', 'Learning requires parsed replay route data.');
  const replayDeck = extractReplayDeck(route);
  const explicitDeck = normalizeCandidateDeck(input.deck);
  if (input.deck !== undefined && !explicitDeck) return failure('DECK_LEARNING_INVALID_DECK', 'The supplied deck must contain positive integer card IDs and a nonempty main deck.');
  const sessionDeck = normalizeCandidateDeck(options.session?.metadata?.currentDeck);
  const sideUnavailable = asRecord(asRecord(route.deck).player).sideDeckRecorded === false;
  const samePlayedDeck = (candidate) => candidate && replayDeck && deckFingerprint({ ...candidate, side: [] }) === deckFingerprint({ ...replayDeck, side: [] });
  // YRP stores main and extra only. Bind to supplied/session side cards only when
  // all recorded cards match; keep side multiplicity in the resulting fingerprint.
  const deck = explicitDeck ?? (sideUnavailable && samePlayedDeck(sessionDeck) ? sessionDeck : replayDeck) ?? sessionDeck;
  if (!deck) return failure('DECK_LEARNING_DECK_REQUIRED', 'Learning requires a replay deck, an explicit deck or a loaded session deck.');
  const fingerprint = deckFingerprint(deck);
  if (replayDeck && (sideUnavailable ? !samePlayedDeck(deck) : deckFingerprint(replayDeck) !== fingerprint)) return failure('DECK_SKILL_DECK_MISMATCH', 'The supplied deck differs from the replay player deck.');
  const steps = extractLearnedSteps(route, input.maxSteps);
  if (!steps.length) return failure('DECK_LEARNING_NO_SEMANTIC_STEPS', 'The replay contains no visible semantic operations to learn.');
  if (input.strategyNotes !== undefined && (typeof input.strategyNotes !== 'string' || input.strategyNotes.length > 30000)) return failure('DECK_LEARNING_INVALID_NOTES', 'strategyNotes must be a string of at most 30000 characters.');
  const source = readString(input.source) ?? readString(asRecord(route.source).fileName) ?? readString(route.fileName) ?? 'provided replay';
  const deckName = readString(input.deckName) ?? 'learned deck';
  const name = input.skillName === undefined ? `${SKILL_PREFIX}${slugify(deckName)}-${fingerprint}` : normalizeSkillName(input.skillName);
  await mkdir(skillDirectory(options), { recursive: true });
  const path = skillPath(options, name);
  const existing = await readOptional(path);
  if (existing !== null && input.overwrite !== true) return failure('DECK_SKILL_EXISTS', `Deck skill ${name} already exists. Set overwrite:true to replace it.`, { name, path });
  if (existing !== null && (parseDeckSkillFrontmatter(existing).metadata.deckFingerprint !== fingerprint || parseDeckSkillFrontmatter(existing).metadata.name !== name)) return failure('DECK_SKILL_DECK_MISMATCH', 'An existing skill for another deck or name cannot be overwritten. Choose a different skillName.');
  const content = renderDeckSkill({ name, description: input.description, deckName, fingerprint, source, steps,
    strategyNotes: input.strategyNotes, replaySummary: asRecord(route.summary) });
  if (existing === null) {
    try { await writeFile(path, content, { encoding: 'utf8', flag: 'wx' }); }
    catch (error) { if (error.code === 'EEXIST') return failure('DECK_SKILL_EXISTS', `Deck skill ${name} was created by another writer.`); throw error; }
  } else {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
      if (await readOptional(path) !== existing) return failure('DECK_SKILL_CHANGED', 'The skill changed during this write. Read it again before overwriting.');
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  }
  const deckSkills = await refreshActiveDeckSkills(options);
  return { ok: true, data: { action: 'learn', name, path, deckName, deckFingerprint: fingerprint,
    stepCount: steps.length, source, replaced: existing !== null, hasStrategyNotes: Boolean(readString(input.strategyNotes)),
    sideDeckBinding: sideUnavailable ? (deck === replayDeck ? 'not-recorded-empty-side' : 'supplied-matching-deck') : 'recorded',
    skill: { ...parseDeckSkillFrontmatter(content).metadata, path, content }, context: { deckSkills } } };
}

async function listDeckSkills(options, deck = null) {
  const directory = skillDirectory(options);
  const fingerprint = deck ? deckFingerprint(deck) : null;
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return { ok: true, data: { directory, fingerprint, skills: [] } }; throw error; }
  const skills = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(SKILL_PREFIX) || !entry.name.endsWith('.md')) continue;
    const name = entry.name.slice(0, -3);
    if (!/^deck-learning-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) continue;
    let loaded;
    try { loaded = await getDeckSkill({ skillName: name }, options); } catch { continue; }
    if (!loaded.ok || (fingerprint && loaded.data.deckFingerprint !== fingerprint)) continue;
    const { content, ...summary } = loaded.data;
    skills.push(summary);
  }
  return { ok: true, data: { directory, fingerprint, skills: skills.sort((a, b) => a.name.localeCompare(b.name)) } };
}

async function getDeckSkill(input, options) {
  const name = normalizeSkillName(input.skillName);
  const path = skillPath(options, name);
  const content = await readOptional(path);
  if (content === null) return failure('DECK_SKILL_NOT_FOUND', `Deck skill ${name} was not found.`);
  const parsed = parseDeckSkillFrontmatter(content);
  if (parsed.metadata.name !== name || !/^[a-f0-9]{20}$/.test(parsed.metadata.deckFingerprint ?? '')) return failure('DECK_SKILL_INVALID_METADATA', `Deck skill ${name} has invalid name or deckFingerprint metadata.`);
  return { ok: true, data: { ...parsed.metadata, name, path, content } };
}

async function deleteDeckSkill(input, options) {
  if (input.confirm !== true) return failure('EXPLICIT_CONFIRMATION_REQUIRED', 'Deleting a deck skill requires confirm:true.');
  const loaded = await getDeckSkill(input, options);
  if (!loaded.ok) return loaded;
  await rm(loaded.data.path);
  const deckSkills = await refreshActiveDeckSkills(options);
  return { ok: true, data: { action: 'delete', name: loaded.data.name, path: loaded.data.path, context: { deckSkills } } };
}

async function activateDeckSkill(input, options) {
  const deck = normalizeCandidateDeck(options.session?.metadata?.currentDeck);
  if (!deck) return failure('DECK_LEARNING_DECK_REQUIRED', 'Load the matching deck into this session before activating a skill.');
  const loaded = await getDeckSkill(input, options);
  if (!loaded.ok) return loaded;
  const fingerprint = deckFingerprint(deck);
  if (loaded.data.deckFingerprint !== fingerprint || (input.deck && deckFingerprint(input.deck) !== fingerprint)) return failure('DECK_SKILL_DECK_MISMATCH', `Deck skill ${loaded.data.name} does not match the loaded session deck.`);
  const deckSkills = await refreshActiveDeckSkills(options);
  return { ok: true, data: { action: 'activate', deckFingerprint: fingerprint, skills: deckSkills.skills, context: { deckSkills } } };
}

function skillDirectory(options) { return resolve(String(options.deckSkillDir ?? resolve(options.skillRoot ?? process.cwd(), 'output', 'deck-skills'))); }
function skillPath(options, name) { return resolve(skillDirectory(options), `${normalizeSkillName(name)}.md`); }
function normalizeSkillName(value) {
  if (typeof value !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) || value.length > 120) throw codedError('DECK_SKILL_INVALID_NAME', 'skillName must be a nonempty lowercase name using letters, digits and single hyphens (at most 120 characters).');
  const name = value.startsWith(SKILL_PREFIX) ? value : `${SKILL_PREFIX}${value}`;
  if (name.length > 120) throw codedError('DECK_SKILL_INVALID_NAME', 'skillName including the deck-learning prefix must be at most 120 characters.');
  return name;
}
function slugify(value) { return String(value).normalize('NFKD').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 64).replace(/-$/, '') || 'unnamed'; }
function normalizeCandidateDeck(value) {
  const record = asRecord(value);
  if (!Array.isArray(record.main) || !record.main.length) return null;
  for (const section of ['main', 'extra', 'side']) {
    if (record[section] === undefined && section !== 'main') continue;
    if (!Array.isArray(record[section]) || !record[section].every((id) => Number.isSafeInteger(id) && id > 0 && id <= 0xffffffff)) return null;
  }
  return normalizeDeck(record);
}
async function readOptional(path) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw codedError('DECK_SKILL_UNSAFE_FILE', 'Deck skills must be regular files without symbolic or hard links.');
    if (stat.size > MAX_SKILL_BYTES) throw codedError('DECK_SKILL_TOO_LARGE', `Deck skills must be at most ${MAX_SKILL_BYTES} bytes.`);
    return await readFile(path, 'utf8');
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function codedError(code, message) { return Object.assign(new Error(message), { code }); }
function failure(code, error, data) { return { ok: false, code, error, ...(data ? { data } : {}) }; }
function normalizeLimit(value) { const number = Number(value); return Number.isInteger(number) && number > 0 ? Math.min(number, 500) : 160; }
function cleanInline(value) { return String(value ?? '').replace(/[\r\n\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500); }
function asRecord(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function readString(value) { return typeof value === 'string' && value.trim() ? value.trim() : null; }
