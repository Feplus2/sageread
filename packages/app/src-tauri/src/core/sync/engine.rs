use super::changelog::{self, ChangeRow};
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
}

/// 单包应用结果：条数 + 分表变更 id
#[derive(Debug, Default)]
pub struct ApplyOutcome {
    pub count: usize,
    pub book_status_ids: Vec<String>,
    pub thread_ids: Vec<String>,
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

async fn upsert_devices_index(config: &WebdavConfig, device_id: &str, latest_seq: i64) -> Result<(), String> {
    let mut index = read_devices_index(config).await.unwrap_or_default();
    index.insert(
        device_id.to_string(),
        DeviceIndexEntry {
            latest_seq,
            last_online: now_ms(),
        },
    );
    let bytes = serde_json::to_vec_pretty(&index).map_err(|e| e.to_string())?;
    put_path_atomic(config, &format!("{L2_ROOT}/devices.json"), bytes).await
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
            _ => {}
        }
    }
    outcome.book_status_ids.sort();
    outcome.book_status_ids.dedup();
    outcome.thread_ids.sort();
    outcome.thread_ids.dedup();
    Ok(outcome)
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
                    outcome.count += applied.count;
                    outcome.book_status_ids.extend(applied.book_status_ids);
                    outcome.thread_ids.extend(applied.thread_ids);
                    state.set_last_pulled(remote_id, cs.seq_end);
                    watermark_changed = true;
                }
                Err(e) => {
                    log::error!("应用 changeset 失败（整包跳过并告警）: {path}: {e}");
                    state.set_last_pulled(remote_id, cs.seq_end);
                    watermark_changed = true;
                }
            }
        }

        state.set_last_pulled(remote_id, info.latest_seq.max(state.last_pulled_of(remote_id)));
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

    // ---- 拉取：应用其他设备的 changesets ----
    let pulled = pull_from_devices(app, pool, config, &device_id, &mut state).await?;

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
    })
}

/// 只拉不推：打开书时的单点快拉（前端带超时调用，超时/失败静默放行本地）
pub async fn run_pull_only(app: &AppHandle, pool: &SqlitePool, config: &WebdavConfig) -> Result<SyncRunResult, String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let mut state = super::backup::read_sync_state(&config_dir);
    let device_id = ensure_device_id(&config_dir, &mut state)?;

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

        for (table, pk) in [("threads", "id"), ("notes", "id"), ("book_status", "book_id")] {
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
}
