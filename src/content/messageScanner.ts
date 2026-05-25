import type { CachedMessage, ResolveResult, ScanResult, ScannedUserMessageCandidate, VisibleRange } from '../shared/types';
import { hashText } from '../shared/hash';
import { toPreview, toSearchText } from '../shared/text';
import type { CacheStore } from './cacheStore';
import type { DomAdapter } from './domAdapter';
import type { ScanDirection, ScanSegmentKind } from './orderList';
import type { RuntimeStore } from './runtimeStore';
import type { ScrollDriver } from './scrollDriver';
import type { UserScrollDirection } from './scrollDriver';

const MUTATION_DEBOUNCE_MS = 500;
const SCROLL_THROTTLE_MS = 300;
const MIN_SEGMENT_GAP_PX = 320;

interface ScannedCandidateSegment {
  candidates: ScannedUserMessageCandidate[];
  direction: ScanDirection;
  kind: ScanSegmentKind;
}

export class MessageScanner {
  private mutationObserver: MutationObserver | null = null;
  private intersectionObserver: IntersectionObserver | null = null;
  private mutationTimer: number | null = null;
  private scrollTimer: number | null = null;
  private elementById = new Map<string, HTMLElement>();
  private mountedIds = new Set<string>();
  private cleanupScroll: (() => void) | null = null;
  private cleanupUserScroll: (() => void) | null = null;
  private lastScanScrollTop: number | null = null;
  private lastObservedScrollTop: number | null = null;
  private lastObservedDirection: ScanDirection = 'unknown';

  constructor(
    private readonly domAdapter: DomAdapter,
    private readonly cacheStore: CacheStore,
    private readonly scrollDriver: ScrollDriver,
    private readonly runtimeStore: RuntimeStore
  ) {}

  start(): void {
    this.mutationObserver = new MutationObserver(() => this.scheduleRescan());
    this.mutationObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
    this.cleanupScroll = this.scrollDriver.onScroll(() => this.scheduleScrollCapture());
    this.cleanupUserScroll = this.scrollDriver.onUserScroll((direction) => this.captureUserScrollDirection(direction));
    this.scheduleRescan();
  }

  clearState(): void {
    this.elementById.clear();
    this.mountedIds = new Set();
    this.lastScanScrollTop = null;
    this.lastObservedScrollTop = null;
    this.lastObservedDirection = 'unknown';
    if (this.mutationTimer !== null) {
      window.clearTimeout(this.mutationTimer);
      this.mutationTimer = null;
    }
  }

  stop(): void {
    this.mutationObserver?.disconnect();
    this.intersectionObserver?.disconnect();
    this.cleanupScroll?.();
    this.cleanupUserScroll?.();
    this.elementById.clear();
    this.mountedIds.clear();
    this.lastScanScrollTop = null;
    this.lastObservedScrollTop = null;
    this.lastObservedDirection = 'unknown';
  }

  async rescan(): Promise<ScanResult> {
    this.scrollDriver.triggerRootCheck();

    const domConversationId = this.domAdapter.extractConversationId();
    const storedConversationId = this.runtimeStore.getSnapshot().conversationId;
    const conversationId = domConversationId ?? storedConversationId;
    if (!conversationId) {
      return { mountedIds: new Set(), activeMessageId: null, visibleRange: null, newOrUpdated: [] };
    }
    if (domConversationId && domConversationId !== storedConversationId) {
      await this.cacheStore.flush();
      this.runtimeStore.setConversationId(domConversationId);
      const cache = await this.cacheStore.loadConversation(domConversationId);
      this.runtimeStore.setMessages(cache?.messages ?? []);
    }

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

    const candidateSegments = this.createCandidateSegments(candidates, scanDirection);
    const sortedCandidates = candidateSegments.flatMap((segment) => segment.candidates);
    const result = await this.cacheStore.resolveScannedSegments(
      conversationId,
      candidateSegments.map((segment) => ({
        candidates: segment.candidates.map(({ element: _element, ...candidate }) => candidate),
        direction: segment.direction,
        kind: segment.kind
      }))
    );
    this.lastScanScrollTop = scrollTop;

    this.rebuildMountedMaps(result, sortedCandidates);

    // 注册 AI turn 锚点的 DOM 元素（不参与 resolveScannedSegments 候选流程）
    this.registerAnchorTurnElements(conversationId, result.allMessages);

    this.runtimeStore.setMessages(result.allMessages);
    this.runtimeStore.setMountedState(this.mountedIds, this.elementById);
    this.reobserveMountedElements();

    const activeMessageId = this.computeActiveMessageId();
    this.runtimeStore.setActiveMessageId(activeMessageId);

    return {
      mountedIds: new Set(this.mountedIds),
      activeMessageId,
      visibleRange: this.computeVisibleRange(),
      newOrUpdated: result.newOrUpdated
    };
  }

  getElementByLocalId(localId: string): HTMLElement | undefined {
    return this.elementById.get(localId);
  }

  getMountedIds(): Set<string> {
    return new Set(this.mountedIds);
  }

  updateScrollMeta(localId: string, scrollTop: number, scrollRatio: number): void {
    const snapshot = this.runtimeStore.getSnapshot();
    const target = snapshot.messages.find((message) => message.localMessageId === localId);
    if (!target || !snapshot.conversationId) return;

    this.cacheStore.updateMessageScrollMeta(target.localMessageId, scrollTop, scrollRatio);
  }

  private scheduleRescan(): void {
    if (this.mutationTimer !== null) window.clearTimeout(this.mutationTimer);
    this.mutationTimer = window.setTimeout(() => {
      void this.rescan().catch((error) => console.warn('[ChatGPT Navigator] rescan failed', error));
    }, MUTATION_DEBOUNCE_MS);
  }

  private scheduleScrollCapture(): void {
    this.captureObservedScrollDirection();
    if (this.scrollTimer !== null) return;
    this.scrollTimer = window.setTimeout(() => {
      this.scrollTimer = null;
      const snapshot = this.runtimeStore.getSnapshot();
      const userIds = new Set(
        snapshot.messages.filter(m => m.role === 'user').map(m => m.localMessageId)
      );
      for (const localId of this.mountedIds) {
        if (!userIds.has(localId)) continue;
        const el = this.elementById.get(localId);
        if (el && this.scrollDriver.isElementInViewport(el)) {
          this.updateScrollMeta(localId, this.scrollDriver.getScrollTop(), this.scrollDriver.getScrollRatio());
        }
      }
      this.runtimeStore.setActiveMessageId(this.computeActiveMessageId());
    }, SCROLL_THROTTLE_MS);
  }

  private rebuildMountedMaps(result: ResolveResult, candidates: ScannedUserMessageCandidate[]): void {
    this.elementById.clear();
    this.mountedIds = new Set(result.resolvedMounted);

    for (const resolved of result.resolvedCandidates) {
      const candidate = candidates[resolved.candidateIndex];
      if (candidate) this.elementById.set(resolved.localMessageId, candidate.element);
    }
  }

  private createCandidateSegments(
    candidates: ScannedUserMessageCandidate[],
    direction: ScanDirection
  ): ScannedCandidateSegment[] {
    const sorted = [...candidates].sort((a, b) => a.absoluteTop - b.absoluteTop);
    if (sorted.length === 0) return [];

    const threshold = Math.max(MIN_SEGMENT_GAP_PX, this.scrollDriver.getClientHeight() * 0.8);
    const chunks: ScannedUserMessageCandidate[][] = [];
    let current: ScannedUserMessageCandidate[] = [];

    for (const candidate of sorted) {
      const previous = current[current.length - 1];
      if (previous && candidate.absoluteTop - previous.absoluteTop > threshold) {
        chunks.push(current);
        current = [];
      }
      current.push(candidate);
    }
    if (current.length > 0) chunks.push(current);

    return chunks.map((chunk, index) => ({
      candidates: chunk,
      direction,
      kind: this.segmentKind(index, chunks.length)
    }));
  }

  private segmentKind(index: number, count: number): ScanSegmentKind {
    if (count === 1) return 'local-contiguous';
    if (index === 0) return 'detached-top';
    if (index === count - 1) return 'detached-bottom';
    return 'local-contiguous';
  }

  private getScanDirection(scrollTop: number): ScanDirection {
    if (this.lastScanScrollTop === null) return this.lastObservedDirection;
    if (scrollTop < this.lastScanScrollTop) return 'up';
    if (scrollTop > this.lastScanScrollTop) return 'down';
    return this.lastObservedDirection;
  }

  private captureUserScrollDirection(direction: UserScrollDirection): void {
    if (direction !== 'unknown') this.lastObservedDirection = direction;
    this.lastObservedScrollTop = this.scrollDriver.getScrollTop();
  }

  private captureObservedScrollDirection(): void {
    const scrollTop = this.scrollDriver.getScrollTop();
    if (this.lastObservedScrollTop !== null) {
      if (scrollTop < this.lastObservedScrollTop) this.lastObservedDirection = 'up';
      if (scrollTop > this.lastObservedScrollTop) this.lastObservedDirection = 'down';
    }
    this.lastObservedScrollTop = scrollTop;
  }

  private reobserveMountedElements(): void {
    this.intersectionObserver?.disconnect();
    this.intersectionObserver = new IntersectionObserver(() => {
      this.runtimeStore.setActiveMessageId(this.computeActiveMessageId());
    }, { threshold: [0, 0.25, 0.5, 1] });

    this.elementById.forEach((element) => {
      this.intersectionObserver?.observe(element);
    });
  }

  private registerAnchorTurnElements(conversationId: string, allMessages: CachedMessage[]): void {
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

      if (!this.elementById.has(localId)) {
        const assistantEl = turnEl.querySelector<HTMLElement>('[data-message-author-role="assistant"]');
        if (!assistantEl || !assistantEl.isConnected) continue;

        // 验证 DOM 元素有有效视觉尺寸（排除 skeleton）
        const rect = assistantEl.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;

        this.elementById.set(localId, assistantEl);
        this.mountedIds.add(localId);
      }
    }
  }

  private computeActiveMessageId(): string | null {
    const viewport = this.scrollDriver.getViewportRect();
    const probeY = viewport.top + (viewport.bottom - viewport.top) * 0.4;

    const entries = Array.from(this.elementById.entries())
      .map(([id, element]) => ({ id, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.bottom >= viewport.top && rect.top <= viewport.bottom);

    // 优先选择包含 probe line 的消息（40% 高度处）
    const containingProbe = entries
      .filter(({ rect }) => rect.top <= probeY && rect.bottom >= probeY)
      .sort((a, b) => Math.abs(a.rect.top - probeY) - Math.abs(b.rect.top - probeY))[0];
    if (containingProbe) return containingProbe.id;

    // probe line 没命中 → 选择 viewport 顶部以下最近的消息
    const firstBelowTop = entries
      .filter(({ rect }) => rect.top >= viewport.top)
      .sort((a, b) => a.rect.top - b.rect.top)[0];
    if (firstBelowTop) return firstBelowTop.id;

    // viewport 内无消息 → 取 viewport 上方最近的消息
    const nearestAbove = Array.from(this.elementById.entries())
      .map(([id, element]) => ({ id, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.top < viewport.top)
      .sort((a, b) => b.rect.top - a.rect.top)[0];

    return nearestAbove?.id ?? null;
  }

  private computeVisibleRange(): VisibleRange | null {
    const snapshot = this.runtimeStore.getSnapshot();
    const visibleOrderKeys = snapshot.messages
      .filter((message) => message.role === 'user')
      .filter((message) => {
        const element = this.elementById.get(message.localMessageId);
        return element ? this.scrollDriver.isElementInViewport(element) : false;
      })
      .map((message) => message.orderKey);

    if (visibleOrderKeys.length === 0) return null;
    return {
      minOrderKey: Math.min(...visibleOrderKeys),
      maxOrderKey: Math.max(...visibleOrderKeys)
    };
  }
}
