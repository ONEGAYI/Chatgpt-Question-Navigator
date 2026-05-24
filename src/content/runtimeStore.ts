import type { AutoCollectProgress, CachedUserMessage, JumpState, RuntimeState } from '../shared/types';

export class RuntimeStore {
  private state: RuntimeState = {
    conversationId: null,
    messages: [],
    elementById: new Map(),
    mountedIds: new Set(),
    activeMessageId: null,
    jumpState: { status: 'idle' },
    autoCollectProgress: null,
  };

  private listeners = new Set<() => void>();

  getSnapshot(): RuntimeState {
    return {
      ...this.state,
      messages: [...this.state.messages],
      elementById: new Map(this.state.elementById),
      mountedIds: new Set(this.state.mountedIds),
      autoCollectProgress: this.state.autoCollectProgress
        ? { ...this.state.autoCollectProgress }
        : null,
    };
  }

  setConversationId(id: string | null): void {
    this.state = {
      ...this.state,
      conversationId: id,
      messages: [],
      elementById: new Map(),
      mountedIds: new Set(),
      activeMessageId: null,
      jumpState: { status: 'idle' },
      autoCollectProgress: null,
    };
    this.emit();
  }

  setMessages(messages: CachedUserMessage[]): void {
    this.state = {
      ...this.state,
      messages: [...messages]
    };
    this.emit();
  }

  setMountedState(mountedIds: Set<string>, elementById: Map<string, HTMLElement>): void {
    this.state = {
      ...this.state,
      mountedIds: new Set(mountedIds),
      elementById: new Map(elementById)
    };
    this.emit();
  }

  setActiveMessageId(id: string | null): void {
    if (this.state.activeMessageId === id) return;
    this.state = { ...this.state, activeMessageId: id };
    this.emit();
  }

  setJumpState(state: JumpState): void {
    this.state = { ...this.state, jumpState: state };
    this.emit();
  }

  setAutoCollectProgress(progress: AutoCollectProgress | null): void {
    this.state = { ...this.state, autoCollectProgress: progress };
    this.emit();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener());
  }
}
