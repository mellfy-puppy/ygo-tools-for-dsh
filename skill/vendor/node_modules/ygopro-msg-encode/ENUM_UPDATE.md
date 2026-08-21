# 枚举类型更新总结

本文档记录了将网络协议中的数字字段改为 TypeScript 枚举的更新。

## 更新原则

1. **仅更新网络协议相关的枚举**：CTOS 和 STOC 协议中的语义字段
2. **不修改已有常量**：MSG 协议中的字段（如 `phase`、`position`、`location`、`reason`）已在 `OcgcoreCommonConstants` 中定义，保持使用常量
3. **使用 TypeScript enum**：提供类型安全和更好的 IDE 支持

## 新增枚举类型

所有枚举定义在 `src/protos/network-enums.ts`：

### 1. HandResult - 猜拳结果
```typescript
enum HandResult {
  ROCK = 1,
  SCISSORS = 2,
  PAPER = 3,
}
```
**使用位置**：`CTOS_HandResult.res`

### 2. TurnPlayerResult - 先后手选择
```typescript
enum TurnPlayerResult {
  SECOND = 0,
  FIRST = 1,
}
```
**使用位置**：`CTOS_TPResult.res`

### 3. NetPlayerType - 玩家类型/位置
```typescript
enum NetPlayerType {
  PLAYER1 = 0,
  PLAYER2 = 1,
  PLAYER3 = 2,
  PLAYER4 = 3,
  PLAYER5 = 4,
  PLAYER6 = 5,
  OBSERVER = 7,
}
```
**使用位置**：
- `CTOS_Kick.pos`

### 4. ChatColor - 聊天消息颜色
```typescript
enum ChatColor {
  LIGHTBLUE = 8,
  RED = 11,
  GREEN = 12,
  BLUE = 13,
  BABYBLUE = 14,
  PINK = 15,
  YELLOW = 16,
  WHITE = 17,
  GRAY = 18,
  DARKGRAY = 19,
}
```
**说明**：用于 `STOC_Chat.player_type` 字段，但该字段保持为 `number` 类型，因为它可以是玩家类型（0-7）或聊天颜色（8-19）

### 5. GameMode - 游戏模式
```typescript
enum GameMode {
  SINGLE = 0,
  MATCH = 1,
  TAG = 2,
}
```
**使用位置**：`HostInfo.mode`

### 6. ErrorMessageType - 错误消息类型
```typescript
enum ErrorMessageType {
  JOINERROR = 1,
  DECKERROR = 2,
  SIDEERROR = 3,
  VERERROR = 4,
}
```
**使用位置**：`STOC_ErrorMsg.msg`

### 7. DeckErrorType - 卡组错误类型
```typescript
enum DeckErrorType {
  LFLIST = 1,
  OCGONLY = 2,
  TCGONLY = 3,
  UNKNOWNCARD = 4,
  CARDCOUNT = 5,
  MAINCOUNT = 6,
  EXTRACOUNT = 7,
  SIDECOUNT = 8,
  NOTAVAIL = 9,
}
```
**说明**：用于解析 `STOC_ErrorMsg.code` 的高 4 位（当 `msg == DECKERROR` 时）

### 8. PlayerChangeState - 玩家状态变化
```typescript
enum PlayerChangeState {
  OBSERVE = 8,
  READY = 9,
  NOTREADY = 10,
  LEAVE = 11,
}
```
**说明**：用于解析 `STOC_HS_PlayerChange.status` 的低 4 位

### 9. RoomStatus - 房间状态（SRVPro）
```typescript
enum RoomStatus {
  WAITING = 0,
  DUELING = 1,
  SIDING = 2,
}
```
**使用位置**：`STOC_SRVPRO_ROOMLIST.room_status`

## 已更新的文件

### CTOS 协议
1. `src/protos/ctos/proto/hand-result.ts` - `res: HandResult`
2. `src/protos/ctos/proto/tp-result.ts` - `res: TurnPlayerResult`
3. `src/protos/ctos/proto/kick.ts` - `pos: NetPlayerType`

### STOC 协议
1. `src/protos/stoc/proto/error-msg.ts` - `msg: ErrorMessageType`
2. `src/protos/stoc/proto/chat.ts` - `player_type: number` (可以是 NetPlayerType 0-7 或 ChatColor 8-19)
3. `src/protos/stoc/proto/srvpro-roomlist.ts` - `room_status: RoomStatus`

### 公共结构
1. `src/protos/common/host-info.ts` - `mode: GameMode`

**注意**：`HostInfo.rule` 保持为 `number` 类型，因为它是UI下拉列表的索引（0-5），而不是实际的OT值。

### 主入口
1. `index.ts` - 导出所有枚举类型

## 未更改的字段

以下字段已在 `OcgcoreCommonConstants` 中有常量定义，因此**不改为枚举**：

### MSG 协议字段
- `MSG_HINT.type` - 使用 `HINT_*` 常量
- `MSG_CARD_HINT.type` - 使用 `HINT_*` 常量
- `MSG_PLAYER_HINT.type` - 使用 `PHINT_*` 常量
- `MSG_NEW_PHASE.phase` - 使用 `PHASE_*` 常量
- `MSG_MOVE.reason` - 使用 `REASON_*` 常量
- `MSG_POS_CHANGE.position` - 使用 `POS_*` 常量
- `MSG_SELECT_POSITION.positions` - 使用 `POS_*` 常量
- 所有包含 `location` 的字段 - 使用 `LOCATION_*` 常量（注：部分基础常量可能在 vendor 生成脚本中缺失）

### HostInfo 字段
- `HostInfo.duel_rule` - 使用 `MASTER_RULE3`, `NEW_MASTER_RULE`, `MASTER_RULE_2020` 等常量

## 使用示例

```typescript
import { 
  YGOProCtosHandResult, 
  HandResult,
  YGOProCtosCreateGame,
  GameMode,
  NetPlayerType,
  YGOProCtosKick,
} from 'ygopro-msg-encode';

// 创建猜拳消息
const handResult = new YGOProCtosHandResult();
handResult.res = HandResult.ROCK;

// 创建游戏
const createGame = new YGOProCtosCreateGame();
createGame.info.mode = GameMode.MATCH;
createGame.info.rule = 0; // Rule index (0-5), maps to OT values in UI
createGame.info.duel_rule = 5; // MASTER_RULE_2020 (from OcgcoreCommonConstants)

// 踢出玩家
const kick = new YGOProCtosKick();
kick.pos = NetPlayerType.PLAYER2;
```

## 向后兼容性

由于 TypeScript enum 在运行时就是 `number`，这些改动是**完全向后兼容**的：

```typescript
// 旧代码仍然可以工作
handResult.res = 1; // OK

// 但现在有类型检查和 IDE 自动补全
handResult.res = HandResult.ROCK; // Better!
handResult.res = 99; // TypeScript 会警告（如果启用严格模式）
```

## 类型安全改进

```typescript
// 之前：没有类型检查
function handleHandResult(res: number) {
  if (res === 1) { /* ... */ }
}

// 现在：类型安全
function handleHandResult(res: HandResult) {
  if (res === HandResult.ROCK) { /* ... */ }
}

// IDE 会提供自动补全和类型检查
```

## 测试

所有现有测试均通过，枚举更改不影响二进制序列化/反序列化逻辑。
