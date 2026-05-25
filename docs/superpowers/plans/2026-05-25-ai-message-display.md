# AI 消息侧栏展示 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在侧栏中展示 AI（assistant）消息，帮助用户视觉定位"这条问题对应哪条回答"。两阶段交付：Phase 1 展开模式，Phase 2 MiniBar。

**Architecture:** 复用现有 CachedMessage.role 字段和有序消息列表。UI 层新增 AI 消息布局组件（树状符号 + 引用块），底层 computeActiveMessageId 扩展为追踪所有角色。JumpController 无需修改。

**Tech Stack:** TypeScript strict, Preact (JSX), Shadow DOM CSS

---

## File Structure

| 文件 | 职责 | 操作 |
|------|------|------|
| `src/content/messageScanner.ts` | computeActiveMessageId 移除 user-only 过滤 | 修改 |
| `src/ui/styles.css` | AI 消息样式（展开 + Mini） | 修改 |
| `src/ui/MessageItem.tsx` | 新增 isAssistant prop，条件渲染 AI 布局 | 修改 |
| `src/ui/Sidebar.tsx` | 移除 user-only 过滤，新增编号逻辑，传递 label | 修改 |
| `src/ui/MiniBar.tsx` | 接收全部消息，AI 细条标记，导航跳过 AI | 修改（Phase 2） |

---

## Phase 1：展开模式

### Task 1: computeActiveMessageId 扩展

**Files:**
- Modify: `src/content/messageScanner.ts:279-303`

**目的：** 让定位器同时追踪 user 和 assistant 消息，使 active 高亮能在 Q 和 A 之间平滑移动。

- [ ] **Step 1: 移除 isUserElement 过滤**

将 `computeActiveMessageId()` 中的 `.filter(([id]) => isUserElement(id))` 两处都删除。`isUserElement` 辅助函数也一并移除。

修改后的完整方法：

```typescript
private computeActiveMessageId(): string | null {
  const viewport = this.scrollDriver.getViewportRect();

  const entries = Array.from(this.elementById.entries())
    .map(([id, element]) => ({ id, rect: element.getBoundingClientRect() }))
    .filter(({ rect }) => rect.bottom >= viewport.top && rect.top <= viewport.bottom);

  const visibleBelowTop = entries
    .filter(({ rect }) => rect.top >= viewport.top)
    .sort((a, b) => a.rect.top - b.rect.top)[0];
  if (visibleBelowTop) return visibleBelowTop.id;

  const nearestAbove = Array.from(this.elementById.entries())
    .map(([id, element]) => ({ id, rect: element.getBoundingClientRect() }))
    .filter(({ rect }) => rect.top < viewport.top)
    .sort((a, b) => b.rect.top - a.rect.top)[0];

  return nearestAbove?.id ?? null;
}
```

同时删除不再需要的 `snapshot` 和 `messageById` 变量（原 L280-282）。

- [ ] **Step 2: 验证类型检查通过**

Run: `pnpm compile`
Expected: 无类型错误

- [ ] **Step 3: 提交**

```bash
git add src/content/messageScanner.ts
git commit -m "feat: computeActiveMessageId 追踪所有角色消息

移除 isUserElement 过滤，让 active 高亮能在 user 和 assistant
消息之间平滑移动。当用户滚动到 AI 回答区域时，侧栏定位器
会从 Q 移动到对应的 A。"
```

---

### Task 2: CSS 样式新增

**Files:**
- Modify: `src/ui/styles.css`

**目的：** 为 AI 消息添加完整的视觉样式——树状连接器、引用块、激活态、跳转态。

- [ ] **Step 1: 在 `.cqn-item-meta` 规则之后（约 L175）、`.cqn-hover-preview` 规则之前，插入 AI 消息样式**

在 `styles.css` 的第 175 行（`.cqn-item-meta` 结束）之后、第 177 行（`.cqn-hover-preview`）之前，插入以下 CSS：

```css
/* --- AI message (assistant) --- */

.cqn-item-ai {
  width: 100%;
  display: flex;
  gap: 0;
  margin: 0 0 2px;
  padding-left: 10px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  text-align: left;
}

.cqn-item-ai:hover {
  background: var(--cqn-bg-secondary);
}

.cqn-item-ai.is-active {
  border-color: var(--cqn-accent);
  background: rgba(16, 163, 127, 0.12);
}

.cqn-item-ai.is-jumping {
  animation: cqn-pulse 1.2s ease-in-out infinite;
}

.cqn-tree-connector {
  width: 28px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  padding-top: 6px;
  color: var(--cqn-accent);
  opacity: 0.6;
  font-size: 13px;
  line-height: 1;
  user-select: none;
}

.cqn-tree-connector-line {
  line-height: 1;
}

.cqn-tree-connector-branch {
  line-height: 1;
  margin-top: -2px;
}

.cqn-item-ai-body {
  flex: 1;
  min-width: 0;
  border-left: 3px solid rgba(16, 163, 127, 0.4);
  border-radius: 0 7px 7px 0;
  padding: 6px 10px;
  background: rgba(16, 163, 127, 0.04);
}

.cqn-item-ai.is-active .cqn-item-ai-body {
  border-left-color: var(--cqn-accent);
}

.cqn-item-ai.is-active .cqn-tree-connector {
  opacity: 1;
}

.cqn-item-ai-label {
  color: var(--cqn-accent);
  font-size: 12px;
  font-weight: 700;
}

.cqn-item-ai-preview {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  line-height: 1.4;
  color: var(--cqn-text-secondary);
}

.cqn-item-ai.is-active .cqn-item-ai-preview {
  color: var(--cqn-text-primary);
}

.cqn-item-ai-meta {
  display: block;
  margin-top: 3px;
  font-size: 11px;
  color: var(--cqn-text-secondary);
}
```

- [ ] **Step 2: 验证构建通过**

Run: `pnpm build`
Expected: 构建成功，无错误

- [ ] **Step 3: 提交**

```bash
git add src/ui/styles.css
git commit -m "feat: 新增 AI 消息 CSS 样式

包含树状连接器（│└─）、引用块布局、激活/跳转态。
统一绿色色系，通过缩进和结构区分 AI 与用户消息。"
```

---

### Task 3: MessageItem 组件扩展

**Files:**
- Modify: `src/ui/MessageItem.tsx`

**目的：** MessageItem 新增 `isAssistant` + `label` prop，条件渲染 user 或 AI 布局。

- [ ] **Step 1: 扩展 MessageItemProps 接口，新增 isAssistant 和 label**

修改 `MessageItem.tsx` 的 Props 接口，在 `searchQuery` 后新增两个字段：

```typescript
interface MessageItemProps {
  message: CachedMessage;
  index: number;
  active: boolean;
  mounted: boolean;
  isJumping?: boolean;
  searchQuery: string;
  isAssistant?: boolean;
  label: string;   // "Q1" 或 "A1"
  onClick: (message: CachedMessage) => void;
  onHoverStart?: (message: CachedMessage, rect: DOMRect) => void;
  onHoverEnd?: () => void;
}
```

- [ ] **Step 2: 解构新 props**

在组件函数参数中解构 `isAssistant` 和 `label`：

```typescript
function MessageItemComponent({
  message, index, active, mounted, isJumping, searchQuery,
  isAssistant, label,
  onClick, onHoverStart, onHoverEnd,
}: MessageItemProps) {
```

- [ ] **Step 3: 添加 AI 布局分支**

在 `handleMouseEnter` 函数之后、`return` 语句之前，插入条件分支。将现有 `return` 包裹的 JSX 改为：

```tsx
const metaText = isJumping ? '⟳ 跳转中…' : mounted ? '● 当前可跳转' : '○ 已缓存';

// --- AI 消息布局 ---
if (isAssistant) {
  const handleAiMouseEnter = (e: MouseEvent) => {
    const target = (e.currentTarget as HTMLElement).querySelector<HTMLElement>('.cqn-item-ai-body');
    if (target && onHoverStart) {
      onHoverStart(message, target.getBoundingClientRect());
    }
  };

  return (
    <button
      className={`cqn-item-ai${active ? ' is-active' : ''}${isJumping ? ' is-jumping' : ''}`}
      type="button"
      onClick={() => onClick(message)}
      onMouseEnter={handleAiMouseEnter}
      onMouseLeave={onHoverEnd}
    >
      <span className="cqn-tree-connector" aria-hidden="true">
        <span className="cqn-tree-connector-line">│</span>
        <span className="cqn-tree-connector-branch">└─</span>
      </span>
      <span className="cqn-item-ai-body">
        <span className="cqn-item-ai-label">{label}</span>
        <span className="cqn-item-ai-preview">
          {parts.map((part) => part.match ? <mark>{part.text}</mark> : <span>{part.text}</span>)}
        </span>
        <span className="cqn-item-ai-meta">{metaText}</span>
      </span>
    </button>
  );
}

// --- 用户消息布局（保持现有，替换 metaText） ---
```

然后将原有 return 中的 meta 行：
```tsx
{isJumping ? '⟳ 跳转中…' : mounted ? '● 当前可跳转' : '○ 已缓存'}
```
替换为：
```tsx
{metaText}
```

同时将原有的 `<span className="cqn-item-index">Q{index + 1}</span>` 替换为：
```tsx
<span className="cqn-item-index">{label}</span>
```

- [ ] **Step 4: 验证类型检查通过**

Run: `pnpm compile`
Expected: 无类型错误（注意此时 Sidebar 尚未传递新 props，会有参数缺失错误——这是预期的，下一步修复）

- [ ] **Step 5: 提交**

```bash
git add src/ui/MessageItem.tsx
git commit -m "feat: MessageItem 支持 AI 消息布局

新增 isAssistant 和 label prop，条件渲染树状连接器 + 引用块。
用户消息布局保持不变，仅将编号改为动态 label。"
```

---

### Task 4: Sidebar 数据流和编号逻辑

**Files:**
- Modify: `src/ui/Sidebar.tsx`

**目的：** 移除 user-only 过滤，实现 Q/A 编号逻辑，传递新 props 给 MessageItem，修复状态栏计数。

- [ ] **Step 1: 替换 userMessages 为全部消息 + 编号逻辑**

将 Sidebar.tsx 第 97-102 行的 `userMessages` 和 `messages` 两个 useMemo 替换为一个：

```typescript
const indexedMessages = useMemo(() => {
  const query = searchQuery.trim().toLowerCase();
  let qIndex = 0;
  return snapshot.messages
    .filter((m) => {
      if (!query) return true;
      return m.textForSearch.toLowerCase().includes(query);
    })
    .map((m) => {
      if (m.role === 'user') {
        qIndex++;
        return { message: m, label: `Q${qIndex}` as const, isAssistant: false };
      }
      return { message: m, label: `A${qIndex}` as const, isAssistant: true };
    });
}, [snapshot.messages, searchQuery]);

const userCount = useMemo(
  () => snapshot.messages.filter((m) => m.role === 'user').length,
  [snapshot.messages]
);
```

- [ ] **Step 2: 更新状态栏调用**

将第 226 行的 `getStatusText(collectPhase, snapshot.autoCollectProgress, userMessages.length)` 改为：

```tsx
{getStatusText(collectPhase, snapshot.autoCollectProgress, userCount)}
```

- [ ] **Step 3: 更新展开模式的消息列表渲染**

将第 237-249 行的 messages.map 替换为：

```tsx
{indexedMessages.map(({ message, label, isAssistant }) => (
  <MessageItem
    key={message.localMessageId}
    message={message}
    index={0}
    active={snapshot.activeMessageId === message.localMessageId}
    mounted={snapshot.mountedIds.has(message.localMessageId)}
    isJumping={snapshot.jumpState.status === 'jumping' && snapshot.jumpState.targetId === message.localMessageId}
    searchQuery={searchQuery}
    isAssistant={isAssistant}
    label={label}
    onClick={handleJump}
    onHoverStart={(msg, rect) => setHover({ message: msg, rect })}
    onHoverEnd={() => setHover(null)}
  />
))}
```

注意：`index` prop 不再用于编号（已由 `label` 替代），传 `0` 作为占位。后续可考虑移除 `index` prop，但不在本次变更范围。

- [ ] **Step 4: 更新 Mini 模式的 messages 传递**

第 149 行的 `<MiniBar messages={userMessages}` 暂时改为传入 user-only 消息（Phase 2 再改）：

```tsx
<MiniBar
  messages={snapshot.messages.filter((m) => m.role === 'user')}
  activeMessageId={snapshot.activeMessageId}
  mountedIds={snapshot.mountedIds}
  onJump={handleJump}
  onExpand={() => handleModeChange('expanded')}
/>
```

- [ ] **Step 5: 更新 hover preview 的 hover state 兼容**

hover preview 部分无需修改——它只读取 `hover.message.textForSearch`，对 user/assistant 消息都适用。

- [ ] **Step 6: 验证类型检查通过**

Run: `pnpm compile`
Expected: 无类型错误

- [ ] **Step 7: 构建验证**

Run: `pnpm build`
Expected: 构建成功

- [ ] **Step 8: 提交**

```bash
git add src/ui/Sidebar.tsx
git commit -m "feat: 侧栏展示 AI 消息（展开模式）

- 移除 user-only 过滤，全部消息按序展示
- 新增 Q/A 编号逻辑（Q1→A1→Q2→A2...）
- 搜索过滤作用于全部消息
- 状态栏计数保持仅统计用户消息数量
- MiniBar 暂保持 user-only（Phase 2 适配）"
```

---

### Task 5: 手动验证（用户验收点）

**目的：** 在浏览器中验证 Phase 1 展开模式的效果。

- [ ] **Step 1: 构建并加载扩展**

```bash
pnpm dev
```

在 Chrome 加载 `.output/chrome-mv3-dev` 目录，打开一个 ChatGPT 长对话。

- [ ] **Step 2: 验收清单**

逐项确认：

1. **AI 消息可见**：每个 Q 消息下方出现对应的 A 消息，带 `│└─` 树状符号
2. **编号正确**：Q1/A1/Q2/A2/Q3/A3... 按序排列
3. **颜色统一**：AI 消息使用绿色色系，不是紫色或其他颜色
4. **激活态**：滚动页面，定位器在 Q 和 A 之间平滑移动，高亮效果一致
5. **跳转功能**：点击 AI 消息能跳转到对应回答位置
6. **跳转中状态**：跳转时 AI 消息显示脉冲动画
7. **hover 预览**：hover AI 消息时显示完整文本预览
8. **搜索**：输入关键词能同时匹配 Q 和 A 消息
9. **状态栏**：仍显示 "Indexed N questions"（N 为用户消息数量）
10. **Mini 模式不变**：MiniBar 仍只显示 Q 标记

- [ ] **Step 3: 用户确认后提交验收标记**

此步骤由用户手动确认。

---

## Phase 2：MiniBar 适配

> **前置条件：Phase 1 用户验收通过**

### Task 6: MiniBar CSS 样式

**Files:**
- Modify: `src/ui/styles.css`

**目的：** 为 MiniBar 中的 AI 标记添加缩细条样式。

- [ ] **Step 1: 在 `.cqn-mini-expand:hover` 规则之后插入 Mini AI 标记样式**

在 `styles.css` 的 `.cqn-mini-expand:hover` 块（约 L287）之后、`.cqn-collect-spinner` 之前，插入：

```css
.cqn-mini-mark-ai {
  position: relative;
  display: block;
  width: calc(20px * var(--cqn-mini-scale));
  height: calc(8px * var(--cqn-mini-scale));
  cursor: pointer;
  border: 0;
  padding: 0;
  margin-top: 0;
  background: transparent;
}

.cqn-mini-mark-ai::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: calc(10px * var(--cqn-mini-scale));
  height: calc(2px * var(--cqn-mini-scale));
  border-radius: calc(1px * var(--cqn-mini-scale));
  background: var(--cqn-accent);
  opacity: 0.35;
}

.cqn-mini-mark-ai.is-mounted::after {
  opacity: 0.5;
}

.cqn-mini-mark-ai.is-active::after {
  width: calc(14px * var(--cqn-mini-scale));
  height: calc(3px * var(--cqn-mini-scale));
  border-radius: calc(1.5px * var(--cqn-mini-scale));
  opacity: 1;
  box-shadow: 0 0 calc(6px * var(--cqn-mini-scale)) rgba(16, 163, 127, 0.4);
}
```

- [ ] **Step 2: 提交**

```bash
git add src/ui/styles.css
git commit -m "feat: MiniBar AI 标记 CSS 样式

缩细条（约 70% 宽度、60% 高度），绿色色系统一。
支持 active/mounted/cached 三态。"
```

---

### Task 7: MiniBar 组件适配

**Files:**
- Modify: `src/ui/MiniBar.tsx`

**目的：** MiniBar 接收全部消息，AI 消息渲染为缩细条，▲/▼ 导航跳过 AI 标记。

- [ ] **Step 1: 修改导航逻辑，▲/▼ 仅在 Q 消息之间移动**

将 `handlePrev` 和 `handleNext` 改为跳过 assistant 消息：

```typescript
const handlePrev = () => {
  // 从当前 activeIdx 向前找最近的 user 消息
  for (let i = activeIdx - 1; i >= 0; i--) {
    const prev = messages[i];
    if (prev && prev.role === 'user') {
      onJump(prev);
      return;
    }
  }
};

const handleNext = () => {
  // 从当前 activeIdx 向后找最近的 user 消息
  for (let i = activeIdx + 1; i < messages.length; i++) {
    const next = messages[i];
    if (next && next.role === 'user') {
      onJump(next);
      return;
    }
  }
};
```

- [ ] **Step 2: 修改 canPrev / canNext 判断**

```typescript
const canPrev = activeIdx > 0 && messages.slice(0, activeIdx).some((m) => m.role === 'user');
const canNext = activeIdx < messages.length - 1 && messages.slice(activeIdx + 1).some((m) => m.role === 'user');
```

- [ ] **Step 3: 修改标记渲染，区分 user/assistant**

将 `visible.map` 中的渲染逻辑改为：

```tsx
{visible.map(({ message, originalIndex }) => {
  const isActive = message.localMessageId === activeMessageId;
  const isMounted = mountedIds.has(message.localMessageId);
  const stateClass = isActive ? 'is-active' : isMounted ? 'is-mounted' : 'is-cached';
  const isAi = message.role === 'assistant';

  return (
    <button
      key={message.localMessageId}
      className={`cqn-mini-mark${isAi ? '-ai' : ''} ${stateClass}`}
      type="button"
      onClick={() => onJump(message)}
      onMouseEnter={(e) => handleMarkHover(e, message, originalIndex)}
      onMouseLeave={() => setHover(null)}
      aria-label={isAi ? `A${originalIndex + 1}` : `Q${originalIndex + 1}`}
    />
  );
})}
```

- [ ] **Step 4: 修改 hover preview 标签**

将 hover preview 中的 `Q{hover.index + 1}` 改为根据角色显示：

```tsx
<span style={{ color: 'var(--cqn-accent)', fontSize: '9px', fontWeight: 700, display: 'block', marginBottom: '3px' }}>
  {hover.message.role === 'assistant' ? 'A' : 'Q'}{/* 编号从原始 index 推导 */}
</span>
```

不过 hover.index 是滑动窗口内的偏移索引，不能直接用作 Q/A 编号。需要传入原始 index 中的 user 计数。最简单的方案：在 visible 计算时预计算 label：

在 `visible` 的 useMemo 中，增加 label 计算：

```typescript
const visible = useMemo(() => {
  const { start, end } = getVisibleRange(messages.length, activeIdx);
  let qCount = 0;
  // 先计数 start 之前的 user 消息
  for (let i = 0; i < start; i++) {
    if (messages[i]?.role === 'user') qCount++;
  }
  return messages.slice(start, end).map((msg) => {
    if (msg.role === 'user') {
      qCount++;
      return { message: msg, originalIndex: start + messages.slice(start, end).indexOf(msg), label: `Q${qCount}` };
    }
    return { message: msg, originalIndex: start + messages.slice(start, end).indexOf(msg), label: `A${qCount}` };
  });
}, [messages, activeIdx]);
```

但 `indexOf` 在 map 内使用不正确。更简洁的方案——在 MiniBar 内直接使用 originalIndex（在全部消息数组中的位置）来推断编号：

```typescript
const visible = useMemo(() => {
  const { start, end } = getVisibleRange(messages.length, activeIdx);
  return messages.slice(start, end).map((msg, i) => {
    // 计算此消息之前的 user 消息数量作为编号
    let qBefore = 0;
    for (let j = 0; j <= start + i; j++) {
      if (messages[j]?.role === 'user') qBefore++;
    }
    const label = msg.role === 'user' ? `Q${qBefore}` : `A${qBefore}`;
    return { message: msg, originalIndex: start + i, label };
  });
}, [messages, activeIdx]);
```

然后更新 hover 渲染：

```tsx
<span style={{ color: 'var(--cqn-accent)', fontSize: '9px', fontWeight: 700, display: 'block', marginBottom: '3px' }}>
  {hover.label}
</span>
```

为此需要扩展 `HoverState` 接口：

```typescript
interface HoverState {
  message: CachedMessage;
  rect: DOMRect;
  index: number;
  label: string;
}
```

以及 `handleMarkHover` 调用时传入 label：

```tsx
onMouseEnter={(e) => handleMarkHover(e, message, originalIndex, label)}
```

对应修改 `handleMarkHover`：

```typescript
const handleMarkHover = (e: MouseEvent, message: CachedMessage, index: number, label: string) => {
  const target = e.currentTarget as HTMLElement;
  setHover({ message, rect: target.getBoundingClientRect(), index, label });
};
```

- [ ] **Step 5: 验证类型检查通过**

Run: `pnpm compile`
Expected: 无类型错误

- [ ] **Step 6: 提交**

```bash
git add src/ui/MiniBar.tsx
git commit -m "feat: MiniBar 展示 AI 消息标记

- AI 消息渲染为缩细条（视觉区分但同色系）
- ▲/▼ 导航跳过 AI 标记，仅在 Q 消息之间移动
- hover 预览显示正确的 A/Q 编号"
```

---

### Task 8: Sidebar Mini 模式传入全部消息

**Files:**
- Modify: `src/ui/Sidebar.tsx`

**目的：** 将 MiniBar 的 messages 从 user-only 改为全部消息。

- [ ] **Step 1: 修改 Sidebar 中 Mini 模式的 messages prop**

将 Sidebar.tsx Mini 模式中的：

```tsx
<MiniBar
  messages={snapshot.messages.filter((m) => m.role === 'user')}
  ...
/>
```

改为：

```tsx
<MiniBar
  messages={snapshot.messages}
  activeMessageId={snapshot.activeMessageId}
  mountedIds={snapshot.mountedIds}
  onJump={handleJump}
  onExpand={() => handleModeChange('expanded')}
/>
```

- [ ] **Step 2: 提升滑动窗口 MAX_VISIBLE**

MiniBar.tsx 中的 `MAX_VISIBLE` 从 7 改为 10，以保持约 5 个 Q 可见（加上对应的 A 标记）：

```typescript
const MAX_VISIBLE = 10;
const HALF_WINDOW = Math.floor(MAX_VISIBLE / 2);
```

- [ ] **Step 3: 验证构建**

Run: `pnpm build`
Expected: 构建成功

- [ ] **Step 4: 提交**

```bash
git add src/ui/Sidebar.tsx src/ui/MiniBar.tsx
git commit -m "feat: MiniBar 传入全部消息，滑动窗口扩展到 10

MAX_VISIBLE 从 7 提升到 10，以容纳 AI 标记后仍保持约 5 个
Q 标记可见。"
```

---

### Task 9: 手动验证 Phase 2（用户验收点）

- [ ] **Step 1: 构建并加载扩展**

```bash
pnpm dev
```

- [ ] **Step 2: 验收清单**

1. **Mini AI 标记可见**：每个 Q 横条下方出现缩细的 AI 标记
2. **AI 标记样式**：更短更细，绿色但透明度略低
3. **AI 标记点击跳转**：点击 AI 标记能跳转到对应回答位置
4. **AI 标记激活态**：滚动到 AI 回答时，对应标记高亮
5. **▲/▼ 导航**：仅在 Q 标记之间移动，跳过 AI 标记
6. **hover 预览**：hover AI 标记显示 "A1/A2..." 编号 + 预览文本
7. **滑动窗口**：同时可见约 5 个 Q + 4 个 A（MAX_VISIBLE=10）
8. **展开模式不受影响**：切换回展开模式，Phase 1 功能正常

- [ ] **Step 3: 用户确认后完成**

此步骤由用户手动确认。

---

### Task 10: CLAUDE.md 更新

**Files:**
- Modify: `CLAUDE.md`

**目的：** 更新项目文档反映 AI 消息展示功能。

- [ ] **Step 1: 更新 "AI 锚点消息" 相关描述**

将 CLAUDE.md 中 "AI 消息作为隐藏锚点参与 visibleRange 计算但不显示在 UI 中" 修改为反映新行为：

找到 `AI 锚点消息` 相关段落（在 "开发注意事项" 区域），将：

> AI 消息作为隐藏锚点参与 visibleRange 计算但不显示在 UI 中，也不参与 activeMessageId 计算

替换为：

> AI 消息在 UI 中以树状缩进 + A1/A2 编号展示，与用户消息共享同一色系。点击可跳转，参与 activeMessageId 追踪和 visibleRange 计算

- [ ] **Step 2: 提交**

```bash
git add CLAUDE.md
git commit -m "docs: 更新 CLAUDE.md 反映 AI 消息展示功能"
```
