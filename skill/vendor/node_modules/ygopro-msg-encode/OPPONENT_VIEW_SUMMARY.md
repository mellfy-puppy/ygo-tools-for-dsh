# opponentView 实现总结

本文档总结了所有实现 `opponentView`（对手视角）的 MSG 类及其隐藏逻辑。

## 1. MSG_DRAW (90) - 抽卡

**字段**: `player`, `count`, `cards[]`

**逻辑**: 隐藏未公开的抽卡
```typescript
opponentView(): this {
  const view = this.copy();
  view.cards = view.cards.map((card) => {
    // 如果卡片的高位（0x80000000）未设置，对方看不到，返回 0
    if (!(card & 0x80000000)) {
      return 0;
    }
    return card;
  });
  return view;
}
```

**说明**:
- 卡片代码高位 `0x80000000` 表示该卡是否公开
- 未公开的抽卡对对手显示为 0

---

## 2. MSG_DECK_TOP (38) - 卡组顶部

**字段**: `player`, `sequence`, `code`

**逻辑**: 隐藏未公开的卡组顶部卡片
```typescript
opponentView(): this {
  const view = this.copy();
  if (!(view.code & 0x80000000)) {
    view.code = 0;
  }
  return view;
}
```

**说明**:
- 只有设置了公开标志的卡组顶部卡片对手才能看到
- 未公开的显示为 0

---

## 3. MSG_SHUFFLE_HAND (33) - 洗手牌

**字段**: `player`, `count`, `cards[]`

**逻辑**: 完全隐藏手牌信息
```typescript
opponentView(): this {
  const view = this.copy();
  view.cards = view.cards.map(() => 0);
  return view;
}
```

**说明**:
- 洗手牌时，对手完全看不到任何手牌信息
- 所有卡片都显示为 0

---

## 4. MSG_SHUFFLE_EXTRA (39) - 洗额外卡组

**字段**: `player`, `count`, `cards[]`

**逻辑**: 隐藏未公开的额外卡组卡片
```typescript
opponentView(): this {
  const view = this.copy();
  view.cards = view.cards.map((card) => {
    if (!(card & 0x80000000)) {
      return 0;
    }
    return card;
  });
  return view;
}
```

**说明**:
- 类似 MSG_DRAW，使用 `0x80000000` 标志判断是否公开
- 未公开的额外卡组卡片显示为 0

---

## 5. MSG_TAG_SWAP (161) - TAG 决斗交换

**字段**: `player`, `mzoneCount`, `extraCount`, `pzoneCount`, `handCount`, `handCards[]`, `extraCards[]`, `mzoneFlags`

**逻辑**: 隐藏手牌和未公开的额外卡组
```typescript
opponentView(): this {
  const view = this.copy();
  view.handCards = view.handCards.map(() => 0);
  view.extraCards = view.extraCards.map((card) => {
    if (!(card & 0x80000000)) {
      return 0;
    }
    return card;
  });
  return view;
}

teammateView(): this {
  return this.opponentView(); // 队友也看不到
}
```

**说明**:
- TAG 交换时，手牌完全隐藏
- 额外卡组只显示公开的卡片
- **特殊**: 队友视角和对手视角相同（都看不到）

---

## 6. MSG_CONFIRM_DECKTOP (30) - 确认卡组顶部

**字段**: `player`, `count`, `cards[]` (每张卡包含 `code`, `controller`, `location`, `sequence`)

**逻辑**: 隐藏未公开的卡片代码
```typescript
opponentView(): this {
  const view = this.copy();
  view.cards = view.cards.map((card) => {
    const c = { ...card };
    if (!(c.code & 0x80000000)) {
      c.code = 0;
    }
    return c;
  });
  return view;
}
```

**说明**:
- 保留卡片位置信息（controller, location, sequence）
- 只隐藏未公开的卡片代码

---

## 7. MSG_CONFIRM_EXTRATOP (42) - 确认额外卡组顶部

**字段**: `player`, `count`, `cards[]` (每张卡包含 `code`, `controller`, `location`, `sequence`)

**逻辑**: 同 MSG_CONFIRM_DECKTOP
```typescript
opponentView(): this {
  const view = this.copy();
  view.cards = view.cards.map((card) => {
    const c = { ...card };
    if (!(c.code & 0x80000000)) {
      c.code = 0;
    }
    return c;
  });
  return view;
}
```

**说明**:
- 逻辑完全相同于 MSG_CONFIRM_DECKTOP
- 只是针对额外卡组

---

## 8. MSG_CONFIRM_CARDS (31) - 确认卡片

**字段**: `player`, `unused`, `count`, `cards[]` (每张卡包含 `code`, `controller`, `location`, `sequence`, `subsequence`)

**逻辑**: 同 MSG_CONFIRM_DECKTOP
```typescript
opponentView(): this {
  const view = this.copy();
  view.cards = view.cards.map((card) => {
    const c = { ...card };
    if (!(c.code & 0x80000000)) {
      c.code = 0;
    }
    return c;
  });
  return view;
}
```

**说明**:
- 逻辑完全相同于 MSG_CONFIRM_DECKTOP
- 可以确认任意位置的卡片

---

## 9. MSG_UPDATE_CARD (7) - 更新单张卡片信息

**字段**: `controller`, `location`, `sequence`, `card: CardQuery`

**逻辑**: 隐藏盖放卡片的详细信息
```typescript
opponentView(): this {
  const copy = this.copy();
  // 如果卡片是盖放的，清除查询数据（只保留 flags = QUERY_CODE，code = 0）
  if (copy.card?.position && (copy.card.position & POS_FACEDOWN)) {
    const clearedCard = new CardQuery();
    clearedCard.flags = QUERY_CODE;
    clearedCard.code = 0;
    clearedCard.empty = false;
    copy.card = clearedCard;
  }
  return copy;
}

teammateView(): this {
  // TAG 决斗中，队友的视角规则：
  // - 场上卡片 (LOCATION_ONFIELD)：队友可以看到己方盖放的卡片
  // - 其他位置：和对手视角相同
  if (this.location & LOCATION_ONFIELD) {
    return this.copy();
  } else {
    return this.opponentView();
  }
}

playerView(playerId: number): this {
  // 特殊实现：使用 controller 字段判断
  if (this.controller === playerId) {
    return this.copy();
  }
  return this.opponentView();
}
```

**说明**:
- 根据卡片的 `position` 字段判断是否盖放（POS_FACEDOWN）
- 盖放的卡片只保留最基本的信息（flags 和 code = 0）
- **队友视角**: 场上盖放可见，非场上盖放隐藏
- **特殊**: 需要重写 playerView，因为字段名是 `controller` 不是 `player`

---

## 10. MSG_UPDATE_DATA (6) - 更新区域所有卡片信息

**字段**: `player`, `location`, `cards: CardQuery[]`

**逻辑**: 隐藏盖放卡片的详细信息
```typescript
opponentView(): this {
  const copy = this.copy();
  if (copy.cards) {
    copy.cards = copy.cards.map((card) => {
      if (card.position && (card.position & POS_FACEDOWN)) {
        // 盖放的卡片，清除所有查询数据
        const clearedCard = new CardQuery();
        clearedCard.flags = 0;
        clearedCard.empty = true;
        return clearedCard;
      }
      return card;
    });
  }
  return copy;
}

teammateView(): this {
  // TAG 决斗中，队友的视角规则：
  // - MZONE/SZONE：队友可以看到己方盖放的卡片
  // - HAND：队友也看不到非公开的手牌
  // - 其他公开区域：队友可以看到
  
  if (this.location === LOCATION_MZONE || this.location === LOCATION_SZONE) {
    return this.copy(); // 场上盖放可见
  } else if (this.location === LOCATION_HAND) {
    // 手牌：只有公开的才能看到
    const copy = this.copy();
    if (copy.cards) {
      copy.cards = copy.cards.map((card) => {
        if (!card.position || !(card.position & POS_FACEUP)) {
          const clearedCard = new CardQuery();
          clearedCard.flags = 0;
          clearedCard.empty = true;
          return clearedCard;
        }
        return card;
      });
    }
    return copy;
  } else {
    return this.copy(); // 其他区域可见
  }
}
```

**说明**:
- 对手视角：所有盖放的卡片都清除为空数据
- **队友视角（复杂）**:
  - MZONE/SZONE（场上）：可以看到盖放的卡片
  - HAND（手牌）：只能看到公开的手牌
  - 其他区域（墓地、除外等）：通常都能看到

---

## 隐藏逻辑分类

### 1. 完全隐藏（显示为 0）
- MSG_SHUFFLE_HAND - 所有手牌
- MSG_TAG_SWAP - 所有手牌

### 2. 条件隐藏（0x80000000 标志位）
- MSG_DRAW - 未公开的抽卡
- MSG_DECK_TOP - 未公开的卡组顶部
- MSG_SHUFFLE_EXTRA - 未公开的额外卡组
- MSG_TAG_SWAP - 未公开的额外卡组
- MSG_CONFIRM_DECKTOP - 未公开的卡片代码
- MSG_CONFIRM_EXTRATOP - 未公开的卡片代码
- MSG_CONFIRM_CARDS - 未公开的卡片代码

### 3. 位置状态隐藏（POS_FACEDOWN）
- MSG_UPDATE_CARD - 盖放的卡片
- MSG_UPDATE_DATA - 盖放的卡片

---

## TAG 决斗队友视角特殊规则

### 完全隐藏（队友也看不到）
- MSG_TAG_SWAP - 手牌和未公开额外卡组

### 条件可见（根据位置和状态）
- MSG_UPDATE_CARD:
  - ✅ 场上盖放卡片可见
  - ❌ 非场上盖放卡片隐藏

- MSG_UPDATE_DATA:
  - ✅ MZONE/SZONE 盖放卡片可见
  - ❌ HAND 非公开手牌隐藏
  - ✅ GRAVE/REMOVED 等区域可见

---

## playerView 特殊实现

### 基类默认实现
检查 `this['player']` 字段，匹配则返回完整数据，否则返回 opponentView()

### 需要重写的 MSG
- **MSG_UPDATE_CARD**: 字段名是 `controller` 而非 `player`，需要重写判断逻辑

---

## 公开标志位说明

### 0x80000000 - 公开标志
- 设置：卡片对所有人可见（包括对手）
- 未设置：卡片仅对控制者可见

### POS_FACEDOWN (位置标志)
- POS_FACEDOWN = 10 (0x0A)
- POS_FACEDOWN_ATTACK = 2
- POS_FACEDOWN_DEFENSE = 8
- 用于判断卡片是否盖放

### POS_FACEUP (位置标志)
- POS_FACEUP = 5
- POS_FACEUP_ATTACK = 1
- POS_FACEUP_DEFENSE = 4
- 用于判断卡片是否表侧

---

## 总结

共有 **10 个 MSG 类**实现了 opponentView：

1. **简单隐藏类**（4 个）: DRAW, DECK_TOP, SHUFFLE_HAND, SHUFFLE_EXTRA
2. **确认类**（3 个）: CONFIRM_DECKTOP, CONFIRM_EXTRATOP, CONFIRM_CARDS
3. **TAG 决斗类**（1 个）: TAG_SWAP
4. **查询数据类**（2 个）: UPDATE_CARD, UPDATE_DATA

其中，**UPDATE_CARD** 和 **UPDATE_DATA** 的实现最为复杂，包含：
- opponentView: 隐藏盖放卡片
- teammateView: 根据位置区分队友可见性
- playerView: 根据控制者/玩家 ID 判断
