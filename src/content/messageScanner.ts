import type { CachedMessage, ResolveResult, ScanResult, ScannedMessageCandidate, VisibleRange } from '../shared/types';
import { hashText } from '../shared/hash';
import { toAiPreview, toAiSearchText, toPreview, toSearchText } from '../shared/text';
import type { CacheStore } from './cacheStore';
import { DomAdapter } from './domAdapter';
import type { ScanDirection, ScanSegmentKind } from './orderList';
import type { RuntimeStore } from './runtimeStore';
import type { ScrollDriver } from './scrollDriver';
import type { UserScrollDirection } from './scrollDriver';

const MUTATION_DEBOUNCE_MS = 500;
const STREAMING_DEBOUNCE_MS = 3000;
const SCROLL_THROTTLE_MS = 300;
const MIN_SEGMENT_GAP_PX = 320;

interface ScannedCandidateSegment {
  candidates: ScannedMessageCandidate[];
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
  private rescanGeneration = 0;

  constructor(
    private readonly domAdapter: DomAdapter,
    private readonly cacheStore: CacheStore,
    private readonly scrollDriver: ScrollDriver,
    private readonly runtimeStore: RuntimeStore
  ) {}

  start(): void {
    this.mutationObserver = new MutationObserver((records) => this.handleMutations(records));
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
    if (this.mutationTimer !== null) {
      window.clearTimeout(this.mutationTimer);
      this.mutationTimer = null;
    }
    if (this.scrollTimer !== null) {
      window.clearTimeout(this.scrollTimer);
      this.scrollTimer = null;
    }
    this.elementById.clear();
    this.mountedIds.clear();
    this.lastScanScrollTop = null;
    this.lastObservedScrollTop = null;
    this.lastObservedDirection = 'unknown';
  }

  async rescan(): Promise<ScanResult> {
    this.rescanGeneration += 1;
    const generation = this.rescanGeneration;
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
          absoluteTop: this.scrollDriver.getAbsoluteTop(userEl),
          element: userEl,
          turnKey,
          role: 'user',
          turnIndex,
        });
      } else {
        // assistant: 尝试从 DOM 提取文本；流式输出中则为空骨架
        const assistantEl = this.domAdapter.findRoleElementInTurn(turnEl, 'assistant');
        const text = assistantEl ? this.domAdapter.extractText(assistantEl) : '';

        let textHash: string;
        let preview: string;
        let textForSearch: string;

        if (text) {
          textForSearch = toAiSearchText(text);
          textHash = await hashText(textForSearch);
          preview = toAiPreview(text);
        } else {
          textHash = await hashText(`assistant:${turnKey}`);
          preview = '';
          textForSearch = '';
        }

        console.log('[CQN] rescan: assistant anchor turnKey=', turnKey, 'turnIndex=', turnIndex,
          'hasText=', !!text, 'preview=', preview.slice(0, 30));

        candidates.push({
          observedDomMessageId: null,
          text,
          textHash,
          preview,
          textForSearch,
          scrollRatio,
          scrollTop,
          absoluteTop: this.scrollDriver.getAbsoluteTop(turnEl),
          element: turnEl,
          turnKey,
          role: 'assistant',
          turnIndex,
        });
      }
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

    if (generation !== this.rescanGeneration) return { mountedIds: new Set(), activeMessageId: null, visibleRange: null, newOrUpdated: [] };

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

  private handleMutations(records: MutationRecord[]): void {
    const hasNewTurn = records.some((record) =>
      Array.from(record.addedNodes).some((node) =>
        node instanceof HTMLElement
        && (node.matches?.(DomAdapter.TURN_SELECTOR) || node.querySelector?.(DomAdapter.TURN_SELECTOR))
      )
    );

    if (hasNewTurn) {
      this.scheduleRescan();
    } else {
      this.scheduleRescan(STREAMING_DEBOUNCE_MS);
    }
  }

  private scheduleRescan(debounceMs: number = MUTATION_DEBOUNCE_MS): void {
    if (this.mutationTimer !== null) window.clearTimeout(this.mutationTimer);
    this.mutationTimer = window.setTimeout(() => {
      this.mutationTimer = null;
      void this.rescan().catch((error) => console.warn('[ChatGPT Navigator] rescan failed', error));
    }, debounceMs);
  }

  private scheduleScrollCapture(): void {
    this.captureObservedScrollDirection();
    if (this.scrollTimer !== null) return;
    this.scrollTimer = window.setTimeout(() => {
      this.scrollTimer = null;
      for (const localId of this.mountedIds) {
        const el = this.elementById.get(localId);
        if (el && this.scrollDriver.isElementInViewport(el)) {
          this.updateScrollMeta(localId, this.scrollDriver.getScrollTop(), this.scrollDriver.getScrollRatio());
        }
      }
      this.runtimeStore.setActiveMessageId(this.computeActiveMessageId());
    }, SCROLL_THROTTLE_MS);
  }

  private rebuildMountedMaps(result: ResolveResult, candidates: ScannedMessageCandidate[]): void {
    this.elementById.clear();
    this.mountedIds = new Set(result.resolvedMounted);

    for (const resolved of result.resolvedCandidates) {
      const candidate = candidates[resolved.candidateIndex];
      if (candidate) this.elementById.set(resolved.localMessageId, candidate.element);
    }
  }

  private createCandidateSegments(
    candidates: ScannedMessageCandidate[],
    direction: ScanDirection
  ): ScannedCandidateSegment[] {
    const sorted = [...candidates].sort((a, b) => a.absoluteTop - b.absoluteTop);
    if (sorted.length === 0) return [];

    const threshold = Math.max(MIN_SEGMENT_GAP_PX, this.scrollDriver.getClientHeight() * 0.8);
    const chunks: ScannedMessageCandidate[][] = [];
    let current: ScannedMessageCandidate[] = [];

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

    this.elementById.forEach((element) => this.intersectionObserver?.observe(element));
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

      if (!this.elementById.has(localId) && turnEl.isConnected) {
        this.elementById.set(localId, turnEl);
        this.mountedIds.add(localId);
      }
    }
  }

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

  private computeVisibleRange(): VisibleRange | null {
    const snapshot = this.runtimeStore.getSnapshot();
    const visibleOrderKeys = snapshot.messages
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
