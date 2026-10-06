import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadOverlayPatches, evaluatePluginCompatibility } from '@deepseek-ai/dsh-app-boot';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
const patchPath = fileURLToPath(new URL('../presets/ygo.patch.yml', import.meta.url));

test('bundle supplies the game preset to current DSH composition', () => {
  assert.equal(manifest.dsh.bundle.patch, './presets/ygo.patch.yml');
  assert.ok(manifest.files.includes('presets'));
  const rows = loadOverlayPatches('ygo-test', patchPath);
  assert.equal(rows.length, 1);
  const preset = rows[0].insert[0];
  assert.equal(preset.name, '@deepseek-ai/dsh-agent-preset');
  assert.equal(preset.config.id, 'ygoai');
  assert.equal(preset.config.name, '游戏王模式');
  const plugins = preset.config.plugins;
  assert.equal(plugins.filter(row => row.name === 'ygo-tools-for-dsh').length, 1);
  assert.ok(plugins.some(row => row.name === '@deepseek-ai/dsh-tool-skill'));
  assert.ok(plugins.some(row => row.name === '@deepseek-ai/dsh-skill-filesystem'));
  assert.ok(plugins.some(row => row.name === '@deepseek-ai/dsh-tool-pwsh'));
  assert.ok(plugins.some(row => row.name === '@deepseek-ai/dsh-tool-bash'));
  assert.equal(new Set(plugins.map(row => row.id)).size, plugins.length);
});

test('declared compatibility admits installed rc.2 and rejects old runtime', () => {
  assert.equal(evaluatePluginCompatibility(manifest, {}, '0.1.7-rc.2'), undefined);
  assert.ok(evaluatePluginCompatibility(manifest, {}, '0.1.0-rc.6'));
});
