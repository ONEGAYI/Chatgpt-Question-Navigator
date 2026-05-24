# Phase 4: 渐进式跳转 实施计划（修订版）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现未挂载（cached-only）消息的渐进式跳转，包括 scrollRatio 粗定位 + messages index 自适应步进、token 取消机制和 JumpToast UI 组件。

**Architecture:** 重写 `JumpController.jumpToMessage`，在直接跳转失败后启动渐进式循环：attempt 0 用 `scrollRatio` 粗定位，后续用 `decideDirection`（基于 messages 数组 index）+ `scrollOneChunk` 逐步逼近。通过 `JumpToken` + `isCurrent` 实现可取消的异步操作并防止竞态。用户滚动/Esc/新跳转触发取消。新增 `JumpToast` 组件从 RuntimeStore 读取 jumpState 显示进度和失败状态。`VisibleRange` 改为 index-based，`updateScrollMeta` 改用 cacheStore 直接更新方法。

**Tech Stack:** TypeScript, Preact, WXT (createShadowRootUi)

---

## 前置条件

### 顺序模型（已满足 ✓）

`decideDirection` 需要可靠的方向判断。PR #4 后排序权威来源是 `orderedIds` / `RuntimeStore.messages` 数组顺序。

远端提交 `2186b90` 已通过引入 `orderedIds` + `orderList.ts`（anchor-splice 合并模型）解决了此问题：
- 最终排序由 `orderedIds` + `orderMessagesByIds()` 控制
- `VisibleRange` 本计划改为基于数组 `minIndex/maxIndex`（Task 1），完全绕开 orderKey
- `decideDirection` 使用 index 比较方向

**无需额外修复 orderKey。**

---

## 文件结构

### 新建
- `src/ui/JumpToast.tsx` — 跳转状态 Toast 组件

### 修改
- `src/shared/types.ts` — `VisibleRange` 改为 index-based（`minIndex/maxIndex`）
- `src/content/cacheStore.ts` — 新增 `updateMessageScrollMeta` 直接更新方法
- `src/content/scrollDriver.ts` — pointerdown 检测 + markProgrammatic fallback timer + destroy 清理
- `src/content/messageScanner.ts` — `updateScrollMeta` 改用 cacheStore 直接更新 + `computeVisibleRange` 改为 index-based
- `src/content/jumpController.ts` — 核心重写：index-based 方向判断 + JumpToken 竞态守卫 + isConnected 守卫
- `entrypoints/content.ts` — onUserScroll 取消 + Esc 取消
- `src/ui/MessageItem.tsx` — 添加 `isJumping` 状态显示
- `src/ui/Sidebar.tsx` — 渲染 JumpToast，传递 isJumping
- `src/ui/styles.css` — JumpToast 样式 + flex 布局修正

### 更新
- `docs/Tree.md` — 文件树更新
- `CLAUDE.md` — 架构说明更新
- `README.md` — 移除 Phase 4 待实现限制

---

### Task 0: scrollDriver 改进 — pointerdown + markProgrammatic fallback

**Files:**
- Modify: `src/content/scrollDriver.ts`

**两个修改：**
1. 在 `bindListeners` 中添加 `pointerdown` 监听（ChatGPT 主滚动区域滚动条拖拽检测）
2. `markProgrammatic` 添加 200ms fallback timer，确保即使没有 scroll event 也自动清除 `isProgrammatic` 标志

- [ ] **Step 1: 添加 programmaticTimer 字段和修改 markProgrammatic**

在 `src/content/scrollDriver.ts` 中，在 `private cleanupFns` 字段（line 10）之后添加：

```typescript
  private programmaticTimer: number | null = null;
```

将 `markProgrammatic` 方法（line 129-131）替换为：

```typescript
  private markProgrammatic(): void {
    this.isProgrammatic = true;
    if (this.programmaticTimer !== null) window.clearTimeout(this.programmaticTimer);
    this.programmaticTimer = window.setTimeout(() => {
      this.isProgrammatic = false;
      this.programmaticTimer = null;
    }, 200);
  }
```

- [ ] **Step 2: 修改 scroll handler 使用同一个 timer**

将 `bindListeners` 中的 `onScroll`（line 100-107）替换为：

```typescript
    const onScroll = () => {
      this.scrollListeners.forEach((listener) => listener());
      if (this.isProgrammatic) {
        if (this.programmaticTimer !== null) window.clearTimeout(this.programmaticTimer);
        this.programmaticTimer = window.setTimeout(() => {
          this.isProgrammatic = false;
          this.programmaticTimer = null;
        }, 80);
      }
    };
```

- [ ] **Step 3: 添加 pointerdown 监听**

在 `bindListeners` 方法中，在 `window.addEventListener('keydown', onKey);`（原 line 122）之后、cleanup 推入之前，添加 pointerdown 监听器：

找到：
```typescript
    window.addEventListener('keydown', onKey);

    this.cleanupFns.push(() => scrollTarget.removeEventListener('wheel', onWheel));
    this.cleanupFns.push(() => scrollTarget.removeEventListener('touchstart', onTouch));
    this.cleanupFns.push(() => window.removeEventListener('keydown', onKey));
```

替换为：
```typescript
    window.addEventListener('keydown', onKey);

    const onPointer = (event: PointerEvent) => {
      if (this.target === window) {
        const node = event.target as Node | null;
        if (node && node.getRootNode() !== document) return;
      }
      this.notifyUserScroll();
    };
    scrollTarget.addEventListener('pointerdown', onPointer, { passive: true });

    this.cleanupFns.push(() => scrollTarget.removeEventListener('wheel', onWheel));
    this.cleanupFns.push(() => scrollTarget.removeEventListener('touchstart', onTouch));
    this.cleanupFns.push(() => window.removeEventListener('keydown', onKey));
    this.cleanupFns.push(() => scrollTarget.removeEventListener('pointerdown', onPointer));
```

- [ ] **Step 4: 修改 destroy 方法清理 programmaticTimer**

将 `destroy` 方法（line 90-95）替换为：

```typescript
  destroy(): void {
    if (this.programmaticTimer !== null) {
      window.clearTimeout(this.programmaticTimer);
      this.programmaticTimer = null;
    }
    this.isProgrammatic = false;
    this.cleanupFns.forEach((cleanup) => cleanup());
    this.cleanupFns = [];
    this.scrollListeners.clear();
    this.userScrollListeners.clear();
  }
```

- [ ] **Step 5: 编译检查**

Run: `pnpm compile`
Expected: 无错误

- [ ] **Step 6: 提交**

```bash
git add src/content/scrollDriver.ts
git commit -m "feat: scrollDriver 添加 pointerdown 检测、markProgrammatic fallback 和 destroy 清理

- 添加 pointerdown 事件监听用于检测滚动条拖拽（scroll target 为
  window 时过滤 Shadow DOM 事件）
- markProgrammatic 添加 200ms fallback timer，确保即使没有 scroll
  event 触发也能自动清除 isProgrammatic 标志
- destroy 方法清理 programmaticTimer 并重置 isProgrammatic"
```

---

### Task 1: types + cacheStore + messageScanner — index-based 可见范围 + 直接更新 scrollMeta

**Files:**
- Modify: `src/shared/types.ts:65-68`
- Modify: `src/content/cacheStore.ts` — 新增方法
- Modify: `src/content/messageScanner.ts:116-131` + `191-205`

**背景：** PR #4 后排序权威来源是 `orderedIds` / `RuntimeStore.messages` 数组顺序，`orderKey` 只是兼容字段。`decideDirection` 必须基于数组 index 而非 orderKey。同时 `updateScrollMeta` 通过 `resolveScannedCandidates` 重新匹配 candidate 存在误更新风险（重复文本时可能更新错消息），应改为按 `localMessageId` 直接更新。

- [ ] **Step 1: 修改 VisibleRange 类型定义**

将 `src/shared/types.ts` 中的 `VisibleRange` 接口（line 65-68）替换为：

```typescript
export interface VisibleRange {
  minIndex: number;
  maxIndex: number;
}
```

- [ ] **Step 2: 在 CacheStore 增加 updateMessageScrollMeta 方法**

在 `src/content/cacheStore.ts` 中，在 `flush` 方法（line 180-188）之前添加：

```typescript
  updateMessageScrollMeta(
    conversationId: string,
    localMessageId: string,
    scrollTop: number,
    scrollRatio: number
  ): boolean {
    this.ensureCurrentCache(conversationId);
    const messages = this.currentCache!.messages;
    const index = messages.findIndex((m) => m.localMessageId === localMessageId);
    if (index < 0) return false;

    const prev = messages[index]!;
    if (prev.lastKnownScrollTop === scrollTop && prev.lastKnownScrollRatio === scrollRatio) return false;

    messages[index] = { ...prev, lastKnownScrollTop: scrollTop, lastKnownScrollRatio: scrollRatio, lastSeenAt: Date.now() };
    this.dirty = true;
    this.scheduleSave();
    return true;
  }
```

- [ ] **Step 3: 重写 messageScanner.updateScrollMeta**

将 `src/content/messageScanner.ts` 中的 `updateScrollMeta` 方法（line 116-131）替换为：

```typescript
  updateScrollMeta(localId: string, scrollTop: number, scrollRatio: number): void {
    const { conversationId } = this.runtimeStore.getSnapshot();
    if (!conversationId) return;
    this.cacheStore.updateMessageScrollMeta(conversationId, localId, scrollTop, scrollRatio);
  }
```

- [ ] **Step 4: 重写 messageScanner.computeVisibleRange 为 index-based**

将 `src/content/messageScanner.ts` 中的 `computeVisibleRange` 方法（line 191-205）替换为：

```typescript
  private computeVisibleRange(): VisibleRange | null {
    const snapshot = this.runtimeStore.getSnapshot();
    const visibleIndices: number[] = [];

    for (let i = 0; i < snapshot.messages.length; i++) {
      const message = snapshot.messages[i]!;
      const element = this.elementById.get(message.localMessageId);
      if (element && this.domAdapter.isElementInViewport(element)) {
        visibleIndices.push(i);
      }
    }

    if (visibleIndices.length === 0) return null;
    return {
      minIndex: Math.min(...visibleIndices),
      maxIndex: Math.max(...visibleIndices)
    };
  }
```

- [ ] **Step 5: 编译检查**

Run: `pnpm compile`
Expected: 无错误

- [ ] **Step 6: 提交**

```bash
git add src/shared/types.ts src/content/cacheStore.ts src/content/messageScanner.ts
git commit -m "refactor: VisibleRange 改为 index-based + updateScrollMeta 直接更新

- types.ts: VisibleRange 使用 minIndex/maxIndex 替代 minOrderKey/maxOrderKey
- cacheStore: 新增 updateMessageScrollMeta 直接按 localMessageId 更新，
  避免重复文本时 resolveScannedCandidates 匹配错消息
- messageScanner: updateScrollMeta 改用 cacheStore 直接更新方法；
  computeVisibleRange 基于数组 index 计算可见范围"
```

---

### Task 2: 重写 jumpController.ts — 渐进式跳转核心（index-based + 竞态守卫）

**Files:**
- Rewrite: `src/content/jumpController.ts`

**关键设计：**
- `decideDirection` 基于 `messages` 数组 index，不使用 `orderKey`
- `isCurrent(token)` 守卫：所有 await 后、所有 `setJumpState` 前检查
- `jumpToMessage` 成功后（`isCurrent && found`）必须 `setJumpState({ status: 'idle' })`
- 旧跳转完成时不得把新跳转的 `jumping` 状态清成 `idle`
- `targetIndex` 每次 `scanner.rescan()` 后从最新 `runtimeStore.getSnapshot().messages` 重新计算
- `targetIndex < 0` 时设置 `failed` 状态，不保持 `jumping`
- `landOnTarget` 接受 `JumpToken`，返回 `Promise<boolean>`，中断时返回 false
- `el.isConnected` 守卫防止 stale DOM element 误判
- `landOnTarget` 使用 `behavior: 'auto'`（非 smooth），确保 scroll metadata 立即可用
- `updateScrollMeta` 改为同步调用（cacheStore 直接更新方法）
- 渐进式循环最多 30 次，每步 500ms DOM 沉淀
- 会话切换检测：conversationId 不匹配时终止

- [ ] **Step 1: 完整重写 jumpController.ts**

将 `src/content/jumpController.ts` 内容替换为：

```typescript
import type { CachedUserMessage, VisibleRange } from '../shared/types';
import type { CacheStore } from './cacheStore';
import type { MessageScanner } from './messageScanner';
import type { RuntimeStore } from './runtimeStore';
import type { ScrollDriver } from './scrollDriver';

const HIGHLIGHT_CLASS = 'cqn-target-highlight';
const HIGHLIGHT_MS = 1500;
const STYLE_ID = 'cqn-highlight-style';
const MAX_ATTEMPTS = 30;
const SETTLE_MS = 500;

interface JumpToken {
  cancelled: boolean;
  cancel: () => void;
}

let styleInjected = false;

function ensureHighlightStyle(): void {
  if (styleInjected) return;
  if (document.getElementById(STYLE_ID)) {
    styleInjected = true;
    return;
  }
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `.${HIGHLIGHT_CLASS}{outline:2px solid #10a37f!important;outline-offset:4px!important;border-radius:8px!important;transition:outline-color 160ms ease,outline-offset 160ms ease}`;
  document.head.appendChild(style);
  styleInjected = true;
}

function createJumpToken(): JumpToken {
  const token: JumpToken = { cancelled: false, cancel: () => {} };
  token.cancel = () => { token.cancelled = true; };
  return token;
}

function decideDirection(targetIndex: number, visibleRange: VisibleRange | null): 'up' | 'down' {
  if (!visibleRange) return 'down';
  if (targetIndex < visibleRange.minIndex) return 'up';
  return 'down';
}

function waitForDomSettled(ms: number): Promise<void> {
  return new Promise((resolve) => { window.setTimeout(resolve, ms); });
}

export class JumpController {
  private currentToken: JumpToken | null = null;

  constructor(
    private readonly scanner: MessageScanner,
    private readonly cacheStore: CacheStore,
    private readonly scrollDriver: ScrollDriver,
    private readonly runtimeStore: RuntimeStore
  ) {}

  private isCurrent(token: JumpToken): boolean {
    return this.currentToken === token && !token.cancelled;
  }

  async jumpToMessage(target: CachedUserMessage): Promise<boolean> {
    this.cancelCurrent();

    const token = createJumpToken();
    this.currentToken = token;
    this.runtimeStore.setJumpState({ status: 'jumping', targetId: target.localMessageId, attempt: 0 });

    // 先尝试直接跳转
    const direct = await this.jumpToMounted(target, token);
    if (!this.isCurrent(token)) return false;

    if (direct) {
      this.runtimeStore.setJumpState({ status: 'idle' });
      this.clearToken(token);
      return true;
    }

    // 渐进式跳转
    const found = await this.jumpToCachedMessage(target, token);
    if (this.isCurrent(token) && found) {
      this.runtimeStore.setJumpState({ status: 'idle' });
    }
    this.clearToken(token);
    return found;
  }

  cancelCurrent(): void {
    if (this.currentToken) {
      this.currentToken.cancel();
      this.currentToken = null;
    }
    const { jumpState } = this.runtimeStore.getSnapshot();
    if (jumpState.status !== 'idle') {
      this.runtimeStore.setJumpState({ status: 'idle' });
    }
  }

  private async jumpToCachedMessage(target: CachedUserMessage, token: JumpToken): Promise<boolean> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      if (!this.isCurrent(token)) return false;

      // 会话切换检测
      const { conversationId } = this.runtimeStore.getSnapshot();
      if (conversationId !== target.conversationId) return false;

      // 检查目标是否已挂载（含 isConnected 守卫）
      const el = this.scanner.getElementByLocalId(target.localMessageId);
      if (el?.isConnected) {
        return await this.landOnTarget(el, target, token);
      }

      // 扫描当前 DOM 状态
      const result = await this.scanner.rescan();
      if (!this.isCurrent(token)) return false;

      // rescan 后重新计算 targetIndex（messages 列表可能因滚动发现新消息而变化）
      const targetIndex = this.runtimeStore.getSnapshot().messages.findIndex((m) => m.localMessageId === target.localMessageId);
      if (targetIndex < 0) {
        if (this.isCurrent(token)) {
          this.runtimeStore.setJumpState({ status: 'failed', targetId: target.localMessageId, reason: '目标消息不在当前会话列表中' });
        }
        return false;
      }

      // rescan 后再次检查是否已挂载
      if (result.mountedIds.has(target.localMessageId)) {
        const found = this.scanner.getElementByLocalId(target.localMessageId);
        if (found?.isConnected) {
          return await this.landOnTarget(found, target, token);
        }
      }

      // 更新尝试计数
      if (!this.isCurrent(token)) return false;
      this.runtimeStore.setJumpState({ status: 'jumping', targetId: target.localMessageId, attempt: attempt + 1 });

      // 步进策略
      if (attempt === 0 && Number.isFinite(target.lastKnownScrollRatio)) {
        this.scrollDriver.scrollToRatio(target.lastKnownScrollRatio, 'auto');
      } else {
        const direction = decideDirection(targetIndex, result.visibleRange);
        this.scrollOneChunk(direction, attempt);
      }

      await waitForDomSettled(SETTLE_MS);
    }

    if (this.isCurrent(token)) {
      this.runtimeStore.setJumpState({
        status: 'failed',
        targetId: target.localMessageId,
        reason: `经过 ${MAX_ATTEMPTS} 次尝试仍未找到目标消息`
      });
    }
    return false;
  }

  private async landOnTarget(el: HTMLElement, target: CachedUserMessage, token: JumpToken): Promise<boolean> {
    if (!this.isCurrent(token)) return false;
    // 使用 'auto' 行为：即时滚动，scroll metadata 立即可读
    this.scrollDriver.scrollElementIntoView(el, { block: 'center', behavior: 'auto' });
    this.highlightMessage(el);
    this.scanner.updateScrollMeta(target.localMessageId, this.scrollDriver.getScrollTop(), this.scrollDriver.getScrollRatio());
    await this.cacheStore.flush();
    return this.isCurrent(token);
  }

  private scrollOneChunk(direction: 'up' | 'down', attempt: number): void {
    const viewportHeight = this.scrollDriver.getClientHeight();
    const decay = Math.max(0.3, 1 - attempt * 0.03);
    const step = viewportHeight * decay;
    const deltaY = direction === 'up' ? -step : step;
    this.scrollDriver.scrollBy(deltaY);
  }

  private async jumpToMounted(target: CachedUserMessage, token: JumpToken): Promise<boolean> {
    const el = this.scanner.getElementByLocalId(target.localMessageId);
    if (!el?.isConnected) return false;
    return await this.landOnTarget(el, target, token);
  }

  private highlightMessage(el: HTMLElement): void {
    ensureHighlightStyle();
    el.classList.add(HIGHLIGHT_CLASS);
    window.setTimeout(() => { el.classList.remove(HIGHLIGHT_CLASS); }, HIGHLIGHT_MS);
  }

  private clearToken(token: JumpToken): void {
    if (this.currentToken === token) {
      this.currentToken = null;
    }
  }
}
```

- [ ] **Step 2: 编译检查**

Run: `pnpm compile`
Expected: 无错误

- [ ] **Step 3: 提交**

```bash
git add src/content/jumpController.ts
git commit -m "feat: 实现渐进式跳转核心逻辑

重写 JumpController，添加以下功能：
- JumpToken + isCurrent 竞态守卫，旧跳转不刷新跳转状态
- decideDirection 基于 messages 数组 index（非 orderKey）
- targetIndex 每次 rescan 后从最新 snapshot 重新计算
- landOnTarget 传入 token，返回 boolean，中断时放弃落地
- 渐进式跳转循环（MAX_ATTEMPTS=30，SETTLE_MS=500）
- scrollRatio 种子跳转 + index-based 自适应步进
- el.isConnected 守卫防止 stale DOM element 误判
- 会话切换检测（conversationId 不匹配时自动终止）"
```

---

### Task 3: content.ts 接入跳转取消机制

**Files:**
- Modify: `entrypoints/content.ts`

- [ ] **Step 1: 添加取消监听**

在 `entrypoints/content.ts` 中，找到 `scanner.start();`（line 39）之后的代码：

```typescript
    scanner.start();

    window.addEventListener('beforeunload', () => {
```

替换为：

```typescript
    scanner.start();

    // 用户滚动取消进行中的跳转
    scrollDriver.onUserScroll(() => jumpController.cancelCurrent());

    // Esc 键取消进行中的跳转
    window.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Escape') jumpController.cancelCurrent();
    });

    window.addEventListener('beforeunload', () => {
```

- [ ] **Step 2: 编译检查**

Run: `pnpm compile`
Expected: 无错误

- [ ] **Step 3: 提交**

```bash
git add entrypoints/content.ts
git commit -m "feat: 接入跳转取消机制

在 content script 中注册两个取消监听：
- scrollDriver.onUserScroll → jumpController.cancelCurrent()
- Esc 键 → jumpController.cancelCurrent()"
```

---

### Task 4: UI 组件 — JumpToast + MessageItem + Sidebar

**Files:**
- Create: `src/ui/JumpToast.tsx`
- Modify: `src/ui/MessageItem.tsx`
- Modify: `src/ui/Sidebar.tsx`

**注意：** 三个文件在同一 Task 中修改，避免中间阶段编译失败（MessageItem 的 `isJumping` prop 需要 Sidebar 同步传递）。

- [ ] **Step 1: 创建 JumpToast.tsx**

创建 `src/ui/JumpToast.tsx`，内容如下：

```typescript
import type { JumpState } from '../shared/types';

interface JumpToastProps {
  jumpState: JumpState;
  onCancel: () => void;
}

export function JumpToast({ jumpState, onCancel }: JumpToastProps) {
  if (jumpState.status === 'idle') return null;

  if (jumpState.status === 'jumping') {
    return (
      <div className="cqn-toast cqn-toast--jumping">
        <span className="cqn-toast-text">正在跳转... ({jumpState.attempt}/30)</span>
        <button className="cqn-toast-btn" type="button" onClick={onCancel}>取消</button>
      </div>
    );
  }

  // status === 'failed'
  return (
    <div className="cqn-toast cqn-toast--failed">
      <span className="cqn-toast-text">{jumpState.reason}</span>
      <button className="cqn-toast-btn" type="button" onClick={onCancel}>关闭</button>
    </div>
  );
}
```

- [ ] **Step 2: 更新 MessageItem.tsx（添加 isJumping prop）**

将 `src/ui/MessageItem.tsx` 内容替换为：

```typescript
import { memo } from 'preact/compat';
import type { CachedUserMessage } from '../shared/types';
import { splitByQuery } from '../shared/text';

interface MessageItemProps {
  message: CachedUserMessage;
  index: number;
  active: boolean;
  mounted: boolean;
  isJumping: boolean;
  searchQuery: string;
  onClick: (message: CachedUserMessage) => void;
}

function MessageItemComponent({ message, index, active, mounted, isJumping, searchQuery, onClick }: MessageItemProps) {
  const parts = splitByQuery(message.preview, searchQuery);

  return (
    <button
      className={`cqn-item${active ? ' is-active' : ''}${isJumping ? ' is-jumping' : ''}`}
      type="button"
      onClick={() => onClick(message)}
    >
      <span className="cqn-item-index">Q{index + 1}</span>
      <span className="cqn-item-body">
        <span className="cqn-item-preview">
          {parts.map((part) => part.match ? <mark>{part.text}</mark> : <span>{part.text}</span>)}
        </span>
        <span className="cqn-item-meta">
          {isJumping ? '⟳ 跳转中...' : mounted ? '● 当前可跳转' : '○ 已缓存'}
        </span>
        <span className="cqn-hover-preview" role="tooltip">
          {message.textForSearch}
        </span>
      </span>
    </button>
  );
}

export const MessageItem = memo(MessageItemComponent);
```

- [ ] **Step 3: 更新 Sidebar.tsx（集成 JumpToast + isJumping）**

将 `src/ui/Sidebar.tsx` 内容替换为：

```typescript
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { JumpController } from '../content/jumpController';
import type { RuntimeStore } from '../content/runtimeStore';
import type { RuntimeState } from '../shared/types';
import { JumpToast } from './JumpToast';
import { MessageItem } from './MessageItem';
import { SearchBox } from './SearchBox';

interface SidebarProps {
  runtimeStore: RuntimeStore;
  jumpController: JumpController;
}

export function Sidebar({ runtimeStore, jumpController }: SidebarProps) {
  const [snapshot, setSnapshot] = useState<RuntimeState>(() => runtimeStore.getSnapshot());
  const [collapsed, setCollapsed] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => runtimeStore.subscribe(() => setSnapshot(runtimeStore.getSnapshot())), [runtimeStore]);

  useEffect(() => {
    const timer = window.setTimeout(() => setSearchQuery(searchInput), 300);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const messages = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return snapshot.messages;
    return snapshot.messages.filter((message) => message.textForSearch.toLowerCase().includes(query));
  }, [snapshot.messages, searchQuery]);

  const { jumpState } = snapshot;

  if (collapsed) {
    return (
      <aside className="cqn-sidebar is-collapsed">
        <button className="cqn-collapse" type="button" onClick={() => setCollapsed(false)} title="展开导航">
          ☰
        </button>
      </aside>
    );
  }

  return (
    <aside className="cqn-sidebar">
      <header className="cqn-header">
        <strong>ChatGPT Navigator</strong>
        <button className="cqn-collapse" type="button" onClick={() => setCollapsed(true)} title="折叠导航">
          ×
        </button>
      </header>

      <SearchBox value={searchInput} onChange={setSearchInput} />

      <div className="cqn-status">
        Indexed {snapshot.messages.length} questions locally
      </div>

      <nav className="cqn-list" aria-label="ChatGPT user questions">
        {messages.map((message, index) => (
          <MessageItem
            key={message.localMessageId}
            message={message}
            index={index}
            active={snapshot.activeMessageId === message.localMessageId}
            mounted={snapshot.mountedIds.has(message.localMessageId)}
            isJumping={jumpState.status === 'jumping' && jumpState.targetId === message.localMessageId}
            searchQuery={searchQuery}
            onClick={(target) => void jumpController.jumpToMessage(target)}
          />
        ))}
      </nav>

      <JumpToast jumpState={jumpState} onCancel={() => jumpController.cancelCurrent()} />
    </aside>
  );
}
```

- [ ] **Step 4: 编译检查**

Run: `pnpm compile`
Expected: 无错误

- [ ] **Step 5: 提交**

```bash
git add src/ui/JumpToast.tsx src/ui/MessageItem.tsx src/ui/Sidebar.tsx
git commit -m "feat: UI 集成跳转状态显示

- 新建 JumpToast 组件：显示跳转进度/失败原因 + 取消/关闭按钮
- MessageItem 添加 isJumping prop，显示 ⟳ 跳转中状态
- Sidebar 集成 JumpToast，仅 jumping 状态匹配的条目显示跳转中"
```

---

### Task 5: styles.css — JumpToast 样式 + flex 布局修正

**Files:**
- Modify: `src/ui/styles.css`

- [ ] **Step 1: 修正 .cqn-list flex 布局**

在 `src/ui/styles.css` 中，找到 `.cqn-list` 规则（line 93-96）：

```css
.cqn-list {
  overflow-y: auto;
  padding: 4px 6px 8px;
}
```

替换为：

```css
.cqn-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 6px 8px;
}
```

- [ ] **Step 2: 在 `@media` 规则之前添加 JumpToast 样式**

在 `@media (prefers-color-scheme: light)` 块（line 178）之前插入：

```css
.cqn-item.is-jumping {
  background: rgba(16, 163, 127, 0.06);
  border-color: rgba(16, 163, 127, 0.3);
}

.cqn-toast {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-top: 1px solid var(--cqn-border);
  font-size: 12px;
}

.cqn-toast--jumping {
  background: rgba(16, 163, 127, 0.08);
}

.cqn-toast--failed {
  background: rgba(239, 68, 68, 0.08);
}

.cqn-toast-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cqn-toast--failed .cqn-toast-text {
  color: #ef4444;
}

.cqn-toast-btn {
  flex-shrink: 0;
  padding: 2px 8px;
  border: 1px solid var(--cqn-border);
  border-radius: 4px;
  background: transparent;
  color: var(--cqn-text-secondary);
  font-size: 11px;
  cursor: pointer;
}

.cqn-toast-btn:hover {
  background: var(--cqn-bg-secondary);
  color: var(--cqn-text-primary);
}

```

- [ ] **Step 3: 编译检查**

Run: `pnpm compile`
Expected: 无错误（CSS 不参与 tsc 检查）

- [ ] **Step 4: 提交**

```bash
git add src/ui/styles.css
git commit -m "feat: 添加 JumpToast 样式和 flex 布局修正

- .cqn-list: 添加 flex:1 + min-height:0 确保列表可收缩
- .cqn-toast: flex-shrink:0 确保 Toast 在底部可见
- .cqn-item.is-jumping: 绿色半透明背景 + 边框
- .cqn-toast--jumping/--failed: 进度/失败状态背景色"
```

---

### Task 6: 更新项目文档

**Files:**
- Modify: `docs/Tree.md`
- Modify: `CLAUDE.md`
- Modify: `README.md`

- [ ] **Step 1: 更新 Tree.md**

在 `docs/Tree.md` 中：

1. 在 `src/ui/` 部分，`SearchBox.tsx` 行之后添加：
```
│   │   ├── JumpToast.tsx       — 跳转状态 Toast（进度/失败/取消）
```

2. 更新 `src/content/jumpController.ts` 的描述为：
```
│   ├── jumpController.ts  — 跳转控制：直接跳转 + 渐进式跳转 + token 取消 + 高亮
```

- [ ] **Step 2: 更新 CLAUDE.md**

1. 更新内容层表格中 `JumpController` 描述：

找到：
```
| `JumpController` | 跳转逻辑：对已挂载消息直接 scrollIntoView + 临时高亮；未挂载消息返回失败（Phase 4 待实现渐进式跳转） |
```

替换为：
```
| `JumpController` | 跳转逻辑：已挂载消息直接跳转 + 高亮；未挂载消息渐进式跳转（scrollRatio 粗定位 + messages index 自适应步进，MAX_ATTEMPTS=30）；JumpToken 可取消 |
```

2. 更新开发注意事项：

找到：
```
- **Phase 4 未实现**：渐进式远距离跳转、跳转取消、失败 toast 仍在路线图中。当前点击未挂载消息会返回失败状态
```

替换为：
```
- **渐进式跳转**：点击未挂载（cached-only）消息触发渐进式跳转循环。attempt 0 用 scrollRatio 种子定位，后续用 decideDirection + scrollOneChunk 自适应步进（viewport × 衰减系数），每步等待 500ms DOM 沉淀。最大 30 次尝试后显示失败 toast
- **跳转取消**：用户手动滚动（wheel/touch/keyboard/pointerdown）、Esc 键、或点击新目标时自动取消当前跳转。通过 JumpToken 实现可取消异步操作
- **orderKey 稳定性**：cacheStore 使用 orderedIds + anchor-splice 合并模型（`orderList.ts`），匹配消息保持原 orderKey，新消息在锚点间插入。排序由 orderedIds 控制，不依赖 orderKey 数值排序
```

3. 在 UI 层部分添加 JumpToast：

在 `SearchBox.tsx` 行之后添加：
```
- `JumpToast.tsx` — 跳转进度和失败状态 Toast，底部固定显示
```

- [ ] **Step 3: 更新 README.md**

在 `README.md` 中：

1. 在"已实现范围"末尾追加：
```
- 点击 cached-only 消息可渐进式跳转（scrollRatio 粗定位 + messages index 自适应步进）。
- 跳转过程中用户滚动、按 Esc 或点击新目标可取消跳转。
- 跳转进度和失败状态在侧栏底部 Toast 显示。
```

2. 更新"已知限制"：

找到：
```
- Phase 1-3 只支持当前 DOM 中已挂载消息的直接跳转。
- cached-only 消息的渐进式远距离跳转将在 Phase 4 实现。
```

替换为：
```
- 渐进式跳转依赖 scroll metadata，不能保证 100% 精确定位。
```

3. 更新"后续路线"：

找到：
```
- Phase 4：渐进式跳转、跳转取消、失败 toast。
```

删除该行。

- [ ] **Step 4: 提交**

```bash
git add docs/Tree.md CLAUDE.md README.md
git commit -m "docs: 更新文档以反映 Phase 4 渐进式跳转

- Tree.md: 添加 JumpToast.tsx，更新 jumpController.ts 描述
- CLAUDE.md: 更新 Phase 4 说明，添加渐进式跳转和 orderKey 稳定性描述
- README.md: 移除 Phase 4 待实现限制，更新已实现范围"
```

---

### Task 7: 完整编译和构建验证

- [ ] **Step 1: orderedIds 回归测试**

Run: `pnpm test:order`
Expected: 所有测试通过

- [ ] **Step 2: TypeScript 类型检查**

Run: `pnpm compile`
Expected: 无错误

- [ ] **Step 3: 生产构建**

Run: `pnpm build`
Expected: 构建成功，输出到 `.output/chrome-mv3`

- [ ] **Step 4: 最终确认**

```bash
git log --oneline -10
```

确认所有 Task 的提交均已正确记录。

---

## Self-Review

### 1. 规格覆盖检查

| 规格要求 | 对应 Task |
|---------|-----------|
| orderKey / 全局顺序稳定 | 已满足（远端提交 `2186b90`，orderedIds + orderList.ts） |
| VisibleRange 基于 index | Task 1 |
| updateScrollMeta 直接按 localMessageId 更新 | Task 1 (cacheStore + messageScanner) |
| decideDirection 基于 index，非 orderKey | Task 2 |
| isCurrent(token) 竞态守卫 | Task 2 |
| 旧跳转不刷新跳转状态 | Task 2 (isCurrent 守卫所有 setJumpState) |
| 渐进式跳转循环（scrollRatio seed + adaptive stepping） | Task 2 |
| MAX_ATTEMPTS = 30 | Task 2 |
| cancellation token | Task 2 |
| scrollDriver.onUserScroll → 取消 | Task 3 |
| Esc → 取消 | Task 3 |
| 新跳转自动取消前一个 | Task 2 (cancelCurrent) |
| pointerdown 用户滚动检测 | Task 0 |
| markProgrammatic fallback timer | Task 0 |
| ScrollDriver.destroy 清理 programmaticTimer | Task 0 |
| scrollOneChunk(direction, attempt) | Task 2 |
| waitForDomSettled(500ms) | Task 2 |
| el.isConnected 守卫 | Task 2 |
| landOnTarget behavior:'auto' | Task 2 |
| updateScrollMeta sync（cacheStore 直接更新） | Task 1 + Task 2 |
| 失败 toast | Task 4 (JumpToast) |
| JumpToast UI 组件 | Task 4 |
| isJumping 仅匹配 jumping 状态 | Task 4 (Sidebar) |
| attempt 计数驱动 UI | Task 2 + Task 4 |
| .cqn-list flex:1 + .cqn-toast flex-shrink:0 | Task 5 |
| README 移除 Phase 4 限制 | Task 6 |
| test:order 回归测试 | Task 7 |

### 2. 占位符扫描

无 "TBD"、"TODO"、"implement later" 等占位符。所有步骤包含完整代码。

### 3. 类型一致性

- `JumpToken` 仅在 `jumpController.ts` 内部使用
- `VisibleRange` 改为 `{ minIndex: number; maxIndex: number }`，`decideDirection(targetIndex, visibleRange)` 使用 index 比较
- `JumpState` 类型在 `types.ts` 中已定义，所有使用者一致
- `MessageItemProps.isJumping: boolean`，Sidebar 传递 `jumpState.status === 'jumping' && ...`（boolean 表达式）
- `JumpToastProps` 使用 `JumpState` + `onCancel: () => void`
- `updateScrollMeta` 为 sync（返回 `void`），`landOnTarget` 在调用后 await `cacheStore.flush()`
- `updateMessageScrollMeta(conversationId, localMessageId, scrollTop, scrollRatio)` 返回 `boolean`
- `isCurrent(token: JumpToken): boolean` 在所有 await 后和 setJumpState 前调用
- `landOnTarget(el, target, token)` 返回 `Promise<boolean>`，调用处根据返回值决定是否返回 true
- `jumpToMounted(target, token)` 接受 token 参数
- `targetIndex` 每次 rescan 后从最新 snapshot 重新计算，`< 0` 时设 failed 而非保持 jumping

### 4. 修订校正检查

| 校正项 | 状态 |
|--------|------|
| 1. VisibleRange 改为 index-based（minIndex/maxIndex） | ✓ Task 1 |
| 2. decideDirection 基于 index，非 orderKey | ✓ Task 2 |
| 3. isCurrent(token) 竞态守卫 | ✓ Task 2 |
| 4. 旧跳转不刷新跳转状态 | ✓ Task 2 (isCurrent 守卫所有 setJumpState) |
| 5. updateScrollMeta 不走 resolveScannedCandidates | ✓ Task 1 (cacheStore.updateMessageScrollMeta) |
| 6. ScrollDriver.destroy 清理 programmaticTimer | ✓ Task 0 |
| 7. Task 7 增加 pnpm test:order | ✓ Task 7 |
| 8. content.ts 路径为 entrypoints/content.ts | ✓ Task 3 |
| 9. UI Task 合并（避免中间编译失败） | ✓ Task 4 |
| 10. isJumping 仅匹配 jumping 状态 | ✓ Task 4 (Sidebar) |
| 11. el.isConnected 守卫 | ✓ Task 2 |
| 12. markProgrammatic fallback timer | ✓ Task 0 |
| 13. landOnTarget 用 behavior:'auto' | ✓ Task 2 |
| 14. .cqn-list flex:1 + .cqn-toast flex-shrink:0 | ✓ Task 5 |
| 15. README 更新 | ✓ Task 6 ||
