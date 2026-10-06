import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModelToolHost } from '../skill/backend/model-tool-host.mjs';
import { PUBLIC_TOOL_NAMES, validatePublicToolInput } from '../skill/backend/tool-schemas.mjs';
import { deckFingerprint } from '../skill/backend/deck-learning.mjs';

// Real 2026-08-25 YRP2 replay: player names anonymized, original cards/responses retained.
const REAL_YRP_BASE64 = 'eXJwMmITAAARAAAAAAAAADsCAABSfI1qXQAAIAAAAACsAfQwQ10Im89lw75VdXqCp3aBmbETc4iv5Q8ycsp1gQEAAAAAAAAAAAAAAAAAAAAAIwAJicA4mTb6JYRTipcmZFTfMNmTqvVpe5rkN0tj0Zq1aaWUkb7h5OV4CtRuonvYY8VpNsEK6hZUGXX+ZNhIvaxRUxR/VbSWLmFsZAybrmC3CQllLmZ9EkxAnE3LuSNG1vGAEvYNbbBz0NNFCJ0wPKvxe+9X8Y27vdnK+5qW4XfOMTIYlJAJYP1x6BYoN0uu/stWe7ohr1WN4aZB2ePZWeO3tTvzxyksyQb4857ZfQuXRUI+P0wxpyMU6kcHP9za73PZY5AdIJ4ZEG2OZ9UU2QzTvqWU6/D8f+F/Ay+mIVmyNs5eef8FL4IKBgv23zZjNK/hVjOo/qLYkoeARBpetRqvrv/F1048LkI6dv1cVMXQV629t1AVakYh4JxGyadpELoCMw13rdK2zJkKJdeTMrwpzmRHnbeikOtD5yIuHxKvSLLTd/vacU5WmWGsT6XJ/GRXkrEGb1th6BZn4JgV9qd+RciDD8QZqkng0RIgDsmaFTeXcem4hPljXvL7IPb5nYjeHWbuA2Zthdr1wF4JdwKLnSkP8AZKLP/an5dr';

test('15th tool supports replay learning, actual deck loading, notes, reuse and session isolation', { timeout: 30000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ygo-learn-replay-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const host = createModelToolHost({ deckSkillDir: join(directory, 'skills') });
  t.after(() => { for (const id of host.listSessions()) host.deleteSession(id); });
  const call = async (name, input, sessionId = 'one') => {
    const result = await host.execute({ name, input }, { sessionId });
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.result.data;
  };
  assert.equal(PUBLIC_TOOL_NAMES.length, 15);
  assert.ok(PUBLIC_TOOL_NAMES.includes('learnDeck'));
  assert.equal(validatePublicToolInput('learnDeck', { action: 'learn', strategyNotes: 'notes' }).ok, true);
  const before = await host.execute({ name: 'learnDeck', input: { action: 'learn' } });
  assert.equal(before.result.code, 'DECK_LEARNING_REPLAY_REQUIRED');
  const parsed = await call('analyzeReplay', { action: 'parse', yrpBase64: REAL_YRP_BASE64, fileName: 'fixture.yrp' });
  assert.equal(parsed.summary.fullyConsumed, true);
  assert.equal(parsed.summary.consumedResponseCount, 16);
  assert.equal(parsed.visibleSteps.length, 10);
  assert.equal(parsed.deck.player.main.length, 40);
  assert.equal(parsed.deck.player.extra.length, 15);
  assert.equal(parsed.deck.player.sideDeckRecorded, false);
  assert.equal(parsed.deck.opponent.main, undefined);
  assert.match(parsed.visibleSteps[0].label, /试胆竞速/);
  const learned = await call('learnDeck', { action: 'learn', skillName: 'real-replay', strategyNotes: '先核对试胆竞速的生命值条件。' });
  assert.equal(learned.stepCount, 10);
  assert.equal(learned.source, 'fixture.yrp');
  assert.equal(learned.context.deckSkills.skills.length, 0);
  const deck = { main: [...parsed.deck.player.main].reverse(), extra: parsed.deck.player.extra, side: [] };
  const loaded = await call('manageSessionDeck', { action: 'set', deck });
  assert.equal(loaded.context.deckSkills.deckFingerprint, deckFingerprint(deck));
  assert.equal(loaded.context.deckSkills.skills.length, 1);
  assert.match(loaded.context.deckSkills.skills[0].content, /先核对试胆竞速/);
  assert.equal((await call('manageSessionDeck', { action: 'get' })).context.deckSkills.skills.length, 1);
  assert.equal((await call('learnDeck', { action: 'activate', skillName: 'real-replay' })).context.deckSkills.skills.length, 1);
  host.getSession('one').runner = {
    currentDecision: { actions: [{ label: 'test legal operation', kind: 'other' }], terminal: false },
    captureSnapshot: () => ({ player: {}, opponent: {} }),
  };
  assert.equal((await call('observeDuel', { action: 'actions' })).context.deckSkills.skills.length, 1);
  assert.equal((await call('observeDuel', { action: 'state' })).context.deckSkills.skills.length, 1);
  const other = await host.execute({ name: 'learnDeck', input: { action: 'learn' } }, { sessionId: 'other' });
  assert.equal(other.result.code, 'DECK_LEARNING_REPLAY_REQUIRED');
  const file = join(directory, 'real.yrp');
  await writeFile(file, Buffer.from(REAL_YRP_BASE64, 'base64'));
  const fileLearn = await call('learnDeck', { action: 'learn', file, skillName: 'real-file', maxSteps: 3 });
  assert.equal(fileLearn.stepCount, 3);
  assert.equal(fileLearn.context.deckSkills.skills.length, 2);
  assert.match(fileLearn.skill.content, /contains 10 visible operations/);
  assert.equal((await call('manageSessionDeck', { action: 'edit', operation: 'add', section: 'main', cardId: 68353324, quantity: 1 })).context.deckSkills.skills.length, 0);
  const reloaded = await call('manageSessionDeck', { action: 'set', deck }, 'other');
  assert.equal(reloaded.context.deckSkills.skills.length, 2);
  assert.equal(host.getSession('one').metadata.activeDeckSkills.length, 0);
  assert.equal((await call('observeDuel', { action: 'actions' })).context.deckSkills.skills.length, 0);
  assert.equal((await call('learnDeck', { action: 'delete', skillName: 'real-replay', confirm: true }, 'other')).context.deckSkills.skills.length, 1);
});
