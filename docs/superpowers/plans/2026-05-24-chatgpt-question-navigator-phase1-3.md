# ChatGPT Question Navigator Phase 1-3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建 ChatGPT 长对话导航扩展的 Phase 1-3：完成 WXT/Preact 基础工程、DOM 用户消息采集、本地缓存、右侧 Shadow DOM 侧栏、当前消息高亮、直接跳转、搜索与 hover 预览。

**Architecture:** 采用 WXT Manifest V3 content script 作为入口，按 `content`、`ui`、`shared` 三层拆分。DOM 扫描、滚动抽象、缓存解析、运行期状态、URL 监听和跳转控制相互隔离，UI 只通过 `runtimeStore` 订阅状态并调用 `jumpController`。

**Tech Stack:** WXT、TypeScript strict、Preact 10、preact/compat、chrome.storage.local、MutationObserver、IntersectionObserver、Shadow DOM。

---

## 范围说明

本计划只覆盖设计文档中的 Phase 1、Phase 2、Phase 3。

不在本计划实现的 Phase 4 能力：
- 渐进式远距离跳转。
- 跳转 cancellation token。
- wheel/touch/key/pointerdown 自动取消。
- JumpToast 与失败 toast。
- order-guided adaptive stepping。

Phase 3 中点击 cached-only 消息时，`jumpController` 返回不可直接跳转的结果，并在控制台记录原因；完整远距离跳转留给 Phase 4 计划。

## 文件结构

- Create: `package.json` — npm 脚本与 WXT/Preact/TypeScript 依赖。
- Create: `tsconfig.json` — strict TypeScript 配置，继承 WXT 生成类型。
- Create: `wxt.config.ts` — Manifest V3 权限、host permissions、扩展元数据。
- Create: `.gitignore` — 忽略依赖、构建产物和本地环境文件。
- Create: `README.md` — Phase 1-3 使用说明、隐私说明、加载方式和已知限制。
- Create: `public/icon.png` — 临时扩展图标，可使用 1x1 PNG 占位，后续替换。
- Create: `src/shared/types.ts` — 持久化类型、扫描候选、运行期状态、接口类型。
- Create: `src/shared/hash.ts` — SHA-256 前 16 hex 文本哈希。
- Create: `src/shared/text.ts` — 文本清洗、截断、搜索高亮辅助。
- Create: `src/content/domAdapter.ts` — ChatGPT DOM 选择器集中管理、文本提取、conversationId 提取。
- Create: `src/content/scrollDriver.ts` — 滚动容器检测、scroll ratio、程序化滚动封装。
- Create: `src/content/cacheStore.ts` — chrome.storage.local 当前会话缓存、身份解析、debounce 保存、LRU 清理、temp migration。
- Create: `src/content/runtimeStore.ts` — 内存态状态与 subscribe。
- Create: `src/content/urlWatcher.ts` — SPA URL 监听。
- Create: `src/content/messageScanner.ts` — DOM 扫描、MutationObserver、IntersectionObserver、滚动采集。
- Create: `src/content/jumpController.ts` — Phase 3 直接跳转与目标高亮。
- Create: `src/ui/ShadowRootApp.tsx` — WXT `createShadowRootUi` 容器与 Preact 挂载。
- Create: `src/ui/Sidebar.tsx` — 侧栏主组件，本地管理搜索与折叠。
- Create: `src/ui/MessageItem.tsx` — 单条用户消息项。
- Create: `src/ui/SearchBox.tsx` — 搜索输入。
- Create: `src/ui/styles.css` — Shadow DOM 样式。
- Create: `src/entrypoints/content.ts` — content script 入口与依赖装配。

---

### Task 1: 初始化 WXT + Preact 工程

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `wxt.config.ts`
- Create: `.gitignore`
- Create: `public/icon.png`

- [ ] **Step 1: 创建最小工程配置**

写入 `package.json`：

```json
{
  "name": "chatgpt-question-navigator",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wxt",
    "dev:chrome": "wxt -b chrome",
    "dev:edge": "wxt -b edge",
    "build": "wxt build",
    "build:chrome": "wxt build -b chrome",
    "build:edge": "wxt build -b edge",
    "compile": "tsc --noEmit",
    "zip": "wxt zip"
  },
  "dependencies": {
    "@preact/preset-vite": "^2.10.2",
    "preact": "^10.26.9"
  },
  "devDependencies": {
    "@types/chrome": "^0.0.326",
    "typescript": "^5.8.3",
    "wxt": "^0.20.6"
  }
}
```

写入 `tsconfig.json`：

```json
{
  "extends": "./.wxt/tsconfig.json",
  "compilerOptions": {
    "strict": true,
    "jsx": "react-jsx",
    "jsxImportSource": "preact",
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true
  }
}
```

写入 `wxt.config.ts`：

```typescript
import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'ChatGPT Question Navigator',
    description: 'ChatGPT 长对话导航侧栏 - 本地索引用户问题，支持快速跳转',
    version: '0.1.0',
    permissions: ['storage'],
    host_permissions: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
    icons: {
      16: 'icon.png',
      32: 'icon.png',
      48: 'icon.png',
      128: 'icon.png'
    }
  }
});
```

写入 `.gitignore`：

```gitignore
node_modules/
.wxt/
.output/
dist/
*.log
.env
.env.*
```

- [ ] **Step 2: 创建临时图标**

使用任一 PNG 工具创建 `public/icon.png`。如果当前环境没有图像工具，用以下 PowerShell 生成 1x1 PNG：

```powershell
[byte[]]$png = 137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,8,6,0,0,0,31,21,196,137,0,0,0,13,73,68,65,84,120,156,99,248,207,192,240,31,0,5,0,1,255,137,153,61,29,0,0,0,0,73,69,78,68,174,66,96,130
[System.IO.File]::WriteAllBytes('public/icon.png', $png)
```

- [ ] **Step 3: 安装依赖并生成 WXT 类型**

Run:

```bash
pnpm install
pnpm compile
```

Expected:

```text
No TypeScript errors.
```

如果用户环境没有 `pnpm`，Run:

```bash
npm install
npm run compile
```

Expected:

```text
No TypeScript errors.
```

- [ ] **Step 4: 提交工程初始化**

```bash
git add package.json tsconfig.json wxt.config.ts .gitignore public/icon.png
git commit -m "chore: 初始化 WXT 扩展工程" -m "创建 WXT、Preact 与 TypeScript 严格模式基础配置。配置最小化 storage 权限和 ChatGPT 域名 host permissions，为后续 content script 与 Shadow DOM 侧栏开发建立工程骨架。"
```

---

### Task 2: 定义共享类型与文本工具

**Files:**
- Create: `src/shared/types.ts`
- Create: `src/shared/hash.ts`
- Create: `src/shared/text.ts`

- [ ] **Step 1: 编写共享类型**

写入 `src/shared/types.ts`：

```typescript
export interface CachedUserMessage {
  conversationId: string;
  localMessageId: string;
  role: 'user';
  textForSearch: string;
  preview: string;
  textHash: string;
  occurrenceIndex: number;
  firstSeenAt: number;
  lastSeenAt: number;
  lastKnownScrollTop: number;
  lastKnownScrollRatio: number;
  orderKey: number;
}

export interface ConversationCache {
  conversationId: string;
  updatedAt: number;
  messages: CachedUserMessage[];
}

export interface StorageMeta {
  conversationIds: string[];
  totalBytes: number;
  lastCleanupAt: number;
}

export interface ScannedUserMessageCandidate {
  observedDomMessageId: string | null;
  text: string;
  textHash: string;
  preview: string;
  textForSearch: string;
  scrollRatio: number;
  scrollTop: number;
  domOrderIndex: number;
  element: HTMLElement;
}

export interface ResolveResult {
  allMessages: CachedUserMessage[];
  resolvedMounted: Set<string>;
  newOrUpdated: CachedUserMessage[];
}

export type JumpState =
  | { status: 'idle' }
  | { status: 'jumping'; targetId: string; attempt: number }
  | { status: 'failed'; targetId: string; reason: string };

export interface RuntimeState {
  conversationId: string | null;
  messages: CachedUserMessage[];
  elementById: Map<string, HTMLElement>;
  mountedIds: Set<string>;
  activeMessageId: string | null;
  jumpState: JumpState;
}

export interface VisibleRange {
  minOrderKey: number;
  maxOrderKey: number;
}

export interface ScanResult {
  mountedIds: Set<string>;
  activeMessageId: string | null;
  visibleRange: VisibleRange | null;
  newOrUpdated: CachedUserMessage[];
}
```

- [ ] **Step 2: 编写哈希工具**

写入 `src/shared/hash.ts`：

```typescript
export async function hashText(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .slice(0, 8)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
```

- [ ] **Step 3: 编写文本清洗与高亮工具**

写入 `src/shared/text.ts`：

```typescript
export function normalizeMessageText(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

export function toPreview(input: string, maxLength = 120): string {
  const normalized = normalizeMessageText(input);
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

export function toSearchText(input: string, maxLength = 2000): string {
  return normalizeMessageText(input).slice(0, maxLength);
}

export function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function splitByQuery(text: string, query: string): Array<{ text: string; match: boolean }> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return [{ text, match: false }];

  const regex = new RegExp(`(${escapeRegExp(normalizedQuery)})`, 'ig');
  return text
    .split(regex)
    .filter((part) => part.length > 0)
    .map((part) => ({
      text: part,
      match: part.toLowerCase() === normalizedQuery.toLowerCase()
    }));
}
```

- [ ] **Step 4: 类型检查**

Run:

```bash
pnpm compile
```

Expected:

```text
No TypeScript errors.
```

- [ ] **Step 5: 提交共享层**

```bash
git add src/shared/types.ts src/shared/hash.ts src/shared/text.ts
git commit -m "feat: 添加共享类型与文本工具" -m "定义缓存消息、扫描候选、运行期状态和扫描结果等核心类型。添加 SHA-256 短哈希、文本清洗、摘要截断与搜索高亮分段工具，为 DOM 扫描、缓存和 UI 展示提供稳定基础。"
```

---

### Task 3: 实现 domAdapter 与 scrollDriver

**Files:**
- Create: `src/content/domAdapter.ts`
- Create: `src/content/scrollDriver.ts`

- [ ] **Step 1: 编写 DOM 适配器**

写入 `src/content/domAdapter.ts`：

```typescript
import { normalizeMessageText } from '../shared/text';

const SELECTORS = {
  userMessage: '[data-message-author-role="user"]',
  messageText: '.whitespace-pre-wrap, .message-body, [data-message-author-role] > div',
  excludeButtons: 'button, [role="button"], .copy-button, .edit-button',
  scrollContainer: 'main .overflow-y-auto, [class*="react-scroll-to-bottom"]'
} as const;

const OBSERVED_ID_ATTRIBUTES = ['data-id', 'data-message-id'] as const;

export class DomAdapter {
  findUserMessages(): HTMLElement[] {
    return Array.from(document.querySelectorAll<HTMLElement>(SELECTORS.userMessage));
  }

  extractText(el: HTMLElement): string {
    const clone = el.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(SELECTORS.excludeButtons).forEach((node) => node.remove());

    const textNode = clone.matches(SELECTORS.messageText)
      ? clone
      : clone.querySelector<HTMLElement>(SELECTORS.messageText);

    return normalizeMessageText((textNode ?? clone).innerText || (textNode ?? clone).textContent || '');
  }

  extractConversationId(): string | null {
    const match = location.pathname.match(/\/c\/([^/?#]+)/);
    return match?.[1] ?? null;
  }

  findScrollContainer(): HTMLElement | null {
    const candidates = Array.from(document.querySelectorAll<HTMLElement>(SELECTORS.scrollContainer));
    return candidates.find((el) => el.scrollHeight > el.clientHeight) ?? null;
  }

  isElementInViewport(el: HTMLElement): boolean {
    const rect = el.getBoundingClientRect();
    return rect.bottom >= 0 && rect.top <= window.innerHeight;
  }

  extractObservedId(el: HTMLElement): string | null {
    for (const attr of OBSERVED_ID_ATTRIBUTES) {
      const value = el.getAttribute(attr);
      if (value?.trim()) return value.trim();
    }
    return null;
  }
}
```

- [ ] **Step 2: 编写滚动驱动**

写入 `src/content/scrollDriver.ts`：

```typescript
import type { DomAdapter } from './domAdapter';

type ScrollTarget = HTMLElement | Window;

export class ScrollDriver {
  private target: ScrollTarget = window;
  private scrollListeners = new Set<() => void>();
  private userScrollListeners = new Set<() => void>();
  private isProgrammatic = false;
  private cleanupFns: Array<() => void> = [];

  constructor(private readonly domAdapter: DomAdapter) {}

  init(): void {
    this.target = this.domAdapter.findScrollContainer() ?? document.scrollingElement as HTMLElement | null ?? window;
    this.bindListeners();
  }

  getContainer(): ScrollTarget {
    return this.target;
  }

  getScrollTop(): number {
    if (this.target === window) return window.scrollY || document.documentElement.scrollTop || 0;
    return this.target.scrollTop;
  }

  getScrollHeight(): number {
    if (this.target === window) return document.scrollingElement?.scrollHeight ?? document.documentElement.scrollHeight;
    return this.target.scrollHeight;
  }

  getClientHeight(): number {
    if (this.target === window) return window.innerHeight;
    return this.target.clientHeight;
  }

  getScrollRatio(): number {
    const max = Math.max(1, this.getScrollHeight() - this.getClientHeight());
    return Math.min(1, Math.max(0, this.getScrollTop() / max));
  }

  scrollTo(options: ScrollToOptions): void {
    this.markProgrammatic();
    if (this.target === window) {
      window.scrollTo(options);
      return;
    }
    this.target.scrollTo(options);
  }

  scrollBy(deltaY: number): void {
    this.markProgrammatic();
    if (this.target === window) {
      window.scrollBy({ top: deltaY, behavior: 'auto' });
      return;
    }
    this.target.scrollBy({ top: deltaY, behavior: 'auto' });
  }

  scrollToRatio(ratio: number, behavior: ScrollBehavior = 'auto'): void {
    const clamped = Math.min(1, Math.max(0, ratio));
    const top = clamped * Math.max(0, this.getScrollHeight() - this.getClientHeight());
    this.scrollTo({ top, behavior });
  }

  scrollElementIntoView(el: HTMLElement, options: ScrollIntoViewOptions = { block: 'center', behavior: 'smooth' }): void {
    this.markProgrammatic();
    el.scrollIntoView(options);
  }

  onScroll(callback: () => void): () => void {
    this.scrollListeners.add(callback);
    return () => this.scrollListeners.delete(callback);
  }

  onUserScroll(callback: () => void): () => void {
    this.userScrollListeners.add(callback);
    return () => this.userScrollListeners.delete(callback);
  }

  destroy(): void {
    this.cleanupFns.forEach((cleanup) => cleanup());
    this.cleanupFns = [];
    this.scrollListeners.clear();
    this.userScrollListeners.clear();
  }

  private bindListeners(): void {
    const scrollTarget = this.target === window ? window : this.target;

    const onScroll = () => {
      this.scrollListeners.forEach((listener) => listener());
      if (this.isProgrammatic) {
        window.setTimeout(() => {
          this.isProgrammatic = false;
        }, 80);
      }
    };

    scrollTarget.addEventListener('scroll', onScroll, { passive: true });
    this.cleanupFns.push(() => scrollTarget.removeEventListener('scroll', onScroll));

    const onWheel = () => this.notifyUserScroll();
    const onTouch = () => this.notifyUserScroll();
    const onKey = (event: KeyboardEvent) => {
      if (['PageUp', 'PageDown', ' ', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
        this.notifyUserScroll();
      }
    };

    scrollTarget.addEventListener('wheel', onWheel, { passive: true });
    scrollTarget.addEventListener('touchstart', onTouch, { passive: true });
    window.addEventListener('keydown', onKey);

    this.cleanupFns.push(() => scrollTarget.removeEventListener('wheel', onWheel));
    this.cleanupFns.push(() => scrollTarget.removeEventListener('touchstart', onTouch));
    this.cleanupFns.push(() => window.removeEventListener('keydown', onKey));
  }

  private markProgrammatic(): void {
    this.isProgrammatic = true;
  }

  private notifyUserScroll(): void {
    if (this.isProgrammatic) return;
    this.userScrollListeners.forEach((listener) => listener());
  }
}
```

- [ ] **Step 3: 类型检查**

Run:

```bash
pnpm compile
```

Expected:

```text
No TypeScript errors.
```

- [ ] **Step 4: 提交 DOM 与滚动抽象**

```bash
git add src/content/domAdapter.ts src/content/scrollDriver.ts
git commit -m "feat: 添加 DOM 适配器和滚动驱动" -m "集中管理 ChatGPT 用户消息选择器、文本提取、conversationId 提取和 observed id 白名单。封装滚动容器检测、scroll ratio、程序化滚动和用户滚动监听，避免业务模块直接操作页面滚动细节。"
```

---

### Task 4: 实现 runtimeStore 和 cacheStore

**Files:**
- Create: `src/content/runtimeStore.ts`
- Create: `src/content/cacheStore.ts`

- [ ] **Step 1: 编写运行期状态仓库**

写入 `src/content/runtimeStore.ts`：

```typescript
import type { CachedUserMessage, JumpState, RuntimeState } from '../shared/types';

export class RuntimeStore {
  private state: RuntimeState = {
    conversationId: null,
    messages: [],
    elementById: new Map(),
    mountedIds: new Set(),
    activeMessageId: null,
    jumpState: { status: 'idle' }
  };

  private listeners = new Set<() => void>();

  getSnapshot(): RuntimeState {
    return {
      ...this.state,
      messages: [...this.state.messages],
      elementById: new Map(this.state.elementById),
      mountedIds: new Set(this.state.mountedIds)
    };
  }

  setConversationId(id: string | null): void {
    this.state = {
      ...this.state,
      conversationId: id,
      messages: [],
      elementById: new Map(),
      mountedIds: new Set(),
      activeMessageId: null,
      jumpState: { status: 'idle' }
    };
    this.emit();
  }

  setMessages(messages: CachedUserMessage[]): void {
    this.state = {
      ...this.state,
      messages: [...messages].sort((a, b) => a.orderKey - b.orderKey)
    };
    this.emit();
  }

  setMountedState(mountedIds: Set<string>, elementById: Map<string, HTMLElement>): void {
    this.state = {
      ...this.state,
      mountedIds: new Set(mountedIds),
      elementById: new Map(elementById)
    };
    this.emit();
  }

  setActiveMessageId(id: string | null): void {
    if (this.state.activeMessageId === id) return;
    this.state = { ...this.state, activeMessageId: id };
    this.emit();
  }

  setJumpState(state: JumpState): void {
    this.state = { ...this.state, jumpState: state };
    this.emit();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener());
  }
}
```

- [ ] **Step 2: 编写缓存仓库**

写入 `src/content/cacheStore.ts`：

```typescript
import type {
  CachedUserMessage,
  ConversationCache,
  ResolveResult,
  ScannedUserMessageCandidate,
  StorageMeta
} from '../shared/types';

type StoredCandidate = Omit<ScannedUserMessageCandidate, 'element'>;

const META_KEY = 'meta';
const CACHE_PREFIX = 'conv:';
const SAVE_DEBOUNCE_MS = 2000;
const STORAGE_LIMIT_BYTES = 8 * 1024 * 1024;
const STORAGE_CLEAN_TARGET_BYTES = Math.floor(STORAGE_LIMIT_BYTES * 0.8);

const defaultMeta = (): StorageMeta => ({
  conversationIds: [],
  totalBytes: 0,
  lastCleanupAt: 0
});

export class CacheStore {
  private currentCache: ConversationCache | null = null;
  private dirty = false;
  private saveTimer: number | null = null;

  async loadConversation(id: string): Promise<ConversationCache | null> {
    await this.flush();
    const key = this.cacheKey(id);
    const result = await chrome.storage.local.get(key);
    const cache = result[key] as ConversationCache | undefined;
    this.currentCache = cache ?? { conversationId: id, updatedAt: Date.now(), messages: [] };
    this.dirty = false;
    return cache ?? null;
  }

  async saveConversation(cache: ConversationCache): Promise<void> {
    const normalized = {
      ...cache,
      updatedAt: Date.now(),
      messages: [...cache.messages].sort((a, b) => a.orderKey - b.orderKey)
    };
    await chrome.storage.local.set({ [this.cacheKey(cache.conversationId)]: normalized });
    await this.touchMeta(cache.conversationId);
    this.currentCache = normalized;
    this.dirty = false;
    await this.performLruCleanupIfNeeded();
  }

  async clearConversation(id: string): Promise<void> {
    await chrome.storage.local.remove(this.cacheKey(id));
    const meta = await this.loadMeta();
    meta.conversationIds = meta.conversationIds.filter((conversationId) => conversationId !== id);
    meta.totalBytes = await this.getBytesInUse();
    await chrome.storage.local.set({ [META_KEY]: meta });
    if (this.currentCache?.conversationId === id) this.currentCache = null;
  }

  async clearAll(): Promise<void> {
    const meta = await this.loadMeta();
    const keys = meta.conversationIds.map((id) => this.cacheKey(id));
    await chrome.storage.local.remove([...keys, META_KEY]);
    this.currentCache = null;
    this.dirty = false;
  }

  async resolveScannedCandidates(conversationId: string, candidates: StoredCandidate[]): Promise<ResolveResult> {
    this.ensureCurrentCache(conversationId);

    const now = Date.now();
    const existing = this.currentCache!.messages;
    const usedExisting = new Set<string>();
    const resolvedMounted = new Set<string>();
    const newOrUpdated: CachedUserMessage[] = [];
    const nextMessagesById = new Map(existing.map((message) => [message.localMessageId, message]));

    for (const candidate of candidates) {
      const matched = this.matchCandidate(conversationId, candidate, existing, usedExisting);
      const occurrenceIndex = matched?.occurrenceIndex ?? this.nextOccurrenceIndex(conversationId, candidate.textHash, existing, nextMessagesById);
      const localMessageId = matched?.localMessageId ?? this.createLocalMessageId(conversationId, candidate.observedDomMessageId, candidate.textHash, occurrenceIndex);

      const next: CachedUserMessage = {
        conversationId,
        localMessageId,
        role: 'user',
        textForSearch: candidate.textForSearch,
        preview: candidate.preview,
        textHash: candidate.textHash,
        occurrenceIndex,
        firstSeenAt: matched?.firstSeenAt ?? now,
        lastSeenAt: now,
        lastKnownScrollTop: candidate.scrollTop,
        lastKnownScrollRatio: candidate.scrollRatio,
        orderKey: candidate.domOrderIndex
      };

      if (!matched || this.hasMeaningfulChange(matched, next)) {
        newOrUpdated.push(next);
        this.dirty = true;
      }

      usedExisting.add(localMessageId);
      resolvedMounted.add(localMessageId);
      nextMessagesById.set(localMessageId, next);
    }

    const allMessages = Array.from(nextMessagesById.values()).sort((a, b) => a.orderKey - b.orderKey);
    this.currentCache = {
      conversationId,
      updatedAt: now,
      messages: allMessages
    };

    if (this.dirty) this.scheduleSave();

    return { allMessages, resolvedMounted, newOrUpdated };
  }

  async migrateTempCache(tempId: string, realId: string): Promise<void> {
    const temp = await this.loadRawConversation(tempId);
    if (!temp) return;

    const migrated: ConversationCache = {
      conversationId: realId,
      updatedAt: Date.now(),
      messages: temp.messages.map((message) => ({
        ...message,
        conversationId: realId,
        localMessageId: message.localMessageId.replace(`${tempId}::`, `${realId}::`)
      }))
    };

    await chrome.storage.local.set({ [this.cacheKey(realId)]: migrated });
    await chrome.storage.local.remove(this.cacheKey(tempId));
    await this.touchMeta(realId);
    const meta = await this.loadMeta();
    meta.conversationIds = meta.conversationIds.filter((id) => id !== tempId);
    await chrome.storage.local.set({ [META_KEY]: meta });
    this.currentCache = migrated;
    this.dirty = false;
  }

  async getBytesInUse(): Promise<number> {
    return chrome.storage.local.getBytesInUse(null);
  }

  async performLruCleanupIfNeeded(): Promise<void> {
    let bytes = await this.getBytesInUse();
    if (bytes <= STORAGE_LIMIT_BYTES) return;

    const meta = await this.loadMeta();
    const ids = [...meta.conversationIds];

    while (bytes > STORAGE_CLEAN_TARGET_BYTES && ids.length > 1) {
      const victim = ids.pop();
      if (!victim) break;
      if (victim === this.currentCache?.conversationId) {
        ids.unshift(victim);
        break;
      }
      await chrome.storage.local.remove(this.cacheKey(victim));
      bytes = await this.getBytesInUse();
    }

    meta.conversationIds = ids;
    meta.totalBytes = bytes;
    meta.lastCleanupAt = Date.now();
    await chrome.storage.local.set({ [META_KEY]: meta });
  }

  async flush(): Promise<void> {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.currentCache && this.dirty) {
      await this.saveConversation(this.currentCache);
    }
  }

  private ensureCurrentCache(conversationId: string): void {
    if (this.currentCache?.conversationId === conversationId) return;
    this.currentCache = { conversationId, updatedAt: Date.now(), messages: [] };
    this.dirty = false;
  }

  private matchCandidate(
    conversationId: string,
    candidate: StoredCandidate,
    existing: CachedUserMessage[],
    usedExisting: Set<string>
  ): CachedUserMessage | null {
    if (candidate.observedDomMessageId) {
      const domId = `${conversationId}::dom::${candidate.observedDomMessageId}`;
      const exact = existing.find((message) => message.localMessageId === domId && !usedExisting.has(message.localMessageId));
      if (exact) return exact;
    }

    const sameHash = existing
      .filter((message) => message.textHash === candidate.textHash && !usedExisting.has(message.localMessageId))
      .map((message) => ({
        message,
        distance: Math.abs(message.lastKnownScrollRatio - candidate.scrollRatio) + Math.abs(message.orderKey - candidate.domOrderIndex) * 0.01
      }))
      .sort((a, b) => a.distance - b.distance);

    const best = sameHash[0];
    if (!best) return null;
    if (Math.abs(best.message.lastKnownScrollRatio - candidate.scrollRatio) > 0.15) return null;
    return best.message;
  }

  private nextOccurrenceIndex(
    conversationId: string,
    textHash: string,
    existing: CachedUserMessage[],
    nextMessagesById: Map<string, CachedUserMessage>
  ): number {
    const indexes = [...existing, ...nextMessagesById.values()]
      .filter((message) => message.conversationId === conversationId && message.textHash === textHash)
      .map((message) => message.occurrenceIndex);
    return indexes.length === 0 ? 0 : Math.max(...indexes) + 1;
  }

  private createLocalMessageId(conversationId: string, observedDomMessageId: string | null, textHash: string, occurrenceIndex: number): string {
    if (observedDomMessageId) return `${conversationId}::dom::${observedDomMessageId}`;
    return `${conversationId}::hash::${textHash}::${occurrenceIndex}`;
  }

  private hasMeaningfulChange(previous: CachedUserMessage, next: CachedUserMessage): boolean {
    return previous.preview !== next.preview
      || previous.textForSearch !== next.textForSearch
      || previous.lastKnownScrollTop !== next.lastKnownScrollTop
      || previous.lastKnownScrollRatio !== next.lastKnownScrollRatio
      || previous.orderKey !== next.orderKey;
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      void this.flush().catch((error) => console.warn('[ChatGPT Navigator] Failed to save cache', error));
    }, SAVE_DEBOUNCE_MS);
  }

  private async loadRawConversation(id: string): Promise<ConversationCache | null> {
    const key = this.cacheKey(id);
    const result = await chrome.storage.local.get(key);
    return (result[key] as ConversationCache | undefined) ?? null;
  }

  private async loadMeta(): Promise<StorageMeta> {
    const result = await chrome.storage.local.get(META_KEY);
    return (result[META_KEY] as StorageMeta | undefined) ?? defaultMeta();
  }

  private async touchMeta(conversationId: string): Promise<void> {
    const meta = await this.loadMeta();
    meta.conversationIds = [conversationId, ...meta.conversationIds.filter((id) => id !== conversationId)];
    meta.totalBytes = await this.getBytesInUse();
    await chrome.storage.local.set({ [META_KEY]: meta });
  }

  private cacheKey(id: string): string {
    return `${CACHE_PREFIX}${id}`;
  }
}
```

- [ ] **Step 3: 类型检查**

Run:

```bash
pnpm compile
```

Expected:

```text
No TypeScript errors.
```

- [ ] **Step 4: 提交状态与缓存层**

```bash
git add src/content/runtimeStore.ts src/content/cacheStore.ts
git commit -m "feat: 添加运行期状态和本地缓存" -m "实现 runtimeStore 的订阅式内存状态管理。实现 cacheStore 的 chrome.storage.local 读写、currentCache 内存模型、扫描候选身份解析、debounce 保存、LRU 清理和 temp cache migration。"
```

---

### Task 5: 实现 URL watcher 与 messageScanner

**Files:**
- Create: `src/content/urlWatcher.ts`
- Create: `src/content/messageScanner.ts`

- [ ] **Step 1: 编写 SPA URL 监听**

写入 `src/content/urlWatcher.ts`：

```typescript
import type { DomAdapter } from './domAdapter';

type ConversationChangeCallback = (id: string | null, previousId: string | null) => void | Promise<void>;

export class UrlWatcher {
  private callbacks = new Set<ConversationChangeCallback>();
  private currentId: string | null = null;
  private previousHref = location.href;
  private intervalId: number | null = null;
  private tempId: string | null = null;
  private originalPushState = history.pushState;
  private originalReplaceState = history.replaceState;

  constructor(private readonly domAdapter: DomAdapter) {}

  onConversationChange(callback: ConversationChangeCallback): void {
    this.callbacks.add(callback);
  }

  start(): void {
    this.patchHistory();
    window.addEventListener('popstate', this.handleLocationMaybeChanged);
    this.intervalId = window.setInterval(this.handleLocationMaybeChanged, 1000);
    this.emitIfChanged(true);
  }

  getCurrentId(): string | null {
    return this.currentId;
  }

  stop(): void {
    history.pushState = this.originalPushState;
    history.replaceState = this.originalReplaceState;
    window.removeEventListener('popstate', this.handleLocationMaybeChanged);
    if (this.intervalId !== null) window.clearInterval(this.intervalId);
  }

  private patchHistory(): void {
    const notify = () => window.setTimeout(this.handleLocationMaybeChanged, 0);

    history.pushState = ((...args) => {
      const result = this.originalPushState.apply(history, args);
      notify();
      return result;
    }) as History['pushState'];

    history.replaceState = ((...args) => {
      const result = this.originalReplaceState.apply(history, args);
      notify();
      return result;
    }) as History['replaceState'];
  }

  private handleLocationMaybeChanged = (): void => {
    if (location.href === this.previousHref) return;
    this.previousHref = location.href;
    this.emitIfChanged(false);
  };

  private emitIfChanged(force: boolean): void {
    const previousId = this.currentId;
    const nextId = this.resolveConversationId();
    if (!force && previousId === nextId) return;
    this.currentId = nextId;
    this.callbacks.forEach((callback) => void callback(nextId, previousId));
  }

  private resolveConversationId(): string {
    const urlId = this.domAdapter.extractConversationId();
    if (urlId) return urlId;
    this.tempId ??= `temp:${Date.now()}`;
    return this.tempId;
  }
}
```

- [ ] **Step 2: 编写消息扫描器**

写入 `src/content/messageScanner.ts`：

```typescript
import type { ResolveResult, ScanResult, ScannedUserMessageCandidate, VisibleRange } from '../shared/types';
import { hashText } from '../shared/hash';
import { toPreview, toSearchText } from '../shared/text';
import type { CacheStore } from './cacheStore';
import type { DomAdapter } from './domAdapter';
import type { RuntimeStore } from './runtimeStore';
import type { ScrollDriver } from './scrollDriver';

const MUTATION_DEBOUNCE_MS = 500;
const SCROLL_THROTTLE_MS = 300;

export class MessageScanner {
  private mutationObserver: MutationObserver | null = null;
  private intersectionObserver: IntersectionObserver | null = null;
  private mutationTimer: number | null = null;
  private scrollTimer: number | null = null;
  private elementById = new Map<string, HTMLElement>();
  private mountedIds = new Set<string>();
  private cleanupScroll: (() => void) | null = null;

  constructor(
    private readonly domAdapter: DomAdapter,
    private readonly cacheStore: CacheStore,
    private readonly scrollDriver: ScrollDriver,
    private readonly runtimeStore: RuntimeStore
  ) {}

  start(): void {
    this.mutationObserver = new MutationObserver(() => this.scheduleRescan());
    this.mutationObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
    this.cleanupScroll = this.scrollDriver.onScroll(() => this.scheduleScrollCapture());
  }

  stop(): void {
    this.mutationObserver?.disconnect();
    this.intersectionObserver?.disconnect();
    this.cleanupScroll?.();
    this.elementById.clear();
    this.mountedIds.clear();
  }

  async rescan(): Promise<ScanResult> {
    const conversationId = this.runtimeStore.getSnapshot().conversationId;
    if (!conversationId) {
      return { mountedIds: new Set(), activeMessageId: null, visibleRange: null, newOrUpdated: [] };
    }

    const elements = this.domAdapter.findUserMessages();
    const candidates: ScannedUserMessageCandidate[] = [];

    for (let index = 0; index < elements.length; index += 1) {
      const element = elements[index];
      if (!element) continue;
      const text = this.domAdapter.extractText(element);
      if (!text) continue;
      candidates.push({
        observedDomMessageId: this.domAdapter.extractObservedId(element),
        text,
        textHash: await hashText(text),
        preview: toPreview(text),
        textForSearch: toSearchText(text),
        scrollRatio: this.scrollDriver.getScrollRatio(),
        scrollTop: this.scrollDriver.getScrollTop(),
        domOrderIndex: index,
        element
      });
    }

    const result = await this.cacheStore.resolveScannedCandidates(
      conversationId,
      candidates.map(({ element: _element, ...candidate }) => candidate)
    );

    this.rebuildMountedMaps(result, candidates);
    this.runtimeStore.setMessages(result.allMessages);
    this.runtimeStore.setMountedState(this.mountedIds, this.elementById);
    this.reobserveMountedElements();

    const activeMessageId = this.computeActiveMessageId();
    this.runtimeStore.setActiveMessageId(activeMessageId);

    return {
      mountedIds: new Set(this.mountedIds),
      activeMessageId,
      visibleRange: this.computeVisibleRange(),
      newOrUpdated: result.newOrUpdated
    };
  }

  getElementByLocalId(localId: string): HTMLElement | undefined {
    return this.elementById.get(localId);
  }

  getMountedIds(): Set<string> {
    return new Set(this.mountedIds);
  }

  updateScrollMeta(localId: string, scrollTop: number, scrollRatio: number): void {
    const snapshot = this.runtimeStore.getSnapshot();
    const target = snapshot.messages.find((message) => message.localMessageId === localId);
    if (!target || !snapshot.conversationId) return;

    void this.cacheStore.resolveScannedCandidates(snapshot.conversationId, [{
      observedDomMessageId: target.localMessageId.includes('::dom::') ? target.localMessageId.split('::dom::')[1] ?? null : null,
      text: target.textForSearch,
      textHash: target.textHash,
      preview: target.preview,
      textForSearch: target.textForSearch,
      scrollRatio,
      scrollTop,
      domOrderIndex: target.orderKey
    }]);
  }

  private scheduleRescan(): void {
    if (this.mutationTimer !== null) window.clearTimeout(this.mutationTimer);
    this.mutationTimer = window.setTimeout(() => {
      void this.rescan().catch((error) => console.warn('[ChatGPT Navigator] rescan failed', error));
    }, MUTATION_DEBOUNCE_MS);
  }

  private scheduleScrollCapture(): void {
    if (this.scrollTimer !== null) return;
    this.scrollTimer = window.setTimeout(() => {
      this.scrollTimer = null;
      for (const localId of this.mountedIds) {
        const el = this.elementById.get(localId);
        if (el && this.domAdapter.isElementInViewport(el)) {
          this.updateScrollMeta(localId, this.scrollDriver.getScrollTop(), this.scrollDriver.getScrollRatio());
        }
      }
      this.runtimeStore.setActiveMessageId(this.computeActiveMessageId());
    }, SCROLL_THROTTLE_MS);
  }

  private rebuildMountedMaps(result: ResolveResult, candidates: ScannedUserMessageCandidate[]): void {
    this.elementById.clear();
    this.mountedIds = new Set(result.resolvedMounted);

    const messagesByIdentity = new Map(result.allMessages.map((message) => [
      `${message.textHash}:${message.orderKey}`,
      message.localMessageId
    ]));

    for (const candidate of candidates) {
      const localId = messagesByIdentity.get(`${candidate.textHash}:${candidate.domOrderIndex}`);
      if (localId) this.elementById.set(localId, candidate.element);
    }
  }

  private reobserveMountedElements(): void {
    this.intersectionObserver?.disconnect();
    this.intersectionObserver = new IntersectionObserver(() => {
      this.runtimeStore.setActiveMessageId(this.computeActiveMessageId());
    }, { threshold: [0, 0.25, 0.5, 1] });

    this.elementById.forEach((element) => this.intersectionObserver?.observe(element));
  }

  private computeActiveMessageId(): string | null {
    const entries = Array.from(this.elementById.entries())
      .map(([id, element]) => ({ id, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.bottom >= 0 && rect.top <= window.innerHeight);

    const visibleBelowTop = entries
      .filter(({ rect }) => rect.top >= 0)
      .sort((a, b) => a.rect.top - b.rect.top)[0];
    if (visibleBelowTop) return visibleBelowTop.id;

    const nearestAbove = Array.from(this.elementById.entries())
      .map(([id, element]) => ({ id, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.top < 0)
      .sort((a, b) => b.rect.top - a.rect.top)[0];

    return nearestAbove?.id ?? null;
  }

  private computeVisibleRange(): VisibleRange | null {
    const snapshot = this.runtimeStore.getSnapshot();
    const visibleOrderKeys = snapshot.messages
      .filter((message) => {
        const element = this.elementById.get(message.localMessageId);
        return element ? this.domAdapter.isElementInViewport(element) : false;
      })
      .map((message) => message.orderKey);

    if (visibleOrderKeys.length === 0) return null;
    return {
      minOrderKey: Math.min(...visibleOrderKeys),
      maxOrderKey: Math.max(...visibleOrderKeys)
    };
  }
}
```

- [ ] **Step 3: 类型检查**

Run:

```bash
pnpm compile
```

Expected:

```text
No TypeScript errors.
```

- [ ] **Step 4: 提交 URL 与扫描层**

```bash
git add src/content/urlWatcher.ts src/content/messageScanner.ts
git commit -m "feat: 添加 URL 监听和消息扫描" -m "实现 ChatGPT SPA 路由监听，支持初次 start 立即 emit 和无 conversationId 时的 temp id。实现用户消息 DOM 扫描、MutationObserver 防抖、IntersectionObserver 当前消息识别和滚动采集入口。"
```

---

### Task 6: 实现 Shadow DOM UI 基础侧栏

**Files:**
- Create: `src/ui/ShadowRootApp.tsx`
- Create: `src/ui/Sidebar.tsx`
- Create: `src/ui/MessageItem.tsx`
- Create: `src/ui/SearchBox.tsx`
- Create: `src/ui/styles.css`

- [ ] **Step 1: 编写 Shadow DOM 挂载容器**

写入 `src/ui/ShadowRootApp.tsx`：

```tsx
import { render } from 'preact';
import { createShadowRootUi, type ContentScriptContext } from 'wxt/client';
import type { JumpController } from '../content/jumpController';
import type { RuntimeStore } from '../content/runtimeStore';
import { Sidebar } from './Sidebar';

export async function createShadowRootApp(
  ctx: ContentScriptContext,
  deps: { runtimeStore: RuntimeStore; jumpController: JumpController }
): Promise<void> {
  const ui = await createShadowRootUi(ctx, {
    name: 'chatgpt-navigator',
    position: 'overlay',
    anchor: 'body',
    onMount(container: HTMLElement) {
      render(<Sidebar runtimeStore={deps.runtimeStore} jumpController={deps.jumpController} />, container);
      return () => render(null, container);
    },
    onRemove(cleanup: unknown) {
      if (typeof cleanup === 'function') cleanup();
    }
  });

  ui.mount();
}
```

- [ ] **Step 2: 先创建 jumpController 类型桩**

在 Task 8 会补全实现。为避免 UI 先引用不存在的文件，写入 `src/content/jumpController.ts`：

```typescript
import type { CachedUserMessage } from '../shared/types';

export class JumpController {
  async jumpToMessage(_target: CachedUserMessage): Promise<boolean> {
    return false;
  }

  cancelCurrent(): void {}
}
```

- [ ] **Step 3: 编写搜索框组件**

写入 `src/ui/SearchBox.tsx`：

```tsx
interface SearchBoxProps {
  value: string;
  onChange: (value: string) => void;
}

export function SearchBox({ value, onChange }: SearchBoxProps) {
  return (
    <label className="cqn-search">
      <span className="cqn-search-icon">⌕</span>
      <input
        value={value}
        onInput={(event) => onChange(event.currentTarget.value)}
        placeholder="搜索问题"
        type="search"
      />
    </label>
  );
}
```

- [ ] **Step 4: 编写消息项组件**

写入 `src/ui/MessageItem.tsx`：

```tsx
import { memo } from 'preact/compat';
import type { CachedUserMessage } from '../shared/types';
import { splitByQuery } from '../shared/text';

interface MessageItemProps {
  message: CachedUserMessage;
  index: number;
  active: boolean;
  mounted: boolean;
  searchQuery: string;
  onClick: (message: CachedUserMessage) => void;
}

function MessageItemComponent({ message, index, active, mounted, searchQuery, onClick }: MessageItemProps) {
  const parts = splitByQuery(message.preview, searchQuery);

  return (
    <button
      className={`cqn-item${active ? ' is-active' : ''}`}
      title={message.textForSearch}
      type="button"
      onClick={() => onClick(message)}
    >
      <span className="cqn-item-index">Q{index + 1}</span>
      <span className="cqn-item-body">
        <span className="cqn-item-preview">
          {parts.map((part) => part.match ? <mark>{part.text}</mark> : <span>{part.text}</span>)}
        </span>
        <span className="cqn-item-meta">{mounted ? '● 当前可跳转' : '○ 已缓存'}</span>
      </span>
    </button>
  );
}

export const MessageItem = memo(MessageItemComponent);
```

- [ ] **Step 5: 编写侧栏组件**

写入 `src/ui/Sidebar.tsx`：

```tsx
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
```

- [ ] **Step 6: 编写样式**

写入 `src/ui/styles.css`：

```css
:host {
  --cqn-bg-primary: #212121;
  --cqn-bg-secondary: #2f2f2f;
  --cqn-text-primary: #ececec;
  --cqn-text-secondary: #b4b4b4;
  --cqn-accent: #10a37f;
  --cqn-border: #424242;
  --cqn-sidebar-width: 280px;
  --cqn-sidebar-collapsed: 40px;
  color-scheme: dark;
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

.cqn-sidebar {
  position: fixed;
  top: 72px;
  right: 12px;
  z-index: 2147483647;
  width: var(--cqn-sidebar-width);
  max-height: calc(100vh - 96px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--cqn-border);
  border-radius: 8px;
  background: var(--cqn-bg-primary);
  color: var(--cqn-text-primary);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.28);
}

.cqn-sidebar.is-collapsed {
  width: var(--cqn-sidebar-collapsed);
  min-height: 40px;
}

.cqn-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 10px 8px;
  border-bottom: 1px solid var(--cqn-border);
  font-size: 13px;
}

.cqn-collapse {
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--cqn-text-secondary);
  cursor: pointer;
}

.cqn-collapse:hover {
  background: var(--cqn-bg-secondary);
  color: var(--cqn-text-primary);
}

.cqn-search {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 10px;
  padding: 7px 9px;
  border: 1px solid var(--cqn-border);
  border-radius: 7px;
  background: var(--cqn-bg-secondary);
}

.cqn-search input {
  min-width: 0;
  width: 100%;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--cqn-text-primary);
  font: inherit;
}

.cqn-search-icon,
.cqn-status,
.cqn-item-meta {
  color: var(--cqn-text-secondary);
}

.cqn-status {
  padding: 0 10px 8px;
  font-size: 12px;
}

.cqn-list {
  overflow-y: auto;
  padding: 4px 6px 8px;
}

.cqn-item {
  width: 100%;
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr);
  gap: 8px;
  margin: 2px 0;
  padding: 8px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  text-align: left;
}

.cqn-item:hover {
  background: var(--cqn-bg-secondary);
}

.cqn-item.is-active {
  border-color: var(--cqn-accent);
  background: rgba(16, 163, 127, 0.12);
}

.cqn-item-index {
  color: var(--cqn-accent);
  font-size: 12px;
  font-weight: 700;
}

.cqn-item-body {
  min-width: 0;
}

.cqn-item-preview {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  line-height: 1.4;
}

.cqn-item-preview mark {
  border-radius: 3px;
  background: rgba(16, 163, 127, 0.28);
  color: var(--cqn-text-primary);
}

.cqn-item-meta {
  display: block;
  margin-top: 3px;
  font-size: 11px;
}

@media (prefers-color-scheme: light) {
  :host {
    --cqn-bg-primary: #ffffff;
    --cqn-bg-secondary: #f4f4f4;
    --cqn-text-primary: #202123;
    --cqn-text-secondary: #6b6b6b;
    --cqn-border: #d9d9e3;
    color-scheme: light;
  }
}
```

- [ ] **Step 7: 类型检查**

Run:

```bash
pnpm compile
```

Expected:

```text
No TypeScript errors.
```

- [ ] **Step 8: 提交 UI 基础**

```bash
git add src/ui/ShadowRootApp.tsx src/ui/Sidebar.tsx src/ui/MessageItem.tsx src/ui/SearchBox.tsx src/ui/styles.css src/content/jumpController.ts
git commit -m "feat: 添加 Shadow DOM 导航侧栏" -m "实现 WXT createShadowRootUi 容器、Preact 侧栏、折叠状态、搜索输入、消息列表项、mounted/cached 状态展示和基础样式。添加 jumpController 类型桩以支撑 UI 依赖装配。"
```

---

### Task 7: 装配 content script，实现 Phase 1-2 可用闭环

**Files:**
- Create: `src/entrypoints/content.ts`
- Modify: `src/content/messageScanner.ts`

- [ ] **Step 1: 编写 content script 入口**

写入 `src/entrypoints/content.ts`：

```typescript
import '../ui/styles.css';
import { defineContentScript } from 'wxt/client';
import { CacheStore } from '../content/cacheStore';
import { DomAdapter } from '../content/domAdapter';
import { JumpController } from '../content/jumpController';
import { MessageScanner } from '../content/messageScanner';
import { RuntimeStore } from '../content/runtimeStore';
import { ScrollDriver } from '../content/scrollDriver';
import { UrlWatcher } from '../content/urlWatcher';
import { createShadowRootApp } from '../ui/ShadowRootApp';

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
    const jumpController = new JumpController();

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

    await createShadowRootApp(ctx, { runtimeStore, jumpController });
  }
});
```

- [ ] **Step 2: 修正 scanner 启动后首次扫描机会**

在 `src/content/messageScanner.ts` 的 `start()` 末尾增加一次防抖扫描：

```typescript
  start(): void {
    this.mutationObserver = new MutationObserver(() => this.scheduleRescan());
    this.mutationObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
    this.cleanupScroll = this.scrollDriver.onScroll(() => this.scheduleScrollCapture());
    this.scheduleRescan();
  }
```

- [ ] **Step 3: 类型检查**

Run:

```bash
pnpm compile
```

Expected:

```text
No TypeScript errors.
```

- [ ] **Step 4: 本地构建**

Run:

```bash
pnpm build
```

Expected:

```text
WXT build completes and creates .output/chrome-mv3.
```

- [ ] **Step 5: 手工验收 Phase 1-2**

Run:

```bash
pnpm dev
```

Expected:

```text
WXT dev server starts without errors.
```

浏览器手工检查：
- 加载 `.output/chrome-mv3` 到 Chrome 或 Edge。
- 打开 `https://chatgpt.com/` 或 `https://chat.openai.com/`。
- 右侧出现侧栏。
- 当前 DOM 中用户消息显示为 Q1、Q2。
- 滚动后列表增加经过的用户消息。
- 刷新页面后已采集问题仍然显示。

- [ ] **Step 6: 提交 content 装配**

```bash
git add src/entrypoints/content.ts src/content/messageScanner.ts
git commit -m "feat: 装配内容脚本采集闭环" -m "连接 domAdapter、cacheStore、scrollDriver、runtimeStore、urlWatcher、messageScanner 和 Shadow DOM UI。完成 URL 切换加载缓存、DOM 扫描入库、运行期 mounted 状态更新和侧栏展示的 Phase 1-2 可用路径。"
```

---

### Task 8: 实现 Phase 3 直接跳转与目标高亮

**Files:**
- Modify: `src/content/jumpController.ts`
- Modify: `src/entrypoints/content.ts`
- Modify: `src/ui/styles.css`

- [ ] **Step 1: 补全 jumpController**

替换 `src/content/jumpController.ts`：

```typescript
import type { CachedUserMessage } from '../shared/types';
import type { CacheStore } from './cacheStore';
import type { MessageScanner } from './messageScanner';
import type { RuntimeStore } from './runtimeStore';
import type { ScrollDriver } from './scrollDriver';

const HIGHLIGHT_CLASS = 'cqn-target-highlight';
const HIGHLIGHT_MS = 1500;

export class JumpController {
  constructor(
    private readonly scanner: MessageScanner,
    private readonly cacheStore: CacheStore,
    private readonly scrollDriver: ScrollDriver,
    private readonly runtimeStore: RuntimeStore
  ) {}

  async jumpToMessage(target: CachedUserMessage): Promise<boolean> {
    this.runtimeStore.setJumpState({ status: 'jumping', targetId: target.localMessageId, attempt: 0 });

    const direct = await this.jumpToMounted(target);
    if (direct) {
      this.runtimeStore.setJumpState({ status: 'idle' });
      return true;
    }

    await this.scanner.rescan();
    const afterRescan = await this.jumpToMounted(target);
    if (afterRescan) {
      this.runtimeStore.setJumpState({ status: 'idle' });
      return true;
    }

    this.runtimeStore.setJumpState({
      status: 'failed',
      targetId: target.localMessageId,
      reason: '目标消息当前未挂载，渐进式跳转将在 Phase 4 实现'
    });
    console.info('[ChatGPT Navigator] Cached-only target is not mounted yet', target.localMessageId);
    return false;
  }

  cancelCurrent(): void {
    this.runtimeStore.setJumpState({ status: 'idle' });
  }

  private async jumpToMounted(target: CachedUserMessage): Promise<boolean> {
    const el = this.scanner.getElementByLocalId(target.localMessageId);
    if (!el) return false;

    this.scrollDriver.scrollElementIntoView(el, { block: 'center', behavior: 'smooth' });
    this.highlightMessage(el);
    this.scanner.updateScrollMeta(target.localMessageId, this.scrollDriver.getScrollTop(), this.scrollDriver.getScrollRatio());
    await this.cacheStore.flush();
    return true;
  }

  private highlightMessage(el: HTMLElement): void {
    el.classList.add(HIGHLIGHT_CLASS);
    window.setTimeout(() => {
      el.classList.remove(HIGHLIGHT_CLASS);
    }, HIGHLIGHT_MS);
  }
}
```

- [ ] **Step 2: 更新 content script 注入依赖**

在 `src/entrypoints/content.ts` 中替换 jumpController 创建语句：

```typescript
    const scanner = new MessageScanner(domAdapter, cacheStore, scrollDriver, runtimeStore);
    const jumpController = new JumpController(scanner, cacheStore, scrollDriver, runtimeStore);
```

- [ ] **Step 3: 添加目标高亮样式**

在 `src/ui/styles.css` 末尾增加：

```css
:global(.cqn-target-highlight) {
  outline: 2px solid var(--cqn-accent, #10a37f) !important;
  outline-offset: 4px !important;
  border-radius: 8px !important;
  transition: outline-color 160ms ease, outline-offset 160ms ease;
}
```

- [ ] **Step 4: 类型检查**

Run:

```bash
pnpm compile
```

Expected:

```text
No TypeScript errors.
```

- [ ] **Step 5: 手工验收直接跳转**

Run:

```bash
pnpm dev
```

Expected:

```text
WXT dev server starts without errors.
```

浏览器手工检查：
- 打开已有 ChatGPT 对话。
- 点击侧栏中标记为 `● 当前可跳转` 的问题。
- 页面滚动到目标消息附近，目标消息出现 1.5 秒绿色高亮。
- 点击 `○ 已缓存` 且当前 DOM 不存在的问题时，不产生死循环，控制台出现 cached-only 提示。

- [ ] **Step 6: 提交直接跳转**

```bash
git add src/content/jumpController.ts src/entrypoints/content.ts src/ui/styles.css
git commit -m "feat: 实现当前 DOM 消息直接跳转" -m "补全 jumpController，支持 mounted 用户消息的居中滚动、1.5 秒目标高亮和跳转后滚动元数据刷新。cached-only 目标暂以失败状态和控制台提示处理，为 Phase 4 渐进式跳转保留边界。"
```

---

### Task 9: 完善搜索、hover 预览和 active 高亮体验

**Files:**
- Modify: `src/ui/Sidebar.tsx`
- Modify: `src/ui/MessageItem.tsx`
- Modify: `src/ui/styles.css`

- [ ] **Step 1: 给搜索增加 300ms debounce**

替换 `src/ui/Sidebar.tsx`：

```tsx
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
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => runtimeStore.subscribe(() => setSnapshot(runtimeStore.getSnapshot())), [runtimeStore]);

  useEffect(() => {
    const timer = window.setTimeout(() => setSearchQuery(searchInput), 300);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

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
            onClick={(target) => void jumpController.jumpToMessage(target)}
          />
        ))}
      </nav>
    </aside>
  );
}
```

- [ ] **Step 2: 用自绘 hover 预览替代浏览器 title**

替换 `src/ui/MessageItem.tsx`：

```tsx
import { memo } from 'preact/compat';
import type { CachedUserMessage } from '../shared/types';
import { splitByQuery } from '../shared/text';

interface MessageItemProps {
  message: CachedUserMessage;
  index: number;
  active: boolean;
  mounted: boolean;
  searchQuery: string;
  onClick: (message: CachedUserMessage) => void;
}

function MessageItemComponent({ message, index, active, mounted, searchQuery, onClick }: MessageItemProps) {
  const parts = splitByQuery(message.preview, searchQuery);

  return (
    <button
      className={`cqn-item${active ? ' is-active' : ''}`}
      type="button"
      onClick={() => onClick(message)}
    >
      <span className="cqn-item-index">Q{index + 1}</span>
      <span className="cqn-item-body">
        <span className="cqn-item-preview">
          {parts.map((part) => part.match ? <mark>{part.text}</mark> : <span>{part.text}</span>)}
        </span>
        <span className="cqn-item-meta">{mounted ? '● 当前可跳转' : '○ 已缓存'}</span>
        <span className="cqn-hover-preview" role="tooltip">
          {message.textForSearch}
        </span>
      </span>
    </button>
  );
}

export const MessageItem = memo(MessageItemComponent);
```

- [ ] **Step 3: 添加 hover 预览样式**

在 `src/ui/styles.css` 中加入：

```css
.cqn-item-body {
  position: relative;
  min-width: 0;
}

.cqn-hover-preview {
  position: absolute;
  right: calc(100% + 12px);
  top: 0;
  display: none;
  width: min(360px, calc(100vw - 340px));
  max-height: 200px;
  overflow: auto;
  padding: 10px;
  border: 1px solid var(--cqn-border);
  border-radius: 7px;
  background: var(--cqn-bg-primary);
  color: var(--cqn-text-primary);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.28);
  font-size: 12px;
  line-height: 1.5;
  white-space: normal;
  pointer-events: none;
}

.cqn-item:hover .cqn-hover-preview {
  display: block;
}
```

如果 `.cqn-item-body` 旧规则已经存在，只保留一个合并后的 `.cqn-item-body` 规则，避免重复定义。

- [ ] **Step 4: 类型检查**

Run:

```bash
pnpm compile
```

Expected:

```text
No TypeScript errors.
```

- [ ] **Step 5: 手工验收搜索和 hover**

Run:

```bash
pnpm dev
```

Expected:

```text
WXT dev server starts without errors.
```

浏览器手工检查：
- 搜索框输入关键词，300ms 后列表过滤。
- 匹配关键词在 preview 中高亮。
- 鼠标悬停消息项，左侧出现完整预览，最大高度约 200px。
- 当前阅读附近的用户消息在侧栏中显示 active 边框。

- [ ] **Step 6: 提交 Phase 3 UI 体验**

```bash
git add src/ui/Sidebar.tsx src/ui/MessageItem.tsx src/ui/styles.css
git commit -m "feat: 完善搜索和消息预览体验" -m "为侧栏搜索增加 300ms debounce 和关键词高亮。将浏览器 title 替换为 Shadow DOM 内 hover 预览，并保持 active、mounted、cached 状态在列表中清晰展示。"
```

---

### Task 10: README、最终验证和 Phase 1-3 收口

**Files:**
- Create: `README.md`

- [ ] **Step 1: 编写 README**

写入 `README.md`：

```markdown
# ChatGPT Question Navigator

本项目是一个本地优先、隐私友好的 Chrome/Edge Manifest V3 扩展，用于在 ChatGPT 长对话页面右侧显示用户问题导航侧栏。

## 已实现范围

- 仅在 `https://chatgpt.com/*` 和 `https://chat.openai.com/*` 启用。
- 使用 WXT content script 和 Shadow DOM 注入右侧侧栏。
- 扫描当前 DOM 中 `data-message-author-role="user"` 的用户消息。
- 将已见过的用户消息缓存到 `chrome.storage.local`。
- SPA URL 切换时加载对应会话缓存。
- 侧栏展示 Q1、Q2 等问题摘要、mounted/cached 状态和 indexed 数量。
- 当前阅读附近的用户消息在侧栏高亮。
- 点击当前 DOM 中存在的问题可平滑跳转并临时高亮目标。
- 支持搜索已缓存问题和 hover 查看完整预览。

## 安装依赖

```bash
pnpm install
```

如果没有 pnpm：

```bash
npm install
```

## 开发运行

```bash
pnpm dev
```

或：

```bash
npm run dev
```

## 类型检查

```bash
pnpm compile
```

## 构建扩展

```bash
pnpm build
```

构建产物位于 `.output/chrome-mv3`。

## Chrome 加载方式

1. 打开 `chrome://extensions/`。
2. 开启右上角「开发者模式」。
3. 点击「加载已解压的扩展程序」。
4. 选择 `.output/chrome-mv3`。
5. 打开 ChatGPT 页面验证右侧导航侧栏。

## Edge 加载方式

1. 打开 `edge://extensions/`。
2. 开启左侧「开发人员模式」。
3. 点击「加载解压缩的扩展」。
4. 选择 `.output/chrome-mv3`。
5. 打开 ChatGPT 页面验证右侧导航侧栏。

## 隐私说明

扩展不调用 ChatGPT 内部 API，不 monkey patch fetch/XHR，不请求 `<all_urls>` 权限，不添加 analytics，也不会把聊天内容上传到任何服务器。已采集的问题摘要和搜索文本只保存在浏览器本地的 `chrome.storage.local`。

## 已知限制

- 扩展无法读取从未在 DOM 中出现过的历史消息。
- 第一次打开超长对话时，远处问题需要用户滚动经过后才会被缓存。
- ChatGPT 页面结构变化可能导致 DOM 识别失效。
- Phase 1-3 只支持当前 DOM 中已挂载消息的直接跳转。
- cached-only 消息的渐进式远距离跳转将在 Phase 4 实现。

## 后续路线

- Phase 4：渐进式跳转、跳转取消、失败 toast。
- 验证并启用 experimental DOM 后备选择器。
- 导出/导入缓存。
- 自定义快捷键。
```

- [ ] **Step 2: 最终类型检查**

Run:

```bash
pnpm compile
```

Expected:

```text
No TypeScript errors.
```

- [ ] **Step 3: 最终构建**

Run:

```bash
pnpm build
```

Expected:

```text
WXT build completes and creates .output/chrome-mv3.
```

- [ ] **Step 4: 最终手工验收清单**

在 Chrome 或 Edge 中加载 `.output/chrome-mv3` 后检查：
- 打开 ChatGPT 页面，右侧出现导航侧栏。
- 侧栏可折叠和展开。
- 当前 DOM 中用户消息自动显示为 Q1、Q2。
- 滚动经过新的历史问题后，侧栏增加条目。
- 刷新页面后，已采集问题仍然存在。
- 当前阅读区域附近的用户消息在侧栏 active 高亮。
- 点击当前 DOM 中存在的问题，页面平滑滚动并高亮目标。
- 搜索框可以过滤已缓存问题。
- hover 消息项可以查看较长预览。
- DevTools 控制台无持续报错。
- Manifest 权限只包含 `storage` 和 ChatGPT host permissions。

- [ ] **Step 5: 提交文档和收口**

```bash
git add README.md
git commit -m "docs: 补充 Phase 1-3 使用说明" -m "记录扩展功能范围、安装依赖、开发运行、构建、Chrome/Edge 加载方式、隐私说明、已知限制和 Phase 4 后续路线，便于验收当前阶段成果。"
```

---

## 自审结果

- Spec 覆盖：Phase 1 的工程初始化、content script 注入、Shadow DOM 侧栏、URL watcher、基础 DOM 扫描、当前 DOM 用户消息展示已覆盖；Phase 2 的本地缓存、滚动采集、刷新恢复索引、当前消息高亮已覆盖；Phase 3 的直接跳转、目标高亮、搜索框、hover preview 已覆盖。
- 明确排除：Phase 4 渐进式跳转、取消机制和失败 toast 没有混入本计划，避免提前实现复杂跳转逻辑。
- 占位扫描：计划中没有空白占位、泛化错误处理要求或缺少具体内容的代码步骤；每个代码步骤给出具体文件和内容。
- 类型一致性：`CachedUserMessage.localMessageId`、`RuntimeStore`、`MessageScanner.rescan()`、`JumpController.jumpToMessage()` 的名称在任务间保持一致。

## 执行交接

Plan complete and saved to `docs/superpowers/plans/2026-05-24-chatgpt-question-navigator-phase1-3.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
