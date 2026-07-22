# SageRead 增量同步协议（L2）· 设计评审稿 v1

> 状态：**待评审**。这是跨设备同步的地基协议，未来手机/平板客户端也说这门语言。
> 评审要点见文末"开放问题"。定稿后再开始实现。

## 1. 目标与非目标

**目标**：多台设备上的 SageRead 实例，经任意 WebDAV 网盘中转，实现元数据（书单、进度、划线、对话、时长、技能、星标）与书籍文件的准实时双向同步。

**非目标**：实时协同编辑（无此场景）；API 密钥等敏感配置同步（永不）；WebDAV 之外的传输层（协议保持传输无关，WebDAV 只是第一个载体）。

## 2. 总体架构

两条独立通道，互不阻塞：

- **元数据通道**：各设备把本地数据库变更打包成 changeset（JSONL 文件）放云端，同时拉取其他设备的 changeset 应用进本地库
- **书籍文件通道**：书籍文件按 sha256 内容寻址存储于云端，谁有谁传、谁缺谁下

云端目录结构（WebDAV 根下）：

```
sageread-sync/
  sync.json                      # 全局信息：protocol 版本、创建时间
  devices/<device_id>.json       # 每台设备的指针：最新 changeset 序号、最后在线时间
  changesets/<device_id>/<seq>.jsonl   # 各设备的变更包（只增不改）
  files/<sha256前2位>/<sha256>         # 书籍文件（内容寻址）
  files-index.json               # book_id → {sha256, size, format, title} 清单
```

设计理由：changeset 只增不改（append-only），云端永远不需要"编辑"文件，规避一切云端写冲突；设备指针各写各的（`devices/<自己>.json`），互不打架。

## 3. 身份与状态

- **device_id**：每安装实例一个 UUID，首次同步时生成，持久化本地（`sync-state.json`，不进备份）
- **本地位**：`last_pushed_seq`——本地变更日志（_sync_log）已推送到的序号
- **对每台远端设备**：`last_pulled_seq[device_id]`——已应用到本地的对方 changeset 序号
- 状态全部存本地；云端只是"哑"文件存储，不保存任何权威状态

## 4. 变更捕获（本地）

在 fork 迁移通道建一张变更日志表 + 触发器：

```sql
CREATE TABLE IF NOT EXISTS _sync_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  op TEXT NOT NULL,          -- INSERT | UPDATE | DELETE
  at INTEGER NOT NULL        -- 毫秒时间戳
);
-- 对每张被同步表建 AFTER INSERT/UPDATE/DELETE 触发器写入 _sync_log
```

- 覆盖表：`books`、`book_status`、`book_notes`、`notes`、`threads`、`reading_sessions`、`skills`、`tags`
- **删除即墓碑**：DELETE 触发器记录 row_id，同步给对端执行同样的删除——解决"这边删了那边复活"
- 触发器对应用完全透明，业务代码零改动；上游 schema 演进时由迁移通道补齐对应触发器

## 5. Changeset 格式

文件名：`changesets/<device_id>/<seq_end 补齐10位>.jsonl`，内容一行一条 JSON：

```jsonl
{"header":{"protocol":1,"device_id":"…","seq_from":41,"seq_to":87,"created_at":1784…,"app_version":"0.1.1"}}
{"table":"book_status","id":"…","op":"UPDATE","updated_at":1784…,"data":{…整行…}}
{"table":"book_notes","id":"…","op":"DELETE","updated_at":1784…}
```

- 一次同步把 `_sync_log` 中 `seq > last_pushed_seq` 的所有条目打包上传，成功后推进 `devices/<自己>.json` 指针
- 数据行只含**已知列**（宽容读者原则：对端遇到不认识的列名直接忽略，保证 schema 演进的向后兼容）

## 6. 冲突规则（应用 changeset 时）

| 表 | 规则 |
|---|---|
| 默认（books/book_notes/notes/skills/tags） | 按行 `updated_at`，最后写入赢（LWW）；墓碑优先于更旧的写入，输于更新的重建 |
| threads | **消息级并集合并（已定 2026-07-21）**：两边 messages 按消息 id 取并集、按时间排序；同 id 消息按 `metadata.updated_at` 取新；标题等其他字段整行 LWW。覆盖"设备未刷新就发消息"的分叉场景，零消息丢失 |
| book_status | 进度按 `last_read_at` 大者整体采用（进度是"最后读到哪里"的语义）；status 字段随行 |
| reading_sessions | 只增不改：按主键 id 去重合并，无冲突 |
| books（元数据行） | LWW；对应文件内容以 sha256 为准，永不"覆盖"，只补充缺失 |

应用原则：**每条 changeset 一个事务**；UPSERT by 主键；全部应用是幂等的（同一包重放无副作用）。

## 7. 防回环（关键工程细节）

应用远端变更也会触发本地触发器写 `_sync_log`，若不处理会被当成"本地新变更"再推回去，形成乒乓。解法：应用事务内先记 `seq_start = MAX(seq)`，应用完成后**删除事务内新增且属于本次应用来源的日志行**（按 table+row_id+op 精确匹配删除，不误伤应用期间用户真实的手写改动——其 row_id 撞上的概率可忽略，撞上最多多传一次，无害）。

## 8. 书籍文件通道

- 上传方：新书籍入库后（或同步时发现本地有、云端无），计算 sha256 → PUT `files/<前2位>/<sha256>` → 更新 `files-index.json`
- 下载方：拉 `files-index.json`，与本地库比对；**书架立即可见**（元数据在元数据通道），书文件**点开才下载**（懒加载），下载后按 sha256 校验入库
- `files-index.json` 是唯一的"共享可变"文件，写入策略：读取-合并-重写（设备只增不减），竞态下以云端为准重试合并一次；竞态窗口极小（秒级），可接受

## 9. 同步时机

- 定时：每 5 分钟（可配：关/1分钟/5分钟/30分钟）
- 事件：启动后、退出前、网络恢复时
- 手动：设置页"立即同步"按钮；**对话面板头部的"刷新"按钮**（2026-07-21 新增）——发消息前手动拉取其他设备的最新内容，把"未刷新就发消息"的分叉窗口再缩短一截（与消息级合并双保险）
- 同步状态与最近日志在设置页可见

## 10. 安全措施

- **每次应用远端变更前**，自动 `VACUUM INTO` 本地快照（复用 L1 机制，保留最近 3 份）——同步出错可一键回滚
- `protocol` 版本号：不兼容演进时整体升级目录（`sageread-sync-v2/`），老客户端不受冲击
- 云端文件全部先写临时名再改名（PUT …`.tmp` 完成后再 MOVE），避免半截文件被拉走
- 校验：changeset 逐行 JSON 解析失败即整包跳过并告警；文件 sha256 不符即重下

## 11. 分阶段实施

- **2a 元数据通道**（核心）：迁移（_sync_log+触发器）、本地打包/应用引擎、WebDAV 读写、冲突矩阵、安全快照、设置 UI（同步开关/频率/日志）
- **2b 书籍通道**：sha256 索引、上传、懒下载、书架"云端未下载"标识
- **2c 打磨**：调度优化（空闲才跑）、大库首次全量引导、移动端接入文档

## 12. 开放问题（请评审）

1. ~~**对话（threads）整行 LWW 是否够用**~~ **已定（2026-07-21）：整行 LWW**。同时编辑同一对话的概率可忽略，接受极端情况下丢一边。
2. **同步频率**默认 5 分钟可否？对坚果云免费流量（changeset 都是小文本，每次几 KB~几十 KB，可忽略）。
3. ~~**删除书**~~ **已定（2026-07-21）：回收站模式**——删除改为软删（books.trashed_at），进回收站界面，保留期（30 天）内可恢复；超期自动彻底删除（本地文件+云端文件一起清）。trashed_at 作为普通字段走 LWW 同步；彻底删除才产生墓碑。云端文件按引用计数（files-index 中无引用时）清除。
4. **设置类 JSON**（界面设置、布局）要不要也纳入 L2 同步（整文件 LWW）？还是留在 L1 备份恢复即可？
5. 有没有遗漏的数据类型是你希望跨端一致的（如辅助模型选择？字体？阅读背景？——字体和背景图涉及文件，归"可选资产通道"以后再说）。

## 13. 风险登记

- 触发器带来的写放大：每次业务写多一条日志行，可忽略
- 首次双端全量合并：以"并集"为原则（各自上传全部现状作为初始 changeset），报告里写清引导流程
- 老库升级：_sync_log 从迁移时刻开始记录，之前的存量数据通过"初始引导"全量推送一次
