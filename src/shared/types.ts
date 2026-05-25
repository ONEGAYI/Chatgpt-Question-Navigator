import type { ScrollProfileName } from './scrollProfile';

export interface CachedMessage {
  conversationId: string;
  localMessageId: string;
  role: 'user' | 'assistant';  // TODO(#12): CachedMessage → CachedMessage
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
  messages: CachedMessage[];
  orderedIds: string[];
  orderMode?: 'incremental' | 'canonical';
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
  turnKey: string | null;
}

export interface ResolveResult {
  allMessages: CachedMessage[];
  resolvedMounted: Set<string>;
  resolvedCandidates: Array<{
    localMessageId: string;
    candidateIndex: number;
  }>;
  newOrUpdated: CachedMessage[];
}

export type JumpState =
  | { status: 'idle' }
  | { status: 'jumping'; targetId: string; attempt: number }
  | { status: 'failed'; targetId: string; reason: string };

export interface RuntimeState {
  conversationId: string | null;
  messages: CachedMessage[];
  elementById: Map<string, HTMLElement>;
  mountedIds: Set<string>;
  activeMessageId: string | null;
  jumpState: JumpState;
  autoCollectProgress: AutoCollectProgress | null;
  scrollProfileName: ScrollProfileName;
}

export interface VisibleRange {
  minOrderKey: number;
  maxOrderKey: number;
}

export interface ScanResult {
  mountedIds: Set<string>;
  activeMessageId: string | null;
  visibleRange: VisibleRange | null;
  newOrUpdated: CachedMessage[];
}

// --- AutoCollector types ---

export type AutoCollectPhase =
  | 'idle'
  | 'preparing'
  | 'collecting'
  | 'finalizing'
  | 'completed'
  | 'cancelled'
  | 'failed';

export interface AutoCollectProgress {
  phase: AutoCollectPhase;
  conversationId: string;
  foundCount: number;
  round: number;
  errorMessage?: string;
  totalTurns?: number;
  hydratedCount?: number;
  unhydratedCount?: number;
}

export interface AutoCollectIntent {
  conversationId: string;
  url: string;
  requestedAt: number;
}

// --- TurnFrame types ---

export interface TurnFrame {
  turnKey: string;
  turnIndex: number;
  role: 'user' | 'assistant' | 'unknown';
  hydrated: boolean;
  observedDomMessageId: string | null;
  textHash: string | null;
  preview: string | null;
  textForSearch: string | null;
  lastKnownScrollTop: number;
  lastKnownScrollRatio: number;
  lastHydratedAt: number | null;
}
