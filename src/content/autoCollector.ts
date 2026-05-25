import type { AutoCollectIntent, AutoCollectPhase, AutoCollectProgress, CachedMessage, TurnFrame } from '../shared/types';
import { hashText } from '../shared/hash';
import { toPreview, toSearchText, toAiPreview, toAiSearchText } from '../shared/text';
import type { CacheStore } from './cacheStore';
import type { DomAdapter } from './domAdapter';
import type { RuntimeStore } from './runtimeStore';
import type { ScrollDriver } from './scrollDriver';
import type { ScrollProfile } from '../shared/scrollProfile';
import { AC_SETTLE_TIMEOUT_MS } from '../shared/scrollProfile';

// --- Constants ---

const INTENT_KEY = 'cqn-auto-collect-intent';
const MAX_ROUNDS = 500;
const STAGNANT_LIMIT = 3;
const NO_MOVEMENT_LIMIT = 5;
const FALLBACK_MAX_ROUNDS = 50;
const CHECKPOINT_EVERY_ROUNDS = 20;

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
  private frames = new Map<string, TurnFrame>();

  constructor(
    private readonly domAdapter: DomAdapter,
    private readonly cacheStore: CacheStore,
    private readonly scrollDriver: ScrollDriver,
    private readonly runtimeStore: RuntimeStore,
    private readonly afterReplace?: () => Promise<void>,
    private readonly getProfile: () => ScrollProfile = () => ({
      name: 'default' as const, label: '标准',
      acScrollStepRatio: 0.7, acSettleStableMs: 500, acSettleQuietMs: 400, acSettlePollMs: 100,
      jcSettleMs: 500, jcDecayRate: 0.03, jcMinDecay: 0.3,
    }),
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
        this.foundCount = this.countHydratedUserMessages();
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
          this.buildAllMessages(conversationId)
        );
        this.emitProgress();

        // Periodic checkpoint to persist progress across crashes
        if (this.round % CHECKPOINT_EVERY_ROUNDS === 0) {
          await this.checkpointProgress(conversationId);
        }

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
        const step = Math.floor(this.scrollDriver.getClientHeight() * this.getProfile().acScrollStepRatio);
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
      // Clear progress after terminal states so UI resets to normal
      const terminalPhase = this.phase;
      if (terminalPhase === 'cancelled' || terminalPhase === 'completed' || terminalPhase === 'failed') {
        setTimeout(() => {
          if (this.phase === terminalPhase) {
            this.runtimeStore.setAutoCollectProgress(null);
          }
        }, 3000);
      }
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
  }

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

  // --- Internal: User scroll detection ---

  private registerUserScrollListener(): void {
    this.cleanupUserScroll?.();
    this.cleanupUserScroll = this.scrollDriver.onUserScroll(() => {
      if (this.phase === 'collecting' || this.phase === 'preparing') {
        this.cancelRequested = true;
      }
    });
  }

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

    if (role === 'assistant') {
      const assistantEl = el.querySelector<HTMLElement>('[data-message-author-role="assistant"]');
      const text = assistantEl ? this.domAdapter.extractText(assistantEl) : '';
      if (text) {
        const search = toAiSearchText(text);
        frame.textHash = await hashText(search);
        frame.preview = toAiPreview(text);
        frame.textForSearch = search;
      } else {
        // 文本不可提取时使用 turnKey 派生 hash，确保 anchor 一定生成
        frame.textHash = await hashText(`assistant:${frame.turnKey}`);
        frame.preview = '';
        frame.textForSearch = '';
      }
    }

    frame.role = role;
    frame.hydrated = true;
    frame.lastHydratedAt = Date.now();
    frame.lastKnownScrollTop = this.scrollDriver.getScrollTop();
    frame.lastKnownScrollRatio = this.scrollDriver.getScrollRatio();
  }

  private buildAllMessages(conversationId: string): CachedMessage[] {
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
      turnKey: frame.turnKey,
      turnIndex: frame.turnIndex,
    }));
  }

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
          this.buildAllMessages(this.currentConversationId)
        );
        this.emitProgress();
      } else {
        stagnantRounds++;
      }

      if (this.frames.size - hydratedAfter === 0) break;
      if (stagnantRounds >= STAGNANT_LIMIT) break;

      const step = Math.floor(this.scrollDriver.getClientHeight() * this.getProfile().acScrollStepRatio);
      const beforeTop = this.scrollDriver.getScrollTop();
      this.scrollDriver.scrollBy(step);
      await this.waitForPageSettled();

      const afterTop = this.scrollDriver.getScrollTop();
      if (Math.abs(afterTop - beforeTop) < 2) break;

      fallbackRound++;
    }
  }

  private async checkpointProgress(conversationId: string): Promise<void> {
    const messages = this.buildAllMessages(conversationId);
    await this.cacheStore.replaceConversationMessages(conversationId, messages);
  }

  // --- Internal: Canonical finalization ---

  private async finalize(conversationId: string): Promise<void> {
    this.setPhase('finalizing');

    const messages = this.buildAllMessages(conversationId);
    await this.cacheStore.replaceConversationMessages(conversationId, messages);
    this.runtimeStore.setMessages(messages);

    try {
      await this.afterReplace?.();
    } catch (e) {
      console.warn('[CQN] afterReplace callback failed:', e);
    }

    this.setPhase('completed');
  }

  // --- Internal: Page settle detection ---

  private async waitForPageSettled(): Promise<void> {
    const profile = this.getProfile();
    const start = Date.now();
    let lastMutationTime = Date.now();
    let lastScrollTop = this.scrollDriver.getScrollTop();
    let stableSince = Date.now();

    const observer = new MutationObserver(() => {
      lastMutationTime = Date.now();
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    try {
      await this.delay(profile.acSettlePollMs);

      while (true) {
        if (this.cancelRequested) return;

        const now = Date.now();
        const currentScrollTop = this.scrollDriver.getScrollTop();

        if (Math.abs(currentScrollTop - lastScrollTop) > 2) {
          lastScrollTop = currentScrollTop;
          stableSince = now;
        }

        const scrollStable = (now - stableSince) >= profile.acSettleStableMs;
        const domQuiet = (now - lastMutationTime) >= profile.acSettleQuietMs;
        const timeout = (now - start) >= AC_SETTLE_TIMEOUT_MS;

        if ((scrollStable && domQuiet) || timeout) return;

        await this.delay(profile.acSettlePollMs);
      }
    } finally {
      observer.disconnect();
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
