import type { DomAdapter } from './domAdapter';

type ScrollTarget = HTMLElement | Window;
export type UserScrollDirection = 'up' | 'down' | 'unknown';

export class ScrollDriver {
  private target: ScrollTarget = window;
  private scrollListeners = new Set<() => void>();
  private userScrollListeners = new Set<(direction: UserScrollDirection) => void>();
  private isProgrammatic = false;
  private cleanupFns: Array<() => void> = [];
  private touchStartY: number | null = null;

  constructor(private readonly domAdapter: DomAdapter) {}

  init(): void {
    this.target = this.domAdapter.findScrollContainer() ?? document.scrollingElement as HTMLElement | null ?? window;
    this.bindListeners();
  }

  getContainer(): ScrollTarget {
    return this.target;
  }

  getScrollTop(): number {
    if (this.target === window) return window.scrollY || document.documentElement.scrollTop || 0;
    return (this.target as HTMLElement).scrollTop;
  }

  getScrollHeight(): number {
    if (this.target === window) return document.scrollingElement?.scrollHeight ?? document.documentElement.scrollHeight;
    return (this.target as HTMLElement).scrollHeight;
  }

  getClientHeight(): number {
    if (this.target === window) return window.innerHeight;
    return (this.target as HTMLElement).clientHeight;
  }

  getScrollRatio(): number {
    const max = Math.max(1, this.getScrollHeight() - this.getClientHeight());
    return Math.min(1, Math.max(0, this.getScrollTop() / max));
  }

  scrollTo(options: ScrollToOptions): void {
    this.markProgrammatic();
    if (this.target === window) {
      window.scrollTo(options);
      return;
    }
    this.target.scrollTo(options);
  }

  scrollBy(deltaY: number): void {
    this.markProgrammatic();
    if (this.target === window) {
      window.scrollBy({ top: deltaY, behavior: 'auto' });
      return;
    }
    this.target.scrollBy({ top: deltaY, behavior: 'auto' });
  }

  scrollToRatio(ratio: number, behavior: ScrollBehavior = 'auto'): void {
    const clamped = Math.min(1, Math.max(0, ratio));
    const top = clamped * Math.max(0, this.getScrollHeight() - this.getClientHeight());
    this.scrollTo({ top, behavior });
  }

  scrollElementIntoView(el: HTMLElement, options: ScrollIntoViewOptions = { block: 'center', behavior: 'smooth' }): void {
    this.markProgrammatic();
    el.scrollIntoView(options);
  }

  getAbsoluteTop(element: HTMLElement): number {
    if (this.target === window) {
      return element.getBoundingClientRect().top + window.scrollY;
    }
    const container = this.target as HTMLElement;
    return container.scrollTop + (element.getBoundingClientRect().top - container.getBoundingClientRect().top);
  }

  onScroll(callback: () => void): () => void {
    this.scrollListeners.add(callback);
    return () => this.scrollListeners.delete(callback);
  }

  onUserScroll(callback: (direction: UserScrollDirection) => void): () => void {
    this.userScrollListeners.add(callback);
    return () => this.userScrollListeners.delete(callback);
  }

  destroy(): void {
    this.cleanupFns.forEach((cleanup) => cleanup());
    this.cleanupFns = [];
    this.scrollListeners.clear();
    this.userScrollListeners.clear();
  }

  private bindListeners(): void {
    const scrollTarget = this.target === window ? window : this.target;

    const onScroll = () => {
      this.scrollListeners.forEach((listener) => listener());
      if (this.isProgrammatic) {
        window.setTimeout(() => {
          this.isProgrammatic = false;
        }, 80);
      }
    };

    scrollTarget.addEventListener('scroll', onScroll, { passive: true });
    this.cleanupFns.push(() => scrollTarget.removeEventListener('scroll', onScroll));

    const onWheel = (event: Event) => this.notifyUserScroll(directionFromDelta((event as WheelEvent).deltaY));
    const onTouchStart = (event: Event) => {
      const touchEvent = event as TouchEvent;
      this.touchStartY = touchEvent.touches[0]?.clientY ?? null;
      this.notifyUserScroll('unknown');
    };
    const onTouchMove = (event: Event) => {
      const touchEvent = event as TouchEvent;
      const currentY = touchEvent.touches[0]?.clientY ?? null;
      if (this.touchStartY === null || currentY === null) return;
      this.notifyUserScroll(directionFromDelta(this.touchStartY - currentY));
    };
    const onKey = (event: KeyboardEvent) => {
      const direction = directionFromKey(event.key);
      if (direction !== 'unknown') this.notifyUserScroll(direction);
    };

    scrollTarget.addEventListener('wheel', onWheel, { passive: true });
    scrollTarget.addEventListener('touchstart', onTouchStart, { passive: true });
    scrollTarget.addEventListener('touchmove', onTouchMove, { passive: true });
    window.addEventListener('keydown', onKey);

    this.cleanupFns.push(() => scrollTarget.removeEventListener('wheel', onWheel));
    this.cleanupFns.push(() => scrollTarget.removeEventListener('touchstart', onTouchStart));
    this.cleanupFns.push(() => scrollTarget.removeEventListener('touchmove', onTouchMove));
    this.cleanupFns.push(() => window.removeEventListener('keydown', onKey));
  }

  private markProgrammatic(): void {
    this.isProgrammatic = true;
  }

  private notifyUserScroll(direction: UserScrollDirection): void {
    if (this.isProgrammatic) return;
    this.userScrollListeners.forEach((listener) => listener(direction));
  }
}

export function directionFromDelta(deltaY: number): UserScrollDirection {
  if (deltaY < 0) return 'up';
  if (deltaY > 0) return 'down';
  return 'unknown';
}

export function directionFromKey(key: string): UserScrollDirection {
  if (['PageUp', 'ArrowUp', 'Home'].includes(key)) return 'up';
  if (['PageDown', ' ', 'ArrowDown', 'End'].includes(key)) return 'down';
  return 'unknown';
}
