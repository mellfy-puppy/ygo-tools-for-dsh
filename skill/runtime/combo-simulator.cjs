#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const v8 = require('node:v8');
const { URL } = require('node:url');
const { createRequire } = require('node:module');
const { fork } = require('node:child_process');
const os = require('node:os');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const SCRIPT_DIR = __dirname;
const {
  requireSkillDependency,
  requireOptionalSkillDependency,
  resolveSkillDependency,
} = require(path.join(SCRIPT_DIR, 'src', 'vendor-require.cjs'));
process.env.KOISHIPRO_CORE_EFFECTIVE_HEAP_SNAPSHOT ??= '1';
process.env.KOISHIPRO_CORE_EFFECTIVE_HEAP_PADDING ??= '65536';
process.env.KOISHIPRO_CORE_EFFECTIVE_HEAP_ALIGN ??= '65536';
const {
  createOcgcoreWrapper,
  DirScriptReader,
  SqljsCardReader,
  _OcgcoreConstants,
} = requireSkillDependency('koishipro-core.js');

const appRequire = createRequire(path.join(process.cwd(), 'package.json'));
const koishiEntry = resolveSkillDependency('koishipro-core.js');
const koishiRequire = createRequire(koishiEntry);

function requirePreferApp(moduleName) {
  try {
    return requireSkillDependency(moduleName);
  } catch {
    try {
      return koishiRequire(moduleName);
    } catch {
      return appRequire(moduleName);
    }
  }
}

function requireOptional(moduleName) {
  return requireOptionalSkillDependency(moduleName);
}

const initSqlJsModule = requirePreferApp('sql.js');
const koffi = requireOptional('koffi');
const ygopro = requirePreferApp('ygopro-msg-encode');
const ygoproCdb = requireOptional('ygopro-cdb-encode');
const ygoproYrp = requireOptional('ygopro-yrp-encode');
const {
  normalizeExactSearchBackend,
  resolveExactSearchBackend,
} = require(path.join(SCRIPT_DIR, 'src', 'core', 'native', 'exact-search-backend.cjs'));
const {
  createExactSearchApi,
} = require(path.join(SCRIPT_DIR, 'src', 'core', 'search', 'exact-search.cjs'));
const { createExactParallelRuntimeApi } = require(path.join(SCRIPT_DIR, 'src', 'runtime', 'exact-parallel-runtime.cjs'));
const { createSnapshotAccelRuntimeApi } = require(path.join(SCRIPT_DIR, 'src', 'runtime', 'snapshot-accel-runtime.cjs'));
const { createWorkerEntryApi } = require(path.join(SCRIPT_DIR, 'src', 'runtime', 'worker-entry.cjs'));

const initSqlJs =
  typeof initSqlJsModule === 'function' ? initSqlJsModule : initSqlJsModule.default;

const {
  OcgcoreScriptConstants: SCRIPT,
  OcgcoreCommonConstants: COMMON,
} = _OcgcoreConstants;

const {
  LOCATION_DECK,
  LOCATION_EXTRA,
  LOCATION_HAND,
  LOCATION_MZONE,
  LOCATION_SZONE,
  LOCATION_GRAVE,
  LOCATION_REMOVED,
  LOCATION_FZONE,
  POS_FACEDOWN_DEFENSE,
} = SCRIPT;

const QUERY_FLAG_SNAPSHOT =
  COMMON.QUERY_CODE |
  COMMON.QUERY_TYPE |
  COMMON.QUERY_ATTACK |
  COMMON.QUERY_DEFENSE |
  COMMON.QUERY_POSITION |
  COMMON.QUERY_LINK;

const IDLE_CMD = {
  SUMMON: 0,
  SPSUMMON: 1,
  REPOS: 2,
  MSET: 3,
  SSET: 4,
  ACTIVATE: 5,
  TO_BP: 6,
  TO_EP: 7,
  SHUFFLE: 8,
};

const BATTLE_CMD = {
  ACTIVATE: 0,
  ATTACK: 1,
  TO_M2: 2,
  TO_EP: 3,
};

const DEFAULT_OPTIONS = {
  drawCount: 1,
  maxDepth: 300,
  maxNodes: 10000,
  maxBeamWidth: 20,
  maxActionsPerNode: 12,
  maxProcessPerStep: 2000,
  snapshotPoolSize: 512,
  seed: Date.now() >>> 0,
  topK: 20,
};
const HARD_DISABLE_SELECTCARD_CANCEL = process.env.COMBO_ALLOW_SELECTCARD_CANCEL !== '1';
const HARD_DISABLE_SELECT_UNSELECT_CANCEL = process.env.COMBO_ALLOW_SELECT_UNSELECT_CANCEL !== '1';

const CURRENT_DUEL_RULE = 5;
const CURRENT_DUEL_OPTIONS = CURRENT_DUEL_RULE << 16;
const NATIVE_BOOTSTRAP_PRELOAD_SCRIPTS = [
  './script/patches/entry.lua',
  './script/special.lua',
  './script/init.lua',
];

const MODERN_SNAPSHOT_POOL_MAX_ENTRIES = Math.max(
  128,
  toInt(process.env.COMBO_MODERN_SNAPSHOT_POOL_MAX_ENTRIES, 512),
);
const MODERN_SNAPSHOT_POOL_MAX_BYTES = Math.max(
  96 * 1024 * 1024,
  toInt(process.env.COMBO_MODERN_SNAPSHOT_POOL_MAX_BYTES, 384 * 1024 * 1024),
);
const MODERN_SNAPSHOT_PAGE_SIZE = Math.max(
  256,
  toInt(process.env.COMBO_SNAPSHOT_PAGE_SIZE, 2048),
);
const MODERN_SNAPSHOT_GPU_MIN_BYTES = MODERN_SNAPSHOT_PAGE_SIZE * 64;
const OCGCORE_SCRIPT_BUFFER_SIZE = Math.max(
  256 * 1024,
  toInt(process.env.COMBO_OCGCORE_SCRIPT_BUFFER_SIZE, 256 * 1024),
);
const OCGCORE_SNAPSHOT_MAGIC = Uint8Array.from([0x4b, 0x4f, 0x43, 0x47, 0x53, 0x4e, 0x50, 0x31]);
const OCGCORE_SNAPSHOT_HEADER_SIZE = OCGCORE_SNAPSHOT_MAGIC.length + 4;
const UTF8_DECODER = new TextDecoder('utf-8');

const DEFAULT_LIB_DIR = process.env.YGO_LIB_DIR
  ? path.resolve(String(process.env.YGO_LIB_DIR))
  : path.join(SCRIPT_DIR, '..', 'resources', 'lib');
const WEB_UI_DIR = path.join(process.cwd(), 'ui');
const WEB_ARCHIVE_DIR = path.join(process.cwd(), 'archives');
const WEB_ARCHIVE_ENABLED = process.env.YGO_ALLOW_FILE_WRITES === '1' && process.env.COMBO_WEB_ARCHIVE === '1';
const ROOT_SNAPSHOT_CACHE_DIR = path.join(
  process.env.YGO_CACHE_DIR ? path.resolve(String(process.env.YGO_CACHE_DIR)) : path.join(process.cwd(), '.cache'),
  'root-snapshots',
);
const ROOT_SNAPSHOT_CACHE_SCHEMA_VERSION = 3;
const ROOT_SNAPSHOT_CACHE_ENABLED = process.env.YGO_ALLOW_DIAGNOSTIC_FILES === '1' && process.env.COMBO_ROOT_SNAPSHOT_CACHE === '1';
const DEFAULT_WEB_REPLAY_OUTPUT_DIR = path.join(process.cwd(), 'replays', 'archive-generated');
const WEB_ARCHIVE_SCHEMA_VERSION = 1;
const WEB_SEARCH_ENGINE_VERSION = 7;
const WEB_ARCHIVE_CHECKPOINT_NODES = Math.max(
  100000,
  toInt(process.env.COMBO_WEB_ARCHIVE_CHECKPOINT_NODES, 1000000),
);
const WEB_SEARCH_RESUME_COMPATIBLE_TOPK = 64;
const DEFAULT_YGOPRO2_PICTURE_DIRS = (process.env.YGO_YGOPRO2_PICTURE_DIRS || '')
  .split(path.delimiter)
  .map((entry) => entry.trim())
  .filter(Boolean);
const DEFAULT_LOCAL_FILES = {
  deck: path.join(DEFAULT_LIB_DIR, 'slm.ydk'),
  cards: path.join(DEFAULT_LIB_DIR, 'cards.cdb'),
  scripts: path.join(DEFAULT_LIB_DIR, 'ygopro-scripts'),
};
const SNAPSHOT_ACCEL_DLL_PATH = (() => {
  const envOverride = process.env.COMBO_SNAPSHOT_ACCEL_DLL_PATH;
  if (envOverride) return path.resolve(String(envOverride));
  const candidatePaths = [
    path.join(process.cwd(), 'native', 'snapshot_accel.next.dll'),
    path.join(process.cwd(), 'native', 'snapshot_accel.dll'),
  ];
  return candidatePaths.find((candidate) => fs.existsSync(candidate)) ?? candidatePaths[0];
})();
const NATIVE_OCGCORE_DLL_PATH = process.env.COMBO_NATIVE_OCGCORE_DLL_PATH || process.env.YGO_GPU_OCGCORE_DLL_PATH || path.join(
  process.cwd(),
  '..',
  'ygopro-core',
  'build',
  'bin',
  'x64',
  'Release',
  'ocgcore.dll',
);

let snapshotAccelState;
// Keep GPU acceleration mandatory by default. "auto" is normalized to "gpu"
// so the runtime never silently drops to the CPU path on its own.
let snapshotAccelMode = 'gpu';
let snapshotStorageMode = 'delta';
const WEB_DEFAULT_WORKERS = 4;
const WEB_DEFAULT_SNAPSHOT_ACCEL_MODE = 'gpu';
const WEB_DEFAULT_SNAPSHOT_STORAGE_MODE = 'delta';
let coreProfileEnabled = false;
const coreProfileStats = new Map();
const webSearchJobs = new Map();

// 识别一组 WASM 运行时 trap，这些都对应 wasm 内部状态损坏（内存/函数表/控制流），
// 与 snapshot 恢复路径有关。触发后按两段台阶降级，尽量保住 GPU 加速。
// 之前只匹配 'memory access out of bounds'，导致 'null function or function signature
// mismatch' 这类 call_indirect trap 没法触发 fallback，3 次 retry 全部用同样的 gpu/delta
// 配置 spawn worker，3 次踩同一坏路径，3 次同样炸（2026-05-09 现场已观察到）。
const WASM_RUNTIME_FAULT_PATTERN =
  /memory access out of bounds|null function or function signature mismatch/i;

function isWasmRuntimeFaultError(reason) {
  return WASM_RUNTIME_FAULT_PATTERN.test(String(reason ?? ''));
}

// 兼容旧名（如有外部 require/测试引用），保留别名指向新实现。
const isWasmMemoryBoundsError = isWasmRuntimeFaultError;

// 两段台阶降级：根因大多在 delta 页合并恢复路径，先只换存储模式保住 GPU；
// 真到 GPU 加速器本身也坏的极端情况，再退到 cpu/full。CPU 穷举吞吐显著低于 GPU，
// 所以 gpu→cpu 这一档要尽量晚触发。
function nextSnapshotFallbackStep(prevAccelMode, prevStorageMode) {
  const accel = String(prevAccelMode ?? '').toLowerCase();
  const storage = String(prevStorageMode ?? '').toLowerCase();
  if (accel === 'gpu' && storage !== 'full') {
    // 第一档：保 GPU，只把 delta 页差分换成 full 全量镜像，绕开 delta 恢复路径。
    return { accelMode: 'gpu', storageMode: 'full', degree: 'storage-only' };
  }
  if (storage === 'full' && accel !== 'cpu') {
    // 第二档：full 也救不了，说明 GPU 加速器本身也有问题，退到 cpu/full。
    return { accelMode: 'cpu', storageMode: 'full', degree: 'full-degrade' };
  }
  return null; // 已在最稳模式，无可降
}

function applyStableSnapshotFallbackForRetry(job, requestBody, reason) {
  if (!isWasmRuntimeFaultError(reason)) return false;
  if (!requestBody || typeof requestBody !== 'object') return false;
  const previousStorageMode = String(requestBody.snapshotStorageMode ?? snapshotStorageMode ?? '').toLowerCase();
  const previousAccelMode = String(requestBody.snapshotAccelMode ?? snapshotAccelMode ?? '').toLowerCase();
  const step = nextSnapshotFallbackStep(previousAccelMode, previousStorageMode);
  if (!step) return false; // 已经是 cpu/full，再降也没意义
  requestBody.snapshotStorageMode = step.storageMode;
  requestBody.snapshotAccelMode = step.accelMode;
  if (job?.progress && typeof job.progress === 'object') {
    job.progress = {
      ...job.progress,
      snapshotStorageMode: requestBody.snapshotStorageMode,
      snapshotAccelMode: requestBody.snapshotAccelMode,
    };
  }
  const stepLabel =
    step.degree === 'storage-only'
      ? '轻度降级（保 GPU，仅切 full 存储）'
      : '深度降级（GPU 加速器也异常，切 cpu/full）';
  appendJobLog(
    job,
    `检测到 WASM 运行时异常，${stepLabel}：${previousAccelMode || '?'} / ${previousStorageMode || '?'} -> ${step.accelMode} / ${step.storageMode}`,
  );
  logTerminal('warn', 'web-search', 'stable-snapshot-fallback-enabled', {
    jobId: job?.id ?? null,
    reason: String(reason ?? ''),
    fallbackDegree: step.degree,
    previousSnapshotAccelMode: previousAccelMode || null,
    previousSnapshotStorageMode: previousStorageMode || null,
    nextSnapshotAccelMode: requestBody.snapshotAccelMode,
    nextSnapshotStorageMode: requestBody.snapshotStorageMode,
  });
  return true;
}

function startProfileTimer() {
  return coreProfileEnabled ? process.hrtime.bigint() : 0n;
}

function endProfileTimer(name, startNs) {
  if (!coreProfileEnabled || startNs === 0n || !name) return;
  const elapsedNs = process.hrtime.bigint() - startNs;
  const prev = coreProfileStats.get(name) ?? { count: 0, totalNs: 0n };
  prev.count += 1;
  prev.totalNs += elapsedNs;
  coreProfileStats.set(name, prev);
}

function recordProfileEvent(name) {
  if (!coreProfileEnabled || !name) return;
  const prev = coreProfileStats.get(name) ?? { count: 0, totalNs: 0n };
  prev.count += 1;
  coreProfileStats.set(name, prev);
}

function profileCountBucket(value) {
  const count = Math.max(0, Number(value) || 0);
  if (count === 0) return '0';
  if (count <= 8) return '1_8';
  if (count <= 64) return '9_64';
  if (count <= 256) return '65_256';
  if (count <= 1024) return '257_1024';
  return 'gt1024';
}

function profileKiBBucket(value) {
  const kib = Math.max(0, Math.ceil((Number(value) || 0) / 1024));
  if (kib === 0) return '0';
  if (kib <= 64) return '1_64';
  if (kib <= 256) return '65_256';
  if (kib <= 1024) return '257_1024';
  if (kib <= 4096) return '1025_4096';
  return 'gt4096';
}

function recordChangedPageDistribution(changedPages, targetByteLength) {
  if (!coreProfileEnabled || !changedPages) return;
  const offsets = changedPages.pageOffsets;
  const count = offsets instanceof Uint32Array ? offsets.length : 0;
  const pageSize = Math.max(1, Number(changedPages.pageSize ?? MODERN_SNAPSHOT_PAGE_SIZE) || MODERN_SNAPSHOT_PAGE_SIZE);
  const byteLength = Math.max(0, Number(changedPages.byteLength ?? 0) || 0);
  const compareBytes = Math.max(0, Number(targetByteLength ?? 0) || 0);
  const maxOffset = count > 0 ? Number(offsets[count - 1] >>> 0) : 0;
  const maxEnd = count > 0 ? Math.min(compareBytes || maxOffset + pageSize, maxOffset + pageSize) : 0;
  const maxMiB = Math.max(0, Math.floor(maxEnd / (1024 * 1024)));
  const compareMiB = Math.max(0, Math.ceil(compareBytes / (1024 * 1024)));
  const spanPct = compareBytes > 0
    ? Math.max(0, Math.min(100, Math.ceil((maxEnd / compareBytes) * 10) * 10))
    : 0;
  recordProfileEvent(`snapshot.changedPages.count.${profileCountBucket(count)}`);
  recordProfileEvent(`snapshot.changedPages.packedKiB.${profileKiBBucket(byteLength)}`);
  recordProfileEvent(`snapshot.changedPages.maxEndMiB.${maxMiB}_of_${compareMiB}`);
  recordProfileEvent(`snapshot.changedPages.maxEndPct.${spanPct}`);
}

function clearCoreProfileStats() {
  coreProfileStats.clear();
}

function resetSnapshotAccelState() {
  try {
    snapshotAccelState?.releaseBuffers?.();
  } catch {
    // ignore native accelerator teardown failures
  }
  snapshotAccelState = undefined;
}

function printCoreProfileStats() {
  if (!coreProfileEnabled || coreProfileStats.size === 0) return;
  printProfileRows(getCoreProfileRows());
}

function getCoreProfileRows() {
  return [...coreProfileStats.entries()]
    .map(([name, stat]) => ({
      name,
      count: stat.count,
      totalMs: Number(stat.totalNs) / 1e6,
    }))
    .sort((a, b) => b.totalMs - a.totalMs);
}

const snapshotState = {
  getSnapshotAccelMode: () => snapshotAccelMode,
  setSnapshotAccelMode: (value) => {
    snapshotAccelMode = String(value ?? snapshotAccelMode).toLowerCase();
  },
  getSnapshotStorageMode: () => snapshotStorageMode,
  setSnapshotStorageMode: (value) => {
    snapshotStorageMode = String(value ?? snapshotStorageMode).toLowerCase();
  },
  getSnapshotAccelState: () => snapshotAccelState,
  setSnapshotAccelState: (value) => {
    snapshotAccelState = value;
    return snapshotAccelState;
  },
  resetSnapshotAccelState,
  isCoreProfileEnabled: () => coreProfileEnabled,
  setCoreProfileEnabled: (value) => {
    coreProfileEnabled = !!value;
  },
  clearCoreProfileStats,
};

function printProfileRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return;
  console.log('\n===== Core Profile =====');
  for (const row of rows) {
    const avgMs = row.count > 0 ? row.totalMs / row.count : 0;
    console.log(
      `${row.name}: total ${row.totalMs.toFixed(2)} ms | count ${row.count} | avg ${avgMs.toFixed(4)} ms`,
    );
  }
}

function printHelp() {
  console.log(`
Combo 推演器（koishipro-core.js）

用法:
  node scripts/combo-simulator.cjs [选项]

默认会优先调用本地目录:
  卡组:   ${DEFAULT_LOCAL_FILES.deck}
  卡池:   ${DEFAULT_LOCAL_FILES.cards}
  脚本:   ${DEFAULT_LOCAL_FILES.scripts}

可选参数:
  --deck              主玩家 .ydk（默认 lib/slm.ydk）
  --cards             cards.cdb 路径（默认 lib/cards.cdb）
  --scripts           脚本资源路径（默认 lib/ygopro-scripts）
  --resource-dir      资源根目录（会推导 slm.ydk/cards.cdb/ygopro-scripts）
  --opponent-deck     对手 .ydk（默认与 --deck 相同）
  --seed              随机种子（默认 ${DEFAULT_OPTIONS.seed}）
  --draw-count        起手张数（默认 ${DEFAULT_OPTIONS.drawCount}）
  --opening-cards     固定我方起手卡ID，逗号分隔（需与 --draw-count 数量一致）
  --opponent-opening-cards
                      固定对方起手卡ID，逗号分隔（需与 --draw-count 数量一致）
  --max-depth         搜索最大深度（默认 ${DEFAULT_OPTIONS.maxDepth}）
  --max-nodes         精确穷举节点预算（默认 ${DEFAULT_OPTIONS.maxNodes}）
  --target-terminals  命中指定终局数量后提前停止搜索
  --beam-width        Beam 束宽（默认 ${DEFAULT_OPTIONS.maxBeamWidth}）
  --max-actions       每节点最多扩展动作数（默认 ${DEFAULT_OPTIONS.maxActionsPerNode}）
  --snapshot-pool     状态快照池大小（默认 ${DEFAULT_OPTIONS.snapshotPoolSize}）
  --snapshot-accel    页差分快照加速: auto / cpu / gpu（默认 gpu；auto 等同 gpu）
  --snapshot-storage  内核快照策略: delta / full（默认 delta，GPU 页差分）
  --engine-backend    搜索内核后端: auto / wasm / native（默认 auto，精确穷举当前建议 wasm）
  --exact-search-backend
                      精确穷举控制后端: auto / js / parallel-js（默认 auto）
  --workers           精确穷举分片并行进程数（仅对 parallel-js 生效；默认 1，推荐 4）
  --enumerate-openings
                      未固定起手时，按实例全枚举所有起手组合
  --web-ui            启动本地网页界面与 API 服务
  --host              Web UI 绑定地址（默认 127.0.0.1）
  --port              Web UI 端口（默认 3456）
  --profile-core      输出 save/restore/step/query 等内核热点耗时统计
  --top               输出步数最多的前 N 条路径（默认 ${DEFAULT_OPTIONS.topK}）
  --expand-script-keywords
                      保留 reposition/set 的脚本关键词，多个关键词用逗号分隔
  --export-yrp        导出 top 路径为 .yrp（可选值: 输出目录或文件）
  --yrp-version       replay 格式版本: 1 或 2（默认 2，YGOPRO2 推荐）
  --verbose           打印调试信息
  --help              显示帮助
`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    if (eq >= 0) {
      args[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function toUInt32(input, fallback = DEFAULT_OPTIONS.seed) {
  const n = Number(input);
  if (!Number.isFinite(n)) return fallback >>> 0;
  return n >>> 0;
}

function toInt(input, fallback) {
  const n = Number(input);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : fallback;
}

function parseKeywordList(input) {
  if (!input) return [];
  return String(input)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseCodeList(input, optionName = 'codes') {
  if (!input) return [];
  return String(input)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((token) => {
      const n = Number(token);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`${optionName} 包含无效卡片ID: ${token}`);
      }
      return n >>> 0;
    });
}

function parseYrpVersion(input, fallback = 1) {
  const n = Number(input);
  if (!Number.isFinite(n)) return fallback;
  return n === 2 ? 2 : 1;
}

function cloneHistoryState(state) {
  if (!state || !Array.isArray(state.history)) return { history: [] };
  const out = {
    history: state.history.slice(),
  };
  if (typeof state.historyKey === 'string' && state.historyKey) {
    out.historyKey = state.historyKey;
  }
  if (typeof state.snapshotBase64 === 'string' && state.snapshotBase64) {
    out.snapshotBase64 = state.snapshotBase64;
  }
  if (state.decision) {
    out.decision = cloneDecisionState(state.decision);
  }
  return out;
}

function cloneEncodedHistory(history) {
  return Array.isArray(history) ? history.slice() : [];
}

function makeEncodedActionHistoryToken(item) {
  return typeof item?.intResponse === 'number'
    ? `i:${item.intResponse | 0}`
    : `b:${item?.responseBase64 ?? ''}`;
}

function appendEncodedActionHistoryKey(currentKey, item) {
  const token = makeEncodedActionHistoryToken(item);
  return currentKey ? `${currentKey}|${token}` : token;
}

function scanYgoProPayloadMessages(payload, visitor) {
  const data = toUint8Array(payload);
  if (!(data instanceof Uint8Array) || typeof visitor !== 'function') {
    return { ok: false, matched: false };
  }
  const registry = ygopro?.YGOProMessages;
  if (!registry || typeof registry.get !== 'function') {
    return { ok: false, matched: false };
  }
  let offset = 0;
  while (offset + 2 <= data.length) {
    const declaredLength = data[offset] | (data[offset + 1] << 8);
    if (declaredLength <= 0) return { ok: true, matched: false };
    const packetLength = 2 + declaredLength;
    if (offset + packetLength > data.length) return { ok: false, matched: false };
    const chunk = data.subarray(offset, offset + packetLength);
    const proto = registry.get(chunk[2]);
    if (!proto) return { ok: false, matched: false };
    let instance;
    try {
      instance = new proto().fromFullPayload(chunk);
    } catch {
      return { ok: false, matched: false };
    }
    if (visitor(instance)) {
      return { ok: true, matched: true };
    }
    offset += packetLength;
  }
  return { ok: true, matched: false };
}

function serializeDecisionAction(action) {
  if (!action || typeof action !== 'object') return null;
  const out = {
    label: action.label,
    kind: action.kind,
    text: action.text ?? '',
  };
  if (Number.isInteger(action.selectionIndex)) out.selectionIndex = action.selectionIndex;
  if (typeof action.intResponse === 'number') {
    out.intResponse = action.intResponse | 0;
    return out;
  }
  if (typeof action.responseBase64 === 'string' && action.responseBase64) {
    out.responseBase64 = action.responseBase64;
    return out;
  }
  if (action.response instanceof Uint8Array) {
    out.responseBase64 = Buffer.from(toUint8Array(action.response) ?? new Uint8Array(0)).toString('base64');
  }
  return out;
}

function deserializeDecisionAction(action) {
  if (!action || typeof action !== 'object') return null;
  const out = {
    label: action.label,
    kind: action.kind,
    text: action.text ?? '',
  };
  if (Number.isInteger(action.selectionIndex)) out.selectionIndex = action.selectionIndex;
  if (typeof action.intResponse === 'number') {
    out.intResponse = action.intResponse | 0;
    return out;
  }
  if (typeof action.responseBase64 === 'string' && action.responseBase64) {
    out.response = Uint8Array.from(Buffer.from(action.responseBase64, 'base64'));
  }
  return out;
}

function serializeDecisionState(decision) {
  if (!decision || typeof decision !== 'object') return null;
  return {
    terminal: !!decision.terminal,
    reason: decision.reason ?? null,
    messageName: decision.messageName ?? decision.message?.constructor?.name ?? null,
    factorizedSelection: decision.factorizedSelection === true,
    estimatedLegalCandidateCount: decision.estimatedLegalCandidateCount ?? null,
    selectionConstraints: decision.selectionConstraints ? { ...decision.selectionConstraints } : null,
    actions: Array.isArray(decision.actions)
      ? decision.actions
          .map(serializeDecisionAction)
          .filter(Boolean)
      : [],
  };
}

function deserializeDecisionState(decision) {
  if (!decision || typeof decision !== 'object') return null;
  return {
    terminal: !!decision.terminal,
    reason: decision.reason ?? null,
    messageName: decision.messageName ?? null,
    factorizedSelection: decision.factorizedSelection === true,
    estimatedLegalCandidateCount: decision.estimatedLegalCandidateCount ?? null,
    selectionConstraints: decision.selectionConstraints ? { ...decision.selectionConstraints } : null,
    actions: Array.isArray(decision.actions)
      ? decision.actions
          .map(deserializeDecisionAction)
          .filter(Boolean)
      : [],
  };
}

function serializeHistoryState(state) {
  if (!state || !Array.isArray(state.history)) return { history: [] };
  const out = {
    history: state.history.map((item) => serializeDecisionAction(item) ?? { ...item }),
  };
  if (typeof state.historyKey === 'string' && state.historyKey) out.historyKey = state.historyKey;
  if (typeof state.snapshotBase64 === 'string' && state.snapshotBase64) out.snapshotBase64 = state.snapshotBase64;
  if (state.decision) out.decision = serializeDecisionState(state.decision);
  return out;
}

function deserializeHistoryState(state) {
  if (!state || !Array.isArray(state.history)) return { history: [] };
  const out = {
    history: state.history.map((item) => serializeDecisionAction(item) ?? { ...item }),
  };
  if (typeof state.historyKey === 'string' && state.historyKey) out.historyKey = state.historyKey;
  if (typeof state.snapshotBase64 === 'string' && state.snapshotBase64) out.snapshotBase64 = state.snapshotBase64;
  if (state.decision) out.decision = deserializeDecisionState(state.decision);
  return out;
}

function encodedActionToReplayResponse(action) {
  if (typeof action?.intResponse === 'number') {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setInt32(0, action.intResponse | 0, true);
    return out;
  }
  if (typeof action?.responseBase64 === 'string') {
    return Uint8Array.from(Buffer.from(action.responseBase64, 'base64'));
  }
  return new Uint8Array(0);
}

function toUint8Array(raw) {
  if (raw instanceof Uint8Array) return raw;
  if (Array.isArray(raw)) return Uint8Array.from(raw);
  if (!raw) return null;
  if (typeof raw === 'object') {
    const entries = Object.entries(raw)
      .map(([key, value]) => [Number(key), Number(value)])
      .filter(([key, value]) => Number.isSafeInteger(key) && key >= 0 && Number.isFinite(value))
      .sort(([left], [right]) => left - right)
      .map(([, value]) => value);
    if (entries.length > 0) return Uint8Array.from(entries);
  }
  return null;
}

function formatDebugResponse(response, limit = 64) {
  const bytes = toUint8Array(response);
  if (!(bytes instanceof Uint8Array)) return '<null>';
  const hex = Buffer.from(bytes.subarray(0, Math.min(bytes.length, limit))).toString('hex');
  return bytes.length > limit ? `${hex}...(${bytes.length}B)` : `${hex} (${bytes.length}B)`;
}

function isCancelSentinelResponse(response) {
  const bytes = toUint8Array(response);
  return bytes instanceof Uint8Array
    && bytes.length === 4
    && bytes[0] === 0xff
    && bytes[1] === 0xff
    && bytes[2] === 0xff
    && bytes[3] === 0xff;
}

function formatDebugAction(action) {
  if (!action) return '<null-action>';
  if (typeof action.intResponse === 'number') {
    return `${action.kind || 'unknown'} ${action.label || '<no-label>'} int=${action.intResponse}`;
  }
  return `${action.kind || 'unknown'} ${action.label || '<no-label>'} bytes=${formatDebugResponse(action.response)}`;
}

function formatDebugDecision(decision) {
  if (!decision) return '<null-decision>';
  const messageName = decision?.message?.constructor?.name ?? decision?.reason ?? 'unknown';
  const actionCount = Array.isArray(decision?.actions) ? decision.actions.length : 0;
  return `${messageName} actions=${actionCount} terminal=${!!decision?.terminal}`;
}

function cloneDecisionAction(action) {
  if (!action || typeof action !== 'object') return null;
  const out = {
    label: action.label,
    kind: action.kind,
    text: action.text ?? '',
  };
  if (Number.isInteger(action.selectionIndex)) out.selectionIndex = action.selectionIndex;
  if (typeof action.intResponse === 'number') {
    out.intResponse = action.intResponse | 0;
    return out;
  }
  if (typeof action.responseBase64 === 'string' && action.responseBase64) {
    out.responseBase64 = action.responseBase64;
    return out;
  }
  if (action.response instanceof Uint8Array) {
    out.responseBase64 = Buffer.from(toUint8Array(action.response) ?? new Uint8Array(0)).toString('base64');
  }
  return out;
}

function cloneDecisionState(decision) {
  if (!decision || typeof decision !== 'object') return null;
  return {
    terminal: !!decision.terminal,
    reason: decision.reason ?? null,
    messageName: decision.message?.constructor?.name ?? null,
    factorizedSelection: decision.factorizedSelection === true,
    estimatedLegalCandidateCount: decision.estimatedLegalCandidateCount ?? null,
    selectionConstraints: decision.selectionConstraints ? { ...decision.selectionConstraints } : null,
    actions: Array.isArray(decision.actions)
      ? decision.actions
          .map(cloneDecisionAction)
          .filter(Boolean)
      : [],
  };
}

function inflateDecisionState(decision) {
  if (!decision || typeof decision !== 'object') return null;
  const message =
    decision.messageName
      ? { constructor: { name: decision.messageName } }
      : null;
  return {
    terminal: !!decision.terminal,
    reason: decision.reason ?? null,
    message,
    factorizedSelection: decision.factorizedSelection === true,
    estimatedLegalCandidateCount: decision.estimatedLegalCandidateCount ?? null,
    selectionConstraints: decision.selectionConstraints ? { ...decision.selectionConstraints } : null,
    actions: Array.isArray(decision.actions)
      ? decision.actions
          .map((action) => {
            if (!action) return null;
            const out = {
              label: action.label,
              kind: action.kind,
              text: action.text ?? '',
            };
            if (Number.isInteger(action.selectionIndex)) out.selectionIndex = action.selectionIndex;
            if (typeof action.intResponse === 'number') {
              out.intResponse = action.intResponse | 0;
            } else if (typeof action.responseBase64 === 'string' && action.responseBase64) {
              out.response = Uint8Array.from(Buffer.from(action.responseBase64, 'base64'));
            } else if (action.response instanceof Uint8Array) {
              out.response = Uint8Array.from(action.response);
            } else {
              const bytes = toUint8Array(action.response);
              if (bytes) out.response = Uint8Array.from(bytes);
            }
            return out;
          })
          .filter(Boolean)
      : [],
  };
}

function decodeOcgcoreDuelSnapshotBytes(input) {
  if (!(input instanceof Uint8Array) || input.length < OCGCORE_SNAPSHOT_HEADER_SIZE) {
    throw new Error('Invalid ocgcore duel snapshot: truncated header');
  }
  for (let i = 0; i < OCGCORE_SNAPSHOT_MAGIC.length; i += 1) {
    if (input[i] !== OCGCORE_SNAPSHOT_MAGIC[i]) {
      throw new Error('Invalid ocgcore duel snapshot: bad magic');
    }
  }
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const metadataLength = view.getUint32(OCGCORE_SNAPSHOT_MAGIC.length, true);
  const memoryOffset = OCGCORE_SNAPSHOT_HEADER_SIZE + metadataLength;
  if (memoryOffset > input.byteLength) {
    throw new Error('Invalid ocgcore duel snapshot: truncated metadata');
  }
  const metadataText = UTF8_DECODER.decode(input.subarray(OCGCORE_SNAPSHOT_HEADER_SIZE, memoryOffset));
  const metadata = JSON.parse(metadataText);
  const memory = input.subarray(memoryOffset);
  if (
    !metadata ||
    !Number.isSafeInteger(metadata.memoryByteLength) ||
    metadata.memoryByteLength !== memory.byteLength
  ) {
    throw new Error('Invalid ocgcore duel snapshot: memory length mismatch');
  }
  if (!metadata.duel || !metadata.wrapper) {
    throw new Error('Invalid ocgcore duel snapshot: missing state');
  }
  return { metadata, memory };
}

function ensureOcgcoreModuleMemoryCapacity(moduleInstance, byteLength) {
  while ((moduleInstance?.HEAPU8?.byteLength ?? 0) < byteLength) {
    const before = moduleInstance.HEAPU8.byteLength;
    const ptr = moduleInstance._malloc(byteLength);
    if (ptr) moduleInstance._free(ptr);
    const after = moduleInstance.HEAPU8.byteLength;
    if (after <= before) {
      throw new Error('Unable to grow ocgcore wasm memory for snapshot restore');
    }
  }
}

function cloneWrapperSnapshotState(state) {
  if (!state || typeof state !== 'object') return null;
  return {
    scriptBufferPtr: state.scriptBufferPtr ?? 0,
    scriptBufferSize: state.scriptBufferSize ?? 0,
    logBufferPtr: state.logBufferPtr ?? 0,
    logBufferSize: state.logBufferSize ?? 0,
    tmpStringBufferPtr: state.tmpStringBufferPtr ?? 0,
    tmpStringBufferSize: state.tmpStringBufferSize ?? 0,
  };
}

function cloneDuelSnapshotState(state) {
  if (!state || typeof state !== 'object') return null;
  return {
    duelPtr: state.duelPtr ?? 0,
    returnPtr: state.returnPtr ?? 0,
    receivePtr: state.receivePtr ?? 0,
  };
}

function captureModernSnapshotMeta(wrapper, duel, fixedMemoryByteLength = null) {
  const heap = wrapper?.ocgcoreModule?.HEAPU8;
  if (!(heap instanceof Uint8Array) || !duel) return null;
  const memoryByteLength =
    Number.isSafeInteger(fixedMemoryByteLength) && fixedMemoryByteLength > 0
      ? fixedMemoryByteLength
      : typeof wrapper?.getSnapshotMemoryByteLength === 'function'
        ? wrapper.getSnapshotMemoryByteLength()
        : heap.byteLength;
  return {
    memoryByteLength,
    duel: cloneDuelSnapshotState({
      duelPtr: duel.duelPtr,
      returnPtr: duel.returnPtr,
      receivePtr: duel.receivePtr,
    }),
    wrapper: cloneWrapperSnapshotState(wrapper.getSnapshotState?.()),
  };
}

function createBaseMemoryFromRoot(rootMemory, targetByteLength) {
  if (!(rootMemory instanceof Uint8Array)) return null;
  if (rootMemory.byteLength === targetByteLength) {
    return Uint8Array.from(rootMemory);
  }
  const base = new Uint8Array(targetByteLength);
  base.set(rootMemory.subarray(0, Math.min(rootMemory.byteLength, targetByteLength)), 0);
  return base;
}

function canRestoreModernSnapshotInPlace(currentMeta, targetMeta) {
  if (!currentMeta || !targetMeta) return false;
  return (
    currentMeta.memoryByteLength === targetMeta.memoryByteLength &&
    currentMeta.duel?.duelPtr === targetMeta.duel?.duelPtr &&
    currentMeta.duel?.returnPtr === targetMeta.duel?.returnPtr &&
    currentMeta.duel?.receivePtr === targetMeta.duel?.receivePtr
  );
}

const {
  collectChangedPagesAgainstRoot,
  collectChangedPagesAgainstRootCpu,
} = createSnapshotAccelRuntimeApi({
  Buffer,
  fs,
  koffi,
  SNAPSHOT_ACCEL_DLL_PATH,
  MODERN_SNAPSHOT_GPU_MIN_BYTES,
  MODERN_SNAPSHOT_PAGE_SIZE,
  startProfileTimer,
  endProfileTimer,
  snapshotState,
});

function forEachSnapshotPage(snapshotEntry, visitor) {
  if (typeof visitor !== 'function' || !snapshotEntry) return;
  if (snapshotEntry.pageOffsets instanceof Uint32Array && snapshotEntry.pageData instanceof Uint8Array) {
    const pageSize = Math.max(1, snapshotEntry.pageSize ?? MODERN_SNAPSHOT_PAGE_SIZE);
    const memoryByteLength = Math.max(0, snapshotEntry.metadata?.memoryByteLength ?? 0);
    let readOffset = 0;
    for (const pageOffset of snapshotEntry.pageOffsets) {
      const end = memoryByteLength > 0
        ? Math.min(pageOffset + pageSize, memoryByteLength)
        : pageOffset + pageSize;
      const pageLength = Math.max(0, end - pageOffset);
      const bytes = snapshotEntry.pageData.subarray(readOffset, readOffset + pageLength);
      visitor(pageOffset, bytes);
      readOffset += pageLength;
    }
    return;
  }
  for (const page of snapshotEntry.pages ?? []) {
    if (!(page?.bytes instanceof Uint8Array) || typeof page?.offset !== 'number') continue;
    visitor(page.offset, page.bytes);
  }
}

function buildSnapshotPageMap(snapshotEntry) {
  if (snapshotEntry?._pageMap instanceof Map) {
    return snapshotEntry._pageMap;
  }
  const pageMap = new Map();
  forEachSnapshotPage(snapshotEntry, (offset, bytes) => {
    pageMap.set(offset, bytes);
  });
  if (snapshotEntry && typeof snapshotEntry === 'object') {
    try {
      Object.defineProperty(snapshotEntry, '_pageMap', {
        value: pageMap,
        configurable: true,
      });
    } catch {
      // ignore cache attach failures
    }
  }
  return pageMap;
}

function extractCodesFromFieldQueryRaw(raw, length) {
  return extractCardsFromFieldQueryRaw(raw, length).map((card) => card.code);
}

function extractCardsFromFieldQueryRaw(raw, length, location = null) {
  if (!(raw instanceof Uint8Array) || length <= 0) return [];
  const cards = [];
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  let offset = 0;
  let sequence = 0;
  while (offset + 4 <= length) {
    const chunkLen = view.getInt32(offset, true);
    if (chunkLen <= 0) break;
    const card = { sequence };
    if (chunkLen > 4 && offset + 8 <= length) {
      const flags = view.getInt32(offset + 4, true) >>> 0;
      let cursor = offset + 8;
      if ((flags & COMMON.QUERY_CODE) !== 0) {
        card.code = view.getInt32(cursor, true) >>> 0;
        cursor += 4;
      }
      if ((flags & COMMON.QUERY_POSITION) !== 0) {
        card.position = view.getInt32(cursor, true) >>> 0;
        cursor += 4;
      }
      if ((flags & COMMON.QUERY_ALIAS) !== 0) cursor += 4;
      if ((flags & COMMON.QUERY_TYPE) !== 0) {
        card.type = view.getInt32(cursor, true) >>> 0;
        cursor += 4;
      }
      if ((flags & COMMON.QUERY_LEVEL) !== 0) cursor += 4;
      if ((flags & COMMON.QUERY_RANK) !== 0) cursor += 4;
      if ((flags & COMMON.QUERY_ATTRIBUTE) !== 0) cursor += 4;
      if ((flags & COMMON.QUERY_RACE) !== 0) cursor += 4;
      if ((flags & COMMON.QUERY_ATTACK) !== 0) cursor += 4;
      if ((flags & COMMON.QUERY_DEFENSE) !== 0) cursor += 4;
      if ((flags & COMMON.QUERY_BASE_ATTACK) !== 0) cursor += 4;
      if ((flags & COMMON.QUERY_BASE_DEFENSE) !== 0) cursor += 4;
      if ((flags & COMMON.QUERY_REASON) !== 0) cursor += 4;
      if ((flags & COMMON.QUERY_REASON_CARD) !== 0) cursor += 4;
      if ((flags & COMMON.QUERY_EQUIP_CARD) !== 0) cursor += 4;
      if ((flags & COMMON.QUERY_TARGET_CARD) !== 0) cursor += 4;
      if ((flags & COMMON.QUERY_OVERLAY_CARD) !== 0 && cursor + 4 <= offset + chunkLen) {
        const overlayCount = view.getInt32(cursor, true) >>> 0;
        cursor += 4 + overlayCount * 4;
      }
      if ((flags & COMMON.QUERY_COUNTERS) !== 0 && cursor + 4 <= offset + chunkLen) {
        const counterCount = view.getInt32(cursor, true) >>> 0;
        cursor += 4 + counterCount * 4;
      }
      if ((flags & COMMON.QUERY_OWNER) !== 0) cursor += 4;
      if ((flags & COMMON.QUERY_STATUS) !== 0) cursor += 4;
      if ((flags & COMMON.QUERY_LSCALE) !== 0) cursor += 4;
      if ((flags & COMMON.QUERY_RSCALE) !== 0) cursor += 4;
      if ((flags & COMMON.QUERY_LINK) !== 0 && cursor + 4 <= offset + chunkLen) {
        card.link_marker = view.getInt32(cursor, true) >>> 0;
      }
      if (card.code > 0) {
        if (location !== null) card.location = location;
        cards.push(card);
      }
    }
    offset += chunkLen;
    sequence += 1;
  }
  return cards;
}

function extractLpPairFromFieldInfoRaw(raw, length) {
  if (!(raw instanceof Uint8Array) || length < 2) {
    return { p0: 0, p1: 0 };
  }
  const view = new DataView(raw.buffer, raw.byteOffset, Math.min(raw.byteLength, length));
  let offset = 2;
  const players = [];
  for (let player = 0; player < 2; player += 1) {
    if (offset + 4 > length) {
      players.push(0);
      continue;
    }
    const lp = view.getInt32(offset, true);
    players.push(lp);
    offset += 4;
    for (let seq = 0; seq < 7 && offset < length; seq += 1) {
      const occupied = view.getUint8(offset);
      offset += occupied ? 3 : 1;
    }
    for (let seq = 0; seq < 8 && offset < length; seq += 1) {
      const occupied = view.getUint8(offset);
      offset += occupied ? 2 : 1;
    }
    offset += 6;
  }
  return {
    p0: players[0] ?? 0,
    p1: players[1] ?? 0,
  };
}

function makeSeedSequence(seed, count = 8) {
  const rnd = makeXorshift32(seed ^ 0x6a09e667);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push((rnd() * 0x100000000) >>> 0);
  }
  return out;
}

function buildReplayMainDeck(openingInfo, fallbackMain) {
  const opening = openingInfo?.opening;
  const remain = openingInfo?.remain;
  if (Array.isArray(opening) && Array.isArray(remain) && opening.length > 0) {
    return [...remain, ...opening.slice().reverse()];
  }
  return [...(fallbackMain ?? [])];
}

function exportReplayYrp(params) {
  if (!ygoproYrp?.YGOProYrp || !ygoproYrp?.ReplayHeader) {
    throw new Error('未检测到 ygopro-yrp-encode，无法导出 .yrp');
  }

  const {
    seed,
    drawCount,
    playerDeck,
    opponentDeck,
    playerOpening,
    opponentOpening,
    state,
    responsesEncoded,
    outPath,
    yrpVersion = 2,
    seedSequence = [],
  } = params;

  const sourceResponses =
    Array.isArray(responsesEncoded) && responsesEncoded.length > 0
      ? responsesEncoded
      : (state?.history ?? []);

  const responses = sourceResponses
    .map(encodedActionToReplayResponse)
    .filter((seg) => seg.length > 0);

  const {
    YGOProYrp,
    ReplayHeader,
    REPLAY_ID_YRP1,
    REPLAY_ID_YRP2,
    REPLAY_COMPRESSED_FLAG,
    REPLAY_UNIFORM,
  } = ygoproYrp;

  const header = new ReplayHeader();
  header.id = (yrpVersion === 2 ? REPLAY_ID_YRP2 : REPLAY_ID_YRP1) ?? 829452921;
  header.version = 4962;
  const compressedFlag = REPLAY_COMPRESSED_FLAG ?? 1;
  const uniformFlag = REPLAY_UNIFORM ?? 16;
  header.flag = yrpVersion === 2 ? (compressedFlag | uniformFlag) : compressedFlag;
  header.seed = seed >>> 0;
  header.hash = ((seed >>> 0) * 2654435761) >>> 0;
  header.props = [93, 0, 0, 32, 0, 0, 0, 0];
  if (yrpVersion === 2) {
    header.seedSequence = Array.isArray(seedSequence) && seedSequence.length > 0
      ? seedSequence.map((value) => value >>> 0)
      : makeSeedSequence(seed >>> 0);
    header.headerVersion = 1;
    header.value1 = 0;
    header.value2 = 0;
    header.value3 = 0;
  } else {
    header.seedSequence = [];
    header.headerVersion = 0;
    header.value1 = 0;
    header.value2 = 0;
    header.value3 = 0;
  }

  const yrp = new YGOProYrp({
    header,
    hostName: 'ComboBot',
    clientName: 'OpponentBot',
    startLp: 8000,
    startHand: Array.isArray(playerOpening?.opening) ? playerOpening.opening.length : drawCount,
    drawCount: 1,
    opt: CURRENT_DUEL_OPTIONS,
    hostDeck: {
      main: buildReplayMainDeck(playerOpening, playerDeck.main),
      extra: [...(playerDeck.extra ?? [])],
      side: [...(playerDeck.side ?? [])],
    },
    clientDeck: {
      main: buildReplayMainDeck(opponentOpening, opponentDeck.main),
      extra: [...(opponentDeck.extra ?? [])],
      side: [...(opponentDeck.side ?? [])],
    },
    responses,
  });

  const bytes = yrp.toYrp();
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, Buffer.from(bytes));
  return {
    outPath,
    responseCount: responses.length,
    byteLength: bytes.length,
    yrpVersion,
  };
}

function assertFileExists(filePath, name) {
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`${name} 不存在: ${filePath ?? '(empty)'}`);
  }
}

function uniq(arr) {
  return [...new Set(arr)];
}

function resolveScriptDirs(inputPath) {
  const abs = path.resolve(inputPath);
  const candidates = [abs];
  if (path.basename(abs).toLowerCase() === 'script') {
    candidates.push(path.dirname(abs));
  } else {
    candidates.push(path.join(abs, 'script'));
  }
  return uniq(candidates.filter((p) => fs.existsSync(p) && fs.statSync(p).isDirectory()));
}

function parseYdkText(text) {
  const normalizedText = typeof text === 'string' && !/[\r\n]/.test(text) && /\\n/.test(text)
    ? text.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n')
    : text;
  const deck = { main: [], extra: [], side: [] };
  let section = 'main';
  for (const raw of String(normalizedText ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const lower = line.toLowerCase();
    if (lower === '#main') {
      section = 'main';
      continue;
    }
    if (lower === '#extra') {
      section = 'extra';
      continue;
    }
    if (lower === '!side') {
      section = 'side';
      continue;
    }
    if (line.startsWith('#')) continue;
    const code = Number(line);
    if (!Number.isFinite(code)) continue;
    deck[section].push(code >>> 0);
  }
  return deck;
}

function parseYdk(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  return parseYdkText(text);
}

function makeXorshift32(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

function shuffleInPlace(arr, rnd) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function simulateOpeningHand(mainDeck, drawCount, seed) {
  const deck = mainDeck.slice();
  const rnd = makeXorshift32(seed);
  shuffleInPlace(deck, rnd);
  return {
    opening: deck.slice(0, drawCount),
    remain: deck.slice(drawCount),
  };
}

function buildFixedOpening(mainDeck, openingCards, label = '固定起手') {
  const remain = mainDeck.slice();
  const opening = [];
  for (const rawCode of openingCards ?? []) {
    const code = rawCode >>> 0;
    const idx = remain.indexOf(code);
    if (idx < 0) {
      throw new Error(`${label} 不在主卡组中或数量不足: ${code}`);
    }
    opening.push(code);
    remain.splice(idx, 1);
  }
  return { opening, remain };
}

function createDeckInstanceId(section, code, ordinal) {
  return `${section}:${code >>> 0}:${ordinal}`;
}

function createDeckCardInstances(deck, cardText = null) {
  const buildSection = (section, codes) => {
    const seen = new Map();
    return (codes ?? []).map((rawCode, index) => {
      const code = rawCode >>> 0;
      const ordinal = (seen.get(code) ?? 0) + 1;
      seen.set(code, ordinal);
      return {
        instanceId: createDeckInstanceId(section, code, ordinal),
        code,
        name: cardText ? cardText.getName(code) : String(code),
        section,
        ordinal,
        index,
      };
    });
  };

  const main = buildSection('main', deck?.main ?? []);
  const extra = buildSection('extra', deck?.extra ?? []);
  const side = buildSection('side', deck?.side ?? []);
  const all = [...main, ...extra, ...side];
  const byId = new Map(all.map((card) => [card.instanceId, card]));
  return { main, extra, side, all, byId };
}

function resolveCardImageFile(code, searchDirs = DEFAULT_YGOPRO2_PICTURE_DIRS) {
  const fileName = `${code >>> 0}.jpg`;
  for (const dir of searchDirs) {
    const fullPath = path.join(dir, fileName);
    if (fs.existsSync(fullPath)) return fullPath;
  }
  return null;
}

function createDeckView(deckInstances, imagePathResolver = resolveCardImageFile) {
  const decorate = (card) => ({
    ...card,
    imageUrl: `/api/card-image/${card.code >>> 0}`,
    hasLocalImage: !!imagePathResolver(card.code),
  });
  return {
    main: deckInstances.main.map(decorate),
    extra: deckInstances.extra.map(decorate),
    side: deckInstances.side.map(decorate),
    cards: deckInstances.all.map(decorate),
  };
}

function buildFixedOpeningFromInstanceIds(mainInstances, selectedIds, drawCount, label = '固定起手') {
  const chosen = new Set(selectedIds ?? []);
  const selectedCards = mainInstances.filter((card) => chosen.has(card.instanceId));
  if (selectedCards.length !== chosen.size) {
    const knownIds = new Set(mainInstances.map((card) => card.instanceId));
    const unknown = [...chosen].filter((id) => !knownIds.has(id));
    throw new Error(`${label} 包含未知卡牌实例: ${unknown.join(', ')}`);
  }
  if (selectedCards.length !== drawCount) {
    throw new Error(`${label} 数量(${selectedCards.length}) 必须等于 drawCount(${drawCount})`);
  }
  return {
    opening: selectedCards.map((card) => card.code >>> 0),
    openingInstanceIds: selectedCards.map((card) => card.instanceId),
    remain: mainInstances
      .filter((card) => !chosen.has(card.instanceId))
      .map((card) => card.code >>> 0),
  };
}

function* chooseCombinations(items, choose, start = 0, prefix = []) {
  if (prefix.length === choose) {
    yield prefix.slice();
    return;
  }
  const remaining = choose - prefix.length;
  for (let index = start; index <= items.length - remaining; index += 1) {
    prefix.push(items[index]);
    yield* chooseCombinations(items, choose, index + 1, prefix);
    prefix.pop();
  }
}

function* chooseOrderedSelections(items, choose) {
  for (const picked of chooseCombinations(items, choose)) {
    yield* choosePermutations(picked);
  }
}

function estimateOrderedSelectionCount(available, min, max, cap = Number.POSITIVE_INFINITY) {
  const countAvailable = Math.max(0, Math.trunc(Number(available) || 0));
  const lower = Math.max(0, Math.trunc(Number(min) || 0));
  const upper = Math.max(lower, Math.min(Math.trunc(Number(max) || lower), countAvailable));
  let total = lower === 0 ? 1 : 0;
  for (let count = Math.max(1, lower); count <= upper; count += 1) {
    let permutations = 1;
    for (let offset = 0; offset < count; offset += 1) {
      permutations *= countAvailable - offset;
      if (total + permutations > cap) return cap + 1;
    }
    total += permutations;
    if (total > cap) return cap + 1;
  }
  return total;
}

function makeIndexResponse(index) {
  if (typeof ygopro?.IndexResponse !== 'function') {
    throw new Error('ygopro.IndexResponse is unavailable');
  }
  return ygopro.IndexResponse(index);
}

function formatPlaceChoiceLabel(place) {
  const player = normalizePlaceNumber(place?.player ?? place?.controller);
  const location = normalizePlaceNumber(place?.location);
  const sequence = normalizePlaceNumber(place?.sequence);
  const position = normalizePlaceNumber(place?.position);
  const zone = describePlaceZone(location, sequence);
  const parts = [
    `P${player ?? '?'}`,
    zone,
    `seq=${sequence ?? '?'}`,
  ];
  if (position !== null) parts.push(`pos=${position}`);
  return parts.join(' ');
}

function formatPlaceChoiceDebug(place) {
  const player = normalizePlaceNumber(place?.player ?? place?.controller);
  const location = normalizePlaceNumber(place?.location);
  const sequence = normalizePlaceNumber(place?.sequence);
  const position = normalizePlaceNumber(place?.position);
  return `player=${player ?? '?'} location=${location ?? '?'}(${describePlaceZone(location, sequence)}) sequence=${sequence ?? '?'} position=${position ?? '?'}`;
}

function describePlaceZone(location, sequence = null) {
  switch (location) {
    case 0x04:
      return sequence === 5 || sequence === 6 ? `额外怪兽区${sequence}` : `主怪兽区${sequence ?? '?'}`;
    case 0x08:
      return `魔法陷阱区${sequence ?? '?'}`;
    case 0x10:
      return `场地区${sequence ?? '?'}`;
    case 0x20:
      return `墓地区${sequence ?? '?'}`;
    case 0x40:
      return `除外区${sequence ?? '?'}`;
    default:
      return `区域L${location ?? '?'}`;
  }
}

function normalizePlaceNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function hashPayloadSha256(payload) {
  const bytes = toUint8Array(payload);
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return '';
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function* choosePermutations(items, prefix = [], used = null) {
  const state = used ?? new Array(items.length).fill(false);
  if (prefix.length === items.length) {
    yield prefix.slice();
    return;
  }
  for (let index = 0; index < items.length; index += 1) {
    if (state[index]) continue;
    state[index] = true;
    prefix.push(items[index]);
    yield* choosePermutations(items, prefix, state);
    prefix.pop();
    state[index] = false;
  }
}

function maskToBitChoices(mask) {
  const choices = [];
  let bit = 1;
  while (bit !== 0) {
    if ((mask & bit) !== 0) choices.push(bit >>> 0);
    bit = (bit << 1) >>> 0;
    if (bit === 0) break;
  }
  return choices;
}

function* chooseBitmaskCombinations(mask, choose) {
  const bits = maskToBitChoices(mask);
  for (const picked of chooseCombinations(bits, choose)) {
    yield picked.reduce((sum, bit) => (sum | bit) >>> 0, 0);
  }
}

function* distributeCounterCounts(cards, total, index = 0, prefix = []) {
  if (index >= cards.length) {
    if (total === 0) yield prefix.slice();
    return;
  }
  const current = cards[index];
  const maxTake = Math.max(0, Math.min(total, Number(current?.counterCount ?? 0) | 0));
  for (let count = 0; count <= maxTake; count += 1) {
    if (count > 0) {
      prefix.push({ card: current, count });
    }
    yield* distributeCounterCounts(cards, total - count, index + 1, prefix);
    if (count > 0) {
      prefix.pop();
    }
  }
}

function cloneSnapshot(snapshot) {
  return snapshot ? JSON.parse(JSON.stringify(snapshot)) : snapshot;
}

function normalizeScoringRules(rules = []) {
  return rules.map((rule, index) => ({
    id: String(rule?.id ?? `rule-${index + 1}`),
    name: rule?.name ? String(rule.name) : String(rule?.id ?? `rule-${index + 1}`),
    targetCode: Number(rule?.targetCode) >>> 0,
    targetInstanceId: rule?.targetInstanceId ? String(rule.targetInstanceId) : null,
    targetLocation: String(rule?.targetLocation ?? 'grave'),
    score: Number(rule?.score ?? 0),
    priority: Number(rule?.priority ?? index),
    maxMatches: Math.max(1, Math.trunc(Number(rule?.maxMatches ?? 1) || 1)),
    dedupeKey: rule?.dedupeKey
      ? String(rule.dedupeKey)
      : (rule?.targetInstanceId ? String(rule.targetInstanceId) : null),
  })).filter((rule) => Number.isFinite(rule.score) && rule.targetCode > 0);
}

function assignSnapshotInstances(snapshot, deckInstances) {
  if (!snapshot || !deckInstances?.all?.length) return snapshot;
  const poolByCode = new Map();
  for (const card of deckInstances.all) {
    const arr = poolByCode.get(card.code) ?? [];
    arr.push(card);
    poolByCode.set(card.code, arr);
  }

  const takeCard = (code, fallbackIndex, location) => {
    const pool = poolByCode.get(code) ?? [];
    if (pool.length > 0) {
      const card = pool.shift();
      return {
        ...card,
        location,
        snapshotIndex: fallbackIndex,
      };
    }
    return {
      instanceId: `${location}:${code}:${fallbackIndex}`,
      code,
      name: String(code),
      section: 'unknown',
      ordinal: fallbackIndex + 1,
      index: fallbackIndex,
      location,
      snapshotIndex: fallbackIndex,
    };
  };

  const decorateZone = (codes, location) =>
    (codes ?? []).map((rawCode, index) => takeCard(rawCode >>> 0, index, location));

  const clone = cloneSnapshot(snapshot);
  clone.p0 = clone.p0 ?? {};
  clone.p1 = clone.p1 ?? {};
  clone.p0Zones = {
    hand: decorateZone(clone.p0.hand, 'hand'),
    mzone: decorateZone(clone.p0.mzone, 'mzone'),
    szone: decorateZone(clone.p0.szone, 'szone'),
    grave: decorateZone(clone.p0.grave, 'grave'),
    banished: decorateZone(clone.p0.banished, 'banished'),
    deck: decorateZone(clone.p0.deck, 'deck'),
    extra: decorateZone(clone.p0.extra, 'extra'),
  };
  clone.p1Zones = {
    hand: decorateZone(clone.p1.hand, 'hand'),
    mzone: decorateZone(clone.p1.mzone, 'mzone'),
    szone: decorateZone(clone.p1.szone, 'szone'),
    grave: decorateZone(clone.p1.grave, 'grave'),
    banished: decorateZone(clone.p1.banished, 'banished'),
    deck: decorateZone(clone.p1.deck, 'deck'),
    extra: decorateZone(clone.p1.extra, 'extra'),
  };
  return clone;
}

function buildSnapshotZoneSlots(snapshot, deckInstances) {
  const slots = {
    field: [],
    hand: [],
    mzone: [],
    szone: [],
    grave: [],
    banished: [],
    deck: [],
    extra: [],
  };
  const enriched = snapshot?.p0Zones ? snapshot : assignSnapshotInstances(snapshot, deckInstances);
  for (const [location, cards] of Object.entries(enriched?.p0Zones ?? {})) {
    if (!Array.isArray(cards) || !slots[location]) continue;
    cards.forEach((card, index) => {
      const code = Number(card?.code) >>> 0;
      const instanceId = card?.instanceId ? String(card.instanceId) : '';
      slots[location].push({
        slotId: instanceId || `${location}:${code}:${index}`,
        instanceId,
        location,
        code,
        index,
        name: card?.name ? String(card.name) : String(code),
      });
    });
  }
  slots.field = [...slots.mzone, ...slots.szone].map((slot, index) => ({
    ...slot,
    location: 'field',
    sourceLocation: slot.location,
    fieldIndex: index,
  }));
  return slots;
}

function scoreSnapshotByRules(snapshot, scoringRules, deckInstances) {
  const normalizedRules = normalizeScoringRules(scoringRules);
  if (normalizedRules.length === 0) {
    const ownField = snapshot.p0.mzone.length * 6 + snapshot.p0.szone.length * 3;
    const ownResource = snapshot.p0.hand.length * 2 + snapshot.p0.grave.length;
    const oppPressure = snapshot.p1.mzone.length * 4 + snapshot.p1.szone.length * 2;
    const lpDelta = (snapshot.lp.p0 - snapshot.lp.p1) / 800;
    return {
      score: ownField + ownResource - oppPressure + lpDelta,
      breakdown: [],
      snapshot: assignSnapshotInstances(snapshot, deckInstances),
    };
  }

  const enriched = assignSnapshotInstances(snapshot, deckInstances);
  const zoneSlots = buildSnapshotZoneSlots(enriched, deckInstances);
  const consumedSlots = new Set();
  const satisfiedGroups = new Map();
  const breakdown = [];
  let totalScore = 0;

  for (const rule of normalizedRules.sort((a, b) => a.priority - b.priority)) {
    const dedupeKey =
      rule.dedupeKey ||
      rule.targetInstanceId ||
      `${rule.targetCode}:${rule.targetLocation}`;
    const groupHits = satisfiedGroups.get(dedupeKey) ?? 0;
    const remainingGroupCapacity = Math.max(0, rule.maxMatches - groupHits);
    const matches = (zoneSlots[rule.targetLocation] ?? []).filter((slot) =>
      (slot.code >>> 0) === (rule.targetCode >>> 0) &&
      !consumedSlots.has(slot.slotId) &&
      (!rule.targetInstanceId || slot.instanceId === rule.targetInstanceId),
    );
    const accepted = [];
    for (const match of matches) {
      if (accepted.length >= remainingGroupCapacity) break;
      accepted.push(match);
      consumedSlots.add(match.slotId);
    }
    const hitCount = accepted.length;
    if (hitCount > 0) {
      satisfiedGroups.set(dedupeKey, groupHits + hitCount);
    }
    const ruleScore = hitCount * rule.score;
    totalScore += ruleScore;
    breakdown.push({
      ruleId: rule.id,
      ruleName: rule.name ?? rule.id,
      targetCode: rule.targetCode,
      targetInstanceId: rule.targetInstanceId,
      targetLocation: rule.targetLocation,
      score: rule.score,
      hitCount,
      satisfied: hitCount > 0,
      total: ruleScore,
      matchedInstanceIds: accepted.map((slot) => slot.instanceId || slot.slotId),
      matchedSlots: accepted.map((slot) => ({
        slotId: slot.slotId,
        instanceId: slot.instanceId || null,
        code: slot.code,
        name: slot.name,
        location: slot.location,
        sourceLocation: slot.sourceLocation ?? slot.location,
      })),
      dedupeKey,
      priority: rule.priority,
    });
  }

  return {
    score: totalScore,
    breakdown,
    snapshot: enriched,
  };
}

class CardTextResolver {
  constructor(sqlDb) {
    this.sqlDbs = Array.isArray(sqlDb) ? sqlDb : [sqlDb];
    this.cache = new Map();
    this.cols = this.detectColumns();
  }

  detectColumns() {
    const result = this.sqlDbs[0].exec('PRAGMA table_info(texts);');
    const effectCols = [];
    if (result[0]) {
      for (const row of result[0].values || []) {
        const name = String(row[1]);
        const m = /^(str|desc)(\d+)$/i.exec(name);
        if (m) effectCols.push({ key: name, idx: Number(m[2]) });
      }
    }
    effectCols.sort((a, b) => a.idx - b.idx);
    return effectCols;
  }

  getCard(code) {
    const id = code >>> 0;
    if (this.cache.has(id)) return this.cache.get(id);

    let row = null;
    for (const sqlDb of this.sqlDbs) {
      const stmt = sqlDb.prepare('SELECT * FROM texts WHERE id = ?');
      try {
        stmt.bind([id]);
        if (stmt.step()) row = stmt.getAsObject();
      } finally {
        stmt.free();
      }
      if (row) break;
    }

    const name = (row?.name ? String(row.name) : String(id)).trim();
    const desc = (row?.desc ? String(row.desc) : '').trim();
    const effectByIndex = {};
    const stringsByIndex = {};
    const effects = [];
    if (row) {
      for (const col of this.cols) {
        const v = row[col.key];
        if (typeof v !== 'string' || !v.trim()) continue;
        const text = v.trim();
        effectByIndex[col.idx] = text;
        if (/^str\d+$/i.test(col.key)) stringsByIndex[col.idx - 1] = text;
        effects.push(text);
      }
    }

    const card = {
      id,
      name,
      desc,
      effects,
      effectByIndex,
      stringsByIndex,
      numberedEffects: this.getNumberedEffects(desc),
    };
    this.cache.set(id, card);
    return card;
  }

  getName(code) {
    return this.getCard(code).name;
  }

  getDescription(code) {
    return this.getCard(code).desc;
  }

  getEffectDetails(code, descId) {
    const card = this.getCard(code);
    const id = Number(descId);
    if (!Number.isFinite(id) || id === 0) {
      return {
        descriptionId: null,
        stringIndex: null,
        effectNumber: null,
        marker: null,
        text: '',
        confidence: 'missing-engine-id',
        reference: '未提供引擎效果标识',
      };
    }

    const unsignedId = id >>> 0;
    const candidates = [];
    const auxBase = (card.id * 16) >>> 0;
    const auxOffset = unsignedId - auxBase;
    if (auxOffset >= 0 && auxOffset < 16) candidates.push(auxOffset);

    // Some bridges expose the compact Stringid index instead of cardId * 16 + n.
    const lowNibble = unsignedId & 0xf;
    if (lowNibble >= 0 && lowNibble < 16) candidates.push(lowNibble);
    const lowByte = unsignedId & 0xff;
    if (lowByte >= 1 && lowByte <= 16) candidates.push(lowByte - 1);
    const shifted = unsignedId >>> 4;
    if (shifted >= 0 && shifted < 16) candidates.push(shifted);

    for (const stringIndex of uniq(candidates)) {
      const stringText = card.stringsByIndex[stringIndex] ?? '';
      const matches = stringText
        ? card.numberedEffects.filter((effect) => textMatchesEffect(stringText, effect.text))
        : [];
      if (matches.length === 1) {
        const match = matches[0];
        return this.makeEffectDetails(card, unsignedId, stringIndex, match, 'text-match');
      }
      if (stringText) {
        const activationMatch = card.numberedEffects
          .filter((effect) => isActivatableNumberedEffect(effect.text))[stringIndex];
        if (activationMatch) {
          return this.makeEffectDetails(card, unsignedId, stringIndex, activationMatch, 'activation-order');
        }
        return this.makeEffectDetails(card, unsignedId, stringIndex, null, 'engine-string');
      }
      const activationMatch = card.numberedEffects
        .filter((effect) => isActivatableNumberedEffect(effect.text))[stringIndex];
      if (activationMatch) {
        return this.makeEffectDetails(card, unsignedId, stringIndex, activationMatch, 'activation-order');
      }
      if (card.numberedEffects.length === 1) {
        return this.makeEffectDetails(card, unsignedId, stringIndex, card.numberedEffects[0], 'single-effect');
      }
    }

    const stringIndex = uniq(candidates)[0] ?? null;
    return this.makeEffectDetails(card, unsignedId, stringIndex, null, 'engine-id-only');
  }

  makeEffectDetails(card, descriptionId, stringIndex, match, confidence) {
    const effectNumber = match?.index ?? null;
    const marker = match?.marker ?? null;
    const reference = effectNumber !== null
      ? `卡面${match.scope ? `${match.scope}` : '效果'}${marker}`
      : stringIndex === null
        ? `引擎效果ID=${descriptionId}`
        : `引擎效果#${stringIndex + 1} (Stringid=${card.id}:${stringIndex})`;
    return {
      descriptionId,
      stringIndex,
      effectNumber,
      marker,
      text: match?.text ?? card.stringsByIndex[stringIndex] ?? '',
      confidence,
      reference,
    };
  }

  getEffectDescription(code, descId) {
    return this.getEffectDetails(code, descId).text;
  }

  getNumberedEffects(description) {
    const markers = [
      '①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧',
      '⑨', '⑩', '⑪', '⑫', '⑬', '⑭', '⑮', '⑯',
    ];
    const starts = [];
    const pattern = /[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯]\s*[：:]/g;
    for (const match of String(description ?? '').matchAll(pattern)) {
      const marker = match[0][0];
      starts.push({
        start: match.index,
        marker,
        index: markers.indexOf(marker) + 1,
        scope: findEffectScope(description, match.index),
      });
    }
    return starts.map((effect, position) => ({
      ...effect,
      ordinal: position + 1,
      text: description.slice(effect.start, starts[position + 1]?.start ?? description.length).trim(),
    }));
  }

  getNumberedEffectFromDescription(description, index) {
    return this.getNumberedEffects(description).find((effect) => effect.index === index)?.text ?? '';
  }
}

function textMatchesEffect(stringText, effectText) {
  const normalize = (value) => String(value ?? '')
    .replace(/[\s\r\n]/g, '')
    .replace(/[：:，。、“”「」『』()（）]/g, '');
  const needle = normalize(stringText);
  const haystack = normalize(effectText);
  const withoutActionPrefix = needle.replace(/^(发动|改变|选择|适用|把|将)/, '');
  return needle.length >= 2 && (
    haystack.includes(needle)
    || needle.includes(haystack)
    || (withoutActionPrefix.length >= 2 && haystack.includes(withoutActionPrefix))
  );
}

function isActivatableNumberedEffect(effectText) {
  return /(?:发动|才能|可以|场合|时|阶段|宣言|之际)/.test(String(effectText ?? ''));
}

function findEffectScope(description, position) {
  const prefix = String(description ?? '').slice(0, position);
  const headings = [...prefix.matchAll(/【([^】]*效果)】/g)];
  return headings.at(-1)?.[1] ?? '';
}

function findNumberedEffectStart(description, marker, fromIndex = 0) {
  let pos = description.indexOf(marker, fromIndex);
  while (pos >= 0) {
    const next = description[pos + marker.length];
    if (next === '：' || next === ':') return pos;
    pos = description.indexOf(marker, pos + marker.length);
  }
  return -1;
}

function trimText(text, max = 24) {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

function shouldUseVerboseCardLabels() {
  return process.env.COMBO_DECISION_DEBUG === '1' || process.env.COMBO_SEARCH_DEBUG === '1';
}

function formatCardLocator(card) {
  if (!card || typeof card !== 'object') return '';
  const parts = [];
  if (Number.isFinite(card.controller)) parts.push(`P${card.controller}`);
  if (Number.isFinite(card.location)) parts.push(`L${card.location}`);
  if (Number.isFinite(card.sequence)) parts.push(`S${card.sequence}`);
  if (Number.isFinite(card.subsequence)) parts.push(`SS${card.subsequence}`);
  return parts.length > 0 ? `@${parts.join(':')}` : '';
}

function formatCardChoiceLabel(prefix, name, card) {
  if (!shouldUseVerboseCardLabels()) {
    return `${prefix}[${name}]`;
  }
  return `${prefix}[${name}${formatCardLocator(card)}]`;
}

function formatMultiCardChoiceLabel(indexedCards, resolveName) {
  const choices = indexedCards.map(({ item, index }) => `#${index} ${resolveName(item.code)}`);
  return `选择${indexedCards.length}张卡片[${choices.join(' -> ')}]`;
}

class DuelRunner {
  constructor(params) {
    this.wrapper = params.wrapper;
    this.cardText = params.cardText;
    this.seed = params.seed >>> 0;
    this.seedSequence = Array.isArray(params.seedSequence) ? params.seedSequence.map((value) => value >>> 0) : [];
    this.yrpVersion = params.yrpVersion === 2 ? 2 : 1;
    this.drawCount = Math.max(0, params.drawCount ?? params.playerOpening?.opening?.length ?? 1);
    this.duelOptions = Number.isFinite(params.duelOptions) ? params.duelOptions >>> 0 : CURRENT_DUEL_OPTIONS;
    this.config = params.config;
    this.playerDeck = params.playerDeck;
    this.opponentDeck = params.opponentDeck;
    this.playerOpening = params.playerOpening;
    this.opponentOpening = params.opponentOpening;
    this.scoringRules = normalizeScoringRules(params.scoringRules ?? []);
    this.playerDeckInstances =
      params.playerDeckInstances ?? createDeckCardInstances(this.playerDeck, this.cardText);

    this.duel = null;
    this.currentDecision = null;
    this.actionHistory = [];
    this.actionHistoryKey = '';
    this.replayCollector = null;
    this.statePool = new Map();
    this.statePoolOrder = [];
    this.maxStatePoolSize = Math.max(0, this.config.snapshotPoolSize ?? DEFAULT_OPTIONS.snapshotPoolSize);
    this.nativeSnapshotMode = 'unknown';
    this.nativeSnapshotPool = new Map();
    this.nativeSnapshotPoolOrder = [];
    this.nativeSnapshotPoolBytes = 0;
    this.modernRootSnapshot = null;
    this.modernSnapshotMetadata = null;
    this.maxNativeSnapshotPoolSize = Math.max(
      0,
      Math.min(this.maxStatePoolSize, MODERN_SNAPSHOT_POOL_MAX_ENTRIES),
    );
    this.maxNativeSnapshotPoolBytes = MODERN_SNAPSHOT_POOL_MAX_BYTES;

    this.classes = {
      AnnounceAttrib: ygopro.YGOProMsgAnnounceAttrib,
      AnnounceCard: ygopro.YGOProMsgAnnounceCard,
      AnnounceNumber: ygopro.YGOProMsgAnnounceNumber,
      AnnounceRace: ygopro.YGOProMsgAnnounceRace,
      RockPaperScissors: ygopro.YGOProMsgRockPaperScissors,
      Response: ygopro.YGOProMsgResponseBase,
      Retry: ygopro.YGOProMsgRetry,
      SelectIdle: ygopro.YGOProMsgSelectIdleCmd,
      SelectBattle: ygopro.YGOProMsgSelectBattleCmd,
      SelectChain: ygopro.YGOProMsgSelectChain,
      SelectCard: ygopro.YGOProMsgSelectCard,
      SelectCounter: ygopro.YGOProMsgSelectCounter,
      SelectOption: ygopro.YGOProMsgSelectOption,
      SelectYesNo: ygopro.YGOProMsgSelectYesNo,
      SelectEffectYn: ygopro.YGOProMsgSelectEffectYn,
      SelectPlace: ygopro.YGOProMsgSelectPlace,
      SelectDisField: ygopro.YGOProMsgSelectDisField,
      SelectPosition: ygopro.YGOProMsgSelectPosition,
      SelectSum: ygopro.YGOProMsgSelectSum,
      SelectTribute: ygopro.YGOProMsgSelectTribute,
      SelectUnselect: ygopro.YGOProMsgSelectUnselectCard,
      SortCard: ygopro.YGOProMsgSortCard,
    };
    this.classNames = {
      AnnounceAttrib: 'YGOProMsgAnnounceAttrib',
      AnnounceCard: 'YGOProMsgAnnounceCard',
      AnnounceNumber: 'YGOProMsgAnnounceNumber',
      AnnounceRace: 'YGOProMsgAnnounceRace',
      RockPaperScissors: 'YGOProMsgRockPaperScissors',
      Response: 'YGOProMsgResponseBase',
      Retry: 'YGOProMsgRetry',
      SelectIdle: 'YGOProMsgSelectIdleCmd',
      SelectBattle: 'YGOProMsgSelectBattleCmd',
      SelectChain: 'YGOProMsgSelectChain',
      SelectCard: 'YGOProMsgSelectCard',
      SelectCounter: 'YGOProMsgSelectCounter',
      SelectOption: 'YGOProMsgSelectOption',
      SelectYesNo: 'YGOProMsgSelectYesNo',
      SelectEffectYn: 'YGOProMsgSelectEffectYn',
      SelectPlace: 'YGOProMsgSelectPlace',
      SelectDisField: 'YGOProMsgSelectDisField',
      SelectPosition: 'YGOProMsgSelectPosition',
      SelectSum: 'YGOProMsgSelectSum',
      SelectTribute: 'YGOProMsgSelectTribute',
      SelectUnselect: 'YGOProMsgSelectUnselectCard',
      SortCard: 'YGOProMsgSortCard',
    };
  }

  init() {
    if (this.tryRestoreCachedRootState()) return;
    this.rebuildFromHistory([]);
    this.persistRootSnapshotCache();
  }

  setActionHistory(history, historyKey = null, options = {}) {
    this.actionHistory = options.assumeOwned
      ? (Array.isArray(history) ? history : [])
      : cloneEncodedHistory(history);
    this.actionHistoryKey =
      typeof historyKey === 'string'
        ? historyKey
        : this.makeHistoryKey(this.actionHistory);
  }

  pushEncodedHistoryAction(encodedAction) {
    this.actionHistory.push(encodedAction);
    this.actionHistoryKey = appendEncodedActionHistoryKey(
      this.actionHistoryKey,
      encodedAction,
    );
  }

  makeHistoryKey(history) {
    if (!Array.isArray(history) || history.length === 0) return '';
    return history.map(makeEncodedActionHistoryToken).join('|');
  }

  detectNativeSnapshotMode() {
    if (!this.duel) {
      if (this.nativeSnapshotMode === 'legacy' || this.nativeSnapshotMode === 'modern') {
        return this.nativeSnapshotMode;
      }
      return 'none';
    }
    if (
      this.duel &&
      typeof this.duel.saveState === 'function' &&
      typeof this.duel.loadState === 'function'
    ) {
      return 'legacy';
    }
    if (
      this.duel &&
      typeof this.duel.snapshot === 'function' &&
      this.wrapper &&
      this.wrapper.ocgcoreModule &&
      typeof this.wrapper.attachDuel === 'function' &&
      typeof this.wrapper.restoreSnapshotState === 'function'
    ) {
      return 'modern';
    }
    return 'none';
  }

  ensureNativeSnapshotMode() {
    const mode = this.detectNativeSnapshotMode();
    if (this.nativeSnapshotMode !== mode) {
      this.nativeSnapshotMode = mode;
      if (mode !== 'modern') {
        this.clearNativeSnapshotPool();
      } else {
        this.clearStatePool();
      }
    }
    return this.nativeSnapshotMode;
  }

  clearNativeSnapshotPool() {
    this.nativeSnapshotPool.clear();
    this.nativeSnapshotPoolOrder = [];
    this.nativeSnapshotPoolBytes = 0;
    this.modernRootSnapshot = null;
    this.modernSnapshotMetadata = null;
  }

  clearStatePool() {
    for (const entry of this.statePool.values()) {
      if (!entry?.duel) continue;
      try {
        entry.duel.endDuel();
      } catch {
        // ignore
      }
    }
    this.statePool.clear();
    this.statePoolOrder = [];
  }

  touchNativeSnapshotPoolKey(key) {
    if (typeof key !== 'string') return;
    if (!this.nativeSnapshotPool.has(key)) return;
    this.nativeSnapshotPoolOrder = this.nativeSnapshotPoolOrder.filter((k) => k !== key);
    this.nativeSnapshotPoolOrder.push(key);
  }

  estimateNativeSnapshotEntryBytes(snapshotEntry) {
    if (snapshotEntry?.memory instanceof Uint8Array) {
      return snapshotEntry.memory.length;
    }
    if (snapshotEntry?.bytes instanceof Uint8Array) {
      return snapshotEntry.bytes.length;
    }
    if (snapshotEntry?.pageData instanceof Uint8Array) {
      return snapshotEntry.pageData.length;
    }
    if (Array.isArray(snapshotEntry?.pages)) {
      return snapshotEntry.pages.reduce((sum, page) => sum + (page?.bytes?.length ?? 0), 0);
    }
    return 0;
  }

  ensureModernRootSnapshot() {
    if (this.ensureNativeSnapshotMode() !== 'modern') return null;
    if (this.modernRootSnapshot?.memory instanceof Uint8Array) {
      return this.modernRootSnapshot;
    }
    const heap = this.wrapper?.ocgcoreModule?.HEAPU8;
    const metadata = this.captureModernSnapshotMetadata();
    if (!(heap instanceof Uint8Array) || !metadata) return null;
    this.modernRootSnapshot = {
      metadata,
      memory: Uint8Array.from(heap.subarray(0, metadata.memoryByteLength)),
    };
    return this.modernRootSnapshot;
  }

  captureModernSnapshotMetadata(fixedMemoryByteLength = null) {
    const startedAt = startProfileTimer();
    try {
      const heap = this.wrapper?.ocgcoreModule?.HEAPU8;
      if (!(heap instanceof Uint8Array) || !this.duel) return null;
      const memoryByteLength =
        Number.isSafeInteger(fixedMemoryByteLength) && fixedMemoryByteLength > 0
          ? fixedMemoryByteLength
          : typeof this.wrapper?.getSnapshotMemoryByteLength === 'function'
            ? this.wrapper.getSnapshotMemoryByteLength()
            : heap.byteLength;
      const cached = this.modernSnapshotMetadata;
      if (
        cached &&
        cached.memoryByteLength === memoryByteLength &&
        cached.duel?.duelPtr === this.duel.duelPtr &&
        cached.duel?.returnPtr === this.duel.returnPtr &&
        cached.duel?.receivePtr === this.duel.receivePtr
      ) {
        return cached;
      }
      const metadata = captureModernSnapshotMeta(this.wrapper, this.duel, memoryByteLength);
      if (!metadata) return null;
      this.modernSnapshotMetadata = metadata;
      return metadata;
    } finally {
      endProfileTimer('captureModernSnapshotMeta', startedAt);
    }
  }

  captureCompressedModernSnapshot() {
    const startedAt = startProfileTimer();
    try {
      const rootSnapshot = this.ensureModernRootSnapshot();
      const heap = this.wrapper?.ocgcoreModule?.HEAPU8;
      const metadataStartedAt = startProfileTimer();
      this.modernSnapshotMetadata = null;
      const metadata = this.captureModernSnapshotMetadata(
        rootSnapshot?.metadata?.memoryByteLength ?? null,
      );
      endProfileTimer('captureCompressedModernSnapshot.metadata', metadataStartedAt);
      if (!rootSnapshot || !(heap instanceof Uint8Array) || !metadata) return null;
      const changedPagesStartedAt = startProfileTimer();
      const changedPages = collectChangedPagesAgainstRoot(
        heap,
        rootSnapshot.memory,
        metadata.memoryByteLength,
      );
      endProfileTimer('captureCompressedModernSnapshot.changedPages', changedPagesStartedAt);
      recordChangedPageDistribution(changedPages, metadata.memoryByteLength);
      return {
        type: 'page-delta',
        metadata,
        pageOffsets: changedPages.pageOffsets,
        pageData: changedPages.pageData,
        pageSize: changedPages.pageSize ?? MODERN_SNAPSHOT_PAGE_SIZE,
        byteLength: changedPages.byteLength,
      };
    } finally {
      endProfileTimer('captureCompressedModernSnapshot', startedAt);
    }
  }

  putNativeSnapshotIntoPool(key, snapshotEntry) {
    if (typeof key !== 'string' || this.ensureNativeSnapshotMode() !== 'modern') return;
    if (this.maxNativeSnapshotPoolSize <= 0 || this.maxNativeSnapshotPoolBytes <= 0) return;
    if (!snapshotEntry) return;
    const entryBytes = this.estimateNativeSnapshotEntryBytes(snapshotEntry);
    if (entryBytes <= 0) return;
    if (entryBytes > this.maxNativeSnapshotPoolBytes) return;

    const old = this.nativeSnapshotPool.get(key);
    const oldBytes = this.estimateNativeSnapshotEntryBytes(old);
    if (oldBytes > 0) {
      this.nativeSnapshotPoolBytes = Math.max(0, this.nativeSnapshotPoolBytes - oldBytes);
    }

    const frozenEntry =
      snapshotEntry?.type === 'full' && snapshotEntry?.memory instanceof Uint8Array
        ? { type: 'full', metadata: snapshotEntry.metadata, memory: Uint8Array.from(snapshotEntry.memory) }
        : snapshotEntry?.bytes instanceof Uint8Array
          ? { bytes: Uint8Array.from(snapshotEntry.bytes) }
          : snapshotEntry?.pageOffsets instanceof Uint32Array && snapshotEntry?.pageData instanceof Uint8Array
            ? snapshotEntry
          : {
              type: 'page-delta',
              metadata: snapshotEntry.metadata,
              pages: snapshotEntry.pages.map((page) => ({
                offset: page.offset,
                bytes: Uint8Array.from(page.bytes),
              })),
              byteLength: entryBytes,
            };
    this.nativeSnapshotPool.set(key, frozenEntry);
    this.nativeSnapshotPoolBytes += entryBytes;
    this.touchNativeSnapshotPoolKey(key);

    while (
      this.nativeSnapshotPoolOrder.length > this.maxNativeSnapshotPoolSize ||
      this.nativeSnapshotPoolBytes > this.maxNativeSnapshotPoolBytes
    ) {
      const evictKey = this.nativeSnapshotPoolOrder.shift();
      if (evictKey === undefined) break;
      const entry = this.nativeSnapshotPool.get(evictKey);
      this.nativeSnapshotPool.delete(evictKey);
      const removedBytes = this.estimateNativeSnapshotEntryBytes(entry);
      if (removedBytes > 0) {
        this.nativeSnapshotPoolBytes = Math.max(0, this.nativeSnapshotPoolBytes - removedBytes);
      }
    }
  }

  getNativeSnapshotFromPool(key) {
    if (typeof key !== 'string') return null;
    if (this.ensureNativeSnapshotMode() !== 'modern') return null;
    if (!this.nativeSnapshotPool.has(key)) return null;
    const entry = this.nativeSnapshotPool.get(key);
    this.touchNativeSnapshotPoolKey(key);
    return entry ?? null;
  }

  getRootSnapshotCacheKey() {
    return crypto.createHash('sha256').update(stableStringify({
      version: ROOT_SNAPSHOT_CACHE_SCHEMA_VERSION,
      seed: this.seed,
      seedSequence: this.seedSequence,
      yrpVersion: this.yrpVersion,
      drawCount: this.drawCount,
      duelOptions: this.duelOptions,
      playerDeck: this.playerDeck,
      opponentDeck: this.opponentDeck,
      playerOpening: this.playerOpening,
      opponentOpening: this.opponentOpening,
    })).digest('hex');
  }

  getRootSnapshotCachePath() {
    return path.join(ROOT_SNAPSHOT_CACHE_DIR, `${this.getRootSnapshotCacheKey()}.json`);
  }

  getRootSnapshotCacheMetaPath() {
    return path.join(ROOT_SNAPSHOT_CACHE_DIR, `${this.getRootSnapshotCacheKey()}.meta.json`);
  }

  getRootSnapshotCacheBinaryPath() {
    return path.join(ROOT_SNAPSHOT_CACHE_DIR, `${this.getRootSnapshotCacheKey()}.bin`);
  }

  tryRestoreCachedRootState() {
    if (!ROOT_SNAPSHOT_CACHE_ENABLED) return false;
    if (
      !this.wrapper ||
      !this.wrapper.ocgcoreModule ||
      typeof this.wrapper.attachDuel !== 'function' ||
      typeof this.wrapper.restoreSnapshotState !== 'function'
    ) {
      return false;
    }
    try {
      const currentCacheKey = this.getRootSnapshotCacheKey();
      const metaPath = this.getRootSnapshotCacheMetaPath();
      const binaryPath = this.getRootSnapshotCacheBinaryPath();
      let payload = null;
      let bytes = null;
      if (fs.existsSync(metaPath) && fs.existsSync(binaryPath)) {
        payload = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        if (
          payload?.schemaVersion !== ROOT_SNAPSHOT_CACHE_SCHEMA_VERSION ||
          payload?.cacheKey !== currentCacheKey
        ) {
          return false;
        }
        bytes = Uint8Array.from(fs.readFileSync(binaryPath));
      } else {
        const cachePath = this.getRootSnapshotCachePath();
        if (!fs.existsSync(cachePath)) return false;
        payload = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        if (
          payload?.schemaVersion !== ROOT_SNAPSHOT_CACHE_SCHEMA_VERSION ||
          payload?.cacheKey !== currentCacheKey
        ) {
          return false;
        }
        if (typeof payload?.snapshotBase64 !== 'string' || !payload.snapshotBase64) return false;
        bytes = Uint8Array.from(Buffer.from(payload.snapshotBase64, 'base64'));
      }
      if (!(bytes instanceof Uint8Array) || bytes.length === 0) return false;
      const decoded = decodeOcgcoreDuelSnapshotBytes(bytes);
      if (!this.restoreModernSnapshotFromMemory(decoded.metadata, decoded.memory, { skipAdvance: true, allowWithoutCurrentDuel: true })) {
        return false;
      }
      this.currentDecision = inflateDecisionState(deserializeDecisionState(payload.decision));
      this.setActionHistory([], '');
      this.modernRootSnapshot = {
        metadata: decoded.metadata,
        memory: decoded.memory,
      };
      this.modernSnapshotMetadata = decoded.metadata;
      this.ensureNativeSnapshotMode();
      return true;
    } catch {
      return false;
    }
  }

  persistRootSnapshotCache() {
    if (!ROOT_SNAPSHOT_CACHE_ENABLED) return;
    if (this.ensureNativeSnapshotMode() !== 'modern') return;
    try {
      const snapshotBytes = this.captureNativeSnapshotBytes();
      if (!(snapshotBytes instanceof Uint8Array) || snapshotBytes.length === 0) return;
      fs.mkdirSync(ROOT_SNAPSHOT_CACHE_DIR, { recursive: true });
      writeFileAtomic(this.getRootSnapshotCacheBinaryPath(), Buffer.from(snapshotBytes));
      writeJsonAtomic(this.getRootSnapshotCacheMetaPath(), {
        schemaVersion: ROOT_SNAPSHOT_CACHE_SCHEMA_VERSION,
        cacheKey: this.getRootSnapshotCacheKey(),
        decision: serializeDecisionState(this.currentDecision),
      });
    } catch {
      // ignore cache write failures
    }
  }

  findNearestNativeSnapshotPrefix(history, historyKey = null) {
    const startedAt = startProfileTimer();
    if (this.ensureNativeSnapshotMode() !== 'modern') return null;
    if (!Array.isArray(history) || history.length <= 1) return null;
    try {
      let prefixKey =
        typeof historyKey === 'string' && historyKey
          ? historyKey
          : this.makeHistoryKey(history);
      if (!prefixKey) return null;
      for (let length = history.length; length > 1; length -= 1) {
        const separatorIndex = prefixKey.lastIndexOf('|');
        if (separatorIndex < 0) break;
        prefixKey = prefixKey.slice(0, separatorIndex);
        if (!this.nativeSnapshotPool.has(prefixKey)) continue;
        this.touchNativeSnapshotPoolKey(prefixKey);
        recordProfileEvent('findNearestNativeSnapshotPrefix.hit');
        return {
          history: history.slice(0, length - 1),
          historyKey: prefixKey,
          length: length - 1,
        };
      }
      recordProfileEvent('findNearestNativeSnapshotPrefix.miss');
      return null;
    } finally {
      endProfileTimer('findNearestNativeSnapshotPrefix', startedAt);
    }
  }

  putStateIntoPool(key, duel, decision, history) {
    if (this.ensureNativeSnapshotMode() === 'modern') return;
    if (!duel) return;
    if (this.maxStatePoolSize <= 0) {
      try {
        duel.endDuel();
      } catch {
        // ignore
      }
      return;
    }
    const old = this.statePool.get(key);
    if (old?.duel && old.duel !== duel) {
      try {
        old.duel.endDuel();
      } catch {
        // ignore
      }
    }
    this.statePool.set(key, {
      duel,
      decision,
      history: cloneEncodedHistory(history),
      historyKey: key,
    });
    this.statePoolOrder = this.statePoolOrder.filter((k) => k !== key);
    this.statePoolOrder.push(key);
    while (this.statePoolOrder.length > this.maxStatePoolSize) {
      const evictKey = this.statePoolOrder.shift();
      if (evictKey === undefined) break;
      const entry = this.statePool.get(evictKey);
      this.statePool.delete(evictKey);
      if (!entry?.duel) continue;
      try {
        entry.duel.endDuel();
      } catch {
        // ignore
      }
    }
  }

  takeStateFromPool(key) {
    if (this.ensureNativeSnapshotMode() === 'modern') return null;
    if (!this.statePool.has(key)) return null;
    const entry = this.statePool.get(key);
    this.statePool.delete(key);
    this.statePoolOrder = this.statePoolOrder.filter((k) => k !== key);
    return entry ?? null;
  }

  collectReplayResponse(entry) {
    if (!this.replayCollector) return;
    if (typeof entry?.intResponse === 'number') {
      this.replayCollector.push({ intResponse: entry.intResponse | 0 });
      return;
    }
    if (entry?.response) {
      this.replayCollector.push({
        responseBase64: Buffer.from(entry.response).toString('base64'),
      });
    }
  }

  buildReplayResponseHistory(state, chainLabels = null) {
      const manualHistory =
        Array.isArray(chainLabels) && chainLabels.length > 0
          ? chainLabels.map((label) => ({ label }))
          : cloneEncodedHistory(state?.history);
    const replayResponses = [];
    let debugReplaySteps = 0;

    try {
      this.destroyDuel();
      this.replayCollector = replayResponses;
      this.duel = this.createReplayCompatibleDuelInstance();
      this.currentDecision = this.advanceUntilDecision();

      for (const encoded of manualHistory) {
        while (!this.currentDecision?.terminal && !this.hasReplayActionMatch(encoded, this.currentDecision)) {
          const forced = this.pickForcedReplayAction(this.currentDecision);
          if (!forced) break;
          if (process.env.COMBO_REPLAY_DEBUG === '1' && debugReplaySteps < 12) {
            console.error('[replay-debug][forced]', this.currentDecision?.message?.constructor?.name, forced.label, typeof forced.intResponse === 'number' ? `i:${forced.intResponse}` : `b:${Buffer.from(forced.response ?? []).toString('hex')}`);
          }
          if (typeof forced.intResponse === 'number') {
            this.duel.setResponseInt(forced.intResponse);
            this.collectReplayResponse({ intResponse: forced.intResponse });
          } else {
            this.duel.setResponse(forced.response);
            this.collectReplayResponse({ response: forced.response });
          }
          this.currentDecision = this.advanceUntilDecision();
        }
        if (this.currentDecision?.terminal) break;
        const action = this.resolveReplayAction(encoded, this.currentDecision);
        if (process.env.COMBO_REPLAY_DEBUG === '1' && debugReplaySteps < 12) {
          console.error('[replay-debug][pick]', this.currentDecision?.message?.constructor?.name, encoded.label ?? '<no-label>', action?.label ?? '<none>', typeof action?.intResponse === 'number' ? `i:${action.intResponse}` : `b:${Buffer.from(action?.response ?? []).toString('hex')}`);
          debugReplaySteps += 1;
        }
        if (typeof action.intResponse === 'number') {
          this.duel.setResponseInt(action.intResponse);
          this.collectReplayResponse({ intResponse: action.intResponse });
        } else {
          this.duel.setResponse(action.response);
          this.collectReplayResponse({ response: action.response });
        }
        this.currentDecision = this.advanceUntilDecision();
        if (this.currentDecision?.terminal) break;
      }
    } finally {
      this.replayCollector = null;
    }

    return replayResponses;
  }

  destroyDuel() {
    if (this.duel) {
      try {
        this.duel.endDuel();
      } catch {
        // ignore
      }
    }
    this.duel = null;
    this.clearStatePool();
    this.clearNativeSnapshotPool();
  }

  loadDeck(duel, deck, opening, owner, player) {
    let seq = 0;
    for (const code of opening.opening) {
      duel.newCard({
        code,
        owner,
        player,
        location: LOCATION_HAND,
        sequence: seq,
        position: POS_FACEDOWN_DEFENSE,
      });
      seq += 1;
    }
    seq = 0;
    for (const code of opening.remain) {
      duel.newCard({
        code,
        owner,
        player,
        location: LOCATION_DECK,
        sequence: 0,
        position: POS_FACEDOWN_DEFENSE,
      });
    }
    seq = 0;
    for (const code of deck.extra) {
      duel.newCard({
        code,
        owner,
        player,
        location: LOCATION_EXTRA,
        sequence: 0,
        position: POS_FACEDOWN_DEFENSE,
      });
    }
  }

  createDuelInstance() {
    const duel = this.yrpVersion === 2 && this.seedSequence.length > 0
      ? this.wrapper.createDuelV2(this.seedSequence)
      : this.wrapper.createDuel(this.seed);
    duel.setPlayerInfo({ player: 0, lp: 8000, startHand: 0, drawCount: 1 });
    duel.setPlayerInfo({ player: 1, lp: 8000, startHand: 0, drawCount: 1 });

    for (const preload of ['./script/patches/entry.lua', './script/special.lua', './script/init.lua']) {
      try {
        duel.preloadScript(preload);
      } catch {
        // ignore
      }
    }

    this.loadDeck(duel, this.playerDeck, this.playerOpening, 0, 0);
    this.loadDeck(duel, this.opponentDeck, this.opponentOpening, 1, 1);
    duel.startDuel(CURRENT_DUEL_OPTIONS);
    return duel;
  }

  loadReplayDeck(duel, deck, opening, owner, player) {
    const main = buildReplayMainDeck(opening, deck?.main ?? []);
    for (const code of main) {
      duel.newCard({
        code,
        owner,
        player,
        location: LOCATION_DECK,
        sequence: 0,
        position: POS_FACEDOWN_DEFENSE,
      });
    }
    for (const code of deck?.extra ?? []) {
      duel.newCard({
        code,
        owner,
        player,
        location: LOCATION_EXTRA,
        sequence: 0,
        position: POS_FACEDOWN_DEFENSE,
      });
    }
  }

  createReplayCompatibleDuelInstance() {
    const duel = this.yrpVersion === 2 && this.seedSequence.length > 0
      ? this.wrapper.createDuelV2(this.seedSequence)
      : this.wrapper.createDuel(this.seed);
    duel.setPlayerInfo({ player: 0, lp: 8000, startHand: this.drawCount, drawCount: 1 });
    duel.setPlayerInfo({ player: 1, lp: 8000, startHand: this.drawCount, drawCount: 1 });

    for (const preload of ['./script/patches/entry.lua', './script/special.lua', './script/init.lua']) {
      try {
        duel.preloadScript(preload);
      } catch {
        // ignore
      }
    }

    this.loadReplayDeck(duel, this.playerDeck, this.playerOpening, 0, 0);
    this.loadReplayDeck(duel, this.opponentDeck, this.opponentOpening, 1, 1);
    duel.startDuel(CURRENT_DUEL_OPTIONS);
    return duel;
  }

  isExactReplayActionMatch(left, right) {
    if (!left || !right) return false;
    if (left.label !== right.label) return false;
    if ((left.kind ?? '') !== (right.kind ?? '')) return false;
    if (typeof left.intResponse === 'number' || typeof right.intResponse === 'number') {
      return (left.intResponse | 0) === (right.intResponse | 0);
    }
    const leftBytes = left.response ? toUint8Array(left.response) : null;
    const rightBytes = right.response ? toUint8Array(right.response) : null;
    if (!leftBytes || !rightBytes || leftBytes.length !== rightBytes.length) return false;
    for (let i = 0; i < leftBytes.length; i += 1) {
      if (leftBytes[i] !== rightBytes[i]) return false;
    }
    return true;
  }

  resolveReplayAction(encoded, decision) {
    const decoded = this.decodeAction(encoded);
    if (!decision || decision.terminal || !Array.isArray(decision.actions)) {
      return decoded;
    }
    const sameLabel = decision.actions.filter((action) => action?.label === decoded.label);
    const sameKind = sameLabel.filter((action) => !decoded.kind || action.kind === decoded.kind);
    const exact = sameKind.find((action) => this.isExactReplayActionMatch(action, decoded));
    if (exact) return exact;
    if (sameKind.length > 0 || sameLabel.length > 0) {
      this.logDecisionWarning('replay-action-exact-miss', {
        label: decoded.label,
        kind: decoded.kind ?? '',
        historyLength: this.actionHistory.length,
        candidateCount: sameKind.length || sameLabel.length,
        fallback: 'decoded-response',
      });
    }
    return decoded;
  }

  hasReplayActionMatch(encoded, decision) {
    if (!decision || decision.terminal || !Array.isArray(decision.actions)) return false;
    const decoded = this.decodeAction(encoded);
    return decision.actions.some((action) =>
      this.isExactReplayActionMatch(action, decoded)
      || (action?.label === decoded.label && (!decoded.kind || action.kind === decoded.kind)));
  }

  pickForcedReplayAction(decision) {
    if (!decision || decision.terminal || !Array.isArray(decision.actions)) return null;
    if (decision.actions.length !== 1) return null;
    return decision.actions[0] ?? null;
  }

  encodeAction(action) {
    const out = {
      label: action.label,
      kind: action.kind,
      text: action.text ?? '',
    };
    if (typeof action.intResponse === 'number') {
      out.intResponse = action.intResponse;
      return out;
    }
    out.responseBase64 = Buffer.from(toUint8Array(action.response) ?? new Uint8Array(0)).toString('base64');
    return out;
  }

  decodeAction(encoded) {
    if (typeof encoded.intResponse === 'number') {
      return {
        label: encoded.label,
        kind: encoded.kind,
        text: encoded.text ?? '',
        intResponse: encoded.intResponse,
      };
    }
    if (encoded.response instanceof Uint8Array || Array.isArray(encoded.response)) {
      return {
        label: encoded.label,
        kind: encoded.kind,
        text: encoded.text ?? '',
        response: toUint8Array(encoded.response) ?? new Uint8Array(0),
      };
    }
    return {
      label: encoded.label,
      kind: encoded.kind,
      text: encoded.text ?? '',
      response: Uint8Array.from(Buffer.from(encoded.responseBase64 ?? '', 'base64')),
    };
  }

  hasNativeSnapshotApi() {
    const mode = this.ensureNativeSnapshotMode();
    return mode === 'legacy' || mode === 'modern';
  }

  captureNativeSnapshotBytes() {
    const mode = this.ensureNativeSnapshotMode();
    if (!this.duel || mode === 'none') return null;
    try {
      if (mode === 'legacy') {
        return toUint8Array(this.duel.saveState());
      }
      if (mode === 'modern') {
        return toUint8Array(this.duel.snapshot());
      }
    } catch {
      return null;
    }
    return null;
  }

  captureNativeSnapshotBase64() {
    const bytes = this.captureNativeSnapshotBytes();
    if (!bytes || bytes.length === 0) return '';
    return Buffer.from(bytes).toString('base64');
  }

  restoreModernSnapshotFromMemory(metadata, memory, options = {}) {
    const startedAt = startProfileTimer();
    if (
      !metadata ||
      !(memory instanceof Uint8Array) ||
      (
        this.ensureNativeSnapshotMode() !== 'modern' &&
        !(options.allowWithoutCurrentDuel && !this.duel)
      ) ||
      !this.wrapper ||
      !this.wrapper.ocgcoreModule ||
      typeof this.wrapper.attachDuel !== 'function' ||
      typeof this.wrapper.restoreSnapshotState !== 'function'
    ) {
      endProfileTimer('restoreModernSnapshotFromMemory', startedAt);
      return false;
    }

    try {
      const heap = this.wrapper.ocgcoreModule.HEAPU8;
      if (!(heap instanceof Uint8Array)) return false;

      const currentMeta = !options.forceRecreate && this.duel
        ? this.captureModernSnapshotMetadata()
        : null;
      if (currentMeta && canRestoreModernSnapshotInPlace(currentMeta, metadata)) {
        heap.set(memory, 0);
        this.wrapper.restoreSnapshotState(metadata.wrapper);
        if (!this.reattachModernDuelFromMetadata(metadata)) return false;
        this.currentDecision = options.skipAdvance
          ? null
          : this.advanceUntilDecision();
        endProfileTimer('restoreModernSnapshotFromMemory', startedAt);
        return true;
      }

      if (this.duel) {
        try {
          this.duel.endDuel();
        } catch {
          // ignore
        }
      }
      this.duel = null;
      this.currentDecision = null;
      this.setActionHistory([], '');
      this.clearStatePool();

      ensureOcgcoreModuleMemoryCapacity(
        this.wrapper.ocgcoreModule,
        metadata.memoryByteLength,
      );
      const targetHeap = this.wrapper.ocgcoreModule.HEAPU8;
      if (!(targetHeap instanceof Uint8Array)) return false;
      targetHeap.set(memory, 0);
      this.wrapper.restoreSnapshotState(metadata.wrapper);
      if (!this.reattachModernDuelFromMetadata(metadata)) return false;
      this.currentDecision = options.skipAdvance
        ? null
        : this.advanceUntilDecision();
      return true;
    } catch (err) {
      if (process.env.COMBO_DELTA_RESTORE_DIAG === '1') {
        console.error(
          `[modern-snapshot-restore-failed] memory=${metadata?.memoryByteLength ?? 0} history=${this.actionHistory.length} skipAdvance=${!!options.skipAdvance} error=${err?.message ?? String(err)}`,
        );
      }
      return false;
    } finally {
      endProfileTimer('restoreModernSnapshotFromMemory', startedAt);
    }
  }

  reattachModernDuelFromMetadata(metadata) {
    if (
      !metadata?.duel ||
      !this.wrapper ||
      typeof this.wrapper.attachDuel !== 'function'
    ) {
      return false;
    }
    this.duel = this.wrapper.attachDuel(
      metadata.duel.duelPtr,
      metadata.duel,
    );
    this.ensureNativeSnapshotMode();
    this.modernSnapshotMetadata = metadata;
    return !!this.duel;
  }

  restoreModernSnapshotBytes(snapshotBytes, options = {}) {
    const bytes = toUint8Array(snapshotBytes);
    if (!bytes || bytes.length === 0) return false;
    if (this.ensureNativeSnapshotMode() !== 'modern') return false;
    if (
      !this.wrapper ||
      !this.wrapper.ocgcoreModule ||
      typeof this.wrapper.attachDuel !== 'function' ||
      typeof this.wrapper.restoreSnapshotState !== 'function'
    ) {
      return false;
    }

    let decoded;
    try {
      decoded = decodeOcgcoreDuelSnapshotBytes(bytes);
    } catch {
      return false;
    }

    return this.restoreModernSnapshotFromMemory(decoded.metadata, decoded.memory, options);
  }

  getModernSnapshotEntryForKey(key) {
    if (typeof key === 'string' && key) {
      return this.nativeSnapshotPool.get(key) ?? null;
    }
    const rootSnapshot = this.ensureModernRootSnapshot();
    if (!rootSnapshot) return null;
    return {
      type: 'page-delta',
      metadata: rootSnapshot.metadata,
      pageOffsets: new Uint32Array(0),
      pageData: new Uint8Array(0),
      pageSize: MODERN_SNAPSHOT_PAGE_SIZE,
      byteLength: 0,
    };
  }

  restoreCompressedModernSnapshotInPlace(currentKey, snapshotEntry, options = {}) {
    const startedAt = startProfileTimer();
    const rootSnapshot = this.ensureModernRootSnapshot();
    const currentEntry = this.getModernSnapshotEntryForKey(currentKey);
    const heap = this.wrapper?.ocgcoreModule?.HEAPU8;
    if (
      !rootSnapshot ||
      !currentEntry ||
      !snapshotEntry ||
      !this.duel ||
      !(heap instanceof Uint8Array) ||
      snapshotEntry.type !== 'page-delta'
    ) {
      endProfileTimer('restoreCompressedModernSnapshotInPlace', startedAt);
      return false;
    }
    const currentMeta = currentEntry.metadata;
    const targetMeta = snapshotEntry.metadata;
    if (!canRestoreModernSnapshotInPlace(currentMeta, targetMeta)) {
      endProfileTimer('restoreCompressedModernSnapshotInPlace', startedAt);
      return false;
    }

    const currentPages = buildSnapshotPageMap(currentEntry);
    const targetPages = buildSnapshotPageMap(snapshotEntry);
    const touchedOffsets = new Set([
      ...currentPages.keys(),
      ...targetPages.keys(),
    ]);

    try {
      for (const offset of touchedOffsets) {
        const targetBytes = targetPages.get(offset);
        if (targetBytes instanceof Uint8Array) {
          heap.set(targetBytes, offset);
          continue;
        }
        const end = Math.min(offset + MODERN_SNAPSHOT_PAGE_SIZE, targetMeta.memoryByteLength);
        const rootSlice = rootSnapshot.memory.subarray(offset, end);
        heap.set(rootSlice, offset);
      }

      this.wrapper.restoreSnapshotState(targetMeta.wrapper);
      if (!this.reattachModernDuelFromMetadata(targetMeta)) return false;
      this.currentDecision = options.skipAdvance
        ? null
        : this.advanceUntilDecision();
      endProfileTimer('restoreCompressedModernSnapshotInPlace', startedAt);
      return true;
    } catch (err) {
      console.error(
        `[search-delta-restore-inplace-failed] currentKey=${currentKey || '<root>'} targetPages=${targetPages.size} touched=${touchedOffsets.size} history=${this.actionHistory.length} decision=${formatDebugDecision(this.currentDecision)}`,
      );
      throw err;
    }
  }

  restoreCompressedModernSnapshotFromRoot(snapshotEntry, options = {}) {
    const startedAt = startProfileTimer();
    const rootSnapshot = this.ensureModernRootSnapshot();
    const heap = this.wrapper?.ocgcoreModule?.HEAPU8;
    if (
      !rootSnapshot ||
      !snapshotEntry ||
      !(heap instanceof Uint8Array) ||
      snapshotEntry.type !== 'page-delta' ||
      !canRestoreModernSnapshotInPlace(rootSnapshot.metadata, snapshotEntry.metadata)
    ) {
      endProfileTimer('restoreCompressedModernSnapshotFromRoot', startedAt);
      return false;
    }
    try {
      heap.set(rootSnapshot.memory, 0);
      forEachSnapshotPage(snapshotEntry, (offset, bytes) => {
        heap.set(bytes, offset);
      });
      this.wrapper.restoreSnapshotState(snapshotEntry.metadata.wrapper);
      if (!this.reattachModernDuelFromMetadata(snapshotEntry.metadata)) return false;
      this.currentDecision = options.skipAdvance
        ? null
        : this.advanceUntilDecision();
      return true;
    } catch (err) {
      console.error(
        `[search-delta-restore-root-failed] pageCount=${Math.ceil((snapshotEntry.pageOffsets?.length ?? 0))} history=${this.actionHistory.length} decision=${formatDebugDecision(this.currentDecision)}`,
      );
      throw err;
    } finally {
      endProfileTimer('restoreCompressedModernSnapshotFromRoot', startedAt);
    }
  }

  restoreCompressedModernSnapshot(snapshotEntry, targetKey = '', options = {}) {
    recordProfileEvent('restoreCompressedModernSnapshot.attempt');
    const rootSnapshot = this.ensureModernRootSnapshot();
    if (
      !rootSnapshot ||
      !snapshotEntry ||
      snapshotEntry.type !== 'page-delta' ||
      !snapshotEntry.metadata
    ) {
      recordProfileEvent('restoreCompressedModernSnapshot.invalid');
      return false;
    }
    const currentKey = this.actionHistoryKey;
    try {
      if (this.restoreCompressedModernSnapshotInPlace(currentKey, snapshotEntry, options)) {
        recordProfileEvent('restoreCompressedModernSnapshot.path.inPlace.hit');
        return true;
      }
      recordProfileEvent('restoreCompressedModernSnapshot.path.inPlace.miss');
    } catch (err) {
      recordProfileEvent('restoreCompressedModernSnapshot.path.inPlace.error');
      console.error(
        `[search-delta-restore-inplace-recoverable] targetKey=${targetKey || '<root>'} error=${err?.message ?? String(err)}`,
      );
    }
    try {
      if (this.restoreCompressedModernSnapshotFromRoot(snapshotEntry, options)) {
        recordProfileEvent('restoreCompressedModernSnapshot.path.root.hit');
        return true;
      }
      recordProfileEvent('restoreCompressedModernSnapshot.path.root.miss');
    } catch (err) {
      recordProfileEvent('restoreCompressedModernSnapshot.path.root.error');
      console.error(
        `[search-delta-restore-root-recoverable] targetKey=${targetKey || '<root>'} error=${err?.message ?? String(err)}`,
      );
    }
    const baseMemory = createBaseMemoryFromRoot(
      rootSnapshot.memory,
      snapshotEntry.metadata.memoryByteLength,
    );
    if (!(baseMemory instanceof Uint8Array)) {
      recordProfileEvent('restoreCompressedModernSnapshot.path.memory.invalid');
      return false;
    }
    forEachSnapshotPage(snapshotEntry, (offset, bytes) => {
      baseMemory.set(bytes, offset);
    });
    try {
      const restoredFromMemory = this.restoreModernSnapshotFromMemory(snapshotEntry.metadata, baseMemory, options);
      recordProfileEvent(
        restoredFromMemory
          ? 'restoreCompressedModernSnapshot.path.memory.hit'
          : 'restoreCompressedModernSnapshot.path.memory.miss',
      );
      return restoredFromMemory;
    } catch (err) {
      recordProfileEvent('restoreCompressedModernSnapshot.path.memory.error');
      console.error(
        `[search-delta-restore-fallback-failed] targetKey=${targetKey || '<root>'} memory=${snapshotEntry.metadata?.memoryByteLength ?? 0} history=${this.actionHistory.length} decision=${formatDebugDecision(this.currentDecision)}`,
      );
      console.error(
        `[search-delta-restore-fallback-recoverable] targetKey=${targetKey || '<root>'} error=${err?.message ?? String(err)}`,
      );
      return false;
    }
    finally {
      if (process.env.COMBO_DELTA_RESTORE_DIAG === '1') {
        console.error(
          `[delta-restore-fallback-finished] targetKey=${targetKey || '<root>'} memory=${snapshotEntry.metadata?.memoryByteLength ?? 0} history=${this.actionHistory.length}`,
        );
      }
    }
  }

  restoreModernRootSnapshot(options = {}) {
    const rootSnapshot = this.ensureModernRootSnapshot();
    if (!rootSnapshot) return false;
    const currentKey = this.actionHistoryKey;
    const rootEntry = this.getModernSnapshotEntryForKey('');
    if (!options.forceRecreate) {
      try {
        if (this.restoreCompressedModernSnapshotInPlace(currentKey, rootEntry, options)) {
          return true;
        }
      } catch (err) {
        console.error(
          `[search-root-snapshot-inplace-fallback] currentKey=${currentKey || '<root>'} error=${err?.message ?? String(err)}`,
        );
      }
    }
    if (this.duel) {
      try {
        this.duel.endDuel();
      } catch {
        // ignore; the full root restore below replaces wrapper state and heap.
      }
    }
    this.duel = null;
    this.currentDecision = null;
    this.setActionHistory([], '');
    const baseMemory = createBaseMemoryFromRoot(
      rootSnapshot.memory,
      rootSnapshot.metadata.memoryByteLength,
    );
    if (!(baseMemory instanceof Uint8Array)) return false;
    return this.restoreModernSnapshotFromMemory(rootSnapshot.metadata, baseMemory, {
      ...options,
      allowWithoutCurrentDuel: true,
      forceRecreate: true,
    });
  }

  restoreNativeSnapshotBytes(snapshotBytes, options = {}) {
    const bytes = toUint8Array(snapshotBytes);
    if (!bytes || bytes.length === 0) return false;
    const mode = this.ensureNativeSnapshotMode();
    if (mode === 'legacy') {
      if (!this.duel || typeof this.duel.loadState !== 'function') return false;
      try {
        this.duel.loadState(bytes);
        this.currentDecision = options.skipAdvance
          ? null
          : this.advanceUntilDecision();
        return true;
      } catch {
        return false;
      }
    }
    if (mode === 'modern') {
      return this.restoreModernSnapshotBytes(bytes, options);
    }
    return false;
  }

  restoreNativeSnapshotBase64(snapshotBase64, options = {}) {
    if (!snapshotBase64) return false;
    try {
      const bytes = Uint8Array.from(Buffer.from(snapshotBase64, 'base64'));
      return this.restoreNativeSnapshotBytes(bytes, options);
    } catch {
      return false;
    }
  }

  tryRestoreNativeSnapshotFromPool(key, options = {}) {
    if (typeof key !== 'string') return false;
    const snapshotBytes = this.getNativeSnapshotFromPool(key);
    if (!snapshotBytes) return false;
    if (snapshotBytes?.type === 'full') {
      return this.restoreModernSnapshotFromMemory(snapshotBytes.metadata, snapshotBytes.memory, options);
    }
    if (snapshotBytes?.type === 'page-delta') {
      return this.restoreCompressedModernSnapshot(snapshotBytes, key, options);
    }
    return this.restoreNativeSnapshotBytes(snapshotBytes, options);
  }

  ensureCurrentNativeSnapshotCached(historyOverride = null, historyKeyOverride = null) {
    const snapshotMode = this.ensureNativeSnapshotMode();
    if (snapshotMode !== 'modern') return '';
    const history = Array.isArray(historyOverride)
      ? historyOverride
      : this.actionHistory;
    const historyKey =
      typeof historyKeyOverride === 'string'
        ? historyKeyOverride
        : Array.isArray(historyOverride)
          ? this.makeHistoryKey(historyOverride)
          : this.actionHistoryKey;
    if (!historyKey && snapshotStorageMode === 'delta') {
      this.ensureModernRootSnapshot();
      return historyKey;
    }
    if (this.nativeSnapshotPool.has(historyKey)) {
      this.touchNativeSnapshotPoolKey(historyKey);
      return historyKey;
    }
    const snapshotEntry =
      snapshotStorageMode === 'full'
        ? (() => {
            const heap = this.wrapper?.ocgcoreModule?.HEAPU8;
            if (!(heap instanceof Uint8Array)) return null;
            const metadata = this.captureModernSnapshotMetadata();
            if (!metadata) return null;
            const memory = Buffer.from(heap.buffer, 0, metadata.memoryByteLength);
            return { type: 'full', metadata, memory };
          })()
        : this.captureCompressedModernSnapshot();
    if (snapshotEntry) {
      this.putNativeSnapshotIntoPool(historyKey, snapshotEntry);
    }
    return historyKey;
  }

  saveResultState() {
    const startedAt = startProfileTimer();
    try {
      return {
        history: cloneEncodedHistory(this.actionHistory),
        historyKey: this.actionHistoryKey,
        decision: cloneDecisionState(this.currentDecision),
      };
    } finally {
      endProfileTimer('saveResultState', startedAt);
    }
  }

  saveState(reason = '') {
    const startedAt = startProfileTimer();
    const reasonLabel = String(reason || '').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80);
    try {
      const history = cloneEncodedHistory(this.actionHistory);
      const historyKey = this.ensureCurrentNativeSnapshotCached(
        history,
        this.actionHistoryKey,
      );
      const state = {
        history,
        historyKey,
        decision: cloneDecisionState(this.currentDecision),
      };
      const snapshotMode = this.ensureNativeSnapshotMode();
      if (snapshotMode === 'legacy') {
        const snapshotBase64 = this.captureNativeSnapshotBase64();
        if (snapshotBase64) state.snapshotBase64 = snapshotBase64;
        return state;
      }
      return state;
    } catch (err) {
      console.error(
        `[search-save-state-failed] history=${this.actionHistory.length} decision=${formatDebugDecision(this.currentDecision)}`,
      );
      throw err;
    } finally {
      endProfileTimer('saveState', startedAt);
      if (reasonLabel) endProfileTimer(`saveState.reason.${reasonLabel}`, startedAt);
    }
  }

  restoreState(state) {
    const startedAt = startProfileTimer();
    try {
      if (Array.isArray(state?.history)) {
        const history = state.history;
        const decision =
          state._inflatedDecision !== undefined
            ? state._inflatedDecision
            : (state._inflatedDecision = inflateDecisionState(state.decision));
        const currentKey = this.actionHistoryKey;
        const targetKey =
          typeof state.historyKey === 'string' && state.historyKey
            ? state.historyKey
            : this.makeHistoryKey(history);
        if (this.duel && currentKey === targetKey) {
          // Even when historyKey matches, we must restore decision if provided
          // (worker may have updated decision while history stayed the same)
          if (decision) this.currentDecision = decision;
          return;
        }
        const restoreOptions = { skipAdvance: !!decision };
        if (this.restoreNativeSnapshotBase64(state.snapshotBase64, restoreOptions)) {
          this.setActionHistory(history, targetKey);
          if (decision) this.currentDecision = decision;
          return;
        }
        let restoredRootSnapshot = false;
        if (snapshotStorageMode === 'delta' && !targetKey) {
          try {
            restoredRootSnapshot = this.restoreModernRootSnapshot(restoreOptions);
          } catch (err) {
            console.error(
              `[search-root-snapshot-restore-fallback] error=${err?.message ?? String(err)}`,
            );
          }
        }
        if (restoredRootSnapshot) {
          this.setActionHistory(history, targetKey);
          if (decision) this.currentDecision = decision;
          return;
        }
        let restoredFromSnapshot = false;
        try {
          restoredFromSnapshot = this.tryRestoreNativeSnapshotFromPool(targetKey, restoreOptions);
        } catch (err) {
          console.error(
            `[search-snapshot-restore-fallback] targetHistory=${history.length} targetKey=${targetKey || '<root>'} error=${err?.message ?? String(err)}`,
          );
        }
        if (restoredFromSnapshot) {
          this.setActionHistory(history, targetKey);
          if (decision) this.currentDecision = decision;
          return;
        }
        this.rebuildFromHistory(history);
        if (decision) this.currentDecision = decision;
        return;
      }
      const n = Math.max(0, Math.min(this.actionHistory.length, state?.historyLength ?? 0));
      this.rebuildFromHistory(this.actionHistory.slice(0, n));
    } catch (err) {
      const targetHistoryLength = Array.isArray(state?.history) ? state.history.length : Number(state?.historyLength ?? 0);
      console.error(
        `[search-restore-state-failed] currentHistory=${this.actionHistory.length} targetHistory=${targetHistoryLength} decision=${formatDebugDecision(this.currentDecision)}`,
      );
      throw err;
    } finally {
      endProfileTimer('restoreState', startedAt);
    }
  }

  rebuildFromHistory(history) {
    const startedAt = startProfileTimer();
    try {
      const targetHistory = cloneEncodedHistory(history);
      const targetKey = this.makeHistoryKey(targetHistory);
      const currentKey = this.actionHistoryKey;
      if (this.duel && currentKey === targetKey) {
        this.setActionHistory(targetHistory, targetKey);
        return;
      }

      if (this.duel) {
        if (this.ensureNativeSnapshotMode() === 'modern') {
          try {
            this.duel.endDuel();
          } catch {
            // ignore
          }
        } else {
          this.putStateIntoPool(currentKey, this.duel, this.currentDecision, this.actionHistory);
        }
        this.duel = null;
        this.currentDecision = null;
        this.setActionHistory([], '');
      }

      const pooled = this.takeStateFromPool(targetKey);
      if (pooled?.duel) {
        this.duel = pooled.duel;
        this.currentDecision = pooled.decision;
        this.setActionHistory(pooled.history, pooled.historyKey ?? targetKey, { assumeOwned: true });
        this.ensureNativeSnapshotMode();
        return;
      }

      const prefixSnapshot = this.findNearestNativeSnapshotPrefix(targetHistory, targetKey);
      let restoredPrefixSnapshot = false;
      if (prefixSnapshot) {
        try {
          restoredPrefixSnapshot = this.tryRestoreNativeSnapshotFromPool(prefixSnapshot.historyKey);
        } catch (err) {
          console.error(
            `[search-rebuild-prefix-restore-fallback] prefix=${prefixSnapshot.length} total=${targetHistory.length} error=${err?.message ?? String(err)}`,
          );
        }
      }
      if (prefixSnapshot && restoredPrefixSnapshot) {
        this.setActionHistory(prefixSnapshot.history, prefixSnapshot.historyKey);
        for (let index = prefixSnapshot.length; index < targetHistory.length; index += 1) {
          const encoded = targetHistory[index];
          const action = this.decodeAction(encoded);
          try {
            this.step(action);
          } catch (err) {
            console.error(
              `[search-rebuild-prefix-failed] prefix=${prefixSnapshot.length} index=${index} total=${targetHistory.length} msg=${this.currentDecision?.message?.constructor?.name ?? this.currentDecision?.reason ?? 'unknown'} action=${formatDebugAction(action)} history=${this.actionHistory.length}`,
            );
            throw err;
          }
          if (this.currentDecision?.terminal) break;
        }
        return;
      }

      let restoredRootForRebuild = false;
      if (this.ensureNativeSnapshotMode() === 'modern') {
        try {
          restoredRootForRebuild = this.restoreModernRootSnapshot({
            forceRecreate: true,
          });
        } catch (err) {
          console.error(
            `[search-rebuild-root-restore-fallback] total=${targetHistory.length} error=${err?.message ?? String(err)}`,
          );
        }
      }

      if (!restoredRootForRebuild) {
        this.duel = this.createDuelInstance();
        this.currentDecision = this.advanceUntilDecision();
        this.setActionHistory([], '');
        this.ensureNativeSnapshotMode();
        if (targetHistory.length === 0 && this.ensureNativeSnapshotMode() === 'modern') {
          this.modernRootSnapshot = null;
          this.modernSnapshotMetadata = null;
          this.ensureModernRootSnapshot();
        }
      } else {
        this.setActionHistory([], '');
      }

      for (let index = 0; index < targetHistory.length; index += 1) {
        const encoded = targetHistory[index];
        const action = this.decodeAction(encoded);
        try {
          this.step(action);
        } catch (err) {
          console.error(
            `[search-rebuild-history-failed] index=${index} total=${targetHistory.length} msg=${this.currentDecision?.message?.constructor?.name ?? this.currentDecision?.reason ?? 'unknown'} action=${formatDebugAction(action)} history=${this.actionHistory.length}`,
          );
          throw err;
        }
        if (this.currentDecision?.terminal) break;
      }
    } finally {
      endProfileTimer('rebuildFromHistory', startedAt);
    }
  }

  step(action) {
    const startedAt = startProfileTimer();
    try {
      const currentMessageName = this.currentDecision?.message?.constructor?.name ?? this.currentDecision?.reason ?? 'unknown';
      const previousHistoryLength = this.actionHistory.length;
      try {
        if (typeof action.intResponse === 'number') {
          this.duel.setResponseInt(action.intResponse);
        } else {
          this.duel.setResponse(action.response);
        }
        this.pushEncodedHistoryAction(this.encodeAction(action));
        this.currentDecision = this.advanceUntilDecision();
        return this.currentDecision;
      } catch (err) {
        const detail = `[search-step-failed] msg=${currentMessageName} action=${formatDebugAction(action)} history=${this.actionHistory.length}`;
        if (
          this.shouldLogSearchDecisions() ||
          process.env.COMBO_LOG_RECOVERED_STEP_FAILURES === '1'
        ) {
          console.error(detail);
        }
        try {
          const previousHistory = this.actionHistory.slice(0, previousHistoryLength);
          this.logDecisionWarning('step-rebuild-retry', {
            message: currentMessageName,
            historyLength: previousHistory.length,
            action: formatDebugAction(action),
          });
          this.rebuildFromHistory(previousHistory);
          if (typeof action.intResponse === 'number') {
            this.duel.setResponseInt(action.intResponse);
          } else {
            this.duel.setResponse(action.response);
          }
          this.pushEncodedHistoryAction(this.encodeAction(action));
          this.currentDecision = this.advanceUntilDecision();
          this.logDecisionWarning('step-rebuild-retry-succeeded', {
            message: currentMessageName,
            historyLength: this.actionHistory.length,
            action: formatDebugAction(action),
          });
          return this.currentDecision;
        } catch (retryErr) {
          const message = err?.message ? `${err.message} | ${detail}` : detail;
          const retryMessage = retryErr?.message ? ` | retry=${retryErr.message}` : '';
          throw new Error(`${message}${retryMessage}`);
        }
      }
    } finally {
      endProfileTimer('step', startedAt);
    }
  }

  autoRespond(msg) {
    const sendResponse = (resp) => {
      this.duel.setResponse(resp);
      this.collectReplayResponse({ response: resp });
      return true;
    };
    const sendInt = (value) => {
      this.duel.setResponseInt(value | 0);
      this.collectReplayResponse({ intResponse: value | 0 });
      return true;
    };

    try {
      const def = msg.defaultResponse?.();
      if (def) {
        return sendResponse(def);
      }
    } catch {
      // ignore
    }

    if (this.isMsgType(msg, 'SelectOption')) {
      const val = msg.options?.[0] ?? 0;
      try {
        return sendResponse(msg.prepareResponse(val));
      } catch {
        // ignore
      }
      try {
        return sendResponse(msg.prepareResponse(0));
      } catch {
        // ignore
      }
    }

    const autoActions = this.enumerateActions(msg, { keepRepositionSet: true });
    const factorizedSelection = autoActions.factorizedSelection;
    if (factorizedSelection) {
      const constraints = factorizedSelection.selectionConstraints ?? {};
      const min = Math.max(0, Math.trunc(Number(constraints.min) || 0));
      const available = Math.max(0, Math.trunc(Number(constraints.available) || 0));
      if (min <= available) {
        try {
          const selected = Array.from({ length: min }, (_, index) => makeIndexResponse(index));
          return sendResponse(msg.prepareResponse(selected));
        } catch {
          return false;
        }
      }
      return false;
    }
    if (autoActions.length > 0) {
      const preferred =
        autoActions.find((a) => a.kind === 'phase_end') ??
        autoActions.find((a) => a.kind === 'other') ??
        autoActions[0];
      if (typeof preferred?.intResponse === 'number') {
        try {
          return sendInt(preferred.intResponse);
        } catch {
          // ignore
        }
      } else if (preferred?.response) {
        try {
          return sendResponse(preferred.response);
        } catch {
          // ignore
        }
      }
    }

    try {
      return sendInt(0);
    } catch {
      return false;
    }
  }

  tryAutoRespondDecisionMessage(msg, backend = null) {
    if (!this.isDecisionMessage(msg)) return null;
    const responsePlayer = typeof msg.responsePlayer === 'function' ? msg.responsePlayer() : 0;
    if (responsePlayer === 0) return null;
    if (this.autoRespond(msg)) {
      this.logDecisionDebug('decision-auto-respond', {
        historyLength: this.actionHistory.length,
        message: this.formatDecisionMessageName(msg),
        responsePlayer,
        ...(backend ? { backend } : {}),
      });
      return { handled: true, result: null };
    }
    this.logDecisionWarning('decision-terminal', {
      reason: 'AUTO_RESPONSE_FAIL',
      historyLength: this.actionHistory.length,
      message: this.formatDecisionMessageName(msg),
      responsePlayer,
      ...(backend ? { backend } : {}),
    });
    return {
      handled: true,
      result: { terminal: true, reason: 'AUTO_RESPONSE_FAIL', actions: [] },
    };
  }

  advanceUntilDecision() {
    const startedAt = startProfileTimer();
    try {
      const ocgcoreModule = this.wrapper?.ocgcoreModule;
      const duelPtr = this.duel?.duelPtr ?? 0;
      const receivePtr = this.duel?.receivePtr ?? 0;
      const copyHeap = typeof this.wrapper?.copyHeap === 'function'
        ? this.wrapper.copyHeap.bind(this.wrapper)
        : null;
      if (!ocgcoreModule || !duelPtr || !receivePtr || !copyHeap) {
        return { terminal: true, reason: 'PROCESS_UNAVAILABLE', actions: [] };
      }
      let guard = 0;
      while (guard < this.config.maxProcessPerStep) {
        guard += 1;
        const processStartedAt = startProfileTimer();
        const rawResult = ocgcoreModule._process(duelPtr);
        endProfileTimer('duel.process', processStartedAt);
        const length = (rawResult & 0x0fffffff) >>> 0;
        const status = (rawResult >>> 28) & 0x0f;
        let raw = null;
        if (length > 0) {
          ocgcoreModule._get_message(duelPtr, receivePtr);
          const heapU8 = ocgcoreModule.HEAPU8;
          raw =
            heapU8 instanceof Uint8Array
              ? heapU8.subarray(receivePtr, receivePtr + length)
              : copyHeap(receivePtr, length);
          let decisionResult = null;
          const scanResult = scanYgoProPayloadMessages(raw, (msg) => {
            const autoResponse = this.tryAutoRespondDecisionMessage(msg);
            if (autoResponse) {
              if (autoResponse.result) {
                decisionResult = autoResponse.result;
                return true;
              }
              return false;
            }
            const resolved = this.tryBuildDecisionFromMessage(msg);
            if (!resolved) return false;
            decisionResult = resolved;
            return true;
          });
          if (decisionResult) {
            return decisionResult;
          }
          if (!scanResult.ok) {
            try {
              const parsedMessages = ygopro.YGOProMessages.getInstancesFromPayload(raw);
              for (const msg of parsedMessages) {
                const autoResponse = this.tryAutoRespondDecisionMessage(msg);
                if (autoResponse) {
                  if (autoResponse.result) {
                    return autoResponse.result;
                  }
                  continue;
                }
                const resolved = this.tryBuildDecisionFromMessage(msg);
                if (resolved) {
                  return resolved;
                }
              }
            } catch {
              // ignore parse failure
            }
          }
        }

        if (status === 2) {
          this.logDecisionDebug('decision-terminal', {
            reason: 'STATUS_END',
            historyLength: this.actionHistory.length,
          });
          return { terminal: true, reason: 'STATUS_END', actions: [] };
        }
        if (raw && raw.length > 0 && raw[0] === COMMON.MSG_RETRY) {
          this.logDecisionWarning('decision-terminal', {
            reason: 'MSG_RETRY_RAW',
            historyLength: this.actionHistory.length,
          });
          return { terminal: true, reason: 'MSG_RETRY_RAW', actions: [] };
        }
      }
      this.logDecisionWarning('decision-terminal', {
        reason: 'PROCESS_GUARD',
        historyLength: this.actionHistory.length,
        maxProcessPerStep: this.config.maxProcessPerStep,
      });
      return { terminal: true, reason: 'PROCESS_GUARD', actions: [] };
    } finally {
      endProfileTimer('advanceUntilDecision', startedAt);
    }
  }

  makeAction({ label, kind, response, intResponse, text }) {
    const normalizedResponse =
      typeof intResponse === 'number'
        ? undefined
        : (toUint8Array(response) ?? new Uint8Array(0));
    return {
      label,
      kind,
      response: normalizedResponse,
      intResponse,
      text,
    };
  }

  isMsgType(msg, key) {
    if (!msg || !key) return false;
    const Ctor = this.classes[key];
    if (Ctor && msg instanceof Ctor) return true;
    const expectedName = this.classNames[key];
    return !!expectedName && msg?.constructor?.name === expectedName;
  }

  isDecisionMessage(msg) {
    if (!msg || this.isMsgType(msg, 'Retry')) return false;
    if (this.isMsgType(msg, 'Response')) return true;
    return typeof msg.prepareResponse === 'function';
  }

  tryBuildDecisionFromMessage(msg, backend = null) {
    if (this.isMsgType(msg, 'Retry')) {
      this.logDecisionWarning('decision-terminal', {
        reason: 'MSG_RETRY',
        historyLength: this.actionHistory.length,
        message: this.formatDecisionMessageName(msg),
        ...(backend ? { backend } : {}),
      });
      return { terminal: true, reason: 'MSG_RETRY', actions: [] };
    }
    if (!this.isDecisionMessage(msg)) return null;
    const enumerateStartedAt = startProfileTimer();
    const actions = this.enumerateActions(msg);
    endProfileTimer('enumerateActions', enumerateStartedAt);
    if (actions.length === 0) {
      this.logDecisionWarning('decision-terminal', {
        reason: 'NO_ACTION',
        historyLength: this.actionHistory.length,
        message: this.formatDecisionMessageName(msg),
        ...(backend ? { backend } : {}),
        optionKeys: Object.keys(msg ?? {}).sort(),
      });
      return { terminal: true, reason: 'NO_ACTION', actions: [] };
    }
    const factorizedSelection = actions.factorizedSelection ?? null;
    return {
      terminal: false,
      reason: null,
      actions,
      message: msg,
      ...(factorizedSelection ? {
        factorizedSelection: true,
        estimatedLegalCandidateCount: factorizedSelection.estimatedLegalCandidateCount,
        selectionConstraints: factorizedSelection.selectionConstraints,
      } : {}),
    };
  }

  shouldLogSearchDecisions() {
    return process.env.COMBO_SEARCH_DEBUG === '1' || process.env.COMBO_DECISION_DEBUG === '1';
  }

  formatDecisionMessageName(msg) {
    return msg?.constructor?.name ?? this.currentDecision?.message?.constructor?.name ?? 'UnknownDecision';
  }

  logDecisionDebug(message, detail = null) {
    if (!this.shouldLogSearchDecisions()) return;
    logTerminal('info', 'decision-debug', message, detail);
  }

  logDecisionWarning(message, detail = null) {
    if (!this.shouldLogSearchDecisions()) {
      if (message === 'replay-action-exact-miss') return;
      if (message === 'enumerate-unknown-message') return;
      if (message === 'step-rebuild-retry' || message === 'step-rebuild-retry-succeeded') return;
      const noisyReason = detail?.reason ?? '';
      if (
        message === 'decision-terminal' &&
        ['MSG_RETRY', 'MSG_RETRY_RAW', 'NO_ACTION', 'STATUS_END', 'PROCESS_GUARD', 'AUTO_RESPONSE_FAIL'].includes(noisyReason)
      ) {
        return;
      }
      if (message === 'prepare-response-failed') return;
    }
    logTerminal('warn', 'decision-debug', message, detail);
  }

  enumerateActions(msg, options = {}) {
    const actions = [];
    const add = (action) => {
      if (action) actions.push(action);
    };
    const addPrepared = (label, kind, prepare, text = '') => {
      try {
        add(this.makeAction({
          label,
          kind,
          response: prepare(),
          text,
        }));
      } catch (err) {
        this.logDecisionWarning('prepare-response-failed', {
          message: this.formatDecisionMessageName(msg),
          label,
          kind,
          error: err?.message ?? String(err),
        });
      }
    };
    const cardName = (code) => this.cardText.getName(code);
    const effectDetails = (code, desc) => this.cardText.getEffectDetails(code, desc);
    const effectLabel = (code, desc) => {
      const details = effectDetails(code, desc);
      return details.effectNumber !== null
        ? `（${details.reference}）`
        : `（${details.reference}，不要按序号猜测）`;
    };
    const effectText = (code, desc) => {
      const details = effectDetails(code, desc);
      const cardDescription = this.cardText.getDescription(code);
      const mapped = details.text
        ? `对应文本：${details.text}`
        : '本地数据未能把该引擎效果唯一映射到卡面编号；请以当前卡牌原文和引擎效果标识为准。';
      return `[${details.reference}] ${mapped}\n卡牌原文：${cardDescription}`.trim();
    };
    const messageName = this.formatDecisionMessageName(msg);
    const toIndexedItems = (items) => (items ?? []).map((item, index) => ({ item, index }));
    const toIndexResponses = (indices) => indices.map((index) => makeIndexResponse(index));
    const emitTrackedDecisionLog = () => {};

    if (this.isMsgType(msg, 'SelectIdle')) {
      for (const card of msg.summonableCards ?? []) {
        add(this.makeAction({
          label: formatCardChoiceLabel('通常召唤', cardName(card.code), card),
          kind: 'summon',
          response: msg.prepareResponse(IDLE_CMD.SUMMON, card),
          text: this.cardText.getDescription(card.code),
        }));
      }
      for (const card of msg.spSummonableCards ?? []) {
        add(this.makeAction({
          label: formatCardChoiceLabel('特殊召唤', cardName(card.code), card),
          kind: 'spsummon',
          response: msg.prepareResponse(IDLE_CMD.SPSUMMON, card),
          text: this.cardText.getDescription(card.code),
        }));
      }
      for (const card of msg.reposableCards ?? []) {
        add(this.makeAction({
          label: formatCardChoiceLabel('改变表示', cardName(card.code), card),
          kind: 'reposition',
          response: msg.prepareResponse(IDLE_CMD.REPOS, card),
          text: this.cardText.getDescription(card.code),
        }));
      }
      for (const card of msg.msetableCards ?? []) {
        add(this.makeAction({
          label: formatCardChoiceLabel('盖放怪兽', cardName(card.code), card),
          kind: 'set',
          response: msg.prepareResponse(IDLE_CMD.MSET, card),
          text: this.cardText.getDescription(card.code),
        }));
      }
      for (const card of msg.ssetableCards ?? []) {
        add(this.makeAction({
          label: formatCardChoiceLabel('盖放魔陷', cardName(card.code), card),
          kind: 'set',
          response: msg.prepareResponse(IDLE_CMD.SSET, card),
          text: this.cardText.getDescription(card.code),
        }));
      }
      for (const card of msg.activatableCards ?? []) {
        add(this.makeAction({
          label: `${formatCardChoiceLabel('发动效果', cardName(card.code), card)}${effectLabel(card.code, card.desc)}`,
          kind: 'activate',
          response: msg.prepareResponse(IDLE_CMD.ACTIVATE, card),
          text: effectText(card.code, card.desc),
        }));
      }
      if (msg.canBp) {
        add(this.makeAction({ label: '进入战斗阶段', kind: 'other', response: msg.prepareResponse(IDLE_CMD.TO_BP), text: '' }));
      }
      if (msg.canEp) {
        add(this.makeAction({ label: '结束回合', kind: 'phase_end', response: msg.prepareResponse(IDLE_CMD.TO_EP), text: '' }));
      }
    } else if (this.isMsgType(msg, 'SelectBattle')) {
      for (const card of msg.activatableCards ?? []) {
        add(this.makeAction({
          label: `${formatCardChoiceLabel('战阶发动', cardName(card.code), card)}${effectLabel(card.code, card.desc)}`,
          kind: 'activate',
          response: msg.prepareResponse(BATTLE_CMD.ACTIVATE, card),
          text: effectText(card.code, card.desc),
        }));
      }
      for (const card of msg.attackableCards ?? []) {
        add(this.makeAction({
          label: formatCardChoiceLabel('攻击', cardName(card.code), card),
          kind: 'attack',
          response: msg.prepareResponse(BATTLE_CMD.ATTACK, card),
          text: '',
        }));
      }
      if (msg.canM2) {
        add(this.makeAction({ label: '进入主要阶段2', kind: 'other', response: msg.prepareResponse(BATTLE_CMD.TO_M2), text: '' }));
      }
      if (msg.canEp) {
        add(this.makeAction({ label: '战阶结束', kind: 'phase_end', response: msg.prepareResponse(BATTLE_CMD.TO_EP), text: '' }));
      }
    } else if (this.isMsgType(msg, 'SelectChain')) {
      for (const chain of msg.chains ?? []) {
        add(this.makeAction({
          label: `${formatCardChoiceLabel('连锁发动', cardName(chain.code), chain)}${effectLabel(chain.code, chain.desc)}`,
          kind: 'chain',
          response: msg.prepareResponse(chain),
          text: effectText(chain.code, chain.desc),
        }));
      }
      const def = msg.defaultResponse?.();
      if (def) add(this.makeAction({ label: '不连锁', kind: 'other', response: def, text: '' }));
    } else if (this.isMsgType(msg, 'SelectEffectYn')) {
      const text = effectText(msg.code, msg.desc);
      add(this.makeAction({ label: `发动[${cardName(msg.code)}]${effectLabel(msg.code, msg.desc)}`, kind: 'activate', response: msg.prepareResponse(true), text }));
      add(this.makeAction({ label: `不发动[${cardName(msg.code)}]`, kind: 'other', response: msg.prepareResponse(false), text: '' }));
    } else if (this.isMsgType(msg, 'SelectYesNo')) {
      add(this.makeAction({ label: '选择[是]', kind: 'yes', response: msg.prepareResponse(true), text: '' }));
      add(this.makeAction({ label: '选择[否]', kind: 'other', response: msg.prepareResponse(false), text: '' }));
    } else if (this.isMsgType(msg, 'SelectOption')) {
      for (let i = 0; i < (msg.options?.length ?? 0); i += 1) {
        addPrepared(
          `选择选项#${i + 1}`,
          'option',
          () => msg.prepareResponse(makeIndexResponse(i)),
          '',
        );
      }
    } else if (this.isMsgType(msg, 'SelectCard')) {
      this.logDecisionDebug('select-card-candidates', {
        message: messageName,
        historyLength: this.actionHistory.length,
        min: msg.min ?? null,
        max: msg.max ?? null,
        cards: (msg.cards ?? []).map((card, index) => ({
          index,
          code: card?.code ?? null,
          name: card?.code ? cardName(card.code) : '',
          location: card?.location ?? null,
          sequence: card?.sequence ?? null,
          controller: card?.controller ?? null,
          position: card?.position ?? null,
        })),
      });
      const min = Math.max(0, msg.min ?? 1);
      const max = Math.max(min, Math.min(msg.max ?? min, (msg.cards ?? []).length));
      const indexedCards = toIndexedItems(msg.cards);
      if (min === 0) {
        addPrepared('不选择', 'other', () => msg.prepareResponse([]), '');
      }
      const def = msg.defaultResponse?.();
      if (def) {
        const isCancelDefault = isCancelSentinelResponse(def);
        const defaultSelectCardLabel =
          isCancelDefault
            ? `取消选择流程[${messageName}]`
            : (min > 0 ? `不发动[${messageName}]` : `不选择[${messageName}]`);
        if (isCancelDefault && HARD_DISABLE_SELECTCARD_CANCEL) {
          this.logDecisionDebug('select-card-cancel-suppressed', {
            message: messageName,
            min,
            max,
            cardCount: indexedCards.length,
          });
        } else {
          add(this.makeAction({
            label: defaultSelectCardLabel,
            kind: 'other',
            response: def,
            text: '',
          }));
        }
      }
      const enumerationCap = Math.max(1, Math.trunc(Number(this.config.maxActionsPerNode) || DEFAULT_OPTIONS.maxActionsPerNode));
      const estimatedLegalCandidateCount = estimateOrderedSelectionCount(indexedCards.length, min, max, Number.MAX_SAFE_INTEGER);
      const factorize = this.config.factorizeLargeSelections === true
        && estimatedLegalCandidateCount > enumerationCap;
      if (factorize) {
        for (const entry of indexedCards) {
          const card = entry.item;
          add({
            ...this.makeAction({
              label: formatCardChoiceLabel('选择卡片', cardName(card.code), card),
              kind: 'factorized_select_card_candidate',
              response: new Uint8Array(0),
              text: this.cardText.getDescription(card.code),
            }),
            selectionIndex: entry.index,
          });
        }
        Object.defineProperty(actions, 'factorizedSelection', {
          configurable: true,
          value: {
            estimatedLegalCandidateCount,
            selectionConstraints: {
              protocol: messageName,
              min,
              max,
              available: indexedCards.length,
              ordered: true,
              submitWith: 'executeAction.selectionIndexes',
            },
          },
        });
      } else {
        for (let count = Math.max(1, min); count <= max; count += 1) {
          const selectionIterator = count === 1
            ? chooseCombinations(indexedCards, count)
            : chooseOrderedSelections(indexedCards, count);
          for (const picked of selectionIterator) {
            const pickedCards = picked.map((entry) => entry.item);
            const pickedIndices = picked.map((entry) => entry.index);
            const label =
              count === 1
                ? formatCardChoiceLabel('选择卡片', cardName(pickedCards[0].code), pickedCards[0])
                : formatMultiCardChoiceLabel(picked, cardName);
            addPrepared(
              label,
              'other',
              () => msg.prepareResponse(toIndexResponses(pickedIndices)),
              pickedCards.map((c) => this.cardText.getDescription(c.code)).join(' '),
            );
          }
        }
      }
    } else if (this.isMsgType(msg, 'SelectPlace') || this.isMsgType(msg, 'SelectDisField')) {
      const places = msg.getSelectablePlaces?.() ?? [];
      const need = Math.max(1, msg.count ?? 1);
      if (places.length >= need) {
        const placeChoices = chooseCombinations(places, need);
        for (const picked of placeChoices) {
          const pickedPlaces = Array.isArray(picked) ? picked : [picked];
          const placeLabel = pickedPlaces.map(formatPlaceChoiceLabel).join(' + ');
          add(this.makeAction({
            label: `选择区域[${placeLabel}]`,
            kind: 'other',
            response: msg.prepareResponse(picked),
            text: `Select place: ${pickedPlaces.map(formatPlaceChoiceDebug).join(' + ')}`,
          }));
        }
      }
    } else if (this.isMsgType(msg, 'SelectPosition')) {
      const POS = [1, 2, 4, 8];
      for (const p of POS) {
        if ((msg.positions & p) !== 0) {
          add(this.makeAction({ label: `选择表示形式(${p})`, kind: 'other', response: msg.prepareResponse(p), text: '' }));
        }
      }
    } else if (this.isMsgType(msg, 'SelectTribute')) {
      const min = Math.max(1, msg.min ?? 1);
      const max = Math.max(min, Math.min(msg.max ?? min, (msg.cards ?? []).length));
      const indexedCards = toIndexedItems(msg.cards);
      const enumerationCap = Math.max(1, Math.trunc(Number(this.config.maxActionsPerNode) || DEFAULT_OPTIONS.maxActionsPerNode));
      const estimatedLegalCandidateCount = estimateOrderedSelectionCount(indexedCards.length, min, max, Number.MAX_SAFE_INTEGER);
      if (this.config.factorizeLargeSelections === true && estimatedLegalCandidateCount > enumerationCap) {
        for (const entry of indexedCards) {
          const card = entry.item;
          add({
            ...this.makeAction({
              label: formatCardChoiceLabel('选择祭品', cardName(card.code), card),
              kind: 'factorized_select_card_candidate',
              response: new Uint8Array(0),
              text: this.cardText.getDescription(card.code),
            }),
            selectionIndex: entry.index,
          });
        }
        Object.defineProperty(actions, 'factorizedSelection', {
          configurable: true,
          value: {
            estimatedLegalCandidateCount,
            selectionConstraints: {
              protocol: messageName,
              min,
              max,
              available: indexedCards.length,
              ordered: true,
              submitWith: 'executeAction.selectionIndexes',
            },
          },
        });
      } else {
        for (let count = min; count <= max; count += 1) {
          const selectionIterator = count === 1
            ? chooseCombinations(indexedCards, count)
            : chooseOrderedSelections(indexedCards, count);
          for (const picked of selectionIterator) {
            const pickedCards = picked.map((entry) => entry.item);
            const pickedIndices = picked.map((entry) => entry.index);
            addPrepared(
              `选择${count}个祭品`,
              'other',
              () => msg.prepareResponse(toIndexResponses(pickedIndices)),
              pickedCards.map((c) => this.cardText.getDescription(c.code)).join(' '),
            );
          }
        }
      }
      const def = msg.defaultResponse?.();
      if (def) add(this.makeAction({ label: `默认响应[${messageName}]`, kind: 'fallback', response: def, text: '' }));
    } else if (this.isMsgType(msg, 'SelectCounter')) {
      for (const option of distributeCounterCounts(msg.cards ?? [], Math.max(0, msg.counterCount ?? 0))) {
        addPrepared(
          `选择指示物分配(${option.reduce((sum, item) => sum + item.count, 0)})`,
          'other',
          () => msg.prepareResponse(option),
          option.map((item) => `${cardName(item.card.code)}:${item.count}`).join(', '),
        );
      }
    } else if (this.isMsgType(msg, 'SelectSum')) {
      const required = Array.isArray(msg.mustSelectCards) ? msg.mustSelectCards : [];
      const indexedOptional = toIndexedItems(msg.cards);
      const min = Math.max(0, (msg.min ?? 0) - required.length);
      const max = Math.max(min, Math.min((msg.max ?? indexedOptional.length) - required.length, indexedOptional.length));
      for (let count = min; count <= max; count += 1) {
        const selectionIterator = count <= 1
          ? chooseCombinations(indexedOptional, count)
          : chooseOrderedSelections(indexedOptional, count);
        for (const picked of selectionIterator) {
          const pickedCards = picked.map((entry) => entry.item);
          const pickedIndices = picked.map((entry) => entry.index);
          const full = [...required, ...pickedCards];
          addPrepared(
            `选择合计素材(${full.length})`,
            'other',
            () => msg.prepareResponse(toIndexResponses(pickedIndices)),
            full.map((c) => `${cardName(c.code)}(${c.opParam ?? 0})`).join(' '),
          );
        }
      }
    } else if (this.isMsgType(msg, 'SortCard')) {
      for (const sorted of choosePermutations(toIndexedItems(msg.cards))) {
        const sortedCards = sorted.map((entry) => entry.item);
        const sortedIndices = sorted.map((entry) => entry.index);
        addPrepared(
          `排序卡片(${sortedCards.length})`,
          'other',
          () => msg.prepareResponse(toIndexResponses(sortedIndices)),
          sortedCards.map((c) => cardName(c.code)).join(' -> '),
        );
      }
      const def = msg.defaultResponse?.();
      if (def) add(this.makeAction({ label: `默认响应[${messageName}]`, kind: 'fallback', response: def, text: '' }));
    } else if (this.isMsgType(msg, 'AnnounceNumber')) {
      for (const number of msg.numbers ?? []) {
        addPrepared(`宣告数字(${number})`, 'option', () => msg.prepareResponse(number), String(number));
      }
    } else if (this.isMsgType(msg, 'AnnounceAttrib')) {
      const count = Math.max(1, msg.count ?? 1);
      for (const value of chooseBitmaskCombinations(msg.availableAttributes >>> 0, count)) {
        addPrepared(`宣告属性(${value})`, 'option', () => msg.prepareResponse(value), String(value));
      }
    } else if (this.isMsgType(msg, 'AnnounceRace')) {
      const count = Math.max(1, msg.count ?? 1);
      for (const value of chooseBitmaskCombinations(msg.availableRaces >>> 0, count)) {
        addPrepared(`宣告种族(${value})`, 'option', () => msg.prepareResponse(value), String(value));
      }
    } else if (this.isMsgType(msg, 'RockPaperScissors')) {
      for (const choice of [1, 2, 3]) {
        addPrepared(`猜拳(${choice})`, 'option', () => msg.prepareResponse(choice), String(choice));
      }
    } else if (this.isMsgType(msg, 'SelectUnselect')) {
      const selectable = msg.selectableCards ?? [];
      const unselectable = msg.unselectableCards ?? [];
      for (let index = 0; index < selectable.length; index += 1) {
        const c = selectable[index];
        addPrepared(
          formatCardChoiceLabel('选择卡片', cardName(c.code), c),
          'other',
          () => msg.prepareResponse(makeIndexResponse(index)),
          this.cardText.getDescription(c.code),
        );
      }
      const selectedCount = unselectable.length;
      const minSelected = Math.max(0, msg.min ?? 0);
      const maxSelected = Math.max(minSelected, msg.max ?? selectedCount);
      const canFinish = !!msg.finishable && selectedCount >= minSelected && selectedCount <= maxSelected;
      const canStillSelectMore = selectable.length > 0 && selectedCount < maxSelected;
      if (!HARD_DISABLE_SELECT_UNSELECT_CANCEL) {
        for (let index = 0; index < unselectable.length; index += 1) {
          const c = unselectable[index];
          addPrepared(
            formatCardChoiceLabel('取消选择', cardName(c.code), c),
            'other',
            () => msg.prepareResponse(makeIndexResponse(selectable.length + index)),
            this.cardText.getDescription(c.code),
          );
        }
      }
      if (canFinish) {
        addPrepared(
          '确认选择',
          canStillSelectMore ? 'other' : 'option',
          () => msg.prepareResponse(null),
          '',
        );
      } else if (!HARD_DISABLE_SELECT_UNSELECT_CANCEL && msg.cancelable) {
        addPrepared(
          '取消选择流程',
          'fallback',
          () => msg.prepareResponse(null),
          '',
        );
      }
    } else {
      const def = msg.defaultResponse?.();
      this.logDecisionWarning('enumerate-unknown-message', {
        message: messageName,
        historyLength: this.actionHistory.length,
        hasDefaultResponse: !!def,
        optionKeys: Object.keys(msg ?? {}).sort(),
      });
      if (def) add(this.makeAction({ label: `默认响应[${msg.constructor.name}]`, kind: 'fallback', response: def, text: '' }));
      else add(this.makeAction({ label: `整数响应0[${msg.constructor.name}]`, kind: 'fallback', intResponse: 0, text: '' }));
    }

    this.logDecisionDebug('enumerate-actions', {
      message: messageName,
      historyLength: this.actionHistory.length,
      actionCount: actions.length,
      labels: actions.map((action) => action.label),
    });
    emitTrackedDecisionLog();
    return actions;
  }

  queryCodes(player, location) {
    const startedAt = startProfileTimer();
    try {
      const out = this.duel.queryFieldCard(
        { player, location, queryFlag: QUERY_FLAG_SNAPSHOT },
        { noParse: true },
      );
      return extractCodesFromFieldQueryRaw(out.raw, out.length);
    } finally {
      endProfileTimer('queryCodes', startedAt);
    }
  }

  queryCards(player, location) {
    const startedAt = startProfileTimer();
    try {
      const out = this.duel.queryFieldCard(
        { player, location, queryFlag: QUERY_FLAG_SNAPSHOT },
        { noParse: true },
      );
      return extractCardsFromFieldQueryRaw(out.raw, out.length, location)
        .map((card) => ({
          ...card,
          controller: player,
          name: this.cardText.getName(card.code),
        }));
    } finally {
      endProfileTimer('queryCards', startedAt);
    }
  }

  captureSnapshot() {
    const startedAt = startProfileTimer();
    try {
      const info = this.duel.queryFieldInfo({ noParse: true });
      const lp = extractLpPairFromFieldInfoRaw(info.raw, info.length);
      const snapshot = {
        lp,
        p0: {
          mzone: this.queryCodes(0, LOCATION_MZONE),
          szone: [
            ...this.queryCodes(0, LOCATION_SZONE),
            ...this.queryCodes(0, LOCATION_FZONE),
          ],
          hand: this.queryCodes(0, LOCATION_HAND),
          grave: this.queryCodes(0, LOCATION_GRAVE),
          banished: this.queryCodes(0, LOCATION_REMOVED),
          deck: this.queryCodes(0, LOCATION_DECK),
          extra: this.queryCodes(0, LOCATION_EXTRA),
        },
        p1: {
          mzone: this.queryCodes(1, LOCATION_MZONE),
          szone: [
            ...this.queryCodes(1, LOCATION_SZONE),
            ...this.queryCodes(1, LOCATION_FZONE),
          ],
          hand: this.queryCodes(1, LOCATION_HAND),
          grave: this.queryCodes(1, LOCATION_GRAVE),
          banished: this.queryCodes(1, LOCATION_REMOVED),
          deck: this.queryCodes(1, LOCATION_DECK),
          extra: this.queryCodes(1, LOCATION_EXTRA),
        },
      };
      snapshot.p0Zones = {
        mzone: this.queryCards(0, LOCATION_MZONE),
        szone: [
          ...this.queryCards(0, LOCATION_SZONE),
          ...this.queryCards(0, LOCATION_FZONE),
        ],
      };
      snapshot.p1Zones = {
        mzone: this.queryCards(1, LOCATION_MZONE),
        szone: [
          ...this.queryCards(1, LOCATION_SZONE),
          ...this.queryCards(1, LOCATION_FZONE),
        ],
      };
      snapshot.cardIdList = {
        p0Field: [...snapshot.p0.mzone, ...snapshot.p0.szone],
        p0Extra: [...snapshot.p0.extra],
        p1Field: [...snapshot.p1.mzone, ...snapshot.p1.szone],
        p0Hand: [...snapshot.p0.hand],
        p0Grave: [...snapshot.p0.grave],
      };
      return snapshot;
    } catch (err) {
      console.error(
        `[search-capture-snapshot-failed] history=${this.actionHistory.length} decision=${formatDebugDecision(this.currentDecision)}`,
      );
      throw err;
    } finally {
      endProfileTimer('captureSnapshot', startedAt);
    }
  }

  scoreSnapshotDetailed(snapshot) {
    return scoreSnapshotByRules(snapshot, this.scoringRules, this.playerDeckInstances);
  }

  scoreSnapshot(snapshot) {
    return this.scoreSnapshotDetailed(snapshot).score;
  }

  normalizeExactStateKeySnapshot(snapshot) {
    return snapshot;
  }
}

function buildNativeCardDataType() {
  if (!koffi) return null;
  return koffi.struct('combo_native_card_data', {
    code: 'uint32_t',
    alias: 'uint32_t',
    setcode: koffi.array('uint16_t', 16),
    type: 'uint32_t',
    level: 'uint32_t',
    attribute: 'uint32_t',
    race: 'uint32_t',
    attack: 'int32_t',
    defense: 'int32_t',
    lscale: 'uint32_t',
    rscale: 'uint32_t',
    link_marker: 'uint32_t',
    rule_code: 'uint32_t',
  });
}

class NativeFfiDuel {
  constructor(runtime, params) {
    this.runtime = runtime;
    this.seed = params.seed >>> 0;
    this.seedSequence = Array.isArray(params.seedSequence) ? params.seedSequence.map((value) => value >>> 0) : [];
    this.yrpVersion = params.yrpVersion === 2 ? 2 : 1;
    this.drawCount = Math.max(0, params.drawCount ?? params.playerOpening?.opening?.length ?? 1);
    this.duelOptions = Number.isFinite(params.duelOptions) ? params.duelOptions >>> 0 : CURRENT_DUEL_OPTIONS;
    this.replayMode = !!params.replayMode;
    this.playerDeck = params.playerDeck;
    this.opponentDeck = params.opponentDeck;
    this.playerOpening = params.playerOpening;
    this.opponentOpening = params.opponentOpening;
    this.receiveBuffer = Buffer.alloc(Math.max(COMMON.SIZE_MESSAGE_BUFFER ?? 0x20000, 0x40000));
    this.returnBuffer = Buffer.alloc(Math.max(COMMON.SIZE_RETURN_VALUE ?? 0x1000, 0x1000));
    this.queryBuffer = Buffer.alloc(0x40000);
    this.fieldInfoBuffer = Buffer.alloc(0x4000);
    this.duelPtr = null;
    this.open();
  }

  loadDeck(deck, opening, owner, player) {
    this.loadCardList(opening.opening, owner, player, LOCATION_HAND);
    this.loadCardList(opening.remain, owner, player, LOCATION_DECK);
    this.loadCardList(deck.extra ?? [], owner, player, LOCATION_EXTRA);
  }

  loadReplayDeck(deck, opening, owner, player) {
    this.loadCardList(buildReplayMainDeck(opening, deck?.main ?? []), owner, player, LOCATION_DECK);
    this.loadCardList(deck.extra ?? [], owner, player, LOCATION_EXTRA);
  }

  loadCardList(codes, owner, player, location) {
    if (!Array.isArray(codes) || codes.length === 0) return;
    if (typeof this.runtime.loadDeckCards === 'function') {
      const payload = Buffer.alloc(codes.length * 4);
      codes.forEach((code, index) => {
        payload.writeUInt32LE(code >>> 0, index * 4);
      });
      this.runtime.loadDeckCards(
        this.duelPtr,
        payload,
        codes.length >>> 0,
        owner,
        player,
        location,
        POS_FACEDOWN_DEFENSE,
      );
      return;
    }
    let seq = 0;
    for (const code of codes) {
      this.runtime.newCard(this.duelPtr, code >>> 0, owner, player, location, seq, POS_FACEDOWN_DEFENSE);
      if (location === LOCATION_HAND || location === LOCATION_MZONE || location === LOCATION_SZONE) {
        seq += 1;
      }
    }
  }

  buildBootstrapPayload() {
    const makeCodeBuffer = (codes) => {
      const items = Array.isArray(codes) ? codes : [];
      if (items.length === 0) return null;
      const buffer = Buffer.alloc(items.length * 4);
      items.forEach((code, index) => {
        buffer.writeUInt32LE(code >>> 0, index * 4);
      });
      return buffer;
    };
    const buildPlayer = (deck, opening) => {
      const hand = this.replayMode ? [] : opening?.opening ?? [];
      const main = this.replayMode
        ? buildReplayMainDeck(opening, deck?.main ?? [])
        : opening?.remain ?? [];
      const extra = deck?.extra ?? [];
      const handBuffer = makeCodeBuffer(hand);
      const deckBuffer = makeCodeBuffer(main);
      const extraBuffer = makeCodeBuffer(extra);
      return {
        lp: 8000,
        startcount: this.replayMode ? this.drawCount : 0,
        drawcount: 1,
        hand: handBuffer,
        hand_count: hand.length >>> 0,
        deck: deckBuffer,
        deck_count: main.length >>> 0,
        extra: extraBuffer,
        extra_count: extra.length >>> 0,
      };
    };
    const player0 = buildPlayer(this.playerDeck, this.playerOpening);
    const player1 = buildPlayer(this.opponentDeck, this.opponentOpening);
    const scriptBuffer = Buffer.from(`${NATIVE_BOOTSTRAP_PRELOAD_SCRIPTS.join('\0')}\0`, 'utf8');
    return {
      options: this.duelOptions,
      script_data: scriptBuffer,
      script_length: scriptBuffer.length >>> 0,
      players: [player0, player1],
    };
  }

  open() {
    if (this.yrpVersion === 2 && this.seedSequence.length > 0) {
      const seedBuffer = this.runtime.allocSeedSequence(this.seedSequence);
      try {
        this.duelPtr = this.runtime.createDuelV2(seedBuffer);
      } finally {
        this.runtime.releaseSeedSequence(seedBuffer);
      }
    } else {
      this.duelPtr = this.runtime.createDuel(this.seed);
    }
    if (typeof this.runtime.bootstrapDuel === 'function') {
      const bootstrap = this.buildBootstrapPayload();
      const result = this.runtime.bootstrapDuel(this.duelPtr, bootstrap);
      if (result) {
        return;
      }
    }
    const startHand = this.replayMode ? this.drawCount : 0;
    this.runtime.setPlayerInfo(this.duelPtr, 0, 8000, startHand, 1);
    this.runtime.setPlayerInfo(this.duelPtr, 1, 8000, startHand, 1);
    for (const preload of NATIVE_BOOTSTRAP_PRELOAD_SCRIPTS) {
      try {
        this.runtime.preloadScript?.(this.duelPtr, preload, Buffer.byteLength(preload, 'utf8'));
      } catch {
        // ignore
      }
    }
    if (this.replayMode) {
      this.loadReplayDeck(this.playerDeck, this.playerOpening, 0, 0);
      this.loadReplayDeck(this.opponentDeck, this.opponentOpening, 1, 1);
    } else {
      this.loadDeck(this.playerDeck, this.playerOpening, 0, 0);
      this.loadDeck(this.opponentDeck, this.opponentOpening, 1, 1);
    }
    this.runtime.startDuel(this.duelPtr, this.duelOptions);
  }

  endDuel() {
    if (!this.duelPtr) return;
    try {
      this.runtime.endDuel(this.duelPtr);
    } catch {
      // ignore
    }
    this.duelPtr = null;
  }

  setResponse(response) {
    const bytes = Buffer.from(toUint8Array(response));
    this.returnBuffer.fill(0);
    bytes.copy(this.returnBuffer, 0, 0, Math.min(bytes.length, this.returnBuffer.length));
    this.runtime.setResponseB(this.duelPtr, this.returnBuffer);
  }

  setResponseInt(value) {
    this.runtime.setResponseI(this.duelPtr, value | 0);
  }

  queryFieldCard({ player, location, queryFlag }, { noParse } = {}) {
    if (!noParse) {
      throw new Error('NativeFfiDuel 仅支持 noParse queryFieldCard');
    }
    const length = this.runtime.queryFieldCard(
      this.duelPtr,
      player | 0,
      location | 0,
      queryFlag >>> 0,
      this.queryBuffer,
      0,
    );
    const safeLength = Math.max(0, length | 0);
    return {
      raw: Uint8Array.from(this.queryBuffer.subarray(0, safeLength)),
      length: safeLength,
    };
  }

  queryFieldInfo({ noParse } = {}) {
    if (!noParse) {
      throw new Error('NativeFfiDuel 仅支持 noParse queryFieldInfo');
    }
    const length = this.runtime.queryFieldInfo(this.duelPtr, this.fieldInfoBuffer);
    const safeLength = Math.max(0, length | 0);
    return {
      raw: Uint8Array.from(this.fieldInfoBuffer.subarray(0, safeLength)),
      length: safeLength,
    };
  }
}

class NativeRandomDuelRunner extends DuelRunner {
  constructor(params) {
    super({
      wrapper: null,
      cardText: params.cardText,
      seed: params.seed,
      seedSequence: params.seedSequence,
      yrpVersion: params.yrpVersion,
      drawCount: params.drawCount,
      duelOptions: params.duelOptions,
      config: params.config,
      playerDeck: params.playerDeck,
      opponentDeck: params.opponentDeck,
      playerOpening: params.playerOpening,
      opponentOpening: params.opponentOpening,
    });
    this.nativeRuntime = params.nativeRuntime;
    this.prebuiltRootCount = Math.max(1, params.prebuiltRootCount | 0);
    this.rootDuelPool = [];
    this.retiredDuels = [];
    this.nativeSnapshotMode = 'native-replay';
  }

  init() {
    this.rootDuelPool = [];
    const warmCount = Math.max(0, this.prebuiltRootCount - 1);
    for (let i = 0; i < warmCount; i += 1) {
      this.rootDuelPool.push(this.buildFreshRootState());
    }
    const first = this.buildFreshRootState();
    this.duel = first.duel;
    this.currentDecision = first.decision;
    this.setActionHistory([], '');
  }

  detectNativeSnapshotMode() {
    return 'native-replay';
  }

  ensureNativeSnapshotMode() {
    this.nativeSnapshotMode = 'native-replay';
    return this.nativeSnapshotMode;
  }

  createDuelInstance() {
    return new NativeFfiDuel(this.nativeRuntime, {
      seed: this.seed,
      seedSequence: this.seedSequence,
      yrpVersion: this.yrpVersion,
      drawCount: this.drawCount,
      duelOptions: this.duelOptions,
      playerDeck: this.playerDeck,
      opponentDeck: this.opponentDeck,
      playerOpening: this.playerOpening,
      opponentOpening: this.opponentOpening,
    });
  }

  createReplayCompatibleDuelInstance() {
    return new NativeFfiDuel(this.nativeRuntime, {
      seed: this.seed,
      seedSequence: this.seedSequence,
      yrpVersion: this.yrpVersion,
      drawCount: this.drawCount,
      duelOptions: this.duelOptions,
      replayMode: true,
      playerDeck: this.playerDeck,
      opponentDeck: this.opponentDeck,
      playerOpening: this.playerOpening,
      opponentOpening: this.opponentOpening,
    });
  }

  buildFreshRootState() {
    const duel = this.createDuelInstance();
    const decision = this.advanceUntilDecisionForDuel(duel);
    return { duel, decision };
  }

  clearNativeSnapshotPool() {
    this.nativeSnapshotPool.clear();
    this.nativeSnapshotPoolOrder = [];
    this.nativeSnapshotPoolBytes = 0;
    this.modernRootSnapshot = null;
    this.modernSnapshotMetadata = null;
  }

  destroyDuel() {
    if (this.duel) {
      this.duel.endDuel();
    }
    for (const entry of this.rootDuelPool) {
      try {
        entry?.duel?.endDuel();
      } catch {
        // ignore
      }
    }
    for (const duel of this.retiredDuels) {
      try {
        duel?.endDuel();
      } catch {
        // ignore
      }
    }
    this.duel = null;
    this.rootDuelPool = [];
    this.retiredDuels = [];
    this.currentDecision = null;
    this.setActionHistory([], '');
    this.clearStatePool();
    this.clearNativeSnapshotPool();
  }

  saveState(reason = '') {
    const startedAt = startProfileTimer();
    const reasonLabel = String(reason || '').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80);
    try {
      const history = cloneEncodedHistory(this.actionHistory);
      return {
        history,
        historyKey: this.actionHistoryKey,
        decision: cloneDecisionState(this.currentDecision),
      };
    } finally {
      endProfileTimer('saveState', startedAt);
      if (reasonLabel) endProfileTimer(`saveState.reason.${reasonLabel}`, startedAt);
    }
  }

  restoreState(state) {
    const startedAt = startProfileTimer();
    try {
      if (Array.isArray(state?.history)) {
        const history = state.history;
        const decision =
          state._inflatedDecision !== undefined
            ? state._inflatedDecision
            : (state._inflatedDecision = inflateDecisionState(state.decision));
        this.rebuildFromHistory(history);
        if (decision) {
          this.currentDecision = decision;
        }
        return;
      }
      this.rebuildFromHistory([]);
    } finally {
      endProfileTimer('restoreState', startedAt);
    }
  }

  rebuildFromHistory(history) {
    const startedAt = startProfileTimer();
    try {
      const targetHistory = cloneEncodedHistory(history);
      const targetKey = this.makeHistoryKey(targetHistory);
      const currentKey = this.actionHistoryKey;
      if (this.duel && currentKey === targetKey) return;

      if (this.duel) {
        this.retiredDuels.push(this.duel);
        this.duel = null;
        this.currentDecision = null;
        this.setActionHistory([], '');
      }

      if (targetHistory.length === 0 && this.rootDuelPool.length > 0) {
        const takeStartedAt = startProfileTimer();
        const entry = this.rootDuelPool.pop();
        this.duel = entry?.duel ?? this.createDuelInstance();
        this.currentDecision = entry?.decision ?? this.advanceUntilDecisionForDuel(this.duel);
        endProfileTimer('nativeRootPoolTake', takeStartedAt);
      } else {
        const createStartedAt = startProfileTimer();
        this.duel = this.createDuelInstance();
        this.currentDecision = this.advanceUntilDecisionForDuel(this.duel);
        endProfileTimer('nativeCreateRootDuel', createStartedAt);
      }
      this.setActionHistory([], '');

      for (const encoded of targetHistory) {
        const action = this.decodeAction(encoded);
        if (typeof action.intResponse === 'number') {
          this.duel.setResponseInt(action.intResponse);
        } else {
          this.duel.setResponse(action.response);
        }
        this.pushEncodedHistoryAction(this.encodeAction(action));
        this.currentDecision = this.advanceUntilDecision();
        if (this.currentDecision?.terminal) break;
      }
    } finally {
      endProfileTimer('rebuildFromHistory', startedAt);
    }
  }

  advanceUntilDecision() {
    return this.advanceUntilDecisionForDuel(this.duel);
  }

  normalizeExactStateKeySnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return snapshot;
    return {
      ...snapshot,
      p0: {
        ...(snapshot.p0 ?? {}),
        szone: [],
      },
      p1: {
        ...(snapshot.p1 ?? {}),
        szone: [],
      },
    };
  }

  advanceUntilDecisionForDuel(duel) {
    const startedAt = startProfileTimer();
    try {
      if (!duel?.duelPtr) {
        return { terminal: true, reason: 'PROCESS_UNAVAILABLE', actions: [] };
      }
      let guard = 0;
      while (guard < this.config.maxProcessPerStep) {
        guard += 1;
        const processStartedAt = startProfileTimer();
        const rawResult = this.nativeRuntime.process(duel.duelPtr) >>> 0;
        endProfileTimer('duel.process', processStartedAt);
        const length = (rawResult & 0x0fffffff) >>> 0;
        const status = (rawResult >>> 28) & 0x0f;
        let raw = null;
        if (length > 0) {
          this.nativeRuntime.getMessage(duel.duelPtr, duel.receiveBuffer);
          raw = duel.receiveBuffer.subarray(0, length);
          let decisionResult = null;
          const scanResult = scanYgoProPayloadMessages(raw, (msg) => {
            const autoResponse = this.tryAutoRespondDecisionMessage(msg, 'native');
            if (autoResponse) {
              if (autoResponse.result) {
                decisionResult = autoResponse.result;
                return true;
              }
              return false;
            }
            const resolved = this.tryBuildDecisionFromMessage(msg, 'native');
            if (!resolved) return false;
            decisionResult = resolved;
            return true;
          });
          if (decisionResult) {
            return decisionResult;
          }
          if (!scanResult.ok) {
            try {
              const messages = ygopro.YGOProMessages.getInstancesFromPayload(raw);
              for (const msg of messages) {
                const autoResponse = this.tryAutoRespondDecisionMessage(msg, 'native');
                if (autoResponse) {
                  if (autoResponse.result) {
                    return autoResponse.result;
                  }
                  continue;
                }
                const resolved = this.tryBuildDecisionFromMessage(msg, 'native');
                if (resolved) {
                  return resolved;
                }
              }
            } catch {
              // ignore parse failure
            }
          }
        }

        if (status === 2) {
          this.logDecisionDebug('decision-terminal', {
            reason: 'STATUS_END',
            historyLength: this.actionHistory.length,
            backend: 'native',
          });
          return { terminal: true, reason: 'STATUS_END', actions: [] };
        }
        if (raw && raw.length > 0 && raw[0] === COMMON.MSG_RETRY) {
          this.logDecisionWarning('decision-terminal', {
            reason: 'MSG_RETRY_RAW',
            historyLength: this.actionHistory.length,
            backend: 'native',
          });
          return { terminal: true, reason: 'MSG_RETRY_RAW', actions: [] };
        }
      }
      this.logDecisionWarning('decision-terminal', {
        reason: 'PROCESS_GUARD',
        historyLength: this.actionHistory.length,
        backend: 'native',
        maxProcessPerStep: this.config.maxProcessPerStep,
      });
      return { terminal: true, reason: 'PROCESS_GUARD', actions: [] };
    } finally {
      endProfileTimer('advanceUntilDecision', startedAt);
    }
  }
}

async function createNativeRandomRuntime(cardsPath, scriptsRoot, options = {}) {
  if (!koffi || !ygoproCdb?.CardDataEntry) {
    throw new Error('native 随机搜索需要 koffi 和 ygopro-cdb-encode');
  }
  const ocgcoreDllPath = path.resolve(String(options.ocgcoreDllPath || NATIVE_OCGCORE_DLL_PATH));
  if (!fs.existsSync(ocgcoreDllPath)) {
    throw new Error(`native ocgcore.dll 不存在: ${ocgcoreDllPath}`);
  }

  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(cardsPath));
  const cardText = new CardTextResolver(db);
  const cardReader = SqljsCardReader(db);
  const cardPayloadCache = new Map();
  const originalCwd = process.cwd();
  process.chdir(scriptsRoot);

  const DuelHandle = koffi.pointer('combo_native_duel_handle', koffi.opaque());
  const CardData = buildNativeCardDataType();
  const BootstrapPlayer = koffi.struct('combo_native_bootstrap_player', {
    lp: 'int32_t',
    startcount: 'int32_t',
    drawcount: 'int32_t',
    hand: 'void *',
    hand_count: 'uint32_t',
    deck: 'void *',
    deck_count: 'uint32_t',
    extra: 'void *',
    extra_count: 'uint32_t',
  });
  const BootstrapDuel = koffi.struct('combo_native_bootstrap_duel', {
    options: 'uint32_t',
    script_data: 'void *',
    script_length: 'uint32_t',
    players: koffi.array(BootstrapPlayer, 2),
  });
  koffi.proto('combo_native_card_reader', 'uint32_t', ['uint32_t', koffi.pointer(CardData)]);
  koffi.proto('combo_native_message_handler', 'uint32_t', [DuelHandle, 'uint32_t']);

  const lib = koffi.load(ocgcoreDllPath);
  const optionalFunc = (name, returnType, args) => {
    try {
      return lib.func(name, returnType, args);
    } catch {
      return null;
    }
  };
  const runtime = {
    kind: 'native-random',
    db,
    cardText,
    lib,
    ocgcoreDllPath,
    originalCwd,
    scriptsRoot,
    createDuel: lib.func('create_duel', DuelHandle, ['uint32_t']),
    createDuelV2: lib.func('create_duel_v2', DuelHandle, ['void *']),
    bootstrapDuel: optionalFunc('bootstrap_duel', 'int32_t', [DuelHandle, koffi.pointer(BootstrapDuel)]),
    startDuel: lib.func('start_duel', 'void', [DuelHandle, 'uint32_t']),
    endDuel: lib.func('end_duel', 'void', [DuelHandle]),
    setPlayerInfo: lib.func('set_player_info', 'void', [DuelHandle, 'int32_t', 'int32_t', 'int32_t', 'int32_t']),
    getMessage: lib.func('get_message', 'int32_t', [DuelHandle, 'void *']),
    process: lib.func('process', 'uint32_t', [DuelHandle]),
    preloadScript: optionalFunc('preload_script', 'int32_t', [DuelHandle, 'str', 'int32_t']),
    loadDeckCards: optionalFunc('load_deck_cards', 'void', [DuelHandle, 'void *', 'uint32_t', 'uint8_t', 'uint8_t', 'uint8_t', 'uint8_t']),
    newCard: lib.func('new_card', 'void', [DuelHandle, 'uint32_t', 'uint8_t', 'uint8_t', 'uint8_t', 'uint8_t', 'uint8_t']),
    setResponseI: lib.func('set_responsei', 'void', [DuelHandle, 'int32_t']),
    setResponseB: lib.func('set_responseb', 'void', [DuelHandle, 'void *']),
    queryFieldCard: lib.func('query_field_card', 'int32_t', [DuelHandle, 'uint8_t', 'uint8_t', 'uint32_t', 'void *', 'int32_t']),
    queryFieldInfo: lib.func('query_field_info', 'int32_t', [DuelHandle, 'void *']),
  };

  runtime.defaultScriptReader = lib.symbol('default_script_reader', 'void *');
  runtime.setScriptReader = lib.func('void set_script_reader(void *reader)');
  runtime.setCardReader = lib.func('void set_card_reader(combo_native_card_reader *reader)');
  runtime.setMessageHandler = lib.func('void set_message_handler(combo_native_message_handler *handler)');

  runtime.seedSequenceBuffers = new Set();
  runtime.allocSeedSequence = (seedSequence) => {
    const values = Array.isArray(seedSequence) ? seedSequence : [];
    const buffer = Buffer.alloc(Math.max(1, values.length) * 4);
    values.forEach((value, index) => {
      buffer.writeUInt32LE(value >>> 0, index * 4);
    });
    runtime.seedSequenceBuffers.add(buffer);
    return buffer;
  };
  runtime.releaseSeedSequence = (buffer) => {
    runtime.seedSequenceBuffers.delete(buffer);
  };

  runtime.cardCallback = koffi.register((code, dataPtr) => {
    const cacheKey = code >>> 0;
    let payload = cardPayloadCache.get(cacheKey) ?? null;
    if (!payload) {
      const entry = cardReader(cacheKey);
      if (!entry) return 0;
      payload = Buffer.from(
        entry instanceof ygoproCdb.CardDataEntry
          ? entry.toPayload()
          : new ygoproCdb.CardDataEntry().fromPartial(entry).toPayload(),
      );
      cardPayloadCache.set(cacheKey, payload);
    }
    const target = Buffer.from(koffi.view(dataPtr, payload.length));
    payload.copy(target, 0, 0, payload.length);
    return 0;
  }, 'combo_native_card_reader *');
  runtime.messageCallback = koffi.register(() => 0, 'combo_native_message_handler *');
  runtime.setScriptReader(runtime.defaultScriptReader);
  runtime.setCardReader(runtime.cardCallback);
  runtime.setMessageHandler(runtime.messageCallback);
  return runtime;
}

let exactSearchApi = null;

function getExactSearchApi() {
  if (exactSearchApi) return exactSearchApi;
  exactSearchApi = createExactSearchApi({
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
    startProfileTimer,
    endProfileTimer,
  });
  return exactSearchApi;
}

function makeExactStateKey(state, snapshot, decision) {
  const sortCodes = (codes) =>
    [...(codes ?? [])]
      .map((x) => x >>> 0)
      .sort((a, b) => a - b)
      .join(',');

  const decisionSig = decision?.actions?.length
    ? stableStringify(decision.actions.map((action) => serializeDecisionAction(action)))
    : decision?.message?.constructor?.name ?? decision?.reason ?? 'terminal';

  return [
    snapshot?.lp?.p0 ?? 0,
    snapshot?.lp?.p1 ?? 0,
    sortCodes(snapshot?.p0?.mzone),
    sortCodes(snapshot?.p0?.szone),
    sortCodes(snapshot?.p0?.hand),
    sortCodes(snapshot?.p0?.grave),
    sortCodes(snapshot?.p0?.banished),
    sortCodes(snapshot?.p1?.mzone),
    sortCodes(snapshot?.p1?.szone),
    sortCodes(snapshot?.p1?.hand),
    sortCodes(snapshot?.p1?.grave),
    sortCodes(snapshot?.p1?.banished),
    decisionSig,
  ].join('|');
}

function makeExactStateKeyNoLp(state, snapshot, decision) {
  const sortCodes = (codes) =>
    [...(codes ?? [])]
      .map((x) => x >>> 0)
      .sort((a, b) => a - b)
      .join(',');

  const decisionSig = decision?.actions?.length
    ? stableStringify(decision.actions.map((action) => serializeDecisionAction(action)))
    : decision?.message?.constructor?.name ?? decision?.reason ?? 'terminal';

  return [
    sortCodes(snapshot?.p0?.mzone),
    sortCodes(snapshot?.p0?.szone),
    sortCodes(snapshot?.p0?.hand),
    sortCodes(snapshot?.p0?.grave),
    sortCodes(snapshot?.p0?.banished),
    sortCodes(snapshot?.p1?.mzone),
    sortCodes(snapshot?.p1?.szone),
    sortCodes(snapshot?.p1?.hand),
    sortCodes(snapshot?.p1?.grave),
    sortCodes(snapshot?.p1?.banished),
    decisionSig,
  ].join('|');
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
    scoreTrace: Array.isArray(candidate.scoreTrace)
      ? JSON.parse(JSON.stringify(candidate.scoreTrace))
      : [],
    scoreBreakdown: Array.isArray(candidate.scoreBreakdown)
      ? JSON.parse(JSON.stringify(candidate.scoreBreakdown))
      : [],
    routeFoundAtMs: candidate.routeFoundAtMs ?? null,
    routeFoundAtIso: candidate.routeFoundAtIso ?? null,
    routeFoundElapsedMs: candidate.routeFoundElapsedMs ?? null,
    routeFoundNodes: candidate.routeFoundNodes ?? null,
    routeFoundTerminals: candidate.routeFoundTerminals ?? null,
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
    scoreTrace: Array.isArray(candidate.scoreTrace)
      ? JSON.parse(JSON.stringify(candidate.scoreTrace))
      : [],
    scoreBreakdown: Array.isArray(candidate.scoreBreakdown)
      ? JSON.parse(JSON.stringify(candidate.scoreBreakdown))
      : [],
    routeFoundAtMs: candidate.routeFoundAtMs ?? null,
    routeFoundAtIso: candidate.routeFoundAtIso ?? null,
    routeFoundElapsedMs: candidate.routeFoundElapsedMs ?? null,
    routeFoundNodes: candidate.routeFoundNodes ?? null,
    routeFoundTerminals: candidate.routeFoundTerminals ?? null,
    snapshot: candidate.snapshot ?? null,
    state: candidate.state ? deserializeHistoryState(candidate.state) : null,
  };
}

function serializeSearchCoreResult(result) {
  if (!result || typeof result !== 'object') {
    return { nodes: 0, terminalCount: 0, topPaths: [] };
  }
  return {
    nodes: result.nodes ?? 0,
    terminalCount: result.terminalCount ?? 0,
    topPaths: Array.isArray(result.topPaths)
      ? result.topPaths.map(serializeTopPathCandidate).filter(Boolean)
      : [],
  };
}

function deserializeSearchCoreResult(result) {
  if (!result || typeof result !== 'object') {
    return { nodes: 0, terminalCount: 0, topPaths: [] };
  }
  return {
    nodes: result.nodes ?? 0,
    terminalCount: result.terminalCount ?? 0,
    topPaths: Array.isArray(result.topPaths)
      ? result.topPaths.map(deserializeTopPathCandidate).filter(Boolean)
      : [],
  };
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

// v3: frame stack 的 baseState.history 采用 delta 编码,避免父子帧重复存历史。
// 旧 v2 存档反序列化时返回 null。
const EXACT_SEARCH_RESUME_VERSION = 3;

function historyItemsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  try {
    return JSON.stringify(serializeDecisionAction(a) ?? a) === JSON.stringify(serializeDecisionAction(b) ?? b);
  } catch (_) {
    return false;
  }
}

function serializeBaseStateWithDelta(frameBaseState, prevHistory) {
  const base = serializeHistoryState(frameBaseState);
  if (!Array.isArray(base.history) || !Array.isArray(prevHistory) || prevHistory.length === 0) return base;
  if (base.history.length < prevHistory.length) return base;
  for (let i = 0; i < prevHistory.length; i += 1) {
    if (!historyItemsEqual(prevHistory[i], base.history[i])) return base;
  }
  const tail = base.history.slice(prevHistory.length);
  const out = {
    ...base,
    historyBase: { parentLen: prevHistory.length, tail },
  };
  out.history = [];
  return out;
}

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

function restoreExactSearchFrameState(runner, frame) {
  runner.restoreState(deserializeHistoryState(frame.baseState));
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
    stateKey: frame.stateKey ?? '',
    ancestorStateKeys: cloneExactStateKeyPath(frame.ancestorStateKeys),
    nodeHardLimit: frame.nodeHardLimit ?? null,
    shouldBalanceCardChoices: !!frame.shouldBalanceCardChoices,
    perChoiceBudget: frame.perChoiceBudget ?? 0,
    actions: Array.isArray(frame.actions)
      ? frame.actions.map(serializeSearchAction).filter(Boolean)
      : [],
    baseState: baseStateSerialized,
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
    stateKey: typeof frame.stateKey === 'string' ? frame.stateKey : '',
    ancestorStateKeys: cloneExactStateKeyPath(frame.ancestorStateKeys),
    nodeHardLimit: Number.isFinite(frame.nodeHardLimit) ? Number(frame.nodeHardLimit) : null,
    shouldBalanceCardChoices: !!frame.shouldBalanceCardChoices,
    perChoiceBudget: Number.isFinite(frame.perChoiceBudget) ? Number(frame.perChoiceBudget) : 0,
    actions: Array.isArray(frame.actions)
      ? frame.actions.map(deserializeSearchAction).filter(Boolean)
      : [],
    baseState,
  };
}

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
    best: {
      nodes: payload.best?.nodes ?? 0,
      terminalCount: payload.best?.terminalCount ?? 0,
      topPaths: Array.isArray(payload.best?.topPaths)
        ? payload.best.topPaths.map(serializeTopPathCandidate).filter(Boolean)
        : [],
    },
    chain: Array.isArray(payload.chain) ? payload.chain.slice() : [],
    stack: serializeExactSearchStack(payload.stack),
  };
}

function deserializeExactSearchResumeState(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if ((payload.resumeVersion ?? 0) !== EXACT_SEARCH_RESUME_VERSION) return null;
  return {
    rootState: payload.rootState ? deserializeHistoryState(payload.rootState) : null,
    best: {
      nodes: payload.best?.nodes ?? 0,
      terminalCount: payload.best?.terminalCount ?? 0,
      topPaths: Array.isArray(payload.best?.topPaths)
        ? payload.best.topPaths.map(deserializeTopPathCandidate).filter(Boolean)
        : [],
    },
    chain: Array.isArray(payload.chain) ? payload.chain.slice() : [],
    stack: deserializeExactSearchStack(payload.stack),
  };
}

function parseDebugWatchCodes(rawValue) {
  const values = Array.isArray(rawValue)
    ? rawValue
    : String(rawValue ?? '')
        .split(/[,\s]+/)
        .filter(Boolean);
  return [...new Set(values
    .map((item) => Number.parseInt(String(item), 10))
    .filter((item) => Number.isFinite(item))
    .map((item) => item >>> 0))];
}

function buildTrackedCodeZoneSummary(snapshot, trackedCodes) {
  if (!snapshot || !Array.isArray(trackedCodes) || trackedCodes.length === 0) return {};
  const zones = [
    ['p0.hand', snapshot?.p0?.hand],
    ['p0.mzone', snapshot?.p0?.mzone],
    ['p0.szone', snapshot?.p0?.szone],
    ['p0.grave', snapshot?.p0?.grave],
    ['p0.banished', snapshot?.p0?.banished],
    ['p1.hand', snapshot?.p1?.hand],
    ['p1.mzone', snapshot?.p1?.mzone],
    ['p1.szone', snapshot?.p1?.szone],
    ['p1.grave', snapshot?.p1?.grave],
    ['p1.banished', snapshot?.p1?.banished],
  ];
  const out = {};
  for (const rawCode of trackedCodes) {
    const code = rawCode >>> 0;
    const hits = {};
    for (const [zoneName, zoneCards] of zones) {
      if (!Array.isArray(zoneCards) || zoneCards.length === 0) continue;
      let count = 0;
      for (const value of zoneCards) {
        if ((value >>> 0) === code) count += 1;
      }
      if (count > 0) hits[zoneName] = count;
    }
    if (Object.keys(hits).length > 0) out[String(code)] = hits;
  }
  return out;
}

function summarizeChainTail(chain, limit = 6) {
  return Array.isArray(chain) ? chain.slice(-Math.max(1, limit | 0)) : [];
}

function summarizeActionLabels(actions, limit = 8) {
  return Array.isArray(actions)
    ? actions.slice(0, Math.max(1, limit | 0)).map((action) => ({
        kind: action?.kind ?? '',
        label: action?.label ?? '',
      }))
    : [];
}

function incrementCountMap(map, key, delta = 1) {
  if (!map || typeof map !== 'object') return;
  const normalizedKey = String(key ?? 'unknown');
  map[normalizedKey] = (map[normalizedKey] ?? 0) + delta;
}

function pushLimitedSample(list, sample, limit = 12) {
  if (!Array.isArray(list) || list.length >= Math.max(1, limit | 0)) return false;
  list.push(sample);
  return true;
}

function appendSearchDebugJsonl(filePath, event, payload) {
  if (!filePath) return;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(
      filePath,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        event,
        ...payload,
      })}\n`,
    );
  } catch {
    // ignore debug trace write errors
  }
}

function createSearchDebugCollector(opts = {}) {
  const envTracePath = typeof process.env.COMBO_DEBUG_SEARCH_TRACE_PATH === 'string'
    ? process.env.COMBO_DEBUG_SEARCH_TRACE_PATH
    : '';
  const filePath = typeof opts.filePath === 'string' && opts.filePath
    ? path.resolve(opts.filePath)
    : envTracePath
      ? path.resolve(envTracePath)
      : '';
  const trackedCodes = parseDebugWatchCodes(
    Array.isArray(opts.watchCodes) && opts.watchCodes.length > 0
      ? opts.watchCodes
      : process.env.COMBO_DEBUG_SEARCH_TRACE_CODES,
  );
  const sampleLimitRaw = Number.parseInt(
    String(opts.sampleLimit ?? process.env.COMBO_DEBUG_SEARCH_SAMPLE_LIMIT ?? 12),
    10,
  );
  const sampleLimit = Number.isFinite(sampleLimitRaw) && sampleLimitRaw > 0
    ? Math.min(sampleLimitRaw, 40)
    : 12;
  const enabled = !!(opts.enabled || process.env.COMBO_DEBUG_SEARCH === '1' || filePath);
  // 性能关键：未显式开启 debug 且无 trackedCodes 时，直接返回 null。
  // exact-search 热循环里对 debugCollector?.noteBranch / recordSample 的判空会短路，
  // 从而省掉每次无效 payload 构造与 runner.captureSnapshot()。
  if (!enabled && (!Array.isArray(trackedCodes) || trackedCodes.length === 0)) {
    return null;
  }
  const summary = {
    label: typeof opts.label === 'string' ? opts.label : '',
    mode: typeof opts.mode === 'string' ? opts.mode : '',
    trackedCodes,
    guards: opts.guards && typeof opts.guards === 'object' ? { ...opts.guards } : {},
    searchLimits: {
      maxNodes: opts.maxNodes ?? null,
      maxDepth: opts.maxDepth ?? null,
    },
    opening: opts.opening && typeof opts.opening === 'object' ? { ...opts.opening } : {},
    counters: {
      multiActionFrames: 0,
      maxBranchingFactor: 0,
      budgetFrames: 0,
      budgetCutoffs: 0,
      prunedChildren: 0,
      terminals: 0,
      pruneReasons: {},
      terminalReasons: {},
      choiceBudgetByDepth: {},
    },
    samples: {
      branches: [],
      budget: [],
      budgetCutoff: [],
      prunes: [],
      terminals: [],
    },
  };

  const captureTracked = (snapshot) => buildTrackedCodeZoneSummary(snapshot, trackedCodes);
  const maybeWriteSample = (bucket, event, sample) => {
    if (!summary.samples[bucket]) {
      summary.samples[bucket] = [];
    }
    const appended = pushLimitedSample(summary.samples[bucket], sample, sampleLimit);
    if (enabled && appended) {
      appendSearchDebugJsonl(filePath, event, sample);
    }
  };

  return {
    trackedCodes,
    summary,
    setOpening(payload) {
      if (!payload || typeof payload !== 'object') return;
      summary.opening = {
        ...summary.opening,
        ...payload,
      };
      if (enabled) appendSearchDebugJsonl(filePath, 'opening', summary.opening);
    },
    noteBranch(payload) {
      const actionCount = Math.max(0, payload?.actionCount ?? 0);
      if (actionCount <= 1) return;
      summary.counters.multiActionFrames += 1;
      summary.counters.maxBranchingFactor = Math.max(summary.counters.maxBranchingFactor, actionCount);
      maybeWriteSample('branches', 'branch-frame', {
        depth: payload?.depth ?? 0,
        actionCount,
        shouldBalanceCardChoices: !!payload?.shouldBalanceCardChoices,
        decisionName: payload?.decisionName ?? '',
        chainTail: summarizeChainTail(payload?.chain),
        actions: summarizeActionLabels(payload?.actions),
        tracked: captureTracked(payload?.snapshot),
      });
    },
    noteBudget(payload) {
      summary.counters.budgetFrames += 1;
      incrementCountMap(summary.counters.choiceBudgetByDepth, payload?.depth ?? 0);
      maybeWriteSample('budget', 'choice-budget', {
        depth: payload?.depth ?? 0,
        budgetRemaining: payload?.budgetRemaining ?? 0,
        perChoiceBudget: payload?.perChoiceBudget ?? 0,
        nodeHardLimit: payload?.nodeHardLimit ?? 0,
        actionCount: payload?.actionCount ?? 0,
        chainTail: summarizeChainTail(payload?.chain),
        actions: summarizeActionLabels(payload?.actions),
        tracked: captureTracked(payload?.snapshot),
      });
    },
    noteBudgetCutoff(payload) {
      summary.counters.budgetCutoffs += 1;
      maybeWriteSample('budgetCutoff', 'budget-cutoff', {
        depth: payload?.depth ?? 0,
        nodes: payload?.nodes ?? 0,
        nodeHardLimit: payload?.nodeHardLimit ?? 0,
        chainTail: summarizeChainTail(payload?.chain),
        tracked: captureTracked(payload?.snapshot),
      });
    },
    notePrune(payload) {
      const reasons = Array.isArray(payload?.reasons) && payload.reasons.length > 0
        ? payload.reasons.map((item) => String(item))
        : ['unknown'];
      summary.counters.prunedChildren += 1;
      reasons.forEach((reason) => incrementCountMap(summary.counters.pruneReasons, reason));
      maybeWriteSample('prunes', 'prune', {
        depth: payload?.depth ?? 0,
        reasons,
        actionKind: payload?.action?.kind ?? '',
        actionLabel: payload?.action?.label ?? '',
        sameKeyStreak: payload?.sameKeyStreak ?? 0,
        exactStateVisits: payload?.exactStateVisits ?? 0,
        noLpStateVisits: payload?.noLpStateVisits ?? 0,
        chainTail: summarizeChainTail(payload?.chain),
        trackedBefore: captureTracked(payload?.parentSnapshot),
        trackedAfter: captureTracked(payload?.childSnapshot),
      });
    },
    noteTerminal(payload) {
      const reason = String(payload?.reason ?? 'UNKNOWN');
      summary.counters.terminals += 1;
      incrementCountMap(summary.counters.terminalReasons, reason);
      maybeWriteSample('terminals', 'terminal', {
        reason,
        depth: payload?.depth ?? 0,
        chainTail: summarizeChainTail(payload?.chain),
        tracked: captureTracked(payload?.snapshot),
      });
    },
    incrementCounter(name, delta = 1) {
      incrementCountMap(summary.counters, name, delta);
    },
    setCounterMax(name, value) {
      if (!Number.isFinite(value)) return;
      const normalizedName = String(name ?? '');
      if (!normalizedName) return;
      summary.counters[normalizedName] = Math.max(summary.counters[normalizedName] ?? 0, value);
    },
    recordSample(bucket, event, payload) {
      maybeWriteSample(bucket, event, {
        ...payload,
      });
    },
    finalize(payload) {
      const finalSummary = {
        ...summary,
        final: payload && typeof payload === 'object' ? { ...payload } : {},
      };
      if (enabled) appendSearchDebugJsonl(filePath, 'summary', finalSummary);
      return finalSummary;
    },
  };
}

function searchTopLongestPathsExactSingleStableCompat(runner, opts) {
  const best = {
    nodes: 0,
    terminalCount: 0,
    topPaths: [],
  };
  const topK = Math.max(1, opts.topK ?? DEFAULT_OPTIONS.topK);
  const progressEvery = Math.max(1, opts.progressEvery ?? 200);
  const progressMinIntervalMs = Math.max(100, opts.progressMinIntervalMs ?? 500);
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const targetTerminals = Math.max(0, opts.targetTerminals ?? 0);
  const balanceCardChoiceMaxDepth = Math.max(0, opts.balanceCardChoiceMaxDepth ?? 8);
  const maxSameNoLpStateVisits = Math.max(1, opts.maxSameNoLpStateVisits ?? 2);
  const disableNoLpStateLimit = process.env.COMBO_DISABLE_NO_LP_STATE_LIMIT === '1';
  const disableChoiceBudget = process.env.COMBO_DISABLE_CARD_CHOICE_BUDGET === '1';
  const depthLimited = Number.isFinite(opts.maxDepth) && opts.maxDepth > 0;
  const rootState = runner.saveState();
  const pathStateCounts = new Map();
  const pathStateCountsNoLp = new Map();
  const chain = [];
  let lastReportedNodes = -1;
  let lastReportedAtNs = 0n;
  const debugCollector = createSearchDebugCollector({
    ...(opts.debugTrace ?? {}),
    mode: 'stable-compat',
    maxNodes: opts.maxNodes,
    maxDepth: opts.maxDepth,
    guards: {
      balanceCardChoiceMaxDepth,
      maxSameNoLpStateVisits,
      disableNoLpStateLimit,
      disableChoiceBudget,
    },
  });
  if (opts.debugTrace?.opening) {
    debugCollector.setOpening(opts.debugTrace.opening);
  }

  const settleTerminal = (chainValue, snapshotOverride = null, reasonHint = '', stateOverride = null) => {
    const rawSnapshot = snapshotOverride ?? runner.captureSnapshot();
    const scored = runner.scoreSnapshotDetailed(rawSnapshot);
    const candidate = {
      chain: chainValue.slice(),
      depth: chainValue.length,
      score: scored.score,
      reason: reasonHint,
      snapshot: scored.snapshot,
      state: null,
    };
    best.terminalCount += 1;
    const worst = best.topPaths[topK - 1] ?? null;
    const shouldKeepState =
      best.topPaths.length < topK ||
      isTopPathCandidateBetter(candidate, worst);
    if (shouldKeepState) {
      const resolvedState =
        typeof stateOverride === 'function'
          ? stateOverride()
          : stateOverride;
      candidate.state = resolvedState ? cloneHistoryState(resolvedState) : null;
    }
    best.topPaths.push(candidate);
    best.topPaths.sort(compareTopPathCandidates);
    if (best.topPaths.length > topK) best.topPaths.length = topK;
    debugCollector.noteTerminal({
      reason: reasonHint,
      depth: chainValue.length,
      chain: chainValue,
      snapshot: rawSnapshot,
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
      best.nodes >= opts.maxNodes ||
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
      done: false,
    });
  };

  const exploreLive = (depth, sameKeyStreak = 0, nodeHardLimit = opts.maxNodes) => {
    if (targetTerminals > 0 && best.terminalCount >= targetTerminals) return;
    if (best.nodes >= opts.maxNodes) return;
    if (best.nodes >= nodeHardLimit) {
      debugCollector.noteBudgetCutoff({
        depth,
        nodes: best.nodes,
        nodeHardLimit,
        chain,
        snapshot: runner.captureSnapshot(),
      });
      return;
    }

    const snapshot = runner.captureSnapshot();
    const stateKeySnapshot = typeof runner.normalizeExactStateKeySnapshot === 'function'
      ? runner.normalizeExactStateKeySnapshot(snapshot)
      : snapshot;
    const current = runner.currentDecision;
    const stateKey = makeExactStateKey(null, stateKeySnapshot, current);
    const stateKeyNoLp = makeExactStateKeyNoLp(null, stateKeySnapshot, current);

    if (!current || current.terminal || !current.actions?.length) {
      settleTerminal(chain, snapshot, current?.reason ?? 'NO_ACTION_OR_NULL', () => runner.saveResultState());
      return;
    }
    if (depthLimited && depth >= opts.maxDepth) {
      settleTerminal(chain, snapshot, 'MAX_DEPTH', () => runner.saveResultState());
      return;
    }

    pathStateCounts.set(stateKey, (pathStateCounts.get(stateKey) ?? 0) + 1);
    pathStateCountsNoLp.set(stateKeyNoLp, (pathStateCountsNoLp.get(stateKeyNoLp) ?? 0) + 1);
    let exploredChild = false;

    const nonEndActions = current.actions.filter((action) => action.kind !== 'phase_end');
    const iterActions = sortActionsForLongestPath(
      nonEndActions.length > 0 ? nonEndActions : current.actions,
    );
    const shouldBalanceCardChoices =
      !disableChoiceBudget &&
      depth <= balanceCardChoiceMaxDepth &&
      iterActions.length > 1 &&
      iterActions.every((action) =>
        typeof action?.label === 'string' && action.label.startsWith('选择卡片[')
      );
    debugCollector.noteBranch({
      depth,
      actionCount: iterActions.length,
      shouldBalanceCardChoices,
      decisionName: current?.message?.constructor?.name ?? '',
      chain,
      actions: iterActions,
      snapshot,
    });
    const currentState = iterActions.length > 1 ? runner.saveState() : null;

    const runAction = (action, childLimit = nodeHardLimit) => {
      if (targetTerminals > 0 && best.terminalCount >= targetTerminals) return;
      if (best.nodes >= opts.maxNodes || best.nodes >= childLimit) return;

      runner.step(action);
      best.nodes += 1;
      chain.push(action.label);

      const childSnapshot = runner.captureSnapshot();
      const childDecision = runner.currentDecision;
      const childDepth = depth + 1;
      maybeReportProgress(childDepth);

      if (action.kind === 'phase_end') {
        exploredChild = true;
        settleTerminal(chain, childSnapshot, 'TURN_END', () => runner.saveResultState());
        if (currentState) runner.restoreState(currentState);
        chain.pop();
        maybeReportProgress(childDepth);
        return;
      }

      const childStateKeySnapshot = typeof runner.normalizeExactStateKeySnapshot === 'function'
        ? runner.normalizeExactStateKeySnapshot(childSnapshot)
        : childSnapshot;
      const childStateKey = makeExactStateKey(null, childStateKeySnapshot, childDecision);
      const childStateKeyNoLp = makeExactStateKeyNoLp(null, childStateKeySnapshot, childDecision);
      const childSameKeyStreak = childStateKey === stateKey ? sameKeyStreak + 1 : 0;
      const childPathCount = pathStateCounts.get(childStateKey) ?? 0;
      const childPathCountNoLp = pathStateCountsNoLp.get(childStateKeyNoLp) ?? 0;
      const pruneReasons = [];
      if (childStateKey === stateKey && (action.kind === 'fallback' || action.label === '确认选择')) {
        pruneReasons.push('same_state_fallback_or_confirm');
      }
      if (childSameKeyStreak > 2) {
        pruneReasons.push('same_state_streak>2');
      }
      if (childPathCount >= 3) {
        pruneReasons.push('exact_state_repeat>=3');
      }
      if (!disableNoLpStateLimit && childPathCountNoLp >= maxSameNoLpStateVisits) {
        pruneReasons.push(`no_lp_state_repeat>=${maxSameNoLpStateVisits}`);
      }
      const skipBecauseLoop = pruneReasons.length > 0;

      if (!skipBecauseLoop) {
        exploredChild = true;
        exploreLive(childDepth, childSameKeyStreak, childLimit);
      } else {
        debugCollector.notePrune({
          depth: childDepth,
          reasons: pruneReasons,
          action,
          chain,
          sameKeyStreak: childSameKeyStreak,
          exactStateVisits: childPathCount,
          noLpStateVisits: childPathCountNoLp,
          parentSnapshot: snapshot,
          childSnapshot,
        });
      }

      if (currentState) runner.restoreState(currentState);
      chain.pop();
      maybeReportProgress(childDepth);
    };

    if (shouldBalanceCardChoices) {
      const budgetRemaining = Math.max(1, Math.min(nodeHardLimit, opts.maxNodes) - best.nodes);
      const perChoiceBudget = Math.max(1, Math.floor(budgetRemaining / iterActions.length));
      debugCollector.noteBudget({
        depth,
        budgetRemaining,
        perChoiceBudget,
        nodeHardLimit,
        actionCount: iterActions.length,
        chain,
        actions: iterActions,
        snapshot,
      });
      for (const action of iterActions) {
        if (targetTerminals > 0 && best.terminalCount >= targetTerminals) break;
        if (best.nodes >= opts.maxNodes || best.nodes >= nodeHardLimit) break;
        const childLimit = Math.min(nodeHardLimit, best.nodes + perChoiceBudget);
        runAction(action, childLimit);
      }
    } else {
      for (const action of iterActions) {
        if (targetTerminals > 0 && best.terminalCount >= targetTerminals) break;
        if (best.nodes >= opts.maxNodes || best.nodes >= nodeHardLimit) break;
        runAction(action, nodeHardLimit);
      }
    }

    const nextCount = (pathStateCounts.get(stateKey) ?? 1) - 1;
    if (nextCount > 0) pathStateCounts.set(stateKey, nextCount);
    else pathStateCounts.delete(stateKey);
    const nextNoLpCount = (pathStateCountsNoLp.get(stateKeyNoLp) ?? 1) - 1;
    if (nextNoLpCount > 0) pathStateCountsNoLp.set(stateKeyNoLp, nextNoLpCount);
    else pathStateCountsNoLp.delete(stateKeyNoLp);

    if (!exploredChild) {
      settleTerminal(
        chain,
        snapshot,
        best.nodes >= opts.maxNodes ? 'MAX_NODES' : 'ALL_CHILDREN_PRUNED',
        () => runner.saveResultState(),
      );
    }
  };

  runner.restoreState(rootState);
  maybeReportProgress(0, true);
  exploreLive(0);
  runner.restoreState(rootState);
  if (best.topPaths.length === 0) {
    settleTerminal([], null, best.nodes >= opts.maxNodes ? 'MAX_NODES' : 'NO_RESULT', rootState);
  }
  if (onProgress) {
    onProgress({
      nodes: best.nodes,
      maxNodes: opts.maxNodes,
      terminalCount: best.terminalCount,
      currentDepth: 0,
      done: true,
    });
  }
  best.debugSummary = debugCollector.finalize({
    nodes: best.nodes,
    terminalCount: best.terminalCount,
    topDepth: best.topPaths[0]?.depth ?? 0,
    topScore: best.topPaths[0]?.score ?? 0,
  });
  return best;
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
      }
    : {
        nodes: 0,
        terminalCount: 0,
        topPaths: [],
      };
  const topK = Math.max(1, opts.topK ?? DEFAULT_OPTIONS.topK);
  const progressEvery = Math.max(1, opts.progressEvery ?? 200);
  const progressMinIntervalMs = Math.max(100, opts.progressMinIntervalMs ?? 500);
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const onCheckpoint = typeof opts.onCheckpoint === 'function' ? opts.onCheckpoint : null;
  const checkpointEvery = Math.max(1, opts.checkpointEvery ?? WEB_ARCHIVE_CHECKPOINT_NODES);
  const targetTerminals = Math.max(0, opts.targetTerminals ?? 0);
  const balanceCardChoiceMaxDepth = Math.max(0, opts.balanceCardChoiceMaxDepth ?? 8);
  const depthLimited = Number.isFinite(opts.maxDepth) && opts.maxDepth > 0;
  const rootState = resumeState?.rootState
    ? cloneHistoryState(resumeState.rootState)
    : runner.saveState();
  const chain = Array.isArray(resumeState?.chain) ? resumeState.chain.slice() : [];
  const stack = Array.isArray(resumeState?.stack)
    ? resumeState.stack.map((frame) => ({
        ...frame,
        baseState: cloneHistoryState(frame.baseState),
        ancestorStateKeys: cloneExactStateKeyPath(frame.ancestorStateKeys),
        actions: Array.isArray(frame.actions) ? frame.actions.map((item) => ({ ...item })) : [],
      }))
    : [];
  let activeFrame = null;
  let lastReportedNodes = -1;
  let lastReportedAtNs = 0n;
  let lastCheckpointNodes = Math.floor(best.nodes / checkpointEvery) * checkpointEvery;

  const settleTerminal = (chain, snapshotOverride = null, reasonHint = '', stateOverride = null) => {
    try {
      const rawSnapshot = snapshotOverride ?? runner.captureSnapshot();
      const scored = runner.scoreSnapshotDetailed(rawSnapshot);
      const candidate = {
        chain: chain.slice(),
        depth: chain.length,
        score: scored.score,
        reason: reasonHint,
        snapshot: scored.snapshot,
        state: null,
      };
      best.terminalCount += 1;
      const worst = best.topPaths[topK - 1] ?? null;
      const shouldKeepState =
        best.topPaths.length < topK ||
        isTopPathCandidateBetter(candidate, worst);
      if (shouldKeepState) {
        const resolvedState =
          typeof stateOverride === 'function'
            ? stateOverride()
            : stateOverride;
        candidate.state = resolvedState ? cloneHistoryState(resolvedState) : null;
      }
      best.topPaths.push(candidate);
      best.topPaths.sort(compareTopPathCandidates);
      if (best.topPaths.length > topK) best.topPaths.length = topK;
    } catch (err) {
      console.error(
        `[search-settle-terminal-failed] reason=${reasonHint || 'unknown'} chainDepth=${chain.length} history=${runner.actionHistory?.length ?? 0} decision=${formatDebugDecision(runner.currentDecision)}`,
      );
      throw err;
    }
  };

  const emitCheckpoint = (force = false) => {
    if (!onCheckpoint) return;
    if (!force && best.nodes < lastCheckpointNodes + checkpointEvery) return;
    lastCheckpointNodes = best.nodes;
    onCheckpoint({
      nodes: best.nodes,
      terminalCount: best.terminalCount,
      resumeState: serializeExactSearchResumeState({
        rootState,
        best,
        chain,
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
      best.nodes >= opts.maxNodes ||
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
      done: false,
    });
  };

  const syncCurrentChainFromState = (state) => {
    const nextChain = buildChainFromHistoryState(state);
    chain.length = 0;
    chain.push(...nextChain);
  };

  const prepareCurrentFrontier = (
    startDepth,
    nodeHardLimit = opts.maxNodes,
    ancestorStateKeys = [],
  ) => {
    let depth = startDepth;
    const seenStateKeys = new Set(cloneExactStateKeyPath(ancestorStateKeys));
    while (best.nodes < opts.maxNodes && best.nodes < nodeHardLimit) {
      const current = runner.currentDecision;
      const currentStateKey = buildCurrentDecisionStateKey(runner);

      if (currentStateKey) {
        if (seenStateKeys.has(currentStateKey)) {
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

      const nonEndActions = current.actions.filter((action) => action.kind !== 'phase_end');
      const sortedActions = sortActionsForLongestPath(
        nonEndActions.length > 0 ? nonEndActions : current.actions,
      );
      if (sortedActions.length !== 1) {
        const shouldBalanceCardChoices =
          depth <= balanceCardChoiceMaxDepth &&
          sortedActions.length > 1 &&
          sortedActions.every((action) =>
            typeof action?.label === 'string' && action.label.startsWith('选择卡片[')
          );
        const perChoiceBudget = shouldBalanceCardChoices
          ? Math.max(
              1,
              Math.floor(
                Math.max(1, Math.min(nodeHardLimit, opts.maxNodes) - best.nodes) / sortedActions.length,
              ),
            )
          : 0;
        const stateKey = currentStateKey || buildCurrentDecisionStateKey(runner);
        const lineageStateKeys = stateKey
          ? [...cloneExactStateKeyPath(ancestorStateKeys), stateKey]
          : cloneExactStateKeyPath(ancestorStateKeys);
        return {
          depth,
          nextIndex: 0,
          exploredChild: false,
          snapshot: null,
          stateKey,
          ancestorStateKeys: lineageStateKeys,
          nodeHardLimit,
          shouldBalanceCardChoices,
          perChoiceBudget,
          actions: sortedActions.map((action) => serializeSearchAction(action)),
          baseState: serializeHistoryState(runner.saveState()),
        };
      }

      const forcedAction = sortedActions[0];
      runner.step(forcedAction);
      best.nodes += 1;
      depth += 1;
      chain.push(forcedAction.label);
      maybeReportProgress(depth);

      if (forcedAction.kind === 'phase_end') {
        settleTerminal(chain, null, 'TURN_END', () => runner.saveResultState());
        return null;
      }
      if (best.nodes >= opts.maxNodes) {
        settleTerminal(chain, null, 'MAX_NODES', () => runner.saveResultState());
        return null;
      }
    }
    return null;
  };

  const logFrameRestoreFailed = (phase, frame, err) => {
    const actionCount = Array.isArray(frame?.actions) ? frame.actions.length : 0;
    const nextAction = actionCount > 0 ? summarizeSearchActionForLog(frame.actions[frame?.nextIndex ?? 0]) : '<none>';
    console.error(
      `[search-frame-restore-failed] phase=${phase} depth=${frame?.depth ?? -1} nextIndex=${frame?.nextIndex ?? -1}/${actionCount} targetHistory=${frame?.baseState?.history?.length ?? 0} currentHistory=${runner.actionHistory?.length ?? 0} stateKey=${frame?.stateKey ?? '<none>'} ancestors=${Array.isArray(frame?.ancestorStateKeys) ? frame.ancestorStateKeys.length : 0} nextAction=${nextAction} decision=${formatDebugDecision(runner.currentDecision)} actionWindow=${summarizeFrameActionsForLog(frame)} error=${err?.message ?? String(err)}`,
    );
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
  maybeReportProgress(0, true);
  if (stack.length === 0) {
    const rootFrame = prepareCurrentFrontier(0, opts.maxNodes, []);
    if (rootFrame) {
      stack.push(rootFrame);
      activeFrame = rootFrame;
    }
  } else if (stack.length > 0) {
    const top = stack[0];
    try {
      restoreExactSearchFrameState(runner, top);
    } catch (err) {
      logFrameRestoreFailed('resume', top, err);
      throw err;
    }
    syncCurrentChainFromState(top.baseState);
    activeFrame = top;
  }

  while (stack.length > 0 && best.nodes < opts.maxNodes) {
    if (targetTerminals > 0 && best.terminalCount >= targetTerminals) break;
    const frame = stack[0];
    if (frame !== activeFrame) {
      try {
        restoreExactSearchFrameState(runner, frame);
      } catch (err) {
        logFrameRestoreFailed('loop', frame, err);
        throw err;
      }
      syncCurrentChainFromState(frame.baseState);
      activeFrame = frame;
    }
    syncCurrentChainFromState(frame.baseState);

    if (frame.nextIndex >= frame.actions.length) {
      if (!frame.exploredChild) {
        settleTerminal(
          chain,
          frame.snapshot,
          best.nodes >= opts.maxNodes ? 'MAX_NODES' : 'NO_ACTION_EXPLORED',
          () => runner.saveResultState(),
        );
      }
      stack.shift();
      activeFrame = null;
      emitCheckpoint();
      continue;
    }

    const encodedAction = frame.actions[frame.nextIndex];
    frame.nextIndex += 1;
    const childLimit = frame.shouldBalanceCardChoices
      ? Math.min(frame.nodeHardLimit ?? opts.maxNodes, best.nodes + Math.max(1, frame.perChoiceBudget ?? 1))
      : (frame.nodeHardLimit ?? opts.maxNodes);
    const action = runner.resolveReplayAction(encodedAction, runner.currentDecision);
    runner.step(action);
    best.nodes += 1;
    frame.exploredChild = true;
    chain.push(action.label);

    const childDepth = frame.depth + 1;
    maybeReportProgress(childDepth);

    if (action.kind === 'phase_end') {
      settleTerminal(chain, null, 'TURN_END', () => runner.saveResultState());
      chain.length = frame.depth;
      activeFrame = null;
      emitCheckpoint();
      maybeReportProgress(childDepth);
      continue;
    }

    if (best.nodes >= opts.maxNodes) {
      settleTerminal(chain, null, 'MAX_NODES', () => runner.saveResultState());
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
      if (best.nodes < opts.maxNodes && frame.nextIndex < frame.actions.length) {
        try {
          restoreExactSearchFrameState(runner, frame);
        } catch (err) {
          logFrameRestoreFailed('resume-current', frame, err);
          throw err;
        }
        syncCurrentChainFromState(frame.baseState);
        activeFrame = frame;
      } else {
        if (frame.nextIndex >= frame.actions.length) stack.shift();
        activeFrame = null;
      }
      emitCheckpoint();
      maybeReportProgress(childDepth);
      continue;
    }
    stack.push(nextFrame);
    if (best.nodes < opts.maxNodes && frame.nextIndex < frame.actions.length) {
      try {
        restoreExactSearchFrameState(runner, frame);
      } catch (err) {
        logFrameRestoreFailed('restore-sibling', frame, err);
        throw err;
      }
      syncCurrentChainFromState(frame.baseState);
      activeFrame = frame;
    } else {
      if (frame.nextIndex >= frame.actions.length) stack.shift();
      activeFrame = null;
    }
    emitCheckpoint();
  }

  try {
    runner.restoreState(rootState);
  } catch (err) {
    console.error(
      `[search-root-restore-failed] phase=finalize history=${runner.actionHistory?.length ?? 0} targetHistory=${rootState?.history?.length ?? 0}`,
    );
    throw err;
  }
  if (best.topPaths.length === 0) {
    settleTerminal([], null, best.nodes >= opts.maxNodes ? 'MAX_NODES' : 'NO_RESULT', rootState);
  }
  emitCheckpoint(true);
  if (onProgress) {
    onProgress({
      nodes: best.nodes,
      maxNodes: opts.maxNodes,
      terminalCount: best.terminalCount,
      currentDepth: 0,
      done: true,
    });
  }
  return best;
}

function searchTopLongestPathsRandom(runner, opts) {
  const best = {
    nodes: 0,
    terminalCount: 0,
    topPaths: [],
  };
  const topK = Math.max(1, opts.topK ?? DEFAULT_OPTIONS.topK);
  const progressEvery = Math.max(1, opts.progressEvery ?? 200);
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const targetTerminals = Math.max(0, opts.targetTerminals ?? 0);
  const depthLimited = Number.isFinite(opts.maxDepth) && opts.maxDepth > 0;
  const rootState = runner.saveState();
  const rnd = makeXorshift32(((opts.seed ?? DEFAULT_OPTIONS.seed) ^ 0x85ebca6b) >>> 0);

  const settleTerminal = (chain, snapshotOverride = null, reasonHint = '', stateOverride = null) => {
    const rawSnapshot = snapshotOverride ?? runner.captureSnapshot();
    const scored = runner.scoreSnapshotDetailed(rawSnapshot);
    best.terminalCount += 1;
    const candidate = {
      chain: chain.slice(),
      depth: chain.length,
      score: scored.score,
      reason: reasonHint,
      snapshot: scored.snapshot,
      state: null,
    };
    const worst = best.topPaths[topK - 1] ?? null;
    const shouldKeepState =
      best.topPaths.length < topK ||
      isTopPathCandidateBetter(candidate, worst);
    if (shouldKeepState) {
      const resolvedState =
        typeof stateOverride === 'function'
          ? stateOverride()
          : stateOverride;
      candidate.state = resolvedState ? cloneHistoryState(resolvedState) : null;
    }
    best.topPaths.push(candidate);
    best.topPaths.sort(compareTopPathCandidates);
    if (best.topPaths.length > topK) best.topPaths.length = topK;
  };

  runner.restoreState(rootState);
  if (onProgress) {
    onProgress({
      nodes: best.nodes,
      maxNodes: opts.maxNodes,
      terminalCount: best.terminalCount,
      currentDepth: 0,
      done: false,
    });
  }

  while (best.nodes < opts.maxNodes) {
    if (targetTerminals > 0 && best.terminalCount >= targetTerminals) break;
    const nodesBeforeRound = best.nodes;
    runner.restoreState(rootState);

    const chain = [];
    let depth = 0;
    let reason = 'NO_ACTION_OR_NULL';

    while ((!depthLimited || depth < opts.maxDepth) && best.nodes < opts.maxNodes) {
      if (targetTerminals > 0 && best.terminalCount >= targetTerminals) break;
      const current = runner.currentDecision;
      if (!current || current.terminal || !current.actions?.length) {
        reason = current?.reason ?? 'NO_ACTION_OR_NULL';
        break;
      }

      const nonEndActions = current.actions.filter((a) => a.kind !== 'phase_end');
      const iterActions = nonEndActions.length > 0 ? nonEndActions : current.actions;
      if (!iterActions.length) {
        reason = 'NO_ACTION_OR_NULL';
        break;
      }

      const action = iterActions[Math.floor(rnd() * iterActions.length)];
      runner.step(action);
      chain.push(action.label);
      depth += 1;
      best.nodes += 1;

      if (action.kind === 'phase_end') {
        reason = 'TURN_END';
        break;
      }
      if (depthLimited && depth >= opts.maxDepth) {
        reason = 'MAX_DEPTH';
        break;
      }
      const next = runner.currentDecision;
      if (!next || next.terminal || !next.actions?.length) {
        reason = next?.reason ?? 'NO_ACTION_OR_NULL';
        break;
      }

      if (onProgress && (best.nodes % progressEvery === 0 || best.nodes >= opts.maxNodes)) {
        onProgress({
          nodes: best.nodes,
          maxNodes: opts.maxNodes,
          terminalCount: best.terminalCount,
          currentDepth: depth,
          done: false,
        });
      }
    }

    if (
      best.nodes >= opts.maxNodes &&
      (!depthLimited || depth < opts.maxDepth) &&
      reason === 'NO_ACTION_OR_NULL'
    ) {
      reason = 'MAX_NODES';
    }

    settleTerminal(chain, null, reason, runner.saveResultState());
    if (best.nodes === nodesBeforeRound) {
      break;
    }
  }

  runner.restoreState(rootState);
  if (best.topPaths.length === 0) settleTerminal([], null, 'NO_RESULT', rootState);
  if (onProgress) {
    onProgress({
      nodes: best.nodes,
      maxNodes: opts.maxNodes,
      terminalCount: best.terminalCount,
      currentDepth: 0,
      done: true,
    });
  }
  return best;
}

function searchTopLongestPaths(runner, opts) {
  return getExactSearchApi().searchTopLongestPathsExactSingle(runner, opts);
}

async function createRuntime(cardsPaths, scriptDirs) {
  if (typeof initSqlJs !== 'function') {
    throw new Error('sql.js 初始化函数不可用');
  }
  const SQL = await initSqlJs();
  const resolvedCardsPaths = Array.isArray(cardsPaths) ? cardsPaths : [cardsPaths];
  const dbs = resolvedCardsPaths.map((cardsPath) => new SQL.Database(fs.readFileSync(cardsPath)));
  const cardText = new CardTextResolver(dbs);

  const wrapper = await createOcgcoreWrapper({
    scriptBufferSize: OCGCORE_SCRIPT_BUFFER_SIZE,
  });
  const engineMessages = [];
  wrapper.setMessageHandler((_duel, message, type) => {
    engineMessages.push({ type, message: String(message ?? '') });
    if (engineMessages.length > 100) engineMessages.shift();
  }, true);
  wrapper.setScriptReader(DirScriptReader(...scriptDirs), true);
  wrapper.setCardReader(SqljsCardReader(...dbs), true);

  return {
    wrapper,
    db: { close: () => dbs.forEach((db) => db.close()) },
    cardText,
    engineMessages,
  };
}

function formatCards(codes, cardText) {
  return codes.map((c) => `${cardText.getName(c)}(${c})`);
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

// ===== topPath 收集策略(参见 src/core/search/exact-search.cjs 中的同名实现) =====
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

function topPathPolicyDefined(policy) {
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

function applyTopPathPolicy(list, candidate, topK, policy) {
  if (topPathPolicyDefined(policy) && policy.minScoreExclusive !== undefined && policy.minScoreExclusive !== null) {
    if (Number(candidate?.score ?? 0) <= Number(policy.minScoreExclusive)) return false;
  }
  if (topPathPolicyDefined(policy) && policy.diversityCap) {
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

function applyTopPathPolicyBatch(list, topK, policy) {
  if (!Array.isArray(list)) return [];
  let filtered = list;
  if (topPathPolicyDefined(policy) && policy.minScoreExclusive !== undefined && policy.minScoreExclusive !== null) {
    const threshold = Number(policy.minScoreExclusive);
    filtered = filtered.filter((c) => Number(c?.score ?? 0) > threshold);
  }
  filtered.sort(compareTopPathCandidates);
  if (topPathPolicyDefined(policy) && policy.diversityCap) {
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

function resolveTopReplayOutputPaths(exportYrpArg, seed, topPathsCount) {
  const count = Math.max(1, topPathsCount | 0);
  const defaultDir = path.join(process.cwd(), 'replays', `combo-seed${seed}`);
  const makeDefaultPath = (idx, depth) =>
    path.join(defaultDir, `top${idx + 1}-depth${depth}.yrp`);

  if (exportYrpArg === true) {
    return (depths) => depths.map((depth, idx) => makeDefaultPath(idx, depth));
  }

  const resolved = path.resolve(String(exportYrpArg));
  const ext = path.extname(resolved).toLowerCase();
  if (ext === '.yrp' && count === 1) {
    return () => [resolved];
  }
  if (ext === '.yrp' && count > 1) {
    const dir = path.dirname(resolved);
    const base = path.basename(resolved, '.yrp');
    return (depths) =>
      depths.map((depth, idx) => path.join(dir, `${base}-top${idx + 1}-depth${depth}.yrp`));
  }
  return (depths) =>
    depths.map((depth, idx) => path.join(resolved, `top${idx + 1}-depth${depth}.yrp`));
}

function renderProgressBar(nodes, maxNodes, currentDepth, terminalCount) {
  const total = Math.max(1, maxNodes | 0);
  const value = Math.max(0, Math.min(total, nodes | 0));
  const ratio = value / total;
  const width = 28;
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
  const bar = `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
  const percent = `${(ratio * 100).toFixed(1)}%`;
  return `探索进度 [${bar}] ${percent} (${value}/${total}) | 深度:${Math.max(0, currentDepth | 0)} | 终局:${Math.max(0, terminalCount | 0)}`;
}

async function cleanupRuntime(runtime, runner) {
  if (runner) runner.destroyDuel();
  if (runtime?.kind === 'native-random') {
    if (runtime.messageCallback) {
      try {
        koffi.unregister(runtime.messageCallback);
      } catch {
        // ignore
      }
    }
    if (runtime.cardCallback) {
      try {
        koffi.unregister(runtime.cardCallback);
      } catch {
        // ignore
      }
    }
    if (runtime?.db) {
      try {
        runtime.db.close();
      } catch {
        // ignore
      }
    }
    if (runtime?.lib) {
      try {
        runtime.lib.unload();
      } catch {
        // ignore
      }
    }
    if (runtime?.originalCwd) {
      try {
        process.chdir(runtime.originalCwd);
      } catch {
        // ignore
      }
    }
    return;
  }
  if (runtime?.wrapper) {
    try {
      runtime.wrapper.finalize();
    } catch {
      // ignore
    }
  }
  if (runtime?.db) {
    try {
      runtime.db.close();
    } catch {
      // ignore
    }
  }
}

function mergeTopPaths(items, topK) {
  return items
    .slice()
    .sort(compareTopPathCandidates)
    .slice(0, Math.max(1, topK | 0));
}

function mergeSearchResults(results, topK) {
  const merged = {
    nodes: 0,
    terminalCount: 0,
    topPaths: [],
  };
  for (const item of results) {
    if (!item?.result) continue;
    merged.nodes += item.result.nodes ?? 0;
    merged.terminalCount += item.result.terminalCount ?? 0;
    if (Array.isArray(item.result.topPaths) && item.result.topPaths.length > 0) {
      merged.topPaths.push(...item.result.topPaths);
    }
  }
  merged.topPaths = mergeTopPaths(merged.topPaths, topK);
  return merged;
}

function mergeProfileRows(rows) {
  const merged = new Map();
  for (const row of rows ?? []) {
    if (!row?.name) continue;
    const prev = merged.get(row.name) ?? { name: row.name, count: 0, totalMs: 0 };
    prev.count += row.count ?? 0;
    prev.totalMs += row.totalMs ?? 0;
    merged.set(row.name, prev);
  }
  return [...merged.values()].sort((a, b) => b.totalMs - a.totalMs);
}

async function runSingleSearchJob(job) {
  let runtime = null;
  let runner = null;
  try {
    ({ runtime, runner } = await createSearchContext(job));
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

    const searchStartNs = process.hrtime.bigint();
    const result = searchTopLongestPaths(runner, {
      maxDepth: job.maxDepth,
      maxNodes: job.maxNodes,
      targetTerminals: job.targetTerminals,
      maxBeamWidth: job.maxBeamWidth,
      topK: job.topK,
      seed: job.seed,
      exactSingleSearch: job.exactSingleSearch,
      progressEvery: job.progressEvery,
      onProgress: job.onProgress,
      onCheckpoint: job.onCheckpoint,
      checkpointEvery: job.checkpointEvery,
      exactSearchBackend: job.exactSearchBackend ?? 'js',
      resumeState: job.resumeState,
      searchStartedAtMs: job.searchStartedAtMs ?? job.startedAtMs,
      debugTrace: job.debugTrace,
      recordIntermediateScoredStates: Array.isArray(job.scoringRules) && job.scoringRules.length > 0,
    });
    const searchElapsedMs = Number(process.hrtime.bigint() - searchStartNs) / 1e6;
    return {
      result,
      searchElapsedMs,
      initialPlayerHand,
      initialOpponentHand,
      nativeSnapshotMode: runner.nativeSnapshotMode,
      initialDecisionName: runner.currentDecision?.message?.constructor?.name ?? '终局',
      profileRows: getCoreProfileRows(),
    };
  } finally {
    await cleanupRuntime(runtime, runner);
  }
}

async function runSearchJob(job) {
  if (shouldUseParallelExactSearch(job)) {
    return runParallelExactSearch(job);
  }
  return runSingleSearchJob(job);
}

async function createSearchContext(job) {
  if (job?.snapshotAccelMode) {
    snapshotState.setSnapshotAccelMode(String(job.snapshotAccelMode).toLowerCase());
  }
  if (job?.snapshotStorageMode) {
    snapshotState.setSnapshotStorageMode(String(job.snapshotStorageMode).toLowerCase());
  }
  if (job?.snapshotAccelMode || job?.snapshotStorageMode) {
    snapshotState.resetSnapshotAccelState();
  }
  const recordedSeedSequence = Array.isArray(job.seedSequence)
    ? job.seedSequence.map((value) => Number(value) >>> 0)
    : [];
  const seedSequence = job.yrpVersion === 2
    ? (recordedSeedSequence.length > 0 ? recordedSeedSequence : makeSeedSequence(job.seed >>> 0))
    : [];
  const config = {
    maxDepth: job.maxDepth,
    maxNodes: job.maxNodes,
    maxBeamWidth: job.maxBeamWidth,
    maxActionsPerNode: job.maxActionsPerNode,
    factorizeLargeSelections: job.factorizeLargeSelections === true,
    maxProcessPerStep: DEFAULT_OPTIONS.maxProcessPerStep,
    snapshotPoolSize: job.snapshotPoolSize,
    expandScriptKeywords: job.expandScriptKeywords,
  };

  if (job.engineBackend === 'native' && !job.exactSingleSearch) {
    const runtime = await createNativeRandomRuntime(job.cardsPath, job.nativeScriptsRoot ?? job.scriptDirs[0], {
      ocgcoreDllPath: job.nativeOcgcoreDllPath,
    });
    const runner = new NativeRandomDuelRunner({
      nativeRuntime: runtime,
      cardText: runtime.cardText,
      seed: job.seed,
      seedSequence,
      yrpVersion: job.yrpVersion,
      drawCount: job.drawCount,
      duelOptions: job.duelOptions,
      prebuiltRootCount: Math.max(1, Math.min(job.targetTerminals || 1, 128)),
      config,
      playerDeck: job.playerDeck,
      opponentDeck: job.opponentDeck,
      playerOpening: job.playerOpening,
      opponentOpening: job.opponentOpening,
      scoringRules: job.scoringRules,
      playerDeckInstances: job.playerDeckInstances,
    });
    runner.init();
    removeDecisionScoringSurface(runner);
    return { runtime, runner };
  }

  const runtime = await createRuntime(job.cardsPaths ?? job.cardsPath, job.scriptDirs);
  const runner = new DuelRunner({
    wrapper: runtime.wrapper,
    cardText: runtime.cardText,
    seed: job.seed,
    seedSequence,
    yrpVersion: job.yrpVersion,
    drawCount: job.drawCount,
    duelOptions: job.duelOptions,
    config,
    playerDeck: job.playerDeck,
    opponentDeck: job.opponentDeck,
    playerOpening: job.playerOpening,
    opponentOpening: job.opponentOpening,
    scoringRules: job.scoringRules,
    playerDeckInstances: job.playerDeckInstances,
  });
  runner.init();
  runner.engineMessages = runtime.engineMessages;
  removeDecisionScoringSurface(runner);
  return { runtime, runner };
}

function removeDecisionScoringSurface(runner) {
  const blockedProperties = ['scoringRules', 'scoreSnapshot', 'scoreSnapshotDetailed'];
  for (const property of blockedProperties) delete runner[property];
  let prototype = Object.getPrototypeOf(runner);
  while (prototype && prototype !== Object.prototype) {
    for (const property of blockedProperties) delete prototype[property];
    prototype = Object.getPrototypeOf(prototype);
  }
}

async function runParallelRandomSearch(job) {
  const requestedWorkers = Math.max(2, job.workers | 0);
  const cpuCap =
    typeof os.availableParallelism === 'function'
      ? os.availableParallelism()
      : Math.max(1, os.cpus().length);
  const workerCount = Math.max(
    2,
    Math.min(
      requestedWorkers,
      Math.max(2, job.targetTerminals || requestedWorkers),
      cpuCap,
    ),
  );
  const perWorkerTerminals = Math.floor(job.targetTerminals / workerCount);
  const extraTerminals = job.targetTerminals % workerCount;
  const workers = [];
  const workerResults = [];

  try {
    for (let index = 0; index < workerCount; index += 1) {
      const targetTerminals =
        perWorkerTerminals + (index < extraTerminals ? 1 : 0);
      const child = fork(__filename, ['--child-worker'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          COMBO_SIMULATOR_CHILD: '1',
        },
        // --max-old-space-size=4096:把 V8 老生代上限提到 4 GB,避免高强度搜索撞 2 GB 红线。
        // 与 src/runtime/exact-parallel-runtime.cjs 中 exact-parallel worker 的 execArgv 保持一致。
        execArgv: ['--max-old-space-size=4096'],
        silent: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      child.send({
        type: 'init',
        job: {
          ...job,
          targetTerminals,
          maxNodes: Math.max(1, Math.ceil(job.maxNodes / workerCount)),
          progressEvery: 0,
          workers: 1,
          seed: (job.seed + ((index + 1) * 0x9e3779b9)) >>> 0,
        },
      });
      workers.push(child);
    }

    await Promise.all(workers.map((worker) => new Promise((resolve, reject) => {
      const onMessage = (message) => {
        if (message?.type !== 'ready') return;
        worker.off('message', onMessage);
        resolve();
      };
      worker.on('message', onMessage);
      worker.once('error', reject);
      worker.once('exit', (code) => {
        if (code !== 0) reject(new Error(`worker exited with code ${code}`));
      });
    })));

    const searchStartNs = process.hrtime.bigint();
    const settled = await Promise.all(workers.map((worker) => new Promise((resolve, reject) => {
      worker.once('message', (message) => {
        if (message?.type === 'result') {
          resolve(message.payload);
          return;
        }
        if (message?.type === 'error') {
          reject(new Error(message.error || 'worker search failed'));
          return;
        }
        reject(new Error('worker returned unexpected message'));
      });
      worker.once('error', reject);
      worker.send({ type: 'run' });
    })));
    const searchElapsedMs = Number(process.hrtime.bigint() - searchStartNs) / 1e6;
    workerResults.push(...settled);

    return {
      workerCount,
      searchElapsedMs,
      result: mergeSearchResults(workerResults, job.topK),
      profileRows: mergeProfileRows(workerResults.flatMap((item) => item?.profileRows ?? [])),
      nativeSnapshotMode: workerResults[0]?.nativeSnapshotMode ?? 'unknown',
      initialDecisionName: workerResults[0]?.initialDecisionName ?? '终局',
    };
  } finally {
    await Promise.all(workers.map((worker) => new Promise((resolve) => {
      if (worker.killed || worker.exitCode !== null) {
        resolve();
        return;
      }
      worker.once('exit', () => resolve());
      worker.kill();
    })));
  }
}

const {
  shouldUseParallelExactSearch,
  isParallelExactResumeState,
  runParallelExactSearch,
} = createExactParallelRuntimeApi({
  console,
  os,
  process,
  fork,
  Worker,
  childEntryFile: __filename,
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
});

function resolveResourcePaths(options = {}) {
  const resourceDir = options.resourceDir
    ? path.resolve(String(options.resourceDir))
    : DEFAULT_LIB_DIR;
  const deckPath = options.deckPath
    ? path.resolve(String(options.deckPath))
    : path.join(resourceDir, 'slm.ydk');
  const opponentDeckPath = options.opponentDeckPath
    ? path.resolve(String(options.opponentDeckPath))
    : deckPath;
  const cardsPath = options.cardsPath
    ? path.resolve(String(options.cardsPath))
    : path.join(resourceDir, 'cards.cdb');
  const scriptsRoot = options.scriptsRoot
    ? path.resolve(String(options.scriptsRoot))
    : path.join(resourceDir, 'ygopro-scripts');
  return {
    resourceDir,
    deckPath,
    opponentDeckPath,
    cardsPath,
    scriptsRoot,
    scriptDirs: resolveScriptDirs(scriptsRoot),
  };
}

async function createCardTextRuntime(cardsPath) {
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(cardsPath));
  return {
    db,
    cardText: new CardTextResolver(db),
  };
}

function buildSearchResultPayload(searchResult, openingInfo, exportIndex = null) {
  return {
    openingInstanceIds: openingInfo?.openingInstanceIds ?? [],
    openingCodes: openingInfo?.openingCodes ?? [],
    depth: searchResult.depth,
    score: searchResult.score,
    chain: searchResult.chain ?? [],
    reason: searchResult.reason ?? '',
    terminalDepth: searchResult.terminalDepth ?? searchResult.depth,
    terminalReason: searchResult.terminalReason ?? searchResult.reason ?? '',
    bestScoreDepth: searchResult.bestScoreDepth ?? searchResult.depth,
    scoreTrace: Array.isArray(searchResult.scoreTrace) ? searchResult.scoreTrace : [],
    scoreBreakdown: Array.isArray(searchResult.scoreBreakdown) ? searchResult.scoreBreakdown : [],
    routeFoundAtMs: searchResult.routeFoundAtMs ?? null,
    routeFoundAtIso: searchResult.routeFoundAtIso ?? null,
    routeFoundElapsedMs: searchResult.routeFoundElapsedMs ?? null,
    routeFoundNodes: searchResult.routeFoundNodes ?? null,
    routeFoundTerminals: searchResult.routeFoundTerminals ?? null,
    snapshot: searchResult.snapshot ?? null,
    exportIndex,
  };
}

function buildRankedSearchResultExportItems(aggregated, topK) {
  const ranked = [];
  for (const item of aggregated ?? []) {
    const topPaths = Array.isArray(item?.searchResult?.topPaths)
      ? item.searchResult.topPaths
      : [];
    for (const topPath of topPaths) {
      ranked.push({ item, topPath });
    }
  }
  const selected = ranked
    .sort((a, b) => compareTopPathCandidates(a.topPath, b.topPath))
    .slice(0, Math.max(1, topK | 0));
  const exportItems = [];
  const searchResults = selected.map(({ item, topPath }) => {
    const exportIndex = exportItems.length;
    exportItems.push({
      opening: item.opening,
      openingCodes: item.openingCodes,
      openingInstanceIds: item.openingInstanceIds,
      opponentOpening: item.opponentOpening,
      seed: item.seed,
      depth: topPath.depth,
      terminalDepth: topPath.terminalDepth ?? topPath.depth,
      bestScoreDepth: topPath.bestScoreDepth ?? topPath.depth,
      scoreTrace: Array.isArray(topPath.scoreTrace) ? topPath.scoreTrace : [],
      scoreBreakdown: Array.isArray(topPath.scoreBreakdown) ? topPath.scoreBreakdown : [],
      routeFoundAtMs: topPath.routeFoundAtMs ?? null,
      routeFoundAtIso: topPath.routeFoundAtIso ?? null,
      routeFoundElapsedMs: topPath.routeFoundElapsedMs ?? null,
      routeFoundNodes: topPath.routeFoundNodes ?? null,
      routeFoundTerminals: topPath.routeFoundTerminals ?? null,
      state: topPath.state ? cloneHistoryState(topPath.state) : null,
      chain: topPath.chain ?? [],
    });
    return buildSearchResultPayload(topPath, item, exportIndex);
  });
  return { searchResults, exportItems };
}

function buildArchiveSearchRetuneOptions(options = {}) {
  const topK = normalizeRequestedTopK(options.topK);
  return {
    topK,
    retainedTopK: Math.max(
      topK,
      Math.max(1, toInt(options.retainedTopK, WEB_SEARCH_RESUME_COMPATIBLE_TOPK)),
    ),
    scoringRules: normalizeScoringRules(options.scoringRules),
    playerDeckInstances:
      options.playerDeckInstances
      ?? createDeckCardInstances(options.playerDeck ?? { main: [], extra: [], side: [] }),
  };
}

function retuneTopPathCandidates(candidates, options = {}) {
  const retuneOptions = buildArchiveSearchRetuneOptions(options);
  return (Array.isArray(candidates) ? candidates : [])
    .map((candidate) => {
      if (!candidate || typeof candidate !== 'object') return null;
      const rescored = candidate.snapshot
        ? scoreSnapshotByRules(
            candidate.snapshot,
            retuneOptions.scoringRules,
            retuneOptions.playerDeckInstances,
          )
        : {
            score: Number(candidate.score ?? 0),
            snapshot: candidate.snapshot ?? null,
          };
      return {
        ...candidate,
        chain: Array.isArray(candidate.chain) ? candidate.chain.slice() : [],
        score: Number(rescored.score ?? candidate.score ?? 0),
        scoreBreakdown: Array.isArray(rescored.breakdown) ? rescored.breakdown : [],
        snapshot: rescored.snapshot ?? candidate.snapshot ?? null,
        state: candidate.state ? cloneHistoryState(candidate.state) : null,
      };
    })
    .filter(Boolean)
    .sort(compareTopPathCandidates)
    .slice(0, retuneOptions.retainedTopK);
}

function retuneSearchCoreResult(searchResult, options = {}) {
  const completed = searchResult?.completed !== false;
  return {
    nodes: Number(searchResult?.nodes ?? 0),
    terminalCount: Number(searchResult?.terminalCount ?? 0),
    topPaths: retuneTopPathCandidates(searchResult?.topPaths, options),
    completed,
    stopReason:
      typeof searchResult?.stopReason === 'string' && searchResult.stopReason
        ? searchResult.stopReason
        : completed
          ? 'DONE'
          : 'UNKNOWN',
  };
}

function retuneArchiveOpeningRecord(item, options = {}) {
  if (!item || typeof item !== 'object') return null;
  return {
    ...item,
    openingInstanceIds: Array.isArray(item.openingInstanceIds) ? item.openingInstanceIds.slice() : [],
    openingCodes: Array.isArray(item.openingCodes) ? item.openingCodes.slice() : [],
    opening: item.opening ?? null,
    opponentOpening: item.opponentOpening ?? null,
    searchResult: retuneSearchCoreResult(item.searchResult, options),
  };
}

function retuneArchiveCurrentOpening(currentOpening, options = {}) {
  const archivedCurrent = deserializeArchiveCurrentOpening(currentOpening);
  if (!archivedCurrent?.resumeState) return archivedCurrent;
  if (isParallelExactResumeState(archivedCurrent.resumeState)) {
    if (!archivedCurrent.resumeState.best) return archivedCurrent;
    archivedCurrent.resumeState = {
      ...archivedCurrent.resumeState,
      best: retuneSearchCoreResult(archivedCurrent.resumeState.best, options),
    };
    return archivedCurrent;
  }
  const resumeState = getExactSearchApi().deserializeExactSearchResumeState(archivedCurrent.resumeState);
  if (!resumeState?.best) return archivedCurrent;
  archivedCurrent.resumeState = getExactSearchApi().serializeExactSearchResumeState({
    ...resumeState,
    best: retuneSearchCoreResult(resumeState.best, options),
  });
  return archivedCurrent;
}

function buildPartialOpeningRecordFromArchiveCurrent(currentOpening, options = {}) {
  const archivedCurrent = deserializeArchiveCurrentOpening(currentOpening);
  if (!archivedCurrent?.resumeState) return null;
  if (isParallelExactResumeState(archivedCurrent.resumeState) && archivedCurrent.resumeState.best) {
    const searchResult = retuneSearchCoreResult(archivedCurrent.resumeState.best, options);
    return {
      openingInstanceIds: archivedCurrent.openingInstanceIds ?? [],
      openingCodes: archivedCurrent.openingCodes ?? [],
      opening: archivedCurrent.opening ?? null,
      opponentOpening: archivedCurrent.opponentOpening ?? null,
      seed: archivedCurrent.seed ?? 0,
      exactSearchBackend: archivedCurrent.exactSearchBackend ?? 'parallel-js',
      searchResult,
    };
  }
  const resumeState = getExactSearchApi().deserializeExactSearchResumeState(archivedCurrent.resumeState);
  if (!resumeState?.best) return null;
  const searchResult = retuneSearchCoreResult(resumeState.best, options);
  return {
    openingInstanceIds: archivedCurrent.openingInstanceIds ?? [],
    openingCodes: archivedCurrent.openingCodes ?? [],
    opening: archivedCurrent.opening ?? null,
    opponentOpening: archivedCurrent.opponentOpening ?? null,
    seed: archivedCurrent.seed ?? 0,
    exactSearchBackend: archivedCurrent.exactSearchBackend ?? 'js',
    searchResult,
  };
}

function buildArchiveCurrentOpeningFromSearchResult(params = {}) {
  const searchResult = params.searchResult;
  if (searchResult?.completed !== false || !searchResult?.resumeState) return null;
  return {
    openingIndex: params.openingIndex ?? 0,
    openingInstanceIds: Array.isArray(params.openingInstanceIds) ? params.openingInstanceIds.slice() : [],
    openingCodes: Array.isArray(params.openingCodes) ? params.openingCodes.slice() : [],
    opening: params.opening ?? null,
    opponentOpening: params.opponentOpening ?? null,
    seed: params.seed ?? 0,
    exactSearchBackend: params.exactSearchBackend ?? 'js',
    resumeState: searchResult.resumeState,
  };
}

function buildCompletedOpeningsForArchive(records, currentOpening = null) {
  if (!currentOpening) return records;
  const currentIndex = Number(currentOpening.openingIndex ?? -1);
  if (!Number.isInteger(currentIndex) || currentIndex < 0) return records;
  return records.filter((_, index) => index !== currentIndex);
}

function buildFinalResultFromArchiveState(archive, requestOverrides = {}) {
  const request = {
    ...(archive?.request ?? {}),
    ...requestOverrides,
  };
  const retuneOptions = buildArchiveSearchRetuneOptions({
    topK: request.topK ?? request.topP ?? request.topp,
    scoringRules: request.scoringRules,
    playerDeck: request.playerDeck ?? archive?.request?.playerDeck,
  });
  const completed = Array.isArray(archive?.completedOpenings)
    ? archive.completedOpenings
      .map(deserializeArchiveOpeningRecord)
      .map((item) => retuneArchiveOpeningRecord(item, retuneOptions))
      .filter(Boolean)
    : [];
  const partialCurrent = buildPartialOpeningRecordFromArchiveCurrent(
    archive?.currentOpening,
    retuneOptions,
  );
  const currentOpening = deserializeArchiveCurrentOpening(archive?.currentOpening);
  const aggregated = completed.slice();
  if (partialCurrent) {
    const currentIndex = Number(currentOpening?.openingIndex ?? -1);
    if (Number.isInteger(currentIndex) && currentIndex >= 0 && currentIndex < aggregated.length) {
      aggregated[currentIndex] = partialCurrent;
    } else {
      aggregated.push(partialCurrent);
    }
  }
  const topK = retuneOptions.topK;
  const { searchResults, exportItems } = buildRankedSearchResultExportItems(aggregated, topK);
  const totalNodes = aggregated.reduce((sum, item) => sum + (item.searchResult?.nodes ?? 0), 0);
  const totalTerminals = aggregated.reduce((sum, item) => sum + (item.searchResult?.terminalCount ?? 0), 0);
  return {
    completedOpenings: aggregated,
    finalResult: {
      searchResults,
      exploredOpenings: aggregated.length,
      totalNodes,
      totalTerminals,
      truncated: aggregated.some((item) => item.searchResult?.completed === false),
      exportItems,
    },
  };
}

async function runExhaustiveOpeningSearch(options) {
  const {
    resourcePaths,
    seed,
    drawCount,
    maxDepth,
    maxNodes,
    targetTerminals,
    maxBeamWidth,
    maxActionsPerNode,
    snapshotPoolSize,
    topK,
    expandScriptKeywords,
    yrpVersion,
    playerDeck,
    opponentDeck,
    playerDeckInstances,
    fixedOpeningInstanceIds = [],
    fixedOpeningCodes = [],
    fixedOpponentOpeningCodes = [],
    scoringRules = [],
    enumerateOpenings = false,
    engineBackend = 'wasm',
    exactSearchBackend = 'js',
    workers = 1,
    snapshotAccelMode = snapshotState.getSnapshotAccelMode(),
    snapshotStorageMode = snapshotState.getSnapshotStorageMode(),
    progressEvery = 0,
    profileCore = snapshotState.isCoreProfileEnabled(),
    verbose = false,
    onProgress = null,
    onArchiveUpdate = null,
    archivePath = null,
    requestSignature = '',
    resumeArchive = null,
    searchStartedAtMs = Date.now(),
    debugTrace = null,
    checkpointEvery = WEB_ARCHIVE_CHECKPOINT_NODES,
  } = options;
  const normalizedCheckpointEvery = Math.max(1, Number(checkpointEvery) || WEB_ARCHIVE_CHECKPOINT_NODES);
  const retainedTopK = buildResumeCompatibleTopK(topK);
  const archiveRetuneOptions = buildArchiveSearchRetuneOptions({
    topK,
    retainedTopK,
    scoringRules,
    playerDeckInstances,
  });

  const selectedIds = [...new Set(fixedOpeningInstanceIds ?? [])];
  const openingSpecs = [];
  if (selectedIds.length > 0) {
    const opening = buildFixedOpeningFromInstanceIds(
      playerDeckInstances.main,
      selectedIds,
      drawCount,
      '我方固定起手',
    );
    openingSpecs.push({
      opening,
      openingCodes: opening.opening.slice(),
      openingInstanceIds: opening.openingInstanceIds.slice(),
    });
  } else if (Array.isArray(fixedOpeningCodes) && fixedOpeningCodes.length > 0) {
    const opening = buildFixedOpening(playerDeck.main, fixedOpeningCodes, '我方固定起手');
    const openingInstanceIds = [];
    const remainingIds = new Set(playerDeckInstances.main.map((card) => card.instanceId));
    for (const code of opening.opening) {
      const match = playerDeckInstances.main.find(
        (card) => remainingIds.has(card.instanceId) && (card.code >>> 0) === (code >>> 0),
      );
      if (match) {
        openingInstanceIds.push(match.instanceId);
        remainingIds.delete(match.instanceId);
      }
    }
    openingSpecs.push({
      opening,
      openingCodes: opening.opening.slice(),
      openingInstanceIds,
    });
  } else if (enumerateOpenings) {
    for (const combo of chooseCombinations(playerDeckInstances.main, drawCount)) {
      const instanceIds = combo.map((card) => card.instanceId);
      const opening = buildFixedOpeningFromInstanceIds(
        playerDeckInstances.main,
        instanceIds,
        drawCount,
        '我方穷举起手',
      );
      openingSpecs.push({
        opening,
        openingCodes: opening.opening.slice(),
        openingInstanceIds: opening.openingInstanceIds.slice(),
      });
    }
  } else {
    const opening = {
      ...simulateOpeningHand(playerDeck.main, drawCount, seed),
      openingInstanceIds: [],
    };
    openingSpecs.push({
      opening,
      openingCodes: opening.opening.slice(),
      openingInstanceIds: [],
    });
  }

  const archivedCompleted = Array.isArray(resumeArchive?.completedOpenings)
    ? resumeArchive.completedOpenings
      .map(deserializeArchiveOpeningRecord)
      .map((item) => retuneArchiveOpeningRecord(item, archiveRetuneOptions))
      .filter(Boolean)
    : [];
  const archivedCurrentOpening = retuneArchiveCurrentOpening(
    resumeArchive?.currentOpening,
    archiveRetuneOptions,
  );
  const aggregated = archivedCompleted.slice(0, openingSpecs.length);
  const exportItems = [];
  let totalNodes = aggregated.reduce((sum, item) => sum + (item.searchResult?.nodes ?? 0), 0);
  let totalTerminals = aggregated.reduce((sum, item) => sum + (item.searchResult?.terminalCount ?? 0), 0);
  let finalCurrentOpening = null;
  const emitProgress = (payload) => {
    if (typeof onProgress === 'function') onProgress(payload);
  };
  const persistArchive = (
    status,
    currentOpening = null,
    finalResult = null,
    extraProgress = {},
    completedOpenings = aggregated,
  ) => {
    if (typeof onArchiveUpdate !== 'function') return;
    onArchiveUpdate({
      archivePath,
      status,
      requestSignature,
      progress: {
        exploredOpenings: aggregated.length,
        totalOpenings: openingSpecs.length,
        totalNodes,
        totalTerminals,
        ...extraProgress,
      },
      completedOpenings,
      currentOpening,
      finalResult,
    });
  };

  emitProgress({
    phase: 'prepare',
    message: `已生成 ${openingSpecs.length} 组待搜索起手`,
    exploredOpenings: aggregated.length,
    totalOpenings: openingSpecs.length,
    totalNodes,
    totalTerminals,
  });

  for (let index = aggregated.length; index < openingSpecs.length; index += 1) {
    const openingSpec = openingSpecs[index];
    emitProgress({
      phase: 'opening_start',
      message: `开始搜索第 ${index + 1}/${openingSpecs.length} 组起手: ${openingSpec.openingCodes.join(', ') || '未指定'}`,
      openingIndex: index,
      exploredOpenings: index,
      totalOpenings: openingSpecs.length,
      openingCodes: openingSpec.openingCodes,
      totalNodes,
      totalTerminals,
    });
    const seedForOpening = (seed + index) >>> 0;
    const canResumeCurrentOpening =
      archivedCurrentOpening
      && archivedCurrentOpening.openingIndex === index
      && stableStringify(archivedCurrentOpening.openingCodes ?? []) === stableStringify(openingSpec.openingCodes ?? []);
    const opponentOpening = canResumeCurrentOpening
      ? archivedCurrentOpening.opponentOpening
      : Array.isArray(fixedOpponentOpeningCodes) && fixedOpponentOpeningCodes.length > 0
      ? buildFixedOpening(opponentDeck.main, fixedOpponentOpeningCodes, '对方固定起手')
      : simulateOpeningHand(
          opponentDeck.main,
          drawCount,
          (seed ^ 0x9e3779b9 ^ index) >>> 0,
        );
    const jobResult = await runSearchJob({
      cardsPath: resourcePaths.cardsPath,
      scriptDirs: resourcePaths.scriptDirs,
      nativeScriptsRoot: resourcePaths.scriptsRoot,
      seed: seedForOpening,
      drawCount,
      maxDepth,
      maxNodes,
      targetTerminals,
      maxBeamWidth,
      maxActionsPerNode,
      snapshotPoolSize,
      topK: retainedTopK,
      expandScriptKeywords,
      playerDeck,
      opponentDeck,
      playerOpening: openingSpec.opening,
      opponentOpening,
      exactSingleSearch: true,
      exactSearchBackend,
      workers,
      scoringRules,
      playerDeckInstances,
      engineBackend,
      snapshotAccelMode,
      snapshotStorageMode,
      yrpVersion,
      progressEvery,
      profileCore,
      checkpointEvery: normalizedCheckpointEvery,
      searchStartedAtMs,
      verbose,
      resumeState: canResumeCurrentOpening ? archivedCurrentOpening.resumeState : null,
      debugTrace: debugTrace && typeof debugTrace === 'object'
        ? {
            ...debugTrace,
            label: typeof debugTrace.label === 'string' && debugTrace.label
              ? `${debugTrace.label}#${index + 1}`
              : `opening-${index + 1}`,
            opening: {
              requestedFixedOpeningInstanceIds: selectedIds.slice(),
              requestedFixedOpeningCodes: Array.isArray(fixedOpeningCodes)
                ? fixedOpeningCodes.map((code) => code >>> 0)
                : [],
              resolvedOpeningCodes: openingSpec.openingCodes.slice(),
              resolvedOpeningInstanceIds: openingSpec.openingInstanceIds.slice(),
              resolvedOpponentOpeningCodes: Array.isArray(opponentOpening?.opening)
                ? opponentOpening.opening.map((code) => code >>> 0)
                : [],
              openingIndex: index,
              seed: seedForOpening,
            },
          }
        : null,
      onProgress: (progress) => {
        emitProgress({
          phase: 'searching',
          message: `起手 ${index + 1}/${openingSpecs.length} 搜索中: ${progress.nodes}/${progress.maxNodes} 节点, 深度 ${progress.currentDepth}, 终局 ${progress.terminalCount}`,
          openingIndex: index,
          exploredOpenings: index,
          totalOpenings: openingSpecs.length,
          openingCodes: openingSpec.openingCodes,
          totalNodes: totalNodes + progress.nodes,
          totalTerminals: totalTerminals + progress.terminalCount,
          currentNodes: progress.nodes,
          maxNodes: progress.maxNodes,
          currentDepth: progress.currentDepth,
          terminalCount: progress.terminalCount,
          done: !!progress.done,
        });
      },
      onCheckpoint: (checkpoint) => {
        persistArchive('partial', {
          openingIndex: index,
          openingInstanceIds: openingSpec.openingInstanceIds,
          openingCodes: openingSpec.openingCodes,
          opening: openingSpec.opening,
          opponentOpening,
          seed: seedForOpening,
          exactSearchBackend,
          resumeState: checkpoint.resumeState,
        }, null, {
          exploredOpenings: index,
          totalNodes: totalNodes + (checkpoint.nodes ?? 0),
          totalTerminals: totalTerminals + (checkpoint.terminalCount ?? 0),
          checkpointNodes: checkpoint.nodes ?? 0,
        });
        emitProgress({
          phase: 'checkpoint',
          message: `opening ${index + 1}/${openingSpecs.length} checkpoint saved: nodes ${checkpoint.nodes ?? 0}/${maxNodes}, terminals ${checkpoint.terminalCount ?? 0}`,
          openingIndex: index,
          exploredOpenings: index,
          totalOpenings: openingSpecs.length,
          openingCodes: openingSpec.openingCodes,
          totalNodes: totalNodes + (checkpoint.nodes ?? 0),
          totalTerminals: totalTerminals + (checkpoint.terminalCount ?? 0),
          checkpointNodes: checkpoint.nodes ?? 0,
          currentNodes: checkpoint.nodes ?? 0,
          terminalCount: checkpoint.terminalCount ?? 0,
          done: false,
        });
      },
    });
    totalNodes += jobResult.result.nodes;
    totalTerminals += jobResult.result.terminalCount;
    const openingRecord = {
      openingInstanceIds: openingSpec.openingInstanceIds,
      openingCodes: openingSpec.openingCodes,
      opening: openingSpec.opening,
      opponentOpening,
      seed: seedForOpening,
      exactSearchBackend,
      initialPlayerHand: Array.isArray(jobResult.initialPlayerHand) ? jobResult.initialPlayerHand.slice() : null,
      initialOpponentHand: Array.isArray(jobResult.initialOpponentHand) ? jobResult.initialOpponentHand.slice() : null,
      debugSummary: jobResult.result?.debugSummary ?? null,
      profileRows: Array.isArray(jobResult.profileRows) ? jobResult.profileRows.slice() : [],
      searchResult: jobResult.result,
    };
    aggregated.push(openingRecord);
    const currentOpening = buildArchiveCurrentOpeningFromSearchResult({
      openingIndex: index,
      openingInstanceIds: openingSpec.openingInstanceIds,
      openingCodes: openingSpec.openingCodes,
      opening: openingSpec.opening,
      opponentOpening,
      seed: seedForOpening,
      exactSearchBackend,
      searchResult: jobResult.result,
    });
    if (currentOpening) {
      finalCurrentOpening = currentOpening;
      persistArchive('partial', currentOpening, null, {
        exploredOpenings: index,
      }, buildCompletedOpeningsForArchive(aggregated, currentOpening));
    } else {
      persistArchive('partial', null, null, {
        exploredOpenings: index + 1,
      });
    }
    emitProgress({
      phase: 'opening_done',
      message: `完成第 ${index + 1}/${openingSpecs.length} 组起手: 节点 ${jobResult.result.nodes}, 终局 ${jobResult.result.terminalCount}`,
      openingIndex: index,
      exploredOpenings: index + 1,
      totalOpenings: openingSpecs.length,
      openingCodes: openingSpec.openingCodes,
      totalNodes,
      totalTerminals,
    });
    if (currentOpening) break;
  }

  const rankedPayload = buildRankedSearchResultExportItems(aggregated, topK);
  exportItems.push(...rankedPayload.exportItems);
  const searchResults = rankedPayload.searchResults;

  const finalPayload = {
    searchResults,
    exploredOpenings: aggregated.length,
    totalNodes,
    totalTerminals,
    profileRows: mergeProfileRows(aggregated.flatMap((item) => item.profileRows ?? [])),
    truncated: aggregated.some((item) => item.searchResult?.completed === false),
    openingDiagnostics: aggregated.map((item, index) => ({
      openingIndex: index,
      openingCodes: item.openingCodes.slice(),
      openingInstanceIds: item.openingInstanceIds.slice(),
      initialPlayerHand: Array.isArray(item.initialPlayerHand) ? item.initialPlayerHand.slice() : [],
      initialOpponentHand: Array.isArray(item.initialOpponentHand) ? item.initialOpponentHand.slice() : [],
      opponentOpeningCodes: Array.isArray(item.opponentOpening?.opening)
        ? item.opponentOpening.opening.slice()
        : [],
      nodes: item.searchResult?.nodes ?? 0,
      terminalCount: item.searchResult?.terminalCount ?? 0,
      topDepth: item.searchResult?.topPaths?.[0]?.depth ?? 0,
      topScore: item.searchResult?.topPaths?.[0]?.score ?? 0,
      debugSummary: item.debugSummary ?? null,
    })),
    exportItems,
  };
  const finalCompletedOpenings = buildCompletedOpeningsForArchive(aggregated, finalCurrentOpening);
  persistArchive(finalPayload.truncated ? 'truncated' : 'completed', finalCurrentOpening, finalPayload, {
    exploredOpenings: finalCurrentOpening ? finalCurrentOpening.openingIndex : openingSpecs.length,
    done: true,
  }, finalCompletedOpenings);
  emitProgress({
    phase: 'done',
    message: `搜索完成，共 ${aggregated.length}/${openingSpecs.length} 组起手，累计 ${totalNodes} 节点`,
    exploredOpenings: finalCurrentOpening ? finalCurrentOpening.openingIndex : openingSpecs.length,
    totalOpenings: openingSpecs.length,
    totalNodes,
    totalTerminals,
    resultCount: searchResults.length,
    truncated: finalPayload.truncated,
    done: true,
  });
  return finalPayload;
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
  }[ext] ?? 'application/octet-stream';
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function ensureWebArchiveDir() {
  fs.mkdirSync(WEB_ARCHIVE_DIR, { recursive: true });
  return WEB_ARCHIVE_DIR;
}

function normalizeArchivePath(pathValue) {
  return path.resolve(String(pathValue));
}

function resolveArchivePathCandidate(pathValue) {
  let raw = String(pathValue ?? '').trim();
  if (!raw) return null;
  if (/\.v8$/i.test(raw)) raw = raw.replace(/\.v8$/i, '');
  if (path.basename(raw) === raw) {
    return path.join(WEB_ARCHIVE_DIR, raw);
  }
  return normalizeArchivePath(raw);
}

function buildWebArchivePath(signature) {
  if (!WEB_ARCHIVE_ENABLED) return null;
  ensureWebArchiveDir();
  return path.join(WEB_ARCHIVE_DIR, `web-${String(signature).slice(0, 16)}.combo-archive.json`);
}

function buildWebArchiveBackupPath(archivePath) {
  const resolved = normalizeArchivePath(archivePath);
  return `${resolved}.bak`;
}

function buildWebArchiveBinaryPath(archivePath) {
  const resolved = normalizeArchivePath(archivePath);
  return `${resolved}.v8`;
}

function writeJsonAtomic(outPath, payload) {
  const resolved = normalizeArchivePath(outPath);
  const dir = path.dirname(resolved);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${resolved}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, resolved);
  return resolved;
}

function writeFileAtomic(outPath, payload) {
  const resolved = normalizeArchivePath(outPath);
  const dir = path.dirname(resolved);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${resolved}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, payload);
  fs.renameSync(tmpPath, resolved);
  return resolved;
}

function writeV8ArchiveAtomic(outPath, payload) {
  const resolved = normalizeArchivePath(outPath);
  const dir = path.dirname(resolved);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${resolved}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, v8.serialize(payload));
  fs.renameSync(tmpPath, resolved);
  return resolved;
}

function readJsonIfExists(filePath) {
  const resolved = normalizeArchivePath(filePath);
  if (!fs.existsSync(resolved)) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (err) {
    if (err?.code === 'ERR_STRING_TOO_LONG') {
      logTerminal('warn', 'web-search', 'archive-json-too-large', {
        filePath: resolved,
        error: err.message,
      });
      return null;
    }
    throw err;
  }
  if (parsed && typeof parsed === 'object' && !parsed.sourcePath) {
    parsed.sourcePath = resolved;
  }
  return parsed;
}

function readV8ArchiveIfExists(filePath, sourcePath = null) {
  const resolved = normalizeArchivePath(filePath);
  if (!fs.existsSync(resolved)) return null;
  const parsed = v8.deserialize(fs.readFileSync(resolved));
  if (parsed && typeof parsed === 'object' && !parsed.sourcePath) {
    parsed.sourcePath = sourcePath ? normalizeArchivePath(sourcePath) : resolved.replace(/\.v8$/i, '');
  }
  return parsed;
}

function serializeArchiveOpeningRecord(item) {
  if (!item || typeof item !== 'object') return null;
  return {
    openingInstanceIds: Array.isArray(item.openingInstanceIds) ? item.openingInstanceIds.slice() : [],
    openingCodes: Array.isArray(item.openingCodes) ? item.openingCodes.slice() : [],
    opening: item.opening ?? null,
    opponentOpening: item.opponentOpening ?? null,
    seed: item.seed ?? 0,
    exactSearchBackend: item.exactSearchBackend ?? 'js',
    searchResult: getExactSearchApi().serializeSearchCoreResult(item.searchResult),
  };
}

function deserializeArchiveOpeningRecord(item) {
  if (!item || typeof item !== 'object') return null;
  return {
    openingInstanceIds: Array.isArray(item.openingInstanceIds) ? item.openingInstanceIds.slice() : [],
    openingCodes: Array.isArray(item.openingCodes) ? item.openingCodes.slice() : [],
    opening: item.opening ?? null,
    opponentOpening: item.opponentOpening ?? null,
    seed: item.seed ?? 0,
    exactSearchBackend: item.exactSearchBackend ?? 'js',
    searchResult: getExactSearchApi().deserializeSearchCoreResult(item.searchResult),
  };
}

function serializeArchiveCurrentOpening(item) {
  if (!item || typeof item !== 'object') return null;
  return {
    openingIndex: item.openingIndex ?? 0,
    openingInstanceIds: Array.isArray(item.openingInstanceIds) ? item.openingInstanceIds.slice() : [],
    openingCodes: Array.isArray(item.openingCodes) ? item.openingCodes.slice() : [],
    opening: item.opening ?? null,
    opponentOpening: item.opponentOpening ?? null,
    seed: item.seed ?? 0,
    exactSearchBackend: item.exactSearchBackend ?? 'js',
    resumeState: item.resumeState ?? null,
  };
}

function deserializeArchiveCurrentOpening(item) {
  if (!item || typeof item !== 'object') return null;
  return {
    openingIndex: item.openingIndex ?? 0,
    openingInstanceIds: Array.isArray(item.openingInstanceIds) ? item.openingInstanceIds.slice() : [],
    openingCodes: Array.isArray(item.openingCodes) ? item.openingCodes.slice() : [],
    opening: item.opening ?? null,
    opponentOpening: item.opponentOpening ?? null,
    seed: item.seed ?? 0,
    exactSearchBackend: item.exactSearchBackend ?? 'js',
    resumeState: item.resumeState ?? null,
  };
}

function serializeFullSearchResult(result) {
  if (!result || typeof result !== 'object') return null;
  return {
    searchResults: Array.isArray(result.searchResults)
      ? result.searchResults.map((item) => ({
          ...item,
          exportIndex: item.exportIndex ?? null,
          state: item.state ? serializeHistoryState(item.state) : null,
        }))
      : [],
    exploredOpenings: result.exploredOpenings ?? 0,
    totalNodes: result.totalNodes ?? 0,
    totalTerminals: result.totalTerminals ?? 0,
    truncated: !!result.truncated,
    exportItems: Array.isArray(result.exportItems)
      ? result.exportItems.map((item) => ({
          ...item,
          state: item.state ? serializeHistoryState(item.state) : null,
        }))
      : [],
  };
}

function deserializeFullSearchResult(result) {
  if (!result || typeof result !== 'object') return null;
  return {
    searchResults: Array.isArray(result.searchResults)
      ? result.searchResults.map((item) => ({
          ...item,
          state: item.state ? deserializeHistoryState(item.state) : null,
        }))
      : [],
    exploredOpenings: result.exploredOpenings ?? 0,
    totalNodes: result.totalNodes ?? 0,
    totalTerminals: result.totalTerminals ?? 0,
    truncated: !!result.truncated,
    exportItems: Array.isArray(result.exportItems)
      ? result.exportItems.map((item) => ({
          ...item,
          state: item.state ? deserializeHistoryState(item.state) : null,
        }))
      : [],
  };
}

function selectRequestedExportItems(fullResult, topKValue = null) {
  const exportItems = Array.isArray(fullResult?.exportItems) ? fullResult.exportItems : [];
  if (exportItems.length === 0) return [];
  const searchResults = Array.isArray(fullResult?.searchResults) ? fullResult.searchResults : [];
  const requestedTopK = normalizeRequestedTopK(
    topKValue ?? (searchResults.length > 0 ? searchResults.length : exportItems.length),
  );
  const selected = [];
  const seen = new Set();
  for (const result of searchResults.slice(0, requestedTopK)) {
    const exportIndex = Number(result?.exportIndex);
    if (!Number.isInteger(exportIndex) || exportIndex < 0 || exportIndex >= exportItems.length) {
      continue;
    }
    if (seen.has(exportIndex)) continue;
    seen.add(exportIndex);
    selected.push(exportItems[exportIndex]);
  }
  return selected.length > 0 ? selected : exportItems.slice(0, requestedTopK);
}

function buildWebSearchRequestSignature(payload) {
  return crypto.createHash('sha256').update(stableStringify({
    engineVersion: WEB_SEARCH_ENGINE_VERSION,
    payload,
  })).digest('hex');
}

function normalizeRequestedTopK(value) {
  return Math.max(1, toInt(value, DEFAULT_OPTIONS.topK));
}

function buildResumeCompatibleTopK(topK) {
  return Math.max(normalizeRequestedTopK(topK), WEB_SEARCH_RESUME_COMPATIBLE_TOPK);
}

function buildWebSearchCompatibilityPayload(params) {
  return {
    resourcePaths: {
      cardsPath: params.resourcePaths?.cardsPath ?? '',
      scriptsRoot: params.resourcePaths?.scriptsRoot ?? '',
    },
    drawCount: toInt(params.drawCount, DEFAULT_OPTIONS.drawCount),
    seed: toUInt32(params.seed, DEFAULT_OPTIONS.seed),
    maxNodes: toInt(params.maxNodes, DEFAULT_OPTIONS.maxNodes),
    maxDepth: toInt(params.maxDepth, DEFAULT_OPTIONS.maxDepth),
    targetTerminals: toInt(params.targetTerminals, 0),
    maxBeamWidth: Math.max(1, toInt(params.maxBeamWidth, DEFAULT_OPTIONS.maxBeamWidth)),
    maxActionsPerNode: toInt(params.maxActionsPerNode, DEFAULT_OPTIONS.maxActionsPerNode),
    snapshotPoolSize: toInt(params.snapshotPoolSize, DEFAULT_OPTIONS.snapshotPoolSize),
    engineBackend: String(params.engineBackend ?? 'auto'),
    exactSearchBackend: normalizeExactSearchBackend(params.exactSearchBackend ?? 'auto'),
    enumerateOpenings: !!params.enumerateOpenings,
    fixedOpeningInstanceIds: Array.isArray(params.fixedOpeningInstanceIds)
      ? params.fixedOpeningInstanceIds.map((item) => String(item))
      : [],
    yrpVersion: parseYrpVersion(params.yrpVersion, 2),
    playerDeck: params.playerDeck ?? null,
    opponentDeck: params.opponentDeck ?? null,
  };
}

function buildWebSearchCompatibilityPayloadFromArchive(archive) {
  const request = archive?.request ?? {};
  return buildWebSearchCompatibilityPayload({
    resourcePaths: {
      cardsPath:
        archive?.resourcePaths?.cardsPath
        ?? request.resourcePaths?.cardsPath
        ?? request.cardsPath
        ?? '',
      scriptsRoot:
        archive?.resourcePaths?.scriptsRoot
        ?? request.resourcePaths?.scriptsRoot
        ?? request.scriptsRoot
        ?? '',
    },
    drawCount: request.drawCount,
    seed: request.seed,
    maxNodes: request.maxNodes,
    maxDepth: request.maxDepth,
    targetTerminals: request.targetTerminals,
    maxBeamWidth: request.maxBeamWidth,
    maxActionsPerNode: request.maxActionsPerNode,
    snapshotPoolSize: request.snapshotPoolSize,
    engineBackend: request.engineBackend,
    exactSearchBackend: request.exactSearchBackend,
    enumerateOpenings: request.enumerateOpenings,
    fixedOpeningInstanceIds: request.fixedOpeningInstanceIds,
    yrpVersion: request.yrpVersion,
    playerDeck: request.playerDeck,
    opponentDeck: request.opponentDeck,
  });
}

function describeWebSearchArchiveCompatibility(archive, prepared, body = null) {
  const archivePayload = buildWebSearchCompatibilityPayloadFromArchive(archive);
  const requestPayload = prepared.signaturePayload;
  const archiveRequest = archive?.request ?? {};
  const fields = [
    ['drawCount', '抽卡数', archivePayload.drawCount, requestPayload.drawCount],
    ['seed', '随机种子', archivePayload.seed, requestPayload.seed],
    ['maxNodes', '最大节点数', archivePayload.maxNodes, requestPayload.maxNodes],
    ['maxDepth', '最大深度', archivePayload.maxDepth, requestPayload.maxDepth],
    ['targetTerminals', '目标终局数', archivePayload.targetTerminals, requestPayload.targetTerminals],
    ['maxBeamWidth', 'Beam 宽度', archivePayload.maxBeamWidth, requestPayload.maxBeamWidth],
    ['maxActionsPerNode', '每节点动作上限', archivePayload.maxActionsPerNode, requestPayload.maxActionsPerNode],
    ['snapshotPoolSize', '快照池大小', archivePayload.snapshotPoolSize, requestPayload.snapshotPoolSize],
    ['enumerateOpenings', '起手枚举模式', archivePayload.enumerateOpenings, requestPayload.enumerateOpenings],
    ['fixedOpeningInstanceIds', '固定起手', archivePayload.fixedOpeningInstanceIds, requestPayload.fixedOpeningInstanceIds],
    ['yrpVersion', '录像版本', archivePayload.yrpVersion, requestPayload.yrpVersion],
  ];
  if (body?.engineBackend !== undefined || Object.prototype.hasOwnProperty.call(archiveRequest, 'engineBackend')) {
    fields.push(['engineBackend', '搜索后端', archivePayload.engineBackend, requestPayload.engineBackend]);
  }
  if (
    body?.exactSearchBackend !== undefined
    || Object.prototype.hasOwnProperty.call(archiveRequest, 'exactSearchBackend')
  ) {
    fields.push(['exactSearchBackend', '精确搜索后端', archivePayload.exactSearchBackend, requestPayload.exactSearchBackend]);
  }
  if (body?.cardsPath || body?.resourceDir) {
    fields.push(['resourcePaths.cardsPath', 'cards.cdb 路径', archivePayload.resourcePaths.cardsPath, requestPayload.resourcePaths.cardsPath]);
  }
  if (body?.scriptsRoot || body?.resourceDir) {
    fields.push(['resourcePaths.scriptsRoot', '脚本目录', archivePayload.resourcePaths.scriptsRoot, requestPayload.resourcePaths.scriptsRoot]);
  }
  if (body?.deckText) {
    fields.push(['playerDeck', '我方卡组', archivePayload.playerDeck, requestPayload.playerDeck]);
  }
  if (body?.opponentDeckText || body?.deckText) {
    fields.push(['opponentDeck', '对方卡组', archivePayload.opponentDeck, requestPayload.opponentDeck]);
  }
  const mismatches = fields
    .filter(([key, , archiveValue, requestValue]) => {
      if (key === 'maxNodes') {
        const archiveNodes = Number(archiveValue ?? 0);
        const requestNodes = Number(requestValue ?? 0);
        return !Number.isFinite(archiveNodes) || !Number.isFinite(requestNodes) || requestNodes < archiveNodes;
      }
      return stableStringify(archiveValue) !== stableStringify(requestValue);
    })
    .map(([key, label]) => ({ key, label }));
  return {
    compatible: mismatches.length === 0,
    mismatches,
  };
}

function buildPreparedRequestFromArchive(prepared, archive, body = null) {
  const request = archive?.request ?? {};
  const requestedMaxNodes = toInt(body?.maxNodes, prepared.maxNodes);
  const effectiveMaxNodes = Math.max(
    toInt(request.maxNodes, prepared.maxNodes),
    requestedMaxNodes,
  );
  const resourcePaths = resolveResourcePaths({
    cardsPath:
      archive?.resourcePaths?.cardsPath
      ?? request.resourcePaths?.cardsPath
      ?? prepared.resourcePaths?.cardsPath,
    scriptsRoot:
      archive?.resourcePaths?.scriptsRoot
      ?? request.resourcePaths?.scriptsRoot
      ?? prepared.resourcePaths?.scriptsRoot,
  });
  const immutablePayload = buildWebSearchCompatibilityPayload({
    resourcePaths: {
      cardsPath: resourcePaths.cardsPath,
      scriptsRoot: resourcePaths.scriptsRoot,
    },
    drawCount: request.drawCount ?? prepared.drawCount,
    seed: request.seed ?? prepared.seed,
    maxNodes: effectiveMaxNodes,
    maxDepth: request.maxDepth ?? prepared.maxDepth,
    targetTerminals: request.targetTerminals ?? prepared.targetTerminals,
    maxBeamWidth: request.maxBeamWidth ?? prepared.maxBeamWidth,
    maxActionsPerNode: request.maxActionsPerNode ?? prepared.maxActionsPerNode,
    snapshotPoolSize: request.snapshotPoolSize ?? prepared.snapshotPoolSize,
    engineBackend: request.engineBackend ?? prepared.engineBackend,
    exactSearchBackend: request.exactSearchBackend ?? prepared.exactSearchBackend,
    enumerateOpenings:
      request.enumerateOpenings !== undefined ? !!request.enumerateOpenings : prepared.enumerateOpenings,
    fixedOpeningInstanceIds: request.fixedOpeningInstanceIds ?? prepared.fixedOpeningInstanceIds,
    yrpVersion: request.yrpVersion ?? prepared.yrpVersion,
    playerDeck: request.playerDeck ?? prepared.playerDeck,
    opponentDeck: request.opponentDeck ?? prepared.opponentDeck,
  });
  const requestedWorkers = Math.max(
    1,
    toInt(body?.workers ?? request.workers ?? prepared.workers ?? 1, 1),
  );
  return {
    ...prepared,
    resourcePaths,
    drawCount: immutablePayload.drawCount,
    seed: immutablePayload.seed,
    maxNodes: immutablePayload.maxNodes,
    maxDepth: immutablePayload.maxDepth,
    targetTerminals: immutablePayload.targetTerminals,
    maxBeamWidth: immutablePayload.maxBeamWidth,
    maxActionsPerNode: immutablePayload.maxActionsPerNode,
    snapshotPoolSize: immutablePayload.snapshotPoolSize,
    engineBackend: immutablePayload.engineBackend,
    exactSearchBackend: immutablePayload.exactSearchBackend,
    enumerateOpenings: immutablePayload.enumerateOpenings,
    fixedOpeningInstanceIds: immutablePayload.fixedOpeningInstanceIds,
    yrpVersion: immutablePayload.yrpVersion,
    playerDeck: immutablePayload.playerDeck,
    opponentDeck: immutablePayload.opponentDeck,
    workers:
      immutablePayload.exactSearchBackend === 'parallel-js'
        ? requestedWorkers
        : 1,
    topK: normalizeRequestedTopK(body?.topK ?? body?.topP ?? body?.topp ?? prepared.topK),
    scoringRules: normalizeScoringRules(body?.scoringRules ?? prepared.scoringRules),
    signaturePayload: immutablePayload,
    requestSignature: buildWebSearchRequestSignature(immutablePayload),
    archivePath: archive?.sourcePath ?? prepared.archivePath,
  };
}

function resolveRequestedWebArchivePath(body) {
  const candidates = [
    body?.resumeArchivePath,
    body?.loadedArchivePath,
    body?.archivePath,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return resolveArchivePathCandidate(candidate);
    }
  }
  return null;
}

function resolveRequestedWebArchiveDocument(body) {
  const rawArchive = body?.archive ?? body?.loadedArchive ?? body?.loadedArchiveText ?? null;
  if (!rawArchive) return null;
  let archive = typeof rawArchive === 'string' ? JSON.parse(rawArchive) : rawArchive;
  if (!archive || typeof archive !== 'object') {
    throw new Error('加载的存档内容无效');
  }
  const requestedArchivePath = resolveRequestedWebArchivePath(body);
  if (requestedArchivePath && fs.existsSync(requestedArchivePath)) {
    archive = readBestWebArchiveVariant(requestedArchivePath, archive.requestSignature ?? null) ?? archive;
    archive.sourcePath = requestedArchivePath;
  } else if (typeof archive.sourcePath === 'string' && archive.sourcePath.trim()) {
    const resolvedSourcePath = normalizeArchivePath(archive.sourcePath.trim());
    if (fs.existsSync(resolvedSourcePath)) {
      archive = readBestWebArchiveVariant(resolvedSourcePath, archive.requestSignature ?? null) ?? archive;
      archive.sourcePath = resolvedSourcePath;
    } else {
      delete archive.sourcePath;
    }
  }
  return archive;
}

function resolveWebArchiveForPreparedRequest(body, prepared) {
  const embeddedArchive = resolveRequestedWebArchiveDocument(body);
  if (embeddedArchive) {
    if (isAutoFinalizedWebArchive(embeddedArchive)) {
      throw new Error('所选存档来自旧版自动收尾结果，不能继续断点续传');
    }
    const compatibility = describeWebSearchArchiveCompatibility(embeddedArchive, prepared, body);
    if (!compatibility.compatible) {
      throw new Error(
        `所选存档与当前参数不兼容；允许修改评分规则、TopP/TopK，并允许增大最大节点数。不同项: ${compatibility.mismatches.map((item) => item.label).join('、')}`,
      );
    }
    const effectivePrepared = buildPreparedRequestFromArchive(prepared, embeddedArchive, body);
    return {
      archivePath: embeddedArchive.sourcePath ?? effectivePrepared.archivePath,
      archive: embeddedArchive,
      prepared: effectivePrepared,
      explicit: true,
      compatibility,
    };
  }
  const explicitArchivePath = resolveRequestedWebArchivePath(body);
  if (explicitArchivePath) {
    const archive =
      readBestWebArchiveVariant(explicitArchivePath, prepared.requestSignature ?? null) ??
      readBestWebArchiveVariant(explicitArchivePath, null);
    if (!archive) {
      const autoPath = buildWebArchivePath(prepared.requestSignature);
      if (normalizeArchivePath(explicitArchivePath) === normalizeArchivePath(autoPath)) {
        // archivePath 是当前签名的自动路径，存档尚未创建属于正常情况，走 fallthrough
      } else {
        throw new Error(`存档不存在: ${explicitArchivePath}`);
      }
    } else {
      if (isAutoFinalizedWebArchive(archive)) {
        throw new Error('所选存档来自旧版自动收尾结果，不能继续断点续传');
      }
      const compatibility = describeWebSearchArchiveCompatibility(archive, prepared, body);
      if (!compatibility.compatible) {
        throw new Error(
          `所选存档与当前参数不兼容；允许修改评分规则、TopP/TopK，并允许增大最大节点数。不同项: ${compatibility.mismatches.map((item) => item.label).join('、')}`,
        );
      }
      return {
        archivePath: explicitArchivePath,
        archive,
        prepared: buildPreparedRequestFromArchive(prepared, archive, body),
        explicit: true,
        compatibility,
      };
    }
  }
  const existing = loadWebArchiveForSignature(prepared.requestSignature);
  return {
    archivePath: existing?.archivePath ?? prepared.archivePath,
    archive: existing?.archive ?? null,
    prepared,
    explicit: false,
    compatibility: null,
  };
}

function prepareWebSearchRequest(body) {
  const resourcePaths = resolveResourcePaths(body);
  assertFileExists(resourcePaths.cardsPath, 'cards.cdb');
  if (resourcePaths.scriptDirs.length === 0) {
    throw new Error(`脚本目录无效: ${resourcePaths.scriptsRoot}`);
  }
  const drawCount = toInt(body.drawCount, DEFAULT_OPTIONS.drawCount);
  const maxDepth = toInt(body.maxDepth, DEFAULT_OPTIONS.maxDepth);
  const maxNodes = toInt(body.maxNodes, DEFAULT_OPTIONS.maxNodes);
  const topK = normalizeRequestedTopK(body.topK ?? body.topP ?? body.topp);
  const seed = toUInt32(body.seed, DEFAULT_OPTIONS.seed);
  const targetTerminals = toInt(body.targetTerminals, 0);
  const maxBeamWidth = Math.max(1, toInt(body.maxBeamWidth, DEFAULT_OPTIONS.maxBeamWidth));
  const maxActionsPerNode = toInt(body.maxActionsPerNode, DEFAULT_OPTIONS.maxActionsPerNode);
  const snapshotPoolSize = toInt(body.snapshotPoolSize, DEFAULT_OPTIONS.snapshotPoolSize);
  // Keep Web UI progress independent from huge maxNodes; large batches make live searches look stalled.
  const progressEvery = Math.max(1, toInt(body.progressEvery, 200));
  const requestedWorkers = Math.max(1, toInt(body.workers, WEB_DEFAULT_WORKERS));
  const requestedEngineBackend = String(body.engineBackend ?? 'auto').toLowerCase();
  const requestedExactSearchBackend = normalizeExactSearchBackend(body.exactSearchBackend ?? 'auto');
  const requestedSnapshotAccelMode = String(
    body.snapshotAccelMode ?? WEB_DEFAULT_SNAPSHOT_ACCEL_MODE,
  ).toLowerCase();
  const requestedSnapshotStorageMode = String(
    body.snapshotStorageMode ?? WEB_DEFAULT_SNAPSHOT_STORAGE_MODE,
  ).toLowerCase();
  if (!['auto', 'cpu', 'gpu'].includes(requestedSnapshotAccelMode)) {
    throw new Error(`snapshotAccelMode 无效: ${requestedSnapshotAccelMode}`);
  }
  if (!['delta', 'full'].includes(requestedSnapshotStorageMode)) {
    throw new Error(`snapshotStorageMode 无效: ${requestedSnapshotStorageMode}`);
  }
  const snapshotAccelModeForRequest =
    requestedSnapshotAccelMode === 'auto' ? 'gpu' : requestedSnapshotAccelMode;
  const { engineBackend, exactSearchBackend } = resolveExactSearchBackend({
    requestedEngineBackend,
    requestedExactSearchBackend,
    requestedWorkers,
  });
  const enumerateOpenings = !!body.enumerateOpenings;
  const fixedOpeningInstanceIds = Array.isArray(body.fixedOpeningInstanceIds)
    ? body.fixedOpeningInstanceIds.map((item) => String(item))
    : [];
  const scoringRules = normalizeScoringRules(body.scoringRules);
  const yrpVersion = parseYrpVersion(body.yrpVersion, 2);
  const playerDeck = body.deckText
    ? parseYdkText(String(body.deckText))
    : (() => {
        assertFileExists(resourcePaths.deckPath, 'deck');
        return parseYdk(resourcePaths.deckPath);
      })();
  const opponentDeck = body.opponentDeckText
    ? parseYdkText(String(body.opponentDeckText))
    : body.deckText
      ? playerDeck
      : (() => {
          assertFileExists(resourcePaths.opponentDeckPath, 'opponent deck');
          return parseYdk(resourcePaths.opponentDeckPath);
        })();
  const signaturePayload = buildWebSearchCompatibilityPayload({
    resourcePaths: {
      cardsPath: resourcePaths.cardsPath,
      scriptsRoot: resourcePaths.scriptsRoot,
    },
    drawCount,
    seed,
    maxNodes,
    maxDepth,
    targetTerminals,
    maxBeamWidth,
    maxActionsPerNode,
    snapshotPoolSize,
    engineBackend,
    exactSearchBackend,
    workers: exactSearchBackend === 'parallel-js' ? requestedWorkers : 1,
    enumerateOpenings,
    fixedOpeningInstanceIds,
    yrpVersion,
    playerDeck,
    opponentDeck,
  });
  const requestSignature = buildWebSearchRequestSignature(signaturePayload);
  return {
    resourcePaths,
    drawCount,
    maxDepth,
    maxNodes,
    topK,
    seed,
    targetTerminals,
    maxBeamWidth,
    maxActionsPerNode,
    snapshotPoolSize,
    engineBackend,
    exactSearchBackend,
    workers: exactSearchBackend === 'parallel-js' ? requestedWorkers : 1,
    snapshotAccelMode: snapshotAccelModeForRequest,
    snapshotStorageMode: requestedSnapshotStorageMode,
    progressEvery,
    checkpointEvery: WEB_ARCHIVE_CHECKPOINT_NODES,
    enumerateOpenings,
    fixedOpeningInstanceIds,
    scoringRules,
    yrpVersion,
    playerDeck,
    opponentDeck,
    requestSignature,
    archivePath: buildWebArchivePath(requestSignature),
    signaturePayload,
  };
}

function buildWebExecutionPathMeta(prepared = {}) {
  return {
    engineBackend: prepared.engineBackend ?? 'wasm',
    exactSearchBackend: prepared.exactSearchBackend ?? 'js',
    workers: Math.max(1, Number(prepared.workers ?? 1) || 1),
    snapshotAccelMode: prepared.snapshotAccelMode ?? snapshotState.getSnapshotAccelMode(),
    snapshotStorageMode: prepared.snapshotStorageMode ?? snapshotState.getSnapshotStorageMode(),
  };
}

function loadWebArchiveForSignature(signature) {
  const archivePath = buildWebArchivePath(signature);
  const archive = readBestWebArchiveVariant(archivePath, signature);
  return archive ? { archivePath, archive } : null;
}

function buildWebArchiveDocument(params) {
  return {
    schemaVersion: WEB_ARCHIVE_SCHEMA_VERSION,
    jobId: params.jobId,
    status: params.status,
    requestSignature: params.requestSignature,
    request: params.request,
    resourcePaths: params.resourcePaths,
    progress: params.progress,
    completedOpenings: Array.isArray(params.completedOpenings)
      ? params.completedOpenings.map(serializeArchiveOpeningRecord).filter(Boolean)
      : [],
    currentOpening: params.currentOpening ? serializeArchiveCurrentOpening(params.currentOpening) : null,
    finalResult: params.finalResult ? serializeFullSearchResult(params.finalResult) : null,
    sourcePath: params.sourcePath ?? null,
    checkpointWatermark: Number(params.checkpointWatermark ?? 0),
    updatedAt: new Date().toISOString(),
  };
}

function normalizeWebArchiveProgressForClient(archive) {
  if (!archive || typeof archive !== 'object') return null;
  const baseProgress = archive.progress && typeof archive.progress === 'object'
    ? archive.progress
    : null;
  if (!baseProgress) return null;
  if (archive.status !== 'partial') return baseProgress;
  const resumeBestNodes = Number(archive.currentOpening?.resumeState?.best?.nodes ?? 0);
  if (!Number.isFinite(resumeBestNodes) || resumeBestNodes <= 0) return baseProgress;
  const originalTotalNodes = Number(baseProgress.totalNodes ?? 0);
  if (originalTotalNodes === resumeBestNodes) return baseProgress;
  logTerminal('warn', 'web-search', 'archive-progress-totalNodes-rewritten-to-best', {
    archivePath: archive.sourcePath ?? null,
    originalTotalNodes,
    originalCheckpointNodes: Number(baseProgress.checkpointNodes ?? 0),
    resumeBestNodes,
  });
  return {
    ...baseProgress,
    totalNodes: resumeBestNodes,
    checkpointNodes: resumeBestNodes,
  };
}

function buildWebArchiveClientSummary(archive) {
  if (!archive || typeof archive !== 'object') return null;
  const currentOpening = archive.currentOpening && typeof archive.currentOpening === 'object'
    ? archive.currentOpening
    : null;
  const resumeState = currentOpening?.resumeState && typeof currentOpening.resumeState === 'object'
    ? currentOpening.resumeState
    : null;
  const summarizeSearchResult = (item) => {
    if (!item || typeof item !== 'object') return null;
    return {
      openingCodes: Array.isArray(item.openingCodes) ? item.openingCodes.slice() : [],
      depth: Number(item.depth ?? 0),
      score: Number(item.score ?? 0),
      chain: Array.isArray(item.chain) ? item.chain.slice() : [],
      snapshot: item.snapshot ?? null,
    };
  };
  return {
    schemaVersion: archive.schemaVersion ?? WEB_ARCHIVE_SCHEMA_VERSION,
    jobId: archive.jobId ?? null,
    status: archive.status ?? '',
    requestSignature: archive.requestSignature ?? null,
    request: archive.request ?? null,
    resourcePaths: archive.resourcePaths ?? null,
    progress: normalizeWebArchiveProgressForClient(archive),
    completedOpenings: [],
    currentOpening: currentOpening
      ? {
          openingIndex: currentOpening.openingIndex ?? 0,
          openingCodes: Array.isArray(currentOpening.openingCodes) ? currentOpening.openingCodes.slice() : [],
          seed: currentOpening.seed ?? 0,
          exactSearchBackend: currentOpening.exactSearchBackend ?? null,
          resumeState: resumeState
            ? {
                resumeKind: resumeState.resumeKind ?? null,
                pendingShards: Array.isArray(resumeState.pendingShards) ? resumeState.pendingShards.length : 0,
                completedResults: Array.isArray(resumeState.completedResults) ? resumeState.completedResults.length : 0,
                bestNodes: Number(resumeState.best?.nodes ?? 0),
                bestTerminals: Number(resumeState.best?.terminalCount ?? 0),
              }
            : null,
        }
      : null,
    finalResult: archive.finalResult
      ? {
          exploredOpenings: archive.finalResult.exploredOpenings ?? archive.progress?.exploredOpenings ?? 0,
          totalNodes: archive.finalResult.totalNodes ?? archive.progress?.totalNodes ?? 0,
          totalTerminals: archive.finalResult.totalTerminals ?? archive.progress?.totalTerminals ?? 0,
          truncated: !!archive.finalResult.truncated,
          searchResults: Array.isArray(archive.finalResult.searchResults)
            ? archive.finalResult.searchResults.slice(0, 20).map(summarizeSearchResult).filter(Boolean)
            : [],
        }
      : null,
    sourcePath: archive.sourcePath ?? null,
    checkpointWatermark: Number(archive.checkpointWatermark ?? 0),
    updatedAt: archive.updatedAt ?? null,
  };
}

function getWebArchiveCheckpointNodeValue(archive) {
  if (!archive || typeof archive !== 'object') return 0;
  const currentOpening = deserializeArchiveCurrentOpening(archive.currentOpening);
  const resumeNodes = Number(currentOpening?.resumeState?.best?.nodes ?? 0);
  const checkpointNodes = Number(archive.progress?.checkpointNodes ?? 0);
  const totalNodes = Number(archive.progress?.totalNodes ?? 0);
  return Math.max(
    Number.isFinite(resumeNodes) ? resumeNodes : 0,
    Number.isFinite(checkpointNodes) ? checkpointNodes : 0,
    Number.isFinite(totalNodes) ? totalNodes : 0,
  );
}

function compareWebArchivePriority(a, b) {
  const aWatermark = getWebArchiveCheckpointNodeValue(a);
  const bWatermark = getWebArchiveCheckpointNodeValue(b);
  if (aWatermark !== bWatermark) return aWatermark - bWatermark;
  const aUpdatedAt = Date.parse(a?.updatedAt ?? '') || 0;
  const bUpdatedAt = Date.parse(b?.updatedAt ?? '') || 0;
  if (aUpdatedAt !== bUpdatedAt) return aUpdatedAt - bUpdatedAt;
  const aStatus = String(a?.status ?? '');
  const bStatus = String(b?.status ?? '');
  if (aStatus !== bStatus) {
    const rank = (value) => (
      value === 'completed' ? 3 :
      value === 'truncated' ? 2 :
      value === 'partial' ? 1 : 0
    );
    return rank(aStatus) - rank(bStatus);
  }
  return 0;
}

function readBestWebArchiveVariant(archivePath, requestSignature = null) {
  if (!archivePath) return null;
  const primaryPath = resolveArchivePathCandidate(archivePath);
  const backupPath = buildWebArchiveBackupPath(primaryPath);
  const binaryCandidates = [
    readV8ArchiveIfExists(buildWebArchiveBinaryPath(primaryPath), primaryPath),
    readV8ArchiveIfExists(buildWebArchiveBinaryPath(backupPath), primaryPath),
  ]
    .filter(Boolean)
    .filter((archive) => !requestSignature || archive.requestSignature === requestSignature);
  const candidates = binaryCandidates.length > 0
    ? binaryCandidates
    : [readJsonIfExists(primaryPath), readJsonIfExists(backupPath)]
      .filter(Boolean)
      .filter((archive) => !requestSignature || archive.requestSignature === requestSignature);
  if (candidates.length === 0) return null;
  let best = candidates[0];
  for (let index = 1; index < candidates.length; index += 1) {
    if (compareWebArchivePriority(best, candidates[index]) < 0) {
      best = candidates[index];
    }
  }
  return best;
}

function writeWebArchiveDocumentMonotonic(archivePath, archiveDocument, options = {}) {
  if (!WEB_ARCHIVE_ENABLED) return null;
  if (!archivePath || !archiveDocument) return null;
  const resolved = normalizeArchivePath(archivePath);
  const backupPath = buildWebArchiveBackupPath(resolved);
  const binaryPath = buildWebArchiveBinaryPath(resolved);
  const binaryBackupPath = buildWebArchiveBinaryPath(backupPath);
  const writeStartedAtMs = Date.now();
  const isPartialCheckpoint = archiveDocument.status === 'partial';
  const previousBest = isPartialCheckpoint
    ? null
    : readBestWebArchiveVariant(resolved, archiveDocument.requestSignature ?? null);
  const nextWatermark = getWebArchiveCheckpointNodeValue(archiveDocument);
  const previousWatermark = getWebArchiveCheckpointNodeValue(previousBest);
  if (previousBest && compareWebArchivePriority(previousBest, archiveDocument) > 0) {
    if (options.logRegression !== false) {
      logTerminal('warn', 'web-search', 'checkpoint-regression-skipped', {
        archivePath: resolved,
        existingCheckpointNodes: previousWatermark,
        nextCheckpointNodes: nextWatermark,
        existingUpdatedAt: previousBest?.updatedAt ?? null,
        nextStatus: archiveDocument.status ?? null,
      });
    }
    return {
      written: false,
      reason: 'regression-skipped',
      archive: previousBest,
      archivePath: previousBest?.sourcePath ?? resolved,
      checkpointWatermark: previousWatermark,
    };
  }
  const enriched = {
    ...archiveDocument,
    sourcePath: resolved,
    checkpointWatermark: nextWatermark,
  };
  if (isPartialCheckpoint) {
    writeV8ArchiveAtomic(binaryPath, enriched);
    if (options.logWrite !== false) {
      logTerminal('info', 'web-search', 'checkpoint-write-accepted', {
        archivePath: resolved,
        checkpointWatermark: nextWatermark,
        previousCheckpointWatermark: previousWatermark,
        status: enriched.status ?? null,
        updatedAt: enriched.updatedAt ?? null,
        writeElapsedMs: Date.now() - writeStartedAtMs,
        fastPartial: true,
      });
    }
    return {
      written: true,
      reason: 'written',
      archive: enriched,
      archivePath: resolved,
      checkpointWatermark: nextWatermark,
    };
  }
  if (previousBest && previousWatermark > 0) {
    const backupArchive = {
      ...previousBest,
      sourcePath: resolved,
      checkpointWatermark: previousWatermark,
    };
    writeV8ArchiveAtomic(binaryBackupPath, backupArchive);
    if (backupArchive.status !== 'partial') {
      try {
        writeJsonAtomic(backupPath, backupArchive);
      } catch (err) {
        if (err?.code !== 'ERR_STRING_TOO_LONG') throw err;
        logTerminal('warn', 'web-search', 'archive-json-backup-too-large', {
          archivePath: backupPath,
          binaryPath: binaryBackupPath,
          error: err.message,
        });
      }
    }
  }
  writeV8ArchiveAtomic(binaryPath, enriched);
  if (enriched.status !== 'partial') {
    try {
      writeJsonAtomic(resolved, enriched);
    } catch (err) {
      if (err?.code !== 'ERR_STRING_TOO_LONG') throw err;
      logTerminal('warn', 'web-search', 'archive-json-too-large-written-binary', {
        archivePath: resolved,
        binaryPath,
        checkpointWatermark: nextWatermark,
        error: err.message,
      });
    }
  }
  if (options.mirrorToBackup === true) {
    writeV8ArchiveAtomic(binaryBackupPath, enriched);
    if (enriched.status !== 'partial') {
      try {
        writeJsonAtomic(backupPath, enriched);
      } catch (err) {
        if (err?.code !== 'ERR_STRING_TOO_LONG') throw err;
        logTerminal('warn', 'web-search', 'archive-json-backup-too-large', {
          archivePath: backupPath,
          binaryPath: binaryBackupPath,
          error: err.message,
        });
      }
    }
  }
  if (options.logWrite !== false) {
    logTerminal('info', 'web-search', 'checkpoint-write-accepted', {
      archivePath: resolved,
      checkpointWatermark: nextWatermark,
      previousCheckpointWatermark: previousWatermark,
      status: enriched.status ?? null,
      updatedAt: enriched.updatedAt ?? null,
      writeElapsedMs: Date.now() - writeStartedAtMs,
    });
  }
  return {
    written: true,
    reason: 'written',
    archive: enriched,
    archivePath: resolved,
    checkpointWatermark: nextWatermark,
  };
}

function appendJobLog(job, message) {
  if (!job || !message) return;
  job.logs.push(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${message}`);
  if (job.logs.length > 200) {
    job.logs.splice(0, job.logs.length - 200);
  }
}

function logTerminal(level, source, message, detail = null) {
  const normalizedSource = String(source || 'server');
  const normalizedMessage = String(message || '');
  if (process.env.COMBO_LOG_WEB_UI_NOISE !== '1') {
    const shouldSuppress =
      (normalizedSource === 'http' && (
        normalizedMessage.includes('/api/card-image/') ||
        normalizedMessage.includes('/api/client-log') ||
        normalizedMessage.includes('/api/search/status')
      )) ||
      (normalizedSource === 'web-ui' && [
        'load-deck-clicked',
        'deck-loaded',
        'run-search-clicked',
        'search-progress',
      ].includes(normalizedMessage));
    if (shouldSuppress) return;
  }
  const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const head = `[${timestamp}][${String(level || 'info').toUpperCase()}][${normalizedSource}] ${normalizedMessage}`;
  if (detail == null) {
    console.log(head);
    return;
  }
  try {
    console.log(`${head} ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  } catch {
    console.log(head);
  }
}

async function executeWebSearch(body, onProgress = null) {
  const prepared = prepareWebSearchRequest(body);
  const {
    resourcePaths,
    drawCount,
    maxDepth,
    maxNodes,
    topK,
    seed,
    targetTerminals,
    maxBeamWidth,
    maxActionsPerNode,
    snapshotPoolSize,
    engineBackend,
    exactSearchBackend,
    workers,
    progressEvery,
    enumerateOpenings,
    fixedOpeningInstanceIds,
    scoringRules,
    yrpVersion,
    playerDeck,
    opponentDeck,
    requestSignature,
  } = prepared;
  const archiveResolution = resolveWebArchiveForPreparedRequest(body, prepared);
  const effectivePrepared = archiveResolution.prepared ?? prepared;
  const archivePath = archiveResolution.archivePath;
  const existingArchive = isAutoFinalizedWebArchive(archiveResolution.archive) ? null : archiveResolution.archive;
  const effectiveResourcePaths = effectivePrepared.resourcePaths;
  const effectiveDrawCount = effectivePrepared.drawCount;
  const effectiveMaxDepth = effectivePrepared.maxDepth;
  const effectiveMaxNodes = effectivePrepared.maxNodes;
  const effectiveTopK = effectivePrepared.topK;
  const effectiveSeed = effectivePrepared.seed;
  const effectiveTargetTerminals = effectivePrepared.targetTerminals;
  const effectiveMaxBeamWidth = effectivePrepared.maxBeamWidth;
  const effectiveMaxActionsPerNode = effectivePrepared.maxActionsPerNode;
  const effectiveSnapshotPoolSize = effectivePrepared.snapshotPoolSize;
  const effectiveEngineBackend = effectivePrepared.engineBackend;
  const effectiveExactSearchBackend = effectivePrepared.exactSearchBackend;
  const effectiveWorkers = Math.max(1, effectivePrepared.workers ?? 1);
  const effectiveSnapshotAccelMode = effectivePrepared.snapshotAccelMode ?? snapshotState.getSnapshotAccelMode();
  const effectiveSnapshotStorageMode = effectivePrepared.snapshotStorageMode ?? snapshotState.getSnapshotStorageMode();
  const effectiveProgressEvery = effectivePrepared.progressEvery;
  const effectiveEnumerateOpenings = effectivePrepared.enumerateOpenings;
  const effectiveFixedOpeningInstanceIds = effectivePrepared.fixedOpeningInstanceIds;
  const effectiveScoringRules = effectivePrepared.scoringRules;
  const effectiveYrpVersion = effectivePrepared.yrpVersion;
  const effectivePlayerDeck = effectivePrepared.playerDeck;
  const effectiveOpponentDeck = effectivePrepared.opponentDeck;
  const effectiveRequestSignature = effectivePrepared.requestSignature;
  const effectiveCheckpointEvery = Math.max(
    1,
    Number(effectivePrepared.checkpointEvery ?? WEB_ARCHIVE_CHECKPOINT_NODES) || WEB_ARCHIVE_CHECKPOINT_NODES,
  );
  const executionPath = buildWebExecutionPathMeta(effectivePrepared);
  const normalizedArchivePath = archivePath ? normalizeArchivePath(archivePath) : null;
  const existingSourcePath =
    typeof existingArchive?.sourcePath === 'string' && existingArchive.sourcePath.trim()
      ? normalizeArchivePath(existingArchive.sourcePath.trim())
      : '';
  if (existingArchive) {
    logTerminal('info', 'web-search', 'resume-archive-selected', {
      archivePath: existingArchive.sourcePath ?? normalizedArchivePath ?? archivePath ?? null,
      status: existingArchive.status ?? null,
      checkpointWatermark: getWebArchiveCheckpointNodeValue(existingArchive),
      totalNodes: Number(existingArchive.progress?.totalNodes ?? 0),
      checkpointNodes: Number(existingArchive.progress?.checkpointNodes ?? 0),
      openingIndex: existingArchive.currentOpening?.openingIndex ?? -1,
      exactSearchBackend: existingArchive.currentOpening?.exactSearchBackend ?? null,
      resumeKind: existingArchive.currentOpening?.resumeState?.resumeKind ?? null,
      completedOpenings: Array.isArray(existingArchive.completedOpenings) ? existingArchive.completedOpenings.length : 0,
      completedResults: existingArchive.currentOpening?.resumeState?.completedResults?.length ?? 0,
      pendingShards: existingArchive.currentOpening?.resumeState?.pendingShards?.length ?? 0,
      checkpointEvery: effectiveCheckpointEvery,
    });
  }
  if (
    existingArchive
    && normalizedArchivePath
    && (!existingSourcePath || existingSourcePath !== normalizedArchivePath)
  ) {
    writeWebArchiveDocumentMonotonic(normalizedArchivePath, {
      ...existingArchive,
      requestSignature: effectiveRequestSignature,
      sourcePath: normalizedArchivePath,
      checkpointWatermark: getWebArchiveCheckpointNodeValue(existingArchive),
    });
  }
  const cardRuntime = await createCardTextRuntime(effectiveResourcePaths.cardsPath);
  try {
    const playerDeckInstances = createDeckCardInstances(effectivePlayerDeck, cardRuntime.cardText);
    const deckView = createDeckView(playerDeckInstances);
    const fixedOpeningDebugCards = (effectiveFixedOpeningInstanceIds ?? [])
      .map((instanceId) => {
        const card = playerDeckInstances.main.find((item) => item.instanceId === String(instanceId));
        return card
          ? {
              instanceId: card.instanceId,
              code: card.code >>> 0,
              name: card.name ?? '',
              ordinal: card.ordinal ?? 0,
            }
          : { instanceId: String(instanceId), missing: true };
      });
    logTerminal('info', 'web-search', 'search-start-resolved-request', {
      requestSignature: effectiveRequestSignature,
      deckPath: effectivePrepared.deckPath ?? '',
      deckName: effectivePrepared.deckName ?? '',
      mainDeckCount: effectivePlayerDeck.main.length,
      extraDeckCount: effectivePlayerDeck.extra.length,
      fixedOpeningInstanceIds: effectiveFixedOpeningInstanceIds,
      fixedOpeningCodes: fixedOpeningDebugCards
        .map((card) => card.code)
        .filter((code) => Number.isFinite(code)),
      fixedOpeningCards: fixedOpeningDebugCards,
      enumerateOpenings: effectiveEnumerateOpenings,
    });
    const searchStartedAtMs = Date.now();
    const searchStartedNs = process.hrtime.bigint();
    const search = await runExhaustiveOpeningSearch({
      resourcePaths: effectiveResourcePaths,
      seed: effectiveSeed,
      drawCount: effectiveDrawCount,
      maxDepth: effectiveMaxDepth,
      maxNodes: effectiveMaxNodes,
      targetTerminals: effectiveTargetTerminals,
      maxBeamWidth: effectiveMaxBeamWidth,
      maxActionsPerNode: effectiveMaxActionsPerNode,
      snapshotPoolSize: effectiveSnapshotPoolSize,
      topK: effectiveTopK,
      expandScriptKeywords: parseKeywordList(body.expandScriptKeywords),
      yrpVersion: effectiveYrpVersion,
      playerDeck: effectivePlayerDeck,
      opponentDeck: effectiveOpponentDeck,
      playerDeckInstances,
      fixedOpeningInstanceIds: effectiveFixedOpeningInstanceIds,
      scoringRules: effectiveScoringRules,
      enumerateOpenings: effectiveEnumerateOpenings,
      engineBackend: effectiveEngineBackend,
      exactSearchBackend: effectiveExactSearchBackend,
      workers: effectiveWorkers,
      snapshotAccelMode: effectiveSnapshotAccelMode,
      snapshotStorageMode: effectiveSnapshotStorageMode,
      searchStartedAtMs,
      verbose: false,
      onProgress: typeof onProgress === 'function'
        ? (progress) => {
            onProgress({
              ...progress,
              ...executionPath,
              startedAtMs: searchStartedAtMs,
            });
          }
        : null,
      progressEvery: effectiveProgressEvery,
      checkpointEvery: effectiveCheckpointEvery,
      archivePath,
      requestSignature: effectiveRequestSignature,
      resumeArchive: existingArchive,
      onArchiveUpdate: (payload) => {
        const nextArchiveDocument = buildWebArchiveDocument({
          jobId: body.__jobId ?? `worker-${Date.now()}`,
          status: payload.status,
          requestSignature: effectiveRequestSignature,
          request: {
            drawCount: effectiveDrawCount,
            seed: effectiveSeed,
            maxNodes: effectiveMaxNodes,
            maxDepth: effectiveMaxDepth,
            targetTerminals: effectiveTargetTerminals,
            topK: effectiveTopK,
            engineBackend: effectiveEngineBackend,
            exactSearchBackend: effectiveExactSearchBackend,
            workers: effectiveWorkers,
            enumerateOpenings: effectiveEnumerateOpenings,
            fixedOpeningInstanceIds: effectiveFixedOpeningInstanceIds,
            scoringRules: effectiveScoringRules,
            yrpVersion: effectiveYrpVersion,
            playerDeck: effectivePlayerDeck,
            opponentDeck: effectiveOpponentDeck,
          },
          resourcePaths: {
            cardsPath: effectiveResourcePaths.cardsPath,
            scriptsRoot: effectiveResourcePaths.scriptsRoot,
          },
          progress: payload.progress,
          completedOpenings: payload.completedOpenings,
          currentOpening: payload.currentOpening,
          finalResult: payload.finalResult,
          sourcePath: archivePath,
          checkpointWatermark: Math.max(
            Number(payload.progress?.checkpointNodes ?? 0),
            Number(payload.progress?.totalNodes ?? 0),
          ),
        });
        writeWebArchiveDocumentMonotonic(archivePath, nextArchiveDocument);
      },
    });
    const searchElapsedMs = Number(process.hrtime.bigint() - searchStartedNs) / 1e6;
    return {
      deck: deckView,
      scoringRules: effectiveScoringRules,
      requestSignature: effectiveRequestSignature,
      archivePath,
      archiveStatus: search.truncated ? 'truncated' : 'completed',
      resumedFromArchive: !!existingArchive && (
        existingArchive.status === 'partial' ||
        shouldResumeTruncatedWebArchive(existingArchive, effectivePrepared)
      ),
      executionPath,
      startedAtMs: searchStartedAtMs,
      searchElapsedMs,
      ...search,
    };
  } finally {
    cardRuntime.db.close();
  }
}

function createPublicWebResult(fullResult) {
  if (!fullResult) return null;
  const { exportItems, ...rest } = fullResult;
  const visibleExportItems = selectRequestedExportItems(fullResult, rest.searchResults?.length ?? null);
  return {
    ...rest,
    exportableCount: visibleExportItems.length,
  };
}

async function exportWebSearchJobResults(job, outputDirArg = null) {
  const body = job.requestBody ?? {};
  const exportItems = selectRequestedExportItems(
    job?.fullResult,
    body.topK ?? body.topP ?? body.topp,
  );
  if (!exportItems.length) {
    throw new Error('当前搜索结果没有可导出的录像');
  }
  const resourcePaths = resolveResourcePaths(body);
  assertFileExists(resourcePaths.cardsPath, 'cards.cdb');
  if (resourcePaths.scriptDirs.length === 0) {
    throw new Error(`脚本目录无效: ${resourcePaths.scriptsRoot}`);
  }
  const drawCount = toInt(body.drawCount, DEFAULT_OPTIONS.drawCount);
  const yrpVersion = parseYrpVersion(body.yrpVersion, 2);
  const playerDeck = body.deckText
    ? parseYdkText(String(body.deckText))
    : (() => {
        assertFileExists(resourcePaths.deckPath, 'deck');
        return parseYdk(resourcePaths.deckPath);
      })();
  const opponentDeck = body.opponentDeckText
    ? parseYdkText(String(body.opponentDeckText))
    : body.deckText
      ? playerDeck
      : (() => {
          assertFileExists(resourcePaths.opponentDeckPath, 'opponent deck');
          return parseYdk(resourcePaths.opponentDeckPath);
        })();
  const outputResolver = resolveTopReplayOutputPaths(
    outputDirArg || path.join(process.cwd(), 'replays', `web-${job.id}`),
    toUInt32(body.seed, DEFAULT_OPTIONS.seed),
    exportItems.length,
  );
  const outputPaths = outputResolver(exportItems.map((item) => item.depth));
  const exports = [];

  for (let index = 0; index < exportItems.length; index += 1) {
    const item = exportItems[index];
    const { runtime, runner } = await createSearchContext({
      cardsPath: resourcePaths.cardsPath,
      scriptDirs: resourcePaths.scriptDirs,
      nativeScriptsRoot: resourcePaths.scriptsRoot,
      seed: item.seed >>> 0,
      drawCount,
      maxDepth: toInt(body.maxDepth, DEFAULT_OPTIONS.maxDepth),
      maxNodes: toInt(body.maxNodes, DEFAULT_OPTIONS.maxNodes),
      targetTerminals: toInt(body.targetTerminals, 0),
      maxBeamWidth: Math.max(1, toInt(body.maxBeamWidth, DEFAULT_OPTIONS.maxBeamWidth)),
      maxActionsPerNode: toInt(body.maxActionsPerNode, DEFAULT_OPTIONS.maxActionsPerNode),
      snapshotPoolSize: toInt(body.snapshotPoolSize, DEFAULT_OPTIONS.snapshotPoolSize),
      expandScriptKeywords: parseKeywordList(body.expandScriptKeywords),
      playerDeck,
      opponentDeck,
      playerOpening: item.opening,
      opponentOpening: item.opponentOpening,
      exactSingleSearch: true,
      engineBackend: 'wasm',
      yrpVersion,
    });
    try {
      const responsesEncoded = runner.buildReplayResponseHistory(item.state);
      const replayInfo = exportReplayYrp({
        seed: item.seed >>> 0,
        drawCount,
        playerDeck,
        opponentDeck,
        playerOpening: item.opening,
        opponentOpening: item.opponentOpening,
        state: item.state,
        responsesEncoded,
        outPath: outputPaths[index],
        yrpVersion,
        seedSequence: runner.seedSequence,
      });
      exports.push({
        path: replayInfo.outPath,
        depth: item.depth,
        responseCount: replayInfo.responseCount,
        byteLength: replayInfo.byteLength,
      });
    } finally {
      await cleanupRuntime(runtime, runner);
    }
  }

  return {
    outputDir: path.dirname(exports[0]?.path ?? ''),
    files: exports,
  };
}

async function exportCliSearchResults(params) {
  const {
    search,
    resourcePaths,
    drawCount,
    yrpVersion,
    playerDeck,
    opponentDeck,
    seed,
    maxDepth,
    maxNodes,
    targetTerminals,
    maxBeamWidth,
    maxActionsPerNode,
    snapshotPoolSize,
    expandScriptKeywords,
    exportYrpArg,
  } = params ?? {};
  if (!search?.exportItems?.length) {
    throw new Error('当前搜索结果没有可导出的录像');
  }
  const outputResolver = resolveTopReplayOutputPaths(
    exportYrpArg === undefined ? true : exportYrpArg,
    toUInt32(seed, DEFAULT_OPTIONS.seed),
    search.exportItems.length,
  );
  const outputPaths = outputResolver(search.exportItems.map((item) => item.depth));
  const files = [];
  for (let index = 0; index < search.exportItems.length; index += 1) {
    const item = search.exportItems[index];
    const { runtime, runner } = await createSearchContext({
      cardsPath: resourcePaths.cardsPath,
      scriptDirs: resourcePaths.scriptDirs,
      nativeScriptsRoot: resourcePaths.scriptsRoot,
      seed: item.seed >>> 0,
      drawCount,
      maxDepth,
      maxNodes,
      targetTerminals,
      maxBeamWidth,
      maxActionsPerNode,
      snapshotPoolSize,
      expandScriptKeywords,
      playerDeck,
      opponentDeck,
      playerOpening: item.opening,
      opponentOpening: item.opponentOpening,
      exactSingleSearch: true,
      engineBackend: 'wasm',
      yrpVersion,
    });
    try {
      const responsesEncoded = runner.buildReplayResponseHistory(item.state);
      const replayInfo = exportReplayYrp({
        seed: item.seed >>> 0,
        drawCount,
        playerDeck,
        opponentDeck,
        playerOpening: item.opening,
        opponentOpening: item.opponentOpening,
        state: item.state,
        responsesEncoded,
        outPath: outputPaths[index],
        yrpVersion,
        seedSequence: runner.seedSequence,
      });
      files.push({
        path: replayInfo.outPath,
        depth: item.depth,
        responseCount: replayInfo.responseCount,
        byteLength: replayInfo.byteLength,
      });
    } finally {
      await cleanupRuntime(runtime, runner);
    }
  }
  return {
    outputDir: path.dirname(files[0]?.path ?? ''),
    files,
  };
}

async function buildReplayFilesFromArchiveDocument(archive, outputDirArg = null) {
  if (!archive || typeof archive !== 'object') {
    throw new Error('存档内容无效');
  }
  const request = archive.request ?? {};
  const requestedTopK = request.topK ?? request.topP ?? request.topp;
  let finalResult = deserializeFullSearchResult(archive.finalResult);
  let exportItems = selectRequestedExportItems(
    finalResult,
    requestedTopK,
  );
  let synthesizedFromCheckpoint = false;
  if (!exportItems.length) {
    const synthesized = buildFinalResultFromArchiveState(archive, {
      topK: requestedTopK,
      scoringRules: request.scoringRules,
      playerDeck: request.playerDeck,
    })?.finalResult ?? null;
    finalResult = synthesized;
    exportItems = selectRequestedExportItems(finalResult, requestedTopK);
    synthesizedFromCheckpoint = exportItems.length > 0;
  }
  if (!exportItems.length) {
    throw new Error('存档中没有可导出的录像结果');
  }
  const resourcePaths = resolveResourcePaths({
    cardsPath: archive.resourcePaths?.cardsPath ?? request.resourcePaths?.cardsPath ?? request.cardsPath,
    scriptsRoot: archive.resourcePaths?.scriptsRoot ?? request.resourcePaths?.scriptsRoot ?? request.scriptsRoot,
  });
  assertFileExists(resourcePaths.cardsPath, 'cards.cdb');
  if (resourcePaths.scriptDirs.length === 0) {
    throw new Error(`脚本目录无效: ${resourcePaths.scriptsRoot}`);
  }
  const drawCount = toInt(request.drawCount, DEFAULT_OPTIONS.drawCount);
  const yrpVersion = parseYrpVersion(request.yrpVersion, 2);
  const playerDeck = request.playerDeck;
  const opponentDeck = request.opponentDeck ?? playerDeck;
  if (!playerDeck || !opponentDeck) {
    throw new Error('存档缺少牌组数据，无法生成录像');
  }
  const outputResolver = resolveTopReplayOutputPaths(
    outputDirArg || DEFAULT_WEB_REPLAY_OUTPUT_DIR,
    toUInt32(request.seed, DEFAULT_OPTIONS.seed),
    exportItems.length,
  );
  const outputPaths = outputResolver(exportItems.map((item) => item.depth));
  const files = [];
  for (let index = 0; index < exportItems.length; index += 1) {
    const item = exportItems[index];
    const { runtime, runner } = await createSearchContext({
      cardsPath: resourcePaths.cardsPath,
      scriptDirs: resourcePaths.scriptDirs,
      nativeScriptsRoot: resourcePaths.scriptsRoot,
      seed: (item.seed ?? request.seed ?? DEFAULT_OPTIONS.seed) >>> 0,
      drawCount,
      maxDepth: toInt(request.maxDepth, DEFAULT_OPTIONS.maxDepth),
      maxNodes: toInt(request.maxNodes, DEFAULT_OPTIONS.maxNodes),
      targetTerminals: toInt(request.targetTerminals, 0),
      maxBeamWidth: Math.max(1, toInt(request.maxBeamWidth, DEFAULT_OPTIONS.maxBeamWidth)),
      maxActionsPerNode: toInt(request.maxActionsPerNode, DEFAULT_OPTIONS.maxActionsPerNode),
      snapshotPoolSize: toInt(request.snapshotPoolSize, DEFAULT_OPTIONS.snapshotPoolSize),
      expandScriptKeywords: parseKeywordList(request.expandScriptKeywords),
      playerDeck,
      opponentDeck,
      playerOpening: item.opening,
      opponentOpening: item.opponentOpening,
      exactSingleSearch: true,
      engineBackend: 'wasm',
      yrpVersion,
    });
    try {
      const responsesEncoded = runner.buildReplayResponseHistory(item.state);
      const replayInfo = exportReplayYrp({
        seed: (item.seed ?? request.seed ?? DEFAULT_OPTIONS.seed) >>> 0,
        drawCount,
        playerDeck,
        opponentDeck,
        playerOpening: item.opening,
        opponentOpening: item.opponentOpening,
        state: item.state,
        responsesEncoded,
        outPath: outputPaths[index],
        yrpVersion,
        seedSequence: runner.seedSequence,
      });
      files.push({
        name: `top${index + 1}-depth${item.depth}.yrp`,
        path: replayInfo.outPath,
        depth: item.depth,
        responseCount: replayInfo.responseCount,
        byteLength: replayInfo.byteLength,
      });
    } finally {
      await cleanupRuntime(runtime, runner);
    }
  }
  return {
    archivePath: archive.sourcePath ?? null,
    outputDir: path.dirname(files[0]?.path ?? normalizeArchivePath(outputDirArg || DEFAULT_WEB_REPLAY_OUTPUT_DIR)),
    topK: exportItems.length,
    checkpointBased: synthesizedFromCheckpoint,
    archiveStatus: archive.status ?? null,
    totalNodes: finalResult?.totalNodes ?? 0,
    totalTerminals: finalResult?.totalTerminals ?? 0,
    truncated: !!finalResult?.truncated,
    searchResults: Array.isArray(finalResult?.searchResults) ? finalResult.searchResults : [],
    files,
  };
}

const WEB_SEARCH_STALL_TIMEOUT_MS = 300000;
const WEB_SEARCH_AUTO_RETRY_LIMIT = 3;
const WEB_SEARCH_AUTO_RETRY_DELAY_MS = 1500;

function loadPartialWebArchiveCheckpoint(archivePath, requestSignature = null) {
  const archive = readBestWebArchiveVariant(archivePath, requestSignature);
  if (!archive || typeof archive !== 'object' || archive.status !== 'partial') {
    return null;
  }
  const currentOpening = deserializeArchiveCurrentOpening(archive.currentOpening);
  const hasResumeState = !!currentOpening?.resumeState;
  const hasCompletedOpenings =
    Array.isArray(archive.completedOpenings) && archive.completedOpenings.length > 0;
  if (!hasResumeState && !hasCompletedOpenings) {
    return null;
  }
  let stat = null;
  try {
    stat = fs.statSync(archive.sourcePath ?? archivePath);
  } catch {
    stat = null;
  }
  const totalNodes = Number(archive.progress?.totalNodes ?? 0);
  const checkpointNodes = Number(
    archive.progress?.checkpointNodes
      ?? currentOpening?.resumeState?.best?.nodes
      ?? 0,
  );
  const checkpointKey = JSON.stringify({
    requestSignature: archive.requestSignature ?? '',
    exploredOpenings: Number(archive.progress?.exploredOpenings ?? 0),
    totalNodes,
    checkpointNodes,
    openingIndex: currentOpening?.openingIndex ?? -1,
    updatedAt: archive.updatedAt ?? '',
    size: Number(stat?.size ?? 0),
    mtimeMs: Number(stat?.mtimeMs ?? 0),
  });
  return {
    archive,
    currentOpening,
    totalNodes,
    checkpointNodes,
    checkpointKey,
    archivePath: archive.sourcePath ?? normalizeArchivePath(archivePath),
    mtimeMs: Number(stat?.mtimeMs ?? 0),
  };
}

function isAutoFinalizedWebArchive(archive) {
  if (!archive || typeof archive !== 'object') return false;
  if (!['completed', 'truncated'].includes(String(archive.status ?? ''))) return false;
  return String(archive.progress?.message ?? '').includes('自动收尾');
}

function shouldResumeTruncatedWebArchive(archive, prepared) {
  if (!archive || String(archive.status ?? '') !== 'truncated') return false;
  const currentOpening = deserializeArchiveCurrentOpening(archive.currentOpening);
  if (!currentOpening?.resumeState) return false;
  const requestedMaxNodes = Number(prepared?.maxNodes ?? 0);
  const resumeNodes = Number(currentOpening.resumeState?.best?.nodes ?? 0);
  if (!Number.isFinite(requestedMaxNodes) || requestedMaxNodes <= 0) return false;
  if (!Number.isFinite(resumeNodes)) return false;
  return requestedMaxNodes > resumeNodes;
}

function findActiveWebSearchJobBySignature(requestSignature) {
  if (!requestSignature) return null;
  for (const job of webSearchJobs.values()) {
    if (job?.requestSignature !== requestSignature) continue;
    if (['queued', 'running', 'recovering'].includes(job.state)) {
      return job;
    }
  }
  return null;
}

function buildWebSearchJobRequestBody(body, prepared = null) {
  if (!prepared || typeof prepared !== 'object') return { ...body };
  return {
    ...body,
    drawCount: prepared.drawCount,
    seed: prepared.seed,
    maxNodes: prepared.maxNodes,
    maxDepth: prepared.maxDepth,
    targetTerminals: prepared.targetTerminals,
    topK: prepared.topK,
    maxBeamWidth: prepared.maxBeamWidth,
    maxActionsPerNode: prepared.maxActionsPerNode,
    snapshotPoolSize: prepared.snapshotPoolSize,
    engineBackend: prepared.engineBackend,
    exactSearchBackend: prepared.exactSearchBackend,
    workers: prepared.workers,
    snapshotAccelMode: prepared.snapshotAccelMode,
    snapshotStorageMode: prepared.snapshotStorageMode,
    progressEvery: prepared.progressEvery,
    checkpointEvery: prepared.checkpointEvery,
    enumerateOpenings: prepared.enumerateOpenings,
    fixedOpeningInstanceIds: prepared.fixedOpeningInstanceIds,
    scoringRules: prepared.scoringRules,
    yrpVersion: prepared.yrpVersion,
    playerDeck: prepared.playerDeck,
    opponentDeck: prepared.opponentDeck,
    cardsPath: prepared.resourcePaths?.cardsPath ?? body.cardsPath,
    scriptsRoot: prepared.resourcePaths?.scriptsRoot ?? body.scriptsRoot,
    archivePath: prepared.archivePath ?? body.archivePath,
  };
}

function createWebSearchJob(body, options = {}) {
  const id = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const configuredAutoRetryLimit = Number(options.autoRetryLimit ?? WEB_SEARCH_AUTO_RETRY_LIMIT);
  const unlimitedAutoRetries =
    !Number.isFinite(configuredAutoRetryLimit) || configuredAutoRetryLimit < 0;
  const maxAutoRetries = unlimitedAutoRetries
    ? -1
    : Math.max(0, configuredAutoRetryLimit);
  const formatRetryStatus = (retryCount) =>
    unlimitedAutoRetries ? `${retryCount}/无限` : `${retryCount}/${maxAutoRetries}`;
  const requestBody = {
    ...buildWebSearchJobRequestBody(body, options.prepared),
    __jobId: id,
  };
  const executionPath =
    options.executionPath && typeof options.executionPath === 'object'
      ? {
          engineBackend: options.executionPath.engineBackend ?? 'wasm',
          exactSearchBackend: options.executionPath.exactSearchBackend ?? 'js',
          workers: Math.max(1, Number(options.executionPath.workers ?? 1) || 1),
          snapshotAccelMode: options.executionPath.snapshotAccelMode ?? snapshotState.getSnapshotAccelMode(),
          snapshotStorageMode: options.executionPath.snapshotStorageMode ?? snapshotState.getSnapshotStorageMode(),
        }
        : {
            engineBackend: String(body.engineBackend ?? 'auto'),
            exactSearchBackend: normalizeExactSearchBackend(body.exactSearchBackend ?? 'auto'),
            workers: Math.max(1, Number(body.workers ?? WEB_DEFAULT_WORKERS) || WEB_DEFAULT_WORKERS),
            snapshotAccelMode: WEB_DEFAULT_SNAPSHOT_ACCEL_MODE,
            snapshotStorageMode: WEB_DEFAULT_SNAPSHOT_STORAGE_MODE,
        };
  const startedAtMs = Math.max(0, Number(options.startedAtMs ?? Date.now()) || Date.now());
  const job = {
    id,
    state: 'queued',
    createdAt: Date.now(),
    requestSignature: options.requestSignature ?? null,
    requestBody,
    logs: [],
    progress: {
      phase: 'queued',
      message: '任务已创建',
      exploredOpenings: 0,
      totalOpenings: 0,
      totalNodes: 0,
      totalTerminals: 0,
      archivePath: options.archivePath ?? null,
      archiveStatus: options.archiveStatus ?? null,
      resumedFromArchive: !!options.resumeFromArchive || options.archiveStatus === 'partial',
      retryCount: 0,
      maxRetryCount: unlimitedAutoRetries ? -1 : maxAutoRetries,
      startedAtMs,
      ...executionPath,
      done: false,
    },
    result: null,
    fullResult: null,
    error: null,
    lastNodeAdvanceAt: Date.now(),
    lastTotalNodes: 0,
    lastRetryCheckpointNodes: 0,
    autoRetryCount: 0,
    workerGeneration: 0,
    retryTimer: null,
    worker: null,
  };
  let stallTimer = null;
  appendJobLog(job, '已接收穷举任务');
  webSearchJobs.set(id, job);
  const clearRetryTimer = () => {
    if (!job.retryTimer) return;
    clearTimeout(job.retryTimer);
    job.retryTimer = null;
  };
  const stopStallTimer = () => {
    if (!stallTimer) return;
    clearInterval(stallTimer);
    stallTimer = null;
  };
  const terminateWorker = (worker, invalidateGeneration = false) => {
    if (!worker) return;
    if (invalidateGeneration && job.worker === worker) {
      job.workerGeneration += 1;
    }
    if (job.worker === worker) {
      job.worker = null;
    }
    worker.terminate().catch(() => {});
  };
  const markFailed = (message) => {
    clearRetryTimer();
    stopStallTimer();
    terminateWorker(job.worker, true);
    job.state = 'failed';
    job.error = message;
    job.progress = {
      ...job.progress,
      archivePath: options.archivePath ?? job.progress.archivePath ?? null,
      phase: 'failed',
      message,
      retryCount: job.autoRetryCount,
      maxRetryCount: unlimitedAutoRetries ? -1 : maxAutoRetries,
      done: true,
    };
    appendJobLog(job, `搜索失败: ${message}`);
  };
  const finalizeFromCheckpoint = (reason) => {
    if (!options.archivePath) return false;
    const checkpoint = loadPartialWebArchiveCheckpoint(
      options.archivePath,
      options.requestSignature ?? null,
    );
    if (!checkpoint?.archive) return false;
    const fullResult = buildFinalResultFromArchiveState(checkpoint.archive, {
      topK: body?.topK ?? body?.topP ?? body?.topp,
      scoringRules: body?.scoringRules,
    }).finalResult;
    if (!fullResult) return false;
    clearRetryTimer();
    stopStallTimer();
    terminateWorker(job.worker, true);
    job.state = 'succeeded';
    job.error = null;
    job.fullResult = {
      ...fullResult,
      archivePath: options.archivePath,
      archiveStatus: 'partial',
      resumedFromArchive: true,
    };
    job.result = {
      ...createPublicWebResult(fullResult),
      archivePath: options.archivePath,
      archiveStatus: 'partial',
      resumedFromArchive: true,
    };
    job.progress = {
      ...job.progress,
      phase: 'done',
      message: `${reason}; synthesized a resumable result from the latest checkpoint and kept the checkpoint archive intact`,
      exploredOpenings: Number(
        checkpoint.archive.progress?.exploredOpenings ?? job.progress.exploredOpenings ?? 0,
      ),
      totalOpenings: Number(
        checkpoint.archive.progress?.totalOpenings ?? job.progress.totalOpenings ?? 0,
      ),
      totalNodes: Number(checkpoint.archive.progress?.totalNodes ?? job.progress.totalNodes ?? 0),
      totalTerminals: Number(
        checkpoint.archive.progress?.totalTerminals ?? job.progress.totalTerminals ?? 0,
      ),
      archivePath: options.archivePath,
      archiveStatus: 'partial',
      resumedFromArchive: true,
      retryCount: job.autoRetryCount,
      maxRetryCount: unlimitedAutoRetries ? -1 : maxAutoRetries,
      done: true,
    };
    appendJobLog(job, reason);
    appendJobLog(job, 'latest checkpoint preserved; you can resume from this archive without losing progress');
    logTerminal('warn', 'web-search', 'search-finalized-from-checkpoint', {
      jobId: job.id,
      reason,
      archivePath: options.archivePath,
      totalNodes: checkpoint.totalNodes,
      checkpointNodes: checkpoint.checkpointNodes,
      retryCount: job.autoRetryCount,
    });
    return true;
  };
  const scheduleRetryFromCheckpoint = (reason) => {
    if (job.result || job.state === 'succeeded') return false;
    if (!options.archivePath) return false;
    if (!unlimitedAutoRetries && job.autoRetryCount >= maxAutoRetries) return false;
    const checkpoint = loadPartialWebArchiveCheckpoint(
      options.archivePath,
      options.requestSignature ?? null,
    );
    if (!checkpoint) return false;
    logTerminal('info', 'web-search', 'resume-checkpoint-loaded', {
      archivePath: checkpoint.archivePath ?? options.archivePath,
      totalNodes: checkpoint.totalNodes,
      checkpointNodes: checkpoint.checkpointNodes,
      openingIndex: checkpoint.currentOpening?.openingIndex ?? -1,
      exactSearchBackend: checkpoint.currentOpening?.exactSearchBackend ?? null,
      resumeKind: checkpoint.currentOpening?.resumeState?.resumeKind ?? null,
      completedOpenings: checkpoint.archive?.completedOpenings?.length ?? 0,
      completedResults: checkpoint.currentOpening?.resumeState?.completedResults?.length ?? 0,
      pendingShards: checkpoint.currentOpening?.resumeState?.pendingShards?.length ?? 0,
    });
    // OOB 触发的重试,先尝试切到稳定快照模式 (cpu/full),覆盖 requestBody 上的字段。
    // requestBody 是 closure 内同一对象引用,下次 spawnWorker 的 workerData.job 会自动用最新值。
    const stableSnapshotApplied = applyStableSnapshotFallbackForRetry(job, requestBody, reason);
    job.autoRetryCount += 1;
    job.state = 'recovering';
    job.error = null;
    job.lastNodeAdvanceAt = Date.now();
    job.lastTotalNodes = Math.max(job.lastTotalNodes, checkpoint.totalNodes);
    job.lastRetryCheckpointNodes = Math.max(
      Number(job.lastRetryCheckpointNodes ?? 0),
      Number(checkpoint.checkpointNodes ?? checkpoint.totalNodes ?? 0),
    );
    job.progress = {
      ...job.progress,
      phase: 'retrying',
      message: `${reason}，已从最近检查点自动重试 (${formatRetryStatus(job.autoRetryCount)})`,
      exploredOpenings: Number(
        checkpoint.archive.progress?.exploredOpenings ?? job.progress.exploredOpenings ?? 0,
      ),
      totalOpenings: Number(
        checkpoint.archive.progress?.totalOpenings ?? job.progress.totalOpenings ?? 0,
      ),
      totalNodes: Number(checkpoint.archive.progress?.totalNodes ?? job.progress.totalNodes ?? 0),
      totalTerminals: Number(
        checkpoint.archive.progress?.totalTerminals ?? job.progress.totalTerminals ?? 0,
      ),
      archivePath: options.archivePath,
      archiveStatus: checkpoint.archive.status ?? 'partial',
      resumedFromArchive: true,
      retryCount: job.autoRetryCount,
      maxRetryCount: unlimitedAutoRetries ? -1 : maxAutoRetries,
      snapshotAccelMode: requestBody.snapshotAccelMode ?? job.progress.snapshotAccelMode ?? null,
      snapshotStorageMode: requestBody.snapshotStorageMode ?? job.progress.snapshotStorageMode ?? null,
      done: false,
    };
    appendJobLog(job, `${reason}，准备从最近检查点自动重试 (${formatRetryStatus(job.autoRetryCount)})`);
    appendJobLog(
      job,
      `最近检查点: 累计节点 ${checkpoint.totalNodes}，断点节点 ${checkpoint.checkpointNodes}，已完成起手 ${checkpoint.archive.progress?.exploredOpenings ?? 0}`,
    );
    logTerminal('warn', 'web-search', 'search-retry-from-checkpoint', {
      jobId: job.id,
      reason,
      retryCount: job.autoRetryCount,
      totalNodes: checkpoint.totalNodes,
      checkpointNodes: checkpoint.checkpointNodes,
      archivePath: options.archivePath,
      stableSnapshotFallback: stableSnapshotApplied,
      snapshotAccelMode: requestBody.snapshotAccelMode ?? null,
      snapshotStorageMode: requestBody.snapshotStorageMode ?? null,
    });
    clearRetryTimer();
    job.retryTimer = setTimeout(() => {
      job.retryTimer = null;
      spawnWorker(true);
    }, WEB_SEARCH_AUTO_RETRY_DELAY_MS);
    return true;
  };
  const handleWorkerFailure = (worker, generation, reason) => {
    if (generation !== job.workerGeneration) return;
    terminateWorker(worker);
    if (scheduleRetryFromCheckpoint(reason)) return;
    if (finalizeFromCheckpoint(reason)) return;
    markFailed(reason);
  };
  const spawnWorker = (isRetry = false) => {
    if (job.state === 'failed' || job.state === 'succeeded') return;
    clearRetryTimer();
    const generation = job.workerGeneration + 1;
    job.workerGeneration = generation;
    const worker = new Worker(__filename, {
      workerData: {
        type: 'web-search-worker',
        job: requestBody,
      },
    });
    job.worker = worker;
    let finished = false;
    const acknowledgeWorkerMessage = (type) => {
      try {
        worker.postMessage({ type });
      } catch {
        // Worker may already be exiting; the sender has a timeout fallback.
      }
    };
    worker.on('message', (message) => {
      if (generation !== job.workerGeneration) return;
      if (message?.type === 'ready') {
        job.state = 'running';
        job.lastNodeAdvanceAt = Date.now();
        if (isRetry) {
          job.progress = {
            ...job.progress,
            phase: 'resume',
            message: `已从最近检查点恢复，正在继续搜索 (${formatRetryStatus(job.autoRetryCount)})`,
            archivePath: options.archivePath ?? job.progress.archivePath ?? null,
            archiveStatus: 'partial',
            resumedFromArchive: true,
            retryCount: job.autoRetryCount,
            maxRetryCount: unlimitedAutoRetries ? -1 : maxAutoRetries,
            done: false,
          };
          appendJobLog(job, '已从最近检查点恢复，继续执行搜索');
        } else {
          appendJobLog(job, '开始执行搜索');
        }
        if (isRetry) {
          logTerminal('info', 'web-search', 'search-resumed-from-checkpoint', {
            jobId: job.id,
            retryCount: job.autoRetryCount,
            archivePath: options.archivePath ?? job.progress.archivePath ?? null,
          });
        } else {
          logTerminal('info', 'web-search', 'search-worker-started', {
            jobId: job.id,
            requestSignature: job.requestSignature,
            engineBackend: executionPath.engineBackend,
            exactSearchBackend: executionPath.exactSearchBackend,
            workers: executionPath.workers,
          });
        }
        worker.postMessage({ type: 'run' });
        return;
      }
      if (message?.type === 'progress') {
        job.lastNodeAdvanceAt = Date.now();
        job.progress = {
          ...job.progress,
          ...message.progress,
          retryCount: job.autoRetryCount,
          maxRetryCount: unlimitedAutoRetries ? -1 : maxAutoRetries,
          resumedFromArchive: job.autoRetryCount > 0 || !!job.progress.resumedFromArchive,
        };
        const nextTotalNodes = Number(message.progress?.totalNodes ?? job.progress.totalNodes ?? 0);
        if (nextTotalNodes > job.lastTotalNodes) {
          job.lastTotalNodes = nextTotalNodes;
        }
        if (message.progress?.phase === 'checkpoint') {
          const checkpointNodes = Number(
            message.progress?.checkpointNodes ?? message.progress?.currentNodes ?? 0,
          );
          const previousRetryCheckpointNodes = Number(job.lastRetryCheckpointNodes ?? 0);
          if (job.autoRetryCount > 0 && checkpointNodes > previousRetryCheckpointNodes) {
            const previousRetryCount = job.autoRetryCount;
            job.autoRetryCount = 0;
            job.lastRetryCheckpointNodes = checkpointNodes;
            job.progress = {
              ...job.progress,
              retryCount: 0,
              maxRetryCount: unlimitedAutoRetries ? -1 : maxAutoRetries,
            };
            appendJobLog(job, `检查点已推进到 ${checkpointNodes}，自动重试次数已重置`);
            logTerminal('info', 'web-search', 'auto-retry-budget-reset', {
              jobId: job.id,
              previousRetryCount,
              previousRetryCheckpointNodes,
              checkpointNodes,
            });
          } else if (checkpointNodes > previousRetryCheckpointNodes) {
            job.lastRetryCheckpointNodes = checkpointNodes;
          }
          logTerminal('info', 'web-search', 'search-checkpoint', {
            jobId: job.id,
            openingIndex: message.progress?.openingIndex ?? null,
            checkpointNodes: message.progress?.checkpointNodes ?? message.progress?.currentNodes ?? 0,
            totalNodes: message.progress?.totalNodes ?? 0,
            totalTerminals: message.progress?.totalTerminals ?? 0,
          });
        }
        if (message.progress?.message) appendJobLog(job, message.progress.message);
        return;
      }
      if (message?.type === 'result') {
        acknowledgeWorkerMessage('result-ack');
        finished = true;
        clearRetryTimer();
        stopStallTimer();
        job.state = 'succeeded';
        job.error = null;
        job.fullResult = message.payload;
        job.result = createPublicWebResult(message.payload);
        job.progress = {
          ...job.progress,
          phase: 'done',
          message: message.payload?.archivePath ? `搜索完成，已生成存档 ${message.payload.archivePath}` : '搜索完成',
          archivePath: message.payload?.archivePath ?? job.progress.archivePath ?? null,
          archiveStatus: message.payload?.archiveStatus ?? job.progress.archiveStatus ?? null,
          resumedFromArchive: !!message.payload?.resumedFromArchive,
          retryCount: job.autoRetryCount,
          maxRetryCount: unlimitedAutoRetries ? -1 : maxAutoRetries,
          done: true,
        };
        appendJobLog(job, '搜索完成，结果已准备好');
        terminateWorker(worker);
        return;
      }
      if (message?.type === 'error') {
        acknowledgeWorkerMessage('error-ack');
        finished = true;
        handleWorkerFailure(
          worker,
          generation,
          message.error || 'worker search failed',
        );
      }
    });
    worker.once('error', (err) => {
      if (generation !== job.workerGeneration || finished) return;
      finished = true;
      handleWorkerFailure(
        worker,
        generation,
        err?.message ?? String(err),
      );
    });
    worker.once('exit', (code) => {
      if (generation !== job.workerGeneration || finished) return;
      if (code === 0 && job.result) {
        terminateWorker(worker);
        return;
      }
      finished = true;
      handleWorkerFailure(
        worker,
        generation,
        `搜索 worker 异常退出 (code=${code})`,
      );
    });
  };
  stallTimer = setInterval(() => {
    if (!['running', 'recovering'].includes(job.state) || job.result) return;
    if (!options.archivePath) return;
    if (Date.now() - job.lastNodeAdvanceAt < WEB_SEARCH_STALL_TIMEOUT_MS) return;
    const reason =
      job.state === 'recovering'
        ? '搜索恢复后仍长时间无新增节点'
        : '检测到搜索长时间无新增节点';
    if (scheduleRetryFromCheckpoint(reason)) {
      terminateWorker(job.worker, true);
      return;
    }
    if (finalizeFromCheckpoint(reason)) return;
    markFailed(reason);
  }, 2000);
  spawnWorker(false);
  return job;
}

function createCompletedWebSearchJob(body, archive, archivePath, logs = []) {
  const id = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const fullResult = buildFinalResultFromArchiveState(archive, {
    topK: body?.topK ?? body?.topP ?? body?.topp,
    scoringRules: body?.scoringRules,
  }).finalResult;
  const job = {
    id,
    state: 'succeeded',
    createdAt: Date.now(),
    requestSignature: archive.requestSignature ?? null,
    requestBody: {
      ...body,
      __jobId: id,
    },
    logs: logs.slice(),
    progress: {
      phase: 'done',
      message: archive.status === 'truncated' ? '已加载完成存档（达到上限）' : '已加载完成存档',
      exploredOpenings: archive.progress?.exploredOpenings ?? fullResult?.exploredOpenings ?? 0,
      totalOpenings: archive.progress?.totalOpenings ?? fullResult?.exploredOpenings ?? 0,
      totalNodes: archive.progress?.totalNodes ?? fullResult?.totalNodes ?? 0,
      totalTerminals: archive.progress?.totalTerminals ?? fullResult?.totalTerminals ?? 0,
      archivePath,
      archiveStatus: archive.status,
      resumedFromArchive: true,
      done: true,
    },
    result: {
      ...createPublicWebResult(fullResult),
      archivePath,
      archiveStatus: archive.status,
      resumedFromArchive: true,
    },
    fullResult,
    error: null,
  };
  if (!job.logs.length) {
    job.logs.push(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] 命中已有存档 ${archivePath}`);
  }
  webSearchJobs.set(id, job);
  return job;
}

async function startWebUiServer(options = {}) {
  const port = Math.max(1, Number(options.port ?? 3456) || 3456);
  const host = String(options.host ?? '127.0.0.1');
  const server = http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url ?? '/', `http://${host}:${port}`);
      logTerminal('info', 'http', `${req.method} ${requestUrl.pathname}`);
      if (req.method === 'GET' && requestUrl.pathname === '/api/health') {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === 'GET' && requestUrl.pathname === '/api/config') {
        const defaultExecutionPath = resolveExactSearchBackend({
          requestedEngineBackend: 'auto',
          requestedExactSearchBackend: 'auto',
          requestedWorkers: WEB_DEFAULT_WORKERS,
        });
        sendJson(res, 200, {
          defaultArchiveReplayOutputDir: DEFAULT_WEB_REPLAY_OUTPUT_DIR,
          defaultSearchRequest: {
            drawCount: DEFAULT_OPTIONS.drawCount,
            maxNodes: DEFAULT_OPTIONS.maxNodes,
            maxDepth: DEFAULT_OPTIONS.maxDepth,
            topK: DEFAULT_OPTIONS.topK,
            targetTerminals: 0,
          },
          defaultExecutionPath: {
            requestedEngineBackend: 'auto',
            requestedExactSearchBackend: 'auto',
            workers: WEB_DEFAULT_WORKERS,
            engineBackend: defaultExecutionPath.engineBackend,
            exactSearchBackend: defaultExecutionPath.exactSearchBackend,
            snapshotAccelMode: WEB_DEFAULT_SNAPSHOT_ACCEL_MODE,
            snapshotStorageMode: WEB_DEFAULT_SNAPSHOT_STORAGE_MODE,
            checkpointEvery: WEB_ARCHIVE_CHECKPOINT_NODES,
          },
        });
        return;
      }
      if (req.method === 'POST' && requestUrl.pathname === '/api/client-log') {
        const body = await readJsonBody(req);
        logTerminal(body.level ?? 'info', body.source ?? 'web-ui', body.message ?? '', body.detail ?? null);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === 'GET' && requestUrl.pathname.startsWith('/api/card-image/')) {
        const code = Number(requestUrl.pathname.split('/').pop());
        const imagePath = resolveCardImageFile(code);
        if (!imagePath) {
          res.writeHead(404);
          res.end('not found');
          return;
        }
        const stream = fs.createReadStream(imagePath);
        res.writeHead(200, { 'Content-Type': getContentType(imagePath) });
        stream.pipe(res);
        return;
      }
      if (req.method === 'POST' && requestUrl.pathname === '/api/deck/load') {
        const body = await readJsonBody(req);
        const resourcePaths = resolveResourcePaths(body);
        assertFileExists(resourcePaths.cardsPath, 'cards.cdb');
        if (resourcePaths.scriptDirs.length === 0) {
          throw new Error(`脚本目录无效: ${resourcePaths.scriptsRoot}`);
        }
        const deck = body.deckText
          ? parseYdkText(String(body.deckText))
          : (() => {
              assertFileExists(resourcePaths.deckPath, 'deck');
              return parseYdk(resourcePaths.deckPath);
            })();
        const cardRuntime = await createCardTextRuntime(resourcePaths.cardsPath);
        try {
          const deckInstances = createDeckCardInstances(deck, cardRuntime.cardText);
          sendJson(res, 200, {
            deckPath: body.deckText ? String(body.deckName ?? resourcePaths.deckPath) : resourcePaths.deckPath,
            cardsPath: resourcePaths.cardsPath,
            scriptsRoot: resourcePaths.scriptsRoot,
            deck: createDeckView(deckInstances),
          });
        } finally {
          cardRuntime.db.close();
        }
        return;
      }
      if (req.method === 'POST' && requestUrl.pathname === '/api/search/run') {
        const body = await readJsonBody(req);
        const result = await executeWebSearch(body);
        sendJson(res, 200, result);
        return;
      }
      if (req.method === 'POST' && requestUrl.pathname === '/api/search/start') {
        const body = await readJsonBody(req);
        const preparedForLog = prepareWebSearchRequest(body);
        logTerminal('info', 'web-search', 'search-start-request', {
          drawCount: preparedForLog.drawCount,
          seed: preparedForLog.seed,
          maxNodes: preparedForLog.maxNodes,
          maxDepth: preparedForLog.maxDepth,
          topK: preparedForLog.topK,
          exactSearchBackend: preparedForLog.exactSearchBackend,
          workers: preparedForLog.workers,
          checkpointEvery: preparedForLog.checkpointEvery,
          progressEvery: preparedForLog.progressEvery,
        });
        const prepared = preparedForLog;
        const archiveResolution = resolveWebArchiveForPreparedRequest(body, prepared);
        const effectivePrepared = archiveResolution.prepared ?? prepared;
        const existingArchive = archiveResolution.archive ? {
          archivePath: archiveResolution.archivePath,
          archive: archiveResolution.archive,
        } : null;
        const archive = existingArchive?.archive ?? null;
        const reusableArchive = isAutoFinalizedWebArchive(archive) ? null : archive;
        const shouldResumeArchive =
          reusableArchive?.status === 'partial' ||
          shouldResumeTruncatedWebArchive(reusableArchive, effectivePrepared);
        const shouldLoadArchiveResult =
          reusableArchive &&
          (
            reusableArchive.status === 'completed' ||
            (reusableArchive.status === 'truncated' && !shouldResumeArchive)
          );
        const existingJob = findActiveWebSearchJobBySignature(effectivePrepared.requestSignature);
        const job =
          existingJob
            ? existingJob
            : shouldLoadArchiveResult
            ? createCompletedWebSearchJob(body, reusableArchive, existingArchive.archivePath)
            : createWebSearchJob(body, {
                archivePath: archiveResolution.archivePath,
                archiveStatus: reusableArchive?.status ?? null,
                requestSignature: effectivePrepared.requestSignature,
                prepared: effectivePrepared,
                executionPath: buildWebExecutionPathMeta(effectivePrepared),
                resumeFromArchive: shouldResumeArchive,
                startedAtMs: Date.now(),
              });
        if (existingJob) {
          appendJobLog(existingJob, '检测到页面重新连接，已复用正在执行的同签名任务');
        }
        sendJson(res, 200, {
          jobId: job.id,
          state: job.state,
          progress: job.progress,
          logs: job.logs,
          result: job.result,
          archivePath:
            job.result?.archivePath
            ?? job.progress?.archivePath
            ?? existingArchive?.archivePath
            ?? archiveResolution.archivePath,
          archiveStatus: job.result?.archiveStatus ?? job.progress?.archiveStatus ?? reusableArchive?.status ?? null,
          resumedFromArchive: !!(
            job.result?.resumedFromArchive
            ?? job.progress?.resumedFromArchive
            ?? shouldResumeArchive
          ),
        });
        return;
      }
      if (req.method === 'POST' && requestUrl.pathname === '/api/archive/load') {
        const body = await readJsonBody(req);
        const archivePath = resolveRequestedWebArchivePath(body);
        if (!archivePath) {
          throw new Error('缺少存档路径');
        }
        const archive = readBestWebArchiveVariant(archivePath, null);
        if (!archive) {
          throw new Error(`存档不存在: ${archivePath}`);
        }
        sendJson(res, 200, {
          archive: buildWebArchiveClientSummary({
            ...archive,
            sourcePath: archive.sourcePath ?? archivePath,
          }),
        });
        return;
      }
      if (req.method === 'GET' && requestUrl.pathname === '/api/search/status') {
        const jobId = String(requestUrl.searchParams.get('id') ?? '');
        const job = webSearchJobs.get(jobId);
        if (!job) {
          sendJson(res, 404, { error: '搜索任务不存在' });
          return;
        }
        sendJson(res, 200, {
          jobId: job.id,
          state: job.state,
          progress: job.progress,
          logs: job.logs,
          result: job.result,
          error: job.error,
          archivePath: job.result?.archivePath ?? job.progress?.archivePath ?? null,
          archiveStatus: job.result?.archiveStatus ?? job.progress?.archiveStatus ?? null,
          resumedFromArchive: !!(job.result?.resumedFromArchive ?? job.progress?.resumedFromArchive),
        });
        return;
      }
      if (req.method === 'POST' && requestUrl.pathname === '/api/search/export') {
        const body = await readJsonBody(req);
        const jobId = String(body.jobId ?? '');
        const job = webSearchJobs.get(jobId);
        if (!job) {
          sendJson(res, 404, { error: '搜索任务不存在' });
          return;
        }
        if (job.state !== 'succeeded' || !job.fullResult) {
          sendJson(res, 400, { error: '搜索尚未完成，无法导出录像' });
          return;
        }
        const exported = await exportWebSearchJobResults(job, body.outputDir ? String(body.outputDir) : null);
        appendJobLog(job, `已导出 ${exported.files.length} 个录像到 ${exported.outputDir}`);
        sendJson(res, 200, exported);
        return;
      }
      if (req.method === 'POST' && requestUrl.pathname === '/api/archive/build-replays') {
        const body = await readJsonBody(req);
        const archiveInput = body.archive ?? body;
        const requestedArchivePath = resolveRequestedWebArchivePath(body);
        const archive = requestedArchivePath
          ? readBestWebArchiveVariant(requestedArchivePath, null)
          : typeof archiveInput === 'string'
            ? JSON.parse(archiveInput)
            : archiveInput;
        if (!archive) {
          throw new Error(requestedArchivePath ? `存档不存在: ${requestedArchivePath}` : '存档内容无效');
        }
        const built = await buildReplayFilesFromArchiveDocument(
          archive,
          body.outputDir ? String(body.outputDir) : null,
        );
        logTerminal('info', 'archive-build', 'build-replays-finished', {
          outputDir: built.outputDir,
          count: built.files?.length ?? 0,
        });
        sendJson(res, 200, built);
        return;
      }

      const targetPath = requestUrl.pathname === '/'
        ? path.join(WEB_UI_DIR, 'index.html')
        : path.join(WEB_UI_DIR, requestUrl.pathname.replace(/^\/+/, ''));
      if (!targetPath.startsWith(WEB_UI_DIR) || !fs.existsSync(targetPath) || fs.statSync(targetPath).isDirectory()) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': getContentType(targetPath) });
      fs.createReadStream(targetPath).pipe(res);
    } catch (err) {
      logTerminal('error', 'http', err?.message ?? String(err), err?.stack ?? null);
      sendJson(res, 500, { error: err?.message ?? String(err) });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return {
    server,
    url: `http://${host}:${port}`,
  };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return;
  }
  if (args['web-ui']) {
    const { url } = await startWebUiServer({
      port: args.port,
      host: args.host,
    });
    console.log(`Combo Simulator Web UI 已启动: ${url}`);
    console.log('按 Ctrl+C 关闭服务');
    await new Promise(() => {});
  }

  const resourcePaths = resolveResourcePaths({
    resourceDir: args['resource-dir'],
    deckPath: args.deck,
    opponentDeckPath: args['opponent-deck'],
    cardsPath: args.cards,
    scriptsRoot: args.scripts,
  });
  assertFileExists(resourcePaths.deckPath, 'deck');
  assertFileExists(resourcePaths.opponentDeckPath, 'opponent deck');
  assertFileExists(resourcePaths.cardsPath, 'cards.cdb');

  const seed = toUInt32(args.seed, DEFAULT_OPTIONS.seed);
  const drawCount = toInt(args['draw-count'], DEFAULT_OPTIONS.drawCount);
  const maxDepth = toInt(args['max-depth'], DEFAULT_OPTIONS.maxDepth);
  const maxNodes = toInt(args['max-nodes'], DEFAULT_OPTIONS.maxNodes);
  const targetTerminals = toInt(args['target-terminals'], 0);
  const maxBeamWidth = Math.max(1, toInt(args['beam-width'], DEFAULT_OPTIONS.maxBeamWidth));
  const maxActionsPerNode = toInt(args['max-actions'], DEFAULT_OPTIONS.maxActionsPerNode);
  const snapshotPoolSize = toInt(args['snapshot-pool'], DEFAULT_OPTIONS.snapshotPoolSize);
  const requestedWorkers = Math.max(0, toInt(args.workers, 0));
  const requestedSnapshotAccelMode = String(args['snapshot-accel'] ?? 'auto').toLowerCase();
  const requestedSnapshotStorageMode = String(args['snapshot-storage'] ?? 'delta').toLowerCase();
  const requestedEngineBackend = String(args['engine-backend'] ?? 'auto').toLowerCase();
  const requestedExactSearchBackend = normalizeExactSearchBackend(args['exact-search-backend'] ?? 'auto');
  const topK = Math.max(1, toInt(args.top, DEFAULT_OPTIONS.topK));
  const expandScriptKeywords = parseKeywordList(args['expand-script-keywords']);
  const openingCards = parseCodeList(args['opening-cards'], '--opening-cards');
  const opponentOpeningCards = parseCodeList(args['opponent-opening-cards'], '--opponent-opening-cards');
  const exportYrpArg = args['export-yrp'];
  const yrpVersion = parseYrpVersion(args['yrp-version'], 2);
  const profileCore = !!args['profile-core'];
  const verbose = !!args.verbose;

  if (!['auto', 'cpu', 'gpu'].includes(requestedSnapshotAccelMode)) {
    throw new Error(`--snapshot-accel 无效: ${requestedSnapshotAccelMode}`);
  }
  if (!['delta', 'full'].includes(requestedSnapshotStorageMode)) {
    throw new Error(`--snapshot-storage 无效: ${requestedSnapshotStorageMode}`);
  }
  if (!['auto', 'wasm', 'native'].includes(requestedEngineBackend)) {
    throw new Error(`--engine-backend 无效: ${requestedEngineBackend}`);
  }
  snapshotState.setSnapshotAccelMode(requestedSnapshotAccelMode);
  snapshotState.setSnapshotStorageMode(requestedSnapshotStorageMode);
  snapshotState.resetSnapshotAccelState();
  snapshotState.setCoreProfileEnabled(profileCore);
  snapshotState.clearCoreProfileStats();

  if (resourcePaths.scriptDirs.length === 0) {
    throw new Error(`脚本目录无效: ${resourcePaths.scriptsRoot}`);
  }

  const playerDeck = parseYdk(resourcePaths.deckPath);
  const opponentDeck = parseYdk(resourcePaths.opponentDeckPath);
  if (playerDeck.main.length < drawCount || opponentDeck.main.length < drawCount) {
    throw new Error(`主卡组数量不足以抽${drawCount}张起手`);
  }
  if (openingCards.length > 0 && openingCards.length !== drawCount) {
    throw new Error(`--opening-cards 数量(${openingCards.length}) 必须等于 --draw-count(${drawCount})`);
  }
  if (opponentOpeningCards.length > 0 && opponentOpeningCards.length !== drawCount) {
    throw new Error(`--opponent-opening-cards 数量(${opponentOpeningCards.length}) 必须等于 --draw-count(${drawCount})`);
  }

  const enumerateOpenings = !!args['enumerate-openings'];
  const { engineBackend, exactSearchBackend } = resolveExactSearchBackend({
    requestedEngineBackend,
    requestedExactSearchBackend,
    requestedWorkers,
  });
  if (requestedWorkers > 1 && exactSearchBackend !== 'parallel-js') {
    console.log('提示: 当前精确穷举控制后端不启用分片并行，--workers 将按 1 处理。');
  } else if (requestedWorkers > 1 && exactSearchBackend === 'parallel-js') {
    console.log(`提示: 已启用精确穷举分片并行，worker 数=${requestedWorkers}。`);
  }
  if (exportYrpArg !== undefined && enumerateOpenings) {
    console.log('提示: 穷举多组起手时暂不导出 replay，已忽略 --export-yrp。');
  }

  console.log(`随机种子: ${seed}`);
  console.log(`搜索模式: 精确DFS(统一穷举) | 引擎:${engineBackend} | 控制:${exactSearchBackend}`);
  console.log(`我方起手: ${openingCards.length > 0 ? openingCards.join(', ') : enumerateOpenings ? `全枚举 ${drawCount} 张组合` : '按种子抽样'}`);
  console.log(`对方起手: ${opponentOpeningCards.length > 0 ? opponentOpeningCards.join(', ') : '按种子抽样'}`);

  const cardRuntime = await createCardTextRuntime(resourcePaths.cardsPath);
  try {
    const playerDeckInstances = createDeckCardInstances(playerDeck, cardRuntime.cardText);
    const search = await runExhaustiveOpeningSearch({
      resourcePaths,
      seed,
      drawCount,
      maxDepth,
      maxNodes,
      targetTerminals,
      maxBeamWidth,
      maxActionsPerNode,
      snapshotPoolSize,
      topK,
      expandScriptKeywords,
      yrpVersion,
      playerDeck,
      opponentDeck,
      playerDeckInstances,
      fixedOpeningCodes: openingCards,
      fixedOpponentOpeningCodes: opponentOpeningCards,
      enumerateOpenings,
      scoringRules: [],
      engineBackend,
      exactSearchBackend,
      workers: exactSearchBackend === 'parallel-js' ? requestedWorkers : 1,
      progressEvery: Math.max(10, Math.floor(maxNodes / 500)),
      profileCore,
      verbose,
    });

    if (verbose) {
      const loadedPkgs = [
        ygoproCdb ? 'ygopro-cdb-encode' : null,
        ygopro ? 'ygopro-msg-encode' : null,
        ygoproYrp ? 'ygopro-yrp-encode' : null,
      ].filter(Boolean);
      console.log(`快照页差分加速: ${snapshotAccelMode}`);
      console.log(`已加载编码库: ${loadedPkgs.join(', ') || '无'}`);
    }

    console.log(`\n===== Top ${topK} 最长路径 =====`);
    search.searchResults.forEach((item, idx) => {
      const chainText = item.chain.length > 0 ? item.chain.join(' -> ') : '[无可执行展开链]';
      console.log(`\n#${idx + 1} | 步数: ${item.depth} | 评分: ${item.score.toFixed(2)}`);
      console.log(`起手: ${item.openingCodes.join(', ') || '未指定'}`);
      console.log(chainText);
      if (verbose) {
        console.log(`终止原因: ${item.reason || '未知'}`);
      }
    });
    console.log(`\n穷举起手组数: ${search.exploredOpenings}`);
    console.log(`累计搜索节点: ${search.totalNodes} | 累计终局分支: ${search.totalTerminals}`);
    if (search.truncated) {
      console.log('注意: 至少一组起手触及 max-nodes，结果可能尚未完全穷尽。');
    }
    if (exportYrpArg !== undefined && !enumerateOpenings) {
      const exported = await exportCliSearchResults({
        search,
        resourcePaths,
        drawCount,
        yrpVersion,
        playerDeck,
        opponentDeck,
        seed,
        maxDepth,
        maxNodes,
        targetTerminals,
        maxBeamWidth,
        maxActionsPerNode,
        snapshotPoolSize,
        expandScriptKeywords,
        exportYrpArg,
      });
      if (exported.files.length > 0) {
        console.log(`\n已导出 replay 到: ${exported.outputDir}`);
        exported.files.forEach((file, idx) => {
          console.log(
            `#${idx + 1} replay | 深度 ${file.depth} | ${file.byteLength} bytes | ${file.path}`,
          );
        });
      }
    }
    if (profileCore && Array.isArray(search.profileRows) && search.profileRows.length > 0) {
      printProfileRows(search.profileRows);
    } else {
      printCoreProfileStats();
    }
  } finally {
    cardRuntime.db.close();
  }
}

function createWebArchiveApi() {
  return {
    prepareWebSearchRequest,
    buildWebArchiveDocument,
    writeJsonAtomic,
    loadPartialWebArchiveCheckpoint,
    buildFinalResultFromArchiveState,
    buildReplayFilesFromArchiveDocument,
    shouldResumeTruncatedWebArchive,
    deserializeFullSearchResult,
    createPublicWebResult,
    readJsonIfExists,
  };
}

module.exports = {
  parseYdkText,
  parseYdk,
  createDeckCardInstances,
  createCardTextRuntime,
  createSearchContext,
  createDeckView,
  resolveResourcePaths,
  buildFixedOpening,
  simulateOpeningHand,
  cleanupRuntime,
  resolveCardImageFile,
  estimateOrderedSelectionCount,
};

const {
  runWorkerThread,
  runChildWorkerProcess,
} = createWorkerEntryApi({
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
});

if (process.env.COMBO_SIMULATOR_CHILD === '1') {
  runChildWorkerProcess().catch((err) => {
    if (typeof process.send === 'function') {
      process.send({ type: 'error', error: err?.message ?? String(err) });
    }
    process.exit(1);
  });
} else if (!isMainThread && ['search-worker', 'web-search-worker', 'parallel-exact-worker'].includes(workerData?.type)) {
  runWorkerThread().catch((err) => {
    if (parentPort) {
      parentPort.postMessage({ type: 'error', error: err?.message ?? String(err) });
    }
    process.exit(1);
  });
} else if (require.main === module) {
  console.error('[combo-simulator] Direct search CLI is disabled. Use the YGO tools registered by the DeepSeek Harness plugin.');
  process.exit(1);
}
