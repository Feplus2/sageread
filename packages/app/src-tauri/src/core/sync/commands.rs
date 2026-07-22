use super::models::{BackupInfo, BackupManifest, BackupOutcome, SyncState, WebdavConfig};
use super::{backup, engine, restore, webdav};
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

/// 读取 WebDAV 配置（供退出前推送等非命令路径复用）
pub fn load_webdav_config(app: &AppHandle) -> Result<WebdavConfig, String> {
    load_config(app)
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

/* ---------------- L2 增量同步 ---------------- */

/// L2 状态（设置页展示）
#[derive(serde::Serialize)]
pub struct L2Status {
    pub enabled: bool,
    pub frequency: String,
    pub device_id: Option<String>,
    pub last_pushed_seq: i64,
    pub last_pulled: std::collections::HashMap<String, i64>,
    pub last_sync_at: Option<i64>,
    pub last_result: Option<String>,
}

#[tauri::command]
pub async fn sync_get_l2_status(app: AppHandle) -> Result<L2Status, String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let state = super::backup::read_sync_state(&config_dir);
    let config = load_config(&app).unwrap_or(WebdavConfig {
        endpoint: String::new(),
        username: String::new(),
        password: String::new(),
        remote_dir: "sageread-backups".to_string(),
        auto_backup: "off".to_string(),
        l2_enabled: false,
        sync_frequency: super::models::default_sync_frequency(),
    });

    Ok(L2Status {
        enabled: config.l2_enabled,
        frequency: config.sync_frequency,
        device_id: state.device_id,
        last_pushed_seq: state.last_pushed_seq.unwrap_or(0),
        last_pulled: state.last_pulled.unwrap_or_default(),
        last_sync_at: state.last_l2_sync_at,
        last_result: state.last_l2_result,
    })
}

/// 记录 L2 失败原因到 sync-state（设置页"最近一次"展示）
fn record_l2_failure(app: &AppHandle, error: &str) {
    if let Ok(config_dir) = app.path().app_config_dir().map_err(|e| e.to_string()) {
        let mut state = backup::read_sync_state(&config_dir);
        state.last_l2_sync_at = Some(chrono::Utc::now().timestamp_millis());
        state.last_l2_result = Some(format!("失败: {error}"));
        let _ = backup::write_sync_state(&config_dir, &state);
    }
}

/// 立即执行一轮 L2 增量同步（推送本地变更 + 拉取应用远端变更）
#[tauri::command]
pub async fn sync_run_now(app: AppHandle, state: State<'_, AppState>) -> Result<engine::SyncRunResult, String> {
    let config = load_config(&app)?;
    let db_pool_guard = state.db_pool.lock().await;
    let pool = db_pool_guard.as_ref().ok_or("数据库未初始化")?;
    match engine::run_sync(&app, pool, &config).await {
        Ok(result) => Ok(result),
        Err(error) => {
            record_l2_failure(&app, &error);
            Err(error)
        }
    }
}

/// 只拉不推：打开书时的单点快拉（前端带超时调用，超时/失败静默放行本地）
#[tauri::command]
pub async fn sync_pull_now(app: AppHandle, state: State<'_, AppState>) -> Result<engine::SyncRunResult, String> {
    let config = load_config(&app)?;
    let db_pool_guard = state.db_pool.lock().await;
    let pool = db_pool_guard.as_ref().ok_or("数据库未初始化")?;
    match engine::run_pull_only(&app, pool, &config).await {
        Ok(result) => Ok(result),
        Err(error) => {
            record_l2_failure(&app, &error);
            Err(error)
        }
    }
}

/// 是否有未推送的本地变更（纯本地查询，无网络请求；事件驱动推送的调度依据）
#[tauri::command]
pub async fn sync_has_unpushed(app: AppHandle, state: State<'_, AppState>) -> Result<bool, String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let sync_state = backup::read_sync_state(&config_dir);
    let db_pool_guard = state.db_pool.lock().await;
    let pool = db_pool_guard.as_ref().ok_or("数据库未初始化")?;
    engine::has_unpushed(pool, sync_state.last_pushed_seq.unwrap_or(0)).await
}
