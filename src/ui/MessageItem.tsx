import { memo } from 'preact/compat';
import type { CachedUserMessage } from '../shared/types';
import { splitByQuery } from '../shared/text';

interface MessageItemProps {
  message: CachedUserMessage;
  index: number;
  active: boolean;
  mounted: boolean;
  searchQuery: string;
  onClick: (message: CachedUserMessage) => void;
  onHoverStart?: (message: CachedUserMessage, rect: DOMRect) => void;
  onHoverEnd?: () => void;
}

function MessageItemComponent({
  message, index, active, mounted, searchQuery,
  onClick, onHoverStart, onHoverEnd,
}: MessageItemProps) {
  const parts = splitByQuery(message.preview, searchQuery);

  const handleMouseEnter = (e: MouseEvent) => {
    const target = (e.currentTarget as HTMLElement).querySelector<HTMLElement>('.cqn-item-body');
    if (target && onHoverStart) {
      onHoverStart(message, target.getBoundingClientRect());
    }
  };

  return (
    <button
      className={`cqn-item${active ? ' is-active' : ''}`}
      type="button"
      onClick={() => onClick(message)}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={onHoverEnd}
    >
      <span className="cqn-item-index">Q{index + 1}</span>
      <span className="cqn-item-body">
        <span className="cqn-item-preview">
          {parts.map((part) => part.match ? <mark>{part.text}</mark> : <span>{part.text}</span>)}
        </span>
        <span className="cqn-item-meta">{mounted ? '● 当前可跳转' : '○ 已缓存'}</span>
      </span>
    </button>
  );
}

export const MessageItem = memo(MessageItemComponent);
