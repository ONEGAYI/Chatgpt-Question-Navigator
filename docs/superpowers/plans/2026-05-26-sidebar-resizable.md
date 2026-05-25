# 侧栏展开模式拖拽调宽 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在侧栏展开模式左侧添加拖拽手柄，支持用户拖拽调整宽度，宽度持久化到 chrome.storage.local。

**Architecture:** 新增 `useResize` hook 封装拖拽逻辑（mousedown/mousemove/mouseup）和持久化读写，Sidebar 组件消费该 hook 并通过 CSS 变量驱动宽度变化。手柄为 absolute 定位的 4px div，不参与 flex 流。

**Tech Stack:** Preact hooks, CSS 变量, chrome.storage.local

---

## 文件结构

| 操作 | 文件 | 职责 |
|------|------|------|
| 新增 | `src/ui/useResize.ts` | 拖拽逻辑 hook：宽度状态、拖拽事件、持久化 |
| 修改 | `src/ui/Sidebar.tsx` | 消费 useResize，渲染手柄 div，传递 CSS 变量 |
| 修改 | `src/ui/styles.css` | 添加 `.cqn-resize-handle` 样式，修复 hover-preview 宽度 |

---

### Task 1: 创建 useResize hook

**Files:**
- Create: `src/ui/useResize.ts`

- [ ] **Step 1: 创建 `src/ui/useResize.ts`**

```typescript
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

const MIN_WIDTH = 240;
const MAX_WIDTH = 560;
const DEFAULT_WIDTH = 280;

export interface UseResizeOptions {
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  storageKey: string;
}

export interface UseResizeReturn {
  width: number;
  isResizing: boolean;
  dragHandleProps: {
    onMouseDown: (e: MouseEvent) => void;
  };
}

export function useResize({
  defaultWidth = DEFAULT_WIDTH,
  minWidth = MIN_WIDTH,
  maxWidth = MAX_WIDTH,
  storageKey,
}: UseResizeOptions): UseResizeReturn {
  const [width, setWidth] = useState(defaultWidth);
  const [isResizing, setIsResizing] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  // 从 chrome.storage.local 加载持久化的宽度
  useEffect(() => {
    chrome.storage.local.get(storageKey, (result) => {
      const stored = result[storageKey];
      if (typeof stored === 'number' && stored >= minWidth && stored <= maxWidth) {
        setWidth(stored);
      }
      setLoaded(true);
    });
  }, [storageKey, minWidth, maxWidth]);

  const handleMouseDown = useCallback(
    (e: MouseEvent) => {
      e.preventDefault();
      startXRef.current = e.clientX;
      startWidthRef.current = width;
      setIsResizing(true);

      const originalUserSelect = document.body.style.userSelect;
      document.body.style.userSelect = 'none';

      const handleMouseMove = (ev: MouseEvent) => {
        // 侧栏在右侧，鼠标左移 = 宽度增大（right edge fixed, left edge moves left）
        const dx = startXRef.current - ev.clientX;
        const next = Math.min(maxWidth, Math.max(minWidth, startWidthRef.current + dx));
        setWidth(next);
      };

      const handleMouseUp = (ev: MouseEvent) => {
        document.body.style.userSelect = originalUserSelect;
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        setIsResizing(false);

        // 持久化最终宽度
        const dx = startXRef.current - ev.clientX;
        const finalWidth = Math.min(maxWidth, Math.max(minWidth, startWidthRef.current + dx));
        chrome.storage.local.set({ [storageKey]: finalWidth });
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [width, minWidth, maxWidth, storageKey]
  );

  // 未加载完成前用默认宽度，加载完成后用存储值
  return {
    width: loaded ? width : defaultWidth,
    isResizing,
    dragHandleProps: { onMouseDown: handleMouseDown },
  };
}
```

- [ ] **Step 2: 运行 TypeScript 类型检查确认无报错**

Run: `pnpm compile`
Expected: 无新增错误

- [ ] **Step 3: 提交**

```bash
git add src/ui/useResize.ts
git commit -m "feat: 添加 useResize hook 封装侧栏拖拽调宽逻辑"
```

---

### Task 2: Sidebar 集成 useResize hook 并渲染拖拽手柄

**Files:**
- Modify: `src/ui/Sidebar.tsx`

- [ ] **Step 1: 在 Sidebar.tsx 顶部导入 useResize**

在现有 import 块末尾添加：

```typescript
import { useResize } from './useResize';
```

- [ ] **Step 2: 在 Sidebar 函数组件内调用 useResize**

在 `const [searchInput, setSearchInput] = useState('');` 行（约第 62 行）之后添加：

```typescript
  const { width: sidebarWidth, isResizing, dragHandleProps } = useResize({
    storageKey: 'cqn-sidebar-width',
    defaultWidth: 280,
    minWidth: 240,
    maxWidth: 560,
  });
```

- [ ] **Step 3: 在展开模式的 `<aside>` 上设置 CSS 变量和拖拽中光标类**

将展开模式的 `<aside className="cqn-sidebar">`（约第 175 行）改为：

```tsx
      <aside
        className={`cqn-sidebar${isResizing ? ' is-resizing' : ''}`}
        style={{ '--cqn-sidebar-width': `${sidebarWidth}px` } as React.CSSProperties}
      >
```

注意：Preact 下 `style` 接受对象，CSS 变量作为对象属性传递需要 `as React.CSSProperties` 或直接用 `as any`。实际上在 Preact 中可以直接写：

```tsx
      <aside
        className={`cqn-sidebar${isResizing ? ' is-resizing' : ''}`}
        style={{ '--cqn-sidebar-width': `${sidebarWidth}px` } as preact.JSX.CSSProperties}
      >
```

因为项目是 Preact，不需要 `React.CSSProperties`，改用：

```tsx
      <aside
        className={`cqn-sidebar${isResizing ? ' is-resizing' : ''}`}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        style={{ '--cqn-sidebar-width': `${sidebarWidth}px` } as any}
      >
```

- [ ] **Step 4: 在 `<aside>` 内部开头添加拖拽手柄 div**

在 `<aside>` 开标签后、`<header>` 前添加：

```tsx
        <div className="cqn-resize-handle" {...dragHandleProps} />
```

最终展开模式 JSX 结构变为：

```tsx
      <aside
        className={`cqn-sidebar${isResizing ? ' is-resizing' : ''}`}
        style={{ '--cqn-sidebar-width': `${sidebarWidth}px` } as any}
      >
        <div className="cqn-resize-handle" {...dragHandleProps} />
        <header className="cqn-header">
          {/* 现有内容不变 */}
```

- [ ] **Step 5: 运行类型检查确认无报错**

Run: `pnpm compile`
Expected: 无新增错误

- [ ] **Step 6: 提交**

```bash
git add src/ui/Sidebar.tsx
git commit -m "feat: Sidebar 集成 useResize hook 并渲染拖拽手柄"
```

---

### Task 3: 添加拖拽手柄 CSS 样式和修复 hover-preview

**Files:**
- Modify: `src/ui/styles.css`

- [ ] **Step 1: 为 `.cqn-sidebar` 添加 `position: relative`（手柄 absolute 定位依赖）**

将 `.cqn-sidebar` 规则中已有的 `position: fixed` 保持不变，不需修改（fixed 定位的元素内部 absolute 子元素参照该 fixed 元素，天然满足需求）。**确认无需改动。**

- [ ] **Step 2: 在 `.cqn-sidebar.is-collapsed` 规则后添加拖拽手柄样式**

在 `.cqn-sidebar.is-collapsed { ... }` 块（约第 32-35 行）之后，`.cqn-header` 规则之前添加：

```css
.cqn-resize-handle {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 4px;
  cursor: col-resize;
  background: transparent;
  transition: background 0.15s ease;
  z-index: 1;
}

.cqn-resize-handle:hover {
  background: rgba(16, 163, 127, 0.3);
}

.cqn-sidebar.is-resizing .cqn-resize-handle {
  background: rgba(16, 163, 127, 0.6);
}

.cqn-sidebar.is-resizing {
  transition: none;
}

.cqn-sidebar.is-resizing * {
  user-select: none !important;
}
```

- [ ] **Step 3: 修复 `.cqn-hover-preview` 的宽度公式**

找到 `.cqn-hover-preview` 规则（约第 242-257 行），将其中的：

```css
  width: min(360px, calc(100vw - 340px));
```

改为：

```css
  width: min(360px, calc(100vw - var(--cqn-sidebar-width) - 24px));
```

这样 hover preview 的宽度会随侧栏宽度变化自适应。`24px` 是侧栏 `right: 12px` + preview 自身 `right` 偏移 `12px` 的合计。

- [ ] **Step 4: 运行类型检查确认无报错**

Run: `pnpm compile`
Expected: 无新增错误

- [ ] **Step 5: 提交**

```bash
git add src/ui/styles.css
git commit -m "feat: 添加拖拽手柄 CSS 样式，修复 hover-preview 宽度公式"
```

---

### Task 4: 开发构建并手动验证

- [ ] **Step 1: 开发构建**

Run: `pnpm dev`

Expected: WXT watch 启动，输出到 `.output/chrome-mv3-dev`

- [ ] **Step 2: 在 Chrome 中加载扩展并验证**

加载 `.output/chrome-mv3-dev`，打开 ChatGPT 对话页面：

1. 确认侧栏展开模式宽度仍为 280px（默认值）
2. 鼠标悬停侧栏左侧边缘，确认 4px 手柄出现绿色半透明高亮
3. 拖拽手柄向左/右移动，确认宽度实时变化
4. 确认宽度被限制在 240-560px 之间
5. 释放鼠标后刷新页面，确认宽度恢复（持久化生效）
6. 确认消息列表、搜索框、AI 消息等内部元素自适应
7. 切换到 Mini 模式再切回展开模式，确认宽度保持

- [ ] **Step 3: 提交（如有修复）**

```bash
git add -u
git commit -m "fix: 修复手动验证中发现的问题"
```

---

## 自检清单

### Spec 覆盖

| Spec 要求 | 对应 Task |
|-----------|-----------|
| 拖拽手柄 4px 左侧边缘 | Task 3 (CSS) + Task 2 (DOM) |
| hover 半透明高亮 | Task 3 (`.cqn-resize-handle:hover`) |
| 拖拽中高亮 + 全局光标 | Task 3 (`.is-resizing`) |
| mousedown→mousemove→mouseup on document | Task 1 (useResize) |
| e.preventDefault() + user-select: none | Task 1 (handleMouseDown) |
| 最小 240px / 最大 560px / 默认 280px | Task 1 (常量) |
| 持久化 cqn-sidebar-width | Task 1 (chrome.storage.local) |
| hover-preview 宽度自适应 | Task 3 (CSS 修复) |
| useResize hook 封装 | Task 1 |
| Sidebar 消费 hook + 渲染手柄 | Task 2 |

### 无占位符：无 TBD/TODO/"implement later"

### 类型一致性：useResize 返回 `{ width, isResizing, dragHandleProps }`，Sidebar 通过解构消费，类型匹配。
