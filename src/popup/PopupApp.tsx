import { useCallback, useEffect, useState } from 'preact/hooks';

interface ConversationInfo {
  id: string;
  updatedAt: number;
  messageCount: number;
}

interface StorageInfo {
  bytesInUse: number;
  conversations: ConversationInfo[];
}

interface ToastState {
  message: string;
  key: number;
}

const STORAGE_LIMIT = 8 * 1024 * 1024;
const META_KEY = 'meta';
const CACHE_PREFIX = 'conv:';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatTime(ts: number): string {
  const diffMs = Date.now() - ts;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours} 小时前`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays} 天前`;
  return new Date(ts).toLocaleDateString('zh-CN');
}

function sendMessage(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response ?? {});
      }
    });
  });
}

async function fetchStorageInfo(): Promise<StorageInfo> {
  const [bytesInUse, metaResult] = await Promise.all([
    chrome.storage.local.getBytesInUse(null),
    chrome.storage.local.get(META_KEY),
  ]);

  const meta = metaResult[META_KEY];
  const conversationIds: string[] = meta?.conversationIds ?? [];

  if (conversationIds.length === 0) {
    return { bytesInUse, conversations: [] };
  }

  const keys = conversationIds.map((id) => `${CACHE_PREFIX}${id}`);
  const cacheResult = await chrome.storage.local.get(keys);

  const conversations: ConversationInfo[] = conversationIds
    .map((id) => {
      const cache = cacheResult[`${CACHE_PREFIX}${id}`];
      return {
        id,
        updatedAt: cache?.updatedAt ?? 0,
        messageCount: cache?.messages?.length ?? 0,
      };
    })
    .filter((c) => c.messageCount > 0);

  return { bytesInUse, conversations };
}

export function PopupApp() {
  const [info, setInfo] = useState<StorageInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirmClearAll, setConfirmClearAll] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [operating, setOperating] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const data = await fetchStorageInfo();
      setInfo(data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const showToast = (message: string) => {
    setToast({ message, key: Date.now() });
    setTimeout(() => setToast(null), 1600);
  };

  const handleClearConversation = async (id: string) => {
    setOperating(true);
    try {
      try {
        await sendMessage({ type: 'CLEAR_CONVERSATION', id });
      } catch {
        await chrome.storage.local.remove(`${CACHE_PREFIX}${id}`);
        const metaResult = await chrome.storage.local.get(META_KEY);
        const meta = metaResult[META_KEY];
        if (meta) {
          meta.conversationIds = meta.conversationIds.filter((cid: string) => cid !== id);
          await chrome.storage.local.set({ [META_KEY]: meta });
        }
      }
      showToast('已删除');
      await refresh();
    } finally {
      setOperating(false);
    }
  };

  const handleClearAll = async () => {
    if (!confirmClearAll) {
      setConfirmClearAll(true);
      return;
    }
    setOperating(true);
    try {
      try {
        await sendMessage({ type: 'CLEAR_ALL' });
      } catch {
        const metaResult = await chrome.storage.local.get(META_KEY);
        const meta = metaResult[META_KEY];
        if (meta) {
          const keys = meta.conversationIds.map((id: string) => `${CACHE_PREFIX}${id}`);
          await chrome.storage.local.remove([...keys, META_KEY]);
        }
      }
      setConfirmClearAll(false);
      showToast('已清空所有缓存');
      await refresh();
    } finally {
      setOperating(false);
    }
  };

  const handleLruCleanup = async () => {
    setOperating(true);
    try {
      try {
        await sendMessage({ type: 'LRU_CLEANUP' });
      } catch {
        // No content script running; best-effort local cleanup
      }
      showToast('清理完成');
      await refresh();
    } finally {
      setOperating(false);
    }
  };

  if (loading) {
    return <div class="popup"><div class="loading">加载中...</div></div>;
  }

  const usagePercent = info ? Math.min((info.bytesInUse / STORAGE_LIMIT) * 100, 100) : 0;
  const usageLevel = usagePercent > 90 ? 'is-critical' : usagePercent > 70 ? 'is-warning' : '';

  return (
    <div class="popup">
      {/* Header */}
      <div class="popup-header">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <span>ChatGPT Navigator</span>
      </div>

      {/* Storage meter */}
      <div class="storage-meter">
        <div class="storage-label">
          <span>存储用量</span>
          <span>{formatBytes(info?.bytesInUse ?? 0)} / {formatBytes(STORAGE_LIMIT)}</span>
        </div>
        <div class="storage-bar">
          <div
            class={`storage-bar-fill ${usageLevel}`}
            style={`width: ${usagePercent.toFixed(1)}%`}
          />
        </div>
      </div>

      {info && info.conversations.length > 0 && (
        <>
          <div class="divider" />

          {/* Conversation list */}
          <div class="section-title">
            缓存对话 ({info.conversations.length})
          </div>
          <div class="conv-list">
            {info.conversations.map((conv) => (
              <div class="conv-item" key={conv.id}>
                <div class="conv-info">
                  <div class="conv-id" title={conv.id}>
                    {conv.id.length > 20 ? `${conv.id.slice(0, 8)}...${conv.id.slice(-8)}` : conv.id}
                  </div>
                  <div class="conv-meta">
                    {conv.messageCount} 条消息 · {formatTime(conv.updatedAt)}
                  </div>
                </div>
                <button
                  class="conv-delete"
                  title="删除此对话缓存"
                  disabled={operating}
                  onClick={() => handleClearConversation(conv.id)}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      {info && info.conversations.length === 0 && (
        <>
          <div class="divider" />
          <div class="empty-state">暂无缓存数据</div>
        </>
      )}

      <div class="divider" />

      {/* Action buttons */}
      <div class="btn-group">
        <button
          class="btn btn-accent"
          disabled={operating}
          onClick={handleLruCleanup}
        >
          LRU 清理
        </button>
        <button
          class={`btn btn-danger ${confirmClearAll ? 'is-confirming' : ''}`}
          disabled={operating || (info?.conversations.length ?? 0) === 0}
          onClick={handleClearAll}
          onBlur={() => setConfirmClearAll(false)}
        >
          {confirmClearAll ? '确认清空?' : '清空全部'}
        </button>
      </div>

      {/* Toast */}
      {toast && (
        <div class="toast" key={toast.key}>{toast.message}</div>
      )}
    </div>
  );
}
