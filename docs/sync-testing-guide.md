# 多设备同步 · 测试与操作手册（2026-07-27）

> 适用对象：本机双实例验证 / 未来真·多设备使用。先读"概念三分钟"再动手。

## 概念三分钟

- **两条独立通道**：
  - **备份/恢复**（整库快照 zip）——走设置里"远端目录"（默认 `sageread-backups/`），防丢、开荒克隆用
  - **增量同步**（变更日志 changeset）——云端路径**硬编码** `sageread-sync/`，与"远端目录"设置**无关**，日常多设备一致靠它
- **新设备开荒**：直接开增量同步即可——首次同步会自动把存量全量推给新设备（2026-07-26 起，见"已知缺口"）；也可以先"恢复"一台老设备的备份再开增量同步。恢复只带数据，**设备 ID 仍是本机自己的**（`sync-state.json` 不进备份包）
- **节奏**：本地变更 ≤25 秒上云；拉取每 30 秒一轮（频率可在设置改）；退出应用前会自动推一轮
- **真进度**：在某位置**停留 ≥30 秒**才推进"真进度时间戳"；随手乱翻不污染。对端拉到更新的真进度后，若你 60 秒内没翻过页，阅读器自动跟上；否则只 toast 不打扰
- **删除**：删书进回收站是同步的；回收站里彻底删除也会同步删除他端

## 这台机器上的 SageRead 都是谁（先认清再测试！）

| 身份 | 来源 | 有我们的功能？ | 数据目录 |
|---|---|---|---|
| **上游安装版**（2025-10 构建） | `D:\SmallApps\sageread\SageRead.exe` | ❌ 无 WebDAV/同步/回收站等一切 fork 功能 | `%APPDATA%\com.xincmm.sageread\` |
| **实例 A**（我们的代码） | 主目录 `F:\MyProjects\SageRead` 跑 `pnpm dev` | ✅ 全部 | `%APPDATA%\com.xincmm.sageread.dev\` |
| **实例 B**（我们的代码） | worktree `F:\MyProjects\SageRead-dev2` 跑 `pnpm dev` | ✅ 全部 | `%APPDATA%\com.xincmm.sageread.dev2\` |

**三次混淆教训（2026-07-27 实录）**：① 以为安装版有 WebDAV——上游原版没有；② 以为 `D:\SmallApps` 的安装版是我们 fork 的构建——实为上游 2025-10 构建；③ 拿 `woff2_compress.exe` 当"我们的构建"的证据——它是上游原有 sidecar。**辨别方法只看三样：exe 路径与构建日期、数据目录是否带 `.dev`、能不能在设置页看到"增量同步"面板。规则：同步测试只认两个 `pnpm dev` 实例，安装版永不参与。**

## 双实例测试环境怎么搭（已踩坑版）

| | 实例 A | 实例 B |
|---|---|---|
| 目录 | `F:\MyProjects\SageRead` | `F:\MyProjects\SageRead-dev2`（git worktree） |
| identifier | `com.xincmm.sageread.dev` | `com.xincmm.sageread.dev2`（tauri.conf.json 改的） |
| 端口 | 1420 | 1421（vite.config.ts + devUrl 改的） |
| 数据目录 | `%APPDATA%\com.xincmm.sageread.dev\` | `%APPDATA%\com.xincmm.sageread.dev2\` |
| 启动 | 仓库根 `pnpm dev` | worktree 根 `pnpm dev` |

**踩过的坑（重建环境时必读）**：
1. `packages/app/src-tauri/binaries/books_converter-*.exe` 被 gitignore，**worktree/新克隆要手工从主目录拷贝**（含 `_internal/`），否则 Rust 构建脚本报错
2. pnpm 11 构建审批：`pnpm-workspace.yaml` 的 allowBuilds 需含 `es5-ext: true`（漏了会 ERR_PNPM_IGNORED_BUILDS）
3. `pnpm dev` 启动失败会留下**孤儿 SageRead.exe**（vite 死了 exe 不死）；多个实例共用一个数据目录会抢库。启动失败先 `Get-CimInstance Win32_Process -Filter "Name='SageRead.exe'"` 查进程
4. 端口被占：杀残留 node 进程（`netstat -ano | grep 1420`）

## 已知缺口（2026-07-27 验证发现）

- ~~**元数据首次全量引导未实现**~~ **已修复（2026-07-26）**：首次同步自动把 8 张同步表存量全量回填进 changeset（`bootstrapped_at`）；发现新设备加入且本地有书时再回填一次（`bootstrap_peers`）；应用侧 FK 延迟到提交校验，整包不再因"父行后至"被静默丢弃。**新设备无需再"恢复"备份开荒，开增量同步即可收到存量书**
- B 端若无任何推送，不会出现在云端 `devices.json` 索引里（只有指针文件），属正常现象

## 正式测试清单

> 前提：A、B 都已"恢复/拥有"同一批书（见开荒流程），两边增量同步都已开启。每步给出预期与等待时间。

**A. 元数据基础**
- A1 星标：A 给某对话加星 → B 对话列表 30 秒内出现星标（或点 B 对话面板刷新按钮立现）
- A2 划线：A 划一条线 → B 若正开着该书，划线应直接出现（无需重开）；书架/笔记页同步刷新

**B. 真进度与跳转**
- B1：A 把书读到靠后章节并**停留 ≥30 秒** → 约 1 分钟内，B（该书开在前面章节、且 60 秒没翻页）自动跟上 A 的位置
- B2：B 端点对话面板"刷新"按钮 → 立即对齐到最新真进度并跳转
- B3 对照：A 随手乱翻（每页不停留）→ B 不应被抢走位置

**C. 书籍文件通道**
- C1：A 导入新书 → B 书架 30 秒内出现该书、带"云端"角标（未下载）→ 点开自动下载 → 正常阅读
- C2：A 设置页"上传全部"→ B 云端书目列表与 A 一致

**D. 资产与偏好**
- D1：A 换阅读背景/字体 → B 生效
- D2：A 改辅助模型选择 → B 同步

**E. 删除传播**
- E1：A 删书（进回收站）→ B 书架该书消失；A 回收站可恢复，恢复也会同步

**F. 健壮性（最后做）**
- F1：设置页"同步前快照"列表有内容；试一次回滚（会重启）
- F2：观察 10 分钟两边设置页同步状态：无同一变更来回推送（防回环）
- F3：断网 5 分钟做变更 → 恢复网络 → 变更应自动上云（online 事件触发）

## 排障手册

**日志**：`%LOCALAPPDATA%\com.xincmm.sageread.dev(.2)\logs\sageread.log`（只留最近片段）。关键字：
- `云端修剪：删除 N 个已消费 changesets` = 正常清理
- `changeset 缺失（跳过）` = 云端包被删了，水位照推（见"已知缺口"）
- `读取 files-index.json：N 条条目` = 文件通道正常
- `应用 changeset 失败` = 坏包，要查

**本地状态**：`%APPDATA%\com.xincmm.sageread.dev(.2)\sync-state.json`——`device_id`、`last_pushed_seq`、`last_pulled{对端id: seq}`。设置页"增量同步"区可见设备 ID 前 8 位。

**云端结构**（WebDAV 里 `sageread-sync/`）：
```
devices.json                  # {设备id: {latest_seq, last_online}} 谁有货、货到哪了
devices/<设备id>.json          # 指针：changesets 清单 + 各对端消费水位
changesets/<设备id>/<序号>.jsonl  # 变更包（只增不改）
files-index.json + files/     # 书籍文件（sha256 内容寻址）
assets-index.json + assets/   # 字体/背景图
ui-config.json                # 背景选择/辅助模型选择（整文件 LWW）
```

**常见现象对照**：
| 现象 | 原因 | 处置 |
|---|---|---|
| 新设备书架空 | 旧版存量书不在 changeset（已修复：首次同步自动全量回填） | 等一轮同步（推送 ≤25s + 拉取周期）；仍空查两端 sync-state.json 的 `bootstrapped_at` |
| 点开云端书一直"下载中" | 旧版下载无超时、持 DB 锁跨网络（已修复） | 下载超时现在会报错而非永远转圈（后端 120s / 前端 150s），按提示检查网络后重试 |
| 恢复后 B 推了一批"旧变更" | 恢复带入了 A 的残留日志，以 B 名义重推 | 幂等无害，忽略 |
| 进度不跳 | 停留不足 30 秒/60 秒防跳动窗口内 | 看 toast；点刷新按钮强制对齐 |
| 书到了但打不开 | 文件未下载完或 sha 不符 | 重开该书触发重下 |
