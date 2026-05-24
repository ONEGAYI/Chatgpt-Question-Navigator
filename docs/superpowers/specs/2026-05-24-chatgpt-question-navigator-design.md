# ChatGPT Question Navigator — 完整设计文档

> 日期：2026-05-24
> 状态：修订版 v4

## 1. 项目概述

构建一个本地优先、隐私友好的 ChatGPT 长对话导航 Chrome/Edge 扩展。在 chatgpt.com 页面右侧注入导航侧栏，自动采集用户消息，建立本地缓存，支持直接跳转和渐进式远距离跳转。

### 核心原则

- 只使用 DOM 扫描 + 滚动采集 + 本地缓存
- 不调用 ChatGPT 内部 API
- 不 monkey patch fetch / XHR
- 不上传任何聊天内容
- 不请求 `<all_urls>` 权限
- 所有数据仅保存在浏览器本地

### 技术决策

| 决策项 | 选择 | 理由 |
|--------|------|------|
| 框架 | WXT | Manifest V3 开发框架，开箱即用，提供 createShadowRootUi |
| 语言 | TypeScript ^5.x | 类型安全 |
| UI 框架 | Preact ^10.x + preact/compat | 轻量（~3KB），兼容 React memo 等 API |
| 存储方案 | chrome.storage.local | API 简单，WXT 封装好，自用数据量可控 |
| 架构 | 经典分层架构 | 调试友好，适合项目规模 |
| 跳转策略 | 混合（ratio seed + order-guided adaptive stepping） | 实用稳健，不依赖严格二分 |
| 侧栏风格 | 融入 ChatGPT 风格 | 手动定义 CSS 变量匹配 ChatGPT 主题 |
| Shadow DOM | WXT createShadowRootUi + cssInjectionMode: 'ui' | 开发期 open mode 可调试，WXT 统一管理生命周期 |
| 列表性能 | 全量渲染 + 滚动容器 + IO 高亮驱动 | 自用场景消息量有限，无需虚拟列表 |

## 2. 项目结构

```
chatgpt-question-navigator/
├── package.json
├── tsconfig.json
├── wxt.config.ts              # WXT 框架配置
├── README.md
├── docs/                      # 规格文档
│
├── src/
│   ├── entrypoints/
│   │   └── content.ts         # Content script 入口（WXT 约定）
│   │
│   ├── content/
│   │   ├── domAdapter.ts      # DOM 选择器集中管理 + 消息节点识别
│   │   ├── scrollDriver.ts    # 滚动容器抽象层（window / document.scrollingElement / 内部容器）
│   │   ├── messageScanner.ts  # DOM 扫描 + MutationObserver + 滚动采集
│   │   ├── jumpController.ts  # 直接跳转 + 渐进式跳转 + cancellation token
│   │   ├── cacheStore.ts      # chrome.storage.local 读写 + 缓存合并逻辑 + LRU 容量管理
│   │   ├── runtimeStore.ts    # 运行期状态：mountedIds、activeMessageId、jumpState
│   │   └── urlWatcher.ts      # URL 变化监听（SPA 路由）+ temp cache migration
│   │
│   ├── ui/
│   │   ├── Sidebar.tsx        # 主侧栏组件
│   │   ├── ShadowRootApp.tsx  # WXT createShadowRootUi 容器 + Preact 挂载
│   │   ├── MessageItem.tsx    # 单条消息列表项
│   │   ├── SearchBox.tsx      # 搜索框组件
│   │   ├── JumpToast.tsx      # 跳转状态/失败提示
│   │   └── styles.css         # 侧栏样式（融入 ChatGPT 风格，import 到 content.ts）
│   │
│   └── shared/
│       ├── types.ts           # 所有 TypeScript 类型定义
│       └── hash.ts            # 文本哈希工具
│
└── public/
    └── icon.png               # 扩展图标
```

### 模块依赖关系

```
content.ts (入口)
  ├── DomAdapter (无依赖，纯 DOM 操作)
  ├── CacheStore (无依赖，仅持久化数据)
  ├── ScrollDriver (依赖 DomAdapter.findScrollContainer)
  ├── UrlWatcher (依赖 DomAdapter 提取 conversationId)
  ├── RuntimeStore (依赖 CacheStore 获取 messages 列表)
  ├── MessageScanner (依赖 DomAdapter + CacheStore + ScrollDriver + RuntimeStore)
  ├── JumpController (依赖 MessageScanner + CacheStore + ScrollDriver + RuntimeStore)
  └── ShadowRootApp (依赖 RuntimeStore + JumpController)
```

## 3. WXT 配置

```typescript
// wxt.config.ts
export default defineConfig({
  manifest: {
    name: 'ChatGPT Question Navigator',
    description: 'ChatGPT 长对话导航侧栏 - 本地索引用户问题，支持快速跳转',
    version: '1.0.0',
    permissions: ['storage'],
    host_permissions: [
      'https://chatgpt.com/*',
      'https://chat.openai.com/*'
    ],
  },
});
```

不请求 `tabs`、`activeTab`、`<all_urls>` 等多余权限。

## 4. 数据层

### 状态职责划分

```
┌─────────────────────────────────────────────────────────────┐
│                    状态归属三分类                             │
│                                                              │
│  cacheStore（持久化）        runtimeStore（内存，不持久化）    │
│  ├─ ConversationCache       ├─ mountedIds: Set<string>      │
│  ├─ StorageMeta             ├─ elementById: Map<string, El> │
│  ├─ messages[]              ├─ activeMessageId              │
│  └─ occurrenceIndex 分配    ├─ jumpState                    │
│                             └─ conversationId               │
│                                                              │
│                     Sidebar 本地状态（组件内）                 │
│                     ├─ searchQuery                          │
│                     ├─ collapsed                            │
│                     └─ searchResults                        │
└─────────────────────────────────────────────────────────────┘
```

**设计原则**：
- cacheStore 只管理持久化数据（conversation cache + storage meta），不持有运行期 UI 状态
- runtimeStore 持有所有内存态运行数据（mountedIds、activeMessageId、jumpState、elementById），提供 subscribe 通知
- Sidebar 组件通过 runtimeStore.subscribe() 获取数据，本地管理 UI 交互状态（searchQuery、collapsed）

### 核心持久化类型

```typescript
// === 持久化到 chrome.storage.local 的数据 ===

interface CachedUserMessage {
  conversationId: string;
  localMessageId: string;      // 见下方 localMessageId 生成规则
  role: 'user';
  textForSearch: string;        // 截断到 2000 chars，用于搜索匹配
  preview: string;              // 前 80-150 字，用于侧栏列表显示
  textHash: string;             // SHA-256 前 8 位
  occurrenceIndex: number;      // 同一 conversationId + textHash 下稳定分配的序号
  firstSeenAt: number;          // timestamp
  lastSeenAt: number;
  lastKnownScrollTop: number;
  lastKnownScrollRatio: number;
  orderKey: number;             // 可变排序字段，当前会话中的大致位置
}

// === localMessageId 生成规则 ===
//
// 规则 1：有 observedDomMessageId
//   localMessageId = `${conversationId}::dom::${observedDomMessageId}`
//
// 规则 2：无 observedDomMessageId，通过 cacheStore.resolveScannedCandidates() 匹配后
//   localMessageId = `${conversationId}::hash::${textHash}::${occurrenceIndex}`
//
// occurrenceIndex 由 cacheStore.resolveScannedCandidates() 稳定分配（见 §5）

interface ConversationCache {
  conversationId: string;
  updatedAt: number;
  messages: CachedUserMessage[];
}

interface StorageMeta {
  conversationIds: string[];    // 按 updatedAt 降序（LRU 顺序）
  totalBytes: number;
  lastCleanupAt: number;
}
```

### 扫描候选类型

```typescript
// messageScanner 从 DOM 提取的原始候选数据，交由 cacheStore 解析身份
interface ScannedUserMessageCandidate {
  observedDomMessageId: string | null;  // DOM 上的标识（data-id 等）
  text: string;
  textHash: string;
  preview: string;
  textForSearch: string;                 // 截断后
  scrollRatio: number;                   // 当前 scrollRatio
  scrollTop: number;                     // 当前 scrollTop
  domOrderIndex: number;                 // 在当前 DOM 中的顺序（0-based）
  element: HTMLElement;                  // DOM 引用（运行期使用，不持久化）
}
```

### 运行期状态类型

```typescript
// runtimeStore 持有的完整运行期状态
interface RuntimeState {
  conversationId: string | null;
  messages: CachedUserMessage[];       // 从 cacheStore 加载的当前会话消息

  // DOM 挂载状态（由 messageScanner 更新）
  elementById: Map<string, HTMLElement>;
  mountedIds: Set<string>;

  // 可见性追踪（由 IntersectionObserver 更新）
  activeMessageId: string | null;

  // 跳转状态（由 jumpController 更新）
  jumpState: JumpState;
}

type JumpState =
  | { status: 'idle' }
  | { status: 'jumping'; targetId: string; attempt: number }
  | { status: 'failed'; targetId: string; reason: string };

// messageScanner.rescan() 返回值
interface ScanResult {
  mountedIds: Set<string>;
  activeMessageId: string | null;
  visibleRange: {
    minOrderKey: number;
    maxOrderKey: number;
  } | null;
  newOrUpdated: CachedUserMessage[];
}
```

### cacheStore 接口

```typescript
interface CacheStore {
  // 存储操作
  loadConversation(id: string): Promise<ConversationCache | null>;
  saveConversation(cache: ConversationCache): Promise<void>;
  clearConversation(id: string): Promise<void>;
  clearAll(): Promise<void>;

  // 核心：将扫描候选解析为确定的 CachedUserMessage[]
  // 综合 observedDomMessageId、textHash、scrollRatio、orderKey、DOM 顺序匹配已有缓存
  // 匹配到的保持原 localMessageId；匹配不到的分配新 occurrenceIndex
  resolveScannedCandidates(
    conversationId: string,
    candidates: Omit<ScannedUserMessageCandidate, 'element'>[]
  ): CachedUserMessage[];

  // temp cache migration
  migrateTempCache(tempId: string, realId: string): Promise<void>;

  // 容量管理
  getBytesInUse(): Promise<number>;
  performLruCleanupIfNeeded(): Promise<void>;
}
```

### resolveScannedCandidates 匹配算法

这是避免重复消息误合并的关键。当 DOM 节点无 observedDomMessageId 时，仅靠 textHash 不足以区分相同文本的不同消息。

**匹配流程**：

```
输入：candidates[]（当前 DOM 扫描结果）
已缓存：existingMessages[]（cacheStore 中的消息）

Step 1: 精确匹配 — observedDomMessageId
  candidate.observedDomMessageId 存在 → 在 existing 中找 localMessageId 包含该 ID 的
  匹配到 → 保持原 localMessageId，更新 scroll 信息

Step 2: 模糊匹配 — textHash + 综合线索
  无 observedDomMessageId 的 candidate，按 textHash 分组
  对每个 textHash 组：
    获取 existing 中同 textHash 的所有未匹配消息
    按 scrollRatio 接近度排序候选匹配
    综合考虑：
      - scrollRatio 差距（权重最高）
      - orderKey 与 domOrderIndex 的相对一致性
      - DOM 顺序与缓存顺序的对应关系
    贪心匹配：差距最小的先配对
    匹配到 → 保持原 localMessageId
    未匹配到 → 分配新 occurrenceIndex，生成新 localMessageId

Step 3: 孤儿检测
  existing 中未匹配到的消息 → 保持原样（可能已不在 DOM 中，不应删除）
```

**核心保证**：
- 两条相同文本消息不会被误合并（scrollRatio + DOM 顺序综合判断）
- 不会在每次 rescan 时生成新 ID（已匹配到的保持原 ID）
- 消息临时从 DOM 消失后重新出现时，能通过 scrollRatio 等线索重新关联

### cacheStore 职责

1. **读写 chrome.storage.local** — 按 `conv:{conversationId}` 为 key 存储；维护 `meta` key
2. **resolveScannedCandidates** — 稳定身份解析（上述算法）
3. **批量保存** — debounce 2s
4. **存储容量控制**：
   - textForSearch 截断到 2000 chars，preview 80-150 chars
   - 保存后 getBytesInUse 检查，超过 8MB 阈值执行 LRU 清理
   - LRU：按 StorageMeta.conversationIds 中 updatedAt 最旧的删除，直到低于 80%
5. **temp cache migration** — 新建对话用 `"temp:{timestamp}"`，真实 ID 出现后迁移

### temp cache migration 流程

```
用户新建对话 → URL 为 /（无 ID）→ 创建 temp:{timestamp} 缓存
    ↓
用户发送消息 → DOM 扫描 → 写入 temp 缓存
    ↓
URL 变为 /c/{realId} → urlWatcher 检测到变化
    ↓
cacheStore.migrateTempCache(tempId, realId)
  - 更新所有消息的 conversationId 和 localMessageId
  - 以 realId 写入新缓存
  - 删除 temp 缓存
    ↓
runtimeStore.updateConversationId(realId)
messageScanner.rescan()
```

### runtimeStore 接口

```typescript
interface RuntimeStore {
  // 读取
  getSnapshot(): RuntimeState;

  // 更新 conversationId（URL 变化时）
  setConversationId(id: string | null): void;

  // 更新消息列表（cacheStore 加载或 resolve 后）
  setMessages(messages: CachedUserMessage[]): void;

  // 更新运行期挂载状态（由 messageScanner 调用）
  setMountedState(mountedIds: Set<string>, elementById: Map<string, HTMLElement>): void;
  setActiveMessageId(id: string | null): void;

  // 更新跳转状态（由 jumpController 调用）
  setJumpState(state: JumpState): void;

  // 响应式
  subscribe(listener: () => void): () => void;
}
```

### 数据流

```
DOM 扫描 → messageScanner.rescan()
              ↓
         生成 ScannedUserMessageCandidate[]
              ↓
         cacheStore.resolveScannedCandidates(candidates) → CachedUserMessage[]
              ↓
         runtimeStore.setMessages(resolved) + setMountedState(mountedIds, elementById)
              ↓
         subscribe 通知
              ↓
         Preact Sidebar 重渲染
```

```
URL 变化 → urlWatcher → callback
              ↓
         cacheStore.migrateTempCache()（如需要）
              ↓
         cacheStore.loadConversation(newId)
              ↓
         runtimeStore.setConversationId(newId) + setMessages(messages)
              ↓
         messageScanner.rescan()
```

## 5. DOM 扫描与消息采集

### domAdapter — 选择器集中管理

domAdapter 只负责 DOM 查询和文本提取。

```typescript
const SELECTORS = {
  // 主选择器（Phase 1-2 唯一启用）
  userMessage: '[data-message-author-role="user"]',

  // 后备选择器（标记 experimental，Phase 1-2 不启用）
  // userMessageExperimental: '.text-base .whitespace-pre-wrap',

  messageText: '.whitespace-pre-wrap, .message-body, [data-message-author-role] > div',
  excludeButtons: 'button, [role="button"], .copy-button, .edit-button',
  scrollContainer: 'main .overflow-y-auto, [class*="react-scroll-to-bottom"]',
} as const;

interface DomAdapter {
  findUserMessages(): HTMLElement[];
  extractText(el: HTMLElement): string;
  extractConversationId(): string | null;
  findScrollContainer(): HTMLElement | null;
  isElementInViewport(el: HTMLElement): boolean;
  extractObservedId(el: HTMLElement): string | null;
}
```

### scrollDriver — 滚动容器抽象层

统一封装所有滚动操作。直接跳转和渐进式跳转最终定位都通过 ScrollDriver，jumpController 不直接调用 el.scrollIntoView。

```typescript
interface ScrollDriver {
  init(): void;

  // 读取
  getScrollTop(): number;
  getScrollHeight(): number;
  getClientHeight(): number;
  getScrollRatio(): number;      // clamp(scrollTop / (scrollHeight - clientHeight), 0, 1)
  getContainer(): HTMLElement | Window;

  // 程序化滚动
  scrollTo(options: ScrollToOptions): void;
  scrollBy(deltaY: number): void;
  scrollToRatio(ratio: number, behavior?: ScrollBehavior): void;
  // 实现：const top = ratio * (getScrollHeight() - getClientHeight());
  //       scrollTo({ top, behavior: behavior ?? 'auto' });

  // 元素滚动定位（替代直接 el.scrollIntoView）
  scrollElementIntoView(el: HTMLElement, options?: ScrollIntoViewOptions): void;
  // 内部处理：确保在正确的滚动容器上操作，而非依赖 window.scrollIntoView

  // 监听
  onScroll(callback: () => void): void;          // 所有滚动
  onUserScroll(callback: () => void): () => void; // 仅用户手动

  // 清理
  destroy(): void;
}
```

**滚动容器检测优先级**：
1. `domAdapter.findScrollContainer()` 返回的内部容器
2. `document.scrollingElement`
3. `window`

**区分程序化滚动与用户手动滚动**：

```
程序化滚动：scrollTo / scrollBy / scrollToRatio / scrollElementIntoView
            设置 _isProgrammatic = true
            在 scroll 事件中检查并重置
            → 不触发 onUserScroll

用户手动滚动（不使用泛化 click）：
  1. wheel — 鼠标滚轮
  2. touchstart / touchmove — 触摸屏
  3. keydown — PageUp/PageDown/Space/ArrowUp/ArrowDown/Home/End
  4. pointerdown — 仅限 ChatGPT 主滚动区域
     排除插件 Shadow DOM 内的 pointerdown（检查 composedPath 或 host 元素）
  → 直接触发 onUserScroll
```

### messageScanner — 采集引擎

```typescript
interface MessageScanner {
  start(): void;
  stop(): void;

  // 核心：扫描 DOM，生成候选，交由 cacheStore 解析身份，返回结构化结果
  rescan(): Promise<ScanResult>;

  // 运行期 element map 查询
  getElementByLocalId(localId: string): HTMLElement | undefined;
  getMountedIds(): Set<string>;

  // 更新单条消息 scroll metadata
  updateScrollMeta(localId: string, scrollTop: number, scrollRatio: number): void;
}
```

**rescan() 流程**：
1. `domAdapter.findUserMessages()` 获取所有用户消息节点
2. 对每个节点生成 `ScannedUserMessageCandidate`（含 observedDomMessageId、textHash、scrollRatio、domOrderIndex 等）
3. 将候选列表传给 `cacheStore.resolveScannedCandidates(conversationId, candidates)`
4. 得到确定身份的 `CachedUserMessage[]`
5. 更新 runtimeStore 的 mountedIds、elementById
6. 返回 `ScanResult`

**IntersectionObserver 追踪 — activeMessageId 逻辑**：
- 观察所有已知用户消息节点
- 优先取视口内 top ≥ 0 且最小的 user message
- **长 assistant 回答场景**：视口内无 user message 时，取视口上方最近的一条（top < 0 中 top 最大的）

**滚动采集**：scrollDriver.onScroll → throttle 300ms → 更新可见消息的 scroll metadata

### urlWatcher — SPA 路由监听

```typescript
interface UrlWatcher {
  // 注册回调（必须在 start 之前注册）
  onConversationChange(callback: (id: string | null, previousId: string | null) => void): void;

  // 启动监听，立即 emit 当前 conversationId
  start(): void;

  // 获取当前 conversationId（随时可调用）
  getCurrentId(): string | null;

  stop(): void;
}
```

**监听方式**：
1. history.pushState / replaceState 代理
2. popstate 事件
3. 回退：setInterval 1s 轮询 location.href

**关键行为**：
- `start()` 必须在 `onConversationChange` 注册之后调用
- `start()` 调用时立即 emit 当前 URL 的 conversationId（previousId = null）
- `getCurrentId()` 随时返回当前 ID

## 6. 导航与跳转

### jumpController

所有滚动操作通过 scrollDriver，不直接调用 el.scrollIntoView。

#### 直接跳转

```typescript
async function jumpToMounted(target: CachedUserMessage): Promise<boolean> {
  const el = messageScanner.getElementByLocalId(target.localMessageId);
  if (!el) return false;

  scrollDriver.scrollElementIntoView(el, { block: 'center', behavior: 'smooth' });
  highlightMessage(el);  // 1.5 秒临时高亮
  return true;
}
```

#### 渐进式跳转

**混合策略**：
1. ratio seed jump（scrollRatio 粗定位）
2. order-guided adaptive stepping（基于 orderKey 判断方向）
3. 每步 rescan() 获取 ScanResult，判断 mountedIds 和 visibleRange
4. 目标出现在 mountedIds → scrollElementIntoView 精确定位
5. cancellation token + 最大 30 次 + 失败 toast

```typescript
interface JumpToken {
  cancelled: boolean;
  cancel: () => void;
}

function createJumpToken(): JumpToken {
  const token = { cancelled: false, cancel: () => {} };
  token.cancel = () => { token.cancelled = true; };
  return token;
}

async function jumpToCachedMessage(
  target: CachedUserMessage,
  token: JumpToken
): Promise<void> {
  const MAX_ATTEMPTS = 30;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (token.cancelled) return;

    // 检查目标是否已挂载
    const el = messageScanner.getElementByLocalId(target.localMessageId);
    if (el) {
      scrollDriver.scrollElementIntoView(el, { block: 'center', behavior: 'smooth' });
      highlightMessage(el);
      return;
    }

    // 扫描当前状态
    const result: ScanResult = await messageScanner.rescan();

    // rescan 后再检查
    if (result.mountedIds.has(target.localMessageId)) {
      const found = messageScanner.getElementByLocalId(target.localMessageId);
      if (found) {
        scrollDriver.scrollElementIntoView(found, { block: 'center', behavior: 'smooth' });
        highlightMessage(found);
        return;
      }
    }

    // 第一次用 scrollRatio 粗定位
    if (attempt === 0 && Number.isFinite(target.lastKnownScrollRatio)) {
      scrollDriver.scrollToRatio(target.lastKnownScrollRatio, 'auto');
    } else {
      const direction = decideDirection(target, result.visibleRange);
      scrollOneChunk(direction, attempt);
    }

    await waitForDomSettled(500);
  }

  showJumpFailedToast(target);
}
```

**辅助函数**：

| 函数 | 职责 |
|------|------|
| `decideDirection(target, visibleRange)` | 比较目标 orderKey 和可见范围，返回 'up' / 'down' |
| `scrollOneChunk(direction, attempt)` | scrollDriver.scrollBy() 自适应步长 |
| `waitForDomSettled(ms)` | 等待 DOM 稳定 |
| `highlightMessage(el)` | 1.5 秒高亮（ChatGPT 绿 #10a37f） |

**取消机制**：
- scrollDriver.onUserScroll（wheel/touch/key/pointerdown，排除 Shadow DOM）→ 取消
- 点击侧栏另一个目标 → 取消当前，开始新跳转
- Esc → 取消
- 新跳转自动取消前一个

## 7. 侧栏 UI

### Shadow DOM 容器

```typescript
// src/ui/ShadowRootApp.tsx
import type { ContentScriptContext } from 'wxt/client';
import { createShadowRootUi } from 'wxt/client';
import { render } from 'preact';
import Sidebar from './Sidebar';
import type { RuntimeStore } from '../content/runtimeStore';
import type { JumpController } from '../content/jumpController';

export async function createShadowRootApp(
  ctx: ContentScriptContext,
  deps: { runtimeStore: RuntimeStore; jumpController: JumpController }
) {
  const ui = await createShadowRootUi(ctx, {
    name: 'chatgpt-navigator',
    position: 'overlay',
    anchor: 'body',
    onMount(container: HTMLElement) {
      render(<Sidebar runtimeStore={deps.runtimeStore} jumpController={deps.jumpController} />, container);

      // 返回 cleanup 函数
      return () => {
        render(null, container);
      };
    },
    onRemove(cleanup: unknown) {
      if (typeof cleanup === 'function') {
        cleanup();
      }
    },
  });

  ui.mount();
}
```

### 组件结构

```
┌──────────────────────────┐
│  [≡] ChatGPT Navigator   │  ← 标题栏（可折叠）
│  ─────────────────────── │
│  🔍 搜索框               │  ← SearchBox
│  ─────────────────────── │
│  Indexed: 18 questions   │  ← 状态栏
│  ─────────────────────── │
│  Q1  如何在 React 中...   │  ← MessageItem (active)
│  Q2  请解释一下...        │  ← MessageItem
│  Q3  帮我写一个...        │  ← MessageItem (mounted ●)
│  Q4  [cached] 关于...    │  ← MessageItem (仅缓存 ○)
│  Q5  [cached] 什么是...  │  ← MessageItem
│  ...                     │
│  ─────────────────────── │
│  [Jumping to Q4...     ] │  ← JumpToast
└──────────────────────────┘
```

### 各组件

**Sidebar.tsx** — 主容器
- 通过 props 接收 runtimeStore 和 jumpController
- 使用 `runtimeStore.subscribe()` 监听变更，用 `useReducer` 或 `useState` 管理从 runtimeStore 同步的状态
- **本地管理** `searchQuery`、`collapsed`、`searchResults`（这些不属于 runtimeStore）
- 宽度：展开 280px / 折叠 40px（浮动按钮）
- 列表容器：`overflow-y: auto; max-height: calc(100vh - header - searchbox)`

**MessageItem.tsx** — 单条消息
- 序号（Q1, Q2...）+ preview
- 状态标记：active（高亮边框）、mounted（●）、cached（○）
- hover：textForSearch tooltip（最大高度 200px）
- 点击 → jumpController
- `import { memo } from 'preact/compat'` 包裹

**SearchBox.tsx** — 搜索
- debounce 300ms 搜索 textForSearch
- 高亮关键词
- 状态由 Sidebar 本地管理，不经过 runtimeStore

**JumpToast.tsx** — 跳转状态
- 从 runtimeStore.getSnapshot().jumpState 读取状态
- 底部显示，可关闭

### 样式

```css
:host {
  --bg-primary: #212121;
  --bg-secondary: #2f2f2f;
  --text-primary: #ececec;
  --text-secondary: #b4b4b4;
  --accent: #10a37f;
  --border: #424242;
  --sidebar-width: 280px;
  --sidebar-collapsed: 40px;
}
```

支持浅色模式：读取 `document.documentElement` 的 `data-theme` 或 class。

### Preact 性能优化

- `import { memo } from 'preact/compat'` 包裹 MessageItem 等纯展示组件
- `useMemo` 缓存过滤后的消息列表
- `useCallback` 缓存事件处理器

## 8. Content Script 入口

```typescript
// src/entrypoints/content.ts
import '../ui/styles.css';  // 路径修正：content.ts 在 src/entrypoints/，styles.css 在 src/ui/

export default defineContentScript({
  matches: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
  cssInjectionMode: 'ui',

  async main(ctx) {
    // 1. 初始化纯依赖模块
    const domAdapter = new DomAdapter();
    const cacheStore = new CacheStore();
    const scrollDriver = new ScrollDriver(domAdapter);

    // 2. 初始化需要回调注册的模块
    const urlWatcher = new UrlWatcher();
    const runtimeStore = new RuntimeStore(cacheStore);
    const scanner = new MessageScanner(domAdapter, cacheStore, scrollDriver, runtimeStore);
    const jumpController = new JumpController(scanner, cacheStore, scrollDriver, runtimeStore);

    // 3. 注册 URL 变化回调（必须在 start 之前）
    urlWatcher.onConversationChange(async (id, previousId) => {
      if (!id) return;

      // temp → real migration
      if (previousId?.startsWith('temp:') && !id.startsWith('temp:')) {
        await cacheStore.migrateTempCache(previousId, id);
      }

      // 加载缓存到 runtimeStore
      const cache = await cacheStore.loadConversation(id);
      runtimeStore.setConversationId(id);
      runtimeStore.setMessages(cache?.messages ?? []);

      // 缓存加载完成后 rescan
      await scanner.rescan();
    });

    // 4. 初始化滚动容器
    scrollDriver.init();

    // 5. 启动 URL 监听（立即 emit 当前 conversationId）
    urlWatcher.start();
    // → 触发上面的 callback → 加载当前会话缓存
    // → await 是在 callback 内部，不阻塞后续

    // 6. scanner.start() 在 cache load 完成后由 callback 触发首次 rescan
    //    此处启动 MutationObserver
    scanner.start();

    // 7. 用户手动滚动取消跳转
    scrollDriver.onUserScroll(() => {
      jumpController.cancelCurrent();
    });

    // 8. 创建 Shadow DOM UI
    await createShadowRootApp(ctx, { runtimeStore, jumpController });
  }
});
```

**初始化顺序要点**：
1. 先注册 onConversationChange callback
2. 再 start urlWatcher（start 立即 emit 当前 ID → 触发 cache load）
3. cache load 完成后 scanner.start() 的 MutationObserver 已就绪
4. scanner.start() 本身只启动 MutationObserver，不依赖 cache 已加载

## 9. 错误处理

| 场景 | 处理方式 |
|------|----------|
| DOM 选择器失效 | 静默降级，不崩溃，侧栏显示"检测中..." |
| storage 写入失败 | console.warn + 重试 1 次 |
| 跳转超时 | 显示失败 toast |
| ConversationId 解析失败 | temp:{timestamp}，后续迁移 |
| ChatGPT 页面未加载完成 | MutationObserver 自然等待 |
| Shadow DOM 注入失败 | console.error + 不影响页面 |
| scrollContainer 找不到 | 回退 document.scrollingElement / window |
| storage 容量超限 | LRU 自动清理 |

## 10. 性能防护

- **DOM 扫描**：MutationObserver 回调 debounce 500ms
- **滚动采集**：throttle 300ms
- **storage 写入**：debounce 2000ms
- **storage 容量**：getBytesInUse + LRU
- **Preact 渲染**：preact/compat memo + useMemo + useCallback
- **搜索**：debounce 300ms
- **文本截断**：textForSearch ≤ 2000 chars

## 11. 清理

- 停止 MutationObserver / IntersectionObserver
- scrollDriver.destroy()
- urlWatcher.stop()
- 保存最后的缓存数据
- WXT 自动清理 UI（onRemove → render(null, container)）

## 12. 实施阶段

### Phase 1-2：基础 + 缓存 + 侧栏

- 项目初始化（WXT + TypeScript + Preact）
- content script 注入（cssInjectionMode: 'ui'，import '../ui/styles.css'）
- domAdapter — 仅 data-message-author-role
- scrollDriver（含 scrollToRatio、getClientHeight、scrollElementIntoView）
- urlWatcher（start 立即 emit、getCurrentId）
- cacheStore（resolveScannedCandidates + LRU + temp migration）
- runtimeStore（mountedIds、activeMessageId、jumpState、elementById）
- messageScanner（rescan → ScanResult，候选交给 cacheStore 解析身份）
- Shadow DOM 侧栏（WXT createShadowRootUi，onMount 返回 cleanup）
- 侧栏展示已采集消息列表

### Phase 3：直接跳转 + 搜索

- 直接跳转（Promise<boolean>，通过 scrollDriver.scrollElementIntoView）
- 目标高亮（1.5 秒）
- IntersectionObserver activeMessageId（含长 assistant 场景）
- 搜索框（Sidebar 本地状态）

### Phase 4：渐进式跳转

- 渐进式跳转（Number.isFinite + order-guided adaptive stepping）
- 跳转取消（wheel/touch/key/pointerdown，排除 Shadow DOM）
- 最大尝试次数 + 失败 toast
- JumpToast

### Phase 5：收尾

- README + 隐私说明
- 权限最小化
- Chrome/Edge 加载说明
- 打包测试

## 13. 已知限制

- 插件无法读取从未在 DOM 中出现过的历史消息
- 第一次打开超长对话时，远处问题需滚动经过后才被缓存
- ChatGPT 页面结构变化可能导致 DOM 识别失效
- 渐进式跳转依赖 scroll metadata，不能保证 100% 精确
- chrome.storage.local 默认 10MB（LRU 控制在 8MB 以内）

## 14. 后续路线

- 验证并启用 experimental 后备选择器
- compact rail/minimap 模式
- 导出/导入缓存
- 自定义快捷键
- bracket + binary refinement 跳转优化
- fullText 可选存储
- unlimitedStorage 权限（如需要）
