use super::models::{BackupInfo, BackupManifest, BackupOutcome, SyncState, WebdavConfig};
use super::{backup, restore, webdav};
use crate::core::state::AppState;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};

const CONFIG_FILE: &str = "webdav-config.json";

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(config_dir.join(CONFIG_FILE))
}

fn load_config(app: &AppHandle) -> Result<WebdavConfig, String> {
    let path = config_path(app)?;
    if !path.exists() {
        return Err("尚未配置 WebDAV".to_string());
    }
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| format!("解析 WebDAV 配置失败: {e}"))
}

#[tauri::command]
pub async fn sync_get_config(app: AppHandle) -> Result<Option<WebdavConfig>, String> {
    let path = config_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let config = serde_json::from_str(&content).map_err(|e| format!("解析 WebDAV 配置失败: {e}"))?;
    Ok(Some(config))
}

/// 保存配置到本地 webdav-config.json（只存本地，不进备份包）
#[tauri::command]
pub async fn sync_save_config(app: AppHandle, config: WebdavConfig) -> Result<(), String> {
    let path = config_path(&app)?;
    let content = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(path, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sync_test_connection(config: WebdavConfig) -> Result<String, String> {
    webdav::test_connection(&config).await
}

#[tauri::command]
pub async fn sync_backup_now(app: AppHandle, state: State<'_, AppState>) -> Result<BackupOutcome, String> {
    let config = load_config(&app)?;
    let db_pool_guard = state.db_pool.lock().await;
    let pool = db_pool_guard.as_ref().ok_or("数据库未初始化")?;
    backup::run_backup(&app, pool, &config).await
}

#[tauri::command]
pub async fn sync_list_backups(app: AppHandle) -> Result<Vec<BackupInfo>, String> {
    let config = load_config(&app)?;
    webdav::read_index(&config).await
}

#[tauri::command]
pub async fn sync_get_state(app: AppHandle) -> Result<SyncState, String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(backup::read_sync_state(&config_dir))
}

#[tauri::command]
pub async fn sync_restore(app: AppHandle, backup_name: String) -> Result<BackupManifest, String> {
    let config = load_config(&app)?;
    restore::stage_restore(&app, &config, &backup_name).await
}

#[tauri::command]
pub async fn sync_rollback(app: AppHandle) -> Result<String, String> {
    restore::rollback(&app)
}

/// 恢复已暂存后重启应用（启动时检测 pending-restore 完成实际替换）
#[tauri::command]
pub fn sync_restart_app(app: AppHandle) {
    app.restart();
}
