# AI 加载动画 + 流式期间防抖优化

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 AI 骨架消息中显示三点跳动加载动画，流式输出期间降低 rescan 频率以优化性能。

**Architecture:** UI 层通过 `preview === '' && isAssistant` 隐式检测流式状态显示 CSS 动画；MessageScanner 在无新 turn 出现的流式场景中延长防抖时间（500ms → 3000ms）。不引入新模块，最小化改动。

**Tech Stack:** TypeScript, Preact, CSS Keyframes, WXT (Manifest V3)

---

## Context

上一轮修复中，`MessageScanner.rescan()` 的 assistant 分支已能从 DOM 提取实际文本（`findRoleElementInTurn` + `extractText`）。流式输出中文本为空（骨架），完成后文本非空（自动填充）。这意味着 rescan 路径本身已能正确采集文本，无需额外的 StreamMonitor 模块。

当前仍有的两个问题：
1. **UI 缺少流式状态指示** — AI 骨架在侧栏中显示为空白行，用户无法区分"正在生成"和"无内容"
2. **流式期间 rescan 频率过高** — MutationObserver 每 500ms 触发一次全量 rescan，但流式中数据无变化（dirty=false）

---

## File Structure

| File | Change | Responsibility |
|------|--------|----------------|
| `src/ui/MessageItem.tsx` | Modify | 空 preview 的 assistant 显示三点跳动动画 |
| `src/ui/MiniBar.tsx` | Modify | 流式中的 AI 标记使用呼吸动画 |
| `src/ui/styles.css` | Modify | 新增 `@keyframes cqn-dot-bounce` + 流式样式 |
| `src/content/messageScanner.ts` | Modify | 流式期间延长防抖时间；清理临时日志 |
| `src/content/cacheStore.ts` | Modify | 清理临时日志 |

**不需要修改的文件：**
- `src/shared/types.ts` — 使用 `preview === ''` 隐式判断流式状态
- `src/content/cacheStore.ts` — resolveScannedSegments 逻辑无需改动
- `src/content/domAdapter.ts` — 已有所需方法
- `src/content/AutoCollector.ts` — 全量采集路径独立

---

### Task 1: MessageItem 加载动画

**Files:**
- Modify: `src/ui/MessageItem.tsx`
- Modify: `src/ui/styles.css`

- [ ] **Step 1: MessageItem 中添加流式检测和三点动画**

在 `MessageItem.tsx` 的 `isAssistant` 渲染分支中，修改 `cqn-item-ai-preview` 部分。

**当前代码**（约行 35-37）：
```typescript
        <span className="cqn-item-ai-preview">
          {parts.map((part) => part.match ? <mark>{part.text}</mark> : <span>{part.text}</span>)}
        </span>
```

**替换为**：
```typescript
        <span className="cqn-item-ai-preview">
          {message.preview
            ? parts.map((part, i) => part.match
              ? <mark key={i}>{part.text}</mark>
              : <span key={i}>{part.text}</span>)
            : <span className="cqn-streaming-dots" aria-label="AI 正在生成">
                <span /><span /><span />
              </span>
          }
        </span>
```

关键点：
- 使用 `message.preview` 的真值判断（空字符串 = 流式中）
- `className` 而非 `class`（Preact + JSX 配置）
- 自闭合 `<span />` 在 Preact 中会正确渲染为 `<span></span>` 空元素

- [ ] **Step 2: CSS 中添加三点跳动动画**

在 `src/ui/styles.css` 文件末尾（`@keyframes cqn-pulse` 之后）添加：

```css
/* --- AI Streaming Dots Animation --- */

@keyframes cqn-dot-bounce {
  0%, 80%, 100% {
    transform: translateY(0);
    opacity: 0.35;
  }
  40% {
    transform: translateY(-5px);
    opacity: 1;
  }
}

.cqn-streaming-dots {
  display: inline-flex;
  gap: 3px;
  align-items: center;
  padding: 2px 0;
}

.cqn-streaming-dots span {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--cqn-accent);
  animation: cqn-dot-bounce 1.4s ease-in-out infinite;
}

.cqn-streaming-dots span:nth-child(1) {
  animation-delay: 0s;
}

.cqn-streaming-dots span:nth-child(2) {
  animation-delay: 0.2s;
}

.cqn-streaming-dots span:nth-child(3) {
  animation-delay: 0.4s;
}
```

动画设计说明：
- 三个圆点交错跳动（0s / 0.2s / 0.4s delay），产生波浪效果
- `translateY(-5px)` 向上弹跳，`opacity` 从 0.35 到 1 的渐变增加视觉层次
- `1.4s` 周期匹配现有的 `cqn-pulse` 动画节奏

- [ ] **Step 3: 运行类型检查**

Run: `pnpm compile`
Expected: PASS

---

### Task 2: MiniBar 流式指示器

**Files:**
- Modify: `src/ui/MiniBar.tsx`
- Modify: `src/ui/styles.css`

- [ ] **Step 1: MiniBar.tsx 中检测流式状态并添加 class**

在 `MiniBar.tsx` 中（约行 96-113），给流式 AI 标记添加 `is-streaming` class：

**当前代码**（约行 103）：
```typescript
  const isAi = message.role === 'assistant';

  return (
    <button
      key={message.localMessageId}
      className={`cqn-mini-mark${isAi ? '-ai' : ''} ${stateClass}`}
```

**替换为**：
```typescript
  const isAi = message.role === 'assistant';
  const isStreaming = isAi && !message.preview;
  const streamClass = isStreaming ? ' is-streaming' : '';

  return (
    <button
      key={message.localMessageId}
      className={`cqn-mini-mark${isAi ? '-ai' : ''} ${stateClass}${streamClass}`}
```

- [ ] **Step 2: 为流式中的 AI 标记添加呼吸动画**

在 `src/ui/styles.css` 中，在 `.cqn-mini-mark-ai` 相关样式之后添加：

```css
/* 流式输出中的 AI 标记 — 呼吸动画 */
.cqn-mini-mark-ai.is-streaming::after {
  animation: cqn-streaming-pulse 1.4s ease-in-out infinite;
}

@keyframes cqn-streaming-pulse {
  0%, 100% {
    opacity: 0.2;
    transform: translate(-50%, -50%) scaleX(0.7);
  }
  50% {
    opacity: 0.8;
    transform: translate(-50%, -50%) scaleX(1.3);
  }
}
```

动画设计说明：
- 复用 `.cqn-mini-mark-ai::after` 的基础样式（已有 `position: absolute; content: ''` 等）
- `scaleX(0.7)` → `scaleX(1.3)` 产生宽度呼吸效果，`opacity` 0.2 → 0.8 增加可见度变化
- 必须在每个关键帧中包含 `translate(-50%, -50%)` 以保持居中定位

- [ ] **Step 3: 运行类型检查**

Run: `pnpm compile`
Expected: PASS

---

### Task 3: MessageScanner 流式期间防抖优化

**Files:**
- Modify: `src/content/messageScanner.ts`

- [ ] **Step 1: 修改 MutationObserver handler 支持动态防抖**

在 `start()` 方法中，将 MutationObserver 回调改为检测新 turn 的智能判断：

**当前代码**（约行 42-43）：
```typescript
    this.mutationObserver = new MutationObserver(() => this.scheduleRescan());
    this.mutationObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
```

**替换为**：
```typescript
    this.mutationObserver = new MutationObserver((records) => this.handleMutations(records));
    this.mutationObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
```

新增 `handleMutations` 方法和常量：

在文件顶部常量区域添加：
```typescript
const STREAMING_DEBOUNCE_MS = 3000;
```

在类中新增方法：
```typescript
  private handleMutations(records: MutationRecord[]): void {
    const TURN_SELECTOR = 'section[data-testid^="conversation-turn-"]';
    const hasNewTurn = records.some((record) =>
      Array.from(record.addedNodes).some((node) =>
        node instanceof HTMLElement
        && (node.matches?.(TURN_SELECTOR) || node.querySelector?.(TURN_SELECTOR))
      )
    );

    if (hasNewTurn) {
      // 新 turn 出现 → 正常防抖（快速响应新消息）
      this.scheduleRescan();
    } else {
      // 无新 turn → 可能是流式文本变化，使用较长防抖
      this.scheduleRescan(STREAMING_DEBOUNCE_MS);
    }
  }
```

- [ ] **Step 2: 修改 scheduleRescan 支持自定义防抖时间**

**当前代码**：
```typescript
  private scheduleRescan(): void {
    if (this.mutationTimer !== null) window.clearTimeout(this.mutationTimer);
    this.mutationTimer = window.setTimeout(() => {
      void this.rescan().catch((error) => console.warn('[ChatGPT Navigator] rescan failed', error));
    }, MUTATION_DEBOUNCE_MS);
  }
```

**替换为**：
```typescript
  private scheduleRescan(debounceMs: number = MUTATION_DEBOUNCE_MS): void {
    if (this.mutationTimer !== null) window.clearTimeout(this.mutationTimer);
    this.mutationTimer = window.setTimeout(() => {
      this.mutationTimer = null;
      void this.rescan().catch((error) => console.warn('[ChatGPT Navigator] rescan failed', error));
    }, debounceMs);
  }
```

关键设计：
- 默认参数 `debounceMs = MUTATION_DEBOUNCE_MS`（500ms）保持向后兼容
- 新 turn 出现时使用快速防抖（500ms），确保新消息及时响应
- 流式文本变化时使用长防抖（3000ms），减少无变化 rescan 的频率
- 流式结束后 3000ms 内的第一次 rescan 会提取到完整文本，自动填充

- [ ] **Step 3: 运行类型检查**

Run: `pnpm compile`
Expected: PASS

---

### Task 4: 清理临时调试日志

**Files:**
- Modify: `src/content/messageScanner.ts`
- Modify: `src/content/cacheStore.ts`

- [ ] **Step 1: 清理 messageScanner.ts 中的临时日志**

删除以下 `console.log('[CQN]'` 行：
- rescan 入口的 `found turns=` 日志
- rescan 候选汇总的 `candidates=` 统计日志
- rescan 结果的 `mounted=` 统计日志

保留：
- `assistant anchor turnKey=` 日志（含 `hasText` 和 `preview` 信息，对长期调试有用）

- [ ] **Step 2: 清理 cacheStore.ts 中的临时日志**

删除以下 `console.log('[CQN]'` 行：
- `resolveScannedSegments` 入口的 `segments=` 统计日志
- `resolveScannedSegments` 中每条 newOrUpdated 的日志
- `resolveScannedSegments` 结果汇总的 `result allMessages=` 日志
- placeholder protection 的 `matched.preview=` 日志
- matchCandidate turnKey 匹配的日志

保留：无（这些日志已完成了诊断任务）

- [ ] **Step 3: 运行 TypeScript 类型检查**

Run: `pnpm compile`
Expected: PASS

---

### Task 5: 构建验证 + 提交

- [ ] **Step 1: 运行生产构建**

Run: `pnpm build`
Expected: PASS

- [ ] **Step 2: 提交代码**

```bash
git add src/ui/MessageItem.tsx src/ui/MiniBar.tsx src/ui/styles.css src/content/messageScanner.ts src/content/cacheStore.ts
git commit -m "feat: AI 加载动画 + 流式期间防抖优化

UI 层：
- MessageItem: 空 preview 的 assistant 显示三点跳动加载动画
- MiniBar: 流式中的 AI 标记添加呼吸动画
- CSS: 新增 @keyframes cqn-dot-bounce 和 cqn-streaming-pulse

性能优化：
- MessageScanner: 无新 turn 时使用 3000ms 防抖（流式场景）
- 新 turn 出现时保持 500ms 快速响应

清理临时调试日志。"
```

---

## Verification

### 场景验证清单

1. **新对话 + AI 流式输出**：
   - 发送消息后，侧栏出现 Q1 和 A1 骨架（三点跳动）
   - AI 流式输出期间，rescan 频率降低（每 3s 一次而非每 500ms）
   - 流式结束后 3s 内，A1 自动填充文本，跳动动画消失
   - MiniBar 中 AI 标记从呼吸动画变为正常状态

2. **连续对话**：
   - 发送 Q1 → AI 回复 → A1 自动填充
   - 发送 Q2 → 新 turn 检测触发快速 rescan（500ms）→ Q2 + A2 骨架出现
   - A2 流式结束后自动填充

3. **页面刷新**：
   - 已完成对话刷新后，缓存恢复所有消息（含 AI 文本）
   - 无三点动画（因为 preview 非空）

4. **性能对比**：
   - 流式输出期间 rescan 频率从 ~2/s 降至 ~0.33/s
   - CPU 占用应明显降低
