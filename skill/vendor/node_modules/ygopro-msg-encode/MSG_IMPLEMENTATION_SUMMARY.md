# YGOPro MSG 类实现总结

## 项目概览

已完成 **84 个 MSG 类**的完整实现，涵盖 YGOPro 协议的所有主要消息类型。

## 实现的消息类型

### 基础消息（无字段或简单字段）
1. MSG_RETRY (1) - 重试
2. MSG_WAITING (3) - 等待
3. MSG_WIN (5) - 胜利
4. MSG_NEW_TURN (40) - 新回合
5. MSG_NEW_PHASE (41) - 新阶段
6. MSG_SHUFFLE_DECK (32) - 洗卡组
7. MSG_SWAP_GRAVE_DECK (35) - 墓地卡组交换
8. MSG_REVERSE_DECK (37) - 翻转卡组
9. MSG_CHAIN_END (74) - 连锁结束
10. MSG_SUMMONED (61) - 召唤完成
11. MSG_SPSUMMONED (63) - 特殊召唤完成
12. MSG_FLIPSUMMONED (65) - 翻转召唤完成
13. MSG_ATTACK_DISABLED (112) - 攻击禁用
14. MSG_DAMAGE_STEP_START (113) - 伤害步骤开始
15. MSG_DAMAGE_STEP_END (114) - 伤害步骤结束
16. MSG_HAND_RES (133) - 猜拳结果
17. MSG_ROCK_PAPER_SCISSORS (132) - 猜拳

### 玩家状态消息
18. MSG_HINT (2) - 提示
19. MSG_DAMAGE (91) - 伤害
20. MSG_RECOVER (92) - 回复
21. MSG_LPUPDATE (94) - LP 更新
22. MSG_PAY_LPCOST (100) - 支付 LP
23. MSG_PLAYER_HINT (165) - 玩家提示
24. MSG_RESET_TIME (221) - 重置时间

### 卡片状态消息
25. MSG_SET (54) - 盖放
26. MSG_POS_CHANGE (53) - 位置变更
27. MSG_MOVE (50) - 移动
28. MSG_SWAP (55) - 交换
29. MSG_FIELD_DISABLED (56) - 场地禁用
30. MSG_SUMMONING (60) - 召唤中
31. MSG_SPSUMMONING (62) - 特殊召唤中
32. MSG_FLIPSUMMONING (64) - 翻转召唤中
33. MSG_CARD_HINT (160) - 卡片提示
34. MSG_DECK_TOP (38) - 卡组顶部

### 战斗相关消息
35. MSG_ATTACK (110) - 攻击宣言
36. MSG_BATTLE (111) - 战斗伤害计算

### 连锁相关消息
37. MSG_CHAINING (70) - 连锁中
38. MSG_CHAINED (71) - 连锁完成
39. MSG_CHAIN_SOLVING (72) - 连锁处理中
40. MSG_CHAIN_SOLVED (73) - 连锁处理完成
41. MSG_CHAIN_NEGATED (75) - 连锁无效
42. MSG_CHAIN_DISABLED (76) - 连锁禁用

### 目标和装备消息
43. MSG_EQUIP (93) - 装备
44. MSG_CARD_TARGET (96) - 卡片目标
45. MSG_CANCEL_TARGET (97) - 取消目标
46. MSG_BECOME_TARGET (83) - 成为目标

### 指示物消息
47. MSG_ADD_COUNTER (101) - 添加指示物
48. MSG_REMOVE_COUNTER (102) - 移除指示物

### 随机效果消息
49. MSG_TOSS_COIN (130) - 投硬币
50. MSG_TOSS_DICE (131) - 掷骰子
51. MSG_RANDOM_SELECTED (81) - 随机选择
52. MSG_MISSED_EFFECT (120) - 错过时点

### 宣言消息
53. MSG_ANNOUNCE_RACE (140) - 宣言种族
54. MSG_ANNOUNCE_ATTRIB (141) - 宣言属性
55. MSG_ANNOUNCE_CARD (142) - 宣言卡片
56. MSG_ANNOUNCE_NUMBER (143) - 宣言数字

### 选择消息（简单）
57. MSG_SELECT_YESNO (13) - 是/否选择
58. MSG_SELECT_OPTION (14) - 选项选择
59. MSG_SELECT_POSITION (19) - 位置选择
60. MSG_SELECT_PLACE (18) - 区域选择
61. MSG_SELECT_DISFIELD (24) - 禁用场地选择
62. MSG_SELECT_EFFECTYN (12) - 效果是/否

### 选择消息（复杂）
63. MSG_SELECT_CARD (15) - 卡片选择
64. MSG_SELECT_TRIBUTE (20) - 解放选择
65. MSG_SELECT_COUNTER (22) - 指示物选择
66. MSG_SELECT_SUM (23) - 总和选择
67. MSG_SELECT_UNSELECT_CARD (26) - 可选/不可选卡片
68. MSG_SELECT_CHAIN (16) - 连锁选择
69. MSG_SELECT_BATTLECMD (10) - 战斗命令选择
70. MSG_SELECT_IDLECMD (11) - 主要阶段命令选择

### 确认和洗牌消息
71. MSG_CONFIRM_DECKTOP (30) - 确认卡组顶部
72. MSG_CONFIRM_EXTRATOP (42) - 确认额外卡组顶部
73. MSG_CONFIRM_CARDS (31) - 确认卡片
74. MSG_SHUFFLE_HAND (33) - 洗手牌
75. MSG_SHUFFLE_EXTRA (39) - 洗额外卡组
76. MSG_SHUFFLE_SET_CARD (36) - 洗覆盖卡
77. MSG_SORT_CARD (25) - 排序卡片
78. MSG_DRAW (90) - 抽卡

### TAG 决斗消息
79. MSG_TAG_SWAP (161) - TAG 交换

### 特殊消息
80. MSG_MATCH_KILL (170) - 比赛中止
81. MSG_START (4) - 决斗开始
82. MSG_UPDATE_CARD (7) - 更新卡片（完整实现）
83. MSG_UPDATE_DATA (6) - 更新数据（完整实现）
84. MSG_RELOAD_FIELD (162) - 重载场地

## CardQuery 完整查询数据类

### 标量字段
- code, alias, type
- level, rank, attribute, race
- attack, defense, baseAttack, baseDefense
- reason, owner, status
- lscale, rscale, link, linkMarker
- position

### 数组/对象字段
- equipCard: CardQuery_CardLocation
- targetCards: CardQuery_CardLocation[]
- overlayCards: number[] (卡片代码数组)
- counters: CardQuery_Counter[] (指示物数组)

### 特性
- 支持所有 QUERY_* 标志位
- 自动按标志位顺序序列化和反序列化
- 正确处理可变长度数组
- 支持空卡片（flags = 0）

## 视角控制（opponentView/teammateView）

以下消息实现了视角控制，向对方/队友隐藏敏感信息：

1. **MSG_DRAW** - 隐藏未公开的抽牌
2. **MSG_SHUFFLE_HAND** - 隐藏手牌内容
3. **MSG_SHUFFLE_EXTRA** - 隐藏未公开的额外卡组
4. **MSG_DECK_TOP** - 隐藏卡组顶部信息
5. **MSG_CONFIRM_DECKTOP** - 隐藏未公开的卡组顶部
6. **MSG_CONFIRM_EXTRATOP** - 隐藏未公开的额外顶部
7. **MSG_CONFIRM_CARDS** - 隐藏未公开的卡片
8. **MSG_TAG_SWAP** - TAG 交换时隐藏手牌和额外卡组
9. **MSG_UPDATE_CARD** - 对手视角隐藏盖放卡片的详细信息
10. **MSG_UPDATE_DATA** - 对手视角隐藏盖放卡片的详细信息，队友可见全部

## 小类命名规范

所有小类都使用 `{主类名}_{小类名}` 格式，并且全部导出：

### 常见小类
- `*_CardInfo`: 带代码的卡片信息（code + location）
- `*_CardLocation`: 卡片位置信息（controller + location + sequence + position）
- `*_SimpleCardInfo`: 简单卡片信息（code + location，7字节）
- `*_ActivatableInfo`: 可激活卡片信息（code + location + desc，11字节）
- `*_AttackableInfo`: 可攻击卡片信息（code + location + directAttack，8字节）
- `*_ChainInfo`: 连锁信息（13字节）
- `*_SetCardInfo`: 覆盖卡信息（oldLocation + newLocation）
- `*_CardStats`: 卡片状态（location + atk + def）
- `*_Counter`: 指示物信息（type + count）
- `*_PlayerInfo`: 玩家信息
- `*_ZoneCard`: 区域卡片信息

## 二进制格式

### 标准格式
```
[MSG_IDENTIFIER (1 byte)][字段数据...]
```

### 查询数据格式（MSG_UPDATE_CARD）
```
[MSG_IDENTIFIER][controller][location][sequence][length (4 bytes)][flags (4 bytes)][查询字段...]
```

### 字段查询数据格式（MSG_UPDATE_DATA）
```
[MSG_IDENTIFIER][player][location]
  [length1 (4 bytes)][flags1 (4 bytes)][查询字段1...]
  [length2 (4 bytes)][flags2 (4 bytes)][查询字段2...]
  ...
```

## 文件统计

- **MSG 类文件**: 84 个
- **小类**: 30+ 个
- **测试用例**: 57 个（全部通过）
- **代码行数**: ~3000+ 行

## 测试覆盖

- ✅ 简单字段序列化/反序列化
- ✅ 动态长度数组
- ✅ 嵌套对象和对象数组
- ✅ 视角控制（opponentView/teammateView）
- ✅ MSG identifier 验证
- ✅ 查询数据完整解析
- ✅ 多卡片查询数据数组
- ✅ Registry 系统

## 使用示例

### 基础使用
```typescript
import { YGOProMsgDraw, OcgcoreCommonConstants } from 'ygopro-msg-encode';

// 创建消息
const msg = new YGOProMsgDraw();
msg.player = 0;
msg.count = 2;
msg.cards = [12345, 67890];

// 序列化
const binary = msg.toPayload();

// 反序列化
const decoded = new YGOProMsgDraw();
decoded.fromPayload(binary);
```

### 视角控制
```typescript
const msg = new YGOProMsgDraw();
msg.player = 0;
msg.count = 2;
msg.cards = [12345, 0x80000000 | 67890]; // 第二张卡公开

// 对方视角
const opponentView = msg.opponentView();
console.log(opponentView.cards); // [0, 0x80000000 | 67890]
```

### 查询数据
```typescript
import { YGOProMsgUpdateCard, CardQuery } from 'ygopro-msg-encode';

const msg = new YGOProMsgUpdateCard();
msg.controller = 0;
msg.location = 4; // MZONE
msg.sequence = 0;

msg.card = new CardQuery();
msg.card.flags = QUERY_CODE | QUERY_ATTACK | QUERY_DEFENSE;
msg.card.code = 89631139; // 青眼白龙
msg.card.attack = 3000;
msg.card.defense = 2500;

const binary = msg.toPayload();
```

### Registry 使用
```typescript
import { YGOProMessages, OcgcoreCommonConstants } from 'ygopro-msg-encode';

// 根据 identifier 获取类
const MsgClass = YGOProMessages.get(OcgcoreCommonConstants.MSG_WIN);
const msg = new MsgClass();

// 解析二进制数据
const identifier = data[0];
const MsgClass2 = YGOProMessages.get(identifier);
const decoded = new MsgClass2();
decoded.fromPayload(data);
```

## 技术亮点

### 1. 装饰器系统
使用 `@BinaryField` 装饰器定义二进制结构，支持：
- 固定偏移和动态偏移
- 固定长度和动态长度
- 嵌套对象和对象数组
- 基础类型：u8, i8, u16, i16, u32, i32, utf8, utf16

### 2. 自动序列化
- 自动按字段顺序序列化和反序列化
- 支持 Little-Endian 字节序
- 正确处理字符串截断和空终止符

### 3. 视角系统
- `opponentView()`: 对方视角（隐藏手牌、未公开信息）
- `teammateView()`: 队友视角（TAG 决斗）
- `observerView()`: 观察者视角
- `playerView(playerId)`: 指定玩家视角

### 4. 类型安全
- 完整的 TypeScript 类型定义
- 所有小类都导出，可独立使用
- 编译时类型检查

### 5. 可扩展性
- Registry 系统支持动态注册
- 易于添加新的 MSG 类型
- 小类可在不同 MSG 之间复用

## 参考来源

- YGOPro ocgcore: `/home/nanahira/ygo/ygopro/ocgcore`
- YGOPro 客户端: `/home/nanahira/ygo/ygopro/gframe`
- 参考实现: `/home/nanahira/ygo/koishipro-core.js`

## 视角系统实现

### playerView 方法
基类提供了默认实现，检查 `this['player']` 字段：
- 如果 `player === playerId`：返回完整数据
- 否则：返回 `opponentView()`

### 特殊情况
**MSG_UPDATE_CARD**: 字段名是 `controller` 而非 `player`，需要重写 `playerView` 方法。

### 视角类型总结
1. **opponentView()**: 对手视角，隐藏未公开信息
2. **teammateView()**: TAG 决斗队友视角
   - 场上：可见盖放卡片
   - 手牌：不可见非公开卡片
3. **observerView()**: 观察者视角，默认使用 opponentView
4. **playerView(playerId)**: 根据玩家 ID 自动选择视角

## 测试结果

```
Test Suites: 4 passed, 4 total
Tests:       66 passed, 66 total
Snapshots:   0 total
Time:        ~11 seconds
```

### 测试覆盖
- ✅ 基础序列化/反序列化（31 个测试）
- ✅ 查询数据完整解析（11 个测试）
- ✅ 视角控制（24 个测试）
  - MSG_DRAW, MSG_SHUFFLE_HAND 等的 opponentView
  - MSG_TAG_SWAP 的 teammateView
  - MSG_UPDATE_CARD 的视角控制
    - 对手视角：盖放卡片隐藏
    - 队友视角：场上盖放卡片可见，非场上盖放卡片隐藏
    - playerView：正确使用 controller 字段
  - MSG_UPDATE_DATA 的视角控制
    - 对手视角：盖放卡片隐藏
    - 队友视角：MZONE/SZONE 盖放可见，HAND 非公开不可见
    - playerView：正确使用 player 字段

✅ 所有测试通过
✅ 构建成功
✅ 类型检查通过
