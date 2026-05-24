import '../src/ui/styles.css';

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
    const scrollDriver = new ScrollDriver(domAdapter);
    const runtimeStore = new RuntimeStore();
    const urlWatcher = new UrlWatcher(domAdapter);
    const scanner = new MessageScanner(domAdapter, cacheStore, scrollDriver, runtimeStore);
    const jumpController = new JumpController(scanner, cacheStore, scrollDriver, runtimeStore);

    urlWatcher.onConversationChange(async (id, previousId) => {
      if (!id) return;

      if (previousId?.startsWith('temp:') && !id.startsWith('temp:')) {
        await cacheStore.migrateTempCache(previousId, id);
      }

      const cache = await cacheStore.loadConversation(id);
      runtimeStore.setConversationId(id);
      runtimeStore.setMessages(cache?.messages ?? []);
      await scanner.rescan();
    });

    scrollDriver.init();
    urlWatcher.start();
    scanner.start();

    window.addEventListener('beforeunload', () => {
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
    });

    await createShadowRootApp(ctx, { runtimeStore, jumpController });
  }
});
