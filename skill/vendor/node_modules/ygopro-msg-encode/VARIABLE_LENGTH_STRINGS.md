# 可变长度字符串协议实现说明

## 概述

以下三个协议使用了自定义的可变长度 UTF-16 字符串实现：
1. `CTOS_CHAT` (0x16)
2. `STOC_CHAT` (0x19)
3. `CTOS_EXTERNAL_ADDRESS` (0x17)

## 实现原则

### 序列化（toPayload）
- ✅ 只发送实际内容的字节数，不填充到最大长度
- ✅ 在字符串末尾添加一个 UTF-16 null terminator (`\0\0`, 即 2 字节的 0)
- ✅ 对于有前缀字段的协议（如 player_type, real_ip），先写入前缀字段

### 反序列化（fromPayload）
- ✅ 解析所有可用字节
- ✅ 不要求末尾必须有 `\0\0`
- ✅ 自动移除末尾的所有 null 字符
- ✅ 对于有前缀字段的协议，先读取前缀字段，然后解析剩余字节为字符串

## 协议详情

### 1. CTOS_CHAT (0x16)

**格式**: `[UTF-16LE 字符串]`

```typescript
export class YGOProCtosChat extends YGOProCtosBase {
  static identifier = 0x16;
  msg: string;
}
```

**序列化示例**:
- 原始消息: `"Hello"` (5 个字符)
- 输出: 12 字节 = 5 字符 × 2 + 2 字节 null terminator
- 字节序列: `[0x48, 0x00, 0x65, 0x00, 0x6C, 0x00, 0x6C, 0x00, 0x6F, 0x00, 0x00, 0x00]`

**反序列化**:
- 接受任意长度的 UTF-16LE 编码字节
- 自动移除末尾的 null 字符

### 2. STOC_CHAT (0x19)

**格式**: `[player_type 2 bytes][UTF-16LE 字符串]`

```typescript
export class YGOProStocChat extends YGOProStocBase {
  static identifier = 0x19;
  player_type: number;  // uint16_t
  msg: string;
}
```

**序列化示例**:
- player_type: `0x0010` (Observer + Player 0)
- 原始消息: `"GG"` (2 个字符)
- 输出: 8 字节 = 2 (player_type) + 2 字符 × 2 + 2 字节 null terminator
- 字节序列: `[0x10, 0x00, 0x47, 0x00, 0x47, 0x00, 0x00, 0x00]`

**反序列化**:
- 前 2 字节: player_type (little endian)
- 剩余字节: UTF-16LE 字符串（自动移除末尾 null）

### 3. CTOS_EXTERNAL_ADDRESS (0x17)

**格式**: `[real_ip 4 bytes][UTF-16LE 字符串]`

```typescript
export class YGOProCtosExternalAddress extends YGOProCtosBase {
  static identifier = 0x17;
  real_ip: string;      // IPv4 address as string (e.g., "127.0.0.1")
  hostname: string;
}
```

**序列化示例**:
- real_ip: `"127.0.0.1"` (自动转换为网络序 0x7F000001)
- 原始主机名: `"example.com"` (11 个字符)
- 输出: 28 字节 = 4 (real_ip) + 11 字符 × 2 + 2 字节 null terminator
- 字节序列: `[0x7F, 0x00, 0x00, 0x01, 0x65, 0x00, 0x78, 0x00, ...]`
  - 注意：real_ip 使用**大端序（网络序）**

**反序列化**:
- 前 4 字节: real_ip (big endian / network byte order，自动转换为字符串)
- 剩余字节: UTF-16LE 字符串（自动移除末尾 null）

**IPv6 映射支持**:
- 输入: `"::ffff:127.0.0.1"` → 自动提取为 `"127.0.0.1"`
- 序列化时转换为标准 IPv4 格式

## 优势

### 节省带宽
- ❌ 固定长度方式: CTOS_CHAT 总是发送 512 字节 (256 × 2)
- ✅ 可变长度方式: "Hello" 只需 12 字节

### 兼容性
- ✅ 始终添加 null terminator，确保 C/C++ 字符串兼容
- ✅ 解析时不要求 null terminator，适应各种数据源
- ✅ 自动处理末尾 null 字符，避免显示问题

## 对比表

| 特性 | 固定长度实现 | 可变长度实现 |
|------|--------------|--------------|
| CTOS_CHAT 大小 | 512 bytes | 实际内容 × 2 + 2 |
| STOC_CHAT 大小 | 514 bytes | 2 + 实际内容 × 2 + 2 |
| EXTERNAL_ADDRESS 大小 | 516 bytes | 4 + 实际内容 × 2 + 2 |
| real_ip 类型 | uint32_t | string (IPv4) |
| real_ip 示例 | 0x7F000001 | "127.0.0.1" |
| 带宽效率 | 低 | 高 |
| Null terminator | 可选 | 始终添加 |
| 解析灵活性 | 低 | 高 |

## 测试

运行测试脚本验证实现：

```bash
npx tsx test-chat-protocols.ts
```

测试内容：
- ✅ CTOS_CHAT 序列化和反序列化
- ✅ STOC_CHAT 序列化和反序列化
- ✅ CTOS_EXTERNAL_ADDRESS 序列化和反序列化
- ✅ 无 null terminator 的数据解析
- ✅ 验证 null terminator 的存在
- ✅ 验证前缀字段正确编码

## 实现细节

### UTF-16LE 编码

使用 JavaScript 的 `TextDecoder` 和手动编码：

```typescript
// 编码
const utf16 = new Uint16Array(text.length + 1);
for (let i = 0; i < text.length; i++) {
  utf16[i] = text.charCodeAt(i);
}
utf16[text.length] = 0; // null terminator
const bytes = new Uint8Array(utf16.buffer);

// 解码
const decoder = new TextDecoder('utf-16le');
const text = decoder.decode(data).replace(/\0+$/, '');
```

### 字节序（Byte Order）

**Little Endian** - 用于 player_type：

```typescript
// 写入 uint16_t (little endian)
result[0] = value & 0xff;
result[1] = (value >> 8) & 0xff;
```

**Big Endian (Network Byte Order)** - 用于 real_ip：

```typescript
// 写入 uint32_t (big endian / network byte order)
result[0] = (value >> 24) & 0xff;
result[1] = (value >> 16) & 0xff;
result[2] = (value >> 8) & 0xff;
result[3] = value & 0xff;
```

⚠️ **重要**: `real_ip` 字段使用**网络字节序（大端序）**，这是 IPv4 地址的标准格式。

### IPv4 字符串转换

`CTOS_EXTERNAL_ADDRESS` 的 `real_ip` 字段使用字符串格式，自动处理转换：

```typescript
// IPv4 string to uint32 (network byte order)
private ipToUint32(ip: string): number {
  // Handle IPv6-mapped IPv4: "::ffff:127.0.0.1" -> "127.0.0.1"
  let ipv4 = ip.startsWith('::ffff:') ? ip.substring(7) : ip;
  
  const parts = ipv4.split('.');
  const bytes = parts.map(p => parseInt(p, 10));
  
  // Network byte order (big endian)
  return (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
}

// uint32 to IPv4 string
private uint32ToIp(value: number): string {
  const byte1 = (value >>> 24) & 0xff;
  const byte2 = (value >>> 16) & 0xff;
  const byte3 = (value >>> 8) & 0xff;
  const byte4 = value & 0xff;
  return `${byte1}.${byte2}.${byte3}.${byte4}`;
}
```

**使用示例**:
```typescript
const ext = new YGOProCtosExternalAddress();
ext.real_ip = "127.0.0.1";           // 标准 IPv4
ext.real_ip = "::ffff:192.168.1.1";  // IPv6 映射的 IPv4

const payload = ext.toPayload();
// real_ip "127.0.0.1" → bytes [0x7F, 0x00, 0x00, 0x01]
```

## 注意事项

1. **字符编码**: 仅支持 BMP（Basic Multilingual Plane）字符，不支持代理对（Surrogate Pairs）
2. **最大长度**: 虽然是可变长度，但应该避免发送过长的字符串（建议 < 256 字符）
3. **Null terminator**: 序列化时始终添加，但反序列化时不依赖它
4. **空字符串**: 空字符串将被序列化为仅 2 字节的 null terminator
5. **IPv4 格式**: `real_ip` 仅支持 IPv4 地址，IPv6 映射格式会自动提取 IPv4 部分
6. **IP 验证**: 无效的 IP 地址（如 "abc.def"）会被转换为 `0.0.0.0`

## 更新日期

2026-02-02
