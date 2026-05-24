import { useMemo, useState } from 'preact/hooks';
import type { CachedUserMessage } from '../shared/types';

const MAX_VISIBLE = 7;
const HALF_WINDOW = Math.floor(MAX_VISIBLE / 2);

interface HoverState {
  message: CachedUserMessage;
  rect: DOMRect;
  index: number;
}

interface MiniBarProps {
  messages: CachedUserMessage[];
  activeMessageId: string | null;
  mountedIds: Set<string>;
  onJump: (message: CachedUserMessage) => void;
  onExpand: () => void;
}

function getActiveIndex(messages: CachedUserMessage[], activeId: string | null): number {
  if (!activeId) return 0;
  const idx = messages.findIndex((m) => m.localMessageId === activeId);
  return idx >= 0 ? idx : 0;
}

function getVisibleRange(total: number, activeIdx: number): { start: number; end: number } {
  if (total <= MAX_VISIBLE) return { start: 0, end: total };
  const start = Math.max(0, Math.min(activeIdx - HALF_WINDOW, total - MAX_VISIBLE));
  return { start, end: start + MAX_VISIBLE };
}

export function MiniBar({ messages, activeMessageId, mountedIds, onJump, onExpand }: MiniBarProps) {
  const [hover, setHover] = useState<HoverState | null>(null);

  const activeIdx = useMemo(() => getActiveIndex(messages, activeMessageId), [messages, activeMessageId]);
  const visible = useMemo(() => {
    const { start, end } = getVisibleRange(messages.length, activeIdx);
    return messages.slice(start, end).map((msg, i) => ({ message: msg, originalIndex: start + i }));
  }, [messages, activeIdx]);

  const canPrev = activeIdx > 0;
  const canNext = activeIdx < messages.length - 1;

  const handlePrev = () => {
    if (!canPrev) return;
    onJump(messages[activeIdx - 1]);
  };

  const handleNext = () => {
    if (!canNext) return;
    onJump(messages[activeIdx + 1]);
  };

  const handleMarkHover = (e: MouseEvent, message: CachedUserMessage, index: number) => {
    const target = e.currentTarget as HTMLElement;
    setHover({ message, rect: target.getBoundingClientRect(), index });
  };

  return (
    <div className="cqn-minibar" role="navigation" aria-label="Mini 问题导航">
      <button
        className={`cqn-mini-nav${canPrev ? '' : ' is-disabled'}`}
        type="button"
        onClick={handlePrev}
        aria-label="上一条问题"
      >
        ▲
      </button>

      {visible.map(({ message, originalIndex }) => {
        const isActive = message.localMessageId === activeMessageId;
        const isMounted = mountedIds.has(message.localMessageId);
        const stateClass = isActive ? 'is-active' : isMounted ? 'is-mounted' : 'is-cached';

        return (
          <button
            key={message.localMessageId}
            className={`cqn-mini-mark ${stateClass}`}
            type="button"
            onClick={() => onJump(message)}
            onMouseEnter={(e) => handleMarkHover(e, message, originalIndex)}
            onMouseLeave={() => setHover(null)}
            aria-label={`Q${originalIndex + 1}`}
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
            Q{hover.index + 1}
          </span>
          {hover.message.textForSearch}
        </span>
      )}
    </div>
  );
}
