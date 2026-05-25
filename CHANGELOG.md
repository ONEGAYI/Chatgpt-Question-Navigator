# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - 2025-05-25

首个公开版本。实现了 ChatGPT 长对话页面的用户问题导航侧栏，包含完整的消息扫描与缓存、Skeleton-First Hydration 全量采集、渐进式远距离跳转、AI 锚点消息展示、Popup 缓存管理、可配置滚屏速率等核心功能。

### 新功能

- **基础架构与数据采集（Phase 1）** — WXT 扩展工程初始化、共享类型与文本工具、DOM 适配器（DomAdapter）、滚动驱动（ScrollDriver）、运行期状态管理（RuntimeStore）、本地缓存（CacheStore）、URL 监听（UrlWatcher）、消息扫描引擎（MessageScanner）
- **Shadow DOM 侧栏 UI（Phase 2）** — 导航侧栏组件（折叠/展开），通过 WXT `createShadowRootUi` 实现样式隔离，CSS 变量支持暗色/亮色主题
- **搜索与预览体验完善** — 搜索框 300ms 防抖、关键词高亮、hover 预览、active/mounted/cached 状态区分展示
- **消息直接跳转（Phase 3）** — 已挂载消息居中滚动 + 1.5 秒目标高亮，高亮样式动态注入
- **Popup 缓存管理界面** — 浏览器扩展 Popup 页面，含存储用量仪表、对话列表、缓存操作按钮（逐条删除、清空全部、LRU 清理）。（#1）
- **WXT Edge 持久化 dev profile** — Edge 开发浏览器启动配置，支持持久化 profile 和独立 worktree 调试
- **构建产物自动拷贝** — 构建后自动拷贝到 `%TEMP%` 统一加载路径，支持多 worktree 并行开发
- **Mini Bar 三态导航** — 侧边栏三态切换（展开/Mini/折叠），滑动窗口渲染、▲/▼ 导航、hover preview fixed 定位修复溢出裁剪，mode 通过 chrome.storage.local 持久化。（#5）
- **侧栏清除当前会话缓存按钮** — 展开模式侧栏 Header 垃圾桶按钮，二次确认后清除当前会话缓存并重新扫描。（#9）
- **ScrollDriver 完整重写** — 引入 ScrollRoot 模型，多源候选收集（selector/main 后代/main 祖先/user message 祖先链/DOM root）+ 评分 + 最小滚动验证，document root 归一化为 window kind，操作结果追踪、viewport 判断、用户滚动方向捕获（wheel/touch/keyboard），运行时重检 + 诊断快照（Ctrl+Shift+D）。（#10）
- **Skeleton-First Hydration 采集重构** — 三阶段流程：扫描所有 turn 骨架 → bottom-to-top 滚动逐帧水合 → 可选 fallback top-to-bottom 补充水合。支持 cancel、跨 reload 恢复（intent 持久化）、每 20 轮 checkpoint 增量持久化，完成后原子替换缓存（canonical 顺序）。（#11）
- **渐进式跳转（Phase 4）** — 点击未挂载消息触发渐进式跳转循环：scrollRatio 种子定位 + orderKey 自适应步进，JumpToken 可取消（用户滚动/Esc/新跳转自动取消），JumpToast 显示进度和失败状态。（#13）
- **AI 锚点消息** — 缓存同时包含 user 和 assistant 消息，AI turn 作为隐藏锚点参与 visibleRange 计算，扩展跳转的连续推进能力。（#13）
- **AI 消息侧栏展示** — 展开模式以树状缩进（SVG 连接器）+ 引用块展示 AI 消息（A1/A2 编号），MiniBar 中 AI 消息为缩细条标记。`computeActiveMessageId` 同时追踪 user 和 assistant 消息，active 高亮可在 Q 和 A 之间平滑切换。（#16）
- **AI 加载动画 + 流式期间防抖优化** — AI 回复生成中显示三点跳动动画（展开模式）和呼吸动画（MiniBar），流式输出期间 rescan 防抖从 500ms 提升至 3000ms，generation counter 防止旧 rescan 覆盖新数据，TURN_SELECTOR 集中管理。（#17）
- **ScrollProfile 可配置滚屏速率** — 新增 default/fast/turbo 三档预置速率参数，影响 AutoCollector 采集速度和 JumpController 跳转步进。Popup 设置区域可切换（Ctrl+Shift+S 快捷键也可循环切换），通过 chrome.storage.local 持久化，默认极速。（#19）
- **版本管理脚本** — `scripts/bump.mjs` 支持 patch/minor/major/精确版本号四种模式，`--dry-run` 预览，同步更新 package.json 和 wxt.config.ts
- **发布流程脚本** — `scripts/release.mjs` 自动执行 pull → push → build → zip 四步发布流程

### Bug 修复

- **消息排序键修复** — 将 orderKey 从 domOrderIndex 改为 absoluteTop（元素绝对垂直位置），修复跨扫描合并时消息交错的问题
- **切换对话缓存竞态** — rescan() 入口改为从 DOM URL 取 conversationId 作为真相源，检测到 conversationId 变化时先 flush 旧缓存再加载新对话
- **切换对话旧消息污染** — SPA 导航时不再在 DOM 过渡期扫描（改为 clearState），让 MutationObserver 在 DOM 真正更新后自然触发 rescan。（#3）
- **消息全局顺序稳定** — 在缓存中维护 orderedIds，通过 anchor-splice 将每次扫描的局部连续片段合并进持久顺序，修复虚拟化 DOM 下 Q 编号被重新洗牌的问题。（#4）
- **分段合并消息顺序** — MessageScanner 按视觉 gap 切分可信局部片段，CacheStore 按 segment 合并 orderedIds，避免远处残留消息被错误用作 anchor。（#6）
- **用户滚动方向提前捕获** — ScrollDriver 在 wheel/key/touch 输入阶段产出 up/down 方向，修复懒加载 mutation 扫描时方向为 unknown 导致历史消息排序错误的问题。（#7）
- **scroll root 检测时序** — 新增 main 祖先候选源（ChatGPT 滚动容器是 main 的父级 DIV），content script init 时轮询 redetect（每秒一次，最多 10 次）等待异步渲染完成
- **ScrollDriver 6 项缺陷修复** — 检测期间 scroll 事件抑制、target 切换时 timer 竞态、beforeunload 资源泄漏、短对话无恢复路径、main 后代扫描上限防卡顿、移除死代码
- **渐进式跳转 attempt 0 回到顶部** — scrollRatio 种子与当前位置差距小于 2% 时跳过绝对定位，改为相对步进，确保重复跳转能够累进
- **AI anchor textHash 不一致** — 先计算 toAiSearchText 再取 hash，确保 textHash 和 textForSearch 基于相同 normalized 输入
- **虚拟化残留 DOM 节点误判为 mounted** — 新增 isDirectMountCandidateTurn viewport 邻近过滤（+-1 viewport buffer）、tryLandOnMounted 后置验证、decideDirection ratioHint 参数。修复侧栏误显示"可跳转"且跳转只微微滚动就退出的问题。（#21）
- **highlightMessage 和 flush 执行顺序** — tryLandOnMounted 中将 highlightMessage 移到 flush 成功之后，确保只有持久化成功才触发视觉反馈。（#22）
- **async onMessage 回调 sendResponse 失效** — 将 SET_SCROLL_PROFILE 分支改为 .then() 链式调用，移除回调的 async 声明

### 其他改进

- **CI 双层自动审查配置** — PR Agent（DeepSeek V4 Flash 增量审查）+ CodeRabbit 双层配置，含中文审查、skip-review 标签、失败自动重试。（#2）
- **CachedUserMessage 重命名为 CachedMessage** — 语义统一，自 AI 锚点消息功能引入后原类型名不再准确，纯机械替换无逻辑变更。（#14）
- **替换扩展图标** — 将 1x1 占位图替换为正式 1254x1254 索引色 PNG 图标，构建体积从 1.09MB 降至 297KB
- **ScrollProfile 默认极速** — 实测极速模式无问题，RuntimeStore 和 Popup 默认 scrollProfileName 改为 'turbo'，移除 Popup 重置按钮，跳转失败提示加调速引导
- **.claude 文件夹 gitignore** — 添加对 .claude 文件夹的排除

<!-- 变更链接 -->
[0.1.0]: https://github.com/ONEGAYI/Chatgpt-Question-Navigator/commits/v0.1.0
