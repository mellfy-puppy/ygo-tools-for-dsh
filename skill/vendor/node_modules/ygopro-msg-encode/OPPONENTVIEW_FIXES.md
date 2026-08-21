# OpponentView 实现修复总结

## 已修复的问题

### 1. MSG_SHUFFLE_EXTRA (shuffle-extra.ts)

**问题**：只遮掩了非公开的卡片（没有 0x80000000 标记的）

**正确实现**：应该全部遮掩，无论是否有公开标记

**对照源码**：`single_duel.cpp` 第 1163-1179 行
```cpp
for (int i = 0; i < count; ++i)
    BufferIO::Write<int32_t>(pbuf, 0);  // 全部遮掩
```

**修复**：
```typescript
// 修复前
view.cards = view.cards.map((card) => {
  if (!(card & 0x80000000)) {
    return 0;
  }
  return card;
});

// 修复后
view.cards = view.cards.map(() => 0);  // 全部遮掩
```

---

### 2. MSG_TAG_SWAP (tag-swap.ts)

**问题**：`handCards` 全部遮掩，但应该只遮掩非公开的（类似 `extraCards`）

**正确实现**：手牌和额外卡组都应该只遮掩没有 0x80000000 标记的卡片

**对照源码**：`tag_duel.cpp` 第 1932-1960 行
```cpp
// 对手牌的处理
for (int i = 0; i < hcount; ++i) {
    if(!(pbufw[3] & 0x80))  // 检查 0x80000000
        BufferIO::Write<int32_t>(pbufw, 0);  // 非公开的遮掩
    else
        pbufw += 4;  // 公开的保留
}
// 对额外卡组的处理（同样逻辑）
for (int i = 0; i < ecount; ++i) {
    if(!(pbufw[3] & 0x80))
        BufferIO::Write<int32_t>(pbufw, 0);
    else
        pbufw += 4;
}
```

**修复**：
```typescript
// 修复前
view.handCards = view.handCards.map(() => 0);  // 全部遮掩

// 修复后
view.handCards = view.handCards.map((card) => {
  if (!(card & 0x80000000)) {
    return 0;  // 只遮掩非公开的
  }
  return card;  // 保留公开的
});
```

---

## 其他修复

### 3. MSG_CONFIRM_DECKTOP / MSG_CONFIRM_EXTRATOP / MSG_DECK_TOP

**问题**：项目中实现了 `opponentView` 遮掩逻辑，但 YGOPro 源码中这些消息不做遮掩

**正确实现**：移除 `opponentView` 方法，使用基类的默认实现（不遮掩）

**对照源码**：`single_duel.cpp` 第 1089-1224 行

这些消息在源码中**直接发给所有人，不做遮掩**：
```cpp
// MSG_CONFIRM_DECKTOP
NetServer::SendBufferToPlayer(players[0], STOC_GAME_MSG, offset, pbuf - offset);
NetServer::ReSendToPlayer(players[1]);  // 直接转发，无遮掩

// MSG_CONFIRM_EXTRATOP (相同处理)
// MSG_DECK_TOP (相同处理)
```

**原因**：ocgcore 在生成这些消息时，已经通过 `0x80000000` 标记控制了哪些内容是公开的。网络层直接转发，不需要额外遮掩。

**修复**：移除了这些消息的 `opponentView` 方法，使用基类的默认实现（直接返回 copy）。

---

## 0x80000000 标记的语义

在 YGOPro 中，`0x80000000` 标记用于表示"公开"状态：

- **有标记**：这张卡是公开的，所有人都能看到
- **无标记**：这张卡是非公开的，需要根据玩家身份决定是否遮掩

**源码示例**（ocgcore/field.cpp）：
```cpp
pduel->write_buffer32(pcard->data.code | (pcard->is_position(POS_FACEUP) ? 0x80000000 : 0));
```

---

## 验证方法

对照 YGOPro 源代码：
- **单人决斗**：`/home/nanahira/ygo/ygopro/gframe/single_duel.cpp`
- **TAG 决斗**：`/home/nanahira/ygo/ygopro/gframe/tag_duel.cpp`
- **核心逻辑**：`/home/nanahira/ygo/ygopro/ocgcore/`

关键函数：
- `RefreshHand()`: 刷新手牌
- `RefreshMzone()`: 刷新怪兽区
- `RefreshSzone()`: 刷新魔陷区
- `RefreshExtra()`: 刷新额外卡组
- `RefreshSingle()`: 刷新单张卡片

---

## 修复日期

2026-02-14
