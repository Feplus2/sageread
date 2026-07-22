use super::models::{BackupInfo, BackupManifest, BackupOutcome, SyncState, WebdavConfig};
use super::webdav;
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use std::fs;
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

/// 轮转保留的备份份数
const MAX_KEEP: usize = 10;
/// 纳入备份的 JSON 配置（model-provider.json 含 API 密钥，刻意排除）
const JSON_FILES: [&str; 3] = ["app-settings.json", "layout-store.json", "llama-store.json"];

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{:02x}", b)).collect()
}

fn device_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "unknown".to_string())
}

pub fn read_sync_state(config_dir: &Path) -> SyncState {
    fs::read_to_string(config_dir.join("sync-state.json"))
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_default()
}

pub fn write_sync_state(config_dir: &Path, state: &SyncState) -> Result<(), String> {
    let content = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    fs::write(config_dir.join("sync-state.json"), content).map_err(|e| e.to_string())
}

/// 打包备份 zip：条目 + manifest.json（抽出以便测试）
pub fn build_backup_zip(entries: &[(String, Vec<u8>)], manifest: &BackupManifest) -> Result<Vec<u8>, String> {
    let mut zw = ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    for (name, bytes) in entries {
        zw.start_file(name, options).map_err(|e| format!("zip 写入失败: {e}"))?;
        zw.write_all(bytes).map_err(|e| format!("zip 写入失败: {e}"))?;
    }

    let manifest_json = serde_json::to_string_pretty(manifest).map_err(|e| e.to_string())?;
    zw.start_file("manifest.json", options)
        .map_err(|e| format!("zip 写入失败: {e}"))?;
    zw.write_all(manifest_json.as_bytes())
        .map_err(|e| format!("zip 写入失败: {e}"))?;

    let cursor = zw.finish().map_err(|e| format!("zip 完成失败: {e}"))?;
    Ok(cursor.into_inner())
}

/// 备份成功后的状态更新：只动四个备份字段，保留 device_id / 推送拉取水位等 L2 状态
fn backup_success_state(state: SyncState, created_at: i64, backup_name: String, db_sha256: String) -> SyncState {
    SyncState {
        last_backup_at: Some(created_at),
        last_backup_name: Some(backup_name),
        last_db_sha256: Some(db_sha256),
        last_result: Some("uploaded".to_string()),
        ..state
    }
}

/// 执行一次备份：VACUUM INTO 快照 → 打包 → 无变化跳过 → 上传 → 更新 index.json → 轮转
pub async fn run_backup(
    app: &AppHandle,
    pool: &SqlitePool,
    config: &WebdavConfig,
) -> Result<BackupOutcome, String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let staging_dir = config_dir.join("sync-staging");
    fs::create_dir_all(&staging_dir).map_err(|e| e.to_string())?;

    // 1. 在线一致性快照（VACUUM INTO 要求目标文件不存在）
    let staged_db = staging_dir.join("app.db");
    if staged_db.exists() {
        fs::remove_file(&staged_db).map_err(|e| e.to_string())?;
    }
    sqlx::query("VACUUM INTO ?")
        .bind(staged_db.to_string_lossy().replace('\\', "/"))
        .execute(pool)
        .await
        .map_err(|e| format!("数据库快照失败: {e}"))?;

    let db_bytes = fs::read(&staged_db).map_err(|e| format!("读取数据库快照失败: {e}"))?;
    let db_sha256 = sha256_hex(&db_bytes);

    // 2. 无变化检测（与上次备份的 db 哈希一致则跳过上传）
    let state = read_sync_state(&config_dir);
    if state.last_db_sha256.as_deref() == Some(db_sha256.as_str()) && state.last_backup_name.is_some() {
        return Ok(BackupOutcome {
            status: "skipped".to_string(),
            message: "数据无变化，已跳过上传".to_string(),
            backup_name: None,
        });
    }

    // 3. 收集打包内容：app.db + 三个 JSON + themes/*.css
    let mut entries: Vec<(String, Vec<u8>)> = vec![("app.db".to_string(), db_bytes)];
    for name in JSON_FILES {
        let path = config_dir.join(name);
        if path.exists() {
            entries.push((name.to_string(), fs::read(&path).map_err(|e| e.to_string())?));
        }
    }
    let themes_dir = config_dir.join("themes");
    if themes_dir.is_dir() {
        let mut theme_files: Vec<PathBuf> = fs::read_dir(&themes_dir)
            .map_err(|e| e.to_string())?
            .filter_map(|entry| entry.ok().map(|e| e.path()))
            .filter(|path| path.is_file() && path.extension().is_some_and(|ext| ext == "css"))
            .collect();
        theme_files.sort();
        for path in theme_files {
            let name = format!("themes/{}", path.file_name().unwrap().to_string_lossy());
            entries.push((name, fs::read(&path).map_err(|e| e.to_string())?));
        }
    }

    let created_at = chrono::Utc::now().timestamp_millis();
    let manifest = BackupManifest {
        format: "sageread-backup".to_string(),
        version: 1,
        created_at,
        device: device_name(),
        app_version: app.package_info().version.to_string(),
        contents: entries.iter().map(|(name, _)| name.clone()).collect(),
        db_sha256: db_sha256.clone(),
    };
    let zip_bytes = build_backup_zip(&entries, &manifest)?;

    // 4. 上传
    webdav::ensure_dir(config).await?;
    let backup_name = format!("backup-{}.zip", chrono::Local::now().format("%Y%m%d-%H%M%S"));
    webdav::put_file(config, &backup_name, zip_bytes.clone()).await?;

    // 5. 更新远端 index.json 并轮转（保留最新 MAX_KEEP 份，多余的连 zip 一起删）
    let mut index = webdav::read_index(config).await.unwrap_or_default();
    index.push(BackupInfo {
        name: backup_name.clone(),
        size: zip_bytes.len() as u64,
        created_at,
        device: manifest.device.clone(),
        app_version: manifest.app_version.clone(),
        db_sha256,
    });
    index.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    while index.len() > MAX_KEEP {
        if let Some(oldest) = index.pop() {
            let _ = webdav::delete_file(config, &oldest.name).await;
        }
    }
    webdav::write_index(config, &index).await?;

    // 6. 记录本地状态
    let _ = write_sync_state(
        &config_dir,
        &backup_success_state(state, created_at, backup_name.clone(), manifest.db_sha256.clone()),
    );

    Ok(BackupOutcome {
        status: "uploaded".to_string(),
        message: format!("已上传 {backup_name}"),
        backup_name: Some(backup_name),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 回归：备份成功后写状态不得重置 L2 字段（device_id / 推送拉取水位）
    #[test]
    fn test_backup_success_state_preserves_l2() {
        let mut pulled = std::collections::HashMap::new();
        pulled.insert("dev-b".to_string(), 42);
        let old = SyncState {
            device_id: Some("dev-a".to_string()),
            last_pushed_seq: Some(100),
            last_pulled: Some(pulled),
            last_l2_sync_at: Some(999),
            last_l2_result: Some("无新变更".to_string()),
            ..Default::default()
        };

        let new = backup_success_state(old, 123, "backup-1.zip".to_string(), "abc".to_string());

        assert_eq!(new.device_id.as_deref(), Some("dev-a"));
        assert_eq!(new.last_pushed_seq, Some(100));
        assert_eq!(new.last_pulled.as_ref().and_then(|m| m.get("dev-b")), Some(&42));
        assert_eq!(new.last_l2_sync_at, Some(999));
        assert_eq!(new.last_l2_result.as_deref(), Some("无新变更"));
        assert_eq!(new.last_backup_at, Some(123));
        assert_eq!(new.last_backup_name.as_deref(), Some("backup-1.zip"));
        assert_eq!(new.last_db_sha256.as_deref(), Some("abc"));
        assert_eq!(new.last_result.as_deref(), Some("uploaded"));
    }

    /// 验证打包流程：VACUUM INTO 快照可读、zip 结构完整、manifest 可解析
    #[tokio::test]
    async fn test_vacuum_and_package() {
        let staging = std::env::temp_dir().join(format!("sageread-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&staging).unwrap();

        // 临时文件库造数据（sqlx 建新文件需要 mode=rwc）
        let src = staging.join("src.db");
        let url = format!("sqlite:{}?mode=rwc", src.to_string_lossy().replace('\\', "/"));
        let pool = SqlitePool::connect(&url).await.unwrap();
        sqlx::query("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO t (v) VALUES ('hello')")
            .execute(&pool)
            .await
            .unwrap();

        // VACUUM INTO 快照
        let staged_db = staging.join("app.db");
        sqlx::query("VACUUM INTO ?")
            .bind(staged_db.to_string_lossy().replace('\\', "/"))
            .execute(&pool)
            .await
            .unwrap();
        assert!(staged_db.exists(), "VACUUM INTO 未生成快照文件");

        // 重新打开快照，数据应可读
        let check = SqlitePool::connect(&format!("sqlite:{}", staged_db.to_string_lossy().replace('\\', "/")))
            .await
            .unwrap();
        let row: (String,) = sqlx::query_as("SELECT v FROM t")
            .fetch_one(&check)
            .await
            .unwrap();
        assert_eq!(row.0, "hello");

        // 打包
        let db_bytes = fs::read(&staged_db).unwrap();
        let manifest = BackupManifest {
            format: "sageread-backup".to_string(),
            version: 1,
            created_at: 0,
            device: "test".to_string(),
            app_version: "0.1.0".to_string(),
            contents: vec!["app.db".to_string(), "app-settings.json".to_string()],
            db_sha256: sha256_hex(&db_bytes),
        };
        let zip_bytes = build_backup_zip(
            &[
                ("app.db".to_string(), db_bytes),
                ("app-settings.json".to_string(), b"{}".to_vec()),
            ],
            &manifest,
        )
        .unwrap();

        // 解包验证结构与 manifest
        let mut archive = zip::ZipArchive::new(Cursor::new(zip_bytes)).unwrap();
        assert!(archive.by_name("app.db").is_ok());
        assert!(archive.by_name("app-settings.json").is_ok());
        let mut manifest_file = archive.by_name("manifest.json").unwrap();
        let mut manifest_bytes = Vec::new();
        std::io::Read::read_to_end(&mut manifest_file, &mut manifest_bytes).unwrap();
        let parsed: BackupManifest = serde_json::from_slice(&manifest_bytes).unwrap();
        assert_eq!(parsed.format, "sageread-backup");
        assert_eq!(parsed.version, 1);
        assert_eq!(parsed.contents.len(), 2);

        let _ = fs::remove_dir_all(&staging);
    }
}
