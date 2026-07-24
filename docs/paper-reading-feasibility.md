# 论文阅读与多格式支持 · 可行性调研（2026-07-22）

> 额度恢复期前的调研存档。结论：**两个点子都可行，且共用同一条关键路径；建议分阶段做，重活全部留在 SageRead 本体之外，不臃肿。**

## 结论速览

| 点子 | 可行性 | 关键事实 | 估算（结对工作日） |
|---|---|---|---|
| 多格式（MOBI/AZW3/FB2/CBZ） | ★★★★★ 几乎是解锁而非开发 | foliate-js 原生支持，SageRead 只是写死了 EPUB | ~1 天 |
| 论文阅读（重排 + RAG 问答） | ★★★★ 缺的一环 zotero-brain 正好有 | RAG 链路已格式无关；缺的只有 PDF→结构化 MD | 3-5 天，分 3 阶段 |
| PDF 原文阅读+原生批注 | ★★ 建议降级为"对照面板" | foliate-js 的 PDF 分支被注释、批注坐标系是 epubcfi（fixed-layout 不适用） | 只做对照面板 ~1 天；原生批注不做 |

## 点子 1：多格式支持

**事实**：vendored foliate-js 自带 epub/mobi(kf8/azw3)/fb2/cbz 加载器（`packages/foliate-js/`）。SageRead 写死 EPUB 的位置全是浅层：

- `services/constants.ts:22` `SUPPORTED_FILE_EXTS=["epub"]`（注释里躺着完整历史清单）
- `pages/library/components/upload.tsx:30` `accept=".epub"` + 文案
- `services/book-service.ts`：白名单其实已含 PDF/MOBI/CBZ/FB2/FBZ（:31），只是封面/元数据仅 EPUB 分支（:44-58, 80-101 回退文件名）
- `pages/reader/store/create-reader-store.ts:90-92` MIME 写死 `application/epub+zip`
- 向量化管线 `tauri-plugin-epub/pipeline.rs:25` 硬编码 `book.epub`

**工作量**：解锁常量 → accept/MIME 按格式分发 → 非 EPUB 封面回退（首屏截图或默认封面）→ pipeline 路径泛化。**MOBI/AZW3/FB2/CBZ 约 1 天**。PDF 不在此列（见点子 2）。非文本格式（CBZ 漫画等）AI 功能天然不可用，UI 上做能力降级提示即可。

## 点子 2：论文阅读

### 关键洞察（为什么可行）

1. **SageRead 的 RAG 链路已格式无关**：向量化的输入就是 Markdown 分片（EPUB→epub2mdbook→md 分片→embedding→sqlite-vec+BM25 hybrid），`ragSearch/ragToc/ragContext/ragRange` 工具与对话面板 tool-calling 全部就绪。**唯一缺的是"PDF→结构化 MD"这一段的产物。**
2. **zotero-brain 恰好握着这一段**：MinerU Cloud API（VLM）解析 → 结构化 Markdown（含表格/公式/图片描述）+ content_list.json（块级 bbox/页码）+ 原图目录，缓存在 `parsed/{KEY}/`。外加 OpenAlex/arXiv/CrossRef/S2 检索与 6 级下载瀑布。Python 依赖仅 6 行，无本地模型。
3. **论文 md 与 EPUB 章节结构天然同构**——这是整个方案最漂亮的桥（见阶段 1）。

### 分阶段方案（反臃肿的核心：SageRead 本体只做桥接）

**阶段 1 · 读"解析好的论文"（1-2 天）**
把 zotero-brain 的 `parsed/{KEY}/` 缓存自动打包成 EPUB（md+图片+章节，结构稳定）→ 导入 SageRead。效果：阅读、进度、划线批注（epubcfi 锚定自生成 EPUB 的 DOM，稳定）、AI 对话、ragSearch、WebDAV 同步**全套零改动复用**。 Scholaread 的收费卖点"PDF 重排"我们由 MinerU 免费（额度内）获得。管线泛化：pipeline.rs 接受"已有 md"路径，跳过 epub2mdbook。

**阶段 2 · PDF 原文对照面板（~1 天）**
阅读器内可侧开原始 PDF（pdf.js 只读面板），供对照排版/引用原文页码；利用 content_list.json 的 page_start 做"当前位置对应原文第 N 页"。**不做 PDF 原生划线**（fixed-layout 无 CFI 坐标系，投入产出比低，Scholaread 级重排才是我们的路线）。

**阶段 3 · 联网发现与导入（1-2 天）**
不内置任何 Python 依赖：zotero-brain 本就是 stdio MCP，SageRead 对话面板已有 tool-calling 循环（stopWhen 20 步）。把它的搜索/下载/解析工具挂进对话，用户说"搜 XX 主题近三年的论文，解析后放进书库"即闭环；解析完成 → 阶段 1 的桥自动入库。Zotero 双向（pyzotero 已通）作为可选增强。

### 与 zotero-brain 的分工（不合并、不搬运）

| 层 | 归属 |
|---|---|
| 检索/下载/解析/向量化缓存 | zotero-brain（独立项目，Python，MCP） |
| 阅读/批注/进度/对话/同步 GUI | SageRead（只加 EPUB 桥 + PDF 对照面板 + MCP 挂接） |
| 重叠区（都有 RAG） | 各管各的：zotero-brain 的 ChromaDB 服务论文语料问答；SageRead 的 vectors.sqlite 服务"当前打开的这本书"。互不替代，不强行统一 |

### 风险与开放问题

- **MinerU Cloud API 的额度/收费/可持续性**：方案的体验基石，需确认免费额度与限速；用户已有使用经验，评估其稳定性
- **Sci-Hub 在 zotero-brain 下载瀑布最末级**：版权灰色地带，SageRead 侧不做任何内置，仅在文档提示
- **双栏/公式密集论文的解析质量**：MinerU VLM 目前是第一梯队，但需拿 5-10 篇真实论文验收（阶段 1 的验收标准）
- **重排版批注 vs 原文页码**：批注锚在重排版 DOM，引用场景需靠页码映射显示"原文第 N 页"，学术界引用习惯可满足但不完美
- **同步协议**：books.format 随行同步无需改协议；论文 EPUB 走 2b 书籍文件通道（sha256 内容寻址）天然兼容

### 建议排期（插入既有批次）

点子 1（1 天）→ 并入**第三批**；点子 2 阶段 1（1-2 天）→ 列**第四批首位**（价值/成本比最高）；阶段 2、3 视阶段 1 验收结果再排。全程不阻塞 PR 4/5 与 L2 2b 主线。
