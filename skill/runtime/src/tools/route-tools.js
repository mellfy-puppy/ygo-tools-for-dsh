// @ts-check

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateVerifiedRouteReport } from './route-validation.js';
import { checkFileWriteAuthorization } from './file-write-policy.js';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_ROUTES_DIR = resolve(PROJECT_ROOT, 'routes');
const MAX_ROUTE_CONTENT_LENGTH = 200000;

/**
 * Save a route report produced from verified tool results.
 *
 * @param {unknown} _context
 * @param {unknown} input
 */
export async function saveRouteFile(context, input = {}) {
  const authorization = checkFileWriteAuthorization(context, input, 'saveRouteFile');
  if (!authorization.ok) return authorization;
  const record = asRecord(input);
  const content = readNonEmptyString(record.content);
  if (!content) return { ok: false, error: 'saveRouteFile requires non-empty content.' };
  if (content.length > MAX_ROUTE_CONTENT_LENGTH) {
    return { ok: false, error: `saveRouteFile content is too large; max ${MAX_ROUTE_CONTENT_LENGTH} characters.` };
  }

  const validation = validateVerifiedRouteReport(context, content);
  if (!validation.ok) return validation;

  const format = normalizeFormat(record.format);
  const fileName = buildSafeFileName(
    readNonEmptyString(record.fileName) ?? readNonEmptyString(record.title) ?? 'route',
    format,
  );
  const outputPath = resolve(DEFAULT_ROUTES_DIR, fileName);
  if (!outputPath.startsWith(`${DEFAULT_ROUTES_DIR}\\`) && outputPath !== DEFAULT_ROUTES_DIR) {
    return { ok: false, error: 'saveRouteFile resolved outside routes directory.' };
  }

  await mkdir(DEFAULT_ROUTES_DIR, { recursive: true });
  await writeFile(outputPath, content, 'utf8');
  return {
    ok: true,
    data: {
      path: outputPath,
      fileName,
      bytes: Buffer.byteLength(content, 'utf8'),
      format,
      warnings: validation.warnings ?? [],
    },
  };
}

export const saveRouteFileTool = {
  name: 'saveRouteFile',
  description: 'Explicitly save a user-requested verified combo/route report. Hidden during normal memory-only operation.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      fileName: { type: 'string' },
      format: { type: 'string', enum: ['markdown', 'json', 'txt'] },
      content: { type: 'string' },
    },
    required: ['content'],
    additionalProperties: false,
  },
  execute: saveRouteFile,
};

/** @param {unknown} value */
function normalizeFormat(value) {
  const format = readNonEmptyString(value)?.toLowerCase();
  if (format === 'json' || format === 'txt') return format;
  return 'markdown';
}

/**
 * @param {string} rawName
 * @param {string} format
 */
function buildSafeFileName(rawName, format) {
  const extension = format === 'json' ? '.json' : format === 'txt' ? '.txt' : '.md';
  const base = rawName
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'route';
  return base.toLowerCase().endsWith(extension) ? base : `${base}${extension}`;
}

/** @param {unknown} value */
function readNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/** @param {unknown} value */
function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : {};
}
