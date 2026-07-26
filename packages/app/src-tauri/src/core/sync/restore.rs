use super::models::{BackupManifest, WebdavConfig};
use super::webdav;
use std::fs;
use std::io::{Cursor, Read};
use std::path::Path;
use tauri::{AppHandle, Manager};
use zip::ZipArchive;

/// 纳入恢复/保险备份的文件（与备份包内容对应）
const JSON_FILES: [&str; 3] = ["app-settings.json", "layout-store.json", "llama-store.json"];

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let target = dst.join(entry.file_name());
        if path.is_dir() {
            copy_dir_recursive(&path, &target)?;
        } else {
            fs::copy(&path, &target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// 恢复第一阶段：下载选中备份、校验 manifest、解压到 staging、写 pending-restore.json。
/// 实际替换发生在下次启动（见 apply_pending_restore），保证数据库连接已关闭。
pub async fn stage_restore(
    app: &AppHandle,
    config: &WebdavConfig,
    backup_name: &str,
) -> Result<BackupManifest, String> {
    let bytes = webdav::get_file_required(config, backup_name).await?;

    let mut archive = ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("备份包损坏: {e}"))?;
    let mut manifest_bytes = Vec::new();
    archive
        .by_name("manifest.json")
        .map_err(|_| "备份包缺少 manifest.json".to_string())?
        .read_to_end(&mut manifest_bytes)
        .map_err(|e| e.to_string())?;
    let manifest: BackupManifest =
        serde_json::from_slice(&manifest_bytes).map_err(|e| format!("manifest 解析失败: {e}"))?;
    if manifest.format != "sageread-backup" {
        return Err("不是有效的 SageRead 备份包".to_string());
    }

    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let staging = config_dir.join("sync-staging").join("restore");
    if staging.exists() {
        fs::remove_dir_all(&staging).map_err(|e| e.to_string())?;
    }
    fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    archive.extract(&staging).map_err(|e| format!("解压备份包失败: {e}"))?;

    let pending = serde_json::json!({
        "backup_name": backup_name,
        "staged_at": chrono::Utc::now().timestamp_millis(),
    });
    fs::write(
        config_dir.join("pending-restore.json"),
        serde_json::to_string_pretty(&pending).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    Ok(manifest)
}

/// 数据库的 WAL/SHM 伴生文件路径
fn db_sidecar_paths(db_path: &Path) -> [std::path::PathBuf; 2] {
    [db_path.with_extension("db-wal"), db_path.with_extension("db-shm")]
}

/// 删除数据库的 WAL/SHM 伴生文件（存在才删）。
/// 替换主文件后必须删除旧 WAL——它是替换前数据库时代的页面镜像，
/// SQLite 会把它叠在新主文件上重放，恢复后用户看到旧库内容（真机实证）
fn remove_db_sidecars(db_path: &Path) -> Result<(), String> {
    for sidecar in db_sidecar_paths(db_path) {
        if sidecar.exists() {
            fs::remove_file(&sidecar).map_err(|e| format!("删除旧 WAL/SHM 失败: {e}"))?;
        }
    }
    Ok(())
}

/// 替换数据库主文件：旧主文件 + WAL/SHM 先备份到 backup_db_dir（WAL 可能含未检查点的最后提交），
/// staged_db 覆盖主文件后删除新位 WAL/SHM（理由见 remove_db_sidecars）
fn restore_replace_db(staged_db: &Path, db_path: &Path, backup_db_dir: &Path) -> Result<(), String> {
    if db_path.exists() {
        fs::create_dir_all(backup_db_dir).map_err(|e| e.to_string())?;
        fs::copy(db_path, backup_db_dir.join("app.db")).map_err(|e| e.to_string())?;
        for sidecar in db_sidecar_paths(db_path) {
            if sidecar.exists() {
                let name = sidecar.file_name().ok_or("WAL/SHM 文件名非法")?;
                fs::copy(&sidecar, backup_db_dir.join(name)).map_err(|e| e.to_string())?;
            }
        }
    }
    if staged_db.exists() {
        if let Some(parent) = db_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::copy(staged_db, db_path).map_err(|e| e.to_string())?;
    }
    remove_db_sidecars(db_path)
}

/// 恢复第二阶段（启动时、数据库初始化之前调用）：
/// 先把当前数据完整备份到 restore-backup-{ts}/（回滚保险），再用 staging 内容替换。
pub fn apply_pending_restore(app: &AppHandle) -> Result<(), String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let pending_path = config_dir.join("pending-restore.json");
    if !pending_path.exists() {
        return Ok(());
    }
    log::info!("检测到待恢复标记，开始恢复数据...");

    let staging = config_dir.join("sync-staging").join("restore");
    if !staging.exists() {
        let _ = fs::remove_file(&pending_path);
        return Err("恢复暂存不存在，已取消恢复".to_string());
    }

    // 1. 回滚保险：备份当前数据
    let backup_dir = config_dir.join(format!(
        "restore-backup-{}",
        chrono::Utc::now().timestamp_millis() / 1000
    ));
    fs::create_dir_all(&backup_dir).map_err(|e| e.to_string())?;

    let db_path = config_dir.join("database").join("app.db");
    for name in JSON_FILES {
        let src = config_dir.join(name);
        if src.exists() {
            fs::copy(&src, backup_dir.join(name)).map_err(|e| e.to_string())?;
        }
    }
    let themes_dir = config_dir.join("themes");
    if themes_dir.is_dir() {
        copy_dir_recursive(&themes_dir, &backup_dir.join("themes"))?;
    }

    // 2. 用 staging 内容替换（db 的备份+替换+WAL/SHM 清理合一）
    let staged_db = staging.join("app.db");
    restore_replace_db(&staged_db, &db_path, &backup_dir.join("database"))?;
    for name in JSON_FILES {
        let src = staging.join(name);
        if src.exists() {
            fs::copy(&src, config_dir.join(name)).map_err(|e| e.to_string())?;
        }
    }
    let staged_themes = staging.join("themes");
    if staged_themes.is_dir() {
        if themes_dir.exists() {
            fs::remove_dir_all(&themes_dir).map_err(|e| e.to_string())?;
        }
        copy_dir_recursive(&staged_themes, &themes_dir)?;
    }

    // 3. 清理标记与暂存
    let _ = fs::remove_file(&pending_path);
    let _ = fs::remove_dir_all(&staging);
    log::info!("数据恢复完成，恢复前数据已备份到 {:?}", backup_dir);
    Ok(())
}

/// 回滚：把最近的 restore-backup-* 目录换回去（需重启生效）
pub fn rollback(app: &AppHandle) -> Result<String, String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;

    let mut backup_dirs: Vec<_> = fs::read_dir(&config_dir)
        .map_err(|e| e.to_string())?
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            entry.path().is_dir()
                && entry.file_name().to_string_lossy().starts_with("restore-backup-")
        })
        .collect();
    backup_dirs.sort_by_key(|entry| entry.file_name());
    let latest = backup_dirs.pop().ok_or("没有可回滚的备份".to_string())?;
    let src_dir = latest.path();

    let staged_db = src_dir.join("database").join("app.db");
    if staged_db.exists() {
        fs::copy(&staged_db, config_dir.join("database").join("app.db")).map_err(|e| e.to_string())?;
        // 旧 WAL/SHM 同样不得叠在换回的主文件上（同 apply_pending_restore）
        remove_db_sidecars(&config_dir.join("database").join("app.db"))?;
    }
    for name in JSON_FILES {
        let src = src_dir.join(name);
        if src.exists() {
            fs::copy(&src, config_dir.join(name)).map_err(|e| e.to_string())?;
        }
    }
    let staged_themes = src_dir.join("themes");
    let themes_dir = config_dir.join("themes");
    if staged_themes.is_dir() {
        if themes_dir.exists() {
            fs::remove_dir_all(&themes_dir).map_err(|e| e.to_string())?;
        }
        copy_dir_recursive(&staged_themes, &themes_dir)?;
    }

    let _ = fs::remove_dir_all(&src_dir);
    Ok("已回滚到恢复前的数据，请重启应用生效".to_string())
}

/* ---------------- L2 同步前安全快照 ---------------- */

/// 快照信息（设置页展示）
#[derive(serde::Serialize, Debug)]
pub struct SnapshotInfo {
    pub name: String,
    pub created_at: i64,
    pub size: u64,
}

/// 列出 L2 同步前安全快照（sync-staging/l2-safety/app-<ts>.db）
pub fn list_l2_snapshots(app: &AppHandle) -> Result<Vec<SnapshotInfo>, String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let dir = config_dir.join("sync-staging").join("l2-safety");
    if !dir.exists() {
        return Ok(vec![]);
    }

    let mut snapshots: Vec<SnapshotInfo> = fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            name.starts_with("app-") && name.ends_with(".db")
        })
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            // 从文件名提取时间戳：app-<ts>.db
            let ts = name.trim_start_matches("app-").trim_end_matches(".db").parse::<i64>().unwrap_or(0);
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            Some(SnapshotInfo { name, created_at: ts, size })
        })
        .collect();

    // 按时间倒序（最新在前）
    snapshots.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(snapshots)
}

/// 回滚到指定 L2 安全快照：直接替换数据库文件，需重启生效
pub fn rollback_to_l2_snapshot(app: &AppHandle, name: &str) -> Result<String, String> {
    // 安全校验：只允许 app-*.db 格式
    if !name.starts_with("app-") || !name.ends_with(".db") || name.contains("..") {
        return Err("无效的快照名称".to_string());
    }

    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let snapshot_path = config_dir.join("sync-staging").join("l2-safety").join(name);
    if !snapshot_path.exists() {
        return Err(format!("快照不存在: {name}"));
    }

    let db_path = config_dir.join("database").join("app.db");

    // 先备份当前数据库（可回滚的回滚）
    if db_path.exists() {
        let backup_name = format!("app-pre-rollback-{}.db", chrono::Utc::now().timestamp_millis());
        let backup_path = config_dir.join("sync-staging").join("l2-safety").join(&backup_name);
        fs::copy(&db_path, &backup_path).map_err(|e| format!("备份当前数据库失败: {e}"))?;
    }

    // 替换数据库（旧 WAL/SHM 不得叠在快照上重放，同 apply_pending_restore）
    fs::copy(&snapshot_path, &db_path).map_err(|e| format!("替换数据库失败: {e}"))?;
    remove_db_sidecars(&db_path)?;

    Ok("已回滚到同步前快照，请重启应用生效".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::SqlitePool;

    async fn create_marker_db(path: &Path, marker: &str) {
        let url = format!("sqlite:{}?mode=rwc", path.to_string_lossy().replace('\\', "/"));
        let pool = SqlitePool::connect(&url).await.unwrap();
        sqlx::query("CREATE TABLE t (v TEXT)").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO t VALUES (?)").bind(marker).execute(&pool).await.unwrap();
        pool.close().await;
    }

    /// 回归：替换 app.db 时旧 WAL/SHM 必须删除（否则旧 WAL 叠在新主文件上重放 → 用户看到旧库）
    #[tokio::test]
    async fn test_restore_replace_db_removes_wal_shm() {
        let root = std::env::temp_dir().join(format!("sageread-restore-test-{}", uuid::Uuid::new_v4()));
        let live_db_dir = root.join("live").join("database");
        let backup_db_dir = root.join("backup").join("database");
        fs::create_dir_all(&live_db_dir).unwrap();
        let live_db = live_db_dir.join("app.db");
        let staged_db = root.join("staged").join("app.db");
        fs::create_dir_all(staged_db.parent().unwrap()).unwrap();

        // 旧库（live）+ 旧时代的 WAL/SHM（事故载体；替换流程不读内容，标记字节即可）
        create_marker_db(&live_db, "old").await;
        fs::write(live_db_dir.join("app.db-wal"), b"stale-wal").unwrap();
        fs::write(live_db_dir.join("app.db-shm"), b"stale-shm").unwrap();

        // 快照（staged）
        create_marker_db(&staged_db, "new").await;

        restore_replace_db(&staged_db, &live_db, &backup_db_dir).unwrap();

        // WAL/SHM 从新位消失，且已备份（可回滚保险）
        assert!(!live_db_dir.join("app.db-wal").exists(), "旧 WAL 必须删除");
        assert!(!live_db_dir.join("app.db-shm").exists(), "旧 SHM 必须删除");
        assert_eq!(fs::read(backup_db_dir.join("app.db-wal")).unwrap(), b"stale-wal");
        assert_eq!(fs::read(backup_db_dir.join("app.db-shm")).unwrap(), b"stale-shm");
        assert!(backup_db_dir.join("app.db").exists(), "旧主文件应备份");

        // 新库读出的是快照内容而非旧库
        let url = format!("sqlite:{}", live_db.to_string_lossy().replace('\\', "/"));
        let check = SqlitePool::connect(&url).await.unwrap();
        let row: (String,) = sqlx::query_as("SELECT v FROM t").fetch_one(&check).await.unwrap();
        assert_eq!(row.0, "new");
        check.close().await;

        let _ = fs::remove_dir_all(&root);
    }
}
