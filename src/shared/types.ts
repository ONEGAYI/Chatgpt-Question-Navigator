export interface CachedUserMessage {
  conversationId: string;
  localMessageId: string;
  role: 'user';
  textForSearch: string;
  preview: string;
  textHash: string;
  occurrenceIndex: number;
  firstSeenAt: number;
  lastSeenAt: number;
  lastKnownScrollTop: number;
  lastKnownScrollRatio: number;
  orderKey: number;
}

export interface ConversationCache {
  conversationId: string;
  updatedAt: number;
  messages: CachedUserMessage[];
  orderedIds: string[];
}

export interface StorageMeta {
  conversationIds: string[];
  totalBytes: number;
  lastCleanupAt: number;
}

export interface ScannedUserMessageCandidate {
  observedDomMessageId: string | null;
  text: string;
  textHash: string;
  preview: string;
  textForSearch: string;
  scrollRatio: number;
  scrollTop: number;
  absoluteTop: number;
  element: HTMLElement;
}

export interface ResolveResult {
  allMessages: CachedUserMessage[];
  resolvedMounted: Set<string>;
  resolvedCandidates: Array<{
    localMessageId: string;
    candidateIndex: number;
  }>;
  newOrUpdated: CachedUserMessage[];
}

export type JumpState =
  | { status: 'idle' }
  | { status: 'jumping'; targetId: string; attempt: number }
  | { status: 'failed'; targetId: string; reason: string };

export interface RuntimeState {
  conversationId: string | null;
  messages: CachedUserMessage[];
  elementById: Map<string, HTMLElement>;
  mountedIds: Set<string>;
  activeMessageId: string | null;
  jumpState: JumpState;
}

export interface VisibleRange {
  minIndex: number;
  maxIndex: number;
}

export interface ScanResult {
  mountedIds: Set<string>;
  activeMessageId: string | null;
  visibleRange: VisibleRange | null;
  newOrUpdated: CachedUserMessage[];
}
