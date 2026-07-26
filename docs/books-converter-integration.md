# Books_Converter 整合进 SageRead · 实施交接文档

> 状态：**进行中（已暂停）**。SageRead 侧 Rust 后端已写好；Books_Converter 侧改造 + 前端页面未做。
> 暂停原因：Books_Converter（`F:\MyProjects\Books_Converter`）在 SageRead 工作区**之外**，文件编辑工具够不到。
> **接手前提**：在 IDE 里把 `F:\MyProjects\Books_Converter` 添加为工作区文件夹（File → Add Folder to Workspace），即可正常编辑两个项目。
> 最后更新：2026-07-24。

---

## 一、目标与架构

把 Books_Converter（Python，PDF→EPUB）整合进 SageRead：主页新增"PDF 转 EPUB"板块，拖入 PDF → 实时进度转换 → 一键导入图书馆。

- Books_Converter 改造为**无界面 CLI**（headless），PyInstaller 打成单个 exe。
- 作为 **Tauri sidecar** 捆绑；Rust 后端 spawn 它，**env 传配置**（MinerU Token + 辅助模型 LLM 配置），**args 传选项**，**stdout 流式回传 JSON 进度**。
- LLM 配置**复用辅助模型**（`getUtilityModel()`，OpenAI 兼容端点）；MinerU Token 为新增设置项。

### 关键决策（已与用户确认）
1. **调用方式**：打包成 CLI exe sidecar（非调用本机 Python）。
2. **v1 范围**：PDF→EPUB + 入库，含"强制 OCR"开关 + "全书翻译"语言选项。
3. **引擎**：只用 **hybrid**（MinerU 云 + LLM 云，无需本地 GPU）。**不打 popo 本地引擎**（避免 torch 巨包）。
   - 已验证：Books_Converter 的 `.py` 文件**完全没有 import torch/transformers/accelerate**（本地 VLM 后端已移除）；tkinter 仅 `app.py`/`progress_ui.py` 用到。故 hybrid CLI 可打成无 torch、无 tkinter 的精简 exe。

### Books_Converter 关键事实
- 配置走 env：`MINERU_TOKEN`、`DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`、`DEEPSEEK_MODEL`（见 `config.py`）。
- CLI：`python pipeline.py <pdf> [--output-dir DIR] [--no-ocr] [--translate LANG] [--max-pages N]`。
- 默认 hybrid 引擎；`logging` 走 **stderr**，stdout 干净（适合输出 JSON 进度）。
- 依赖（hybrid 路径）：`fitz`(PyMuPDF)、`mineru`、`openai`、`ebooklib`、`latex2mathml`、`popo/`(纯 Python 包)。

---

## 二、JSON 进度协议（sidecar stdout，每行一个对象）

```
启动:     {"type":"start","title":"...","engine":"hybrid","translate":false}
进度:     {"type":"progress","stage":1,"stage_name":"MinerU","detail":"...","fraction":0.5,"percent":20.0}
阶段完成: {"type":"stage_done","stage":1,"stage_name":"MinerU","elapsed":154.0,"percent":40.0}
全部完成: {"type":"done","epub_path":"...","title":"...","elapsed":123.0,"percent":100.0}
失败:     {"type":"error","message":"..."}
```
Rust 侧另会在进程退出时补发 `{"type":"terminated","success":bool}`（防 done 未发出时前端卡死）。

阶段顺序：MinerU(1) → Hybrid 结构重建(2) → [翻译(3，可选)] → EPUB 生成(末)。

---

## 三、已完成（SageRead 侧，均在工作区内）

### 3.1 Rust 后端
- **新增** `packages/app/src-tauri/src/core/converter.rs`：
  - `ConverterState`（存当前子进程 `CommandChild`，供取消）。
  - `convert_pdf_to_epub(app, params)`：输出目录 = `app_data_dir/converter`；spawn sidecar `books_converter`，注入 env（MINERU_TOKEN/DEEPSEEK_*）+ args（pdf、--headless、--output-dir、[--no-ocr]、[--translate LANG]）；后台任务逐行读 stdout，按行 emit `convert://progress` 事件（payload 为原始 JSON 字符串）；stderr 转 log。
  - `cancel_convert(app)`：kill 子进程。
  - `ConvertParams`（camelCase）：`pdfPath, ocr, translate?, mineruToken, llmBaseUrl, llmApiKey, llmModel`。
- **`core/mod.rs`**：已加 `pub mod converter;`。
- **`lib.rs`**：已 import `converter::{cancel_convert, convert_pdf_to_epub, ConverterState}`；`.manage(ConverterState::default())`；invoke_handler 注册 `convert_pdf_to_epub, cancel_convert`。

### 3.2 配置
- **`tauri.conf.json`** → `bundle.externalBin` 已加 `"binaries/books_converter"`。
- **`capabilities/default.json`** → 已加 `shell:allow-spawn` 与 `shell:allow-kill`（allow `binaries/books_converter`, sidecar:true, args:true）。

### ⚠️ 当前阻塞
`cargo check` 报 `failed to run custom build command`——因为 tauri-build 校验 externalBin 文件存在，而 sidecar exe 还没构建放置。
**需先把 exe 放到** `packages/app/src-tauri/binaries/books_converter-x86_64-pc-windows-msvc.exe`（命名参照已有的 `woff2_compress-x86_64-pc-windows-msvc.exe`），cargo check 才能通过。

---

## 四、待完成 Phase 0：Books_Converter 无界面改造（需工作区访问）

### 4.1 新建 `F:\MyProjects\Books_Converter\progress_headless.py`（完整内容，直接落盘）

```python
"""
无界面进度报告器 — 供 SageRead sidecar 集成使用。
接口对齐 progress_ui.ProgressWindow，向 stdout 打印 JSON 行。
"""

import json
import sys


def _emit(obj: dict):
    try:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    except Exception:
        pass


class HeadlessProgress:
    def __init__(self, book_name: str, engine: str = "hybrid",
                 stage_estimates: list | None = None,
                 translate: bool = False):
        self._book_name = book_name
        self._engine = engine
        self._translate = translate
        if stage_estimates and sum(stage_estimates) > 0:
            total = sum(stage_estimates)
            span = {}
            acc = 0.0
            for i, est in enumerate(stage_estimates, 1):
                nxt = acc + est / total * 100
                span[i] = (acc, min(nxt, 100.0))
                acc = nxt
            self._stage_span = span
        else:
            self._stage_span = {1: (0.0, 40.0), 2: (40.0, 95.0), 3: (95.0, 100.0)}
        self._percent = 0.0

    def _pct_for(self, stage: int, fraction: float) -> float:
        base, ceiling = self._stage_span.get(stage, (0.0, 100.0))
        return base + max(0.0, min(fraction, 1.0)) * (ceiling - base)

    def start(self):
        _emit({"type": "start", "title": self._book_name, "engine": self._engine,
               "translate": self._translate})

    def update_stage(self, stage: int, title: str, detail: str = "",
                     fraction: float | None = None):
        if fraction is not None:
            self._percent = max(self._percent, self._pct_for(stage, fraction))
        _emit({"type": "progress", "stage": stage, "stage_name": title,
               "detail": detail, "fraction": fraction, "percent": round(self._percent, 1)})

    def complete_stage(self, stage: int, title: str, elapsed: float):
        _base, ceiling = self._stage_span.get(stage, (0.0, 100.0))
        self._percent = max(self._percent, ceiling)
        _emit({"type": "stage_done", "stage": stage, "stage_name": title,
               "elapsed": round(elapsed, 1), "percent": round(self._percent, 1)})

    def finish(self, epub_path: str, total_elapsed: float):
        self._percent = 100.0
        _emit({"type": "done", "epub_path": str(epub_path), "title": self._book_name,
               "elapsed": round(total_elapsed, 1), "percent": 100.0})

    def close(self):
        pass


def emit_error(message: str):
    _emit({"type": "error", "message": message})
```

### 4.2 修改 `pipeline.py`（5 处）

**(1) 顶部 import**（约 30-33 行）——去掉顶层 `from progress_ui import ProgressWindow`，改为延迟导入；加入 headless 导入：
```python
from stage1_mineru import run_mineru, save_mineru_metadata, _count_pages
from stage2_hybrid import analyze_structure_hybrid, save_structure
from stage3_epub import generate_epub
from progress_headless import HeadlessProgress, emit_error
# ProgressWindow（tkinter）改为延迟导入，headless CLI 不打包 tkinter
```

**(2) 加错误捕获 handler**（imports 之后）：
```python
class _ErrCapture(logging.Handler):
    last = ""
    def emit(self, record):
        if record.levelno >= logging.ERROR:
            _ErrCapture.last = record.getMessage()
```

**(3) 加 `--headless` 参数**（在 `--translate` 参数之后）：
```python
    parser.add_argument(
        "--headless", action="store_true",
        help="无界面模式：向 stdout 打印 JSON 进度（供 SageRead sidecar 集成）",
    )
```
并在 `args = parser.parse_args()` 之后、创建进度窗口之前，headless 时挂捕获 handler：
```python
    if args.headless:
        logging.getLogger().addHandler(_ErrCapture())
```

**(4) 进度窗口创建**（约 120-123 行）——按 headless 分支：
```python
    if args.headless:
        pw = HeadlessProgress(book_name, engine="hybrid",
                              stage_estimates=est_list,
                              translate=bool(args.translate))
    else:
        from progress_ui import ProgressWindow  # 延迟导入
        pw = ProgressWindow(book_name, engine="hybrid",
                            stage_estimates=est_list,
                            translate=bool(args.translate))
    pw.start()
```

**(5) 终产物路径**（约 226 行）——让 `--output-dir` 生效：
```python
    # 原: final_path = pdf_path.parent / epub_path.name
    final_path = output_base / epub_path.name
```

**(6) 异常处理**（main 末尾的 except 块）——headless 时发 error JSON：
```python
    except SystemExit as e:
        pw.close()
        if args.headless and (e.code not in (0, None)):
            emit_error(_ErrCapture.last or "转换失败")
        raise
    except KeyboardInterrupt:
        pw.close()
        if args.headless:
            emit_error("用户取消")
        raise
    except Exception as e:
        pw.close()
        if args.headless:
            emit_error(str(e) or _ErrCapture.last or "转换失败")
        raise
```

### 4.3 新建 PyInstaller spec `F:\MyProjects\Books_Converter\books_converter_cli.spec`（onefile，console=True）

```python
# -*- mode: python ; coding: utf-8 -*-
a = Analysis(
    ['pipeline.py'],
    pathex=[],
    binaries=[],
    datas=[],
    hiddenimports=['mineru', 'fitz', 'openai', 'ebooklib', 'latex2mathml'],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['tkinter', 'tkinterdnd2', 'torch', 'transformers', 'accelerate'],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz, a.scripts, a.binaries, a.datas, [],
    name='books_converter',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,   # headless CLI 需要 stdout 管道；Tauri sidecar 会隐藏窗口
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
```

### 4.4 构建与放置
```powershell
cd F:\MyProjects\Books_Converter
.venv\Scripts\pyinstaller books_converter_cli.spec
# 产物 dist\books_converter.exe（onefile），拷贝并重命名（加目标三元组后缀）：
copy dist\books_converter.exe F:\MyProjects\SageRead\packages\app\src-tauri\binaries\books_converter-x86_64-pc-windows-msvc.exe
```
> 注：首次构建可能因隐式导入缺 hiddenimports 报错，按报错补 `hiddenimports` 即可。若产物过大，确认 excludes 生效（不应含 torch）。

---

## 五、待完成 Phase 3：前端设置（MinerU Token + 辅助模型读取）

- 设置对话框新增"PDF 转换"区：MinerU Token 输入框（持久化 store，参照现有设置项写法）。
- 辅助模型配置读取：`getUtilityModel()`（`ai/providers/factory.ts`）返回 `{providerId, modelId}`；再从 `provider-store` 的 `modelProviders` 里找该 provider 的 `baseUrl`/`apiKey`。映射为 `llmBaseUrl/llmApiKey/llmModel` 传给 Rust。

## 六、待完成 Phase 4：前端转换页面

- `services/converter-service.ts`：封装 `invoke("convert_pdf_to_epub", {params})`、`invoke("cancel_convert")`、`listen("convert://progress", cb)`（cb 里 `JSON.parse(event.payload)`）。
- `pages/converter/index.tsx`（ConverterPage）：
  - 选 PDF：用 `@tauri-apps/plugin-dialog` 的 `open({filters:[{name:'PDF',extensions:['pdf']}]})` 拿**路径字符串**（不是 File）。
  - 选项：强制 OCR 开关（默认开）、翻译语言下拉（不译/zh/en/ja/fr/de/es/ko）。
  - 开始转换 → invoke + listen 进度（阶段名 + percent + detail）；支持取消。
  - 完成（收到 `done`）→ "导入图书馆"按钮：`readFile(epub_path)`（plugin-fs，路径在 appdata 下已有权限）→ `new File([bytes], name, {type:'application/epub+zip'})` → 复用 `uploadBook(file)`（book-service.ts）→ `refreshBooks()` → toast。
- `home-layout.tsx`：加 `/converter` 路由（参照 `/skills`）。
- `Sidebar`（`components/sidebar.tsx`）：加导航项（图标如 `FileDown`）。

## 七、待完成 Phase 5：验证
- exe 就位后 `cargo check`（应通过）；`tsc --noEmit`。
- 端到端：拖入 PDF → 进度正常 → 导入图书馆 → 书架可见可阅读。
- 更新 `docs/local-roadmap.md` 第四批标记 Books_Converter 整合完成。

---

## 八、复用点速查
- 入库：`uploadBook()`（`services/book-service.ts`）→ Rust `save_book`（移到 `books/<id>/book.epub` + 封面 + 入库 + 同步上传）。
- sidecar 先例：`core/fonts/commands.rs` 的 `woff2_compress`（`.shell().sidecar(...)`）。
- 流式用 `command.spawn()` 返回 `(Receiver<CommandEvent>, CommandChild)`；`CommandEvent::{Stdout,Stderr,Terminated,Error}`。
