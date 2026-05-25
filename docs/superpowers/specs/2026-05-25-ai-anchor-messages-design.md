# AI 锚点消息设计

## 概述

将 assistant turn 作为**隐藏锚点消息**写入缓存（`CachedUserMessage`，role 扩展为 `'user' | 'assistant'`）和 RuntimeStore。UI 仍只展示 user 消息，但 MessageScanner 在计算 `visibleRange` 时同时考虑 user + assistant anchor。

本设计**不替代** Phase 4 的 progressive jump；它只是提升 Phase 4 中 `decideDirection` 的可靠性。

> **命名说明**：`CachedUserMessage` 现在也承载 assistant 消息，存在语义不一致。本 PR 不重命名，跟踪于 #12。

## 动机

### 问题

渐进式跳转依赖 `visibleRange`（`minOrderKey / maxOrderKey`）判断目标相对当前视口的方向。`computeVisibleRange` 只从**已挂载的用户消息**中提取 orderKey。

ChatGPT 的 AI 回复通常比用户提问长数倍到数十倍。在渐进式跳转的滚动过程中，**大部分时间视口内只有 AI 回复**。此时没有用户消息在视口中 → `visibleRange` 为 `null` → `decideDirection` 只能默认返回 `'down'`，靠猜。如果方向错误，需要等待 `consecutiveNoOps` 纠正，效率极低。

### 方案

将 assistant turn 也存入缓存（截断文本作为摘要），使它们参与 `visibleRange` 计算。这样即使视口内只有 AI 回复，也能通过 assistant anchor 得到当前视口在 canonical messages 数组中的 index 区间，从而稳定判断目标在上方还是下方。

## 数据模型

### CachedUserMessage 扩展

```typescript
export interface CachedUserMessage {  // TODO(#12): 重命名为 CachedMessage
  conversationId: string;
  localMessageId: string;
  role: 'user' | 'assistant';  // 原 'user'，现支持 'assistant'
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
```

### 存储规则

| 属性 | 用户提问 | AI 回复（锚点） |
|------|---------|---------------|
| `role` | `'user'` | `'assistant'` |
| `localMessageId` | `convId::turn::turnKey` | `convId::turn::turnKey` |
| `textForSearch` | 完整可搜索文本 | 截断至 500 字符 |
| `preview` | 截断预览 | 截断至 200 字符 |
| `textHash` | SHA-256 前 8 字节 | SHA-256 前 8 字节（基于截断文本） |
| `orderKey` | 连续分配，保持文档顺序 | 连续分配，保持文档顺序 |
| UI 显示 | 显示 | **隐藏**（本 PR 不改 UI） |

### orderKey 分配

AutoCollector 按文档顺序（top-to-bottom）分配连续 orderKey：

```
turn 0 (user):      orderKey = 0
turn 1 (assistant): orderKey = 1
turn 2 (user):      orderKey = 2
turn 3 (assistant): orderKey = 3
...
```

这确保了 `decideDirection` 的 `<` / `>=` 比较能正确反映文档位置关系。

## 技术设计

### 变更文件

#### 1. `src/shared/types.ts`

- `CachedUserMessage.role`: `'user'` → `'user' | 'assistant'`

#### 2. `src/shared/text.ts`

- 新增常量 `AI_PREVIEW_MAX_LENGTH = 200`、`AI_SEARCH_MAX_LENGTH = 500`
- 新增 `toAiPreview(text: string): string` — 截断 AI 回复为 200 字符预览
- 新增 `toAiSearchText(text: string): string` — 截断为 500 字符搜索文本

#### 3. `src/content/autoCollector.ts`

- `buildResult()` 不再过滤 `role === 'user'`，输出所有已水合帧
- AI 帧使用截断文本函数生成 preview/textForSearch
- `orderKey` 按文档顺序连续分配（不是按 userFrames 的 index）

#### 4. `src/content/cacheStore.ts`

- `resolveScannedSegments()` 兼容 AI 消息的 dedup/merge
- `replaceConversationMessages()` 写入时包含 AI 消息
- `updateMessageScrollMeta()` 对 AI 消息同样生效
- 按 `localMessageId` 去重，role 不影响匹配逻辑

#### 5. `src/content/messageScanner.ts`

- `rescan()` 同时检测 AI turn 元素：
  - 通过 DomAdapter 查找所有可见 turn 元素
  - 已缓存的消息（含 AI）如果 DOM 元素在视口中，加入 `elementById`
  - AI 消息不需要通过 `resolveScannedSegments` 的候选流程（它们由 AutoCollector 采集）
- `computeVisibleRange()` 无需修改——它遍历 `snapshot.messages` 中所有消息的 `elementById` 映射，AI 消息进入映射后自然参与计算

#### 6. `src/content/domAdapter.ts`

- 新增 `findTurnElements(): HTMLElement[]` 返回所有 turn 元素（复用 `turnSkeleton` 选择器）
- 由调用方通过 `extractTurnRole` 识别角色

#### 7. `src/ui/Sidebar.tsx`

- 消息列表渲染前过滤：`snapshot.messages.filter(m => m.role === 'user')`
- status 文本中的 `messageCount` 改为只计用户消息数量

### 数据流

#### AutoCollector 采集路径

```
scanAllTurnSkeletons() → 所有 turn 帧建立（含 AI）
  → bottom-to-top 水合（所有帧）
  → buildResult() → 所有已水合帧转为 CachedUserMessage（含 AI）
  → replaceConversationMessages() → 写入缓存 + RuntimeStore
```

#### MessageScanner 增量扫描路径（扩展）

```
rescan()
  → findUserMessages() → 用户消息候选 → resolveScannedSegments（不变）
  → findTurnElements() → 匹配已缓存消息的 DOM 元素
    → AI 消息若在缓存中且 DOM 存在 → 加入 elementById + mountedIds
  → computeVisibleRange() → 遍历所有已缓存消息（含 AI anchor）→ 精确范围
```

#### 跳转路径（不变，自动受益）

```
jumpToCachedMessage()
  → rescan() → visibleRange 含 AI anchor
  → decideDirection(targetOrderKey, visibleRange) → 精确方向
```

### 不变更的文件

- `jumpController.ts` — 自动受益于更精确的 visibleRange
- `MiniBar.tsx` — 通过 mountedIds 渲染标记，不受 AI 消息影响
- `MessageItem.tsx` — 只接收过滤后的用户消息
- `JumpToast.tsx` — 无关
- `scrollDriver.ts` — 无关
- `ShadowRootApp.tsx` — 无新 props

### 存储影响评估

- AI 回复截断后每条约 200-300 字节（preview + textForSearch + 元数据）
- 100 轮对话（50 用户 + 50 AI）约增加 15KB
- 在 8MB 的 LRU 上限内完全可接受

## 本 PR 范围

### 包含

- 类型扩展（`role` 字段）
- AutoCollector 输出 AI 消息
- CacheStore 兼容 AI 消息
- MessageScanner 检测 AI turn 元素
- visibleRange 自动包含 AI 消息
- Sidebar 过滤只显示用户消息

### 不包含（后续 PR）

- AI 回复在侧栏的显示（需要 UI 设计：折叠/展开、样式区分）
- AI 回复的搜索支持
- AI 回复在 MiniBar 中的标记
- `CachedUserMessage` → `CachedMessage` 重命名（#12）

## 验收标准

1. AutoCollector 采集后，缓存中同时包含 `role: 'user'` 和 `role: 'assistant'` 消息
2. `orderKey` 按文档顺序连续分配（用户和 AI 交替递增）
3. 侧栏消息列表**只显示用户提问**，AI 回复不可见
4. `visibleRange` 在视口内只有 AI 回复时仍能返回有效范围
5. `decideDirection` 在 AI 回复占视口时仍能返回正确方向
6. 渐进式跳转穿越长 AI 回复区时方向不再丢失
7. 存储增长在可接受范围内（100 轮对话 < 20KB 增量）
8. `pnpm compile` 和 `pnpm build` 无错误
