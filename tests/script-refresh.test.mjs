import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pullMissingScripts } from '../skill/runtime/src/database/incremental-download.js';

const require = createRequire(import.meta.url);
const { requireSkillDependency } = require('../skill/runtime/src/vendor-require.cjs');
const JSZip = requireSkillDependency('jszip');

async function archive(files) {
  const zip = new JSZip();
  for (const [name, text] of Object.entries(files)) zip.file(name, text);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// Serves HTTP range requests from in-memory archives; no network.
function rangeFetch(files) {
  return async (url, init) => {
    const body = files[url.split('/').at(-1)];
    const range = init.headers.Range;
    const [, from, to] = /bytes=(\d*)-(\d*)/.exec(range);
    const start = from === '' ? body.length - Number(to) : Number(from);
    const end = from === '' ? body.length - 1 : Math.min(Number(to), body.length - 1);
    return new Response(body.subarray(start, end + 1), {
      status: 206,
      headers: { 'content-range': `bytes ${start}-${end}/${body.length}`, 'content-length': String(end - start + 1) },
    });
  };
}

test('script refresh replaces changed base scripts but only adds absent card scripts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ygo-script-refresh-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scriptsDir = join(root, 'ygopro-scripts');
  const prereleaseScriptsDir = join(root, 'prerelease', 'script');
  await mkdir(scriptsDir, { recursive: true });
  await mkdir(prereleaseScriptsDir, { recursive: true });
  await writeFile(join(scriptsDir, 'constant.lua'), 'OLD_CONSTANT=1');
  await writeFile(join(scriptsDir, 'c100.lua'), '-- local card edit');
  await writeFile(join(prereleaseScriptsDir, 'procedure.lua'), 'FusionSpell=nil');

  const files = {
    'script.zip': await archive({ 'constant.lua': 'CATEGORY_DECK_SPSUMMON=0x1', 'utility.lua': 'Auxiliary={}', 'c100.lua': '-- upstream card', 'c200.lua': '-- new card' }),
    'ygopro-super-pre.ypk': await archive({ 'script/procedure.lua': 'FusionSpell={}', 'script/c300.lua': '-- prerelease card' }),
  };
  const result = await pullMissingScripts(
    { scriptsDir, prereleaseScriptsDir, scriptDirs: [prereleaseScriptsDir, scriptsDir] },
    { fetchImpl: rangeFetch(files), scriptArchiveUrl: 'https://fixture/script.zip', prereleaseYpkUrl: 'https://fixture/ygopro-super-pre.ypk' },
  );

  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(await readFile(join(scriptsDir, 'constant.lua'), 'utf8'), 'CATEGORY_DECK_SPSUMMON=0x1');
  assert.equal(await readFile(join(scriptsDir, 'utility.lua'), 'utf8'), 'Auxiliary={}');
  assert.equal(await readFile(join(prereleaseScriptsDir, 'procedure.lua'), 'utf8'), 'FusionSpell={}');
  assert.equal(await readFile(join(scriptsDir, 'c100.lua'), 'utf8'), '-- local card edit', 'existing card scripts are never overwritten');
  assert.equal(await readFile(join(scriptsDir, 'c200.lua'), 'utf8'), '-- new card');
  assert.equal(await readFile(join(prereleaseScriptsDir, 'c300.lua'), 'utf8'), '-- prerelease card');
  assert.deepEqual(result.updatedBaseScripts.map((entry) => entry.file).sort(), ['constant.lua', 'procedure.lua', 'utility.lua']);

  const again = await pullMissingScripts(
    { scriptsDir, prereleaseScriptsDir, scriptDirs: [prereleaseScriptsDir, scriptsDir] },
    { fetchImpl: rangeFetch(files), scriptArchiveUrl: 'https://fixture/script.zip', prereleaseYpkUrl: 'https://fixture/ygopro-super-pre.ypk' },
  );
  assert.equal(again.updatedBaseScripts, undefined, 'unchanged base scripts are not rewritten');
  assert.equal(again.scripts.length, 0);
});
