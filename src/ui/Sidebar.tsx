import { useEffect, useMemo, useState } from 'preact/hooks';
import type { JumpController } from '../content/jumpController';
import type { RuntimeStore } from '../content/runtimeStore';
import type { CachedUserMessage, RuntimeState } from '../shared/types';
import { MessageItem } from './MessageItem';
import { MiniBar } from './MiniBar';
import { SearchBox } from './SearchBox';

type SidebarMode = 'expanded' | 'mini' | 'collapsed';

interface HoverState {
  message: CachedUserMessage;
  rect: DOMRect;
}

interface SidebarProps {
  runtimeStore: RuntimeStore;
  jumpController: JumpController;
}

export function Sidebar({ runtimeStore, jumpController }: SidebarProps) {
  const [snapshot, setSnapshot] = useState<RuntimeState>(() => runtimeStore.getSnapshot());
  const [mode, setMode] = useState<SidebarMode>('expanded');
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [hover, setHover] = useState<HoverState | null>(null);

  useEffect(() => runtimeStore.subscribe(() => setSnapshot(runtimeStore.getSnapshot())), [runtimeStore]);

  useEffect(() => {
    const timer = window.setTimeout(() => setSearchQuery(searchInput), 300);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const messages = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return snapshot.messages;
    return snapshot.messages.filter((message) => message.textForSearch.toLowerCase().includes(query));
  }, [snapshot.messages, searchQuery]);

  const handleJump = (target: CachedUserMessage) => void jumpController.jumpToMessage(target);

  // --- 折叠模式 ---
  if (mode === 'collapsed') {
    return (
      <aside className="cqn-sidebar is-collapsed">
        <button className="cqn-collapse" type="button" onClick={() => setMode('expanded')} title="展开导航">
          ☰
        </button>
      </aside>
    );
  }

  // --- Mini 模式 ---
  if (mode === 'mini') {
    return (
      <>
        <MiniBar
          messages={snapshot.messages}
          activeMessageId={snapshot.activeMessageId}
          mountedIds={snapshot.mountedIds}
          onJump={handleJump}
          onExpand={() => setMode('expanded')}
        />
      </>
    );
  }

  // --- 展开模式 ---
  return (
    <>
      <aside className="cqn-sidebar">
        <header className="cqn-header">
          <strong>ChatGPT Navigator</strong>
          <div style={{ display: 'flex', gap: '4px' }}>
            <button className="cqn-collapse" type="button" onClick={() => setMode('mini')} title="Mini 模式">
              ◫
            </button>
            <button className="cqn-collapse" type="button" onClick={() => setMode('collapsed')} title="折叠导航">
              ×
            </button>
          </div>
        </header>

        <SearchBox value={searchInput} onChange={setSearchInput} />

        <div className="cqn-status">
          Indexed {snapshot.messages.length} questions locally
        </div>

        <nav className="cqn-list" aria-label="ChatGPT user questions">
          {messages.map((message, index) => (
            <MessageItem
              key={message.localMessageId}
              message={message}
              index={index}
              active={snapshot.activeMessageId === message.localMessageId}
              mounted={snapshot.mountedIds.has(message.localMessageId)}
              searchQuery={searchQuery}
              onClick={handleJump}
              onHoverStart={(msg, rect) => setHover({ message: msg, rect })}
              onHoverEnd={() => setHover(null)}
            />
          ))}
        </nav>
      </aside>

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
          {hover.message.textForSearch}
        </span>
      )}
    </>
  );
}
