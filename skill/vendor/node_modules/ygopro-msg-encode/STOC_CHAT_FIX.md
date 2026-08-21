# STOC_CHAT player_type 修正总结

## 问题

`STOC_Chat.player_type` 字段之前被定义为 `NetPlayerType` 枚举，但实际上该字段可以包含两种不同类型的值：

1. **玩家类型**（0-7）：PLAYER1-6, OBSERVER
2. **聊天颜色**（8-19）：用于系统消息或特殊格式的聊天

## 修正

### 1. 添加 ChatColor 枚举 ✅

在 `src/protos/network-enums.ts` 中添加：

```typescript
/**
 * Chat message colors (used in STOC_Chat.player_type)
 */
export enum ChatColor {
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

**来源**：`/home/nanahira/ygo/srvpro/data/constants.json` 中的 `COLORS` 定义

### 2. 将 player_type 改回 number ✅

```typescript
export class YGOProStocChat extends YGOProStocBase {
  static identifier = 0x19;

  player_type: number; // NetPlayerType (0-7) or ChatColor (8-19)
  msg: string;
  
  // ...
}
```

**原因**：该字段可以是玩家类型或聊天颜色，使用联合类型更合适。

### 3. 更新了文档 ✅

- `README.md` - 添加了 `ChatColor` 的使用示例
- `ENUM_UPDATE.md` - 说明了 `player_type` 保持为 `number` 的原因

## 使用场景

### 场景 1：玩家发送的聊天消息

```typescript
import { YGOProStocChat, NetPlayerType } from 'ygopro-msg-encode';

const chat = new YGOProStocChat();
chat.player_type = NetPlayerType.PLAYER1; // 或直接使用 0
chat.msg = "Good game!";
```

在这种情况下，`player_type` 表示发送消息的玩家位置。

### 场景 2：系统消息或特殊颜色

```typescript
import { YGOProStocChat, ChatColor } from 'ygopro-msg-encode';

const chat = new YGOProStocChat();
chat.player_type = ChatColor.RED; // 红色系统消息
chat.msg = "Game will start in 10 seconds!";
```

在这种情况下，`player_type` 表示聊天消息的颜色。

## duelclient.cpp 中的处理逻辑

从源码可以看到：

```cpp
uint16_t chat_player_type = BufferIO::Read<uint16_t>(pdata);
// ...
int player = chat_player_type;
auto play_sound = false;
if(player < 4) {  // 玩家消息（0-3）
    auto localplayer = mainGame->ChatLocalPlayer(player);
    player = localplayer & 0xf;
    if(!(localplayer & 0x10))
        play_sound = true;
    if(play_sound && mainGame->chkIgnore1->isChecked())
        break;
} else {  // 系统消息或特殊颜色（>= 4）
    if(player == 8) { //system custom message.
        // ...
    }
}
```

客户端根据 `player_type` 的值：
- **< 4**：当作玩家消息处理
- **>= 4**：当作系统消息或特殊格式处理（可能包含颜色信息）

## 颜色值映射（参考）

| 值 | 常量名 | 说明 |
|----|--------|------|
| 8 | LIGHTBLUE | 浅蓝色 |
| 11 | RED | 红色 |
| 12 | GREEN | 绿色 |
| 13 | BLUE | 蓝色 |
| 14 | BABYBLUE | 婴儿蓝 |
| 15 | PINK | 粉色 |
| 16 | YELLOW | 黄色 |
| 17 | WHITE | 白色 |
| 18 | GRAY | 灰色 |
| 19 | DARKGRAY | 深灰色 |

## 类型安全建议

虽然 `player_type` 是 `number` 类型，但可以使用类型守卫来确保类型安全：

```typescript
function isPlayerType(value: number): value is NetPlayerType {
  return value >= 0 && value <= 7 && value !== 6;
}

function isChatColor(value: number): value is ChatColor {
  return value >= 8 && value <= 19;
}

// 使用
const chat = new YGOProStocChat();
chat.fromFullPayload(data);

if (isPlayerType(chat.player_type)) {
  console.log('Player message from:', NetPlayerType[chat.player_type]);
} else if (isChatColor(chat.player_type)) {
  console.log('System message with color:', ChatColor[chat.player_type]);
} else {
  console.log('Unknown player_type:', chat.player_type);
}
```

## 总结

`STOC_Chat.player_type` 是一个多用途字段：
- ✅ 保持为 `number` 类型以支持两种不同的语义
- ✅ 提供 `NetPlayerType` 和 `ChatColor` 枚举供参考
- ✅ 用户可以根据值的范围判断其含义
- ✅ 完全向后兼容，不影响现有代码
