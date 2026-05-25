# 修复跳转状态：mounted 虚假判定 + Progressive Jump 中断

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 ChatGPT 长对话中底部消息在视口顶部仍显示 mounted 状态，点击后跳转只微微滚动就退出的 bug。

**Architecture:** 三层修复 — (1) MessageScanner 的 live rescan 增加 viewport 邻近过滤，只接受视口附近的 turn 作为 mounted；(2) JumpController 的 direct landing 增加后置验证，scroll 后必须确认目标真正进入 viewport；(3) direct landing 失败时 fallthrough 到 progressive jump 而非提前退出。

**Tech Stack:** TypeScript, Preact, WXT (browser extension), Chrome Extension Manifest V3

> **⚠️ 行号仅供参考：** 本计划中的行号均基于修复前的代码快照，代码一旦新增方法/常量即会漂移。实现时必须以函数名、变量名、代码片段搜索为准，不得机械依赖行号。

---

## Hard Constraints（硬约束，违反即 plan 失败）

1. **不得修改 `AutoCollector.scanAllTurnSkeletons()` 的全量 skeleton 遍历逻辑。不得把 viewport 过滤直接套到 AutoCollector。**
2. **`registerAnchorTurnElements()` 不得绕过 viewport-near 过滤。** 否则 AI anchor 会重新污染 `elementById`/`mountedIds`/`visibleRange`。
3. **`tryLandOnMounted` 返回 false 只表示 direct landing 失败，不代表整个 jump 失败。** 不得 `setJumpState failed`，不得 `return false` 退出 `jumpToCachedMessage`。
4. **不按固定数量（如"底部 3 个"）特判。** 过滤必须基于 DOM 几何可达性。
5. **不默认保留 `console.log` 噪声。** 调试输出必须受 `DEBUG_SCAN` / `DEBUG_JUMP` 常量控制且默认为 false。
6. **每个 Task 完成后只运行 `pnpm compile`，不自动 commit。** 等用户明确要求或全部 Task 完成后统一提交。

---

## Root Cause

1. **`mountedIds` 被 offscreen DOM 节点污染** — ChatGPT 虚拟化保留底部 turn 节点但移出 viewport，`isConnected` 仍为 true。`rescan()` 的 `findTurnElements()` 返回全部 DOM turn，无 viewport 过滤。`registerAnchorTurnElements()` 对所有 `isConnected` 的 AI turn 无条件注册。
2. **`landOnTarget()` 无后置验证** — `scrollElementIntoView()` 后只等 400ms 就返回 true，不检查元素是否真正进入 viewport、rect 是否有尺寸。
3. **假 mounted → 跳转提前退出** — `jumpToMounted()` 返回 true → `jumpToMessage()` 直接 return，progressive jump 永远没机会执行。

## Files

| Action | Path | Responsibility |
|--------|------|----------------|
| Modify | `src/content/messageScanner.ts` | 新增 viewport 邻近过滤，限制 mountedIds 范围 |
| Modify | `src/content/jumpController.ts` | 新增 tryLandOnMounted 后置验证，改造跳转 fallthrough |
| Modify | `src/ui/MessageItem.tsx` | 更准确的状态文案 |

---

### Task 1: MessageScanner — 新增 viewport 邻近过滤方法 + 应用

**Files:**
- Modify: `src/content/messageScanner.ts`

**前置知识：** `rescan()` 在第 101 行调用 `this.domAdapter.findTurnElements()` 获取所有 turn DOM 节点，然后在第 106-179 行遍历处理。`registerAnchorTurnElements()` 在第 344-363 行再次遍历所有 turn 注册 AI anchor。这两个遍历都需要加入 viewport 过滤。

- [ ] **Step 1: 添加 `DEBUG_SCAN` 常量和 `isDirectMountCandidateTurn` 私有方法**

在 `MIN_SEGMENT_GAP_PX = 320;` （第 14 行）之后添加常量：

```typescript
const DEBUG_SCAN = false;
```

在 `rescanGeneration = 0;` （约第 34 行）之后、`constructor` 之前，添加方法：

```typescript
  /**
   * 判断 turn 元素是否在 viewport 附近，是 live rescan 的 mounted 候选。
   * 这是普通 live rescan 的过滤，不用于 AutoCollector 全量骨架扫描。
   * ChatGPT 虚拟化可能保留 DOM 节点但将其移出 viewport（isConnected 仍为 true）。
   * DOM connected 不能等价于 mounted — 只有几何上可达的节点才应进入 mountedIds。
   * viewport 必须来自 scrollDriver.getViewportRect()，不要直接使用 window.innerHeight，
   * 否则 element scroll root 场景会误判。
   */
  private isDirectMountCandidateTurn(turnEl: HTMLElement): boolean {
    if (!turnEl.isConnected) return false;
    const rect = turnEl.getBoundingClientRect();
    if (rect.height <= 0 || rect.width <= 0) return false;
    const viewport = this.scrollDriver.getViewportRect();
    // buffer = 1 个 viewport 高度。mounted 语义是"附近可定位"而非"当前可见"。
    // 如果改为"当前可见"，文案需同步调整为"当前可见可定位"并收紧 buffer。
    const buffer = this.scrollDriver.getClientHeight();
    const eligible = rect.bottom >= viewport.top - buffer
      && rect.top <= viewport.bottom + buffer;
    if (!eligible && DEBUG_SCAN) {
      const turnKey = this.domAdapter.extractTurnKey(turnEl);
      // 使用 plain object 而非 live DOMRect，避免浏览器控制台显示不稳定
      const rectInfo = { top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
      const viewportInfo = { top: viewport.top, bottom: viewport.bottom, height: viewport.height };
      console.debug('[CQN SCAN] filtered offscreen turn:', turnKey, rectInfo, viewportInfo);
    }
    return eligible;
  }
```

- [ ] **Step 2: 在 `rescan()` 的 turnElements 遍历中加入过滤**

找到 `rescan()` 方法中第 106-108 行：

```typescript
    for (let index = 0; index < turnElements.length; index += 1) {
      const turnEl = turnElements[index];
      if (!turnEl) continue;
```

在 `if (!turnEl) continue;` 之后插入一行：

```typescript
      if (!this.isDirectMountCandidateTurn(turnEl)) continue;
```

修改后该段为：

```typescript
    for (let index = 0; index < turnElements.length; index += 1) {
      const turnEl = turnElements[index];
      if (!turnEl) continue;
      if (!this.isDirectMountCandidateTurn(turnEl)) continue;

      const turnKey = this.domAdapter.extractTurnKey(turnEl);
      ...
```

**验证点（mental check）：** 如果过滤后 candidates 为空，`resolveScannedSegments(conversationId, [])` 会返回 `{ allMessages: existing, resolvedMounted: empty, ... }`。已有缓存消息不会被清空，`runtimeStore.messages` 保留缓存列表，只是 `mountedIds`/`elementById` 变为空或变少。这是正确行为。

- [ ] **Step 3: 在 `registerAnchorTurnElements()` 中加入同样的过滤**

找到 `registerAnchorTurnElements` 方法（约第 344-363 行），当前代码：

```typescript
    for (const turnEl of allTurnElements) {
      const turnKey = this.domAdapter.extractTurnKey(turnEl);
      if (!turnKey) continue;

      const localId = `${conversationId}::turn::${turnKey}`;
      const cached = messageById.get(localId);
      if (!cached || cached.role !== 'assistant') continue;

      if (!this.elementById.has(localId) && turnEl.isConnected) {
```

修改为 — 在 `if (!turnKey) continue;` 后插入过滤，并移除已被包含的 `turnEl.isConnected` 检查：

```typescript
    for (const turnEl of allTurnElements) {
      const turnKey = this.domAdapter.extractTurnKey(turnEl);
      if (!turnKey) continue;
      if (!this.isDirectMountCandidateTurn(turnEl)) continue;

      const localId = `${conversationId}::turn::${turnKey}`;
      const cached = messageById.get(localId);
      if (!cached || cached.role !== 'assistant') continue;

      if (!this.elementById.has(localId)) {
```

**验收标准：** `registerAnchorTurnElements()` 不得绕过 viewport-near 过滤。

- [ ] **Step 4: 移除 rescan() 中的 debug console.log**

找到 `rescan()` 中约第 161-162 行：

```typescript
        console.log('[CQN] rescan: assistant anchor turnKey=', turnKey, 'turnIndex=', turnIndex,
          'hasText=', !!text, 'preview=', preview.slice(0, 30));
```

删除这两行。

- [ ] **Step 5: 运行类型检查**

Run: `pnpm compile`
Expected: 无错误

- [ ] **Step 6: 全仓搜索确认 filter 方法引用一致**

Run: `rg 'isDirectMountCandidateTurn|isLiveScanEligibleTurn' src`
Expected: 只有 `messageScanner.ts` 中的定义和调用，无其他文件引用。

---

### Task 2: JumpController — 新增 tryLandOnMounted 后置验证 + 流程 fallthrough

**Files:**
- Modify: `src/content/jumpController.ts`

**前置知识：** `jumpToMessage()` 在第 63 行先调 `jumpToMounted()`，成功则直接 return；失败则进入 `jumpToCachedMessage()` 循环。`jumpToCachedMessage()` 循环内有两处直接调用 `landOnTarget()`（第 126 行和第 143 行），也都是成功即 return。

- [ ] **Step 1: 新增 `tryLandOnMounted` 私有方法**

在 `jumpToMounted` 方法（约第 247 行）之前，添加新方法：

```typescript
  /**
   * 尝试直接落地到已挂载的元素。scroll 后验证目标真正进入 viewport 才算成功。
   * 返回 false 只表示 direct landing 失败，不代表整个 jump 失败。
   * 调用方必须 fallthrough 到 progressive jump，不得 setJumpState failed 或退出。
   */
  private async tryLandOnMounted(target: CachedMessage, token: JumpToken, smooth: boolean): Promise<boolean> {
    const el = this.scanner.getElementByLocalId(target.localMessageId);
    if (!el?.isConnected) return false;

    const rectBefore = el.getBoundingClientRect();
    if (rectBefore.height <= 0 || rectBefore.width <= 0) return false;

    // 使用 behavior: 'auto' 保证验证确定性。smooth 可能未完成就误判失败。
    // 需要 visual 平滑效果可以后续优化，不影响判定正确性。
    const scrollResult = this.scrollDriver.scrollElementIntoView(el, {
      block: 'center',
      behavior: 'auto',
    });

    // 保留 scrollResult 供 debug 参考，但最终成功标准以 rect + isElementInViewport 为准。
    // scrollResult.moved=false 不代表失败（目标可能已在 viewport 内）。
    if (DEBUG_JUMP) {
      console.debug('[CQN Jump] tryLandOnMounted scrollResult:', scrollResult, 'rectBefore:', rectBefore);
    }

    await waitForDomSettled(this.getProfile().jcSettleMs);
    if (!this.isCurrent(token)) return false;
    if (!el.isConnected) return false;

    const rectAfter = el.getBoundingClientRect();
    if (rectAfter.height <= 0 || rectAfter.width <= 0) return false;
    if (!this.scrollDriver.isElementInViewport(el)) return false;

    if (DEBUG_JUMP) {
      const rectInfo = { top: rectAfter.top, bottom: rectAfter.bottom, width: rectAfter.width, height: rectAfter.height };
      console.debug('[CQN Jump] tryLandOnMounted verify: rectAfter=', rectInfo, 'inViewport=', true);
    }

    this.highlightMessage(el);
    this.scanner.updateScrollMeta(target.localMessageId, this.scrollDriver.getScrollTop(), this.scrollDriver.getScrollRatio());
    await this.cacheStore.flush();
    return true;
  }
```

- [ ] **Step 2: 改造 `jumpToMounted` 使用 `tryLandOnMounted`**

将当前的 `jumpToMounted` 方法（约第 247-251 行）：

```typescript
  private async jumpToMounted(target: CachedMessage, token: JumpToken): Promise<boolean> {
    const el = this.scanner.getElementByLocalId(target.localMessageId);
    if (!el?.isConnected) return false;
    return await this.landOnTarget(el, target, token, true);
  }
```

替换为：

```typescript
  private async jumpToMounted(target: CachedMessage, token: JumpToken): Promise<boolean> {
    return await this.tryLandOnMounted(target, token, true);
  }
```

- [ ] **Step 3: 改造 `jumpToCachedMessage` 中的 el?.isConnected 分支**

找到 `jumpToCachedMessage` 方法中约第 124-127 行：

```typescript
      const el = this.scanner.getElementByLocalId(target.localMessageId);
      if (el?.isConnected) {
        return await this.landOnTarget(el, target, token, true);
      }
```

替换为 fallthrough 模式。注意：tryLandOnMounted 失败后，fallthrough 继续执行本 attempt 内的 rescan，随后重建 elementById 清理 stale mapping。不在同一 attempt 内重复尝试同一个 stale element。

```typescript
      const el = this.scanner.getElementByLocalId(target.localMessageId);
      if (el?.isConnected) {
        const landed = await this.tryLandOnMounted(target, token, true);
        if (landed) return true;
        // fallthrough: 元素虽然在 DOM 中但不可真实定位，继续 progressive jump。
        // 后续 rescan 会重建 elementById，清理 stale mapping。
      }
```

- [ ] **Step 4: 改造 `jumpToCachedMessage` 中的 mountedIds.has 分支**

找到约第 140-145 行：

```typescript
      if (result.mountedIds.has(target.localMessageId)) {
        const found = this.scanner.getElementByLocalId(target.localMessageId);
        if (found?.isConnected) {
          return await this.landOnTarget(found, target, token, true);
        }
      }
```

替换为 fallthrough 模式：

```typescript
      if (result.mountedIds.has(target.localMessageId)) {
        const landed = await this.tryLandOnMounted(target, token, true);
        if (landed) return true;
        // fallthrough: mountedIds 记录可能过时，继续 progressive jump。
      }
```

- [ ] **Step 5: 删除已无调用者的 `landOnTarget` 方法**

找到 `landOnTarget` 方法（约第 224-235 行）：

```typescript
  private async landOnTarget(el: HTMLElement, target: CachedMessage, token: JumpToken, smooth: boolean): Promise<boolean> {
    if (!this.isCurrent(token)) return false;
    this.scrollDriver.scrollElementIntoView(el, { block: 'center', behavior: smooth ? 'smooth' : 'auto' });
    this.highlightMessage(el);
    if (smooth) {
      await waitForDomSettled(400);
      if (!this.isCurrent(token)) return false;
    }
    this.scanner.updateScrollMeta(target.localMessageId, this.scrollDriver.getScrollTop(), this.scrollDriver.getScrollRatio());
    await this.cacheStore.flush();
    return true;
  }
```

整个方法删除。

- [ ] **Step 6: 运行类型检查 + 全仓搜索确认无遗留引用**

Run:
```bash
pnpm compile
rg 'landOnTarget' src
```
Expected: compile 无错误；rg 无结果（landOnTarget 已无任何引用）。

再确认新方法引用：
```bash
rg 'tryLandOnMounted|jumpToMounted' src
```
Expected: 只有 `jumpController.ts` 中的定义和调用。

---

### Task 3: MessageItem — UI 文案调整

**Files:**
- Modify: `src/ui/MessageItem.tsx:54`

**设计说明：** mounted 过滤 buffer 为 ±1 viewport，语义是"附近可定位"而非"当前可见"。文案必须与 mounted 语义一致。

- [ ] **Step 1: 更新用户消息状态文案**

找到第 54 行：

```typescript
  const metaText = isJumping ? '⟳ 跳转中…' : mounted ? '● 当前可跳转' : '○ 已缓存';
```

替换为：

```typescript
  const metaText = isJumping ? '⟳ 跳转中…' : mounted ? '● 附近可定位' : '○ 已缓存，点击定位';
```

- [ ] **Step 2: 运行类型检查**

Run: `pnpm compile`
Expected: 无错误

---

### Task 4: 最终验证

- [ ] **Step 1: 运行全部自动化检查**

Run:
```bash
pnpm compile
pnpm test:order
pnpm build
git diff --check
```

Expected: 全部通过。注意：项目无 `pnpm test` 脚本，只有 `pnpm test:order`。`git diff --check` 抓尾随空格、冲突标记等低级问题。

- [ ] **Step 2: 全仓搜索确认关键方法引用一致**

Run:
```bash
rg 'isDirectMountCandidateTurn|tryLandOnMounted|landOnTarget|registerAnchorTurnElements|isLiveScanEligibleTurn' src
```

Expected:
- `isDirectMountCandidateTurn`：仅在 `messageScanner.ts` 定义和调用
- `tryLandOnMounted`：仅在 `jumpController.ts` 定义和调用
- `landOnTarget`：无结果（已删除）
- `isLiveScanEligibleTurn`：无结果（未使用此名称）

- [ ] **Step 2b: 确认无新增默认 console.log**

Run:
```bash
rg 'console\.log\(' src
```
Expected: 无本次修复新增的 `console.log`。允许 `console.debug` 但必须受 `DEBUG_*` 开关控制。

- [ ] **Step 3: 手动验证场景**

以下场景需在真实 ChatGPT 长对话页面手动验证：

1. **长对话顶部 → 底部状态**：打开 15+ 轮对话，采集后滚动到顶部，侧栏最底部的用户问题应显示"○ 已缓存，点击定位"而非"● 附近可定位"
2. **刷新后立即顶部**：刷新页面，从底部进入后手动滚到顶部（不点重新采集），观察底部问题是否仍错误显示 mounted
3. **底部问题 progressive jump**：点击底部已缓存问题，应进入持续 progressive jump，不应只轻微滚动后退出
4. **当前 viewport 问题 direct landing**：当前视口附近的问题应显示"● 附近可定位"，点击后快速 direct landing
5. **AI anchor 不污染 visibleRange**：远离 viewport 的 AI turn 不应因 registerAnchorTurnElements 被注册为 mounted
6. **AutoCollector 不受影响**：重新采集仍能收集完整骨架和用户问题
7. **candidates 为空时侧栏不丢消息**：过滤到无 candidate 时，侧栏列表仍显示缓存消息，只是 mounted 状态全变为 cached
8. **旧缓存容错**：使用旧缓存（不清缓存直接验证），点击底部 cached 项即使 `lastKnownScrollRatio` 旧值不准，也不应 direct 成功退出，应继续 progressive jump

---

## Acceptance Criteria

- [ ] 在顶部时，远离 viewport 的底部用户问题不再进入 `mountedIds`
- [ ] 侧栏底部问题不再显示 mounted 文案
- [ ] 点击这些 cached 问题时，direct landing 失败后必须继续 progressive jump
- [ ] direct landing 只有在 scroll 后目标元素真实进入 viewport 且 rect 非零时才返回 true
- [ ] `registerAnchorTurnElements()` 不得绕过 viewport-near 过滤
- [ ] `tryLandOnMounted` 返回 false 时不得调用 `updateScrollMeta`，不得把 phantom 节点当前位置写回 cache
- [ ] AutoCollector 全量骨架扫描不受 live scan 过滤影响
- [ ] candidates 为空时，缓存消息列表不被清空，只是 mountedIds/elementById 变为空或变少
- [ ] `pnpm compile`、`pnpm test:order`、`pnpm build` 通过
- [ ] 不默认保留 console.log 噪声
- [ ] 不按固定"底部 3 个"特判

## 边界情况说明

| 场景 | 预期行为 | 理由 |
|------|----------|------|
| AutoCollector 骨架水合 | 不受影响 | AutoCollector 使用 `scanAllTurnSkeletons()` 独立流程，不走 `rescan()`。不得修改 |
| 短对话（全部在 viewport） | 所有 turn 正常 mounted | 所有 turn 都在 viewport ± 1 clientHeight 范围内 |
| 滚动时 scheduleScrollCapture | 不受影响 | 已有 `isElementInViewport` 检查 |
| canonical 模式 | 不受影响 | 过滤不影响 orderMode 逻辑 |
| 正常 direct landing | 仍快速定位 | viewport 内元素通过后置验证无额外开销 |
| rescan 过滤到 0 candidate | 缓存保留、mountedIds 清空 | `resolveScannedSegments(id, [])` 返回 existing messages，`mountedIds` 为空 |

## 未自动化覆盖的风险

本修复不要求引入新的浏览器 DOM 测试框架；如无现成框架，保留手动验证清单即可。

项目当前没有浏览器 DOM 测试框架。以下是最小回归测试思路，待引入测试框架后实现：

- mock 一个 `isConnected=true` 但 `getBoundingClientRect()` 返回远在 viewport 外的 HTMLElement
- `getElementByLocalId` 返回该元素
- `tryLandOnMounted` 应返回 false
- `jumpToCachedMessage` 不应提前成功，应继续调用 `scrollBy`/`scrollToRatio`
