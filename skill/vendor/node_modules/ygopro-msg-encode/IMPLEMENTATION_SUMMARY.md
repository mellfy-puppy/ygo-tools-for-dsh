# CTOS/STOC 协议实现完成总结

## 完成内容

### 1. 模块结构

按照 MSG 协议的模式，为 CTOS 和 STOC 建立了完整的模块结构：

```
src/protos/
├── common/                    # 公共数据结构
│   ├── host-info.ts          # HostInfo 结构（20字节）
│   └── index.ts
├── ctos/                      # Client to Server 协议
│   ├── base.ts               # CTOS 基类
│   ├── registry.ts           # CTOS 注册器
│   ├── index.ts
│   └── proto/                # 19 个 CTOS 协议实现
│       ├── response.ts
│       ├── update-deck.ts
│       ├── hand-result.ts
│       └── ... (共19个文件)
└── stoc/                      # Server to Client 协议
    ├── base.ts               # STOC 基类
    ├── registry.ts           # STOC 注册器
    ├── index.ts
    └── proto/                # 24 个 STOC 协议实现
        ├── game-msg.ts
        ├── error-msg.ts
        ├── replay.ts
        └── ... (共24个文件)
```

### 2. 协议格式处理

正确实现了 CTOS/STOC 的二进制格式：
- `[length 2 bytes][identifier 1 byte][body]`
- Base 类只处理 body 部分
- Registry 配置正确的 `identifierOffset: 2` 和 `dataOffset: 3`

### 3. Struct Padding 处理

正确处理了所有 C++ 结构体的 padding：
- `HostInfo`: 字节 9-11 padding（共 20 字节）
- `CTOS_JoinGame`: 字节 2-3 padding
- `STOC_ErrorMsg`: 字节 1-3 padding
- `STOC_TimeLimit`: 字节 1 padding
- `STOC_HS_PlayerEnter`: 实际 41 字节（workaround）

### 4. 特殊协议封装

#### CTOS_UPDATE_DECK (0x02)
```typescript
export class YGOProCtosUpdateDeck extends YGOProCtosBase {
  static identifier = 0x2;
  deck: YGOProDeck;
  
  fromPayload(data: Uint8Array): this {
    this.deck = YGOProDeck.fromUpdateDeckPayload(data);
    return this;
  }
  
  toPayload(): Uint8Array {
    return this.deck.toUpdateDeckPayload();
  }
  
  fromPartial(data: Partial<this>): this {
    if (data.deck) {
      this.deck = new YGOProDeck(data.deck);
    }
    return this;
  }
  
  copy(): this {
    const copied = new (this.constructor as any)();
    copied.deck = new YGOProDeck(this.deck);
    return copied;
  }
}
```

#### STOC_REPLAY (0x17)
```typescript
export class YGOProStocReplay extends YGOProStocBase {
  static identifier = 0x17;
  replay: YGOProYrp;
  
  fromPayload(data: Uint8Array): this {
    this.replay = new YGOProYrp().fromYrp(data);
    return this;
  }
  
  toPayload(): Uint8Array {
    return this.replay.toYrp();
  }
  
  fromPartial(data: Partial<this>): this {
    if (data.replay) {
      this.replay = new YGOProYrp(data.replay);
    }
    return this;
  }
  
  copy(): this {
    const copied = new (this.constructor as any)();
    copied.replay = new YGOProYrp(this.replay);
    return copied;
  }
}
```

#### STOC_GAME_MSG (0x01)
```typescript
export class YGOProStocGameMsg extends YGOProStocBase {
  static identifier = 0x1;
  msg: YGOProMsgBase | undefined;
  
  fromPayload(data: Uint8Array): this {
    this.msg = YGOProMessages.getInstanceFromPayload(data);
    return this;
  }
  
  toPayload(): Uint8Array {
    if (!this.msg) {
      return new Uint8Array(0);
    }
    return this.msg.toPayload();
  }
  
  fromPartial(data: Partial<this>): this {
    if (data.msg) {
      this.msg = data.msg.copy(); // 使用 copy()
    }
    return this;
  }
}
```

### 5. 数组字段处理

修正了所有数组字段的写法：
- ❌ 错误：`@BinaryField('u16[]', 0, () => 20)`
- ✅ 正确：`@BinaryField('u16', 0, 20)`
- ✅ UTF-16：`@BinaryField('utf16', 0, 256)`

### 6. 实现的协议列表

#### CTOS 协议（19 个）
| ID | 协议名 | 说明 |
|----|--------|------|
| 0x01 | RESPONSE | 响应数据 |
| 0x02 | UPDATE_DECK | 更新卡组（ygopro-deck-encode） |
| 0x03 | HAND_RESULT | 猜拳结果 |
| 0x04 | TP_RESULT | 先后手结果 |
| 0x10 | PLAYER_INFO | 玩家信息 |
| 0x11 | CREATE_GAME | 创建房间 |
| 0x12 | JOIN_GAME | 加入房间 |
| 0x13 | LEAVE_GAME | 离开房间 |
| 0x14 | SURRENDER | 认输 |
| 0x15 | TIME_CONFIRM | 时间确认 |
| 0x16 | CHAT | 聊天 |
| 0x17 | EXTERNAL_ADDRESS | 外部地址 |
| 0x20 | HS_TODUELIST | 切换到决斗者 |
| 0x21 | HS_TOOBSERVER | 切换到观战者 |
| 0x22 | HS_READY | 准备 |
| 0x23 | HS_NOTREADY | 取消准备 |
| 0x24 | HS_KICK | 踢人 |
| 0x25 | HS_START | 开始决斗 |
| 0x30 | REQUEST_FIELD | 请求场地信息 |

#### STOC 协议（24 个）
| ID | 协议名 | 说明 |
|----|--------|------|
| 0x01 | GAME_MSG | 游戏消息（YGOProMessages） |
| 0x02 | ERROR_MSG | 错误消息 |
| 0x03 | SELECT_HAND | 选择猜拳 |
| 0x04 | SELECT_TP | 选择先后手 |
| 0x05 | HAND_RESULT | 猜拳结果 |
| 0x06 | TP_RESULT | 先后手结果 |
| 0x07 | CHANGE_SIDE | 换边 |
| 0x08 | WAITING_SIDE | 等待换边 |
| 0x09 | DECK_COUNT | 卡组数量 |
| 0x11 | CREATE_GAME | 创建房间 |
| 0x12 | JOIN_GAME | 加入房间 |
| 0x13 | TYPE_CHANGE | 类型变更 |
| 0x14 | LEAVE_GAME | 离开房间 |
| 0x15 | DUEL_START | 决斗开始 |
| 0x16 | DUEL_END | 决斗结束 |
| 0x17 | REPLAY | 录像（ygopro-yrp-encode） |
| 0x18 | TIME_LIMIT | 时间限制 |
| 0x19 | CHAT | 聊天 |
| 0x20 | HS_PLAYER_ENTER | 玩家进入 |
| 0x21 | HS_PLAYER_CHANGE | 玩家状态变更 |
| 0x22 | HS_WATCH_CHANGE | 观战者数量变更 |
| 0x23 | TEAMMATE_SURRENDER | 队友认输 |
| 0x30 | FIELD_FINISH | 场地同步完成 |
| 0x31 | SRVPRO_ROOMLIST | 房间列表（SRVPro 服务器） |

### 7. 导出配置

更新了主入口文件 `index.ts`：
```typescript
export * from './src/binary/binary-meta';
export * from './src/binary/fill-binary-fields';
export * from './src/protos/common';
export * from './src/protos/ctos';
export * from './src/protos/stoc';
export * from './src/protos/msg';
```

### 8. 构建结果

```
✓ dist/index.cjs      151.9kb  (之前: 10.8kb)
✓ dist/index.mjs      141.7kb  (之前: 9.7kb)
✓ dist/index.d.ts     类型声明文件已生成
```

## 关键设计决策

### 1. Registry Options
```typescript
{
  identifierOffset: 2,  // identifier 在字节 2（跳过 2 字节长度）
  dataOffset: 3,        // body 从字节 3 开始（跳过长度 + identifier）
}
```

### 2. fromPartial 实现策略
- **YGOProStocGameMsg**: 使用 `msg.copy()` 复制
- **YGOProCtosUpdateDeck**: 使用 `new YGOProDeck(data.deck)` 传入构造函数
- **YGOProStocReplay**: 使用 `new YGOProYrp(data.replay)` 传入构造函数

### 3. copy() 方法
为 `YGOProCtosUpdateDeck` 和 `YGOProStocReplay` 添加了 `copy()` 方法，确保正确的深拷贝。

### 4. STOC_SRVPRO_ROOMLIST 实现
根据 `duelclient.cpp` 实现了 SRVPro 服务器的房间列表协议：
```typescript
export class SrvproRoomInfo {
  roomname: string;          // UTF-8, 64 bytes
  room_status: number;       // 0=Waiting, 1=Dueling, 2=Siding
  room_duel_count: number;   // 决斗计数
  room_turn_count: number;   // 回合计数
  player1: string;           // 玩家1名字, UTF-8, 128 bytes
  player1_score: number;     // 玩家1分数
  player1_lp: number;        // 玩家1 LP
  player2: string;           // 玩家2名字, UTF-8, 128 bytes
  player2_score: number;     // 玩家2分数
  player2_lp: number;        // 玩家2 LP
}

export class YGOProStocSrvproRoomlist {
  count: number;             // 房间数量
  rooms: SrvproRoomInfo[];   // 房间数组
}
```
每个房间信息占 333 字节。

## 参考源码

实现参照了以下源码：
- YGOPro ocgcore: `/home/nanahira/ygo/ygopro/ocgcore`
- YGOPro gframe: `/home/nanahira/ygo/ygopro/gframe`
- 特别是 `network.h` 文件中的结构体定义
- `duelclient.cpp` 中的 `STOC_SRVPRO_ROOMLIST` 实现（第 413-463 行）

## 依赖关系

```
ygopro-msg-encode
├── ygopro-deck-encode  (卡组编解码)
└── ygopro-yrp-encode   (录像编解码)
```

## 测试

已创建测试脚本 `test-ctos-stoc.ts`，可以验证：
- 协议序列化和反序列化
- Registry 正确识别协议类型
- 数据完整性

运行测试：
```bash
npx tsx test-ctos-stoc.ts
```

## 完成时间

2026-02-02

## 状态

✅ **已完成并通过构建测试**
