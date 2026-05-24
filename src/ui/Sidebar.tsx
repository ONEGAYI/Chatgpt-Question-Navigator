import { useEffect, useMemo, useState } from 'preact/hooks';
import type { JumpController } from '../content/jumpController';
import type { RuntimeStore } from '../content/runtimeStore';
import type { RuntimeState } from '../shared/types';
import { MessageItem } from './MessageItem';
import { SearchBox } from './SearchBox';

interface SidebarProps {
  runtimeStore: RuntimeStore;
  jumpController: JumpController;
}

export function Sidebar({ runtimeStore, jumpController }: SidebarProps) {
  const [snapshot, setSnapshot] = useState<RuntimeState>(() => runtimeStore.getSnapshot());
  const [collapsed, setCollapsed] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => runtimeStore.subscribe(() => setSnapshot(runtimeStore.getSnapshot())), [runtimeStore]);

  const messages = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return snapshot.messages;
    return snapshot.messages.filter((message) => message.textForSearch.toLowerCase().includes(query));
  }, [snapshot.messages, searchQuery]);

  if (collapsed) {
    return (
      <aside className="cqn-sidebar is-collapsed">
        <button className="cqn-collapse" type="button" onClick={() => setCollapsed(false)} title="展开导航">
          ☰
        </button>
      </aside>
    );
  }

  return (
    <aside className="cqn-sidebar">
      <header className="cqn-header">
        <strong>ChatGPT Navigator</strong>
        <button className="cqn-collapse" type="button" onClick={() => setCollapsed(true)} title="折叠导航">
          ×
        </button>
      </header>

      <SearchBox value={searchQuery} onChange={setSearchQuery} />

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
            onClick={(target) => void jumpController.jumpToMessage(target)}
          />
        ))}
      </nav>
    </aside>
  );
}
