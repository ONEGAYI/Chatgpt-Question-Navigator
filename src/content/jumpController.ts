import type { CachedUserMessage, VisibleRange } from '../shared/types';
import type { CacheStore } from './cacheStore';
import type { MessageScanner } from './messageScanner';
import type { RuntimeStore } from './runtimeStore';
import type { ScrollDriver } from './scrollDriver';

const HIGHLIGHT_CLASS = 'cqn-target-highlight';
const HIGHLIGHT_MS = 1500;
const STYLE_ID = 'cqn-highlight-style';
const MAX_ATTEMPTS = 30;
const SETTLE_MS = 500;

interface JumpToken {
  cancelled: boolean;
  cancel: () => void;
}

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

function createJumpToken(): JumpToken {
  const token: JumpToken = { cancelled: false, cancel: () => {} };
  token.cancel = () => { token.cancelled = true; };
  return token;
}

function decideDirection(targetIndex: number, visibleRange: VisibleRange | null): 'up' | 'down' {
  if (!visibleRange) return 'down';
  if (targetIndex < visibleRange.minIndex) return 'up';
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

    // 先尝试直接跳转
    const direct = await this.jumpToMounted(target, token);
    if (!this.isCurrent(token)) return false;

    if (direct) {
      this.runtimeStore.setJumpState({ status: 'idle' });
      this.clearToken(token);
      return true;
    }

    // 渐进式跳转
    const found = await this.jumpToCachedMessage(target, token);
    if (this.isCurrent(token) && found) {
      this.runtimeStore.setJumpState({ status: 'idle' });
    }
    this.clearToken(token);
    return found;
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
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      if (!this.isCurrent(token)) return false;

      // 会话切换检测
      const { conversationId } = this.runtimeStore.getSnapshot();
      if (conversationId !== target.conversationId) return false;

      // 检查目标是否已挂载（含 isConnected 守卫）
      const el = this.scanner.getElementByLocalId(target.localMessageId);
      if (el?.isConnected) {
        return await this.landOnTarget(el, target, token);
      }

      // 扫描当前 DOM 状态
      const result = await this.scanner.rescan();
      if (!this.isCurrent(token)) return false;

      // rescan 后重新计算 targetIndex（messages 列表可能因滚动发现新消息而变化）
      const targetIndex = this.runtimeStore.getSnapshot().messages.findIndex((m) => m.localMessageId === target.localMessageId);
      if (targetIndex < 0) {
        if (this.isCurrent(token)) {
          this.runtimeStore.setJumpState({ status: 'failed', targetId: target.localMessageId, reason: '目标消息不在当前会话列表中' });
        }
        return false;
      }

      // rescan 后再次检查是否已挂载
      if (result.mountedIds.has(target.localMessageId)) {
        const found = this.scanner.getElementByLocalId(target.localMessageId);
        if (found?.isConnected) {
          return await this.landOnTarget(found, target, token);
        }
      }

      // 更新尝试计数
      if (!this.isCurrent(token)) return false;
      this.runtimeStore.setJumpState({ status: 'jumping', targetId: target.localMessageId, attempt: attempt + 1 });

      // 步进策略
      if (attempt === 0 && Number.isFinite(target.lastKnownScrollRatio)) {
        this.scrollDriver.scrollToRatio(target.lastKnownScrollRatio, 'auto');
      } else {
        const direction = decideDirection(targetIndex, result.visibleRange);
        this.scrollOneChunk(direction, attempt);
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

  private async landOnTarget(el: HTMLElement, target: CachedUserMessage, token: JumpToken): Promise<boolean> {
    if (!this.isCurrent(token)) return false;
    // 使用 'auto' 行为：即时滚动，scroll metadata 立即可读
    this.scrollDriver.scrollElementIntoView(el, { block: 'center', behavior: 'auto' });
    this.highlightMessage(el);
    this.scanner.updateScrollMeta(target.localMessageId, this.scrollDriver.getScrollTop(), this.scrollDriver.getScrollRatio());
    await this.cacheStore.flush();
    return this.isCurrent(token);
  }

  private scrollOneChunk(direction: 'up' | 'down', attempt: number): void {
    const viewportHeight = this.scrollDriver.getClientHeight();
    const decay = Math.max(0.3, 1 - attempt * 0.03);
    const step = viewportHeight * decay;
    const deltaY = direction === 'up' ? -step : step;
    this.scrollDriver.scrollBy(deltaY);
  }

  private async jumpToMounted(target: CachedUserMessage, token: JumpToken): Promise<boolean> {
    const el = this.scanner.getElementByLocalId(target.localMessageId);
    if (!el?.isConnected) return false;
    return await this.landOnTarget(el, target, token);
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
