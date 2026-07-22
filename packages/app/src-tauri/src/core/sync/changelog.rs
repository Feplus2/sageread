use super::tables::{self, ColType};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sqlx::{Row, SqlitePool};
use std::collections::HashMap;

/// changeset 数据行（协议 §5）
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ChangeRow {
    pub table: String,
    pub id: String,
    pub op: String, // INSERT | UPDATE | DELETE
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

#[derive(Serialize)]
struct ChangesetHeader {
    protocol: u32,
    device_id: String,
    seq_from: i64,
    seq_to: i64,
    created_at: i64,
    app_version: String,
}

pub struct PackedChangeset {
    pub seq_from: i64,
    pub seq_to: i64,
    pub jsonl: String,
    pub row_count: usize,
}

struct LogEntry {
    seq: i64,
    table_name: String,
    row_id: String,
    op: String,
    at: i64,
}

/// 把整行读成 JSON（只含注册表里的已知列）
async fn fetch_row_json(pool: &SqlitePool, table: &tables::SyncTable, id: &str) -> Result<Option<Value>, String> {
    let columns = table
        .columns
        .iter()
        .map(|(name, _)| *name)
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!("SELECT {columns} FROM {} WHERE {} = ?", table.name, table.pk);
    let row = sqlx::query(&sql)
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("读取变更行失败: {e}"))?;

    let Some(row) = row else { return Ok(None) };

    let mut map = Map::new();
    for (name, col_type) in table.columns {
        let value = match col_type {
            ColType::Text => match row.try_get::<Option<String>, _>(*name) {
                Ok(v) => v.map(Value::from).unwrap_or(Value::Null),
                Err(_) => Value::Null,
            },
            ColType::Int => match row.try_get::<Option<i64>, _>(*name) {
                Ok(v) => v.map(Value::from).unwrap_or(Value::Null),
                Err(_) => Value::Null,
            },
        };
        map.insert(name.to_string(), value);
    }

    Ok(Some(Value::Object(map)))
}

/// 把 _sync_log 中 seq > last_pushed_seq 的条目打包成 changeset（JSONL）
pub async fn pack_changes(
    pool: &SqlitePool,
    device_id: &str,
    app_version: &str,
    last_pushed_seq: i64,
) -> Result<Option<PackedChangeset>, String> {
    let rows = sqlx::query("SELECT seq, table_name, row_id, op, at FROM _sync_log WHERE seq > ? ORDER BY seq ASC")
        .bind(last_pushed_seq)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("读取变更日志失败: {e}"))?;

    if rows.is_empty() {
        return Ok(None);
    }

    let entries: Vec<LogEntry> = rows
        .iter()
        .map(|row| LogEntry {
            seq: row.get("seq"),
            table_name: row.get("table_name"),
            row_id: row.get("row_id"),
            op: row.get("op"),
            at: row.get("at"),
        })
        .collect();

    let seq_from = entries.first().unwrap().seq;
    let seq_to = entries.last().unwrap().seq;

    // 同一 (table,row_id) 只保留最后一次操作（按 seq 大者），减少冗余传输
    let mut latest: HashMap<(String, String), &LogEntry> = HashMap::new();
    for entry in &entries {
        latest
            .entry((entry.table_name.clone(), entry.row_id.clone()))
            .and_modify(|current| {
                if entry.seq > current.seq {
                    *current = entry;
                }
            })
            .or_insert(entry);
    }

    let mut change_rows: Vec<ChangeRow> = Vec::new();
    for ((table_name, row_id), entry) in &latest {
        let Some(table) = tables::find_table(table_name) else {
            continue; // 未注册的表（不该发生，防御）
        };

        if entry.op == "DELETE" {
            change_rows.push(ChangeRow {
                table: table_name.clone(),
                id: row_id.clone(),
                op: "DELETE".to_string(),
                updated_at: entry.at,
                data: None,
            });
            continue;
        }

        match fetch_row_json(pool, table, row_id).await? {
            Some(data) => {
                let updated_at = data
                    .get("updated_at")
                    .and_then(Value::as_i64)
                    .unwrap_or(entry.at);
                change_rows.push(ChangeRow {
                    table: table_name.clone(),
                    id: row_id.clone(),
                    op: entry.op.clone(),
                    updated_at,
                    data: Some(data),
                });
            }
            None => {
                // 行已被删（INSERT/UPDATE 之后又删了）→ 转成墓碑
                change_rows.push(ChangeRow {
                    table: table_name.clone(),
                    id: row_id.clone(),
                    op: "DELETE".to_string(),
                    updated_at: entry.at,
                    data: None,
                });
            }
        }
    }

    // 稳定输出：按 table+id 排序，幂等可 diff
    change_rows.sort_by(|a, b| (&a.table, &a.id).cmp(&(&b.table, &b.id)));
    let row_count = change_rows.len();

    let header = ChangesetHeader {
        protocol: 1,
        device_id: device_id.to_string(),
        seq_from,
        seq_to,
        created_at: chrono::Utc::now().timestamp_millis(),
        app_version: app_version.to_string(),
    };

    let mut jsonl = serde_json::to_string(&serde_json::json!({ "header": header })).map_err(|e| e.to_string())?;
    for row in &change_rows {
        jsonl.push('\n');
        jsonl.push_str(&serde_json::to_string(row).map_err(|e| e.to_string())?);
    }

    Ok(Some(PackedChangeset {
        seq_from,
        seq_to,
        jsonl,
        row_count,
    }))
}
