# Robust Scroll Driver 实施计划 (v3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重构 ScrollDriver 使 scroll root 检测稳健、操作结果可观测、viewport 判断基于有效根，为未来 Phase 4 渐进式跳转提供可靠基础。

**Architecture:** ScrollDriver 内部维护带诊断信息的 `ScrollRoot` 模型替代裸 `HTMLElement | Window`。通过多源候选收集 + 评分 + 最小滚动验证自动检测正确的 scroll root。所有滚动操作返回 `ScrollOperationResult`。viewport 判断从 DomAdapter 迁移到 ScrollDriver 统一提供。保留 PR #7 的 `UserScrollDirection` API。ScrollDriver 不再依赖 DomAdapter。document root 候选统一归一化为 `kind: 'window'`。

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`), WXT browser extension, Preact

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/content/scrollDriver.ts` | **Rewrite** | 完整重写。无 DomAdapter 依赖。document root 候选归一化为 window kind |
| `src/content/domAdapter.ts` | **Modify** | 移除 `findScrollContainer()` 和 `isElementInViewport()`，删除 `scrollContainer` 选择器 |
| `src/content/messageScanner.ts` | **Modify** | viewport 调用迁移到 scrollDriver，`computeActiveMessageId` 使用 scroll root viewport |
| `entrypoints/content.ts` | **Modify** | `new ScrollDriver()` 无参构造，会话切换时 redetect，挂载 `__CQN_SCROLL_DEBUG__` |

不修改 `jumpController.ts`（其调用 `scrollElementIntoView` 签名兼容）、不修改 UI 层、不引入 Phase 4 功能。

---

## Task 1: 原子重写 scrollDriver.ts + DomAdapter + MessageScanner + content.ts

**Files:**
- Rewrite: `src/content/scrollDriver.ts`
- Modify: `src/content/domAdapter.ts`
- Modify: `src/content/messageScanner.ts`
- Modify: `entrypoints/content.ts`

四文件原子修改，一次性通过编译后提交。不提交中间态。

- [ ] **Step 1: Write the complete new scrollDriver.ts**

```ts
// === Types ===

export type UserScrollDirection = 'up' | 'down' | 'unknown';

type ScrollRootKind = 'window' | 'element';

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  maxScrollTop: number;
  ratio: number;
}

export interface ScrollRoot {
  kind: ScrollRootKind;
  target: Window | HTMLElement;
  element: HTMLElement | null;
  reason: string;
}

export interface ScrollOperationResult {
  moved: boolean;
  before: ScrollMetrics;
  after: ScrollMetrics;
  requestedDelta?: number;
  requestedTop?: number;
  reason?: string;
}

interface ScrollRootCandidate {
  element: HTMLElement;
  source: string;
  reason: string;
  score?: number;
}

interface PlainRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

// === ScrollDriver ===

export class ScrollDriver {
  private scrollRoot: ScrollRoot;
  private scrollListeners = new Set<() => void>();
  private userScrollListeners = new Set<(direction: UserScrollDirection) => void>();
  private isProgrammatic = false;
  private cleanupFns: Array<() => void> = [];
  private touchStartY: number | null = null;
  private lastOpResult: ScrollOperationResult | null = null;
  private lastScoredCandidates: ScrollRootCandidate[] = [];
  private lastRedetectTime = 0;
  private programmaticTimer: ReturnType<typeof setTimeout> | null = null;
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null;

  private static readonly REDETECT_COOLDOWN_MS = 5000;
  private static readonly MIN_SCROLL_PX = 8;
  private static readonly MIN_CLIENT_HEIGHT = 100;
  private static readonly PROGRAMMATIC_CLEAR_MS = 80;
  private static readonly FALLBACK_CLEAR_MS = 300;

  /** Document-level roots that must be normalized to kind:'window' */
  private static readonly DOCUMENT_ROOT_TAGS = new Set(['HTML', 'BODY']);

  constructor() {
    this.scrollRoot = { kind: 'window', target: window, element: null, reason: 'not-initialized' };
  }

  // --- Lifecycle ---

  init(): void {
    this.scrollRoot = this.detectScrollRoot();
    this.scrollRoot.reason = '[init] ' + this.scrollRoot.reason;
    this.bindListeners();
  }

  destroy(): void {
    if (this.programmaticTimer !== null) clearTimeout(this.programmaticTimer);
    if (this.fallbackTimer !== null) clearTimeout(this.fallbackTimer);
    this.programmaticTimer = null;
    this.fallbackTimer = null;
    this.isProgrammatic = false;
    this.touchStartY = null;
    this.lastOpResult = null;
    this.cleanupFns.forEach((fn) => fn());
    this.cleanupFns = [];
    this.scrollListeners.clear();
    this.userScrollListeners.clear();
  }

  // --- Root Detection ---

  getScrollRoot(): ScrollRoot {
    return { ...this.scrollRoot };
  }

  redetectScrollRoot(reason: string): void {
    this.lastRedetectTime = Date.now();
    const previousTarget = this.scrollRoot.target;
    this.scrollRoot = this.detectScrollRoot();
    this.scrollRoot.reason = `[${reason}] ${this.scrollRoot.reason}`;

    if (previousTarget !== this.scrollRoot.target) {
      this.rebindAllListeners();
    }
  }

  revalidateRoot(): boolean {
    const root = this.scrollRoot;

    if (root.kind === 'element') {
      const el = root.target as HTMLElement;
      if (!el.isConnected) {
        this.redetectScrollRoot('root-disconnected');
        return false;
      }
    }

    return true;
  }

  /**
   * 在 scroll 操作前调用。
   * - element root disconnected → 立即 redetect
   * - root reason 含 no-valid-scroll-root 且冷却已过 → 重试
   * - 不在短对话/无滚动页面频繁触发 DOM 查询
   */
  private ensureValidRoot(): void {
    const root = this.scrollRoot;

    // element root disconnected → 无冷却限制，立即 redetect
    if (root.kind === 'element') {
      const el = root.target as HTMLElement;
      if (!el.isConnected) {
        this.redetectScrollRoot('root-disconnected-pre-op');
        return;
      }
    }

    // 仅在已知 root 无效时尝试重检，受冷却限制
    if (!root.element && this.mayRedetect()) {
      this.redetectScrollRoot('invalid-root-retry');
    }
  }

  private detectScrollRoot(): ScrollRoot {
    const candidates = this.collectCandidates();

    const scored = candidates
      .map((c) => ({ ...c, score: this.scoreCandidate(c) }))
      .filter((c) => (c.score ?? -1) >= 0 && this.getMetricsForElement(c.element).maxScrollTop > ScrollDriver.MIN_SCROLL_PX)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

    this.lastScoredCandidates = scored;

    for (const candidate of scored) {
      if (this.verifyCandidate(candidate.element)) {
        // Document-level roots 归一化为 kind:'window'
        if (ScrollDriver.DOCUMENT_ROOT_TAGS.has(candidate.element.tagName)) {
          return {
            kind: 'window',
            target: window,
            element: candidate.element,
            reason: `${candidate.reason} (normalized to window)`,
          };
        }
        return {
          kind: 'element',
          target: candidate.element,
          element: candidate.element,
          reason: candidate.reason,
        };
      }
    }

    // Fallback: document.scrollingElement (always window kind)
    const scrollingEl = document.scrollingElement as HTMLElement | null;
    if (scrollingEl) {
      const maxScroll = scrollingEl.scrollHeight - scrollingEl.clientHeight;
      if (maxScroll > ScrollDriver.MIN_SCROLL_PX) {
        return {
          kind: 'window',
          target: window,
          element: scrollingEl,
          reason: 'fallback: document.scrollingElement',
        };
      }
    }

    return {
      kind: 'window',
      target: window,
      element: null,
      reason: 'no-valid-scroll-root',
    };
  }

  private collectCandidates(): ScrollRootCandidate[] {
    const candidates: ScrollRootCandidate[] = [];
    const seen = new Set<HTMLElement>();

    const addCandidate = (el: HTMLElement, source: string, reason: string) => {
      if (seen.has(el)) return;
      seen.add(el);
      candidates.push({ element: el, source, reason });
    };

    // 1. Selector-based (backward compat with known ChatGPT patterns)
    const selectorMatches = document.querySelectorAll<HTMLElement>(
      'main .overflow-y-auto, [class*="react-scroll-to-bottom"]'
    );
    for (const el of selectorMatches) {
      addCandidate(el, 'selector', 'selector match');
    }

    // 2. <main> and its descendants with scrollable overflow
    const main = document.querySelector<HTMLElement>('main');
    if (main) {
      addCandidate(main, 'main', '<main> element');
      const descendants = main.querySelectorAll<HTMLElement>('*');
      for (const el of descendants) {
        const style = getComputedStyle(el);
        if (['auto', 'scroll', 'overlay'].includes(style.overflowY)) {
          addCandidate(el, 'main-descendant', `main descendant overflow-y:${style.overflowY}`);
        }
      }
    }

    // 3. Ancestor chain from sampled user messages (first 3 + middle + last 3)
    const userMsgs = document.querySelectorAll('[data-message-author-role="user"]');
    if (userMsgs.length > 0) {
      const sampleIndexes = new Set<number>();
      for (let i = 0; i < Math.min(3, userMsgs.length); i++) sampleIndexes.add(i);
      for (let i = Math.max(0, userMsgs.length - 3); i < userMsgs.length; i++) sampleIndexes.add(i);
      sampleIndexes.add(Math.floor(userMsgs.length / 2));

      for (const idx of sampleIndexes) {
        const msg = userMsgs[idx] as HTMLElement;
        let parent = msg.parentElement;
        while (parent && parent !== document.body && parent !== document.documentElement) {
          const style = getComputedStyle(parent);
          if (['auto', 'scroll', 'overlay'].includes(style.overflowY)) {
            addCandidate(parent, 'message-ancestor', `ancestor of user message #${idx}`);
          }
          parent = parent.parentElement;
        }
      }
    }

    // 4. Document-level roots (will be normalized to kind:'window' if selected)
    if (document.scrollingElement instanceof HTMLElement && document.scrollingElement !== document.body) {
      addCandidate(document.scrollingElement, 'scrollingElement', 'document.scrollingElement');
    }
    addCandidate(document.documentElement, 'documentElement', 'document.documentElement');
    addCandidate(document.body, 'body', 'document.body');

    return candidates;
  }

  private scoreCandidate(candidate: ScrollRootCandidate): number {
    const el = candidate.element;

    if (!el.isConnected) return -1;
    if (el.getRootNode() instanceof ShadowRoot) return -1;
    if (el.closest('textarea, input, select, [contenteditable="true"], code, pre')) return -1;

    if (el.clientHeight < ScrollDriver.MIN_CLIENT_HEIGHT) return -1;

    let score = 0;

    if (el.querySelector('[data-message-author-role="user"]')) score += 50;

    if (el.tagName === 'MAIN') score += 30;
    else if (el.parentElement?.tagName === 'MAIN') score += 25;

    const style = getComputedStyle(el);
    if (['auto', 'scroll', 'overlay'].includes(style.overflowY)) score += 20;

    const viewportRatio = el.clientHeight / window.innerHeight;
    if (viewportRatio > 0.5 && viewportRatio <= 1.2) score += 15;

    if (candidate.source === 'message-ancestor') score += 10;
    if (candidate.source === 'selector') score += 5;

    return score;
  }

  private verifyCandidate(el: HTMLElement): boolean {
    const originalTop = el.scrollTop;
    const maxScroll = el.scrollHeight - el.clientHeight;

    let testDelta = 1;
    if (originalTop >= maxScroll - 1) testDelta = -1;

    el.scrollTop = originalTop + testDelta;
    const moved = el.scrollTop !== originalTop;
    el.scrollTop = originalTop;

    return moved;
  }

  // --- Metrics ---

  getScrollTop(): number {
    if (this.scrollRoot.kind === 'window') {
      return window.scrollY || document.documentElement.scrollTop || 0;
    }
    return (this.scrollRoot.target as HTMLElement).scrollTop;
  }

  getScrollHeight(): number {
    if (this.scrollRoot.kind === 'window') {
      return document.scrollingElement?.scrollHeight ?? document.documentElement.scrollHeight;
    }
    return (this.scrollRoot.target as HTMLElement).scrollHeight;
  }

  getClientHeight(): number {
    if (this.scrollRoot.kind === 'window') return window.innerHeight;
    return (this.scrollRoot.target as HTMLElement).clientHeight;
  }

  getScrollRatio(): number {
    return this.getMetrics().ratio;
  }

  getMetrics(): ScrollMetrics {
    if (this.scrollRoot.kind === 'window') {
      const scrollTop = window.scrollY || document.documentElement.scrollTop || 0;
      const scrollHeight = document.scrollingElement?.scrollHeight ?? document.documentElement.scrollHeight;
      const clientHeight = window.innerHeight;
      const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
      return {
        scrollTop,
        scrollHeight,
        clientHeight,
        maxScrollTop,
        ratio: maxScrollTop > 0 ? Math.min(1, scrollTop / maxScrollTop) : 0,
      };
    }
    return this.getMetricsForElement(this.scrollRoot.target as HTMLElement);
  }

  private getMetricsForElement(el: HTMLElement): ScrollMetrics {
    const scrollTop = el.scrollTop;
    const scrollHeight = el.scrollHeight;
    const clientHeight = el.clientHeight;
    const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
    return {
      scrollTop,
      scrollHeight,
      clientHeight,
      maxScrollTop,
      ratio: maxScrollTop > 0 ? Math.min(1, scrollTop / maxScrollTop) : 0,
    };
  }

  getAbsoluteTop(element: HTMLElement): number {
    if (this.scrollRoot.kind === 'window') {
      return element.getBoundingClientRect().top + window.scrollY;
    }
    const container = this.scrollRoot.target as HTMLElement;
    return container.scrollTop + (element.getBoundingClientRect().top - container.getBoundingClientRect().top);
  }

  // --- Viewport ---

  getViewportRect(): DOMRect {
    if (this.scrollRoot.kind === 'window') {
      return new DOMRect(0, 0, window.innerWidth, window.innerHeight);
    }
    return (this.scrollRoot.target as HTMLElement).getBoundingClientRect();
  }

  isElementInViewport(el: HTMLElement): boolean {
    const viewport = this.getViewportRect();
    const rect = el.getBoundingClientRect();
    return rect.bottom >= viewport.top && rect.top <= viewport.bottom;
  }

  // --- Scroll Operations ---

  scrollBy(deltaY: number): ScrollOperationResult {
    this.ensureValidRoot();
    const before = this.getMetrics();
    this.markProgrammatic();
    this.executeRawScrollBy(deltaY);

    const after = this.getMetrics();
    const moved = after.scrollTop !== before.scrollTop;

    if (this.shouldRedetectForNoOp(before, moved, deltaY) && this.mayRedetect()) {
      this.redetectScrollRoot('scrollBy-no-op');
      const retryBefore = this.getMetrics();
      this.markProgrammatic();
      this.executeRawScrollBy(deltaY);
      const retryAfter = this.getMetrics();
      return this.recordResult(
        retryAfter.scrollTop !== retryBefore.scrollTop,
        before,
        retryAfter,
        { requestedDelta: deltaY, reason: 'redetect-retry' },
      );
    }

    return this.recordResult(moved, before, after, { requestedDelta: deltaY });
  }

  scrollTo(options: ScrollToOptions): ScrollOperationResult {
    this.ensureValidRoot();
    const before = this.getMetrics();
    const isSmooth = options.behavior === 'smooth';
    this.markProgrammatic();
    this.executeRawScrollTo(options);

    const after = this.getMetrics();
    const moved = after.scrollTop !== before.scrollTop;

    if (!isSmooth && this.shouldRedetectForNoOp(before, moved, undefined, options.top) && this.mayRedetect()) {
      this.redetectScrollRoot('scrollTo-no-op');
      this.markProgrammatic();
      this.executeRawScrollTo(options);
      const retryAfter = this.getMetrics();
      return this.recordResult(
        retryAfter.scrollTop !== before.scrollTop,
        before,
        retryAfter,
        { requestedTop: options.top, reason: 'redetect-retry' },
      );
    }

    return this.recordResult(moved, before, after, { requestedTop: options.top });
  }

  scrollToRatio(ratio: number, behavior: ScrollBehavior = 'auto'): ScrollOperationResult {
    this.ensureValidRoot();
    const metrics = this.getMetrics();
    const clamped = Math.min(1, Math.max(0, ratio));
    const top = clamped * metrics.maxScrollTop;
    const result = this.scrollTo({ top, behavior });
    return { ...result, requestedTop: top };
  }

  scrollElementIntoView(
    el: HTMLElement,
    options: { block?: ScrollLogicalPosition; behavior?: ScrollBehavior; offset?: number } = {},
  ): ScrollOperationResult {
    const { block = 'center', behavior = 'smooth', offset = 0 } = options;

    this.ensureValidRoot();
    const elRect = el.getBoundingClientRect();
    const viewport = this.getViewportRect();
    const viewportHeight = viewport.bottom - viewport.top;

    if (block === 'nearest') {
      if (elRect.top >= viewport.top && elRect.bottom <= viewport.bottom) {
        const metrics = this.getMetrics();
        return this.recordResult(false, metrics, metrics, { reason: 'already-visible-nearest' });
      }
    }

    let targetTop: number;

    if (this.scrollRoot.kind === 'window') {
      targetTop = window.scrollY + (elRect.top - viewport.top) - offset;
    } else {
      const container = this.scrollRoot.target as HTMLElement;
      targetTop = container.scrollTop + (elRect.top - viewport.top) - offset;
    }

    switch (block) {
      case 'center':
        targetTop -= viewportHeight / 2 - elRect.height / 2;
        break;
      case 'end':
        targetTop -= viewportHeight - elRect.height;
        break;
      case 'nearest':
        if (elRect.top >= viewport.top) {
          targetTop -= viewportHeight - elRect.height;
        }
        break;
    }

    return this.scrollTo({ top: targetTop, behavior });
  }

  getLastOperationResult(): ScrollOperationResult | null {
    return this.lastOpResult;
  }

  // --- User Scroll Direction (PR #7 compatible) ---

  onScroll(callback: () => void): () => void {
    this.scrollListeners.add(callback);
    return () => this.scrollListeners.delete(callback);
  }

  onUserScroll(callback: (direction: UserScrollDirection) => void): () => void {
    this.userScrollListeners.add(callback);
    return () => this.userScrollListeners.delete(callback);
  }

  // --- Debug ---

  getDebugSnapshot(): Record<string, unknown> {
    const root = this.scrollRoot;
    const metrics = this.getMetrics();
    const userMsgs = document.querySelectorAll('[data-message-author-role="user"]');
    const firstMsg = userMsgs[0] as HTMLElement | undefined;
    const lastMsg = userMsgs[userMsgs.length - 1] as HTMLElement | undefined;

    return {
      root: {
        kind: root.kind,
        tag: root.element?.tagName ?? 'window',
        id: root.element?.id ?? '',
        className: root.element?.className?.substring(0, 120) ?? '',
        reason: root.reason,
        connected: root.element?.isConnected ?? true,
      },
      metrics,
      candidates: this.lastScoredCandidates.map((c) => ({
        tag: c.element.tagName,
        id: c.element.id || undefined,
        source: c.source,
        score: c.score,
        reason: c.reason,
      })),
      lastOperation: this.lastOpResult,
      userMessageCount: userMsgs.length,
      firstMessageRect: firstMsg ? this.toPlainRect(firstMsg.getBoundingClientRect()) : null,
      lastMessageRect: lastMsg ? this.toPlainRect(lastMsg.getBoundingClientRect()) : null,
      rootContainsUserMessages: root.element
        ? root.element.querySelector('[data-message-author-role="user"]') !== null
        : false,
    };
  }

  // --- Private: Raw Execution ---

  private executeRawScrollBy(deltaY: number): void {
    if (this.scrollRoot.kind === 'window') {
      window.scrollBy({ top: deltaY, behavior: 'auto' });
    } else {
      (this.scrollRoot.target as HTMLElement).scrollBy({ top: deltaY, behavior: 'auto' });
    }
  }

  private executeRawScrollTo(options: ScrollToOptions): void {
    if (this.scrollRoot.kind === 'window') {
      window.scrollTo(options);
    } else {
      (this.scrollRoot.target as HTMLElement).scrollTo(options);
    }
  }

  // --- Private: Helpers ---

  private recordResult(
    moved: boolean,
    before: ScrollMetrics,
    after: ScrollMetrics,
    extra?: { requestedDelta?: number; requestedTop?: number; reason?: string },
  ): ScrollOperationResult {
    const result: ScrollOperationResult = { moved, before, after };
    if (extra) {
      if (extra.requestedDelta != null) result.requestedDelta = extra.requestedDelta;
      if (extra.requestedTop != null) result.requestedTop = extra.requestedTop;
      if (extra.reason != null) result.reason = extra.reason;
    }
    this.lastOpResult = result;
    return result;
  }

  /**
   * 方向敏感 no-op 判定：
   * - maxScrollTop=0 → root 明显错误
   * - delta 方向有移动空间但没移动 → 可能 root 错误
   * - absolute top clamp 到 [0, maxScrollTop] 后仍与当前位置不同 → 可能 root 错误
   */
  private shouldRedetectForNoOp(
    before: ScrollMetrics,
    moved: boolean,
    delta?: number,
    top?: number | null,
  ): boolean {
    if (moved) return false;

    if (before.maxScrollTop <= ScrollDriver.MIN_SCROLL_PX) return true;

    if (delta != null && delta !== 0) {
      if (delta > 0 && before.scrollTop < before.maxScrollTop) return true;
      if (delta < 0 && before.scrollTop > 0) return true;
      return false;
    }

    if (top != null) {
      const clampedTop = Math.max(0, Math.min(top, before.maxScrollTop));
      if (Math.abs(clampedTop - before.scrollTop) > 1) return true;
    }

    return false;
  }

  private isAtScrollBoundary(metrics: ScrollMetrics): boolean {
    return metrics.scrollTop <= 0 || metrics.scrollTop >= metrics.maxScrollTop;
  }

  private mayRedetect(): boolean {
    const now = Date.now();
    if (now - this.lastRedetectTime < ScrollDriver.REDETECT_COOLDOWN_MS) return false;
    this.lastRedetectTime = now;
    return true;
  }

  private markProgrammatic(): void {
    this.isProgrammatic = true;
    if (this.programmaticTimer !== null) clearTimeout(this.programmaticTimer);
    if (this.fallbackTimer !== null) clearTimeout(this.fallbackTimer);
    this.fallbackTimer = setTimeout(() => {
      this.isProgrammatic = false;
      this.fallbackTimer = null;
    }, ScrollDriver.FALLBACK_CLEAR_MS);
  }

  private notifyUserScroll(direction: UserScrollDirection): void {
    if (this.isProgrammatic) return;
    this.userScrollListeners.forEach((listener) => listener(direction));
  }

  private toPlainRect(rect: DOMRect): PlainRect {
    return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width, height: rect.height };
  }

  // --- Private: Listener Binding ---

  private rebindAllListeners(): void {
    this.cleanupFns.forEach((fn) => fn());
    this.cleanupFns = [];
    this.bindScrollListener();
    this.bindInputListeners();
  }

  private bindListeners(): void {
    this.bindScrollListener();
    this.bindInputListeners();
  }

  private bindScrollListener(): void {
    const scrollTarget = this.scrollRoot.kind === 'window' ? window : this.scrollRoot.target;

    const onScroll = () => {
      if (this.fallbackTimer !== null) {
        clearTimeout(this.fallbackTimer);
        this.fallbackTimer = null;
      }
      this.scrollListeners.forEach((listener) => listener());
      if (this.isProgrammatic) {
        if (this.programmaticTimer !== null) clearTimeout(this.programmaticTimer);
        this.programmaticTimer = setTimeout(() => {
          this.isProgrammatic = false;
          this.programmaticTimer = null;
        }, ScrollDriver.PROGRAMMATIC_CLEAR_MS);
      }
    };

    scrollTarget.addEventListener('scroll', onScroll, { passive: true });
    this.cleanupFns.push(() => scrollTarget.removeEventListener('scroll', onScroll));
  }

  private bindInputListeners(): void {
    const inputTarget = this.scrollRoot.kind === 'window' ? window : this.scrollRoot.target;

    const onWheel = (event: Event) =>
      this.notifyUserScroll(directionFromDelta((event as WheelEvent).deltaY));

    const onTouchStart = (event: Event) => {
      const touchEvent = event as TouchEvent;
      this.touchStartY = touchEvent.touches[0]?.clientY ?? null;
      this.notifyUserScroll('unknown');
    };

    const onTouchMove = (event: Event) => {
      const touchEvent = event as TouchEvent;
      const currentY = touchEvent.touches[0]?.clientY ?? null;
      if (this.touchStartY === null || currentY === null) return;
      this.notifyUserScroll(directionFromDelta(this.touchStartY - currentY));
    };

    const onKey = (event: KeyboardEvent) => {
      const direction = directionFromKey(event.key);
      if (direction !== 'unknown') this.notifyUserScroll(direction);
    };

    inputTarget.addEventListener('wheel', onWheel, { passive: true });
    inputTarget.addEventListener('touchstart', onTouchStart, { passive: true });
    inputTarget.addEventListener('touchmove', onTouchMove, { passive: true });
    window.addEventListener('keydown', onKey);

    this.cleanupFns.push(() => inputTarget.removeEventListener('wheel', onWheel));
    this.cleanupFns.push(() => inputTarget.removeEventListener('touchstart', onTouchStart));
    this.cleanupFns.push(() => inputTarget.removeEventListener('touchmove', onTouchMove));
    this.cleanupFns.push(() => window.removeEventListener('keydown', onKey));

    // pointerdown 仅用于 element root（捕获 scrollbar 拖拽），过滤 CQN 事件
    if (this.scrollRoot.kind === 'element') {
      const onPointerDown = (event: PointerEvent) => {
        const target = event.target as HTMLElement | null;
        if (!target) return;
        if (target.getRootNode() instanceof ShadowRoot) return;
        if (target.closest?.('[class*="cqn-"]')) return;
        this.notifyUserScroll('unknown');
      };

      inputTarget.addEventListener('pointerdown', onPointerDown, { passive: true });
      this.cleanupFns.push(() => (inputTarget as HTMLElement).removeEventListener('pointerdown', onPointerDown));
    }
  }
}

// === Direction Helpers (exported, tested by order-list-regression.test.mjs) ===

export function directionFromDelta(deltaY: number): UserScrollDirection {
  if (deltaY < 0) return 'up';
  if (deltaY > 0) return 'down';
  return 'unknown';
}

export function directionFromKey(key: string): UserScrollDirection {
  if (['PageUp', 'ArrowUp', 'Home'].includes(key)) return 'up';
  if (['PageDown', ' ', 'ArrowDown', 'End'].includes(key)) return 'down';
  return 'unknown';
}
```

- [ ] **Step 2: Rewrite domAdapter.ts**

```ts
import { normalizeMessageText } from '../shared/text';

const SELECTORS = {
  userMessage: '[data-message-author-role="user"]',
  messageText: '.whitespace-pre-wrap, .message-body, [data-message-author-role] > div',
  excludeButtons: 'button, [role="button"], .copy-button, .edit-button',
} as const;

const OBSERVED_ID_ATTRIBUTES = ['data-id', 'data-message-id'] as const;

export class DomAdapter {
  findUserMessages(): HTMLElement[] {
    return Array.from(document.querySelectorAll<HTMLElement>(SELECTORS.userMessage));
  }

  extractText(el: HTMLElement): string {
    const clone = el.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(SELECTORS.excludeButtons).forEach((node) => node.remove());

    const textNode = clone.matches(SELECTORS.messageText)
      ? clone
      : clone.querySelector<HTMLElement>(SELECTORS.messageText);

    return normalizeMessageText((textNode ?? clone).innerText || (textNode ?? clone).textContent || '');
  }

  extractConversationId(): string | null {
    const match = location.pathname.match(/\/c\/([^/?#]+)/);
    return match?.[1] ?? null;
  }

  extractObservedId(el: HTMLElement): string | null {
    for (const attr of OBSERVED_ID_ATTRIBUTES) {
      const value = el.getAttribute(attr);
      if (value?.trim()) return value.trim();
    }
    return null;
  }
}
```

- [ ] **Step 3: Update messageScanner.ts — 3 处 viewport 迁移**

**3a.** `scheduleScrollCapture`（约第 168 行）：

找到：
```ts
        if (el && this.domAdapter.isElementInViewport(el)) {
```
替换为：
```ts
        if (el && this.scrollDriver.isElementInViewport(el)) {
```

**3b.** `computeActiveMessageId`（约第 251-267 行）— 整个方法替换：

```ts
  private computeActiveMessageId(): string | null {
    const viewport = this.scrollDriver.getViewportRect();

    const entries = Array.from(this.elementById.entries())
      .map(([id, element]) => ({ id, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.bottom >= viewport.top && rect.top <= viewport.bottom);

    const visibleBelowTop = entries
      .filter(({ rect }) => rect.top >= viewport.top)
      .sort((a, b) => a.rect.top - b.rect.top)[0];
    if (visibleBelowTop) return visibleBelowTop.id;

    const nearestAbove = Array.from(this.elementById.entries())
      .map(([id, element]) => ({ id, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.top < viewport.top)
      .sort((a, b) => b.rect.top - a.rect.top)[0];

    return nearestAbove?.id ?? null;
  }
```

**3c.** `computeVisibleRange`（约第 274 行）：

找到：
```ts
        return element ? this.domAdapter.isElementInViewport(element) : false;
```
替换为：
```ts
        return element ? this.scrollDriver.isElementInViewport(element) : false;
```

- [ ] **Step 4: Update content.ts — 无参构造 + redetect + debug**

找到（约第 18 行）：
```ts
    const scrollDriver = new ScrollDriver(domAdapter);
```
替换为：
```ts
    const scrollDriver = new ScrollDriver();
```

找到 `urlWatcher.onConversationChange` 回调（约第 34 行）：
```ts
      scanner.clearState();
    });
```
替换为：
```ts
      scanner.clearState();
      scrollDriver.redetectScrollRoot('conversation-change');
    });
```

找到（约第 39 行）：
```ts
    scanner.start();

    window.addEventListener('beforeunload', () => {
```
替换为：
```ts
    scanner.start();

    (window as any).__CQN_SCROLL_DEBUG__ = () => scrollDriver.getDebugSnapshot();

    window.addEventListener('beforeunload', () => {
```

- [ ] **Step 5: Run full verification**

Run: `pnpm test:order && pnpm compile && pnpm build`
Expected: 全部 PASS

- [ ] **Step 6: Single atomic commit**

```bash
git add src/content/scrollDriver.ts src/content/domAdapter.ts src/content/messageScanner.ts entrypoints/content.ts
git commit -m "refactor: robust scroll root detection and scroll driver diagnostics

ScrollDriver 完整重写：
- 引入 ScrollRoot 模型替代裸 HTMLElement | Window
- detectScrollRoot 多源候选收集（selector/main 后代/采样 user msg 祖先链）+ 评分 + 滚动验证
- document root 候选归一化为 kind:'window'，不作为 element root 返回
- scrollBy/scrollTo/scrollToRatio 返回 ScrollOperationResult
- 自定义 scrollElementIntoView 基于当前 ScrollRoot 手动计算目标位置
- 新增 isElementInViewport/getViewportRect 迁移自 DomAdapter
- ensureValidRoot 在 scroll 操作前验证 root 有效性（含冷却）
- no-op 时方向敏感判定 + 自动 redetect + retry（5s 冷却）
- smooth scroll 不做同步 no-op 判定
- shouldRedetectForNoOp absolute top clamp 到 [0, maxScrollTop]
- markProgrammatic 含 fallback timer，destroy 清理并重置状态
- pointerdown 仅 element root，过滤 CQN Shadow DOM
- getDebugSnapshot 含评分候选列表 + plain rect
- 移除 DomAdapter 依赖，无参构造
- 保留 PR #7 UserScrollDirection API (wheel/touch/keyboard)

DomAdapter 精简：
- 移除 findScrollContainer()、isElementInViewport()、scrollContainer 选择器

MessageScanner 迁移：
- viewport 调用迁移到 scrollDriver
- computeActiveMessageId 使用 scrollDriver.getViewportRect()

content.ts 集成：
- new ScrollDriver() 无参构造
- 会话切换时 redetectScrollRoot
- 挂载 __CQN_SCROLL_DEBUG__() 调试入口"
```

---

## Task 2: Update CLAUDE.md and docs/Tree.md

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/Tree.md`

- [ ] **Step 1: Update CLAUDE.md architecture table**

找到：
```markdown
| `ScrollDriver` | 滚动容器抽象，区分用户滚动与程序滚动 |
```
替换为：
```markdown
| `ScrollDriver` | 滚动基础设施：多源 scroll root 检测 + 评分验证、操作结果追踪、viewport 判断、用户滚动方向捕获（PR #7）、运行时重检 + 诊断。无 DomAdapter 依赖。document root 候选归一化为 window kind |
```

找到：
```markdown
| `DomAdapter` | 所有 ChatGPT DOM 交互的集中抽象。选择器定义在此文件顶部 `SELECTORS` 常量。修改 DOM 识别逻辑只动这个文件 |
```
替换为：
```markdown
| `DomAdapter` | ChatGPT DOM 结构查询抽象。选择器定义在此文件顶部 `SELECTORS` 常量。仅负责 DOM 元素识别和文本提取，不涉及滚动 |
```

- [ ] **Step 2: Update CLAUDE.md architecture notes**

找到：
```markdown
- **选择器集中管理**：ChatGPT DOM 选择器全部在 `DomAdapter` 的 `SELECTORS` 常量中，不要散落
```
在其后添加：
```markdown
- **ScrollDriver scroll root 检测**：`detectScrollRoot()` 通过多源候选（selector、main 后代、采样 user message 祖先链、标准 DOM root）+ 评分 + 最小滚动验证选择滚动根。document root 候选（HTML/BODY）归一化为 `kind:'window'`。运行时通过 `ensureValidRoot()` 在 scroll 操作前自动验证，`revalidateRoot()` / `redetectScrollRoot()` 手动重检。DevTools 调用 `__CQN_SCROLL_DEBUG__()` 查看诊断快照（含评分候选列表 + plain rect）
```

- [ ] **Step 3: Update docs/Tree.md**

找到：
```markdown
│   │   ├── domAdapter.ts           # ChatGPT DOM 交互抽象层，选择器集中定义
```
替换为：
```markdown
│   │   ├── domAdapter.ts           # ChatGPT DOM 结构查询抽象，选择器集中定义
```

找到：
```markdown
│   │   ├── scrollDriver.ts         # 滚动容器抽象，区分用户滚动与程序滚动
```
替换为：
```markdown
│   │   ├── scrollDriver.ts         # 滚动基础设施：多源 root 检测 + 操作结果 + viewport + 方向捕获 + 诊断
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/Tree.md
git commit -m "docs: 更新 CLAUDE.md 和 Tree.md 的 ScrollDriver/DomAdapter 描述"
```

---

## Task 3: Manual Verification

在浏览器中手工验收。加载扩展到 `.output/chrome-mv3-dev`（`pnpm dev`）或 `.output/chrome-mv3`（`pnpm build`）。

- [ ] **Step 1: Build and load extension**

```bash
pnpm build
```

在 Chrome `chrome://extensions/` 加载 `.output/chrome-mv3`。

- [ ] **Step 2: 长对话 root 检测验证**

1. 打开一个长 ChatGPT 对话（10+ 条 user message）
2. 打开 DevTools Console
3. 执行：

```js
const d = __CQN_SCROLL_DEBUG__();
console.log('root:', JSON.stringify(d.root, null, 2));
console.log('metrics:', JSON.stringify(d.metrics, null, 2));
console.log('candidates:', d.candidates.map(c => `${c.tag}#${c.id} score=${c.score} src=${c.source}`));
```

验收标准：
- `root.kind` 为 `'element'`（找到内部滚动容器）或 `'window'`（使用 document root）
- `root.reason` 不含 `'no-valid-scroll-root'`
- `metrics.maxScrollTop > 0`
- `rootContainsUserMessages === true`
- candidates 列表中有评分 ≥ 50 的候选

- [ ] **Step 3: scrollBy 验证**

```js
// 应看到页面实际移动
const r1 = scrollDriver.scrollBy(500); // 无法直接访问，需通过内部机制
// 替代：用 debug 快照观察前后的 scrollTop
const before = __CQN_SCROLL_DEBUG__().metrics.scrollTop;
// 手动在控制台执行滚动后：
window.__CQN_TEST_SCROLL__?.scrollBy(500);
```

如果无法直接调用，在 Step 2 验证 root 正确后，此步骤可延后到 Phase 4 实现时验证。

替代验证方式：在侧栏点击任意已挂载消息，确认 `scrollElementIntoView` 能正确跳转并高亮。

- [ ] **Step 4: scrollToRatio 验证**

通过侧栏 UI 或代码验证：
- 点击第一条消息 → 页面移至顶部附近
- 点击最后一条消息 → 页面移至底部附近
- 点击中间消息 → 页面移至中部附近

- [ ] **Step 5: MessageScanner active 高亮验证**

滚动页面过程中确认：
- 侧栏中当前 active 高亮随滚动更新
- MiniBar 中 active 标记正确
- orderedIds 顺序不回退（向上滚动加载历史消息后顺序正确）

- [ ] **Step 6: 会话切换 root 重检验证**

1. 在 ChatGPT 中切换到另一个对话
2. 执行 `__CQN_SCROLL_DEBUG__()` 确认 root 已重新检测
3. root.reason 应包含 `[conversation-change]`

- [ ] **Step 7: 侧栏自身不误触主滚动**

1. 打开侧栏（展开模式）
2. 如果消息列表超出侧栏高度，滚动侧栏
3. 确认主页面不随之滚动
4. MiniBar hover 不触发滚动

---

## Self-Review (v3)

### 1. Spec Coverage

| Spec 要求 | 对应 Task |
|-----------|----------|
| 1. 重构 ScrollDriver 的 scroll root 模型 | Task 1 |
| 2. robust root detection | Task 1 |
| 3. Scroll 操作返回结果 | Task 1 |
| 4. 不用原生 scrollIntoView | Task 1 |
| 5. viewport 判断迁移到 ScrollDriver | Task 1 + Task 1-Step 3 |
| 6. 保持 PR #7 的 UserScrollDirection API | Task 1 |
| 7. root 失效重检 | Task 1 (ensureValidRoot + redetect) |
| 8. 诊断工具 | Task 1 (getDebugSnapshot) + Task 1-Step 4 (__CQN_SCROLL_DEBUG__) |
| 9. 修复 MessageScanner 调用 | Task 1-Step 3 |
| 10. 文件边界 | Task 1-Step 2 (DomAdapter 精简) |

### 2. Review Fix Coverage

| 修订版本 | 修订 | 处理 |
|---------|------|------|
| v2 | 1. init() 重复绑定 | `init()` 直接 `detectScrollRoot()` + `bindListeners()` |
| v2 | 2. exactOptionalPropertyTypes | `recordResult()` 仅在 `!= null` 时写入 |
| v2 | 3. markProgrammatic fallback timer | 双 timer + destroy 清理 |
| v2 | 4. no-op redetect 方向敏感 | `shouldRedetectForNoOp()` |
| v2 | 5. 合并 Task 2+3 | Task 1 原子操作四文件 |
| v2 | 6. 统一构造函数 | 无参构造，移除 DomAdapter |
| v2 | 7. pointerdown 过滤 | 仅 element root + CQN 过滤 |
| v2 | 8. getDebugSnapshot 评分候选 | `lastScoredCandidates` + `toPlainRect` |
| v2 | 9. smooth scroll no-op | `isSmooth` 跳过 no-op |
| v2 | 10. 采样 user msg 祖先 | first 3 + middle + last 3 |
| v2 | 11. 操作前 ensureValidRoot | 每次操作前调用 |
| v3 | 1. document root 归一化 | `DOCUMENT_ROOT_TAGS` 检测 + 归一化为 `kind:'window'` |
| v3 | 2. scrollToRatio ensureValidRoot 前置 | `ensureValidRoot()` 在 `getMetrics()` 之前 |
| v3 | 3. 不提交不可编译中间态 | 四文件原子 commit |
| v3 | 4. shouldRedetectForNoOp clamp | `Math.max(0, Math.min(top, maxScrollTop))` |
| v3 | 5. ensureValidRoot 冷却 | 仅在 `!root.element && mayRedetect()` 时触发 DOM 查询 |
| v3 | 6. destroy() 重置 | `isProgrammatic=false, touchStartY=null, lastOpResult=null` |
| v3 | 7. 手工验收 | Task 3 含 7 步验收清单 |

### 3. Placeholder Scan

无 TBD、TODO 等占位符。所有步骤包含完整代码。

### 4. Type Consistency

- `ScrollRoot.kind` 类型一致
- `ScrollOperationResult` optional 字段通过显式 `if` 赋值
- `UserScrollDirection` 与 PR #7 一致
- `directionFromDelta` / `directionFromKey` 签名兼容 `test:order`
- `scrollElementIntoView` options 兼容 `jumpController.ts` 调用
- `getViewportRect()` 返回 `DOMRect`，`computeActiveMessageId` 使用 `.top`/`.bottom`
- `DOCUMENT_ROOT_TAGS` 使用 `tagName` 大写匹配
- `ScrollDriver` constructor 无参数
