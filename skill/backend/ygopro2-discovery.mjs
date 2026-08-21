import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENV_ROOT_KEYS = Object.freeze(['YGO_YGOPRO2_ROOT', 'YGOPRO2_ROOT', 'YGO_PRO2_ROOT']);
const ENV_SEARCH_KEYS = Object.freeze(['YGO_YGOPRO2_SEARCH_ROOTS', 'YGOPRO2_SEARCH_ROOTS']);
const ENV_EXTERNAL_POLICY_KEYS = Object.freeze(['YGO_EXTERNAL_WINDBOT_ROOT', 'YGO_WINDBOT_BRIDGE_ROOT']);
const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLED_EXTERNAL_POLICY_ROOT = resolve(SKILL_ROOT, 'resources', 'ygopro2-bridge', 'windbot');
const SKIP_DIRECTORY_NAMES = new Set([
  '.git', '.cache', 'node_modules', 'artifacts', 'obj', 'bin',
  'YGOPro2_Data', 'Library', 'Temp', 'packages',
]);

/**
 * Discover a local YGOPro2 installation without assuming a drive, username,
 * checkout location, or frontend. The result is suitable for storing in a
 * session metadata record; this function never writes a file or starts a
 * process.
 */
export async function discoverYgoPro2(input = {}, environment = process.env) {
  const options = normalizeOptions(input, environment);
  const roots = uniquePaths([
    ...options.explicitRoots,
    ...options.environmentRoots,
    ...(options.standardLocations ? standardRoots(environment) : []),
  ]);
  const searchedRoots = [];
  const diagnostics = [];
  const candidates = new Map();

  const externalPolicyClients = [];
  for (const root of options.externalPolicyRoots) {
    const client = await inspectExternalPolicyClient(root);
    if (client) externalPolicyClients.push(client);
  }
  const selectedExternalPolicyClient = externalPolicyClients[0] ?? null;

  for (const root of roots) {
    if (!(await isDirectory(root))) {
      diagnostics.push({ root, status: 'missing' });
      continue;
    }
    searchedRoots.push({ root, source: rootSource(root, options) });
    await inspectCandidate(root, candidates, options, diagnostics);
    if (options.scan) await scanRoot(root, candidates, options, diagnostics);
  }

  const installations = (await Promise.all(
    [...candidates.values()].map((candidate) => finalizeCandidate(candidate, selectedExternalPolicyClient)),
  )).sort(compareCandidates);
  const selected = installations[0] ?? null;
  return {
    ok: true,
    data: {
      schemaVersion: 1,
      recordedAt: new Date().toISOString(),
      found: installations.length > 0,
      selected,
      installations,
      selectedExternalPolicyClient,
      externalPolicyClients,
      searchedRoots,
      diagnostics,
      search: {
        scan: options.scan,
        maxDepth: options.maxDepth,
        maxDirectories: options.maxDirectories,
      },
    },
  };
}

function normalizeOptions(input, environment) {
  const record = asRecord(input);
  const explicitRoots = [record.root, ...(Array.isArray(record.roots) ? record.roots : [])]
    .filter(isPath)
    .map((value) => resolve(value));
  const environmentRoots = ENV_ROOT_KEYS
    .map((key) => environment[key])
    .filter(isPath)
    .map((value) => resolve(value));
  const envSearchRoots = ENV_SEARCH_KEYS
    .flatMap((key) => splitPathList(environment[key]))
    .map((value) => resolve(value));
  const searchRoots = [
    ...envSearchRoots,
    ...(Array.isArray(record.searchRoots) ? record.searchRoots : []),
  ].filter(isPath).map((value) => resolve(value));
  const externalPolicyRoots = uniquePaths([
    record.externalPolicyRoot,
    ...(Array.isArray(record.externalPolicyRoots) ? record.externalPolicyRoots : []),
    ...ENV_EXTERNAL_POLICY_KEYS.map((key) => environment[key]),
    BUNDLED_EXTERNAL_POLICY_ROOT,
  ]);
  return {
    explicitRoots: [...explicitRoots, ...searchRoots],
    environmentRoots,
    externalPolicyRoots,
    scan: record.scan !== false,
    standardLocations: record.standardLocations !== false,
    maxDepth: clampInteger(record.maxDepth, 2, 0, 6),
    maxDirectories: clampInteger(record.maxDirectories, 1200, 50, 10000),
    maxInstallations: clampInteger(record.maxInstallations, 20, 1, 100),
  };
}

function standardRoots(environment) {
  const home = environment.HOME || environment.USERPROFILE || homedir();
  const roots = [
    join(home, 'YGOPro2'),
    join(home, '.ygopro2'),
  ];
  if (platform() === 'win32') {
    const local = environment.LOCALAPPDATA;
    const roaming = environment.APPDATA;
    const programFiles = environment.ProgramFiles;
    const programFilesX86 = environment['ProgramFiles(x86)'];
    for (const base of [local, roaming, programFiles, programFilesX86]) {
      if (isPath(base)) roots.push(join(base, 'YGOPro2'), join(base, 'ygopro2'));
    }
    const username = environment.USERNAME;
    if (isPath(username)) {
      // Installers sometimes place the profile on a non-system drive while
      // leaving LOCALAPPDATA pointed at the system profile.
      for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
        const drive = `${letter}:\\`;
        roots.push(
          join(drive, 'Users', username, 'AppData', 'Local', 'YGOPro2'),
          join(drive, 'Users', username, 'AppData', 'Roaming', 'YGOPro2'),
        );
      }
    }
  } else if (platform() === 'darwin') {
    roots.push(join(home, 'Library', 'Application Support', 'YGOPro2'));
  } else {
    roots.push(join(home, '.local', 'share', 'YGOPro2'), '/opt/ygopro2', '/usr/local/share/ygopro2');
  }
  return roots;
}

async function scanRoot(root, candidates, options, diagnostics) {
  const queue = [{ directory: root, depth: 0 }];
  let visited = 0;
  while (queue.length > 0 && visited < options.maxDirectories) {
    const current = queue.shift();
    visited += 1;
    await inspectCandidate(current.directory, candidates, options, diagnostics);
    if (current.depth >= options.maxDepth) continue;
    let entries;
    try {
      entries = await readdir(current.directory, { withFileTypes: true });
    } catch (error) {
      diagnostics.push({ root: current.directory, status: 'unreadable', error: error?.code ?? String(error) });
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRECTORY_NAMES.has(entry.name)) continue;
      queue.push({ directory: join(current.directory, entry.name), depth: current.depth + 1 });
    }
  }
  if (visited >= options.maxDirectories) diagnostics.push({ root, status: 'scan-limit', maxDirectories: options.maxDirectories });
}

async function inspectCandidate(root, candidates, options, diagnostics) {
  const markerPaths = {
    serverExecutable: await firstExisting(root, ['AI.Server.exe', 'AI.Server', join('bin', 'AI.Server.exe')]),
    clientExecutable: await firstExisting(root, ['YGOPro2.exe', 'ygopro.exe', 'ygopro2.exe']),
    windbotExecutable: await firstExisting(root, [join('WindBot', 'WindBot.exe'), 'WindBot.exe', join('windbot', 'WindBot.exe')]),
    cardsDatabase: await firstExisting(root, [join('cdb', 'cards.cdb'), 'cards.cdb', join('database', 'cards.cdb')]),
    scriptsDirectory: await firstDirectory(root, ['script', 'scripts', join('data', 'script')]),
    replayDirectory: await firstDirectory(root, ['replay', 'replays']),
  };
  const markerCount = Object.values(markerPaths).filter(Boolean).length;
  if (markerCount === 0 || (markerCount === 1 && !/ygopro/i.test(basename(root)))) return;
  const existing = candidates.get(root) ?? {
    root,
    markerPaths: {},
    markerCount: 0,
    sources: [],
  };
  existing.markerPaths = { ...existing.markerPaths, ...markerPaths };
  existing.markerCount = Object.values(existing.markerPaths).filter(Boolean).length;
  existing.sources = uniqueStrings([...existing.sources, rootSource(root, options)]);
  candidates.set(root, existing);
  if (candidates.size > options.maxInstallations) {
    const oldest = candidates.keys().next().value;
    candidates.delete(oldest);
    diagnostics.push({ root, status: 'candidate-limit', maxInstallations: options.maxInstallations });
  }
}

async function finalizeCandidate(candidate, externalPolicyClient) {
  const paths = candidate.markerPaths;
  const bridgeComponentsFound = Boolean(paths.serverExecutable && paths.windbotExecutable && paths.cardsDatabase);
  const bridgeLaunchReady = Boolean(bridgeComponentsFound && externalPolicyClient?.verified);
  const capabilities = {
    aiServer: Boolean(paths.serverExecutable),
    guiClient: Boolean(paths.clientExecutable),
    windbotClient: Boolean(paths.windbotExecutable),
    cardsDatabase: Boolean(paths.cardsDatabase),
    scripts: Boolean(paths.scriptsDirectory),
    replayDirectory: Boolean(paths.replayDirectory),
    bridgeComponentsFound,
    externalPolicyClient: Boolean(externalPolicyClient?.verified),
    bridgeLaunchReady,
    liveDuelBridge: false,
  };
  const score = (Number(capabilities.aiServer) * 5)
    + (Number(capabilities.windbotClient) * 4)
    + (Number(capabilities.cardsDatabase) * 3)
    + (Number(capabilities.guiClient) * 2)
    + Number(capabilities.scripts)
    + Number(capabilities.replayDirectory);
  return {
    root: candidate.root,
    confidence: score >= 12 ? 'high' : score >= 7 ? 'medium' : 'low',
    score,
    sources: candidate.sources,
    paths,
    opponentAiProfiles: await discoverWindBotProfiles(paths.windbotExecutable),
    capabilities,
    interfaces: {
      aiServer: paths.serverExecutable ? { executable: paths.serverExecutable, transport: 'tcp' } : null,
      windbot: paths.windbotExecutable ? { executable: paths.windbotExecutable, transport: 'tcp', control: 'command-line' } : null,
      externalPolicy: bridgeLaunchReady ? {
        executable: externalPolicyClient.executable,
        workingDirectory: externalPolicyClient.workingDirectory,
        transport: 'newline-delimited-json-over-tcp',
        protocol: 'ygoagentskill-external-policy-v1',
      } : null,
    },
  };
}

async function inspectExternalPolicyClient(root) {
  if (!isPath(root)) return null;
  const executable = await firstExisting(resolve(root), [
    'WindBot.exe',
    join('bin', 'Release', 'WindBot.exe'),
    join('windbot', 'WindBot.exe'),
  ]);
  if (!executable) return null;
  let payload;
  try {
    payload = await readFile(executable);
  } catch {
    return null;
  }
  const markers = {
    externalDeck: payload.includes(Buffer.from('YGOFTKExternal', 'ascii')),
    externalPolicyClient: payload.includes(Buffer.from('ExternalPolicyClient', 'ascii')),
  };
  const workingDirectory = dirname(executable);
  return {
    root: resolve(root),
    executable,
    workingDirectory,
    verified: markers.externalDeck && markers.externalPolicyClient,
    markers,
    dependencies: {
      sqlite: await firstExisting(workingDirectory, ['sqlite3.dll']),
      sqliteProvider: await firstExisting(workingDirectory, ['Mono.Data.Sqlite.dll']),
      config: await firstExisting(workingDirectory, ['WindBot.exe.config']),
    },
  };
}

async function discoverWindBotProfiles(executable) {
  if (!executable) return [];
  const decksDirectory = join(dirname(executable), 'Decks');
  let entries;
  try {
    entries = await readdir(decksDirectory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && /^AI_.+\.ydk$/i.test(entry.name))
    .map((entry) => entry.name.replace(/^AI_/i, '').replace(/\.ydk$/i, ''))
    .filter((name) => name.toLowerCase() !== 'ygoftk')
    .sort((left, right) => left.localeCompare(right));
}

function compareCandidates(left, right) {
  return right.score - left.score || left.root.localeCompare(right.root);
}

async function firstExisting(root, relativePaths) {
  for (const relative of relativePaths) {
    const path = resolve(root, relative);
    if (await isFile(path)) return path;
  }
  return null;
}

async function firstDirectory(root, relativePaths) {
  for (const relative of relativePaths) {
    const path = resolve(root, relative);
    if (await isDirectory(path)) return path;
  }
  return null;
}

async function isFile(path) {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

async function isDirectory(path) {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

function rootSource(root, options) {
  if (options.explicitRoots.includes(root)) return 'caller';
  if (options.environmentRoots.includes(root)) return 'environment';
  return 'standard-location';
}

function splitPathList(value) {
  return typeof value === 'string' ? value.split(delimiter).map((part) => part.trim()).filter(Boolean) : [];
}

function uniquePaths(values) {
  const seen = new Set();
  return values.filter((value) => {
    if (!isPath(value)) return false;
    const normalized = resolve(value).toLowerCase();
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  }).map((value) => resolve(value));
}

function uniqueStrings(values) { return [...new Set(values.filter(Boolean))]; }
function isPath(value) { return typeof value === 'string' && value.trim().length > 0; }
function clampInteger(value, fallback, min, max) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? Math.min(max, Math.max(min, number)) : fallback;
}
function asRecord(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
