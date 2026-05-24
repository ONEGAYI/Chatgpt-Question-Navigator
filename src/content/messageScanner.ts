import type { ResolveResult, ScanResult, ScannedUserMessageCandidate, VisibleRange } from '../shared/types';
import { hashText } from '../shared/hash';
import { toPreview, toSearchText } from '../shared/text';
import type { CacheStore } from './cacheStore';
import type { DomAdapter } from './domAdapter';
import type { RuntimeStore } from './runtimeStore';
import type { ScrollDriver } from './scrollDriver';

const MUTATION_DEBOUNCE_MS = 500;
const SCROLL_THROTTLE_MS = 300;

export class MessageScanner {
  private mutationObserver: MutationObserver | null = null;
  private intersectionObserver: IntersectionObserver | null = null;
  private mutationTimer: number | null = null;
  private scrollTimer: number | null = null;
  private elementById = new Map<string, HTMLElement>();
  private mountedIds = new Set<string>();
  private cleanupScroll: (() => void) | null = null;

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
    this.scheduleRescan();
  }

  stop(): void {
    this.mutationObserver?.disconnect();
    this.intersectionObserver?.disconnect();
    this.cleanupScroll?.();
    this.elementById.clear();
    this.mountedIds.clear();
  }

  async rescan(): Promise<ScanResult> {
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
        scrollTop: this.scrollDriver.getScrollTop(),
        absoluteTop: this.scrollDriver.getAbsoluteTop(element),
        element
      });
    }

    const result = await this.cacheStore.resolveScannedCandidates(
      conversationId,
      candidates.map(({ element: _element, ...candidate }) => candidate)
    );

    this.rebuildMountedMaps(result, candidates);
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

    void this.cacheStore.resolveScannedCandidates(snapshot.conversationId, [{
      observedDomMessageId: target.localMessageId.includes('::dom::') ? target.localMessageId.split('::dom::')[1] ?? null : null,
      text: target.textForSearch,
      textHash: target.textHash,
      preview: target.preview,
      textForSearch: target.textForSearch,
      scrollRatio,
      scrollTop,
      absoluteTop: target.orderKey
    }]);
  }

  private scheduleRescan(): void {
    if (this.mutationTimer !== null) window.clearTimeout(this.mutationTimer);
    this.mutationTimer = window.setTimeout(() => {
      void this.rescan().catch((error) => console.warn('[ChatGPT Navigator] rescan failed', error));
    }, MUTATION_DEBOUNCE_MS);
  }

  private scheduleScrollCapture(): void {
    if (this.scrollTimer !== null) return;
    this.scrollTimer = window.setTimeout(() => {
      this.scrollTimer = null;
      for (const localId of this.mountedIds) {
        const el = this.elementById.get(localId);
        if (el && this.domAdapter.isElementInViewport(el)) {
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

  private reobserveMountedElements(): void {
    this.intersectionObserver?.disconnect();
    this.intersectionObserver = new IntersectionObserver(() => {
      this.runtimeStore.setActiveMessageId(this.computeActiveMessageId());
    }, { threshold: [0, 0.25, 0.5, 1] });

    this.elementById.forEach((element) => this.intersectionObserver?.observe(element));
  }

  private computeActiveMessageId(): string | null {
    const entries = Array.from(this.elementById.entries())
      .map(([id, element]) => ({ id, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.bottom >= 0 && rect.top <= window.innerHeight);

    const visibleBelowTop = entries
      .filter(({ rect }) => rect.top >= 0)
      .sort((a, b) => a.rect.top - b.rect.top)[0];
    if (visibleBelowTop) return visibleBelowTop.id;

    const nearestAbove = Array.from(this.elementById.entries())
      .map(([id, element]) => ({ id, rect: element.getBoundingClientRect() }))
      .filter(({ rect }: { rect: DOMRect }) => rect.top < (0 as number))
      .sort((a, b) => b.rect.top - a.rect.top)[0];

    return nearestAbove?.id ?? null;
  }

  private computeVisibleRange(): VisibleRange | null {
    const snapshot = this.runtimeStore.getSnapshot();
    const visibleOrderKeys = snapshot.messages
      .filter((message) => {
        const element = this.elementById.get(message.localMessageId);
        return element ? this.domAdapter.isElementInViewport(element) : false;
      })
      .map((message) => message.orderKey);

    if (visibleOrderKeys.length === 0) return null;
    return {
      minOrderKey: Math.min(...visibleOrderKeys),
      maxOrderKey: Math.max(...visibleOrderKeys)
    };
  }
}
