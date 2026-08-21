'use strict';

function createExactSearchApi(deps) {
  const {
    cloneHistoryState,
    serializeHistoryState,
    deserializeHistoryState,
    serializeDecisionAction,
    deserializeDecisionAction,
    hashPayloadSha256,
    stableStringify,
    DEFAULT_OPTIONS,
    WEB_ARCHIVE_CHECKPOINT_NODES,
    HARD_DISABLE_SELECT_UNSELECT_CANCEL,
    crypto,
    createSearchDebugCollector,
    formatDebugDecision,
    startProfileTimer = () => 0n,
    endProfileTimer = () => {},
  } = deps;

  function sanitizeProfileLabel(value, fallback = 'unknown') {
    const label = String(value || fallback).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80);
    return label.length > 0 ? label : fallback;
  }

  function normalizeExactStateKeyCodes(codes) {
    return Array.isArray(codes) ? codes.map((code) => code >>> 0) : [];
  }

  function normalizeExactStateKeyPlayer(player) {
    return {
      mzone: normalizeExactStateKeyCodes(player?.mzone),
      szone: normalizeExactStateKeyCodes(player?.szone),
      hand: normalizeExactStateKeyCodes(player?.hand),
      grave: normalizeExactStateKeyCodes(player?.grave),
      banished: normalizeExactStateKeyCodes(player?.banished),
      deck: normalizeExactStateKeyCodes(player?.deck),
      extra: normalizeExactStateKeyCodes(player?.extra),
    };
  }

  function buildExactStateKeySnapshotPayload(snapshot, includeLp = true) {
    return {
      lp: includeLp
        ? {
            p0: snapshot?.lp?.p0 ?? 0,
            p1: snapshot?.lp?.p1 ?? 0,
          }
        : null,
      p0: normalizeExactStateKeyPlayer(snapshot?.p0),
      p1: normalizeExactStateKeyPlayer(snapshot?.p1),
    };
  }

  function buildExactStateKeyDecisionPayload(decision) {
    return {
      terminal: !!decision?.terminal,
      reason: decision?.reason ?? null,
      messageName: decision?.message?.constructor?.name ?? null,
      actions: Array.isArray(decision?.actions)
        ? decision.actions.map((action) => serializeDecisionAction(action))
        : [],
    };
  }

  function makeExactStateKey(state, snapshot, decision) {
    return hashPayloadSha256(stableStringify({
      snapshot: buildExactStateKeySnapshotPayload(snapshot, true),
      decision: buildExactStateKeyDecisionPayload(decision),
    }));
  }

  function makeExactStateKeyNoLp(state, snapshot, decision) {
    return hashPayloadSha256(stableStringify({
      snapshot: buildExactStateKeySnapshotPayload(snapshot, false),
      decision: buildExactStateKeyDecisionPayload(decision),
    }));
  }

  function rankActionForLongestPath(action) {
    const base = {
      chain: 8,
      activate: 7,
      spsummon: 6,
      summon: 5,
      option: 4,
      yes: 3,
      attack: 2,
      other: 1,
      fallback: -2,
      phase_end: -8,
    }[action?.kind] ?? 0;

    let score = base;
    if (/^不/.test(action?.label ?? '')) score -= 2;
    if ((action?.text ?? '').length > 0) score += 0.5;
    return score;
  }

  function sortActionsForLongestPath(actions) {
    return [...(actions ?? [])].sort(
      (a, b) =>
        rankActionForLongestPath(b) - rankActionForLongestPath(a) ||
        String(a?.label ?? '').localeCompare(String(b?.label ?? ''), 'zh-Hans-CN'),
    );
  }

  function getSortedSearchActions(decision) {
    return sortActionsForLongestPath(Array.isArray(decision?.actions) ? decision.actions : []);
  }

  function normalizeSearchStopReason(reason, fallback = 'DONE') {
    return typeof reason === 'string' && reason.length > 0 ? reason : fallback;
  }

  function resolveSearchNodeLimit(maxNodes) {
    return Number.isFinite(maxNodes) && maxNodes > 0 ? Number(maxNodes) : Number.POSITIVE_INFINITY;
  }

  function hasReachedSearchNodeLimit(nodes, nodeLimit) {
    return Number.isFinite(nodeLimit) && nodeLimit > 0 && nodes >= nodeLimit;
  }

  function routeFoundSortValue(candidate) {
    const value = Number(candidate?.routeFoundAtMs);
    return Number.isFinite(value) && value > 0 ? value : Number.POSITIVE_INFINITY;
  }

  function compareTopPathCandidates(a, b) {
    const aScore = Number.isFinite(Number(a?.score)) ? Number(a.score) : 0;
    const bScore = Number.isFinite(Number(b?.score)) ? Number(b.score) : 0;
    if (bScore !== aScore) return bScore - aScore;
    const aDepth = Number.isFinite(Number(a?.depth)) ? Number(a.depth) : 0;
    const bDepth = Number.isFinite(Number(b?.depth)) ? Number(b.depth) : 0;
    if (bDepth !== aDepth) return bDepth - aDepth;
    // 同分 + 最高分位置相同时,优先选实际走得更远的(终局深度更大),
    // 避免 chain 被截到 bestScoreDepth 后 chain.length 和 depth 同值导致 tie-break 失效。
    const aTerminal = Number.isFinite(Number(a?.terminalDepth))
      ? Number(a.terminalDepth)
      : (a?.chain?.length ?? 0);
    const bTerminal = Number.isFinite(Number(b?.terminalDepth))
      ? Number(b.terminalDepth)
      : (b?.chain?.length ?? 0);
    if (bTerminal !== aTerminal) return bTerminal - aTerminal;
    const chainLengthDelta = (b?.chain?.length ?? 0) - (a?.chain?.length ?? 0);
    if (chainLengthDelta !== 0) return chainLengthDelta;
    return routeFoundSortValue(a) - routeFoundSortValue(b);
  }

  function isTopPathCandidateBetter(candidate, worst) {
    return !worst || compareTopPathCandidates(candidate, worst) < 0;
  }

  // ===== topPath 收集策略 =====
  // policy 形如 { minScoreExclusive?: number, diversityCap?: number, diversityKey?: 'score-terminalDepth' }
  // - minScoreExclusive: candidate.score 必须 > 该值才入选(默认关闭)
  // - diversityCap: 同 (score, terminalDepth) 分组最多保留 N 条(默认关闭)
  // 策略默认全关,以保证既有调用方和测试不受影响;需要的入口在调用时显式传。
  function buildTopPathGroupKey(candidate, mode) {
    const keyMode = mode || 'score-terminalDepth';
    const rawScore = Number(candidate?.score);
    const score = Number.isFinite(rawScore) ? rawScore.toFixed(6) : '0';
    if (keyMode === 'score-only') return `s:${score}`;
    const term = Number.isFinite(Number(candidate?.terminalDepth))
      ? Number(candidate.terminalDepth)
      : (Array.isArray(candidate?.chain) ? candidate.chain.length : 0);
    return `s:${score}|t:${term}`;
  }

  function policyDefined(policy) {
    if (!policy || typeof policy !== 'object') return false;
    const hasMin =
      policy.minScoreExclusive !== undefined &&
      policy.minScoreExclusive !== null &&
      Number.isFinite(Number(policy.minScoreExclusive));
    const hasCap =
      policy.diversityCap !== undefined &&
      policy.diversityCap !== null &&
      Number.isFinite(Number(policy.diversityCap)) &&
      Number(policy.diversityCap) > 0;
    return hasMin || hasCap;
  }

  // 单条候选入选决策。返回 true 表示候选留在 list 中。
  // 副作用:按策略与 topK 修改 list。
  function applyTopPathPolicy(list, candidate, topK, policy) {
    if (policyDefined(policy) && policy.minScoreExclusive !== undefined && policy.minScoreExclusive !== null) {
      if (Number(candidate?.score ?? 0) <= Number(policy.minScoreExclusive)) return false;
    }
    if (policyDefined(policy) && policy.diversityCap) {
      const cap = Math.max(1, Number(policy.diversityCap) | 0);
      const keyMode = policy.diversityKey;
      const incomingKey = buildTopPathGroupKey(candidate, keyMode);
      let groupSize = 0;
      let worstInGroupIdx = -1;
      for (let i = 0; i < list.length; i += 1) {
        if (buildTopPathGroupKey(list[i], keyMode) !== incomingKey) continue;
        groupSize += 1;
        if (worstInGroupIdx === -1 || compareTopPathCandidates(list[i], list[worstInGroupIdx]) > 0) {
          worstInGroupIdx = i;
        }
      }
      if (groupSize >= cap) {
        if (compareTopPathCandidates(candidate, list[worstInGroupIdx]) >= 0) return false;
        list.splice(worstInGroupIdx, 1);
      }
    }
    list.push(candidate);
    list.sort(compareTopPathCandidates);
    if (list.length > topK) list.length = topK;
    return list.includes(candidate);
  }

  // 批量版:用于 merge 场景。假定 list 已经包含全部待合并候选,整体过滤+截断。
  function applyTopPathPolicyBatch(list, topK, policy) {
    if (!Array.isArray(list)) return [];
    let filtered = list;
    if (policyDefined(policy) && policy.minScoreExclusive !== undefined && policy.minScoreExclusive !== null) {
      const threshold = Number(policy.minScoreExclusive);
      filtered = filtered.filter((c) => Number(c?.score ?? 0) > threshold);
    }
    filtered.sort(compareTopPathCandidates);
    if (policyDefined(policy) && policy.diversityCap) {
      const cap = Math.max(1, Number(policy.diversityCap) | 0);
      const keyMode = policy.diversityKey;
      const groupCount = new Map();
      filtered = filtered.filter((c) => {
        const key = buildTopPathGroupKey(c, keyMode);
        const cnt = groupCount.get(key) ?? 0;
        if (cnt >= cap) return false;
        groupCount.set(key, cnt + 1);
        return true;
      });
    }
    if (filtered.length > topK) filtered.length = topK;
    return filtered;
  }

  function normalizeScoreTraceEntry(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const depth = Number.isFinite(Number(entry.depth)) ? Number(entry.depth) : 0;
    return {
      depth,
      label: typeof entry.label === 'string' ? entry.label : '',
      score: Number.isFinite(Number(entry.score)) ? Number(entry.score) : 0,
      scoreUnavailable: entry.scoreUnavailable === true,
      error: typeof entry.error === 'string' ? entry.error : '',
    };
  }

  function cloneScoreTrace(trace) {
    return Array.isArray(trace)
      ? trace.map(normalizeScoreTraceEntry).filter(Boolean)
      : [];
  }

  function cloneScoreBreakdown(breakdown) {
    return Array.isArray(breakdown)
      ? JSON.parse(JSON.stringify(breakdown))
      : [];
  }

  function normalizeRouteFoundMeta(candidate) {
    const routeFoundAtMs = Number.isFinite(Number(candidate?.routeFoundAtMs))
      ? Number(candidate.routeFoundAtMs)
      : null;
    return {
      routeFoundAtMs,
      routeFoundAtIso:
        typeof candidate?.routeFoundAtIso === 'string' && candidate.routeFoundAtIso
          ? candidate.routeFoundAtIso
          : (routeFoundAtMs != null ? new Date(routeFoundAtMs).toISOString() : null),
      routeFoundElapsedMs: Number.isFinite(Number(candidate?.routeFoundElapsedMs))
        ? Math.max(0, Number(candidate.routeFoundElapsedMs))
        : null,
      routeFoundNodes: Number.isFinite(Number(candidate?.routeFoundNodes))
        ? Math.max(0, Number(candidate.routeFoundNodes))
        : null,
      routeFoundTerminals: Number.isFinite(Number(candidate?.routeFoundTerminals))
        ? Math.max(0, Number(candidate.routeFoundTerminals))
        : null,
    };
  }

  function buildRouteFoundMeta(searchStartedAtMs, nodes, terminalCount) {
    const routeFoundAtMs = Date.now();
    const startedAtMs = Number.isFinite(Number(searchStartedAtMs))
      ? Number(searchStartedAtMs)
      : routeFoundAtMs;
    return {
      routeFoundAtMs,
      routeFoundAtIso: new Date(routeFoundAtMs).toISOString(),
      routeFoundElapsedMs: Math.max(0, routeFoundAtMs - startedAtMs),
      routeFoundNodes: Number.isFinite(Number(nodes)) ? Math.max(0, Number(nodes)) : null,
      routeFoundTerminals: Number.isFinite(Number(terminalCount)) ? Math.max(0, Number(terminalCount)) : null,
    };
  }

  function buildTopPathProgress(best) {
    const top = Array.isArray(best?.topPaths) ? best.topPaths[0] : null;
    if (!top) return {};
    const topScore = Number(top.score);
    return {
      topScore: Number.isFinite(topScore) ? topScore : 0,
      topDepth: Number.isFinite(Number(top.depth)) ? Number(top.depth) : 0,
      topTerminalDepth: Number.isFinite(Number(top.terminalDepth))
        ? Number(top.terminalDepth)
        : (Array.isArray(top.chain) ? top.chain.length : 0),
      topBestScoreDepth: Number.isFinite(Number(top.bestScoreDepth))
        ? Number(top.bestScoreDepth)
        : (Number.isFinite(Number(top.depth)) ? Number(top.depth) : 0),
      topRouteFoundAtMs: Number.isFinite(Number(top.routeFoundAtMs)) ? Number(top.routeFoundAtMs) : null,
    };
  }

  function normalizeBestScoreRecord(record) {
    if (!record || typeof record !== 'object') return null;
    const entry = normalizeScoreTraceEntry(record);
    if (!entry) return null;
    return {
      ...entry,
      snapshot: record.snapshot ?? null,
      scoreBreakdown: cloneScoreBreakdown(record.scoreBreakdown),
    };
  }

  function compareScoreTraceEntries(a, b) {
    const aScore = Number.isFinite(Number(a?.score)) ? Number(a.score) : 0;
    const bScore = Number.isFinite(Number(b?.score)) ? Number(b.score) : 0;
    if (bScore !== aScore) return bScore - aScore;
    const aDepth = Number.isFinite(Number(a?.depth)) ? Number(a.depth) : 0;
    const bDepth = Number.isFinite(Number(b?.depth)) ? Number(b.depth) : 0;
    return bDepth - aDepth;
  }

  function isScoreTraceEntryBetter(entry, currentBest) {
    return !currentBest || compareScoreTraceEntries(entry, currentBest) < 0;
  }

  function selectBestScoreTraceEntry(trace) {
    let bestEntry = null;
    for (const entry of cloneScoreTrace(trace)) {
      if (isScoreTraceEntryBetter(entry, bestEntry)) bestEntry = entry;
    }
    return bestEntry;
  }

  function truncateHistoryStateToDepth(state, depth) {
    const cloned = cloneHistoryState(state);
    if (!Array.isArray(cloned.history)) return { history: [] };
    const targetDepth = Math.max(0, Math.min(cloned.history.length, depth | 0));
    if (targetDepth >= cloned.history.length) return cloned;
    return {
      history: cloned.history.slice(0, targetDepth),
    };
  }

  function serializeTopPathCandidate(candidate) {
    if (!candidate || typeof candidate !== 'object') return null;
    return {
      chain: Array.isArray(candidate.chain) ? candidate.chain.slice() : [],
      depth: candidate.depth ?? 0,
      score: candidate.score ?? 0,
      reason: candidate.reason ?? '',
      terminalDepth: candidate.terminalDepth ?? candidate.depth ?? 0,
      terminalReason: candidate.terminalReason ?? candidate.reason ?? '',
      bestScoreDepth: candidate.bestScoreDepth ?? candidate.depth ?? 0,
      scoreTrace: cloneScoreTrace(candidate.scoreTrace),
      scoreBreakdown: cloneScoreBreakdown(candidate.scoreBreakdown),
      ...normalizeRouteFoundMeta(candidate),
      snapshot: candidate.snapshot ?? null,
      state: candidate.state ? serializeHistoryState(candidate.state) : null,
    };
  }

  function deserializeTopPathCandidate(candidate) {
    if (!candidate || typeof candidate !== 'object') return null;
    return {
      chain: Array.isArray(candidate.chain) ? candidate.chain.slice() : [],
      depth: candidate.depth ?? 0,
      score: candidate.score ?? 0,
      reason: candidate.reason ?? '',
      terminalDepth: candidate.terminalDepth ?? candidate.depth ?? 0,
      terminalReason: candidate.terminalReason ?? candidate.reason ?? '',
      bestScoreDepth: candidate.bestScoreDepth ?? candidate.depth ?? 0,
      scoreTrace: cloneScoreTrace(candidate.scoreTrace),
      scoreBreakdown: cloneScoreBreakdown(candidate.scoreBreakdown),
      ...normalizeRouteFoundMeta(candidate),
      snapshot: candidate.snapshot ?? null,
      state: candidate.state ? deserializeHistoryState(candidate.state) : null,
    };
  }

  function serializeSearchCoreResult(result) {
    if (!result || typeof result !== 'object') {
      return { nodes: 0, terminalCount: 0, topPaths: [], completed: true, stopReason: 'DONE' };
    }
    const completed = result.completed !== false;
    const out = {
      nodes: result.nodes ?? 0,
      terminalCount: result.terminalCount ?? 0,
      topPaths: Array.isArray(result.topPaths)
        ? result.topPaths.map(serializeTopPathCandidate).filter(Boolean)
        : [],
      completed,
      stopReason: normalizeSearchStopReason(result.stopReason, completed ? 'DONE' : 'UNKNOWN'),
    };
    return out;
  }

  function deserializeSearchCoreResult(result) {
    if (!result || typeof result !== 'object') {
      return { nodes: 0, terminalCount: 0, topPaths: [], completed: true, stopReason: 'DONE' };
    }
    const completed = result.completed !== false;
    const out = {
      nodes: result.nodes ?? 0,
      terminalCount: result.terminalCount ?? 0,
      topPaths: Array.isArray(result.topPaths)
        ? result.topPaths.map(deserializeTopPathCandidate).filter(Boolean)
        : [],
      completed,
      stopReason: normalizeSearchStopReason(result.stopReason, completed ? 'DONE' : 'UNKNOWN'),
    };
    return out;
  }

  function serializeSearchAction(action) {
    return serializeDecisionAction(action);
  }

  function deserializeSearchAction(action) {
    return deserializeDecisionAction(action);
  }

  function summarizeSearchActionForLog(action) {
    if (!action) return '<null>';
    return String(action.label ?? action.text ?? action.kind ?? '<unknown>').slice(0, 120);
  }

  function summarizeFrameActionsForLog(frame, radius = 2) {
    const actions = Array.isArray(frame?.actions) ? frame.actions : [];
    if (actions.length === 0) return '';
    const nextIndex = Math.max(0, Math.min(actions.length - 1, Number(frame?.nextIndex ?? 0)));
    const start = Math.max(0, nextIndex - radius);
    const end = Math.min(actions.length, nextIndex + radius + 1);
    return actions
      .slice(start, end)
      .map((action, offset) => {
        const index = start + offset;
        const marker = index === nextIndex ? '*' : '';
        return `${marker}${index}:${summarizeSearchActionForLog(action)}`;
      })
      .join(' | ');
  }

  // v3: frame stack 的 baseState.history 采用 delta 编码(每帧只存相对上一帧的尾巴),
  //     可将多帧栈中的历史复制开销从 O(N*depth) 降到 O(depth)。
  //     旧的 v2 存档反序列化时会返回 null,需要重跑。
  const EXACT_SEARCH_RESUME_VERSION = 3;

  // 历史项相等比较。先做引用快速路径,再退化到 JSON 比较。
  function historyItemsEqual(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    try {
      return JSON.stringify(serializeDecisionAction(a) ?? a) === JSON.stringify(serializeDecisionAction(b) ?? b);
    } catch (_) {
      return false;
    }
  }

  // 把 baseState 序列化时,如果 prevHistory 是当前 history 的严格前缀,
  // 用 { historyBase: { parentLen, tail } } 取代 history 字段,避免重复存储父帧已知的前缀。
  // prevHistory 为已序列化(plain-object 数组)或 in-memory 数组皆可。
  function serializeBaseStateWithDelta(frameBaseState, prevHistory) {
    const base = serializeHistoryState(frameBaseState);
    if (!Array.isArray(base.history) || !Array.isArray(prevHistory) || prevHistory.length === 0) {
      return base;
    }
    if (base.history.length < prevHistory.length) return base;
    for (let i = 0; i < prevHistory.length; i += 1) {
      if (!historyItemsEqual(prevHistory[i], base.history[i])) return base;
    }
    const tail = base.history.slice(prevHistory.length);
    const out = {
      ...base,
      historyBase: { parentLen: prevHistory.length, tail },
    };
    // 用空数组占位,既能通过 deserializeHistoryState 的 isArray 检查,也避免重复存储 history。
    out.history = [];
    return out;
  }

  // 反序列化 baseState:若包含 historyBase,合并父历史 + 尾巴恢复完整 history。
  function deserializeBaseStateWithDelta(serialized, prevHistory) {
    if (!serialized || typeof serialized !== 'object') return { history: [] };
    if (serialized.historyBase && Array.isArray(serialized.historyBase.tail)) {
      const parentLen = Number.isFinite(Number(serialized.historyBase.parentLen))
        ? Number(serialized.historyBase.parentLen)
        : 0;
      const prefix = Array.isArray(prevHistory) ? prevHistory.slice(0, parentLen) : [];
      const tail = serialized.historyBase.tail;
      const reconstructed = { ...serialized, history: [...prefix, ...tail] };
      delete reconstructed.historyBase;
      return deserializeHistoryState(reconstructed);
    }
    return deserializeHistoryState(serialized);
  }

  function cloneExactStateKeyPath(path) {
    return Array.isArray(path)
      ? path.filter((item) => typeof item === 'string' && item.length > 0).slice()
      : [];
  }

  function buildChainFromHistoryState(state) {
    return Array.isArray(state?.history)
      ? state.history.map((item) => item?.label ?? '')
      : [];
  }

  function isExactCycleLikeActionLabel(label) {
    return typeof label === 'string' && (
      /^取消选择/.test(label) ||
      /^取消选择流程$/.test(label) ||
      /^取消\/不发动\[/.test(label) ||
      /^不发动\[YGOProMsgSelectCard\]/.test(label) ||
      /^不选择$/.test(label) ||
      /^默认响应\[/.test(label)
    );
  }

  function shouldBuildExactCycleStateKey(decision) {
    const messageName = decision?.message?.constructor?.name ?? '';
    if (messageName === 'YGOProMsgSelectUnselectCard' && !HARD_DISABLE_SELECT_UNSELECT_CANCEL) return true;
    return Array.isArray(decision?.actions) && decision.actions.some((action) =>
      isExactCycleLikeActionLabel(action?.label)
    );
  }

  function isSnapshotUnavailableTerminalDecision(decision) {
    if (!decision?.terminal) return false;
    return [
      'MSG_RETRY',
      'MSG_RETRY_RAW',
      'PROCESS_UNAVAILABLE',
      'AUTO_RESPONSE_FAIL',
    ].includes(decision.reason);
  }

  function buildCurrentDecisionStateKey(runner) {
    if (!runner) return '';
    const decision = runner.currentDecision ?? null;
    if (!shouldBuildExactCycleStateKey(decision)) return '';
    let logicalStateKey = '';
    if (typeof runner.captureSnapshot === 'function') {
      try {
        const snapshot = runner.captureSnapshot();
        const normalizedSnapshot = typeof runner.normalizeExactStateKeySnapshot === 'function'
          ? runner.normalizeExactStateKeySnapshot(snapshot)
          : snapshot;
        logicalStateKey = makeExactStateKey(null, normalizedSnapshot, decision);
      } catch {
        logicalStateKey = '';
      }
    }
    let nativeSnapshotHash = '';
    if (!logicalStateKey && typeof runner.captureNativeSnapshotBytes === 'function') {
      try {
        nativeSnapshotHash = hashPayloadSha256(runner.captureNativeSnapshotBytes());
      } catch {
        nativeSnapshotHash = '';
      }
    }
    return crypto.createHash('sha256').update(stableStringify({
      logicalStateKey,
      nativeSnapshotHash,
      terminal: !!decision?.terminal,
      reason: decision?.reason ?? null,
      messageName: decision?.message?.constructor?.name ?? null,
      actions: Array.isArray(decision?.actions)
        ? decision.actions.map((action) => serializeDecisionAction(action))
        : [],
    })).digest('hex');
  }

  function endFrameRestoreProfile(phase, frame, startedAt) {
    const frameKind = sanitizeProfileLabel(frame?.frameKind);
    const phaseLabel = sanitizeProfileLabel(phase);
    endProfileTimer('exact.frame.restore', startedAt);
    endProfileTimer(`exact.frame.restore.kind.${frameKind}`, startedAt);
    endProfileTimer(`exact.frame.restore.phase.${phaseLabel}`, startedAt);
    endProfileTimer(`exact.frame.restore.kind.${frameKind}.phase.${phaseLabel}`, startedAt);
  }

  function restoreExactSearchFrameState(runner, frame, phase = 'unknown') {
    const startedAt = startProfileTimer();
    try {
      runner.restoreState(deserializeHistoryState(frame.baseState));
    } finally {
      endFrameRestoreProfile(phase, frame, startedAt);
    }
  }

  function decodeSearchFrameAction(action) {
    if (
      action &&
      typeof action === 'object' &&
      (typeof action.intResponse === 'number' || action.response instanceof Uint8Array) &&
      typeof action.responseBase64 !== 'string'
    ) {
      return action;
    }
    try {
      return deserializeSearchAction(action) ?? action;
    } catch {
      return action;
    }
  }

  function resolveExactSearchFrameAction(runner, encodedAction) {
    const decision = runner.currentDecision;
    if (!decision || decision.terminal || !Array.isArray(decision.actions)) {
      return null;
    }
    if (typeof runner.isExactReplayActionMatch === 'function') {
      const decoded = decodeSearchFrameAction(encodedAction);
      return decision.actions.find((action) =>
        runner.isExactReplayActionMatch(action, decoded)
      ) ?? null;
    }
    if (typeof runner.resolveReplayAction === 'function') {
      return runner.resolveReplayAction(encodedAction, decision);
    }
    return decodeSearchFrameAction(encodedAction);
  }

  function serializeExactSearchFrame(frame, prevHistory) {
    if (!frame || typeof frame !== 'object') return null;
    let baseStateSerialized;
    if (frame.baseState) {
      baseStateSerialized = Array.isArray(prevHistory) && prevHistory.length > 0
        ? serializeBaseStateWithDelta(frame.baseState, prevHistory)
        : serializeHistoryState(frame.baseState);
    } else {
      baseStateSerialized = { history: [] };
    }
    return {
      depth: frame.depth ?? 0,
      nextIndex: frame.nextIndex ?? 0,
      exploredChild: !!frame.exploredChild,
      snapshot: frame.snapshot ?? null,
      frameKind: typeof frame.frameKind === 'string' ? frame.frameKind : '',
      stateKey: frame.stateKey ?? '',
      ancestorStateKeys: cloneExactStateKeyPath(frame.ancestorStateKeys),
      nodeHardLimit: frame.nodeHardLimit ?? null,
      shouldBalanceCardChoices: !!frame.shouldBalanceCardChoices,
      perChoiceBudget: frame.perChoiceBudget ?? 0,
      actions: Array.isArray(frame.actions)
        ? frame.actions.map(serializeSearchAction).filter(Boolean)
        : [],
      baseState: baseStateSerialized,
      scoreTrace: cloneScoreTrace(frame.scoreTrace),
      bestScoreRecord: normalizeBestScoreRecord(frame.bestScoreRecord),
    };
  }

  function deserializeExactSearchFrame(frame, prevHistory) {
    if (!frame || typeof frame !== 'object') return null;
    let baseState;
    if (frame.baseState) {
      baseState = frame.baseState.historyBase
        ? deserializeBaseStateWithDelta(frame.baseState, prevHistory)
        : deserializeHistoryState(frame.baseState);
    } else {
      baseState = { history: [] };
    }
    return {
      depth: frame.depth ?? 0,
      nextIndex: frame.nextIndex ?? 0,
      exploredChild: !!frame.exploredChild,
      snapshot: frame.snapshot ?? null,
      frameKind: typeof frame.frameKind === 'string' ? frame.frameKind : '',
      stateKey: typeof frame.stateKey === 'string' ? frame.stateKey : '',
      ancestorStateKeys: cloneExactStateKeyPath(frame.ancestorStateKeys),
      nodeHardLimit: Number.isFinite(frame.nodeHardLimit) ? Number(frame.nodeHardLimit) : null,
      shouldBalanceCardChoices: !!frame.shouldBalanceCardChoices,
      perChoiceBudget: Number.isFinite(frame.perChoiceBudget) ? Number(frame.perChoiceBudget) : 0,
      actions: Array.isArray(frame.actions)
        ? frame.actions.map(deserializeSearchAction).filter(Boolean)
        : [],
      baseState,
      scoreTrace: cloneScoreTrace(frame.scoreTrace),
      bestScoreRecord: normalizeBestScoreRecord(frame.bestScoreRecord),
    };
  }

  // 栈级编码:按顺序遍历,每帧拿上一帧已序列化后的 history(经过 delta 解码后还原成完整数组)
  // 作为基线传给下一帧。in-memory frame 的 history 已是 plain 对象,可以直接当作基线。
  function serializeExactSearchStack(stack) {
    if (!Array.isArray(stack)) return [];
    const out = [];
    let prevHistory = null;
    for (const frame of stack) {
      const serialized = serializeExactSearchFrame(frame, prevHistory);
      if (!serialized) continue;
      out.push(serialized);
      prevHistory = Array.isArray(frame?.baseState?.history) ? frame.baseState.history : prevHistory;
    }
    return out;
  }

  function deserializeExactSearchStack(serializedStack) {
    if (!Array.isArray(serializedStack)) return [];
    const out = [];
    let prevHistory = null;
    for (const sFrame of serializedStack) {
      const frame = deserializeExactSearchFrame(sFrame, prevHistory);
      if (!frame) continue;
      out.push(frame);
      prevHistory = Array.isArray(frame.baseState?.history) ? frame.baseState.history : prevHistory;
    }
    return out;
  }

  function serializeExactSearchResumeState(payload) {
    if (!payload || typeof payload !== 'object') return null;
    return {
      resumeVersion: EXACT_SEARCH_RESUME_VERSION,
      rootState: payload.rootState ? serializeHistoryState(payload.rootState) : null,
      rootAncestorStateKeys: cloneExactStateKeyPath(payload.rootAncestorStateKeys),
      best: serializeSearchCoreResult(payload.best),
      chain: Array.isArray(payload.chain) ? payload.chain.slice() : [],
      scoreTrace: cloneScoreTrace(payload.scoreTrace),
      bestScoreRecord: normalizeBestScoreRecord(payload.bestScoreRecord),
      stack: serializeExactSearchStack(payload.stack),
    };
  }

  function deserializeExactSearchResumeState(payload) {
    if (!payload || typeof payload !== 'object') return null;
    if ((payload.resumeVersion ?? 0) !== EXACT_SEARCH_RESUME_VERSION) return null;
    return {
      rootState: payload.rootState ? deserializeHistoryState(payload.rootState) : null,
      rootAncestorStateKeys: cloneExactStateKeyPath(payload.rootAncestorStateKeys),
      best: deserializeSearchCoreResult(payload.best),
      chain: Array.isArray(payload.chain) ? payload.chain.slice() : [],
      scoreTrace: cloneScoreTrace(payload.scoreTrace),
      bestScoreRecord: normalizeBestScoreRecord(payload.bestScoreRecord),
      stack: deserializeExactSearchStack(payload.stack),
    };
  }

  function searchTopLongestPathsExactSingle(runner, opts) {
    const resumeState = deserializeExactSearchResumeState(opts.resumeState);
    const best = resumeState?.best
      ? {
          nodes: resumeState.best.nodes ?? 0,
          terminalCount: resumeState.best.terminalCount ?? 0,
          topPaths: Array.isArray(resumeState.best.topPaths)
            ? resumeState.best.topPaths.map((item) => ({
                ...item,
                state: item.state ? cloneHistoryState(item.state) : null,
              }))
            : [],
          completed: resumeState.best.completed !== false,
          stopReason: normalizeSearchStopReason(
            resumeState.best.stopReason,
            resumeState.best.completed === false ? 'UNKNOWN' : 'DONE',
          ),
        }
      : createEmptySearchCoreResult();
    const rootAncestorStateKeys = cloneExactStateKeyPath(resumeState?.rootAncestorStateKeys);
    const topK = Math.max(1, opts.topK ?? DEFAULT_OPTIONS.topK);
    // topPath 收集策略(默认关闭,保持老调用方兼容)。Web 入口显式开启 { minScoreExclusive: 0, diversityCap: 5 }。
    const topPathPolicy =
      opts.topPathPolicy && typeof opts.topPathPolicy === 'object' ? opts.topPathPolicy : null;
    const progressEvery = Math.max(1, opts.progressEvery ?? 200);
    const progressMinIntervalMs = Math.max(100, opts.progressMinIntervalMs ?? 500);
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    const onCheckpoint = typeof opts.onCheckpoint === 'function' ? opts.onCheckpoint : null;
    const checkpointEvery = Math.max(1, opts.checkpointEvery ?? WEB_ARCHIVE_CHECKPOINT_NODES);
    // 已废弃节点判定。checkpointEvery 仅保留在选项签名上以维持调用方兼容,实际不再用于判定。
    // 唯一的判定是时间间隔:每 5 分钟向上层(主进程或调用方 onCheckpoint)推送一次最新 resumeState。
    // 在并行模式下这相当于 worker 给主进程的"心跳上报",主进程再根据自己的 10 分钟窗口决定是否落盘;
    // 串行(CLI 单进程)模式下,onCheckpoint 直接对应落盘,因此就是每 5 分钟落盘一次。
    // 历史:曾尝试 1 分钟心跳,但高频 IPC 序列化巨型 resumeState 把主进程 V8 堆 2 GB 红线撞爆,
    // FATAL ERROR: Zone Allocation failed - process out of memory(详见 2026-05-05 崩溃日志),
    // 故回退到 5 分钟。提升崩溃恢复保真度的方向应改为让 resumeState 体积更小,而非加快心跳。
    void checkpointEvery;
    const CHECKPOINT_INTERVAL_MS = 5 * 60 * 1000;
    const targetTerminals = Math.max(0, opts.targetTerminals ?? 0);
    const balanceCardChoiceMaxDepth = Number.isFinite(Number(opts.balanceCardChoiceMaxDepth))
      ? Math.max(0, Number(opts.balanceCardChoiceMaxDepth))
      : Number.POSITIVE_INFINITY;
    const enableChoiceBudget =
      opts.enableChoiceBudget !== false &&
      process.env.COMBO_DISABLE_EXACT_CHOICE_BUDGET !== '1';
    const disableChoiceBudget = !enableChoiceBudget;
    const depthLimited = Number.isFinite(opts.maxDepth) && opts.maxDepth > 0;
    const searchNodeLimit = resolveSearchNodeLimit(opts.maxNodes);
    const searchStartedAtMs = Number.isFinite(Number(opts.searchStartedAtMs ?? opts.startedAtMs))
      ? Number(opts.searchStartedAtMs ?? opts.startedAtMs)
      : Date.now();
    const invocationStartNodes = best.nodes ?? 0;
    const nodeBudget = resolveSearchNodeLimit(opts.nodeBudget);
    const nodeBudgetLimit = Number.isFinite(nodeBudget)
      ? invocationStartNodes + nodeBudget
      : Number.POSITIVE_INFINITY;
    const effectiveNodeLimit = Math.min(searchNodeLimit, nodeBudgetLimit);
    const rootState = resumeState?.rootState
      ? cloneHistoryState(resumeState.rootState)
      : runner.saveState('exact.root.default');
    const chain = Array.isArray(resumeState?.chain) ? resumeState.chain.slice() : [];
    let scoreTrace = cloneScoreTrace(resumeState?.scoreTrace);
    let bestScoreRecord = normalizeBestScoreRecord(resumeState?.bestScoreRecord);
    const stack = Array.isArray(resumeState?.stack)
      ? resumeState.stack.map((frame) => ({
          ...frame,
          baseState: cloneHistoryState(frame.baseState),
          nodeHardLimit: Number.isFinite(frame.nodeHardLimit)
            ? Math.max(Number(frame.nodeHardLimit), effectiveNodeLimit)
            : effectiveNodeLimit,
          ancestorStateKeys: cloneExactStateKeyPath(frame.ancestorStateKeys),
          actions: Array.isArray(frame.actions) ? frame.actions.map((item) => ({ ...item })) : [],
          scoreTrace: cloneScoreTrace(frame.scoreTrace),
          bestScoreRecord: normalizeBestScoreRecord(frame.bestScoreRecord),
        }))
      : [];
    let activeFrame = null;
    let lastReportedNodes = -1;
    let lastReportedAtNs = 0n;
    let lastCheckpointTimeNs = process.hrtime.bigint();
    const debugCollector = typeof createSearchDebugCollector === 'function'
      ? createSearchDebugCollector({
          ...(opts.debugTrace ?? {}),
          mode: 'topdown-exact',
          maxNodes: opts.maxNodes,
          maxDepth: opts.maxDepth,
          guards: {
            balanceCardChoiceMaxDepth,
            enableChoiceBudget,
            disableChoiceBudget,
          },
        })
      : null;
    if (opts.debugTrace?.opening && debugCollector?.setOpening) {
      debugCollector.setOpening(opts.debugTrace.opening);
    }
    const bumpCounter = (name, delta = 1) => {
      if (debugCollector?.incrementCounter) {
        debugCollector.incrementCounter(name, delta);
      }
    };
    const setCounterMax = (name, value) => {
      if (debugCollector?.setCounterMax) {
        debugCollector.setCounterMax(name, value);
      }
    };

    const shouldBalanceSearchChoices = (decision, actions, depth) => {
      if (disableChoiceBudget) return false;
      if (!Array.isArray(actions) || actions.length <= 1) return false;
      if (depth > balanceCardChoiceMaxDepth) return false;
      const messageName = decision?.message?.constructor?.name ?? '';
      return [
        'YGOProMsgSelectIdleCmd',
        'YGOProMsgSelectCard',
        'YGOProMsgSelectEffectYn',
        'YGOProMsgSelectChain',
        'YGOProMsgSelectYesNo',
      ].includes(messageName);
    };

    const computePerChoiceBudget = (nodeHardLimit, actionCount) => {
      const remaining = Math.max(1, Math.min(nodeHardLimit, effectiveNodeLimit) - best.nodes);
      return Math.max(1, Math.floor(remaining / Math.max(1, actionCount | 0)));
    };
    const recordSample = (bucket, event, payload) => {
      if (debugCollector?.recordSample) {
        debugCollector.recordSample(bucket, event, payload);
      }
    };
    const shouldRecordIntermediateScoredStates = opts.recordIntermediateScoredStates === true;
    const hasReachedGlobalNodeLimit = () => hasReachedSearchNodeLimit(best.nodes, searchNodeLimit);
    const hasReachedSliceNodeLimit = () => hasReachedSearchNodeLimit(best.nodes, nodeBudgetLimit);
    const hasReachedEffectiveNodeLimit = () => hasReachedSearchNodeLimit(best.nodes, effectiveNodeLimit);
    const hasReachedTargetTerminalLimit = () =>
      targetTerminals > 0 && best.terminalCount >= targetTerminals;
    const buildCurrentResumeState = () => serializeExactSearchResumeState({
      rootState,
      rootAncestorStateKeys,
      best,
      chain,
      scoreTrace,
      bestScoreRecord,
      stack,
    });

    const pushScoredCandidate = (candidate, stateOverride = null, stateDepth = null) => {
      // 先走策略判定;策略拒收的候选完全不进 list,也不解析 state(节省 state 克隆开销)
      if (policyDefined(topPathPolicy)) {
        const preliminaryKept = applyTopPathPolicy(best.topPaths, candidate, topK, topPathPolicy);
        if (preliminaryKept) {
          const resolvedState =
            typeof stateOverride === 'function'
              ? stateOverride()
              : stateOverride;
          candidate.state = resolvedState
            ? truncateHistoryStateToDepth(
                resolvedState,
                Number.isFinite(Number(stateDepth)) ? Number(stateDepth) : candidate.depth,
              )
            : null;
        }
        return preliminaryKept;
      }
      const worst = best.topPaths[topK - 1] ?? null;
      const shouldKeepState =
        best.topPaths.length < topK ||
        isTopPathCandidateBetter(candidate, worst);
      if (shouldKeepState) {
        const resolvedState =
          typeof stateOverride === 'function'
            ? stateOverride()
            : stateOverride;
        candidate.state = resolvedState
          ? truncateHistoryStateToDepth(
              resolvedState,
              Number.isFinite(Number(stateDepth)) ? Number(stateDepth) : candidate.depth,
            )
          : null;
      }
      best.topPaths.push(candidate);
      best.topPaths.sort(compareTopPathCandidates);
      if (best.topPaths.length > topK) best.topPaths.length = topK;
      return shouldKeepState;
    };

    const buildTraceEntry = (chainValue, scored) => {
      const depth = Array.isArray(chainValue) ? chainValue.length : 0;
      return {
        depth,
        label: depth > 0 ? String(chainValue[depth - 1] ?? '') : '[root]',
        score: Number.isFinite(Number(scored?.score)) ? Number(scored.score) : 0,
      };
    };

    const buildUnavailableTraceEntry = (chainValue, err = null) => {
      const depth = Array.isArray(chainValue) ? chainValue.length : 0;
      return {
        depth,
        label: depth > 0 ? String(chainValue[depth - 1] ?? '') : '[root]',
        score: 0,
        scoreUnavailable: true,
        error: err?.message ? String(err.message).slice(0, 160) : 'snapshot unavailable',
      };
    };

    const captureScoredTracePoint = (chainValue, phase) => {
      if (isSnapshotUnavailableTerminalDecision(runner.currentDecision)) {
        const entry = buildUnavailableTraceEntry(chainValue, {
          message: runner.currentDecision?.reason ?? 'terminal snapshot unavailable',
        });
        bumpCounter('scoreTraceSnapshotSkipped');
        recordSample('score', 'snapshot-skipped', {
          phase,
          depth: Array.isArray(chainValue) ? chainValue.length : 0,
          reason: runner.currentDecision?.reason ?? null,
        });
        return {
          rawSnapshot: null,
          scored: null,
          entry,
          ok: false,
        };
      }
      try {
        const rawSnapshot = runner.captureSnapshot();
        const scored = runner.scoreSnapshotDetailed(rawSnapshot);
        return {
          rawSnapshot,
          scored,
          entry: buildTraceEntry(chainValue, scored),
          ok: true,
        };
      } catch (err) {
        bumpCounter('scoreTraceSnapshotFailures');
        recordSample('score', 'snapshot-failed', {
          phase,
          depth: Array.isArray(chainValue) ? chainValue.length : 0,
          reason: runner.currentDecision?.reason ?? null,
          decisionName: runner.currentDecision?.message?.constructor?.name ?? '',
          error: err?.message ?? String(err),
        });
        return {
          rawSnapshot: null,
          scored: null,
          entry: buildUnavailableTraceEntry(chainValue, err),
          ok: false,
        };
      }
    };

    const recordCurrentScoreTraceStep = (chainValue) => {
      if (!shouldRecordIntermediateScoredStates) return null;
      const point = captureScoredTracePoint(chainValue, 'step');
      const entry = point.entry;
      if (scoreTrace.length >= entry.depth) {
        scoreTrace.length = Math.max(0, entry.depth - 1);
      }
      scoreTrace.push(entry);
      if (point.ok && isScoreTraceEntryBetter(entry, bestScoreRecord)) {
        bestScoreRecord = {
          ...entry,
          snapshot: point.scored.snapshot,
          scoreBreakdown: cloneScoreBreakdown(point.scored.breakdown),
        };
      }
      return entry;
    };

    const restoreScoreTrackerFromFrame = (frame) => {
      if (!shouldRecordIntermediateScoredStates) {
        scoreTrace = [];
        bestScoreRecord = null;
        return;
      }
      const frameTrace = cloneScoreTrace(frame?.scoreTrace);
      if (frameTrace.length > 0 && frame?.bestScoreRecord) {
        scoreTrace = frameTrace;
        bestScoreRecord = normalizeBestScoreRecord(frame?.bestScoreRecord);
        return;
      }
      scoreTrace = [];
      bestScoreRecord = null;
    };

    const settleTerminal = (chainValue, snapshotOverride = null, reasonHint = '', stateOverride = null) => {
      try {
        const captured = snapshotOverride
          ? (() => {
              const scored = runner.scoreSnapshotDetailed(snapshotOverride);
              return {
                rawSnapshot: snapshotOverride,
                scored,
                entry: buildTraceEntry(chainValue, scored),
                ok: true,
              };
            })()
          : captureScoredTracePoint(chainValue, 'terminal');
        const rawSnapshot = captured.rawSnapshot;
        const scored = captured.scored;
        const terminalDepth = chainValue.length;
        let terminalTrace = [];
        let representative = null;
        let representativeSnapshot = scored?.snapshot ?? bestScoreRecord?.snapshot ?? null;
        let representativeBreakdown = cloneScoreBreakdown(scored?.breakdown);

        if (shouldRecordIntermediateScoredStates) {
          terminalTrace = cloneScoreTrace(scoreTrace);
          const lastTrace = terminalTrace[terminalTrace.length - 1] ?? null;
          if (!lastTrace || lastTrace.depth !== terminalDepth) {
            const terminalEntry = captured.entry;
            terminalTrace.push(terminalEntry);
            if (captured.ok && isScoreTraceEntryBetter(terminalEntry, bestScoreRecord)) {
              bestScoreRecord = {
                ...terminalEntry,
                snapshot: scored.snapshot,
                scoreBreakdown: cloneScoreBreakdown(scored.breakdown),
              };
            }
          }
          representative = selectBestScoreTraceEntry(terminalTrace) ?? captured.entry;
          if (
            bestScoreRecord &&
            bestScoreRecord.depth === representative.depth &&
            Number(bestScoreRecord.score) === Number(representative.score)
          ) {
            representativeSnapshot = bestScoreRecord.snapshot ?? scored?.snapshot ?? null;
            representativeBreakdown = cloneScoreBreakdown(bestScoreRecord.scoreBreakdown);
          }
        } else {
          representative = captured.entry;
          terminalTrace = [representative];
        }

        const bestDepth = Math.max(0, Math.min(terminalDepth, representative.depth ?? terminalDepth));
        const candidate = {
          chain: chainValue.slice(0, bestDepth),
          depth: bestDepth,
          score: representative.score,
          reason: reasonHint,
          terminalDepth,
          terminalReason: reasonHint,
          bestScoreDepth: bestDepth,
          scoreTrace: terminalTrace,
          scoreBreakdown: representativeBreakdown,
          ...buildRouteFoundMeta(searchStartedAtMs, best.nodes, best.terminalCount + 1),
          snapshot: representativeSnapshot,
          state: null,
        };
        best.terminalCount += 1;
        pushScoredCandidate(candidate, stateOverride, bestDepth);
        if (debugCollector?.noteTerminal) {
          debugCollector.noteTerminal({
            reason: reasonHint,
            depth: chainValue.length,
            chain: chainValue,
            snapshot: rawSnapshot ?? representativeSnapshot,
          });
        }
        return true;
      } catch (err) {
        console.error(
          `[search-record-candidate-failed] reason=${reasonHint || 'unknown'} chainDepth=${chainValue.length} history=${runner.actionHistory?.length ?? 0} decision=${formatDebugDecision(runner.currentDecision)}`,
        );
        throw err;
      }
    };
    const settleCurrentDecisionIfTerminal = () => {
      const current = runner.currentDecision;
      if (!current || current.terminal || !current.actions?.length) {
        settleTerminal(chain, null, current?.reason ?? 'NO_ACTION_OR_NULL', () => runner.saveResultState());
        return true;
      }
      return false;
    };

    const emitCheckpoint = (
      force = false,
      getCheckpointRootState = null,
      checkpointRootAncestorStateKeys = null,
    ) => {
      if (!onCheckpoint) return;
      // 仅按时间触发:距上次推送已超过 CHECKPOINT_INTERVAL_MS,或显式 force(例如收尾)。
      if (!force) {
        const elapsedMs = Number(process.hrtime.bigint() - lastCheckpointTimeNs) / 1e6;
        if (elapsedMs < CHECKPOINT_INTERVAL_MS) return;
      }
      lastCheckpointTimeNs = process.hrtime.bigint();
      const checkpointRootState =
        typeof getCheckpointRootState === 'function'
          ? getCheckpointRootState()
          : rootState;
      const serializedRootAncestorStateKeys =
        checkpointRootAncestorStateKeys == null
          ? rootAncestorStateKeys
          : checkpointRootAncestorStateKeys;
      onCheckpoint({
        nodes: best.nodes,
        terminalCount: best.terminalCount,
        resumeState: serializeExactSearchResumeState({
          rootState: checkpointRootState,
          rootAncestorStateKeys: serializedRootAncestorStateKeys,
          best,
          chain,
          scoreTrace,
          bestScoreRecord,
          stack,
        }),
      });
    };

    const maybeReportProgress = (currentDepth, force = false) => {
      if (!onProgress) return;
      const nowNs = process.hrtime.bigint();
      const intervalElapsed =
        lastReportedAtNs === 0n ||
        Number(nowNs - lastReportedAtNs) / 1e6 >= progressMinIntervalMs;
      const hitNodeBoundary =
        best.nodes === 0 ||
        best.nodes >= effectiveNodeLimit ||
        best.nodes % progressEvery === 0;
      if (!force && !hitNodeBoundary && !intervalElapsed) return;
      if (!force && best.nodes === lastReportedNodes && !intervalElapsed) return;
      lastReportedNodes = best.nodes;
      lastReportedAtNs = nowNs;
      onProgress({
        nodes: best.nodes,
        maxNodes: opts.maxNodes,
        terminalCount: best.terminalCount,
        currentDepth,
        ...buildTopPathProgress(best),
        done: false,
      });
    };

    const syncCurrentChainFromState = (state) => {
      const nextChain = buildChainFromHistoryState(state);
      chain.length = 0;
      chain.push(...nextChain);
    };

    const dropUnrestorableFrame = (phase, frame, err) => {
      bumpCounter('unrestorableFrames');
      const actionCount = Array.isArray(frame?.actions) ? frame.actions.length : 0;
      const nextAction = actionCount > 0 ? summarizeSearchActionForLog(frame.actions[frame?.nextIndex ?? 0]) : '<none>';
      console.error(
        `[search-frame-unrestorable-fatal] phase=${phase} depth=${frame?.depth ?? -1} nextIndex=${frame?.nextIndex ?? -1}/${actionCount} targetHistory=${frame?.baseState?.history?.length ?? 0} currentHistory=${runner.actionHistory?.length ?? 0} stateKey=${frame?.stateKey ?? '<none>'} ancestors=${Array.isArray(frame?.ancestorStateKeys) ? frame.ancestorStateKeys.length : 0} nextAction=${nextAction} decision=${formatDebugDecision(runner.currentDecision)} actionWindow=${summarizeFrameActionsForLog(frame)} error=${err?.message ?? String(err)}`,
      );
      recordSample('frames', 'unrestorable-frame-fatal', {
        phase,
        depth: frame?.depth ?? -1,
        nextIndex: frame?.nextIndex ?? -1,
        actionCount,
        targetHistory: frame?.baseState?.history?.length ?? 0,
        currentHistory: runner.actionHistory?.length ?? 0,
        stateKey: frame?.stateKey ?? '',
        ancestorStateKeys: Array.isArray(frame?.ancestorStateKeys) ? frame.ancestorStateKeys.length : 0,
        nextAction,
        decision: formatDebugDecision(runner.currentDecision),
        error: err?.message ? String(err.message).slice(0, 160) : String(err).slice(0, 160),
      });
      chain.length = 0;
      scoreTrace = [];
      bestScoreRecord = null;
      activeFrame = null;
      emitCheckpoint();
      throw err;
    };

    const logFrameRestoreFailed = (phase, frame, err) => {
      const actionCount = Array.isArray(frame?.actions) ? frame.actions.length : 0;
      const nextAction = actionCount > 0 ? summarizeSearchActionForLog(frame.actions[frame?.nextIndex ?? 0]) : '<none>';
      console.error(
        `[search-frame-restore-failed] phase=${phase} depth=${frame?.depth ?? -1} nextIndex=${frame?.nextIndex ?? -1}/${actionCount} targetHistory=${frame?.baseState?.history?.length ?? 0} currentHistory=${runner.actionHistory?.length ?? 0} stateKey=${frame?.stateKey ?? '<none>'} ancestors=${Array.isArray(frame?.ancestorStateKeys) ? frame.ancestorStateKeys.length : 0} nextAction=${nextAction} decision=${formatDebugDecision(runner.currentDecision)} actionWindow=${summarizeFrameActionsForLog(frame)} error=${err?.message ?? String(err)}`,
      );
    };

    const buildFrontierFrameFromCurrentState = (
      depth,
      nodeHardLimit = effectiveNodeLimit,
      ancestorStateKeys = [],
    ) => {
      const current = runner.currentDecision;
      if (!current || current.terminal || !current.actions?.length) return null;
      if (depthLimited && depth >= opts.maxDepth) return null;
      const sortedActions = getSortedSearchActions(current);
      const shouldBalanceCardChoices = shouldBalanceSearchChoices(current, sortedActions, depth);
      const stateKey = buildCurrentDecisionStateKey(runner);
      const lineageStateKeys = stateKey
        ? [...cloneExactStateKeyPath(ancestorStateKeys), stateKey]
        : cloneExactStateKeyPath(ancestorStateKeys);
      return {
        depth,
        nextIndex: 0,
        exploredChild: false,
        snapshot: null,
        frameKind: 'pause',
        stateKey,
        ancestorStateKeys: lineageStateKeys,
        nodeHardLimit,
        shouldBalanceCardChoices,
        perChoiceBudget: shouldBalanceCardChoices
          ? computePerChoiceBudget(nodeHardLimit, sortedActions.length)
          : 0,
        actions: sortedActions.map((action) => serializeSearchAction(action)),
        baseState: serializeHistoryState(runner.saveState('exact.frontier.pause')),
        scoreTrace: cloneScoreTrace(scoreTrace),
        bestScoreRecord: normalizeBestScoreRecord(bestScoreRecord),
      };
    };

    const prepareCurrentFrontier = (
      startDepth,
      nodeHardLimit = effectiveNodeLimit,
      ancestorStateKeys = [],
    ) => {
      let depth = startDepth;
      const seenStateKeys = new Set(cloneExactStateKeyPath(ancestorStateKeys));
      while (best.nodes < effectiveNodeLimit && best.nodes < nodeHardLimit) {
        const current = runner.currentDecision;
        const currentStateKey = buildCurrentDecisionStateKey(runner);

        if (currentStateKey) {
          if (seenStateKeys.has(currentStateKey)) {
            bumpCounter('cyclePrunedTerminals');
            recordSample('frontier', 'cycle-pruned', {
              depth,
              chainTail: chain.slice(-6),
              decisionName: current?.message?.constructor?.name ?? '',
            });
            settleTerminal(chain, null, 'CYCLE_PRUNED', () => runner.saveResultState());
            return null;
          }
          seenStateKeys.add(currentStateKey);
        }

        if (!current || current.terminal || !current.actions?.length) {
          settleTerminal(chain, null, current?.reason ?? 'NO_ACTION_OR_NULL', () => runner.saveResultState());
          return null;
        }
        if (depthLimited && depth >= opts.maxDepth) {
          settleTerminal(chain, null, 'MAX_DEPTH', () => runner.saveResultState());
          return null;
        }

        const sortedActions = getSortedSearchActions(current);
        if (sortedActions.length !== 1) {
          const shouldBalanceCardChoices = shouldBalanceSearchChoices(current, sortedActions, depth);
          const perChoiceBudget = shouldBalanceCardChoices
            ? computePerChoiceBudget(nodeHardLimit, sortedActions.length)
            : 0;
          if (debugCollector?.noteBranch) {
            debugCollector.noteBranch({
              depth,
              actionCount: sortedActions.length,
              shouldBalanceCardChoices,
              decisionName: current?.message?.constructor?.name ?? '',
              chain,
              actions: sortedActions,
              snapshot: typeof runner.captureSnapshot === 'function' ? runner.captureSnapshot() : null,
            });
          }
          const stateKey = currentStateKey || buildCurrentDecisionStateKey(runner);
          const lineageStateKeys = stateKey
            ? [...cloneExactStateKeyPath(ancestorStateKeys), stateKey]
            : cloneExactStateKeyPath(ancestorStateKeys);
          return {
            depth,
            nextIndex: 0,
            exploredChild: false,
            snapshot: null,
            frameKind: 'branch',
            stateKey,
            ancestorStateKeys: lineageStateKeys,
            nodeHardLimit,
            shouldBalanceCardChoices,
            perChoiceBudget,
            actions: sortedActions.map((action) => serializeSearchAction(action)),
            baseState: serializeHistoryState(runner.saveState('exact.frontier.branch')),
            scoreTrace: cloneScoreTrace(scoreTrace),
            bestScoreRecord: normalizeBestScoreRecord(bestScoreRecord),
          };
        }

        const forcedAction = sortedActions[0];
        runner.step(forcedAction);
        best.nodes += 1;
        bumpCounter('forcedActionSteps');
        depth += 1;
        chain.push(forcedAction.label);
        recordCurrentScoreTraceStep(chain);
        maybeReportProgress(depth);
        emitCheckpoint(false, () => runner.saveState('exact.checkpoint.forced'), [...seenStateKeys]);

        if (forcedAction.kind === 'phase_end') {
          settleTerminal(chain, null, 'TURN_END', () => runner.saveResultState());
          return null;
        }
        if (settleCurrentDecisionIfTerminal()) {
          return null;
        }
        if (hasReachedEffectiveNodeLimit()) {
          return null;
        }
      }
      if (best.nodes < effectiveNodeLimit && best.nodes >= nodeHardLimit) {
        bumpCounter('frontierHardLimitExits');
        if (debugCollector?.noteBudgetCutoff) {
          debugCollector.noteBudgetCutoff({
            depth,
            nodes: best.nodes,
            nodeHardLimit,
            chain,
            snapshot: typeof runner.captureSnapshot === 'function' ? runner.captureSnapshot() : null,
          });
        }
        return buildFrontierFrameFromCurrentState(depth, nodeHardLimit, [...seenStateKeys]);
      }
      if (best.nodes >= effectiveNodeLimit) {
        return buildFrontierFrameFromCurrentState(depth, nodeHardLimit, [...seenStateKeys]);
      }
      return null;
    };

    try {
      runner.restoreState(rootState);
    } catch (err) {
      console.error(
        `[search-root-restore-failed] history=${runner.actionHistory?.length ?? 0} targetHistory=${rootState?.history?.length ?? 0} decision=${formatDebugDecision(runner.currentDecision)}`,
      );
      throw err;
    }
    syncCurrentChainFromState(rootState);
    if (stack.length === 0) {
      const rootDepth = Array.isArray(rootState?.history) ? rootState.history.length : 0;
      maybeReportProgress(rootDepth, true);
      const rootFrame = prepareCurrentFrontier(rootDepth, effectiveNodeLimit, rootAncestorStateKeys);
      if (rootFrame) {
        stack.push(rootFrame);
        bumpCounter('stackPushes');
        setCounterMax('maxStackSize', stack.length);
        recordSample('frames', 'push-root-frame', {
          depth: rootFrame.depth,
          actionCount: rootFrame.actions.length,
          shouldBalanceCardChoices: !!rootFrame.shouldBalanceCardChoices,
        });
        activeFrame = rootFrame;
      }
    } else if (stack.length > 0) {
      let top = stack[stack.length - 1];
      try {
        restoreExactSearchFrameState(runner, top, 'resume');
      } catch (err) {
        logFrameRestoreFailed('resume', top, err);
        dropUnrestorableFrame('resume', top, err);
        maybeReportProgress(Number.isFinite(top?.depth) ? top.depth : chain.length, true);
        activeFrame = null;
        top = null;
      }
      if (top) {
        syncCurrentChainFromState(top.baseState);
        restoreScoreTrackerFromFrame(top);
        activeFrame = top;
        maybeReportProgress(Number.isFinite(top?.depth) ? top.depth : chain.length, true);
      }
    }

    while (stack.length > 0 && best.nodes < effectiveNodeLimit) {
      if (hasReachedTargetTerminalLimit()) break;
      const frame = stack[stack.length - 1];
      if (frame !== activeFrame) {
        try {
          restoreExactSearchFrameState(runner, frame, 'loop');
        } catch (err) {
          logFrameRestoreFailed('loop', frame, err);
          dropUnrestorableFrame('loop', frame, err);
          continue;
        }
        syncCurrentChainFromState(frame.baseState);
        restoreScoreTrackerFromFrame(frame);
        activeFrame = frame;
      }
      syncCurrentChainFromState(frame.baseState);
      restoreScoreTrackerFromFrame(frame);

      if (frame.nextIndex >= frame.actions.length) {
        bumpCounter('frameExhausted');
        if (!frame.exploredChild && !hasReachedEffectiveNodeLimit() && !hasReachedTargetTerminalLimit()) {
          settleTerminal(
            chain,
            frame.snapshot,
            'NO_ACTION_EXPLORED',
            () => runner.saveResultState(),
          );
        }
        stack.pop();
        bumpCounter('stackPops');
        recordSample('frames', 'pop-frame', {
          depth: frame.depth,
          actionCount: frame.actions.length,
          exploredChild: !!frame.exploredChild,
          remainingStack: stack.length,
          nodes: best.nodes,
        });
        if (stack.length === 0 && best.nodes < effectiveNodeLimit) {
          bumpCounter('frontierEmptiedBeforeMaxNodes');
          recordSample('frontier', 'stack-emptied', {
            nodes: best.nodes,
            maxNodes: Number.isFinite(effectiveNodeLimit) ? effectiveNodeLimit : opts.maxNodes,
            reason: 'frame_exhausted',
            chainTail: chain.slice(-6),
          });
        }
        activeFrame = null;
        emitCheckpoint();
        continue;
      }

      const encodedAction = frame.actions[frame.nextIndex];
      frame.nextIndex += 1;
      const childLimit = frame.shouldBalanceCardChoices
        ? Math.min(
            frame.nodeHardLimit ?? effectiveNodeLimit,
            best.nodes + Math.max(1, frame.perChoiceBudget ?? 1),
          )
        : (frame.nodeHardLimit ?? effectiveNodeLimit);
      const action = resolveExactSearchFrameAction(runner, encodedAction);
      if (!action) {
        bumpCounter('staleFrameActions');
        recordSample('frames', 'stale-frame-action', {
          depth: frame.depth,
          label: encodedAction?.label ?? '',
          kind: encodedAction?.kind ?? '',
          decisionName: runner.currentDecision?.message?.constructor?.name ?? '',
          nextIndex: frame.nextIndex,
          actionCount: frame.actions.length,
        });
        emitCheckpoint();
        maybeReportProgress(frame.depth);
        continue;
      }
      runner.step(action);
      best.nodes += 1;
      frame.exploredChild = true;
      chain.push(action.label);

      const childDepth = frame.depth + 1;
      recordCurrentScoreTraceStep(chain);
      maybeReportProgress(childDepth);

      if (action.kind === 'phase_end') {
        settleTerminal(chain, null, 'TURN_END', () => runner.saveResultState());
        chain.length = frame.depth;
        activeFrame = null;
        emitCheckpoint();
        maybeReportProgress(childDepth);
        continue;
      }

      if (settleCurrentDecisionIfTerminal()) {
        chain.length = frame.depth;
        activeFrame = null;
        emitCheckpoint();
        maybeReportProgress(childDepth);
        continue;
      }

      if (hasReachedEffectiveNodeLimit()) {
        const pausedChildFrame = buildFrontierFrameFromCurrentState(
          childDepth,
          childLimit,
          cloneExactStateKeyPath(frame.ancestorStateKeys),
        );
        if (pausedChildFrame) {
          stack.push(pausedChildFrame);
          bumpCounter('stackPushes');
          setCounterMax('maxStackSize', stack.length);
        }
        chain.length = frame.depth;
        activeFrame = null;
        emitCheckpoint();
        maybeReportProgress(childDepth);
        continue;
      }

      const nextFrame = prepareCurrentFrontier(
        childDepth,
        childLimit,
        cloneExactStateKeyPath(frame.ancestorStateKeys),
      );
      if (!nextFrame) {
        if (best.nodes < effectiveNodeLimit && frame.nextIndex < frame.actions.length) {
          try {
            restoreExactSearchFrameState(runner, frame, 'resume-current');
          } catch (err) {
            logFrameRestoreFailed('resume-current', frame, err);
            dropUnrestorableFrame('resume-current', frame, err);
            emitCheckpoint();
            maybeReportProgress(childDepth);
            continue;
          }
          syncCurrentChainFromState(frame.baseState);
          restoreScoreTrackerFromFrame(frame);
          activeFrame = frame;
        } else {
          if (frame.nextIndex >= frame.actions.length) {
            stack.pop();
            bumpCounter('stackPops');
            recordSample('frames', 'pop-frame-no-next', {
              depth: frame.depth,
              actionCount: frame.actions.length,
              remainingStack: stack.length,
              nodes: best.nodes,
            });
            if (stack.length === 0 && best.nodes < effectiveNodeLimit) {
              bumpCounter('frontierEmptiedBeforeMaxNodes');
              recordSample('frontier', 'stack-emptied', {
                nodes: best.nodes,
                maxNodes: Number.isFinite(effectiveNodeLimit) ? effectiveNodeLimit : opts.maxNodes,
                reason: 'no_next_frame',
                chainTail: chain.slice(-6),
              });
            }
          }
          activeFrame = null;
        }
        emitCheckpoint();
        maybeReportProgress(childDepth);
        continue;
      }
      const shouldRestoreSibling =
        frame.shouldBalanceCardChoices &&
        best.nodes < effectiveNodeLimit &&
        frame.nextIndex < frame.actions.length;
      if (shouldRestoreSibling) {
        stack.splice(Math.max(0, stack.length - 1), 0, nextFrame);
      } else {
        stack.push(nextFrame);
      }
      bumpCounter('stackPushes');
      setCounterMax('maxStackSize', stack.length);
      recordSample('frames', 'push-frame', {
        parentDepth: frame.depth,
        depth: nextFrame.depth,
        actionCount: nextFrame.actions.length,
        shouldBalanceCardChoices: !!nextFrame.shouldBalanceCardChoices,
        childLimit,
        remainingParentActions: Math.max(0, frame.actions.length - frame.nextIndex),
      });
      if (shouldRestoreSibling) {
        try {
          restoreExactSearchFrameState(runner, frame, 'restore-sibling');
        } catch (err) {
          logFrameRestoreFailed('restore-sibling', frame, err);
          dropUnrestorableFrame('restore-sibling', frame, err);
          activeFrame = nextFrame;
          emitCheckpoint();
          continue;
        }
        syncCurrentChainFromState(frame.baseState);
        restoreScoreTrackerFromFrame(frame);
        activeFrame = frame;
      } else {
        if (frame.nextIndex >= frame.actions.length) {
          const frameIndex = stack.indexOf(frame);
          if (frameIndex >= 0) {
            stack.splice(frameIndex, 1);
            bumpCounter('stackPops');
          }
        }
        activeFrame = nextFrame;
      }
      emitCheckpoint();
    }

    try {
      runner.restoreState(rootState);
    } catch (err) {
      console.error(
        `[search-root-restore-failed] phase=finalize history=${runner.actionHistory?.length ?? 0} targetHistory=${rootState?.history?.length ?? 0}`,
      );
      recordSample('frames', 'finalize-root-restore-failed', {
        targetHistory: rootState?.history?.length ?? 0,
        error: err?.message ? String(err.message).slice(0, 160) : String(err).slice(0, 160),
      });
    }
    const stackHasPendingWork = stack.length > 0;
    const endedByGlobalNodeLimit = stackHasPendingWork && hasReachedGlobalNodeLimit();
    const endedByNodeBudget =
      stackHasPendingWork &&
      !endedByGlobalNodeLimit &&
      hasReachedSliceNodeLimit();
    const endedByTargetTerminals = hasReachedTargetTerminalLimit();
    const searchCompleted = !stackHasPendingWork && !endedByTargetTerminals;
    if (best.topPaths.length === 0 && searchCompleted) {
      settleTerminal([], null, 'NO_RESULT', rootState);
    }
    best.completed = searchCompleted;
    best.stopReason = searchCompleted
      ? 'DONE'
      : endedByGlobalNodeLimit
        ? 'MAX_NODES'
        : endedByNodeBudget
          ? 'NODE_BUDGET'
          : 'TARGET_TERMINALS';
    emitCheckpoint(true);
    best.resumeState = searchCompleted ? null : buildCurrentResumeState();
    if (onProgress) {
      onProgress({
        nodes: best.nodes,
        maxNodes: opts.maxNodes,
        terminalCount: best.terminalCount,
        currentDepth: 0,
        ...buildTopPathProgress(best),
        done: true,
      });
    }
    best.debugSummary = debugCollector?.finalize
      ? debugCollector.finalize({
          nodes: best.nodes,
          terminalCount: best.terminalCount,
          topDepth: best.topPaths[0]?.depth ?? 0,
          topScore: best.topPaths[0]?.score ?? 0,
          stackExhaustedBeforeMaxNodes: stack.length === 0 && best.nodes < effectiveNodeLimit,
          remainingStack: stack.length,
          endedByMaxNodes: endedByGlobalNodeLimit,
          endedByNodeBudget,
        })
      : null;
    return best;
  }

  function createEmptySearchCoreResult() {
    return {
      nodes: 0,
      terminalCount: 0,
      topPaths: [],
      completed: true,
      stopReason: 'DONE',
    };
  }

  function cloneSearchCoreResult(result) {
    return deserializeSearchCoreResult(serializeSearchCoreResult(result));
  }

  function mergeSearchCoreResults(results, topK = DEFAULT_OPTIONS.topK, options = {}) {
    const mergePolicy =
      options && typeof options === 'object' && options.topPathPolicy && typeof options.topPathPolicy === 'object'
        ? options.topPathPolicy
        : null;
    const merged = createEmptySearchCoreResult();
    let mergedCompleted = true;
    let mergedStopReason = 'DONE';
    for (const item of results ?? []) {
      if (!item || typeof item !== 'object') continue;
      merged.nodes += item.nodes ?? 0;
      merged.terminalCount += item.terminalCount ?? 0;
      const itemCompleted = item.completed !== false;
      if (!itemCompleted) {
        mergedCompleted = false;
        if (mergedStopReason === 'DONE') {
          mergedStopReason = normalizeSearchStopReason(item.stopReason, 'UNKNOWN');
        }
      }
      if (Array.isArray(item.topPaths) && item.topPaths.length > 0) {
        merged.topPaths.push(
          ...item.topPaths.map((candidate) => ({
            ...candidate,
            chain: Array.isArray(candidate?.chain) ? candidate.chain.slice() : [],
            state: candidate?.state ? cloneHistoryState(candidate.state) : null,
          })),
        );
      }
    }
    if (policyDefined(mergePolicy)) {
      merged.topPaths = applyTopPathPolicyBatch(merged.topPaths, topK, mergePolicy);
    } else {
      merged.topPaths.sort(compareTopPathCandidates);
      if (merged.topPaths.length > topK) merged.topPaths.length = topK;
    }
    merged.completed = mergedCompleted;
    merged.stopReason = mergedCompleted ? 'DONE' : mergedStopReason;
    return merged;
  }

  function splitExactResumeStateFrontier(resumeState, targetCount = 1) {
    const decoded = deserializeExactSearchResumeState(resumeState);
    if (!decoded) return [];
    const maxShards = Math.max(1, targetCount | 0);
    const shards = [];
    const emptyBest = createEmptySearchCoreResult();
    const stack = Array.isArray(decoded.stack) ? decoded.stack : [];
    const frames = stack.slice().reverse();

    const buildResumeFromFrame = (frame, actions) => {
      const baseState = cloneHistoryState(frame?.baseState ?? decoded.rootState);
      const splitFrame = {
        ...frame,
        nextIndex: 0,
        actions: actions.map((action) => ({ ...action })),
        baseState,
        ancestorStateKeys: cloneExactStateKeyPath(frame?.ancestorStateKeys),
      };
      return serializeExactSearchResumeState({
        rootState: baseState,
        rootAncestorStateKeys: cloneExactStateKeyPath(frame?.ancestorStateKeys),
        best: createEmptySearchCoreResult(),
        chain: buildChainFromHistoryState(baseState),
        stack: [splitFrame],
      });
    };

    for (const frame of frames) {
      const actions = Array.isArray(frame?.actions) ? frame.actions : [];
      const startIndex = Math.max(0, frame?.nextIndex | 0);
      const remainingActions = actions.slice(startIndex);
      if (remainingActions.length === 0) continue;
      const remainingSlots = Math.max(1, maxShards - shards.length);
      const chunkCount = Math.min(remainingSlots, remainingActions.length);
      for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
        const chunkActions = remainingActions.filter((_, index) => index % chunkCount === chunkIndex);
        if (chunkActions.length === 0) continue;
        shards.push(buildResumeFromFrame(frame, chunkActions));
      }
    }

    if (shards.length > 0) return shards;
    return [serializeExactSearchResumeState({
      ...decoded,
      best: emptyBest,
    })];
  }

  function planExactSearchShards(runner, opts = {}) {
    const topK = Math.max(1, opts.topK ?? DEFAULT_OPTIONS.topK);
    const seedTopPathPolicy =
      opts.topPathPolicy && typeof opts.topPathPolicy === 'object' ? opts.topPathPolicy : null;
    const maxNodes = Math.max(1, opts.maxNodes ?? DEFAULT_OPTIONS.maxNodes);
    const targetShardCount = Math.max(1, opts.targetShardCount ?? 1);
    const maxSplitDepth = Math.max(0, opts.maxSplitDepth ?? 10);
    const seedNodeBudget = Math.max(
      1,
      Math.min(
        maxNodes,
        opts.seedNodeBudget ?? Math.min(1024, Math.max(1, Math.floor(maxNodes / 8))),
      ),
    );
    const depthLimited = Number.isFinite(opts.maxDepth) && opts.maxDepth > 0;
    const shouldRecordIntermediateScoredStates = opts.recordIntermediateScoredStates === true;
    const searchStartedAtMs = Number.isFinite(Number(opts.searchStartedAtMs ?? opts.startedAtMs))
      ? Number(opts.searchStartedAtMs ?? opts.startedAtMs)
      : Date.now();
    const rootState = cloneHistoryState(runner.saveState('plan.root'));
    const seedResult = createEmptySearchCoreResult();
    const plannedShards = [];
    let seedScoreTrace = [];
    let seedBestScoreRecord = null;

    const buildSeedTraceEntry = (chainValue, scored) => {
      const depth = Array.isArray(chainValue) ? chainValue.length : 0;
      return {
        depth,
        label: depth > 0 ? String(chainValue[depth - 1] ?? '') : '[root]',
        score: Number.isFinite(Number(scored?.score)) ? Number(scored.score) : 0,
      };
    };

    const buildUnavailableSeedTraceEntry = (chainValue, err = null) => {
      const depth = Array.isArray(chainValue) ? chainValue.length : 0;
      return {
        depth,
        label: depth > 0 ? String(chainValue[depth - 1] ?? '') : '[root]',
        score: 0,
        scoreUnavailable: true,
        error: err?.message ? String(err.message).slice(0, 160) : 'snapshot unavailable',
      };
    };

    const captureSeedScoredTracePoint = (chainValue) => {
      if (isSnapshotUnavailableTerminalDecision(runner.currentDecision)) {
        return {
          rawSnapshot: null,
          scored: null,
          entry: buildUnavailableSeedTraceEntry(chainValue, {
            message: runner.currentDecision?.reason ?? 'terminal snapshot unavailable',
          }),
          ok: false,
        };
      }
      try {
        const rawSnapshot = runner.captureSnapshot();
        const scored = runner.scoreSnapshotDetailed(rawSnapshot);
        return {
          rawSnapshot,
          scored,
          entry: buildSeedTraceEntry(chainValue, scored),
          ok: true,
        };
      } catch (err) {
        return {
          rawSnapshot: null,
          scored: null,
          entry: buildUnavailableSeedTraceEntry(chainValue, err),
          ok: false,
        };
      }
    };

    const settleSeedTerminal = (
      chainValue,
      snapshotOverride = null,
      reasonHint = '',
      stateOverride = null,
    ) => {
      const captured = snapshotOverride
        ? (() => {
            const scored = runner.scoreSnapshotDetailed(snapshotOverride);
            return {
              rawSnapshot: snapshotOverride,
              scored,
              entry: buildSeedTraceEntry(chainValue, scored),
              ok: true,
            };
          })()
        : captureSeedScoredTracePoint(chainValue);
      const scored = captured.scored;
      const terminalDepth = chainValue.length;
      let terminalTrace = [];
      let representative = null;
      let representativeSnapshot = scored?.snapshot ?? seedBestScoreRecord?.snapshot ?? null;
      let representativeBreakdown = cloneScoreBreakdown(scored?.breakdown);

      if (shouldRecordIntermediateScoredStates) {
        terminalTrace = cloneScoreTrace(seedScoreTrace);
        const lastTrace = terminalTrace[terminalTrace.length - 1] ?? null;
        if (!lastTrace || lastTrace.depth !== terminalDepth) {
          const terminalEntry = captured.entry;
          terminalTrace.push(terminalEntry);
          if (captured.ok && isScoreTraceEntryBetter(terminalEntry, seedBestScoreRecord)) {
            seedBestScoreRecord = {
              ...terminalEntry,
              snapshot: scored.snapshot,
              scoreBreakdown: cloneScoreBreakdown(scored.breakdown),
            };
          }
        }
        representative = selectBestScoreTraceEntry(terminalTrace) ?? captured.entry;
        if (
          seedBestScoreRecord &&
          seedBestScoreRecord.depth === representative?.depth &&
          Number(seedBestScoreRecord.score) === Number(representative?.score)
        ) {
          representativeSnapshot = seedBestScoreRecord.snapshot ?? scored?.snapshot ?? null;
          representativeBreakdown = cloneScoreBreakdown(seedBestScoreRecord.scoreBreakdown);
        }
      } else {
        representative = captured.entry;
        terminalTrace = [representative];
      }
      const bestDepth = Math.max(0, Math.min(terminalDepth, representative?.depth ?? terminalDepth));
      const candidate = {
        chain: chainValue.slice(0, bestDepth),
        depth: bestDepth,
        score: representative?.score ?? 0,
        reason: reasonHint,
        terminalDepth,
        terminalReason: reasonHint,
        bestScoreDepth: bestDepth,
        scoreTrace: terminalTrace,
        scoreBreakdown: representativeBreakdown,
        ...buildRouteFoundMeta(searchStartedAtMs, seedResult.nodes, seedResult.terminalCount + 1),
        snapshot: representativeSnapshot,
        state: null,
      };
      seedResult.terminalCount += 1;
      if (policyDefined(seedTopPathPolicy)) {
        const kept = applyTopPathPolicy(seedResult.topPaths, candidate, topK, seedTopPathPolicy);
        if (kept) {
          const resolvedState =
            typeof stateOverride === 'function'
              ? stateOverride()
              : stateOverride;
          candidate.state = resolvedState ? truncateHistoryStateToDepth(resolvedState, bestDepth) : null;
        }
        return;
      }
      const worst = seedResult.topPaths[topK - 1] ?? null;
      const shouldKeepState =
        seedResult.topPaths.length < topK ||
        isTopPathCandidateBetter(candidate, worst);
      if (shouldKeepState) {
        const resolvedState =
          typeof stateOverride === 'function'
            ? stateOverride()
            : stateOverride;
        candidate.state = resolvedState ? truncateHistoryStateToDepth(resolvedState, bestDepth) : null;
      }
      seedResult.topPaths.push(candidate);
      seedResult.topPaths.sort(compareTopPathCandidates);
      if (seedResult.topPaths.length > topK) seedResult.topPaths.length = topK;
    };

    const recordSeedScoreTraceStep = () => {
      if (!shouldRecordIntermediateScoredStates) return;
      const state = runner.saveResultState();
      const chainValue = buildChainFromHistoryState(state);
      const point = captureSeedScoredTracePoint(chainValue);
      const entry = point.entry;
      if (seedScoreTrace.length >= entry.depth) {
        seedScoreTrace.length = Math.max(0, entry.depth - 1);
      }
      seedScoreTrace.push(entry);
      if (point.ok && isScoreTraceEntryBetter(entry, seedBestScoreRecord)) {
        seedBestScoreRecord = {
          ...entry,
          snapshot: point.scored.snapshot,
          scoreBreakdown: cloneScoreBreakdown(point.scored.breakdown),
        };
      }
    };

    const buildShardResumeState = (state, rootAncestorStateKeys = []) =>
      serializeExactSearchResumeState({
        rootState: cloneHistoryState(state),
        rootAncestorStateKeys: cloneExactStateKeyPath(rootAncestorStateKeys),
        best: createEmptySearchCoreResult(),
        chain: buildChainFromHistoryState(state),
        scoreTrace: seedScoreTrace,
        bestScoreRecord: seedBestScoreRecord,
        stack: [],
      });

    const buildActionSubsetResumeState = (
      state,
      rootAncestorStateKeys,
      frameStateKey,
      frameAncestorStateKeys,
      actions,
      scoreTraceOverride,
      bestScoreRecordOverride,
    ) => {
      const baseState = cloneHistoryState(state);
      const scoreTraceSnapshot = cloneScoreTrace(scoreTraceOverride);
      const bestScoreSnapshot = normalizeBestScoreRecord(bestScoreRecordOverride);
      return serializeExactSearchResumeState({
        rootState: baseState,
        rootAncestorStateKeys: cloneExactStateKeyPath(rootAncestorStateKeys),
        best: createEmptySearchCoreResult(),
        chain: buildChainFromHistoryState(baseState),
        scoreTrace: scoreTraceSnapshot,
        bestScoreRecord: bestScoreSnapshot,
        stack: [{
          depth: Array.isArray(baseState.history) ? baseState.history.length : 0,
          nextIndex: 0,
          exploredChild: false,
          snapshot: null,
          frameKind: 'plan.shard',
          stateKey: typeof frameStateKey === 'string' ? frameStateKey : '',
          ancestorStateKeys: cloneExactStateKeyPath(frameAncestorStateKeys),
          nodeHardLimit: null,
          shouldBalanceCardChoices: false,
          perChoiceBudget: 0,
          actions: actions.map((action) => serializeSearchAction(action)),
          baseState: serializeHistoryState(baseState),
          scoreTrace: scoreTraceSnapshot,
          bestScoreRecord: bestScoreSnapshot,
        }],
      });
    };

    const buildCurrentShard = (rootAncestorStateKeys, splitDepth, actionCount = 0) => ({
      resumeState: buildShardResumeState(runner.saveState('plan.shard.boundary'), rootAncestorStateKeys),
      splitDepth,
      actionCount: Math.max(0, actionCount | 0),
    });

    const advanceToShardBoundary = (startDepth, rootAncestorStateKeys, splitDepth) => {
      let depth = startDepth;
      const seenStateKeys = new Set(cloneExactStateKeyPath(rootAncestorStateKeys));
      while (seedResult.nodes < seedNodeBudget && seedResult.nodes < maxNodes) {
        const current = runner.currentDecision;
        const currentStateKey = buildCurrentDecisionStateKey(runner);

        if (currentStateKey) {
          if (seenStateKeys.has(currentStateKey)) {
            settleSeedTerminal(
              buildChainFromHistoryState(runner.saveResultState()),
              null,
              'CYCLE_PRUNED',
              () => runner.saveResultState(),
            );
            return null;
          }
          seenStateKeys.add(currentStateKey);
        }

        if (!current || current.terminal || !current.actions?.length) {
          settleSeedTerminal(
            buildChainFromHistoryState(runner.saveResultState()),
            null,
            current?.reason ?? 'NO_ACTION_OR_NULL',
            () => runner.saveResultState(),
          );
          return null;
        }
        if (depthLimited && depth >= opts.maxDepth) {
          settleSeedTerminal(
            buildChainFromHistoryState(runner.saveResultState()),
            null,
            'MAX_DEPTH',
            () => runner.saveResultState(),
          );
          return null;
        }

        const sortedActions = getSortedSearchActions(current);
        if (sortedActions.length !== 1) {
          return buildCurrentShard(rootAncestorStateKeys, splitDepth, sortedActions.length);
        }

        const forcedAction = sortedActions[0];
        runner.step(forcedAction);
        seedResult.nodes += 1;
        depth += 1;
        recordSeedScoreTraceStep();

        if (forcedAction.kind === 'phase_end') {
          settleSeedTerminal(
            buildChainFromHistoryState(runner.saveResultState()),
            null,
            'TURN_END',
            () => runner.saveResultState(),
          );
          return null;
        }
        if (seedResult.nodes >= maxNodes) {
          settleSeedTerminal(
            buildChainFromHistoryState(runner.saveResultState()),
            null,
            'MAX_NODES',
            () => runner.saveResultState(),
          );
          return null;
        }
      }

      if (seedResult.nodes < maxNodes) {
        return buildCurrentShard(rootAncestorStateKeys, splitDepth, runner.currentDecision?.actions?.length ?? 0);
      }
      return null;
    };

    const splitShard = (shard) => {
      const resumeState = deserializeExactSearchResumeState(shard?.resumeState);
      if (!resumeState?.rootState) {
        return [];
      }
      const branchState = cloneHistoryState(resumeState.rootState);
      const rootAncestorStateKeys = cloneExactStateKeyPath(resumeState.rootAncestorStateKeys);
      const branchScoreTrace = cloneScoreTrace(resumeState.scoreTrace);
      const branchBestScoreRecord = normalizeBestScoreRecord(resumeState.bestScoreRecord);
      seedScoreTrace = cloneScoreTrace(branchScoreTrace);
      seedBestScoreRecord = normalizeBestScoreRecord(branchBestScoreRecord);
      runner.restoreState(branchState);

      const current = runner.currentDecision;
      if (!current || current.terminal || !current.actions?.length) {
        settleSeedTerminal(
          buildChainFromHistoryState(branchState),
          null,
          current?.reason ?? 'NO_ACTION_OR_NULL',
          branchState,
        );
        return [];
      }

      const sortedActions = getSortedSearchActions(current);
      if (sortedActions.length <= 1 || shard.splitDepth >= maxSplitDepth) {
        return [{
          resumeState: shard.resumeState,
          splitDepth: maxSplitDepth,
          actionCount: sortedActions.length,
        }];
      }

      const currentStateKey = buildCurrentDecisionStateKey(runner);
      const childAncestorStateKeys = currentStateKey
        ? [...rootAncestorStateKeys, currentStateKey]
        : rootAncestorStateKeys;
      const nextSplitDepth = shard.splitDepth + 1;
      const nextDepth = Array.isArray(branchState.history) ? branchState.history.length + 1 : 1;
      const expanded = [];
      let actionIndex = 0;

      const buildPendingActionShard = (actions) => ({
        resumeState: buildActionSubsetResumeState(
          branchState,
          rootAncestorStateKeys,
          currentStateKey,
          childAncestorStateKeys,
          actions,
          branchScoreTrace,
          branchBestScoreRecord,
        ),
        splitDepth: nextSplitDepth,
        actionCount: actions.length,
      });

      for (; actionIndex < sortedActions.length; actionIndex += 1) {
        if (seedResult.nodes >= seedNodeBudget || seedResult.nodes >= maxNodes) break;
        const action = sortedActions[actionIndex];
        runner.restoreState(branchState);
        seedScoreTrace = cloneScoreTrace(branchScoreTrace);
        seedBestScoreRecord = normalizeBestScoreRecord(branchBestScoreRecord);
        runner.step(action);
        seedResult.nodes += 1;
        recordSeedScoreTraceStep();

        if (action.kind === 'phase_end') {
          settleSeedTerminal(
            buildChainFromHistoryState(runner.saveResultState()),
            null,
            'TURN_END',
            () => runner.saveResultState(),
          );
          continue;
        }
        if (seedResult.nodes >= maxNodes) {
          settleSeedTerminal(
            buildChainFromHistoryState(runner.saveResultState()),
            null,
            'MAX_NODES',
            () => runner.saveResultState(),
          );
          continue;
        }

        const childShard = advanceToShardBoundary(nextDepth, childAncestorStateKeys, nextSplitDepth);
        if (childShard) expanded.push(childShard);
      }

      if (actionIndex < sortedActions.length && seedResult.nodes < maxNodes) {
        for (const action of sortedActions.slice(actionIndex)) {
          expanded.push(buildPendingActionShard([action]));
        }
      }
      return expanded;
    };

    try {
      runner.restoreState(rootState);
      const rootShard = advanceToShardBoundary(
        Array.isArray(rootState.history) ? rootState.history.length : 0,
        [],
        0,
      );
      if (rootShard) plannedShards.push(rootShard);

      while (
        plannedShards.length < targetShardCount &&
        seedResult.nodes < maxNodes
      ) {
        plannedShards.sort((a, b) => b.actionCount - a.actionCount || a.splitDepth - b.splitDepth);
        const shardIndex = plannedShards.findIndex((item) => item.splitDepth < maxSplitDepth && item.actionCount > 1);
        if (shardIndex < 0) break;
        const [shard] = plannedShards.splice(shardIndex, 1);
        const expanded = splitShard(shard);
        if (expanded.length === 0) continue;
        plannedShards.push(...expanded);
      }
    } finally {
      runner.restoreState(rootState);
    }

    plannedShards.sort((a, b) => b.actionCount - a.actionCount || a.splitDepth - b.splitDepth);
    return {
      rootState: cloneHistoryState(rootState),
      seedNodeBudget,
      targetShardCount,
      maxSplitDepth,
      seedResult: cloneSearchCoreResult(seedResult),
      shards: plannedShards.map((shard, index) => ({
        shardId: index,
        splitDepth: shard.splitDepth,
        actionCount: shard.actionCount,
        resumeState: shard.resumeState,
      })),
    };
  }

  return {
    buildCurrentDecisionStateKey,
    cloneSearchCoreResult,
    deserializeExactSearchResumeState,
    deserializeSearchCoreResult,
    makeExactStateKey,
    makeExactStateKeyNoLp,
    mergeSearchCoreResults,
    planExactSearchShards,
    searchTopLongestPathsExactSingle,
    serializeExactSearchResumeState,
    serializeSearchCoreResult,
    splitExactResumeStateFrontier,
    sortActionsForLongestPath,
  };
}

module.exports = {
  createExactSearchApi,
};
