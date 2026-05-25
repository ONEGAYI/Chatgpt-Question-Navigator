# Assistant Anchor 即时采集 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在普通自动扫描路径中即时创建 assistant anchor，使 visibleRange 和 progressive jump 在长 AI 回复区域能正确工作。

**Architecture:** 将 MessageScanner.rescan() 从 user-only 扫描扩展为 turn-level 扫描，通过 DomAdapter 已有的 turn 检测方法识别角色，创建带 role 的通用 candidate，CacheStore 不再硬编码 role。assistant 作为隐藏锚点参与 visibleRange 但不显示在 UI。orderKey 通过 turnIndex 正确排序，确保中间插入的 assistant anchor 不会破坏空间方向判断。P0 使用稳定 fallback hash，不写流式文本；已有 assistant 文本不会被 placeholder 覆盖。

**Tech Stack:** TypeScript, Preact, WXT (Manifest V3), Shadow DOM

---

## Context

当前普通扫描路径 `MessageScanner.rescan()` 只调用 `findUserMessages()`，日常浏览/新对话场景只记录用户提问，不记录 AI 回复。这导致 visibleRange 在长 AI 回复区域返回 null，progressive jump 无法判断方向。

AutoCollector 全量采集路径已能处理 assistant turn，但那是手动触发的重量级操作。本次改造让普通轻量扫描也能即时创建 assistant anchor。

---

## Priority

### P0（本计划必须完成）
- MessageScanner turn-level 扫描
- candidate 支持 role（重命名为 ScannedMessageCandidate）
- CacheStore 使用 candidate.role
- assistant anchor 立即创建，P0 使用稳定 fallback hash，不写流式文本
- 已有 assistant 文本不被 placeholder 覆盖
- assistant element 注册到 elementById/mountedIds
- orderKey 对 user+assistant 内部序列保持正确（基于 turnIndex 排序）
- AutoCollector 写入 turnKey/turnIndex
- hasMeaningfulChange 比较新增元数据
- normalizeCache 从旧 localMessageId 补 turnKey/turnIndex + 重排
- UI 继续只显示 user

### P1（后续 PR）
- assistant 文本稳定后懒更新（preview/textForSearch）
- streaming/stable 状态管理
- 更完整测试

---

## File Structure

**实际文件名全部为小驼峰，计划中所有路径必须与之一致。**

| File | Change | Responsibility |
|------|--------|----------------|
| `src/shared/types.ts` | Modify | 重命名 ScannedUserMessageCandidate → ScannedMessageCandidate，增加 role/turnIndex；CachedMessage 增加 turnKey/turnIndex |
| `src/content/domAdapter.ts` | Modify | 新增 `findRoleElementInTurn()`、`extractTurnText()` |
| `src/content/messageScanner.ts` | Modify | rescan() 从 user-only 改为 turn-level 扫描；P0 assistant 只写稳定 hash，不写流式文本 |
| `src/content/orderList.ts` | Modify | 新增泛型 reorderAndRekeyByTurnIndex helper（不依赖 CachedMessage） |
| `src/content/cacheStore.ts` | Modify | resolveScannedSegments 使用 candidate.role；matchCandidate hash 匹配加 role 限制；hasMeaningfulChange 增加字段比较；normalizeCache 旧缓存迁移 + 重排 |
| `src/content/autoCollector.ts` | Modify | buildAllMessages() 写入 turnKey/turnIndex（最小补充，不改采集流程） |

**不需要修改的文件（已正确隔离）：**
- `src/ui/Sidebar.tsx` — 已有 `role === 'user'` 过滤
- `src/ui/MiniBar.tsx` — 已接收 pre-filtered user messages
- `src/content/runtimeStore.ts` — 纯状态容器，无 role 过滤
- `src/content/jumpController.ts` — role 无关，仅用 orderKey

---

### Task 1: 类型重命名和扩展

**Files:**
- Modify: `src/shared/types.ts`

- [ ] **Step 1: 重命名 ScannedUserMessageCandidate → ScannedMessageCandidate，增加 role 和 turnIndex**

```typescript
export interface ScannedMessageCandidate {
  observedDomMessageId: string | null;
  text: string;
  textHash: string;
  preview: string;
  textForSearch: string;
  scrollRatio: number;
  scrollTop: number;
  absoluteTop: number;
  element: HTMLElement;
  turnKey: string | null;
  role: 'user' | 'assistant';
  turnIndex: number;
}

/** @deprecated 使用 ScannedMessageCandidate */
export type ScannedUserMessageCandidate = ScannedMessageCandidate;
```

保留别名避免一次性修改所有引用点。

- [ ] **Step 2: 在 CachedMessage 中增加 turnKey 和 turnIndex 可选字段**

```typescript
export interface CachedMessage {
  conversationId: string;
  localMessageId: string;
  role: 'user' | 'assistant';
  textForSearch: string;
  preview: string;
  textHash: string;
  occurrenceIndex: number;
  firstSeenAt: number;
  lastSeenAt: number;
  lastKnownScrollTop: number;
  lastKnownScrollRatio: number;
  orderKey: number;
  turnKey?: string;
  turnIndex?: number;
}
```

- [ ] **Step 3: 运行类型检查确认**

Run: `pnpm compile`
Expected: 可能有类型错误（缺少 role/turnIndex 等），将在后续 Task 修复。

---

### Task 2: DomAdapter 增加 turn 级别辅助方法

**Files:**
- Modify: `src/content/domAdapter.ts`

- [ ] **Step 1: 新增 findRoleElementInTurn 方法**

```typescript
findRoleElementInTurn(turnEl: HTMLElement, role: 'user' | 'assistant'): HTMLElement | null {
  return turnEl.querySelector<HTMLElement>(`[data-message-author-role="${role}"]`);
}
```

- [ ] **Step 2: 新增 extractTurnText 方法**

```typescript
extractTurnText(turnEl: HTMLElement, role: 'user' | 'assistant'): string {
  const roleEl = this.findRoleElementInTurn(turnEl, role);
  if (!roleEl) return '';
  return this.extractText(roleEl);
}
```

---

### Task 3: orderList 新增泛型 reorderAndRekeyByTurnIndex

**Files:**
- Modify: `src/content/orderList.ts`

先在 orderList.ts 中新增泛型排序 helper，不引入 CachedMessage 依赖。

- [ ] **Step 1: 新增 hasFiniteTurnIndex 类型守卫和 reorderAndRekeyByTurnIndex 函数**

在 `src/content/orderList.ts` 底部新增：

```typescript
export function hasFiniteTurnIndex<T extends { turnIndex?: number }>(m: T): m is T & { turnIndex: number } {
  return typeof m.turnIndex === 'number' && Number.isFinite(m.turnIndex);
}

/**
 * 对有 turnIndex 的消息按 turnIndex 升序排序，缺失 turnIndex 的保持原相对顺序放末尾。
 * 排序后重新分配连续 orderKey（0, 1, 2, ...）。
 */
export function reorderAndRekeyByTurnIndex<T extends {
  localMessageId: string;
  orderKey: number;
  turnIndex?: number;
}>(messages: T[]): T[] {
  if (messages.length === 0) return messages;
  if (!messages.some(hasFiniteTurnIndex)) return messages;

  const withIndex = messages.filter(hasFiniteTurnIndex)
    .sort((a, b) => a.turnIndex - b.turnIndex);
  const withoutIndex = messages.filter((m) => !hasFiniteTurnIndex(m));

  const sorted = [...withIndex, ...withoutIndex];

  return sorted.map((m, index) => ({
    ...m,
    orderKey: index,
  }));
}
```

使用泛型 `<T>` 而非直接依赖 `CachedMessage`，避免 orderList.ts 与 types.ts 产生不必要的层级耦合。

---

### Task 4: CacheStore 角色传递 + 排序 + 元数据比较 + 旧缓存迁移

**Files:**
- Modify: `src/content/cacheStore.ts`

这是 CacheStore 的闭环改造，包含角色支持、placeholder 保护、排序接入、dirty 检测、旧缓存迁移。

- [ ] **Step 1: 更新导入语句**

在 cacheStore.ts 顶部，将：

```typescript
import { inferDirectionFromScrollAnchor, mergeOrderedSegments, orderMessagesByIds } from './orderList';
```

改为：

```typescript
import { inferDirectionFromScrollAnchor, mergeOrderedSegments, orderMessagesByIds, reorderAndRekeyByTurnIndex } from './orderList';
```

- [ ] **Step 2: resolveScannedSegments — 角色传递 + placeholder 保护 + turnKey/turnIndex + 排序接入**

修改 `resolveScannedSegments` 方法，有三处改动：

**4a. candidate → CachedMessage 构建替换（约第 123-138 行）**

将：

```typescript
const next: CachedMessage = {
  conversationId,
  localMessageId,
  role: 'user',
  textForSearch: candidate.textForSearch,
  preview: candidate.preview,
  textHash: candidate.textHash,
  occurrenceIndex,
  firstSeenAt: matched?.firstSeenAt ?? now,
  lastSeenAt: now,
  lastKnownScrollTop: candidate.scrollTop,
  lastKnownScrollRatio: candidate.scrollRatio,
  orderKey: matched?.orderKey ?? (this.currentCache?.orderMode === 'canonical'
    ? maxExistingOrderKey + 1 + candidateIndex
    : candidate.absoluteTop)
};
```

改为：

```typescript
// P0 assistant placeholder 保护：如果已有缓存有文本，不被空 placeholder 覆盖
const isPlaceholder =
  candidate.role === 'assistant'
  && candidate.preview === ''
  && candidate.textForSearch === '';

const next: CachedMessage = {
  conversationId,
  localMessageId,
  role: candidate.role,
  textHash: isPlaceholder && matched ? matched.textHash : candidate.textHash,
  preview: isPlaceholder && matched ? matched.preview : candidate.preview,
  textForSearch: isPlaceholder && matched ? matched.textForSearch : candidate.textForSearch,
  occurrenceIndex,
  firstSeenAt: matched?.firstSeenAt ?? now,
  lastSeenAt: now,
  lastKnownScrollTop: candidate.scrollTop,
  lastKnownScrollRatio: candidate.scrollRatio,
  orderKey: matched?.orderKey ?? (this.currentCache?.orderMode === 'canonical'
    ? maxExistingOrderKey + 1 + candidateIndex
    : candidate.absoluteTop),
  ...(candidate.turnKey ? { turnKey: candidate.turnKey } : {}),
  ...(candidate.turnIndex >= 0 ? { turnIndex: candidate.turnIndex } : {}),
};
```

**关键：**
- `isPlaceholder` 检测 P0 空文本 candidate，如果 matched 存在（已有缓存），保留已有文本
- 新 assistant（无 matched）正常创建空 placeholder
- `turnKey` / `turnIndex` 使用条件展开，避免 exactOptionalPropertyTypes 下显式 `undefined` 编译失败

**4b. matchCandidate hash 匹配增加 role 限制（约第 312-318 行）**

将：

```typescript
const sameHash = existing
  .filter((message) => message.textHash === candidate.textHash && !usedExisting.has(message.localMessageId))
```

改为：

```typescript
const sameHash = existing
  .filter((message) => message.textHash === candidate.textHash && message.role === candidate.role && !usedExisting.has(message.localMessageId))
```

**4c. resolveScannedSegments 返回阶段 — 接入 reorderAndRekeyByTurnIndex（约第 183-196 行）**

将：

```typescript
const allMessages = orderMessagesByIds(nextMessagesById, orderedIds);
if (!arraysEqual(existingOrderedIds, orderedIds)) this.dirty = true;

this.currentCache = {
  ...this.currentCache!,
  conversationId,
  updatedAt: now,
  messages: allMessages,
  orderedIds
};
```

改为：

```typescript
let allMessages = orderMessagesByIds(nextMessagesById, orderedIds);

// 如果有 turnIndex，按 turnIndex 排序并重算 orderKey
const reordered = reorderAndRekeyByTurnIndex(allMessages);
allMessages = reordered;

const newOrderedIds = allMessages.map((m) => m.localMessageId);

// 检测 orderedIds 变化 或 orderKey/turnKey/turnIndex/role 等元数据变化
const existingById = new Map(existing.map((m) => [m.localMessageId, m]));
const metadataChanged = allMessages.some((m) => {
  const prev = existingById.get(m.localMessageId);
  return !prev
    || prev.orderKey !== m.orderKey
    || prev.turnKey !== m.turnKey
    || prev.turnIndex !== m.turnIndex
    || prev.role !== m.role;
});

if (!arraysEqual(existingOrderedIds, newOrderedIds) || metadataChanged) {
  this.dirty = true;
}

this.currentCache = {
  ...this.currentCache!,
  conversationId,
  updatedAt: now,
  messages: allMessages,
  orderedIds: newOrderedIds,
};
```

这确保 reorderAndRekeyByTurnIndex 产生的 orderKey 变化也被检测为 dirty，不会只在内存存在而不保存到 storage。

**4d. newOrUpdated 映射为 rekey 后的最终值**

newOrUpdated 在 rekey 前被填充，可能携带旧的 orderKey。在 return 之前，用 rekey 后的 allMessages 回填：

```typescript
// 将 newOrUpdated 映射为 rekey 后的最终值
const finalById = new Map(allMessages.map((m) => [m.localMessageId, m]));
const finalNewOrUpdated = newOrUpdated.map((m) => finalById.get(m.localMessageId) ?? m);

return { allMessages, resolvedMounted, resolvedCandidates, newOrUpdated: finalNewOrUpdated };
```

注意：metadataChanged 只负责 reorder/rekey 后的结构元数据；文本变化仍由 hasMeaningfulChange 负责。

- [ ] **Step 3: hasMeaningfulChange 增加字段比较**

修改 `hasMeaningfulChange` 方法：

```typescript
private hasMeaningfulChange(previous: CachedMessage, next: CachedMessage): boolean {
  return previous.role !== next.role
    || previous.preview !== next.preview
    || previous.textForSearch !== next.textForSearch
    || previous.textHash !== next.textHash
    || previous.lastKnownScrollTop !== next.lastKnownScrollTop
    || previous.lastKnownScrollRatio !== next.lastKnownScrollRatio
    || previous.turnKey !== next.turnKey
    || previous.turnIndex !== next.turnIndex
    || previous.orderKey !== next.orderKey;
}
```

包含 role / turnKey / turnIndex / textHash / orderKey 的比较。

- [ ] **Step 4: normalizeCache 旧缓存迁移 — 补 turnKey/turnIndex + 重排**

修改 `normalizeCache` 方法。新增 `inferTurnFields` 辅助函数，并在 normalizeCache 中调用 reorderAndRekeyByTurnIndex：

在 cacheStore.ts 底部（`arraysEqual` 函数之前）新增：

```typescript
function inferTurnFields(localMessageId: string, conversationId: string): { turnKey: string; turnIndex: number } | null {
  const prefix = `${conversationId}::turn::`;
  if (!localMessageId.startsWith(prefix)) return null;
  const turnKey = localMessageId.slice(prefix.length);
  const match = turnKey.match(/^conversation-turn-(\d+)$/);
  if (!match?.[1]) return null;
  return { turnKey, turnIndex: parseInt(match[1], 10) };
}
```

修改 `normalizeCache` 方法：

```typescript
private normalizeCache(cache: ConversationCache): ConversationCache {
  const messagesById = new Map<string, CachedMessage>(cache.messages.map((message) => [message.localMessageId, message]));
  const storedOrderedIds = Array.isArray(cache.orderedIds) ? cache.orderedIds : [];
  const orderedIds = appendMissingIds(
    storedOrderedIds.filter((id) => messagesById.has(id)),
    cache.messages.map((message) => message.localMessageId)
  );

  // 补全旧缓存中缺失的 turnKey / turnIndex
  let messages = orderMessagesByIds(messagesById, orderedIds).map((message) => {
    if (message.turnKey !== undefined && message.turnIndex !== undefined) return message;
    const inferred = inferTurnFields(message.localMessageId, message.conversationId);
    if (!inferred) return message;
    return { ...message, ...inferred };
  });

  // 按 turnIndex 排序并重算 orderKey
  messages = reorderAndRekeyByTurnIndex(messages);
  const normalizedOrderedIds = messages.map((m) => m.localMessageId);

  return {
    ...cache,
    messages,
    orderedIds: normalizedOrderedIds,
  };
}
```

这确保旧缓存加载后内存态正确：messages 按 turnIndex 排序、orderKey 连续化。

**落盘策略**：normalizeCache 的旧缓存迁移是 read-time normalization。如果 raw cache 和 normalized cache 的 orderedIds 或 messages 元数据不同，应标记 dirty 并 scheduleSave，避免每次加载都重复迁移。在 `loadConversation` 中：

```typescript
const normalized = cache ? this.normalizeCache(cache) : null;
this.currentCache = normalized ?? this.createEmptyCache(id);

if (cache && normalized && (
  !arraysEqual(cache.orderedIds ?? [], normalized.orderedIds)
  || cache.messages.some((raw, i) => {
    const norm = normalized.messages[i];
    return !norm || raw.orderKey !== norm.orderKey || raw.turnKey !== norm.turnKey || raw.turnIndex !== norm.turnIndex;
  })
)) {
  this.dirty = true;
  this.scheduleSave();
} else {
  this.dirty = false;
}
```

- [ ] **Step 5: updateMessageScrollMeta 接入 reorderAndRekeyByTurnIndex**

修改 `updateMessageScrollMeta` 方法，确保所有写路径都经过 rekey。将：

```typescript
this.currentCache = {
  ...this.currentCache,
  updatedAt: now,
  messages: orderMessagesByIds(messagesById, this.currentCache.orderedIds)
};
```

改为：

```typescript
const normalized = reorderAndRekeyByTurnIndex(orderMessagesByIds(messagesById, this.currentCache.orderedIds));
this.currentCache = {
  ...this.currentCache,
  updatedAt: now,
  messages: normalized,
  orderedIds: normalized.map((m) => m.localMessageId),
};
```

- [ ] **Step 6: migrateTempCache 接入 normalizeCache**

在 `migrateTempCache` 方法中，写入 storage 前调用 normalizeCache：

将：

```typescript
const migrated: ConversationCache = { ... };
await chrome.storage.local.set({ [this.cacheKey(realId)]: migrated });
await chrome.storage.local.remove(this.cacheKey(tempId));
await this.touchMeta(realId);
const meta = await this.loadMeta();
meta.conversationIds = meta.conversationIds.filter((id) => id !== tempId);
await chrome.storage.local.set({ [META_KEY]: meta });
this.currentCache = migrated;
this.dirty = false;
```

改为：

```typescript
const migrated: ConversationCache = { ... };
const normalizedMigrated = this.normalizeCache(migrated);
await chrome.storage.local.set({ [this.cacheKey(realId)]: normalizedMigrated });
await chrome.storage.local.remove(this.cacheKey(tempId));
await this.touchMeta(realId);
const meta = await this.loadMeta();
meta.conversationIds = meta.conversationIds.filter((id) => id !== tempId);
await chrome.storage.local.set({ [META_KEY]: meta });
this.currentCache = normalizedMigrated;
this.dirty = false;
```

---

### Task 5: MessageScanner Turn-Level 扫描

**Files:**
- Modify: `src/content/messageScanner.ts`

这是核心改动。将 `rescan()` 从 user-only 扩展为 turn-level 扫描。

- [ ] **Step 1: 更新导入语句**

修改 `src/content/messageScanner.ts` 顶部导入：

```typescript
import type { CachedMessage, ResolveResult, ScanResult, ScannedMessageCandidate, VisibleRange } from '../shared/types';
```

将 `ScannedUserMessageCandidate` 替换为 `ScannedMessageCandidate`（新代码使用新名称，deprecated alias 只为兼容旧引用保留）。

P0 只需要现有 `toPreview` / `toSearchText` / `hashText`，**不引入** toAiPreview / toAiSearchText（避免 noUnusedLocals 报错）。P1 做文本懒更新时再引入。

- [ ] **Step 2: 重写 rescan() 中的候选生成逻辑**

替换 `rescan()` 方法中从 `const elements = this.domAdapter.findUserMessages()` 到候选生成循环结束的代码块（约第 89-111 行）。

**替换前：**
```typescript
const elements = this.domAdapter.findUserMessages();
const candidates: ScannedUserMessageCandidate[] = [];
const scrollTop = this.scrollDriver.getScrollTop();
const scanDirection = this.getScanDirection(scrollTop);

for (let index = 0; index < elements.length; index += 1) {
  const element = elements[index];
  if (!element) continue;
  const text = this.domAdapter.extractText(element);
  if (!text) continue;
  candidates.push({
    observedDomMessageId: this.domAdapter.extractObservedId(element),
    text,
    textHash: await hashText(text),
    preview: toPreview(text),
    textForSearch: toSearchText(text),
    scrollRatio: this.scrollDriver.getScrollRatio(),
    scrollTop,
    absoluteTop: this.scrollDriver.getAbsoluteTop(element),
    element,
    turnKey: this.domAdapter.findTurnKeyForElement(element),
  });
}
```

**替换后：**
```typescript
const turnElements = this.domAdapter.findTurnElements();
const candidates: ScannedMessageCandidate[] = [];
const scrollTop = this.scrollDriver.getScrollTop();
const scanDirection = this.getScanDirection(scrollTop);

for (let index = 0; index < turnElements.length; index += 1) {
  const turnEl = turnElements[index];
  if (!turnEl) continue;

  const turnKey = this.domAdapter.extractTurnKey(turnEl);
  if (!turnKey) continue;

  const turnIndex = this.domAdapter.extractTurnIndex(turnKey);
  if (turnIndex < 0) continue;

  const role = this.domAdapter.extractTurnRole(turnEl);
  if (role === 'unknown') continue;

  const scrollRatio = this.scrollDriver.getScrollRatio();
  const absoluteTop = this.scrollDriver.getAbsoluteTop(turnEl);

  if (role === 'user') {
    // user: 使用 userEl 作为 element，保留现有 activeMessageId / 高亮 / scroll meta 行为
    const userEl = this.domAdapter.findRoleElementInTurn(turnEl, 'user');
    if (!userEl) continue;
    const text = this.domAdapter.extractText(userEl);
    if (!text) continue;

    candidates.push({
      observedDomMessageId: this.domAdapter.extractObservedId(userEl),
      text,
      textHash: await hashText(text),
      preview: toPreview(text),
      textForSearch: toSearchText(text),
      scrollRatio,
      scrollTop,
      absoluteTop,
      element: userEl,
      turnKey,
      role: 'user',
      turnIndex,
    });
  } else {
    // assistant P0: 只创建 anchor，不写流式文本
    // textHash 使用 turnKey 派生的稳定 hash，不随流式输出变化
    // preview / textForSearch 暂为空，P1 懒更新
    const textHash = await hashText(`assistant:${turnKey}`);

    candidates.push({
      observedDomMessageId: null,
      text: '',
      textHash,
      preview: '',
      textForSearch: '',
      scrollRatio,
      scrollTop,
      absoluteTop,
      // assistant 的 element 使用 turn 容器本身（不是内部 markdown 节点），
      // 因为 turn 元素始终存在且位置稳定，覆盖整个 AI 回复区域
      element: turnEl,
      turnKey,
      role: 'assistant',
      turnIndex,
    });
  }
}
```

**关键设计决策：**
1. **user 的 element 使用 userEl**（内部 role 子元素）：保留现有 activeMessageId / 高亮 / scroll meta 行为不变
2. **assistant 的 element 使用 turnEl**（turn 容器）：让长 AI 回复的整个 turn 作为空间锚点参与 visibleRange。不要改用内部 markdown 节点，否则 visibleRange 只覆盖局部区域
3. **assistant P0 使用稳定 fallback hash**：`hashText('assistant:${turnKey}')`，不随流式文本变化。避免 MutationObserver 在流式输出期间频繁触发 rescan 造成抖动
4. **placeholder 保护在 CacheStore 层（Task 4 Step 2）**：当普通扫描产生空 placeholder 但已有缓存有文本时，CacheStore 保留已有文本不被覆盖

- [ ] **Step 3: rebuildMountedMaps 兼容 turn 元素**

`rebuildMountedMaps` 方法将 candidate.element 映射到 localMessageId。对于 assistant，element 是 turn 元素。该方法已经是通用的，不需修改。

- [ ] **Step 4: registerAnchorTurnElements 职责变化**

改造后此方法的职责变为：
- **candidate 流程负责**：创建 + 注册当前扫描到的 assistant（包括 DOM element 绑定）
- **registerAnchorTurnElements 只负责**：把缓存中已有但本轮 candidate 未注册到的 assistant 重新绑定 DOM element

它不负责创建 assistant message。作为安全网保留，**无需修改**。

- [ ] **Step 5: computeActiveMessageId 仍只考虑 user**

已有 `isUserElement` 过滤：`messageById.get(id)?.role === 'user'`。**无需修改**。

- [ ] **Step 6: computeVisibleRange 包含 assistant**

当前不按 role 过滤，只检查 element 是否在 viewport 中。assistant 的 element 已通过 rebuildMountedMaps 注册到 elementById。**无需修改**。

---

### Task 6: AutoCollector 写入 turnKey / turnIndex

**Files:**
- Modify: `src/content/autoCollector.ts`

- [ ] **Step 1: buildAllMessages() 写入 turnKey / turnIndex**

修改 `buildAllMessages` 方法中构建 CachedMessage 的代码（约第 311-325 行），在每个消息对象中增加 turnKey 和 turnIndex：

```typescript
return hydratedFrames.map((frame, index) => ({
  conversationId,
  localMessageId: `${conversationId}::turn::${frame.turnKey}`,
  role: frame.role as 'user' | 'assistant',
  textForSearch: frame.textForSearch ?? '',
  preview: frame.preview ?? '',
  textHash: frame.textHash!,
  occurrenceIndex: index,
  firstSeenAt: now,
  lastSeenAt: now,
  lastKnownScrollTop: frame.lastKnownScrollTop,
  lastKnownScrollRatio: frame.lastKnownScrollRatio,
  orderKey: index,
  turnKey: frame.turnKey,
  turnIndex: frame.turnIndex,
}));
```

这确保 AutoCollector 全量采集产生的消息与普通扫描产生的消息有一致的 turnKey/turnIndex 元数据。不改采集流程。

---

### Task 7: Sidebar Q 编号验证

**Files:**
- Read-only verify: `src/ui/Sidebar.tsx`

- [ ] **Step 1: 确认 Q 编号仅基于 user messages**

Sidebar 过滤逻辑：`snapshot.messages.filter((m) => m.role === 'user')`，后续 index 基于 userMessages 数组。Q 编号不受 assistant anchor 影响。

**无需修改。**

---

### Task 8: 编译和构建验证

- [ ] **Step 1: 运行 TypeScript 类型检查**

Run: `pnpm compile`
Expected: PASS（所有类型错误应已修复）

- [ ] **Step 2: 运行生产构建**

Run: `pnpm build`
Expected: PASS（构建成功）

- [ ] **Step 3: 提交代码**

```bash
git add src/shared/types.ts src/content/domAdapter.ts src/content/orderList.ts src/content/cacheStore.ts src/content/messageScanner.ts src/content/autoCollector.ts docs/superpowers/plans/2026-05-25-assistant-anchor-instant-creation.md
git commit -m "feat: 普通扫描路径即时创建 assistant anchor

扩展 MessageScanner.rescan() 从 user-only 扫描为 turn-level 扫描：
- 新增 ScannedMessageCandidate，并保留 ScannedUserMessageCandidate 兼容别名
- DomAdapter 新增 findRoleElementInTurn / extractTurnText 辅助方法
- CacheStore.resolveScannedSegments 使用 candidate.role 替代硬编码
- matchCandidate hash 匹配增加 role 限制防止误匹配
- P0 assistant placeholder 保护：不覆盖已有 assistant 文本
- hasMeaningfulChange 增加 role/turnKey/turnIndex/textHash/orderKey 比较
- normalizeCache 从 localMessageId 反推 turnKey/turnIndex + 重排
- loadConversation 检测迁移后结构变化并落盘
- updateMessageScrollMeta / migrateTempCache 接入 rekey 流程
- AutoCollector.buildAllMessages 写入 turnKey/turnIndex
- 新增泛型 reorderAndRekeyByTurnIndex 确保 orderKey 按 turnIndex 正确排序

P0 策略：assistant anchor 使用稳定 fallback hash，不写流式文本。
文本懒更新留给 P1。assistant 作为隐藏锚点参与 visibleRange 计算，
不影响 UI 显示和 activeMessageId 高亮。"
```

---

## Verification

### P0 场景验证清单

1. **新对话普通扫描**：在 ChatGPT 新对话中发几条消息，打开 DevTools 检查：
   - `runtimeStore.messages` 包含 `role === 'assistant'` 的消息 ✓
   - assistant 的 `localMessageId` 基于 turnKey（格式 `conv::turn::conversation-turn-N`） ✓
   - assistant 有稳定的 `orderKey` 和 `turnIndex` ✓
   - assistant 的 element 在 `elementById` / `mountedIds` 中 ✓
   - Sidebar 只显示 user 消息，Q 编号正确 ✓

2. **visibleRange 测试**：滚动到只有 AI 回复的区域：
   - `computeVisibleRange()` 返回非 null 值（包含 assistant orderKey） ✓
   - 不再出现 null visibleRange ✓

3. **流式输出稳定性**：AI 正在回复时：
   - 不重复创建 assistant 消息（localMessageId 基于 turnKey，稳定） ✓
   - textHash 不随流式文本变化（使用 `assistant:${turnKey}` fallback） ✓
   - 不会因流式输出频繁触发 meaningful change ✓

4. **中间插入排序**：已有 user-only cache 的长对话中，滚到中间 AI 回复区：
   - 普通扫描补出 assistant anchor ✓
   - assistant 的 orderKey / turnIndex 位于前后 user turn 之间（不是末尾） ✓
   - 点击上方/下方 user 问题，progressive jump 方向正确 ✓

5. **已有文本保护**：先运行 AutoCollector 全量采集，再普通 rescan：
   - assistant 的 preview/textForSearch 不被清空 ✓
   - assistant 文本是否非空不影响 visibleRange ✓

6. **搜索不受影响**：Sidebar 搜索仍只搜索 user 提问 ✓

7. **缓存恢复**：刷新页面后 assistant anchor 从 cache 恢复 ✓
   - 旧缓存（无 turnKey/turnIndex）通过 normalizeCache 迁移 ✓

8. **AutoCollector 兼容**：全量采集后 messages 包含 turnKey/turnIndex ✓
