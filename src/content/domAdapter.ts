import { normalizeMessageText } from '../shared/text';

const SELECTORS = {
  userMessage: '[data-message-author-role="user"]',
  messageText: '.whitespace-pre-wrap, .message-body, [data-message-author-role] > div',
  excludeButtons: 'button, [role="button"], .copy-button, .edit-button',
  scrollContainer: 'main .overflow-y-auto, [class*="react-scroll-to-bottom"]'
} as const;

const OBSERVED_ID_ATTRIBUTES = ['data-id', 'data-message-id'] as const;

export class DomAdapter {
  private scrollContainer: HTMLElement | null = null;

  setScrollContainer(container: HTMLElement | null): void {
    this.scrollContainer = container;
  }

  findUserMessages(): HTMLElement[] {
    return Array.from(document.querySelectorAll<HTMLElement>(SELECTORS.userMessage));
  }

  extractText(el: HTMLElement): string {
    const clone = el.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(SELECTORS.excludeButtons).forEach((node) => node.remove());

    const textNode = clone.matches(SELECTORS.messageText)
      ? clone
      : clone.querySelector<HTMLElement>(SELECTORS.messageText);

    return normalizeMessageText((textNode ?? clone).innerText || (textNode ?? clone).textContent || '');
  }

  extractConversationId(): string | null {
    const match = location.pathname.match(/\/c\/([^/?#]+)/);
    return match?.[1] ?? null;
  }

  findScrollContainer(): HTMLElement | null {
    // Strategy 1: known CSS selectors
    const candidates = Array.from(document.querySelectorAll<HTMLElement>(SELECTORS.scrollContainer));
    const found = candidates.find((el) => el.scrollHeight > el.clientHeight);
    if (found) return found;

    // Strategy 2: walk up from first user message, test actual scrollability
    const firstMessage = document.querySelector<HTMLElement>(SELECTORS.userMessage);
    if (firstMessage) {
      let parent: HTMLElement | null = firstMessage.parentElement;
      let scrollableAncestor: HTMLElement | null = null;
      while (parent && parent !== document.documentElement) {
        if (parent.scrollHeight > parent.clientHeight + 1) {
          const prev = parent.scrollTop;
          parent.scrollTop += 1;
          if (parent.scrollTop > prev) {
            parent.scrollTop = prev;
            scrollableAncestor = parent;
          }
        }
        parent = parent.parentElement;
      }
      if (scrollableAncestor) return scrollableAncestor;
    }

    // Strategy 3: document.scrollingElement if scrollable
    const scrolling = document.scrollingElement as HTMLElement | null;
    if (scrolling && scrolling.scrollHeight > scrolling.clientHeight) {
      return scrolling;
    }

    return null;
  }

  isElementInViewport(el: HTMLElement): boolean {
    const rect = el.getBoundingClientRect();
    if (this.scrollContainer) {
      const containerRect = this.scrollContainer.getBoundingClientRect();
      return rect.bottom >= containerRect.top && rect.top <= containerRect.bottom;
    }
    return rect.bottom >= 0 && rect.top <= window.innerHeight;
  }

  extractObservedId(el: HTMLElement): string | null {
    for (const attr of OBSERVED_ID_ATTRIBUTES) {
      const value = el.getAttribute(attr);
      if (value?.trim()) return value.trim();
    }
    return null;
  }
}
