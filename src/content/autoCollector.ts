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
  absoluteTop: number;
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
const SCROLL_STEP_RATIO = 0.75;
const SETTLE_STABLE_MS = 500;
const SETTLE_QUIET_MS = 400;
const SETTLE_TIMEOUT_MS = 5000;
const SETTLE_POLL_MS = 100;
const NO_NEW_CANDIDATES_LIMIT = 5;
const ABSOLUTE_TOP_BUCKET = 100;

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
    private readonly afterReplace?: () => Promise<void>,
  ) {}

  // --- Public API ---

  getProgress(): AutoCollectProgress {
    const progress: AutoCollectProgress = {
      phase: this.phase,
      conversationId: this.currentConversationId,
      foundCount: this.foundCount,
      round: this.round,
    };
    if (this.errorMessage) {
      progress.errorMessage = this.errorMessage;
    }
    return progress;
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

      this.scrollDriver.scrollToRatio(1);
      await this.waitForPageSettled();

      if (this.cancelRequested) { this.setPhase('cancelled'); return; }

      const metrics = this.scrollDriver.getMetrics();
      if (metrics.maxScrollTop <= 8) {
        const batch = await this.extractCurrentBatch(0);
        await this.finalize([batch], conversationId);
        return;
      }

      this.setPhase('collecting');

      const batches: CollectedBatch[] = [];
      let consecutiveNoNew = 0;
      const seenKeys = new Set<string>();

      while (this.round < MAX_ROUNDS && !this.cancelRequested) {
        const batch = await this.extractCurrentBatch(this.round);

        let newCount = 0;
        for (const c of batch.candidates) {
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
        absoluteTop: this.scrollDriver.getAbsoluteTop(el),
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

    await this.afterReplace?.();

    this.setPhase('completed');
  }

  private mergeBatches(batches: CollectedBatch[], conversationId: string): CachedUserMessage[] {
    const reversed = [...batches].reverse();

    const seenDomIds = new Set<string>();
    const seenBucketKeys = new Set<string>();
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
