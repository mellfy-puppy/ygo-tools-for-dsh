import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function resolveSkillConfig(env = process.env) {
  const skillRoot = resolve(env.YGO_SKILL_ROOT || SKILL_ROOT);
  const runtimeRoot = resolve(env.YGO_RUNTIME_ROOT || resolve(skillRoot, 'runtime'));
  const resourcesRoot = resolve(env.YGO_RESOURCES_ROOT || resolve(skillRoot, 'resources'));
  const resourceRoot = resolve(env.YGO_RESOURCE_ROOT || resourcesRoot);
  const libRoot = resolve(resourceRoot, 'lib');
  const prereleaseDir = resolve(env.YGO_PRERELEASE_DIR || resolve(libRoot, 'prerelease'));
  const cardsDbPath = resolve(env.YGO_CARDS_DB || resolve(libRoot, 'cards.cdb'));
  const scriptsDir = resolve(env.YGO_SCRIPTS_DIR || resolve(libRoot, 'ygopro-scripts'));
  const prereleaseReleaseDbPath = resolve(env.YGO_PRERELEASE_RELEASE_DB || resolve(prereleaseDir, 'test-release.cdb'));
  const prereleaseUpdateDbPath = resolve(env.YGO_PRERELEASE_UPDATE_DB || resolve(prereleaseDir, 'test-update.cdb'));
  const prereleaseScriptsDir = resolve(env.YGO_PRERELEASE_SCRIPTS_DIR || resolve(prereleaseDir, 'script'));
  return {
    skillRoot,
    runtimeRoot,
    resourcesRoot,
    resourceRoot,
    cardsDbPath,
    cardsDbPaths: readPathList(env.YGO_CARDS_DBS) ?? [prereleaseUpdateDbPath, prereleaseReleaseDbPath, cardsDbPath],
    scriptsDir,
    scriptDirs: readPathList(env.YGO_SCRIPT_DIRS) ?? [prereleaseScriptsDir, scriptsDir],
    prereleaseDir,
    prereleaseReleaseDbPath,
    prereleaseUpdateDbPath,
    prereleaseScriptsDir,
    cacheDir: resolve(env.YGO_CACHE_DIR || resolve(skillRoot, '.cache', 'ygopro-data')),
    replayDir: resolve(env.YGO_REPLAY_DIR || resolve(skillRoot, 'output', 'replays')),
    routeDir: resolve(env.YGO_ROUTE_DIR || resolve(skillRoot, 'output', 'routes')),
    deckDir: resolve(env.YGO_DECK_DIR || resolve(skillRoot, 'output', 'decks')),
    deckPath: resolve(env.YGO_DECK_PATH || resolve(resourceRoot, 'lib', 'slm.ydk')),
    idMigrationsPath: resolve(env.YGO_ID_MIGRATIONS || resolve(resourceRoot, 'lib', 'id-migrations.json')),
    engineBackend: env.YGO_ENGINE_BACKEND || 'js',
    allowNetworkUpdate: env.YGO_ALLOW_NETWORK_UPDATE === '1',
  };
}

function readPathList(value) {
  if (typeof value !== 'string') return null;
  const paths = value.split(';').map((item) => item.trim()).filter(Boolean).map(resolve);
  return paths.length > 0 ? paths : null;
}
