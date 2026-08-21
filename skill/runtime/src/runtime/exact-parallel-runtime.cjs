'use strict';

function createExactParallelRuntimeApi(deps) {
  const {
    console,
    os,
    process,
    fork,
    Worker,
    childEntryFile,
    LOCATION_DECK,
    LOCATION_HAND,
    createSearchContext,
    cleanupRuntime,
    getExactSearchApi,
    searchTopLongestPaths,
    getCoreProfileRows,
    mergeProfileRows,
    clearCoreProfileStats,
    runSingleSearchJob,
  } = deps;
  const PARALLEL_EXACT_RESUME_VERSION = 1;
  const DEFAULT_PARALLEL_EXACT_WORKER_NODE_GRANT_MAX = 1000000;
  const PARALLEL_EXACT_WORKER_NODE_GRANT_MAX = (() => {
    const raw = Number(
      process.env.COMBO_PARALLEL_EXACT_WORKER_NODE_GRANT_MAX ??
        DEFAULT_PARALLEL_EXACT_WORKER_NODE_GRANT_MAX,
    );
    return Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : DEFAULT_PARALLEL_EXACT_WORKER_NODE_GRANT_MAX;
  })();

  function getParallelExactWorkerTransport() {
    const mode = String(process.env.COMBO_PARALLEL_EXACT_WORKER_TRANSPORT ?? 'process').trim().toLowerCase();
    if (['thread', 'threads', 'worker-thread', 'worker_threads'].includes(mode) && typeof Worker === 'function') {
      return 'thread';
    }
    return 'process';
  }

  function createWorkerThreadTransport(workerScript, workerData) {
    const thread = new Worker(workerScript, {
      workerData,
      resourceLimits: {
        maxOldGenerationSizeMb: 4096,
      },
    });
    const transport = {
      pid: thread.threadId,
      killed: false,
      exitCode: null,
      send(message) {
        thread.postMessage(message);
        return true;
      },
      on(event, listener) {
        thread.on(event, listener);
        return this;
      },
      once(event, listener) {
        thread.once(event, listener);
        return this;
      },
      off(event, listener) {
        thread.off(event, listener);
        return this;
      },
      kill() {
        this.killed = true;
        thread.terminate().catch(() => {});
      },
    };
    thread.once('exit', (code) => {
      transport.exitCode = code;
    });
    return transport;
  }

  function cloneJsonValue(value) {
    if (value === undefined) return undefined;
    if (value === null) return null;
    return JSON.parse(JSON.stringify(value));
  }

  function isParallelExactResumeState(payload) {
    return !!payload &&
      typeof payload === 'object' &&
      payload.resumeKind === 'parallel-exact' &&
      (payload.resumeVersion ?? 0) === PARALLEL_EXACT_RESUME_VERSION;
  }

  function cloneParallelShardState(shard) {
    if (!shard || typeof shard !== 'object') return null;
    return {
      shardId: shard.shardId ?? null,
      shardCount: shard.shardCount ?? 1,
      splitDepth: shard.splitDepth ?? 0,
      actionCount: shard.actionCount ?? 0,
      resumeState: cloneJsonValue(shard.resumeState) ?? null,
    };
  }

  function cloneParallelCompletedResult(exactApi, entry) {
    if (!entry || typeof entry !== 'object') return null;
    return {
      shardId: entry.shardId ?? null,
      shardCount: entry.shardCount ?? 1,
      searchElapsedMs: entry.searchElapsedMs ?? 0,
      result: entry.result ? exactApi.cloneSearchCoreResult(entry.result) : null,
      profileRows: Array.isArray(entry.profileRows) ? cloneJsonValue(entry.profileRows) : [],
    };
  }

  function makeParallelShardKey(entry) {
    return entry?.shardId == null ? '' : `${entry.shardId}/${entry.shardCount ?? 1}`;
  }

  function readExactResumeBest(exactApi, resumeState) {
    const decoded = exactApi.deserializeExactSearchResumeState(resumeState);
    return decoded?.best ? exactApi.cloneSearchCoreResult(decoded.best) : null;
  }

  function readDecodedExactResumeState(exactApi, resumeState) {
    return exactApi.deserializeExactSearchResumeState(resumeState) ?? null;
  }

  function countResumeRemainingActions(decodedResumeState) {
    return (decodedResumeState?.stack ?? []).reduce((sum, frame) => {
      const actions = Array.isArray(frame?.actions) ? frame.actions : [];
      const nextIndex = Math.max(0, Number(frame?.nextIndex ?? 0) | 0);
      return sum + Math.max(0, actions.length - nextIndex);
    }, 0);
  }

  function hasRunnableResumeFrontier(exactApi, resumeState) {
    const decoded = readDecodedExactResumeState(exactApi, resumeState);
    return countResumeRemainingActions(decoded) > 0;
  }

  function hasSearchCorePayload(result) {
    return !!result && (
      (result.nodes ?? 0) > 0 ||
      (result.terminalCount ?? 0) > 0 ||
      (Array.isArray(result.topPaths) && result.topPaths.length > 0)
    );
  }

  function completedResultFromPendingShard(exactApi, shard) {
    const best = readExactResumeBest(exactApi, shard?.resumeState);
    if (!hasSearchCorePayload(best)) return null;
    best.completed = true;
    best.stopReason = 'DONE';
    return {
      shardId: shard?.shardId ?? null,
      shardCount: shard?.shardCount ?? 1,
      searchElapsedMs: 0,
      result: best,
      profileRows: [],
    };
  }

  function normalizeParallelResumeFragments(exactApi, completedResults, pendingShards) {
    const clonedCompleted = Array.isArray(completedResults)
      ? completedResults.map((entry) => cloneParallelCompletedResult(exactApi, entry)).filter(Boolean)
      : [];
    const normalizedPending = [];
    for (const shard of pendingShards ?? []) {
      const cloned = cloneParallelShardState(shard);
      if (!cloned?.resumeState) continue;
      if (hasRunnableResumeFrontier(exactApi, cloned.resumeState)) {
        normalizedPending.push(cloned);
        continue;
      }
      const completed = completedResultFromPendingShard(exactApi, cloned);
      if (completed) clonedCompleted.push(completed);
    }
    return {
      completedResults: clonedCompleted,
      pendingShards: normalizedPending,
    };
  }

  function readSearchCoreCounts(result) {
    return {
      nodes: result?.nodes ?? 0,
      terminalCount: result?.terminalCount ?? 0,
    };
  }

  function readShardResumeProgress(exactApi, shard) {
    return readSearchCoreCounts(readExactResumeBest(exactApi, shard?.resumeState));
  }

  function readShardResumeDepth(exactApi, shard) {
    const decoded = readDecodedExactResumeState(exactApi, shard?.resumeState);
    if (!decoded) return 0;
    if (Array.isArray(decoded.stack) && decoded.stack.length > 0) {
      const top = decoded.stack[decoded.stack.length - 1];
      if (Number.isFinite(top?.depth)) return Number(top.depth);
      const baseDepth = Array.isArray(top?.baseState?.history) ? top.baseState.history.length : 0;
      if (baseDepth > 0) return baseDepth;
    }
    if (Array.isArray(decoded.chain) && decoded.chain.length > 0) return decoded.chain.length;
    return Array.isArray(decoded.rootState?.history) ? decoded.rootState.history.length : 0;
  }

  function buildCompletedPartialResult(exactApi, result) {
    if (!result || typeof result !== 'object') return null;
    const cloned = exactApi.cloneSearchCoreResult(result);
    cloned.completed = true;
    cloned.stopReason = 'DONE';
    return cloned;
  }

  function splitPendingShardFrontier(exactApi, shard, targetCount) {
    const cloned = cloneParallelShardState(shard);
    if (!cloned?.resumeState) return [];
    const resumeStates = typeof exactApi.splitExactResumeStateFrontier === 'function'
      ? exactApi.splitExactResumeStateFrontier(cloned.resumeState, targetCount)
      : [cloned.resumeState];
    return resumeStates
      .map((resumeState) => ({
        ...cloned,
        actionCount: readDecodedExactResumeState(exactApi, resumeState)?.stack?.[0]?.actions?.length ?? cloned.actionCount,
        resumeState,
      }))
      .filter((item) => item.resumeState && hasRunnableResumeFrontier(exactApi, item.resumeState));
  }

  function prioritizePendingShards(exactApi, shards) {
    return (shards ?? [])
      .map((entry) => cloneParallelShardState(entry))
      .filter((entry) => entry && hasRunnableResumeFrontier(exactApi, entry.resumeState))
      .sort((a, b) => {
        const aProgress = readShardResumeProgress(exactApi, a);
        const bProgress = readShardResumeProgress(exactApi, b);
        const aDepth = readShardResumeDepth(exactApi, a);
        const bDepth = readShardResumeDepth(exactApi, b);
        return (
          (bProgress.nodes - aProgress.nodes) ||
          (bProgress.terminalCount - aProgress.terminalCount) ||
          (bDepth - aDepth) ||
          ((a.shardId ?? 0) - (b.shardId ?? 0))
        );
      });
  }

  function sumShardResumeProgress(exactApi, shards) {
    return (shards ?? []).reduce((summary, shard) => {
      const counts = readShardResumeProgress(exactApi, shard);
      summary.nodes += counts.nodes;
      summary.terminalCount += counts.terminalCount;
      return summary;
    }, { nodes: 0, terminalCount: 0 });
  }

  function serializeParallelExactResumeState(exactApi, payload, topK, options = {}) {
    if (!payload || typeof payload !== 'object') return null;
    const mergePolicy =
      options && typeof options === 'object' && options.topPathPolicy && typeof options.topPathPolicy === 'object'
        ? { topPathPolicy: options.topPathPolicy }
        : undefined;
    const seedResult = exactApi.cloneSearchCoreResult(payload.seedResult ?? null);
    const normalized = normalizeParallelResumeFragments(
      exactApi,
      payload.completedResults,
      payload.pendingShards,
    );
    const completedResults = normalized.completedResults;
    const pendingShards = normalized.pendingShards;
    const partialResults = [
      seedResult,
      ...completedResults.map((entry) => entry.result).filter(Boolean),
      ...pendingShards.map((entry) => readExactResumeBest(exactApi, entry.resumeState)).filter(Boolean),
    ].filter(Boolean);
    const best = partialResults.length > 0
      ? exactApi.mergeSearchCoreResults(partialResults, topK, mergePolicy)
      : exactApi.cloneSearchCoreResult(seedResult);
    if (pendingShards.length > 0) {
      best.completed = false;
      best.stopReason = 'CHECKPOINT';
    }
    return {
      resumeKind: 'parallel-exact',
      resumeVersion: PARALLEL_EXACT_RESUME_VERSION,
      seedResult,
      completedResults,
      pendingShards,
      best,
    };
  }

  function getAvailableWorkerCount(requestedWorkers = 1) {
    const cpuCap =
      typeof os.availableParallelism === 'function'
        ? os.availableParallelism()
        : Math.max(1, os.cpus().length);
    return Math.max(1, Math.min(Math.max(1, requestedWorkers | 0), cpuCap));
  }

  function shouldUseParallelExactSearch(job) {
    const resumeState = job?.resumeState;
    const isParallelResume = isParallelExactResumeState(resumeState);
    return !!job?.exactSingleSearch &&
      job?.engineBackend !== 'native' &&
      job?.exactSearchBackend === 'parallel-js' &&
      Math.max(1, job?.workers | 0) > 1 &&
      (!resumeState || isParallelResume) &&
      !Array.isArray(job?.exactShards) &&
      !(job?.targetTerminals > 0);
  }

  function splitExactShardsAcrossWorkers(shards, workerCount) {
    const groups = Array.from({ length: Math.max(1, workerCount | 0) }, () => []);
    (shards ?? []).forEach((shard, index) => {
      groups[index % groups.length].push(shard);
    });
    return groups.filter((group) => group.length > 0);
  }

  function computeWorkerCheckpointEvery(globalCheckpointEvery, activeWorkerCount) {
    const normalizedGlobal = Math.max(1, globalCheckpointEvery | 0);
    const envOverride = Number(process.env.COMBO_PARALLEL_EXACT_WORKER_CHECKPOINT_NODES ?? 0);
    if (Number.isFinite(envOverride) && envOverride > 0) {
      return Math.max(1, Math.floor(envOverride));
    }
    const normalizedWorkers = Math.max(1, activeWorkerCount | 0);
    return Math.max(1, Math.floor(normalizedGlobal / normalizedWorkers));
  }

  function createBaseAwareProgressEmitter(job, baseProgress, workerCount, shardCount) {
    if (typeof job?.onProgress !== 'function') return null;
    const progressBase = baseProgress && typeof baseProgress === 'object'
      ? baseProgress
      : { nodes: 0, terminalCount: 0 };
    return (progress = {}, done = false) => {
      job.onProgress({
        ...progress,
        nodes: (progressBase.nodes ?? 0) + (progress?.nodes ?? 0),
        maxNodes: job.maxNodes,
        terminalCount: (progressBase.terminalCount ?? 0) + (progress?.terminalCount ?? 0),
        done,
        parallel: true,
        workerCount,
        shardCount,
      });
    };
  }

  function computeWorkerNodeGrant(remainingNodes, activeWorkerCount) {
    if (!Number.isFinite(remainingNodes) || remainingNodes <= 0) return 0;
    const normalizedRemaining = Math.max(0, Math.floor(remainingNodes));
    if (normalizedRemaining <= 0) return 0;
    const applyGrantCap = (grant) =>
      PARALLEL_EXACT_WORKER_NODE_GRANT_MAX > 0
        ? Math.min(grant, PARALLEL_EXACT_WORKER_NODE_GRANT_MAX)
        : grant;
    const normalizedWorkers = Math.max(1, activeWorkerCount | 0);
    if (normalizedWorkers <= 1) return applyGrantCap(normalizedRemaining);
    const grant = Math.max(
      1,
      Math.min(
        normalizedRemaining,
        Math.max(64, Math.floor(normalizedRemaining / Math.max(1, normalizedWorkers * 2))),
      ),
    );
    return applyGrantCap(grant);
  }

  function resolveParallelSeedNodeBudget(maxNodes) {
    const raw = Number(process.env.COMBO_PARALLEL_EXACT_SEED_NODE_BUDGET ?? 0);
    if (Number.isFinite(raw) && raw > 0) {
      return Math.max(1, Math.min(Math.max(1, maxNodes), Math.floor(raw)));
    }
    return Math.min(
      Math.max(1, maxNodes),
      Math.max(4096, Math.min(16384, Math.floor(maxNodes / 4))),
    );
  }

  async function runParallelExactSearch(job) {
    // Web/并行入口默认开启 topPath 收集策略:score>0 才入选,同 (score, terminalDepth) 最多 5 条。
    // 调用方可以显式传 job.topPathPolicy 来覆盖,传 null/false 关闭。
    const effectiveTopPathPolicy = (() => {
      if (job && Object.prototype.hasOwnProperty.call(job, 'topPathPolicy')) {
        return job.topPathPolicy ?? null;
      }
      return { minScoreExclusive: 0, diversityCap: 5 };
    })();
    // 注回 job 以便 slimJob 透传到 worker
    if (job && typeof job === 'object') {
      if (!Object.prototype.hasOwnProperty.call(job, 'topPathPolicy')) {
        job.topPathPolicy = effectiveTopPathPolicy;
      }
    }
    const emitParallelDiagnostics =
      job?.parallelDiagnostics === true ||
      process.env.COMBO_PARALLEL_EXACT_DIAG === '1';
    const logParallelDiagnostic = (event, detail = {}) => {
      if (!emitParallelDiagnostics) return;
      try {
        console.error('[parallel-exact-debug]', event, JSON.stringify(detail));
      } catch {
        console.error('[parallel-exact-debug]', event);
      }
    };
    const workerCount = getAvailableWorkerCount(job.workers);
    const exactApi = getExactSearchApi();
    const parallelResumeState = isParallelExactResumeState(job?.resumeState) ? job.resumeState : null;
    let runtime = null;
    let runner = null;
    const workers = [];
    try {
      ({ runtime, runner } = await createSearchContext({
        ...job,
        exactSearchBackend: 'js',
        workers: 1,
      }));
      const initialPlayerHand = typeof runner?.queryCodes === 'function'
        ? runner.queryCodes(0, LOCATION_HAND).slice()
        : null;
      const initialOpponentHand = typeof runner?.queryCodes === 'function'
        ? runner.queryCodes(1, LOCATION_HAND).slice()
        : null;
      if (typeof job.onReady === 'function') {
        job.onReady({
          runner,
          runtime,
          initialPlayerHand,
          initialOpponentHand,
        });
      }
      if (job.verbose && typeof runner?.queryCodes === 'function') {
        console.log('\nRoot Deck Diagnostic:');
        console.log(
          JSON.stringify(
            {
              p0DeckTop10: runner.queryCodes(0, LOCATION_DECK).slice(0, 10),
              p0DeckLast10: runner.queryCodes(0, LOCATION_DECK).slice(-10),
              p0Hand: runner.queryCodes(0, LOCATION_HAND),
            },
            null,
            2,
          ),
        );
      }

      clearCoreProfileStats();
      const searchStartNs = process.hrtime.bigint();
      let targetShardCount = 0;
      let maxSplitDepth = 0;
      let seedNodeBudget = 0;
      let plan;
      let planningProfileRows = [];
      const normalizedResumeFragments = normalizeParallelResumeFragments(
        exactApi,
        parallelResumeState?.completedResults,
        parallelResumeState?.pendingShards,
      );
      const resumedCompletedResults = normalizedResumeFragments.completedResults;
      if (parallelResumeState) {
        plan = {
          seedResult: exactApi.cloneSearchCoreResult(parallelResumeState.seedResult ?? null),
          shards: prioritizePendingShards(exactApi, normalizedResumeFragments.pendingShards),
        };
      } else {
        targetShardCount = Math.min(128, Math.max(workerCount * 12, 24));
        maxSplitDepth = 16;
        seedNodeBudget = resolveParallelSeedNodeBudget(job.maxNodes);
        plan = exactApi.planExactSearchShards(runner, {
          maxDepth: job.maxDepth,
          maxNodes: job.maxNodes,
          topK: job.topK,
          targetShardCount,
          maxSplitDepth,
          seedNodeBudget,
          searchStartedAtMs: job.searchStartedAtMs ?? job.startedAtMs,
          recordIntermediateScoredStates: Array.isArray(job.scoringRules) && job.scoringRules.length > 0,
          topPathPolicy: effectiveTopPathPolicy,
        });
        planningProfileRows = getCoreProfileRows();
      }
      const resumedCompletedProgress = resumedCompletedResults.reduce((summary, entry) => {
        const counts = readSearchCoreCounts(entry.result);
        summary.nodes += counts.nodes;
        summary.terminalCount += counts.terminalCount;
        return summary;
      }, { nodes: 0, terminalCount: 0 });
      const pendingShardBaseProgress = sumShardResumeProgress(exactApi, plan.shards);
      const checkpointEvery = Math.max(1, job?.checkpointEvery ?? 100000);
      const progressBase = {
        nodes: (plan.seedResult?.nodes ?? 0) + resumedCompletedProgress.nodes + pendingShardBaseProgress.nodes,
        terminalCount:
          (plan.seedResult?.terminalCount ?? 0) +
          resumedCompletedProgress.terminalCount +
          pendingShardBaseProgress.terminalCount,
      };
      if (progressBase.nodes > job.maxNodes) {
        throw new Error(`parallel exact confirmed nodes exceed maxNodes before dispatch: ${progressBase.nodes}/${job.maxNodes}`);
      }
      const emitParallelProgress = createBaseAwareProgressEmitter(
        job,
        progressBase,
        workerCount,
        plan.shards.length,
      );
      // 存档判定:仅依赖时间(每 10 分钟一次),不再考察节点数。
      const PARALLEL_CHECKPOINT_INTERVAL_MS = 10 * 60 * 1000;
      let lastCheckpointTimeNs = process.hrtime.bigint();
      let checkpointWriteCount = 0;
      // 上一次落盘窗口的 baseline,用于诊断本窗口期实际"完结"了多少 shard / 多少节点。
      // 如果一段时间内 progressBase / completedTotal 完全不增长,说明 worker 全卡在巨型 shard 里。
      let lastCheckpointProgressBaseNodes = progressBase.nodes;
      let lastCheckpointCompletedTotal = resumedCompletedResults.length;
      const emitAggregatedProgress = (workerStates = [], done = false) => {
        if (!emitParallelProgress) return;
        let nodes = 0;
        let terminalCount = 0;
        let currentDepth = 0;
        for (const state of workerStates) {
          nodes += state.currentConsumedNodes ?? 0;
          terminalCount += state.currentConsumedTerminals ?? 0;
          currentDepth = Math.max(currentDepth, state.currentDepth ?? 0);
        }
        emitParallelProgress({ nodes, terminalCount, currentDepth }, done);
      };
      const buildPendingShardsFromWorkers = (workerStates, shardQueue) => {
        const pending = (shardQueue ?? []).map((entry) => cloneParallelShardState(entry)).filter(Boolean);
        for (const state of workerStates) {
          if (!state.activeShard) continue;
          pending.push({
            shardId: state.activeShard.shardId ?? null,
            shardCount: state.activeShard.shardCount ?? 1,
            splitDepth: state.activeShard.splitDepth ?? 0,
            actionCount: state.activeShard.actionCount ?? 0,
            resumeState: cloneJsonValue(state.activeCheckpointResumeState ?? state.activeShard.resumeState) ?? null,
          });
        }
        return prioritizePendingShards(exactApi, pending);
      };
      const collectCompletedResults = (workerStates) => [
        ...resumedCompletedResults.map((entry) => cloneParallelCompletedResult(exactApi, entry)),
        ...workerStates.flatMap((state) => state.results.map((entry) => cloneParallelCompletedResult(exactApi, entry))),
      ].filter(Boolean);
      const maybeEmitParallelCheckpoint = (workerStates, shardQueue, force = false) => {
        if (typeof job?.onCheckpoint !== 'function') return;
        const timeSinceLastCheckpointMs = Number(process.hrtime.bigint() - lastCheckpointTimeNs) / 1e6;
        // 唯一判定:强制 OR 距上次写入已超过固定时间窗。节点数完全不参与判定。
        const shouldCheckpoint = force || timeSinceLastCheckpointMs >= PARALLEL_CHECKPOINT_INTERVAL_MS;
        if (!shouldCheckpoint) return;
        const completedResults = collectCompletedResults(workerStates);
        const pendingShards = buildPendingShardsFromWorkers(workerStates, shardQueue);
        const pendingFromActive = workerStates.filter((s) => s.activeShard).length;
        const pendingFromQueue = (shardQueue ?? []).length;
        const completedFromResumed = resumedCompletedResults.length;
        const completedFromWorkers = workerStates.reduce((sum, s) => sum + s.results.length, 0);
        const persistedBest = serializeParallelExactResumeState(exactApi, {
          seedResult: plan.seedResult,
          completedResults,
          pendingShards,
        }, job.topK, { topPathPolicy: effectiveTopPathPolicy });
        const checkpointNodes = persistedBest?.best?.nodes ?? 0;
        const checkpointTerminals = persistedBest?.best?.terminalCount ?? 0;
        const triggerReason = force ? 'force' : 'time';
        const nextCount = checkpointWriteCount + 1;
        const inFlightNodes = workerStates.reduce(
          (sum, s) => sum + (s?.currentConsumedNodes ?? 0),
          0,
        );
        const totalNodesNow = progressBase.nodes + inFlightNodes;
        const completedTotalNow = completedFromResumed + completedFromWorkers;
        // 诊断:本窗口期实际"完结"了多少。若两个值长时间为 0,说明所有 worker 卡在大 shard 内部、
        // archive 写入的内容只是 shard 起点 + 中途 resumeState,真实推进未被合并到 progressBase。
        const shardsCompletedThisWindow = completedTotalNow - lastCheckpointCompletedTotal;
        const progressBaseDeltaThisWindow = progressBase.nodes - lastCheckpointProgressBaseNodes;
        console.error(JSON.stringify({
          ts: new Date().toISOString(),
          src: 'parallel-exact-checkpoint',
          event: 'emit',
          triggerReason,
          writeIndex: nextCount,
          timeSinceLastMs: Math.round(timeSinceLastCheckpointMs),
          // checkpointNodes:写入 archive 的"已完结合并值",仅含已结束 shard。
          // archiveNodes:本次实际上报给 onCheckpoint 的进度数(= totalNodesNow,与 UI 实时一致)。
          checkpointNodes,
          archiveNodes: totalNodesNow,
          checkpointTerminals,
          progressBaseNodes: progressBase.nodes,
          inFlightNodes,
          totalNodesNow,
          shardsCompletedThisWindow,
          progressBaseDeltaThisWindow,
          completedTotal: completedTotalNow,
          pendingTotal: pendingFromActive + pendingFromQueue,
          activeWorkers: pendingFromActive,
          queueShards: pendingFromQueue,
          workerStates: workerStates.map((s) => ({
            idx: s.workerIndex,
            activeShard: !!s.activeShard,
            shardId: s.activeShardId ?? null,
            consumed: s.currentConsumedNodes ?? 0,
            grant: s.currentGrant ?? 0,
            results: s.results.length,
            idle: !!s.idle,
            settled: !!s.settled,
          })),
        }));
        lastCheckpointTimeNs = process.hrtime.bigint();
        lastCheckpointProgressBaseNodes = progressBase.nodes;
        lastCheckpointCompletedTotal = completedTotalNow;
        checkpointWriteCount += 1;
        // 上报给上层(写 archive)的 nodes 必须使用 resumeState 内真实可恢复的节点数。
        // totalNodesNow 只是实时观测进度,含 worker 尚未产出 sub-resumeState 的 in-flight 节点;
        // 若用 totalNodesNow 写盘,加载时会出现 "UI 显示水位 > 实际可恢复 best.nodes" 的不一致。
        job.onCheckpoint({
          nodes: checkpointNodes,
          terminalCount: checkpointTerminals,
          resumeState: persistedBest,
        });
      };

      if (plan.shards.length === 0) {
        emitAggregatedProgress([], true);
        return {
          workerCount: 0,
          shardCount: 0,
          searchElapsedMs: Number(process.hrtime.bigint() - searchStartNs) / 1e6,
          result: exactApi.mergeSearchCoreResults(
            [
              plan.seedResult,
              ...resumedCompletedResults.map((entry) => entry.result).filter(Boolean),
            ],
            job.topK,
            { topPathPolicy: effectiveTopPathPolicy },
          ),
          initialPlayerHand,
          initialOpponentHand,
          nativeSnapshotMode: runner.nativeSnapshotMode,
          initialDecisionName: runner.currentDecision?.message?.constructor?.name ?? '终局',
          profileRows: planningProfileRows,
        };
      }

      if (progressBase.nodes >= job.maxNodes) {
        const exhaustedState = serializeParallelExactResumeState(exactApi, {
          seedResult: plan.seedResult,
          completedResults: resumedCompletedResults,
          pendingShards: plan.shards,
        }, job.topK, { topPathPolicy: effectiveTopPathPolicy });
        const exhaustedResult = exactApi.cloneSearchCoreResult(exhaustedState?.best);
        exhaustedResult.completed = false;
        exhaustedResult.stopReason = 'MAX_NODES';
        exhaustedResult.resumeState = exhaustedState;
        emitAggregatedProgress([], true);
        return {
          workerCount: 0,
          shardCount: plan.shards.length,
          searchElapsedMs: Number(process.hrtime.bigint() - searchStartNs) / 1e6,
          result: exhaustedResult,
          initialPlayerHand,
          initialOpponentHand,
          nativeSnapshotMode: runner.nativeSnapshotMode,
          initialDecisionName: runner.currentDecision?.message?.constructor?.name ?? '终局',
          profileRows: planningProfileRows,
        };
      }

      if (plan.shards.length === 1) {
        clearCoreProfileStats();
        const shardBaseProgress = readShardResumeProgress(exactApi, plan.shards[0]);
        const localProgressBase = {
          nodes: progressBase.nodes - shardBaseProgress.nodes,
          terminalCount: progressBase.terminalCount - shardBaseProgress.terminalCount,
        };
        const emitLocalProgress = createBaseAwareProgressEmitter(job, localProgressBase, 1, 1);
        const localResult = searchTopLongestPaths(runner, {
          maxDepth: job.maxDepth,
          maxNodes: job.maxNodes,
          nodeBudget: Math.max(0, job.maxNodes - progressBase.nodes),
          targetTerminals: job.targetTerminals,
          maxBeamWidth: job.maxBeamWidth,
          topK: job.topK,
          seed: job.seed,
          exactSingleSearch: job.exactSingleSearch,
          progressEvery: job.progressEvery,
          resumeState: plan.shards[0].resumeState,
          searchStartedAtMs: job.searchStartedAtMs ?? job.startedAtMs,
          recordIntermediateScoredStates: Array.isArray(job.scoringRules) && job.scoringRules.length > 0,
          topPathPolicy: effectiveTopPathPolicy,
          onProgress: emitLocalProgress
            ? (progress) => {
                emitLocalProgress({
                  nodes: Math.max(0, (progress?.nodes ?? shardBaseProgress.nodes) - shardBaseProgress.nodes),
                  terminalCount: Math.max(
                    0,
                    (progress?.terminalCount ?? shardBaseProgress.terminalCount) - shardBaseProgress.terminalCount,
                  ),
                  currentDepth: progress?.currentDepth ?? 0,
                }, !!progress?.done);
              }
            : null,
          onCheckpoint: typeof job?.onCheckpoint === 'function'
            ? (checkpoint) => {
                job.onCheckpoint({
                  nodes: localProgressBase.nodes + Math.max(0, (checkpoint?.nodes ?? shardBaseProgress.nodes) - shardBaseProgress.nodes),
                  terminalCount:
                    localProgressBase.terminalCount +
                    Math.max(
                      0,
                      (checkpoint?.terminalCount ?? shardBaseProgress.terminalCount) - shardBaseProgress.terminalCount,
                    ),
                  resumeState: serializeParallelExactResumeState(exactApi, {
                    seedResult: plan.seedResult,
                    completedResults: resumedCompletedResults,
                    pendingShards: [{
                      ...cloneParallelShardState(plan.shards[0]),
                      resumeState: cloneJsonValue(checkpoint?.resumeState) ?? null,
                    }],
                  }, job.topK, { topPathPolicy: effectiveTopPathPolicy }),
                });
              }
            : null,
          checkpointEvery,
        });
        const localProfileRows = getCoreProfileRows();
        emitLocalProgress?.({
          nodes: Math.max(0, (localResult.nodes ?? shardBaseProgress.nodes) - shardBaseProgress.nodes),
          terminalCount: Math.max(
            0,
            (localResult.terminalCount ?? shardBaseProgress.terminalCount) - shardBaseProgress.terminalCount,
          ),
          currentDepth: localResult.topPaths?.[0]?.depth ?? 0,
        }, true);
        const mergedLocalResult = exactApi.mergeSearchCoreResults(
          [
            plan.seedResult,
            ...resumedCompletedResults.map((entry) => entry.result).filter(Boolean),
            localResult,
          ],
          job.topK,
          { topPathPolicy: effectiveTopPathPolicy },
        );
        if (localResult?.completed === false && localResult.resumeState) {
          const localPersistedState = serializeParallelExactResumeState(exactApi, {
            seedResult: plan.seedResult,
            completedResults: resumedCompletedResults,
            pendingShards: [{
              ...cloneParallelShardState(plan.shards[0]),
              resumeState: cloneJsonValue(localResult.resumeState) ?? null,
            }],
          }, job.topK, { topPathPolicy: effectiveTopPathPolicy });
          mergedLocalResult.completed = false;
          mergedLocalResult.stopReason = localResult.stopReason ?? 'MAX_NODES';
          mergedLocalResult.resumeState = localPersistedState;
        }
        return {
          workerCount: 1,
          shardCount: 1,
          searchElapsedMs: Number(process.hrtime.bigint() - searchStartNs) / 1e6,
          result: mergedLocalResult,
          initialPlayerHand,
          initialOpponentHand,
          nativeSnapshotMode: runner.nativeSnapshotMode,
          initialDecisionName: runner.currentDecision?.message?.constructor?.name ?? '终局',
          profileRows: mergeProfileRows([...planningProfileRows, ...localProfileRows]),
        };
      }

      const shardQueue = plan.shards.map((shard) => ({
        ...shard,
        shardCount: plan.shards.length,
      }));
      const activeWorkerCount = Math.min(workerCount, shardQueue.length);
      const workerCheckpointEvery = computeWorkerCheckpointEvery(checkpointEvery, activeWorkerCount);
      const initialDecisionName = runner.currentDecision?.message?.constructor?.name ?? '终局';
      const nativeSnapshotMode = runner.nativeSnapshotMode;
      const workerTransport = getParallelExactWorkerTransport();
      await cleanupRuntime(runtime, runner);
      runtime = null;
      runner = null;

      const workerStates = [];
      for (let index = 0; index < activeWorkerCount; index += 1) {
        const child = workerTransport === 'thread'
          ? createWorkerThreadTransport(childEntryFile, { type: 'parallel-exact-worker' })
          : fork(childEntryFile, ['--child-worker'], {
              cwd: process.cwd(),
              env: {
                ...process.env,
                COMBO_SIMULATOR_CHILD: '1',
              },
              // --expose-gc:允许搜索运行时手动触发 gc 释放积压。
              // --max-old-space-size=4096:把 V8 老生代上限从默认 ~2 GB 提到 4 GB,
              // 兜底"resumeState 序列化峰值 + 状态栈占用"撞 2 GB 红线的崩溃。详见 2026-05-05 崩溃日志。
              execArgv: ['--expose-gc', '--max-old-space-size=4096'],
              silent: false,
              stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
            });
        child.on('exit', (code, signal) => {
          const state = workerStates[index] ?? null;
          logParallelDiagnostic('child-exit', {
            transport: workerTransport,
            workerIndex: index,
            pid: child.pid ?? null,
            code,
            signal,
            settled: !!state?.settled,
            idle: !!state?.idle,
            activeShardId: state?.activeShardId ?? null,
            currentGrant: state?.currentGrant ?? 0,
            currentConsumedNodes: state?.currentConsumedNodes ?? 0,
            currentConsumedTerminals: state?.currentConsumedTerminals ?? 0,
          });
        });
        child.on('disconnect', () => {
          const state = workerStates[index] ?? null;
          logParallelDiagnostic('child-disconnect', {
            transport: workerTransport,
            workerIndex: index,
            pid: child.pid ?? null,
            settled: !!state?.settled,
            activeShardId: state?.activeShardId ?? null,
          });
        });
        workerStates.push({
          workerIndex: index,
          shardIds: [],
          totalConsumedNodes: 0,
          totalConsumedTerminals: 0,
          currentConsumedNodes: 0,
          currentConsumedTerminals: 0,
          currentDepth: 0,
          currentGrant: 0,
          activeBaseNodes: 0,
          activeBaseTerminals: 0,
          totalSearchElapsedMs: 0,
          results: [],
          activeShard: null,
          activeCheckpointResumeState: null,
          idle: false,
          finishWorker: null,
          settled: false,
        });
        // child.send 会用 IPC JSON 序列化, 单条消息超过 V8 字符串上限 (0x1fffffe8 ≈ 512MB) 会
        // 触发 ERR_STRING_TOO_LONG 父端 parseChannelMessages 崩溃。深度 174、节点 38M+ 的 resumeState
        // 含 162 个 pendingShards × frame stack, 体积可超过这个上限。child worker init 只需要
        // deck / 资源 / 搜索配置, 不需要 parallel resume state, 在这里把它剥离。
        const {
          resumeState: _initStripResumeState,
          exactShards: _initStripExactShards,
          onProgress: _initStripOnProgress,
          onCheckpoint: _initStripOnCheckpoint,
          ...slimJob
        } = job;
        child.send({
          type: 'init',
          job: {
            ...slimJob,
            exactSearchBackend: 'js',
            workers: 1,
            checkpointEvery: workerCheckpointEvery,
            childWorkerIndex: index,
            seedResultNodesBase: plan.seedResult.nodes ?? 0,
            seedResultTerminalBase: plan.seedResult.terminalCount ?? 0,
          },
        });
        logParallelDiagnostic('child-init-sent', {
          transport: workerTransport,
          workerIndex: index,
          pid: child.pid ?? null,
        });
        workers.push(child);
      }

      await Promise.all(workers.map((worker, index) => new Promise((resolve, reject) => {
        const onMessage = (message) => {
          if (message?.type !== 'ready') return;
          worker.off('message', onMessage);
          resolve();
        };
        worker.on('message', onMessage);
        worker.once('error', reject);
        worker.once('exit', (code, signal) => {
          reject(new Error(`parallel exact worker ${index} exited before ready (code=${code}, signal=${signal ?? 'none'})`));
        });
      })));

      const computeRemainingGrantBudget = () =>
        Math.max(
          0,
          job.maxNodes -
            progressBase.nodes -
            workerStates.reduce((sum, state) => sum + (state.currentGrant ?? 0), 0),
        );
      const countDispatchableWorkers = () =>
        Math.max(1, workerStates.reduce((sum, state) => sum + (state.settled ? 0 : 1), 0));
      const hasActiveWorkerGrant = () =>
        workerStates.some((state) => !state.settled && (state.currentGrant ?? 0) > 0);
      const assertSliceConsumptionWithinGrant = (state, consumedNodes, phase) => {
        if ((state.currentGrant ?? 0) <= 0) {
          throw new Error(`parallel exact worker ${state.workerIndex} reported ${phase} without an active grant`);
        }
        if (consumedNodes > state.currentGrant) {
          throw new Error(
            `parallel exact worker ${state.workerIndex} exceeded node grant: consumed=${consumedNodes} grant=${state.currentGrant} phase=${phase}`,
          );
        }
      };
      const dispatchNextShard = (worker, state) => {
        const remainingGrantBudget = computeRemainingGrantBudget();
        if (shardQueue.length === 0 || remainingGrantBudget <= 0) {
          state.currentConsumedNodes = 0;
          state.currentConsumedTerminals = 0;
          state.currentDepth = 0;
          state.currentGrant = 0;
          state.activeBaseNodes = 0;
          state.activeBaseTerminals = 0;
          state.activeShard = null;
          state.activeCheckpointResumeState = null;
          state.idle = true;
          emitAggregatedProgress(workerStates, false);
          return hasActiveWorkerGrant();
        }
        const shard = cloneParallelShardState(shardQueue.shift());
        const nodeGrant = computeWorkerNodeGrant(remainingGrantBudget, countDispatchableWorkers());
        if (nodeGrant <= 0) {
          state.idle = true;
          emitAggregatedProgress(workerStates, false);
          return hasActiveWorkerGrant();
        }
        const shardBase = readShardResumeProgress(exactApi, shard);
        const shardDepth = readShardResumeDepth(exactApi, shard);
        state.activeShard = cloneParallelShardState(shard);
        state.activeCheckpointResumeState = shard.resumeState ?? null;
        state.activeShardId = shard.shardId;
        state.shardIds.push(shard.shardId);
        state.currentConsumedNodes = 0;
        state.currentConsumedTerminals = 0;
        state.currentDepth = shardDepth;
        state.currentGrant = nodeGrant;
        state.activeBaseNodes = shardBase.nodes;
        state.activeBaseTerminals = shardBase.terminalCount;
        state.idle = false;
        worker.send({
          type: 'run-shard',
          shard,
          nodeBudget: nodeGrant,
        });
        return true;
      };

      const wakeIdleWorkers = () => {
        for (let index = 0; index < workerStates.length; index += 1) {
          const state = workerStates[index];
          if (state.settled || !state.idle) continue;
          const dispatched = dispatchNextShard(workers[index], state);
          if (!dispatched && !hasActiveWorkerGrant()) {
            state.finishWorker?.();
          }
        }
      };

      const settled = await Promise.all(workers.map((worker, index) => new Promise((resolve, reject) => {
        const state = workerStates[index];
        let settledWorker = false;
        const finishWorker = () => {
          if (settledWorker) return;
          settledWorker = true;
          state.settled = true;
          state.idle = false;
          worker.off('message', onMessage);
          resolve(state);
        };
        state.finishWorker = finishWorker;
        const onMessage = (message) => {
          if (message?.type === 'progress') {
            const rawNodes = message.progress?.nodes ?? state.activeBaseNodes;
            const rawTerminals = message.progress?.terminalCount ?? state.activeBaseTerminals;
            const consumedNodes = Math.max(0, rawNodes - state.activeBaseNodes);
            assertSliceConsumptionWithinGrant(state, consumedNodes, 'progress');
            const consumedTerminals = Math.max(0, rawTerminals - state.activeBaseTerminals);
            state.currentConsumedNodes = consumedNodes;
            state.currentConsumedTerminals = consumedTerminals;
            state.currentDepth = message.progress?.currentDepth ?? 0;
            if (consumedNodes === 0 && consumedTerminals === 0) {
              return;
            }
            emitAggregatedProgress(workerStates, false);
            return;
          }
          if (message?.type === 'checkpoint') {
            state.activeCheckpointResumeState = message.checkpoint?.resumeState ?? state.activeCheckpointResumeState;
            maybeEmitParallelCheckpoint(workerStates, shardQueue, false);
            return;
          }
          if (message?.type === 'shard-result') {
            const payload = message.payload ?? {};
            const result = payload.result ? exactApi.cloneSearchCoreResult(payload.result) : null;
            const payloadComplete = payload.complete !== false;
            const resultComplete = result?.completed !== false;
            if (payloadComplete !== resultComplete) {
              throw new Error(
                `parallel exact worker ${state.workerIndex} returned inconsistent completion flags: payload=${payloadComplete} result=${resultComplete}`,
              );
            }
            const consumedNodes = Math.max(0, (result?.nodes ?? state.activeBaseNodes) - state.activeBaseNodes);
            assertSliceConsumptionWithinGrant(state, consumedNodes, 'result');
            const consumedTerminals = Math.max(
              0,
              (result?.terminalCount ?? state.activeBaseTerminals) - state.activeBaseTerminals,
            );
            progressBase.nodes += consumedNodes;
            progressBase.terminalCount += consumedTerminals;
            state.totalSearchElapsedMs += payload.searchElapsedMs ?? 0;
            state.totalConsumedNodes += consumedNodes;
            state.totalConsumedTerminals += consumedTerminals;
            state.currentConsumedNodes = 0;
            state.currentConsumedTerminals = 0;
            state.currentDepth = 0;
            state.currentGrant = 0;
            state.activeBaseNodes = 0;
            state.activeBaseTerminals = 0;
            delete state.activeShardId;
            const finishedShard = cloneParallelShardState(state.activeShard);
            state.activeShard = null;
            state.activeCheckpointResumeState = null;
            if (payloadComplete) {
              state.results.push({
                shardId: finishedShard?.shardId ?? payload.shardId ?? null,
                shardCount: finishedShard?.shardCount ?? payload.shardCount ?? 1,
                result,
                searchElapsedMs: payload.searchElapsedMs ?? 0,
                profileRows: Array.isArray(payload.profileRows) ? cloneJsonValue(payload.profileRows) : [],
              });
            } else {
              const resumeState = payload.resumeState ?? null;
              if (!resumeState) {
                throw new Error(`parallel exact worker ${state.workerIndex} returned an unfinished shard without resumeState`);
              }
              const partialResult = buildCompletedPartialResult(exactApi, result);
              if (partialResult && ((partialResult.nodes ?? 0) > 0 || (partialResult.terminalCount ?? 0) > 0)) {
                state.results.push({
                  shardId: finishedShard?.shardId ?? payload.shardId ?? null,
                  shardCount: finishedShard?.shardCount ?? payload.shardCount ?? 1,
                  result: partialResult,
                  searchElapsedMs: payload.searchElapsedMs ?? 0,
                  profileRows: Array.isArray(payload.profileRows) ? cloneJsonValue(payload.profileRows) : [],
                });
              }
              const splitShards = splitPendingShardFrontier(exactApi, {
                shardId: finishedShard?.shardId ?? null,
                shardCount: finishedShard?.shardCount ?? plan.shards.length,
                splitDepth: finishedShard?.splitDepth ?? 0,
                actionCount: finishedShard?.actionCount ?? 0,
                resumeState,
              }, countDispatchableWorkers());
              shardQueue.push(...(splitShards.length > 0 ? splitShards : [{
                shardId: finishedShard?.shardId ?? null,
                shardCount: finishedShard?.shardCount ?? plan.shards.length,
                splitDepth: finishedShard?.splitDepth ?? 0,
                actionCount: finishedShard?.actionCount ?? 0,
                resumeState,
              }]));
            }
            emitAggregatedProgress(workerStates, false);
            maybeEmitParallelCheckpoint(workerStates, shardQueue, false);
            if (!dispatchNextShard(worker, state)) {
              finishWorker();
            }
            wakeIdleWorkers();
            return;
          }
          if (message?.type === 'error') {
            worker.off('message', onMessage);
            reject(new Error(message.error || 'parallel exact worker failed'));
          }
        };
        worker.on('message', onMessage);
        worker.once('error', reject);
        worker.once('exit', (code, signal) => {
          if (!settledWorker) {
            reject(new Error(`parallel exact worker ${index} exited before shard settled (code=${code}, signal=${signal ?? 'none'})`));
          }
        });
        if (!dispatchNextShard(worker, state)) {
          finishWorker();
        }
      })));

      const finalPendingShards = buildPendingShardsFromWorkers([], shardQueue);
      const finalPersistedState = serializeParallelExactResumeState(exactApi, {
        seedResult: plan.seedResult,
        completedResults: collectCompletedResults(settled),
        pendingShards: finalPendingShards,
      }, job.topK, { topPathPolicy: effectiveTopPathPolicy });
      const finalResult = exactApi.cloneSearchCoreResult(finalPersistedState?.best);
      if (finalPendingShards.length > 0 && progressBase.nodes >= job.maxNodes) {
        finalResult.completed = false;
        finalResult.stopReason = 'MAX_NODES';
      }
      if (finalPendingShards.length > 0 || finalResult?.completed === false) {
        finalResult.resumeState = finalPersistedState;
      }
      emitAggregatedProgress(settled, true);
      const payload = {
        workerCount: activeWorkerCount,
        workerTransport,
        shardCount: plan.shards.length,
        searchElapsedMs: Number(process.hrtime.bigint() - searchStartNs) / 1e6,
        result: finalResult,
        initialPlayerHand,
        initialOpponentHand,
        nativeSnapshotMode,
        initialDecisionName,
        profileRows: mergeProfileRows([
          ...planningProfileRows,
          ...collectCompletedResults(settled).flatMap((entry) => entry?.profileRows ?? []),
        ]),
      };
      if (emitParallelDiagnostics) {
        payload.parallelDiagnostics = {
          targetShardCount,
          maxSplitDepth,
          seedNodeBudget,
          checkpointEvery,
          workerCheckpointEvery,
          workerTransport,
          seedNodes: plan.seedResult.nodes ?? 0,
          seedTerminals: plan.seedResult.terminalCount ?? 0,
          confirmedNodes: progressBase.nodes,
          confirmedTerminals: progressBase.terminalCount,
          pendingShards: finalPendingShards.map((shard) => ({
            shardId: shard.shardId,
            splitDepth: shard.splitDepth,
            actionCount: shard.actionCount,
          })),
          planningProfileRows,
          workers: settled.map((item, index) => ({
            workerIndex: index,
            shardCount: item.shardIds.length,
            shardIds: item.shardIds.slice(),
            searchElapsedMs: item.totalSearchElapsedMs,
            nodes: item.totalConsumedNodes,
            terminalCount: item.totalConsumedTerminals,
            topDepth: exactApi.mergeSearchCoreResults(
              item.results.map((entry) => entry.result),
              job.topK,
            )?.topPaths?.[0]?.depth ?? 0,
          })),
        };
      }
      return payload;
    } finally {
      await cleanupRuntime(runtime, runner);
      await Promise.all(workers.map((worker) => new Promise((resolve) => {
        if (worker.killed || worker.exitCode !== null) {
          resolve();
          return;
        }
        const killTimer = setTimeout(() => {
          try {
            worker.kill();
          } catch {
            resolve();
          }
        }, 1000);
        worker.once('exit', () => {
          clearTimeout(killTimer);
          resolve();
        });
        try {
          worker.send({ type: 'shutdown' });
        } catch {
          clearTimeout(killTimer);
          try {
            worker.kill();
          } finally {
            resolve();
          }
        }
      })));
    }
  }

  return {
    getAvailableWorkerCount,
    shouldUseParallelExactSearch,
    splitExactShardsAcrossWorkers,
    isParallelExactResumeState,
    serializeParallelExactResumeState,
    runParallelExactSearch,
  };
}

module.exports = {
  createExactParallelRuntimeApi,
};
