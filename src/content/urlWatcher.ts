import type { DomAdapter } from './domAdapter';

type ConversationChangeCallback = (id: string | null, previousId: string | null) => void | Promise<void>;

export class UrlWatcher {
  private callbacks = new Set<ConversationChangeCallback>();
  private currentId: string | null = null;
  private previousHref = location.href;
  private intervalId: number | null = null;
  private tempId: string | null = null;
  private originalPushState = history.pushState;
  private originalReplaceState = history.replaceState;

  constructor(private readonly domAdapter: DomAdapter) {}

  onConversationChange(callback: ConversationChangeCallback): void {
    this.callbacks.add(callback);
  }

  start(): void {
    this.patchHistory();
    window.addEventListener('popstate', this.handleLocationMaybeChanged);
    this.intervalId = window.setInterval(this.handleLocationMaybeChanged, 1000);
    this.emitIfChanged(true);
  }

  getCurrentId(): string | null {
    return this.currentId;
  }

  stop(): void {
    history.pushState = this.originalPushState;
    history.replaceState = this.originalReplaceState;
    window.removeEventListener('popstate', this.handleLocationMaybeChanged);
    if (this.intervalId !== null) window.clearInterval(this.intervalId);
  }

  private patchHistory(): void {
    const notify = () => window.setTimeout(this.handleLocationMaybeChanged, 0);

    history.pushState = ((...args) => {
      const result = this.originalPushState.apply(history, args);
      notify();
      return result;
    }) as History['pushState'];

    history.replaceState = ((...args) => {
      const result = this.originalReplaceState.apply(history, args);
      notify();
      return result;
    }) as History['replaceState'];
  }

  private handleLocationMaybeChanged = (): void => {
    if (location.href === this.previousHref) return;
    this.previousHref = location.href;
    this.emitIfChanged(false);
  };

  private emitIfChanged(force: boolean): void {
    const previousId = this.currentId;
    const nextId = this.resolveConversationId();
    if (!force && previousId === nextId) return;
    this.currentId = nextId;
    this.callbacks.forEach((callback) => void callback(nextId, previousId));
  }

  private resolveConversationId(): string {
    const urlId = this.domAdapter.extractConversationId();
    if (urlId) return urlId;
    this.tempId ??= `temp:${Date.now()}`;
    return this.tempId;
  }
}
