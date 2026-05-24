# AutoCollector 实现计划（v3 修订版）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现按钮触发的自动向上滚动采集流程，生成稳定的 canonical message order，彻底替代不可靠的手动滚动增量排序。

**Architecture:** 新增 AutoCollector 模块，通过 bottom-to-top 编程式滚动遍历整个对话，收集所有用户消息候选。采集完成后统一去重、排序、分配 orderKey=0..N-1，通过 CacheStore.replaceConversationMessages() 原子替换缓存（同时写入 messages + orderedIds + orderMode='canonical'）。现有 MessageScanner 保留用于轻量增量更新（mounted state、跳转），但在 canonical 模式下不再能通过 mergeOrderedSegments 移动已有 orderedIds。使用 chrome.storage.local 保存 autoCollectIntent 实现跨 reload 恢复。

**Tech Stack:** TypeScript, Preact, WXT (Manifest V3), Chrome Extension APIs

---

## 修订历史

### v2 → v3 修正要点

| # | 问题 | 修正 |
|---|------|------|
| 1 | onConversationChange 回调中读 intent 有竞态（UrlWatcher.emitIfChanged 不 await callback） | 在 urlWatcher.start() 之前读 intent，用 domAdapter.extractConversationId() 计算 shouldAutoCollectOnStartup |
| 2 | foundCount 临时 key 使用 batchIndex 导致 overlap 消息每次都被认为是新消息 | RawCandidate 加入 absoluteTop（scrollDriver.getAbsoluteTop），临时 key 使用 observedDomMessageId 或 textHash + rounded absoluteTop bucket |
| 3 | mergeBatches 中无 domId 候选用 textHash + scrollTop proximity 去重会误删同一窗口内两条相同文本消息 | 改为 textHash + Math.floor(absoluteTop/100) bucket 去重；同一 batch 内不因 textHash 相同而去重 |
| 4 | canonical 模式 append newIds 后未同步 knownIds，可能导致同一轮重复 append | push 后立即 knownIds.add(id) |
| 5 | AutoCollector 直接依赖 MessageScanner | 移除 scanner 参数，改为 afterReplace 回调；content.ts 负责 clearState + rescan + start |
| 6 | Task 1/2 分开导致 compile 预期 FAIL | 合并为单一 task，compile 始终 PASS |

### v1 → v2 修正要点

| # | 问题 | 修正 |
|---|------|------|
| 1 | entrypoints/content.ts 路径 | 已确认正确，保留 |
| 2 | UI Q 编号来自 orderedIds 而非 orderKey | 新增 canonical 模式保护 orderedIds |
| 3 | replaceConversationMessages 必须写入 orderedIds | 已明确，同时设置 orderMode |
| 4 | resolveScannedSegments 不得在 canonical 模式下调用 mergeOrderedSegments | ConversationCache 新增 orderMode 字段 |
| 5 | canonical 模式只能 append 新消息 | resolveScannedSegments 增加分支 |
| 6 | content.ts 不能用 return 阻止 scanner.start() | 重构启动流程 |
| 7 | setConversationId 需补 autoCollectProgress: null | RuntimeStore 初始状态和 reset 均包含 |
| 8 | 采集循环 foundCount 判断不能用 textHash 作唯一 key | 改用稳定 key |
| 9 | OVERLAP_RATIO 25%步长过慢 | 改为 SCROLL_STEP_RATIO = 0.75 |
| 10 | finalize 后必须触发 scanner.rescan() | 通过 afterReplace 回调实现 |

---

## Context

当前 bug 来自手动滚动扫描时使用 domOrderIndex / 可见窗口顺序推导全局 orderKey。用户从底部向上滚动时较早消息后发现需要插入已有列表前面，但从顶部回到底部时又发生重排，说明增量 orderKey 方案不稳定。本任务不再修补增量排序，而是实现一次性全量采集生成 canonical order。

## File Structure

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/shared/types.ts` | 修改 | 新增 AutoCollectPhase/Progress/Intent 类型，ConversationCache 新增 orderMode，扩展 RuntimeState |
| `src/content/autoCollector.ts` | **新建** | 采集状态机、滚动循环、稳定等待、去重合并、intent 持久化（无 scanner 依赖） |
| `src/content/cacheStore.ts` | 修改 | 新增 replaceConversationMessages()，resolveScannedSegments() 增加 canonical 模式分支，preserve orderMode |
| `src/content/runtimeStore.ts` | 修改 | 新增 autoCollectProgress 状态字段、setAutoCollectProgress setter |
| `entrypoints/content.ts` | 修改 | 挂载 AutoCollector，重构启动流程（urlWatcher.start() 前读 intent），afterReplace 回调 |
| `src/ui/ShadowRootApp.tsx` | 修改 | 传递 autoCollector 和 onStartAutoCollect 回调 |
| `src/ui/Sidebar.tsx` | 修改 | 新增采集按钮、进度显示、取消按钮 |
| `src/ui/styles.css` | 修改 | 采集按钮 spinner 样式 |

**不修改的文件:** orderList.ts, messageScanner.ts, domAdapter.ts, scrollDriver.ts, jumpController.ts, urlWatcher.ts, hash.ts, text.ts, MiniBar.tsx, MessageItem.tsx, SearchBox.tsx

---

### Task 1: Types + RuntimeStore（合并，保证 compile PASS）

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/content/runtimeStore.ts`

- [ ] **Step 1: 更新 types.ts**

1. 在 `ConversationCache` 接口中添加 `orderMode` 字段：

```typescript
export interface ConversationCache {
  conversationId: string;
  updatedAt: number;
  messages: CachedUserMessage[];
  orderedIds: string[];
  orderMode?: 'incremental' | 'canonical';  // 新增
}
```

2. 在 `RuntimeState` 接口中添加 `autoCollectProgress`：

```typescript
export interface RuntimeState {
  conversationId: string | null;
  messages: CachedUserMessage[];
  elementById: Map<string, HTMLElement>;
  mountedIds: Set<string>;
  activeMessageId: string | null;
  jumpState: JumpState;
  autoCollectProgress: AutoCollectProgress | null;  // 新增
}
```

3. 在文件末尾（`ScanResult` 之后）添加：

```typescript
// --- AutoCollector types ---

export type AutoCollectPhase =
  | 'idle'
  | 'preparing'
  | 'collecting'
  | 'finalizing'
  | 'completed'
  | 'cancelled'
  | 'failed';

export interface AutoCollectProgress {
  phase: AutoCollectPhase;
  conversationId: string;
  foundCount: number;
  round: number;
  errorMessage?: string;
}

export interface AutoCollectIntent {
  conversationId: string;
  url: string;
  requestedAt: number;
}
```

- [ ] **Step 2: 更新 runtimeStore.ts**

1. 更新 import：

```typescript
import type { AutoCollectProgress, CachedUserMessage, JumpState, RuntimeState } from '../shared/types';
```

2. 初始 state 添加 `autoCollectProgress: null`：

```typescript
private state: RuntimeState = {
  conversationId: null,
  messages: [],
  elementById: new Map(),
  mountedIds: new Set(),
  activeMessageId: null,
  jumpState: { status: 'idle' },
  autoCollectProgress: null,
};
```

3. `setConversationId()` 的 reset 对象中添加 `autoCollectProgress: null`：

```typescript
setConversationId(id: string | null): void {
  this.state = {
    ...this.state,
    conversationId: id,
    messages: [],
    elementById: new Map(),
    mountedIds: new Set(),
    activeMessageId: null,
    jumpState: { status: 'idle' },
    autoCollectProgress: null,
  };
  this.emit();
}
```

4. 添加 setter：

```typescript
setAutoCollectProgress(progress: AutoCollectProgress | null): void {
  this.state = { ...this.state, autoCollectProgress: progress };
  this.emit();
}
```

5. `getSnapshot()` 返回对象中添加 autoCollectProgress 浅拷贝：

```typescript
getSnapshot(): RuntimeState {
  return {
    ...this.state,
    messages: [...this.state.messages],
    elementById: new Map(this.state.elementById),
    mountedIds: new Set(this.state.mountedIds),
    autoCollectProgress: this.state.autoCollectProgress
      ? { ...this.state.autoCollectProgress }
      : null,
  };
}
```

- [ ] **Step 3: 编译验证**

Run: `pnpm compile`
Expected: PASS（types.ts 和 runtimeStore.ts 同步更新）

- [ ] **Step 4: Commit**

```bash
git add src/shared/types.ts src/content/runtimeStore.ts
git commit -m "feat: 添加 AutoCollect 类型定义和 RuntimeStore.autoCollectProgress 状态"
```

---

### Task 2: CacheStore — replaceConversationMessages + canonical 模式

**Files:**
- Modify: `src/content/cacheStore.ts`

核心改动：
1. 新增 `replaceConversationMessages()` 写入 canonical order + orderMode
2. `resolveScannedSegments()` 在 canonical 模式下不调用 mergeOrderedSegments，只 append 新消息
3. canonical append 时同步 knownIds（修正 #4）
4. resolveScannedSegments 末尾 preserve orderMode

- [ ] **Step 1: 添加 replaceConversationMessages**

在 `clearAll()` 方法之后添加：

```typescript
/**
 * 原子替换对话消息 — 仅由 AutoCollector 调用。
 * 同时写入 messages、orderedIds、orderMode='canonical'。
 */
async replaceConversationMessages(
  conversationId: string,
  messages: CachedUserMessage[]
): Promise<void> {
  const orderedIds = messages.map((m) => m.localMessageId);
  const cache: ConversationCache = {
    conversationId,
    updatedAt: Date.now(),
    messages,
    orderedIds,
    orderMode: 'canonical',
  };
  this.currentCache = this.normalizeCache(cache);
  this.dirty = true;
  await this.saveConversation(this.currentCache);
}
```

- [ ] **Step 2: resolveScannedSegments 增加 canonical 模式分支**

在 `resolveScannedSegments` 方法中，找到构建 orderedIds 的位置（当前代码 line 141-143）：

```typescript
// 原代码:
const orderedIds = mergeOrderedSegments(existingOrderedIds, resolvedSegments);
const allMessages = orderMessagesByIds(nextMessagesById, orderedIds);
if (!arraysEqual(existingOrderedIds, orderedIds)) this.dirty = true;
```

替换为：

```typescript
let orderedIds: string[];

if (this.currentCache?.orderMode === 'canonical') {
  // canonical 模式：不调用 mergeOrderedSegments，只 append 新消息到末尾
  const knownIds = new Set(existingOrderedIds);
  const newIds: string[] = [];
  for (const resolved of resolvedCandidates) {
    if (!knownIds.has(resolved.localMessageId)) {
      newIds.push(resolved.localMessageId);
      knownIds.add(resolved.localMessageId);  // 修正 #4: 同步 knownIds
    }
  }
  orderedIds = [...existingOrderedIds, ...newIds];
} else {
  // incremental 模式：使用原有的 mergeOrderedSegments
  orderedIds = mergeOrderedSegments(existingOrderedIds, resolvedSegments);
}

const allMessages = orderMessagesByIds(nextMessagesById, orderedIds);
if (!arraysEqual(existingOrderedIds, orderedIds)) this.dirty = true;
```

- [ ] **Step 3: resolveScannedSegments 末尾 preserve orderMode**

将 resolveScannedSegments 末尾的 `this.currentCache = { ... }` 赋值（当前代码 line 145-150）：

```typescript
// 原代码:
this.currentCache = {
  conversationId,
  updatedAt: now,
  messages: allMessages,
  orderedIds
};
```

改为 spread 保留 orderMode：

```typescript
this.currentCache = {
  ...this.currentCache!,
  conversationId,
  updatedAt: now,
  messages: allMessages,
  orderedIds
};
```

- [ ] **Step 4: canonical 模式下新消息 orderKey 保护**

将构建 `next` 对象时的 orderKey 赋值（当前代码 line 113）：

```typescript
orderKey: matched?.orderKey ?? candidate.absoluteTop
```

改为：

```typescript
orderKey: matched?.orderKey ?? (this.currentCache?.orderMode === 'canonical'
  ? (existing.length > 0 ? Math.max(...existing.map((m) => m.orderKey)) + 1 + candidateIndex : candidateIndex)
  : candidate.absoluteTop)
```

- [ ] **Step 5: 编译验证**

Run: `pnpm compile`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/content/cacheStore.ts
git commit -m "feat: CacheStore 添加 replaceConversationMessages 和 canonical 模式保护 orderedIds"
```

---

### Task 3: AutoCollector 核心模块

**Files:**
- Create: `src/content/autoCollector.ts`

关键设计：
- **修正 #5**: 移除 MessageScanner 依赖，改为 `afterReplace` 回调
- **修正 #2**: RawCandidate 加入 absoluteTop，临时 key 使用 observedDomMessageId 或 textHash + absoluteTop bucket
- **修正 #3**: mergeBatches 去重使用 textHash + absoluteTop bucket，同 batch 不因 textHash 相同而去重
- **修正 #9**: SCROLL_STEP_RATIO = 0.75

- [ ] **Step 1: 创建 AutoCollector**

创建 `src/content/autoCollector.ts`：

```typescript
import type { AutoCollectIntent, AutoCollectPhase, AutoCollectProgress, CachedUserMessage } from '../shared/types';
import { hashText } from '../shared/hash';
import { toPreview, toSearchText } from '../shared/text';
import type { CacheStore } from './cacheStore';
import type { DomAdapter } from './domAdapter';
import type { RuntimeStore } from './runtimeStore';
import type { ScrollDriver } from './scrollDriver';

// --- Internal types ---

interface RawCandidate {
  observedDomMessageId: string | null;
  text: string;
  textHash: string;
  preview: string;
  textForSearch: string;
  batchIndex: number;
  domIndexInBatch: number;
  absoluteTop: number;  // 修正 #2: 稳定位置，用于去重
}

interface CollectedBatch {
  batchIndex: number;
  scrollTop: number;
  scrollRatio: number;
  candidates: RawCandidate[];
}

// --- Constants ---

const INTENT_KEY = 'cqn-auto-collect-intent';
const MAX_ROUNDS = 500;
const SCROLL_STEP_RATIO = 0.75; // 每步滚动 75% viewport，保留 25% overlap
const SETTLE_STABLE_MS = 500;
const SETTLE_QUIET_MS = 400;
const SETTLE_TIMEOUT_MS = 5000;
const SETTLE_POLL_MS = 100;
const NO_NEW_CANDIDATES_LIMIT = 5;
const ABSOLUTE_TOP_BUCKET = 100; // absoluteTop 去重桶大小（px）

// --- AutoCollector ---

export class AutoCollector {
  private phase: AutoCollectPhase = 'idle';
  private cancelRequested = false;
  private foundCount = 0;
  private round = 0;
  private currentConversationId = '';
  private errorMessage = '';
  private progressListeners = new Set<(p: AutoCollectProgress) => void>();
  private cleanupUserScroll: (() => void) | null = null;

  constructor(
    private readonly domAdapter: DomAdapter,
    private readonly cacheStore: CacheStore,
    private readonly scrollDriver: ScrollDriver,
    private readonly runtimeStore: RuntimeStore,
    private readonly afterReplace?: () => Promise<void>,  // 修正 #5: 回调替代 scanner 依赖
  ) {}

  // --- Public API ---

  getProgress(): AutoCollectProgress {
    return {
      phase: this.phase,
      conversationId: this.currentConversationId,
      foundCount: this.foundCount,
      round: this.round,
      errorMessage: this.errorMessage || undefined,
    };
  }

  onProgress(listener: (p: AutoCollectProgress) => void): () => void {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  cancel(): void {
    this.cancelRequested = true;
  }

  async startFullCollection(conversationId: string): Promise<void> {
    if (this.phase !== 'idle' && this.phase !== 'completed' && this.phase !== 'cancelled' && this.phase !== 'failed') {
      return;
    }

    this.currentConversationId = conversationId;
    this.cancelRequested = false;
    this.foundCount = 0;
    this.round = 0;
    this.errorMessage = '';

    try {
      this.setPhase('preparing');
      this.registerUserScrollListener();

      // Scroll to bottom
      this.scrollDriver.scrollToRatio(1);
      await this.waitForPageSettled();

      if (this.cancelRequested) { this.setPhase('cancelled'); return; }

      // Trivial case: short conversation
      const metrics = this.scrollDriver.getMetrics();
      if (metrics.maxScrollTop <= 8) {
        const batch = await this.extractCurrentBatch(0);
        await this.finalize([batch], conversationId);
        return;
      }

      this.setPhase('collecting');

      const batches: CollectedBatch[] = [];
      let consecutiveNoNew = 0;
      // 修正 #2: 使用稳定 key 追踪 foundCount
      const seenKeys = new Set<string>();

      while (this.round < MAX_ROUNDS && !this.cancelRequested) {
        const batch = await this.extractCurrentBatch(this.round);

        let newCount = 0;
        for (const c of batch.candidates) {
          // 修正 #2: 临时 key 基于稳定标识，不含 batchIndex
          const tempKey = c.observedDomMessageId
            ? `dom:${c.observedDomMessageId}`
            : `hash:${c.textHash}:@${Math.floor(c.absoluteTop / ABSOLUTE_TOP_BUCKET)}`;
          if (!seenKeys.has(tempKey)) {
            seenKeys.add(tempKey);
            newCount++;
          }
        }

        batches.push(batch);
        this.foundCount = seenKeys.size;
        this.round++;
        this.emitProgress();

        if (newCount === 0) {
          consecutiveNoNew++;
        } else {
          consecutiveNoNew = 0;
        }

        const currentScrollTop = this.scrollDriver.getScrollTop();
        if (currentScrollTop <= 8 && consecutiveNoNew >= 2) break;

        // 修正 #9: 滚动 75% viewport
        const step = Math.floor(this.scrollDriver.getClientHeight() * SCROLL_STEP_RATIO);
        const beforeTop = this.scrollDriver.getScrollTop();
        this.scrollDriver.scrollBy(-step);
        await this.waitForPageSettled();

        const afterTop = this.scrollDriver.getScrollTop();
        const noMovement = Math.abs(afterTop - beforeTop) < 2;

        if (noMovement && afterTop <= 8) break;
        if (noMovement && consecutiveNoNew >= NO_NEW_CANDIDATES_LIMIT) break;
      }

      if (this.cancelRequested) {
        this.setPhase('cancelled');
        return;
      }

      // Final batch at very top
      if (this.scrollDriver.getScrollTop() > 0) {
        this.scrollDriver.scrollToRatio(0);
        await this.waitForPageSettled();
        const finalBatch = await this.extractCurrentBatch(this.round);
        batches.push(finalBatch);
      }

      await this.finalize(batches, conversationId);

    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : String(error);
      this.setPhase('failed');
    } finally {
      this.cleanupUserScroll?.();
      this.cleanupUserScroll = null;
    }
  }

  // --- Intent persistence (static) ---

  static async writeIntent(conversationId: string, url: string): Promise<void> {
    const intent: AutoCollectIntent = { conversationId, url, requestedAt: Date.now() };
    await chrome.storage.local.set({ [INTENT_KEY]: intent });
  }

  static async readIntent(): Promise<AutoCollectIntent | null> {
    const result = await chrome.storage.local.get(INTENT_KEY);
    return (result[INTENT_KEY] as AutoCollectIntent | undefined) ?? null;
  }

  static async clearIntent(): Promise<void> {
    await chrome.storage.local.remove(INTENT_KEY);
  }

  // --- Internal: Phase management ---

  private setPhase(phase: AutoCollectPhase): void {
    this.phase = phase;
    this.emitProgress();
    this.runtimeStore.setAutoCollectProgress(this.getProgress());
  }

  private emitProgress(): void {
    const progress = this.getProgress();
    this.progressListeners.forEach((listener) => listener(progress));
  }

  // --- Internal: User scroll detection ---

  private registerUserScrollListener(): void {
    this.cleanupUserScroll?.();
    this.cleanupUserScroll = this.scrollDriver.onUserScroll(() => {
      if (this.phase === 'collecting' || this.phase === 'preparing') {
        this.cancelRequested = true;
      }
    });
  }

  // --- Internal: Batch extraction ---

  private async extractCurrentBatch(batchIndex: number): Promise<CollectedBatch> {
    const elements = this.domAdapter.findUserMessages();
    const candidates: RawCandidate[] = [];

    for (let i = 0; i < elements.length; i++) {
      const el = elements[i]!;
      const text = this.domAdapter.extractText(el);
      if (!text) continue;

      candidates.push({
        observedDomMessageId: this.domAdapter.extractObservedId(el),
        text,
        textHash: await hashText(text),
        preview: toPreview(text),
        textForSearch: toSearchText(text),
        batchIndex,
        domIndexInBatch: i,
        absoluteTop: this.scrollDriver.getAbsoluteTop(el),  // 修正 #2: 稳定位置
      });
    }

    return {
      batchIndex,
      scrollTop: this.scrollDriver.getScrollTop(),
      scrollRatio: this.scrollDriver.getScrollRatio(),
      candidates,
    };
  }

  // --- Internal: Canonical merge ---

  private async finalize(batches: CollectedBatch[], conversationId: string): Promise<void> {
    this.setPhase('finalizing');

    const messages = this.mergeBatches(batches, conversationId);
    await this.cacheStore.replaceConversationMessages(conversationId, messages);
    this.runtimeStore.setMessages(messages);

    // 修正 #5: 通过回调让 content.ts 处理 scanner 对齐
    await this.afterReplace?.();

    this.setPhase('completed');
  }

  private mergeBatches(batches: CollectedBatch[], conversationId: string): CachedUserMessage[] {
    // Reverse: collection was bottom-to-top, we need top-to-bottom (oldest first)
    const reversed = [...batches].reverse();

    // 修正 #3: 两种去重追踪
    const seenDomIds = new Set<string>();
    const seenBucketKeys = new Set<string>();  // textHash + absoluteTop bucket
    const canonical: Array<{
      observedDomMessageId: string | null;
      textHash: string;
      preview: string;
      textForSearch: string;
      scrollTop: number;
      scrollRatio: number;
      absoluteTop: number;
    }> = [];

    for (const batch of reversed) {
      for (const candidate of batch.candidates) {
        if (candidate.observedDomMessageId) {
          // domId 去重：精确匹配
          if (seenDomIds.has(candidate.observedDomMessageId)) continue;
          seenDomIds.add(candidate.observedDomMessageId);
          canonical.push({
            observedDomMessageId: candidate.observedDomMessageId,
            textHash: candidate.textHash,
            preview: candidate.preview,
            textForSearch: candidate.textForSearch,
            scrollTop: batch.scrollTop,
            scrollRatio: batch.scrollRatio,
            absoluteTop: candidate.absoluteTop,
          });
          continue;
        }

        // 修正 #3: 无 domId 候选使用 textHash + absoluteTop bucket 去重
        // 同一 batch 内不因 textHash 相同而去重（它们可能有不同的 absoluteTop bucket）
        const bucket = Math.floor(candidate.absoluteTop / ABSOLUTE_TOP_BUCKET);
        const dedupKey = `${candidate.textHash}:@${bucket}`;
        if (seenBucketKeys.has(dedupKey)) continue;
        seenBucketKeys.add(dedupKey);

        canonical.push({
          observedDomMessageId: null,
          textHash: candidate.textHash,
          preview: candidate.preview,
          textForSearch: candidate.textForSearch,
          scrollTop: batch.scrollTop,
          scrollRatio: batch.scrollRatio,
          absoluteTop: candidate.absoluteTop,
        });
      }
    }

    // Build CachedUserMessage[] with orderKey 0..N-1 and localMessageId
    const now = Date.now();
    const occurrenceTracker = new Map<string, number>();

    return canonical.map((c, index) => {
      const occurrenceIndex = occurrenceTracker.get(c.textHash) ?? 0;
      occurrenceTracker.set(c.textHash, occurrenceIndex + 1);

      const localMessageId = c.observedDomMessageId
        ? `${conversationId}::dom::${c.observedDomMessageId}`
        : `${conversationId}::hash::${c.textHash}::${occurrenceIndex}`;

      return {
        conversationId,
        localMessageId,
        role: 'user' as const,
        textForSearch: c.textForSearch,
        preview: c.preview,
        textHash: c.textHash,
        occurrenceIndex,
        firstSeenAt: now,
        lastSeenAt: now,
        lastKnownScrollTop: c.scrollTop,
        lastKnownScrollRatio: c.scrollRatio,
        orderKey: index,
      };
    });
  }

  // --- Internal: Page settle detection ---

  private async waitForPageSettled(): Promise<void> {
    const start = Date.now();
    let lastMutationTime = Date.now();
    let lastScrollTop = this.scrollDriver.getScrollTop();
    let stableSince = Date.now();

    const observer = new MutationObserver(() => {
      lastMutationTime = Date.now();
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    try {
      await this.delay(SETTLE_POLL_MS);

      while (true) {
        if (this.cancelRequested) return;

        const now = Date.now();
        const currentScrollTop = this.scrollDriver.getScrollTop();

        if (Math.abs(currentScrollTop - lastScrollTop) > 2) {
          lastScrollTop = currentScrollTop;
          stableSince = now;
        }

        const scrollStable = (now - stableSince) >= SETTLE_STABLE_MS;
        const domQuiet = (now - lastMutationTime) >= SETTLE_QUIET_MS;
        const timeout = (now - start) >= SETTLE_TIMEOUT_MS;

        if ((scrollStable && domQuiet) || timeout) return;

        await this.delay(SETTLE_POLL_MS);
      }
    } finally {
      observer.disconnect();
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
```

- [ ] **Step 2: 编译验证**

Run: `pnpm compile`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/content/autoCollector.ts
git commit -m "feat: 新增 AutoCollector 模块（状态机、滚动循环、canonical 去重合并、afterReplace 回调）"
```

---

### Task 4: Content Script 编排

**Files:**
- Modify: `entrypoints/content.ts`

**修正 #1**: 在 urlWatcher.start() 之前读取 intent，避免 onConversationChange 回调竞态。
**修正 #5**: 通过 afterReplace 回调解耦 AutoCollector 与 scanner。

- [ ] **Step 1: 挂载 AutoCollector 并重构启动流程**

1. 添加 import：

```typescript
import { AutoCollector } from '../src/content/autoCollector';
```

2. 在 `main(ctx)` 中，scanner 创建之后、urlWatcher 事件绑定之前添加：

```typescript
const autoCollector = new AutoCollector(domAdapter, cacheStore, scrollDriver, runtimeStore, async () => {
  // 修正 #5: afterReplace 回调 — content.ts 负责 scanner 对齐
  scanner.clearState();
  await scanner.rescan();
});
```

3. 添加"重新采集"启动函数（给 UI 用）：

```typescript
const startAutoCollect = async (): Promise<void> => {
  const { conversationId } = runtimeStore.getSnapshot();
  if (!conversationId) return;
  await AutoCollector.writeIntent(conversationId, location.href);
  location.reload();
};
```

4. **修正 #1: 在 urlWatcher.start() 之前读取 intent**

在 `urlWatcher.onConversationChange(...)` 注册之后、`scrollDriver.init()` 之前添加：

```typescript
// 修正 #1: 在 urlWatcher.start() 前读 intent，避免回调竞态
const intent = await AutoCollector.readIntent();
const currentConvId = domAdapter.extractConversationId();
const shouldAutoCollectOnStartup = intent !== null && currentConvId !== null
  && (intent.conversationId === currentConvId || intent.url === location.href);

if (shouldAutoCollectOnStartup) {
  await AutoCollector.clearIntent();
}
```

5. 修改启动序列——原来的 `scrollDriver.init()` + `urlWatcher.start()` + `scanner.start()` 改为条件执行：

```typescript
scrollDriver.init();
urlWatcher.start();

let pollId: number | undefined;

if (shouldAutoCollectOnStartup && currentConvId) {
  // Auto-collect 路径：跳过 scanner.start()，等滚动根就绪后启动采集
  let pollAttempts = 0;
  pollId = window.setInterval(async () => {
    pollAttempts++;
    scrollDriver.redetectScrollRoot(`init-poll-${pollAttempts}`);
    if (scrollDriver.getScrollRoot().element || pollAttempts >= 10) {
      clearInterval(pollId);
      pollId = undefined;
      try {
        await autoCollector.startFullCollection(currentConvId);
      } catch (e) {
        console.error('[CQN] Auto-collect failed:', e);
      }
      // 修正 #5: afterReplace 已在 finalize 内完成 clearState + rescan
      scanner.start();
    }
  }, 1000);
} else {
  scanner.start();

  // 正常启动的 polling redetect
  let pollAttempts = 0;
  pollId = window.setInterval(() => {
    pollAttempts++;
    scrollDriver.redetectScrollRoot(`init-poll-${pollAttempts}`);
    if (scrollDriver.getScrollRoot().element || pollAttempts >= 10) {
      clearInterval(pollId);
      pollId = undefined;
    }
  }, 1000);
}
```

6. 在 `chrome.runtime.onMessage.addListener` 中添加：

```typescript
if (msg.type === 'START_AUTO_COLLECT') {
  const cid = runtimeStore.getSnapshot().conversationId;
  if (cid) {
    startAutoCollect().then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: String(err) }));
    return true;
  }
}
```

7. 更新 `createShadowRootApp` 调用：

```typescript
await createShadowRootApp(ctx, {
  runtimeStore,
  jumpController,
  onClearCurrentSession: clearCurrentSession,
  onStartAutoCollect: startAutoCollect,
  autoCollector,
});
```

8. `beforeunload` 中清理 pollId（现在 pollId 已提升到 if/else 外层声明，可直接引用）：

```typescript
window.addEventListener('beforeunload', () => {
  if (pollId !== undefined) clearInterval(pollId);
  window.removeEventListener('keydown', onDebugKey);
  void cacheStore.flush();
  scanner.stop();
  scrollDriver.destroy();
  urlWatcher.stop();
});
```

- [ ] **Step 2: 编译验证**

Run: `pnpm compile`
Expected: 可能有 ShadowRootApp 类型错误（Task 5 修复）

- [ ] **Step 3: Commit**

```bash
git add entrypoints/content.ts
git commit -m "feat: 挂载 AutoCollector、重构启动流程（urlWatcher.start 前读 intent、afterReplace 回调）"
```

---

### Task 5: UI 层改动

**Files:**
- Modify: `src/ui/ShadowRootApp.tsx`
- Modify: `src/ui/Sidebar.tsx`
- Modify: `src/ui/styles.css`

- [ ] **Step 1: 更新 ShadowRootApp 依赖类型**

修改 `src/ui/ShadowRootApp.tsx`：

```typescript
import { render } from 'preact';
import { createShadowRootUi } from 'wxt/utils/content-script-ui/shadow-root';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import type { AutoCollector } from '../content/autoCollector';
import type { JumpController } from '../content/jumpController';
import type { RuntimeStore } from '../content/runtimeStore';
import { Sidebar } from './Sidebar';

export async function createShadowRootApp(
  ctx: ContentScriptContext,
  deps: {
    runtimeStore: RuntimeStore;
    jumpController: JumpController;
    onClearCurrentSession: () => Promise<void>;
    onStartAutoCollect: () => void;
    autoCollector: AutoCollector;
  }
): Promise<void> {
  const ui = await createShadowRootUi(ctx, {
    name: 'chatgpt-navigator',
    position: 'overlay',
    anchor: 'body',
    onMount(container: HTMLElement) {
      render(
        <Sidebar
          runtimeStore={deps.runtimeStore}
          jumpController={deps.jumpController}
          onClearCurrentSession={deps.onClearCurrentSession}
          onStartAutoCollect={deps.onStartAutoCollect}
          autoCollector={deps.autoCollector}
        />,
        container
      );
      return () => render(null, container);
    },
    onRemove(mounted) {
      if (typeof mounted === 'function') mounted();
    }
  });

  ui.mount();
}
```

- [ ] **Step 2: 更新 Sidebar 组件**

修改 `src/ui/Sidebar.tsx`：

1. 添加 import：

```typescript
import type { AutoCollector } from '../content/autoCollector';
import type { AutoCollectProgress } from '../shared/types';
```

2. 更新 SidebarProps：

```typescript
interface SidebarProps {
  runtimeStore: RuntimeStore;
  jumpController: JumpController;
  onClearCurrentSession: () => Promise<void>;
  onStartAutoCollect: () => void;
  autoCollector: AutoCollector;
}
```

3. 更新函数签名解构参数：

```typescript
export function Sidebar({ runtimeStore, jumpController, onClearCurrentSession, onStartAutoCollect, autoCollector }: SidebarProps) {
```

4. 添加状态和订阅（在现有 useState 声明之后）：

```typescript
const [collectProgress, setCollectProgress] = useState<AutoCollectProgress | null>(null);

useEffect(() => {
  return autoCollector.onProgress(setCollectProgress);
}, [autoCollector]);
```

5. 在展开模式 header 的 `<div style={{ display: 'flex', gap: '4px' }}>` 内最前面，清除按钮之前，添加采集按钮：

```tsx
{snapshot.conversationId && (
  <button
    className="cqn-collapse"
    type="button"
    onClick={() => {
      const p = autoCollector.getProgress();
      if (p.phase === 'collecting' || p.phase === 'preparing' || p.phase === 'finalizing') {
        autoCollector.cancel();
      } else {
        onStartAutoCollect();
      }
    }}
    disabled={clearing}
    title={
      collectProgress?.phase === 'collecting' ? '取消采集' :
      collectProgress?.phase === 'preparing' ? '准备中...' :
      '重新采集本对话'
    }
  >
    {collectProgress?.phase === 'collecting' || collectProgress?.phase === 'preparing' || collectProgress?.phase === 'finalizing' ? (
      <span className="cqn-collect-spinner">↻</span>
    ) : (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="23 4 23 10 17 10" />
        <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
      </svg>
    )}
  </button>
)}
```

6. 替换状态行，原来的：

```tsx
{!clearing && (
  <div className="cqn-status">
    Indexed {snapshot.messages.length} questions locally
  </div>
)}
```

替换为：

```tsx
{!clearing && (
  <div className="cqn-status">
    {collectProgress?.phase === 'collecting'
      ? `Collecting... ${collectProgress.foundCount} found`
      : collectProgress?.phase === 'preparing'
        ? 'Preparing collection...'
        : collectProgress?.phase === 'finalizing'
          ? 'Finalizing...'
          : collectProgress?.phase === 'cancelled'
            ? 'Collection cancelled'
            : collectProgress?.phase === 'failed'
              ? `Collection failed: ${collectProgress.errorMessage ?? 'unknown'}`
              : collectProgress?.phase === 'completed'
                ? `Collected ${snapshot.messages.length} questions`
                : `Indexed ${snapshot.messages.length} questions locally`
    }
  </div>
)}
```

- [ ] **Step 3: 添加 spinner 样式**

在 `src/ui/styles.css` 的 `@media (prefers-color-scheme: light)` 之前添加：

```css
.cqn-collect-spinner {
  display: inline-block;
  animation: cqn-spin 1s linear infinite;
}

@keyframes cqn-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
```

- [ ] **Step 4: 编译验证**

Run: `pnpm compile`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui/ShadowRootApp.tsx src/ui/Sidebar.tsx src/ui/styles.css
git commit -m "feat: UI 层添加自动采集按钮和进度显示"
```

---

### Task 6: 验证与收尾

- [ ] **Step 1: 完整编译和构建**

Run:
```bash
pnpm compile
pnpm build
```
Expected: Both PASS

- [ ] **Step 2: 更新文件树文档**

更新 `docs/Tree.md`：添加 `src/content/autoCollector.ts` 条目。

- [ ] **Step 3: 手工验收测试清单**

1. `pnpm build` 成功
2. 加载扩展到 Chrome，打开一个长 ChatGPT 对话
3. 侧栏显示"重新采集"按钮（循环箭头图标）
4. 点击按钮 → 页面刷新
5. 刷新后自动滚到底部，然后自动向上滚动
6. 采集中侧栏显示 "Collecting... N found"
7. 到达顶部后停止，显示 "Collected N questions"
8. Q1 是最早的用户问题，最后一个 Q 是最新的
9. 从顶部手动滚到底部，Q 编号不再重排（canonical 模式保护 orderedIds）
10. 刷新页面后 Q 编号仍然稳定
11. 点击已挂载消息能直接跳转并高亮（afterReplace 回调对齐了 mounted state）
12. 搜索和 hover 预览正常
13. DevTools 控制台无持续报错
14. `chrome.storage.local` 中无残留 autoCollectIntent
15. 采集过程中手动滚动 → 采集取消
16. 短对话（< 5 条消息）也能正确采集

- [ ] **Step 4: Commit 文档更新**

```bash
git add docs/Tree.md
git commit -m "docs: 更新文件树，添加 AutoCollector"
```

---

## Verification Summary

- `pnpm compile` — TypeScript 类型检查
- `pnpm build` — 生产构建
- 手工验收：16 项测试清单

## 关键设计决策

1. **orderedIds 保护**: canonical 模式下 `resolveScannedSegments()` 不调用 `mergeOrderedSegments`，只 append 新消息到末尾。`ConversationCache.orderMode` 字段标记模式。
2. **replaceConversationMessages 原子写入**: 同时写入 messages + orderedIds + orderMode='canonical'。
3. **启动流程无竞态**: 在 urlWatcher.start() 之前读取 intent，用 domAdapter.extractConversationId() 计算应否自动采集，避免 onConversationChange 回调的异步竞态。
4. **AutoCollector 与 scanner 解耦**: 通过 afterReplace 回调，AutoCollector 不依赖 MessageScanner。content.ts 负责在 finalize 后调用 scanner.clearState() + rescan() + start()。
5. **稳定去重 key**: foundCount 追踪使用 observedDomMessageId 或 textHash + absoluteTop bucket（100px），不使用 batchIndex。mergeBatches 同理。
6. **resolveScannedSegments preserve orderMode**: 使用 spread 保留已有 currentCache 的 orderMode 字段。
7. **滚动步长 75%**: SCROLL_STEP_RATIO = 0.75，兼顾速度与 overlap 覆盖。
