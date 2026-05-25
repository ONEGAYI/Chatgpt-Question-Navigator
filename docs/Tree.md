# 文件树

```
chatgpt-question-navigator/
├── entrypoints/
│   ├── content.ts                  # WXT content script 入口，装配所有模块并启动
│   └── popup/
│       ├── index.html              # Popup 入口 HTML，WXT 自动注册为 action.default_popup
│       └── main.tsx                # Preact 挂载点，渲染 PopupApp
├── src/
│   ├── content/
│   │   ├── autoCollector.ts        # 自动 bottom-to-top 采集，按钮触发，生成 canonical 顺序（含 AI 锚点）
│   │   ├── cacheStore.ts           # chrome.storage.local 持久化，按会话缓存消息，LRU 清理
│   │   ├── domAdapter.ts           # ChatGPT DOM 结构查询抽象，选择器集中定义
│   │   ├── jumpController.ts       # 跳转控制：已挂载直接跳转 + 未挂载渐进式跳转（JumpToken 可取消）
│   │   ├── messageScanner.ts       # 核心扫描引擎，MutationObserver + IntersectionObserver + AI turn 锚点注册
│   │   ├── orderList.ts            # 有序 ID 分段合并算法（contiguous/detached 段合并 + 方向推断）
│   │   ├── runtimeStore.ts         # 内存响应式状态，subscribe/emit 驱动 UI
│   │   ├── scrollDriver.ts         # 滚动基础设施：多源 root 检测 + 评分验证 + 操作结果 + viewport + 方向捕获 + 诊断
│   │   └── urlWatcher.ts           # SPA 路由监听，history patch + popstate + 轮询
│   ├── popup/
│   │   ├── PopupApp.tsx            # Popup 主组件：存储用量仪表、对话列表、缓存操作按钮、滚屏速率设置（default/fast/turbo）
│   │   └── popup.css               # Popup 样式，复用侧栏 CSS 变量体系
│   ├── shared/
│   │   ├── hash.ts                 # SHA-256 文本指纹（前 8 字节）
│   │   ├── scrollProfile.ts        # ScrollProfile 类型、default/fast/turbo 三档预置速率参数
│   │   ├── text.ts                 # 文本归一化、截断预览、搜索分词高亮
│   │   └── types.ts                # 全局类型定义（CachedMessage, RuntimeState 等）
│   └── ui/
│       ├── MessageItem.tsx          # 单条消息列表项；user: 搜索高亮+hover+跳转；AI: 树状SVG+引用块（isAssistant prop）
│       ├── JumpToast.tsx            # 跳转进度和失败状态 Toast，底部固定显示
│       ├── MiniBar.tsx              # Mini 模式导航条，滑动窗口（MAX_VISIBLE=10）user 横条 + AI 缩细条，▲/▼ 仅移动 Q
│       ├── SearchBox.tsx            # 搜索输入框（300ms 防抖）
│       ├── ShadowRootApp.tsx        # Shadow DOM 挂载入口
│       ├── Sidebar.tsx              # 主组件，三态切换（展开/Mini/折叠），Q/A 编号消息列表 + 搜索 + 可调宽度
│       ├── useResize.ts             # 拖拽调宽 hook，mousedown/mousemove/mouseup + chrome.storage 持久化
│       └── styles.css               # Shadow DOM 内样式，CSS 变量支持暗色/亮色，拖拽手柄样式
├── docs/
│   ├── Tree.md                      # 本文件
│   ├── 项目脚手架及二阶段计划.md       # 完整功能规格与分阶段计划
│   └── superpowers/
│       ├── plans/                   # Superpowers plan 文件
│       └── specs/                   # Superpowers spec 文件
├── public/
│   └── icon.png                     # 扩展图标（16/32/48/128 复用）
├── scripts/
│   ├── bump.mjs                     # 版本管理：patch/minor/major/精确版本，同步更新 package.json + wxt.config.ts
│   ├── copy-build.mjs               # 构建后拷贝产物到 %TEMP% 统一加载路径
│   ├── dev-edge-isolated.mjs        # Isolated Edge dev 脚本，profile 位于 .wxt/edge-data
│   ├── order-list-regression.test.mjs  # orderList 分段合并回归测试（node:test）
│   └── release.mjs                  # 发布流程：pull → push → build → zip，输出产物路径供 gh release 使用
├── .github/
│   └── workflows/
│       ├── pr-agent.yml             # PR Agent 自动增量审查（DeepSeek V4 Flash）
│       └── coderabbit-retry.yml     # CodeRabbit 审查失败自动重试
├── .coderabbit.yaml                 # CodeRabbit 配置
├── .pr_agent.toml                   # PR Agent 配置
├── .gitignore
├── CLAUDE.md                        # Claude Code 项目指引
├── CHANGELOG.md                     # 版本变更记录（Keep a Changelog 格式）
├── README.md                        # 用户文档：安装、构建、加载、隐私说明
├── package.json
├── pnpm-workspace.yaml              # pnpm workspace 配置
├── tsconfig.json                    # 继承 .wxt/tsconfig.json，strict + Preact JSX
├── web-ext.config.ts                # WXT dev 浏览器启动配置：持久化 Edge profile
└── wxt.config.ts                    # WXT 配置：manifest、权限、图标
```

> 构建产物输出到 `.output/` 目录（`chrome-mv3` 生产构建，`chrome-mv3-dev` 开发构建），WXT 运行时生成到 `.wxt/`，两者均已 gitignore。
