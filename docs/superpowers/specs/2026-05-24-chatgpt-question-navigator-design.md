# ChatGPT Question Navigator — 完整设计文档

> 日期：2026-05-24
> 状态：已批准

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
| 框架 | WXT | Manifest V3 开发框架，开箱即用 |
| 语言 | TypeScript ^5.x | 类型安全 |
| UI 框架 | Preact ^10.x | 轻量（~3KB），适合扩展场景 |
| 存储方案 | chrome.storage.local | API 简单，WXT 封装好，自用数据量可控 |
| 架构 | 经典分层架构 | 调试友好，适合项目规模 |
| 跳转策略 | 混合（ratio seed + order-guided adaptive stepping） | 实用稳健，不依赖严格二分 |
| 侧栏风格 | 融入 ChatGPT 风格 | 手动定义 CSS 变量匹配 ChatGPT 主题 |
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
│   │   ├── messageScanner.ts  # DOM 扫描 + MutationObserver + 滚动采集
│   │   ├── jumpController.ts  # 直接跳转 + 渐进式跳转 + cancellation token
│   │   ├── cacheStore.ts      # chrome.storage.local 读写 + 缓存合并逻辑
│   │   └── urlWatcher.ts      # URL 变化监听（SPA 路由）
│   │
│   ├── ui/
│   │   ├── Sidebar.tsx        # 主侧栏组件
│   │   ├── ShadowRootApp.tsx  # Shadow DOM 容器 + Preact 挂载
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
  ├── CacheStore (无依赖，存储操作)
  ├── UrlWatcher (依赖 DomAdapter 提取 conversationId)
  ├── MessageScanner (依赖 DomAdapter + CacheStore)
  ├── JumpController (依赖 DomAdapter + MessageScanner + CacheStore)
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

### 核心类型

```typescript
interface CachedUserMessage {
  conversationId: string;
  localMessageId: string;     // conversationId + textHash + approximateOrder 的组合
  role: 'user';
  text: string;
  preview: string;             // 前 80-150 字
  textHash: string;            // SHA-256 前 8 位
  firstSeenAt: number;         // timestamp
  lastSeenAt: number;
  lastKnownScrollTop: number;
  lastKnownScrollRatio: number;
  approximateOrder: number;    // 在会话中的大致位置
  mounted: boolean;            // 当前是否在 DOM 中
}

interface ConversationCache {
  conversationId: string;
  updatedAt: number;
  messages: CachedUserMessage[];
}

type JumpState =
  | { status: 'idle' }
  | { status: 'jumping'; targetId: string; attempt: number }
  | { status: 'failed'; targetId: string; reason: string };

interface SidebarState {
  conversationId: string | null;
  messages: CachedUserMessage[];
  activeMessageId: string | null;
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
5. **清理策略** — 保留最近 100 个会话，提供 clear current / clear all

### 数据流

```
DOM 扫描 → messageScanner → cacheStore.mergeMessages()
                              ↓
                         subscribe 通知
                              ↓
                     Preact Sidebar 重渲染
```

```
URL 变化 → urlWatcher → cacheStore.loadConversation()
                           ↓
                      subscribe 通知
                           ↓
                    Preact Sidebar 重渲染
```

## 5. DOM 扫描与消息采集

### domAdapter — 选择器集中管理

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
  extractConversationId(): string | null;
  findScrollContainer(): HTMLElement | null;
  findMessageByLocalId(localId: string): HTMLElement | null;
  isElementInViewport(el: HTMLElement): boolean;
}
```

**选择器回退策略**：
1. 优先 `data-message-author-role="user"`
2. 回退到语义结构匹配
3. 全部失败时静默降级，不报错不崩溃

### messageScanner — 采集引擎

```typescript
interface MessageScanner {
  start(): void;
  stop(): void;
  rescan(): void;
}
```

**内部机制**：
1. **MutationObserver** — 监听 DOM 变化，debounce 500ms 后触发扫描
2. **滚动监听** — throttle 300ms，扫描可见区域附近的消息
3. **IntersectionObserver** — 追踪当前视口内用户消息，更新 activeMessageId
4. **去重** — 通过 textHash + approximateOrder 判断

**扫描流程**：
1. `findUserMessages()` 获取所有用户消息节点
2. 提取文本、计算 hash、生成 `localMessageId`
3. 维护 `Map<string, { el: HTMLElement; cache: CachedUserMessage }>` 映射
4. 新消息/更新消息 → `cacheStore.mergeMessages()`
5. 更新 `mounted` 状态

**IntersectionObserver 追踪**：观察所有已知用户消息节点，视口中最靠近顶部的为 `activeMessageId`。

**滚动采集**：滚动时更新每个可见消息的 `lastKnownScrollTop` 和 `lastKnownScrollRatio`。

### urlWatcher — SPA 路由监听

```typescript
interface UrlWatcher {
  start(): void;
  stop(): void;
  onConversationChange(callback: (id: string | null) => void): void;
}
```

**监听方式**：
1. history.pushState / replaceState 代理
2. popstate 事件
3. 回退：setInterval 1s 轮询 location.href

从 URL 提取 conversationId：`/c/{id}`。无法解析时使用 `"temp:{timestamp}"`。

## 6. 导航与跳转

### jumpController

#### 直接跳转（目标在 DOM 中）

```typescript
async function jumpToMounted(target: CachedUserMessage): Promise<void> {
  const el = domAdapter.findMessageByLocalId(target.localMessageId);
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  highlightMessage(el);  // 1.5 秒临时高亮
  updateActiveMessage(target.localMessageId);
}
```

#### 渐进式跳转（目标不在 DOM 中）

**混合策略**：
1. ratio seed jump（scrollRatio 作为初始粗定位）
2. order-guided adaptive stepping（基于 approximateOrder 判断方向，自适应步长滚动）
3. 每步重新扫描 DOM + 校正方向
4. 目标消息一旦挂载，立即 scrollIntoView 精确定位
5. 支持 cancellation token、最大尝试次数（30次）、失败 toast

**不实现严格二分搜索**：ChatGPT 虚拟列表下 scrollHeight 和 DOM 挂载不稳定，严格二分收益不高。

```typescript
interface JumpToken {
  cancelled: boolean;
  cancel: () => void;
}

async function jumpToCachedMessage(
  target: CachedUserMessage,
  token: JumpToken
): Promise<void> {
  const MAX_ATTEMPTS = 30;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (token.cancelled) return;

    // 检查目标是否已挂载
    const direct = domAdapter.findMessageByLocalId(target.localMessageId);
    if (direct) {
      direct.scrollIntoView({ block: 'center', behavior: 'smooth' });
      highlightMessage(direct);
      return;
    }

    const visibleRange = getVisibleUserMessageRange();

    // 第一次尝试使用 scrollRatio 快速定位
    if (attempt === 0 && target.lastKnownScrollRatio > 0) {
      scrollToApproximateRatio(target.lastKnownScrollRatio);
    } else {
      const direction = decideDirection(target, visibleRange);
      scrollOneChunk(direction, attempt);
    }

    await waitForDomSettled(500);
    await messageScanner.rescan();
  }

  showJumpFailedToast(target);
}
```

**辅助函数**：

| 函数 | 职责 |
|------|------|
| `getVisibleUserMessageRange()` | 获取当前视口内消息的 approximateOrder 范围 |
| `decideDirection(target, range)` | 比较目标 order 和可见范围，返回 'up' / 'down' |
| `scrollOneChunk(direction, attempt)` | 自适应步长滚动（前几次步长大，后面减小） |
| `waitForDomSettled(ms)` | 等待 DOM 变化稳定（MutationObserver quiet period） |
| `highlightMessage(el)` | 添加 1.5 秒高亮动画（ChatGPT 绿 #10a37f） |
| `createJumpToken()` | 创建可取消令牌 |

**取消机制**：
- 用户手动滚动 → 取消当前跳转
- 用户点击另一个目标 → 取消当前，开始新跳转
- 用户按 Esc → 取消当前跳转
- 新跳转请求自动取消前一个

## 7. 侧栏 UI

### Shadow DOM 容器

- 创建宿主 div，`position: fixed; right: 0; top: 0; height: 100vh; z-index: 9999`
- `attachShadow({ mode: 'closed' })`
- 在 shadowRoot 内注入样式 + 挂载 Preact `<Sidebar />`
- 不影响 ChatGPT 页面样式，也不受页面样式影响

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
│  Q3  帮我写一个...        │  ← MessageItem (mounted)
│  Q4  [cached] 关于...    │  ← MessageItem (仅缓存)
│  Q5  [cached] 什么是...  │  ← MessageItem
│  ...                     │
│  ─────────────────────── │
│  [Jumping to Q4...     ] │  ← JumpToast
└──────────────────────────┘
```

### 各组件

**Sidebar.tsx** — 主容器
- 接收 `cacheStore.getSnapshot()` 作为 props
- 使用 `cacheStore.subscribe()` 监听变更
- 管理 collapsed 状态
- 宽度：展开 280px / 折叠 40px（浮动按钮）
- 过渡：`transition: width 0.2s ease`

**MessageItem.tsx** — 单条消息
- 序号（Q1, Q2...）+ preview 摘要
- 状态标记：活跃（高亮边框）、已挂载（绿色点）、仅缓存（灰色点）
- hover：完整问题预览 tooltip（最大高度 200px）
- 点击：触发 jumpController
- 跳转中：显示 "Jumping..." + 动画

**SearchBox.tsx** — 搜索
- debounce 300ms 搜索已缓存消息
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

## 8. Content Script 入口

```typescript
// src/entrypoints/content.ts
export default defineContentScript({
  matches: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
  main() {
    const domAdapter = new DomAdapter();
    const cacheStore = new CacheStore();
    const urlWatcher = new UrlWatcher();
    const scanner = new MessageScanner(domAdapter, cacheStore);

    urlWatcher.onConversationChange(async (id) => {
      await cacheStore.loadConversation(id);
      scanner.rescan();
    });

    scanner.start();
    urlWatcher.start();
    createShadowRootApp(cacheStore);
  }
});
```

## 9. 错误处理

| 场景 | 处理方式 |
|------|----------|
| DOM 选择器失效 | 静默降级，不崩溃，侧栏显示"检测中..." |
| storage 写入失败 | console.warn + 重试 1 次 |
| 跳转超时 | 显示失败 toast，用户可手动滚动后重试 |
| ConversationId 解析失败 | 使用临时 key `"temp:{timestamp}"` |
| ChatGPT 页面未加载完成 | MutationObserver 自然等待 DOM 就绪 |
| Shadow DOM 注入失败 | console.error + 不影响页面 |

## 10. 性能防护

- **DOM 扫描**：MutationObserver 回调 debounce 500ms
- **滚动事件**：throttle 300ms
- **storage 写入**：debounce 2000ms 批量保存
- **Preact 渲染**：React.memo + useMemo 避免 re-render
- **搜索**：debounce 300ms

## 11. 清理

页面关闭 / 导航离开 ChatGPT 时：
- 停止 MutationObserver
- 停止 IntersectionObserver
- 移除滚动监听
- 移除 URL 监听
- 保存最后的缓存数据
- 移除 Shadow DOM

## 12. 已知限制

- 插件无法读取从未在 DOM 中出现过的历史消息
- 第一次打开超长对话时，远处问题需要用户滚动经过后才会被缓存
- ChatGPT 页面结构变化可能导致 DOM 识别失效
- 渐进式跳转依赖缓存过的 scroll metadata，不能保证 100% 精确

## 13. 后续路线

- 更强的 DOM adapter（更多回退选择器）
- compact rail/minimap 模式
- 导出/导入缓存
- 自定义快捷键
- bracket + binary refinement 跳转优化
