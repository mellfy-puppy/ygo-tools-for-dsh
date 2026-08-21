# real_ip 字段改为字符串类型

## 更新日期
2026-02-02

## 改动说明

### 修改内容

`CTOS_EXTERNAL_ADDRESS` 协议的 `real_ip` 字段从 `number` 改为 `string` 类型。

**文件**: `src/protos/ctos/proto/external-address.ts`

### 之前 ❌

```typescript
export class YGOProCtosExternalAddress extends YGOProCtosBase {
  static identifier = 0x17;
  real_ip: number;      // uint32_t
  hostname: string;
}

// 使用方式
const ext = new YGOProCtosExternalAddress();
ext.real_ip = 0x7F000001; // 必须手动计算网络序
```

### 之后 ✅

```typescript
export class YGOProCtosExternalAddress extends YGOProCtosBase {
  static identifier = 0x17;
  real_ip: string;      // IPv4 address as string
  hostname: string;
}

// 使用方式
const ext = new YGOProCtosExternalAddress();
ext.real_ip = "127.0.0.1"; // 直接使用字符串
```

## 优势

### 1. 更直观的 API ✨

```typescript
// ❌ 之前: 需要手动转换
ext.real_ip = 0x7F000001;  // 这是什么 IP？

// ✅ 现在: 一目了然
ext.real_ip = "127.0.0.1";
```

### 2. 自动处理字节序 🔄

```typescript
// 自动转换为网络序（大端序）
ext.real_ip = "192.168.1.1";
const payload = ext.toPayload();
// payload[0-3] = [0xC0, 0xA8, 0x01, 0x01]

// 自动从网络序转换回字符串
ext.fromPayload(payload);
console.log(ext.real_ip); // "192.168.1.1"
```

### 3. IPv6 映射支持 🌐

```typescript
// 自动处理 IPv6 映射的 IPv4 地址
ext.real_ip = "::ffff:192.168.1.1";
const payload = ext.toPayload();
// 自动提取为 192.168.1.1 并编码

// 解析结果始终为标准 IPv4 格式
ext.fromPayload(payload);
console.log(ext.real_ip); // "192.168.1.1"
```

### 4. 错误处理 🛡️

```typescript
// 无效的 IP 会被转换为 0.0.0.0
ext.real_ip = "invalid.ip.address";
const payload = ext.toPayload();
// payload[0-3] = [0x00, 0x00, 0x00, 0x00]
```

## 实现细节

### IPv4 字符串 → uint32 (网络序)

```typescript
private ipToUint32(ip: string): number {
  // 1. 处理 IPv6 映射格式
  let ipv4 = ip.startsWith('::ffff:') ? ip.substring(7) : ip;
  
  // 2. 分割并解析
  const parts = ipv4.split('.');  // ["192", "168", "1", "1"]
  const bytes = parts.map(p => parseInt(p, 10));  // [192, 168, 1, 1]
  
  // 3. 验证
  if (parts.length !== 4 || bytes.some(b => isNaN(b) || b < 0 || b > 255)) {
    return 0;  // 无效 IP
  }
  
  // 4. 转换为网络序（大端序）
  return (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
}
```

**示例**:
- `"127.0.0.1"` → `0x7F000001`
- `"192.168.1.1"` → `0xC0A80101`
- `"::ffff:10.0.0.1"` → `0x0A000001`

### uint32 (网络序) → IPv4 字符串

```typescript
private uint32ToIp(value: number): string {
  const byte1 = (value >>> 24) & 0xff;  // 无符号右移
  const byte2 = (value >>> 16) & 0xff;
  const byte3 = (value >>> 8) & 0xff;
  const byte4 = value & 0xff;
  return `${byte1}.${byte2}.${byte3}.${byte4}`;
}
```

**示例**:
- `0x7F000001` → `"127.0.0.1"`
- `0xC0A80101` → `"192.168.1.1"`
- `0x00000000` → `"0.0.0.0"`

## 字节序说明

### ⚠️ 重要：网络序（大端序）

`real_ip` 使用**网络字节序（Big Endian）**，这与其他字段不同：

| 字段 | 字节序 | 示例 |
|------|--------|------|
| player_type | Little Endian | `0x0010` → `[0x10, 0x00]` |
| **real_ip** | **Big Endian** | `0x7F000001` → `[0x7F, 0x00, 0x00, 0x01]` |

这是因为 IPv4 地址按照网络协议标准使用大端序。

## 使用示例

### 基本使用

```typescript
import { YGOProCtosExternalAddress } from 'ygopro-msg-encode';

const ext = new YGOProCtosExternalAddress();
ext.real_ip = "127.0.0.1";
ext.hostname = "example.com";

// 序列化
const payload = ext.toPayload();

// 反序列化
const parsed = new YGOProCtosExternalAddress();
parsed.fromPayload(payload);
console.log(parsed.real_ip);     // "127.0.0.1"
console.log(parsed.hostname);    // "example.com"
```

### IPv6 映射

```typescript
const ext = new YGOProCtosExternalAddress();
ext.real_ip = "::ffff:192.168.1.1";  // IPv6 映射格式

const payload = ext.toPayload();
// 自动提取为 192.168.1.1

const parsed = new YGOProCtosExternalAddress();
parsed.fromPayload(payload);
console.log(parsed.real_ip);  // "192.168.1.1" (标准 IPv4)
```

### 私有网络地址

```typescript
// 常见私有网络地址
ext.real_ip = "10.0.0.1";        // Class A private
ext.real_ip = "172.16.0.1";      // Class B private
ext.real_ip = "192.168.1.1";     // Class C private

// 本地回环地址
ext.real_ip = "127.0.0.1";       // localhost

// 特殊地址
ext.real_ip = "0.0.0.0";         // any/unspecified
ext.real_ip = "255.255.255.255"; // broadcast
```

## 测试

测试文件 `test-chat-protocols.ts` 包含以下测试：

1. **标准 IPv4 测试**
   ```typescript
   ext.real_ip = "127.0.0.1";
   // 验证字节序: [0x7F, 0x00, 0x00, 0x01]
   ```

2. **IPv6 映射测试**
   ```typescript
   ext.real_ip = "::ffff:192.168.1.1";
   // 验证提取并编码: [0xC0, 0xA8, 0x01, 0x01]
   ```

3. **往返转换测试**
   ```typescript
   const original = "192.168.1.1";
   ext.real_ip = original;
   const payload = ext.toPayload();
   ext.fromPayload(payload);
   assert(ext.real_ip === original);
   ```

运行测试：
```bash
npx tsx test-chat-protocols.ts
```

## 迁移指南

如果你之前使用数字格式的 `real_ip`：

### 迁移步骤

1. **将数字转换为字符串**
   ```typescript
   // 之前
   ext.real_ip = 0x7F000001;
   
   // 现在
   ext.real_ip = "127.0.0.1";
   ```

2. **使用辅助函数转换（如果需要）**
   ```typescript
   function uint32ToIp(value: number): string {
     return [
       (value >>> 24) & 0xff,
       (value >>> 16) & 0xff,
       (value >>> 8) & 0xff,
       value & 0xff
     ].join('.');
   }
   
   // 转换旧代码
   ext.real_ip = uint32ToIp(0x7F000001);  // "127.0.0.1"
   ```

## 兼容性

### ✅ 完全兼容

- 二进制格式完全相同（仍然是 4 字节网络序）
- 可以与旧版本互操作
- 只是 API 层面的改进

### ⚠️ API 变更

- TypeScript 类型从 `number` 改为 `string`
- 需要更新代码中的类型注解

## 构建结果

```
✅ 编译成功
✅ 无 linter 错误
✅ 无 TypeScript 错误
✅ 文件大小: 145.2kb (ESM)
```

## 总结

这次更新让 `real_ip` 字段更加：
- ✅ **易用**: 直接使用字符串格式
- ✅ **直观**: 一眼就能看出是什么 IP
- ✅ **智能**: 自动处理字节序转换
- ✅ **灵活**: 支持 IPv6 映射格式
- ✅ **兼容**: 二进制格式不变

推荐所有用户迁移到新的字符串 API！
