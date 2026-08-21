# CTOS/STOC 协议实现总结

本文档总结了 CTOS（Client to Server）和 STOC（Server to Client）协议的实现。

## 协议格式

CTOS 和 STOC 协议的二进制格式为：
```
[length 2 bytes][identifier 1 byte][body]
```

- `length`: 2 字节小端序，表示 identifier + body 的总长度
- `identifier`: 1 字节，协议类型标识符
- `body`: 正文内容（可变长度）

## 实现架构

### 基础类

#### `YGOProCtosBase` (`src/protos/ctos/base.ts`)
- 继承自 `PayloadBase`
- 只处理正文（body）部分
- 不包含 header 处理逻辑

#### `YGOProStocBase` (`src/protos/stoc/base.ts`)
- 继承自 `PayloadBase`
- 只处理正文（body）部分
- 不包含 header 处理逻辑

### 注册器

#### `YGOProCtos` (`src/protos/ctos/registry.ts`)
```typescript
export const YGOProCtos = new RegistryBase(YGOProCtosBase, {
  identifierOffset: 2,  // identifier 在字节 2
  dataOffset: 3,        // body 从字节 3 开始
});
```

#### `YGOProStoc` (`src/protos/stoc/registry.ts`)
```typescript
export const YGOProStoc = new RegistryBase(YGOProStocBase, {
  identifierOffset: 2,  // identifier 在字节 2
  dataOffset: 3,        // body 从字节 3 开始
});
```

### 公共数据结构

#### `HostInfo` (`src/protos/common/host-info.ts`)
用于多个协议的房间信息结构（20 字节）：
- `lflist`: uint32_t
- `rule`: uint8_t
- `mode`: uint8_t
- `duel_rule`: uint8_t
- `no_check_deck`: uint8_t
- `no_shuffle_deck`: uint8_t
- 3 字节 padding
- `start_lp`: int32_t
- `start_hand`: uint8_t
- `draw_count`: uint8_t
- `time_limit`: uint16_t

## CTOS 协议实现

实现了以下 CTOS 协议（共 19 个）：

| 标识符 | 类名 | 说明 |
|--------|------|------|
| 0x01 | `YGOProCtosResponse` | 响应数据（字节数组） |
| 0x02 | `YGOProCtosUpdateDeck` | 更新卡组（使用 ygopro-deck-encode） |
| 0x03 | `YGOProCtosHandResult` | 猜拳结果 |
| 0x04 | `YGOProCtosTpResult` | 先后手选择结果 |
| 0x10 | `YGOProCtosPlayerInfo` | 玩家信息（名字） |
| 0x11 | `YGOProCtosCreateGame` | 创建房间 |
| 0x12 | `YGOProCtosJoinGame` | 加入房间 |
| 0x13 | `YGOProCtosLeaveGame` | 离开房间（无数据） |
| 0x14 | `YGOProCtosSurrender` | 认输（无数据） |
| 0x15 | `YGOProCtosTimeConfirm` | 时间确认（无数据） |
| 0x16 | `YGOProCtosChat` | 聊天消息 |
| 0x17 | `YGOProCtosExternalAddress` | 外部地址 |
| 0x20 | `YGOProCtosHsToDuelist` | 切换到决斗者（无数据） |
| 0x21 | `YGOProCtosHsToObserver` | 切换到观战者（无数据） |
| 0x22 | `YGOProCtosHsReady` | 准备（无数据） |
| 0x23 | `YGOProCtosHsNotReady` | 取消准备（无数据） |
| 0x24 | `YGOProCtosKick` | 踢人 |
| 0x25 | `YGOProCtosHsStart` | 开始决斗（无数据） |
| 0x30 | `YGOProCtosRequestField` | 请求场地信息（无数据） |

### 特殊实现

#### `YGOProCtosUpdateDeck` (0x02)
- 使用 `ygopro-deck-encode` 库的 `YGOProDeck` 类
- `fromUpdateDeckPayload()` 和 `toUpdateDeckPayload()` 方法
- 成员：`deck: YGOProDeck`

#### `YGOProCtosResponse` (0x01)
- 直接存储原始字节数组
- 用于游戏响应数据

## STOC 协议实现

实现了以下 STOC 协议（共 24 个）：

| 标识符 | 类名 | 说明 |
|--------|------|------|
| 0x01 | `YGOProStocGameMsg` | 游戏消息（使用 YGOProMessages） |
| 0x02 | `YGOProStocErrorMsg` | 错误消息 |
| 0x03 | `YGOProStocSelectHand` | 选择猜拳（无数据） |
| 0x04 | `YGOProStocSelectTp` | 选择先后手（无数据） |
| 0x05 | `YGOProStocHandResult` | 猜拳结果 |
| 0x06 | `YGOProStocTpResult` | 先后手结果（保留） |
| 0x07 | `YGOProStocChangeSide` | 换边（无数据） |
| 0x08 | `YGOProStocWaitingSide` | 等待换边（无数据） |
| 0x09 | `YGOProStocDeckCount` | 卡组数量 |
| 0x11 | `YGOProStocCreateGame` | 创建房间（保留） |
| 0x12 | `YGOProStocJoinGame` | 加入房间 |
| 0x13 | `YGOProStocTypeChange` | 类型变更 |
| 0x14 | `YGOProStocLeaveGame` | 离开房间（保留） |
| 0x15 | `YGOProStocDuelStart` | 决斗开始（无数据） |
| 0x16 | `YGOProStocDuelEnd` | 决斗结束（无数据） |
| 0x17 | `YGOProStocReplay` | 录像（使用 ygopro-yrp-encode） |
| 0x18 | `YGOProStocTimeLimit` | 时间限制 |
| 0x19 | `YGOProStocChat` | 聊天消息 |
| 0x20 | `YGOProStocHsPlayerEnter` | 玩家进入 |
| 0x21 | `YGOProStocHsPlayerChange` | 玩家状态变更 |
| 0x22 | `YGOProStocHsWatchChange` | 观战者数量变更 |
| 0x23 | `YGOProStocTeammateSurrender` | 队友认输（无数据） |
| 0x30 | `YGOProStocFieldFinish` | 场地同步完成（无数据） |
| 0x31 | `YGOProStocSrvproRoomlist` | 房间列表（SRVPro 服务器） |

### 特殊实现

#### `YGOProStocSrvproRoomlist` (0x31)
- SRVPro 服务器特定协议，用于返回房间列表
- 结构：
  ```typescript
  export class SrvproRoomInfo {
    roomname: string;          // UTF-8, 64 bytes
    room_status: number;       // uint8_t (0=Waiting, 1=Dueling, 2=Siding)
    room_duel_count: number;   // int8_t
    room_turn_count: number;   // int8_t
    player1: string;           // UTF-8, 128 bytes
    player1_score: number;     // int8_t
    player1_lp: number;        // int32_t
    player2: string;           // UTF-8, 128 bytes
    player2_score: number;     // int8_t
    player2_lp: number;        // int32_t
  }
  
  export class YGOProStocSrvproRoomlist {
    count: number;             // uint16_t
    rooms: SrvproRoomInfo[];   // 房间数组
  }
  ```
- 每个房间信息大小：333 字节（64 + 1 + 1 + 1 + 128 + 1 + 4 + 128 + 1 + 4）

#### `YGOProStocGameMsg` (0x01)
- 使用 `YGOProMessages` registry 解析 MSG 协议
- 成员：`msg: YGOProMsgBase | undefined`
- 自动解析和序列化 MSG 协议消息

#### `YGOProStocReplay` (0x17)
- 使用 `ygopro-yrp-encode` 库的 `YGOProYrp` 类
- `fromYrp()` 和 `toYrp()` 方法
- 成员：`replay: YGOProYrp`

## 使用示例

### CTOS 协议使用

```typescript
import { YGOProCtos, YGOProCtosPlayerInfo } from 'ygopro-msg-encode';

// 创建协议对象
const playerInfo = new YGOProCtosPlayerInfo();
playerInfo.name = [0x0041, 0x0042, ...]; // UTF-16 字符数组

// 序列化
const payload = playerInfo.toPayload();

// 解析
const parsed = YGOProCtos.getInstanceFromPayload(payload);
```

### STOC 协议使用

```typescript
import { YGOProStoc, YGOProStocGameMsg, YGOProMsgHint } from 'ygopro-msg-encode';

// 创建游戏消息
const gameMsg = new YGOProStocGameMsg();
const hint = new YGOProMsgHint();
hint.type = 1;
hint.player = 0;
hint.desc = 0x1234;
gameMsg.msg = hint;

// 序列化
const payload = gameMsg.toPayload();

// 解析
const parsed = YGOProStoc.getInstanceFromPayload(payload);
```

### UpdateDeck 使用

```typescript
import { YGOProCtosUpdateDeck } from 'ygopro-msg-encode';
import YGOProDeck from 'ygopro-deck-encode';

// 创建
const updateDeck = new YGOProCtosUpdateDeck();
updateDeck.deck = new YGOProDeck({
  main: [12345, 67890],
  extra: [11111],
  side: [22222],
});

// 序列化
const payload = updateDeck.toPayload();

// 解析
const parsed = new YGOProCtosUpdateDeck().fromPayload(payload.slice(3)); // 去掉 header
```

### Replay 使用

```typescript
import { YGOProStocReplay } from 'ygopro-msg-encode';
import { YGOProYrp } from 'ygopro-yrp-encode';

// 创建
const replay = new YGOProStocReplay();
replay.replay = new YGOProYrp({
  hostName: 'Player1',
  clientName: 'Player2',
  // ... 其他字段
});

// 序列化
const payload = replay.toPayload();
```

## 注意事项

### Struct Padding
C++ 结构体的 padding 已经在各个类中正确处理：
- `HostInfo`: 字节 9-11 是 padding
- `CTOS_JoinGame`: 字节 2-3 是 padding
- `STOC_ErrorMsg`: 字节 1-3 是 padding
- `STOC_TimeLimit`: 字节 1 是 padding
- `STOC_HS_PlayerEnter`: 实际大小 41 字节（有 workaround）

### 数组字段
- 固定长度数组使用 `@BinaryField('u16', offset, length)`
- UTF-16 字符串使用 `@BinaryField('utf16', offset, length)`
- 不使用 `u16[]` 这种写法

### 无数据协议
多个协议（如 `LEAVE_GAME`, `SURRENDER` 等）没有正文数据，只有 header。

## 依赖库

- `ygopro-deck-encode`: 卡组编解码
- `ygopro-yrp-encode`: 录像编解码

## 测试

运行测试脚本：
```bash
npm run build
node dist/test-ctos-stoc.cjs
```

或直接使用 TypeScript：
```bash
npx tsx test-ctos-stoc.ts
```
