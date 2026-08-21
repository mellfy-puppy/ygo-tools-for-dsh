// @ts-nocheck

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { cp, mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_CARDS_DB_PATH, openCardsDatabase } from './cards-db.js';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(MODULE_DIR, '../..');
const SKILL_ROOT = resolve(PROJECT_ROOT, '..');
const require = createRequire(import.meta.url);
const { requireSkillDependency } = require('../vendor-require.cjs');
export const DEFAULT_YGOPRO_DATA_DIR = resolve(SKILL_ROOT, '.cache/ygopro-data');
export const DEFAULT_BUNDLED_DATA_DIR = resolve(SKILL_ROOT, 'resources/lib');
export const DEFAULT_ENGINE_SCRIPTS_DIR = resolve(SKILL_ROOT, 'resources/lib/ygopro-scripts');
export const DEFAULT_REMOTE_CARDS_CDB_URL = 'http://cdn01.moestart.com/koishipro/ygopro-database/zh-CN/cards.cdb';
export const DEFAULT_REMOTE_LFLIST_URL = 'http://cdn01.moestart.com/koishipro/ygopro-database/zh-CN/lflist.conf';
export const DEFAULT_REMOTE_STRINGS_URL = 'http://cdn01.moestart.com/koishipro/ygopro-database/zh-CN/strings.conf';
export const DEFAULT_YGOPRO_SCRIPTS_ARCHIVE_URL = 'https://cdn01.moestart.com/koishipro/script-zip/script.zip';
export const DEFAULT_YGOPRO_SCRIPTS_TREE_URL = 'https://api.github.com/repos/Smile-DK/ygopro-scripts/git/trees/master?recursive=1';
export const DEFAULT_PRERELEASE_YPK_URL = 'https://cdn02.moecube.com:444/ygopro-super-pre/archive/ygopro-super-pre.ypk';
export const DEFAULT_PRERELEASE_VERSION_URL = 'https://cdn02.moecube.com:444/ygopro-super-pre/versions/master/version.txt';
export const DEFAULT_PRERELEASE_CATALOG_URL = 'https://cdn02.moecube.com:444/ygopro-super-pre/versions/master/test-release-v2.json';

const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_NETWORK_RETRY_COUNT = 2;
const DEFAULT_SCRIPT_DOWNLOAD_CONCURRENCY = 12;
const REQUIRED_ENGINE_SUPPORT_SCRIPTS = Object.freeze(['constant.lua', 'utility.lua', 'procedure.lua']);

/** @typedef {{ dataDir?: string, cardsUrl?: string, lflistUrl?: string, stringsUrl?: string, timeoutMs?: number, fetchImpl?: typeof fetch, progress?: boolean, onProgress?: (progress: { phase: string, message: string, elapsedMs: number }) => void, scriptConcurrency?: number }} CardDataUpdateOptions */
/** @typedef {{ path: string, exists: boolean, size: number, sha256: string | null, updatedAt: string | null }} DataFileStatus */
/** @typedef {{ name: string, hash: number, entries: Map<number, number>, sections: Record<string, number[]> }} BanlistRecord */
/** @typedef {{ id: number, name: string, quantity: number, status: 'forbidden' | 'limited' | 'semi_limited' | 'unlimited', statusText: string, listName: string, listHash: number | null, sourcePath: string | null }} BanStatus */

export function getYgoproDataPaths(options = {}) {
  const dataDir = resolve(readString(options.dataDir) ?? DEFAULT_YGOPRO_DATA_DIR);
  const scriptsDir = resolve(readString(options.scriptsDir) ?? DEFAULT_ENGINE_SCRIPTS_DIR);
  const bundledDataDir = resolve(readString(options.bundledDataDir) ?? DEFAULT_BUNDLED_DATA_DIR);
  const activeDataDir = resolve(readString(options.activeDataDir) ?? bundledDataDir);
  const prereleaseDir = resolve(readString(options.prereleaseDir) ?? resolve(activeDataDir, 'prerelease'));
  const prereleaseScriptsDir = resolve(readString(options.prereleaseScriptsDir) ?? resolve(prereleaseDir, 'script'));
  return {
    dataDir,
    scriptsDir,
    cardsPath: resolve(activeDataDir, 'cards.cdb'),
    lflistPath: resolve(activeDataDir, 'lflist.conf'),
    stringsPath: resolve(activeDataDir, 'strings.conf'),
    prereleaseDir,
    prereleaseReleaseDbPath: resolve(prereleaseDir, 'test-release.cdb'),
    prereleaseUpdateDbPath: resolve(prereleaseDir, 'test-update.cdb'),
    prereleaseStringsPath: resolve(prereleaseDir, 'test-strings.conf'),
    prereleaseScriptsDir,
    cardDbPaths: [resolve(prereleaseDir, 'test-update.cdb'), resolve(prereleaseDir, 'test-release.cdb'), resolve(activeDataDir, 'cards.cdb')],
    scriptDirs: [prereleaseScriptsDir, scriptsDir],
  };
}

export async function refreshCardDataSources(options = {}) {
  const paths = getYgoproDataPaths(options);
  const startedAt = Date.now();
  const dataDirExisted = await stat(paths.dataDir).then(() => true, () => false);
  await mkdir(paths.dataDir, { recursive: true });
  const stagingRoot = resolve(paths.dataDir, `staging-${process.pid}-${Date.now()}`);
  const stagedDataDir = resolve(stagingRoot, 'lib');
  const stagedScriptsDir = resolve(stagedDataDir, 'ygopro-scripts');
  const stagedPrereleaseDir = resolve(stagedDataDir, 'prerelease');
  const stagedPaths = {
    ...paths,
    dataDir: stagingRoot,
    scriptsDir: stagedScriptsDir,
    cardsPath: resolve(stagedDataDir, 'cards.cdb'),
    lflistPath: resolve(stagedDataDir, 'lflist.conf'),
    stringsPath: resolve(stagedDataDir, 'strings.conf'),
    prereleaseDir: stagedPrereleaseDir,
    prereleaseReleaseDbPath: resolve(stagedPrereleaseDir, 'test-release.cdb'),
    prereleaseUpdateDbPath: resolve(stagedPrereleaseDir, 'test-update.cdb'),
    prereleaseStringsPath: resolve(stagedPrereleaseDir, 'test-strings.conf'),
    prereleaseScriptsDir: resolve(stagedPrereleaseDir, 'script'),
    cardDbPaths: [resolve(stagedPrereleaseDir, 'test-update.cdb'), resolve(stagedPrereleaseDir, 'test-release.cdb'), resolve(stagedDataDir, 'cards.cdb')],
    scriptDirs: [resolve(stagedPrereleaseDir, 'script'), stagedScriptsDir],
  };
  await mkdir(stagedDataDir, { recursive: true });

  try {
    reportRefreshProgress(options, startedAt, 'download-core', 'Downloading the Koishi database, banlist, strings, and matching complete script archive.');
    const oldCards = await readLayeredCardIdentityIndex(paths).catch(() => []);
    const [cardsDownload, lflistDownload, stringsDownload, scriptIndex, scriptArchiveBytes, prereleaseYpkBytes, prereleaseVersionBytes, prereleaseCatalogBytes] = await settleAllOrThrow([
      downloadDataFile(readString(options.cardsUrl) ?? DEFAULT_REMOTE_CARDS_CDB_URL, stagedPaths.cardsPath, options),
      downloadDataFile(readString(options.lflistUrl) ?? DEFAULT_REMOTE_LFLIST_URL, stagedPaths.lflistPath, options),
      downloadDataFile(readString(options.stringsUrl) ?? DEFAULT_REMOTE_STRINGS_URL, stagedPaths.stringsPath, options),
      loadOnlineCardScriptIndex(options),
      downloadBytes(readString(options.scriptArchiveUrl) ?? DEFAULT_YGOPRO_SCRIPTS_ARCHIVE_URL, options),
      downloadBytes(readString(options.prereleaseYpkUrl) ?? DEFAULT_PRERELEASE_YPK_URL, options),
      downloadBytes(readString(options.prereleaseVersionUrl) ?? DEFAULT_PRERELEASE_VERSION_URL, options),
      downloadBytes(readString(options.prereleaseCatalogUrl) ?? DEFAULT_PRERELEASE_CATALOG_URL, options),
    ]);
    const downloads = [cardsDownload, lflistDownload, stringsDownload];
    reportRefreshProgress(options, startedAt, 'refresh-scripts', `Extracting and verifying the complete Koishi script revision ${scriptIndex.revision ?? 'unknown'}.`);
    const [scripts, prerelease] = await settleAllOrThrow([
      refreshOnlineCardScripts(stagedPaths, {
        ...options,
        scriptIndex,
        archiveBytes: scriptArchiveBytes,
      }),
      installPrereleasePackage(stagedPaths, {
        ypkBytes: prereleaseYpkBytes,
        versionBytes: prereleaseVersionBytes,
        catalogBytes: prereleaseCatalogBytes,
        ypkUrl: readString(options.prereleaseYpkUrl) ?? DEFAULT_PRERELEASE_YPK_URL,
      }),
    ]);
    downloads.push(scripts);
    downloads.push(prerelease);
    const newCards = await readLayeredCardIdentityIndex(stagedPaths);
    const detectedMigrations = buildIdMigrations(oldCards, newCards);
    const previousMigrations = await readExistingMigrations(resolve(dirname(paths.cardsPath), 'id-migrations.json'));
    const idMigrations = mergeIdMigrations(previousMigrations, detectedMigrations);
    const migrationPath = resolve(stagedDataDir, 'id-migrations.json');
    await writeFile(migrationPath, `${JSON.stringify({ updatedAt: new Date().toISOString(), migrations: idMigrations }, null, 2)}\n`, 'utf8');
    reportRefreshProgress(options, startedAt, 'verify-staged', 'Verifying staged data and starting the compatibility runner.');
    const verification = await verifyUpdatedData(stagedPaths, { scripts, prerelease, idMigrations });
    verification.engineCompatibility = await verifyEngineCompatibility(stagedPaths);
    verification.ok = verification.ok && verification.engineCompatibility.ok;
    if (!verification.ok) {
      return { ok: false, code: 'CARD_DATA_VERIFICATION_FAILED', error: 'Staged online card data failed verification; active resources were not changed.', data: { paths, downloads, verification } };
    }

    reportRefreshProgress(options, startedAt, 'install', 'Installing verified resources.');
    await installStagedResources(stagedPaths, paths, migrationPath, scripts);
    const installedScripts = { ...scripts, path: paths.scriptsDir };
    const installedPrerelease = { ...prerelease, path: paths.prereleaseDir };
    const installedVerification = await verifyUpdatedData(paths, { scripts: installedScripts, prerelease: installedPrerelease, idMigrations });
    installedVerification.engineCompatibility = verification.engineCompatibility;
    installedVerification.ok = installedVerification.ok && verification.engineCompatibility.ok;
  const manifest = {
    updatedAt: new Date().toISOString(),
    sources: {
      cards: readString(options.cardsUrl) ?? DEFAULT_REMOTE_CARDS_CDB_URL,
      lflist: readString(options.lflistUrl) ?? DEFAULT_REMOTE_LFLIST_URL,
      strings: readString(options.stringsUrl) ?? DEFAULT_REMOTE_STRINGS_URL,
      prerelease: {
        ypk: readString(options.prereleaseYpkUrl) ?? DEFAULT_PRERELEASE_YPK_URL,
        version: readString(options.prereleaseVersionUrl) ?? DEFAULT_PRERELEASE_VERSION_URL,
        catalog: readString(options.prereleaseCatalogUrl) ?? DEFAULT_PRERELEASE_CATALOG_URL,
      },
      engineScripts: {
        archive: readString(options.scriptArchiveUrl) ?? DEFAULT_YGOPRO_SCRIPTS_ARCHIVE_URL,
        tree: readString(options.cardScriptsTreeUrl) ?? DEFAULT_YGOPRO_SCRIPTS_TREE_URL,
        revision: scriptIndex.revision,
      },
    },
    files: {
      cards: await getDataFileStatus(paths.cardsPath),
      lflist: await getDataFileStatus(paths.lflistPath),
      strings: await getDataFileStatus(paths.stringsPath),
      prereleaseRelease: await getDataFileStatus(paths.prereleaseReleaseDbPath),
      prereleaseUpdate: await getDataFileStatus(paths.prereleaseUpdateDbPath),
      prereleaseStrings: await getDataFileStatus(paths.prereleaseStringsPath),
      prereleaseScriptsDir: await getDirectoryStatus(paths.prereleaseScriptsDir),
      engineScriptsDir: await getDirectoryStatus(paths.scriptsDir),
    },
    scripts: installedScripts,
    prerelease: installedPrerelease,
    idMigrations,
    verification: installedVerification,
  };
  reportRefreshProgress(options, startedAt, 'complete', 'Card data refresh completed.');

  return {
    ok: installedVerification.ok,
    data: {
      paths,
      downloads,
      manifest,
      elapsedMs: Date.now() - startedAt,
    },
  };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
    if (!dataDirExisted) await rmdir(paths.dataDir).catch(() => {});
  }
}

async function settleAllOrThrow(promises) {
  const results = await Promise.allSettled(promises);
  const failure = results.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
  return results.map((result) => result.status === 'fulfilled' ? result.value : undefined);
}

export async function refreshEngineCardScripts(pathsOrOptions = {}, maybeOptions = {}) {
  const paths = pathsOrOptions?.cardsPath ? pathsOrOptions : getYgoproDataPaths(pathsOrOptions);
  const options = pathsOrOptions?.cardsPath ? maybeOptions : pathsOrOptions;
  const [scriptIndex, archiveBytes] = await Promise.all([
    options.scriptIndex ?? loadOnlineCardScriptIndex(options),
    options.archiveBytes ?? downloadBytes(readString(options.scriptArchiveUrl) ?? DEFAULT_YGOPRO_SCRIPTS_ARCHIVE_URL, options),
  ]);
  return refreshOnlineCardScripts(paths, { ...options, scriptIndex, archiveBytes });
}

async function loadOnlineCardScriptIndex(options) {
  const source = readString(options.cardScriptsTreeUrl) ?? DEFAULT_YGOPRO_SCRIPTS_TREE_URL;
  const tree = await fetchJson(source, options);
  if (tree?.truncated === true) throw new Error('Smile-DK/ygopro-scripts tree response was truncated.');
  const files = new Map();
  for (const entry of Array.isArray(tree?.tree) ? tree.tree : []) {
    const path = readString(entry?.path);
    const sha = readString(entry?.sha);
    if (!path || !sha || !isAllowedYgoproScriptPath(path)) continue;
    files.set(path, { path, sha });
  }
  if (files.size === 0) throw new Error('Smile-DK/ygopro-scripts returned no engine scripts.');
  for (const fileName of REQUIRED_ENGINE_SUPPORT_SCRIPTS) {
    if (!files.has(fileName)) throw new Error(`Smile-DK/ygopro-scripts is missing ${fileName}.`);
  }
  return {
    source,
    revision: readString(tree?.sha),
    truncated: false,
    files,
  };
}

async function refreshOnlineCardScripts(paths, options) {
  const scriptIndex = options.scriptIndex;
  if (!(scriptIndex?.files instanceof Map) || scriptIndex.files.size === 0) {
    throw new Error('A complete Smile-DK/ygopro-scripts tree index is required.');
  }
  const JSZip = requireSkillDependency('jszip');
  const archive = await JSZip.loadAsync(options.archiveBytes);
  const archiveFiles = Object.values(archive.files)
    .filter((entry) => !entry.dir && isAllowedYgoproScriptPath(entry.name));
  const archiveNames = new Set(archiveFiles.map((entry) => entry.name));
  const expectedNames = new Set(scriptIndex.files.keys());
  const missing = [...expectedNames].filter((path) => !archiveNames.has(path));
  const unexpected = [...archiveNames].filter((path) => !expectedNames.has(path));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(`Koishi script archive/tree mismatch: missing=${missing.length}, unexpected=${unexpected.length}.`);
  }

  const concurrency = normalizeConcurrency(options.scriptConcurrency, DEFAULT_SCRIPT_DOWNLOAD_CONCURRENCY);
  const validated = await mapWithConcurrency([...scriptIndex.files.values()], concurrency, async (expected) => {
    const entry = archive.file(expected.path);
    if (!entry) throw new Error(`Koishi script archive is missing ${expected.path}.`);
    const bytes = await entry.async('nodebuffer');
    const actualBlobSha = gitBlobSha(bytes);
    if (actualBlobSha !== expected.sha) {
      throw new Error(`Koishi script archive contains a different revision of ${expected.path}.`);
    }
    return { expected, bytes, actualBlobSha };
  });

  const extractionDir = resolve(dirname(paths.scriptsDir), `.${basename(paths.scriptsDir)}-staging-${process.pid}-${Date.now()}`);
  await rm(extractionDir, { recursive: true, force: true });
  await mkdir(extractionDir, { recursive: true });
  const results = await mapWithConcurrency(validated, concurrency, async ({ expected, bytes, actualBlobSha }) => {
    const targetPath = resolveSafeScriptPath(extractionDir, expected.path);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, bytes);
    return { path: expected.path, bytes: bytes.length, sha256: sha256(bytes), gitBlobSha: actualBlobSha };
  });
  await replaceDirectoryAtomically(extractionDir, paths.scriptsDir);
  const cardScriptCount = results.filter((result) => /^c\d+\.lua$/.test(result.path)).length;
  return {
    ok: true,
    mode: 'complete-verified-archive',
    url: readString(options.scriptArchiveUrl) ?? DEFAULT_YGOPRO_SCRIPTS_ARCHIVE_URL,
    sourceIndex: {
      source: scriptIndex.source,
      revision: scriptIndex.revision,
      truncated: scriptIndex.truncated,
      files: scriptIndex.files.size,
    },
    count: results.length,
    cardScriptCount,
    missing,
    unexpected,
    archiveSha256: sha256(options.archiveBytes),
    verifiedFileSamples: results.slice(0, 10).map((result) => result.path),
    staging: { mode: 'complete', files: results.length },
    path: paths.scriptsDir,
  };
}

async function installPrereleasePackage(paths, options) {
  const JSZip = requireSkillDependency('jszip');
  const archive = await JSZip.loadAsync(options.ypkBytes);
  const entries = Object.values(archive.files).filter((entry) => !entry.dir);
  for (const entry of entries) {
    const originalName = String(entry.unsafeOriginalName ?? entry.name).replace(/\\/g, '/');
    if (originalName.startsWith('/') || originalName.split('/').includes('..')) {
      throw new Error(`Unsafe prerelease YPK path: ${originalName}`);
    }
  }

  const requiredFiles = ['test-release.cdb', 'test-update.cdb', 'test-strings.conf'];
  for (const fileName of requiredFiles) {
    if (!archive.file(fileName)) throw new Error(`Official prerelease YPK is missing ${fileName}.`);
  }

  await rm(paths.prereleaseDir, { recursive: true, force: true });
  await mkdir(paths.prereleaseDir, { recursive: true });
  const extracted = [];
  for (const entry of entries) {
    const name = String(entry.name).replace(/\\/g, '/');
    if (!requiredFiles.includes(name) && !/^script\/[A-Za-z0-9_]+\.lua$/.test(name)) continue;
    const bytes = await entry.async('nodebuffer');
    const targetPath = resolveSafePrereleasePath(paths.prereleaseDir, name);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, bytes);
    extracted.push({ name, bytes: bytes.length, sha256: sha256(bytes) });
  }

  const version = Buffer.from(options.versionBytes).toString('utf8').trim();
  if (!/^\d+$/.test(version)) throw new Error(`Invalid official prerelease version: ${version || '<empty>'}`);
  let catalog;
  try {
    catalog = JSON.parse(Buffer.from(options.catalogBytes).toString('utf8'));
  } catch (error) {
    throw new Error(`Official prerelease catalog is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(catalog)) throw new Error('Official prerelease catalog must be an array.');

  const releaseCards = await readCardIdentityIndex(paths.prereleaseReleaseDbPath);
  const updateCards = await readCardIdentityIndex(paths.prereleaseUpdateDbPath);
  const releaseRuntime = await readCardRuntimeIndex(paths.prereleaseReleaseDbPath);
  const scriptNames = new Set(extracted.filter((item) => item.name.startsWith('script/')).map((item) => basename(item.name)));
  const catalogComparison = comparePrereleaseCatalog(releaseCards, releaseRuntime, catalog, scriptNames);
  const { releaseById, catalogById, missingFromCatalog, nameMismatches, pendingCatalogCards } = catalogComparison;
  if (missingFromCatalog.length > 0 || nameMismatches.length > 0) {
    throw new Error(`Official prerelease CDB/catalog mismatch: missingFromCatalog=${missingFromCatalog.length}, nameMismatches=${nameMismatches.length}.`);
  }

  const missingReleaseScripts = releaseRuntime
    .filter(cardRequiresScript)
    .filter((card) => !scriptNames.has(`c${card.id}.lua`) && !(card.alias > 0 && scriptNames.has(`c${card.alias}.lua`)))
    .map((card) => card.id);
  if (missingReleaseScripts.length > 0) {
    throw new Error(`Official prerelease YPK is missing ${missingReleaseScripts.length} required prerelease card scripts.`);
  }

  return {
    ok: true,
    mode: 'official-mycard-super-pre-ypk',
    url: options.ypkUrl,
    version,
    archiveSha256: sha256(options.ypkBytes),
    catalogSha256: sha256(options.catalogBytes),
    releaseCardCount: releaseCards.length,
    nonTokenReleaseCardCount: releaseById.size,
    tokenCount: releaseCards.length - releaseById.size,
    updateCardCount: updateCards.length,
    catalogCardCount: catalogById.size,
    catalogMatched: pendingCatalogCards.length === 0,
    catalogCoversRelease: true,
    pendingCatalogCardCount: pendingCatalogCards.length,
    pendingCatalogCards,
    scriptCount: scriptNames.size,
    extractedFileCount: extracted.length,
    staging: { mode: 'complete-prerelease', files: extracted.length },
    path: paths.prereleaseDir,
  };
}

export function comparePrereleaseCatalog(releaseCards, releaseRuntime, catalog, scriptNames = new Set()) {
  const runtimeById = new Map(releaseRuntime.map((card) => [card.id, card]));
  const releaseById = new Map(releaseCards
    .filter((card) => (Number(runtimeById.get(card.id)?.type ?? 0) & 0x4000) === 0)
    .map((card) => [card.id, card]));
  const catalogById = new Map();
  for (const card of catalog) {
    const id = readPositiveInteger(card?.id);
    const name = readString(card?.name);
    if (!id || !name) throw new Error('Official prerelease catalog contains a card without a valid id and name.');
    if (catalogById.has(id)) throw new Error(`Official prerelease catalog contains duplicate card ID ${id}.`);
    catalogById.set(id, { id, name });
  }
  const missingFromCatalog = [...releaseById.keys()].filter((id) => !catalogById.has(id));
  const nameMismatches = [...releaseById].filter(([id, card]) => {
    const catalogCard = catalogById.get(id);
    return normalizeCardQuery(card.name) !== normalizeCardQuery(catalogCard?.name);
  }).map(([id, card]) => ({ id, cdbName: card.name, catalogName: catalogById.get(id)?.name }));
  const pendingCatalogCards = [...catalogById.values()]
    .filter((card) => !releaseById.has(card.id))
    .map((card) => {
      const scriptAvailable = scriptNames.has(`c${card.id}.lua`);
      return {
        ...card,
        cdbAvailable: false,
        scriptAvailable,
        reason: scriptAvailable ? 'cdb_missing' : 'cdb_and_script_missing',
      };
    });
  return {
    releaseById,
    catalogById,
    missingFromCatalog,
    nameMismatches,
    pendingCatalogCards,
  };
}

function resolveSafePrereleasePath(rootDir, relativePath) {
  const root = resolve(rootDir);
  const target = resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}\\`) && !target.startsWith(`${root}/`)) {
    throw new Error(`Prerelease YPK path escapes the target directory: ${relativePath}`);
  }
  return target;
}

async function replaceDirectoryAtomically(sourceDir, targetDir) {
  const backupDir = resolve(dirname(targetDir), `.${basename(targetDir)}-backup-${process.pid}-${Date.now()}`);
  let targetMoved = false;
  try {
    const targetExists = await stat(targetDir).then(() => true).catch(() => false);
    if (targetExists) {
      await rename(targetDir, backupDir);
      targetMoved = true;
    }
    await rename(sourceDir, targetDir);
  } catch (error) {
    await rm(targetDir, { recursive: true, force: true }).catch(() => {});
    if (targetMoved) await rename(backupDir, targetDir).catch(() => {});
    throw error;
  }
  if (targetMoved) await rm(backupDir, { recursive: true, force: true });
}

function isAllowedYgoproScriptPath(path) {
  return /^(?:[A-Za-z0-9_]+\.lua|patches\/[A-Za-z0-9_-]+\.lua)$/.test(String(path ?? ''));
}

function resolveSafeScriptPath(scriptsDir, relativePath) {
  if (!isAllowedYgoproScriptPath(relativePath)) throw new Error(`Unsafe Koishi script archive path: ${relativePath}`);
  const root = resolve(scriptsDir);
  const target = resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}\\`) && !target.startsWith(`${root}/`)) {
    throw new Error(`Koishi script path escapes the target directory: ${relativePath}`);
  }
  return target;
}

async function downloadBytes(url, options) {
  return fetchWithRetry(url, options, async (response) => {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) throw new Error('Downloaded file is empty.');
    return bytes;
  });
}

async function readCardIdentityIndex(path) {
  const initSqlJs = requireSkillDependency('sql.js');
  const SQL = await initSqlJs();
  const db = new SQL.Database(await readFile(path));
  try {
    const result = db.exec('SELECT id, name FROM texts')[0];
    return (result?.values ?? []).map(([id, name]) => ({ id: Number(id), name: String(name ?? '') }));
  } finally {
    db.close();
  }
}

async function readLayeredCardIdentityIndex(paths) {
  const byId = new Map();
  for (const path of [...paths.cardDbPaths].reverse()) {
    const cards = await readCardIdentityIndex(path).catch(() => []);
    for (const card of cards) byId.set(card.id, card);
  }
  return [...byId.values()];
}

async function readCardRuntimeIndex(path) {
  const initSqlJs = requireSkillDependency('sql.js');
  const SQL = await initSqlJs();
  const db = new SQL.Database(await readFile(path));
  try {
    const result = db.exec('SELECT id, alias, type FROM datas')[0];
    return (result?.values ?? []).map(([id, alias, type]) => ({ id: Number(id), alias: Number(alias ?? 0), type: Number(type ?? 0) }));
  } finally {
    db.close();
  }
}

async function readLayeredCardRuntimeIndex(paths) {
  const byId = new Map();
  for (const path of [...paths.cardDbPaths].reverse()) {
    const cards = await readCardRuntimeIndex(path).catch(() => []);
    for (const card of cards) byId.set(card.id, card);
  }
  return [...byId.values()];
}

function buildIdMigrations(before, after) {
  const afterByName = new Map();
  for (const card of after) {
    const key = normalizeCardQuery(card.name);
    if (!key) continue;
    const values = afterByName.get(key) ?? [];
    values.push(card);
    afterByName.set(key, values);
  }
  return before.flatMap((oldCard) => {
    const matches = afterByName.get(normalizeCardQuery(oldCard.name)) ?? [];
    if (matches.some((card) => card.id === oldCard.id) || matches.length !== 1) return [];
    return [{ oldId: oldCard.id, newId: matches[0].id, name: matches[0].name }];
  }).sort((left, right) => left.oldId - right.oldId);
}

async function readExistingMigrations(path) {
  try {
    const payload = JSON.parse(await readFile(path, 'utf8'));
    return Array.isArray(payload?.migrations) ? payload.migrations : [];
  } catch {
    return [];
  }
}

function mergeIdMigrations(...groups) {
  const byOldId = new Map();
  for (const migration of groups.flat()) {
    const oldId = readPositiveInteger(migration?.oldId);
    const newId = readPositiveInteger(migration?.newId);
    if (!oldId || !newId || oldId === newId) continue;
    byOldId.set(oldId, { oldId, newId, name: readString(migration?.name) ?? String(newId) });
  }
  return [...byOldId.values()].sort((left, right) => left.oldId - right.oldId);
}

async function installStagedResources(staged, active, migrationPath, scripts) {
  if (scripts?.staging?.mode !== 'complete') throw new Error('Refusing to install a partial engine script update.');
  const stagedDataDir = dirname(staged.cardsPath);
  const activeDataDir = dirname(active.cardsPath);
  const stagedLayoutOk = resolve(staged.scriptsDir) === resolve(stagedDataDir, 'ygopro-scripts')
    && resolve(staged.prereleaseDir) === resolve(stagedDataDir, 'prerelease')
    && resolve(migrationPath) === resolve(stagedDataDir, 'id-migrations.json');
  const activeLayoutOk = resolve(active.scriptsDir) === resolve(activeDataDir, 'ygopro-scripts')
    && resolve(active.prereleaseDir) === resolve(activeDataDir, 'prerelease');
  if (!stagedLayoutOk || !activeLayoutOk) {
    throw new Error('Atomic data refresh requires formal and prerelease resources to share one lib directory.');
  }

  const managedNames = new Set([
    'cards.cdb',
    'lflist.conf',
    'strings.conf',
    'supplemental-cards.json',
    'prerelease',
    'id-migrations.json',
    'ygopro-scripts',
  ]);
  for (const entry of await readdir(activeDataDir, { withFileTypes: true }).catch(() => [])) {
    if (managedNames.has(entry.name)) continue;
    await cp(resolve(activeDataDir, entry.name), resolve(stagedDataDir, entry.name), {
      recursive: entry.isDirectory(),
      force: false,
      errorOnExist: true,
    });
  }

  const backupDir = resolve(dirname(activeDataDir), `.${basename(activeDataDir)}-backup-${process.pid}-${Date.now()}`);
  let activeMoved = false;
  let stagedInstalled = false;
  try {
    await rename(activeDataDir, backupDir);
    activeMoved = true;
    await rename(stagedDataDir, activeDataDir);
    stagedInstalled = true;
  } catch (error) {
    if (stagedInstalled) await rm(activeDataDir, { recursive: true, force: true }).catch(() => {});
    if (activeMoved) {
      await rename(backupDir, activeDataDir).catch(() => {});
    }
    throw error;
  }
  await rm(backupDir, { recursive: true, force: true });
}

async function verifyEngineCompatibility(paths) {
  try {
    const runnerModule = await import('../runner/factory.js');
    const stateTools = await import('../tools/state-tools.js');
    const runtimeCards = await readLayeredCardRuntimeIndex(paths);
    const prereleaseCards = await readCardRuntimeIndex(paths.prereleaseReleaseDbPath);
    const availableScripts = await readLayeredScriptNames(paths);
    const executable = (card) => !cardRequiresScript(card)
      || availableScripts.has(`c${card.id}.lua`)
      || (card.alias > 0 && availableScripts.has(`c${card.alias}.lua`));
    const prereleaseMain = selectRepresentativeCards(prereleaseCards.filter(isMainDeckCard).filter(executable), 20);
    const prereleaseExtra = selectRepresentativeCards(prereleaseCards.filter(isExtraDeckCard).filter(executable), 15);
    const selectedPrereleaseIds = new Set([...prereleaseMain, ...prereleaseExtra].map((card) => card.id));
    const baseMain = runtimeCards
      .filter(isMainDeckCard)
      .filter(executable)
      .filter((card) => !selectedPrereleaseIds.has(card.id))
      .sort((left, right) => left.id - right.id);
    const main = [...prereleaseMain, ...baseMain].map((card) => card.id).slice(0, 40);
    if (main.length < 40) throw new Error(`Only ${main.length} main-deck engine probe cards were available.`);
    const extra = prereleaseExtra.map((card) => card.id);
    const opening = main.slice(0, Math.min(5, main.length));
    const remain = main.slice(5);
    const runner = await runnerModule.createRealRunner({
      cardsDb: paths.cardsPath,
      cardsDbs: paths.cardDbPaths,
      scriptDirs: paths.scriptDirs,
      playerDeck: { main, extra, side: [] },
      playerOpening: { opening, remain },
      seed: 1,
      drawCount: opening.length,
      quiet: true,
    });
    const listed = stateTools.listActions(runner);
    if (!listed.ok) throw new Error(listed.error);
    const diagnostics = listed.data.engineDiagnostics ?? [];
    if (diagnostics.length > 0) throw new Error(`Engine emitted ${diagnostics.length} script diagnostic messages.`);
    if (!Array.isArray(listed.data.actions) || listed.data.actions.length === 0) {
      throw new Error('Engine probe produced no legal opening actions.');
    }
    return {
      ok: Boolean(runner),
      probeCardCount: main.length,
      probeIds: main,
      prereleaseProbe: {
        availableMainDeckCards: prereleaseCards.filter(isMainDeckCard).length,
        availableExtraDeckCards: prereleaseCards.filter(isExtraDeckCard).length,
        selectedMainDeckIds: prereleaseMain.map((card) => card.id),
        selectedExtraDeckIds: prereleaseExtra.map((card) => card.id),
      },
      openingActionCount: listed.data.actions.length,
      engineDiagnostics: diagnostics,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function isMainDeckCard(card) {
  const type = Number(card?.type ?? 0);
  return (type & 0x4000) === 0
    && !isExtraDeckCard(card)
    && (type & (0x1 | 0x2 | 0x4)) !== 0;
}

function isExtraDeckCard(card) {
  const type = Number(card?.type ?? 0);
  return (type & (0x40 | 0x2000 | 0x800000 | 0x4000000)) !== 0;
}

function selectRepresentativeCards(cards, limit) {
  const groups = new Map();
  for (const card of cards.slice().sort((left, right) => left.id - right.id)) {
    const key = cardTypeGroup(card);
    const group = groups.get(key) ?? [];
    group.push(card);
    groups.set(key, group);
  }
  const selected = [];
  while (selected.length < limit && [...groups.values()].some((group) => group.length > 0)) {
    for (const group of groups.values()) {
      if (selected.length >= limit) break;
      const card = group.shift();
      if (card) selected.push(card);
    }
  }
  return selected;
}

function cardTypeGroup(card) {
  const type = Number(card?.type ?? 0);
  if ((type & 0x40) !== 0) return 'fusion';
  if ((type & 0x2000) !== 0) return 'synchro';
  if ((type & 0x800000) !== 0) return 'xyz';
  if ((type & 0x4000000) !== 0) return 'link';
  if ((type & 0x2) !== 0) return 'spell';
  if ((type & 0x4) !== 0) return 'trap';
  return 'monster';
}

export async function inspectCardDataSources(options = {}) {
  const paths = getYgoproDataPaths(options);
  const verification = await verifyUpdatedData(paths);
  return {
    ok: true,
    data: {
      paths,
      activeCardsPath: DEFAULT_CARDS_DB_PATH,
      defaultLookupPriority: [
        'prerelease/test-update.cdb',
        'prerelease/test-release.cdb',
        'lib/cards.cdb',
      ],
      files: {
        activeCards: await getDataFileStatus(DEFAULT_CARDS_DB_PATH),
        cards: await getDataFileStatus(paths.cardsPath),
        lflist: await getDataFileStatus(paths.lflistPath),
        strings: await getDataFileStatus(paths.stringsPath),
        prereleaseRelease: await getDataFileStatus(paths.prereleaseReleaseDbPath),
        prereleaseUpdate: await getDataFileStatus(paths.prereleaseUpdateDbPath),
        prereleaseStrings: await getDataFileStatus(paths.prereleaseStringsPath),
        prereleaseScriptsDir: await getDirectoryStatus(paths.prereleaseScriptsDir),
        engineScriptsDir: await getDirectoryStatus(paths.scriptsDir),
      },
      verification,
    },
  };
}

export async function resolveDefaultCardsDbPath(options = {}) {
  const paths = getYgoproDataPaths(options);
  const status = await getDataFileStatus(paths.cardsPath);
  return status.exists && status.size > 0 ? paths.cardsPath : null;
}

export function resolveCachedCardsDbPath(options = {}) {
  const paths = getYgoproDataPaths(options);
  return paths.cardsPath;
}

export async function readBanlistContext(options = {}) {
  const paths = getYgoproDataPaths(options);
  const banlists = await loadBanlists(paths.lflistPath);
  const selected = selectBanlist(banlists, readString(options.listName), options.listIndex);
  let queryId = readPositiveInteger(options.id ?? options.cardId);
  let queryName = readString(options.cardName ?? options.name);
  if (!queryId && queryName) {
    const db = openCardsDatabase({ dbPaths: paths.cardDbPaths });
    try {
      const card = db.getByName(queryName);
      queryId = readPositiveInteger(card?.id);
      queryName = readString(card?.name) ?? queryName;
    } finally {
      db.close();
    }
  }
  const status = queryId ? getBanStatusById(queryId, selected, paths.lflistPath, queryName) : null;
  return {
    ok: true,
    data: {
      sourcePath: paths.lflistPath,
      listCount: banlists.length,
      currentList: summarizeBanlist(selected, paths.lflistPath),
      queriedCard: status,
    },
  };
}

export async function getBanStatusForCard(card, options = {}) {
  const id = readPositiveInteger(card?.id);
  if (!id) return null;
  const paths = getYgoproDataPaths(options);
  const banlists = await loadBanlists(paths.lflistPath).catch(() => []);
  if (banlists.length === 0) return null;
  const selected = selectBanlist(banlists, readString(options.listName), options.listIndex);
  return getBanStatusById(id, selected, paths.lflistPath, readString(card?.name));
}

export function getBanStatusForCardSync(card, options = {}) {
  const id = readPositiveInteger(card?.id);
  if (!id) return null;
  try {
    const paths = getYgoproDataPaths(options);
    const text = requireFsRead(paths.lflistPath);
    const banlists = parseLflist(text);
    if (banlists.length === 0) return null;
    const selected = selectBanlist(banlists, readString(options.listName), options.listIndex);
    return getBanStatusById(id, selected, paths.lflistPath, readString(card?.name));
  } catch {
    return null;
  }
}

export async function getCardScriptStatus(card, options = {}) {
  const id = readPositiveInteger(card?.id ?? card?.passcode ?? card);
  if (!id) return null;
  const paths = getYgoproDataPaths(options);
  let missing = null;
  for (const scriptsDir of paths.scriptDirs) {
    const status = await readCardScriptStatus(id, scriptsDir, readString(card?.name));
    if (status.readable) return status;
    missing = status;
  }
  return missing;
}

export function getCardScriptStatusSync(card, options = {}) {
  const id = readPositiveInteger(card?.id ?? card?.passcode ?? card);
  if (!id) return null;
  const paths = getYgoproDataPaths(options);
  let missing = null;
  for (const scriptsDir of paths.scriptDirs) {
    const status = readCardScriptStatusSync(id, scriptsDir, readString(card?.name));
    if (status.readable) return status;
    missing = status;
  }
  return missing;
}

export async function loadBanlists(lflistPath) {
  const text = await readFile(lflistPath, 'utf8');
  return parseLflist(text);
}

export function parseLflist(text) {
  /** @type {BanlistRecord[]} */
  const banlists = [];
  /** @type {BanlistRecord | null} */
  let current = null;
  let section = 'other';

  for (const rawLine of String(text).replace(/\r/g, '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      section = line.slice(1).trim().toLowerCase() || 'other';
      continue;
    }
    if (line.startsWith('!')) {
      current = {
        name: line.slice(1).trim(),
        hash: 0,
        entries: new Map(),
        sections: { forbidden: [], limited: [], semi_limited: [], other: [] },
      };
      banlists.push(current);
      section = 'other';
      continue;
    }
    if (!current) continue;
    const match = /^(\d+)\s+([0123])(?:\s|$)/.exec(line);
    if (!match) continue;
    const id = Number(match[1]);
    const quantity = Number(match[2]);
    current.entries.set(id, quantity);
    current.hash = hashBanlistEntry(current.hash, id, quantity);
    const normalizedSection = section in current.sections ? section : statusKeyForQuantity(quantity);
    current.sections[normalizedSection].push(id);
  }

  return banlists;
}

async function verifyUpdatedData(paths, online = {}) {
  let cardsOk = false;
  let cardsError = null;
  let databaseCardCount = 0;
  let prereleaseReleaseCardCount = 0;
  let prereleaseUpdateCardCount = 0;
  try {
    const db = openCardsDatabase({ dbPaths: paths.cardDbPaths });
    try {
      cardsOk = true;
      databaseCardCount = (await readLayeredCardRuntimeIndex(paths)).length;
      prereleaseReleaseCardCount = (await readCardRuntimeIndex(paths.prereleaseReleaseDbPath)).length;
      prereleaseUpdateCardCount = (await readCardRuntimeIndex(paths.prereleaseUpdateDbPath)).length;
    } finally {
      db.close();
    }
  } catch (error) {
    cardsError = error instanceof Error ? error.message : String(error);
  }

  const banlists = await loadBanlists(paths.lflistPath).catch(() => []);
  const currentBanlist = banlists[0] ?? null;
  const banlistOk = Boolean(currentBanlist && currentBanlist.entries.size > 0);

  const scriptCoverage = await verifyDatabaseScriptCoverage(paths).catch((error) => ({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    requiredCardCount: 0,
    missingCount: null,
    missing: [],
  }));
  const scriptsOk = !online.scripts || (online.scripts.ok === true && online.scripts.missing?.length === 0);
  const prereleaseOk = !online.prerelease || online.prerelease.ok === true;
  return {
    ok: cardsOk && banlistOk && scriptsOk && prereleaseOk && scriptCoverage.ok,
    cardsDatabaseReadable: cardsOk,
    cardsDatabaseError: cardsError,
    databaseCardCount,
    prereleaseReleaseCardCount,
    prereleaseUpdateCardCount,
    currentBanlist: currentBanlist ? summarizeBanlist(currentBanlist, paths.lflistPath) : null,
    onlineScripts: online.scripts ?? null,
    onlinePrerelease: online.prerelease ?? null,
    databaseScriptCoverage: scriptCoverage,
    idMigrations: online.idMigrations ?? [],
    expectedChecks: {
      banlistReadable: banlistOk,
      allRequiredCardScriptsAvailable: scriptCoverage.ok,
      layeredDatabasesReadable: cardsOk,
    },
  };
}

function cardRequiresScript(card) {
  const type = Number(card?.type ?? 0);
  const TYPE_MONSTER = 0x1;
  const TYPE_SPELL = 0x2;
  const TYPE_TRAP = 0x4;
  const TYPE_NORMAL = 0x10;
  const TYPE_TOKEN = 0x4000;
  const TYPE_PENDULUM = 0x1000000;
  const TYPE_SKILL = 0x8000000;
  if ((type & TYPE_TOKEN) !== 0) return false;
  if ((type & (TYPE_SPELL | TYPE_TRAP | TYPE_SKILL)) !== 0) return true;
  return (type & TYPE_MONSTER) !== 0 && ((type & TYPE_NORMAL) === 0 || (type & TYPE_PENDULUM) !== 0);
}

async function verifyDatabaseScriptCoverage(paths) {
  const runtimeCards = await readLayeredCardRuntimeIndex(paths);
  const scriptFiles = await readLayeredScriptNames(paths);
  const requiredCards = runtimeCards.filter(cardRequiresScript);
  const missing = requiredCards
    .filter((card) => !scriptFiles.has(`c${card.id}.lua`)
      && !(card.alias > 0 && scriptFiles.has(`c${card.alias}.lua`)))
    .map((card) => ({ id: card.id, alias: card.alias, type: card.type }));
  return {
    ok: missing.length === 0,
    databaseCardCount: runtimeCards.length,
    requiredCardCount: requiredCards.length,
    availableCardScriptCount: scriptFiles.size,
    missingCount: missing.length,
    missing: missing.slice(0, 100),
  };
}

async function readLayeredScriptNames(paths) {
  const names = new Set();
  for (const scriptsDir of paths.scriptDirs) {
    for (const fileName of await readdir(scriptsDir).catch(() => [])) {
      if (/^c\d+\.lua$/.test(fileName)) names.add(fileName);
    }
  }
  return names;
}

async function fetchJson(url, options) {
  return fetchWithRetry(url, options, (response) => response.json());
}

async function downloadDataFile(url, targetPath, options) {
  const bytes = await downloadBytes(url, options);
  await writeDataFile(targetPath, bytes);
  return {
    url,
    path: targetPath,
    ok: true,
    bytes: bytes.length,
    sha256: sha256(bytes),
  };
}

async function fetchWithRetry(url, options, readResponse) {
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  const retryCount = normalizeRetryCount(options.retryCount);
  const fetchImpl = options.fetchImpl ?? fetch;
  let lastError = null;
  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'YGOagentskill-card-updater' },
      });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status} ${response.statusText}`.trim());
        error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        throw error;
      }
      return await readResponse(response);
    } catch (error) {
      lastError = error;
      if (error?.retryable === false || attempt >= retryCount) break;
      await delay(Math.min(5000, 750 * (2 ** attempt)));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(`Request failed for ${url} after ${retryCount + 1} attempt(s): ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function writeDataFile(targetPath, bytes) {
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(dirname(targetPath), { recursive: true });
  try {
    await writeFile(tempPath, bytes);
    await rename(tempPath, targetPath);
  } finally {
    await rm(tempPath, { force: true }).catch(() => {});
  }
}

async function getDataFileStatus(path) {
  try {
    const info = await stat(path);
    const bytes = await readFile(path);
    return {
      path,
      exists: true,
      size: info.size,
      sha256: sha256(bytes),
      updatedAt: info.mtime.toISOString(),
    };
  } catch {
    return {
      path,
      exists: false,
      size: 0,
      sha256: null,
      updatedAt: null,
    };
  }
}

async function getDirectoryStatus(path) {
  try {
    const info = await stat(path);
    return {
      path,
      exists: true,
      isDirectory: info.isDirectory(),
      updatedAt: info.mtime.toISOString(),
    };
  } catch {
    return {
      path,
      exists: false,
      isDirectory: false,
      updatedAt: null,
    };
  }
}

async function readCardScriptStatus(id, scriptsDir, fallbackName = null) {
  const path = resolve(scriptsDir, `c${id}.lua`);
  const base = {
    id,
    name: fallbackName ?? String(id),
    path,
    scriptsDir,
    requiredFile: `c${id}.lua`,
  };
  try {
    const text = await readFile(path, 'utf8');
    return formatScriptStatus(base, text);
  } catch (error) {
    return {
      ...base,
      available: false,
      readable: false,
      hasInitialEffect: false,
      sha256: null,
      bytes: 0,
      source: null,
      error: error instanceof Error ? error.message : String(error),
      note: '卡片资料文本存在不等于引擎脚本可用；缺少这个 Lua 文件时 ocgcore 不能执行该卡效果。',
    };
  }
}

function readCardScriptStatusSync(id, scriptsDir, fallbackName = null) {
  const path = resolve(scriptsDir, `c${id}.lua`);
  const base = {
    id,
    name: fallbackName ?? String(id),
    path,
    scriptsDir,
    requiredFile: `c${id}.lua`,
  };
  try {
    return formatScriptStatus(base, requireFsRead(path));
  } catch (error) {
    return {
      ...base,
      available: false,
      readable: false,
      hasInitialEffect: false,
      sha256: null,
      bytes: 0,
      source: null,
      error: error instanceof Error ? error.message : String(error),
      note: '卡片资料文本存在不等于引擎脚本可用；缺少这个 Lua 文件时 ocgcore 不能执行该卡效果。',
    };
  }
}

function formatScriptStatus(base, text) {
  const hasInitialEffect = new RegExp(`(?:function\\s+c${base.id}\\.initial_effect|function\\s+s\\.initial_effect|c${base.id}\\s*=\\s*\\{\\}|local\\s+s\\s*,\\s*id(?:\\s*,\\s*\\w+)*\\s*=\\s*GetID\\(\\))`).test(text);
  return {
    ...base,
    available: hasInitialEffect,
    readable: true,
    hasInitialEffect,
    sha256: sha256(Buffer.from(text, 'utf8')),
    bytes: Buffer.byteLength(text, 'utf8'),
    source: 'engine-scripts-dir',
    error: null,
    note: hasInitialEffect ? null : '脚本文件存在但没有识别到 initial_effect 入口，不能视为可执行卡片实现。',
  };
}

function summarizeBanlist(banlist, sourcePath) {
  return {
    name: banlist.name,
    hash: banlist.hash >>> 0,
    sourcePath,
    counts: {
      forbidden: countQuantity(banlist, 0),
      limited: countQuantity(banlist, 1),
      semiLimited: countQuantity(banlist, 2),
      listedUnlimited: countQuantity(banlist, 3),
      totalListed: banlist.entries.size,
    },
  };
}

function selectBanlist(banlists, listName, listIndex) {
  if (listName) {
    const match = banlists.find((banlist) => banlist.name === listName);
    if (match) return match;
  }
  const index = Math.trunc(Number(listIndex));
  if (Number.isSafeInteger(index) && index >= 0 && index < banlists.length) return banlists[index];
  return banlists[0];
}

function getBanStatusById(id, banlist, sourcePath, fallbackName = null) {
  const quantity = banlist.entries.get(id) ?? 3;
  return {
    id,
    name: fallbackName ?? String(id),
    quantity,
    status: statusKeyForQuantity(quantity),
    statusText: statusTextForQuantity(quantity),
    listName: banlist.name,
    listHash: banlist.hash >>> 0,
    sourcePath,
  };
}

function statusKeyForQuantity(quantity) {
  if (quantity <= 0) return 'forbidden';
  if (quantity === 1) return 'limited';
  if (quantity === 2) return 'semi_limited';
  return 'unlimited';
}

function statusTextForQuantity(quantity) {
  if (quantity <= 0) return '禁止卡';
  if (quantity === 1) return '限制1张';
  if (quantity === 2) return '限制2张';
  return '无限制';
}

function countQuantity(banlist, quantity) {
  let count = 0;
  for (const value of banlist.entries.values()) {
    if (value === quantity) count += 1;
  }
  return count;
}

function hashBanlistEntry(hash, id, quantity) {
  let next = hash >>> 0;
  next = ((next << 5) - next + id) >>> 0;
  next = ((next << 5) - next + quantity) >>> 0;
  return next >>> 0;
}

function normalizeCardQuery(value) {
  const text = readString(value);
  if (!text) return null;
  return text.toLowerCase().replace(/[\s_\-·・.：:]+/g, '');
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function gitBlobSha(bytes) {
  const header = Buffer.from(`blob ${bytes.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(bytes).digest('hex');
}

function normalizeTimeout(value) {
  const timeout = Math.trunc(Number(value ?? DEFAULT_TIMEOUT_MS));
  return Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS;
}

function normalizeRetryCount(value) {
  const retries = Math.trunc(Number(value ?? DEFAULT_NETWORK_RETRY_COUNT));
  return Number.isFinite(retries) && retries >= 0 ? Math.min(retries, 5) : DEFAULT_NETWORK_RETRY_COUNT;
}

function normalizeConcurrency(value, fallback) {
  const concurrency = Math.trunc(Number(value ?? fallback));
  return Number.isSafeInteger(concurrency) && concurrency > 0 ? Math.min(concurrency, 32) : fallback;
}

async function mapWithConcurrency(values, concurrency, worker) {
  const results = new Array(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(values[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function reportRefreshProgress(options, startedAt, phase, message) {
  const progress = { phase, message, elapsedMs: Date.now() - startedAt };
  if (typeof options.onProgress === 'function') options.onProgress(progress);
  if (options.progress === true) console.error(`[YGO data refresh] ${message} (${progress.elapsedMs} ms)`);
}

function readPositiveInteger(value) {
  const number = Math.trunc(Number(value));
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function readString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function requireFsRead(path) {
  const fs = /** @type {typeof import('node:fs')} */ (
    require('node:fs')
  );
  return fs.readFileSync(path, 'utf8');
}
