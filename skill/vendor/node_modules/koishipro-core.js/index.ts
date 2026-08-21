import { Buffer } from 'buffer';

if (
  typeof globalThis !== 'undefined' &&
  !(globalThis as { Buffer?: unknown }).Buffer
) {
  (globalThis as { Buffer?: unknown }).Buffer = Buffer;
}

export * from './src/ocgcore-wrapper';
export * from './src/ocgcore-duel';
export * from './src/create-ocgcore-wrapper';
export * from './src/types';
export * from './src/adapters';
export * from './src/constants';
// export * from './src/utility';
export * as _OcgcoreConstants from './src/vendor';
export * from './src/script-reader';
export * from './src/card-reader';
export * from './src/play-yrp';
export * from './src/test-card';
export * from './src/advancors';
export * from './src/utility/search-zips';
export * from './src/utility/lua-coverage';
export { CardDataEntry as _CardDataEntry } from 'ygopro-cdb-encode';
