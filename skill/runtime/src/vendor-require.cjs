'use strict';

const { createRequire } = require('node:module');
const path = require('node:path');

const SKILL_ROOT = path.resolve(__dirname, '..', '..');
const VENDOR_NODE_MODULES = path.join(SKILL_ROOT, 'vendor', 'node_modules');
const vendorRequire = createRequire(path.join(VENDOR_NODE_MODULES, '.ygoagentskill-vendor.cjs'));

function requireSkillDependency(moduleName) {
  try {
    return vendorRequire(moduleName);
  } catch (vendorError) {
    try {
      return require(moduleName);
    } catch (fallbackError) {
      const error = new Error(
        `Unable to load dependency "${moduleName}". Expected it under vendor/node_modules inside YGOagentskill.`,
      );
      error.cause = fallbackError;
      error.vendorError = vendorError;
      throw error;
    }
  }
}

function requireOptionalSkillDependency(moduleName) {
  try {
    return requireSkillDependency(moduleName);
  } catch {
    return null;
  }
}

function resolveSkillDependency(moduleName) {
  try {
    return vendorRequire.resolve(moduleName);
  } catch (vendorError) {
    try {
      return require.resolve(moduleName);
    } catch (fallbackError) {
      const error = new Error(
        `Unable to resolve dependency "${moduleName}". Expected it under vendor/node_modules inside YGOagentskill.`,
      );
      error.cause = fallbackError;
      error.vendorError = vendorError;
      throw error;
    }
  }
}

module.exports = {
  SKILL_ROOT,
  VENDOR_NODE_MODULES,
  requireSkillDependency,
  requireOptionalSkillDependency,
  resolveSkillDependency,
};
