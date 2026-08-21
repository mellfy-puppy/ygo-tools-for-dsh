# GameRule 枚举修正总结

## 问题

之前错误地为 `HostInfo.rule` 字段创建了 `GameRule` 枚举，但实际上：

1. **`rule` 字段是 UI 下拉列表的索引**（0-5），不是实际的 OT 值
2. **实际的 OT 值**（1=OCG, 2=TCG, 4=OCG+TCG, 8=Traditional）是从 UI 索引映射过来的
3. **在协议中传输的是索引值**，而不是 OT 值本身

## 修正

### 1. 删除了 `GameRule` 枚举 ✅

从 `src/protos/network-enums.ts` 中删除：
```typescript
// 已删除
export enum GameRule {
  OCG_ONLY = 1,
  TCG_ONLY = 2,
  OCG_TCG = 4,
  TRADITIONAL = 8,
}
```

### 2. 将 `HostInfo.rule` 改回 `number` ✅

```typescript
export class HostInfo {
  @BinaryField('u32', 0)
  lflist: number;

  @BinaryField('u8', 4)
  rule: number; // Rule index (0-5), maps to OT values in UI

  @BinaryField('u8', 5)
  mode: GameMode;
  
  // ...
}
```

### 3. 更新了文档 ✅

- `README.md` - 移除了 `GameRule` 的引用
- `ENUM_UPDATE.md` - 添加了 `HostInfo.rule` 保持为 `number` 的说明

## UI 索引到 OT 值的映射（参考）

从 `gframe/game.cpp` 中可以看到映射关系：

| UI 索引 | OT 值 | 说明 |
|---------|-------|------|
| 0 | 1 | OCG Only (String 1483) |
| 1 | 2 | TCG Only (String 1484) |
| 2 | 8 | Traditional (String 1485) |
| 3 | 4 | OCG + TCG (String 1486) |
| 4+ | ? | 其他规则 |

**注意**：协议中传输的是索引（0-5），不是 OT 值（1, 2, 4, 8）。

## 保留的枚举

以下枚举保持不变：

1. `HandResult` - 猜拳结果
2. `TurnPlayerResult` - 先后手选择
3. `NetPlayerType` - 玩家类型/位置
4. `GameMode` - 游戏模式
5. `ErrorMessageType` - 错误消息类型
6. `DeckErrorType` - 卡组错误类型
7. `PlayerChangeState` - 玩家状态变化
8. `RoomStatus` - 房间状态

## 使用示例

```typescript
import { YGOProCtosCreateGame, GameMode } from 'ygopro-msg-encode';

const createGame = new YGOProCtosCreateGame();
createGame.info.mode = GameMode.MATCH;
createGame.info.rule = 0; // UI 索引 0 (会映射到 OT=1, OCG Only)
createGame.info.duel_rule = 5; // MASTER_RULE_2020
```
