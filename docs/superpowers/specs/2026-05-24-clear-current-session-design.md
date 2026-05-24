# 侧栏「清除当前会话」按钮设计

## 概述

在展开模式的侧栏 Header 右侧按钮组中新增垃圾桶图标按钮，点击后二次确认可清除当前会话的缓存记录并立即触发重新扫描。不影响其他会话的缓存。

## 动机

长对话场景中，ChatGPT 可能大幅修改 DOM 结构（编辑消息、删除消息、重新生成），导致缓存中出现过时或错误的条目。用户需要一个快捷入口丢弃当前会话的脏数据并从头开始，而不必打开 Popup 操作。

## UI 设计

### 按钮位置

```
ChatGPT Navigator    [🗑] [◫] [×]
```

垃圾桶按钮位于标题右侧按钮组的最左侧，紧邻 Mini 模式按钮。

### 交互状态

| 状态 | 外观 | 行为 |
|------|------|------|
| 默认 | 灰色垃圾桶图标 | 点击进入确认状态 |
| 确认中 | 红色背景 + "确认?" 文字 | 点击执行清除；2 秒后自动恢复默认 |
| 执行中 | 禁用（opacity 降低） | 防止重复点击 |
| 无会话 | 隐藏按钮 | conversationId 为 null 时不显示 |

### 视觉样式

- 复用 `.cqn-collapse` 按钮基础样式
- 确认状态使用 `.is-confirming` class，背景色 `#dc2626`（红色），文字色白色
- 使用内联 SVG 垃圾桶图标（与 Popup 中删除按钮图标一致）

## 技术设计

### 回调传递方式

采用 Props 回调模式，与现有 `jumpController` 传递方式一致：

```
content.ts (定义 clearCurrentSession)
  → ShadowRootApp.tsx (透传)
    → Sidebar.tsx (消费)
```

### 变更文件

#### 1. `src/ui/Sidebar.tsx`

- `SidebarProps` 新增 `onClearCurrentSession: () => Promise<void>`
- 新增 `confirmClear` 和 `clearing` 两个 state
- 展开模式 header 中新增垃圾桶按钮 JSX
- 点击逻辑：
  1. 首次点击 → `setConfirmClear(true)` + 2 秒定时器恢复
  2. 确认点击 → `setClearing(true)` → 调用 `onClearCurrentSession()` → `setClearing(false)` + `setConfirmClear(false)`

#### 2. `src/ui/ShadowRootApp.tsx`

- `deps` 类型新增 `onClearCurrentSession: () => Promise<void>`
- 透传给 `<Sidebar>`

#### 3. `entrypoints/content.ts`

- 新增 `clearCurrentSession` async 函数：
  1. 获取当前 `conversationId`
  2. `cacheStore.flush()`
  3. `cacheStore.clearConversation(id)`
  4. `runtimeStore.setMessages([])`
  5. `scanner.clearState()`
  6. `scanner.rescan()`
- 传入 `createShadowRootApp`

#### 4. `src/ui/styles.css`

- 新增 `.cqn-clear-session.is-confirming` 样式

### 数据流

```
用户点击垃圾桶 → 确认 → onClearCurrentSession()
  → cacheStore.flush()              # 保存可能存在的脏数据
  → cacheStore.clearConversation(id) # 清除当前会话存储
  → runtimeStore.setMessages([])     # 清空 UI 消息列表
  → scanner.clearState()             # 重置扫描器状态
  → scanner.rescan()                 # 重新扫描 DOM → 触发缓存填充
```

### 不变更的部分

- CacheStore 接口不变（复用 `clearConversation` 和 `flush`）
- MessageScanner 接口不变（复用 `clearState` 和 `rescan`）
- RuntimeStore 接口不变（复用 `setMessages`）
- 不引入新的消息类型或存储机制
- Popup 层不变

## 验收标准

1. 展开侧栏时 Header 右侧显示垃圾桶按钮
2. 首次点击按钮变红并显示"确认?"，2 秒后自动恢复
3. 确认后当前会话消息列表清空，随后自动重新填充
4. 清除期间按钮显示禁用状态
5. 其他会话的缓存不受影响（切换到其他对话后缓存仍在）
6. conversationId 为 null 时按钮不显示
