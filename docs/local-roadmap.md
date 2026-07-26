# SageRead 本地定制路线图

> 本文档记录我们（fork 方）的定制计划，**不提交给上游**。最后更新：2026-07-27。

> **2026-07-27 战略变更：fork 即主线。** 上游三个 PR（#44/#45/#46）一个月零响应，不再冀望合并；只维护自己的仓库 [Feplus2/sageread](https://github.com/Feplus2/sageread)。`local` 分支历史已重写为 noreply 邮箱（原哈希失效，备份在 `backup/local-before-email-rewrite`），已推送为 fork 的 `main` 并设上游跟踪；仓库级 `user.email` 已配为 noreply。PR 保持敞开，作者回来随时可合。日常流程简化为：在 `local` 上开发 → push 即发布。

## 进度快照（2026-07-24）

- **2026-07-27 补记**：50 小时空窗期由其他 agent 推进的工作已全部落袋——拆成 5 个 commit：网络搜索（可用性待验证）、批量/智能标签+会话多选、预览面板、笔记 HTML 菜单、Books_Converter sidecar 半成品。tsc + cargo check 通过。**仍欠：L2（含 2b 书籍通道）真机复验、网络搜索非敏感查询验证、预览面板手动验收（用户已验，通过）。**

- **2026-07-27 验证发现（重要）**：双实例环境搭成（主目录 .dev:1420 + worktree .dev2:1421，手册见 `docs/sync-testing-guide.md`）。**首个实测结论：元数据"首次全量引导"未实现**——本快照 07-24 条目里"2c 打磨（…首次全量引导…）"系误报，实际只做了书籍文件的批量上传；触发器建立前的存量书永远进不了 changeset，全新设备增量同步收不到存量（云端修剪会让缺口静默永久化）。当前绕过：新设备先 L1 恢复再开 L2。**待办：实现存量回填引导（见下）**

**已完成**：P0 对话管理、P1 导出+主题、P2 路线 A（MCP）、对话星标、回收站、L1 备份、L2 2a 元数据同步（含审计修复，cargo 21/21）、支线"刷新按钮增强"。PR #44/#45/#46 已开往上游。

**本次新增完成（2026-07-24）**：
- **第一批快赢**：回收站警告文案、多选按钮布局修复、失败通知颜色随主题（Sonner 对接 useThemeStore + 补齐 --destructive-foreground + 接管 --gray* 色阶）、新建标签勾选不入标签 BUG（根因：误把标签名当标签 ID 写入 book.tags）
- **第二批 2b 书籍通道**：files.rs（sha256 内容寻址上传/懒下载/files-index.json）、书架云端角标+点开自动下载、新书入库自动上传、设置页“上传全部”；l2-safety 快照回滚入口（列表+一键回滚）；2c 打磨（空闲调度 10s、首次全量引导、自动同步完全静默）
- **资产通道**：assets.rs（字体/背景图内容寻址双向同步）、背景选择状态+辅助模型选择同步（ui-config.json 整文件 LWW，值对比检测变更）；安全红线：API 密钥永不同步
- **第三批·支线中项**：会话列表多选管理（多选删除/星标/逐个导出 MD）、全部原生菜单换 HTML 主题菜单（7 处）、AI 对话网络搜索（Bing+百度+DDG 三引擎轮询 + 输入框旁引擎选择器，**搜索可用性待验证**）、批量与智能标签（书架多选 + 批量打/移标签 + AI 批量分类；复选框事件冒泡 BUG 已修）
- **L3 端到端加密**：经用户确认跳过（同步的均为阅读元数据，无加密必要）

**本次新增完成（2026-07-26）**：
- **标签栏纵横切换**：仿 Edge 垂直标签页（左侧栏展开 220px/折叠 48px、窄顶条 32px 承载拖拽区域+窗口控件、偏好持久化）；横向标签体验优化（滚轮平滑滚动、激活标签自动滚入视野、溢出左右箭头按钮、中键关闭标签、拖拽排序持久化、静止裁剪视口杜绝标签与顶部按钮重叠/误触）

**后续执行顺序**（按批，估算为 AI 结对工作日）：

1. **第三批·支线中项（已完成）**：会话列表多选管理、对话右键菜单换 HTML、AI 对话网络搜索（Bing+百度+DDG）、批量与智能标签（一书多标签已支持，无需 schema 变更）
2. **第四批·大件（各 2-3 天）**：Books_Converter 整合（PDF→EPUB→入库，复用辅助模型）、~~标签栏纵横切换~~（已完成）、APP 帮助助手、**全局 Agent 动作工具**（向量化/整理划线/整理标签/备份/同步，见《Agent 架构设想》）
3. **等作者**：PR 4（L1 备份）未建分支；PR 5（L2 同步）须 PR 1/3/4 合并后 rebase 再提；作者 3 个月无响应则 fork 转活跃维护版（README 顶部声明 + 发 release + 考虑改名）
4. **远期不承诺**：P2 路线 B（内嵌 MCP over HTTP）、移动端

## 已知问题 / 待观察

### 网络搜索失败（未定论，暂不修）
- **现象**：应用内网络搜索失败。用户以《墓碑》（杨继绳）作者晚年经历测试，搜索报错。
- **初步调查**：
  - 必应中国对敏感查询会审查（实测返回“为回应符合本地法律要求的通知，部分搜索结果未予显示”）；
  - 百度对自动化请求触发反爬验证页（“百度安全验证”）；
  - DuckDuckGo 国内被墙，需代理（已有 7897/7890/10809/1080 代理 fallback）。
- **未定论点**：用户观察到必应与 DuckDuckGo **同时失败**，若是纯内容审查，DuckDuckGo（免审查）在配了代理时理应可用——故不排除工具解析/网络层也有问题。用于测试的网页抓取工具返回的是错乱无关结果，无法直接看到搜索引擎真实返回页面，未能直接验证。
- **已做的诊断增强**（web_search.rs）：识别百度反爬验证页并跳过、每引擎尝试情况写日志（`[网络搜索] 引擎 xxx ...`）、最终错误提示敏感内容可切 DuckDuckGo+代理。
- **下一步验证方法**：用**非敏感查询**（如“鲁迅生平简介”“光合作用原理”）测试。若普通查询也失败→是工具解析/网络问题，需修；若仅敏感查询失败→是审查限制，解法是切 DuckDuckGo 并配代理。

### 轻量 AI 任务偏慢（待优化）
- **现象**：AI 重命名、AI 自动分类等简单任务慢。
- **原因**：这些任务走辅助模型（getUtilityModel，未配置时回落聊天模型）；若辅助/聊天模型是推理（thinking）模型，简单任务也会先思考。
- **建议解法**：把**辅助模型**设为快速非推理模型（如 deepseek-chat / gpt-4o-mini）——这正是辅助模型设计的用途。可选增强：为轻量任务的 generateText 调用加 provider 级“禁用思考”选项（各 provider 支持不一，非通用）。

### 同步遇 503 无退避（2026-07-27 实测发现）

- **现象**：双实例高频同步（25-30s/轮 × 2 + 大量上传下载）数小时后，坚果云对账号限流，全部请求 503，含 L1 测试连接；恢复靠服务端自然解封（数十分钟到数小时）。
- **现状**：引擎按原频率继续撞（日志一片 WARN）。
- **待做**：同步请求遇 503/429 指数退避（1m→5m→30m），恢复后回正常频率。

## Agent 架构设想：用自然语言复刻 GUI

**核心愿景**：一个 Agent，让用户把“所有能在 GUI 里完成的功能”仅通过自然语言同样能实现。

**现状架构**（见 `ai/custom-chat-transport.ts`）：基于 Vercel AI SDK 的**单 Agent 工具调用循环**（`streamText` + `toolChoice: "auto"` + `stopWhen: stepCountIs(20)`，ReAct 式）。不是 Claude Code / crewAI，是 AI SDK 内置的单 Agent 代理循环，模型在前端 WebView 直接发起。

**两个 Agent 上下文（同一套引擎，不同工具集）**：

| | 阅读助手 Agent | 全局 Agent |
|---|---|---|
| 入口 | 书内侧边栏对话（绑定 book_id） | 主页“聊天”（book_id=undefined） |
| 范围 | 当前这本书 | 整个书库 / 全局 |
| 工具 | 只读查询 + 本书 RAG（ragSearch/ragToc/ragContext）+ mindmap/webSearch | 只读查询（getBooks/getReadingStats/notes/getSkills）+ mindmap/webSearch，**＋全局动作工具** |

**关键设计原则：动作工具只赋予全局 Agent。**
- 整理标签、批量向量化、备份、同步、导入导出等**全局性动作工具**，只挂给全局 Agent。
- **不**把这些动作工具塞进阅读助手 Agent——避免工具过多导致模型选择混乱、误触发，保持阅读助手“专注本书问答”的精简工具集。
- 阅读助手保持只读 + 本书 RAG；全局 Agent 才是“干活”的入口。

**落地路径（渐进，不换架构）**：现有工具循环天然支持多步任务，只需把现有 GUI 功能封装成**动作工具**挂给全局 Agent：
- “帮我把这批书全部向量化” → `vectorizeBooks(bookIds)`（包装 `indexEpub`）
- “把某本书的划线整理成一个 Markdown” → `exportHighlightsToMarkdown(bookId)`（包装笔记查询 + MD 生成）
- “整理标签”（批量打/移/AI 归类）→ 包装现有批量标签逻辑
- “立即备份 / 立即同步” → 包装 L1 备份 / L2 同步命令
- 可能需要：调高 20 步上限、为长任务加规划能力。

**远期**：“完全了解软件所有文档和代码细节的专属助手”需对 docs/代码库做 RAG 索引（更大工程，路径清晰）。

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
- **标签栏拥挤与纵横切换**（2026-07-22，✅ 已完成 2026-07-26）：仿 Edge 垂直标签页（左侧栏展开 220px/折叠 48px、窄顶条 32px 承载拖拽区域+窗口控件、偏好持久化）＋横向优化（滚轮平滑滚动、激活标签自动滚入视野、溢出左右箭头按钮、中键关闭、拖拽排序持久化、静止裁剪视口 .chrome-tabs-viewport 杜绝标签与顶部按钮重叠/误触，固定按钮区 z-index 恒在上层）
- **BUG：新建标签勾选书籍未真正入标签**（2026-07-21 报）：创建标签时勾选的书从"未分类"消失了，但没出现在新标签里，要从"全部"里手动拖。需排查 books.tags 关联写入逻辑
- **功能：批量与智能标签管理**（2026-07-21）：① 多选书目批量打/移标签；② AI 自动批量归类——优先归入现有标签，无匹配时询问并新建；**支持一书多标签**
- **UI：对话右键菜单换自定义 HTML 菜单**（2026-07-21）：现在用的是 Tauri 原生菜单（`Menu.new`），无法跟随全局主题；换 HTML 右键菜单后可套羊皮纸等主题
- **小修：回收站彻底删除的警告文案**（2026-07-21）：删除已可撤销（进回收站），去掉"此操作无法撤销"字样，改为普通确认
- **预览面板**（2026-07-22）：AI 产物（解读报告、思维导图 HTML、分析长文）需要"写得出 + 看得见"——侧边栏拉一个预览窗口直接阅览 HTML/MD 文件，别让用户去系统文件管理器里找。书与文献通用，高频功能
- **一句话 Zotero 导入**（2026-07-22，详见 `paper-reading-feasibility.md` 阶段 3 补充）：对话面板挂 zotero-brain MCP，文献连同 Zotero 分类文件夹导入，collection 层级映射为 SageRead 标签/分组

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

### 分批方案（2026-07-22 定稿，local 领先 main 的 24 个提交的归属）

**原则：冲突只发生在"跳过的提交碰过同一文件"。按 1→5 顺序提，每次 cherry-pick 的基底最多差一个已合并的 PR，冲突已知且有界。**

| 批次 | 提交 | 依赖 | 状态 |
|---|---|---|---|
| **PR 1 对话功能包 = [#44](https://github.com/xincmm/sageread/pull/44)** | 54ca32c 导出MD、cd6b9de AI命名、b8c1348 列表菜单、616154a fix、6d917b2 辅助模型、d476825 fix、569e056 图片/HTML/多选导出、3b592f3 星标、9baea95 fix 排序 | 仅上游 main | ✅ 已开 PR（分支 `feat/chat-thread-features`）；569e056 与主题批的冲突已解（剥掉 3 行 data-region，归 PR 2 再加） |
| **PR 2 全局主题包 = [#45](https://github.com/xincmm/sageread/pull/45)** | e2f090b 主题引擎+钩子、2ef551a 羊皮纸、47b590c 阅读区主题面板 | 仅上游 main；与 PR 1 在 side-chat 两文件有 3 行 data-region 交叠，后到者 rebase 时补回即可 | ✅ 已开 PR（cherry-pick 零冲突，tsc 通过） |
| **PR 3 书籍回收站 = [#46](https://github.com/xincmm/sageread/pull/46)** | a64a37f | 仅上游 main；与 PR 1 各引入 `run_migrations`（各加一段 ALTER），后到者 rebase 保留两段即可 | ✅ 已开 PR（冲突已解：剪成只含 trashed_at 迁移 + 补调用点；cargo check + tsc 通过） |
| **PR 4 WebDAV 备份/恢复（L1）** | 0889e71（设计文档 a55932b 可带上） | 仅上游 main | 未建分支 |
| **PR 5 L2 增量同步** | ef08132、9d33b05、8249186 审计修复、文档 f7113b5+0305b02 | **依赖 PR 1（starred 列）+ PR 3（trashed_at）+ PR 4（L1 复用）**，必须等它们合并后 rebase 再提；且真机双设备复验还没做（额度恢复后第一件事） | 暂不提 |

**永不提 PR**（留在 local）：f193c54 chore 本地配置、235d446/7cafa5e/5cc2027 docs 本地路线图。

**流程备忘**（无 gh CLI，全网页操作）：GitHub 网页 fork xincmm/sageread → `git remote add origin <fork地址>` → `git push -u origin feat/chat-thread-features` → 网页点 "Compare & pull request"（base: xincmm/sageread 的 main）。**不要 push `local`**（含本地专属提交）。

> 2026-07-22 实录：PR 1 已提（xincmm/sageread#44，fork = Feplus2/sageread，fork/push/开 PR 均由 API 完成）。**坑：GitHub 邮箱隐私保护会拒绝推送**——解法是把 feat 分支提交邮箱重写为 noreply 后再推：`git checkout feat/xxx && git -c user.name="Feplus2" -c user.email="202785243+Feplus2@users.noreply.github.com" rebase main --exec "git commit --amend --no-edit --reset-author"`。后续每个 PR 分支都要做这一步（或去 GitHub Settings → Emails 关掉 Block 选项）。

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
