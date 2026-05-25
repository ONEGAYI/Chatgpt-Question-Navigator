import { normalizeMessageText } from '../shared/text';

const SELECTORS = {
  userMessage: '[data-message-author-role="user"]',
  messageText: '.whitespace-pre-wrap, .message-body, [data-message-author-role] > div',
  excludeButtons: 'button, [role="button"], .copy-button, .edit-button',
  turnSkeleton: 'section[data-testid^="conversation-turn-"]',
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

  extractObservedId(el: HTMLElement): string | null {
    for (const attr of OBSERVED_ID_ATTRIBUTES) {
      const value = el.getAttribute(attr);
      if (value?.trim()) return value.trim();
    }
    return null;
  }

  findTurnSkeletons(): HTMLElement[] {
    return Array.from(document.querySelectorAll<HTMLElement>(SELECTORS.turnSkeleton));
  }

  findTurnElements(): HTMLElement[] {
    return this.findTurnSkeletons();
  }

  extractTurnKey(el: HTMLElement): string | null {
    const testId = el.getAttribute('data-testid');
    if (!testId?.startsWith('conversation-turn-')) return null;
    return testId;
  }

  extractTurnIndex(turnKey: string): number {
    const match = turnKey.match(/^conversation-turn-(\d+)$/);
    return match ? parseInt(match[1]!, 10) : -1;
  }

  extractTurnRole(el: HTMLElement): 'user' | 'assistant' | 'unknown' {
    if (el.querySelector('[data-message-author-role="user"]')) return 'user';
    if (el.querySelector('[data-message-author-role="assistant"]')) return 'assistant';
    return 'unknown';
  }

  findRoleElementInTurn(turnEl: HTMLElement, role: 'user' | 'assistant'): HTMLElement | null {
    return turnEl.querySelector<HTMLElement>(`[data-message-author-role="${role}"]`);
  }

  extractTurnText(turnEl: HTMLElement, role: 'user' | 'assistant'): string {
    const roleEl = this.findRoleElementInTurn(turnEl, role);
    if (!roleEl) return '';
    return this.extractText(roleEl);
  }

  findTurnKeyForElement(el: HTMLElement): string | null {
    const turnEl = el.closest<HTMLElement>(SELECTORS.turnSkeleton);
    if (!turnEl) return null;
    return this.extractTurnKey(turnEl);
  }
}
