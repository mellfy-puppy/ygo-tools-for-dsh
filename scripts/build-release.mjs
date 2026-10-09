#!/usr/bin/env node
// Builds the two release packages:
//   external   - plugin only; the user supplies their own YGOPro2 client.
//   integrated - plugin plus a YGOPro2 client (no card pictures) so a human
//                can play the model without installing anything else.
//
// Usage:
//   node scripts/build-release.mjs external
//   node scripts/build-release.mjs integrated --client <YGOPro2 folder>
//   node scripts/build-release.mjs stage-client --client <YGOPro2 folder>
//     (only copies the client into skill/resources/ygopro2-client for local testing)
import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT_DIR = join(REPO, 'skill', 'resources', 'ygopro2-client');
const CLIENT_SOURCE_URL = 'https://github.com/lllyasviel/YGOProUnity_V2';

// Plugin files that never belong in a release (local data, caches, build output).
const PLUGIN_EXCLUDES = [
  /^skill[\\/](\.cache|output)([\\/]|$)/,
  /^skill[\\/]resources[\\/]ygopro2-client([\\/]|$)/,
  /[\\/](bin|obj)([\\/]|$)/,
  /(^|[\\/])node_modules([\\/]|$)/,
  /\.(log|tgz)$/i,
];
const VENDOR_NODE_MODULES = /^skill[\\/]vendor[\\/]node_modules([\\/]|$)/;

// Client entries that are personal, oversized, or replaced by the plugin.
const CLIENT_EXCLUDES = [
  /^picture([\\/]|$)/i,             // card art: large and not ours to redistribute
  /^replay([\\/]|$)/i,
  /^deck([\\/]|$)/i,
  /^WindBot([\\/]|$)/i,             // the plugin brings its own WindBot
  /^AI\.Server\.exe$/i,             // the plugin brings its own server
  /^Uninst\.exe$/i,
  /^commamd\.shell$/i,
  /^\d{4}-\d{2}-\d{2}_\d+([\\/]|$)/,
  /^backup-/i,
  /^\.ygomobile-/i,
  /^expansions([\\/]|$)/i,          // refilled from the plugin's prerelease data
  /^cdb([\\/]|$)/i,                 // refilled from the plugin's card database
  /output_log\.txt$/i,
];

async function main() {
  const [variant, ...rest] = process.argv.slice(2);
  const clientIndex = rest.indexOf('--client');
  const clientSource = clientIndex >= 0 ? resolve(rest[clientIndex + 1] ?? '') : null;
  if (!['external', 'integrated', 'stage-client'].includes(variant)) {
    throw new Error('Usage: build-release.mjs external | integrated --client <YGOPro2 folder> | stage-client --client <YGOPro2 folder>');
  }
  if (variant !== 'external' && !clientSource) throw new Error(`${variant} needs --client <YGOPro2 folder>.`);
  if (clientSource) await requireFile(join(clientSource, 'YGOPro2.exe'), 'YGOPro2.exe was not found in the --client folder.');

  if (variant === 'stage-client') {
    await stageClient(clientSource, CLIENT_DIR, join(REPO, 'skill', 'resources', 'lib'));
    console.log(`Staged client at ${CLIENT_DIR}`);
    return;
  }

  const pkg = JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8'));
  const stageRoot = join(REPO, 'dist', `stage-${variant}`);
  const stage = join(stageRoot, 'package');
  await rm(stageRoot, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });

  await cp(join(REPO, 'package.json'), join(stage, 'package.json'));
  for (const entry of pkg.files ?? []) {
    const source = join(REPO, entry);
    if (!(await exists(source))) continue;
    await cp(source, join(stage, entry), { recursive: true, filter: (path) => keepPluginPath(relative(REPO, path)) });
  }
  if (variant === 'integrated') {
    await stageClient(clientSource, join(stage, 'skill', 'resources', 'ygopro2-client'), join(stage, 'skill', 'resources', 'lib'));
  }

  const output = join(REPO, 'dist', `${pkg.name}-${pkg.version}-${variant}.tgz`);
  await rm(output, { force: true });
  await run('tar', ['-czf', output, '-C', stageRoot, 'package']);
  await rm(stageRoot, { recursive: true, force: true });
  const size = (await stat(output)).size;
  console.log(`${basename(output)}  ${(size / 1024 / 1024).toFixed(1)} MB`);
}

function keepPluginPath(path) {
  if (!path) return true;
  if (VENDOR_NODE_MODULES.test(path)) return true;
  return !PLUGIN_EXCLUDES.some((pattern) => pattern.test(path));
}

// Copies a clean client: no personal data, no pictures, the plugin's card data,
// a neutral config, and a notice that names the client's license and source.
async function stageClient(source, target, libDir) {
  await rm(target, { recursive: true, force: true });
  await cp(source, target, {
    recursive: true,
    filter: (path) => {
      const rel = relative(source, path);
      return !rel || !CLIENT_EXCLUDES.some((pattern) => pattern.test(rel));
    },
  });
  for (const dir of ['deck', 'replay', 'picture', 'cdb', 'expansions']) await mkdir(join(target, dir), { recursive: true });
  await cp(join(libDir, 'cards.cdb'), join(target, 'cdb', 'cards.cdb'));
  for (const name of ['test-release.cdb', 'test-update.cdb']) {
    const from = join(libDir, 'prerelease', name);
    if (await exists(from)) await cp(from, join(target, 'expansions', name));
  }
  await cp(join(libDir, 'lflist.conf'), join(target, 'config', 'lflist.conf'));

  const configPath = join(target, 'config', 'config.conf');
  if (await exists(configPath)) {
    const config = (await readFile(configPath, 'utf8'))
      .replace(/^name->.*$/m, 'name->Player')
      .replace(/^deckInUse->.*$/m, 'deckInUse->');
    await writeFile(configPath, config, 'utf8');
  }
  await writeFile(join(target, 'config', 'hosts.conf'), '', 'utf8');
  await writeFile(join(target, 'NOTICE.md'), [
    '# Bundled YGOPro2 client',
    '',
    'This folder contains the YGOPro2 client (YGOProUnity_V2), licensed under the',
    'GNU General Public License v3; see LICENSE in this folder.',
    '',
    `Source code: ${CLIENT_SOURCE_URL}`,
    '',
    'Card pictures are not included. Card data in cdb/ and expansions/ is copied',
    'from the plugin and refreshed when the plugin opens a room.',
    '',
  ].join('\n'), 'utf8');
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

async function requireFile(path, message) {
  if (!(await exists(path))) throw new Error(message);
}

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${command} failed: ${stderr || error.message}`));
      else resolvePromise(stdout);
    });
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
