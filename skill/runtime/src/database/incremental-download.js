import { readFile, writeFile, mkdir, readdir, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { inflateRawSync } from 'node:zlib';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const { requireSkillDependency } = require('../vendor-require.cjs');
const SQL = await requireSkillDependency('sql.js')();
const CORE = 'https://cdn01.moestart.com/koishipro/';
const PRE = 'https://cdn02.moecube.com:444/ygopro-super-pre/';
const DATA_COLUMNS = ['id', 'ot', 'alias', 'setcode', 'type', 'atk', 'def', 'level', 'race', 'attribute', 'category'];
const TEXT_COLUMNS = ['id', 'name', 'desc', ...Array.from({ length: 16 }, (_, i) => `str${i + 1}`)];

export async function pullMissingCardData(paths, options = {}) {
  const started = Date.now();
  const transfer = new Transfer(options);
  const local = await readLocalIds(paths.cardDbPaths);
  const result = { mode: 'network-missing-only', addedCards: [], addedDataRows: [], addedTextRows: [], scripts: [], data: [], missingScripts: [], errors: [], transfer: transfer.stats };
  transfer.report('catalog', 'Reading the online card catalog and resource directories.');
  const catalog = JSON.parse((await transfer.get(options.prereleaseCatalogUrl ?? PRE + 'versions/master/test-release-v2.json')).toString('utf8'));
  const names = new Map(catalog.map(card => [Number(card.id), card.name]));
  const formal = new RemoteSqlite(new RangeFile(options.cardsUrl ?? CORE + 'ygopro-database/zh-CN/cards.cdb', transfer));
  const prerelease = new RemoteZip(new RangeFile(options.prereleaseYpkUrl ?? PRE + 'archive/ygopro-super-pre.ypk', transfer));
  const scripts = new RemoteZip(new RangeFile(options.scriptArchiveUrl ?? CORE + 'script-zip/script.zip', transfer));
  await Promise.all([formal.open(), prerelease.open(), scripts.open()]);

  transfer.report('cards', 'Fetching missing card records from official sources.');
  const formalRows = await formal.rows('datas');
  const missingFormal = formalRows.filter(row => !local.datas.has(Number(row[0])) || !local.texts.has(Number(row[0])));
  const formalTexts = await formal.rows('texts', new Set(missingFormal.map(row => Number(row[0]))));
  await appendCards(paths.cardsPath, missingFormal, formalTexts, local, names, result);
  transfer.report('cards', `Added ${result.addedCards.length} formal cards; reading missing prerelease records.`);

  // Only these database members are fetched from the YPK, never the package or pictures.
  for (const [member, destination] of [['test-update.cdb', paths.prereleaseUpdateDbPath], ['test-release.cdb', paths.prereleaseReleaseDbPath]]) {
    const source = new RemoteSqlite(new MemoryFile(await prerelease.member(member)));
    await source.open();
    const rows = (await source.rows('datas')).filter(row => !local.datas.has(Number(row[0])) || !local.texts.has(Number(row[0])));
    const texts = await source.rows('texts', new Set(rows.map(row => Number(row[0]))));
    await appendCards(destination, rows, texts, local, names, result);
  }
  transfer.report('scripts', `Added ${result.addedCards.length} cards. Fetching absent Lua files.`);
  await addScripts(prerelease, paths.prereleaseScriptsDir, paths.scriptDirs, 'script/', result);
  await addScripts(scripts, paths.scriptsDir, paths.scriptDirs, '', result);
  for (const card of [...formalRows, ...local.runtime]) {
    const [id, , alias, , type] = card.map(value => typeof value === 'bigint' ? Number(value) : value);
    const needsScript = !(type & 0x4000) && ((type & 6) || (type & 0x8000000) || ((type & 1) && (!(type & 0x10) || (type & 0x1000000))));
    if (needsScript && !result.availableScripts.has(`c${id}.lua`) && !(alias && result.availableScripts.has(`c${alias}.lua`))) result.missingScripts.push(Number(id));
  }
  delete result.availableScripts;

  // Existing string IDs and banlist sections remain untouched; append new entries.
  const strings = await transfer.get(options.stringsUrl ?? CORE + 'ygopro-database/zh-CN/strings.conf');
  await appendStrings(paths.stringsPath, strings, result);
  if (prerelease.entries.has('test-strings.conf')) await appendStrings(paths.prereleaseStringsPath, await prerelease.member('test-strings.conf'), result);
  await appendBanlists(paths.lflistPath, await transfer.get(options.lflistUrl ?? CORE + 'ygopro-database/zh-CN/lflist.conf'), result);
  result.pendingCatalogCards = catalog.filter(card => !local.datas.has(Number(card.id)) || !local.texts.has(Number(card.id))).map(card => ({ id: card.id, name: card.name }));
  result.elapsedMs = Date.now() - started;
  transfer.report('complete', `Added ${result.addedCards.length} cards and ${result.scripts.length} scripts; downloaded ${transfer.stats.bytesReceived} bytes.`);
  await mkdir(paths.dataDir, { recursive: true });
  await writeFile(resolve(paths.dataDir, 'last-incremental-pull.json'), JSON.stringify(result, null, 2));
  return { ok: result.errors.length === 0, data: { paths, ...result } };
}

export async function pullMissingScripts(paths, options = {}) {
  const transfer = new Transfer(options);
  const result = { mode: 'network-missing-only', scripts: [], errors: [], transfer: transfer.stats };
  const sources = [
    [options.prereleaseYpkUrl ?? PRE + 'archive/ygopro-super-pre.ypk', paths.prereleaseScriptsDir, 'script/'],
    [options.scriptArchiveUrl ?? CORE + 'script-zip/script.zip', paths.scriptsDir, ''],
  ];
  for (const [url, destination, prefix] of sources) {
    const archive = new RemoteZip(new RangeFile(url, transfer));
    await archive.open();
    await addScripts(archive, destination, paths.scriptDirs, prefix, result);
  }
  delete result.availableScripts;
  return { ok: result.errors.length === 0, ...result };
}

export async function distributeMissingPull(source, destination, pulled) {
  const local = await readLocalIds(destination.cardDbPaths);
  const result = { addedCards: [], addedDataRows: [], addedTextRows: [], scripts: [], data: [] };
  const ids = new Set([...pulled.addedDataRows, ...pulled.addedTextRows]);
  for (const key of ['cardsPath', 'prereleaseUpdateDbPath', 'prereleaseReleaseDbPath']) {
    const db = new RemoteSqlite(new MemoryFile(await readFile(source[key])));
    await db.open();
    await appendCards(destination[key], await db.rows('datas', ids), await db.rows('texts', ids), local, new Map(), result);
  }
  const present = new Set();
  for (const dir of destination.scriptDirs) for (const name of await listFiles(dir)) present.add(name);
  const baseFiles = new Set((pulled.updatedBaseScripts ?? []).map(script => script.path));
  for (const script of pulled.scripts) {
    if (present.has(script.file) && !baseFiles.has(script.path)) continue;
    const root = script.path.startsWith(source.prereleaseScriptsDir) ? destination.prereleaseScriptsDir : destination.scriptsDir;
    const path = resolve(root, script.file);
    await saveFile(path, await readFile(script.path));
    result.scripts.push({file:script.file,path});
  }
  await appendStrings(destination.stringsPath, await readFile(source.stringsPath), result);
  await appendStrings(destination.prereleaseStringsPath, await readFile(source.prereleaseStringsPath), result);
  await appendBanlists(destination.lflistPath, await readFile(source.lflistPath), result);
  return result;
}

async function readLocalIds(paths) {
  const local = { datas: new Set(), texts: new Set(), runtime: [] };
  for (const path of paths) {
    const bytes = await readFile(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!bytes) continue;
    const db = new SQL.Database(bytes);
    try {
      for (const table of ['datas', 'texts']) {
        const rows = db.exec(`SELECT id FROM ${table}`)[0]?.values ?? [];
        for (const [id] of rows) local[table].add(Number(id));
      }
      for (const [id, alias, type] of db.exec('SELECT id, alias, type FROM datas')[0]?.values ?? []) local.runtime.push([id, 0, alias, 0, type]);
    } finally { db.close(); }
  }
  return local;
}

async function appendCards(path, rows, texts, local, names, result) {
  const newData = rows.filter(row => !local.datas.has(Number(row[0])));
  const newText = texts.filter(row => !local.texts.has(Number(row[0])));
  if (!newData.length && !newText.length) return;
  const previous = await readFile(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  const db = new SQL.Database(previous ?? undefined);
  try {
    db.run('CREATE TABLE IF NOT EXISTS datas (id INTEGER PRIMARY KEY, ot INTEGER, alias INTEGER, setcode INTEGER, type INTEGER, atk INTEGER, def INTEGER, level INTEGER, race INTEGER, attribute INTEGER, category INTEGER)');
    db.run('CREATE TABLE IF NOT EXISTS texts (id INTEGER PRIMARY KEY, name TEXT, desc TEXT, ' + TEXT_COLUMNS.slice(3).map(column => column + ' TEXT').join(', ') + ')');
    db.run('BEGIN');
    for (const [table, columns, values] of [['datas', DATA_COLUMNS, newData], ['texts', TEXT_COLUMNS, newText]]) {
      for (const row of values) {
        const data = row.slice(0, columns.length);
        if (table === 'texts' && names.has(Number(row[0]))) data[1] = names.get(Number(row[0]));
        const placeholders = data.map(value => typeof value === 'bigint' ? 'CAST(? AS INTEGER)' : '?');
        db.run(`INSERT OR IGNORE INTO ${table} (${columns.join(',')}) VALUES (${placeholders.join(',')})`, data.map(value => typeof value === 'bigint' ? value.toString() : value));
      }
    }
    db.run('COMMIT');
    await saveFile(path, Buffer.from(db.export()));
    for (const row of newData) { const id = Number(row[0]); local.datas.add(id); result.addedDataRows.push(id); result.addedCards.push(id); local.runtime.push(row); }
    for (const row of newText) { const id = Number(row[0]); local.texts.add(id); result.addedTextRows.push(id); }
  } finally { db.close(); }
}

async function addScripts(archive, destination, searchDirs, prefix, result) {
  const present = result.availableScripts ?? new Set();
  for (const dir of searchDirs) for (const name of await listFiles(dir)) present.add(name);
  result.availableScripts = present;
  // Card scripts are fetched only when absent. Base scripts (constant, utility,
  // procedure, ...) are always taken from the same source, because new card
  // scripts depend on definitions that only the matching base copies provide.
  const isBaseScript = name => /^[A-Za-z_][A-Za-z0-9_]*\.lua$/.test(name) && !/^c\d+\.lua$/.test(name);
  const missing = [...archive.entries.values()].filter(entry => {
    if (!entry.name.startsWith(prefix)) return false;
    const name = entry.name.slice(prefix.length);
    if (!/^(?:[A-Za-z0-9_]+\.lua|patches\/[A-Za-z0-9_-]+\.lua)$/.test(name)) return false;
    return isBaseScript(name) || !present.has(name);
  });
  archive.file.transfer.report('scripts', `${missing.length} absent scripts in ${prefix ? 'prerelease' : 'formal'} source.`);
  const groups = [];
  for (const entry of missing.sort((a, b) => a.offset - b.offset)) {
    const previous = groups.at(-1);
    if (previous && previous.at(-1).end === entry.offset && entry.end - previous[0].offset < 262144) previous.push(entry);
    else groups.push([entry]);
  }
  await parallel(groups, 6, async entries => {
    try {
      const bytes = await archive.file.read(entries[0].offset, entries.at(-1).end - entries[0].offset);
      for (const entry of entries) {
        const start = entry.offset - entries[0].offset;
        const member = bytes.subarray(start, entry.end - entries[0].offset);
        const offset = 30 + member.readUInt16LE(26) + member.readUInt16LE(28);
        const compressed = member.subarray(offset, offset + entry.compressed);
        const payload = entry.method === 8 ? inflateRawSync(compressed) : compressed;
        const name = entry.name.slice(prefix.length);
        const target = resolve(destination, name);
        if (isBaseScript(name)) {
          const current = await readFile(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
          if (current && current.equals(payload)) { present.add(name); continue; }
          (result.updatedBaseScripts ??= []).push({ file: name, path: target, bytes: payload.length, replaced: Boolean(current) });
        }
        await saveFile(target, payload);
        present.add(name);
        result.scripts.push({ file: name, path: target, bytes: payload.length });
      }
      archive.file.transfer.report('scripts', `Installed ${result.scripts.length} new scripts.`);
    } catch (error) { for (const entry of entries) result.errors.push({ file: entry.name.slice(prefix.length), error: error.message }); }
  });
}

async function listFiles(dir, prefix = '') {
  const names = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
    if (entry.isDirectory()) names.push(...await listFiles(resolve(dir, entry.name), prefix + entry.name + '/'));
    else names.push(prefix + entry.name);
  }
  return names;
}

async function appendStrings(path, bytes, result) {
  const original = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  const key = line => line.match(/^!\S+\s+\S+/)?.[0].replace(/\s+/g, ' ');
  const present = new Set(original.split(/\r?\n/).map(key).filter(Boolean));
  const added = bytes.toString('utf8').split(/\r?\n/).filter(line => { const id = key(line); if (!id || present.has(id)) return false; present.add(id); return true; });
  if (added.length) { await saveFile(path, Buffer.from(original + (original.endsWith('\n') ? '' : '\n') + added.join('\n') + '\n')); result.data.push({ path, addedEntries: added.length }); }
}

async function appendBanlists(path, bytes, result) {
  const original = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  const names = new Set([...original.matchAll(/^!([^\r\n]+)/gm)].map(match => match[1]));
  const blocks = bytes.toString('utf8').split(/(?=^!)/m).filter(block => block.startsWith('!') && !names.has(block.match(/^!([^\r\n]+)/)[1]));
  if (blocks.length) { await saveFile(path, Buffer.from(original + '\n' + blocks.join('\n'))); result.data.push({ path, addedBanlists: blocks.length }); }
}

async function saveFile(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.new`;
  await writeFile(temporary, bytes);
  await rename(temporary, path);
}

class Transfer {
  constructor(options) { this.options = options; this.active = 0; this.waiting = []; this.started = Date.now(); this.stats = { requests: 0, bytesReceived: 0, resources: {} }; }
  report(phase, message) {
    const progress = { phase, message, elapsedMs: Date.now() - this.started, ...this.stats };
    this.options.onProgress?.(progress);
    if (this.options.progress) console.error(`[YGO incremental] ${message}`);
  }
  async get(url, range) {
    if (this.active >= 6) await new Promise(resolve => this.waiting.push(resolve));
    this.active++;
    try {
      for (let attempt = 0; ; attempt++) {
        try { return await this.receive(url, range); }
        catch (error) {
          if (attempt >= 2 || error.httpStatus) throw error;
          this.report('retry', `Retrying ${url} ${range ?? ''}: ${error.message}`);
        }
      }
    } finally { this.active--; this.waiting.shift()?.(); }
  }
  async receive(url, range) {
      if (process.platform === 'win32' && !this.options.fetchImpl) {
        const response = await curlBytes(url, range, this.options);
        this.stats.requests++;
        if (this.stats.requests % 50 === 0) this.report('download', `Received ${this.stats.bytesReceived} bytes in ${this.stats.requests} incremental requests.`);
        this.stats.bytesReceived += response.length;
        this.stats.resources[url] = (this.stats.resources[url] ?? 0) + response.length;
        return response;
      }
      const controller = new AbortController();
      const idleMs = Math.min(60000, this.options.timeoutMs ?? 30000);
      let timer;
      const tick = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(), idleMs); };
      tick();
      try {
        const response = await (this.options.fetchImpl ?? fetch)(url, { signal: controller.signal, headers: { 'User-Agent': 'YGOagentskill-incremental', 'Accept-Encoding': 'identity', Connection: 'close', ...(range ? { Range: range } : {}) } });
        if ((range && response.status !== 206) || !response.ok) { await response.body?.cancel(); throw new Error(`${url}: HTTP ${response.status}${range ? '; partial response required' : ''}`); }
        const chunks = [];
        for await (const chunk of response.body) {
          tick(); chunks.push(Buffer.from(chunk)); this.stats.bytesReceived += chunk.length;
          this.stats.resources[url] = (this.stats.resources[url] ?? 0) + chunk.length;
        }
        this.stats.requests++;
        const bytes = Buffer.concat(chunks);
        bytes.responseUrl = response.url || url;
        bytes.totalSize = Number(response.headers.get('content-range')?.split('/')[1] ?? response.headers.get('content-length'));
        bytes.contentType = response.headers.get('content-type');
        return bytes;
      } finally { clearTimeout(timer); }
  }
}

class RangeFile {
  constructor(url, transfer) { this.url = url; this.transfer = transfer; }
  async read(start, length) {
    if (!length) return Buffer.alloc(0);
    const bytes = await this.transfer.get(this.url, `bytes=${start}-${start + length - 1}`);
    this.url = bytes.responseUrl;
    this.size = bytes.totalSize;
    return bytes;
  }
  async readMany(ranges) {
    return parallel(ranges, 6, item => this.read(item.start, item.length));
  }
  async tail(length) {
    const bytes = await this.transfer.get(this.url, `bytes=-${length}`);
    this.url = bytes.responseUrl; this.size = bytes.totalSize; return bytes;
  }
}
class MemoryFile {
  constructor(bytes) { this.bytes = bytes; }
  async read(start, length) { return this.bytes.subarray(start, start + length); }
  async readMany(ranges) { return ranges.map(item => this.bytes.subarray(item.start, item.start + item.length)); }
}

class RemoteZip {
  constructor(file) { this.file = file; this.entries = new Map(); }
  async open() {
    const tail = await this.file.tail(65557);
    const end = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const size = tail.readUInt32LE(end + 12), offset = tail.readUInt32LE(end + 16);
    const start = this.file.size - tail.length;
    const directory = offset >= start ? tail.subarray(offset - start, offset - start + size) : await this.file.read(offset, size);
    for (let at = 0; at < directory.length;) {
      const nameLength = directory.readUInt16LE(at + 28), extra = directory.readUInt16LE(at + 30), comment = directory.readUInt16LE(at + 32);
      const name = directory.toString('utf8', at + 46, at + 46 + nameLength);
      this.entries.set(name, { name, method: directory.readUInt16LE(at + 10), compressed: directory.readUInt32LE(at + 20), offset: directory.readUInt32LE(at + 42) });
      at += 46 + nameLength + extra + comment;
    }
    const ordered = [...this.entries.values()].sort((a, b) => a.offset - b.offset);
    ordered.forEach((entry, i) => { entry.end = ordered[i + 1]?.offset ?? offset; });
  }
  async member(name) {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`Official archive has no ${name}`);
    const member = await this.file.read(entry.offset, entry.end - entry.offset);
    const start = 30 + member.readUInt16LE(26) + member.readUInt16LE(28);
    const bytes = member.subarray(start, start + entry.compressed);
    if (entry.method === 0) return bytes;
    if (entry.method === 8) return inflateRawSync(bytes);
    throw new Error(`ZIP compression method ${entry.method} is unsupported`);
  }
}

// SQLite table B-trees expose a compact card-number index. Text pages are read
// only along paths containing missing IDs; no complete cards.cdb is fetched.
class RemoteSqlite {
  constructor(file) { this.file = file; this.pages = new Map(); this.roots = new Map(); }
  async open() {
    const header = await this.file.read(0, 100);
    this.pageSize = header.readUInt16BE(16) || 65536;
    if (this.pageSize === 1) this.pageSize = 65536;
    this.usable = this.pageSize - header[20];
    const schema = await this.tree(1, null);
    for (const row of schema) if (row.values[0] === 'table') this.roots.set(row.values[1], Number(row.values[3]));
  }
  page(id) {
    if (!this.pages.has(id)) this.pages.set(id, this.file.read((id - 1) * this.pageSize, this.pageSize));
    return this.pages.get(id);
  }
  async prefetch(ids) {
    const missing = [...new Set(ids)].filter(id => !this.pages.has(id)).sort((a, b) => a - b);
    const groups = [];
    for (const id of missing) {
      const last = groups.at(-1);
      if (last && id === last.at(-1) + 1 && last.length < 128) last.push(id);
      else groups.push([id]);
    }
    const batches = [];
    for (let i = 0; i < groups.length; i += 12) batches.push(groups.slice(i, i + 12));
    await parallel(batches, 3, async batch => {
      const ranges = batch.map(group => ({ start: (group[0] - 1) * this.pageSize, length: group.length * this.pageSize }));
      const buffers = await this.file.readMany(ranges);
      for (let j = 0; j < batch.length; j++) for (let i = 0; i < batch[j].length; i++) this.pages.set(batch[j][i], Promise.resolve(buffers[j].subarray(i * this.pageSize, (i + 1) * this.pageSize)));
    });
  }

  async rows(table, ids = null) {
    if (ids?.size === 0) return [];
    const rows = await this.tree(this.roots.get(table), ids);
    return rows.map(row => { row.values[0] = row.id; return row.values; });
  }
  async tree(id, ids) {
    const page = await this.page(id);
    const h = id === 1 ? 100 : 0;
    const type = page[h], count = page.readUInt16BE(h + 3);
    const output = [];
    if (type === 5) {
      let lower = -Infinity;
      const children = [];
      for (let i = 0; i <= count; i++) {
        const cell = i < count ? page.readUInt16BE(h + 12 + i * 2) : null;
        const child = cell === null ? page.readUInt32BE(h + 8) : page.readUInt32BE(cell);
        const upper = cell === null ? Infinity : Number(varint(page, cell + 4).value);
        const selected = ids ? new Set([...ids].filter(value => value > lower && value <= upper)) : null;
        if (!selected || selected.size) children.push({ child, ids: selected });
        lower = upper;
      }
      await this.prefetch(children.map(item => item.child));
      for (const rows of await parallel(children, 8, child => this.tree(child.child, child.ids))) output.push(...rows);
      return output;
    }
    if (type !== 13) throw new Error(`Unsupported SQLite table page ${type}`);
    for (let i = 0; i < count; i++) {
      const cell = page.readUInt16BE(h + 8 + i * 2);
      const length = varint(page, cell), rowid = varint(page, length.next);
      const rowId = Number(rowid.value);
      if (ids && !ids.has(rowId)) continue;
      const size = Number(length.value);
      const max = this.usable - 35, min = Math.floor((this.usable - 12) * 32 / 255) - 23;
      let localSize = size;
      if (size > max) { localSize = min + (size - min) % (this.usable - 4); if (localSize > max) localSize = min; }
      const chunks = [page.subarray(rowid.next, rowid.next + localSize)];
      let remaining = size - localSize;
      let overflow = remaining ? page.readUInt32BE(rowid.next + localSize) : 0;
      while (remaining > 0) {
        const block = await this.page(overflow);
        const take = Math.min(remaining, this.usable - 4);
        chunks.push(block.subarray(4, 4 + take)); remaining -= take; overflow = block.readUInt32BE(0);
      }
      output.push({ id: rowId, values: decodeRecord(Buffer.concat(chunks)) });
    }
    return output;
  }
}

function varint(buffer, offset) {
  let value = 0n;
  for (let i = 0; i < 9; i++) {
    const byte = buffer[offset++];
    if (i === 8) return { value: (value << 8n) | BigInt(byte), next: offset };
    value = (value << 7n) | BigInt(byte & 127);
    if (byte < 128) return { value, next: offset };
  }
}
function decodeRecord(buffer) {
  const header = varint(buffer, 0);
  let at = header.next, data = Number(header.value);
  const values = [];
  while (at < Number(header.value)) {
    const serial = varint(buffer, at); at = serial.next;
    const type = Number(serial.value);
    if (type === 0) { values.push(null); continue; }
    if (type === 8 || type === 9) { values.push(type - 8); continue; }
    if (type === 7) { values.push(buffer.readDoubleBE(data)); data += 8; continue; }
    if (type >= 12) {
      const length = Math.floor((type - 12) / 2);
      values.push(type % 2 ? buffer.toString('utf8', data, data + length) : buffer.subarray(data, data + length)); data += length; continue;
    }
    const length = [0, 1, 2, 3, 4, 6, 8][type];
    let value = 0n;
    for (let i = 0; i < length; i++) value = (value << 8n) | BigInt(buffer[data + i]);
    if (buffer[data] & 128) value -= 1n << BigInt(length * 8);
    values.push(value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(value) : value);
    data += length;
  }
  return values;
}
async function parallel(items, count, fn) {
  const output = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(count, items.length) }, async () => {
    while (next < items.length) { const index = next++; output[index] = await fn(items[index], index); }
  }));
  return output;
}

function curlBytes(url, range, options) {
  return new Promise((resolve, reject) => {
    const args = ['--ipv4', '--location', '--silent', '--show-error', '--include', '--connect-timeout', '8', '--speed-time', '15', '--speed-limit', '1', '--max-time', '60', '--header', 'Accept-Encoding: identity', '--header', 'Connection: close'];
    if (range) args.push('--header', 'Range: ' + range);
    if (options.proxyUrl) args.push('--proxy', options.proxyUrl);
    args.push(url);
    const child = spawn('curl.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [], errors = [];
    let pendingHeaders = Buffer.alloc(0), readingHeaders = true, responseError;
    child.stdout.on('data', chunk => {
      chunks.push(chunk);
      if (!readingHeaders) return;
      pendingHeaders = Buffer.concat([pendingHeaders, chunk]);
      let end;
      while ((end = pendingHeaders.indexOf('\r\n\r\n')) >= 0) {
        const header = pendingHeaders.toString('ascii', 0, end);
        const status = Number(header.split(' ')[1]);
        pendingHeaders = pendingHeaders.subarray(end + 4);
        if ((status >= 300 && status < 400) || status < 200 || /200 Connection established/i.test(header)) continue;
        readingHeaders = false;
        if (status >= 400 || (range && status !== 206)) {
          responseError = Object.assign(new Error(`${url}: HTTP ${status}; partial response required`), { httpStatus: status });
          child.kill();
        }
        break;
      }
    });
    child.stderr.on('data', chunk => errors.push(chunk));
    child.on('error', reject);
    child.on('close', code => {
      if (responseError) return reject(responseError);
      if (code) return reject(new Error(Buffer.concat(errors).toString().trim()));
      const output = Buffer.concat(chunks);
      let at = 0, status, headers, effectiveUrl = url;
      while (output.toString('ascii', at, at + 5) === 'HTTP/') {
        const end = output.indexOf('\r\n\r\n', at);
        const lines = output.toString('utf8', at, end).split('\r\n');
        status = Number(lines[0].split(' ')[1]);
        headers = Object.fromEntries(lines.slice(1).map(line => { const index = line.indexOf(':'); return [line.slice(0, index).toLowerCase(), line.slice(index + 1).trim()]; }));
        if (headers.location) effectiveUrl = new URL(headers.location, effectiveUrl).href;
        at = end + 4;
      }
      if (status >= 400 || (range && status !== 206)) return reject(Object.assign(new Error(`${url}: HTTP ${status}; partial response required`), { httpStatus: status }));
      const bytes = output.subarray(at);
      bytes.responseUrl = effectiveUrl;
      bytes.totalSize = Number(headers['content-range']?.split('/')[1] ?? headers['content-length']);
      bytes.contentType = headers['content-type'];
      resolve(bytes);
    });
  });
}
