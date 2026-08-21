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

  async function health() {
    try {
      const result = await requestJson(`${baseUrl}/health`, { timeoutMs: 1500 });
      if (result.protocol !== ENGINE_HOST_PROTOCOL) {
        return { ok: false, code: 'ENGINE_HOST_PROTOCOL_MISMATCH', error: `Port ${port} is occupied by an incompatible service.` };
      }
      return result;
    } catch (error) {
      return { ok: false, code: 'ENGINE_HOST_UNAVAILABLE', error: error instanceof Error ? error.message : String(error) };
    }
  }

  async function ensureStarted() {
    const current = await health();
    if (current.ok) return current;
    if (current.code === 'ENGINE_HOST_PROTOCOL_MISMATCH' || !autoStart) throw new Error(current.error);
    if (!starting) {
      starting = startDetachedHost({
        hostname,
        port,
        env: { ...process.env, ...asRecord(options.serverEnv) },
      }).finally(() => { starting = null; });
    }
    await starting;
    const deadline = Date.now() + startupTimeoutMs;
    let last;
    while (Date.now() < deadline) {
      last = await health();
      if (last.ok) return last;
      if (last.code === 'ENGINE_HOST_PROTOCOL_MISMATCH') throw new Error(last.error);
      await delay(75);
    }
    throw new Error(`Persistent engine host did not become ready within ${startupTimeoutMs} ms: ${last?.error ?? 'unknown error'}`);
  }

  async function execute(call, executeOptions = {}) {
    await ensureStarted();
    return requestJson(`${baseUrl}/execute`, {
      method: 'POST',
      body: { call, sessionId: executeOptions.sessionId ?? 'default' },
      timeoutMs: normalizeTimeout(executeOptions.timeoutMs, 120000),
    });
  }

  async function listTools() {
    await ensureStarted();
    const result = await requestJson(`${baseUrl}/tools`, { timeoutMs: 5000 });
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
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(normalizeTimeout(options.timeoutMs, 5000)),
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
}

function normalizePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid persistent engine host port: ${value}`);
  return port;
}

function normalizeTimeout(value, fallback) {
  const timeout = Number(value);
  return Number.isFinite(timeout) && timeout > 0 ? Math.trunc(timeout) : fallback;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
