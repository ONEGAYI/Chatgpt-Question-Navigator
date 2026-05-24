# Mini Bar 模式设计规格

## 概述

侧边栏增加第三种显示状态——Mini Bar 模式，在展开列表和折叠图标之间提供轻量级的问题导航方式。

## 状态模型

三态切换：**展开 → Mini → 折叠图标**

```
┌─────────┐    Mini 按钮    ┌──────────┐    折叠按钮    ┌──────────┐
│  展开    │ ──────────────→ │  Mini    │ ──────────────→ │ 折叠图标  │
│ (280px)  │ ←────────────── │ (融入背景) │ ←────────────── │ (40px)   │
└─────────┘    展开按钮      └──────────┘    展开按钮      └──────────┘
                               ▲ 也有折叠按钮 → 直接到折叠
```

切换规则：
- **展开模式**：显示 Mini 按钮 + 折叠按钮
- **Mini 模式**：只显示展开按钮（☰ 图标，底部）
- **折叠图标模式**：只显示展开按钮（☰ 图标）

## Mini Bar 视觉

### 布局

- 位置：右侧固定，垂直居中于视口
- 无面板包裹：无背景、无边框、无 box-shadow，融入 ChatGPT 页面背景
- 组件结构（从上到下）：
  1. ▲ 三角导航按钮
  2. 问题标记组（滑动窗口）
  3. ▼ 三角导航按钮
  4. ☰ 展开按钮

### 标记样式

每个问题渲染为一个绿色短线标记，三种视觉状态：

| 状态 | 宽度 | 高度 | opacity | 其他 |
|------|------|------|---------|------|
| 当前位置（高亮） | 22px | 4px | 1.0 | `box-shadow: 0 0 8px rgba(16,163,127,0.5)` |
| 已挂载 · 可跳转 | 14px | 3px | 0.7 | — |
| 已缓存 · 未挂载 | 14px | 3px | 0.35 | — |

标记间距：固定 `8px`（上间距）。

### 滑动窗口

常量 `MAX_VISIBLE = 7`。

```
halfWindow = Math.floor(MAX_VISIBLE / 2)  // = 3

if total <= MAX_VISIBLE:
  显示全部
else:
  start = clamp(activeIdx - halfWindow, 0, total - MAX_VISIBLE)
  end = start + MAX_VISIBLE
  显示 messages[start..end)
```

边界处理：
- 活跃消息在前部 → 窗口从索引 0 开始，向后取 MAX_VISIBLE 条
- 活跃消息在尾部 → 窗口从 `total - MAX_VISIBLE` 开始
- 活跃消息在中间 → 以其为中心，前后各 halfWindow 条

"活跃消息"定义：`RuntimeState.activeMessageId` 对应的消息。如果没有活跃消息，使用距离当前视口中心最近的消息。

## 交互

### Hover 标记

- 触发：鼠标悬停到标记上
- 效果：在标记左侧弹出 preview tooltip
- Tooltip 内容：Q 序号 + 完整问题文本
- Tooltip 定位：`position: fixed`，与 tooltip 修复方案一致（在 `Sidebar` 外部渲染，避免 overflow 裁剪）
- 离开标记时消失

### 点击标记

- 触发：点击标记
- 效果：调用 `jumpController.jumpToMessage(target)` 跳转到该问题

### ▲/▼ 导航

- ▲：跳转到当前活跃消息的上一条问题
- ▼：跳转到当前活跃消息的下一条问题
- 到达边界时禁用（opacity 降低 + `pointer-events: none`）
- 跳转后窗口跟随滑动，新活跃消息居中

## 组件设计

### 新增：`src/ui/MiniBar.tsx`

```typescript
interface MiniBarProps {
  messages: CachedUserMessage[];
  activeMessageId: string | null;
  mountedIds: Set<string>;
  onJump: (message: CachedUserMessage) => void;
  onExpand: () => void;
}
```

职责：
- 接收 messages 和状态，计算滑动窗口
- 渲染标记组 + 导航按钮 + 展开按钮
- 管理 hover 状态（tooltip）
- ▲/▼ 导航逻辑

### 修改：`src/ui/Sidebar.tsx`

- `collapsed: boolean` → `mode: 'expanded' | 'mini' | 'collapsed'`
- 展开模式渲染现有 Sidebar + Mini/折叠按钮
- Mini 模式渲染 `<MiniBar />`
- 折叠模式渲染现有折叠按钮

### 修改：`src/ui/styles.css`

新增样式类：
- `.cqn-minibar` — 容器（fixed 定位，右侧融入背景，垂直居中）
- `.cqn-mini-mark` — 标记基础样式
- `.cqn-mini-mark.is-active` — 当前位置高亮
- `.cqn-mini-mark.is-mounted` — 已挂载
- `.cqn-mini-mark.is-cached` — 已缓存
- `.cqn-mini-nav` — ▲/▼ 导航按钮
- `.cqn-mini-expand` — ☰ 展开按钮

## 数据流

```
RuntimeStore
  ├── messages → MiniBar（滑动窗口计算）
  ├── activeMessageId → MiniBar（高亮标记 + 窗口中心）
  └── mountedIds → MiniBar（标记样式区分）

用户交互：
  hover 标记 → MiniBar 内部 state → tooltip 显隐
  点击标记 / ▲/▼ → onJump → JumpController.jumpToMessage()
  点击 ☰ → onExpand → Sidebar 切换 mode = 'expanded'
```

无需新增数据源或修改 RuntimeStore。

## 实现约束

- 标记的 `position: fixed` 定位，不依赖父级 flex/grid 布局
- Tooltip 复用现有的 fixed 定位方案（在 `Sidebar` Fragment 外部渲染）
- `MAX_VISIBLE` 作为常量定义在 `MiniBar.tsx` 顶部
- 模式状态持久化：`mode` 不需要持久化到 storage，每次加载默认展开
