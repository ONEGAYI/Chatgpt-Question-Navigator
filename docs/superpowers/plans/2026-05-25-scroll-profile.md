# ScrollProfile 可配置速率 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 AutoCollector 和 JumpController 的硬编码速率常量提取为可切换的 default/fast/turbo 三档 ScrollProfile，通过 Popup 切换并持久化。

**Architecture:** 新增 `src/shared/scrollProfile.ts` 定义类型和预置档位。RuntimeStore 增加 `scrollProfileName` 状态。AutoCollector/JumpController 通过 `getProfile` 回调注入读取速率参数。Popup 新增设置 UI。

**Tech Stack:** TypeScript, Preact, chrome.storage.local

---

### Task 1: 创建分支

**Files:** 无代码变更

- [ ] **Step 1: 从 master 创建功能分支**

```bash
git checkout -b feat/scroll-profile
```

- [ ] **Step 2: 验证分支**

```bash
git branch --show-current
```

Expected: `feat/scroll-profile`

---

### Task 2: 新建 scrollProfile.ts — 类型和预置档位

**Files:**
- Create: `src/shared/scrollProfile.ts`

- [ ] **Step 1: 创建文件**

```typescript
// src/shared/scrollProfile.ts

export type ScrollProfileName = 'default' | 'fast' | 'turbo';

export interface ScrollProfile {
  name: ScrollProfileName;
  label: string;

  // AutoCollector
  acScrollStepRatio: number;
  acSettleStableMs: number;
  acSettleQuietMs: number;
  acSettlePollMs: number;

  // JumpController
  jcSettleMs: number;
  jcDecayRate: number;
  jcMinDecay: number;
}

export const SCROLL_PROFILES: Record<ScrollProfileName, ScrollProfile> = {
  default: {
    name: 'default',
    label: '标准',
    acScrollStepRatio: 0.7,
    acSettleStableMs: 500,
    acSettleQuietMs: 400,
    acSettlePollMs: 100,
    jcSettleMs: 500,
    jcDecayRate: 0.03,
    jcMinDecay: 0.3,
  },
  fast: {
    name: 'fast',
    label: '快速',
    acScrollStepRatio: 0.85,
    acSettleStableMs: 300,
    acSettleQuietMs: 250,
    acSettlePollMs: 80,
    jcSettleMs: 300,
    jcDecayRate: 0.02,
    jcMinDecay: 0.4,
  },
  turbo: {
    name: 'turbo',
    label: '极速',
    acScrollStepRatio: 1.0,
    acSettleStableMs: 200,
    acSettleQuietMs: 150,
    acSettlePollMs: 50,
    jcSettleMs: 200,
    jcDecayRate: 0.01,
    jcMinDecay: 0.5,
  },
};

export function getScrollProfile(name: ScrollProfileName): ScrollProfile {
  return SCROLL_PROFILES[name];
}

export const SCROLL_PROFILE_ORDER: ScrollProfileName[] = ['default', 'fast', 'turbo'];

export const PROFILE_STORAGE_KEY = 'cqn-scroll-profile';
```

- [ ] **Step 2: 类型检查**

```bash
pnpm compile
```

Expected: 无错误（新文件尚未被引用，但自身类型完整）

- [ ] **Step 3: 提交**

```bash
git add src/shared/scrollProfile.ts
git commit -m "feat: 新增 ScrollProfile 类型和预置档位

添加 src/shared/scrollProfile.ts，定义 ScrollProfileName、ScrollProfile
类型和 default/fast/turbo 三档预置参数。同时导出
getScrollProfile、SCROLL_PROFILE_ORDER 和 PROFILE_STORAGE_KEY 常量。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 3: RuntimeState 新增 scrollProfileName 字段

**Files:**
- Modify: `src/shared/types.ts:58-66` (RuntimeState 接口)

- [ ] **Step 1: 在 RuntimeState 接口末尾新增字段**

在 `src/shared/types.ts` 的 `RuntimeState` 接口中，在 `autoCollectProgress` 后新增：

```typescript
  scrollProfileName: ScrollProfileName;
```

同时在文件顶部的 import 区域新增：

```typescript
import type { ScrollProfileName } from './scrollProfile';
```

完整的 RuntimeState 接口变为：

```typescript
export interface RuntimeState {
  conversationId: string | null;
  messages: CachedMessage[];
  elementById: Map<string, HTMLElement>;
  mountedIds: Set<string>;
  activeMessageId: string | null;
  jumpState: JumpState;
  autoCollectProgress: AutoCollectProgress | null;
  scrollProfileName: ScrollProfileName;
}
```

- [ ] **Step 2: 类型检查**

```bash
pnpm compile
```

Expected: 报错 `runtimeStore.ts` 缺少 `scrollProfileName`（因为初始状态未包含）——这是预期的，下一步修复。

- [ ] **Step 3: 提交**

```bash
git add src/shared/types.ts
git commit -m "feat: RuntimeState 新增 scrollProfileName 字段

在 RuntimeState 接口添加 scrollProfileName: ScrollProfileName，
由 scrollProfile.ts 导入类型。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 4: RuntimeStore 新增 scrollProfileName 状态和方法

**Files:**
- Modify: `src/content/runtimeStore.ts`

- [ ] **Step 1: 更新初始状态和新增方法**

在 `runtimeStore.ts` 中：

1. 在 import 行新增 `ScrollProfileName` 类型导入：

```typescript
import type { AutoCollectProgress, CachedMessage, JumpState, RuntimeState } from '../shared/types';
import type { ScrollProfileName } from '../shared/scrollProfile';
```

2. 在 `state` 初始值中新增 `scrollProfileName`：

```typescript
  private state: RuntimeState = {
    conversationId: null,
    messages: [],
    elementById: new Map(),
    mountedIds: new Set(),
    activeMessageId: null,
    jumpState: { status: 'idle' },
    autoCollectProgress: null,
    scrollProfileName: 'default',
  };
```

3. 在 `setAutoCollectProgress` 方法之后、`subscribe` 方法之前新增：

```typescript
  setScrollProfile(name: ScrollProfileName): void {
    this.state = { ...this.state, scrollProfileName: name };
    this.emit();
  }
```

4. `getSnapshot` 方法无需修改——它已经做 `{ ...this.state }` 浅拷贝，新增字段自动包含。

- [ ] **Step 2: 类型检查**

```bash
pnpm compile
```

Expected: 编译通过（RuntimeState 和 RuntimeStore 现在一致了）

- [ ] **Step 3: 提交**

```bash
git add src/content/runtimeStore.ts
git commit -m "feat: RuntimeStore 新增 scrollProfileName 状态和 setScrollProfile 方法

初始值为 'default'，setScrollProfile 更新状态并 emit 通知订阅者。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 5: AutoCollector 接入 ScrollProfile

**Files:**
- Modify: `src/content/autoCollector.ts`

- [ ] **Step 1: 修改 imports 和删除硬编码常量**

1. 在 imports 区域新增：

```typescript
import type { ScrollProfile } from '../shared/scrollProfile';
```

2. 删除以下四个常量（保留 `MAX_ROUNDS`、`STAGNANT_LIMIT`、`NO_MOVEMENT_LIMIT`、`FALLBACK_MAX_ROUNDS`、`CHECKPOINT_EVERY_ROUNDS`、`INTENT_KEY`）：

```typescript
// 删除这四行：
const SCROLL_STEP_RATIO = 0.7;
const SETTLE_STABLE_MS = 500;
const SETTLE_QUIET_MS = 400;
const SETTLE_POLL_MS = 100;
const SETTLE_TIMEOUT_MS = 5000;
```

注意 `SETTLE_TIMEOUT_MS` 也删除——它不变但为了清晰性，直接内联 5000 到 `waitForPageSettled`。

- [ ] **Step 2: 构造函数新增 getProfile 参数**

将构造函数改为：

```typescript
  constructor(
    private readonly domAdapter: DomAdapter,
    private readonly cacheStore: CacheStore,
    private readonly scrollDriver: ScrollDriver,
    private readonly runtimeStore: RuntimeStore,
    private readonly afterReplace?: () => Promise<void>,
    private readonly getProfile: () => ScrollProfile = () => ({
      name: 'default', label: '标准',
      acScrollStepRatio: 0.7, acSettleStableMs: 500, acSettleQuietMs: 400, acSettlePollMs: 100,
      jcSettleMs: 500, jcDecayRate: 0.03, jcMinDecay: 0.3,
    }),
  ) {}
```

默认参数保证向后兼容（现有调用无需改动）。

- [ ] **Step 3: 替换 startFullCollection 中的硬编码引用**

在 `startFullCollection` 方法的 while 循环中（约第 136 行附近），将：

```typescript
        const step = Math.floor(this.scrollDriver.getClientHeight() * SCROLL_STEP_RATIO);
```

替换为：

```typescript
        const step = Math.floor(this.scrollDriver.getClientHeight() * this.getProfile().acScrollStepRatio);
```

在 `runFallbackHydration` 中（约第 371 行）同样替换：

```typescript
      const step = Math.floor(this.scrollDriver.getClientHeight() * SCROLL_STEP_RATIO);
```

替换为：

```typescript
      const step = Math.floor(this.scrollDriver.getClientHeight() * this.getProfile().acScrollStepRatio);
```

- [ ] **Step 4: 替换 waitForPageSettled 中的硬编码引用**

将 `waitForPageSettled` 方法中的常量替换为 profile 读取：

```typescript
  private async waitForPageSettled(): Promise<void> {
    const profile = this.getProfile();
    const start = Date.now();
    let lastMutationTime = Date.now();
    let lastScrollTop = this.scrollDriver.getScrollTop();
    let stableSince = Date.now();

    const observer = new MutationObserver(() => {
      lastMutationTime = Date.now();
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    try {
      await this.delay(profile.acSettlePollMs);

      while (true) {
        if (this.cancelRequested) return;

        const now = Date.now();
        const currentScrollTop = this.scrollDriver.getScrollTop();

        if (Math.abs(currentScrollTop - lastScrollTop) > 2) {
          lastScrollTop = currentScrollTop;
          stableSince = now;
        }

        const scrollStable = (now - stableSince) >= profile.acSettleStableMs;
        const domQuiet = (now - lastMutationTime) >= profile.acSettleQuietMs;
        const timeout = (now - start) >= 5000;

        if ((scrollStable && domQuiet) || timeout) return;

        await this.delay(profile.acSettlePollMs);
      }
    } finally {
      observer.disconnect();
    }
  }
```

- [ ] **Step 5: 类型检查**

```bash
pnpm compile
```

Expected: 编译通过

- [ ] **Step 6: 提交**

```bash
git add src/content/autoCollector.ts
git commit -m "feat: AutoCollector 接入 ScrollProfile 速率参数

- 删除 SCROLL_STEP_RATIO、SETTLE_STABLE_MS、SETTLE_QUIET_MS、SETTLE_POLL_MS 硬编码常量
- 构造函数新增 getProfile 回调参数（带默认值，向后兼容）
- waitForPageSettled 和滚动步长计算改为从 profile 动态读取
- SETTLE_TIMEOUT_MS 内联为 5000（不变）

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 6: JumpController 接入 ScrollProfile

**Files:**
- Modify: `src/content/jumpController.ts`

- [ ] **Step 1: 修改 imports 和删除硬编码常量**

1. 在 imports 区域新增：

```typescript
import type { ScrollProfile } from '../shared/scrollProfile';
```

2. 删除常量 `SETTLE_MS`：

```typescript
// 删除这一行：
const SETTLE_MS = 500;
```

保留 `HIGHLIGHT_MS`、`STYLE_ID`、`MAX_ATTEMPTS`、`MAX_CONSECUTIVE_NOOPS`、`DEBUG_JUMP`。

- [ ] **Step 2: 构造函数新增 getProfile 参数**

```typescript
  constructor(
    private readonly scanner: MessageScanner,
    private readonly cacheStore: CacheStore,
    private readonly scrollDriver: ScrollDriver,
    private readonly runtimeStore: RuntimeStore,
    private readonly getProfile: () => ScrollProfile = () => ({
      name: 'default', label: '标准',
      acScrollStepRatio: 0.7, acSettleStableMs: 500, acSettleQuietMs: 400, acSettlePollMs: 100,
      jcSettleMs: 500, jcDecayRate: 0.03, jcMinDecay: 0.3,
    }),
  ) {}
```

- [ ] **Step 3: 替换 jumpToCachedMessage 中的 SETTLE_MS**

在 `jumpToCachedMessage` 方法末尾（约第 206 行），将：

```typescript
      await waitForDomSettled(SETTLE_MS);
```

替换为：

```typescript
      await waitForDomSettled(this.getProfile().jcSettleMs);
```

- [ ] **Step 4: 替换 scrollOneChunk 中的衰减常量**

将 `scrollOneChunk` 方法改为：

```typescript
  private scrollOneChunk(direction: 'up' | 'down', attempt: number): boolean {
    const { jcDecayRate, jcMinDecay } = this.getProfile();
    const viewportHeight = this.scrollDriver.getClientHeight();
    const decay = Math.max(jcMinDecay, 1 - attempt * jcDecayRate);
    const step = viewportHeight * decay;
    const deltaY = direction === 'up' ? -step : step;
    const result = this.scrollDriver.scrollBy(deltaY);
    return result.moved;
  }
```

- [ ] **Step 5: 类型检查**

```bash
pnpm compile
```

Expected: 编译通过

- [ ] **Step 6: 提交**

```bash
git add src/content/jumpController.ts
git commit -m "feat: JumpController 接入 ScrollProfile 速率参数

- 删除 SETTLE_MS 硬编码常量
- 构造函数新增 getProfile 回调参数（带默认值，向后兼容）
- scrollOneChunk 中衰减系数和最小衰减改为从 profile 读取
- settle 等待时间改为从 profile 读取

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 7: content.ts 入口注入 getProfile + 持久化 + 快捷键

**Files:**
- Modify: `entrypoints/content.ts`

- [ ] **Step 1: 新增 imports**

在文件顶部的 imports 区域新增：

```typescript
import { getScrollProfile, PROFILE_STORAGE_KEY, SCROLL_PROFILE_ORDER } from '../src/shared/scrollProfile';
import type { ScrollProfileName } from '../src/shared/scrollProfile';
```

- [ ] **Step 2: 创建 getProfile 回调并注入到 AutoCollector 和 JumpController**

在 `content.ts` 的 `main` 函数中，在 `runtimeStore` 创建之后、模块构造之前，新增：

```typescript
    // ScrollProfile: 从 RuntimeStore 动态读取当前 profile
    const getProfile = () => getScrollProfile(runtimeStore.getSnapshot().scrollProfileName);
```

修改 `jumpController` 构造：

```typescript
    const jumpController = new JumpController(scanner, cacheStore, scrollDriver, runtimeStore, getProfile);
```

修改 `autoCollector` 构造（在 `afterReplace` 回调之后新增 `getProfile`）：

```typescript
    const autoCollector = new AutoCollector(domAdapter, cacheStore, scrollDriver, runtimeStore, async () => {
      scanner.clearState();
      await scanner.rescan();
    }, getProfile);
```

- [ ] **Step 3: 启动时从 chrome.storage.local 恢复 profile 选择**

在 `scrollDriver.init()` 之前（约第 87 行之前），新增：

```typescript
    // 恢复持久化的 ScrollProfile 选择
    const profileResult = await chrome.storage.local.get(PROFILE_STORAGE_KEY);
    const savedProfile = profileResult[PROFILE_STORAGE_KEY] as ScrollProfileName | undefined;
    if (savedProfile && SCROLL_PROFILE_ORDER.includes(savedProfile)) {
      runtimeStore.setScrollProfile(savedProfile);
    }
```

- [ ] **Step 4: 新增 Ctrl+Shift+S 快捷键循环切换**

在 `onDebugKey` 监听器附近（约第 131 行之后），新增：

```typescript
    const onProfileSwitchKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'S') {
        const current = runtimeStore.getSnapshot().scrollProfileName;
        const idx = SCROLL_PROFILE_ORDER.indexOf(current);
        const next = SCROLL_PROFILE_ORDER[(idx + 1) % SCROLL_PROFILE_ORDER.length];
        runtimeStore.setScrollProfile(next);
        chrome.storage.local.set({ [PROFILE_STORAGE_KEY]: next });
        console.log(`[CQN] ScrollProfile switched to: ${next}`);
      }
    };
    window.addEventListener('keydown', onProfileSwitchKey);
```

在 `beforeunload` 清理中新增：

```typescript
      window.removeEventListener('keydown', onProfileSwitchKey);
```

- [ ] **Step 5: 新增 Popup 消息监听（SET_SCROLL_PROFILE）**

在 `chrome.runtime.onMessage.addListener` 中（约第 196 行之前），新增一个消息类型：

```typescript
      if (msg.type === 'SET_SCROLL_PROFILE') {
        const name = msg.name as ScrollProfileName;
        if (SCROLL_PROFILE_ORDER.includes(name)) {
          runtimeStore.setScrollProfile(name);
          chrome.storage.local.set({ [PROFILE_STORAGE_KEY]: name });
          sendResponse({ success: true });
        } else {
          sendResponse({ success: false, error: 'Invalid profile name' });
        }
        return true;
      }
```

- [ ] **Step 6: 类型检查**

```bash
pnpm compile
```

Expected: 编译通过

- [ ] **Step 7: 提交**

```bash
git add entrypoints/content.ts
git commit -m "feat: content.ts 接入 ScrollProfile — 注入回调 + 持久化 + 快捷键

- 创建 getProfile 回调并注入到 AutoCollector 和 JumpController
- 启动时从 chrome.storage.local 恢复持久化的 profile 选择
- 新增 Ctrl+Shift+S 快捷键循环切换 default → fast → turbo
- 新增 SET_SCROLL_PROFILE 消息监听（供 Popup 使用）

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 8: Popup 新增滚屏速率设置 UI

**Files:**
- Modify: `src/popup/PopupApp.tsx`
- Modify: `src/popup/popup.css`

- [ ] **Step 1: 在 popup.css 末尾新增速率设置样式**

```css
/* Scroll profile */
.profile-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.profile-options {
  display: flex;
  gap: 6px;
}

.profile-btn {
  flex: 1;
  padding: 6px 0;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
  transition: all 0.15s;
  text-align: center;
}

.profile-btn:hover {
  background: var(--bg-hover);
}

.profile-btn.is-active {
  border-color: var(--accent);
  background: rgba(16, 163, 127, 0.15);
  color: var(--accent);
  font-weight: 600;
}

.profile-reset {
  padding: 4px 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
  transition: color 0.15s;
  text-align: center;
}

.profile-reset:hover {
  color: var(--accent);
}
```

- [ ] **Step 2: 在 PopupApp.tsx 新增 profile 状态和切换逻辑**

1. 在 imports 之后、`STORAGE_LIMIT` 常量之前新增：

```typescript
import type { ScrollProfileName } from '../src/shared/scrollProfile';
import { SCROLL_PROFILE_ORDER, PROFILE_STORAGE_KEY } from '../src/shared/scrollProfile';

const PROFILE_LABELS: Record<ScrollProfileName, string> = {
  default: '标准',
  fast: '快速',
  turbo: '极速',
};
```

2. 在 `PopupApp` 函数内部，`const [operating, setOperating]` 之后新增：

```typescript
  const [profile, setProfile] = useState<ScrollProfileName>('default');
```

3. 在 `useEffect` 中（`refresh()` 之后），新增 profile 读取：

```typescript
  useEffect(() => {
    refresh();
    chrome.storage.local.get(PROFILE_STORAGE_KEY).then((result) => {
      const saved = result[PROFILE_STORAGE_KEY] as ScrollProfileName | undefined;
      if (saved && SCROLL_PROFILE_ORDER.includes(saved)) {
        setProfile(saved);
      }
    });
  }, [refresh]);
```

注意：需要将原来的空依赖数组 `[refresh]` 保持不变。

4. 新增 profile 切换处理函数（在 `handleLruCleanup` 之后）：

```typescript
  const handleProfileChange = async (name: ScrollProfileName) => {
    setProfile(name);
    await chrome.storage.local.set({ [PROFILE_STORAGE_KEY]: name });
    try {
      await sendMessage({ type: 'SET_SCROLL_PROFILE', name });
    } catch {
      // Content script may not be running — storage is the source of truth
    }
  };

  const handleProfileReset = () => {
    handleProfileChange('default');
  };
```

- [ ] **Step 3: 在 Popup JSX 中新增速率设置 UI**

在存储用量 `storage-meter` div 之后、`{info && info.conversations.length > 0 &&` 之前（即约第 203 行之前），插入：

```tsx
      <div class="divider" />

      <div class="profile-section">
        <div class="section-title">滚屏速率</div>
        <div class="profile-options">
          {SCROLL_PROFILE_ORDER.map((name) => (
            <button
              key={name}
              class={`profile-btn ${profile === name ? 'is-active' : ''}`}
              onClick={() => handleProfileChange(name)}
            >
              {PROFILE_LABELS[name]}
            </button>
          ))}
        </div>
        {profile !== 'default' && (
          <button class="profile-reset" onClick={handleProfileReset}>
            重置为标准
          </button>
        )}
      </div>
```

- [ ] **Step 4: 类型检查**

```bash
pnpm compile
```

Expected: 编译通过

- [ ] **Step 5: 提交**

```bash
git add src/popup/PopupApp.tsx src/popup/popup.css
git commit -m "feat: Popup 新增滚屏速率设置区域

- 新增滚屏速率 section，含标准/快速/极速三档切换按钮
- 非默认档位时显示「重置为标准」按钮
- 选择通过 chrome.storage.local 持久化
- 同时向 content script 发送 SET_SCROLL_PROFILE 消息

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 9: 构建验证

**Files:** 无代码变更

- [ ] **Step 1: 运行生产构建**

```bash
pnpm build
```

Expected: 构建成功，无错误

- [ ] **Step 2: 运行类型检查**

```bash
pnpm compile
```

Expected: 无错误

- [ ] **Step 3: 在浏览器中手动验证**

1. 加载 `.output/chrome-mv3` 到 Chrome
2. 打开一个长 ChatGPT 对话
3. 点击扩展图标 → Popup 应显示「滚屏速率」区域
4. 切换到「快速」档 → 控制台应显示 `[CQN] ScrollProfile switched to: fast`
5. 触发全量采集 → 观察滚动速度是否明显加快
6. 点击缓存消息跳转 → 观察跳转速度
7. 切换到「极速」档 → 重复观察
8. 点击「重置为标准」→ profile 应恢复 default
9. 刷新页面 → profile 选择应持久化
10. 按 Ctrl+Shift+S → profile 应循环切换

---

### Task 10: 更新 CLAUDE.md 文件树和架构说明

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: 更新架构说明**

在「内容层」表格的 `RuntimeStore` 行，更新描述以反映新增功能：

```
| `RuntimeStore` | ... 含 autoCollectProgress 状态和 scrollProfileName 速率档位 |
```

在 `content.ts` 入口描述中补充 profile 注入说明。

- [ ] **Step 2: 更新 docs/Tree.md 文件树**

在 `src/shared/` 区域新增 `scrollProfile.ts` 条目。

- [ ] **Step 3: 提交**

```bash
git add CLAUDE.md docs/Tree.md
git commit -m "docs: 更新 CLAUDE.md 和文件树反映 ScrollProfile 功能

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```
