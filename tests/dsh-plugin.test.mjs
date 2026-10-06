import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import Tools, { defineTool } from '@deepseek-ai/dsh-tools';
import Skills from '@deepseek-ai/dsh-skill';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import plugin, { resolvePluginConfig } from '../lib/index.js';
import { PUBLIC_TOOL_NAMES } from '../skill/backend/tool-schemas.mjs';
import { ENGINE_HOST_PROTOCOL } from '../skill/backend/persistent-engine-server.mjs';

// These tests use the installed DSH registries and execution pipeline. The
// loopback peer only replaces the detached engine, so no real duel is touched.
async function harness(t, handle = () => ({ ok: true, data: {} })) {
  const requests = [];
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/health') {
      response.end(JSON.stringify({ ok: true, protocol: ENGINE_HOST_PROTOCOL }));
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(payload);
    const result = await handle(payload);
    response.end(JSON.stringify({ ok: result.ok !== false, sessionId: payload.sessionId, result }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const ctx = new Context();
  t.after(async () => {
    await ctx.fiber.dispose();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(Tools, { mode: 'native' });
  await ctx.plugin(Skills, {});
  const config = { engineAutoStart: false, enginePort: server.address().port };
  const fiber = await ctx.plugin(plugin, config);
  let call = 0;
  const run = (name, args, agent = { id: 'agent-a', session: { id: 'session-a' } }, signal = new AbortController().signal) => ctx.tools.execute({
    callId: `test-${++call}`,
    name,
    arguments: args,
    agent,
    signal,
  });
  return { ctx, fiber, config, requests, run };
}

test('current DSH loads every public tool and packaged skill, then disposes and reloads them', async (t) => {
  const { ctx, fiber, config } = await harness(t);
  assert.equal(PUBLIC_TOOL_NAMES.length, 15);
  for (const name of PUBLIC_TOOL_NAMES) {
    const definition = ctx.tools.get(name);
    assert.ok(definition, `${name} is registered`);
    assert.equal(definition.output.schema.type, 'object');
    assert.ok(definition.output.schema.required.includes('ok'));
  }
  const skill = await ctx.skills.get('ygo-tools-for-dsh');
  assert.equal(skill.provider, 'ygo-tools');
  assert.deepEqual(skill.invocation, { modelInvocable: true, userInvocable: true });
  assert.match(skill.content, /learnDeck/);
  await fiber.dispose();
  for (const name of PUBLIC_TOOL_NAMES) assert.equal(ctx.tools.get(name), undefined);
  assert.equal(await ctx.skills.get('ygo-tools-for-dsh'), undefined);
  const reloaded = await ctx.plugin(plugin, config);
  assert.ok(ctx.tools.get('learnDeck'));
  await reloaded.dispose();
});

test('structured canonical results and durable session routing work through ToolRuntime', async (t) => {
  const { run, requests } = await harness(t, ({ sessionId }) => ({ ok: true, data: { sessionId, value: 3 } }));
  const a = await run('manageEngineSession', { action: 'status' });
  const b = await run('manageEngineSession', { action: 'status' }, { id: 'agent-a', session: { id: 'session-b' } });
  const aAgain = await run('manageEngineSession', { action: 'status' });
  await run('manageEngineSession', { action: 'status' }, { id: 'legacy-session' });
  assert.equal(a.isError, false);
  assert.equal(b.isError, false);
  assert.equal(aAgain.isError, false);
  assert.equal(typeof a.value, 'object');
  assert.equal(a.value.result.data.value, 3);
  assert.equal(a.value.sessionId, undefined);
  assert.equal(a.value.result.data.sessionId, undefined);
  assert.deepEqual(JSON.parse(a.content[0].text), a.value);
  assert.deepEqual(requests.map((entry) => entry.sessionId), [
    'dsh-session-a', 'dsh-session-b', 'dsh-session-a', 'dsh-legacy-session',
  ]);
});

test('a failed partial plugin load rolls back only its own registrations', async (t) => {
  const { ctx, fiber, config } = await harness(t);
  await fiber.dispose();
  const conflict = defineTool({
    name: PUBLIC_TOOL_NAMES[3], description: 'Preexisting tool fixture.', parameters: {},
    output: { schema: { type: 'boolean' }, render: () => [] },
    async execute() { return true; },
  });
  const removeConflict = ctx.tools.register(conflict);
  await assert.rejects(async () => { await ctx.plugin(plugin, config); }, /already registered/);
  assert.equal(ctx.tools.get(PUBLIC_TOOL_NAMES[3]), conflict);
  for (const name of PUBLIC_TOOL_NAMES.slice(0, 3)) assert.equal(ctx.tools.get(name), undefined);
  assert.equal(await ctx.skills.get('ygo-tools-for-dsh'), undefined);
  await removeConflict();
});

test('anonymous and pre-aborted execution cannot reach a shared engine session', async (t) => {
  const { run, requests } = await harness(t);
  const anonymous = await run('manageEngineSession', { action: 'status' }, {});
  assert.equal(anonymous.isError, true);
  assert.match(anonymous.content[0].text, /session identity/);
  const aborted = await run('manageEngineSession', { action: 'status' }, { id: 'a' }, AbortSignal.abort());
  assert.equal(aborted.isError, true);
  assert.equal(requests.length, 0);
});

test('DSH validates model arguments before backend dispatch', async (t) => {
  const { run, requests } = await harness(t);
  const result = await run('manageEngineSession', { action: 'not-an-action' });
  assert.equal(result.isError, true);
  assert.equal(requests.length, 0);
});

test('deck context is deferred, deduplicated per session and replaced on changes', async (t) => {
  let content = 'Summon Beaver, then inspect the available effect.';
  let active = true;
  const { run } = await harness(t, ({ call }) => ({
    ok: true,
    data: call.name === 'manageEngineSession' && call.input.action === 'clear'
      ? { action: 'clear-session' }
      : { context: { deckSkills: {
        deckFingerprint: active ? 'deck-a' : 'deck-b',
        skills: active ? [{ name: 'beaver-route', description: 'Replay operations', content }] : [],
      } } },
  }));
  const first = await run('manageSessionDeck', { action: 'get' });
  assert.equal(first.isError, false);
  const message = first.additionalContexts[0];
  assert.equal(message.role, 'user');
  assert.ok(message.id);
  assert.equal(message.source.kind, 'ygo-deck-skills');
  assert.equal(message.source.form, 'snapshot');
  assert.equal(message.source.deckFingerprint, 'deck-a');
  assert.match(message.content[0].text, /Summon Beaver/);
  const same = await run('observeDuel', { action: 'state' });
  assert.equal(same.additionalContexts, undefined);
  const otherSession = await run('manageSessionDeck', { action: 'get' }, { id: 'b' });
  assert.equal(otherSession.additionalContexts.length, 1);
  content = 'Updated verified replay operations.';
  const changed = await run('learnDeck', { action: 'activate' });
  assert.match(changed.additionalContexts[0].content[0].text, /Updated verified/);
  active = false;
  const switched = await run('manageSessionDeck', { action: 'get' });
  assert.match(switched.additionalContexts[0].content[0].text, /Earlier learned-deck context is inactive/);
  active = true;
  const restored = await run('manageSessionDeck', { action: 'get' });
  assert.equal(restored.additionalContexts.length, 1);
  const cleared = await run('manageEngineSession', { action: 'clear', confirm: true });
  assert.match(cleared.additionalContexts[0].content[0].text, /No learned YGO skill is active/);
});

test('failed engine result does not activate supplied deck instructions', async (t) => {
  const { run } = await harness(t, () => ({ ok: false, code: 'NO_DECK', data: {
    deckSkills: { deckFingerprint: 'x', skills: [{ name: 'x', content: 'Uncommitted skill.' }] },
  } }));
  const result = await run('learnDeck', { action: 'activate' });
  assert.equal(result.value.ok, false);
  assert.equal(result.additionalContexts, undefined);
});

test('the first empty match after plugin reload invalidates older transcript context', async (t) => {
  let active = true;
  const { ctx, fiber, config, run } = await harness(t, () => ({ ok: true, data: {
    context: { deckSkills: { deckFingerprint: 'deck-a', skills: active ? [{ name: 'route', content: 'Prior learned line.' }] : [] } },
  } }));
  const initial = await run('manageSessionDeck', { action: 'get' });
  assert.equal(initial.additionalContexts.length, 1);
  await fiber.dispose();
  active = false;
  const reloaded = await ctx.plugin(plugin, config);
  const empty = await run('manageSessionDeck', { action: 'get' });
  assert.match(empty.additionalContexts[0].content[0].text, /Earlier learned-deck context is inactive/);
  const repeated = await run('manageSessionDeck', { action: 'get' });
  assert.equal(repeated.additionalContexts, undefined);
  await reloaded.dispose();
});

test('deck skill storage has an independent writable data-root setting', () => {
  const dataRoot = resolve('test-ygo-data');
  const custom = resolve('test-custom-skills');
  const options = resolvePluginConfig({ dataRoot, deckSkillDir: custom });
  assert.equal(options.serverEnv.YGO_DECK_SKILL_DIR, custom);
  if (!process.env.YGO_DECK_SKILL_DIR) {
    assert.equal(resolvePluginConfig({ dataRoot }).serverEnv.YGO_DECK_SKILL_DIR, join(dataRoot, 'deck-skills'));
  }
});
