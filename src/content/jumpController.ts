import type { CachedMessage, VisibleRange } from '../shared/types';
import type { CacheStore } from './cacheStore';
import type { MessageScanner } from './messageScanner';
import type { RuntimeStore } from './runtimeStore';
import type { ScrollDriver } from './scrollDriver';
import type { ScrollProfile } from '../shared/scrollProfile';

const HIGHLIGHT_CLASS = 'cqn-target-highlight';
const HIGHLIGHT_MS = 1500;
const STYLE_ID = 'cqn-highlight-style';
export const MAX_ATTEMPTS = 200;
const MAX_CONSECUTIVE_NOOPS = 3;
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

function decideDirection(
  targetOrderKey: number,
  visibleRange: VisibleRange | null,
  ratioHint?: { target: number; current: number },
): 'up' | 'down' {
  if (visibleRange) return targetOrderKey < visibleRange.minOrderKey ? 'up' : 'down';
  if (ratioHint) return ratioHint.target < ratioHint.current ? 'up' : 'down';
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
    private readonly runtimeStore: RuntimeStore,
    private readonly getProfile: () => ScrollProfile = () => ({
      name: 'default' as const, label: '标准',
      acScrollStepRatio: 0.7, acSettleStableMs: 500, acSettleQuietMs: 400, acSettlePollMs: 100,
      jcSettleMs: 500, jcDecayRate: 0.03, jcMinDecay: 0.3,
    }),
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
        this.runtimeStore.setJumpState({
          status: 'failed',
          targetId: target.localMessageId,
          reason: `跳转异常: ${e instanceof Error ? e.message : String(e)}（可尝试降低滚屏速率）`,
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
        const landed = await this.tryLandOnMounted(target, token);
        if (landed) return true;
        // fallthrough: 元素虽然在 DOM 中但不可真实定位，继续 progressive jump。
        // 后续 rescan 会重建 elementById，清理 stale mapping。
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
        const landed = await this.tryLandOnMounted(target, token);
        if (landed) return true;
        // fallthrough: mountedIds 记录可能过时，继续 progressive jump。
      }

      if (!this.isCurrent(token)) return false;
      this.runtimeStore.setJumpState({ status: 'jumping', targetId: target.localMessageId, attempt: attempt + 1 });

      let moved = false;
      let directionSource: string;

      if (result.visibleRange !== null) {
        // AI anchor or user message provides position context — use orderKey direction
        const direction = decideDirection(target.orderKey, result.visibleRange);
        moved = this.scrollOneChunk(direction, attempt);
        directionSource = 'visible-range';
      } else if (
        attempt === 0 &&
        target.lastKnownScrollRatio != null &&
        Number.isFinite(target.lastKnownScrollRatio)
      ) {
        // No visible anchors — fall back to ratio seed for initial coarse positioning
        const currentRatio = this.scrollDriver.getScrollRatio();
        const ratioDiff = target.lastKnownScrollRatio - currentRatio;
        if (Math.abs(ratioDiff) > 0.02) {
          const scrollResult = this.scrollDriver.scrollToRatio(target.lastKnownScrollRatio, 'auto');
          moved = scrollResult.moved;
          directionSource = 'ratio-seed';
        } else {
          const direction = decideDirection(target.orderKey, result.visibleRange, {
            target: target.lastKnownScrollRatio!,
            current: currentRatio,
          });
          moved = this.scrollOneChunk(direction, attempt);
          directionSource = 'fallback';
        }
      } else {
        const ratioHint = target.lastKnownScrollRatio != null
          ? { target: target.lastKnownScrollRatio, current: this.scrollDriver.getScrollRatio() }
          : undefined;
        const direction = decideDirection(target.orderKey, result.visibleRange, ratioHint);
        moved = this.scrollOneChunk(direction, attempt);
        directionSource = 'fallback';
      }

      if (DEBUG_JUMP) {
        console.debug('[CQN Jump]', {
          targetId: target.localMessageId,
          targetOrderKey: target.orderKey,
          targetLastKnownScrollRatio: target.lastKnownScrollRatio,
          attempt,
          currentScrollTop: this.scrollDriver.getScrollTop(),
          currentScrollRatio: this.scrollDriver.getScrollRatio(),
          visibleRange: result.visibleRange,
          directionSource,
          moved,
        });
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
              reason: `连续 ${MAX_CONSECUTIVE_NOOPS} 次滚动无效，可能已到达边界（可尝试降低滚屏速率）`
            });
          }
          return false;
        }
      }

      await waitForDomSettled(this.getProfile().jcSettleMs);
    }

    if (this.isCurrent(token)) {
      this.runtimeStore.setJumpState({
        status: 'failed',
        targetId: target.localMessageId,
        reason: `经过 ${MAX_ATTEMPTS} 次尝试仍未找到目标消息（可尝试降低滚屏速率）`
      });
    }
    return false;
  }

  private scrollOneChunk(direction: 'up' | 'down', attempt: number): boolean {
    const { jcDecayRate, jcMinDecay } = this.getProfile();
    const viewportHeight = this.scrollDriver.getClientHeight();
    const decay = Math.max(jcMinDecay, 1 - attempt * jcDecayRate);
    const step = viewportHeight * decay;
    const deltaY = direction === 'up' ? -step : step;
    const result = this.scrollDriver.scrollBy(deltaY);
    return result.moved;
  }

  /**
   * 尝试直接落地到已挂载的元素。scroll 后验证目标真正进入 viewport 才算成功。
   * 返回 false 只表示 direct landing 失败，不代表整个 jump 失败。
   * 调用方必须 fallthrough 到 progressive jump，不得 setJumpState failed 或退出。
   */
  private async tryLandOnMounted(target: CachedMessage, token: JumpToken): Promise<boolean> {
    const el = this.scanner.getElementByLocalId(target.localMessageId);
    if (!el?.isConnected) return false;

    const rectBefore = el.getBoundingClientRect();
    if (rectBefore.height <= 0 || rectBefore.width <= 0) return false;

    // 使用 behavior: 'auto' 保证验证确定性。smooth 可能未完成就误判失败。
    const scrollResult = this.scrollDriver.scrollElementIntoView(el, {
      block: 'center',
      behavior: 'auto',
    });

    // 保留 scrollResult 供 debug 参考，但最终成功标准以 rect + isElementInViewport 为准。
    if (DEBUG_JUMP) {
      console.debug('[CQN Jump] tryLandOnMounted', { scrollResult, rectBefore: { width: rectBefore.width, height: rectBefore.height } });
    }

    await waitForDomSettled(this.getProfile().jcSettleMs);
    if (!this.isCurrent(token)) return false;
    if (!el.isConnected) return false;

    const rectAfter = el.getBoundingClientRect();
    if (rectAfter.height <= 0 || rectAfter.width <= 0) return false;
    if (!this.scrollDriver.isElementInViewport(el)) return false;

    if (DEBUG_JUMP) {
      console.debug('[CQN Jump] tryLandOnMounted verify', { rectAfter: { top: rectAfter.top, bottom: rectAfter.bottom, width: rectAfter.width, height: rectAfter.height }, inViewport: true });
    }

    this.scanner.updateScrollMeta(target.localMessageId, this.scrollDriver.getScrollTop(), this.scrollDriver.getScrollRatio());
    await this.cacheStore.flush();
    this.highlightMessage(el);
    return true;
  }

  private async jumpToMounted(target: CachedMessage, token: JumpToken): Promise<boolean> {
    return await this.tryLandOnMounted(target, token);
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
