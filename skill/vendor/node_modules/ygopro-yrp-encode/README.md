# ygopro-yrp-encode

A platform-agnostic YGOPro `.yrp` / `.yrp2` replay parser and writer (no Node `Buffer` usage inside the core logic).

## Install

```bash
npm i ygopro-yrp-encode
```

## API

### `YGOProYrp`

Main class for reading and writing replays.

```ts
import { YGOProYrp } from 'ygopro-yrp-encode';

// Read
const payload = fs.readFileSync('tests/ygopro-yrp-test.yrp');
const yrp = new YGOProYrp().fromYrp(payload);

console.log(yrp.hostName);   // first player name
console.log(yrp.clientName); // second player name

// Write
const out = yrp.toYrp();
fs.writeFileSync('ygopro-yrp-test-remake.yrp', out);
```

### `YGOProYrpLike`

Structure used by the deep-copy constructor.

```ts
import { YGOProYrp, type YGOProYrpLike } from 'ygopro-yrp-encode';

const copy = new YGOProYrp(existing as YGOProYrpLike); // deep copy
```

### `ReplayHeader`

Header object used by `YGOProYrp`. It exposes flags and LZMA properties.

```ts
import { ReplayHeader, REPLAY_ID_YRP1, REPLAY_ID_YRP2 } from 'ygopro-yrp-encode';

const header = new ReplayHeader();
header.id = REPLAY_ID_YRP1;
```

### Constants

```ts
import {
  SEED_COUNT,
  REPLAY_ID_YRP1,
  REPLAY_ID_YRP2,
  REPLAY_COMPRESSED_FLAG,
  REPLAY_TAG_FLAG,
  REPLAY_DECODED_FLAG,
  REPLAY_SINGLE_MODE,
  REPLAY_UNIFORM,
} from 'ygopro-yrp-encode';
```

## Notes

- Repacking will usually produce a different SHA256, because LZMA compression output is not byte-stable.
- Tag duel fields (`tag*`) are only present when `header.isTag` is true.
