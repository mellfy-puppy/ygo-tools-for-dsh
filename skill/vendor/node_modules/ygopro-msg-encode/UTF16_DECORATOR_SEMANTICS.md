# UTF-16 装饰器语义说明

## 概述

`@BinaryField('utf16', offset, length)` 装饰器中的 `length` 参数表示**字符数**，而不是字节数。

## 语义规则

### UTF-16 字段
```typescript
@BinaryField('utf16', 0, 20)
name: string;
```
- `length` 参数：**20** 表示 **20 个字符**
- 实际占用空间：**40 字节**（每个字符占 2 字节，UTF-16LE 编码）
- 对应 C++ 定义：`uint16_t name[20]`

### UTF-8 字段
```typescript
@BinaryField('utf8', 0, 100)
text: string;
```
- `length` 参数：**100** 表示 **100 字节**
- 实际占用空间：**100 字节**

## 实现细节

在 `src/binary/fill-binary-fields.ts` 中：

```typescript
// 读取字符串时
if (type === 'utf8' || type === 'utf16') {
  const lengthValue = resolveLength(obj, info.length!, key);
  // utf16: 字符数转换为字节数
  const byteLength = type === 'utf16' ? lengthValue * 2 : lengthValue;
  (obj as any)[key] = readString(type, offset, byteLength);
  totalSize = Math.max(totalSize, offset + byteLength);
}
```

## 与 YGOPro C++ 协议对应关系

| TypeScript | C++ | 字符数 | 字节数 |
|------------|-----|--------|--------|
| `@BinaryField('utf16', 0, 20)` | `uint16_t name[20]` | 20 | 40 |
| `@BinaryField('utf16', 0, 256)` | `uint16_t msg[256]` | 256 | 512 |

## 示例

### CTOS_PlayerInfo
```typescript
export class YGOProCtosPlayerInfo extends YGOProCtosBase {
  @BinaryField('utf16', 0, 20)  // 20 字符 = 40 字节
  name: string;
}
```

对应 C++：
```cpp
struct CTOS_PlayerInfo {
  uint16_t name[20]{};  // 20 个 uint16_t = 40 字节
};
static_assert(sizeof(CTOS_PlayerInfo) == 40, "size mismatch: CTOS_PlayerInfo");
```

### CTOS_CreateGame
```typescript
export class YGOProCtosCreateGame extends YGOProCtosBase {
  @BinaryField(() => HostInfo, 0)
  info: HostInfo;  // 20 字节

  @BinaryField('utf16', 20, 20)  // 20 字符 = 40 字节
  name: string;

  @BinaryField('utf16', 60, 20)  // 20 字符 = 40 字节
  pass: string;
}
```

对应 C++：
```cpp
struct CTOS_CreateGame {
  HostInfo info;         // 20 字节
  uint16_t name[20]{};   // 40 字节
  uint16_t pass[20]{};   // 40 字节
};
static_assert(sizeof(CTOS_CreateGame) == 100, "size mismatch: CTOS_CreateGame");
```

## 修改历史

- **2026-02-11**: 修改 utf16 装饰器语义，将 `length` 参数从表示字节数改为表示字符数，与 C++ 定义保持一致。
