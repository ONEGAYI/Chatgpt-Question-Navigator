import type { CachedMessage, VisibleRange } from '../shared/types';
import type { CacheStore } from './cacheStore';
import type { MessageScanner } from './messageScanner';
import type { RuntimeStore } from './runtimeStore';
import type { ScrollDriver } from './scrollDriver';

const HIGHLIGHT_CLASS = 'cqn-target-highlight';
const HIGHLIGHT_MS = 1500;
const STYLE_ID = 'cqn-highlight-style';
export const MAX_ATTEMPTS = 200;
const SETTLE_MS = 500;
const MAX_CONSECUTIVE_NOOPS = 3;
const RATIO_ESCAPE_STAGNANT = 2;
const RATIO_ESCAPE_INEFFECTIVE = 2;
const DEBUG_JUMP = false;

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

function orderDistanceToRange(targetOrderKey: number, range: VisibleRange | null): number {
  if (!range) return Infinity;
  if (targetOrderKey < range.minOrderKey) return range.minOrderKey - targetOrderKey;
  if (targetOrderKey > range.maxOrderKey) return targetOrderKey - range.maxOrderKey;
  return 0;
}

function visibleRangeSignature(range: VisibleRange | null): string {
  return range ? `${range.minOrderKey}:${range.maxOrderKey}` : 'null';
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

  async jumpToMessage(target: CachedMessage): Promise<boolean> {
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
        const msg = e instanceof Error ? e.message : String(e);
        this.runtimeStore.setJumpState({
          status: 'failed',
          targetId: target.localMessageId,
          reason: msg.includes('Extension context invalidated')
            ? '扩展已更新，请刷新页面后重试'
            : `跳转异常: ${msg}`,
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

  private async jumpToCachedMessage(target: CachedMessage, token: JumpToken): Promise<boolean> {
    let consecutiveNoOps = 0;
    let lastRangeSig: string | null = null;
    let stagnantRangeCount = 0;
    let ineffectiveMoveCount = 0;

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
      if (el?.isConnected && this.scrollDriver.isElementInViewport(el)) {
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
        if (found?.isConnected && this.scrollDriver.isElementInViewport(found)) {
          return await this.landOnTarget(found, target, token, true);
        }
      }

      if (!this.isCurrent(token)) return false;
      this.runtimeStore.setJumpState({ status: 'jumping', targetId: target.localMessageId, attempt: attempt + 1 });

      // --- visibleRange 停滞检测 ---
      const rangeSig = visibleRangeSignature(result.visibleRange);
      if (rangeSig === lastRangeSig) {
        stagnantRangeCount += 1;
      } else {
        stagnantRangeCount = 0;
      }
      lastRangeSig = rangeSig;

      // --- ratio escape：被局部 anchor 捕捉时强制跳到目标 ratio ---
      if (
        (stagnantRangeCount >= RATIO_ESCAPE_STAGNANT || ineffectiveMoveCount >= RATIO_ESCAPE_INEFFECTIVE) &&
        target.lastKnownScrollRatio != null &&
        Number.isFinite(target.lastKnownScrollRatio)
      ) {
        this.scrollDriver.scrollToRatio(target.lastKnownScrollRatio, 'auto');
        if (DEBUG_JUMP) {
          console.debug('[CQN Jump] ratio-escape', { attempt, stagnantRangeCount, ineffectiveMoveCount, targetRatio: target.lastKnownScrollRatio });
        }
        stagnantRangeCount = 0;
        ineffectiveMoveCount = 0;
        await waitForDomSettled(SETTLE_MS);
        continue;
      }

      // --- 滚动策略 ---
      const beforeTop = this.scrollDriver.getScrollTop();
      let directionSource: string;

      const distance = orderDistanceToRange(target.orderKey, result.visibleRange);

      if (
        attempt === 0 &&
        distance >= 4 &&
        target.lastKnownScrollRatio != null &&
        Number.isFinite(target.lastKnownScrollRatio)
      ) {
        // 远距离目标优先用 ratio 粗定位
        this.scrollDriver.scrollToRatio(target.lastKnownScrollRatio, 'auto');
        directionSource = 'initial-ratio-seed';
      } else if (result.visibleRange !== null) {
        const direction = decideDirection(target.orderKey, result.visibleRange);
        this.scrollOneChunk(direction, attempt);
        directionSource = 'visible-range';
      } else {
        const direction = decideDirection(target.orderKey, result.visibleRange);
        this.scrollOneChunk(direction, attempt);
        directionSource = 'fallback';
      }

      await waitForDomSettled(SETTLE_MS);
      if (!this.isCurrent(token)) return false;

      // --- 用 settle 后的净位移判断是否有效 ---
      const afterTop = this.scrollDriver.getScrollTop();
      const minEffectiveDelta = Math.max(80, this.scrollDriver.getClientHeight() * 0.08);
      const effectiveMoved = Math.abs(afterTop - beforeTop) >= minEffectiveDelta;

      if (DEBUG_JUMP) {
        console.debug('[CQN Jump]', {
          targetId: target.localMessageId,
          targetOrderKey: target.orderKey,
          attempt,
          currentScrollTop: afterTop,
          visibleRange: result.visibleRange,
          directionSource,
          distance,
          effectiveMoved,
          stagnantRangeCount,
          ineffectiveMoveCount,
        });
      }

      if (effectiveMoved) {
        consecutiveNoOps = 0;
        ineffectiveMoveCount = 0;
      } else {
        consecutiveNoOps += 1;
        ineffectiveMoveCount += 1;
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

  private async landOnTarget(el: HTMLElement, target: CachedMessage, token: JumpToken, smooth: boolean): Promise<boolean> {
    if (!this.isCurrent(token)) return false;

    this.scrollDriver.scrollElementIntoView(el, { block: 'center', behavior: smooth ? 'smooth' : 'auto' });

    if (smooth) {
      await waitForDomSettled(400);
      if (!this.isCurrent(token)) return false;
    }

    // 验证目标真的在 viewport 中，否则返回 false 让外层继续跳转
    if (!el.isConnected || !this.scrollDriver.isElementInViewport(el)) {
      return false;
    }

    this.highlightMessage(el);

    try {
      this.scanner.updateScrollMeta(target.localMessageId, this.scrollDriver.getScrollTop(), this.scrollDriver.getScrollRatio());
      await this.cacheStore.flush();
    } catch {
      // Extension context invalidated — visual jump already succeeded
    }

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

  private async jumpToMounted(target: CachedMessage, token: JumpToken): Promise<boolean> {
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
