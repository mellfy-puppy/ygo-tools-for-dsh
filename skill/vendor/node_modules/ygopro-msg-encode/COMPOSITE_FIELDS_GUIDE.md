# 复合字段使用指南

本文档说明 YGOPro 协议中使用位运算或特殊结构的复合字段。

## MSG_START.playerType

### 字段结构

`playerType` 是一个 `uint8_t` 字段，使用位运算编码了两种信息：

- **低 4 位 (0x0F)**: 玩家编号
- **高 4 位 (0xF0)**: 观战者标志

### 可能的值

| 值 | 十六进制 | 含义 |
|----|----------|------|
| 0 | 0x00 | 玩家 0（你先手） |
| 1 | 0x01 | 玩家 1（对手先手） |
| 16 | 0x10 | 观战者视角（观看玩家 0） |
| 17 | 0x11 | 观战者视角（观看玩家 1，swapped） |

### 使用示例

#### 使用 getter/setter（推荐）

```typescript
import { YGOProMsgStart } from 'ygopro-msg-encode';

const startMsg = new YGOProMsgStart();
startMsg.fromPayload(data);

// 读取低 4 位（玩家编号）
const playerNumber = startMsg.playerNumber;  // 0-3
const isFirst = startMsg.playerNumber === 0;

// 读取高 4 位（观战者标志）
const observerFlag = startMsg.observerFlag;  // 0x00 或 0x10
const isObserver = startMsg.observerFlag !== 0;

// 设置值
startMsg.playerNumber = 1;      // 设置为玩家 1
startMsg.observerFlag = 0x10;   // 设置为观战者

// 组合判断
if (isObserver) {
  console.log(`You are watching player ${playerNumber}`);
} else if (isFirst) {
  console.log('You go first!');
} else {
  console.log('Opponent goes first!');
}
```

#### 直接访问（也可以）

```typescript
// 直接读写 playerType
startMsg.playerType = 0x11;  // 观战者视角，观看玩家 1

// 手动位运算
const playerNumber = startMsg.playerType & 0x0f;
const observerFlag = startMsg.playerType & 0xf0;
```

### 源码参考

```cpp
// duelclient.cpp:1429-1432
int playertype = BufferIO::Read<uint8_t>(pbuf);
mainGame->dInfo.isFirst = (playertype & 0xf) ? false : true;
if(playertype & 0xf0)
    mainGame->dInfo.player_type = 7;  // Observer
```

---

## STOC_DECK_COUNT 卡组数量

### 字段结构

使用嵌套对象结构存储双方玩家的卡组数量：

- `player0DeckCount`: `YGOProStocDeckCount_DeckInfo` - 玩家 0 的卡组信息
  - `main`: `int16_t` - 主卡组数量
  - `extra`: `int16_t` - 额外卡组数量
  - `side`: `int16_t` - 副卡组数量
- `player1DeckCount`: `YGOProStocDeckCount_DeckInfo` - 玩家 1 的卡组信息
  - `main`: `int16_t` - 主卡组数量
  - `extra`: `int16_t` - 额外卡组数量
  - `side`: `int16_t` - 副卡组数量

### 使用示例

#### 直接访问对象属性（推荐）

```typescript
import { YGOProStocDeckCount } from 'ygopro-msg-encode';

const deckCount = new YGOProStocDeckCount();
deckCount.fromFullPayload(data);

// 访问玩家 0 的卡组数量
console.log(`Your deck: Main=${deckCount.player0DeckCount.main}, Extra=${deckCount.player0DeckCount.extra}, Side=${deckCount.player0DeckCount.side}`);

// 访问玩家 1 的卡组数量
console.log(`Opponent: Main=${deckCount.player1DeckCount.main}, Extra=${deckCount.player1DeckCount.extra}, Side=${deckCount.player1DeckCount.side}`);
```

#### 设置卡组数量

```typescript
import { YGOProStocDeckCount, YGOProStocDeckCount_DeckInfo } from 'ygopro-msg-encode';

const deckCount = new YGOProStocDeckCount();
deckCount.player0DeckCount = new YGOProStocDeckCount_DeckInfo();
deckCount.player1DeckCount = new YGOProStocDeckCount_DeckInfo();

// 设置玩家 0
deckCount.player0DeckCount.main = 40;
deckCount.player0DeckCount.extra = 15;
deckCount.player0DeckCount.side = 15;

// 设置玩家 1
deckCount.player1DeckCount.main = 42;
deckCount.player1DeckCount.extra = 14;
deckCount.player1DeckCount.side = 13;

const payload = deckCount.toFullPayload();
```

### 源码参考

```cpp
// single_duel.cpp:485-490 (发送端)
BufferIO::Write<uint16_t>(pbuf, (short)pdeck[0].main.size());
BufferIO::Write<uint16_t>(pbuf, (short)pdeck[0].extra.size());
BufferIO::Write<uint16_t>(pbuf, (short)pdeck[0].side.size());
BufferIO::Write<uint16_t>(pbuf, (short)pdeck[1].main.size());
BufferIO::Write<uint16_t>(pbuf, (short)pdeck[1].extra.size());
BufferIO::Write<uint16_t>(pbuf, (short)pdeck[1].side.size());

// duelclient.cpp:541-548 (接收端)
int deckc = BufferIO::Read<uint16_t>(pdata);
int extrac = BufferIO::Read<uint16_t>(pdata);
int sidec = BufferIO::Read<uint16_t>(pdata);
mainGame->dField.Initial(0, deckc, extrac, sidec);
deckc = BufferIO::Read<uint16_t>(pdata);
extrac = BufferIO::Read<uint16_t>(pdata);
sidec = BufferIO::Read<uint16_t>(pdata);
mainGame->dField.Initial(1, deckc, extrac, sidec);
```

---

## STOC_TYPE_CHANGE.type

### 字段结构

`type` 是一个 `uint8_t` 字段，使用位运算编码玩家位置和房主状态：

- **低 4 位 (0x0F)**: 玩家位置 (0-7)
- **高 4 位 (0xF0)**: 房主标志 (0x10 = 房主, 0x00 = 非房主)

### 使用示例

#### 使用 getter/setter（推荐）

```typescript
import { YGOProStocTypeChange } from 'ygopro-msg-encode';

const typeChange = new YGOProStocTypeChange();
typeChange.fromFullPayload(data);

// 读取玩家位置
const pos = typeChange.playerPosition;  // 0-7

// 读取房主状态
const isHost = typeChange.isHost;  // true/false

// 设置值
typeChange.playerPosition = 2;
typeChange.isHost = true;  // 设置为房主
```

#### 直接访问（也可以）

```typescript
// 直接位运算
const pos = typeChange.type & 0x0f;
const isHost = ((typeChange.type >> 4) & 0x0f) !== 0;
```

### 源码参考

```cpp
// duelclient.cpp:645-646
selftype = pkt->type & 0xf;
is_host = ((pkt->type >> 4) & 0xf) != 0;
```

---

## STOC_HS_PLAYER_CHANGE.status

### 字段结构

`status` 是一个 `uint8_t` 字段，使用位运算编码玩家位置和状态：

- **低 4 位 (0x0F)**: 玩家状态 (PlayerChangeState 或位置 0-7)
- **高 4 位 (0xF0)**: 玩家位置 (0-3)

### 使用示例

#### 使用 getter/setter（推荐）

```typescript
import { YGOProStocHsPlayerChange, PlayerChangeState } from 'ygopro-msg-encode';

const playerChange = new YGOProStocHsPlayerChange();
playerChange.fromFullPayload(data);

// 读取玩家位置
const pos = playerChange.playerPosition;  // 0-3

// 读取状态
const state = playerChange.playerState;
if (state === PlayerChangeState.READY) {
  console.log(`Player ${pos} is ready!`);
}

// 设置值
playerChange.playerPosition = 1;
playerChange.playerState = PlayerChangeState.READY;
```

#### 直接访问（也可以）

```typescript
// 直接位运算
const pos = (playerChange.status >> 4) & 0x0f;
const state = playerChange.status & 0x0f;
```

### 源码参考

```cpp
// duelclient.cpp:991-992
unsigned char pos = (pkt->status >> 4) & 0xf;
unsigned char state = pkt->status & 0xf;

// single_duel.cpp:372 (设置值)
scpc.status = (dp->type << 4) | (is_ready ? PLAYERCHANGE_READY : PLAYERCHANGE_NOTREADY);
```

---

## 其他复合字段

### STOC_ErrorMsg.code (当 msg == DECKERROR 时)

复合字段（未提供辅助方法，使用位运算）：

- **高 4 位**: 卡组错误类型 (DeckErrorType)
- **低 28 位**: 卡片 ID

```typescript
if (errorMsg.msg === ErrorMessageType.DECKERROR) {
  const errorType = (errorMsg.code >> 28) & 0xf;  // DeckErrorType
  const cardId = errorMsg.code & 0x0fffffff;      // Card ID
}
```

---

## 设计原则

这些复合字段的设计遵循以下原则：

1. **节省带宽**：在一个字节中编码多个信息
2. **向后兼容**：通过位运算扩展功能而不破坏现有结构
3. **简单解析**：使用简单的位运算即可提取信息

## 最佳实践

1. **使用对象属性和 getter/setter**：优先使用结构化的对象属性（如 `player0DeckCount.main`）和 getter/setter（如 `startMsg.playerNumber`）
2. **避免直接位运算**：除非有特殊需求，否则避免直接对 `playerType` 等字段进行位运算
3. **类型安全**：利用 TypeScript 的类型系统和枚举来确保正确性

```typescript
// ✅ 推荐：使用 getter/setter
if (startMsg.observerFlag !== 0) {
  const watching = startMsg.playerNumber;
}

// ✅ 推荐：使用对象属性
console.log(`Main deck: ${deckCount.player0DeckCount.main}`);

// ⚠️ 可以但不推荐：直接位运算
if (startMsg.playerType & 0xf0) {
  const watching = startMsg.playerType & 0x0f;
}
```
