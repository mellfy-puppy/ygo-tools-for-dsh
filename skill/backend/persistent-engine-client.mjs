import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_ENGINE_HOST,
  DEFAULT_ENGINE_PORT,
  ENGINE_HOST_PROTOCOL,
} from './persistent-engine-server.mjs';

const SERVER_ENTRY = fileURLToPath(new URL('./persistent-engine-server.mjs', import.meta.url));

export function createPersistentEngineClient(options = {}) {
  const hostname = readString(options.hostname ?? process.env.YGO_ENGINE_HOST) ?? DEFAULT_ENGINE_HOST;
  const port = normalizePort(options.port ?? process.env.YGO_ENGINE_HOST_PORT ?? DEFAULT_ENGINE_PORT);
  const baseUrl = `http://${hostname}:${port}`;
  const autoStart = options.autoStart !== false;
  const startupTimeoutMs = normalizeTimeout(options.startupTimeoutMs, 15000);
  let starting = null;

  async function health(requestOptions = {}) {
    try {
      const result = await requestJson(`${baseUrl}/health`, {
        signal: requestOptions.signal,
        timeoutMs: normalizeTimeout(requestOptions.timeoutMs, 1500),
      });
      if (result.protocol !== ENGINE_HOST_PROTOCOL) {
        return { ok: false, code: 'ENGINE_HOST_PROTOCOL_MISMATCH', error: `Port ${port} is occupied by an incompatible service.` };
      }
      return result;
    } catch (error) {
      // A caller cancellation is not evidence that the host is unavailable.
      requestOptions.signal?.throwIfAborted();
      return { ok: false, code: 'ENGINE_HOST_UNAVAILABLE', error: error instanceof Error ? error.message : String(error) };
    }
  }

  async function ensureStarted(requestOptions = {}) {
    const { signal } = requestOptions;
    signal?.throwIfAborted();
    const current = await health({ signal });
    if (current.ok) return current;
    if (current.code === 'ENGINE_HOST_PROTOCOL_MISMATCH' || !autoStart) throw new Error(current.error);
    signal?.throwIfAborted();
    if (!starting) {
      starting = startDetachedHost({
        hostname,
        port,
        env: { ...process.env, ...asRecord(options.serverEnv) },
      }).finally(() => { starting = null; });
    }
    // The detached host is shared by other sessions. Cancelling this wait must
    // never kill it or submit a shutdown request.
    await waitWithSignal(starting, signal);
    const deadline = Date.now() + startupTimeoutMs;
    let last;
    while (Date.now() < deadline) {
      last = await health({ signal, timeoutMs: Math.min(1500, deadline - Date.now()) });
      if (last.ok) return last;
      if (last.code === 'ENGINE_HOST_PROTOCOL_MISMATCH') throw new Error(last.error);
      await delay(Math.min(75, Math.max(0, deadline - Date.now())), signal);
    }
    throw new Error(`Persistent engine host did not become ready within ${startupTimeoutMs} ms: ${last?.error ?? 'unknown error'}`);
  }

  async function execute(call, executeOptions = {}) {
    const timeoutMs = normalizeTimeout(executeOptions.timeoutMs, 120000);
    const scope = abortScope(executeOptions.signal, timeoutMs);
    try {
      await ensureStarted({ signal: scope.signal });
      return await requestJson(`${baseUrl}/execute`, {
        method: 'POST',
        body: { call, sessionId: executeOptions.sessionId ?? 'default' },
        signal: scope.signal,
        timeoutMs,
      });
    } finally {
      scope.dispose();
    }
  }

  async function listTools(requestOptions = {}) {
    await ensureStarted(requestOptions);
    const result = await requestJson(`${baseUrl}/tools`, { timeoutMs: 5000, signal: requestOptions.signal });
    return result.tools;
  }

  return { hostname, port, baseUrl, health, ensureStarted, execute, listTools };
}

function startDetachedHost(options) {
  return new Promise((resolve, reject) => {
    try {
      const child = spawn(process.execPath, [SERVER_ENTRY, '--host', options.hostname, '--port', String(options.port)], {
        detached: true,
        env: options.env,
        stdio: 'ignore',
        windowsHide: true,
      });
      const onError = (error) => {
        child.off('spawn', onSpawn);
        reject(error);
      };
      const onSpawn = () => {
        child.off('error', onError);
        child.unref();
        resolve();
      };
      child.once('error', onError);
      child.once('spawn', onSpawn);
    } catch (error) {
      reject(error);
    }
  });
}

async function requestJson(url, options = {}) {
  const scope = abortScope(options.signal, normalizeTimeout(options.timeoutMs, 5000));
  try {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: scope.signal,
    });
    const text = await response.text();
    let value;
    try {
      value = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Persistent engine host returned invalid JSON with HTTP ${response.status}.`);
    }
    if (!response.ok) throw new Error(value.error ?? `Persistent engine host returned HTTP ${response.status}.`);
    return value;
  } finally {
    scope.dispose();
  }
}

function normalizePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid persistent engine host port: ${value}`);
  return port;
}

function normalizeTimeout(value, fallback) {
  const timeout = Number(value);
  return Number.isFinite(timeout) && timeout > 0 ? Math.max(1, Math.trunc(timeout)) : fallback;
}

function abortScope(source, timeoutMs) {
  source?.throwIfAborted();
  const controller = new AbortController();
  const onAbort = () => controller.abort(source.reason);
  source?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    controller.abort(new DOMException(`Persistent engine request timed out after ${timeoutMs} ms.`, 'TimeoutError'));
  }, timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      source?.removeEventListener('abort', onAbort);
    },
  };
}

function waitWithSignal(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

function delay(ms, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function readString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
