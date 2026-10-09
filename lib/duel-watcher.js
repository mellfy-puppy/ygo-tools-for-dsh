// Hosted-room watcher: a DSH background job that settles once the hosted duel
// needs the model. DSH turns that settlement into a wake-up for an idle session.

const DUEL_WATCH_INTERVAL_MS = 2000;

// Settles when the opponent starts the duel, a decision or chat is waiting,
// the duel ends, or the room fails. Returns null when no job registry exists.
export function startDuelWatcher(jobs, engineClient, exec, sessionId, intervalMs = DUEL_WATCH_INTERVAL_MS) {
  if (!jobs || typeof jobs.start !== 'function') return null;
  try {
    const id = jobs.start({
      kind: 'ygoduel',
      label: 'Waiting for the YGOPro2 opponent to start the duel',
      ...(exec?.agent ? { owner: exec.agent.id } : {}),
      run: (job) => {
        let stopped = false;
        let timer;
        let settle;
        const done = new Promise((resolvePromise) => { settle = resolvePromise; });
        const finish = (outcome) => {
          if (stopped) return;
          stopped = true;
          clearTimeout(timer);
          settle(outcome);
        };
        const poll = async () => {
          if (stopped) return;
          try {
            const response = await engineClient.execute(
              { name: 'manageYgoPro2', input: { action: 'status' } },
              { sessionId, timeoutMs: 10000 },
            );
            const bridge = response?.result?.data ?? {};
            if (bridge.mode !== 'host' || bridge.running === false) {
              finish({ status: 'completed', detail: 'room closed', result: 'The YGOPro2 room is no longer running.' });
              return;
            }
            const started = Boolean(bridge.room?.duelStartedAt);
            if (started || bridge.hostEventPending || bridge.hostError || bridge.terminalResult) {
              const what = bridge.hostError ? `room error: ${bridge.hostError}`
                : bridge.terminalResult ? `duel ended: ${bridge.terminalResult}`
                  : started ? 'opponent started the duel' : 'opponent sent chat';
              job.append(`${what}\n`);
              finish({
                status: 'completed',
                detail: what,
                result: `${what}. Call manageYgoPro2 action:"wait" now and keep playing: act with executeAction on each "decision", reply to "chat" with action:"chat", and call wait again on "timeout" until the duel ends.`,
              });
              return;
            }
            job.updateProgress(bridge.room?.opponentConnected ? 'opponent in room, not started' : 'waiting for opponent');
          } catch (error) {
            job.updateProgress(`status check failed: ${error instanceof Error ? error.message : String(error)}`);
          }
          if (!stopped) timer = setTimeout(poll, intervalMs);
        };
        timer = setTimeout(poll, intervalMs);
        return {
          done,
          cancel: (reason) => finish({ status: 'killed', ...(reason ? { detail: reason } : {}) }),
        };
      },
    });
    return { jobId: id };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function attachDuelWatcher(result, watcher) {
  if (!watcher) return;
  const target = result.result && typeof result.result === 'object' ? result.result : result;
  target.data = { ...(target.data ?? {}), duelWatcher: watcher };
}
