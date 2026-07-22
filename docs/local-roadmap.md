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
| 辅助模型设置 | 设置→模型提供商页顶部"辅助模型"卡片；`getUtilityModel()`（`ai/providers/factory.ts`，预留 `task` 参数）统一解析，回落聊天模型；标题/语义上下文/AI标签三处已切换 | 小 ✅ |

> 修复备忘（2026-07-21）：① 标题生成 `maxOutputTokens` 30→500（deepseek-v4-pro 等推理模型的 reasoning 会吃光小预算导致输出为空）；② `use-chat-state.ts` 的 `onFinish`/`generateSemanticContextAsync` 误读全局 `useThreadStore`，而侧边栏对话存 `useReaderStore`，导致回答被存进新建对话（对话分裂）——已改为 `currentThreadRef`。**②是上游 main 的既有 bug，是首个上游 PR 的好素材。**

### P1 —— 导出增强 + 主题系统

- 导出 HTML（MD 渲染为内联样式独立 HTML）、导出图片（html-to-image 类库截聊天 DOM；注意 WebView2 外部资源跨域坑）、单条消息导出
- 书籍区"羊皮纸"等新主题：palette + 纹理背景注入（现有 `getThemeCode`/`setStyles` 机制，成本小）
- 应用 UI 自定义 CSS：设置页入口 + 启动注入
- **主题开发者友好设计**（解决 CherryStudio"留口子但不给 DOM 地图"的痛点）：关键区域加稳定 `data-region` 语义钩子，编写 `THEMING.md` 文档化钩子与 CSS 变量；主题包 = manifest.json + CSS，社区可 PR 贡献

### P2 —— MCP 钩子（独立项目 sageread-mcp）✅ 路线 A 已完成

- **路线 A（已完成 2026-07-21）**：`F:/MyProjects/sageread-mcp`（TypeScript + 官方 SDK，stdio，better-sqlite3 只读）。tools：list_books / get_book_progress / get_reading_stats / list_threads（支持 starred_only）/ get_thread / list_book_notes / export_thread_markdown。已配入 Kimi CLI（`~/.kimi-code/mcp.json`）
- **对话星标 ✅**：threads.starred 列（fork 迁移通道 `database.rs run_migrations`），列表星标按钮+置顶；MCP 可按星标过滤——ima 导出工作流的数据基础
- **路线 B（成熟后提 PR）**：Tauri 后端内嵌 MCP over HTTP（`rmcp` crate），实时数据、免 DB 锁顾虑，作为给上游的重磅功能 PR
- **候选：APP 帮助助手**——把 `docs/` 等文档喂给内置问答（书籍 RAG 基础设施可复用；模型走辅助模型）
- **待办：ima 侧 MCP 配置**（社区 tencent-ima-copilot-mcp 或官方 API），配好后"导出星标对话到 ima"一句话即可触发

### P3 —— 数据同步（WebDAV / 坚果云）【设计已定 2026-07-21】

决策：**L1 先行、元数据为主**（书籍文件默认不同步，照顾坚果云免费档流量）。

- **L1 一致性备份/恢复（当前任务）**：`VACUUM INTO` 在线快照 → zip（db 快照 + JSON 配置[排除 model-provider.json] + themes + manifest.json）→ WebDAV 上传；sha256 去重（无变化不传）；保留最近 10 份轮转；恢复前自动本地备份（可回滚）；恢复走"重启生效"流程（pending-restore 标记，启动时先换文件再开库）；WebDAV 走 Rust reqwest（绕 WebView2 CORS）；密码存本地独立文件，不进备份包
- **L2 记录级增量同步（下一步）**：不传整个库，传变更——changeset（JSONL，带设备 id）+ 按行 `updated_at` LWW + 进度取 `last_read_at` 大者 + 删除墓碑 + reading_sessions 只增无冲突；书籍走 sha256 内容寻址，全网只传一次。**协议格式第一天就按"未来手机端也说这门语言"设计**
- **L3 端到端加密（可选）**：上传前 AES-GCM，密钥不落地
- 背景：CherryStudio 是备份/恢复模型（[文档](https://docs.cherry-ai.com/pre-basic/data-settings/webdav)），其弱点（无变化也全量备份、多设备覆盖、无合并，见其 issue #8872/#1752）即 L1/L2 要修掉的点

### P4 —— 远景（不承诺）

- 内置 MCP server 上游 PR、移动/平板客户端（Tauri 2 移动端需大量适配，数月级）、双向同步
- 生态位判断：Windows 开源 + 可自接 API + AI 深度集成的阅读器目前只有 SageRead，方向成立；移动端另当别论

## 支线清单（与主线无关，陆续完善）

- **刷新按钮增强**（2026-07-22）：对话面板的刷新按钮除拉取对话/星标外，应同时把当前书的进度对齐到云端/本地最新的真进度并跳转到对应位置
- **AI 对话引入网络搜索**（2026-07-22）：现状是"带 ragSearch 工具的 tool-calling 对话"（自定义 transport + AI SDK，不是完整 Agent 框架），新增 webSearch 工具可同构接入。优先免 API key 方案（用户不想配多个 key）：DuckDuckGo/Bing HTML 抓取（免 key 但脆）、SearXNG 自托管、或选用 provider 自带搜索（如 Gemini grounding）
- **整合 Books_Converter**（2026-07-22）：把 `F:\MyProjects\Books_Converter` 整合进 SageRead——PDF 转 EPUB 再导入书库的全流程；转换要用的 LLM **直接复用辅助模型**，正好闭环
- **BUG：side-chat 头部多选按钮被同步刷新按钮顶掉**（2026-07-22）：加 L2 刷新按钮后，原来的多选（ListChecks）按钮不见了，检查头部布局拥挤问题
- **通知体系优化**（2026-07-22）：备份/定时备份等后台小动作走现有"通知"小工具静默通知，别弹 toast；增量同步（高频）完全不发通知。**另：失败通知的字体颜色与主题不匹配，一并修**
- **会话列表的多选管理**（2026-07-22）：对话列表页加多选（区别于聊天页内的多选导出）：多选删除、多选星标/取消星标、多选导出
- **标签栏拥挤与纵横切换**（2026-07-22）：开书多时顶部标签挤、难滑动、遮挡主页/窗口按钮——优化选中与滑动逻辑不占别的按钮位置；仿 Edge 垂直标签页，做横向/纵向标签栏切换
- **BUG：新建标签勾选书籍未真正入标签**（2026-07-21 报）：创建标签时勾选的书从"未分类"消失了，但没出现在新标签里，要从"全部"里手动拖。需排查 books.tags 关联写入逻辑
- **功能：批量与智能标签管理**（2026-07-21）：① 多选书目批量打/移标签；② AI 自动批量归类——优先归入现有标签，无匹配时询问并新建；**支持一书多标签**
- **UI：对话右键菜单换自定义 HTML 菜单**（2026-07-21）：现在用的是 Tauri 原生菜单（`Menu.new`），无法跟随全局主题；换 HTML 右键菜单后可套羊皮纸等主题
- **小修：回收站彻底删除的警告文案**（2026-07-21）：删除已可撤销（进回收站），去掉"此操作无法撤销"字样，改为普通确认

## PR 策略（防止"改动太大不好提"）

核心原则：**main 永远只跟踪上游，我们的功能全部开在独立分支，一个功能一个 PR**。

```
upstream/main (只读同步上游)
main (本地，= upstream/main，不放自己的改动)
local     (当前分支：本地改动 + 所有功能提交，日常用)
feat/xxx  (PR 时才创建：从 main 开出，cherry-pick local 上的对应提交)
```

1. **提交按功能拆分，分支到 PR 时再建**：日常开发都在 `local` 上，提交（commit）按功能粒度记录；要提 PR 时，从 main 开 `feat/xxx` 分支，`git cherry-pick` 挑出该功能的提交，推到自己的 fork 发 PR。每个 PR diff 小、聚焦，上游好审好合
2. **日常自己用的是 `local` 分支**：包含所有功能提交和本地改动，开发版就在这里跑
3. **大功能拆小**：主题系统这种大块头，拆成"自定义 CSS 注入 → data-region 钩子 + THEMING.md → 主题包加载"几个独立 PR 依次提（后面的 PR 依赖前面的就 stacked 排列，等前面的合了再 rebase）
4. **定期同步上游**：`git fetch upstream`，local 用 merge 或 rebase 跟上，冲突尽早暴露
5. **上游不收的**：留在 local 分支自用即可，没有损失
6. 提 PR 前检查：不带入"本地改动清单"里的任何一行（chore/docs 提交永远留在 local）

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
