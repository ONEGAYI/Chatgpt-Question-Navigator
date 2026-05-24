import type {
  CachedUserMessage,
  ConversationCache,
  ResolveResult,
  ScannedUserMessageCandidate,
  StorageMeta
} from '../shared/types';
import { inferDirectionFromScrollAnchor, mergeOrderedSegments, orderMessagesByIds } from './orderList';
import type { OrderedIdSegment, ScanDirection, ScanSegmentKind } from './orderList';

type StoredCandidate = Omit<ScannedUserMessageCandidate, 'element'>;
export interface StoredCandidateSegment {
  candidates: StoredCandidate[];
  direction: ScanDirection;
  kind: ScanSegmentKind;
}

const META_KEY = 'meta';
const CACHE_PREFIX = 'conv:';
const SAVE_DEBOUNCE_MS = 2000;
const STORAGE_LIMIT_BYTES = 8 * 1024 * 1024;
const STORAGE_CLEAN_TARGET_BYTES = Math.floor(STORAGE_LIMIT_BYTES * 0.8);

const defaultMeta = (): StorageMeta => ({
  conversationIds: [],
  totalBytes: 0,
  lastCleanupAt: 0
});

export class CacheStore {
  private currentCache: ConversationCache | null = null;
  private dirty = false;
  private saveTimer: number | null = null;

  async loadConversation(id: string): Promise<ConversationCache | null> {
    await this.flush();
    const key = this.cacheKey(id);
    const result = await chrome.storage.local.get(key);
    const cache = result[key] as ConversationCache | undefined;
    const normalized = cache ? this.normalizeCache(cache) : null;
    this.currentCache = normalized ?? this.createEmptyCache(id);
    this.dirty = false;
    return normalized;
  }

  async saveConversation(cache: ConversationCache): Promise<void> {
    const normalized = this.normalizeCache({ ...cache, updatedAt: Date.now() });
    await chrome.storage.local.set({ [this.cacheKey(cache.conversationId)]: normalized });
    await this.touchMeta(cache.conversationId);
    this.currentCache = normalized;
    this.dirty = false;
    await this.performLruCleanupIfNeeded();
  }

  async clearConversation(id: string): Promise<void> {
    await chrome.storage.local.remove(this.cacheKey(id));
    const meta = await this.loadMeta();
    meta.conversationIds = meta.conversationIds.filter((conversationId) => conversationId !== id);
    meta.totalBytes = await this.getBytesInUse();
    await chrome.storage.local.set({ [META_KEY]: meta });
    if (this.currentCache?.conversationId === id) this.currentCache = null;
  }

  async clearAll(): Promise<void> {
    const meta = await this.loadMeta();
    const keys = meta.conversationIds.map((id) => this.cacheKey(id));
    await chrome.storage.local.remove([...keys, META_KEY]);
    this.currentCache = null;
    this.dirty = false;
  }

  async resolveScannedCandidates(conversationId: string, candidates: StoredCandidate[]): Promise<ResolveResult> {
    return this.resolveScannedSegments(conversationId, [{
      candidates,
      direction: 'unknown',
      kind: 'local-contiguous'
    }]);
  }

  async resolveScannedSegments(conversationId: string, segments: StoredCandidateSegment[]): Promise<ResolveResult> {
    this.ensureCurrentCache(conversationId);

    const now = Date.now();
    const existing = this.currentCache!.messages;
    const existingOrderedIds = this.currentCache!.orderedIds;
    const usedExisting = new Set<string>();
    const resolvedMounted = new Set<string>();
    const resolvedCandidates: ResolveResult['resolvedCandidates'] = [];
    const resolvedSegments: OrderedIdSegment[] = [];
    const newOrUpdated: CachedUserMessage[] = [];
    const nextMessagesById = new Map<string, CachedUserMessage>(existing.map((message) => [message.localMessageId, message]));
    let candidateIndex = 0;

    for (const segment of segments) {
      const segmentIds: string[] = [];
      for (const candidate of segment.candidates) {
        const matched = this.matchCandidate(conversationId, candidate, existing, usedExisting);
        const occurrenceIndex = matched?.occurrenceIndex ?? this.nextOccurrenceIndex(conversationId, candidate.textHash, existing, nextMessagesById);
        const localMessageId = matched?.localMessageId ?? this.createLocalMessageId(conversationId, candidate.observedDomMessageId, candidate.textHash, occurrenceIndex);

        const next: CachedUserMessage = {
          conversationId,
          localMessageId,
          role: 'user',
          textForSearch: candidate.textForSearch,
          preview: candidate.preview,
          textHash: candidate.textHash,
          occurrenceIndex,
          firstSeenAt: matched?.firstSeenAt ?? now,
          lastSeenAt: now,
          lastKnownScrollTop: candidate.scrollTop,
          lastKnownScrollRatio: candidate.scrollRatio,
          orderKey: matched?.orderKey ?? candidate.absoluteTop
        };

        if (!matched || this.hasMeaningfulChange(matched, next)) {
          newOrUpdated.push(next);
          this.dirty = true;
        }

        usedExisting.add(localMessageId);
        resolvedMounted.add(localMessageId);
        resolvedCandidates.push({ localMessageId, candidateIndex });
        segmentIds.push(localMessageId);
        nextMessagesById.set(localMessageId, next);
        candidateIndex += 1;
      }

      resolvedSegments.push({
        ids: segmentIds,
        direction: segment.direction === 'unknown'
          ? inferDirectionFromScrollAnchor({
            segmentRatio: averageScrollRatio(segment.candidates),
            existingRatios: existing.map((message) => message.lastKnownScrollRatio)
          })
          : segment.direction,
        kind: segment.kind
      });
    }

    const orderedIds = mergeOrderedSegments(existingOrderedIds, resolvedSegments);
    const allMessages = orderMessagesByIds(nextMessagesById, orderedIds);
    if (!arraysEqual(existingOrderedIds, orderedIds)) this.dirty = true;

    this.currentCache = {
      conversationId,
      updatedAt: now,
      messages: allMessages,
      orderedIds
    };

    if (this.dirty) this.scheduleSave();

    return { allMessages, resolvedMounted, resolvedCandidates, newOrUpdated };
  }

  updateMessageScrollMeta(localMessageId: string, scrollTop: number, scrollRatio: number): void {
    if (!this.currentCache) return;
    const now = Date.now();
    const messages = this.currentCache.messages.map((message) => {
      if (message.localMessageId !== localMessageId) return message;
      return {
        ...message,
        lastSeenAt: now,
        lastKnownScrollTop: scrollTop,
        lastKnownScrollRatio: scrollRatio
      };
    });
    const changed = messages.some((message, index) => message !== this.currentCache!.messages[index]);
    if (!changed) return;

    const messagesById = new Map<string, CachedUserMessage>(messages.map((message) => [message.localMessageId, message]));
    this.currentCache = {
      ...this.currentCache,
      updatedAt: now,
      messages: orderMessagesByIds(messagesById, this.currentCache.orderedIds)
    };
    this.dirty = true;
    this.scheduleSave();
  }

  async migrateTempCache(tempId: string, realId: string): Promise<void> {
    const temp = await this.loadRawConversation(tempId);
    if (!temp) return;

    const migrated: ConversationCache = {
      conversationId: realId,
      updatedAt: Date.now(),
      messages: temp.messages.map((message) => ({
        ...message,
        conversationId: realId,
        localMessageId: message.localMessageId.replace(`${tempId}::`, `${realId}::`)
      })),
      orderedIds: temp.orderedIds.map((id) => id.replace(`${tempId}::`, `${realId}::`))
    };

    await chrome.storage.local.set({ [this.cacheKey(realId)]: migrated });
    await chrome.storage.local.remove(this.cacheKey(tempId));
    await this.touchMeta(realId);
    const meta = await this.loadMeta();
    meta.conversationIds = meta.conversationIds.filter((id) => id !== tempId);
    await chrome.storage.local.set({ [META_KEY]: meta });
    this.currentCache = migrated;
    this.dirty = false;
  }

  async getBytesInUse(): Promise<number> {
    return chrome.storage.local.getBytesInUse(null);
  }

  async performLruCleanupIfNeeded(): Promise<void> {
    let bytes = await this.getBytesInUse();
    if (bytes <= STORAGE_LIMIT_BYTES) return;

    const meta = await this.loadMeta();
    const ids = [...meta.conversationIds];

    while (bytes > STORAGE_CLEAN_TARGET_BYTES && ids.length > 1) {
      const victim = ids.pop();
      if (!victim) break;
      if (victim === this.currentCache?.conversationId) {
        ids.unshift(victim);
        break;
      }
      await chrome.storage.local.remove(this.cacheKey(victim));
      bytes = await this.getBytesInUse();
    }

    meta.conversationIds = ids;
    meta.totalBytes = bytes;
    meta.lastCleanupAt = Date.now();
    await chrome.storage.local.set({ [META_KEY]: meta });
  }

  async flush(): Promise<void> {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.currentCache && this.dirty) {
      await this.saveConversation(this.currentCache);
    }
  }

  private ensureCurrentCache(conversationId: string): void {
    if (this.currentCache?.conversationId === conversationId) return;
    this.currentCache = this.createEmptyCache(conversationId);
    this.dirty = false;
  }

  private matchCandidate(
    conversationId: string,
    candidate: StoredCandidate,
    existing: CachedUserMessage[],
    usedExisting: Set<string>
  ): CachedUserMessage | null {
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

  private nextOccurrenceIndex(
    conversationId: string,
    textHash: string,
    existing: CachedUserMessage[],
    nextMessagesById: Map<string, CachedUserMessage>
  ): number {
    const indexes = [...existing, ...nextMessagesById.values()]
      .filter((message) => message.conversationId === conversationId && message.textHash === textHash)
      .map((message) => message.occurrenceIndex);
    return indexes.length === 0 ? 0 : Math.max(...indexes) + 1;
  }

  private createLocalMessageId(conversationId: string, observedDomMessageId: string | null, textHash: string, occurrenceIndex: number): string {
    if (observedDomMessageId) return `${conversationId}::dom::${observedDomMessageId}`;
    return `${conversationId}::hash::${textHash}::${occurrenceIndex}`;
  }

  private hasMeaningfulChange(previous: CachedUserMessage, next: CachedUserMessage): boolean {
    return previous.preview !== next.preview
      || previous.textForSearch !== next.textForSearch
      || previous.lastKnownScrollTop !== next.lastKnownScrollTop
      || previous.lastKnownScrollRatio !== next.lastKnownScrollRatio;
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      void this.flush().catch((error) => console.warn('[ChatGPT Navigator] Failed to save cache', error));
    }, SAVE_DEBOUNCE_MS);
  }

  private async loadRawConversation(id: string): Promise<ConversationCache | null> {
    const key = this.cacheKey(id);
    const result = await chrome.storage.local.get(key);
    const cache = result[key] as ConversationCache | undefined;
    return cache ? this.normalizeCache(cache) : null;
  }

  private async loadMeta(): Promise<StorageMeta> {
    const result = await chrome.storage.local.get(META_KEY);
    return (result[META_KEY] as StorageMeta | undefined) ?? defaultMeta();
  }

  private async touchMeta(conversationId: string): Promise<void> {
    const meta = await this.loadMeta();
    meta.conversationIds = [conversationId, ...meta.conversationIds.filter((id) => id !== conversationId)];
    meta.totalBytes = await this.getBytesInUse();
    await chrome.storage.local.set({ [META_KEY]: meta });
  }

  private cacheKey(id: string): string {
    return `${CACHE_PREFIX}${id}`;
  }

  private createEmptyCache(conversationId: string): ConversationCache {
    return { conversationId, updatedAt: Date.now(), messages: [], orderedIds: [] };
  }

  private normalizeCache(cache: ConversationCache): ConversationCache {
    const messagesById = new Map<string, CachedUserMessage>(cache.messages.map((message) => [message.localMessageId, message]));
    const storedOrderedIds = Array.isArray(cache.orderedIds) ? cache.orderedIds : [];
    const orderedIds = appendMissingIds(
      storedOrderedIds.filter((id) => messagesById.has(id)),
      cache.messages.map((message) => message.localMessageId)
    );

    return {
      ...cache,
      messages: orderMessagesByIds(messagesById, orderedIds),
      orderedIds
    };
  }
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function appendMissingIds(existingIds: string[], candidateIds: string[]): string[] {
  const result = [...existingIds];
  const known = new Set(result);
  for (const id of candidateIds) {
    if (known.has(id)) continue;
    result.push(id);
    known.add(id);
  }
  return result;
}

function averageScrollRatio(candidates: StoredCandidate[]): number | null {
  if (candidates.length === 0) return null;
  const total = candidates.reduce((sum, candidate) => sum + candidate.scrollRatio, 0);
  return total / candidates.length;
}
