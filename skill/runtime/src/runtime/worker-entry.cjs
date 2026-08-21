'use strict';

function createWorkerEntryApi(deps) {
  const {
    process,
    isMainThread,
    parentPort,
    workerData,
    cleanupRuntime,
    createSearchContext,
    searchTopLongestPaths,
    runSearchJob,
    executeWebSearch,
    getCoreProfileRows,
    getExactSearchApi,
    snapshotState,
  } = deps;

  function cloneJsonValue(value) {
    if (value === undefined) return undefined;
    if (value === null) return null;
    return JSON.parse(JSON.stringify(value));
  }

  function summarizeResumeStateForDump(shard) {
    const summary = {
      decoded: false,
      rootHistory: 0,
      rootHistoryKey: '',
      stackLength: 0,
      best: null,
      framesTail: [],
      decodeError: null,
    };
    try {
      const exactApi = typeof getExactSearchApi === 'function' ? getExactSearchApi() : null;
      const decoded = exactApi?.deserializeExactSearchResumeState
        ? exactApi.deserializeExactSearchResumeState(shard?.resumeState)
        : null;
      if (!decoded) return summary;
      const stack = Array.isArray(decoded.stack) ? decoded.stack : [];
      summary.decoded = true;
      summary.rootHistory = Array.isArray(decoded.rootState?.history) ? decoded.rootState.history.length : 0;
      summary.rootHistoryKey = decoded.rootState?.historyKey ?? '';
      summary.stackLength = stack.length;
      summary.best = {
        nodes: decoded.best?.nodes ?? 0,
        terminalCount: decoded.best?.terminalCount ?? 0,
        topPaths: Array.isArray(decoded.best?.topPaths) ? decoded.best.topPaths.length : 0,
      };
      summary.framesTail = stack.slice(-5).map((frame, index) => ({
        tailIndex: stack.length - Math.min(stack.length, 5) + index,
        depth: frame?.depth ?? 0,
        nextIndex: frame?.nextIndex ?? 0,
        actionCount: Array.isArray(frame?.actions) ? frame.actions.length : 0,
        baseHistory: Array.isArray(frame?.baseState?.history) ? frame.baseState.history.length : 0,
        stateKey: frame?.stateKey ?? '',
        ancestorStateKeys: Array.isArray(frame?.ancestorStateKeys) ? frame.ancestorStateKeys.length : 0,
        nextAction: Array.isArray(frame?.actions)
          ? (frame.actions[frame?.nextIndex ?? 0]?.label ?? frame.actions[frame?.nextIndex ?? 0]?.kind ?? null)
          : null,
      }));
    } catch (err) {
      summary.decodeError = err?.message ?? String(err);
    }
    return summary;
  }

  function summarizeRunnerForDump(runner) {
    const decision = runner?.currentDecision;
    return {
      actionHistoryLength: Array.isArray(runner?.actionHistory) ? runner.actionHistory.length : 0,
      actionHistoryKey: runner?.actionHistoryKey ?? '',
      decision: {
        terminal: !!decision?.terminal,
        reason: decision?.reason ?? null,
        messageName: decision?.message?.constructor?.name ?? null,
        actionCount: Array.isArray(decision?.actions) ? decision.actions.length : 0,
        actionLabels: Array.isArray(decision?.actions)
          ? decision.actions.slice(0, 12).map((action) => action?.label ?? action?.kind ?? String(action ?? ''))
          : [],
      },
    };
  }

  function buildShardFailureDump(err, shard, nodeBudget, job, runner) {
    return {
      dumpedAt: new Date().toISOString(),
      pid: process.pid,
      error: {
        message: err?.message ?? String(err),
        name: err?.name ?? null,
        stack: err?.stack ?? null,
      },
      job: {
        deckPath: job?.deckPath ?? null,
        resourceDir: job?.resourceDir ?? null,
        cardsPath: job?.cardsPath ?? null,
        scriptDirs: cloneJsonValue(job?.scriptDirs ?? null),
        nativeScriptsRoot: job?.nativeScriptsRoot ?? null,
        drawCount: job?.drawCount ?? null,
        seed: job?.seed ?? null,
        yrpVersion: job?.yrpVersion ?? null,
        maxNodes: job?.maxNodes ?? null,
        maxDepth: job?.maxDepth ?? null,
        topK: job?.topK ?? null,
        targetTerminals: job?.targetTerminals ?? null,
        maxBeamWidth: job?.maxBeamWidth ?? null,
        progressEvery: job?.progressEvery ?? null,
        checkpointEvery: job?.checkpointEvery ?? null,
        workers: job?.workers ?? null,
        childWorkerIndex: job?.childWorkerIndex ?? null,
        seedResultNodesBase: job?.seedResultNodesBase ?? null,
        seedResultTerminalBase: job?.seedResultTerminalBase ?? null,
        engineBackend: job?.engineBackend ?? null,
        exactSearchBackend: job?.exactSearchBackend ?? null,
        exactSingleSearch: !!job?.exactSingleSearch,
        snapshotAccelMode: job?.snapshotAccelMode ?? null,
        snapshotStorageMode: job?.snapshotStorageMode ?? null,
        fixedOpeningInstanceIds: cloneJsonValue(job?.fixedOpeningInstanceIds ?? null),
        fixedOpeningCodes: cloneJsonValue(job?.fixedOpeningCodes ?? null),
        openingCodes: cloneJsonValue(job?.openingCodes ?? null),
        requestSignature: job?.requestSignature ?? null,
        playerOpening: cloneJsonValue(job?.playerOpening ?? null),
        opponentOpening: cloneJsonValue(job?.opponentOpening ?? null),
        playerDeck: cloneJsonValue(job?.playerDeck ?? null),
        opponentDeck: cloneJsonValue(job?.opponentDeck ?? null),
        scoringRules: cloneJsonValue(job?.scoringRules ?? null),
        topPathPolicy: cloneJsonValue(job?.topPathPolicy ?? null),
      },
      shard: {
        shardId: shard?.shardId ?? null,
        shardCount: shard?.shardCount ?? null,
        splitDepth: shard?.splitDepth ?? null,
        actionCount: shard?.actionCount ?? null,
        nodeBudget,
        resumeState: cloneJsonValue(shard?.resumeState ?? null),
      },
      resumeStateSummary: summarizeResumeStateForDump(shard),
      runner: summarizeRunnerForDump(runner),
      profileRows: typeof getCoreProfileRows === 'function' ? cloneJsonValue(getCoreProfileRows()) : [],
    };
  }

  function writeShardFailureDump(err, shard, nodeBudget, job, runner) {
    if (process.env.YGO_ALLOW_DIAGNOSTIC_FILES !== '1' || process.env.COMBO_SHARD_FAILURE_DUMP !== '1') return null;
    try {
      const fs = require('fs');
      const path = require('path');
      const dumpDir = process.env.COMBO_SHARD_FAILURE_DUMP_DIR ||
        path.join(process.env.YGO_CACHE_DIR ? path.resolve(String(process.env.YGO_CACHE_DIR)) : path.join(process.cwd(), '.cache'), 'repro-dumps');
      fs.mkdirSync(dumpDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const shardId = String(shard?.shardId ?? 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
      const shardCount = String(shard?.shardCount ?? 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
      const workerIndex = String(job?.childWorkerIndex ?? 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
      const filePath = path.join(
        dumpDir,
        `${stamp}-pid${process.pid}-worker${workerIndex}-shard${shardId}-of-${shardCount}.json`,
      );
      fs.writeFileSync(filePath, JSON.stringify(buildShardFailureDump(err, shard, nodeBudget, job, runner), null, 2));
      console.error(`[parallel-shard-failure-dump] path=${filePath}`);
      return filePath;
    } catch (dumpErr) {
      console.error(`[parallel-shard-failure-dump-failed] error=${dumpErr?.message ?? String(dumpErr)}`);
      return null;
    }
  }

  // 把 shard 顶层 frame 信息折成短字符串,附在 error message 后面,方便父进程定位 OOB 哪个 shard。
  function summarizeShardForError(shard, nodeBudget, job) {
    if (!shard) return '';
    let topFrame = null;
    try {
      const exactApi = typeof getExactSearchApi === 'function' ? getExactSearchApi() : null;
      const decoded = exactApi?.deserializeExactSearchResumeState
        ? exactApi.deserializeExactSearchResumeState(shard.resumeState)
        : null;
      const stack = Array.isArray(decoded?.stack) ? decoded.stack : [];
      if (stack.length > 0) {
        const top = stack[stack.length - 1];
        topFrame = {
          depth: top?.depth ?? 0,
          nextIndex: top?.nextIndex ?? 0,
          actions: Array.isArray(top?.actions) ? top.actions.length : 0,
          history: Array.isArray(top?.baseState?.history) ? top.baseState.history.length : 0,
        };
      }
    } catch {
      // ignore decode errors,只是辅助诊断
    }
    const parts = [
      `shard=${shard.shardId ?? '?'}/${shard.shardCount ?? '?'}`,
      `worker=${job?.childWorkerIndex ?? '?'}`,
      `budget=${nodeBudget ?? 0}`,
      `snapshot=${job?.snapshotAccelMode ?? '?'}/${job?.snapshotStorageMode ?? '?'}`,
    ];
    if (topFrame) {
      parts.push(
        `topFrame(depth=${topFrame.depth},nextIndex=${topFrame.nextIndex},actions=${topFrame.actions},history=${topFrame.history})`,
      );
    }
    return parts.join(' ');
  }

  function enrichShardError(err, shard, nodeBudget, job) {
    const summary = summarizeShardForError(shard, nodeBudget, job);
    if (!summary) return err;
    const baseMsg = err?.message ?? String(err);
    if (typeof baseMsg === 'string' && baseMsg.includes(' | shard=')) return err;
    const enriched = new Error(`${baseMsg} | ${summary}`);
    if (err?.stack) enriched.stack = `${enriched.message}\n${err.stack}`;
    return enriched;
  }

  async function runParallelExactWorkerThread() {
    let runtime = null;
    let runner = null;
    let job = null;
    let finished = false;
    const debugWorkerThread = (...args) => {
      if (process.env.COMBO_WORKER_DEBUG === '1' || process.env.COMBO_PARALLEL_EXACT_DIAG === '1') {
        console.error('[parallel-thread-debug]', ...args);
      }
    };
    const postMessage = (message) => {
      if (!finished) parentPort.postMessage(message);
    };
    const cleanupAndFinish = async () => {
      if (finished) return;
      finished = true;
      await cleanupRuntime(runtime, runner);
      runtime = null;
      runner = null;
      parentPort.close();
    };
    const runExactShard = (shard, nodeBudget) => {
      let latestCheckpointResumeState = shard.resumeState ?? null;
      const searchStartNs = process.hrtime.bigint();
      snapshotState.clearCoreProfileStats();
      const result = searchTopLongestPaths(runner, {
        maxDepth: job.maxDepth,
        maxNodes: nodeBudget,
        targetTerminals: job.targetTerminals,
        maxBeamWidth: job.maxBeamWidth,
        topK: job.topK,
        seed: job.seed,
        exactSingleSearch: job.exactSingleSearch,
        progressEvery: job.progressEvery,
        resumeState: shard.resumeState,
        searchStartedAtMs: job.searchStartedAtMs ?? job.startedAtMs,
        topPathPolicy: job.topPathPolicy ?? null,
        onProgress: (progress) => {
          postMessage({
            type: 'progress',
            progress: {
              ...progress,
              shardId: shard.shardId,
              shardCount: shard.shardCount ?? 1,
              childWorkerIndex: job.childWorkerIndex ?? 0,
            },
          });
        },
        onCheckpoint: (checkpoint) => {
          latestCheckpointResumeState = checkpoint?.resumeState ?? latestCheckpointResumeState;
          postMessage({
            type: 'checkpoint',
            checkpoint: {
              ...checkpoint,
              shardId: shard.shardId,
              shardCount: shard.shardCount ?? 1,
              childWorkerIndex: job.childWorkerIndex ?? 0,
            },
          });
        },
      });
      return {
        shardId: shard.shardId,
        shardCount: shard.shardCount ?? 1,
        result,
        resumeState: cloneJsonValue(result?.resumeState) ?? latestCheckpointResumeState ?? null,
        complete: result?.completed !== false,
        stopReason: result?.stopReason ?? 'DONE',
        searchElapsedMs: Number(process.hrtime.bigint() - searchStartNs) / 1e6,
        profileRows: getCoreProfileRows(),
      };
    };

    await new Promise((resolve, reject) => {
      parentPort.on('message', async (message) => {
        try {
          debugWorkerThread('message', message?.type ?? null);
          if (message?.type === 'init') {
            job = message.job ?? {};
            snapshotState.setSnapshotAccelMode(String(job.snapshotAccelMode ?? snapshotState.getSnapshotAccelMode()).toLowerCase());
            snapshotState.setSnapshotStorageMode(String(job.snapshotStorageMode ?? snapshotState.getSnapshotStorageMode()).toLowerCase());
            snapshotState.resetSnapshotAccelState();
            snapshotState.setCoreProfileEnabled(!!job.profileCore);
            snapshotState.clearCoreProfileStats();
            ({ runtime, runner } = await createSearchContext(job));
            postMessage({
              type: 'ready',
              nativeSnapshotMode: runner.nativeSnapshotMode,
              initialDecisionName: runner.currentDecision?.message?.constructor?.name ?? '终局',
            });
            return;
          }
          if (message?.type === 'run-shard') {
            if (!job || !runner) {
              throw new Error('parallel exact thread worker is not initialized');
            }
            const shard = message.shard;
            const nodeBudget = Number(message.nodeBudget ?? 0);
            if (!shard?.resumeState) {
              throw new Error('parallel exact thread worker received invalid shard payload');
            }
            if (!Number.isFinite(nodeBudget) || nodeBudget <= 0) {
              throw new Error('parallel exact thread worker received invalid shard node budget');
            }
            let shardPayload;
            try {
              shardPayload = runExactShard(shard, nodeBudget);
            } catch (err) {
              const dumpPath = writeShardFailureDump(err, shard, nodeBudget, job, runner);
              const enriched = enrichShardError(err, shard, nodeBudget, job);
              if (dumpPath && enriched?.message && !enriched.message.includes('dump=')) {
                enriched.message = `${enriched.message} dump=${dumpPath}`;
              }
              throw enriched;
            }
            postMessage({
              type: 'shard-result',
              payload: shardPayload,
            });
            if (typeof global.gc === 'function') {
              try {
                global.gc();
              } catch {
                // best-effort heap trim after sending a large shard payload
              }
            }
            return;
          }
          if (message?.type === 'shutdown') {
            await cleanupAndFinish();
            resolve();
          }
        } catch (err) {
          postMessage({ type: 'error', error: err?.message ?? String(err) });
          await cleanupAndFinish();
          reject(err);
        }
      });
    });
    return true;
  }

  async function runWorkerThread() {
    if (
      isMainThread ||
      !parentPort ||
      !['search-worker', 'web-search-worker', 'parallel-exact-worker'].includes(workerData?.type)
    ) {
      return false;
    }
    if (workerData?.type === 'parallel-exact-worker') {
      return runParallelExactWorkerThread();
    }
    const job = workerData.job ?? {};
    snapshotState.setSnapshotAccelMode(String(job.snapshotAccelMode ?? snapshotState.getSnapshotAccelMode()).toLowerCase());
    snapshotState.setSnapshotStorageMode(String(job.snapshotStorageMode ?? snapshotState.getSnapshotStorageMode()).toLowerCase());
    snapshotState.resetSnapshotAccelState();
    snapshotState.setCoreProfileEnabled(!!job.profileCore);
    snapshotState.clearCoreProfileStats();
    const debugWorkerThread = (...args) => {
      if (process.env.COMBO_WORKER_DEBUG === '1') {
        console.error('[worker-thread-debug]', ...args);
      }
    };

    const postMessageAndWaitForAck = (message, ackType, timeoutMs = 5000) =>
      new Promise((resolve, reject) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          parentPort.off('message', onAck);
          resolve();
        };
        const onAck = (incoming) => {
          if (incoming?.type === ackType) done();
        };
        const timer = setTimeout(done, timeoutMs);
        parentPort.on('message', onAck);
        try {
          parentPort.postMessage(message);
        } catch (err) {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            parentPort.off('message', onAck);
            reject(err);
          }
        }
      });

    await new Promise((resolve, reject) => {
      parentPort.once('message', async (message) => {
        debugWorkerThread('received', message?.type, workerData?.type);
        if (message?.type !== 'run') {
          reject(new Error('worker did not receive run command'));
          return;
        }
        try {
          debugWorkerThread('run-start', workerData?.type);
          const payload = workerData?.type === 'web-search-worker'
            ? await executeWebSearch(job, (progress) => {
                parentPort.postMessage({ type: 'progress', progress });
              })
            : await runSearchJob({
                ...job,
                onProgress: (progress) => {
                  parentPort.postMessage({ type: 'progress', progress });
                },
              });
          debugWorkerThread('run-finished', workerData?.type);
          await postMessageAndWaitForAck({ type: 'result', payload }, 'result-ack');
          debugWorkerThread('result-acked', workerData?.type);
          resolve();
        } catch (err) {
          debugWorkerThread('run-error', err?.message ?? String(err));
          try {
            await postMessageAndWaitForAck(
              { type: 'error', error: err?.message ?? String(err) },
              'error-ack',
              1000,
            );
          } catch {
            // The outer catch path will surface the worker failure via exit code.
          }
          reject(err);
        }
      });
      parentPort.postMessage({ type: 'ready' });
    });
    return true;
  }

  async function runChildWorkerProcess() {
    if (process.env.COMBO_SIMULATOR_CHILD !== '1' || typeof process.send !== 'function') {
      return false;
    }

    let runtime = null;
    let runner = null;
    let job = null;
    let ipcConnected = process.connected !== false;
    const debugChildWorkerProcess = (event, detail = {}) => {
      if (process.env.COMBO_PARALLEL_EXACT_DIAG !== '1' && process.env.COMBO_WORKER_DEBUG !== '1') return;
      try {
        console.error('[parallel-child-debug]', event, JSON.stringify(detail));
      } catch {
        console.error('[parallel-child-debug]', event);
      }
    };

    class IpcDisconnectedError extends Error {
      constructor(message = 'child worker IPC disconnected') {
        super(message);
        this.code = 'IPC_DISCONNECTED';
      }
    }

    const isIpcDisconnectedError = (err) =>
      err?.code === 'IPC_DISCONNECTED' ||
      err?.code === 'EPIPE' ||
      err?.code === 'ERR_IPC_CHANNEL_CLOSED';

    const markIpcDisconnected = () => {
      ipcConnected = false;
    };

    const safeSend = (message) => {
      if (!ipcConnected || typeof process.send !== 'function' || process.connected === false) {
        markIpcDisconnected();
        return false;
      }
      try {
        process.send(message, (err) => {
          if (err && isIpcDisconnectedError(err)) {
            markIpcDisconnected();
          }
        });
        return true;
      } catch (err) {
        if (isIpcDisconnectedError(err)) {
          markIpcDisconnected();
          return false;
        }
        throw err;
      }
    };

    const sendOrAbort = (message) => {
      if (!safeSend(message)) {
        throw new IpcDisconnectedError();
      }
    };

    process.once('disconnect', () => {
      markIpcDisconnected();
    });
    process.on('error', (err) => {
      if (isIpcDisconnectedError(err)) {
        markIpcDisconnected();
        return;
      }
      throw err;
    });

    const runExactShard = (shard, nodeBudget) => {
      snapshotState.clearCoreProfileStats();
      const searchStartNs = process.hrtime.bigint();
      let latestCheckpointResumeState = null;
      const result = searchTopLongestPaths(runner, {
        maxDepth: job.maxDepth,
        maxNodes: job.maxNodes,
        nodeBudget,
        targetTerminals: job.targetTerminals,
        maxBeamWidth: job.maxBeamWidth,
        topK: job.topK,
        seed: job.seed,
        exactSingleSearch: job.exactSingleSearch,
        progressEvery: job.progressEvery,
        resumeState: shard.resumeState,
        checkpointEvery: job.checkpointEvery,
        searchStartedAtMs: job.searchStartedAtMs ?? job.startedAtMs,
        recordIntermediateScoredStates: Array.isArray(job.scoringRules) && job.scoringRules.length > 0,
        topPathPolicy: job.topPathPolicy ?? null,
        onProgress: ipcConnected
          ? (progress) => {
              sendOrAbort({
                type: 'progress',
                progress: {
                  ...progress,
                  shardId: shard.shardId,
                  shardCount: shard.shardCount ?? 1,
                  childWorkerIndex: job.childWorkerIndex ?? 0,
                },
              });
            }
          : null,
        onCheckpoint: ipcConnected
          ? (checkpoint) => {
              latestCheckpointResumeState = checkpoint?.resumeState ?? latestCheckpointResumeState;
              sendOrAbort({
                type: 'checkpoint',
                checkpoint: {
                  ...checkpoint,
                  shardId: shard.shardId,
                  shardCount: shard.shardCount ?? 1,
                  childWorkerIndex: job.childWorkerIndex ?? 0,
                },
              });
            }
          : null,
      });
      return {
        shardId: shard.shardId,
        shardCount: shard.shardCount ?? 1,
        result,
        resumeState: cloneJsonValue(result?.resumeState) ?? latestCheckpointResumeState ?? null,
        complete: result?.completed !== false,
        stopReason: result?.stopReason ?? 'DONE',
        searchElapsedMs: Number(process.hrtime.bigint() - searchStartNs) / 1e6,
        profileRows: getCoreProfileRows(),
      };
    };

    process.on('message', async (message) => {
      try {
        debugChildWorkerProcess('message', {
          pid: process.pid,
          type: message?.type ?? null,
          hasJob: !!job,
        });
        if (message?.type === 'init') {
          job = message.job ?? {};
          snapshotState.setSnapshotAccelMode(String(job.snapshotAccelMode ?? snapshotState.getSnapshotAccelMode()).toLowerCase());
          snapshotState.setSnapshotStorageMode(String(job.snapshotStorageMode ?? snapshotState.getSnapshotStorageMode()).toLowerCase());
          snapshotState.resetSnapshotAccelState();
          snapshotState.setCoreProfileEnabled(!!job.profileCore);
          snapshotState.clearCoreProfileStats();
          ({ runtime, runner } = await createSearchContext(job));
          sendOrAbort({
            type: 'ready',
            nativeSnapshotMode: runner.nativeSnapshotMode,
            initialDecisionName: runner.currentDecision?.message?.constructor?.name ?? '终局',
          });
          debugChildWorkerProcess('ready-sent', {
            pid: process.pid,
            childWorkerIndex: job.childWorkerIndex ?? null,
          });
          return;
        }
        if (message?.type === 'run-shard') {
          if (!job || !runner) {
            throw new Error('child worker is not initialized');
          }
          const shard = message.shard;
          const nodeBudget = Number(message.nodeBudget ?? 0);
          if (!shard?.resumeState) {
            throw new Error('child worker received invalid shard payload');
          }
          if (!Number.isFinite(nodeBudget) || nodeBudget <= 0) {
            throw new Error('child worker received invalid shard node budget');
          }
          debugChildWorkerProcess('run-shard-start', {
            pid: process.pid,
            childWorkerIndex: job.childWorkerIndex ?? null,
            shardId: shard.shardId ?? null,
            nodeBudget,
          });
          let shardPayload;
          try {
            shardPayload = runExactShard(shard, nodeBudget);
          } catch (err) {
            const dumpPath = writeShardFailureDump(err, shard, nodeBudget, job, runner);
            const enriched = enrichShardError(err, shard, nodeBudget, job);
            if (dumpPath && enriched?.message && !enriched.message.includes('dump=')) {
              enriched.message = `${enriched.message} dump=${dumpPath}`;
            }
            throw enriched;
          }
          sendOrAbort({
            type: 'shard-result',
            payload: shardPayload,
          });
          if (typeof global.gc === 'function') {
            try {
              global.gc();
            } catch {
              // best-effort heap trim after sending a large shard payload
            }
          }
          debugChildWorkerProcess('run-shard-result-sent', {
            pid: process.pid,
            childWorkerIndex: job.childWorkerIndex ?? null,
            shardId: shard.shardId ?? null,
            nodes: shardPayload?.result?.nodes ?? null,
            complete: shardPayload?.complete !== false,
            profileCore: !!job.profileCore,
            profileRows: Array.isArray(shardPayload?.profileRows) ? shardPayload.profileRows.length : 0,
          });
          return;
        }
        if (message?.type === 'run') {
          if (!job || !runner) {
            throw new Error('child worker is not initialized');
          }
          snapshotState.clearCoreProfileStats();
          const searchStartNs = process.hrtime.bigint();
          let result;
          if (Array.isArray(job.exactShards) && job.exactShards.length > 0) {
            const shardResults = [];
            let completedNodes = 0;
            let completedTerminals = 0;
            for (const shard of job.exactShards) {
              const shardResult = searchTopLongestPaths(runner, {
                maxDepth: job.maxDepth,
                maxNodes: job.maxNodes,
                targetTerminals: job.targetTerminals,
                maxBeamWidth: job.maxBeamWidth,
                topK: job.topK,
                seed: job.seed,
                exactSingleSearch: job.exactSingleSearch,
                progressEvery: job.progressEvery,
                resumeState: shard.resumeState,
                searchStartedAtMs: job.searchStartedAtMs ?? job.startedAtMs,
                topPathPolicy: job.topPathPolicy ?? null,
                onProgress: ipcConnected
                  ? (progress) => {
                      sendOrAbort({
                        type: 'progress',
                        progress: {
                          ...progress,
                          nodes: completedNodes + (progress?.nodes ?? 0),
                          terminalCount: completedTerminals + (progress?.terminalCount ?? 0),
                          shardId: shard.shardId,
                          shardCount: shard.shardCount ?? job.exactShards.length,
                          childWorkerIndex: job.childWorkerIndex ?? 0,
                        },
                      });
                    }
                  : null,
              });
              shardResults.push(shardResult);
              completedNodes += shardResult.nodes ?? 0;
              completedTerminals += shardResult.terminalCount ?? 0;
            }
            result = getExactSearchApi().mergeSearchCoreResults(
              shardResults,
              job.topK,
              { topPathPolicy: job.topPathPolicy ?? null },
            );
          } else {
            result = searchTopLongestPaths(runner, {
              maxDepth: job.maxDepth,
              maxNodes: job.maxNodes,
              targetTerminals: job.targetTerminals,
              maxBeamWidth: job.maxBeamWidth,
              topK: job.topK,
              seed: job.seed,
              exactSingleSearch: job.exactSingleSearch,
              progressEvery: job.progressEvery,
              searchStartedAtMs: job.searchStartedAtMs ?? job.startedAtMs,
              topPathPolicy: job.topPathPolicy ?? null,
              onProgress: ipcConnected
                ? (progress) => {
                    sendOrAbort({
                      type: 'progress',
                      progress,
                    });
                  }
                : null,
            });
          }
          const searchElapsedMs = Number(process.hrtime.bigint() - searchStartNs) / 1e6;
          sendOrAbort({
            type: 'result',
            payload: {
              result,
              searchElapsedMs,
              nativeSnapshotMode: runner.nativeSnapshotMode,
              initialDecisionName: runner.currentDecision?.message?.constructor?.name ?? '终局',
              profileRows: getCoreProfileRows(),
            },
          });
          await cleanupRuntime(runtime, runner);
          runtime = null;
          runner = null;
          process.exit(0);
          return;
        }
        if (message?.type === 'shutdown') {
          await cleanupRuntime(runtime, runner);
          runtime = null;
          runner = null;
          process.exit(0);
        }
      } catch (err) {
        if (!isIpcDisconnectedError(err)) {
          safeSend({ type: 'error', error: err?.message ?? String(err) });
        }
        await cleanupRuntime(runtime, runner);
        process.exit(isIpcDisconnectedError(err) ? 0 : 1);
      }
    });
    return true;
  }

  return {
    runWorkerThread,
    runChildWorkerProcess,
  };
}

module.exports = {
  createWorkerEntryApi,
};
