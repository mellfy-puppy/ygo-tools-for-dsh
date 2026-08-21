# ygopro-cdb-encode

YGOPro CDB encoder/decoder and query helpers for Node.js/TypeScript, built on top of `sql.js`.

## Features
- Read and query `.cdb` files with `sql.js`.
- Convert between DB rows and `CardDataEntry`.
- Query with SQL or with a filter object (TypeORM-style operators).
- Create new databases, insert cards, and export `.cdb` bytes.

## Install

```bash
npm i ygopro-cdb-encode
```

## Usage

### Open an existing CDB

```ts
import fs from 'fs';
import initSqlJs from 'sql.js';
import { YGOProCdb } from 'ygopro-cdb-encode';

const SQL = await initSqlJs();
const data = new Uint8Array(fs.readFileSync('cards.cdb'));
const cdb = new YGOProCdb(SQL).from(data);

const blueEyes = cdb.findOne('texts.name = :name', { name: '青眼白龙' });
console.log(blueEyes?.code);
```

### Create a new CDB and add cards

```ts
import initSqlJs from 'sql.js';
import { YGOProCdb, CardDataEntry } from 'ygopro-cdb-encode';

const SQL = await initSqlJs();
const cdb = new YGOProCdb(SQL);

const card = new CardDataEntry().fromPartial({
  code: 123456,
  name: '测试卡',
  desc: '测试描述',
  attack: 1800,
  defense: 1000,
  level: 4,
});

cdb.addCard(card);
const bytes = cdb.export(); // Uint8Array
```

## Query API

### SQL statement

```ts
const cards = cdb.find('datas.atk >= :atk AND texts.name = :name', {
  atk: 2000,
  name: '黑魔术师',
});
```

### Filter object

```ts
const cards = cdb.find({
  name: '黑魔术师',
  atk: MoreThanOrEqual(2000),
});
```

### Operators

```ts
import {
  Not,
  LessThan,
  MoreThan,
  LessThanOrEqual,
  MoreThanOrEqual,
  And,
  Or,
  HasBit,
  HasAllBits,
} from 'ygopro-cdb-encode';
```

- `Not(value)` / `Not(op)`
- `LessThan(value)`
- `MoreThan(value)`
- `LessThanOrEqual(value)`
- `MoreThanOrEqual(value)`
- `And(...values | ...ops)`
- `Or(...values | ...ops)`
- `HasBit(value)` → `column & value != 0`
- `HasAllBits(value)` → `column & value = value`

## Virtual fields in filters

The filter API supports computed fields to match `CardData` semantics:

- `code` → `datas.id`
- `level` → `datas.level & 255`
- `lscale` → `(datas.level >> 24) & 255`
- `rscale` → `(datas.level >> 16) & 255`
- `rawLevel` → `datas.level`
- `rawDefense` → `datas.def`
- `defense` → `CASE WHEN TYPE_LINK THEN NULL ELSE datas.def END`
- `linkMarker` → `CASE WHEN TYPE_LINK THEN datas.def ELSE NULL END`

## API Overview

```ts
class YGOProCdb {
  constructor(sqljs: SqlJsStatic | Database | YGOProCdb)
  from(db: Database | Uint8Array): this

  find(stmt?: string, params?: Record<string, any>): CardDataEntry[]
  find(filter?: CdbFindFilter): CardDataEntry[]
  findOne(stmt?: string, params?: Record<string, any>): CardDataEntry | undefined
  findOne(filter?: CdbFindFilter): CardDataEntry | undefined
  findById(id: number): CardDataEntry | undefined

  addCard(card: CardDataEntry | CardDataEntry[]): this
  export(): Uint8Array
  finalize(): void
}
```

## License

MIT
