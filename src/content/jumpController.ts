import type { CachedUserMessage, VisibleRange } from '../shared/types';
import type { CacheStore } from './cacheStore';
import type { MessageScanner } from './messageScanner';
import type { RuntimeStore } from './runtimeStore';
import type { ScrollDriver } from './scrollDriver';

const HIGHLIGHT_CLASS = 'cqn-target-highlight';
const HIGHLIGHT_MS = 1500;
const STYLE_ID = 'cqn-highlight-style';
export const MAX_ATTEMPTS = 30;
const SETTLE_MS = 500;
const MAX_CONSECUTIVE_NOOPS = 3;

interface JumpToken {
  cancelled: boolean;
  cancel: () => void;
}

function ensureHighlightStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `.${HIGHLIGHT_CLASS}{outline:2px solid #10a37f!important;outline-offset:4px!important;border-radius:8px!important;transition:outline-color 160ms ease,outline-offset 160ms ease}`;
  document.head.appendChild(style);
}

function createJumpToken(): JumpToken {
  const token: JumpToken = { cancelled: false, cancel: () => {} };
  token.cancel = () => { token.cancelled = true; };
  return token;
}

function decideDirection(targetOrderKey: number, visibleRange: VisibleRange | null): 'up' | 'down' {
  if (!visibleRange) return 'down';
  if (targetOrderKey < visibleRange.minOrderKey) return 'up';
  return 'down';
}

function waitForDomSettled(ms: number): Promise<void> {
  return new Promise((resolve) => { window.setTimeout(resolve, ms); });
}

export class JumpController {
  private currentToken: JumpToken | null = null;

  constructor(
    private readonly scanner: MessageScanner,
    private readonly cacheStore: CacheStore,
    private readonly scrollDriver: ScrollDriver,
    private readonly runtimeStore: RuntimeStore
  ) {}

  private isCurrent(token: JumpToken): boolean {
    return this.currentToken === token && !token.cancelled;
  }

  async jumpToMessage(target: CachedUserMessage): Promise<boolean> {
    this.cancelCurrent();

    const token = createJumpToken();
    this.currentToken = token;
    this.runtimeStore.setJumpState({ status: 'jumping', targetId: target.localMessageId, attempt: 0 });

    try {
      const direct = await this.jumpToMounted(target, token);
      if (!this.isCurrent(token)) return false;

      if (direct) {
        this.runtimeStore.setJumpState({ status: 'idle' });
        this.clearToken(token);
        return true;
      }

      const found = await this.jumpToCachedMessage(target, token);
      if (this.isCurrent(token) && found) {
        this.runtimeStore.setJumpState({ status: 'idle' });
      }
      this.clearToken(token);
      return found;
    } catch (e) {
      if (this.isCurrent(token)) {
        this.runtimeStore.setJumpState({
          status: 'failed',
          targetId: target.localMessageId,
          reason: `跳转异常: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
      this.clearToken(token);
      return false;
    }
  }

  cancelCurrent(): void {
    if (this.currentToken) {
      this.currentToken.cancel();
      this.currentToken = null;
    }
    const { jumpState } = this.runtimeStore.getSnapshot();
    if (jumpState.status !== 'idle') {
      this.runtimeStore.setJumpState({ status: 'idle' });
    }
  }

  private async jumpToCachedMessage(target: CachedUserMessage, token: JumpToken): Promise<boolean> {
    let consecutiveNoOps = 0;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      if (!this.isCurrent(token)) return false;

      const { conversationId } = this.runtimeStore.getSnapshot();
      if (conversationId !== target.conversationId) {
        if (this.isCurrent(token)) {
          this.runtimeStore.setJumpState({ status: 'failed', targetId: target.localMessageId, reason: '会话已切换' });
        }
        return false;
      }

      const el = this.scanner.getElementByLocalId(target.localMessageId);
      if (el?.isConnected) {
        return await this.landOnTarget(el, target, token, true);
      }

      const result = await this.scanner.rescan();
      if (!this.isCurrent(token)) return false;

      const targetIndex = this.runtimeStore.getSnapshot().messages.findIndex((m) => m.localMessageId === target.localMessageId);
      if (targetIndex < 0) {
        if (this.isCurrent(token)) {
          this.runtimeStore.setJumpState({ status: 'failed', targetId: target.localMessageId, reason: '目标消息不在当前会话列表中' });
        }
        return false;
      }

      if (result.mountedIds.has(target.localMessageId)) {
        const found = this.scanner.getElementByLocalId(target.localMessageId);
        if (found?.isConnected) {
          return await this.landOnTarget(found, target, token, true);
        }
      }

      if (!this.isCurrent(token)) return false;
      this.runtimeStore.setJumpState({ status: 'jumping', targetId: target.localMessageId, attempt: attempt + 1 });

      let moved = false;
      if (attempt === 0 && target.lastKnownScrollRatio != null && Number.isFinite(target.lastKnownScrollRatio)) {
        const scrollResult = this.scrollDriver.scrollToRatio(target.lastKnownScrollRatio, 'auto');
        moved = scrollResult.moved;
      } else {
        const direction = decideDirection(target.orderKey, result.visibleRange);
        moved = this.scrollOneChunk(direction, attempt);
      }

      if (moved) {
        consecutiveNoOps = 0;
      } else {
        consecutiveNoOps += 1;
        if (consecutiveNoOps >= MAX_CONSECUTIVE_NOOPS) {
          if (this.isCurrent(token)) {
            this.runtimeStore.setJumpState({
              status: 'failed',
              targetId: target.localMessageId,
              reason: `连续 ${MAX_CONSECUTIVE_NOOPS} 次滚动无效，可能已到达边界`
            });
          }
          return false;
        }
      }

      await waitForDomSettled(SETTLE_MS);
    }

    if (this.isCurrent(token)) {
      this.runtimeStore.setJumpState({
        status: 'failed',
        targetId: target.localMessageId,
        reason: `经过 ${MAX_ATTEMPTS} 次尝试仍未找到目标消息`
      });
    }
    return false;
  }

  private async landOnTarget(el: HTMLElement, target: CachedUserMessage, token: JumpToken, smooth: boolean): Promise<boolean> {
    if (!this.isCurrent(token)) return false;
    this.scrollDriver.scrollElementIntoView(el, { block: 'center', behavior: smooth ? 'smooth' : 'auto' });
    this.highlightMessage(el);
    if (smooth) {
      await waitForDomSettled(400);
      if (!this.isCurrent(token)) return false;
    }
    this.scanner.updateScrollMeta(target.localMessageId, this.scrollDriver.getScrollTop(), this.scrollDriver.getScrollRatio());
    await this.cacheStore.flush();
    return true;
  }

  private scrollOneChunk(direction: 'up' | 'down', attempt: number): boolean {
    const viewportHeight = this.scrollDriver.getClientHeight();
    const decay = Math.max(0.3, 1 - attempt * 0.03);
    const step = viewportHeight * decay;
    const deltaY = direction === 'up' ? -step : step;
    const result = this.scrollDriver.scrollBy(deltaY);
    return result.moved;
  }

  private async jumpToMounted(target: CachedUserMessage, token: JumpToken): Promise<boolean> {
    const el = this.scanner.getElementByLocalId(target.localMessageId);
    if (!el?.isConnected) return false;
    return await this.landOnTarget(el, target, token, true);
  }

  private highlightMessage(el: HTMLElement): void {
    ensureHighlightStyle();
    el.classList.add(HIGHLIGHT_CLASS);
    window.setTimeout(() => { el.classList.remove(HIGHLIGHT_CLASS); }, HIGHLIGHT_MS);
  }

  private clearToken(token: JumpToken): void {
    if (this.currentToken === token) {
      this.currentToken = null;
    }
  }
}
