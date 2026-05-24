import { normalizeMessageText } from '../shared/text';

const SELECTORS = {
  userMessage: '[data-message-author-role="user"]',
  messageText: '.whitespace-pre-wrap, .message-body, [data-message-author-role] > div',
  excludeButtons: 'button, [role="button"], .copy-button, .edit-button',
  scrollContainer: 'main .overflow-y-auto, [class*="react-scroll-to-bottom"]'
} as const;

const OBSERVED_ID_ATTRIBUTES = ['data-id', 'data-message-id'] as const;

export class DomAdapter {
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
    const candidates = Array.from(document.querySelectorAll<HTMLElement>(SELECTORS.scrollContainer));
    return candidates.find((el) => el.scrollHeight > el.clientHeight) ?? null;
  }

  isElementInViewport(el: HTMLElement): boolean {
    const rect = el.getBoundingClientRect();
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
