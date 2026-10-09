import assert from 'node:assert/strict';
import test from 'node:test';
import { attachDuelWatcher, startDuelWatcher } from '../lib/duel-watcher.js';

// A minimal job registry: runs the producer and exposes its settlement.
function fakeJobs() {
  const jobs = { started: [], start(spec) {
    const job = { id: `${spec.kind}-1`, appended: [], progress: [] };
    const handle = { id: job.id, append: (text) => job.appended.push(text), updateProgress: (line) => job.progress.push(line) };
    job.spec = spec;
    job.hooks = spec.run(handle);
    jobs.started.push(job);
    return job.id;
  } };
  return jobs;
}

// Engine stub whose status changes over successive polls.
function engineWith(statuses) {
  let call = 0;
  return { execute: async () => ({ result: { ok: true, data: statuses[Math.min(call++, statuses.length - 1)] } }) };
}

const waiting = { mode: 'host', running: true, room: { opponentConnected: false, duelStartedAt: null } };
const inRoom = { mode: 'host', running: true, room: { opponentConnected: true, duelStartedAt: null } };
const started = { mode: 'host', running: true, room: { opponentConnected: true, duelStartedAt: '2026-10-08T00:00:00Z' } };

test('watcher keeps waiting until the duel starts, then completes with instructions', async () => {
  const jobs = fakeJobs();
  const watcher = startDuelWatcher(jobs, engineWith([waiting, inRoom, started]), { agent: { id: 'agent-1' } }, 'dsh-1', 5);
  assert.deepEqual(watcher, { jobId: 'ygoduel-1' });
  const job = jobs.started[0];
  assert.equal(job.spec.owner, 'agent-1');
  const outcome = await job.hooks.done;
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.detail, 'opponent started the duel');
  assert.match(outcome.result, /action:"wait"/);
  assert.deepEqual(job.progress, ['waiting for opponent', 'opponent in room, not started']);
});

test('watcher settles when the room closes or errors, and can be cancelled', async () => {
  const closed = fakeJobs();
  startDuelWatcher(closed, engineWith([{ running: false }]), {}, 'dsh-1', 5);
  assert.equal((await closed.started[0].hooks.done).detail, 'room closed');

  const failed = fakeJobs();
  startDuelWatcher(failed, engineWith([{ ...inRoom, hostError: 'AI.Server exited' }]), {}, 'dsh-1', 5);
  assert.equal((await failed.started[0].hooks.done).detail, 'room error: AI.Server exited');

  const cancelled = fakeJobs();
  startDuelWatcher(cancelled, engineWith([waiting]), {}, 'dsh-1', 5);
  cancelled.started[0].hooks.cancel('user stop');
  assert.deepEqual(await cancelled.started[0].hooks.done, { status: 'killed', detail: 'user stop' });
});

test('no job registry means no watcher, and the job id is attached to the host result', () => {
  assert.equal(startDuelWatcher(undefined, engineWith([waiting]), {}, 'dsh-1'), null);
  const result = { ok: true, result: { ok: true, data: { room: {} } } };
  attachDuelWatcher(result, { jobId: 'ygoduel-1' });
  assert.deepEqual(result.result.data.duelWatcher, { jobId: 'ygoduel-1' });
  attachDuelWatcher(result, null);
  assert.deepEqual(result.result.data.duelWatcher, { jobId: 'ygoduel-1' });
});
