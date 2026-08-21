# MSG 类重构变更说明

## 主要修改

### 1. 基类修改 - 添加 MSG Identifier

**文件**: `src/protos/msg/base.ts`

修改了 `YGOProMsgBase` 的 `fromPayload` 和 `toPayload` 方法：

- **toPayload()**: 第一个字节写入 MSG identifier
- **fromPayload()**: 
  - 验证第一个字节是否与 identifier 一致
  - 从第二个字节开始解析数据

**手动实现修改**: `src/protos/msg/proto/update-card.ts` 同样进行了修改

### 2. 小类重命名和导出

所有嵌套的小类都已：
- 重命名为 `{主类名}_{小类名}` 格式
- 改为 `export` 导出

#### 修改的文件列表：

**使用 1/2 或对称命名改为小类的文件**（共 9 个）：
- `card-target.ts` - 改用 `YGOProMsgCardTarget_CardLocation` (card1/card2)
- `cancel-target.ts` - 改用 `YGOProMsgCancelTarget_CardLocation` (card1/card2)
- `swap.ts` - 改用 `YGOProMsgSwap_CardLocation` (card1/card2)
- `move.ts` - 改用 `YGOProMsgMove_CardLocation` (previous/current)
- `pos-change.ts` - 改用 `YGOProMsgPosChange_CardLocation` (card + previousPosition/currentPosition)
- `attack.ts` - 改用 `YGOProMsgAttack_CardLocation` (attacker/defender)
- `battle.ts` - 改用 `YGOProMsgBattle_CardLocation` + `YGOProMsgBattle_CardStats` (attacker/defender，嵌套 location + atk/def)
- `equip.ts` - 改用 `YGOProMsgEquip_CardLocation` (equip/target)
- `shuffle-set-card.ts` - 改用 `YGOProMsgShuffleSetCard_CardLocation` + `YGOProMsgShuffleSetCard_SetCardInfo` (oldLocation/newLocation)

**导出小类的文件**：
- `confirm-decktop.ts` → `YGOProMsgConfirmDeckTop_CardInfo`
- `confirm-extratop.ts` → `YGOProMsgConfirmExtraTop_CardInfo`
- `confirm-cards.ts` → `YGOProMsgConfirmCards_CardInfo`
- `select-card.ts` → `YGOProMsgSelectCard_CardInfo`
- `select-tribute.ts` → `YGOProMsgSelectTribute_CardInfo`
- `select-unselect-card.ts` → `YGOProMsgSelectUnselectCard_CardInfo`
- `sort-card.ts` → `YGOProMsgSortCard_CardInfo`
- `select-counter.ts` → `YGOProMsgSelectCounter_CardInfo`
- `select-sum.ts` → `YGOProMsgSelectSum_CardInfo`
- `select-chain.ts` → `YGOProMsgSelectChain_ChainInfo`
- `select-battlecmd.ts` → `YGOProMsgSelectBattleCmd_ActivatableInfo`, `YGOProMsgSelectBattleCmd_AttackableInfo`
- `select-idlecmd.ts` → `YGOProMsgSelectIdleCmd_SimpleCardInfo`, `YGOProMsgSelectIdleCmd_ActivatableInfo`
- `shuffle-set-card.ts` → `YGOProMsgShuffleSetCard_SetCardInfo`

### 3. 字段重构

#### 前（使用 1/2 命名）：
```typescript
export class YGOProMsgCardTarget extends YGOProMsgBase {
  @BinaryField('u8', 0) controller1: number;
  @BinaryField('u8', 1) location1: number;
  @BinaryField('u8', 2) sequence1: number;
  @BinaryField('u8', 3) controller2: number;
  @BinaryField('u8', 4) location2: number;
  @BinaryField('u8', 5) sequence2: number;
}
```

#### 后（使用小类）：
```typescript
export class YGOProMsgCardTarget_CardLocation {
  @BinaryField('u8', 0) controller: number;
  @BinaryField('u8', 1) location: number;
  @BinaryField('u8', 2) sequence: number;
}

export class YGOProMsgCardTarget extends YGOProMsgBase {
  @BinaryField(() => YGOProMsgCardTarget_CardLocation, 0)
  card1: YGOProMsgCardTarget_CardLocation;
  
  @BinaryField(() => YGOProMsgCardTarget_CardLocation, 3)
  card2: YGOProMsgCardTarget_CardLocation;
}
```

### 示例 2: 嵌套小类

#### 前（使用扁平命名）：
```typescript
export class YGOProMsgBattle extends YGOProMsgBase {
  @BinaryField('u8', 0) attackerController: number;
  @BinaryField('u8', 1) attackerLocation: number;
  @BinaryField('u8', 2) attackerSequence: number;
  @BinaryField('u8', 3) attackerPosition: number;
  @BinaryField('i32', 4) attackerAtk: number;
  @BinaryField('i32', 8) attackerDef: number;
  @BinaryField('u8', 12) defenderController: number;
  // ... 类似的 defender 字段
}
```

#### 后（使用嵌套小类）：
```typescript
export class YGOProMsgBattle_CardLocation {
  @BinaryField('u8', 0) controller: number;
  @BinaryField('u8', 1) location: number;
  @BinaryField('u8', 2) sequence: number;
  @BinaryField('u8', 3) position: number;
}

export class YGOProMsgBattle_CardStats {
  @BinaryField(() => YGOProMsgBattle_CardLocation, 0)
  location: YGOProMsgBattle_CardLocation;
  
  @BinaryField('i32', 4) atk: number;
  @BinaryField('i32', 8) def: number;
}

export class YGOProMsgBattle extends YGOProMsgBase {
  @BinaryField(() => YGOProMsgBattle_CardStats, 0)
  attacker: YGOProMsgBattle_CardStats;
  
  @BinaryField(() => YGOProMsgBattle_CardStats, 12)
  defender: YGOProMsgBattle_CardStats;
  
  @BinaryField('u8', 24) battleDamageCalc: number;
}
```

## 二进制格式变化

### 前：
```
[字段数据...]
```

### 后：
```
[MSG_IDENTIFIER (1 byte)][字段数据...]
```

所有 MSG 的序列化数据现在第一个字节都是 MSG identifier，解析时会验证该字节。

## 测试更新

`tests/msg.spec.ts` 已更新以适配新的二进制格式：
- 期望长度增加 1 字节（identifier）
- 验证第一个字节是正确的 MSG identifier
- 添加了 identifier 验证测试

## 向后兼容性

⚠️ **破坏性变更**：由于二进制格式改变，此修改与旧版本不兼容。

## 新增消息类型

### MSG_START (4)
开始决斗的消息，包含：
- playerType: 玩家类型
- duelRule: 决斗规则
- startLp0/startLp1: 双方起始 LP
- player0/player1: 双方卡组和额外卡组数量

### MSG_WAITING (3)
等待消息，无字段

### MSG_UPDATE_CARD (7) - 完整实现 ✅ 视角控制
更新单张卡片信息，现在使用完整的 `CardQuery` 类：
- controller, location, sequence: 卡片位置
- card: CardQuery 对象，包含完整的查询数据
- **opponentView**: 对手视角下，盖放卡片（POS_FACEDOWN）只显示 flags = QUERY_CODE 和 code = 0
- **teammateView**: TAG 决斗中
  - 场上卡片（LOCATION_ONFIELD）：队友可以看到己方盖放的卡片
  - 非场上卡片：和对手视角相同

### MSG_UPDATE_DATA (6) - 完整实现 ✅ 视角控制
更新某个位置所有卡片的信息，现在使用 `CardQuery[]` 数组：
- player, location: 位置信息
- cards: CardQuery 数组，每张卡片的完整查询数据
- **opponentView**: 对手视角下，盖放卡片（POS_FACEDOWN）清除所有查询数据（flags = 0, empty = true）
- **teammateView**: TAG 决斗中，根据位置不同处理
  - MZONE/SZONE：队友可以看到己方盖放的卡片
  - HAND：队友也看不到非公开的手牌（只有当前操作玩家能看到）
  - 其他公开区域（GRAVE 等）：队友可以看到

### MSG_RELOAD_FIELD (162)
重新加载整个场地信息，包含：
- duelRule: 决斗规则
- players[2]: 双方玩家状态（LP、各区域卡片数量和位置）
- chains: 连锁信息数组

## CardQuery 类

新增 `CardQuery` 类，完整实现 OCG 查询数据的序列化和反序列化：

### 支持的查询标志
- QUERY_CODE (1): 卡片代码
- QUERY_POSITION (2): 卡片位置
- QUERY_ALIAS (4): 别名
- QUERY_TYPE (8): 卡片类型
- QUERY_LEVEL (16): 等级
- QUERY_RANK (32): 阶级
- QUERY_ATTRIBUTE (64): 属性
- QUERY_RACE (128): 种族
- QUERY_ATTACK (256): 攻击力
- QUERY_DEFENSE (512): 守备力
- QUERY_BASE_ATTACK (1024): 基础攻击力
- QUERY_BASE_DEFENSE (2048): 基础守备力
- QUERY_REASON (4096): 原因
- QUERY_REASON_CARD (8192): 原因卡片（自动跳过）
- QUERY_EQUIP_CARD (16384): 装备卡位置
- QUERY_TARGET_CARD (32768): 目标卡片位置数组
- QUERY_OVERLAY_CARD (65536): 超量素材数组
- QUERY_COUNTERS (131072): 指示物数组
- QUERY_OWNER (262144): 拥有者
- QUERY_STATUS (524288): 状态
- QUERY_LSCALE (2097152): 左刻度
- QUERY_RSCALE (4194304): 右刻度
- QUERY_LINK (8388608): Link 值和 Link 标记

### 小类
- `CardQuery_CardLocation`: 卡片位置信息
- `CardQuery_Counter`: 指示物信息

## 视角控制实现

### MSG_UPDATE_CARD
根据 single_duel.cpp 和 tag_duel.cpp (RefreshSingle) 的实现：
- **对卡片控制者**：发送完整的查询数据
- **对对手**：如果卡片是盖放的（POS_FACEDOWN），只保留 flags = QUERY_CODE 和 code = 0
- **对队友（TAG 决斗）**：
  - 场上卡片（LOCATION_ONFIELD）：发送完整数据（包括盖放）
  - 非场上卡片：和对手视角相同

### MSG_UPDATE_DATA
根据 single_duel.cpp 和 tag_duel.cpp (RefreshMzone/RefreshSzone/RefreshHand) 的实现：
- **对卡片控制者**：发送完整的查询数据
- **对对手**：遍历每张卡片，盖放的卡片（POS_FACEDOWN）清除所有查询数据
- **对队友（TAG 决斗）**：
  - MZONE/SZONE：发送完整数据（队友可以看到己方盖放的卡片）
  - HAND：只有当前操作玩家（cur_player[player]）能看到完整手牌，队友也看不到非公开的手牌
  - 其他公开区域（GRAVE 等）：所有人都能看到

## playerView 实现

### 基类实现
基类 `YGOProMsgBase` 提供了默认的 `playerView` 实现：
- 检查 `this['player']` 字段
- 如果匹配传入的 `playerId`，返回完整数据
- 否则返回 `opponentView()`

### 特殊实现
**MSG_UPDATE_CARD** - 字段名是 `controller` 而不是 `player`，需要重写 `playerView`：
```typescript
playerView(playerId: number): this {
  if (this.controller === playerId) {
    return this.copy();
  }
  return this.opponentView();
}
```

## 测试结果

✅ 所有 66 个测试通过（新增 20 个查询数据和视角控制测试）
✅ 构建成功

新增测试：
- MSG_UPDATE_CARD 的视角控制（对手/队友/playerView）
- MSG_UPDATE_DATA 的视角控制（对手/队友/playerView）
- 场上盖放卡片的队友可见性
- 手牌非公开卡片的队友不可见性
- playerView 正确使用 controller 和 player 字段
