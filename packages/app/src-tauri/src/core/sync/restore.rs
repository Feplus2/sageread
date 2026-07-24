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
    if db_path.exists() {
        fs::create_dir_all(backup_dir.join("database")).map_err(|e| e.to_string())?;
        fs::copy(&db_path, backup_dir.join("database").join("app.db")).map_err(|e| e.to_string())?;
    }
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

    // 2. 用 staging 内容替换
    let staged_db = staging.join("app.db");
    if staged_db.exists() {
        fs::create_dir_all(config_dir.join("database")).map_err(|e| e.to_string())?;
        fs::copy(&staged_db, &db_path).map_err(|e| e.to_string())?;
    }
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

    // 替换数据库
    fs::copy(&snapshot_path, &db_path).map_err(|e| format!("替换数据库失败: {e}"))?;

    Ok("已回滚到同步前快照，请重启应用生效".to_string())
}
