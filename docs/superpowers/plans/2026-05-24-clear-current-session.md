# 侧栏「清除当前会话」按钮 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在展开模式侧栏 Header 中增加垃圾桶按钮，二次确认后清除当前会话缓存并重新扫描。

**Architecture:** 通过 Props 回调将 `onClearCurrentSession` 从 content.ts 经 ShadowRootApp 传递到 Sidebar，Sidebar 负责确认交互，content.ts 负责编排 clear → flush → rescan 流程。

**Tech Stack:** TypeScript, Preact, WXT (Manifest V3), chrome.storage.local

---

### Task 1: content.ts — 新增 clearCurrentSession 并传入 UI 层

**Files:**
- Modify: `entrypoints/content.ts:16-22` (依赖实例区域)
- Modify: `entrypoints/content.ts:78` (createShadowRootApp 调用)

- [ ] **Step 1: 在 content.ts 中添加 clearCurrentSession 函数**

在 `const jumpController = ...` 之后（约第 22 行后）插入：

```typescript
const clearCurrentSession = async (): Promise<void> => {
  const { conversationId } = runtimeStore.getSnapshot();
  if (!conversationId) return;
  await cacheStore.flush();
  await cacheStore.clearConversation(conversationId);
  runtimeStore.setMessages([]);
  scanner.clearState();
  await scanner.rescan();
};
```

- [ ] **Step 2: 将 clearCurrentSession 传入 createShadowRootApp**

将第 78 行：

```typescript
await createShadowRootApp(ctx, { runtimeStore, jumpController });
```

改为：

```typescript
await createShadowRootApp(ctx, { runtimeStore, jumpController, onClearCurrentSession: clearCurrentSession });
```

- [ ] **Step 3: TypeScript 编译检查**

Run: `pnpm compile`
Expected: 无错误（ShadowRootApp 的 deps 类型尚未更新，下一步修改）

---

### Task 2: ShadowRootApp.tsx — 透传 onClearCurrentSession

**Files:**
- Modify: `src/ui/ShadowRootApp.tsx:8-10` (deps 类型) 和 `:17` (render 调用)

- [ ] **Step 1: 更新 deps 类型和 Sidebar 调用**

将整个文件改为：

```typescript
import { render } from 'preact';
import { createShadowRootUi } from 'wxt/utils/content-script-ui/shadow-root';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import type { JumpController } from '../content/jumpController';
import type { RuntimeStore } from '../content/runtimeStore';
import { Sidebar } from './Sidebar';

export async function createShadowRootApp(
  ctx: ContentScriptContext,
  deps: { runtimeStore: RuntimeStore; jumpController: JumpController; onClearCurrentSession: () => Promise<void> }
): Promise<void> {
  const ui = await createShadowRootUi(ctx, {
    name: 'chatgpt-navigator',
    position: 'overlay',
    anchor: 'body',
    onMount(container: HTMLElement) {
      render(<Sidebar runtimeStore={deps.runtimeStore} jumpController={deps.jumpController} onClearCurrentSession={deps.onClearCurrentSession} />, container);
      return () => render(null, container);
    },
    onRemove(mounted) {
      if (typeof mounted === 'function') mounted();
    }
  });

  ui.mount();
}
```

- [ ] **Step 2: TypeScript 编译检查**

Run: `pnpm compile`
Expected: 无错误（Sidebar 的 props 类型尚未更新，下一步修改）

---

### Task 3: Sidebar.tsx — 新增垃圾桶按钮与确认交互

**Files:**
- Modify: `src/ui/Sidebar.tsx:18-21` (SidebarProps 接口)
- Modify: `src/ui/Sidebar.tsx:23` (组件参数解构)
- Modify: `src/ui/Sidebar.tsx:96-110` (展开模式 header 区域)
- Modify: `src/ui/Sidebar.tsx:29` 附近 (新增 state)

- [ ] **Step 1: 更新 SidebarProps 接口和组件参数**

将 SidebarProps 接口改为：

```typescript
interface SidebarProps {
  runtimeStore: RuntimeStore;
  jumpController: JumpController;
  onClearCurrentSession: () => Promise<void>;
}
```

将组件函数签名改为：

```typescript
export function Sidebar({ runtimeStore, jumpController, onClearCurrentSession }: SidebarProps) {
```

- [ ] **Step 2: 新增确认状态和定时器逻辑**

在现有 state 声明之后（`const [hover, setHover]` 之后），添加：

```typescript
const [confirmClear, setConfirmClear] = useState(false);
const [clearing, setClearing] = useState(false);
```

在 `clearHover` 的 useCallback 之后，添加确认逻辑：

```typescript
const handleClearClick = useCallback(async () => {
  if (clearing) return;
  if (!confirmClear) {
    setConfirmClear(true);
    window.setTimeout(() => setConfirmClear(false), 2000);
    return;
  }
  setClearing(true);
  setConfirmClear(false);
  try {
    await onClearCurrentSession();
  } finally {
    setClearing(false);
  }
}, [confirmClear, clearing, onClearCurrentSession]);
```

- [ ] **Step 3: 在展开模式 header 中添加垃圾桶按钮**

将展开模式 header 的按钮区域（第 102-109 行的 `<div style={{ display: 'flex', gap: '4px' }}>` 内容）改为：

```tsx
<div style={{ display: 'flex', gap: '4px' }}>
  {snapshot.conversationId && (
    <button
      className={`cqn-collapse ${confirmClear ? 'is-confirming' : ''}`}
      type="button"
      onClick={handleClearClick}
      disabled={clearing}
      title={confirmClear ? '再次点击确认清除' : '清除当前会话缓存'}
      style={clearing ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
    >
      {confirmClear ? '?' : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        </svg>
      )}
    </button>
  )}
  <button className="cqn-collapse" type="button" onClick={() => handleModeChange('mini')} title="Mini 模式">
    ◫
  </button>
  <button className="cqn-collapse" type="button" onClick={() => handleModeChange('collapsed')} title="折叠导航">
    ×
  </button>
</div>
```

- [ ] **Step 4: TypeScript 编译检查**

Run: `pnpm compile`
Expected: PASS，无错误

---

### Task 4: styles.css — 新增确认状态样式

**Files:**
- Modify: `src/ui/styles.css:57-60` (在 `.cqn-collapse:hover` 之后)

- [ ] **Step 1: 在 `.cqn-collapse:hover` 规则之后添加确认状态样式**

在第 60 行（`.cqn-collapse:hover` 闭合花括号）之后插入：

```css
.cqn-collapse.is-confirming {
  background: #dc2626;
  color: #fff;
}

.cqn-collapse.is-confirming:hover {
  background: #b91c1c;
  color: #fff;
}
```

- [ ] **Step 2: 构建验证**

Run: `pnpm build`
Expected: 构建成功，无错误

---

### Task 5: 手工验收

- [ ] **Step 1: 启动开发构建**

Run: `pnpm dev`

- [ ] **Step 2: 在 Chrome 中加载扩展并验证**

在 `chrome://extensions/` 加载 `.output/chrome-mv3-dev`，打开 ChatGPT 长对话页面：

1. 展开侧栏 → Header 右侧可见垃圾桶按钮
2. 点击一次 → 按钮变红显示 `?`，2 秒后自动恢复灰色
3. 点击后立即再次点击 → 消息列表清空，随后自动重新填充
4. 清除期间按钮变灰不可点击
5. 切换到另一个对话 → 缓存仍在，未受影响
6. 回到原对话 → 重新扫描后的缓存正常

- [ ] **Step 3: 提交**

```bash
git add src/ui/Sidebar.tsx src/ui/ShadowRootApp.tsx entrypoints/content.ts src/ui/styles.css
git commit -m "feat: 侧栏新增清除当前会话缓存按钮

在展开模式侧栏 Header 右侧添加垃圾桶按钮，二次确认后清除当前会话的缓存记录并触发重新扫描，不影响其他会话。

- SidebarProps 新增 onClearCurrentSession 回调
- content.ts 新增 clearCurrentSession 编排 clear→rescan 流程
- ShadowRootApp 透传回调
- 二次确认交互：首次点击变红，2秒超时恢复"
```
