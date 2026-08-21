# MSG Response 使用指南

本文档介绍如何使用 YGOPro MSG 协议的响应功能。

## 概述

YGOPro 协议中有 18 种需要客户端响应的 MSG 消息。本库为这些消息提供了统一的响应生成接口。

## 基础概念

### YGOProMsgResponseBase

所有需要响应的 MSG 类都继承自 `YGOProMsgResponseBase`，该基类提供两个核心方法：

- **`prepareResponse(...)`**: 根据用户选择生成响应数据
- **`defaultResponse(): Uint8Array | undefined`**: 返回"保守默认"响应（如果适用）

## 响应方法

### 1. 简单是/否类型

#### MSG_SELECT_EFFECTYN / MSG_SELECT_YESNO

```typescript
import { YGOProMsgSelectEffectyn, YGOProMsgSelectYesno } from 'ygopro-msg-encode';

// 用户选择是或否
const response = msg.prepareResponse(true);  // 选择"是"
const response = msg.prepareResponse(false); // 选择"否"

// 默认响应（总是"否"）
const defaultResp = msg.defaultResponse(); // 等同于 prepareResponse(false)
```

### 2. 位置选择类型

#### MSG_SELECT_POSITION

```typescript
import { YGOProMsgSelectPosition } from 'ygopro-msg-encode';

// 用户选择卡片位置（使用 POS_* 常量）
const response = msg.prepareResponse(0x1); // POS_FACEUP_ATTACK
```

#### MSG_SELECT_PLACE / MSG_SELECT_DISFIELD

```typescript
import { YGOProMsgSelectPlace, YGOProMsgSelectDisfield } from 'ygopro-msg-encode';

// 选择单个位置
const response = msg.prepareResponse([
  { player: 0, location: 0x04, sequence: 2 } // LOCATION_MZONE, 序列 2
]);

// 选择多个位置
const response = msg.prepareResponse([
  { player: 0, location: 0x04, sequence: 2 },
  { player: 0, location: 0x04, sequence: 3 }
]);
```

### 3. 索引选择类型（支持 IndexResponse 和语义对象）

这类消息支持两种选择方式：
1. **直接索引选择**：使用 `IndexResponse(index)` 明确指定第几个选项
2. **语义对象选择**：通过卡片属性（code、controller、location、sequence、desc）进行匹配

#### MSG_SELECT_BATTLECMD / MSG_SELECT_IDLECMD

```typescript
import { 
  YGOProMsgSelectBattlecmd, 
  BattleCmdType,
  YGOProMsgSelectIdlecmd,
  IdleCmdType,
  IndexResponse 
} from 'ygopro-msg-encode';

// 方式 1: 使用 IndexResponse 直接选择第几个
const response = msg.prepareResponse(
  BattleCmdType.ACTIVATE,
  IndexResponse(0) // 选择第 0 个激活选项
);

// 方式 2: 使用语义对象匹配
const response = msg.prepareResponse(
  BattleCmdType.ACTIVATE,
  { 
    code: 12345678,        // 卡片代码
    controller: 0,         // 控制者
    location: 0x04,        // 位置
    sequence: 2,           // 序列
    desc: 10               // 效果描述（用于区分同一卡片的不同效果）
  }
);

// 方式 3: 部分匹配（只提供部分属性）
const response = msg.prepareResponse(
  IdleCmdType.SUMMON,
  { code: 12345678 } // 只匹配卡片代码
);

// 特殊命令（无需选项）
const response = msg.prepareResponse(IdleCmdType.TO_BP);   // 进入战斗阶段
const response = msg.prepareResponse(IdleCmdType.TO_EP);   // 进入结束阶段
const response = msg.prepareResponse(IdleCmdType.SHUFFLE); // 洗手牌
```

**命令类型枚举：**

```typescript
// BattleCmdType
enum BattleCmdType {
  ACTIVATE = 0,  // 激活效果
  ATTACK = 1,    // 攻击
  TO_M2 = 2,     // 进入 M2
  TO_EP = 3      // 进入结束阶段
}

// IdleCmdType
enum IdleCmdType {
  SUMMON = 0,    // 通常召唤
  SPSUMMON = 1,  // 特殊召唤
  REPOS = 2,     // 改变表示形式
  MSET = 3,      // 盖放怪兽
  SSET = 4,      // 盖放魔陷
  ACTIVATE = 5,  // 激活效果
  TO_BP = 6,     // 进入战斗阶段
  TO_EP = 7,     // 进入结束阶段
  SHUFFLE = 8    // 洗手牌
}
```

#### MSG_SELECT_OPTION

```typescript
import { YGOProMsgSelectOption, IndexResponse } from 'ygopro-msg-encode';

// 方式 1: 使用 IndexResponse
const response = msg.prepareResponse(IndexResponse(1)); // 选择第 1 个选项

// 方式 2: 直接使用数字（简写）
const response = msg.prepareResponse(1);
```

#### MSG_SELECT_CHAIN

```typescript
import { YGOProMsgSelectChain, IndexResponse } from 'ygopro-msg-encode';

// 选择连锁
const response = msg.prepareResponse(IndexResponse(0));

// 或使用语义对象（包含 desc 用于区分同一卡片的不同效果）
const response = msg.prepareResponse({
  code: 12345678,
  controller: 0,
  location: 0x04,
  sequence: 2,
  desc: 10
});

// 不连锁（如果允许取消）
const response = msg.prepareResponse(null);

// 默认响应（仅在无强制连锁时返回"不连锁"）
const defaultResp = msg.defaultResponse();
```

### 4. 卡片选择类型（支持 IndexResponse 和语义对象数组）

#### MSG_SELECT_CARD

```typescript
import { YGOProMsgSelectCard, IndexResponse } from 'ygopro-msg-encode';

// 选择卡片（使用 IndexResponse）
const response = msg.prepareResponse([
  IndexResponse(0),
  IndexResponse(2)
]);

// 使用语义对象选择
const response = msg.prepareResponse([
  { code: 12345678, controller: 0, location: 0x04, sequence: 0 },
  { code: 87654321, location: 0x08 } // 只匹配 code 和 location
]);

// 取消选择（如果允许）
const response = msg.prepareResponse(null);

// 默认响应（仅在 cancelable 时返回"取消"）
const defaultResp = msg.defaultResponse();
```

#### MSG_SELECT_UNSELECT_CARD

```typescript
import { YGOProMsgSelectUnselectCard, IndexResponse } from 'ygopro-msg-encode';

// 选择一张卡片
const response = msg.prepareResponse(IndexResponse(0));

// 使用语义对象
const response = msg.prepareResponse({
  code: 12345678,
  controller: 0,
  location: 0x04,
  sequence: 1
});

// 完成选择（如果 finishable）
const response = msg.prepareResponse(null);

// 默认响应（根据 cancelable/finishable 判断）
const defaultResp = msg.defaultResponse();
```

#### MSG_SELECT_TRIBUTE

```typescript
import { YGOProMsgSelectTribute, IndexResponse } from 'ygopro-msg-encode';

// 选择祭品（方式同 MSG_SELECT_CARD）
const response = msg.prepareResponse([
  IndexResponse(0),
  IndexResponse(1)
]);

// 取消（如果允许）
const response = msg.prepareResponse(null);
```

#### MSG_SORT_CARD

```typescript
import { YGOProMsgSortCard, IndexResponse } from 'ygopro-msg-encode';

// 指定排序顺序
const response = msg.prepareResponse([
  IndexResponse(2),
  IndexResponse(0),
  IndexResponse(1)
]);

// 使用语义对象
const response = msg.prepareResponse([
  { code: 12345678 },
  { code: 87654321 },
  { code: 11223344 }
]);

// 使用默认排序
const response = msg.prepareResponse(null);

// 默认响应（总是返回默认排序）
const defaultResp = msg.defaultResponse(); // 等同于 prepareResponse(null)
```

#### MSG_SELECT_SUM

```typescript
import { YGOProMsgSelectSum, IndexResponse } from 'ygopro-msg-encode';

// 选择等级/刻度和的卡片
const response = msg.prepareResponse([
  IndexResponse(0),
  IndexResponse(2),
  IndexResponse(5)
]);

// 使用语义对象
const response = msg.prepareResponse([
  { code: 12345678, controller: 0, location: 0x04, sequence: 0 },
  { code: 87654321, location: 0x02 }
]);
```

#### MSG_SELECT_COUNTER

```typescript
import { YGOProMsgSelectCounter, IndexResponse } from 'ygopro-msg-encode';

// 为每张卡片指定移除的指示物数量
const response = msg.prepareResponse([
  { card: IndexResponse(0), count: 2 },
  { card: IndexResponse(1), count: 1 }
]);

// 使用语义对象
const response = msg.prepareResponse([
  { card: { code: 12345678, sequence: 0 }, count: 2 },
  { card: { code: 87654321, sequence: 1 }, count: 1 }
]);
```

### 5. 宣言类型

#### MSG_ANNOUNCE_RACE

```typescript
import { YGOProMsgAnnounceRace } from 'ygopro-msg-encode';

// 宣言种族（直接传入种族值，使用 RACE_* 常量）
const response = msg.prepareResponse(0x1); // RACE_WARRIOR

// availableRaces 字段是一个位掩码，表示哪些种族可选
// 例如：availableRaces = 0x3 表示 RACE_WARRIOR (0x1) 和 RACE_SPELLCASTER (0x2) 可选
```

#### MSG_ANNOUNCE_ATTRIB

```typescript
import { YGOProMsgAnnounceAttrib } from 'ygopro-msg-encode';

// 宣言属性（直接传入属性值，使用 ATTRIBUTE_* 常量）
const response = msg.prepareResponse(0x1); // ATTRIBUTE_EARTH

// availableAttributes 字段是一个位掩码，表示哪些属性可选
```

#### MSG_ANNOUNCE_CARD

```typescript
import { YGOProMsgAnnounceCard } from 'ygopro-msg-encode';

// 宣言卡片代码（直接传入卡片代码）
const response = msg.prepareResponse(12345678);

// 注意：opcodes 字段不是可选的卡片列表，而是一个逆波兰表达式（RPN）
// 用于定义宣言条件（如种族、属性、类型等的组合条件）
// 服务器会验证宣言的卡片是否满足 opcodes 定义的条件
```

#### MSG_ANNOUNCE_NUMBER

```typescript
import { YGOProMsgAnnounceNumber, IndexResponse } from 'ygopro-msg-encode';

// 从可用数字中选择一个（使用 IndexResponse）
const response = msg.prepareResponse(IndexResponse(0));

// 或直接使用数字（简写，会自动查找索引）
const response = msg.prepareResponse(0);

// numbers 字段是可选的数字列表
```

## 语义对象匹配规则

使用语义对象时，系统会在可选列表中查找匹配的项：

1. **所有提供的属性都必须匹配**
2. **未提供的属性会被忽略**
3. **如果找不到匹配项，会抛出 `TypeError`**
4. **如果索引超出范围，也会抛出 `TypeError`**

```typescript
// 示例：精确匹配
const response = msg.prepareResponse(
  BattleCmdType.ACTIVATE,
  { 
    code: 12345678,
    controller: 0,
    location: 0x04,
    sequence: 2,
    desc: 10
  }
);

// 示例：只匹配卡片代码
const response = msg.prepareResponse(
  IdleCmdType.SUMMON,
  { code: 12345678 } // 找到第一个 code 为 12345678 的卡片
);

// 示例：匹配位置
const response = msg.prepareResponse(
  IdleCmdType.SPSUMMON,
  { location: 0x40, sequence: 0 } // 额外卡组的第一张卡
);
```

## 默认响应

某些消息提供了"保守默认"响应，通过 `defaultResponse()` 获取：

| 消息类型 | 默认响应 | 条件 |
|---------|---------|------|
| `MSG_SELECT_EFFECTYN` | `false` (否) | 总是可用 |
| `MSG_SELECT_YESNO` | `false` (否) | 总是可用 |
| `MSG_SELECT_CHAIN` | `null` (不连锁) | 无强制连锁时 |
| `MSG_SELECT_CARD` | `null` (取消) | `cancelable = 1` 时 |
| `MSG_SELECT_UNSELECT_CARD` | `null` (完成/取消) | `cancelable = 1` 或 `finishable = 1` 时 |
| `MSG_SELECT_TRIBUTE` | `null` (取消) | `cancelable = 1` 时 |
| `MSG_SORT_CARD` | `null` (默认排序) | 总是可用 |
| 其他消息 | `undefined` | 不可用 |

```typescript
// 检查是否有默认响应
const defaultResp = msg.defaultResponse();
if (defaultResp !== undefined) {
  // 使用默认响应
  sendResponse(defaultResp);
} else {
  // 必须由用户手动选择
  promptUserForResponse(msg);
}
```

## 错误处理

所有 `prepareResponse()` 方法在遇到无效输入时会抛出 `TypeError`：

```typescript
try {
  const response = msg.prepareResponse(
    BattleCmdType.ACTIVATE,
    IndexResponse(999) // 索引超出范围
  );
} catch (e) {
  if (e instanceof TypeError) {
    console.error('无效的选择:', e.message);
    // 可以尝试使用默认响应或提示用户重新选择
  }
}

try {
  const response = msg.prepareResponse(
    IdleCmdType.SUMMON,
    { code: 99999999 } // 找不到这个卡片
  );
} catch (e) {
  if (e instanceof TypeError) {
    console.error('找不到匹配的卡片:', e.message);
  }
}
```

## 常见模式

### 模式 1: 优先使用默认响应

```typescript
function autoRespond(msg: YGOProMsgResponseBase): Uint8Array {
  const defaultResp = msg.defaultResponse();
  if (defaultResp !== undefined) {
    return defaultResp;
  }
  throw new Error('此消息需要用户手动响应');
}
```

### 模式 2: 智能卡片选择

```typescript
function selectByCardCode(
  msg: YGOProMsgSelectCard,
  preferredCodes: number[]
): Uint8Array {
  const selections = [];
  
  for (const code of preferredCodes) {
    try {
      selections.push({ code });
    } catch (e) {
      // 这张卡不可选，跳过
      continue;
    }
    
    if (selections.length >= msg.max) {
      break;
    }
  }
  
  if (selections.length >= msg.min) {
    return msg.prepareResponse(selections);
  }
  
  // 无法满足最小数量要求
  if (msg.cancelable) {
    return msg.prepareResponse(null);
  }
  
  throw new Error('无法选择足够的卡片');
}
```

### 模式 3: 根据效果描述选择

```typescript
function selectEffectByDescription(
  msg: YGOProMsgSelectBattlecmd,
  cardCode: number,
  preferredDesc: number
): Uint8Array {
  try {
    return msg.prepareResponse(
      BattleCmdType.ACTIVATE,
      { code: cardCode, desc: preferredDesc }
    );
  } catch (e) {
    // 该效果不可用，使用第一个可用效果
    return msg.prepareResponse(
      BattleCmdType.ACTIVATE,
      IndexResponse(0)
    );
  }
}
```

## 注意事项

1. **响应格式**: 所有 `prepareResponse()` 返回 `Uint8Array`，即使是单个整数值
2. **null vs undefined**: `null` 表示"不选择/取消"，`undefined` 表示"不可用"
3. **desc 字段**: 在 `ACTIVATE` 类型的选择中，`desc` 用于区分同一卡片的不同效果
4. **索引从 0 开始**: 使用 `IndexResponse(0)` 表示第一个选项
5. **部分匹配**: 语义对象可以只提供部分属性，系统会找到第一个匹配项
6. **类型安全**: 使用 TypeScript 枚举（如 `BattleCmdType`）而不是魔法数字
7. **ANNOUNCE 类型的特殊性**:
   - `MSG_ANNOUNCE_RACE` / `MSG_ANNOUNCE_ATTRIB`: 传入的是实际值（位掩码），不是索引
   - `MSG_ANNOUNCE_CARD`: `opcodes` 是逆波兰表达式（条件定义），不是卡片列表；响应直接传入卡片代码
   - `MSG_ANNOUNCE_NUMBER`: 既可以传入索引，也可以传入实际数字值（会自动查找）

## 完整示例

```typescript
import { 
  YGOProMsgSelectBattlecmd,
  BattleCmdType,
  IndexResponse
} from 'ygopro-msg-encode';

// 解析收到的 MSG
const buffer = new Uint8Array([/* ... */]);
const msg = new YGOProMsgSelectBattlecmd();
fillBinaryFields(msg, buffer);

// 根据游戏逻辑生成响应
let response: Uint8Array;

if (msg.activatableCount > 0) {
  // 优先激活特定卡片的效果
  try {
    response = msg.prepareResponse(
      BattleCmdType.ACTIVATE,
      { code: 12345678, desc: 10 }
    );
  } catch (e) {
    // 该效果不可用，激活第一个可用效果
    response = msg.prepareResponse(
      BattleCmdType.ACTIVATE,
      IndexResponse(0)
    );
  }
} else if (msg.attackableCount > 0) {
  // 攻击
  response = msg.prepareResponse(
    BattleCmdType.ATTACK,
    IndexResponse(0)
  );
} else if (msg.canToEp) {
  // 进入结束阶段
  response = msg.prepareResponse(BattleCmdType.TO_EP);
} else {
  throw new Error('无可用操作');
}

// 发送响应
sendCtosResponse(response);
```

## 相关文件

- `src/protos/msg/with-response-base.ts` - 响应基类
- `src/protos/msg/index-response.ts` - IndexResponse 工具
- `src/protos/msg/proto/*` - 各个消息类型的实现
