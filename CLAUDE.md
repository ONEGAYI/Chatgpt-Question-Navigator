# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

ChatGPT Question Navigator — 一个 Manifest V3 浏览器扩展，在 ChatGPT 长对话页面右侧注入用户问题导航侧栏。仅通过 DOM 扫描 + 本地缓存工作，不调用 ChatGPT API、不上传数据。

目标页面：`https://chatgpt.com/*` 和 `https://chat.openai.com/*`

## 常用命令

```bash
pnpm install          # 安装依赖
pnpm dev              # 开发模式（WXT watch，输出到 .output/chrome-mv3-dev）
pnpm build            # 生产构建（输出到 .output/chrome-mv3）
pnpm build:edge       # Edge 构建
pnpm compile          # TypeScript 类型检查（tsc --noEmit）
pnpm zip              # 打包 zip
```

加载扩展：Chrome `chrome://extensions/` → 开发者模式 → 加载已解压的扩展程序 → 选择 `.output/chrome-mv3`。

## 技术栈

- **WXT** (wxt) — 浏览器扩展框架，处理 manifest 生成和 content script 构建
- **TypeScript** strict 模式，启用 `noUncheckedIndexedAccess` 和 `exactOptionalPropertyTypes`
- **Preact** — UI 渲染（通过 `@preact/preset-vite`，jsxImportSource 设为 preact）
- **Shadow DOM** — UI 样式隔离，通过 WXT 的 `createShadowRootUi` 实现
- 包管理：pnpm

## 架构

入口为 `entrypoints/content.ts`（WXT content script），装配所有模块后启动扫描和 UI。Popup 入口为 `entrypoints/popup/index.html`，WXT 自动注册为 `action.default_popup`。

### Popup 层 (`src/popup/`)

浏览器扩展 Popup 页面，通过点击扩展图标打开。使用 Preact 渲染，直接读取 `chrome.storage.local` 显示存储状态，通过 `chrome.runtime.sendMessage` 向 content script 发送缓存管理命令。

- `PopupApp.tsx` — 主组件：存储用量仪表、对话列表、缓存操作按钮（逐条删除、清空全部、LRU 清理）
- `popup.css` — Popup 样式，复用侧栏 CSS 变量体系

Popup → Content Script 通信协议：
- `{ type: 'CLEAR_CONVERSATION', id }` — 删除单个对话缓存
- `{ type: 'CLEAR_ALL' }` — 清空所有缓存
- `{ type: 'LRU_CLEANUP' }` — 手动触发 LRU 淘汰

### 内容层 (`src/content/`)

| 模块 | 职责 |
|------|------|
| `AutoCollector` | Skeleton-First Hydration 采集。三阶段流程：(1) scanAllTurnSkeletons 扫描所有 turn 骨架；(2) bottom-to-top 滚动逐帧水合（角色+文本提取）；(3) 可选 fallback top-to-bottom 补充水合。完成后通过 CacheStore.replaceConversationMessages() 原子替换缓存（canonical 顺序）。支持 cancel、跨 reload 恢复（intent 持久化）、每 20 轮 checkpoint 增量持久化 |
| `DomAdapter` | ChatGPT DOM 结构查询抽象。选择器定义在此文件顶部 `SELECTORS` 常量。仅负责 DOM 元素识别和文本提取，不涉及滚动 |
| `MessageScanner` | 核心扫描引擎。通过 MutationObserver（防抖 500ms）和 IntersectionObserver 监控 DOM 变化，将候选消息交给 CacheStore 去重合并。候选生成时通过 DomAdapter.findTurnKeyForElement 提取 turnKey。rescan 时注册 AI turn 锚点元素到 elementById（扩展 visibleRange），computeActiveMessageId 限制为 user 消息 |
| `CacheStore` | `chrome.storage.local` 持久化层。按 `conv:{id}` 分会话存储，LRU 清理（上限 8MB），防抖保存（2s）。`resolveScannedSegments` 是核心分段合并方法，`replaceConversationMessages` 用于 canonical 模式原子写入。localMessageId 优先使用 turn-based 格式。缓存同时包含 user 和 assistant 消息（AI 锚点） |
| `orderList` | 有序 ID 分段合并算法。`mergeOrderedSegments` 处理 contiguous/detached 段的 anchor-splice 合并，`inferDirectionFromScrollAnchor` 从滚动元数据推断扫描方向 |
| `RuntimeStore` | 内存中的响应式状态。通过 subscribe/emit 模式驱动 Preact UI 更新。包含 autoCollectProgress 状态 |
| `UrlWatcher` | 监听 SPA 路由变化（patch history API + popstate + 轮询），提取 conversationId 或分配临时 ID |
| `ScrollDriver` | 滚动基础设施：多源 scroll root 检测（selector / main 后代 / main 祖先 / user message 祖先链 / DOM root）+ 评分 + 最小滚动验证、操作结果追踪、viewport 判断、用户滚动方向捕获（PR #7）、运行时重检 + 诊断。无 DomAdapter 依赖。document root 候选归一化为 window kind。ChatGPT 的实际滚动容器是 `<main>` 的父级 DIV（overflowY: auto），init 时需轮询等待异步渲染完成后 redetect |
| `JumpController` | 跳转控制：已挂载消息直接 scrollIntoView + 高亮；未挂载消息渐进式跳转（scrollRatio 粗定位 + orderKey 自适应步进，JumpToken 可取消，MAX_ATTEMPTS=30）；用户滚动/Esc/新跳转自动取消当前操作 |

### UI 层 (`src/ui/`)

使用 Preact 在 Shadow DOM 内渲染，样式通过 `src/ui/styles.css` 注入（CSS 变量控制暗色/亮色主题）。

- `ShadowRootApp.tsx` — 挂载点，通过 WXT 的 `createShadowRootUi` 创建隔离容器
- `Sidebar.tsx` — 主组件，三态模式切换（展开/Mini/折叠），从 RuntimeStore 订阅状态，展开模式含清除当前会话缓存按钮（二次确认）
- `MiniBar.tsx` — Mini 模式导航条：滑动窗口（MAX_VISIBLE=7）渲染问题标记，▲/▼ 导航，hover preview
- `MessageItem.tsx` — 单条消息项，搜索高亮、hover 预览、跳转中状态
- `SearchBox.tsx` — 搜索输入（300ms 防抖）
- `JumpToast.tsx` — 跳转进度和失败状态 Toast，底部固定显示

### 共享层 (`src/shared/`)

| 文件 | 职责 |
|------|------|
| `types.ts` | 所有接口定义（CachedUserMessage, ConversationCache, RuntimeState, JumpState 等） |
| `hash.ts` | SHA-256 取前 8 字节作为文本指纹 |
| `text.ts` | 文本归一化、截断预览、搜索分词高亮 |

### 数据流

```
DOM 变化 → MutationObserver → MessageScanner.rescan()
  → DomAdapter 提取候选 → MessageScanner 按视觉 gap 切分扫描片段
  → CacheStore.resolveScannedSegments()（去重 + 分段顺序合并）
  → RuntimeStore 更新状态 → Preact UI 重渲染

URL 变化 → UrlWatcher → 加载对应会话缓存 → rescan
用户点击消息 → JumpController.jumpToMessage → ScrollDriver 滚动 + 高亮
跳转中用户滚动/Esc/新跳转 → JumpController.cancelCurrent → JumpToken 取消
用户清除会话 → scanner.stop → cacheStore.clearConversation → setMessages([]) → 3s 等待 → scanner.start（自动 rescan）
用户触发采集 → AutoCollector.startFullCollection
  → Phase 1: scanAllTurnSkeletons 扫描所有 turn 骨架
  → Phase 2: bottom-to-top 滚动逐帧水合（角色+文本提取）
  → Phase 3: 可选 fallback top-to-bottom 补充水合
  → replaceConversationMessages（canonical 顺序）→ scanner.rescan
采集恢复 → 启动时读 intent → poll scroll root → startFullCollection → scanner.start
```

### 消息身份识别

`localMessageId` 优先级：`conversationId::turn::{turnKey}`（来自 turn 骨架的 `data-testid`，skeleton-first 水合产生）> `conversationId::dom::{observedDomMessageId}`（来自 `data-id` 或 `data-message-id` 属性）> `conversationId::hash::{textHash}::{occurrenceIndex}`。这使得相同文本的多次出现能被区分。

## 开发注意事项

- **选择器集中管理**：ChatGPT DOM 选择器全部在 `DomAdapter` 的 `SELECTORS` 常量中，不要散落
- **ScrollDriver scroll root 检测**：`detectScrollRoot()` 通过多源候选（selector、main 后代、**main 祖先**、采样 user message 祖先链、标准 DOM root）+ 评分 + 最小滚动验证选择滚动根。document root 候选（HTML/BODY）归一化为 `kind:'window'`。运行时通过 `ensureValidRoot()` 在 scroll 操作前自动验证，`revalidateRoot()` / `redetectScrollRoot()` 手动重检。ChatGPT 异步渲染导致 init 时所有候选 `maxScrollTop=0`，需轮询 redetect（每秒一次，最多 10 次）。调试：**Ctrl+Shift+D** 输出诊断快照（CSP 阻止 inline `<script>` 注入，改用键盘快捷键）
- **CacheStore 的 currentCache 是单会话热缓存**：`ensureCurrentCache` 在 conversationId 不匹配时会重建，这意味着跨会话操作前需要先 `loadConversation`
- **防抖/节流常量**：定义在各自模块顶部（`MUTATION_DEBOUNCE_MS=500`, `SCROLL_THROTTLE_MS=300`, `SAVE_DEBOUNCE_MS=2000`）
- **消息顺序使用持久 orderedIds + 分段合并**：`absoluteTop` / `orderKey` 只保留为局部扫描和旧字段兼容信息，不作为全局排序依据。MessageScanner 会先按视觉 gap 切分可信局部片段，CacheStore 再通过 `orderList.mergeOrderedSegments()` 逐段合并，避免远处残留 DOM 节点成为错误 anchor
- **Canonical 模式**：AutoCollector 采集完成后通过 `replaceConversationMessages()` 原子写入 messages + orderedIds + orderMode='canonical'。在 canonical 模式下，CacheStore.resolveScannedSegments 不调用 mergeOrderedSegments，只 append 新 ID 到末尾。现有 MessageScanner 保留用于轻量增量更新（mounted state、跳转）
- **AutoCollector 跨 reload 恢复**：使用 chrome.storage.local 保存 `autoCollectIntent`，启动时在 urlWatcher.start() 之前读取 intent，匹配当前 URL 则自动恢复采集
- **渐进式跳转**：点击未挂载（cached-only）消息触发渐进式跳转循环。attempt 0 用 scrollRatio 种子定位，后续用 decideDirection + scrollOneChunk 自适应步进（viewport × 衰减系数），每步等待 500ms DOM 沉淀。最大 30 次尝试后显示失败 toast
- **跳转取消**：用户手动滚动（wheel/touch/keyboard/pointerdown）、Esc 键、或点击新目标时自动取消当前跳转。通过 JumpToken 实现可取消异步操作
- **VisibleRange 基于 orderKey**：`minOrderKey/maxOrderKey` 来自 RuntimeStore.messages 中可见消息的 orderKey 字段
- **构建产物**：`.output/` 目录，`chrome-mv3` 为生产构建，`chrome-mv3-dev` 为开发构建
- **AI 锚点消息**：缓存中同时包含 `role: 'user'` 和 `role: 'assistant'` 消息。AI 消息作为隐藏锚点参与 `visibleRange` 计算但不显示在 UI 中，也不参与 activeMessageId 计算。`CachedUserMessage` 命名待重命名为 `CachedMessage`（#12）

## 文件树

@[docs/Tree.md]

## 设计文档

完整功能规格和分阶段计划：`docs/项目脚手架及二阶段计划.md`
