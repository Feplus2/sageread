# SageRead 本地定制路线图

> 本文档记录我们（fork 方）的定制计划，**不提交给上游**。最后更新：2026-07-21。

## 背景

- 上游：[xincmm/sageread](https://github.com/xincmm/sageread)，AGPL-3.0，Tauri 2 + React/TS，pnpm monorepo
- 目标：按个人需求改造 SageRead，通用功能逐步以 PR 回馈上游
- 借鉴对象：[CherryHQ/cherry-studio](https://github.com/CherryHQ/cherry-studio)（同为 AGPL-3.0，代码可合法借用，需保留出处声明）；注意其技术栈（Electron + Redux）与本项目（Tauri + zustand）不同，只借鉴设计与实现思路，不整片搬运 UI

## 本地改动清单（不进 PR）

| 改动 | 文件 | 原因 |
|---|---|---|
| identifier 改为 `com.xincmm.sageread.dev` | `packages/app/src-tauri/tauri.conf.json` | 开发版与发行版数据隔离 |
| allowBuilds 三项设为 true | `pnpm-workspace.yaml` | pnpm 11 构建脚本审批 |

## 数据隔离

- 发行版数据：`%APPDATA%\com.xincmm.sageread\`
- 开发版数据：`%APPDATA%\com.xincmm.sageread.dev\`（已从发行版拷贝一份作示例数据）
- 两边可同时运行，互不干扰

## 需求与可行性

### P0 —— 对话管理（最先做）

| 功能 | 方案 | 成本 |
|---|---|---|
| 对话重命名 | 后端零改动（`edit_thread` 已支持只改 title）；前端 `chat-threads.tsx` 右键菜单加项 + 弹窗 | 小 |
| AI 自动命名 | 仿 `ai-context-service.ts` 的轻量调用，首轮对话结束后异步生成标题回写；prompt 可借鉴 CherryStudio | 小 |
| 导出 Markdown | 纯前端遍历 `UIMessage[]` 拼 MD（quote 渲染为 blockquote + 书名），`plugin-dialog` 保存 + `plugin-fs` 落盘 | 小 |

### P1 —— 导出增强 + 主题系统

- 导出 HTML（MD 渲染为内联样式独立 HTML）、导出图片（html-to-image 类库截聊天 DOM；注意 WebView2 外部资源跨域坑）、单条消息导出
- 书籍区"羊皮纸"等新主题：palette + 纹理背景注入（现有 `getThemeCode`/`setStyles` 机制，成本小）
- 应用 UI 自定义 CSS：设置页入口 + 启动注入
- **主题开发者友好设计**（解决 CherryStudio"留口子但不给 DOM 地图"的痛点）：关键区域加稳定 `data-region` 语义钩子，编写 `THEMING.md` 文档化钩子与 CSS 变量；主题包 = manifest.json + CSS，社区可 PR 贡献

### P2 —— MCP 钩子（独立项目 sageread-mcp）

- **路线 A（先做）**：独立 MCP server（Node 或 Python），只读打开 SageRead SQLite，暴露 tools：`list_books` / `get_progress` / `get_reading_stats` / `list_highlights` / `get_thread` / `export_thread_markdown` 等。任何 AI Agent 配上即可跨应用访问阅读数据；联动 ima 侧 MCP（ima 已打通）实现"把对话搬进 ima 知识库"等灵活操作
- **路线 B（成熟后提 PR）**：Tauri 后端内嵌 MCP over HTTP（`rmcp` crate），实时数据、免 DB 锁顾虑，作为给上游的重磅功能 PR

### P3 —— 数据同步（WebDAV / 坚果云）

- 采用 CherryStudio 同款**备份/恢复**模型（打包上传、换机恢复），第一版不做实时双向同步
- 注意 SQLite 热拷贝风险：备份前 checkpoint

### P4 —— 远景（不承诺）

- 内置 MCP server 上游 PR、移动/平板客户端（Tauri 2 移动端需大量适配，数月级）、双向同步
- 生态位判断：Windows 开源 + 可自接 API + AI 深度集成的阅读器目前只有 SageRead，方向成立；移动端另当别论

## PR 策略（防止"改动太大不好提"）

核心原则：**main 永远只跟踪上游，我们的功能全部开在独立分支，一个功能一个 PR**。

```
upstream/main (只读同步上游)
main (本地，= upstream/main，不放自己的改动)
feat/xxx  (每个功能一个分支，从 main 开出，PR 就用它)
local     (个人整合分支：合并所有 feat + 本地改动，自己日常用)
```

1. **一个功能一个分支一个 PR**：重命名是一个 PR，自动命名是一个 PR，导出是一个 PR。每个 PR  diff 小、聚焦，上游好审好合
2. **日常自己用的是 `local` 整合分支**：把所有 feat 分支和两处本地改动合进去，不影响各 feat 分支保持干净
3. **大功能拆小**：主题系统这种大块头，拆成"自定义 CSS 注入 → data-region 钩子 + THEMING.md → 主题包加载"几个独立 PR 依次提（后面的 PR 依赖前面的就 stacked 排列，等前面的合了再 rebase）
4. **定期同步上游**：`git fetch upstream && git rebase upstream/main`（feat 分支）/ merge（local 分支），冲突尽早暴露
5. **上游不收的**：留在 local 分支自用即可，没有损失
6. 提 PR 前检查：不带入"本地改动清单"里的任何一行

## 开发环境速查

```bash
# 安装依赖（首次）
pnpm install

# 日常开发（在仓库根目录）
pnpm dev          # = cd packages/app && pnpm tauri dev
```

- 前端代码（`packages/app/src`）保存即热更新；Rust 代码（`src-tauri`）改动自动重编译重启
- 停止：终端 Ctrl+C；再启动增量编译只需数秒
- 注意：本机访问 github.com 需走代理，git 操作已配置仓库级代理 `127.0.0.1:7897`
