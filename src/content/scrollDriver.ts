import type { DomAdapter } from './domAdapter';

type ScrollTarget = HTMLElement | Window;

export class ScrollDriver {
  private target: ScrollTarget = window;
  private scrollListeners = new Set<() => void>();
  private userScrollListeners = new Set<() => void>();
  private isProgrammatic = false;
  private cleanupFns: Array<() => void> = [];
  private programmaticTimer: number | null = null;

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

  onUserScroll(callback: () => void): () => void {
    this.userScrollListeners.add(callback);
    return () => this.userScrollListeners.delete(callback);
  }

  destroy(): void {
    if (this.programmaticTimer !== null) {
      window.clearTimeout(this.programmaticTimer);
      this.programmaticTimer = null;
    }
    this.isProgrammatic = false;
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
        if (this.programmaticTimer !== null) window.clearTimeout(this.programmaticTimer);
        this.programmaticTimer = window.setTimeout(() => {
          this.isProgrammatic = false;
          this.programmaticTimer = null;
        }, 80);
      }
    };

    scrollTarget.addEventListener('scroll', onScroll, { passive: true });
    this.cleanupFns.push(() => scrollTarget.removeEventListener('scroll', onScroll));

    const onWheel = () => this.notifyUserScroll();
    const onTouch = () => this.notifyUserScroll();
    const onKey = (event: KeyboardEvent) => {
      if (['PageUp', 'PageDown', ' ', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
        this.notifyUserScroll();
      }
    };

    scrollTarget.addEventListener('wheel', onWheel, { passive: true });
    scrollTarget.addEventListener('touchstart', onTouch, { passive: true });
    window.addEventListener('keydown', onKey);

    const onPointer = (event: Event) => {
      if (this.target === window) {
        const node = event.target as Node | null;
        if (node && node.getRootNode() !== document) return;
      }
      this.notifyUserScroll();
    };
    scrollTarget.addEventListener('pointerdown', onPointer, { passive: true });

    this.cleanupFns.push(() => scrollTarget.removeEventListener('wheel', onWheel));
    this.cleanupFns.push(() => scrollTarget.removeEventListener('touchstart', onTouch));
    this.cleanupFns.push(() => window.removeEventListener('keydown', onKey));
    this.cleanupFns.push(() => scrollTarget.removeEventListener('pointerdown', onPointer));
  }

  private markProgrammatic(): void {
    this.isProgrammatic = true;
    if (this.programmaticTimer !== null) window.clearTimeout(this.programmaticTimer);
    this.programmaticTimer = window.setTimeout(() => {
      this.isProgrammatic = false;
      this.programmaticTimer = null;
    }, 200);
  }

  private notifyUserScroll(): void {
    if (this.isProgrammatic) return;
    this.userScrollListeners.forEach((listener) => listener());
  }
}
