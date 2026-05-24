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
│   │   ├── cacheStore.ts           # chrome.storage.local 持久化，按会话缓存消息，LRU 清理
│   │   ├── domAdapter.ts           # ChatGPT DOM 交互抽象层，选择器集中定义
│   │   ├── jumpController.ts       # 跳转控制：已挂载消息直接跳转 + 临时高亮
│   │   ├── messageScanner.ts       # 核心扫描引擎，MutationObserver + IntersectionObserver
│   │   ├── runtimeStore.ts         # 内存响应式状态，subscribe/emit 驱动 UI
│   │   ├── scrollDriver.ts         # 滚动容器抽象，区分用户滚动与程序滚动
│   │   └── urlWatcher.ts           # SPA 路由监听，history patch + popstate + 轮询
│   ├── popup/
│   │   ├── PopupApp.tsx            # Popup 主组件：存储用量仪表、对话列表、缓存操作按钮
│   │   └── popup.css               # Popup 样式，复用侧栏 CSS 变量体系
│   ├── shared/
│   │   ├── hash.ts                 # SHA-256 文本指纹（前 8 字节）
│   │   ├── text.ts                 # 文本归一化、截断预览、搜索分词高亮
│   │   └── types.ts                # 全局类型定义（CachedUserMessage, RuntimeState 等）
│   └── ui/
│       ├── MessageItem.tsx          # 单条消息列表项，搜索高亮 + hover 预览
│       ├── SearchBox.tsx            # 搜索输入框（300ms 防抖）
│       ├── ShadowRootApp.tsx        # Shadow DOM 挂载入口
│       ├── Sidebar.tsx              # 主侧栏组件，状态订阅 + 搜索 + 折叠
│       └── styles.css               # Shadow DOM 内样式，CSS 变量支持暗色/亮色
├── docs/
│   ├── Tree.md                      # 本文件
│   ├── 项目脚手架及二阶段计划.md       # 完整功能规格与分阶段计划
│   └── superpowers/
│       ├── plans/                   # Superpowers plan 文件
│       └── specs/                   # Superpowers spec 文件
├── public/
│   └── icon.png                     # 扩展图标（16/32/48/128 复用）
├── .gitignore
├── CLAUDE.md                        # Claude Code 项目指引
├── README.md                        # 用户文档：安装、构建、加载、隐私说明
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.json                    # 继承 .wxt/tsconfig.json，strict + Preact JSX
└── wxt.config.ts                    # WXT 配置：manifest、权限、图标
```

> 构建产物输出到 `.output/` 目录（`chrome-mv3` 生产构建，`chrome-mv3-dev` 开发构建），WXT 运行时生成到 `.wxt/`，两者均已 gitignore。
