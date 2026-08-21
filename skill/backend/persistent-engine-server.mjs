#!/usr/bin/env node
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createModelToolHost } from './model-tool-host.mjs';

export const ENGINE_HOST_PROTOCOL = 'ygoagentskill-engine-host-v1';
export const DEFAULT_ENGINE_HOST = '127.0.0.1';
export const DEFAULT_ENGINE_PORT = 19981;
const MAX_RESPONSE_ARRAY_ITEMS = 2000;
const MAX_RESPONSE_STRING_LENGTH = 1024 * 1024;
const MAX_RESPONSE_NODES = 20000;

export function createPersistentEngineServer(options = {}) {
  const hostname = readString(options.hostname) ?? DEFAULT_ENGINE_HOST;
  const port = normalizePort(options.port ?? DEFAULT_ENGINE_PORT);
  const startedAt = new Date().toISOString();
  let closing = false;
  let server;
  const host = createModelToolHost(options.backendConfig ?? {}, {
    onShutdown() {
      closing = true;
      server?.close(() => {
        if (options.exitOnShutdown === true) process.exit(0);
      });
    },
  });

  server = createServer(async (request, response) => {
    try {
      setJsonHeaders(response);
      if (request.method === 'GET' && request.url === '/health') {
        return sendJson(response, 200, {
          ok: true,
          protocol: ENGINE_HOST_PROTOCOL,
          pid: process.pid,
          hostname,
          port,
          startedAt,
          closing,
          sessionCount: host.sessions.size,
        });
      }
      if (request.method === 'GET' && request.url?.startsWith('/tools')) {
        return sendJson(response, 200, {
          ok: true,
          protocol: ENGINE_HOST_PROTOCOL,
          tools: host.listTools(),
        });
      }
      if (request.method === 'POST' && request.url === '/execute') {
        const body = await readJsonBody(request);
        const result = await host.execute(body.call ?? body, { sessionId: body.sessionId });
        return sendJson(response, 200, result);
      }
      return sendJson(response, 404, { ok: false, code: 'NOT_FOUND', error: 'Unknown persistent engine host endpoint.' });
    } catch (error) {
      return sendJson(response, 500, {
        ok: false,
        code: 'ENGINE_HOST_REQUEST_FAILED',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return {
    host,
    server,
    hostname,
    port,
    startedAt,
    start: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, hostname, () => {
        server.off('error', reject);
        resolve({ hostname, port, startedAt, pid: process.pid });
      });
    }),
    close: () => new Promise((resolve, reject) => {
      for (const sessionId of host.listSessions()) host.deleteSession(sessionId);
      if (!server.listening) return resolve();
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16 * 1024 * 1024) throw new Error('Persistent engine request body exceeds 16 MiB.');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function setJsonHeaders(response) {
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
}

function sendJson(response, status, value) {
  response.statusCode = status;
  response.end(JSON.stringify(boundJsonValue(value)));
}

function boundJsonValue(value) {
  const state = { nodes: 0, truncated: false };
  const output = visitJsonValue(value, state, '$', 0);
  if (state.truncated && output && typeof output === 'object' && !Array.isArray(output)) {
    output.responseTruncated = true;
    output.responseTruncationReason = 'Persistent engine response exceeded structured size limits.';
  }
  return output;
}

export function boundPersistentEngineResponse(value) {
  return boundJsonValue(value);
}

function visitJsonValue(value, state, path, depth) {
  state.nodes += 1;
  if (state.nodes > MAX_RESPONSE_NODES || depth > 24) {
    state.truncated = true;
    return { truncated: true, path };
  }
  if (typeof value === 'string') {
    if (value.length <= MAX_RESPONSE_STRING_LENGTH) return value;
    state.truncated = true;
    return `${value.slice(0, MAX_RESPONSE_STRING_LENGTH)}...[truncated ${value.length - MAX_RESPONSE_STRING_LENGTH} chars]`;
  }
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Uint8Array) {
    if (value.length <= MAX_RESPONSE_ARRAY_ITEMS) return Array.from(value);
    state.truncated = true;
    return { byteLength: value.length, base64Prefix: Buffer.from(value.subarray(0, 768)).toString('base64'), truncated: true };
  }
  if (Array.isArray(value)) {
    const limit = Math.min(value.length, MAX_RESPONSE_ARRAY_ITEMS);
    const output = new Array(limit);
    for (let index = 0; index < limit; index += 1) output[index] = visitJsonValue(value[index], state, `${path}[${index}]`, depth + 1);
    if (limit < value.length) {
      state.truncated = true;
      output.push({ truncatedItems: value.length - limit, totalItems: value.length });
    }
    return output;
  }
  const output = {};
  for (const [key, entry] of Object.entries(value)) output[key] = visitJsonValue(entry, state, `${path}.${key}`, depth + 1);
  return output;
}

function normalizePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid persistent engine host port: ${value}`);
  return port;
}

function readString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  const args = parseArgs(process.argv.slice(2));
  const instance = createPersistentEngineServer({
    hostname: args.host ?? process.env.YGO_ENGINE_HOST,
    port: args.port ?? process.env.YGO_ENGINE_HOST_PORT,
    exitOnShutdown: true,
  });
  await instance.start();
  const stop = async () => {
    await instance.close();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

function parseArgs(args) {
  const output = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--host') output.host = args[++index];
    else if (args[index] === '--port') output.port = args[++index];
  }
  return output;
}
