# UTF-16 字符串字段修复总结

## 问题

多个网络协议中的字段被错误地定义为 `u16` 数组（`number[]`），但实际上它们应该是 UTF-16 字符串（`string`）。

这些字段在源码 `network.h` 中都定义为 `uint16_t name[20]` 或 `uint16_t pass[20]`，表示 UTF-16 编码的字符串，而不是整数数组。

## 修复的字段

### 1. CTOS_PlayerInfo (`src/protos/ctos/proto/player-info.ts`)

**修复前**:
```typescript
@BinaryField('u16', 0, 20)
name: number[];
```

**修复后**:
```typescript
@BinaryField('utf16', 0, 20)
name: string;
```

### 2. CTOS_JoinGame (`src/protos/ctos/proto/join-game.ts`)

**修复前**:
```typescript
@BinaryField('u16', 8, 20)
pass: number[];
```

**修复后**:
```typescript
@BinaryField('utf16', 8, 20)
pass: string;
```

### 3. CTOS_CreateGame (`src/protos/ctos/proto/create-game.ts`)

**修复前**:
```typescript
@BinaryField('u16', 20, 20)
name: number[];

@BinaryField('u16', 60, 20)
pass: number[];
```

**修复后**:
```typescript
@BinaryField('utf16', 20, 20)
name: string;

@BinaryField('utf16', 60, 20)
pass: string;
```

### 4. STOC_HS_PlayerEnter (`src/protos/stoc/proto/hs-player-enter.ts`)

**修复前**:
```typescript
@BinaryField('u16', 0, 20)
name: number[];
```

**修复后**:
```typescript
@BinaryField('utf16', 0, 20)
name: string;
```

## 测试文件修复

同时更新了 `tests/ctos-stoc.spec.ts` 中的相关测试：

**修复前**:
```typescript
playerInfo.name = Array.from({ length: 20 }, (_, i) =>
  i < 4 ? 0x0041 + i : 0,
); // "ABCD"
```

**修复后**:
```typescript
playerInfo.name = 'ABCD';
```

## 源码参考

根据 `gframe/network.h` 的定义：

```cpp
struct CTOS_PlayerInfo {
    uint16_t name[20]{};  // UTF-16 string, 20 characters max
};

struct CTOS_CreateGame {
    HostInfo info;
    uint16_t name[20]{};  // UTF-16 string, 20 characters max
    uint16_t pass[20]{};  // UTF-16 string, 20 characters max
};

struct CTOS_JoinGame {
    uint16_t version{};
    // byte padding[2]
    uint32_t gameid{};
    uint16_t pass[20]{};  // UTF-16 string, 20 characters max
};

struct STOC_HS_PlayerEnter {
    uint16_t name[20]{};  // UTF-16 string, 20 characters max
    uint8_t pos{};
    // byte padding[1]
};
```

所有这些 `uint16_t array[20]` 字段都是用于存储 UTF-16 编码的字符串，最多 20 个字符（包括 null 终止符）。

## 使用示例

### 修复前（错误）:
```typescript
const playerInfo = new YGOProCtosPlayerInfo();
playerInfo.name = [0x0041, 0x0042, 0x0043, 0x0044, 0, 0, ...]; // "ABCD"
```

### 修复后（正确）:
```typescript
const playerInfo = new YGOProCtosPlayerInfo();
playerInfo.name = 'ABCD'; // 直接使用字符串

const createGame = new YGOProCtosCreateGame();
createGame.name = 'MyGame';
createGame.pass = 'password123';

const joinGame = new YGOProCtosJoinGame();
joinGame.version = 0x1353;
joinGame.gameid = 12345;
joinGame.pass = 'password123';
```

## 二进制格式

UTF-16 字符串在二进制中的存储方式：
- 每个字符占 2 字节（UTF-16LE 编码）
- 字符串以 null 终止符（`\0`, `0x0000`）结尾
- 固定长度字段会被 null 字符填充到指定长度

例如，字符串 `"ABCD"` 在 20 字符的字段中：
```
41 00 42 00 43 00 44 00 00 00 00 00 ... (共 40 字节)
 A     B     C     D    \0   \0   ...
```

## 向后兼容性

这个修复是**破坏性变更**，因为字段类型从 `number[]` 改为了 `string`。

**升级指南**：
```typescript
// 旧代码
playerInfo.name = [0x0041, 0x0042, 0x0043, 0x0044, ...];

// 新代码
playerInfo.name = 'ABCD';

// 如果需要从旧格式转换
const oldName = [0x0041, 0x0042, 0x0043, 0x0044, 0, ...];
const newName = String.fromCharCode(...oldName.filter(c => c !== 0));
playerInfo.name = newName;
```

## 验证

所有测试通过：
- ✅ Binary serialization/deserialization tests
- ✅ CTOS/STOC protocol tests
- ✅ Round-trip encoding/decoding tests

## 总结

共修复了 **4 个文件** 中的 **5 个字段**：
1. `CTOS_PlayerInfo.name` - 玩家名称
2. `CTOS_JoinGame.pass` - 游戏密码
3. `CTOS_CreateGame.name` - 游戏名称
4. `CTOS_CreateGame.pass` - 游戏密码
5. `STOC_HS_PlayerEnter.name` - 玩家名称

所有字段都从 `@BinaryField('u16', ..., 20)` + `number[]` 改为 `@BinaryField('utf16', ..., 20)` + `string`。
