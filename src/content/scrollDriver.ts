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

      // 2b. Ancestors of <main> with scrollable overflow (covers parent scroll container)
      let ancestor = main.parentElement;
      while (ancestor && ancestor !== document.body && ancestor !== document.documentElement) {
        const style = getComputedStyle(ancestor);
        if (['auto', 'scroll', 'overlay'].includes(style.overflowY)) {
          addCandidate(ancestor, 'main-ancestor', `main ancestor overflow-y:${style.overflowY}`);
        }
        ancestor = ancestor.parentElement;
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
      const retryExtra: { requestedDelta?: number; requestedTop?: number; reason?: string } = { reason: 'redetect-retry' };
      if (options.top != null) retryExtra.requestedTop = options.top;
      return this.recordResult(
        retryAfter.scrollTop !== before.scrollTop,
        before,
        retryAfter,
        retryExtra,
      );
    }

    const finalExtra: { requestedDelta?: number; requestedTop?: number; reason?: string } = {};
    if (options.top != null) finalExtra.requestedTop = options.top;
    return this.recordResult(moved, before, after, finalExtra);
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

      inputTarget.addEventListener('pointerdown', onPointerDown as EventListener, { passive: true });
      this.cleanupFns.push(() => (inputTarget as HTMLElement).removeEventListener('pointerdown', onPointerDown as EventListener));
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
