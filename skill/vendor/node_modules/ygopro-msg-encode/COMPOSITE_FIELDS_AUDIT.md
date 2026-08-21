# 复合字段审计报告

本文档记录了对所有 CTOS、STOC、MSG 协议的复合字段（使用位运算的字段）审计结果。

## 审计范围

- **CTOS 协议**: 19 个
- **STOC 协议**: 24 个
- **MSG 协议**: 100+ 个

## 审计方法

1. 检查 `/home/nanahira/ygo/ygopro/gframe/network.h` 中的协议定义
2. 检查 `/home/nanahira/ygo/ygopro/gframe/duelclient.cpp` 中的解析代码
3. 检查 `/home/nanahira/ygo/ygopro/ocgcore/playerop.cpp` 中的 MSG 协议
4. 搜索位运算操作符：`<<`, `>>`, `& 0xf`, `& 0x0f`, `& 0xf0`

---

## 发现的复合字段

### 1. STOC_TypeChange.type ✅ 已添加 getter/setter

**结构**: `uint8_t`

**位运算**:
- 低 4 位 (0x0F): 玩家位置 (0-7)
- 高 4 位 (0xF0): 房主标志 (0x10 = 房主)

**源码**: `duelclient.cpp:645-646`
```cpp
selftype = pkt->type & 0xf;
is_host = ((pkt->type >> 4) & 0xf) != 0;
```

**实现**:
- ✅ `get/set playerPosition`: 低 4 位
- ✅ `get/set isHost`: 高 4 位 (boolean)

---

### 2. STOC_HS_PlayerChange.status ✅ 已添加 getter/setter

**结构**: `uint8_t`

**位运算**:
- 低 4 位 (0x0F): 玩家状态 (PlayerChangeState 或位置 0-7)
- 高 4 位 (0xF0): 玩家位置 (0-3)

**源码**: `duelclient.cpp:991-992`
```cpp
unsigned char pos = (pkt->status >> 4) & 0xf;
unsigned char state = pkt->status & 0xf;
```

**实现**:
- ✅ `get/set playerPosition`: 高 4 位
- ✅ `get/set playerState`: 低 4 位

---

### 3. MSG_START.playerType ✅ 已添加 getter/setter

**结构**: `uint8_t`

**位运算**:
- 低 4 位 (0x0F): 玩家编号 (0-3)
- 高 4 位 (0xF0): 观战者标志 (0x10 = 观战者)

**源码**: `duelclient.cpp:1429-1432`
```cpp
int playertype = BufferIO::Read<uint8_t>(pbuf);
mainGame->dInfo.isFirst = (playertype & 0xf) ? false : true;
if(playertype & 0xf0)
    mainGame->dInfo.player_type = 7;  // Observer
```

**实现**:
- ✅ `get/set playerNumber`: 低 4 位
- ✅ `get/set observerFlag`: 高 4 位

---

## 不是复合字段的情况

### STOC_ErrorMsg.code (条件复合)

**注意**: 这个字段**不是**固定的复合字段，只在特定条件下使用位运算。

当 `msg == DECKERROR` 时：
- 高 4 位 (28-31): 卡组错误类型 (DeckErrorType)
- 低 28 位 (0-27): 卡片 ID

**源码**: `single_duel.cpp:358`
```cpp
scem.code = deckerror;  // deckerror = (deckError << 28) | cardId
```

**为什么不添加 getter/setter**:
- 这是条件性的，不是该字段的固定含义
- 在其他 `msg` 值下，`code` 有不同的含义
- 用户需要根据 `msg` 字段自己解析

---

### get_info_location() 返回值

**不是协议字段**: `get_info_location()` 是 C++ 函数返回的**临时值**，不是协议定义的一部分。

**位运算** (card.cpp:444):
```cpp
return c | (l << 8) | (s << 16) | (ss << 24);
```

**在 TypeScript 中**: 这些信息被拆分为独立字段，不需要位运算：
```typescript
@BinaryField('u8', 0) controller: number;
@BinaryField('u8', 1) location: number;
@BinaryField('u8', 2) sequence: number;
@BinaryField('u8', 3) position: number;
```

---

### MSG 协议中的临时变量

**不是协议字段**: MSG 协议中很多位运算用于解析**客户端响应**，不是协议定义本身。

**例子** (playerop.cpp:70-71):
```cpp
int32_t t = (uint32_t)returns.ivalue[0] & 0xffff;
int32_t s = (uint32_t)returns.ivalue[0] >> 16;
```

这是服务器端对客户端响应的解析，不是发送给客户端的协议字段。

---

## CTOS 协议审计结果

检查了所有 19 个 CTOS 协议：

- ✅ CTOS_PlayerInfo - 无复合字段
- ✅ CTOS_CreateGame - 无复合字段
- ✅ CTOS_JoinGame - 无复合字段
- ✅ CTOS_LeaveGame - 无数据
- ✅ CTOS_Kick - 无复合字段（简单 enum）
- ✅ CTOS_HandResult - 无复合字段（简单 enum）
- ✅ CTOS_TPResult - 无复合字段（简单 enum）
- ✅ CTOS_UpdateDeck - 无复合字段
- ✅ CTOS_Response - 无复合字段
- ✅ CTOS_Surrender - 无数据
- ✅ CTOS_Chat - 无复合字段
- ✅ CTOS_HS_ToObserver - 无数据
- ✅ CTOS_HS_ToDuelist - 无数据
- ✅ CTOS_HS_Ready - 无数据
- ✅ CTOS_HS_NotReady - 无数据
- ✅ CTOS_HS_Start - 无数据
- ✅ CTOS_TimeConfirm - 无数据
- ✅ CTOS_RequestField - 无数据
- ✅ CTOS_ExternalAddress - 无复合字段

**结论**: CTOS 协议中**没有**复合字段。

---

## STOC 协议审计结果

检查了所有 24 个 STOC 协议：

- ✅ STOC_GameMsg - 无复合字段（封装 MSG）
- ✅ STOC_ErrorMsg - code 是条件复合（见上文）
- ✅ STOC_SelectHand - 无数据
- ✅ STOC_SelectTP - 无数据
- ✅ STOC_HandResult - 无复合字段
- ✅ STOC_TPResult - 无复合字段
- ✅ STOC_ChangeSide - 无数据
- ✅ STOC_WaitingSide - 无数据
- ✅ STOC_DeckCount - 结构化对象（已改进）
- ✅ STOC_CreateGame - 无数据
- ✅ STOC_JoinGame - 无复合字段
- ✅ **STOC_TypeChange** - ✅ 已添加 getter/setter
- ✅ STOC_LeaveGame - 无复合字段
- ✅ STOC_DuelStart - 无数据
- ✅ STOC_DuelEnd - 无数据
- ✅ STOC_Replay - 无复合字段
- ✅ STOC_TimeLimit - 无复合字段
- ✅ STOC_Chat - 无复合字段（player_type 是条件性的）
- ✅ STOC_HS_PlayerEnter - 无复合字段
- ✅ **STOC_HS_PlayerChange** - ✅ 已添加 getter/setter
- ✅ STOC_HS_WatchChange - 无复合字段
- ✅ STOC_TeammateSurrender - 无数据
- ✅ STOC_FieldFinish - 无数据
- ✅ STOC_SRVPRO_ROOMLIST - 无复合字段

**结论**: STOC 协议中有 **2 个复合字段**，已全部添加 getter/setter。

---

## MSG 协议审计结果

检查了所有需要客户端响应的 MSG 协议（18 个）和其他主要 MSG 协议：

- ✅ **MSG_START** - ✅ 已添加 getter/setter (playerType)
- ✅ MSG_SELECT_BATTLECMD - 无复合字段
- ✅ MSG_SELECT_IDLECMD - 无复合字段
- ✅ MSG_SELECT_EFFECTYN - 无复合字段
- ✅ MSG_SELECT_YESNO - 无复合字段
- ✅ MSG_SELECT_OPTION - 无复合字段
- ✅ MSG_SELECT_CARD - 无复合字段
- ✅ MSG_SELECT_CHAIN - 无复合字段
- ✅ MSG_SELECT_PLACE - 无复合字段
- ✅ MSG_SELECT_POSITION - 无复合字段
- ✅ MSG_SELECT_TRIBUTE - 无复合字段
- ✅ MSG_SELECT_COUNTER - 无复合字段
- ✅ MSG_SELECT_SUM - 无复合字段
- ✅ MSG_SELECT_DISFIELD - 无复合字段
- ✅ MSG_SORT_CARD - 无复合字段
- ✅ MSG_ANNOUNCE_RACE - 无复合字段
- ✅ MSG_ANNOUNCE_ATTRIB - 无复合字段
- ✅ MSG_ANNOUNCE_CARD - 无复合字段
- ✅ MSG_ANNOUNCE_NUMBER - 无复合字段
- ✅ 其他 MSG (80+) - 无复合字段（信息显示类消息）

**注意**: MSG 协议中的位运算主要用于：
1. 临时变量解析（如 `returns.ivalue[0]` 的拆分）
2. C++ 函数返回值（如 `get_info_location()`）
3. 这些不是协议字段定义本身

**结论**: MSG 协议中只有 **1 个复合字段** (MSG_START.playerType)，已添加 getter/setter。

---

## 总结

### 复合字段统计

- **CTOS**: 0 个复合字段
- **STOC**: 2 个复合字段（已全部添加 getter/setter）
- **MSG**: 1 个复合字段（已添加 getter/setter）
- **总计**: 3 个复合字段，✅ 已全部添加 getter/setter

### 实现的 getter/setter

1. ✅ `YGOProStocTypeChange`
   - `playerPosition` (get/set)
   - `isHost` (get/set)

2. ✅ `YGOProStocHsPlayerChange`
   - `playerPosition` (get/set)
   - `playerState` (get/set)

3. ✅ `YGOProMsgStart`
   - `playerNumber` (get/set)
   - `observerFlag` (get/set)

### 测试结果

- ✅ 所有 101 个测试通过
- ✅ 构建成功
- ✅ 类型检查通过

---

## 审计完成日期

2026-02-02

## 参考源码

- `/home/nanahira/ygo/ygopro/gframe/network.h` - 协议定义
- `/home/nanahira/ygo/ygopro/gframe/duelclient.cpp` - 客户端解析
- `/home/nanahira/ygo/ygopro/gframe/single_duel.cpp` - 服务器端发送
- `/home/nanahira/ygo/ygopro/gframe/tag_duel.cpp` - 服务器端发送
- `/home/nanahira/ygo/ygopro/ocgcore/playerop.cpp` - MSG 协议定义
