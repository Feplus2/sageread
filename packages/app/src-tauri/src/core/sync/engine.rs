use super::assets;
use super::changelog::{self, ChangeRow};
use super::files;
use super::merge::{self, ThreadRowData};
use super::models::{SyncState, WebdavConfig};
use super::tables::{self, ColType};
use super::webdav;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{Row, SqlitePool};
use std::collections::HashMap;
use std::path::Path;
use tauri::{AppHandle, Manager};

/// L2 云端根目录（协议版本化：不兼容演进时整体升级 sageread-sync-v2）
const L2_ROOT: &str = "sageread-sync";
/// 应用前安全快照保留份数
const SAFETY_SNAPSHOTS_KEEP: usize = 3;

#[derive(Serialize, Debug)]
pub struct SyncRunResult {
    pub status: String,
    pub message: String,
    pub pushed_rows: usize,
    pub pulled_rows: usize,
    /// 本轮拉取应用了变更的 book_status 书籍 id（供前端精确刷新进度/位置）
    pub book_status_ids: Vec<String>,
    /// 本轮拉取应用了变更的 threads 对话 id（供前端失效对话缓存）
    pub thread_ids: Vec<String>,
    /// 本轮拉取 books 表有实际变更（供前端刷新书架）
    pub books_changed: bool,
    /// 本轮拉取 notes / book_notes 表有实际变更（供前端刷新划线笔记）
    pub notes_changed: bool,
    /// 本轮下载的字体数（供前端刷新字体）
    pub fonts_downloaded: usize,
    /// 本轮下载的背景图数（供前端刷新背景列表）
    pub backgrounds_downloaded: usize,
}

/// 单包应用结果：条数 + 分表变更 id + 书架/笔记变更信号
#[derive(Debug, Default)]
pub struct ApplyOutcome {
    pub count: usize,
    pub book_status_ids: Vec<String>,
    pub thread_ids: Vec<String>,
    pub books_changed: bool,
    pub notes_changed: bool,
    /// 实际应用的 books 行数（B 端引导到达的可观测日志用）
    pub books_count: usize,
}

/// 设备指针文件 devices/<device_id>.json（各写各的，互不打架）
#[derive(Serialize, Deserialize, Debug, Default, Clone)]
pub struct DevicePointer {
    #[serde(default)]
    pub device_id: String,
    #[serde(default)]
    pub latest_seq: i64,
    #[serde(default)]
    pub last_online: i64,
    #[serde(default)]
    pub changesets: Vec<ChangesetEntry>,
    /// 本设备对各远端设备的应用水位（供其他设备修剪其 changesets 时取最小值）
    #[serde(default)]
    pub pulled: HashMap<String, i64>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ChangesetEntry {
    pub seq_end: i64,
    pub created_at: i64,
}

/// 全局设备索引 devices.json（读-合并-重写，files-index 模式）
#[derive(Serialize, Deserialize, Debug, Default, Clone)]
pub struct DeviceIndexEntry {
    #[serde(default)]
    pub latest_seq: i64,
    #[serde(default)]
    pub last_online: i64,
}

#[derive(Deserialize)]
struct ChangesetHeaderLine {
    protocol: u32,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn app_version(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

/* ---------------- 本地状态 ---------------- */

fn ensure_device_id(config_dir: &Path, state: &mut SyncState) -> Result<String, String> {
    if let Some(device_id) = &state.device_id {
        return Ok(device_id.clone());
    }
    let device_id = uuid::Uuid::new_v4().to_string();
    state.device_id = Some(device_id.clone());
    super::backup::write_sync_state(config_dir, state)?;
    Ok(device_id)
}

impl SyncState {
    fn last_pulled_of(&self, device_id: &str) -> i64 {
        self.last_pulled
            .as_ref()
            .and_then(|m| m.get(device_id))
            .copied()
            .unwrap_or(0)
    }

    fn set_last_pulled(&mut self, device_id: &str, seq: i64) {
        self.last_pulled
            .get_or_insert_with(HashMap::new)
            .insert(device_id.to_string(), seq);
    }

    /// 记录某包应用失败，返回累计次数
    fn record_pack_failure(&mut self, device_id: &str, seq_end: i64) -> u8 {
        let count = self.failed_packs.entry(pack_failure_key(device_id, seq_end)).or_insert(0);
        *count += 1;
        *count
    }

    /// 应用成功：清除该包失败记录
    fn clear_pack_failure(&mut self, device_id: &str, seq_end: i64) {
        self.failed_packs.remove(&pack_failure_key(device_id, seq_end));
    }
}

fn pack_failure_key(device_id: &str, seq_end: i64) -> String {
    format!("{device_id}/{seq_end}")
}

/// 单包应用失败重试上限：满后跳过并告警（防永久坏包卡死拉取水位）
const MAX_PACK_FAILURES: u8 = 3;

/// 失败包处置：累计失败次数，返回 true 表示已达上限应跳过（调用方推进水位），false 留下轮重试
fn note_pack_failure(state: &mut SyncState, device_id: &str, seq_end: i64) -> bool {
    state.record_pack_failure(device_id, seq_end) >= MAX_PACK_FAILURES
}

/* ---------------- 云端指针与索引 ---------------- */

fn pointer_path(device_id: &str) -> String {
    format!("{L2_ROOT}/devices/{device_id}.json")
}

async fn read_pointer(config: &WebdavConfig, device_id: &str) -> Result<DevicePointer, String> {
    match webdav::get_path(config, &pointer_path(device_id)).await? {
        Some(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("解析设备指针失败: {e}")),
        None => Ok(DevicePointer {
            device_id: device_id.to_string(),
            ..Default::default()
        }),
    }
}

/// 上传远端文件。原为 .tmp + MOVE 原子改名，坚果云 MOVE 返回 409（其 Destination 实现有差异），
/// 改为直接 PUT；半截文件风险由拉取侧"解析失败整包跳过"兜底（协议 §10 注）
async fn put_path_atomic(config: &WebdavConfig, path: &str, bytes: Vec<u8>) -> Result<(), String> {
    webdav::put_path(config, path, bytes).await
}

async fn write_pointer(config: &WebdavConfig, pointer: &DevicePointer) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(pointer).map_err(|e| e.to_string())?;
    put_path_atomic(config, &pointer_path(&pointer.device_id), bytes).await
}

async fn read_devices_index(config: &WebdavConfig) -> Result<HashMap<String, DeviceIndexEntry>, String> {
    match webdav::get_path(config, &format!("{L2_ROOT}/devices.json")).await? {
        Some(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("解析设备索引失败: {e}")),
        None => Ok(HashMap::new()),
    }
}

/// 把本设备登记进索引 map（纯函数便于测试；网络读写由 upsert_devices_index 负责）。
/// latest_seq 可为 0（纯拉取设备也要可被对端发现，协议 §3 设备登记语义）
pub fn register_in_index(index: &mut HashMap<String, DeviceIndexEntry>, device_id: &str, latest_seq: i64) {
    index.insert(
        device_id.to_string(),
        DeviceIndexEntry {
            latest_seq,
            last_online: now_ms(),
        },
    );
}

async fn upsert_devices_index(config: &WebdavConfig, device_id: &str, latest_seq: i64) -> Result<(), String> {
    // 索引不存在（404）才当空表；读取/解析失败直接 Err，禁止盲写覆盖云端其他设备条目
    let mut index = read_devices_index(config).await?;
    register_in_index(&mut index, device_id, latest_seq);
    let bytes = serde_json::to_vec_pretty(&index).map_err(|e| e.to_string())?;
    put_path_atomic(config, &format!("{L2_ROOT}/devices.json"), bytes).await
}

/// 发现需要全量引导的新 peer：devices.json 里非自身且未引导过的设备（排序输出，日志/测试稳定）
pub fn new_bootstrap_peers(
    device_ids: impl IntoIterator<Item = String>,
    device_id: &str,
    bootstrap_peers: &[String],
) -> Vec<String> {
    let mut peers: Vec<String> = device_ids
        .into_iter()
        .filter(|id| id != device_id && !bootstrap_peers.contains(id))
        .collect();
    peers.sort();
    peers
}

/* ---------------- 应用前安全快照（复用 L1 VACUUM INTO） ---------------- */

async fn snapshot_before_apply(app: &AppHandle, pool: &SqlitePool) -> Result<(), String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let dir = config_dir.join("sync-staging").join("l2-safety");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let staged = dir.join(format!("app-{}.db", now_ms()));
    sqlx::query("VACUUM INTO ?")
        .bind(staged.to_string_lossy().replace('\\', "/"))
        .execute(pool)
        .await
        .map_err(|e| format!("同步前安全快照失败: {e}"))?;

    // 只保留最近 SAFETY_SNAPSHOTS_KEEP 份
    let mut snapshots: Vec<_> = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|path| path.extension().is_some_and(|ext| ext == "db"))
        .collect();
    snapshots.sort();
    snapshots.reverse();
    for path in snapshots.into_iter().skip(SAFETY_SNAPSHOTS_KEEP) {
        let _ = std::fs::remove_file(path);
    }

    Ok(())
}

/* ---------------- 变更应用（协议 §6 冲突矩阵） ---------------- */

fn value_to_i64(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| value.as_str().and_then(|s| s.parse().ok()))
}

fn data_string(data: &Value, key: &str) -> Option<String> {
    data.get(key).and_then(|v| match v {
        Value::String(s) => Some(s.clone()),
        _ => None,
    })
}

/// 按注册表列把 JSON data 绑定进 INSERT/UPDATE 语句
async fn insert_row(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    table: &tables::SyncTable,
    data: &Value,
) -> Result<(), String> {
    let names = table.columns.iter().map(|(n, _)| *n).collect::<Vec<_>>();
    let placeholders = names.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
    let sql = format!("INSERT INTO {} ({}) VALUES ({})", table.name, names.join(", "), placeholders);
    let mut query = sqlx::query(&sql);
    for (name, col_type) in table.columns {
        let value = data.get(*name).unwrap_or(&Value::Null);
        query = bind_value(query, value, col_type);
    }
    query.execute(&mut **tx).await.map_err(|e| format!("插入行失败: {e}"))?;
    Ok(())
}

async fn update_row(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    table: &tables::SyncTable,
    id: &str,
    data: &Value,
) -> Result<(), String> {
    let names: Vec<&str> = table
        .columns
        .iter()
        .map(|(n, _)| *n)
        .filter(|n| *n != table.pk)
        .collect();
    let assignments = names.iter().map(|n| format!("{n} = ?")).collect::<Vec<_>>().join(", ");
    let sql = format!("UPDATE {} SET {} WHERE {} = ?", table.name, assignments, table.pk);
    let mut query = sqlx::query(&sql);
    for name in &names {
        let (_, col_type) = table.columns.iter().find(|(n, _)| n == name).unwrap();
        let value = data.get(*name).unwrap_or(&Value::Null);
        query = bind_value(query, value, col_type);
    }
    query = query.bind(id);
    query.execute(&mut **tx).await.map_err(|e| format!("更新行失败: {e}"))?;
    Ok(())
}

fn bind_value<'q>(
    query: sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments<'q>>,
    value: &Value,
    col_type: &ColType,
) -> sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments<'q>> {
    match col_type {
        ColType::Text => match value {
            Value::String(s) => query.bind(Some(s.clone())),
            Value::Null => query.bind(None::<String>),
            other => query.bind(Some(other.to_string())),
        },
        ColType::Int => match value {
            Value::Number(n) => query.bind(n.as_i64()),
            Value::Null => query.bind(None::<i64>),
            Value::String(s) => query.bind(s.parse::<i64>().ok()),
            _ => query.bind(None::<i64>),
        },
    }
}

async fn local_updated_at(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    table: &tables::SyncTable,
    id: &str,
) -> Result<Option<i64>, String> {
    let sql = format!("SELECT updated_at FROM {} WHERE {} = ?", table.name, table.pk);
    let row = sqlx::query(&sql)
        .bind(id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|e| format!("读取本地行失败: {e}"))?;
    Ok(row.and_then(|r| r.try_get::<Option<i64>, _>("updated_at").unwrap_or(None)))
}

/// 记录实际执行的写入（table, row_id, op），供防回环精确删除
type AppliedOps = Vec<(String, String, String)>;

/// 默认 LWW 表：books / book_notes / notes / skills / tags
async fn apply_lww_upsert(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    row: &ChangeRow,
    applied: &mut AppliedOps,
) -> Result<(), String> {
    let table = tables::find_table(&row.table).ok_or("未知表")?;
    let data = row.data.as_ref().ok_or("UPSERT 行缺少 data")?;
    let local = local_updated_at(tx, table, &row.id).await?;

    match local {
        None => {
            insert_row(tx, table, data).await?;
            applied.push((row.table.clone(), row.id.clone(), "INSERT".to_string()));
        }
        Some(local_at) if merge::remote_wins(Some(local_at), row.updated_at) => {
            update_row(tx, table, &row.id, data).await?;
            applied.push((row.table.clone(), row.id.clone(), "UPDATE".to_string()));
        }
        _ => {}
    }
    Ok(())
}

/// 墓碑：优先于更旧的写入，输于更新的重建（协议 §6）
async fn apply_delete(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    row: &ChangeRow,
    applied: &mut AppliedOps,
) -> Result<(), String> {
    let table = tables::find_table(&row.table).ok_or("未知表")?;
    let local = local_updated_at(tx, table, &row.id).await?;

    // 本地不存在 → 无需删除（也不会产生日志）；本地更旧 → 删除；本地更新 → 墓碑输
    if merge::remote_wins(local, row.updated_at) && local.is_some() {
        let sql = format!("DELETE FROM {} WHERE {} = ?", table.name, table.pk);
        sqlx::query(&sql)
            .bind(&row.id)
            .execute(&mut **tx)
            .await
            .map_err(|e| format!("删除行失败: {e}"))?;
        applied.push((row.table.clone(), row.id.clone(), "DELETE".to_string()));
    }
    Ok(())
}

/// book_status：按 position_changed_at 大者整体采用（真进度；NULL 时回落 last_read_at）
async fn apply_book_status_upsert(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    row: &ChangeRow,
    applied: &mut AppliedOps,
) -> Result<(), String> {
    let table = tables::find_table("book_status").unwrap();
    let data = row.data.as_ref().ok_or("UPSERT 行缺少 data")?;

    let exists_sql = "SELECT last_read_at, position_changed_at FROM book_status WHERE book_id = ?";
    let existing = sqlx::query(exists_sql)
        .bind(&row.id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|e| format!("读取本地进度失败: {e}"))?;

    // 真进度比较键：position_changed_at 优先，NULL 回落 last_read_at
    let remote_key = data
        .get("position_changed_at")
        .and_then(value_to_i64)
        .or_else(|| data.get("last_read_at").and_then(value_to_i64))
        .unwrap_or(0);

    match existing {
        None => {
            insert_row(tx, table, data).await?;
            applied.push((row.table.clone(), row.id.clone(), "INSERT".to_string()));
        }
        Some(local_row) => {
            let local_key = local_row
                .try_get::<Option<i64>, _>("position_changed_at")
                .unwrap_or(None)
                .or_else(|| local_row.try_get::<Option<i64>, _>("last_read_at").unwrap_or(None))
                .unwrap_or(0);
            if remote_key > local_key {
                update_row(tx, table, &row.id, data).await?;
                applied.push((row.table.clone(), row.id.clone(), "UPDATE".to_string()));
            }
        }
    }
    Ok(())
}

/// reading_sessions：只增不改，按主键去重合并
async fn apply_session_insert(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    row: &ChangeRow,
    applied: &mut AppliedOps,
) -> Result<(), String> {
    let table = tables::find_table("reading_sessions").unwrap();
    let data = row.data.as_ref().ok_or("UPSERT 行缺少 data")?;

    let names = table.columns.iter().map(|(n, _)| *n).collect::<Vec<_>>();
    let placeholders = names.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
    let sql = format!(
        "INSERT OR IGNORE INTO {} ({}) VALUES ({})",
        table.name,
        names.join(", "),
        placeholders
    );
    let mut query = sqlx::query(&sql);
    for (name, col_type) in table.columns {
        let value = data.get(*name).unwrap_or(&Value::Null);
        query = bind_value(query, value, col_type);
    }
    let result = query.execute(&mut **tx).await.map_err(|e| format!("合并阅读会话失败: {e}"))?;
    if result.rows_affected() > 0 {
        applied.push((row.table.clone(), row.id.clone(), "INSERT".to_string()));
    }
    Ok(())
}

/// skills：两端各自初始化会自建同名默认技能（id 不同、name 相同），按主键 INSERT 会撞
/// UNIQUE(name) 索引导致整包失败（真机实证 2067）。本地无此 id 时按 name 找已存在行：
/// 视为同一技能，LWW 取新则 UPDATE 本地行（保留本地 id），否则跳过
async fn apply_skill_upsert(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    row: &ChangeRow,
    applied: &mut AppliedOps,
) -> Result<(), String> {
    let table = tables::find_table("skills").unwrap();
    let data = row.data.as_ref().ok_or("UPSERT 行缺少 data")?;

    if let Some(local_at) = local_updated_at(tx, table, &row.id).await? {
        // 同 id：标准 LWW
        if merge::remote_wins(Some(local_at), row.updated_at) {
            update_row(tx, table, &row.id, data).await?;
            applied.push((row.table.clone(), row.id.clone(), "UPDATE".to_string()));
        }
        return Ok(());
    }

    // 本地无此 id：可能撞同名（默认技能）→ 按 name 匹配
    let name = data.get("name").and_then(Value::as_str).unwrap_or("");
    let existing: Option<(String, Option<i64>)> = if name.is_empty() {
        None
    } else {
        sqlx::query("SELECT id, updated_at FROM skills WHERE name = ?")
            .bind(name)
            .fetch_optional(&mut **tx)
            .await
            .map_err(|e| format!("读取本地技能失败: {e}"))?
            .map(|r| (r.get("id"), r.try_get("updated_at").unwrap_or(None)))
    };

    match existing {
        Some((local_id, local_at)) => {
            if merge::remote_wins(local_at, row.updated_at) {
                // update_row 不含主键列，本地 id 保留
                update_row(tx, table, &local_id, data).await?;
                applied.push((row.table.clone(), local_id, "UPDATE".to_string()));
            }
            Ok(())
        }
        None => {
            insert_row(tx, table, data).await?;
            applied.push((row.table.clone(), row.id.clone(), "INSERT".to_string()));
            Ok(())
        }
    }
}

fn thread_row_from_data(data: &Value) -> ThreadRowData {
    ThreadRowData {
        id: data_string(data, "id").unwrap_or_default(),
        book_id: data_string(data, "book_id"),
        metadata: data_string(data, "metadata").unwrap_or_else(|| "{}".to_string()),
        title: data_string(data, "title").unwrap_or_default(),
        messages: data_string(data, "messages").unwrap_or_else(|| "[]".to_string()),
        starred: data.get("starred").and_then(value_to_i64).unwrap_or(0),
        created_at: data.get("created_at").and_then(value_to_i64).unwrap_or(0),
        updated_at: data.get("updated_at").and_then(value_to_i64).unwrap_or(0),
    }
}

async fn fetch_thread_row(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    id: &str,
) -> Result<Option<ThreadRowData>, String> {
    let row = sqlx::query(
        "SELECT id, book_id, metadata, title, messages, starred, created_at, updated_at FROM threads WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|e| format!("读取本地对话失败: {e}"))?;

    Ok(row.map(|r| ThreadRowData {
        id: r.get("id"),
        book_id: r.get("book_id"),
        metadata: r.get("metadata"),
        title: r.get("title"),
        messages: r.get("messages"),
        starred: r.get::<i64, _>("starred"),
        created_at: r.get("created_at"),
        updated_at: r.get("updated_at"),
    }))
}

/// threads：消息级并集合并（协议 §6，已定 2026-07-21）
async fn apply_thread_upsert(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    row: &ChangeRow,
    applied: &mut AppliedOps,
) -> Result<(), String> {
    let data = row.data.as_ref().ok_or("UPSERT 行缺少 data")?;
    let remote_row = thread_row_from_data(data);
    let local_row = fetch_thread_row(tx, &row.id).await?;

    let merged = merge::merge_thread_row(local_row.as_ref(), &remote_row);

    match &local_row {
        None => {
            let json = thread_row_to_json(&merged);
            insert_row(tx, tables::find_table("threads").unwrap(), &json).await?;
            applied.push((row.table.clone(), row.id.clone(), "INSERT".to_string()));
        }
        Some(local) if merged != *local => {
            let json = thread_row_to_json(&merged);
            update_row(tx, tables::find_table("threads").unwrap(), &row.id, &json).await?;
            applied.push((row.table.clone(), row.id.clone(), "UPDATE".to_string()));
        }
        _ => {} // 合并结果与本地一致（重放幂等），不写
    }
    Ok(())
}

fn thread_row_to_json(row: &ThreadRowData) -> Value {
    serde_json::json!({
        "id": row.id,
        "book_id": row.book_id,
        "metadata": row.metadata,
        "title": row.title,
        "messages": row.messages,
        "starred": row.starred,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    })
}

async fn apply_change_row(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    row: &ChangeRow,
    applied: &mut AppliedOps,
) -> Result<(), String> {
    if tables::find_table(&row.table).is_none() {
        log::warn!("跳过未知表变更: {}", row.table);
        return Ok(());
    }

    if row.op == "DELETE" {
        return apply_delete(tx, row, applied).await;
    }

    match row.table.as_str() {
        "threads" => apply_thread_upsert(tx, row, applied).await,
        "book_status" => apply_book_status_upsert(tx, row, applied).await,
        "reading_sessions" => apply_session_insert(tx, row, applied).await,
        "skills" => apply_skill_upsert(tx, row, applied).await,
        _ => apply_lww_upsert(tx, row, applied).await,
    }
}

/// 应用单个 changeset：逐包一个事务 + 防回环（协议 §7）
pub async fn apply_changeset(pool: &SqlitePool, bytes: &[u8]) -> Result<ApplyOutcome, String> {
    let text = String::from_utf8(bytes.to_vec()).map_err(|_| "changeset 不是合法 UTF-8".to_string())?;
    let mut lines = text.lines();

    // 解析失败即整包跳过（协议 §10）
    let header_line = lines.next().ok_or("changeset 为空")?;
    let header_wrapper: Value = serde_json::from_str(header_line).map_err(|e| format!("header 解析失败: {e}"))?;
    let header: ChangesetHeaderLine =
        serde_json::from_value(header_wrapper.get("header").cloned().ok_or("缺少 header")?)
            .map_err(|e| format!("header 解析失败: {e}"))?;
    if header.protocol != 1 {
        return Err(format!("不支持的协议版本: {}", header.protocol));
    }

    let mut rows: Vec<ChangeRow> = Vec::new();
    for line in lines {
        if line.trim().is_empty() {
            continue;
        }
        rows.push(serde_json::from_str::<ChangeRow>(line).map_err(|e| format!("数据行解析失败: {e}"))?);
    }

    let seq_start: i64 = sqlx::query("SELECT COALESCE(MAX(seq), 0) as max_seq FROM _sync_log")
        .fetch_one(pool)
        .await
        .map_err(|e| format!("读取日志水位失败: {e}"))?
        .get("max_seq");

    let mut applied: AppliedOps = Vec::new();
    let mut tx = pool.begin().await.map_err(|e| format!("开启事务失败: {e}"))?;

    // 包内行按 table+id 排序，book_notes/book_status 排在 books 之前；FK 检查延迟到提交时，
    // 同包"父行后至"也能整体落库（提交时仍校验，真缺父行则整包回滚）
    sqlx::query("PRAGMA defer_foreign_keys = ON")
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("设置外键延迟检查失败: {e}"))?;

    for row in &rows {
        apply_change_row(&mut tx, row, &mut applied).await?;
    }

    // 防回环：精确删除本次应用写出的日志行（应用期间用户真实改动误伤概率可忽略，撞上最多多传一次）
    for (table, id, op) in &applied {
        sqlx::query("DELETE FROM _sync_log WHERE seq > ? AND table_name = ? AND row_id = ? AND op = ?")
            .bind(seq_start)
            .bind(table)
            .bind(id)
            .bind(op)
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("防回环清理失败: {e}"))?;
    }

    tx.commit().await.map_err(|e| format!("提交事务失败: {e}"))?;

    let mut outcome = ApplyOutcome {
        count: applied.len(),
        ..Default::default()
    };
    for (table, id, _) in &applied {
        match table.as_str() {
            "book_status" => outcome.book_status_ids.push(id.clone()),
            "threads" => outcome.thread_ids.push(id.clone()),
            "books" => {
                outcome.books_changed = true;
                outcome.books_count += 1;
            }
            "notes" | "book_notes" => outcome.notes_changed = true,
            _ => {}
        }
    }
    outcome.book_status_ids.sort();
    outcome.book_status_ids.dedup();
    outcome.thread_ids.sort();
    outcome.thread_ids.dedup();
    Ok(outcome)
}

/* ---------------- 存量回填引导（协议 §11 2c / §13） ---------------- */

/// 把 8 张同步表的全部现存行以 op=INSERT 写入 _sync_log（books 含回收站行，全保真）。
/// 触发器只记录迁移之后的变更，存量行永远进不了 changeset——引导时回填一次，
/// 让新设备经增量通道收到全量现状。接收端按主键 UPSERT 幂等应用，重放无害。
/// 返回回填行数。
pub async fn emit_bootstrap_dump(pool: &SqlitePool) -> Result<usize, String> {
    let now = now_ms();
    let mut total = 0usize;
    for table in tables::TABLES {
        // 多行 INSERT：行数可达数千，一条 SELECT 插入避免逐行往返（表名/主键均为编译期常量）
        let sql = format!(
            "INSERT INTO _sync_log (table_name, row_id, op, at) SELECT '{}', {}, 'INSERT', {} FROM {}",
            table.name, table.pk, now, table.name
        );
        let result = sqlx::query(&sql)
            .execute(pool)
            .await
            .map_err(|e| format!("存量回填失败({}): {e}", table.name))?;
        total += result.rows_affected() as usize;
    }
    Ok(total)
}

/* ---------------- 水位查询与日志修剪（本地+云端） ---------------- */

/// 是否有未推送的本地变更（纯本地查询，无网络）
pub async fn has_unpushed(pool: &SqlitePool, last_pushed_seq: i64) -> Result<bool, String> {
    let max_seq: i64 = sqlx::query("SELECT COALESCE(MAX(seq), 0) as max_seq FROM _sync_log")
        .fetch_one(pool)
        .await
        .map_err(|e| format!("读取日志水位失败: {e}"))?
        .get("max_seq");
    Ok(max_seq > last_pushed_seq)
}

/// 本地日志保留窗口：推送成功后删除早于 last_pushed_seq - KEEP 的日志行
const LOCAL_LOG_KEEP: i64 = 100;

async fn prune_local_log(pool: &SqlitePool, last_pushed_seq: i64) -> Result<(), String> {
    sqlx::query("DELETE FROM _sync_log WHERE seq < ?")
        .bind(last_pushed_seq - LOCAL_LOG_KEEP)
        .execute(pool)
        .await
        .map_err(|e| format!("本地日志修剪失败: {e}"))?;
    Ok(())
}

/// 云端 changesets 保留规则：最近 5 个永不删；超过最近 50 个必删（离线设备兜底）
const CLOUD_KEEP_RECENT: usize = 5;
const CLOUD_KEEP_MAX: usize = 50;

/// 计算本设备云端 changesets 的删除候选（纯函数便于测试）：
/// seq_end < min_pulled 且不在最近 5 个之列；另外超出最近 50 个的一律删除
pub fn compute_prune_candidates(seq_ends: &[i64], min_pulled: i64) -> Vec<i64> {
    let mut sorted = seq_ends.to_vec();
    sorted.sort_unstable();

    let newest5_start = sorted.len().saturating_sub(CLOUD_KEEP_RECENT);
    let newest5: std::collections::HashSet<i64> = sorted[newest5_start..].iter().copied().collect();
    let max50_boundary = if sorted.len() > CLOUD_KEEP_MAX {
        Some(sorted[sorted.len() - CLOUD_KEEP_MAX])
    } else {
        None
    };

    sorted
        .into_iter()
        .filter(|seq_end| {
            let beyond_max = max50_boundary.is_some_and(|boundary| *seq_end < boundary);
            let consumed = *seq_end < min_pulled && !newest5.contains(seq_end);
            beyond_max || consumed
        })
        .collect()
}

/// 计算其他设备对指定设备 changesets 的最低消费水位（缺失按 0）
pub fn min_pulled_for(device_id: &str, pointers: &[DevicePointer]) -> i64 {
    pointers
        .iter()
        .filter(|p| p.device_id != device_id)
        .map(|p| p.pulled.get(device_id).copied().unwrap_or(0))
        .min()
        .unwrap_or(0)
}

/// 推送成功后修剪云端：删除所有设备都已消费（或超出兜底数量）的本设备 changesets。
/// 任何一步失败只记 warn，不影响同步主流程。
async fn prune_remote_changesets(config: &WebdavConfig, device_id: &str) {
    let result: Result<(), String> = async {
        // 设备集合来自 devices.json 索引；逐一读指针拿各自 pulled 水位
        let index = read_devices_index(config).await?;
        let mut pointers = Vec::new();
        for remote_id in index.keys() {
            if let Ok(pointer) = read_pointer(config, remote_id).await {
                pointers.push(pointer);
            }
        }
        let min_pulled = min_pulled_for(device_id, &pointers);

        let mut own = read_pointer(config, device_id).await?;
        let seq_ends: Vec<i64> = own.changesets.iter().map(|cs| cs.seq_end).collect();
        let candidates = compute_prune_candidates(&seq_ends, min_pulled);

        for seq_end in &candidates {
            webdav::delete_path(config, &format!("{L2_ROOT}/changesets/{device_id}/{:010}.jsonl", seq_end)).await?;
        }
        if !candidates.is_empty() {
            own.changesets.retain(|cs| !candidates.contains(&cs.seq_end));
            write_pointer(config, &own).await?;
            log::info!("云端修剪：删除 {} 个已消费 changesets", candidates.len());
        }
        Ok(())
    }
    .await;

    if let Err(e) = result {
        log::warn!("云端修剪失败（忽略，不影响同步）: {e}");
    }
}

/* ---------------- 主流程：推送 + 拉取 ---------------- */

/// 拉取其他设备的 changesets 并应用（run_sync 与 run_pull_only 共用）
async fn pull_from_devices(
    app: &AppHandle,
    pool: &SqlitePool,
    config: &WebdavConfig,
    device_id: &str,
    state: &mut SyncState,
) -> Result<ApplyOutcome, String> {
    let mut outcome = ApplyOutcome::default();
    let devices = read_devices_index(config).await.unwrap_or_default();

    // 新设备引导回填（协议 §11 2c）：发现他端设备（此前未为其引导过）且本地有存量书，
    // 则全量回填一次进 _sync_log，下一轮推送周期上云；bootstrap_peers 防重复
    let new_peers = new_bootstrap_peers(devices.keys().cloned(), device_id, &state.bootstrap_peers);
    if !new_peers.is_empty() {
        let book_count: i64 = sqlx::query("SELECT COUNT(*) as c FROM books")
            .fetch_one(pool)
            .await
            .map_err(|e| format!("读取书籍数量失败: {e}"))?
            .get("c");
        if book_count > 0 {
            let dumped = emit_bootstrap_dump(pool).await?;
            for peer in &new_peers {
                log::info!(
                    "发现新设备 {}，已生成全量引导（{} 行），将于下一轮推送",
                    &peer[..8.min(peer.len())],
                    dumped
                );
            }
            state.bootstrap_peers.extend(new_peers);
        }
    }

    let mut snapshot_done = false;
    let mut watermark_changed = false;

    for (remote_id, info) in &devices {
        if remote_id == device_id {
            continue;
        }
        let last_pulled = state.last_pulled_of(remote_id);
        if info.latest_seq <= last_pulled {
            continue;
        }

        let pointer = match read_pointer(config, remote_id).await {
            Ok(pointer) => pointer,
            Err(e) => {
                log::warn!("读取设备指针失败，跳过 {remote_id}: {e}");
                continue;
            }
        };

        // 失败包不推水位、阻塞同设备后续包（父行可能就在失败包里，跳过去应用仍会失败）
        let mut blocked = false;

        for cs in &pointer.changesets {
            if cs.seq_end <= last_pulled {
                continue;
            }
            let path = format!("{L2_ROOT}/changesets/{remote_id}/{:010}.jsonl", cs.seq_end);
            let Some(bytes) = webdav::get_path(config, &path).await? else {
                log::warn!("changeset 缺失（跳过）: {path}");
                state.set_last_pulled(remote_id, cs.seq_end);
                watermark_changed = true;
                continue;
            };

            if !snapshot_done {
                if let Err(e) = snapshot_before_apply(app, pool).await {
                    log::error!("同步前安全快照失败（继续同步）: {e}");
                }
                snapshot_done = true;
            }

            match apply_changeset(pool, &bytes).await {
                Ok(applied) => {
                    if applied.books_count > 0 {
                        log::info!("收到书籍元数据 {} 条", applied.books_count);
                    }
                    outcome.count += applied.count;
                    outcome.book_status_ids.extend(applied.book_status_ids);
                    outcome.thread_ids.extend(applied.thread_ids);
                    outcome.books_changed |= applied.books_changed;
                    outcome.notes_changed |= applied.notes_changed;
                    outcome.books_count += applied.books_count;
                    state.set_last_pulled(remote_id, cs.seq_end);
                    state.clear_pack_failure(remote_id, cs.seq_end);
                    watermark_changed = true;
                }
                Err(e) => {
                    if note_pack_failure(state, remote_id, cs.seq_end) {
                        log::error!("应用 changeset 失败满 {MAX_PACK_FAILURES} 次，跳过并告警: {path}: {e}");
                        state.set_last_pulled(remote_id, cs.seq_end);
                        watermark_changed = true;
                    } else {
                        // 不推进水位，下轮重试（如乱序包：引导包到达后自动恢复）
                        log::warn!("应用 changeset 失败，不推水位，下轮重试: {path}: {e}");
                        blocked = true;
                        break;
                    }
                }
            }
        }

        if !blocked {
            state.set_last_pulled(remote_id, info.latest_seq.max(state.last_pulled_of(remote_id)));
        }
    }

    // 发布本设备的应用水位到设备指针（供其他设备修剪其云端 changesets）
    if watermark_changed {
        if let Ok(mut own) = read_pointer(config, device_id).await {
            if let Some(pulled_map) = &state.last_pulled {
                own.pulled = pulled_map.clone();
            }
            own.device_id = device_id.to_string();
            if let Err(e) = write_pointer(config, &own).await {
                log::warn!("发布应用水位失败（忽略）: {e}");
            }
        }
    }

    outcome.book_status_ids.sort();
    outcome.book_status_ids.dedup();
    outcome.thread_ids.sort();
    outcome.thread_ids.dedup();
    Ok(outcome)
}

pub async fn run_sync(app: &AppHandle, pool: &SqlitePool, config: &WebdavConfig) -> Result<SyncRunResult, String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let mut state = super::backup::read_sync_state(&config_dir);
    let device_id = ensure_device_id(&config_dir, &mut state)?;

    // 坚果云等 WebDAV 不允许 PUT 到不存在的父目录，先确保 L2 目录树就位
    webdav::ensure_remote_dirs(
        config,
        &[
            L2_ROOT.to_string(),
            format!("{L2_ROOT}/changesets"),
            format!("{L2_ROOT}/changesets/{device_id}"),
            format!("{L2_ROOT}/devices"),
        ],
    )
    .await?;

    // 设备登记（协议 §3）：无论有无变更，每轮都把自己 upsert 进 devices.json——
    // 纯拉取设备也必须可被对端发现，否则"发现新 peer 就全量引导"永远触发不到它
    upsert_devices_index(config, &device_id, state.last_pushed_seq.unwrap_or(0)).await?;

    // 首次全量引导（协议 §11 2c）：触发器建立前的存量行回填进 _sync_log，随后走正常推送
    if state.bootstrapped_at.is_none() {
        let dumped = emit_bootstrap_dump(pool).await?;
        state.bootstrapped_at = Some(now_ms());
        // 立即持久化，避免后续网络失败导致下轮重复回填
        super::backup::write_sync_state(&config_dir, &state)?;
        log::info!("首次全量引导：回填 {dumped} 行存量到变更日志");
    }

    // ---- 推送：本地变更打包上传 ----
    let mut pushed_rows = 0;
    if let Some(packed) = changelog::pack_changes(pool, &device_id, &app_version(app), state.last_pushed_seq.unwrap_or(0)).await? {
        let name = format!("{:010}.jsonl", packed.seq_to);
        put_path_atomic(
            config,
            &format!("{L2_ROOT}/changesets/{device_id}/{name}"),
            packed.jsonl.into_bytes(),
        )
        .await?;

        let mut pointer = read_pointer(config, &device_id).await?;
        pointer.device_id = device_id.clone();
        pointer.latest_seq = packed.seq_to;
        pointer.last_online = now_ms();
        pointer.changesets.push(ChangesetEntry {
            seq_end: packed.seq_to,
            created_at: now_ms(),
        });
        write_pointer(config, &pointer).await?;
        upsert_devices_index(config, &device_id, packed.seq_to).await?;

        state.last_pushed_seq = Some(packed.seq_to);
        pushed_rows = packed.row_count;

        // 推送成功后修剪：本地日志保留窗口 + 云端已消费 changesets（失败只记 warn 不影响主流程）
        if let Err(e) = prune_local_log(pool, packed.seq_to).await {
            log::warn!("本地日志修剪失败（忽略）: {e}");
        }
        prune_remote_changesets(config, &device_id).await;
    }

    // ---- 书籍文件自动上传（静默，失败只 warn） ----
    {
        let app_data_dir = app.path().app_data_dir().ok();
        if let Some(app_data_dir) = app_data_dir {
            match files::find_unuploaded_books(config, pool, &app_data_dir).await {
                Ok(unuploaded) => {
                    for (book_id, title, src, format) in unuploaded {
                        if let Err(e) =
                            files::upload_book(config, &app_data_dir, &device_id, &book_id, &src, &title, &format)
                                .await
                        {
                            log::warn!("书籍文件自动上传失败（忽略）: {title}: {e}");
                        }
                    }
                }
                Err(e) => log::warn!("查询未上传书籍失败（忽略）: {e}"),
            }
        }
    }

    // ---- 资产（字体/背景图）自动上传（静默，失败只 warn） ----
    let mut fonts_downloaded = 0usize;
    let mut backgrounds_downloaded = 0usize;
    {
        let app_data_dir = app.path().app_data_dir().ok();
        let config_dir_opt = app.path().app_config_dir().ok();
        if let (Some(app_data_dir), Some(config_dir)) = (app_data_dir, config_dir_opt) {
            if let Err(e) = assets::upload_missing_assets(config, &app_data_dir, &config_dir, &device_id).await {
                log::warn!("资产自动上传失败（忽略）: {e}");
            }
        }
    }

    // ---- 拉取：应用其他设备的 changesets ----
    let pulled = pull_from_devices(app, pool, config, &device_id, &mut state).await?;

    // ---- 资产（字体/背景图）下载（静默，失败只 warn） ----
    {
        let app_data_dir = app.path().app_data_dir().ok();
        let config_dir_opt = app.path().app_config_dir().ok();
        if let (Some(app_data_dir), Some(config_dir)) = (app_data_dir, config_dir_opt) {
            match assets::download_missing_assets(config, &app_data_dir, &config_dir).await {
                Ok((fonts, backgrounds)) => {
                    fonts_downloaded = fonts;
                    backgrounds_downloaded = backgrounds;
                }
                Err(e) => log::warn!("资产下载失败（忽略）: {e}"),
            }
        }
    }

    state.last_l2_sync_at = Some(now_ms());
    // 结果语义化：推送/拉取分述，双零时说明无新变更
    let mut message = match (pushed_rows, pulled.count) {
        (0, 0) => "无新变更".to_string(),
        _ => {
            let mut parts = Vec::new();
            if pushed_rows > 0 {
                parts.push(format!("推送 {pushed_rows} 条"));
            }
            if pulled.count > 0 {
                parts.push(format!("拉取应用 {} 条", pulled.count));
            }
            parts.join("，")
        }
    };
    if pulled.count > 0 {
        message = format!("{message}（进度 {} 本 / 对话 {} 个）", pulled.book_status_ids.len(), pulled.thread_ids.len());
    }
    state.last_l2_result = Some(message.clone());
    super::backup::write_sync_state(&config_dir, &state)?;

    Ok(SyncRunResult {
        status: "ok".to_string(),
        message,
        pushed_rows,
        pulled_rows: pulled.count,
        book_status_ids: pulled.book_status_ids,
        thread_ids: pulled.thread_ids,
        books_changed: pulled.books_changed,
        notes_changed: pulled.notes_changed,
        fonts_downloaded,
        backgrounds_downloaded,
    })
}

/// 只拉不推：打开书时的单点快拉（前端带超时调用，超时/失败静默放行本地）
pub async fn run_pull_only(app: &AppHandle, pool: &SqlitePool, config: &WebdavConfig) -> Result<SyncRunResult, String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let mut state = super::backup::read_sync_state(&config_dir);
    let device_id = ensure_device_id(&config_dir, &mut state)?;

    // 设备登记（协议 §3）：纯拉取轮同样每轮写 devices.json（latest_seq 可为 0），
    // 否则新设备对老设备的"发现新 peer 就全量引导"不可见；先确保云端目录存在
    webdav::ensure_remote_dirs(config, &[L2_ROOT.to_string(), format!("{L2_ROOT}/devices")]).await?;
    upsert_devices_index(config, &device_id, state.last_pushed_seq.unwrap_or(0)).await?;

    let pulled = pull_from_devices(app, pool, config, &device_id, &mut state).await?;

    state.last_l2_sync_at = Some(now_ms());
    let message = if pulled.count == 0 {
        "远端无新变更".to_string()
    } else {
        format!(
            "拉取应用 {} 条（进度 {} 本 / 对话 {} 个）",
            pulled.count,
            pulled.book_status_ids.len(),
            pulled.thread_ids.len()
        )
    };
    state.last_l2_result = Some(message.clone());
    super::backup::write_sync_state(&config_dir, &state)?;

    Ok(SyncRunResult {
        status: "ok".to_string(),
        message,
        pushed_rows: 0,
        pulled_rows: pulled.count,
        book_status_ids: pulled.book_status_ids,
        thread_ids: pulled.thread_ids,
        books_changed: pulled.books_changed,
        notes_changed: pulled.notes_changed,
        fonts_downloaded: 0,
        backgrounds_downloaded: 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 建内存测试库：_sync_log + threads + notes + 触发器（与迁移同构）
    async fn setup_pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();

        sqlx::query(
            "CREATE TABLE _sync_log (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                table_name TEXT NOT NULL,
                row_id TEXT NOT NULL,
                op TEXT NOT NULL,
                at INTEGER NOT NULL
            )",
        )
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query(
            "CREATE TABLE threads (
                id TEXT PRIMARY KEY NOT NULL,
                book_id TEXT,
                metadata TEXT NOT NULL,
                title TEXT NOT NULL,
                messages TEXT NOT NULL,
                starred INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )",
        )
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query(
            "CREATE TABLE notes (
                id TEXT PRIMARY KEY NOT NULL,
                book_id TEXT,
                book_meta TEXT,
                title TEXT,
                content TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )",
        )
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query(
            "CREATE TABLE book_status (
                book_id TEXT PRIMARY KEY NOT NULL,
                status TEXT NOT NULL DEFAULT 'unread',
                progress_current INTEGER DEFAULT 0,
                progress_total INTEGER DEFAULT 0,
                location TEXT,
                last_read_at INTEGER,
                position_changed_at INTEGER,
                dwell_seconds INTEGER DEFAULT 0,
                started_at INTEGER,
                completed_at INTEGER,
                metadata TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )",
        )
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query(
            "CREATE TABLE books (
                id TEXT PRIMARY KEY NOT NULL,
                title TEXT,
                author TEXT,
                format TEXT,
                file_path TEXT,
                cover_path TEXT,
                file_size INTEGER,
                language TEXT,
                tags TEXT,
                trashed_at INTEGER,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )",
        )
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query(
            "CREATE TABLE book_notes (
                id TEXT PRIMARY KEY NOT NULL,
                book_id TEXT,
                type TEXT,
                cfi TEXT,
                text TEXT,
                style TEXT,
                color TEXT,
                note TEXT,
                context_before TEXT,
                context_after TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )",
        )
        .execute(&pool)
        .await
        .unwrap();

        for (table, pk) in [("threads", "id"), ("notes", "id"), ("book_status", "book_id"), ("books", "id"), ("book_notes", "id")] {
            for (suffix, op, key) in [
                ("ai", "INSERT", format!("NEW.{pk}")),
                ("au", "UPDATE", format!("NEW.{pk}")),
                ("ad", "DELETE", format!("OLD.{pk}")),
            ] {
                let sql = format!(
                    "CREATE TRIGGER _sync_{table}_{suffix} AFTER {op} ON {table} BEGIN
                        INSERT INTO _sync_log (table_name, row_id, op, at)
                        VALUES ('{table}', {key}, '{op}', 0);
                    END"
                );
                sqlx::query(&sql).execute(&pool).await.unwrap();
            }
        }

        pool
    }

    fn note_row(id: &str, title: &str, updated_at: i64) -> ChangeRow {
        ChangeRow {
            table: "notes".to_string(),
            id: id.to_string(),
            op: "UPDATE".to_string(),
            updated_at,
            data: Some(serde_json::json!({
                "id": id,
                "book_id": null,
                "book_meta": null,
                "title": title,
                "content": "内容",
                "created_at": 1000,
                "updated_at": updated_at,
            })),
        }
    }

    fn changeset_bytes(rows: &[ChangeRow]) -> Vec<u8> {
        let mut jsonl = r#"{"header":{"protocol":1,"device_id":"dev-b","seq_from":1,"seq_to":10,"created_at":0,"app_version":"0"}}"#.to_string();
        for row in rows {
            jsonl.push('\n');
            jsonl.push_str(&serde_json::to_string(row).unwrap());
        }
        jsonl.into_bytes()
    }

    async fn note_title(pool: &SqlitePool, id: &str) -> Option<String> {
        sqlx::query("SELECT title FROM notes WHERE id = ?")
            .bind(id)
            .fetch_optional(pool)
            .await
            .unwrap()
            .map(|r| r.get("title"))
    }

    async fn log_count(pool: &SqlitePool) -> i64 {
        sqlx::query("SELECT COUNT(*) as c FROM _sync_log")
            .fetch_one(pool)
            .await
            .unwrap()
            .get("c")
    }

    #[tokio::test]
    async fn test_lww_insert_and_older_loses() {
        let pool = setup_pool().await;

        // 远端新行 → 插入
        let applied = apply_changeset(&pool, &changeset_bytes(&[note_row("n1", "远端标题", 2000)]))
            .await
            .unwrap();
        assert_eq!(applied.count, 1);
        assert_eq!(note_title(&pool, "n1").await.as_deref(), Some("远端标题"));

        // 远端更旧 → 本地保留
        sqlx::query("UPDATE notes SET title = '本地标题', updated_at = 3000 WHERE id = 'n1'")
            .execute(&pool)
            .await
            .unwrap();
        let applied2 = apply_changeset(&pool, &changeset_bytes(&[note_row("n1", "旧的远端", 1000)]))
            .await
            .unwrap();
        assert_eq!(applied2.count, 0);
        assert_eq!(note_title(&pool, "n1").await.as_deref(), Some("本地标题"));
    }

    #[tokio::test]
    async fn test_tombstone_vs_recreate() {
        let pool = setup_pool().await;

        // 本地有行（updated_at=2000）
        sqlx::query("INSERT INTO notes (id, title, content, created_at, updated_at) VALUES ('n1', '本地', 'x', 1000, 2000)")
            .execute(&pool)
            .await
            .unwrap();

        // 远端墓碑（updated_at=3000 更新）→ 删除
        let tombstone = ChangeRow {
            table: "notes".to_string(),
            id: "n1".to_string(),
            op: "DELETE".to_string(),
            updated_at: 3000,
            data: None,
        };
        apply_changeset(&pool, &changeset_bytes(&[tombstone])).await.unwrap();
        assert_eq!(note_title(&pool, "n1").await, None);

        // 远端重建（updated_at=4000 更新）→ 墓碑输，行回来
        apply_changeset(&pool, &changeset_bytes(&[note_row("n1", "重建", 4000)]))
            .await
            .unwrap();
        assert_eq!(note_title(&pool, "n1").await.as_deref(), Some("重建"));

        // 远端墓碑更旧（updated_at=1000）→ 本地保留
        let old_tombstone = ChangeRow {
            table: "notes".to_string(),
            id: "n1".to_string(),
            op: "DELETE".to_string(),
            updated_at: 1000,
            data: None,
        };
        apply_changeset(&pool, &changeset_bytes(&[old_tombstone])).await.unwrap();
        assert_eq!(note_title(&pool, "n1").await.as_deref(), Some("重建"));
    }

    #[tokio::test]
    async fn test_anti_loop_and_idempotent_replay() {
        let pool = setup_pool().await;

        // 应用远端变更后，防回环应把触发器写出的日志删掉
        let applied = apply_changeset(&pool, &changeset_bytes(&[note_row("n1", "远端", 2000)]))
            .await
            .unwrap();
        assert_eq!(applied.count, 1);
        assert_eq!(log_count(&pool).await, 0, "应用写出的日志应被防回环删除");

        // 重放同一包：LWW 相等不赢 → 零应用、零日志（幂等）
        let applied2 = apply_changeset(&pool, &changeset_bytes(&[note_row("n1", "远端", 2000)]))
            .await
            .unwrap();
        assert_eq!(applied2.count, 0);
        assert_eq!(log_count(&pool).await, 0);
    }

    #[tokio::test]
    async fn test_thread_merge_apply() {
        let pool = setup_pool().await;

        // 本地有一问
        sqlx::query(
            "INSERT INTO threads (id, title, metadata, messages, starred, created_at, updated_at)
             VALUES ('t1', '对话', '{}', '[{\"id\":\"a\",\"role\":\"user\",\"parts\":[],\"metadata\":{\"createdAt\":100,\"updatedAt\":100}}]', 0, 100, 200)",
        )
        .execute(&pool)
        .await
        .unwrap();

        // 远端同对话多一答（updated_at 更大）
        let remote = ChangeRow {
            table: "threads".to_string(),
            id: "t1".to_string(),
            op: "UPDATE".to_string(),
            updated_at: 300,
            data: Some(serde_json::json!({
                "id": "t1",
                "book_id": null,
                "metadata": "{}",
                "title": "对话",
                "messages": "[{\"id\":\"a\",\"role\":\"user\",\"parts\":[],\"metadata\":{\"createdAt\":100,\"updatedAt\":100}},{\"id\":\"b\",\"role\":\"assistant\",\"parts\":[],\"metadata\":{\"createdAt\":250,\"updatedAt\":250}}]",
                "starred": 0,
                "created_at": 100,
                "updated_at": 300,
            })),
        };
        let applied = apply_changeset(&pool, &changeset_bytes(&[remote])).await.unwrap();
        assert_eq!(applied.count, 1);

        let row = sqlx::query("SELECT messages FROM threads WHERE id = 't1'")
            .fetch_one(&pool)
            .await
            .unwrap();
        let messages: String = row.get("messages");
        let parsed: Vec<Value> = serde_json::from_str(&messages).unwrap();
        assert_eq!(parsed.len(), 2, "消息应并集合并");
        assert_eq!(parsed[1]["id"].as_str().unwrap(), "b");

        // 重放：合并结果与本地一致 → 幂等零应用
        let remote2 = ChangeRow {
            table: "threads".to_string(),
            id: "t1".to_string(),
            op: "UPDATE".to_string(),
            updated_at: 300,
            data: Some(serde_json::json!({
                "id": "t1",
                "book_id": null,
                "metadata": "{}",
                "title": "对话",
                "messages": "[{\"id\":\"a\",\"role\":\"user\",\"parts\":[],\"metadata\":{\"createdAt\":100,\"updatedAt\":100}},{\"id\":\"b\",\"role\":\"assistant\",\"parts\":[],\"metadata\":{\"createdAt\":250,\"updatedAt\":250}}]",
                "starred": 0,
                "created_at": 100,
                "updated_at": 300,
            })),
        };
        let applied2 = apply_changeset(&pool, &changeset_bytes(&[remote2])).await.unwrap();
        assert_eq!(applied2.count, 0);
    }

    fn status_row(book_id: &str, last_read_at: i64, position_changed_at: Option<i64>, location: &str) -> ChangeRow {
        ChangeRow {
            table: "book_status".to_string(),
            id: book_id.to_string(),
            op: "UPDATE".to_string(),
            updated_at: position_changed_at.unwrap_or(last_read_at),
            data: Some(serde_json::json!({
                "book_id": book_id,
                "status": "reading",
                "progress_current": 50,
                "progress_total": 100,
                "location": location,
                "last_read_at": last_read_at,
                "position_changed_at": position_changed_at,
                "dwell_seconds": 0,
                "started_at": null,
                "completed_at": null,
                "metadata": null,
                "created_at": 1000,
                "updated_at": position_changed_at.unwrap_or(last_read_at),
            })),
        }
    }

    async fn status_location(pool: &SqlitePool, book_id: &str) -> Option<String> {
        sqlx::query("SELECT location FROM book_status WHERE book_id = ?")
            .bind(book_id)
            .fetch_optional(pool)
            .await
            .unwrap()
            .map(|r| r.get("location"))
    }

    #[tokio::test]
    async fn test_book_status_merge_position_changed_at_wins() {
        let pool = setup_pool().await;

        // 本地真进度 position_changed_at=2000
        sqlx::query(
            "INSERT INTO book_status (book_id, status, progress_current, progress_total, location, last_read_at, position_changed_at, dwell_seconds, created_at, updated_at)
             VALUES ('b1', 'reading', 10, 100, 'cfi-old', 5000, 2000, 0, 1000, 5000)",
        )
        .execute(&pool)
        .await
        .unwrap();

        // 远端 position_changed_at=3000 更大 → 采用远端位置
        let applied = apply_changeset(&pool, &changeset_bytes(&[status_row("b1", 3000, Some(3000), "cfi-remote")]))
            .await
            .unwrap();
        assert_eq!(applied.count, 1);
        assert_eq!(status_location(&pool, "b1").await.as_deref(), Some("cfi-remote"));

        // 远端 position_changed_at=1000 更旧 → 本地保留
        let applied2 = apply_changeset(&pool, &changeset_bytes(&[status_row("b1", 1000, Some(1000), "cfi-stale")]))
            .await
            .unwrap();
        assert_eq!(applied2.count, 0);
        assert_eq!(status_location(&pool, "b1").await.as_deref(), Some("cfi-remote"));
    }

    #[tokio::test]
    async fn test_book_status_merge_null_fallback_last_read_at() {
        let pool = setup_pool().await;

        // 本地 position_changed_at=NULL，last_read_at=5000（旧库未回填场景）
        sqlx::query(
            "INSERT INTO book_status (book_id, status, progress_current, progress_total, location, last_read_at, position_changed_at, dwell_seconds, created_at, updated_at)
             VALUES ('b1', 'reading', 10, 100, 'cfi-old', 5000, NULL, 0, 1000, 5000)",
        )
        .execute(&pool)
        .await
        .unwrap();

        // 远端 position_changed_at=NULL 但 last_read_at=6000 → 按 last_read_at 比较，远端赢
        let applied = apply_changeset(&pool, &changeset_bytes(&[status_row("b1", 6000, None, "cfi-remote")]))
            .await
            .unwrap();
        assert_eq!(applied.count, 1);
        assert_eq!(status_location(&pool, "b1").await.as_deref(), Some("cfi-remote"));

        // 远端 last_read_at=4000 更旧 → 本地保留
        let applied2 = apply_changeset(&pool, &changeset_bytes(&[status_row("b1", 4000, None, "cfi-stale")]))
            .await
            .unwrap();
        assert_eq!(applied2.count, 0);
        assert_eq!(status_location(&pool, "b1").await.as_deref(), Some("cfi-remote"));
    }

    /// books / notes / book_notes 实际变更时置对应信号；无实际变更（重放幂等）时不置
    #[tokio::test]
    async fn test_books_notes_changed_flags() {
        let pool = setup_pool().await;

        // notes 实际变更 → notes_changed=true，books_changed=false
        let outcome = apply_changeset(&pool, &changeset_bytes(&[note_row("n1", "远端", 2000)]))
            .await
            .unwrap();
        assert!(outcome.notes_changed);
        assert!(!outcome.books_changed);

        // 重放无实际变更 → 两个信号都为 false
        let outcome = apply_changeset(&pool, &changeset_bytes(&[note_row("n1", "远端", 2000)]))
            .await
            .unwrap();
        assert_eq!(outcome.count, 0);
        assert!(!outcome.notes_changed);
        assert!(!outcome.books_changed);

        // books 实际变更 → books_changed=true，notes_changed=false
        let book = ChangeRow {
            table: "books".to_string(),
            id: "b1".to_string(),
            op: "UPDATE".to_string(),
            updated_at: 2000,
            data: Some(serde_json::json!({
                "id": "b1",
                "title": "书",
                "author": null,
                "format": "epub",
                "file_path": "/x.epub",
                "cover_path": null,
                "file_size": 1,
                "language": null,
                "tags": null,
                "trashed_at": null,
                "created_at": 1000,
                "updated_at": 2000,
            })),
        };
        let outcome = apply_changeset(&pool, &changeset_bytes(&[book])).await.unwrap();
        assert!(outcome.books_changed);
        assert!(!outcome.notes_changed);

        // book_notes 实际变更 → notes_changed=true
        let book_note = ChangeRow {
            table: "book_notes".to_string(),
            id: "bn1".to_string(),
            op: "UPDATE".to_string(),
            updated_at: 2000,
            data: Some(serde_json::json!({
                "id": "bn1",
                "book_id": "b1",
                "type": "highlight",
                "cfi": "epubcfi(/6/2)",
                "text": "划线",
                "style": null,
                "color": "yellow",
                "note": null,
                "context_before": null,
                "context_after": null,
                "created_at": 1000,
                "updated_at": 2000,
            })),
        };
        let outcome = apply_changeset(&pool, &changeset_bytes(&[book_note])).await.unwrap();
        assert!(outcome.notes_changed);
        assert!(!outcome.books_changed);
    }

    #[tokio::test]
    async fn test_book_status_merge_changed_ids_reported() {
        let pool = setup_pool().await;

        // 远端新书进度 → 应用且变更 id 被报告
        let outcome = apply_changeset(&pool, &changeset_bytes(&[status_row("b1", 3000, Some(3000), "cfi-remote")]))
            .await
            .unwrap();
        assert_eq!(outcome.count, 1);
        assert_eq!(outcome.book_status_ids, vec!["b1".to_string()]);
    }

    #[tokio::test]
    async fn test_has_unpushed() {
        let pool = setup_pool().await;

        // 空日志：无未推送变更
        assert!(!has_unpushed(&pool, 0).await.unwrap());

        // 写入一行触发日志（触发器产生 seq=1）
        sqlx::query("INSERT INTO notes (id, title, content, created_at, updated_at) VALUES ('n1', 't', 'c', 1000, 1000)")
            .execute(&pool)
            .await
            .unwrap();
        assert!(has_unpushed(&pool, 0).await.unwrap(), "seq=1 > 0 应为有变更");
        assert!(!has_unpushed(&pool, 1).await.unwrap(), "seq=1 <= 1 应为无变更");
    }

    #[tokio::test]
    async fn test_prune_local_log_boundary() {
        let pool = setup_pool().await;

        // 造 150 条日志（150 次写入）
        for i in 0..150 {
            sqlx::query("INSERT INTO notes (id, title, content, created_at, updated_at) VALUES (?, 't', 'c', 1000, 1000)")
                .bind(format!("n{i}"))
                .execute(&pool)
                .await
                .unwrap();
        }
        assert_eq!(log_count(&pool).await, 150);

        // 推送水位 150 后修剪：应保留 seq >= 50（150 - 100）
        prune_local_log(&pool, 150).await.unwrap();
        assert_eq!(log_count(&pool).await, 101, "应保留 seq 50..=150 共 101 行");

        let min_seq: i64 = sqlx::query("SELECT MIN(seq) as m FROM _sync_log")
            .fetch_one(&pool)
            .await
            .unwrap()
            .get("m");
        assert_eq!(min_seq, 50);
    }

    #[test]
    fn test_compute_prune_candidates() {
        // min_pulled=60：10..50 全被消费 → 删；60..100 保留
        let seq_ends: Vec<i64> = (10..=100).step_by(10).collect();
        let candidates = compute_prune_candidates(&seq_ends, 60);
        assert_eq!(candidates, vec![10, 20, 30, 40, 50]);

        // 最近 5 个永不删：min_pulled=1000（全部已消费）也只删到倒数第 5 个之前
        let candidates2 = compute_prune_candidates(&seq_ends, 1000);
        assert_eq!(candidates2, vec![10, 20, 30, 40, 50]);

        // 超出最近 50 个的兜底：60 个连续 seq，min_pulled=0（有设备长期离线）
        let many: Vec<i64> = (1..=60).collect();
        let candidates3 = compute_prune_candidates(&many, 0);
        assert_eq!(candidates3, (1..=10).collect::<Vec<i64>>(), "应删掉最老的 10 个，保留最近 50 个");

        // 兜底与消费规则交集：min_pulled 较大时两种原因都算
        let candidates4 = compute_prune_candidates(&many, 55);
        // 1..=10 超 50 兜底必删；11..=50 已消费但不在最近 5 → 删；51..=55 已消费且属最近 10 但仍在最近 50 内
        // 最近 5 = 56..=60 保留；55 不小于 min_pulled(55) → 保留
        assert_eq!(candidates4, (1..=54).collect::<Vec<i64>>(), "55 不小于 55，保留");
    }

    #[test]
    fn test_min_pulled_for() {
        let mut p_a = DevicePointer {
            device_id: "a".to_string(),
            ..Default::default()
        };
        p_a.pulled.insert("me".to_string(), 100);
        let mut p_b = DevicePointer {
            device_id: "b".to_string(),
            ..Default::default()
        };
        p_b.pulled.insert("me".to_string(), 40);
        let p_me = DevicePointer {
            device_id: "me".to_string(),
            ..Default::default()
        };

        // 其他设备对 "me" 的最低水位 = 40；自身不计入
        assert_eq!(min_pulled_for("me", &[p_a.clone(), p_b.clone(), p_me]), 40);
        // 某设备缺水位记录按 0（保守不删）
        let p_c = DevicePointer {
            device_id: "c".to_string(),
            ..Default::default()
        };
        assert_eq!(min_pulled_for("me", &[p_a, p_b, p_c]), 0);
        // 没有其他设备 → 0
        assert_eq!(min_pulled_for("me", &[]), 0);
    }

    async fn table_count(pool: &SqlitePool, table: &str) -> i64 {
        sqlx::query(&format!("SELECT COUNT(*) as c FROM {table}"))
            .fetch_one(pool)
            .await
            .unwrap()
            .get("c")
    }

    /// 引导测试库：8 张同步表 + _sync_log（与线上一致的 FK），seed=true 时先插存量再建触发器
    /// （模拟"迁移前已有数据"——这些行靠触发器永远进不了 changeset）
    async fn bootstrap_pool(seed: bool) -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();

        for ddl in [
            "CREATE TABLE books (
                id TEXT PRIMARY KEY NOT NULL,
                title TEXT NOT NULL,
                author TEXT NOT NULL,
                format TEXT NOT NULL,
                file_path TEXT NOT NULL,
                cover_path TEXT,
                file_size INTEGER NOT NULL,
                language TEXT NOT NULL,
                tags TEXT,
                trashed_at INTEGER,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )",
            "CREATE TABLE book_status (
                book_id TEXT PRIMARY KEY NOT NULL,
                status TEXT NOT NULL DEFAULT 'unread',
                progress_current INTEGER DEFAULT 0,
                progress_total INTEGER DEFAULT 0,
                location TEXT,
                last_read_at INTEGER,
                position_changed_at INTEGER,
                dwell_seconds INTEGER DEFAULT 0,
                started_at INTEGER,
                completed_at INTEGER,
                metadata TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
            )",
            "CREATE TABLE book_notes (
                id TEXT PRIMARY KEY NOT NULL,
                book_id TEXT NOT NULL,
                type TEXT NOT NULL,
                cfi TEXT NOT NULL,
                text TEXT,
                style TEXT,
                color TEXT,
                note TEXT NOT NULL,
                context_before TEXT,
                context_after TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
            )",
            "CREATE TABLE notes (
                id TEXT PRIMARY KEY NOT NULL,
                book_id TEXT,
                book_meta TEXT,
                title TEXT,
                content TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE SET NULL
            )",
            "CREATE TABLE threads (
                id TEXT PRIMARY KEY NOT NULL,
                book_id TEXT,
                metadata TEXT NOT NULL,
                title TEXT NOT NULL,
                messages TEXT NOT NULL,
                starred INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
            )",
            "CREATE TABLE reading_sessions (
                id TEXT PRIMARY KEY NOT NULL,
                book_id TEXT NOT NULL,
                started_at INTEGER NOT NULL,
                ended_at INTEGER,
                duration_seconds INTEGER DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
            )",
            "CREATE TABLE skills (
                id TEXT PRIMARY KEY NOT NULL,
                name TEXT NOT NULL UNIQUE,
                content TEXT NOT NULL,
                is_active INTEGER DEFAULT 1,
                is_system INTEGER DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )",
            "CREATE TABLE tags (
                id TEXT PRIMARY KEY NOT NULL,
                name TEXT NOT NULL UNIQUE,
                color TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )",
            "CREATE TABLE _sync_log (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                table_name TEXT NOT NULL,
                row_id TEXT NOT NULL,
                op TEXT NOT NULL,
                at INTEGER NOT NULL
            )",
        ] {
            sqlx::query(ddl).execute(&pool).await.unwrap();
        }

        if seed {
            for seed_sql in [
                "INSERT INTO books (id, title, author, format, file_path, file_size, language, trashed_at, created_at, updated_at) VALUES
                    ('b1', '书一', '作者', 'EPUB', 'books/b1/book.epub', 100, 'zh', NULL, 1000, 1000),
                    ('b2', '回收站的书', '作者', 'EPUB', 'books/b2/book.epub', 200, 'zh', 123, 1000, 1000)",
                "INSERT INTO book_status (book_id, status, created_at, updated_at) VALUES ('b1', 'reading', 1000, 1000)",
                "INSERT INTO book_notes (id, book_id, type, cfi, note, created_at, updated_at) VALUES ('bn1', 'b1', 'highlight', 'epubcfi(/6/2)', '批注', 1000, 1000)",
                "INSERT INTO notes (id, book_id, title, content, created_at, updated_at) VALUES ('n1', 'b1', '笔记', '内容', 1000, 1000)",
                "INSERT INTO threads (id, book_id, metadata, title, messages, starred, created_at, updated_at) VALUES ('t1', 'b1', '{}', '对话', '[]', 0, 1000, 1000)",
                "INSERT INTO reading_sessions (id, book_id, started_at, duration_seconds, created_at, updated_at) VALUES ('s1', 'b1', 1000, 60, 1000, 1000)",
                "INSERT INTO skills (id, name, content, is_active, is_system, created_at, updated_at) VALUES ('sk1', '技能', '内容', 1, 0, 1000, 1000)",
                "INSERT INTO tags (id, name, color, created_at, updated_at) VALUES ('tg1', '标签', '#fff', 1000, 1000)",
            ] {
                sqlx::query(seed_sql).execute(&pool).await.unwrap();
            }
        }

        // 触发器（迁移同构）：seed 之后建，存量行不产生日志
        for (table, pk) in [
            ("books", "id"),
            ("book_status", "book_id"),
            ("book_notes", "id"),
            ("notes", "id"),
            ("threads", "id"),
            ("reading_sessions", "id"),
            ("skills", "id"),
            ("tags", "id"),
        ] {
            for (suffix, op, key) in [
                ("ai", "INSERT", format!("NEW.{pk}")),
                ("au", "UPDATE", format!("NEW.{pk}")),
                ("ad", "DELETE", format!("OLD.{pk}")),
            ] {
                let sql = format!(
                    "CREATE TRIGGER _sync_{table}_{suffix} AFTER {op} ON {table} BEGIN
                        INSERT INTO _sync_log (table_name, row_id, op, at)
                        VALUES ('{table}', {key}, '{op}', 0);
                    END"
                );
                sqlx::query(&sql).execute(&pool).await.unwrap();
            }
        }

        pool
    }

    /// 存量回填引导：存量行全保真打包，对端空库整体应用（含 FK 延迟校验，无静默丢数据）
    #[tokio::test]
    async fn test_bootstrap_dump_applies_to_empty_device() {
        let src = bootstrap_pool(true).await;

        // 存量不产生日志：触发器建立前的行对 changeset 不可见
        assert_eq!(log_count(&src).await, 0);
        assert!(!has_unpushed(&src, 0).await.unwrap());

        // 引导回填：8 张表 9 行全部进日志
        let dumped = emit_bootstrap_dump(&src).await.unwrap();
        assert_eq!(dumped, 9);
        assert!(has_unpushed(&src, 0).await.unwrap());

        // 打包：每行一条（含回收站的书 b2）
        let packed = changelog::pack_changes(&src, "dev-a", "0.0.0", 0)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(packed.row_count, 9);

        // 对端空库应用：book_notes/book_status 排序在 books 前，靠 FK 延迟校验整包落库
        let dst = bootstrap_pool(false).await;
        let outcome = apply_changeset(&dst, packed.jsonl.as_bytes()).await.unwrap();
        assert_eq!(outcome.count, 9, "全量包应整体应用，无 FK 静默丢数据");

        assert_eq!(table_count(&dst, "books").await, 2, "含回收站行全保真");
        assert_eq!(table_count(&dst, "reading_sessions").await, 1);
        assert_eq!(table_count(&dst, "book_notes").await, 1);
        assert_eq!(table_count(&dst, "book_status").await, 1);
        assert_eq!(table_count(&dst, "threads").await, 1);
        assert_eq!(table_count(&dst, "notes").await, 1);
        assert_eq!(table_count(&dst, "skills").await, 1);
        assert_eq!(table_count(&dst, "tags").await, 1);
        assert_eq!(log_count(&dst).await, 0, "应用侧防回环应清掉日志");
    }

    fn book_row(id: &str, updated_at: i64) -> ChangeRow {
        ChangeRow {
            table: "books".to_string(),
            id: id.to_string(),
            op: "INSERT".to_string(),
            updated_at,
            data: Some(serde_json::json!({
                "id": id,
                "title": "书",
                "author": "作者",
                "format": "EPUB",
                "file_path": format!("books/{id}/book.epub"),
                "cover_path": null,
                "file_size": 100,
                "language": "zh",
                "tags": null,
                "trashed_at": null,
                "created_at": 1000,
                "updated_at": updated_at,
            })),
        }
    }

    fn session_row(id: &str, book_id: &str, updated_at: i64) -> ChangeRow {
        ChangeRow {
            table: "reading_sessions".to_string(),
            id: id.to_string(),
            op: "INSERT".to_string(),
            updated_at,
            data: Some(serde_json::json!({
                "id": id,
                "book_id": book_id,
                "started_at": 1000,
                "ended_at": null,
                "duration_seconds": 60,
                "created_at": 1000,
                "updated_at": updated_at,
            })),
        }
    }

    /// 完整链路：B 空白（无变更可推）→ 登记进 devices.json → A 发现新 peer → dump+推 → B 收到全量
    #[tokio::test]
    async fn test_device_registration_and_bootstrap_chain() {
        // B 空白：无任何可推变更——若登记只在推送分支，B 永远进不了 devices.json（漏洞 1 前置）
        let b = bootstrap_pool(false).await;
        assert!(!has_unpushed(&b, 0).await.unwrap());
        assert!(changelog::pack_changes(&b, "dev-b", "0.0.0", 0).await.unwrap().is_none(), "B 无变更可推");

        // B 每轮登记（latest_seq 可为 0）→ 出现在索引里
        let mut index: HashMap<String, DeviceIndexEntry> = HashMap::new();
        register_in_index(&mut index, "dev-b", 0);
        assert_eq!(index.get("dev-b").map(|e| e.latest_seq), Some(0));

        // A 有存量：发现 B（不在 bootstrap_peers）→ dump 全量 → 打包
        let a = bootstrap_pool(true).await;
        let peers = new_bootstrap_peers(index.keys().cloned(), "dev-a", &[]);
        assert_eq!(peers, vec!["dev-b".to_string()], "A 应发现新设备 B");
        let dumped = emit_bootstrap_dump(&a).await.unwrap();
        assert_eq!(dumped, 9);
        // 已引导过的 peer 不再重复发现（防重复 dump）
        assert!(new_bootstrap_peers(index.keys().cloned(), "dev-a", &["dev-b".to_string()]).is_empty());
        // A 自身不出现在新 peer 列表
        let mut index_with_a = index.clone();
        register_in_index(&mut index_with_a, "dev-a", 42);
        assert_eq!(new_bootstrap_peers(index_with_a.keys().cloned(), "dev-a", &["dev-b".to_string()]), Vec::<String>::new());

        let packed = changelog::pack_changes(&a, "dev-a", "0.0.0", 0)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(packed.row_count, 9);

        // B 拉到全量：8 表齐全、无 FK 错误
        let outcome = apply_changeset(&b, packed.jsonl.as_bytes()).await.unwrap();
        assert_eq!(outcome.count, 9);
        assert_eq!(outcome.books_count, 2, "books 应用条数可用于 B 端可见性日志");
        for (table, expected) in [
            ("books", 2),
            ("book_status", 1),
            ("book_notes", 1),
            ("notes", 1),
            ("threads", 1),
            ("reading_sessions", 1),
            ("skills", 1),
            ("tags", 1),
        ] {
            assert_eq!(table_count(&b, table).await, expected, "{table} 应收到全量");
        }
    }

    /// 乱序丢包：B 先拉到引用缺失书籍的 session 包（失败不计水位、不跳过）→ 书籍包到达 → 重试成功
    #[tokio::test]
    async fn test_out_of_order_pack_retried_after_books_arrive() {
        let b = bootstrap_pool(false).await;
        let mut state = SyncState::default();

        // B 先拉到 session 包（引用的 books b1 还没到）→ 整包失败（FK 延迟到提交仍校验）
        let session_pack = changeset_bytes(&[session_row("s1", "b1", 2000)]);
        assert!(apply_changeset(&b, &session_pack).await.is_err(), "父行整库缺失应整包失败");

        // 失败处置：不推水位、未满 3 次不跳过（留下轮重试）
        assert!(!note_pack_failure(&mut state, "dev-a", 10), "第 1 次失败不应跳过");
        assert!(!note_pack_failure(&mut state, "dev-a", 10), "第 2 次失败不应跳过");
        assert_eq!(state.last_pulled_of("dev-a"), 0, "失败包不推进水位");
        assert_eq!(state.failed_packs.get("dev-a/10"), Some(&2));

        // 书籍包到达 → 应用成功，水位推进
        let books_pack = changeset_bytes(&[book_row("b1", 1000)]);
        let outcome = apply_changeset(&b, &books_pack).await.unwrap();
        assert_eq!(outcome.count, 1);
        assert_eq!(outcome.books_count, 1);
        state.set_last_pulled("dev-a", 9);

        // 下轮重试 session 包 → 成功，清除失败记录
        let outcome = apply_changeset(&b, &session_pack).await.unwrap();
        assert_eq!(outcome.count, 1, "父行到达后重放应成功（幂等）");
        state.clear_pack_failure("dev-a", 10);
        assert!(state.failed_packs.is_empty());
        assert_eq!(table_count(&b, "reading_sessions").await, 1);

        // 3 次封顶：永久坏包满 3 次才跳过（推进水位）
        let mut state2 = SyncState::default();
        assert!(!note_pack_failure(&mut state2, "dev-a", 20));
        assert!(!note_pack_failure(&mut state2, "dev-a", 20));
        assert!(note_pack_failure(&mut state2, "dev-a", 20), "第 3 次失败应跳过并告警");
    }

    /// skills 跨设备同名冲突：本地已有同名默认技能（id 不同），对端同名义 INSERT 按 name 合并 UPDATE
    #[tokio::test]
    async fn test_skill_name_conflict_merges_by_name() {
        let pool = bootstrap_pool(false).await;

        // 本地初始化的默认技能（id 与对端不同、name 相同）
        sqlx::query("INSERT INTO skills (id, name, content, is_active, is_system, created_at, updated_at) VALUES ('local-sk', '生成思维导图', '旧内容', 1, 1, 1000, 2000)")
            .execute(&pool)
            .await
            .unwrap();
        // 模拟该技能此前已推送过（稳态）：清掉种子行自带的日志，后文才能断言防回环清零
        sqlx::query("DELETE FROM _sync_log").execute(&pool).await.unwrap();

        let remote = |id: &str, content: &str, updated_at: i64| ChangeRow {
            table: "skills".to_string(),
            id: id.to_string(),
            op: "INSERT".to_string(),
            updated_at,
            data: Some(serde_json::json!({
                "id": id,
                "name": "生成思维导图",
                "content": content,
                "is_active": 1,
                "is_system": 1,
                "created_at": 900,
                "updated_at": updated_at,
            })),
        };

        // 对端同名义 INSERT（updated_at 更新）→ 不报错，按 name 合并：内容取远端，id 保本地
        let outcome = apply_changeset(&pool, &changeset_bytes(&[remote("remote-sk", "新内容", 3000)]))
            .await
            .unwrap();
        assert_eq!(outcome.count, 1);
        assert_eq!(table_count(&pool, "skills").await, 1, "同名技能应合并为一行");
        let row = sqlx::query("SELECT id, content FROM skills WHERE name = '生成思维导图'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(row.get::<String, _>("id"), "local-sk");
        assert_eq!(row.get::<String, _>("content"), "新内容");
        assert_eq!(log_count(&pool).await, 0, "合并写出的日志应被防回环删除");

        // 远端更旧的同名义包 → LWW 不赢，跳过
        let outcome = apply_changeset(&pool, &changeset_bytes(&[remote("remote-sk", "更旧内容", 2500)]))
            .await
            .unwrap();
        assert_eq!(outcome.count, 0);
        let row = sqlx::query("SELECT content FROM skills WHERE name = '生成思维导图'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(row.get::<String, _>("content"), "新内容");

        // 重放同一包（updated_at 相等）→ 幂等零应用
        let outcome = apply_changeset(&pool, &changeset_bytes(&[remote("remote-sk", "新内容", 3000)]))
            .await
            .unwrap();
        assert_eq!(outcome.count, 0);

        // 无同名的新技能 INSERT → 正常插入
        let new_skill = ChangeRow {
            table: "skills".to_string(),
            id: "sk-new".to_string(),
            op: "INSERT".to_string(),
            updated_at: 4000,
            data: Some(serde_json::json!({
                "id": "sk-new",
                "name": "总结章节",
                "content": "内容",
                "is_active": 1,
                "is_system": 0,
                "created_at": 4000,
                "updated_at": 4000,
            })),
        };
        let outcome = apply_changeset(&pool, &changeset_bytes(&[new_skill])).await.unwrap();
        assert_eq!(outcome.count, 1);
        assert_eq!(table_count(&pool, "skills").await, 2);
    }
}
