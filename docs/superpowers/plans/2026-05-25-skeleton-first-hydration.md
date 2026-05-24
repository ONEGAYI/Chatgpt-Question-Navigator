# Skeleton-First Hydration 采集重构 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 AutoCollector 从"滚动发现消息"模式改为"先扫描所有 turn skeleton，再滚动水合"模式，确保在 ChatGPT 一次性挂载完整 turn skeleton（包含 0 高度空壳）的场景下可靠工作。

**Architecture:** AutoCollector 启动后先 `await scanAllTurnSkeletons()` 获取所有 turn 框架（包括 0 高度空壳），然后通过 bottom-to-top 滚动逐个水合（hydration）这些框架。水合完成后按 turnIndex 升序构建 canonical 消息列表。localMessageId 统一使用 `convId::turn::turnKey` 格式，CacheStore 和 MessageScanner 同步适配以保持 mounted 状态匹配。

**Tech Stack:** TypeScript (strict), WXT, Preact, chrome.storage.local

## 前置依赖确认

本计划依赖 v3 基础设施，当前分支 `feat/realtime-collect-list` 已具备以下全部能力（已验证）：

- `AutoCollectPhase` / `AutoCollectProgress` / `AutoCollectIntent` 类型（`src/shared/types.ts`）
- `RuntimeStore.setAutoCollectProgress()` 方法（`src/content/runtimeStore.ts:70`）
- `CacheStore.replaceConversationMessages()` 方法（`src/content/cacheStore.ts:76`）
- `ConversationCache.orderMode` canonical 保护逻辑（`cacheStore.ts:167-181`）
- `content.ts` 中 AutoCollector 实例化与 intent 恢复（`entrypoints/content.ts:16-106`）
- `Sidebar.tsx` 中采集按钮与 `getStatusText()` 函数（`src/ui/Sidebar.tsx:14-30`）

**重要约束：** `resolveScannedSegments()` 在 `orderMode === 'canonical'` 时仅 append 新 id，不调用 `mergeOrderedSegments` 重排已有 orderedIds。本计划不修改此行为。

---

## 文件变更清单

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/shared/types.ts` | 修改 | 添加 TurnFrame 接口、更新 AutoCollectProgress 和 ScannedUserMessageCandidate |
| `src/content/domAdapter.ts` | 修改 | 添加 turn skeleton 扫描、角色识别、文本提取方法 |
| `src/content/cacheStore.ts` | 修改 | 适配 turn-based localMessageId 的创建和匹配 |
| `src/content/messageScanner.ts` | 修改 | 扫描时从 turn 祖先推导 turnKey，传递给 CacheStore |
| `src/content/autoCollector.ts` | 重写 | 骨架扫描 → 水合循环 → fallback → 构建 canonical 消息 |
| `src/ui/Sidebar.tsx` | 修改 | 更新采集进度文本显示，含水合统计 |

---

### Task 1: 更新类型定义

**Files:**
- Modify: `src/shared/types.ts`

- [ ] **Step 1: 在 AutoCollector types 区段添加 TurnFrame 接口**

在 `src/shared/types.ts` 文件末尾（第 103 行之后）添加：

```typescript
// --- TurnFrame types ---

export interface TurnFrame {
  turnKey: string;
  turnIndex: number;
  role: 'user' | 'assistant' | 'unknown';
  hydrated: boolean;
  observedDomMessageId: string | null;
  textHash: string | null;
  preview: string | null;
  textForSearch: string | null;
  lastKnownScrollTop: number;
  lastKnownScrollRatio: number;
  lastHydratedAt: number | null;
}
```

- [ ] **Step 2: 更新 AutoCollectProgress 添加水合统计字段**

替换第 90-96 行的 `AutoCollectProgress` 接口：

```typescript
export interface AutoCollectProgress {
  phase: AutoCollectPhase;
  conversationId: string;
  foundCount: number;
  round: number;
  errorMessage?: string;
  totalTurns?: number;
  hydratedCount?: number;
  unhydratedCount?: number;
}
```

- [ ] **Step 3: 在 ScannedUserMessageCandidate 中添加 turnKey 字段**

在第 39 行 `element: HTMLElement;` 之后添加：

```typescript
  turnKey: string | null;
```

- [ ] **Step 4: 运行类型检查验证**

Run: `pnpm compile`
Expected: 可能有未使用的 import 报错（因为引用方还没更新），但类型本身不应报错

---

### Task 2: DomAdapter 添加 turn skeleton 扫描

**Files:**
- Modify: `src/content/domAdapter.ts`

- [ ] **Step 1: 在 SELECTORS 常量中添加 turnSkeleton 选择器**

在第 7 行 `excludeButtons` 之后添加：

```typescript
  turnSkeleton: 'section[data-testid^="conversation-turn-"]',
```

- [ ] **Step 2: 添加 turn skeleton 相关方法**

在 `extractObservedId` 方法（第 32-38 行）之后添加以下方法：

```typescript
  findTurnSkeletons(): HTMLElement[] {
    return Array.from(document.querySelectorAll<HTMLElement>(SELECTORS.turnSkeleton));
  }

  extractTurnKey(el: HTMLElement): string | null {
    const testId = el.getAttribute('data-testid');
    if (!testId?.startsWith('conversation-turn-')) return null;
    return testId;
  }

  extractTurnIndex(turnKey: string): number {
    const match = turnKey.match(/^conversation-turn-(\d+)$/);
    return match ? parseInt(match[1]!, 10) : -1;
  }

  extractTurnRole(el: HTMLElement): 'user' | 'assistant' | 'unknown' {
    if (el.querySelector('[data-message-author-role="user"]')) return 'user';
    if (el.querySelector('[data-message-author-role="assistant"]')) return 'assistant';
    return 'unknown';
  }

  findTurnKeyForElement(el: HTMLElement): string | null {
    const turnEl = el.closest<HTMLElement>(SELECTORS.turnSkeleton);
    if (!turnEl) return null;
    return this.extractTurnKey(turnEl);
  }
```

- [ ] **Step 3: 运行类型检查**

Run: `pnpm compile`

---

### Task 3: CacheStore 适配 turn-based localMessageId

**Files:**
- Modify: `src/content/cacheStore.ts`

- [ ] **Step 1: 更新 matchCandidate 添加 turn-based 匹配路径**

在第 294 行 `matchCandidate` 方法的开头（现有 `if (candidate.observedDomMessageId)` 之前）添加 turn-based 匹配逻辑。

将 `matchCandidate` 方法（第 294-318 行）替换为：

```typescript
  private matchCandidate(
    conversationId: string,
    candidate: StoredCandidate,
    existing: CachedUserMessage[],
    usedExisting: Set<string>
  ): CachedUserMessage | null {
    if (candidate.turnKey) {
      const turnId = `${conversationId}::turn::${candidate.turnKey}`;
      const matched = existing.find((message) => message.localMessageId === turnId && !usedExisting.has(message.localMessageId));
      if (matched) return matched;
    }

    if (candidate.observedDomMessageId) {
      const domId = `${conversationId}::dom::${candidate.observedDomMessageId}`;
      const exact = existing.find((message) => message.localMessageId === domId && !usedExisting.has(message.localMessageId));
      if (exact) return exact;
    }

    const sameHash = existing
      .filter((message) => message.textHash === candidate.textHash && !usedExisting.has(message.localMessageId))
      .map((message) => ({
        message,
        distance: Math.abs(message.lastKnownScrollRatio - candidate.scrollRatio)
      }))
      .sort((a, b) => a.distance - b.distance);

    const best = sameHash[0];
    if (!best) return null;
    if (Math.abs(best.message.lastKnownScrollRatio - candidate.scrollRatio) > 0.15) return null;
    return best.message;
  }
```

- [ ] **Step 2: 更新 createLocalMessageId 支持 turn 格式**

将第 332-335 行的 `createLocalMessageId` 方法替换为：

```typescript
  private createLocalMessageId(conversationId: string, observedDomMessageId: string | null, textHash: string, occurrenceIndex: number, turnKey?: string | null): string {
    if (turnKey) return `${conversationId}::turn::${turnKey}`;
    if (observedDomMessageId) return `${conversationId}::dom::${observedDomMessageId}`;
    return `${conversationId}::hash::${textHash}::${occurrenceIndex}`;
  }
```

- [ ] **Step 3: 更新 resolveScannedSegments 中的 createLocalMessageId 调用**

在第 121 行，更新 `createLocalMessageId` 调用，传入 `candidate.turnKey`：

```typescript
        const localMessageId = matched?.localMessageId ?? this.createLocalMessageId(conversationId, candidate.observedDomMessageId, candidate.textHash, occurrenceIndex, candidate.turnKey);
```

- [ ] **Step 4: 更新 StoredCandidate 类型定义**

在第 11 行，`StoredCandidate` 的定义已经通过 `Omit<ScannedUserMessageCandidate, 'element'>` 自动包含新增的 `turnKey` 字段，无需额外修改。

- [ ] **Step 5: 运行类型检查**

Run: `pnpm compile`

---

### Task 4: MessageScanner 适配 turn-based ID

**Files:**
- Modify: `src/content/messageScanner.ts`

- [ ] **Step 1: 在 rescan 中为候选添加 turnKey**

在 `rescan()` 方法的候选生成循环中（第 94-110 行），在 `candidates.push(...)` 调用中添加 `turnKey` 字段。

将第 94-110 行的 for 循环替换为：

```typescript
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

- [ ] **Step 2: 运行类型检查**

Run: `pnpm compile`

Expected: 通过。如果 StoredCandidateSegment 的 candidate 类型报错，确认 `Omit<ScannedUserMessageCandidate, 'element'>` 是否正确传递了 `turnKey`。

---

### Task 5: 重写 AutoCollector

**Files:**
- Modify: `src/content/autoCollector.ts`

这是最核心的任务。将整个 AutoCollector 类重写为 skeleton-first hydration 模式。

- [ ] **Step 1: 替换内部类型和常量**

将第 9-38 行（从 `// --- Internal types ---` 到 `NO_NEW_CANDIDATES_LIMIT`）替换为：

```typescript
// --- Internal types ---
// TurnFrame is imported from types

// --- Constants ---

const INTENT_KEY = 'cqn-auto-collect-intent';
const MAX_ROUNDS = 500;
const SCROLL_STEP_RATIO = 0.7; // 固定步长，方便调试和复现
const SETTLE_STABLE_MS = 500;
const SETTLE_QUIET_MS = 400;
const SETTLE_TIMEOUT_MS = 5000;
const SETTLE_POLL_MS = 100;
const STAGNANT_LIMIT = 3;
const NO_MOVEMENT_LIMIT = 5;
const FALLBACK_MAX_ROUNDS = 50;
```

- [ ] **Step 2: 更新类属性**

将第 42-58 行的类定义（从 `export class AutoCollector` 到构造函数结束）替换为：

```typescript
export class AutoCollector {
  private phase: AutoCollectPhase = 'idle';
  private cancelRequested = false;
  private foundCount = 0;
  private round = 0;
  private currentConversationId = '';
  private errorMessage = '';
  private progressListeners = new Set<(p: AutoCollectProgress) => void>();
  private cleanupUserScroll: (() => void) | null = null;
  private frames = new Map<string, TurnFrame>();

  constructor(
    private readonly domAdapter: DomAdapter,
    private readonly cacheStore: CacheStore,
    private readonly scrollDriver: ScrollDriver,
    private readonly runtimeStore: RuntimeStore,
    private readonly afterReplace?: () => Promise<void>,
  ) {}
```

- [ ] **Step 3: 更新 emitProgress 添加水合统计**

将第 204-208 行的 `emitProgress` 方法替换为：

```typescript
  private emitProgress(): void {
    const progress = this.getProgress();
    const totalFrames = this.frames.size;
    const hydrated = this.countHydrated();
    progress.totalTurns = totalFrames;
    progress.hydratedCount = hydrated;
    progress.unhydratedCount = totalFrames - hydrated;
    this.progressListeners.forEach((listener) => listener(progress));
    this.runtimeStore.setAutoCollectProgress(progress);
  }
```

- [ ] **Step 4: 删除旧的 extractCurrentBatch 和 mergeBatches 方法**

删除第 221-343 行（从 `// --- Internal: Batch extraction ---` 到 `mergeBatches` 方法结束）。

- [ ] **Step 5: 添加新的核心方法 — scanAllTurnSkeletons**

在 `waitForPageSettled` 方法之前添加：

```typescript
  // --- Internal: Skeleton scanning & hydration ---

  private async scanAllTurnSkeletons(): Promise<void> {
    const skeletons = this.domAdapter.findTurnSkeletons();

    for (const el of skeletons) {
      const turnKey = this.domAdapter.extractTurnKey(el);
      if (!turnKey) continue;
      const turnIndex = this.domAdapter.extractTurnIndex(turnKey);
      if (turnIndex < 0) continue;

      const existing = this.frames.get(turnKey);
      if (existing) {
        await this.tryHydrateFrame(el, existing);
      } else {
        const frame: TurnFrame = {
          turnKey,
          turnIndex,
          role: 'unknown',
          hydrated: false,
          observedDomMessageId: null,
          textHash: null,
          preview: null,
          textForSearch: null,
          lastKnownScrollTop: this.scrollDriver.getScrollTop(),
          lastKnownScrollRatio: this.scrollDriver.getScrollRatio(),
          lastHydratedAt: null,
        };
        await this.tryHydrateFrame(el, frame);
        this.frames.set(turnKey, frame);
      }
    }
  }

  private async tryHydrateFrame(el: HTMLElement, frame: TurnFrame): Promise<void> {
    if (frame.hydrated) return;

    const rect = el.getBoundingClientRect();
    if (rect.height === 0) return;

    const role = this.domAdapter.extractTurnRole(el);
    if (role === 'unknown') return;

    if (role === 'user') {
      const userEl = el.querySelector<HTMLElement>('[data-message-author-role="user"]');
      if (!userEl) return;
      const text = this.domAdapter.extractText(userEl);
      if (!text) return;

      frame.observedDomMessageId = this.domAdapter.extractObservedId(userEl);
      frame.textHash = await hashText(text);
      frame.preview = toPreview(text);
      frame.textForSearch = toSearchText(text);
    }
    // assistant turn 只需 role recognition 即视为 hydrated；
    // 最终 Q 列表只由 user frames 生成，无需保存 assistant 文本。

    frame.role = role;
    frame.hydrated = true;
    frame.lastHydratedAt = Date.now();
    frame.lastKnownScrollTop = this.scrollDriver.getScrollTop();
    frame.lastKnownScrollRatio = this.scrollDriver.getScrollRatio();
  }
```

- [ ] **Step 6: 添加 buildUserMessagesFromFrames 方法**

在 `tryHydrateFrame` 之后添加：

```typescript
  private buildUserMessagesFromFrames(conversationId: string): CachedUserMessage[] {
    const sortedFrames = [...this.frames.values()]
      .sort((a, b) => a.turnIndex - b.turnIndex);

    const userFrames = sortedFrames.filter(
      (f) => f.role === 'user' && f.hydrated && f.textHash !== null
    );

    const now = Date.now();
    return userFrames.map((frame, index) => ({
      conversationId,
      localMessageId: `${conversationId}::turn::${frame.turnKey}`,
      role: 'user' as const,
      textForSearch: frame.textForSearch!,
      preview: frame.preview!,
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

- [ ] **Step 7: 添加统计辅助方法**

在 `buildUserMessagesFromFrames` 之后添加：

```typescript
  private countHydrated(): number {
    let count = 0;
    for (const frame of this.frames.values()) {
      if (frame.hydrated) count++;
    }
    return count;
  }

  private countHydratedUserMessages(): number {
    let count = 0;
    for (const frame of this.frames.values()) {
      if (frame.role === 'user' && frame.hydrated && frame.textHash !== null) count++;
    }
    return count;
  }
```

- [ ] **Step 8: 重写 finalize 方法**

将第 254-264 行的 `finalize` 方法替换为：

```typescript
  private async finalize(conversationId: string): Promise<void> {
    this.setPhase('finalizing');

    const messages = this.buildUserMessagesFromFrames(conversationId);
    await this.cacheStore.replaceConversationMessages(conversationId, messages);
    this.runtimeStore.setMessages(messages);

    await this.afterReplace?.();

    this.setPhase('completed');
  }
```

- [ ] **Step 9: 重写 startFullCollection 主循环**

将第 84-179 行的 `startFullCollection` 方法替换为：

```typescript
  async startFullCollection(conversationId: string): Promise<void> {
    if (this.phase !== 'idle' && this.phase !== 'completed' && this.phase !== 'cancelled' && this.phase !== 'failed') {
      return;
    }

    this.currentConversationId = conversationId;
    this.cancelRequested = false;
    this.foundCount = 0;
    this.round = 0;
    this.errorMessage = '';
    this.frames = new Map();

    try {
      this.setPhase('preparing');
      this.registerUserScrollListener();

      this.scrollDriver.scrollToRatio(1);
      await this.waitForPageSettled();

      if (this.cancelRequested) { this.setPhase('cancelled'); return; }

      // Phase 1: Scan all turn skeletons
      await this.scanAllTurnSkeletons();
      this.setPhase('collecting');
      this.runtimeStore.setMessages([]);

      const metrics = this.scrollDriver.getMetrics();
      if (metrics.maxScrollTop <= 8) {
        await this.finalize(conversationId);
        return;
      }

      // Phase 2: Bottom-to-top hydration loop
      let stagnantRounds = 0;

      while (this.round < MAX_ROUNDS && !this.cancelRequested) {
        const hydratedBefore = this.countHydrated();

        await this.scanAllTurnSkeletons();

        const hydratedAfter = this.countHydrated();
        this.foundCount = this.countHydratedUserMessages();
        this.round++;

        this.runtimeStore.setMessages(
          this.buildUserMessagesFromFrames(conversationId)
        );
        this.emitProgress();

        // End conditions
        if (this.frames.size - hydratedAfter === 0) break;

        if (hydratedAfter === hydratedBefore) {
          stagnantRounds++;
        } else {
          stagnantRounds = 0;
        }

        const scrollTop = this.scrollDriver.getScrollTop();
        if (scrollTop <= 8 && stagnantRounds >= STAGNANT_LIMIT) break;

        // Scroll up
        const step = Math.floor(this.scrollDriver.getClientHeight() * SCROLL_STEP_RATIO);
        const beforeTop = this.scrollDriver.getScrollTop();
        this.scrollDriver.scrollBy(-step);
        await this.waitForPageSettled();

        const afterTop = this.scrollDriver.getScrollTop();
        const noMovement = Math.abs(afterTop - beforeTop) < 2;

        if (noMovement && afterTop <= 8) break;
        if (noMovement && stagnantRounds >= NO_MOVEMENT_LIMIT) break;
      }

      if (this.cancelRequested) {
        this.setPhase('cancelled');
        return;
      }

      // Phase 3: Optional top-to-bottom fallback hydration
      const unhydrated = [...this.frames.values()].filter((f) => !f.hydrated);
      if (unhydrated.length > 0) {
        await this.runFallbackHydration();
      }

      await this.finalize(conversationId);

    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : String(error);
      this.setPhase('failed');
    } finally {
      this.cleanupUserScroll?.();
      this.cleanupUserScroll = null;
    }
  }
```

- [ ] **Step 10: 添加 runFallbackHydration 方法**

在 `startFullCollection` 之后添加：

```typescript
  private async runFallbackHydration(): Promise<void> {
    this.scrollDriver.scrollToRatio(0);
    await this.waitForPageSettled();

    let fallbackRound = 0;
    let stagnantRounds = 0;

    while (fallbackRound < FALLBACK_MAX_ROUNDS && !this.cancelRequested) {
      const hydratedBefore = this.countHydrated();

      await this.scanAllTurnSkeletons();

      const hydratedAfter = this.countHydrated();

      if (hydratedAfter > hydratedBefore) {
        stagnantRounds = 0;
        this.foundCount = this.countHydratedUserMessages();
        this.runtimeStore.setMessages(
          this.buildUserMessagesFromFrames(this.currentConversationId)
        );
        this.emitProgress();
      } else {
        stagnantRounds++;
      }

      if (this.frames.size - hydratedAfter === 0) break;
      if (stagnantRounds >= STAGNANT_LIMIT) break;

      const step = Math.floor(this.scrollDriver.getClientHeight() * SCROLL_STEP_RATIO);
      const beforeTop = this.scrollDriver.getScrollTop();
      this.scrollDriver.scrollBy(step);
      await this.waitForPageSettled();

      const afterTop = this.scrollDriver.getScrollTop();
      if (Math.abs(afterTop - beforeTop) < 2) break;

      fallbackRound++;
    }
  }
```

- [ ] **Step 11: 更新 import 添加 TurnFrame**

将第 1 行的 import 替换为：

```typescript
import type { AutoCollectIntent, AutoCollectPhase, AutoCollectProgress, CachedUserMessage, TurnFrame } from '../shared/types';
```

- [ ] **Step 12: 运行类型检查**

Run: `pnpm compile`
Expected: 通过。检查是否有遗漏的类型引用。

---

### Task 6: 更新 UI 采集进度显示

**Files:**
- Modify: `src/ui/Sidebar.tsx`

- [ ] **Step 1: 更新 getStatusText 函数**

将第 24-30 行的 `getStatusText` 函数替换为：

```typescript
function getStatusText(phase: AutoCollectPhase | null | undefined, progress: { foundCount: number; hydratedCount?: number; totalTurns?: number; unhydratedCount?: number; errorMessage?: string } | null, messageCount: number): string {
  if (!phase || phase === 'idle') return `Indexed ${messageCount} questions locally`;
  if (phase === 'collecting') {
    const hydrated = progress?.hydratedCount ?? 0;
    const total = progress?.totalTurns ?? 0;
    const found = progress?.foundCount ?? 0;
    return `Collecting... ${found} questions (${hydrated}/${total} turns)`;
  }
  if (phase === 'completed') {
    const unhydrated = progress?.unhydratedCount ?? 0;
    if (unhydrated > 0) {
      return `Collected ${messageCount} questions, ${unhydrated} turns unhydrated`;
    }
    return `Collected ${messageCount} questions`;
  }
  if (phase === 'failed') return `Collection failed: ${progress?.errorMessage ?? 'unknown'}`;
  return STATUS_TEXT[phase];
}
```

- [ ] **Step 2: 运行类型检查**

Run: `pnpm compile`

---

### Task 7: 编译检查与集成验证

**Files:**
- 所有修改的文件

- [ ] **Step 1: 运行完整 TypeScript 编译检查**

Run: `pnpm compile`
Expected: 0 errors

- [ ] **Step 2: 运行生产构建**

Run: `pnpm build`
Expected: 构建成功，输出到 `.output/chrome-mv3`

- [ ] **Step 3: 手动验证清单**

在 Chrome 中加载构建产物，执行以下验证：

1. **基本采集流程**：打开一个 ChatGPT 长对话 → 点击重新采集按钮 → 观察进度文本应显示水合统计（`Collecting... X questions (Y/Z turns)`）
2. **完成状态**：采集完成后，状态应显示 `Collected N questions` 或带 unhydrated 计数
3. **消息列表实时更新**：采集过程中消息列表应逐步显示已发现的用户问题
4. **取消功能**：采集过程中点击取消按钮，状态应变为 `Collection cancelled`
5. **采集后 rescan**：采集完成后，滚动页面时 MessageScanner 的 mounted 状态应正确标记（验证 turn-based ID 匹配是否正常）
6. **跳转功能**：点击列表中的消息项，页面应跳转到对应位置
7. **跨 reload 恢复**：触发采集 → 等待页面 reload → 采集应自动恢复

---

## 自查清单

### 1. Spec 覆盖度

| Spec 要求 | 对应 Task |
|-----------|-----------|
| scanAllTurnSkeletons() async + await tryHydrateFrame | Task 5 Step 5 |
| TurnFrame 接口及所有字段 | Task 1 Step 1 |
| 滚动只做 hydration，不改变 frame 顺序 | Task 5 Step 9（scanAllTurnSkeletons 只回填，不重建） |
| 不对 0 高度 empty turn 调用 scrollElementIntoView | Task 5 Step 5（tryHydrateFrame 检查 rect.height === 0 直接 return） |
| 结束条件：scrollTop<=8 + stagnant、all hydrated、MAX_ROUNDS | Task 5 Step 9 |
| buildUserMessagesFromFrames() | Task 5 Step 6 |
| localMessageId = convId::turn::turnKey | Task 5 Step 6, Task 3 Step 2 |
| MessageScanner 从 turn 推导 localMessageId | Task 4 Step 1, Task 3 Step 1 |
| UI 显示 unhydrated 计数 | Task 6 Step 1 |
| fallback hydration pass | Task 5 Step 10 |
| assistant turn 只需 role recognition，不保存文本 | Task 5 Step 5（注释说明） |
| 固定步长 SCROLL_STEP_RATIO = 0.7 | Task 5 Step 1 |
| canonical orderedIds 保护不变 | Task 3 不修改 resolveScannedSegments 的 canonical 分支 |
| v3 基础设施已就绪 | 已确认（见"前置依赖确认"段落） |

### 2. Placeholder 扫描

无 TBD / TODO / "implement later" / "add error handling" 等。

### 3. 类型一致性

- `TurnFrame` 在 types.ts 定义，autoCollector.ts 使用 ✓
- `turnKey` 在 ScannedUserMessageCandidate 添加，MessageScanner 设置、CacheStore 读取 ✓
- `createLocalMessageId` 签名增加 `turnKey` 参数，调用方传入 `candidate.turnKey` ✓
- `AutoCollectProgress` 新增字段可选（`?`），不破坏现有代码 ✓
- `getStatusText` 参数类型扩展兼容 `AutoCollectProgress` 新字段 ✓
