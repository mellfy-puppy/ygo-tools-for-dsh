'use strict';

const EXACT_SEARCH_BACKENDS = ['auto', 'js', 'parallel-js'];

function normalizeExactSearchBackend(value = 'auto') {
  const normalized = String(value ?? 'auto').trim().toLowerCase();
  if (!EXACT_SEARCH_BACKENDS.includes(normalized)) {
    throw new Error(`--exact-search-backend 无效: ${value}`);
  }
  return normalized;
}

function resolveExactSearchBackend({
  requestedEngineBackend = 'auto',
  requestedExactSearchBackend = 'auto',
  requestedWorkers = 1,
} = {}) {
  const exactSearchBackend = normalizeExactSearchBackend(requestedExactSearchBackend);
  const engineBackend =
    requestedEngineBackend === 'native'
      ? 'native'
      : 'wasm';
  const workerCount = Math.max(1, requestedWorkers | 0);
  const effectiveExactSearchBackend =
    exactSearchBackend === 'auto'
      ? workerCount > 1
        ? 'parallel-js'
        : 'js'
      : exactSearchBackend;
  return {
    engineBackend,
    exactSearchBackend: effectiveExactSearchBackend,
  };
}

module.exports = {
  EXACT_SEARCH_BACKENDS,
  normalizeExactSearchBackend,
  resolveExactSearchBackend,
};
