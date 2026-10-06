import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm, readdir, link } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deckFingerprint, extractLearnedSteps, extractReplayDeck, learnDeckSkill, loadMatchingDeckSkills, refreshActiveDeckSkills, parseDeckSkillFrontmatter } from '../skill/backend/deck-learning.mjs';
import { createPortableSession } from '../skill/backend/session.mjs';

const deck = { main: [68353324, 88686573, 68353324], extra: [72329844], side: [] };
const route = { deck: { player: deck }, visibleSteps: [{ label: '通常召唤[素早河狸]', player: 0 }, { label: '发动河狸的特殊召唤效果' }], summary: { visibleStepCount: 2, fullyConsumed: true } };
async function setup(t, currentDeck = deck) {
  const directory = await mkdtemp(join(tmpdir(), 'ygo-deck-learning-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { deckSkillDir: directory, session: createPortableSession({ metadata: currentDeck ? { currentDeck } : {} }) };
}
const learn = (options, input = {}) => learnDeckSkill({ action: 'learn', route, skillName: 'nimble', ...input }, options);

test('fingerprints ignore order, retain duplicates, card sections and side deck', () => {
  assert.equal(deckFingerprint(deck), deckFingerprint({ ...deck, main: [...deck.main].reverse() }));
  assert.notEqual(deckFingerprint(deck), deckFingerprint({ ...deck, main: [68353324, 88686573] }));
  assert.notEqual(deckFingerprint(deck), deckFingerprint({ ...deck, side: [68353324] }));
  assert.notEqual(deckFingerprint(deck), deckFingerprint({ main: deck.extra, extra: deck.main }));
});

test('extracts real labels, skips hidden/unlabelled events and does not invent steps', () => {
  assert.equal(extractLearnedSteps(route)[0].actor, 'player 0');
  assert.deepEqual(extractLearnedSteps({ visibleSteps: [{ responseHex: '00' }] }), []);
  assert.equal(extractLearnedSteps({ visibleSteps: [], rawEvents: [{ visibility: 'hidden', label: 'hidden' }, { visibility: 'visible', label: 'summon' }] })[0].label, 'summon');
  assert.equal(extractLearnedSteps(route, 1).length, 1);
  assert.deepEqual(extractReplayDeck(route), deck);
  assert.equal(extractReplayDeck({ deck: { player: { counts: { main: 40 }, opening: [{ code: 1 }] } } }), null);
});

test('learn persists readable, editable content and separate model notes; matching context activates', async (t) => {
  const options = await setup(t);
  const result = await learn(options, { deckName: '河狸: test #1', description: 'Operations: "quoted" # safe', strategyNotes: '先检查墓地，再考虑延伸。\n不要假定对手没有打断。' });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.data.stepCount, 2);
  assert.equal(result.data.context.deckSkills.skills.length, 1);
  const content = await readFile(result.data.path, 'utf8');
  assert.match(content, /Model Strategy Notes/);
  assert.match(content, /engine-verified conclusions/);
  assert.match(content, /素早河狸/);
  assert.doesNotMatch(content, /Observed operation|responseHex|unknown/);
  assert.equal(parseDeckSkillFrontmatter(content).metadata.description, 'Operations: "quoted" # safe');
  await writeFile(result.data.path, `${content}\nManual correction.\n`);
  assert.match((await refreshActiveDeckSkills(options)).skills[0].content, /Manual correction/);
});

test('empty/unlabelled route and malformed decks are rejected without creating artifacts', async (t) => {
  const options = await setup(t);
  assert.equal((await learn(options, { route: { deck: { player: deck }, visibleSteps: [{}] } })).code, 'DECK_LEARNING_NO_SEMANTIC_STEPS');
  assert.equal((await learn(options, { route: {} })).code, 'DECK_LEARNING_REPLAY_REQUIRED');
  assert.equal((await learn(options, { deck: { main: [1, '2'] } })).code, 'DECK_LEARNING_INVALID_DECK');
  assert.deepEqual(await readdir(options.deckSkillDir), []);
});

test('existing skills require overwrite and cannot be rebound to a different deck', async (t) => {
  const options = await setup(t);
  const original = await learn(options);
  assert.equal((await learn(options)).code, 'DECK_SKILL_EXISTS');
  const changedDeck = { main: [1], extra: [], side: [] };
  assert.equal((await learn(options, { overwrite: true, route: { ...route, deck: { player: changedDeck } } })).code, 'DECK_SKILL_DECK_MISMATCH');
  assert.equal(await readFile(original.data.path, 'utf8'), original.data.skill.content);
  const overwritten = await learn(options, { overwrite: true, strategyNotes: 'revised' });
  assert.equal(overwritten.ok, true, overwritten.error);
  assert.equal(overwritten.data.replaced, true);
  assert.match(await readFile(original.data.path, 'utf8'), /revised/);
  assert.equal((await readdir(options.deckSkillDir)).length, 1);
});

test('traversal, missing names, links and oversized files are rejected', async (t) => {
  const options = await setup(t);
  for (const skillName of ['../outside', 'x/y', 'x\\y', 'x.md', '', 'X', 'foo:bar']) assert.equal((await learn(options, { skillName })).code, 'DECK_SKILL_INVALID_NAME');
  assert.equal((await learnDeckSkill({ action: 'get' }, options)).code, 'DECK_SKILL_INVALID_NAME');
  const source = join(options.deckSkillDir, 'outside.txt');
  await writeFile(source, 'do not overwrite');
  await link(source, join(options.deckSkillDir, 'deck-learning-linked.md'));
  assert.equal((await learn(options, { skillName: 'linked', overwrite: true })).code, 'DECK_SKILL_UNSAFE_FILE');
  assert.equal(await readFile(source, 'utf8'), 'do not overwrite');
  await writeFile(join(options.deckSkillDir, 'deck-learning-large.md'), 'x'.repeat(180001));
  assert.equal((await learnDeckSkill({ action: 'get', skillName: 'large' }, options)).code, 'DECK_SKILL_TOO_LARGE');
  assert.deepEqual((await learnDeckSkill({ action: 'list' }, options)).data.skills, []);
});

test('matching-only lists and activation use the actual loaded session deck', async (t) => {
  const options = await setup(t);
  await learn(options);
  assert.equal((await learnDeckSkill({ action: 'list', matchingOnly: true }, options)).data.skills.length, 1);
  const other = { main: [42], extra: [], side: [] };
  options.session.mergeMetadata({ currentDeck: other });
  assert.deepEqual((await refreshActiveDeckSkills(options)).skills, []);
  assert.deepEqual((await loadMatchingDeckSkills(other, options)).data.skills, []);
  assert.equal((await learnDeckSkill({ action: 'activate', skillName: 'nimble', deck }, options)).code, 'DECK_SKILL_DECK_MISMATCH');
  assert.equal((await learnDeckSkill({ action: 'list', matchingOnly: true }, options)).data.skills.length, 0);
  const isolated = createPortableSession({ metadata: { currentDeck: deck } });
  assert.equal((await refreshActiveDeckSkills({ ...options, session: isolated })).skills.length, 1);
  assert.deepEqual(options.session.metadata.activeDeckSkills, []);
});

test('learn follows replay deck instead of unrelated loaded deck and does not activate it', async (t) => {
  const options = await setup(t, { main: [42], extra: [], side: [] });
  const result = await learn(options);
  assert.equal(result.data.deckFingerprint, deckFingerprint(deck));
  assert.deepEqual(result.data.context.deckSkills.skills, []);
  assert.equal((await learn(options, { deck: { main: [42] }, skillName: 'other' })).code, 'DECK_SKILL_DECK_MISMATCH');
});

test('YRP missing side deck may bind matching loaded deck, preserving its side quantities', async (t) => {
  const withSide = { ...deck, side: [42, 42] };
  const options = await setup(t, withSide);
  const result = await learn(options, { route: { ...route, deck: { player: { ...deck, sideDeckRecorded: false } } } });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.data.deckFingerprint, deckFingerprint(withSide));
  assert.equal(result.data.context.deckSkills.skills.length, 1);
});

test('delete confirmation protects file and deletion clears active context', async (t) => {
  const options = await setup(t);
  await learn(options);
  assert.equal((await learnDeckSkill({ action: 'delete', skillName: 'nimble' }, options)).code, 'EXPLICIT_CONFIRMATION_REQUIRED');
  const result = await learnDeckSkill({ action: 'delete', skillName: 'nimble', confirm: true }, options);
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.context.deckSkills.skills, []);
  assert.equal((await learnDeckSkill({ action: 'get', skillName: 'nimble' }, options)).code, 'DECK_SKILL_NOT_FOUND');
});

test('simultaneous first writes cannot silently overwrite a skill', async (t) => {
  const options = await setup(t);
  const results = await Promise.all([learn(options, { strategyNotes: 'A' }), learn(options, { strategyNotes: 'B' })]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(results.find((r) => !r.ok).code, 'DECK_SKILL_EXISTS');
});

test('get returns edits; invalid manual metadata cannot contaminate activation', async (t) => {
  const options = await setup(t);
  const result = await learn(options);
  await writeFile(result.data.path, result.data.skill.content.replace('name: "deck-learning-nimble"', 'name: "deck-learning-other"'));
  assert.equal((await learnDeckSkill({ action: 'get', skillName: 'nimble' }, options)).code, 'DECK_SKILL_INVALID_METADATA');
  assert.deepEqual((await refreshActiveDeckSkills(options)).skills, []);
  assert.equal((await learn(options, { overwrite: true })).code, 'DECK_SKILL_DECK_MISMATCH');
});

test('no loaded deck cannot be activated by supplying a different deck argument', async (t) => {
  const options = await setup(t, null);
  await learn(options);
  assert.equal((await learnDeckSkill({ action: 'activate', skillName: 'nimble', deck }, options)).code, 'DECK_LEARNING_DECK_REQUIRED');
  assert.equal((await learnDeckSkill({ action: 'list', matchingOnly: true }, options)).code, 'DECK_LEARNING_DECK_REQUIRED');
});
