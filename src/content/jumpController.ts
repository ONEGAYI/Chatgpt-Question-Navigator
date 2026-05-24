import type { CachedUserMessage } from '../shared/types';
import type { CacheStore } from './cacheStore';
import type { MessageScanner } from './messageScanner';
import type { RuntimeStore } from './runtimeStore';
import type { ScrollDriver } from './scrollDriver';

const HIGHLIGHT_CLASS = 'cqn-target-highlight';
const HIGHLIGHT_MS = 1500;
const STYLE_ID = 'cqn-highlight-style';

let styleInjected = false;

function ensureHighlightStyle(): void {
  if (styleInjected) return;
  if (document.getElementById(STYLE_ID)) {
    styleInjected = true;
    return;
  }
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `.${HIGHLIGHT_CLASS}{outline:2px solid #10a37f!important;outline-offset:4px!important;border-radius:8px!important;transition:outline-color 160ms ease,outline-offset 160ms ease}`;
  document.head.appendChild(style);
  styleInjected = true;
}

export class JumpController {
  constructor(
    private readonly scanner: MessageScanner,
    private readonly cacheStore: CacheStore,
    private readonly scrollDriver: ScrollDriver,
    private readonly runtimeStore: RuntimeStore
  ) {}

  async jumpToMessage(target: CachedUserMessage): Promise<boolean> {
    this.runtimeStore.setJumpState({ status: 'jumping', targetId: target.localMessageId, attempt: 0 });

    const direct = await this.jumpToMounted(target);
    if (direct) {
      this.runtimeStore.setJumpState({ status: 'idle' });
      return true;
    }

    await this.scanner.rescan();
    const afterRescan = await this.jumpToMounted(target);
    if (afterRescan) {
      this.runtimeStore.setJumpState({ status: 'idle' });
      return true;
    }

    this.runtimeStore.setJumpState({
      status: 'failed',
      targetId: target.localMessageId,
      reason: '目标消息当前未挂载，渐进式跳转将在 Phase 4 实现'
    });
    console.info('[ChatGPT Navigator] Cached-only target is not mounted yet', target.localMessageId);
    return false;
  }

  cancelCurrent(): void {
    this.runtimeStore.setJumpState({ status: 'idle' });
  }

  private async jumpToMounted(target: CachedUserMessage): Promise<boolean> {
    const el = this.scanner.getElementByLocalId(target.localMessageId);
    if (!el) return false;

    this.scrollDriver.scrollElementIntoView(el, { block: 'center', behavior: 'smooth' });
    this.highlightMessage(el);
    this.scanner.updateScrollMeta(target.localMessageId, this.scrollDriver.getScrollTop(), this.scrollDriver.getScrollRatio());
    await this.cacheStore.flush();
    return true;
  }

  private highlightMessage(el: HTMLElement): void {
    ensureHighlightStyle();
    el.classList.add(HIGHLIGHT_CLASS);
    window.setTimeout(() => {
      el.classList.remove(HIGHLIGHT_CLASS);
    }, HIGHLIGHT_MS);
  }
}
