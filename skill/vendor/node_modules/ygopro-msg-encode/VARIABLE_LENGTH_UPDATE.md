# 可变长度字符串协议更新

## 更新日期
2026-02-02

## 更新内容

### 修改的协议

将以下三个协议从固定长度实现改为可变长度实现：

1. **CTOS_CHAT** (0x16)
   - 文件: `src/protos/ctos/proto/chat.ts`
   - 从: `@BinaryField('utf16', 0, 256)` 
   - 到: 自定义 `fromPayload` / `toPayload` 实现

2. **STOC_CHAT** (0x19)
   - 文件: `src/protos/stoc/proto/chat.ts`
   - 从: `@BinaryField('utf16', 2, 256)`
   - 到: 自定义实现，先处理 `player_type`，再处理可变长度字符串

3. **CTOS_EXTERNAL_ADDRESS** (0x17)
   - 文件: `src/protos/ctos/proto/external-address.ts`
   - 从: `@BinaryField('utf16', 4, 256)`
   - 到: 自定义实现，先处理 `real_ip`，再处理可变长度字符串

## 实现特性

### 序列化（toPayload）
```typescript
// 1. 将字符串转换为 UTF-16LE
// 2. 在末尾添加 null terminator (\0\0)
// 3. 只发送实际内容长度，不填充到最大长度

// 示例："Hello" → 12 bytes (不是 512 bytes)
```

### 反序列化（fromPayload）
```typescript
// 1. 读取所有可用字节
// 2. 使用 TextDecoder('utf-16le') 解码
// 3. 移除末尾的所有 null 字符
// 4. 不要求末尾必须有 \0\0
```

## 带宽优化

| 协议 | 固定长度 | 可变长度 (示例) | 节省 |
|------|----------|-----------------|------|
| CTOS_CHAT | 512 bytes | ~10-30 bytes | ~95% |
| STOC_CHAT | 514 bytes | ~10-30 bytes | ~95% |
| CTOS_EXTERNAL_ADDRESS | 516 bytes | ~20-50 bytes | ~90% |

**实际示例**:
- "Hello": 12 bytes vs 512 bytes (节省 97.7%)
- "GG": 8 bytes vs 512 bytes (节省 98.4%)
- "example.com": 28 bytes vs 516 bytes (节省 94.6%)

## 代码对比

### 之前 (固定长度)
```typescript
export class YGOProCtosChat extends YGOProCtosBase {
  static identifier = 0x16;
  
  @BinaryField('utf16', 0, 256)
  msg: string;
}
```
- 总是序列化 512 字节
- 浪费带宽
- 简单但低效

### 之后 (可变长度)
```typescript
export class YGOProCtosChat extends YGOProCtosBase {
  static identifier = 0x16;
  msg: string;
  
  fromPayload(data: Uint8Array): this {
    const decoder = new TextDecoder('utf-16le');
    this.msg = decoder.decode(data).replace(/\0+$/, '');
    return this;
  }
  
  toPayload(): Uint8Array {
    // 编码为 UTF-16LE + null terminator
    const utf16 = new Uint16Array(text.length + 1);
    for (let i = 0; i < text.length; i++) {
      utf16[i] = text.charCodeAt(i);
    }
    utf16[text.length] = 0; // null terminator
    return new Uint8Array(utf16.buffer);
  }
}
```
- 只序列化实际内容
- 高效利用带宽
- 自定义但灵活

## 兼容性

### ✅ 向前兼容
- 始终添加 null terminator，确保 C/C++ 代码可以正确读取
- UTF-16LE 编码与原有实现一致

### ✅ 向后兼容
- 解析时不要求 null terminator，可以处理各种格式
- 自动移除末尾 null 字符，避免显示问题

### ✅ 多语言支持
- UTF-16LE 编码支持所有 Unicode BMP 字符
- 中文、日文、韩文等多语言无问题

## 测试

### 测试脚本
`test-chat-protocols.ts` 包含以下测试：

1. **CTOS_CHAT 测试**
   - 序列化 "Hello World!"
   - 验证 null terminator 存在
   - 反序列化并验证内容

2. **STOC_CHAT 测试**
   - 序列化 player_type + "GG!"
   - 验证 player_type 正确编码
   - 验证 null terminator 存在
   - 反序列化并验证内容

3. **CTOS_EXTERNAL_ADDRESS 测试**
   - 序列化 real_ip + "example.com"
   - 验证 real_ip 正确编码
   - 验证 null terminator 存在
   - 反序列化并验证内容

4. **无 null terminator 测试**
   - 验证可以解析不带 null terminator 的数据
   - 确保向后兼容

### 运行测试
```bash
npx tsx test-chat-protocols.ts
```

## 构建结果

```
✅ 编译成功
✅ 无 linter 错误
✅ 无 TypeScript 错误

文件大小:
- dist/index.cjs: 154.6kb
- dist/index.mjs: 144.4kb
```

## 影响范围

### 修改的文件
- `src/protos/ctos/proto/chat.ts` ✏️
- `src/protos/stoc/proto/chat.ts` ✏️
- `src/protos/ctos/proto/external-address.ts` ✏️

### 新增的文件
- `test-chat-protocols.ts` ✨
- `VARIABLE_LENGTH_STRINGS.md` 📄
- `VARIABLE_LENGTH_UPDATE.md` 📄 (本文件)

### 更新的文件
- `FINAL_SUMMARY.md` 📝

## 技术细节

### UTF-16LE 编码
```typescript
// 手动编码（避免依赖 TextEncoder 的 UTF-16 支持）
const utf16 = new Uint16Array(text.length + 1);
for (let i = 0; i < text.length; i++) {
  utf16[i] = text.charCodeAt(i);
}
utf16[text.length] = 0; // null terminator
const bytes = new Uint8Array(utf16.buffer);
```

### 多字节字段编码
```typescript
// Little Endian
result[0] = value & 0xff;
result[1] = (value >> 8) & 0xff;
result[2] = (value >> 16) & 0xff;
result[3] = (value >> 24) & 0xff;
```

### 解码
```typescript
// 使用浏览器/Node.js 内置 API
const decoder = new TextDecoder('utf-16le');
const text = decoder.decode(data).replace(/\0+$/, '');
```

## 性能影响

### ✅ 优化
- 减少网络传输字节数（节省 90-98%）
- 减少内存占用
- 更快的序列化/反序列化（处理的字节更少）

### ⚠️ 注意
- 自定义实现稍微增加了代码复杂度
- 需要手动处理字符串编码（不使用装饰器）

## 未来改进

可能的未来改进方向：

1. 支持 UTF-8 编码（更节省带宽）
2. 支持代理对（Surrogate Pairs）处理 Unicode 扩展字符
3. 添加最大长度限制检查
4. 性能优化（缓存编码器）

## 总结

✅ **成功将三个协议改为可变长度实现**  
✅ **大幅减少网络带宽使用（节省 90-98%）**  
✅ **保持完全兼容性（向前和向后）**  
✅ **所有测试通过，构建成功**  

这次更新显著提升了这三个协议的效率，特别是在频繁发送聊天消息的场景下。
