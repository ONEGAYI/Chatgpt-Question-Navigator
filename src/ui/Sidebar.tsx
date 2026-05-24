import { useEffect, useMemo, useState } from 'preact/hooks';
import type { JumpController } from '../content/jumpController';
import type { RuntimeStore } from '../content/runtimeStore';
import type { CachedUserMessage, RuntimeState } from '../shared/types';
import { MessageItem } from './MessageItem';
import { MiniBar } from './MiniBar';
import { SearchBox } from './SearchBox';

type SidebarMode = 'expanded' | 'mini' | 'collapsed';

const MODE_STORAGE_KEY = 'cqn-sidebar-mode';

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
  const [modeLoaded, setModeLoaded] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [hover, setHover] = useState<HoverState | null>(null);

  useEffect(() => runtimeStore.subscribe(() => setSnapshot(runtimeStore.getSnapshot())), [runtimeStore]);

  useEffect(() => {
    chrome.storage.local.get(MODE_STORAGE_KEY, (result) => {
      const stored = result[MODE_STORAGE_KEY];
      if (stored === 'expanded' || stored === 'mini' || stored === 'collapsed') {
        setMode(stored);
      }
      setModeLoaded(true);
    });
  }, []);

  const handleModeChange = (next: SidebarMode) => {
    setMode(next);
    chrome.storage.local.set({ [MODE_STORAGE_KEY]: next });
  };

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

  if (!modeLoaded) return null;

  // --- 折叠模式 ---
  if (mode === 'collapsed') {
    return (
      <aside className="cqn-sidebar is-collapsed">
        <button className="cqn-collapse" type="button" onClick={() => handleModeChange('expanded')} title="展开导航">
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
          onExpand={() => handleModeChange('expanded')}
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
            <button className="cqn-collapse" type="button" onClick={() => handleModeChange('mini')} title="Mini 模式">
              ◫
            </button>
            <button className="cqn-collapse" type="button" onClick={() => handleModeChange('collapsed')} title="折叠导航">
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
