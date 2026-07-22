use serde::{Deserialize, Serialize};

fn default_remote_dir() -> String {
    "sageread-backups".to_string()
}

fn default_auto_backup() -> String {
    "off".to_string()
}

/// WebDAV 连接配置（只存本地 webdav-config.json，不进备份包）
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct WebdavConfig {
    pub endpoint: String,
    pub username: String,
    pub password: String,
    #[serde(default = "default_remote_dir")]
    pub remote_dir: String,
    /// 自动备份频率：off / hourly / daily（前端 setInterval 实现）
    #[serde(default = "default_auto_backup")]
    pub auto_backup: String,
}

/// 备份包内的清单文件（manifest.json）
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct BackupManifest {
    pub format: String, // 固定 "sageread-backup"
    pub version: u32,
    pub created_at: i64,
    pub device: String,
    pub app_version: String,
    pub contents: Vec<String>,
    pub db_sha256: String,
}

/// 远端 index.json 里的列表项（用清单文件代替 PROPFIND 解析，简单可靠）
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct BackupInfo {
    pub name: String,
    pub size: u64,
    pub created_at: i64,
    pub device: String,
    pub app_version: String,
    pub db_sha256: String,
}

/// 本地 sync-state.json：上次备份状态与 db 哈希（无变化检测用）
#[derive(Serialize, Deserialize, Debug, Default, Clone)]
pub struct SyncState {
    pub last_backup_at: Option<i64>,
    pub last_backup_name: Option<String>,
    pub last_db_sha256: Option<String>,
    pub last_result: Option<String>,
}

/// 备份执行结果（uploaded=已上传，skipped=无变化跳过）
#[derive(Serialize, Debug)]
pub struct BackupOutcome {
    pub status: String,
    pub message: String,
    pub backup_name: Option<String>,
}
