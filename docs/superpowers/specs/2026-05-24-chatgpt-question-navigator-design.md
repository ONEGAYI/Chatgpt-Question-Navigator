# ChatGPT Question Navigator — 完整设计文档

> 日期：2026-05-24
> 状态：修订版 v3

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
│   │   ├── cacheStore.ts      # chrome.storage.local 读写 + 缓存合并逻辑 + LRU 容量管理
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
  occurrenceIndex: number;      // 同一 conversationId + textHash 下由 cacheStore 稳定分配的序号
  firstSeenAt: number;          // timestamp
  lastSeenAt: number;
  lastKnownScrollTop: number;
  lastKnownScrollRatio: number;
  orderKey: number;             // 可变排序字段，当前会话中的大致位置
  // 注意：fullText 不在默认存储中，后续可选扩展
}

// localMessageId 生成规则（不包含 orderKey）：
//
// 规则 1：如果 DOM 节点存在 observedDomMessageId（data-id / id 等标识）
//   localMessageId = `${conversationId}::dom::${observedDomMessageId}`
//
// 规则 2：无 observedDomMessageId 时
//   localMessageId = `${conversationId}::hash::${textHash}::${occurrenceIndex}`
//
// occurrenceIndex 的稳定分配（不随 rescan 重算）：
//   - 由 cacheStore 在 mergeMessages() 时负责分配和持久化
//   - 对于同一 conversationId + textHash，cacheStore 维护一个计数器
//   - 新消息如果无 observedDomMessageId，分配下一个 occurrenceIndex
//   - 已有 localMessageId 的消息保持原 occurrenceIndex 不变
//   - 这样即使 DOM 挂载顺序变化，同一消息始终获得相同的 localMessageId

interface ConversationCache {
  conversationId: string;      // 真实 ID 或 "temp:{timestamp}"
  updatedAt: number;
  messages: CachedUserMessage[];
}

// === Storage 容量管理元数据 ===

interface StorageMeta {
  conversationIds: string[];    // 按 updatedAt 降序排列（最近使用的在前）
  totalBytes: number;           // 当前已用字节数
  lastCleanupAt: number;        // 上次清理时间
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

  // 当前活跃的用户消息 ID
  // 规则：视口内最靠近顶部的 user message
  // 如果视口内无 user message（长 assistant 回答场景），
  // 则取视口顶部之前最近的一条 user message
  activeMessageId: string | null;
}

// messageScanner.rescan() 返回值
interface ScanResult {
  mountedIds: Set<string>;
  activeMessageId: string | null;
  visibleRange: {
    minOrderKey: number;
    maxOrderKey: number;
  } | null;  // null 表示当前视口及视口前均无已识别用户消息
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

1. **读写 chrome.storage.local** — 按 `conv:{conversationId}` 为 key 存储 `ConversationCache`；额外维护 `meta` key 存储 `StorageMeta`
2. **缓存合并** — 相同 `localMessageId` 更新 lastSeenAt/scroll 信息，新消息追加
3. **occurrenceIndex 稳定分配** — mergeMessages() 时，对同一 conversationId + textHash 的新消息分配递增的 occurrenceIndex，不随 rescan 重算。避免相同 textHash 的不同消息被误合并
4. **变更通知** — subscribe 机制，Preact 组件通过此机制响应变化
5. **批量保存** — debounce 2s 避免频繁写入
6. **存储容量控制**：
   - 单条消息 textForSearch 截断到 2000 chars，preview 单独保存（80-150 chars），不存全文
   - 每次 saveConversation 后调用 `chrome.storage.local.getBytesInUse()` 检查已用量
   - 当总用量超过阈值（如 8MB，默认 QUOTA 10MB 留 2MB 余量）时，执行 LRU 清理
   - LRU 策略：按 `StorageMeta.conversationIds` 中 updatedAt 最旧的会话开始删除，直到总量低于阈值的 80%
   - 清理后更新 StorageMeta
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
  // 主选择器（Phase 1-2 唯一启用）
  userMessage: '[data-message-author-role="user"]',

  // 后备选择器（标记 experimental，Phase 1-2 不启用，后续经验证后按需开启）
  // userMessageExperimental: '.text-base .whitespace-pre-wrap',

  messageText: '.whitespace-pre-wrap, .message-body, [data-message-author-role] > div',
  excludeButtons: 'button, [role="button"], .copy-button, .edit-button',
  scrollContainer: 'main .overflow-y-auto, [class*="react-scroll-to-bottom"]',
} as const;

interface DomAdapter {
  // 使用 SELECTORS.userMessage 扫描
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

**选择器策略**：
- Phase 1-2：仅使用 `data-message-author-role="user"`，不启用后备选择器
- 后续：如需后备选择器，需经过实际验证后标记启用，不盲目启用
- 全部失败时静默降级，不报错不崩溃

### scrollDriver — 滚动容器抽象层

统一封装滚动操作，屏蔽 ChatGPT 可能使用的不同滚动容器。

```typescript
interface ScrollDriver {
  // 初始化：检测并绑定实际滚动容器
  init(): void;

  // 读取
  getScrollTop(): number;
  getScrollHeight(): number;
  getClientHeight(): number;     // 可视区域高度
  getScrollRatio(): number;      // scrollTop / (scrollHeight - clientHeight)，clamp 到 [0, 1]
  getContainer(): HTMLElement | Window;

  // 程序化滚动
  scrollTo(options: ScrollToOptions): void;
  scrollBy(deltaY: number): void;
  scrollToRatio(ratio: number, behavior?: ScrollBehavior): void;
  // scrollToRatio 实现：
  //   const top = ratio * (this.getScrollHeight() - this.getClientHeight());
  //   this.scrollTo({ top, behavior: behavior ?? 'auto' });

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
程序化滚动：scrollDriver 的 scrollTo / scrollBy / scrollToRatio 方法
            设置内部标志 _isProgrammatic = true
            在下一个 scroll 事件中检查并重置（requestAnimationFrame 后）
            → 不触发 onUserScroll

用户手动滚动检测（仅以下事件，不使用泛化 click）：
  1. wheel 事件 — 鼠标滚轮
  2. touchstart / touchmove — 触摸屏
  3. keydown — PageUp/PageDown/Space/ArrowUp/ArrowDown/Home/End
  4. pointerdown — 仅限 ChatGPT 主滚动区域内的拖拽
     排除插件 Shadow DOM 内的 pointerdown（通过检查 event.composedPath()
     或 event.target 是否在插件 host 元素内来过滤）
  → 这些事件直接触发 onUserScroll 回调
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
4. **去重** — 通过 localMessageId（observedDomMessageId 优先，textHash + occurrenceIndex 回退）判断

**rescan() 流程**：
1. `domAdapter.findUserMessages()` 获取所有用户消息节点
2. 对每个节点：提取文本 → 计算 hash → 提取 observedDomMessageId
3. 如果有 observedDomMessageId → 直接构造 localMessageId
4. 如果无 observedDomMessageId → 使用 textHash 查询 cacheStore 获取稳定的 occurrenceIndex
5. 更新 `elementById` Map 和 `mountedIds` Set
6. 与 cacheStore 中已有数据比较，生成 `newOrUpdated` 列表
7. 返回 `ScanResult`

**localMessageId 生成规则**：
```
if (observedDomMessageId) {
  localMessageId = `${conversationId}::dom::${observedDomMessageId}`;
} else {
  // occurrenceIndex 由 cacheStore 稳定分配，不随 rescan 重算
  localMessageId = `${conversationId}::hash::${textHash}::${occurrenceIndex}`;
}
```

**occurrenceIndex 稳定分配机制**：
- messageScanner 在 rescan() 中发现新消息时，先尝试通过 observedDomMessageId 匹配已有缓存
- 如果无法匹配且 textHash 在缓存中已存在，cacheStore.mergeMessages() 负责分配下一个 occurrenceIndex
- cacheStore 内部维护 `Map<string, number>` 记录每个 `(conversationId, textHash)` 的下一个可用 index
- 这确保了即使 DOM 挂载顺序变化或消息临时消失后重新出现，同一消息始终获得相同的 occurrenceIndex 和 localMessageId

**IntersectionObserver 追踪 — activeMessageId 逻辑**：
- 观察所有已知用户消息节点
- 优先取视口内最靠近顶部的 user message 作为 activeMessageId
- **长 assistant 回答场景**：如果视口内无 user message（只有 assistant 回答），则取视口顶部之上最近的一条 user message
- 实现：记录每个被观察 user message 的 `boundingClientRect.top`，视口内取 top ≥ 0 且最小的；如果全部 top < 0，取 top 最大的（即最接近视口的上方消息）

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
async function jumpToMounted(target: CachedUserMessage): Promise<boolean> {
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
    // 使用 Number.isFinite 而非 > 0，因为 ratio=0 表示页面顶部，也是有效位置
    if (attempt === 0 && Number.isFinite(target.lastKnownScrollRatio)) {
      scrollDriver.scrollToRatio(target.lastKnownScrollRatio, 'auto');
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
- 用户手动滚动（通过 scrollDriver.onUserScroll 检测 wheel/touch/key/pointerdown 事件，排除插件 Shadow DOM 内的交互）→ 取消当前跳转
- 用户点击侧栏中另一个目标 → 取消当前，开始新跳转
- 用户按 Esc → 取消当前跳转
- 新跳转请求自动取消前一个
- **不使用泛化 click 取消**（避免误触），不监听 scroll 事件取消（程序化滚动也会触发）

## 7. 侧栏 UI

### Shadow DOM 容器

使用 WXT 官方 `createShadowRootUi` + `cssInjectionMode: 'ui'` 模式：

```typescript
// src/ui/ShadowRootApp.tsx
import type { ContentScriptContext } from 'wxt/client';
import { createShadowRootUi } from 'wxt/client';
import { render } from 'preact';
import Sidebar from './Sidebar';

export async function createShadowRootApp(
  ctx: ContentScriptContext,
  deps: AppDeps
) {
  const ui = await createShadowRootUi(ctx, {
    name: 'chatgpt-navigator',
    position: 'overlay',
    anchor: 'body',
    onMount(container: HTMLElement) {
      // container 是 shadowRoot 内的挂载容器
      // render 返回的 root 用于后续清理
      render(<Sidebar deps={deps} />, container);

      // 返回 cleanup 函数，onRemove 时 WXT 会调用
      return () => {
        render(null, container);
      };
    },
    onRemove(mounted: ReturnType<NonNullable<typeof onMount>>) {
      // mounted 即 onMount 返回的 cleanup 函数
      if (typeof mounted === 'function') {
        mounted();
      }
    },
  });

  // 触发挂载
  ui.mount();
}
```

**关键要点**：
- `cssInjectionMode: 'ui'` 在 content.ts 入口中配置，WXT 自动将 import 的 styles.css 注入到 shadowRoot 内
- `createShadowRootUi` 返回的对象需调用 `.mount()` 才实际挂载
- `onMount` 返回 cleanup 函数（或 root 引用），`onRemove` 接收该返回值执行清理
- 开发期 shadowRoot 为 open mode，可通过 DevTools 调试

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
  - 活跃（高亮边框）— 当前视口附近或上方最近
  - 已挂载（绿色实心点 ●）— 在 DOM 中，通过 `mountedIds.has(id)` 判断
  - 仅缓存（灰色空心点 ○）— 不在 DOM 中
- hover：显示 textForSearch 中的内容作为 tooltip（最大高度 200px）
- 点击：触发 jumpController
- 跳转中：显示 "Jumping..." + 动画
- 使用 `import { memo } from 'preact/compat'` 包裹避免不必要的重渲染

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
- 明确不使用 `React.memo`（React 命名空间在 Preact 项目中不存在）

## 8. Content Script 入口

```typescript
// src/entrypoints/content.ts
import './styles.css';  // WXT cssInjectionMode: 'ui' 时，import 的 CSS 自动注入 shadowRoot

export default defineContentScript({
  matches: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
  cssInjectionMode: 'ui',

  async main(ctx) {
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

    // 创建 Shadow DOM UI
    await createShadowRootApp(ctx, { cacheStore, jumpController });
  }
});
```

**WXT 官方模式要点**：
- `cssInjectionMode: 'ui'` — content.ts import 的 CSS 文件由 WXT 自动注入到 shadowRoot
- `async main(ctx)` — main 函数为 async，ctx 是 ContentScriptContext
- `await createShadowRootUi(...)` — 异步创建 UI
- `ui.mount()` — 在 createShadowRootApp 内部调用，触发实际挂载

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
| storage 容量超限 | LRU 自动清理最旧的会话 |

## 10. 性能防护

- **DOM 扫描**：MutationObserver 回调 debounce 500ms
- **滚动采集**：throttle 300ms，仅扫描可见区域附近
- **storage 写入**：debounce 2000ms 批量保存
- **storage 容量**：每次保存后 getBytesInUse 检查，超阈值触发 LRU 清理
- **Preact 渲染**：preact/compat 的 memo + useMemo + useCallback
- **搜索**：debounce 300ms
- **文本截断**：textForSearch 截断到 2000 chars，避免单条消息占用过多 storage

## 11. 清理

页面关闭 / 导航离开 ChatGPT 时：
- 停止 MutationObserver
- 停止 IntersectionObserver
- scrollDriver.destroy()
- 移除 URL 监听
- 保存最后的缓存数据
- WXT 自动清理 createShadowRootUi 创建的 UI（调用 onRemove → render(null, container)）

## 12. 实施阶段

### Phase 1-2：基础 + 缓存 + 侧栏

- 项目初始化（WXT + TypeScript + Preact）
- content script 注入（cssInjectionMode: 'ui'，import styles.css）
- domAdapter — 仅使用 `[data-message-author-role="user"]` 选择器，后备选择器标记 experimental 不启用
- scrollDriver — 滚动容器抽象（含 scrollToRatio、getClientHeight）
- urlWatcher — SPA 路由监听 + temp cache migration
- messageScanner — DOM 扫描 + MutationObserver + rescan() → ScanResult
- cacheStore — chrome.storage.local 读写 + 缓存合并 + occurrenceIndex 稳定分配 + getBytesInUse LRU 容量管理
- mounted runtime state（elementById + mountedIds）
- Shadow DOM 侧栏 — WXT createShadowRootUi（async main + await + ui.mount()）
- 侧栏展示已采集消息列表（含 mounted 状态标记）

### Phase 3：直接跳转 + 搜索

- 直接跳转（目标在 mountedIds 中 → scrollIntoView），返回 Promise<boolean>
- 目标高亮（1.5 秒临时高亮）
- IntersectionObserver 追踪 activeMessageId（含长 assistant 回答场景：视口上方最近 user message）
- 侧栏 active 高亮
- 搜索框

### Phase 4：渐进式跳转

在 ScanResult / ScrollDriver / cancellation token 都稳定之后：
- 渐进式跳转算法（ratio seed：Number.isFinite 判断 + order-guided adaptive stepping）
- 跳转取消（wheel/touch/key/pointerdown 事件，排除插件 Shadow DOM 内交互）
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
- chrome.storage.local 默认 QUOTA_BYTES 为 10MB（通过 LRU 管理控制在 8MB 以内）

## 14. 后续路线

- 验证并启用 experimental 后备选择器
- compact rail/minimap 模式
- 导出/导入缓存
- 自定义快捷键
- bracket + binary refinement 跳转优化
- fullText 可选存储（用于完整历史回看）
- 申请 unlimitedStorage 权限（如果 LRU 管理不够用）
