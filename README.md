# ChatGPT Question Navigator

本项目是一个本地优先、隐私友好的 Chrome/Edge Manifest V3 扩展，用于在 ChatGPT 长对话页面右侧显示用户问题导航侧栏。

## 已实现范围

- 仅在 `https://chatgpt.com/*` 和 `https://chat.openai.com/*` 启用。
- 使用 WXT content script 和 Shadow DOM 注入右侧侧栏。
- 扫描当前 DOM 中 `data-message-author-role="user"` 的用户消息。
- 将已见过的用户消息缓存到 `chrome.storage.local`。
- SPA URL 切换时加载对应会话缓存。
- 侧栏展示 Q1、Q2 等问题摘要、mounted/cached 状态和 indexed 数量。
- 当前阅读附近的用户消息在侧栏高亮。
- 点击当前 DOM 中存在的问题可平滑跳转并临时高亮目标。
- 支持搜索已缓存问题和 hover 查看完整预览。
- 点击 cached-only 消息可渐进式跳转（scrollRatio 粗定位 + messages index 自适应步进）。
- 跳转过程中用户滚动、按 Esc 或点击新目标可取消跳转。
- 跳转进度和失败状态在侧栏底部 Toast 显示。

## 安装依赖

```bash
pnpm install
```

如果没有 pnpm：

```bash
npm install
```

## 开发运行

```bash
pnpm dev
```

或：

```bash
npm run dev
```

## 类型检查

```bash
pnpm compile
```

## 构建扩展

```bash
pnpm build
```

构建完成后，产物会自动拷贝到 `%TEMP%\Chatgpt-Question-Navigator`（即系统临时目录下的 `Chatgpt-Question-Navigator` 文件夹）。原始构建产物仍保留在 `.output/chrome-mv3`。

> **为什么拷贝到临时目录？** 当使用 git worktree 在多个分支间并行开发时，每个工作树有独立的 `.output` 目录。浏览器只需固定加载临时目录中的副本，切换工作树后重新 `pnpm build` 即可更新，无需反复修改扩展加载路径。

## Chrome 加载方式

1. 打开 `chrome://extensions/`。
2. 开启右上角「开发者模式」。
3. 点击「加载已解压的扩展程序」。
4. 选择 `%TEMP%\Chatgpt-Question-Navigator`（即系统临时目录下的 `Chatgpt-Question-Navigator` 文件夹）。
5. 打开 ChatGPT 页面验证右侧导航侧栏。

## Edge 加载方式

1. 打开 `edge://extensions/`。
2. 开启左侧「开发人员模式」。
3. 点击「加载解压缩的扩展」。
4. 选择 `%TEMP%\Chatgpt-Question-Navigator`（即系统临时目录下的 `Chatgpt-Question-Navigator` 文件夹）。
5. 打开 ChatGPT 页面验证右侧导航侧栏。

## 隐私说明

扩展不调用 ChatGPT 内部 API，不 monkey patch fetch/XHR，不请求 `<all_urls>` 权限，不添加 analytics，也不会把聊天内容上传到任何服务器。已采集的问题摘要和搜索文本只保存在浏览器本地的 `chrome.storage.local`。

## 已知限制

- 扩展无法读取从未在 DOM 中出现过的历史消息。
- 第一次打开超长对话时，远处问题需要用户滚动经过后才会被缓存。
- ChatGPT 页面结构变化可能导致 DOM 识别失效。
- 渐进式跳转依赖 scroll metadata，不能保证 100% 精确定位。

## 后续路线

- 验证并启用 experimental DOM 后备选择器。
- 导出/导入缓存。
- 自定义快捷键。
