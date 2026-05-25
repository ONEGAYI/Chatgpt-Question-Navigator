import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { AutoCollector } from '../content/autoCollector';
import type { JumpController } from '../content/jumpController';
import type { RuntimeStore } from '../content/runtimeStore';
import type { AutoCollectPhase, CachedUserMessage, RuntimeState } from '../shared/types';
import { JumpToast } from './JumpToast';
import { MessageItem } from './MessageItem';
import { MiniBar } from './MiniBar';
import { SearchBox } from './SearchBox';

type SidebarMode = 'expanded' | 'mini' | 'collapsed';

const MODE_STORAGE_KEY = 'cqn-sidebar-mode';

const STATUS_TEXT: Record<AutoCollectPhase, string> = {
  idle: '',
  preparing: 'Preparing collection...',
  collecting: '',
  finalizing: 'Finalizing...',
  completed: '',
  cancelled: 'Collection cancelled',
  failed: '',
};

function getStatusText(phase: AutoCollectPhase | null | undefined, progress: { foundCount: number; hydratedCount?: number; totalTurns?: number; unhydratedCount?: number; errorMessage?: string } | null, messageCount: number): string {
  if (!phase || phase === 'idle') return `Indexed ${messageCount} questions locally`;
  if (phase === 'collecting') {
    const hydrated = progress?.hydratedCount ?? 0;
    const total = progress?.totalTurns ?? 0;
    const found = progress?.foundCount ?? 0;
    return `Collecting... ${found} questions (${hydrated}/${total} turns)`;
  }
  if (phase === 'completed') {
    const unhydrated = progress?.unhydratedCount ?? 0;
    if (unhydrated > 0) {
      return `Collected ${messageCount} questions, ${unhydrated} turns unhydrated`;
    }
    return `Collected ${messageCount} questions`;
  }
  if (phase === 'failed') return `Collection failed: ${progress?.errorMessage ?? 'unknown'}`;
  return STATUS_TEXT[phase];
}

interface HoverState {
  message: CachedUserMessage;
  rect: DOMRect;
}

interface SidebarProps {
  runtimeStore: RuntimeStore;
  jumpController: JumpController;
  onClearCurrentSession: () => Promise<void>;
  onStartAutoCollect: () => void;
  autoCollector: AutoCollector;
}

export function Sidebar({ runtimeStore, jumpController, onClearCurrentSession, onStartAutoCollect, autoCollector }: SidebarProps) {
  const [snapshot, setSnapshot] = useState<RuntimeState>(() => runtimeStore.getSnapshot());
  const [mode, setMode] = useState<SidebarMode>('expanded');
  const [modeLoaded, setModeLoaded] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [hover, setHover] = useState<HoverState | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const confirmTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => () => { if (confirmTimerRef.current !== undefined) clearTimeout(confirmTimerRef.current); }, []);

  const collectPhase = snapshot.autoCollectProgress?.phase;

  useEffect(() => {
    const unsubscribe = runtimeStore.subscribe(() => setSnapshot(runtimeStore.getSnapshot()));
    return unsubscribe;
  }, [runtimeStore]);

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

  const userMessages = useMemo(() => snapshot.messages.filter((m) => m.role === 'user'), [snapshot.messages]);
  const messages = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return userMessages;
    return userMessages.filter((message) => message.textForSearch.toLowerCase().includes(query));
  }, [userMessages, searchQuery]);

  const handleJump = (target: CachedUserMessage) => void jumpController.jumpToMessage(target);

  const clearHover = useCallback(() => setHover(null), []);

  const handleDismissJump = useCallback(() => jumpController.cancelCurrent(), [jumpController]);

  const handleClearClick = useCallback(async () => {
    if (clearing) return;
    if (!confirmClear) {
      setConfirmClear(true);
      confirmTimerRef.current = window.setTimeout(() => { confirmTimerRef.current = undefined; setConfirmClear(false); }, 2000);
      return;
    }
    setClearing(true);
    setConfirmClear(false);
    try {
      await onClearCurrentSession();
    } finally {
      setClearing(false);
    }
  }, [confirmClear, clearing, onClearCurrentSession]);

  useEffect(() => {
    window.addEventListener('scroll', clearHover, true);
    return () => window.removeEventListener('scroll', clearHover, true);
  }, [clearHover]);

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
          messages={userMessages}
          activeMessageId={snapshot.activeMessageId}
          mountedIds={snapshot.mountedIds}
          onJump={handleJump}
          onExpand={() => handleModeChange('expanded')}
        />
        <JumpToast jumpState={snapshot.jumpState} onDismiss={handleDismissJump} />
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
            {snapshot.conversationId && (
              <button
                className="cqn-collapse"
                type="button"
                onClick={() => {
                  if (collectPhase === 'collecting' || collectPhase === 'preparing') {
                    autoCollector.cancel();
                  } else {
                    onStartAutoCollect();
                  }
                }}
                disabled={clearing || collectPhase === 'finalizing'}
                title={
                  collectPhase === 'collecting' ? '取消采集' :
                  collectPhase === 'preparing' ? '准备中...' :
                  collectPhase === 'finalizing' ? '正在完成...' :
                  '重新采集本对话'
                }
              >
                {collectPhase === 'collecting' || collectPhase === 'preparing' || collectPhase === 'finalizing' ? (
                  <span className="cqn-collect-spinner">↻</span>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="23 4 23 10 17 10" />
                    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                  </svg>
                )}
              </button>
            )}
            {snapshot.conversationId && (
              <button
                className={`cqn-collapse ${confirmClear ? 'is-confirming' : ''}`}
                type="button"
                onClick={handleClearClick}
                disabled={clearing}
                title={confirmClear ? '再次点击确认清除' : '清除当前会话缓存'}
                style={clearing ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
              >
                {confirmClear ? '?' : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                )}
              </button>
            )}
            <button className="cqn-collapse" type="button" onClick={() => handleModeChange('mini')} title="Mini 模式">
              ◫
            </button>
            <button className="cqn-collapse" type="button" onClick={() => handleModeChange('collapsed')} title="折叠导航">
              ×
            </button>
          </div>
        </header>

        <SearchBox value={searchInput} onChange={setSearchInput} />

        {!clearing && (
          <div className="cqn-status">
            {getStatusText(collectPhase, snapshot.autoCollectProgress, userMessages.length)}
          </div>
        )}

        {clearing && messages.length === 0 ? (
          <div className="cqn-list" role="status" aria-live="polite">
            <div className="cqn-clearing-notice">已清理，即将重新采集当前会话……</div>
          </div>
        ) : (
          <nav className="cqn-list" aria-label="ChatGPT user questions">
            {messages.map((message, index) => (
              <MessageItem
                key={message.localMessageId}
                message={message}
                index={index}
                active={snapshot.activeMessageId === message.localMessageId}
                mounted={snapshot.mountedIds.has(message.localMessageId)}
                isJumping={snapshot.jumpState.status === 'jumping' && snapshot.jumpState.targetId === message.localMessageId}
                searchQuery={searchQuery}
                onClick={handleJump}
                onHoverStart={(msg, rect) => setHover({ message: msg, rect })}
                onHoverEnd={() => setHover(null)}
              />
            ))}
          </nav>
        )}

        <JumpToast jumpState={snapshot.jumpState} onDismiss={handleDismissJump} />
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
