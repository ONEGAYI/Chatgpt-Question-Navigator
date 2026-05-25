# ScrollProfile 可配置速率设计

## 背景

AutoCollector 全量采集和 JumpController 渐进式跳转的滚屏速率由硬编码常量控制。长对话（500+ 轮）中，采集耗时可达 8-10 分钟。本设计将这些常量提取为可切换的 profile，在不引入回归的前提下提升速率。

## 目标

- 提供 default / fast / turbo 三档滚屏速率
- 通过 Popup 切换并持久化用户选择
- 提供重置按钮恢复默认
- default 档精确还原当前行为（零回归）
- 开发者快捷键 `Ctrl+Shift+S` 循环切换（便于 A/B 对比）

## 核心类型

### ScrollProfile

定义在 `src/shared/scrollProfile.ts`：

```typescript
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
```

### 预置参数

| 参数 | default | fast | turbo |
|------|---------|------|-------|
| acScrollStepRatio | 0.7 | 0.85 | 1.0 |
| acSettleStableMs | 500 | 300 | 200 |
| acSettleQuietMs | 400 | 250 | 150 |
| acSettlePollMs | 100 | 80 | 50 |
| jcSettleMs | 500 | 300 | 200 |
| jcDecayRate | 0.03 | 0.02 | 0.01 |
| jcMinDecay | 0.3 | 0.4 | 0.5 |

导出 `SCROLL_PROFILES: Record<ScrollProfileName, ScrollProfile>` 和辅助函数 `getScrollProfile(name: ScrollProfileName): ScrollProfile`。

## 存储与切换

### RuntimeStore

- 新增 `scrollProfileName: ScrollProfileName` 状态字段，默认 `'default'`
- 新增 `setScrollProfile(name: ScrollProfileName): void` 方法，更新状态并 emit

### 持久化

- `chrome.storage.local` key: `cqn-scroll-profile`
- content script 启动时读取并调用 `runtimeStore.setScrollProfile()`

### 切换入口

1. **Popup 设置区域**：新增「滚屏速率」section，含三个 radio 按钮 + 「重置」按钮
2. **开发者快捷键**：`Ctrl+Shift+S` 循环切换 `default → fast → turbo → default`

## 模块集成

### AutoCollector

- 注入方式：构造函数新增 `getProfile: () => ScrollProfile` 回调
- 替换点：
  - `SCROLL_STEP_RATIO` → `profile.acScrollStepRatio`
  - `SETTLE_STABLE_MS` → `profile.acSettleStableMs`
  - `SETTLE_QUIET_MS` → `profile.acSettleQuietMs`
  - `SETTLE_POLL_MS` → `profile.acSettlePollMs`
- 每次 settle 循环开始时读取最新 profile（支持运行时切换）

### JumpController

- 注入方式：同 AutoCollector，构造函数新增 `getProfile: () => ScrollProfile` 回调
- 替换点：
  - `SETTLE_MS` → `profile.jcSettleMs`
  - `scrollOneChunk` 中 `0.03` → `profile.jcDecayRate`、`0.3` → `profile.jcMinDecay`
- `MAX_ATTEMPTS`（200）保持不变，不归 profile 管理

### content.ts 入口

- 创建 `getProfile` 回调：`() => getScrollProfile(runtimeStore.getSnapshot().scrollProfileName)`
- 传入 AutoCollector 和 JumpController 构造函数

## 回归防护

- default 档所有参数与当前硬编码值完全一致
- turbo 档 `acSettleStableMs=200` 仍高于 ChatGPT DOM 典型渲染周期（~50-100ms）
- turbo 档 `acScrollStepRatio=1.0` 每步一屏，不会跳过虚拟化区域（ChatGPT 使用懒加载而非严格虚拟化）
- 所有档位的 settle 逻辑（stable + quiet 双条件）保持不变，只调整时间值

## 文件变更清单

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `src/shared/scrollProfile.ts` | 新增 | ScrollProfile 类型 + 预置档位 |
| `src/shared/types.ts` | 修改 | RuntimeState 新增 scrollProfileName |
| `src/content/runtimeStore.ts` | 修改 | 新增 scrollProfileName 状态 + setScrollProfile |
| `src/content/autoCollector.ts` | 修改 | 硬编码常量 → profile 读取 |
| `src/content/jumpController.ts` | 修改 | 硬编码常量 → profile 读取 |
| `entrypoints/content.ts` | 修改 | 创建 getProfile 回调，注入到 AutoCollector/JumpController |
| `src/popup/PopupApp.tsx` | 修改 | 新增滚屏速率设置区域 |
| `src/popup/popup.css` | 修改 | 新增速率设置样式 |
