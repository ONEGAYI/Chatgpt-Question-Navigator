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
| `DomAdapter` | 所有 ChatGPT DOM 交互的集中抽象。选择器定义在此文件顶部 `SELECTORS` 常量。修改 DOM 识别逻辑只动这个文件 |
| `MessageScanner` | 核心扫描引擎。通过 MutationObserver（防抖 500ms）和 IntersectionObserver 监控 DOM 变化，将候选消息交给 CacheStore 去重合并 |
| `CacheStore` | `chrome.storage.local` 持久化层。按 `conv:{id}` 分会话存储，LRU 清理（上限 8MB），防抖保存（2s）。`resolveScannedCandidates` 是核心合并方法 |
| `RuntimeStore` | 内存中的响应式状态。通过 subscribe/emit 模式驱动 Preact UI 更新 |
| `UrlWatcher` | 监听 SPA 路由变化（patch history API + popstate + 轮询），提取 conversationId 或分配临时 ID |
| `ScrollDriver` | 滚动容器抽象，区分用户滚动与程序滚动 |
| `JumpController` | 跳转逻辑：已挂载消息直接跳转 + 高亮；未挂载消息渐进式跳转（scrollRatio 粗定位 + messages index 自适应步进，MAX_ATTEMPTS=30）；JumpToken 可取消 |

### UI 层 (`src/ui/`)

使用 Preact 在 Shadow DOM 内渲染，样式通过 `src/ui/styles.css` 注入（CSS 变量控制暗色/亮色主题）。

- `ShadowRootApp.tsx` — 挂载点，通过 WXT 的 `createShadowRootUi` 创建隔离容器
- `Sidebar.tsx` — 主侧栏，从 RuntimeStore 订阅状态，管理搜索和折叠
- `MessageItem.tsx` — 单条消息项，搜索高亮和 hover 预览
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
  → DomAdapter 提取候选 → CacheStore.resolveScannedCandidates()（去重合并）
  → RuntimeStore 更新状态 → Preact UI 重渲染

URL 变化 → UrlWatcher → 加载对应会话缓存 → rescan
用户点击消息 → JumpController.jumpToMessage → ScrollDriver 滚动 + 高亮
```

### 消息身份识别

`localMessageId` 优先使用 `conversationId::dom::{observedDomMessageId}`（来自 `data-id` 或 `data-message-id` 属性），退化到 `conversationId::hash::{textHash}::{occurrenceIndex}`。这使得相同文本的多次出现能被区分。

## 开发注意事项

- **选择器集中管理**：ChatGPT DOM 选择器全部在 `DomAdapter` 的 `SELECTORS` 常量中，不要散落
- **CacheStore 的 currentCache 是单会话热缓存**：`ensureCurrentCache` 在 conversationId 不匹配时会重建，这意味着跨会话操作前需要先 `loadConversation`
- **防抖/节流常量**：定义在各自模块顶部（`MUTATION_DEBOUNCE_MS=500`, `SCROLL_THROTTLE_MS=300`, `SAVE_DEBOUNCE_MS=2000`）
- **消息顺序使用持久 orderedIds**：`absoluteTop` / `orderKey` 只保留为局部扫描和旧字段兼容信息，不作为全局排序依据。新消息通过 anchor-splice 插入 `orderedIds`，已有消息的全局相对顺序默认不改
- **渐进式跳转**：点击未挂载（cached-only）消息触发渐进式跳转循环。attempt 0 用 scrollRatio 种子定位，后续用 decideDirection + scrollOneChunk 自适应步进（viewport × 衰减系数），每步等待 500ms DOM 沉淀。最大 30 次尝试后显示失败 toast
- **跳转取消**：用户手动滚动（wheel/touch/keyboard/pointerdown）、Esc 键、或点击新目标时自动取消当前跳转。通过 JumpToken 实现可取消异步操作
- **orderKey 稳定性**：cacheStore 使用 orderedIds + anchor-splice 合并模型（`orderList.ts`），匹配消息保持原 orderKey，新消息在锚点间插入。排序由 orderedIds 控制，不依赖 orderKey 数值排序
- **构建产物**：`.output/` 目录，`chrome-mv3` 为生产构建，`chrome-mv3-dev` 为开发构建

## 文件树

@[docs/Tree.md]

## 设计文档

完整功能规格和分阶段计划：`docs/项目脚手架及二阶段计划.md`
