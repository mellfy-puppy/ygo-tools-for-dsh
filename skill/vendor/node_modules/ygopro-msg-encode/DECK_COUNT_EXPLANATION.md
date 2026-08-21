# STOC_DECK_COUNT 字段说明

## 概述

`STOC_DECK_COUNT` 协议在换边（Side Deck）阶段发送，用于告知客户端双方玩家的卡组数量信息。

## 字段结构

协议包含两个 `YGOProStocDeckCount_DeckInfo` 对象：

### player0DeckCount

- `main` (int16_t) - 玩家 0 的主卡组数量
- `extra` (int16_t) - 玩家 0 的额外卡组数量
- `side` (int16_t) - 玩家 0 的副卡组数量

### player1DeckCount

- `main` (int16_t) - 玩家 1 的主卡组数量
- `extra` (int16_t) - 玩家 1 的额外卡组数量
- `side` (int16_t) - 玩家 1 的副卡组数量

## 二进制布局

| 偏移 | 类型 | 字段 |
|------|------|------|
| 0 | int16_t | player0DeckCount.main |
| 2 | int16_t | player0DeckCount.extra |
| 4 | int16_t | player0DeckCount.side |
| 6 | int16_t | player1DeckCount.main |
| 8 | int16_t | player1DeckCount.extra |
| 10 | int16_t | player1DeckCount.side |

## 源码参考

### 服务器端发送 (single_duel.cpp:485-490)

```cpp
BufferIO::Write<uint16_t>(pbuf, (short)pdeck[0].main.size());
BufferIO::Write<uint16_t>(pbuf, (short)pdeck[0].extra.size());
BufferIO::Write<uint16_t>(pbuf, (short)pdeck[0].side.size());
BufferIO::Write<uint16_t>(pbuf, (short)pdeck[1].main.size());
BufferIO::Write<uint16_t>(pbuf, (short)pdeck[1].extra.size());
BufferIO::Write<uint16_t>(pbuf, (short)pdeck[1].side.size());
```

### 客户端接收 (duelclient.cpp:541-548)

```cpp
int deckc = BufferIO::Read<uint16_t>(pdata);
int extrac = BufferIO::Read<uint16_t>(pdata);
int sidec = BufferIO::Read<uint16_t>(pdata);
mainGame->dField.Initial(0, deckc, extrac, sidec);
deckc = BufferIO::Read<uint16_t>(pdata);
extrac = BufferIO::Read<uint16_t>(pdata);
sidec = BufferIO::Read<uint16_t>(pdata);
mainGame->dField.Initial(1, deckc, extrac, sidec);
```

## 使用示例

### 读取卡组数量

```typescript
import { YGOProStocDeckCount } from 'ygopro-msg-encode';

const deckCount = new YGOProStocDeckCount();
deckCount.fromFullPayload(data);

// 访问玩家 0 的卡组数量
console.log(`Player 0: Main=${deckCount.player0DeckCount.main}, Extra=${deckCount.player0DeckCount.extra}, Side=${deckCount.player0DeckCount.side}`);

// 访问玩家 1 的卡组数量
console.log(`Player 1: Main=${deckCount.player1DeckCount.main}, Extra=${deckCount.player1DeckCount.extra}, Side=${deckCount.player1DeckCount.side}`);

// 简洁写法
const { main, extra, side } = deckCount.player0DeckCount;
console.log(`Your deck: ${main}+${extra}+${side}`);
```

### 设置卡组数量

```typescript
import { YGOProStocDeckCount, YGOProStocDeckCount_DeckInfo } from 'ygopro-msg-encode';

const deckCount = new YGOProStocDeckCount();

// 初始化对象
deckCount.player0DeckCount = new YGOProStocDeckCount_DeckInfo();
deckCount.player1DeckCount = new YGOProStocDeckCount_DeckInfo();

// 设置玩家 0 的卡组数量
deckCount.player0DeckCount.main = 40;
deckCount.player0DeckCount.extra = 15;
deckCount.player0DeckCount.side = 15;

// 设置玩家 1 的卡组数量
deckCount.player1DeckCount.main = 42;
deckCount.player1DeckCount.extra = 14;
deckCount.player1DeckCount.side = 13;

const payload = deckCount.toFullPayload();
```

## 使用场景

这个协议主要在以下场景使用：

1. **换边阶段前**：告知客户端双方当前的卡组配置
2. **匹配赛（Match）中**：在第二局或第三局开始前发送，让玩家知道对手是否更换了副卡组

## 注意事项

1. **对象初始化**：使用前需要创建 `YGOProStocDeckCount_DeckInfo` 实例
2. **数值范围**：每个值都是 `int16_t`（-32768 到 32767），但实际使用时应该是非负整数
3. **玩家索引**：Player 0 通常是先手，Player 1 通常是后手（但需要根据 `MSG_START` 确认）
4. **副卡组融合怪兽**：在某些服务器配置下（`DUEL_FLAG_SIDEINS`），副卡组中的融合/同调/超量/连接怪兽会被计入额外卡组数量
5. **类型安全**：使用对象属性访问提供更好的类型检查和 IDE 自动补全

## 相关协议

- `STOC_CHANGE_SIDE` (0x07) - 通知客户端进入换边阶段
- `STOC_WAITING_SIDE` (0x08) - 等待对手换边
- `CTOS_UPDATE_DECK` (0x02) - 客户端发送更新后的卡组
