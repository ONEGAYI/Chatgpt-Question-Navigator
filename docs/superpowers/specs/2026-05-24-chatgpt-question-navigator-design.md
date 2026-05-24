# ChatGPT Question Navigator — 完整设计文档

> 日期：2026-05-24
> 状态：修订版 v2

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
│   │   ├── messageScanner.ts  # DOM 扫描 + MutationObserver + 滚动采集 + mounted element map
│   │   ├── jumpController.ts  # 直接跳转 + 渐进式跳转 + cancellation token
│   │   ├── cacheStore.ts      # chrome.storage.local 读写 + 缓存合并逻辑
│   │   └── urlWatcher.ts      # URL 变化监听（SPA 路由）+ temp cache migration
│   │
│   ├── ui/
│   │   ├── Sidebar.tsx        # 主侧栏组件
│   │   ├── ShadowRootApp.tsx  # WXT createShadowRootUi 容器 + Preact 挂载
│   │   ├── MessageItem.tsx    # 单条消息列表项
│   │   ├── SearchBox.tsx      # 搜索框组件
│   │   ├── JumpToast.tsx      # 跳转状态/失败提示
│   │   └── styles.css         # 侧栏样式（融入 ChatGPT 风格）
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
  ├── ScrollDriver (依赖 DomAdapter.findScrollContainer)
  ├── CacheStore (无依赖，存储操作)
  ├── UrlWatcher (依赖 DomAdapter 提取 conversationId)
  ├── MessageScanner (依赖 DomAdapter + CacheStore + ScrollDriver)
  ├── JumpController (依赖 MessageScanner + CacheStore + ScrollDriver)
  └── ShadowRootApp (依赖 CacheStore + JumpController)
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
  // 使用 WXT 内置 Shadow DOM UI 创建方案，开发期 open mode 可调试
  // cssInjectionMode 由各 content script 的 createShadowRootUi 调用自行配置
});
```

不请求 `tabs`、`activeTab`、`<all_urls>` 等多余权限。

## 4. 数据层

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
  occurrenceIndex: number;      // 同一 textHash 在同一 conversationId 下的出现序号（0-based）
  firstSeenAt: number;          // timestamp
  lastSeenAt: number;
  lastKnownScrollTop: number;
  lastKnownScrollRatio: number;
  orderKey: number;             // 可变排序字段，当前会话中的大致位置
  // 注意：fullText 不在默认存储中，后续可选扩展
}

// localMessageId 生成规则（不包含 orderKey）：
// 如果 DOM 节点存在 data-id / id 等标识 → observedDomMessageId
// 否则 → `${conversationId}::${textHash}::${occurrenceIndex}`
// observedDomMessageId 优先用于去重和稳定标识

interface ConversationCache {
  conversationId: string;      // 真实 ID 或 "temp:{timestamp}"
  updatedAt: number;
  messages: CachedUserMessage[];
}
```

### 运行期状态类型（不持久化）

```typescript
// === 仅存在于内存的运行期状态 ===

interface RuntimeState {
  // 当前 DOM 中挂载的用户消息 → 其 HTMLElement 引用
  // 由 messageScanner 维护，不写入 storage
  elementById: Map<string, HTMLElement>;    // localMessageId → HTMLElement

  // 当前挂载的 localMessageId 集合（方便快速查询）
  mountedIds: Set<string>;

  // 当前视口中最靠近顶部的用户消息
  activeMessageId: string | null;
}

// messageScanner.rescan() 返回值
interface ScanResult {
  mountedIds: Set<string>;
  activeMessageId: string | null;
  visibleRange: {
    minOrderKey: number;
    maxOrderKey: number;
  } | null;  // null 表示当前视口无已识别用户消息
  newOrUpdated: CachedUserMessage[];  // 本次扫描发现的新消息或有更新的消息
}
```

### UI 状态类型

```typescript
type JumpState =
  | { status: 'idle' }
  | { status: 'jumping'; targetId: string; attempt: number }
  | { status: 'failed'; targetId: string; reason: string };

interface SidebarState {
  conversationId: string | null;
  messages: CachedUserMessage[];
  mountedIds: Set<string>;         // 从 RuntimeState 同步
  activeMessageId: string | null;  // 从 RuntimeState 同步
  jumpState: JumpState;
  searchQuery: string;
  collapsed: boolean;
}
```

### cacheStore 接口

```typescript
interface CacheStore {
  // 存储操作
  loadConversation(id: string): Promise<ConversationCache | null>;
  saveConversation(cache: ConversationCache): Promise<void>;
  mergeMessages(id: string, newMessages: CachedUserMessage[]): Promise<void>;
  clearConversation(id: string): Promise<void>;
  clearAll(): Promise<void>;

  // temp cache migration：真实 conversationId 出现后迁移
  migrateTempCache(tempId: string, realId: string): Promise<void>;

  // 响应式
  subscribe(listener: () => void): () => void;
  getSnapshot(): SidebarState;
}
```

### cacheStore 职责

1. **读写 chrome.storage.local** — 按 `conv:{conversationId}` 为 key 存储 `ConversationCache`
2. **缓存合并** — 相同 `localMessageId` 更新 lastSeenAt/scroll 信息，新消息追加
3. **变更通知** — subscribe 机制，Preact 组件通过此机制响应变化
4. **批量保存** — debounce 2s 避免频繁写入
5. **存储容量控制** — 单条消息 textForSearch 截断到 2000 chars，preview 单独保存（80-150 chars）。不存全文，减少 storage 占用
6. **清理策略** — 保留最近 100 个会话，提供 clear current / clear all
7. **temp cache migration** — 新建对话时用 `"temp:{timestamp}"` 作为临时 ID，当 URL 中出现真实 conversationId 后，将临时缓存迁移到真实 ID

### temp cache migration 流程

```
用户新建对话 → URL 为 /（无 ID）→ 创建 temp:{timestamp} 缓存
    ↓
用户发送消息 → DOM 扫描采集 → 写入 temp 缓存
    ↓
URL 变为 /c/{realId} → urlWatcher 检测到变化
    ↓
cacheStore.migrateTempCache(tempId, realId)
  - 读取 temp 缓存
  - 更新所有消息的 conversationId 和 localMessageId
  - 以 realId 写入新缓存
  - 删除 temp 缓存
    ↓
messageScanner.rescan() → 用新 ID 重新映射
```

### 数据流

```
DOM 扫描 → messageScanner.rescan() → ScanResult
              ↓
         cacheStore.mergeMessages(newOrUpdated)
              ↓
         subscribe 通知 + 更新 mountedIds/activeMessageId
              ↓
         Preact Sidebar 重渲染
```

```
URL 变化 → urlWatcher
             ↓
         如果是 temp → real 的迁移 → cacheStore.migrateTempCache()
             ↓
         cacheStore.loadConversation(newId)
             ↓
         messageScanner.rescan()
```

## 5. DOM 扫描与消息采集

### domAdapter — 选择器集中管理

domAdapter 只负责 DOM 查询和文本提取，不负责消息 ID 查找（该能力由 messageScanner 的 element map 提供）。

```typescript
const SELECTORS = {
  userMessage: '[data-message-author-role="user"]',
  userMessageFallback: '.text-base .whitespace-pre-wrap',
  messageText: '.whitespace-pre-wrap, .message-body, [data-message-author-role] > div',
  excludeButtons: 'button, [role="button"], .copy-button, .edit-button',
  scrollContainer: 'main .overflow-y-auto, [class*="react-scroll-to-bottom"]',
} as const;

interface DomAdapter {
  findUserMessages(): HTMLElement[];
  extractText(el: HTMLElement): string;
  extractConversationId(): string | null;  // 从 URL /c/{id}
  findScrollContainer(): HTMLElement | null;
  isElementInViewport(el: HTMLElement): boolean;

  // 从 DOM 元素提取 observedDomMessageId（如 data-id 属性等）
  // 返回 null 表示 DOM 元素无可用标识
  extractObservedId(el: HTMLElement): string | null;
}
```

**选择器回退策略**：
1. 优先 `data-message-author-role="user"`
2. 回退到语义结构匹配
3. 全部失败时静默降级，不报错不崩溃

### scrollDriver — 滚动容器抽象层

统一封装滚动操作，屏蔽 ChatGPT 可能使用的不同滚动容器。

```typescript
interface ScrollDriver {
  // 初始化：检测并绑定实际滚动容器
  init(): void;

  // 读取
  getScrollTop(): number;
  getScrollHeight(): number;
  getScrollRatio(): number;       // scrollTop / (scrollHeight - clientHeight)
  getContainer(): HTMLElement | Window;

  // 程序化滚动（跳转用）
  scrollTo(options: ScrollToOptions): void;
  scrollBy(deltaY: number): void;

  // 监听
  onScroll(callback: () => void): void;          // 所有滚动（程序化 + 用户）
  onUserScroll(callback: () => void): () => void; // 仅用户手动滚动

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
程序化滚动：scrollDriver.scrollBy() / scrollTo() 设置标志 isProgrammatic = true
             scroll 事件回调中检查该标志 → 不触发 onUserScroll
             setTimeout 后重置标志

用户手动滚动：通过 wheel / touchstart / keydown(pageUp/pageDown/space/arrow) / click 等事件检测
              这些事件直接触发 onUserScroll 回调
              → 用于取消当前跳转任务
```

### messageScanner — 采集引擎

```typescript
interface MessageScanner {
  start(): void;
  stop(): void;

  // 核心：扫描 DOM 并返回结构化结果
  rescan(): Promise<ScanResult>;

  // 运行期 element map 查询
  getElementByLocalId(localId: string): HTMLElement | undefined;
  getMountedIds(): Set<string>;

  // 更新单条消息的 scroll metadata
  updateScrollMeta(localId: string, scrollTop: number, scrollRatio: number): void;
}
```

**内部机制**：
1. **MutationObserver** — 监听 DOM 变化，debounce 500ms 后触发 `rescan()`
2. **滚动采集** — throttle 300ms，通过 scrollDriver.onScroll 触发，扫描可见区域附近的消息并更新 scroll metadata
3. **IntersectionObserver** — 追踪当前视口内用户消息，更新 activeMessageId
4. **去重** — 通过 textHash + occurrenceIndex + observedDomMessageId 判断

**rescan() 流程**：
1. `domAdapter.findUserMessages()` 获取所有用户消息节点
2. 对每个节点：提取文本 → 计算 hash → 提取 observedDomMessageId → 确定 occurrenceIndex → 生成 localMessageId
3. 更新 `elementById` Map 和 `mountedIds` Set
4. 与 cacheStore 中已有数据比较，生成 `newOrUpdated` 列表
5. 返回 `ScanResult`

**localMessageId 生成规则**：
```
if (observedDomMessageId) {
  localMessageId = `${conversationId}::dom::${observedDomMessageId}`;
} else {
  localMessageId = `${conversationId}::hash::${textHash}::${occurrenceIndex}`;
}
```

occurrenceIndex 在同一 conversationId + textHash 下递增。每次 rescan 时通过当前 DOM 中已挂载的消息顺序重新计算。

**IntersectionObserver 追踪**：观察所有已知用户消息节点，视口中最靠近顶部的为 `activeMessageId`。

**滚动采集**：滚动时通过 scrollDriver 获取 scrollTop/scrollRatio，更新每个可见消息的 `lastKnownScrollTop` 和 `lastKnownScrollRatio`。

### urlWatcher — SPA 路由监听

```typescript
interface UrlWatcher {
  start(): void;
  stop(): void;
  onConversationChange(callback: (id: string | null, previousId: string | null) => void): void;
}
```

**监听方式**：
1. history.pushState / replaceState 代理
2. popstate 事件
3. 回退：setInterval 1s 轮询 location.href

从 URL 提取 conversationId：`/c/{id}`。

**temp cache 处理**：
- 无法解析 ID 时创建 `"temp:{timestamp}"`
- 当真实 ID 出现时，通过 callback 通知 content.ts 触发 migration
- callback 参数包含 `previousId`，用于判断是否需要从 temp 迁移

## 6. 导航与跳转

### jumpController

jumpController 依赖 messageScanner.getElementByLocalId() 获取 DOM 元素（而非 domAdapter）。

#### 直接跳转（目标在 DOM 中）

```typescript
async function jumpToMounted(target: CachedUserMessage): Promise<void> {
  const el = messageScanner.getElementByLocalId(target.localMessageId);
  if (!el) return false;

  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  highlightMessage(el);  // 1.5 秒临时高亮
  return true;
}
```

#### 渐进式跳转（目标不在 DOM 中）

**混合策略**：
1. ratio seed jump（scrollRatio 作为初始粗定位）
2. order-guided adaptive stepping（基于 orderKey 判断方向，自适应步长滚动）
3. 每步调用 messageScanner.rescan() 获取 ScanResult，基于 ScanResult 判断 mountedIds 和 visibleRange
4. 目标消息一旦出现在 mountedIds 中，立即 scrollIntoView 精确定位
5. 支持 cancellation token、最大尝试次数（30次）、失败 toast

**不实现严格二分搜索**：ChatGPT 虚拟列表下 scrollHeight 和 DOM 挂载不稳定，严格二分收益不高。

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

    // 检查目标是否已挂载（通过 messageScanner element map）
    const el = messageScanner.getElementByLocalId(target.localMessageId);
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      highlightMessage(el);
      return;  // 成功
    }

    // 执行扫描获取当前状态
    const result: ScanResult = await messageScanner.rescan();

    // 再次检查（rescan 后可能有新挂载）
    if (result.mountedIds.has(target.localMessageId)) {
      const found = messageScanner.getElementByLocalId(target.localMessageId);
      if (found) {
        found.scrollIntoView({ block: 'center', behavior: 'smooth' });
        highlightMessage(found);
        return;
      }
    }

    // 第一次尝试使用 scrollRatio 快速定位
    if (attempt === 0 && target.lastKnownScrollRatio > 0) {
      scrollDriver.scrollToRatio(target.lastKnownScrollRatio);
    } else {
      // 基于 orderKey 和 visibleRange 判断方向并滚动
      const direction = decideDirection(target, result.visibleRange);
      scrollOneChunk(direction, attempt);
    }

    // 等待 DOM 稳定
    await waitForDomSettled(500);
  }

  // 失败：显示 toast
  showJumpFailedToast(target);
}
```

**辅助函数**：

| 函数 | 职责 |
|------|------|
| `decideDirection(target, visibleRange)` | 比较目标 orderKey 和可见范围，返回 'up' / 'down' |
| `scrollOneChunk(direction, attempt)` | 通过 scrollDriver.scrollBy() 自适应步长滚动（前几次步长大，后面减小） |
| `waitForDomSettled(ms)` | 等待 DOM 变化稳定（MutationObserver quiet period） |
| `highlightMessage(el)` | 添加 1.5 秒高亮动画（ChatGPT 绿 #10a37f） |

**取消机制**：
- 用户手动滚动（通过 scrollDriver.onUserScroll 检测 wheel/touch/key 事件）→ 取消当前跳转
- 用户点击另一个目标 → 取消当前，开始新跳转
- 用户按 Esc → 取消当前跳转
- 新跳转请求自动取消前一个
- **不监听 scroll 事件来取消**（因为程序化滚动也会触发 scroll 事件）

## 7. 侧栏 UI

### Shadow DOM 容器

使用 WXT 内置的 `createShadowRootUi` API，开发期使用 open mode 方便调试：

```typescript
// src/ui/ShadowRootApp.tsx
import { createShadowRootUi } from 'wxt/client';

export function createShadowRootApp(context: ContentScriptContext, deps: AppDeps) {
  const ui = createShadowRootUi(context, {
    name: 'chatgpt-navigator',
    position: 'overlay',
    anchor: 'body',
    onMount(container) {
      // container 是 shadowRoot 内的容器
      // 挂载 Preact app
      render(<Sidebar deps={deps} />, container);
    },
    onRemove(container) {
      // 清理 Preact 渲染
    },
  });

  // 通过 wxt.config.ts 中的 cssInjectionMode 或此处的配置
  // 确保 styles.css 被注入到 shadowRoot 内
}
```

**定位**：宿主 div 通过 WXT overlay 定位在页面右侧，不遮挡 ChatGPT 原有滚动条和布局。

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
- 通过 props 接收 cacheStore 和 jumpController
- 使用 `cacheStore.subscribe()` 监听变更，用 `useReducer` 管理本地状态
- 管理 collapsed 状态
- 宽度：展开 280px / 折叠 40px（浮动按钮）
- 过渡：`transition: width 0.2s ease`
- 列表容器：`overflow-y: auto; max-height: calc(100vh - header - searchbox)`

**MessageItem.tsx** — 单条消息
- 序号（Q1, Q2...）+ preview 摘要
- 状态标记：
  - 活跃（高亮边框）— 当前视口附近
  - 已挂载（绿色实心点 ●）— 在 DOM 中，通过 `mountedIds.has(id)` 判断
  - 仅缓存（灰色空心点 ○）— 不在 DOM 中
- hover：显示 textForSearch 中的内容作为 tooltip（最大高度 200px）
- 点击：触发 jumpController
- 跳转中：显示 "Jumping..." + 动画
- 使用 `preact/compat` 的 `memo` 包裹避免不必要的重渲染

**SearchBox.tsx** — 搜索
- debounce 300ms 搜索 textForSearch 字段
- 高亮匹配关键词
- 保留原始序号，过滤显示

**JumpToast.tsx** — 跳转状态提示
- 底部显示
- 跳转中：进度动画 + "Jumping to Q{n}..."
- 失败："Target not mounted. Try scrolling near this area."
- 可关闭

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

- 使用 `import { memo } from 'preact/compat'` 包裹 MessageItem 等纯展示组件
- 使用 `useMemo` 缓存过滤后的消息列表
- 使用 `useCallback` 缓存事件处理器
- 不使用 `React.memo`（那是 React 的 API，Preact 项目中使用 preact/compat 的 memo）

## 8. Content Script 入口

```typescript
// src/entrypoints/content.ts
export default defineContentScript({
  matches: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
  cssInjectionMode: 'ui',

  main(ctx) {
    const domAdapter = new DomAdapter();
    const scrollDriver = new ScrollDriver(domAdapter);
    const cacheStore = new CacheStore();
    const urlWatcher = new UrlWatcher();
    const scanner = new MessageScanner(domAdapter, cacheStore, scrollDriver);
    const jumpController = new JumpController(scanner, cacheStore, scrollDriver);

    scrollDriver.init();
    scanner.start();
    urlWatcher.start();

    urlWatcher.onConversationChange(async (id, previousId) => {
      if (!id) return;

      // temp → real migration
      if (previousId?.startsWith('temp:') && !id.startsWith('temp:')) {
        await cacheStore.migrateTempCache(previousId, id);
      }

      await cacheStore.loadConversation(id);
      await scanner.rescan();
    });

    // 用户手动滚动取消跳转
    scrollDriver.onUserScroll(() => {
      jumpController.cancelCurrent();
    });

    createShadowRootApp(ctx, { cacheStore, jumpController });
  }
});
```

## 9. 错误处理

| 场景 | 处理方式 |
|------|----------|
| DOM 选择器失效 | 静默降级，不崩溃，侧栏显示"检测中..." |
| storage 写入失败 | console.warn + 重试 1 次 |
| 跳转超时 | 显示失败 toast，用户可手动滚动后重试 |
| ConversationId 解析失败 | 使用临时 key `"temp:{timestamp}"`，后续迁移 |
| ChatGPT 页面未加载完成 | MutationObserver 自然等待 DOM 就绪 |
| Shadow DOM 注入失败 | console.error + 不影响页面 |
| scrollContainer 找不到 | 回退到 document.scrollingElement 或 window |

## 10. 性能防护

- **DOM 扫描**：MutationObserver 回调 debounce 500ms
- **滚动采集**：throttle 300ms，仅扫描可见区域附近
- **storage 写入**：debounce 2000ms 批量保存
- **Preact 渲染**：preact/compat 的 memo + useMemo + useCallback
- **搜索**：debounce 300ms
- **存储容量**：textForSearch 截断到 2000 chars，避免单条消息占用过多 storage

## 11. 清理

页面关闭 / 导航离开 ChatGPT 时：
- 停止 MutationObserver
- 停止 IntersectionObserver
- scrollDriver.destroy()
- 移除 URL 监听
- 保存最后的缓存数据
- WXT 自动清理 createShadowRootUi 创建的 UI

## 12. 实施阶段

### Phase 1-2：基础 + 缓存 + 侧栏

- 项目初始化（WXT + TypeScript + Preact）
- content script 注入
- domAdapter — DOM 选择器 + 消息节点识别 + 文本提取
- scrollDriver — 滚动容器抽象
- urlWatcher — SPA 路由监听 + temp cache migration
- messageScanner — DOM 扫描 + MutationObserver + rescan() → ScanResult
- cacheStore — chrome.storage.local 读写 + 缓存合并
- mounted runtime state（elementById + mountedIds）
- Shadow DOM 侧栏 — WXT createShadowRootUi
- 侧栏展示已采集消息列表（含 mounted 状态标记）

### Phase 3：直接跳转 + 搜索

- 直接跳转（目标在 mountedIds 中 → scrollIntoView）
- 目标高亮（1.5 秒临时高亮）
- IntersectionObserver 追踪 activeMessageId
- 侧栏 active 高亮
- 搜索框

### Phase 4：渐进式跳转

在 ScanResult / ScrollDriver / cancellation token 都稳定之后：
- 渐进式跳转算法（ratio seed + order-guided adaptive stepping）
- 跳转取消（wheel/touch/key 事件触发，非 scroll 事件）
- 最大尝试次数 + 失败 toast
- JumpToast 组件

### Phase 5：收尾

- README + 隐私说明
- 权限最小化确认
- Chrome/Edge 加载说明
- 打包测试

## 13. 已知限制

- 插件无法读取从未在 DOM 中出现过的历史消息
- 第一次打开超长对话时，远处问题需要用户滚动经过后才会被缓存
- ChatGPT 页面结构变化可能导致 DOM 识别失效
- 渐进式跳转依赖缓存过的 scroll metadata，不能保证 100% 精确
- chrome.storage.local 默认 QUOTA_BYTES 为 10MB（可申请 unlimitedStorage 扩展）

## 14. 后续路线

- 更强的 DOM adapter（更多回退选择器）
- compact rail/minimap 模式
- 导出/导入缓存
- 自定义快捷键
- bracket + binary refinement 跳转优化
- fullText 可选存储（用于完整历史回看）
- 申请 unlimitedStorage 权限（如果数据量增大）
