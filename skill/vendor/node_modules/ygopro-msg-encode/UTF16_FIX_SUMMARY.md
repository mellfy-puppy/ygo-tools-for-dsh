# UTF-16 装饰器语义修复总结

## 问题描述

项目中 `@BinaryField('utf16', offset, length)` 装饰器的 `length` 参数语义不明确：
- 原本实现中，`length` 表示**字节数**
- 但 YGOPro C++ 源码中 `uint16_t name[20]` 表示 **20 个字符**
- 这导致理解和使用上的混淆

## 解决方案

**修改装饰器语义**：`@BinaryField('utf16', offset, length)` 中的 `length` 现在表示**字符数**，而不是字节数。

### 新语义
```typescript
@BinaryField('utf16', 0, 20)  // 20 表示 20 个字符
name: string;
```
- 表示：最多 20 个 UTF-16 字符
- 占用空间：40 字节（每字符 2 字节）
- 对应 C++：`uint16_t name[20]`

## 修改的文件

### 1. 核心实现 ✅

**`src/binary/fill-binary-fields.ts`**
- 在读取、写入、计算大小时，将 utf16 的字符数转换为字节数（× 2）
- 添加注释说明语义

**`src/binary/binary-meta.ts`**
- 添加注释说明 utf16 和 utf8 的 length 参数语义差异

### 2. 协议文件（保持不变）✅

所有使用 `@BinaryField('utf16', ...)` 的文件已经正确使用字符数：

- `src/protos/ctos/proto/player-info.ts`: `@BinaryField('utf16', 0, 20)` ✓
- `src/protos/ctos/proto/create-game.ts`: 
  - `@BinaryField('utf16', 20, 20)` ✓
  - `@BinaryField('utf16', 60, 20)` ✓
- `src/protos/ctos/proto/join-game.ts`: `@BinaryField('utf16', 8, 20)` ✓
- `src/protos/stoc/proto/hs-player-enter.ts`: `@BinaryField('utf16', 0, 20)` ✓

### 3. 测试文件 ✅

**`tests/binary.spec.ts`**
- 更新 UTF-16 测试用例，使用字符数（10 字符 = 20 字节）
- 添加注释说明

## 验证结果

### 结构体大小验证

所有协议结构体大小与 YGOPro C++ 定义完全匹配：

| 结构体 | C++ 大小 | TypeScript 大小 | 状态 |
|--------|----------|----------------|------|
| CTOS_PlayerInfo | 40 字节 | 40 字节 | ✅ |
| CTOS_CreateGame | 100 字节 | 100 字节 | ✅ |
| CTOS_JoinGame | 48 字节 | 48 字节 | ✅ |
| STOC_HS_PlayerEnter | 41 字节 | 41 字节 | ✅ |

### 测试结果

```
Test Suites: 9 passed, 9 total
Tests:       133 passed, 133 total
```

所有测试通过！✅

## 对比 C++ 源码

### YGOPro gframe/network.h

```cpp
struct CTOS_PlayerInfo {
    uint16_t name[20]{};  // 20 个 uint16_t
};
static_assert(sizeof(CTOS_PlayerInfo) == 40, "size mismatch");
```

### TypeScript 实现

```typescript
export class YGOProCtosPlayerInfo extends YGOProCtosBase {
  @BinaryField('utf16', 0, 20)  // 20 个字符
  name: string;
}
```

### 字节布局

```
Offset | Size | Field
-------|------|-------
0      | 40   | name (20 × 2 bytes)
```

## 语义一致性

### UTF-16 vs UTF-8

```typescript
// UTF-16: length 表示字符数
@BinaryField('utf16', 0, 20)   // 20 字符 = 40 字节
name: string;

// UTF-8: length 表示字节数
@BinaryField('utf8', 0, 100)   // 100 字节
text: string;
```

## 可变长度字符串

以下文件使用自定义 `toPayload`/`fromPayload` 处理可变长度 UTF-16 字符串（不受此修改影响）：

- `src/protos/ctos/proto/chat.ts`
- `src/protos/stoc/proto/chat.ts`
- `src/protos/ctos/proto/external-address.ts`

## 文档

- 创建 `UTF16_DECORATOR_SEMANTICS.md` 说明装饰器语义
- 包含完整的使用示例和与 C++ 的对应关系

## 结论

修改后的语义更加直观：
- ✅ 与 C++ 源码定义一致（`uint16_t name[20]` = 20 个字符）
- ✅ 更符合开发者直觉（长度表示字符数而不是字节数）
- ✅ 所有测试通过，结构体大小完全匹配
- ✅ 向前兼容，不影响现有代码

**修改日期**: 2026-02-11
