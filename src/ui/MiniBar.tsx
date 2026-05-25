import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import type { CachedMessage } from '../shared/types';

const MAX_VISIBLE = 10;
const HALF_WINDOW = Math.floor(MAX_VISIBLE / 2);

interface HoverState {
  message: CachedMessage;
  rect: DOMRect;
  index: number;
  label: string;
}

interface MiniBarProps {
  messages: CachedMessage[];
  activeMessageId: string | null;
  mountedIds: Set<string>;
  onJump: (message: CachedMessage) => void;
  onExpand: () => void;
}

function getActiveIndex(messages: CachedMessage[], activeId: string | null): number {
  if (!activeId) return 0;
  const idx = messages.findIndex((m) => m.localMessageId === activeId);
  return idx >= 0 ? idx : 0;
}

function getVisibleRange(total: number, activeIdx: number): { start: number; end: number } {
  if (total <= MAX_VISIBLE) return { start: 0, end: total };
  const start = Math.max(0, Math.min(activeIdx - HALF_WINDOW, total - MAX_VISIBLE));
  return { start, end: start + MAX_VISIBLE };
}

/** 计算前 i 条消息中有多少条 user 消息 */
function countUserBefore(messages: CachedMessage[], upTo: number): number {
  let count = 0;
  for (let j = 0; j < upTo; j++) {
    if (messages[j]?.role === 'user') count++;
  }
  return count;
}

export function MiniBar({ messages, activeMessageId, mountedIds, onJump, onExpand }: MiniBarProps) {
  const [hover, setHover] = useState<HoverState | null>(null);

  const clearHover = useCallback(() => setHover(null), []);

  useEffect(() => {
    window.addEventListener('scroll', clearHover, true);
    return () => window.removeEventListener('scroll', clearHover, true);
  }, [clearHover]);

  const activeIdx = useMemo(() => getActiveIndex(messages, activeMessageId), [messages, activeMessageId]);
  const visible = useMemo(() => {
    const { start, end } = getVisibleRange(messages.length, activeIdx);
    return messages.slice(start, end).map((msg, i) => {
      const globalIdx = start + i;
      const qCount = countUserBefore(messages, globalIdx) + (msg.role === 'user' ? 1 : 0);
      const label = msg.role === 'user' ? `Q${qCount}` : `A${qCount}`;
      return { message: msg, originalIndex: globalIdx, label };
    });
  }, [messages, activeIdx]);

  const canPrev = activeIdx > 0 && messages.slice(0, activeIdx).some((m) => m.role === 'user');
  const canNext = activeIdx < messages.length - 1 && messages.slice(activeIdx + 1).some((m) => m.role === 'user');

  const handlePrev = () => {
    for (let i = activeIdx - 1; i >= 0; i--) {
      if (messages[i]?.role === 'user') { onJump(messages[i]!); return; }
    }
  };

  const handleNext = () => {
    for (let i = activeIdx + 1; i < messages.length; i++) {
      if (messages[i]?.role === 'user') { onJump(messages[i]!); return; }
    }
  };

  const handleMarkHover = (e: MouseEvent, message: CachedMessage, index: number, label: string) => {
    const target = e.currentTarget as HTMLElement;
    setHover({ message, rect: target.getBoundingClientRect(), index, label });
  };

  return (
    <>
      <div className="cqn-minibar" role="navigation" aria-label="Mini 问题导航">
        <button
          className={`cqn-mini-nav${canPrev ? '' : ' is-disabled'}`}
          type="button"
          onClick={handlePrev}
          aria-label="上一条问题"
        >
          ▲
        </button>

        {visible.map(({ message, originalIndex, label }) => {
          const isActive = message.localMessageId === activeMessageId;
          const isMounted = mountedIds.has(message.localMessageId);
          const stateClass = isActive ? 'is-active' : isMounted ? 'is-mounted' : 'is-cached';
          const isAi = message.role === 'assistant';

          return (
            <button
              key={message.localMessageId}
              className={`cqn-mini-mark${isAi ? '-ai' : ''} ${stateClass}`}
              type="button"
              onClick={() => onJump(message)}
              onMouseEnter={(e) => handleMarkHover(e, message, originalIndex, label)}
              onMouseLeave={() => setHover(null)}
              aria-label={label}
            />
          );
        })}

        <button
          className={`cqn-mini-nav${canNext ? '' : ' is-disabled'}`}
          type="button"
          onClick={handleNext}
          aria-label="下一条问题"
        >
          ▼
        </button>

        <button className="cqn-mini-expand" type="button" onClick={onExpand} aria-label="展开导航">
          ☰
        </button>
      </div>

      {hover && (
        <span
          className="cqn-hover-preview"
          role="tooltip"
          style={{
            position: 'fixed',
            top: `${hover.rect.top}px`,
            right: `${window.innerWidth - hover.rect.left + 12}px`,
          }}
        >
          <span style={{ color: 'var(--cqn-accent)', fontSize: '9px', fontWeight: 700, display: 'block', marginBottom: '3px' }}>
            {hover.label}
          </span>
          {hover.message.textForSearch}
        </span>
      )}
    </>
  );
}
