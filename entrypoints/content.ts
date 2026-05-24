import '../src/ui/styles.css';

import { AutoCollector } from '../src/content/autoCollector';
import { CacheStore } from '../src/content/cacheStore';
import { DomAdapter } from '../src/content/domAdapter';
import { JumpController } from '../src/content/jumpController';
import { MessageScanner } from '../src/content/messageScanner';
import { RuntimeStore } from '../src/content/runtimeStore';
import { ScrollDriver } from '../src/content/scrollDriver';
import { UrlWatcher } from '../src/content/urlWatcher';
import { createShadowRootApp } from '../src/ui/ShadowRootApp';

export default defineContentScript({
  matches: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
  cssInjectionMode: 'ui',
  async main(ctx) {
    const domAdapter = new DomAdapter();
    const cacheStore = new CacheStore();
    const scrollDriver = new ScrollDriver();
    const runtimeStore = new RuntimeStore();
    const urlWatcher = new UrlWatcher(domAdapter);
    const scanner = new MessageScanner(domAdapter, cacheStore, scrollDriver, runtimeStore);
    const jumpController = new JumpController(scanner, cacheStore, scrollDriver, runtimeStore);
    const autoCollector = new AutoCollector(domAdapter, cacheStore, scrollDriver, runtimeStore, async () => {
      scanner.clearState();
      await scanner.rescan();
    });

    const clearCurrentSession = async (): Promise<void> => {
      const { conversationId } = runtimeStore.getSnapshot();
      if (!conversationId) return;
      await cacheStore.flush();
      try {
        await cacheStore.clearConversation(conversationId);
      } catch {
        return;
      }
      runtimeStore.setMessages([]);
      scanner.stop();
      await new Promise((resolve) => setTimeout(resolve, 3000));
      scanner.start();
    };

    const startAutoCollect = async (): Promise<void> => {
      const { conversationId } = runtimeStore.getSnapshot();
      if (!conversationId) return;
      await AutoCollector.writeIntent(conversationId, location.href);
      location.reload();
    };

    urlWatcher.onConversationChange(async (id, previousId) => {
      if (!id) return;

      // Cancel active auto-collect when navigating to a different conversation
      const collectProgress = autoCollector.getProgress();
      if (collectProgress.phase === 'collecting' || collectProgress.phase === 'preparing') {
        autoCollector.cancel();
      }

      if (previousId?.startsWith('temp:') && !id.startsWith('temp:')) {
        await cacheStore.migrateTempCache(previousId, id);
      }

      const cache = await cacheStore.loadConversation(id);
      runtimeStore.setConversationId(id);
      runtimeStore.setMessages(cache?.messages ?? []);
      scanner.clearState();
      scrollDriver.redetectScrollRoot('conversation-change');
    });

    // 修正 #1: 在 urlWatcher.start() 前读 intent，避免回调竞态
    const intent = await AutoCollector.readIntent();
    const currentConvId = domAdapter.extractConversationId();
    const INTENT_TTL_MS = 60_000;
    const shouldAutoCollectOnStartup = intent !== null && currentConvId !== null
      && (Date.now() - intent.requestedAt < INTENT_TTL_MS)
      && (intent.conversationId === currentConvId || intent.url === location.href);

    if (intent !== null) {
      await AutoCollector.clearIntent();
    }

    if (shouldAutoCollectOnStartup) {
      await AutoCollector.clearIntent();
    }

    scrollDriver.init();
    urlWatcher.start();

    let pollId: number | undefined;

    if (shouldAutoCollectOnStartup && currentConvId) {
      // Auto-collect 路径：跳过 scanner.start()，等滚动根就绪后启动采集
      let pollAttempts = 0;
      pollId = window.setInterval(async () => {
        try {
          pollAttempts++;
          scrollDriver.redetectScrollRoot(`init-poll-${pollAttempts}`);
          if (scrollDriver.getScrollRoot().element || pollAttempts >= 10) {
            clearInterval(pollId);
            pollId = undefined;
            try {
              await autoCollector.startFullCollection(currentConvId);
            } catch (e) {
              console.error('[CQN] Auto-collect failed:', e);
            }
            scanner.start();
          }
        } catch (e) {
          console.error('[CQN] Auto-collect poll error:', e);
        }
      }, 1000);
    } else {
      scanner.start();

      // 正常启动的 polling redetect
      let pollAttempts = 0;
      pollId = window.setInterval(() => {
        pollAttempts++;
        scrollDriver.redetectScrollRoot(`init-poll-${pollAttempts}`);
        if (scrollDriver.getScrollRoot().element || pollAttempts >= 10) {
          clearInterval(pollId);
          pollId = undefined;
        }
      }, 1000);
    }

    // Debug: Ctrl+Shift+D logs scroll driver snapshot to console.
    // Content script runs in isolated world — inline <script> injection is blocked by CSP.
    // A keyboard shortcut bypasses CSP entirely.
    const onDebugKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'D') {
        console.log('[CQN] ScrollDriver debug:', scrollDriver.getDebugSnapshot());
      }
    };
    window.addEventListener('keydown', onDebugKey);

    window.addEventListener('beforeunload', () => {
      if (pollId !== undefined) clearInterval(pollId);
      window.removeEventListener('keydown', onDebugKey);
      void cacheStore.flush();
      scanner.stop();
      scrollDriver.destroy();
      urlWatcher.stop();
    });

    // Popup 缓存管理消息监听
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg.type === 'CLEAR_CONVERSATION') {
        cacheStore.clearConversation(msg.id as string).then(() => {
          if (msg.id === runtimeStore.getSnapshot().conversationId) {
            runtimeStore.setMessages([]);
          }
          sendResponse({ success: true });
        }).catch((err) => sendResponse({ success: false, error: String(err) }));
        return true;
      }

      if (msg.type === 'CLEAR_ALL') {
        cacheStore.clearAll().then(() => {
          runtimeStore.setMessages([]);
          sendResponse({ success: true });
        }).catch((err) => sendResponse({ success: false, error: String(err) }));
        return true;
      }

      if (msg.type === 'LRU_CLEANUP') {
        cacheStore.getBytesInUse().then(async (bytesBefore) => {
          await cacheStore.performLruCleanupIfNeeded();
          const bytesAfter = await cacheStore.getBytesInUse();
          sendResponse({ success: true, bytesBefore, bytesAfter });
        }).catch((err) => sendResponse({ success: false, error: String(err) }));
        return true;
      }

      if (msg.type === 'START_AUTO_COLLECT') {
        const cid = runtimeStore.getSnapshot().conversationId;
        if (cid) {
          startAutoCollect().then(() => sendResponse({ success: true }))
            .catch((err) => sendResponse({ success: false, error: String(err) }));
          return true;
        }
        sendResponse({ success: false, error: 'No active conversation' });
        return false;
      }
    });

    await createShadowRootApp(ctx, {
      runtimeStore,
      jumpController,
      onClearCurrentSession: clearCurrentSession,
      onStartAutoCollect: startAutoCollect,
      autoCollector,
    });
  }
});
