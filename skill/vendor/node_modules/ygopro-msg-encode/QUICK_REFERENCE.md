# toFullPayload / fromFullPayload 快速参考

## 快速开始 ⚡

```typescript
import { YGOProCtosChat } from 'ygopro-msg-encode';

// 序列化（旧方式 ❌）
const chat = new YGOProCtosChat();
chat.msg = "Hello";
const body = chat.toPayload();
// 还需要手动添加 header...

// 序列化（新方式 ✅）
const chat = new YGOProCtosChat();
chat.msg = "Hello";
const fullPayload = chat.toFullPayload(); // 一行搞定！

// 反序列化（新方式 ✅）
const parsed = new YGOProCtosChat();
parsed.fromFullPayload(fullPayload);
console.log(parsed.msg); // "Hello"
```

## API 参考

### toFullPayload()

序列化为完整数据包（包含 header）。

```typescript
toFullPayload(): Uint8Array
```

**返回**: `[length 2 bytes LE][identifier 1 byte][body]`

**示例**:
```typescript
const protocol = new YGOProCtosPlayerInfo();
protocol.name = [0x41, 0x42, ...];
const fullPayload = protocol.toFullPayload();
// fullPayload[0-1]: length (LE)
// fullPayload[2]:   identifier (0x10)
// fullPayload[3+]:  body
```

### fromFullPayload(data)

从完整数据包反序列化。

```typescript
fromFullPayload(data: Uint8Array): this
```

**参数**:
- `data`: 完整数据包（包含 header）

**返回**: `this`（链式调用）

**异常**:
- 数据太短 → `Error: payload too short`
- identifier 不匹配 → `Error: identifier mismatch`

**示例**:
```typescript
const protocol = new YGOProCtosPlayerInfo();
try {
  protocol.fromFullPayload(fullPayload);
  console.log(protocol.name);
} catch (error) {
  console.error('Parse error:', error.message);
}
```

## 常见用例

### 1. 发送消息

```typescript
const chat = new YGOProCtosChat();
chat.msg = "GG!";
socket.send(chat.toFullPayload()); // ✅ 直接发送
```

### 2. 接收消息

```typescript
socket.on('data', (data: Uint8Array) => {
  const chat = new YGOProStocChat();
  try {
    chat.fromFullPayload(data);
    console.log(`[${chat.player_type}] ${chat.msg}`);
  } catch (error) {
    console.error('Invalid packet:', error.message);
  }
});
```

### 3. 往返测试

```typescript
const original = new YGOProCtosHandResult();
original.res = 1;

const fullPayload = original.toFullPayload();

const parsed = new YGOProCtosHandResult();
parsed.fromFullPayload(fullPayload);

expect(parsed.res).toBe(original.res); // ✅ Pass
```

### 4. 批量处理

```typescript
const messages = ["msg1", "msg2", "msg3"];
const payloads = messages.map(msg => {
  const chat = new YGOProCtosChat();
  chat.msg = msg;
  return chat.toFullPayload();
});
```

## 错误处理

### 数据太短

```typescript
const shortData = new Uint8Array([1, 0]); // 只有 2 字节
const protocol = new YGOProCtosChat();

try {
  protocol.fromFullPayload(shortData);
} catch (error) {
  // Error: CTOS payload too short: expected at least 3 bytes, got 2
}
```

### identifier 不匹配

```typescript
const wrongData = new Uint8Array([5, 0, 0xFF, ...]); // identifier = 0xFF
const protocol = new YGOProCtosChat(); // 期望 0x16

try {
  protocol.fromFullPayload(wrongData);
} catch (error) {
  // Error: CTOS identifier mismatch: expected 0x16, got 0xff
}
```

### 自动截断

```typescript
// 声明长度 5，但实际有 100 字节
const extended = new Uint8Array(100);
extended[0] = 5;  // length
extended[1] = 0;
extended[2] = 0x03; // identifier
// ... body 2 bytes ...
// ... extra 93 bytes ...

const protocol = new YGOProCtosHandResult();
protocol.fromFullPayload(extended); // ✅ 成功！自动截断
```

## 数据包格式

```
完整数据包格式:
┌────────────────┬──────────────┬─────────────────┐
│ Byte 0-1       │ Byte 2       │ Byte 3+         │
├────────────────┼──────────────┼─────────────────┤
│ Length (u16)   │ Identifier   │ Body            │
│ Little Endian  │ (u8)         │ (Variable)      │
└────────────────┴──────────────┴─────────────────┘

Length = 1 (identifier) + body.length
```

**示例**:
```
数据: [05 00 16 48 00 65 00 00 00]
      ^^^^^ length = 5
           ^^ identifier = 0x16 (CTOS_CHAT)
              ^^^^^^^^^^^^^ body (5-1=4 bytes)
```

## 性能提示

### ✅ 好的做法

```typescript
// 1. 重用对象
const protocol = new YGOProCtosChat();
for (const msg of messages) {
  protocol.msg = msg;
  send(protocol.toFullPayload());
}

// 2. 使用 try-catch
try {
  protocol.fromFullPayload(data);
} catch (error) {
  handleError(error);
}

// 3. 验证长度
if (data.length >= 3) {
  protocol.fromFullPayload(data);
}
```

### ❌ 避免的做法

```typescript
// 1. 不要每次创建新对象
for (const msg of messages) {
  const protocol = new YGOProCtosChat(); // ❌ 浪费内存
  protocol.msg = msg;
  send(protocol.toFullPayload());
}

// 2. 不要忽略错误
protocol.fromFullPayload(data); // ❌ 没有错误处理

// 3. 不要混用 API
const body = protocol.toPayload(); // ❌
const fullPayload = new Uint8Array(3 + body.length);
// ... 手动构建 header
// 应该直接用 toFullPayload()
```

## 与 Registry 配合

```typescript
import { YGOProCtos } from 'ygopro-msg-encode';

// 方式 1: Registry 自动识别
const fullPayload = receivedData;
const parsed = YGOProCtos.getInstanceFromPayload(fullPayload);

if (parsed instanceof YGOProCtosChat) {
  console.log('Chat:', parsed.msg);
}

// 方式 2: 直接解析
const chat = new YGOProCtosChat();
chat.fromFullPayload(fullPayload);
console.log('Chat:', chat.msg);
```

## 类型判断

```typescript
// 检查 identifier
const identifier = data[2];
switch (identifier) {
  case 0x16: // CTOS_CHAT
    const chat = new YGOProCtosChat();
    chat.fromFullPayload(data);
    break;
  case 0x10: // CTOS_PLAYER_INFO
    const playerInfo = new YGOProCtosPlayerInfo();
    playerInfo.fromFullPayload(data);
    break;
}

// 或使用 Registry
const parsed = YGOProCtos.getInstanceFromPayload(data);
if (parsed) {
  console.log('Parsed:', parsed.constructor.name);
}
```

## 调试技巧

```typescript
// 1. 查看完整数据包
const fullPayload = protocol.toFullPayload();
console.log('Full payload:', Array.from(fullPayload).map(b => b.toString(16)));

// 2. 解析 header
const length = fullPayload[0] | (fullPayload[1] << 8);
const identifier = fullPayload[2];
console.log('Length:', length, 'Identifier:', `0x${identifier.toString(16)}`);

// 3. 验证往返
const original = new YGOProCtosChat();
original.msg = "test";
const fullPayload = original.toFullPayload();
const parsed = new YGOProCtosChat();
parsed.fromFullPayload(fullPayload);
console.log('Match:', original.msg === parsed.msg);
```

## 所有支持的协议

### CTOS (19 个)
✅ 所有 CTOS 协议都支持 `toFullPayload()` / `fromFullPayload()`

- CTOS_RESPONSE (0x01)
- CTOS_UPDATE_DECK (0x02)
- CTOS_HAND_RESULT (0x03)
- CTOS_TP_RESULT (0x04)
- CTOS_PLAYER_INFO (0x10)
- CTOS_CREATE_GAME (0x11)
- CTOS_JOIN_GAME (0x12)
- CTOS_LEAVE_GAME (0x13)
- CTOS_SURRENDER (0x14)
- CTOS_TIME_CONFIRM (0x15)
- CTOS_CHAT (0x16)
- CTOS_EXTERNAL_ADDRESS (0x17)
- ... 以及其他 CTOS 协议

### STOC (24 个)
✅ 所有 STOC 协议都支持 `toFullPayload()` / `fromFullPayload()`

- STOC_GAME_MSG (0x01)
- STOC_ERROR_MSG (0x02)
- STOC_SELECT_HAND (0x03)
- STOC_SELECT_TP (0x04)
- STOC_HAND_RESULT (0x05)
- STOC_CHAT (0x19)
- STOC_SRVPRO_ROOMLIST (0x31)
- ... 以及其他 STOC 协议

## 常见问题 FAQ

### Q: 什么时候用 `toPayload()` vs `toFullPayload()`?

**A**: 
- `toPayload()`: 只需要 body（例如与 Registry 配合）
- `toFullPayload()`: 需要完整数据包（例如直接发送到网络）

### Q: 可以修改 identifier 吗?

**A**: 不行，identifier 是类的静态属性，每个协议类都有固定的 identifier。

### Q: 为什么会自动截断数据?

**A**: 网络传输可能会附带额外数据（例如多个数据包粘在一起）。`fromFullPayload()` 会根据声明的 length 自动截断，确保只解析当前协议的数据。

### Q: 向后兼容吗?

**A**: 是的！100% 向后兼容。原有的 `toPayload()` / `fromPayload()` 方法不受影响。

---

**需要更多帮助?** 查看完整文档:
- `FULL_PAYLOAD_UPDATE.md` - 详细实现文档
- `CTOS_STOC_IMPLEMENTATION.md` - 协议实现说明
