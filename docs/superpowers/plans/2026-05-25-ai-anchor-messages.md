# AI 锚点消息 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 assistant turn 作为隐藏锚点消息写入缓存和 RuntimeStore，使 `computeVisibleRange` 在视口内只有 AI 回复时仍能返回有效范围，提升渐进式跳转 `decideDirection` 的可靠性。

**Architecture:** 复用 `CachedUserMessage` 类型（role 扩展为 `'user' | 'assistant'`），AutoCollector 在 `tryHydrateFrame` 中提取 AI 回复的截断文本（文本不可提取时使用 turnKey 派生 hash，确保 anchor 始终生成），`buildAllMessages` 输出所有 turn（含 assistant）。MessageScanner 在 rescan 时接收 `result.allMessages`，通过 DomAdapter 的 `findTurnElements` 将已缓存 AI 消息的 DOM 元素注册到 `elementById`，`computeVisibleRange` 自然扩展。`computeActiveMessageId` 限制只有 user 消息可成为 active。Sidebar/MiniBar 通过统一的 `userMessages` useMemo 过滤只渲染用户提问。

**Tech Stack:** TypeScript, Preact, Chrome Extension (Manifest V3), WXT

**依赖说明：** 本计划基于 PR #13（`phase4-jump-v2`）的 Phase 4 渐进式跳转实现，应在 #13 合并后实施。#13 采用 orderKey-based `VisibleRange`：`JumpController.decideDirection(target.orderKey, visibleRange)` 根据 `minOrderKey/maxOrderKey` 判断方向。因此本计划继续使用 orderKey-based 设计，不再切换为 index-based。canonical 模式下 `orderKey` 由 `buildAllMessages` 按 turnIndex 排序后连续分配（user/assistant 共享同一序列），`decideDirection` 的 `<` / `>=` 比较自然正确。

> **旧缓存兼容**：AI anchor 只有在 AutoCollector 重新采集后才会写入缓存。旧缓存里只有 user message，不会自动凭空出现 assistant anchor。需要对目标会话重新执行自动采集后，缓存中才会包含 AI 锚点。旧缓存仍可正常使用，只是不会获得 AI anchor 对 `visibleRange` 的增强。

---

### Task 1: 扩展 CachedUserMessage.role 类型

**Files:**
- Modify: `src/shared/types.ts:4`

- [ ] **Step 1: 修改 role 类型**

将 `src/shared/types.ts` 第 4 行的 `role: 'user'` 改为联合类型：

```typescript
  role: 'user' | 'assistant';  // TODO(#12): CachedUserMessage → CachedMessage
```

- [ ] **Step 2: 验证编译**

Run: `pnpm compile`
Expected: PASS。`cacheStore.ts:127` 的 `role: 'user'` 是合法赋值（`'user'` 是 `'user' | 'assistant'` 的子类型），不会报错。

---

### Task 2: 新增 AI 文本截断函数

**Files:**
- Modify: `src/shared/text.ts`

- [ ] **Step 1: 添加 AI 文本截断常量和函数**

在 `src/shared/text.ts` 文件末尾（`splitByQuery` 之后）添加：

```typescript
export const AI_PREVIEW_MAX_LENGTH = 200;
export const AI_SEARCH_MAX_LENGTH = 500;

export function toAiPreview(input: string): string {
  return toPreview(input, AI_PREVIEW_MAX_LENGTH);
}

export function toAiSearchText(input: string): string {
  return toSearchText(input, AI_SEARCH_MAX_LENGTH);
}
```

这复用了已有的 `toPreview` 和 `toSearchText`，只是传入不同的截断长度。

- [ ] **Step 2: 验证编译**

Run: `pnpm compile`
Expected: PASS

- [ ] **Step 3: 提交**

```bash
git add src/shared/types.ts src/shared/text.ts
git commit -m "feat: 扩展 CachedUserMessage.role 支持 assistant，新增 AI 文本截断函数

- types.ts: role 从 'user' 扩展为 'user' | 'assistant'
- text.ts: 新增 AI_PREVIEW_MAX_LENGTH(200)、AI_SEARCH_MAX_LENGTH(500)
- text.ts: 新增 toAiPreview、toAiSearchText 截断函数

Refs #12"
```

---

### Task 3: AutoCollector 输出 AI 锚点消息

**Files:**
- Modify: `src/content/autoCollector.ts`

这是核心改动。需要修改三处：`tryHydrateFrame`（提取 assistant 文本，**即使文本为空也必须生成 anchor**）、`buildUserMessagesFromFrames`（改名为 `buildAllMessages`，输出含 AI 的消息）、所有调用点更新。

- [ ] **Step 1: 修改 tryHydrateFrame 提取 assistant 文本**

在 `src/content/autoCollector.ts` 中，找到 `tryHydrateFrame` 方法里第 277-279 行的注释块：

```typescript
    }
    // assistant turn 只需 role recognition 即视为 hydrated；
    // 最终 Q 列表只由 user frames 生成，无需保存 assistant 文本。

    frame.role = role;
```

替换为：

```typescript
    }

    if (role === 'assistant') {
      const assistantEl = el.querySelector<HTMLElement>('[data-message-author-role="assistant"]');
      const text = assistantEl ? this.domAdapter.extractText(assistantEl) : '';
      if (text) {
        frame.textHash = await hashText(text.slice(0, 500));
        frame.preview = toAiPreview(text);
        frame.textForSearch = toAiSearchText(text);
      } else {
        // 文本不可提取时使用 turnKey 派生 hash，确保 anchor 一定生成
        frame.textHash = await hashText(`assistant:${frame.turnKey}`);
        frame.preview = '';
        frame.textForSearch = '';
      }
    }

    frame.role = role;
```

**关键设计**：assistant anchor 即使无法提取文本也必须生成。文本为空时使用 `hashText(\`assistant:${frame.turnKey}\`)` 生成确定性 hash，preview/textForSearch 为空字符串。这确保每条 AI turn 都有 anchor，不会因为 ChatGPT 的 DOM 虚拟化导致文本丢失而跳过。

同时在文件顶部的 import 中添加 `toAiPreview` 和 `toAiSearchText`：

```typescript
import { toPreview, toSearchText, toAiPreview, toAiSearchText } from '../shared/text';
```

- [ ] **Step 2: 将 buildUserMessagesFromFrames 改为 buildAllMessages**

将 `buildUserMessagesFromFrames` 方法（第 288-311 行）整体替换为 `buildAllMessages`：

```typescript
  private buildAllMessages(conversationId: string): CachedUserMessage[] {
    const sortedFrames = [...this.frames.values()]
      .sort((a, b) => a.turnIndex - b.turnIndex);

    const hydratedFrames = sortedFrames.filter(
      (f) => f.hydrated && f.textHash !== null
    );

    const now = Date.now();
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
    }));
  }
```

关键差异：
- 不再过滤 `role === 'user'`，而是输出所有已水合且 textHash 非空的帧
- `role` 使用 `frame.role as 'user' | 'assistant'`（已确认 hydrated 的帧 role 不为 'unknown'——`tryHydrateFrame` 在 role='unknown' 时提前 return）
- `textForSearch`/`preview` 使用 `?? ''` 回退（AI 文本不可提取时为空字符串）
- `orderKey` 使用 hydratedFrames 中的连续 `index`，保持文档顺序

- [ ] **Step 3: 更新所有 buildUserMessagesFromFrames 调用点**

在 `autoCollector.ts` 中，将所有 `buildUserMessagesFromFrames` 替换为 `buildAllMessages`。分布在 `startFullCollection`、`runFallbackHydration`、`checkpointProgress`、`finalize` 方法中：

1. 主循环中的 `this.runtimeStore.setMessages(this.buildAllMessages(conversationId))`
2. fallback hydration 中的 `this.runtimeStore.setMessages(this.buildAllMessages(this.currentConversationId))`
3. `checkpointProgress` 中的 `const messages = this.buildAllMessages(conversationId)`
4. `finalize` 中的 `const messages = this.buildAllMessages(conversationId)`

使用全局替换：
```bash
cd "D:\CODE\Project\Chatgpt-Question-Navigator\.claude\worktrees\phase4-progressive-jump"
sed -i 's/buildUserMessagesFromFrames/buildAllMessages/g' src/content/autoCollector.ts
```

- [ ] **Step 4: 验证编译**

Run: `pnpm compile`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/content/autoCollector.ts
git commit -m "feat: AutoCollector 输出 assistant turn 作为隐藏锚点消息

- tryHydrateFrame: assistant turn 提取截断文本，文本不可提取时用 turnKey 派生 hash
- buildUserMessagesFromFrames → buildAllMessages: 输出所有已水合帧（含 AI）
- orderKey 按 turnIndex 排序后连续分配，user/assistant 共享序列"
```

---

### Task 4: DomAdapter 新增 findTurnElements

**Files:**
- Modify: `src/content/domAdapter.ts`

- [ ] **Step 1: 新增 findTurnElements 方法**

在 `src/content/domAdapter.ts` 的 `findTurnSkeletons` 方法之后（约第 43 行后）添加：

```typescript
  findTurnElements(): HTMLElement[] {
    return this.findTurnSkeletons();
  }
```

这只是一个语义别名——`findTurnSkeletons` 已经返回所有 `section[data-testid^="conversation-turn-"]` 元素。但分开命名让调用方意图更清晰：`findTurnSkeletons` 用于骨架扫描（AutoCollector），`findTurnElements` 用于运行时 DOM 检测（MessageScanner）。

- [ ] **Step 2: 验证编译**

Run: `pnpm compile`
Expected: PASS

- [ ] **Step 3: 提交**

```bash
git add src/content/domAdapter.ts
git commit -m "feat: DomAdapter 新增 findTurnElements 方法

语义别名 findTurnSkeletons，用于 MessageScanner 检测运行时 turn 元素"
```

---

### Task 5: MessageScanner 注册 AI turn 元素 + computeActiveMessageId 限制

**Files:**
- Modify: `src/content/messageScanner.ts`

这是让 `computeVisibleRange` 自然扩展的关键改动，同时确保 AI anchor 不参与 active 消息计算。

- [ ] **Step 1: 在 rescan 中注册 AI turn 元素**

在 `src/content/messageScanner.ts` 的 `rescan()` 方法中，找到 `rebuildMountedMaps` 和 `setMessages` 调用（第 125-126 行）：

```typescript
    this.rebuildMountedMaps(result, sortedCandidates);
    this.runtimeStore.setMessages(result.allMessages);
```

替换为：

```typescript
    this.rebuildMountedMaps(result, sortedCandidates);

    // 注册 AI turn 锚点的 DOM 元素（不参与 resolveScannedSegments 候选流程）
    this.registerAnchorTurnElements(conversationId, result.allMessages);

    this.runtimeStore.setMessages(result.allMessages);
```

新增 `registerAnchorTurnElements` 私有方法。在 `computeVisibleRange` 方法之前（第 273 行前）添加：

```typescript
  private registerAnchorTurnElements(conversationId: string, allMessages: CachedUserMessage[]): void {
    // 构建 Map 避免 O(n²) 查找
    const messageById = new Map(allMessages.map((m) => [m.localMessageId, m]));
    const allTurnElements = this.domAdapter.findTurnElements();

    for (const turnEl of allTurnElements) {
      const turnKey = this.domAdapter.extractTurnKey(turnEl);
      if (!turnKey) continue;

      const localId = `${conversationId}::turn::${turnKey}`;
      // 只注册已在缓存中的 AI 消息；用户消息已通过 rebuildMountedMaps 处理
      const cached = messageById.get(localId);
      if (!cached || cached.role !== 'assistant') continue;

      if (!this.elementById.has(localId) && turnEl.isConnected) {
        this.elementById.set(localId, turnEl);
        this.mountedIds.add(localId);
      }
    }
  }
```

**设计说明**：
- 接收 `result.allMessages` 参数而不是从 `runtimeStore.getSnapshot()` 读取，避免在 `setMessages` 调用前读取可能过时的快照
- 使用 `Map` 而非 `find()`，避免 O(n²) 查找（turn 元素数 × 消息数）
- 用 `turnKey` 构造 `localMessageId`（与 AutoCollector 的 `convId::turn::turnKey` 格式一致）
- 只处理 `role === 'assistant'`，用户消息已通过 `rebuildMountedMaps` 处理

需要在文件顶部添加 `CachedUserMessage` 的 import：

```typescript
import type { CachedUserMessage, ResolveResult, ScanResult, ScannedUserMessageCandidate, VisibleRange } from '../shared/types';
```

- [ ] **Step 2: 修改 computeActiveMessageId 只允许 user 消息成为 active**

找到 `computeActiveMessageId` 方法（第 254-272 行），在视口内消息过滤中添加 `role === 'user'` 条件。

将方法整体替换为：

```typescript
  private computeActiveMessageId(): string | null {
    const snapshot = this.runtimeStore.getSnapshot();
    const viewport = this.scrollDriver.getViewportRect();
    const messageById = new Map(snapshot.messages.map((m) => [m.localMessageId, m]));

    const isUserElement = (id: string): boolean => messageById.get(id)?.role === 'user';

    const entries = Array.from(this.elementById.entries())
      .filter(([id]) => isUserElement(id))
      .map(([id, element]) => ({ id, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.bottom >= viewport.top && rect.top <= viewport.bottom);

    const visibleBelowTop = entries
      .filter(({ rect }) => rect.top >= viewport.top)
      .sort((a, b) => a.rect.top - b.rect.top)[0];
    if (visibleBelowTop) return visibleBelowTop.id;

    const nearestAbove = Array.from(this.elementById.entries())
      .filter(([id]) => isUserElement(id))
      .map(([id, element]) => ({ id, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.top < viewport.top)
      .sort((a, b) => b.rect.top - a.rect.top)[0];

    return nearestAbove?.id ?? null;
  }
```

**设计说明**：
- 使用 `Map` 避免 `find()` 的 O(n²) 查找（elementById 条目数 × messages 数组长度）
- 提取 `isUserElement` 辅助函数减少重复逻辑
- AI anchor 只参与 `visibleRange`（提供方向信息），不参与 `activeMessageId`（UI 高亮）。MiniBar 和 Sidebar 的 active 标记只落在用户提问上，不会意外跳到 AI 回复

- [ ] **Step 3: 验证编译**

Run: `pnpm compile`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add src/content/messageScanner.ts
git commit -m "feat: MessageScanner 注册 AI turn 锚点元素，active 限制为 user

- registerAnchorTurnElements: 从 result.allMessages 参数匹配 AI 消息
- computeActiveMessageId: 只允许 role === 'user' 成为 active
- computeVisibleRange 自动受益：遍历 snapshot.messages 时包含 AI 锚点"
```

---

### Task 6: Sidebar 统一 userMessages 过滤

**Files:**
- Modify: `src/ui/Sidebar.tsx`

- [ ] **Step 1: 抽出 userMessages useMemo，统一使用**

在 `src/ui/Sidebar.tsx` 中，将第 97-101 行的 `messages` useMemo 重构为两层：

```typescript
  const userMessages = useMemo(() => snapshot.messages.filter((m) => m.role === 'user'), [snapshot.messages]);
  const messages = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return userMessages;
    return userMessages.filter((message) => message.textForSearch.toLowerCase().includes(query));
  }, [userMessages, searchQuery]);
```

- [ ] **Step 2: getStatusText 使用 userMessages.length**

将第 225 行的 `snapshot.messages.length` 替换为 `userMessages.length`：

```typescript
            {getStatusText(collectPhase, snapshot.autoCollectProgress, userMessages.length)}
```

- [ ] **Step 3: MiniBar 使用 userMessages**

将第 147-148 行的 MiniBar `messages` prop 从 `snapshot.messages` 改为 `userMessages`：

```typescript
        <MiniBar
          messages={userMessages}
          activeMessageId={snapshot.activeMessageId}
          mountedIds={snapshot.mountedIds}
          onJump={handleJump}
          onExpand={() => handleModeChange('expanded')}
        />
```

- [ ] **Step 4: 验证编译**

Run: `pnpm compile`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/ui/Sidebar.tsx
git commit -m "feat: Sidebar 统一 userMessages 过滤，UI 只显示用户提问

- 新增 userMessages useMemo 过滤 role === 'user'
- messages（搜索过滤）基于 userMessages
- MiniBar、getStatusText 统一使用 userMessages"
```

---

### Task 7: 更新 CLAUDE.md 和 docs/Tree.md

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/Tree.md`

- [ ] **Step 1: 更新 CLAUDE.md**

在 `CLAUDE.md` 的 `CacheStore` 描述行中，将：

```
| `CacheStore` | `chrome.storage.local` 持久化层。按 `conv:{id}` 分会话存储，LRU 清理（上限 8MB），防抖保存（2s）。`resolveScannedSegments` 是核心分段合并方法，`replaceConversationMessages` 用于 canonical 模式原子写入。localMessageId 优先使用 turn-based 格式 |
```

改为：

```
| `CacheStore` | `chrome.storage.local` 持久化层。按 `conv:{id}` 分会话存储，LRU 清理（上限 8MB），防抖保存（2s）。`resolveScannedSegments` 是核心分段合并方法，`replaceConversationMessages` 用于 canonical 模式原子写入。localMessageId 优先使用 turn-based 格式。缓存同时包含 user 和 assistant 消息（AI 锚点） |
```

在 `MessageScanner` 描述行中将：

```
| `MessageScanner` | 核心扫描引擎。通过 MutationObserver（防抖 500ms）和 IntersectionObserver 监控 DOM 变化，将候选消息交给 CacheStore 去重合并。候选生成时通过 DomAdapter.findTurnKeyForElement 提取 turnKey |
```

改为：

```
| `MessageScanner` | 核心扫描引擎。通过 MutationObserver（防抖 500ms）和 IntersectionObserver 监控 DOM 变化，将候选消息交给 CacheStore 去重合并。候选生成时通过 DomAdapter.findTurnKeyForElement 提取 turnKey。rescan 时注册 AI turn 锚点元素到 elementById（扩展 visibleRange），computeActiveMessageId 限制为 user 消息 |
```

在开发注意事项中添加新条目：

```
- **AI 锚点消息**：缓存中同时包含 `role: 'user'` 和 `role: 'assistant'` 消息。AI 消息作为隐藏锚点参与 `visibleRange` 计算但不显示在 UI 中，也不参与 activeMessageId 计算。`CachedUserMessage` 命名待重命名为 `CachedMessage`（#12）
```

- [ ] **Step 2: 更新 docs/Tree.md**

在 `docs/Tree.md` 的文件树中更新 autoCollector 和 messageScanner 的描述：

```
│   │   ├── autoCollector.ts        # 自动 bottom-to-top 采集，按钮触发，生成 canonical 顺序（含 AI 锚点）
```

```
│   │   ├── messageScanner.ts       # 核心扫描引擎，MutationObserver + IntersectionObserver + AI turn 锚点注册
```

- [ ] **Step 3: 提交**

```bash
git add CLAUDE.md docs/Tree.md
git commit -m "docs: 更新 CLAUDE.md 和 Tree.md 反映 AI 锚点消息

- CacheStore/MessageScanner/AutoCollector 描述更新
- 开发注意事项新增 AI 锚点消息说明（含 active 限制）
- Tree.md 更新文件描述"
```

---

### Task 8: 最终验证

- [ ] **Step 1: TypeScript 编译检查**

Run: `pnpm compile`
Expected: 零错误

- [ ] **Step 2: 生产构建**

Run: `pnpm build`
Expected: 零错误，产物输出到 `.output/chrome-mv3/`

- [ ] **Step 3: Spec 验收检查清单**

对照 spec 验收标准逐项确认：

1. [ ] AutoCollector 采集后，缓存中同时包含 `role: 'user'` 和 `role: 'assistant'` 消息 → Task 3
2. [ ] `orderKey` 按文档顺序连续分配 → Task 3（hydratedFrames 按 turnIndex 排序后 index）
3. [ ] 侧栏消息列表只显示用户提问 → Task 6（userMessages useMemo）
4. [ ] `visibleRange` 在视口内只有 AI 回复时仍能返回有效范围 → Task 5（registerAnchorTurnElements）
5. [ ] `decideDirection` 在 AI 回复占视口时仍能返回正确方向 → 自动受益于 #4
6. [ ] 渐进式跳转穿越长 AI 回复区时方向不再丢失 → 自动受益于 #4
7. [ ] 存储增长可接受 → AI 截断 200/500 字符
8. [ ] `pnpm compile` 和 `pnpm build` 无错误 → 本 Task 验证

- [ ] **Step 4: 手工验收场景**

在 ChatGPT 长对话页面（10+ 轮，含长 AI 回复）加载扩展后，逐项验证：

1. **AI 回复中段方向稳定**：滚动到一条长 AI 回复的中间位置，点击远处 cached-only 用户问题，观察 JumpToast 尝试过程。预期：不会长期 fallback 到默认 down，不会频繁上下方向反复切换。
    - 若后续添加了 visibleRange debug 输出，可直接确认 visibleRange 非 null。
    - 当前 #13 的 Ctrl+Shift+D 只打印 ScrollDriver debug，不作为 visibleRange 直接验收手段。
2. **MiniBar 不回退 Q1**：在 MiniBar 模式下，当视口处于长 AI 回复区域时，activeMessageId 应保持为最近的用户提问，不会跳回 Q1
3. **远距离 cached-only 跳转方向稳定**：点击列表中一条距离很远的 cached-only 消息（需要跨多个长 AI 回复），观察：
   - 跳转不应在 3 次 consecutiveNoOps 后失败
   - 方向应保持一致（不会在 down/up 之间反复切换）
   - 最终应成功找到目标消息或因合理的边界原因失败
