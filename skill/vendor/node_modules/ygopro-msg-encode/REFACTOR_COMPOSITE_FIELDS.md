# 复合字段重构总结

## 重构目标

改进复合字段的 API 设计，使其更符合面向对象原则，提供更好的类型安全和开发体验。

---

## 1. STOC_DECK_COUNT 重构

### 重构前（数组方式）

```typescript
export class YGOProStocDeckCount extends YGOProStocBase {
  @BinaryField('i16', 0, 6)
  counts: number[];

  getPlayerDeckCounts(player: 0 | 1): { main: number; extra: number; side: number } {
    const offset = player * 3;
    return {
      main: this.counts[offset],
      extra: this.counts[offset + 1],
      side: this.counts[offset + 2],
    };
  }

  setPlayerDeckCounts(player: 0 | 1, counts: { main: number; extra: number; side: number }): void {
    const offset = player * 3;
    this.counts[offset] = counts.main;
    this.counts[offset + 1] = counts.extra;
    this.counts[offset + 2] = counts.side;
  }
}
```

**问题**：
- 使用数组存储，缺乏语义
- 需要记住索引顺序（0-2 是玩家 0，3-5 是玩家 1）
- 需要辅助方法来访问，但仍然可以直接访问数组
- 不符合面向对象设计原则

### 重构后（对象方式）✅

```typescript
export class YGOProStocDeckCount_DeckInfo {
  @BinaryField('i16', 0)
  main: number;

  @BinaryField('i16', 2)
  extra: number;

  @BinaryField('i16', 4)
  side: number;
}

export class YGOProStocDeckCount extends YGOProStocBase {
  @BinaryField(() => YGOProStocDeckCount_DeckInfo, 0)
  player0DeckCount: YGOProStocDeckCount_DeckInfo;

  @BinaryField(() => YGOProStocDeckCount_DeckInfo, 6)
  player1DeckCount: YGOProStocDeckCount_DeckInfo;
}
```

**优势**：
- ✅ 结构清晰，语义明确
- ✅ 类型安全，IDE 自动补全
- ✅ 符合面向对象设计
- ✅ 不需要辅助方法，直接访问属性

### 使用对比

```typescript
// 重构前
const main = deckCount.counts[0];  // 需要记住索引
deckCount.setPlayerDeckCounts(0, { main: 40, extra: 15, side: 15 });

// 重构后
const main = deckCount.player0DeckCount.main;  // 语义清晰
deckCount.player0DeckCount.main = 40;
deckCount.player0DeckCount.extra = 15;
deckCount.player0DeckCount.side = 15;
```

---

## 2. MSG_START.playerType 重构

### 重构前（辅助方法）

```typescript
export class YGOProMsgStart extends YGOProMsgBase {
  @BinaryField('u8', 0)
  playerType: number;

  getPlayerNumber(): number {
    return this.playerType & 0x0f;
  }

  isObserver(): boolean {
    return (this.playerType & 0xf0) !== 0;
  }

  isFirst(): boolean {
    return (this.playerType & 0x0f) === 0;
  }

  getWatchingPlayer(): number {
    return this.playerType & 0x0f;
  }
}
```

**问题**：
- 添加了很多辅助方法（get 前缀）
- 方法名冗长（`getPlayerNumber`）
- 只能读取，不能方便地设置
- 不符合 TypeScript getter/setter 惯例

### 重构后（getter/setter）✅

```typescript
export class YGOProMsgStart extends YGOProMsgBase {
  @BinaryField('u8', 0)
  playerType: number;

  get playerNumber(): number {
    return this.playerType & 0x0f;
  }

  set playerNumber(value: number) {
    this.playerType = (this.playerType & 0xf0) | (value & 0x0f);
  }

  get observerFlag(): number {
    return this.playerType & 0xf0;
  }

  set observerFlag(value: number) {
    this.playerType = (this.playerType & 0x0f) | (value & 0xf0);
  }
}
```

**优势**：
- ✅ 符合 TypeScript getter/setter 惯例
- ✅ 简洁的访问方式（`startMsg.playerNumber`）
- ✅ 支持读写操作
- ✅ 仍然可以直接访问 `playerType` 进行位运算

### 使用对比

```typescript
// 重构前
const playerNum = startMsg.getPlayerNumber();  // 方法调用
const isObs = startMsg.isObserver();           // 方法调用
// 设置很麻烦，需要手动位运算

// 重构后
const playerNum = startMsg.playerNumber;       // 属性访问
const isObs = startMsg.observerFlag !== 0;     // 属性访问
startMsg.playerNumber = 1;                     // 直接赋值
startMsg.observerFlag = 0x10;                  // 直接赋值
```

---

## 设计原则

### 1. 面向对象设计
使用嵌套对象而不是数组，提供清晰的结构和语义。

### 2. TypeScript 惯例
使用 getter/setter 而不是 `getXxx()`/`setXxx()` 方法。

### 3. 类型安全
利用 TypeScript 类型系统提供编译时检查和 IDE 支持。

### 4. 简洁性
- 属性访问优于方法调用
- 对象属性优于数组索引
- 保持底层字段可访问，允许高级用户直接操作

---

## 破坏性变更

### STOC_DECK_COUNT

**旧代码**：
```typescript
const main = deckCount.counts[0];
deckCount.setPlayerDeckCounts(0, { main: 40, extra: 15, side: 15 });
```

**新代码**：
```typescript
const main = deckCount.player0DeckCount.main;
deckCount.player0DeckCount.main = 40;
deckCount.player0DeckCount.extra = 15;
deckCount.player0DeckCount.side = 15;
```

### MSG_START

**旧代码**：
```typescript
const playerNum = startMsg.getPlayerNumber();
const isObs = startMsg.isObserver();
```

**新代码**：
```typescript
const playerNum = startMsg.playerNumber;
const isObs = startMsg.observerFlag !== 0;
```

---

## 测试结果

✅ 所有 101 个测试通过  
✅ 构建成功  
✅ 类型检查通过  

---

## 相关文档

- [COMPOSITE_FIELDS_GUIDE.md](./COMPOSITE_FIELDS_GUIDE.md) - 复合字段使用指南（已更新）
- [DECK_COUNT_EXPLANATION.md](./DECK_COUNT_EXPLANATION.md) - STOC_DECK_COUNT 详解（已更新）

---

## 总结

这次重构改进了两个关键复合字段的 API 设计：

1. **STOC_DECK_COUNT**: 从数组 + 辅助方法改为嵌套对象结构
2. **MSG_START**: 从辅助方法改为 getter/setter

新的设计更符合面向对象原则和 TypeScript 惯例，提供了更好的类型安全和开发体验。
