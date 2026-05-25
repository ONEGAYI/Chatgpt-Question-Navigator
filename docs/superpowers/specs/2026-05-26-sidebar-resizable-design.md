# 侧栏展开模式拖拽调宽

## 概述

在展开模式侧栏左侧边缘添加拖拽手柄，用户可通过鼠标拖拽调整侧栏宽度，内部元素自适应。调整后的宽度持久化到 `chrome.storage.local`。

## 交互设计

### 拖拽手柄

- 位置：侧栏左侧边缘，宽 4px，高度撑满侧栏
- 默认状态：透明不可见
- hover：背景变为 `var(--cqn-accent)` 半透明（`rgba(16, 163, 127, 0.3)`），提示可拖拽
- 拖拽中：背景高亮（`var(--cqn-accent)` 不透明度 0.6），全局 `cursor: col-resize`
- 光标：手柄区域始终 `cursor: col-resize`

### 拖拽行为

- 监听 `mousedown`（手柄） → `mousemove`（document） → `mouseup`（document）
- `mousemove` 期间实时更新 CSS 变量 `--cqn-sidebar-width`
- 为防止拖拽时选中文本或触发 iframe 事件，`mousedown` 时调用 `e.preventDefault()` 并在 document 上临时设置 `user-select: none`
- 拖拽中 `mousemove`/`mouseup` 绑定到 document（而非手柄元素），确保鼠标移出手柄区域仍能追踪

### 宽度约束

| 参数 | 值 | 理由 |
|------|------|------|
| 最小宽度 | 240px | 保证消息文本可读 |
| 最大宽度 | 560px | 不遮挡过多主内容区 |
| 默认宽度 | 280px | 当前值不变 |

### 持久化

- Storage key：`cqn-sidebar-width`
- 值类型：`number`（像素值，如 `340`）
- 保存时机：`mouseup` 时一次性保存
- 加载时机：组件初始化时从 `chrome.storage.local` 读取，不存在则使用默认 280px

## 自适应分析

现有内部布局天然适配宽度变化，无需额外调整：

- `.cqn-item`：`grid-template-columns: 36px minmax(0, 1fr)` → 弹性
- `.cqn-item-ai-body`：`flex: 1; min-width: 0` → 弹性
- `.cqn-search input`：`width: 100%` → 填满
- `.cqn-item-preview`：`text-overflow: ellipsis` → 自动截断

需调整的硬编码引用：
- `.cqn-hover-preview` 的 `width: min(360px, calc(100vw - 340px))` 中 `340px` 改为基于 `--cqn-sidebar-width` 计算

## 实现

### 新增文件

- `src/ui/useResize.ts` — 自定义 hook，封装拖拽逻辑，返回 `{ width, isResizing, dragHandleProps }`

### 修改文件

- `src/ui/Sidebar.tsx` — 消费 `useResize` hook，渲染拖拽手柄元素，将 width 传递为 CSS 变量
- `src/ui/styles.css` — 添加拖拽手柄样式（`.cqn-resize-handle`），修复 hover-preview 宽度公式

### useResize hook 接口

```typescript
interface UseResizeReturn {
  width: number;                          // 当前宽度（px）
  isResizing: boolean;                    // 是否正在拖拽
  dragHandleProps: {                      // 传给拖拽手柄元素的 props
    onMouseDown: (e: MouseEvent) => void;
  };
}

function useResize(options: {
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  storageKey: string;
}): UseResizeReturn;
```

### 拖拽手柄 DOM 结构

```html
<aside className="cqn-sidebar" style={`--cqn-sidebar-width: ${width}px`}>
  <div className="cqn-resize-handle" {...dragHandleProps} />
  <!-- 现有内容不变 -->
</aside>
```

手柄使用 `position: absolute; left: 0; top: 0; bottom: 0; width: 4px;`，不参与 flex 布局流。
