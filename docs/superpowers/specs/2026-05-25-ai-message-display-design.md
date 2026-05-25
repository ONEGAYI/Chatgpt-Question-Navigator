# AI 消息侧栏展示设计

日期：2026-05-25

## 概述

在侧栏中展示 AI（assistant）消息，帮助用户通过视觉定位"这条问题对应哪条回答"。AI 消息与用户消息共享同一绿色色系，仅通过缩进、树状连接符号和引用块样式区分。两阶段实现：先展开模式，后 MiniBar。

## 已确认设计决策

1. **展示形式**：AI 消息紧跟对应 Q 消息下方，左侧用 `│└─` 树状符号连接
2. **编号**：AI 消息使用 A1/A2/A3...，与 Q1/Q2/Q3... 一一对应
3. **色系**：统一使用 `#10a37f` 绿色，不引入新颜色
4. **交互**：AI 消息可点击跳转，复用现有 JumpController 逻辑
5. **状态**：AI 消息与 Q 消息共享 active/jumping/mounted/cached 四态
6. **MiniBar**：AI 消息用缩细条（约 70% 宽度、60% 高度）紧跟 Q 标记

## 分阶段计划

### Phase 1：展开模式

#### 数据流变更

当前 `Sidebar.tsx:97` 通过 `filter(m => m.role === 'user')` 只保留用户消息。改为：

- 使用全部 `snapshot.messages`（按 orderedIds 顺序，已包含 user + assistant）
- 遍历时按角色分配编号：遇到 user 递增 Q 计数器，遇到 assistant 用相同计数器 + "A" 前缀
- 搜索过滤作用于全部消息（不再只搜索 user 消息）

#### activeMessageId 扩展

`computeActiveMessageId()` (messageScanner.ts:279) 当前仅追踪 user 消息：

```
.filter(([id]) => isUserElement(id))  // ← 硬过滤
```

移除 `isUserElement` 过滤，让定位器同时追踪 user 和 assistant 消息。当用户滚动到 AI 回答区域时，active 高亮从 Q 平滑移动到 A。

#### MessageItem 组件变更

新增 `isAssistant` prop，根据角色条件渲染：

**user 消息（保持现有布局）：**
- `cqn-item` 容器，grid 布局
- 左侧 `Q{n}` 编号标签
- 右侧预览文本 + 状态指示器

**assistant 消息（新布局）：**
- 外层 flex 容器（对齐树状符号 + 内容区）
- 左侧：`│└─` 树状符号（用 CSS `::before` / `::after` 伪元素绘制，绿色）
- 右侧：引用块样式（`border-left: 3px solid` + 浅色背景）+ `A{n}` 标签 + 预览文本 + 状态指示器
- 可点击，复用同一 `onClick` handler

#### 样式新增（styles.css）

```css
/* AI 消息容器 */
.cqn-item-ai {
  width: 100%;
  display: flex;
  padding-left: 10px;
  margin: 0 0 2px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  cursor: pointer;
  text-align: left;
  color: inherit;
}

.cqn-item-ai:hover { background: var(--cqn-bg-secondary); }

/* 树状连接器 */
.cqn-tree-connector {
  width: 28px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  color: var(--cqn-accent);
  opacity: 0.6;
  font-size: 12px;
  line-height: 1;
  padding-top: 8px;
}

/* AI 内容区（引用块样式） */
.cqn-item-ai-body {
  flex: 1;
  min-width: 0;
  border-left: 3px solid rgba(16, 163, 127, 0.4);
  border-radius: 0 7px 7px 0;
  padding: 6px 10px;
  background: rgba(16, 163, 127, 0.04);
}

/* 激活态 — 与用户消息一致 */
.cqn-item-ai.is-active {
  border-color: var(--cqn-accent);
  background: rgba(16, 163, 127, 0.12);
}
.cqn-item-ai.is-active .cqn-item-ai-body {
  border-left-color: var(--cqn-accent);
}

/* 跳转中 — 脉冲动画复用 */
.cqn-item-ai.is-jumping {
  animation: cqn-pulse 1.2s ease-in-out infinite;
}
```

#### 编号逻辑

```typescript
// 在 Sidebar 的 messages useMemo 中
let qIndex = 0;
const indexedMessages = filteredMessages.map((m) => {
  if (m.role === 'user') {
    qIndex++;
    return { message: m, label: `Q${qIndex}`, qIndex };
  }
  // assistant：使用当前 qIndex（对应紧跟的 Q）
  return { message: m, label: `A${qIndex}`, qIndex };
});
```

#### 状态栏文本

`getStatusText` 中的 `messageCount` 参数改为传入 user 消息数量（不变），因为用户认知中统计的是"问题"数量。

### Phase 2：MiniBar

#### MiniBar 数据变更

当前 MiniBar 接收 `userMessages`（只有 user 角色）。改为接收全部消息。

#### 标记渲染

- user 消息：保持现有 `.cqn-mini-mark` 横条样式
- assistant 消息：新增 `.cqn-mini-mark-ai` 样式

```css
.cqn-mini-mark-ai {
  /* 继承 .cqn-mini-mark 基础样式 */
  composes: cqn-mini-mark;
}

.cqn-mini-mark-ai::after {
  width: calc(10px * var(--cqn-mini-scale));   /* 约 70% 宽度 */
  height: calc(2px * var(--cqn-mini-scale));   /* 约 60% 高度 */
  opacity: 0.4;
}
```

#### 导航行为

▲/▼ 导航跳过 AI 标记（仅移动到 Q 标记），因为 MiniBar 的主要用途是快速定位问题。点击 AI 标记本身仍可触发跳转。

#### 滑动窗口

`MAX_VISIBLE` 仍为 7，但现在包含 AI 标记。实际可见的 Q 数量会减少（约 4 个 Q + 3 个 A）。考虑将 `MAX_VISIBLE` 提升到 10 以保持约 5 个 Q 可见。

## 影响范围

| 文件 | 变更类型 |
|------|----------|
| `src/ui/Sidebar.tsx` | 数据流：移除 user-only 过滤，新增编号逻辑 |
| `src/ui/MessageItem.tsx` | 新增 `isAssistant` prop + AI 布局 |
| `src/ui/MiniBar.tsx` | 接收全部消息，AI 标记渲染（Phase 2） |
| `src/ui/styles.css` | AI 消息样式、MiniBar AI 标记样式 |
| `src/content/messageScanner.ts` | `computeActiveMessageId` 移除 user-only 过滤 |

## 不变部分

- `CachedMessage` 类型定义不变（`role` 字段已存在）
- `CacheStore` 逻辑不变（已缓存 user + assistant 消息）
- `JumpController` 不变（已支持任意 CachedMessage 跳转）
- `AutoCollector` 不变（已采集 user + assistant 消息）
- `RuntimeStore` 类型不变（`activeMessageId` 已是 `string | null`，不限制角色）
