const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_YGOPRO_ROOT = path.resolve(ROOT, '../ygopro');
const YGOPRO_ROOT = process.env.YGOPRO_PATH
  ? path.resolve(process.env.YGOPRO_PATH)
  : DEFAULT_YGOPRO_ROOT;
const COMMON_H = path.join(YGOPRO_ROOT, 'ocgcore', 'common.h');
const DEFAULT_COMMON_H = path.join(DEFAULT_YGOPRO_ROOT, 'ocgcore', 'common.h');
const NETWORK_H = path.join(YGOPRO_ROOT, 'gframe', 'network.h');
const SCRIPT_CONSTANT_LUA = path.join(YGOPRO_ROOT, 'script', 'constant.lua');
const OUT_OCORE = path.join(ROOT, 'src', 'vendor', 'ocgcore-constants.ts');
const OUT_SCRIPT = path.join(ROOT, 'src', 'vendor', 'script-constants.ts');

function readFileSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    console.error(`[gen-constants] Failed to read: ${file}`);
    throw err;
  }
}

function existingFiles(files) {
  return Array.from(new Set(files)).filter((file) => fs.existsSync(file));
}

function parseNumber(raw) {
  const cleaned = raw.replace(/\s+/g, '');
  if (/^0x[0-9a-fA-F]+$/.test(cleaned)) return Number.parseInt(cleaned, 16);
  if (/^\d+$/.test(cleaned)) return Number.parseInt(cleaned, 10);
  return null;
}

function sanitizeExpr(expr) {
  return expr
    .replace(/\/\/.*$/g, '')
    .replace(/\/\*.*?\*\//g, '')
    .replace(/((?:0x[0-9a-f]+)|(?:\d+))(ull|ul|u|ll|l)\b/gi, '$1')
    .replace(/\bU\b/gi, '')
    .replace(/\bUL\b/gi, '')
    .replace(/\bULL\b/gi, '')
    .replace(/\bL\b/gi, '')
    .replace(/\s+/g, '');
}

function evalExpr(expr, constants) {
  const clean = sanitizeExpr(expr);
  const tokens = clean
    .replace(/<<|>>/g, (m) => ` ${m} `)
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((token) => token.split(/([+\-*/()|&~^<>])/).filter(Boolean));

  const values = tokens.map((t) => {
    if (
      t === '+' ||
      t === '-' ||
      t === '*' ||
      t === '/' ||
      t === '(' ||
      t === ')' ||
      t === '|' ||
      t === '&' ||
      t === '~' ||
      t === '^' ||
      t === '<' ||
      t === '>' ||
      t === '<<' ||
      t === '>>'
    ) {
      return t;
    }
    const num = parseNumber(t);
    if (num !== null) return num;
    if (Object.prototype.hasOwnProperty.call(constants, t)) return constants[t];
    return NaN;
  });

  if (values.some((v) => Number.isNaN(v))) {
    return null;
  }

  const exprStr = values.join('');
  // eslint-disable-next-line no-new-func
  return Function(`"use strict";return (${exprStr});`)();
}

function parseCDefines(source) {
  const lines = source.split(/\r?\n/);
  const constants = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('#define ')) continue;
    const content = trimmed.slice('#define '.length).trim();
    if (!content) continue;
    const parts = content.split(/\s+/);
    const name = parts.shift();
    if (!name) continue;
    if (name.includes('(')) continue; // macro with args
    const valueRaw = parts.join(' ');
    if (!valueRaw) continue;
    const value = evalExpr(valueRaw, constants);
    if (typeof value === 'number' && Number.isFinite(value)) {
      constants[name] = value;
    }
  }

  return constants;
}

function parseLuaConstants(source) {
  const lines = source.split(/\r?\n/);
  const constants = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('--')) continue;
    const match = /^([A-Z0-9_]+)\s*=\s*([^\-]+?)(?:\s+--.*)?$/.exec(trimmed);
    if (!match) continue;
    const name = match[1];
    const valueRaw = match[2].trim();
    const value = evalExpr(valueRaw, constants);
    if (typeof value === 'number' && Number.isFinite(value)) {
      constants[name] = value;
    }
  }

  return constants;
}

function emitConstantsTs(objectName, constants, sourcePath) {
  const keys = Object.keys(constants).sort();
  const lines = [];
  lines.push(`// Generated from ${sourcePath}`);
  lines.push(`export const ${objectName} = {`);
  for (const key of keys) {
    const value = constants[key];
    lines.push(`  ${key}: ${value},`);
  }
  lines.push(`} as const;`);
  lines.push('');
  return lines.join('\n');
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

function main() {
  const commonSources = existingFiles([DEFAULT_COMMON_H, COMMON_H, NETWORK_H]);
  const commonSource = commonSources.map((file) => readFileSafe(file)).join('\n');
  const luaSource = readFileSafe(SCRIPT_CONSTANT_LUA);

  const ocgcoreConstants = parseCDefines(commonSource);
  const scriptConstants = parseLuaConstants(luaSource);

  writeFile(OUT_OCORE, emitConstantsTs('OcgcoreCommonConstants', ocgcoreConstants, commonSources.join(' + ')));
  writeFile(OUT_SCRIPT, emitConstantsTs('OcgcoreScriptConstants', scriptConstants, SCRIPT_CONSTANT_LUA));

  console.log(`[gen-constants] Wrote ${Object.keys(ocgcoreConstants).length} common.h constants`);
  console.log(`[gen-constants] Wrote ${Object.keys(scriptConstants).length} constant.lua constants`);
}

main();
